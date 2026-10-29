/**
 * Rulebook helpers used only by the rulebooks feature: wording, validation (the publish checks as
 * built), approve-in-chat restrictions, defaults for Try an action, and the Test on past actions headline.
 */
import type { Agent, ApproverGroup, Condition, ConditionOp, Decision, RiskTag, Rule, Rulebook, RulebookVersion } from '@/types';
import { semanticDiff, type ReplayResult } from '@/lib/evaluate';
import { TOOLS, type ToolDef } from '@/mock/catalog';
import { APPROVER_GROUPS } from '@/mock/users';
import { n, rupees, tagLabel } from '@/lib/format';

/* ── The organisation's tools and approver groups ─────────── */

/**
 * Tools the rulebook editor knows: the catalogue plus every tool discovered on the organisation's connectors
 * (including MCP servers added at runtime). Set by the editor for the organisation it shows.
 */
let toolRegistry: ToolDef[] = TOOLS;
let groupRegistry: ApproverGroup[] = APPROVER_GROUPS;

export function registerOrg(tools: ToolDef[], groups: ApproverGroup[]) {
  toolRegistry = tools.length ? tools : TOOLS;
  groupRegistry = groups.length ? groups : APPROVER_GROUPS;
}
export const allTools = () => toolRegistry;
export const toolByName = (name: string) => toolRegistry.find((t) => t.name === name);
export const orgGroups = () => groupRegistry;

/** Settings the builder writes into a rule's YAML that the core Rule shape does not carry. */
export const BUILDER_KEYS = ['escalate_to', 'escalate_after', 'requires_autonomy', 'pack', 'locked'];
export type RuleExtra = { escalate_to?: string; escalate_after?: string; requires_autonomy?: string; pack?: string; locked?: boolean };
export function builderExtra(x?: Record<string, unknown>): RuleExtra {
  if (!x) return {};
  return { escalate_to: typeof x.escalate_to === 'string' ? x.escalate_to : undefined, escalate_after: x.escalate_after !== undefined ? String(x.escalate_after) : undefined, requires_autonomy: typeof x.requires_autonomy === 'string' ? x.requires_autonomy : undefined, pack: typeof x.pack === 'string' ? x.pack : undefined, locked: x.locked === true };
}
/** true when a rule carries YAML settings the builder cannot show (anything other than the builder's own keys). */
export const hasForeignExtras = (x?: Record<string, unknown>) => !!x && Object.keys(x).some((k) => !BUILDER_KEYS.includes(k));

export const ALL_TAGS: RiskTag[] = ['reads_data', 'writes_data', 'moves_money', 'sends_external', 'personal_data', 'deletes', 'changes_access', 'changes_production'];

export const OPS: { value: ConditionOp; label: string; symbol: string; kind: 'number' | 'text' | 'list'; help: string }[] = [
  { value: 'eq', label: 'equals', symbol: '=', kind: 'text', help: 'The value equals this text (case-insensitive).' },
  { value: 'lt', label: 'less than', symbol: '<', kind: 'number', help: 'A number below this value.' },
  { value: 'lte', label: 'at most', symbol: '≤', kind: 'number', help: 'A number at or below this value.' },
  { value: 'gt', label: 'more than', symbol: '>', kind: 'number', help: 'A number above this value.' },
  { value: 'gte', label: 'at least', symbol: '≥', kind: 'number', help: 'A number at or above this value.' },
  { value: 'in', label: 'is one of', symbol: 'in', kind: 'list', help: 'One of these values, or a named list such as approved_vendors.' },
  { value: 'to_domain_in', label: 'goes to a domain in', symbol: 'to domain in', kind: 'list', help: 'The email address domain is one of these.' },
  { value: 'fields_include', label: 'includes the fields', symbol: 'has fields', kind: 'list', help: 'Every one of these argument names is present.' },
];
export const opMeta = (op: ConditionOp) => OPS.find((o) => o.value === op)!;
export const OP_VALUES = OPS.map((o) => o.value);

export const NAMED_LISTS: Record<string, string> = {
  approved_vendors: 'Approved vendors',
  own_accounts: 'Our own bank accounts',
};

export const EXPIRY_OPTIONS = ['30m', '1h', '2h', '4h', '8h', '24h', '3d', '7d', '30d'];
export const QUOTA_WINDOWS: { value: string; label: string }[] = [
  { value: '30m', label: 'per 30 minutes' },
  { value: '1h', label: 'per hour' },
  { value: 'day', label: 'per day' },
  { value: '7d', label: 'per 7 days' },
];
export const windowLabel = (w: string) => QUOTA_WINDOWS.find((x) => x.value === w)?.label ?? `per ${w}`;

export const OUTCOME: Record<Decision, { label: string; short: string; tone: 'ok' | 'held' | 'bad'; edge: string }> = {
  allow: { label: 'Allow', short: 'Allow', tone: 'ok', edge: 'border-l-ok' },
  ask: { label: 'Ask a person', short: 'Ask', tone: 'held', edge: 'border-l-held' },
  refuse: { label: 'Refuse', short: 'Refuse', tone: 'bad', edge: 'border-l-bad' },
};

export const groupName = (id?: string) => groupRegistry.find((g) => g.id === id)?.name ?? id ?? '—';

/* ── Versions ─────────────────────────────────────────────── */

export const publishedOf = (rb: Rulebook): RulebookVersion | undefined => rb.versions.find((v) => v.version === rb.currentVersion && v.status === 'published') ?? rb.versions.filter((v) => v.status === 'published').slice(-1)[0];
export const draftOf = (rb: Rulebook): RulebookVersion | undefined => rb.versions.find((v) => v.status !== 'published');
export const nextVersionNo = (rb: Rulebook) => draftOf(rb)?.version ?? Math.max(...rb.versions.map((v) => v.version)) + 1;
export const statusLabel = (s: RulebookVersion['status']) => ({ published: 'Published', draft: 'Draft', in_review: 'In review' })[s];

/* ── Rule reach and wording ───────────────────────────────── */

/** Tools a rule reaches. Tag rules reach every tool carrying the tag; limited to the agent's tools when given. */
export function toolsForRule(rule: Rule, agentTools?: string[]): ToolDef[] {
  const pool = agentTools?.length ? toolRegistry.filter((t) => agentTools.includes(t.name)) : toolRegistry;
  if (rule.match.tool) {
    const t = toolByName(rule.match.tool);
    return t ? [t] : [];
  }
  if (rule.match.tag) return pool.filter((t) => t.tags.includes(rule.match.tag!));
  return [];
}

export const isAmountField = (f: string) => /amount|sum|value|total/i.test(f);

export function formatValue(c: Condition): string {
  if (Array.isArray(c.value)) return c.value.map((v) => NAMED_LISTS[v] ? `${v}` : v).join(', ');
  if (typeof c.value === 'number' && isAmountField(c.field)) return rupees(c.value);
  if (typeof c.value === 'number') return n(c.value);
  return String(c.value);
}

export function conditionText(c: Condition): string {
  const m = opMeta(c.op);
  return `${c.field} ${m?.symbol ?? c.op} ${formatValue(c)}`;
}

export function quotaText(q: NonNullable<Rule['quota']>): string {
  if (q.kind === 'max_sum') return `At most ${isAmountField(q.field ?? 'amount') ? rupees(q.limit) : n(q.limit)} of ${q.field ?? 'amount'} ${windowLabel(q.window)}`;
  return `At most ${n(q.limit)} calls ${windowLabel(q.window)}`;
}

export function hasUpperAmount(rule: Rule): boolean {
  return !!rule.when?.some((c) => isAmountField(c.field) && (c.op === 'lt' || c.op === 'lte'));
}

const CHAT_SENSITIVE: RiskTag[] = ['deletes', 'changes_access', 'changes_production', 'personal_data'];

/** Why approve-in-chat cannot be enabled for this rule (as built: checked again on publish). */
export function chatBlockReason(rule: Rule, agentTools?: string[]): string | undefined {
  const tags = new Set<RiskTag>(toolsForRule(rule, agentTools).flatMap((t) => t.tags));
  if (rule.match.tag) tags.add(rule.match.tag);
  const hit = CHAT_SENSITIVE.find((t) => tags.has(t));
  if (hit) return `This rule reaches tools tagged “${tagLabel[hit]}”. Those are decided in the console or by a signed email link, which asks for a password — never by a chat button.`;
  if (tags.has('moves_money') && !hasUpperAmount(rule)) return 'This rule moves money with no upper amount. Add a condition such as amount ≤ ₹1,00,000 before a chat button can approve it.';
  return undefined;
}

const expiryMs = (s: string) => {
  const m = /^(\d+)\s*(m|h|d)$/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * { m: 6e4, h: 3.6e6, d: 864e5 }[m[2] as 'm' | 'h' | 'd'];
};

/* ── Canonical form (for change detection and test freshness) ─ */

export function normRule(r: Rule): Rule {
  const c = (xs?: Condition[]) => (xs?.length ? xs.map((x) => ({ field: x.field, op: x.op, value: x.value })) : undefined);
  const out: Rule = { id: r.id, match: r.match.tool ? { tool: r.match.tool } : { tag: r.match.tag }, decide: r.decide, reason: r.reason };
  const w = c(r.when); if (w) out.when = w;
  const u = c(r.unless); if (u) out.unless = u;
  if (r.approver) out.approver = r.approver;
  if (r.expiresIn) out.expiresIn = r.expiresIn;
  if (r.approveInChat !== undefined) out.approveInChat = r.approveInChat;
  if (r.quota) out.quota = { kind: r.quota.kind, ...(r.quota.field ? { field: r.quota.field } : {}), limit: r.quota.limit, window: r.quota.window };
  if (r.mode) out.mode = r.mode;
  return out;
}
export const rulesKey = (rules: Rule[]) => JSON.stringify(rules.map(normRule));

/**
 * semanticDiff on canonical rules, so key order from YAML parsing never reads as a change.
 * Threshold moves are re-judged by direction: raising "amount > X" on an ask rule holds fewer calls,
 * so it is looser, not tighter (the shared helper looks only at whether the number went up).
 */
export function semDiff(before: Rule[], after: Rule[]) {
  const b = before.map(normRule);
  const a = after.map(normRule);
  return semanticDiff(b, a).map((d) => {
    if (d.change !== 'tighter' && d.change !== 'looser') return d;
    const old = b.find((r) => r.id === d.id);
    const cur = a.find((r) => r.id === d.id);
    if (!old || !cur || old.decide !== cur.decide) return d;
    const on = old.when?.find((c) => typeof c.value === 'number');
    const nn = cur.when?.find((c) => typeof c.value === 'number' && c.field === on?.field);
    if (!on || !nn) return d;
    const raised = Number(nn.value) > Number(on.value);
    const lowerBound = nn.op === 'gt' || nn.op === 'gte';
    const widens = lowerBound ? !raised : raised; // does the condition now match more calls?
    const looser = cur.decide === 'allow' ? widens : !widens;
    return { ...d, change: looser ? ('looser' as const) : ('tighter' as const) };
  });
}

/* ── Validation: the publish checks ───────────────────────── */

export interface Problem { level: 'error' | 'warning'; ruleId?: string; text: string; line?: number }

export function validateRules(rules: Rule[], agent?: Agent, ruleExtras: Record<string, Record<string, unknown>> = {}): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    const bx = builderExtra(ruleExtras[r.id]);
    if (bx.escalate_to) {
      const g = groupRegistry.find((x) => x.id === bx.escalate_to);
      if (r.decide !== 'ask') out.push({ level: 'error', ruleId: r.id, text: `${r.id}: escalate_to applies to ask rules only.` });
      else if (!g) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: backup group “${bx.escalate_to}” does not exist.` });
      else if (!g.members.length) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: backup group ${g.name} has no members.` });
      else if (g.id === r.approver) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: the backup group must be different from the approver group.` });
      if (!bx.escalate_after || !/^(\d{1,3}%|\d+\s*(m|h|d))$/.test(bx.escalate_after.trim())) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: escalate_after needs a share of the window such as 50% or a time such as 2h.` });
    }
    if (bx.requires_autonomy && !/^A[0-5]$/.test(bx.requires_autonomy)) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: requires_autonomy must be A0 to A5.` });
    if (!r.id.trim()) out.push({ level: 'error', text: 'A rule has no id.' });
    if (seen.has(r.id)) out.push({ level: 'error', ruleId: r.id, text: `Two rules share the id “${r.id}”. Ids must be unique.` });
    seen.add(r.id);
    if (!r.match.tool && !r.match.tag) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: choose a tool or a risk tag to match.` });
    if (r.match.tool && !toolByName(r.match.tool)) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: “${r.match.tool}” is not a known tool. Tool names are checked strictly.` });
    else if (r.match.tool && agent && !agent.tools.includes(r.match.tool)) out.push({ level: 'warning', ruleId: r.id, text: `${r.id}: ${agent.slug} does not use ${r.match.tool} today, so this rule never applies.` });
    if (!r.reason?.trim()) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: write a reason. It is shown to approvers and recorded on every receipt.` });
    if (r.decide === 'ask' && !r.approver) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: an ask rule needs an approver group.` });
    if (r.decide === 'ask' && r.approver) {
      const g = groupRegistry.find((x) => x.id === r.approver);
      if (!g) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: approver group “${r.approver}” does not exist in this organisation.` });
      else if (!g.members.length) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: approver group ${g.name} has no members, so nobody could decide.` });
      else if (g.members.length === 1) out.push({ level: 'warning', ruleId: r.id, text: `${r.id}: approver group ${g.name} has one member. Add a backup group so held calls do not wait on one person.` });
    }
    if (r.decide !== 'ask' && r.unless?.length) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: “unless” exceptions apply to ask rules only.` });
    if (r.decide === 'ask' && r.expiresIn && !(expiryMs(r.expiresIn) <= 30 * 864e5)) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: expiry “${r.expiresIn}” is not valid. Use up to 30d.` });
    if (r.approveInChat) {
      const why = chatBlockReason(r, agent?.tools);
      if (why) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: approve in chat is not allowed. ${why}` });
    }
    if (r.quota?.kind === 'max_sum' && !r.quota.field) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: a sum quota needs the field it adds up, such as amount.` });
    if (r.quota && !(r.quota.limit > 0)) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: the quota limit must be above zero.` });
    for (const c of [...(r.when ?? []), ...(r.unless ?? [])]) {
      if (!c.field.trim()) out.push({ level: 'error', ruleId: r.id, text: `${r.id}: a condition has no field.` });
      if (['lt', 'lte', 'gt', 'gte'].includes(c.op) && typeof c.value !== 'number') out.push({ level: 'error', ruleId: r.id, text: `${r.id}: ${c.field} ${c.op} needs a number.` });
    }
  }
  if (agent?.riskLevel === 'high') {
    const high = ['moves_money', 'deletes', 'changes_access', 'changes_production'] as RiskTag[];
    const agentTags = new Set(toolRegistry.filter((t) => agent.tools.includes(t.name)).flatMap((t) => t.tags));
    for (const tag of high.filter((t) => agentTags.has(t))) {
      const covered = rules.some((r) => r.decide !== 'allow' && toolsForRule(r, agent.tools).some((t) => t.tags.includes(tag)));
      if (!covered) out.push({ level: 'error', text: `${agent.slug} is high risk and its tools can “${tagLabel[tag]}”, but no rule asks a person or refuses for those tools.` });
    }
  }
  if (rules.length && !rules.some((r) => r.decide === 'allow')) out.push({ level: 'warning', text: 'No rule allows anything. Every call will be held or refused.' });
  if (!rules.length) out.push({ level: 'warning', text: 'The rulebook has no rules. Every call will be refused by the default.' });
  return out;
}

/* ── Try an action defaults ───────────────────────────────── */

export const DEFAULT_ARGS: Record<string, Record<string, string>> = {
  'zoho_books.record_payment': { amount: '75000', vendor: 'Northwind Traders', bill_id: 'BILL-2291' },
  'zoho_books.create_bill': { amount: '180000', vendor: 'Kalyani Metals', due_in_days: '30' },
  'zoho_books.list_invoices': { status: 'unpaid' },
  'zoho_books.delete_bill': { bill_id: 'BILL-2291' },
  'zoho_books.create_vendor': { name: 'Surya Packaging' },
  'gmail.send_email': { to: 'accounts@northwind.in', subject: 'Payment advice', template: 'reminder_1' },
  'gmail.read_inbox': { folder: 'ap' },
  'gmail.create_draft': { to: 'accounts@northwind.in', subject: 'Query on claim' },
  'procure.create_vendor': { name: 'Indigo Print Works', gstin_verified: 'true' },
  'procure.verify_gstin': { gstin: '29ABCDE1234F1Z5' },
  'procure.update_bank_details': { vendor: 'Northwind Traders', account: 'XXXX4521' },
  'platform.read_logs': { service: 'payments-api' },
  'platform.merge_pr': { pr: '1842', approvals: '1', checks: 'passing' },
  'platform.deploy': { service: 'payments-api', window: 'change_window' },
  'platform.grant_access': { user: 'contractor@example.com', repo: 'payments-api' },
  'bank.get_balance': { account: 'HDFC-OPS-0042' },
  'bank.initiate_transfer': { amount: '1500000', to_account: 'ICICI-FD-1180' },
  'hr.read_application': { application_id: 'APP-311' },
  'hr.send_candidate_email': { to: 'candidate@example.com', subject: 'Interview' },
};

export const FIELD_SUGGESTIONS = Array.from(new Set(['amount', 'vendor', 'to', 'template', 'to_account', 'approvals', 'checks', 'window', 'gstin_verified', 'days_overdue', ...Object.values(DEFAULT_ARGS).flatMap((a) => Object.keys(a))]));

/** "75000" → 75000; everything else stays text, exactly as an agent would send it. */
export function coerce(v: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : v;
}

/* ── Test on past actions headline (memo wording) ─────────── */

export function replayHeadline(r: ReplayResult): string {
  const c = r.counts;
  const parts: string[] = [];
  if (c.moreRefused) parts.push(`${n(c.moreRefused)} more would be refused`);
  if (c.moreAsk) parts.push(`${n(c.moreAsk)} more would ask a person`);
  if (c.fewerAsk) parts.push(`${n(c.fewerAsk)} fewer would ask a person`);
  if (c.fewerRefused) parts.push(`${n(c.fewerRefused)} fewer would be refused`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  const head = parts.length ? `Of ${n(r.total)} ${r.total === 1 ? 'call' : 'calls'}, ${list}.` : `Of ${n(r.total)} ${r.total === 1 ? 'call' : 'calls'}, none would change.`;
  return r.unjudged ? `${head} ${n(r.unjudged)} could not be judged.` : head;
}

export function diffSummary(d: { change: string }[]): string {
  if (!d.length) return 'No changes';
  const order = ['added', 'removed', 'tighter', 'looser', 'changed'];
  const counts = order.map((k) => [k, d.filter((x) => x.change === k).length] as const).filter(([, c]) => c > 0);
  return counts.map(([k, c]) => `${c} ${k}`).join(', ');
}
