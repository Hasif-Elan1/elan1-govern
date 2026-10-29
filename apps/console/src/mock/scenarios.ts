import type { Decision, RiskTag } from '@/types';
import { makeRand } from '@/lib/prng';

type Rand = ReturnType<typeof makeRand>;

export interface Call {
  tool: string;
  args: Record<string, string | number | boolean>;
  decision: Decision;
  ruleId: string;
  reason: string;
  tags: RiskTag[];
  connector: string;
  // for ask decisions
  approverGroup?: string;
  headline?: string;
  effect?: string;
  triggeredBy?: string;
  amount?: number;
  counterparty?: string;
  approveInChat?: boolean;
  expiresInH?: number;
  approveP?: number; // probability the held call is approved
}

export interface Scenario {
  weight: number;
  make: (r: Rand, agent: string) => Call;
  offHours?: boolean;
}

export const VENDORS = [
  { name: 'Northwind Traders', domain: 'northwind.in' },
  { name: 'Kalyani Metals', domain: 'kalyanimetals.com' },
  { name: 'Surya Packaging', domain: 'suryapack.in' },
  { name: 'Blue Dart Logistics', domain: 'bluedartlogistics.in' },
  { name: 'Indigo Print Works', domain: 'indigoprint.co.in' },
  { name: 'Shakti Chemicals', domain: 'shaktichem.in' },
];

const CUSTOMERS = ['Prakash Retail', 'Lotus Home Stores', 'Coastal Hardware', 'Meridian Foods', 'Vastra Fabrics', 'Green Leaf Organics', 'Hill Country Traders'];

const inv = (r: Rand) => `INV-${r.int(2100, 2399)}`;
const bill = (r: Rand) => `BILL-${r.int(8800, 9400)}`;
const fmt = (n: number) => '₹' + new Intl.NumberFormat('en-IN').format(n);
const round = (n: number, to = 100) => Math.round(n / to) * to;

export const SCENARIOS: Record<string, Scenario[]> = {
  'invoice-bot': [
    { weight: 24, make: (r) => ({ tool: 'gmail.read_inbox', args: { folder: 'AP/Inbox', unread: r.int(1, 14) }, decision: 'allow', ruleId: 'read-ledger', reason: 'Reading invoices and the AP inbox is routine.', tags: ['reads_data', 'personal_data'], connector: 'Gmail' }) },
    { weight: 18, make: (r) => ({ tool: 'zoho_books.list_invoices', args: { status: r.pick(['open', 'overdue', 'unpaid']), page: r.int(1, 4) }, decision: 'allow', ruleId: 'read-ledger', reason: 'Reading invoices and the AP inbox is routine.', tags: ['reads_data'], connector: 'Zoho Books' }) },
    { weight: 15, make: (r) => { const v = r.pick(VENDORS); const a = round(r.int(8000, 480000)); return { tool: 'zoho_books.create_bill', args: { vendor: v.name, amount: a, currency: 'INR', bill: bill(r) }, decision: 'allow', ruleId: 'draft-bills', reason: 'Bills up to ₹5,00,000 are drafted without a person.', tags: ['writes_data'], connector: 'Zoho Books', amount: a, counterparty: v.name }; } },
    { weight: 12, make: (r) => { const v = r.pick(VENDORS.slice(0, 5)); const a = round(r.int(4000, 50000)); return { tool: 'zoho_books.record_payment', args: { vendor: v.name, amount: a, bill: bill(r), mode: 'NEFT' }, decision: 'allow', ruleId: 'pay-small', reason: 'Small payments to approved vendors run within the daily cap.', tags: ['moves_money', 'writes_data'], connector: 'Zoho Books', amount: a, counterparty: v.name }; } },
    { weight: 6, make: (r) => { const v = r.pick(VENDORS.slice(0, 5)); const a = round(r.weighted([[r.int(50100, 100000), 6], [r.int(100000, 400000), 3], [r.int(400000, 900000), 1]] as const)); const b = bill(r); return { tool: 'zoho_books.record_payment', args: { vendor: v.name, amount: a, bill: b, mode: 'RTGS' }, decision: 'ask', ruleId: 'pay-large', reason: 'Payments over ₹50,000 need the finance controller.', tags: ['moves_money', 'writes_data'], connector: 'Zoho Books', approverGroup: 'finance', headline: `invoice-bot wants to pay ${fmt(a)} to ${v.name}`, effect: `Records an RTGS payment of ${fmt(a)} against ${b} in Zoho Books. The bank file is released in the 16:00 batch.`, triggeredBy: `amount ${fmt(a)} is over the ₹50,000 limit`, amount: a, counterparty: v.name, approveInChat: false, expiresInH: 24, approveP: 0.86 }; } },
    { weight: 8, make: (r) => { const v = r.pick(VENDORS.slice(0, 5)); return { tool: 'gmail.send_email', args: { to: `accounts@${v.domain}`, subject: `Remittance advice ${bill(r)}`, attachments: 1 }, decision: 'allow', ruleId: 'email-vendors', reason: 'Replies to known vendor domains are routine.', tags: ['sends_external'], connector: 'Gmail', counterparty: v.name }; } },
    { weight: 1.6, make: (r) => { const d = r.pick(['apexglobal-trading.ae', 'gmail.com', 'outlook.com', 'kalyani-metals.co']); return { tool: 'gmail.send_email', args: { to: `billing@${d}`, subject: 'Re: Updated bank details for payment', attachments: 0 }, decision: 'ask', ruleId: 'email-other', reason: 'Email to an unknown domain is checked by a person.', tags: ['sends_external'], connector: 'Gmail', approverGroup: 'finance', headline: `invoice-bot wants to email billing@${d}`, effect: `Sends a reply from ap@demotraders.in to billing@${d}. The domain is not on the approved vendor list.`, triggeredBy: `${d} is not an approved vendor domain`, counterparty: d, approveInChat: true, expiresInH: 4, approveP: 0.35 }; } },
    { weight: 0.8, make: (r) => ({ tool: 'zoho_books.delete_bill', args: { bill: bill(r), reason: 'duplicate' }, decision: 'refuse', ruleId: 'no-deletes', reason: 'Bills are cancelled by a person in Zoho Books, never deleted by an agent.', tags: ['deletes'], connector: 'Zoho Books' }) },
    { weight: 0.5, make: (r) => ({ tool: 'zoho_books.void_payment', args: { payment: `PAY-${r.int(5000, 5600)}` }, decision: 'refuse', ruleId: 'default', reason: 'No rule allows this tool. Anything not explicitly allowed is refused.', tags: [], connector: 'Zoho Books' }) },
  ],
  'collections-agent': [
    { weight: 14, make: (r) => ({ tool: 'zoho_books.list_invoices', args: { status: 'overdue', older_than_days: r.pick([15, 30, 45, 60]) }, decision: 'allow', ruleId: 'read-receivables', reason: 'Reading receivables is routine.', tags: ['reads_data'], connector: 'Zoho Books' }) },
    { weight: 16, make: (r) => { const c = r.pick(CUSTOMERS); return { tool: 'gmail.send_email', args: { to: `accounts@${c.toLowerCase().replace(/\s+/g, '')}.in`, template: r.pick(['reminder_1', 'reminder_2']), invoice: inv(r) }, decision: 'allow', ruleId: 'reminders', reason: 'Approved reminder templates go out without a person.', tags: ['sends_external'], connector: 'Gmail', counterparty: c }; } },
    { weight: 5, make: (r) => ({ tool: 'gmail.create_draft', args: { template: 'promise_to_pay_ack', invoice: inv(r) }, decision: 'allow', ruleId: 'drafts', reason: 'Drafts are never sent.', tags: ['writes_data'], connector: 'Gmail' }) },
    { weight: 1.4, make: (r) => { const c = r.pick(CUSTOMERS); const a = round(r.int(60000, 900000)); const i = inv(r); return { tool: 'gmail.send_email', args: { to: `accounts@${c.toLowerCase().replace(/\s+/g, '')}.in`, template: 'final_notice', invoice: i, amount_due: a, days_overdue: r.int(45, 140) }, decision: 'ask', ruleId: 'final-notice', reason: 'A final notice is a legal step; finance sends it.', tags: ['sends_external'], connector: 'Gmail', approverGroup: 'finance', headline: `collections-agent wants to send a final notice to ${c}`, effect: `Emails the final-notice template for ${i} (${fmt(a)} due) to ${c}. It states that the account may be referred for recovery.`, triggeredBy: 'template is final_notice', amount: a, counterparty: c, approveInChat: true, expiresInH: 24, approveP: 0.8 }; } },
    { weight: 0.4, make: (_r) => ({ tool: 'gmail.send_email', args: { to: 'accounts@prakashretail.in', template: 'reminder_3_custom' }, decision: 'refuse', ruleId: 'invalid-arguments', reason: 'template must be one of reminder_1, reminder_2, final_notice.', tags: ['sends_external'], connector: 'Gmail' }) },
  ],
  'vendor-onboarding': [
    { weight: 8, make: (r) => ({ tool: 'procure.verify_gstin', args: { gstin: `29AAB${'CDEFGHJK'[r.int(0, 7)]}${r.int(1000, 9999)}K1Z${r.int(1, 9)}` }, decision: 'allow', ruleId: 'gstin-check', reason: 'Public register lookup.', tags: ['reads_data'], connector: 'Procurement MCP' }) },
    { weight: 4, make: (r) => { const v = r.pick(['Deccan Fasteners', 'Malabar Spices Export', 'Konkan Cold Chain', 'Orbit Office Supplies', 'Sahyadri Freight']); return { tool: 'procure.create_vendor', args: { name: v, gstin_verified: 'true', state: r.pick(['KA', 'MH', 'TN', 'KL']) }, decision: 'allow', ruleId: 'create-vendor', reason: 'Vendors with a verified GSTIN are created directly.', tags: ['writes_data', 'personal_data'], connector: 'Procurement MCP', counterparty: v }; } },
    { weight: 1.2, make: (r) => { const v = r.pick(['Apex Global Trading FZE', 'Sunrise Imports', 'Metro Scrap Dealers']); return { tool: 'procure.create_vendor', args: { name: v, gstin_verified: 'false', country: v.includes('FZE') ? 'AE' : 'IN' }, decision: 'ask', ruleId: 'unverified-vendor', reason: 'A vendor without a verified GSTIN needs procurement.', tags: ['writes_data', 'personal_data'], connector: 'Procurement MCP', approverGroup: 'procurement', headline: `vendor-onboarding wants to create vendor ${v}`, effect: `Creates ${v} in the procurement master without a verified GSTIN. Bills can be raised against it once it exists.`, triggeredBy: 'gstin_verified is false', counterparty: v, approveInChat: true, expiresInH: 24, approveP: 0.6 }; } },
    { weight: 0.9, make: (r) => { const v = r.pick(VENDORS); return { tool: 'procure.update_bank_details', args: { vendor: v.name, ifsc: `HDFC000${r.int(1000, 9999)}`, account_last4: String(r.int(1000, 9999)) }, decision: 'ask', ruleId: 'bank-change', reason: 'Bank detail changes are the most common payment fraud route; a person confirms by phone.', tags: ['writes_data', 'personal_data', 'moves_money'], connector: 'Procurement MCP', approverGroup: 'procurement', headline: `vendor-onboarding wants to change the bank account for ${v.name}`, effect: `Replaces the bank account used for every future payment to ${v.name}. Confirm by phone with a contact you already hold.`, triggeredBy: 'every bank detail change is held', counterparty: v.name, approveInChat: false, expiresInH: 24, approveP: 0.55 }; } },
  ],
  'devops-assistant': [
    { weight: 12, make: (r) => ({ tool: 'platform.read_logs', args: { service: r.pick(['billing-api', 'web', 'ledger-sync', 'notifier']), since: '1h' }, decision: 'allow', ruleId: 'logs', reason: 'Read-only.', tags: ['reads_data'], connector: 'Platform MCP' }) },
    { weight: 4, make: (r) => ({ tool: 'platform.merge_pr', args: { repo: r.pick(['billing-api', 'web']), pr: r.int(1400, 1700), approvals: r.int(1, 2), checks: 'passing' }, decision: 'allow', ruleId: 'merge-reviewed', reason: 'Reviewed pull requests with passing checks merge without a second gate.', tags: ['changes_production'], connector: 'Platform MCP' }) },
    { weight: 0.8, make: (r) => ({ tool: 'platform.merge_pr', args: { repo: 'billing-api', pr: r.int(1400, 1700), approvals: 0, checks: 'failing' }, decision: 'refuse', ruleId: 'default', reason: 'No rule allows this call. Anything not explicitly allowed is refused.', tags: ['changes_production'], connector: 'Platform MCP' }) },
    { weight: 1.6, make: (r) => { const s = r.pick(['billing-api', 'web', 'ledger-sync']); const v = `v${r.int(3, 4)}.${r.int(0, 19)}.${r.int(0, 9)}`; return { tool: 'platform.deploy', args: { service: s, version: v, environment: 'production' }, decision: 'ask', ruleId: 'deploy-prod', reason: 'Production changes are held for the on-call engineer.', tags: ['changes_production'], connector: 'Platform MCP', approverGroup: 'engineering', headline: `devops-assistant wants to deploy ${s} ${v} to production`, effect: `Rolls ${s} ${v} out to production. Rollback is one command and is recorded.`, triggeredBy: 'environment is production, outside the change window', approveInChat: false, expiresInH: 2, approveP: 0.82 }; } },
    { weight: 0.4, make: (r) => ({ tool: 'platform.grant_access', args: { user: r.pick(['contractor-ext-17', 'intern-04']), repo: 'billing-api', role: 'write' }, decision: 'refuse', ruleId: 'no-access-grants', reason: 'Access is granted through the identity team, not by an agent.', tags: ['changes_access'], connector: 'Platform MCP' }) },
  ],
  'treasury-sweeper': [
    { weight: 6, make: (r) => ({ tool: 'bank.get_balance', args: { account: r.pick(['HDFC-OPS-0042', 'ICICI-FD-1180']) }, decision: 'allow', ruleId: 'balances', reason: 'Read-only.', tags: ['reads_data'], connector: 'Treasury bank gateway' }) },
    { weight: 2, make: (r) => { const a = round(r.int(200000, 2400000), 10000); return { tool: 'bank.initiate_transfer', args: { from_account: 'HDFC-OPS-0042', to_account: 'ICICI-FD-1180', amount: a }, decision: 'allow', ruleId: 'sweep', reason: 'Sweeps between our own accounts up to ₹25 lakh.', tags: ['moves_money'], connector: 'Treasury bank gateway', amount: a }; } },
    { weight: 0.4, make: (r) => { const a = round(r.int(300000, 1800000), 10000); return { tool: 'bank.initiate_transfer', args: { from_account: 'HDFC-OPS-0042', to_account: 'EXT-SBIN-7781', amount: a }, decision: 'ask', ruleId: 'external-transfer', reason: 'Any transfer outside our own accounts needs an owner.', tags: ['moves_money'], connector: 'Treasury bank gateway', approverGroup: 'owners', headline: `treasury-sweeper wants to transfer ${fmt(a)} to an external account`, effect: `Initiates a transfer of ${fmt(a)} from HDFC-OPS-0042 to SBIN account ending 7781, which is not one of our own accounts.`, triggeredBy: 'to_account is not in own_accounts', amount: a, approveInChat: false, expiresInH: 1, approveP: 0.2 }; } },
  ],
  'expense-auditor': [
    { weight: 10, make: (r) => ({ tool: 'zoho_books.list_invoices', args: { type: 'expense_claims', month: r.pick(['2026-09', '2026-10']) }, decision: 'allow', ruleId: 'read', reason: 'Read-only review.', tags: ['reads_data'], connector: 'Zoho Books' }) },
    { weight: 3, make: (r) => ({ tool: 'gmail.create_draft', args: { template: 'expense_query', claim: `EXP-${r.int(700, 999)}` }, decision: 'allow', ruleId: 'draft-queries', reason: 'Drafts only; a person sends.', tags: ['writes_data'], connector: 'Gmail' }) },
    { weight: 0.3, make: () => ({ tool: 'gmail.send_email', args: { to: 'employee@demotraders.in', template: 'expense_query' }, decision: 'refuse', ruleId: 'default', reason: 'No rule allows this tool. Anything not explicitly allowed is refused.', tags: ['sends_external'], connector: 'Gmail' }) },
  ],
  'hr-screening': [
    { weight: 3, make: (r) => ({ tool: 'hr.read_application', args: { role: r.pick(['Accounts Executive', 'Warehouse Lead', 'Sales Associate']), application: `APP-${r.int(300, 480)}` }, decision: 'ask', ruleId: 'read-cv', reason: 'Personal data in CVs is read only after the DPO approves the run.', tags: ['reads_data', 'personal_data'], connector: 'Recruiting MCP', approverGroup: 'privacy', headline: 'hr-screening wants to read a job application', effect: 'Reads the CV and cover letter for one application to write a summary for the recruiter.', triggeredBy: 'personal data in a CV', approveInChat: false, expiresInH: 24, approveP: 0.5 }) },
    { weight: 0.8, make: () => ({ tool: 'hr.send_candidate_email', args: { template: 'rejection' }, decision: 'refuse', ruleId: 'no-candidate-email', reason: 'Candidates hear from a recruiter, never from an agent.', tags: ['sends_external', 'personal_data'], connector: 'Recruiting MCP' }) },
  ],
};

/** Relative traffic per agent (calls per working hour). */
export const RATE: Record<string, number> = {
  'invoice-bot': 1.4,
  'collections-agent': 0.9,
  'vendor-onboarding': 0.35,
  'devops-assistant': 0.55,
  'treasury-sweeper': 0.18,
  'expense-auditor': 0.4,
  'hr-screening': 0.12,
};
