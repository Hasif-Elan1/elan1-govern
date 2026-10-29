import "server-only";
import { prisma } from "@gate/db";
import { HttpError } from "../../api";
import { gate } from "../../gate";
import { docOf, override, type Ctx, type Doc } from "./common";

/*
 * Billing on the real ledger (apps/gate/src/wiring/billing.ts).
 *  - The console's billing operations keep their own rules and write billing.* receipts; the gate writes what those
 *    receipts say into the ledger tables in the transaction that puts them on the chain. Nothing here repeats them.
 *  - The meter and the invoices come from the real chain and the ledger: api.meter and api.billing bring the ledger up
 *    to the chain (invoices and credit notes computed by core and stored) and answer with the stored invoices; the
 *    document's invoice list (what the screens read synchronously) becomes the ledger's, and the meter's
 *    reconciliation counts the chain itself.
 *  - The billing desk (elan1's side of disputes, discount requests and reopening) is for Elan1 platform staff only
 *    (User.isPlatformStaff, set by `pnpm govern staff add <email>`). It records elan1's decision as the billing
 *    desk; the staff member who recorded it is named on the receipt (recorded_by).
 */

interface LedgerInvoice {
  number: string;
  period: string;
  status: string;
  issuedAt: string | null;
  createdAt: string;
  lines: { label: string; quantity?: number; unit?: string; rate?: number; amount: number; note?: string }[];
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
}
export interface Ledger {
  invoices: LedgerInvoice[];
  creditNotes: { number: string; invoiceNumber: string; totalPaise: number }[];
  disputes: { seq: number | null; status: string }[];
  chain: { decisions: number; tenths: number };
}

const rupees = (paise: number) => Math.round(paise) / 100;
const lastMonth = (now = new Date()) => {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  ist.setUTCDate(1);
  ist.setUTCMonth(ist.getUTCMonth() - 1);
  return ist.toISOString().slice(0, 7);
};

/** A stored invoice as the console's screens show one (rupees; a closed month is due, an older one settled). */
function consoleInvoice(i: LedgerInvoice) {
  const status = i.status === "issued" ? (i.period >= lastMonth() ? "due" : "paid") : "draft";
  return {
    id: i.number,
    period: i.period,
    issuedAt: i.issuedAt ?? i.createdAt,
    status,
    lines: i.lines.map((l) => ({ label: l.label, quantity: l.quantity, unit: l.unit, ...(l.rate !== undefined ? { rate: rupees(l.rate) } : {}), amount: rupees(l.amount), ...(l.note ? { note: l.note } : {}) })),
    subtotal: rupees(i.subtotalPaise),
    gst: rupees(i.gstPaise),
    total: rupees(i.totalPaise),
  };
}

/** What only the document knows and the invoices need: the level history, installed packs, counterparties' seats. */
function factsOf(d: Doc) {
  const org = d.org as { levelHistory?: { level: string; from: string }[]; residency?: string; createdAt?: string };
  const platform = (d.platform ?? {}) as { packs?: { id: string; name?: string; installedAt?: string }[]; counterparties?: { id?: string; name: string; seats: number; since: string }[] };
  return {
    levelHistory: (org.levelHistory ?? []).map((p) => ({ level: p.level, from: p.from })),
    packs: (platform.packs ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id, ...(p.installedAt ? { installedAt: p.installedAt } : {}) })),
    counterparties: (platform.counterparties ?? []).map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name, seats: c.seats, since: c.since })),
    ...(org.residency ? { residency: org.residency } : {}),
    ...(org.createdAt ? { createdAt: org.createdAt } : {}),
  };
}

/** The ledger brought up to the chain (POST /internal/orgs/:org/wiring/billing/ledger). */
export async function ledgerOf(ctx: Ctx): Promise<Ledger> {
  let r: { status: number; data: Ledger & { error?: string } };
  try {
    r = await gate<Ledger & { error?: string }>("POST", `/internal/orgs/${encodeURIComponent(ctx.orgId)}/wiring/billing/ledger`, factsOf(docOf(ctx)));
  } catch {
    throw new Error("Elan1 Govern is not reachable, so the ledger could not be read. Try again in a moment.");
  }
  if (r.status !== 200) throw new Error(r.data.error ?? "Elan1 Govern could not read the billing ledger.");
  return r.data;
}

/** The document's invoice list becomes the ledger's (the screens read it synchronously). */
function keepInvoices(ctx: Ctx, ledger: Ledger) {
  const invoices = ledger.invoices.map(consoleInvoice);
  docOf(ctx).invoices = invoices;
  return invoices;
}

override("api.meter", async (ctx) => {
  const view = (await ctx.original(...ctx.args)) as { invoices: unknown[]; reconciliation: { meterEvents: number; chainDecisions: number; units: number; chainUnits?: number; difference: number; matched: boolean } };
  const ledger = await ledgerOf(ctx);
  view.invoices = keepInvoices(ctx, ledger);
  // the chain counted by the real backend, against the console's meter
  const rec = view.reconciliation;
  rec.chainDecisions = ledger.chain.decisions;
  rec.chainUnits = ledger.chain.tenths / 10;
  rec.difference = Math.round((rec.units - rec.chainUnits) * 10) / 10;
  rec.matched = rec.meterEvents === rec.chainDecisions && rec.difference === 0;
  return view;
});

override("api.billing", async (ctx) => {
  const view = (await ctx.original(...ctx.args)) as { invoices: unknown[] };
  view.invoices = keepInvoices(ctx, await ledgerOf(ctx));
  return view;
});

/** The billing desk: Elan1 platform staff only, whatever their role in the organisation. */
async function requireStaff(ctx: Ctx) {
  const u = await prisma.user.findUnique({ where: { id: ctx.actorUserId }, select: { isPlatformStaff: true } });
  if (!u?.isPlatformStaff) throw new HttpError(403, "The billing desk is for Elan1 platform staff. Your account is not one.");
}

/**
 * The desk's input names elan1's decider (decidedBy), which the door has set to the signed-in person: elan1's decision
 * is recorded as the billing desk's, with the staff member who recorded it on the receipt.
 */
function asDesk(ctx: Ctx): unknown[] {
  const args = [...ctx.args];
  const input = args[2];
  if (input && typeof input === "object") {
    const { decidedBy: _decidedBy, ...rest } = input as Record<string, unknown>;
    args[2] = rest;
  }
  return args;
}

for (const op of ["api.billingDesk.settleDispute", "api.billingDesk.decideDiscountRequest", "api.billingDesk.decideReopen", "billing.deskSettleDispute", "billing.deskDecideDiscountRequest", "billing.deskDecideReopen"]) {
  override(op, async (ctx) => {
    await requireStaff(ctx);
    return ctx.original(...asDesk(ctx));
  });
}
