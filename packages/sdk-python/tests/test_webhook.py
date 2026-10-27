from __future__ import annotations

import hashlib
import hmac
import unittest

import _support  # noqa: F401  (puts src/ on the path)

from elan1_govern import verify_webhook

# Computed once with the TypeScript SDK's logic (createHmac over "<t>.<body>", checked with
# packages/sdk/src/webhook.ts verifyWebhook, which returned true). The body has non-ASCII text
# so both sides must hash the same UTF-8 bytes.
SECRET = "whsec_fixture_secret"
BODY = '{"id":"d_1","type":"receipt.created","org":"org_1","data":{"vendor":"Śrī Traders","amount_inr":200000}}'
T = 1793000000
HEADER = "t=1793000000,v1=0d4207b425812906f4ea16e7e30d89bf0a55098ec1788ded3e08e924ec1f7092"


def sign(secret: str, t: int, body: str) -> str:
    return hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()


class WebhookTest(unittest.TestCase):
    def test_signature_from_the_typescript_sdk_verifies(self) -> None:
        self.assertTrue(verify_webhook(HEADER, BODY, SECRET, now=T))
        self.assertTrue(verify_webhook(HEADER, BODY.encode("utf-8"), SECRET, now=T + 299.9))

    def test_tampered_body_or_wrong_secret(self) -> None:
        self.assertFalse(verify_webhook(HEADER, BODY.replace("200000", "900000"), SECRET, now=T))
        self.assertFalse(verify_webhook(HEADER, BODY, "whsec_other", now=T))
        self.assertFalse(verify_webhook(HEADER.replace("t=1793000000", "t=1793000001"), BODY, SECRET, now=T))

    def test_expired_or_future_timestamp(self) -> None:
        self.assertFalse(verify_webhook(HEADER, BODY, SECRET, now=T + 301))
        self.assertFalse(verify_webhook(HEADER, BODY, SECRET, now=T - 301))
        self.assertTrue(verify_webhook(HEADER, BODY, SECRET, now=T + 300))
        self.assertTrue(verify_webhook(HEADER, BODY, SECRET, tolerance_s=3600, now=T + 3000))

    def test_uses_the_clock_by_default(self) -> None:
        self.assertFalse(verify_webhook(HEADER, BODY, SECRET))
        import time

        t = int(time.time())
        self.assertTrue(verify_webhook(f"t={t},v1={sign(SECRET, t, BODY)}", BODY, SECRET))

    def test_any_of_several_v1_signatures(self) -> None:
        good = sign(SECRET, T, BODY)
        self.assertTrue(verify_webhook(f"t={T}, v1={'0' * 64}, v1={good}", BODY, SECRET, now=T))

    def test_malformed_headers(self) -> None:
        good = sign(SECRET, T, BODY)
        for header in [None, "", "garbage", f"v1={good}", f"t={T}", f"t={T},v1={good.upper()}", f"t={T},v1={good[:-2]}", f"t=-{T},v1={good}", f"t={T}x,v1={good}"]:
            self.assertFalse(verify_webhook(header, BODY, SECRET, now=T), header)
        self.assertFalse(verify_webhook(HEADER, BODY, "", now=T))


if __name__ == "__main__":
    unittest.main()
