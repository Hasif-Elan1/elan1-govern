import { createHash, createPublicKey, sign } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_DETAIL_KEYS,
  checkpointPreimage,
  encodeConsoleReceipt,
  fromConsoleCheckpoint,
  fromConsoleReceipt,
  isChainFormat,
  publicKeyHex,
  receiptPreimage,
  signatureHex,
  toConsoleCheckpoint,
  toConsoleReceipt,
  type ConsoleReceipt,
} from "../src/console-receipt";
import { GENESIS, buildReceipt, receiptHash, signCheckpoint, verifyChain, verifyCheckpoint, type Receipt, type ReceiptInput } from "../src/receipt";
import { keyFingerprint } from "../src/crypto";
import { KEYS } from "./fixtures";

const KID = keyFingerprint(KEYS.publicKeyPem);

const ts = "2026-10-29T09:30:00.000Z";
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A console receipt body as the console's domain writes one (apps/console/src/mock/chain.ts and db.ts). */
const consoleApproval = {
  kind: "approval",
  agent: "invoice-bot",
  tool: "zoho_books.record_payment",
  ref_seq: 3001,
  approval: { id: "apr_1", status: "approved_run_failed", approver: "u_venkat", channel: "slack", self_approval: false },
  decision: "allow",
  reason: "Matches the PO and GRN.",
  outcome: { status: "error", ref: "zoho:123456", ms: 420 },
  actor: "u_venkat",
  details: { channel: "slack", mode: "governed_run" },
};

describe("console receipts in core's format", () => {
  it("encodes the console's own fields into core's names and details, and reads them back", () => {
    const enc = encodeConsoleReceipt({ ...consoleApproval, environment: "sandbox" });
    expect(enc.approval).toEqual({ id: "apr_1", result: "approved", by: "u_venkat", self_approval: false });
    expect(enc.outcome).toEqual({ status: "error", ref: "zoho:123456" });
    expect(enc.details).toEqual({
      channel: "slack",
      mode: "governed_run",
      [CONSOLE_DETAIL_KEYS.approvalStatus]: "approved_run_failed",
      [CONSOLE_DETAIL_KEYS.approvalChannel]: "slack",
      [CONSOLE_DETAIL_KEYS.outcomeMs]: 420,
      [CONSOLE_DETAIL_KEYS.environment]: "sandbox",
    });
    expect(enc).not.toHaveProperty("environment");

    // signed by core as any receipt is, and read back as the console wrote it
    const r = buildReceipt(enc as ReceiptInput, { org: "org_demo", ts, head: GENESIS, kid: KID }, KEYS.privateKeyPem);
    const back = toConsoleReceipt(r);
    expect(back).toMatchObject({ ...consoleApproval, environment: "sandbox", seq: 1, org: "org_demo", ts, prev_hash: GENESIS.hash, kid: KID, hash: r.hash, sig: r.sig });
    expect(back.details).toEqual(consoleApproval.details);
    expect(fromConsoleReceipt(back)).toEqual(r);
    // the console verifies it by recomputing core's hash over the console form
    expect(sha(receiptPreimage(back))).toBe(r.hash);
    expect(verifyChain([fromConsoleReceipt(back)], KEYS.publicKeyPem).ok).toBe(true);
  });

  it("leaves details alone when nothing needed them, and keeps an empty details object", () => {
    const plain = buildReceipt({ kind: "admin", actor: "a@b.in", action: "framework.enabled", details: {} }, { org: "o", ts, head: GENESIS }, KEYS.privateKeyPem);
    expect(toConsoleReceipt(plain).details).toEqual({});
    const bare = buildReceipt({ kind: "admin", actor: "a@b.in", action: "x" }, { org: "o", ts, head: GENESIS }, KEYS.privateKeyPem);
    expect(toConsoleReceipt(bare)).not.toHaveProperty("details");
    expect(fromConsoleReceipt(toConsoleReceipt(bare))).toEqual(bare);
    // a receipt with only console values in details: none left after reading, all back after encoding
    const only = encodeConsoleReceipt({ kind: "decision", tool: "t", decision: "allow", outcome: { status: "ok", ms: 9 } });
    const r = buildReceipt(only as ReceiptInput, { org: "o", ts, head: GENESIS }, KEYS.privateKeyPem);
    expect(toConsoleReceipt(r)).not.toHaveProperty("details");
    expect(fromConsoleReceipt(toConsoleReceipt(r))).toEqual(r);
  });

  it("reads a gate approval (by, at, expires_at) the console way and keeps what it does not know", () => {
    const g = buildReceipt(
      { kind: "approval", agent: "ap-bot", ref_seq: 4, approval: { id: "a1", result: "rejected", by: "priya@acme.in", at: ts, expires_at: ts }, decision: "refuse" },
      { org: "o", ts, head: GENESIS },
      KEYS.privateKeyPem,
    );
    const c = toConsoleReceipt(g);
    expect(c.approval).toEqual({ id: "a1", status: "rejected", approver: "priya@acme.in", at: ts, expires_at: ts });
    expect(fromConsoleReceipt(c)).toEqual(g);
  });

  it("refuses a field a chain receipt has no place for, and a details key the encoding needs", () => {
    expect(() => encodeConsoleReceipt({ kind: "admin", redacted: { fields: [] } })).toThrow(/no field "redacted"/);
    expect(() => encodeConsoleReceipt({ kind: "admin", environment: "sandbox", details: { [CONSOLE_DETAIL_KEYS.environment]: "x" } })).toThrow(/reserved/);
  });

  // core receipts of every shape, details carrying reserved keys with any value: the console form always maps back
  const json = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
  const reserved = fc.constantFrom(...Object.values(CONSOLE_DETAIL_KEYS));
  const details = fc.option(
    fc.dictionary(fc.oneof(reserved, fc.string({ minLength: 1, maxLength: 6 })), fc.oneof(json, fc.constantFrom("approved_run_failed", "slack", 120)), { maxKeys: 5 }),
    { nil: undefined },
  );
  const input: fc.Arbitrary<ReceiptInput> = fc.record(
    {
      kind: fc.constantFrom("decision", "approval", "outcome", "admin"),
      agent: fc.string({ maxLength: 8 }),
      tool: fc.string({ maxLength: 8 }),
      decision: fc.constantFrom("allow", "ask", "refuse"),
      approval: fc.record(
        { id: fc.string({ minLength: 1, maxLength: 6 }), result: fc.constantFrom("pending", "approved", "rejected", "expired"), by: fc.string({ maxLength: 6 }), at: fc.constant(ts), self_approval: fc.boolean() },
        { requiredKeys: ["id", "result"] },
      ),
      outcome: fc.record({ status: fc.constantFrom("ok", "error", "not_run"), ref: fc.string({ maxLength: 6 }), error: fc.string({ maxLength: 6 }) }, { requiredKeys: ["status"] }),
      ref_seq: fc.nat(1000),
      actor: fc.string({ maxLength: 6 }),
      action: fc.string({ maxLength: 10 }),
      details,
    },
    { requiredKeys: ["kind"] },
  ) as fc.Arbitrary<ReceiptInput>;

  it("property: every chain receipt maps to the console form and back to the same bytes", () => {
    fc.assert(
      fc.property(input, (i) => {
        const r = buildReceipt(i, { org: "o", ts, head: GENESIS, kid: "k" }, KEYS.privateKeyPem);
        const c = toConsoleReceipt(JSON.parse(JSON.stringify(r)) as Receipt);
        expect(fromConsoleReceipt(c)).toEqual(r);
        expect(sha(receiptPreimage(c))).toBe(receiptHash(r));
      }),
      { numRuns: 300 },
    );
  });

  const consoleBody = fc.record(
    {
      kind: fc.constantFrom("decision", "approval", "admin"),
      approval: fc.record(
        { id: fc.string({ minLength: 1, maxLength: 6 }), status: fc.constantFrom("pending", "approved", "rejected", "expired", "approved_run_failed"), approver: fc.string({ maxLength: 6 }), channel: fc.constantFrom("web", "slack", "whatsapp"), self_approval: fc.boolean() },
        { requiredKeys: ["id", "status"] },
      ),
      outcome: fc.record({ status: fc.constantFrom("ok", "error", "not_run"), ref: fc.string({ maxLength: 6 }), ms: fc.nat(5000) }, { requiredKeys: ["status"] }),
      environment: fc.constantFrom("sandbox", "production"),
      details: fc.option(fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.oneof(fc.string(), fc.integer(), fc.boolean()), { maxKeys: 4 }), { nil: undefined }),
    },
    { requiredKeys: ["kind"] },
  );

  it("property: what the console writes reads back as the console wrote it", () => {
    fc.assert(
      fc.property(consoleBody, (body) => {
        const r = buildReceipt(encodeConsoleReceipt(body) as ReceiptInput, { org: "o", ts, head: GENESIS }, KEYS.privateKeyPem);
        const { seq: _s, ts: _t, org: _o, prev_hash: _p, kid: _k, hash: _h, sig: _g, ...back } = toConsoleReceipt(r);
        const expected = { ...body } as Record<string, unknown>;
        // an empty details object the console wrote alongside console-only values reads back as none
        const consoleOnly = body.approval?.status === "approved_run_failed" || body.approval?.channel !== undefined || body.outcome?.ms !== undefined || body.environment !== undefined;
        if (expected.details && !Object.keys(expected.details).length && consoleOnly) delete expected.details;
        expect(back).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("tells the chain's receipts from the console's demo ones", () => {
    expect(isChainFormat({ hash: "sha256:ab" })).toBe(true);
    expect(isChainFormat({ hash: "ab".repeat(32) })).toBe(false);
    expect(isChainFormat(null)).toBe(false);
    expect(isChainFormat([])).toBe(false);
  });
});

describe("checkpoints, signatures and keys", () => {
  it("maps a chain checkpoint to the console's and recomputes what it signs", () => {
    const cp = signCheckpoint({ org: "o", seq: 7, hash: "sha256:00", ts, kid: KID }, KEYS.privateKeyPem);
    const c = toConsoleCheckpoint(cp);
    expect(c).toMatchObject({ id: "cp_7", ...cp });
    expect(fromConsoleCheckpoint({ ...c, onDemand: true })).toEqual(cp);
    expect(verifyCheckpoint(fromConsoleCheckpoint(c), [{ publicKeyPem: KEYS.publicKeyPem }])).toBe(true);
    // the signature is over the SHA-256 of the preimage, as text
    const msg = sha(checkpointPreimage(c));
    const pub = createPublicKey(KEYS.publicKeyPem);
    expect(signatureHex(cp.sig)).toBe(Buffer.from(cp.sig.slice("ed25519:".length), "base64").toString("hex"));
    expect(Buffer.from(signatureHex(cp.sig)!, "hex").equals(sign(null, Buffer.from(msg), KEYS.privateKeyPem))).toBe(true);
    expect(pub.asymmetricKeyType).toBe("ed25519");
    const noKid = signCheckpoint({ org: "o", seq: 1, hash: "sha256:00", ts }, KEYS.privateKeyPem);
    expect(fromConsoleCheckpoint(toConsoleCheckpoint(noKid))).toEqual(noKid);
    expect(checkpointPreimage(noKid)).not.toContain("kid");
  });

  it("reads an Ed25519 signature and public key as the raw hex the console's verifier takes", () => {
    const raw = createPublicKey(KEYS.publicKeyPem).export({ format: "jwk" }).x!;
    expect(publicKeyHex(KEYS.publicKeyPem)).toBe(Buffer.from(raw, "base64url").toString("hex"));
    expect(() => publicKeyHex("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toThrow(/not an Ed25519/);
    expect(() => publicKeyHex("not base64 at all!")).toThrow(/not an Ed25519/);
    expect(signatureHex("deadbeef")).toBeUndefined();
    expect(signatureHex("ed25519:AAAA")).toBeUndefined();
    expect(signatureHex("ed25519:*bad*")).toBeUndefined();
    expect(signatureHex(42 as unknown as string)).toBeUndefined();
  });
});

describe("the console form of a receipt", () => {
  it("keeps its chain strings untouched", () => {
    const r = buildReceipt({ kind: "admin", action: "x" }, { org: "o", ts, head: GENESIS, kid: "k" }, KEYS.privateKeyPem);
    const c: ConsoleReceipt = toConsoleReceipt(r);
    expect([c.hash, c.sig, c.prev_hash, c.kid]).toEqual([r.hash, r.sig, r.prev_hash, r.kid]);
    expect(c.hash.startsWith("sha256:") && c.sig.startsWith("ed25519:")).toBe(true);
  });
});
