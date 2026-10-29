/**
 * The meter, computed from the organisation's own chain — nothing typed in, nothing modelled.
 *
 * One meter event per governed action (a `decision` receipt). Its outcome comes from the chain:
 * allowed → committed; asked → the approval receipt that resolved it (approved → committed,
 * rejected or expired → refused); refused → refused. A committed action uses 1 included action;
 * a refused one uses 0.4 (40% of the per-action rate); a call still waiting for a person uses 0.
 *
 * Invoices are built per IST calendar month with the plan in force at each event (the organisation's
 * level history), so a month that crosses an upgrade boundary carries both plans, each for its days.
 * Sovereign is billed as a yearly deployment licence plus every action at the Sovereign rate.
 */
// a type only: mock/db.ts builds its invoices with this module, so it must not import the API at run time
import type { OrgDB } from '@/mock/db';
import type { Invoice, InvoiceLine, LevelId, PlanId, Receipt } from '@/types';
import { PLANS, REFUSAL_FACTOR, GST_RATE, monthlyInvoice, ADD_ONS } from '@/lib/pricing';
import { levelAt, levelRank, LEVEL_INFO } from '@/lib/levels';
import { sha256Hex } from '@/lib/crypto';
import { LEGAL_ENTITY } from '@/lib/company';
import { closesDispute, discountsOf, discountCovers, latestRuns, pilotOf, settlementsOf, PILOT, type Settlement, type SettlementOutcome } from '@/mock/billing';
import { isPlatformRefusal } from '@/lib/platformRefusal';

export type OrgData = OrgDB;

const H = 3_600_000;
const D = 24 * H;
const IST = 5.5 * H;

/** 'YYYY-MM' of an instant, in IST. */
export const monthOf = (t: number) => new Date(t + IST).toISOString().slice(0, 7);
/** IST midnight of the first day of a 'YYYY-MM' month, as epoch ms. */
export const monthStart = (ym: string) => { const [y, m] = ym.split('-').map(Number); return Date.UTC(y, m - 1, 1) - IST; };
export const nextMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
/** First month of the Indian fiscal year containing `ym`. */
export const fyStartOf = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${m >= 4 ? y : y - 1}-04`; };
export const fyLabel = (ym: string) => { const s = Number(fyStartOf(ym).slice(0, 4)); return `FY ${s}–${String(s + 1).slice(2)}`; };

/* ── Supplier (printed on every tax invoice) ──────────────── */

/**
 * The supplier block on the tax invoice. The GSTIN shown is the standard sample format value; replace it,
 * the address and the bank details with the registered ones before the first real invoice is issued.
 */
export const SUPPLIER = {
  name: LEGAL_ENTITY,
  brand: 'elan1 · Elan1 Govern',
  gstin: '29ABCDE1234F1Z5',
  stateCode: '29',
  state: 'Karnataka',
  address: 'Bengaluru, Karnataka, India',
  sac: '998315',
  sacLabel: 'Hosting and information technology infrastructure provisioning services',
};

/* ── Meter events ─────────────────────────────────────────── */

export type Via = 'allowed' | 'approved' | 'refused' | 'rejected' | 'expired' | 'pending';

export interface ChainEvent {
  seq: number;
  ts: string;
  t: number;
  month: string;
  agent?: string;
  tool?: string;
  decision: 'allow' | 'ask' | 'refuse';
  via: Via;
  outcome: 'committed' | 'refused' | 'pending';
  /** 1 committed · 0.4 refused · 0 pending */
  units: number;
  level: LevelId;
  resolvedSeq?: number;
  /** made with a sandbox key (sk_sbx_): metered at 0, never on an invoice line */
  sandbox?: boolean;
  /** a PLATFORM refusal (gate-error): our failure, metered at 0 and never billed */
  platform?: boolean;
}

export interface MonthUsage {
  month: string;
  allowed: number;
  approved: number;
  refused: number;
  expired: number;
  pending: number;
  units: number;
  events: number;
  /** sandbox calls (sk_sbx_) in the month, metered at 0 and not in the counts above */
  sandbox: number;
  firstSeq?: number;
  lastSeq?: number;
}

export interface ChainMeter {
  plan: (typeof PLANS)[PlanId];
  level: LevelId;
  events: ChainEvent[]; // oldest first
  months: MonthUsage[]; // oldest first
  days: { day: string; committed: number; refused: number; pending: number }[]; // last 30 IST days
  window: { from?: string; to?: string; firstSeq?: number; lastSeq?: number };
  fy: { label: string; start: string; committed: number; refused: number; units: number; included: number; remaining: number; share: number; coveredFrom?: string };
  totals: { events: number; committed: number; refused: number; pending: number; units: number; sandbox: number };
  digest: string;
}

function historyOf(d: OrgData) {
  return d.org.levelHistory?.length ? d.org.levelHistory : [{ level: d.org.plan as LevelId, from: d.org.createdAt }];
}

export function chainMeter(d: OrgData, now = Date.now()): ChainMeter {
  const history = historyOf(d);
  const resolution = new Map<number, Receipt>();
  for (const r of d.receipts) if (r.kind === 'approval' && r.ref_seq !== undefined) resolution.set(r.ref_seq, r);
  const events: ChainEvent[] = [];
  for (const r of d.receipts) {
    if (r.kind !== 'decision' || !r.decision) continue;
    const t = new Date(r.ts).getTime();
    let via: Via = r.decision === 'allow' ? 'allowed' : r.decision === 'refuse' ? 'refused' : 'pending';
    let resolvedSeq: number | undefined;
    if (r.decision === 'ask') {
      const res = resolution.get(r.seq);
      if (res) {
        resolvedSeq = res.seq;
        via = res.decision === 'allow' ? 'approved' : res.approval?.status === 'expired' ? 'expired' : 'rejected';
      }
    }
    const outcome: ChainEvent['outcome'] = via === 'allowed' || via === 'approved' ? 'committed' : via === 'pending' ? 'pending' : 'refused';
    const sandbox = r.environment === 'sandbox';
    // a PLATFORM refusal (gate-error) is our failure: recorded, never billed (lib/platformRefusal.ts)
    const platform = isPlatformRefusal(r);
    events.push({ seq: r.seq, ts: r.ts, t, month: monthOf(t), agent: r.agent, tool: r.tool, decision: r.decision, via, outcome, units: sandbox || platform ? 0 : outcome === 'committed' ? 1 : outcome === 'refused' ? REFUSAL_FACTOR : 0, level: levelAt(history, t, history[0].level), resolvedSeq, ...(sandbox ? { sandbox } : {}), ...(platform ? { platform } : {}) });
  }

  const byMonth = new Map<string, MonthUsage>();
  for (const e of events) {
    const m = byMonth.get(e.month) ?? { month: e.month, allowed: 0, approved: 0, refused: 0, expired: 0, pending: 0, units: 0, events: 0, sandbox: 0 };
    if (e.sandbox) { m.sandbox++; byMonth.set(e.month, m); continue; }
    m.events++;
    m.units += e.units;
    if (e.via === 'allowed') m.allowed++;
    else if (e.via === 'approved') m.approved++;
    else if (e.via === 'expired') m.expired++;
    else if (e.via === 'pending') m.pending++;
    else m.refused++;
    m.firstSeq = m.firstSeq === undefined ? e.seq : Math.min(m.firstSeq, e.seq);
    m.lastSeq = m.lastSeq === undefined ? e.seq : Math.max(m.lastSeq, e.seq);
    byMonth.set(e.month, m);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  // last 30 IST days
  const today = new Date(now + IST); today.setUTCHours(0, 0, 0, 0);
  const dayStart = today.getTime() - IST - 29 * D;
  const days = Array.from({ length: 30 }, (_, i) => ({ day: new Date(dayStart + i * D + IST).toISOString().slice(0, 10), committed: 0, refused: 0, pending: 0 }));
  const prod = events.filter((e) => !e.sandbox);
  for (const e of prod) {
    const i = Math.floor((e.t - dayStart) / D);
    if (i < 0 || i >= 30) continue;
    days[i][e.outcome]++;
  }

  const level = d.org.plan as LevelId;
  const plan = PLANS[level];
  const fyStart = fyStartOf(monthOf(now));
  const inFy = prod.filter((e) => e.month >= fyStart);
  const fyUnits = inFy.reduce((s, e) => s + e.units, 0);
  const committed = prod.filter((e) => e.outcome === 'committed').length;
  const refused = prod.filter((e) => e.outcome === 'refused' && !e.platform).length;
  const pending = prod.filter((e) => e.outcome === 'pending').length;
  const units = Math.round(events.reduce((s, e) => s + e.units, 0) * 10) / 10;
  return {
    plan, level, events, months, days,
    window: { from: d.receipts[0]?.ts, to: d.receipts[d.receipts.length - 1]?.ts, firstSeq: d.receipts[0]?.seq, lastSeq: d.receipts[d.receipts.length - 1]?.seq },
    fy: {
      label: fyLabel(monthOf(now)), start: fyStart,
      committed: inFy.filter((e) => e.outcome === 'committed').length,
      refused: inFy.filter((e) => e.outcome === 'refused' && !e.platform).length,
      units: Math.round(fyUnits * 10) / 10,
      included: plan.includedPerYear,
      remaining: Math.max(0, plan.includedPerYear - fyUnits),
      share: plan.includedPerYear ? Math.min(1, fyUnits / plan.includedPerYear) : 0,
      coveredFrom: d.receipts[0] && monthOf(new Date(d.receipts[0].ts).getTime()) > fyStart ? d.receipts[0].ts : undefined,
    },
    totals: { events: prod.length, committed, refused, pending, units, sandbox: events.length - prod.length },
    digest: sha256Hex(events.map((e) => `${e.seq}:${e.units}`).join('|')),
  };
}

/* ── Refusal cost (inside vs beyond the allowance) ────────── */

export interface RefusalCost {
  refused: number;
  inside: number;
  beyond: number;
  unitsInside: number;
  cost: number;
  atFullRate: number;
  months: string[];
  byLevel: { level: LevelId; refused: number; rate: number }[];
}

/**
 * What the refusals between `from` and `to` cost, using the meter's own order: within each fiscal year,
 * every event draws the allowance of the plan in force when it happened; once used up, a refusal is billed
 * at 40% of that plan's per-action rate. Sovereign includes no allowance.
 */
export function refusalCost(m: ChainMeter, from: number, to: number): RefusalCost {
  let fy = '';
  let used = 0;
  const out: RefusalCost = { refused: 0, inside: 0, beyond: 0, unitsInside: 0, cost: 0, atFullRate: 0, months: [], byLevel: [] };
  const lv = new Map<LevelId, number>();
  for (const e of m.events) {
    if (e.sandbox || e.platform) continue; // metered at 0 (sandbox calls; PLATFORM refusals are never billed)
    const f = fyStartOf(e.month);
    if (f !== fy) { fy = f; used = 0; }
    const plan = PLANS[e.level];
    const insideNow = used + e.units <= plan.includedPerYear;
    if (e.t >= from && e.t <= to && e.outcome === 'refused') {
      out.refused++;
      out.atFullRate += plan.overageRate;
      lv.set(e.level, (lv.get(e.level) ?? 0) + 1);
      if (insideNow) { out.inside++; out.unitsInside += e.units; } else { out.beyond++; out.cost += plan.refusalRate; }
      if (!out.months.includes(e.month)) out.months.push(e.month);
    }
    used += e.units;
  }
  out.byLevel = [...lv.entries()].map(([level, refused]) => ({ level, refused, rate: PLANS[level].refusalRate }));
  out.unitsInside = Math.round(out.unitsInside * 10) / 10;
  return out;
}

/* ── Invoices ─────────────────────────────────────────────── */

export type LineKind = 'floor' | 'inside' | 'refused_inside' | 'beyond' | 'refused_beyond' | 'pack' | 'seat' | 'profile' | 'exports' | 'deployment' | 'discount' | 'pilot' | 'sandbox' | 'credit';

export interface ChainLine extends InvoiceLine {
  id: string;
  kind: LineKind;
  level?: LevelId;
  fromSeq?: number;
  toSeq?: number;
  /** a dispute is open on this line: it is held and not payable until resolved */
  held?: { seq: number; by: string; reason: string; fromSeq?: number; toSeq?: number; at: string };
  /** a dispute on this line was settled by elan1 */
  settled?: { disputeSeq: number; seq: number; outcome: SettlementOutcome; credit: number; creditNote?: string; note: string; decidedBy: string; approvedBy?: string; at: string; reason: string };
  /** discount lines: the receipt that recorded it, and its end date */
  discount?: { seq: number; pct: number; until: string; agreedBy: 'lead' | 'founder' };
}

/** 'held': the period is not reconciled (meter and chain disagree), so the invoice is not issued. 'credit': a credit note. */
export type ChainInvoiceStatus = Invoice['status'] | 'held' | 'credit';

export interface ChainInvoice extends Omit<Invoice, 'status' | 'lines'> {
  status: ChainInvoiceStatus;
  number: string;
  kind: 'monthly' | 'deployment' | 'credit_note';
  lines: ChainLine[];
  /** credit notes: the invoice and line they credit */
  creditFor?: { invoice: string; line: string; lineLabel: string; outcome: SettlementOutcome; settlementSeq: number; disputeSeq: number };
  /** held invoices: the reconciliation run that holds it */
  heldBy?: { seq: number; meterEvents: number; chainDecisions: number; at: string };
  /** credit notes issued against this invoice */
  credits?: { number: string; amount: number }[];
  /** the pilot covers part or all of this month */
  pilot?: { from: string; to: string };
  periodStart: string;
  periodEnd: string;
  segments: { level: LevelId; from: string; to: string; days: number; pilot?: boolean }[];
  fromSeq?: number;
  toSeq?: number;
  events: number;
  partial?: string; // the chain this console holds starts inside the month
  heldAmount: number;
  payableNow: number;
  irn: string;
  dueAt?: string;
  placeOfSupply: string;
  customer: { name: string; residency: string };
}

export interface BillingContext {
  packs: { id: string; name: string; installedAt?: string }[];
  /** `seats` is the count now; the history comes from the seat-change receipts (seatSpans). `id` is optional for older callers. */
  counterparties: { id?: string; name: string; seats: number; since: string }[];
}

/** One stretch of time a counterparty held a number of seats. `seq` is the receipt that started it (a seat change). */
export interface SeatSpan { name: string; from: number; to: number; seats: number; seq?: number; before?: number }

/**
 * Each counterparty's seats over time, from the chain: it holds the seats it was added with from its `since` date,
 * and each counterparty.seats.changed receipt sets a new count from that moment. A change therefore never reaches
 * back into a month already billed: past invoices keep their amounts.
 */
export function seatSpans(d: OrgData, ctx: BillingContext): SeatSpan[] {
  const out: SeatSpan[] = [];
  const changes = d.receipts.filter((r) => r.action === 'counterparty.seats.changed' && r.details);
  for (const c of ctx.counterparties) {
    const since = new Date(c.since).getTime();
    const mine = changes.filter((r) => (r.details!.counterparty_id !== undefined && c.id !== undefined ? r.details!.counterparty_id === c.id : r.details!.counterparty === c.name) && new Date(r.ts).getTime() >= since);
    let from = since;
    let seats = mine.length ? Number(mine[0].details!.from) || c.seats : c.seats;
    let seq: number | undefined;
    let before: number | undefined;
    for (const r of mine) {
      const t = new Date(r.ts).getTime();
      if (t > from) out.push({ name: c.name, from, to: t, seats, seq, before });
      before = seats;
      seats = Number(r.details!.to) || seats;
      seq = r.seq;
      from = Math.max(from, t);
    }
    out.push({ name: c.name, from, to: Infinity, seats, seq, before });
  }
  return out;
}

/** Receipts written by the meter screen: add-on orders and disputes. */
export interface Dispute { seq: number; invoice: string; line: string; reason: string; fromSeq?: number; toSeq?: number; by: string; at: string; open: boolean; closedSeq?: number; settlement?: Settlement }

export function disputesOf(d: OrgData): Dispute[] {
  const out: Dispute[] = [];
  const settled = new Map(settlementsOf(d).map((s) => [s.dispute, s]));
  for (const r of d.receipts) {
    if (r.action === 'billing.dispute_opened') {
      const x = r.details ?? {};
      out.push({ seq: r.seq, invoice: String(x.invoice), line: String(x.line), reason: String(x.reason ?? ''), fromSeq: x.from_seq !== undefined ? Number(x.from_seq) : undefined, toSeq: x.to_seq !== undefined ? Number(x.to_seq) : undefined, by: r.actor ?? '', at: r.ts, open: true });
    } else if (closesDispute(r)) {
      // withdrawn by the owner, or decided by elan1's billing desk (a settlement written by anyone else does not count)
      const ds = out.find((x) => x.seq === Number(r.details?.dispute));
      if (ds && ds.open) { ds.open = false; ds.closedSeq = r.seq; ds.settlement = settled.get(ds.seq); }
    }
  }
  return out;
}

/** A verifier-profile order. `cancelledAt` keeps the order on every invoice up to and including the month it was cancelled in, billed to that month's end. */
export interface ProfileOrder { seq: number; profileId: string; at: string; by: string; active: boolean; cancelledAt?: string; cancelledSeq?: number; cause?: string }

export function profileOrders(d: OrgData): ProfileOrder[] {
  const out: ProfileOrder[] = [];
  for (const r of d.receipts) {
    if (r.action === 'billing.addon_ordered' && r.details?.addon === 'profile') out.push({ seq: r.seq, profileId: String(r.details.profile), at: r.ts, by: r.actor ?? '', active: true });
    if (r.action === 'billing.addon_cancelled' && r.details?.addon === 'profile') {
      out.filter((o) => o.active && o.profileId === String(r.details?.profile)).forEach((o) => { o.active = false; o.cancelledAt = r.ts; o.cancelledSeq = r.seq; if (r.details?.cause !== undefined) o.cause = String(r.details.cause); });
    }
  }
  return out;
}

/** Whether an order is billed in the month [start, end): ordered before the month ends and not cancelled before it began. */
const billedIn = (o: ProfileOrder, start: number, end: number) =>
  new Date(o.at).getTime() < end && (!o.cancelledAt || new Date(o.cancelledAt).getTime() >= start);

const fmtDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);

export function buildInvoices(d: OrgData, m: ChainMeter, ctx: BillingContext, now = Date.now()): ChainInvoice[] {
  const history = historyOf(d);
  const allDisputes = disputesOf(d);
  const disputes = allDisputes.filter((x) => x.open);
  const settled = allDisputes.filter((x) => x.settlement);
  const orders = profileOrders(d);
  const seatSpans_ = seatSpans(d, ctx);
  const discounts = discountsOf(d);
  const runs = latestRuns(d);
  const pilot = pilotOf(d, now);
  // the pilot is free from its start until it moves to the paid plan; a stopped or ended pilot is never billed
  const pilotFrom = pilot ? new Date(pilot.starts).getTime() : undefined;
  const pilotTo = pilot ? (pilot.convertedAt ? new Date(pilot.convertedAt).getTime() : Infinity) : undefined;
  // the pilot covers Guarded only: a segment at a higher level is never billed as the pilot
  const inPilot = (t: number) => pilotFrom !== undefined && pilotTo !== undefined && t >= pilotFrom && t < pilotTo && levelAt(history, t, history[0].level) === PILOT.listPlan;
  // nothing is billed before the organisation existed (a sign-up organisation's first month starts on its sign-up day)
  const orgFrom = d.org.createdAt ? new Date(d.org.createdAt).getTime() : -Infinity;
  const prefix = d.org.slug.split('-')[0].toUpperCase().slice(0, 4);
  const curMonth = monthOf(now);
  const first = d.receipts[0];
  if (!first) return [];
  const firstMonth = monthOf(new Date(first.ts).getTime());
  // the L1 auditor pack is free; each L2+ evidence bundle is ₹2,500 (decision 6f)
  const exportsByMonth = new Map<string, { count: number; bundles: number; fromSeq: number; toSeq: number }>();
  for (const r of d.receipts) {
    if (r.action !== 'evidence.exported') continue;
    const k = monthOf(new Date(r.ts).getTime());
    const x = exportsByMonth.get(k) ?? { count: 0, bundles: 0, fromSeq: r.seq, toSeq: r.seq };
    exportsByMonth.set(k, { count: x.count + 1, bundles: x.bundles + (r.details?.format === 'elan1.evidence.bundle.v1' ? 1 : 0), fromSeq: Math.min(x.fromSeq, r.seq), toSeq: Math.max(x.toSeq, r.seq) });
  }
  // packs run as a dry run below L2 and are billed only from the move to L2 (decision 5)
  const l2From = history.find((h) => levelRank(h.level) >= levelRank('l2'))?.from;
  // every period a pack was installed: the installs now, and each live removal (pack.uninstalled) with the install it ended
  const removals = d.receipts.filter((r) => r.action === 'pack.uninstalled' && r.details?.pack !== undefined).map((r) => ({
    id: String(r.details!.pack), name: String(r.details!.pack), installedAt: r.details!.installed_at !== undefined ? String(r.details!.installed_at) : undefined,
    removedAt: new Date(r.ts).getTime() as number | undefined, removedSeq: r.seq as number | undefined, billed: r.details!.billing !== 'never_billed',
  }));
  const periods = [...removals.filter((x) => x.billed), ...ctx.packs.map((p) => ({ ...p, removedAt: undefined, removedSeq: undefined, billed: true }))];
  // an install after an earlier removal of the same pack starts billing from the month after that removal (already billed to its end)
  const packPeriods = periods.map((p) => {
    const inst = p.installedAt ? new Date(p.installedAt).getTime() : 0;
    const prior = removals.filter((x) => x.id === p.id && x.removedSeq !== p.removedSeq && x.billed && (x.removedAt ?? Infinity) <= inst).map((x) => monthStart(nextMonth(monthOf(x.removedAt!))));
    return { ...p, billFrom: prior.length ? Math.max(...prior) : undefined };
  });

  const invoices: ChainInvoice[] = [];
  const creditNotes: ChainInvoice[] = [];
  // fiscal-year allowance drawn so far (from the chain this console holds)
  let fy = '';
  let used = 0;
  for (let ym = firstMonth; ym <= curMonth; ym = nextMonth(ym)) {
    if (fyStartOf(ym) !== fy) { fy = fyStartOf(ym); used = 0; }
    const start = monthStart(ym);
    const end = monthStart(nextMonth(ym));
    const daysInMonth = Math.round((end - start) / D);
    const share = (from: number, to = end) => Math.max(0, Math.min(1, (Math.min(end, to) - Math.max(start, from)) / (end - start)));
    const dayUnit = (f: number) => (f === 1 ? 'month' : `${Math.round(f * daysInMonth * 10) / 10} of ${daysInMonth} days`);
    // level segments inside the month, cut again where the pilot starts or ends
    const pilotCuts = [pilotFrom, pilotTo, orgFrom].filter((t): t is number => t !== undefined && Number.isFinite(t) && t > start && t < end);
    const cuts = [...new Set([start, ...history.map((h) => new Date(h.from).getTime()).filter((t) => t > start && t < end), ...pilotCuts, end])].sort((a, b) => a - b).filter((t) => t >= orgFrom || t === end);
    const segments: ChainInvoice['segments'] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const lvl = levelAt(history, cuts[i], history[0].level);
      segments.push({ level: lvl, from: new Date(cuts[i]).toISOString(), to: new Date(cuts[i + 1]).toISOString(), days: Math.round(((cuts[i + 1] - cuts[i]) / D) * 10) / 10, ...(inPilot(cuts[i]) ? { pilot: true } : {}) });
    }
    const lines: ChainLine[] = [];
    const allEvs = m.events.filter((e) => e.month === ym);
    const evs = allEvs.filter((e) => !e.sandbox); // sandbox calls (sk_sbx_) are metered at 0
    const levelsBilled = new Set(segments.filter((s) => !s.pilot).map((s) => s.level));
    for (const seg of segments) {
      const sFrom = new Date(seg.from).getTime();
      const sTo = new Date(seg.to).getTime();
      const se = evs.filter((e) => e.t >= sFrom && e.t < sTo);
      const fromSeq = se[0]?.seq;
      const toSeq = se[se.length - 1]?.seq;
      if (seg.pilot) {
        // the pilot names the list price it discounts
        const list = PLANS[PILOT.listPlan];
        lines.push({ id: `pilot-${seg.from.slice(0, 10)}`, kind: 'pilot', level: seg.level, label: `Pilot — free for ${PILOT.days} days, up to ${PILOT.cap.toLocaleString('en-IN')} governed actions (${seg.days} of ${daysInMonth} days)`, quantity: se.length, unit: 'actions', rate: 0, amount: 0, note: `Discounts the ${list.name} list price in full: ₹1,80,000 a year floor and ₹${list.overageRate.toFixed(2)} per action beyond ${list.includedPerYear.toLocaleString('en-IN')} a year`, fromSeq, toSeq });
        continue;
      }
      const plan = PLANS[seg.level];
      const usage = { month: ym, allowed: se.filter((e) => e.via === 'allowed').length, approved: se.filter((e) => e.via === 'approved').length, refused: se.filter((e) => (e.via === 'refused' || e.via === 'rejected') && !e.platform).length, expired: se.filter((e) => e.via === 'expired').length };
      const inv = monthlyInvoice(plan, usage, used);
      used += se.reduce((s, e) => s + e.units, 0);
      const kinds: LineKind[] = ['floor', 'inside', 'refused_inside', 'beyond', 'refused_beyond'];
      const tag = levelsBilled.size > 1 || segments.length > 1 && segments.some((s) => s.pilot) ? `${LEVEL_INFO[seg.level].short} · ` : '';
      inv.lines.forEach((l, i) => {
        const kind = kinds[i];
        if (kind === 'floor') {
          if (seg.level === 'sovereign') return; // billed as the yearly deployment licence
          const frac = seg.days / daysInMonth;
          const amount = Math.round((plan.floorPerYear / 12) * frac * 100) / 100;
          lines.push({ id: `${seg.level}-floor`, kind, level: seg.level, label: `${tag}${plan.name} platform floor (${plan.level})`, quantity: frac === 1 ? 1 : Math.round(frac * 1000) / 1000, unit: frac === 1 ? 'month' : `${seg.days} of ${daysInMonth} days`, rate: plan.floorPerYear / 12, amount });
          return;
        }
        if (seg.level === 'sovereign' && (kind === 'inside' || kind === 'refused_inside')) return;
        if (!l.quantity && !l.amount) return; // nothing to bill on this line
        lines.push({ ...l, id: `${seg.level}-${kind}`, kind, level: seg.level, label: `${tag}${l.label}`, fromSeq, toSeq });
      });
      // a discount applies only to governed actions beyond the allowance: never the floor, the meter basis, a refusal or the evidence line
      const over = inv.lines[3].quantity ?? 0;
      const committedEvs = se.filter((e) => e.outcome === 'committed');
      const overEvs = over > 0 ? committedEvs.slice(Math.max(0, committedEvs.length - over)) : [];
      for (const ds of discounts) {
        const dsFrom = new Date(`${ds.from}T00:00:00+05:30`).getTime();
        if (!(dsFrom < sTo && discountCovers(ds, Math.max(sFrom, dsFrom)))) continue;
        const qty = overEvs.filter((e) => discountCovers(ds, e.t)).length;
        const perAction = Math.round(plan.overageRate * ds.pct) / 100;
        const amount = -Math.round(qty * perAction * 100) / 100;
        lines.push({
          id: `${seg.level}-discount-${ds.seq}`, kind: 'discount', level: seg.level, label: `${tag}Discount ${ds.pct}% on governed actions beyond the allowance — until ${ds.until}`,
          quantity: qty, unit: 'actions', rate: -perAction, amount: amount === 0 ? 0 : amount,
          note: `Offered by ${ds.agreedName || (ds.agreedBy === 'founder' ? 'an elan1 founder' : 'an elan1 lead')}${ds.agreedTitle ? `, ${ds.agreedTitle}` : ''}${ds.reference && ds.reference !== '—' ? ` (${ds.reference})` : ''} in receipt #${ds.seq}${ds.acceptedSeq ? `, accepted in receipt #${ds.acceptedSeq}` : ''}. ${qty ? '' : 'No governed actions beyond the allowance in this period. '}The floor, refusals and the evidence line are never discounted.`,
          discount: { seq: ds.seq, pct: ds.pct, until: ds.until, agreedBy: ds.agreedBy }, fromSeq: overEvs[0]?.seq, toSeq: overEvs[overEvs.length - 1]?.seq,
        });
      }
    }
    // add-ons in force during the month, pro rata from the install or order day like the floor; one that stops (a pack
    // removed, a profile order cancelled) is billed to the end of the month it stopped in, and not from the next month
    for (const p of packPeriods) {
      if (!p.installedAt || !l2From) continue;
      const from = Math.max(new Date(p.installedAt).getTime(), new Date(l2From).getTime(), p.billFrom ?? 0);
      const stop = p.removedAt !== undefined ? monthStart(nextMonth(monthOf(p.removedAt))) : Infinity;
      if (from >= end || start >= stop || from >= stop) continue;
      const f = Math.round(share(from) * 1000) / 1000;
      const removedNote = p.removedAt !== undefined ? ` · removed in receipt #${p.removedSeq} on ${fmtDay(p.removedAt)}; billed to the end of that month, not from the next` : '';
      lines.push({ id: `pack-${p.id}${p.removedSeq !== undefined ? `-r${p.removedSeq}` : ''}`, kind: 'pack', label: `Regulatory pack — ${p.name}`, quantity: f, unit: dayUnit(f), rate: 135000 / 12, amount: Math.round(f * (135000 / 12) * 100) / 100, note: `₹1,35,000 per pack per year${f < 1 ? `, from ${fmtDay(Math.max(from, start))}` : ''}; its verifier profile is billed separately${removedNote}` });
    }
    // seats per month from the seat-change receipts, pro rata by day like packs and profiles: a change counts from the
    // moment it was recorded, so it never rewrites a month already invoiced
    const inMonth = seatSpans_.filter((s) => s.from < end && s.to > start && s.seats > 0);
    const seatMonths = inMonth.reduce((sum, s) => sum + s.seats * share(s.from, s.to), 0);
    if (seatMonths > 0) {
      const atEnd = inMonth.filter((s) => s.to >= end).reduce((sum, s) => sum + s.seats, 0);
      const whole = inMonth.every((s) => s.from <= start && s.to >= end);
      const q = Math.round(seatMonths * 1000) / 1000;
      const changed = inMonth.filter((s) => s.seq !== undefined && s.from >= start && s.from < end);
      const added = inMonth.filter((s) => s.seq === undefined && s.from > start);
      const why = [
        ...added.map((s) => `${s.name} added on ${fmtDay(s.from)} with ${s.seats}`),
        ...changed.map((s) => `${s.name} ${s.before ?? '?'} → ${s.seats} on ${fmtDay(s.from)} (receipt #${s.seq})`),
      ];
      lines.push({
        id: 'seats', kind: 'seat', label: `Counterparty verification seats (${atEnd || Math.round(seatMonths)})`, quantity: whole ? atEnd : q, unit: whole ? 'seats' : 'seat-months', rate: 45000 / 12,
        amount: Math.round(seatMonths * (45000 / 12) * 100) / 100,
        note: `₹45,000 per seat per year${whole ? '' : `, pro rata by day: ${why.join('; ')}`}`,
      });
    }
    for (const o of orders.filter((x) => billedIn(x, start, end))) {
      // a re-order of a profile cancelled earlier in the same month starts from the next month: that month is already billed
      const reFrom = Math.max(new Date(o.at).getTime(), ...orders.filter((x) => x !== o && x.profileId === o.profileId && x.cancelledAt && new Date(x.cancelledAt).getTime() <= new Date(o.at).getTime()).map((x) => monthStart(nextMonth(monthOf(new Date(x.cancelledAt!).getTime())))));
      const f = Math.round(share(reFrom) * 1000) / 1000;
      if (f <= 0) continue;
      lines.push({ id: `profile-${o.profileId}${orders.filter((x) => x.profileId === o.profileId && billedIn(x, start, end)).length > 1 ? `-${o.seq}` : ''}`, kind: 'profile', label: `Verifier profile — ${o.profileId}`, quantity: f, unit: dayUnit(f), rate: 300000 / 12, amount: Math.round(f * (300000 / 12) * 100) / 100, note: `₹3,00,000 per regime per year · ordered in receipt #${o.seq}${o.cancelledAt && new Date(o.cancelledAt).getTime() < end ? ` · cancelled in receipt #${o.cancelledSeq}${o.cause === 'profile_withdrawn' ? ' when the profile was withdrawn' : ''}; billed to the end of the month it was cancelled in, not from the next` : ''}` });
    }
    const ex = exportsByMonth.get(ym);
    if (ex?.bundles) lines.push({ id: 'bundles', kind: 'exports', label: `Evidence bundles (${ex.bundles})`, quantity: ex.bundles, unit: 'bundles', rate: 2500, amount: ex.bundles * 2500, note: '₹2,500 per L2+ evidence bundle — each export is itself a receipt', fromSeq: ex.fromSeq, toSeq: ex.toSeq });
    if (ex && ex.count > ex.bundles) lines.push({ id: 'exports', kind: 'exports', label: `L1 auditor packs (${ex.count - ex.bundles})`, quantity: ex.count - ex.bundles, unit: 'exports', rate: 0, amount: 0, note: 'Free — every export is itself a receipt', fromSeq: ex.fromSeq, toSeq: ex.toSeq });
    const sbx = allEvs.filter((e) => e.sandbox);
    if (sbx.length) lines.push({ id: 'sandbox', kind: 'sandbox', label: `Sandbox calls, sk_sbx_ keys (${sbx.length})`, quantity: sbx.length, unit: 'calls', rate: 0, amount: 0, note: 'Calls made with a sandbox key are metered at 0 and never billed', fromSeq: sbx[0].seq, toSeq: sbx[sbx.length - 1].seq });

    const number = `EG-${prefix}-${ym.replace('-', '')}`;
    for (const l of lines) {
      const ds = disputes.find((x) => x.invoice === number && x.line === l.id);
      if (ds) l.held = { seq: ds.seq, by: ds.by, reason: ds.reason, fromSeq: ds.fromSeq, toSeq: ds.toSeq, at: ds.at };
      const st = settled.find((x) => x.invoice === number && x.line === l.id);
      if (st?.settlement) l.settled = { disputeSeq: st.seq, seq: st.settlement.seq, outcome: st.settlement.outcome, credit: st.settlement.credit, creditNote: st.settlement.creditNote, note: st.settlement.note, decidedBy: st.settlement.decidedBy, approvedBy: st.settlement.approvedBy, at: st.settlement.at, reason: st.reason };
    }
    const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const held = lines.filter((l) => l.held).reduce((s, l) => s + l.amount, 0);
    const gst = Math.round(subtotal * GST_RATE * 100) / 100;
    const base: ChainInvoiceStatus = ym === curMonth ? 'draft' : nextMonth(ym) === curMonth ? 'due' : 'paid';
    // a period whose meter and chain disagree is never invoiced on either number: the invoice is held until it reconciles
    const run = runs.get(ym);
    const holdRun = run && !run.matched && base !== 'paid' ? run : undefined;
    const status: ChainInvoiceStatus = holdRun ? 'held' : base;
    const issued = end + 10 * H; // 10:00 UTC on the 1st, after the month closes
    const inv: ChainInvoice = {
      id: number, number, kind: 'monthly', period: ym, issuedAt: new Date(issued).toISOString(), status, lines, subtotal, gst, total: subtotal + gst,
      periodStart: new Date(start).toISOString(), periodEnd: new Date(Math.min(end, now)).toISOString(), segments,
      fromSeq: evs[0]?.seq, toSeq: evs[evs.length - 1]?.seq, events: evs.length,
      partial: ym === firstMonth && new Date(first.ts).getTime() > start + D ? first.ts : undefined,
      heldAmount: holdRun ? subtotal : held, payableNow: holdRun ? 0 : Math.round((subtotal - held) * (1 + GST_RATE) * 100) / 100,
      irn: irnFor(number, ym), dueAt: new Date(issued + 15 * D).toISOString(), placeOfSupply: placeOfSupply(d), customer: { name: d.org.name, residency: d.org.residency ?? 'ap-south-1 Mumbai' },
      ...(holdRun ? { heldBy: { seq: holdRun.seq, meterEvents: holdRun.meterEvents, chainDecisions: holdRun.chainDecisions, at: holdRun.at } } : {}),
      ...(segments.some((s) => s.pilot) ? { pilot: { from: segments.find((s) => s.pilot)!.from, to: [...segments].reverse().find((s) => s.pilot)!.to } } : {}),
    };
    invoices.push(inv);
    creditNotes.push(...creditNotesFor(inv));
  }

  // Sovereign: a yearly licence per deployment, invoiced in advance from go-live
  const sov = history.find((h) => h.level === 'sovereign');
  if (sov) {
    const goLive = new Date(sov.from).getTime();
    for (let k = 0; goLive + k * 365 * D <= now; k++) {
      const s = goLive + k * 365 * D;
      const e = s + 365 * D;
      const number = `EG-${prefix}-DEP-${fmtDay(s).slice(0, 4)}${k ? `-${k + 1}` : ''}`;
      const lines: ChainLine[] = [{ id: 'deployment', kind: 'deployment', level: 'sovereign', label: `Sovereign deployment licence — ${fmtDay(s)} to ${fmtDay(e - D)}`, quantity: 1, unit: 'deployment-year', rate: PLANS.sovereign.floorPerYear, amount: PLANS.sovereign.floorPerYear, note: 'Per deployment per year, in advance. Every governed action is metered monthly at ₹0.55; a refusal at ₹0.22.' }];
      const ds = disputes.find((x) => x.invoice === number && x.line === 'deployment');
      if (ds) lines[0].held = { seq: ds.seq, by: ds.by, reason: ds.reason, at: ds.at };
      const st = settled.find((x) => x.invoice === number && x.line === 'deployment');
      if (st?.settlement) lines[0].settled = { disputeSeq: st.seq, seq: st.settlement.seq, outcome: st.settlement.outcome, credit: st.settlement.credit, creditNote: st.settlement.creditNote, note: st.settlement.note, decidedBy: st.settlement.decidedBy, approvedBy: st.settlement.approvedBy, at: st.settlement.at, reason: st.reason };
      const subtotal = lines[0].amount;
      const held = lines[0].held ? subtotal : 0;
      const inv: ChainInvoice = {
        id: number, number, kind: 'deployment', period: monthOf(s), issuedAt: new Date(s).toISOString(), status: now - s > 30 * D ? 'paid' : 'due', lines, subtotal, gst: subtotal * GST_RATE, total: subtotal * (1 + GST_RATE),
        periodStart: new Date(s).toISOString(), periodEnd: new Date(e).toISOString(), segments: [{ level: 'sovereign', from: new Date(s).toISOString(), to: new Date(e).toISOString(), days: 365 }],
        events: 0, heldAmount: held, payableNow: (subtotal - held) * (1 + GST_RATE), irn: irnFor(number, monthOf(s)), dueAt: new Date(s + 30 * D).toISOString(), placeOfSupply: placeOfSupply(d), customer: { name: d.org.name, residency: d.org.residency ?? 'On premises' },
      };
      invoices.push(inv);
      creditNotes.push(...creditNotesFor(inv));
    }
  }
  return [...invoices, ...creditNotes].sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.kind.localeCompare(b.kind));
}

/** A credit note for every settled dispute on this invoice that credits money (upheld or partly upheld). */
function creditNotesFor(inv: ChainInvoice): ChainInvoice[] {
  const out: ChainInvoice[] = [];
  for (const l of inv.lines) {
    const st = l.settled;
    if (!st || !(st.credit > 0) || !st.creditNote) continue;
    const credit = Math.min(st.credit, Math.max(0, l.amount));
    inv.credits = [...(inv.credits ?? []), { number: st.creditNote, amount: credit }];
    const gst = -Math.round(credit * GST_RATE * 100) / 100;
    out.push({
      id: st.creditNote, number: st.creditNote, kind: 'credit_note', period: inv.period, issuedAt: st.at, status: 'credit',
      lines: [{ id: 'credit', kind: 'credit', level: l.level, label: `Credit against ${inv.number} — ${l.label}`, quantity: 1, unit: 'credit', rate: -credit, amount: -credit, note: `${st.outcome === 'upheld' ? 'Dispute upheld' : 'Dispute partly upheld'} by ${st.decidedBy}: ${st.note}` }],
      subtotal: -credit, gst, total: -credit + gst,
      creditFor: { invoice: inv.number, line: l.id, lineLabel: l.label, outcome: st.outcome, settlementSeq: st.seq, disputeSeq: st.disputeSeq },
      periodStart: inv.periodStart, periodEnd: inv.periodEnd, segments: [], events: 0, heldAmount: 0, payableNow: -credit + gst,
      irn: irnFor(st.creditNote, inv.period, 'CRN'), placeOfSupply: inv.placeOfSupply, customer: inv.customer,
    });
  }
  return out;
}

/** The IRN as the Invoice Registration Portal derives it: SHA-256 over supplier GSTIN, financial year, document type and number. */
export function irnFor(number: string, ym: string, docType: 'INV' | 'CRN' = 'INV') {
  return sha256Hex(`${SUPPLIER.gstin}${fyLabel(ym).replace('FY ', '').replace('–', '-')}${docType}${number}`);
}

function placeOfSupply(d: OrgData) {
  const r = (d.org.residency ?? '').toLowerCase();
  if (r.includes('bengaluru') || r.includes('karnataka')) return 'Karnataka (29)';
  if (r.includes('hyderabad')) return 'Telangana (36)';
  if (r.includes('chennai')) return 'Tamil Nadu (33)';
  return 'Maharashtra (27)';
}

/** Intra-state supplies carry CGST + SGST; inter-state carry IGST. */
export function taxSplit(inv: ChainInvoice) {
  const intra = inv.placeOfSupply.includes(`(${SUPPLIER.stateCode})`);
  return intra ? [{ label: 'CGST 9%', amount: inv.gst / 2 }, { label: 'SGST 9%', amount: inv.gst / 2 }] : [{ label: 'IGST 18%', amount: inv.gst }];
}

export const ADDON_PRICE = Object.fromEntries(ADD_ONS.map((a) => [a.id, a.price])) as Record<string, number>;

/**
 * Activity link for the records behind a line: the whole window (range=all) cut to the line's receipt range
 * (fs/ts, the first and last metered decision of the line's month or level segment), filtered by decision.
 */
export function linesHref(l: ChainLine) {
  const p = new URLSearchParams({ range: 'all' });
  if (l.kind === 'refused_inside' || l.kind === 'refused_beyond') p.set('d', 'refuse');
  else if (l.kind === 'inside' || l.kind === 'beyond' || l.kind === 'discount') p.set('d', 'allow');
  else if (l.kind === 'exports') p.set('q', 'evidence.exported');
  if (l.fromSeq !== undefined) p.set('fs', String(l.fromSeq));
  if (l.toSeq !== undefined) p.set('ts', String(l.toSeq));
  return `/activity?${p.toString()}`;
}
