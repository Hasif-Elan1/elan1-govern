/**
 * The one entry point of every console operation in a live build. scripts/live-transform.mjs rewrites each
 * operation the server's RPC door runs (the operation manifest, built from src/server/entry.ts) so that it reads
 *
 *   export function decide(...__args) { return __live.call("work.decide", decide__impl, __args, this, 1, 0); }
 *
 * and wraps the methods of the operation objects (`api`, `orgApi` …) the same way at the end of their module.
 *
 * This module imports nothing, so it is ready before any operation module runs, whatever the import cycles. Until
 * the live engine is installed (src/api/live/boot.ts) every call runs its own body, as the mock does.
 */

/** What the wrapper knows about its operation (from the manifest). */
export interface OpInfo {
  /** The dotted name the server knows it by: `api.setFramework`, `work.decide` … */
  name: string;
  /** It returns a promise: the server answers it (pure RPC). */
  async: boolean;
  /** Index of its organisation argument, or null when it takes none. */
  org: number | null;
}

export type Impl = (...args: unknown[]) => unknown;

export interface LiveEngine {
  call(op: OpInfo, impl: Impl, args: unknown[], self: unknown): unknown;
}

let engine: LiveEngine | undefined;
const infos = new Map<string, OpInfo>();

function info(name: string, async: number | boolean, org: number | null): OpInfo {
  let i = infos.get(name);
  if (!i) infos.set(name, (i = { name, async: !!async, org }));
  return i;
}

/** An object shared by a frozen module namespace (`ops: opsModule` in `api`) is copied before its methods are wrapped. */
const copied = new WeakSet<object>();

export const __live = {
  call(name: string, impl: Impl, args: unknown[], self: unknown, async: number | boolean, org: number | null): unknown {
    if (!engine) return impl.apply(self, args);
    return engine.call(info(name, async, org), impl, args, self);
  },

  /**
   * Wrap the operation methods of an object: each entry is [property path, operation name, async, organisation
   * index]. Nested objects on the path are copied first when they cannot be written (module namespaces).
   */
  wrap(root: Record<string, unknown>, entries: [string[], string, number, number | null][]): void {
    for (const [path, name, async, org] of entries) {
      let parent = root;
      for (const key of path.slice(0, -1)) {
        let child = parent[key] as Record<string, unknown>;
        if (!child || typeof child !== 'object') throw new Error(`${name}: ${key} is not an object to wrap.`);
        if (!copied.has(child) && (Object.isFrozen(child) || Object.getPrototypeOf(child) === null || !Object.isExtensible(child))) {
          child = { ...child };
          copied.add(child);
          parent[key] = child;
        }
        parent = child;
      }
      const last = path[path.length - 1];
      const impl = parent[last];
      if (typeof impl !== 'function') throw new Error(`${name} is not a function, so it cannot be wrapped.`);
      parent[last] = function (this: unknown, ...a: unknown[]) {
        return __live.call(name, impl as Impl, a, this, async, org);
      };
    }
  },

  /** Install (or remove, with undefined) the engine every call goes through from now on. */
  install(e: LiveEngine | undefined): void {
    engine = e;
  },

  /** Whether an engine is installed (diagnostics and tests). */
  installed(): boolean {
    return !!engine;
  },
};
