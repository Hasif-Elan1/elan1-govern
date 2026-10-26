import { describe, expect, it, vi } from "vitest";
import { authorizeUrl, exchangeCode, gmailConnector, refreshTokens, zohoConnector, zohoOrganizations, type ConnectorContext } from "../src";
import { __test } from "../src/gmail";

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown };

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = handler(String(url), init);
    return new Response(body === undefined ? "not json" : JSON.stringify(body), { status });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const google = { clientId: "gid", clientSecret: "gsecret" };
const zohoCfg = { clientId: "zid", clientSecret: "zsecret", accountsUrl: "https://accounts.zoho.in", apiUrl: "https://www.zohoapis.in" };
const tokens = () => ({ access_token: "at-1", refresh_token: "rt-1", expires_at: Date.now() + 3_600_000 });
const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("oauth", () => {
  it("builds authorize URLs for Google and Zoho India", () => {
    const g = new URL(authorizeUrl("gmail", google, "https://gate/cb", "st"));
    expect(g.origin).toBe("https://accounts.google.com");
    expect(g.searchParams.get("scope")).toContain("gmail.readonly");
    expect(g.searchParams.get("access_type")).toBe("offline");
    const z = new URL(authorizeUrl("zoho", zohoCfg, "https://gate/cb", "st"));
    expect(z.origin).toBe("https://accounts.zoho.in");
    expect(z.searchParams.get("scope")).toContain("ZohoBooks.bills.ALL");
    expect(new URL(authorizeUrl("zoho", { clientId: "a", clientSecret: "b" }, "x", "s")).origin).toBe("https://accounts.zoho.in");
  });
  it("exchanges and refreshes tokens", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { access_token: "new", refresh_token: "r2", expires_in: 60 } }));
    const t = await exchangeCode("gmail", google, "code", "https://gate/cb", f);
    expect(t).toMatchObject({ access_token: "new", refresh_token: "r2" });
    expect(String(calls[0]!.init.body)).toContain("grant_type=authorization_code");
    const { f: f2 } = fakeFetch(() => ({ body: { access_token: "n2" } }));
    expect(await refreshTokens("zoho", zohoCfg, "keep", f2)).toMatchObject({ access_token: "n2", refresh_token: "keep" });
    const { f: bad } = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
    await expect(refreshTokens("gmail", google, "x", bad)).rejects.toThrow(/invalid_grant/);
    const { f: junk } = fakeFetch(() => ({ status: 500, body: undefined }));
    await expect(refreshTokens("zoho", { clientId: "a", clientSecret: "b" }, "x", junk)).rejects.toThrow(/500/);
  });
});

describe("live gmail", () => {
  const msg = {
    id: "g1",
    threadId: "th1",
    payload: {
      headers: [
        { name: "From", value: "Vendor <a@v.in>" },
        { name: "To", value: "ap@x.in" },
        { name: "Subject", value: "Invoice 9" },
        { name: "Date", value: "today" },
        { name: "Message-ID", value: "<mid@v.in>" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("hello") } },
        { mimeType: "application/pdf", filename: "inv.pdf", body: { attachmentId: "att1", size: 10 } },
        { mimeType: "application/pdf", filename: "huge.pdf", body: { attachmentId: "att2", size: 99e6 } },
      ],
    },
  };
  const handler: Handler = (url) => {
    if (url.includes("/messages?")) return { body: { messages: [{ id: "g1" }] } };
    if (url.includes("format=metadata")) return { body: msg };
    if (url.includes("/attachments/")) return { body: { data: b64("PDF") } };
    if (url.includes("format=full")) return { body: msg };
    if (url.endsWith("/drafts")) return { body: { id: "dr1" } };
    if (url.endsWith("/messages/send")) return { body: { id: "s1" } };
    return { status: 404, body: { message: "nope" } };
  };

  it("runs every tool", async () => {
    const { f, calls } = fakeFetch(handler);
    const g = gmailConnector(google, f);
    const ctx: ConnectorContext = { orgId: "o", tokens: tokens() };
    expect((await g.call("gmail.search", { query: "invoice" }, ctx)).data).toEqual({ messages: [{ message_id: "g1", from: "Vendor <a@v.in>", subject: "Invoice 9", date: "today" }] });
    expect((await g.call("gmail.read_message", { message_id: "g1" }, ctx)).data).toMatchObject({ body: "hello", attachments: [{ attachment_id: "att1" }, { attachment_id: "att2" }] });
    expect((await g.call("gmail.get_attachment", { message_id: "g1", attachment_id: "att1" }, ctx)).data).toMatchObject({ content_base64: Buffer.from("PDF").toString("base64") });
    await expect(g.call("gmail.get_attachment", { message_id: "g1", attachment_id: "att2" }, ctx)).rejects.toThrow(/10 MB/);
    await expect(g.call("gmail.get_attachment", { message_id: "g1", attachment_id: "zzz" }, ctx)).rejects.toThrow(/No such/);
    expect((await g.call("gmail.draft_reply", { message_id: "g1", body: "ok" }, ctx)).ref).toBe("dr1");
    expect((await g.call("gmail.send_reply", { message_id: "g1", to: "a@v.in", body: "ok" }, ctx)).ref).toBe("s1");
    const sent = JSON.parse(String(calls.at(-1)!.init.body));
    expect(Buffer.from(sent.raw, "base64url").toString()).toContain("Subject: Re: Invoice 9");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer at-1");
    await expect(g.call("zoho.list_bills", {}, ctx)).rejects.toThrow(/does not handle/);
    expect(await g.describe("gmail.search", {}, ctx)).toEqual({});
    expect(await g.evidence("gmail.search", {}, ctx)).toEqual({});
    expect(await g.vendorDomains(ctx)).toEqual([]);
  });

  it("refuses header injection in replies", () => {
    const raw = Buffer.from(__test.rawReply("a@v.in\r\nBcc: evil@x", "Re: hi", "<m>", "body"), "base64url").toString();
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(__test.clean("a\nb")).toBe("a b");
  });

  it("refreshes expired tokens and saves them", async () => {
    let first = true;
    const { f } = fakeFetch((url) => {
      if (url.includes("oauth2.googleapis.com")) return { body: { access_token: "fresh", expires_in: 3600 } };
      if (first) {
        first = false;
        return { status: 401, body: { message: "expired" } };
      }
      return { body: msg };
    });
    const save = vi.fn(async () => {});
    const ctx: ConnectorContext = { orgId: "o", tokens: tokens(), saveTokens: save };
    await gmailConnector(google, f).call("gmail.read_message", { message_id: "g1" }, ctx);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ access_token: "fresh", refresh_token: "rt-1" }));

    const ctx2: ConnectorContext = { orgId: "o", tokens: { access_token: "old", expires_at: Date.now() - 1 } };
    await expect(gmailConnector(google, f).call("gmail.read_message", { message_id: "g1" }, ctx2)).rejects.toThrow(/reconnect/);
    await expect(gmailConnector(google, f).call("gmail.read_message", { message_id: "g1" }, { orgId: "o" })).rejects.toThrow(/not connected/);
    const { f: notFound } = fakeFetch(() => ({ status: 404, body: undefined }));
    await expect(gmailConnector(google, notFound).call("gmail.read_message", { message_id: "g1" }, { orgId: "o", tokens: tokens() })).rejects.toThrow(/HTTP 404/);
  });
});

describe("live zoho books", () => {
  const bill = { bill_id: "zb1", bill_number: "INV-1", vendor_id: "zv1", vendor_name: "Sharma", date: "d", due_date: "dd", total: 200000, balance: 200000, status: "open" };
  const contact = { contact_id: "zv1", contact_name: "Sharma", email: "a@sharma.in", gst_no: "27X", billing_address: { address: "Mumbai" }, custom_fields: [{ api_name: "cf_bank_account", value: "1234567890" }, { api_name: "cf_ifsc", value: "HDFC1" }] };
  const handler: Handler = (url, init) => {
    if (url.includes("/organizations")) return { body: { organizations: [{ organization_id: "60001", name: "Acme" }] } };
    if (url.includes("/bills/zb1")) return { body: { bill } };
    if (url.includes("/bills") && init.method === "POST") return { body: { bill: { ...bill, bill_id: "zb2" } } };
    if (url.includes("/bills?")) return { body: { bills: [bill] } };
    if (url.includes("/vendorpayments")) return { body: { vendorpayment: { payment_id: "p1", payment_number: "VP-1" } } };
    if (url.includes("/contacts?")) return { body: { contacts: [contact, { ...contact, email: "x@Other.in" }, { contact_id: "n" }] } };
    if (url.includes("/contacts/zv1")) return { body: { contact } };
    return { status: 404, body: { message: "not found" } };
  };
  const ctx = (): ConnectorContext => ({ orgId: "o", tokens: tokens(), meta: { zoho_org_id: "60001", expense_account_id: "acc1", paid_through_account_id: "bank1" } });

  it("runs every tool against the India data centre", async () => {
    const { f, calls } = fakeFetch(handler);
    const z = zohoConnector(zohoCfg, f);
    expect((await z.call("zoho.list_bills", { status: "open", vendor_id: "zv1" }, ctx())).data).toMatchObject({ bills: [{ bill_id: "zb1", total_inr: 200000 }] });
    expect(calls[0]!.url).toBe("https://www.zohoapis.in/books/v3/bills?status=open&vendor_id=zv1&organization_id=60001");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Zoho-oauthtoken at-1");
    expect((await z.call("zoho.get_vendor", { vendor_id: "zv1" }, ctx())).data).toMatchObject({ bank_account: "•••• 7890", ifsc: "HDFC1" });
    expect((await z.call("zoho.create_bill", { vendor_id: "zv1", bill_number: "INV-2", bill_date: "2026-10-01", amount_inr: 5 }, ctx())).ref).toBe("zb2");
    expect(JSON.parse(String(calls.at(-1)!.init.body)).line_items[0].account_id).toBe("acc1");
    expect((await z.call("zoho.record_bill_payment", { bill_id: "zb1", amount_inr: 100 }, ctx())).ref).toBe("VP-1");
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toMatchObject({ vendor_id: "zv1", bills: [{ bill_id: "zb1", amount_applied: 100 }], paid_through_account_id: "bank1" });
    await z.call("zoho.update_vendor", { vendor_id: "zv1", fields: { email: "n@s.in", address: "Pune", ifsc: "X1" } }, ctx());
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ email: "n@s.in", billing_address: { address: "Pune" }, custom_fields: [{ api_name: "cf_ifsc", value: "X1" }] });
    await expect(z.call("gmail.search", {}, ctx())).rejects.toThrow(/does not handle/);
  });

  it("describes, gathers evidence and lists vendor domains", async () => {
    const { f } = fakeFetch(handler);
    const z = zohoConnector(zohoCfg, f);
    expect(await z.describe("zoho.record_bill_payment", { bill_id: "zb1" }, ctx())).toEqual({ vendor: "Sharma", bill: "INV-1" });
    expect(await z.describe("zoho.get_vendor", { vendor_id: "zv1" }, ctx())).toEqual({ vendor: "Sharma" });
    expect(await z.describe("zoho.get_vendor", { vendor_id: "missing" }, ctx())).toEqual({});
    expect(await z.describe("zoho.list_bills", {}, ctx())).toEqual({});
    const ev = await z.evidence("zoho.record_bill_payment", { bill_id: "zb1" }, ctx());
    expect(ev).toMatchObject({ bill: { number: "INV-1" }, vendor: { name: "Sharma", bank: "•••• 7890" } });
    expect(await z.evidence("zoho.record_bill_payment", { bill_id: "missing" }, ctx())).toEqual({});
    expect(await z.vendorDomains(ctx())).toEqual(["sharma.in", "other.in"]);
    expect(await zohoOrganizations(zohoCfg, "at", f)).toEqual([{ organization_id: "60001", name: "Acme" }]);
  });

  it("needs an organisation id and handles upstream errors", async () => {
    const { f } = fakeFetch(handler);
    const z = zohoConnector(zohoCfg, f);
    await expect(z.call("zoho.list_bills", {}, { orgId: "o", tokens: tokens() })).rejects.toThrow(/organisation is not set/);
    expect(await z.vendorDomains({ orgId: "o", tokens: tokens() })).toEqual([]);
    const { f: down } = fakeFetch(() => ({ status: 503, body: {} }));
    await expect(zohoOrganizations(zohoCfg, "at", down)).rejects.toThrow(/503/);
    const { f: empty } = fakeFetch(() => ({ body: {} }));
    expect(await zohoOrganizations(zohoCfg, "at", empty)).toEqual([]);
    expect(((await zohoConnector(zohoCfg, empty).call("zoho.list_bills", {}, ctx())).data as { bills: unknown[] }).bills).toEqual([]);
    expect(await zohoConnector(zohoCfg, empty).vendorDomains(ctx())).toEqual([]);
  });
});
