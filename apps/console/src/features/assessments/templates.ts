/**
 * The three assessment templates and their deterministic, point-based scoring.
 * Every answer carries a fixed number of points; the total against the template's thresholds gives the tier.
 * The same answers always give the same score — there is no model in the scoring.
 */
import type { Assessment, AssessmentQuestion, AssessmentTemplate, LevelId, PackId, RiskTier } from '@/types';
import { PACKS } from '@/lib/packs';

export interface AnswerOption {
  label: string;
  points: number;
  explanation: string;
  /** Selecting this answer makes the result Unacceptable regardless of the total. */
  prohibited?: boolean;
}

export interface BankQuestion {
  id: string;
  section: string;
  text: string;
  options: AnswerOption[];
}

export interface TemplateDef {
  id: AssessmentTemplate;
  label: string;
  purpose: string;
  when: string;
  maxScore: number;
  questions: BankQuestion[];
}

const o = (label: string, points: number, explanation: string, prohibited?: boolean): AnswerOption => ({ label, points, explanation, prohibited });

export const TEMPLATES: Record<AssessmentTemplate, TemplateDef> = {
  risk_triage: {
    id: 'risk_triage',
    label: 'Risk triage',
    purpose: 'A quick first look at what the system can do and who it can hurt. Decides whether a full impact assessment is needed.',
    when: 'Every new system, before it leaves Proposed.',
    maxScore: 24,
    questions: [
      { id: 't1', section: 'Actions', text: 'Does it move money or change payment destinations?', options: [o('No', 0, 'No money movement scores 0.'), o('Between our own accounts only', 2, 'Internal transfers score 2 of 4.'), o('Yes, to external parties', 4, 'Paying or changing payees outside the company is the highest fraud exposure: 4 of 4.')] },
      { id: 't2', section: 'Actions', text: 'Does it act on external parties (send, create or change their records)?', options: [o('No', 0, 'Internal-only actions score 0.'), o('It drafts; a person sends', 1, 'A person in the loop before anything leaves scores 1 of 3.'), o('Yes, directly', 3, 'Acting on outsiders directly scores 3 of 3.')] },
      { id: 't3', section: 'Actions', text: 'Can it delete data or change access or production?', options: [o('No', 0, 'No destructive or privileged actions scores 0.'), o('Only with a person’s approval', 1, 'Held for approval scores 1 of 3.'), o('Yes', 3, 'Unheld destructive or privileged actions score 3 of 3.')] },
      { id: 't4', section: 'People', text: 'Who is affected if it errs?', options: [o('Only our own staff', 0, 'Internal impact only scores 0.'), o('Customers or vendors', 2, 'External parties affected scores 2 of 3.'), o('Individuals with a significant interest (applicants, patients, borrowers)', 3, 'Individuals with a significant interest score the maximum, 3 of 3.')] },
      { id: 't5', section: 'People', text: 'Does it process personal data?', options: [o('No', 0, 'No personal data scores 0.'), o('Contact details only', 1, 'Contact details score 1 of 3.'), o('Financial, health, identity or employment data', 3, 'Sensitive categories score 3 of 3.')] },
      { id: 't6', section: 'Model', text: 'Is the model on the decision path?', options: [o('No — rules decide in code', 0, 'No model on the decision path scores 0.'), o('The model drafts; a person decides', 1, 'Model output reviewed by a person scores 1 of 2.'), o('The model decides', 2, 'A model deciding scores 2 of 2.')] },
      { id: 't7', section: 'Controls', text: 'Is there a human approval step for high-impact actions?', options: [o('Yes — held for a named approver', 0, 'An approval step reduces the score to 0.'), o('Sometimes', 1, 'Partial approval coverage scores 1 of 2.'), o('No', 2, 'No approval step scores 2 of 2.')] },
      { id: 't8', section: 'Controls', text: 'Can it be stopped at once?', options: [o('Yes — pause and emergency stop', 0, 'An immediate stop scores 0.'), o('Only by revoking its credentials', 1, 'A slow stop scores 1 of 2.'), o('No', 2, 'No way to stop it scores 2 of 2.')] },
      { id: 't9', section: 'Controls', text: 'Is every decision recorded?', options: [o('Yes — on a sealed or signed, hash-chained record', 0, 'Sealed or signed, hash-chained records score 0.'), o('Application logs only', 1, 'Ordinary logs score 1 of 2.'), o('No', 2, 'No record scores 2 of 2.')] },
    ],
  },
  impact: {
    id: 'impact',
    label: 'Impact assessment',
    purpose: 'A full assessment of decisions, people, data and controls. Required for any system that triage puts at limited risk or above.',
    when: 'Before go-live, and at every review date.',
    maxScore: 40,
    questions: [
      { id: 'i1', section: 'Decisions', text: 'Can the system commit the business without a person?', options: [o('No', 0, 'Nothing is committed without a person: 0.'), o('Within small limits', 3, 'Commitments within limits score 3 of 5.'), o('Yes', 5, 'Committing the business without review scores the maximum, 5 of 5.')] },
      { id: 'i2', section: 'Decisions', text: 'Are its decisions reversible?', options: [o('Fully, at once', 0, 'Fully reversible scores 0.'), o('Partly', 3, 'Partial reversibility scores 3 of 5.'), o('No', 5, 'Irreversible decisions score 5 of 5.')] },
      { id: 'i3', section: 'People', text: 'Who is affected if it errs?', options: [o('Only our own staff', 1, 'Internal impact scores 1 of 5.'), o('Customers or vendors', 3, 'External parties affected score 3 of 5.'), o('Individuals with a significant interest', 5, 'Applicants, patients or borrowers score 5 of 5.')] },
      { id: 'i4', section: 'People', text: 'How many people could one error affect?', options: [o('Fewer than 10', 1, 'Narrow blast radius scores 1 of 5.'), o('Up to 1,000', 3, 'Medium blast radius scores 3 of 5.'), o('More than 1,000', 5, 'Wide blast radius scores 5 of 5.')] },
      { id: 'i5', section: 'Data', text: 'What kind of data does it process?', options: [o('No personal data', 0, 'No personal data scores 0.'), o('Contact details', 2, 'Contact details score 2 of 5.'), o('Financial, health, identity or employment data', 5, 'Sensitive categories score 5 of 5.')] },
      { id: 'i6', section: 'Data', text: 'Does data leave the organisation?', options: [o('No', 0, 'Data stays inside: 0.'), o('To a named processor under contract', 3, 'A contracted processor scores 3 of 5.'), o('Yes, to third parties', 5, 'Uncontrolled onward sharing scores 5 of 5.')] },
      { id: 'i7', section: 'Controls', text: 'Is there a human approval step for high-impact actions?', options: [o('Yes — held for a named approver', 0, 'An approval gate reduces the score to 0.'), o('Partly', 3, 'Partial coverage scores 3 of 5.'), o('No', 5, 'No approval step scores 5 of 5.')] },
      { id: 'i8', section: 'Controls', text: 'Is it used for a prohibited practice (social scoring, manipulative techniques, untargeted face scraping)?', options: [o('No', 0, 'No prohibited practice: 0.'), o('Under legal review', 5, 'Unclear status scores 5 of 5 until legal confirms.'), o('Yes', 5, 'A prohibited practice makes the result Unacceptable whatever the total.', true)] },
    ],
  },
  data_protection: {
    id: 'data_protection',
    label: 'Data-protection check',
    purpose: 'Checks lawful basis, notice, retention, rights, transfers and security for systems that touch personal data (DPDP and GDPR).',
    when: 'Any system that processes personal data.',
    maxScore: 30,
    questions: [
      { id: 'd1', section: 'Lawful basis', text: 'What is the lawful basis for processing?', options: [o('Consent, recorded', 1, 'Recorded consent scores 1 of 5.'), o('A legitimate use named in the Act', 2, 'A named legitimate use scores 2 of 5.'), o('Not decided', 5, 'No lawful basis scores 5 of 5.')] },
      { id: 'd2', section: 'Notice', text: 'Are people told their data is processed by an AI system?', options: [o('Yes', 0, 'Clear notice scores 0.'), o('Partly', 3, 'Partial notice scores 3 of 5.'), o('No', 5, 'No notice scores 5 of 5.')] },
      { id: 'd3', section: 'Retention', text: 'How long is personal data kept?', options: [o('Deleted within 30 days', 0, 'Short retention scores 0.'), o('Up to one year', 3, 'Retention up to a year scores 3 of 5.'), o('Indefinitely, or not decided', 5, 'Open-ended retention scores 5 of 5.')] },
      { id: 'd4', section: 'Rights', text: 'How can a person ask for access, correction or erasure?', options: [o('Self-service', 0, 'Self-service rights score 0.'), o('By writing to the Data Protection Officer', 2, 'A manual route scores 2 of 5.'), o('No route yet', 5, 'No route scores 5 of 5.')] },
      { id: 'd5', section: 'Transfers', text: 'Is personal data transferred outside India?', options: [o('No', 0, 'Data stays in India: 0.'), o('To a country not restricted by the government', 3, 'Permitted transfers score 3 of 5.'), o('Not known', 5, 'Unknown transfers score 5 of 5.')] },
      { id: 'd6', section: 'Security', text: 'Is access to personal data governed by a rule and recorded?', options: [o('Yes — held for approval and recorded', 0, 'Governed and recorded access scores 0.'), o('Recorded only', 2, 'Recording without a rule scores 2 of 5.'), o('No', 5, 'Ungoverned access scores 5 of 5.')] },
    ],
  },
};

/* ── More templates: framework checks aligned to verifier profiles, and pack admission ── */

/**
 * Template variants. The stored `template` is always one of the three base ids (risk_triage, impact,
 * data_protection) so every screen can read it; the variant says which question set it uses.
 */
export type VariantId = AssessmentTemplate | 'eu_ai_act' | 'iso42001' | 'pack_ledger1' | 'pack_invoice1' | 'pack_collect1';

export interface VariantDef extends Omit<TemplateDef, 'id'> {
  id: VariantId;
  base: AssessmentTemplate;
  kind: 'risk' | 'framework' | 'admission';
  /** the verifier profile this template is aligned to */
  profileId?: string;
  frameworkId?: string;
  packId?: PackId;
  /** level the template needs (none today: pack admission runs from L1, as a dry run below L2) */
  level?: LevelId;
  /** below this level an approved admission is a dry run: the pack's checks run and report, with no regulatory claim */
  liveFrom?: LevelId;
}

const FRAMEWORK_TEMPLATES: Record<'eu_ai_act' | 'iso42001', VariantDef> = {
  eu_ai_act: {
    id: 'eu_ai_act', base: 'impact', kind: 'framework', profileId: 'eu-ai-act-art12', frameworkId: 'euaiact',
    label: 'EU AI Act check (Art. 9–15, 26, 72)',
    purpose: 'Checks the deployer duties the EU AI Act places on a high-risk system: risk management, logs, transparency, human oversight and monitoring. Aligned to the eu-ai-act-art12 verifier profile.',
    when: 'Any system used in, or affecting people in, the European Union.',
    maxScore: 28,
    questions: [
      { id: 'e1', section: 'Art. 9 Risk management', text: 'Is there a documented risk-management process for this system, reviewed at a fixed interval?', options: [o('Yes — an approved assessment with a review date', 0, 'An approved assessment with a review date scores 0.'), o('Documented but not reviewed', 2, 'An unreviewed process scores 2 of 4.'), o('No', 4, 'No risk management scores 4 of 4.')] },
      { id: 'e2', section: 'Art. 12 Record-keeping', text: 'Are events logged automatically over the system’s lifetime, in a form an auditor can check?', options: [o('Yes — sealed, hash-chained receipts with external timestamps', 0, 'Sealed records with two timestamps meet Art. 12 and the eu-ai-act-art12 profile: 0.'), o('Signed, hash-chained receipts without external timestamps', 2, 'Signed records without timestamps score 2 of 4: the time of each event rests on our clock.'), o('Application logs only', 4, 'Ordinary logs score 4 of 4.')] },
      { id: 'e3', section: 'Art. 12 Record-keeping', text: 'Are logs kept for at least six months, write-once?', options: [o('Yes — write-once storage, 6 months or more', 0, 'Write-once retention scores 0.'), o('Kept, but can be changed or deleted', 2, 'Mutable retention scores 2 of 4.'), o('Not decided', 4, 'Undecided retention scores 4 of 4.')] },
      { id: 'e4', section: 'Art. 13 Transparency', text: 'Do deployers and affected people get instructions for use and know an AI system is involved?', options: [o('Yes', 0, 'Clear instructions and notice score 0.'), o('Partly', 2, 'Partial transparency scores 2 of 4.'), o('No', 4, 'No transparency scores 4 of 4.')] },
      { id: 'e5', section: 'Art. 14 Human oversight', text: 'Can a named person stop the system and approve high-impact actions before they run?', options: [o('Yes — held for a named approver, with pause and stop', 0, 'Approval before the call and an immediate stop score 0.'), o('Only after the action', 2, 'Review after the fact scores 2 of 4.'), o('No', 4, 'No human oversight scores 4 of 4.')] },
      { id: 'e6', section: 'Art. 26 and 72 Monitoring', text: 'Is the system’s behaviour monitored, with unusual behaviour raising an alert?', options: [o('Yes — detectors with alerts and auto-pause', 0, 'Active monitoring scores 0.'), o('Periodic review only', 2, 'Periodic review scores 2 of 4.'), o('No', 4, 'No monitoring scores 4 of 4.')] },
      { id: 'e7', section: 'Art. 73 Serious incidents', text: 'Is there a route to report a serious incident to the authority within the deadline?', options: [o('Yes — a named owner and a written procedure', 0, 'A written route scores 0.'), o('Informal', 2, 'An informal route scores 2 of 4.'), o('No', 4, 'No route scores 4 of 4.')] },
    ],
  },
  iso42001: {
    id: 'iso42001', base: 'impact', kind: 'framework', profileId: 'iso42001-nist', frameworkId: 'iso42001',
    label: 'ISO/IEC 42001 and NIST AI RMF check',
    purpose: 'Checks the AI management-system controls an ISO/IEC 42001 auditor samples, mapped to NIST AI RMF functions. Aligned to the iso42001-nist verifier profile.',
    when: 'Before a certification audit, and yearly after.',
    maxScore: 24,
    questions: [
      { id: 'n1', section: 'Govern', text: '6.1.2 / GOVERN 1 — Is the AI risk assessment approved by a person other than its author?', options: [o('Yes', 0, 'Two-person sign-off scores 0.'), o('Approved by the author', 2, 'Self-approval scores 2 of 4.'), o('No assessment', 4, 'No assessment scores 4 of 4.')] },
      { id: 'n2', section: 'Map', text: '6.1.4 / MAP 1 — Is the system’s impact on people and the organisation assessed and recorded?', options: [o('Yes', 0, 'A recorded impact assessment scores 0.'), o('Partly', 2, 'A partial assessment scores 2 of 4.'), o('No', 4, 'No impact assessment scores 4 of 4.')] },
      { id: 'n3', section: 'Measure', text: 'A.6.2.8 / MANAGE 4 — Are the system’s event logs complete and checkable offline?', options: [o('Yes — every decision is a sealed or signed receipt; an auditor verifies offline', 0, 'Offline-verifiable records score 0.'), o('Logs exist but cannot be checked independently', 2, 'Unverifiable logs score 2 of 4.'), o('No', 4, 'No event logs score 4 of 4.')] },
      { id: 'n4', section: 'Manage', text: 'A.9.2 / MANAGE 2 — Are changes to the system’s rules reviewed by a second person before they apply?', options: [o('Yes — enforced', 0, 'Enforced dual control scores 0.'), o('Recorded, not enforced', 2, 'Recorded review scores 2 of 4.'), o('No', 4, 'No review scores 4 of 4.')] },
      { id: 'n5', section: 'Manage', text: 'A.10.3 / MAP 4 — Are suppliers and counterparties that rely on the system’s output known and able to verify it?', options: [o('Yes — a counterparty register with verification', 0, 'Verified counterparties score 0.'), o('Known, not verifying', 2, 'A list without verification scores 2 of 4.'), o('No', 4, 'Unknown counterparties score 4 of 4.')] },
      { id: 'n6', section: 'Measure', text: '9.1 / MEASURE 3 — Are the system’s risks monitored over time, with incidents recorded?', options: [o('Yes', 0, 'Monitoring with incident records scores 0.'), o('Partly', 2, 'Partial monitoring scores 2 of 4.'), o('No', 4, 'No monitoring scores 4 of 4.')] },
    ],
  },
};

const met = (evidence: string) => o('Met', 0, `Gate met. ${evidence}`);
const notMet = (what: string) => o('Not met', 1, `Gate not met: ${what} The pack is not admitted for this system until it is.`);

function admission(packId: PackId): VariantDef {
  const pk = PACKS.find((p) => p.id === packId)!;
  return {
    id: `pack_${packId}` as VariantId, base: 'risk_triage', kind: 'admission', packId, profileId: pk.profileId, liveFrom: 'l2',
    label: `${pk.name} admission`,
    purpose: `Checks the five admission gates for ${pk.name} (${pk.regime}) on this system. Every gate must be met, and a different person must approve, before the pack’s rules are enabled for its agent.`,
    when: `Before ${pk.name}’s rules apply to an agent.`,
    maxScore: 5,
    questions: pk.gates.map((g) => ({ id: `${packId}-${g.id.toLowerCase()}`, section: `${g.id} ${g.label}`, text: `${g.description} For this system: ${g.evidence}`, options: [met(g.evidence), notMet(g.description)] })),
  };
}

export const VARIANTS: Record<VariantId, VariantDef> = {
  risk_triage: { ...TEMPLATES.risk_triage, id: 'risk_triage', base: 'risk_triage', kind: 'risk' },
  impact: { ...TEMPLATES.impact, id: 'impact', base: 'impact', kind: 'risk' },
  data_protection: { ...TEMPLATES.data_protection, id: 'data_protection', base: 'data_protection', kind: 'risk', profileId: 'in-dpdp', frameworkId: 'dpdp' },
  ...FRAMEWORK_TEMPLATES,
  pack_ledger1: admission('ledger1'),
  pack_invoice1: admission('invoice1'),
  pack_collect1: admission('collect1'),
};

export const VARIANT_ORDER: VariantId[] = ['risk_triage', 'impact', 'data_protection', 'eu_ai_act', 'iso42001', 'pack_ledger1', 'pack_invoice1', 'pack_collect1'];

/** The question set an assessment uses (its variant, or its base template). */
export function variantOf(a: Pick<Assessment, 'template'> & { variant?: VariantId }): VariantDef {
  return VARIANTS[a.variant ?? a.template] ?? VARIANTS[a.template];
}

export const variantLabel = (a: Pick<Assessment, 'template'> & { variant?: VariantId }) => variantOf(a).label;

/** Pack admission: every gate met. */
export function admissionOf(a: Pick<Assessment, 'questions'>): { met: number; total: number; admitted: boolean; complete: boolean } {
  const total = a.questions.length;
  const answered = a.questions.filter((q) => !!q.answer).length;
  const metCount = a.questions.filter((q) => q.answer === 'Met').length;
  return { met: metCount, total, admitted: metCount === total && total > 0, complete: answered === total };
}

/** Questions written on older template versions map to the current answer sets by their wording. */
const ALIASES: Record<string, string> = {
  'how long are summaries kept?': 'd3',
  'how does an applicant ask for erasure?': 'd4',
  'what is the lawful basis under dpdp?': 'd1',
  'is the model on the decision path?': 't6',
  'does it act on external parties?': 't2',
  'does it move money?': 't1',
  'can it be stopped at once?': 't8',
  'is there a human approval gate?': 'i7',
  'are decisions reversible?': 'i2',
  'who is affected if it errs?': 'i3',
  'does it process personal data?': 't5',
};

const BY_ID: Record<string, BankQuestion> = Object.fromEntries(Object.values(VARIANTS).flatMap((t) => t.questions.map((q) => [q.id, q])));

/** The answer set for a question, or a plain No / Partly / Yes scale when the wording is not in the bank. */
export function optionsFor(q: AssessmentQuestion, template: AssessmentTemplate, perQuestionMax: number): AnswerOption[] {
  const direct = BY_ID[q.id] && (BY_ID[q.id].text === q.text || q.id.includes('-g-')) ? BY_ID[q.id] : undefined;
  const alias = ALIASES[q.text.trim().toLowerCase()];
  const fromBank = direct ?? (alias ? BY_ID[alias] : undefined) ?? TEMPLATES[template].questions.find((b) => b.text.toLowerCase() === q.text.trim().toLowerCase());
  if (fromBank) return fromBank.options;
  const m = Math.max(2, perQuestionMax);
  const half = Math.round(m / 2);
  return [o('No', 0, 'No exposure scores 0.'), o('Partly', half, `Partial exposure scores ${half} of ${m}.`), o('Yes', m, `Full exposure scores ${m} of ${m}.`)];
}

/* ── Thresholds ───────────────────────────────────────────── */

export const THRESHOLDS = { high: 0.7, limited: 0.4 } as const;

export function bands(maxScore: number) {
  const high = Math.ceil(maxScore * THRESHOLDS.high);
  const limited = Math.ceil(maxScore * THRESHOLDS.limited);
  return [
    { tier: 'minimal' as RiskTier, from: 0, to: limited - 1 },
    { tier: 'limited' as RiskTier, from: limited, to: high - 1 },
    { tier: 'high' as RiskTier, from: high, to: maxScore },
  ];
}

export function tierFor(score: number, maxScore: number, prohibited = false): RiskTier {
  if (prohibited) return 'unacceptable';
  const b = bands(maxScore);
  return b.find((x) => score >= x.from && score <= x.to)?.tier ?? (score > maxScore ? 'high' : 'minimal');
}

export function isAnswered(q: AssessmentQuestion) {
  return !!q.answer && q.answer.trim().length > 0;
}

export interface ScoreSummary {
  score: number;
  maxScore: number;
  answered: number;
  total: number;
  complete: boolean;
  prohibited: boolean;
  tier: RiskTier;
}

export function prohibitedAnswer(q: AssessmentQuestion, template: AssessmentTemplate) {
  const opts = optionsFor(q, template, 5);
  return !!opts.find((x) => x.label === q.answer)?.prohibited;
}

export function summarise(a: Pick<Assessment, 'questions' | 'maxScore' | 'template'>): ScoreSummary {
  const score = a.questions.reduce((s, q) => s + (isAnswered(q) ? q.points : 0), 0);
  const answered = a.questions.filter(isAnswered).length;
  const prohibited = a.questions.some((q) => isAnswered(q) && prohibitedAnswer(q, a.template));
  return { score, maxScore: a.maxScore, answered, total: a.questions.length, complete: answered === a.questions.length, prohibited, tier: tierFor(score, a.maxScore, prohibited) };
}

/** Next review set on approval: 6 months for high and unacceptable, 12 for limited, 24 for minimal (low) and anything else. */
export function reviewMonths(tier: RiskTier) {
  return tier === 'high' || tier === 'unacceptable' ? 6 : tier === 'limited' ? 12 : 24;
}

/** The next-review date for a tier, in calendar months from `from` (the approval). One rule everywhere. */
export function nextReviewDate(tier: RiskTier, from = Date.now()): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + reviewMonths(tier));
  return d.toISOString();
}

export function newAssessmentFromTemplate(variant: VariantId, aiSystemId: string, authorId: string): Assessment & { variant: VariantId } {
  const t = VARIANTS[variant];
  return {
    id: `as_${variant}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    aiSystemId,
    template: t.base,
    variant,
    status: 'draft',
    score: 0,
    maxScore: t.maxScore,
    resultTier: 'unassessed',
    authorId,
    createdAt: new Date().toISOString(),
    questions: t.questions.map((q) => ({ id: q.id, section: q.section, text: q.text, answer: '', points: 0, explanation: '' })),
  };
}
