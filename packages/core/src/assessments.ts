// Built-in assessment templates and their scoring. Pure data and functions, no I/O.
// Templates live in code, versioned: an assessment stores the key and version it was
// answered against, so changing a template never changes an old result.

import type { RiskTier } from "./rulebook";

export type QuestionType = "single" | "multi" | "text" | "yes_no";

export interface AnswerOption {
  value: string;
  label: string;
  /** Points added to the score when chosen. */
  weight: number;
  /** Choosing this makes the result at least this tier, whatever the score. */
  forces?: RiskTier;
  /** In a multi question: cannot be combined with other options (e.g. "None of these"). */
  exclusive?: boolean;
}

export interface Question {
  id: string;
  text: string;
  help?: string;
  type: QuestionType;
  options?: AnswerOption[];
  optional?: boolean;
}

export interface TemplateSection {
  id: string;
  title: string;
  description?: string;
  questions: Question[];
}

export interface AssessmentTemplate {
  key: string;
  version: number;
  name: string;
  description: string;
  sections: TemplateSection[];
  /** The score at which the result becomes medium, and high. Below `medium` it is low. */
  thresholds: { medium: number; high: number };
}

export type Answers = Record<string, string | string[]>;

export const ASSESSMENT_STATUSES = ["draft", "submitted", "approved", "changes_requested"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export const STATUS_LABELS: Record<AssessmentStatus, string> = {
  draft: "Draft",
  submitted: "Waiting for review",
  approved: "Approved",
  changes_requested: "Changes requested",
};

const opt = (value: string, label: string, weight = 0, extra: Pick<AnswerOption, "forces" | "exclusive"> = {}): AnswerOption => ({ value, label, weight, ...extra });
/** A yes/no question's options. */
const yesNo = (yes: number, no: number, forces?: { yes?: RiskTier; no?: RiskTier }): AnswerOption[] => [
  opt("yes", "Yes", yes, forces?.yes ? { forces: forces.yes } : {}),
  opt("no", "No", no, forces?.no ? { forces: forces.no } : {}),
];
const NONE = (label = "None of these") => opt("none", label, 0, { exclusive: true });

const HIGH_RISK_AREA = { forces: "high" } as const;

export const TRIAGE: AssessmentTemplate = {
  key: "triage",
  version: 1,
  name: "AI risk triage",
  description: "Nine quick questions that set a starting risk tier. Use it for every new AI system.",
  thresholds: { medium: 5, high: 11 },
  sections: [
    {
      id: "use",
      title: "What it does",
      questions: [
        {
          id: "autonomy",
          type: "single",
          text: "How much does the system decide on its own?",
          options: [opt("informs", "It only gives information or drafts", 0), opt("recommends", "It recommends, and a person decides", 1), opt("decides", "It makes or carries out decisions without a person checking each one", 3)],
        },
        {
          id: "areas",
          type: "multi",
          text: "Is it used in any of these areas?",
          help: "Many AI rules, such as the EU AI Act's list of high-risk uses, treat these areas as high risk. Choosing any of them makes the result high.",
          options: [
            opt("employment", "Hiring, promotion, performance or firing", 3, HIGH_RISK_AREA),
            opt("credit", "Credit, insurance or other financial eligibility", 3, HIGH_RISK_AREA),
            opt("education", "Education, admissions or exams", 3, HIGH_RISK_AREA),
            opt("essential", "Access to health care, benefits, housing or utilities", 3, HIGH_RISK_AREA),
            opt("justice", "Policing, migration, courts or elections", 3, HIGH_RISK_AREA),
            opt("biometric", "Recognising people by face, voice or other body features", 3, HIGH_RISK_AREA),
            opt("safety", "Safety of machines, vehicles or critical infrastructure", 3, HIGH_RISK_AREA),
            NONE(),
          ],
        },
        { id: "external", type: "yes_no", text: "Does it talk to people outside the company directly, for example by chat, email or phone?", options: yesNo(2, 0) },
      ],
    },
    {
      id: "people",
      title: "People and data",
      questions: [
        {
          id: "affected",
          type: "multi",
          text: "Whose lives or work does its output affect?",
          options: [opt("employees", "Employees", 1), opt("customers", "Customers", 2), opt("public", "The public", 2), opt("patients", "Patients", 3), opt("children", "Children", 3), NONE("Nobody directly")],
        },
        {
          id: "data",
          type: "multi",
          text: "What kind of data does it use?",
          options: [opt("personal", "Personal details, such as names, phone numbers or ID numbers", 1), opt("financial", "Financial details, such as bank accounts or salaries", 2), opt("health", "Health information", 3), opt("biometric", "Biometric data, such as faces or fingerprints", 3), opt("children", "Children's data", 3), NONE("No personal data")],
        },
      ],
    },
    {
      id: "controls",
      title: "Controls",
      questions: [
        {
          id: "oversight",
          type: "single",
          text: "Does a person check its work?",
          options: [opt("always", "Every output, before it is used", 0), opt("sampled", "Now and then, by sampling", 1), opt("never", "Not routinely", 3)],
        },
        { id: "appeal", type: "yes_no", text: "Can someone affected ask a person to review a result?", options: yesNo(0, 2) },
        {
          id: "supplier",
          type: "single",
          text: "Who built the model behind it?",
          options: [opt("in_house", "We did", 0), opt("documented", "A vendor, and we have their documentation", 1), opt("opaque", "A vendor, and we know little about how it works", 2)],
        },
        { id: "notes", type: "text", text: "Anything else a reviewer should know?", optional: true },
      ],
    },
  ],
};

export const IMPACT: AssessmentTemplate = {
  key: "impact",
  version: 1,
  name: "AI impact assessment",
  description: "Who could be affected, how they could be harmed, and what is in place to prevent and put right harm. Inspired by the topics of a fundamental rights impact assessment (EU AI Act, Article 27). It does not on its own meet any legal requirement.",
  thresholds: { medium: 6, high: 14 },
  sections: [
    {
      id: "context",
      title: "Use and context",
      questions: [
        { id: "process", type: "text", text: "Describe the process the system is used in, and how its output is used.", help: "For example: screens loan applications and flags ones for a credit officer to review." },
        {
          id: "frequency",
          type: "single",
          text: "How often is it used?",
          options: [opt("occasional", "Occasionally", 0), opt("regular", "Regularly, every week", 1), opt("continuous", "Continuously, or for every case", 2)],
        },
        {
          id: "scale",
          type: "single",
          text: "About how many people does it affect in a year?",
          options: [opt("small", "Fewer than 100", 0), opt("medium", "100 to 10,000", 1), opt("large", "More than 10,000", 2)],
        },
      ],
    },
    {
      id: "people",
      title: "People affected",
      questions: [
        {
          id: "groups",
          type: "multi",
          text: "Which groups of people does it affect?",
          options: [
            opt("employees", "Employees", 1),
            opt("customers", "Customers", 1),
            opt("public", "The public", 2),
            opt("patients", "Patients", 2),
            opt("children", "Children", 3),
            opt("vulnerable", "People in vulnerable situations, for example elderly people, people with disabilities or people in financial difficulty", 3),
          ],
        },
        { id: "informed", type: "yes_no", text: "Are people told that AI is involved?", options: yesNo(0, 2) },
      ],
    },
    {
      id: "harms",
      title: "Possible harms",
      questions: [
        {
          id: "harm_types",
          type: "multi",
          text: "What could go wrong for the people affected?",
          options: [
            opt("discrimination", "Unfair treatment of a group, for example by gender, caste, religion, age or disability", 3),
            opt("privacy", "Loss of privacy", 2),
            opt("access", "Losing access to a job, money, a service or a benefit", 3),
            opt("safety", "Physical or health harm", 3, { forces: "high" }),
            opt("expression", "Limits on what people can say, see or find", 2),
            NONE("Nothing significant"),
          ],
        },
        {
          id: "severity",
          type: "single",
          text: "If it gets something wrong, how bad is it for the person?",
          options: [opt("minor", "Minor and easy to put right", 0), opt("significant", "Significant, but it can be put right", 2), opt("severe", "Severe or hard to undo", 4, { forces: "high" })],
        },
        {
          id: "bias_tested",
          type: "single",
          text: "Has it been tested for unfair results across groups of people?",
          options: [opt("recent", "Yes, in the last 12 months", 0), opt("old", "Yes, but more than a year ago", 1), opt("never", "No", 2)],
        },
      ],
    },
    {
      id: "oversight",
      title: "Oversight and remedies",
      questions: [
        { id: "overseer", type: "text", text: "Who oversees it, and how can they stop or override it?" },
        { id: "complaints", type: "yes_no", text: "Can people complain, or ask for a person to review a result?", options: yesNo(0, 3) },
        { id: "incident_plan", type: "yes_no", text: "Is there a plan for what to do if it causes harm?", options: yesNo(0, 2) },
      ],
    },
  ],
};

export const DATA_PROTECTION: AssessmentTemplate = {
  key: "data-protection",
  version: 1,
  name: "Data protection check",
  description: "A short privacy check: lawful basis and consent, using only the data needed, how long it is kept, transfers abroad and children's data. Inspired by data protection impact assessments under India's DPDP Act and the GDPR. It is not legal advice.",
  thresholds: { medium: 5, high: 12 },
  sections: [
    {
      id: "data",
      title: "Data used",
      questions: [
        {
          id: "categories",
          type: "multi",
          text: "What personal data does it use?",
          options: [opt("personal", "Contact or identity details", 1), opt("financial", "Financial details", 2), opt("health", "Health information", 3), opt("biometric", "Biometric data", 3), opt("children", "Children's data", 3), NONE("No personal data")],
        },
        {
          id: "source",
          type: "single",
          text: "Where does the data come from?",
          options: [opt("person", "Directly from the person", 0), opt("own_records", "Our own records", 0), opt("third_party", "Another company, or public sources", 1), opt("scraped", "Collected from the internet", 2)],
        },
      ],
    },
    {
      id: "basis",
      title: "Lawful basis and consent",
      questions: [
        {
          id: "lawful_basis",
          type: "single",
          text: "Why are you allowed to use this data?",
          help: "Pick the closest. If you are not sure, say so: a reviewer can help.",
          options: [
            opt("consent", "The person agreed to it", 0),
            opt("contract", "It is needed for a service they asked for", 0),
            opt("legal", "A law requires it", 0),
            opt("other", "Another reasonable purpose, such as employment or fraud prevention", 1),
            opt("unsure", "Not sure", 3),
          ],
        },
        { id: "notice", type: "yes_no", text: "Are people told, in plain language, how their data is used?", options: yesNo(0, 3) },
        { id: "rights", type: "yes_no", text: "Can people withdraw consent, or ask for their data to be corrected or deleted?", options: yesNo(0, 2) },
      ],
    },
    {
      id: "minimise",
      title: "Using only what is needed",
      questions: [
        { id: "minimal", type: "yes_no", text: "Does it use only the data it needs for its purpose?", options: yesNo(0, 2) },
        {
          id: "training",
          type: "single",
          text: "Is personal data used to train or improve a model?",
          options: [opt("no", "No", 0), opt("own", "Yes, our own model", 1), opt("vendor", "Yes, a vendor's model", 3)],
        },
        {
          id: "retention",
          type: "single",
          text: "How long is the data kept?",
          options: [opt("set", "For a set period, then deleted", 0), opt("indefinite", "Until someone deletes it", 2), opt("unknown", "We don't know", 3)],
        },
      ],
    },
    {
      id: "transfers",
      title: "Transfers, children and security",
      questions: [
        {
          id: "transfer",
          type: "single",
          text: "Is the data sent to or stored in another country?",
          options: [opt("no", "No", 0), opt("safeguarded", "Yes, with contracts and safeguards in place", 1), opt("unchecked", "Yes, and the safeguards have not been checked", 3)],
        },
        {
          id: "children_consent",
          type: "single",
          text: "If it could use children's data, is a parent's or guardian's consent checked first?",
          options: [opt("not_applicable", "It never uses children's data", 0), opt("yes", "Yes", 0), opt("no", "No", 4, { forces: "high" })],
        },
        { id: "security", type: "yes_no", text: "Is the data encrypted, with access limited to the people who need it?", options: yesNo(0, 2) },
        { id: "contact", type: "text", text: "Who answers questions about this data, for example your data protection officer?", optional: true },
      ],
    },
  ],
};

export const TEMPLATES: readonly AssessmentTemplate[] = [TRIAGE, IMPACT, DATA_PROTECTION];

export function getTemplate(key: string): AssessmentTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

export function questionsOf(t: AssessmentTemplate): Question[] {
  return t.sections.flatMap((s) => s.questions);
}

const TEXT_MAX = 2000;

const answered = (v: string | string[] | undefined) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim().length > 0);

/**
 * Checks answers against a template. `errors` lists answers that are not allowed at all;
 * `missing` lists required questions with no answer (fine for a draft, not for submitting).
 */
export function checkAnswers(t: AssessmentTemplate, answers: Answers): { errors: string[]; missing: string[] } {
  const qs = questionsOf(t);
  const errors: string[] = [];
  for (const [id, v] of Object.entries(answers)) {
    const q = qs.find((x) => x.id === id);
    if (!q) {
      errors.push(`"${id}" is not a question in this assessment.`);
      continue;
    }
    if (q.type === "text") {
      if (typeof v !== "string") errors.push(`"${q.text}" needs a written answer.`);
      else if (v.length > TEXT_MAX) errors.push(`"${q.text}" can be at most ${TEXT_MAX} characters.`);
      continue;
    }
    const allowed = new Set((q.options ?? []).map((o) => o.value));
    if (q.type === "multi") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !allowed.has(x))) errors.push(`"${q.text}" has an answer that is not one of the choices.`);
      else if (new Set(v).size !== v.length) errors.push(`"${q.text}" has the same choice twice.`);
      else if (v.length > 1 && v.some((x) => q.options!.find((o) => o.value === x)?.exclusive)) errors.push(`"${q.text}": "None" cannot be combined with other choices.`);
      continue;
    }
    if (typeof v !== "string" || !allowed.has(v)) errors.push(`"${q.text}" has an answer that is not one of the choices.`);
  }
  const missing = qs.filter((q) => !q.optional && !answered(answers[q.id])).map((q) => q.id);
  return { errors, missing };
}

export interface ScoreReason {
  questionId: string;
  question: string;
  answer: string;
  points: number;
  forces?: RiskTier;
}

export interface AssessmentResult {
  score: number;
  maxScore: number;
  tier: RiskTier;
  /** Answers that added points or forced the tier, highest first. */
  reasons: ScoreReason[];
  /** Answers that forced the tier up regardless of the score. */
  forcedBy: ScoreReason[];
}

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

/** The highest of several tiers; low when there are none. */
export function highestTier(tiers: Iterable<RiskTier>): RiskTier {
  let top: RiskTier = "low";
  for (const t of tiers) if (TIER_RANK[t] > TIER_RANK[top]) top = t;
  return top;
}

export function tierForScore(t: AssessmentTemplate, score: number): RiskTier {
  if (score >= t.thresholds.high) return "high";
  if (score >= t.thresholds.medium) return "medium";
  return "low";
}

function maxPoints(q: Question): number {
  const ws = (q.options ?? []).map((o) => o.weight);
  if (!ws.length) return 0;
  return q.type === "multi" ? ws.filter((w) => w > 0).reduce((a, b) => a + b, 0) : Math.max(...ws);
}

/** Deterministic score and tier. Unanswered and unknown answers count as zero. */
export function scoreAssessment(t: AssessmentTemplate, answers: Answers): AssessmentResult {
  const reasons: ScoreReason[] = [];
  let score = 0;
  let maxScore = 0;
  for (const q of questionsOf(t)) {
    maxScore += maxPoints(q);
    if (q.type === "text") continue;
    const raw = answers[q.id];
    const chosen = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    for (const v of chosen) {
      const o = q.options?.find((x) => x.value === v);
      if (!o) continue;
      score += o.weight;
      if (o.weight > 0 || o.forces) reasons.push({ questionId: q.id, question: q.text, answer: o.label, points: o.weight, ...(o.forces ? { forces: o.forces } : {}) });
    }
  }
  const forcedBy = reasons.filter((r) => r.forces);
  const tier = highestTier([tierForScore(t, score), ...forcedBy.map((r) => r.forces!)]);
  reasons.sort((a, b) => b.points - a.points);
  return { score, maxScore, tier, reasons, forcedBy };
}

/** One plain sentence explaining a result. */
export function explainResult(t: AssessmentTemplate, r: AssessmentResult): string {
  const base = `Score ${r.score} of ${r.maxScore}. Medium starts at ${t.thresholds.medium} and high at ${t.thresholds.high}.`;
  if (r.forcedBy.length && tierForScore(t, r.score) !== r.tier) {
    return `${base} The result is ${r.tier} because of the answer "${r.forcedBy[0]!.answer}".`;
  }
  return base;
}

/** Months until the next review after approval, by tier. */
export const REVIEW_MONTHS: Record<RiskTier, number> = { high: 6, medium: 12, low: 24 };

export function nextReviewDate(tier: RiskTier, from: Date): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + REVIEW_MONTHS[tier]);
  // Clamp to the last day of the month (31 Aug + 6 months is 28 or 29 Feb, not 3 Mar).
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export type AssessmentAction = "save" | "submit" | "approve" | "request_changes";

/** The status after an action, or null when the action is not allowed from this status. */
export function nextStatus(status: AssessmentStatus, action: AssessmentAction): AssessmentStatus | null {
  const editable = status === "draft" || status === "changes_requested";
  switch (action) {
    case "save":
      return editable ? status : null;
    case "submit":
      return editable ? "submitted" : null;
    case "approve":
      return status === "submitted" ? "approved" : null;
    case "request_changes":
      return status === "submitted" ? "changes_requested" : null;
  }
}

/** Separation of duties: why this person may not review, or null if they may. */
export function reviewProblem(a: { status: AssessmentStatus; submittedById: string | null }, reviewerId: string): string | null {
  if (a.status !== "submitted") return "Only a submitted assessment can be reviewed.";
  if (a.submittedById === reviewerId) return "You submitted this assessment, so someone else has to review it.";
  return null;
}
