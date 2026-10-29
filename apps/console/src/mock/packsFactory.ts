/**
 * The pack factory, per organisation: the portfolio register (candidates, admissions and rejections), the
 * gates each pack is scored on, the T1–T8 acceptance tests, the 90-day pilot, the two-way reconciliation
 * against the target system's own audit trail, the verifier-profile lifecycle (author, issuer, P1–P12,
 * withdrawn) and the profile entitlement (an order, or a clear trial at L1). Every recorded change is an
 * admin receipt on the chain. State lives on the organisation's platform state, so it is saved with it;
 * every field is optional on read because saved browser state may predate it.
 */
import type { AdmissionGate, LevelId, PackId, ProfileRuleResult, Receipt, Role, VerifierProfile } from '@/types';
import { getDB, logAdmin, touch, deriveBilling, memberRole, readOnlyOpen, type OrgDB } from './db';
import { buildEvidenceBundle, levelStart, setBundleProfileHook } from './platform';
import { userName } from './users';
import { atLeast, levelOfOrg, levelRank, LEVEL_INFO } from '@/lib/levels';
import { can } from '@/lib/permissions';
import { recordIdOf } from '@/lib/seal';
import { makeRand } from '@/lib/prng';
import { CODE_LABELS, bundleDigest, setProfileWithdrawalLookup, verifyBundle, type EvidenceBundle, type ProfileWithdrawal, type VerifyBundleResult } from '@/lib/verify6';
import { PROFILES, profileById, runProfileRules, dispositionProblems } from '@/lib/profiles';
import { CORE_CODES, RUNGS } from './devpathData';
import {
  PACKS, PACK_FACTS, PACK_FIXTURE_REFUSALS, PACK_TEMPLATE, PACK_TESTS, PACK_WRITE_TYPES, PILOT_STEPS, evaluateGates, gatesPass,
  type GateFacts, type PackTestId, type PilotStepId,
} from '@/lib/packs';

const D = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
export const PROFILE_PRICE = 300000;

/* ══ Types ═══════════════════════════════════════════════════════════════ */

export type CandidateStatus = 'live' | 'admitted' | 'awaiting_admission' | 'candidate' | 'rejected' | 'returned';

export interface PackCandidate {
  id: string;
  name: string;
  domain: string;
  facts: GateFacts;
  status: CandidateStatus;
  gates: AdmissionGate[];
  source: 'portfolio' | 'proposed';
  proposedBy?: string;
  proposedAt?: string;
  proposedSeq?: number;
  decidedBy?: string;
  decidedAt?: string;
  decidedSeq?: number;
  /** the gate a rejected candidate failed, and the sentence — "not softened, parked or renamed" */
  failedGates?: string[];
  sentence?: string;
  revisit?: string;
  /** named on the day of admission: never the same person as the profile author */
  team?: { declarationOwner: string; profileAuthor: string; profileCertifier: string };
  goLive?: string;
  note?: string;
}

export interface PilotRecord {
  packId: PackId;
  customer: string;
  auditor: { name: string; firm: string };
  startedAt: string;
  startedBy: string;
  startLevel: LevelId;
  startSeq?: number;
  necessity?: { questions: string[]; statement: string; notMeasurable: { clause: string; reason: string; wouldChangeIf: string }[]; at: string; by: string; seq?: number };
  selfExport?: { at: string; by: string; help: boolean; note: string; receipts: number; firstSeq: number; lastSeq: number; exportSeq?: number; seq?: number };
  /** day 77: the verifier run on the customer's own day-76 bundle (its digest matches the export receipt), then on a tampered copy of it */
  airGap?: { at: string; by: string; goodCode: string; goodExit: number; tamperedCode: string; tamperedExit: number; tamperedAt?: string; seq?: number; bundleDigest?: string; exportSeq?: number; records?: number; fileName?: string };
  verdict?: { at: string; by: string; auditor: string; outcome: 'relies' | 'relies_with_limits' | 'does_not_rely'; words: string; seq?: number };
  gd?: { at: string; by: string; answer: 'yes' | 'no'; note: string; seq?: number };
  status: 'running' | 'closed' | 'stopped';
  stoppedReason?: string;
  stoppedAt?: string;
  /** steps recorded before their planned day, with the reason given (the step is marked early) */
  early?: Partial<Record<PilotStepId, { day: number; reason: string }>>;
}

export interface ReconRow { key: string; recordId: string; type: string; at: string; by: string; seq?: number }

export interface Reconciliation {
  id: string;
  packId: PackId;
  at: string;
  by: string;
  source: 'connector' | 'upload';
  target: string;
  from: string;
  to: string;
  chainCommitted: number;
  targetChanges: number;
  matched: number;
  targetOnly: ReconRow[];
  chainOnly: ReconRow[];
  explained: Record<string, { by: string; at: string; note: string; seq?: number }>;
  seq?: number;
}

export interface ConformanceResult { id: string; title: string; state: 'pass' | 'fail' | 'not_run' | 'not_applicable'; detail: string }

interface ProfileOverlay {
  status?: VerifierProfile['status'];
  author?: string;
  submittedAt?: string;
  submittedSeq?: number;
  certifier?: string;
  certifiedAt?: string;
  certifiedSeq?: number;
  secondReader?: { by: string; at: string; statement: string; seq?: number };
  fixtures?: { at: string; by: string; range: string; good: string; tampered: string; nonconforming: string; incomplete: string; goodExit: number; tamperedExit: number; nonconformingExit: number; incompleteExit: number; seq?: number };
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawnReason?: string;
  withdrawnSeq?: number;
}

export interface PackTestResult { id: PackTestId; title: string; passesWhen: string; state: 'pass' | 'fail' | 'not_applicable' | 'not_run'; detail: string }
export interface PackTestRun { at: string; by: string; results: PackTestResult[]; seq?: number }

interface FactoryState {
  candidates: PackCandidate[];
  profiles: Record<string, ProfileOverlay>;
  pilots: Partial<Record<PackId, PilotRecord>>;
  recons: Reconciliation[];
  drills: Partial<Record<PackId, Record<string, { at: string; by: string; note: string; seq?: number }>>>;
  readings: Partial<Record<PackId, { at: string; by: string; auditor: string; statement: string; seq?: number }>>;
  testRuns: Partial<Record<PackId, PackTestRun>>;
  removed: { id: PackId; at: string; by: string; reason: string; seq: number; profileCancelled: boolean; installedAt?: string; billedTo?: string }[];
  /** earlier pilots of a pack, kept for ever when a new pilot starts (block 4 keeps their evidence) */
  pilotHistory?: Partial<Record<PackId, PilotRecord[]>>;
  seeded?: boolean;
  ordersSeeded?: boolean;
  /** the seeded L1 pilots sit on a dry-run install made before day 0 */
  installsAligned?: boolean;
}

type WithFactory = { packFactory?: FactoryState };

function factory(db: OrgDB): FactoryState {
  const p = db.platform as unknown as WithFactory;
  if (!p.packFactory) p.packFactory = { candidates: [], profiles: {}, pilots: {}, recons: [], drills: {}, readings: {}, testRuns: {}, removed: [] };
  const f = p.packFactory;
  f.candidates ??= []; f.profiles ??= {}; f.pilots ??= {}; f.recons ??= []; f.drills ??= {}; f.readings ??= {}; f.testRuns ??= {}; f.removed ??= [];
  return f;
}

/* ══ People and roles ════════════════════════════════════════════════════ */

const roleOf = (orgId: string, userId?: string): Role | undefined => memberRole(orgId, userId);

/**
 * The pack-pilot steps an auditor may record on the client's chain: only those the Information Memorandum's 90-day
 * pilot (journey J9) gives to the auditor by name — day 0, the auditor's necessity statement; day 77, the auditor's
 * air-gapped verifier run; day 80, the auditor's written verdict. Every other step (the day-76 self-export, the
 * reconciliation and its explanations, reversal drills, the T8 reading, the acceptance tests, the G-D answer) is
 * recorded by an owner or an admin. An auditor's integrity run is a read-only check (api.runIntegrity).
 */
export const AUDITOR_PILOT_STEPS = ['necessity', 'air_gap', 'verdict'] as const;

function requireRoles(orgId: string, userId: string | undefined, roles: Role[], what: string): Role {
  const r = roleOf(orgId, userId);
  if (!r || !roles.includes(r)) {
    const names = roles.map((x) => ({ owner: 'owners', admin: 'admins', auditor: 'auditors', approver: 'approvers', viewer: 'viewers' })[x]);
    throw new Error(`${what} — ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]} can do this; your role cannot.`);
  }
  return r;
}

const ownerOf = (db: OrgDB) => db.members.find((m) => m.role === 'owner' && m.status === 'active')?.userId ?? db.members[0]?.userId ?? 'system';
const adminOf = (db: OrgDB) => db.members.find((m) => m.role === 'admin' && m.status === 'active')?.userId;
const auditorOf = (db: OrgDB) => db.members.find((m) => m.role === 'auditor')?.userId;

const minLen = (s: string | undefined, n: number, what: string) => { if ((s ?? '').trim().length < n) throw new Error(`${what} needs at least ${n} characters.`); };

/* ══ The portfolio register ══════════════════════════════════════════════ */

const fact = (o: Partial<GateFacts> & { hook: GateFacts['hook'] }): GateFacts => ({
  auditor: { role: '', obliged: false, callable: false }, writeTypes: [], evidence: { ownLine: 'no', note: '' }, writePath: { kind: 'owns', note: '' }, ...o,
});

/** The register as written in E18 §02 and the Technology Memorandum §13.2: three live packs, two candidates re-scored from the earlier portfolio, eight rejections. */
const PORTFOLIO: Omit<PackCandidate, 'gates'>[] = [
  ...PACKS.map((p): Omit<PackCandidate, 'gates'> => ({ id: p.id, name: p.name, domain: PACK_TEMPLATE[p.id].domain, facts: PACK_FACTS[p.id], status: 'live', source: 'portfolio', goLive: PACK_TEMPLATE[p.id].goLive, decidedAt: '2026-09-23T06:30:00Z' })),
  {
    id: 'close1', name: 'close1', domain: 'Month-end close: accruals, reversals and period locks posted by agents, and the evidence that each passed stated rules.', source: 'portfolio', status: 'awaiting_admission',
    facts: {
      hook: { instrument: 'Companies (Accounts) Rules — proviso to Rule 3(1), applied to period-close entries', issuer: 'Ministry of Corporate Affairs', date: '2023-04-01', kind: 'regulation' },
      auditor: { role: 'Statutory auditor', organisation: 'the same Rule 11(g) report as ledger1', obliged: true, callable: true },
      writeTypes: [{ name: 'accrual.post', reversibility: 'reversible' }, { name: 'accrual.reverse', reversibility: 'reversible' }, { name: 'period.lock', reversibility: 'irreversible_declared' }],
      evidence: { ownLine: 'provisional', budgetLine: 'Finance operations', note: 'A close pack the controller hands to the auditor at year end.' },
      writePath: { kind: 'owns', note: 'Close entries post through the same governed route as ledger1.' },
    },
    note: 'Re-scored from the earlier portfolio of ten packs.',
  },
  {
    id: 'gxp1', name: 'gxp1', domain: 'Changes to GxP records in manufacturing and laboratory systems, and the evidence each one was authorised.', source: 'portfolio', status: 'candidate',
    facts: {
      hook: { instrument: 'Schedule M (revised) — Drugs Rules, 1945', issuer: 'CDSCO', date: '2024-12-28', kind: 'regulation' },
      auditor: { role: 'Drug inspector and the QA head', obliged: true, callable: true },
      writeTypes: [{ name: 'batch_record.update', reversibility: 'unclear' }, { name: 'deviation.close', reversibility: 'irreversible_declared' }],
      evidence: { ownLine: 'probably', note: 'Quality teams might pay for it separately from the validation work.' },
      writePath: { kind: 'reads_log', note: 'The batch records live in the MES vendor’s system; the first design reads its audit log.' },
    },
    note: 'Re-scored from the earlier portfolio of ten packs.',
  },
  ...([
    ['agri1', 'Subsidy and procurement records for agricultural co-operatives.', 'G-B', 'Subsidy audits are annual and on paper.', 'An auditor who asks for per-action evidence.',
      fact({ hook: { instrument: 'State subsidy scheme guidelines', date: '2024-04-01', kind: 'regulation' }, auditor: { role: 'Annual subsidy audit', obliged: false, callable: false }, writeTypes: [{ name: 'claim.submit', reversibility: 'reversible' }], evidence: { ownLine: 'no', note: 'Nobody asks for it.' }, writePath: { kind: 'owns', note: 'Claims could be raised through the governed route.' } })],
    ['legal1', 'Matter management for law firms and in-house legal teams.', 'G-E', 'The matter lives in someone else’s document system.', 'A matter system that writes through us.',
      fact({ hook: { instrument: 'Bar Council rules on client records', date: '1975-01-01', kind: 'regulation' }, auditor: { role: 'Bar Council', obliged: true, callable: true }, writeTypes: [{ name: 'matter.update', reversibility: 'reversible' }], evidence: { ownLine: 'yes', note: 'Firms pay for matter evidence.' }, writePath: { kind: 'beside', note: 'The matter lives in someone else’s document system.' } })],
    ['energy1', 'Dispatch and metering writes for power producers.', 'G-E', 'The write path belongs to SCADA vendors.', 'A grid regulator requires per-action evidence and a path exists for us to be in the write path rather than beside it.',
      fact({ hook: { instrument: 'CEA grid standards', date: '2010-06-01', kind: 'regulation' }, auditor: { role: 'Grid regulator', obliged: true, callable: true }, writeTypes: [{ name: 'dispatch.set', reversibility: 'irreversible_declared' }], evidence: { ownLine: 'yes', note: 'Producers pay for dispatch evidence.' }, writePath: { kind: 'beside', note: 'The write path belongs to SCADA vendors.' } })],
    ['public1', 'Procurement writes for public-sector buyers.', 'G-A, G-D', 'The procurement cycle outlasts the runway.', 'A dated mandate with a budget line of its own.',
      fact({ hook: { instrument: 'Direction of travel in public procurement', kind: 'principle' }, auditor: { role: 'CAG audit', obliged: true, callable: true }, writeTypes: [{ name: 'tender.award', reversibility: 'irreversible_declared' }], evidence: { ownLine: 'no', note: 'No buyer for the evidence on its own line inside the runway.' }, writePath: { kind: 'owns', note: 'Awards could run through the governed route.' } })],
    ['edu1', 'Admissions and grading writes in education.', 'G-D', 'No buyer for evidence on its own line.', 'A regulator or accreditor that buys evidence separately.',
      fact({ hook: { instrument: 'UGC regulations on examinations', date: '2023-07-01', kind: 'regulation' }, auditor: { role: 'University examination board', obliged: true, callable: true }, writeTypes: [{ name: 'grade.submit', reversibility: 'reversible' }], evidence: { ownLine: 'no', note: 'No buyer for evidence on its own line.' }, writePath: { kind: 'owns', note: 'Grades could be submitted through the governed route.' } })],
    ['retail1', 'Price and promotion changes in retail.', 'G-B', 'Reversible, low stakes, nobody audits a price change.', 'A consumer-protection rule that obliges somebody to ask for price-change records.',
      fact({ hook: { instrument: 'Legal Metrology (Packaged Commodities) Rules', date: '2011-04-01', kind: 'regulation' }, auditor: { role: 'Nobody audits a price change', obliged: false, callable: false }, writeTypes: [{ name: 'price.update', reversibility: 'reversible' }], evidence: { ownLine: 'no', note: 'Low stakes.' }, writePath: { kind: 'owns', note: 'Prices could be changed through the governed route.' } })],
    ['hr1', 'Hiring and HR record changes.', 'G-A', 'Overlaps hire1 without a separable dated hook.', 'A dated hook that hire1 does not already carry.',
      fact({ hook: { instrument: 'Fair hiring practice', kind: 'principle' }, auditor: { role: 'Internal audit', obliged: true, callable: true }, writeTypes: [{ name: 'offer.issue', reversibility: 'reversible' }], evidence: { ownLine: 'probably', note: 'Some buyers might.' }, writePath: { kind: 'owns', note: 'Offers could be issued through the governed route.' } })],
    ['governance1', 'A general AI governance product.', 'G-E', 'Fails on every deal, because a general governance product is definitionally outside the write path.', 'None: this is the product most of the market sells.',
      fact({ hook: { instrument: 'AI governance frameworks in general', kind: 'principle' }, auditor: { role: 'Whoever asks', obliged: false, callable: false }, writeTypes: [], evidence: { ownLine: 'probably', note: 'Buyers say they want it.' }, writePath: { kind: 'reads_log', note: 'Observes other systems’ activity.' } })],
  ] as const).map(([id, domain, failed, sentence, revisit, facts]): Omit<PackCandidate, 'gates'> => ({
    id, name: id === 'governance1' ? 'a general AI governance product' : id, domain, facts, status: 'rejected', source: 'portfolio', failedGates: failed.split(', '), sentence, revisit, decidedAt: '2026-09-23T06:30:00Z',
  })),
];

/** The register as this organisation sees it: the portfolio, its own proposals and decisions, and each live pack re-scored on its pilot. */
export function portfolio(orgId: string): PackCandidate[] {
  const db = getDB(orgId);
  const st = factory(db);
  const installedIds = new Set(db.platform.packs.map((p) => p.id));
  const out = PORTFOLIO.map((c) => {
    const over = st.candidates.find((x) => x.id === c.id);
    const base: PackCandidate = { ...c, ...(over ?? {}), facts: over?.facts ?? c.facts, gates: [] };
    if (PACKS.some((p) => p.id === c.id)) {
      base.gates = packGates(orgId, c.id as PackId);
      // a live pack whose pilot answered "no" to G-D goes back to the register, whatever has been built
      const pilot = answeredPilot(db, c.id as PackId);
      if (pilot?.gd?.answer === 'no') { base.status = 'returned'; base.sentence = `G-D failed in the pilot: ${pilot.gd.note}`; base.failedGates = ['G-D']; }
      base.note = installedIds.has(c.id as PackId) ? 'Installed in this organisation.' : undefined;
    } else base.gates = evaluateGates(base.facts);
    if (!base.proposedBy && c.status !== 'live' && c.status !== 'rejected') base.proposedBy = adminOf(db) ?? ownerOf(db);
    return base;
  });
  const own = st.candidates.filter((x) => !PORTFOLIO.some((c) => c.id === x.id)).map((x) => ({ ...x, gates: evaluateGates(x.facts) }));
  return [...out, ...own];
}

/** The pilot whose day-85 answer scores G-D: the latest answered one, the current pilot or an earlier one (kept for ever). */
export function answeredPilot(db: OrgDB, packId: PackId): PilotRecord | undefined {
  const st = factory(db);
  const all = [...(st.pilotHistory?.[packId] ?? []), ...(st.pilots[packId] ? [st.pilots[packId]!] : [])].filter((p) => p.gd);
  return all.sort((a, b) => a.gd!.at.localeCompare(b.gd!.at))[all.length - 1];
}

/** The five gates for a live pack in this organisation: G-D follows the latest pilot's day-85 answer. */
export function packGates(orgId: string, packId: PackId): AdmissionGate[] {
  const db = getDB(orgId);
  const pilot = answeredPilot(db, packId);
  const f = PACK_FACTS[packId];
  if (pilot?.gd) {
    const day = Math.max(0, Math.floor((new Date(pilot.gd.at).getTime() - new Date(pilot.startedAt).getTime()) / D));
    return evaluateGates({ ...f, evidence: { ...f.evidence, ownLine: pilot.gd.answer === 'yes' ? 'yes' : 'no', note: pilot.gd.answer === 'yes' ? `Answered yes on day ${day} of the pilot: “${pilot.gd.note}”` : `Answered no on day ${day} of the pilot: “${pilot.gd.note}”` } });
  }
  return evaluateGates(f);
}

export interface CandidateInput {
  name: string;
  domain: string;
  facts: GateFacts;
}

export function proposeCandidate(orgId: string, input: CandidateInput, userId: string): PackCandidate {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Proposing a pack');
  const name = input.name.trim();
  if (!/^[a-z][a-z0-9]{2,15}1$/.test(name)) throw new Error('A pack id is lowercase letters and digits, 4 to 17 characters, ending in 1 (for example close1).');
  if (portfolio(orgId).some((c) => c.id === name)) throw new Error(`${name} is already in the portfolio register.`);
  minLen(input.domain, 20, 'The domain sentence');
  const gates = evaluateGates(input.facts);
  const failed = gates.filter((g) => g.state === 'not_met').map((g) => g.id);
  const r = logAdmin(orgId, userId, 'pack.candidate_proposed', { candidate: name, gates_met: gates.filter((g) => g.state !== 'not_met').map((g) => g.id).join(','), gates_failed: failed.join(',') || 'none' });
  const c: PackCandidate = { id: name, name, domain: input.domain.trim(), facts: input.facts, status: failed.length ? 'candidate' : 'awaiting_admission', gates, source: 'proposed', proposedBy: userId, proposedAt: r.ts, proposedSeq: r.seq };
  factory(db).candidates.push(c);
  touch(orgId, 'pack');
  return c;
}

/** Admit a candidate to the build queue: a governed write under dual control. The proposer cannot admit their own candidate. */
export function admitCandidate(orgId: string, id: string, userId: string, team: { declarationOwner: string; profileAuthor: string; profileCertifier: string }, note: string): PackCandidate {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Admitting a pack');
  const c = portfolio(orgId).find((x) => x.id === id);
  if (!c) throw new Error('No such candidate.');
  if (c.status !== 'awaiting_admission') throw new Error(`${c.name} is ${c.status === 'candidate' ? 'failing a gate and cannot be admitted' : 'not waiting for admission'}.`);
  if (c.proposedBy === userId) throw new Error(`Dual control: you proposed ${c.name}, so a different owner or admin must admit it.`);
  if (!gatesPass(c.gates)) throw new Error('Every gate must pass before a pack is admitted. A gate scored “probably” is scored fail.');
  if (!team.declarationOwner || !team.profileAuthor || !team.profileCertifier) throw new Error('Name the declaration owner, the profile author and the profile issuer on the day of admission.');
  if (team.profileAuthor === team.profileCertifier) throw new Error('The profile issuer is never the profile author. Name two different people.');
  const r = logAdmin(orgId, userId, 'pack.candidate_admitted', { candidate: c.id, proposed_by: c.proposedBy ?? '', declaration_owner: team.declarationOwner, profile_author: team.profileAuthor, profile_issuer: team.profileCertifier, dual_control: true, note: note.trim() });
  const st = factory(db);
  const next: PackCandidate = { ...c, status: 'admitted', decidedBy: userId, decidedAt: r.ts, decidedSeq: r.seq, team, note: note.trim() || c.note };
  st.candidates = [...st.candidates.filter((x) => x.id !== id), next];
  touch(orgId, 'pack');
  return next;
}

/** Reject a candidate into the register by name, with the gate it failed and the sentence. */
export function rejectCandidate(orgId: string, id: string, userId: string, sentence: string, revisit: string): PackCandidate {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Rejecting a pack');
  const c = portfolio(orgId).find((x) => x.id === id);
  if (!c) throw new Error('No such candidate.');
  if (c.status !== 'candidate' && c.status !== 'awaiting_admission') throw new Error(`${c.name} is not an open candidate.`);
  minLen(sentence, 12, 'The sentence');
  const failed = c.gates.filter((g) => g.state === 'not_met').map((g) => g.id);
  const r = logAdmin(orgId, userId, 'pack.candidate_rejected', { candidate: c.id, failed_gates: failed.join(',') || 'none', sentence: sentence.trim() });
  const st = factory(db);
  const next: PackCandidate = { ...c, status: 'rejected', decidedBy: userId, decidedAt: r.ts, decidedSeq: r.seq, failedGates: failed, sentence: sentence.trim(), revisit: revisit.trim() || undefined };
  st.candidates = [...st.candidates.filter((x) => x.id !== id), next];
  touch(orgId, 'pack');
  return next;
}

/* ══ Profile orders and entitlement ══════════════════════════════════════ */

export interface ProfileOrderInfo { seq: number; at: string; by: string }

/** Active verifier-profile orders, from the billing.addon_ordered / addon_cancelled receipts (the same rule as the meter). */
export function activeProfileOrders(db: OrgDB): Map<string, ProfileOrderInfo> {
  const m = new Map<string, ProfileOrderInfo>();
  for (const r of db.receipts) {
    if (r.details?.addon !== 'profile') continue;
    const id = String(r.details.profile);
    if (r.action === 'billing.addon_ordered') m.set(id, { seq: r.seq, at: r.ts, by: r.actor ?? '' });
    else if (r.action === 'billing.addon_cancelled') m.delete(id);
  }
  return m;
}

export interface Entitlement {
  level: LevelId;
  ordered: boolean;
  order?: ProfileOrderInfo;
  /** L1: every profile may be run as a preview, not recorded and not claimable */
  trial: boolean;
  withdrawn: boolean;
  /** issued (certified) in this organisation: only an issued profile is ordered or claimed */
  issued?: boolean;
  /** L2+: a draft runs as a preview, not recorded, and is never ordered or claimed */
  preview?: boolean;
  canRun: boolean;
  canClaim: boolean;
  why?: string;
}

const dayText = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function entitlement(orgId: string, profileId: string): Entitlement {
  const db = getDB(orgId);
  const level = levelOfOrg(db.org);
  const order = activeProfileOrders(db).get(profileId);
  const status = profileStatus(db, profileId);
  const withdrawn = status === 'withdrawn';
  const issued = status === 'certified';
  if (withdrawn) {
    const ov = factory(db).profiles[profileId];
    return { level, ordered: !!order, order, trial: false, withdrawn, issued: false, canRun: false, canClaim: false, why: `This profile was withdrawn${ov?.withdrawnAt ? ` on ${dayText(ov.withdrawnAt)}` : ''}: it can no longer be run, ordered or claimed. The verifier reports a bundle that already claims it with the withdrawal date.${order ? ' Its order is still open and is billed until it is cancelled — cancel it so it stops at the end of this month.' : ''}` };
  }
  if (!atLeast(level, 'l2')) return { level, ordered: !!order, order, trial: true, withdrawn, issued, canRun: true, canClaim: false, why: `At ${LEVEL_INFO.l1.label} a profile runs as a trial preview — not recorded and not claimable in an export. Ordering and claiming start at ${LEVEL_INFO.l2.label}${issued ? '' : ', and only once the profile is issued'}.` };
  if (!issued) return { level, ordered: !!order, order, trial: false, withdrawn, issued, preview: true, canRun: true, canClaim: false, why: `This profile is a ${status === 'superseded' ? 'superseded version' : 'draft'}, not issued: it runs as a preview, not recorded, and it is not ordered or claimed in a bundle until a second person issues it after P1–P12 pass.` };
  if (!order) return { level, ordered: false, trial: false, withdrawn, issued, canRun: false, canClaim: false, why: 'Order this verifier profile (₹3,00,000 a year, its own line) before it is run against the chain or claimed in a bundle.' };
  return { level, ordered: true, order, trial: false, withdrawn, issued, canRun: true, canClaim: true };
}

/** Before a run: the role check, the order (or the L1 trial), and whether the run is recorded. Returns the user to record the run as, or undefined (not recorded). */
export function guardRun(orgId: string, profileId: string, userId?: string): string | undefined {
  if (!profileById(profileId)) throw new Error(`No verifier profile called ${profileId}.`);
  const e = entitlement(orgId, profileId);
  if (!e.canRun) throw new Error(e.why ?? 'This profile cannot be run.');
  if (e.trial || e.preview) return undefined; // L1 trials and draft previews are never recorded
  if (!userId) return undefined;
  const role = roleOf(orgId, userId);
  if (!can(role, 'evidence.export')) throw new Error('Running a profile against the chain is recorded — owners, admins and auditors can run it; your role can read the results.');
  // auditors are read-only on the client's chain: their run is shown to them and nothing is written
  if (role === 'auditor') return undefined;
  return userId;
}

/** Before an export that claims a profile: L2+, ordered and not withdrawn. */
export function guardClaim(orgId: string, profileId?: string) {
  if (!profileId || profileId === 'none') return;
  const e = entitlement(orgId, profileId);
  if (!e.canClaim) throw new Error(e.why ?? 'This profile cannot be claimed.');
}

export function orderProfile(orgId: string, profileId: string, userId: string) {
  const db = getDB(orgId);
  if (!profileById(profileId)) throw new Error('No such verifier profile.');
  if (!atLeast(levelOfOrg(db.org), 'l2')) throw new Error(`Verifier profiles are ordered from ${LEVEL_INFO.l2.label}. At ${LEVEL_INFO.l1.label} every profile runs as a trial preview.`);
  if (!can(roleOf(orgId, userId), 'billing.manage')) throw new Error('Owners order add-ons; your role cannot.');
  if (profileStatus(db, profileId) === 'withdrawn') throw new Error('A withdrawn profile cannot be ordered.');
  if (profileStatus(db, profileId) !== 'certified') throw new Error('Only an issued profile is ordered. This one is not issued yet: a second person issues it once P1–P12 pass.');
  if (activeProfileOrders(db).has(profileId)) throw new Error('This profile is already ordered.');
  const r = logAdmin(orgId, userId, 'billing.addon_ordered', { addon: 'profile', profile: profileId, price_per_year: PROFILE_PRICE });
  deriveBilling(db);
  touch(orgId, 'billing');
  return { seq: r.seq };
}

export function cancelProfileOrder(orgId: string, profileId: string, userId: string) {
  const db = getDB(orgId);
  if (!can(roleOf(orgId, userId), 'billing.manage')) throw new Error('Owners cancel add-ons; your role cannot.');
  if (!activeProfileOrders(db).has(profileId)) throw new Error('This profile is not ordered.');
  const r = logAdmin(orgId, userId, 'billing.addon_cancelled', { addon: 'profile', profile: profileId, price_per_year: PROFILE_PRICE });
  deriveBilling(db);
  touch(orgId, 'billing');
  return { seq: r.seq };
}

/* ══ Uninstall ═══════════════════════════════════════════════════════════ */

/**
 * One rule for every add-on that stops (a pack removed, a profile order cancelled, a profile withdrawn): it is billed
 * to the end of the month it stops in, and not from the next month. The meter applies the same rule (billing/chainMeter.ts).
 */
export const ADDON_STOP_RULE = 'billed to the end of this month, and not from next month';

/** The last instant billed for an add-on stopped at `ts`: the end of that calendar month (IST, as the invoices are cut). */
export function monthEndIso(ts: string) {
  const ist = new Date(new Date(ts).getTime() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - 5.5 * 3_600_000 - 1).toISOString();
}

/** Remove a pack: its declaration stops running, its export stops, and it is billed to the end of this month only. */
export function uninstallPack(orgId: string, packId: PackId, userId: string, reason: string, cancelProfile: boolean) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Removing a pack');
  const inst = db.platform.packs.find((x) => x.id === packId);
  if (!inst) throw new Error(`${packId} is not installed.`);
  minLen(reason, 8, 'The reason');
  const pk = PACKS.find((p) => p.id === packId)!;
  const st = factory(db);
  const pilot = st.pilots[packId];
  if (pilot?.status === 'running') throw new Error(`The ${packId} pilot is still running. Close or stop it before removing the pack.`);
  if (cancelProfile && activeProfileOrders(db).has(pk.profileId) && !can(roleOf(orgId, userId), 'billing.manage')) throw new Error('Only an owner can cancel the verifier profile order. Remove the pack without cancelling it, or ask an owner.');
  const live = atLeast(levelOfOrg(db.org), 'l2');
  db.platform.packs = db.platform.packs.filter((x) => x.id !== packId);
  const r = logAdmin(orgId, userId, 'pack.uninstalled', { pack: packId, installed_at: inst.installedAt.slice(0, 10), mode: live ? 'live' : 'dry_run', billing: live ? 'last_billed_this_month' : 'never_billed', reason: reason.trim() });
  let profileCancelled = false;
  if (cancelProfile && activeProfileOrders(db).has(pk.profileId)) {
    logAdmin(orgId, userId, 'billing.addon_cancelled', { addon: 'profile', profile: pk.profileId, price_per_year: PROFILE_PRICE, with_pack: packId });
    profileCancelled = true;
  }
  st.removed.push({ id: packId, at: r.ts, by: userId, reason: reason.trim(), seq: r.seq, profileCancelled, installedAt: inst.installedAt, billedTo: live ? monthEndIso(r.ts) : undefined });
  deriveBilling(db);
  touch(orgId, 'pack');
  return { seq: r.seq, profileCancelled };
}

export const removedPacks = (orgId: string) => [...factory(getDB(orgId)).removed];

/* ══ Profiles: author, issuer, P1–P12, withdrawn ═════════════════════════ */

function profileStatus(db: OrgDB, profileId: string): VerifierProfile['status'] {
  return factory(db).profiles[profileId]?.status ?? profileById(profileId)?.status ?? 'draft';
}

const KNOWN_FIELDS = ['seq', 'ts', 'org', 'kind', 'agent', 'tool', 'args', 'args_summary', 'args_hash', 'decision', 'rule_id', 'reason', 'rulebook', 'approval', 'ref_seq', 'actor', 'action', 'details', 'prev_hash', 'hash', 'sig', 'kid'];
const resolves = (f: string) => KNOWN_FIELDS.includes(f.split('.')[0]);

export const CONFORMANCE_TESTS = [
  { id: 'P1', title: 'Clause coverage', passesWhen: 'Every clause has a check; every check serves a clause.' },
  { id: 'P2', title: 'Name resolution', passesWhen: 'Every field named resolves against the record format.' },
  { id: 'P3', title: 'Known-good', passesWhen: 'The reference good bundle exits 0 PASS.' },
  { id: 'P4', title: 'Known-tampered', passesWhen: 'A tampered bundle is rejected, naming record and field.' },
  { id: 'P5', title: 'Known-nonconforming', passesWhen: 'Sound integrity with a rule broken exits 2 — never 1.' },
  { id: 'P6', title: 'Incomplete', passesWhen: 'A missing member exits 3 — never 2.' },
  { id: 'P7', title: 'Erasure wording', passesWhen: 'A destroyed salt reads “chain intact, payload unbound”; the word FAIL appears nowhere.' },
  { id: 'P8', title: 'L1 dry run', passesWhen: 'Checks that need L2 evidence read not applicable at assurance level 1 — never a silent pass, never a fail.' },
  { id: 'P9', title: 'Scope printing', passesWhen: 'A partial-scope run prints the range and the count.' },
  { id: 'P10', title: 'Limits statement', passesWhen: 'Present, over 200 characters, and not copied from another profile.' },
  { id: 'P11', title: 'Second reader', passesWhen: 'Someone who did not author it reads the report and states what it does not prove.' },
  { id: 'P12', title: 'Offline', passesWhen: 'Completes with no network; the verifier makes no call.' },
] as const;

const SEEDED_FIXTURES = (p: VerifierProfile) => `against fixture set fx-${p.id}-${p.version}, ${new Date(p.certifiedAt ?? '2026-09-23').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

function fixtureLabel(code: string, exit: number) { return `exit ${exit} ${code}`; }

/** Run P1–P12 for a profile in this organisation. P3–P6 read the last fixture run (or, for an issued version, the result it was issued with). */
export function conformance(orgId: string, profileId: string): ConformanceResult[] {
  const db = getDB(orgId);
  const base = profileById(profileId);
  if (!base) throw new Error('No such verifier profile.');
  const p = decorateProfile(orgId, base);
  const ov = factory(db).profiles[profileId] ?? {};
  const issuedSeed = base.status === 'certified' && !ov.fixtures;
  const sample = db.receipts.slice(-200);
  const ctx = (level: LevelId) => ({
    receipts: sample, checkpoints: db.checkpoints.filter((c) => c.seq >= (sample[0]?.seq ?? 0)), level, wormRetentionYears: atLeast(level, 'l2') ? 8 : 0,
    erasures: db.platform.erasures, agents: db.agents, aiSystems: db.aiSystems, assessments: db.assessments,
  });
  const at2 = runProfileRules(p, ctx('l2'));
  const at1 = runProfileRules(p, ctx('l1'));
  const out: ConformanceResult[] = [];
  const add = (id: string, state: ConformanceResult['state'], detail: string) => out.push({ id, title: CONFORMANCE_TESTS.find((t) => t.id === id)!.title, state, detail });
  // P1
  const unchecked = at2.filter((r, i) => (p.rules[i].disposition ?? 'bound') === 'bound' && r.detail === 'Not applicable to this range.');
  const noClause = p.rules.filter((r) => !r.clause.trim());
  const dispo = dispositionProblems(p);
  add('P1', unchecked.length || noClause.length || dispo.length ? 'fail' : 'pass', unchecked.length ? `${unchecked.map((r) => r.id).join(', ')} name a clause but no check serves it.` : noClause.length ? `${noClause.map((r) => r.id).join(', ')} serve no clause.` : dispo.length ? dispo.join(' ') : `${p.rules.length} rules: ${p.rules.filter((r) => (r.disposition ?? 'bound') === 'bound').length} checked, ${p.rules.filter((r) => r.disposition === 'not_measurable').length} not measurable, ${p.rules.filter((r) => r.disposition === 'out_of_scope').length} out of scope.`);
  // P2
  const bad = p.requiredFields.filter((f) => !resolves(f));
  add('P2', bad.length ? 'fail' : 'pass', bad.length ? `Does not resolve: ${bad.join(', ')}.` : `${p.requiredFields.length} fields resolve against the receipt format.`);
  // P3–P6
  if (issuedSeed) {
    add('P3', 'pass', `Exit 0 PASS ${SEEDED_FIXTURES(p)}.`);
    add('P4', 'pass', `Exit 1 FAIL_INTEGRITY naming record and field, ${SEEDED_FIXTURES(p)}.`);
    add('P5', 'pass', `Exit 2 FAIL_PROFILE, never 1, ${SEEDED_FIXTURES(p)}.`);
    add('P6', 'pass', `Exit 3 INCOMPLETE, never 2, ${SEEDED_FIXTURES(p)}.`);
  } else if (ov.fixtures) {
    const f = ov.fixtures;
    add('P3', f.goodExit === 0 ? 'pass' : 'fail', `${fixtureLabel(f.good, f.goodExit)} on ${f.range}.`);
    add('P4', f.tamperedExit === 1 ? 'pass' : 'fail', `${fixtureLabel(f.tampered, f.tamperedExit)} for the tampered copy.`);
    add('P5', f.nonconformingExit === 2 ? 'pass' : 'fail', `${fixtureLabel(f.nonconforming, f.nonconformingExit)} for the non-conforming copy${f.nonconformingExit === 1 ? ' — a profile failure reported as an integrity failure accuses the customer of tampering' : ''}.`);
    add('P6', f.incompleteExit === 3 ? 'pass' : 'fail', `${fixtureLabel(f.incomplete, f.incompleteExit)} for the copy missing a member.`);
  } else if (!atLeast(levelOfOrg(db.org), 'l2')) {
    for (const id of ['P3', 'P4', 'P5', 'P6']) add(id, 'not_applicable', `Runs against an L2 evidence bundle. This organisation is at ${LEVEL_INFO.l1.label}.`);
  } else {
    for (const id of ['P3', 'P4', 'P5', 'P6']) add(id, 'not_run', 'Run the fixture tests to check this.');
  }
  // P7
  const unboundLabel = CODE_LABELS.PASS_PAYLOAD_UNBOUND;
  add('P7', /fail/i.test(unboundLabel) ? 'fail' : 'pass', `A destroyed salt reads “${unboundLabel}”.`);
  // P8: a rule that passes with L2 evidence must not fail at L1 — it reads not applicable
  const silent = at1.filter((r, i) => r.state === 'fail' && at2[i]?.state !== 'fail');
  const na = at1.filter((r, i) => r.state === 'not_applicable' && at2[i]?.state !== 'not_applicable');
  add('P8', silent.length ? 'fail' : 'pass', silent.length ? `${silent.map((r) => r.id).join(', ')} fail at L1 only for want of L2 evidence.` : `${na.length} checks read not applicable — assurance level 1${na.length ? ` (${na.map((r) => r.id).join(', ')})` : ''}.`);
  // P9
  const part = db.receipts.slice(-20);
  add('P9', part.length ? 'pass' : 'fail', part.length ? `A partial run prints its scope: #${part[0].seq}–#${part[part.length - 1].seq}, ${part.length} records.` : 'No records to run.');
  // P10
  const dup = PROFILES.filter((x) => x.id !== p.id && x.limits.trim() === p.limits.trim());
  add('P10', p.limits.length > 200 && !dup.length ? 'pass' : 'fail', p.limits.length <= 200 ? `The limits statement is ${p.limits.length} characters; it needs more than 200.` : dup.length ? `The limits statement is copied from ${dup.map((x) => x.id).join(', ')}. A copied statement has not been thought about.` : `${p.limits.length} characters, its own words.`);
  // P11
  if (ov.secondReader) add('P11', 'pass', `${userName(ov.secondReader.by)} read it: “${ov.secondReader.statement.slice(0, 120)}${ov.secondReader.statement.length > 120 ? '…' : ''}”`);
  else if (base.status === 'certified') add('P11', 'pass', `Recorded with version ${base.version} by the profile issuer’s second reader.`);
  else add('P11', 'not_run', 'Nobody other than the author has read the report yet.');
  // P12
  add('P12', 'pass', 'The verifier runs in this browser with no network call; the same code runs on an air-gapped machine.');
  return out;
}

/** The profile with this organisation's lifecycle applied (author, issuer, status) and the pilot's not_measurable rows. */
export function decorateProfile<T extends VerifierProfile>(orgId: string, p: T): T {
  const db = getDB(orgId);
  const st = factory(db);
  const ov = st.profiles[p.id];
  const out: T = { ...p, rules: [...p.rules] };
  if (ov) {
    if (ov.status) out.status = ov.status;
    if (ov.author) out.author = userName(ov.author);
    if (ov.certifier) out.certifier = userName(ov.certifier);
    if (ov.certifiedAt) out.certifiedAt = ov.certifiedAt;
    if (ov.withdrawnAt) { out.withdrawnAt = ov.withdrawnAt; out.withdrawnReason = ov.withdrawnReason; }
  }
  if (p.packId) {
    const nm = st.pilots[p.packId]?.necessity?.notMeasurable ?? [];
    nm.forEach((row, i) => out.rules.push({ id: `N${String(i + 1).padStart(2, '0')}`, kind: 'coverage', clause: row.clause, text: `From the auditor’s day-0 necessity statement: ${row.clause}`, disposition: 'not_measurable', reason: row.reason, wouldChangeIf: row.wouldChangeIf }));
  }
  return out;
}

/** The extra results a run carries for rows the organisation's pilot added (not_measurable, never a silent omission). */
export function extraRuleResults(orgId: string, profileId: string, have: string[]): ProfileRuleResult[] {
  const base = profileById(profileId);
  if (!base) return [];
  const p = decorateProfile(orgId, base);
  return runProfileRules({ ...p, rules: p.rules.filter((r) => !have.includes(r.id)) }, { receipts: [], checkpoints: [], level: 'l1', wormRetentionYears: 0, erasures: [], agents: [], aiSystems: [], assessments: [] });
}

export interface ProfileLifecycle {
  status: VerifierProfile['status'];
  authorId?: string;
  certifierId?: string;
  submittedAt?: string;
  certifiedAt?: string;
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawnReason?: string;
  secondReader?: ProfileOverlay['secondReader'];
  fixtures?: ProfileOverlay['fixtures'];
  conformance: ConformanceResult[];
  entitlement: Entitlement;
  /** eligible issuers: owners and admins who are not the author (no agents; auditors are read-only on the client's chain) */
  eligibleIssuers: string[];
}

export function profileLifecycle(orgId: string, profileId: string): ProfileLifecycle {
  const db = getDB(orgId);
  const ov = factory(db).profiles[profileId] ?? {};
  return {
    status: profileStatus(db, profileId), authorId: ov.author, certifierId: ov.certifier, submittedAt: ov.submittedAt, certifiedAt: ov.certifiedAt,
    withdrawnAt: ov.withdrawnAt, withdrawnBy: ov.withdrawnBy, withdrawnReason: ov.withdrawnReason, secondReader: ov.secondReader, fixtures: ov.fixtures,
    conformance: conformance(orgId, profileId), entitlement: entitlement(orgId, profileId),
    eligibleIssuers: db.members.filter((m) => m.status === 'active' && ['owner', 'admin'].includes(m.role) && m.userId !== ov.author).map((m) => m.userId),
  };
}

/** The author puts their name to the draft (signed from L2, recorded at L1) and submits it for issue. */
export function submitProfile(orgId: string, profileId: string, userId: string) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Submitting a profile');
  const p = profileById(profileId);
  if (!p) throw new Error('No such verifier profile.');
  const st = factory(db);
  if (profileStatus(db, profileId) !== 'draft') throw new Error('Only a draft profile is submitted for issue.');
  const ov = (st.profiles[profileId] ??= {});
  // L1 copy never says "signed": the author is recorded, and the receipt is sealed in a hash chain
  const level = levelOfOrg(db.org);
  if (ov.author) throw new Error(`${userName(ov.author)} is already ${atLeast(level, 'l2') ? 'signed' : 'recorded'} as this draft’s author.`);
  const r = logAdmin(orgId, userId, 'profile.submitted', { profile: profileId, version: p.version, author: userId, level });
  Object.assign(ov, { author: userId, submittedAt: r.ts, submittedSeq: r.seq });
  touch(orgId, 'pack');
  return profileLifecycle(orgId, profileId);
}

/** P11: a person who did not author the profile reads the report and states what it does not prove. */
export function recordSecondReader(orgId: string, profileId: string, userId: string, statement: string) {
  const db = getDB(orgId);
  // written to the client's chain, so owners and admins only: auditors are read-only there
  requireRoles(orgId, userId, ['owner', 'admin'], 'Recording the second reader');
  const st = factory(db);
  const ov = (st.profiles[profileId] ??= {});
  if (ov.author === userId) throw new Error('The second reader is never the author.');
  minLen(statement, 40, 'What the report does not prove');
  const r = logAdmin(orgId, userId, 'profile.second_reader', { profile: profileId, chars: statement.trim().length });
  ov.secondReader = { by: userId, at: r.ts, statement: statement.trim(), seq: r.seq };
  touch(orgId, 'pack');
  return profileLifecycle(orgId, profileId);
}

/* ── Fixture runs: the verifier against good, tampered, non-conforming and incomplete bundles ── */

interface FixtureRun { range: string; good: VerifyBundleResult; tampered: VerifyBundleResult; nonconforming: VerifyBundleResult; incomplete: VerifyBundleResult; tamperedSeq: number }

function fixtureRuns(db: OrgDB, profileId: string): FixtureRun {
  if (!atLeast(levelOfOrg(db.org), 'l2')) throw new Error(`Fixture runs need an L2 evidence bundle. This organisation is at ${LEVEL_INFO.l1.label}.`);
  const n = Math.min(120, db.receipts.length);
  const from = db.receipts[db.receipts.length - n].seq;
  const to = db.receipts[db.receipts.length - 1].seq;
  const good = buildEvidenceBundle(db, 'system', from, to, profileId).bundle as EvidenceBundle;
  const goodRes = verifyBundle(good, {});
  // tampered: one value inside a receipt changed after it was sealed
  const t = JSON.parse(JSON.stringify(good)) as EvidenceBundle;
  const k = Math.floor(t.receipts.length / 2);
  const target = t.receipts[k];
  target.reason = `${target.reason ?? ''} (edited)`;
  const tamperedRes = verifyBundle(t, {});
  // non-conforming: a sound chain whose daily checkpoints were left out, claiming the MCA audit-trail profile (C04 breaks)
  const nc = buildEvidenceBundle({ ...db, checkpoints: [] } as OrgDB, 'system', from, to, 'in-mca-audit-trail').bundle as EvidenceBundle;
  const ncRes = verifyBundle(nc, {});
  // incomplete: a member left out
  const inc = JSON.parse(JSON.stringify(good)) as EvidenceBundle;
  delete (inc as Partial<EvidenceBundle>).declarations;
  const incRes = verifyBundle(inc, {});
  return { range: `#${from}–#${to} (${n} records)`, good: goodRes, tampered: tamperedRes, nonconforming: ncRes, incomplete: incRes, tamperedSeq: target.seq };
}

/** Run P3–P6 against bundles built from this organisation's chain (L2+). Recorded. */
export function runProfileFixtures(orgId: string, profileId: string, userId: string) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Running the fixture tests');
  if (!profileById(profileId)) throw new Error('No such verifier profile.');
  const f = fixtureRuns(db, profileId);
  const r = logAdmin(orgId, userId, 'profile.fixtures_run', { profile: profileId, range: f.range, good: f.good.exitCode, tampered: f.tampered.exitCode, nonconforming: f.nonconforming.exitCode, incomplete: f.incomplete.exitCode });
  const ov = (factory(db).profiles[profileId] ??= {});
  ov.fixtures = { at: r.ts, by: userId, range: f.range, good: f.good.code, tampered: f.tampered.code, nonconforming: f.nonconforming.code, incomplete: f.incomplete.code, goodExit: f.good.exitCode, tamperedExit: f.tampered.exitCode, nonconformingExit: f.nonconforming.exitCode, incompleteExit: f.incomplete.exitCode, seq: r.seq };
  touch(orgId, 'pack');
  return profileLifecycle(orgId, profileId);
}

/** Issue a profile: a second person, never the author, and only when P1–P12 all pass. */
export function issueProfile(orgId: string, profileId: string, userId: string) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Issuing a profile');
  const p = profileById(profileId);
  if (!p) throw new Error('No such verifier profile.');
  const st = factory(db);
  const ov = (st.profiles[profileId] ??= {});
  if (profileStatus(db, profileId) !== 'draft') throw new Error('Only a draft profile is issued.');
  if (!ov.author) throw new Error(`The author ${atLeast(levelOfOrg(db.org), 'l2') ? 'signs' : 'is recorded on'} the draft first. Then a different person issues it.`);
  if (ov.author === userId) throw new Error('Dual control: the issuer is never the author. A different owner or admin issues it.');
  const failing = conformance(orgId, profileId).filter((x) => x.state !== 'pass');
  if (failing.length) throw new Error(`A profile that has not passed all twelve tests is not issued. Still open: ${failing.map((x) => x.id).join(', ')}.`);
  const r = logAdmin(orgId, userId, 'profile.issued', { profile: profileId, version: p.version, author: ov.author, issuer: userId, dual_control: true });
  Object.assign(ov, { status: 'certified' as const, certifier: userId, certifiedAt: r.ts, certifiedSeq: r.seq });
  touch(orgId, 'pack');
  return profileLifecycle(orgId, profileId);
}

/** Withdraw a profile found wrong, or whose regime was withdrawn. It can no longer be run, ordered or claimed. */
export function withdrawProfile(orgId: string, profileId: string, userId: string, reason: string) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Withdrawing a profile');
  const p = profileById(profileId);
  if (!p) throw new Error('No such verifier profile.');
  const status = profileStatus(db, profileId);
  if (status === 'withdrawn') throw new Error('This profile is already withdrawn.');
  minLen(reason, 12, 'The reason');
  // a withdrawn profile can no longer be run or claimed, so its order ends with it: billed to the end of this month only
  const order = activeProfileOrders(db).get(profileId);
  const r = logAdmin(orgId, userId, 'profile.withdrawn', { profile: profileId, version: p.version, previous_status: status, reason: reason.trim(), order_cancelled: !!order });
  const ov = (factory(db).profiles[profileId] ??= {});
  Object.assign(ov, { status: 'withdrawn' as const, withdrawnAt: r.ts, withdrawnBy: userId, withdrawnReason: reason.trim(), withdrawnSeq: r.seq });
  if (order) {
    logAdmin(orgId, userId, 'billing.addon_cancelled', { addon: 'profile', profile: profileId, price_per_year: PROFILE_PRICE, cause: 'profile_withdrawn', withdrawn_seq: r.seq, order_seq: order.seq });
    deriveBilling(db);
    touch(orgId, 'billing');
  }
  touch(orgId, 'pack');
  return { ...profileLifecycle(orgId, profileId), orderCancelled: !!order };
}

/* ══ The pilot ═══════════════════════════════════════════════════════════ */

export interface PilotView extends PilotRecord {
  day: number;
  boundary?: { at: string; level: LevelId; before: number; after: number; state: 'done' | 'waiting' | 'not_needed' };
  reconciliation?: Reconciliation;
  steps: {
    id: PilotStepId; day: number; title: string; what: string; plannedAt: string; state: 'done' | 'open' | 'waiting' | 'not_needed'; doneAt?: string; seq?: number;
    /** recorded (or, when open, it would be recorded) before its planned day */
    early?: { day: number; reason?: string };
    /** open but its planned day has not come: recording it now needs a reason, and it is marked early */
    notYet?: boolean;
  }[];
}

const pilotDayAt = (p: PilotRecord, t: number) => Math.max(0, Math.floor((t - new Date(p.startedAt).getTime()) / D));

/** A step recorded before its planned day needs a reason (12+ characters) and is marked early; returns the mark, or undefined on time. */
function checkPlannedDay(p: PilotRecord, id: PilotStepId, reason?: string) {
  const step = PILOT_STEPS.find((s) => s.id === id)!;
  const day = pilotDayAt(p, Date.now());
  if (day >= step.day) return undefined;
  const planned = new Date(new Date(p.startedAt).getTime() + step.day * D).toISOString();
  if ((reason ?? '').trim().length < 12) throw new Error(`${step.title} is planned for day ${step.day} (${dayText(planned)}); this is day ${day}. It is recorded early only with the reason, in at least 12 characters, and it is marked early.`);
  const mark = { day, reason: (reason ?? '').trim() };
  p.early = { ...(p.early ?? {}), [id]: mark };
  return mark;
}

const earlyDetails = (m?: { day: number; reason: string }, plannedDay?: number): Record<string, string | number | boolean> => (m ? { recorded_day: m.day, planned_day: plannedDay ?? 0, early_reason: m.reason } : {});

function boundaryOf(db: OrgDB, pilot: PilotRecord): PilotView['boundary'] {
  if (levelRank(pilot.startLevel) >= levelRank('l2')) return { at: pilot.startedAt, level: pilot.startLevel, before: 0, after: 0, state: 'not_needed' };
  const t = levelStart(db, 'l2');
  if (t === undefined) return undefined; // still at L1: day 1 waits on the upgrade
  const at = iso(t);
  const before = db.receipts.filter((r) => new Date(r.ts).getTime() < t).length;
  return { at, level: 'l2', before, after: db.receipts.length - before, state: 'done' };
}

export function pilotView(orgId: string, packId: PackId): PilotView | undefined {
  const db = getDB(orgId);
  const st = factory(db);
  const p = st.pilots[packId];
  if (!p) return undefined;
  const start = new Date(p.startedAt).getTime();
  const day = Math.max(0, Math.floor((Date.now() - start) / D));
  const boundary = boundaryOf(db, p);
  const recon = st.recons.filter((r) => r.packId === packId && r.at >= p.startedAt && (!p.selfExport || r.at >= p.selfExport.at)).sort((a, b) => b.at.localeCompare(a.at))[0];
  const done: Record<PilotStepId, { at?: string; seq?: number } | undefined> = {
    necessity: p.necessity, boundary: boundary?.state === 'done' ? { at: boundary.at } : undefined, operation: p.selfExport ? { at: p.selfExport.at } : undefined,
    self_export: p.selfExport, air_gap: p.airGap, reconcile: p.selfExport && recon ? { at: recon.at, seq: recon.seq } : undefined, verdict: p.verdict, gd: p.gd,
  };
  let blocked = false;
  const steps = PILOT_STEPS.map((s) => {
    const plannedAt = iso(start + s.day * D);
    if (s.id === 'boundary' && boundary?.state === 'not_needed') return { ...s, plannedAt, state: 'not_needed' as const };
    const d = done[s.id];
    if (d) {
      const doneDay = d.at ? pilotDayAt(p, new Date(d.at).getTime()) : s.day;
      // the boundary and the ongoing operation follow the upgrade; every other step is checked against its planned day
      const early = s.id !== 'boundary' && s.id !== 'operation' && doneDay < s.day ? { day: doneDay, reason: p.early?.[s.id]?.reason } : undefined;
      return { ...s, plannedAt, state: 'done' as const, doneAt: d.at, seq: d.seq, ...(early ? { early } : {}) };
    }
    // days 2–75 are ongoing: in progress once the boundary is behind, and they never hold up the day-76 export
    if (s.id === 'operation') return { ...s, plannedAt, state: blocked || p.status !== 'running' ? 'waiting' as const : 'open' as const };
    const state = blocked || p.status !== 'running' ? 'waiting' as const : 'open' as const;
    blocked = true;
    const notYet = state === 'open' && s.id !== 'boundary' && day < s.day;
    return { ...s, plannedAt, state, ...(notYet ? { notYet } : {}) };
  });
  return { ...p, day, boundary, reconciliation: recon, steps };
}

const requirePilot = (db: OrgDB, packId: PackId) => {
  const p = factory(db).pilots[packId];
  if (!p) throw new Error(`No ${packId} pilot has been started.`);
  if (p.status !== 'running') throw new Error(`The ${packId} pilot is ${p.status}.`);
  return p;
};

export function startPilot(orgId: string, packId: PackId, userId: string, input: { auditorName: string; auditorFirm: string }) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Starting a pilot');
  if (!db.platform.packs.some((x) => x.id === packId)) throw new Error(`Install ${packId} first — at L1 it installs as a dry run, and the pilot starts there.`);
  const st = factory(db);
  const prev = st.pilots[packId];
  if (prev?.status === 'running') throw new Error(`A ${packId} pilot is already running.`);
  minLen(input.auditorName, 3, 'The auditor’s name');
  minLen(input.auditorFirm, 3, 'The auditor’s firm');
  const level = levelOfOrg(db.org);
  const earlier = (st.pilotHistory?.[packId]?.length ?? 0) + (prev ? 1 : 0);
  const r = logAdmin(orgId, userId, 'pack.pilot_started', { pack: packId, auditor: input.auditorName.trim(), firm: input.auditorFirm.trim(), level, window_days: 90, earlier_pilots: earlier });
  // the earlier pilot is kept, with its verdict, its G-D answer and its timeline: G-D keeps that answer until this pilot gives one
  if (prev) st.pilotHistory = { ...(st.pilotHistory ?? {}), [packId]: [...(st.pilotHistory?.[packId] ?? []), prev] };
  st.pilots[packId] = { packId, customer: db.org.name, auditor: { name: input.auditorName.trim(), firm: input.auditorFirm.trim() }, startedAt: r.ts, startedBy: userId, startLevel: level, startSeq: r.seq, status: 'running' };
  touch(orgId, 'pack');
  return pilotView(orgId, packId)!;
}

export function recordNecessity(orgId: string, packId: PackId, userId: string, input: { questions: string[]; statement: string; notMeasurable: { clause: string; reason: string; wouldChangeIf: string }[] }) {
  const db = getDB(orgId);
  // J9 gives day 0 to the auditor ("the auditor's half day"), so the auditor may record it; see AUDITOR_PILOT_STEPS
  requireRoles(orgId, userId, ['owner', 'admin', 'auditor'], 'Recording the necessity statement');
  const p = requirePilot(db, packId);
  if (p.necessity) throw new Error('The day-0 necessity statement is already recorded; it is kept as written.');
  const qs = input.questions.map((q) => q.trim()).filter(Boolean);
  if (qs.length !== 3) throw new Error('Write the three questions the auditor would ask.');
  qs.forEach((q, i) => minLen(q, 10, `Question ${i + 1}`));
  minLen(input.statement, 40, 'What the auditor would need to rely on a record like this');
  const rows = input.notMeasurable.filter((x) => x.clause.trim() || x.reason.trim() || x.wouldChangeIf.trim());
  rows.forEach((x, i) => { minLen(x.clause, 6, `Row ${i + 1}: the need`); minLen(x.reason, 12, `Row ${i + 1}: why it cannot be measured`); minLen(x.wouldChangeIf, 12, `Row ${i + 1}: what would change it`); });
  const r = logAdmin(orgId, userId, 'pack.pilot_necessity', { pack: packId, questions: 3, not_measurable: rows.length, auditor: p.auditor.name });
  p.necessity = { questions: qs, statement: input.statement.trim(), notMeasurable: rows.map((x) => ({ clause: x.clause.trim(), reason: x.reason.trim(), wouldChangeIf: x.wouldChangeIf.trim() })), at: r.ts, by: userId, seq: r.seq };
  touch(orgId, 'pack');
  return pilotView(orgId, packId)!;
}

/** Day 76: the customer's own export, recorded with whether they needed help (needing help is the finding). */
export function recordSelfExport(orgId: string, packId: PackId, userId: string, input: { exportSeq: number; receipts: number; firstSeq: number; lastSeq: number; help: boolean; note: string; early?: string }) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Recording the customer’s export');
  const p = requirePilot(db, packId);
  if (!p.necessity) throw new Error('Record the day-0 necessity statement first.');
  if (!atLeast(levelOfOrg(db.org), 'l2')) throw new Error(`The day-76 export is an L2 evidence bundle. Move to ${LEVEL_INFO.l2.label} first (day 1 of the pilot).`);
  const exp = db.receipts.find((r) => r.seq === input.exportSeq && r.action === 'evidence.exported');
  if (!exp) throw new Error('That export is not on the chain.');
  if (new Date(exp.ts).getTime() < new Date(p.startedAt).getTime()) throw new Error('That export was made before this pilot started.');
  if (input.help) minLen(input.note, 12, 'What help was needed');
  const early = checkPlannedDay(p, 'self_export', input.early);
  const r = logAdmin(orgId, userId, 'pack.pilot_self_export', { pack: packId, export_seq: input.exportSeq, receipts: input.receipts, help_needed: input.help, note: input.note.trim(), ...earlyDetails(early, 76) });
  p.selfExport = { at: r.ts, by: userId, help: input.help, note: input.note.trim(), receipts: input.receipts, firstSeq: input.firstSeq, lastSeq: input.lastSeq, exportSeq: input.exportSeq, seq: r.seq };
  touch(orgId, 'pack');
  return pilotView(orgId, packId)!;
}

/**
 * Day 77: the verifier, disconnected — on the customer's own day-76 bundle (the file they exported, loaded by the
 * auditor; its digest must match the export receipt), then on a tampered copy of that same bundle. A FAIL_INTEGRITY
 * on the customer's bundle stops the pack.
 */
export function recordAirGap(orgId: string, packId: PackId, userId: string, input: { bundle: unknown; fileName?: string; early?: string }) {
  const db = getDB(orgId);
  // J9: day 77 "auditor runs verifier air-gapped" — the auditor may record it
  requireRoles(orgId, userId, ['owner', 'admin', 'auditor'], 'Recording the auditor’s offline run');
  const p = requirePilot(db, packId);
  const se = p.selfExport;
  if (!se) throw new Error('The customer exports the bundle first (day 76).');
  const b = input.bundle as EvidenceBundle | undefined;
  if (!b || typeof b !== 'object' || !Array.isArray(b.receipts) || !b.manifest) throw new Error('This file is not an evidence bundle. Load the bundle the customer exported on day 76 (the ZIP or JSON file).');
  // the customer's own bundle: its digest is the one written on an export receipt of the day-76 export
  const digest = bundleDigest(b);
  const exportReceipts = db.receipts.filter((r) => r.action === 'evidence.exported' && r.seq >= (se.exportSeq ?? 0) && (se.seq === undefined || r.seq < se.seq));
  const match = exportReceipts.find((r) => String(r.details?.digest ?? '') === digest.slice(0, 16));
  if (!match) throw new Error(`This is not the bundle the customer exported on day 76${se.exportSeq !== undefined ? ` (export receipt #${se.exportSeq})` : ''}: its digest ${digest.slice(0, 16)} matches no export receipt of that export. Load the file the customer exported.`);
  const early = checkPlannedDay(p, 'air_gap', input.early);
  const good = verifyBundle(b, { expectedFingerprint: db.org.keyFingerprint });
  // the tampered copy: one value inside a receipt of the customer's bundle changed after it was sealed
  const t = JSON.parse(JSON.stringify(b)) as EvidenceBundle;
  const k = Math.floor(t.receipts.length / 2);
  const target = t.receipts[k];
  target.reason = `${target.reason ?? ''} (edited)`;
  const tampered = verifyBundle(t, { expectedFingerprint: db.org.keyFingerprint });
  const r = logAdmin(orgId, userId, 'pack.pilot_air_gap', { pack: packId, export_seq: match.seq, bundle_digest: digest.slice(0, 16), records: b.receipts.length, bundle_exit: good.exitCode, bundle_code: good.code, tampered_exit: tampered.exitCode, tampered_code: tampered.code, ...earlyDetails(early, 77) });
  p.airGap = { at: r.ts, by: userId, goodCode: good.code, goodExit: good.exitCode, tamperedCode: tampered.code, tamperedExit: tampered.exitCode, tamperedAt: `#${target.seq}`, seq: r.seq, bundleDigest: digest, exportSeq: match.seq, records: b.receipts.length, fileName: input.fileName };
  if (good.exitCode === 1) {
    p.status = 'stopped';
    p.stoppedAt = r.ts;
    p.stoppedReason = `FAIL_INTEGRITY on the customer’s own bundle (export receipt #${match.seq}) during the pilot. It stops the pack, not just the pilot.`;
    logAdmin(orgId, userId, 'pack.pilot_stopped', { pack: packId, reason: 'fail_integrity', export_seq: match.seq });
  }
  touch(orgId, 'pack');
  return pilotView(orgId, packId)!;
}

export function recordVerdict(orgId: string, packId: PackId, userId: string, input: { auditor: string; outcome: 'relies' | 'relies_with_limits' | 'does_not_rely'; words: string; early?: string }) {
  const db = getDB(orgId);
  // J9: day 80 "auditor's written verdict" — the auditor may record it
  requireRoles(orgId, userId, ['owner', 'admin', 'auditor'], 'Recording the auditor’s verdict');
  const p = requirePilot(db, packId);
  if (!p.airGap) throw new Error('The auditor runs the verifier first (day 77).');
  const v = pilotView(orgId, packId)!;
  if (!v.reconciliation) throw new Error('Run the two-way reconciliation first (day 78).');
  minLen(input.auditor, 3, 'The auditor’s name');
  minLen(input.words, 40, 'The verdict, in the auditor’s words');
  const early = checkPlannedDay(p, 'verdict', input.early);
  const r = logAdmin(orgId, userId, 'pack.pilot_verdict', { pack: packId, auditor: input.auditor.trim(), outcome: input.outcome, chars: input.words.trim().length, ...earlyDetails(early, 80) });
  p.verdict = { at: r.ts, by: userId, auditor: input.auditor.trim(), outcome: input.outcome, words: input.words.trim(), seq: r.seq };
  touch(orgId, 'pack');
  return pilotView(orgId, packId)!;
}

/** Day 85: "Would you pay for this on its own line?" The answer closes the pilot and scores G-D. */
export function recordGd(orgId: string, packId: PackId, userId: string, input: { answer: 'yes' | 'no'; note: string; early?: string }) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner'], 'Answering the G-D question');
  const p = requirePilot(db, packId);
  if (!p.verdict) throw new Error('Record the auditor’s verdict first (day 80).');
  minLen(input.note, 12, 'The answer, in the buyer’s words');
  const early = checkPlannedDay(p, 'gd', input.early);
  const r = logAdmin(orgId, userId, 'pack.pilot_closed', { pack: packId, gd_answer: input.answer, note: input.note.trim(), gate: input.answer === 'yes' ? 'G-D met' : 'G-D not met', ...earlyDetails(early, 85) });
  p.gd = { at: r.ts, by: userId, answer: input.answer, note: input.note.trim(), seq: r.seq };
  p.status = 'closed';
  touch(orgId, 'pack');
  return pilotView(orgId, packId)!;
}

export function stopPilot(orgId: string, packId: PackId, userId: string, reason: string) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Stopping a pilot');
  const p = requirePilot(db, packId);
  minLen(reason, 12, 'The reason');
  const r = logAdmin(orgId, userId, 'pack.pilot_stopped', { pack: packId, reason: reason.trim() });
  p.status = 'stopped';
  p.stoppedAt = r.ts;
  p.stoppedReason = `${reason.trim()} (receipt #${r.seq})`;
  touch(orgId, 'pack');
  return pilotView(orgId, packId)!;
}

/** Earlier pilots of a pack in this organisation, newest first, each with the view of its timeline as it ended. */
export function earlierPilots(orgId: string, packId: PackId) {
  const db = getDB(orgId);
  const list = factory(db).pilotHistory?.[packId] ?? [];
  return [...list].reverse().map((p) => {
    const end = p.gd?.at ?? p.stoppedAt ?? p.verdict?.at ?? p.airGap?.at ?? p.selfExport?.at ?? p.necessity?.at ?? p.startedAt;
    return { ...p, endedAt: end, endedDay: pilotDayAt(p, new Date(end).getTime()) };
  });
}

/* ══ Withdrawn profiles reach the bundle and the verifier ═══════════════════ */

/** This organisation's withdrawn profiles: id → when and why (the verifier reports a bundle claiming one with the date). */
export function profileWithdrawals(orgId: string): Record<string, ProfileWithdrawal> {
  const st = factory(getDB(orgId));
  const out: Record<string, ProfileWithdrawal> = {};
  for (const [id, ov] of Object.entries(st.profiles)) if (ov.status === 'withdrawn' && ov.withdrawnAt) out[id] = { at: ov.withdrawnAt, reason: ov.withdrawnReason };
  return out;
}

// the bundle's profile member carries this organisation's lifecycle and the pilot's not_measurable rows (platform.ts)
setBundleProfileHook((d, p) => decorateProfile(d.org.id, p));
// the verifier, run in this console, knows which profiles the bundle's organisation has withdrawn (lib/verify6.ts)
setProfileWithdrawalLookup((id) => {
  const d = readOnlyOpen(() => getDB(id));
  return d.org.id === id ? profileWithdrawals(id) : undefined;
});

/* ══ Two-way reconciliation against the target system's own audit trail ═══ */

const PACK_MATCH: Record<PackId, (r: Receipt) => boolean> = {
  ledger1: (r) => r.kind === 'decision' && !!r.tool?.startsWith('zoho_books.'),
  invoice1: (r) => r.kind === 'decision' && (r.tool === 'zoho_books.create_bill' || r.tool === 'zoho_books.record_payment' || r.tool === 'zoho_books.delete_bill'),
  collect1: (r) => r.kind === 'decision' && r.tool === 'gmail.send_email' && r.args_summary?.template !== undefined,
};

/** Committed governed writes for the pack in the window: allowed, or held and approved. */
function committedWrites(db: OrgDB, packId: PackId, from: number, to: number): Receipt[] {
  const approved = new Set(db.receipts.filter((r) => r.kind === 'approval' && r.approval?.status === 'approved' && r.ref_seq !== undefined).map((r) => r.ref_seq!));
  return db.receipts.filter((r) => PACK_MATCH[packId](r) && (r.decision === 'allow' || (r.decision === 'ask' && approved.has(r.seq))) && new Date(r.ts).getTime() >= from && new Date(r.ts).getTime() <= to);
}

const keyOf = (r: Receipt) => `${recordIdOf(r)}#${r.seq}`;

/** The target's own trail as its connector reads it: every governed write, plus the changes made directly in the target. */
function targetTrail(db: OrgDB, packId: PackId, writes: Receipt[], from: number, to: number): ReconRow[] {
  const rand = makeRand(db.org.id.length * 97 + packId.length * 13 + Math.floor(to / D));
  const rows: ReconRow[] = [];
  // one governed write in about every 60 never reached the target (the run failed after the decision)
  const dropped = new Set(writes.filter((_, i) => i > 0 && i % 61 === 7).map((r) => r.seq));
  for (const r of writes) if (!dropped.has(r.seq)) rows.push({ key: keyOf(r), recordId: recordIdOf(r), type: r.tool ?? '', at: iso(new Date(r.ts).getTime() + 2000), by: `${r.agent ?? 'agent'} via Elan1 Govern` });
  // changes made directly in the target system, outside the write path
  const direct = packId === 'collect1'
    ? [{ id: 'to_domain:meridianfoods.in', type: 'manual email (collections desk)', by: 'Collections desk user' }, { id: 'to_domain:sunrise-retail.in', type: 'manual call logged', by: 'Field recovery agent' }]
    : packId === 'invoice1'
      ? [{ id: 'bill:BILL-9131', type: 'bill edited in Zoho Books', by: 'Accounts user (direct)' }]
      : [{ id: 'bill:BILL-9120', type: 'journal edited in Zoho Books', by: 'Accounts user (direct)' }, { id: 'payment:PAY-4471', type: 'payment voided in Zoho Books', by: 'Finance controller (direct)' }];
  for (const d of direct) rows.push({ key: `${d.id}#direct${Math.floor(rand.next() * 1000)}`, recordId: d.id, type: d.type, at: iso(from + Math.floor(rand.next() * (to - from))), by: d.by });
  return rows;
}

function parseTargetCsv(text: string): ReconRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('The audit-trail file needs a header row and at least one change.');
  const head = lines[0].toLowerCase().split(',').map((h) => h.trim());
  const col = (n: string[]) => head.findIndex((h) => n.includes(h));
  const ri = col(['record_id', 'record', 'document']); const ai = col(['changed_at', 'at', 'timestamp']); const bi = col(['changed_by', 'by', 'user']); const ti = col(['change', 'type', 'action']);
  if (ri < 0 || ai < 0) throw new Error('The audit-trail file needs record_id and changed_at columns (changed_by and change are optional).');
  return lines.slice(1).map((l, i) => {
    const c = l.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    const at = new Date(c[ai]);
    if (Number.isNaN(at.getTime())) throw new Error(`Row ${i + 2}: changed_at is not a date.`);
    return { key: `${c[ri]}#row${i + 2}`, recordId: c[ri], type: ti >= 0 ? c[ti] : 'change', at: at.toISOString(), by: bi >= 0 ? c[bi] : '—' };
  });
}

/**
 * Two-way reconciliation (E11 test 3): every change in the target for the governed record types must have an elan1
 * record, and every committed record a change in the target. Exceptions target → chain are the finding that matters.
 */
export function reconcile(orgId: string, packId: PackId, userId: string, input: { days: number; csv?: string }) {
  const db = getDB(orgId);
  // written to the client's chain and not given to the auditor by J9: owners and admins only
  requireRoles(orgId, userId, ['owner', 'admin'], 'Running the reconciliation');
  if (!db.platform.packs.some((x) => x.id === packId)) throw new Error(`Install ${packId} first.`);
  const days = Math.max(1, Math.min(90, Math.round(input.days || 30)));
  const to = Date.now();
  const from = to - days * D;
  const writes = committedWrites(db, packId, from, to);
  const trail = input.csv ? parseTargetCsv(input.csv) : targetTrail(db, packId, writes, from, to);
  // match each committed write to one target change on the record id, nearest in time
  const pool = [...trail];
  const chainOnly: ReconRow[] = [];
  let matched = 0;
  for (const w of writes) {
    const rid = recordIdOf(w);
    const t = new Date(w.ts).getTime();
    let best = -1; let bestGap = Infinity;
    pool.forEach((x, i) => { if (x.recordId !== rid) return; const gap = Math.abs(new Date(x.at).getTime() - t); if (gap < bestGap && gap <= 15 * 60_000) { best = i; bestGap = gap; } });
    if (best >= 0) { pool.splice(best, 1); matched++; } else chainOnly.push({ key: keyOf(w), recordId: rid, type: w.tool ?? '', at: w.ts, by: w.agent ?? '', seq: w.seq });
  }
  const targetOnly = pool;
  const tpl = PACK_TEMPLATE[packId];
  const r = logAdmin(orgId, userId, 'pack.reconciled', { pack: packId, target: tpl.target.name, source: input.csv ? 'upload' : 'connector', days, chain_committed: writes.length, target_changes: trail.length, matched, target_only: targetOnly.length, chain_only: chainOnly.length });
  const rec: Reconciliation = { id: `rec_${r.seq}`, packId, at: r.ts, by: userId, source: input.csv ? 'upload' : 'connector', target: `${tpl.target.name} — ${tpl.target.trail}`, from: iso(from), to: iso(to), chainCommitted: writes.length, targetChanges: trail.length, matched, targetOnly, chainOnly, explained: {}, seq: r.seq };
  const st = factory(db);
  st.recons = [rec, ...st.recons].slice(0, 30);
  touch(orgId, 'pack');
  return rec;
}

export function explainException(orgId: string, reconId: string, key: string, userId: string, note: string) {
  const db = getDB(orgId);
  // the organisation explains its own exceptions: owners and admins only
  requireRoles(orgId, userId, ['owner', 'admin'], 'Explaining an exception');
  const rec = factory(db).recons.find((x) => x.id === reconId);
  if (!rec) throw new Error('No such reconciliation.');
  const row = [...rec.targetOnly, ...rec.chainOnly].find((x) => x.key === key);
  if (!row) throw new Error('No such exception.');
  if (rec.explained[key]) throw new Error('This exception is already explained.');
  minLen(note, 12, 'The explanation');
  const r = logAdmin(orgId, userId, 'pack.reconciliation_explained', { pack: rec.packId, reconciliation: rec.id, record: row.recordId, direction: rec.targetOnly.includes(row) ? 'target_without_record' : 'record_without_target', note: note.trim() });
  rec.explained[key] = { by: userId, at: r.ts, note: note.trim(), seq: r.seq };
  touch(orgId, 'pack');
  return rec;
}

export const reconciliations = (orgId: string, packId: PackId) => factory(getDB(orgId)).recons.filter((r) => r.packId === packId);

/* ══ T1–T8 ═══════════════════════════════════════════════════════════════ */

const NEVER_SKIPPABLE = ['G1', 'G2', 'G3', 'G4', 'G7', 'G9'];
const DECLARED_OFF: Record<PackId, string[]> = { ledger1: ['G5', 'G6', 'G8'], invoice1: ['G6'], collect1: ['G6'] };

export function recordDrill(orgId: string, packId: PackId, writeType: string, userId: string, note: string) {
  const db = getDB(orgId);
  requireRoles(orgId, userId, ['owner', 'admin'], 'Recording a reversal drill');
  const wt = PACK_WRITE_TYPES[packId].find((w) => w.name === writeType);
  if (!wt) throw new Error('No such write type in this pack.');
  if (!wt.reversible) throw new Error(`${writeType} is declared irreversible; it has no reversal to drill.`);
  minLen(note, 12, 'What the drill did');
  const r = logAdmin(orgId, userId, 'pack.reversal_drill', { pack: packId, write_type: writeType, note: note.trim() });
  const st = factory(db);
  (st.drills[packId] ??= {})[writeType] = { at: r.ts, by: userId, note: note.trim(), seq: r.seq };
  touch(orgId, 'pack');
  return drills(orgId, packId);
}

export const drills = (orgId: string, packId: PackId) => ({ ...(factory(getDB(orgId)).drills[packId] ?? {}) });

export function recordReading(orgId: string, packId: PackId, userId: string, input: { auditor: string; statement: string }) {
  const db = getDB(orgId);
  // T8 is not a J9 step: an owner or admin records what the named auditor said (auditors are read-only on the client's chain)
  requireRoles(orgId, userId, ['owner', 'admin'], 'Recording the auditor’s reading');
  minLen(input.auditor, 3, 'The auditor’s name');
  minLen(input.statement, 60, 'What the auditor said the report does not prove');
  const r = logAdmin(orgId, userId, 'pack.auditor_reading', { pack: packId, auditor: input.auditor.trim(), chars: input.statement.trim().length });
  factory(db).readings[packId] = { at: r.ts, by: userId, auditor: input.auditor.trim(), statement: input.statement.trim(), seq: r.seq };
  touch(orgId, 'pack');
  return factory(db).readings[packId]!;
}

export const reading = (orgId: string, packId: PackId) => factory(getDB(orgId)).readings[packId];

/** Evaluate T1–T8 for a pack in this organisation. `live` runs the verifier for T5–T7 (L2+). */
export function evaluateTests(orgId: string, packId: PackId, live = false): PackTestResult[] {
  const db = getDB(orgId);
  const pk = PACKS.find((p) => p.id === packId)!;
  const st = factory(db);
  const res = (id: PackTestId, state: PackTestResult['state'], detail: string): PackTestResult => ({ ...PACK_TESTS.find((t) => t.id === id)!, state, detail });
  const out: PackTestResult[] = [];
  // T1
  const off = DECLARED_OFF[packId];
  const skipped = NEVER_SKIPPABLE.filter((g) => off.includes(g));
  const wtNames = PACK_WRITE_TYPES[packId].map((w) => w.name);
  const missingWt = pk.declaration.writeTypes.filter((w) => !wtNames.includes(w));
  const blank = !pk.declaration.fields.length || !pk.declaration.id;
  out.push(res('T1', skipped.length || missingWt.length || blank ? 'fail' : 'pass', skipped.length ? `${skipped.join(', ')} declared off, but never skippable.` : missingWt.length ? `${missingWt.join(', ')} have no blast radius or reversal plan.` : `${pk.declaration.id}: ${pk.declaration.writeTypes.length} write types, the 6 never-skippable checks present, ${off.join(', ')} declared off.`));
  // T2
  const prof = decorateProfile(orgId, profileById(pk.profileId)!);
  const conf = conformance(orgId, pk.profileId);
  const open = conf.filter((c) => c.state !== 'pass');
  const issued = prof.status === 'certified';
  out.push(res('T2', issued && prof.author && prof.certifier && prof.author !== prof.certifier && !open.length ? 'pass' : 'fail',
    !issued ? `${prof.name} is ${prof.status === 'withdrawn' ? 'withdrawn' : prof.status}; the pack ships only with an issued profile.` : open.length ? `P1–P12: ${open.map((c) => c.id).join(', ')} not passed.` : `${prof.name} v${prof.version}: P1–P12 pass; author ${prof.author}, issuer ${prof.certifier}.`));
  // T3
  const d = st.drills[packId] ?? {};
  const rev = PACK_WRITE_TYPES[packId].filter((w) => w.reversible);
  const undrilled = rev.filter((w) => !d[w.name]);
  out.push(res('T3', undrilled.length ? 'fail' : 'pass', undrilled.length ? `${undrilled.length} of ${rev.length} reversal plans have never been run: ${undrilled.map((w) => w.name).join(', ')}. A plan nobody has run is a plan that does not exist.` : `${rev.length} reversal plans run in dated drills; ${PACK_WRITE_TYPES[packId].length - rev.length} write types declared irreversible.`));
  // T4
  const declared = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'].filter((g) => !off.includes(g));
  const fx = PACK_FIXTURE_REFUSALS[packId];
  // each reference refusal must carry a code the platform emits: in the core register, at the rung the register names
  const inRegister = (x: (typeof fx)[number]) => {
    const c = CORE_CODES.find((k) => k.wire === x.code);
    return !!c && RUNGS[c.rung].n === String(x.rung);
  };
  const offRegister = fx.filter((x) => !inRegister(x));
  const uncovered = declared.filter((g) => !fx.some((x) => x.gate === g && x.code && x.operatorAction && inRegister(x)));
  const realRefusals = db.receipts.filter((r) => PACK_MATCH[packId](r) && r.decision === 'refuse').length;
  out.push(res('T4', uncovered.length ? 'fail' : 'pass', uncovered.length ? `No reference refusal from the refusal register for ${uncovered.join(', ')}.${offRegister.length ? ` Not in the register, or at the wrong rung: ${offRegister.map((x) => `${x.code} (rung ${x.rung})`).join(', ')}.` : ''}` : `${fx.length} reference refusals, one per declared pre-write check, each with a register code raised at rung ${RUNGS.checks.n} (${RUNGS.checks.name.toLowerCase()}) and an operator action. ${realRefusals} real refusals on this chain for the pack’s write types.`));
  // T5–T7
  if (!atLeast(levelOfOrg(db.org), 'l2')) {
    for (const id of ['T5', 'T6', 'T7'] as const) out.push(res(id, 'not_applicable', `Not applicable — assurance level 1. ${id === 'T5' ? 'An L2 evidence bundle and the six-code verifier start at L2 Attested.' : 'Runs against an L2 evidence bundle.'}`));
  } else {
    const prev = st.testRuns[packId]?.results;
    if (live) {
      const f = fixtureRuns(db, pk.profileId);
      out.push(res('T5', f.good.exitCode === 0 ? 'pass' : 'fail', `${fixtureLabel(f.good.code, f.good.exitCode)} on ${f.range}, in this browser with no network.${f.good.exitCode === 2 ? ` ${f.good.headline}` : ''}`));
      out.push(res('T6', f.tampered.exitCode === 1 ? 'pass' : 'fail', `${fixtureLabel(f.tampered.code, f.tampered.exitCode)}; record #${f.tamperedSeq} was edited.`));
      out.push(res('T7', f.nonconforming.exitCode === 2 ? 'pass' : 'fail', `${fixtureLabel(f.nonconforming.code, f.nonconforming.exitCode)} for a sound bundle with its checkpoints left out.`));
    } else {
      for (const id of ['T5', 'T6', 'T7'] as const) out.push(prev?.find((x) => x.id === id) ?? res(id, 'not_run', 'Run the tests to verify a bundle offline.'));
    }
  }
  // T8
  const rd = st.readings[packId];
  out.push(res('T8', rd ? 'pass' : 'not_run', rd ? `${rd.auditor}: “${rd.statement.slice(0, 140)}${rd.statement.length > 140 ? '…' : ''}”` : 'The named auditor has not yet read a report and said what it does not prove.'));
  return out;
}

export function runPackTests(orgId: string, packId: PackId, userId: string): PackTestRun {
  const db = getDB(orgId);
  // recorded on the client's chain (pack.tests_run) and not a J9 step: owners and admins only
  requireRoles(orgId, userId, ['owner', 'admin'], 'Running the acceptance tests');
  const results = evaluateTests(orgId, packId, true);
  const r = logAdmin(orgId, userId, 'pack.tests_run', { pack: packId, passed: results.filter((x) => x.state === 'pass').length, failed: results.filter((x) => x.state === 'fail').length, not_run: results.filter((x) => x.state === 'not_run').length, not_applicable: results.filter((x) => x.state === 'not_applicable').length, failing: results.filter((x) => x.state === 'fail').map((x) => x.id).join(',') || 'none' });
  const run: PackTestRun = { at: r.ts, by: userId, results, seq: r.seq };
  factory(db).testRuns[packId] = run;
  touch(orgId, 'pack');
  return run;
}

export function lastTestRun(orgId: string, packId: PackId) { return factory(getDB(orgId)).testRuns[packId]; }

/* ══ Seeding: once per organisation ══════════════════════════════════════ */

/**
 * Seed what the demo organisations show: profile orders for the packs installed at L2+ (written to the chain once),
 * and the pilots, drills and auditor readings each level would have by now. Sign-up organisations get nothing.
 */
export function ensureSeed(orgId: string) {
  const db = getDB(orgId);
  if (db.fresh) return;
  const st = factory(db);
  const level = levelOfOrg(db.org);
  if (!st.ordersSeeded) {
    st.ordersSeeded = true;
    if (atLeast(level, 'l2')) {
      const orders = activeProfileOrders(db);
      const owner = ownerOf(db);
      for (const inst of db.platform.packs) {
        const pid = PACKS.find((p) => p.id === inst.id)?.profileId;
        if (pid && !orders.has(pid)) logAdmin(orgId, owner, 'billing.addon_ordered', { addon: 'profile', profile: pid, price_per_year: PROFILE_PRICE, with_pack: inst.id });
      }
      deriveBilling(db);
    }
  }
  if (st.seeded) { alignSeededInstalls(db, st); return; }
  seedOnce(orgId, db, st, level);
  alignSeededInstalls(db, st);
}

/**
 * A pilot that starts at L1 runs on a dry-run install made before day 0 (startPilot requires the install). The seeded
 * L1 pilots start the day before the move to L2, so their pack's install is placed on the morning of day 0 at L1.
 */
function alignSeededInstalls(db: OrgDB, st: FactoryState) {
  if (st.installsAligned) return;
  st.installsAligned = true;
  for (const p of Object.values(st.pilots)) {
    if (!p || p.startSeq !== undefined || p.startLevel !== 'l1') continue; // only the seeded pilots that started at L1
    const inst = db.platform.packs.find((x) => x.id === p.packId);
    const before = new Date(p.startedAt).getTime() - 2 * 3_600_000;
    if (inst && new Date(inst.installedAt).getTime() > before) inst.installedAt = iso(before);
  }
}

function seedOnce(orgId: string, db: OrgDB, st: FactoryState, level: LevelId) {
  st.seeded = true;
  const now = Date.now();
  const auditor = auditorOf(db) ?? ownerOf(db);
  const owner = ownerOf(db);
  const drillAll = (packId: PackId, daysAgo: number, only?: number) => {
    const rev = PACK_WRITE_TYPES[packId].filter((w) => w.reversible).slice(0, only);
    st.drills[packId] = Object.fromEntries(rev.map((w, i) => [w.name, { at: iso(now - (daysAgo - i) * D), by: owner, note: `Reversal plan run on a test record: ${w.reversal}` }]));
  };
  const necessity = (at: number) => ({
    questions: ['Can you show me every change to the books in the year, including the ones refused?', 'How do I know the trail was never switched off between two dates?', 'Can I check it without asking you or the vendor for anything?'],
    statement: 'I would need every governed change with its actor and approver, a way to see that nothing is missing at the end, and a check I can run myself on my own machine.',
    notMeasurable: [{ clause: 'Changes made directly in the accounting system', reason: 'Edits made in the accounting system itself never pass through the governed route.', wouldChangeIf: 'The bundle carries the accounting system’s own audit trail for the period.' }],
    at: iso(at), by: auditor,
  });
  if (orgId === 'org_northbank' && db.platform.packs.some((p) => p.id === 'ledger1')) {
    const l2 = levelStart(db, 'l2') ?? now - 45 * D;
    const start = l2 - D;
    st.pilots.ledger1 = { packId: 'ledger1', customer: db.org.name, auditor: { name: 'Kavita Desai', firm: 'Desai & Rao, Chartered Accountants' }, startedAt: iso(start), startedBy: owner, startLevel: 'l1', status: 'running', necessity: necessity(start + 3 * 3_600_000) };
    drillAll('ledger1', 30, 4);
  }
  if (orgId === 'org_kaveri') {
    const l2 = levelStart(db, 'l2') ?? now - 120 * D;
    const start = l2 - D;
    const day = (n: number) => iso(start + n * D + 5 * 3_600_000);
    st.pilots.ledger1 = {
      packId: 'ledger1', customer: db.org.name, auditor: { name: 'Kavita Desai', firm: 'Desai & Rao, Chartered Accountants' }, startedAt: iso(start), startedBy: owner, startLevel: 'l1', status: 'closed', necessity: necessity(start + 3 * 3_600_000),
      selfExport: { at: day(76), by: owner, help: false, note: '', receipts: 412, firstSeq: db.receipts[0]?.seq ?? 1, lastSeq: (db.receipts[0]?.seq ?? 1) + 411 },
      airGap: { at: day(77), by: auditor, goodCode: 'PASS', goodExit: 0, tamperedCode: 'FAIL_INTEGRITY', tamperedExit: 1, tamperedAt: 'a record in the middle of the range' },
      verdict: { at: day(80), by: auditor, auditor: 'Kavita Desai', outcome: 'relies_with_limits', words: 'I can rely on the bundle for changes made through the governed route. It does not show edits made directly in the accounting system; the reconciliation found 2, both explained. I would report on the trail with that limit stated.' },
      gd: { at: day(85), by: owner, answer: 'yes', note: 'Yes — we would pay for the audit-trail evidence on its own line; our auditor asked for it.' },
    };
    st.recons.push({ id: 'rec_seed_kaveri', packId: 'ledger1', at: day(78), by: auditor, source: 'connector', target: `${PACK_TEMPLATE.ledger1.target.name} — ${PACK_TEMPLATE.ledger1.target.trail}`, from: iso(start), to: day(76), chainCommitted: 388, targetChanges: 390, matched: 388, targetOnly: [{ key: 'bill:BILL-8812#direct', recordId: 'bill:BILL-8812', type: 'journal edited in Zoho Books', at: day(40), by: 'Accounts user (direct)' }, { key: 'payment:PAY-3920#direct', recordId: 'payment:PAY-3920', type: 'payment voided in Zoho Books', at: day(61), by: 'Finance controller (direct)' }], chainOnly: [], explained: { 'bill:BILL-8812#direct': { by: owner, at: day(79), note: 'Year-end correction made in the accounting system by the accountant; outside the write path.' }, 'payment:PAY-3920#direct': { by: owner, at: day(79), note: 'Voided by the controller after a bank return; the reversal was re-posted through the governed route.' } } });
    st.readings.ledger1 = { at: day(80), by: auditor, auditor: 'Kavita Desai', statement: 'The report shows every governed change in the range unaltered since it was sealed. It does not prove the books are complete — direct edits in the accounting system are outside it — nor that the transactions were genuine.' };
    drillAll('ledger1', 100);
    if (db.platform.packs.some((p) => p.id === 'collect1')) drillAll('collect1', 90);
  }
  if (orgId === 'org_deccan') {
    const start = now - 70 * D;
    st.pilots.collect1 = { packId: 'collect1', customer: db.org.name, auditor: { name: 'Kavita Desai', firm: 'Desai & Rao, Chartered Accountants' }, startedAt: iso(start), startedBy: owner, startLevel: level, status: 'running', necessity: { ...necessity(start + 2 * 3_600_000), questions: ['Can you show every borrower contact, including the refused ones?', 'How do I know no contact went out before 08:00 or after 19:00?', 'Who approved each final notice, and when?'], statement: 'I would need every contact with the time, the template and the person who approved any final notice, and a check I can run myself.', notMeasurable: [{ clause: 'What was said on recovery calls', reason: 'The record holds that a call was placed and when, not what was said.', wouldChangeIf: 'A call-recording digest is bound into each contact record.' }] } };
    for (const p of db.platform.packs) drillAll(p.id, 60);
    st.readings.ledger1 = { at: iso(now - 40 * D), by: auditor, auditor: 'Kavita Desai', statement: 'The report shows the governed changes to the books, unaltered and timestamped. It does not prove the books are complete or that any transaction was genuine; that remains for the statutory audit.' };
  }
}
