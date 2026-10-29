import type { AiSystem, Assessment, AssessmentQuestion, Control, Framework, Requirement } from '@/types';

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

export const AI_SYSTEMS: AiSystem[] = [
  { id: 'ai_invoice', name: 'Accounts-payable agent', kind: 'agent', vendor: 'Anthropic (Claude) via Elan1 Govern MCP', purpose: 'Reads supplier invoices, drafts bills and records vendor payments.', ownerId: 'u_venkat', businessUnit: 'Finance', lifecycle: 'live', riskTier: 'high', dataCategories: ['Vendor bank details', 'Invoice amounts', 'Business email'], affectedPeople: ['Vendors', 'Finance team'], decisionImpact: 'decides', linkedAgentId: 'ag_invoice', nextReview: daysAhead(142), createdAt: daysAgo(140), frameworks: ['iso42001', 'nist', 'rbi', 'dpdp'] },
  { id: 'ai_collect', name: 'Receivables reminders', kind: 'agent', vendor: 'LangChain on Claude', purpose: 'Sends payment reminders to customers with overdue invoices.', ownerId: 'u_venkat', businessUnit: 'Finance', lifecycle: 'live', riskTier: 'limited', dataCategories: ['Customer contact details', 'Amounts due'], affectedPeople: ['Customers'], decisionImpact: 'informs', linkedAgentId: 'ag_collect', nextReview: daysAhead(260), createdAt: daysAgo(98), frameworks: ['iso42001', 'dpdp'] },
  { id: 'ai_vendor', name: 'Vendor onboarding', kind: 'agent', vendor: 'OpenAI Agents SDK', purpose: 'Verifies GSTIN and creates vendors in the procurement master.', ownerId: 'u_arjun', businessUnit: 'Procurement', lifecycle: 'live', riskTier: 'high', dataCategories: ['Vendor KYC', 'Bank details'], affectedPeople: ['Vendors'], decisionImpact: 'decides', linkedAgentId: 'ag_vendor', nextReview: daysAhead(88), createdAt: daysAgo(64), frameworks: ['iso42001', 'nist', 'rbi'] },
  { id: 'ai_devops', name: 'DevOps assistant', kind: 'agent', vendor: 'Cursor', purpose: 'Reads logs, merges reviewed changes and requests deploys.', ownerId: 'u_sanjay', businessUnit: 'Engineering', lifecycle: 'live', riskTier: 'limited', dataCategories: ['Source code', 'Service logs'], affectedPeople: ['Customers (indirectly)'], decisionImpact: 'informs', linkedAgentId: 'ag_devops', nextReview: daysAhead(190), createdAt: daysAgo(41), frameworks: ['iso42001', 'soc2'] },
  { id: 'ai_treasury', name: 'Treasury sweeper', kind: 'agent', vendor: 'Anthropic (Claude)', purpose: 'Moves surplus cash between own accounts within limits.', ownerId: 'u_ananya', businessUnit: 'Treasury', lifecycle: 'live', riskTier: 'high', dataCategories: ['Account balances'], affectedPeople: ['Company'], decisionImpact: 'decides', linkedAgentId: 'ag_treasury', nextReview: daysAhead(160), createdAt: daysAgo(22), frameworks: ['iso42001', 'rbi'] },
  { id: 'ai_expense', name: 'Expense claim reviewer', kind: 'agent', vendor: 'Anthropic (Claude)', purpose: 'Flags expense claims that break policy and drafts queries.', ownerId: 'u_fatima', businessUnit: 'Finance', lifecycle: 'live', riskTier: 'limited', dataCategories: ['Employee expenses'], affectedPeople: ['Employees'], decisionImpact: 'informs', linkedAgentId: 'ag_expense', nextReview: daysAhead(300), createdAt: daysAgo(56), frameworks: ['iso42001', 'dpdp'] },
  { id: 'ai_hr', name: 'CV screening summariser', kind: 'agent', vendor: 'In-house', purpose: 'Summarises job applications for recruiters. Does not rank or reject.', ownerId: 'u_fatima', businessUnit: 'People', lifecycle: 'in_review', riskTier: 'unassessed', dataCategories: ['CVs', 'Contact details', 'Employment history'], affectedPeople: ['Job applicants'], decisionImpact: 'informs', linkedAgentId: 'ag_hr', createdAt: daysAgo(13), frameworks: ['euaiact', 'nyc144', 'dpdp', 'gdpr'] },
  { id: 'ai_copilot', name: 'Microsoft 365 Copilot', kind: 'vendor_tool', vendor: 'Microsoft', purpose: 'Drafting and summarising in Office for 140 staff.', ownerId: 'u_rahul', businessUnit: 'All', lifecycle: 'live', riskTier: 'minimal', dataCategories: ['Business documents'], affectedPeople: ['Employees'], decisionImpact: 'none', nextReview: daysAhead(40), createdAt: daysAgo(200), frameworks: ['iso42001'] },
  { id: 'ai_forecast', name: 'Demand forecasting model', kind: 'model', vendor: 'In-house (gradient boosting)', purpose: 'Weekly SKU demand forecast for purchasing.', ownerId: 'u_arjun', businessUnit: 'Procurement', lifecycle: 'live', riskTier: 'limited', dataCategories: ['Sales history'], affectedPeople: ['Company'], decisionImpact: 'informs', nextReview: daysAhead(75), createdAt: daysAgo(400), frameworks: ['iso42001', 'nist'] },
  { id: 'ai_chatbot', name: 'Customer support chatbot', kind: 'internal_app', vendor: 'Proposed — vendor not chosen', purpose: 'Answer order-status questions on the website.', ownerId: 'u_meera', businessUnit: 'Customer service', lifecycle: 'proposed', riskTier: 'unassessed', dataCategories: ['Order data', 'Customer contact details'], affectedPeople: ['Customers'], decisionImpact: 'informs', createdAt: daysAgo(4), frameworks: ['euaiact', 'dpdp'] },
];

const q = (id: string, section: string, text: string, answer: string, points: number, explanation: string): AssessmentQuestion => ({ id, section, text, answer, points, explanation });

export const ASSESSMENTS: Assessment[] = [
  {
    id: 'as_invoice_impact', aiSystemId: 'ai_invoice', template: 'impact', status: 'approved', score: 31, maxScore: 40, resultTier: 'high',
    authorId: 'u_venkat', reviewerId: 'u_fatima', submittedAt: daysAgo(132), reviewedAt: daysAgo(130), createdAt: daysAgo(135), reviewNote: 'Agreed. High because it moves money; mitigated by pay-large approval rule.',
    questions: [
      q('q1', 'Decisions', 'Can the system commit the business without a person?', 'Yes, payments up to ₹50,000', 8, 'Committing money without review scores the maximum for this section.'),
      q('q2', 'Decisions', 'Are decisions reversible?', 'Partly — payments need a recall request', 6, 'Partial reversibility scores 6 of 8.'),
      q('q3', 'People', 'Who is affected if it errs?', 'Vendors and our cash position', 5, 'External parties affected scores 5.'),
      q('q4', 'Data', 'Does it process personal data?', 'Vendor contact and bank details', 6, 'Financial identifiers score 6.'),
      q('q5', 'Controls', 'Is there a human approval gate?', 'Yes — pay-large, email-other', 2, 'An approval gate reduces the score to 2.'),
      q('q6', 'Controls', 'Is every decision recorded?', 'Yes — receipts sealed in a hash chain', 4, 'Recorded but not externally anchored scores 4 of 8.'),
    ],
  },
  {
    id: 'as_vendor_triage', aiSystemId: 'ai_vendor', template: 'risk_triage', status: 'approved', score: 18, maxScore: 24, resultTier: 'high',
    authorId: 'u_arjun', reviewerId: 'u_venkat', submittedAt: daysAgo(61), reviewedAt: daysAgo(60), createdAt: daysAgo(62), reviewNote: 'Bank changes must stay held. Approved.',
    questions: [
      q('q1', 'Triage', 'Does it change payment destinations?', 'Yes — bank detail updates', 8, 'Payment-destination changes are the highest fraud exposure.'),
      q('q2', 'Triage', 'Does it act on external parties?', 'Creates vendor records', 5, ''),
      q('q3', 'Triage', 'Is the model on the decision path?', 'No — Elan1 Govern decides in code', 1, 'No model on the decision path scores 1.'),
      q('q4', 'Triage', 'Can it be stopped at once?', 'Yes', 4, ''),
    ],
  },
  {
    id: 'as_hr_impact', aiSystemId: 'ai_hr', template: 'impact', status: 'submitted', score: 33, maxScore: 40, resultTier: 'high',
    authorId: 'u_fatima', submittedAt: daysAgo(1), createdAt: daysAgo(6),
    questions: [
      q('q1', 'Decisions', 'Does the output influence hiring?', 'Yes — recruiters read the summary', 8, 'Employment is a high-risk use under the EU AI Act Annex III.'),
      q('q2', 'People', 'Who is affected?', 'Job applicants', 8, 'Individuals with a significant interest score the maximum.'),
      q('q3', 'Data', 'Does it process personal data?', 'CVs and contact details', 7, ''),
      q('q4', 'Controls', 'Is there a bias audit?', 'Not yet — planned before go-live', 6, 'NYC LL 144 requires an independent bias audit for AEDTs.'),
      q('q5', 'Controls', 'Is every read approved?', 'Yes — DPO approves each run', 4, ''),
    ],
  },
  {
    id: 'as_hr_dp', aiSystemId: 'ai_hr', template: 'data_protection', status: 'draft', score: 12, maxScore: 30, resultTier: 'unassessed',
    authorId: 'u_fatima', createdAt: daysAgo(2),
    questions: [
      q('q1', 'Lawful basis', 'What is the lawful basis under DPDP?', 'Legitimate use — employment', 4, ''),
      q('q2', 'Retention', 'How long are summaries kept?', '', 0, 'Unanswered.'),
      q('q3', 'Rights', 'How does an applicant ask for erasure?', '', 0, 'Unanswered.'),
    ],
  },
  {
    id: 'as_chatbot_triage', aiSystemId: 'ai_chatbot', template: 'risk_triage', status: 'draft', score: 6, maxScore: 24, resultTier: 'unassessed',
    authorId: 'u_meera', createdAt: daysAgo(3), questions: [q('q1', 'Triage', 'Does it act on external parties?', 'Answers customers', 5, ''), q('q2', 'Triage', 'Is the model on the decision path?', '', 0, 'Unanswered.')],
  },
  {
    id: 'as_treasury_triage', aiSystemId: 'ai_treasury', template: 'risk_triage', status: 'approved', score: 17, maxScore: 24, resultTier: 'high',
    authorId: 'u_ananya', reviewerId: 'u_venkat', submittedAt: daysAgo(21), reviewedAt: daysAgo(21), createdAt: daysAgo(21), reviewNote: 'High. External transfers held for owners.',
    questions: [q('q1', 'Triage', 'Does it move money?', 'Yes — between own accounts', 8, ''), q('q2', 'Triage', 'Can it reach external accounts?', 'Only with owner approval', 5, '')],
  },
];

export const CONTROLS: Control[] = [
  { id: 'EG-01', name: 'Agents can only do what a rule allows', description: 'Every rulebook defaults to refuse; unknown and switched-off tools are refused.', evidenceKind: 'Default and rule refusals', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-02', name: 'A person approves high-impact actions', description: 'Moves money, deletes, access and production changes are held for a named approver.', evidenceKind: 'Approval receipts', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-03', name: 'Every decision is recorded on a sealed hash chain', description: 'One receipt per decision, approval and outcome, hash-linked and sealed with Ed25519 (signed from L2).', evidenceKind: 'Receipts and hourly checkpoints', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-04', name: 'Rulebooks are sealed and versioned', description: 'Each published version is sealed in the chain and verified on every call.', evidenceKind: 'rulebook.published receipts', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-05', name: 'Rulebook changes are reviewed by a second person', description: 'Dual control on publishing.', evidenceKind: 'Reviewed publishes', evidenceCount: 0, status: 'partial', note: 'Dual control is designed; today the review is recorded but not enforced.' },
  { id: 'EG-06', name: 'Agents never hold the credentials', description: 'On the MCP route Elan1 Govern holds the tool credential and runs the call.', evidenceKind: 'Governed-run decisions', evidenceCount: 0, status: 'partial', note: 'True only on the MCP route. REST and SDK agents hold their own credentials.' },
  { id: 'EG-07', name: 'Spending and volume limits are enforced', description: 'Count and sum quotas per window turn an allow into an ask, or a refusal when the rule names no approver group.', evidenceKind: 'Quota decisions', evidenceCount: 0, status: 'evidenced', note: 'Daily limits are checked outside the chain lock; two concurrent payments can together exceed a limit.' },
  { id: 'EG-08', name: 'Personal data access is controlled', description: 'Calls tagged personal_data follow a rule, and reads can be held.', evidenceKind: 'personal_data decisions', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-09', name: 'Unusual behaviour raises an alert', description: 'Six detectors watch volume, refusals, amounts, counterparties, tools and hours.', evidenceKind: 'Alerts', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-10', name: 'Agents can be stopped at once', description: 'Pause per agent; emergency stop for all.', evidenceKind: 'Pause and stop receipts', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-11', name: 'AI systems are inventoried', description: 'Each AI system has an owner, purpose and review date.', evidenceKind: 'Inventory entries', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-12', name: 'Risk assessments are approved before go-live', description: 'Signed off by a different person; sets the risk tier.', evidenceKind: 'Approved assessments', evidenceCount: 0, status: 'partial', note: 'HR screening is in review without an approved assessment.' },
  { id: 'EG-13', name: 'Evidence can be exported and checked offline', description: 'Auditor pack plus govern verify, no account needed.', evidenceKind: 'Auditor pack exports', evidenceCount: 0, status: 'evidenced' },
  // documented controls GATE-03, GATE-10 and GATE-11 (technology memorandum control list); ids continue after the level controls EG-14 to EG-17
  { id: 'EG-18', name: 'Separation of duties on approvals', description: 'Every approval records whether the approver also owns the agent; self-approvals are flagged and counted, and an author cannot sign off their own assessment.', evidenceKind: 'Approval receipts with the self-approval flag', evidenceCount: 0, status: 'partial', note: 'At L1 approving an action of an agent you own is allowed but flagged and counted; from L2 it is forbidden. Two different people approve an action above the two-person limit or with a wide blast radius.' },
  { id: 'EG-19', name: 'Retention is set and recorded', description: 'Receipts are kept for a set period, never shorter than 8 years, and every change to it is a receipt.', evidenceKind: 'retention.changed receipts', evidenceCount: 0, status: 'evidenced' },
  { id: 'EG-20', name: 'Access is role-based, and changes are recorded', description: 'Members act through a role (owner, admin, approver, auditor, viewer); every invitation, role change, suspension and removal is a receipt.', evidenceKind: 'Member and role-change receipts', evidenceCount: 0, status: 'evidenced' },
];

const req = (id: string, title: string, controlIds: string[]): Requirement => ({ id, title, controlIds });

export const FRAMEWORKS: Framework[] = [
  { id: 'euaiact', name: 'EU Artificial Intelligence Act', short: 'EU AI Act', jurisdiction: 'European Union', officialRef: 'Regulation (EU) 2024/1689', enabled: true, coverage: 0, requirements: [
    req('Art. 9', 'Risk management system', ['EG-12']), req('Art. 10', 'Data and data governance', []), req('Art. 11', 'Technical documentation', ['EG-11']),
    req('Art. 12', 'Record-keeping (automatic logs)', ['EG-03']), req('Art. 13', 'Transparency to deployers', []), req('Art. 14', 'Human oversight', ['EG-02', 'EG-10']),
    req('Art. 15', 'Accuracy, robustness and cybersecurity', []), req('Art. 17', 'Quality management system', ['EG-04', 'EG-05']), req('Art. 26', 'Obligations of deployers', ['EG-02', 'EG-09']),
    req('Art. 27', 'Fundamental rights impact assessment', ['EG-12']), req('Art. 72', 'Post-market monitoring', ['EG-09']), req('Art. 73', 'Reporting of serious incidents', []),
  ] },
  { id: 'nist', name: 'NIST AI Risk Management Framework 1.0', short: 'NIST AI RMF', jurisdiction: 'United States', officialRef: 'NIST AI 100-1', enabled: true, coverage: 0, requirements: [
    req('GOVERN 1', 'Policies, processes and procedures', ['EG-04']), req('GOVERN 2', 'Accountability structures', ['EG-02']), req('GOVERN 4', 'Organisational culture of risk', []),
    req('MAP 1', 'Context is established', ['EG-11']), req('MAP 4', 'Risks and benefits mapped for third parties', []), req('MEASURE 2', 'Systems evaluated for trustworthiness', ['EG-12']),
    req('MEASURE 3', 'Risks tracked over time', ['EG-09']), req('MANAGE 2', 'Strategies to maximise benefit, minimise harm', ['EG-01', 'EG-07']), req('MANAGE 4', 'Risk treatments documented and monitored', ['EG-03']),
  ] },
  { id: 'iso42001', name: 'ISO/IEC 42001:2023 AI management system', short: 'ISO 42001', jurisdiction: 'International', officialRef: 'ISO/IEC 42001:2023', enabled: true, coverage: 0, requirements: [
    req('6.1.2', 'AI risk assessment', ['EG-12']), req('6.1.4', 'AI system impact assessment', []), req('8.2', 'AI risk treatment', ['EG-01', 'EG-02']),
    req('9.1', 'Monitoring, measurement, analysis', ['EG-09']), req('A.6.2.6', 'AI system operation and monitoring', ['EG-03', 'EG-10']), req('A.6.2.8', 'AI system event logs', ['EG-03']),
    req('A.8.2', 'System documentation for users', []), req('A.9.2', 'Processes for responsible use', ['EG-04', 'EG-05']), req('A.10.3', 'Suppliers', []),
    req('A.4.2', 'Resource documentation', ['EG-11']), req('7.5', 'Documented information', []), req('10.2', 'Nonconformity and corrective action', []), req('A.5.2', 'Impact assessment process', []),
  ] },
  { id: 'dpdp', name: 'Digital Personal Data Protection Act 2023', short: 'DPDP', jurisdiction: 'India', officialRef: 'Act No. 22 of 2023', enabled: true, coverage: 0, requirements: [
    req('s.4', 'Grounds for processing', []), req('s.5', 'Notice to data principal', []), req('s.6', 'Consent', []), req('s.8(4)', 'Reasonable security safeguards', ['EG-08']),
    req('s.8(5)', 'Breach notification', []), req('s.8(7)', 'Erasure when purpose is served', []), req('s.11', 'Right to access information', []), req('s.12', 'Right to correction and erasure', []), req('s.10', 'Significant data fiduciary obligations', []),
  ] },
  { id: 'rbi', name: 'RBI Framework for Responsible and Ethical Enablement of AI (FREE-AI)', short: 'RBI FREE-AI', jurisdiction: 'India', officialRef: 'RBI committee report, August 2025', enabled: true, coverage: 0, requirements: [
    req('Pillar: Governance', 'Board-approved AI policy', ['EG-04']), req('Pillar: Protection', 'Consumer protection and grievance', []), req('Pillar: Assurance', 'Audit trail of AI decisions', ['EG-03', 'EG-13']),
    req('Rec. 14', 'Human in the loop for high-impact decisions', ['EG-02']), req('Rec. 18', 'AI inventory', ['EG-11']), req('Rec. 21', 'Incident reporting and kill switch', ['EG-10']),
  ] },
  { id: 'gdpr', name: 'General Data Protection Regulation', short: 'GDPR', jurisdiction: 'European Union', officialRef: 'Regulation (EU) 2016/679', enabled: true, coverage: 0, requirements: [
    req('Art. 5(1)(f)', 'Integrity and confidentiality', ['EG-08']), req('Art. 22', 'Automated individual decision-making', ['EG-02']), req('Art. 25', 'Data protection by design', []),
    req('Art. 30', 'Records of processing', ['EG-11']), req('Art. 32', 'Security of processing', []), req('Art. 33', 'Breach notification', []), req('Art. 35', 'Data protection impact assessment', []),
  ] },
  { id: 'hipaa', name: 'Health Insurance Portability and Accountability Act', short: 'HIPAA', jurisdiction: 'United States', officialRef: '45 CFR Parts 160, 164', enabled: false, coverage: 0, requirements: [
    req('164.308(a)(1)', 'Security management process', ['EG-12']), req('164.312(b)', 'Audit controls', ['EG-03']), req('164.312(a)(1)', 'Access control', ['EG-01']), req('164.308(a)(6)', 'Security incident procedures', ['EG-10']),
  ] },
  { id: 'soc2', name: 'SOC 2 Trust Services Criteria (2017)', short: 'SOC 2', jurisdiction: 'United States', officialRef: 'AICPA TSC 2017', enabled: true, coverage: 0, requirements: [
    req('CC6.1', 'Logical access controls', ['EG-01', 'EG-06']), req('CC7.2', 'System monitoring', ['EG-09']), req('CC7.4', 'Incident response', ['EG-10']),
    req('CC8.1', 'Change management', ['EG-04', 'EG-05']), req('CC4.1', 'Monitoring of controls', ['EG-03']), req('CC9.2', 'Vendor risk', []),
  ] },
  { id: 'colorado', name: 'Colorado Artificial Intelligence Act', short: 'Colorado AI Act', jurisdiction: 'Colorado, US', officialRef: 'SB 24-205', enabled: false, coverage: 0, requirements: [
    req('6-1-1703(2)', 'Risk management policy', ['EG-04']), req('6-1-1703(3)', 'Impact assessment', ['EG-12']), req('6-1-1703(4)', 'Consumer notice', []),
  ] },
  { id: 'nyc144', name: 'New York City Local Law 144', short: 'NYC LL 144', jurisdiction: 'New York City, US', officialRef: 'Local Law 144 of 2021', enabled: false, coverage: 0, requirements: [
    req('§20-871(a)(1)', 'Independent bias audit within one year', []), req('§20-871(a)(2)', 'Public summary of audit results', []), req('§20-871(b)', 'Notice to candidates', []),
  ] },
];
