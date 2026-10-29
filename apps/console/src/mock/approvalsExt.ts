/**
 * Approvals — decide-screen extension state, kept on the organisation's record (so it is shared by everyone in the
 * organisation and survives a reload) and written to the chain for every change:
 *
 *  - blast radius per call (single record · one account · tenant · cross-boundary); tenant and cross-boundary
 *    trigger dual control,
 *  - the declared reversal plan per tool, and reversals within 30 days of an approval,
 *  - the same-actor setting (flag or forbid self-approval),
 *  - named, time-boxed delegates,
 *  - step-up re-authentication for irreversible or high-value approvals,
 *  - the approvals-service outage state (fail closed: nothing is decided and nothing expires while it is down).
 *
 * Everything new on the organisation's record is optional and defaulted on read: saved browser state may predate it.
 */
import type { Approval, LevelId, Receipt } from '@/types';
import { append, approvalHooks, allowedApprovers, decideApproval, getDB, memberRole, touch, type OrgDB } from './db';
import { DEMO_ACCOUNTS, approverGroupsFor, personFor, userById, userName } from './users';
import { can } from '@/lib/permissions';
import { atLeast, levelOfOrg } from '@/lib/levels';

const H = 3_600_000;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

/* ── Types ────────────────────────────────────────────────── */

export type SameActorMode = 'flag' | 'forbid';
export type BlastScope = 'single_record' | 'account' | 'tenant' | 'cross_boundary';

export interface Delegation {
  id: string;
  from: string;
  to: string;
  until: string;
  reason: string;
  createdAt: string;
  createdBy: string;
  seq?: number;
  revokedAt?: string;
  revokedBy?: string;
  revokedSeq?: number;
}

export interface Reversal {
  approvalId: string;
  by: string;
  at: string;
  reason: string;
  seq: number;
  resultSeq?: number;
  plan: string;
  ref?: string;
}

export interface Outage {
  active: boolean;
  since?: string;
  by?: string;
  seq?: number;
  endedAt?: string;
  endedBy?: string;
  endedSeq?: number;
  /** minutes the last outage lasted; waiting approvals had their expiry moved by this much */
  pausedMinutes?: number;
  history: { since: string; endedAt: string; minutes: number; extended: number }[];
}

export interface StepUpPolicy { above: number; irreversible: boolean }

interface ApprovalsExt {
  v: 1;
  sameActor: SameActorMode;
  sameActorSeq?: number;
  stepUp: StepUpPolicy;
  delegations: Delegation[];
  reversals: Record<string, Reversal>;
  outage: Outage;
  ruleDrafts: Record<string, { by: string; at: string; rulebook: string; version: number; rule: string; seq: number }>;
  seeded?: boolean;
  /** the delegation to a demo sign-in account, and one call decided under it (added after `seeded`; optional) */
  seededDelegate?: boolean;
}

type ExtDB = OrgDB & { approvalsExt?: ApprovalsExt };

/* ── State ────────────────────────────────────────────────── */

export function approvalsExt(orgId: string): ApprovalsExt {
  const d = getDB(orgId) as ExtDB;
  if (!d.approvalsExt) {
    const l2 = atLeast(levelOfOrg(d.org), 'l2');
    d.approvalsExt = {
      v: 1,
      // from L2 an approver may not approve an action of an agent they own; at L1 it is flagged on the receipt
      sameActor: l2 ? 'forbid' : 'flag',
      stepUp: { above: 500000, irreversible: true },
      delegations: [],
      reversals: {},
      outage: { active: false, history: [] },
      ruleDrafts: {},
    };
  }
  const x = d.approvalsExt;
  x.sameActor ??= 'flag';
  x.stepUp ??= { above: 500000, irreversible: true };
  x.delegations ??= [];
  x.reversals ??= {};
  x.outage ??= { active: false, history: [] };
  x.outage.history ??= [];
  x.ruleDrafts ??= {};
  if (!x.seeded) {
    x.seeded = true;
    seedDemo(d, x);
  }
  if (!x.seededDelegate) {
    x.seededDelegate = true;
    seedDelegateDemo(d, x);
  }
  return x;
}

const DEMO_ORGS = ['org_demo', 'org_northbank', 'org_kaveri', 'org_deccan'];
const ROLE_RANK: Record<string, number> = { approver: 0, admin: 1, owner: 2 };

/**
 * Demo data so the delegate's side can be seen by signing in: in each demo organisation an approver has delegated
 * to a demo sign-in account (Demo Traders: Venkat Iyer; Northbank, Kaveri: the owner; Deccan: the admin) for a group
 * that account is not in. Open approvals from that group show “You are deciding for …”, and one of them is decided
 * under the delegation now, so its decision receipt carries delegated_from and the decided block shows the badge.
 */
function seedDelegateDemo(d: ExtDB, x: ApprovalsExt) {
  const orgId = d.org.id;
  if (!DEMO_ORGS.includes(orgId)) return;
  const now = Date.now();
  const decides = (u: string) => can(memberRole(orgId, u), 'approvals.decide');
  const open = (a: Approval) => a.status === 'pending' && !a.heldByStop && new Date(a.expiresAt).getTime() > now + H;
  const delegates = DEMO_ACCOUNTS.filter((acc) => acc.orgId === orgId && decides(acc.userId)).sort((p, q) => (ROLE_RANK[p.role] ?? 9) - (ROLE_RANK[q.role] ?? 9)).map((acc) => acc.userId);
  let pick: { from: string; to: string; items: Approval[] } | undefined;
  for (const to of delegates) {
    // approvals this account cannot already decide as a group member, grouped by an approver who can
    const byFrom = new Map<string, Approval[]>();
    for (const a of d.approvals.filter(open)) {
      if (allowedApprovers(orgId, a, to).includes(to)) continue;
      const from = allowedApprovers(orgId, a).find((u) => u !== to && memberRole(orgId, u) === 'approver' && userById(u));
      if (from) byFrom.set(from, [...(byFrom.get(from) ?? []), a]);
    }
    const best = [...byFrom.entries()].sort((p, q) => q[1].length - p[1].length)[0];
    if (best) { pick = { from: best[0], to, items: best[1] }; break; }
  }
  if (!pick) {
    // no open approval fits: still delegate an approver's groups to the first demo account, for the settings view
    const to = delegates[0];
    const from = to ? approverGroupsFor(orgId).filter((g) => !g.members.includes(to)).flatMap((g) => g.members).find((u) => u !== to && memberRole(orgId, u) === 'approver') : undefined;
    if (!to || !from) return;
    pick = { from, to, items: [] };
  }
  const { from, to } = pick;
  const groups = approverGroupsFor(orgId).filter((g) => g.members.includes(from)).map((g) => g.name);
  const reason = `Away this week. ${groups.join(' and ') || 'My'} approvals go to ${userName(to)} until I am back.`;
  const del: Delegation = { id: `dlg_${orgId.replace('org_', '')}_demo`, from, to, until: iso(now + 5 * D), reason, createdAt: iso(now), createdBy: from };
  x.delegations.unshift(del);
  // decide one of them under the delegation, keeping at least one waiting for the live demonstration
  const step = x.stepUp ?? { above: 500000, irreversible: true };
  const ownsAgent = (a: Approval) => getDB(orgId).agents.find((g) => g.slug === a.agentSlug)?.ownerId === to;
  const candidates = pick.items.filter((a) => !ownsAgent(a));
  const safeToApprove = (a: Approval) => !blastRadius(a).dualControl && !irreversible(a) && (a.amount ?? 0) < Math.min(step.above, 1000000);
  const target = candidates.length >= 2 ? (candidates.find(safeToApprove) ?? candidates[candidates.length - 1]) : undefined;
  setTimeout(() => {
    if (!x.delegations.includes(del)) return;
    const r = append(d, { kind: 'admin', actor: from, action: 'approval.delegated', details: { delegation: del.id, from, to, until: del.until, reason, groups: groups.join(', ') } });
    del.seq = r.seq;
    del.createdAt = r.ts;
    if (target && target.status === 'pending') {
      const approve = safeToApprove(target);
      try {
        decideApproval(orgId, target.id, approve, to, approve ? `Checked the change field by field; deciding for ${userName(from)} while they are away.` : `Not without ${userName(from)}’s own review: rejected under the delegation; the agent can ask again when they are back.`, 'web', { delegated_from: from, delegation: del.id, blast_radius: blastRadius(target).scope });
      } catch {
        // a stop, a paused agent or an outage blocks it: the delegation alone is still seeded
      }
    }
    touch(orgId, 'approval');
  }, 0);
}

/**
 * Demo data so each feature is visible in every demo organisation: the procurement approver is on leave and has
 * delegated to the EU finance lead until four days from now, and one approved payment was reversed. The receipts
 * are written just after the current call returns (never during a render).
 */
function seedDemo(d: ExtDB, x: ApprovalsExt) {
  const orgId = d.org.id;
  if (!['org_demo', 'org_northbank', 'org_kaveri', 'org_deccan'].includes(orgId)) return;
  const from = personFor(orgId, 'u_arjun');
  const to = personFor(orgId, 'u_tom');
  const now = Date.now();
  const del: Delegation = { id: `dlg_${orgId.replace('org_', '')}_1`, from, to, until: iso(now + 4 * D), reason: 'On leave this week. Procurement approvals go to the EU finance lead.', createdAt: iso(now), createdBy: from };
  if (userById(from) && userById(to)) x.delegations.push(del);
  const pay = d.approvals
    .filter((a) => a.status === 'approved' && a.tool.endsWith('record_payment') && a.resultSeq !== undefined && a.decidedAt && now - new Date(a.decidedAt).getTime() > 2 * D && now - new Date(a.decidedAt).getTime() < 20 * D)
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))[0];
  setTimeout(() => {
    if (x.delegations.includes(del)) {
      const r = append(d, { kind: 'admin', actor: from, action: 'approval.delegated', details: { delegation: del.id, from, to, until: del.until, reason: del.reason } });
      del.seq = r.seq;
      del.createdAt = r.ts;
    }
    if (pay && !x.reversals[pay.id]) {
      const by = pay.decidedBy ?? personFor(orgId, 'u_venkat');
      const plan = reversalPlan(pay);
      const r = append(d, { kind: 'admin', actor: by, action: 'approval.reversed', agent: pay.agentSlug, details: { approval: pay.id, result_seq: pay.resultSeq ?? 0, plan: plan.plan, reason: 'Paid twice: the same bill was settled by cheque the day before.', days_after: Math.max(0, Math.floor((now - new Date(pay.decidedAt!).getTime()) / D)) } });
      x.reversals[pay.id] = { approvalId: pay.id, by, at: r.ts, reason: 'Paid twice: the same bill was settled by cheque the day before.', seq: r.seq, resultSeq: pay.resultSeq, plan: plan.plan };
    }
    touch(orgId, 'approval');
  }, 0);
}

/* ── Blast radius ─────────────────────────────────────────── */

export const BLAST_LABEL: Record<BlastScope, string> = {
  single_record: 'Single record',
  account: 'One account',
  tenant: 'Whole organisation',
  cross_boundary: 'Crosses a boundary',
};

/** The declared blast radius of a held call: how far a mistake would reach. Tenant and cross-boundary need two people. */
export function blastRadius(a: Pick<Approval, 'tool' | 'args' | 'riskTags'> & { counterparty?: string }): { scope: BlastScope; label: string; why: string; dualControl: boolean } {
  const tool = a.tool;
  const args = a.args ?? {};
  const tags = a.riskTags ?? [];
  const to = String(args.to_account ?? '');
  let scope: BlastScope = 'single_record';
  let why = 'It changes one record.';
  if (tool.includes('initiate_transfer') || to.startsWith('EXT') || String(args.country ?? '').length === 2 && String(args.country) !== 'IN' && tags.includes('moves_money')) {
    scope = 'cross_boundary';
    why = 'Money leaves your own accounts for an account outside the organisation.';
  } else if (tags.includes('changes_production') || tags.includes('changes_access') || String(args.environment ?? '') === 'production' || /bulk|batch|all_/.test(tool)) {
    scope = 'tenant';
    why = tags.includes('changes_access') ? 'It changes who can reach your systems.' : 'It changes a production service every user of the organisation relies on.';
  } else if (tags.includes('moves_money') || tags.includes('sends_external') || !!a.counterparty) {
    scope = 'account';
    why = tags.includes('sends_external') ? 'It reaches one outside party.' : 'It changes what one counterparty is paid or owed.';
  }
  return { scope, label: BLAST_LABEL[scope], why, dualControl: scope === 'tenant' || scope === 'cross_boundary' };
}

/* ── Reversal plans ───────────────────────────────────────── */

export const REVERSAL_DAYS = 30;

export interface ReversalPlan {
  /** "Payment recorded" — the outcome line shown after approval */
  outcome: string;
  /** "Payment voided" — the state after a reversal */
  reversed: string;
  reversible: boolean;
  /** nothing changes (a read) */
  readOnly: boolean;
  plan: string;
}

/** The declared reversal plan for a tool, or that it is irreversible. */
export function reversalPlan(a: Pick<Approval, 'tool' | 'args' | 'riskTags'>): ReversalPlan {
  const t = a.tool;
  const tags = a.riskTags ?? [];
  if (t.endsWith('record_payment') || t.includes('pay_')) return { outcome: 'Payment recorded', reversed: 'Payment voided', reversible: true, readOnly: false, plan: `Void the payment against ${a.args.bill ?? 'the bill'} and take it out of the next bank file. The bill reopens with its balance.` };
  if (t.includes('update_bank_details')) return { outcome: 'Bank details changed', reversed: 'Previous bank details restored', reversible: true, readOnly: false, plan: 'Restore the bank account that was on file before this change. Payments already sent are not affected.' };
  if (t.includes('create_vendor')) return { outcome: 'Vendor created', reversed: 'Vendor deactivated', reversible: true, readOnly: false, plan: 'Deactivate the vendor record so no bill can be raised against it. The record is kept for the audit trail.' };
  if (t.includes('deploy')) return { outcome: 'Deployed', reversed: 'Rolled back', reversible: true, readOnly: false, plan: 'Roll the service back to the version that ran before this deployment.' };
  if (t.includes('merge_pr')) return { outcome: 'Merged', reversed: 'Merge reverted', reversible: true, readOnly: false, plan: 'Open and merge a revert of this pull request.' };
  if (t.includes('initiate_transfer') || t.includes('transfer')) return { outcome: 'Transfer initiated', reversed: 'Reversed', reversible: false, readOnly: false, plan: 'Irreversible: a transfer to an outside bank account cannot be pulled back by the organisation.' };
  if (t.includes('send_email') || tags.includes('sends_external')) return { outcome: 'Email sent', reversed: 'Reversed', reversible: false, readOnly: false, plan: 'Irreversible: a sent email cannot be unsent.' };
  if (tags.includes('deletes')) return { outcome: 'Deleted', reversed: 'Reversed', reversible: false, readOnly: false, plan: 'Irreversible: the deleted data cannot be restored from here.' };
  if (tags.every((g) => g === 'reads_data' || g === 'personal_data') && tags.includes('reads_data')) return { outcome: 'Read', reversed: 'Reversed', reversible: false, readOnly: true, plan: 'Nothing to reverse: the call only reads.' };
  return { outcome: 'Recorded', reversed: 'Undone', reversible: true, readOnly: false, plan: 'Undo the write and restore the record as it was before.' };
}

/** Irreversible writes are never approved without a fresh password, whatever the session's age. */
export function irreversible(a: Pick<Approval, 'tool' | 'args' | 'riskTags'>): boolean {
  const p = reversalPlan(a);
  return !p.reversible && !p.readOnly;
}

/** Can this approved call still be reversed, and if not, why not. */
export function reversibility(orgId: string, a: Approval, now = Date.now()): { can: boolean; why?: string; until?: string; reversal?: Reversal; plan: ReversalPlan } {
  const plan = reversalPlan(a);
  const reversal = approvalsExt(orgId).reversals[a.id];
  if (reversal) return { can: false, why: `Reversed by ${userName(reversal.by)}.`, reversal: clone(reversal), plan };
  if (a.status !== 'approved') return { can: false, why: a.status === 'approved_run_failed' ? 'The call did not complete, so nothing changed and there is nothing to reverse.' : 'Only an approved call that ran can be reversed.', plan };
  if (plan.readOnly) return { can: false, why: plan.plan, plan };
  if (!plan.reversible) return { can: false, why: plan.plan, plan };
  const until = new Date(a.decidedAt ?? a.createdAt).getTime() + REVERSAL_DAYS * D;
  if (now > until) return { can: false, why: `The 30-day reversal window closed on ${new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}. Correct it with a new call.`, until: iso(until), plan };
  return { can: true, until: iso(until), plan };
}

export function reversalOf(orgId: string, approvalId: string): Reversal | undefined {
  const r = approvalsExt(orgId).reversals[approvalId];
  return r ? clone(r) : undefined;
}

/**
 * Reverse an approved call within 30 days, following its declared reversal plan. Owners and admins, the person
 * who approved it and members of its approver group may reverse it. Writes approval.reversed with a reason.
 */
/**
 * May this person reverse this approved call? Owners and admins, the person who approved it and members of its
 * approver group (with a role that decides approvals). Used by the screen to hide or disable "Reverse this" with
 * the reason, and by reverseApproval to refuse.
 */
export function reverseRight(orgId: string, a: Approval, userId?: string): { ok: boolean; why?: string } {
  if (!userId) return { ok: false, why: 'Sign in to reverse.' };
  const role = memberRole(orgId, userId);
  if (!role) return { ok: false, why: 'You hold no active role in this organisation.' };
  if (role === 'owner' || role === 'admin') return { ok: true };
  if (!can(role, 'approvals.decide')) return { ok: false, why: `Owners, admins, the approver and members of ${a.approverGroup} reverse this; ${role === 'auditor' ? 'auditors review the record' : 'viewers can only read'}.` };
  if (a.decidedBy === userId || allowedApprovers(orgId, a).includes(userId)) return { ok: true };
  return { ok: false, why: `Owners, admins, the approver and members of ${a.approverGroup} reverse this; you are not in ${a.approverGroup}.` };
}

export function reverseApproval(orgId: string, approvalId: string, userId: string, reason: string, route?: string): Reversal {
  const d = getDB(orgId);
  const a = d.approvals.find((x) => x.id === approvalId);
  if (!a) throw new Error('This approval does not exist in this organisation.');
  const x = approvalsExt(orgId);
  if (x.outage.active) throw new Error('We cannot check this change right now. Nothing was changed.');
  const right = reverseRight(orgId, a, userId);
  if (!right.ok) throw new Error(right.why ?? 'Your role cannot reverse this.');
  const r = reversibility(orgId, a);
  if (!r.can) throw new Error(r.why ?? 'This call cannot be reversed.');
  if (reason.trim().length < 10) throw new Error('Say why it is being reversed, in at least a sentence. The reason is recorded.');
  const governed = route === 'mcp';
  const ref = governed ? `${a.connector.split(' ')[0].toLowerCase()}:rev-${Math.floor(Math.random() * 900000 + 100000)}` : undefined;
  const rec = append(d, {
    kind: 'admin', actor: userId, action: 'approval.reversed', agent: a.agentSlug, tool: a.tool, ref_seq: a.resultSeq,
    ...(governed ? { outcome: { status: 'ok' as const, ref, ms: 410 } } : {}),
    details: { approval: a.id, result_seq: a.resultSeq ?? 0, plan: r.plan.plan, reason: reason.trim(), mode: governed ? 'governed_run' : 'check_and_record', days_after: Math.floor((Date.now() - new Date(a.decidedAt ?? a.createdAt).getTime()) / D) },
  });
  const rev: Reversal = { approvalId: a.id, by: userId, at: rec.ts, reason: reason.trim(), seq: rec.seq, resultSeq: a.resultSeq, plan: r.plan.plan, ref };
  x.reversals[a.id] = rev;
  a.similar = { ...a.similar, reversed: (a.similar?.reversed ?? 0) + 1 };
  touch(orgId, 'approval');
  return clone(rev);
}

/* ── Same actor ───────────────────────────────────────────── */

export function sameActorMode(orgId: string): SameActorMode {
  return approvalsExt(orgId).sameActor;
}

function requireAdmin(orgId: string, userId: string, what: string) {
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what} Owners and admins change it; your role cannot.`);
}

export function setSameActorMode(orgId: string, mode: SameActorMode, userId: string): Receipt {
  requireAdmin(orgId, userId, 'The same-person setting protects every approval.');
  const x = approvalsExt(orgId);
  const from = x.sameActor;
  x.sameActor = mode;
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'approval.same_actor_policy', details: { from, to: mode } });
  x.sameActorSeq = r.seq;
  touch(orgId, 'approval');
  return clone(r);
}

/** Does the same-person rule stop this person approving this call? (They own the agent that proposed it.) */
export function sameActorBlocks(orgId: string, a: Pick<Approval, 'agentSlug'>, userId?: string): boolean {
  if (!userId) return false;
  const ag = getDB(orgId).agents.find((x) => x.slug === a.agentSlug);
  return !!ag && ag.ownerId === userId && sameActorMode(orgId) === 'forbid';
}

/* ── Step-up ──────────────────────────────────────────────── */

export function stepUpPolicy(orgId: string): StepUpPolicy {
  return clone(approvalsExt(orgId).stepUp);
}

export function setStepUpPolicy(orgId: string, patch: Partial<StepUpPolicy>, userId: string): Receipt {
  requireAdmin(orgId, userId, 'Step-up protects high-value and irreversible approvals.');
  const x = approvalsExt(orgId);
  if (patch.above !== undefined && !(patch.above >= 10000)) throw new Error('Choose an amount of at least ₹10,000.');
  Object.assign(x.stepUp, patch);
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'approval.step_up_policy', details: { above: x.stepUp.above, irreversible: x.stepUp.irreversible } });
  touch(orgId, 'approval');
  return clone(r);
}

/** Why approving this call asks for the password again whatever the session's age, or undefined. */
export function stepUpReason(orgId: string, a: Pick<Approval, 'tool' | 'args' | 'riskTags' | 'amount'>): string | undefined {
  const p = approvalsExt(orgId).stepUp;
  if (p.irreversible && irreversible(a)) return 'This call cannot be reversed once it runs.';
  if ((a.amount ?? 0) >= p.above) return `It is ${inr(a.amount ?? 0)}, at or above the ${inr(p.above)} step-up limit.`;
  return undefined;
}

/** Fresh step-ups: person and approval → when the password was checked (memory only; a reload asks again). */
const stepUps = new Map<string, number>();
const STEP_UP_MS = 5 * 60_000;

export function markStepUp(userId: string, approvalId: string) {
  stepUps.set(`${userId}:${approvalId}`, Date.now());
}

export function hasStepUp(userId: string, approvalId: string): boolean {
  const t = stepUps.get(`${userId}:${approvalId}`);
  return !!t && Date.now() - t < STEP_UP_MS;
}

/* ── Delegation ───────────────────────────────────────────── */

export const MAX_DELEGATION_DAYS = 30;

const live = (dl: Delegation, now = Date.now()) => !dl.revokedAt && new Date(dl.until).getTime() > now;

export function delegations(orgId: string): (Delegation & { active: boolean })[] {
  const now = Date.now();
  return clone(approvalsExt(orgId).delegations).map((dl) => ({ ...dl, active: live(dl, now) })).sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt.localeCompare(a.createdAt));
}

/** The approver this person stands in for on this approval, through a live delegation, or undefined. */
export function delegateFor(orgId: string, a: Approval, userId: string): string | undefined {
  const x = approvalsExt(orgId);
  const now = Date.now();
  if (!can(memberRole(orgId, userId), 'approvals.decide')) return undefined;
  for (const dl of x.delegations) {
    if (dl.to !== userId || !live(dl, now)) continue;
    // the delegator must still be an active member who may decide it
    if (!can(memberRole(orgId, dl.from), 'approvals.decide')) continue;
    if (allowedApprovers(orgId, a, dl.from).includes(dl.from)) return dl.from;
  }
  return undefined;
}

approvalHooks.delegateFor = delegateFor;

/**
 * Delegate your approvals to a named person until a date. You may delegate for yourself; owners and admins may set
 * one up for any approver. The delegate must hold a role that decides approvals. At most 30 days. Writes approval.delegated.
 */
export function addDelegation(orgId: string, input: { from: string; to: string; until: string; reason: string }, userId: string): Delegation {
  const role = memberRole(orgId, userId);
  if (input.from !== userId && role !== 'owner' && role !== 'admin') throw new Error('You can delegate your own approvals. Owners and admins set up a delegation for someone else.');
  if (!can(memberRole(orgId, input.from), 'approvals.decide')) throw new Error(`${userName(input.from)} does not decide approvals here, so there is nothing to delegate.`);
  if (input.to === input.from) throw new Error('Choose a different person to delegate to.');
  if (!can(memberRole(orgId, input.to), 'approvals.decide')) throw new Error(`${userName(input.to)} holds no role that decides approvals. Choose an approver, admin or owner.`);
  const until = new Date(input.until).getTime();
  if (!Number.isFinite(until) || until <= Date.now()) throw new Error('Choose an end date in the future.');
  // to the end of the chosen day: at most 30 days and the rest of that day
  if (until - Date.now() > (MAX_DELEGATION_DAYS + 1) * D) throw new Error(`A delegation lasts at most ${MAX_DELEGATION_DAYS} days. Set it up again when it ends.`);
  if (input.reason.trim().length < 5) throw new Error('Say why, for example “On leave until Friday”. The reason is recorded.');
  const x = approvalsExt(orgId);
  if (x.delegations.some((dl) => live(dl) && dl.from === input.from && dl.to === input.to)) throw new Error(`${userName(input.from)} already delegates to ${userName(input.to)}. Revoke that one first to change its dates.`);
  const groups = approverGroupsFor(orgId).filter((g) => g.members.includes(input.from)).map((g) => g.name);
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'approval.delegated', details: { from: input.from, to: input.to, until: iso(until), reason: input.reason.trim(), groups: groups.join(', ') } });
  const dl: Delegation = { id: `dlg_${r.seq}`, from: input.from, to: input.to, until: iso(until), reason: input.reason.trim(), createdAt: r.ts, createdBy: userId, seq: r.seq };
  x.delegations.unshift(dl);
  touch(orgId, 'approval');
  return clone(dl);
}

export function revokeDelegation(orgId: string, id: string, userId: string): Delegation {
  const x = approvalsExt(orgId);
  const dl = x.delegations.find((d) => d.id === id);
  if (!dl) throw new Error('That delegation does not exist.');
  if (!live(dl)) throw new Error('That delegation has already ended.');
  const role = memberRole(orgId, userId);
  if (dl.from !== userId && dl.to !== userId && role !== 'owner' && role !== 'admin') throw new Error('The person who delegated, the delegate, owners and admins end a delegation.');
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'approval.delegation_revoked', details: { delegation: dl.id, from: dl.from, to: dl.to } });
  dl.revokedAt = r.ts;
  dl.revokedBy = userId;
  dl.revokedSeq = r.seq;
  touch(orgId, 'approval');
  return clone(dl);
}

/* ── Outage (fail closed) ─────────────────────────────────── */

export const OUTAGE_SENTENCE = 'We cannot check this change right now. Nothing was changed.';

export function outageState(orgId: string): Outage {
  return clone(approvalsExt(orgId).outage);
}

export function outageActive(orgId: string): boolean {
  return approvalsExt(orgId).outage.active;
}

/**
 * Demonstration: take the approvals service down for this organisation. While it is down nothing can be approved,
 * rejected, re-routed or reversed, and nothing expires. Owners and admins start and end it. Writes approvals.outage_started.
 */
export function startOutage(orgId: string, userId: string): Outage {
  requireAdmin(orgId, userId, 'Simulating an approvals outage affects everyone here.');
  const x = approvalsExt(orgId);
  if (x.outage.active) throw new Error('The approvals service is already down for this organisation.');
  const waiting = getDB(orgId).approvals.filter((a) => a.status === 'pending').length;
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'approvals.outage_started', details: { waiting, demonstration: true } });
  x.outage = { ...x.outage, active: true, since: r.ts, by: userId, seq: r.seq, endedAt: undefined, endedBy: undefined, endedSeq: undefined };
  touch(orgId, 'approval');
  return clone(x.outage);
}

/** End the outage. Every waiting approval's expiry moves by the time it was down, so nothing expired while it was down. */
export function endOutage(orgId: string, userId: string): Outage {
  requireAdmin(orgId, userId, 'Ending the approvals outage affects everyone here.');
  const x = approvalsExt(orgId);
  if (!x.outage.active || !x.outage.since) throw new Error('The approvals service is not down.');
  const d = getDB(orgId);
  const ms = Math.max(0, Date.now() - new Date(x.outage.since).getTime());
  const minutes = Math.ceil(ms / 60_000);
  const waiting = d.approvals.filter((a) => a.status === 'pending');
  for (const a of waiting) a.expiresAt = iso(new Date(a.expiresAt).getTime() + ms);
  for (const l of d.platform.links) if (!l.usedAt && waiting.some((a) => a.id === l.approvalId)) l.expiresAt = iso(new Date(l.expiresAt).getTime() + ms);
  // the outage is over before its receipt is written: expiry may run again
  const since = x.outage.since;
  x.outage.active = false;
  const r = append(d, { kind: 'admin', actor: userId, action: 'approvals.outage_ended', details: { minutes, expiry_extended: waiting.length, since } });
  x.outage = { ...x.outage, active: false, endedAt: r.ts, endedBy: userId, endedSeq: r.seq, pausedMinutes: minutes, history: [{ since, endedAt: r.ts, minutes, extended: waiting.length }, ...x.outage.history].slice(0, 10) };
  touch(orgId, 'approval');
  return clone(x.outage);
}

/* ── Rule drafted from an approval ────────────────────────── */

export function ruleDraftOf(orgId: string, approvalId: string) {
  const r = approvalsExt(orgId).ruleDrafts[approvalId];
  return r ? clone(r) : undefined;
}

export function recordRuleDraft(orgId: string, approvalId: string, userId: string, info: { rulebook: string; version: number; rule: string }, agent?: string): Receipt {
  const x = approvalsExt(orgId);
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'approval.rule_drafted', agent, details: { approval: approvalId, rulebook: info.rulebook, draft_version: info.version, rule: info.rule } });
  x.ruleDrafts[approvalId] = { by: userId, at: r.ts, ...info, seq: r.seq };
  touch(orgId, 'rulebook');
  return clone(r);
}

/* ── Level wording ────────────────────────────────────────── */

/** L1 receipts are "sealed in a hash chain"; from L2 they are "signed". */
export function sealWord(level: LevelId | undefined): string {
  return atLeast(level, 'l2') ? 'signed' : 'sealed in a hash chain';
}
