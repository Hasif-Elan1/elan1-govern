// Freeze the approved console's Seal v6, Merkle and verifier outputs into test/fixtures/seal-v6/, so core's port is
// tested byte for byte against the console. Run once, from the repository root, while apps/console still has its
// own lib/seal.ts, lib/merkle.ts and lib/verify6.ts:
//
//   node_modules/.bin/tsx --tsconfig apps/console/tsconfig.json packages/core/scripts/gen-seal-v6-fixtures.mts
//
// It reads the console's code (never core's) for every expected value. Core is used only to build the synthetic
// input bundles (test/seal-v6-builder.ts), which the console then verifies.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

(globalThis as Record<string, unknown>).window = globalThis;
const root = new URL("../../../", import.meta.url);
const consoleLib = (p: string) => new URL(`apps/console/src/${p}`, root).href;
const out = new URL("packages/core/test/fixtures/seal-v6/", root);
mkdirSync(out, { recursive: true });

await import(new URL("packages/core/src/seal/node.ts", root).href);
const cases = await import(new URL("packages/core/test/seal-v6-cases.ts", root).href);

const seal = await import(consoleLib("lib/seal.ts"));
const merkle = await import(consoleLib("lib/merkle.ts"));
const crypto6 = await import(consoleLib("lib/crypto.ts"));
const profiles = await import(consoleLib("lib/profiles.ts"));
const v6 = await import(consoleLib("lib/verify6.ts"));
const api = await import(consoleLib("api/index.ts"));
const platform = await import(consoleLib("mock/platform.ts"));
const evidence = await import(consoleLib("mock/evidence.ts"));
const verifyPage = await import(consoleLib("features/verify/bundle.ts"));

const write = (name: string, value: unknown) => {
  const text = JSON.stringify(value) + "\n";
  writeFileSync(new URL(name, out), text);
  console.log(name, `${Math.round(text.length / 1024)} KB`);
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// ── 1. The 64 vectors and the primitives they rest on
{
  const key = crypto6.keyFromSeed("elan1:seal-v6:test-vectors", "k_tv");
  const other = crypto6.keyFromSeed("elan1:seal-v6:test-vectors:other", "k_tv_other");
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  // the console's sampleValues is private: these are the same 12 lists, read back through runTestVectors' digests
  const suite = seal.runTestVectors("2026-10-28T00:00:00.000Z");
  const leaves = Array.from({ length: 17 }, (_, i) => crypto6.sha256Hex(`fixture-leaf-${i}`));
  const trees = Array.from({ length: 18 }, (_, n) => {
    const ls = leaves.slice(0, n);
    return { n, root: merkle.merkleRoot(ls), paths: ls.map((_, i) => merkle.inclusionPath(ls, i)) };
  });
  const payloads = [{}, { a: 1, b: [true, null, "₹ 1,000"] }, { args_summary: { amount: 2500, vendor: "Blue Dart" }, decision: "allow" }, "text", 42, [1, "two", { three: 3 }]];
  const salts = ["00".repeat(16), "0123456789abcdef0123456789abcdef", "ff".repeat(16)];
  const fieldSets = [
    ["org_fx", "1", "0".repeat(64), "w_1", "zoho_books.record_payment", "rulebook:invoice-bot", "7", "a1b2c3d4e5f60718", "invoice-bot", "agent", "A2", "bill:BILL-1", "1", "ab".repeat(32), "cd".repeat(32), "2026-10-27T05:30:00.000Z"],
    Array.from({ length: 16 }, () => ""),
    Array.from({ length: 16 }, (_, i) => "मराठी.भारत ₹ \u{1F600} ".repeat(i + 1)),
  ];
  write("vectors.json", {
    suite,
    key: { publicKeyHex: key.publicKeyHex, fingerprint: key.fingerprint },
    other: { publicKeyHex: other.publicKeyHex, fingerprint: other.fingerprint },
    signatures: suite.vectors.filter((v: { expect: string }) => v.expect === "accept").map((v: { id: string; expected: string }) => ({ id: v.id, digest: v.expected, sig: seal.signDigest(v.expected, key) })),
    seals: fieldSets.map((values) => ({ values, preimage: hex(seal.sealPreimage(values)), digest: seal.sealDigest(values), alt: seal.sealDigestAlt(values), sig: seal.signDigest(seal.sealDigest(values), key) })),
    payloadHashes: salts.flatMap((salt) => payloads.map((payload) => ({ salt, payload, hash: seal.payloadHash(salt, payload) }))),
    salts: [0, 1, 999, 9007199254740991].map((seq) => ({ secret: "ab".repeat(16), seq, salt: seal.deriveSalt("ab".repeat(16), seq) })),
    writeIds: [["org_a", 1, "00".repeat(32)], ["org_b", 42, "ff".repeat(32)]].map(([o, s, h]) => ({ org: o, seq: s, hash: h, id: seal.writeIdFor(o, s, h) })),
    merkle: { leaves, trees, leafHash: merkle.leafHash(leaves[0]), nodeHash: merkle.nodeHash(leaves[0], leaves[1]) },
    textSigs: ["", "abc", crypto6.sha256Hex("x")].map((m) => ({ message: m, sig: crypto6.signText(m, key) })),
    profiles: profiles.PROFILES.map((p: { id: string; digest: string }) => ({ id: p.id, digest: p.digest })),
    verifierDigest: crypto6.sha256Hex(v6.VERIFIER_VERSION),
  });
}

// ── 2. Bundles the console's export code builds (ranges of its demo organisations)
const { db } = api;
const build = (orgId: string, from: number, to: number, profileId?: string) =>
  db.readOnlyOpen(() => {
    const d = db.getDB(orgId);
    return d.org.plan === "l1" ? evidence.buildAuditorPack(d, "system", from, to).bundle : platform.buildEvidenceBundle(d, "system", from, to, profileId).bundle;
  });
const fingerprint = (orgId: string) => verifyPage.publishedFingerprint(orgId);
const firstRedacted = (orgId: string) => db.readOnlyOpen(() => db.getDB(orgId).receipts.find((r: { redacted?: unknown; seq: number }) => !!r.redacted)?.seq);
const kvAt = firstRedacted("org_kaveri") ?? 900;
const bases = {
  northbank: { bundle: build("org_northbank", 1206, 1240), fingerprint: fingerprint("org_northbank") },
  northbank_rbi: { bundle: build("org_northbank", 1210, 1235, "in-rbi-collections"), fingerprint: fingerprint("org_northbank") },
  kaveri: { bundle: build("org_kaveri", Math.max(801, kvAt - 8), kvAt + 14), fingerprint: fingerprint("org_kaveri") },
  deccan: { bundle: build("org_deccan", 501, 525), fingerprint: fingerprint("org_deccan") },
  demo: { bundle: build("org_demo", 3001, 3025), fingerprint: fingerprint("org_demo") },
};
write("real-bundles.json", bases);

// ── 3. What the console's verifier says about every case
const strip = (r: Record<string, unknown>) => {
  const { ms: _ms, chain, ...rest } = r;
  void _ms;
  if (chain && typeof chain === "object") {
    const { ms: _c, ...c } = chain as Record<string, unknown>;
    void _c;
    return { ...rest, chain: c };
  }
  return rest;
};
const all = [...cases.syntheticCases(), ...cases.realCases(JSON.parse(JSON.stringify(bases)))];
const results: Record<string, unknown> = {};
for (const c of all) {
  const input = JSON.stringify(c.input) ?? "undefined";
  let result: Record<string, unknown> | { threw: string };
  let report: unknown;
  try {
    const r = v6.verifyBundle(JSON.parse(input === "undefined" ? "null" : input), c.opts);
    const m = c.input && typeof c.input === "object" && !Array.isArray(c.input) && typeof (c.input as { manifest?: unknown }).manifest === "object" ? (c.input as { manifest: unknown }).manifest : {};
    report = v6.reportSections(r, m ?? {}, c.profileChecked ? { profileChecked: c.profileChecked } : {}).map((s: { lines: { label: string }[] }) => ({ ...s, lines: s.lines.filter((l) => l.label !== "Time taken") }));
    result = strip(r);
  } catch (e) {
    result = { threw: (e as Error).message };
  }
  // the whole result and report as digests of their canonical JSON (byte for byte), and a readable summary so a
  // mismatch shows where it is
  const summary = "threw" in result ? result : {
    code: result.code, exitCode: result.exitCode, headline: result.headline, variants: result.variants,
    sections: (result.sections as { id: string; state: string; detail: string }[]).map((x) => `${x.id}:${x.state}: ${x.detail}`), notes: result.notes,
  };
  results[c.name] = { inputDigest: sha(input), summary, resultDigest: sha(crypto6.canonical(result)), reportDigest: sha(crypto6.canonical(report ?? null)) };
}
write("results.json", results);
console.log(`${all.length} cases`);
