import { randomBytes } from "node:crypto";
import { allOrgIds, forOrg, type AnchorBatch } from "@gate/db";
import { SYSTEM_ACTOR } from "./behaviour";
import { chain } from "./chain";
import { raiseAlert, type Deps } from "./deps";
import { configuredAuthorities } from "./tsa/config";
import { inclusionPath, leafHash, merkleRoot, verifyInclusion, type PathStep } from "./tsa/merkle";
import { TsaError, type TimestampAuthority, type TimestampToken } from "./tsa/token";

/**
 * Merkle batches (L2 Attested and above). Every 15 minutes the receipts written since an org's
 * last batch are put under one RFC 6962 root, the root is stamped by every configured timestamp
 * authority, and the batch is stored with an `anchor.batched` receipt naming the range, root and
 * each token. Two timestamps make a batch "ok"; one is "degraded" (still a valid timestamp, and a
 * health alert); none is "failed", and those records go into the next batch.
 *
 * Stamping happens outside the chain lock (an authority may take up to 10 s); the batch row and
 * its receipt are then written in one chain transaction, which first re-checks that no other run
 * covered the same records.
 */

export const ANCHOR_QUEUE = "anchor-batches";
export const ANCHOR_ACTION = "anchor.batched";
/** Levels whose receipts are timestamped. */
export const ANCHORED_LEVELS = ["l2", "l3", "sovereign"];
/** Most receipts in one batch; a backlog is drained in several batches in one run. */
export const MAX_LEAVES = 10_000;
const MAX_BATCHES_PER_RUN = 20;

export type BatchStatus = "ok" | "degraded" | "failed";

export interface InclusionProof {
  seq: number;
  receiptHash: string;
  leafHash: string;
  leafIndex: number;
  treeSize: number;
  batchId: string;
  root: string;
  path: PathStep[];
  tokens: TimestampToken[];
  status: BatchStatus;
  /** The root recomputed from the chain's receipts and from this path both equal the batch root. */
  verified: boolean;
}

export class AnchorError extends Error {}

const statusFor = (tokens: number): BatchStatus => (tokens >= 2 ? "ok" : tokens === 1 ? "degraded" : "failed");

/** A receipt hash ("sha256:<hex>") as a Merkle leaf: its 32 bytes, in hex, as the console's receipts carry them. */
export function leafOf(receiptHash: string): string {
  const hex = receiptHash.startsWith("sha256:") ? receiptHash.slice(7) : receiptHash;
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new AnchorError("a receipt hash is not a SHA-256 digest");
  return hex;
}

type ScopedDb = Pick<ReturnType<typeof forOrg>, "anchorBatch">;

/** The last seq in a batch that holds at least one timestamp (0 when none). */
async function coveredTo(db: ScopedDb): Promise<number> {
  const last = await db.anchorBatch.findFirst({ where: { status: { not: "failed" } }, orderBy: { toSeq: "desc" }, select: { toSeq: true } });
  return last?.toSeq ?? 0;
}

/** Stamp a root with every authority, in parallel. Failures are kept as short fixed phrases. */
export async function stampAll(authorities: TimestampAuthority[], root: string) {
  const results = await Promise.allSettled(authorities.map((a) => a.stamp(root)));
  const tokens: TimestampToken[] = [];
  const failures: { tsaId: string; error: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") tokens.push(r.value);
    else failures.push({ tsaId: authorities[i]!.id, error: r.reason instanceof TsaError ? r.reason.message : "the authority could not be used" });
  });
  return { tokens, failures, status: statusFor(tokens.length) };
}

/** Batch and timestamp the next run of unbatched receipts. Null when there is nothing new (only earlier anchor receipts). */
export async function anchorNext(deps: Deps, orgId: string, authorities: TimestampAuthority[]): Promise<AnchorBatch | null> {
  const db = forOrg(orgId, deps.db);
  const fromSeq = (await coveredTo(db)) + 1;
  const rows = await db.receipt.findMany({ where: { seq: { gte: fromSeq } }, orderBy: { seq: "asc" }, take: MAX_LEAVES, select: { seq: true, hash: true, action: true } });
  if (!rows.some((r) => r.action !== ANCHOR_ACTION)) return null;
  rows.forEach((r, i) => {
    if (r.seq !== fromSeq + i) throw new AnchorError(`the receipt chain has a gap at #${fromSeq + i}`);
  });
  const toSeq = fromSeq + rows.length - 1;
  const root = merkleRoot(rows.map((r) => leafOf(r.hash)));
  const { tokens, failures, status } = await stampAll(authorities, root);

  const batch = await chain(deps, orgId, async (append, tx) => {
    if ((await coveredTo(tx)) >= fromSeq) return null; // another run batched these first
    const id = `mb_${randomBytes(10).toString("hex")}`;
    const details: Record<string, string | number> = { batch_id: id, from_seq: fromSeq, to_seq: toSeq, count: rows.length, root, status };
    tokens.forEach((t, i) => Object.assign(details, { [`tsa_${i + 1}_id`]: t.tsaId, [`tsa_${i + 1}_gen`]: t.genTime, [`tsa_${i + 1}_serial`]: t.serial }));
    failures.forEach((f, i) => Object.assign(details, { [`failed_${i + 1}_id`]: f.tsaId }));
    const receipt = await append({ kind: "admin", actor: SYSTEM_ACTOR, action: ANCHOR_ACTION, details });
    return tx.anchorBatch.create({ data: { id, orgId, fromSeq, toSeq, root, tokens: tokens as object[], failures, status, receiptSeq: receipt.seq } });
  });
  if (batch && status !== "ok") {
    const which = failures.map((f) => `${f.tsaId}: ${f.error}`).join("; ");
    await raiseAlert(deps, `anchor-${status}`, status === "degraded" ? `Receipts #${fromSeq}–#${toSeq} have one timestamp instead of two (${which}).` : `Receipts #${fromSeq}–#${toSeq} could not be timestamped (${which}); they go into the next batch.`, orgId);
  }
  return batch;
}

/** Batch an org's new receipts if it is at L2 or above. Drains a backlog; stops at a failed batch. */
export async function anchorOrg(deps: Deps, orgId: string, authorities: TimestampAuthority[] = configuredAuthorities(deps)): Promise<AnchorBatch[]> {
  const org = await forOrg(orgId, deps.db).org.findFirstOrThrow({ select: { level: true } });
  if (!ANCHORED_LEVELS.includes(org.level)) return [];
  const out: AnchorBatch[] = [];
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const b = await anchorNext(deps, orgId, authorities);
    if (!b) break;
    out.push(b);
    if (b.status === "failed" || b.toSeq - b.fromSeq + 1 < MAX_LEAVES) break;
  }
  return out;
}

/** The cron job: every org, each in its own try/catch so one failure does not stop the rest. Logs counts only. */
export async function anchorAll(deps: Deps, authorities: TimestampAuthority[] = configuredAuthorities(deps)) {
  const counts = { batches: 0, degraded: 0, failed: 0 };
  for (const orgId of await allOrgIds(deps.db)) {
    try {
      for (const b of await anchorOrg(deps, orgId, authorities)) {
        counts.batches++;
        if (b.status === "degraded") counts.degraded++;
        if (b.status === "failed") counts.failed++;
      }
    } catch (e) {
      await raiseAlert(deps, "anchor-batch-error", `Merkle batching failed: ${(e as Error).message}`, orgId);
    }
  }
  return counts;
}

/** Where a receipt sits in its timestamped batch: the RFC 6962 audit path to the root, and the root's tokens. */
export async function inclusionProof(deps: Deps, orgId: string, seq: number): Promise<InclusionProof> {
  const db = forOrg(orgId, deps.db);
  const receipt = await db.receipt.findFirst({ where: { seq }, select: { hash: true } });
  if (!receipt) throw new AnchorError(`No receipt #${seq} in this organisation.`);
  const b = await db.anchorBatch.findFirst({ where: { fromSeq: { lte: seq }, toSeq: { gte: seq }, status: { not: "failed" } }, orderBy: { createdAt: "desc" } });
  if (!b) throw new AnchorError("This receipt is not in a timestamped batch yet.");
  const rows = await db.receipt.findMany({ where: { seq: { gte: b.fromSeq, lte: b.toSeq } }, orderBy: { seq: "asc" }, select: { hash: true } });
  const hashes = rows.map((r) => leafOf(r.hash));
  const index = seq - b.fromSeq;
  const path = index < hashes.length ? inclusionPath(hashes, index) : [];
  const complete = hashes.length === b.toSeq - b.fromSeq + 1 && merkleRoot(hashes) === b.root;
  return {
    seq,
    receiptHash: leafOf(receipt.hash),
    leafHash: leafHash(leafOf(receipt.hash)),
    leafIndex: index,
    treeSize: hashes.length,
    batchId: b.id,
    root: b.root,
    path,
    tokens: b.tokens as unknown as TimestampToken[],
    status: b.status as BatchStatus,
    verified: complete && verifyInclusion(leafOf(receipt.hash), path, b.root),
  };
}
