/**
 * Regulatory packs: one declaration + one certified verifier profile + one regime export, under one
 * dated obligation. Always written lowercase: ledger1, invoice1, collect1. ₹1,35,000 per tenant per year.
 * A pack is admitted only when it passes five gates (G-A … G-E). The gates are evaluated from the facts
 * written for the candidate (evaluateGates): "a gate scored 'probably' is scored fail", and G-D stays
 * provisional until the pilot's day-85 answer (Technology Memorandum §13.2–§13.5).
 */
import type { AdmissionGate, PackId, RegulatoryPack } from '@/types';

export const PACK_PRICE = 135000;

/* ── Admission gates: evaluated from facts, never hard-coded ───────────── */

/** What a candidate's author writes down; the gates are scored from it. */
export interface GateFacts {
  /** G-A: a named regulation, standard or contract with a date on it */
  hook: { instrument: string; issuer?: string; date?: string; kind: 'regulation' | 'standard' | 'contract' | 'principle' };
  /** G-B: somebody obliged to ask for the evidence, who could be telephoned */
  auditor: { role: string; organisation?: string; obliged: boolean; callable: boolean };
  /** G-C: every write type is reversible with a plan, or declared irreversible */
  writeTypes: { name: string; reversibility: 'reversible' | 'irreversible_declared' | 'unclear' }[];
  /** G-D: would a buyer pay for the evidence on its own line? 'probably' scores fail; 'provisional' waits on the pilot */
  evidence: { ownLine: 'yes' | 'provisional' | 'probably' | 'no'; budgetLine?: string; note: string };
  /** G-E: elan1 is in the write path, not reading somebody else's log */
  writePath: { kind: 'owns' | 'reads_log' | 'beside'; note: string };
}

export const GATE_INFO: Record<AdmissionGate['id'], { label: string; description: string }> = {
  'G-A': { label: 'A dated hook', description: 'A named regulation, standard or contract with a date on it — not a principle or a direction of travel.' },
  'G-B': { label: 'A named auditor', description: 'Somebody whose job is to ask for the evidence, and who could be telephoned. A category does not count.' },
  'G-C': { label: 'Reversible or declared irreversible', description: 'Every write type says which it is without lying: a reversal plan, or irreversible and held for a person.' },
  'G-D': { label: 'Evidence sold separately', description: 'A buyer would pay for the evidence on its own line item. Provisional until the pilot asks on day 85.' },
  'G-E': { label: 'elan1 owns the write', description: 'The governed write passes through Elan1 Govern — not a copy read from somebody else’s log afterwards.' },
};

const validDate = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d).getTime());
const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Score the five gates from the facts. Each gate carries the sentence that decided it. */
export function evaluateGates(f: GateFacts): AdmissionGate[] {
  const g = (id: AdmissionGate['id'], state: AdmissionGate['state'], evidence: string): AdmissionGate => ({ id, ...GATE_INFO[id], evidence, state });
  const unclear = f.writeTypes.filter((w) => w.reversibility === 'unclear');
  return [
    f.hook.kind === 'principle' || !f.hook.instrument.trim()
      ? g('G-A', 'not_met', `${f.hook.instrument || 'No instrument named'} — a principle or direction of travel, not a dated obligation.`)
      : !validDate(f.hook.date)
        ? g('G-A', 'not_met', `${f.hook.instrument} names no date by which anybody must comply.`)
        : g('G-A', 'met', `${f.hook.instrument}${f.hook.issuer ? ` (${f.hook.issuer})` : ''}, dated ${fmtDate(f.hook.date!)}.`),
    !f.auditor.role.trim() || !f.auditor.obliged
      ? g('G-B', 'not_met', `${f.auditor.role || 'Nobody'} is not obliged to ask for the records. If nobody is obliged to ask, nobody asks.`)
      : !f.auditor.callable
        ? g('G-B', 'not_met', `${f.auditor.role} is a category, not somebody who could be telephoned.`)
        : g('G-B', 'met', `${f.auditor.role}${f.auditor.organisation ? `, ${f.auditor.organisation}` : ''} — obliged to ask, and reachable.`),
    !f.writeTypes.length
      ? g('G-C', 'not_met', 'No write types are named, so none can say whether it is reversible.')
      : unclear.length
        ? g('G-C', 'not_met', `${unclear.map((w) => w.name).join(', ')} ${unclear.length === 1 ? 'does' : 'do'} not say whether ${unclear.length === 1 ? 'it is' : 'they are'} reversible.`)
        : g('G-C', 'met', `${f.writeTypes.length} write types: ${f.writeTypes.filter((w) => w.reversibility === 'reversible').length} with a reversal plan, ${f.writeTypes.filter((w) => w.reversibility === 'irreversible_declared').length} declared irreversible and held for a person.`),
    f.evidence.ownLine === 'yes'
      ? g('G-D', 'met', f.evidence.note)
      : f.evidence.ownLine === 'provisional'
        ? g('G-D', 'provisional', `${f.evidence.note} Provisional — this is the gate the pilot tests on day 85.`)
        : g('G-D', 'not_met', f.evidence.ownLine === 'probably' ? `${f.evidence.note} Scored “probably”, and a gate scored “probably” is scored fail.` : f.evidence.note),
    f.writePath.kind === 'owns'
      ? g('G-E', 'met', f.writePath.note)
      : g('G-E', 'not_met', `${f.writePath.note} ${f.writePath.kind === 'reads_log' ? 'Reading another system’s log is telemetry, not evidence.' : 'elan1 would sit beside the write, not in it.'}`),
  ];
}

/** Admitted only when every gate passes; a provisional G-D admits, pending the pilot. */
export const gatesPass = (gates: AdmissionGate[]) => gates.every((x) => x.state !== 'not_met');

/** The facts each live pack was admitted on (E18 §06; IM §5). */
export const PACK_FACTS: Record<PackId, GateFacts> = {
  ledger1: {
    hook: { instrument: 'Companies (Accounts) Rules, 2014 — proviso to Rule 3(1)', issuer: 'Ministry of Corporate Affairs', date: '2023-04-01', kind: 'regulation' },
    auditor: { role: 'Statutory auditor', organisation: 'reports under Rule 11(g) of the Companies (Audit and Auditors) Rules', obliged: true, callable: true },
    writeTypes: [
      { name: 'sales_invoice.submit', reversibility: 'reversible' }, { name: 'sales_invoice.cancel', reversibility: 'reversible' }, { name: 'purchase_invoice.submit', reversibility: 'reversible' },
      { name: 'payment_entry.submit', reversibility: 'reversible' }, { name: 'journal_entry.submit', reversibility: 'reversible' }, { name: 'customer.update', reversibility: 'reversible' },
    ],
    evidence: { ownLine: 'provisional', budgetLine: 'Audit and compliance', note: 'An audit-trail export the statutory auditor can verify on their own machine.' },
    writePath: { kind: 'owns', note: 'Postings run through the governed route to the ledger; the single writer is the only path.' },
  },
  invoice1: {
    hook: { instrument: 'CGST Rules, 2017 — Rule 48(4) e-invoicing', issuer: 'CBIC (GST Council notifications)', date: '2020-10-01', kind: 'regulation' },
    auditor: { role: 'GST auditor and the statutory auditor', organisation: 'GST audit under Section 65', obliged: true, callable: true },
    writeTypes: [{ name: 'invoice.create', reversibility: 'reversible' }, { name: 'invoice.cancel', reversibility: 'irreversible_declared' }, { name: 'bill.create', reversibility: 'reversible' }, { name: 'credit_note.create', reversibility: 'irreversible_declared' }],
    evidence: { ownLine: 'provisional', budgetLine: 'Indirect tax', note: 'A GST register export with external timestamps, bought by the indirect-tax lead.' },
    writePath: { kind: 'owns', note: 'Invoices are raised through the governed route before the IRN is requested.' },
  },
  collect1: {
    hook: { instrument: 'RBI Master Direction on outsourcing of financial services — recovery agents; Fair Practices Code', issuer: 'Reserve Bank of India', date: '2023-04-01', kind: 'regulation' },
    auditor: { role: 'RBI inspection team and the internal auditor', organisation: 'annual inspection under the Banking Regulation Act', obliged: true, callable: true },
    writeTypes: [
      { name: 'contact.email', reversibility: 'irreversible_declared' }, { name: 'contact.sms', reversibility: 'irreversible_declared' }, { name: 'contact.call', reversibility: 'irreversible_declared' },
      { name: 'notice.final', reversibility: 'irreversible_declared' }, { name: 'promise_to_pay.record', reversibility: 'reversible' },
    ],
    evidence: { ownLine: 'provisional', budgetLine: 'Collections conduct and compliance', note: 'A conduct register the lender hands to the inspector, with every refused contact on it.' },
    writePath: { kind: 'owns', note: 'Contacts are sent through the governed route; nothing reaches a borrower around it.' },
  },
};

export const PACKS: Omit<RegulatoryPack, 'installed' | 'installedAt' | 'installedBy' | 'coverage'>[] = [
  {
    id: 'ledger1', name: 'ledger1', regime: 'MCA audit trail — Companies (Accounts) Rules, Rule 3(1)',
    summary: 'Every change to the books is recorded with who, when and under which rules, in a trail that cannot be switched off, and handed to the statutory auditor for Rule 11(g).',
    buyer: 'Promoter or finance controller of a ₹5–50 crore company, on the auditor’s advice',
    declaration: { id: 'decl.ledger1', version: 1, writeTypes: ['sales_invoice.submit', 'sales_invoice.cancel', 'purchase_invoice.submit', 'payment_entry.submit', 'journal_entry.submit', 'customer.update'], fields: ['voucher_no', 'amount', 'party', 'posting_date', 'edited_by'], dualControlAbove: 200000 },
    gates: evaluateGates(PACK_FACTS.ledger1),
    profileId: 'in-mca-audit-trail', price: PACK_PRICE,
    exports: [{ id: 'mca-audit-trail-csv', label: 'MCA audit-trail register (CSV)', format: 'csv' }, { id: 'mca-edit-log-json', label: 'Edit log (JSON)', format: 'json' }],
  },
  {
    id: 'invoice1', name: 'invoice1', regime: 'GST e-invoicing — CGST Rules, Rule 48(4)',
    summary: 'Invoices and bills raised by agents carry the amount, counterparty and an external timestamp, and are never deleted by an agent.',
    buyer: 'Finance controller of a GST-registered business above the e-invoicing threshold',
    declaration: { id: 'decl.invoice1', version: 1, writeTypes: ['invoice.create', 'invoice.cancel', 'bill.create', 'credit_note.create'], fields: ['irn', 'amount', 'gstin', 'counterparty', 'invoice_date'] },
    gates: evaluateGates(PACK_FACTS.invoice1),
    profileId: 'in-gst-einvoice', price: PACK_PRICE,
    exports: [{ id: 'gst-register-csv', label: 'GST invoice register (CSV)', format: 'csv' }],
  },
  {
    id: 'collect1', name: 'collect1', regime: 'RBI collections conduct — recovery agents and Fair Practices Code',
    summary: 'Every borrower contact is checked for time of day, template and daily cap before it is sent; final notices are approved by a named person.',
    buyer: 'Head of collections at an NBFC, bank or fintech lender',
    declaration: { id: 'decl.collect1', version: 1, writeTypes: ['contact.email', 'contact.sms', 'contact.call', 'notice.final', 'promise_to_pay.record'], fields: ['template', 'channel', 'contact_time', 'days_overdue', 'amount_due'] },
    gates: evaluateGates(PACK_FACTS.collect1),
    profileId: 'in-rbi-collections', price: PACK_PRICE,
    exports: [{ id: 'rbi-conduct-csv', label: 'Collections conduct register (CSV)', format: 'csv' }],
  },
];

export const packById = (id: PackId) => PACKS.find((p) => p.id === id);

/* ── The pack template: eleven blocks (E18 §04) ────────────────────────── */

export const PACK_BLOCKS = [
  { n: 1, id: 'pack_identity', title: 'Pack identity', what: 'Pack id, version, owner role and the domain in one sentence a non-engineer can read.' },
  { n: 2, id: 'obligation', title: 'Obligation', what: 'Regime, issuer, date and the clause set served. One regime per profile.' },
  { n: 3, id: 'buyer', title: 'Buyer', what: 'The job title that signs, the budget line it comes from, and the auditor’s job title.' },
  { n: 4, id: 'gate_scores', title: 'Admission scores', what: 'G-A to G-E with their evidence, kept for ever — including for packs that later fail, and for every pilot run on the pack.' },
  { n: 5, id: 'declaration_ref', title: 'Declaration', what: 'The declaration and version the pack points to. The pack has no ontology of its own.' },
  { n: 6, id: 'write_types', title: 'Write types', what: 'Each with its blast radius, reversal plan, and whether it is reversible or declared irreversible.' },
  { n: 7, id: 'gates', title: 'Pre-write checks G1–G9', what: 'Which of the nine pre-write checks run, in order, with their parameters. The six never-skippable checks are present.' },
  { n: 8, id: 'profile_binding', title: 'Profile binding', what: 'The verifier profile and version, the rule-as-at date. Issued by someone who is not its author.' },
  { n: 9, id: 'buyer_promise', title: 'Buyer promise', what: 'What the buyer receives, in the buyer’s words — and in the same block, what it does not establish.' },
  { n: 10, id: 'tests', title: 'Tests T1–T8', what: 'The eight acceptance tests a pack passes before it ships.' },
  { n: 11, id: 'pilot', title: 'Pilot', what: 'Named customer, named auditor, the dates and the finding. Filled during the 90-day pilot.' },
] as const;

export interface PackTemplate {
  version: number;
  ownerRole: string;
  domain: string;
  obligation: { regime: string; issuer: string; inForceFrom: string; clauses: string[] };
  buyer: { signs: string; budgetLine: string; auditor: string };
  profileBinding: { ruleAsAt: string; appliesToRecordsFrom: string; minAssuranceLevel: 2; refusalsRequired: boolean; continuityScope: 'full_chain' | 'range' };
  promise: { receives: string[]; doesNotEstablish: string[] };
  goLive: string;
  /** the target system whose own audit trail the two-way reconciliation reads (E11 test 3) */
  target: { name: string; trail: string };
}

const PROMISE_RECEIVES = (what: string) => [
  `Every governed ${what} went through stated rules, with a named actor and, where required, a named approver.`,
  'Here is a file covering a period you choose. Your auditor can check it on their own machine, offline, with software they did not get from us.',
  'Here is what that file does not establish, in the profile’s own words, printed in every report.',
];

export const PACK_TEMPLATE: Record<PackId, PackTemplate> = {
  ledger1: {
    version: 1, ownerRole: 'elan1 lead', domain: 'Changes to the books of account, and the evidence that each one passed stated rules.',
    obligation: { regime: 'Companies (Accounts) Rules — audit trail (edit log) for accounting software', issuer: 'Ministry of Corporate Affairs', inForceFrom: '2023-04-01', clauses: ['each_and_every_transaction', 'edit_log_of_each_change', 'date_of_each_change', 'not_disabled'] },
    buyer: { signs: 'Promoter or finance controller of a ₹5–50 crore firm, on the CA’s advice', budgetLine: 'Audit and compliance', auditor: 'Statutory auditor' },
    profileBinding: { ruleAsAt: '2023-04-01', appliesToRecordsFrom: '2027-07-01', minAssuranceLevel: 2, refusalsRequired: true, continuityScope: 'full_chain' },
    promise: { receives: PROMISE_RECEIVES('change to the books'), doesNotEstablish: ['That the books of account are complete: changes made directly in the accounting system, outside this write path, are in that system’s own audit trail.', 'That the transactions were genuine or the rules adequate.', 'That Rule 3(1) is satisfied — that determination belongs to the auditor.'] },
    goLive: 'October 2027', target: { name: 'Zoho Books', trail: 'Zoho Books audit trail (edit log)' },
  },
  invoice1: {
    version: 1, ownerRole: 'elan1 lead', domain: 'Invoices and bills raised by agents, and the evidence that each IRN request passed stated rules.',
    obligation: { regime: 'CGST Rules, 2017 — e-invoicing (Rule 48(4)) and retention (Section 36)', issuer: 'CBIC', inForceFrom: '2020-10-01', clauses: ['irn_before_issue', 'no_agent_delete', 'cancel_within_24h', 'retain_72_months'] },
    buyer: { signs: 'Finance controller of a business above the e-invoicing threshold', budgetLine: 'Indirect tax', auditor: 'GST auditor' },
    profileBinding: { ruleAsAt: '2020-10-01', appliesToRecordsFrom: '2028-04-01', minAssuranceLevel: 2, refusalsRequired: true, continuityScope: 'full_chain' },
    promise: { receives: PROMISE_RECEIVES('invoice write'), doesNotEstablish: ['That the Invoice Registration Portal issued an IRN, or that a GSTIN is valid today.', 'That input tax credit is available to the buyer.', 'That invoices raised outside this write path are in the file.'] },
    goLive: 'April 2028', target: { name: 'Zoho Books', trail: 'Zoho Books activity log' },
  },
  collect1: {
    version: 1, ownerRole: 'elan1 lead', domain: 'Every contact with a borrower, and the evidence that each one kept to the conduct rules before it was sent.',
    obligation: { regime: 'RBI recovery-agent directions and the Fair Practices Code', issuer: 'Reserve Bank of India', inForceFrom: '2023-04-01', clauses: ['contact_window_08_19', 'daily_contact_cap', 'final_notice_named_person', 'retain_8_years'] },
    buyer: { signs: 'Head of collections at an NBFC, bank or fintech lender', budgetLine: 'Collections conduct and compliance', auditor: 'RBI inspection team' },
    profileBinding: { ruleAsAt: '2023-04-01', appliesToRecordsFrom: '2028-10-01', minAssuranceLevel: 2, refusalsRequired: true, continuityScope: 'full_chain' },
    promise: { receives: PROMISE_RECEIVES('borrower contact'), doesNotEstablish: ['That a borrower was reached, or what was said on a call.', 'That contacts made by people outside the governed route kept to the window.', 'That the lender’s conduct policy satisfies the RBI directions.'] },
    goLive: 'October 2028', target: { name: 'Gmail', trail: 'the collections mailbox’s own sent-items log' },
  },
};

/** Blast radius and reversal plan per write type (block 6). */
export const PACK_WRITE_TYPES: Record<PackId, { name: string; blastRadius: string; reversal: string; reversible: boolean; dualControl?: string }[]> = {
  ledger1: [
    { name: 'sales_invoice.submit', blastRadius: 'one record', reversal: 'Cancel the invoice; Zoho Books posts the reversing ledger entries.', reversible: true, dualControl: 'above ₹2,00,000' },
    { name: 'sales_invoice.cancel', blastRadius: 'one record', reversal: 'Amend and resubmit the cancelled invoice as a new version.', reversible: true, dualControl: 'always' },
    { name: 'purchase_invoice.submit', blastRadius: 'one record', reversal: 'Cancel; a debit note compensates once paid.', reversible: true, dualControl: 'above ₹2,00,000' },
    { name: 'payment_entry.submit', blastRadius: 'one counterparty', reversal: 'Cancel the payment entry before the bank file is released; after that, a compensating receipt.', reversible: true, dualControl: 'always' },
    { name: 'journal_entry.submit', blastRadius: 'one record', reversal: 'A reversing journal entry dated the same period.', reversible: true, dualControl: 'always' },
    { name: 'customer.update', blastRadius: 'one counterparty', reversal: 'Restore the previous version from the version table.', reversible: true, dualControl: 'on a GSTIN change' },
  ],
  invoice1: [
    { name: 'invoice.create', blastRadius: 'one counterparty', reversal: 'Cancel the IRN within 24 hours; after that, a credit note.', reversible: true },
    { name: 'invoice.cancel', blastRadius: 'one counterparty', reversal: 'Declared irreversible: an IRN cancelled cannot be restored. Held for a person.', reversible: false, dualControl: 'always' },
    { name: 'bill.create', blastRadius: 'one record', reversal: 'Void the bill before payment.', reversible: true },
    { name: 'credit_note.create', blastRadius: 'one counterparty', reversal: 'Declared irreversible once reported to the portal. Held for a person.', reversible: false, dualControl: 'always' },
  ],
  collect1: [
    { name: 'contact.email', blastRadius: 'one counterparty', reversal: 'Declared irreversible: a sent message cannot be recalled.', reversible: false },
    { name: 'contact.sms', blastRadius: 'one counterparty', reversal: 'Declared irreversible: a sent message cannot be recalled.', reversible: false },
    { name: 'contact.call', blastRadius: 'one counterparty', reversal: 'Declared irreversible: a call placed cannot be unplaced.', reversible: false },
    { name: 'notice.final', blastRadius: 'one counterparty', reversal: 'Declared irreversible; held for a named person before it is sent.', reversible: false, dualControl: 'always' },
    { name: 'promise_to_pay.record', blastRadius: 'one record', reversal: 'Withdraw the promise record; the previous state is restored.', reversible: true },
  ],
};

/**
 * A reference refusal per declared pre-write check (T4): the code as the refusal register spells it on the wire
 * (GATE.* is a protocol identifier and stays as written), the rung it is raised at (3, pre-write checks, in the
 * register) and the operator action. T4 checks each code against the register (mock/devpathData.ts).
 */
export const PACK_FIXTURE_REFUSALS: Record<PackId, { gate: string; code: string; rung: number; operatorAction: string }[]> = {
  ledger1: [
    { gate: 'G1', code: 'GATE.CONSENT_MISSING', rung: 3, operatorAction: 'Capture the consent the declaration names through your own process, or leave the write refused.' },
    { gate: 'G2', code: 'GATE.RESIDENCY_MISMATCH', rung: 3, operatorAction: 'Route the write to the in-region ledger. Never override.' },
    { gate: 'G3', code: 'GATE.RETENTION_WINDOW_CLOSED', rung: 3, operatorAction: 'Keep the record as it is; archive or erase it, never change it.' },
    { gate: 'G4', code: 'GATE.DUAL_CONTROL_SAME_ACTOR', rung: 3, operatorAction: 'A different named person approves.' },
    { gate: 'G7', code: 'GATE.COUNTERPARTY_SANCTIONED', rung: 3, operatorAction: 'Never override. Escalate the party to compliance.' },
    { gate: 'G9', code: 'GATE.PRECONDITION_FAILED', rung: 3, operatorAction: 'Reopen the period or post in the open period.' },
  ],
  invoice1: [
    { gate: 'G1', code: 'GATE.CONSENT_MISSING', rung: 3, operatorAction: 'Authorise the seller GSTIN with the GSP.' },
    { gate: 'G2', code: 'GATE.RESIDENCY_MISMATCH', rung: 3, operatorAction: 'Use the in-region IRP endpoint.' },
    { gate: 'G3', code: 'GATE.RETENTION_WINDOW_CLOSED', rung: 3, operatorAction: 'Keep the invoice; it is past its window and is not changed.' },
    { gate: 'G4', code: 'GATE.DUAL_CONTROL_SAME_ACTOR', rung: 3, operatorAction: 'A second named person approves the cancellation.' },
    { gate: 'G5', code: 'GATE.RATE_EXCEEDED', rung: 3, operatorAction: 'Wait for the next minute; the call is not retried automatically.' },
    { gate: 'G7', code: 'GATE.COUNTERPARTY_SANCTIONED', rung: 3, operatorAction: 'Never override. Escalate the buyer to compliance.' },
    { gate: 'G8', code: 'GATE.OUTSIDE_SCHEDULE', rung: 3, operatorAction: 'Raise a credit note instead of cancelling.' },
    { gate: 'G9', code: 'GATE.PRECONDITION_FAILED', rung: 3, operatorAction: 'Obtain the IRN before sending the invoice.' },
  ],
  collect1: [
    { gate: 'G1', code: 'GATE.CONSENT_MISSING', rung: 3, operatorAction: 'Record the borrower’s channel consent, or use another channel.' },
    { gate: 'G2', code: 'GATE.RESIDENCY_MISMATCH', rung: 3, operatorAction: 'Use the in-region dialler.' },
    { gate: 'G3', code: 'GATE.RETENTION_WINDOW_CLOSED', rung: 3, operatorAction: 'Keep the contact log as it is.' },
    { gate: 'G4', code: 'GATE.DUAL_CONTROL_SAME_ACTOR', rung: 3, operatorAction: 'A named person approves the final notice.' },
    { gate: 'G5', code: 'GATE.RATE_EXCEEDED', rung: 3, operatorAction: 'Contact again tomorrow.' },
    { gate: 'G7', code: 'GATE.COUNTERPARTY_SANCTIONED', rung: 3, operatorAction: 'Never override. Escalate the borrower record to compliance.' },
    { gate: 'G8', code: 'GATE.OUTSIDE_SCHEDULE', rung: 3, operatorAction: 'Send inside 08:00–19:00 IST.' },
    { gate: 'G9', code: 'GATE.PRECONDITION_FAILED', rung: 3, operatorAction: 'Close the open dispute first; use a DLT-registered template.' },
  ],
};

/* ── T1–T8 acceptance tests (E18 §04) ──────────────────────────────────── */

export const PACK_TESTS = [
  { id: 'T1', title: 'Declaration validates', passesWhen: 'Seven blocks validate; the six never-skippable checks are present; no field is blank.' },
  { id: 'T2', title: 'Profile issued', passesWhen: 'The bound profile passes P1–P12 and carries an issuer who is not its author.' },
  { id: 'T3', title: 'Reversal is honest', passesWhen: 'Every reversible write type’s reversal plan has been run once, in a dated drill.' },
  { id: 'T4', title: 'Refusals are real', passesWhen: 'The fixture set holds at least one refusal per declared pre-write check, each with a code from the refusal register, the rung it is raised at and an operator action.' },
  { id: 'T5', title: 'Bundle verifies offline', passesWhen: 'A bundle for the pack’s write types exits 0 PASS with no network.' },
  { id: 'T6', title: 'Tampered bundle refuses', passesWhen: 'The tampered variant exits 1 FAIL_INTEGRITY, naming record and field.' },
  { id: 'T7', title: 'Non-conforming bundle is not accused', passesWhen: 'A sound bundle that breaks a profile rule exits 2 FAIL_PROFILE, never 1.' },
  { id: 'T8', title: 'The auditor reads it', passesWhen: 'The named auditor reads a report unprompted and can state what it does not prove.' },
] as const;

export type PackTestId = (typeof PACK_TESTS)[number]['id'];

/* ── The 90-day pilot (E18 §07) ────────────────────────────────────────── */

export const PILOT_STEPS = [
  { id: 'necessity', day: 0, title: 'The auditor’s half day', what: 'Three questions the auditor would ask, and a written statement of what they would need to rely on a record like this. Anything the profile cannot bind becomes a not_measurable row.' },
  { id: 'boundary', day: 1, title: 'Upgrade L1 → L2', what: 'The organisation moves to L2 Attested. The boundary date and the counts each side are shown to the customer and the auditor the same day.' },
  { id: 'operation', day: 2, title: 'Normal operation (days 2–75)', what: 'No curated data and no suppressed refusals.' },
  { id: 'self_export', day: 76, title: 'The customer exports the bundle', what: 'Without help. Needing help is the finding.' },
  { id: 'air_gap', day: 77, title: 'The auditor runs the verifier', what: 'On a disconnected machine, then the tampered bundle, and watches it fail. elan1 is not in the room.' },
  { id: 'reconcile', day: 78, title: 'Two-way reconciliation', what: 'The chain against the target system’s own audit trail.' },
  { id: 'verdict', day: 80, title: 'The auditor’s written verdict', what: 'In the auditor’s words, kept verbatim even if unflattering.' },
  { id: 'gd', day: 85, title: 'The G-D question', what: '“Would you pay for this on its own line?” The answer closes the pilot.' },
] as const;

export type PilotStepId = (typeof PILOT_STEPS)[number]['id'];
