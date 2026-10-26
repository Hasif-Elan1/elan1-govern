import { seedMockState, type MockState, type MockVendor } from "./mock-data";
import { ConnectorError, type Connector, type ConnectorContext, type Evidence } from "./types";

// One in-memory mailbox and ledger per org. Restarting the gate service resets it.
const states = new Map<string, MockState>();

export function mockState(orgId: string): MockState {
  let s = states.get(orgId);
  if (!s) {
    s = seedMockState();
    states.set(orgId, s);
  }
  return s;
}

export function resetMockState(orgId?: string) {
  if (orgId) states.delete(orgId);
  else states.clear();
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function vendorOf(s: MockState, id: string): MockVendor {
  const v = s.vendors.find((x) => x.id === id);
  if (!v) throw new ConnectorError(`No vendor with id ${id}`, "not_found");
  return v;
}

function billOf(s: MockState, id: string) {
  const b = s.bills.find((x) => x.id === id);
  if (!b) throw new ConnectorError(`No bill with id ${id}`, "not_found");
  return b;
}

function messageOf(s: MockState, id: string) {
  const m = s.messages.find((x) => x.id === id);
  if (!m) throw new ConnectorError(`No message with id ${id}`, "not_found");
  return m;
}

const maskAccount = (acct: string) => `•••• ${acct.slice(-4)}`;

function publicVendor(v: MockVendor) {
  return { vendor_id: v.id, name: v.name, email: v.email, phone: v.phone, address: v.address, gstin: v.gstin, bank_account: maskAccount(v.bank_account), ifsc: v.ifsc };
}

export const mockGmail: Connector = {
  kind: "gmail",
  async call(tool: string, args, ctx) {
    const s = mockState(ctx.orgId);
    switch (tool) {
      case "gmail.search": {
        const q = str(args.query).toLowerCase();
        const terms = q.split(/\s+/).filter(Boolean).filter((t) => !t.includes(":"));
        const wantsAttachment = q.includes("has:attachment");
        const hits = s.messages.filter(
          (m) =>
            (!wantsAttachment || m.attachments.length > 0) &&
            terms.every((t) => `${m.subject} ${m.from} ${m.body}`.toLowerCase().includes(t)),
        );
        const max = typeof args.max_results === "number" ? args.max_results : 10;
        return { data: { messages: hits.slice(0, max).map((m) => ({ message_id: m.id, from: m.from, subject: m.subject, date: m.date, has_attachment: m.attachments.length > 0 })) } };
      }
      case "gmail.read_message": {
        const m = messageOf(s, str(args.message_id));
        return {
          data: { message_id: m.id, thread_id: m.thread_id, from: m.from, to: m.to, subject: m.subject, date: m.date, body: m.body, attachments: m.attachments.map(({ id, filename, mime_type, size }) => ({ attachment_id: id, filename, mime_type, size })) },
        };
      }
      case "gmail.get_attachment": {
        const m = messageOf(s, str(args.message_id));
        const a = m.attachments.find((x) => x.id === args.attachment_id);
        if (!a) throw new ConnectorError("No such attachment", "not_found");
        return { data: { attachment_id: a.id, filename: a.filename, mime_type: a.mime_type, size: a.size, extracted_invoice: a.invoice } };
      }
      case "gmail.draft_reply": {
        messageOf(s, str(args.message_id));
        const id = `d_${++s.seq}`;
        s.drafts.push({ id, message_id: str(args.message_id), body: str(args.body) });
        return { data: { draft_id: id }, ref: id };
      }
      case "gmail.send_reply": {
        messageOf(s, str(args.message_id));
        const id = `sent_${++s.seq}`;
        s.sent.push({ id, message_id: str(args.message_id), to: str(args.to), body: str(args.body) });
        return { data: { sent_id: id }, ref: id };
      }
      default:
        throw new ConnectorError(`Gmail does not handle ${tool}`, "invalid");
    }
  },
  async describe(_tool, args, ctx): Promise<Record<string, string>> {
    // The sender's domain only: enough to audit, without names or subjects.
    const m = typeof args.message_id === "string" ? mockState(ctx.orgId).messages.find((x) => x.id === args.message_id) : undefined;
    const domain = m ? /@([^>\s]+)/.exec(m.from)?.[1] : undefined;
    return domain ? { from_domain: domain.toLowerCase() } : {};
  },
  async evidence(tool, args, ctx) {
    const s = mockState(ctx.orgId);
    if (tool === "gmail.send_reply") {
      const m = s.messages.find((x) => x.id === args.message_id);
      const v = s.vendors.find((x) => m?.from.includes(x.email));
      return v ? { vendor: { id: v.id, name: v.name, email: v.email, gstin: v.gstin, city: v.city } } : {};
    }
    return {};
  },
  async vendorDomains(ctx) {
    return mockState(ctx.orgId).vendors.map((v) => v.email.split("@")[1] as string);
  },
};

export const mockZoho: Connector = {
  kind: "zoho",
  async call(tool: string, args, ctx) {
    const s = mockState(ctx.orgId);
    switch (tool) {
      case "zoho.list_bills": {
        const bills = s.bills.filter((b) => (!args.status || b.status === args.status) && (!args.vendor_id || b.vendor_id === args.vendor_id));
        return {
          data: { bills: bills.map((b) => ({ bill_id: b.id, bill_number: b.number, vendor_id: b.vendor_id, vendor_name: vendorOf(s, b.vendor_id).name, date: b.date, due_date: b.due_date, total_inr: b.total_inr, balance_inr: b.balance_inr, status: b.status })) },
        };
      }
      case "zoho.get_vendor":
        return { data: publicVendor(vendorOf(s, str(args.vendor_id))) };
      case "zoho.create_bill": {
        vendorOf(s, str(args.vendor_id));
        if (s.bills.some((b) => b.vendor_id === args.vendor_id && b.number === args.bill_number)) {
          throw new ConnectorError(`Bill ${str(args.bill_number)} already exists for this vendor`, "invalid");
        }
        const amount = Number(args.amount_inr);
        const bill = { id: `bill_${++s.seq}`, vendor_id: str(args.vendor_id), number: str(args.bill_number), date: str(args.bill_date), due_date: str(args.due_date) || str(args.bill_date), total_inr: amount, balance_inr: amount, status: "open" as const };
        s.bills.push(bill);
        return { data: { bill_id: bill.id, bill_number: bill.number, status: bill.status }, ref: bill.id };
      }
      case "zoho.record_bill_payment": {
        const bill = billOf(s, str(args.bill_id));
        const amount = Number(args.amount_inr);
        if (amount <= 0) throw new ConnectorError("Amount must be more than zero", "invalid");
        if (amount > bill.balance_inr + 0.001) throw new ConnectorError(`Amount is more than the bill's balance of ${bill.balance_inr}`, "invalid");
        const id = `PAY-${++s.seq}`;
        s.payments.push({ id, bill_id: bill.id, amount_inr: amount, paid_on: str(args.paid_on) || new Date().toISOString().slice(0, 10), reference: str(args.reference) || undefined });
        bill.balance_inr = Math.round((bill.balance_inr - amount) * 100) / 100;
        if (bill.balance_inr <= 0) bill.status = "paid";
        return { data: { payment_id: id, bill_id: bill.id, balance_inr: bill.balance_inr, status: bill.status }, ref: id };
      }
      case "zoho.update_vendor": {
        const v = vendorOf(s, str(args.vendor_id));
        const fields = (args.fields ?? {}) as Record<string, string | undefined>;
        for (const [k, val] of Object.entries(fields)) if (val !== undefined) (v as unknown as Record<string, string>)[k] = val;
        return { data: publicVendor(v), ref: v.id };
      }
      default:
        throw new ConnectorError(`Zoho Books does not handle ${tool}`, "invalid");
    }
  },
  async describe(tool, args, ctx) {
    const s = mockState(ctx.orgId);
    const out: Record<string, string> = {};
    const bill = typeof args.bill_id === "string" ? s.bills.find((b) => b.id === args.bill_id) : undefined;
    const vendorId = bill?.vendor_id ?? (typeof args.vendor_id === "string" ? args.vendor_id : undefined);
    const vendor = vendorId ? s.vendors.find((v) => v.id === vendorId) : undefined;
    if (vendor) out.vendor = vendor.name;
    if (bill) out.bill = bill.number;
    if (tool === "zoho.create_bill" && typeof args.bill_number === "string") out.bill = args.bill_number;
    return out;
  },
  async evidence(tool, args, ctx: ConnectorContext): Promise<Evidence> {
    const s = mockState(ctx.orgId);
    const bill = typeof args.bill_id === "string" ? s.bills.find((b) => b.id === args.bill_id) : undefined;
    const vendorId = bill?.vendor_id ?? (typeof args.vendor_id === "string" ? args.vendor_id : undefined);
    const v = vendorId ? s.vendors.find((x) => x.id === vendorId) : undefined;
    const ev: Evidence = {};
    if (v) ev.vendor = { id: v.id, name: v.name, email: v.email, gstin: v.gstin, bank: maskAccount(v.bank_account), ifsc: v.ifsc, city: v.city };
    if (bill) {
      ev.bill = { id: bill.id, number: bill.number, date: bill.date, due_date: bill.due_date, total_inr: bill.total_inr, balance_inr: bill.balance_inr, status: bill.status };
      const inv = s.messages.find((m) => m.id === bill.message_id)?.attachments[0]?.invoice;
      if (inv) ev.invoice = inv;
    }
    return ev;
  },
  async vendorDomains(ctx) {
    return mockGmail.vendorDomains(ctx);
  },
};
