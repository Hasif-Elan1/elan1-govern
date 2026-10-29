import { buildInvoices, generateKeyPair, type ComputedInvoice } from "@gate/core";
import { afterAll, describe, expect, it } from "vitest";
import { forOrg, issueInvoice, meterReceipts, pilotDecisionCount, prisma, storeCreditNote, storeInvoice, TENANT_MODELS, withChain } from "../src";

const keys = generateKeyPair();
const newOrg = (name = "Billing Org") => prisma.org.create({ data: { name, publicKey: keys.publicKeyPem, privateKeyEnc: "unused-in-tests" } });

afterAll(() => prisma.$disconnect());

/** One month's invoice and a credit note, computed by core from a tiny chain. */
function invoices(): { inv: ComputedInvoice; cn: ComputedInvoice } {
  const receipts = [{ seq: 1, ts: "2026-08-10T06:00:00.000Z", kind: "decision", decision: "allow", rule_id: "r" }];
  const disputes = [{ seq: 9, invoice: "EG-TEST-202608", line: "l1-floor", reason: "r", by: "u", at: "2026-09-01T00:00:00Z", open: false, settlement: { seq: 10, outcome: "partly_upheld" as const, credit: 100_000, creditNote: "CN-TEST-202608-9", at: "2026-09-05T00:00:00.000Z" } }];
  const all = buildInvoices({ org: { prefix: "TEST", name: "Test", level: "l1", createdAt: "2026-08-01T00:00:00Z" }, receipts, disputes, now: Date.parse("2026-10-20T00:00:00Z") });
  return { inv: all.find((i) => i.number === "EG-TEST-202608")!, cn: all.find((i) => i.kind === "credit_note")! };
}

describe("billing ledger", () => {
  it("every billing model belongs to one organisation", async () => {
    for (const m of ["BillingAccount", "Invoice", "CreditNote", "Discount", "DiscountRequest", "Dispute", "ReconciliationRun"]) expect(TENANT_MODELS).toContain(m);
    const [a, b] = await Promise.all([newOrg("A"), newOrg("B")]);
    await forOrg(a.id).billingAccount.create({ data: { orgId: b.id, invoicePrefix: "AAAA", buyerName: "A" } as never });
    await forOrg(a.id).dispute.create({ data: { invoiceNumber: "EG-AAAA-202610", line: "l1-floor", reason: "why", openedBy: "u" } as never });
    await forOrg(a.id).reconciliationRun.create({ data: { period: "2026-10", meterEvents: 1, chainDecisions: 1, meterTenths: 10, chainTenths: 10, matched: true, runBy: "system" } as never });
    expect(await forOrg(b.id).billingAccount.count()).toBe(0);
    expect((await forOrg(a.id).billingAccount.findFirstOrThrow()).orgId).toBe(a.id);
    expect(await forOrg(b.id).dispute.count()).toBe(0);
    expect(await forOrg(b.id).reconciliationRun.count()).toBe(0);
    expect(await forOrg(a.id).discount.count()).toBe(0);
    expect(await forOrg(a.id).discountRequest.count()).toBe(0);
  });

  it("stores drafts, issues them, and never rewrites an issued invoice", async () => {
    const org = await newOrg();
    const { inv } = invoices();
    expect(await storeInvoice(org.id, inv)).toEqual({ stored: true, status: "draft" });
    expect(await storeInvoice(org.id, { ...inv, subtotal: inv.subtotal + 1 })).toEqual({ stored: true, status: "draft" });
    expect(await storeInvoice(org.id, { ...inv, status: "held" })).toEqual({ stored: true, status: "held" });
    expect(await issueInvoice(org.id, inv.number)).toBe(false); // a held invoice waits for its period to reconcile
    await storeInvoice(org.id, inv);
    expect(await issueInvoice(org.id, inv.number, new Date("2026-09-01T10:00:00Z"))).toBe(true);

    expect(await storeInvoice(org.id, { ...inv, subtotal: 1 })).toEqual({ stored: false, status: "issued" });
    const row = await forOrg(org.id).invoice.findFirstOrThrow({ where: { number: inv.number } });
    expect(row).toMatchObject({ status: "issued", subtotalPaise: BigInt(inv.subtotal), gstPaise: BigInt(inv.gst), totalPaise: BigInt(inv.total) });
    expect((row.lines as { amount: number }[]).map((l) => l.amount)).toEqual(inv.lines.map((l) => l.amount));
    await expect(storeInvoice(org.id, invoices().cn)).rejects.toThrow(/storeCreditNote/);
  });

  it("the database itself refuses to change or delete an issued invoice; voiding is the one change", async () => {
    const org = await newOrg();
    const { inv } = invoices();
    await storeInvoice(org.id, inv);
    await issueInvoice(org.id, inv.number);
    const db = forOrg(org.id);
    await expect(db.invoice.updateMany({ where: { number: inv.number }, data: { totalPaise: 1n } })).rejects.toThrow(/cannot be changed/);
    await expect(db.invoice.updateMany({ where: { number: inv.number }, data: { status: "draft" } })).rejects.toThrow(/cannot be changed/);
    await expect(db.invoice.updateMany({ where: { number: inv.number }, data: { status: "void", totalPaise: 1n } })).rejects.toThrow(/cannot be changed/);
    await expect(db.invoice.deleteMany({ where: { number: inv.number } })).rejects.toThrow(/cannot be deleted/);
    await db.invoice.updateMany({ where: { number: inv.number }, data: { status: "void", voidedAt: new Date(), voidReason: "issued to the wrong buyer" } });
    await expect(db.invoice.updateMany({ where: { number: inv.number }, data: { voidReason: "changed my mind" } })).rejects.toThrow(/void/);
    // a draft can still be removed
    await storeInvoice(org.id, { ...inv, number: "EG-TEST-202609" });
    expect((await db.invoice.deleteMany({ where: { number: "EG-TEST-202609" } })).count).toBe(1);
  });

  it("writes a credit note once and never changes it", async () => {
    const org = await newOrg();
    const { cn } = invoices();
    await storeCreditNote(org.id, cn, { note: "Two days credited" });
    await storeCreditNote(org.id, cn, { note: "again" });
    const db = forOrg(org.id);
    const row = await db.creditNote.findFirstOrThrow();
    expect(row).toMatchObject({ number: "CN-TEST-202608-9", invoiceNumber: "EG-TEST-202608", line: "l1-floor", outcome: "partly_upheld", amountPaise: 100_000n, gstPaise: 18_000n, totalPaise: 118_000n, note: "Two days credited" });
    expect(await db.creditNote.count()).toBe(1);
    await expect(db.creditNote.updateMany({ data: { note: "x" } })).rejects.toThrow(/cannot be changed/);
    await expect(db.creditNote.deleteMany({})).rejects.toThrow(/cannot be changed/);
    await expect(storeCreditNote(org.id, invoices().inv, { note: "x" })).rejects.toThrow(/not a credit note/);
  });

  it("counts production decisions for the pilot, leaving out platform refusals and pilot-stop refusals", async () => {
    const org = await newOrg();
    const since = new Date(Date.now() - 60_000);
    await withChain(org.id, keys.privateKeyPem, async (append) => {
      await append({ kind: "decision", tool: "t", decision: "allow", rule_id: "read" });
      await append({ kind: "decision", tool: "t", decision: "ask", rule_id: "pay" });
      await append({ kind: "decision", tool: "t", decision: "refuse", rule_id: "default" });
      await append({ kind: "decision", tool: "t", decision: "refuse", rule_id: "gate-error" });
      await append({ kind: "decision", tool: "t", decision: "refuse", rule_id: "pilot-limit" });
      await append({ kind: "admin", actor: "x", action: "rulebook.published" });
    });
    expect(await pilotDecisionCount(org.id, since)).toBe(3);
    expect(await pilotDecisionCount(org.id, since, since)).toBe(0);
    expect(await pilotDecisionCount(org.id, new Date(Date.now() + 60_000))).toBe(0);
    const rs = await meterReceipts(org.id, since, new Date(Date.now() + 60_000));
    expect(rs.map((r) => r.rule_id)).toEqual(["read", "pay", "default", "gate-error", "pilot-limit"]);
    expect(await meterReceipts(org.id, since)).toHaveLength(5);
  });
});
