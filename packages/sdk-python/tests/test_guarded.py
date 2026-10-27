from __future__ import annotations

import asyncio
import inspect
import unittest
from typing import Any, List

from _support import FakeGovern, allow, approval, ask, recorded, refuse

from elan1_govern import ApprovalPending, Govern, GovernError, RecordError, Refused, guarded


class GuardedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeGovern()
        self.gov = Govern(self.fake.url, api_key="gk_test", timeout=5)
        self.calls: List[Any] = []
        calls = self.calls

        @guarded(self.gov, "crm.issue_refund", ref=lambda r: r["refund_id"])
        def issue_refund(order_id: str, amount: float, note: str = "") -> dict:
            """Refund an order."""
            calls.append((order_id, amount, note))
            if amount < 0:
                raise ValueError("negative amount")
            return {"refund_id": "rf_" + order_id}

        self.issue_refund = issue_refund

    def tearDown(self) -> None:
        self.fake.close()

    def bodies(self) -> List[Any]:
        return [(r.path.split("?")[0], r.body) for r in self.fake.requests]

    def test_allow_runs_then_records_ok(self) -> None:
        self.fake.replies += [allow(check_id=41), recorded()]
        self.assertEqual(self.issue_refund("o1", amount=50), {"refund_id": "rf_o1"})
        self.assertEqual(self.calls, [("o1", 50, "")])
        self.assertEqual(
            self.bodies(),
            [
                ("/v1/check", {"tool": "crm.issue_refund", "args": {"order_id": "o1", "amount": 50, "note": ""}}),
                ("/v1/record", {"check_id": 41, "status": "ok", "ref": "rf_o1"}),
            ],
        )

    def test_keeps_the_function_name_doc_and_signature(self) -> None:
        self.assertEqual(self.issue_refund.__name__, "issue_refund")
        self.assertEqual(self.issue_refund.__doc__, "Refund an order.")
        self.assertEqual(list(inspect.signature(self.issue_refund).parameters), ["order_id", "amount", "note"])

    def test_tool_error_is_recorded_and_reraised(self) -> None:
        self.fake.replies += [allow(check_id=41), recorded()]
        with self.assertRaises(ValueError):
            self.issue_refund("o1", -1)
        self.assertEqual(self.bodies()[1], ("/v1/record", {"check_id": 41, "status": "error", "error": "ValueError: negative amount"}))

    def test_tool_error_wins_over_a_failed_record(self) -> None:
        self.fake.replies += [allow(), (503, {"error": "down"})]
        with self.assertRaises(ValueError):
            self.issue_refund("o1", -1)

    def test_refuse_raises_and_never_runs(self) -> None:
        self.fake.replies.append(refuse("refund-limit"))
        with self.assertRaises(Refused) as ctx:
            self.issue_refund("o1", 5000)
        self.assertEqual((ctx.exception.rule_id, ctx.exception.reason), ("refund-limit", "Deleting is never allowed."))
        self.assertIn("refund-limit", str(ctx.exception))
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.fake.requests), 1)

    def test_ask_without_wait_raises_pending_and_never_runs(self) -> None:
        self.fake.replies.append(ask("ap_1"))
        with self.assertRaises(ApprovalPending) as ctx:
            self.issue_refund("o1", 500)
        self.assertEqual(ctx.exception.approval_id, "ap_1")
        self.assertEqual(ctx.exception.approval_url, "http://localhost:3000/approvals/ap_1")
        self.assertEqual(self.calls, [])

    def wait_refund(self) -> Any:
        calls = self.calls

        @guarded(self.gov, "crm.issue_refund", wait=True, timeout_s=60)
        def refund(order_id: str, amount: float) -> str:
            calls.append(order_id)
            return "done"

        return refund

    def test_ask_with_wait_runs_after_approval_and_records_by_approval_id(self) -> None:
        self.fake.replies += [ask("ap_1"), approval("pending"), approval("approved"), recorded()]
        self.assertEqual(self.wait_refund()("o1", 500), "done")
        self.assertEqual(self.calls, ["o1"])
        self.assertEqual(self.bodies()[-1], ("/v1/record", {"approval_id": "ap_1", "status": "ok"}))

    def test_ask_with_wait_rejected_raises_refused(self) -> None:
        self.fake.replies += [ask("ap_1"), approval("rejected")]
        with self.assertRaises(Refused) as ctx:
            self.wait_refund()("o1", 500)
        self.assertEqual((ctx.exception.rule_id, ctx.exception.approval_id), ("large-refunds", "ap_1"))
        self.assertEqual(self.calls, [])

    def test_ask_with_wait_expired_raises_refused(self) -> None:
        self.fake.replies += [ask("ap_1"), approval("expired")]
        with self.assertRaises(Refused):
            self.wait_refund()("o1", 500)
        self.assertEqual(self.calls, [])

    def test_ask_with_wait_timing_out_raises_pending(self) -> None:
        @guarded(self.gov, "crm.issue_refund", wait=True, timeout_s=0)
        def refund(order_id: str) -> None:
            self.calls.append(order_id)

        self.fake.replies += [ask("ap_1"), approval("pending")]
        with self.assertRaises(ApprovalPending):
            refund("o1")
        self.assertEqual(self.calls, [])

    def test_fails_closed_when_the_service_is_down(self) -> None:
        self.fake.close()
        with self.assertRaises(GovernError):
            self.issue_refund("o1", 1)
        self.assertEqual(self.calls, [])

    def test_fails_closed_on_server_errors(self) -> None:
        for reply in [(500, {"error": "boom"}), (401, {"error": "Missing or invalid agent API key"}), (200, {"decision": "maybe"}), (200, {"decision": "allow", "rule_id": "r", "reason": "", "check_id": None})]:
            self.fake.replies.append(reply)
            with self.assertRaises(GovernError):
                self.issue_refund("o1", 1)
        self.assertEqual(self.calls, [])

    def test_record_failure_after_the_run_says_it_ran(self) -> None:
        self.fake.replies += [allow(), (500, {"error": "boom"})]
        with self.assertRaises(RecordError) as ctx:
            self.issue_refund("o1", 1)
        self.assertEqual(ctx.exception.result, {"refund_id": "rf_o1"})
        self.assertEqual(len(self.calls), 1)

    def test_unserialisable_arguments_never_run(self) -> None:
        with self.assertRaises(TypeError):
            self.issue_refund(object(), 1)
        self.assertEqual(self.calls, [])

    def test_var_keyword_arguments_are_flattened(self) -> None:
        @guarded(self.gov, "crm.update_customer")
        def update(customer_id: str, **fields: Any) -> None:
            pass

        self.fake.replies += [allow(), recorded()]
        update("c1", email="a@example.com")
        self.assertEqual(self.fake.requests[0].body["args"], {"customer_id": "c1", "email": "a@example.com"})

    def test_async_functions(self) -> None:
        calls = self.calls

        @guarded(self.gov, "crm.issue_refund")
        async def refund(order_id: str) -> str:
            calls.append(order_id)
            await asyncio.sleep(0)
            return "ok"

        self.assertTrue(inspect.iscoroutinefunction(refund))
        self.fake.replies += [allow(check_id=3), recorded()]
        self.assertEqual(asyncio.run(refund("o1")), "ok")
        self.assertEqual(self.bodies()[1], ("/v1/record", {"check_id": 3, "status": "ok"}))

        self.fake.replies.append(refuse())
        with self.assertRaises(Refused):
            asyncio.run(refund("o2"))
        self.assertEqual(calls, ["o1"])


if __name__ == "__main__":
    unittest.main()
