// The record types Seal v6 and the six-code verifier read, as the approved console defines them
// (apps/console/src/types.ts). Hashes, keys and signatures are lower-case hex without a prefix.

export type ISODate = string;
export type Decision = "allow" | "ask" | "refuse";
export type Channel = "web" | "email" | "phone_link" | "slack" | "whatsapp";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "approved_run_failed";

/** Assurance level ids — the same ids as the plans. */
export type LevelId = "l1" | "l2" | "l3" | "sovereign";
export type PackId = "ledger1" | "invoice1" | "collect1";

/* ── Receipts (22 top-level fields) ───────────────────────── */

export type ReceiptKind = "decision" | "approval" | "outcome" | "admin";

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
  outcome?: { status: "ok" | "error" | "not_run"; ref?: string; ms?: number };
  ref_seq?: number;
  actor?: string; // person or system for admin receipts
  action?: string; // admin action e.g. rulebook.published, key.rotated, stop.engaged
  details?: Record<string, string | number | boolean>;
  prev_hash: string;
  kid: string;
  hash: string;
  sig: string;
  /**
   * Set when an executed erasure request removed fields from this receipt. The stored hash and signature are the
   * originals, so the content hash cannot be recomputed: the organisation's key signs the redacted receipt instead
   * (`kid`, `sig` over redactionMessage, which includes the original hash).
   */
  redacted?: { fields: string[]; reason: string; request?: string; payloadHash?: string; at?: string; kid?: string; sig?: string };
  /** 'sandbox' when the call came with a sandbox agent key. Part of the signed body. */
  environment?: "sandbox" | "production";
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

/* ── Seal v6 ──────────────────────────────────────────────── */

export type SealFieldId = "F01" | "F02" | "F03" | "F04" | "F05" | "F06" | "F07" | "F08" | "F09" | "F10" | "F11" | "F12" | "F13" | "F14" | "F15" | "F16";

export interface SealField {
  id: SealFieldId;
  name: string; // tenant_id, seq, prev_digest …
  value: string;
}

export interface SealRecord {
  format: "elan1.seal.v6";
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
  /** The salt for F14 was destroyed by an erasure: the payload can no longer be linked, the seal still verifies. */
  payloadUnbound?: boolean;
}

export type TestVectorGroup = "structure" | "chain" | "merkle_anchor" | "negative";

export interface TestVector {
  id: string; // TV-01 … TV-64
  group: TestVectorGroup;
  title: string;
  expect: "accept" | "reject";
  /** Expected digest (hex) for accept vectors; the failing check for reject vectors. */
  expected: string;
  results: { typescript: "pass" | "fail"; python: "pass" | "fail" };
  /** Both implementations produced the same bytes. */
  agree: boolean;
}

export interface TestVectorSuite {
  version: string;
  implementations: { id: "typescript" | "python"; name: string; version: string; source: string; ranAt: ISODate; how: string }[];
  vectors: TestVector[];
  summary: { total: number; typescript: number; python: number; agree: number; byGroup: Record<TestVectorGroup, number> };
}

/* ── Anchoring (Merkle batches + RFC 3161) ────────────────── */

export interface TsaAuthority {
  id: string;
  name: string;
  scope: "India" | "Global" | "Local";
  url: string;
  policyOid: string;
  publicKey: string; // hex, Ed25519 stand-in for the TSA certificate key
  fingerprint: string;
  status: "operational" | "degraded";
}

export interface TimestampToken {
  tsaId: string;
  tsaName: string;
  genTime: ISODate;
  serial: string;
  policyOid: string;
  status: "granted" | "granted_late";
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
  status: "anchored" | "late";
}

/* ── Verifier (six codes, nine sections) ─────────────────── */

export type VerifyCode = "PASS" | "PASS_UNANCHORED_TAIL" | "PASS_KEY_FROM_BUNDLE" | "PASS_L1_INTERNAL" | "PASS_PAYLOAD_UNBOUND" | "FAIL_INTEGRITY" | "FAIL_PROFILE" | "INCOMPLETE" | "UNSUPPORTED" | "USAGE";
export type SectionState = "pass" | "fail" | "warn" | "not_applicable" | "incomplete";

export interface VerifySection {
  id: "bundle" | "keys" | "signatures" | "chain" | "checkpoints" | "anchors" | "seals" | "profile" | "disclosure";
  number: number; // 1–9
  title: string;
  state: SectionState;
  detail: string;
  facts?: { label: string; value: string }[];
  firstFailure?: { seq?: number; field: string; expected: string; found: string };
}

export interface VerifyStep {
  label: string;
  state: "pass" | "fail" | "skip";
  detail: string;
  /** refusal code a failed step carries, e.g. RECEIPT_REPLAYED */
  code?: string;
}

/* ── Verifier profiles ────────────────────────────────────── */

export interface ProfileRule {
  id: string; // C01 …
  kind: "integrity" | "structural" | "binding" | "coverage" | "temporal";
  clause: string;
  text: string;
  /** How the clause is bound: by a check (default), or honestly not measured / scoped out. */
  disposition?: "bound" | "not_measurable" | "out_of_scope";
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
  status: "draft" | "certified" | "superseded" | "withdrawn";
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
  kind: ProfileRule["kind"];
  clause: string;
  text: string;
  state: "pass" | "fail" | "not_applicable" | "not_measurable" | "out_of_scope";
  detail: string;
  failingSeqs: number[];
}

/* ── Selective disclosure ─────────────────────────────────── */

export interface DisclosureField {
  name: string;
  digest: string;
}
export interface RevealedField {
  name: string;
  salt: string;
  value: string;
}

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
  status: "active" | "revoked" | "expired";
  views: number;
  lastViewedAt?: ISODate;
  seqCreated?: number;
}

/* ── Erasure (as the profile rules read it) ───────────────── */

export interface ErasureRequest {
  id: string;
  subjectRef: string;
  /** SHA-256 of the identifier; the identifier itself is never stored */
  subjectHash: string;
  reason: string;
  requestedBy: string;
  requestedAt: ISODate;
  /** requestedAt + 72 hours */
  dueAt: ISODate;
  affectedSeqs: number[];
  affected: number;
  /** 2 different approvers */
  required: number;
  approvals: { userId: string; at: ISODate }[];
  status: "awaiting_approval" | "approved" | "executed" | "rejected";
  executedAt?: ISODate;
  executedBy?: string;
  rejectedAt?: ISODate;
  rejectedBy?: string;
  rejectReason?: string;
  seq?: number;
  chainStillVerifies?: boolean;
}
