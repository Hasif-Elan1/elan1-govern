import { frameworkById, FRAMEWORKS, type Framework, type Requirement } from "./frameworks";

/**
 * The controls catalogue. DRAFT — NEEDS LEGAL REVIEW.
 *
 * Each control is something Elan1 Govern actually does, backed by receipts on the signed chain
 * (the evidence key says which). Mappings point to requirements in the framework library
 * where a reviewer might look; they are not claims of compliance.
 */

/** Which receipts count as evidence for a control. Counted in packages/db (evidenceCounts). */
export const EVIDENCE_KEYS = [
  "decisions",
  "default_refusals",
  "approvals",
  "self_approvals",
  "receipts",
  "rulebooks",
  "kill_switch",
  "agents",
  "connectors",
  "settings",
  "member_changes",
  "systems",
  "approved_assessments",
] as const;
export type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

/** What each evidence key counts, in plain words (for tables and the framework report). */
export const EVIDENCE_LABELS: Record<EvidenceKey, string> = {
  decisions: "actions checked",
  default_refusals: "actions refused",
  approvals: "decisions by a person",
  self_approvals: "flagged self-approvals",
  receipts: "signed receipts",
  rulebooks: "rulebook versions signed",
  kill_switch: "agents paused or resumed",
  agents: "agents registered",
  connectors: "connector changes",
  settings: "settings changes",
  member_changes: "member and role changes",
  systems: "AI systems added to the inventory",
  approved_assessments: "risk assessments approved",
};

export interface ControlMapping {
  framework: string;
  requirement: string;
  note?: string;
}

export interface Control {
  id: string;
  title: string;
  description: string;
  evidence: EvidenceKey;
  mappings: ControlMapping[];
}

const m = (framework: string, requirement: string, note?: string): ControlMapping => ({ framework, requirement, ...(note ? { note } : {}) });

export const CONTROLS: Control[] = [
  {
    id: "GATE-01",
    title: "Agents can only do what a rule allows",
    description: "Every tool call is checked against the agent's signed rulebook. Anything not allowed is refused by default.",
    evidence: "default_refusals",
    mappings: [
      m("eu-ai-act", "art-9"),
      m("iso-42001", "a-9"),
      m("nist-ai-rmf", "manage-1-3"),
      m("rbi-free-ai", "governance", "Map to the specific recommendation"),
      m("gdpr", "art-25"),
      m("soc2", "cc6"),
      m("hipaa", "164-312-a"),
      m("colorado-ai-act", "1703-program"),
    ],
  },
  {
    id: "GATE-02",
    title: "A person approves high-impact actions",
    description: "Rules can require a named approver before an action runs, such as a large payment, a refund or a production change.",
    evidence: "approvals",
    mappings: [
      m("eu-ai-act", "art-14"),
      m("eu-ai-act", "art-26", "Assign human oversight"),
      m("iso-42001", "a-9"),
      m("nist-ai-rmf", "govern-3-2"),
      m("rbi-free-ai", "governance", "Human oversight of AI decisions"),
      m("gdpr", "art-22", "Human intervention in automated decisions"),
      m("soc2", "cc5"),
      m("colorado-ai-act", "1703-notice", "Human review on appeal"),
    ],
  },
  {
    id: "GATE-03",
    title: "Separation of duties on approvals",
    description: "Approvals by the person who set up the agent are flagged on the receipt.",
    evidence: "self_approvals",
    mappings: [m("iso-42001", "a-3"), m("nist-ai-rmf", "govern-2-1"), m("soc2", "cc5", "Segregation of duties")],
  },
  {
    id: "GATE-04",
    title: "Tamper-evident record of every decision",
    description: "Receipts are hash-chained, signed and checkpointed, and can be verified offline.",
    evidence: "receipts",
    mappings: [
      m("eu-ai-act", "art-12"),
      m("eu-ai-act", "art-26", "Keep the logs"),
      m("iso-42001", "cl-9-1"),
      m("nist-ai-rmf", "measure-2-8"),
      m("nist-ai-rmf", "manage-4-1"),
      m("rbi-free-ai", "assurance", "Audit and monitoring"),
      m("gdpr", "art-5", "Accountability"),
      m("hipaa", "164-312-b"),
      m("hipaa", "164-312-c"),
      m("soc2", "cc4"),
      m("soc2", "cc7"),
      m("soc2", "pi1"),
    ],
  },
  {
    id: "GATE-05",
    title: "Signed, versioned rulebooks",
    description: "Policy changes create a new signed version. Old versions stay readable.",
    evidence: "rulebooks",
    mappings: [
      m("iso-42001", "cl-7-5"),
      m("iso-42001", "a-2"),
      m("nist-ai-rmf", "govern-1-4"),
      m("rbi-free-ai", "policy"),
      m("hipaa", "164-316"),
      m("soc2", "cc8"),
      m("colorado-ai-act", "1703-program"),
    ],
  },
  {
    id: "GATE-06",
    title: "Kill switch for every agent",
    description: "Pausing an agent refuses all of its calls immediately.",
    evidence: "kill_switch",
    mappings: [m("nist-ai-rmf", "manage-2-4"), m("eu-ai-act", "art-14", "Ability to interrupt the system"), m("soc2", "cc7", "Incident response")],
  },
  {
    id: "GATE-07",
    title: "Registry of agents, owners and risk tiers",
    description: "Every agent has an owner, a purpose, a risk tier and the tools it can reach.",
    evidence: "agents",
    mappings: [
      m("iso-42001", "a-4"),
      m("iso-42001", "a-5"),
      m("nist-ai-rmf", "map-1-1"),
      m("nist-ai-rmf", "govern-2-1"),
      m("eu-ai-act", "art-26"),
      m("rbi-free-ai", "governance", "Inventory of AI use"),
    ],
  },
  {
    id: "GATE-08",
    title: "Minimal personal data in logs",
    description: "Receipts keep a hash of the arguments and only the fields a rule checked. Message bodies and prompts are never stored.",
    evidence: "decisions",
    mappings: [
      m("dpdp", "sec-8-5"),
      m("iso-42001", "a-7"),
      m("rbi-free-ai", "protection", "Data protection"),
      m("gdpr", "art-5", "Data minimisation"),
      m("gdpr", "art-25"),
      m("hipaa", "164-502-b"),
      m("soc2", "c1"),
    ],
  },
  {
    id: "GATE-09",
    title: "Agents never hold credentials",
    description: "OAuth tokens stay encrypted inside Elan1 Govern. The agent only gets an API key it can lose without exposing the systems behind it.",
    evidence: "connectors",
    mappings: [m("dpdp", "sec-8-5"), m("eu-ai-act", "art-15"), m("nist-ai-rmf", "measure-2-7"), m("gdpr", "art-32"), m("hipaa", "164-312-a"), m("soc2", "cc6")],
  },
  {
    id: "GATE-10",
    title: "Retention is set and recorded",
    description: "The organisation sets how long records are kept. Changes are recorded in the chain.",
    evidence: "settings",
    mappings: [m("dpdp", "sec-8-7"), m("iso-42001", "cl-7-5"), m("gdpr", "art-5", "Storage limitation"), m("hipaa", "164-316", "Retention of documentation"), m("soc2", "c1")],
  },
  {
    id: "GATE-11",
    title: "Access to Elan1 Govern is role-based and changes are recorded",
    description: "Owners, admins, approvers, viewers and auditors have fixed permissions. Every invite, role change and removal is a receipt.",
    evidence: "member_changes",
    mappings: [m("iso-42001", "a-3"), m("soc2", "cc6"), m("hipaa", "164-312-a"), m("gdpr", "art-32")],
  },
  {
    id: "GATE-12",
    title: "AI systems are inventoried",
    description: "Every AI system the organisation uses, including ones that do not act through Elan1 Govern, is listed with an owner and a purpose.",
    evidence: "systems",
    mappings: [
      m("nist-ai-rmf", "govern-1-6"),
      m("iso-42001", "a-4"),
      m("eu-ai-act", "art-49", "Where the system is high-risk"),
      m("gdpr", "art-30"),
      m("rbi-free-ai", "governance", "Inventory of AI use"),
      m("colorado-ai-act", "1703-statement"),
    ],
  },
  {
    id: "GATE-13",
    title: "Risk assessments are approved before go-live",
    description: "Each AI system has a written risk assessment that a named person approves before it is used.",
    evidence: "approved_assessments",
    mappings: [
      m("eu-ai-act", "art-9"),
      m("eu-ai-act", "art-27"),
      m("iso-42001", "cl-6-1"),
      m("iso-42001", "a-5"),
      m("nist-ai-rmf", "map-5"),
      m("dpdp", "sec-10"),
      m("rbi-free-ai", "assurance"),
      m("gdpr", "art-35"),
      m("hipaa", "164-308-a-1"),
      m("soc2", "cc3"),
      m("colorado-ai-act", "1703-assessment"),
    ],
  },
];

const CONTROL_BY_ID = new Map(CONTROLS.map((c) => [c.id, c]));

export function controlById(id: string): Control | undefined {
  return CONTROL_BY_ID.get(id);
}

/** Controls that map to a framework, with the mappings for that framework only. */
export function controlsFor(frameworkId: string): (Control & { refs: ControlMapping[] })[] {
  return CONTROLS.map((c) => ({ ...c, refs: c.mappings.filter((x) => x.framework === frameworkId) })).filter((c) => c.refs.length > 0);
}

export type Counts = Partial<Record<EvidenceKey, number>>;

export interface RequirementCoverage {
  requirement: Requirement;
  controls: { control: Control; evidence: number; note?: string }[];
  /** At least one mapped control has live evidence. */
  covered: boolean;
  /** No control maps here at all. */
  gap: boolean;
}

export interface FrameworkCoverage {
  framework: Framework;
  requirements: RequirementCoverage[];
  covered: number;
  total: number;
  /** Whole percent, rounded down so 99.5% never shows as 100%. */
  percent: number;
}

/** Coverage: requirements with at least one control that has live evidence, over all requirements. */
export function frameworkCoverage(frameworkId: string, counts: Counts): FrameworkCoverage {
  const framework = frameworkById(frameworkId);
  if (!framework) throw new Error(`unknown framework "${frameworkId}"`);
  const requirements = framework.requirements.map((requirement) => {
    const controls = CONTROLS.flatMap((control) =>
      control.mappings
        .filter((x) => x.framework === frameworkId && x.requirement === requirement.id)
        .slice(0, 1)
        .map((x) => ({ control, evidence: counts[control.evidence] ?? 0, ...(x.note ? { note: x.note } : {}) })),
    );
    return { requirement, controls, covered: controls.some((c) => c.evidence > 0), gap: controls.length === 0 };
  });
  const covered = requirements.filter((x) => x.covered).length;
  const total = requirements.length;
  return { framework, requirements, covered, total, percent: total ? Math.floor((covered / total) * 100) : 0 };
}

/** Every mapping that points at a framework or requirement the library does not have. */
export function brokenMappings(): string[] {
  const out: string[] = [];
  for (const c of CONTROLS) {
    for (const x of c.mappings) {
      const f = FRAMEWORKS.find((y) => y.id === x.framework);
      if (!f) out.push(`${c.id}: unknown framework ${x.framework}`);
      else if (!f.requirements.some((q) => q.id === x.requirement)) out.push(`${c.id}: ${x.framework} has no requirement ${x.requirement}`);
    }
  }
  return out;
}
