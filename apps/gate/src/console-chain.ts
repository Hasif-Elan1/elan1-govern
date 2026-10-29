import { GENESIS_HASH, KEY_ROTATED_ACTION, ReceiptSchema, type Checkpoint, type Receipt, type ReceiptInput } from "@gate/core";
import { forOrg, toCheckpoint, withChain, type ChainTx } from "@gate/db";
import { z } from "zod";
import { chain, checkpoint } from "./chain";
import type { Deps } from "./deps";
import { signer } from "./keys";

/*
 * The approved console's receipts (plans/console-app.md E5: receipts are always written by the real chain). The
 * console's domain runs in the web app; an operation that records something hands its receipts here in one call,
 * after the head its document holds, and gets back the signed receipts. Two rules keep the console's document and
 * the chain one and the same:
 *  - a write names the head it continues (`base`); if anything else wrote to the chain since (the guard, an approval,
 *    a job), it is refused whole (ChainMoved) and the console runs the operation again on the new head;
 *  - the console never writes what only the gate may: a key rotation, a re-wrap, an organisation's creation, or the
 *    history-import marker.
 * A seeded demo organisation's generated history is written once, through importConsoleHistory, keeping each
 * receipt's own time.
 */

export interface ChainHead {
  seq: number;
  hash: string;
}

/** The marker receipt written after an imported history. */
export const HISTORY_IMPORTED = "console.history_imported";

/** Actions only the gate writes: a console receipt naming one would claim what the gate never did. */
export const GATE_ONLY_ACTIONS: ReadonlySet<string> = new Set([KEY_ROTATED_ACTION, "key.rewrapped", "org.created", HISTORY_IMPORTED]);

/** One receipt as the console sends it: core's format, without what the chain fills in. */
export const ConsoleReceiptInput = ReceiptSchema.omit({ seq: true, ts: true, org: true, prev_hash: true, kid: true, hash: true, sig: true }).strict();
/** One imported history receipt: the same, with its own time. */
export const ConsoleHistoryInput = ConsoleReceiptInput.extend({ ts: z.string() }).strict();
export const ChainHeadInput = z.object({ seq: z.number().int().min(0), hash: z.string().min(1).max(100) }).strict();

/** The chain moved past the head the console's document holds. */
export class ChainMoved extends Error {
  constructor(readonly head: ChainHead) {
    super(`The chain moved on to #${head.seq} while this change was being made.`);
    this.name = "ChainMoved";
  }
}

/** A console write the gate refuses (a gate-only action, an import that is not allowed). */
export class ConsoleChainRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleChainRefused";
  }
}

async function headOf(tx: ChainTx): Promise<ChainHead> {
  const last = await tx.receipt.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
  return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
}

function refuseGateOnly(receipts: readonly ReceiptInput[]) {
  const bad = receipts.find((r) => r.action !== undefined && GATE_ONLY_ACTIONS.has(r.action));
  if (bad) throw new ConsoleChainRefused(`Only Elan1 Govern writes ${bad.action} receipts.`);
}

async function latestCheckpoint(deps: Deps, orgId: string): Promise<Checkpoint | null> {
  const row = await forOrg(orgId, deps.db).checkpoint.findFirst({ orderBy: { seq: "desc" } });
  return row ? toCheckpoint(row) : null;
}

/**
 * Appends the console's receipts, in order, after `base`, under the chain lock and signed with the org's active
 * key (webhooks and the unusual-behaviour check run for them as for any receipt). With `checkpoint`, also signs the
 * new head (or returns the last checkpoint when nothing moved since).
 */
export async function writeConsoleReceipts(deps: Deps, orgId: string, input: { base: ChainHead; receipts: ReceiptInput[]; checkpoint?: boolean }) {
  refuseGateOnly(input.receipts);
  const receipts = await chain(deps, orgId, async (append, tx) => {
    const head = await headOf(tx);
    if (head.seq !== input.base.seq || head.hash !== input.base.hash) throw new ChainMoved(head);
    const out: Receipt[] = [];
    for (const r of input.receipts) out.push(await append(r));
    return out;
  });
  const cp = input.checkpoint ? ((await checkpoint(deps, orgId)) ?? (await latestCheckpoint(deps, orgId))) : null;
  return { receipts, ...(cp ? { checkpoint: cp } : {}) };
}

/**
 * Writes a seeded console organisation's generated history into its chain once, keeping each receipt's own time,
 * then a `console.history_imported` receipt saying what was imported, and a checkpoint. Allowed only while the
 * chain holds nothing but the organisation's own setup receipts (admin receipts, no earlier import), right after
 * `base`; the times must be in order and none later than now. Webhooks are not sent for history.
 */
export async function importConsoleHistory(deps: Deps, orgId: string, input: { base: ChainHead; receipts: (ReceiptInput & { ts: string })[] }) {
  refuseGateOnly(input.receipts);
  const now = Date.now();
  let last = -Infinity;
  for (const r of input.receipts) {
    const t = Date.parse(r.ts);
    if (!(t <= now) || new Date(t).toISOString() !== r.ts) throw new ConsoleChainRefused(`An imported receipt's time (${r.ts.slice(0, 40)}) must be an ISO time no later than now.`);
    if (t < last) throw new ConsoleChainRefused("Imported receipts must be in time order.");
    last = t;
  }
  const out = await withChain(
    orgId,
    signer(deps, orgId),
    async (append, tx) => {
      const head = await headOf(tx);
      if (head.seq !== input.base.seq || head.hash !== input.base.hash) throw new ChainMoved(head);
      if (await tx.receipt.findFirst({ where: { OR: [{ kind: { not: "admin" } }, { action: HISTORY_IMPORTED }] }, select: { seq: true } })) {
        throw new ConsoleChainRefused("This organisation's chain already holds activity, so history can no longer be imported into it.");
      }
      const receipts: Receipt[] = [];
      for (const { ts, ...r } of input.receipts) receipts.push(await append(r, { at: ts }));
      const first = receipts[0];
      const end = receipts[receipts.length - 1];
      const marker = await append({
        kind: "admin",
        actor: "system",
        action: HISTORY_IMPORTED,
        details: { receipts: receipts.length, from_seq: first?.seq ?? 0, to_seq: end?.seq ?? 0, first_ts: first?.ts ?? "", last_ts: end?.ts ?? "", source: "console demo history" },
      });
      return { receipts, marker };
    },
    deps.db,
  );
  return { ...out, checkpoint: await checkpoint(deps, orgId) };
}
