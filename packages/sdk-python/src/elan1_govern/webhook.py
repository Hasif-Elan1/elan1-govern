"""Checking Elan1 Govern webhook signatures. Same rules as verifyWebhook in the TypeScript SDK."""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Optional, Union

_T = re.compile(r"[0-9]{1,12}")
_V1 = re.compile(r"[0-9a-f]{64}")


def verify_webhook(
    header: Optional[str],
    body: Union[str, bytes],
    secret: str,
    tolerance_s: int = 300,
    now: Optional[float] = None,
) -> bool:
    """Check an Elan1 Govern webhook.

    ``header`` is the ``gate-signature`` header (``t=<unix>,v1=<hex>``), ``body`` the raw request
    body as received, before JSON parsing. Signatures whose timestamp is more than ``tolerance_s``
    seconds (default 5 minutes) from ``now`` are rejected, which stops replays.
    """
    if not secret or not isinstance(header, str):
        return False
    t: Optional[int] = None
    sigs = []
    for part in header.split(","):
        k, sep, v = part.partition("=")
        if not sep:
            continue
        k, v = k.strip(), v.strip()
        if k == "t" and _T.fullmatch(v):
            t = int(v)
        if k == "v1" and _V1.fullmatch(v):
            sigs.append(v)
    if t is None or not sigs:
        return False
    current = int((time.time() if now is None else now) // 1)
    if abs(current - t) > tolerance_s:
        return False
    text = body if isinstance(body, str) else body.decode("utf-8", errors="replace")
    expected = hmac.new(secret.encode("utf-8"), f"{t}.{text}".encode("utf-8"), hashlib.sha256).digest()
    return any(hmac.compare_digest(bytes.fromhex(s), expected) for s in sigs)
