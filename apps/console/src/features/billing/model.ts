import type { Invoice, InvoiceLine, Plan, UsageMonth } from '@/types';
import { allowanceUsed, monthlyInvoice, REFUSAL_FACTOR, GST_RATE } from '@/lib/pricing';
import { rupees, usd, INR_PER_USD } from '@/lib/format';

export type Currency = 'INR' | 'USD';

/** Money in the chosen view. INR is primary; the US$ view divides by INR_PER_USD for reference only. */
export function money(v: number, cur: Currency, precise = false): string {
  if (cur === 'INR') return precise ? rupees(v, { paise: true }) : rupees(v);
  const x = v / INR_PER_USD;
  if (!precise) return usd(x);
  return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(x) < 1 ? 4 : 2 });
}

/** A per-action rate: ₹1.60 / $0.0178 */
export const rate = (v: number, cur: Currency) => money(v, cur, true);

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthLong = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const toDate = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)); };
export const monthLabel = (ym: string) => monthFmt.format(toDate(ym));
export const monthLabelLong = (ym: string) => monthLong.format(toDate(ym));
export const addMonths = (ym: string, k: number) => { const d = toDate(ym); d.setUTCMonth(d.getUTCMonth() + k); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

/** Fiscal year starts in April (India). */
export function fiscalYear(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  const months = Array.from({ length: 12 }, (_, i) => addMonths(`${start}-04`, i));
  return { label: `FY ${start}–${String(start + 1).slice(2)}`, start: months[0], end: months[11], months };
}

export interface AllowanceProjection {
  fy: ReturnType<typeof fiscalYear>;
  used: number;
  included: number;
  share: number;
  committed: number;
  refusals: number;
  runRate: number; // allowance units a month at last month's rate
  runOutMonth?: string; // month in which the allowance runs out
  projectedOverCost: number; // beyond-allowance charges for the rest of the fiscal year at the run rate
  remainingMonths: number;
}

export function projectAllowance(plan: Plan, usage: UsageMonth[]): AllowanceProjection | undefined {
  if (!usage.length) return undefined;
  const last = usage[usage.length - 1];
  const fy = fiscalYear(last.month);
  const inFy = usage.filter((u) => fy.months.includes(u.month));
  const used = inFy.reduce((s, u) => s + allowanceUsed(u), 0);
  const committed = inFy.reduce((s, u) => s + u.allowed + u.approved, 0);
  const refusals = inFy.reduce((s, u) => s + u.refused + u.expired, 0);
  const runRate = allowanceUsed(last);
  const remaining = fy.months.slice(fy.months.indexOf(last.month) + 1);
  let cum = used;
  let runOutMonth: string | undefined = used >= plan.includedPerYear ? last.month : undefined;
  let projectedOverCost = 0;
  for (const m of remaining) {
    const inv = monthlyInvoice(plan, { ...last, month: m }, cum);
    projectedOverCost += inv.lines.filter((l) => l.label.includes('beyond allowance')).reduce((s, l) => s + l.amount, 0);
    if (!runOutMonth && cum + runRate > plan.includedPerYear) runOutMonth = m;
    cum += runRate;
  }
  return { fy, used, included: plan.includedPerYear, share: plan.includedPerYear ? used / plan.includedPerYear : 1, committed, refusals, runRate, runOutMonth, projectedOverCost, remainingMonths: remaining.length };
}

/** Year estimate using exactly the invoice rules, month by month (committed actions draw the allowance first, then refusals at 0.4 each). */
export function estimateYear(plan: Plan, actionsPerMonth: number, refusalShare: number) {
  const refused = Math.round(actionsPerMonth * refusalShare);
  const committed = Math.max(0, actionsPerMonth - refused);
  let used = 0;
  const totals = new Map<string, InvoiceLine>();
  const invoices: Invoice[] = [];
  for (let i = 0; i < 12; i++) {
    const inv = monthlyInvoice(plan, { month: `m${i}`, allowed: committed, approved: 0, refused, expired: 0 }, used);
    used += committed + REFUSAL_FACTOR * refused;
    invoices.push(inv);
    for (const l of inv.lines) {
      const t = totals.get(l.label);
      if (t) { t.quantity = (t.quantity ?? 0) + (l.quantity ?? 0); t.amount += l.amount; }
      else totals.set(l.label, { ...l });
    }
  }
  const lines = [...totals.values()];
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const gst = subtotal * GST_RATE;
  const firstOver = invoices.findIndex((inv) => inv.lines.some((l) => l.label.includes('beyond allowance') && (l.quantity ?? 0) > 0));
  return {
    committed, refused, lines, subtotal, gst, total: subtotal + gst,
    unitsPerYear: 12 * (committed + REFUSAL_FACTOR * refused),
    monthly: subtotal / 12, firstOverMonth: firstOver < 0 ? undefined : firstOver + 1,
    firstMonth: invoices[0].subtotal, lastMonth: invoices[11].subtotal,
  };
}

export const lineOf = (lines: InvoiceLine[], startsWith: string) => lines.find((l) => l.label.startsWith(startsWith));
