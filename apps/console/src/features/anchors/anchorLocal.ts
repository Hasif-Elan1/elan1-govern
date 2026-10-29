/**
 * Local helpers for the Timestamps screens: recompute Merkle roots from the chain, check timestamp-token
 * signatures against the authority's registered key, and anchor the open batch on demand.
 *
 * "Anchor now" closes the open 15-minute window early (api.anchorNow, owners and admins): it builds the RFC 6962
 * root over every sealed record not yet in a timestamped batch, asks both authorities for a token over that root
 * and records the result on the chain as an `anchor.on_demand` receipt (root, range and both tokens). The page and
 * every export read on-demand batches back from those receipts, so they survive a reload and travel in a bundle's
 * anchors.json. The next regular batch covers the same records again; the on-demand batch is then marked as covered.
 */
import { api, db } from '@/api';
import { verifySig } from '@/lib/crypto';
import { inclusionPath, leafHash, merkleRoot, nodeHash } from '@/lib/merkle';
import { tokenMessage } from '@/lib/verify6';
import { ON_DEMAND_ANCHOR, onDemandAnchorBatches } from '@/mock/platform';
import type { AnchorBatch, Receipt, TimestampToken, TsaAuthority } from '@/types';

export const ON_DEMAND_ACTION = ON_DEMAND_ANCHOR;
export const WINDOW_MS = 15 * 60_000;
export const TARGET_SECONDS = 15 * 60;

export type ViewBatch = AnchorBatch & { onDemand?: boolean; recordedSeq?: number; covered?: boolean };

/** The authority's short name, e.g. "eMudhra TSA". */
export const tsaShort = (name: string) => name.split(' (')[0];

/** Does the token's Ed25519 signature verify with the authority's registered key? */
export function tokenVerifies(t: TimestampToken, authorities: TsaAuthority[]): boolean {
  const a = authorities.find((x) => x.id === t.tsaId);
  if (!a) return false;
  return verifySig(tokenMessage(t), t.sig, a.publicKey);
}

/** Receipts of a seq range, in order. */
export function receiptsIn(orgId: string, firstSeq: number, lastSeq: number): Receipt[] {
  return db.getDB(orgId).receipts.filter((r) => r.seq >= firstSeq && r.seq <= lastSeq);
}

/** Recompute a batch's Merkle root from the receipts on the chain. */
export function recomputeRoot(orgId: string, firstSeq: number, lastSeq: number) {
  const hashes = receiptsIn(orgId, firstSeq, lastSeq).map((r) => r.hash);
  return { root: merkleRoot(hashes), count: hashes.length, hashes };
}

/** Recompute a root from a receipt hash and its audit path, step by step (RFC 6962 §2.1.1). */
export function walkPath(receiptHash: string, path: { hash: string; side: 'left' | 'right' }[]) {
  const leaf = leafHash(receiptHash);
  let h = leaf;
  const steps = path.map((s, i) => {
    const out = s.side === 'right' ? nodeHash(h, s.hash) : nodeHash(s.hash, h);
    const step = { index: i + 1, side: s.side, sibling: s.hash, input: h, output: out };
    h = out;
    return step;
  });
  return { leaf, steps, root: h };
}

/**
 * On-demand batches recorded on the chain, newest first: read by the mock (mock/platform.ts onDemandAnchorBatches),
 * the same batches an export carries in anchors.json.
 */
export function onDemandBatches(orgId: string, lastRegularSeq?: number): ViewBatch[] {
  return onDemandAnchorBatches(db.getDB(orgId)).map(({ leaves: _l, ...b }) => ({ ...b, covered: lastRegularSeq !== undefined && b.lastSeq <= lastRegularSeq })).reverse();
}

/** An inclusion proof for a receipt inside an on-demand batch, computed here. */
export function onDemandProof(orgId: string, b: ViewBatch, seq: number) {
  const { hashes } = recomputeRoot(orgId, b.firstSeq, b.lastSeq);
  const r = db.getDB(orgId).receipts.find((x) => x.seq === seq);
  if (!r) throw new Error(`No receipt ${seq} in this organisation.`);
  const index = hashes.indexOf(r.hash);
  if (index < 0) throw new Error('That receipt is not in this batch.');
  return { seq, receiptHash: r.hash, leafHash: leafHash(r.hash), leafIndex: index, treeSize: hashes.length, batchId: b.id, root: b.root, path: inclusionPath(hashes, index), tokens: b.tokens };
}

/**
 * Anchor every sealed record that is not yet in a timestamped batch, through the API (owners and admins, checked
 * there). Both authorities must answer with their registered key, or nothing is recorded. Returns the new batch.
 */
export async function anchorNow(orgId: string, userId: string): Promise<ViewBatch> {
  const b = await api.anchorNow(orgId, userId);
  return { ...b, covered: false };
}

/** Sealed records not yet in any timestamped batch, ignoring "Anchor now" receipts themselves (nothing to anchor for those alone). */
export function pendingToAnchor(orgId: string, lastRegularSeq: number, sealedFromMs: number): number {
  const d = db.getDB(orgId);
  const covered = Math.max(lastRegularSeq, ...onDemandBatches(orgId).map((b) => b.lastSeq));
  return d.receipts.filter((r) => r.seq > covered && new Date(r.ts).getTime() >= sealedFromMs && r.action !== ON_DEMAND_ACTION).length;
}

/** The end of the open 15-minute window (when the next regular batch is timestamped). */
export function nextWindowEnd(now = Date.now()) {
  return Math.ceil(now / WINDOW_MS) * WINDOW_MS + 60_000;
}
