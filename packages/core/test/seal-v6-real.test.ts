import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";
import { fromConsoleCheckpoint, publicKeyHex } from "../src/console-receipt";
import { hashCanonical, keyFingerprint, signText as chainSign } from "../src/crypto";
import "../src/index";
import { verifyChain as verifyChainL1 } from "../src/receipt";
import {
  bundle6ToZip, chainKeyFingerprint, checkpointMessage, contentOk, fingerprintOf, keyFingerprintOf, readEvidenceFile6, receiptHash, reportSections, setSealCrypto, verifyBundle6,
  verifyChain, verifyDisclosure, verifySig, writeIdFor, type BundleManifest, type SealCrypto,
} from "../src/seal";
import { nodeSealCrypto } from "../src/seal/node";
import { buildRealBundle, chainKey, realChain, realCases, realReceipts, REAL_ORG, type TsaFixture } from "./seal-v6-real-builder";

// The artefacts the server produces (receipts from the organisation's real chain, gate-made seals, real RFC 3161
// tokens), and what the approved console's own verifier said about each case (scripts/gen-rfc3161-fixture.mts): core's
// verifyBundle6 must agree with it byte for byte, as it does on the demo bundles in seal-v6.test.ts.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/seal-v6-real/${name}`, import.meta.url), "utf8"));
const tsa = fixture("tsa.json") as TsaFixture;
const consoleResults = fixture("console-results.json") as Record<string, { inputDigest: string; summary: Record<string, unknown>; resultDigest: string; reportDigest: string }>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const key = chainKey();

describe("the real chain's receipts and checkpoints in the six-code verifier", () => {
  it("are the chain's own: core's L1 verifier accepts them with the organisation's PEM", () => {
    const chain = realChain();
    expect(verifyChainL1(chain, key.publicKeyPem)).toMatchObject({ ok: true, count: chain.length });
    expect(chain.every((r) => r.hash.startsWith("sha256:") && r.sig.startsWith("ed25519:") && r.kid === key.kid)).toBe(true);
  });

  it("recompute each console-form receipt's hash with core's preimage, and fail one that changed", () => {
    const receipts = realReceipts();
    for (const r of receipts) expect(receiptHash(r)).toBe(r.hash);
    // the console's own fields travel in details: the console form has them back
    expect(receipts[3]!.approval).toEqual({ id: "apr_7", status: "approved", approver: "u_meera", channel: "web" });
    expect(receipts[4]!.outcome).toEqual({ status: "ok", ref: "PAY-7", ms: 120 });
    expect(receipts[7]!.environment).toBe("sandbox");
    expect(receiptHash({ ...receipts[1]!, reason: "edited" })).not.toBe(receipts[1]!.hash);
    // a field the chain has no place for cannot be recomputed at all
    expect(receiptHash({ ...receipts[1]!, unknown: 1 } as never)).toBe("");
    expect(contentOk({ ...receipts[1]!, unknown: 1 } as never, { [key.kid]: key.publicKeyHex })).toBe(false);
  });

  it("verify as a chain, with the kid as the key's fingerprint and chain-format checkpoints", () => {
    const { bundle } = buildRealBundle(tsa);
    const r = verifyChain(bundle.receipts, bundle.public_keys, bundle.checkpoints);
    expect(r).toMatchObject({ result: "verified", receipts: 8, checkpoints: { total: 2, valid: 2 }, keyFingerprint: key.kid });
    const cp = bundle.checkpoints[0]!;
    const { sig: _s, ...unsigned } = fromConsoleCheckpoint(cp);
    expect(checkpointMessage(cp)).toBe(hashCanonical(unsigned));
    expect(verifyChain(bundle.receipts, bundle.public_keys, [{ ...cp, seq: cp.seq + 1 }]).checkpoints.valid).toBe(0);
  });

  it("accept `ed25519:<base64>` signatures over the same text, and nothing malformed", () => {
    const sig = chainSign(key.privateKeyPem, "the message");
    expect(verifySig("the message", sig, key.publicKeyHex)).toBe(true);
    expect(verifySig("another message", sig, key.publicKeyHex)).toBe(false);
    for (const bad of ["ed25519:", "ed25519:!!", `ed25519:${Buffer.alloc(63).toString("base64")}`, sig.slice(0, -4)]) expect(verifySig("the message", bad, key.publicKeyHex)).toBe(false);
    expect(verifySig("the message", Buffer.from(sig.slice(8), "base64").toString("hex"), key.publicKeyHex)).toBe(true);
  });
});

describe("the node:crypto provider's other hashes", () => {
  it("are SHA-384, SHA-512 and SHA-1", () => {
    const data = new TextEncoder().encode("timestamp");
    for (const name of ["sha384", "sha512", "sha1"] as const) expect(Buffer.from(nodeSealCrypto[name]!(data)).toString("hex")).toBe(createHash(name).update(data).digest("hex"));
  });
});

describe("key fingerprints", () => {
  it("are core's keyFingerprint of the PEM for a chain key, rebuilt from the raw key", () => {
    for (let i = 0; i < 40; i++) {
      const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
      const raw = publicKeyHex(pem);
      expect(chainKeyFingerprint(raw)).toBe(keyFingerprint(pem));
      expect(chainKeyFingerprint(raw.toUpperCase())).toBe(keyFingerprint(pem));
      expect(keyFingerprintOf(keyFingerprint(pem), raw)).toBe(keyFingerprint(pem));
    }
  });

  it("stay the demo's for any other kid", () => {
    expect(keyFingerprintOf("k_org_1", key.publicKeyHex)).toBe(fingerprintOf(key.publicKeyHex));
    expect(keyFingerprintOf("0123456789abcdef", key.publicKeyHex)).toBe(fingerprintOf(key.publicKeyHex));
    expect(keyFingerprintOf(undefined, key.publicKeyHex)).toBe(fingerprintOf(key.publicKeyHex));
    expect(keyFingerprintOf(key.kid, "not a key")).toBe(fingerprintOf("not a key"));
    expect(keyFingerprintOf(key.kid.toUpperCase(), key.publicKeyHex)).toBe(fingerprintOf(key.publicKeyHex));
  });

  it("pin a disclosure package signed with a chain key by its kid", () => {
    const p = buildRealBundle(tsa).bundle.disclosures![0]!;
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(verifyDisclosure(p, { pinnedFingerprint: key.kid, now }).valid).toBe(true);
    expect(verifyDisclosure(p, { pinnedFingerprint: fingerprintOf(key.publicKeyHex), now }).valid).toBe(false);
    expect(verifyDisclosure({ ...p, seq: p.seq + 1 }, { now }).valid).toBe(false);
  });
});

describe("verifyBundle6 on real-format bundles, against the console's verifier", () => {
  const cases = realCases(tsa);

  it("has a frozen console result for every case and no stale ones", () => {
    expect(new Set(cases.map((c) => c.name))).toEqual(new Set(Object.keys(consoleResults)));
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const want = consoleResults[c.name]!;
    const input = JSON.stringify(c.input);
    expect(sha(input), `the input for ${c.name} changed since the fixtures were made`).toBe(want.inputDigest);
    const r = verifyBundle6(JSON.parse(input), c.opts);
    expect(r.code).toBe(c.code);
    expect({ code: r.code, exitCode: r.exitCode, headline: r.headline, variants: r.variants, sections: r.sections.map((x) => `${x.id}:${x.state}: ${x.detail}`), notes: r.notes }).toEqual(want.summary);
    const { ms: _ms, chain, ...rest } = r;
    const stripped = chain ? { ...rest, chain: (({ ms: _c, ...x }) => x)(chain) } : rest;
    expect(sha(canonicalize(JSON.parse(JSON.stringify(stripped)))), `${c.name}: result differs from the console's`).toBe(want.resultDigest);
    const report = reportSections(r, c.input.manifest as BundleManifest, {}).map((s) => ({ ...s, lines: s.lines.filter((l) => l.label !== "Time taken") }));
    expect(sha(canonicalize(JSON.parse(JSON.stringify(report)))), `${c.name}: report differs from the console's`).toBe(want.reportDigest);
  });

  it("passes the real bundle pinned to the kid, reporting it as the fingerprint", () => {
    const { bundle } = buildRealBundle(tsa);
    const r = verifyBundle6(clone(bundle), { expectedFingerprint: key.kid });
    expect(r).toMatchObject({ code: "PASS", exitCode: 0, fingerprint: key.kid, keySource: "supplied", counts: { receipts: 8, seals: 6, batches: 2, tokens: 4, checkpoints: 2, disclosures: 1, unanchored: 0 } });
    expect(r.sections.every((s) => s.state === "pass" || s.state === "not_applicable")).toBe(true);
    expect(r.sections.find((s) => s.id === "anchors")!.detail).toBe("2 Merkle batches recompute; 4 RFC 3161 timestamp tokens from 2 authorities verify.");
    expect(verifyBundle6(clone(bundle), { expectedFingerprint: key.kid.toUpperCase() }).code).toBe("PASS");
    expect(verifyBundle6(clone(bundle)).code).toBe("PASS_KEY_FROM_BUNDLE");
    // the same bundle as a ZIP of its members
    expect(verifyBundle6(readEvidenceFile6(bundle6ToZip(bundle)), { expectedFingerprint: key.kid }).code).toBe("PASS");
  });

  it("seals over chain receipts: F03 starts from a prefixed receipt hash, F04 binds the prefixed hash", () => {
    const { bundle } = buildRealBundle(tsa);
    const first = bundle.seals![0]!;
    const before = bundle.receipts.find((r) => r.seq === first.seq - 1)!;
    expect(first.fields[2]!.value).toBe(before.hash);
    expect(before.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const s of bundle.seals!) {
      const r = bundle.receipts.find((x) => x.seq === s.seq)!;
      expect(s.fields[3]!.value).toBe(writeIdFor(REAL_ORG, r.seq, r.hash));
      expect(s.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(s.kid).toBe(key.kid);
    }
  });

  it("names the token that failed and why", () => {
    const failing = (name: string) => verifyBundle6(clone(cases.find((c) => c.name === name)!.input), { expectedFingerprint: key.kid }).sections.find((s) => s.id === "anchors")!.firstFailure?.found;
    expect(failing("real: a byte of a token's DER flipped")).toBe("the token's signature does not verify");
    expect(failing("real: the authorities' certificates swapped")).toBe("the token is signed by another certificate than the authority's");
    expect(failing("real: an authority without its certificate")).toBe("the authority's certificate could not be read");
    expect(failing("real: a token's stored serial changed")).toBe("the token's stored fields do not match its contents");
    expect(failing("real: a real token stripped of its DER")).toBe("signature or imprint mismatch");
  });

  it("checks hosted tokens with the hashes the crypto provider has, and the gate's own with SHA-256 alone", () => {
    const minimal: SealCrypto = { sha256: nodeSealCrypto.sha256, ed25519PublicKey: nodeSealCrypto.ed25519PublicKey, ed25519Sign: nodeSealCrypto.ed25519Sign, ed25519Verify: nodeSealCrypto.ed25519Verify };
    const prev = setSealCrypto(minimal);
    try {
      expect(verifyBundle6(clone(buildRealBundle(tsa).bundle), { expectedFingerprint: key.kid }).code).toBe("PASS");
      // OpenSSL's B signs over SHA-512 and names its certificate by SHA-1
      const hosted = verifyBundle6(clone(buildRealBundle(tsa, { authorities: ["openssl-rsa-a", "openssl-rsa-b"] }).bundle), { expectedFingerprint: key.kid });
      expect(hosted.code).toBe("FAIL_INTEGRITY");
      expect(hosted.sections.find((s) => s.id === "anchors")!.firstFailure?.found).toBe("the token uses an unsupported digest");
    } finally {
      setSealCrypto(prev);
    }
  });
});
