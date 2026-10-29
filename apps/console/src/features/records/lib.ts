/**
 * Records — the business objects agents act on, derived from the chain.
 *
 * Nothing here is stored separately: every record, count and state below is computed from signed receipts
 * (decision → approval → outcome, linked by ref_seq) and the approvals they held. A record's key is
 * `type:id`, e.g. "vendor:Northwind Traders", "bill:BILL-9127", "service:billing-api", "account:EXT-SBIN-7781".
 */
import type { LucideIcon } from 'lucide-react';
import { AtSign, Banknote, Building2, FileCheck, FileText, FileUser, GitBranch, GitPullRequest, Landmark, ReceiptText, Server, UserRound } from 'lucide-react';
import type { Approval, Decision, Org, Receipt, Rulebook } from '@/types';
import { api } from '@/api';
import { toolByName } from '@/mock/catalog';
import { describeCall } from '../activity/shared';

/* ── Types of record ─────────────────────────────────────── */

export type RecordType = 'vendor' | 'customer' | 'domain' | 'bill' | 'invoice' | 'payment' | 'claim' | 'account' | 'service' | 'repo' | 'pr' | 'application';
export type RecordGroup = 'counterparties' | 'documents' | 'accounts' | 'code' | 'applications';

export const TYPE_META: Record<RecordType, { label: string; plural: string; group: RecordGroup; icon: LucideIcon; hint: string; personal?: boolean }> = {
  vendor: { label: 'Vendor', plural: 'Vendors', group: 'counterparties', icon: Building2, hint: 'A supplier your agents pay, bill or onboard.' },
  customer: { label: 'Customer', plural: 'Customers', group: 'counterparties', icon: UserRound, hint: 'A customer your agents send reminders and notices to, named by its email domain. Holds contact details (personal data).', personal: true },
  domain: { label: 'Email domain', plural: 'Email domains', group: 'counterparties', icon: AtSign, hint: 'An outside address that is not an approved vendor or a known customer. Holds contact details (personal data).', personal: true },
  bill: { label: 'Bill', plural: 'Bills', group: 'documents', icon: FileText, hint: 'A vendor bill in the books.' },
  invoice: { label: 'Invoice', plural: 'Invoices', group: 'documents', icon: ReceiptText, hint: 'A customer invoice your agents chase.' },
  payment: { label: 'Payment', plural: 'Payments', group: 'documents', icon: Banknote, hint: 'A recorded payment.' },
  claim: { label: 'Expense claim', plural: 'Expense claims', group: 'documents', icon: FileCheck, hint: 'An employee expense claim.' },
  account: { label: 'Bank account', plural: 'Bank accounts', group: 'accounts', icon: Landmark, hint: 'A bank account money moved from or to.' },
  service: { label: 'Service', plural: 'Services', group: 'code', icon: Server, hint: 'A running service your agents read, deploy or change.' },
  repo: { label: 'Repository', plural: 'Repositories', group: 'code', icon: GitBranch, hint: 'A code repository.' },
  pr: { label: 'Pull request', plural: 'Pull requests', group: 'code', icon: GitPullRequest, hint: 'A pull request an agent asked to merge.' },
  application: { label: 'Job application', plural: 'Job applications', group: 'applications', icon: FileUser, hint: 'A candidate application. Personal data.', personal: true },
};

export const GROUPS: { id: RecordGroup | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'counterparties', label: 'Counterparties' },
  { id: 'documents', label: 'Bills and invoices' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'code', label: 'Services and code' },
  { id: 'applications', label: 'Applications' },
];

export interface RecordRef {
  key: string;
  type: RecordType;
  id: string;
  name: string;
}

export function makeKey(type: RecordType, id: string) {
  return `${type}:${id}`;
}

export function parseKey(raw: string | undefined): { type: RecordType; id: string } | undefined {
  if (!raw) return undefined;
  let key = raw;
  if (/%[0-9a-f]{2}/i.test(key)) {
    try { key = decodeURIComponent(key); } catch { /* keep as is */ }
  }
  const i = key.indexOf(':');
  if (i <= 0) return undefined;
  const type = key.slice(0, i) as RecordType;
  const id = key.slice(i + 1);
  if (!TYPE_META[type] || !id) return undefined;
  return { type, id };
}

export const recordPath = (key: string) => `/records/${encodeURIComponent(key)}`;

/* ── What happened to the record in one governed call ─────── */

export type EventStatus = 'committed' | 'advised' | 'approved' | 'waiting' | 'rejected' | 'expired' | 'refused' | 'failed' | 'read';
export type StateTone = 'ok' | 'held' | 'bad' | 'neutral' | 'info';

export interface RecordEvent {
  seq: number;
  ts: string;
  agent?: string;
  tool?: string;
  args: Record<string, string | number | boolean>;
  decision: Decision;
  ruleId?: string;
  reason?: string;
  rulebook?: { version: number; hash: string };
  mode?: 'governed_run' | 'check_and_record';
  /** Only reads data — not a governed write. */
  read: boolean;
  status: EventStatus;
  approval?: Approval;
  /** The decision receipt first, then the approval and outcome receipts that point back to it. */
  receipts: Receipt[];
  approvalReceipt?: Receipt;
  outcomeReceipt?: Receipt;
  refs: RecordRef[];
}

const READ_ONLY_TAGS = new Set(['reads_data', 'personal_data']);

function isRead(tool?: string) {
  const t = tool ? toolByName(tool) : undefined;
  if (!t) return tool ? /\.(read|list|get|search|verify)_/.test(tool) : false;
  return t.tags.length > 0 && t.tags.every((x) => READ_ONLY_TAGS.has(x));
}

/* ── Extraction: which records a receipt touches ──────────── */

interface Ctx {
  vendorByDomain: Map<string, string>;
  customerDomains: Set<string>;
  nameByDomain: Map<string, string>;
  ownDomains: Set<string>;
}

function extract(args: Record<string, string | number | boolean>, tool: string | undefined, ctx: Ctx): RecordRef[] {
  const out: RecordRef[] = [];
  const seen = new Set<string>();
  const add = (type: RecordType, raw: unknown, name?: string) => {
    if (raw === undefined || raw === null || raw === '') return;
    const id = String(raw).trim();
    if (!id) return;
    const key = makeKey(type, id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, type, id, name: name ?? id });
  };
  if (args.vendor !== undefined) add('vendor', args.vendor);
  if (args.counterparty !== undefined) add('vendor', args.counterparty);
  if (args.name !== undefined && tool && /vendor/.test(tool)) add('vendor', args.name);
  if (typeof args.to_domain === 'string') {
    const dom = args.to_domain.toLowerCase();
    const vendor = ctx.vendorByDomain.get(dom);
    if (vendor) add('vendor', vendor);
    else if (ctx.ownDomains.has(dom)) { /* our own people — not a counterparty */ }
    else if (ctx.customerDomains.has(dom)) add('customer', dom, ctx.nameByDomain.get(dom) ?? dom);
    else add('domain', dom);
  }
  if (args.bill !== undefined) add('bill', args.bill);
  if (args.invoice !== undefined) add('invoice', args.invoice);
  if (args.payment !== undefined) add('payment', args.payment);
  if (args.claim !== undefined) add('claim', args.claim);
  for (const k of ['from_account', 'to_account', 'account']) if (args[k] !== undefined) add('account', args[k]);
  if (args.service !== undefined) add('service', args.service);
  if (args.repo !== undefined) {
    add('repo', args.repo);
    if (args.pr !== undefined) add('pr', `${args.repo}#${args.pr}`, `${args.repo} #${args.pr}`);
  }
  if (args.application !== undefined) add('application', args.application);
  return out;
}

const compactName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Everything the extractor needs, taken from the organisation's own data: approved vendor domains from its
 * published rulebooks (to_domain_in conditions), vendor names from its chain, its own mail domains from its
 * organisation profile and members, and customer domains from collections traffic.
 */
function buildCtx(src: RecordSources): Ctx {
  const { receipts, approvals, rulebooks, org, memberEmails } = src;
  const vendorNames = new Set<string>();
  for (const r of receipts) {
    const a = r.args_summary;
    if (!a) continue;
    if (typeof a.vendor === 'string') vendorNames.add(a.vendor);
    if (typeof a.name === 'string' && r.tool && /vendor/.test(r.tool)) vendorNames.add(a.name);
  }
  const names = Array.from(vendorNames);
  const vendorDomains = new Set<string>();
  for (const rb of rulebooks) {
    const v = rb.versions.find((x) => x.version === rb.currentVersion) ?? rb.versions[rb.versions.length - 1];
    for (const rule of v?.rules ?? []) {
      for (const c of [...(rule.when ?? []), ...(rule.unless ?? [])]) {
        if (c.op === 'to_domain_in' && Array.isArray(c.value)) c.value.forEach((d) => vendorDomains.add(String(d).toLowerCase()));
      }
    }
  }
  const vendorByDomain = new Map<string, string>();
  for (const dom of vendorDomains) {
    const stem = compactName(dom.split('.')[0]);
    const name = names.find((nm) => { const c = compactName(nm); return stem.length >= 4 && (c.startsWith(stem) || stem.startsWith(c)); });
    vendorByDomain.set(dom, name ?? dom);
  }
  // a held vendor email names the vendor too
  for (const ap of approvals) {
    const to = ap.args?.to;
    if (typeof to === 'string' && to.includes('@') && ap.counterparty && vendorNames.has(ap.counterparty)) vendorByDomain.set(to.split('@')[1].toLowerCase(), ap.counterparty);
  }
  const ownDomains = new Set<string>(memberEmails.map((e) => e.split('@')[1]?.toLowerCase()).filter(Boolean) as string[]);
  if (org.domain) ownDomains.add(org.domain.toLowerCase());
  const customerDomains = new Set<string>();
  for (const r of receipts) {
    const a = r.args_summary;
    if (a && typeof a.to_domain === 'string' && (a.invoice !== undefined || a.amount_due !== undefined || (typeof a.template === 'string' && /reminder|notice/.test(a.template)))) {
      customerDomains.add(a.to_domain.toLowerCase());
    }
  }
  const nameByDomain = new Map<string, string>();
  for (const ap of approvals) {
    const to = ap.args?.to;
    if (typeof to === 'string' && to.includes('@') && ap.counterparty && !ap.counterparty.includes('.')) nameByDomain.set(to.split('@')[1].toLowerCase(), ap.counterparty);
  }
  return { vendorByDomain, customerDomains, nameByDomain, ownDomains };
}

/* ── The index ────────────────────────────────────────────── */

export interface RecordEntry {
  ref: RecordRef;
  events: RecordEvent[]; // newest first
}

export interface RecordIndex {
  records: Map<string, RecordEntry>;
  events: RecordEvent[];
  publicKeys: Record<string, string>;
  org: Org;
  totals: { receipts: number; rulebooks: number; connectors: number; aiSystems: number; assessments: number };
  builtAt: number;
}

/** The organisation's data the index is built from — all loaded through the API. */
export interface RecordSources {
  org: Org;
  receipts: Receipt[]; // oldest first
  approvals: Approval[];
  rulebooks: Rulebook[];
  memberEmails: string[];
  publicKeys: Record<string, string>;
  totals: RecordIndex['totals'];
}

function statusOf(r: Receipt, read: boolean, approval: Approval | undefined, apr: Receipt | undefined, out: Receipt | undefined): EventStatus {
  if (r.decision === 'refuse') return 'refused';
  if (r.decision === 'allow') {
    if (read) return 'read';
    if (r.outcome?.status === 'error' || out?.outcome?.status === 'error') return 'failed';
    if (r.details?.mode === 'check_and_record' && !out) return 'advised';
    return 'committed';
  }
  // ask
  const st = apr?.approval?.status ?? approval?.status;
  if (st === 'approved') return apr?.outcome?.status === 'error' ? 'failed' : 'approved';
  if (st === 'approved_run_failed') return 'failed';
  if (st === 'rejected') return 'rejected';
  if (st === 'expired') return 'expired';
  return 'waiting';
}

export function buildIndex(src: RecordSources): RecordIndex {
  const d = src;
  const ctx = buildCtx(src);
  const approvalsById = new Map(d.approvals.map((a) => [a.id, a]));
  const followUps = new Map<number, Receipt[]>();
  for (const r of d.receipts) {
    if (r.ref_seq !== undefined && (r.kind === 'approval' || r.kind === 'outcome')) {
      const list = followUps.get(r.ref_seq);
      if (list) list.push(r);
      else followUps.set(r.ref_seq, [r]);
    }
  }

  const records = new Map<string, RecordEntry>();
  const events: RecordEvent[] = [];
  for (let i = d.receipts.length - 1; i >= 0; i--) {
    const r = d.receipts[i];
    if (r.kind !== 'decision' || !r.args_summary || !r.decision) continue;
    const refs = extract(r.args_summary, r.tool, ctx);
    if (!refs.length) continue;
    const fu = followUps.get(r.seq) ?? [];
    const apr = fu.find((x) => x.kind === 'approval');
    // an approved advisory call may have an outcome that points at the approval receipt
    const out = fu.find((x) => x.kind === 'outcome') ?? (apr ? followUps.get(apr.seq)?.find((x) => x.kind === 'outcome') : undefined);
    const approval = r.approval ? approvalsById.get(r.approval.id) : undefined;
    const read = isRead(r.tool);
    const mode = r.details?.mode === 'governed_run' || r.details?.mode === 'check_and_record' ? r.details.mode : undefined;
    const ev: RecordEvent = {
      seq: r.seq, ts: r.ts, agent: r.agent, tool: r.tool, args: r.args_summary, decision: r.decision, ruleId: r.rule_id, reason: r.reason,
      rulebook: r.rulebook, mode, read, approval, approvalReceipt: apr, outcomeReceipt: out,
      status: statusOf(r, read, approval, apr, out),
      receipts: [r, ...(apr ? [apr] : []), ...(out ? [out] : [])],
      refs,
    };
    events.push(ev);
    for (const ref of refs) {
      const e = records.get(ref.key);
      if (e) {
        e.events.push(ev);
        // prefer a human name over a domain when one turns up later
        if (e.ref.name === e.ref.id && ref.name !== ref.id) e.ref = ref;
      } else records.set(ref.key, { ref, events: [ev] });
    }
  }

  return { records, events, publicKeys: d.publicKeys, org: d.org, totals: d.totals, builtAt: Date.now() };
}

/** Loaded through useQuery (and the API) so the index rebuilds whenever the organisation's chain moves. */
export async function loadRecords(orgId: string): Promise<RecordIndex> {
  const [rs, approvals, members, rulebooks, connectors, inventory, assessments, evidence] = await Promise.all([
    api.receipts(orgId), api.approvals(orgId), api.members(orgId), api.rulebooks(orgId), api.connectors(orgId), api.inventory(orgId), api.assessments(orgId), api.evidence(orgId),
  ]);
  const receipts = rs.items.slice().reverse();
  return buildIndex({
    org: evidence.org, receipts, approvals, rulebooks,
    memberEmails: members.filter((m) => m.role !== 'auditor' && m.user).map((m) => m.user!.email),
    publicKeys: evidence.publicKeys,
    totals: { receipts: rs.total, rulebooks: rulebooks.length, connectors: connectors.length, aiSystems: inventory.length, assessments: assessments.length },
  });
}

/** Records that hold personal data, and so can be erased under DPDP (salt destruction, from L2). */
export const holdsPersonalData = (type: RecordType) => !!TYPE_META[type].personal;

/* ── Words for what happened ──────────────────────────────── */

const ACT: Record<string, { done: string; approved: string; noun: string }> = {
  'zoho_books.record_payment': { done: 'Payment recorded', approved: 'Payment approved and recorded', noun: 'payment' },
  'zoho_books.create_bill': { done: 'Bill drafted', approved: 'Bill approved and drafted', noun: 'bill' },
  'zoho_books.delete_bill': { done: 'Bill deleted', approved: 'Deletion approved and done', noun: 'deletion' },
  'zoho_books.void_payment': { done: 'Payment voided', approved: 'Void approved and done', noun: 'void' },
  'zoho_books.create_vendor': { done: 'Vendor created', approved: 'Vendor approved and created', noun: 'vendor creation' },
  'procure.create_vendor': { done: 'Vendor created', approved: 'Vendor approved and created', noun: 'vendor creation' },
  'procure.update_bank_details': { done: 'Bank account changed', approved: 'Bank change approved and made', noun: 'bank change' },
  'gmail.send_email': { done: 'Email sent', approved: 'Email approved and sent', noun: 'email' },
  'gmail.create_draft': { done: 'Draft saved', approved: 'Draft approved and saved', noun: 'draft' },
  'platform.deploy': { done: 'Deployed', approved: 'Deploy approved and rolled out', noun: 'deploy' },
  'platform.merge_pr': { done: 'Pull request merged', approved: 'Merge approved and done', noun: 'merge' },
  'platform.grant_access': { done: 'Access granted', approved: 'Access grant approved', noun: 'access grant' },
  'bank.initiate_transfer': { done: 'Transfer initiated', approved: 'Transfer approved and initiated', noun: 'transfer' },
  'hr.read_application': { done: 'Application read', approved: 'Read approved and done', noun: 'read' },
  'hr.send_candidate_email': { done: 'Candidate emailed', approved: 'Candidate email approved and sent', noun: 'candidate email' },
};

/** What the agent tried, in the words of the attempted action. */
export function describeEvent(ev: Pick<RecordEvent, 'tool' | 'args'>): string {
  const a = ev.args;
  const s = (k: string) => (a[k] !== undefined ? String(a[k]) : '');
  const money = (k: string) => (typeof a[k] === 'number' ? '₹' + new Intl.NumberFormat('en-IN').format(a[k] as number) : '');
  switch (ev.tool) {
    case 'platform.merge_pr': return `merge pull request #${s('pr')} into ${s('repo')}${a.checks ? ` with checks ${s('checks')}` : ''}${a.approvals !== undefined ? ` and ${s('approvals')} ${s('approvals') === '1' ? 'review' : 'reviews'}` : ''}`;
    case 'platform.grant_access': return `grant ${s('user')} ${s('role')} access to ${s('repo')}`;
    case 'platform.read_logs': return `read the last ${s('since') || 'hour'} of ${s('service')} logs`;
    case 'zoho_books.delete_bill': return `delete ${s('bill')}${a.reason ? ` (${s('reason')})` : ''}`;
    case 'zoho_books.void_payment': return `void payment ${s('payment')}`;
    case 'zoho_books.create_bill': return `draft ${s('bill')} for ${money('amount')} from ${s('vendor')}`;
    case 'zoho_books.record_payment': return `record a ${s('mode') ? `${s('mode')} ` : ''}payment of ${money('amount')} to ${s('vendor')} against ${s('bill')}`;
    case 'procure.create_vendor': return `create vendor ${s('name')}${s('gstin_verified') === 'false' ? ' without a verified GSTIN' : ' with a verified GSTIN'}`;
    case 'procure.update_bank_details': return `change the bank account for ${s('vendor')} to •••• ${s('account_last4')} (${s('ifsc')})`;
    case 'bank.initiate_transfer': return `transfer ${money('amount')} from ${s('from_account')} to ${s('to_account')}`;
    case 'bank.get_balance': return `read the balance of ${s('account')}`;
    case 'hr.read_application': return `read application ${s('application')}${a.role ? ` for ${s('role')}` : ''}`;
    case 'gmail.send_email':
      if (a.template) return `send the ${s('template').replace(/_/g, ' ')} email${a.invoice ? ` for ${s('invoice')}` : ''}${a.amount_due !== undefined ? ` (${money('amount_due')} due)` : ''} to ${s('to_domain')}`;
      return `send an email to ${s('to_domain')}`;
    case 'gmail.create_draft': return `draft a ${s('template').replace(/_/g, ' ')} reply${a.invoice ? ` for ${s('invoice')}` : ''}${a.claim ? ` about ${s('claim')}` : ''}`;
    default: return describeCall(ev.tool, a);
  }
}

export function actOf(tool?: string) {
  return (tool && ACT[tool]) || { done: 'Write committed', approved: 'Approved and committed', noun: 'call' };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function groupOf(ev: RecordEvent): string {
  return (ev.approval?.approverGroup ?? 'a person').toLowerCase();
}

/** One short label for what an event did to the record. */
export function eventLabel(ev: RecordEvent): { label: string; tone: StateTone } {
  const a = actOf(ev.tool);
  switch (ev.status) {
    case 'committed': return { label: ev.outcomeReceipt ? `${a.done} (agent reported)` : a.done, tone: 'ok' };
    case 'advised': return { label: `${cap(a.noun)} allowed — agent runs it`, tone: 'ok' };
    case 'approved': return { label: a.approved, tone: 'ok' };
    case 'waiting': return { label: `Waiting for ${groupOf(ev)}`, tone: 'held' };
    case 'rejected': return { label: `Refused — ${a.noun} rejected`, tone: 'bad' };
    case 'expired': return { label: `Refused — ${a.noun} expired unanswered`, tone: 'bad' };
    case 'failed': return { label: ev.decision === 'ask' ? `${cap(a.noun)} approved, run failed` : `${cap(a.noun)} failed — tool error`, tone: 'bad' };
    case 'read': return { label: 'Read', tone: 'neutral' };
    case 'refused':
    default:
      if (ev.ruleId === 'agent-paused') return { label: `Refused — agent paused`, tone: 'bad' };
      if (ev.ruleId === 'default') return { label: `Refused — no rule allows this ${a.noun}`, tone: 'bad' };
      if (ev.ruleId === 'invalid-arguments') return { label: 'Refused — invalid arguments', tone: 'bad' };
      return { label: `Refused by ${ev.ruleId ?? 'a rule'}`, tone: 'bad' };
  }
}

/* ── Summary of a record ──────────────────────────────────── */

export interface RecordSummary {
  ref: RecordRef;
  events: RecordEvent[];
  inRange: RecordEvent[];
  last?: string;
  first?: string;
  committed: number;
  asked: number;
  refused: number;
  failed: number;
  reads: number;
  waiting: RecordEvent[];
  agents: string[];
  state: { label: string; tone: StateTone; seq?: number };
  lastWrite?: RecordEvent;
}

const COMMITTED: EventStatus[] = ['committed', 'advised', 'approved'];
const REFUSED: EventStatus[] = ['refused', 'rejected', 'expired'];

export function isCommitted(ev: RecordEvent) { return COMMITTED.includes(ev.status); }
export function isRefusal(ev: RecordEvent) { return REFUSED.includes(ev.status); }
export function isEscalation(ev: RecordEvent) { return ev.decision === 'ask'; }

/** Current state is computed from every event; the counts only from events at or after `from`. */
export function summarise(entry: RecordEntry, from?: number): RecordSummary {
  const inRange = from ? entry.events.filter((e) => new Date(e.ts).getTime() >= from) : entry.events;
  const waiting = entry.events.filter((e) => e.status === 'waiting');
  const agents = Array.from(new Set(inRange.map((e) => e.agent).filter(Boolean) as string[]));
  const lastWrite = entry.events.find((e) => !e.read || e.decision !== 'allow');
  let state: RecordSummary['state'];
  if (waiting.length) {
    const groups = Array.from(new Set(waiting.map(groupOf)));
    state = { label: `${waiting.length > 1 ? `${waiting.length} waiting` : 'Waiting'} for ${groups.join(' and ')}`, tone: 'held', seq: waiting[0].seq };
  } else if (lastWrite) {
    const l = eventLabel(lastWrite);
    state = { label: l.label, tone: l.tone, seq: lastWrite.seq };
  } else state = { label: 'Read only — no writes', tone: 'neutral', seq: entry.events[0]?.seq };
  return {
    ref: entry.ref, events: entry.events, inRange,
    last: inRange[0]?.ts, first: inRange[inRange.length - 1]?.ts,
    committed: inRange.filter((e) => !e.read && isCommitted(e)).length,
    asked: inRange.filter(isEscalation).length,
    refused: inRange.filter(isRefusal).length,
    failed: inRange.filter((e) => e.status === 'failed').length,
    reads: inRange.filter((e) => e.status === 'read').length,
    waiting, agents, state, lastWrite,
  };
}

/* ── Pinned fields ────────────────────────────────────────── */

export const FIELD_LABEL: Record<string, string> = {
  amount: 'Amount', amount_due: 'Amount due', currency: 'Currency', mode: 'Payment mode', bill: 'Bill', invoice: 'Invoice', vendor: 'Vendor', name: 'Name',
  gstin_verified: 'GSTIN status', gstin: 'GSTIN', state: 'State', country: 'Country', ifsc: 'IFSC', account_last4: 'Bank account',
  service: 'Service', version: 'Version', environment: 'Environment', since: 'Log window', repo: 'Repository', pr: 'Pull request', approvals: 'Reviews', checks: 'Checks',
  to_domain: 'Address domain', template: 'Template', days_overdue: 'Days overdue', from_account: 'From account', to_account: 'To account', account: 'Account',
  application: 'Application', role: 'Role', user: 'User', payment: 'Payment', claim: 'Claim', reason: 'Reason', status: 'Status', folder: 'Folder', older_than_days: 'Older than', type: 'Type', month: 'Month',
};

const FIELD_ORDER = ['amount', 'amount_due', 'account_last4', 'ifsc', 'gstin_verified', 'version', 'environment', 'mode', 'currency', 'days_overdue', 'template', 'checks', 'approvals', 'state', 'country', 'role'];

export function fieldValue(k: string, v: string | number | boolean): string {
  const num = typeof v === 'number' ? v : undefined;
  if ((k === 'amount' || k === 'amount_due') && num !== undefined) return '₹' + new Intl.NumberFormat('en-IN').format(num);
  if (k === 'gstin_verified') return String(v) === 'true' ? 'Verified' : 'Not verified';
  if (k === 'account_last4') return `•••• ${v}`;
  if (k === 'days_overdue' && num !== undefined) return `${num} days`;
  if (k === 'older_than_days') return `${v} days`;
  if (k === 'template') return String(v).replace(/_/g, ' ');
  return String(v);
}

const PER_CALL = new Set(['amount', 'amount_due', 'mode', 'currency', 'template', 'days_overdue', 'version', 'environment']);

function labelFor(field: string, tool?: string) {
  const base = FIELD_LABEL[field] ?? cap(field.replace(/_/g, ' '));
  if (!tool) return base;
  const noun = actOf(tool).noun;
  return `Last ${noun} · ${base.toLowerCase()}`;
}

export interface PinnedField {
  field: string;
  label: string;
  value: string;
  ev: RecordEvent;
  /** A newer attempt that did not go through, so it is not the current value. */
  attempted?: { value: string; ev: RecordEvent };
}

/** Latest committed value of every field this record's writes carried, with any newer attempt that did not commit. */
export function pinnedFields(ref: RecordRef, events: RecordEvent[]): PinnedField[] {
  // Identity fields name other records. A parent (vendor, account, service…) lists those as related records instead;
  // a child (bill, invoice, pull request…) pins its parent, e.g. a bill pins its vendor.
  const identity = new Set(['vendor', 'counterparty', 'name', 'bill', 'invoice', 'service', 'repo', 'pr', 'application', 'payment', 'claim', 'to_domain', 'from_account', 'to_account', 'account']);
  const parent = ['vendor', 'customer', 'domain', 'account', 'service', 'repo'].includes(ref.type);
  const out = new Map<string, PinnedField>();
  const attempts = new Map<string, { value: string; ev: RecordEvent }>();
  for (const ev of events) {
    // newest first; reads change nothing, so they never set a pinned value
    if (ev.read && ev.decision === 'allow') continue;
    for (const [k, raw] of Object.entries(ev.args)) {
      if (identity.has(k) && (parent || String(raw) === ref.id || (ref.type === 'pr' && k === 'pr'))) continue;
      if (k === 'page' || k === 'unread') continue;
      // a child's parent (a bill's vendor) is who it belongs to, not a value a write changes
      if (identity.has(k)) {
        const v = fieldValue(k, raw);
        const cur = out.get(k);
        // the same number can be named by more than one call; show every owner the chain records, newest first
        if (!cur) out.set(k, { field: k, label: labelFor(k), value: v, ev });
        else if (!cur.value.split(' · ').includes(v)) cur.value = `${cur.value} · ${v}`;
        continue;
      }
      // On a parent, an amount belongs to the call that carried it: "Last payment amount", not one "Amount".
      const perCall = parent && PER_CALL.has(k);
      const slot = perCall ? `${k}@${ev.tool}` : k;
      const value = fieldValue(k, raw);
      if (out.has(slot)) continue;
      if (isCommitted(ev)) {
        const att = attempts.get(slot);
        out.set(slot, { field: k, label: labelFor(k, perCall ? ev.tool : undefined), value, ev, attempted: att && att.value !== value ? att : undefined });
      } else if (!attempts.has(slot)) {
        attempts.set(slot, { value, ev });
      }
    }
  }
  // fields only ever attempted, never committed
  for (const [slot, att] of attempts) {
    if (out.has(slot)) continue;
    const [k, tool] = slot.split('@');
    out.set(slot, { field: k, label: labelFor(k, tool), value: '', ev: att.ev, attempted: att });
  }
  const rank = (k: string) => { if (identity.has(k)) return -1; const i = FIELD_ORDER.indexOf(k); return i < 0 ? 99 : i; };
  return Array.from(out.values()).sort((a, b) => rank(a.field) - rank(b.field) || a.field.localeCompare(b.field));
}

/** Other records that appear in the same governed calls, with how many calls they share. */
export function relatedRecords(ref: RecordRef, events: RecordEvent[]): { ref: RecordRef; count: number; last: string }[] {
  const m = new Map<string, { ref: RecordRef; count: number; last: string }>();
  for (const ev of events) {
    for (const r of ev.refs) {
      if (r.key === ref.key) continue;
      const x = m.get(r.key);
      if (x) x.count++;
      else m.set(r.key, { ref: r, count: 1, last: ev.ts });
    }
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

export const H = 3_600_000;
export const D = 24 * H;
