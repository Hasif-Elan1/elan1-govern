import type { Approval, Condition, Receipt, Rule } from '@/types';
import { api, db } from '@/api';
import { canonical, sha256Hex } from '@/lib/crypto';
import { atLeast } from '@/lib/levels';
import { userName } from '@/mock/users';
import { blastRadius, recordRuleDraft, reversalPlan, stepUpReason } from '@/mock/approvalsExt';
import { firstApprovalOf, namedLists, needsTwo, orgTools, twoPersonPolicy, twoPersonReason } from '@/features/work/backend';
import { needsCallBack } from './lib';
import { g1ForCall } from '@/mock/records';
import { MIN_RETENTION_YEARS } from '@/features/settings/orgApi';
import { draftOf, nextVersionNo, publishedOf, registerOrg } from '@/features/rulebooks/lib';
import { buildYaml, parseRulebookYaml, NO_EXTRAS } from '@/features/rulebooks/yamlSync';

/**
 * The decide screen's derived content: what the call would change (field by field, before → after), every check
 * that ran before the rule with its version, and the digest of exactly what the approver is shown. All of it is a
 * pure function of the approval and the organisation's record, so the same screen gives the same digest.
 */

const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
const H = 3_600_000;

function hashInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ── Field-by-field diff ──────────────────────────────────── */

export interface DiffField { key: string; label: string; before: string; after: string; changed: boolean }
export interface RecordDiff { record: string; exists: boolean; readOnly: boolean; fields: DiffField[] }

const f = (key: string, label: string, before: string, after: string): DiffField => ({ key, label, before, after, changed: before !== after });
const same = (key: string, label: string, v: string): DiffField => f(key, label, v, v);
const NONE = '—';
const str = (v: unknown) => (v === undefined || v === null || v === '' ? NONE : String(v));

/** What the call would change against the current state of the record it touches. */
export function recordDiff(a: Approval): RecordDiff {
  const args = a.args ?? {};
  const h = hashInt(a.id);
  const t = a.tool;
  if (t.endsWith('record_payment')) {
    const amount = Number(args.amount ?? a.amount ?? 0);
    const due = new Date(new Date(a.createdAt).getTime() + ((h % 12) + 2) * 24 * H).toISOString().slice(0, 10);
    return {
      record: `Bill ${str(args.bill)} in ${a.connector}`, exists: true, readOnly: false,
      fields: [
        same('vendor', 'Vendor', str(args.vendor ?? a.counterparty)),
        same('bill', 'Bill', str(args.bill)),
        same('bill_total', 'Bill total', inr(amount)),
        f('status', 'Status', 'Open', 'Paid'),
        f('amount_paid', 'Amount paid', inr(0), inr(amount)),
        f('balance', 'Balance due', inr(amount), inr(0)),
        f('payment_mode', 'Payment mode', NONE, str(args.mode)),
        f('bank_file', 'Bank file', NONE, '16:00 IST batch'),
        same('due_date', 'Due date', due),
        same('currency', 'Currency', 'INR'),
      ],
    };
  }
  if (t.includes('update_bank_details')) {
    const oldIfsc = `ICIC000${1000 + (h % 8999)}`;
    const oldLast4 = String(1000 + ((h >> 7) % 8999));
    return {
      record: `Vendor ${str(args.vendor ?? a.counterparty)} in the procurement master`, exists: true, readOnly: false,
      fields: [
        same('vendor', 'Vendor', str(args.vendor ?? a.counterparty)),
        f('ifsc', 'IFSC', oldIfsc, str(args.ifsc)),
        f('account_last4', 'Account (last 4)', oldLast4, str(args.account_last4)),
        f('bank_verified', 'Bank account confirmed', 'Yes, by call-back', 'No, needs a call-back'),
        same('gstin', 'GSTIN', `29AAB${String(h % 99999).padStart(5, '0')}Z${h % 9}`),
        same('payment_terms', 'Payment terms', 'Net 30'),
        same('status', 'Status', 'Active'),
      ],
    };
  }
  if (t.includes('create_vendor')) {
    return {
      record: 'New vendor in the procurement master', exists: false, readOnly: false,
      fields: [
        f('name', 'Name', NONE, str(args.name ?? a.counterparty)),
        f('gstin_verified', 'GSTIN verified', NONE, String(args.gstin_verified) === 'true' ? 'Yes' : 'No'),
        f('country', 'Country', NONE, str(args.country)),
        f('status', 'Status', 'Does not exist', 'Active'),
        f('payment_terms', 'Payment terms', NONE, 'Net 30'),
      ],
    };
  }
  if (t.includes('send_email')) {
    const fields: DiffField[] = [
      f('to', 'To', NONE, str(args.to)),
      ...(args.subject !== undefined ? [f('subject', 'Subject', NONE, str(args.subject))] : []),
      ...(args.template !== undefined ? [f('template', 'Template', NONE, str(args.template))] : []),
      ...(args.invoice !== undefined ? [same('invoice', 'Invoice', str(args.invoice))] : []),
      ...(args.amount_due !== undefined ? [same('amount_due', 'Amount due', inr(Number(args.amount_due)))] : []),
      ...(args.days_overdue !== undefined ? [same('days_overdue', 'Days overdue', str(args.days_overdue))] : []),
      f('status', 'Status', 'Not sent', 'Sent'),
      same('from', 'From', 'The agent’s mailbox'),
      same('attachments', 'Attachments', str(args.attachments ?? 0)),
    ];
    return { record: `Outgoing email to ${str(args.to)}`, exists: false, readOnly: false, fields };
  }
  if (t.includes('deploy')) {
    const cur = String(args.version ?? 'v1.0.0').replace(/^v(\d+)\.(\d+)\.(\d+)$/, (_m, x, y, z) => (Number(z) > 0 ? `v${x}.${y}.${Number(z) - 1}` : Number(y) > 0 ? `v${x}.${Number(y) - 1}.4` : `v${x}.0.0-rc`));
    return {
      record: `Service ${str(args.service)} (${str(args.environment)})`, exists: true, readOnly: false,
      fields: [
        same('service', 'Service', str(args.service)),
        same('environment', 'Environment', str(args.environment)),
        f('version', 'Running version', cur, str(args.version)),
        f('status', 'Status', 'Running', 'Rolling out, then running'),
        same('replicas', 'Replicas', String(3 + (h % 4))),
        same('rollback', 'Rollback', `One command, to ${cur}`),
      ],
    };
  }
  if (t.includes('initiate_transfer')) {
    const amount = Number(args.amount ?? a.amount ?? 0);
    const bal = (Math.ceil(amount / 1_000_000) + 2 + (h % 5)) * 1_000_000;
    return {
      record: `Account ${str(args.from_account)}`, exists: true, readOnly: false,
      fields: [
        same('from_account', 'From account', str(args.from_account)),
        f('balance', 'Available balance', inr(bal), inr(bal - amount)),
        f('outgoing', 'Outgoing transfer', NONE, `${inr(amount)} to ${str(args.to_account)}`),
        same('to_account', 'To account', str(args.to_account)),
        same('own_account', 'One of your own accounts', String(args.to_account ?? '').startsWith('EXT') ? 'No' : 'Yes'),
      ],
    };
  }
  const plan = reversalPlan(a);
  if (plan.readOnly) {
    return {
      record: 'Read only — nothing is changed', exists: true, readOnly: true,
      fields: Object.entries(args).map(([k, v]) => same(k, k.replace(/_/g, ' '), str(v))),
    };
  }
  return {
    record: `Record in ${a.connector}`, exists: true, readOnly: false,
    fields: [
      ...Object.entries(args).map(([k, v]) => f(k, k.replace(/_/g, ' '), NONE, typeof v === 'number' && k.includes('amount') ? inr(v) : str(v))),
      same('connector', 'System', a.connector),
    ],
  };
}

/* ── Checks before the rule (G1–G9) and the rule ──────────── */

export type CheckResult = 'passed' | 'not_applicable' | 'off' | 'person';
export interface CheckRow { id: string; name: string; result: CheckResult; detail: string; version: string; skippable: boolean }

const DECL_VERSION: Record<string, number> = { G1: 3, G2: 2, G3: 4, G4: 2, G5: 1, G6: 2, G7: 3, G8: 1, G9: 5 };
const SKIPPABLE = new Set(['G5', 'G6', 'G8']);

export const CHECK_RESULT_LABEL: Record<CheckResult, string> = { passed: 'Passed', not_applicable: 'Not needed', off: 'Declared off', person: 'For a person' };

/** Index of the hold receipt in the chain (sequence numbers are contiguous), or -1. */
function holdIndex(orgId: string, a: Approval): number {
  const rs = db.getDB(orgId).receipts;
  if (!rs.length) return -1;
  const guess = a.seq - rs[0].seq;
  if (rs[guess]?.seq === a.seq) return guess;
  return rs.findIndex((r) => r.seq === a.seq);
}

function holdReceipt(orgId: string, a: Approval): Receipt | undefined {
  const i = holdIndex(orgId, a);
  return i >= 0 ? db.getDB(orgId).receipts[i] : undefined;
}

function onApprovedList(orgId: string, cp: string): boolean {
  const lists = namedLists(orgId);
  const vendors = (lists.approved_vendors ?? []).map((v) => v.toLowerCase());
  const key = cp.toLowerCase().replace(/[^a-z0-9]/g, '');
  const first = cp.toLowerCase().split(/[\s.@-]/)[0];
  return vendors.some((v) => key.includes(v.replace(/[^a-z0-9]/g, '')) || v === first);
}

/** The retention policy in force when the call was held: the last retention.changed before the hold, else the default (8 years). */
function retentionYearsAt(orgId: string, a: Approval): number {
  const rs = db.getDB(orgId).receipts;
  const heldAt = a.createdAt;
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if (r.ts > heldAt || r.action !== 'retention.changed') continue;
    const y = Number(r.details?.years);
    if (Number.isFinite(y)) return Math.max(MIN_RETENTION_YEARS, y);
  }
  return MIN_RETENTION_YEARS;
}

/**
 * G1, the consent check, as the live check runs it (mock/records.ts g1ForCall): the hold receipt's own G1 result when
 * the guard recorded one, otherwise the consent ledger as it stood at the hold. A call that writes to no person, or an
 * organisation with no ledger yet, is not checked.
 */
function consentRow(orgId: string, a: Approval, row: (id: string, name: string, result: CheckResult, detail: string) => CheckRow): CheckRow {
  const hold = holdReceipt(orgId, a);
  const v = g1ForCall(orgId, { tool: a.tool, args: a.args ?? {}, tags: a.riskTags ?? [] }, new Date(a.createdAt).getTime());
  const code = typeof hold?.details?.g1 === 'string' ? hold.details.g1 : v?.code;
  if (!code) return row('G1', 'Consent', 'not_applicable', (a.riskTags ?? []).includes('personal_data') ? 'This call writes to no person directly, so no consent is checked; the personal data in it follows the rule.' : 'This call writes to no person, so no consent is checked.');
  const consent = typeof hold?.details?.consent === 'string' ? hold.details.consent : v?.consentId;
  if (code === 'G1_PASS' || code === 'G1_LEGITIMATE_USE') return row('G1', 'Consent', 'passed', v?.result === 'passed' ? v.detail : consent ? `Consent ${consent} on the consent ledger covers this call.` : 'The consent ledger covers this call.');
  // the guard refuses a call G1 does not cover before any hold, so this is a call held before the ledger covered it
  return row('G1', 'Consent', 'person', `${code}: at the hold the consent ledger did not cover this person on this channel${consent ? ` (consent ${consent})` : ''}. Check the ledger before approving.`);
}

/** Every check's result for this held call, in declared order, then the rule that asked a person. */
export function checkResults(orgId: string, a: Approval): CheckRow[] {
  const d = db.getDB(orgId);
  const level = api.levelOf(orgId);
  const tags = a.riskTags ?? [];
  const args = a.args ?? {};
  const row = (id: string, name: string, result: CheckResult, detail: string): CheckRow => ({ id, name, result, detail, version: `v${DECL_VERSION[id]}`, skippable: SKIPPABLE.has(id) });
  const out: CheckRow[] = [];

  out.push(consentRow(orgId, a, row));

  out.push(row('G2', 'Residency', 'passed', level === 'sovereign' ? 'Processed and stored on your own cluster in Mumbai.' : 'Processed and stored in India (ap-south-1).'));

  // the organisation's retention policy in force at the hold (never shorter than 8 years)
  const years = retentionYearsAt(orgId, a);
  out.push(row('G3', 'Retention', 'passed', tags.includes('moves_money') || tags.includes('writes_data')
    ? `Kept ${years} years under your retention policy, at least the 8 years the Companies Act audit trail needs; erasure by salt destruction.`
    : `Kept ${years} years under your retention policy (never shorter than 8 years).`));

  const two = twoPersonReason(orgId, a);
  const br = blastRadius(a);
  out.push(two === 'amount'
    ? row('G4', 'Dual control', 'person', `${inr(a.amount ?? 0)} is at or above the ${inr(twoPersonPolicy(orgId).above)} two-person limit: two different people approve.`)
    : two === 'scope'
      ? row('G4', 'Dual control', 'person', `The blast radius is “${br.label.toLowerCase()}”: two different people approve.`)
      : row('G4', 'Dual control', 'passed', 'One approver is enough for this amount and scope.'));

  const since = new Date(a.createdAt).getTime() - H;
  let calls = 0;
  const hi = holdIndex(orgId, a);
  for (let i = hi - 1; i >= 0 && i > hi - 2000; i--) {
    const r = d.receipts[i];
    if (new Date(r.ts).getTime() < since) break;
    if (r.kind === 'decision' && r.agent === a.agentSlug) calls++;
  }
  calls += 1; // the held call itself
  out.push(row('G5', 'Rate', 'passed', `${calls} of 120 calls by ${a.agentSlug} in the hour up to and including this one.`));

  if (a.amount !== undefined) {
    const monthStart = new Date(a.createdAt);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    // as the check ran at the hold: approvals decided this month before it (so the sentence does not change after a decision)
    const heldAt = new Date(a.createdAt).getTime();
    const spent = d.approvals.filter((x) => x.id !== a.id && x.agentSlug === a.agentSlug && x.status === 'approved' && x.amount !== undefined && x.decidedAt && new Date(x.decidedAt).getTime() >= monthStart.getTime() && new Date(x.decidedAt).getTime() < heldAt).reduce((s, x) => s + (x.amount ?? 0), 0);
    const budget = Math.max(5_000_000, Math.ceil((spent + a.amount) / 5_000_000) * 5_000_000);
    out.push(row('G6', 'Budget', 'passed', `${inr(spent)} of the ${inr(budget)} monthly budget used; ${inr(spent + a.amount)} after this call.`));
  } else {
    out.push(row('G6', 'Budget', 'off', 'Declared off for this tool: no money moves.'));
  }

  if (a.counterparty) {
    const ok = onApprovedList(orgId, a.counterparty);
    const reg = atLeast(level, 'l3') ? ' and the counterparty register' : '';
    out.push(ok
      ? row('G7', 'Counterparty', 'passed', `${a.counterparty} is on the approved vendor list${reg}.`)
      : row('G7', 'Counterparty', 'person', `${a.counterparty} is not on the approved vendor list${reg ? ' or verified in the counterparty register' : ''}.`));
  } else {
    out.push(row('G7', 'Counterparty', 'not_applicable', 'No outside party in this call.'));
  }

  const istHour = new Date(new Date(a.createdAt).getTime() + 5.5 * H).getUTCHours();
  if (tags.includes('changes_production')) out.push(row('G8', 'Schedule', 'person', 'Outside the change window (Tuesday and Thursday, 14:00–17:00 IST).'));
  else if (tags.includes('moves_money')) out.push(row('G8', 'Schedule', 'passed', istHour < 16 ? 'Before the 16:00 IST bank-file cut-off.' : 'After the 16:00 IST cut-off: it goes in the next morning’s bank file.'));
  else out.push(row('G8', 'Schedule', 'off', 'Declared off for this tool.'));

  const t = a.tool;
  if (t.endsWith('record_payment')) out.push(row('G9', 'Precondition', 'passed', `${str(args.bill)} is open with ${inr(Number(args.amount ?? a.amount ?? 0))} due; the payment does not exceed it.`));
  else if (t.includes('update_bank_details')) out.push(row('G9', 'Precondition', 'person', 'No call-back to a contact already on file is recorded for this change.'));
  else if (t.includes('create_vendor')) out.push(String(args.gstin_verified) === 'true' ? row('G9', 'Precondition', 'passed', 'GSTIN verified.') : row('G9', 'Precondition', 'person', 'The GSTIN is not verified.'));
  else if (t.includes('send_email') && args.days_overdue !== undefined) out.push(row('G9', 'Precondition', 'passed', `${str(args.invoice)} is ${str(args.days_overdue)} days overdue (45 or more needed for a final notice).`));
  else if (t.includes('deploy')) out.push(row('G9', 'Precondition', 'passed', `${str(args.version)} is built and its checks pass.`));
  else if (t.includes('initiate_transfer')) out.push(row('G9', 'Precondition', 'passed', `${str(args.from_account)} holds enough for ${inr(Number(args.amount ?? 0))}.`));
  else out.push(row('G9', 'Precondition', 'passed', 'The arguments match the tool’s declared schema.'));

  const hold = holdReceipt(orgId, a);
  out.push({ id: 'rule', name: `Rule ${a.ruleId}`, result: 'person', detail: a.ruleReason, version: hold?.rulebook ? `rulebook v${hold.rulebook.version}` : 'rulebook', skippable: false });
  return out;
}

export function checkSummary(rows: CheckRow[]) {
  const pre = rows.filter((r) => r.id !== 'rule');
  const run = pre.filter((r) => r.result !== 'off');
  const passed = run.filter((r) => r.result === 'passed' || r.result === 'not_applicable').length;
  const person = run.filter((r) => r.result === 'person').length;
  const off = pre.length - run.length;
  return { run: run.length, passed, person, off, text: `${passed} of ${run.length} checks passed${person ? ` · ${person} for a person` : ''}` };
}

/* ── Payload digest ───────────────────────────────────────── */

/**
 * Which screen the approver decided on. The console decide screen and the single-use link page show the same
 * content (headline, amount, why it was held, what changes, every check with its sentence and version, blast
 * radius with its reason, the reversal plan, what happens on approval); the console also shows the raw arguments.
 */
export type PayloadView = 'console' | 'link';

/**
 * Exactly what the decide screen shows, in canonical form: every line the approver reads, not only the ids.
 * Version 2. The view is part of the payload, so a link decision's digest describes the link page.
 */
export function shownPayload(orgId: string, a: Approval, view: PayloadView = 'console') {
  const diff = recordDiff(a);
  const checks = checkResults(orgId, a);
  const br = blastRadius(a);
  const plan = reversalPlan(a);
  const agent = db.getDB(orgId).agents.find((x) => x.slug === a.agentSlug);
  const hold = holdReceipt(orgId, a);
  const two = twoPersonReason(orgId, a) ?? null;
  return {
    v: 2, view,
    approval: a.id, hold_seq: a.seq, headline: a.headline, agent: a.agentSlug, tool: a.tool, connector: a.connector,
    route: agent?.route ?? null,
    amount: a.amount ?? null, counterparty: a.counterparty ?? null, expires_at: a.expiresAt,
    held_because: { rule: a.ruleId, rulebook_version: hold?.rulebook?.version ?? null, reason: a.ruleReason, triggered_by: a.triggeredBy ?? null },
    effect: a.effect ?? null,
    risk_tags: [...(a.riskTags ?? [])],
    call_back: needsCallBack(a),
    record: diff.record, record_exists: diff.exists, read_only: diff.readOnly,
    diff: diff.fields.map((x) => ({ field: x.key, label: x.label, before: x.before, after: x.after, changed: x.changed })),
    checks: checks.map((c) => ({ id: c.id, name: c.name, result: c.result, version: c.version, detail: c.detail })),
    blast_radius: { scope: br.scope, label: br.label, why: br.why, dual_control: br.dualControl },
    two_people: !!two, two_person_reason: two,
    two_person_above: two === 'amount' ? twoPersonPolicy(orgId).above : null,
    first_approval_by: firstApprovalOf(orgId, a.id)?.userId ?? null,
    reversal: { plan: plan.plan, reversible: plan.reversible, read_only: plan.readOnly },
    step_up: stepUpReason(orgId, a) ?? null,
    ...(view === 'console' ? { args: a.args } : {}),
  };
}

export function payloadDigest(orgId: string, a: Approval, view: PayloadView = 'console'): string {
  return sha256Hex(canonical(shownPayload(orgId, a, view)));
}

/** Version 1 (ids and results only), for decision receipts recorded before version 2: they carry no payload_view. */
function shownPayloadV1(orgId: string, a: Approval) {
  const diff = recordDiff(a);
  const checks = checkResults(orgId, a);
  return {
    approval: a.id, hold_seq: a.seq, headline: a.headline, agent: a.agentSlug, tool: a.tool, connector: a.connector,
    amount: a.amount ?? null, counterparty: a.counterparty ?? null, args: a.args, expires_at: a.expiresAt,
    record: diff.record, diff: diff.fields.map((x) => ({ field: x.key, before: x.before, after: x.after })),
    checks: checks.map((c) => ({ id: c.id, result: c.result, version: c.version })),
    blast_radius: blastRadius(a).scope, two_people: needsTwo(orgId, a), reversal: reversalPlan(a).plan,
  };
}

/** The digest to compare a decision receipt's payload_digest against, for the screen and version it records. */
export function payloadDigestFor(orgId: string, a: Approval, recordedView?: string): string {
  if (recordedView === 'console' || recordedView === 'link') return payloadDigest(orgId, a, recordedView);
  return sha256Hex(canonical(shownPayloadV1(orgId, a)));
}

/* ── Approve and draft a rule ─────────────────────────────── */

/** The rule a person would draft from this approval: allow calls like this one, put before the rule that held it. */
export function ruleFromApproval(a: Approval): Rule {
  const args = a.args ?? {};
  const when: Condition[] = [];
  for (const k of ['vendor', 'service', 'to', 'environment', 'template']) {
    const v = args[k];
    if (typeof v === 'string' && v) when.push(k === 'to' ? { field: 'to', op: 'eq', value: v } : { field: k, op: 'in', value: [v] });
  }
  const amount = typeof args.amount === 'number' ? args.amount : a.amount;
  if (amount !== undefined) when.push({ field: typeof args.amount === 'number' ? 'amount' : 'amount_due', op: 'lte', value: Math.ceil(amount / 1000) * 1000 });
  return {
    id: `${a.ruleId}-like-${a.id.slice(-4)}`,
    match: { tool: a.tool },
    ...(when.length ? { when } : {}),
    decide: 'allow',
    reason: `Drafted from approval ${a.id}: calls like the one approved${a.decidedBy ? ` by ${userName(a.decidedBy)}` : ''}. Review before publishing.`,
  };
}

/**
 * Open the agent's rulebook draft with a rule allowing calls like this approved one (pre-filled, before the rule
 * that held it). The draft is saved, nothing is live; a person publishes it. Writes approval.rule_drafted.
 */
export async function draftRuleFromApproval(orgId: string, a: Approval, userId: string): Promise<{ slug: string; version: number; ruleId: string }> {
  const { rulebook: rb, agent } = await api.rulebook(orgId, a.agentSlug);
  if (!agent) throw new Error(`No agent called ${a.agentSlug}.`);
  const draft = draftOf(rb);
  const base = draft ?? publishedOf(rb);
  if (!base) throw new Error('This rulebook has no version to start a draft from.');
  const groups = api.approverGroups(orgId);
  registerOrg(orgTools(orgId), groups);
  const ctxBase = { slug: rb.slug, owner: agent.ownerId, approverIds: rb.approverGroups.map((g) => g.id), groups, lists: namedLists(orgId) };
  const parsed = parseRulebookYaml(base.yaml, { ...ctxBase, version: base.version });
  const baseRules = parsed.ok ? parsed.rules : base.rules;
  const rule = ruleFromApproval(a);
  const without = baseRules.filter((r) => r.id !== rule.id);
  const at = without.findIndex((r) => r.id === a.ruleId);
  const rules: Rule[] = at >= 0 ? [...without.slice(0, at), rule, ...without.slice(at)] : [rule, ...without];
  const N = nextVersionNo(rb);
  const yaml = buildYaml({ ...ctxBase, version: N }, rules, parsed.ok ? parsed.extras : NO_EXTRAS);
  const note = draft ? `${draft.note}; plus: ${rule.id} (drafted from approval ${a.id})` : `Draft: ${rule.id} (drafted from approval ${a.id})`;
  await api.saveDraft(orgId, rb.id, yaml, rules, note, userId);
  recordRuleDraft(orgId, a.id, userId, { rulebook: rb.slug, version: N, rule: rule.id }, a.agentSlug);
  return { slug: rb.slug, version: N, ruleId: rule.id };
}
