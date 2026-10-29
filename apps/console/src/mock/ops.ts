/**
 * Work door — safety and operations state (mock backend).
 *
 * Dual control on lifting the emergency stop (from L2), break-glass emergency access (two people at every level),
 * incidents declared by hand (key compromise, isolation breach and the rest), the CERT-In six-hour reporting clock,
 * receipt-write failures (from L1), approver telemetry and the sampling of an approver's past approvals.
 *
 * Every change is a receipt on the organisation's chain (append), and the state lives on the organisation's record
 * (`opsExt`, optional and defaulted on read, so a saved browser state from before this module still loads).
 */
import type { Approval, Incident, LevelId, Receipt } from '@/types';
import { addCallGate, append, engageStop as dbEngageStop, getDB, liftStop as dbLiftStop, memberRole, persist, setAgentStatus, touch, type OrgDB } from './db';
import { ORGS, userById, userName, USERS } from './users';
import { atLeast, levelOfOrg } from '@/lib/levels';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const ms = (s: string) => new Date(s).getTime();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ── Types ─────────────────────────────────────────────────── */

export interface LiftRequest {
  id: string;
  incidentId: string;
  requestedBy: string;
  requestedAt: string;
  note: string;
  checks: number;
  /** absent on seeded history recorded before this demonstration */
  requestSeq?: number;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  decisionSeq?: number;
  liftSeq?: number;
  /** seeded history: recorded before this demonstration, so it carries no receipt numbers */
  seeded?: boolean;
}

export type BreakGlassStatus = 'pending' | 'active' | 'declined' | 'withdrawn' | 'ended' | 'expired';

export interface BreakGlass {
  id: string;
  /** the person who gets emergency access */
  forUser: string;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  minutes: number;
  requestSeq?: number;
  status: BreakGlassStatus;
  approvedBy?: string;
  approvedAt?: string;
  approveSeq?: number;
  expiresAt?: string;
  endedAt?: string;
  endedBy?: string;
  endSeq?: number;
  declineReason?: string;
  /** seeded history: recorded before this demonstration, so it carries no receipt numbers */
  seeded?: boolean;
}

export interface CertInDraft {
  category: string;
  summary: string;
  systems: string;
  indicators: string;
  actions: string;
  contactName: string;
  contactEmail: string;
}

export interface CertInReport {
  incidentId: string;
  noticedAt: string;
  dueAt: string;
  draft: CertInDraft;
  draftSavedAt?: string;
  draftSavedBy?: string;
  draftSeq?: number;
  submittedAt?: string;
  submittedBy?: string;
  submitSeq?: number;
  method?: 'email' | 'portal';
  reference?: string;
  late?: boolean;
  notReportable?: { by: string; at: string; reason: string; seq?: number };
}

export interface WriteFailure {
  id: string;
  at: string;
  endedAt?: string;
  error: string;
  source: 'probe' | 'drill';
  by?: string;
  /** agent calls the guard refused while the writer was failed: none ran, none could be written then */
  refused?: number;
  calls?: { ts: string; agent: string; tool: string }[];
  /** the receipt written when the writer was back (health.drill_ended or health.write_recovered) */
  recoveredSeq?: number;
}

export interface ApproverSample {
  id: string;
  approverId: string;
  drawnBy: string;
  drawnAt: string;
  drawSeq?: number;
  reason: string;
  approvalIds: string[];
  reviews: { approvalId: string; by: string; at: string; ok: boolean; note: string; seq?: number }[];
  status: 'open' | 'closed';
  closedAt?: string;
  closeSeq?: number;
}

interface OpsExt {
  v: 1;
  seededAt: string;
  lifts: LiftRequest[];
  breakGlass: BreakGlass[];
  certIn: Record<string, CertInReport>;
  /** approval id → who opened its full record in the console, and when */
  opened: Record<string, { userId: string; at: string }[]>;
  samples: ApproverSample[];
  writeFailures: WriteFailure[];
  /** version of the seeded two-person stop-lift history (added after the first seed, so saved states get it too) */
  liftSeed?: number;
}

type X = OrgDB & { opsExt?: OpsExt };

/* ── State ─────────────────────────────────────────────────── */

function ext(orgId: string): OpsExt {
  const d = getDB(orgId) as X;
  if (!d.opsExt) {
    d.opsExt = { v: 1, seededAt: iso(Date.now()), lifts: [], breakGlass: [], certIn: {}, opened: {}, samples: [], writeFailures: [] };
    try { seed(d); } catch { /* seeding never breaks the console */ }
    persist(d.org.id);
  }
  const x = d.opsExt;
  x.lifts ??= [];
  x.breakGlass ??= [];
  x.certIn ??= {};
  x.opened ??= {};
  x.samples ??= [];
  x.writeFailures ??= [];
  // older saved data: the seeded Demo Traders sample was drawn and reviewed by the same person
  for (const s of x.samples) {
    if (s.id === 'smp_seed_demo' && s.reviews.some((v) => v.by === s.drawnBy) && s.approverId !== 'u_rahul' && s.drawnBy !== 'u_rahul') s.drawnBy = 'u_rahul';
  }
  // the two-person stop-lift history: written after the organisation's records open, never during a render
  if ((x.liftSeed ?? 0) < LIFT_SEED && !d.fresh && !liftSeedQueued.has(d.org.id)) {
    liftSeedQueued.add(d.org.id);
    const orgId = d.org.id;
    const run = () => { try { seedLifts(orgId); } catch { /* seeding never breaks the console */ } };
    if (typeof window !== 'undefined') window.setTimeout(run, 0); else run();
  }
  return x;
}

const LIFT_SEED = 1;
const liftSeedQueued = new Set<string>();

/** Make sure the organisation's operations state (and its seeded history) exists. Safe to call often. */
export function ensureOps(orgId: string) {
  ext(orgId);
}

const levelOf = (orgId: string): LevelId => levelOfOrg(getDB(orgId).org);
const isOwnerAdmin = (orgId: string, userId?: string) => { const r = memberRole(orgId, userId); return r === 'owner' || r === 'admin'; };
function requireOwnerAdmin(orgId: string, userId: string, what: string) {
  if (!isOwnerAdmin(orgId, userId)) throw new Error(`${what} Owners and admins do this; your role cannot.`);
}
/** Active owners and admins of the organisation (the people who can be the second person). */
export function ownersAndAdmins(orgId: string): string[] {
  return getDB(orgId).members.filter((m) => m.status === 'active' && (m.role === 'owner' || m.role === 'admin')).map((m) => m.userId);
}
const incidentOf = (d: OrgDB, id?: string) => d.incidents.find((i) => i.id === id);

/* ══ Emergency stop: dual control on the lift ════════════════ */

/**
 * Engaging the stop is one person at every level (safety first). Lifting it needs a second, different owner or
 * admin from L2 Attested up, Sovereign included. At L1 one owner or admin lifts it.
 */
export function liftNeedsSecond(orgId: string) {
  return atLeast(levelOf(orgId), 'l2');
}

export function liftRequests(orgId: string, incidentId?: string): LiftRequest[] {
  return clone(ext(orgId).lifts.filter((l) => !incidentId || l.incidentId === incidentId));
}

/** The lift request waiting for a second person on the current stop, if any. */
export function pendingLift(orgId: string): LiftRequest | undefined {
  const d = getDB(orgId);
  if (!d.stop.active) return undefined;
  const l = ext(orgId).lifts.find((x) => x.status === 'pending' && x.incidentId === d.stop.incidentId);
  return l ? clone(l) : undefined;
}

/** The owners and admins who could approve a lift asked for by this person (everyone active in that role but them). */
export function liftApprovers(orgId: string, requesterId?: string): string[] {
  return ownersAndAdmins(orgId).filter((u) => u !== requesterId);
}

export const NO_SECOND_FOR_LIFT = 'A second owner or admin approves the lift at this level, and this organisation has no other active owner or admin. Invite one in People and roles; once they accept, ask again and they approve it.';

export function requestLift(orgId: string, userId: string, note: string, checks: number): LiftRequest {
  requireOwnerAdmin(orgId, userId, 'Asking to lift the emergency stop.');
  const d = getDB(orgId);
  if (!d.stop.active || !d.stop.incidentId) throw new Error('No emergency stop is engaged.');
  if (!liftNeedsSecond(orgId)) throw new Error('At L1 Guarded one owner or admin lifts the stop; no second person is needed.');
  const open = pendingLift(orgId);
  if (open) throw new Error(`${userName(open.requestedBy)} already asked to lift this stop. A different owner or admin approves or declines that request.`);
  // dual control needs a second person who can actually approve: a request nobody can decide is refused
  if (!liftApprovers(orgId, userId).length) throw new Error(NO_SECOND_FOR_LIFT);
  if (note.trim().length < 8) throw new Error('Write what was found and what changed — at least a sentence.');
  const x = ext(orgId);
  const r = append(d, { kind: 'admin', actor: userId, action: 'stop.lift_requested', details: { incident: d.stop.incidentId, note: note.trim(), checks, level: levelOf(orgId) } });
  const req: LiftRequest = { id: `lift_${Date.now().toString(36)}`, incidentId: d.stop.incidentId, requestedBy: userId, requestedAt: r.ts, note: note.trim(), checks, requestSeq: r.seq, status: 'pending' };
  x.lifts.unshift(req);
  incidentOf(d, d.stop.incidentId)?.timeline.push({ ts: r.ts, text: `Lift requested by ${userName(userId)}: “${note.trim()}”. A different owner or admin must approve it before any agent resumes.`, seq: r.seq, actor: userId });
  touch(orgId, 'stop');
  return clone(req);
}

export function approveLift(orgId: string, id: string, userId: string, note = ''): LiftRequest {
  requireOwnerAdmin(orgId, userId, 'Approving the lift of the emergency stop.');
  const d = getDB(orgId);
  const req = ext(orgId).lifts.find((l) => l.id === id);
  if (!req || req.status !== 'pending') throw new Error('This lift request is no longer waiting.');
  if (req.requestedBy === userId) throw new Error('Dual control: the person who asked to lift the stop cannot also approve it. A different owner or admin approves.');
  if (!d.stop.active || d.stop.incidentId !== req.incidentId) throw new Error('This stop is no longer engaged.');
  const r = append(d, { kind: 'admin', actor: userId, action: 'stop.lift_approved', details: { incident: req.incidentId, request: req.id, requested_by: req.requestedBy, ...(req.requestSeq !== undefined ? { request_seq: req.requestSeq } : {}), ...(note.trim() ? { note: note.trim() } : {}) } });
  incidentOf(d, req.incidentId)?.timeline.push({ ts: r.ts, text: `Lift approved by ${userName(userId)}, the second person${note.trim() ? `: “${note.trim()}”` : ''}.`, seq: r.seq, actor: userId });
  Object.assign(req, { status: 'approved', decidedBy: userId, decidedAt: r.ts, decisionNote: note.trim() || undefined, decisionSeq: r.seq });
  dbLiftStop(orgId, userId, `${req.note} (requested by ${userName(req.requestedBy)}, approved by ${userName(userId)})`);
  req.liftSeq = d.receipts[d.receipts.length - 1].seq;
  persist(orgId);
  return clone(req);
}

export function declineLift(orgId: string, id: string, userId: string, reason: string): LiftRequest {
  requireOwnerAdmin(orgId, userId, 'Declining the lift of the emergency stop.');
  const d = getDB(orgId);
  const req = ext(orgId).lifts.find((l) => l.id === id);
  if (!req || req.status !== 'pending') throw new Error('This lift request is no longer waiting.');
  if (req.requestedBy === userId) throw new Error('You asked for this lift. Withdraw it instead.');
  if (reason.trim().length < 8) throw new Error('Say why the stop should stay on — at least a sentence.');
  const r = append(d, { kind: 'admin', actor: userId, action: 'stop.lift_declined', details: { incident: req.incidentId, request: req.id, requested_by: req.requestedBy, reason: reason.trim() } });
  incidentOf(d, req.incidentId)?.timeline.push({ ts: r.ts, text: `Lift declined by ${userName(userId)}: “${reason.trim()}”. The stop stays on.`, seq: r.seq, actor: userId });
  Object.assign(req, { status: 'declined', decidedBy: userId, decidedAt: r.ts, decisionNote: reason.trim(), decisionSeq: r.seq });
  touch(orgId, 'stop');
  return clone(req);
}

export function withdrawLift(orgId: string, id: string, userId: string): LiftRequest {
  const d = getDB(orgId);
  const req = ext(orgId).lifts.find((l) => l.id === id);
  if (!req || req.status !== 'pending') throw new Error('This lift request is no longer waiting.');
  if (req.requestedBy !== userId) throw new Error('Only the person who asked can withdraw the request.');
  const r = append(d, { kind: 'admin', actor: userId, action: 'stop.lift_withdrawn', details: { incident: req.incidentId, request: req.id } });
  incidentOf(d, req.incidentId)?.timeline.push({ ts: r.ts, text: `Lift request withdrawn by ${userName(userId)}.`, seq: r.seq, actor: userId });
  Object.assign(req, { status: 'withdrawn', decidedBy: userId, decidedAt: r.ts, decisionSeq: r.seq });
  touch(orgId, 'stop');
  return clone(req);
}

/* ══ Break-glass: emergency access, two people, time-boxed ═══ */

export const BREAK_GLASS_MINUTES = [30, 60, 120, 240] as const;

/** Close any active grant whose time is up: a breakglass.expired receipt, written once. */
function sweepBreakGlass(orgId: string) {
  const d = getDB(orgId);
  const now = Date.now();
  let changed = false;
  for (const b of ext(orgId).breakGlass) {
    if (b.status === 'active' && b.expiresAt && ms(b.expiresAt) <= now) {
      b.status = 'expired';
      b.endedAt = b.expiresAt;
      if (!b.seeded) {
        const r = append(d, { kind: 'admin', actor: 'system', action: 'breakglass.expired', details: { grant: b.id, for: b.forUser, minutes: b.minutes } });
        b.endSeq = r.seq;
      }
      changed = true;
    }
  }
  if (changed) persist(orgId);
}

export function breakGlassList(orgId: string): BreakGlass[] {
  sweepBreakGlass(orgId);
  return clone(ext(orgId).breakGlass).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** The active emergency-access grant for a person, if any (it lets them sign in with a password while SSO is enforced). */
export function breakGlassActiveFor(orgId: string, userId?: string): BreakGlass | undefined {
  if (!userId) return undefined;
  const now = Date.now();
  const b = ext(orgId).breakGlass.find((g) => g.forUser === userId && g.status === 'active' && (!g.expiresAt || ms(g.expiresAt) > now));
  return b ? clone(b) : undefined;
}

/** For the sign-in page: does an active break-glass grant let this address sign in with a password? */
export function breakGlassAllowsEmail(orgId: string, email: string): boolean {
  const u = USERS.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
  return !!u && !!breakGlassActiveFor(orgId, u.id);
}

export function requestBreakGlass(orgId: string, userId: string, input: { forUser: string; reason: string; minutes: number }): BreakGlass {
  requireOwnerAdmin(orgId, userId, 'Asking for emergency access.');
  if (!isOwnerAdmin(orgId, input.forUser)) throw new Error('Emergency access is only for an active owner or admin of this organisation.');
  if (!BREAK_GLASS_MINUTES.includes(input.minutes as 30)) throw new Error('Choose 30 minutes, 1, 2 or 4 hours.');
  if (input.reason.trim().length < 10) throw new Error('Say why emergency access is needed — at least a sentence. It is recorded.');
  sweepBreakGlass(orgId);
  const x = ext(orgId);
  if (x.breakGlass.some((b) => b.forUser === input.forUser && (b.status === 'pending' || b.status === 'active'))) throw new Error(`${userName(input.forUser)} already has emergency access waiting or active.`);
  const others = ownersAndAdmins(orgId).filter((u) => u !== userId && u !== input.forUser);
  if (!others.length) throw new Error('A second owner or admin must approve emergency access, and this organisation has no other. Invite one in People and roles.');
  const d = getDB(orgId);
  const r = append(d, { kind: 'admin', actor: userId, action: 'breakglass.requested', details: { for: input.forUser, minutes: input.minutes, reason: input.reason.trim() } });
  const b: BreakGlass = { id: `bg_${Date.now().toString(36)}`, forUser: input.forUser, requestedBy: userId, requestedAt: r.ts, reason: input.reason.trim(), minutes: input.minutes, requestSeq: r.seq, status: 'pending' };
  x.breakGlass.unshift(b);
  touch(orgId, 'session');
  return clone(b);
}

export function approveBreakGlass(orgId: string, id: string, userId: string): BreakGlass {
  requireOwnerAdmin(orgId, userId, 'Approving emergency access.');
  const b = ext(orgId).breakGlass.find((g) => g.id === id);
  if (!b || b.status !== 'pending') throw new Error('This request is no longer waiting.');
  if (b.requestedBy === userId || b.forUser === userId) throw new Error('Dual control: a second person approves emergency access — not the person who asked, and not the person who gets it.');
  const d = getDB(orgId);
  const expiresAt = iso(Date.now() + b.minutes * M);
  const r = append(d, { kind: 'admin', actor: userId, action: 'breakglass.approved', details: { grant: b.id, for: b.forUser, requested_by: b.requestedBy, minutes: b.minutes, expires_at: expiresAt } });
  Object.assign(b, { status: 'active', approvedBy: userId, approvedAt: r.ts, approveSeq: r.seq, expiresAt });
  touch(orgId, 'session');
  return clone(b);
}

export function declineBreakGlass(orgId: string, id: string, userId: string, reason: string): BreakGlass {
  requireOwnerAdmin(orgId, userId, 'Declining emergency access.');
  const b = ext(orgId).breakGlass.find((g) => g.id === id);
  if (!b || b.status !== 'pending') throw new Error('This request is no longer waiting.');
  if (b.requestedBy === userId) throw new Error('You asked for this. Withdraw it instead.');
  if (reason.trim().length < 6) throw new Error('Say why — it is recorded.');
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'breakglass.declined', details: { grant: b.id, for: b.forUser, reason: reason.trim() } });
  Object.assign(b, { status: 'declined', declineReason: reason.trim(), endedAt: r.ts, endedBy: userId, endSeq: r.seq });
  touch(orgId, 'session');
  return clone(b);
}

export function withdrawBreakGlass(orgId: string, id: string, userId: string): BreakGlass {
  const b = ext(orgId).breakGlass.find((g) => g.id === id);
  if (!b || b.status !== 'pending') throw new Error('This request is no longer waiting.');
  if (b.requestedBy !== userId) throw new Error('Only the person who asked can withdraw it.');
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'breakglass.withdrawn', details: { grant: b.id, for: b.forUser } });
  Object.assign(b, { status: 'withdrawn', endedAt: r.ts, endedBy: userId, endSeq: r.seq });
  touch(orgId, 'session');
  return clone(b);
}

/** End active emergency access early: the person who has it, or any owner or admin. */
export function endBreakGlass(orgId: string, id: string, userId: string): BreakGlass {
  sweepBreakGlass(orgId);
  const b = ext(orgId).breakGlass.find((g) => g.id === id);
  if (!b || b.status !== 'active') throw new Error('This emergency access is not active.');
  if (b.forUser !== userId) requireOwnerAdmin(orgId, userId, 'Ending emergency access.');
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'breakglass.ended', details: { grant: b.id, for: b.forUser, minutes_used: Math.max(1, Math.round((Date.now() - ms(b.approvedAt ?? b.requestedAt)) / M)) } });
  Object.assign(b, { status: 'ended', endedAt: r.ts, endedBy: userId, endSeq: r.seq });
  touch(orgId, 'session');
  return clone(b);
}

/* ══ Incidents declared by hand, and the CERT-In clock ═══════ */

export type DeclaredClass = 'key_compromise' | 'isolation_breach' | 'receipt_write' | 'chain_break' | 'security_other';

export const CERT_IN_HOURS = 6;
/** CERT-In Directions of 28 April 2022, Annexure I categories that fit each class. */
export const CERT_IN_CATEGORY: Record<DeclaredClass, string> = {
  key_compromise: 'Compromise of critical systems or information',
  isolation_breach: 'Unauthorised access of IT systems or data',
  security_other: 'Attacks or suspicious activity affecting systems, servers or applications',
  chain_break: 'Attacks or suspicious activity affecting systems, servers or applications',
  receipt_write: 'Attacks or suspicious activity affecting systems, servers or applications',
};
/** Classes that start the six-hour clock on their own; the others start it when the person declaring says so. */
export const CERT_IN_ALWAYS: DeclaredClass[] = ['key_compromise', 'isolation_breach'];

export function certInOf(orgId: string, incidentId: string): CertInReport | undefined {
  const c = ext(orgId).certIn[incidentId];
  return c ? clone(c) : undefined;
}

export function certInAll(orgId: string): CertInReport[] {
  return clone(Object.values(ext(orgId).certIn));
}

function prefill(d: OrgDB, inc: Incident, cls: DeclaredClass, userId: string): CertInDraft {
  const u = userById(userId);
  return {
    category: CERT_IN_CATEGORY[cls],
    summary: `${inc.title}. ${inc.reason}`.trim(),
    systems: inc.agentSlugs.length ? `Elan1 Govern (${d.org.name}); agents ${inc.agentSlugs.join(', ')}` : `Elan1 Govern (${d.org.name})`,
    indicators: '',
    actions: inc.agentSlugs.length ? 'Affected agents paused; every call they make is refused and recorded.' : '',
    contactName: u?.name ?? '',
    contactEmail: u?.email ?? '',
  };
}

function openCertIn(d: OrgDB, inc: Incident, cls: DeclaredClass, userId: string) {
  const x = ext(d.org.id);
  if (x.certIn[inc.id]) return x.certIn[inc.id];
  const rep: CertInReport = { incidentId: inc.id, noticedAt: inc.startedAt, dueAt: iso(ms(inc.startedAt) + CERT_IN_HOURS * H), draft: prefill(d, inc, cls, userId) };
  x.certIn[inc.id] = rep;
  return rep;
}

export interface DeclareInput {
  cls: DeclaredClass;
  title: string;
  what: string;
  noticedAt: string;
  agents: string[];
  pause: boolean;
  certIn: boolean;
}

export function declareIncident(orgId: string, input: DeclareInput, userId: string): Incident {
  requireOwnerAdmin(orgId, userId, 'Declaring an incident.');
  const d = getDB(orgId);
  const title = input.title.trim();
  const what = input.what.trim();
  if (title.length < 4) throw new Error('Give the incident a short title.');
  if (what.length < 10) throw new Error('Say what happened — at least a sentence.');
  const noticed = ms(input.noticedAt);
  if (!Number.isFinite(noticed)) throw new Error('Give the time it was noticed.');
  if (noticed > Date.now() + M) throw new Error('The time it was noticed cannot be in the future.');
  if (Date.now() - noticed > 7 * D) throw new Error('Declare incidents noticed in the last seven days. Older ones belong in the incident report of the period.');
  const reportable = input.certIn || CERT_IN_ALWAYS.includes(input.cls);
  const id = `inc_d_${Date.now().toString(36)}`;
  const r = append(d, { kind: 'admin', actor: userId, action: 'incident.declared', details: { incident: id, class: input.cls, title, noticed_at: iso(noticed), agents: input.agents.length, cert_in: reportable } });
  const inc: Incident & { subkind?: string; declared?: boolean } = {
    id, title, kind: 'health', subkind: input.cls, declared: true, status: 'active', scope: input.agents.length ? 'selected_agents' : 'all_agents', agentSlugs: [...input.agents],
    startedAt: iso(noticed), startedBy: userId, reason: what, refusedWhileStopped: 0, pendingApprovalsAtStop: 0,
    timeline: [
      { ts: iso(noticed), text: 'Noticed', actor: userId },
      { ts: r.ts, text: `Declared by hand by ${userName(userId)}`, seq: r.seq, actor: userId },
    ],
  };
  d.incidents.unshift(inc);
  if (input.pause) {
    for (const slug of input.agents) {
      const a = d.agents.find((x) => x.slug === slug);
      if (a && a.status === 'active') {
        setAgentStatus(orgId, slug, 'paused', userId, `Incident ${id}: ${title}`);
        const pr = d.receipts[d.receipts.length - 1];
        inc.timeline.push({ ts: pr.ts, text: `${slug} paused`, seq: pr.seq, actor: userId });
      }
    }
  }
  if (reportable) {
    const rep = openCertIn(d, inc, input.cls, userId);
    inc.timeline.push({ ts: r.ts, text: `CERT-In reporting clock started: report due by ${new Date(rep.dueAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })} IST (six hours from notice).` });
  }
  touch(orgId, 'incident');
  return clone(inc);
}

export function saveCertInDraft(orgId: string, incidentId: string, draft: CertInDraft, userId: string): CertInReport {
  requireOwnerAdmin(orgId, userId, 'Editing the CERT-In report.');
  const rep = ext(orgId).certIn[incidentId];
  if (!rep) throw new Error('This incident has no CERT-In report.');
  if (rep.submittedAt) throw new Error('The report was already submitted. Record a follow-up with CERT-In directly.');
  const filled = Object.values(draft).filter((v) => v.trim()).length;
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'incident.certin_draft_saved', details: { incident: incidentId, fields_filled: filled, due_at: rep.dueAt } });
  Object.assign(rep, { draft: { ...draft }, draftSavedAt: r.ts, draftSavedBy: userId, draftSeq: r.seq });
  touch(orgId, 'incident');
  return clone(rep);
}

export function submitCertIn(orgId: string, incidentId: string, input: { method: 'email' | 'portal'; reference: string; draft: CertInDraft }, userId: string): CertInReport {
  requireOwnerAdmin(orgId, userId, 'Recording the CERT-In submission.');
  const d = getDB(orgId);
  const rep = ext(orgId).certIn[incidentId];
  if (!rep) throw new Error('This incident has no CERT-In report.');
  if (rep.submittedAt) throw new Error('The submission is already recorded.');
  const dr = input.draft;
  const missing = (['category', 'summary', 'systems', 'actions', 'contactName', 'contactEmail'] as (keyof CertInDraft)[]).filter((k) => !dr[k].trim());
  if (missing.length) throw new Error('Fill in the category, what happened, the systems affected, the actions taken and the point of contact before recording the submission.');
  if (input.reference.trim().length < 4) throw new Error('Give the acknowledgement or reference CERT-In returned, or the sent time of the email.');
  const now = Date.now();
  const late = now > ms(rep.dueAt);
  const hours = Math.round(((now - ms(rep.noticedAt)) / H) * 10) / 10;
  const r = append(d, { kind: 'admin', actor: userId, action: 'incident.certin_submitted', details: { incident: incidentId, method: input.method, reference: input.reference.trim(), category: dr.category, due_at: rep.dueAt, hours_after_notice: hours, late } });
  Object.assign(rep, { draft: { ...dr }, submittedAt: r.ts, submittedBy: userId, submitSeq: r.seq, method: input.method, reference: input.reference.trim(), late });
  incidentOf(d, incidentId)?.timeline.push({ ts: r.ts, text: `Reported to CERT-In by ${input.method === 'email' ? 'email to incident@cert-in.org.in' : 'the CERT-In portal'} (${input.reference.trim()}), ${hours} hours after notice${late ? ' — after the six-hour deadline' : ', inside six hours'}.`, seq: r.seq, actor: userId });
  touch(orgId, 'incident');
  return clone(rep);
}

export function markCertInNotReportable(orgId: string, incidentId: string, reason: string, userId: string): CertInReport {
  if (memberRole(orgId, userId) !== 'owner') throw new Error('Only an owner can decide an incident is not reportable to CERT-In.');
  const d = getDB(orgId);
  const rep = ext(orgId).certIn[incidentId];
  if (!rep) throw new Error('This incident has no CERT-In report.');
  if (rep.submittedAt) throw new Error('The report was already submitted.');
  const inc = incidentOf(d, incidentId) as (Incident & { subkind?: string }) | undefined;
  if (inc?.subkind && CERT_IN_ALWAYS.includes(inc.subkind as DeclaredClass)) throw new Error('A key compromise or an isolation breach is always reportable to CERT-In within six hours.');
  if (reason.trim().length < 12) throw new Error('Say why it is not reportable — at least a sentence. It is recorded.');
  const r = append(d, { kind: 'admin', actor: userId, action: 'incident.certin_not_reportable', details: { incident: incidentId, reason: reason.trim() } });
  rep.notReportable = { by: userId, at: r.ts, reason: reason.trim(), seq: r.seq };
  inc?.timeline.push({ ts: r.ts, text: `Recorded as not reportable to CERT-In by ${userName(userId)}: “${reason.trim()}”`, seq: r.seq, actor: userId });
  touch(orgId, 'incident');
  return clone(rep);
}

/** Why an incident cannot be resolved yet, for the CERT-In clock. */
export function certInBlocker(orgId: string, incidentId: string): string | undefined {
  const rep = ext(orgId).certIn[incidentId];
  if (!rep || rep.submittedAt || rep.notReportable) return undefined;
  return 'Report it to CERT-In first, or have an owner record why it is not reportable. The incident stays open until then.';
}

/* ══ Receipt-write failures (from L1) ════════════════════════ */

export function writeFailures(orgId: string): WriteFailure[] {
  sweepWriteFailures(orgId);
  return clone(ext(orgId).writeFailures);
}

const WRITE_REFUSAL = 'RECEIPT_WRITE_FAILED';

/** The write failure in force now, if any: a drill inside its two minutes, or a failed probe not yet followed by a good one. */
function writerDownNow(orgId: string): WriteFailure | undefined {
  const now = Date.now();
  return ext(orgId).writeFailures.find((f) => (f.source === 'drill' ? !f.recoveredSeq && !!f.endedAt && ms(f.endedAt) > now : !f.endedAt));
}

/** Is the receipt writer failed right now? (For the guard, the health incident and its resolution.) */
export function receiptWriterDown(orgId: string): WriteFailure | undefined {
  sweepWriteFailures(orgId);
  const f = writerDownNow(orgId);
  return f ? clone(f) : undefined;
}

/**
 * When the writer is back: one receipt carries what happened while it was failed (the calls refused, none run),
 * and a health incident opened during the window gets its incident.opened receipt, marked as written late.
 */
function sweepWriteFailures(orgId: string) {
  const x = ext(orgId);
  const now = Date.now();
  // failures recorded before the guard counted its refusals (no `refused` field) are history and are left as they are
  const done = x.writeFailures.filter((f) => f.refused !== undefined && !f.recoveredSeq && !!f.endedAt && ms(f.endedAt) <= now);
  if (!done.length) return;
  const d = getDB(orgId);
  for (const f of done) {
    const inc = (d.incidents as (Incident & { alertId?: string })[]).find((i) => i.alertId === `as_write_${f.id}`);
    if (inc && !d.receipts.some((r) => r.action === 'incident.opened' && r.details?.incident === inc.id)) {
      const o = append(d, { kind: 'admin', actor: 'system', action: 'incident.opened', details: { incident: inc.id, kind: 'health', subkind: 'receipt_write', alert: `as_write_${f.id}`, opened_at: inc.startedAt, written_after_recovery: true } });
      inc.timeline.push({ ts: o.ts, text: 'The incident.opened receipt is written now that the writer is back (it could not be written while receipts were failing).', seq: o.seq, actor: 'system' });
    }
    const calls = f.calls ?? [];
    const agents = Array.from(new Set(calls.map((c) => c.agent)));
    const r = append(d, {
      kind: 'admin', actor: 'system', action: f.source === 'drill' ? 'health.drill_ended' : 'health.write_recovered',
      details: { kind: 'receipt_write', failed_from: f.at, failed_to: f.endedAt!, refused: f.refused ?? 0, ran: 0, agents: agents.join(', ') || 'none', ...(calls.length ? { first_refused: calls[0].ts, last_refused: calls[calls.length - 1].ts } : {}), ...(inc ? { incident: inc.id } : {}) },
    });
    f.recoveredSeq = r.seq;
    inc?.timeline.push({ ts: r.ts, text: `Receipts are written again. ${f.refused ? `${f.refused} agent ${f.refused === 1 ? 'call was' : 'calls were'} refused while the writer was failed; none ran.` : 'No agent call arrived while the writer was failed.'}`, seq: r.seq, actor: 'system' });
  }
  touch(orgId, 'incident');
}

/**
 * The guard's check, asked before anything else on every agent call: while the receipt writer is failed the call
 * is refused and not run. The refusal cannot be written to the chain then, so it is counted on the failure and
 * written as one receipt when the writer is back.
 */
function writeGate(d: OrgDB, agentSlug: string, tool: string): Receipt | undefined {
  const orgId = d.org.id;
  if (!(d as X).opsExt) return undefined;
  sweepWriteFailures(orgId);
  let f = writerDownNow(orgId);
  // a failed probe is checked again: storage that takes a write closes it
  if (f && f.source === 'probe' && probeReceiptWrites(orgId).ok) f = undefined;
  if (!f) return undefined;
  const ts = iso(Date.now());
  f.refused = (f.refused ?? 0) + 1;
  f.calls = [...(f.calls ?? []), { ts, agent: agentSlug, tool }].slice(-200);
  persist(orgId);
  const head = d.receipts[d.receipts.length - 1];
  return {
    seq: 0, ts, org: orgId, kind: 'decision', agent: agentSlug, tool, decision: 'refuse', rule_id: WRITE_REFUSAL,
    reason: 'Refused: the receipt writer is failed, and the guard runs nothing it cannot record. The refusal is counted and written to the chain when receipts are written again.',
    outcome: { status: 'not_run' }, details: { code: WRITE_REFUSAL, recorded: false, failure: f.id }, prev_hash: head?.hash ?? '', kid: '', hash: '', sig: '',
  } as Receipt;
}
addCallGate(writeGate);

/**
 * Check that the receipt store takes a write: in this demonstration, the browser storage the organisation's chain
 * is saved to. A failure is recorded once and closes when a later check succeeds.
 */
export function probeReceiptWrites(orgId: string): { ok: boolean; error?: string } {
  const x = ext(orgId);
  const open = x.writeFailures.find((f) => f.source === 'probe' && !f.endedAt);
  try {
    const k = 'eg:state:v3:__write_probe';
    localStorage.setItem(k, String(Date.now()));
    localStorage.removeItem(k);
    if (open) { open.endedAt = iso(Date.now()); persist(orgId); }
    return { ok: true };
  } catch (e) {
    const error = `The receipt store refused a write: ${(e as Error).message || 'storage unavailable'}`;
    if (!open) x.writeFailures.unshift({ id: `wf_${Date.now().toString(36)}`, at: iso(Date.now()), error, source: 'probe', refused: 0, calls: [] });
    return { ok: false, error };
  }
}

/**
 * A drill: the drill_started receipt is written, then the receipt writer is treated as failed for two minutes. The
 * guard refuses every agent call in the window and runs none (src/mock/db.ts call gates); the health incident opens
 * without its receipt; when the two minutes are up one receipt records the refused calls and the incident's
 * opening, and the incident is worked through.
 */
export function startWriteDrill(orgId: string, userId: string): WriteFailure {
  requireOwnerAdmin(orgId, userId, 'Starting a receipt-write drill.');
  const x = ext(orgId);
  sweepWriteFailures(orgId);
  if (writerDownNow(orgId)) throw new Error('A write-failure drill is already running.');
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'health.drill_started', details: { kind: 'receipt_write', minutes: 2 } });
  const f: WriteFailure = { id: `wf_${Date.now().toString(36)}`, at: r.ts, endedAt: iso(ms(r.ts) + 2 * M), error: 'Drill: the receipt writer is marked failed for two minutes. The guard refuses every agent call it cannot record and runs none of them; the refused calls are written to the chain as one receipt when the writer is back.', source: 'drill', by: userId, refused: 0, calls: [] };
  x.writeFailures.unshift(f);
  touch(orgId, 'incident');
  return clone(f);
}

/* ══ Approver telemetry and rubber-stamp sampling ════════════ */

export function noteApprovalOpened(orgId: string, approvalId: string, userId: string) {
  const d = getDB(orgId);
  const a = d.approvals.find((x) => x.id === approvalId);
  if (!a || a.status !== 'pending') return;
  const x = ext(orgId);
  const list = (x.opened[approvalId] ??= []);
  if (list.some((e) => e.userId === userId)) return;
  list.push({ userId, at: iso(Date.now()) });
  persist(orgId);
}

/**
 * The approval-link page (/approve/:token) shows the approval's full record — the call, the rule, the reason it was
 * held — so opening a link counts as opening the record, for the person the link was sent to.
 */
export function noteApprovalLinkOpened(token: string) {
  const org = ORGS.find((o) => o.slug === token.split('.')[1]);
  if (!org) return;
  const t = (getDB(org.id).platform.links ?? []).find((x) => x.token === token);
  if (!t || t.usedAt) return;
  noteApprovalOpened(org.id, t.approvalId, t.issuedTo);
}

const DECIDED: Approval['status'][] = ['approved', 'rejected', 'approved_run_failed'];

/** Did the approver open the approval's full record before deciding it? A decision made on the approval-link page counts: that page is the full record. */
export function openedBeforeDeciding(orgId: string, a: Pick<Approval, 'id' | 'decidedBy' | 'decidedAt'>) {
  const list = ext(orgId).opened[a.id] ?? [];
  if (list.some((e) => e.userId === a.decidedBy && (!a.decidedAt || ms(e.at) <= ms(a.decidedAt) + M))) return true;
  return (getDB(orgId).platform.links ?? []).some((l) => l.approvalId === a.id && !!l.usedAt && l.usedBy === a.decidedBy);
}

export interface ApproverStats {
  userId: string;
  decided: number;
  approved: number;
  rejected: number;
  medianMinutes: number;
  p90Minutes: number;
  underOneMinute: number;
  withoutOpening: number;
  channels: Record<string, number>;
  lastDecidedAt?: string;
  /** high approval rate with fast decisions or decisions made without opening the record */
  rubberStamp: boolean;
  samples: number;
}

const pctile = (xs: number[], p: number) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export function approverTelemetry(orgId: string, days = 90): ApproverStats[] {
  const d = getDB(orgId);
  const x = ext(orgId);
  const since = Date.now() - days * D;
  const by = new Map<string, Approval[]>();
  for (const a of d.approvals) {
    if (!a.decidedBy || !a.decidedAt || !DECIDED.includes(a.status) || ms(a.decidedAt) < since) continue;
    (by.get(a.decidedBy) ?? by.set(a.decidedBy, []).get(a.decidedBy)!).push(a);
  }
  const out: ApproverStats[] = [];
  for (const [userId, list] of by) {
    const mins = list.map((a) => Math.max(0, (ms(a.decidedAt!) - ms(a.createdAt)) / M));
    const approved = list.filter((a) => a.status !== 'rejected').length;
    const without = list.filter((a) => !openedBeforeDeciding(orgId, a)).length;
    const channels: Record<string, number> = {};
    list.forEach((a) => { const c = a.channel ?? 'web'; channels[c] = (channels[c] ?? 0) + 1; });
    const median = pctile(mins, 0.5);
    const share = approved / list.length;
    out.push({
      userId, decided: list.length, approved, rejected: list.length - approved,
      medianMinutes: Math.round(median * 10) / 10, p90Minutes: Math.round(pctile(mins, 0.9) * 10) / 10,
      underOneMinute: mins.filter((m) => m < 1).length, withoutOpening: without, channels,
      lastDecidedAt: list.map((a) => a.decidedAt!).sort().pop(),
      rubberStamp: list.length >= 5 && share >= 0.9 && (median < 3 || without / list.length >= 0.4),
      samples: x.samples.filter((s) => s.approverId === userId).length,
    });
  }
  return out.sort((a, b) => Number(b.rubberStamp) - Number(a.rubberStamp) || b.decided - a.decided);
}

/** Decided approvals of one approver, newest first, with the facts the telemetry uses. */
export function approverDecisions(orgId: string, userId: string, days = 90) {
  const d = getDB(orgId);
  const since = Date.now() - days * D;
  return d.approvals
    .filter((a) => a.decidedBy === userId && a.decidedAt && DECIDED.includes(a.status) && ms(a.decidedAt) >= since)
    .sort((a, b) => b.decidedAt!.localeCompare(a.decidedAt!))
    .map((a) => ({ approval: clone(a), minutes: Math.round(((ms(a.decidedAt!) - ms(a.createdAt)) / M) * 10) / 10, opened: openedBeforeDeciding(orgId, a) }));
}

export function approverSamples(orgId: string): ApproverSample[] {
  return clone(ext(orgId).samples).sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || b.drawnAt.localeCompare(a.drawnAt));
}

/**
 * Draw a sample of an approver's past approvals for a second person to review: approved decisions from the last
 * 90 days, weighted towards the fastest ones and the ones decided without opening the record.
 */
export function drawApproverSample(orgId: string, approverId: string, size: number, reason: string, userId: string): ApproverSample {
  requireOwnerAdmin(orgId, userId, 'Sampling an approver’s decisions.');
  if (approverId === userId) throw new Error('Nobody samples their own decisions. A different owner or admin draws the sample.');
  if (!ownersAndAdmins(orgId).some((u) => u !== userId && u !== approverId)) throw new Error(`A sample is reviewed by an owner or admin who is neither you (you draw it) nor ${userName(approverId)}, and this organisation has nobody else in that role. Invite one in People and roles first.`);
  if (reason.trim().length < 6) throw new Error('Say why you are sampling — it is recorded.');
  const x = ext(orgId);
  if (x.samples.some((s) => s.approverId === approverId && s.status === 'open')) throw new Error(`A sample of ${userName(approverId)}’s decisions is already open. Finish it first.`);
  const pool = approverDecisions(orgId, approverId).filter((r) => r.approval.status !== 'rejected');
  if (!pool.length) throw new Error(`${userName(approverId)} has approved nothing in the last 90 days.`);
  const n = Math.max(1, Math.min(size, pool.length));
  const salt = Date.now().toString(36);
  const ranked = pool
    .map((r) => ({ r, w: (r.opened ? 0 : 2) + (r.minutes < 2 ? 2 : r.minutes < 10 ? 1 : 0) + (hash(r.approval.id + salt) % 1000) / 1000 }))
    .sort((a, b) => b.w - a.w);
  const ids = ranked.slice(0, n).map((x2) => x2.r.approval.id);
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'approver.sample_drawn', details: { approver: approverId, size: ids.length, pool: pool.length, reason: reason.trim() } });
  const s: ApproverSample = { id: `smp_${Date.now().toString(36)}`, approverId, drawnBy: userId, drawnAt: r.ts, drawSeq: r.seq, reason: reason.trim(), approvalIds: ids, reviews: [], status: 'open' };
  x.samples.unshift(s);
  touch(orgId, 'approval');
  return clone(s);
}

export function reviewSampledApproval(orgId: string, sampleId: string, approvalId: string, ok: boolean, note: string, userId: string): ApproverSample {
  requireOwnerAdmin(orgId, userId, 'Reviewing a sampled approval.');
  const s = ext(orgId).samples.find((x) => x.id === sampleId);
  if (!s || s.status !== 'open') throw new Error('This sample is closed.');
  if (s.approverId === userId) throw new Error('Nobody reviews their own decisions.');
  if (s.drawnBy === userId) throw new Error('You drew this sample, so a different owner or admin reviews it. The check never rests on the person who chose what to check.');
  if (!s.approvalIds.includes(approvalId)) throw new Error('That approval is not in this sample.');
  if (s.reviews.some((v) => v.approvalId === approvalId)) throw new Error('That approval was already reviewed in this sample.');
  if (!ok && note.trim().length < 8) throw new Error('Say what concerns you — at least a sentence. It is recorded.');
  const d = getDB(orgId);
  const r = append(d, { kind: 'admin', actor: userId, action: 'approver.sample_reviewed', details: { sample: s.id, approver: s.approverId, approval: approvalId, outcome: ok ? 'sound' : 'concern', ...(note.trim() ? { note: note.trim() } : {}) } });
  s.reviews.push({ approvalId, by: userId, at: r.ts, ok, note: note.trim(), seq: r.seq });
  if (s.reviews.length === s.approvalIds.length) {
    const concerns = s.reviews.filter((v) => !v.ok).length;
    const c = append(d, { kind: 'admin', actor: userId, action: 'approver.sample_closed', details: { sample: s.id, approver: s.approverId, reviewed: s.reviews.length, concerns } });
    Object.assign(s, { status: 'closed', closedAt: c.ts, closeSeq: c.seq });
  }
  touch(orgId, 'approval');
  return clone(s);
}

/** Who may review a sample: active owners and admins other than the approver sampled and the person who drew it. */
export function sampleReviewers(orgId: string, s: Pick<ApproverSample, 'approverId' | 'drawnBy'>): string[] {
  return ownersAndAdmins(orgId).filter((u) => u !== s.approverId && u !== s.drawnBy);
}

/* ══ Items for the Work queues (Today and Reviews) ═══════════ */

export interface OpsWorkItem {
  id: string;
  kind: 'stop_lift' | 'break_glass' | 'approver_sample';
  title: string;
  detail: string;
  requestedBy: string;
  requestedAt: string;
  dueAt?: string;
  route: string;
  refId: string;
  canAct: boolean;
  whyNot?: string;
  enforced: boolean;
}

export function opsWorkItems(orgId: string, userId?: string, sweep = true): OpsWorkItem[] {
  const d = getDB(orgId);
  const x = ext(orgId);
  if (sweep) sweepBreakGlass(orgId);
  const oa = isOwnerAdmin(orgId, userId);
  const out: OpsWorkItem[] = [];
  const lift = pendingLift(orgId);
  if (lift) {
    const self = lift.requestedBy === userId;
    out.push({
      id: `lift_${lift.id}`, kind: 'stop_lift', title: 'Approve lifting the emergency stop',
      detail: `${userName(lift.requestedBy)} asked to lift the stop: “${lift.note}”. A different owner or admin approves before any agent resumes.`,
      requestedBy: lift.requestedBy, requestedAt: lift.requestedAt, route: `/incidents/${lift.incidentId}`, refId: lift.id,
      canAct: oa && !self, whyNot: !oa ? 'Owners and admins decide a lift.' : self ? 'You asked for this lift; a different owner or admin approves it.' : undefined, enforced: true,
    });
  }
  for (const b of x.breakGlass.filter((g) => g.status === 'pending')) {
    const self = b.requestedBy === userId || b.forUser === userId;
    out.push({
      id: `bg_${b.id}`, kind: 'break_glass', title: `Emergency access for ${userName(b.forUser)} (${b.minutes >= 60 ? `${b.minutes / 60} h` : `${b.minutes} min`})`,
      detail: `Password sign-in while SSO is enforced, until ${b.minutes >= 60 ? `${b.minutes / 60} hours` : `${b.minutes} minutes`} after approval. Asked by ${userName(b.requestedBy)}: “${b.reason}”`,
      requestedBy: b.requestedBy, requestedAt: b.requestedAt, route: '/agents/organisation?tab=sessions', refId: b.id,
      canAct: oa && !self, whyNot: !oa ? 'Owners and admins approve emergency access.' : self ? 'A second person approves — not the person who asked or who gets it.' : undefined, enforced: true,
    });
  }
  for (const s of x.samples.filter((v) => v.status === 'open')) {
    const left = s.approvalIds.length - s.reviews.length;
    const self = s.approverId === userId;
    const drew = s.drawnBy === userId;
    out.push({
      id: `smp_${s.id}`, kind: 'approver_sample', title: `Review ${left} of ${s.approvalIds.length} sampled approvals by ${userName(s.approverId)}`,
      detail: `Drawn by ${userName(s.drawnBy)}: “${s.reason}”. Read each decision and record whether it was sound. Neither the approver nor the person who drew the sample reviews it.`,
      requestedBy: s.drawnBy, requestedAt: s.drawnAt, route: `/work/approvers?sample=${s.id}`, refId: s.id,
      canAct: oa && !self && !drew, whyNot: !oa ? 'Owners and admins review sampled approvals.' : self ? 'These are your own decisions; someone else reviews them.' : drew ? 'You drew this sample; a different owner or admin reviews it.' : undefined, enforced: true,
    });
  }
  void d;
  return out;
}

/* ══ Seeded history (demo organisations) ═════════════════════ */

function seed(d: X) {
  if (d.fresh) return;
  const x = d.opsExt!;
  const now = Date.now();
  const id = d.org.id;
  // who opened the full record before deciding, for decisions made before this demonstration
  for (const a of d.approvals) {
    if (!a.decidedBy || !a.decidedAt || !DECIDED.includes(a.status)) continue;
    const h = hash(a.id) % 100;
    const fromMessage = a.channel === 'slack' || a.channel === 'whatsapp';
    if (fromMessage ? h >= 70 : h >= 22) x.opened[a.id] = [{ userId: a.decidedBy, at: iso(Math.max(ms(a.createdAt), ms(a.decidedAt) - (1 + (h % 9)) * M)) }];
  }
  const has = (u: string) => d.members.some((m) => m.userId === u && m.status === 'active');
  const push = (inc: Incident & { subkind?: string; declared?: boolean }) => { if (!d.incidents.some((i) => i.id === inc.id)) d.incidents.push(inc); };

  if (id === 'org_demo') {
    // L1: a receipt-write failure opens a health incident at L1 too
    const at = now - 4 * D - 3 * H;
    push({
      id: 'inc_h_write_seed', title: 'Receipts could not be written for 7 minutes', kind: 'health', subkind: 'receipt_write', status: 'resolved', scope: 'all_agents', agentSlugs: [],
      startedAt: iso(at), startedBy: 'system', reason: 'The disk under the receipt store filled up. The guard refused every call it could not record — 14 calls — so nothing ran unrecorded.',
      resolvedAt: iso(at + 7 * M + 40_000), resolvedBy: 'u_rahul', refusedWhileStopped: 0, pendingApprovalsAtStop: 0,
      timeline: [
        { ts: iso(at), text: 'Receipt write failure: the receipt store refused a write', actor: 'system' },
        { ts: iso(at + 20_000), text: 'Health incident opened; owners and admins notified', actor: 'system' },
        { ts: iso(at + 7 * M), text: 'Space freed; receipts are written again and the chain head moves', actor: 'u_rahul' },
        { ts: iso(at + 7 * M + 40_000), text: 'Resolved: rotated old logs off the volume and added a 80% disk alert. 14 calls refused during the window; no gap in the chain.', actor: 'u_rahul' },
      ],
    } as Incident);
    if (has('u_rahul') && has('u_ananya')) {
      const t = now - 9 * D;
      x.breakGlass.push({ id: 'bg_seed_demo', forUser: 'u_rahul', requestedBy: 'u_rahul', requestedAt: iso(t), reason: 'Google Workspace sign-in outage — need password access to approve the payroll run before 14:00.', minutes: 60, status: 'ended', approvedBy: 'u_ananya', approvedAt: iso(t + 6 * M), expiresAt: iso(t + 66 * M), endedAt: iso(t + 31 * M), endedBy: 'u_rahul', seeded: true });
    }
    // an open sample of the busiest approver's decisions
    const busiest = [...d.approvals.filter((a) => a.decidedBy && a.status === 'approved').reduce((m, a) => m.set(a.decidedBy!, (m.get(a.decidedBy!) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
    // drawn by Rahul (admin); Ananya (owner) is the different person who reviews it — never the one who drew it
    if (busiest && busiest !== 'u_ananya' && busiest !== 'u_rahul' && has('u_ananya') && has('u_rahul')) {
      const pool = d.approvals.filter((a) => a.decidedBy === busiest && a.status === 'approved').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')).slice(0, 12);
      const ids = pool.filter((_, i) => i % 2 === 0).slice(0, 5).map((a) => a.id);
      if (ids.length >= 2) {
        x.samples.push({
          id: 'smp_seed_demo', approverId: busiest, drawnBy: 'u_rahul', drawnAt: iso(now - 2 * D), reason: 'Quarterly check of approval quality: most decisions this month were made from WhatsApp.', approvalIds: ids,
          reviews: [{ approvalId: ids[0], by: 'u_ananya', at: iso(now - 2 * D + 20 * M), ok: true, note: 'PO and GRN match; amount as quoted.' }], status: 'open',
        });
      }
    }
  }

  if (id === 'org_northbank') {
    // L2: an active key compromise with the CERT-In clock running
    const at = now - 2 * H - 10 * M;
    const inc = {
      id: 'inc_d_seed_keyleak', title: 'Agent API key exposed in a CI build log', kind: 'health', subkind: 'key_compromise', declared: true, status: 'active', scope: 'selected_agents', agentSlugs: d.agents.slice(0, 1).map((a) => a.slug),
      startedAt: iso(at), startedBy: has('u_nb_neha') ? 'u_nb_neha' : 'system', reason: 'A production agent key was printed in a public CI log for 40 minutes before the job was cancelled. Anyone who read the log could call the decision API as that agent.', refusedWhileStopped: 0, pendingApprovalsAtStop: 0,
      timeline: [
        { ts: iso(at), text: 'Noticed by the platform team in the CI log', actor: has('u_nb_neha') ? 'u_nb_neha' : undefined },
        { ts: iso(at + 4 * M), text: 'Declared by hand by Neha Bhatia', actor: has('u_nb_neha') ? 'u_nb_neha' : undefined },
        { ts: iso(at + 4 * M), text: 'CERT-In reporting clock started: report due six hours from notice.' },
      ],
    } as Incident & { subkind: string; declared: boolean };
    push(inc);
    const rep = openCertIn(d, inc, 'key_compromise', has('u_nb_neha') ? 'u_nb_neha' : 'u_rohan');
    rep.draft = { ...rep.draft, indicators: 'Key prefix gk_live_nb7…; CI job #4471 log; first exposure 40 minutes before cancellation.', actions: 'Old key revoked is pending; the agent will be moved to a new key. Calls made with the key since exposure are being read.' };
    rep.draftSavedAt = iso(at + 25 * M);
    rep.draftSavedBy = has('u_nb_neha') ? 'u_nb_neha' : 'u_rohan';
    if (has('u_nb_neha')) {
      x.breakGlass.push({ id: 'bg_seed_nb', forUser: 'u_nb_neha', requestedBy: 'u_nb_neha', requestedAt: iso(now - 35 * M), reason: 'Okta SCIM change locked the admin group out of SSO. Need password sign-in for an hour to repair the group mapping.', minutes: 60, status: 'pending', seeded: true });
    }
  }

  if (id === 'org_kaveri') {
    // L3: an isolation breach reported to CERT-In inside six hours, resolved
    const at = now - 9 * D - 5 * H;
    const inc = {
      id: 'inc_d_seed_isolation', title: 'Lab results visible across hospital tenants', kind: 'health', subkind: 'isolation_breach', declared: true, status: 'resolved', scope: 'selected_agents', agentSlugs: d.agents.slice(0, 1).map((a) => a.slug),
      startedAt: iso(at), startedBy: has('u_kh_arvind') ? 'u_kh_arvind' : 'system', reason: 'A cache key without the hospital identifier let one branch’s agent read another branch’s lab summaries for 18 minutes.',
      resolvedAt: iso(at + 27 * H), resolvedBy: has('u_lakshmi') ? 'u_lakshmi' : 'system', refusedWhileStopped: 0, pendingApprovalsAtStop: 0,
      checksDone: ['contain', 'scope', 'egress'], resolutionNote: 'Cache keys now carry the tenant; 31 summaries were read across the boundary and the patients were told.',
      timeline: [
        { ts: iso(at), text: 'Noticed by the IT infrastructure team', actor: has('u_kh_vivek') ? 'u_kh_vivek' : undefined },
        { ts: iso(at + 10 * M), text: 'Declared by hand by Arvind Swamy; affected agent paused', actor: has('u_kh_arvind') ? 'u_kh_arvind' : undefined },
        { ts: iso(at + 4 * H + 5 * M), text: 'Reported to CERT-In by email to incident@cert-in.org.in (CERTIn-IR-2026-10-118), 4.1 hours after notice, inside six hours.', actor: has('u_lakshmi') ? 'u_lakshmi' : undefined },
        { ts: iso(at + 27 * H), text: 'Resolved: cache keys carry the tenant; 31 summaries read across the boundary; patients told.', actor: has('u_lakshmi') ? 'u_lakshmi' : undefined },
      ],
    } as Incident & { subkind: string; declared: boolean };
    push(inc);
    const rep = openCertIn(d, inc, 'isolation_breach', has('u_kh_arvind') ? 'u_kh_arvind' : 'u_lakshmi');
    Object.assign(rep, { submittedAt: iso(at + 4 * H + 5 * M), submittedBy: has('u_lakshmi') ? 'u_lakshmi' : 'u_kh_arvind', method: 'email', reference: 'CERTIn-IR-2026-10-118', late: false, draftSavedAt: iso(at + 2 * H) });
    rep.draft = { ...rep.draft, indicators: 'Cache key lab:<patient> without the branch prefix; 31 cross-branch reads in 18 minutes.', actions: 'Agent paused; cache flushed; key format fixed and deployed; reads listed from the receipts.' };
  }

  if (id === 'org_deccan' && has('u_anjali') && has('u_suresh')) {
    const t = now - 16 * D;
    x.breakGlass.push({ id: 'bg_seed_dc', forUser: 'u_anjali', requestedBy: 'u_anjali', requestedAt: iso(t), reason: 'Local IdP appliance failed its firmware update during the maintenance window; password access needed to apply the signed update bundle.', minutes: 120, status: 'expired', approvedBy: 'u_suresh', approvedAt: iso(t + 9 * M), expiresAt: iso(t + 129 * M), endedAt: iso(t + 129 * M), seeded: true });
  }
  d.incidents.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.startedAt.localeCompare(a.startedAt));
}

/* ══ Seeded two-person stop lifts (L2, L3, Sovereign) ════════ */

/**
 * Northbank (L2): a stop engaged on the agent whose key leaked, with Neha's lift request waiting for a second owner
 * or admin — written now, as receipts on the chain, so the request is in Rohan's Reviews and on Today.
 * Kaveri (L3): a resolved stop whose first lift was declined by the second person and the second approved.
 * Deccan (Sovereign): a resolved stop lifted by two people. Both histories predate this demonstration (no receipts).
 */
function seedLifts(orgId: string) {
  liftSeedQueued.delete(orgId);
  const d = getDB(orgId) as X;
  const x = d.opsExt;
  if (!x || (x.liftSeed ?? 0) >= LIFT_SEED) return;
  x.liftSeed = LIFT_SEED;
  const oa = (u: string) => d.members.some((m) => m.userId === u && m.status === 'active' && (m.role === 'owner' || m.role === 'admin'));
  const now = Date.now();
  const has = (id: string) => x.lifts.some((l) => l.id === id) || d.incidents.some((i) => i.id === id);

  if (orgId === 'org_northbank' && oa('u_nb_neha') && oa('u_rohan') && !d.stop.active && !has('lift_seed_nb')) {
    const leak = d.incidents.find((i) => i.id === 'inc_d_seed_keyleak');
    const target = d.agents.find((a) => a.status === 'active' && !!leak?.agentSlugs.includes(a.slug)) ?? d.agents.find((a) => a.status === 'active');
    if (target) {
      const inc = dbEngageStop(orgId, 'u_nb_neha', `Agent key for ${target.slug} exposed in a CI build log. Stopped until the key is replaced and every use of it since exposure is read.`, [target.slug]);
      const note = `Exposed key revoked and a new key issued to ${target.slug}. The calls made with the old key since exposure are read and listed on the key-compromise incident; nothing unexpected ran.`;
      const r = append(d, { kind: 'admin', actor: 'u_nb_neha', action: 'stop.lift_requested', details: { incident: inc.id, note, checks: 3, level: levelOf(orgId) } });
      x.lifts.unshift({ id: 'lift_seed_nb', incidentId: inc.id, requestedBy: 'u_nb_neha', requestedAt: r.ts, note, checks: 3, requestSeq: r.seq, status: 'pending' });
      inc.timeline.push({ ts: r.ts, text: `Lift requested by ${userName('u_nb_neha')}: “${note}”. A different owner or admin must approve it before any agent resumes.`, seq: r.seq, actor: 'u_nb_neha' });
      leak?.timeline.push({ ts: inc.startedAt, text: `Emergency stop engaged on ${target.slug}; at L2 a second owner or admin approves lifting it.`, actor: 'u_nb_neha' });
    }
  }

  const history = (cfg: { id: string; slug?: string; t: number; engagedBy: string; reason: string; refused: number; held: number; steps: { by: string; after: number; status: LiftRequest['status']; decidedBy?: string; decidedAfter?: number; note: string; decisionNote?: string }[]; liftedBy: string; liftedAfter: number }) => {
    if (!cfg.slug || has(cfg.id)) return;
    const inc: Incident = {
      id: cfg.id, title: `Stop: ${cfg.slug}`, kind: 'emergency_stop', status: 'resolved', scope: 'selected_agents', agentSlugs: [cfg.slug],
      startedAt: iso(cfg.t), startedBy: cfg.engagedBy, reason: cfg.reason, resolvedAt: iso(cfg.t + cfg.liftedAfter), resolvedBy: cfg.liftedBy,
      refusedWhileStopped: cfg.refused, pendingApprovalsAtStop: cfg.held,
      timeline: [
        { ts: iso(cfg.t), text: `Stop engaged by ${userName(cfg.engagedBy)}. 1 agent paused in one transaction.`, actor: cfg.engagedBy },
        ...(cfg.held ? [{ ts: iso(cfg.t), text: `${cfg.held} waiting approvals are held by the stop: nobody can decide them until it is lifted.` }] : []),
      ],
    };
    cfg.steps.forEach((s, i) => {
      const lift: LiftRequest = { id: `${cfg.id}_lift${i + 1}`, incidentId: cfg.id, requestedBy: s.by, requestedAt: iso(cfg.t + s.after), note: s.note, checks: 3, status: s.status, seeded: true };
      inc.timeline.push({ ts: lift.requestedAt, text: `Lift requested by ${userName(s.by)}: “${s.note}”. A different owner or admin must approve it before any agent resumes.`, actor: s.by });
      if (s.decidedBy && s.decidedAfter !== undefined) {
        Object.assign(lift, { decidedBy: s.decidedBy, decidedAt: iso(cfg.t + s.decidedAfter), decisionNote: s.decisionNote });
        inc.timeline.push(s.status === 'declined'
          ? { ts: lift.decidedAt!, text: `Lift declined by ${userName(s.decidedBy)}: “${s.decisionNote}”. The stop stays on.`, actor: s.decidedBy }
          : { ts: lift.decidedAt!, text: `Lift approved by ${userName(s.decidedBy)}, the second person${s.decisionNote ? `: “${s.decisionNote}”` : ''}.`, actor: s.decidedBy });
      }
      x.lifts.push(lift);
    });
    inc.timeline.push(
      { ts: iso(cfg.t + cfg.liftedAfter), text: `Stop lifted. 1 agent resumed — only the one the stop paused. ${cfg.refused} calls were refused while it was on.`, actor: cfg.liftedBy },
      { ts: iso(cfg.t + cfg.liftedAfter), text: 'Incident report generated.' },
    );
    d.incidents.push(inc);
  };

  if (orgId === 'org_kaveri' && oa('u_kh_arvind') && oa('u_lakshmi') && oa('u_kh_sneha')) {
    const t = now - 23 * D - 4 * H;
    history({
      id: 'inc_stop_seed_kaveri', slug: (d.agents[1] ?? d.agents[0])?.slug, t, engagedBy: 'u_kh_arvind', refused: 27, held: 2, liftedBy: 'u_lakshmi', liftedAfter: 3 * H + 12 * M,
      reason: 'Pre-authorisations going to insurers with the old payer codes after the insurer master changed overnight.',
      steps: [
        { by: 'u_kh_arvind', after: 50 * M, status: 'declined', decidedBy: 'u_lakshmi', decidedAfter: 64 * M, note: 'Payer code mapping corrected in the connector; test claims go to the right insurer.', decisionNote: 'The rulebook still allows a pre-authorisation without a payer-code check. Publish that rule before the agent resumes.' },
        { by: 'u_kh_arvind', after: 2 * H + 55 * M, status: 'approved', decidedBy: 'u_lakshmi', decidedAfter: 3 * H + 12 * M, note: 'Payer-code check published in rulebook v7; the two held pre-authorisations rejected and re-raised by hand.', decisionNote: 'Read v7 and the two rejections. Agreed.' },
      ],
    });
  }

  if (orgId === 'org_deccan' && oa('u_anjali') && oa('u_suresh')) {
    const t = now - 41 * D - 6 * H;
    history({
      id: 'inc_stop_seed_deccan', slug: (d.agents[2] ?? d.agents[0])?.slug, t, engagedBy: 'u_anjali', refused: 12, held: 1, liftedBy: 'u_suresh', liftedAfter: 1 * H + 40 * M,
      reason: 'Borrower reminders queued outside 08:00–19:00 IST after the cluster clock drifted during the node replacement.',
      steps: [
        { by: 'u_anjali', after: 1 * H + 15 * M, status: 'approved', decidedBy: 'u_suresh', decidedAfter: 1 * H + 40 * M, note: 'Node clocks resynced to the local time source; the queued reminders were cancelled before sending.', decisionNote: 'Checked the time source on all three nodes.' },
      ],
    });
  }

  d.incidents.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.startedAt.localeCompare(a.startedAt));
  persist(orgId);
  touch(orgId, 'incident');
}
