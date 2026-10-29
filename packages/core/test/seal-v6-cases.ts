// The verifier cases the console's results were frozen for (test/fixtures/seal-v6/results.json). Both the fixture
// generator (run once against the console's code) and seal-v6.test.ts (run against core) build each input here, so
// the two verifiers see the same bytes. Synthetic cases come from seal-v6-builder.ts; "real" cases start from
// bundles the console's own export code built (test/fixtures/seal-v6/real-bundles.json).
import { PROFILES, keyFromSeed, makeSeal, manifestMessage, merkleRoot, sealFields, signRedaction, signText, tokenMessage, type EvidenceBundle, type Receipt, type SealRecord, type VerifyBundleOptions } from "../src/seal";
import { buildAuditorPack6, buildBundle6, orgKey, orgKey2, interimKey, type BuildOptions, type Built } from "./seal-v6-builder";

export interface Case {
  name: string;
  input: unknown;
  opts: VerifyBundleOptions;
  /** the profile the reader chose, for reportSections (as /verify passes it) */
  profileChecked?: string;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** Every case passes withdrawals, so the console's own withdrawal lookup (its demo state) is never consulted. */
const W = { withdrawals: {} };
const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const flip = (hex: string) => (hex[0] === "a" ? "b" : "a") + hex.slice(1);

type Mutate = (b: EvidenceBundle, built: Built) => unknown;

/** Build, change, and (when `resign`) recompute member digests and the manifest signature. */
function make(o: BuildOptions, mutate?: Mutate, resign = false): unknown {
  const built = buildBundle6(o);
  const b = clone(built.bundle);
  if (!mutate) return b;
  const out = mutate(b, built);
  const value = out === undefined ? b : out;
  return resign ? built.resign(value as EvidenceBundle) : value;
}

const sealed = (b: EvidenceBundle) => b.receipts.filter((r) => (b.seals ?? []).some((s) => s.seq === r.seq));
/** Re-seal a changed seal with the key that sealed it. */
function reseal(s: SealRecord, r: Receipt, built: Built, change: (values: SealRecord["fields"]) => void): SealRecord {
  const fields = clone(s.fields);
  change(fields);
  const key = [built.keys.org, built.keys.next, built.keys.interim].find((k) => k.kid === s.kid)!;
  return makeSeal(r, fields, key, s.level, s.payloadUnbound);
}

export function syntheticCases(): Case[] {
  const fp = orgKey().fingerprint;
  const FP = { ...W, expectedFingerprint: fp };
  const out: Case[] = [];
  const add = (name: string, input: unknown, opts: VerifyBundleOptions = W, profileChecked?: string) => out.push({ name, input, opts, ...(profileChecked ? { profileChecked } : {}) });

  // ── passes and their variants
  add("l2", make({}));
  add("l2-fp", make({}), FP);
  add("l2-fp-upper", make({}), { ...W, expectedFingerprint: ` ${fp.toUpperCase()} ` });
  add("l2-fp-wrong", make({}), { ...W, expectedFingerprint: orgKey2().fingerprint });
  add("l2-fp-usage", make({}), { ...W, expectedFingerprint: "xyz" });
  add("l3", make({ level: "l3" }), FP);
  add("sovereign", make({ level: "sovereign", l1Count: 0 }), FP);
  add("l1-only", make({ l1Count: 30, lexicon: "none" }), FP);
  add("tail", make({ unanchoredTail: 3 }), FP);
  add("degraded", make({ degradedBatches: [1, 2, 3, 4] }), FP);
  add("lexicon-unlisted", make({ lexicon: "unlisted" }), FP);
  add("lexicon-none", make({ lexicon: "none" }), FP);
  add("erased", make({ erased: [10, 12] }), FP);
  add("erased-bound", make({ erased: [10] }, (b) => { b.seals!.find((s) => s.payloadUnbound)!.payloadUnbound = false; }, true), FP);
  add("erased-l1", make({ erased: [] }, (b, built) => {
    // an erased L1 record: no seal, the redaction signature alone binds what is left
    const r = b.receipts[2]!;
    const { args_summary: _a, ...rest } = r;
    void _a;
    b.receipts[2] = signRedaction({ ...(rest as Receipt), redacted: { fields: ["args_summary"], reason: "erasure" } }, built.keys.org);
  }, true), FP);
  add("rotate-org", make({ rotateAt: 15 }), FP);
  add("rotate-next", make({ rotateAt: 15 }), { ...W, expectedFingerprint: orgKey2().fingerprint });
  add("interim", make({ interim: { from: 20, to: 24 } }), FP);
  add("interim-open", make({ interim: { from: 26 } }), FP);
  add("interim-fp", make({ interim: { from: 20, to: 24 } }), { ...W, expectedFingerprint: interimKey().fingerprint });
  add("disclosures", make({ disclosures: [8, 9] }), { ...W, now: NOW });
  add("disclosure-bad", make({ disclosures: [8] }, (b) => { b.disclosures![0]!.revealed[0]!.value = "edited"; }, true), { ...W, now: NOW });
  add("disclosure-expired", make({ disclosures: [8] }), { ...W, now: Date.parse("2027-02-01T00:00:00.000Z") });

  // ── profiles: claimed, overridden, none, unknown, extra rows, withdrawn
  for (const p of PROFILES) add(`profile-${p.id}`, make({ profileId: p.id }), FP, "claimed");
  for (const p of PROFILES) add(`override-${p.id}`, make({ hourShift: 12, checkpointEvery: 1000 }), { ...FP, profileId: p.id }, p.id);
  add("profile-none", make({ profileId: "in-mca-audit-trail" }), { ...FP, profileId: "none" }, "none");
  add("profile-unknown", make({}), { ...FP, profileId: "in-nowhere" }, "in-nowhere");
  add("profile-claimed-unknown", make({ manifestExtra: { profile_id: "in-nowhere" } }), FP);
  add("profile-extra-rows", make({
    profileId: "in-gst-einvoice", profileWithdrawnAt: "2026-10-25T00:00:00.000Z",
    profileExtraRows: [
      { id: "C90", kind: "coverage", clause: "Day 0", text: "Necessity statement", disposition: "not_measurable", reason: "Recorded outside the chain", wouldChangeIf: "The statement is bound into a receipt" },
      { id: "C91", kind: "binding", clause: "Scope", text: "Out of scope", disposition: "out_of_scope", adr: "ADR-0099" },
      { id: "C92", kind: "binding", clause: "Bound", text: "A bound row from the bundle is not used" },
    ],
  }), FP);
  add("profile-withdrawn-opt", make({ profileId: "in-mca-audit-trail" }), { ...FP, withdrawals: { "in-mca-audit-trail": { at: "2026-10-26T00:00:00.000Z", reason: "Superseded" } } });
  add("profile-digest-other", make({ profileId: "in-mca-audit-trail", manifestExtra: { profile_digest: "00".repeat(32) } }), FP);
  add("profile-late-gst", make({ profileId: "in-gst-einvoice", lateBatches: [0, 2] }), FP);
  add("profile-dpdp-context", make({
    profileId: "in-dpdp",
    patch: (i, body) => { if (i === 3) body.args_summary = { ...body.args_summary, contact: "meera@example.in" }; if (i === 8) body.details = {}; },
    context: {
      erasures: [
        { id: "er_1", subjectRef: "DP-1", subjectHash: "00", reason: "asked", requestedBy: "u_1", requestedAt: "2026-09-01T00:00:00.000Z", dueAt: "2026-09-04T00:00:00.000Z", affectedSeqs: [111], affected: 1, required: 2, approvals: [], status: "executed", executedAt: "2026-09-05T00:00:00.000Z" },
        { id: "er_2", subjectRef: "DP-2", subjectHash: "01", reason: "asked", requestedBy: "u_1", requestedAt: "2026-09-01T00:00:00.000Z", dueAt: "2026-09-04T00:00:00.000Z", affectedSeqs: [112], affected: 1, required: 2, approvals: [], status: "approved" },
        { id: "er_3", subjectRef: "DP-3", subjectHash: "02", reason: "asked", requestedBy: "u_1", requestedAt: "2026-09-01T00:00:00.000Z", dueAt: "2026-09-04T00:00:00.000Z", affectedSeqs: [113], affected: 1, required: 2, approvals: [], status: "executed", executedAt: "2026-09-03T00:00:00.000Z" },
      ],
    },
  }), FP);
  add("profile-iso-pass", make({ profileId: "iso42001-nist", context: { agents: [{ slug: "invoice-bot", id: "ag_1", aiSystemId: "ais_1" }], aiSystems: [{ id: "ais_1", riskTier: "high" }], assessments: [] } }), FP);
  add("profile-mca-l1", make({ profileId: "in-mca-audit-trail", l1Count: 30, lexicon: "none", context: { wormRetentionYears: 0 } }), FP);
  add("profile-mca-short-retention", make({ profileId: "in-mca-audit-trail", context: { wormRetentionYears: 0 }, patch: (i, body) => { if (i === 6) delete body.actor; if (i === 0) delete body.rulebook; } }), FP);
  add("profile-gst-l1", make({ profileId: "in-gst-einvoice", l1Count: 30, lexicon: "none" }), FP);
  add("profile-gst-unanchored", make({ profileId: "in-gst-einvoice", unanchoredTail: 24 }, (b) => { b.anchors!.batches = []; }, true), FP);
  add("profile-eu-fails", make({ profileId: "eu-ai-act-art12", patch: (i, body) => { if (i === 2) delete body.approval!.approver; if (i === 1) delete body.rulebook; } }), FP);
  add("profile-gst-fails", make({ profileId: "in-gst-einvoice", patch: (i, body) => { if (i === 0) delete body.args_summary!.amount; if (i === 5) body.decision = "allow"; } }), FP);
  add("profile-rbi-fails", make({ profileId: "in-rbi-collections", hourShift: 14, patch: (i, body) => { if (i === 4) body.decision = "allow"; } }), FP);
  add("profile-mca-approval-orphan", make({ profileId: "in-mca-audit-trail", patch: (i, body) => { if (i === 2) body.ref_seq = 1; } }), FP);

  // ── integrity failures that the member digests catch (bundle changed after it was signed)
  add("tamper-amount", make({}, (b) => { b.receipts[10]!.args_summary!.amount = 99; }), FP);
  add("tamper-manifest-sig", make({}, (b) => { b.manifest_sig = flip(b.manifest_sig!); }), FP);
  add("tamper-signing-kid", make({}, (b) => { b.manifest.signing_kid = "k_none"; }), FP);
  add("tamper-seal-format", make({}, (b) => { b.seals![0]!.format = "elan1.seal.v5" as "elan1.seal.v6"; }), FP);
  add("format-future", make({}, (b) => { b.manifest.bundle_format = "elan1.evidence.bundle.v9"; b.manifest.format = "elan1.evidence.bundle.v9"; }), FP);

  // ── the same failures with the manifest re-signed: each section's own check must catch them
  add("resign-amount", make({}, (b) => { b.receipts[10]!.args_summary!.amount = 99; }, true), FP);
  add("resign-link", make({}, (b) => { b.receipts.splice(12, 1); }, true), FP);
  add("resign-receipt-sig", make({}, (b) => { b.receipts[14]!.sig = flip(b.receipts[14]!.sig); }, true), FP);
  add("resign-record-count", make({}, (b) => { b.manifest.record_count = 31; }, true), FP);
  add("resign-missing-key", make({}, (b) => { delete b.public_keys["k_org_1"]; }, true), FP);
  add("resign-checkpoint-sig", make({}, (b) => { b.checkpoints[0]!.sig = flip(b.checkpoints[0]!.sig); }, true), FP);
  add("resign-no-checkpoints", make({ checkpointEvery: 1000 }), FP);
  add("resign-lexicon-missing", make({}, (b) => { delete b.lexicon; }, true), FP);
  add("resign-anchors-missing", make({}, (b) => { delete b.anchors; }, true), FP);
  add("resign-seal-field", make({}, (b) => { b.seals![3]!.fields[4]!.value += "x"; }, true), FP);
  add("resign-seal-sig", make({}, (b) => { b.seals![3]!.sig = flip(b.seals![3]!.sig); }, true), FP);
  add("resign-seal-structure", make({}, (b) => { b.seals![3]!.fields.splice(11, 1); }, true), FP);
  add("resign-seal-binding", make({}, (b, built) => { const s = b.seals![3]!; b.seals![3] = reseal(s, sealed(b)[3]!, built, (f) => { f[3]!.value = "w_other"; }); }, true), FP);
  add("resign-seal-f03", make({}, (b, built) => { const s = b.seals![5]!; b.seals![5] = reseal(s, sealed(b)[5]!, built, (f) => { f[2]!.value = "00".repeat(32); }); }, true), FP);
  add("resign-seal-missing", make({}, (b) => { b.seals!.splice(7, 1); }, true), FP);
  add("resign-batch-root", make({}, (b) => { b.anchors!.batches[1]!.root = flip(b.anchors!.batches[1]!.root); }, true), FP);
  add("resign-batch-leaf", make({}, (b) => { const x = b.anchors!.batches[1]!; x.leaves[0] = "11".repeat(32); x.root = merkleRoot(x.leaves); }, true), FP);
  add("resign-token-sig", make({}, (b) => { const t = b.anchors!.batches[2]!.tokens[0]!; t.sig = flip(t.sig); }, true), FP);
  add("resign-token-unknown", make({}, (b) => { b.anchors!.authorities = b.anchors!.authorities.slice(1); }, true), FP);
  add("resign-token-none", make({}, (b) => { b.anchors!.batches[0]!.tokens = []; }, true), FP);
  add("resign-batch-gap", make({}, (b) => { b.anchors!.batches.splice(1, 1); }, true), FP);
  add("resign-token-imprint", make({}, (b) => {
    // a token signed over a different imprint by a real authority
    const t = b.anchors!.batches[0]!.tokens[1]!;
    t.imprint = "22".repeat(32);
    t.sig = signText(tokenMessage(t), keyFromSeed("fixture:tsa:global", "tsa_global"));
  }, true), FP);
  add("resign-empty", make({}, (b) => { b.receipts = []; b.checkpoints = []; }, true), FP);
  add("resign-seal-reseal-all", make({}, (b, built) => {
    // a seal chain recomputed from scratch with the fields the builder uses: still valid
    const rs = sealed(b);
    let prev = b.receipts[5]!.hash;
    b.seals = rs.map((r, i) => {
      const s = makeSeal(r, sealFields(r, { prevDigest: prev, autonomy: "A0", recordVersion: 1, salt: String(i).padStart(32, "0"), lexiconHash: "cd".repeat(32), level: "l2" }), built.keys.org, "l2");
      prev = s.digest;
      return s;
    });
  }, true), FP);

  // ── not bundles, and bundles without a manifest
  add("usage-null", null);
  add("usage-string", "bundle");
  add("usage-records", { manifest: { format: "auditor-pack/1" }, records: [] });
  add("usage-throws", { receipts: [null] });
  const plain = buildBundle6({ l1Count: 30, count: 8, lexicon: "none" }).bundle;
  add("receipts-only", { receipts: plain.receipts, public_keys: plain.public_keys, checkpoints: plain.checkpoints }, FP);
  add("receipts-one", { receipts: plain.receipts.slice(0, 1), public_keys: plain.public_keys, checkpoints: [] });
  add("receipts-no-key", { receipts: plain.receipts, public_keys: {}, checkpoints: [] });
  add("receipts-manifest-l1", { manifest: { assurance_levels: [{ level: "l1", count: 8, first_seq: 101, last_seq: 108 }] }, receipts: plain.receipts, public_keys: plain.public_keys, checkpoints: [] }, FP);
  add("receipts-unknown-format", { manifest: { format: "something/2" }, receipts: plain.receipts, public_keys: plain.public_keys, checkpoints: [] });
  add("receipts-sealed-only-fields", { manifest: { sealing_kid: "k_org_1" }, receipts: plain.receipts, public_keys: plain.public_keys, checkpoints: [] });

  // ── console L1 auditor packs
  for (const style of ["file", "canonical", "unsealed-old", "unsealed-new", "seal-stripped"] as const) add(`pack-${style}`, buildAuditorPack6({ style }).bundle, FP);
  add("pack-undated", (() => { const b = buildAuditorPack6({ style: "unsealed-new" }).bundle; delete b.manifest.created_at; return b; })(), FP);
  const pack = (change: (b: EvidenceBundle) => void, reseal = true) => {
    const { bundle, key } = buildAuditorPack6({});
    const b = clone(bundle);
    change(b);
    if (reseal) b.manifest_seal = signText(manifestMessage(b.manifest), key);
    return b;
  };
  add("pack-tamper-amount", pack((b) => { b.receipts[4]!.args_summary!.amount = 1; }, false), FP);
  add("pack-tail-cut", pack((b) => { b.receipts = b.receipts.slice(0, -3); b.checkpoints = b.checkpoints.filter((c) => c.seq <= 17); }, false), FP);
  add("pack-manifest-edited", pack((b) => { b.manifest.refusal_count = 0; }, false), FP);
  add("pack-sealer-missing", pack((b) => { b.manifest.sealing_kid = "k_none"; }), FP);
  add("pack-file-missing", pack((b) => { delete b.summary_pdf; }), FP);
  add("pack-file-edited", pack((b) => { b.readme = "edited"; }), FP);
  add("pack-first-seq", pack((b) => { b.manifest.first_seq = 2; }), FP);
  add("pack-record-count", pack((b) => { b.manifest.record_count = 21; }), FP);
  add("pack-refusals", pack((b) => { b.manifest.refusal_count = 0; }), FP);
  add("pack-checkpoints", pack((b) => { b.manifest.checkpoints = 9; }), FP);
  add("pack-fp-wrong", buildAuditorPack6({}).bundle, { ...W, expectedFingerprint: orgKey2().fingerprint });
  return out;
}

/** Bundles the console's export code built, with the organisation's published fingerprint. */
export interface RealBase {
  bundle: EvidenceBundle;
  fingerprint: string;
}

export function realCases(bases: Record<string, RealBase>): Case[] {
  const out: Case[] = [];
  for (const [name, base] of Object.entries(bases)) {
    const FP = { ...W, expectedFingerprint: base.fingerprint };
    const b = () => clone(base.bundle);
    out.push({ name: `${name}`, input: b(), opts: W });
    out.push({ name: `${name}-fp`, input: b(), opts: FP });
    if (base.bundle.manifest.format === "auditor-pack/1") {
      out.push({ name: `${name}-tamper`, input: (() => { const x = b(); const r = x.receipts.find((y) => typeof y.args_summary?.amount === "number") ?? x.receipts[3]!; r.reason = `${r.reason ?? ""} (edited)`; return x; })(), opts: FP });
      out.push({ name: `${name}-tail`, input: (() => { const x = b(); x.receipts = x.receipts.slice(0, -5); return x; })(), opts: FP });
      continue;
    }
    for (const p of PROFILES) if (p.id !== "in-dpdp") out.push({ name: `${name}-${p.id}`, input: b(), opts: { ...FP, profileId: p.id }, profileChecked: p.id });
    out.push({ name: `${name}-tamper`, input: (() => { const x = b(); const r = x.receipts[x.receipts.length - 4]!; r.reason = `${r.reason ?? ""} (edited)`; return x; })(), opts: FP });
    out.push({ name: `${name}-no-anchors`, input: (() => { const x = b(); delete x.anchors; return x; })(), opts: FP });
    out.push({ name: `${name}-future`, input: (() => { const x = b(); x.manifest.bundle_format = "elan1.evidence.bundle.v9"; return x; })(), opts: FP });
  }
  return out;
}
