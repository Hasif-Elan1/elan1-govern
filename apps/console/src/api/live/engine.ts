/**
 * How a console operation runs in a live build (plans/console-app.md, "1.3 refined after the write inventory"):
 *
 *  - an async operation is answered by the server: POST /api/console/rpc { op, args }. The server runs the same
 *    domain code as the signed-in person (whoever the arguments name) and checks the organisation is theirs;
 *  - a sync operation runs here, at once, so the screens that read its result synchronously keep working. When the
 *    outermost one changed a document, the same operation and arguments go to the server, in order. When the server
 *    answers, the tab takes the server's copy of the document; when it refuses, the local change is thrown away
 *    (the server's copy again) and the refusal is shown;
 *  - an operation called inside another runs locally as part of it; operations the sync itself runs (an import)
 *    are never sent.
 *
 * A few operations mean something else against the real backend (checking a password, signing in): those are
 * handled by overrides (boot.ts).
 */
import { toast } from '@/components/ui/overlay';
import { HttpError, NetworkError, post } from '@/api/http';
import type { Impl, LiveEngine, OpInfo } from './call';
import { DEV, live } from './state';
import { flushDeferred, noteServerVersion, resync } from './sync';

type Override = (args: unknown[]) => unknown;
const overrides = new Map<string, Override>();

/** Serve an operation differently in live builds (e.g. `work.reauth` checks the real password). */
export function override(name: string, fn: Override) {
  overrides.set(name, fn);
}

/** Results come back as JSON: the server writes Maps and Sets as { $map: [...] } and { $set: [...] }. */
export function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === '$map' && Array.isArray(o.$map)) return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [decode(k), decode(x)]));
  if (keys.length === 1 && keys[0] === '$set' && Array.isArray(o.$set)) return new Set((o.$set as unknown[]).map(decode));
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decode(o[k]);
  return out;
}

/** Arguments as JSON: trailing undefined ones are left off, so the server's defaults apply as they do here. */
export function encodeArgs(args: unknown[]): unknown[] {
  let n = args.length;
  while (n > 0 && args[n - 1] === undefined) n--;
  return JSON.parse(JSON.stringify(args.slice(0, n), (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v))) as unknown[];
}

const orgOf = (op: OpInfo, args: unknown[]) => (op.org === null ? undefined : typeof args[op.org] === 'string' ? (args[op.org] as string) : undefined);

interface RpcAnswer { result?: unknown; version?: number | null }

async function rpc(op: OpInfo, args: unknown[]): Promise<unknown> {
  const r = await post<RpcAnswer>('/api/console/rpc', { op: op.name, args: encodeArgs(args) });
  const orgId = orgOf(op, args);
  if (orgId) noteServerVersion(orgId, r.version);
  return decode(r.result);
}

/** The server has no such operation, or never runs it from the browser: a gap in the port, not the person's doing. */
const notServed = (e: unknown) => e instanceof HttpError && (e.status === 404 || (e.status === 403 && /not available here/i.test(e.message)));

let queue: Promise<void> = Promise.resolve();

/** Send an operation the tab already ran to the server, after every one sent before it. */
function forward(op: OpInfo, args: unknown[], orgId: string) {
  // the arguments as they are now: the screen may change its objects before the request goes
  const body = { op: op.name, args: encodeArgs(args) };
  live.inflight.set(orgId, (live.inflight.get(orgId) ?? 0) + 1);
  queue = queue.then(async () => {
    try {
      const r = await post<RpcAnswer>('/api/console/rpc', body);
      noteServerVersion(orgId, r.version, true);
    } catch (e) {
      void resync(orgId, { force: true, afterForward: true });
      if (notServed(e)) {
        if (DEV) console.warn('[live]', `${op.name} changed ${orgId} here, but the server does not run it from the browser (${(e as Error).message}). The change was undone.`);
      } else {
        toast.bad('That change was not saved', e instanceof NetworkError || e instanceof HttpError ? e.message : 'Something went wrong. Nothing was changed.');
      }
    } finally {
      const left = (live.inflight.get(orgId) ?? 1) - 1;
      if (left > 0) live.inflight.set(orgId, left);
      else {
        live.inflight.delete(orgId);
        flushDeferred(orgId);
      }
    }
  });
}

export const engine: LiveEngine = {
  call(op: OpInfo, impl: Impl, args: unknown[], self: unknown): unknown {
    if (live.quiet || live.depth) return impl.apply(self, args);
    const ov = overrides.get(op.name);
    if (ov) return ov(args);
    if (op.async) {
      // without an organisation the server runs nothing from the browser (verification, link pages): those stay here
      if (op.org === null) return impl.apply(self, args);
      return rpc(op, args);
    }
    const mark = live.changes;
    live.changed.clear();
    live.depth++;
    let out: unknown;
    try {
      out = impl.apply(self, args);
    } catch (e) {
      live.depth--;
      // a refusal halfway through: whatever it changed here is put back
      if (live.changes !== mark) for (const o of [...live.changed]) void resync(o, { force: true });
      throw e;
    }
    live.depth--;
    if (live.changes !== mark) {
      const orgId = orgOf(op, args);
      if (orgId) forward(op, args, orgId);
      else {
        if (DEV) console.warn('[live]', `${op.name} changed ${[...live.changed].join(', ')} but names no organisation, so the server cannot run it. The change will be undone.`);
        for (const o of [...live.changed]) void resync(o, { force: true });
      }
    }
    return out;
  },
};

/** For tests: wait until every operation sent so far is answered. */
export function settled(): Promise<void> {
  return queue;
}
