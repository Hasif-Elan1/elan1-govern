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

/**
 * The registered overrides. A hoisted function rather than a module constant: the feature modules imported below
 * call overrideOp while this module is still being evaluated (they import it back), before a constant would exist.
 */
function registry(): Map<string, Override> {
  const self = registry as { map?: Map<string, Override> };
  return (self.map ??= new Map());
}

/** Register `fn` as the real implementation of console operation `op` (its manifest name, e.g. "api.billing"). */
export function overrideOp(op: string, fn: Override) {
  if (registry().has(op)) throw new Error(`console operation ${op} is overridden twice`);
  registry().set(op, fn);
}

export function consoleOverride(op: string): Override | undefined {
  return registry().get(op);
}

// each feature's overrides (imported for their registrations)
import "./console-overrides/signing";
// ── wiring ── the console screens on the real backends (console-overrides/wiring.ts)
import "./console-overrides/wiring";
