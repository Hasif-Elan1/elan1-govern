/**
 * Planned maintenance of the console, per organisation (the server keeps maintenance windows per organisation).
 * The public status page reads the open organisation's window, the console sends people to /maintenance while a
 * window is open, and Today announces the next one.
 *
 * The planned window is worked out from the clock (the next Sunday 02:00–02:20 IST), so reading it writes nothing.
 * Only a window an owner started early (or ended early) is kept, on the organisation's document (`maintenance`),
 * which is saved with the rest of the organisation and cleared with it by "Reset demo data".
 */
import type { ComponentStatus } from '@/types';
import { activeOrg, getDB, logAdmin, memberRole, subscribe, touch, type OrgDB } from './db';

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

/** The windows an owner changed (started early, ended early); the planned one is never stored. */
interface MaintenanceState { windows: MaintenanceWindow[] }
type ExtDB = OrgDB & { maintenance?: MaintenanceState };

/** Only an owner starts a window early or ends a demonstration window; nobody signed out does. */
export function canRunMaintenanceDemo(orgId?: string, userId?: string): boolean {
  if (!userId || !orgId) return false;
  try { return memberRole(orgId, userId) === 'owner'; } catch { return false; }
}

function requireOwner(orgId: string, userId: string, what: string) {
  if (!userId || !orgId) throw new Error(`Sign in as an owner to ${what}.`);
  if (!canRunMaintenanceDemo(orgId, userId)) throw new Error(`Only an owner can ${what}. Everyone else waits for the window to close at its planned time.`);
}

/** The next Sunday 02:00 IST whose 20-minute window has not ended yet. */
function nextSundayIst(now = Date.now()) {
  const ist = new Date(now + 5.5 * H);
  const day = ist.getUTCDay();
  const add = (7 - day) % 7;
  const base = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, 2, 0) - 5.5 * H;
  return base + 20 * M > now ? base : base + 7 * D;
}

function planned(now: number): MaintenanceWindow {
  const from = nextSundayIst(now);
  return {
    id: `mw_${new Date(from + 5.5 * H).toISOString().slice(0, 10)}`, title: 'Console upgrade', from: new Date(from).toISOString(), to: new Date(from + 20 * M).toISOString(),
    components: ['console'], note: 'Planned maintenance 02:00–02:20 IST. The decision service, approvals delivery and the receipt chain keep running.',
  };
}

function stored(orgId: string): MaintenanceState {
  const d = getDB(orgId) as ExtDB;
  d.maintenance ??= { windows: [] };
  d.maintenance.windows ??= [];
  return d.maintenance;
}

/** The organisation's windows of the last 30 days, and the planned one when no changed window is still to come. */
function windowsOf(orgId: string, now: number): MaintenanceWindow[] {
  const kept = ((getDB(orgId) as ExtDB).maintenance?.windows ?? []).filter((w) => new Date(w.to).getTime() > now - 30 * D);
  return kept.some((w) => !w.endedAt && new Date(w.to).getTime() > now) ? kept : [...kept, planned(now)];
}

/** Calls `fn` whenever an organisation changes (a window is kept on its document). */
export function subscribeMaintenance(fn: () => void) {
  return subscribe(() => fn());
}

const isOpen = (w: MaintenanceWindow, now: number) => !w.endedAt && new Date(w.from).getTime() <= now && new Date(w.to).getTime() > now;

export function maintenanceWindows(orgId?: string, now = Date.now()): MaintenanceWindow[] {
  if (!orgId) return [];
  return windowsOf(orgId, now).map((w) => ({ ...w })).sort((a, b) => a.from.localeCompare(b.from));
}

/** The organisation's window open now, if any. */
export function activeMaintenance(orgId?: string, now = Date.now()): MaintenanceWindow | undefined {
  if (!orgId) return undefined;
  const w = windowsOf(orgId, now).find((x) => isOpen(x, now));
  return w ? { ...w } : undefined;
}

/** The organisation's next window that has not started. */
export function nextMaintenance(orgId?: string, now = Date.now()): MaintenanceWindow | undefined {
  if (!orgId) return undefined;
  const w = windowsOf(orgId, now).filter((x) => !x.endedAt && new Date(x.from).getTime() > now).sort((a, b) => a.from.localeCompare(b.from))[0];
  return w ? { ...w } : undefined;
}

/** Demonstration: an owner begins the next planned window now, for its planned length (at most 20 minutes). Recorded on their organisation's chain. */
export function startMaintenanceNow(orgId: string, userId: string): MaintenanceWindow {
  requireOwner(orgId, userId, 'start a maintenance window early');
  // Elan1's hosted windows do not apply to a Sovereign deployment, which runs on the organisation's own cluster
  if (getDB(orgId).org.deployment === 'sovereign') throw new Error('Elan1’s hosted maintenance does not reach a Sovereign deployment. Your administrators apply update bundles under Agents › Deployment.');
  const now = Date.now();
  const next = windowsOf(orgId, now).filter((x) => !x.endedAt && new Date(x.to).getTime() > now).sort((a, b) => a.from.localeCompare(b.from))[0];
  if (!next) throw new Error('No maintenance window is planned.');
  if (isOpen(next, now)) throw new Error('The maintenance window is already open.');
  const s = stored(orgId);
  let w = s.windows.find((x) => x.id === next.id);
  if (!w) {
    // the planned window becomes a kept one, under its own id (the planned slot is offered again once it ends)
    w = { ...next, id: `${next.id}_${now.toString(36)}` };
    s.windows.push(w);
  }
  const len = Math.min(20 * M, new Date(w.to).getTime() - new Date(w.from).getTime());
  w.plannedFrom ??= w.from;
  const r = logAdmin(orgId, userId, 'maintenance.started_early', { window: w.id, title: w.title, planned_from: w.plannedFrom, minutes: Math.round(len / M) });
  w.from = new Date(now).toISOString();
  w.to = new Date(now + len).toISOString();
  w.startedEarly = true;
  w.startedBy = { userId, orgId, seq: r.seq };
  touch(orgId, 'maintenance');
  return { ...w };
}

/** An owner ends the open demonstration window now (the console is available again). A planned window runs its course. */
export function endMaintenance(orgId: string, userId: string): MaintenanceWindow | undefined {
  requireOwner(orgId, userId, 'end the demonstration window');
  const now = Date.now();
  const open = windowsOf(orgId, now).find((x) => isOpen(x, now));
  if (!open) return undefined;
  const w = stored(orgId).windows.find((x) => x.id === open.id);
  if (!w || !w.startedEarly) throw new Error('This is a planned window, not a demonstration. It ends at its planned time.');
  const r = logAdmin(orgId, userId, 'maintenance.ended_early', { window: w.id, title: w.title, started_at: w.from, planned_to: w.to });
  w.endedAt = new Date().toISOString();
  w.endedBy = { userId, orgId, seq: r.seq };
  touch(orgId, 'maintenance');
  return { ...w };
}

/**
 * Status components inside an open window show as in maintenance; their history marks today. The window is the
 * one of the organisation the console has open (the public page signed out reads the default organisation's).
 */
export function applyMaintenanceToStatus<C extends { id: string; status: ComponentStatus; days?: { date: string; status: string; note?: string }[] }>(components: C[], orgId = activeOrg()): C[] {
  const w = activeMaintenance(orgId);
  if (!w) return components;
  for (const c of components) {
    if (!w.components.includes(c.id)) continue;
    c.status = 'maintenance';
    const last = c.days?.[c.days.length - 1];
    if (last) { last.status = 'maintenance'; last.note = w.note; }
  }
  return components;
}
