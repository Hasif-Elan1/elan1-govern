from __future__ import annotations

import socket
import unittest

from _support import FakeGovern, allow, approval, ask, recorded, refuse

from elan1_govern import CheckResult, Govern, GovernError


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeGovern()
        self.gov = Govern(self.fake.url + "/", api_key="gk_test", timeout=5)

    def tearDown(self) -> None:
        self.fake.close()

    def test_check_allow_sends_tool_args_and_key(self) -> None:
        self.fake.replies.append(allow(check_id=41))
        r = self.gov.check("crm.issue_refund", {"order_id": "o1", "amount": 50})
        self.assertEqual(r, CheckResult(decision="allow", rule_id="small-refunds", reason="Within the limit.", check_id=41))
        req = self.fake.requests[0]
        self.assertEqual((req.method, req.path), ("POST", "/v1/check"))
        self.assertEqual(req.headers["authorization"], "Bearer gk_test")
        self.assertEqual(req.headers["content-type"], "application/json")
        self.assertEqual(req.body, {"tool": "crm.issue_refund", "args": {"order_id": "o1", "amount": 50}})

    def test_check_without_args_sends_empty_object(self) -> None:
        self.fake.replies.append(allow())
        self.gov.check("gmail.search")
        self.assertEqual(self.fake.requests[0].body, {"tool": "gmail.search", "args": {}})

    def test_check_ask_carries_the_approval(self) -> None:
        self.fake.replies.append(ask("ap_9"))
        r = self.gov.check("crm.issue_refund", {"amount": 500})
        self.assertEqual(r.decision, "ask")
        self.assertEqual(r.approval_id, "ap_9")
        self.assertEqual(r.approval_url, "http://localhost:3000/approvals/ap_9")
        self.assertEqual(r.expires_at, "2026-10-28T10:00:00.000Z")
        self.assertEqual(r.check_id, 9)

    def test_check_refuse(self) -> None:
        self.fake.replies.append(refuse("never-delete"))
        r = self.gov.check("crm.delete_customer", {"id": "c1"})
        self.assertEqual((r.decision, r.rule_id, r.approval_id), ("refuse", "never-delete", None))

    def test_check_null_check_id(self) -> None:
        self.fake.replies.append((200, {"decision": "refuse", "rule_id": "default", "reason": "Unknown tool.", "check_id": None}))
        self.assertIsNone(self.gov.check("nope").check_id)

    def test_answer_without_a_decision_is_an_error_not_an_allow(self) -> None:
        self.fake.replies.append((200, {"rule_id": "x"}))
        with self.assertRaises(GovernError) as ctx:
            self.gov.check("crm.issue_refund")
        self.assertEqual(ctx.exception.status, 0)
        self.fake.replies.append((200, "not json"))
        with self.assertRaises(GovernError):
            self.gov.check("crm.issue_refund")

    def test_error_message_and_status_come_from_the_service(self) -> None:
        self.fake.replies.append((401, {"error": "Missing or invalid agent API key"}))
        with self.assertRaises(GovernError) as ctx:
            self.gov.check("crm.issue_refund")
        self.assertEqual((str(ctx.exception), ctx.exception.status), ("Missing or invalid agent API key", 401))

    def test_error_without_json_body(self) -> None:
        self.fake.replies.append((502, b"<html>bad gateway</html>"))
        with self.assertRaises(GovernError) as ctx:
            self.gov.check("crm.issue_refund")
        self.assertEqual((ctx.exception.message, ctx.exception.status), ("Elan1 Govern returned 502", 502))

    def test_redirects_are_not_followed(self) -> None:
        self.fake.replies.append((302, {}))
        with self.assertRaises(GovernError) as ctx:
            self.gov.check("crm.issue_refund")
        self.assertEqual(ctx.exception.status, 302)
        self.assertEqual(len(self.fake.requests), 1)

    def test_unreachable_service_raises(self) -> None:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        with self.assertRaises(GovernError) as ctx:
            Govern(f"http://127.0.0.1:{port}", api_key="gk_test", timeout=2).check("crm.issue_refund")
        self.assertEqual(ctx.exception.status, 0)

    def test_record_with_check_id(self) -> None:
        self.fake.replies.append(recorded(12))
        r = self.gov.record(check_id=41, status="ok", ref="rf_1")
        self.assertEqual(r.receipt_seq, 12)
        req = self.fake.requests[0]
        self.assertEqual((req.method, req.path), ("POST", "/v1/record"))
        self.assertEqual(req.body, {"check_id": 41, "status": "ok", "ref": "rf_1"})

    def test_record_with_approval_id_and_error(self) -> None:
        self.fake.replies.append(recorded())
        self.gov.record(approval_id="ap_1", status="error", error="timeout")
        self.assertEqual(self.fake.requests[0].body, {"approval_id": "ap_1", "status": "error", "error": "timeout"})

    def test_record_conflict(self) -> None:
        self.fake.replies.append((409, {"error": "An outcome was already recorded for this action."}))
        with self.assertRaises(GovernError) as ctx:
            self.gov.record(check_id=1, status="ok")
        self.assertEqual(ctx.exception.status, 409)

    def test_wait_polls_until_decided(self) -> None:
        self.fake.replies += [approval("pending", "ap/1"), approval("approved", "ap/1")]
        s = self.gov.wait_for_approval("ap/1", timeout_s=120)
        self.assertEqual(s.status, "approved")
        self.assertEqual(s.message, "It is approved.")
        self.assertEqual([r.path for r in self.fake.requests], ["/v1/approvals/ap%2F1?wait=30"] * 2)
        self.assertEqual(self.fake.requests[0].method, "GET")

    def test_wait_uses_the_time_left(self) -> None:
        self.fake.replies.append(approval("rejected"))
        self.assertEqual(self.gov.wait_for_approval("ap_1", timeout_s=7).status, "rejected")
        self.assertEqual(self.fake.requests[0].path, "/v1/approvals/ap_1?wait=7")

    def test_wait_returns_pending_when_time_is_up(self) -> None:
        self.fake.replies.append(approval("pending"))
        self.assertEqual(self.gov.wait_for_approval("ap_1", timeout_s=0).status, "pending")
        self.assertEqual(self.fake.requests[0].path, "/v1/approvals/ap_1?wait=0")
        self.assertEqual(len(self.fake.requests), 1)

    def test_wait_unknown_approval(self) -> None:
        self.fake.replies.append((404, {"error": "No approval with that id for this agent."}))
        with self.assertRaises(GovernError) as ctx:
            self.gov.wait_for_approval("ap_x")
        self.assertEqual(ctx.exception.status, 404)

    def test_bad_constructor_arguments(self) -> None:
        with self.assertRaises(ValueError):
            Govern("file:///etc/passwd", api_key="k")
        with self.assertRaises(ValueError):
            Govern("http://localhost:4000", api_key="")


if __name__ == "__main__":
    unittest.main()
