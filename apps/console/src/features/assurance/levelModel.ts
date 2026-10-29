/**
 * What each assurance level says, proves and needs — and the upgrade wizard's stages and progress.
 * Wizard progress is kept in the organisation's own chain (level.upgrade_* admin receipts), so it is
 * shared by everyone in the organisation, survives a reload and is itself evidence.
 */
import { db } from '@/api';
import type { CapabilityId, LevelId, Receipt } from '@/types';
import { LEVELS, levelRank } from '@/lib/levels';
import { personFor, userById, userName } from '@/mock/users';

export const LEVEL_COPY: Record<LevelId, {
  forWhom: string;
  question: string;
  mustBeTrue: { text: string; cap: CapabilityId }[];
  wouldSay: string;
  claim: string;
  deployment?: string[];
}> = {
  l1: {
    forWhom: 'Operators — the finance controller or head of operations who lets the agent run.',
    question: 'Can I let this run without it doing something I cannot undo?',
    mustBeTrue: [
      { text: 'Every tool call reaches Elan1 Govern before it runs', cap: 'governed_run' },
      { text: 'A named person approves the held actions', cap: 'approvals' },
      // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
      { text: 'Receipts are sealed with Ed25519 in a hash chain', cap: 'signed_receipts' },
      { text: 'The chain head is checkpointed every hour', cap: 'checkpoints' },
      { text: 'An auditor pack verifies offline, with no account', cap: 'offline_verify' },
    ],
    wouldSay: 'Checked against versioned rules before it happened; a person approved it; tamper-evident to you, the chain holder.',
    claim: 'sealed in a hash chain by Elan1 Govern and not yet externally timestamped',
  },
  l2: {
    forWhom: 'Auditors, lenders doing diligence and compliance teams who receive the evidence.',
    question: 'Can I hand this over and have it checked without us in the room?',
    mustBeTrue: [
      { text: 'Seal v6: 16 frozen fields, SHA-256 over a length-prefixed preimage, Ed25519', cap: 'seal_v6' },
      { text: 'Two implementations agree byte for byte on 64 test vectors', cap: 'two_implementations' },
      { text: 'Every batch timestamped by eMudhra (India) and a global authority within 15 minutes', cap: 'rfc3161_anchors' },
      { text: 'Merkle batches (RFC 6962) with an inclusion proof per record', cap: 'merkle_batches' },
      { text: 'Signing key in AWS KMS in the residency domain (ap-south-1)', cap: 'kms_custody' },
      { text: 'Write-once storage under S3 Object Lock', cap: 'worm_storage' },
      { text: 'A six-code verifier and profiles per regime', cap: 'verifier_profiles' },
      { text: 'Dual control enforced on every rulebook publish', cap: 'dual_control' },
    ],
    wouldSay: 'A party holding our key fingerprint, obtained out of band, can check this bundle on an air-gapped machine, against a named regime, with no elan1 process running.',
    claim: 'sealed, signed with a key in AWS KMS and timestamped by two authorities',
  },
  l3: {
    forWhom: 'Counterparties, regulators and insurers who were never customers.',
    question: 'Does this survive the vendor?',
    mustBeTrue: [
      { text: 'Receipts issued to and verified by other organisations', cap: 'cross_org_verification' },
      { text: 'Selective disclosure — reveal some fields, commit to the rest', cap: 'selective_disclosure' },
      { text: 'Signing key in your HSM, created in a key ceremony', cap: 'customer_held_keys' },
      { text: 'Earned autonomy: A2 to A3 only by a two-person graduation per agent and write type', cap: 'earned_autonomy' },
      { text: 'A counterparty register with verification seats', cap: 'counterparty_register' },
      { text: 'The Action Receipt format is published', cap: 'action_receipt_format' },
    ],
    wouldSay: 'The format is published and the key is yours; a receipt stays checkable by a counterparty after the vendor is gone.',
    claim: 'signed with a key you hold in your HSM and timestamped by two authorities',
  },
  sovereign: {
    forWhom: 'A bank, insurer or public body that must run it on its own infrastructure.',
    question: 'Can we run all of it ourselves, with nothing leaving our network?',
    mustBeTrue: [
      { text: 'Kubernetes, PostgreSQL 16 with row-level security, OpenBao and object-lock storage in your data centre', cap: 'own_infrastructure' },
      { text: 'Signing keys in your HSM on premises', cap: 'customer_hsm' },
      { text: 'Two timestamp authorities inside your network', cap: 'local_tsa' },
      { text: 'Updates arrive as signed, air-gapped bundles', cap: 'air_gapped_updates' },
      { text: 'No telemetry egress; the allow-list starts empty', cap: 'no_egress' },
      { text: 'The same receipts and the same offline verifier', cap: 'offline_verify' },
    ],
    wouldSay: 'Everything Proven proves, run entirely by you: your cluster, your keys, your timestamp authorities, and nothing sent to elan1.',
    claim: 'signed in your own HSM and timestamped by your own two authorities',
    deployment: [
      'Kubernetes: 3 control-plane and 4 worker nodes, plus storage nodes',
      'PostgreSQL 16 with row-level security per tenant',
      'OpenBao for secrets',
      'Object-lock storage: Ceph, SeaweedFS or Garage',
      'Your HSM (Thales Luna or Entrust nShield) and a 3 of 5 key ceremony',
      'Two local timestamp authorities',
      'Signed install and update bundles on air-gapped media',
      'Egress denied by default; no telemetry',
    ],
  },
};

/** The one-line evidence claim for a level. */
export const claimFor = (level: LevelId) => LEVEL_COPY[level].claim;

/** Stated limits per level — what a pass does not prove. */
export function limitsFor(level: LevelId): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  if (level === 'l1') {
    out.push({ title: 'When it happened, to an outsider', text: 'Receipts are not externally timestamped at L1; their times come from Elan1 Govern’s clock. Two-authority timestamps start at L2.' });
    out.push({ title: 'That nobody holding the key rewrote it', text: 'The key is held by Elan1 Govern, so the record is tamper-evident to you, the chain holder. A party who does not trust Elan1 Govern cannot rely on it alone; L2 moves the key into AWS KMS and adds outside timestamps.' });
  } else {
    out.push({ title: 'Records before the boundary', text: 'Records from before the organisation reached L2 stay at the level they were written at: sealed in a hash chain by Elan1 Govern, with no Seal v6 record and no timestamp. They still verify.' });
    out.push({ title: 'The newest records', text: 'Records in the batch still being formed (the unanchored tail, at most 15 minutes) are sealed and signed but not yet timestamped. The verifier says so: PASS_UNANCHORED_TAIL.' });
  }
  if (level === 'l2') out.push({ title: 'Who holds the key', text: 'The key is in AWS KMS in elan1’s account (ap-south-1); its material never leaves KMS and every use is logged. A key you hold yourself starts at L3.' });
  if (level === 'l3' || level === 'sovereign') out.push({ title: 'What a counterparty sees', text: 'A disclosure reveals only the fields you chose; the rest are committed digests. The counterparty can check that the hidden fields exist and were not changed, not what they say.' });
  out.push({ title: 'That the transaction was genuine', text: 'A receipt shows what was decided, by which rule and who approved it. It does not show that the payment, email or record behind it was correct.' });
  out.push({ title: 'That a control works', text: 'Coverage is a count of receipts mapped to controls, not a test that a control works.' });
  return out;
}

/* ── Upgrade wizard ───────────────────────────────────────── */

export type StageId = 'preflight' | 'kms' | 'tsa' | 'worm' | 'profile' | 'notice' | 'second' | 'ceremony' | 'counterparties' | 'autonomy' | 'infra' | 'local_tsa' | 'bundle' | 'egress';

export interface StageDef { id: StageId; title: string; summary: string; level: LevelId | 'all' }

const STAGE_DEFS: Record<StageId, StageDef> = {
  preflight: { id: 'preflight', level: 'all', title: 'Pre-flight', summary: 'Replay the whole chain in this browser — sequence, hash links, Ed25519 seals and checkpoints — before anything changes.' },
  // used on L1 → L2 only (see stagesFor): no other path creates a KMS key
  kms: { id: 'kms', level: 'l2', title: 'Signing key in AWS KMS', summary: 'Create the new Ed25519 key in AWS KMS in your residency domain before the switch, and compare its fingerprint with the one elan1 sends by a separate channel. At the switch the old key is retired for signing and kept for verification.' },
  tsa: { id: 'tsa', level: 'l2', title: 'Timestamp authorities', summary: 'eMudhra (India) and one global authority timestamp every 15-minute Merkle batch.' },
  worm: { id: 'worm', level: 'l2', title: 'Write-once storage', summary: 'Receipts and bundles are kept under S3 Object Lock in compliance mode.' },
  profile: { id: 'profile', level: 'l2', title: 'Verifier profile', summary: 'Choose the regime your auditor checks against, or record that no profile is claimed.' },
  notice: { id: 'notice', level: 'l2', title: 'Customer notices', summary: 'Give your named contact 14 days’ notice of the boundary, and schedule the boundary-day confirmation and the note to your auditor. Each notice is a receipt.' },
  second: { id: 'second', level: 'l2', title: 'Second person', summary: 'A different owner or admin confirms. Signing at L2 cannot be undone, so it takes two people.' },
  ceremony: { id: 'ceremony', level: 'l3', title: 'Key ceremony', summary: 'Your key holders create the signing key in your HSM with a 3 of 5 quorum. The quorum is the dual control: no single person can create or use the key.' },
  counterparties: { id: 'counterparties', level: 'l3', title: 'Counterparties', summary: 'Name the organisations that will verify your receipts. Each holds a seat (₹45,000 a year).' },
  autonomy: { id: 'autonomy', level: 'l3', title: 'Earned autonomy', summary: 'Every agent write type starts at A2 Propose: a person approves each write. A3 comes only from a two-person graduation on the record; no one sets a level.' },
  infra: { id: 'infra', level: 'sovereign', title: 'Your infrastructure', summary: 'Kubernetes, PostgreSQL 16 with row-level security, OpenBao and object-lock storage, ready in your data centre.' },
  local_tsa: { id: 'local_tsa', level: 'sovereign', title: 'Local timestamp authorities', summary: 'Two timestamp authorities inside your network replace the public ones.' },
  bundle: { id: 'bundle', level: 'sovereign', title: 'Signed install bundle', summary: 'The install bundle arrives on air-gapped media; its signature is checked against the elan1 release key.' },
  egress: { id: 'egress', level: 'sovereign', title: 'Deny all egress', summary: 'Nothing leaves your network. The allow-list starts empty and no telemetry is sent.' },
};

/** The stages for a move from `from` to `to`, in order. Dual control: a second person at L2, the key ceremony quorum from L3. */
export function stagesFor(from: LevelId, to: LevelId): StageDef[] {
  const crossing = (l: LevelId) => levelRank(l) > levelRank(from) && levelRank(l) <= levelRank(to);
  const ids: StageId[] = ['preflight'];
  // Sovereign brings its own HSM, timestamp authorities and object-lock storage (infra, ceremony, local_tsa),
  // so a move straight to Sovereign skips the hosted L2 stages (AWS KMS, public authorities, S3 Object Lock).
  // The AWS KMS key is created (before the switch) only on L1 → L2: a move from L1 straight to L3 creates its
  // signing key in the customer's HSM at the key ceremony, and no KMS key is made.
  if (crossing('l2')) ids.push(...(to === 'sovereign' ? [] : to === 'l2' ? (['kms', 'tsa', 'worm'] as StageId[]) : (['tsa', 'worm'] as StageId[])), 'profile');
  if (crossing('sovereign')) ids.push('infra');
  if (crossing('l3') || crossing('sovereign')) ids.push('ceremony');
  if (crossing('l3')) ids.push('counterparties', 'autonomy');
  if (crossing('sovereign')) ids.push('local_tsa', 'bundle', 'egress');
  // L1 → L2: the customer notices come before the second person (see mock/upgrade.ts for the close-out)
  if (from === 'l1' && to === 'l2') ids.push('notice');
  if (!crossing('l3') && !crossing('sovereign')) ids.push('second');
  return ids.map((id) => STAGE_DEFS[id]);
}

export interface UpgradeRun {
  to: LevelId;
  from: LevelId;
  startedBy: string;
  startedSeq: number;
  startedAt: string;
  stages: Partial<Record<StageId, Receipt>>;
}

/** The upgrade in progress, read from the chain: the last level.upgrade_started not followed by a cancel or the upgrade itself. */
export function currentRun(receipts: Receipt[]): UpgradeRun | undefined {
  let start = -1;
  for (let i = receipts.length - 1; i >= 0; i--) {
    const a = receipts[i].action;
    if (a === 'level.upgrade_cancelled' || a === 'level.upgraded') return undefined;
    if (a === 'level.upgrade_started') { start = i; break; }
  }
  if (start < 0) return undefined;
  const s = receipts[start];
  const to = String(s.details?.to) as LevelId;
  const run: UpgradeRun = { to, from: String(s.details?.from) as LevelId, startedBy: s.actor ?? '', startedSeq: s.seq, startedAt: s.ts, stages: {} };
  for (let i = start + 1; i < receipts.length; i++) {
    const r = receipts[i];
    if (r.action === 'level.upgrade_stage' && r.details?.to === to) run.stages[String(r.details.stage) as StageId] = r;
    if (r.action === 'level.upgrade_seconded' && r.details?.to === to) run.stages.second = r;
    // L1 → L2: the notice stage is done when the 14-day notice has gone to the named contact
    if (r.action === 'level.upgrade_notice_sent' && r.details?.kind === 'fourteen_day') run.stages.notice = r;
  }
  return run;
}

/** The last completed upgrade receipt, if any. */
export function lastUpgrade(receipts: Receipt[]): Receipt | undefined {
  for (let i = receipts.length - 1; i >= 0; i--) if (receipts[i].action === 'level.upgraded') return receipts[i];
  return undefined;
}

/** Record a wizard step as an admin receipt in the organisation's chain. */
export function recordStep(orgId: string, userId: string, action: 'level.upgrade_started' | 'level.upgrade_stage' | 'level.upgrade_seconded' | 'level.upgrade_cancelled', details: Record<string, string | number | boolean>) {
  return db.logAdmin(orgId, userId, action, details);
}

/** The five key holders and the three who attend a ceremony (the same people the platform records). */
export function keyHolders(orgId: string) {
  const ids = ['u_ananya', 'u_rahul', 'u_fatima', 'u_sanjay', 'u_venkat'].map((x) => personFor(orgId, x));
  return ids.map((id, i) => ({ id, name: userName(id), role: userById(id)?.title ?? 'Key holder', attends: i < 3 }));
}

export const levelsAbove = (level: LevelId) => LEVELS.filter((l) => levelRank(l) > levelRank(level));
