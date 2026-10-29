/**
 * Indian regimes that come with the regulatory packs (ledger1, invoice1, collect1), mapped to controls the
 * same way as the other frameworks, and the link from each framework to the verifier profile an auditor
 * runs against it (L2 Attested and above). A pack framework counts in coverage once its pack is installed.
 */
import type { Framework, PackId, Requirement } from '@/types';

const req = (id: string, title: string, controlIds: string[]): Requirement => ({ id, title, controlIds });

export type PackFramework = Framework & { packId: PackId; profileId: string };

const BASE: Omit<PackFramework, 'enabled' | 'coverage'>[] = [
  {
    id: 'pack-ledger1', packId: 'ledger1', profileId: 'in-mca-audit-trail',
    name: 'Companies (Accounts) Rules — MCA audit trail', short: 'MCA audit trail', jurisdiction: 'India', officialRef: 'Rule 3(1); Companies (Audit and Auditors) Rules, Rule 11(g)',
    requirements: [
      req('Rule 3(1)', 'Every change to the books is recorded with its date and who made it', ['EG-03', 'EG-14']),
      req('Rule 3(1) proviso', 'The audit trail cannot be switched off', ['EG-03', 'EG-04']),
      req('Rule 3(5)', 'Books and the trail kept in India and retained for 8 years', ['EG-14']),
      req('Rule 11(g)', 'The statutory auditor reports on the audit trail', ['EG-13']),
      req('ledger1 dual control', 'Postings above ₹2,00,000 approved by a second person', ['EG-02', 'EG-05']),
      req('ledger1 admission', 'The pack is admitted for each agent that posts (gates G-A to G-E)', ['EG-12']),
    ],
  },
  {
    id: 'pack-invoice1', packId: 'invoice1', profileId: 'in-gst-einvoice',
    name: 'CGST Rules — GST e-invoicing', short: 'GST e-invoicing', jurisdiction: 'India', officialRef: 'CGST Rules 2017, Rule 48(4); CGST Act, Section 36',
    requirements: [
      req('Rule 48(4)', 'Each invoice raised carries its amount, counterparty and an external timestamp', ['EG-03', 'EG-14']),
      req('Rule 48(4) cancellation', 'Cancellations within 24 hours; an agent never deletes an invoice', ['EG-01']),
      req('Section 36', 'Records retained for 6 years', ['EG-14']),
      req('Rule 56', 'Accounts kept with a trail the GST officer can inspect', ['EG-04', 'EG-13']),
      req('invoice1 hold', 'Invoices above the set amount held for a person', ['EG-02', 'EG-07']),
    ],
  },
  {
    id: 'pack-collect1', packId: 'collect1', profileId: 'in-rbi-collections',
    name: 'RBI collections conduct — recovery agents and Fair Practices Code', short: 'RBI collections', jurisdiction: 'India', officialRef: 'RBI Master Direction on outsourcing; Fair Practices Code',
    requirements: [
      req('Contact hours', 'Borrowers are contacted only between 08:00 and 19:00', ['EG-01', 'EG-07']),
      req('Daily cap', 'Contacts per borrower per day stay under the cap', ['EG-07']),
      req('Approved templates', 'Only approved message templates are used', ['EG-04']),
      req('Final notice', 'Final notices are approved by a named person', ['EG-02']),
      req('Inspection', 'A conduct register the lender hands to the inspector', ['EG-03', 'EG-13', 'EG-14']),
    ],
  },
];

export function packFrameworks(installed: PackId[]): PackFramework[] {
  return BASE.map((f) => ({ ...f, enabled: installed.includes(f.packId), coverage: 0 }));
}

export const packFrameworkById = (id: string) => BASE.find((f) => f.id === id);

/** The verifier profile an auditor runs for each framework (where one exists). */
export const PROFILE_FOR: Record<string, string> = {
  euaiact: 'eu-ai-act-art12',
  dpdp: 'in-dpdp',
  iso42001: 'iso42001-nist',
  nist: 'iso42001-nist',
  'pack-ledger1': 'in-mca-audit-trail',
  'pack-invoice1': 'in-gst-einvoice',
  'pack-collect1': 'in-rbi-collections',
};
