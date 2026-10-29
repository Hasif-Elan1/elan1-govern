/**
 * Work door — backend extension.
 *
 * `src/api` is the data path for every screen. Where it has no endpoint for something the Work door needs
 * (re-authentication, detector settings, auto-pause per agent, assurance-health alerts, health incidents and
 * their resolution, two-person approvals, refusal explanations, named lists, the nightly suggestion run,
 * rule-level escalation), the functions below supply it over the same in-browser store. Every change writes
 * a signed admin receipt to the organisation's chain, and the state is kept on the organisation's record,
 * so it is shared by everyone in the organisation and survives a reload. A real backend replaces these bodies.
 */
import { parse as parseYaml } from 'yaml';
import { api, db } from '@/api';
import type { OrgDB } from '@/mock/db';
import type {
  Alert, Approval, Channel, Detector, Incident, LevelId, Receipt, Rule, RuleSuggestion, Severity, Webhook,
} from '@/types';
import { DEMO_ACCOUNTS, groupFor, userById, userName } from '@/mock/users';
import { VENDOR_DOMAINS, type ToolDef } from '@/mock/catalog';
import { channelsOf, reachPhrase, recipientChannels, recipientsOf } from '@/mock/orgSettings';
import { can } from '@/lib/permissions';
import { contentOk } from '@/lib/crypto';
import { atLeast, levelOfOrg } from '@/lib/levels';
import { plural, rupees } from '@/lib/format';
import { deriveNotDone, type NotDoneData } from './notDone';
import { certInBlocker, ensureOps, opsWorkItems, probeReceiptWrites, receiptWriterDown, writeFailures as opsWriteFailures } from '@/mock/ops';
import { OUTAGE_SENTENCE, blastRadius, delegateFor, hasStepUp, outageActive, sameActorBlocks, stepUpReason } from '@/mock/approvalsExt';

/* ── Small helpers ────────────────────────────────────────── */

const H = 3_600_000;
const D = 24 * H;
const wait = (min = 60, max = 160) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const iso = (t: number) => new Date(t).toISOString();
const istTime = (s: string) => new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

export type Sensitivity = 'fewer' | 'default' | 'more';
export type AssuranceDetector =
  | 'chain_integrity' | 'tsa_late' | 'kms_signing' | 'worm_write' | 'implementations_disagree'
  | 'inclusion_proof' | 'counterparty_verification' | 'autonomy_exceeded' | 'update_signature' | 'node_down' | 'receipt_write';
export type AnyDetector = Detector | AssuranceDetector;

export type HealthKind = 'receipt_write' | 'tsa_outage' | 'kms_failure' | 'worm_failure' | 'chain_break' | 'update_signature' | 'node_down' | 'counterparty_dispute' | 'autonomy_breach'
  // security incidents, declared by hand (src/mock/ops.ts)
  | 'key_compromise' | 'isolation_breach' | 'security_other';

export interface Delivery {
  id: string;
  channel: 'email' | 'slack' | 'whatsapp' | 'webhook' | 'console';
  target: string;
  at: string;
  status: 'delivered' | 'failed' | 'not_sent';
  code?: number;
  detail: string;
}

export type WorkAlert = Omit<Alert, 'detector'> & {
  detector: AnyDetector;
  family: 'behaviour' | 'assurance';
  deliveries: Delivery[];
  /** assurance alerts: what to open to see the evidence */
  evidence?: { label: string; to: string };
  incidentId?: string;
  resolvedBy?: string;
};

export type WorkIncident = Incident & { subkind?: HealthKind; alertId?: string; checksDone?: string[]; resolutionNote?: string; declared?: boolean };

interface Partial2 { userId: string; at: string; seq: number; reason: string; channel: Channel }
interface Explanation { by: string; at: string; note: string; seq?: number }

interface WorkExt {
  v: 1;
  explained: Record<string, Explanation>;
  detectors: Record<string, { on: boolean; sensitivity: Sensitivity }>;
  autoPause: Record<string, boolean>;
  alertState: Record<string, { status: Alert['status']; acknowledgedBy?: string; resolvedAt?: string; resolvedBy?: string }>;
  deliveries: Record<string, Delivery[]>;
  lastAlertAt: Record<string, number>;
  lastScanSeq?: number;
  partials: Record<string, Partial2>;
  twoPerson: { enabled: boolean; above: number };
  dualControlL1: boolean;
  namedLists?: Record<string, string[]>;
  dismissals: Record<string, { reason: string; by: string; at: string; approvals: number; seq?: number }>;
  suggestionScanAt?: string;
  healthIncidents: Record<string, string>; // alertId → incidentId
  /** demo state saved before an open refusal-surge alert was seeded gets one, once (plan journey 4 starts from it) */
  surgeSeeded?: boolean;
}

type ExtDB = OrgDB & { workExt?: WorkExt };

function orgDb(orgId: string): ExtDB {
  return db.getDB(orgId) as ExtDB;
}

function ext(orgId: string): WorkExt {
  const d = orgDb(orgId);
  if (!d.workExt) {
    d.workExt = {
      v: 1, explained: {}, detectors: {},
      autoPause: Object.fromEntries(d.alerts.filter((a) => a.autoPaused).map((a) => [a.agentSlug, true])),
      alertState: {}, deliveries: {}, lastAlertAt: {}, partials: {},
      twoPerson: { enabled: atLeast(levelOfOrg(d.org), 'l2'), above: 1000000 },
      dualControlL1: false, dismissals: {}, healthIncidents: {},
    };
  }
  const x = d.workExt;
  x.healthIncidents ??= {};
  x.dismissals ??= {};
  x.lastAlertAt ??= {};
  if (!x.surgeSeeded) {
    x.surgeSeeded = true;
    seedOpenSurge(d);
  }
  return x;
}

/**
 * Plan journey 4 ("Something goes wrong") starts from an open refusal-surge alert. Fresh demo data seeds one
 * (mock/db.ts); demo state saved before that gets one here, on the active agent with the most rule refusals.
 */
function seedOpenSurge(d: OrgDB) {
  if (d.alerts.some((a) => a.detector === 'refusal_surge' && a.status === 'open')) return;
  const SYSTEM = /^(agent-paused|no-rulebook|rulebook-invalid|gate-error|default|tool-disabled|invalid-arguments|autonomy-|G1_|pack-|POLICY\.|RECEIPT_)/;
  const best = d.agents.filter((a) => a.status === 'active')
    .map((a) => ({ a, refused: d.receipts.filter((r) => r.kind === 'decision' && r.agent === a.slug && r.decision === 'refuse' && !SYSTEM.test(r.rule_id ?? '')) }))
    .filter((c) => c.refused.length)
    .sort((x2, y) => y.refused.length - x2.refused.length)[0];
  if (!best) return;
  d.alerts.unshift({
    id: `al_${d.org.id}_surge`, detector: 'refusal_surge', severity: 'high', agentSlug: best.a.slug,
    title: `Refusals at 64% of ${best.a.slug}'s calls this hour`, detail: `9 of 14 calls in the last hour were refused. The usual share is 6%.`,
    baseline: '6% refused over 14 days', observed: '64% refused in the last hour', status: 'open',
    createdAt: new Date(Date.now() - 35 * 60_000).toISOString(), relatedSeqs: best.refused.slice(-8).map((r) => r.seq),
  });
}

/** The caller must hold one of `roles` as an active member of the organisation (its member record decides). */
function requireRole(orgId: string, userId: string, roles: string[], what: string) {
  const u = userById(userId);
  const role = db.memberRole(orgId, userId);
  if (!u || !role || !roles.includes(role)) throw new Error(`${what} Your role cannot do this.`);
  return u;
}

const levelOf = (orgId: string): LevelId => api.levelOf(orgId);

/* ══ Re-authentication ═══════════════════════════════════════ */

/** Check the signed-in person's password again (the demo account's password). Throws with a sentence on mismatch. */
export async function reauth(userId: string, password: string) {
  await wait(150, 300);
  const acct = DEMO_ACCOUNTS.find((a) => a.userId === userId);
  if (!acct) throw new Error('No password is on record for this person in the demonstration. Sign out and sign in again.');
  if (acct.password !== password) throw new Error('That password does not match your account. Try again.');
  return true;
}

/* ══ Approvals: membership, two-person approvals, links, rule-level escalation ══ */

/** The approver group record for a free-text group on an approval, in this organisation. */
export function groupOf(orgId: string, nameOrId: string) {
  return groupFor(orgId, nameOrId.trim());
}

/**
 * Who may decide this approval: an active member whose role decides approvals and who is in the group (or the
 * group it was escalated from), and (recorded) an owner. The role is the member record's, the same rule
 * db.decideApproval applies. Nobody decides an approval they re-routed to their own group.
 */
export function mayDecide(orgId: string, a: Approval, userId?: string): { ok: boolean; member: boolean; ownerOverride: boolean; why?: string; delegateFor?: string } {
  if (!userId) return { ok: false, member: false, ownerOverride: false, why: 'Sign in to decide.' };
  const role = db.memberRole(orgId, userId);
  if (!can(role, 'approvals.decide')) return { ok: false, member: false, ownerOverride: false, why: role ? 'Your role cannot decide approvals.' : 'You hold no active role in this organisation.' };
  const d = db.getDB(orgId);
  const live = d.approvals.find((x) => x.id === a.id) ?? a;
  const member = db.allowedApprovers(orgId, live, userId).includes(userId);
  const owner = role === 'owner';
  if (member) return { ok: true, member, ownerOverride: false };
  // a named, time-boxed delegate decides as the approver who delegated (recorded on the receipt)
  const dlg = delegateFor(orgId, live, userId);
  if (dlg) return { ok: true, member: false, ownerOverride: false, delegateFor: dlg };
  if (owner) return { ok: true, member: false, ownerOverride: true };
  if ((live.escalations ?? []).some((e) => e.by === userId)) return { ok: false, member: false, ownerOverride: false, why: 'You re-routed this approval, so a member of a group it was routed to by someone else decides.' };
  return { ok: false, member: false, ownerOverride: false, why: `Only members of ${a.approverGroup}${a.originalGroup && a.originalGroup !== a.approverGroup ? ` (or ${a.originalGroup}, which it was escalated from)` : ''} decide this; ask an owner to re-route it.` };
}

/** Why this waiting approval cannot be decided now: it expired, an emergency stop holds it, or its agent is paused. */
export function decideBlocker(orgId: string, a: Pick<Approval, 'id' | 'expiresAt'>): string | undefined {
  // fail closed: while the approvals service is down nothing is decided (and nothing expires)
  if (outageActive(orgId)) return OUTAGE_SENTENCE;
  if (Date.now() >= new Date(a.expiresAt).getTime()) {
    db.expireDue(orgId);
    return 'This approval expired. Expiry is a refusal: nothing ran.';
  }
  return api.decisionBlocked(orgId, a.id);
}

export interface TwoPersonPolicy { enabled: boolean; above: number }

export function twoPersonPolicy(orgId: string): TwoPersonPolicy {
  return clone(ext(orgId).twoPerson);
}

/**
 * true when this approval needs two different approvers: the organisation's policy for large amounts, or a declared
 * blast radius of the whole organisation (tenant) or across a boundary, which always needs dual control.
 */
export function needsTwo(orgId: string, a: Pick<Approval, 'amount'> & Partial<Pick<Approval, 'tool' | 'args' | 'riskTags' | 'counterparty'>>): boolean {
  return !!twoPersonReason(orgId, a);
}

/** Why two different approvers are needed: 'amount' (the two-person rule) or 'scope' (tenant or cross-boundary blast radius). */
export function twoPersonReason(orgId: string, a: Pick<Approval, 'amount'> & Partial<Pick<Approval, 'tool' | 'args' | 'riskTags' | 'counterparty'>>): 'amount' | 'scope' | undefined {
  const p = ext(orgId).twoPerson;
  if (p.enabled && (a.amount ?? 0) >= p.above) return 'amount';
  if (a.tool && blastRadius({ tool: a.tool, args: a.args ?? {}, riskTags: a.riskTags ?? [], counterparty: a.counterparty }).dualControl) return 'scope';
  return undefined;
}

export function firstApprovalOf(orgId: string, approvalId: string): Partial2 | undefined {
  const p = ext(orgId).partials[approvalId];
  return p ? clone(p) : undefined;
}

export async function setTwoPersonPolicy(orgId: string, patch: Partial<TwoPersonPolicy>, userId: string) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins set the two-person rule.');
  const x = ext(orgId);
  if (patch.above !== undefined && !(patch.above >= 1000)) throw new Error('Choose an amount of at least ₹1,000.');
  Object.assign(x.twoPerson, patch);
  const r = db.logAdmin(orgId, userId, 'approval.two_person_policy', { enabled: x.twoPerson.enabled, above: x.twoPerson.above });
  return { policy: clone(x.twoPerson), seq: r.seq };
}

export interface DecideResult { partial: boolean; receipt: Receipt; approval: Approval }

/**
 * Decide a held call. Approver-group membership is enforced (an owner may decide outside the group; the
 * override is recorded). When the two-person rule applies, the first approval is recorded as a partial
 * approval and the call keeps waiting for a second, different approver.
 */
export async function decide(orgId: string, approvalId: string, approve: boolean, userId: string, reason: string, channel: Channel = 'web', extra: DecideExtra = {}): Promise<DecideResult> {
  await wait(250, 500);
  const d = db.getDB(orgId);
  const a = d.approvals.find((x) => x.id === approvalId);
  if (!a || a.status !== 'pending') throw new Error('This approval is no longer waiting.');
  // a stop, a paused agent, an approvals outage or the expiry blocks every decision, the first of two included
  const blocked = decideBlocker(orgId, a);
  if (blocked) throw new Error(blocked);
  const who = mayDecide(orgId, a, userId);
  if (!who.ok) {
    // someone who decides approvals, but not this one (outside its group): the refused attempt is itself a receipt
    if (userId && can(db.memberRole(orgId, userId), 'approvals.decide')) {
      const r = db.logAdmin(orgId, userId, 'approval.decide_refused', { approval: a.id, attempted: approve ? 'approve' : 'reject', approver_group: a.approverGroup, channel, reason: (a.escalations ?? []).some((e) => e.by === userId) ? 're-routed this approval' : 'not in the approver group' }, a.agentSlug);
      db.touch(orgId, 'approval');
      throw new Error(`${who.why} This attempt is recorded (receipt #${r.seq}).`);
    }
    throw new Error(who.why);
  }
  const details = decisionDetails(orgId, a, approve, userId, who, extra);
  const x = ext(orgId);
  // a first approval counts only while the person who gave it may still decide (not removed, suspended or demoted)
  if (x.partials[a.id] && !mayDecide(orgId, a, x.partials[a.id].userId).ok) delete x.partials[a.id];
  const first = x.partials[a.id];
  if (approve && needsTwo(orgId, a)) {
    if (!first) {
      const r = db.logAdmin(orgId, userId, 'approval.partial', { approval: a.id, channel, approvals: 1, required: 2, amount: a.amount ?? 0, two_person_reason: twoPersonReason(orgId, a) ?? 'amount', ...(reason ? { note: reason } : {}), ...(who.ownerOverride ? { owner_override: true } : {}), ...details }, a.agentSlug);
      x.partials[a.id] = { userId, at: r.ts, seq: r.seq, reason, channel };
      db.touch(orgId, 'approval');
      return { partial: true, receipt: clone(r), approval: clone(a) };
    }
    if (first.userId === userId) throw new Error(`You gave the first approval at ${istTime(first.at)} IST. A different person gives the second.`);
  }
  const res = db.decideApproval(orgId, a.id, approve, userId, reason, channel, { ...(first ? { first_approver: first.userId, first_approval_seq: first.seq, two_person: true, two_person_reason: twoPersonReason(orgId, a) ?? 'amount' } : {}), ...details });
  return { partial: false, receipt: clone(res.receipt), approval: clone(res.approval) };
}

/** What the decide screen adds to a decision: the digest of exactly what the approver was shown. */
export interface DecideExtra { payloadDigest?: string; /** which screen the digest describes: the console decide screen or the single-use link page */ payloadView?: 'console' | 'link' }

/**
 * Checks that apply to approving only (rejecting is always safe), and the details every decision records:
 * the same-person rule in forbid mode, step-up for irreversible or high-value calls, the delegation the
 * decider acts under, and the payload digest of what they were shown.
 */
function decisionDetails(orgId: string, a: Approval, approve: boolean, userId: string, who: ReturnType<typeof mayDecide>, extra: DecideExtra): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (approve && sameActorBlocks(orgId, a, userId)) throw new Error('You own the agent that proposed this, so you cannot also approve it. Send it to another approver.');
  const step = approve ? stepUpReason(orgId, a) : undefined;
  if (step) {
    if (!hasStepUp(userId, a.id)) throw new Error(`Enter your password again to approve this. ${step}`);
    out.step_up = 'password';
  }
  if (who.delegateFor) out.delegated_from = who.delegateFor;
  if (extra.payloadDigest) {
    out.payload_digest = extra.payloadDigest;
    out.payload_view = extra.payloadView ?? 'console';
  }
  const br = blastRadius(a);
  out.blast_radius = br.scope;
  return out;
}

/** Approval links issued in this organisation (optionally for one approval), newest first. */
export function linksFor(orgId: string, approvalId?: string) {
  const d = db.getDB(orgId);
  return clone(d.platform.links.filter((l) => !approvalId || l.approvalId === approvalId));
}

/**
 * Decide through a single-use link as the signed-in person. The link must have been sent to that person.
 * With the two-person rule, a first approval through a link is recorded as partial and the link is used up.
 */
export async function decideByLink(token: string, approve: boolean, reason: string, userId: string, extra: DecideExtra = {}): Promise<DecideResult & { link: import('@/types').ApprovalLinkToken }> {
  const link = await api.resolveApprovalLink(token);
  if (link.usedAt) throw new Error(`This link was already used at ${istTime(link.usedAt)} IST. Links work once.`);
  // fail closed before expiry: while the approvals service is down nothing is decided and nothing expires, links included
  if (outageActive(link.orgId)) throw new Error(OUTAGE_SENTENCE);
  if (new Date(link.expiresAt).getTime() < Date.now()) throw new Error('This link has expired.');
  if (link.issuedTo !== userId) throw new Error(`This link was sent to ${userName(link.issuedTo)}. Sign in as them, or decide in the console.`);
  const d = db.getDB(link.orgId);
  const a = d.approvals.find((x) => x.id === link.approvalId);
  if (!a || a.status !== 'pending') throw new Error('This approval is no longer waiting.');
  // the same rules as the console: stop, pause and expiry block it, and the person must still be allowed to decide
  const blocked = decideBlocker(link.orgId, a);
  if (blocked) throw new Error(blocked);
  const who = mayDecide(link.orgId, a, userId);
  if (!who.ok) throw new Error(who.why);
  const details = decisionDetails(link.orgId, a, approve, userId, who, extra);
  const x = ext(link.orgId);
  if (x.partials[a.id] && !mayDecide(link.orgId, a, x.partials[a.id].userId).ok) delete x.partials[a.id];
  const first = x.partials[a.id];
  if (approve && needsTwo(link.orgId, a)) {
    if (first?.userId === userId) throw new Error(`You gave the first approval at ${istTime(first.at)} IST. A different person gives the second.`);
    if (!first) {
      await wait(200, 400);
      const r = db.logAdmin(link.orgId, userId, 'approval.partial', { approval: a.id, channel: link.channel, link: token.slice(-8), single_use: true, approvals: 1, required: 2, amount: a.amount ?? 0, two_person_reason: twoPersonReason(link.orgId, a) ?? 'amount', ...(reason ? { note: reason } : {}), ...details }, a.agentSlug);
      x.partials[a.id] = { userId, at: r.ts, seq: r.seq, reason, channel: link.channel };
      const t = d.platform.links.find((l) => l.token === token)!;
      t.usedAt = r.ts;
      t.usedBy = userId;
      t.usedSeq = r.seq;
      db.touch(link.orgId, 'approval');
      return { partial: true, receipt: clone(r), approval: clone(a), link: clone(t) };
    }
  }
  // the same single-use path as api.decideByLink, with the decide screen's details on the receipt
  await wait(250, 500);
  const t = d.platform.links.find((l) => l.token === token);
  if (!t) throw new Error('This link is not valid.');
  if (t.usedAt) throw new Error(`This link was already used at ${istTime(t.usedAt)} IST. Links work once.`);
  const res = db.decideApproval(link.orgId, a.id, approve, userId, reason, link.channel, { link: token.slice(-8), single_use: true, ...(first ? { first_approver: first.userId, first_approval_seq: first.seq, two_person: true } : {}), ...details });
  t.usedAt = res.receipt.ts;
  t.usedBy = userId;
  t.usedSeq = res.receipt.seq;
  db.touch(link.orgId, 'approval');
  return { partial: false, receipt: clone(res.receipt), approval: clone(res.approval), link: clone(t) };
}

/** Held calls with a first approval, waiting for a second, different approver. */
export function secondApprovals(orgId: string, userId?: string) {
  const d = db.getDB(orgId);
  const x = ext(orgId);
  return d.approvals.filter((a) => a.status === 'pending' && x.partials[a.id]).map((a) => {
    const first = x.partials[a.id];
    const who = mayDecide(orgId, a, userId);
    const mine = first.userId === userId;
    const blocked = api.decisionBlocked(orgId, a.id) ?? (Date.now() >= new Date(a.expiresAt).getTime() ? 'This approval expired. Expiry is a refusal.' : undefined);
    return { approval: clone(a), first: clone(first), canAct: who.ok && !mine && !blocked, whyNot: blocked ?? (mine ? 'You gave the first approval; a different person gives the second.' : who.why) };
  });
}

/** Parse rule settings the builder keeps in YAML (escalation, minimum autonomy, pack lock) from a version's text. */
export function ruleExtrasFromYaml(yaml: string): Record<string, Record<string, unknown>> {
  try {
    const doc = parseYaml(yaml) as { rules?: Record<string, unknown>[] };
    const out: Record<string, Record<string, unknown>> = {};
    for (const r of doc?.rules ?? []) if (r && typeof r.id === 'string') out[r.id] = r;
    return out;
  } catch {
    return {};
  }
}

/** "50%" of the approval window, or "2h", "30m", "1d" → milliseconds after the hold. */
export function escalateAfterMs(spec: string, windowMs: number): number | undefined {
  const s = spec.trim();
  const pct = /^(\d{1,3})\s*%$/.exec(s);
  if (pct) return (Math.min(100, Number(pct[1])) / 100) * windowMs;
  const m = /^(\d+)\s*(m|h|d)$/.exec(s);
  if (!m) return undefined;
  return Number(m[1]) * { m: 60_000, h: H, d: D }[m[2] as 'm' | 'h' | 'd'];
}

/** A rule's own escalation (escalate_to / escalate_after in the published rulebook), if it has one. */
export function ruleEscalation(orgId: string, a: Approval): { to: string; toName: string; after: string; atMs: number } | undefined {
  const d = db.getDB(orgId);
  const rb = d.rulebooks.find((b) => b.slug === a.agentSlug);
  const v = rb?.versions.find((x) => x.version === rb.currentVersion && x.status === 'published');
  if (!v) return undefined;
  const ex = ruleExtrasFromYaml(v.yaml)[a.ruleId];
  if (!ex || typeof ex.escalate_to !== 'string' || ex.escalate_after === undefined) return undefined;
  const windowMs = new Date(a.expiresAt).getTime() - new Date(a.createdAt).getTime();
  const after = escalateAfterMs(String(ex.escalate_after), windowMs);
  const g = groupFor(orgId, ex.escalate_to);
  if (after === undefined || !g) return undefined;
  return { to: g.id, toName: g.name, after: String(ex.escalate_after), atMs: new Date(a.createdAt).getTime() + after };
}

function runRuleEscalations(d: OrgDB) {
  // fail closed: while the approvals service is down nothing is re-routed
  if (outageActive(d.org.id)) return;
  const now = Date.now();
  let n = 0;
  for (const a of d.approvals) {
    if (a.status !== 'pending' || a.escalations?.some((e) => e.by === 'system')) continue;
    if (a.heldByStop) continue; // nobody can decide it while the stop holds it; re-routing would only add noise
    if (now >= new Date(a.expiresAt).getTime()) continue; // expired: expiry handles it
    const esc = ruleEscalation(d.org.id, a);
    if (!esc || now < esc.atMs || esc.toName.toLowerCase() === a.approverGroup.toLowerCase()) continue;
    a.originalGroup ??= a.approverGroup;
    const from = a.approverGroup;
    a.approverGroup = esc.toName;
    // the backup group is told through the saved routing for approval.escalated (Work › Channels)
    const reach = recipientsOf(d, 'approval.escalated', esc.toName);
    const r = db.append(d, { kind: 'admin', actor: 'system', action: 'approval.escalated', agent: a.agentSlug, details: { approval: a.id, from, to: esc.toName, rule: a.ruleId, after: esc.after, source: 'rule', notified: channelsOf(reach).join(','), notified_people: reach.filter((x) => x.email || x.slack || x.whatsapp).length } });
    (a.escalations ??= []).push({ at: r.ts, from, to: esc.toName, by: 'system', seq: r.seq });
    // the backup group gets single-use links like the first hold, deferred (mock/approvalNotify notifyRoutedApproval)
    { const orgId = d.org.id; const id = a.id; const seq = r.seq; setTimeout(() => { void import('@/mock/approvalNotify').then((m) => m.notifyRoutedApproval(orgId, id, 'escalated', seq)).catch(() => undefined); }, 0); }
    a.notified = Array.from(new Set([...a.notified, ...channelsOf(reach)])) as Channel[];
    a.notifiedTo = [...(a.notifiedTo ?? []), ...reach.filter((x) => !(a.notifiedTo ?? []).some((y) => y.userId === x.userId)).map((x) => ({ userId: x.userId, channels: recipientChannels(x) }))];
    n++;
  }
  if (n) db.touch(d.org.id, 'approval');
}

/* ══ Dual control policy and reviews ═════════════════════════ */

export function dualControl(orgId: string) {
  const level = levelOf(orgId);
  const enforcedByLevel = atLeast(level, 'l2');
  const x = ext(orgId);
  return { level, enforcedByLevel, policyL1: x.dualControlL1, enforced: enforcedByLevel || x.dualControlL1 };
}

export async function setDualControlL1(orgId: string, on: boolean, userId: string) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner'], 'Only an owner changes the dual-control policy.');
  ext(orgId).dualControlL1 = on;
  const r = db.logAdmin(orgId, userId, 'policy.dual_control', { enforced: on, level: levelOf(orgId) });
  return { on, seq: r.seq };
}

/** Send an erasure request back with a reason (owners and admins; not the requester's own call to make alone). */
export async function rejectErasure(orgId: string, id: string, userId: string, reason: string) {
  await wait(200, 400);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins decide erasure requests.');
  const d = db.getDB(orgId);
  const e = d.platform.erasures.find((x) => x.id === id);
  if (!e) throw new Error('No such erasure request.');
  if (e.status !== 'awaiting_approval') throw new Error('This request is not waiting for approval.');
  if (reason.trim().length < 10) throw new Error('Write the reason — at least a sentence.');
  const r = db.logAdmin(orgId, userId, 'erasure.rejected', { request: id, reason: reason.trim() });
  // sent back: no clock runs any more and nothing is erased
  e.status = 'rejected';
  e.rejectedAt = r.ts;
  e.rejectedBy = userId;
  e.rejectReason = reason.trim();
  db.touch(orgId, 'erasure');
  return { request: clone(e), seq: r.seq };
}

/* ══ Not done: the queue and shared explanations ═════════════ */

export async function notDone(orgId: string): Promise<NotDoneData> {
  await wait(80, 200);
  return deriveNotDone(db.getDB(orgId));
}

export function explanations(orgId: string): Record<string, Explanation> {
  return clone(ext(orgId).explained);
}

export async function listExplanations(orgId: string) {
  await wait(40, 100);
  return explanations(orgId);
}

/** Mark refusals explained (or put them back), shared by everyone in the organisation and recorded as one admin receipt. */
export async function explainRefusals(orgId: string, keys: string[], note: string, userId: string, on = true) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner', 'admin', 'approver'], 'Owners, admins and approvers mark refusals explained.');
  if (!keys.length) return { count: 0 };
  // from L2 the auditor-facing record says why each refusal was accepted: a note is required to mark them explained
  if (on && atLeast(levelOf(orgId), 'l2') && note.trim().length < 8) throw new Error('Write the operator note — at least a sentence. It is required at this level.');
  const x = ext(orgId);
  const seqs = keys.map(Number).filter((k) => Number.isFinite(k)).sort((a, b) => a - b);
  const r = db.logAdmin(orgId, userId, on ? 'refusal.explained' : 'refusal.explanation_withdrawn', { count: seqs.length, first_seq: seqs[0] ?? 0, last_seq: seqs[seqs.length - 1] ?? 0, ...(note ? { note } : {}) });
  for (const k of keys) {
    if (on) x.explained[k] = { by: userId, at: r.ts, note, seq: r.seq };
    else delete x.explained[k];
  }
  db.touch(orgId, 'explained');
  return { count: keys.length, seq: r.seq };
}

/* ══ Named lists ═════════════════════════════════════════════ */

const DEFAULT_LISTS = (): Record<string, string[]> => ({ approved_vendors: VENDOR_DOMAINS.map((d) => d.split('.')[0]), own_accounts: ['HDFC-OPS-0042', 'ICICI-FD-1180'] });

/** The organisation's named lists (approved_vendors, own_accounts …), as written in its rulebooks. */
export function namedLists(orgId: string): Record<string, string[]> {
  const x = ext(orgId);
  if (!x.namedLists) {
    const d = db.getDB(orgId);
    let found: Record<string, string[]> | undefined;
    for (const rb of d.rulebooks) {
      const v = rb.versions.find((y) => y.version === rb.currentVersion);
      try {
        const doc = parseYaml(v?.yaml ?? '') as { lists?: Record<string, unknown> };
        if (doc?.lists && typeof doc.lists === 'object') {
          found = Object.fromEntries(Object.entries(doc.lists).filter(([, val]) => Array.isArray(val)).map(([k, val]) => [k, (val as unknown[]).map(String)]));
          break;
        }
      } catch { /* keep looking */ }
    }
    x.namedLists = found && Object.keys(found).length ? found : DEFAULT_LISTS();
  }
  return clone(x.namedLists);
}

export async function setNamedList(orgId: string, name: string, values: string[], userId: string) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins edit named lists.');
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('A list name uses lower-case letters, numbers and underscores, for example approved_vendors.');
  const clean = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
  if (!clean.length) throw new Error('A list needs at least one value.');
  const lists = namedLists(orgId);
  lists[name] = clean;
  ext(orgId).namedLists = lists;
  const r = db.logAdmin(orgId, userId, 'list.updated', { list: name, values: clean.length });
  return { lists: clone(lists), seq: r.seq };
}

/** Replace named-list references in conditions with their values, so Try an action uses this organisation's lists. */
export function expandLists(rules: Rule[], lists: Record<string, string[]>): Rule[] {
  const ex = (v: Rule['when']) => v?.map((c) => (Array.isArray(c.value) ? { ...c, value: c.value.flatMap((x) => (lists[x] ? lists[x].flatMap((y) => [y, y.toLowerCase()]) : [x])) } : c));
  return rules.map((r) => ({ ...r, when: ex(r.when), unless: ex(r.unless) }));
}

/* ══ Tools: the catalogue plus every connector's tools ═══════ */

/** The tool catalogue as this organisation sees it (the shared catalogue, its connectors, and its own registered tools and tags). */
export function orgTools(orgId: string): ToolDef[] {
  return db.orgToolDefs(orgId);
}

/* ══ Rule suggestions: the nightly run, created on demand too ══ */

export interface SuggestionGroup {
  key: string; agent: string; ruleId: string; approved: number; rejected: number; expired: number; counterparties: string[];
  first: string; last: string; qualifies: boolean; why: string; suggestionId?: string; maxAmount?: number;
}

const FORBIDDEN_TAGS = ['deletes', 'changes_access', 'changes_production'];

/** Groups of decided approvals in the last 30 days, judged by the suggestion rules (the 02:00 IST run uses the same code). */
export function suggestionGroups(orgId: string): SuggestionGroup[] {
  const d = db.getDB(orgId);
  const tools = orgTools(orgId);
  const from = Date.now() - 30 * D;
  const m = new Map<string, Omit<SuggestionGroup, 'counterparties'> & { cps: Set<string> }>();
  for (const a of d.approvals) {
    if (new Date(a.createdAt).getTime() < from || a.status === 'pending') continue;
    const key = `${a.agentSlug}:${a.ruleId}`;
    const g = m.get(key) ?? { key, agent: a.agentSlug, ruleId: a.ruleId, approved: 0, rejected: 0, expired: 0, first: a.createdAt, last: a.createdAt, qualifies: false, why: '', cps: new Set<string>(), maxAmount: undefined };
    if (a.status === 'approved' || a.status === 'approved_run_failed') { g.approved++; if (a.amount !== undefined) g.maxAmount = Math.max(g.maxAmount ?? 0, a.amount); }
    else if (a.status === 'rejected') g.rejected++;
    else if (a.status === 'expired') g.expired++;
    if (a.counterparty) g.cps.add(a.counterparty);
    if (a.createdAt < g.first) g.first = a.createdAt;
    if (a.createdAt > g.last) g.last = a.createdAt;
    m.set(key, g);
  }
  return Array.from(m.values()).map(({ cps, ...g }) => {
    const span = (new Date(g.last).getTime() - new Date(g.first).getTime()) / D;
    const rb = d.rulebooks.find((r) => r.slug === g.agent);
    const pub = rb?.versions.find((v) => v.version === rb.currentVersion && v.status === 'published');
    const rule = pub?.rules.find((r) => r.id === g.ruleId);
    const ruleTools = rule?.match.tool ? [rule.match.tool] : [];
    const forbidden = rule?.decide === 'refuse' || ruleTools.some((t) => tools.find((x) => x.name === t)?.tags.some((tg) => FORBIDDEN_TAGS.includes(tg))) || FORBIDDEN_TAGS.includes(rule?.match.tag ?? '');
    const why = g.approved < 10 ? `${g.approved} approvals; needs 10` : g.rejected + g.expired > 0 ? `${g.rejected} rejected, ${g.expired} expired` : span < 7 ? 'Spans under 7 days' : Date.now() - new Date(g.last).getTime() > 14 * D ? 'Latest approval over 14 days ago' : forbidden ? 'Never suggested for deletes, access or production' : 'Qualifies';
    const s = rb ? d.suggestions.find((x) => x.rulebookId === rb.id && (x.proposed.id === g.ruleId || x.proposed.id === `${g.ruleId}-precedent` || x.title.toLowerCase().includes(g.ruleId))) : undefined;
    return { ...g, counterparties: Array.from(cps), qualifies: why === 'Qualifies', why, suggestionId: s?.id };
  }).sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || b.approved - a.approved);
}

function proposalFor(d: OrgDB, g: SuggestionGroup): RuleSuggestion | undefined {
  const rb = d.rulebooks.find((r) => r.slug === g.agent);
  const pub = rb?.versions.find((v) => v.version === rb.currentVersion && v.status === 'published');
  const held = pub?.rules.find((r) => r.id === g.ruleId);
  if (!rb || !held) return undefined;
  const when = (held.when ?? []).filter((c) => !(typeof c.value === 'number' && /amount/i.test(c.field) && (c.op === 'gt' || c.op === 'gte')));
  if (g.maxAmount) when.push({ field: 'amount', op: 'lte', value: Math.ceil(g.maxAmount / 1000) * 1000 });
  const cpField = g.agent && held.match.tool?.includes('email') ? undefined : 'vendor';
  if (cpField && g.counterparties.length && g.counterparties.length <= 8) when.push({ field: cpField, op: 'in', value: g.counterparties });
  const days = Math.max(1, Math.round((new Date(g.last).getTime() - new Date(g.first).getTime()) / D));
  const proposed: Rule = { id: `${g.ruleId}-precedent`, match: held.match, ...(when.length ? { when } : {}), decide: 'allow', reason: `Allowed within what people already approved: ${g.approved} approvals over ${days} days, none rejected.` };
  return {
    id: `sg_${g.agent}_${g.ruleId}`.replace(/[^a-z0-9_-]/gi, '_'), rulebookId: rb.id,
    title: `Allow ${held.match.tool ?? held.match.tag} calls like the ${g.approved} already approved under ${g.ruleId}`,
    rationale: `${g.approved} calls held by ${g.ruleId} were approved over ${days} days${g.counterparties.length ? ` for ${g.counterparties.length} counterparties` : ''}${g.maxAmount ? `, the largest ${rupees(g.maxAmount)}` : ''}. None was rejected or expired.`,
    evidence: { approvals: g.approved, days, counterparties: g.counterparties.length, rejections: g.rejected },
    proposed, createdAt: iso(Date.now()), status: 'open',
  };
}

/** Create a suggestion from a qualifying group (a person asked for it from Look for suggestions). */
export async function createSuggestion(orgId: string, key: string, userId: string) {
  await wait(200, 400);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins create suggestions.');
  const d = db.getDB(orgId);
  const g = suggestionGroups(orgId).find((x) => x.key === key);
  if (!g) throw new Error('That group is no longer in the last 30 days.');
  if (!g.qualifies) throw new Error(`This group does not qualify: ${g.why}.`);
  if (g.suggestionId) throw new Error('A suggestion for this group already exists.');
  const s = proposalFor(d, g);
  if (!s) throw new Error('The rule that held these calls is no longer in the published rulebook.');
  d.suggestions.unshift(s);
  db.logAdmin(orgId, userId, 'suggestion.created', { suggestion: s.id, rule: g.ruleId, approvals: g.approved, source: 'manual' }, g.agent);
  return clone(s);
}

/** The 02:00 IST run: create suggestions for qualifying groups and reopen dismissed ones whose approvals at least doubled. */
export function runSuggestionScan(orgId: string, actor = 'system') {
  const d = db.getDB(orgId);
  const x = ext(orgId);
  const created: string[] = [];
  const reopened: string[] = [];
  for (const g of suggestionGroups(orgId)) {
    if (g.suggestionId) {
      const s = d.suggestions.find((y) => y.id === g.suggestionId);
      const dis = s && x.dismissals[s.id];
      if (s && s.status === 'dismissed' && dis && g.approved >= dis.approvals * 2) {
        s.status = 'open';
        s.evidence = { ...s.evidence, approvals: g.approved, rejections: g.rejected };
        db.logAdmin(orgId, actor, 'suggestion.reopened', { suggestion: s.id, approvals_at_dismissal: dis.approvals, approvals_now: g.approved }, g.agent);
        reopened.push(s.id);
      }
      continue;
    }
    if (!g.qualifies) continue;
    const s = proposalFor(d, g);
    if (!s) continue;
    d.suggestions.unshift(s);
    db.logAdmin(orgId, actor, 'suggestion.created', { suggestion: s.id, rule: g.ruleId, approvals: g.approved, source: actor === 'system' ? 'nightly run' : 'manual run' }, g.agent);
    created.push(s.id);
  }
  x.suggestionScanAt = iso(Date.now());
  db.touch(orgId, 'suggestion');
  return { created, reopened, at: x.suggestionScanAt };
}

/** The most recent 02:00 IST. */
export function lastNightlyRun(now = Date.now()) {
  const t = new Date(now + 5.5 * H);
  t.setUTCHours(2, 0, 0, 0);
  let ms = t.getTime() - 5.5 * H;
  if (ms > now) ms -= D;
  return ms;
}

/** Catch up the nightly run if it has not run since the last 02:00 IST (the console was closed). */
export function ensureNightlyScan(orgId: string) {
  const x = ext(orgId);
  if (x.suggestionScanAt && new Date(x.suggestionScanAt).getTime() >= lastNightlyRun()) return undefined;
  return runSuggestionScan(orgId, 'system');
}

export function suggestionScanAt(orgId: string) {
  return ext(orgId).suggestionScanAt;
}

export async function dismissSuggestion(orgId: string, id: string, reason: string, userId: string) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins dismiss suggestions.');
  if (reason.trim().length < 4) throw new Error('Say why — the reason is recorded.');
  const d = db.getDB(orgId);
  const s = d.suggestions.find((x) => x.id === id);
  if (!s) throw new Error('No such suggestion.');
  s.status = 'dismissed';
  const r = db.logAdmin(orgId, userId, 'suggestion.dismissed', { suggestion: id, reason: reason.trim(), approvals: s.evidence.approvals });
  ext(orgId).dismissals[id] = { reason: reason.trim(), by: userId, at: r.ts, approvals: s.evidence.approvals, seq: r.seq };
  db.touch(orgId, 'suggestion');
  return clone(s);
}

export function dismissalOf(orgId: string, id: string) {
  const v = ext(orgId).dismissals[id];
  return v ? clone(v) : undefined;
}

/* ══ Alerts: settings, deliveries, the live detectors, assurance health ══ */

export const DEFAULT_SENSITIVITY: Sensitivity = 'default';

export function alertSettings(orgId: string) {
  const x = ext(orgId);
  return { detectors: clone(x.detectors), autoPause: clone(x.autoPause) };
}

export async function getAlertSettings(orgId: string) {
  await wait(40, 100);
  return alertSettings(orgId);
}

export const detectorOn = (orgId: string, id: AnyDetector) => ext(orgId).detectors[id]?.on ?? true;
export const detectorSensitivity = (orgId: string, id: AnyDetector): Sensitivity => ext(orgId).detectors[id]?.sensitivity ?? 'default';
export const autoPauseFor = (orgId: string, slug: string) => !!ext(orgId).autoPause[slug];

export async function setDetector(orgId: string, id: AnyDetector, on: boolean, userId: string) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins change detectors.');
  const x = ext(orgId);
  x.detectors[id] = { on, sensitivity: x.detectors[id]?.sensitivity ?? 'default' };
  return db.logAdmin(orgId, userId, on ? 'detector.enabled' : 'detector.disabled', { detector: id });
}

export async function setSensitivity(orgId: string, id: AnyDetector, sensitivity: Sensitivity, userId: string) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins change detectors.');
  const x = ext(orgId);
  x.detectors[id] = { on: x.detectors[id]?.on ?? true, sensitivity };
  return db.logAdmin(orgId, userId, 'detector.sensitivity', { detector: id, sensitivity });
}

export async function setAutoPause(orgId: string, slug: string, on: boolean, userId: string) {
  await wait(150, 300);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins set auto-pause.');
  ext(orgId).autoPause[slug] = on;
  return db.logAdmin(orgId, userId, on ? 'autopause.enabled' : 'autopause.disabled', { agent: slug }, slug);
}

/**
 * Who an alert notification goes to: the saved routing for alert.high, alert.medium or alert.low (Work › Channels),
 * to the active owners and admins on each channel it switches on and they have linked, plus the webhooks
 * subscribed to alert.created. Every alert is also in the console's Alerts queue.
 */
function plannedDeliveries(d: OrgDB, a: { id: string; severity: Severity; createdAt: string }): Delivery[] {
  const out: Delivery[] = [];
  const t = new Date(a.createdAt).getTime();
  const reach = recipientsOf(d, `alert.${a.severity}`);
  const LABEL: Record<'email' | 'slack' | 'whatsapp', string> = { email: 'Email with a link to this alert.', slack: 'Slack message with a link to this alert.', whatsapp: 'WhatsApp message with a link to this alert.' };
  for (const x of reach) {
    const u = userById(x.userId);
    if (!u) continue;
    (['email', 'slack', 'whatsapp'] as const).forEach((ch, i) => {
      if (!x[ch]) return;
      out.push({ id: `${a.id}_${ch}_${u.id}`, channel: ch, target: ch === 'email' ? `${u.name} <${u.email}>` : u.name, at: iso(t + 20_000 + i * 1000), status: 'delivered', detail: LABEL[ch] });
    });
  }
  out.unshift({ id: `${a.id}_console`, channel: 'console', target: 'Alerts queue', at: iso(t), status: 'delivered', detail: out.length ? 'Shown in the Alerts queue.' : `Shown in the Alerts queue only: the saved routing for ${a.severity} alerts sends it nowhere else.` });
  d.webhooks.filter((w: Webhook) => w.events.includes('alert.created') && w.status !== 'disabled').forEach((w, i) => {
    const failing = w.status === 'failing';
    out.push({ id: `${a.id}_wh_${w.id}`, channel: 'webhook', target: w.url, at: iso(t + 30_000 + i * 1000), status: failing ? 'failed' : 'delivered', code: failing ? 502 : 200, detail: failing ? 'alert.created was not accepted after 8 attempts. The endpoint is marked failing in Assurance › Exports.' : 'alert.created accepted.' });
  });
  return out;
}

function deliveriesOf(d: OrgDB, x: WorkExt, a: { id: string; severity: Severity; createdAt: string }) {
  return x.deliveries[a.id] ?? plannedDeliveries(d, a);
}

/* ── Live behavioural detectors ───────────────────────────── */

const SENS: Record<Sensitivity, number> = { fewer: 1.5, default: 1, more: 0.67 };
const median = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mad = (xs: number[], m: number) => median(xs.map((v) => Math.abs(v - m)));

interface Finding { detector: Detector; severity: Severity; agent: string; title: string; detail: string; baseline: string; observed: string; seqs: number[] }

function detectFor(d: OrgDB, x: WorkExt, slug: string, fresh: Receipt[]): Finding[] {
  const out: Finding[] = [];
  const now = Date.now();
  const all = d.receipts.filter((r) => r.kind === 'decision' && r.agent === slug);
  const agent = d.agents.find((a) => a.slug === slug);
  if (!agent || now - new Date(agent.createdAt).getTime() < 7 * D) return out; // no alerts in an agent's first 7 days
  const lastHour = all.filter((r) => now - new Date(r.ts).getTime() < H);
  const base = all.filter((r) => { const age = now - new Date(r.ts).getTime(); return age >= H && age < 14 * D; });
  const sens = (id: Detector) => SENS[(x.detectors[id]?.sensitivity ?? 'default') as Sensitivity];
  const on = (id: Detector) => x.detectors[id]?.on ?? true;

  // refusal surge — refused share in the last hour against the 14-day share (stop and pause refusals excluded)
  if (on('refusal_surge')) {
    const cur = lastHour.filter((r) => r.rule_id !== 'agent-paused');
    const bs = base.filter((r) => r.rule_id !== 'agent-paused');
    if (cur.length >= 10 && bs.length >= 20) {
      const share = cur.filter((r) => r.decision === 'refuse').length / cur.length;
      const bshare = bs.filter((r) => r.decision === 'refuse').length / bs.length;
      const lift = share - bshare;
      const k = sens('refusal_surge');
      if (lift >= 0.3 * k) {
        const sev: Severity = lift >= 0.6 * k ? 'high' : 'medium';
        out.push({ detector: 'refusal_surge', severity: sev, agent: slug, title: `Refusals at ${Math.round(share * 100)}% of ${slug}'s calls this hour`, detail: `${cur.filter((r) => r.decision === 'refuse').length} of ${cur.length} calls in the last hour were refused. The usual share is ${Math.round(bshare * 100)}%.`, baseline: `${Math.round(bshare * 100)}% refused over 14 days`, observed: `${Math.round(share * 100)}% refused in the last hour`, seqs: cur.filter((r) => r.decision === 'refuse').slice(-8).map((r) => r.seq) });
      }
    }
  }
  // amount outlier — median-based z-score of each new amount against this agent's amounts
  if (on('amount_outlier')) {
    const amounts = base.map((r) => Number(r.args_summary?.amount)).filter((v) => Number.isFinite(v) && v > 0);
    if (amounts.length >= 5) {
      const m = median(amounts);
      const dev = 1.4826 * mad(amounts, m) || m * 0.1 || 1;
      const k = sens('amount_outlier');
      for (const r of fresh) {
        const v = Number(r.args_summary?.amount);
        if (!Number.isFinite(v)) continue;
        const z = (v - m) / dev;
        if (z >= 6 * k) {
          out.push({ detector: 'amount_outlier', severity: z >= 15 * k ? 'high' : 'medium', agent: slug, title: `${rupees(v)} — far above ${slug}'s usual amounts`, detail: `${slug} called ${r.tool} with ${rupees(v)}. The median of its last ${amounts.length} amounts is ${rupees(m)}.`, baseline: `Median ${rupees(m)} over 14 days`, observed: rupees(v), seqs: [r.seq] });
          break;
        }
      }
    }
  }
  // new tool — first use by this agent
  if (on('new_tool')) {
    const seen = new Set(d.receipts.filter((r) => r.agent === slug && r.kind === 'decision' && !fresh.includes(r)).map((r) => r.tool));
    const firstNew = fresh.find((r) => r.tool && !seen.has(r.tool));
    if (firstNew && seen.size > 0) out.push({ detector: 'new_tool', severity: 'low', agent: slug, title: `First call to ${firstNew.tool}`, detail: `${slug} called a tool it had not used before. The call was ${firstNew.decision === 'refuse' ? 'refused' : firstNew.decision === 'ask' ? 'held for a person' : 'allowed'} by rule ${firstNew.rule_id}.`, baseline: `${seen.size} tools used`, observed: `${seen.size + 1} tools`, seqs: [firstNew.seq] });
  }
  // volume spike — needs a baseline with at least one call an hour; sparse histories are not scored
  if (on('volume_spike')) {
    const hours = Array.from({ length: 14 * 24 }, (_, i) => base.filter((r) => { const age = now - new Date(r.ts).getTime(); return age >= (i + 1) * H && age < (i + 2) * H; }).length);
    const m = median(hours);
    if (m >= 1 && lastHour.length >= 20) {
      const z = (lastHour.length - m) / (1.4826 * mad(hours, m) || 1);
      const k = sens('volume_spike');
      if (z >= 6 * k) out.push({ detector: 'volume_spike', severity: z >= 12 * k ? 'high' : 'medium', agent: slug, title: `Call volume ${Math.round(lastHour.length / m)}× the usual hour`, detail: `${slug} made ${lastHour.length} calls in the last hour.`, baseline: `${m} calls in a usual hour`, observed: `${lastHour.length} calls in the last hour`, seqs: lastHour.slice(-6).map((r) => r.seq) });
    }
  }
  // new counterparty — a vendor, mail domain or account this agent has not dealt with in the last 90 days
  if (on('new_counterparty')) {
    const partyOf = (r: Receipt) => { const a = r.args_summary ?? {}; const v = a.vendor ?? a.to_domain ?? a.to_account ?? a.counterparty; return v === undefined ? undefined : String(v).toLowerCase(); };
    const since = now - 90 * D;
    const seen = new Set(all.filter((r) => !fresh.includes(r) && new Date(r.ts).getTime() >= since).map(partyOf).filter((v): v is string => !!v));
    const first = fresh.find((r) => r.rule_id !== 'agent-paused' && partyOf(r) && !seen.has(partyOf(r)!));
    if (first && seen.size > 0) {
      const party = partyOf(first)!;
      const amount = Number(first.args_summary?.amount);
      out.push({ detector: 'new_counterparty', severity: Number.isFinite(amount) && amount > 0 ? 'medium' : 'low', agent: slug, title: `New counterparty: ${party}`, detail: `${slug} called ${first.tool} for ${party}, which it has not dealt with in the last 90 days. The call was ${first.decision === 'refuse' ? 'refused' : first.decision === 'ask' ? 'held for a person' : 'allowed'} by rule ${first.rule_id}.`, baseline: `${seen.size} counterparties in 90 days`, observed: party, seqs: [first.seq] });
    }
  }
  // off hours — a call in an hour of the week (IST) when this agent almost never acts
  if (on('off_hours') && base.length >= 200) {
    const how = (ts: string) => { const dt = new Date(new Date(ts).getTime() + 5.5 * H); return dt.getUTCDay() * 24 + dt.getUTCHours(); };
    const buckets = new Map<number, number>();
    for (const r of base) buckets.set(how(r.ts), (buckets.get(how(r.ts)) ?? 0) + 1);
    const limit = 0.005 / sens('off_hours');
    const odd = fresh.find((r) => r.rule_id !== 'agent-paused' && (buckets.get(how(r.ts)) ?? 0) / base.length <= limit);
    if (odd) {
      const hhmm = new Date(new Date(odd.ts).getTime() + 5.5 * H).toISOString().slice(11, 16);
      const share = ((buckets.get(how(odd.ts)) ?? 0) / base.length) * 100;
      out.push({ detector: 'off_hours', severity: odd.decision === 'allow' && !String(odd.details?.tags ?? '').split(',').every((t) => t === 'reads_data' || t === '') ? 'medium' : 'low', agent: slug, title: `${odd.tool} at ${hhmm} IST`, detail: `${slug} acted at ${hhmm} IST, an hour of the week that holds ${share.toFixed(1)}% of its calls over the last 14 days.`, baseline: `${base.length} calls over 14 days, mostly in working hours`, observed: `${hhmm} IST`, seqs: [odd.seq] });
    }
  }
  return out;
}

function raise(d: OrgDB, x: WorkExt, f: Finding) {
  const orgId = d.org.id;
  const id = `al_${f.detector}_${Date.now().toString(36)}`;
  const createdAt = iso(Date.now());
  const alert: Alert = { id, detector: f.detector, severity: f.severity, agentSlug: f.agent, title: f.title, detail: f.detail, baseline: f.baseline, observed: f.observed, status: 'open', createdAt, relatedSeqs: f.seqs };
  d.alerts.unshift(alert);
  const r = db.append(d, { kind: 'admin', actor: 'system', action: 'alert.created', agent: f.agent, details: { alert: id, detector: f.detector, severity: f.severity } });
  const deliveries = plannedDeliveries(d, alert).map((del) => ({ ...del, at: del.at < r.ts ? r.ts : del.at }));
  x.deliveries[id] = deliveries;
  for (const w of d.webhooks.filter((wh) => wh.events.includes('alert.created') && wh.status !== 'disabled')) {
    w.deliveries.unshift({ id: `del_${id}_${w.id}`, event: 'alert.created', ts: r.ts, status: w.status === 'failing' ? 502 : 200, attempts: w.status === 'failing' ? 8 : 1, ms: w.status === 'failing' ? 9000 : 180 });
  }
  const agent = d.agents.find((a) => a.slug === f.agent);
  if (f.severity === 'high' && x.autoPause[f.agent] && agent && agent.status === 'active') {
    agent.status = 'paused';
    agent.pausedBy = 'auto-pause';
    alert.autoPaused = true;
    const pr = db.append(d, { kind: 'admin', actor: 'system', action: 'agent.paused', agent: f.agent, details: { reason: `Auto-pause: high-severity ${f.detector} alert ${id}`, alert: id } });
    const inc: Incident = {
      id: `inc_ap_${Date.now().toString(36)}`, title: `${f.agent} auto-paused`, kind: 'auto_pause', status: 'active', scope: 'selected_agents', agentSlugs: [f.agent],
      startedAt: pr.ts, startedBy: 'system', reason: `High-severity ${f.detector.replace('_', ' ')} alert with auto-pause on.`, refusedWhileStopped: 0,
      pendingApprovalsAtStop: d.approvals.filter((a) => a.status === 'pending').length,
      timeline: [
        { ts: r.ts, text: `${f.detector} raised at high severity`, seq: r.seq },
        { ts: pr.ts, text: `Auto-pause paused ${f.agent}`, seq: pr.seq, actor: 'system' },
        { ts: pr.ts, text: `Owners and admins: ${reachPhrase(recipientsOf(d, `alert.${f.severity}`))}; ${plural(deliveries.filter((x2) => x2.channel === 'webhook').length, 'webhook')} called` },
      ],
    };
    d.incidents.unshift(inc);
  }
  x.lastAlertAt[`${f.detector}|${f.agent}`] = Date.now();
  db.touch(orgId, 'alert');
}

function scanBehaviour(d: OrgDB) {
  const x = ext(d.org.id);
  const head = d.receipts[d.receipts.length - 1];
  if (!head) return;
  if (x.lastScanSeq === undefined) { x.lastScanSeq = head.seq; return; } // start from now; history is already judged
  const fresh = d.receipts.filter((r) => r.seq > x.lastScanSeq! && r.kind === 'decision' && r.agent);
  x.lastScanSeq = head.seq;
  if (!fresh.length) return;
  for (const slug of new Set(fresh.map((r) => r.agent!))) {
    for (const f of detectFor(d, x, slug, fresh.filter((r) => r.agent === slug))) {
      const last = x.lastAlertAt[`${f.detector}|${f.agent}`] ?? 0;
      if (Date.now() - last < 6 * H) continue;
      if (d.alerts.some((a) => a.detector === f.detector && a.agentSlug === f.agent && a.status !== 'resolved' && Date.now() - new Date(a.createdAt).getTime() < 24 * H)) continue;
      raise(d, x, f);
    }
  }
}

/* ── Assurance-health detectors (L2, L3, Sovereign) ───────── */

export const HEALTH_FOR: Partial<Record<AssuranceDetector, HealthKind>> = {
  chain_integrity: 'chain_break', tsa_late: 'tsa_outage', kms_signing: 'kms_failure', worm_write: 'worm_failure', update_signature: 'update_signature',
  node_down: 'node_down', counterparty_verification: 'counterparty_dispute', autonomy_exceeded: 'autonomy_breach', inclusion_proof: 'chain_break',
  receipt_write: 'receipt_write',
};

let vectorCache: { agree: number; total: number; at: string } | undefined;

function chainLinkage(d: OrgDB) {
  const rs = d.receipts.slice(-300);
  for (let i = 1; i < rs.length; i++) {
    if (rs[i].prev_hash !== rs[i - 1].hash) return { ok: false, seq: rs[i].seq, why: 'prev_hash does not match the receipt before it' };
    if (!contentOk(rs[i], d.publicKeys)) return { ok: false, seq: rs[i].seq, why: 'the receipt hash does not match its contents' };
  }
  return { ok: true as const, checked: rs.length, from: rs[0]?.seq, to: rs[rs.length - 1]?.seq };
}

/** Assurance alerts derived from the organisation's own evidence: anchors, custody, storage, verifier, counterparties, updates. */
type DerivedAlert = Omit<WorkAlert, 'status' | 'deliveries' | 'acknowledgedBy' | 'resolvedAt'> & { defaultStatus: Alert['status']; recoveredAt?: string };

async function deriveAssurance(orgId: string): Promise<DerivedAlert[]> {
  const level = levelOf(orgId);
  const d = db.getDB(orgId);
  const out: DerivedAlert[] = [];
  const base = { family: 'assurance' as const, agentSlug: '', relatedSeqs: [] as number[] };
  const x = ext(orgId);
  const on = (id: AssuranceDetector) => x.detectors[id]?.on ?? true;

  // From L1: a break in the hash chain, or a receipt the store would not take, opens a health incident at every level.
  if (on('chain_integrity')) {
    const c = chainLinkage(d);
    if (!c.ok) out.push({ ...base, id: `as_chain_${c.seq}`, detector: 'chain_integrity', severity: 'high', title: `Chain integrity check failed at receipt #${c.seq}`, detail: `The check of the last 300 receipts found that ${c.why}. Nothing is overwritten; the break is evidence.`, baseline: 'Every receipt links to the one before', observed: `Break at #${c.seq}`, createdAt: iso(Date.now()), relatedSeqs: [c.seq], evidence: { label: 'Chain', to: '/activity/chain' }, defaultStatus: 'open' });
  }
  if (on('receipt_write')) {
    for (const f of opsWriteFailures(orgId)) {
      const ended = !!f.endedAt && new Date(f.endedAt).getTime() <= Date.now();
      out.push({ ...base, id: `as_write_${f.id}`, detector: 'receipt_write', severity: 'high', title: f.source === 'drill' ? 'Receipt-write drill: receipts could not be written' : 'Receipts could not be written', detail: f.error, baseline: 'Every decision is written before the call runs', observed: ended ? `Writes failed from ${istTime(f.at)} to ${istTime(f.endedAt!)} IST` : `Writes failing since ${istTime(f.at)} IST`, createdAt: f.at, recoveredAt: f.endedAt, evidence: { label: 'Not done', to: '/work/not-done' }, defaultStatus: 'open' });
    }
  }
  if (!atLeast(level, 'l2')) return out;
  const [anchors, custody, deployment] = await Promise.all([
    api.anchors(orgId, 8).catch(() => undefined),
    api.custody(orgId).catch(() => undefined),
    api.deployment(orgId).catch(() => undefined),
  ]);
  if (anchors && on('tsa_late')) {
    for (const inc of anchors.incidents) {
      out.push({ ...base, id: `as_tsa_${inc.id}`, detector: 'tsa_late', severity: inc.status === 'open' ? 'high' : 'medium', title: inc.status === 'open' ? `Timestamps late: ${inc.records} records waiting` : `Timestamp authority unreachable for ${Math.round((new Date(inc.to ?? Date.now()).getTime() - new Date(inc.from).getTime()) / 60_000)} minutes`, detail: inc.summary, baseline: `Both authorities within ${anchors.totals.targetMinutes} minutes`, observed: `${inc.records} records late`, createdAt: inc.from, recoveredAt: inc.to, evidence: { label: 'Timestamps', to: '/assurance/anchors' }, defaultStatus: inc.status === 'open' ? 'open' : 'resolved' });
    }
    const missing = anchors.batches.find((b) => b.tokens.length < anchors.authorities.length);
    if (missing) out.push({ ...base, id: `as_tsa_missing_${missing.id}`, detector: 'tsa_late', severity: 'high', title: `Batch ${missing.id} has ${missing.tokens.length} of ${anchors.authorities.length} timestamps`, detail: 'One authority did not answer for this batch.', baseline: 'Two timestamps per batch', observed: `${missing.tokens.length} timestamp`, createdAt: missing.windowEnd, evidence: { label: 'Timestamps', to: '/assurance/anchors' }, defaultStatus: 'open' });
  }
  if (anchors && on('inclusion_proof') && anchors.totals.lastAnchoredSeq !== undefined) {
    const proof = await api.inclusionProof(orgId, anchors.totals.lastAnchoredSeq).catch(() => undefined);
    if (proof && !proof.verified) out.push({ ...base, id: `as_proof_${proof.batchId}`, detector: 'inclusion_proof', severity: 'high', title: `Inclusion proof failed for receipt #${proof.seq}`, detail: `The path from receipt #${proof.seq} does not lead to the root of batch ${proof.batchId}.`, baseline: 'Every sealed receipt proves into its batch root', observed: 'Root mismatch', createdAt: iso(Date.now()), relatedSeqs: [proof.seq], evidence: { label: 'Timestamps', to: '/assurance/anchors' }, defaultStatus: 'open' });
  }
  if (custody && on('kms_signing')) {
    const head = d.receipts[d.receipts.length - 1];
    if (head && head.kid !== custody.kid) out.push({ ...base, id: `as_kms_${head.kid}`, detector: 'kms_signing', severity: 'high', title: 'The newest receipt is not signed with the key in custody', detail: `Receipt #${head.seq} was signed by ${head.kid}; ${custody.provider} holds ${custody.kid}.`, baseline: `Signed by ${custody.provider}`, observed: head.kid, createdAt: head.ts, relatedSeqs: [head.seq], evidence: { label: 'Keys', to: '/agents/keys' }, defaultStatus: 'open' });
  }
  if (deployment && on('worm_write') && deployment.storage.objectLock !== 'compliance') {
    out.push({ ...base, id: 'as_worm_mode', detector: 'worm_write', severity: 'high', title: 'Write-once storage is not in compliance mode', detail: `Object lock is set to ${deployment.storage.objectLock}. Receipts could be removed by a privileged user before their retention ends.`, baseline: 'Compliance mode', observed: deployment.storage.objectLock, createdAt: iso(Date.now()), evidence: { label: 'Deployment', to: '/agents/deployment' }, defaultStatus: 'open' });
  }
  if (deployment && on('node_down') && deployment.mode === 'sovereign') {
    for (const n of deployment.cluster.nodes.filter((x2) => x2.status !== 'ready')) {
      out.push({ ...base, id: `as_node_${n.name}`, detector: 'node_down', severity: 'high', title: `Node ${n.name} is not ready`, detail: `A ${n.role} node in ${n.zone} stopped reporting ready.`, baseline: `${deployment.cluster.nodes.length} nodes ready`, observed: `${n.name} not ready`, createdAt: iso(Date.now()), evidence: { label: 'Deployment', to: '/agents/deployment' }, defaultStatus: 'open' });
    }
  }
  if (deployment && on('update_signature')) {
    for (const u of deployment.updates.filter((x2) => x2.status === 'rejected')) {
      out.push({ ...base, id: `as_update_${u.id}`, detector: 'update_signature', severity: 'high', title: `Update bundle ${u.version} failed its signature check`, detail: `The bundle's Ed25519 signature does not verify against the elan1 release key (${deployment.release.fingerprint.slice(0, 16)}…). It was not installed. ${u.notes[0] ?? ''}`.trim(), baseline: 'Signed by the elan1 release key', observed: `Signed by ${u.kid}`, createdAt: u.stagedAt ?? u.publishedAt, evidence: { label: 'Deployment', to: '/agents/deployment' }, defaultStatus: 'open' });
    }
  }
  if (on('implementations_disagree')) {
    if (!vectorCache) {
      const suite = await api.testVectors().catch(() => undefined);
      if (suite) vectorCache = { agree: suite.summary.agree, total: suite.summary.total, at: iso(Date.now()) };
    }
    if (vectorCache && vectorCache.agree < vectorCache.total) out.push({ ...base, id: 'as_vectors', detector: 'implementations_disagree', severity: 'high', title: `TypeScript and Python disagree on ${vectorCache.total - vectorCache.agree} test vectors`, detail: 'The two Seal v6 implementations no longer produce the same bytes.', baseline: `${vectorCache.total} of ${vectorCache.total} agree`, observed: `${vectorCache.agree} agree`, createdAt: vectorCache.at, evidence: { label: 'Assurance levels', to: '/assurance/levels' }, defaultStatus: 'open' });
  }
  if (atLeast(level, 'l3')) {
    if (on('counterparty_verification')) {
      const cross = await api.crossOrgReceipts(orgId).catch(() => []);
      for (const xr of cross.filter((c) => c.verification.state === 'failed')) {
        out.push({ ...base, id: `as_cp_${xr.id}`, detector: 'counterparty_verification', severity: 'medium', title: `A receipt from ${xr.counterpartyName} did not verify`, detail: xr.verification.steps.find((s) => s.state === 'fail')?.detail ?? 'A verification step failed.', baseline: 'Received receipts verify', observed: 'Verification failed', createdAt: xr.verification.checkedAt ?? xr.issuedAt, evidence: { label: 'Counterparties', to: '/assurance/counterparties' }, defaultStatus: 'open' });
      }
    }
    if (on('autonomy_exceeded')) {
      const since = Date.now() - 24 * H;
      const byPair = new Map<string, Receipt[]>();
      for (const r of d.receipts) if (r.rule_id === 'autonomy-a0' && new Date(r.ts).getTime() >= since && r.agent && r.tool) (byPair.get(`${r.agent}|${r.tool}`) ?? byPair.set(`${r.agent}|${r.tool}`, []).get(`${r.agent}|${r.tool}`)!).push(r);
      for (const [k, rs] of byPair) {
        if (rs.length < 3) continue;
        const [agent, tool] = k.split('|');
        out.push({ ...base, agentSlug: agent, id: `as_auto_${agent}_${tool}_${new Date(rs[0].ts).toISOString().slice(0, 10)}`.replace(/\./g, '_'), detector: 'autonomy_exceeded', severity: 'medium', title: `${agent} tried to act beyond its autonomy on ${tool}`, detail: `${rs.length} writes in 24 hours were refused because ${agent} has no grant above A0 Observe for ${tool}. The guard refused each one.`, baseline: 'Writes only within the granted level', observed: `${rs.length} writes refused`, createdAt: rs[0].ts, relatedSeqs: rs.slice(-8).map((r) => r.seq), evidence: { label: 'Autonomy', to: `/agents/autonomy?agent=${agent}` }, defaultStatus: 'open' });
      }
    }
  }
  return out;
}

let assuranceCache = new Map<string, { at: number; head: number; items: DerivedAlert[] }>();

async function assuranceDerived(orgId: string) {
  const d = db.getDB(orgId);
  const head = d.receipts[d.receipts.length - 1]?.seq ?? 0;
  const hit = assuranceCache.get(orgId);
  if (hit && Date.now() - hit.at < 30_000 && hit.head === head) return hit.items;
  const items = await deriveAssurance(orgId);
  assuranceCache.set(orgId, { at: Date.now(), head, items });
  return items;
}

/** Every alert: behavioural ones from the detectors and assurance-health ones from the organisation's evidence. */
export async function alerts(orgId: string): Promise<WorkAlert[]> {
  await wait(80, 200);
  const d = db.getDB(orgId);
  const x = ext(orgId);
  const behaviour: WorkAlert[] = d.alerts.map((a) => ({ ...clone(a), family: 'behaviour' as const, deliveries: deliveriesOf(d, x, a) }));
  const derived = await assuranceDerived(orgId);
  const assurance: WorkAlert[] = derived.map(({ defaultStatus, recoveredAt, ...a }) => {
    const st = x.alertState[a.id];
    const status = st?.status ?? defaultStatus;
    return { ...a, status, acknowledgedBy: st?.acknowledgedBy, resolvedAt: st?.resolvedAt ?? (status === 'resolved' ? recoveredAt ?? a.createdAt : undefined), resolvedBy: st?.resolvedBy, deliveries: deliveriesOf(d, x, { id: a.id, severity: a.severity, createdAt: a.createdAt }), incidentId: x.healthIncidents[a.id] };
  });
  return [...assurance, ...behaviour].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function alertBundle(orgId: string, id: string) {
  const list = await alerts(orgId);
  const alert = list.find((a) => a.id === id);
  if (!alert) throw new Error('There is no alert with this id in this organisation.');
  const d = db.getDB(orgId);
  const seqs = new Set(alert.relatedSeqs);
  const related = d.receipts.filter((r) => seqs.has(r.seq));
  const trail = d.receipts.filter((r) => r.kind === 'admin' && (r.details?.alert === id || (alert.agentSlug && r.agent === alert.agentSlug && ['agent.paused', 'agent.resumed'].includes(r.action ?? '') && new Date(r.ts).getTime() >= new Date(alert.createdAt).getTime() - 60_000)));
  const agentData = alert.agentSlug ? await api.agent(orgId, alert.agentSlug).catch(() => undefined) : undefined;
  const created = new Date(alert.createdAt).getTime();
  const incidents = d.incidents as WorkIncident[];
  const incident = (alert.incidentId ? incidents.find((i) => i.id === alert.incidentId) : undefined)
    ?? (alert.agentSlug ? incidents.find((i) => i.kind === 'auto_pause' && i.agentSlugs.includes(alert.agentSlug) && Math.abs(new Date(i.startedAt).getTime() - created) < 6 * H) : undefined)
    ?? (alert.agentSlug ? incidents.find((i) => i.agentSlugs.includes(alert.agentSlug) && new Date(i.startedAt).getTime() <= created && (!i.resolvedAt || new Date(i.resolvedAt).getTime() >= created)) : undefined);
  return clone({
    alert, agent: agentData?.agent, rulebookId: agentData?.rulebook?.slug,
    aiSystem: agentData?.aiSystem ? { id: agentData.aiSystem.id, name: agentData.aiSystem.name } : undefined,
    related, trail, incident,
  });
}

export async function setAlertStatus(orgId: string, a: Pick<WorkAlert, 'id' | 'family' | 'detector' | 'agentSlug'>, status: 'acknowledged' | 'resolved', userId: string): Promise<Receipt> {
  requireRole(orgId, userId, ['owner', 'admin', 'approver'], 'Owners, admins and approvers acknowledge and resolve alerts.');
  if (a.family === 'behaviour') {
    await api.setAlertStatus(orgId, a.id, status, userId);
    const rs = db.getDB(orgId).receipts;
    return clone([...rs].reverse().find((r) => r.action === `alert.${status}` && r.details?.alert === a.id) ?? rs[rs.length - 1]);
  }
  await wait(150, 300);
  const x = ext(orgId);
  const cur = x.alertState[a.id] ?? { status: 'open' as const };
  if (status === 'acknowledged') Object.assign(cur, { status, acknowledgedBy: userId });
  else Object.assign(cur, { status, resolvedAt: iso(Date.now()), resolvedBy: userId });
  x.alertState[a.id] = cur;
  assuranceCache.delete(orgId);
  return db.logAdmin(orgId, userId, `alert.${status}`, { alert: a.id, detector: a.detector, family: 'assurance' }, a.agentSlug || undefined);
}

/* ══ Incidents: health incidents, resolution, report receipts ══ */

export const HEALTH_META: Record<HealthKind, { label: string; level: 'l1' | 'l2' | 'l3' | 'sovereign'; checks: { id: string; label: string; detail: string; to?: string }[] }> = {
  receipt_write: { label: 'Receipt write failure', level: 'l1', checks: [
    { id: 'writes', label: 'Receipts are being written again', detail: 'The newest receipt is recent and the chain head moves.', to: '/activity' },
    { id: 'gap', label: 'No gap in the chain', detail: 'Every receipt links to the one before it.', to: '/activity/chain' },
    { id: 'calls', label: 'Calls during the failure were refused', detail: 'The guard refuses when it cannot record; nothing ran unrecorded. The recovery receipt counts the refused calls, listed on this incident.', to: '/activity' },
  ] },
  tsa_outage: { label: 'Timestamp authority outage', level: 'l2', checks: [
    { id: 'both', label: 'Both authorities answer again', detail: 'eMudhra and the global authority (or your two local TSAs) issue tokens.', to: '/assurance/anchors' },
    { id: 'late', label: 'Late batches were timestamped', detail: 'Every batch in the window now has two tokens, marked late.', to: '/assurance/anchors' },
    { id: 'chain', label: 'No record was lost', detail: 'The chain verifies across the window.', to: '/activity/chain' },
  ] },
  kms_failure: { label: 'Signing key unavailable', level: 'l2', checks: [
    { id: 'sign', label: 'Signing works again', detail: 'The newest receipt is signed with the key in custody.', to: '/agents/keys' },
    { id: 'refused', label: 'Calls during the outage were refused', detail: 'Without a signature nothing is decided; the guard refuses.', to: '/work/not-done' },
    { id: 'trail', label: 'Key use trail checked', detail: 'CloudTrail or the HSM audit log shows no other use of the key.' },
  ] },
  worm_failure: { label: 'Write-once storage failure', level: 'l2', checks: [
    { id: 'mode', label: 'Object lock back in compliance mode', detail: 'Retention cannot be shortened by any user.', to: '/agents/deployment' },
    { id: 'copies', label: 'Receipts from the window are stored', detail: 'Every receipt written during the failure is in the bucket.' },
    { id: 'verify', label: 'An export of the window verifies', detail: 'Export the range and run the verifier.', to: '/assurance/exports' },
  ] },
  chain_break: { label: 'Chain integrity break', level: 'l1', checks: [
    { id: 'locate', label: 'The break is located', detail: 'The first failing receipt and the field that differs are known.', to: '/activity/chain' },
    { id: 'preserve', label: 'Evidence preserved', detail: 'An export of the range around the break is kept with this incident.', to: '/assurance/exports' },
    { id: 'notify', label: 'Auditor told', detail: 'The break is reported to your auditor with the incident report.' },
  ] },
  update_signature: { label: 'Update bundle failed its signature', level: 'sovereign', checks: [
    { id: 'not_applied', label: 'The bundle was not applied', detail: 'It shows as rejected in Agents › Deployment; nothing from it is installed.', to: '/agents/deployment' },
    { id: 'quarantine', label: 'The media is quarantined', detail: 'The removable media is sealed and kept for inspection, not reused.' },
    { id: 'report', label: 'Reported to elan1 out of band', detail: 'Called the elan1 security line on the number in your contract, not one from the media.' },
  ] },
  node_down: { label: 'Cluster node not ready', level: 'sovereign', checks: [
    { id: 'ready', label: 'The node is ready again', detail: 'Every node reports ready in Agents › Deployment.', to: '/agents/deployment' },
    { id: 'replicas', label: 'Replicas back to strength', detail: 'Every component runs its full replica count.' },
    { id: 'chain', label: 'The chain verifies across the window', detail: 'No receipt was lost while the node was down.', to: '/activity/chain' },
  ] },
  counterparty_dispute: { label: 'Counterparty verification dispute', level: 'l3', checks: [
    { id: 'reverify', label: 'Re-verified the receipt', detail: 'Ran the verification again with the counterparty’s current key.', to: '/assurance/counterparties' },
    { id: 'key', label: 'Key confirmed out of band', detail: 'The counterparty confirmed its key fingerprint by phone.' },
    { id: 'record', label: 'Outcome recorded with the counterparty', detail: 'Both sides hold the same result.' },
  ] },
  autonomy_breach: { label: 'Agent acted beyond its autonomy', level: 'l3', checks: [
    { id: 'grant', label: 'Grant reviewed', detail: 'The agent’s grant for the tool is right, or has been changed by a person.', to: '/agents/autonomy' },
    { id: 'refused', label: 'Every attempt was refused', detail: 'The receipts show each write was refused.', to: '/work/not-done?class=autonomy' },
    { id: 'owner', label: 'Agent owner told', detail: 'The owner knows the agent tried to act beyond its grant.' },
  ] },
  // security incidents, declared by hand; key compromise and isolation breach start the CERT-In six-hour clock
  key_compromise: { label: 'Key compromise', level: 'l1', checks: [
    { id: 'revoke', label: 'The exposed key is revoked or rotated', detail: 'An agent key is revoked and reissued; a signing key is rotated in a ceremony.', to: '/agents/keys' },
    { id: 'use', label: 'Every use of the key since exposure is read', detail: 'The receipts made with the key since it was exposed are listed; anything unexpected is in the note.', to: '/activity' },
    { id: 'source', label: 'The leak is closed', detail: 'The log, repository or machine that exposed the key is cleaned and access to it reviewed.' },
  ] },
  isolation_breach: { label: 'Isolation breach', level: 'l1', checks: [
    { id: 'contain', label: 'The path across the boundary is closed', detail: 'The tenant, network or cluster boundary holds again and is tested.' },
    { id: 'scope', label: 'What crossed the boundary is known', detail: 'The receipts show which records were read or written across it.', to: '/activity' },
    { id: 'egress', label: 'Egress and access logs reviewed', detail: 'Nothing else left the boundary in the window.', to: '/agents/deployment' },
  ] },
  security_other: { label: 'Security incident', level: 'l1', checks: [
    { id: 'contain', label: 'Contained', detail: 'What caused it can no longer act; affected agents are paused or fixed.', to: '/agents' },
    { id: 'scope', label: 'Scope known', detail: 'The receipts in the window are read and what happened is written down.', to: '/activity' },
    { id: 'told', label: 'The right people told', detail: 'Owners, the data protection officer and, where needed, customers.' },
  ] },
};

/** Security incidents: declared by hand, with their own label. */
export const SECURITY_KINDS: HealthKind[] = ['key_compromise', 'isolation_breach', 'security_other'];

/** Open a health incident for open high-severity assurance alerts (once per alert); recovered outages are kept as resolved history. */
async function ensureHealthIncidents(orgId: string) {
  const d = db.getDB(orgId);
  const x = ext(orgId);
  const list = (await alerts(orgId)).filter((a) => a.family === 'assurance');
  let changed = false;
  for (const a of list) {
    const kind = HEALTH_FOR[a.detector as AssuranceDetector];
    if (kind && x.healthIncidents[a.id]) {
      // a recovered outage keeps the recovery time the evidence records
      const old = (d.incidents as WorkIncident[]).find((i) => i.id === x.healthIncidents[a.id]);
      if (old && old.resolvedBy === 'system' && a.resolvedAt && old.resolvedAt !== a.resolvedAt) { old.resolvedAt = a.resolvedAt; changed = true; }
      continue;
    }
    if (!kind) continue;
    const historic = a.status === 'resolved';
    if (!historic && a.severity !== 'high') continue;
    const id = `inc_h_${a.id}`.slice(0, 60);
    const inc: WorkIncident = {
      id, title: a.title, kind: 'health', status: historic ? 'resolved' : 'active', scope: 'all_agents', agentSlugs: [], subkind: kind, alertId: a.id,
      startedAt: a.createdAt, startedBy: 'system', reason: a.detail, refusedWhileStopped: 0, pendingApprovalsAtStop: 0,
      timeline: [{ ts: a.createdAt, text: `${HEALTH_META[kind].label}: ${a.title}`, actor: 'system' }],
    };
    if (historic) {
      inc.resolvedAt = a.resolvedAt ?? a.createdAt;
      inc.resolvedBy = 'system';
      inc.timeline.push({ ts: inc.resolvedAt, text: 'Recovered. ' + a.detail, actor: 'system' });
    } else if (kind === 'receipt_write' && receiptWriterDown(orgId)) {
      // the writer is failed: the incident opens, but its receipt is written when receipts are written again (src/mock/ops.ts)
      inc.timeline.push({ ts: iso(Date.now()), text: 'Health incident opened; owners and admins notified. Its incident.opened receipt waits until the receipt writer is back.', actor: 'system' });
    } else {
      const r = db.append(d, { kind: 'admin', actor: 'system', action: 'incident.opened', details: { incident: id, kind: 'health', subkind: kind, alert: a.id } });
      inc.timeline.push({ ts: r.ts, text: 'Health incident opened; owners and admins notified', seq: r.seq, actor: 'system' });
    }
    d.incidents.unshift(inc);
    x.healthIncidents[a.id] = id;
    changed = true;
  }
  if (changed) db.touch(orgId, 'incident');
}

/** Run every check now (detectors and assurance health). Returns the alerts afterwards. */
export async function runChecks(orgId: string) {
  assuranceCache.delete(orgId);
  vectorCache = undefined;
  probeReceiptWrites(orgId);
  scanBehaviour(db.getDB(orgId));
  await ensureHealthIncidents(orgId);
  return alerts(orgId);
}

/**
 * Demo drill (owners and admins): a burst of calls the published rulebook refuses, sent through the real guard from
 * the agent with the most rule refusals, then the detectors run. The refusal-surge detector raises its alert exactly as
 * it would in production (plan journey 4, "Something goes wrong"). Every call is a real, recorded refusal; nothing runs.
 */
export async function simulateRefusalSurge(orgId: string, userId: string): Promise<{ agent: string; calls: number; alertId?: string }> {
  await wait(300, 600);
  const role = db.memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins run the refusal-surge drill.');
  const d = db.getDB(orgId);
  if (d.stop?.active) throw new Error('An emergency stop is engaged: every call is refused as "agent paused", which the detector ignores. Lift the stop first.');
  const x = ext(orgId);
  const SYSTEM = /^(agent-paused|no-rulebook|rulebook-invalid|gate-error|default|tool-disabled|invalid-arguments|autonomy-|G1_|pack-|POLICY\.|RECEIPT_)/;
  const now = Date.now();
  const busyAgents = new Set(d.alerts.filter((a) => a.detector === 'refusal_surge' && a.status !== 'resolved' && now - new Date(a.createdAt).getTime() < 24 * H).map((a) => a.agentSlug));
  const candidates = d.agents
    .filter((a) => a.status === 'active' && now - new Date(a.createdAt).getTime() >= 7 * D && !busyAgents.has(a.slug) && now - (x.lastAlertAt[`refusal_surge|${a.slug}`] ?? 0) >= 6 * H)
    .map((a) => {
      const refused = d.receipts.filter((r) => r.kind === 'decision' && r.agent === a.slug && r.decision === 'refuse' && r.tool && !SYSTEM.test(r.rule_id ?? ''));
      return { agent: a, sample: refused[refused.length - 1], count: refused.length };
    })
    .filter((c) => c.sample)
    .sort((a, b) => b.count - a.count);
  if (!candidates.length) throw new Error('No active agent has a rule refusal to repeat, or every such agent already has a recent refusal-surge alert. Resolve it, then try again.');
  const { agent, sample } = candidates[0];
  const call = {
    tool: sample!.tool!, args: (sample!.args_summary ?? {}) as Record<string, string | number | boolean>, decision: 'refuse' as const,
    ruleId: sample!.rule_id ?? '', reason: sample!.reason ?? '', tags: [], connector: sample!.tool!.split('.')[0],
  };
  db.logAdmin(orgId, userId, 'drill.refusal_surge', { agent: agent.slug, tool: call.tool, rule: call.ruleId, calls: 14 });
  let refused = 0;
  for (let i = 0; i < 14; i++) {
    const r = db.governCall(d, agent, call) as Receipt | undefined;
    if (r?.decision === 'refuse') refused++;
  }
  scanBehaviour(d);
  const alert = d.alerts.find((a) => a.detector === 'refusal_surge' && a.agentSlug === agent.slug && a.status === 'open' && now - new Date(a.createdAt).getTime() < 5 * 60_000);
  db.touch(orgId, 'alert');
  return { agent: agent.slug, calls: refused, alertId: alert?.id };
}

export async function incidents(orgId: string): Promise<WorkIncident[]> {
  await wait(60, 160);
  ensureOps(orgId);
  return clone(db.getDB(orgId).incidents as WorkIncident[]);
}

export async function incidentBundle(orgId: string, id: string) {
  await wait(60, 160);
  const d = db.getDB(orgId);
  const incident = (d.incidents as WorkIncident[]).find((i) => i.id === id);
  if (!incident) throw new Error('There is no incident with this id in this organisation.');
  return clone({ incident, stop: { ...d.stop }, orgName: d.org.name, keyFingerprint: d.org.keyFingerprint, level: levelOf(orgId) });
}

export async function stopState(orgId: string) {
  await wait(30, 80);
  return clone(db.getDB(orgId).stop);
}

/** Resolve an incident that has no stop or pause to lift (health incidents): the guided checks, a note, an incident.resolved receipt. */
export async function resolveIncident(orgId: string, id: string, note: string, checks: string[], userId: string) {
  await wait(300, 600);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins resolve incidents.');
  const d = db.getDB(orgId);
  const inc = (d.incidents as WorkIncident[]).find((i) => i.id === id);
  if (!inc) throw new Error('No such incident.');
  if (inc.status !== 'active') throw new Error('This incident is already resolved.');
  if (inc.kind === 'emergency_stop') throw new Error('An emergency stop is resolved by lifting the stop.');
  if (note.trim().length < 8) throw new Error('Write what was found and what changed — at least a sentence.');
  const meta = inc.subkind ? HEALTH_META[inc.subkind] : undefined;
  if (meta && meta.checks.some((c) => !checks.includes(c.id))) throw new Error('Work through every check before resolving.');
  const certIn = certInBlocker(orgId, id);
  if (certIn) throw new Error(certIn);
  const down = inc.subkind === 'receipt_write' ? receiptWriterDown(orgId) : undefined;
  if (down) throw new Error(`Receipts are not being written yet${down.endedAt && down.source === 'drill' ? `: the drill ends at ${istTime(down.endedAt)} IST` : ''}. Resolve the incident once the writer is back and its recovery receipt is on the chain.`);
  const r = db.logAdmin(orgId, userId, 'incident.resolved', { incident: id, kind: inc.kind, ...(inc.subkind ? { subkind: inc.subkind } : {}), checks: checks.length, note: note.trim() });
  inc.status = 'resolved';
  inc.resolvedAt = r.ts;
  inc.resolvedBy = userId;
  inc.checksDone = checks;
  inc.resolutionNote = note.trim();
  inc.timeline.push({ ts: r.ts, text: `Resolved: ${note.trim()}`, seq: r.seq, actor: userId });
  if (inc.alertId) {
    const x = ext(orgId);
    x.alertState[inc.alertId] = { ...(x.alertState[inc.alertId] ?? {}), status: 'resolved', resolvedAt: r.ts, resolvedBy: userId };
    assuranceCache.delete(orgId);
  }
  db.touch(orgId, 'incident');
  return clone(inc);
}

export async function logIncidentReport(orgId: string, id: string, userId: string, receipts: number) {
  await wait(60, 120);
  return db.logAdmin(orgId, userId, 'incident.report_generated', { incident: id, receipts });
}

/* ══ Today: queues beyond tool-call approvals ════════════════ */

export async function workQueues(orgId: string, userId?: string) {
  await wait(60, 140);
  const d = db.getDB(orgId);
  const level = levelOf(orgId);
  const start = (() => { const t = new Date(Date.now() + 5.5 * H); t.setUTCHours(0, 0, 0, 0); return t.getTime() - 5.5 * H; })();
  const todays = d.receipts.filter((r) => new Date(r.ts).getTime() >= start);
  const reviews = userId ? await api.reviewsQueue(orgId, userId).catch(() => []) : [];
  const second = secondApprovals(orgId, userId);
  const cross = atLeast(level, 'l3') ? await api.crossOrgReceipts(orgId).catch(() => []) : [];
  const custody = atLeast(level, 'l3') ? await api.custody(orgId).catch(() => undefined) : undefined;
  const due = custody?.rotation.nextDueAt;
  const ceremonyDue = !!due && new Date(due).getTime() - Date.now() < 30 * D;
  const assurance = (await alerts(orgId).catch(() => [] as WorkAlert[])).filter((a) => a.family === 'assurance' && a.status !== 'resolved');
  // stop lifts, emergency access and approver samples waiting for a second person; supervised calls sampled 1 in 10 (L3+)
  const ops = opsWorkItems(orgId, userId);
  const supervision = atLeast(level, 'l3') ? await api.supervision(orgId).catch(() => []) : [];
  const role = userId ? db.memberRole(orgId, userId) : undefined;
  const canReviewSamples = role === 'owner' || role === 'admin' || role === 'approver';
  const supervisedSamples = supervision.filter((s) => s.active).flatMap((s) => s.sampled.filter((c) => !c.review).map((c) => ({
    id: `sup_${s.grant.id}_${c.seq}`, grantId: s.grant.id, seq: c.seq, ts: c.ts, agentSlug: s.grant.agentSlug, tool: s.grant.tool, decision: c.decision, ruleId: c.ruleId, summary: c.summary, endsAt: s.endsAt, canAct: canReviewSamples,
  })));
  return clone({
    touchedToday: { total: todays.length, decisions: todays.filter((r) => r.kind === 'decision').length },
    reviews,
    reviewsForMe: reviews.filter((r) => r.canAct),
    secondApprovals: second,
    counterpartyToVerify: cross.filter((x) => x.direction === 'received' && x.verification.state === 'pending'),
    keyCeremony: ceremonyDue ? { dueAt: due!, provider: custody!.provider } : undefined,
    assuranceAlerts: assurance,
    opsItems: ops,
    opsForMe: ops.filter((o) => o.canAct),
    supervisedSamples,
  });
}

/* ══ Engine: escalation by rule, live detectors, health incidents ══ */

const timers = new Map<string, number>();
let lastHealth = new Map<string, number>();
let busy = false;

function schedule(orgId: string) {
  window.clearTimeout(timers.get(orgId));
  timers.set(orgId, window.setTimeout(async () => {
    if (busy) return;
    busy = true;
    try {
      const d = db.getDB(orgId);
      runRuleEscalations(d);
      scanBehaviour(d);
      if (Date.now() - (lastHealth.get(orgId) ?? 0) > 60_000) {
        lastHealth.set(orgId, Date.now());
        await ensureHealthIncidents(orgId);
      }
    } catch { /* the engine never breaks the console */ } finally {
      busy = false;
    }
  }, 1200));
}

let started = false;
/** Start the Work door's engine (once). Runs after records change; idempotent. */
export function startWorkEngine() {
  if (started || typeof window === 'undefined') return;
  started = true;
  db.subscribe((orgId, kind) => {
    if (kind === 'receipt' || kind === 'approval' || kind === 'level') schedule(orgId);
  });
}
startWorkEngine();

/** Reset caches (used after an upgrade so level-specific checks re-run). */
export function resetCaches() {
  assuranceCache = new Map();
  lastHealth = new Map();
  vectorCache = undefined;
}
