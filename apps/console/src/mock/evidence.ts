/**
 * Evidence exports and integrity, beside db.ts and platform.ts:
 *  - the L1 auditor pack (auditor-pack/1): receipts, keys, checkpoints, a PDF summary, a compliance map and a README,
 *    with a manifest sealed (Ed25519) over the last hash, the counts and every file's digest;
 *  - the enforcement mode (governed run, check and record, or both) every export manifest carries;
 *  - the declarations an L2+ export names when they are missing;
 *  - nightly integrity runs and the continuity report;
 *  - the sandbox receipts the demo organisations show (calls made with an sk_sbx_ key).
 * Building is separate from recording: the public verifier's samples build a pack without writing to the chain.
 * L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
 */
import type { Agent, LevelId, Receipt } from '@/types';
import { receiptHash, signText, verifyChain } from '@/lib/crypto';
import { L1_PACK_MEMBERS, bundleDigest, fileDigest, l1PackFiles, manifestMessage, type BundleManifest, type EvidenceBundle } from '@/lib/verify6';
import { applyAutonomy, grantFor } from '@/lib/autonomy';
import { evaluate } from '@/lib/evaluate';
import { rulebookAt } from './chain';
import type { Call } from './scenarios';
import { LEVEL_INFO, levelOfOrg } from '@/lib/levels';
import { LEGAL_ENTITY } from '@/lib/company';
import { buildPdf, type PdfBlock } from '@/lib/pdf';
import { makeRand } from '@/lib/prng';
import { SCENARIOS } from './scenarios';
import { append, getDB, governCall, redactErased, toolTagsIn, type AuditorPackExport, type OrgDB } from './db';
import { unsignedIntervalsInRange } from './keys';
import { indexControls, liveControlsOf, receiptPredicates, requirementsOf } from './controlMap';

const H = 3_600_000;
const D = 24 * H;

/* ── State kept on the organisation (optional: saved state may predate it) ── */

export interface IntegrityRun {
  id: string;
  at: string;
  kind: 'nightly' | 'on_demand';
  by?: string;
  fromSeq: number;
  toSeq: number;
  records: number;
  /** what was recomputed */
  checked: { links: number; hashes: number; signatures: number; checkpoints: number };
  result: 'pass' | 'fail';
  brokenAt?: number;
  reason?: string;
  ms: number;
  /** the evidence.integrity_run receipt (on-demand runs) */
  seq?: number;
}

export interface EvidenceState {
  sandboxSeeded?: boolean;
  integrityRuns?: IntegrityRun[];
}

/** Options an export carries into its manifest and its evidence.exported receipt. */
export interface ExportOptions {
  /** how the console wrote the file: a ZIP of members (default) or one JSON file */
  container?: 'zip' | 'json';
  /** L2+: the residency, retention and consent gate, as the person answered it */
  gate?: {
    residency: 'inside' | 'outside';
    residencyDomain?: string;
    transferBasis?: string;
    purpose?: string;
    personalRecords?: number;
    missingDeclarations?: string[];
    acknowledged?: boolean;
  };
  /** one part of an export split because the range was over the size limit */
  part?: { index: number; of: number; group: string };
}

/* ── Enforcement mode ─────────────────────────────────────── */

export type EnforcementModeId = 'enforced' | 'advisory' | 'mixed' | 'none';

export interface Enforcement {
  mode: EnforcementModeId;
  governed_run: number;
  check_and_record: number;
  agents_governed: number;
  agents_advisory: number;
  statement: string;
}

export const ENFORCEMENT_LABEL: Record<EnforcementModeId, string> = {
  enforced: 'Enforced — governed run',
  advisory: 'Advisory — check and record',
  mixed: 'Mixed — enforced and advisory',
  none: 'No agent decisions',
};

/** The enforcement mode of a set of records: governed run (MCP, enforced), check and record (REST/SDK, advisory), or both. */
export function enforcementOf(db: OrgDB, receipts: Receipt[]): Enforcement {
  let governed = 0;
  let advisory = 0;
  for (const r of receipts) {
    if (r.kind !== 'decision') continue;
    if (r.details?.mode === 'governed_run') governed++;
    else if (r.details?.mode === 'check_and_record') advisory++;
  }
  const live = db.agents.filter((a) => a.status !== 'draft');
  const agentsGoverned = live.filter((a) => a.route === 'mcp').length;
  const agentsAdvisory = live.length - agentsGoverned;
  const mode: EnforcementModeId = governed && advisory ? 'mixed' : governed ? 'enforced' : advisory ? 'advisory' : 'none';
  const statement = mode === 'none'
    ? 'No agent decisions in this range.'
    : `${governed ? `${governed} decision${governed === 1 ? '' : 's'} on the governed run (MCP): enforced — Elan1 Govern held the credential and a refused call could not run.` : ''}${governed && advisory ? ' ' : ''}${advisory ? `${advisory} by check and record (REST or SDK): advisory — Elan1 Govern decided and recorded; the agent ran the call with its own credentials.` : ''}`;
  return { mode, governed_run: governed, check_and_record: advisory, agents_governed: agentsGoverned, agents_advisory: agentsAdvisory, statement };
}

/* ── Declarations an export names when missing ────────────── */

export interface MissingDeclaration { kind: 'ai_system' | 'assessment' | 'rulebook_signature'; subject: string; detail: string }

/** Declarations the records in a range rely on that are not in place: an AI system, its approved assessment, a signed rulebook. */
export function missingDeclarations(db: OrgDB, receipts: Receipt[]): MissingDeclaration[] {
  const out: MissingDeclaration[] = [];
  const agents = new Set(receipts.filter((r) => r.kind === 'decision' && r.agent).map((r) => r.agent!));
  for (const slug of [...agents].sort()) {
    const a = db.agents.find((x) => x.slug === slug);
    if (!a) continue;
    const sys = a.aiSystemId ? db.aiSystems.find((s) => s.id === a.aiSystemId) : db.aiSystems.find((s) => s.linkedAgentId === a.id);
    if (!sys) { out.push({ kind: 'ai_system', subject: slug, detail: `No AI system is declared in the inventory for ${slug}.` }); continue; }
    if (!db.assessments.some((x) => x.aiSystemId === sys.id && x.status === 'approved')) out.push({ kind: 'assessment', subject: slug, detail: `${sys.name} (${slug}) has no approved risk assessment.` });
  }
  const seen = new Set<string>();
  for (const r of receipts) {
    if (!r.agent || !r.rulebook) continue;
    const k = `${r.agent}@${r.rulebook.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const v = db.rulebooks.find((b) => b.slug === r.agent)?.versions.find((x) => x.version === r.rulebook!.version);
    if (v && !v.signedBy) out.push({ kind: 'rulebook_signature', subject: k, detail: `Rulebook ${r.agent} v${r.rulebook.version} has no recorded signer.` });
  }
  return out;
}

/** Records in a range that carry personal data (the rule or the tool tagged them). */
export function personalDataCount(receipts: Receipt[]) {
  return receipts.filter((r) => r.kind === 'decision' && String(r.details?.tags ?? '').includes('personal_data')).length;
}

/* ── Compliance map (L1 pack) ─────────────────────────────── */

export interface ComplianceMap {
  label: string;
  note: string;
  controls: { id: string; name: string; receipts_in_pack: number; example_seq?: number }[];
  frameworks: { id: string; name: string; reference: string; covered: number; total: number; requirements: { id: string; title: string; controls: string[]; receipts_in_pack: number; status: 'evidenced in this pack' | 'no receipts in this pack' | 'no mapped control' }[] }[];
}

/**
 * Which framework requirements the receipts in a pack evidence. The control list, the predicates and the framework
 * mapping (level mappings included: EG-15 and EG-18 to EG-20) are the ones /compliance uses (mock/controlMap.ts).
 */
export function complianceMapOf(db: OrgDB, receipts: Receipt[]): ComplianceMap {
  const level = levelOfOrg(db.org);
  const inForce = liveControlsOf(db, db.controls, level);
  const byId = indexControls(inForce);
  const preds = receiptPredicates(db, level);
  const counts: Record<string, { n: number; last?: number }> = {};
  for (const c of inForce) counts[c.id] = { n: 0 };
  for (const r of receipts) for (const [id, pred] of Object.entries(preds)) if (counts[id] && pred(r)) { counts[id].n++; counts[id].last = r.seq; }
  const controls = inForce.map((c) => ({ id: c.id, name: c.name, receipts_in_pack: counts[c.id].n, ...(counts[c.id].last ? { example_seq: counts[c.id].last } : {}) }));
  const frameworks = db.frameworks.filter((f) => f.enabled).map((f) => {
    const requirements = requirementsOf(f, byId).map((q) => {
      const ids = q.controlIds.filter((id) => counts[id]);
      const n = ids.reduce((s, id) => s + counts[id].n, 0);
      return { id: q.id, title: q.title, controls: ids, receipts_in_pack: n, status: (!ids.length ? 'no mapped control' : n ? 'evidenced in this pack' : 'no receipts in this pack') as ComplianceMap['frameworks'][number]['requirements'][number]['status'] };
    });
    return { id: f.id, name: f.name, reference: f.officialRef, covered: requirements.filter((x) => x.status === 'evidenced in this pack').length, total: requirements.length, requirements };
  });
  return {
    label: 'Draft — needs legal review',
    note: 'A count of the receipts in this pack that each control counts as evidence, mapped to the requirements of the frameworks this organisation has turned on. It is not a test that a control works.',
    controls, frameworks,
  };
}

/* ── L1 auditor pack ──────────────────────────────────────── */

const L1_CLAIM = 'Sealed in a hash chain by Elan1 Govern; not externally timestamped. L1: internal evidence only.';

function l1Readme(org: string, first: number, last: number, enforcement: Enforcement, container: 'zip' | 'json' = 'zip') {
  return `README.txt - Elan1 Govern auditor pack (auditor-pack/1)

Organisation: ${org}
Records: #${first} to #${last}
Assurance level: ${LEVEL_INFO.l1.label}. ${L1_CLAIM}
Enforcement mode: ${ENFORCEMENT_LABEL[enforcement.mode]}. ${enforcement.statement}
Issuer: Elan1 Govern - ${LEGAL_ENTITY}

Files
  manifest.json        the sealed manifest: range, counts, the last receipt's hash and the SHA-256 of every file below
  keys.json            every public key, retired ones included
  receipts.jsonl       the receipts in range, one per line
  checkpoints.json     sealed chain heads in range
  summary.pdf          a summary to read and file
  compliance-map.json  frameworks, requirements and the receipts in this pack that evidence them
  README.txt           this file

File digests
  Each SHA-256 in manifest.json is taken over the file's bytes as the ZIP holds them, so
  sha256sum on a file you extract gives the same value.${container === 'json' ? `
  This copy is one JSON file holding every file; the verifier rebuilds each file's bytes
  the way the ZIP writes them and checks the same digests.` : ''}

How to verify, offline, with no account
  govern verify auditor-pack.zip --fingerprint <16 hex you obtained from the organisation>
  or: govern verify auditor-pack.zip --key org-public-key.pem
  The web verifier at /verify does the same in a browser.

Results
  0  PASS_L1_INTERNAL      intact; L1 records are internal evidence only
  0  PASS_KEY_FROM_BUNDLE  intact, but the key came from the pack: compare the fingerprint out of band
  1  FAIL_INTEGRITY        a receipt, a link, a seal or the manifest does not verify; a cut-off tail
                           no longer matches the last hash in the sealed manifest
  3  INCOMPLETE            something needed to check is missing: a file, a seal or a key; nothing
                           here is a pass or a fail
  5  USAGE                 the input is not a pack, or an option is wrong

What a pass does not show: that the underlying transactions occurred, that the rules were the right
rules, or when the records were made (nothing at L1 is externally timestamped).
Draft - needs legal review.
`;
}

function summaryPdf(db: OrgDB, a: { receipts: Receipt[]; checkpoints: OrgDB['checkpoints']; createdAt: string; createdBy: string; enforcement: Enforcement; map: ComplianceMap }) {
  const rs = a.receipts;
  const first = rs[0];
  const last = rs[rs.length - 1];
  const decisions = rs.filter((r) => r.kind === 'decision');
  const count = (d: string) => decisions.filter((r) => r.decision === d).length;
  const blocks: PdfBlock[] = [
    { kind: 'title', text: `Auditor pack - ${db.org.name}` },
    { kind: 'p', text: `auditor-pack/1 - records #${first.seq} to #${last.seq} - created ${a.createdAt.replace('T', ' ').slice(0, 16)} UTC`, muted: true },
    { kind: 'p', text: 'Draft - needs legal review.', muted: true },
    { kind: 'h', text: 'The claim' },
    { kind: 'p', text: `${db.org.name} is at ${LEVEL_INFO.l1.label}. ${L1_CLAIM} A pass shows these records were sealed by the holder of the named key, in this order, unaltered since. It does not show that the underlying transactions occurred, that the rules were right, or when the records were made.` },
    { kind: 'h', text: 'What is in the pack' },
    { kind: 'kv', rows: [
      ['Records', `${rs.length} (#${first.seq} to #${last.seq})`],
      ['First record', `${first.ts.replace('T', ' ').slice(0, 19)} UTC`],
      ['Last record', `${last.ts.replace('T', ' ').slice(0, 19)} UTC`],
      ['Last hash', last.hash],
      ['Decisions', `${decisions.length}: ${count('allow')} allowed, ${count('ask')} held for a person, ${count('refuse')} refused`],
      ['Approvals', String(rs.filter((r) => r.kind === 'approval').length)],
      ['Admin changes', String(rs.filter((r) => r.kind === 'admin').length)],
      ['Sealed checkpoints', String(a.checkpoints.length)],
      ['Keys', db.signingKeys.map((k) => `${k.kid} (${k.fingerprint}, ${k.status})`).join('; ')],
      ['Exported by', a.createdBy],
    ] },
    { kind: 'h', text: 'Enforcement mode' },
    { kind: 'p', text: `${ENFORCEMENT_LABEL[a.enforcement.mode]}. ${a.enforcement.statement}` },
    { kind: 'h', text: 'Compliance map' },
    { kind: 'p', text: a.map.note, size: 9, muted: true },
    ...(a.map.frameworks.length ? [{ kind: 'table' as const, cols: [{ title: 'Framework', width: 5 }, { title: 'Reference', width: 4 }, { title: 'Requirements evidenced in this pack', width: 4 }], rows: a.map.frameworks.map((f) => [f.name, f.reference, `${f.covered} of ${f.total}`]) }] : [{ kind: 'p' as const, text: 'No framework is turned on, so no requirement is mapped.' }]),
    { kind: 'table', cols: [{ title: 'Control', width: 1.2 }, { title: 'What it is', width: 6 }, { title: 'Receipts in pack', width: 2 }], rows: a.map.controls.map((c) => [c.id, c.name, String(c.receipts_in_pack)]) },
    { kind: 'h', text: 'Checkpoints in range' },
    ...(a.checkpoints.length ? [{ kind: 'table' as const, cols: [{ title: 'At', width: 2 }, { title: 'Head', width: 1.2 }, { title: 'Hash', width: 5 }, { title: 'Key', width: 2.4 }], rows: a.checkpoints.slice(-12).reverse().map((c) => [c.ts.replace('T', ' ').slice(0, 16), `#${c.seq}`, c.hash.slice(0, 32), c.kid]) }] : [{ kind: 'p' as const, text: 'No sealed checkpoint falls in this range. The sealed manifest still fixes the last hash.' }]),
    { kind: 'h', text: 'How to verify' },
    { kind: 'mono', text: `govern verify auditor-pack.zip --fingerprint ${db.org.keyFingerprint}` },
    { kind: 'p', text: 'Obtain the fingerprint from the organisation by a separate channel. Exit 0 (PASS_L1_INTERNAL, or PASS_KEY_FROM_BUNDLE without the fingerprint) means intact; exit 1 (FAIL_INTEGRITY) names the first broken receipt, an edited manifest or a cut-off tail; exit 3 (INCOMPLETE) means something needed to check is missing - a file, a seal or a key - so nothing is a pass or a fail; exit 5 (USAGE) means the input is not a pack, or an option is wrong.' },
  ];
  return buildPdf({ title: `Auditor pack - ${db.org.name}`, footer: `${db.org.name} - auditor-pack/1 - #${first.seq}-#${last.seq} - Draft, needs legal review`, blocks, createdAt: a.createdAt });
}

/** Build an L1 auditor pack for a range. Nothing is written: recordAuditorPack writes the export. */
export function buildAuditorPack(db: OrgDB, userId: string, fromSeq?: number, toSeq?: number, opts: ExportOptions = {}) {
  const receipts = redactErased(db, db.receipts.filter((r) => (fromSeq === undefined || r.seq >= fromSeq) && (toSeq === undefined || r.seq <= toSeq)));
  if (!receipts.length) throw new Error('No receipts in that range.');
  const seqs = new Set(receipts.map((r) => r.seq));
  const checkpoints = db.checkpoints.filter((c) => seqs.has(c.seq));
  const createdAt = new Date().toISOString();
  const enforcement = enforcementOf(db, receipts);
  const map = complianceMapOf(db, receipts);
  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  const readme = l1Readme(db.org.name, first.seq, last.seq, enforcement, opts.container ?? 'zip');
  const summary_pdf = summaryPdf(db, { receipts, checkpoints, createdAt, createdBy: userId, enforcement, map });
  // each digest is the SHA-256 of the file's bytes as written into the ZIP, so sha256sum on the extracted file matches
  const files = l1PackFiles({ public_keys: db.publicKeys, receipts, checkpoints, summary_pdf, compliance_map: map, readme });
  const members = L1_PACK_MEMBERS.map((path) => (path === 'manifest.json' ? { path, bytes: 0, sha256: 'self' } : { path, ...fileDigest(files[path] ?? '') }));
  const key = db.keys[db.keys.length - 1].key;
  const manifest: BundleManifest = {
    format: 'auditor-pack/1', issuer: `Elan1 Govern · ${LEGAL_ENTITY}`, org: db.org.name, org_id: db.org.id, created_at: createdAt, created_by: userId,
    receipts: receipts.length, record_count: receipts.length, refusal_count: receipts.filter((r) => r.decision === 'refuse').length,
    first_seq: first.seq, last_seq: last.seq, last_hash: last.hash, checkpoints: checkpoints.length,
    // records sealed by Elan1 Govern's interim chain key during a key compromise (mock/keys.ts; read first: it marks the interim keys)
    ...(unsignedIntervalsInRange(db.org.id, first.seq, last.seq).length ? { unsigned_intervals: unsignedIntervalsInRange(db.org.id, first.seq, last.seq) } : {}),
    keys: db.signingKeys.map((k) => ({ kid: k.kid, fingerprint: k.fingerprint, status: k.status, ...(k.interim ? { interim: true } : {}) })),
    assurance_levels: [{ level: 'l1' as LevelId, count: receipts.length, first_seq: first.seq, last_seq: last.seq }],
    continuity_scope: fromSeq === undefined && toSeq === undefined ? 'full_chain' : 'range',
    enforcement_mode: enforcement.mode, enforcement,
    members, digest_of: 'file', sealing_kid: key.kid, container: opts.container ?? 'zip',
    note: `Draft — needs legal review. ${L1_CLAIM}`,
  };
  const manifest_seal = signText(manifestMessage(manifest), key);
  const bundle: EvidenceBundle = { manifest, manifest_seal, public_keys: db.publicKeys, receipts, checkpoints, summary_pdf, compliance_map: map, readme };
  const json = JSON.stringify(bundle);
  const exp: AuditorPackExport = {
    id: `exp_${Date.now().toString(36)}`, ts: createdAt, by: userId, firstSeq: first.seq, lastSeq: last.seq, receipts: receipts.length, checkpoints: checkpoints.length,
    sizeKb: Math.round(json.length / 1024), format: 'auditor-pack/1', enforcement: enforcement.mode, digest: bundleDigest(bundle), container: opts.container ?? 'zip',
  };
  return { bundle, json, export: exp };
}

/** Record an export: add it to the organisation's exports and write the evidence.exported receipt. */
export function recordExport(db: OrgDB, userId: string, built: { bundle: EvidenceBundle; export: AuditorPackExport }, extra: Record<string, string | number | boolean> = {}) {
  db.exports.unshift(built.export);
  const r = append(db, { kind: 'admin', actor: userId, action: 'evidence.exported', details: {
    format: built.export.format ?? 'auditor-pack/1', receipts: built.export.receipts, first_seq: built.export.firstSeq, last_seq: built.export.lastSeq,
    enforcement: built.export.enforcement ?? 'none', digest: (built.export.digest ?? '').slice(0, 16), container: built.export.container ?? 'json', ...extra,
  } });
  built.export.seq = r.seq;
  return r;
}

/* ── Sandbox receipts ─────────────────────────────────────── */

/**
 * The demo organisations show a few calls made with the sandbox key of the agent that has one (sk_sbx_). They go
 * through the guard like any call and their receipts carry environment: 'sandbox'. Runs once per organisation.
 */
export function ensureSandboxSeed(db: OrgDB) {
  if (db.fresh) return;
  const ev = (db.evidence ??= {});
  if (ev.sandboxSeeded) return;
  ev.sandboxSeeded = true;
  if (db.receipts.some((r) => r.environment === 'sandbox')) return;
  const agent = db.agents.find((a) => a.status === 'active' && a.keys?.some((k) => k.environment === 'sandbox' && !k.revoked) && SCENARIOS[a.scenarioKey]);
  if (!agent || db.stop.active) return;
  const rand = makeRand(db.org.id.length * 7919 + 11);
  const scen = SCENARIOS[agent.scenarioKey];
  let made = 0;
  for (let i = 0; i < 40 && made < 4; i++) {
    const call = rand.weighted(scen.map((s) => [s, s.weight] as const)).make(rand, agent.slug);
    // a sandbox call never waits on a real approver: skip any call the live rulebook, quota or autonomy would hold
    if (predictDecision(db, agent, call) === 'ask') continue;
    const r = governCall(db, agent, call, { environment: 'sandbox' });
    if (r.decision === 'ask') closeSandboxHold(db, r);
    made++;
  }
}

/** The decision governCall would reach for a call now: the live rulebook, the quota history, a switched-off tool, autonomy. */
export function predictDecision(db: OrgDB, agent: Agent, call: Call): 'allow' | 'ask' | 'refuse' {
  if (db.stop.active || agent.status !== 'active') return 'refuse';
  const rb = rulebookAt(db.rulebooks.find((b) => b.id === agent.rulebookId), Date.now());
  if (!rb) return 'refuse';
  const tags = toolTagsIn(db, call.tool) ?? call.tags;
  const history = db.receipts.filter((r) => r.agent === agent.slug && r.kind === 'decision' && new Date(r.ts).getTime() >= Date.now() - 8 * D);
  const ev = evaluate(rb.rules, call.tool, call.args, tags, { history });
  let decision = ev.decision;
  const tool = db.connectors.flatMap((c) => c.tools).find((t) => t.name === call.tool);
  if (decision !== 'refuse' && tool && !tool.enabled) return 'refuse';
  if (decision !== 'refuse' && levelRankOf(db) >= 2) {
    const eff = applyAutonomy(decision, grantFor(db.platform.grants, agent.slug, call.tool), { tool: call.tool, tags, args: call.args });
    if (eff.changed && !(ev.quota && eff.decision === 'allow')) decision = eff.decision;
  }
  return decision;
}

const levelRankOf = (db: OrgDB) => ['l1', 'l2', 'l3', 'sovereign'].indexOf(levelOfOrg(db.org));

/**
 * Safety net: if a seeded sandbox call was held all the same, it is closed at once as a refusal (the way an expiry
 * closes a hold) so no real approver is ever asked about a sandbox call. The closing receipt is written too.
 */
function closeSandboxHold(db: OrgDB, r: Receipt) {
  const a = db.approvals.find((x) => x.id === r.approval?.id && x.status === 'pending');
  if (!a) return;
  a.status = 'expired';
  a.decidedAt = new Date().toISOString();
  a.decisionReason = 'A sandbox call never waits on a real approver: the hold was closed at once. Closing a hold is a refusal.';
  const c = append(db, { kind: 'approval', agent: a.agentSlug, tool: a.tool, ref_seq: a.seq, approval: { id: a.id, status: 'expired' }, decision: 'refuse', reason: a.decisionReason, outcome: { status: 'not_run' }, actor: 'system', environment: 'sandbox', details: { channel: 'sandbox' } });
  a.resultSeq = c.seq;
}

/** True for a receipt written from a sandbox key. */
export const isSandbox = (r: Pick<Receipt, 'environment'>) => r.environment === 'sandbox';

/* ── Integrity runs ───────────────────────────────────────── */

/** 02:00 IST on each night from `from` to `to` (epoch ms). */
function nightsBetween(from: number, to: number): number[] {
  const out: number[] = [];
  const d = new Date(from + 5.5 * H);
  d.setUTCHours(2, 0, 0, 0);
  let t = d.getTime() - 5.5 * H;
  if (t <= from) t += D;
  for (; t <= to; t += D) out.push(t);
  return out;
}

const nightlyCache = new Map<string, IntegrityRun[]>();

/**
 * The nightly runs: each night at 02:00 IST the run picks up at the record after the previous run's head and
 * recomputes every content hash and hash link up to the head at that moment, and checks each checkpoint against
 * the record it names. Computed from the chain itself, so the history is what a run would have found.
 */
export function nightlyRuns(db: OrgDB, now = Date.now(), nights = 30): IntegrityRun[] {
  const rs = db.receipts;
  if (!rs.length) return [];
  const key = `${db.org.id}:${rs.length}:${rs[rs.length - 1].seq}:${Math.floor((now + 3.5 * H) / D)}:${nights}`;
  const hit = nightlyCache.get(key);
  if (hit) return hit;
  const firstT = new Date(rs[0].ts).getTime();
  const all = nightsBetween(firstT, now);
  const shown = all.slice(-nights);
  const cps = new Map(db.checkpoints.map((c) => [c.seq, c]));
  let i = 0;
  // the record index at the night before the first one shown
  const before = shown.length < all.length ? all[all.length - shown.length - 1] : undefined;
  if (before !== undefined) while (i < rs.length && new Date(rs[i].ts).getTime() <= before) i++;
  const out: IntegrityRun[] = [];
  for (const t of shown) {
    const t0 = performance.now();
    const start = i;
    while (i < rs.length && new Date(rs[i].ts).getTime() <= t) i++;
    const slice = rs.slice(start, i);
    let links = 0;
    let hashes = 0;
    let checkpoints = 0;
    let brokenAt: number | undefined;
    let reason: string | undefined;
    for (let k = start; k < i; k++) {
      const r = rs[k];
      const prev = rs[k - 1];
      if (prev) {
        links++;
        if (brokenAt === undefined && (r.seq !== prev.seq + 1 || r.prev_hash !== prev.hash)) { brokenAt = r.seq; reason = r.seq !== prev.seq + 1 ? `#${prev.seq} is followed by #${r.seq}` : `#${r.seq} does not name the hash of #${prev.seq}`; }
      }
      if (!r.redacted) {
        hashes++;
        if (brokenAt === undefined && receiptHash(r) !== r.hash) { brokenAt = r.seq; reason = `#${r.seq} does not recompute to its hash`; }
      }
      const c = cps.get(r.seq);
      if (c) {
        checkpoints++;
        if (brokenAt === undefined && c.hash !== r.hash) { brokenAt = r.seq; reason = `the checkpoint at #${r.seq} names another hash`; }
      }
    }
    const head = i > 0 ? rs[i - 1].seq : rs[0].seq - 1;
    out.push({
      id: `ir_${db.org.id}_${t}`, at: new Date(t).toISOString(), kind: 'nightly', fromSeq: slice[0]?.seq ?? head + 1, toSeq: head, records: slice.length,
      checked: { links, hashes, signatures: 0, checkpoints }, result: brokenAt === undefined ? 'pass' : 'fail', brokenAt, reason, ms: Math.max(1, Math.round(performance.now() - t0)),
    });
  }
  nightlyCache.clear();
  nightlyCache.set(key, out);
  return out;
}

/** Every run, newest first: the nightly ones and those run on demand. */
export function integrityRuns(db: OrgDB, now = Date.now()): IntegrityRun[] {
  return [...nightlyRuns(db, now), ...(db.evidence?.integrityRuns ?? [])].sort((a, b) => b.at.localeCompare(a.at));
}

export interface ContinuityReport {
  runs: IntegrityRun[];
  /** contiguous coverage of the nightly runs (each starts where the previous one ended) */
  coveredFrom?: number;
  coveredTo?: number;
  gaps: { from: number; to: number }[];
  failures: IntegrityRun[];
  /** records written since the last run's head: not checked over this range yet */
  unchecked?: { from: number; to: number; count: number };
  lastRun?: IntegrityRun;
  headSeq?: number;
}

export function continuityReport(db: OrgDB, now = Date.now()): ContinuityReport {
  const runs = integrityRuns(db, now);
  const nightly = runs.filter((r) => r.kind === 'nightly').slice().reverse();
  const gaps: ContinuityReport['gaps'] = [];
  for (let k = 1; k < nightly.length; k++) {
    if (nightly[k].records && nightly[k].fromSeq > nightly[k - 1].toSeq + 1) gaps.push({ from: nightly[k - 1].toSeq + 1, to: nightly[k].fromSeq - 1 });
  }
  const covered = nightly.filter((r) => r.records > 0);
  const head = db.receipts[db.receipts.length - 1];
  const lastRun = runs[0];
  // the record after the newest run's head; a run's own receipt is written right after it and does not count
  const checkedTo = Math.max(0, ...runs.map((r) => (r.seq !== undefined ? Math.max(r.toSeq, r.seq) : r.toSeq)));
  const pending = head ? db.receipts.filter((r) => r.seq > checkedTo) : [];
  return {
    runs, gaps, failures: runs.filter((r) => r.result === 'fail'), lastRun, headSeq: head?.seq,
    coveredFrom: covered[0]?.fromSeq, coveredTo: covered[covered.length - 1]?.toSeq,
    unchecked: pending.length ? { from: pending[0].seq, to: pending[pending.length - 1].seq, count: pending.length } : undefined,
  };
}

/**
 * Run the integrity check now over the whole chain window: content hashes, links, every Ed25519 signature and
 * every checkpoint. Writes an evidence.integrity_run receipt with the result.
 */
/** What a check over the window found, when it ran off the main thread (the console runs it in the verifier's worker). */
export interface IntegrityOutcome { fromSeq: number; toSeq: number; records: number; hashes: number; signatures: number; checkpoints: number; checkpointsValid: number; brokenAt?: number; reason?: string; ms: number }

export function runIntegrityNow(orgId: string, userId: string, outcome?: IntegrityOutcome): IntegrityRun {
  const db = getDB(orgId);
  const rs = db.receipts;
  if (!rs.length) throw new Error('There are no receipts to check yet.');
  let o = outcome;
  if (o && (o.fromSeq < rs[0].seq || o.toSeq > rs[rs.length - 1].seq || o.fromSeq > o.toSeq)) throw new Error('That check does not cover records in this window.');
  if (!o) {
    const t0 = performance.now();
    const report = verifyChain(rs, db.publicKeys, db.checkpoints);
    o = {
      fromSeq: rs[0].seq, toSeq: rs[rs.length - 1].seq, records: rs.length, hashes: report.checks.filter((c) => c.hash === 'pass').length, signatures: report.checks.filter((c) => c.signature === 'pass').length,
      checkpoints: report.checkpoints.total, checkpointsValid: report.checkpoints.valid, brokenAt: report.brokenAt, reason: report.brokenReason, ms: Math.max(1, Math.round(performance.now() - t0)),
    };
  }
  const sigs = o.signatures;
  const run: IntegrityRun = {
    id: `ir_${Date.now().toString(36)}`, at: new Date().toISOString(), kind: 'on_demand', by: userId, fromSeq: o.fromSeq, toSeq: o.toSeq, records: o.records,
    checked: { links: Math.max(0, o.records - 1), hashes: o.hashes, signatures: sigs, checkpoints: o.checkpoints },
    result: o.brokenAt === undefined && o.checkpointsValid === o.checkpoints ? 'pass' : 'fail', brokenAt: o.brokenAt, reason: o.reason ?? (o.checkpointsValid !== o.checkpoints ? `${o.checkpoints - o.checkpointsValid} checkpoints do not match` : undefined), ms: o.ms,
  };
  const r = append(db, { kind: 'admin', actor: userId, action: 'evidence.integrity_run', details: { from_seq: run.fromSeq, to_seq: run.toSeq, records: run.records, signatures: sigs, checkpoints: run.checked.checkpoints, result: run.result, ...(run.brokenAt !== undefined ? { broken_at: run.brokenAt } : {}) } });
  run.seq = r.seq;
  const ev = (db.evidence ??= {});
  ev.integrityRuns = [run, ...(ev.integrityRuns ?? [])].slice(0, 50);
  return run;
}

/** The continuity report as a PDF. */
export function continuityPdf(db: OrgDB, rep: ContinuityReport, by: string) {
  const level = levelOfOrg(db.org);
  const l2 = level !== 'l1';
  const blocks: PdfBlock[] = [
    { kind: 'title', text: `Continuity report - ${db.org.name}` },
    { kind: 'p', text: `${LEVEL_INFO[level].label} - generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC by ${by}`, muted: true },
    { kind: 'p', text: 'Draft - needs legal review.', muted: true },
    { kind: 'h', text: 'Summary' },
    { kind: 'kv', rows: [
      ['Nightly runs shown', String(rep.runs.filter((r) => r.kind === 'nightly').length)],
      ['Runs on demand', String(rep.runs.filter((r) => r.kind === 'on_demand').length)],
      ['Covered without a gap', rep.coveredFrom !== undefined ? `#${rep.coveredFrom} to #${rep.coveredTo}` : 'No records in the nights shown'],
      ['Gaps between runs', rep.gaps.length ? rep.gaps.map((g) => `#${g.from}-#${g.to}`).join(', ') : 'None: each run started at the record after the previous run ended'],
      ['Failures', rep.failures.length ? rep.failures.map((f) => `${f.at.slice(0, 10)}: ${f.reason ?? `broken at #${f.brokenAt}`}`).join('; ') : 'None'],
      ['Not checked over', rep.unchecked ? `#${rep.unchecked.from} to #${rep.unchecked.to} (${rep.unchecked.count} records written since the last run)` : 'Nothing: the last run reached the head'],
    ] },
    { kind: 'p', text: `Each nightly run at 02:00 IST recomputes the content hash of every record written since the previous run, checks that each names the hash of the one before, and checks every checkpoint against the record it names. A run on demand also checks every ${l2 ? 'signature' : 'Ed25519 seal'} across the whole window. A pass shows the records are unaltered and continuous; it does not show that the underlying actions happened.`, size: 9 },
    { kind: 'h', text: 'Runs' },
    { kind: 'table', cols: [{ title: 'Run at (UTC)', width: 2.2 }, { title: 'Kind', width: 1.3 }, { title: 'Range', width: 2.2 }, { title: 'Records', width: 1 }, { title: 'Checks', width: 3 }, { title: 'Result', width: 1 }], rows: rep.runs.map((r) => [
      r.at.replace('T', ' ').slice(0, 16), r.kind === 'nightly' ? 'Nightly' : 'On demand', r.records ? `#${r.fromSeq}-#${r.toSeq}` : `none new (head #${r.toSeq})`, String(r.records),
      `${r.checked.hashes} hashes, ${r.checked.links} links, ${r.checked.checkpoints} checkpoints${r.checked.signatures ? `, ${r.checked.signatures} ${l2 ? 'signatures' : 'seals'}` : ''}`, r.result === 'pass' ? 'Pass' : `Fail at #${r.brokenAt}`,
    ]) },
  ];
  return buildPdf({ title: `Continuity report - ${db.org.name}`, footer: `${db.org.name} - continuity report - Draft, needs legal review`, blocks });
}
