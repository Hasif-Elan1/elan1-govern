import type { InvoiceDoc } from "./types";

// Seeded, fictional data for the mock Gmail and Zoho Books. GSTINs, accounts and
// addresses are made up. Dates are relative to "now" so the demo never looks stale.

export interface MockVendor {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  gstin: string;
  bank_account: string;
  ifsc: string;
}

export interface MockBill {
  id: string;
  vendor_id: string;
  number: string;
  date: string;
  due_date: string;
  total_inr: number;
  balance_inr: number;
  status: "open" | "paid" | "overdue";
  message_id?: string;
}

export interface MockMessage {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: { id: string; filename: string; mime_type: string; size: number; invoice?: InvoiceDoc }[];
}

export interface MockPayment {
  id: string;
  bill_id: string;
  amount_inr: number;
  paid_on: string;
  reference?: string;
}

export interface MockState {
  vendors: MockVendor[];
  bills: MockBill[];
  messages: MockMessage[];
  payments: MockPayment[];
  drafts: { id: string; message_id: string; body: string }[];
  sent: { id: string; message_id: string; to: string; body: string }[];
  seq: number;
}

const BUYER = { name: "Demo Traders Pvt Ltd", gstin: "27AAACD1234F1Z5", address: "4th Floor, Kamala Mills, Lower Parel, Mumbai 400013" };

function day(offset: number, now: Date): string {
  const d = new Date(now.getTime() + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function invoice(
  number: string,
  date: string,
  seller: { name: string; gstin: string; address: string },
  lines: [string, string, number, number][],
  interstate: boolean,
): InvoiceDoc {
  const rows = lines.map(([description, hsn, qty, rate]) => ({ description, hsn, qty, rate, amount: qty * rate }));
  const taxable = rows.reduce((s, r) => s + r.amount, 0);
  // GST at 18%, total rounded to the rupee as Indian invoices do.
  const total = Math.round(taxable * 1.18);
  const tax = Math.round((total - taxable) * 100) / 100;
  const half = Math.round((tax / 2) * 100) / 100;
  return {
    filename: `${number}.pdf`,
    number,
    date,
    seller,
    buyer: BUYER,
    lines: rows,
    taxable_inr: taxable,
    cgst_inr: interstate ? 0 : half,
    sgst_inr: interstate ? 0 : Math.round((tax - half) * 100) / 100,
    igst_inr: interstate ? tax : 0,
    total_inr: total,
  };
}

export function seedMockState(now = new Date()): MockState {
  const vendors: MockVendor[] = [
    { id: "v_sharma", name: "Sharma Traders", email: "accounts@sharmatraders.in", phone: "+91 22 4012 7788", address: "12 Kalbadevi Road, Mumbai 400002", city: "Mumbai", gstin: "27AAJFS4821K1Z3", bank_account: "50100248214821", ifsc: "HDFC0000123" },
    { id: "v_kaveri", name: "Kaveri Logistics", email: "billing@kaverilogistics.in", phone: "+91 80 2559 1140", address: "88 Peenya Industrial Area, Bengaluru 560058", city: "Bengaluru", gstin: "29AAKCK7712M1Z8", bank_account: "002105017712", ifsc: "ICIC0000021" },
    { id: "v_nilgiri", name: "Nilgiri Office Supplies", email: "accounts@nilgirioffice.in", phone: "+91 422 230 4471", address: "21 Avinashi Road, Coimbatore 641018", city: "Coimbatore", gstin: "33AAPFN3390Q1Z1", bank_account: "910020033390", ifsc: "UTIB0000456" },
  ];
  const seller = (v: MockVendor) => ({ name: v.name, gstin: v.gstin, address: v.address });
  const [sharma, kaveri, nilgiri] = vendors as [MockVendor, MockVendor, MockVendor];

  const invSharma = invoice("INV-2291", day(-6, now), seller(sharma), [["Corrugated cartons, 5-ply (bundle of 100)", "4819", 120, 1250], ["Stretch film rolls, 23 micron", "3920", 40, 487.29]], false);
  const invKaveri = invoice("KL-1187", day(-4, now), seller(kaveri), [["Freight, Bengaluru to Mumbai, part load", "9965", 1, 15254.24]], true);
  const invNilgiri = invoice("NOS-554", day(-3, now), seller(nilgiri), [["A4 copier paper, 75 gsm (box of 5 reams)", "4802", 40, 650], ["Toner cartridge, HP 88A", "8443", 4, 2500]], true);

  const messages: MockMessage[] = [
    {
      id: "m_101", thread_id: "t_101", from: `Sharma Traders <${sharma.email}>`, to: "ap@demotraders.in",
      subject: "Invoice INV-2291 for October supplies", date: day(-6, now),
      body: "Dear Sir/Madam,\n\nPlease find attached our invoice INV-2291 for packaging material supplied this month. Kindly arrange payment by the due date.\n\nRegards,\nAccounts, Sharma Traders",
      attachments: [{ id: "a_101", filename: invSharma.filename, mime_type: "application/pdf", size: 48213, invoice: invSharma }],
    },
    {
      id: "m_102", thread_id: "t_102", from: `Kaveri Logistics <${kaveri.email}>`, to: "ap@demotraders.in",
      subject: "KL-1187: freight charges", date: day(-4, now),
      body: "Hello,\n\nAttached is invoice KL-1187 for the part-load shipment to Mumbai.\n\nThanks,\nKaveri Logistics billing",
      attachments: [{ id: "a_102", filename: invKaveri.filename, mime_type: "application/pdf", size: 31877, invoice: invKaveri }],
    },
    {
      id: "m_103", thread_id: "t_103", from: `Nilgiri Office Supplies <${nilgiri.email}>`, to: "ap@demotraders.in",
      subject: "Invoice NOS-554", date: day(-3, now),
      body: "Hi team,\n\nInvoice NOS-554 for office supplies is attached.\n\nNilgiri Office Supplies",
      attachments: [{ id: "a_103", filename: invNilgiri.filename, mime_type: "application/pdf", size: 29544, invoice: invNilgiri }],
    },
    {
      id: "m_104", thread_id: "t_104", from: "GST Updates <newsletter@gst-updates.example>", to: "ap@demotraders.in",
      subject: "GSTR-3B due date reminder", date: day(-1, now),
      body: "This is a reminder that GSTR-3B for the month is due on the 20th.",
      attachments: [],
    },
  ];

  const bills: MockBill[] = [
    { id: "bill_2291", vendor_id: sharma.id, number: "INV-2291", date: invSharma.date, due_date: day(9, now), total_inr: invSharma.total_inr, balance_inr: invSharma.total_inr, status: "open", message_id: "m_101" },
    { id: "bill_1187", vendor_id: kaveri.id, number: "KL-1187", date: invKaveri.date, due_date: day(11, now), total_inr: invKaveri.total_inr, balance_inr: invKaveri.total_inr, status: "open", message_id: "m_102" },
    { id: "bill_554", vendor_id: nilgiri.id, number: "NOS-554", date: invNilgiri.date, due_date: day(12, now), total_inr: invNilgiri.total_inr, balance_inr: invNilgiri.total_inr, status: "open", message_id: "m_103" },
  ];

  return { vendors, bills, messages, payments: [], drafts: [], sent: [], seq: 8800 };
}
