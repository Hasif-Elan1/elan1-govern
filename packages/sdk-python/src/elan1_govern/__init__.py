"""Elan1 Govern SDK for Python agents with their own tool loop. Ask Elan1 Govern before acting, tell it after.

    gov = Govern("http://localhost:4000", api_key=os.environ["GATE_KEY"])
    check = gov.check("zoho.record_bill_payment", {"bill_id": bill_id, "amount_inr": amount})
    if check.decision == "allow":
        ref = pay()
        gov.record(check_id=check.check_id, status="ok", ref=ref)

Standard library only.
"""

from .client import ApprovalStatus, CheckResult, Govern, GovernError, RecordResult
from .guarded import ApprovalPending, RecordError, Refused, guarded
from .webhook import verify_webhook

__all__ = [
    "ApprovalPending",
    "ApprovalStatus",
    "CheckResult",
    "Govern",
    "GovernError",
    "RecordError",
    "RecordResult",
    "Refused",
    "guarded",
    "verify_webhook",
]

__version__ = "0.1.0"
