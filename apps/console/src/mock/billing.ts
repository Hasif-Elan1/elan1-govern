/**
 * Commercial terms beside the meter, every one read from the organisation's own chain:
 *  - discounts on the per-action charge beyond the allowance. elan1 offers them (an account lead within the cap of 20%
 *    for up to 12 months; only a founder may go further), an owner accepts or declines here, and every one has an end
 *    date. A customer can ask for one, but cannot record one;
 *  - dispute settlements: an owner disputes a line; only elan1's billing desk decides it (upheld, partly upheld or
 *    rejected), and a credit above ₹1,00,000 also needs a founder's approval on the same record;
 *  - reconciliation runs per period: a period whose meter and chain disagree holds its invoice;
 *  - the pilot: free for 90 days and up to 2,000 governed actions at Guarded, then a hard stop (POLICY.TENANT_STOPPED):
 *    no call runs and the organisation is read-only for 30 days, then it is closed unless it moved to the paid plan.
 * The price book's own facts (modelled list prices, target dates, +4% a year after March 2029, cost per governed
 * action) are here too, so the meter screen and the Today tile read one source.
 * Refused actions stay at 40% of the per-action rate: nothing here changes that.
 */
import type { LevelId, Receipt } from '@/types';
import { LIST_PRICE, listPriceFactor } from '@/lib/pricing';
import { levelOfOrg } from '@/lib/levels';
import { append, getDB, logAdmin, memberRole, type OrgDB } from './db';
import { isPlatformRefusal } from '@/lib/platformRefusal';
import { packById } from '@/lib/packs';
import { buildInvoices, chainMeter, type BillingContext } from '@/features/billing/chainMeter';

export { LIST_PRICE, listPriceFactor };

const H = 3_600_000;
const D = 24 * H;
const IST = 5.5 * H;

const monthOfT = (t: number) => new Date(t + IST).toISOString().slice(0, 7);
const dayOfT = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
/** IST midnight of a 'YYYY-MM-DD' day, as epoch ms. */
export const dayStart = (day: string) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) - IST; };
/** When a record says it happened: its `at` detail for terms recorded after the fact, otherwise its own time. */
const atOf = (r: Receipt) => String(r.details?.at ?? r.ts);

/**
 * Cost per governed action (modelled: runtime cost plus 15%), falling from ₹0.092 in October 2026 to ₹0.052 from
 * April 2030, straight-line by month. Published every month beside the refusal share.
 */
export function costPerAction(ym: string): number {
  const start = 2026 * 12 + 9; // Oct 2026
  const end = 2030 * 12 + 3; // Apr 2030
  const [y, m] = ym.split('-').map(Number);
  const k = y * 12 + (m - 1);
  if (k <= start) return 0.092;
  if (k >= end) return 0.052;
  return Math.round((0.092 - ((k - start) / (end - start)) * 0.04) * 10000) / 10000;
}

/* ── elan1's people: who may offer a discount or decide a dispute ── */

export type Elan1Role = 'lead' | 'founder' | 'billing';
export interface Elan1Person { id: string; name: string; role: Elan1Role; title: string }

/** elan1 staff who write commercial records into a customer's chain. A customer's own people are never on this list. */
export const ELAN1_STAFF: Elan1Person[] = [
  { id: 'elan1:meera.iyer', name: 'Meera Iyer', role: 'lead', title: 'elan1 account lead, Mumbai' },
  { id: 'elan1:karthik.nair', name: 'Karthik Nair', role: 'lead', title: 'elan1 account lead, Bengaluru' },
  { id: 'elan1:farah.khan', name: 'Farah Khan', role: 'billing', title: 'elan1 billing desk' },
  { id: 'elan1:founder', name: 'elan1 founder', role: 'founder', title: 'Founder, elan1' },
];
export const isElan1Actor = (actor?: string) => !!actor && ELAN1_STAFF.some((s) => s.id === actor);
export const elan1Person = (id?: string) => ELAN1_STAFF.find((s) => s.id === id);
export const ELAN1_ROLE_LABEL: Record<Elan1Role, string> = { lead: 'account lead', founder: 'founder', billing: 'billing desk' };
/** Each organisation's elan1 account lead: the person who offers its discounts. */
export function accountLeadOf(orgId: string): Elan1Person {
  const id = ({ org_northbank: 'elan1:meera.iyer', org_deccan: 'elan1:meera.iyer' } as Record<string, string>)[orgId] ?? 'elan1:karthik.nair';
  return elan1Person(id)!;
}
export const BILLING_DESK = 'elan1:farah.khan';

function requireOwner(orgId: string, userId: string, what: string) {
  if (memberRole(orgId, userId) !== 'owner') throw new Error(`Only an owner can ${what}.`);
}
function requireStaff(staffId: string, roles: Elan1Role[], what: string): Elan1Person {
  const p = elan1Person(staffId);
  if (!p) throw new Error(`Only elan1 can ${what}. A customer’s own people cannot.`);
  if (!roles.includes(p.role)) throw new Error(`An elan1 ${ELAN1_ROLE_LABEL[p.role]} cannot ${what}.`);
  return p;
}

/* ── Discounts ────────────────────────────────────────────── */

export const DISCOUNT_CAP = { leadPct: 20, leadMonths: 12 };

/** An offer elan1 made, and what the owner did with it. Only accepted offers are discounts on an invoice. */
export interface Discount {
  seq: number;
  pct: number;
  /** first and last day it applies, IST, inclusive (the first day is the later of the offer's start and the acceptance) */
  from: string;
  until: string;
  offeredFrom: string;
  agreedBy: 'lead' | 'founder';
  agreedName: string;
  agreedTitle: string;
  offeredBy: string;
  reference: string;
  offeredAt: string;
  /** the offer lapses if it is not accepted by this day */
  validUntil: string;
  requestSeq?: number;
  status: 'offered' | 'accepted' | 'declined' | 'lapsed';
  acceptedSeq?: number;
  acceptedAt?: string;
  acceptedBy?: string;
  declinedSeq?: number;
  declinedReason?: string;
  endedSeq?: number;
  endedAt?: string;
  endedReason?: string;
}

const monthsBetween = (from: string, until: string) => {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = until.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + (d2 + 1 - d1) / 31;
};

/** Every offer elan1 has made to this organisation, oldest first, with the owner's answer. */
export function offersOf(d: OrgDB, now = Date.now()): Discount[] {
  const out: Discount[] = [];
  for (const r of d.receipts) {
    const x = r.details ?? {};
    if (r.action === 'billing.discount_offered' && isElan1Actor(r.actor)) {
      const p = elan1Person(r.actor)!;
      out.push({
        seq: r.seq, pct: Number(x.pct), from: String(x.from), offeredFrom: String(x.from), until: String(x.until), agreedBy: p.role === 'founder' ? 'founder' : 'lead', agreedName: p.name, agreedTitle: p.title, offeredBy: p.id,
        reference: String(x.reference ?? '—'), offeredAt: atOf(r), validUntil: String(x.valid_until ?? dayOfT(new Date(atOf(r)).getTime() + 30 * D)), requestSeq: x.request !== undefined ? Number(x.request) : undefined, status: 'offered',
      });
    } else if (r.action === 'billing.discount_accepted' || r.action === 'billing.discount_declined') {
      const o = out.find((v) => v.seq === Number(x.offer));
      if (!o || o.status !== 'offered') continue;
      if (r.action === 'billing.discount_accepted') {
        o.status = 'accepted'; o.acceptedSeq = r.seq; o.acceptedAt = atOf(r); o.acceptedBy = r.actor;
        const acc = dayOfT(new Date(o.acceptedAt).getTime());
        if (acc > o.from) o.from = acc;
      } else { o.status = 'declined'; o.declinedSeq = r.seq; o.declinedReason = String(x.reason ?? ''); }
    } else if (r.action === 'billing.discount_ended') {
      const o = out.find((v) => v.seq === Number(x.discount));
      if (o && o.status === 'accepted' && !o.endedSeq) { o.endedSeq = r.seq; o.endedAt = atOf(r); o.endedReason = String(x.reason ?? ''); }
    }
  }
  for (const o of out) if (o.status === 'offered' && dayOfT(now) > o.validUntil) o.status = 'lapsed';
  return out;
}

/** Discounts in force or that were: accepted offers. A discount a customer wrote down for itself is never one. */
export const discountsOf = (d: OrgDB) => offersOf(d).filter((o) => o.status === 'accepted');

/** The last instant a discount applies: the end of its last day, or the moment it was ended early. */
export function discountEnd(ds: Discount): number {
  const last = dayStart(ds.until) + D;
  return ds.endedAt ? Math.min(last, new Date(ds.endedAt).getTime()) : last;
}

export const discountCovers = (ds: Discount, t: number) => t >= dayStart(ds.from) && t < discountEnd(ds);

export function discountState(ds: Discount, now = Date.now()): 'scheduled' | 'active' | 'ended' {
  if (now < dayStart(ds.from)) return 'scheduled';
  return now < discountEnd(ds) ? 'active' : 'ended';
}

/** The cap: an elan1 lead may cut overage by up to 20% for up to 12 months; a founder may go further. Every discount has an end date. */
export function checkDiscount(input: { pct: number; from: string; until: string; agreedBy: 'lead' | 'founder' }): string | undefined {
  if (!(input.pct > 0) || input.pct >= 100) return 'Enter a percentage above 0 and below 100.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.until)) return 'Enter a start date and an end date. Every discount has an end date.';
  if (input.until < input.from) return 'The end date is before the start date.';
  if (input.agreedBy === 'lead') {
    if (input.pct > DISCOUNT_CAP.leadPct) return `An elan1 lead may discount overage by up to ${DISCOUNT_CAP.leadPct}%. A larger discount needs a founder.`;
    if (monthsBetween(input.from, input.until) > DISCOUNT_CAP.leadMonths + 0.01) return `An elan1 lead may agree a discount for up to ${DISCOUNT_CAP.leadMonths} months. A longer one needs a founder.`;
  }
  return undefined;
}

/**
 * elan1's side: offer a discount. The person's authority comes from elan1's own staff list, never from a choice the
 * customer makes: a lead is held to 20% for 12 months; a founder may go further. Written into the customer's chain.
 */
export function offerDiscount(orgId: string, staffId: string, input: { pct: number; from: string; until: string; reference: string; request?: number; validDays?: number; at?: string; seeded?: number; recordedBy?: string }) {
  // the billing desk answers a request within a lead's cap, as a lead would; only a founder goes beyond it
  const p = requireStaff(staffId, ['lead', 'founder', 'billing'], 'offer a discount');
  const err = checkDiscount({ ...input, agreedBy: p.role === 'founder' ? 'founder' : 'lead' });
  if (err) throw new Error(err);
  const d = getDB(orgId);
  const at = input.at ?? new Date().toISOString();
  return append(d, { kind: 'admin', actor: p.id, action: 'billing.discount_offered', details: {
    pct: input.pct, from: input.from, until: input.until, reference: input.reference || '—', offered_by: p.name, offered_by_role: p.role,
    valid_until: dayOfT(new Date(at).getTime() + (input.validDays ?? 30) * D), applies_to: 'governed actions beyond the allowance',
    ...(input.request !== undefined ? { request: input.request } : {}), ...(input.at ? { at: input.at } : {}), ...(input.seeded ? { billing_seed: input.seeded } : {}),
    ...(input.recordedBy ? { recorded_by: input.recordedBy, demo_desk: true } : {}),
  } });
}

/** The owner accepts an offer elan1 made. It applies from the later of its start and today. */
export function acceptDiscount(orgId: string, userId: string, offerSeq: number) {
  requireOwner(orgId, userId, 'accept a discount');
  const d = getDB(orgId);
  const o = offersOf(d).find((x) => x.seq === offerSeq);
  if (!o) throw new Error('No such offer from elan1.');
  if (o.status !== 'offered') throw new Error(o.status === 'lapsed' ? `This offer lapsed on ${o.validUntil}. Ask elan1 for a new one.` : 'This offer has already been answered.');
  const today = dayOfT(Date.now());
  const from = o.from > today ? o.from : today;
  const open = discountsOf(d).filter((x) => discountState(x) !== 'ended');
  if (open.some((x) => !(o.until < x.from || from > x.until))) throw new Error('Another discount covers some of these dates. End it first.');
  return logAdmin(orgId, userId, 'billing.discount_accepted', { offer: offerSeq, pct: o.pct, until: o.until, offered_by: o.agreedName });
}

export function declineDiscount(orgId: string, userId: string, offerSeq: number, reason: string) {
  requireOwner(orgId, userId, 'decline a discount');
  const o = offersOf(getDB(orgId)).find((x) => x.seq === offerSeq);
  if (!o || o.status !== 'offered') throw new Error('There is no open offer to decline.');
  return logAdmin(orgId, userId, 'billing.discount_declined', { offer: offerSeq, reason: reason.trim() || 'Declined' });
}

/** An owner may end an accepted discount early (it only ever raises what the customer pays). */
export function endDiscount(orgId: string, userId: string, seq: number, reason: string) {
  requireOwner(orgId, userId, 'end a discount');
  const ds = discountsOf(getDB(orgId)).find((x) => x.seq === seq);
  if (!ds) throw new Error('No such discount.');
  if (discountState(ds) === 'ended') throw new Error('This discount has already ended.');
  return logAdmin(orgId, userId, 'billing.discount_ended', { discount: seq, reason: reason.trim() || 'Ended early' });
}

export interface DiscountRequest { seq: number; pct: number; months: number; reason: string; by: string; at: string; status: 'with_elan1' | 'offered' | 'withdrawn' | 'declined'; offerSeq?: number; closedSeq?: number; lead: Elan1Person; needs: 'lead' | 'founder'; declinedReason?: string; declinedBy?: string }

/** What the owner has asked elan1 for. A request is never a discount: elan1 answers with an offer, or not. */
export function discountRequestsOf(d: OrgDB): DiscountRequest[] {
  const out: DiscountRequest[] = [];
  for (const r of d.receipts) {
    const x = r.details ?? {};
    if (r.action === 'billing.discount_requested') out.push({ seq: r.seq, pct: Number(x.pct), months: Number(x.months), reason: String(x.reason ?? ''), by: r.actor ?? '', at: r.ts, status: 'with_elan1', lead: accountLeadOf(d.org.id), needs: x.needs === 'founder' ? 'founder' : 'lead' });
    else if (r.action === 'billing.discount_request_withdrawn') { const q = out.find((v) => v.seq === Number(x.request)); if (q && q.status === 'with_elan1') { q.status = 'withdrawn'; q.closedSeq = r.seq; } }
    else if (r.action === 'billing.discount_offered' && isElan1Actor(r.actor) && x.request !== undefined) { const q = out.find((v) => v.seq === Number(x.request)); if (q && q.status === 'with_elan1') { q.status = 'offered'; q.offerSeq = r.seq; q.closedSeq = r.seq; } }
    else if (r.action === 'billing.discount_request_declined' && isElan1Actor(r.actor)) { const q = out.find((v) => v.seq === Number(x.request)); if (q && q.status === 'with_elan1') { q.status = 'declined'; q.closedSeq = r.seq; q.declinedReason = String(x.reason ?? ''); q.declinedBy = elan1Person(r.actor)?.name; } }
  }
  return out;
}

export function requestDiscount(orgId: string, userId: string, input: { pct: number; months: number; reason: string }) {
  requireOwner(orgId, userId, 'ask elan1 for a discount');
  if (!(input.pct > 0) || input.pct >= 100) throw new Error('Ask for a percentage above 0 and below 100.');
  if (!(input.months >= 1) || input.months > 36 || !Number.isInteger(input.months)) throw new Error('Ask for a whole number of months, 1 to 36. Every discount has an end date.');
  if (input.reason.trim().length < 10) throw new Error('Say why in at least 10 characters (expected volume, a competing quote, a renewal).');
  const d = getDB(orgId);
  if (discountRequestsOf(d).some((q) => q.status === 'with_elan1')) throw new Error('A request is already with elan1. Withdraw it first to ask again.');
  const lead = accountLeadOf(orgId);
  return logAdmin(orgId, userId, 'billing.discount_requested', { pct: input.pct, months: input.months, reason: input.reason.trim(), to: lead.name, needs: input.pct > DISCOUNT_CAP.leadPct || input.months > DISCOUNT_CAP.leadMonths ? 'founder' : 'lead' });
}

export function withdrawDiscountRequest(orgId: string, userId: string, requestSeq: number) {
  requireOwner(orgId, userId, 'withdraw a discount request');
  const q = discountRequestsOf(getDB(orgId)).find((x) => x.seq === requestSeq);
  if (!q || q.status !== 'with_elan1') throw new Error('There is no open request to withdraw.');
  return logAdmin(orgId, userId, 'billing.discount_request_withdrawn', { request: requestSeq });
}

/* ── Dispute settlements ──────────────────────────────────── */

export type SettlementOutcome = 'upheld' | 'partly_upheld' | 'rejected';
export const OUTCOME_LABEL: Record<SettlementOutcome, string> = { upheld: 'Upheld', partly_upheld: 'Partly upheld', rejected: 'Rejected' };
/** A credit above this needs a founder's approval as well as the billing desk's decision. */
export const SETTLEMENT_FOUNDER_ABOVE = 100000;

export interface Settlement { seq: number; dispute: number; outcome: SettlementOutcome; credit: number; creditNote?: string; note: string; decidedBy: string; decidedById: string; approvedBy?: string; recordedBy: string; at: string; invoice: string; line: string }

/** elan1's decisions on disputes. Only a record written by elan1's billing desk (or a founder) counts. */
export function settlementsOf(d: OrgDB): Settlement[] {
  return d.receipts.filter((r) => r.action === 'billing.dispute_settled' && isElan1Actor(r.actor)).map((r) => {
    const x = r.details ?? {};
    const p = elan1Person(r.actor)!;
    const outcome = (['upheld', 'partly_upheld', 'rejected'].includes(String(x.outcome)) ? x.outcome : 'rejected') as SettlementOutcome;
    return { seq: r.seq, dispute: Number(x.dispute), outcome, credit: Number(x.credit_amount ?? 0), creditNote: x.credit_note ? String(x.credit_note) : undefined, note: String(x.note ?? ''), decidedBy: `${p.name} (${p.title})`, decidedById: p.id, approvedBy: x.approved_by ? String(elan1Person(String(x.approved_by))?.name ?? x.approved_by) : undefined, recordedBy: r.actor ?? '', at: r.ts, invoice: String(x.invoice), line: String(x.line) };
  });
}

/** true when a record closes a dispute: the owner withdrew it, or elan1 decided it. */
export const closesDispute = (r: Receipt) => r.action === 'billing.dispute_withdrawn' || (r.action === 'billing.dispute_settled' && isElan1Actor(r.actor));

export const creditNoteNumber = (invoice: string, disputeSeq: number) => `CN-${invoice.replace(/^EG-/, '')}-${disputeSeq}`;

/**
 * elan1's side: decide an open dispute. Only elan1's billing desk or a founder decides; a credit above ₹1,00,000 also
 * names a founder who approved it. Upheld credits the whole line, partly upheld a part of it, rejected nothing.
 */
/**
 * The disputed line's amount (before GST), read from the invoice the chain meter builds — the same builder and the
 * same packs and counterparty seats /billing uses — never from the screen. undefined when no invoice carries that line.
 */
export function disputedLineAmount(d: OrgDB, invoice: string, line: string): number | undefined {
  const ctx: BillingContext = {
    packs: (d.platform?.packs ?? []).map((p) => ({ id: p.id, name: packById(p.id)?.name ?? p.id, installedAt: p.installedAt })),
    counterparties: (d.platform?.counterparties ?? []).map((c) => ({ id: c.id, name: c.name, seats: c.seats, since: c.since })),
  };
  const inv = buildInvoices(d, chainMeter(d), ctx).find((i) => i.kind !== 'credit_note' && i.number === invoice);
  const l = inv?.lines.find((x) => x.id === line);
  return l ? Math.round(l.amount * 100) / 100 : undefined;
}

export function settleDispute(orgId: string, staffId: string, input: { dispute: number; invoice: string; line: string; outcome: SettlementOutcome; credit: number; note: string; approvedBy?: string; seeded?: number; recordedBy?: string }) {
  const p = requireStaff(staffId, ['billing', 'founder'], 'decide a dispute');
  const d = getDB(orgId);
  const opened = d.receipts.find((r) => r.seq === input.dispute && r.action === 'billing.dispute_opened');
  if (!opened) throw new Error('No such dispute.');
  // the invoice and line come from the dispute record itself, never from the caller
  const invoice = String(opened.details?.invoice ?? input.invoice);
  const lineId = String(opened.details?.line ?? input.line);
  if (d.receipts.some((r) => closesDispute(r) && Number(r.details?.dispute) === input.dispute)) throw new Error('This dispute is already closed.');
  if (input.note.trim().length < 10) throw new Error('Give elan1’s reason in at least 10 characters.');
  // the line's amount from the invoice, less what earlier settlements on the same line already credited: the cap
  const lineAmount = disputedLineAmount(d, invoice, lineId);
  if (lineAmount === undefined && input.outcome !== 'rejected') throw new Error(`Line ${lineId} is not on invoice ${invoice}, so there is no amount to credit against.`);
  const already = settlementsOf(d).filter((s) => s.invoice === invoice && s.line === lineId).reduce((s, x) => s + x.credit, 0);
  const cap = Math.max(0, Math.round(((lineAmount ?? 0) - already) * 100) / 100);
  if (input.outcome !== 'rejected' && !(cap > 0)) throw new Error('This line has already been credited in full by an earlier settlement.');
  const credit = input.outcome === 'upheld' ? cap : input.outcome === 'rejected' ? 0 : Math.round(input.credit * 100) / 100;
  if (input.outcome === 'partly_upheld' && !(credit > 0 && credit < cap)) throw new Error(`A partly upheld dispute credits more than ₹0 and less than the line (₹${cap.toLocaleString('en-IN')}${already > 0 ? ' still uncredited' : ''}).`);
  if (credit > cap) throw new Error('The credit is more than the disputed line.');
  let approvedBy: string | undefined;
  if (credit > SETTLEMENT_FOUNDER_ABOVE && p.role !== 'founder') {
    const f = elan1Person(input.approvedBy);
    if (!f || f.role !== 'founder') throw new Error(`A credit above ₹${SETTLEMENT_FOUNDER_ABOVE.toLocaleString('en-IN')} needs a founder’s approval as well.`);
    approvedBy = f.id;
  }
  return append(d, { kind: 'admin', actor: p.id, action: 'billing.dispute_settled', details: {
    dispute: input.dispute, invoice, line: lineId, outcome: input.outcome, credit_amount: credit, ...(lineAmount !== undefined ? { line_amount: lineAmount } : {}),
    ...(credit > 0 ? { credit_note: creditNoteNumber(invoice, input.dispute) } : {}),
    note: input.note.trim(), decided_by: p.name, decided_by_role: p.role, ...(approvedBy ? { approved_by: approvedBy } : {}), ...(input.seeded ? { billing_seed: input.seeded } : {}),
    ...(input.recordedBy ? { recorded_by: input.recordedBy, demo_desk: true } : {}),
  } });
}

/* ── Disputes: opened and withdrawn by an owner ───────────── */

export interface OpenDispute { seq: number; invoice: string; line: string; reason: string; by: string; at: string; fromSeq?: number; toSeq?: number }

/** Disputes an owner opened that neither the owner withdrew nor elan1 decided. */
export function openDisputesOf(d: OrgDB): OpenDispute[] {
  const closed = new Set(d.receipts.filter(closesDispute).map((r) => Number(r.details?.dispute)));
  return d.receipts.filter((r) => r.action === 'billing.dispute_opened' && !closed.has(r.seq)).map((r) => {
    const x = r.details ?? {};
    return { seq: r.seq, invoice: String(x.invoice ?? ''), line: String(x.line ?? ''), reason: String(x.reason ?? ''), by: r.actor ?? '', at: r.ts, ...(x.from_seq !== undefined ? { fromSeq: Number(x.from_seq) } : {}), ...(x.to_seq !== undefined ? { toSeq: Number(x.to_seq) } : {}) };
  });
}

/** An owner disputes one invoice line: it is held while the rest of the invoice proceeds. The dispute is a receipt. */
export function openDispute(orgId: string, userId: string, input: { invoice: string; line: string; reason: string; fromSeq?: number; toSeq?: number }) {
  requireOwner(orgId, userId, 'dispute an invoice line');
  const reason = input.reason.trim();
  if (reason.length < 10) throw new Error('Say why in at least 10 characters.');
  if (input.fromSeq !== undefined && input.toSeq !== undefined && !(Number.isInteger(input.fromSeq) && Number.isInteger(input.toSeq) && input.fromSeq <= input.toSeq)) throw new Error('Name a range of receipts, the first no later than the last.');
  const d = getDB(orgId);
  if (openDisputesOf(d).some((x) => x.invoice === input.invoice && x.line === input.line)) throw new Error('This line is already held in dispute.');
  return logAdmin(orgId, userId, 'billing.dispute_opened', { invoice: input.invoice, line: input.line, reason, ...(input.fromSeq !== undefined && input.toSeq !== undefined ? { from_seq: input.fromSeq, to_seq: input.toSeq } : {}) });
}

/** An owner withdraws an open dispute: the line is payable again. */
export function withdrawDispute(orgId: string, userId: string, disputeSeq: number) {
  requireOwner(orgId, userId, 'withdraw a dispute');
  const q = openDisputesOf(getDB(orgId)).find((x) => x.seq === disputeSeq);
  if (!q) throw new Error('There is no open dispute to withdraw. elan1 may already have decided it.');
  return logAdmin(orgId, userId, 'billing.dispute_withdrawn', { dispute: disputeSeq, invoice: q.invoice, line: q.line });
}

/* ── Demo: elan1's billing desk ───────────────────────────────
 * A demo stand-in for elan1's side. An owner records the decision elan1 made on each request: a dispute, a discount
 * request or a request to reopen. The record is written as elan1's (its authority comes from elan1's staff list, as
 * every elan1 record does) and names the owner who recorded it, so it is never mistaken for a decision the
 * organisation made for itself. "Decided by" defaults to the billing desk. */

export const DESK_DEFAULT = BILLING_DESK;

export function deskSettleDispute(orgId: string, ownerId: string, input: { dispute: number; outcome: SettlementOutcome; credit: number; note: string; decidedBy?: string; approvedBy?: string }) {
  requireOwner(orgId, ownerId, 'record elan1’s decision on a dispute');
  const q = openDisputesOf(getDB(orgId)).find((x) => x.seq === input.dispute);
  if (!q) throw new Error('There is no open dispute with that number.');
  // the line's amount is read from the invoice in settleDispute; nothing the screen sends sets or raises it
  return settleDispute(orgId, input.decidedBy ?? DESK_DEFAULT, { dispute: q.seq, invoice: q.invoice, line: q.line, outcome: input.outcome, credit: input.credit, note: input.note, approvedBy: input.approvedBy, recordedBy: ownerId });
}

export function deskDecideDiscountRequest(orgId: string, ownerId: string, input: { request: number; grant: boolean; pct?: number; from?: string; until?: string; reason?: string; decidedBy?: string }) {
  requireOwner(orgId, ownerId, 'record elan1’s decision on a discount request');
  const d = getDB(orgId);
  const q = discountRequestsOf(d).find((x) => x.seq === input.request);
  if (!q || q.status !== 'with_elan1') throw new Error('There is no open discount request with that number.');
  const staff = input.decidedBy ?? DESK_DEFAULT;
  if (input.grant) {
    // granted: elan1 answers with an offer on the requested terms (or its own); an owner then accepts it under Discounts
    return offerDiscount(orgId, staff, { pct: Number(input.pct), from: String(input.from ?? ''), until: String(input.until ?? ''), reference: `REQ-${q.seq}`, request: q.seq, recordedBy: ownerId });
  }
  const p = requireStaff(staff, ['lead', 'founder', 'billing'], 'decline a discount request');
  const reason = (input.reason ?? '').trim();
  if (reason.length < 10) throw new Error('Give elan1’s reason in at least 10 characters.');
  return append(d, { kind: 'admin', actor: p.id, action: 'billing.discount_request_declined', details: { request: q.seq, reason, decided_by: p.name, decided_by_role: p.role, recorded_by: ownerId, demo_desk: true } });
}

export function deskDecideReopen(orgId: string, ownerId: string, input: { approve: boolean; note: string; decidedBy?: string }) {
  requireOwner(orgId, ownerId, 'record elan1’s decision on a request to reopen');
  const d = getDB(orgId);
  const p0 = pilotOf(d);
  if (!p0 || p0.status !== 'closed' || !p0.reopenRequestedSeq) throw new Error('There is no open request to reopen this organisation.');
  const p = requireStaff(input.decidedBy ?? DESK_DEFAULT, ['lead', 'founder', 'billing'], 'decide a request to reopen');
  const note = input.note.trim();
  if (note.length < 10) throw new Error('Give elan1’s reason in at least 10 characters.');
  const r = append(d, { kind: 'admin', actor: p.id, action: 'billing.reopen_decided', details: { request: p0.reopenRequestedSeq, outcome: input.approve ? 'approved' : 'declined', note, decided_by: p.name, decided_by_role: p.role, recorded_by: ownerId, demo_desk: true } });
  // approved: a new order on the paid Guarded plan, billed from today; writes resume
  if (input.approve) append(d, { kind: 'admin', actor: p.id, action: 'billing.pilot_converted', details: { plan: 'l1', via: 'reopen', used: p0.used, cap: p0.cap, refused_at_stop: p0.refusedAtStop, billed_from: new Date().toISOString(), reopen_decision: r.seq } });
  return r;
}

/* ── Reconciliation runs per period ───────────────────────── */

export interface ReconRun { seq: number; period: string; meterEvents: number; chainDecisions: number; meterUnits: number; chainUnits: number; matched: boolean; at: string; by: string; note?: string }

export function reconRunsOf(d: OrgDB): ReconRun[] {
  return d.receipts.filter((r) => r.action === 'billing.reconciliation_run').map((r) => {
    const x = r.details ?? {};
    return { seq: r.seq, period: String(x.period), meterEvents: Number(x.meter_events), chainDecisions: Number(x.chain_decisions), meterUnits: Number(x.meter_units), chainUnits: Number(x.chain_units), matched: x.matched === true || x.matched === 'true', at: r.ts, by: r.actor ?? 'system', note: x.note ? String(x.note) : undefined };
  });
}

/** The latest run for each period. A period whose latest run did not match holds its invoice. */
export function latestRuns(d: OrgDB): Map<string, ReconRun> {
  const out = new Map<string, ReconRun>();
  for (const r of reconRunsOf(d)) out.set(r.period, r);
  return out;
}

export const heldPeriods = (d: OrgDB) => [...latestRuns(d).values()].filter((r) => !r.matched).map((r) => r.period);

/** Production governed actions in a period, counted from the chain (sandbox calls are metered at 0). */
function chainCount(d: OrgDB, period: string) {
  const res = new Map<number, Receipt>();
  for (const r of d.receipts) if (r.kind === 'approval' && r.ref_seq !== undefined) res.set(r.ref_seq, r);
  let decisions = 0;
  let units = 0;
  for (const r of d.receipts) {
    if (r.kind !== 'decision' || monthOfT(new Date(r.ts).getTime()) !== period) continue;
    decisions++;
    if (r.environment === 'sandbox' || isPlatformRefusal(r)) continue; // metered at 0
    if (r.decision === 'allow') units += 1;
    else if (r.decision === 'refuse') units += 0.4;
    else { const a = res.get(r.seq); if (a) units += a.decision === 'allow' ? 1 : 0.4; }
  }
  return { decisions, units: Math.round(units * 10) / 10 };
}

/** Run the two-way reconciliation for a period again: the meter is rebuilt from the chain, so the period reconciles. */
export function rerunReconciliation(orgId: string, userId: string, period: string) {
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins run the reconciliation.');
  const d = getDB(orgId);
  const c = chainCount(d, period);
  const prev = latestRuns(d).get(period);
  return logAdmin(orgId, userId, 'billing.reconciliation_run', { period, meter_events: c.decisions, chain_decisions: c.decisions, meter_units: c.units, chain_units: c.units, matched: true, note: prev && !prev.matched ? `Meter rebuilt from the chain: ${c.decisions - prev.meterEvents} missing meter events replayed` : 'Meter and chain agree' });
}

/* ── Pilot ────────────────────────────────────────────────── */

export const PILOT = { days: 90, cap: 2000, readOnlyDays: 30, listPlan: 'l1' as LevelId, code: 'POLICY.TENANT_STOPPED' };

export interface PilotState {
  seq: number;
  starts: string;
  ends: string;
  cap: number;
  used: number;
  remaining: number;
  daysLeft: number;
  /** stopped: the cap was reached or an owner ended it early; ended: the 90 days ran out; closed: the 30 read-only days passed */
  status: 'active' | 'stopped' | 'ended' | 'converted' | 'closed';
  stoppedSeq?: number;
  stoppedAt?: string;
  stoppedWhy?: string;
  convertedSeq?: number;
  convertedAt?: string;
  /** the plan it moved to: Guarded, or a higher level when an upgrade ended the pilot */
  convertedTo?: LevelId;
  convertedVia?: 'owner' | 'upgrade';
  readOnlyUntil?: string;
  closedSeq?: number;
  closedAt?: string;
  reopenRequestedSeq?: number;
  /** elan1 declined the latest request to reopen (an owner may ask again) */
  reopenDeclined?: { seq: number; note: string; by: string };
  /** calls refused at the stop (they write no record) */
  refusedAtStop: number;
}

const stopKey = (orgId: string) => `eg:data:billing-pilot-stopped:${orgId}`;
function stoppedCalls(orgId: string): number {
  try { return Number(localStorage.getItem(stopKey(orgId)) ?? 0) || 0; } catch { return 0; }
}
function bumpStoppedCalls(orgId: string) {
  try { localStorage.setItem(stopKey(orgId), String(stoppedCalls(orgId) + 1)); } catch { /* fine */ }
}

/** The pilot's start record, cached by how far the chain was read (append asks on every write). */
const pilotStartCache = new WeakMap<OrgDB, { n: number; seq?: number }>();
function pilotStart(d: OrgDB): Receipt | undefined {
  const c = pilotStartCache.get(d) ?? { n: 0 };
  if (c.seq === undefined) {
    for (let i = c.n; i < d.receipts.length; i++) if (d.receipts[i].action === 'billing.pilot_started') { c.seq = d.receipts[i].seq; break; }
    c.n = d.receipts.length;
    pilotStartCache.set(d, c);
  }
  return c.seq === undefined ? undefined : d.receipts.find((r) => r.seq === c.seq);
}

export function pilotOf(d: OrgDB, now = Date.now()): PilotState | undefined {
  const start = pilotStart(d);
  if (!start) return undefined;
  const x = start.details ?? {};
  const starts = String(x.starts ?? start.ts);
  const ends = String(x.ends ?? new Date(new Date(starts).getTime() + PILOT.days * D).toISOString());
  const cap = Number(x.cap ?? PILOT.cap);
  const after = d.receipts.filter((r) => r.seq > start.seq && typeof r.action === 'string' && r.action.startsWith('billing.'));
  const stopped = after.find((r) => r.action === 'billing.pilot_stopped');
  const converted = after.find((r) => r.action === 'billing.pilot_converted');
  const closed = after.find((r) => r.action === 'billing.pilot_closed');
  // the latest request to reopen, until elan1 decides it (a declined request can be made again)
  const reopenAsked = after.filter((r) => r.action === 'billing.reopen_requested').pop();
  const reopenDecided = reopenAsked ? after.find((r) => r.action === 'billing.reopen_decided' && isElan1Actor(r.actor) && Number(r.details?.request) === reopenAsked.seq) : undefined;
  const reopen = reopenDecided ? undefined : reopenAsked;
  const t0 = new Date(starts).getTime();
  const endT = new Date(ends).getTime();
  const convertedT = converted ? new Date(atOf(converted)).getTime() : undefined;
  // production governed actions while the pilot ran (sandbox calls and PLATFORM refusals are metered at 0 and never count)
  const counted = d.receipts.filter((r) => {
    if (r.kind !== 'decision' || r.environment === 'sandbox' || isPlatformRefusal(r)) return false;
    const t = new Date(r.ts).getTime();
    return t >= t0 && t < (convertedT ?? Infinity);
  });
  const recorded = Math.max(Number(stopped?.details?.used ?? 0), Number(converted?.details?.used ?? 0));
  const used = Math.max(counted.length, recorded);
  const capT = counted.length >= cap ? new Date(counted[cap - 1].ts).getTime() + 1 : undefined;
  const stopT = stopped ? new Date(atOf(stopped)).getTime() : capT !== undefined && capT < endT ? capT : now >= endT ? endT : undefined;
  const readOnlyUntilT = stopT !== undefined ? stopT + PILOT.readOnlyDays * D : undefined;
  const why = stopped ? String(stopped.details?.why ?? '') : capT !== undefined && capT < endT ? `${cap} governed actions used` : stopT !== undefined ? `${PILOT.days} days ended` : undefined;
  const status: PilotState['status'] = converted ? 'converted'
    : closed || (readOnlyUntilT !== undefined && now >= readOnlyUntilT) ? 'closed'
    : stopT !== undefined ? (why?.includes('days ended') ? 'ended' : 'stopped')
    : 'active';
  return {
    seq: start.seq, starts, ends, cap, used, remaining: Math.max(0, cap - used), daysLeft: Math.max(0, Math.ceil((endT - now) / D)), status,
    stoppedSeq: stopped?.seq, stoppedAt: stopT !== undefined ? new Date(stopT).toISOString() : undefined, stoppedWhy: why,
    convertedSeq: converted?.seq, convertedAt: converted ? atOf(converted) : undefined,
    convertedTo: converted ? (String(converted.details?.plan ?? 'l1') as LevelId) : undefined,
    convertedVia: converted ? (converted.details?.via === 'upgrade' ? 'upgrade' : 'owner') : undefined,
    readOnlyUntil: readOnlyUntilT !== undefined && !converted ? new Date(readOnlyUntilT).toISOString() : undefined,
    closedSeq: closed?.seq, closedAt: closed ? atOf(closed) : status === 'closed' && readOnlyUntilT !== undefined ? new Date(readOnlyUntilT).toISOString() : undefined,
    reopenRequestedSeq: reopen?.seq,
    ...(reopenDecided && reopenDecided.details?.outcome === 'declined' ? { reopenDeclined: { seq: reopenDecided.seq, note: String(reopenDecided.details?.note ?? ''), by: elan1Person(reopenDecided.actor)?.name ?? 'elan1' } } : {}),
    refusedAtStop: converted && converted.details?.refused_at_stop !== undefined ? Number(converted.details.refused_at_stop) : closed && closed.details?.refused_at_stop !== undefined ? Math.max(Number(closed.details.refused_at_stop), stoppedCalls(d.org.id)) : stoppedCalls(d.org.id),
  };
}

/** true while the pilot holds the organisation read-only (stopped, ended or closed, and not moved to the paid plan). */
export const pilotPaused = (p?: PilotState) => !!p && (p.status === 'stopped' || p.status === 'ended' || p.status === 'closed');

/** Start the pilot (a self-serve organisation at Guarded that has never been billed). */
export function startPilot(orgId: string, userId: string) {
  requireOwner(orgId, userId, 'start the pilot');
  const d = getDB(orgId);
  if (pilotOf(d)) throw new Error('This organisation has already had its pilot.');
  if (!d.fresh) throw new Error('The pilot is for a new organisation that has not been billed yet.');
  if (levelOfOrg(d.org) !== 'l1') throw new Error('The pilot covers Guarded only.');
  const now = Date.now();
  return logAdmin(orgId, userId, 'billing.pilot_started', { starts: new Date(now).toISOString(), ends: new Date(now + PILOT.days * D).toISOString(), cap: PILOT.cap, list_plan: PILOT.listPlan, list_floor: 180000, list_rate: 1.6 });
}

/** An owner ends the pilot before its limit: the same hard stop as reaching it. */
export function endPilotNow(orgId: string, userId: string, reason: string) {
  requireOwner(orgId, userId, 'end the pilot');
  const d = getDB(orgId);
  const p = pilotOf(d);
  if (!p || p.status !== 'active') throw new Error('There is no running pilot to end.');
  return append(d, { kind: 'admin', actor: userId, action: 'billing.pilot_stopped', details: { why: `ended early by an owner${reason.trim() ? `: ${reason.trim()}` : ''}`, used: p.used, cap: p.cap, code: PILOT.code, read_only_days: PILOT.readOnlyDays } });
}

/** Leave the pilot for the paid plan at the level in force (Guarded): billing starts from today, the floor pro rata. Lifts a stop. */
export function convertPilot(orgId: string, userId: string) {
  requireOwner(orgId, userId, 'move to the paid plan');
  const d = getDB(orgId);
  const p = pilotOf(d);
  if (!p) throw new Error('This organisation is not on a pilot.');
  if (p.status === 'converted') throw new Error('The pilot has already moved to the paid plan.');
  if (p.status === 'closed') throw new Error('The organisation is closed: its 30 read-only days have passed. Ask elan1 to reopen it.');
  const refused = stoppedCalls(orgId);
  try { localStorage.removeItem(stopKey(orgId)); } catch { /* fine */ }
  return logAdmin(orgId, userId, 'billing.pilot_converted', { plan: levelOfOrg(d.org), via: 'owner', used: p.used, cap: p.cap, refused_at_stop: refused, billed_from: new Date().toISOString() });
}

/** After closure: ask elan1 to reopen the organisation on a paid plan (a new order). */
export function requestReopen(orgId: string, userId: string) {
  requireOwner(orgId, userId, 'ask elan1 to reopen the organisation');
  const p = pilotOf(getDB(orgId));
  if (!p || p.status !== 'closed') throw new Error('Only a closed organisation is reopened.');
  if (p.reopenRequestedSeq) throw new Error('A request to reopen is already with elan1.');
  return logAdmin(orgId, userId, 'billing.reopen_requested', { plan: 'l1', to: accountLeadOf(orgId).name });
}

/**
 * Before an upgrade. A running pilot covers Guarded only, so an upgrade ends it and billing at the new level starts
 * at the boundary; a stopped pilot blocks the upgrade (writes are paused until an owner moves to the paid plan).
 */
export function pilotUpgradeCheck(d: OrgDB): { whyNot?: string; note?: string } {
  const p = pilotOf(d);
  if (!p || p.status === 'converted') return {};
  if (pilotPaused(p)) return { whyNot: p.status === 'closed' ? 'The organisation is closed after its pilot. Ask elan1 to reopen it on a paid plan first.' : `Writes are paused (${PILOT.code}): the pilot has stopped. Move to the paid plan on the Meter page first, then upgrade.` };
  return { note: 'This organisation is on the free Guarded pilot: the upgrade ends it, and billing at the new level starts at the boundary.' };
}

/** After a successful upgrade: a running pilot ends there, moved to the paid plan at the new level. */
export function endPilotOnUpgrade(d: OrgDB, userId: string, to: LevelId) {
  const p = pilotOf(d);
  if (!p || p.status !== 'active') return undefined;
  return append(d, { kind: 'admin', actor: userId, action: 'billing.pilot_converted', details: { plan: to, via: 'upgrade', used: p.used, cap: p.cap, billed_from: new Date().toISOString() } });
}

/** Record the stop and the closure once they are due (on open, and before a refused call). */
export function sweepPilot(d: OrgDB) {
  const p = pilotOf(d);
  if (!p || p.status === 'active' || p.status === 'converted') return;
  if (!p.stoppedSeq) {
    append(d, { kind: 'admin', actor: 'system', action: 'billing.pilot_stopped', details: { why: p.stoppedWhy ?? `${PILOT.days} days ended`, used: p.used, cap: p.cap, code: PILOT.code, read_only_days: PILOT.readOnlyDays, ...(p.stoppedAt ? { at: p.stoppedAt } : {}) } });
  }
  const q = pilotOf(d);
  if (q?.status === 'closed' && !q.closedSeq) {
    append(d, { kind: 'admin', actor: 'system', action: 'billing.pilot_closed', details: { stopped: q.stoppedSeq ?? 0, read_only_days: PILOT.readOnlyDays, refused_at_stop: stoppedCalls(d.org.id), ...(q.closedAt ? { at: q.closedAt } : {}) } });
  }
}

/**
 * The pilot's hard stop, checked by the guard before anything else. At 2,000 governed actions (or after 90 days, or
 * when an owner ends it) the stop event is recorded once; from then on every production call is refused with
 * POLICY.TENANT_STOPPED and, as the code requires, no record is written. Sandbox calls (sk_sbx_) are metered at 0 and
 * are never stopped.
 */
export function pilotGate(d: OrgDB, environment?: 'sandbox'): Receipt | undefined {
  if (environment === 'sandbox') return undefined;
  if (!pilotStart(d)) return undefined;
  const p = pilotOf(d);
  if (!p || !pilotPaused(p)) return undefined;
  sweepPilot(d);
  bumpStoppedCalls(d.org.id);
  const head = d.receipts[d.receipts.length - 1];
  const closed = p.status === 'closed';
  // not appended: POLICY.TENANT_STOPPED is the one refusal with no record
  return {
    seq: 0, ts: new Date().toISOString(), org: d.org.id, kind: 'decision', decision: 'refuse', rule_id: PILOT.code,
    reason: closed
      ? 'The organisation is closed: its pilot stopped and the 30 read-only days have passed. No call runs. No record is written for this refusal.'
      : `Writes are paused: the pilot ${p.stoppedWhy?.startsWith('ended early') ? 'was ended early by an owner' : p.used >= p.cap ? `has used its ${p.cap.toLocaleString('en-IN')} governed actions` : `ended after ${PILOT.days} days`}. An owner moves to the paid plan on the Meter page to resume. No record is written for this refusal.`,
    outcome: { status: 'not_run' }, details: { code: PILOT.code, recorded: false }, prev_hash: head?.hash ?? '', kid: '', hash: '', sig: '',
  } as Receipt;
}

/** What a person may still do while the pilot holds the organisation read-only: sign in, look after their own access, export, settle the bill. */
const READ_ONLY_ALLOWED = ['auth.', 'session.', 'billing.', 'evidence.', 'export', 'erasure.', 'stop.', 'health.', 'checkpoint'];
const READ_ONLY_ALLOWED_ACTIONS = new Set(['member.mfa_enrolled', 'member.password_changed', 'member.password_reset_requested', 'member.suspended', 'member.removed', 'member.invite_revoked']);

/** Why a write is refused while the pilot holds the organisation read-only, or undefined when it may go ahead. */
export function pilotReadOnlyReason(d: OrgDB, body: { kind: Receipt['kind']; actor?: string; action?: string }): string | undefined {
  if (!pilotStart(d)) return undefined;
  if (!body.actor || body.actor === 'system' || isElan1Actor(body.actor)) return undefined;
  if (body.kind === 'decision' || body.kind === 'outcome') return undefined;
  if (body.kind === 'admin' && body.action && (READ_ONLY_ALLOWED.some((p) => body.action!.startsWith(p)) || READ_ONLY_ALLOWED_ACTIONS.has(body.action))) return undefined;
  const p = pilotOf(d);
  if (!p || !pilotPaused(p)) return undefined;
  return p.status === 'closed'
    ? `The organisation is closed: its pilot stopped (${PILOT.code}) and the ${PILOT.readOnlyDays} read-only days passed on ${dayOfT(new Date(p.closedAt ?? Date.now()).getTime())}. Nothing can be changed. Records can still be exported; an owner can ask elan1 to reopen it on the Meter page.`
    : `Writes are paused (${PILOT.code}): the pilot has stopped and the organisation is read-only until ${dayOfT(new Date(p.readOnlyUntil ?? Date.now()).getTime())}. An owner moves to the paid plan on the Meter page to make changes again.`;
}

/** Throw when the organisation is read-only after its pilot. Called before a change is made, so nothing is half done. */
export function assertPilotWritable(orgId: string, userId?: string, action = 'change') {
  const reason = pilotReadOnlyReason(getDB(orgId), { kind: 'admin', actor: userId ?? 'someone', action });
  if (reason) throw new Error(reason);
}

/* ── Seed: what each demo organisation shows ──────────────── */

const SEED_ORGS = new Set(['org_demo', 'org_northbank', 'org_kaveri', 'org_deccan']);
const seededV = (d: OrgDB, v: number) => d.receipts.some((r) => String(r.action ?? '').startsWith('billing.') && (v === 1 ? r.details?.seeded === true : Number(r.details?.billing_seed) === v));

/**
 * Once per organisation. A sign-up organisation starts on the pilot. Demo Traders started on the pilot in June, hit
 * the 2,000-action stop in July and moved to the paid plan. Northbank has a lead's discount it accepted and last
 * month's period held by the reconciliation; Kaveri has a dispute elan1's billing desk partly upheld with a credit
 * note, and an offer from its account lead waiting for an owner; Deccan has a founder's discount beyond the lead's cap.
 */
export function ensureBillingSeed(d: OrgDB) {
  if (!d.receipts.length) return;
  sweepPilot(d);
  const now = Date.now();
  const thisMonth = monthOfT(now);
  const [y, m] = thisMonth.split('-').map(Number);
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  if (d.fresh) {
    if (pilotStart(d) || levelOfOrg(d.org) !== 'l1' || d.receipts.some((r) => r.action === 'billing.pilot_converted')) return;
    const t0 = new Date(d.org.createdAt ?? d.receipts[0].ts).getTime();
    append(d, { kind: 'admin', actor: 'system', action: 'billing.pilot_started', details: { starts: new Date(t0).toISOString(), ends: new Date(t0 + PILOT.days * D).toISOString(), cap: PILOT.cap, list_plan: PILOT.listPlan, list_floor: 180000, list_rate: 1.6, seeded: true } });
    return;
  }
  if (!SEED_ORGS.has(d.org.id)) return;
  const prefix = d.org.slug.split('-')[0].toUpperCase().slice(0, 4);
  const owner = d.members.find((x) => x.role === 'owner' && x.status === 'active')?.userId ?? 'system';

  if (!seededV(d, 1)) {
    if (d.org.id === 'org_northbank') {
      const c = chainCount(d, lastMonth);
      if (c.decisions > 3) append(d, { kind: 'admin', actor: 'system', action: 'billing.reconciliation_run', details: { period: lastMonth, meter_events: c.decisions - 3, chain_decisions: c.decisions, meter_units: Math.round((c.units - 2.4) * 10) / 10, chain_units: c.units, matched: false, note: 'Nightly two-way run: 3 decisions in the chain have no meter event', seeded: true } });
    }
    // the nightly two-way run for the open month: meter and chain agree
    const c = chainCount(d, thisMonth);
    append(d, { kind: 'admin', actor: 'system', action: 'billing.reconciliation_run', details: { period: thisMonth, meter_events: c.decisions, chain_decisions: c.decisions, meter_units: c.units, chain_units: c.units, matched: true, note: 'Nightly two-way run: meter and chain agree', seeded: true } });
  }

  if (seededV(d, 2)) return;
  const S = 2;
  if (d.org.id === 'org_demo') {
    // the pilot ran from sign-up on 2 June, stopped at 2,000 governed actions on day 52, and moved to the paid plan two days later
    const starts = new Date(d.org.createdAt).toISOString();
    const t0 = new Date(starts).getTime();
    const stopAt = new Date(Math.min(t0 + 52 * D + 3.7 * H, now - 3 * D)).toISOString();
    const convAt = new Date(Math.min(new Date(stopAt).getTime() + 2 * D + 6 * H, now - D)).toISOString();
    append(d, { kind: 'admin', actor: 'system', action: 'billing.pilot_started', details: { starts, ends: new Date(t0 + PILOT.days * D).toISOString(), cap: PILOT.cap, list_plan: PILOT.listPlan, list_floor: 180000, list_rate: 1.6, at: starts, billing_seed: S } });
    append(d, { kind: 'admin', actor: 'system', action: 'billing.pilot_stopped', details: { why: `${PILOT.cap} governed actions used`, used: PILOT.cap, cap: PILOT.cap, code: PILOT.code, read_only_days: PILOT.readOnlyDays, at: stopAt, billing_seed: S } });
    append(d, { kind: 'admin', actor: owner, action: 'billing.pilot_converted', details: { plan: 'l1', via: 'owner', used: PILOT.cap, cap: PILOT.cap, refused_at_stop: 143, billed_from: convAt, at: convAt, billing_seed: S } });
  } else if (d.org.id === 'org_northbank') {
    const o = offerDiscount(d.org.id, 'elan1:meera.iyer', { pct: 15, from: '2026-07-01', until: '2027-06-30', reference: 'NB-COMM-2026-07', at: '2026-06-24T06:30:00.000Z', validDays: 30, seeded: S });
    append(d, { kind: 'admin', actor: owner, action: 'billing.discount_accepted', details: { offer: o.seq, pct: 15, until: '2027-06-30', offered_by: 'Meera Iyer', at: '2026-06-26T08:10:00.000Z', billing_seed: S } });
  } else if (d.org.id === 'org_kaveri') {
    const hist = d.org.levelHistory?.length ? d.org.levelHistory : [{ level: d.org.plan as LevelId, from: d.org.createdAt }];
    const mid = dayStart(`${lastMonth}-15`);
    let lv = hist[0].level as LevelId;
    for (const h of hist) if (new Date(h.from).getTime() <= mid) lv = h.level as LevelId;
    const invoice = `EG-${prefix}-${lastMonth.replace('-', '')}`;
    const line = `${lv}-floor`;
    if (lv !== 'sovereign' && d.receipts.some((r) => monthOfT(new Date(r.ts).getTime()) <= lastMonth)) {
      // a dispute an owner opened (kept from an earlier seed if there is one), decided by elan1's billing desk
      const opened = d.receipts.find((r) => r.action === 'billing.dispute_opened' && r.details?.seeded === true)
        ?? append(d, { kind: 'admin', actor: owner, action: 'billing.dispute_opened', details: { invoice, line, reason: 'Floor charged for the first three days of the month while the custody ceremony was still open; asked for those days at the lower rate.', billing_seed: S } });
      const x = opened.details ?? {};
      if (!d.receipts.some((r) => closesDispute(r) && Number(r.details?.dispute) === opened.seq)) {
        settleDispute(d.org.id, BILLING_DESK, { dispute: opened.seq, invoice: String(x.invoice ?? invoice), line: String(x.line ?? line), outcome: 'partly_upheld', credit: 10000, note: 'Ceremony log confirms two of the three days; those two days are credited, the third stands.', seeded: S });
      }
    }
    offerDiscount(d.org.id, 'elan1:karthik.nair', { pct: 10, from: dayOfT(now), until: dayOfT(now + 182 * D), reference: 'KHN-RENEW-2026-10', validDays: 21, seeded: S });
  } else if (d.org.id === 'org_deccan') {
    // a founder may go beyond the lead's cap (25% here), still with an end date: twelve months from the start
    const [ly, lm] = lastMonth.split('-').map(Number);
    const until = new Date(Date.UTC(ly + 1, lm - 1, 0)).toISOString().slice(0, 10);
    const o = offerDiscount(d.org.id, 'elan1:founder', { pct: 25, from: `${lastMonth}-01`, until, reference: 'DCB-SOV-LAUNCH', at: new Date(dayStart(`${lastMonth}-01`) - 4 * D).toISOString(), seeded: S });
    append(d, { kind: 'admin', actor: owner, action: 'billing.discount_accepted', details: { offer: o.seq, pct: 25, until, offered_by: 'elan1 founder', at: new Date(dayStart(`${lastMonth}-01`) - 2 * D).toISOString(), billing_seed: S } });
  }
}

export { dayOfT as istDay, monthOfT as istMonth };
