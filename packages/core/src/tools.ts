import { z } from "zod";

// The only tools any connector may expose. No delete, forward or settings tools exist.

const id = z.string().min(1).max(200);
const email = z.string().email().max(320);
const amount = z.number().finite().nonnegative().max(1e12);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export const VENDOR_FIELDS = ["name", "email", "phone", "address", "gstin", "bank_account", "ifsc"] as const;

export const TOOL_ARGS = {
  "gmail.search": z.object({ query: z.string().max(500), max_results: z.number().int().min(1).max(50).optional() }).strict(),
  "gmail.read_message": z.object({ message_id: id }).strict(),
  "gmail.get_attachment": z.object({ message_id: id, attachment_id: id }).strict(),
  "gmail.draft_reply": z.object({ message_id: id, body: z.string().max(20000) }).strict(),
  "gmail.send_reply": z.object({ message_id: id, to: email, body: z.string().max(20000) }).strict(),
  "zoho.list_bills": z.object({ status: z.enum(["open", "paid", "overdue"]).optional(), vendor_id: id.optional() }).strict(),
  "zoho.get_vendor": z.object({ vendor_id: id }).strict(),
  "zoho.create_bill": z
    .object({
      vendor_id: id,
      bill_number: z.string().min(1).max(100),
      bill_date: isoDate,
      due_date: isoDate.optional(),
      amount_inr: amount,
      description: z.string().max(500).optional(),
    })
    .strict(),
  "zoho.record_bill_payment": z
    .object({ bill_id: id, amount_inr: amount, paid_on: isoDate.optional(), reference: z.string().max(100).optional() })
    .strict(),
  "zoho.update_vendor": z
    .object({
      vendor_id: id,
      fields: z
        .object(Object.fromEntries(VENDOR_FIELDS.map((f) => [f, z.string().max(500).optional()])) as Record<
          (typeof VENDOR_FIELDS)[number],
          z.ZodOptional<z.ZodString>
        >)
        .strict(),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof TOOL_ARGS;
export const TOOL_NAMES = Object.keys(TOOL_ARGS) as ToolName[];

export interface ToolInfo {
  name: ToolName;
  connector: "gmail" | "zoho";
  label: string;
  description: string;
  /** Moves money out of the business. High-risk agents need an ask rule for these. */
  movesMoney: boolean;
  /** Non-sensitive identifiers that may be copied into a receipt for display. */
  summaryFields: string[];
}

export const TOOLS: Record<ToolName, ToolInfo> = {
  "gmail.search": { name: "gmail.search", connector: "gmail", label: "Search mail", description: "Search the mailbox for messages.", movesMoney: false, summaryFields: [] },
  "gmail.read_message": { name: "gmail.read_message", connector: "gmail", label: "Read an email", description: "Read one message (sender, subject, body, attachment list).", movesMoney: false, summaryFields: ["message_id"] },
  "gmail.get_attachment": { name: "gmail.get_attachment", connector: "gmail", label: "Open an attachment", description: "Download one attachment from a message.", movesMoney: false, summaryFields: ["message_id", "attachment_id"] },
  "gmail.draft_reply": { name: "gmail.draft_reply", connector: "gmail", label: "Draft a reply", description: "Save a reply as a draft. Nothing is sent.", movesMoney: false, summaryFields: ["message_id"] },
  "gmail.send_reply": { name: "gmail.send_reply", connector: "gmail", label: "Send a reply", description: "Send a reply on an existing thread.", movesMoney: false, summaryFields: ["message_id"] },
  "zoho.list_bills": { name: "zoho.list_bills", connector: "zoho", label: "List bills", description: "List bills in Zoho Books.", movesMoney: false, summaryFields: ["status", "vendor_id"] },
  "zoho.get_vendor": { name: "zoho.get_vendor", connector: "zoho", label: "Look up a vendor", description: "Read a vendor's details.", movesMoney: false, summaryFields: ["vendor_id"] },
  "zoho.create_bill": { name: "zoho.create_bill", connector: "zoho", label: "Create a bill", description: "Create a bill for a vendor invoice.", movesMoney: false, summaryFields: ["vendor_id", "bill_number", "amount_inr"] },
  "zoho.record_bill_payment": { name: "zoho.record_bill_payment", connector: "zoho", label: "Record a payment", description: "Record a payment against a bill.", movesMoney: true, summaryFields: ["bill_id", "amount_inr"] },
  "zoho.update_vendor": { name: "zoho.update_vendor", connector: "zoho", label: "Update a vendor", description: "Change a vendor's details.", movesMoney: false, summaryFields: ["vendor_id"] },
};

export function isKnownTool(tool: string): tool is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_ARGS, tool);
}

/** Fields every limit applies to. Only one limit exists today. */
export const LIMIT_TOOLS: Record<"daily_payments_inr", { tool: ToolName; field: string }> = {
  daily_payments_inr: { tool: "zoho.record_bill_payment", field: "amount_inr" },
};
