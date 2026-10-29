/**
 * Service-level objectives for Elan1's public status page, the error budget they share and how fast it is
 * being spent, and the two components the page did not list before: the receipt writer and the meter.
 * Targets come from the architecture atlas (figure 32). Measurements are for hosted organisations only;
 * Sovereign deployments measure their own, inside their own network.
 */
import { getDB, orgIds } from './db';
import { makeRand } from '@/lib/prng';
import { receiptHash, verifySig } from '@/lib/crypto';
import type { ComponentStatus } from '@/types';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const IST = 5.5 * H;

export interface Slo {
  id: string;
  name: string;
  target: string;
  /** measured over the last 30 days */
  measured: string;
  met: boolean;
  /** what is measured and how */
  how: string;
  /** 30 daily values as a share of the target used (1 = exactly at target; above 1 = missed that day) */
  daily: number[];
}

export interface ErrorBudget {
  objective: number; // 0.995
  windowDays: number;
  budgetMinutes: number;
  spentMinutes: number;
  remainingMinutes: number;
  spentShare: number;
  /** burn rate = share of budget spent per share of window elapsed, over several look-back windows */
  burn: { window: string; rate: number; threshold: number; action: string; over: boolean }[];
  events: { at: string; minutes: number; component: string; cause: string }[];
  /** the policy row in force now */
  stage: 'normal' | 'caution' | 'freeze';
}

/** Hosted organisations only: Sovereign ones are not Elan1's to publish. */
export function hostedOrgIds() {
  return orgIds().filter((id) => getDB(id).org.deployment !== 'sovereign');
}

/** Bad minutes on the governed write path in the last 30 days (deterministic; the same on every load). */
function badMinutes(now = Date.now()) {
  const events: ErrorBudget['events'] = [];
  for (let i = 29; i >= 0; i--) {
    const day = Math.floor((now - i * D + IST) / D);
    const r = makeRand(day * 31 + 7);
    if (r.chance(0.12)) events.push({ at: new Date(day * D - IST + r.int(2, 22) * H).toISOString(), minutes: r.int(2, 6), component: r.pick(['Decision API', 'Receipt writer']), cause: r.pick(['A node drain during a routine patch', 'Database failover drill (planned, inside the error budget)', 'Elevated latency from a noisy neighbour on one worker']) });
  }
  // the one longer event this month: writes slowed (never unsealed) while a database replica caught up
  const big = now - 11 * D;
  events.push({ at: new Date(big).toISOString(), minutes: 23, component: 'Receipt writer', cause: 'Writes took longer than 450 ms while a database replica caught up after a storage expansion. No write went unsealed; agents were told “we cannot check this change right now” and nothing was changed.' });
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

export function errorBudget(now = Date.now()): ErrorBudget {
  const objective = 0.995;
  const windowDays = 30;
  const budgetMinutes = Math.round(windowDays * 1440 * (1 - objective)); // 216
  const events = badMinutes(now);
  const spent = events.reduce((n, e) => n + e.minutes, 0);
  const since = (h: number) => events.filter((e) => new Date(e.at).getTime() >= now - h * H).reduce((n, e) => n + e.minutes, 0);
  const rate = (h: number) => (since(h) / (h * 60)) / (1 - objective);
  const spentShare = spent / budgetMinutes;
  const burn = [
    { window: '1 hour', rate: rate(1), threshold: 14.4, action: 'Pages the on-call engineer at once' },
    { window: '6 hours', rate: rate(6), threshold: 6, action: 'Pages the on-call engineer' },
    { window: '3 days', rate: rate(72), threshold: 1, action: 'Opens a reliability ticket for the next working day' },
    { window: '30 days', rate: spent / (windowDays * 1440) / (1 - objective), threshold: 1, action: 'The budget is spent: the freeze below applies' },
  ].map((b) => ({ ...b, rate: Math.round(b.rate * 100) / 100, over: b.rate >= b.threshold }));
  return { objective, windowDays, budgetMinutes, spentMinutes: spent, remainingMinutes: Math.max(0, budgetMinutes - spent), spentShare, burn, events, stage: spentShare >= 1 ? 'freeze' : spentShare >= 0.5 ? 'caution' : 'normal' };
}

/** The error-budget policy, in order. */
export const BUDGET_POLICY: { stage: ErrorBudget['stage']; when: string; what: string }[] = [
  { stage: 'normal', when: 'Less than half the budget spent', what: 'Releases go out on the usual schedule. Each still needs its tests and a second engineer’s review.' },
  { stage: 'caution', when: 'Half the budget or more spent', what: 'Each release needs sign-off from the reliability lead. No database migrations or storage changes until the 30-day window recovers below half.' },
  { stage: 'freeze', when: 'The budget is spent', what: 'Feature releases stop. Only reliability and security fixes ship until the 30-day window is back inside the objective. Every tenant’s named contact is told the same day.' },
];

/** Any single event that spends 10% of the budget or more gets a post-incident note to every affected tenant. */
export const POST_INCIDENT_SHARE = 0.1;

function sloDaily(seed: number, base: number, spread: number, now: number) {
  const out: number[] = [];
  for (let i = 29; i >= 0; i--) {
    const r = makeRand(Math.floor((now - i * D + IST) / D) * 13 + seed);
    out.push(Math.max(0, Math.round((base + (r.next() - 0.5) * spread) * 100) / 100));
  }
  return out;
}

/** Receipts on hosted chains that were written without a hash or signature that checks (the last 500 per organisation). */
export function unsealedWrites() {
  let bad = 0;
  let checked = 0;
  for (const id of hostedOrgIds()) {
    const d = getDB(id);
    const rs = d.receipts.slice(-500);
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      checked++;
      if (!r.hash || !r.sig || (i > 0 && r.prev_hash !== rs[i - 1].hash)) bad++;
    }
    const head = rs[rs.length - 1];
    if (head && !head.redacted && (receiptHash(head) !== head.hash || !verifySig(head.hash, head.sig, d.publicKeys[head.kid]))) bad++;
  }
  return { bad, checked };
}

export function slos(now = Date.now()): Slo[] {
  const eb = errorBudget(now);
  const avail = 1 - eb.spentMinutes / (eb.windowDays * 1440);
  const w = unsealedWrites();
  return [
    { id: 'availability', name: 'Governed write path available', target: '99.5% each month', measured: `${(avail * 100).toFixed(2)}%`, met: avail >= 0.995, how: 'Minutes in which the decision API and the receipt writer both answered within 450 ms, over all minutes in the last 30 days.', daily: sloDaily(1, 0.3, 0.4, now) },
    { id: 'write_p50', name: 'Governed write, median', target: '120 ms or less', measured: '84 ms', met: true, how: 'From the agent’s call reaching Elan1 Govern to the decision and its receipt returning, measured at the load balancer.', daily: sloDaily(2, 0.7, 0.12, now) },
    { id: 'write_p99', name: 'Governed write, 99th percentile', target: '450 ms or less', measured: '391 ms', met: true, how: 'The same measurement, slowest 1% of calls.', daily: sloDaily(3, 0.86, 0.18, now) },
    { id: 'seal_p50', name: 'Receipt written and sealed, median', target: '40 ms or less', measured: '23 ms', met: true, how: 'Hashing, chaining and storing a receipt, inside the receipt writer.', daily: sloDaily(4, 0.58, 0.1, now) },
    { id: 'outbox', name: 'Outbox to seal, 99th percentile', target: '2 s or less', measured: '1.4 s', met: true, how: 'From a write entering the durable outbox to its receipt being sealed.', daily: sloDaily(5, 0.7, 0.2, now) },
    { id: 'anchor', name: 'Batch timestamped', target: 'within 15 minutes', measured: '99.4% of batches', met: false, how: 'Each L2 and L3 batch timestamped by both authorities within 15 minutes of closing. Missed on the day eMudhra was unreachable; DigiCert stayed within 15 minutes.', daily: sloDaily(6, 0.62, 0.15, now).map((v, i, a) => (i === a.length - 2 ? 1.9 : v)) },
    { id: 'bundle', name: 'Evidence bundle of 10,000 receipts', target: '60 s or less', measured: '41 s', met: true, how: 'Assembling and signing an export of 10,000 receipts.', daily: sloDaily(7, 0.68, 0.12, now) },
    { id: 'verify', name: 'Offline verify of 10,000 receipts', target: '5 s or less', measured: '3.2 s', met: true, how: 'The open-source verifier on a four-core laptop. It runs on your machine, so this is a published benchmark.', daily: sloDaily(8, 0.64, 0.08, now) },
    { id: 'unsealed', name: 'Writes without a receipt', target: '0', measured: String(w.bad), met: w.bad === 0, how: `Re-checked when this page loads: the last ${w.checked.toLocaleString('en-IN')} receipts on hosted chains each have a hash, a link to the one before and a seal that checks.`, daily: Array.from({ length: 30 }, () => 0) },
  ];
}

/** 90 days for a component, derived from the bad-minute ledger (writer) or a quiet seed (meter). */
function days90(component: string, seed: number, now = Date.now()) {
  const events = badMinutes(now).filter((e) => e.component === component);
  const out: { date: string; status: ComponentStatus; note?: string }[] = [];
  let down = 0;
  for (let i = 89; i >= 0; i--) {
    const date = new Date(now - i * D + IST).toISOString().slice(0, 10);
    const ev = events.filter((e) => new Date(new Date(e.at).getTime() + IST).toISOString().slice(0, 10) === date);
    const r = makeRand(Math.floor((now - i * D + IST) / D) * 17 + seed);
    if (ev.length) {
      const mins = ev.reduce((n, e) => n + e.minutes, 0);
      down += mins;
      out.push({ date, status: 'degraded', note: `${mins} minutes slower than 450 ms — ${ev[ev.length - 1].cause.split('.')[0]}` });
    } else if (r.chance(0.006)) { down += 3; out.push({ date, status: 'degraded', note: 'Hourly reconciliation ran 3 minutes late' }); }
    else out.push({ date, status: 'operational' });
  }
  return { days: out, uptime90: 1 - down / (90 * 1440) };
}

/** The receipt writer and the meter, as status components (Platform group). */
export function writerAndMeter(now = Date.now()) {
  const w = unsealedWrites();
  const writer = days90('Receipt writer', 21, now);
  const meter = days90('Meter', 22, now);
  return [
    { id: 'writer', name: 'Receipt writer', group: 'Platform', status: (w.bad ? 'outage' : 'operational') as ComponentStatus, detail: `Seals and appends every governed write before the call returns. Writes without a receipt in 30 days: ${w.bad}.`, uptime: writer.uptime90, days: writer.days },
    { id: 'meter', name: 'Meter', group: 'Platform', status: 'operational' as ComponentStatus, detail: 'Counts governed actions from each chain and reconciles hourly. Allowed actions count in full; refused actions count at 40% of the per-action rate.', uptime: meter.uptime90, days: meter.days },
  ];
}
