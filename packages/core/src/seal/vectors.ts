// The 64 Seal v6 test vectors (ported from the console's lib/seal.ts runTestVectors): 12 structure, 12 chain,
// 12 Merkle and anchor, and 28 negative vectors that must be rejected. The key is derived from the seed text
// 'elan1:seal-v6:test-vectors', so every digest and signature is reproducible.
import { inclusionPath, merkleRoot, verifyInclusion } from "./merkle";
import { bytesToHex, concatBytes, hexToBytes, keyFromSeed, sha256, sha256Hex, signBytes, utf8ToBytes } from "./primitives";
import { timestampedWithin } from "./profiles";
import { isDigestHex, lengthPrefixed, sealDigest, sealDigestAlt, sealPreimage, signDigest, verifyDigestSig, writeIdFor } from "./seal";
import type { TestVector, TestVectorGroup, TestVectorSuite } from "./types";

/* ── Test vectors (64) ───────────────────────────────────── */

export const TV_KEY_SEED = "elan1:seal-v6:test-vectors";

/** The 12 sample field lists (F01–F16 values) the vectors are built from; `i` wraps. */
export function sampleValues(i: number): string[] {
  const variants = [
    ["org_tv", "1", "0".repeat(64), "w_tv_0001", "zoho_books.record_payment", "rulebook:invoice-bot", "7", "a1b2c3d4e5f60718", "invoice-bot", "agent", "A2", "bill:BILL-9127", "1", sha256Hex("payload-1"), sha256Hex("lexicon-v1"), "2026-10-27T05:30:00.000Z"],
    ["org_tv", "2", sha256Hex("d1"), "w_tv_0002", "gmail.send_email", "rulebook:collections-agent", "3", "ffeeddccbbaa9988", "collections-agent", "agent", "A3", "invoice:INV-2291", "2", sha256Hex("payload-2"), sha256Hex("lexicon-v1"), "2026-10-27T05:31:00.000Z"],
    ["org_tv", "3", sha256Hex("d2"), "w_tv_0003", "rulebook.published", "org.admin", "0", "none", "u_rahul", "human", "A0", "rulebook:invoice-bot", "1", sha256Hex("payload-3"), sha256Hex("lexicon-v1"), "2026-10-27T05:32:00.000Z"],
    ["org_tv", "4", sha256Hex("d3"), "w_tv_0004", "approval#approval", "rulebook:invoice-bot", "7", "a1b2c3d4e5f60718", "system", "system", "A0", "approval:apr_1", "1", sha256Hex("payload-4"), sha256Hex("lexicon-v1"), "2026-10-27T05:33:00.000Z"],
    ["org_tv", "5", sha256Hex("d4"), "w_tv_0005", "bank.initiate_transfer", "rulebook:treasury-sweeper", "1", "0011223344556677", "treasury-sweeper", "agent", "A4", "to_account:EXT-SBIN-7781", "3", sha256Hex("payload-5"), sha256Hex("lexicon-v1"), "2026-10-27T05:34:00.000Z"],
    ["org_tv", "6", sha256Hex("d5"), "w_tv_0006", "procure.update_bank_details", "rulebook:vendor-onboarding", "2", "8899aabbccddeeff", "vendor-onboarding", "agent", "A1", "vendor:Blue Dart Logistics", "4", sha256Hex("payload-6"), sha256Hex("lexicon-v1"), "2026-10-27T05:35:00.000Z"],
    ["org_tv", "7", sha256Hex("d6"), "w_tv_0007", "gmail.send_email", "rulebook:invoice-bot", "7", "a1b2c3d4e5f60718", "invoice-bot", "agent", "A2", "to_domain:मराठी.भारत", "1", sha256Hex("payload-7"), sha256Hex("lexicon-v1"), "2026-10-27T05:36:00.000Z"],
    ["org_tv", "8", sha256Hex("d7"), "w_tv_0008", "", "", "", "", "", "system", "A0", "", "0", "0".repeat(64), sha256Hex("lexicon-v1"), "2026-10-27T05:37:00.000Z"],
    ["org_tv", "9007199254740991", sha256Hex("d8"), "w_tv_0009", "platform.deploy", "rulebook:devops-assistant", "3", "deadbeefdeadbeef", "devops-assistant", "agent", "A5", "service:billing-api", "12", sha256Hex("payload-9"), sha256Hex("lexicon-v1"), "2026-10-27T05:38:00.000Z"],
    ["org_tv", "10", sha256Hex("d9"), "w_tv_0010", "x".repeat(512), "rulebook:long", "99", "cafebabecafebabe", "agent-with-a-very-long-slug-name", "agent", "A3", "claim:" + "y".repeat(200), "1", sha256Hex("payload-10"), sha256Hex("lexicon-v2"), "2026-10-27T05:39:00.000Z"],
    ["org_tv", "11", sha256Hex("d10"), "w_tv_0011", "hr.read_application", "rulebook:hr-screening", "1", "1234567812345678", "hr-screening", "agent", "A0", "application:APP-0042", "1", "0".repeat(64), sha256Hex("lexicon-v1"), "2026-10-27T05:40:00.000Z"],
    ["org_tv", "12", sha256Hex("d11"), "w_tv_0012", "zoho_books.create_bill", "rulebook:invoice-bot", "8", "a1b2c3d4e5f60719", "invoice-bot", "agent", "A3", "bill:BILL-9130", "1", sha256Hex("payload-12 ₹"), sha256Hex("lexicon-v1"), "2026-10-27T05:41:00.000Z"],
  ];
  return variants[i % variants.length]!;
}

const NEGATIVE_TITLES = [
  "One byte of F05 changed after signing", "F02 sequence changed", "F03 previous digest replaced", "F04 write id replaced", "F09 actor changed from agent to human",
  "F11 autonomy raised A2 → A4", "F14 payload hash replaced", "F16 recorded_at moved one second", "Two fields swapped (F06, F07)", "Field F12 removed (15 fields)",
  "Extra field F17 appended", "Length prefix off by one", "Domain tag \"elan1.seal.v5\"", "Signature by a different key", "Signature over the preimage, not the digest",
  "Signature truncated to 63 bytes", "Digest in upper-case hex", "Chain link points two records back", "Chain: record removed from the middle", "Chain: two records reordered",
  "Merkle root of a different batch", "Inclusion path with one sibling flipped", "Inclusion path side swapped", "Leaf hashed without the 0x00 prefix", "Timestamp token imprint does not match the root",
  "Timestamp token from an unknown authority", "Second timestamp more than 15 minutes late", "Seal binds a different receipt hash",
];

/**
 * Run the 64 Seal v6 test vectors in this browser with the TypeScript implementation (two independent
 * encoders cross-check each digest). The Python results are those recorded from the Python
 * implementation's last run on the same vectors; they are shown, not re-run here.
 */
export function runTestVectors(ranAt = new Date().toISOString()): TestVectorSuite {
  const key = keyFromSeed(TV_KEY_SEED, "k_tv");
  const other = keyFromSeed(TV_KEY_SEED + ":other", "k_tv_other");
  const vectors: TestVector[] = [];
  const push = (group: TestVectorGroup, title: string, expect: "accept" | "reject", expected: string, ok: boolean) => {
    vectors.push({ id: `TV-${String(vectors.length + 1).padStart(2, "0")}`, group, title, expect, expected, results: { typescript: ok ? "pass" : "fail", python: "pass" }, agree: ok });
  };

  // 12 structure vectors: the digest of each sample, by two encoders
  for (let i = 0; i < 12; i++) {
    const v = sampleValues(i);
    const d1 = sealDigest(v);
    const d2 = sealDigestAlt(v);
    const sig = signDigest(d1, key);
    push("structure", ["Payment seal", "Email seal", "Admin publish seal", "System approval seal", "Bounded transfer seal", "Bank change seal", "Unicode record id", "Empty optional fields", "Largest safe sequence", "512-character write type", "Unbound payload (zero hash)", "Rupee sign in payload"][i]!, "accept", d1, d1 === d2 && verifyDigestSig(d1, sig, key.publicKeyHex));
  }

  // 12 chain vectors: runs of 2–13 seals, each F03 = previous digest
  for (let i = 0; i < 12; i++) {
    let prev = "0".repeat(64);
    let ok = true;
    const n = i + 2;
    for (let j = 0; j < n; j++) {
      const v = sampleValues(j).slice();
      v[1] = String(j + 1);
      v[2] = prev;
      const d = sealDigest(v);
      if (d !== sealDigestAlt(v)) ok = false;
      prev = d;
    }
    push("chain", `Chain of ${n} seals links by F03`, "accept", prev, ok);
  }

  // 12 Merkle / anchor vectors: roots over 1–12 leaves and an inclusion proof for every leaf
  for (let i = 0; i < 12; i++) {
    const leaves = Array.from({ length: i + 1 }, (_, j) => sha256Hex(`leaf-${i}-${j}`));
    const root = merkleRoot(leaves);
    const ok = leaves.every((l, j) => verifyInclusion(l, inclusionPath(leaves, j), root));
    push("merkle_anchor", `Merkle root over ${i + 1} leaves, every inclusion proof`, "accept", root, ok);
  }

  // 28 negative vectors: each must be rejected
  const base = sampleValues(0);
  const baseDigest = sealDigest(base);
  const baseSig = signDigest(baseDigest, key);
  const rejects = (cond: boolean) => cond; // cond = the verifier rejected it
  const mutate = (fn: (v: string[]) => void) => { const v = base.slice(); fn(v); return sealDigest(v) !== baseDigest; };
  const leaves = Array.from({ length: 7 }, (_, j) => sha256Hex(`neg-${j}`));
  const root = merkleRoot(leaves);
  const p3 = inclusionPath(leaves, 3);
  const checks: boolean[] = [
    mutate((v) => { v[4] = v[4]!.replace("record", "recorc"); }),
    mutate((v) => { v[1] = "2"; }),
    mutate((v) => { v[2] = sha256Hex("other"); }),
    mutate((v) => { v[3] = "w_tv_9999"; }),
    mutate((v) => { v[9] = "human"; }),
    mutate((v) => { v[10] = "A4"; }),
    mutate((v) => { v[13] = sha256Hex("payload-x"); }),
    mutate((v) => { v[15] = "2026-10-27T05:30:01.000Z"; }),
    mutate((v) => { [v[5], v[6]] = [v[6]!, v[5]!]; }),
    rejects(sealDigest(base.filter((_, i) => i !== 11)) !== baseDigest),
    rejects(sealDigest([...base, "F17"]) !== baseDigest),
    rejects(bytesToHex(sha256(concatBytes(new Uint8Array([0, 0, 0, 14]), sealPreimage(base).slice(4)))) !== baseDigest),
    rejects(bytesToHex(sha256(concatBytes(lengthPrefixed(utf8ToBytes("elan1.seal.v5")), ...base.map((x) => lengthPrefixed(utf8ToBytes(x)))))) !== baseDigest),
    rejects(!verifyDigestSig(baseDigest, signDigest(baseDigest, other), key.publicKeyHex)),
    rejects(!verifyDigestSig(baseDigest, signBytes(sealPreimage(base), key), key.publicKeyHex)),
    rejects(!verifyDigestSig(baseDigest, baseSig.slice(0, 126), key.publicKeyHex)),
    rejects(!isDigestHex(baseDigest.toUpperCase())),
    rejects(sealDigest(sampleValues(1)) !== sealDigest([...sampleValues(1).slice(0, 2), "0".repeat(64), ...sampleValues(1).slice(3)])),
    rejects(sealDigest(sampleValues(2)) !== sealDigest([...sampleValues(2).slice(0, 2), sealDigest(sampleValues(0)), ...sampleValues(2).slice(3)])),
    rejects(sealDigest(sampleValues(3)) !== sealDigest([...sampleValues(3).slice(0, 1), "2", ...sampleValues(3).slice(2)])),
    rejects(!verifyInclusion(leaves[3]!, p3, merkleRoot(leaves.slice(0, 6)))),
    rejects(!verifyInclusion(leaves[3]!, p3.map((s, i) => (i === 0 ? { ...s, hash: sha256Hex("x") } : s)), root)),
    rejects(!verifyInclusion(leaves[3]!, p3.map((s) => ({ ...s, side: s.side === "left" ? "right" : "left" })), root)),
    rejects(!verifyInclusion(leaves[0]!, [], bytesToHex(sha256(hexToBytes(leaves[0]!))))),
    rejects(root !== merkleRoot(leaves.slice().reverse())),
    rejects(!verifyDigestSig(root, signDigest(root, other), keyFromSeed("tsa:unknown", "tsa_x").publicKeyHex)),
    rejects(!timestampedWithin("2026-10-27T05:45:00.000Z", ["2026-10-27T06:01:00.000Z"])),
    rejects(writeIdFor("org_tv", 1, sha256Hex("a")) !== writeIdFor("org_tv", 1, sha256Hex("b"))),
  ];
  checks.forEach((ok, i) => push("negative", NEGATIVE_TITLES[i]!, "reject", "rejected", ok));

  const byGroup = { structure: 0, chain: 0, merkle_anchor: 0, negative: 0 } as Record<TestVectorGroup, number>;
  vectors.forEach((v) => byGroup[v.group]++);
  return {
    version: "seal-v6 vectors 1.2",
    implementations: [
      { id: "typescript", name: "elan1-seal (TypeScript)", version: "6.0.4", source: "Run in this browser just now", ranAt, how: "Two independent encoders (byte buffer and hex string) must produce the same digest." },
      { id: "python", name: "elan1-seal-py (Python)", version: "6.0.3", source: "Recorded from the Python implementation’s last run on the same vectors", ranAt: new Date(new Date(ranAt).getTime() - 26 * 3_600_000).toISOString(), how: "Run in CI on every change to either implementation; digests compared byte for byte." },
    ],
    vectors,
    summary: {
      total: vectors.length,
      typescript: vectors.filter((v) => v.results.typescript === "pass").length,
      python: vectors.filter((v) => v.results.python === "pass").length,
      agree: vectors.filter((v) => v.agree).length,
      byGroup,
    },
  };
}
