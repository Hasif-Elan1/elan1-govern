/**
 * The guards an L2+ export passes before it leaves, enforced where the export is made (api.exportPack), not only in
 * the dialog: every console path that exports — Assurance › Exports, Activity's range export, Settings › Data, the
 * final export when an organisation closes, a pack pilot's self-export — goes through the same checks.
 *  - size: a range over the limit for one bundle must be exported as parts, each verifiable on its own;
 *  - range: a break in the sequence or the hash link stops the export;
 *  - integrity: a completed integrity run (nightly, or run on demand) must cover the range;
 *  - residency, consent and declarations: the answers must be given, and are written into the signed manifest
 *    (export_checks) and the evidence.exported receipt.
 * The L1 auditor pack is free and passes none of these (it holds no seals, timestamps or declarations).
 */
import type { Receipt } from '@/types';
import { atLeast, levelOfOrg } from '@/lib/levels';
import { continuityReport, missingDeclarations, personalDataCount, type ExportOptions, type IntegrityRun } from './evidence';
import type { OrgDB } from './db';

/** One bundle is kept under this size so it travels as an attachment and opens in the web verifier. */
export const BUNDLE_LIMIT_KB = 1024;
/** Estimated size of one record in a bundle: sealed (receipt, Seal v6 record, batch leaf) and L1 (receipt only). */
const EST_KB = { sealed: 3.1, unsealed: 1.0 };

export interface Part { index: number; from: number; to: number; count: number; estKb: number }

/** Split a range into parts that each stay under the size limit. */
export function planParts(rs: Receipt[], isSealed: (r: Receipt) => boolean, limitKb = BUNDLE_LIMIT_KB): Part[] {
  const parts: Part[] = [];
  let cur: Part | undefined;
  for (const r of rs) {
    const kb = isSealed(r) ? EST_KB.sealed : EST_KB.unsealed;
    if (!cur || cur.estKb + kb > limitKb) {
      cur = { index: parts.length + 1, from: r.seq, to: r.seq, count: 0, estKb: 0 };
      parts.push(cur);
    }
    cur.to = r.seq;
    cur.count++;
    cur.estKb += kb;
  }
  return parts;
}

/** The first place in a range where the sequence or the hash link breaks. */
export function firstBreak(rs: Receipt[]): number | undefined {
  for (let i = 1; i < rs.length; i++) if (rs[i].seq !== rs[i - 1].seq + 1 || rs[i].prev_hash !== rs[i - 1].hash) return rs[i].seq;
  return undefined;
}

/** True for a record written at L2 or above (it carries a Seal v6 record and sits in a timestamped batch). */
export function sealedIn(db: OrgDB): (r: Receipt) => boolean {
  const order = ['l1', 'l2', 'l3', 'sovereign'];
  const p = (db.org.levelHistory ?? []).find((h) => order.indexOf(h.level) >= 1);
  const from = p ? new Date(p.from).getTime() : undefined;
  return (r) => from !== undefined && new Date(r.ts).getTime() >= from;
}

export interface IntegrityCoverage {
  covered: boolean;
  /** the last record a completed, passing integrity run has checked */
  checkedTo?: number;
  /** a run found the chain broken at this record, inside the range, and no later passing run cleared it */
  failedAt?: number;
  failReason?: string;
}

/**
 * Whether a completed integrity run covers every record in the range (spec 02 F8: an L2+ export needs one). Nightly
 * runs (02:00 IST) check each night's new records; a run on demand checks the whole window up to the head. The
 * runs are worked out from the chain (mock/evidence.ts), so this is what a run would have found.
 */
export function integrityCoverage(db: OrgDB, fromSeq?: number, toSeq?: number, now = Date.now()): IntegrityCoverage {
  const rs = db.receipts.filter((r) => (fromSeq === undefined || r.seq >= fromSeq) && (toSeq === undefined || r.seq <= toSeq));
  if (!rs.length) return { covered: true };
  const from = rs[0].seq;
  const to = rs[rs.length - 1].seq;
  const runs = continuityReport(db, now).runs;
  // a run's own receipt is written right after its head and counts as checked (as in the continuity report)
  const reach = (r: IntegrityRun) => (r.seq !== undefined ? Math.max(r.toSeq, r.seq) : r.toSeq);
  const failed = runs.find((r) => r.result === 'fail' && r.brokenAt !== undefined && r.brokenAt >= from && r.brokenAt <= to
    && !runs.some((p) => p.result === 'pass' && p.at > r.at && p.fromSeq <= r.brokenAt! && reach(p) >= r.brokenAt!));
  if (failed) return { covered: false, failedAt: failed.brokenAt, failReason: failed.reason };
  const passing = runs.filter((r) => r.result === 'pass');
  const checkedTo = passing.length ? Math.max(...passing.map(reach)) : undefined;
  return { covered: checkedTo !== undefined && to <= checkedTo, checkedTo };
}

/** The sentence an export shows when no completed integrity run covers its range. */
export function integrityProblem(c: IntegrityCoverage, from: number, to: number): string | undefined {
  if (c.covered) return undefined;
  if (c.failedAt !== undefined) return `The last integrity run over this range failed at #${c.failedAt}${c.failReason ? ` (${c.failReason})` : ''}. Run the integrity check again; the bundle can go once it passes.`;
  return `No completed integrity run covers #${Math.max(from, (c.checkedTo ?? from - 1) + 1)}–#${to} yet${c.checkedTo !== undefined ? ` (runs have checked up to #${c.checkedTo})` : ''}. Run the integrity check now; the bundle can go once it passes.`;
}

/** What still stops an export, in plain words; empty when it may go. L1 packs are never stopped here. */
export function exportProblems(db: OrgDB, fromSeq?: number, toSeq?: number, opts: ExportOptions = {}): string[] {
  if (!atLeast(levelOfOrg(db.org), 'l2')) return [];
  const rs = db.receipts.filter((r) => (fromSeq === undefined || r.seq >= fromSeq) && (toSeq === undefined || r.seq <= toSeq));
  if (!rs.length) return ['No receipts in that range.'];
  const out: string[] = [];
  const g = opts.gate;
  if (!g) {
    out.push('From L2 an export must pass the residency, consent and declarations checks first. Open the export dialog, answer them and generate it there.');
    return out;
  }
  const brk = firstBreak(rs);
  if (brk !== undefined) out.push(`The chain breaks at #${brk}, so this range would fail verification. Export the records before the break.`);
  // a completed integrity run must cover the range (spec 02 F8)
  const ip = integrityProblem(integrityCoverage(db, fromSeq, toSeq), rs[0].seq, rs[rs.length - 1].seq);
  if (ip) out.push(ip);
  if (g.residency === 'outside' && !g.transferBasis) out.push('Choose the basis for sending it outside the residency domain.');
  const personal = personalDataCount(rs);
  if (personal > 0 && !g.purpose) out.push(`Say why ${personal} record${personal === 1 ? '' : 's'} with personal data ${personal === 1 ? 'is' : 'are'} being disclosed.`);
  const missing = missingDeclarations(db, rs);
  if (missing.length && !g.acknowledged) out.push(`Acknowledge the ${missing.length} missing declaration${missing.length === 1 ? '' : 's'}, or add them first.`);
  const parts = planParts(rs, sealedIn(db));
  if (parts.length > 1) {
    out.push(opts.part
      ? `Part ${opts.part.index} is itself over the ${BUNDLE_LIMIT_KB} KB limit for one bundle. Split the range again.`
      : `The range is over the ${BUNDLE_LIMIT_KB} KB limit for one bundle: it goes out as ${parts.length} parts, each billed as a bundle. Generate it from the export dialog, which splits it.`);
  }
  return out;
}

/** Throw if an L2+ export would leave without passing its guards. */
export function assertExportAllowed(db: OrgDB, fromSeq?: number, toSeq?: number, opts?: ExportOptions) {
  const problems = exportProblems(db, fromSeq, toSeq, opts);
  if (problems.length) throw new Error(`Not exported. ${problems.join(' ')}`);
}
