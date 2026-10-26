import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildBundle, readBundleFiles, verifyBundle, writeBundleFiles } from "../src/bundle";
import { GENESIS_HASH, hashCanonical, signText } from "../src/crypto";
import {
  GENESIS,
  buildReceipt,
  receiptHash,
  signCheckpoint,
  verifyChain,
  verifyCheckpoint,
  type ChainHead,
  type Receipt,
  type ReceiptInput,
} from "../src/receipt";
import { KEYS, OTHER_KEYS } from "./fixtures";

const ts = "2026-10-26T10:00:00.000Z";

function makeChain(n: number, from: ChainHead = GENESIS): Receipt[] {
  const out: Receipt[] = [];
  let head = from;
  for (let i = 0; i < n; i++) {
    const input: ReceiptInput = {
      kind: "decision",
      agent: "ap-bot",
      tool: "zoho.record_bill_payment",
      args_summary: { amount_inr: 1000 * (i + 1) },
      args_hash: `sha256:${i}`,
      rule_id: "pay-small",
      decision: "allow",
      outcome: { status: "ok", ref: `PAY-${i}` },
    };
    const r = buildReceipt(input, { org: "org1", ts, head }, KEYS.privateKeyPem);
    out.push(r);
    head = { seq: r.seq, hash: r.hash };
  }
  return out;
}

const verify = (rs: unknown[]) => verifyChain(rs, KEYS.publicKeyPem);

describe("receipts", () => {
  it("are linked and signed", () => {
    const [a, b] = makeChain(2);
    expect(a!.seq).toBe(1);
    expect(a!.prev_hash).toBe(GENESIS_HASH);
    expect(b!.prev_hash).toBe(a!.hash);
    expect(receiptHash(a!)).toBe(a!.hash);
    expect(a).not.toHaveProperty("approval");
  });
  it("an intact chain verifies", () => {
    expect(verify(makeChain(5))).toMatchObject({ ok: true, count: 5, firstSeq: 1, lastSeq: 5 });
    expect(verify([])).toMatchObject({ ok: true, count: 0, firstSeq: null, lastSeq: 0 });
  });
});

describe("tamper detection", () => {
  it("names an edited receipt", () => {
    const c = makeChain(5);
    c[2] = { ...c[2]!, args_summary: { amount_inr: 9_99_999 } };
    expect(verify(c)).toEqual({ ok: false, seq: 3, reason: "receipt 3 was changed after it was written" });
  });
  it("catches an edit that recomputes the hash", () => {
    const c = makeChain(5);
    const edited = { ...c[2]!, decision: "refuse" as const };
    c[2] = { ...edited, hash: receiptHash(edited) };
    expect(verify(c)).toMatchObject({ ok: false, seq: 3, reason: expect.stringMatching(/invalid signature/) });
  });
  it("catches a deletion", () => {
    const c = makeChain(5);
    c.splice(1, 1);
    expect(verify(c)).toMatchObject({ ok: false, seq: 2, reason: expect.stringMatching(/missing/) });
  });
  it("catches reordering", () => {
    const c = makeChain(5);
    [c[1], c[2]] = [c[2]!, c[1]!];
    expect(verify(c)).toMatchObject({ ok: false, seq: 2 });
  });
  it("catches a duplicated row", () => {
    const c = makeChain(3);
    c.splice(2, 0, c[1]!);
    expect(verify(c)).toMatchObject({ ok: false, seq: 2, reason: expect.stringMatching(/out of order or duplicated/) });
  });
  it("catches an inserted row signed with another key", () => {
    const c = makeChain(3);
    const fake = buildReceipt({ kind: "admin", action: "x" }, { org: "org1", ts, head: { seq: 1, hash: c[0]!.hash } }, OTHER_KEYS.privateKeyPem);
    const tail = c.slice(1).map((r) => ({ ...r, seq: r.seq + 1 }));
    expect(verify([c[0]!, fake, ...tail])).toMatchObject({ ok: false, seq: 2, reason: expect.stringMatching(/invalid signature/) });
  });
  it("catches a broken link", () => {
    const c = makeChain(3);
    const relinked = { ...c[1]!, prev_hash: GENESIS_HASH };
    c[1] = relinked;
    expect(verify(c)).toMatchObject({ ok: false, seq: 2, reason: expect.stringMatching(/does not link/) });
  });
  it("rejects malformed rows", () => {
    expect(verify([{ seq: 1 }])).toMatchObject({ ok: false, seq: 1, reason: "receipt is malformed" });
    expect(verify(["junk"])).toMatchObject({ ok: false, seq: 1 });
  });
  it("property: any single-field edit is detected at that seq", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 7 }), fc.integer({ min: 1, max: 1e9 }), (n, pick, value) => {
        const c = makeChain(n);
        const i = pick % n;
        c[i] = { ...c[i]!, args_summary: { amount_inr: value === 1000 * (i + 1) ? value + 1 : value } };
        const r = verify(c);
        return !r.ok && r.seq === i + 1;
      }),
      { numRuns: 50 },
    );
  });
  it("property: removing any receipt except the last is detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), fc.integer({ min: 0, max: 6 }), (n, pick) => {
        const c = makeChain(n);
        const i = pick % (n - 1);
        c.splice(i, 1);
        return !verify(c).ok;
      }),
      { numRuns: 50 },
    );
  });
  it("property: swapping two receipts is detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 }), (n, x, y) => {
        const i = x % n;
        const j = y % n;
        fc.pre(i !== j);
        const c = makeChain(n);
        [c[i], c[j]] = [c[j]!, c[i]!];
        return !verify(c).ok;
      }),
      { numRuns: 50 },
    );
  });
});

describe("checkpoints", () => {
  it("are signed and must match the receipt at that seq", () => {
    const c = makeChain(4);
    const cp = signCheckpoint({ org: "org1", seq: 2, hash: c[1]!.hash, ts }, KEYS.privateKeyPem);
    expect(verifyCheckpoint(cp, KEYS.publicKeyPem)).toBe(true);
    expect(verifyChain(c, KEYS.publicKeyPem, { checkpoints: [cp] })).toMatchObject({ ok: true, checkpoints: 1 });
    const wrong = signCheckpoint({ org: "org1", seq: 2, hash: c[2]!.hash, ts }, KEYS.privateKeyPem);
    expect(verifyChain(c, KEYS.publicKeyPem, { checkpoints: [wrong] })).toMatchObject({ ok: false, seq: 2 });
    expect(verifyChain(c, KEYS.publicKeyPem, { checkpoints: [{ ...cp, seq: 3 }] })).toMatchObject({ ok: false, seq: 3, reason: expect.stringMatching(/checkpoint/) });
  });
});

describe("evidence bundles", () => {
  const org = { id: "org1", name: "Acme" };
  const make = (receipts: Receipt[], anchor: ChainHead = GENESIS) =>
    buildBundle({
      org,
      range: { from: "2026-10-01", to: "2026-10-31" },
      anchor,
      receipts,
      checkpoints: receipts.length ? [signCheckpoint({ org: "org1", seq: receipts.at(-1)!.seq, hash: receipts.at(-1)!.hash, ts }, KEYS.privateKeyPem)] : [],
      publicKeyPem: KEYS.publicKeyPem,
      privateKeyPem: KEYS.privateKeyPem,
      generatedAt: ts,
    });
  const tamper = (zip: Uint8Array, fn: (f: Record<string, string>) => void) => {
    const files = readBundleFiles(zip);
    fn(files);
    return writeBundleFiles(files);
  };

  it("verifies an intact bundle, including a mid-chain range", () => {
    const all = makeChain(6);
    expect(verifyBundle(make(all))).toMatchObject({ ok: true, count: 6, org: "Acme" });
    const anchor = { seq: all[2]!.seq, hash: all[2]!.hash };
    expect(verifyBundle(make(all.slice(3), anchor))).toMatchObject({ ok: true, count: 3, firstSeq: 4, lastSeq: 6 });
    expect(verifyBundle(make([]))).toMatchObject({ ok: true, count: 0 });
    expect(readBundleFiles(make(all))["README.txt"]).toMatch(/govern verify/);
  });
  it("names the edited row", () => {
    const zip = tamper(make(makeChain(5)), (f) => {
      f["receipts.jsonl"] = f["receipts.jsonl"]!.replace('"amount_inr":4000', '"amount_inr":4000000');
    });
    expect(verifyBundle(zip)).toMatchObject({ ok: false, seq: 4 });
  });
  it("catches a truncated tail", () => {
    const zip = tamper(make(makeChain(5)), (f) => {
      f["receipts.jsonl"] = f["receipts.jsonl"]!.split("\n").slice(0, 3).join("\n");
      f["checkpoints.json"] = "[]";
    });
    expect(verifyBundle(zip)).toMatchObject({ ok: false, seq: 4, reason: expect.stringMatching(/missing/) });
  });
  it("catches manifest and file tampering", () => {
    const base = make(makeChain(2));
    expect(verifyBundle(tamper(base, (f) => (f["manifest.json"] = f["manifest.json"]!.replace('"Acme"', '"Evil"'))))).toMatchObject({ ok: false, reason: "manifest signature is invalid" });
    expect(verifyBundle(tamper(base, (f) => (f["checkpoints.json"] = JSON.stringify(JSON.parse(f["checkpoints.json"]!)))))).toMatchObject({ ok: false, reason: expect.stringMatching(/checkpoints.json does not match/) });
    expect(verifyBundle(tamper(base, (f) => (f["receipts.jsonl"] = f["receipts.jsonl"]! + "\n")))).toMatchObject({ ok: false, reason: expect.stringMatching(/receipts.jsonl does not match/) });
  });
  it("catches a manifest that disagrees with the chain", () => {
    const zip = tamper(make(makeChain(3)), (f) => {
      const m = JSON.parse(f["manifest.json"]!);
      m.last_seq = 2;
      delete m.sig;
      m.sig = "x";
      f["manifest.json"] = JSON.stringify(m);
    });
    expect(verifyBundle(zip)).toMatchObject({ ok: false });
    // Re-signed manifest with a lower last_seq than the chain: mismatch, not missing.
    const files = readBundleFiles(make(makeChain(3)));
    const m = JSON.parse(files["manifest.json"]!);
    delete m.sig;
    m.last_seq = 2;
    m.sig = signText(KEYS.privateKeyPem, hashCanonical(m));
    files["manifest.json"] = JSON.stringify(m);
    expect(verifyBundle(writeBundleFiles(files))).toMatchObject({ ok: false, reason: "receipts do not match the signed manifest" });
  });
  it("rejects broken archives and missing files", () => {
    expect(verifyBundle(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false, reason: expect.stringMatching(/not a readable bundle/) });
    expect(verifyBundle(tamper(make([]), (f) => delete f["public_key.pem"]))).toMatchObject({ ok: false, reason: expect.stringMatching(/missing a file/) });
    expect(verifyBundle(tamper(make([]), (f) => (f["manifest.json"] = "{")))).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid JSON/) });
    expect(verifyBundle(tamper(make([]), (f) => (f["manifest.json"] = "{}")))).toMatchObject({ ok: false, reason: "manifest.json is malformed" });
    expect(verifyBundle(tamper(make([]), (f) => (f["checkpoints.json"] = "{}")))).toMatchObject({ ok: false, reason: "checkpoints.json is malformed" });
    expect(verifyBundle(tamper(make(makeChain(1)), (f) => (f["receipts.jsonl"] = "{bad")))).toMatchObject({ ok: false, seq: 1, reason: expect.stringMatching(/line 1/) });
  });
  it("can pin the expected key", () => {
    expect(verifyBundle(make([]), { expectedPublicKeyPem: KEYS.publicKeyPem }).ok).toBe(true);
    expect(verifyBundle(make([]), { expectedPublicKeyPem: OTHER_KEYS.publicKeyPem })).toMatchObject({ ok: false, reason: expect.stringMatching(/different key/) });
  });
});

describe("auditor packs", () => {
  it("verifies the bundle inside a pack and plain bundles", async () => {
    const { verifyEvidenceFile, PACK_BUNDLE_NAME } = await import("../src/bundle");
    const { zipSync, strToU8 } = await import("fflate");
    const receipts = makeChain(3);
    const bundle = buildBundle({ org: { id: "org1", name: "Acme" }, range: { from: "a", to: "b" }, anchor: GENESIS, receipts, checkpoints: [], publicKeyPem: KEYS.publicKeyPem, privateKeyPem: KEYS.privateKeyPem, generatedAt: ts });
    const pack = zipSync({ [PACK_BUNDLE_NAME]: bundle, "summary.pdf": strToU8("%PDF") });
    expect(verifyEvidenceFile(pack)).toMatchObject({ ok: true, count: 3 });
    expect(verifyEvidenceFile(bundle)).toMatchObject({ ok: true, count: 3 });
    expect(verifyEvidenceFile(new Uint8Array([9, 9]))).toMatchObject({ ok: false });
  });
});
