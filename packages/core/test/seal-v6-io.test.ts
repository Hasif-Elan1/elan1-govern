import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { GENESIS, buildBundle, buildReceipt, generateKeyPair, type Receipt as L1Receipt } from "../src/index";
import {
  PROFILES, bundle6ToZip, bytesToHex, concatBytes, dispositionProblems, detectBundleProfile, disclosureDigest, commitFields, fieldValuesOf, hexToBytes, isZip,
  keyFromSeed, keyFromSeedBytes, payloadOf, profileCheckedValue, randomHex, randomSalt, readBundleText, readEvidenceFile6, readEvidenceZip,
  recordIdOf, sealCrypto, sealCryptoInstalled, sealedRecordId, setProfileWithdrawalLookup, setSealCrypto, actorOf, utf8ToBytes, verifyBundle6, verifyBytes,
  verifySig, withProfileWithdrawals, writeTypeOf, writeTypesLine, verifyChain, signReceipt, signRedaction, verifyDisclosure, levelRank, atLeast,
  type EvidenceBundle, type LevelId, type Receipt,
} from "../src/seal";
import { nodeSealCrypto } from "../src/seal/node";
import { buildAuditorPack6, buildBundle6, orgKey } from "./seal-v6-builder";

const W = { withdrawals: {} };
const FP = { ...W, expectedFingerprint: orgKey().fingerprint };

describe("the crypto provider", () => {
  it("is installed by the Node entry point and can be replaced", () => {
    expect(sealCryptoInstalled()).toBe(true);
    expect(sealCrypto()).toBe(nodeSealCrypto);
    const bundle = buildBundle6({ count: 8 }).bundle;
    const prev = setSealCrypto(undefined);
    try {
      expect(sealCryptoInstalled()).toBe(false);
      expect(() => sealCrypto()).toThrow(/setSealCrypto/);
      // a bundle cannot be checked without one, and the verifier says so rather than throwing
      const r = verifyBundle6(bundle, W);
      expect(r.code).toBe("USAGE");
      expect(r.sections[0]!.detail).toMatch(/crypto provider/);
    } finally {
      setSealCrypto(prev);
    }
    expect(sealCrypto()).toBe(nodeSealCrypto);
  });

  it("verifies Ed25519 strictly and never throws on malformed input", () => {
    const k = keyFromSeed("t", "k");
    const msg = utf8ToBytes("hello");
    const sig = nodeSealCrypto.ed25519Sign(msg, k.privateKey);
    const pub = hexToBytes(k.publicKeyHex);
    expect(nodeSealCrypto.ed25519Verify(sig, msg, pub)).toBe(true);
    expect(nodeSealCrypto.ed25519Verify(sig.slice(0, 63), msg, pub)).toBe(false);
    expect(nodeSealCrypto.ed25519Verify(sig, msg, pub.slice(0, 31))).toBe(false);
    // 32 bytes that are not a point on the curve
    expect(nodeSealCrypto.ed25519Verify(sig, msg, new Uint8Array(32).fill(0xff))).toBe(false);
    expect(() => nodeSealCrypto.ed25519PublicKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(verifyBytes(msg, "zz", k.publicKeyHex)).toBe(false);
    expect(verifySig(42 as unknown as string, bytesToHex(sig), k.publicKeyHex)).toBe(false);
    expect(keyFromSeedBytes(k.privateKey, "k2").publicKeyHex).toBe(k.publicKeyHex);
    // many keys: the parsed-key cache is bounded
    for (let i = 0; i < 300; i++) expect(verifyBytes(msg, bytesToHex(sig), keyFromSeed(`k${i}`, "x").publicKeyHex)).toBe(false);
  });

  it("parses hex and text strictly", () => {
    expect(bytesToHex(hexToBytes("00aBff"))).toBe("00abff");
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
    expect(() => hexToBytes(7 as unknown as string)).toThrow();
    expect(() => utf8ToBytes(undefined as unknown as string)).toThrow();
    expect(bytesToHex(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3])))).toBe("010203");
  });

  it("draws salts from the secure random source only", () => {
    expect(randomHex()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSalt()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(4)).toHaveLength(8);
    const g = globalThis as { crypto?: unknown };
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(() => randomHex()).toThrow(/secure random/);
    } finally {
      if (saved) Object.defineProperty(globalThis, "crypto", saved);
    }
    expect(g.crypto).toBeDefined();
  });
});

describe("seal fields from receipts", () => {
  const base = { seq: 7, ts: "2026-10-27T05:30:00.000Z", org: "o", prev_hash: "00", kid: "k", hash: "aa", sig: "bb" };
  it("names the write type, the actor and the business record", () => {
    expect(writeTypeOf({ ...base, kind: "approval", tool: "t" })).toBe("t#approval");
    expect(writeTypeOf({ ...base, kind: "approval" })).toBe("approval#approval");
    expect(writeTypeOf({ ...base, kind: "outcome" })).toBe("outcome#outcome");
    expect(writeTypeOf({ ...base, kind: "admin", action: "key.rotated" })).toBe("key.rotated");
    expect(writeTypeOf({ ...base, kind: "admin" })).toBe("admin");
    expect(actorOf({ ...base, kind: "decision" })).toEqual({ id: "unknown-agent", kind: "agent" });
    expect(actorOf({ ...base, kind: "admin" })).toEqual({ id: "system", kind: "system" });
    expect(actorOf({ ...base, kind: "admin", actor: "u_1" })).toEqual({ id: "u_1", kind: "human" });
    expect(recordIdOf({ ...base, kind: "decision", args_summary: { claim: "C-1" } })).toBe("claim:C-1");
    expect(recordIdOf({ ...base, kind: "approval", approval: { id: "apr_1", status: "approved" } })).toBe("approval:apr_1");
    expect(recordIdOf({ ...base, kind: "admin", details: { rulebook: "rb" } })).toBe("rulebook:rb");
    expect(recordIdOf({ ...base, kind: "admin", ref_seq: 3 })).toBe("seq:3");
    expect(recordIdOf({ ...base, kind: "admin" })).toBe("seq:7");
    const personal: Receipt = { ...base, kind: "decision", args_summary: { to_domain: "example.in" } };
    expect(sealedRecordId(personal, "00".repeat(16))).toMatch(/^to_domain:#[0-9a-f]{16}$/);
    expect(sealedRecordId(personal, undefined)).toBe("to_domain:#unlinked");
    expect(payloadOf({ ...base, kind: "decision" })).toEqual({ args_summary: null, details: null, decision: null, reason: null, outcome: null, approval: null });
  });
});

describe("profiles and disclosure helpers", () => {
  it("checks dispositions: not measured needs reasons, out of scope needs a decision record", () => {
    expect(PROFILES.flatMap((p) => dispositionProblems(p))).toEqual([]);
    expect(dispositionProblems({ rules: [{ id: "C1", kind: "coverage", clause: "x", text: "x", disposition: "not_measurable", reason: "short" }, { id: "C2", kind: "binding", clause: "x", text: "x", disposition: "out_of_scope", adr: "ADR-1" }] })).toHaveLength(2);
  });

  it("commits disclosure fields with fresh salts", () => {
    const r: Receipt = { seq: 1, ts: "t", org: "o", kind: "decision", decision: "ask", prev_hash: "0", kid: "k", hash: "h".repeat(64), sig: "s", rulebook: { version: 2, hash: "ab".repeat(32) }, approval: { id: "a", status: "approved", approver: "u", channel: "web" }, outcome: { status: "ok", ref: "R1" }, args_summary: { amount: 5 } };
    const result: Receipt = { ...r, seq: 2, kind: "approval", decision: "allow" };
    const values = fieldValuesOf(r, result);
    expect(values).toMatchObject({ decision: "ask → allow", rulebook_version: `v2 · ${"ab".repeat(8)}`, approval: "approved by u via web", outcome: "ok · R1", amount: "5" });
    expect(fieldValuesOf({ ...r, approval: undefined, outcome: undefined, rulebook: undefined, args_summary: undefined, decision: undefined, agent: undefined, actor: "u_2", tool: undefined, action: "x" })).toMatchObject({ approval: "none", outcome: "not reported", amount: "", agent: "u_2", tool: "x", decision: "" });
    const { committed, salts } = commitFields(values);
    expect(committed.map((c) => c.name)).toEqual(Object.keys(values).sort());
    expect(committed[0]!.digest).toBe(disclosureDigest(salts[committed[0]!.name]!, committed[0]!.name, values[committed[0]!.name as keyof typeof values]));
  });

  it("reports what the reader chose to check, and the write types", () => {
    expect(profileCheckedValue("none")).toBe("none (integrity only)");
    expect(profileCheckedValue("in-dpdp")).toBe("in-dpdp");
    expect(writeTypesLine({}).value).toMatch(/^none/);
  });

  it("reads an organisation's withdrawn profiles through the lookup the console sets", () => {
    const b = buildBundle6({ profileId: "in-mca-audit-trail", count: 10 }).bundle;
    expect(withProfileWithdrawals(b, {})).toEqual({});
    setProfileWithdrawalLookup((org) => (org === "org_fixture" ? { "in-mca-audit-trail": { at: "2026-10-26T00:00:00.000Z" } } : undefined));
    try {
      expect(withProfileWithdrawals(b, {}).withdrawals).toEqual({ "in-mca-audit-trail": { at: "2026-10-26T00:00:00.000Z" } });
      expect(verifyBundle6(b, { expectedFingerprint: orgKey().fingerprint }).profile?.withdrawnAt).toBe("2026-10-26T00:00:00.000Z");
      expect(withProfileWithdrawals({ manifest: { tenant_id: "org_fixture" } }, {}).withdrawals).toBeDefined();
      expect(withProfileWithdrawals({ manifest: { org_id: "other" } }, {})).toEqual({});
      expect(withProfileWithdrawals({ manifest: {} }, {})).toEqual({});
      expect(withProfileWithdrawals(null, {})).toEqual({});
      setProfileWithdrawalLookup(() => { throw new Error("no state"); });
      expect(withProfileWithdrawals(b, {})).toEqual({});
    } finally {
      setProfileWithdrawalLookup(() => undefined);
    }
  });
});

/** Core's own L1 bundle, as the existing tests build it. */
function l1Bundle(): Uint8Array {
  const keys = generateKeyPair();
  const r: L1Receipt = buildReceipt({ kind: "decision", tool: "gmail.search", decision: "allow" }, { org: "o", ts: "2026-10-26T00:00:00Z", head: GENESIS }, keys.privateKeyPem);
  return buildBundle({ org: { id: "o", name: "Acme" }, range: { from: "2026-10-26", to: "2026-10-26" }, anchor: GENESIS, receipts: [r], checkpoints: [], publicKeyPem: keys.publicKeyPem, privateKeyPem: keys.privateKeyPem, generatedAt: "2026-10-26T00:00:00Z" });
}
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const text = (s: string) => strToU8(s);

describe("bundle files and profile detection", () => {
  it("tells core's L1 bundles from Seal v6 bundles", () => {
    const l1 = l1Bundle();
    expect(detectBundleProfile(l1)).toBe("l1");
    expect(detectBundleProfile(zip({ "evidence-bundle.zip": "x" }))).toBe("l1");
    expect(detectBundleProfile(zip({ "README.txt": "no manifest" }))).toBe("l1");
    expect(detectBundleProfile(zip({ "manifest.json": "{not json" }))).toBe("l1");
    expect(detectBundleProfile(zip({ "manifest.json": JSON.stringify({ format: "something/1" }) }))).toBe("l1");
    expect(detectBundleProfile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBe("l1");
    expect(detectBundleProfile(bundle6ToZip(buildBundle6({ count: 8 }).bundle))).toBe("seal-v6");
    expect(detectBundleProfile(bundle6ToZip(buildAuditorPack6({ count: 5 }).bundle))).toBe("seal-v6");
    expect(detectBundleProfile(zip({ "manifest.json": JSON.stringify({ bundle_format: "elan1.evidence.bundle.v9" }) }))).toBe("seal-v6");
    expect(detectBundleProfile(text(JSON.stringify(buildBundle6({ count: 8 }).bundle)))).toBe("seal-v6");
    expect(detectBundleProfile(text("{}"))).toBe("seal-v6");
    expect(detectBundleProfile(text("not a bundle"))).toBe("l1");
    expect(detectBundleProfile(text("   "))).toBe("l1");
    expect(isZip(l1)).toBe(true);
    expect(isZip(new Uint8Array([0x50]))).toBe(false);
  });

  it("reads text: one document, a list of receipts, or receipts as JSON lines", () => {
    const rs = buildBundle6({ count: 3, l1Count: 3, lexicon: "none" }).bundle.receipts;
    expect(readBundleText(JSON.stringify(rs))).toEqual({ manifest: {}, public_keys: {}, receipts: rs, checkpoints: [] });
    expect(readBundleText(rs.map((r) => JSON.stringify(r)).join("\n"))).toEqual({ manifest: {}, public_keys: {}, receipts: rs, checkpoints: [] });
    expect(readBundleText(`${JSON.stringify(rs[0])}\n{"x":1}`)).toBeUndefined();
    expect(readBundleText(`${JSON.stringify(rs[0])}\nnot json`)).toBeUndefined();
    expect(readBundleText(JSON.stringify({ receipts: rs, manifest: [], public_keys: 1 }))).toEqual({ receipts: rs, manifest: {}, public_keys: {}, checkpoints: [] });
    expect(readBundleText("[1,2]")).toEqual([1, 2]);
    expect(() => readEvidenceFile6(text("nope"))).toThrow(/not valid JSON or a ZIP/);
  });

  it("round-trips an L2 bundle and an auditor pack through a ZIP of members, with the same verdict", () => {
    const cases: [EvidenceBundle, string][] = [
      [buildBundle6({ count: 12, disclosures: [7] }).bundle, "PASS"],
      [buildBundle6({ count: 12, lexicon: "none" }).bundle, "PASS"],
      [buildAuditorPack6({ count: 6 }).bundle, "PASS_L1_INTERNAL"],
    ];
    for (const [b, code] of cases) {
      const fromZip = readEvidenceFile6(bundle6ToZip(b));
      const opts = { ...FP, now: Date.parse("2026-11-01T00:00:00Z") };
      expect(verifyBundle6(fromZip, opts).code).toBe(code);
      expect(verifyBundle6(readEvidenceFile6(text(JSON.stringify(b))), opts).code).toBe(code);
    }
  });

  it("reads a ZIP whose members sit in one folder, an unsealed pack's manifest, and a ZIP holding one JSON file", () => {
    const b = buildBundle6({ count: 6, lexicon: "none" }).bundle;
    const inner = readEvidenceZip(bundle6ToZip(b)) as EvidenceBundle;
    const foldered = zip(Object.fromEntries(Object.entries({
      "manifest.json": JSON.stringify({ manifest: b.manifest, manifest_sig: b.manifest_sig }),
      "receipts.jsonl": b.receipts.map((r) => JSON.stringify(r)).join("\n"),
      "keys.json": JSON.stringify(b.public_keys),
      "profile/VERIFY.txt": b.readme ?? "",
    }).map(([k, v]) => [`bundle/${k}`, v])));
    const read = readEvidenceZip(foldered) as EvidenceBundle;
    expect(read.receipts).toEqual(inner.receipts);
    expect(read.readme).toBe(b.readme);
    expect(read.checkpoints).toEqual([]);
    const pack = buildAuditorPack6({ style: "unsealed-old", count: 4 }).bundle;
    const p = readEvidenceZip(bundle6ToZip(pack)) as EvidenceBundle;
    expect(p.manifest_seal).toBeUndefined();
    expect(p.manifest.format).toBe("auditor-pack/1");
    expect(readEvidenceZip(zip({ "bundle.json": JSON.stringify(b) }))).toMatchObject({ receipts: b.receipts });
    expect(() => readEvidenceZip(zip({ "notes.txt": "x" }))).toThrow(/no manifest\.json/);
    expect(readEvidenceZip(zip({ "manifest.json": JSON.stringify({ format: "auditor-pack/1", manifest_seal: "ab" }), "receipts.json": "[]" }))).toMatchObject({ manifest: { format: "auditor-pack/1" }, manifest_seal: "ab", receipts: [] });
  });
});

describe("the console receipt chain and disclosure checks", () => {
  it("catches a retired key, a broken start link, a missing field and a changed erasure", () => {
    const built = buildBundle6({ count: 6, l1Count: 6, lexicon: "none", rotateAt: 2 });
    const { receipts, public_keys } = built.bundle;
    expect(verifyChain(receipts, public_keys).result).toBe("verified");
    expect(verifyChain([], public_keys)).toMatchObject({ result: "cannot_verify", exitCode: 2 });
    expect(verifyChain(receipts, public_keys, [], { expectedPrev: "11".repeat(32) })).toMatchObject({ brokenAt: receipts[0]!.seq, brokenReason: expect.stringMatching(/link/) });
    // the old key signing after the key.rotated receipt that retired it
    const late = signReceipt({ ...receipts[4]!, kid: built.keys.org.kid } as Omit<Receipt, "hash" | "sig">, built.keys.org);
    const relinked = signReceipt({ ...receipts[5]!, prev_hash: late.hash } as Omit<Receipt, "hash" | "sig">, built.keys.next);
    const r1 = verifyChain([...receipts.slice(0, 4), late, relinked], public_keys);
    expect(r1).toMatchObject({ brokenAt: late.seq, brokenReason: expect.stringMatching(/retired/) });
    expect(r1.summary.find((s) => s.label === "Key valid when signed")!.detail).toMatch(/after the key\.rotated/);
    const windowed = verifyChain(receipts, public_keys, [], { keyWindows: { [built.keys.next.kid]: { retiredAt: "2026-10-20T03:00:00.000Z" }, other: {} } });
    expect(windowed.brokenReason).toMatch(/retired/);
    expect(verifyChain(receipts, { [built.keys.org.kid]: public_keys[built.keys.org.kid]! }).brokenReason).toMatch(/not in the bundle/);
    const noTs = { ...receipts[0]!, ts: undefined } as unknown as Receipt;
    expect(verifyChain([noTs], public_keys).brokenReason).toMatch(/content does not match/);
    const noTsSigned = signReceipt({ ...receipts[0]!, ts: null } as unknown as Omit<Receipt, "hash" | "sig">, built.keys.org);
    expect(verifyChain([noTsSigned], public_keys).brokenReason).toBe("A required field is missing.");
    const erased = signRedaction({ ...receipts[0]!, redacted: { fields: ["args_summary"], reason: "erasure" } }, built.keys.org);
    expect(verifyChain([erased], public_keys).summary.find((s) => s.label === "Content hash")!.detail).toMatch(/1 receipt has fields removed/);
    expect(verifyChain([{ ...erased, decision: "refuse" }], public_keys).brokenReason).toMatch(/erased receipt/);
    expect(verifyChain([{ ...erased, redacted: { ...erased.redacted!, kid: undefined } }], public_keys).checks[0]!.hash).toBe("fail");
    const sigBad = { ...receipts[0]!, sig: "00".repeat(64) };
    expect(verifyChain([sigBad], public_keys).brokenReason).toMatch(/signature does not verify/);
  });

  it("checks a disclosure package's audience, expiry, pinned key and signature", () => {
    const pkg = (buildBundle6({ count: 10, disclosures: [8] }).bundle.disclosures ?? [])[0]!;
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(verifyDisclosure(pkg, { now }).valid).toBe(true);
    expect(verifyDisclosure(pkg).steps.length).toBe(5);
    const pinned = verifyDisclosure(pkg, { now, pinnedFingerprint: orgKey().fingerprint, audience: "ar-org:auditor" });
    expect(pinned.steps.map((s) => s.state)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    const wrong = verifyDisclosure({ ...pkg, sig: "00".repeat(64), revealed: [{ ...pkg.revealed[0]!, value: "x" }, { ...pkg.revealed[1]!, value: "y" }] }, { now, pinnedFingerprint: "0".repeat(16), audience: "ar-org:other" });
    expect(wrong.valid).toBe(false);
    expect(wrong.steps.map((s) => s.state)).toEqual(["fail", "pass", "fail", "fail", "fail"]);
    expect(wrong.steps[4]!.detail).toMatch(/2 revealed fields/);
  });

  it("ranks an unknown level as L1", () => {
    expect(levelRank(undefined)).toBe(0);
    expect(levelRank("l9" as LevelId)).toBe(0);
    expect(atLeast("sovereign", "l3")).toBe(true);
  });
});
