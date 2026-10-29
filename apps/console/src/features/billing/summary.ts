/**
 * One loader for everything the meter shows, so /billing and the Today "Meter" tile read the same source:
 * the chain meter, the invoices built from it (with the packs installed and the counterparty seats held), the
 * allowance year from April, the one projection both screens print, and the commercial terms recorded in the chain
 * (discounts and offers from elan1, the pilot, reconciliation).
 */
import { api, db } from '@/api';
import { PLANS } from '@/lib/pricing';
import { discountRequestsOf, discountState, heldPeriods, latestRuns, offersOf, pilotOf, sweepPilot } from '@/mock/billing';
import { buildInvoices, chainMeter, fyStartOf, monthOf, monthStart, type ChainInvoice, type LineKind } from './chainMeter';

const D = 86_400_000;
const MONTH = 30.4 * D;

/** Invoice lines that charge for governed actions themselves (not the floor, add-ons or bundles). */
export const ACTION_LINES: LineKind[] = ['beyond', 'refused_beyond', 'discount'];

export async function loadMeter(orgId: string, now = Date.now()) {
  const [packs, cps] = await Promise.all([api.packs(orgId), api.counterparties(orgId)]);
  const d = db.getDB(orgId);
  try { sweepPilot(d); } catch { /* recording the stop or the closure never blocks reading the meter */ }
  const cm = chainMeter(d, now);
  const ctx = {
    packs: packs.filter((p) => p.installed).map((p) => ({ id: p.id, name: p.name, installedAt: p.installedAt })),
    counterparties: cps.counterparties.map((c) => ({ id: c.id, name: c.name, seats: c.seats, since: c.since })),
  };
  const invoices = buildInvoices(d, cm, ctx, now);
  return { d, cm, ctx, packs, cps, invoices, ...meterFacts(d, cm, invoices, now) };
}

/**
 * The figures the Today tile and the meter screen both print. The projection is one formula for both: units this
 * allowance year per elapsed day (from April, or from where this console's copy of the chain starts), carried to
 * 31 March.
 */
export function meterFacts(d: ReturnType<typeof db.getDB>, cm: ReturnType<typeof chainMeter>, invoices: ChainInvoice[], now = Date.now()) {
  const plan = PLANS[cm.level];
  const curMonth = monthOf(now);
  const draft = invoices.find((i) => i.kind === 'monthly' && i.period === curMonth);
  // allowance year runs April to March
  const fyStart = monthStart(fyStartOf(curMonth));
  const fyEnd = monthStart(`${Number(fyStartOf(curMonth).slice(0, 4)) + 1}-04`);
  const coveredFrom = cm.fy.coveredFrom ? new Date(cm.fy.coveredFrom).getTime() : fyStart;
  const elapsed = Math.max(D, now - Math.max(fyStart, coveredFrom));
  const yearFrac = Math.max(0.02, (now - fyStart) / (fyEnd - fyStart));
  const perDay = cm.fy.units / (elapsed / D);
  const perMonth = perDay * (MONTH / D);
  const projectedUnits = cm.fy.units + perDay * Math.max(0, (fyEnd - now) / D);
  const projectedOver = plan.includedPerYear ? Math.max(0, projectedUnits - plan.includedPerYear) : projectedUnits;
  const runsOut = plan.includedPerYear > 0 && projectedUnits > plan.includedPerYear;
  const runOutAt = plan.includedPerYear > 0 && perDay > 0 ? new Date(now + Math.max(0, (plan.includedPerYear - cm.fy.units) / perDay) * D).toISOString() : undefined;
  // this month's charge for governed actions alone (beyond the allowance, refusals at 40%, less any discount)
  const actionCharge = Math.round((draft?.lines.filter((l) => ACTION_LINES.includes(l.kind)).reduce((s, l) => s + l.amount, 0) ?? 0) * 100) / 100;
  const deployment = invoices.find((i) => i.kind === 'deployment' && new Date(i.periodStart).getTime() <= now && new Date(i.periodEnd).getTime() > now);
  const offers = offersOf(d, now);
  const discounts = offers.filter((o) => o.status === 'accepted');
  return {
    plan, draft, yearFrac, projectedUnits, projectedOver, deployment, actionCharge,
    projection: { perDay, perMonth, projected: projectedUnits, runsOut, runOutAt },
    held: heldPeriods(d),
    runs: latestRuns(d),
    discounts,
    offers,
    openOffers: offers.filter((o) => o.status === 'offered'),
    requests: discountRequestsOf(d),
    activeDiscount: discounts.find((x) => discountState(x, now) === 'active'),
    pilot: pilotOf(d, now),
  };
}
