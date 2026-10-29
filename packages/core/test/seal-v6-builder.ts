// Deterministic Seal v6 evidence bundles and console auditor packs, built and signed with core's own seal module.
// The fixture generator (scripts/gen-seal-v6-fixtures.mts) builds the same bundles and records what the console's
// verifier says about each, so core's verifier is checked against the console on bundles that exercise every
// section, not only on the console's demo data. Keep this file deterministic: no clock, no randomness.
import {
  BUNDLE_MEMBERS, L1_PACK_MEMBERS, LEXICON_MEMBER, PROFILES, fileDigest, keyFromSeed, l1PackContents, l1PackFiles, makeSeal, manifestMessage,
  memberDigest, merkleRoot, sealFields, signCheckpoint, signReceipt, signRedaction, signText, tokenMessage, disclosureDigest, disclosureMessage, fieldValuesOf,
  type AnchorBatch, type BundleLexicon, type BundleManifest, type Checkpoint, type DisclosurePackage, type ErasureRequest, type EvidenceBundle, type KeyPair,
  type LevelId, type Receipt, type SealRecord, type TimestampToken, type TsaAuthority, type VerifierProfile,
} from "../src/seal";

export const ORG = "org_fixture";
export const T0 = Date.parse("2026-10-20T03:30:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export const orgKey = () => keyFromSeed("fixture:org-key:1", "k_org_1");
export const orgKey2 = () => keyFromSeed("fixture:org-key:2", "k_org_2");
export const interimKey = () => keyFromSeed("fixture:interim-key", "k_interim");
const tsaKeys = () => [keyFromSeed("fixture:tsa:emudhra", "tsa_emudhra"), keyFromSeed("fixture:tsa:global", "tsa_global")];

/** One receipt body before chaining: what kind of write it is. */
export type Body = Omit<Receipt, "seq" | "ts" | "org" | "prev_hash" | "kid" | "hash" | "sig">;

/**
 * The receipts' content: a varied mix so every verifier profile rule has something to read (books changes with
 * amounts, payments, collections emails in and out of hours, final notices, deletes, approvals, publishes,
 * refusals, personal-data reads, an email address leak).
 */
function bodyFor(i: number): Body {
  const rb = { version: 3, hash: "ab".repeat(32) };
  switch (i % 12) {
    case 0: return { kind: "decision", agent: "invoice-bot", tool: "zoho_books.create_bill", args_summary: { amount: 1000 + i, vendor: "Blue Dart" }, rulebook: rb, rule_id: "bills-under-cap", decision: "allow", reason: "Under the cap" };
    case 1: return { kind: "decision", agent: "invoice-bot", tool: "zoho_books.record_payment", args_summary: { amount: 2500, bill: `BILL-${i}` }, rulebook: rb, rule_id: "payments", decision: "ask", reason: "Needs a person" };
    case 2: return { kind: "approval", agent: "invoice-bot", tool: "zoho_books.record_payment", ref_seq: -1, decision: "allow", approval: { id: `apr_${i}`, status: "approved", approver: "u_meera", channel: "web" } };
    case 3: return { kind: "decision", agent: "collections-agent", tool: "gmail.send_email", args_summary: { template: "reminder", to_domain: "example.in" }, rulebook: rb, rule_id: "reminders", decision: "allow", reason: "In hours" };
    case 4: return { kind: "decision", agent: "collections-agent", tool: "gmail.send_email", args_summary: { template: "final_notice", to_domain: "example.in" }, rulebook: rb, rule_id: "final-notice", decision: "ask", reason: "Final notices need a person" };
    case 5: return { kind: "decision", agent: "invoice-bot", tool: "zoho_books.delete_invoice", args_summary: { invoice: `INV-${i}` }, rulebook: rb, rule_id: "no-deletes", decision: "refuse", reason: "Agents never delete invoices" };
    case 6: return { kind: "admin", actor: "u_rahul", action: "rulebook.published", details: { rulebook: "invoice-bot", version: 3 } };
    case 7: return { kind: "outcome", agent: "invoice-bot", tool: "zoho_books.create_bill", ref_seq: -7, outcome: { status: "ok", ref: `BILL-${i}`, ms: 120 } };
    case 8: return { kind: "decision", agent: "hr-screening", tool: "hr.read_application", args_summary: { application: `APP-${i}` }, details: { tags: "personal_data" }, rulebook: rb, rule_id: "reads", decision: "allow", reason: "Read only" };
    case 9: return { kind: "decision", agent: "vendor-onboarding", tool: "procure.update_bank_details", args_summary: { vendor: "Acme Traders" }, rulebook: rb, rule_id: "bank-change", decision: "refuse", reason: "Bank changes are refused" };
    case 10: return { kind: "decision", agent: "invoice-bot", tool: "zoho_books.create_bill", args_summary: { amount: 990000, counterparty: "Nilgiri" }, rulebook: rb, rule_id: "bills-over-cap", decision: "ask", reason: "Over the cap" };
    default: return { kind: "decision", agent: "treasury-sweeper", tool: "bank.initiate_transfer", args_summary: { amount: 50000, to_account: "EXT-SBIN-7781" }, rulebook: rb, rule_id: "transfers", decision: "allow", reason: "Bounded transfer" };
  }
}

export interface BuildOptions {
  /** receipts in the bundle (default 30) */
  count?: number;
  /** the first seq (default 101) */
  firstSeq?: number;
  /** how many leading receipts are L1 (default 6); the rest are at `level` */
  l1Count?: number;
  level?: LevelId;
  /** sealed receipts at the head left out of every batch */
  unanchoredTail?: number;
  /** receipts per anchor batch (default 5) */
  batchSize?: number;
  /** batches (by index) that carry a token from only one authority */
  degradedBatches?: number[];
  /** batches (by index) whose second token is issued later than 15 minutes after the window closed */
  lateBatches?: number[];
  /** the lexicon member: listed in the manifest, carried but not listed, or absent (default listed) */
  lexicon?: "listed" | "unlisted" | "none";
  /** profile claimed in the manifest (and carried in profile/) */
  profileId?: string;
  /** rows added to the carried profile (they must be not_measurable or out_of_scope to count) */
  profileExtraRows?: VerifierProfile["rules"];
  profileWithdrawnAt?: string;
  /** rotate to a second key at this receipt index (a key.rotated receipt is written there) */
  rotateAt?: number;
  /** receipts (by index) sealed by an interim chain key after a declared compromise */
  interim?: { from: number; to?: number };
  /** receipt indexes whose fields are erased (redacted + payload unbound) */
  erased?: number[];
  /** disclosure packages over these receipt indexes */
  disclosures?: number[];
  /** a checkpoint every n receipts (default 10) */
  checkpointEvery?: number;
  /** hours added to every receipt time (moves collections contacts out of hours) */
  hourShift?: number;
  /** the profile-rule context in declarations.json */
  context?: Partial<NonNullable<NonNullable<EvidenceBundle["declarations"]>["context"]>>;
  /** extra manifest fields */
  manifestExtra?: Partial<BundleManifest>;
  /** change receipt `i` before it is signed */
  patch?: (i: number, body: Body) => void;
}

export interface Built {
  bundle: EvidenceBundle;
  keys: { org: KeyPair; next: KeyPair; interim: KeyPair };
  /** recompute member digests and the manifest signature after a test changed the bundle */
  resign: (b: EvidenceBundle) => EvidenceBundle;
}

/** The lexicon member: the vocabulary the receipts use. */
function lexiconOf(receipts: Receipt[]): BundleLexicon {
  const ids = Array.from(new Set(receipts.map((r) => r.rule_id).filter((x): x is string => !!x))).sort();
  return {
    format: "elan1.lexicon.v1",
    decisions: { allow: "The call ran.", ask: "A person decided.", refuse: "The call did not run." },
    rules: ids.filter((id) => id !== "reminders").map((id) => ({ id, decision: "allow", text: `Rule ${id}`, rulebooks: ["invoice-bot@3"] })),
    refusal_codes: [{ code: "RULE_REFUSED", ref: "R-01", family: "rules", title: "Refused by a rule", rule_ids: ["no-deletes"] }],
  };
}

export function buildBundle6(o: BuildOptions = {}): Built {
  const count = o.count ?? 30;
  const firstSeq = o.firstSeq ?? 101;
  const l1Count = Math.min(o.l1Count ?? 6, count);
  const level = o.level ?? "l2";
  const org = orgKey();
  const next = orgKey2();
  const interim = interimKey();
  const keyAt = (i: number) => (o.interim && i >= o.interim.from && i <= (o.interim.to ?? Infinity) ? interim : o.rotateAt !== undefined && i > o.rotateAt ? next : org);

  // ── receipts
  const receipts: Receipt[] = [];
  let prev = "0".repeat(64);
  for (let i = 0; i < count; i++) {
    const seq = firstSeq + i;
    const key = keyAt(i);
    const body: Body = o.rotateAt === i ? { kind: "admin", actor: "u_rahul", action: "key.rotated", details: { old_kid: org.kid, new_kid: next.kid } } : clone(bodyFor(i));
    o.patch?.(i, body);
    if (body.ref_seq !== undefined && body.ref_seq < 0) body.ref_seq = seq + body.ref_seq;
    if (body.ref_seq !== undefined && body.ref_seq < firstSeq) delete body.ref_seq;
    const ts = iso(T0 + i * 7 * 60_000 + (o.hourShift ?? 0) * 3_600_000);
    const r = signReceipt({ seq, ts, org: ORG, ...body, prev_hash: prev, kid: key.kid } as Omit<Receipt, "hash" | "sig">, key);
    receipts.push(r);
    prev = r.hash;
  }
  const levelOf = (i: number): LevelId => (i < l1Count ? "l1" : level);
  const levels: NonNullable<BundleManifest["assurance_levels"]> = [];
  receipts.forEach((r, i) => {
    const lv = levelOf(i);
    const last = levels[levels.length - 1];
    if (last && last.level === lv) { last.count++; last.last_seq = r.seq; } else levels.push({ level: lv, count: 1, first_seq: r.seq, last_seq: r.seq });
  });

  // ── seals: every receipt at L2 or above; F03 chains from the last L1 receipt hash
  const seals: SealRecord[] = [];
  let prevDigest = l1Count > 0 ? receipts[l1Count - 1]!.hash : "0".repeat(64);
  const erased = new Set(o.erased ?? []);
  for (let i = l1Count; i < count; i++) {
    const r = receipts[i]!;
    const salt = erased.has(i) ? undefined : String(i).padStart(32, "0");
    const fields = sealFields(r, { prevDigest, autonomy: level === "l3" ? "A2" : "A0", recordVersion: 1, salt, lexiconHash: "cd".repeat(32), level: levelOf(i) }, erased.has(i) ? "ef".repeat(32) : undefined);
    const s = makeSeal(r, fields, keyAt(i), levelOf(i), erased.has(i));
    seals.push(s);
    prevDigest = s.digest;
  }
  // erased receipts leave without the values the rules inspected, bound by the organisation's redaction signature
  const exported = receipts.map((r, i) => {
    if (!erased.has(i)) return r;
    const { args_summary: _a, ...rest } = r;
    return signRedaction({ ...rest, redacted: { fields: ["args_summary"], reason: "erasure", request: "er_1", at: iso(T0 + 86_400_000) } }, org);
  });

  // ── anchors: Merkle batches over the sealed receipts, each timestamped by two authorities
  const [tsaA, tsaB] = tsaKeys() as [KeyPair, KeyPair];
  const authorities: TsaAuthority[] = [
    { id: tsaA.kid, name: "eMudhra TSA", scope: "India", url: "https://tsa.example.in", policyOid: "1.2.3.4", publicKey: tsaA.publicKeyHex, fingerprint: tsaA.fingerprint, status: "operational" },
    { id: tsaB.kid, name: "Global TSA", scope: "Global", url: "https://tsa.example.com", policyOid: "1.2.3.5", publicKey: tsaB.publicKeyHex, fingerprint: tsaB.fingerprint, status: "operational" },
  ];
  const batchSize = o.batchSize ?? 5;
  const anchorable = receipts.slice(l1Count, count - (o.unanchoredTail ?? 0));
  const batches: (AnchorBatch & { leaves: string[] })[] = [];
  for (let b = 0; b * batchSize < anchorable.length; b++) {
    const rs = anchorable.slice(b * batchSize, (b + 1) * batchSize);
    const leaves = rs.map((r) => r.hash);
    const root = merkleRoot(leaves);
    const windowEnd = iso(Date.parse(rs[rs.length - 1]!.ts) + 60_000);
    const token = (k: KeyPair, a: TsaAuthority, delay: number): TimestampToken => {
      const t = { tsaId: a.id, tsaName: a.name, genTime: iso(Date.parse(windowEnd) + delay * 1000), serial: `${a.id}-${b}`, policyOid: a.policyOid, status: delay > 900 ? "granted_late" as const : "granted" as const, imprint: root, sig: "", delaySeconds: delay };
      return { ...t, sig: signText(tokenMessage(t), k) };
    };
    const tokens = [token(tsaA, authorities[0]!, 40), ...((o.degradedBatches ?? []).includes(b) ? [] : [token(tsaB, authorities[1]!, (o.lateBatches ?? []).includes(b) ? 1800 : 70)])];
    batches.push({ id: `b_${b + 1}`, windowStart: iso(Date.parse(rs[0]!.ts) - 60_000), windowEnd, firstSeq: rs[0]!.seq, lastSeq: rs[rs.length - 1]!.seq, count: rs.length, root, tokens, status: "anchored", leaves });
  }

  // ── checkpoints
  const checkpoints: Checkpoint[] = [];
  const every = o.checkpointEvery ?? 10;
  receipts.forEach((r, i) => {
    if ((i + 1) % every !== 0) return;
    const k = keyAt(i) === interim ? org : keyAt(i);
    checkpoints.push(signCheckpoint({ id: `cp_${r.seq}`, org: ORG, seq: r.seq, hash: r.hash, ts: iso(Date.parse(r.ts) + 1000), kid: k.kid }, k));
  });

  // ── disclosure packages
  const disclosures: DisclosurePackage[] = (o.disclosures ?? []).map((i, n) => {
    const r = receipts[i]!;
    const values: Record<string, string> = fieldValuesOf(r);
    // deterministic salts for the fixture (the console draws random ones)
    const names = Object.keys(values).sort();
    const salts = Object.fromEntries(names.map((name, j) => [name, `${n}${j}`.padStart(32, "0")]));
    const committed = names.map((name) => ({ name, digest: disclosureDigest(salts[name]!, name, values[name]!) }));
    const base = { orgId: ORG, seq: r.seq, receiptHash: r.hash, audience: "ar-org:auditor", expiresAt: "2026-12-31T00:00:00.000Z", committed };
    return {
      id: `dp_${n + 1}`, ...base, issuerName: "Fixture Org", createdAt: iso(T0), createdBy: "u_rahul", token: `fixture.${n}`,
      revealed: ["decision", "tool"].map((name) => ({ name, salt: salts[name]!, value: values[name]! })),
      kid: org.kid, publicKey: org.publicKeyHex, sig: signText(disclosureMessage(base), org), status: "active", views: 0,
    };
  });

  // ── declarations, profile, lexicon
  const declarations: NonNullable<EvidenceBundle["declarations"]> = {
    rulebooks: [{ slug: "invoice-bot", version: 3, hash: "ab".repeat(32), signedBy: "u_rahul", signedAt: iso(T0 - 86_400_000) }],
    context: {
      wormRetentionYears: 8,
      erasures: [] as ErasureRequest[],
      agents: [{ slug: "invoice-bot", id: "ag_1", aiSystemId: "ais_1" }, { slug: "collections-agent", id: "ag_2", aiSystemId: "ais_2" }, { slug: "hr-screening", id: "ag_3" }],
      aiSystems: [{ id: "ais_1", riskTier: "high" }, { id: "ais_2", linkedAgentId: "ag_2", riskTier: "limited" }],
      assessments: [{ aiSystemId: "ais_1", status: "approved" }],
      ...o.context,
    },
  };
  const base = o.profileId ? PROFILES.find((p) => p.id === o.profileId) : undefined;
  const profile: VerifierProfile | null = base
    ? { ...clone(base), rules: [...clone(base.rules), ...(o.profileExtraRows ?? [])], ...(o.profileWithdrawnAt ? { withdrawnAt: o.profileWithdrawnAt, withdrawnReason: "Replaced by v1.1" } : {}) }
    : null;
  const readme = "Fixture evidence bundle. Verify it offline: govern verify bundle.json";
  const lexicon = o.lexicon === "none" ? undefined : lexiconOf(exported);

  const signer = o.rotateAt !== undefined ? next : org;
  const publicKeys: Record<string, string> = { [org.kid]: org.publicKeyHex, ...(o.rotateAt !== undefined ? { [next.kid]: next.publicKeyHex } : {}), ...(o.interim ? { [interim.kid]: interim.publicKeyHex } : {}) };
  const bundle: EvidenceBundle = {
    manifest: {},
    public_keys: publicKeys,
    receipts: exported,
    checkpoints,
    seals,
    anchors: { authorities, batches },
    declarations,
    profile,
    readme,
    ...(lexicon ? { lexicon } : {}),
    ...(disclosures.length ? { disclosures } : {}),
  };
  const manifestBase: BundleManifest = {
    format: "elan1.evidence.bundle.v1", bundle_format: "elan1.evidence.bundle.v1", issuer: "Elan1 Govern · fixture", org: "Fixture Org", org_id: ORG, tenant_id: ORG,
    created_at: iso(T0 + 2 * 86_400_000), created_by: "system", receipts: count, record_count: count, refusal_count: exported.filter((r) => r.decision === "refuse").length,
    first_seq: firstSeq, last_seq: firstSeq + count - 1, checkpoints: checkpoints.length,
    ...(o.interim ? { unsigned_intervals: [{ compromise: "kc_1", revoked_kid: org.kid, interim_kid: interim.kid, first_seq: firstSeq + o.interim.from, ...(o.interim.to !== undefined ? { last_seq: firstSeq + o.interim.to } : {}), open: o.interim.to === undefined }] } : {}),
    keys: [{ kid: org.kid, fingerprint: org.fingerprint, status: o.rotateAt !== undefined ? "retired" : "active" }, ...(o.rotateAt !== undefined ? [{ kid: next.kid, fingerprint: next.fingerprint, status: "active" }] : []), ...(o.interim ? [{ kid: interim.kid, fingerprint: interim.fingerprint, status: "interim", interim: true }] : [])],
    assurance_levels: levels, continuity_scope: "range", enforcement_mode: "enforced",
    profile_id: profile?.id, profile_version: profile?.version, profile_digest: base?.digest, redaction_profile: "none",
    unanchored_head: o.unanchoredTail ?? 0, signing_kid: signer.kid, note: "Fixture",
    ...o.manifestExtra,
  };
  const resign = (b: EvidenceBundle): EvidenceBundle => {
    const contents: Record<string, unknown> = {
      "receipts.jsonl": b.receipts, "seals.jsonl": b.seals, "checkpoints.json": b.checkpoints, "anchors.json": b.anchors, "keys.json": b.public_keys, "declarations.json": b.declarations,
      "profile/ (profile.json + VERIFY.txt)": { profile: b.profile ?? null, readme: b.readme ?? "" }, [LEXICON_MEMBER]: b.lexicon,
    };
    const paths = [...BUNDLE_MEMBERS, ...(o.lexicon === "listed" || o.lexicon === undefined ? [LEXICON_MEMBER] : [])];
    const members = paths.map((path) => (path === "manifest.json" ? { path, bytes: 0, sha256: "self" } : { path, ...memberDigest(contents[path] ?? null) }));
    const manifest = { ...(b.manifest.format ? b.manifest : manifestBase), members };
    return { ...b, manifest, manifest_sig: signText(manifestMessage(manifest), signer) };
  };
  return { bundle: resign(bundle), keys: { org, next, interim }, resign };
}

export interface PackOptions {
  count?: number;
  firstSeq?: number;
  /** "file" (current), "canonical" (sealed packs before file digests), "unsealed-old", "unsealed-new" or "seal-stripped" */
  style?: "file" | "canonical" | "unsealed-old" | "unsealed-new" | "seal-stripped";
  createdAt?: string;
}

/** A console L1 auditor pack (auditor-pack/1). */
export function buildAuditorPack6(o: PackOptions = {}): { bundle: EvidenceBundle; key: KeyPair } {
  const built = buildBundle6({ count: o.count ?? 20, firstSeq: o.firstSeq ?? 1, l1Count: o.count ?? 20, lexicon: "none" });
  const key = built.keys.org;
  const { receipts, checkpoints, public_keys } = built.bundle;
  const style = o.style ?? "file";
  const summary_pdf = "%PDF-1.4\n% fixture summary\n%%EOF\n";
  const compliance_map = { frameworks: [{ id: "iso42001", requirements: [{ id: "A.6.2.8", seqs: receipts.slice(0, 3).map((r) => r.seq) }] }] };
  const readme = "Fixture auditor pack. Verify it offline.";
  const src = { public_keys, receipts, checkpoints, summary_pdf, compliance_map, readme };
  const createdAt = o.createdAt ?? (style === "unsealed-old" ? "2026-10-01T00:00:00.000Z" : "2026-10-28T06:00:00.000Z");
  const last = receipts[receipts.length - 1]!;
  const files = l1PackFiles(src);
  const contents = l1PackContents(src);
  const members = L1_PACK_MEMBERS.map((path) => (path === "manifest.json" ? { path, bytes: 0, sha256: "self" } : { path, ...(style === "canonical" ? memberDigest(contents[path]) : fileDigest(files[path] ?? "")) }));
  const common: BundleManifest = {
    format: "auditor-pack/1", issuer: "Elan1 Govern · fixture", org: "Fixture Org", org_id: ORG, created_at: createdAt, created_by: "u_rahul",
    receipts: receipts.length, record_count: receipts.length, refusal_count: receipts.filter((r) => r.decision === "refuse").length,
    first_seq: receipts[0]!.seq, last_seq: last.seq, checkpoints: checkpoints.length, enforcement_mode: "enforced",
    keys: [{ kid: key.kid, fingerprint: key.fingerprint, status: "active" }],
  };
  if (style === "unsealed-old" || style === "unsealed-new") return { bundle: { manifest: common, ...src }, key };
  const manifest: BundleManifest = { ...common, last_hash: last.hash, sealing_kid: key.kid, members, ...(style === "canonical" ? {} : { digest_of: "file" as const }) };
  if (style === "seal-stripped") return { bundle: { manifest, ...src }, key };
  return { bundle: { manifest, manifest_seal: signText(manifestMessage(manifest), key), ...src }, key };
}
