"""An agent tool guarded by Elan1 Govern, with no framework.

    pip install ./packages/sdk-python
    export GATE_URL=http://localhost:4000 GATE_KEY=gk_your_key
    python examples/python/plain.py

The tool name must be one Elan1 Govern knows: a built-in tool or one from an MCP server you
added under Connectors (here a CRM server named "CRM"). Anything no rule allows is refused.
"""

from __future__ import annotations

import os
import uuid

from elan1_govern import ApprovalPending, Govern, Refused, guarded

gov = Govern(os.environ.get("GATE_URL", "http://localhost:4000"), api_key=os.environ["GATE_KEY"])


@guarded(gov, "crm.issue_refund", ref=lambda r: r["refund_id"])
def issue_refund(order_id: str, amount: float) -> dict:
    # Your real code goes here. It runs only after Elan1 Govern allows it.
    return {"refund_id": f"rf_{uuid.uuid4().hex[:8]}", "order_id": order_id, "amount": amount}


def main() -> None:
    for order_id, amount in [("A-1001", 40.0), ("A-1002", 900.0)]:
        try:
            print("refunded:", issue_refund(order_id, amount))
        except Refused as e:
            print(f"refused by rule {e.rule_id}: {e.reason}")
        except ApprovalPending as e:
            print(f"needs approval, ask someone to decide at {e.approval_url}")

    # The same thing by hand, without the decorator:
    check = gov.check("crm.issue_refund", {"order_id": "A-1003", "amount": 25.0})
    if check.decision == "allow":
        # run the refund here, then:
        gov.record(check_id=check.check_id, status="ok", ref="rf_manual")
    elif check.decision == "ask" and check.approval_id:
        status = gov.wait_for_approval(check.approval_id, timeout_s=120)
        if status.status == "approved":
            # run the refund here, then:
            gov.record(approval_id=check.approval_id, status="ok", ref="rf_manual")
    else:
        print(f"refused by rule {check.rule_id}: {check.reason}")


if __name__ == "__main__":
    main()
