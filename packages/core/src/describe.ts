import { TOOLS, isKnownTool } from "./tools";

/** Indian digit grouping: 200000 -> "₹2,00,000", 1234.5 -> "₹1,234.50". */
export function formatINR(amount: number): string {
  if (!Number.isFinite(amount)) return "₹—";
  const negative = amount < 0;
  const [whole, frac] = Math.abs(amount).toFixed(2).split(".") as [string, string];
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}${frac === "00" ? "" : `.${frac}`}`;
}

const FIELD_LABELS: Record<string, string> = {
  bank_account: "bank account",
  ifsc: "IFSC",
  gstin: "GSTIN",
  email: "email",
  phone: "phone",
  address: "address",
  name: "name",
};

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One plain sentence for an action, built only from the stored summary. */
export function describeAction(tool: string, s: Record<string, unknown>): string {
  const str = (k: string) => (typeof s[k] === "string" || typeof s[k] === "number" ? String(s[k]) : undefined);
  const amount = typeof s.amount_inr === "number" ? formatINR(s.amount_inr) : undefined;
  const vendor = str("vendor") ?? (str("vendor_id") ? `vendor ${str("vendor_id")}` : "a vendor");
  switch (tool) {
    case "zoho.record_bill_payment":
      return `Pay ${amount ?? "an amount"} to ${vendor}${str("bill") ? ` for ${str("bill")}` : ""}`;
    case "zoho.update_vendor": {
      const fields = Array.isArray(s.fields) ? s.fields.map((f) => FIELD_LABELS[String(f)] ?? String(f)) : [];
      return fields.length ? `Change the ${listWords(fields)} for ${vendor}` : `Update ${vendor}`;
    }
    case "zoho.create_bill":
      return `Create bill ${str("bill_number") ?? ""} for ${amount ?? "an amount"} from ${vendor}`.replace("  ", " ");
    case "zoho.list_bills":
      return "List bills in Zoho Books";
    case "zoho.get_vendor":
      return `Look up ${vendor}`;
    case "gmail.search":
      return "Search the mailbox";
    case "gmail.read_message":
      return `Read an email${str("subject") ? `: ${str("subject")}` : ""}`;
    case "gmail.get_attachment":
      return "Open an email attachment";
    case "gmail.draft_reply":
      return "Draft a reply";
    case "gmail.send_reply":
      return `Send a reply${str("to_domain") ? ` to ${str("to_domain")}` : ""}`;
    default:
      return isKnownTool(tool) ? TOOLS[tool].label : `Use an unknown tool “${tool}”`;
  }
}
