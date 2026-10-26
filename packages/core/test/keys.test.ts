import { describe, expect, it } from "vitest";
import { buildBundle, readBundleFiles, verifyBundle, writeBundleFiles } from "../src/bundle";
import { generateKeyPair, hashCanonical, keyFingerprint, signText } from "../src/crypto";
import { KEY_ROTATED_ACTION, KeyRing, type PublicKeyInfo } from "../src/keys";
import { GENESIS, buildReceipt, receiptHash, signCheckpoint, verifyChain, verifyCheckpoint, type ChainHead, type Receipt, type ReceiptInput } from "../src/receipt";
import { KEYS, OTHER_KEYS } from "./fixtures";

const A = KEYS;
const B = OTHER_KEYS;
const kidA = keyFingerprint(A.publicKeyPem);
const kidB = keyFingerprint(B.publicKeyPem);
const ROTATED_AT = "2026-10-26T12:00:00.000Z";

const decision: ReceiptInput = { kind: "decision", agent: "ap-bot", tool: "gmail.search", rule_id: "search-mail", decision: "allow" };

/** Appends receipts to a chain, each with its own time, key and optional kid. */
class Chain {
  receipts: Receipt[] = [];
  head: ChainHead = GENESIS;
  add(ts: string, key: { privateKeyPem: string }, kid?: string, input: ReceiptInput = decision) {
    const r = buildReceipt(input, { org: "org1", ts, head: this.head, ...(kid ? { kid } : {}) }, key.privateKeyPem);
    this.receipts.push(r);
    this.head = { seq: r.seq, hash: r.hash };
    return r;
  }
  rotate(ts: string, from: { privateKeyPem: string }, fromKid: string, toKid: string) {
    return this.add(ts, from, fromKid, { kind: "admin", actor: "owner@acme.in", action: KEY_ROTATED_ACTION, details: { old_kid: fromKid, new_kid: toKid } });
  }
}

/** Legacy receipts (no kid), then kid A, a rotation signed by A naming B, then kid B. */
function mixed() {
  const c = new Chain();
  c.add("2026-10-26T09:00:00.000Z", A);
  c.add("2026-10-26T10:00:00.000Z", A, kidA);
  c.rotate(ROTATED_AT, A, kidA, kidB);
  c.add("2026-10-26T13:00:00.000Z", B, kidB);
  c.add("2026-10-26T14:00:00.000Z", B, kidB);
  return c;
}

const ring: PublicKeyInfo[] = [
  { kid: kidA, publicKeyPem: A.publicKeyPem, retiredAt: ROTATED_AT },
  { kid: kidB, publicKeyPem: B.publicKeyPem },
];

describe("key ring", () => {
  it("ids keys by fingerprint and refuses a wrong label", () => {
    const r = new KeyRing(ring);
    expect(r.size).toBe(2);
    expect(r.has(kidA)).toBe(true);
    expect(r.has("nope")).toBe(false);
    expect(() => new KeyRing([{ kid: kidB, publicKeyPem: A.publicKeyPem }])).toThrow(/does not match its fingerprint/);
    expect(verifyChain([], [{ kid: "bad", publicKeyPem: A.publicKeyPem }])).toMatchObject({ ok: false, seq: null, reason: expect.stringMatching(/fingerprint/) });
  });

  it("checks signatures by kid and time", () => {
    const r = new KeyRing(ring);
    const sig = signText(A.privateKeyPem, "x");
    expect(r.verify("x", sig, "2026-10-26T11:00:00.000Z", kidA)).toEqual({ ok: true, kid: kidA });
    expect(r.verify("x", sig, ROTATED_AT, kidA).ok).toBe(true);
    expect(r.verify("x", sig, "2026-10-26T12:00:00.001Z", kidA)).toEqual({ ok: false, reason: `signed with key ${kidA} after it was retired` });
    expect(r.verify("x", sig, "not a date", kidA).ok).toBe(false);
    expect(r.verify("x", sig, "2026-10-26T11:00:00.000Z", "feedfeedfeedfeed")).toEqual({ ok: false, reason: "signed with an unknown key (feedfeedfeedfeed)" });
    expect(r.verify("x", sig, "2026-10-26T11:00:00.000Z", kidB)).toEqual({ ok: false, reason: "has an invalid signature" });
    // Without a kid any key live at that time may have signed it.
    expect(r.verify("x", sig, "2026-10-26T11:00:00.000Z")).toEqual({ ok: true, kid: kidA });
    expect(r.verify("x", sig, "2026-10-27T00:00:00.000Z").ok).toBe(false);
    expect(r.verify("x", signText(B.privateKeyPem, "x"), "2026-10-27T00:00:00.000Z")).toEqual({ ok: true, kid: kidB });
  });

  it("retire keeps the earliest time and ignores unknown keys or bad times", () => {
    const r = new KeyRing(A.publicKeyPem);
    const sig = signText(A.privateKeyPem, "x");
    r.retire("unknown", ROTATED_AT);
    r.retire(kidA, "garbage");
    expect(r.verify("x", sig, "2030-01-01T00:00:00.000Z", kidA).ok).toBe(true);
    r.retire(kidA, ROTATED_AT);
    r.retire(kidA, "2026-12-01T00:00:00.000Z");
    expect(r.verify("x", sig, "2026-11-01T00:00:00.000Z", kidA).ok).toBe(false);
    r.retire(kidA, "2026-10-01T00:00:00.000Z");
    expect(r.verify("x", sig, "2026-10-20T00:00:00.000Z", kidA).ok).toBe(false);
  });
});

describe("chains across a key rotation", () => {
  it("a mixed-kid chain verifies, with or without declared retirement times", () => {
    const c = mixed();
    expect(verifyChain(c.receipts, ring)).toMatchObject({ ok: true, count: 5, lastSeq: 5 });
    expect(verifyChain(c.receipts, [{ publicKeyPem: A.publicKeyPem }, { publicKeyPem: B.publicKeyPem }])).toMatchObject({ ok: true, count: 5 });
    expect(c.receipts[0]).not.toHaveProperty("kid");
    expect(c.receipts[1]!.kid).toBe(kidA);
  });

  it("the kid is covered by the hash", () => {
    const c = mixed();
    const r = c.receipts[3]!;
    c.receipts[3] = { ...r, kid: kidA };
    expect(verifyChain(c.receipts, ring)).toEqual({ ok: false, seq: 4, reason: "receipt 4 was changed after it was written" });
    // Recomputing the hash breaks the signature (and the next link).
    const relabelled = { ...r, kid: kidA };
    c.receipts[3] = { ...relabelled, hash: receiptHash(relabelled) };
    expect(verifyChain(c.receipts, ring)).toMatchObject({ ok: false, seq: 4, reason: expect.stringMatching(/after it was retired|invalid signature/) });
    // Removing the kid from an old receipt is also an edit.
    const d = mixed();
    const { kid: _k, ...noKid } = d.receipts[1]!;
    d.receipts[1] = noKid as Receipt;
    expect(verifyChain(d.receipts, ring)).toMatchObject({ ok: false, seq: 2, reason: "receipt 2 was changed after it was written" });
  });

  it("an unknown kid is refused", () => {
    const c = mixed();
    expect(verifyChain(c.receipts, A.publicKeyPem)).toEqual({ ok: false, seq: 4, reason: `receipt 4 signed with an unknown key (${kidB})` });
  });

  it("a retired key cannot keep signing, even without the declared retirement time", () => {
    const c = mixed();
    c.add("2026-10-26T15:00:00.000Z", A, kidA);
    const undeclared = [{ publicKeyPem: A.publicKeyPem }, { publicKeyPem: B.publicKeyPem }];
    expect(verifyChain(c.receipts, undeclared)).toEqual({ ok: false, seq: 6, reason: `receipt 6 signed with key ${kidA} after it was retired` });
    // A receipt without a kid, signed by the retired key after the handover, fails too.
    const d = mixed();
    d.add("2026-10-26T15:00:00.000Z", A);
    expect(verifyChain(d.receipts, undeclared)).toEqual({ ok: false, seq: 6, reason: "receipt 6 has an invalid signature" });
    // A declared retirement time alone (rotation receipt outside the range) is enforced.
    const e = new Chain();
    e.add("2026-10-26T13:00:00.000Z", A, kidA);
    expect(verifyChain(e.receipts, ring)).toMatchObject({ ok: false, seq: 1, reason: expect.stringMatching(/after it was retired/) });
  });

  it("a rotation receipt must name a different new key", () => {
    const c = new Chain();
    c.add(ROTATED_AT, A, kidA, { kind: "admin", actor: "x", action: KEY_ROTATED_ACTION, details: {} });
    expect(verifyChain(c.receipts, A.publicKeyPem)).toMatchObject({ ok: false, seq: 1, reason: expect.stringMatching(/does not name a new one/) });
    const d = new Chain();
    d.rotate(ROTATED_AT, A, kidA, kidA);
    expect(verifyChain(d.receipts, A.publicKeyPem)).toMatchObject({ ok: false, seq: 1 });
  });

  it("checkpoints carry a kid and respect retirement", () => {
    const c = mixed();
    const head = c.receipts.at(-1)!;
    const good = signCheckpoint({ org: "org1", seq: head.seq, hash: head.hash, ts: "2026-10-26T15:00:00.000Z", kid: kidB }, B.privateKeyPem);
    expect(verifyCheckpoint(good, ring)).toBe(true);
    expect(verifyChain(c.receipts, ring, { checkpoints: [good] })).toMatchObject({ ok: true, checkpoints: 1 });
    const stale = signCheckpoint({ org: "org1", seq: head.seq, hash: head.hash, ts: "2026-10-26T15:00:00.000Z", kid: kidA }, A.privateKeyPem);
    expect(verifyCheckpoint(stale, ring)).toBe(false);
    // Retired by the rotation receipt in the chain, even if the caller did not say so.
    const undeclared = [{ publicKeyPem: A.publicKeyPem }, { publicKeyPem: B.publicKeyPem }];
    expect(verifyChain(c.receipts, undeclared, { checkpoints: [stale] })).toMatchObject({ ok: false, seq: head.seq, reason: expect.stringMatching(/checkpoint/) });
    expect(verifyCheckpoint({ ...good, kid: kidA }, ring)).toBe(false);
  });
});

describe("bundles with several keys", () => {
  const make = (receipts: Receipt[], extra: Partial<Parameters<typeof buildBundle>[0]> = {}) =>
    buildBundle({
      org: { id: "org1", name: "Acme" },
      range: { from: "2026-10-26", to: "2026-10-26" },
      anchor: GENESIS,
      receipts,
      checkpoints: [],
      publicKeyPem: B.publicKeyPem,
      privateKeyPem: B.privateKeyPem,
      publicKeys: [
        { publicKeyPem: A.publicKeyPem, createdAt: "2026-01-01T00:00:00.000Z", retiredAt: ROTATED_AT },
        { publicKeyPem: B.publicKeyPem, createdAt: ROTATED_AT },
      ],
      generatedAt: "2026-10-26T16:00:00.000Z",
      ...extra,
    });
  const tamper = (zip: Uint8Array, fn: (f: Record<string, string>) => void) => {
    const files = readBundleFiles(zip);
    fn(files);
    return writeBundleFiles(files);
  };
  const resign = (f: Record<string, string>, change: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(f["manifest.json"]!);
    delete m.sig;
    change(m);
    m.sig = signText(B.privateKeyPem, hashCanonical(m));
    f["manifest.json"] = JSON.stringify(m);
  };

  it("writes every public key by kid and verifies a mixed chain", () => {
    const zip = make(mixed().receipts);
    const files = readBundleFiles(zip);
    expect(JSON.parse(files["public_keys.json"]!)).toEqual({ [kidA]: A.publicKeyPem, [kidB]: B.publicKeyPem });
    expect(files["public_key.pem"]).toBe(B.publicKeyPem);
    expect(JSON.parse(files["manifest.json"]!)).toMatchObject({ kid: kidB, key_fingerprint: kidB, keys: [{ kid: kidA, retired_at: ROTATED_AT }, { kid: kidB, retired_at: null }] });
    expect(verifyBundle(zip)).toMatchObject({ ok: true, count: 5, fingerprint: kidB, keys: [{ kid: kidA, retiredAt: ROTATED_AT }, { kid: kidB, retiredAt: null }] });
  });

  it("rejects receipts signed by a key after its declared retirement", () => {
    const c = new Chain();
    c.add("2026-10-26T13:00:00.000Z", A, kidA);
    expect(verifyBundle(make(c.receipts))).toMatchObject({ ok: false, seq: 1, reason: expect.stringMatching(/after it was retired/) });
  });

  it("an old bundle without kids or public_keys.json still verifies", () => {
    const c = new Chain();
    c.add("2026-10-26T09:00:00.000Z", A);
    c.add("2026-10-26T10:00:00.000Z", A);
    const zip = make(c.receipts, { publicKeyPem: A.publicKeyPem, privateKeyPem: A.privateKeyPem, publicKeys: undefined });
    const files = readBundleFiles(zip);
    expect(files["public_keys.json"]).toBeUndefined();
    expect(JSON.parse(files["manifest.json"]!)).not.toHaveProperty("kid");
    expect(verifyBundle(zip)).toMatchObject({ ok: true, count: 2, fingerprint: kidA, keys: [{ kid: kidA, retiredAt: null }] });
  });

  it("rejects a tampered key list", () => {
    const zip = make(mixed().receipts);
    expect(verifyBundle(tamper(zip, (f) => (f["public_keys.json"] = "{")))).toMatchObject({ ok: false, reason: "public_keys.json is not valid JSON" });
    expect(verifyBundle(tamper(zip, (f) => (f["public_keys.json"] = "[1]")))).toMatchObject({ ok: false, reason: "public_keys.json is malformed" });
    expect(verifyBundle(tamper(zip, (f) => (f["public_keys.json"] = JSON.stringify({ [kidA]: B.publicKeyPem }))))).toMatchObject({ ok: false, reason: expect.stringMatching(/by the wrong id/) });
    expect(verifyBundle(tamper(zip, (f) => (f["public_keys.json"] = JSON.stringify({ [kidA]: A.publicKeyPem }))))).toMatchObject({ ok: false, reason: "public_key.pem is not listed in public_keys.json" });
    // Adding a key changes the file the manifest signed.
    const extra = generateKeyPair();
    const added = tamper(zip, (f) => (f["public_keys.json"] = JSON.stringify({ ...JSON.parse(f["public_keys.json"]!), [keyFingerprint(extra.publicKeyPem)]: extra.publicKeyPem })));
    expect(verifyBundle(added)).toMatchObject({ ok: false, reason: "public_keys.json does not match the manifest" });
  });

  it("rejects manifests that hide the key list or misname their key", () => {
    const zip = make(mixed().receipts);
    expect(verifyBundle(tamper(zip, (f) => resign(f, (m) => delete m.keys)))).toMatchObject({ ok: false, reason: "manifest.json does not list the bundle's keys" });
    expect(verifyBundle(tamper(zip, (f) => resign(f, (m) => (m.kid = kidA))))).toMatchObject({ ok: false, reason: expect.stringMatching(/different signing key/) });
    expect(
      verifyBundle(
        tamper(zip, (f) =>
          resign(f, (m) => {
            delete (m.files as Record<string, string>)["public_keys.json"];
          }),
        ),
      ),
    ).toMatchObject({ ok: false, reason: "public_keys.json is not covered by the manifest" });
    // Moving a retirement time later, to excuse a late signature, breaks the manifest signature.
    expect(verifyBundle(tamper(zip, (f) => (f["manifest.json"] = f["manifest.json"]!.replace(ROTATED_AT, "2027-01-01T00:00:00.000Z"))))).toMatchObject({ ok: false, reason: "manifest signature is invalid" });
  });
});
