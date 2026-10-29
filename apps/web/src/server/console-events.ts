import "server-only";
import { CONSOLE_CHANNEL } from "@gate/db";
import pg, { type Client } from "pg";
import { env } from "./env";
import { log } from "./log";

/*
 * Change announcements for the console's organisation documents: one LISTEN console_events connection per web
 * process (its own pg connection, outside Prisma's pool), fanned out to every open event stream of that
 * organisation. When the connection drops it comes back with backoff, and every stream is told to "resync",
 * since announcements made while it was down are lost.
 */

export interface ConsoleEvent {
  orgId: string;
  /** What changed (receipt, approval, rulebook …); "hello" on connect, "resync" after the listener reconnected. */
  kind: string;
  version: number;
}
type Listener = (e: ConsoleEvent) => void;

export const HEARTBEAT_MS = 25_000;

// Prisma's own connection-string parameters, which pg would pass on to the server as settings.
const PRISMA_PARAMS = ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size", "socket_timeout", "connect_timeout"];

interface Hub {
  listeners: Map<string, Set<Listener>>;
  client?: Client;
  connecting?: Promise<void>;
  retryMs: number;
  retry?: ReturnType<typeof setTimeout>;
  lost: boolean;
}
const g = globalThis as unknown as { __gateConsoleEvents?: Hub };
const hub: Hub = (g.__gateConsoleEvents ??= { listeners: new Map(), retryMs: 1000, lost: false });

function connectionString() {
  const url = new URL(env().DATABASE_URL);
  for (const p of PRISMA_PARAMS) url.searchParams.delete(p);
  return url.toString();
}

function fanout(e: ConsoleEvent) {
  for (const l of hub.listeners.get(e.orgId) ?? []) {
    try {
      l(e);
    } catch {
      /* one stream's failure never stops the others */
    }
  }
}

function parse(payload: string | undefined): ConsoleEvent | undefined {
  try {
    const e = JSON.parse(payload ?? "") as Partial<ConsoleEvent>;
    if (typeof e.orgId === "string" && typeof e.kind === "string" && typeof e.version === "number") return { orgId: e.orgId, kind: e.kind, version: e.version };
  } catch {
    /* not ours */
  }
  return undefined;
}

function reconnectLater() {
  if (hub.retry || !hub.listeners.size) return;
  hub.retry = setTimeout(() => {
    hub.retry = undefined;
    connect().catch(() => reconnectLater());
  }, hub.retryMs);
  hub.retry.unref?.();
  hub.retryMs = Math.min(hub.retryMs * 2, 30_000);
}

function connect(): Promise<void> {
  if (hub.client) return Promise.resolve();
  hub.connecting ??= (async () => {
    const client = new pg.Client({ connectionString: connectionString(), application_name: "gate-web console events", keepAlive: true, connectionTimeoutMillis: 10_000 });
    const drop = (err?: Error) => {
      // streams open now may miss announcements until it is back: they are told to resync then
      hub.lost = true;
      if (hub.client === client) {
        hub.client = undefined;
        log("warn", "console.events.lost", { err: err?.message });
      }
      client.removeAllListeners();
      client.on("error", () => undefined); // a late error from a dropped connection must not crash the process
      client.end().catch(() => undefined);
      reconnectLater();
    };
    client.on("notification", (n) => {
      const e = n.channel === CONSOLE_CHANNEL ? parse(n.payload) : undefined;
      if (e) fanout(e);
    });
    client.on("error", drop);
    client.on("end", () => drop());
    try {
      await client.connect();
      await client.query(`LISTEN ${CONSOLE_CHANNEL}`);
    } catch (e) {
      drop(e as Error);
      throw e;
    }
    hub.client = client;
    hub.retryMs = 1000;
    if (hub.lost) {
      hub.lost = false;
      for (const orgId of hub.listeners.keys()) fanout({ orgId, kind: "resync", version: -1 });
    }
  })().finally(() => {
    hub.connecting = undefined;
  });
  return hub.connecting;
}

/** Hear every saved change of one organisation's document. Returns the function that stops listening. */
export function subscribe(orgId: string, fn: Listener): () => void {
  let set = hub.listeners.get(orgId);
  if (!set) hub.listeners.set(orgId, (set = new Set()));
  set.add(fn);
  connect().catch((e: Error) => {
    log("warn", "console.events.connect", { err: e.message });
    reconnectLater();
  });
  return () => {
    set.delete(fn);
    if (!set.size) hub.listeners.delete(orgId);
  };
}

/** Wait until this process is listening (tests, and a stream that wants its first event to count). */
export function listening(): Promise<void> {
  return connect();
}

/**
 * A Server-Sent Events response for one organisation: `first`, then each change as `data: {orgId, kind, version}`,
 * with a comment every 25 seconds so proxies keep the connection open. It stops when the browser goes away.
 */
export function eventStream(orgId: string, signal: AbortSignal, first: ConsoleEvent): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      const send = (text: string) => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const unsubscribe = subscribe(orgId, (e) => send(`data: ${JSON.stringify(e)}\n\n`));
      const beat = setInterval(() => send(": keep-alive\n\n"), HEARTBEAT_MS);
      stop = () => {
        if (done) return;
        done = true;
        clearInterval(beat);
        unsubscribe();
        signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      signal.addEventListener("abort", stop, { once: true });
      send(`retry: 5000\n\ndata: ${JSON.stringify(first)}\n\n`);
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" } });
}
