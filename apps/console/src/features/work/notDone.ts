/**
 * Not done — the Work door's queue of refusals that need explaining or acting on.
 * Derived from the organisation's receipts: refused decision receipts and the approval receipts
 * that closed a held call as rejected or expired. Every item is written in the words of the
 * attempted action, so an operator can read it without opening the receipt.
 */
import type { Approval, Channel, LevelId, Receipt } from '@/types';
import type { OrgDB } from '@/mock/db';
import { refusalClassFull, type RefusalClassFull } from '@/features/activity/shared';
import { toolByName } from '@/mock/catalog';
import { rupees } from '@/lib/format';

export type NotDoneClass = RefusalClassFull;

export const H = 3_600_000;
export const D = 24 * H;

export type RangeId = '24h' | '7d' | '21d';
export const RANGES: Record<RangeId, { ms: number; label: string; long: string; activity: string }> = {
  '24h': { ms: D, label: '24 h', long: 'the last 24 hours', activity: '24h' },
  '7d': { ms: 7 * D, label: '7 d', long: 'the last 7 days', activity: '7d' },
  '21d': { ms: 21 * D, label: '21 d', long: 'the last 21 days', activity: 'all' },
};

export interface ClassMeta {
  id: NotDoneClass;
  label: string;
  hint: string;
  action: string;
  /** the level these refusals start at (shown with an upgrade path below it) */
  level?: LevelId;
}

/** The reason classes, in the order an operator should work them. The last three start at L2 or L3. */
export const CLASSES: ClassMeta[] = [
  { id: 'rule', label: 'Refused by a rule', hint: 'A rule in the published rulebook said no.', action: 'If this should run, change the rule.' },
  { id: 'default', label: 'No rule allows it', hint: 'Nothing in the rulebook allowed the call, so it was refused by default.', action: 'Add a rule that allows it, then test it on past actions.' },
  { id: 'paused', label: 'Agent paused or stopped', hint: 'The agent was paused by its owner, by auto-pause or by the emergency stop.', action: 'Resume the agent once the cause is dealt with.' },
  { id: 'invalid', label: 'Invalid arguments', hint: 'The call did not match the tool’s input schema.', action: 'Fix the agent’s call.' },
  { id: 'rejected', label: 'Approval rejected', hint: 'A person said no to a held call.', action: 'Read who rejected it and why.' },
  { id: 'expiry', label: 'Approval expired', hint: 'No one decided a held call in time. Expiry is a refusal.', action: 'Re-route approvals or shorten the expiry.' },
  { id: 'autonomy', label: 'No autonomy grant', hint: 'The agent has no grant above A0 Observe for this tool, so a write was refused.', action: 'No one sets a level. Check the agent on Agents › Autonomy: write types start at A2 Propose.', level: 'l3' },
  { id: 'pack_gate', label: 'Regulatory pack declaration', hint: 'The write is one an installed pack (ledger1, invoice1, collect1) does not admit, or it broke a condition of the pack’s declaration. At L1 packs run as a dry run and never refuse.', action: 'Read the pack’s declaration and its configured values.', level: 'l2' },
];

export const classMeta = (id: NotDoneClass) => CLASSES.find((c) => c.id === id)!;

export interface NotDoneItem {
  key: string; // receipt seq as a string
  seq: number;
  ts: string;
  cls: NotDoneClass;
  agent: string;
  tool: string;
  ruleId?: string;
  /** "invoice-bot tried to delete bill BILL-9031" */
  attempt: string;
  /** "Bills are cancelled by a person …" */
  reason: string;
  stop?: boolean;
  /** decision receipt that held the call, for approval items */
  heldSeq?: number;
  approval?: Pick<Approval, 'id' | 'status' | 'approverGroup' | 'createdAt' | 'expiresAt' | 'decidedBy' | 'decisionReason' | 'ruleId' | 'amount' | 'counterparty'> & { channel?: Channel };
}

export interface NotDoneCluster {
  key: string;
  cls: NotDoneClass;
  agent: string;
  tool: string;
  ruleId?: string;
  items: NotDoneItem[]; // newest first
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const money = (v: unknown) => (typeof v === 'number' ? rupees(v) : str(v));

/** The attempted action in plain words, from the tool and the arguments the receipt kept. */
export function actionPhrase(tool: string, a: Record<string, string | number | boolean> = {}): string {
  switch (tool) {
    case 'zoho_books.delete_bill': return `delete bill ${str(a.bill) || 'in Zoho Books'}`;
    case 'zoho_books.void_payment': return `void payment ${str(a.payment) || 'in Zoho Books'}`;
    case 'zoho_books.record_payment': return `pay ${money(a.amount)} to ${str(a.vendor) || 'a vendor'}${a.bill ? ` against ${a.bill}` : ''}`;
    case 'zoho_books.create_bill': return `create a ${money(a.amount)} bill from ${str(a.vendor) || 'a vendor'}`;
    case 'zoho_books.create_vendor': return `create vendor ${str(a.name) || 'in Zoho Books'}`;
    case 'zoho_books.list_invoices': return `list ${str(a.status || a.type) || ''} invoices`.replace(/\s+/g, ' ');
    case 'gmail.send_email': {
      const to = a.to_domain ? `an address at ${a.to_domain}` : a.to ? str(a.to) : 'someone outside';
      return a.template ? `send the ${a.template} email to ${to}` : `send an email to ${to}`;
    }
    case 'gmail.create_draft': return `draft ${a.template ? `a ${a.template} email` : 'an email'}`;
    case 'gmail.read_inbox': return `read the ${str(a.folder) || 'shared'} inbox`;
    case 'platform.merge_pr': {
      const extra = [a.approvals === 0 ? 'no review' : '', a.checks === 'failing' ? 'failing checks' : ''].filter(Boolean);
      return `merge pull request #${str(a.pr)} into ${str(a.repo) || 'main'}${extra.length ? ` with ${extra.join(' and ')}` : ''}`;
    }
    case 'platform.deploy': return `deploy ${str(a.service)} ${str(a.version)} to ${str(a.environment) || 'production'}`.replace(/\s+/g, ' ');
    case 'platform.grant_access': return `give ${str(a.user) || 'someone'} ${str(a.role) || ''} access to ${str(a.repo) || 'a repository'}`.replace(/\s+/g, ' ');
    case 'platform.read_logs': return `read ${str(a.service) || 'service'} logs`;
    case 'bank.initiate_transfer': return `transfer ${money(a.amount)} from ${str(a.from_account)} to ${str(a.to_account)}`;
    case 'bank.get_balance': return `read the balance of ${str(a.account) || 'an account'}`;
    case 'procure.create_vendor': return `create vendor ${str(a.name) || 'in procurement'}${a.gstin_verified === 'false' || a.gstin_verified === false ? ' without a verified GSTIN' : ''}`;
    case 'procure.update_bank_details': return `change the bank account for ${str(a.vendor) || 'a vendor'}`;
    case 'procure.verify_gstin': return `check GSTIN ${str(a.gstin)}`;
    case 'hr.read_application': return `read job application ${str(a.application)}`.trim();
    case 'hr.send_candidate_email': return `send a ${str(a.template) || ''} email to a candidate`.replace(/\s+/g, ' ');
    default: {
      const def = toolByName(tool);
      if (def) return def.description.charAt(0).toLowerCase() + def.description.slice(1);
      return `call ${tool}`;
    }
  }
}

/** The approval headline in past tense: "invoice-bot wants to pay …" → "invoice-bot asked to pay …". */
function askedPhrase(headline: string) {
  return headline.replace(/^(\S+) wants to /, '$1 asked to ');
}

export function istStartOfDay(now = Date.now()) {
  const t = new Date(now + 5.5 * H);
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime() - 5.5 * H;
}

export interface NotDoneData {
  items: NotDoneItem[]; // newest first, last 21 days
  agents: { slug: string; status: string; pausedBy?: string; ownerId: string; route: string }[];
  stop: OrgDB['stop'];
  plan: string;
}

/** Builds the queue from the organisation's records. Pure: never mutates the store. */
export function deriveNotDone(d: OrgDB, now = Date.now()): NotDoneData {
  const since = now - RANGES['21d'].ms;
  const approvals = new Map(d.approvals.map((a) => [a.id, a]));
  const items: NotDoneItem[] = [];
  for (let i = d.receipts.length - 1; i >= 0; i--) {
    const r: Receipt = d.receipts[i];
    if (new Date(r.ts).getTime() < since) break;
    if (r.decision !== 'refuse' || (r.kind !== 'decision' && r.kind !== 'approval')) continue;
    const cls = refusalClassFull(r);
    if (!cls || !r.agent || !r.tool) continue;
    if (r.kind === 'decision') {
      items.push({
        key: String(r.seq), seq: r.seq, ts: r.ts, cls, agent: r.agent, tool: r.tool, ruleId: r.rule_id,
        attempt: `${r.agent} tried to ${actionPhrase(r.tool, r.args_summary)}`,
        reason: r.reason ?? '',
        stop: cls === 'paused' && /emergency stop/i.test(r.reason ?? ''),
      });
    } else {
      const a = r.approval ? approvals.get(r.approval.id) : undefined;
      items.push({
        key: String(r.seq), seq: r.seq, ts: r.ts, cls, agent: r.agent, tool: r.tool, ruleId: a?.ruleId,
        attempt: a ? askedPhrase(a.headline) : `${r.agent} asked to ${actionPhrase(r.tool)}`,
        reason: r.reason ?? a?.decisionReason ?? '',
        heldSeq: r.ref_seq ?? a?.seq,
        approval: a ? {
          id: a.id, status: a.status, approverGroup: a.approverGroup, createdAt: a.createdAt, expiresAt: a.expiresAt,
          decidedBy: a.decidedBy ?? r.approval?.approver, decisionReason: a.decisionReason, ruleId: a.ruleId, amount: a.amount, counterparty: a.counterparty,
          channel: a.channel ?? r.approval?.channel,
        } : undefined,
      });
    }
  }
  return {
    items,
    agents: d.agents.map((a) => ({ slug: a.slug, status: a.status, pausedBy: a.pausedBy, ownerId: a.ownerId, route: a.route })),
    stop: { ...d.stop },
    plan: d.org.plan,
  };
}

/** Groups repeats of the same attempt so the queue reads as patterns, not noise. Rejections stay one by one. */
export function clusterItems(items: NotDoneItem[]): NotDoneCluster[] {
  const map = new Map<string, NotDoneCluster>();
  for (const it of items) {
    const k = it.cls === 'rejected'
      ? `rejected|${it.seq}`
      : it.cls === 'paused'
        ? `paused|${it.agent}|${it.stop ? 'stop' : it.reason}`
        : `${it.cls}|${it.agent}|${it.tool}|${it.ruleId ?? ''}|${it.cls === 'invalid' ? it.reason : ''}`;
    const c = map.get(k);
    if (c) c.items.push(it);
    else map.set(k, { key: k, cls: it.cls, agent: it.agent, tool: it.tool, ruleId: it.ruleId, items: [it] });
  }
  return [...map.values()];
}
