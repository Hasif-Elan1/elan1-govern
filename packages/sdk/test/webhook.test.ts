import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook } from "../src";

const secret = "whsec_test_secret";
const body = JSON.stringify({ id: "d1", type: "receipt.created", data: { seq: 1 } });
const now = 1_790_000_000_000;
const t = Math.floor(now / 1000);
const mac = (s: string, ts: number, b: string) => createHmac("sha256", s).update(`${ts}.${b}`).digest("hex");
const header = (ts = t, b = body, s = secret) => `t=${ts},v1=${mac(s, ts, b)}`;

describe("verifyWebhook", () => {
  it("accepts a valid signature, as text or bytes", () => {
    expect(verifyWebhook(secret, header(), body, { now })).toBe(true);
    expect(verifyWebhook(secret, header(), new TextEncoder().encode(body), { now })).toBe(true);
    expect(verifyWebhook(secret, ` t=${t} , v1=${mac(secret, t, body)} `, body, { now })).toBe(true);
  });

  it("accepts any of several v1 signatures (secret rollover)", () => {
    expect(verifyWebhook(secret, `t=${t},v1=${mac("old", t, body)},v1=${mac(secret, t, body)}`, body, { now })).toBe(true);
  });

  it("rejects a changed body, wrong secret or forged header", () => {
    expect(verifyWebhook(secret, header(), body.replace("d1", "d2"), { now })).toBe(false);
    expect(verifyWebhook("other", header(), body, { now })).toBe(false);
    expect(verifyWebhook(secret, `t=${t},v1=${"0".repeat(64)}`, body, { now })).toBe(false);
    expect(verifyWebhook(secret, `t=${t + 1},v1=${mac(secret, t, body)}`, body, { now: now + 1000 })).toBe(false);
  });

  it("rejects old or future timestamps (replay)", () => {
    expect(verifyWebhook(secret, header(t - 301), body, { now })).toBe(false);
    expect(verifyWebhook(secret, header(t + 301), body, { now })).toBe(false);
    expect(verifyWebhook(secret, header(t - 600), body, { now, toleranceSeconds: 900 })).toBe(true);
    expect(verifyWebhook(secret, header(Math.floor(Date.now() / 1000)), body)).toBe(true);
  });

  it("rejects malformed headers", () => {
    for (const h of [undefined, null, "", "garbage", `t=${t}`, `v1=${mac(secret, t, body)}`, `t=abc,v1=${mac(secret, t, body)}`, `t=${t},v1=xyz`, "t,v1"]) {
      expect(verifyWebhook(secret, h, body, { now })).toBe(false);
    }
    expect(verifyWebhook("", header(), body, { now })).toBe(false);
  });
});
