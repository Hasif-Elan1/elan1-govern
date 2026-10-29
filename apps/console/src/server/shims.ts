/**
 * Browser globals for the console domain when it runs on the server (bundled by scripts/build-server.mjs).
 *
 * Nothing here is installed on globalThis: setting `window` inside the Next.js process would flip every
 * `typeof window` check in Next, React and the other libraries loaded there. Instead esbuild's `inject` binds the
 * free identifiers `window`, `localStorage`, `sessionStorage`, `location`, `navigator`, `setTimeout`,
 * `clearTimeout`, `setInterval` and `clearInterval` inside the bundle to these exports, so only domain code sees them.
 *
 * Timers: the domain defers work with timers (open-time seeds, the work engine's debounce, notifications written
 * "after the current call returns") and simulates latency with them. On the server every timeout fires on the
 * next turn whatever its delay, and `settle()` waits until none is pending, so an operation's deferred writes
 * land inside its own lock and are saved with it. Intervals (the browser's session watchers) never fire here.
 */

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Domain timers that have not fired yet, by id. */
const pending = new Map<number, ReturnType<typeof realSetTimeout>>();
let nextId = 1;

function shimSetTimeout(fn: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]): number {
  const id = nextId++;
  pending.set(id, realSetTimeout(() => {
    pending.delete(id);
    fn(...args);
  }, 0));
  return id;
}

function shimClearTimeout(id?: number) {
  if (id === undefined) return;
  const t = pending.get(id);
  if (t) realClearTimeout(t);
  pending.delete(id);
}

function shimSetInterval(): number {
  return nextId++;
}

function shimClearInterval(): void {}

/** Wait until every domain timer (and whatever those timers schedule) has fired. Gives up after `maxRounds` turns. */
export async function settle(maxRounds = 500): Promise<boolean> {
  for (let i = 0; i < maxRounds; i++) {
    if (!pending.size) return true;
    await new Promise((r) => realSetTimeout(r, 0));
  }
  return pending.size === 0;
}

/** Cancel every domain timer that has not fired (after a failed operation, so nothing of it runs later). */
export function cancelPending() {
  for (const t of pending.values()) realClearTimeout(t);
  pending.clear();
}

/** An in-memory Storage. The server's durable state is the organisation document, never this. */
class MemoryStorage {
  #m = new Map<string, string>();
  get length() { return this.#m.size; }
  key(i: number) { return Array.from(this.#m.keys())[i] ?? null; }
  getItem(k: string) { return this.#m.has(k) ? this.#m.get(k)! : null; }
  setItem(k: string, v: string) { this.#m.set(String(k), String(v)); }
  removeItem(k: string) { this.#m.delete(k); }
  clear() { this.#m.clear(); }
}

/** `Object.keys(localStorage)` lists the stored keys in a browser; the proxy keeps that true here. */
function storage(): Storage {
  const s = new MemoryStorage();
  return new Proxy(s, {
    ownKeys: () => Array.from({ length: s.length }, (_, i) => s.key(i)!),
    getOwnPropertyDescriptor: (t, k) => (typeof k === 'string' && s.getItem(k) !== null ? { value: s.getItem(k), enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(t, k)),
    get: (t, k) => {
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as unknown as Storage;
}

const shimLocalStorage = storage();
const shimSessionStorage = storage();
const shimLocation = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '', host: 'localhost', hostname: 'localhost', protocol: 'http:', reload() {}, assign() {}, replace() {} };
const shimNavigator = { userAgent: 'Elan1 Govern server', language: 'en-IN', onLine: true };

/**
 * `window`: the shims above, then the real globals (crypto, URL, TextEncoder …). Those are read with globalThis
 * as the receiver, since some of Node's (crypto) are getters that refuse any other `this`.
 */
const own: Record<string | symbol, unknown> = {
  setTimeout: shimSetTimeout,
  clearTimeout: shimClearTimeout,
  setInterval: shimSetInterval,
  clearInterval: shimClearInterval,
  localStorage: shimLocalStorage,
  sessionStorage: shimSessionStorage,
  location: shimLocation,
  navigator: shimNavigator,
};
const shimWindow = new Proxy(own, {
  get: (t, k) => (k in t ? t[k] : Reflect.get(globalThis, k)),
  has: (t, k) => k in t || k in globalThis,
}) as unknown as typeof globalThis;

export {
  shimWindow as window,
  shimLocalStorage as localStorage,
  shimSessionStorage as sessionStorage,
  shimLocation as location,
  shimNavigator as navigator,
  shimSetTimeout as setTimeout,
  shimClearTimeout as clearTimeout,
  shimSetInterval as setInterval,
  shimClearInterval as clearInterval,
};
