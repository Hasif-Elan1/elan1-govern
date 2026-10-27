"""Client for the Elan1 Govern REST Event API: ask before acting, tell it after."""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Literal, Mapping, Optional

Decision = Literal["allow", "ask", "refuse"]
ApprovalState = Literal["pending", "approved", "rejected", "expired"]

_DECISIONS = ("allow", "ask", "refuse")
_STATES = ("pending", "approved", "rejected", "expired")


class GovernError(Exception):
    """Elan1 Govern answered with an error, or could not be reached.

    ``status`` is the HTTP status, or 0 when there was no usable answer (network error,
    timeout, a redirect, or a body that is not what Elan1 Govern sends).
    """

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass(frozen=True)
class CheckResult:
    """Elan1 Govern's answer to ``check()``."""

    decision: Decision
    rule_id: str
    """The rule that decided, or ``default``."""
    reason: str
    check_id: Optional[int]
    """Pass to ``record()`` after you run an allowed action."""
    approval_id: Optional[str] = None
    """Set when ``decision == "ask"``."""
    approval_url: Optional[str] = None
    """Where a person decides."""
    expires_at: Optional[str] = None
    """ISO 8601 time after which the action is refused."""


@dataclass(frozen=True)
class RecordResult:
    receipt_seq: int


@dataclass(frozen=True)
class ApprovalStatus:
    approval_id: str
    status: ApprovalState
    expires_at: str
    rule_id: str
    message: str
    """What to do next, in plain words."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # A redirect would resend the API key (and turn a POST into a GET). Treat it as an error.
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


class Govern:
    """An Elan1 Govern client for agents that run their own tools.

    ``url`` is the base URL of the Elan1 Govern service, e.g. ``http://localhost:4000``.
    ``timeout`` is the socket timeout in seconds for each request (a long-poll adds its wait).
    """

    def __init__(self, url: str, api_key: str, timeout: float = 30.0) -> None:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("url must be an http:// or https:// address")
        if not api_key:
            raise ValueError("api_key is required")
        self._base = url.rstrip("/")
        self._key = api_key
        self._timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect())

    def _req(self, method: str, path: str, body: Optional[Mapping[str, Any]] = None, wait_s: float = 0) -> Dict[str, Any]:
        headers = {"authorization": f"Bearer {self._key}", "accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(self._base + path, data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=self._timeout + wait_s) as res:
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
            e.close()
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise GovernError(f"Could not reach Elan1 Govern: {e}", 0) from e
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            parsed = {}
        out: Dict[str, Any] = parsed if isinstance(parsed, dict) else {}
        if not 200 <= status < 300:
            err = out.get("error")
            raise GovernError(err if isinstance(err, str) else f"Elan1 Govern returned {status}", status)
        return out

    def check(self, tool: str, args: Optional[Mapping[str, Any]] = None) -> CheckResult:
        """Ask Elan1 Govern whether the agent may run this tool with these arguments. Nothing is run."""
        r = self._req("POST", "/v1/check", {"tool": tool, "args": dict(args or {})})
        decision = r.get("decision")
        if decision not in _DECISIONS:
            # Fail closed: an answer we do not understand is never treated as "allow".
            raise GovernError("Elan1 Govern sent an answer without a decision", 0)
        check_id = r.get("check_id")
        approval_id = r.get("approval_id")
        has_approval = isinstance(approval_id, str)
        return CheckResult(
            decision=decision,
            rule_id=str(r.get("rule_id")),
            reason=str(r.get("reason")),
            check_id=check_id if isinstance(check_id, int) and not isinstance(check_id, bool) else None,
            approval_id=approval_id if has_approval else None,
            approval_url=str(r.get("approval_url")) if has_approval else None,
            expires_at=str(r.get("expires_at")) if has_approval else None,
        )

    def record(
        self,
        *,
        check_id: Optional[int] = None,
        approval_id: Optional[str] = None,
        status: Literal["ok", "error"],
        ref: Optional[str] = None,
        error: Optional[str] = None,
    ) -> RecordResult:
        """Tell Elan1 Govern what happened after you ran an allowed (or approved) action.

        Give exactly one of ``check_id`` or ``approval_id``.
        """
        body: Dict[str, Any] = {}
        if check_id is not None:
            body["check_id"] = check_id
        if approval_id is not None:
            body["approval_id"] = approval_id
        body["status"] = status
        if ref:
            body["ref"] = ref
        if error:
            body["error"] = error
        r = self._req("POST", "/v1/record", body)
        seq = r.get("receipt_seq")
        if not isinstance(seq, int):
            raise GovernError("Elan1 Govern did not return a receipt number", 0)
        return RecordResult(receipt_seq=seq)

    def wait_for_approval(self, approval_id: str, timeout_s: float = 600) -> ApprovalStatus:
        """Wait for a person to decide. Long-polls Elan1 Govern in 30-second steps.

        Returns as soon as the approval is no longer pending, or with ``status == "pending"``
        once ``timeout_s`` has passed.
        """
        until = time.monotonic() + timeout_s
        path = "/v1/approvals/" + urllib.parse.quote(approval_id, safe="")
        while True:
            left = max(0, min(30, math.ceil(until - time.monotonic())))
            r = self._req("GET", f"{path}?wait={left}", wait_s=left)
            state = r.get("status")
            if state not in _STATES:
                raise GovernError("Elan1 Govern sent an approval without a status", 0)
            s = ApprovalStatus(
                approval_id=str(r.get("approval_id")),
                status=state,
                expires_at=str(r.get("expires_at")),
                rule_id=str(r.get("rule_id")),
                message=str(r.get("message")),
            )
            if s.status != "pending" or time.monotonic() >= until:
                return s
