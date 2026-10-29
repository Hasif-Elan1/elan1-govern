import { sha256 } from "./crypto";

/**
 * Billing as an internal ledger: the price book, the meter and the invoice arithmetic, ported from the approved
 * console (`apps/console/src/lib/pricing.ts`, `features/billing/chainMeter.ts`, `mock/billing.ts`).
 *
 * Every amount here is an integer number of paise, never a float of rupees. Allowance is counted in tenths of an
 * action, so a refusal's 0.4 is the integer 4 and a committed action is 10. Rounding is half up, to the paisa, at
 * the same points the console rounds (pro rata lines, GST, payable now); see DECISIONS for the two places where the
 * console's floating point disagrees with exact arithmetic.
 *
 * Nothing here reads a database or the clock: callers pass receipts, ledger rows and `now`.
 */

// ---- Price book ----

export type PlanId = "l1" | "l2" | "l3" | "sovereign";
export const PLAN_IDS: readonly PlanId[] = ["l1", "l2", "l3", "sovereign"];

export interface BillingPlan {
  id: PlanId;
  name: string;
  /** "L1", "L2", "L3" or "On-premises" */
  level: string;
  /** paise a year (Sovereign: the yearly deployment licence) */
  floorPerYear: number;
  /** governed actions included a year */
  includedPerYear: number;
  /** paise per governed action beyond the allowance */
  overage: number;
  /** paise per refused action beyond the allowance: 40% of `overage` */
  refusal: number;
}

/** A refused action costs 40% of the per-action rate; inside the allowance it uses 0.4 of an included action. */
export const REFUSAL_FACTOR = 0.4;
/** Tenths of an action: a committed action uses 10, a refusal 4. */
export const UNIT = 10;
export const REFUSAL_UNITS = 4;
export const GST_PERCENT = 18;

const plan = (id: PlanId, name: string, level: string, floorRupees: number, includedPerYear: number, overagePaise: number): BillingPlan => ({
  id,
  name,
  level,
  floorPerYear: floorRupees * 100,
  includedPerYear,
  overage: overagePaise,
  refusal: (overagePaise * REFUSAL_UNITS) / UNIT,
});

/** The price book (modelled list prices, flat to March 2029). */
export const BILLING_PLANS: Record<PlanId, BillingPlan> = {
  l1: plan("l1", "Guarded", "L1", 180_000, 480_000, 160),
  l2: plan("l2", "Attested", "L2", 600_000, 1_500_000, 120),
  l3: plan("l3", "Proven", "L3", 2_400_000, 4_200_000, 90),
  sovereign: plan("sovereign", "Sovereign", "On-premises", 12_000_000, 0, 55),
};

export const LEVEL_SHORT: Record<PlanId, string> = { l1: "L1", l2: "L2", l3: "L3", sovereign: "Sovereign" };
const LEVEL_RANK: Record<PlanId, number> = { l1: 0, l2: 1, l3: 2, sovereign: 3 };

/** Add-ons, in paise: packs, profiles and seats per year; bundles each. The L1 auditor pack is free. */
export const ADD_ON_PRICES = { pack: 13_500_000, profile: 30_000_000, bundle: 250_000, seat: 4_500_000 } as const;
/** The `details.format` of an L2+ evidence bundle export (billed); any other evidence export is a free L1 auditor pack. */
export const EVIDENCE_BUNDLE_FORMAT = "elan1.evidence.bundle.v1";

/**
 * The supplier block on every tax invoice. The GSTIN is the standard sample-format value the console uses; replace
 * it, the address and the bank details with the registered ones before the first real invoice is issued.
 */
export const SUPPLIER = {
  name: "ELAN1 AGENTIC TECHNOLOGIES PRIVATE LIMITED",
  brand: "elan1 · Elan1 Govern",
  gstin: "29ABCDE1234F1Z5",
  stateCode: "29",
  state: "Karnataka",
  address: "Bengaluru, Karnataka, India",
  sac: "998315",
  sacLabel: "Hosting and information technology infrastructure provisioning services",
} as const;

/** The pilot: free for 90 days and up to 2,000 governed actions at Guarded, then a hard stop, 30 read-only days, then closed. */
export const PILOT = { days: 90, cap: 2000, readOnlyDays: 30, listPlan: "l1" as PlanId, ruleId: "pilot-limit", code: "POLICY.TENANT_STOPPED" } as const;

/** An elan1 account lead may cut overage by up to 20% for up to 12 months; only a founder may go further. */
export const DISCOUNT_CAP = { leadPct: 20, leadMonths: 12 } as const;
/** A settlement credit above ₹1,00,000 needs a founder's approval as well as the billing desk's decision. */
export const SETTLEMENT_FOUNDER_ABOVE = 10_000_000;

// ---- Integer arithmetic ----

/** n / d rounded half up (as Math.round does, also for negative n), for d > 0. Exact for integers below 2^52. */
export function roundDiv(n: number, d: number): number {
  return Math.floor((2 * n + d) / (2 * d));
}

/** GST on a taxable value, rounded half up to the paisa (negative values round symmetrically, for credit notes). */
export function gstOn(paise: number): number {
  return paise < 0 ? neg(gstOn(-paise)) : roundDiv(paise * GST_PERCENT, 100);
}

/** -x without a negative zero. */
const neg = (x: number) => (x === 0 ? 0 : -x);

/** Intra-state supplies carry CGST + SGST (the odd paisa goes to SGST); inter-state carry IGST. */
export function taxSplit(gst: number, placeOfSupply: string): { label: string; amount: number }[] {
  if (!placeOfSupply.includes(`(${SUPPLIER.stateCode})`)) return [{ label: "IGST 18%", amount: gst }];
  const cgst = gst < 0 ? neg(Math.floor(-gst / 2)) : Math.floor(gst / 2);
  return [
    { label: "CGST 9%", amount: cgst },
    { label: "SGST 9%", amount: gst - cgst },
  ];
}

/** ₹1,23,456.78 in Indian grouping, from paise. */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = new Intl.NumberFormat("en-IN").format(Math.floor(abs / 100));
  return `${sign}₹${rupees}.${String(abs % 100).padStart(2, "0")}`;
}

// ---- India time ----

const H = 3_600_000;
const D = 24 * H;
const IST = 5.5 * H;

/** "YYYY-MM" of an instant, in IST. */
export const monthOf = (t: number) => new Date(t + IST).toISOString().slice(0, 7);
/** "YYYY-MM-DD" of an instant, in IST. */
export const dayOf = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
/** IST midnight of the first day of a "YYYY-MM" month. */
export function monthStart(ym: string): number {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return Date.UTC(y, m - 1, 1) - IST;
}
/** IST midnight of a "YYYY-MM-DD" day. */
export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - IST;
}
export function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
/** First month of the Indian fiscal year (April to March) containing `ym`. */
export function fyStartOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-04`;
}
export function fyLabel(ym: string): string {
  const s = Number(fyStartOf(ym).slice(0, 4));
  return `FY ${s}–${String(s + 1).slice(2)}`;
}
const ms = (iso: string | undefined) => (iso === undefined ? NaN : Date.parse(iso));

// ---- Levels over time ----

export interface LevelPeriod {
  level: PlanId;
  from: string;
}

/** The level in force at a moment, from the organisation's level history. */
export function levelAt(history: readonly LevelPeriod[] | undefined, t: number, fallback: PlanId = "l1"): PlanId {
  if (!history?.length) return fallback;
  let lv = history[0]!.level;
  for (const p of history) if (ms(p.from) <= t) lv = p.level;
  if (ms(history[0]!.from) > t) return "l1";
  return lv;
}

// ---- The meter: one event per decision receipt ----

/** The receipt fields the meter reads. Our chain's receipts fit it; so do the console's. */
export interface MeterReceipt {
  seq: number;
  ts: string;
  kind: string;
  agent?: string;
  tool?: string;
  decision?: string;
  rule_id?: string;
  /** our chain: `result`; the console's: `status` with `decision: "allow"` for approved */
  approval?: { result?: string; status?: string };
  ref_seq?: number;
  action?: string;
  details?: Record<string, unknown>;
  /** "sandbox" for calls made with a sandbox key (sk_sbx_): metered at 0 */
  environment?: string;
}

export type Via = "allowed" | "approved" | "refused" | "rejected" | "expired" | "pending";

export interface MeterEvent {
  seq: number;
  t: number;
  month: string;
  decision: string;
  via: Via;
  outcome: "committed" | "refused" | "pending";
  /** tenths of an action: 10 committed, 4 refused, 0 pending, sandbox or platform */
  tenths: number;
  resolvedSeq?: number;
  sandbox?: boolean;
  platform?: boolean;
}

/** System rule ids of PLATFORM refusals: our failure, recorded but never billed. */
export const PLATFORM_RULE_IDS: readonly string[] = ["gate-error"];

export function isPlatformRefusal(r: Pick<MeterReceipt, "decision" | "rule_id" | "details">): boolean {
  if (r.decision !== "refuse") return false;
  const rule = r.rule_id ?? "";
  if (PLATFORM_RULE_IDS.includes(rule) || rule.startsWith("PLATFORM.")) return true;
  const code = r.details?.code;
  return typeof code === "string" && code.startsWith("PLATFORM.");
}

/**
 * A refusal at the pilot's hard stop. The console writes no record for these; we write the normal refusal receipt,
 * so the meter leaves them out entirely: they are not governed actions and never count towards anything.
 */
export const isPilotStop = (r: Pick<MeterReceipt, "kind" | "rule_id">) => r.kind === "decision" && r.rule_id === PILOT.ruleId;

function resolutionVia(r: MeterReceipt): Via | undefined {
  const result = r.approval?.result;
  if (result === "pending") return undefined;
  if (result === "approved" || r.decision === "allow") return "approved";
  return result === "expired" || r.approval?.status === "expired" ? "expired" : "rejected";
}

/** Every decision on the chain as a meter event, oldest first. */
export function meterEvents(receipts: readonly MeterReceipt[]): MeterEvent[] {
  const resolution = new Map<number, MeterReceipt>();
  for (const r of receipts) if (r.kind === "approval" && r.ref_seq !== undefined && resolutionVia(r)) resolution.set(r.ref_seq, r);
  const out: MeterEvent[] = [];
  for (const r of receipts) {
    if (r.kind !== "decision" || !r.decision || isPilotStop(r)) continue;
    const t = ms(r.ts);
    let via: Via = r.decision === "allow" ? "allowed" : r.decision === "refuse" ? "refused" : "pending";
    let resolvedSeq: number | undefined;
    const res = r.decision === "ask" ? resolution.get(r.seq) : undefined;
    if (res) {
      resolvedSeq = res.seq;
      via = resolutionVia(res)!;
    }
    const outcome: MeterEvent["outcome"] = via === "allowed" || via === "approved" ? "committed" : via === "pending" ? "pending" : "refused";
    const sandbox = r.environment === "sandbox";
    const platform = isPlatformRefusal(r);
    const tenths = sandbox || platform ? 0 : outcome === "committed" ? UNIT : outcome === "refused" ? REFUSAL_UNITS : 0;
    out.push({ seq: r.seq, t, month: monthOf(t), decision: r.decision, via, outcome, tenths, ...(resolvedSeq !== undefined ? { resolvedSeq } : {}), ...(sandbox ? { sandbox } : {}), ...(platform ? { platform } : {}) });
  }
  return out;
}

/** What one month (or range) used. `refused` counts refused and rejected, platform refusals included (as the console shows them). */
export interface MonthUsage {
  month: string;
  allowed: number;
  approved: number;
  refused: number;
  expired: number;
  pending: number;
  /** platform refusals (gate-error): in `refused` and `events`, metered at 0 */
  platform: number;
  /** tenths of an action drawn from the allowance */
  tenths: number;
  events: number;
  /** sandbox calls, metered at 0 and not in the counts above */
  sandbox: number;
  firstSeq?: number;
  lastSeq?: number;
}

/** The counts an invoice bills: platform refusals left out. */
export interface BillableUsage {
  allowed: number;
  approved: number;
  refused: number;
  expired: number;
}

export function usageOf(events: readonly MeterEvent[], month: string): MonthUsage {
  const m: MonthUsage = { month, allowed: 0, approved: 0, refused: 0, expired: 0, pending: 0, platform: 0, tenths: 0, events: 0, sandbox: 0 };
  for (const e of events) {
    if (e.sandbox) {
      m.sandbox++;
      continue;
    }
    m.events++;
    m.tenths += e.tenths;
    if (e.platform) m.platform++;
    if (e.via === "allowed") m.allowed++;
    else if (e.via === "approved") m.approved++;
    else if (e.via === "expired") m.expired++;
    else if (e.via === "pending") m.pending++;
    else m.refused++;
    m.firstSeq = m.firstSeq === undefined ? e.seq : Math.min(m.firstSeq, e.seq);
    m.lastSeq = m.lastSeq === undefined ? e.seq : Math.max(m.lastSeq, e.seq);
  }
  return m;
}

export function billable(events: readonly MeterEvent[]): BillableUsage {
  const prod = events.filter((e) => !e.sandbox);
  return {
    allowed: prod.filter((e) => e.via === "allowed").length,
    approved: prod.filter((e) => e.via === "approved").length,
    refused: prod.filter((e) => (e.via === "refused" || e.via === "rejected") && !e.platform).length,
    expired: prod.filter((e) => e.via === "expired").length,
  };
}

export interface PeriodMeter extends MonthUsage {
  plan: PlanId;
  billable: BillableUsage;
}

/**
 * The meter for one IST month ("YYYY-MM") or a range [from, to) of epoch ms, counted from the chain the way the
 * console's chain meter does. Approvals resolved later still count in the month of the decision.
 */
export function meterFromReceipts(receipts: readonly MeterReceipt[], period: string | { from: number; to: number }, p: BillingPlan): PeriodMeter {
  const all = meterEvents(receipts);
  const label = typeof period === "string" ? period : monthOf(period.from);
  const evs = typeof period === "string" ? all.filter((e) => e.month === period) : all.filter((e) => e.t >= period.from && e.t < period.to);
  return { ...usageOf(evs, label), plan: p.id, billable: billable(evs) };
}

// ---- The price book's monthly arithmetic ----

export type LineKind =
  | "floor"
  | "inside"
  | "refused_inside"
  | "beyond"
  | "refused_beyond"
  | "pack"
  | "seat"
  | "profile"
  | "exports"
  | "deployment"
  | "discount"
  | "pilot"
  | "sandbox"
  | "credit";

export interface InvoiceLine {
  id: string;
  kind: LineKind;
  label: string;
  quantity: number;
  unit: string;
  /** paise per unit */
  rate: number;
  /** paise */
  amount: number;
  note?: string;
  level?: PlanId;
  fromSeq?: number;
  toSeq?: number;
  /** an open dispute holds this line: not payable until it is resolved */
  held?: { seq: number; by: string; reason: string; at: string };
  /** elan1 settled a dispute on this line */
  settled?: { disputeSeq: number; seq: number; outcome: SettlementOutcome; credit: number; creditNote?: string; at: string };
  discount?: { seq: number; pct: number; until: string };
}

export interface PriceBookInvoice {
  lines: InvoiceLine[];
  subtotal: number;
  gst: number;
  total: number;
}

/**
 * One month at one plan: the floor, then committed actions drawing the allowance first and refusals at 0.4 each,
 * then everything beyond the allowance at the per-action rate (a refusal at 40% of it). `usedBefore` is the
 * allowance already drawn this fiscal year, in tenths of an action.
 */
export function monthlyInvoice(p: BillingPlan, usage: BillableUsage, usedBefore: number, extras: InvoiceLine[] = []): PriceBookInvoice {
  const floorMonthly = p.floorPerYear / 12;
  const committed = usage.allowed + usage.approved;
  const refusals = usage.refused + usage.expired;
  const remaining = Math.max(0, p.includedPerYear * UNIT - usedBefore);
  const insideTenths = Math.min(committed * UNIT, remaining);
  const overTenths = committed * UNIT - insideTenths;
  const refusalsInside = Math.min(refusals, Math.floor((remaining - insideTenths) / REFUSAL_UNITS));
  const refusalsOver = refusals - refusalsInside;
  const lines: InvoiceLine[] = [
    { id: "floor", kind: "floor", label: `${p.name} platform floor (${p.level})`, quantity: 1, unit: "month", rate: floorMonthly, amount: floorMonthly },
    { id: "inside", kind: "inside", label: "Governed actions inside allowance", quantity: insideTenths / UNIT, unit: "actions", rate: 0, amount: 0, note: "Included" },
    { id: "refused_inside", kind: "refused_inside", label: "Refused actions inside allowance", quantity: refusalsInside, unit: "refusals", rate: 0, amount: 0, note: `Uses ${REFUSAL_FACTOR} of an included action each` },
    { id: "beyond", kind: "beyond", label: "Governed actions beyond allowance", quantity: overTenths / UNIT, unit: "actions", rate: p.overage, amount: roundDiv(overTenths * p.overage, UNIT) },
    { id: "refused_beyond", kind: "refused_beyond", label: "Refused actions beyond allowance", quantity: refusalsOver, unit: "refusals", rate: p.refusal, amount: refusalsOver * p.refusal, note: "40% of the per-action rate" },
    ...extras,
  ];
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const gst = gstOn(subtotal);
  return { lines, subtotal, gst, total: subtotal + gst };
}

// ---- Discounts ----

/** An accepted discount on governed actions beyond the allowance. Days are IST, inclusive. */
export interface AcceptedDiscount {
  seq: number;
  pct: number;
  from: string;
  until: string;
  endedAt?: string;
  agreedBy?: "lead" | "founder";
}

/** The first instant after a discount: the end of its last day, or the moment it was ended early. */
export function discountEnd(ds: Pick<AcceptedDiscount, "until" | "endedAt">): number {
  const last = dayStart(ds.until) + D;
  return ds.endedAt ? Math.min(last, ms(ds.endedAt)) : last;
}
export const discountCovers = (ds: AcceptedDiscount, t: number) => t >= dayStart(ds.from) && t < discountEnd(ds);
export function discountState(ds: AcceptedDiscount, now: number): "scheduled" | "active" | "ended" {
  if (now < dayStart(ds.from)) return "scheduled";
  return now < discountEnd(ds) ? "active" : "ended";
}
/** Paise off each governed action beyond the allowance. */
export const discountPerAction = (p: BillingPlan, pct: number) => Math.round((p.overage * pct) / 100);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const monthsBetween = (from: string, until: string) => {
  const [y1, m1, d1] = from.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = until.split("-").map(Number) as [number, number, number];
  return (y2 - y1) * 12 + (m2 - m1) + (d2 + 1 - d1) / 31;
};

/** Why an offer breaks the rules, or undefined: every discount has an end date, and a lead is held to 20% for 12 months. */
export function checkDiscount(input: { pct: number; from: string; until: string; agreedBy: "lead" | "founder" }): string | undefined {
  if (!(input.pct > 0) || input.pct >= 100) return "Enter a percentage above 0 and below 100.";
  if (!DAY_RE.test(input.from) || !DAY_RE.test(input.until)) return "Enter a start date and an end date. Every discount has an end date.";
  if (input.until < input.from) return "The end date is before the start date.";
  if (input.agreedBy === "lead") {
    if (input.pct > DISCOUNT_CAP.leadPct) return `An elan1 lead may discount overage by up to ${DISCOUNT_CAP.leadPct}%. A larger discount needs a founder.`;
    if (monthsBetween(input.from, input.until) > DISCOUNT_CAP.leadMonths + 0.01) return `An elan1 lead may agree a discount for up to ${DISCOUNT_CAP.leadMonths} months. A longer one needs a founder.`;
  }
  return undefined;
}

/** An accepted offer applies from the later of its start and the day it was accepted. */
export const acceptedFrom = (offerFrom: string, acceptedAt: number) => {
  const day = dayOf(acceptedAt);
  return day > offerFrom ? day : offerFrom;
};

/** true when two discounts share a day (accepting one over another is refused). */
export const discountsOverlap = (a: Pick<AcceptedDiscount, "from" | "until">, b: Pick<AcceptedDiscount, "from" | "until">) => !(a.until < b.from || a.from > b.until);

/** A customer's request for a discount: who must decide it, or why it is refused. */
export function checkDiscountRequest(input: { pct: number; months: number; reason: string }): { ok: true; needs: "lead" | "founder" } | { ok: false; error: string } {
  if (!(input.pct > 0) || input.pct >= 100) return { ok: false, error: "Ask for a percentage above 0 and below 100." };
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 36) return { ok: false, error: "Ask for a whole number of months, 1 to 36. Every discount has an end date." };
  if (input.reason.trim().length < 10) return { ok: false, error: "Say why in at least 10 characters (expected volume, a competing quote, a renewal)." };
  return { ok: true, needs: input.pct > DISCOUNT_CAP.leadPct || input.months > DISCOUNT_CAP.leadMonths ? "founder" : "lead" };
}

// ---- Disputes, settlements and credit notes ----

export type SettlementOutcome = "upheld" | "partly_upheld" | "rejected";

export interface DisputeRecord {
  seq: number;
  invoice: string;
  line: string;
  reason: string;
  by: string;
  at: string;
  open: boolean;
  settlement?: { seq: number; outcome: SettlementOutcome; credit: number; creditNote?: string; at: string };
}

export const creditNoteNumber = (invoice: string, disputeSeq: number) => `CN-${invoice.replace(/^EG-/, "")}-${disputeSeq}`;

/**
 * The credit a settlement gives, from the disputed line's amount less what earlier settlements on it already
 * credited: upheld credits all of what is left, rejected nothing, partly upheld more than 0 and less than that.
 * A credit above ₹1,00,000 decided by anyone but a founder also needs a founder's approval.
 */
export function settlementCredit(input: {
  outcome: SettlementOutcome;
  requested: number;
  lineAmount: number | undefined;
  alreadyCredited: number;
  decidedBy: "billing" | "founder";
  founderApproved?: boolean;
}): { ok: true; credit: number; needsFounder: boolean } | { ok: false; error: string } {
  if (input.lineAmount === undefined && input.outcome !== "rejected") return { ok: false, error: "That line is not on the invoice, so there is no amount to credit against." };
  const cap = Math.max(0, (input.lineAmount ?? 0) - input.alreadyCredited);
  if (input.outcome !== "rejected" && !(cap > 0)) return { ok: false, error: "This line has already been credited in full by an earlier settlement." };
  const credit = input.outcome === "upheld" ? cap : input.outcome === "rejected" ? 0 : Math.round(input.requested);
  if (input.outcome === "partly_upheld" && !(credit > 0 && credit < cap)) return { ok: false, error: `A partly upheld dispute credits more than ₹0 and less than the line (${formatPaise(cap)}).` };
  const needsFounder = credit > SETTLEMENT_FOUNDER_ABOVE && input.decidedBy !== "founder";
  if (needsFounder && !input.founderApproved) return { ok: false, error: `A credit above ${formatPaise(SETTLEMENT_FOUNDER_ABOVE)} needs a founder's approval as well.` };
  return { ok: true, credit, needsFounder };
}

// ---- Reconciliation ----

export interface ReconRun {
  seq?: number;
  period: string;
  meterEvents: number;
  chainDecisions: number;
  matched: boolean;
  at: string;
}

/** Decisions on the chain in a period and the allowance they draw (tenths): the chain side of a two-way run. */
export function chainCount(receipts: readonly MeterReceipt[], period: string): { decisions: number; tenths: number } {
  const evs = meterEvents(receipts).filter((e) => e.month === period);
  return { decisions: evs.length, tenths: evs.reduce((s, e) => s + e.tenths, 0) };
}

/** The latest run per period (runs oldest first). A period whose latest run did not match holds its invoice. */
export function latestRuns(runs: readonly ReconRun[]): Map<string, ReconRun> {
  const out = new Map<string, ReconRun>();
  for (const r of runs) out.set(r.period, r);
  return out;
}

// ---- Pilot ----

export interface PilotRecord {
  starts: string;
  ends?: string;
  cap?: number;
  /** recorded once the stop is due (cap reached, 90 days ended, or ended early by an owner) */
  stoppedAt?: string;
  stoppedWhy?: string;
  /** a count recorded with the stop or the conversion; the meter never shows fewer */
  recordedUsed?: number;
  convertedAt?: string;
  closedAt?: string;
}

export type PilotStatus = "active" | "stopped" | "ended" | "converted" | "closed";

export interface PilotState {
  status: PilotStatus;
  starts: string;
  ends: string;
  cap: number;
  used: number;
  remaining: number;
  daysLeft: number;
  stoppedAt?: string;
  stoppedWhy?: string;
  readOnlyUntil?: string;
  closedAt?: string;
  convertedAt?: string;
}

/** Production governed actions while the pilot ran, and the moment the cap was reached (just after the cap-th). */
export function pilotUsage(receipts: readonly MeterReceipt[], p: Pick<PilotRecord, "starts" | "convertedAt" | "cap">): { used: number; capAt?: number } {
  const t0 = ms(p.starts);
  const until = p.convertedAt ? ms(p.convertedAt) : Infinity;
  const cap = p.cap ?? PILOT.cap;
  const counted = meterEvents(receipts).filter((e) => !e.sandbox && !e.platform && e.t >= t0 && e.t < until);
  return { used: counted.length, ...(counted.length >= cap ? { capAt: counted[cap - 1]!.t + 1 } : {}) };
}

/**
 * Where the pilot stands: active, then stopped (cap reached or ended early) or ended (90 days), read-only for 30
 * days, then closed. Moving to the paid plan (converted) lifts a stop at any point before closure.
 */
export function pilotState(p: PilotRecord, usage: { used: number; capAt?: number }, now: number): PilotState {
  const starts = p.starts;
  const ends = p.ends ?? new Date(ms(starts) + PILOT.days * D).toISOString();
  const cap = p.cap ?? PILOT.cap;
  const endT = ms(ends);
  const used = Math.max(usage.used, p.recordedUsed ?? 0);
  const capT = usage.capAt !== undefined && usage.capAt < endT ? usage.capAt : undefined;
  const stopT = p.stoppedAt ? ms(p.stoppedAt) : capT ?? (now >= endT ? endT : undefined);
  const why = p.stoppedAt ? (p.stoppedWhy ?? "") : capT !== undefined ? `${cap} governed actions used` : stopT !== undefined ? `${PILOT.days} days ended` : undefined;
  const readOnlyUntilT = stopT !== undefined ? stopT + PILOT.readOnlyDays * D : undefined;
  const status: PilotStatus = p.convertedAt
    ? "converted"
    : p.closedAt || (readOnlyUntilT !== undefined && now >= readOnlyUntilT)
      ? "closed"
      : stopT !== undefined
        ? why?.includes("days ended")
          ? "ended"
          : "stopped"
        : "active";
  return {
    status,
    starts,
    ends,
    cap,
    used,
    remaining: Math.max(0, cap - used),
    daysLeft: Math.max(0, Math.ceil((endT - now) / D)),
    ...(stopT !== undefined ? { stoppedAt: new Date(stopT).toISOString(), stoppedWhy: why } : {}),
    ...(readOnlyUntilT !== undefined && !p.convertedAt ? { readOnlyUntil: new Date(readOnlyUntilT).toISOString() } : {}),
    ...(p.closedAt ? { closedAt: p.closedAt } : status === "closed" ? { closedAt: new Date(readOnlyUntilT!).toISOString() } : {}),
    ...(p.convertedAt ? { convertedAt: p.convertedAt } : {}),
  };
}

/** true while the pilot holds the organisation: no production call runs and it is read-only. */
export const pilotPaused = (s: PilotState | undefined) => !!s && (s.status === "stopped" || s.status === "ended" || s.status === "closed");

/** The plain reason on a call refused at the pilot's stop. */
export function pilotRefusalReason(s: PilotState): string {
  if (s.status === "closed") return "The organisation is closed: its free pilot stopped and the 30 read-only days have passed. No call runs. Ask elan1 to reopen it on a paid plan.";
  const why = s.stoppedWhy?.startsWith("ended early") ? "was ended early by an owner" : s.status === "ended" ? `ended after ${PILOT.days} days` : `has used its ${s.cap.toLocaleString("en-IN")} governed actions`;
  return `The free pilot ${why}, so every action is refused. An owner moves to the paid plan on the Meter page to resume.`;
}

/** Why an owner's pilot action is refused, or undefined when it may go ahead. */
export function pilotActionError(s: PilotState | undefined, action: "convert" | "end_early" | "request_reopen"): string | undefined {
  if (!s) return "This organisation is not on a pilot.";
  if (action === "end_early") return s.status === "active" ? undefined : "There is no running pilot to end.";
  if (action === "request_reopen") return s.status === "closed" ? undefined : "Only a closed organisation is reopened.";
  if (s.status === "converted") return "The pilot has already moved to the paid plan.";
  if (s.status === "closed") return "The organisation is closed: its 30 read-only days have passed. Ask elan1 to reopen it.";
  return undefined;
}

// ---- Seats, packs, profiles ----

export interface SeatHolder {
  id?: string;
  name: string;
  seats: number;
  since: string;
}

/** One stretch of time a counterparty held a number of seats; `seq` is the seat-change receipt that started it. */
export interface SeatSpan {
  name: string;
  from: number;
  to: number;
  seats: number;
  seq?: number;
  before?: number;
}

/**
 * Each counterparty's seats over time from the chain: the seats it was added with from `since`, then each
 * counterparty.seats.changed receipt sets a new count from that moment. A change never reaches back into a month
 * already billed, so past invoices keep their amounts.
 */
export function seatSpans(receipts: readonly MeterReceipt[], counterparties: readonly SeatHolder[]): SeatSpan[] {
  const out: SeatSpan[] = [];
  const changes = receipts.filter((r) => r.action === "counterparty.seats.changed" && r.details);
  for (const c of counterparties) {
    const since = ms(c.since);
    const mine = changes.filter((r) => (r.details!.counterparty_id !== undefined && c.id !== undefined ? r.details!.counterparty_id === c.id : r.details!.counterparty === c.name) && ms(r.ts) >= since);
    let from = since;
    let seats = mine.length ? Number(mine[0]!.details!.from) || c.seats : c.seats;
    let seq: number | undefined;
    let before: number | undefined;
    for (const r of mine) {
      const t = ms(r.ts);
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

/** A verifier-profile order; one cancelled is billed to the end of the month it was cancelled in. */
export interface ProfileOrder {
  seq: number;
  profileId: string;
  at: string;
  cancelledAt?: string;
}

export function profileOrders(receipts: readonly MeterReceipt[]): ProfileOrder[] {
  const out: (ProfileOrder & { active: boolean })[] = [];
  for (const r of receipts) {
    if (r.action === "billing.addon_ordered" && r.details?.addon === "profile") out.push({ seq: r.seq, profileId: String(r.details.profile), at: r.ts, active: true });
    if (r.action === "billing.addon_cancelled" && r.details?.addon === "profile") {
      for (const o of out.filter((x) => x.active && x.profileId === String(r.details?.profile))) {
        o.active = false;
        o.cancelledAt = r.ts;
      }
    }
  }
  return out.map(({ active: _active, ...o }) => o);
}

export interface PackInstall {
  id: string;
  name: string;
  installedAt?: string;
}

// ---- Invoices ----

export type InvoiceStatus = "draft" | "issued" | "held";

export interface ComputedInvoice {
  number: string;
  kind: "monthly" | "deployment" | "credit_note";
  period: string;
  /** draft: the month is open; issued: closed and billable; held: the period is not reconciled */
  status: InvoiceStatus;
  issuedAt: string;
  dueAt?: string;
  periodStart: string;
  periodEnd: string;
  lines: InvoiceLine[];
  subtotal: number;
  gst: number;
  total: number;
  heldAmount: number;
  payableNow: number;
  irn: string;
  placeOfSupply: string;
  customer: { name: string };
  segments: { level: PlanId; from: string; to: string; days: number; pilot?: boolean }[];
  fromSeq?: number;
  toSeq?: number;
  events: number;
  /** the chain starts inside this month */
  partial?: string;
  heldBy?: { seq?: number; meterEvents: number; chainDecisions: number; at: string };
  pilot?: { from: string; to: string };
  credits?: { number: string; amount: number }[];
  creditFor?: { invoice: string; line: string; outcome: SettlementOutcome; settlementSeq: number; disputeSeq: number };
}

export interface BillingInput {
  org: { prefix: string; name: string; level: PlanId; createdAt?: string; residency?: string };
  levelHistory?: LevelPeriod[];
  /** the organisation's chain, oldest first */
  receipts: readonly MeterReceipt[];
  pilot?: { starts: string; convertedAt?: string };
  discounts?: readonly AcceptedDiscount[];
  disputes?: readonly DisputeRecord[];
  reconciliation?: readonly ReconRun[];
  packs?: readonly PackInstall[];
  counterparties?: readonly SeatHolder[];
  now: number;
}

/** "EG-" plus up to four letters from the organisation's slug or name. */
export function invoicePrefix(slugOrName: string): string {
  return (slugOrName.split(/[-\s]/)[0] ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 4) || "ORG";
}

/** The IRN as the Invoice Registration Portal derives it: SHA-256 over supplier GSTIN, financial year, document type and number. */
export function irnFor(number: string, ym: string, docType: "INV" | "CRN" = "INV"): string {
  return sha256(`${SUPPLIER.gstin}${fyLabel(ym).replace("FY ", "").replace("–", "-")}${docType}${number}`).slice("sha256:".length);
}

export function placeOfSupply(residency: string | undefined): string {
  const r = (residency ?? "").toLowerCase();
  if (r.includes("bengaluru") || r.includes("karnataka")) return "Karnataka (29)";
  if (r.includes("hyderabad")) return "Telangana (36)";
  if (r.includes("chennai")) return "Tamil Nadu (33)";
  return "Maharashtra (27)";
}

const fmtDay = (t: number) => dayOf(t);
const inr = (paise: number) => formatPaise(paise).replace(/\.00$/, "");

/** Share of [start, end) covered by [from, to), in thousandths, rounded half up. */
function shareMilli(start: number, end: number, from: number, to = end): number {
  const covered = Math.min(end, to) - Math.max(start, from);
  if (!(covered > 0)) return 0;
  return Math.min(1000, roundDiv(1000 * covered, end - start));
}

/**
 * Every invoice for the organisation from its first receipt to now, per IST month, with the plan in force at each
 * event (a month that crosses an upgrade carries both plans, each for its days), and credit notes for settled
 * disputes. Sovereign is a yearly deployment licence in advance plus every action at the Sovereign rate.
 */
export function buildInvoices(input: BillingInput): ComputedInvoice[] {
  const { org, now } = input;
  const history: LevelPeriod[] = input.levelHistory?.length ? input.levelHistory : [{ level: org.level, from: org.createdAt ?? "" }];
  const lvlAt = (t: number) => levelAt(history, t, history[0]!.level);
  const events = meterEvents(input.receipts);
  const disputes = (input.disputes ?? []).filter((x) => x.open);
  const settled = (input.disputes ?? []).filter((x) => x.settlement);
  const orders = profileOrders(input.receipts);
  const spans = seatSpans(input.receipts, input.counterparties ?? []);
  const discounts = input.discounts ?? [];
  const runs = latestRuns(input.reconciliation ?? []);
  const pilotFrom = input.pilot ? ms(input.pilot.starts) : undefined;
  const pilotTo = input.pilot ? (input.pilot.convertedAt ? ms(input.pilot.convertedAt) : Infinity) : undefined;
  // the pilot covers Guarded only: a segment at a higher level is never billed as the pilot
  const inPilot = (t: number) => pilotFrom !== undefined && pilotTo !== undefined && t >= pilotFrom && t < pilotTo && lvlAt(t) === PILOT.listPlan;
  const orgFrom = org.createdAt ? ms(org.createdAt) : -Infinity;
  const pos = placeOfSupply(org.residency);
  const curMonth = monthOf(now);
  const first = input.receipts[0];
  if (!first) return [];
  const firstMonth = monthOf(ms(first.ts));

  // the L1 auditor pack is free; each L2+ evidence bundle is ₹2,500
  const exportsByMonth = new Map<string, { count: number; bundles: number; fromSeq: number; toSeq: number }>();
  for (const r of input.receipts) {
    if (r.action !== "evidence.exported") continue;
    const k = monthOf(ms(r.ts));
    const x = exportsByMonth.get(k) ?? { count: 0, bundles: 0, fromSeq: r.seq, toSeq: r.seq };
    exportsByMonth.set(k, { count: x.count + 1, bundles: x.bundles + (r.details?.format === EVIDENCE_BUNDLE_FORMAT ? 1 : 0), fromSeq: Math.min(x.fromSeq, r.seq), toSeq: Math.max(x.toSeq, r.seq) });
  }

  // packs run as a dry run below L2 and are billed only from the move to L2
  const l2From = history.find((h) => LEVEL_RANK[h.level] >= LEVEL_RANK.l2)?.from;
  const removals = input.receipts
    .filter((r) => r.action === "pack.uninstalled" && r.details?.pack !== undefined)
    .map((r) => ({ id: String(r.details!.pack), name: String(r.details!.pack), installedAt: r.details!.installed_at !== undefined ? String(r.details!.installed_at) : undefined, removedAt: ms(r.ts) as number | undefined, removedSeq: r.seq as number | undefined, billed: r.details!.billing !== "never_billed" }));
  const periods = [...removals.filter((x) => x.billed), ...(input.packs ?? []).map((p) => ({ ...p, removedAt: undefined, removedSeq: undefined, billed: true }))];
  // an install after an earlier removal of the same pack starts billing from the month after that removal
  const packPeriods = periods.map((p) => {
    const inst = p.installedAt ? ms(p.installedAt) : 0;
    const prior = removals.filter((x) => x.id === p.id && x.removedSeq !== p.removedSeq && x.billed && x.removedAt! <= inst).map((x) => monthStart(nextMonth(monthOf(x.removedAt!))));
    return { ...p, billFrom: prior.length ? Math.max(...prior) : undefined };
  });

  const invoices: ComputedInvoice[] = [];
  const creditNotes: ComputedInvoice[] = [];
  let fy = "";
  let used = 0;
  for (let ym = firstMonth; ym <= curMonth; ym = nextMonth(ym)) {
    if (fyStartOf(ym) !== fy) {
      fy = fyStartOf(ym);
      used = 0;
    }
    const start = monthStart(ym);
    const end = monthStart(nextMonth(ym));
    const daysInMonth = Math.round((end - start) / D);
    const dayUnit = (fMilli: number) => (fMilli === 1000 ? "month" : `${Math.round((fMilli / 1000) * daysInMonth * 10) / 10} of ${daysInMonth} days`);
    const pilotCuts = [pilotFrom, pilotTo, orgFrom].filter((t): t is number => t !== undefined && Number.isFinite(t) && t > start && t < end);
    const cuts = [...new Set([start, ...history.map((h) => ms(h.from)).filter((t) => t > start && t < end), ...pilotCuts, end])].sort((a, b) => a - b).filter((t) => t >= orgFrom || t === end);
    const segments: ComputedInvoice["segments"] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]!;
      const b = cuts[i + 1]!;
      segments.push({ level: lvlAt(a), from: new Date(a).toISOString(), to: new Date(b).toISOString(), days: Math.round(((b - a) / D) * 10) / 10, ...(inPilot(a) ? { pilot: true } : {}) });
    }
    const lines: InvoiceLine[] = [];
    const allEvs = events.filter((e) => e.month === ym);
    const evs = allEvs.filter((e) => !e.sandbox);
    const levelsBilled = new Set(segments.filter((s) => !s.pilot).map((s) => s.level));
    for (const seg of segments) {
      const sFrom = ms(seg.from);
      const sTo = ms(seg.to);
      const se = evs.filter((e) => e.t >= sFrom && e.t < sTo);
      const fromSeq = se[0]?.seq;
      const toSeq = se.at(-1)?.seq;
      const range = { ...(fromSeq !== undefined ? { fromSeq, toSeq } : {}) };
      if (seg.pilot) {
        const list = BILLING_PLANS[PILOT.listPlan];
        lines.push({ id: `pilot-${seg.from.slice(0, 10)}`, kind: "pilot", level: seg.level, label: `Pilot — free for ${PILOT.days} days, up to ${PILOT.cap.toLocaleString("en-IN")} governed actions (${seg.days} of ${daysInMonth} days)`, quantity: se.length, unit: "actions", rate: 0, amount: 0, note: `Discounts the ${list.name} list price in full`, ...range });
        continue;
      }
      const p = BILLING_PLANS[seg.level];
      const inv = monthlyInvoice(p, billable(se), used);
      used += se.reduce((s, e) => s + e.tenths, 0);
      const tag = levelsBilled.size > 1 || (segments.length > 1 && segments.some((s) => s.pilot)) ? `${LEVEL_SHORT[seg.level]} · ` : "";
      for (const l of inv.lines) {
        if (l.kind === "floor") {
          if (seg.level === "sovereign") continue; // billed as the yearly deployment licence
          const dT = Math.round(seg.days * 10);
          const whole = dT === daysInMonth * 10;
          const frac = seg.days / daysInMonth;
          lines.push({ id: `${seg.level}-floor`, kind: "floor", level: seg.level, label: `${tag}${l.label}`, quantity: whole ? 1 : Math.round(frac * 1000) / 1000, unit: whole ? "month" : `${seg.days} of ${daysInMonth} days`, rate: l.rate, amount: roundDiv(l.amount * dT, daysInMonth * 10) });
          continue;
        }
        if (seg.level === "sovereign" && (l.kind === "inside" || l.kind === "refused_inside")) continue;
        if (!l.quantity && !l.amount) continue;
        lines.push({ ...l, id: `${seg.level}-${l.kind}`, level: seg.level, label: `${tag}${l.label}`, ...range });
      }
      // a discount applies only to governed actions beyond the allowance: never the floor, a refusal or the evidence line
      const over = inv.lines[3]!.quantity;
      const committedEvs = se.filter((e) => e.outcome === "committed");
      const overEvs = over > 0 ? committedEvs.slice(Math.trunc(Math.max(0, committedEvs.length - over))) : [];
      for (const ds of discounts) {
        const dsFrom = dayStart(ds.from);
        if (!(dsFrom < sTo && discountCovers(ds, Math.max(sFrom, dsFrom)))) continue;
        const covered = overEvs.filter((e) => discountCovers(ds, e.t));
        const per = discountPerAction(p, ds.pct);
        const amount = covered.length * per;
        lines.push({
          id: `${seg.level}-discount-${ds.seq}`,
          kind: "discount",
          level: seg.level,
          label: `${tag}Discount ${ds.pct}% on governed actions beyond the allowance — until ${ds.until}`,
          quantity: covered.length,
          unit: "actions",
          rate: -per,
          amount: amount === 0 ? 0 : -amount,
          note: "The floor, refusals and the evidence line are never discounted.",
          discount: { seq: ds.seq, pct: ds.pct, until: ds.until },
          ...(overEvs.length ? { fromSeq: overEvs[0]!.seq, toSeq: overEvs.at(-1)!.seq } : {}),
        });
      }
    }
    // add-ons pro rata from the install or order day like the floor; one that stops is billed to the end of that month
    for (const p of packPeriods) {
      if (!p.installedAt || !l2From) continue;
      const from = Math.max(ms(p.installedAt), ms(l2From), p.billFrom ?? 0);
      const stop = p.removedAt !== undefined ? monthStart(nextMonth(monthOf(p.removedAt))) : Infinity;
      if (from >= end || start >= stop || from >= stop) continue;
      const f = shareMilli(start, end, from);
      lines.push({ id: `pack-${p.id}${p.removedSeq !== undefined ? `-r${p.removedSeq}` : ""}`, kind: "pack", label: `Regulatory pack — ${p.name}`, quantity: f / 1000, unit: dayUnit(f), rate: ADD_ON_PRICES.pack / 12, amount: (f * ADD_ON_PRICES.pack) / 12_000, note: `${inr(ADD_ON_PRICES.pack)} per pack per year${f < 1000 ? `, from ${fmtDay(Math.max(from, start))}` : ""}` });
    }
    // seats pro rata by day: a change counts from the moment it was recorded, so it never rewrites a month already invoiced
    const inMonth = spans.filter((s) => s.from < end && s.to > start && s.seats > 0);
    if (inMonth.length) {
      const monthMs = BigInt(end - start);
      const seatMs = inMonth.reduce((sum, s) => sum + BigInt(s.seats) * BigInt(Math.min(end, s.to) - Math.max(start, s.from)), 0n);
      const seatMonths = Number(seatMs) / Number(monthMs);
      const atEnd = inMonth.filter((s) => s.to >= end).reduce((sum, s) => sum + s.seats, 0);
      const whole = inMonth.every((s) => s.from <= start && s.to >= end);
      const perMonth = BigInt(ADD_ON_PRICES.seat / 12);
      lines.push({
        id: "seats",
        kind: "seat",
        label: `Counterparty verification seats (${atEnd || Math.round(seatMonths)})`,
        quantity: whole ? atEnd : Math.round(seatMonths * 1000) / 1000,
        unit: whole ? "seats" : "seat-months",
        rate: ADD_ON_PRICES.seat / 12,
        amount: Number((2n * seatMs * perMonth + monthMs) / (2n * monthMs)),
        note: `${inr(ADD_ON_PRICES.seat)} per seat per year${whole ? "" : ", pro rata by day"}`,
      });
    }
    for (const o of orders.filter((x) => ms(x.at) < end && (!x.cancelledAt || ms(x.cancelledAt) >= start))) {
      // a re-order of a profile cancelled earlier starts from the month after the cancellation: that month is already billed
      const reFrom = Math.max(ms(o.at), ...orders.filter((x) => x !== o && x.profileId === o.profileId && x.cancelledAt && ms(x.cancelledAt) <= ms(o.at)).map((x) => monthStart(nextMonth(monthOf(ms(x.cancelledAt!))))));
      const f = shareMilli(start, end, reFrom);
      if (f <= 0) continue;
      const twins = orders.filter((x) => x.profileId === o.profileId && ms(x.at) < end && (!x.cancelledAt || ms(x.cancelledAt) >= start)).length;
      lines.push({ id: `profile-${o.profileId}${twins > 1 ? `-${o.seq}` : ""}`, kind: "profile", label: `Verifier profile — ${o.profileId}`, quantity: f / 1000, unit: dayUnit(f), rate: ADD_ON_PRICES.profile / 12, amount: (f * ADD_ON_PRICES.profile) / 12_000, note: `${inr(ADD_ON_PRICES.profile)} per regime per year · ordered in receipt #${o.seq}` });
    }
    const ex = exportsByMonth.get(ym);
    if (ex?.bundles) lines.push({ id: "bundles", kind: "exports", label: `Evidence bundles (${ex.bundles})`, quantity: ex.bundles, unit: "bundles", rate: ADD_ON_PRICES.bundle, amount: ex.bundles * ADD_ON_PRICES.bundle, note: `${inr(ADD_ON_PRICES.bundle)} per L2+ evidence bundle — each export is itself a receipt`, fromSeq: ex.fromSeq, toSeq: ex.toSeq });
    if (ex && ex.count > ex.bundles) lines.push({ id: "exports", kind: "exports", label: `L1 auditor packs (${ex.count - ex.bundles})`, quantity: ex.count - ex.bundles, unit: "exports", rate: 0, amount: 0, note: "Free — every export is itself a receipt", fromSeq: ex.fromSeq, toSeq: ex.toSeq });
    const sbx = allEvs.filter((e) => e.sandbox);
    if (sbx.length) lines.push({ id: "sandbox", kind: "sandbox", label: `Sandbox calls, sk_sbx_ keys (${sbx.length})`, quantity: sbx.length, unit: "calls", rate: 0, amount: 0, note: "Calls made with a sandbox key are metered at 0 and never billed", fromSeq: sbx[0]!.seq, toSeq: sbx.at(-1)!.seq });

    const number = `EG-${org.prefix}-${ym.replace("-", "")}`;
    markDisputes(lines, number, disputes, settled);
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const held = lines.filter((l) => l.held).reduce((s, l) => s + l.amount, 0);
    // a period whose meter and chain disagree is never invoiced on either number; once older than the due month an invoice stands
    const open = ym === curMonth || nextMonth(ym) === curMonth;
    const run = runs.get(ym);
    const holdRun = run && !run.matched && open ? run : undefined;
    const issued = end + 10 * H; // 10:00 UTC on the 1st, after the month closes
    const pilotSegs = segments.filter((s) => s.pilot);
    const inv: ComputedInvoice = {
      number,
      kind: "monthly",
      period: ym,
      status: holdRun ? "held" : ym === curMonth ? "draft" : "issued",
      issuedAt: new Date(issued).toISOString(),
      dueAt: new Date(issued + 15 * D).toISOString(),
      periodStart: new Date(start).toISOString(),
      periodEnd: new Date(Math.min(end, now)).toISOString(),
      lines,
      subtotal,
      gst: gstOn(subtotal),
      total: subtotal + gstOn(subtotal),
      heldAmount: holdRun ? subtotal : held,
      payableNow: holdRun ? 0 : roundDiv((subtotal - held) * (100 + GST_PERCENT), 100),
      irn: irnFor(number, ym),
      placeOfSupply: pos,
      customer: { name: org.name },
      segments,
      ...(evs.length ? { fromSeq: evs[0]!.seq, toSeq: evs.at(-1)!.seq } : {}),
      events: evs.length,
      ...(ym === firstMonth && ms(first.ts) > start + D ? { partial: first.ts } : {}),
      ...(holdRun ? { heldBy: { seq: holdRun.seq, meterEvents: holdRun.meterEvents, chainDecisions: holdRun.chainDecisions, at: holdRun.at } } : {}),
      ...(pilotSegs.length ? { pilot: { from: pilotSegs[0]!.from, to: pilotSegs.at(-1)!.to } } : {}),
    };
    invoices.push(inv);
    creditNotes.push(...creditNotesFor(inv));
  }

  // Sovereign: a yearly licence per deployment, invoiced in advance from go-live
  const sov = history.find((h) => h.level === "sovereign");
  if (sov) {
    const goLive = ms(sov.from);
    for (let k = 0; goLive + k * 365 * D <= now; k++) {
      const s = goLive + k * 365 * D;
      const e = s + 365 * D;
      const number = `EG-${org.prefix}-DEP-${fmtDay(s).slice(0, 4)}${k ? `-${k + 1}` : ""}`;
      const p = BILLING_PLANS.sovereign;
      const lines: InvoiceLine[] = [{ id: "deployment", kind: "deployment", level: "sovereign", label: `Sovereign deployment licence — ${fmtDay(s)} to ${fmtDay(e - D)}`, quantity: 1, unit: "deployment-year", rate: p.floorPerYear, amount: p.floorPerYear, note: "Per deployment per year, in advance. Every governed action is metered monthly at the Sovereign rate." }];
      markDisputes(lines, number, disputes, settled);
      const subtotal = lines[0]!.amount;
      const held = lines[0]!.held ? subtotal : 0;
      const inv: ComputedInvoice = {
        number,
        kind: "deployment",
        period: monthOf(s),
        status: "issued",
        issuedAt: new Date(s).toISOString(),
        dueAt: new Date(s + 30 * D).toISOString(),
        periodStart: new Date(s).toISOString(),
        periodEnd: new Date(e).toISOString(),
        lines,
        subtotal,
        gst: gstOn(subtotal),
        total: subtotal + gstOn(subtotal),
        heldAmount: held,
        payableNow: roundDiv((subtotal - held) * (100 + GST_PERCENT), 100),
        irn: irnFor(number, monthOf(s)),
        placeOfSupply: pos,
        customer: { name: org.name },
        segments: [{ level: "sovereign", from: new Date(s).toISOString(), to: new Date(e).toISOString(), days: 365 }],
        events: 0,
      };
      invoices.push(inv);
      creditNotes.push(...creditNotesFor(inv));
    }
  }
  return [...invoices, ...creditNotes].sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.kind.localeCompare(b.kind));
}

function markDisputes(lines: InvoiceLine[], number: string, open: readonly DisputeRecord[], settled: readonly DisputeRecord[]) {
  for (const l of lines) {
    const ds = open.find((x) => x.invoice === number && x.line === l.id);
    if (ds) l.held = { seq: ds.seq, by: ds.by, reason: ds.reason, at: ds.at };
    const st = settled.find((x) => x.invoice === number && x.line === l.id);
    if (st?.settlement) l.settled = { disputeSeq: st.seq, seq: st.settlement.seq, outcome: st.settlement.outcome, credit: st.settlement.credit, ...(st.settlement.creditNote ? { creditNote: st.settlement.creditNote } : {}), at: st.settlement.at };
  }
}

/** A credit note for every settled dispute on this invoice that credits money, never more than the line. */
function creditNotesFor(inv: ComputedInvoice): ComputedInvoice[] {
  const out: ComputedInvoice[] = [];
  for (const l of inv.lines) {
    const st = l.settled;
    if (!st || !(st.credit > 0) || !st.creditNote) continue;
    const credit = Math.min(st.credit, Math.max(0, l.amount));
    inv.credits = [...(inv.credits ?? []), { number: st.creditNote, amount: credit }];
    const gst = gstOn(-credit);
    out.push({
      number: st.creditNote,
      kind: "credit_note",
      period: inv.period,
      status: "issued",
      issuedAt: st.at,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      lines: [{ id: "credit", kind: "credit", level: l.level, label: `Credit against ${inv.number} — ${l.label}`, quantity: 1, unit: "credit", rate: -credit, amount: -credit, note: st.outcome === "upheld" ? "Dispute upheld" : "Dispute partly upheld" }],
      subtotal: -credit,
      gst,
      total: -credit + gst,
      heldAmount: 0,
      payableNow: -credit + gst,
      irn: irnFor(st.creditNote, inv.period, "CRN"),
      placeOfSupply: inv.placeOfSupply,
      customer: inv.customer,
      segments: [],
      events: 0,
      creditFor: { invoice: inv.number, line: l.id, outcome: st.outcome, settlementSeq: st.seq, disputeSeq: st.disputeSeq },
    });
  }
  return out;
}

// ---- The ledger: issued invoices never change ----

export interface StoredInvoice {
  number: string;
  status: "draft" | "issued" | "held" | "void";
}

/**
 * What the ledger should hold, given what is stored: an issued or void invoice stays exactly as it was, whatever the
 * chain or the terms now say (corrections are credit notes); a draft or held one takes the newly computed figures.
 */
export function mergeWithLedger<T extends StoredInvoice>(computed: readonly ComputedInvoice[], stored: readonly T[]): (ComputedInvoice | T)[] {
  const byNumber = new Map(stored.map((s) => [s.number, s]));
  return computed.map((c) => {
    const s = byNumber.get(c.number);
    return s && (s.status === "issued" || s.status === "void") ? s : c;
  });
}
