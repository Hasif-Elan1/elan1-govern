import { forOrg, setPlatformStaff } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastReceipt, type Harness } from "./harness";

// Billing on the real ledger (apps/web/src/server/console-overrides/wiring/billing.ts, apps/gate/src/wiring/billing.ts):
// the console's billing receipts become ledger rows in the transaction that writes them to the chain; the meter and
// the invoices come from the chain and the ledger; the billing desk is for Elan1 platform staff only. Kaveri (L3) is
// seeded by the console with an open dispute and reconciliation runs.
const ORG = "org_kaveri";
const OWNER = "u_lakshmi";
const ADMIN = "u_kh_arvind";
const VIEWER = "u_kh_nandini";
const OWNER_EMAIL = "lakshmi.pillai@kaverihealth.in";

export function billingCases(h: Harness) {
  const db = forOrg(ORG);
  const pdfRoute = import("../../src/app/api/billing/invoices/[number]/pdf/route");
  async function pdf(number: string, orgId: string, as: string) {
    h.session.userId = as;
    const res = await (await pdfRoute).GET(new NextRequest(`http://localhost:3000/api/billing/invoices/${number}/pdf?org=${orgId}`), { params: Promise.resolve({ number }) });
    return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()) };
  }

  beforeAll(async () => {
    await h.reset(ORG);
    // issued invoices and credit notes never change (the database refuses), so they stay; the rest starts again
    for (const t of [db.dispute, db.discount, db.discountRequest, db.reconciliationRun]) await (t as unknown as { deleteMany(a: object): Promise<unknown> }).deleteMany({});
    await setPlatformStaff(OWNER_EMAIL, false);
  }, 120_000);
  afterAll(() => setPlatformStaff(OWNER_EMAIL, false));

  describe("billing on the real ledger", () => {
    it("writes what the console's billing receipts say into the ledger, in the transaction that puts them on the chain", async () => {
      // the first open seeds Kaveri's billing story (mock/billing.ts ensureBillingSeed) as receipts on the real chain
      const { status, doc } = await h.state(ORG, OWNER);
      expect(status).toBe(200);
      const opened = lastReceipt(doc, "billing.dispute_opened");
      const run = lastReceipt(doc, "billing.reconciliation_run");
      expect(opened).toMatchObject({ actor: OWNER });
      expect(await db.dispute.findFirst({ where: { seq: opened!.seq } })).toMatchObject({ status: "open", invoiceNumber: opened!.details!.invoice, line: opened!.details!.line, openedBy: OWNER });
      expect(await db.reconciliationRun.findFirst({ where: { seq: run!.seq } })).toMatchObject({ period: run!.details!.period, matched: run!.details!.matched, runBy: "system" });
      expect(await db.billingAccount.findFirst()).toMatchObject({ invoicePrefix: "KAVE", buyerName: "Kaveri Health Network" });
      // a receipt the ledger has already taken is never taken twice
      expect(await db.dispute.count({ where: { seq: opened!.seq } })).toBe(1);
    });

    it("keeps a discount request and its withdrawal in the ledger, for owners only", async () => {
      const input = { pct: 8, months: 6, reason: "A second hospital joins the network next quarter" };
      const refused = await h.rpc("billing.requestDiscount", [ORG, OWNER, input], ADMIN);
      expect(refused.status).toBe(400);
      expect(await db.discountRequest.count({ where: { requestedBy: ADMIN } })).toBe(0);

      const ok = await h.rpc("billing.requestDiscount", [ORG, ADMIN, input], OWNER);
      expect(ok.status, ok.body.error).toBe(200);
      const asked = lastReceipt(await h.saved(ORG), "billing.discount_requested")!;
      expect(await db.discountRequest.findFirst({ where: { seq: asked.seq } })).toMatchObject({ status: "with_elan1", pctBasisPoints: 800, months: 6, requestedBy: OWNER, needs: "lead" });

      expect((await h.rpc("billing.withdrawDiscountRequest", [ORG, OWNER, asked.seq], OWNER)).status).toBe(200);
      expect(await db.discountRequest.findFirst({ where: { seq: asked.seq } })).toMatchObject({ status: "withdrawn" });
      expect(lastReceipt((await h.state(ORG, OWNER)).doc, "billing.discount_request_withdrawn")?.details).toMatchObject({ request: asked.seq });
    });

    it("bills from the real chain: the meter's invoices are the ledger's, and its reconciliation counts the chain", async () => {
      const r = await h.rpc("api.meter", [ORG], ADMIN);
      expect(r.status, r.body.error).toBe(200);
      const view = r.body.result as { invoices: { id: string; status: string; total: number }[]; reconciliation: { chainDecisions: number; matched: boolean } };
      const stored = await db.invoice.findMany({ orderBy: { periodStart: "asc" } });
      expect(stored.length).toBeGreaterThan(0);
      expect(view.invoices.map((i) => i.id)).toEqual(stored.map((i) => i.number));
      expect(view.invoices.find((i) => i.id === stored[0]!.number)?.total).toBe(Number(stored[0]!.totalPaise) / 100);
      // closed months are issued once and never change
      expect(stored.filter((i) => i.status === "issued").length).toBeGreaterThan(0);
      expect(view.reconciliation.chainDecisions).toBe(await db.receipt.count({ where: { kind: "decision" } }));
      // and the document's invoice list (what the screens read at once) is the ledger's
      expect(((await h.state(ORG, OWNER)).doc.invoices as { id: string }[]).map((i) => i.id)).toEqual(stored.map((i) => i.number));
    });

    it("refuses the billing desk to an owner who is not Elan1 platform staff, and records staff decisions as elan1's", async () => {
      // this month's floor (the console's own invoices on the real chain start with the organisation's real creation)
      const draft = (await db.invoice.findFirst({ where: { status: "draft", kind: "monthly" }, orderBy: { periodStart: "desc" } }))!;
      const line = (draft.lines as { id: string; amount: number }[]).find((l) => l.id.endsWith("-floor"))!;
      const opened = await h.rpc("api.openDispute", [ORG, OWNER, { invoice: draft.number, line: line.id, reason: "Charged for days before the custody ceremony closed" }], OWNER);
      expect(opened.status, opened.body.error).toBe(200);
      const dispute = lastReceipt(await h.saved(ORG), "billing.dispute_opened")!;
      const decision = { dispute: dispute.seq, outcome: "partly_upheld", credit: 1000, note: "Two of the three days are credited; the third stands", decidedBy: "elan1:founder" };
      const refused = await h.rpc("api.billingDesk.settleDispute", [ORG, OWNER, decision], OWNER);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/platform staff/);
      expect(await db.dispute.findFirst({ where: { seq: dispute.seq } })).toMatchObject({ status: "open" });

      await setPlatformStaff(OWNER_EMAIL, true);
      // anyone else is still refused, through either door to the desk
      expect((await h.rpc("billing.deskSettleDispute", [ORG, ADMIN, decision], ADMIN)).body.error).toMatch(/platform staff/);
      const ok = await h.rpc("api.billingDesk.settleDispute", [ORG, OWNER, decision], OWNER);
      expect(ok.status, ok.body.error).toBe(200);
      const settled = lastReceipt((await h.state(ORG, OWNER)).doc, "billing.dispute_settled")!;
      // recorded as the billing desk's decision, whatever decider the request named, with the staff member who recorded it
      expect(settled).toMatchObject({ actor: "elan1:farah.khan", details: { dispute: dispute.seq, outcome: "partly_upheld", credit_amount: 1000, recorded_by: OWNER } });
      expect(await db.dispute.findFirst({ where: { seq: dispute.seq } })).toMatchObject({ status: "settled", outcome: "partly_upheld", settleSeq: settled.seq, creditPaise: 100_000n, decidedBy: "elan1:farah.khan" });
      // the meter brings the ledger up to date: the credit note is written once, against the disputed invoice
      expect((await h.rpc("api.meter", [ORG], OWNER)).status).toBe(200);
      const cn = await db.creditNote.findFirst({ where: { number: String(settled.details!.credit_note) } });
      expect(cn).toMatchObject({ invoiceNumber: String(dispute.details!.invoice), outcome: "partly_upheld", amountPaise: 100_000n });
      expect((await h.rpc("api.meter", [ORG], OWNER)).status).toBe(200);
      expect(await db.creditNote.count({ where: { number: cn!.number } })).toBe(1);
    });

    it("opens and withdraws a dispute on a stored invoice line, owners only", async () => {
      const issued = (await db.invoice.findFirst({ where: { status: "issued" }, orderBy: { periodStart: "asc" } }))!;
      const line = (issued.lines as { id: string; amount: number }[]).find((l) => l.amount > 0)!;
      const input = { invoice: issued.number, line: line.id, reason: "Refused calls were counted on a day the agent was paused" };
      expect((await h.rpc("api.openDispute", [ORG, OWNER, input], ADMIN)).status).toBe(400);
      const opened = await h.rpc("api.openDispute", [ORG, ADMIN, input], OWNER);
      expect(opened.status, opened.body.error).toBe(200);
      const dispute = lastReceipt(await h.saved(ORG), "billing.dispute_opened")!;
      expect(await db.dispute.findFirst({ where: { seq: dispute.seq } })).toMatchObject({ status: "open", invoiceNumber: issued.number, line: line.id, openedBy: OWNER });
      expect((await h.rpc("api.withdrawDispute", [ORG, OWNER, dispute.seq], OWNER)).status).toBe(200);
      expect(await db.dispute.findFirst({ where: { seq: dispute.seq } })).toMatchObject({ status: "withdrawn" });
    });

    it("downloads a stored invoice as its GST PDF for owners and admins of that organisation only", async () => {
      const issued = (await db.invoice.findFirst({ where: { status: "issued" } }))!;
      const ok = await pdf(issued.number, ORG, ADMIN);
      expect(ok.status).toBe(200);
      expect(ok.type).toBe("application/pdf");
      expect(ok.bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect((await pdf(issued.number, ORG, VIEWER)).status).toBe(403);
      // another organisation's billing: not a member there
      expect((await pdf(issued.number, "org_northbank", ADMIN)).status).toBe(403);
      expect((await pdf("EG-KAVE-190001", ORG, OWNER)).status).toBe(404);
      expect((await pdf("../etc", ORG, OWNER)).status).toBe(400);
    });

    it("keeps each organisation's ledger its own", async () => {
      expect(await db.dispute.count()).toBeGreaterThan(0);
      expect(await forOrg("org_northbank").dispute.count({ where: { invoiceNumber: { startsWith: "EG-KAVE" } } })).toBe(0);
      expect(await forOrg("org_northbank").invoice.count({ where: { number: { startsWith: "EG-KAVE" } } })).toBe(0);
      // a member of another organisation cannot read this one's meter through the door
      expect((await h.rpc("api.meter", [ORG], "u_rohan")).status).toBe(403);
    });
  });
}
