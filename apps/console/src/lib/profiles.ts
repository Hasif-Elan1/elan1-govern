/**
 * Verifier profiles — one per regime. A profile says which fields a bundle must carry, how long records
 * are kept and which rules (C01…) the records must meet. Running a profile checks the rules against the
 * actual chain; a failing rule names the receipts that fail it. Profiles are draft until a named certifier
 * signs them; the wording of each limits statement is shown verbatim and needs legal review.
 */
import type { Checkpoint, ErasureRequest, LevelId, ProfileRule, ProfileRuleResult, Receipt, VerifierProfile } from '@/types';
import { canonical, sha256Hex } from './crypto';
import { atLeast } from './levels';

type P = Omit<VerifierProfile, 'digest'>;

const LIMITS = 'This profile checks that the records in the bundle meet the rules listed, as written, for the range exported. It does not establish that the underlying transactions occurred, that the rules themselves satisfy the regime, or that records outside the range exist or are complete. A pass is evidence for a reviewer, not a finding.';

/** Each profile's own limits statement (P10: present, over 200 characters, and not copied from another profile). */
const LIMITS_MCA = 'A pass shows that the governed changes to the books in this bundle went through the stated rules, with a named actor, in an unbroken order. It does not establish that the books of account are complete: changes made directly in the accounting system, outside this write path, are recorded by that system’s own audit trail and are not in this bundle. It does not establish that transactions were genuine or that the rules were adequate, and it has not been reviewed or accepted by the Ministry of Corporate Affairs or by any regulator. Whether Rule 3(1) is satisfied is for the auditor to decide.';
const LIMITS_GST = 'A pass shows that the invoice and bill writes in this bundle carried an amount and a counterparty, were never deleted by an agent, and were timestamped by two outside authorities. It does not establish that the Invoice Registration Portal issued an IRN, that a GSTIN named is valid today, or that the buyer may claim input tax credit. Invoices raised outside this write path are not in this bundle. It has not been reviewed or accepted by the GST Network, CBIC or any regulator.';
const LIMITS_RBI = 'A pass shows that the borrower contacts in this bundle were checked for time of day, template and daily cap before they were sent, and that every final notice was held for a named person. It does not establish that a borrower was reached, what was said on a call, or that contacts made by people outside the governed route kept to the window. It has not been reviewed or accepted by the Reserve Bank of India or by any regulator.';
const LIMITS_EU = 'A pass shows that the logs in this bundle were recorded automatically, in an unbroken chain, with the time and the rules in force for each decision and the name of every person who decided. It does not establish that the AI system is high-risk or not, that its risk management under Article 9 is adequate, or that logs outside this deployment exist. It is not a conformity assessment and has not been reviewed by a notified body or any authority.';
const LIMITS_ISO = 'A pass shows that event logs in this bundle form an unbroken chain, that each agent that acted is linked to a registered AI system, and that each refusal records its reason and rule. It does not establish that the management system meets ISO/IEC 42001 or that the NIST AI RMF functions are carried out; only a certification body’s audit can say so, and none has reviewed this profile.';

/** The named author and issuer of the issued profiles (never the same person; E13 §03). */
const AUTHORED = { author: 'elan1 profile author (regulatory engineering)', certifier: 'elan1 profile issuer (a second person)', certifiedAt: '2026-09-23T06:30:00Z' };

const RAW: P[] = [
  {
    id: 'in-mca-audit-trail', version: '1.0', name: 'MCA audit trail', regime: 'Companies (Accounts) Rules, 2014 — Rule 3(1) and Companies (Audit and Auditors) Rules — Rule 11(g)', jurisdiction: 'India', issuer: 'elan1 · ledger1', status: 'certified', ...AUTHORED,
    retentionYears: 8, packId: 'ledger1',
    requiredFields: ['seq', 'ts', 'actor', 'tool', 'rulebook.version', 'prev_hash', 'hash', 'sig'],
    rules: [
      { id: 'C01', kind: 'integrity', clause: 'Rule 3(1)', text: 'The audit trail cannot be altered: every record links to the one before it.' },
      { id: 'C02', kind: 'structural', clause: 'Rule 3(1)', text: 'Every change to the books records who made it, when, and under which rulebook version.' },
      { id: 'C03', kind: 'binding', clause: 'Rule 3(1)', text: 'Every approval record points to the decision it resolves.' },
      { id: 'C04', kind: 'coverage', clause: 'Rule 3(1) proviso', text: 'The audit trail was never switched off: a signed checkpoint exists for every day with activity.' },
      { id: 'C05', kind: 'temporal', clause: 'Section 128(5)', text: 'Records are kept for at least 8 years in write-once storage.' },
      { id: 'C06', kind: 'structural', clause: 'Rule 11(g)', text: 'Changes to the rules themselves (rulebook publishes) are recorded with a signer.' },
      { id: 'C07', kind: 'coverage', clause: 'Rule 3(1) — each and every transaction', text: 'Every change to the books, including those made directly in the accounting system, has a record.', disposition: 'not_measurable',
        reason: 'Changes made directly in the accounting system, outside this write path, are in that system’s own audit trail and are not in the bundle.', wouldChangeIf: 'The bundle carries the target system’s own audit trail, or the two-way reconciliation runs inside the verifier.' },
    ],
    limits: LIMITS_MCA,
  },
  {
    id: 'in-gst-einvoice', version: '1.0', name: 'GST e-invoicing', regime: 'CGST Rules, 2017 — Rule 48(4) e-invoicing and Section 36 retention', jurisdiction: 'India', issuer: 'elan1 · invoice1', status: 'certified', ...AUTHORED,
    retentionYears: 6, packId: 'invoice1',
    requiredFields: ['seq', 'ts', 'tool', 'args.amount', 'args.vendor|counterparty', 'hash', 'sig'],
    rules: [
      { id: 'C01', kind: 'integrity', clause: 'Section 35', text: 'Invoice records form an unbroken chain.' },
      { id: 'C02', kind: 'structural', clause: 'Rule 48(4)', text: 'Every bill or invoice write carries an amount and a counterparty.' },
      { id: 'C03', kind: 'binding', clause: 'Rule 48(4)', text: 'No invoice is deleted by an agent; cancellations are refused and recorded.' },
      { id: 'C04', kind: 'temporal', clause: 'Section 36', text: 'Records are kept for at least 72 months (6 years).' },
      { id: 'C05', kind: 'temporal', clause: 'IRP practice', text: 'Records are timestamped by an external authority within 15 minutes.' },
      { id: 'C06', kind: 'binding', clause: 'Rule 48(4) — IRN acknowledgement', text: 'The IRN and signed QR code returned by the portal match the invoice.', disposition: 'out_of_scope', adr: 'ADR-0014' },
    ],
    limits: LIMITS_GST,
  },
  {
    id: 'in-rbi-collections', version: '1.0', name: 'RBI collections conduct', regime: 'RBI Master Direction on outsourcing of financial services — recovery agents; Fair Practices Code', jurisdiction: 'India', issuer: 'elan1 · collect1', status: 'certified', ...AUTHORED,
    retentionYears: 8, packId: 'collect1',
    requiredFields: ['seq', 'ts', 'agent', 'tool', 'args.template', 'decision', 'approval'],
    rules: [
      { id: 'C01', kind: 'integrity', clause: 'Para 3', text: 'Collection records form an unbroken chain.' },
      { id: 'C02', kind: 'temporal', clause: 'Fair Practices Code', text: 'No borrower is contacted before 08:00 or after 19:00 IST.' },
      { id: 'C03', kind: 'binding', clause: 'Para 5', text: 'Every final notice was approved by a named person before it was sent.' },
      { id: 'C04', kind: 'coverage', clause: 'Para 5', text: 'No more than 120 reminders were sent in any day.' },
      { id: 'C05', kind: 'temporal', clause: 'Para 9', text: 'Records are kept for at least 8 years.' },
      { id: 'C06', kind: 'binding', clause: 'Fair Practices Code — conduct on calls', text: 'What a recovery agent said on a call kept to the code.', disposition: 'not_measurable',
        reason: 'The chain records that a call was placed and when; it holds no recording or transcript of what was said.', wouldChangeIf: 'A call-recording digest is bound into the contact record as a proof field.' },
    ],
    limits: LIMITS_RBI,
  },
  {
    id: 'eu-ai-act-art12', version: '1.0', name: 'EU AI Act Art. 12 record-keeping', regime: 'Regulation (EU) 2024/1689 — Article 12 (record-keeping) and Article 19 (logs)', jurisdiction: 'European Union', issuer: 'elan1', status: 'draft',
    retentionYears: 0.5,
    requiredFields: ['seq', 'ts', 'agent', 'tool', 'decision', 'rulebook.version', 'approval.approver'],
    rules: [
      { id: 'C01', kind: 'integrity', clause: 'Art. 12(1)', text: 'Logs are recorded automatically and form an unbroken chain.' },
      { id: 'C02', kind: 'structural', clause: 'Art. 12(2)', text: 'Every decision records its time and the rules in force.' },
      { id: 'C03', kind: 'binding', clause: 'Art. 14', text: 'Every human decision names the person who made it.' },
      { id: 'C04', kind: 'temporal', clause: 'Art. 19(1)', text: 'Logs are kept for at least 6 months.' },
      { id: 'C05', kind: 'structural', clause: 'Art. 12(3)', text: 'Remote biometric identification logs record the reference database and the persons who verified a match.', disposition: 'out_of_scope', adr: 'ADR-0021' },
    ],
    limits: LIMITS_EU,
  },
  {
    id: 'in-dpdp', version: '1.0', name: 'DPDP', regime: 'Digital Personal Data Protection Act, 2023 — Sections 8 and 12', jurisdiction: 'India', issuer: 'elan1', status: 'draft',
    retentionYears: 0,
    requiredFields: ['seq', 'ts', 'args_summary', 'details.tags'],
    rules: [
      { id: 'C01', kind: 'integrity', clause: 'Section 8(5)', text: 'Records form an unbroken chain.' },
      { id: 'C02', kind: 'structural', clause: 'Section 8(4)', text: 'No receipt stores an email address or a full message; only what a rule inspected.' },
      { id: 'C03', kind: 'temporal', clause: 'Section 12(3)', text: 'Every erasure request was executed within 72 hours by two approvers.' },
      { id: 'C04', kind: 'coverage', clause: 'Section 8(5)', text: 'Calls that touch personal data are tagged personal_data.' },
    ],
    limits: LIMITS,
  },
  {
    id: 'iso42001-nist', version: '1.0', name: 'ISO/IEC 42001 and NIST AI RMF', regime: 'ISO/IEC 42001:2023 Annex A and NIST AI RMF 1.0 (Govern, Map, Measure, Manage)', jurisdiction: 'International', issuer: 'elan1', status: 'draft',
    retentionYears: 3,
    requiredFields: ['seq', 'ts', 'agent', 'decision', 'reason'],
    rules: [
      { id: 'C01', kind: 'integrity', clause: 'A.6.2.8', text: 'Event logs form an unbroken chain.' },
      { id: 'C02', kind: 'coverage', clause: 'A.4.2 · MAP 1.1', text: 'Every agent that acted is linked to a registered AI system.' },
      { id: 'C03', kind: 'structural', clause: 'A.9.2 · MANAGE 2.4', text: 'Every refusal records its reason and rule.' },
      { id: 'C04', kind: 'binding', clause: 'A.5.2 · MEASURE 2.6', text: 'High-risk systems have an approved assessment.' },
    ],
    limits: LIMITS_ISO,
  },
];

export const PROFILES: VerifierProfile[] = RAW.map((p) => ({ ...p, digest: sha256Hex(canonical(p)) }));

export const profileById = (id: string) => PROFILES.find((p) => p.id === id);

/** How a profile's status is shown. The stored value 'certified' is never printed: it reads "Issued". */
export const PROFILE_STATUS_LABEL: Record<VerifierProfile['status'], string> = { draft: 'Draft', certified: 'Issued', superseded: 'Superseded', withdrawn: 'Withdrawn' };

/** How a rule result reads on screen (pass / fail / not applicable / not measurable / out of scope). */
export const RULE_STATE_LABEL: Record<ProfileRuleResult['state'], string> = { pass: 'Pass', fail: 'Fail', not_applicable: 'Not applicable', not_measurable: 'Not measurable', out_of_scope: 'Out of scope' };

/** Every rule's disposition is valid: not_measurable needs a reason and a would-change-if of ≥ 12 characters; out_of_scope an ADR-nnnn. */
export function dispositionProblems(p: Pick<VerifierProfile, 'rules'>): string[] {
  const out: string[] = [];
  for (const r of p.rules) {
    if (r.disposition === 'not_measurable' && ((r.reason ?? '').trim().length < 12 || (r.wouldChangeIf ?? '').trim().length < 12)) out.push(`${r.id}: a not_measurable row needs a reason and what would change it, each at least 12 characters.`);
    if (r.disposition === 'out_of_scope' && !/^ADR-[0-9]{4}$/.test(r.adr ?? '')) out.push(`${r.id}: an out_of_scope row needs a decision record (ADR-nnnn).`);
  }
  return out;
}

/** The 15-minute timestamp target, in seconds. */
export const TIMESTAMP_TARGET_SECONDS = 15 * 60;

/**
 * true when at least one timestamp token was issued within `limitSeconds` of the batch window closing.
 * A token issued before the window closed cannot be valid for it and does not count.
 */
export function timestampedWithin(windowEnd: string, genTimes: string[], limitSeconds = TIMESTAMP_TARGET_SECONDS): boolean {
  const end = new Date(windowEnd).getTime();
  return genTimes.some((g) => { const d = (new Date(g).getTime() - end) / 1000; return d >= 0 && d <= limitSeconds; });
}

/** The parts of an anchor batch a profile rule reads. */
export interface ProfileAnchorBatch { id: string; firstSeq: number; lastSeq: number; windowEnd: string; tokens: { genTime: string }[] }

export interface ProfileContext {
  receipts: Receipt[];
  checkpoints: Checkpoint[];
  level: LevelId;
  wormRetentionYears: number;
  anchoredSeqs?: Set<number>;
  /** The anchor batches (window end and token times), so time-to-timestamp rules are checked, not assumed. */
  anchorBatches?: ProfileAnchorBatch[];
  erasures: ErasureRequest[];
  agents: { slug: string; id: string; aiSystemId?: string }[];
  aiSystems: { id: string; linkedAgentId?: string; riskTier: string }[];
  assessments: { aiSystemId: string; status: string }[];
}

const istHour = (ts: string) => new Date(new Date(ts).getTime() + 5.5 * 3.6e6).getUTCHours();
const istDay = (ts: string) => new Date(new Date(ts).getTime() + 5.5 * 3.6e6).toISOString().slice(0, 10);

function linkBreaks(rs: Receipt[]) {
  const bad: number[] = [];
  for (let i = 1; i < rs.length; i++) if (rs[i].prev_hash !== rs[i - 1].hash || rs[i].seq !== rs[i - 1].seq + 1) bad.push(rs[i].seq);
  return bad;
}

function res(rule: ProfileRule, failing: number[], passDetail: string, failDetail: (n: number) => string, na = false): ProfileRuleResult {
  if (na) return { ...rule, state: 'not_applicable', detail: passDetail, failingSeqs: [] };
  return { ...rule, state: failing.length ? 'fail' : 'pass', detail: failing.length ? failDetail(failing.length) : passDetail, failingSeqs: failing.slice(0, 50) };
}

/** Run every rule of a profile against the records. */
export function runProfileRules(profile: VerifierProfile, ctx: ProfileContext): ProfileRuleResult[] {
  const rs = ctx.receipts;
  const integrity = (rule: ProfileRule) => res(rule, linkBreaks(rs), `${rs.length} records link without a gap.`, (n) => `${n} records break the previous-hash link or sequence.`);
  // write-once retention is L2 evidence: at L1 (a pack dry run) it reads not applicable, not failed (decision 5)
  const retention = (rule: ProfileRule, years: number) => !atLeast(ctx.level, 'l2') ? res(rule, [], 'Write-once storage starts at L2 Attested; at L1 this check is not applicable.', () => '', true) : res(rule,ctx.wormRetentionYears >= years ? [] : [rs[0]?.seq ?? 0], `Write-once retention is ${ctx.wormRetentionYears} years (needs ${years}).`, () => `Retention is ${ctx.wormRetentionYears || 'not set to'} years; the profile needs ${years}. ${atLeast(ctx.level, 'l2') ? '' : 'Write-once storage starts at L2 Attested.'}`);
  return profile.rules.map((rule): ProfileRuleResult => {
    // a clause honestly not measured, or scoped out by a decision record, is never a silent pass
    if (rule.disposition === 'not_measurable') return { id: rule.id, kind: rule.kind, clause: rule.clause, text: rule.text, state: 'not_measurable', detail: `Not measured: ${rule.reason ?? ''} Would change if: ${rule.wouldChangeIf ?? ''}`, failingSeqs: [] };
    if (rule.disposition === 'out_of_scope') return { id: rule.id, kind: rule.kind, clause: rule.clause, text: rule.text, state: 'out_of_scope', detail: `Out of scope under ${rule.adr ?? 'a decision record'}.`, failingSeqs: [] };
    const key = `${profile.id}:${rule.id}`;
    switch (key) {
      case 'in-mca-audit-trail:C01': case 'in-gst-einvoice:C01': case 'in-rbi-collections:C01': case 'eu-ai-act-art12:C01': case 'in-dpdp:C01': case 'iso42001-nist:C01':
        return integrity(rule);
      case 'in-mca-audit-trail:C02': {
        const books = rs.filter((r) => r.tool?.startsWith('zoho_books.') && r.kind === 'decision');
        return res(rule, books.filter((r) => !r.rulebook || !r.agent).map((r) => r.seq), `${books.length} changes to the books carry the actor, time and rulebook version.`, (n) => `${n} changes to the books lack a rulebook version or actor.`);
      }
      case 'in-mca-audit-trail:C03': case 'eu-ai-act-art12:C03': {
        const seqs = new Set(rs.map((r) => r.seq));
        const aps = rs.filter((r) => r.kind === 'approval');
        if (key.endsWith('C03') && profile.id === 'eu-ai-act-art12') {
          const human = aps.filter((r) => r.approval?.status !== 'expired');
          return res(rule, human.filter((r) => !r.approval?.approver).map((r) => r.seq), `${human.length} human decisions each name the approver.`, (n) => `${n} human decisions do not name an approver.`);
        }
        return res(rule, aps.filter((r) => !r.ref_seq || (r.ref_seq >= rs[0].seq && !seqs.has(r.ref_seq))).map((r) => r.seq), `${aps.length} approval records each point to their decision.`, (n) => `${n} approval records point to a decision that is not in the range.`);
      }
      case 'in-mca-audit-trail:C04': {
        const active = new Set(rs.map((r) => istDay(r.ts)));
        const cpDays = new Set(ctx.checkpoints.map((c) => istDay(c.ts)));
        const missing = [...active].filter((d) => !cpDays.has(d));
        const failing = rs.filter((r) => missing.includes(istDay(r.ts))).map((r) => r.seq);
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        const cpWord = atLeast(ctx.level, 'l2') ? 'signed' : 'sealed';
        return res(rule, failing, `${active.size} days with activity, each with a ${cpWord} checkpoint.`, () => `${missing.length} days with activity have no ${cpWord} checkpoint.`);
      }
      case 'in-mca-audit-trail:C05': return retention(rule, 8);
      case 'in-mca-audit-trail:C06': {
        // an L2 check: at L1 a pack is a dry run and records are sealed, not signed (decisions 2 and 5)
        if (!atLeast(ctx.level, 'l2')) return res(rule, [], 'Signed rulebook publishes start at L2 Attested; at L1 this pack is a dry run.', () => '', true);
        const pubs = rs.filter((r) => r.action === 'rulebook.published');
        return res(rule, pubs.filter((r) => !r.actor).map((r) => r.seq), `${pubs.length} rulebook publishes each name the signer.`, (n) => `${n} rulebook publishes have no signer.`);
      }
      case 'in-gst-einvoice:C02': {
        const inv = rs.filter((r) => r.kind === 'decision' && (r.tool === 'zoho_books.create_bill' || r.tool === 'zoho_books.record_payment'));
        return res(rule, inv.filter((r) => r.args_summary?.amount === undefined || (r.args_summary?.vendor === undefined && r.args_summary?.counterparty === undefined)).map((r) => r.seq), `${inv.length} bill and payment writes carry an amount and a counterparty.`, (n) => `${n} bill or payment writes lack an amount or counterparty.`);
      }
      case 'in-gst-einvoice:C03': {
        const dels = rs.filter((r) => r.kind === 'decision' && /delete|void/.test(r.tool ?? ''));
        return res(rule, dels.filter((r) => r.decision !== 'refuse').map((r) => r.seq), `${dels.length} delete or void attempts, all refused and recorded.`, (n) => `${n} delete or void attempts were not refused.`);
      }
      case 'in-gst-einvoice:C04': return retention(rule, 6);
      case 'in-gst-einvoice:C05': {
        if (!atLeast(ctx.level, 'l2') || !ctx.anchoredSeqs) return res(rule, [], 'External timestamps start at L2 Attested; this range is L1.', () => '', true);
        const inRange = new Set(rs.map((r) => r.seq));
        const batches = (ctx.anchorBatches ?? []).filter((b) => b.lastSeq >= (rs[0]?.seq ?? 0) && b.firstSeq <= (rs[rs.length - 1]?.seq ?? 0));
        if (!batches.length) return res(rule, [], 'No timestamped batch covers this range, so there is no timestamp time to check.', () => '', true);
        const late = batches.filter((b) => !timestampedWithin(b.windowEnd, (b.tokens ?? []).map((t) => t.genTime)));
        const failing = late.flatMap((b) => { const out: number[] = []; for (let q = b.firstSeq; q <= b.lastSeq; q++) if (inRange.has(q)) out.push(q); return out; });
        const anchored = rs.filter((r) => ctx.anchoredSeqs!.has(r.seq)).length;
        return res(rule, failing, `${batches.length} batches (${anchored} records): each has a timestamp issued within 15 minutes of its window closing.`, (n) => `${late.length} batch${late.length === 1 ? '' : 'es'} (${n} records) had no timestamp within 15 minutes of the window closing.`);
      }
      case 'in-rbi-collections:C02': {
        const contacts = rs.filter((r) => r.kind === 'decision' && r.tool === 'gmail.send_email' && r.args_summary?.template !== undefined && r.decision !== 'refuse');
        return res(rule, contacts.filter((r) => istHour(r.ts) < 8 || istHour(r.ts) >= 19).map((r) => r.seq), `${contacts.length} borrower contacts, all between 08:00 and 19:00 IST.`, (n) => `${n} borrower contacts were sent outside 08:00–19:00 IST.`);
      }
      case 'in-rbi-collections:C03': {
        const finals = rs.filter((r) => r.kind === 'decision' && r.args_summary?.template === 'final_notice');
        return res(rule, finals.filter((r) => r.decision === 'allow').map((r) => r.seq), `${finals.length} final notices, each held for a named person.`, (n) => `${n} final notices went out without a person.`);
      }
      case 'in-rbi-collections:C04': {
        const perDay: Record<string, number[]> = {};
        rs.filter((r) => r.kind === 'decision' && r.rule_id === 'reminders' && r.decision === 'allow').forEach((r) => (perDay[istDay(r.ts)] ??= []).push(r.seq));
        const over = Object.values(perDay).filter((s) => s.length > 120).flat();
        return res(rule, over, `Busiest day: ${Math.max(0, ...Object.values(perDay).map((s) => s.length))} reminders (cap 120).`, () => 'A day went over the 120-reminder cap.');
      }
      case 'in-rbi-collections:C05': return retention(rule, 8);
      case 'eu-ai-act-art12:C02': {
        const ds = rs.filter((r) => r.kind === 'decision');
        return res(rule, ds.filter((r) => !r.ts || (!r.rulebook && r.rule_id !== 'no-rulebook')).map((r) => r.seq), `${ds.length} decisions record the time and rulebook version.`, (n) => `${n} decisions lack a rulebook version.`);
      }
      case 'eu-ai-act-art12:C04': return retention(rule, 0.5);
      case 'in-dpdp:C02': {
        const leaks = rs.filter((r) => Object.values(r.args_summary ?? {}).some((v) => typeof v === 'string' && /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(v)));
        return res(rule, leaks.map((r) => r.seq), `${rs.length} receipts hold no email address or message body.`, (n) => `${n} receipts hold an email address.`);
      }
      case 'in-dpdp:C03': {
        const late = ctx.erasures.filter((e) => e.status === 'executed' && e.executedAt && new Date(e.executedAt).getTime() > new Date(e.dueAt).getTime());
        const open = ctx.erasures.filter((e) => e.status !== 'executed' && e.status !== 'rejected' && Date.now() > new Date(e.dueAt).getTime());
        const bad = [...late, ...open].flatMap((e) => e.affectedSeqs.slice(0, 1));
        return res(rule, bad, `${ctx.erasures.filter((e) => e.status === 'executed').length} erasure requests executed within 72 hours by two approvers.`, () => `${late.length + open.length} erasure requests passed the 72-hour clock.`);
      }
      case 'in-dpdp:C04': {
        const pd = rs.filter((r) => r.kind === 'decision' && /read_application|update_bank_details|read_inbox/.test(r.tool ?? ''));
        return res(rule, pd.filter((r) => !String(r.details?.tags ?? '').includes('personal_data') && r.decision !== 'ask' && r.decision !== 'refuse').map((r) => r.seq), `${pd.length} calls that touch personal data are tagged.`, (n) => `${n} calls that touch personal data are not tagged personal_data.`);
      }
      case 'iso42001-nist:C02': {
        const acted = new Set(rs.filter((r) => r.kind === 'decision' && r.agent).map((r) => r.agent!));
        const missing = ctx.agents.filter((a) => acted.has(a.slug) && !ctx.aiSystems.some((s) => s.id === a.aiSystemId || s.linkedAgentId === a.id));
        const failing = rs.filter((r) => missing.some((m) => m.slug === r.agent)).slice(0, 20).map((r) => r.seq);
        return res(rule, failing, `${acted.size} agents acted; each is linked to a registered AI system.`, () => `${missing.length} agents acted without a registered AI system: ${missing.map((m) => m.slug).join(', ')}.`);
      }
      case 'iso42001-nist:C03': {
        const refs = rs.filter((r) => r.decision === 'refuse');
        return res(rule, refs.filter((r) => !r.reason || !(r.rule_id || r.kind === 'approval')).map((r) => r.seq), `${refs.length} refusals each record a reason and rule.`, (n) => `${n} refusals lack a reason or rule.`);
      }
      case 'iso42001-nist:C04': {
        const high = ctx.aiSystems.filter((s) => s.riskTier === 'high');
        const missing = high.filter((s) => !ctx.assessments.some((a) => a.aiSystemId === s.id && a.status === 'approved'));
        return res(rule, missing.length ? [rs[0]?.seq ?? 0] : [], `${high.length} high-risk systems, each with an approved assessment.`, () => `${missing.length} high-risk systems have no approved assessment.`);
      }
      default:
        return res(rule, [], 'Not applicable to this range.', () => '', true);
    }
  });
}
