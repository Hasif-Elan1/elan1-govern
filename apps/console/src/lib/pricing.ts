import type { Plan, PlanId, UsageMonth, Invoice, InvoiceLine } from '@/types';

/**
 * Price book (Information Memorandum, Appendix A) with the user's correction of 27 Oct 2026:
 * a refused action costs 40% of the per-action rate. Inside the yearly allowance a refusal uses
 * 0.4 of an included action; beyond the allowance it is billed at 40% of the overage rate.
 */
export const REFUSAL_FACTOR = 0.4;
export const GST_RATE = 0.18;

export const PLANS: Record<PlanId, Plan> = {
  l1: {
    id: 'l1', name: 'Guarded', level: 'L1', floorPerYear: 180000, includedPerYear: 480000, overageRate: 1.6,
    refusalRate: 1.6 * REFUSAL_FACTOR, status: 'available', buyer: 'Operator — finance controller, head of operations',
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
    proves: ['Every tool call decided before it runs', 'A named person approves the held ones', 'Receipts sealed in a hash chain, with hourly checkpoints'],
  },
  l2: {
    id: 'l2', name: 'Attested', level: 'L2', floorPerYear: 600000, includedPerYear: 1500000, overageRate: 1.2,
    refusalRate: 1.2 * REFUSAL_FACTOR, status: 'available', buyer: 'Auditor, lender diligence, compliance',
    proves: ['Everything in Guarded', 'Seal v6 records timestamped by two authorities', 'Key custody in AWS KMS', 'Verifier profiles per regime', 'Dual control on publish'],
  },
  l3: {
    id: 'l3', name: 'Proven', level: 'L3', floorPerYear: 2400000, includedPerYear: 4200000, overageRate: 0.9,
    refusalRate: 0.9 * REFUSAL_FACTOR, status: 'available', buyer: 'Counterparty, regulator, insurer',
    proves: ['Everything in Attested', 'Verification between organisations', 'Selective disclosure', 'Customer-held keys', 'Earned autonomy A0–A5'],
  },
  sovereign: {
    id: 'sovereign', name: 'Sovereign', level: 'On-premises', floorPerYear: 12000000, includedPerYear: 0, overageRate: 0.55,
    refusalRate: 0.55 * REFUSAL_FACTOR, status: 'available', buyer: 'Bank, insurer or public body that must run it themselves',
    proves: ['Everything in Proven', 'Your infrastructure, your keys', 'Air-gapped signed updates, no egress', 'Same receipts, same verifier'],
  },
};

/**
 * Every price in the price book is a modelled list price: no buyer has been quoted and there is no published price
 * list. Each level has a target date; prices are flat to 31 March 2029, then rise 4% each April.
 */
export const LIST_PRICE = {
  label: 'Modelled list price',
  note: 'Modelled list prices: no buyer has been quoted, and there is no published price list yet.',
  flatUntil: '2029-03-31',
  escalation: 0.04,
  escalationNote: 'flat to March 2029, then +4% a year',
  /** target availability per plan, from the price book */
  targets: { l1: 'General availability target: April–June 2027', l2: 'Target: April 2028', l3: 'Target: October 2029', sovereign: 'Target: October 2029, with Proven' } as Record<PlanId, string>,
  targetShort: { l1: 'GA target Q2 2027', l2: 'Target Apr 2028', l3: 'Target Oct 2029', sovereign: 'Target Oct 2029' } as Record<PlanId, string>,
};

/** The list-price multiplier for a month: flat to March 2029, then +4% each April. */
export function listPriceFactor(ym: string): number {
  if (ym < '2029-04') return 1;
  const [y, m] = ym.split('-').map(Number);
  const yearsSince = (m >= 4 ? y : y - 1) - 2029 + 1;
  return Math.pow(1 + LIST_PRICE.escalation, yearsSince);
}

/** One line for any screen that shows a list price: "Modelled list price · GA target Q2 2027 · flat to March 2029, then +4% a year". */
export const listPriceLine = (planId: PlanId) => `${LIST_PRICE.label} · ${LIST_PRICE.targetShort[planId]} · ${LIST_PRICE.escalationNote}`;

export const ADD_ONS = [
  { id: 'pack', name: 'Regulatory pack', price: 135000, unit: 'per tenant per year', note: 'ledger1 · invoice1 · collect1 — from L2' },
  { id: 'profile', name: 'Verifier profile', price: 300000, unit: 'per regime per year', note: 'From L2; billed separately, not included with a regulatory pack' },
  { id: 'bundle', name: 'Evidence bundle', price: 2500, unit: 'each', note: 'Each L2+ evidence bundle; the L1 auditor pack is free' },
  { id: 'seat', name: 'Counterparty verification seat', price: 45000, unit: 'per year', note: 'From L3' },
];

/** Allowance consumed: allowed + approved count 1 each, refusals and expiries count 0.4. */
export function allowanceUsed(m: Pick<UsageMonth, 'allowed' | 'approved' | 'refused' | 'expired'>) {
  return m.allowed + m.approved + REFUSAL_FACTOR * (m.refused + m.expired);
}

export function monthlyInvoice(plan: Plan, usage: UsageMonth, usedBeforeThisMonth: number, extras: InvoiceLine[] = []): Invoice {
  const floorMonthly = plan.floorPerYear / 12;
  const committed = usage.allowed + usage.approved;
  const refusals = usage.refused + usage.expired;
  const remaining = Math.max(0, plan.includedPerYear - usedBeforeThisMonth);
  // committed actions draw the allowance first, then refusals at 0.4 each
  const committedInside = Math.min(committed, remaining);
  const committedOver = committed - committedInside;
  const remainingAfter = remaining - committedInside;
  const refusalsInside = Math.min(refusals, Math.floor(remainingAfter / REFUSAL_FACTOR));
  const refusalsOver = refusals - refusalsInside;

  const lines: InvoiceLine[] = [
    { label: `${plan.name} platform floor (${plan.level})`, quantity: 1, unit: 'month', rate: floorMonthly, amount: floorMonthly },
    { label: 'Governed actions inside allowance', quantity: committedInside, unit: 'actions', rate: 0, amount: 0, note: 'Included' },
    { label: 'Refused actions inside allowance', quantity: refusalsInside, unit: 'refusals', rate: 0, amount: 0, note: `Uses ${REFUSAL_FACTOR} of an included action each` },
    { label: 'Governed actions beyond allowance', quantity: committedOver, unit: 'actions', rate: plan.overageRate, amount: committedOver * plan.overageRate },
    { label: 'Refused actions beyond allowance', quantity: refusalsOver, unit: 'refusals', rate: plan.refusalRate, amount: refusalsOver * plan.refusalRate, note: '40% of the per-action rate' },
    ...extras,
  ];
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const gst = subtotal * GST_RATE;
  return { id: '', period: usage.month, issuedAt: '', status: 'preview', lines, subtotal, gst, total: subtotal + gst };
}
