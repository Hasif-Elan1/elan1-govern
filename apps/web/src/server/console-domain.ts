import "server-only";
import { consoleState, ConsoleStateConflict, membershipsForUser, type ConsoleSql } from "@gate/db";
import type { OpEntry, SavedDoc } from "@gate/console/server";
import { HttpError } from "./api";
import { log } from "./log";

/*
 * The approved console's domain, run on the server (plans/console-app.md, Phase 1 design). The bundle
 * (`@gate/console/server`, built by apps/console/scripts/build-server.mjs) keeps each organisation's state in
 * memory as one document; here that memory is backed by ConsoleState in Postgres.
 *
 * Every operation runs:
 *  - alone in this process (one queue for all organisations: the domain shares module state between them, and
 *    some operations write into another organisation's document, such as a counterparty's);
 *  - inside a transaction holding the organisation's advisory lock, so other web processes wait their turn;
 *  - on current documents: any document another process saved since is reloaded first;
 *  - to completion: the timers the domain sets for deferred writes all fire (settle) before anything is saved.
 * Then every document that changed is saved with its version + 1 (optimistic: a document someone else saved in
 * between refuses the save), and after the commit each change is announced with NOTIFY console_events.
 * When the operation or the save fails, every document in memory goes back to its last saved state, so a
 * refusal halfway through leaves nothing behind.
 */

type Domain = typeof import("@gate/console/server");

/** Operations with no organisation parameter that callers may run. Candidates are listed in the Phase 1.2 notes. */
const WITHOUT_ORG = new Set<string>([]);

/**
 * Operations the door never runs: they hand back every member's secrets (TOTP secrets, invite tokens) or other
 * people's single-use approval-link tokens. The browser reads the same settings from its snapshot, which has
 * them removed (forBrowser).
 */
const REFUSED = new Set<string>(["orgApi.orgState", "work.linksFor"]);

interface Stored {
  version: number;
  json: string;
  members?: SavedDoc["members"];
}

interface Runtime {
  domain: Domain;
  ops: Map<string, OpEntry>;
  /** The last saved document of each organisation, as this process knows it. */
  stored: Map<string, Stored>;
  /** Organisations the domain reported as changed since the last save. */
  changed: Set<string>;
  /** The last change kind per organisation (receipt, approval …), for the announcement. */
  kinds: Map<string, string>;
  queue: Promise<unknown>;
}

// One runtime per process; kept on globalThis so a dev reload of this module reuses the loaded domain.
const g = globalThis as unknown as { __gateConsole?: Promise<Runtime> };

async function load(): Promise<Runtime> {
  const domain: Domain = await import("@gate/console/server");
  const rt: Runtime = {
    domain,
    ops: new Map(domain.opsManifest.ops.map((o) => [o.name, o])),
    stored: new Map(),
    changed: new Set(),
    kinds: new Map(),
    queue: Promise.resolve(),
  };
  domain.db.setPersistence({
    load: (orgId) => {
      const s = rt.stored.get(orgId);
      return s ? (JSON.parse(s.json) as SavedDoc) : undefined;
    },
    save: (orgId) => {
      rt.changed.add(orgId);
    },
  });
  domain.db.subscribe((orgId, kind) => {
    if (kind !== "open") rt.kinds.set(orgId, kind);
  });
  return rt;
}

function runtime(): Promise<Runtime> {
  g.__gateConsole ??= load().catch((e) => {
    g.__gateConsole = undefined;
    throw new Error(`The console domain is not built (run pnpm --filter @gate/console build:server): ${(e as Error).message}`);
  });
  return g.__gateConsole;
}

/** One operation at a time in this process. */
function exclusive<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
  const run = rt.queue.then(fn, fn);
  rt.queue = run.catch(() => undefined);
  return run;
}

/** The document as it is stored: what saveState writes, without the save time (so an unchanged one compares equal). */
function docJson(rt: Runtime, orgId: string): string | undefined {
  const d = rt.domain.db.exportDoc(orgId) as (SavedDoc & { savedAt?: number }) | undefined;
  if (!d) return undefined;
  const { savedAt: _savedAt, ...doc } = d;
  return JSON.stringify(doc);
}

const inMemory = (rt: Runtime) => rt.domain.db.orgIds().filter((o) => rt.domain.db.peekDB(o));

/** Bring every document another process saved since into this process. */
async function refresh(rt: Runtime, tx: ConsoleSql) {
  const versions = await consoleState.versions(tx);
  for (const orgId of [...rt.stored.keys()]) {
    if (versions.has(orgId)) continue;
    rt.stored.delete(orgId); // the row is gone (a database reset): forget what was built on it
    rt.domain.db.dropFromMemory(orgId);
  }
  const known = new Set(rt.domain.db.orgIds());
  for (const [orgId, version] of versions) {
    if (!known.has(orgId) || rt.stored.get(orgId)?.version === version) continue;
    const row = await consoleState.load(orgId, tx);
    if (!row) continue;
    rt.stored.set(orgId, row);
    const doc = JSON.parse(row.json) as SavedDoc;
    if (rt.domain.db.peekDB(orgId)) rt.domain.db.importDoc(orgId, doc);
    // the organisation switcher's levels, as the browser keeps them for organisations not open yet
    else rt.domain.db.syncOrgMeta(doc.org);
  }
}

/** Put every document in memory back to its last saved state (or forget it if it was never saved). */
function rollBack(rt: Runtime) {
  rt.domain.cancelPending();
  for (const orgId of inMemory(rt)) {
    const s = rt.stored.get(orgId);
    if (!s) rt.domain.db.dropFromMemory(orgId);
    else if (docJson(rt, orgId) !== s.json) rt.domain.db.importDoc(orgId, JSON.parse(s.json) as SavedDoc);
  }
  rt.changed.clear();
  rt.kinds.clear();
}

/** An operation's own failure (a refusal, a bad argument): its message goes back to the caller. */
class OpFailed extends Error {}

/**
 * Run `fn` on current documents under the lock of `lockOrg`, then save what changed (`lockOrg` is compared even
 * if the domain reported no change). Returns fn's value and `lockOrg`'s saved version after the commit.
 */
async function locked<T>(rt: Runtime, lockOrg: string, fn: () => Promise<T> | T): Promise<{ value: T; version: number | null }> {
  return exclusive(rt, async () => {
    const commits: { orgId: string; stored: Stored; kind: string }[] = [];
    try {
      const out = await consoleState.withLock(lockOrg, async (tx) => {
        await refresh(rt, tx);
        rt.changed.clear();
        rt.kinds.clear();
        let value: T;
        try {
          value = await fn();
        } catch (e) {
          throw new OpFailed(e instanceof Error ? e.message : "The operation failed.");
        }
        if (!(await rt.domain.settle())) throw new Error("The console's deferred work did not finish.");
        const candidates = new Set([...rt.changed, lockOrg, ...inMemory(rt).filter((o) => !rt.stored.has(o))]);
        for (const orgId of candidates) {
          const json = docJson(rt, orgId);
          const before = rt.stored.get(orgId);
          if (json === undefined || json === before?.json) continue;
          const version = await consoleState.save(orgId, json, before?.version ?? 0, tx);
          commits.push({ orgId, stored: { version, json }, kind: rt.kinds.get(orgId) ?? "update" });
        }
        return value;
      });
      for (const c of commits) rt.stored.set(c.orgId, c.stored);
      rt.changed.clear();
      for (const c of commits) {
        await consoleState.notify({ orgId: c.orgId, kind: c.kind, version: c.stored.version }).catch((e: Error) => log("warn", "console.notify", { orgId: c.orgId, err: e.message }));
      }
      return { value: out, version: rt.stored.get(lockOrg)?.version ?? null };
    } catch (e) {
      rollBack(rt);
      if (e instanceof OpFailed) throw new HttpError(400, e.message);
      if (e instanceof ConsoleStateConflict) throw new HttpError(409, "Someone else changed this organisation at the same moment. Nothing was changed; try again.");
      throw e;
    }
  });
}

/** Results go back as JSON. Maps and Sets keep their contents as {"$map": [[k, v] …]} and {"$set": […]}. */
function jsonSafe(value: unknown): unknown {
  const text = JSON.stringify(value, (_k, v: unknown) => (v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v));
  return text === undefined ? null : JSON.parse(text);
}

/** The arguments as the operation will see them: every actor position, and actor input field, is the caller. */
function withActor(op: OpEntry, args: readonly unknown[], actorUserId: string): unknown[] {
  const out = op.rest ? [...args] : args.slice(0, op.params.length);
  for (const i of op.actors) {
    while (out.length < i) out.push(undefined);
    out[i] = actorUserId;
  }
  for (const { index, props } of op.actorProps) {
    const v = out[index];
    if (v && typeof v === "object" && !Array.isArray(v)) out[index] = { ...v, ...Object.fromEntries(props.map((p) => [p, actorUserId])) };
  }
  return out;
}

/** The manifest entry for an operation the caller may run, or an HttpError. */
export async function opFor(opName: string): Promise<OpEntry> {
  const op = (await runtime()).ops.get(opName);
  if (!op) throw new HttpError(404, "There is no such operation.");
  if (REFUSED.has(op.name) || (op.org === null && !WITHOUT_ORG.has(op.name))) throw new HttpError(403, "This operation is not available here.");
  return op;
}

/** Whether the console knows this organisation id (an unknown id would otherwise open Demo Traders). */
export async function knownConsoleOrg(orgId: string): Promise<boolean> {
  return (await runtime()).domain.db.orgIds().includes(orgId);
}

/**
 * Run one operation as `actorUserId` and save what it changed. `orgId` must be the operation's organisation
 * argument (the caller has checked membership); null only for an allowed operation without one, which may not
 * change any document.
 */
export async function runOp(orgId: string | null, actorUserId: string, opName: string, args: readonly unknown[]): Promise<{ result: unknown; version: number | null }> {
  const rt = await runtime();
  const op = await opFor(opName);
  const prepared = withActor(op, args, actorUserId);
  if (op.org === null ? orgId !== null : prepared[op.org] !== orgId || !orgId) throw new HttpError(400, "The organisation does not match the operation.");
  if (orgId && !(await knownConsoleOrg(orgId))) throw new HttpError(404, "There is no such organisation.");
  const parent = op.path.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], rt.domain) as Record<string, unknown>;
  const fn = parent[op.path[op.path.length - 1]!];
  if (typeof fn !== "function") throw new HttpError(404, "There is no such operation.");

  if (!orgId) {
    // no organisation to lock or save: it runs alone, and if it changed any document it is undone
    return exclusive(rt, async () => {
      rt.changed.clear();
      try {
        const result = jsonSafe(await (fn as (...a: unknown[]) => unknown).apply(parent, prepared));
        await rt.domain.settle();
        if (rt.changed.size || inMemory(rt).some((o) => !rt.stored.has(o))) throw new Error(`${op.name} changed a document without an organisation.`);
        return { result, version: null };
      } catch (e) {
        rollBack(rt);
        throw e instanceof HttpError ? e : new HttpError(400, e instanceof Error ? e.message : "The operation failed.");
      }
    });
  }
  // as in the browser, the organisation is open (and the active one) before its operations run; the result is
  // copied inside the lock, since it may share objects with the documents
  const { value, version } = await locked(rt, orgId, async () => {
    rt.domain.db.getDB(orgId);
    rt.domain.db.setActiveOrg(orgId);
    return jsonSafe(await (fn as (...a: unknown[]) => unknown).apply(parent, prepared));
  });
  return { result: value, version };
}

/** The organisation's last saved document, building (and saving) it from the seed the first time. */
async function current(orgId: string): Promise<Stored> {
  const rt = await runtime();
  if (!(await knownConsoleOrg(orgId))) throw new HttpError(404, "There is no such organisation.");
  const version = await consoleState.version(orgId);
  const s = rt.stored.get(orgId);
  if (s && s.version === version) return s;
  await locked(rt, orgId, () => {
    rt.domain.db.getDB(orgId);
  });
  const now = rt.stored.get(orgId);
  if (!now) throw new Error(`The console document of ${orgId} could not be saved.`);
  return now;
}

/**
 * The document minus what no browser should hold: the chain's signing seeds (keySeeds), every person's TOTP
 * secret, invite tokens, pending WhatsApp codes and single-use approval-link tokens. The operation that creates
 * one of these returns it to the person who asked.
 */
function forBrowser(doc: Record<string, unknown>): Record<string, unknown> {
  delete doc.keySeeds;
  const settings = doc.orgSettings as { mfa?: Record<string, { secret?: string }>; invites?: { token?: string }[]; whatsapp?: Record<string, { pending?: unknown }> } | undefined;
  for (const m of Object.values(settings?.mfa ?? {})) delete m.secret;
  for (const i of settings?.invites ?? []) delete i.token;
  for (const w of Object.values(settings?.whatsapp ?? {})) delete w.pending;
  for (const l of ((doc.platform as { links?: { token?: string }[] } | undefined)?.links ?? [])) delete l.token;
  return doc;
}

/** The organisation's document for the browser (without what forBrowser drops) and its version. */
export async function stateFor(orgId: string): Promise<{ version: number; doc: Record<string, unknown> }> {
  const s = await current(orgId);
  return { version: s.version, doc: forBrowser(JSON.parse(s.json) as Record<string, unknown>) };
}

/**
 * Whether the signed-in user may use this console organisation: an active member of it in the Membership table,
 * or, until the demo organisations and their people are seeded (TODO Phase 1.5: remove this second rule then),
 * an active member in the organisation document's own member list.
 */
export async function consoleMember(userId: string, orgId: string): Promise<boolean> {
  if (!(await knownConsoleOrg(orgId))) return false;
  if ((await membershipsForUser(userId)).some((m) => m.orgId === orgId)) return true;
  const s = await current(orgId);
  s.members ??= (JSON.parse(s.json) as SavedDoc).members ?? [];
  return s.members.some((m) => m.userId === userId && m.status === "active");
}

/** For tests: forget this process's documents, as a fresh process would start. */
export async function forgetConsoleMemory() {
  const rt = await runtime();
  await exclusive(rt, async () => {
    for (const orgId of inMemory(rt)) rt.domain.db.dropFromMemory(orgId);
    rt.stored.clear();
    rt.changed.clear();
  });
}
