/**
 * Which `evidence.exported` receipt records each export. An export records its receipt's seq on itself when it is
 * written (mock/evidence.ts, `seq` on the export in the organisation's record); older and seeded exports are
 * matched to the receipt written by the same person closest in time, and the match is kept in memory only (it is
 * worked out again from the chain after a reload). An export whose range ends before the chain window this
 * console holds has no receipt here, and says so.
 */
import { db } from '@/api';

export interface ExportRow { id: string; ts: string; by: string; firstSeq: number; lastSeq: number; receipts: number; checkpoints: number; sizeKb: number; format?: string; profileId?: string }

/** Matches worked out from the chain, per organisation (a cache: never saved). */
const matched = new Map<string, Record<string, number>>();

/** The evidence.exported receipt a person wrote at or after `sinceIso` (newest match). */
export function findExportReceipt(orgId: string, userId: string, sinceIso: string): number | undefined {
  const rs = db.getDB(orgId).receipts;
  const since = new Date(sinceIso).getTime() - 2000;
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if (new Date(r.ts).getTime() < since) break;
    if (r.action === 'evidence.exported' && r.actor === userId) return r.seq;
  }
  return undefined;
}

export type ExportSeq = { seq: number } | { beforeWindow: true } | { missing: true };

export function exportReceiptSeq(orgId: string, row: ExportRow): ExportSeq {
  const d = db.getDB(orgId);
  const own = d.exports.find((e) => e.id === row.id)?.seq;
  const remembered = own ?? matched.get(orgId)?.[row.id];
  if (remembered !== undefined && d.receipts.some((r) => r.seq === remembered && r.action === 'evidence.exported')) return { seq: remembered };
  const t = new Date(row.ts).getTime();
  const first = d.receipts[0];
  if (first && t < new Date(first.ts).getTime() - 60_000) return { beforeWindow: true };
  let best: number | undefined;
  let bestDiff = 15 * 60_000;
  for (const r of d.receipts) {
    if (r.action !== 'evidence.exported' || r.actor !== row.by) continue;
    const diff = Math.abs(new Date(r.ts).getTime() - t);
    if (diff < bestDiff) { bestDiff = diff; best = r.seq; }
  }
  if (best !== undefined) { matched.set(orgId, { ...matched.get(orgId), [row.id]: best }); return { seq: best }; }
  // a range that ends before the first receipt held here was exported from records outside this window
  if (first && row.lastSeq < first.seq) return { beforeWindow: true };
  return { missing: true };
}
