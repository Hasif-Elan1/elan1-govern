import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";
import { forOrg } from "./tenant";

/**
 * Seed data for the compliance map. DRAFT — NEEDS LEGAL REVIEW.
 *
 * Each control is something Gate actually does. The clause references point to where a
 * reviewer might look; they are not claims that using Gate satisfies any law or standard.
 * Edit this file (and re-run the seed) to change them for your organisation.
 */
export interface ControlSeed {
  code: string;
  title: string;
  description: string;
  /** Which receipts count as evidence. */
  evidence: EvidenceKey;
  mappings: { framework: Framework; clause: string; note: string }[];
}

export const FRAMEWORKS = ["DPDP Act 2023", "RBI FREE-AI", "ISO/IEC 42001", "EU AI Act", "NIST AI RMF"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export type EvidenceKey =
  | "decisions"
  | "default_refusals"
  | "approvals"
  | "self_approvals"
  | "receipts"
  | "rulebooks"
  | "kill_switch"
  | "agents"
  | "connectors"
  | "settings";

export const CONTROLS: ControlSeed[] = [
  {
    code: "GATE-01",
    title: "Agents can only do what a rule allows",
    description: "Every tool call is checked against the agent's signed rulebook. Anything not allowed is refused by default.",
    evidence: "default_refusals",
    mappings: [
      { framework: "EU AI Act", clause: "Art. 9", note: "Risk management system" },
      { framework: "ISO/IEC 42001", clause: "Annex A.9", note: "Use of AI systems" },
      { framework: "NIST AI RMF", clause: "MANAGE 1.3", note: "Responses to identified risks" },
      { framework: "RBI FREE-AI", clause: "Governance pillar", note: "Map to the specific recommendation" },
    ],
  },
  {
    code: "GATE-02",
    title: "A person approves high-impact actions",
    description: "Rules can require a named approver before an action runs, such as large payments.",
    evidence: "approvals",
    mappings: [
      { framework: "EU AI Act", clause: "Art. 14", note: "Human oversight" },
      { framework: "ISO/IEC 42001", clause: "Annex A.9", note: "Use of AI systems" },
      { framework: "NIST AI RMF", clause: "GOVERN 3.2", note: "Human-AI configurations and oversight roles" },
      { framework: "RBI FREE-AI", clause: "Governance pillar", note: "Human oversight of AI decisions" },
    ],
  },
  {
    code: "GATE-03",
    title: "Separation of duties on approvals",
    description: "Approvals by the person who set up the agent are flagged on the receipt.",
    evidence: "self_approvals",
    mappings: [
      { framework: "ISO/IEC 42001", clause: "Annex A.3", note: "Internal organisation, roles and responsibilities" },
      { framework: "NIST AI RMF", clause: "GOVERN 2.1", note: "Roles and responsibilities are documented" },
    ],
  },
  {
    code: "GATE-04",
    title: "Tamper-evident record of every decision",
    description: "Receipts are hash-chained, signed and checkpointed, and can be verified offline.",
    evidence: "receipts",
    mappings: [
      { framework: "EU AI Act", clause: "Art. 12", note: "Record-keeping" },
      { framework: "ISO/IEC 42001", clause: "Clause 9.1", note: "Monitoring, measurement, analysis and evaluation" },
      { framework: "NIST AI RMF", clause: "MEASURE 2.8", note: "Transparency and accountability" },
      { framework: "RBI FREE-AI", clause: "Assurance pillar", note: "Audit and monitoring" },
    ],
  },
  {
    code: "GATE-05",
    title: "Signed, versioned rulebooks",
    description: "Policy changes create a new signed version. Old versions stay readable.",
    evidence: "rulebooks",
    mappings: [
      { framework: "ISO/IEC 42001", clause: "Clause 7.5", note: "Documented information" },
      { framework: "NIST AI RMF", clause: "GOVERN 1.4", note: "Risk management process is documented" },
      { framework: "RBI FREE-AI", clause: "Policy pillar", note: "Board-approved AI policy" },
    ],
  },
  {
    code: "GATE-06",
    title: "Kill switch for every agent",
    description: "Pausing an agent refuses all of its calls immediately.",
    evidence: "kill_switch",
    mappings: [
      { framework: "NIST AI RMF", clause: "MANAGE 2.4", note: "Mechanisms to disengage or deactivate AI systems" },
      { framework: "EU AI Act", clause: "Art. 14", note: "Ability to interrupt the system" },
    ],
  },
  {
    code: "GATE-07",
    title: "Registry of agents, owners and risk tiers",
    description: "Every agent has an owner, a purpose, a risk tier and the tools it can reach.",
    evidence: "agents",
    mappings: [
      { framework: "ISO/IEC 42001", clause: "Annex A.5", note: "Assessing impacts of AI systems" },
      { framework: "NIST AI RMF", clause: "MAP 1.1", note: "Intended purposes and context are understood" },
      { framework: "EU AI Act", clause: "Art. 26", note: "Obligations of deployers" },
      { framework: "RBI FREE-AI", clause: "Governance pillar", note: "Inventory of AI use" },
    ],
  },
  {
    code: "GATE-08",
    title: "Minimal personal data in logs",
    description: "Receipts keep a hash of the arguments and only the fields a rule checked. Email bodies and prompts are never stored.",
    evidence: "decisions",
    mappings: [
      { framework: "DPDP Act 2023", clause: "Sec. 8(5)", note: "Reasonable security safeguards" },
      { framework: "ISO/IEC 42001", clause: "Annex A.7", note: "Data for AI systems" },
      { framework: "RBI FREE-AI", clause: "Protection pillar", note: "Data protection" },
    ],
  },
  {
    code: "GATE-09",
    title: "Agents never hold credentials",
    description: "OAuth tokens stay encrypted inside Gate. The agent only gets an API key it can lose without exposing Gmail or Zoho Books.",
    evidence: "connectors",
    mappings: [
      { framework: "DPDP Act 2023", clause: "Sec. 8(5)", note: "Reasonable security safeguards" },
      { framework: "EU AI Act", clause: "Art. 15", note: "Accuracy, robustness and cybersecurity" },
      { framework: "NIST AI RMF", clause: "MEASURE 2.7", note: "Security and resilience" },
    ],
  },
  {
    code: "GATE-10",
    title: "Retention is set and recorded",
    description: "The organisation sets how long records are kept. Changes are recorded in the chain.",
    evidence: "settings",
    mappings: [
      { framework: "DPDP Act 2023", clause: "Sec. 8(7)", note: "Erasure when the purpose is served" },
      { framework: "ISO/IEC 42001", clause: "Clause 7.5", note: "Documented information" },
    ],
  },
];

export async function seedControls(orgId: string, client: PrismaClient = defaultClient) {
  const db = forOrg(orgId, client);
  for (const c of CONTROLS) {
    await db.control.upsert({
      where: { orgId_code: { orgId, code: c.code } },
      create: { orgId, code: c.code, title: c.title, description: c.description, evidence: c.evidence, mappings: c.mappings, status: "draft" },
      update: { title: c.title, description: c.description, evidence: c.evidence, mappings: c.mappings },
    });
  }
}

/** Live evidence counts per evidence key, from real receipts. */
export async function evidenceCounts(orgId: string, range?: { from: Date; to: Date }, client: PrismaClient = defaultClient): Promise<Record<EvidenceKey, number>> {
  const db = forOrg(orgId, client);
  const ts = range ? { ts: { gte: range.from, lte: range.to } } : {};
  const count = (where: object) => db.receipt.count({ where: { ...ts, ...where } });
  const [decisions, defaultRefusals, approvals, selfApprovals, receipts, rulebooks, kill, agents, connectors, settings] = await Promise.all([
    count({ kind: "decision" }),
    count({ kind: "decision", decision: "refuse" }),
    count({ kind: "approval" }),
    count({ kind: "approval", body: { path: ["approval", "self_approval"], equals: true } }),
    count({}),
    count({ action: "rulebook.signed" }),
    count({ action: { in: ["agent.paused", "agent.resumed"] } }),
    count({ action: "agent.created" }),
    count({ action: { in: ["connector.connected", "connector.disconnected"] } }),
    count({ action: "settings.updated" }),
  ]);
  return {
    decisions,
    default_refusals: defaultRefusals,
    approvals,
    self_approvals: selfApprovals,
    receipts,
    rulebooks,
    kill_switch: kill,
    agents,
    connectors,
    settings,
  };
}
