/**
 * What the live engine (engine.ts) and the document sync (sync.ts) share: how deep inside an operation the
 * console is, whether the change being made is the sync's own (an import from the server), and which
 * organisations the domain reported as changed.
 */
export const live = {
  /** Operations running now: only the outermost one is sent to the server. */
  depth: 0,
  /** Above 0 while the sync itself changes documents (importing the server's copy, telling the screens). */
  quiet: 0,
  /** Every change the domain reported (mock/db.ts emit → the persistence hook), counted. */
  changes: 0,
  /** Organisations changed during the current outermost operation. */
  changed: new Set<string>(),
  /** Operations sent to the server and not answered yet, per organisation. */
  inflight: new Map<string, number>(),
};

/** Run `fn` as the sync's own change: no operation inside it is sent to the server, and no change counts. */
export function quietly<T>(fn: () => T): T {
  live.quiet++;
  try { return fn(); } finally { live.quiet--; }
}

/** Is a development build? (warnings about local writes the server never sees) */
export const DEV = (() => {
  try { return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true; } catch { return false; }
})();
