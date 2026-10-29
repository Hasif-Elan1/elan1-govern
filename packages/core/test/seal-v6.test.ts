import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";
import * as core from "../src/index";
import {
  PROFILES, VERIFIER_VERSION, deriveSalt, inclusionPath, keyFromSeed, leafHash, merkleRoot, nodeHash, payloadHash, reportSections, rootFromPath, runTestVectors,
  sealDigest, sealDigestAlt, sealPreimage, sha256Hex, signDigest, signText, verifyBundle6, verifyDigestSig, verifyInclusion, verifySig, writeIdFor, type BundleManifest,
} from "../src/seal";
import { realCases, syntheticCases, type Case, type RealBase } from "./seal-v6-cases";

// Frozen once from the approved console's own code (scripts/gen-seal-v6-fixtures.mts): core must match it byte for byte.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/seal-v6/${name}`, import.meta.url), "utf8"));
const vectors = fixture("vectors.json");
const realBases = fixture("real-bundles.json") as Record<string, RealBase>;
const results = fixture("results.json") as Record<string, { inputDigest: string; summary: Record<string, unknown>; resultDigest: string; reportDigest: string }>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const TV_KEY = keyFromSeed("elan1:seal-v6:test-vectors", "k_tv");

describe("Seal v6 test vectors, against the console", () => {
  it("runs all 64 vectors and agrees with the console's run, vector for vector", () => {
    const suite = runTestVectors("2026-10-28T00:00:00.000Z");
    expect(suite).toEqual(vectors.suite);
    expect(suite.summary).toMatchObject({ total: 64, typescript: 64, agree: 64, byGroup: { structure: 12, chain: 12, merkle_anchor: 12, negative: 28 } });
    expect(runTestVectors().implementations[0]!.ranAt).toMatch(/^\d{4}-/);
  });

  it("derives the same vector key and signs every accepted digest with the same bytes", () => {
    expect(TV_KEY.publicKeyHex).toBe(vectors.key.publicKeyHex);
    expect(TV_KEY.fingerprint).toBe(vectors.key.fingerprint);
    expect(keyFromSeed("elan1:seal-v6:test-vectors:other", "o").publicKeyHex).toBe(vectors.other.publicKeyHex);
    expect(vectors.signatures).toHaveLength(36);
    for (const s of vectors.signatures) {
      expect(signDigest(s.digest, TV_KEY)).toBe(s.sig);
      expect(verifyDigestSig(s.digest, s.sig, TV_KEY.publicKeyHex)).toBe(true);
    }
  });

  it("builds the same preimage, digest (both encoders) and signature for fixed field lists", () => {
    for (const s of vectors.seals) {
      expect(hex(sealPreimage(s.values))).toBe(s.preimage);
      expect(sealDigest(s.values)).toBe(s.digest);
      expect(sealDigestAlt(s.values)).toBe(s.alt);
      expect(signDigest(s.digest, TV_KEY)).toBe(s.sig);
    }
  });

  it("hashes salted payloads, derives salts and write ids, and signs text the same way", () => {
    for (const p of vectors.payloadHashes) expect(payloadHash(p.salt, p.payload)).toBe(p.hash);
    for (const s of vectors.salts) expect(deriveSalt(s.secret, s.seq)).toBe(s.salt);
    for (const w of vectors.writeIds) expect(writeIdFor(w.org, w.seq, w.hash)).toBe(w.id);
    for (const t of vectors.textSigs) {
      expect(signText(t.message, TV_KEY)).toBe(t.sig);
      expect(verifySig(t.message, t.sig, TV_KEY.publicKeyHex)).toBe(true);
    }
    expect(sha256Hex(VERIFIER_VERSION)).toBe(vectors.verifierDigest);
  });

  it("gives every verifier profile the console's digest", () => {
    expect(PROFILES.map((p) => ({ id: p.id, digest: p.digest }))).toEqual(vectors.profiles);
  });
});

describe("Merkle batches, against the console", () => {
  it("computes the same root and audit path for every leaf of trees of 0 to 17 leaves", () => {
    const { leaves, trees } = vectors.merkle;
    expect(leafHash(leaves[0])).toBe(vectors.merkle.leafHash);
    expect(nodeHash(leaves[0], leaves[1])).toBe(vectors.merkle.nodeHash);
    for (const t of trees) {
      const ls = leaves.slice(0, t.n);
      expect(merkleRoot(ls)).toBe(t.root);
      ls.forEach((leaf: string, i: number) => {
        expect(inclusionPath(ls, i)).toEqual(t.paths[i]);
        expect(rootFromPath(leaf, t.paths[i])).toBe(t.root);
        expect(verifyInclusion(leaf, t.paths[i], t.root)).toBe(true);
      });
    }
  });

  it("rejects a malformed inclusion path instead of throwing", () => {
    expect(verifyInclusion("zz", [], "00")).toBe(false);
    expect(verifyInclusion(vectors.merkle.leaves[0], [{ hash: "not hex", side: "left" }], "00")).toBe(false);
  });
});

/** Run one case through core's verifier and compare it with what the console said. */
function check(c: Case) {
  const want = results[c.name];
  expect(want, `no frozen result for ${c.name}: regenerate the fixtures`).toBeDefined();
  const input = JSON.stringify(c.input) ?? "undefined";
  expect(sha(input), `the input for ${c.name} changed since the fixtures were made`).toBe(want!.inputDigest);
  const r = verifyBundle6(JSON.parse(input), c.opts);
  if ("threw" in want!.summary) {
    // the console's verifier threw on this input; core answers USAGE instead
    expect(r.code).toBe("USAGE");
    expect(r.exitCode).toBe(5);
    return;
  }
  expect({ code: r.code, exitCode: r.exitCode, headline: r.headline, variants: r.variants, sections: r.sections.map((x) => `${x.id}:${x.state}: ${x.detail}`), notes: r.notes }).toEqual(want!.summary);
  const { ms: _ms, chain, ...rest } = r;
  void _ms;
  const stripped = chain ? { ...rest, chain: (({ ms: _c, ...x }) => x)(chain) } : rest;
  expect(sha(canonicalize(JSON.parse(JSON.stringify(stripped)))), `${c.name}: result differs from the console's`).toBe(want!.resultDigest);
  const isObj = c.input && typeof c.input === "object" && !Array.isArray(c.input);
  const m = (isObj && typeof (c.input as { manifest?: unknown }).manifest === "object" ? (c.input as { manifest: BundleManifest }).manifest : {}) ?? {};
  const report = reportSections(r, m, c.profileChecked ? { profileChecked: c.profileChecked } : {}).map((s) => ({ ...s, lines: s.lines.filter((l) => l.label !== "Time taken") }));
  expect(sha(canonicalize(JSON.parse(JSON.stringify(report)))), `${c.name}: report differs from the console's`).toBe(want!.reportDigest);
}

describe("verifyBundle6, against the console's verifier", () => {
  const synthetic = syntheticCases();
  const real = realCases(realBases);

  it("has a frozen result for every case and no stale ones", () => {
    expect(new Set([...synthetic, ...real].map((c) => c.name))).toEqual(new Set(Object.keys(results)));
  });

  it.each(synthetic.map((c) => [c.name, c] as const))("synthetic bundle: %s", (_name, c) => check(c));
  it.each(real.map((c) => [c.name, c] as const))("console-built bundle: %s", (_name, c) => check(c));

  it("covers every result code", () => {
    const codes = new Set(Object.values(results).map((r) => r.summary.code));
    for (const code of ["PASS", "PASS_UNANCHORED_TAIL", "PASS_KEY_FROM_BUNDLE", "PASS_L1_INTERNAL", "PASS_PAYLOAD_UNBOUND", "FAIL_INTEGRITY", "FAIL_PROFILE", "INCOMPLETE", "UNSUPPORTED", "USAGE"]) expect(codes).toContain(code);
  });
});

describe("the core entry point", () => {
  it("exports the seal module whole and its main functions by name", () => {
    expect(core.verifyBundle6).toBe(verifyBundle6);
    expect(core.seal6.verifyBundle6).toBe(verifyBundle6);
    expect(core.seal6.sealDigest).toBe(sealDigest);
    expect(core.SEAL_FORMAT).toBe("elan1.seal.v6");
    // core's L1 verifier is unchanged beside it
    expect(core.verifyBundle).not.toBe(verifyBundle6);
  });
});
