import { beforeEach, describe, expect, it } from "vitest";
import { CONNECTOR_LABELS, connectorFor, connectorKindOf, mockState, resetMockState, seedMockState } from "../src";

const ctx = { orgId: "org-mock" };
const gmail = connectorFor("gmail", "mock", {});
const zoho = connectorFor("zoho", "mock", {});

beforeEach(() => resetMockState());

describe("seed data", () => {
  it("has three invoice emails whose totals match the bills", () => {
    const s = seedMockState(new Date("2026-10-26T00:00:00Z"));
    expect(s.messages.filter((m) => m.attachments.length)).toHaveLength(3);
    expect(s.bills.map((b) => b.total_inr)).toEqual([200000, 18000, 42480]);
    for (const b of s.bills) {
      const inv = s.messages.find((m) => m.id === b.message_id)!.attachments[0]!.invoice!;
      expect(inv.total_inr).toBe(b.total_inr);
      expect(Math.round((inv.taxable_inr + inv.cgst_inr + inv.sgst_inr + inv.igst_inr) * 100) / 100).toBe(inv.total_inr);
    }
  });
});

describe("mock gmail", () => {
  it("searches, reads and opens attachments", async () => {
    const found = (await gmail.call("gmail.search", { query: "invoice has:attachment" }, ctx)).data as { messages: { message_id: string }[] };
    expect(found.messages.map((m) => m.message_id)).toEqual(["m_101", "m_102", "m_103"]);
    expect(((await gmail.call("gmail.search", { query: "", max_results: 2 }, ctx)).data as { messages: unknown[] }).messages).toHaveLength(2);
    const msg = (await gmail.call("gmail.read_message", { message_id: "m_101" }, ctx)).data as { attachments: { attachment_id: string }[] };
    expect(msg.attachments[0]!.attachment_id).toBe("a_101");
    const att = (await gmail.call("gmail.get_attachment", { message_id: "m_101", attachment_id: "a_101" }, ctx)).data as { extracted_invoice: { number: string } };
    expect(att.extracted_invoice.number).toBe("INV-2291");
    await expect(gmail.call("gmail.get_attachment", { message_id: "m_101", attachment_id: "x" }, ctx)).rejects.toThrow(/No such attachment/);
    await expect(gmail.call("gmail.read_message", { message_id: "nope" }, ctx)).rejects.toThrow(/No message/);
  });
  it("drafts and sends replies", async () => {
    expect((await gmail.call("gmail.draft_reply", { message_id: "m_102", body: "Thanks" }, ctx)).ref).toMatch(/^d_/);
    expect((await gmail.call("gmail.send_reply", { message_id: "m_102", to: "billing@kaverilogistics.in", body: "Paid" }, ctx)).ref).toMatch(/^sent_/);
    expect(mockState("org-mock").sent).toHaveLength(1);
    await expect(gmail.call("zoho.list_bills", {}, ctx)).rejects.toThrow(/does not handle/);
  });
  it("knows vendor domains and reply evidence", async () => {
    expect(await gmail.vendorDomains(ctx)).toEqual(["sharmatraders.in", "kaverilogistics.in", "nilgirioffice.in"]);
    expect(await zoho.vendorDomains(ctx)).toHaveLength(3);
    expect((await gmail.evidence("gmail.send_reply", { message_id: "m_101" }, ctx)).vendor?.name).toBe("Sharma Traders");
    expect(await gmail.evidence("gmail.send_reply", { message_id: "m_104" }, ctx)).toEqual({});
    expect(await gmail.evidence("gmail.search", {}, ctx)).toEqual({});
    expect(await gmail.describe("gmail.search", {}, ctx)).toEqual({});
  });
});

describe("mock zoho", () => {
  it("lists bills and vendors without exposing full bank numbers", async () => {
    const bills = (await zoho.call("zoho.list_bills", { status: "open" }, ctx)).data as { bills: { vendor_name: string }[] };
    expect(bills.bills).toHaveLength(3);
    expect(((await zoho.call("zoho.list_bills", { vendor_id: "v_kaveri" }, ctx)).data as { bills: unknown[] }).bills).toHaveLength(1);
    const v = (await zoho.call("zoho.get_vendor", { vendor_id: "v_sharma" }, ctx)).data as { bank_account: string };
    expect(v.bank_account).toBe("•••• 4821");
    await expect(zoho.call("zoho.get_vendor", { vendor_id: "x" }, ctx)).rejects.toThrow(/No vendor/);
  });
  it("records payments against the balance", async () => {
    const r = await zoho.call("zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000 }, ctx);
    expect(r.ref).toMatch(/^PAY-/);
    expect(r.data).toMatchObject({ status: "paid", balance_inr: 0 });
    await expect(zoho.call("zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 1 }, ctx)).rejects.toThrow(/more than the bill/);
    await expect(zoho.call("zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 0 }, ctx)).rejects.toThrow(/more than zero/);
    await expect(zoho.call("zoho.record_bill_payment", { bill_id: "nope", amount_inr: 1 }, ctx)).rejects.toThrow(/No bill/);
    expect((await zoho.call("zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 100, reference: "UTR1" }, ctx)).data).toMatchObject({ status: "open" });
  });
  it("creates bills once and updates vendors", async () => {
    const created = await zoho.call("zoho.create_bill", { vendor_id: "v_nilgiri", bill_number: "NOS-600", bill_date: "2026-10-26", amount_inr: 500 }, ctx);
    expect(created.ref).toMatch(/^bill_/);
    await expect(zoho.call("zoho.create_bill", { vendor_id: "v_nilgiri", bill_number: "NOS-600", bill_date: "2026-10-26", amount_inr: 500 }, ctx)).rejects.toThrow(/already exists/);
    const updated = await zoho.call("zoho.update_vendor", { vendor_id: "v_nilgiri", fields: { phone: "+91 1", email: undefined } }, ctx);
    expect(updated.data).toMatchObject({ phone: "+91 1" });
    await expect(zoho.call("gmail.search", {}, ctx)).rejects.toThrow(/does not handle/);
  });
  it("describes and gathers evidence", async () => {
    expect(await zoho.describe("zoho.record_bill_payment", { bill_id: "bill_2291" }, ctx)).toEqual({ vendor: "Sharma Traders", bill: "INV-2291" });
    expect(await zoho.describe("zoho.create_bill", { vendor_id: "v_kaveri", bill_number: "X" }, ctx)).toEqual({ vendor: "Kaveri Logistics", bill: "X" });
    expect(await zoho.describe("zoho.list_bills", {}, ctx)).toEqual({});
    const ev = await zoho.evidence("zoho.record_bill_payment", { bill_id: "bill_2291" }, ctx);
    expect(ev.vendor).toMatchObject({ name: "Sharma Traders", bank: "•••• 4821" });
    expect(ev.invoice?.number).toBe("INV-2291");
    expect(ev.bill?.total_inr).toBe(200000);
    expect(await zoho.evidence("zoho.update_vendor", { vendor_id: "v_kaveri" }, ctx)).toHaveProperty("vendor");
    expect(await zoho.evidence("zoho.list_bills", {}, ctx)).toEqual({});
  });
  it("keeps orgs apart", async () => {
    await zoho.call("zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000 }, ctx);
    const other = (await zoho.call("zoho.list_bills", { status: "open" }, { orgId: "org-other" })).data as { bills: unknown[] };
    expect(other.bills).toHaveLength(3);
    resetMockState("org-mock");
    expect(mockState("org-mock").payments).toHaveLength(0);
  });
});

describe("registry", () => {
  it("maps tools to connectors and demands config for live mode", () => {
    expect(connectorKindOf("gmail.search")).toBe("gmail");
    expect(connectorKindOf("zoho.update_vendor")).toBe("zoho");
    expect(CONNECTOR_LABELS.zoho).toBe("Zoho Books");
    expect(() => connectorFor("gmail", "live", {})).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => connectorFor("zoho", "live", {})).toThrow(/ZOHO_CLIENT_ID/);
    expect(connectorFor("gmail", "live", { google: { clientId: "a", clientSecret: "b" } }).kind).toBe("gmail");
    expect(connectorFor("zoho", "live", { zoho: { clientId: "a", clientSecret: "b", apiUrl: "x" } }).kind).toBe("zoho");
  });
});
