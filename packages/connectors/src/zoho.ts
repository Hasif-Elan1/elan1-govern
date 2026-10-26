import type { ToolName } from "@gate/core";
import { authedJson } from "./http";
import type { Fetch, ProviderConfig } from "./oauth";
import { ConnectorError, type Connector, type ConnectorContext, type Evidence } from "./types";

export interface ZohoConfig extends ProviderConfig {
  /** API host for the data centre, https://www.zohoapis.in for India. */
  apiUrl: string;
}

interface ZohoBill {
  bill_id: string;
  bill_number: string;
  vendor_id: string;
  vendor_name: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
}

interface ZohoContact {
  contact_id: string;
  contact_name: string;
  email?: string;
  phone?: string;
  gst_no?: string;
  billing_address?: { address?: string; city?: string };
  custom_fields?: { api_name?: string; value?: string }[];
}

const VENDOR_FIELD_MAP: Record<string, string> = { name: "contact_name", email: "email", phone: "phone", gstin: "gst_no" };

export function zohoConnector(cfg: ZohoConfig, f: Fetch = fetch): Connector {
  const orgId = (ctx: ConnectorContext) => {
    const id = ctx.meta?.zoho_org_id;
    if (typeof id !== "string" || !id) throw new ConnectorError("Zoho Books organisation is not set; reconnect Zoho Books", "auth");
    return id;
  };
  const req = (ctx: ConnectorContext, method: string, path: string, body?: unknown) => {
    const sep = path.includes("?") ? "&" : "?";
    return authedJson(
      "zoho",
      cfg,
      ctx,
      `${cfg.apiUrl}/books/v3${path}${sep}organization_id=${encodeURIComponent(orgId(ctx))}`,
      { method, authScheme: "Zoho-oauthtoken", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) },
      f,
    ) as Promise<Record<string, unknown>>;
  };
  const bill = async (ctx: ConnectorContext, id: string) => (await req(ctx, "GET", `/bills/${encodeURIComponent(id)}`)).bill as ZohoBill;
  const contact = async (ctx: ConnectorContext, id: string) => (await req(ctx, "GET", `/contacts/${encodeURIComponent(id)}`)).contact as ZohoContact;
  const cf = (c: ZohoContact, name: string) => c.custom_fields?.find((x) => x.api_name === name)?.value;
  const vendorOut = (c: ZohoContact) => ({
    vendor_id: c.contact_id,
    name: c.contact_name,
    email: c.email,
    phone: c.phone,
    gstin: c.gst_no,
    address: c.billing_address?.address,
    bank_account: cf(c, "cf_bank_account") ? `•••• ${String(cf(c, "cf_bank_account")).slice(-4)}` : undefined,
    ifsc: cf(c, "cf_ifsc"),
  });

  return {
    kind: "zoho",
    async call(tool: ToolName, args, ctx) {
      switch (tool) {
        case "zoho.list_bills": {
          const q = new URLSearchParams();
          if (args.status) q.set("status", String(args.status));
          if (args.vendor_id) q.set("vendor_id", String(args.vendor_id));
          const res = await req(ctx, "GET", `/bills?${q}`);
          const bills = (res.bills as ZohoBill[] | undefined) ?? [];
          return { data: { bills: bills.map((b) => ({ bill_id: b.bill_id, bill_number: b.bill_number, vendor_id: b.vendor_id, vendor_name: b.vendor_name, date: b.date, due_date: b.due_date, total_inr: b.total, balance_inr: b.balance, status: b.status })) } };
        }
        case "zoho.get_vendor":
          return { data: vendorOut(await contact(ctx, String(args.vendor_id))) };
        case "zoho.create_bill": {
          const account = ctx.meta?.expense_account_id;
          const res = await req(ctx, "POST", "/bills", {
            vendor_id: args.vendor_id,
            bill_number: args.bill_number,
            date: args.bill_date,
            due_date: args.due_date,
            line_items: [{ description: args.description ?? `Bill ${String(args.bill_number)}`, rate: args.amount_inr, quantity: 1, ...(account ? { account_id: account } : {}) }],
          });
          const b = res.bill as ZohoBill;
          return { data: { bill_id: b.bill_id, bill_number: b.bill_number, status: b.status }, ref: b.bill_id };
        }
        case "zoho.record_bill_payment": {
          const b = await bill(ctx, String(args.bill_id));
          const amount = Number(args.amount_inr);
          const res = await req(ctx, "POST", "/vendorpayments", {
            vendor_id: b.vendor_id,
            amount,
            date: args.paid_on ?? new Date().toISOString().slice(0, 10),
            reference_number: args.reference,
            bills: [{ bill_id: b.bill_id, amount_applied: amount }],
            ...(ctx.meta?.paid_through_account_id ? { paid_through_account_id: ctx.meta.paid_through_account_id } : {}),
          });
          const p = res.vendorpayment as { payment_id: string; payment_number?: string };
          return { data: { payment_id: p.payment_id, payment_number: p.payment_number, bill_id: b.bill_id }, ref: p.payment_number ?? p.payment_id };
        }
        case "zoho.update_vendor": {
          const fields = (args.fields ?? {}) as Record<string, string | undefined>;
          const body: Record<string, unknown> = {};
          const custom: { api_name: string; value: string }[] = [];
          for (const [k, v] of Object.entries(fields)) {
            if (v === undefined) continue;
            if (VENDOR_FIELD_MAP[k]) body[VENDOR_FIELD_MAP[k]] = v;
            else if (k === "address") body.billing_address = { address: v };
            else custom.push({ api_name: `cf_${k}`, value: v });
          }
          if (custom.length) body.custom_fields = custom;
          const res = await req(ctx, "PUT", `/contacts/${encodeURIComponent(String(args.vendor_id))}`, body);
          const c = res.contact as ZohoContact;
          return { data: vendorOut(c), ref: c.contact_id };
        }
        default:
          throw new ConnectorError(`Zoho Books does not handle ${tool}`, "invalid");
      }
    },
    async describe(tool, args, ctx): Promise<Record<string, string>> {
      try {
        if (typeof args.bill_id === "string") {
          const b = await bill(ctx, args.bill_id);
          return { vendor: b.vendor_name, bill: b.bill_number };
        }
        if (typeof args.vendor_id === "string") return { vendor: (await contact(ctx, args.vendor_id)).contact_name };
      } catch {
        // Display names are a nicety; the decision never depends on them.
      }
      return {};
    },
    async evidence(_tool, args, ctx): Promise<Evidence> {
      const ev: Evidence = {};
      try {
        let vendorId = typeof args.vendor_id === "string" ? args.vendor_id : undefined;
        if (typeof args.bill_id === "string") {
          const b = await bill(ctx, args.bill_id);
          vendorId = b.vendor_id;
          ev.bill = { id: b.bill_id, number: b.bill_number, date: b.date, due_date: b.due_date, total_inr: b.total, balance_inr: b.balance, status: b.status };
        }
        if (vendorId) {
          const v = vendorOut(await contact(ctx, vendorId));
          ev.vendor = { id: v.vendor_id, name: v.name, email: v.email, gstin: v.gstin, bank: v.bank_account, ifsc: v.ifsc };
        }
      } catch {
        // Evidence is best effort; the approver still sees the action and the rule.
      }
      return ev;
    },
    async vendorDomains(ctx) {
      try {
        const res = await req(ctx, "GET", "/contacts?contact_type=vendor&per_page=200");
        const contacts = (res.contacts as ZohoContact[] | undefined) ?? [];
        return [...new Set(contacts.map((c) => c.email?.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d))];
      } catch {
        return [];
      }
    },
  };
}

/** After OAuth: find the Zoho Books organisation to use. */
export async function zohoOrganizations(cfg: ZohoConfig, accessToken: string, f: Fetch = fetch): Promise<{ organization_id: string; name: string }[]> {
  const res = await f(`${cfg.apiUrl}/books/v3/organizations`, { headers: { authorization: `Zoho-oauthtoken ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as { organizations?: { organization_id: string; name: string }[] };
  if (!res.ok) throw new ConnectorError(`Zoho Books said: HTTP ${res.status}`, "upstream");
  return json.organizations ?? [];
}
