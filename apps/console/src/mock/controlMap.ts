/**
 * The one control list and framework mapping every coverage figure uses: /compliance, Today, the AI system page, the
 * receipt page's "Controls" and the L1 auditor pack's compliance map. Pure: it reads only the OrgDB it is given (no
 * API, no store), so mock/db.ts, mock/evidence.ts and features/compliance/evidence.ts can all import it without a cycle.
 *
 * The base controls (EG-01 … EG-13, and EG-18 … EG-20: separation of duties, retention, role-based access) hold at
 * every level, as does erasure by salt destruction (EG-15, from L1). From L2 Attested and L3 Proven the level adds
 * controls with their own evidence (sealed and timestamped records, autonomy earned by two-person graduation,
 * verification between organisations); they map to the requirements they serve, and count only for organisations at
 * that level. Coverage = share of a framework's requirements with at least one mapped control that has live evidence.
 * It is a count of receipts, not a test that a control works.
 */
import type { Control, Framework, LevelId, Receipt, Requirement, RiskTag } from '@/types';
import { atLeast, levelOfOrg, LEVEL_INFO } from '@/lib/levels';
import { CONTROLS as BASE_CONTROLS } from './governance';
import type { OrgDB } from './db';

export interface LiveControl extends Control {
  examples: number[]; // latest matching receipt seqs, newest first
  activity: string; // console link that shows the evidence
  activityLabel: string;
  /** level the control starts at (base controls: L1) */
  level?: LevelId;
}

type Ctx = { quotaRules: Set<string>; personalRules: Set<string>; personalTools: Set<string>; sealedFrom?: number };
type Match = { pred?: (r: Receipt, c: Ctx) => boolean; activity: string; activityLabel: string };

const ALL = 'range=all';
const MEMBER_ACTIONS = /^member\.(invited|invite_accepted|invite_revoked|role_changed|removed|suspended|reinstated|jit_provisioned)$/;

export const CONTROL_MATCH: Record<string, Match> = {
  'EG-01': { pred: (r) => r.decision === 'refuse', activity: `/activity?d=refuse&${ALL}`, activityLabel: 'Refusals in Activity' },
  'EG-02': { pred: (r) => r.kind === 'approval', activity: `/activity?kind=approval&${ALL}`, activityLabel: 'Approval receipts' },
  'EG-03': { pred: () => true, activity: '/activity/chain', activityLabel: 'The chain' },
  'EG-04': { pred: (r) => r.action === 'rulebook.published', activity: `/activity?q=rulebook.published&${ALL}`, activityLabel: 'Rulebook publishes' },
  'EG-05': { pred: (r) => r.action === 'rulebook.published' && !!r.details?.reviewed_by, activity: `/activity?q=reviewed_by&${ALL}`, activityLabel: 'Reviewed publishes' },
  'EG-06': { pred: (r) => r.details?.mode === 'governed_run', activity: `/activity?q=governed_run&${ALL}`, activityLabel: 'Governed runs' },
  'EG-07': { pred: (r, c) => r.kind === 'decision' && !!r.agent && c.quotaRules.has(`${r.agent}|${r.rule_id}`), activity: `/activity?kind=decision&${ALL}`, activityLabel: 'Decisions under a quota rule' },
  'EG-08': { pred: (r, c) => r.kind === 'decision' && (String(r.details?.tags ?? '').includes('personal_data') || (!!r.tool && c.personalTools.has(r.tool)) || (!!r.agent && c.personalRules.has(`${r.agent}|${r.rule_id}`))), activity: `/activity?q=personal_data&${ALL}`, activityLabel: 'Personal-data decisions' },
  'EG-09': { activity: '/alerts', activityLabel: 'Alerts' },
  'EG-10': { pred: (r) => r.action === 'agent.paused' || !!r.action?.startsWith('stop.'), activity: '/incidents', activityLabel: 'Pauses and stops' },
  'EG-11': { pred: (r) => r.action === 'inventory.added', activity: '/inventory', activityLabel: 'AI inventory' },
  'EG-12': { pred: (r) => r.action === 'assessment.approved', activity: '/assessments?status=approved', activityLabel: 'Approved assessments' },
  'EG-13': { pred: (r) => r.action === 'evidence.exported' || r.action === 'pack.exported', activity: '/assurance/exports', activityLabel: 'Evidence exports' },
  // level controls
  'EG-14': { pred: (r, c) => c.sealedFrom !== undefined && new Date(r.ts).getTime() >= c.sealedFrom, activity: '/assurance/anchors', activityLabel: 'Timestamps and seals' },
  'EG-15': { pred: (r) => !!r.action?.startsWith('erasure.'), activity: '/records/erasure', activityLabel: 'Erasure requests' },
  'EG-16': { pred: (r) => !!r.action?.startsWith('autonomy.'), activity: '/agents/autonomy', activityLabel: 'Autonomy graduations' },
  'EG-17': { pred: (r) => !!r.action?.startsWith('counterparty.receipt.'), activity: '/assurance/counterparties', activityLabel: 'Counterparty receipts' },
  // documented controls added after the level controls (GATE-03, GATE-10, GATE-11 in the technology memorandum)
  'EG-18': { pred: (r) => (r.kind === 'approval' && !!r.approval?.approver && r.approval.self_approval !== undefined) || /same[-_]?actor/i.test(r.rule_id ?? ''), activity: `/activity?kind=approval&${ALL}`, activityLabel: 'Approvals and self-approvals' },
  'EG-19': { pred: (r) => r.action === 'retention.changed', activity: `/activity?q=retention.changed&${ALL}`, activityLabel: 'Retention changes' },
  'EG-20': { pred: (r) => !!r.action && MEMBER_ACTIONS.test(r.action), activity: `/activity?q=member.&${ALL}`, activityLabel: 'Member and role changes' },
};

/** Controls a level adds. Shown only to organisations at that level; mapped below. */
export const LEVEL_CONTROLS: (Control & { level: LevelId })[] = [
  { id: 'EG-14', level: 'l2', name: 'Records are sealed and timestamped by two authorities', description: 'Every record from the L2 boundary is sealed (Seal v6, 16 frozen fields) and its 15-minute Merkle batch is timestamped by two RFC 3161 authorities.', evidenceKind: 'Sealed receipts', evidenceCount: 0, status: 'evidenced' },
  // erasure is available from L1 (salts from the first L1 record), so its evidence counts at every level
  { id: 'EG-15', level: 'l1', name: 'Personal data can be erased without breaking the chain', description: 'Erasure destroys the salt behind a payload hash after two approvers, within 72 hours. The chain still verifies.', evidenceKind: 'Erasure requests', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-16', level: 'l3', name: 'Autonomy is earned by two-person graduation', description: 'No one sets a level. Each write type starts at A2 Propose and reaches A3 only by a graduation one person proposes and a different person approves, on the record; revoking is one press. Every step is a receipt.', evidenceKind: 'Graduations and revocations', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-17', level: 'l3', name: 'Counterparties verify receipts', description: 'Receipts are issued to and received from counterparties and verified across organisations, revealing only the fields needed.', evidenceKind: 'Receipts issued or received', evidenceCount: 0, status: 'evidenced' },
];

/**
 * Where a level control, or a base control added after EG-13 (EG-18 to EG-20), serves a framework requirement
 * (framework id → requirement id → controls). Kept here rather than in the saved frameworks so organisations saved
 * before these controls existed get the mapping too.
 */
export const LEVEL_MAP: Record<string, Record<string, string[]>> = {
  euaiact: { 'Art. 12': ['EG-14', 'EG-19'], 'Art. 14': ['EG-16', 'EG-18'] },
  iso42001: { 'A.6.2.8': ['EG-14'], '8.2': ['EG-16'], 'A.10.3': ['EG-17'], '7.5': ['EG-19'] },
  nist: { 'MANAGE 4': ['EG-14'], 'GOVERN 2': ['EG-16', 'EG-18'], 'MAP 4': ['EG-17'] },
  rbi: { 'Pillar: Assurance': ['EG-14'], 'Rec. 14': ['EG-18'] },
  hipaa: { '164.312(b)': ['EG-14'], '164.312(a)(1)': ['EG-20'] },
  soc2: { 'CC4.1': ['EG-14'], 'CC9.2': ['EG-17'], 'CC6.1': ['EG-18', 'EG-20'] },
  dpdp: { 's.8(7)': ['EG-15', 'EG-19'], 's.12': ['EG-15'] },
  gdpr: { 'Art. 32': ['EG-20'] },
};

function controlContext(d: OrgDB): Ctx {
  const quotaRules = new Set<string>();
  const personalRules = new Set<string>();
  for (const rb of d.rulebooks) for (const v of rb.versions) for (const r of v.rules) {
    if (r.quota) quotaRules.add(`${rb.slug}|${r.id}`);
    if (r.match.tag === 'personal_data' || r.when?.some((c) => c.op === 'fields_include' && JSON.stringify(c.value).includes('personal'))) personalRules.add(`${rb.slug}|${r.id}`);
  }
  const personalTools = new Set(d.connectors.flatMap((c) => c.tools).filter((t) => (t.tags as RiskTag[]).includes('personal_data')).map((t) => t.name));
  const h = d.org.levelHistory;
  const l2 = h?.find((x) => x.level !== 'l1');
  return { quotaRules, personalRules, personalTools, sealedFrom: l2 ? new Date(l2.from).getTime() : atLeast(d.org.plan, 'l2') ? new Date(d.org.createdAt).getTime() : undefined };
}

/** The controls in force at a level: the saved ones, base controls added since the organisation was saved, and the level's own. */
function controlsInForce(controls: Control[], level: LevelId): (Control & { level?: LevelId })[] {
  const base = [...controls, ...BASE_CONTROLS.filter((c) => !controls.some((x) => x.id === c.id)).map((c) => ({ ...c }))];
  return [...base, ...LEVEL_CONTROLS.filter((c) => atLeast(level, c.level) && !base.some((x) => x.id === c.id))];
}

const levelOk = (id: string, level: LevelId) => { const lc = LEVEL_CONTROLS.find((c) => c.id === id); return !lc || atLeast(level, lc.level); };

/** The EG-18 note for the level and the organisation's same-person setting (mock/approvalsExt.ts). */
function separationNote(d: OrgDB, level: LevelId, self: number): { note: string; forbidden: boolean } {
  const l2 = atLeast(level, 'l2');
  const setting = (d as OrgDB & { approvalsExt?: { sameActor?: string } }).approvalsExt?.sameActor ?? (l2 ? 'forbid' : 'flag');
  const counted = `${self === 1 ? '1 self-approval' : `${self} self-approvals`} flagged and counted.`;
  const two = 'Two different people approve an action above the two-person limit or with a wide blast radius.';
  if (setting === 'forbid') return { forbidden: true, note: `${counted} ${l2 ? `From ${LEVEL_INFO.l2.label}` : 'Here'} the same person cannot approve an action of an agent they own. ${two}` };
  return { forbidden: false, note: `${counted} ${l2 ? 'Approving an action of an agent you own is set to flagged, not forbidden.' : 'At L1 approving an action of an agent you own is allowed but flagged on the receipt; from L2 it is forbidden.'} ${two}` };
}

/** Recount each control's evidence from the live records so the numbers move with the chain. Adds the level's controls. */
export function liveControlsOf(d: OrgDB, controls: Control[], level: LevelId = levelOfOrg(d.org)): LiveControl[] {
  const rs = d.receipts;
  const ctx = controlContext(d);
  const all = controlsInForce(controls, level);
  return all.map((c) => {
    const m = CONTROL_MATCH[c.id] ?? { activity: `/activity?${ALL}`, activityLabel: 'Activity' };
    let count = c.evidenceCount;
    let last = c.lastEvidenceAt;
    const examples: number[] = [];
    if (m.pred) {
      let k = 0;
      let latest: string | undefined;
      for (let i = rs.length - 1; i >= 0; i--) {
        const r = rs[i];
        if (!m.pred(r, ctx)) continue;
        k++;
        if (!latest) latest = r.ts;
        if (examples.length < 3) examples.push(r.seq);
      }
      if (c.id === 'EG-11') { count = Math.max(d.aiSystems.length, k); last = d.aiSystems.map((s) => s.createdAt).sort().pop(); }
      else if (c.id === 'EG-12') { count = d.assessments.filter((a) => a.status === 'approved').length; last = d.assessments.map((a) => (a.status === 'approved' ? a.reviewedAt ?? '' : '')).sort().pop() || undefined; }
      // level controls count their records once each (a request, a grant, a cross-organisation receipt), not every receipt about them
      else if (c.id === 'EG-15') { const es = d.platform?.erasures ?? []; count = es.length; last = [latest ?? '', ...es.map((e) => e.executedAt ?? e.requestedAt)].sort().pop() || undefined; es.forEach((e) => { if (e.seq && examples.length < 3 && !examples.includes(e.seq)) examples.push(e.seq); }); }
      else if (c.id === 'EG-16') { const gs = (d.platform?.grants ?? []).filter((g) => g.origin !== 'start'); count = gs.length; last = [latest ?? '', ...gs.map((g) => g.revokedAt ?? g.grantedAt)].sort().pop() || undefined; }
      else if (c.id === 'EG-17') { const xs = d.platform?.crossOrg ?? []; count = xs.length; last = [latest ?? '', ...xs.map((x) => x.verification.checkedAt ?? x.issuedAt)].sort().pop() || undefined; }
      else { count = k; last = latest; }
    } else if (c.id === 'EG-09') {
      count = d.alerts.length;
      last = d.alerts.map((a) => a.createdAt).sort().pop();
      d.alerts.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).forEach((a) => a.relatedSeqs.slice(-1).forEach((s) => examples.length < 3 && examples.push(s)));
    }
    let note = c.note;
    let status = c.status;
    if (c.id === 'EG-05' && atLeast(level, 'l2')) {
      const at = d.org.levelHistory?.find((x) => x.level !== 'l1')?.from;
      note = `Dual control is enforced at ${LEVEL_INFO[level].label}${at ? ` from ${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : ''}: a version is published only after a different person approves its review.`;
      status = 'evidenced';
    }
    if (c.id === 'EG-15' && count > 0 && !rs.some((r) => r.action === 'erasure.executed') && !(d.platform?.erasures ?? []).some((e) => e.status === 'executed')) { status = 'partial'; note = 'Erasure requests are recorded; none has been executed yet.'; }
    if (c.id === 'EG-18') {
      const sep = separationNote(d, level, rs.filter((r) => r.kind === 'approval' && r.approval?.self_approval === true).length);
      note = sep.note;
      status = sep.forbidden ? 'evidenced' : 'partial';
    }
    // retention is always set (8 years at least); until someone changes it there is no receipt to count
    if (c.id === 'EG-19' && count === 0) { status = 'partial'; note = 'Retention is set to its default of at least 8 years; no change has been recorded yet.'; }
    else if (count === 0) status = 'no_evidence';
    else if (status === 'no_evidence') status = note ? 'partial' : 'evidenced';
    return { ...c, note, evidenceCount: count, lastEvidenceAt: last, status, examples, activity: m.activity, activityLabel: m.activityLabel, level: c.level === 'l1' ? undefined : c.level };
  });
}

/** The controls one receipt counts towards, with the same predicates coverage uses (receipt screens, the L1 pack). */
export function controlIdsOf(d: OrgDB, r: Receipt, level: LevelId = levelOfOrg(d.org)): string[] {
  const ctx = controlContext(d);
  return Object.entries(CONTROL_MATCH).filter(([id, m]) => m.pred && levelOk(id, level) && m.pred(r, ctx)).map(([id]) => id);
}

/** A predicate per control for counting receipts in a range (the L1 pack): EG-09 counts the alert receipts in range. */
export function receiptPredicates(d: OrgDB, level: LevelId = levelOfOrg(d.org)): Record<string, (r: Receipt) => boolean> {
  const ctx = controlContext(d);
  const out: Record<string, (r: Receipt) => boolean> = {};
  for (const [id, m] of Object.entries(CONTROL_MATCH)) {
    if (!levelOk(id, level)) continue;
    if (m.pred) { const p = m.pred; out[id] = (r) => p(r, ctx); }
    else if (id === 'EG-09') out[id] = (r) => !!r.action?.startsWith('alert.');
  }
  return out;
}

export type ReqStatus = 'covered' | 'partial' | 'unevidenced' | 'gap';

export const REQ_STATUS_LABEL: Record<ReqStatus, string> = {
  covered: 'Covered',
  partial: 'Partial evidence',
  unevidenced: 'Mapped, no evidence',
  gap: 'No mapped control',
};

/** A framework's requirements with the controls the organisation's level adds (only controls present in byId). */
export function requirementsOf(f: Framework, byId: Record<string, { id: string }>): Requirement[] {
  const extra = LEVEL_MAP[f.id];
  if (!extra) return f.requirements;
  return f.requirements.map((r) => {
    const add = (extra[r.id] ?? []).filter((id) => byId[id] && !r.controlIds.includes(id));
    return add.length ? { ...r, controlIds: [...r.controlIds, ...add] } : r;
  });
}

export function requirementStatus(r: Requirement, byId: Record<string, LiveControl>): ReqStatus {
  if (!r.controlIds.length) return 'gap';
  const cs = r.controlIds.map((id) => byId[id]).filter(Boolean);
  if (cs.some((c) => c.status === 'evidenced')) return 'covered';
  if (cs.some((c) => c.status === 'partial')) return 'partial';
  return 'unevidenced';
}

export function coverageOf(f: Framework, byId: Record<string, LiveControl>) {
  const reqs = requirementsOf(f, byId);
  const statuses = reqs.map((r) => requirementStatus(r, byId));
  const covered = statuses.filter((s) => s === 'covered').length;
  const total = reqs.length;
  return {
    covered,
    total,
    gaps: statuses.filter((s) => s === 'gap').length,
    partial: statuses.filter((s) => s === 'partial' || s === 'unevidenced').length,
    // rounded down, as specified
    share: total ? Math.floor((covered / total) * 100) / 100 : 0,
  };
}

export function indexControls(cs: LiveControl[]) {
  return Object.fromEntries(cs.map((c) => [c.id, c])) as Record<string, LiveControl>;
}

/** Each framework's coverage share, computed as /compliance computes it. */
export function frameworkShares(d: OrgDB, level: LevelId = levelOfOrg(d.org)): Record<string, number> {
  const byId = indexControls(liveControlsOf(d, d.controls, level));
  return Object.fromEntries(d.frameworks.map((f) => [f.id, coverageOf(f, byId).share]));
}
