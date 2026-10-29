import {
  acceptedFrom,
  buildInvoices,
  invoicePrefix,
  meterEvents,
  PLAN_IDS,
  type BillingInput,
  type ComputedInvoice,
  type InvoiceLine,
  type MeterReceipt,
  type PlanId,
  type Receipt,
} from "@gate/core";
import { forOrg, issueInvoice, meterReceipts, storeCreditNote, storeInvoice, type ChainTx } from "@gate/db";
import { z } from "zod";
import { fail, type WiringRoutes } from "../console-wiring";
import type { Deps } from "../deps";
import { invoicePdf } from "../invoice-pdf";

/*
 * The billing ledger under the console's billing screens. The console's own billing operations stay its own (their
 * rules are the approved console's, mock/billing.ts) and write billing.* receipts; when those receipts are written to
 * the organisation's chain (console-chain.ts writeConsoleReceipts), the same transaction writes what they say into the
 * ledger tables (projectBilling): the pilot on BillingAccount, offers and answers on Discount, requests on
 * DiscountRequest, disputes and settlements on Dispute, reconciliation runs. A receipt the chain refuses leaves no
 * ledger row behind; one applied twice changes nothing (each row carries the seq of the receipt that made it).
 *
 * Invoices and credit notes are computed from the chain and the ledger with core's buildInvoices and stored (the
 * ledger route below, which the console's meter reads go through): a draft or held invoice takes the new figures,
 * an issued one never changes (the database refuses), a credit note is written once.
 */

/** elan1 staff write their side of the ledger (offers, settlements, answers) under these console ids. */
const isStaff = (actor: string | undefined) => !!actor && actor.startsWith("elan1:");
const atOf = (r: Receipt) => new Date(typeof r.details?.at === "string" ? r.details.at : r.ts);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const paise = (rupees: unknown) => Math.round(num(rupees) * 100);
const bp = (pct: unknown) => Math.round(num(pct) * 100);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function accountIn(tx: ChainTx, orgId: string) {
  const a = await tx.billingAccount.findFirst();
  if (a) return a;
  const org = await tx.org.findFirstOrThrow({ select: { name: true, level: true } });
  return tx.billingAccount.create({ data: { orgId, plan: (PLAN_IDS as readonly string[]).includes(org.level) ? org.level : "l1", invoicePrefix: invoicePrefix(org.name), buyerName: org.name } });
}

/** One billing receipt into the ledger, in the transaction that wrote it (or again, idempotently, from the chain). */
async function projectOne(tx: ChainTx, orgId: string, r: Receipt) {
  const x = r.details ?? {};
  const at = atOf(r);
  switch (r.action) {
    case "billing.pilot_started": {
      const a = await accountIn(tx, orgId);
      if (a.pilotStartsAt) return;
      const starts = new Date(str(x.starts) || r.ts);
      await tx.billingAccount.updateMany({ data: { pilotStartsAt: starts, pilotEndsAt: x.ends ? new Date(str(x.ends)) : null, pilotCap: Number.isFinite(num(x.cap)) ? num(x.cap) : null } });
      return;
    }
    case "billing.pilot_stopped":
      await accountIn(tx, orgId);
      await tx.billingAccount.updateMany({ where: { pilotStoppedAt: null, pilotStartsAt: { not: null } }, data: { pilotStoppedAt: at, pilotStoppedWhy: str(x.why), pilotStoppedSeq: r.seq } });
      return;
    case "billing.pilot_converted":
      await accountIn(tx, orgId);
      await tx.billingAccount.updateMany({ where: { pilotConvertedAt: null, pilotStartsAt: { not: null } }, data: { pilotConvertedAt: x.billed_from ? new Date(str(x.billed_from)) : at, pilotConvertedTo: str(x.plan) || "l1" } });
      return;
    case "billing.pilot_closed":
      await tx.billingAccount.updateMany({ where: { pilotClosedAt: null, pilotStartsAt: { not: null } }, data: { pilotClosedAt: at } });
      return;
    case "billing.discount_offered": {
      if (!isStaff(r.actor) || (await tx.discount.findFirst({ where: { offerSeq: r.seq }, select: { id: true } }))) return;
      const from = str(x.from);
      const until = str(x.until);
      if (!DAY.test(from) || !DAY.test(until)) return;
      const request = x.request === undefined ? null : await tx.discountRequest.findFirst({ where: { seq: num(x.request) } });
      const offer = await tx.discount.create({
        data: {
          orgId,
          pctBasisPoints: bp(x.pct),
          fromDay: from,
          untilDay: until,
          offeredBy: r.actor!,
          offeredByRole: str(x.offered_by_role) || "lead",
          reference: str(x.reference) || null,
          validUntil: str(x.valid_until) || until,
          requestId: request?.id ?? null,
          offerSeq: r.seq,
          createdAt: at,
        },
      });
      if (request?.status === "with_elan1") await tx.discountRequest.updateMany({ where: { id: request.id }, data: { status: "offered", offerId: offer.id, closedAt: at } });
      return;
    }
    case "billing.discount_accepted": {
      const offer = await tx.discount.findFirst({ where: { offerSeq: num(x.offer), status: "offered" } });
      if (offer) await tx.discount.updateMany({ where: { id: offer.id }, data: { status: "accepted", acceptedBy: str(r.actor), acceptedAt: at, acceptedSeq: r.seq, fromDay: acceptedFrom(offer.fromDay, at.getTime()) } });
      return;
    }
    case "billing.discount_declined":
      await tx.discount.updateMany({ where: { offerSeq: num(x.offer), status: "offered" }, data: { status: "declined", declinedReason: str(x.reason) } });
      return;
    case "billing.discount_ended":
      await tx.discount.updateMany({ where: { offerSeq: num(x.discount), status: "accepted", endedAt: null }, data: { endedAt: at, endedReason: str(x.reason) } });
      return;
    case "billing.discount_requested":
      if (await tx.discountRequest.findFirst({ where: { seq: r.seq }, select: { id: true } })) return;
      await tx.discountRequest.create({ data: { orgId, pctBasisPoints: bp(x.pct), months: Math.round(num(x.months)), reason: str(x.reason), requestedBy: str(r.actor), needs: x.needs === "founder" ? "founder" : "lead", seq: r.seq, createdAt: at } });
      return;
    case "billing.discount_request_withdrawn":
      await tx.discountRequest.updateMany({ where: { seq: num(x.request), status: "with_elan1" }, data: { status: "withdrawn", closedAt: at } });
      return;
    case "billing.discount_request_declined":
      if (!isStaff(r.actor)) return;
      await tx.discountRequest.updateMany({ where: { seq: num(x.request), status: "with_elan1" }, data: { status: "declined", declinedReason: str(x.reason), declinedBy: str(r.actor), closedAt: at } });
      return;
    case "billing.dispute_opened":
      if (await tx.dispute.findFirst({ where: { seq: r.seq }, select: { id: true } })) return;
      await tx.dispute.create({
        data: { orgId, invoiceNumber: str(x.invoice), line: str(x.line), reason: str(x.reason), fromSeq: x.from_seq === undefined ? null : num(x.from_seq), toSeq: x.to_seq === undefined ? null : num(x.to_seq), openedBy: str(r.actor), seq: r.seq, createdAt: at },
      });
      return;
    case "billing.dispute_withdrawn":
      await tx.dispute.updateMany({ where: { seq: num(x.dispute), status: "open" }, data: { status: "withdrawn", closedAt: at } });
      return;
    case "billing.dispute_settled":
      if (!isStaff(r.actor)) return;
      await tx.dispute.updateMany({
        where: { seq: num(x.dispute), status: "open" },
        data: {
          status: "settled",
          outcome: str(x.outcome),
          linePaise: x.line_amount === undefined ? null : BigInt(paise(x.line_amount)),
          creditPaise: BigInt(paise(x.credit_amount ?? 0)),
          creditNoteNumber: x.credit_note ? str(x.credit_note) : null,
          note: str(x.note),
          decidedBy: str(r.actor),
          decidedByRole: str(x.decided_by_role) || null,
          approvedBy: x.approved_by ? str(x.approved_by) : null,
          settleSeq: r.seq,
          closedAt: at,
        },
      });
      return;
    case "billing.reconciliation_run":
      if (await tx.reconciliationRun.findFirst({ where: { seq: r.seq }, select: { id: true } })) return;
      await tx.reconciliationRun.create({
        data: {
          orgId,
          period: str(x.period),
          meterEvents: Math.round(num(x.meter_events)),
          chainDecisions: Math.round(num(x.chain_decisions)),
          meterTenths: Math.round(num(x.meter_units) * 10),
          chainTenths: Math.round(num(x.chain_units) * 10),
          matched: x.matched === true,
          note: x.note === undefined ? null : str(x.note),
          runBy: str(r.actor),
          seq: r.seq,
          createdAt: at,
        },
      });
      return;
    default:
      return;
  }
}

/** The ledger rows the billing receipts among `receipts` stand for (inside the chain transaction that wrote them). */
export async function projectBilling(tx: ChainTx, orgId: string, receipts: readonly Receipt[]) {
  for (const r of receipts) if (r.kind === "admin" && r.action?.startsWith("billing.")) await projectOne(tx, orgId, r);
}

/** Bring the ledger up to every billing receipt on the chain (receipts written before the ledger followed them). */
async function catchUp(deps: Deps, orgId: string) {
  const db = forOrg(orgId, deps.db);
  const rows = await db.receipt.findMany({ where: { kind: "admin", action: { startsWith: "billing." } }, orderBy: { seq: "asc" }, select: { body: true } });
  if (!rows.length) return;
  await db.$transaction((tx) => projectBilling(tx, orgId, rows.map((r) => r.body as unknown as Receipt)), { timeout: 60_000 });
}

/** Admin receipts the invoices price (bundles, packs, seats, profiles), with the meter's receipts. */
const PRICED_ACTIONS = ["evidence.exported", "pack.installed", "pack.uninstalled", "counterparty.seats.changed", "billing.addon_ordered", "billing.addon_cancelled"];

/** What only the console's document knows: the level history, installed packs and counterparties' seats. */
export const LedgerFacts = z
  .object({
    levelHistory: z.array(z.object({ level: z.enum(PLAN_IDS as unknown as [PlanId, ...PlanId[]]), from: z.string().max(40) }).strict()).max(50).default([]),
    packs: z.array(z.object({ id: z.string().max(80), name: z.string().max(200), installedAt: z.string().max(40).optional() }).strict()).max(100).default([]),
    counterparties: z.array(z.object({ id: z.string().max(80).optional(), name: z.string().max(200), seats: z.number().int().min(0).max(100_000), since: z.string().max(40) }).strict()).max(500).default([]),
    residency: z.string().max(200).optional(),
    /** when the organisation began, as the console counts it (its level history starts there) */
    createdAt: z.string().max(40).refine((v) => Number.isFinite(Date.parse(v)), "a date").optional(),
  })
  .strict();
export type LedgerFacts = z.infer<typeof LedgerFacts>;

const n = (b: bigint | null | undefined) => (b === null || b === undefined ? null : Number(b));

/** The organisation's ledger as the console's screens read it (money in paise, as integers). */
async function ledgerView(deps: Deps, orgId: string) {
  const db = forOrg(orgId, deps.db);
  const [account, invoices, creditNotes, discounts, requests, disputes, runs] = await Promise.all([
    db.billingAccount.findFirst(),
    db.invoice.findMany({ orderBy: { periodStart: "asc" } }),
    db.creditNote.findMany({ orderBy: { issuedAt: "asc" } }),
    db.discount.findMany({ orderBy: { createdAt: "asc" } }),
    db.discountRequest.findMany({ orderBy: { createdAt: "asc" } }),
    db.dispute.findMany({ orderBy: { createdAt: "asc" } }),
    db.reconciliationRun.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  return {
    account,
    invoices: invoices.map((i) => ({ ...i, subtotalPaise: n(i.subtotalPaise), gstPaise: n(i.gstPaise), totalPaise: n(i.totalPaise), heldPaise: n(i.heldPaise), payablePaise: n(i.payablePaise) })),
    creditNotes: creditNotes.map((c) => ({ ...c, amountPaise: n(c.amountPaise), gstPaise: n(c.gstPaise), totalPaise: n(c.totalPaise) })),
    discounts,
    requests,
    disputes: disputes.map((d) => ({ ...d, linePaise: n(d.linePaise), creditPaise: n(d.creditPaise) })),
    runs,
  };
}

/**
 * The ledger brought up to the chain: billing receipts projected, every invoice and credit note computed from the
 * chain and the ledger and stored (a closed month's invoice issued once and never changed). Returns the ledger and
 * the chain's own count of governed actions, for the meter's reconciliation.
 */
export async function syncLedger(deps: Deps, orgId: string, facts: LedgerFacts, now = Date.now()) {
  await catchUp(deps, orgId);
  const db = forOrg(orgId, deps.db);
  const org = await db.org.findFirstOrThrow({ select: { name: true, level: true, createdAt: true } });
  const account = await db.$transaction((tx) => accountIn(tx, orgId));
  if (!account.residency && facts.residency) await db.billingAccount.updateMany({ data: { residency: facts.residency } });
  const metered = await meterReceipts(orgId, new Date(0), null, deps.db);
  const priced = await db.receipt.findMany({ where: { kind: "admin", action: { in: PRICED_ACTIONS } }, orderBy: { seq: "asc" }, select: { body: true } });
  const receipts = [...metered, ...priced.map((r) => r.body as unknown as MeterReceipt)].sort((a, b) => a.seq - b.seq);
  const [discounts, disputes, runs] = await Promise.all([db.discount.findMany({ where: { status: "accepted" } }), db.dispute.findMany(), db.reconciliationRun.findMany()]);
  const level = ((PLAN_IDS as readonly string[]).includes(org.level) ? org.level : account.plan) as PlanId;
  const input: BillingInput = {
    org: { prefix: account.invoicePrefix, name: account.buyerName, level, createdAt: facts.createdAt ?? org.createdAt.toISOString(), residency: account.residency ?? facts.residency },
    ...(facts.levelHistory.length ? { levelHistory: facts.levelHistory } : {}),
    receipts,
    ...(account.pilotStartsAt ? { pilot: { starts: account.pilotStartsAt.toISOString(), ...(account.pilotConvertedAt ? { convertedAt: account.pilotConvertedAt.toISOString() } : {}) } } : {}),
    discounts: discounts.map((d) => ({ seq: d.offerSeq ?? 0, pct: d.pctBasisPoints / 100, from: d.fromDay, until: d.untilDay, ...(d.endedAt ? { endedAt: d.endedAt.toISOString() } : {}), agreedBy: d.offeredByRole === "founder" ? ("founder" as const) : ("lead" as const) })),
    disputes: disputes
      .filter((d) => d.seq !== null)
      .map((d) => ({
        seq: d.seq!,
        invoice: d.invoiceNumber,
        line: d.line,
        reason: d.reason,
        by: d.openedBy,
        at: d.createdAt.toISOString(),
        open: d.status === "open",
        ...(d.status === "settled" && d.settleSeq !== null
          ? { settlement: { seq: d.settleSeq, outcome: (d.outcome ?? "rejected") as "upheld" | "partly_upheld" | "rejected", credit: n(d.creditPaise) ?? 0, ...(d.creditNoteNumber ? { creditNote: d.creditNoteNumber } : {}), at: (d.closedAt ?? d.createdAt).toISOString() } }
          : {}),
      })),
    reconciliation: runs.map((r) => ({ ...(r.seq !== null ? { seq: r.seq } : {}), period: r.period, meterEvents: r.meterEvents, chainDecisions: r.chainDecisions, matched: r.matched, at: r.createdAt.toISOString() })),
    packs: facts.packs,
    counterparties: facts.counterparties,
    now,
  };
  for (const inv of buildInvoices(input)) {
    if (inv.kind === "credit_note") {
      const dispute = disputes.find((d) => d.creditNoteNumber === inv.number);
      await storeCreditNote(orgId, inv, { ...(dispute ? { disputeId: dispute.id } : {}), note: dispute?.note ?? "" }, deps.db);
      continue;
    }
    await storeInvoice(orgId, inv, deps.db);
    if (inv.status === "issued") await issueInvoice(orgId, inv.number, new Date(inv.issuedAt), deps.db);
  }
  const events = meterEvents(metered);
  return { ...(await ledgerView(deps, orgId)), chain: { decisions: metered.filter((r) => r.kind === "decision").length, tenths: events.reduce((t, e) => t + e.tenths, 0) } };
}

/** A stored invoice or credit note, as the PDF prints it (the stored figures, never recomputed). */
async function storedDocument(deps: Deps, orgId: string, number: string): Promise<ComputedInvoice | undefined> {
  const db = forOrg(orgId, deps.db);
  const account = await db.billingAccount.findFirst();
  const customer = { name: account?.buyerName ?? "" };
  const inv = await db.invoice.findFirst({ where: { number } });
  if (inv) {
    if (inv.status === "void") return undefined;
    return {
      number: inv.number,
      kind: inv.kind === "deployment" ? "deployment" : "monthly",
      period: inv.period,
      status: inv.status === "held" ? "held" : inv.status === "issued" ? "issued" : "draft",
      issuedAt: (inv.issuedAt ?? inv.createdAt).toISOString(),
      ...(inv.dueAt ? { dueAt: inv.dueAt.toISOString() } : {}),
      periodStart: inv.periodStart.toISOString(),
      periodEnd: inv.periodEnd.toISOString(),
      lines: inv.lines as unknown as InvoiceLine[],
      subtotal: Number(inv.subtotalPaise),
      gst: Number(inv.gstPaise),
      total: Number(inv.totalPaise),
      heldAmount: Number(inv.heldPaise),
      payableNow: Number(inv.payablePaise),
      irn: inv.irn,
      placeOfSupply: inv.placeOfSupply,
      customer,
      segments: [],
      ...(inv.fromSeq !== null ? { fromSeq: inv.fromSeq } : {}),
      ...(inv.toSeq !== null ? { toSeq: inv.toSeq } : {}),
      events: inv.events,
    };
  }
  const cn = await db.creditNote.findFirst({ where: { number } });
  if (!cn) return undefined;
  const against = await db.invoice.findFirst({ where: { number: cn.invoiceNumber } });
  const amount = Number(cn.amountPaise);
  const period = against?.period ?? cn.issuedAt.toISOString().slice(0, 7);
  return {
    number: cn.number,
    kind: "credit_note",
    period,
    status: "issued",
    issuedAt: cn.issuedAt.toISOString(),
    periodStart: (against?.periodStart ?? cn.issuedAt).toISOString(),
    periodEnd: (against?.periodEnd ?? cn.issuedAt).toISOString(),
    lines: [{ id: "credit", kind: "credit", label: `Credit against ${cn.invoiceNumber} — ${cn.line}`, quantity: 1, unit: "credit", rate: -amount, amount: -amount, note: cn.outcome === "upheld" ? "Dispute upheld" : "Dispute partly upheld" }],
    subtotal: -amount,
    gst: -Number(cn.gstPaise),
    total: -Number(cn.totalPaise),
    heldAmount: 0,
    payableNow: -Number(cn.totalPaise),
    irn: cn.irn,
    placeOfSupply: against?.placeOfSupply ?? "",
    customer,
    segments: [],
    events: 0,
    creditFor: { invoice: cn.invoiceNumber, line: cn.line, outcome: cn.outcome === "upheld" ? "upheld" : "partly_upheld", settlementSeq: 0, disputeSeq: 0 },
  };
}

const InvoiceNumber = z.object({ number: z.string().regex(/^[A-Z0-9-]{3,60}$/) }).strict();

export const billingRoutes: WiringRoutes = (r, w) => {
  type P = { Params: { org: string } };

  // the ledger brought up to the chain, as the meter and invoices read it
  r.post<P>("/internal/orgs/:org/wiring/billing/ledger", async (req) => {
    const orgId = await w.org(req.params.org);
    return syncLedger(w.deps, orgId, w.parse(LedgerFacts, req.body));
  });

  // a stored invoice or credit note as a GST PDF (the web route checks the person may read billing)
  r.post<P>("/internal/orgs/:org/wiring/billing/pdf", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const { number } = w.parse(InvoiceNumber, req.body);
    const doc = await storedDocument(w.deps, orgId, number);
    if (!doc) return w.send(reply, fail(404, "There is no such invoice in the ledger yet. Open the Meter page once to bring it up to date."));
    const account = await forOrg(orgId, w.deps.db).billingAccount.findFirst();
    const bytes = await invoicePdf(doc, { name: account?.buyerName ?? "", gstin: account?.buyerGstin ?? null, address: account?.buyerAddress ?? null });
    return reply.header("content-type", "application/pdf").send(Buffer.from(bytes));
  });
};
