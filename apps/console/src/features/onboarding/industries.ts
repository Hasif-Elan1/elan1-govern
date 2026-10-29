import type { IndustryPack, PackId, Region, Rule } from '@/types';
import { PACKS } from '@/lib/packs';
import { PROFILES } from '@/lib/profiles';

/**
 * The seven industry configurations from the build (§4.15). Each selects a starter rulebook (mostly tag rules;
 * only Finance names built-in tools), recommended frameworks (always ISO/IEC 42001 and NIST AI RMF, plus region
 * frameworks) and the wording of risk questions. An industry configuration is not a regulatory pack: the packs
 * (ledger1, invoice1, collect1 — each a declaration and a regime export checked against a verifier profile that is
 * billed separately, admitted through gates G-A … G-E) are offered separately below: a dry run at L1, live from L2.
 */
export interface IndustryConfig {
  id: IndustryPack;
  label: string;
  short: string;
  starter: string; // what the starter rulebook does
  rules: { decide: 'allow' | 'ask' | 'refuse'; text: string }[];
  frameworks: string[]; // added on top of the base two
  highRisk?: boolean;
}

export const BASE_FRAMEWORKS = ['ISO 42001', 'NIST AI RMF'];

export const INDUSTRIES: IndustryConfig[] = [
  {
    id: 'finance', label: 'Finance and accounting', short: 'Finance',
    starter: 'Names Gmail and Zoho Books. Allows reads, asks Finance before any payment over ₹50,000 or to a new vendor, refuses payments to unverified accounts.',
    rules: [
      { decide: 'allow', text: 'Read invoices, bills and ledgers' },
      { decide: 'ask', text: 'Pay a bill over ₹50,000 or to a vendor unseen in 90 days — Finance' },
      { decide: 'ask', text: 'Email outside the company domain — Finance' },
      { decide: 'refuse', text: 'Delete records; change bank details' },
    ],
    frameworks: ['SOC 2'],
  },
  {
    id: 'healthcare', label: 'Healthcare', short: 'Healthcare', highRisk: true,
    starter: 'Tag rules only. Asks a clinician-owner before anything that touches personal data or leaves the organisation; refuses deletes and access changes.',
    rules: [
      { decide: 'allow', text: 'Read non-personal operational data' },
      { decide: 'ask', text: 'Anything tagged personal data — Privacy' },
      { decide: 'ask', text: 'Anything that sends outside the organisation — Owners' },
      { decide: 'refuse', text: 'Deletes and access changes' },
    ],
    frameworks: ['HIPAA (US only)'],
  },
  {
    id: 'hr', label: 'HR and recruiting', short: 'HR', highRisk: true,
    starter: 'Tag rules only. Asks a person before any candidate or employee record changes or leaves the company; refuses automated rejections.',
    rules: [
      { decide: 'allow', text: 'Read job descriptions and schedules' },
      { decide: 'ask', text: 'Write to a candidate or employee record — HR' },
      { decide: 'ask', text: 'Send personal data outside — Privacy' },
      { decide: 'refuse', text: 'Deletes and access changes' },
    ],
    frameworks: ['NYC LL 144 (US only)'],
  },
  {
    id: 'support', label: 'Customer support', short: 'Support',
    starter: 'Tag rules only. Allows reading tickets and drafting replies, asks before refunds and outbound messages with personal data.',
    rules: [
      { decide: 'allow', text: 'Read tickets and knowledge base' },
      { decide: 'ask', text: 'Refunds and credits — Support leads' },
      { decide: 'ask', text: 'Outbound messages carrying personal data — Privacy' },
      { decide: 'refuse', text: 'Deletes and access changes' },
    ],
    frameworks: [],
  },
  {
    id: 'sales', label: 'Sales and marketing', short: 'Sales',
    starter: 'Tag rules only. Allows CRM reads and updates, asks before bulk sends and contact exports, refuses deletes.',
    rules: [
      { decide: 'allow', text: 'Read and update CRM records' },
      { decide: 'ask', text: 'Bulk email and contact exports — Marketing' },
      { decide: 'ask', text: 'Discounts above the approved band — Sales leads' },
      { decide: 'refuse', text: 'Deletes and access changes' },
    ],
    frameworks: [],
  },
  {
    id: 'engineering', label: 'Engineering and DevOps', short: 'Engineering',
    starter: 'Tag rules only. Allows reads and changes in staging, asks Engineering before production changes, refuses access changes.',
    rules: [
      { decide: 'allow', text: 'Read repositories, logs and dashboards' },
      { decide: 'ask', text: 'Anything tagged changes production — Engineering' },
      { decide: 'ask', text: 'Deletes outside staging — Engineering' },
      { decide: 'refuse', text: 'Access changes' },
    ],
    frameworks: ['SOC 2'],
  },
  {
    id: 'general', label: 'General', short: 'General',
    starter: 'Tag rules only. Allows reads, asks Owners before writes that move money, send externally or touch personal data, refuses the rest.',
    rules: [
      { decide: 'allow', text: 'Reads' },
      { decide: 'ask', text: 'Moves money, sends external or personal data — Owners' },
      { decide: 'refuse', text: 'Deletes, access and production changes' },
    ],
    frameworks: [],
  },
];

export const industryById = (id?: string) => INDUSTRIES.find((i) => i.id === id) ?? INDUSTRIES[INDUSTRIES.length - 1];

const tag = (id: string, t: Rule['match']['tag'], decide: Rule['decide'], reason: string, approver?: string): Rule => ({ id, match: { tag: t }, decide, reason, ...(approver ? { approver } : {}) });

/** The starter rulebook for each industry configuration, as real rules (published only when a person signs it). */
export const STARTER_RULES: Record<IndustryPack, Rule[]> = {
  finance: [
    { id: 'read-books', match: { tag: 'reads_data' }, decide: 'allow', reason: 'Reading invoices, bills and ledgers is allowed.' },
    { id: 'pay-large', match: { tool: 'zoho_books.record_payment' }, when: [{ field: 'amount', op: 'gt', value: 50000 }], decide: 'ask', approver: 'finance', reason: 'Payments over ₹50,000 need Finance.' },
    { id: 'new-vendor', match: { tool: 'zoho_books.create_vendor' }, decide: 'ask', approver: 'finance', reason: 'A new vendor needs Finance.' },
    { id: 'mail-outside', match: { tag: 'sends_external' }, decide: 'ask', approver: 'finance', reason: 'Email outside the company needs Finance.' },
    tag('no-deletes', 'deletes', 'refuse', 'Agents never delete records.'),
    tag('no-access', 'changes_access', 'refuse', 'Agents never change bank details or access.'),
  ],
  healthcare: [
    tag('read-ops', 'reads_data', 'allow', 'Reading non-personal operational data is allowed.'),
    tag('personal', 'personal_data', 'ask', 'Anything that touches personal data needs Privacy.', 'privacy'),
    tag('outside', 'sends_external', 'ask', 'Anything that leaves the organisation needs an owner.', 'owners'),
    tag('no-deletes', 'deletes', 'refuse', 'Agents never delete records.'),
    tag('no-access', 'changes_access', 'refuse', 'Agents never change access.'),
  ],
  hr: [
    tag('read', 'reads_data', 'allow', 'Reading job descriptions and schedules is allowed.'),
    tag('write-record', 'writes_data', 'ask', 'Writing to a candidate or employee record needs HR.', 'owners'),
    tag('personal-out', 'personal_data', 'ask', 'Sending personal data needs Privacy.', 'privacy'),
    tag('no-deletes', 'deletes', 'refuse', 'Agents never delete records.'),
    tag('no-access', 'changes_access', 'refuse', 'Agents never change access.'),
  ],
  support: [
    tag('read', 'reads_data', 'allow', 'Reading tickets and the knowledge base is allowed.'),
    tag('refunds', 'moves_money', 'ask', 'Refunds and credits need a support lead.', 'owners'),
    tag('personal-out', 'personal_data', 'ask', 'Outbound messages with personal data need Privacy.', 'privacy'),
    tag('no-deletes', 'deletes', 'refuse', 'Agents never delete records.'),
    tag('no-access', 'changes_access', 'refuse', 'Agents never change access.'),
  ],
  sales: [
    tag('read', 'reads_data', 'allow', 'Reading CRM records is allowed.'),
    tag('write', 'writes_data', 'allow', 'Updating CRM records is allowed.'),
    tag('bulk', 'sends_external', 'ask', 'Bulk email and contact exports need Marketing.', 'owners'),
    tag('no-deletes', 'deletes', 'refuse', 'Agents never delete records.'),
    tag('no-access', 'changes_access', 'refuse', 'Agents never change access.'),
  ],
  engineering: [
    tag('read', 'reads_data', 'allow', 'Reading repositories, logs and dashboards is allowed.'),
    tag('prod', 'changes_production', 'ask', 'Production changes need Engineering.', 'engineering'),
    tag('deletes', 'deletes', 'ask', 'Deletes need Engineering.', 'engineering'),
    tag('no-access', 'changes_access', 'refuse', 'Agents never change access.'),
  ],
  general: [
    tag('read', 'reads_data', 'allow', 'Reads are allowed.'),
    tag('money', 'moves_money', 'ask', 'Moving money needs an owner.', 'owners'),
    tag('outside', 'sends_external', 'ask', 'Sending outside needs an owner.', 'owners'),
    tag('personal', 'personal_data', 'ask', 'Personal data needs an owner.', 'owners'),
    tag('no-deletes', 'deletes', 'refuse', 'Agents never delete records.'),
    tag('no-access', 'changes_access', 'refuse', 'Agents never change access.'),
    tag('no-prod', 'changes_production', 'refuse', 'Agents never change production.'),
  ],
};

/** The regulatory packs offered in set-up, with their gates and the verifier profile each is checked against (billed separately). A dry run at L1, live from L2. */
export const REG_PACKS = PACKS.map((p) => ({
  id: p.id as PackId, name: p.name, regime: p.regime, summary: p.summary, buyer: p.buyer, price: p.price,
  gates: p.gates, profile: PROFILES.find((x) => x.id === p.profileId),
  starterRules: p.declaration.writeTypes,
  /** Industries and regions it suits (offered first). */
  suits: (industry: IndustryPack, regions: Region[]) => regions.includes('India') && (industry === 'finance' || (p.id === 'ledger1')),
}));

/** Verifier profiles per regime (from L2). */
export const REG_PROFILES = PROFILES.map((p) => ({ id: p.id, name: p.name, regime: p.regime, jurisdiction: p.jurisdiction, status: p.status, packId: p.packId }));

export const HIGH_RISK_NOTE = 'Starter configuration, not a claim of compliance — these uses are high-risk under the EU AI Act.';

export const REGIONS: { id: Region; label: string; frameworks: string[]; note: string }[] = [
  { id: 'India', label: 'India', frameworks: ['DPDP', 'RBI FREE-AI'], note: 'Digital Personal Data Protection Act 2023; RBI FREE-AI for regulated finance.' },
  { id: 'EU', label: 'European Union', frameworks: ['EU AI Act', 'GDPR'], note: 'Regulation (EU) 2024/1689 and Regulation (EU) 2016/679.' },
  { id: 'UK', label: 'United Kingdom', frameworks: ['UK GDPR'], note: 'UK GDPR and the Data Protection Act 2018.' },
  { id: 'US', label: 'United States', frameworks: ['Colorado AI Act'], note: 'State laws apply where you operate; NIST AI RMF is always on.' },
];

/** Frameworks an organisation's configuration enables. Region-specific industry frameworks only apply in that region. */
export function frameworksFor(industry: IndustryPack, regions: Region[]): string[] {
  const set = new Set<string>(BASE_FRAMEWORKS);
  for (const r of REGIONS) if (regions.includes(r.id)) r.frameworks.forEach((f) => set.add(f));
  for (const f of industryById(industry).frameworks) {
    if (f.endsWith('(US only)')) { if (regions.includes('US')) set.add(f.replace(' (US only)', '')); }
    else set.add(f);
  }
  return Array.from(set);
}

export const SIZES = ['1–50', '51–250', '251–1,000', '1,001–5,000', '5,000+'] as const;

export const CURRENCIES = [
  { id: 'INR', label: 'Indian rupee (₹)', sample: '₹1,80,000' },
  { id: 'USD', label: 'US dollar ($)', sample: '$180,000' },
  { id: 'EUR', label: 'Euro (€)', sample: '€180.000' },
  { id: 'GBP', label: 'Pound sterling (£)', sample: '£180,000' },
] as const;

export const TIMEZONES = [
  { id: 'Asia/Kolkata', label: 'India Standard Time (IST, UTC+5:30)' },
  { id: 'Asia/Dubai', label: 'Gulf Standard Time (UTC+4)' },
  { id: 'Asia/Singapore', label: 'Singapore (UTC+8)' },
  { id: 'Europe/London', label: 'London (GMT/BST)' },
  { id: 'Europe/Berlin', label: 'Central European Time (CET/CEST)' },
  { id: 'America/New_York', label: 'US Eastern (ET)' },
  { id: 'America/Los_Angeles', label: 'US Pacific (PT)' },
];
