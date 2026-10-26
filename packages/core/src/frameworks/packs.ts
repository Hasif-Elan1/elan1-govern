import type { RiskAnswers } from "../risk";
import type { Quota, RiskTier, Rule, Rulebook } from "../rulebook";
import { isKnownTool, TOOLS, type RiskTag } from "../tools";
import type { Region } from "./frameworks";

/**
 * Industry packs: a starting point for an organisation in one line of work. Each pack says
 * what usually goes wrong, which frameworks to look at (by where you operate), a starter
 * rulebook and which controls matter most.
 *
 * Starter rules mostly target risk tags rather than tools, so they work with any tool a
 * connector offers. Money rules read a field called `amount`; a money tool without one
 * gets no allow rule and is refused (fail closed). The finance pack keeps the Gmail and
 * Zoho Books rules of the accounts-payable demo.
 */

export type QuestionId = keyof RiskAnswers;

export interface IndustryPack {
  id: string;
  name: string;
  /** A few words for pickers. */
  summary: string;
  description: string;
  /** What agents in this industry typically do. */
  examples: string[];
  risks: string[];
  /** Frameworks to enable. With `regions`, only when the org operates in one of them. */
  frameworks: { framework: string; regions?: Region[]; why?: string }[];
  /** The approver group the starter rules ask. */
  approverGroup: string;
  /** Built-in connectors the starter rules name by tool. Tag rules apply to every connector. */
  connectors: string[];
  starter: { rules: Rule[]; quotas?: Quota[]; limits?: { daily_payments_inr?: number } };
  /** Industry wording for the risk questions in the add-agent wizard. */
  questions: Partial<Record<QuestionId, string>>;
  /** Example purpose for the add-agent wizard. */
  purposeExample: string;
  agentNameExample: string;
  /** Control ids (GATE-xx) that matter most for this industry. */
  controls: string[];
}

const BASE_CONTROLS = ["GATE-01", "GATE-02", "GATE-04", "GATE-05", "GATE-06", "GATE-07", "GATE-12", "GATE-13"];

/** Rules every tag-based pack shares: nothing is deleted, access changes and money wait for a person. */
function guardrails(group: string): Rule[] {
  return [
    { id: "no-deletes", tag: "deletes", decide: "refuse", reason: "Deleting records is done by a person." },
    { id: "access-changes", tag: "changes_access", decide: "ask", approver: group, expires_in: "24h", reason: "Changes to who can access what are checked by a person." },
  ];
}

const moneyAsk = (group: string): Rule => ({ id: "money-ask", tag: "moves_money", decide: "ask", approver: group, expires_in: "24h", reason: "Anything that moves money is approved by a person." });

const FINANCE: IndustryPack = {
  id: "finance",
  name: "Finance and accounting",
  summary: "Invoices, bills and payments. Includes the demo.",
  description: "Agents that read invoices, create bills, reconcile accounts and record payments. This is the accounts-payable demo: Gmail and Zoho Books.",
  examples: ["Accounts-payable agent that pays vendor invoices", "Reconciliation assistant", "Expense report checker"],
  risks: ["Paying the wrong amount or the wrong vendor", "Invoice fraud, such as a changed bank account", "Payments that skip an approval limit", "Vendor and employee personal data in emails"],
  frameworks: [
    { framework: "iso-42001" },
    { framework: "nist-ai-rmf" },
    { framework: "dpdp", regions: ["india"] },
    { framework: "rbi-free-ai", regions: ["india"], why: "If you are an RBI-regulated entity" },
    { framework: "eu-ai-act", regions: ["eu"] },
    { framework: "gdpr", regions: ["eu", "uk"] },
    { framework: "soc2", regions: ["us"] },
  ],
  approverGroup: "finance",
  connectors: ["gmail", "zoho"],
  starter: {
    limits: { daily_payments_inr: 2000000 },
    rules: [
      { id: "read-mail", tool: "gmail.read_message", decide: "allow" },
      { id: "search-mail", tool: "gmail.search", decide: "allow" },
      { id: "open-attachments", tool: "gmail.get_attachment", decide: "allow" },
      { id: "list-bills", tool: "zoho.list_bills", decide: "allow" },
      { id: "look-up-vendor", tool: "zoho.get_vendor", decide: "allow" },
      { id: "draft-replies", tool: "gmail.draft_reply", decide: "allow" },
      { id: "reply-vendor", tool: "gmail.send_reply", when: { to_domain_in: "vendor_domains" }, decide: "ask", approver: "finance", reason: "Emails to vendors are read by a person before they go out." },
      { id: "create-bills", tool: "zoho.create_bill", decide: "allow" },
      { id: "pay-small", tool: "zoho.record_bill_payment", when: { amount_inr: { lte: 50000 } }, decide: "allow" },
      { id: "pay-large", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 50000 } }, decide: "ask", approver: "finance", expires_in: "24h", reason: "Payments over ₹50,000 need someone in finance to approve them." },
      { id: "no-bank-change", tool: "zoho.update_vendor", when: { fields_include: ["bank_account", "ifsc"] }, decide: "refuse", reason: "Bank details are only changed by a person, after calling the vendor on a known number." },
    ],
  },
  questions: {
    money: "Can this agent record or make payments?",
    personal: "Will it see personal details, such as PAN, phone numbers or bank accounts?",
  },
  purposeExample: "Reads vendor invoices from Gmail, creates bills in Zoho Books and records payments.",
  agentNameExample: "AP bot",
  controls: ["GATE-01", "GATE-02", "GATE-03", "GATE-04", "GATE-05", "GATE-06", "GATE-07", "GATE-08", "GATE-09", "GATE-10", "GATE-11", "GATE-12", "GATE-13"],
};

const HEALTHCARE: IndustryPack = {
  id: "healthcare",
  name: "Healthcare",
  summary: "Patient messages and scheduling",
  description: "Patient-communication and scheduling assistants: booking and moving appointments, sending reminders, answering routine questions.",
  examples: ["Appointment scheduling assistant", "Reminder and follow-up messages", "Front-desk inbox triage"],
  risks: ["Health information sent to the wrong person", "Messages to patients that sound like medical advice", "Seeing more patient data than the task needs", "Records changed or removed without a person noticing"],
  frameworks: [
    { framework: "iso-42001" },
    { framework: "nist-ai-rmf" },
    { framework: "hipaa", regions: ["us"], why: "If you are a covered entity or business associate" },
    { framework: "soc2", regions: ["us"] },
    { framework: "gdpr", regions: ["eu", "uk"] },
    { framework: "eu-ai-act", regions: ["eu"] },
    { framework: "dpdp", regions: ["india"] },
  ],
  approverGroup: "clinic-staff",
  connectors: [],
  starter: {
    rules: [
      { id: "read-records", tag: "reads_data", decide: "allow" },
      { id: "update-schedule", tag: "writes_data", decide: "allow" },
      { id: "message-patients", tag: "sends_external", decide: "ask", approver: "clinic-staff", expires_in: "4h", reason: "Messages to patients are read by a member of staff before they go out." },
      moneyAsk("clinic-staff"),
      ...guardrails("clinic-staff"),
    ],
    quotas: [
      { id: "messages-per-hour", tag: "sends_external", window: "1h", max_count: 50 },
      { id: "changes-per-day", tag: "writes_data", window: "day", max_count: 300 },
    ],
  },
  questions: {
    money: "Can this agent take payments or issue refunds?",
    external: "Can it message patients or anyone outside your practice?",
    personal: "Will it see patient details, such as names, dates of birth, appointments or health information?",
  },
  purposeExample: "Books and reschedules patient appointments and sends reminders by email.",
  agentNameExample: "Scheduling assistant",
  controls: [...BASE_CONTROLS, "GATE-08", "GATE-09", "GATE-10", "GATE-11"],
};

const HR: IndustryPack = {
  id: "hr",
  name: "HR and recruiting",
  summary: "Screening candidates and arranging interviews",
  description: "Screening assistants that read applications, shortlist candidates and arrange interviews. Hiring tools are regulated in several places: NYC Local Law 144 needs a bias audit, Colorado treats employment decisions as consequential, and the EU AI Act lists employment uses as high-risk.",
  examples: ["CV screening and shortlisting", "Interview scheduling", "Candidate follow-up emails"],
  risks: ["Unfair or discriminatory screening", "Decisions about people made without a person", "Candidate personal data shared too widely", "Candidates not told that an automated tool is used"],
  frameworks: [
    { framework: "iso-42001" },
    { framework: "nist-ai-rmf" },
    { framework: "nyc-ll144", regions: ["us"], why: "If you hire or promote in New York City" },
    { framework: "colorado-ai-act", regions: ["us"], why: "If decisions affect people in Colorado" },
    { framework: "eu-ai-act", regions: ["eu"] },
    { framework: "gdpr", regions: ["eu", "uk"] },
    { framework: "dpdp", regions: ["india"] },
  ],
  approverGroup: "hr",
  connectors: [],
  starter: {
    rules: [
      { id: "read-applications", tag: "reads_data", decide: "allow" },
      { id: "candidate-changes", tag: "writes_data", decide: "ask", approver: "hr", expires_in: "2d", reason: "A person confirms every change to a candidate's status." },
      { id: "email-candidates", tag: "sends_external", decide: "ask", approver: "hr", expires_in: "24h", reason: "Emails to candidates are read by someone in HR first." },
      moneyAsk("hr"),
      ...guardrails("hr"),
    ],
    quotas: [{ id: "emails-per-hour", tag: "sends_external", window: "1h", max_count: 50 }],
  },
  questions: {
    money: "Can this agent make or change payments, such as payroll or reimbursements?",
    external: "Can it email candidates or anyone outside your company?",
    personal: "Will it see candidate or employee details, such as CVs, contact details or salaries?",
  },
  purposeExample: "Reads applications for open roles, suggests a shortlist and proposes interview times.",
  agentNameExample: "Screening assistant",
  controls: [...BASE_CONTROLS, "GATE-03", "GATE-08"],
};

const SUPPORT: IndustryPack = {
  id: "support",
  name: "Customer support",
  summary: "Customer replies, refunds and account changes",
  description: "Support agents that answer customers, issue small refunds and update accounts.",
  examples: ["Help-desk reply assistant", "Refunds and credits", "Account and address changes"],
  risks: ["Refunds that are too large or too frequent", "Account takeover through a changed email or phone number", "Replies that promise what the company cannot do", "Customer personal data in tickets"],
  frameworks: [
    { framework: "iso-42001" },
    { framework: "nist-ai-rmf" },
    { framework: "soc2", regions: ["us"] },
    { framework: "gdpr", regions: ["eu", "uk"] },
    { framework: "eu-ai-act", regions: ["eu"], why: "Chat assistants must say they are AI (Art. 50)" },
    { framework: "dpdp", regions: ["india"] },
  ],
  approverGroup: "support-leads",
  connectors: [],
  starter: {
    rules: [
      { id: "read-tickets", tag: "reads_data", decide: "allow" },
      { id: "update-tickets", tag: "writes_data", decide: "allow" },
      { id: "reply-customers", tag: "sends_external", decide: "allow" },
      { id: "refund-small", tag: "moves_money", when: { amount: { lte: 500 } }, decide: "allow" },
      { id: "refund-large", tag: "moves_money", when: { amount: { gt: 500 } }, decide: "ask", approver: "support-leads", expires_in: "24h", reason: "Refunds over 500 in your currency need a support lead." },
      ...guardrails("support-leads"),
    ],
    quotas: [
      { id: "replies-per-hour", tag: "sends_external", window: "1h", max_count: 50, approver: "support-leads" },
      { id: "refunds-per-day", tag: "moves_money", window: "day", max_count: 20, approver: "support-leads" },
    ],
  },
  questions: {
    money: "Can this agent issue refunds or credits?",
    external: "Can it reply to customers directly?",
    personal: "Will it see customer details, such as addresses, phone numbers or order history?",
  },
  purposeExample: "Answers customer emails, issues refunds for damaged orders and updates delivery addresses.",
  agentNameExample: "Support assistant",
  controls: [...BASE_CONTROLS, "GATE-08", "GATE-09", "GATE-11"],
};

const SALES: IndustryPack = {
  id: "sales",
  name: "Sales and marketing",
  summary: "Outreach and CRM updates",
  description: "Outreach agents that research prospects, write and send emails, and update the CRM.",
  examples: ["Prospect research and outreach", "Follow-up emails after a demo", "CRM clean-up"],
  risks: ["Sending too many messages, or to people who opted out", "Claims about the product that are not true", "Prospect personal data used without a lawful basis", "Discounts given without approval"],
  frameworks: [
    { framework: "iso-42001" },
    { framework: "nist-ai-rmf" },
    { framework: "gdpr", regions: ["eu", "uk"] },
    { framework: "eu-ai-act", regions: ["eu"] },
    { framework: "dpdp", regions: ["india"] },
    { framework: "soc2", regions: ["us"] },
  ],
  approverGroup: "marketing",
  connectors: [],
  starter: {
    rules: [
      { id: "read-crm", tag: "reads_data", decide: "allow" },
      { id: "update-crm", tag: "writes_data", decide: "allow" },
      { id: "send-outreach", tag: "sends_external", decide: "allow" },
      moneyAsk("marketing"),
      ...guardrails("marketing"),
    ],
    quotas: [
      { id: "outreach-per-hour", tag: "sends_external", window: "1h", max_count: 50, approver: "marketing" },
      { id: "outreach-per-day", tag: "sends_external", window: "day", max_count: 200, approver: "marketing" },
    ],
  },
  questions: {
    money: "Can this agent offer discounts or take payments?",
    external: "Can it email or message prospects and customers?",
    personal: "Will it see contact details of prospects or customers?",
  },
  purposeExample: "Researches prospects, sends a first email and logs replies in the CRM.",
  agentNameExample: "Outreach assistant",
  controls: [...BASE_CONTROLS, "GATE-08"],
};

const ENGINEERING: IndustryPack = {
  id: "engineering",
  name: "Engineering and DevOps",
  summary: "Deploys, restarts and access changes",
  description: "Agents that open pull requests, run deploys, restart services and manage access.",
  examples: ["Deploy and rollback assistant", "On-call helper that restarts services", "Access request handler"],
  risks: ["A bad change reaching production", "Access granted to the wrong person", "Data deleted by mistake", "Secrets exposed in logs or messages"],
  frameworks: [
    { framework: "iso-42001" },
    { framework: "nist-ai-rmf" },
    { framework: "soc2", why: "Change management and access controls" },
    { framework: "eu-ai-act", regions: ["eu"] },
    { framework: "gdpr", regions: ["eu", "uk"] },
    { framework: "dpdp", regions: ["india"] },
  ],
  approverGroup: "engineering",
  connectors: [],
  starter: {
    rules: [
      { id: "read-systems", tag: "reads_data", decide: "allow" },
      { id: "change-records", tag: "writes_data", decide: "allow" },
      { id: "production-changes", tag: "changes_production", decide: "ask", approver: "engineering", expires_in: "4h", reason: "Production changes are approved by an engineer." },
      { id: "contact-outside", tag: "sends_external", decide: "ask", approver: "engineering", expires_in: "24h", reason: "Messages outside the company are read by a person first." },
      moneyAsk("engineering"),
      ...guardrails("engineering"),
    ],
    quotas: [{ id: "deploys-per-day", tag: "changes_production", window: "day", max_count: 10 }],
  },
  questions: {
    money: "Can this agent spend money, such as buying cloud resources?",
    external: "Can it message people outside your company, such as customers or vendors?",
    personal: "Will it see personal data, such as user records or logs with personal details?",
  },
  purposeExample: "Opens pull requests, deploys approved changes and restarts failing services.",
  agentNameExample: "Deploy bot",
  controls: [...BASE_CONTROLS, "GATE-09", "GATE-11"],
};

const GENERAL: IndustryPack = {
  id: "general",
  name: "General",
  summary: "Anything else, with careful defaults",
  description: "A careful default for any other kind of work: reading is allowed, anything that leaves the company, moves money or changes access waits for a person, and nothing is deleted.",
  examples: ["Research assistant", "Operations helper", "Internal knowledge assistant"],
  risks: ["Acting outside its purpose", "Contacting people outside the company", "Seeing personal data it does not need", "Changes nobody reviewed"],
  frameworks: [
    { framework: "iso-42001" },
    { framework: "nist-ai-rmf" },
    { framework: "eu-ai-act", regions: ["eu"] },
    { framework: "gdpr", regions: ["eu", "uk"] },
    { framework: "dpdp", regions: ["india"] },
    { framework: "soc2", regions: ["us"] },
  ],
  approverGroup: "reviewers",
  connectors: [],
  starter: {
    rules: [
      { id: "read-data", tag: "reads_data", decide: "allow" },
      { id: "change-records", tag: "writes_data", decide: "allow" },
      { id: "contact-outside", tag: "sends_external", decide: "ask", approver: "reviewers", expires_in: "24h", reason: "Messages outside the company are read by a person first." },
      moneyAsk("reviewers"),
      { id: "production-changes", tag: "changes_production", decide: "ask", approver: "reviewers", expires_in: "4h", reason: "Production changes are approved by a person." },
      ...guardrails("reviewers"),
    ],
    quotas: [
      { id: "messages-per-hour", tag: "sends_external", window: "1h", max_count: 50 },
      { id: "changes-per-day", tag: "writes_data", window: "day", max_count: 500 },
    ],
  },
  questions: {},
  purposeExample: "Summarises new requests in the shared inbox and drafts replies for the team.",
  agentNameExample: "Inbox assistant",
  controls: BASE_CONTROLS,
};

export const PACKS: IndustryPack[] = [FINANCE, HEALTHCARE, HR, SUPPORT, SALES, ENGINEERING, GENERAL];
export const PACK_IDS = PACKS.map((p) => p.id);

/**
 * Orgs created before industry packs were all set up for the accounts-payable demo,
 * so an org with no industry gets the finance pack.
 */
export const DEFAULT_PACK_ID = "finance";

export function packById(id: string | null | undefined): IndustryPack | undefined {
  return PACKS.find((p) => p.id === id);
}

export function packFor(industry: string | null | undefined): IndustryPack {
  return packById(industry) ?? (packById(DEFAULT_PACK_ID) as IndustryPack);
}

/** The frameworks a pack recommends for the places an org operates, in the pack's order. */
export function recommendedFrameworks(pack: IndustryPack, regions: readonly Region[]): string[] {
  return pack.frameworks.filter((f) => !f.regions || f.regions.some((x) => regions.includes(x))).map((f) => f.framework);
}

// ---- Starter rulebooks ----

function tagsOf(target: { tool?: string; tag?: RiskTag }): RiskTag[] {
  if (target.tag) return [target.tag];
  return target.tool && isKnownTool(target.tool) ? TOOLS[target.tool].tags : [];
}

/** Approver groups named by rules and quotas. */
export function approverGroupsOf(rules: readonly Rule[], quotas: readonly Quota[] = []): string[] {
  return [...new Set([...rules, ...quotas].map((x) => x.approver).filter((g): g is string => !!g))];
}

/** A pack's starter rulebook, unsigned. `approvers` fills every group the rules name. */
export function starterRulebook(pack: IndustryPack, input: { agent: string; owner: string; approvers: string[] }): Rulebook {
  const list = [...new Set([input.owner, ...input.approvers].map((e) => e.toLowerCase()))];
  const { rules, quotas, limits } = pack.starter;
  return {
    version: 1,
    agent: input.agent,
    owner: input.owner,
    default: "refuse",
    approvers: Object.fromEntries(approverGroupsOf(rules, quotas).map((g) => [g, list])),
    ...(limits ? { limits } : {}),
    ...(quotas?.length ? { quotas } : {}),
    rules,
  };
}

/**
 * The add-agent wizard's starter rules: the questionnaire's suggestions (tuned to the risk
 * answers, for the pack's built-in tools) plus the pack's rules and quotas. A suggestion wins
 * over a pack rule with the same id. When the answers say the agent never moves money or never
 * contacts anyone outside, those rules are swapped for a refusal (so a broad "changes records"
 * rule cannot let a payment through), and a high-risk agent asks before changing records.
 */
export function mergeStarterRules(pack: IndustryPack, suggested: readonly Rule[], answers: RiskAnswers, tier: RiskTier): { rules: Rule[]; quotas: Quota[] } {
  const refusals: Rule[] = [];
  if (answers.money === "no") refusals.push({ id: "no-money", tag: "moves_money", decide: "refuse", reason: "This agent does not move money." });
  if (answers.external === "no") refusals.push({ id: "no-outside-contact", tag: "sends_external", decide: "refuse", reason: "This agent does not contact anyone outside the company." });
  const excluded = new Set(refusals.map((r) => r.tag as RiskTag));
  const relevant = (x: { tool?: string; tag?: RiskTag }) => !tagsOf(x).some((t) => excluded.has(t));

  const fromSuggestions = suggested.filter((r) => r.tool && pack.connectors.includes(r.tool.split(".")[0] as string));
  const ids = new Set(fromSuggestions.map((r) => r.id));
  const fromPack = pack.starter.rules
    .filter((r) => !ids.has(r.id) && relevant(r))
    .map((r): Rule => (tier === "high" && r.tag === "writes_data" && r.decide === "allow" ? { ...r, decide: "ask", approver: pack.approverGroup, reason: "High-risk agents ask a person before changing records." } : r));
  return { rules: [...fromSuggestions, ...fromPack, ...refusals], quotas: (pack.starter.quotas ?? []).filter(relevant) };
}
