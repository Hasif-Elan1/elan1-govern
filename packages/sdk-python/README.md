# elan1-govern

Python SDK for Elan1 Govern, for agents that run their own tools. Before a tool runs, ask Elan1 Govern whether it may (**allow**, **ask a person**, or **refuse**); after it runs, tell Elan1 Govern what happened. Both become signed receipts.

Standard library only, Python 3.9 or newer, fully typed.

## Install

From a clone of this repository:

```bash
pip install ./packages/sdk-python
```

You need the address of your Elan1 Govern service and an agent API key (**Agents → your agent → Keys and connection**).

## Quick start

```python
import os
from elan1_govern import Govern

gov = Govern("http://localhost:4000", api_key=os.environ["GATE_KEY"])

check = gov.check("zoho.record_bill_payment", {"bill_id": "B-1", "amount_inr": 18000})
if check.decision == "allow":
    ref = pay_in_zoho("B-1", 18000)                       # your code runs the tool
    gov.record(check_id=check.check_id, status="ok", ref=ref)
elif check.decision == "ask":
    s = gov.wait_for_approval(check.approval_id)          # long-polls, 30 s at a time
    if s.status == "approved":
        ...  # run it, then gov.record(approval_id=check.approval_id, status="ok")
```

| Call | What it does |
|---|---|
| `check(tool, args)` → `CheckResult` | `decision`, `rule_id`, `reason`, `check_id`; for `ask` also `approval_id`, `approval_url`, `expires_at`. Nothing is run. |
| `record(check_id=… or approval_id=…, status="ok"/"error", ref=None, error=None)` → `RecordResult` | Records the outcome. `receipt_seq` is the outcome receipt. |
| `wait_for_approval(approval_id, timeout_s=600)` → `ApprovalStatus` | Waits for a person. Returns when the status is no longer `pending`, or still `pending` once `timeout_s` has passed. |

Every error raises `GovernError` with `message` and `status` (the HTTP status, or 0 when Elan1 Govern could not be reached or sent something unexpected). Redirects are not followed, so the key is never sent anywhere else.

## The `guarded` decorator

`guarded` turns a function into a tool that checks first, runs only when allowed, and records `ok`, or `error` with the exception's text.

```python
from elan1_govern import ApprovalPending, Govern, Refused, guarded

gov = Govern("http://localhost:4000", api_key=os.environ["GATE_KEY"])

@guarded(gov, "crm.issue_refund", ref=lambda r: r["refund_id"])
def issue_refund(order_id: str, amount: float) -> dict:
    return crm.refund(order_id, amount)

try:
    issue_refund("A-1001", 40)
except Refused as e:          # e.rule_id, e.reason
    ...
except ApprovalPending as e:  # e.approval_id, e.approval_url
    ...
```

- The function's arguments, by parameter name, are the tool's arguments, so they must be JSON values.
- **refuse** raises `Refused`. **ask** raises `ApprovalPending` at once; pass `wait=True` (and `timeout_s`) to wait for a person instead. Rejected or expired raises `Refused`.
- **Fails closed.** If Elan1 Govern cannot be reached, answers with an error, or sends something unexpected, `GovernError` is raised and the function never runs.
- If the function ran but the outcome could not be recorded, `RecordError` (a `GovernError`) is raised with the return value in `result`. The action happened: do not run it again.
- `async def` functions work too; the HTTP calls run in a worker thread.
- The function keeps its name, docstring and signature, so framework decorators such as LangChain's `@tool` or the OpenAI Agents SDK's `@function_tool` still see the right schema. Examples are in [`examples/python`](../../examples/python).

## Webhooks

```python
from elan1_govern import verify_webhook

# body: the raw request body (bytes or str), before JSON parsing
if not verify_webhook(request.headers.get("gate-signature"), body, os.environ["GATE_WEBHOOK_SECRET"]):
    return 400
```

The header is `gate-signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. `verify_webhook` compares in constant time and rejects timestamps more than `tolerance_s` seconds (default 300) from now, which stops replays. It accepts exactly what the TypeScript SDK's `verifyWebhook` accepts.

## Tests

```bash
export PATH=~/.local/mamba/envs/tools/bin:$PATH   # on the dev machine; any python3 ≥ 3.9 works
pnpm test:python                                  # python3 -m unittest discover -s packages/sdk-python/tests
```
