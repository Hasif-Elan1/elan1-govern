/**
 * Planned maintenance of the console (platform-wide, not per organisation). The public status page reads it, the
 * console sends people to /maintenance while a window is open, and Today announces the next one.
 * Saved under the eg:state: prefix, so "Reset demo data" clears it.
 */
import type { ComponentStatus } from '@/types';
import { getDB, logAdmin, memberRole } from './db';

const KEY = 'eg:state:ops:maintenance';
const M = 60_000;
const H = 60 * M;
const D = 24 * H;

export interface MaintenanceWindow {
  id: string;
  title: string;
  from: string;
  to: string;
  /** status components the window covers */
  components: string[];
  note: string;
  /** started ahead of its planned time from the console (demonstration) */
  startedEarly?: boolean;
  plannedFrom?: string;
  endedAt?: string;
  /** the owner who started it early or ended it early, and the receipt on their organisation's chain */
  startedBy?: { userId: string; orgId: string; seq?: number };
  endedBy?: { userId: string; orgId: string; seq?: number };
}

/** Who is acting on a demonstration window: the signed-in person and the organisation they are in. */
export interface MaintenanceActor { userId?: string; orgId?: string }

/** Only an owner starts a window early or ends a demonstration window; nobody signed out does. */
export function canRunMaintenanceDemo(by: MaintenanceActor): boolean {
  if (!by.userId || !by.orgId) return false;
  try { return memberRole(by.orgId, by.userId) === 'owner'; } catch { return false; }
}

function requireOwner(by: MaintenanceActor, what: string): { userId: string; orgId: string } {
  if (!by.userId || !by.orgId) throw new Error(`Sign in as an owner to ${what}.`);
  if (!canRunMaintenanceDemo(by)) throw new Error(`Only an owner can ${what}. Everyone else waits for the window to close at its planned time.`);
  return { userId: by.userId, orgId: by.orgId };
}

interface State { windows: MaintenanceWindow[] }

const listeners = new Set<() => void>();
let cache: State | undefined;

/** The next Sunday 02:00 IST at least a day away. */
function nextSundayIst(now = Date.now()) {
  const ist = new Date(now + 5.5 * H);
  const day = ist.getUTCDay();
  let add = (7 - day) % 7;
  const base = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, 2, 0) - 5.5 * H;
  if (base - now < D) add += 7;
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, 2, 0) - 5.5 * H;
}

function seeded(): State {
  const from = nextSundayIst();
  return {
    windows: [{
      id: 'mw_next', title: 'Console upgrade', from: new Date(from).toISOString(), to: new Date(from + 20 * M).toISOString(),
      components: ['console'], note: 'Planned maintenance 02:00–02:20 IST. The decision service, approvals delivery and the receipt chain keep running.',
    }],
  };
}

function state(): State {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) cache = JSON.parse(raw) as State;
  } catch { /* storage unavailable */ }
  if (!cache || !Array.isArray(cache.windows)) cache = seeded();
  // a window that has passed is followed by the next planned one
  const now = Date.now();
  if (!cache.windows.some((w) => !w.endedAt && new Date(w.to).getTime() > now)) {
    cache.windows = [...cache.windows.filter((w) => new Date(w.to).getTime() > now - 30 * D), ...seeded().windows.map((w) => ({ ...w, id: `mw_${Date.now().toString(36)}` }))];
    save();
  }
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* fine */ }
  listeners.forEach((l) => l());
}

export function subscribeMaintenance(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const isOpen = (w: MaintenanceWindow, now: number) => !w.endedAt && new Date(w.from).getTime() <= now && new Date(w.to).getTime() > now;

export function maintenanceWindows(): MaintenanceWindow[] {
  return state().windows.map((w) => ({ ...w })).sort((a, b) => a.from.localeCompare(b.from));
}

/** The window open now, if any. */
export function activeMaintenance(now = Date.now()): MaintenanceWindow | undefined {
  const w = state().windows.find((x) => isOpen(x, now));
  return w ? { ...w } : undefined;
}

/** The next window that has not started. */
export function nextMaintenance(now = Date.now()): MaintenanceWindow | undefined {
  const w = state().windows.filter((x) => !x.endedAt && new Date(x.from).getTime() > now).sort((a, b) => a.from.localeCompare(b.from))[0];
  return w ? { ...w } : undefined;
}

/** Demonstration: an owner begins the next planned window now, for its planned length (at most 20 minutes). Recorded on their organisation's chain. */
export function startMaintenanceNow(by: MaintenanceActor): MaintenanceWindow {
  const who = requireOwner(by, 'start a maintenance window early');
  // Elan1's hosted windows do not apply to a Sovereign deployment, which runs on the organisation's own cluster
  if (getDB(who.orgId).org.deployment === 'sovereign') throw new Error('Elan1’s hosted maintenance does not reach a Sovereign deployment. Your administrators apply update bundles under Agents › Deployment.');
  const s = state();
  const now = Date.now();
  const w = s.windows.filter((x) => !x.endedAt && new Date(x.to).getTime() > now).sort((a, b) => a.from.localeCompare(b.from))[0];
  if (!w) throw new Error('No maintenance window is planned.');
  if (isOpen(w, now)) throw new Error('The maintenance window is already open.');
  const len = Math.min(20 * M, new Date(w.to).getTime() - new Date(w.from).getTime());
  w.plannedFrom ??= w.from;
  const r = logAdmin(who.orgId, who.userId, 'maintenance.started_early', { window: w.id, title: w.title, planned_from: w.plannedFrom, minutes: Math.round(len / M) });
  w.from = new Date(now).toISOString();
  w.to = new Date(now + len).toISOString();
  w.startedEarly = true;
  w.startedBy = { ...who, seq: r.seq };
  save();
  return { ...w };
}

/** An owner ends the open demonstration window now (the console is available again). A planned window runs its course. */
export function endMaintenance(by: MaintenanceActor): MaintenanceWindow | undefined {
  const who = requireOwner(by, 'end the demonstration window');
  const s = state();
  const w = s.windows.find((x) => isOpen(x, Date.now()));
  if (!w) return undefined;
  if (!w.startedEarly) throw new Error('This is a planned window, not a demonstration. It ends at its planned time.');
  const r = logAdmin(who.orgId, who.userId, 'maintenance.ended_early', { window: w.id, title: w.title, started_at: w.from, planned_to: w.to });
  w.endedAt = new Date().toISOString();
  w.endedBy = { ...who, seq: r.seq };
  save();
  return { ...w };
}

/** Status components inside an open window show as in maintenance; their history marks today. */
export function applyMaintenanceToStatus<C extends { id: string; status: ComponentStatus; days?: { date: string; status: string; note?: string }[] }>(components: C[]): C[] {
  const w = activeMaintenance();
  if (!w) return components;
  for (const c of components) {
    if (!w.components.includes(c.id)) continue;
    c.status = 'maintenance';
    const last = c.days?.[c.days.length - 1];
    if (last) { last.status = 'maintenance'; last.note = w.note; }
  }
  return components;
}
