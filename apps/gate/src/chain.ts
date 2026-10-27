import type { Receipt, ReceiptInput } from "@gate/core";
import { createCheckpoint, withChain, type Append, type ChainKey, type ChainTx, type KeySource } from "@gate/db";
import { inlineBehaviourCheck } from "./behaviour";
import { raiseAlert, type Deps } from "./deps";
import { signer } from "./keys";
import { enqueueReceiptEvents } from "./webhooks";

/**
 * Every receipt the gate writes goes through here: one transaction under the org's chain lock,
 * signed with the org's active key. After the transaction commits, the new receipts are handed to
 * webhooks in the background, so the caller (often the guard) never waits for them.
 */
export async function chain<T>(deps: Deps, orgId: string, fn: (append: Append, tx: ChainTx, key: ChainKey) => Promise<T>, key: KeySource = signer(deps, orgId)): Promise<T> {
  const written: Receipt[] = [];
  const result = await withChain(
    orgId,
    key,
    (append, tx, k) =>
      fn(
        async (input) => {
          const r = await append(input);
          written.push(r);
          return r;
        },
        tx,
        k,
      ),
    deps.db,
  );
  if (written.length) background(deps, enqueueReceiptEvents(deps, orgId, written));
  // Unusual-behaviour checks on new decisions: after commit, in the background. They can never
  // slow or fail the call; a failure becomes a health alert (alerting fails open, decisions do not).
  const decisions = written.filter((r) => r.kind === "decision");
  if (decisions.length) {
    const check = (async () => (deps.behaviourInline ?? inlineBehaviourCheck)(deps, orgId, decisions))();
    background(deps, check.catch((e: Error) => raiseAlert(deps, "behaviour-check-failed", `Unusual-behaviour check failed: ${e.message}`, orgId)));
  }
  return result;
}

export function record(deps: Deps, orgId: string, input: ReceiptInput): Promise<Receipt> {
  return chain(deps, orgId, (append) => append(input));
}

export function checkpoint(deps: Deps, orgId: string) {
  return createCheckpoint(orgId, signer(deps, orgId), deps.db);
}

/** Runs work after the response without losing errors; tests and shutdown can await `deps.background`. */
export function background(deps: Deps, p: Promise<unknown>) {
  const tracked = p.catch((e: Error) => deps.log.warn({ err: e.message }, "background task failed"));
  deps.background.add(tracked);
  void tracked.finally(() => deps.background.delete(tracked));
}
