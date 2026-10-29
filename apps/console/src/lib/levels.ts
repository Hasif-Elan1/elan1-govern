import type { Capability, CapabilityId, LevelId, Org, PlanId } from '@/types';

/**
 * Assurance levels — L1 Guarded → L2 Attested → L3 Proven → Sovereign.
 * Each level includes everything below it. Sovereign is L3 run on the customer's own infrastructure,
 * so it includes every L3 capability. A level's capabilities start at the moment the organisation
 * reaches it (the boundary date); records before the boundary keep the lower level.
 */
export const LEVELS: LevelId[] = ['l1', 'l2', 'l3', 'sovereign'];

export const LEVEL_INFO: Record<LevelId, { short: string; tag: string; name: string; label: string; question: string }> = {
  l1: { short: 'L1', tag: 'L1', name: 'Guarded', label: 'Guarded · L1', question: 'Can I let this run?' },
  l2: { short: 'L2', tag: 'L2', name: 'Attested', label: 'Attested · L2', question: 'Can I hand this over?' },
  l3: { short: 'L3', tag: 'L3', name: 'Proven', label: 'Proven · L3', question: 'Does this survive the vendor?' },
  sovereign: { short: 'Sovereign', tag: 'SOV', name: 'Sovereign', label: 'Sovereign · on premises', question: 'Can we run it ourselves?' },
};

/** 0 = L1, 1 = L2, 2 = L3, 3 = Sovereign. */
export function levelRank(level: LevelId | PlanId | undefined): number {
  const i = LEVELS.indexOf((level ?? 'l1') as LevelId);
  return i < 0 ? 0 : i;
}

/** true when `level` is at least `atLeast`. */
export function atLeast(level: LevelId | undefined, atLeastLevel: LevelId): boolean {
  return levelRank(level) >= levelRank(atLeastLevel);
}

export const CAPABILITIES: Capability[] = [
  // L1 Guarded
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided (decision 2)
  { id: 'governed_run', label: 'Decide before the call', level: 'l1', door: 'agents', route: '/agents', description: 'Every tool call is checked against a published rulebook before it runs: allow, ask a person, or refuse (default refuse).' },
  { id: 'approvals', label: 'A named person approves', level: 'l1', door: 'work', route: '/approvals', description: 'Held calls wait for a named approver on web, email, Slack, WhatsApp or a single-use phone link.' },
  { id: 'signed_receipts', label: 'Receipts sealed in a hash chain', level: 'l1', door: 'records', route: '/activity', description: 'Every decision is a receipt sealed in a hash chain by Elan1 Govern, each linked to the one before by SHA-256; not yet externally timestamped.' },
  { id: 'checkpoints', label: 'Hourly checkpoints', level: 'l1', door: 'assurance', route: '/evidence', description: 'The chain head is sealed every hour it moves, and on demand.' },
  { id: 'auditor_pack', label: 'Auditor pack', level: 'l1', door: 'assurance', route: '/assurance/exports', description: 'Receipts, checkpoints and public keys in one file for an auditor.' },
  { id: 'offline_verify', label: 'Offline verify', level: 'l1', door: 'assurance', route: '/verify', description: 'Anyone can verify a pack on their own machine with no account and no network.' },
  { id: 'dpdp_erasure', label: 'Erasure by salt destruction', level: 'l1', door: 'records', route: '/records/erasure', description: 'Two approvers, a 72-hour clock, then the salt is destroyed: the payload is unlinkable and the chain still verifies. Records are salted from the first L1 record.' },
  { id: 'regulatory_packs_dry_run', label: 'Regulatory packs as a dry run', level: 'l1', door: 'records', route: '/records/packs', description: 'Install a pack and its rules run on every call, with reports marked “dry run — no regulatory claim until L2”. Not billed until L2.' },
  { id: 'counterparty_register_read', label: 'Counterparty register (read-only)', level: 'l1', door: 'assurance', route: '/assurance/counterparties', description: 'Every counterparty your agents acted on, listed from the chain. Seats and issuing receipts start at L3.' },
  // L2 Attested
  { id: 'seal_v6', label: 'Seal v6 sealed records', level: 'l2', door: 'assurance', route: '/activity/chain', description: '16 frozen fields, SHA-256 over a length-prefixed preimage, signed with Ed25519.' },
  { id: 'two_implementations', label: 'Two implementations agree', level: 'l2', door: 'assurance', route: '/assurance/levels', description: 'TypeScript and Python seal the same 64 test vectors byte for byte.' },
  { id: 'rfc3161_anchors', label: 'Timestamps from two authorities', level: 'l2', door: 'assurance', route: '/assurance/anchors', description: 'Every batch is timestamped (RFC 3161) by eMudhra in India and one global authority within 15 minutes.' },
  { id: 'merkle_batches', label: 'Merkle batches with inclusion proofs', level: 'l2', door: 'assurance', route: '/assurance/anchors', description: 'Receipts are batched every 15 minutes into an RFC 6962 Merkle tree; each receipt has an inclusion proof.' },
  { id: 'kms_custody', label: 'Key custody in AWS KMS', level: 'l2', door: 'agents', route: '/agents/keys', description: 'The signing key lives in AWS KMS in the residency domain (ap-south-1), never in the application.' },
  { id: 'worm_storage', label: 'Write-once storage', level: 'l2', door: 'assurance', route: '/agents/deployment', description: 'Receipts and bundles are stored under S3 Object Lock in compliance mode.' },
  { id: 'evidence_bundle_8', label: '8-member evidence bundle', level: 'l2', door: 'assurance', route: '/assurance/exports', description: 'Manifest, receipts, seals, checkpoints, anchors, keys, declarations, profile and README.' },
  { id: 'six_code_verifier', label: 'Verifier with six result codes', level: 'l2', door: 'assurance', route: '/verify', description: 'PASS, FAIL_INTEGRITY, FAIL_PROFILE, INCOMPLETE, UNSUPPORTED, USAGE — and a nine-section report.' },
  { id: 'verifier_profiles', label: 'Verifier profiles per regime', level: 'l2', door: 'assurance', route: '/assurance/profiles', description: 'MCA audit trail, GST e-invoicing, RBI collections, EU AI Act Art. 12, DPDP, ISO 42001 and NIST.' },
  { id: 'sd_jwt_redaction', label: 'Redaction (SD-JWT)', level: 'l2', door: 'assurance', route: '/assurance/exports', description: 'Fields are committed as salted digests so a bundle can be redacted and still verify.' },
  { id: 'dual_control', label: 'Dual control on publish', level: 'l2', door: 'work', route: '/work/reviews', description: 'A rulebook is published only after a different person reviews it.' },
  { id: 'regulatory_packs', label: 'Regulatory packs, live', level: 'l2', door: 'records', route: '/records/packs', description: 'ledger1 (MCA audit trail), invoice1 (GST e-invoicing) and collect1 (RBI collections conduct) go live with a regulatory claim. At L1 they run as a dry run.' },
  // L3 Proven
  { id: 'cross_org_verification', label: 'Verification between organisations', level: 'l3', door: 'assurance', route: '/assurance/counterparties', description: 'Issue receipts to counterparties and verify the ones they send you.' },
  { id: 'selective_disclosure', label: 'Selective disclosure', level: 'l3', door: 'assurance', route: '/assurance/disclosure', description: 'Reveal only the fields a counterparty needs; the rest stay committed and checkable.' },
  { id: 'counterparty_register', label: 'Verification seats for counterparties', level: 'l3', door: 'assurance', route: '/assurance/counterparties', description: 'Each counterparty that verifies holds a seat (₹45,000 a year).' },
  { id: 'earned_autonomy', label: 'Earned autonomy (graduation to A3)', level: 'l3', door: 'agents', route: '/agents/autonomy', description: 'Per agent, per tool, by graduation only: A3 after a two-person graduation (≥90 days, ≥200 records, ≥100 approvals) and a 30-day supervised period. Revoke is one press. A4 and A5 are not yet available.' },
  { id: 'customer_held_keys', label: 'Customer-held keys', level: 'l3', door: 'agents', route: '/agents/keys', description: 'The signing key lives in your HSM (CloudHSM, Thales Luna or Entrust nShield), created in a key ceremony.' },
  { id: 'regulator_portal', label: 'Regulator and partner portals', level: 'l3', door: 'assurance', route: '/assurance/counterparties', description: 'A read-only portal where a regulator or partner checks what you shared with them.' },
  { id: 'action_receipt_format', label: 'Action Receipt published format', level: 'l3', door: 'assurance', route: '/developers', description: 'The receipt format is published, so a receipt stays checkable without Elan1 Govern.' },
  // Sovereign
  { id: 'own_infrastructure', label: 'Your own infrastructure', level: 'sovereign', door: 'agents', route: '/agents/deployment', description: 'Kubernetes, PostgreSQL 16 with row-level security, OpenBao secrets and object-lock storage in your data centre.' },
  { id: 'air_gapped_updates', label: 'Air-gapped signed updates', level: 'sovereign', door: 'agents', route: '/agents/deployment', description: 'Updates arrive as signed bundles; you verify, stage and apply them, and each step is a receipt.' },
  { id: 'customer_hsm', label: 'Your HSM on premises', level: 'sovereign', door: 'agents', route: '/agents/keys', description: 'Signing keys never leave your HSM.' },
  { id: 'local_tsa', label: 'Local timestamp authorities', level: 'sovereign', door: 'assurance', route: '/assurance/anchors', description: 'Two timestamp authorities inside your network.' },
  { id: 'no_egress', label: 'No telemetry egress', level: 'sovereign', door: 'agents', route: '/agents/deployment', description: 'Egress is denied by default and the allow-list is empty. Nothing is sent to elan1.' },
];

export const capabilityById = (id: CapabilityId) => CAPABILITIES.find((c) => c.id === id)!;

/** The plan (level) an organisation is on now. */
export function levelOfOrg(org: Pick<Org, 'plan'> | undefined): LevelId {
  return (org?.plan ?? 'l1') as LevelId;
}

/** true when the plan includes the capability. Sovereign includes every L3 capability. */
export function hasCapability(plan: LevelId | undefined, cap: CapabilityId): boolean {
  const c = CAPABILITIES.find((x) => x.id === cap);
  if (!c) return false;
  return levelRank(plan) >= levelRank(c.level);
}

/** Every capability the plan includes, lowest level first. */
export function capabilitiesFor(plan: LevelId | undefined): Capability[] {
  return CAPABILITIES.filter((c) => levelRank(plan) >= levelRank(c.level));
}

/** Capabilities a move from `from` to `to` adds. */
export function capabilitiesAdded(from: LevelId, to: LevelId): Capability[] {
  return CAPABILITIES.filter((c) => levelRank(c.level) > levelRank(from) && levelRank(c.level) <= levelRank(to));
}

/** The next level up, or undefined at Sovereign. */
export function nextLevel(plan: LevelId | undefined): LevelId | undefined {
  return LEVELS[levelRank(plan) + 1];
}

/** The level a capability (or a screen) needs, as a short tag: 'L2', 'L3', 'SOV'. */
export function levelTag(level: LevelId): string {
  return LEVEL_INFO[level].tag;
}

/** The level in force at a moment, from the organisation's history. */
export function levelAt(history: { level: LevelId; from: string }[] | undefined, t: number, fallback: LevelId = 'l1'): LevelId {
  if (!history?.length) return fallback;
  let lv: LevelId = history[0].level;
  for (const p of history) if (new Date(p.from).getTime() <= t) lv = p.level;
  if (new Date(history[0].from).getTime() > t) return 'l1';
  return lv;
}
