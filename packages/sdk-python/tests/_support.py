"""Test helpers: puts src/ on the path and runs a fake Elan1 Govern service on a free local port."""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

Reply = Tuple[int, Union[Dict[str, Any], str, bytes]]
Handler = Callable[["Request"], Reply]


class Request:
    def __init__(self, method: str, path: str, headers: Dict[str, str], body: Optional[Any]) -> None:
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body


class FakeGovern:
    """Answers each request from `replies` in order (a Reply, or a function of the Request)."""

    def __init__(self) -> None:
        self.replies: List[Union[Reply, Handler]] = []
        self.requests: List[Request] = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def _handle(self) -> None:
                n = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(n) if n else b""
                req = Request(self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, json.loads(raw) if raw else None)
                fake.requests.append(req)
                reply = fake.replies.pop(0) if fake.replies else (500, {"error": "no reply scripted"})
                status, body = reply(req) if callable(reply) else reply
                data = body if isinstance(body, bytes) else (body.encode() if isinstance(body, str) else json.dumps(body).encode())
                self.send_response(status)
                if status in (301, 302, 307, 308):
                    self.send_header("location", "http://127.0.0.1:1/elsewhere")
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _handle
            do_POST = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def allow(check_id: int = 7, rule_id: str = "small-refunds") -> Reply:
    return (200, {"decision": "allow", "rule_id": rule_id, "reason": "Within the limit.", "check_id": check_id})


def refuse(rule_id: str = "never-delete") -> Reply:
    return (200, {"decision": "refuse", "rule_id": rule_id, "reason": "Deleting is never allowed.", "check_id": 8})


def ask(approval_id: str = "ap_1") -> Reply:
    return (
        200,
        {
            "decision": "ask",
            "rule_id": "large-refunds",
            "reason": "Over 100 needs a lead.",
            "check_id": 9,
            "approval_id": approval_id,
            "approval_url": f"http://localhost:3000/approvals/{approval_id}",
            "expires_at": "2026-10-28T10:00:00.000Z",
        },
    )


def approval(status: str, approval_id: str = "ap_1") -> Reply:
    return (200, {"approval_id": approval_id, "status": status, "expires_at": "2026-10-28T10:00:00.000Z", "rule_id": "large-refunds", "message": f"It is {status}."})


def recorded(seq: int = 12) -> Reply:
    return (200, {"recorded": True, "receipt_seq": seq})
