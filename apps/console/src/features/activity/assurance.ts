/**
 * Level-aware helpers for Activity, Receipt, Chain and the Auditor workspace:
 * the evidence claim per level, the level a receipt was written at, the L1→L2 boundary split,
 * custody wording and which regulatory pack a receipt falls under. (The controls a receipt counts towards come from
 * features/compliance/evidence.ts controlIdsForReceipt, so they match Coverage.)
 * Pure functions: no data is fetched here.
 */
import type { KeyCustody, LevelId, LevelPeriod, LevelState, PackId, Receipt } from '@/types';
import { LEVEL_INFO, levelAt, levelRank } from '@/lib/levels';
import { date } from '@/lib/format';

/* ── The evidence claim, per level ───────────────────────── */

// L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
export const CLAIM_L1 = 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped.';

const CLAIMS: Record<LevelId, string> = {
  l1: CLAIM_L1,
  l2: 'Sealed, signed with a key in AWS KMS and timestamped by two authorities.',
  l3: 'Sealed, signed with a key you hold in your HSM and timestamped by two authorities.',
  sovereign: 'Sealed, signed in your own HSM and timestamped by your own two authorities.',
};

const CLAIMS_UNANCHORED: Record<Exclude<LevelId, 'l1'>, string> = {
  l2: 'Sealed and signed with a key in AWS KMS. Its batch is not yet timestamped; both authorities stamp it within 15 minutes of the batch closing.',
  l3: 'Sealed and signed with a key you hold in your HSM. Its batch is not yet timestamped; both authorities stamp it within 15 minutes of the batch closing.',
  sovereign: 'Sealed and signed in your own HSM. Its batch is not yet timestamped by your two authorities.',
};

/**
 * The claim for one receipt: what the evidence shows, given the level in force when it was written.
 * `anchored === false` means the receipt is sealed but its batch has not been timestamped yet.
 */
export function claimFor(level: LevelId, opts: { anchored?: boolean } = {}): string {
  if (level === 'l1') return CLAIM_L1;
  if (opts.anchored === false) return CLAIMS_UNANCHORED[level];
  return CLAIMS[level];
}

/** The claim for a whole chain, split at the boundaries when the organisation changed level. */
export function claimForChain(state: Pick<LevelState, 'level' | 'boundaries'>): string {
  const b = state.boundaries.filter((x) => !x.beforeWindow && x.recordsBefore > 0);
  if (!b.length) return claimFor(state.level);
  const first = b[0];
  const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  return `Records before ${date(first.at)} (${LEVEL_INFO[first.from].short}): ${lc(claimFor(first.from)).replace(/\.$/, '')}. Records after (${LEVEL_INFO[state.level].short}): ${lc(claimFor(state.level))}`;
}

/* ── Levels over time ─────────────────────────────────────── */

/** The level in force when a receipt was written. */
export function levelOfReceipt(r: Pick<Receipt, 'ts'>, history: LevelPeriod[] | undefined, current: LevelId): LevelId {
  if (!history?.length) return current;
  return levelAt(history, new Date(r.ts).getTime(), current);
}

/** When the organisation reached `level` (or above), from its history; undefined if it has not. */
export function levelSince(history: LevelPeriod[] | undefined, level: LevelId): string | undefined {
  return history?.find((h) => levelRank(h.level) >= levelRank(level))?.from;
}

export interface LevelSegment { level: LevelId; count: number; firstSeq: number; lastSeq: number }

/** Contiguous runs of receipts by the level in force when they were written (the boundary split). */
export function segmentsByLevel(receipts: Pick<Receipt, 'seq' | 'ts'>[], history: LevelPeriod[] | undefined, current: LevelId): LevelSegment[] {
  const out: LevelSegment[] = [];
  for (const r of receipts) {
    const lv = levelOfReceipt(r, history, current);
    const last = out[out.length - 1];
    if (last && last.level === lv) { last.count++; last.lastSeq = r.seq; } else out.push({ level: lv, count: 1, firstSeq: r.seq, lastSeq: r.seq });
  }
  return out;
}

/** "N receipts before the boundary (L1 rules), M after (L2 sealed and timestamped)". */
export function segmentPhrase(s: LevelSegment): string {
  switch (s.level) {
    case 'l1': return 'L1 — sealed in a hash chain, no Seal v6 record';
    case 'l2': return 'L2 — sealed and timestamped by two authorities';
    case 'l3': return 'L3 — sealed, customer-held key, timestamped by two authorities';
    default: return 'Sovereign — sealed in your HSM, timestamped by your own authorities';
  }
}

/* ── Custody ──────────────────────────────────────────────── */

/** Where the signing key lived at a given level (for keys that are no longer the active key). */
export function custodyAtLevel(level: LevelId): { holder: string; where: string } {
  switch (level) {
    case 'l1': return { holder: 'Elan1 Govern', where: 'Elan1 Govern process key, sealed by the environment master key (ap-south-1)' };
    case 'l2': return { holder: 'Elan1 Govern (in AWS KMS)', where: 'AWS KMS, ap-south-1 Mumbai — key material never leaves KMS' };
    case 'l3': return { holder: 'The organisation', where: 'The organisation’s HSM (CloudHSM, Thales Luna or Entrust nShield)' };
    default: return { holder: 'The organisation', where: 'The organisation’s HSM on its own premises' };
  }
}

export const CUSTODY_MODE_LABEL: Record<KeyCustody['mode'], string> = {
  env_master: 'Held by Elan1 Govern',
  aws_kms: 'AWS KMS (managed custody)',
  customer_hsm_cloud: 'Customer HSM in the cloud',
  customer_hsm_onprem: 'Customer HSM on premises',
};

/* ── Receipt schema ───────────────────────────────────────── */

/** The 22 fields of the receipt format (schema v1). The count on screens is derived from this list. */
export const RECEIPT_FIELDS = ['seq', 'ts', 'org', 'kind', 'agent', 'tool', 'args_summary', 'args_hash', 'rulebook', 'rule_id', 'decision', 'reason', 'approval', 'outcome', 'ref_seq', 'actor', 'action', 'details', 'prev_hash', 'kid', 'hash', 'sig'] as const;

export function receiptFieldsPresent(r: Receipt): number {
  return RECEIPT_FIELDS.filter((k) => r[k] !== undefined && r[k] !== null).length;
}

/* ── Regulatory packs a receipt falls under ───────────────── */

/** Same predicates the pack coverage and regime exports use (mock/platform PACK_MATCH). */
export const PACK_MATCH: Record<PackId, (r: Receipt) => boolean> = {
  ledger1: (r) => r.kind === 'decision' && !!r.tool?.startsWith('zoho_books.'),
  invoice1: (r) => r.kind === 'decision' && (r.tool === 'zoho_books.create_bill' || r.tool === 'zoho_books.record_payment' || r.tool === 'zoho_books.delete_bill'),
  collect1: (r) => r.kind === 'decision' && r.tool === 'gmail.send_email' && r.args_summary?.template !== undefined,
};

export function istHour(ts: string): number {
  return new Date(new Date(ts).getTime() + 5.5 * 3_600_000).getUTCHours();
}

/* Controls a receipt counts towards: features/compliance/evidence.ts controlIdsForReceipt, the same predicates and
   framework mapping Coverage uses (mock/controlMap.ts). */

/* ── Small download helper for the nine-section report ────── */

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
