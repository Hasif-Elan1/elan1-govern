import { CONSOLE_DETAIL_KEYS, PILOT, PLATFORM_RULE_IDS, type ComputedInvoice, type MeterReceipt } from "@gate/core";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";
import { forOrg } from "./tenant";

/** Decisions that never count towards anything: platform refusals and refusals at the pilot's own stop. */
const UNCOUNTED_RULES = [...PLATFORM_RULE_IDS, PILOT.ruleId];

/** A sandbox call's receipt says so where the console's receipts carry it (packages/core/src/console-receipt.ts). */
const SANDBOX_PATH = ["details", CONSOLE_DETAIL_KEYS.environment];

/**
 * Production governed actions in [since, until): every decision receipt except platform refusals (gate-error),
 * pilot-stop refusals and calls made with a sandbox key (metered at ₹0 and never counted towards the cap; the
 * guard marks them, apps/gate/src/guard.ts). Two indexed counts, cheap enough to run on every guarded call of a
 * pilot organisation.
 */
export async function pilotDecisionCount(orgId: string, since: Date, until?: Date | null, client: PrismaClient = defaultClient): Promise<number> {
  const db = forOrg(orgId, client);
  const where = { kind: "decision", ts: { gte: since, ...(until ? { lt: until } : {}) } };
  const uncounted = [...UNCOUNTED_RULES.map((id) => ({ body: { path: ["rule_id"], equals: id } })), { body: { path: SANDBOX_PATH, equals: "sandbox" } }];
  const [all, left] = await Promise.all([db.receipt.count({ where }), db.receipt.count({ where: { ...where, OR: uncounted } })]);
  return all - left;
}

/** Decision and approval receipts in [since, until), oldest first, as the meter reads them (a sandbox call's with its `environment`). */
export async function meterReceipts(orgId: string, since: Date, until?: Date | null, client: PrismaClient = defaultClient): Promise<MeterReceipt[]> {
  const rows = await forOrg(orgId, client).receipt.findMany({ where: { kind: { in: ["decision", "approval"] }, ts: { gte: since, ...(until ? { lt: until } : {}) } }, orderBy: { seq: "asc" }, select: { body: true } });
  return rows.map((r) => {
    const body = r.body as unknown as MeterReceipt;
    return body.details?.[CONSOLE_DETAIL_KEYS.environment] === "sandbox" ? { ...body, environment: "sandbox" } : body;
  });
}

const big = (n: number) => BigInt(n);

function invoiceRow(inv: ComputedInvoice) {
  return {
    kind: inv.kind,
    period: inv.period,
    periodStart: new Date(inv.periodStart),
    periodEnd: new Date(inv.periodEnd),
    // the ledger issues an invoice by an explicit step (issueInvoice); a computed one is a draft until then
    status: inv.status === "held" ? "held" : "draft",
    subtotalPaise: big(inv.subtotal),
    gstPaise: big(inv.gst),
    totalPaise: big(inv.total),
    heldPaise: big(inv.heldAmount),
    payablePaise: big(inv.payableNow),
    placeOfSupply: inv.placeOfSupply,
    irn: inv.irn,
    lines: JSON.parse(JSON.stringify(inv.lines)),
    fromSeq: inv.fromSeq ?? null,
    toSeq: inv.toSeq ?? null,
    events: inv.events,
    dueAt: inv.dueAt ? new Date(inv.dueAt) : null,
  };
}

/**
 * Write a computed invoice into the ledger as a draft (or held). An invoice already issued or void is never
 * touched: its stored figures stand, whatever the chain now says (the database refuses the change anyway).
 */
export async function storeInvoice(orgId: string, inv: ComputedInvoice, client: PrismaClient = defaultClient): Promise<{ stored: boolean; status: string }> {
  if (inv.kind === "credit_note") throw new Error("credit notes are stored with storeCreditNote");
  const db = forOrg(orgId, client);
  const row = invoiceRow(inv);
  const existing = await db.invoice.findFirst({ where: { number: inv.number }, select: { status: true } });
  if (!existing) {
    await db.invoice.create({ data: { orgId, number: inv.number, ...row } });
    return { stored: true, status: row.status };
  }
  const n = await db.invoice.updateMany({ where: { number: inv.number, status: { in: ["draft", "held"] } }, data: row });
  return n.count ? { stored: true, status: row.status } : { stored: false, status: existing.status };
}

/** Issue a draft invoice: from here on it never changes. A held invoice is issued only once its period reconciles. */
export async function issueInvoice(orgId: string, number: string, at: Date = new Date(), client: PrismaClient = defaultClient): Promise<boolean> {
  const n = await forOrg(orgId, client).invoice.updateMany({ where: { number, status: "draft" }, data: { status: "issued", issuedAt: at } });
  return n.count === 1;
}

/** A credit note is written once and never changed; writing the same number again does nothing. */
export async function storeCreditNote(orgId: string, cn: ComputedInvoice, extra: { disputeId?: string; note: string }, client: PrismaClient = defaultClient): Promise<void> {
  if (cn.kind !== "credit_note" || !cn.creditFor) throw new Error("not a credit note");
  await forOrg(orgId, client).creditNote.createMany({
    data: [
      {
        orgId,
        number: cn.number,
        invoiceNumber: cn.creditFor.invoice,
        line: cn.creditFor.line,
        disputeId: extra.disputeId ?? null,
        outcome: cn.creditFor.outcome,
        amountPaise: big(-cn.subtotal),
        gstPaise: big(-cn.gst),
        totalPaise: big(-cn.total),
        irn: cn.irn,
        note: extra.note,
        issuedAt: new Date(cn.issuedAt),
      },
    ],
    skipDuplicates: true,
  });
}
