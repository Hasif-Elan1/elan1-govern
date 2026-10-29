import "server-only";
import type { Domain } from "./console-domain";

/*
 * Console operations the real backend serves itself. The console's domain still runs every other operation on the
 * server (console-domain.ts); an operation named here runs this function instead, inside the same per-org lock and
 * transaction, with the actor the server filled in. It may call the gate (apps/web/src/server/gate.ts) and then bring
 * the org's document in line through the domain (`domain.db.getDB(orgId)`), so the screens read the result as before.
 * `original` runs the console's own implementation with the same arguments, for overrides that only add to it.
 *
 * Each feature registers its overrides from its own module (console-overrides/<feature>.ts), imported below.
 */

export interface OverrideCtx {
  domain: Domain;
  orgId: string;
  actorUserId: string;
  /** The operation's arguments, actor positions already set to the session user. */
  args: unknown[];
  original: (...args: unknown[]) => unknown;
}
export type Override = (ctx: OverrideCtx) => Promise<unknown> | unknown;

const registry = new Map<string, Override>();

/** Register `fn` as the real implementation of console operation `op` (its manifest name, e.g. "api.billing"). */
export function overrideOp(op: string, fn: Override) {
  if (registry.has(op)) throw new Error(`console operation ${op} is overridden twice`);
  registry.set(op, fn);
}

export function consoleOverride(op: string): Override | undefined {
  return registry.get(op);
}

// ── wiring ── the console screens on the real backends (console-overrides/wiring.ts)
import "./console-overrides/wiring";
