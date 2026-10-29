/**
 * Domain model for Elan1 Govern across every assurance level: L1 Guarded, L2 Attested (Seal v6, anchors,
 * KMS custody, verifier profiles, dual control), L3 Proven (counterparties, disclosure, earned autonomy,
 * customer-held keys) and Sovereign (own infrastructure, air-gapped updates).
 * The mock API in src/api returns exactly these shapes; a real backend replaces it later.
 */

export type ISODate = string;

/* ── Identity ─────────────────────────────────────────────── */

export type Role = 'owner' | 'admin' | 'approver' | 'viewer' | 'auditor';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  initials: string;
  orgIds: string[]; // auditors hold several client organisations
  phone?: string;
  mfa: boolean;
  lastSignIn?: ISODate;
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  industry: IndustryPack;
  regions: Region[];
  currency: 'INR' | 'USD' | 'EUR' | 'GBP';
  timezone: string;
  plan: PlanId;
  createdAt: ISODate;
  keyFingerprint: string;
  /** Every level the organisation has held, oldest first. The current level is the last entry (and equals `plan`). */
  levelHistory?: LevelPeriod[];
  /** hosted = elan1 runs it (ap-south-1); sovereign = the customer runs it on its own infrastructure. */
  deployment?: Deployment;
  /** Residency domain, e.g. 'ap-south-1 Mumbai' or 'On premises · Mumbai (BKC data centre)'. */
  residency?: string;
  /** Mail domain used in seeded data, e.g. 'northbank.co.in'. */
  domain?: string;
}

export type Region = 'India' | 'EU' | 'UK' | 'US';

export type IndustryPack = 'finance' | 'healthcare' | 'hr' | 'support' | 'sales' | 'engineering' | 'general';

/* ── Decisions ────────────────────────────────────────────── */

export type Decision = 'allow' | 'ask' | 'refuse';

export type RiskTag =
  | 'reads_data'
  | 'writes_data'
  | 'moves_money'
  | 'sends_external'
  | 'personal_data'
  | 'deletes'
  | 'changes_access'
  | 'changes_production';

/** Refusal ids the guard itself can produce (the developer docs list them under Errors); customer rule ids are free text. */
export type SystemRefusalId = 'agent-paused' | 'no-rulebook' | 'rulebook-invalid' | 'default' | 'invalid-arguments' | 'gate-error';

export type Route = 'mcp' | 'rest' | 'sdk';
/** governed run = MCP proxy, Elan1 Govern holds the credential (enforced). check and record = REST/SDK (advisory). */
export type Mode = 'governed_run' | 'check_and_record';

export type Channel = 'web' | 'email' | 'phone_link' | 'slack' | 'whatsapp';

/* ── Agents ───────────────────────────────────────────────── */

export type AgentStatus = 'active' | 'paused' | 'stopped' | 'draft';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string;
  framework: 'Claude' | 'Cursor' | 'LangChain' | 'OpenAI Agents SDK' | 'Custom';
  route: Route;
  status: AgentStatus;
  pausedBy?: 'owner' | 'auto-pause' | 'emergency-stop';
  ownerId: string;
  riskLevel: RiskLevel;
  rulebookId: string;
  aiSystemId?: string;
  connectorIds: string[];
  tools: string[];
  createdAt: ISODate;
  lastCallAt?: ISODate;
  keys: AgentKey[];
  stats: { calls7d: number; allowed7d: number; asked7d: number; refused7d: number };
  /** The model the agent runs on, e.g. "Claude Sonnet 4.5" (records area; absent in older saved state). */
  modelName?: string;
  /** The model's version or snapshot, e.g. "2025-09-29". */
  modelVersion?: string;
}

export interface AgentKey {
  id: string;
  prefix: string; // shown once in full, then only the prefix
  label: string;
  createdAt: ISODate;
  lastUsedAt?: ISODate;
  expiresAt?: ISODate;
  environment: 'sandbox' | 'production';
  revoked?: boolean;
}

/* ── Rulebooks ────────────────────────────────────────────── */

export type ConditionOp = 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'to_domain_in' | 'fields_include';

export interface Condition {
  field: string;
  op: ConditionOp;
  value: string | number | string[];
}

export interface Quota {
  kind: 'max_count' | 'max_sum';
  field?: string; // for max_sum
  limit: number;
  window: string; // 'day' | '1h' | '30m' | '7d'
}

export interface Rule {
  id: string;
  match: { tool?: string; tag?: RiskTag };
  when?: Condition[];
  unless?: Condition[]; // ask rules only
  decide: Decision;
  approver?: string; // approver group
  reason: string;
  expiresIn?: string; // '24h' default, max '30d'
  approveInChat?: boolean;
  quota?: Quota;
  mode?: 'enforce' | 'simulate';
}

export type RulebookStatus = 'published' | 'draft' | 'in_review';

export interface RulebookVersion {
  version: number;
  status: RulebookStatus;
  hash: string;
  signedBy?: string;
  signedAt?: ISODate;
  reviewedBy?: string;
  createdBy: string;
  createdAt: ISODate;
  note: string;
  rules: Rule[];
  yaml: string;
  /** Set when a published version was withdrawn: calls after `at` never use it (records area, mock/records.ts). */
  withdrawn?: { at: ISODate; by: string; reason: string; seq?: number; fallbackVersion?: number };
}

export interface Rulebook {
  id: string;
  slug: string;
  name: string;
  agentId: string;
  default: 'refuse';
  approverGroups: { id: string; name: string; members: string[] }[];
  currentVersion: number;
  versions: RulebookVersion[];
  updatedAt: ISODate;
}

export interface RuleSuggestion {
  id: string;
  rulebookId: string;
  title: string;
  rationale: string; // numbers only, never "we suggest approving"
  evidence: { approvals: number; days: number; counterparties: number; rejections: number };
  proposed: Rule;
  createdAt: ISODate;
  status: 'open' | 'drafted' | 'dismissed';
}

/* ── Receipts (22 top-level fields) ───────────────────────── */

export type ReceiptKind = 'decision' | 'approval' | 'outcome' | 'admin';

export interface Receipt {
  seq: number;
  ts: ISODate;
  org: string;
  kind: ReceiptKind;
  agent?: string; // agent slug
  tool?: string;
  args_summary?: Record<string, string | number | boolean>;
  args_hash?: string;
  rulebook?: { version: number; hash: string };
  rule_id?: string;
  decision?: Decision;
  reason?: string;
  approval?: { id: string; status: ApprovalStatus; approver?: string; channel?: Channel; self_approval?: boolean };
  outcome?: { status: 'ok' | 'error' | 'not_run'; ref?: string; ms?: number };
  ref_seq?: number;
  actor?: string; // person or system for admin receipts
  action?: string; // admin action e.g. rulebook.published, key.rotated, stop.engaged
  details?: Record<string, string | number | boolean>;
  prev_hash: string;
  kid: string;
  hash: string;
  sig: string;
  /**
   * Set when an executed erasure request removed fields from this receipt (in the organisation's chain and in every
   * export). The stored hash and signature are the originals, so the content hash cannot be recomputed. Instead the
   * organisation's key signs the redacted receipt at erasure time (`kid`, `sig` over lib/crypto redactionMessage,
   * which includes the original hash): changing any remaining field afterwards breaks that signature. The chain link
   * and the receipt's seal (F04 binding, F14 frozen payload hash) still verify.
   */
  redacted?: { fields: string[]; reason: string; request?: string; payloadHash?: string; at?: string; kid?: string; sig?: string };
  /** 'sandbox' when the call came with a sandbox agent key (sk_sbx_). Absent on production calls and on admin receipts. Part of the signed body. */
  environment?: 'sandbox' | 'production';
}

export interface Checkpoint {
  id: string;
  org: string;
  seq: number;
  hash: string;
  ts: ISODate;
  kid: string;
  sig: string;
  onDemand?: boolean;
}

/* ── Approvals ────────────────────────────────────────────── */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'approved_run_failed';

export interface Approval {
  id: string;
  seq: number; // decision receipt that held it
  agentSlug: string;
  tool: string;
  connector: string;
  headline: string; // "invoice-bot wants to pay ₹2,40,000 to Northwind Traders"
  ruleId: string;
  ruleReason: string;
  triggeredBy: string; // the fact that tripped the rule
  approverGroup: string;
  args: Record<string, string | number | boolean>;
  effect: string; // what happens if approved
  riskTags: RiskTag[];
  status: ApprovalStatus;
  createdAt: ISODate;
  expiresAt: ISODate;
  decidedAt?: ISODate;
  decidedBy?: string;
  channel?: Channel;
  decisionReason?: string;
  resultSeq?: number;
  similar: { approved: number; rejected: number; reversed: number };
  approveInChat: boolean;
  amount?: number;
  counterparty?: string;
  notified: Channel[];
  /** Who was notified when the call was held, from the organisation's saved routing (Settings › Notifications). */
  notifiedTo?: { userId: string; channels: Channel[] }[];
  /**
   * Set while an emergency stop covers this approval's agent. The approval keeps waiting (its expiry still runs —
   * expiry is a refusal) but nobody can decide it until the stop is lifted. Cleared on lift.
   */
  heldByStop?: { since: ISODate; incidentId?: string; by?: string };
  /** Automatic re-routes to a backup approver group (escalation policy), oldest first. */
  escalations?: ApprovalEscalation[];
  /** The group the rule first named, kept when the approval is escalated. Members of it may still decide. */
  originalGroup?: string;
  /** Set when an owner decided outside the approver group (recorded on the receipt). */
  override?: { by: string; reason: string };
  /** The one declared extension an approval may have: 24 more hours, with a reason, recorded on the chain. */
  extension?: { by: string; at: ISODate; reason: string; from: ISODate; to: ISODate; seq: number };
}

export interface ApprovalEscalation {
  at: ISODate;
  from: string; // group name
  to: string; // group name
  by: 'system' | string;
  afterMinutes?: number;
  seq?: number;
}

/** A single-use approval link (phone, email, chat). Used once, then dead. */
export interface ApprovalLinkToken {
  token: string;
  orgId: string;
  approvalId: string;
  issuedTo: string; // user id
  channel: Channel;
  issuedAt: ISODate;
  expiresAt: ISODate;
  usedAt?: ISODate;
  usedBy?: string;
  usedSeq?: number;
}

/* ── Connectors and upstream MCP servers ─────────────────── */

export interface ConnectorTool {
  name: string;
  description: string;
  tags: RiskTag[];
  suggestedTags?: RiskTag[];
  enabled: boolean;
  calls7d: number;
}

export interface Connector {
  id: string;
  kind: 'gmail' | 'zoho_books' | 'mcp_upstream';
  name: string;
  status: 'connected' | 'demo' | 'error' | 'disconnected';
  mode: 'live' | 'demo';
  url?: string;
  authHeader?: string; // masked
  region?: string;
  connectedAt: ISODate;
  lastSyncAt?: ISODate;
  tools: ConnectorTool[];
  heldCredential: boolean;
}

/* ── Governance layer ─────────────────────────────────────── */

export type Lifecycle = 'proposed' | 'in_review' | 'approved' | 'live' | 'retired';
export type RiskTier = 'minimal' | 'limited' | 'high' | 'unacceptable' | 'unassessed';

export interface AiSystem {
  id: string;
  name: string;
  kind: 'agent' | 'model' | 'vendor_tool' | 'internal_app';
  vendor: string;
  purpose: string;
  ownerId: string;
  businessUnit: string;
  lifecycle: Lifecycle;
  riskTier: RiskTier; // set only by an approved assessment
  dataCategories: string[];
  affectedPeople: string[];
  decisionImpact: 'none' | 'informs' | 'decides';
  linkedAgentId?: string;
  nextReview?: ISODate;
  createdAt: ISODate;
  frameworks: string[];
  /** The model behind the system, e.g. "GPT-4o" (records area; absent in older saved state). */
  modelName?: string;
  /** The model's version or snapshot. */
  modelVersion?: string;
}

export type AssessmentTemplate = 'risk_triage' | 'impact' | 'data_protection';
export type AssessmentStatus = 'draft' | 'submitted' | 'approved' | 'changes_requested';

export interface AssessmentQuestion {
  id: string;
  section: string;
  text: string;
  answer?: string;
  points: number;
  explanation: string;
}

export interface Assessment {
  id: string;
  aiSystemId: string;
  template: AssessmentTemplate;
  status: AssessmentStatus;
  score: number;
  maxScore: number;
  resultTier: RiskTier;
  authorId: string;
  reviewerId?: string;
  submittedAt?: ISODate;
  reviewedAt?: ISODate;
  createdAt: ISODate;
  reviewNote?: string;
  questions: AssessmentQuestion[];
}

export interface Control {
  id: string; // EG-01 … EG-13
  name: string;
  description: string;
  evidenceKind: string; // what receipts count as evidence
  evidenceCount: number;
  lastEvidenceAt?: ISODate;
  status: 'evidenced' | 'partial' | 'no_evidence';
  note?: string;
}

export interface Requirement {
  id: string; // e.g. Art. 14
  title: string;
  controlIds: string[];
}

export interface Framework {
  id: string;
  name: string;
  short: string;
  jurisdiction: string;
  officialRef: string;
  enabled: boolean;
  requirements: Requirement[];
  coverage: number; // 0..1 share of requirements with a mapped control that has live evidence
}

/* ── Alerts and incidents ─────────────────────────────────── */

export type Detector = 'volume_spike' | 'refusal_surge' | 'amount_outlier' | 'new_counterparty' | 'new_tool' | 'off_hours';
export type Severity = 'low' | 'medium' | 'high';

export interface Alert {
  id: string;
  detector: Detector;
  severity: Severity;
  agentSlug: string;
  title: string;
  detail: string;
  baseline: string;
  observed: string;
  status: 'open' | 'acknowledged' | 'resolved';
  createdAt: ISODate;
  acknowledgedBy?: string;
  resolvedAt?: ISODate;
  autoPaused?: boolean;
  relatedSeqs: number[];
}

export interface Incident {
  id: string;
  title: string;
  kind: 'emergency_stop' | 'auto_pause' | 'health';
  status: 'active' | 'resolved';
  scope: 'all_agents' | 'selected_agents';
  agentSlugs: string[];
  startedAt: ISODate;
  startedBy: string;
  reason: string;
  resolvedAt?: ISODate;
  resolvedBy?: string;
  refusedWhileStopped: number;
  pendingApprovalsAtStop: number;
  timeline: { ts: ISODate; text: string; seq?: number; actor?: string }[];
}

/* ── Settings ─────────────────────────────────────────────── */

export interface Member {
  userId: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  invitedAt?: ISODate;
  lastActiveAt?: ISODate;
  slackLinked?: boolean;
  whatsappVerified?: boolean;
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  status: 'active' | 'failing' | 'disabled';
  secretPrefix: string;
  createdAt: ISODate;
  deliveries: { id: string; event: WebhookEvent; ts: ISODate; status: number; attempts: number; ms: number }[];
}

/** Webhook events: the four built first plus the newer platform events (escalation, stop, erasure, counterparty, anchoring, integrity). */
export type WebhookEvent =
  | 'receipt.created' | 'approval.pending' | 'approval.resolved' | 'alert.created'
  | 'approval.escalated' | 'stop.engaged' | 'stop.lifted' | 'erasure.requested' | 'erasure.executed'
  | 'counterparty.receipt' | 'timestamp.anchored' | 'chain.integrity';

export interface SigningKey {
  kid: string;
  fingerprint: string;
  algorithm: 'Ed25519';
  /**
   * active: signs now · retired: stopped signing, still verifies · revoked: stopped after a declared compromise
   * (receipts before revokedAt still verify) · bound: published and bound, not yet signing ("Key bound · signing off").
   */
  status: 'active' | 'retired' | 'revoked' | 'bound';
  createdAt: ISODate;
  retiredAt?: ISODate;
  receiptsSigned: number;
  /** When the public key was first published (bound). Before createdAt when a successor was published ahead: the overlap. */
  publishedAt?: ISODate;
  revokedAt?: ISODate;
  revokedReason?: string;
  /** Elan1 Govern's interim chain key during a key compromise: receipts it seals are hash-chained, not signed. */
  interim?: boolean;
}

/* ── Billing and assurance ──────────────────────── */

export type PlanId = 'l1' | 'l2' | 'l3' | 'sovereign';

export interface Plan {
  id: PlanId;
  name: string;
  level: string;
  floorPerYear: number; // INR
  includedPerYear: number;
  overageRate: number; // INR per governed action beyond allowance
  refusalRate: number; // 40% of the overage rate
  status: 'available' | 'planned';
  buyer: string;
  proves: string[];
}

export interface UsageMonth {
  month: string; // '2026-10'
  allowed: number;
  approved: number; // ask → approved and run
  refused: number;
  expired: number;
}

export interface InvoiceLine {
  label: string;
  quantity?: number;
  unit?: string;
  rate?: number;
  amount: number;
  note?: string;
}

export interface Invoice {
  id: string;
  period: string;
  issuedAt: ISODate;
  status: 'paid' | 'due' | 'draft' | 'preview';
  lines: InvoiceLine[];
  subtotal: number;
  gst: number;
  total: number;
}

/* ── Status marks used across the console ─────────────────── */

export type BuildStatus = 'built' | 'partial' | 'planned' | 'specified';

/* ══════════════════════════════════════════════════════════════
 * Assurance levels and the complete platform (L1 → L2 → L3 → Sovereign)
 * ══════════════════════════════════════════════════════════════ */

/** Assurance level ids — the same ids as the plans. */
export type LevelId = PlanId;
export type Deployment = 'hosted' | 'sovereign';
export type DoorId = 'work' | 'records' | 'agents' | 'assurance';

export interface LevelPeriod {
  level: LevelId;
  from: ISODate;
  by?: string; // user id who upgraded; undefined for the starting level
  seq?: number; // the level.upgraded receipt
}

export type CapabilityId =
  // L1 Guarded
  | 'governed_run' | 'approvals' | 'signed_receipts' | 'checkpoints' | 'auditor_pack' | 'offline_verify'
  | 'dpdp_erasure' | 'regulatory_packs_dry_run' | 'counterparty_register_read'
  // L2 Attested
  | 'seal_v6' | 'two_implementations' | 'rfc3161_anchors' | 'merkle_batches' | 'kms_custody' | 'worm_storage'
  | 'evidence_bundle_8' | 'six_code_verifier' | 'verifier_profiles' | 'sd_jwt_redaction' | 'dual_control'
  | 'regulatory_packs'
  // L3 Proven
  | 'cross_org_verification' | 'selective_disclosure' | 'counterparty_register' | 'earned_autonomy'
  | 'customer_held_keys' | 'regulator_portal' | 'action_receipt_format'
  // Sovereign
  | 'own_infrastructure' | 'air_gapped_updates' | 'customer_hsm' | 'local_tsa' | 'no_egress';

export interface Capability {
  id: CapabilityId;
  label: string;
  level: LevelId; // the level it starts at
  door: DoorId;
  route: string;
  description: string;
}

/** The L1→L2 (or L2→L3 …) boundary in the chain: records before it carry the lower level. */
export interface LevelBoundary {
  from: LevelId;
  to: LevelId;
  at: ISODate;
  /** First receipt sequence at the new level (undefined when the boundary is before the chain window). */
  firstSeq?: number;
  recordsBefore: number;
  recordsAfter: number;
  /** true when the boundary falls before the first receipt this console holds (counts before it are 0 in the window). */
  beforeWindow: boolean;
}

export interface LevelState {
  orgId: string;
  level: LevelId;
  plan: Plan;
  deployment: Deployment;
  residency: string;
  history: LevelPeriod[];
  since: ISODate;
  boundaries: LevelBoundary[];
  capabilities: (Capability & { enabled: boolean; since?: ISODate })[];
  next?: LevelId;
}

export interface UpgradeStep {
  id: string;
  label: string;
  detail: string;
  /** who does it: elan1, the customer, or both */
  owner: 'elan1' | 'customer' | 'both';
}

export interface UpgradePlan {
  orgId: string;
  from: LevelId;
  to: LevelId;
  allowed: boolean;
  whyNot?: string;
  adds: Capability[];
  priceBefore: Plan;
  priceAfter: Plan;
  floorDifference: number; // INR per year
  steps: UpgradeStep[];
  boundaryNote: string;
}

/* ── Seal v6 ──────────────────────────────────────────────── */

export type SealFieldId = 'F01' | 'F02' | 'F03' | 'F04' | 'F05' | 'F06' | 'F07' | 'F08' | 'F09' | 'F10' | 'F11' | 'F12' | 'F13' | 'F14' | 'F15' | 'F16';

export interface SealField {
  id: SealFieldId;
  name: string; // tenant_id, seq, prev_digest …
  value: string;
}

export interface SealRecord {
  format: 'elan1.seal.v6';
  seq: number;
  /** The L1 receipt hash this seal binds (receipt.hash). */
  receiptHash: string;
  level: LevelId;
  fields: SealField[];
  /** Bytes in the length-prefixed preimage. */
  preimageBytes: number;
  /** SHA-256 over the length-prefixed preimage, hex. */
  digest: string;
  kid: string;
  /** Ed25519 over the 32 digest bytes, hex. */
  sig: string;
  /** The salt for F14 was destroyed by a DPDP erasure: the payload can no longer be linked, the seal still verifies. */
  payloadUnbound?: boolean;
}

export type TestVectorGroup = 'structure' | 'chain' | 'merkle_anchor' | 'negative';

export interface TestVector {
  id: string; // TV-01 … TV-64
  group: TestVectorGroup;
  title: string;
  expect: 'accept' | 'reject';
  /** Expected digest (hex) for accept vectors; the failing check for reject vectors. */
  expected: string;
  results: { typescript: 'pass' | 'fail'; python: 'pass' | 'fail' };
  /** Both implementations produced the same bytes. */
  agree: boolean;
}

export interface TestVectorSuite {
  version: string;
  implementations: { id: 'typescript' | 'python'; name: string; version: string; source: string; ranAt: ISODate; how: string }[];
  vectors: TestVector[];
  summary: { total: number; typescript: number; python: number; agree: number; byGroup: Record<TestVectorGroup, number> };
}

/* ── Anchoring (Merkle batches + RFC 3161) ────────────────── */

export interface TsaAuthority {
  id: string;
  name: string;
  scope: 'India' | 'Global' | 'Local';
  url: string;
  policyOid: string;
  publicKey: string; // hex, Ed25519 stand-in for the TSA certificate key
  fingerprint: string;
  status: 'operational' | 'degraded';
}

export interface TimestampToken {
  tsaId: string;
  tsaName: string;
  genTime: ISODate;
  serial: string;
  policyOid: string;
  status: 'granted' | 'granted_late';
  /** messageImprint: the batch's Merkle root. */
  imprint: string;
  sig: string;
  delaySeconds: number;
}

export interface AnchorBatch {
  id: string;
  windowStart: ISODate;
  windowEnd: ISODate;
  firstSeq: number;
  lastSeq: number;
  count: number;
  /** RFC 6962 Merkle root over the receipt hashes in the batch, hex. */
  root: string;
  tokens: TimestampToken[];
  status: 'anchored' | 'late';
}

export interface AnchorIncident {
  id: string;
  from: ISODate;
  to?: ISODate;
  records: number;
  status: 'recovered' | 'open';
  summary: string;
}

export interface AnchorsView {
  orgId: string;
  enabled: boolean;
  level: LevelId;
  since?: ISODate;
  authorities: TsaAuthority[];
  /** Authorities that stamped batches before the Sovereign boundary (an organisation that moved onto its own TSAs). Their tokens keep verifying. */
  previousAuthorities?: TsaAuthority[];
  batches: AnchorBatch[]; // newest first, limited
  totals: { batches: number; anchoredRecords: number; unanchoredTail: number; lastAnchoredSeq?: number; headSeq: number; withinTargetPct: number; targetMinutes: number };
  incidents: AnchorIncident[];
}

export interface InclusionProof {
  seq: number;
  receiptHash: string;
  leafHash: string;
  leafIndex: number;
  treeSize: number;
  batchId: string;
  root: string;
  path: { hash: string; side: 'left' | 'right' }[];
  tokens: TimestampToken[];
  /** recomputed root from the path equals the batch root */
  verified: boolean;
}

/* ── Key custody ──────────────────────────────────────────── */

export type CustodyMode = 'env_master' | 'aws_kms' | 'customer_hsm_cloud' | 'customer_hsm_onprem';

export interface KeyCeremony {
  id: string;
  kind: 'generation' | 'rotation' | 'quorum_check';
  at: ISODate;
  participants: { name: string; role: string }[];
  quorum: string; // '3 of 5'
  outcome: 'completed' | 'aborted';
  kidBefore?: string;
  kidAfter?: string;
  hsmSerial?: string;
  seq?: number;
  log: { at: ISODate; text: string }[];
}

export interface KeyCustody {
  orgId: string;
  mode: CustodyMode;
  provider: string; // 'Elan1 Govern process key', 'AWS KMS', 'AWS CloudHSM', 'Thales Luna', 'Entrust nShield'
  location: string;
  keyRef: string; // ARN, HSM label …
  alias?: string;
  algorithm: 'Ed25519';
  residencyDomain: string;
  heldBy: 'elan1' | 'customer';
  kid: string;
  fingerprint: string;
  rotation: { policy: string; lastRotatedAt?: ISODate; nextDueAt?: ISODate };
  quorum?: { required: number; of: number };
  holders?: { name: string; role: string }[];
  ceremonies: KeyCeremony[];
  note: string;
  /**
   * Set while signing is off after a declared key compromise: records are sealed by Elan1 Govern's interim chain
   * key (hash chain only), not by the organisation's key. `kid`/`fingerprint` above then name the organisation's
   * own key (the bound replacement, or the revoked key until one is bound), never the interim key.
   */
  signingOff?: { interimKid: string; interimFingerprint: string; since: ISODate; ownKeyStatus: SigningKey['status'] };
}

/* ── Verifier (six codes, nine sections) ─────────────────── */

export type VerifyCode = 'PASS' | 'PASS_UNANCHORED_TAIL' | 'PASS_KEY_FROM_BUNDLE' | 'PASS_L1_INTERNAL' | 'PASS_PAYLOAD_UNBOUND' | 'FAIL_INTEGRITY' | 'FAIL_PROFILE' | 'INCOMPLETE' | 'UNSUPPORTED' | 'USAGE';
export type SectionState = 'pass' | 'fail' | 'warn' | 'not_applicable' | 'incomplete';

export interface VerifySection {
  id: 'bundle' | 'keys' | 'signatures' | 'chain' | 'checkpoints' | 'anchors' | 'seals' | 'profile' | 'disclosure';
  number: number; // 1–9
  title: string;
  state: SectionState;
  detail: string;
  facts?: { label: string; value: string }[];
  firstFailure?: { seq?: number; field: string; expected: string; found: string };
}

/* ── Verifier profiles ────────────────────────────────────── */

export interface ProfileRule {
  id: string; // C01 …
  kind: 'integrity' | 'structural' | 'binding' | 'coverage' | 'temporal';
  clause: string;
  text: string;
  /** How the clause is bound: by a check (default), or honestly not measured / scoped out (E13 §02). */
  disposition?: 'bound' | 'not_measurable' | 'out_of_scope';
  /** not_measurable: why it cannot be measured, and what would change the answer (each ≥ 12 characters) */
  reason?: string;
  wouldChangeIf?: string;
  /** out_of_scope: the decision record, ADR-nnnn */
  adr?: string;
}

export interface VerifierProfile {
  id: string; // in-mca-audit-trail
  version: string;
  name: string;
  regime: string;
  jurisdiction: string;
  issuer: string;
  status: 'draft' | 'certified' | 'superseded' | 'withdrawn';
  retentionYears: number;
  requiredFields: string[];
  rules: ProfileRule[];
  packId?: PackId;
  limits: string;
  digest: string;
  /** the profile's author and issuer (never the same person), and when it was issued or withdrawn */
  author?: string;
  certifier?: string;
  certifiedAt?: ISODate;
  withdrawnAt?: ISODate;
  withdrawnReason?: string;
}

export interface ProfileRuleResult {
  id: string;
  kind: ProfileRule['kind'];
  clause: string;
  text: string;
  state: 'pass' | 'fail' | 'not_applicable' | 'not_measurable' | 'out_of_scope';
  detail: string;
  failingSeqs: number[];
}

export interface ProfileRunResult {
  id: string;
  profileId: string;
  version: string;
  orgId: string;
  ranAt: ISODate;
  ranBy?: string;
  range: { firstSeq: number; lastSeq: number; count: number };
  result: 'pass' | 'fail';
  rules: ProfileRuleResult[];
  digest: string;
  seq?: number;
}

/* ── Cross-organisation (L3) ──────────────────────────────── */

export type CounterpartyKind = 'customer' | 'vendor' | 'insurer' | 'lender' | 'regulator';

export interface Counterparty {
  id: string;
  name: string;
  kind: CounterpartyKind;
  domain: string;
  /** set when the counterparty is another organisation in this console (cross-org verify is real) */
  orgId?: string;
  seats: number;
  seatsUsed: number;
  verification: 'verified' | 'pending' | 'failed' | 'not_started';
  keyFingerprint?: string;
  keyRoute: 'pinned' | 'well_known' | 'trust_anchor';
  since: ISODate;
  contact: string;
  issued: number;
  received: number;
}

export interface VerifyStep { label: string; state: 'pass' | 'fail' | 'skip'; detail: string; /** refusal code a failed step carries, e.g. RECEIPT_REPLAYED */ code?: string }

/** A dispute about a cross-organisation receipt (L3): raised by the receiver, recorded on both sides. */
export interface CrossOrgDispute {
  status: 'open' | 'upheld' | 'rejected';
  raisedAt: ISODate;
  /** a person's name or user id */
  raisedBy: string;
  /** who raised it: the receiving organisation in this console, or a counterparty outside it (recorded by the issuer) */
  side: 'receiver' | 'counterparty';
  reason: string;
  seq?: number;
  resolvedAt?: ISODate;
  resolvedBy?: string;
  resolution?: string;
  resolveSeq?: number;
  /** who closed it: the issuer deciding, the receiver withdrawing its side, or the issuer revoking the receipt */
  closedBy?: 'issuer' | 'receiver' | 'revocation';
}

/** Dual control for accepting a received receipt (receipt.accept): one owner or admin starts, a different one completes. */
export interface CrossOrgAcceptance {
  state: 'pending' | 'accepted' | 'refused';
  first?: { userId: string; at: ISODate; seq?: number; note?: string };
  second?: { userId: string; at: ISODate; seq?: number; note?: string };
}

export interface CrossOrgReceipt {
  id: string;
  direction: 'issued' | 'received';
  counterpartyId: string;
  counterpartyName: string;
  issuerOrgId: string;
  issuerName: string;
  audience: string; // ar-org:<domain>
  seq: number; // issuer's receipt seq
  receiptHash: string;
  kid: string;
  publicKey: string;
  sig: string;
  issuedAt: ISODate;
  expiresAt: ISODate;
  nonce: string;
  summary: string;
  disclosureId?: string;
  /** public portal token for an issued receipt (/counterparty/:token) */
  token?: string;
  /** the full issuer receipt, held by the receiver so it can be re-verified offline */
  receipt?: Receipt;
  verification: { state: 'verified' | 'failed' | 'pending' | 'expired'; checkedAt?: ISODate; steps: VerifyStep[] };
  /** receiver's chain: the seq of the receipt that bound it */
  boundSeq?: number;
  /** receiver: when this copy arrived (replay detection keeps the first copy of a nonce) */
  receivedAt?: ISODate;
  /** issuer: the issued receipt this received copy came from (when the issuer is in this console) */
  peerId?: string;
  /** issuer side: the issuer revoked this receipt */
  revoked?: { at: ISODate; by: string; reason: string; seq?: number };
  /** receiver side: the issuer revoked it after it arrived */
  issuerRevoked?: { at: ISODate; reason: string; seq?: number };
  dispute?: CrossOrgDispute;
  /** receiver side: dual-control acceptance */
  acceptance?: CrossOrgAcceptance;
}

export interface DisclosureField { name: string; digest: string }
export interface RevealedField { name: string; salt: string; value: string }

export interface DisclosurePackage {
  id: string;
  orgId: string;
  issuerName: string;
  seq: number;
  receiptHash: string;
  createdAt: ISODate;
  createdBy: string;
  audience: string;
  counterpartyId?: string;
  token: string;
  expiresAt: ISODate;
  /** committed field digests, sorted by name — SHA-256 over canonical([salt, name, value]) */
  committed: DisclosureField[];
  revealed: RevealedField[];
  kid: string;
  publicKey: string;
  /** Ed25519 over canonical({iss, seq, receipt_hash, aud, exp, digests}) */
  sig: string;
  status: 'active' | 'revoked' | 'expired';
  views: number;
  /** When the portal link was last opened (saved with the organisation, like the count). */
  lastViewedAt?: ISODate;
  seqCreated?: number;
}

/* ── Earned autonomy (L3) ─────────────────────────────────── */

export type AutonomyLevel = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5';

export interface AutonomyGrant {
  id: string;
  agentSlug: string;
  tool: string;
  level: AutonomyLevel;
  /** A4 only: the bound the grant allows without a person (A4 is not yet available) */
  bound?: { field: string; max: number };
  grantedBy: string;
  grantedAt: ISODate;
  expiresAt?: ISODate;
  reason: string;
  seq?: number;
  revokedAt?: ISODate;
  revokedBy?: string;
  /** how the level was reached: the A2 starting level the platform writes at L3, or a two-person graduation */
  origin?: 'start' | 'graduation';
  /** graduation only: the proposal it came from */
  graduationId?: string;
  /** graduation only: the supervised period ends here; until then 1 in `sampleEvery` calls is sampled for a person */
  supervisedUntil?: ISODate;
  sampleEvery?: number;
}

export interface GraduationProposal {
  id: string;
  agentSlug: string;
  tool: string;
  from: AutonomyLevel;
  to: AutonomyLevel;
  /** numbers only — never a recommendation. `days` is days of operation for the agent and tool */
  evidence: { approvals: number; rejections: number; reversals: number; days: number; records: number; counterparties: number; medianMinutesToDecide: number };
  createdAt: ISODate;
  /** withdrawn: the proposer took it back before a second person decided */
  status: 'open' | 'granted' | 'declined' | 'withdrawn';
  required: number; // distinct people (2): the proposer and a different approver
  /** the owner or admin who proposed it (their justification is the first decision's note) */
  proposedBy?: string;
  decisions: { userId: string; approve: boolean; at: ISODate; note: string }[];
  seq?: number;
}

/** A person's review of a call sampled during a graduated grant's supervised period. */
export interface SampleReview {
  grantId: string;
  seq: number;
  by: string;
  at: ISODate;
  /** true: the call was right for A3; false: a concern (revoking is a separate press) */
  ok: boolean;
  note: string;
  reviewSeq?: number;
}

/* ── Regulatory packs ─────────────────────────────────────── */

export type PackId = 'ledger1' | 'invoice1' | 'collect1';

export interface AdmissionGate {
  id: 'G-A' | 'G-B' | 'G-C' | 'G-D' | 'G-E';
  label: string;
  description: string;
  evidence: string;
  /** 'provisional': passed on the evidence so far, waiting on the pilot's day-85 answer (G-D). "Probably" is scored not_met. */
  state: 'met' | 'not_met' | 'provisional';
}

export interface RegulatoryPack {
  id: PackId;
  name: string;
  regime: string;
  summary: string;
  buyer: string;
  declaration: { id: string; version: number; writeTypes: string[]; fields: string[]; dualControlAbove?: number };
  gates: AdmissionGate[];
  profileId: string;
  price: number;
  exports: { id: string; label: string; format: 'csv' | 'json' }[];
  installed: boolean;
  installedAt?: ISODate;
  installedBy?: string;
  /** Below L2 a pack runs as a dry run: rules and reports run, with no regulatory claim and no charge until L2. */
  dryRun?: boolean;
  coverage?: { writes: number; refusals: number; lastAt?: ISODate };
}

export interface PackExport {
  packId: PackId;
  exportId: string;
  filename: string;
  mime: string;
  text: string;
  rows: number;
  seq: number;
}

/* ── DPDP erasure ─────────────────────────────────────────── */

export interface ErasureRequest {
  id: string;
  subjectRef: string; // DP-2026-0141
  subjectHash: string; // SHA-256 of the identifier; the identifier itself is never stored
  reason: string;
  requestedBy: string;
  requestedAt: ISODate;
  dueAt: ISODate; // requestedAt + 72 hours
  affectedSeqs: number[];
  affected: number;
  required: number; // 2 different approvers
  approvals: { userId: string; at: ISODate }[];
  status: 'awaiting_approval' | 'approved' | 'executed' | 'rejected';
  executedAt?: ISODate;
  executedBy?: string;
  /** Set when the request was sent back (status 'rejected'): no clock runs and nothing is erased. */
  rejectedAt?: ISODate;
  rejectedBy?: string;
  rejectReason?: string;
  seq?: number;
  /** after execution the chain was re-verified */
  chainStillVerifies?: boolean;
}

/* ── Approvals: escalation ────────────────────────────────── */

export interface EscalationPolicy {
  groupId: string;
  groupName: string;
  afterMinutes: number;
  backupGroupId: string;
  backupGroupName: string;
  enabled: boolean;
  triggered: number;
  lastTriggeredAt?: ISODate;
}

export interface ApproverGroup { id: string; name: string; members: string[] }

/* ── Dual control and the reviews queue ───────────────────── */

export interface ReviewRequest {
  id: string;
  kind: 'rulebook';
  rulebookId: string;
  slug: string;
  version: number;
  requestedBy: string;
  requestedAt: ISODate;
  note: string;
  status: 'pending' | 'approved' | 'changes_requested' | 'published';
  /** SHA-256 of the draft YAML the reviewer was asked to review. Publishing under this review must publish exactly this content. */
  draftHash?: string;
  /** The rules of the draft the reviewer was asked to review. Publishing under this review signs these rules, never rules passed with the text. */
  rules?: Rule[];
  reviewerId?: string;
  decidedAt?: ISODate;
  decisionNote?: string;
}

export interface ReviewItem {
  id: string;
  kind: 'rulebook_review' | 'assessment_signoff' | 'erasure_approval' | 'graduation_proposal';
  title: string;
  detail: string;
  requestedBy: string;
  requestedAt: ISODate;
  dueAt?: ISODate;
  route: string;
  refId: string;
  canAct: boolean;
  whyNot?: string;
  enforced: boolean; // dual control enforced at this level (L2+) or only recorded (L1)
}

/* ── Meter ────────────────────────────────────────────────── */

export interface MeterEvent {
  id: string;
  seq: number;
  ts: ISODate;
  agent?: string;
  tool?: string;
  decision: Decision;
  outcome: 'committed' | 'refused' | 'pending';
  /** 1 for a committed action, 0.4 for a refused one (40% of the per-action rate), 0 while pending */
  quantity: number;
}

export interface MeterView {
  orgId: string;
  plan: Plan;
  window: { from: ISODate; to: ISODate; decisions: number; committed: number; refused: number; pending: number; units: number; valueAtOverage: number };
  events: MeterEvent[]; // newest first, limited
  months: (UsageMonth & { source: 'modelled' | 'chain' })[];
  modelledNote: string;
  invoices: Invoice[];
  allowance: { included: number; usedThisYear: number; remaining: number; pct: number };
  /**
   * The meter against the chain, counted two independent ways: `units` from the meter events (one per decision,
   * resolved through its approval) and `chainUnits` straight from the receipts (allowed decisions and approved
   * approvals count 1, refused decisions and rejected or expired approvals 0.4). `difference` = units − chainUnits.
   */
  reconciliation: { meterEvents: number; chainDecisions: number; matched: boolean; difference: number; units: number; chainUnits?: number; headSeq: number; digest: string; checkedAt: ISODate };
}

/* ── Sovereign deployment ─────────────────────────────────── */

export interface UpdateBundle {
  id: string;
  version: string;
  publishedAt: ISODate;
  sizeMb: number;
  digest: string;
  kid: string;
  fingerprint: string;
  sig: string;
  transport: 'air-gapped media' | 'managed rollout';
  status: 'available' | 'staged' | 'applied' | 'rejected';
  verified?: boolean;
  stagedAt?: ISODate;
  stagedBy?: string;
  appliedAt?: ISODate;
  appliedBy?: string;
  seq?: number;
  notes: string[];
  /** Sovereign: this bundle was applied and then rolled back to the one before it (mock/sovereign.ts). */
  rolledBackAt?: ISODate;
  rolledBackBy?: string;
  rollbackSeq?: number;
  rollbackReason?: string;
  /** Sovereign: a rollback of `restoredFrom` returned this bundle to service (then appliedAt/appliedBy/seq name that rollback); its first apply is kept here. */
  restoredFrom?: string;
  firstAppliedAt?: ISODate;
  firstAppliedBy?: string;
  firstAppliedSeq?: number;
}

export interface DeploymentView {
  orgId: string;
  mode: Deployment;
  operator: string;
  location: string;
  cluster: {
    name: string;
    distribution: string;
    version: string;
    nodes: { name: string; role: 'control-plane' | 'worker' | 'storage'; cpu: number; memoryGb: number; status: 'ready' | 'not_ready'; zone: string }[];
    cpuUsedPct: number;
    memoryUsedPct: number;
  };
  components: { name: string; version: string; status: 'running' | 'degraded'; replicas: number }[];
  database: { engine: string; rowLevelSecurity: boolean; replicas: number; sizeGb: number };
  secrets: { backend: string; version: string; sealed: boolean };
  storage: { backend: string; objectLock: 'compliance' | 'governance'; retentionYears: number; usedTb: number; capacityTb: number };
  hsm: { provider: string; model: string; fips: string; location: string; heldBy: 'elan1' | 'customer' };
  tsa: TsaAuthority[];
  egress: { policy: 'deny_all' | 'elan1_managed'; allowList: string[]; blockedLast24h: number; telemetry: 'none' | 'operational metrics only' };
  backup: { lastBackupAt: ISODate; rpoMinutes: number; rtoMinutes: number; lastDrillAt: ISODate; drillResult: 'passed' | 'failed'; site: string };
  updates: UpdateBundle[];
  release: { kid: string; fingerprint: string; publicKey: string };
}

/* ── Residency, identity, discovery ───────────────────────── */

export interface ResidencyView {
  orgId: string;
  domain: string;
  deployment: Deployment;
  stores: { name: string; location: string; provider: string; holds: string }[];
  crossBorder: { allowed: boolean; transfers30d: number; note: string };
  proof: { statement: string; digest: string; signedAt: ISODate; kid: string; sig: string };
}

export interface IdentityConfig {
  saml: { enabled: boolean; enforced: boolean; idp: string; entityId: string; acsUrl: string; metadataUrl: string; certFingerprint: string; certExpiresAt: ISODate; jitProvisioning: boolean; lastLoginAt?: ISODate };
  scim: { enabled: boolean; endpoint: string; tokenPrefix: string; lastSyncAt?: ISODate; usersProvisioned: number; deprovisioned30d: number; groupMap: { idpGroup: string; role: Role }[] };
}

export interface DiscoveryFinding {
  id: string;
  name: string;
  kind: 'api_key' | 'bot' | 'mcp_server' | 'browser_extension' | 'saas_feature';
  vendor: string;
  source: string;
  evidence: string;
  firstSeen: ISODate;
  lastSeen: ISODate;
  callsSeen: number;
  risk: RiskLevel;
  status: 'unregistered' | 'registered' | 'dismissed';
  aiSystemId?: string;
}

export interface DiscoveryScan {
  orgId: string;
  scannedAt: ISODate;
  sources: { name: string; kind: 'connector' | 'mcp_server' | 'identity_provider' | 'network'; scanned: boolean }[];
  findings: DiscoveryFinding[];
}

/* ── Public status ────────────────────────────────────────── */

export type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'maintenance';

export interface StatusComponent {
  id: string;
  name: string;
  group: 'Platform' | 'Delivery' | 'Timestamping' | 'Chain integrity';
  status: ComponentStatus;
  detail: string;
  uptime90: number; // 0..1
  days: { date: string; status: ComponentStatus; note?: string }[]; // 90, oldest first
}

export interface StatusView {
  updatedAt: ISODate;
  overall: ComponentStatus;
  components: StatusComponent[];
  incidents: { id: string; title: string; status: 'resolved' | 'monitoring'; startedAt: ISODate; resolvedAt?: ISODate; updates: { at: ISODate; text: string }[] }[];
}
