"""guarded(): wrap a Python function as a tool that Elan1 Govern checks before it runs."""

from __future__ import annotations

import asyncio
import functools
import inspect
from typing import Any, Callable, Dict, Optional, TypeVar, cast

from .client import CheckResult, Govern, GovernError

F = TypeVar("F", bound=Callable[..., Any])


class Refused(Exception):
    """Elan1 Govern refused the action, or a person rejected it, or the approval expired. The tool did not run."""

    def __init__(self, rule_id: str, reason: str, approval_id: Optional[str] = None) -> None:
        super().__init__(f'Refused by rule "{rule_id}": {reason}')
        self.rule_id = rule_id
        self.reason = reason
        self.approval_id = approval_id


class ApprovalPending(Exception):
    """The action needs a person's approval and no decision was made in time. The tool did not run.

    Show ``approval_url`` to someone who can decide. Do not retry the action: check again later
    with ``Govern.wait_for_approval(approval_id)``.
    """

    def __init__(self, check: CheckResult) -> None:
        super().__init__(f"Waiting for approval: {check.reason} ({check.approval_url})")
        self.rule_id = check.rule_id
        self.reason = check.reason
        self.approval_id = check.approval_id
        self.approval_url = check.approval_url
        self.expires_at = check.expires_at


class RecordError(GovernError):
    """The tool ran, but Elan1 Govern could not record the outcome. Do not run it again.

    ``result`` holds what the tool returned.
    """

    def __init__(self, cause: GovernError, result: Any) -> None:
        super().__init__(f"The action ran but its outcome was not recorded: {cause.message}", cause.status)
        self.result = result


def _arguments(sig: inspect.Signature, args: tuple, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    bound = sig.bind(*args, **kwargs)
    bound.apply_defaults()
    out: Dict[str, Any] = {}
    for name, value in bound.arguments.items():
        kind = sig.parameters[name].kind
        if kind is inspect.Parameter.VAR_KEYWORD:
            out.update(value)
        elif kind is inspect.Parameter.VAR_POSITIONAL:
            out[name] = list(value)
        else:
            out[name] = value
    return out


def _truncate(s: Optional[str], n: int) -> Optional[str]:
    return s[:n] if s else None


def guarded(
    gov: Govern,
    tool: str,
    *,
    wait: bool = False,
    timeout_s: float = 600,
    ref: Optional[Callable[[Any], Optional[str]]] = None,
) -> Callable[[F], F]:
    """Decorator: check with Elan1 Govern first, run only if allowed, then record the outcome.

    ``tool`` is the tool name Elan1 Govern knows (e.g. ``crm.issue_refund``). The function's
    arguments, by parameter name, are sent as the tool's arguments, so they must be JSON values.

    - allow: the function runs, and ``ok`` (or ``error`` with the exception text) is recorded.
    - refuse: raises ``Refused``.
    - ask: with ``wait=False`` (the default) raises ``ApprovalPending`` at once. With
      ``wait=True`` waits up to ``timeout_s`` for a person; runs on approval, raises ``Refused`` on
      rejection or expiry and ``ApprovalPending`` if nobody decided in time.

    ``ref`` turns the function's return value into a short reference for the receipt (for
    example a payment id). Errors talking to Elan1 Govern before the run raise ``GovernError`` and
    the function never runs. Works on plain and ``async`` functions.
    """

    def decide(args: Dict[str, Any]) -> Dict[str, Any]:
        """Returns the record() keyword that identifies this action, or raises."""
        check = gov.check(tool, args)
        if check.decision == "allow":
            if check.check_id is None:
                raise GovernError("Elan1 Govern allowed the action but sent no check_id", 0)
            return {"check_id": check.check_id}
        if check.decision == "refuse":
            raise Refused(check.rule_id, check.reason)
        if not wait or check.approval_id is None:
            raise ApprovalPending(check)
        s = gov.wait_for_approval(check.approval_id, timeout_s)
        if s.status == "approved":
            return {"approval_id": check.approval_id}
        if s.status == "pending":
            raise ApprovalPending(check)
        raise Refused(s.rule_id, s.message, approval_id=check.approval_id)

    def ok(key: Dict[str, Any], result: Any) -> Any:
        try:
            gov.record(**key, status="ok", ref=_truncate(ref(result) if ref else None, 200))
        except GovernError as e:
            raise RecordError(e, result) from e
        return result

    def failed(key: Dict[str, Any], exc: BaseException) -> None:
        try:
            gov.record(**key, status="error", error=_truncate(f"{type(exc).__name__}: {exc}", 500))
        except GovernError:
            pass  # the tool's own exception is the one the caller needs to see

    def wrap(fn: F) -> F:
        sig = inspect.signature(fn)

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def run_async(*a: Any, **kw: Any) -> Any:
                key = await asyncio.to_thread(decide, _arguments(sig, a, kw))
                try:
                    result = await fn(*a, **kw)
                except Exception as e:
                    await asyncio.to_thread(failed, key, e)
                    raise
                return await asyncio.to_thread(ok, key, result)

            return cast(F, run_async)

        @functools.wraps(fn)
        def run(*a: Any, **kw: Any) -> Any:
            key = decide(_arguments(sig, a, kw))
            try:
                result = fn(*a, **kw)
            except Exception as e:
                failed(key, e)
                raise
            return ok(key, result)

        return cast(F, run)

    return wrap
