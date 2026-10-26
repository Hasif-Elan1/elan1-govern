/**
 * The framework library. DRAFT — NEEDS LEGAL REVIEW.
 *
 * Each framework lists requirements at the level of an article, section, clause, function
 * or pillar: the place a reviewer would look. Summaries are one plain line written by the
 * Elan1 Govern team from the official text. They are starting points, not legal advice, and not a
 * claim that using Elan1 Govern satisfies any law or standard.
 */

export const LEGAL_REVIEW_NOTE = "Draft — needs legal review";

/** Where an organisation operates, as picked in onboarding. */
export const REGIONS = ["india", "eu", "us", "uk", "other"] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Record<Region, string> = {
  india: "India",
  eu: "European Union",
  us: "United States",
  uk: "United Kingdom",
  other: "Somewhere else",
};

export interface Requirement {
  /** Unique within the framework, e.g. "art-14". */
  id: string;
  /** Where to look in the official text, e.g. "Art. 14". */
  ref: string;
  title: string;
  summary: string;
}

export interface Framework {
  id: string;
  name: string;
  shortName: string;
  jurisdiction: string;
  kind: "law" | "standard" | "guidance";
  description: string;
  url: string;
  requirements: Requirement[];
}

const r = (id: string, ref: string, title: string, summary: string): Requirement => ({ id, ref, title, summary });

export const FRAMEWORKS: Framework[] = [
  {
    id: "eu-ai-act",
    name: "EU AI Act (Regulation (EU) 2024/1689)",
    shortName: "EU AI Act",
    jurisdiction: "European Union",
    kind: "law",
    description: "The EU's law on AI. It bans some practices, sets duties for high-risk AI systems, and asks for transparency when people deal with AI. Duties differ for providers and deployers.",
    url: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj",
    requirements: [
      r("art-4", "Art. 4", "AI literacy", "Staff who operate or use AI systems have enough understanding of them."),
      r("art-5", "Art. 5", "Prohibited AI practices", "Some uses of AI, such as manipulative techniques or social scoring, are not allowed."),
      r("art-9", "Art. 9", "Risk management system", "High-risk AI systems have a risk management process that runs for their whole life."),
      r("art-10", "Art. 10", "Data and data governance", "Training, validation and testing data for high-risk systems meet quality criteria."),
      r("art-11", "Art. 11", "Technical documentation", "High-risk systems have technical documentation drawn up before they are placed on the market."),
      r("art-12", "Art. 12", "Record-keeping", "High-risk systems allow events to be logged automatically over their lifetime."),
      r("art-13", "Art. 13", "Transparency to deployers", "High-risk systems come with instructions that let deployers understand and use them properly."),
      r("art-14", "Art. 14", "Human oversight", "High-risk systems can be overseen by people, including being able to stop them."),
      r("art-15", "Art. 15", "Accuracy, robustness and cybersecurity", "High-risk systems perform consistently and resist errors and attacks."),
      r("art-17", "Art. 17", "Quality management system", "Providers of high-risk systems have a documented quality management system."),
      r("art-26", "Art. 26", "Obligations of deployers", "Deployers use high-risk systems as instructed, assign human oversight and keep the logs."),
      r("art-27", "Art. 27", "Fundamental rights impact assessment", "Certain deployers assess the impact on fundamental rights before using a high-risk system."),
      r("art-49", "Art. 49", "Registration", "High-risk systems are registered in the EU database before use, where required."),
      r("art-50", "Art. 50", "Transparency for certain AI systems", "People are told when they interact with an AI system or see AI-generated content."),
      r("art-72", "Art. 72", "Post-market monitoring", "Providers monitor how high-risk systems perform once they are in use."),
      r("art-73", "Art. 73", "Reporting serious incidents", "Serious incidents involving high-risk systems are reported to the authorities."),
    ],
  },
  {
    id: "nist-ai-rmf",
    name: "NIST AI Risk Management Framework 1.0 (NIST AI 100-1)",
    shortName: "NIST AI RMF",
    jurisdiction: "United States (voluntary, used worldwide)",
    kind: "guidance",
    description: "A voluntary framework from the US National Institute of Standards and Technology. It organises AI risk work into four functions: Govern, Map, Measure and Manage.",
    url: "https://www.nist.gov/itl/ai-risk-management-framework",
    requirements: [
      r("govern-1-4", "GOVERN 1.4", "Risk management is documented", "The risk management process and its outcomes are set out in transparent policies and procedures."),
      r("govern-1-6", "GOVERN 1.6", "AI systems are inventoried", "There are mechanisms to keep an inventory of AI systems."),
      r("govern-2-1", "GOVERN 2.1", "Roles and responsibilities", "Roles, responsibilities and lines of communication for AI risk are documented and clear."),
      r("govern-3-2", "GOVERN 3.2", "Human-AI oversight roles", "Policies define roles and responsibilities for human-AI configurations and oversight."),
      r("map-1-1", "MAP 1.1", "Intended purpose and context", "The intended purposes, context of use and relevant laws are understood and documented."),
      r("map-5", "MAP 5", "Impacts are characterised", "Impacts to individuals, groups, organisations and society are identified and assessed."),
      r("measure-2-7", "MEASURE 2.7", "Security and resilience", "AI system security and resilience are evaluated and documented."),
      r("measure-2-8", "MEASURE 2.8", "Transparency and accountability", "Risks to transparency and accountability are examined and documented."),
      r("manage-1-3", "MANAGE 1.3", "Responses to identified risks", "Responses to high-priority risks are developed, planned and documented."),
      r("manage-2-4", "MANAGE 2.4", "Disengaging AI systems", "There are mechanisms to supersede, disengage or deactivate AI systems that behave unexpectedly."),
      r("manage-4-1", "MANAGE 4.1", "Post-deployment monitoring", "Monitoring plans for AI systems in use are put into practice."),
    ],
  },
  {
    id: "iso-42001",
    name: "ISO/IEC 42001:2023 AI management system",
    shortName: "ISO/IEC 42001",
    jurisdiction: "International standard",
    kind: "standard",
    description: "The international standard for an AI management system. Clauses 4 to 10 set the management system; Annex A lists reference controls.",
    url: "https://www.iso.org/standard/81230.html",
    requirements: [
      r("cl-5-2", "Clause 5.2", "AI policy", "Top management sets an AI policy suited to the organisation."),
      r("cl-6-1", "Clause 6.1", "Actions to address risks and opportunities", "AI risks are assessed and treated, and AI system impacts are assessed."),
      r("cl-7-5", "Clause 7.5", "Documented information", "The information the management system needs is documented and controlled."),
      r("cl-8", "Clause 8", "Operation", "Processes for AI systems are planned, carried out and controlled."),
      r("cl-9-1", "Clause 9.1", "Monitoring and measurement", "The organisation monitors, measures, analyses and evaluates its AI management system."),
      r("cl-9-2", "Clause 9.2", "Internal audit", "Internal audits are carried out at planned intervals."),
      r("a-2", "Annex A.2", "Policies related to AI", "Controls for documenting and reviewing AI policies."),
      r("a-3", "Annex A.3", "Internal organisation", "Roles, responsibilities and reporting of concerns are set."),
      r("a-4", "Annex A.4", "Resources for AI systems", "The resources an AI system uses, such as data, tools and people, are documented."),
      r("a-5", "Annex A.5", "Assessing impacts of AI systems", "The impact of AI systems on people and society is assessed."),
      r("a-6", "Annex A.6", "AI system life cycle", "AI systems are designed, built, verified and deployed under defined processes."),
      r("a-7", "Annex A.7", "Data for AI systems", "Data used by AI systems is managed for quality and provenance."),
      r("a-8", "Annex A.8", "Information for interested parties", "Users and other interested parties get the information they need about AI systems."),
      r("a-9", "Annex A.9", "Use of AI systems", "AI systems are used responsibly and as intended."),
      r("a-10", "Annex A.10", "Third-party and customer relationships", "Responsibilities with suppliers and customers are allocated."),
    ],
  },
  {
    id: "dpdp",
    name: "Digital Personal Data Protection Act, 2023 (India)",
    shortName: "DPDP Act 2023",
    jurisdiction: "India",
    kind: "law",
    description: "India's personal data protection law. It sets when personal data may be processed, what notice and consent need, and the duties of data fiduciaries.",
    url: "https://www.meity.gov.in/writereaddata/files/Digital%20Personal%20Data%20Protection%20Act%202023.pdf",
    requirements: [
      r("sec-4", "Sec. 4", "Grounds for processing", "Personal data is processed only for a lawful purpose, with consent or for a legitimate use."),
      r("sec-5", "Sec. 5", "Notice", "People are told what personal data is collected and why."),
      r("sec-6", "Sec. 6", "Consent", "Consent is free, specific, informed, unconditional and unambiguous, and can be withdrawn."),
      r("sec-8-5", "Sec. 8(5)", "Reasonable security safeguards", "Data fiduciaries protect personal data with reasonable security safeguards to prevent breaches."),
      r("sec-8-6", "Sec. 8(6)", "Breach intimation", "A personal data breach is reported to the Board and to each affected person."),
      r("sec-8-7", "Sec. 8(7)", "Erasure when the purpose is served", "Personal data is erased once it is no longer needed, unless the law requires keeping it."),
      r("sec-9", "Sec. 9", "Children's data", "Processing a child's data needs verifiable parental consent and avoids harm."),
      r("sec-10", "Sec. 10", "Significant data fiduciaries", "Significant data fiduciaries appoint a DPO, run impact assessments and audits."),
      r("sec-11-13", "Secs. 11–13", "Rights of data principals", "People can access, correct and erase their data, and have a way to raise grievances."),
    ],
  },
  {
    id: "rbi-free-ai",
    name: "RBI Framework for Responsible and Ethical Enablement of AI (FREE-AI), August 2025 report",
    shortName: "RBI FREE-AI",
    jurisdiction: "India (regulated financial entities)",
    kind: "guidance",
    description: "The report of the Reserve Bank of India's committee on AI in the financial sector. It sets out seven principles (sutras) and recommendations under six pillars. Map each control to the specific recommendation that applies to you.",
    url: "https://www.rbi.org.in/",
    requirements: [
      r("infrastructure", "Infrastructure pillar", "Infrastructure", "Shared data and compute infrastructure that supports responsible AI adoption."),
      r("policy", "Policy pillar", "Policy", "AI policies, at regulated entities and at the regulator, that enable responsible adoption."),
      r("capacity", "Capacity pillar", "Capacity", "Building AI skills among boards, staff and supervisors."),
      r("governance", "Governance pillar", "Governance", "Governance structures, accountability and human oversight for AI use."),
      r("protection", "Protection pillar", "Protection", "Protecting consumers, their data and the security of AI systems."),
      r("assurance", "Assurance pillar", "Assurance", "Testing, monitoring and audit of AI systems over their life."),
    ],
  },
  {
    id: "gdpr",
    name: "General Data Protection Regulation (Regulation (EU) 2016/679)",
    shortName: "GDPR",
    jurisdiction: "European Union (the UK has its own version, the UK GDPR, with the same structure)",
    kind: "law",
    description: "The EU's data protection law. It applies whenever an agent handles personal data of people in the EU, including in automated decisions about them.",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    requirements: [
      r("art-5", "Art. 5", "Principles", "Lawfulness, purpose limitation, data minimisation, accuracy, storage limitation, security and accountability."),
      r("art-6", "Art. 6", "Lawfulness of processing", "Each processing activity has a legal basis."),
      r("art-13-14", "Arts. 13–14", "Information to people", "People are told how their data is used, including about automated decision-making."),
      r("art-15-17", "Arts. 15–17", "Access, rectification and erasure", "People can see, correct and erase their personal data."),
      r("art-22", "Art. 22", "Automated decision-making", "People have rights around decisions based solely on automated processing, including human intervention."),
      r("art-25", "Art. 25", "Data protection by design and by default", "Systems are built to process only the data needed."),
      r("art-30", "Art. 30", "Records of processing activities", "Controllers and processors keep a record of their processing activities."),
      r("art-32", "Art. 32", "Security of processing", "Appropriate technical and organisational security measures are in place."),
      r("art-33-34", "Arts. 33–34", "Breach notification", "Breaches are reported to the authority and, where the risk is high, to the people affected."),
      r("art-35", "Art. 35", "Data protection impact assessment", "High-risk processing is assessed before it starts."),
    ],
  },
  {
    id: "hipaa",
    name: "HIPAA Privacy and Security Rules (45 CFR Parts 160 and 164)",
    shortName: "HIPAA",
    jurisdiction: "United States (healthcare)",
    kind: "law",
    description: "US rules for protected health information held by covered entities and their business associates. The Privacy Rule limits uses and disclosures; the Security Rule requires safeguards for electronic health information.",
    url: "https://www.hhs.gov/hipaa/for-professionals/index.html",
    requirements: [
      r("164-308-a-1", "§ 164.308(a)(1)", "Security management process", "Risks to electronic health information are analysed and managed."),
      r("164-308-b", "§ 164.308(b)", "Business associate contracts", "Business associates that handle health information give written assurances."),
      r("164-312-a", "§ 164.312(a)", "Access control", "Only authorised people and software can access electronic health information."),
      r("164-312-b", "§ 164.312(b)", "Audit controls", "Activity in systems holding health information is recorded and can be examined."),
      r("164-312-c", "§ 164.312(c)", "Integrity", "Health information is protected from improper change or destruction."),
      r("164-316", "§ 164.316", "Policies, procedures and documentation", "Security policies are documented, kept and reviewed."),
      r("164-502-b", "§ 164.502(b)", "Minimum necessary", "Uses and disclosures are limited to the minimum health information needed."),
      r("164-400-414", "§§ 164.400–414", "Breach notification", "Breaches of unsecured health information are notified to the people affected and to HHS."),
    ],
  },
  {
    id: "soc2",
    name: "SOC 2 (2017 Trust Services Criteria)",
    shortName: "SOC 2",
    jurisdiction: "International (AICPA attestation, common in the US)",
    kind: "standard",
    description: "An attestation report on controls for security, availability, processing integrity, confidentiality and privacy, against the AICPA Trust Services Criteria.",
    url: "https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2",
    requirements: [
      r("cc1", "CC1", "Control environment", "Integrity, ethical values, oversight and accountability."),
      r("cc2", "CC2", "Communication and information", "The information needed for controls to work is produced and shared."),
      r("cc3", "CC3", "Risk assessment", "Risks to objectives are identified and assessed."),
      r("cc4", "CC4", "Monitoring activities", "Controls are evaluated and deficiencies are reported."),
      r("cc5", "CC5", "Control activities", "Control activities, including segregation of duties, reduce risks."),
      r("cc6", "CC6", "Logical and physical access", "Access to systems and data is restricted to authorised users."),
      r("cc7", "CC7", "System operations", "Systems are monitored, and incidents are detected and handled."),
      r("cc8", "CC8", "Change management", "Changes are authorised, tested, approved and recorded."),
      r("cc9", "CC9", "Risk mitigation", "Business disruption and vendor risks are mitigated."),
      r("c1", "C1", "Confidentiality", "Confidential information is protected and disposed of as committed."),
      r("pi1", "PI1", "Processing integrity", "Processing is complete, valid, accurate and authorised."),
    ],
  },
  {
    id: "colorado-ai-act",
    name: "Colorado AI Act (SB 24-205, C.R.S. 6-1-1701 to 6-1-1707)",
    shortName: "Colorado AI Act",
    jurisdiction: "United States – Colorado",
    kind: "law",
    description: "Colorado's law on high-risk AI systems that make or substantially help make consequential decisions, such as in employment, lending, housing or healthcare. It sets duties to avoid algorithmic discrimination.",
    url: "https://leg.colorado.gov/bills/sb24-205",
    requirements: [
      r("1702", "§ 6-1-1702", "Developer duties", "Developers use reasonable care and give deployers the documentation they need."),
      r("1703-program", "§ 6-1-1703", "Risk management policy and program", "Deployers have a risk management policy and program for high-risk AI systems."),
      r("1703-assessment", "§ 6-1-1703", "Impact assessment", "Deployers complete impact assessments for high-risk AI systems, and repeat them."),
      r("1703-notice", "§ 6-1-1703", "Notice, explanation and appeal", "Consumers are told when a high-risk system is used for a decision about them, and can correct data and appeal."),
      r("1703-statement", "§ 6-1-1703", "Public statement", "Deployers publish a summary of the high-risk systems they use and how they manage risk."),
      r("1704", "§ 6-1-1704", "Disclosure of AI interaction", "Consumers are told when they are interacting with an AI system."),
    ],
  },
  {
    id: "nyc-ll144",
    name: "NYC Local Law 144 of 2021 (automated employment decision tools)",
    shortName: "NYC LL144",
    jurisdiction: "United States – New York City",
    kind: "law",
    description: "New York City's law on automated employment decision tools used to screen candidates or employees for hiring or promotion. It requires a bias audit and notices.",
    url: "https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page",
    requirements: [
      r("20-871-a", "Admin. Code § 20-871(a)", "Bias audit and published results", "The tool has had an independent bias audit within the past year, and a summary of the results is public."),
      r("20-871-b", "Admin. Code § 20-871(b)", "Notice to candidates and employees", "Candidates and employees in the city are told that a tool is used, and what it assesses."),
    ],
  },
];

const BY_ID = new Map(FRAMEWORKS.map((f) => [f.id, f]));

export function frameworkById(id: string): Framework | undefined {
  return BY_ID.get(id);
}

export function isFrameworkId(id: string): boolean {
  return BY_ID.has(id);
}

export const FRAMEWORK_IDS = FRAMEWORKS.map((f) => f.id);
