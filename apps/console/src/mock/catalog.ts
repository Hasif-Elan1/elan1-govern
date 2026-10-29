import { stringify } from 'yaml';
import type { Agent, Connector, Rule, Rulebook, RulebookVersion, RuleSuggestion, RiskTag } from '@/types';
import { sha256Hex } from '@/lib/crypto';
import { APPROVER_GROUPS } from './users';

const daysAgo = (d: number, h = 0) => new Date(Date.now() - d * 86_400_000 - h * 3_600_000).toISOString();

/* ── Tools ────────────────────────────────────────────────── */

export interface ToolDef { name: string; description: string; tags: RiskTag[]; connector: string }

export const TOOLS: ToolDef[] = [
  { name: 'gmail.read_inbox', description: 'Read messages in the shared accounts-payable inbox', tags: ['reads_data', 'personal_data'], connector: 'con_gmail' },
  { name: 'gmail.create_draft', description: 'Create a draft reply', tags: ['writes_data'], connector: 'con_gmail' },
  { name: 'gmail.send_email', description: 'Send an email from the accounts-payable address', tags: ['sends_external'], connector: 'con_gmail' },
  { name: 'zoho_books.list_invoices', description: 'List invoices and bills', tags: ['reads_data'], connector: 'con_zoho' },
  { name: 'zoho_books.create_bill', description: 'Create a vendor bill', tags: ['writes_data'], connector: 'con_zoho' },
  { name: 'zoho_books.record_payment', description: 'Record a vendor payment against a bill', tags: ['moves_money', 'writes_data'], connector: 'con_zoho' },
  { name: 'zoho_books.delete_bill', description: 'Delete a bill', tags: ['deletes'], connector: 'con_zoho' },
  { name: 'zoho_books.create_vendor', description: 'Create a vendor record', tags: ['writes_data'], connector: 'con_zoho' },
  { name: 'procure.create_vendor', description: 'Create a vendor in the procurement master', tags: ['writes_data', 'personal_data'], connector: 'con_procure' },
  { name: 'procure.verify_gstin', description: 'Check a GSTIN against the public register', tags: ['reads_data'], connector: 'con_procure' },
  { name: 'procure.update_bank_details', description: 'Change a vendor bank account', tags: ['writes_data', 'personal_data', 'moves_money'], connector: 'con_procure' },
  { name: 'platform.read_logs', description: 'Read service logs', tags: ['reads_data'], connector: 'con_platform' },
  { name: 'platform.merge_pr', description: 'Merge a pull request to main', tags: ['changes_production'], connector: 'con_platform' },
  { name: 'platform.deploy', description: 'Deploy a service to production', tags: ['changes_production'], connector: 'con_platform' },
  { name: 'platform.grant_access', description: 'Grant a person access to a repository', tags: ['changes_access'], connector: 'con_platform' },
  { name: 'bank.get_balance', description: 'Read current account balances', tags: ['reads_data'], connector: 'con_bank' },
  { name: 'bank.initiate_transfer', description: 'Initiate an outbound bank transfer', tags: ['moves_money'], connector: 'con_bank' },
  { name: 'hr.read_application', description: 'Read a job application and CV', tags: ['reads_data', 'personal_data'], connector: 'con_hr' },
  { name: 'hr.send_candidate_email', description: 'Email a candidate', tags: ['sends_external', 'personal_data'], connector: 'con_hr' },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);

/* ── Connectors ───────────────────────────────────────────── */

function toolsFor(id: string, calls: Record<string, number> = {}) {
  return TOOLS.filter((t) => t.connector === id).map((t) => ({
    name: t.name, description: t.description, tags: t.tags, enabled: t.name !== 'zoho_books.delete_bill' || false, calls7d: calls[t.name] ?? 0,
  }));
}

export const CONNECTORS: Connector[] = [
  { id: 'con_gmail', kind: 'gmail', name: 'Gmail — ap@demotraders.in', status: 'demo', mode: 'demo', connectedAt: daysAgo(140), lastSyncAt: daysAgo(0, 1), tools: toolsFor('con_gmail'), heldCredential: true },
  { id: 'con_zoho', kind: 'zoho_books', name: 'Zoho Books — India data centre', status: 'demo', mode: 'demo', region: 'zoho.in', connectedAt: daysAgo(140), lastSyncAt: daysAgo(0, 1), tools: toolsFor('con_zoho'), heldCredential: true },
  { id: 'con_procure', kind: 'mcp_upstream', name: 'Procurement MCP', status: 'connected', mode: 'live', url: 'https://procure-mcp.demotraders.in/mcp', authHeader: 'Authorization: Bearer ••••••••3f2a', connectedAt: daysAgo(64), lastSyncAt: daysAgo(0, 3), tools: toolsFor('con_procure'), heldCredential: true },
  { id: 'con_platform', kind: 'mcp_upstream', name: 'Platform MCP (GitHub and deploy)', status: 'connected', mode: 'live', url: 'https://platform-mcp.internal.demotraders.in/mcp', authHeader: 'X-Api-Key: ••••••••91bd', connectedAt: daysAgo(41), lastSyncAt: daysAgo(0, 2), tools: toolsFor('con_platform'), heldCredential: true },
  { id: 'con_bank', kind: 'mcp_upstream', name: 'Treasury bank gateway MCP', status: 'connected', mode: 'live', url: 'https://bank-mcp.demotraders.in/mcp', authHeader: 'Authorization: Bearer ••••••••c7e0', connectedAt: daysAgo(22), lastSyncAt: daysAgo(0, 5), tools: toolsFor('con_bank'), heldCredential: true },
  { id: 'con_hr', kind: 'mcp_upstream', name: 'Recruiting MCP', status: 'error', mode: 'live', url: 'https://hr-mcp.demotraders.in/mcp', authHeader: 'Authorization: Bearer ••••••••0a14', connectedAt: daysAgo(12), lastSyncAt: daysAgo(2), tools: toolsFor('con_hr').map((t) => ({ ...t, enabled: false, suggestedTags: t.tags })), heldCredential: true },
];

/* ── Agents ───────────────────────────────────────────────── */

const key = (prefix: string, label: string, created: number, used?: number, env: 'sandbox' | 'production' = 'production') => ({
  id: 'key_' + prefix, prefix: (env === 'sandbox' ? 'sk_sbx_' : 'gk_') + prefix, label, createdAt: daysAgo(created), lastUsedAt: used !== undefined ? daysAgo(0, used) : undefined, environment: env,
});

export const AGENTS: Agent[] = [
  {
    id: 'ag_invoice', slug: 'invoice-bot', name: 'Invoice bot', description: 'Reads supplier invoices from the AP inbox, drafts bills in Zoho Books and records payments.',
    // technical owner is the admin, not a Finance approver: from L2 a person may not approve calls from an agent they own
    framework: 'Claude', route: 'mcp', status: 'active', ownerId: 'u_rahul', riskLevel: 'high', rulebookId: 'rb_invoice', aiSystemId: 'ai_invoice',
    connectorIds: ['con_gmail', 'con_zoho'], tools: ['gmail.read_inbox', 'gmail.send_email', 'zoho_books.list_invoices', 'zoho_books.create_bill', 'zoho_books.record_payment', 'zoho_books.delete_bill'],
    createdAt: daysAgo(138), keys: [key('7Kq2', 'Claude production', 90, 0), key('m1Px', 'Claude sandbox', 120, 30, 'sandbox')], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 },
  },
  {
    id: 'ag_collect', slug: 'collections-agent', name: 'Collections agent', description: 'Sends payment reminders for overdue receivables and logs promises to pay.',
    framework: 'LangChain', route: 'mcp', status: 'active', ownerId: 'u_rahul', riskLevel: 'medium', rulebookId: 'rb_collect', aiSystemId: 'ai_collect',
    connectorIds: ['con_gmail', 'con_zoho'], tools: ['zoho_books.list_invoices', 'gmail.send_email', 'gmail.create_draft'],
    createdAt: daysAgo(96), keys: [key('Ra9w', 'LangChain worker', 96, 0)], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 },
  },
  {
    id: 'ag_vendor', slug: 'vendor-onboarding', name: 'Vendor onboarding', description: 'Checks GSTIN and creates vendors in the procurement master. Bank changes need a person.',
    framework: 'OpenAI Agents SDK', route: 'rest', status: 'active', ownerId: 'u_rahul', riskLevel: 'high', rulebookId: 'rb_vendor', aiSystemId: 'ai_vendor',
    connectorIds: ['con_procure'], tools: ['procure.verify_gstin', 'procure.create_vendor', 'procure.update_bank_details'],
    createdAt: daysAgo(63), keys: [key('Vn4c', 'Procurement service', 63, 1)], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 },
  },
  {
    id: 'ag_devops', slug: 'devops-assistant', name: 'DevOps assistant', description: 'Reads logs, merges reviewed pull requests and deploys. Production changes are held for engineering.',
    framework: 'Cursor', route: 'mcp', status: 'active', ownerId: 'u_sanjay', riskLevel: 'high', rulebookId: 'rb_devops', aiSystemId: 'ai_devops',
    connectorIds: ['con_platform'], tools: ['platform.read_logs', 'platform.merge_pr', 'platform.deploy', 'platform.grant_access'],
    createdAt: daysAgo(40), keys: [key('Dx8t', 'Cursor team', 40, 0)], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 },
  },
  {
    id: 'ag_treasury', slug: 'treasury-sweeper', name: 'Treasury sweeper', description: 'Moves surplus cash between operating and deposit accounts within set limits.',
    framework: 'Claude', route: 'mcp', status: 'paused', pausedBy: 'auto-pause', ownerId: 'u_ananya', riskLevel: 'high', rulebookId: 'rb_treasury', aiSystemId: 'ai_treasury',
    connectorIds: ['con_bank'], tools: ['bank.get_balance', 'bank.initiate_transfer'],
    createdAt: daysAgo(21), keys: [key('Tr2s', 'Treasury runner', 21, 20)], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 },
  },
  {
    id: 'ag_expense', slug: 'expense-auditor', name: 'Expense auditor', description: 'Reviews employee expense claims against policy and drafts queries. Read-only.',
    framework: 'Claude', route: 'sdk', status: 'active', ownerId: 'u_fatima', riskLevel: 'low', rulebookId: 'rb_expense', aiSystemId: 'ai_expense',
    connectorIds: ['con_zoho', 'con_gmail'], tools: ['zoho_books.list_invoices', 'gmail.create_draft'],
    createdAt: daysAgo(55), keys: [key('Ex3a', 'Python SDK', 55, 2)], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 },
  },
  {
    id: 'ag_hr', slug: 'hr-screening', name: 'HR screening', description: 'Summarises applications for recruiters. Paused by its owner pending the impact assessment.',
    framework: 'Custom', route: 'sdk', status: 'paused', pausedBy: 'owner', ownerId: 'u_fatima', riskLevel: 'high', rulebookId: 'rb_hr', aiSystemId: 'ai_hr',
    connectorIds: ['con_hr'], tools: ['hr.read_application', 'hr.send_candidate_email'],
    createdAt: daysAgo(12), keys: [key('Hr6b', 'Screening service', 12, 50)], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 },
  },
];

export const agentBySlug = (slug?: string) => AGENTS.find((a) => a.slug === slug);

/* ── Rulebooks ────────────────────────────────────────────── */

export const VENDOR_DOMAINS = ['northwind.in', 'kalyanimetals.com', 'suryapack.in', 'bluedartlogistics.in', 'indigoprint.co.in'];

const RULES: Record<string, Rule[]> = {
  rb_invoice: [
    { id: 'read-ledger', match: { tag: 'reads_data' }, decide: 'allow', reason: 'Reading invoices and the AP inbox is routine.' },
    { id: 'draft-bills', match: { tool: 'zoho_books.create_bill' }, when: [{ field: 'amount', op: 'lte', value: 500000 }], decide: 'allow', reason: 'Bills up to ₹5,00,000 are drafted without a person.' },
    { id: 'pay-small', match: { tag: 'moves_money' }, when: [{ field: 'amount', op: 'lte', value: 50000 }, { field: 'vendor', op: 'in', value: ['approved_vendors'] }], decide: 'allow', reason: 'Small payments to approved vendors run within the daily cap.', quota: { kind: 'max_sum', field: 'amount', limit: 300000, window: 'day' } },
    { id: 'pay-large', match: { tag: 'moves_money' }, when: [{ field: 'amount', op: 'gt', value: 50000 }], decide: 'ask', approver: 'finance', reason: 'Payments over ₹50,000 need the finance controller.', expiresIn: '24h', approveInChat: false },
    { id: 'email-vendors', match: { tool: 'gmail.send_email' }, when: [{ field: 'to', op: 'to_domain_in', value: VENDOR_DOMAINS }], decide: 'allow', reason: 'Replies to known vendor domains are routine.' },
    { id: 'email-other', match: { tag: 'sends_external' }, unless: [{ field: 'to', op: 'to_domain_in', value: VENDOR_DOMAINS }], decide: 'ask', approver: 'finance', reason: 'Email to an unknown domain is checked by a person.', expiresIn: '4h', approveInChat: true },
    { id: 'no-deletes', match: { tag: 'deletes' }, decide: 'refuse', reason: 'Bills are cancelled by a person in Zoho Books, never deleted by an agent.' },
  ],
  rb_collect: [
    { id: 'read-receivables', match: { tool: 'zoho_books.list_invoices' }, decide: 'allow', reason: 'Reading receivables is routine.' },
    { id: 'drafts', match: { tool: 'gmail.create_draft' }, decide: 'allow', reason: 'Drafts are never sent.' },
    { id: 'reminders', match: { tool: 'gmail.send_email' }, when: [{ field: 'template', op: 'in', value: ['reminder_1', 'reminder_2'] }], decide: 'allow', reason: 'Approved reminder templates go out without a person.', quota: { kind: 'max_count', limit: 120, window: 'day' } },
    { id: 'final-notice', match: { tool: 'gmail.send_email' }, when: [{ field: 'template', op: 'eq', value: 'final_notice' }], decide: 'ask', approver: 'finance', reason: 'A final notice is a legal step; finance sends it.', expiresIn: '24h', approveInChat: true },
  ],
  rb_vendor: [
    { id: 'gstin-check', match: { tool: 'procure.verify_gstin' }, decide: 'allow', reason: 'Public register lookup.' },
    { id: 'create-vendor', match: { tool: 'procure.create_vendor' }, when: [{ field: 'gstin_verified', op: 'eq', value: 'true' }], decide: 'allow', reason: 'Vendors with a verified GSTIN are created directly.' },
    { id: 'unverified-vendor', match: { tool: 'procure.create_vendor' }, when: [{ field: 'gstin_verified', op: 'eq', value: 'false' }], decide: 'ask', approver: 'procurement', reason: 'A vendor without a verified GSTIN needs procurement.', expiresIn: '24h', approveInChat: true },
    { id: 'bank-change', match: { tool: 'procure.update_bank_details' }, decide: 'ask', approver: 'procurement', reason: 'Bank detail changes are the most common payment fraud route; a person confirms by phone.', expiresIn: '24h', approveInChat: false },
  ],
  rb_devops: [
    { id: 'logs', match: { tool: 'platform.read_logs' }, decide: 'allow', reason: 'Read-only.' },
    { id: 'merge-reviewed', match: { tool: 'platform.merge_pr' }, when: [{ field: 'approvals', op: 'gte', value: 1 }, { field: 'checks', op: 'eq', value: 'passing' }], decide: 'allow', reason: 'Reviewed pull requests with passing checks merge without a second gate.' },
    { id: 'deploy-prod', match: { tool: 'platform.deploy' }, decide: 'ask', approver: 'engineering', reason: 'Production changes are held for the on-call engineer.', expiresIn: '2h', approveInChat: false, unless: [{ field: 'window', op: 'eq', value: 'change_window' }] },
    { id: 'no-access-grants', match: { tag: 'changes_access' }, decide: 'refuse', reason: 'Access is granted through the identity team, not by an agent.' },
  ],
  rb_treasury: [
    { id: 'balances', match: { tool: 'bank.get_balance' }, decide: 'allow', reason: 'Read-only.' },
    { id: 'sweep', match: { tool: 'bank.initiate_transfer' }, when: [{ field: 'to_account', op: 'in', value: ['own_accounts'] }, { field: 'amount', op: 'lte', value: 2500000 }], decide: 'allow', reason: 'Sweeps between our own accounts up to ₹25 lakh.', quota: { kind: 'max_count', limit: 6, window: 'day' } },
    { id: 'external-transfer', match: { tool: 'bank.initiate_transfer' }, unless: [{ field: 'to_account', op: 'in', value: ['own_accounts'] }], decide: 'ask', approver: 'owners', reason: 'Any transfer outside our own accounts needs an owner.', expiresIn: '1h', approveInChat: false },
  ],
  rb_expense: [
    { id: 'read', match: { tag: 'reads_data' }, decide: 'allow', reason: 'Read-only review.' },
    { id: 'draft-queries', match: { tool: 'gmail.create_draft' }, decide: 'allow', reason: 'Drafts only; a person sends.' },
  ],
  rb_hr: [
    { id: 'read-cv', match: { tool: 'hr.read_application' }, decide: 'ask', approver: 'privacy', reason: 'Personal data in CVs is read only after the DPO approves the run.', expiresIn: '24h' },
    { id: 'no-candidate-email', match: { tool: 'hr.send_candidate_email' }, decide: 'refuse', reason: 'Candidates hear from a recruiter, never from an agent.' },
  ],
};

function ruleToYaml(r: Rule) {
  const o: Record<string, unknown> = { id: r.id };
  if (r.match.tool) o.tool = r.match.tool;
  if (r.match.tag) o.tag = r.match.tag;
  if (r.when?.length) o.when = Object.fromEntries(r.when.map((c) => [c.field, { [c.op]: c.value }]));
  if (r.unless?.length) o.unless = Object.fromEntries(r.unless.map((c) => [c.field, { [c.op]: c.value }]));
  o.decide = r.decide;
  if (r.approver) o.approver = r.approver;
  if (r.expiresIn) o.expires_in = r.expiresIn;
  if (r.approveInChat !== undefined) o.approve_in_chat = r.approveInChat;
  if (r.quota) o.quota = { [r.quota.kind]: r.quota.limit, ...(r.quota.field ? { field: r.quota.field } : {}), per: r.quota.window };
  // only simulate is written: a rule that decides needs no mode, so seeded rulebooks keep their hashes
  if (r.mode === 'simulate') o.mode = r.mode;
  o.reason = r.reason;
  return o;
}

export function rulebookYaml(agentSlug: string, version: number, owner: string, rules: Rule[], approvers: string[]): string {
  const doc = {
    version,
    agent: agentSlug,
    owner,
    default: 'refuse',
    approvers: Object.fromEntries(APPROVER_GROUPS.filter((g) => approvers.includes(g.id)).map((g) => [g.id, g.members])),
    lists: { approved_vendors: VENDOR_DOMAINS.map((d) => d.split('.')[0]), own_accounts: ['HDFC-OPS-0042', 'ICICI-FD-1180'] },
    rules: rules.map(ruleToYaml),
  };
  return `# Rulebook for ${agentSlug} — sealed on publish, verified on every call.\n# Anything no rule allows is refused.\n` + stringify(doc, { lineWidth: 0 });
}

function buildRulebook(id: string, agent: Agent, versions: { v: number; daysAgo: number; note: string; by: string; signer?: string; status?: RulebookVersion['status']; mutate?: (r: Rule[]) => Rule[] }[]): Rulebook {
  const base = RULES[id];
  const approvers = Array.from(new Set(base.map((r) => r.approver).filter(Boolean))) as string[];
  const vs: RulebookVersion[] = versions.map(({ v, daysAgo: d, note, by, signer, status, mutate }) => {
    const rules = mutate ? mutate(base) : base;
    const yaml = rulebookYaml(agent.slug, v, agent.ownerId, rules, approvers);
    return {
      version: v, status: status ?? 'published', hash: sha256Hex(yaml), createdBy: by, createdAt: daysAgo(d, 2), note, rules, yaml,
      signedBy: (status ?? 'published') === 'published' ? signer ?? by : undefined, signedAt: (status ?? 'published') === 'published' ? daysAgo(d) : undefined,
      reviewedBy: (status ?? 'published') === 'published' ? 'u_ananya' : undefined,
    };
  });
  const published = vs.filter((x) => x.status === 'published');
  return {
    id, slug: agent.slug, name: `${agent.name} rulebook`, agentId: agent.id, default: 'refuse',
    approverGroups: APPROVER_GROUPS.filter((g) => approvers.includes(g.id)),
    currentVersion: published[published.length - 1].version, versions: vs, updatedAt: vs[vs.length - 1].createdAt,
  };
}

const ag = (slug: string) => AGENTS.find((a) => a.slug === slug)!;

/** Before v7 there was no vendor-email rule: every external email, vendors included, was held. */
const withoutVendorEmail = (r: Rule[]) => r.filter((x) => x.id !== 'email-vendors').map((x) => { if (x.id !== 'email-other') return x; const { unless: _u, ...rest } = x; return rest; });

export const RULEBOOKS: Rulebook[] = [
  buildRulebook('rb_invoice', ag('invoice-bot'), [
    { v: 5, daysAgo: 80, note: 'First published version', by: 'u_rahul', mutate: (r) => withoutVendorEmail(r).filter((x) => x.id !== 'pay-small') },
    { v: 6, daysAgo: 41, note: 'Allow small payments to approved vendors', by: 'u_rahul', mutate: (r) => withoutVendorEmail(r) },
    { v: 7, daysAgo: 9, note: 'Allow replies to known vendor domains', by: 'u_rahul' },
    { v: 8, daysAgo: 0, note: 'Draft: raise the no-approval limit to ₹1,00,000 (from rule suggestion)', by: 'u_rahul', status: 'in_review',
      mutate: (r) => r.map((x) => x.id === 'pay-small' ? { ...x, when: [{ field: 'amount', op: 'lte', value: 100000 }, x.when![1]] } : x.id === 'pay-large' ? { ...x, when: [{ field: 'amount', op: 'gt', value: 100000 }], reason: 'Payments over ₹1,00,000 need the finance controller.' } : x) },
  ]),
  buildRulebook('rb_collect', ag('collections-agent'), [
    { v: 2, daysAgo: 90, note: 'First published version', by: 'u_rahul' },
    { v: 3, daysAgo: 20, note: 'Daily cap of 120 reminders', by: 'u_rahul' },
  ]),
  buildRulebook('rb_vendor', ag('vendor-onboarding'), [
    { v: 1, daysAgo: 60, note: 'First published version', by: 'u_arjun' },
    { v: 2, daysAgo: 15, note: 'Bank changes never approvable in chat', by: 'u_arjun' },
  ]),
  buildRulebook('rb_devops', ag('devops-assistant'), [
    { v: 1, daysAgo: 38, note: 'First published version', by: 'u_sanjay' },
    { v: 2, daysAgo: 6, note: 'Allow reviewed merges; refuse access grants', by: 'u_sanjay' },
    { v: 3, daysAgo: 1, note: 'Draft: deploys inside the change window run without a hold', by: 'u_sanjay', status: 'draft' },
  ]),
  buildRulebook('rb_treasury', ag('treasury-sweeper'), [{ v: 1, daysAgo: 20, note: 'First published version', by: 'u_ananya' }]),
  buildRulebook('rb_expense', ag('expense-auditor'), [{ v: 1, daysAgo: 54, note: 'Read-only review', by: 'u_fatima' }]),
  buildRulebook('rb_hr', ag('hr-screening'), [{ v: 1, daysAgo: 11, note: 'Personal data held for the DPO', by: 'u_fatima' }]),
];

export const rulebookById = (id?: string) => RULEBOOKS.find((r) => r.id === id);
export const rulebookBySlug = (slug?: string) => RULEBOOKS.find((r) => r.slug === slug);

export const SUGGESTIONS: RuleSuggestion[] = [
  {
    id: 'sug_1', rulebookId: 'rb_invoice', title: 'Raise the no-approval payment limit from ₹50,000 to ₹1,00,000',
    rationale: '41 payments between ₹50,000 and ₹1,00,000 to 6 approved vendors were approved in the last 30 days. None was rejected and none was reversed.',
    evidence: { approvals: 41, days: 30, counterparties: 6, rejections: 0 },
    proposed: { id: 'pay-small', match: { tag: 'moves_money' }, when: [{ field: 'amount', op: 'lte', value: 100000 }, { field: 'vendor', op: 'in', value: ['approved_vendors'] }], decide: 'allow', reason: 'Payments up to ₹1,00,000 to approved vendors.' },
    createdAt: daysAgo(1), status: 'drafted',
  },
  {
    id: 'sug_2', rulebookId: 'rb_vendor', title: 'Allow vendors whose GSTIN check returned "active" in the last 24 hours',
    rationale: '17 vendor creations held only because the GSTIN flag was set by an earlier call. All 17 were approved within 2 hours.',
    evidence: { approvals: 17, days: 30, counterparties: 17, rejections: 0 },
    proposed: { id: 'create-vendor-recent-check', match: { tool: 'procure.create_vendor' }, when: [{ field: 'gstin_checked_within', op: 'lte', value: 86400 }], decide: 'allow', reason: 'Recent GSTIN check counts as verified.' },
    createdAt: daysAgo(0, 4), status: 'open',
  },
  {
    id: 'sug_3', rulebookId: 'rb_collect', title: 'Allow final notices for invoices more than 90 days overdue',
    rationale: '12 final notices approved, 3 rejected. Rejections were all within 60 days overdue.',
    evidence: { approvals: 12, days: 30, counterparties: 12, rejections: 3 },
    proposed: { id: 'final-notice-90d', match: { tool: 'gmail.send_email' }, when: [{ field: 'template', op: 'eq', value: 'final_notice' }, { field: 'days_overdue', op: 'gt', value: 90 }], decide: 'allow', reason: 'Final notice after 90 days overdue.' },
    createdAt: daysAgo(3), status: 'open',
  },
];
