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
      return `Read an email${str("from_domain") ? ` from ${str("from_domain")}` : ""}`;
    case "gmail.get_attachment":
      return `Open an email attachment${str("from_domain") ? ` from ${str("from_domain")}` : ""}`;
    case "gmail.draft_reply":
      return "Draft a reply";
    case "gmail.send_reply":
      return `Send a reply${str("to_domain") ? ` to ${str("to_domain")}` : ""}`;
    default:
      return isKnownTool(tool) ? TOOLS[tool].label : `Use an unknown tool “${tool}”`;
  }
}

const OPS: Record<string, string> = { lt: "under", lte: "up to", gt: "over", gte: "at least", eq: "exactly", in: "one of" };

function conditionWords(field: string, cond: unknown): string {
  if (field === "to_domain_in") {
    return typeof cond === "string" ? `to someone at a ${cond === "vendor_domains" ? "known vendor" : cond.replace(/_/g, " ")}` : `to ${(cond as string[]).join(", ")}`;
  }
  if (field === "fields_include") return `it changes the ${listWords((cond as string[]).map((f) => FIELD_LABELS[f] ?? f))}`;
  const name = field === "amount_inr" ? "the amount" : field.replace(/_/g, " ");
  const c = (cond ?? {}) as Record<string, unknown>;
  const parts = Object.entries(c).map(([op, v]) => {
    const value = field === "amount_inr" && typeof v === "number" ? formatINR(v) : Array.isArray(v) ? v.join(", ") : String(v);
    return `${OPS[op] ?? op} ${value}`;
  });
  return `${name} is ${parts.join(" and ")}`;
}

/** "Ask finance before: Record a payment, when the amount is over ₹50,000" */
export function describeRule(rule: { tool: string; decide: string; approver?: string; when?: Record<string, unknown> }): string {
  const label = isKnownTool(rule.tool) ? TOOLS[rule.tool].label : rule.tool;
  const when = Object.entries(rule.when ?? {}).map(([k, v]) => conditionWords(k, v));
  const verb = rule.decide === "allow" ? "Allow" : rule.decide === "ask" ? `Ask ${rule.approver ?? "a person"} before` : "Never allow";
  return `${verb}: ${label.toLowerCase()}${when.length ? `, when ${when.join(" and ")}` : ""}`;
}
