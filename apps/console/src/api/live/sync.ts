/**
 * Live builds: the console's synchronous store (mock/db.ts) holds the server's copy of each organisation's
 * document, so the screens keep reading it as they always have (plans/console-app.md, Phase 1.3 refined).
 *
 *  - Opening an organisation fetches GET /api/console/state?org= and imports it (db.importDoc), and fills the
 *    directory (mock/users) with the organisation's real people from GET /api/console/people?org=.
 *  - GET /api/console/stream?org= (Server-Sent Events) announces every saved change. A newer version is fetched
 *    and imported, then the screens are told (kind 'resync', which every useQuery takes as "anything changed").
 *  - The domain's persistence hook no longer writes localStorage: it only reports changes, which the engine
 *    (engine.ts) sends on to the server when an operation made them.
 *
 * The browser never holds signing keys: the server's document comes without them (forBrowser). A local operation
 * that signs a record does so with a stand-in key that exists only in this tab, and the server's copy, signed by the
 * real key, replaces it as soon as the server answers.
 */
import * as db from '@/mock/db';
import type { SavedDoc } from '@/mock/db';
import { ORGS, USERS } from '@/mock/users';
import type { Org, Role, User } from '@/types';
import { get } from '@/api/http';
import { DEV, live, quietly } from './state';

interface StateAnswer { version: number; doc: SavedDoc & Record<string, unknown> }
export interface Person { id: string; name: string; email: string; title?: string | null; initials: string; mfa: boolean; role: Role; status: string }

/** The server version of each organisation's document this tab holds. */
const versions = new Map<string, number>();
const loaded = new Set<string>();
/** A stand-in signing seed for this tab only (see the file comment). */
const tabSeed = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const warned = new Set<string>();

function warnOnce(key: string, ...msg: unknown[]) {
  if (!DEV || warned.has(key)) return;
  warned.add(key);
  console.warn('[live]', ...msg);
}

/** Every change the domain makes goes through here (mock/db.ts emit → saveState); nothing is written to storage. */
export function installPersistence() {
  db.setPersistence({
    load(orgId) {
      // an organisation this tab never fetched: the domain builds it from the demonstration seed
      warnOnce(`seed:${orgId}`, `${orgId} was opened before its document arrived from the server, so it was built from the demonstration seed.`);
      return undefined;
    },
    save(orgId) {
      if (live.quiet) return;
      live.changes++;
      live.changed.add(orgId);
      if (!live.depth) {
        const at = new Error().stack?.split('\n').slice(2, 6).join(' ← ') ?? '';
        warnOnce(`stray:${at}`, `A change to ${orgId} was made outside any console operation, so the server never sees it and the next sync undoes it.`, at);
      }
    },
  });
}

/** The document as the domain can open it: the server sends it without keys, so this tab gets stand-in ones. */
function prepare(doc: StateAnswer['doc']): SavedDoc {
  const d = doc as SavedDoc & { keySeeds?: { seed: string; kid: string; from: number }[]; publicKeys?: Record<string, string> };
  if (!d.keySeeds?.length) {
    const kids = Object.keys(d.publicKeys ?? {});
    // the active key signs last: the newest record's key goes to the end
    const head = (d.receipts ?? [])[(d.receipts ?? []).length - 1]?.kid;
    const ordered = head && kids.includes(head) ? [...kids.filter((k) => k !== head), head] : kids;
    d.keySeeds = ordered.map((kid, i) => ({ seed: `${tabSeed}:${kid}`, kid, from: i }));
  }
  return d;
}

/** Keep the shared organisation list (switcher, levels) in step with the server's organisation record. */
function upsertOrg(org: Org) {
  const o = ORGS.find((x) => x.id === org.id);
  if (o) Object.assign(o, org);
  else ORGS.push({ ...org });
}

/**
 * The directory (userName, userById …) shows the organisation's real people: each is added or brought up to date,
 * and a person the server no longer lists in this organisation is taken out of it.
 */
export function applyPeople(orgId: string, people: Person[]) {
  const ids = new Set(people.map((p) => p.id));
  for (const p of people) {
    const i = USERS.findIndex((u) => u.id === p.id);
    const prev = i >= 0 ? USERS[i] : undefined;
    const next: User = {
      ...(prev ?? {}),
      id: p.id,
      name: p.name,
      email: p.email,
      title: p.title ?? prev?.title ?? '',
      initials: p.initials,
      mfa: p.mfa,
      role: prev && prev.orgIds.some((o) => o !== orgId) ? prev.role : p.role,
      orgIds: Array.from(new Set([...(prev?.orgIds ?? []), orgId])),
    };
    if (i >= 0) USERS[i] = next;
    else USERS.push(next);
  }
  for (let i = USERS.length - 1; i >= 0; i--) {
    const u = USERS[i];
    if (!u.orgIds.includes(orgId) || ids.has(u.id)) continue;
    u.orgIds = u.orgIds.filter((o) => o !== orgId);
    if (!u.orgIds.length) USERS.splice(i, 1);
  }
}

/** Put the signed-in person in the directory as /api/me describes them (before any organisation is open). */
export function applySelf(u: User) {
  const i = USERS.findIndex((x) => x.id === u.id);
  if (i >= 0) USERS[i] = { ...USERS[i], ...u, orgIds: Array.from(new Set([...USERS[i].orgIds, ...u.orgIds])) };
  else USERS.push({ ...u });
}

function importState(orgId: string, s: StateAnswer) {
  const doc = prepare(s.doc);
  quietly(() => db.importDoc(orgId, doc));
  upsertOrg(db.getDB(orgId).org);
  versions.set(orgId, s.version);
  loaded.add(orgId);
}

async function fetchPeople(orgId: string) {
  try {
    const r = await get<{ people: Person[] }>(`/api/console/people?org=${encodeURIComponent(orgId)}`);
    applyPeople(orgId, r.people);
  } catch { /* the directory keeps what it has */ }
}

/** Fetch an organisation's document and people and open it. Rejects when the server refuses it. */
export async function loadOrg(orgId: string): Promise<void> {
  const [s] = await Promise.all([get<StateAnswer>(`/api/console/state?org=${encodeURIComponent(orgId)}`), fetchPeople(orgId)]);
  importState(orgId, s);
}

export const isLoaded = (orgId: string) => loaded.has(orgId);
export const versionOf = (orgId: string) => versions.get(orgId);

/** Tell every screen the organisation's records changed (useQuery reloads; stores re-read). */
function announce(orgId: string) {
  quietly(() => db.touch(orgId, 'resync'));
}

interface Pending { force: boolean; people: boolean }
const running = new Map<string, Promise<void>>();
const again = new Map<string, Pending>();
const deferred = new Map<string, Pending>();

const merge = (a: Pending | undefined, b: Pending): Pending => ({ force: !!a?.force || b.force, people: !!a?.people || b.people });

/**
 * Bring an organisation up to the server's copy. `force` imports it even at the same version (to discard local
 * changes the server refused). Calls made while one runs are folded into one more run; calls made while the tab
 * waits for the server to answer one of its own operations wait for that answer (see engine.ts).
 */
export function resync(orgId: string, opts: { force?: boolean; people?: boolean; afterForward?: boolean } = {}): Promise<void> {
  if (!loaded.has(orgId)) return Promise.resolve();
  const want: Pending = { force: !!opts.force, people: !!opts.people };
  if (!opts.afterForward && (live.inflight.get(orgId) ?? 0) > 0) {
    deferred.set(orgId, merge(deferred.get(orgId), want));
    return Promise.resolve();
  }
  const current = running.get(orgId);
  if (current) {
    again.set(orgId, merge(again.get(orgId), want));
    return current;
  }
  const run = (async () => {
    try {
      const [s] = await Promise.all([get<StateAnswer>(`/api/console/state?org=${encodeURIComponent(orgId)}`), want.people ? fetchPeople(orgId) : undefined]);
      if (want.force || s.version !== versions.get(orgId) || want.people) {
        if (want.force || s.version !== versions.get(orgId)) importState(orgId, s);
        announce(orgId);
      }
    } catch { /* offline or signed out: the http hooks have said so; the next event or reconnect resyncs */ }
  })().finally(() => {
    running.delete(orgId);
    const next = again.get(orgId);
    again.delete(orgId);
    if (next) void resync(orgId, next);
  });
  running.set(orgId, run);
  return run;
}

/** The server answered one of this tab's operations at `version`: fetch it unless this tab already has it. */
export function noteServerVersion(orgId: string, version: unknown, afterForward = false) {
  if (typeof version !== 'number') return;
  if (version !== versions.get(orgId)) void resync(orgId, { afterForward });
}

/** Every operation this tab sent for the organisation is answered: run the resyncs that waited for that. */
export function flushDeferred(orgId: string) {
  const d = deferred.get(orgId);
  deferred.delete(orgId);
  if (d) void resync(orgId, { ...d, afterForward: true });
}

/* ── The live stream ──────────────────────────────────────── */

let stream: { orgId: string; es: EventSource; retry?: number } | undefined;
let lastProbe = 0;

/** Ask the server whether it is there (and whether the session still is): the http hooks report what it says. */
function probe() {
  if (Date.now() - lastProbe < 4000) return;
  lastProbe = Date.now();
  void get('/api/me').catch(() => undefined);
}

/** Listen to one organisation's changes (the open one); replaces any earlier stream. */
export function startStream(orgId: string) {
  stopStream();
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource(`/api/console/stream?org=${encodeURIComponent(orgId)}`);
  const me = { orgId, es } as NonNullable<typeof stream>;
  stream = me;
  es.onmessage = (m) => {
    let e: { orgId?: string; kind?: string; version?: number };
    try { e = JSON.parse(m.data as string); } catch { return; }
    if (e.orgId !== orgId) return;
    if (e.kind === 'resync') void resync(orgId, { force: true });
    else if (typeof e.version === 'number' && e.version !== versions.get(orgId)) void resync(orgId, { people: e.kind === 'member' });
  };
  es.onerror = () => {
    if (stream !== me) return;
    probe();
    // a refused stream (signed out, no longer a member) is closed for good by the browser: try again later
    if (es.readyState === EventSource.CLOSED) {
      me.retry = window.setTimeout(() => { if (stream === me) startStream(orgId); }, 5000);
    }
  };
}

export function stopStream() {
  if (!stream) return;
  window.clearTimeout(stream.retry);
  stream.es.close();
  stream = undefined;
}

/** Signed out: forget every organisation this tab opened. */
export function forgetAll() {
  stopStream();
  for (const orgId of loaded) quietly(() => db.dropFromMemory(orgId));
  loaded.clear();
  versions.clear();
  deferred.clear();
  again.clear();
}
