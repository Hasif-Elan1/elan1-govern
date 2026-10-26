import { z } from "zod";

// ---- Risk tags: what an action can do, independent of the tool or industry ----

export const RISK_TAGS = ["reads_data", "writes_data", "moves_money", "sends_external", "personal_data", "deletes", "changes_access", "changes_production"] as const;
export type RiskTag = (typeof RISK_TAGS)[number];

export const RISK_TAG_LABELS: Record<RiskTag, string> = {
  reads_data: "reads data",
  writes_data: "changes records",
  moves_money: "moves money",
  sends_external: "contacts people outside the company",
  personal_data: "touches personal data",
  deletes: "deletes data",
  changes_access: "changes who can access what",
  changes_production: "changes production systems",
};

/** Tags that a high-risk agent may never use without at least one "ask" rule. */
export const HIGH_IMPACT_TAGS: RiskTag[] = ["moves_money", "deletes", "changes_access", "changes_production"];

// ---- Built-in tools (Gmail and Zoho Books). Other tools come from connectors at runtime. ----

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
  tags: RiskTag[];
}

export const TOOLS: Record<ToolName, ToolInfo> = {
  "gmail.search": { name: "gmail.search", connector: "gmail", label: "Search mail", description: "Search the mailbox for messages.", movesMoney: false, summaryFields: [], tags: ["reads_data"] },
  "gmail.read_message": { name: "gmail.read_message", connector: "gmail", label: "Read an email", description: "Read one message (sender, subject, body, attachment list).", movesMoney: false, summaryFields: ["message_id"], tags: ["reads_data", "personal_data"] },
  "gmail.get_attachment": { name: "gmail.get_attachment", connector: "gmail", label: "Open an attachment", description: "Download one attachment from a message.", movesMoney: false, summaryFields: ["message_id", "attachment_id"], tags: ["reads_data", "personal_data"] },
  "gmail.draft_reply": { name: "gmail.draft_reply", connector: "gmail", label: "Draft a reply", description: "Save a reply as a draft. Nothing is sent.", movesMoney: false, summaryFields: ["message_id"], tags: ["writes_data"] },
  "gmail.send_reply": { name: "gmail.send_reply", connector: "gmail", label: "Send a reply", description: "Send a reply on an existing thread.", movesMoney: false, summaryFields: ["message_id"], tags: ["sends_external", "personal_data"] },
  "zoho.list_bills": { name: "zoho.list_bills", connector: "zoho", label: "List bills", description: "List bills in Zoho Books.", movesMoney: false, summaryFields: ["status", "vendor_id"], tags: ["reads_data"] },
  "zoho.get_vendor": { name: "zoho.get_vendor", connector: "zoho", label: "Look up a vendor", description: "Read a vendor's details.", movesMoney: false, summaryFields: ["vendor_id"], tags: ["reads_data"] },
  "zoho.create_bill": { name: "zoho.create_bill", connector: "zoho", label: "Create a bill", description: "Create a bill for a vendor invoice.", movesMoney: false, summaryFields: ["vendor_id", "bill_number", "amount_inr"], tags: ["writes_data"] },
  "zoho.record_bill_payment": { name: "zoho.record_bill_payment", connector: "zoho", label: "Record a payment", description: "Record a payment against a bill.", movesMoney: true, summaryFields: ["bill_id", "amount_inr"], tags: ["moves_money", "writes_data"] },
  "zoho.update_vendor": { name: "zoho.update_vendor", connector: "zoho", label: "Update a vendor", description: "Change a vendor's details.", movesMoney: false, summaryFields: ["vendor_id"], tags: ["writes_data", "personal_data"] },
};

export function isKnownTool(tool: string): tool is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_ARGS, tool);
}

/** The built-in daily payments limit (rulebook `limits.daily_payments_inr`). */
export const LIMIT_TOOLS: Record<"daily_payments_inr", { tool: ToolName; field: string }> = {
  daily_payments_inr: { tool: "zoho.record_bill_payment", field: "amount_inr" },
};

// ---- The registry: what the engine, the rulebook validator and the UI consult ----

export interface ToolSpec {
  /** Namespaced: "<connector>.<tool>", e.g. "zoho.record_bill_payment" or "crm.update_contact". */
  name: string;
  connector: string;
  label: string;
  description: string;
  tags: RiskTag[];
  /** Non-sensitive identifiers that may be copied into a receipt for display. */
  summaryFields: string[];
  /** Argument names, used to check rule conditions. */
  fields: string[];
  /** Strict validation for built-in tools. Runtime tools are checked against `inputSchema`. */
  schema?: z.ZodType;
  /** JSON Schema of the arguments (always present; derived for built-in tools). */
  inputSchema?: Record<string, unknown>;
  /** Field names are not known (lenient loading); conditions on any field are accepted. */
  open?: boolean;
}

export interface ToolRegistry {
  get(name: string): ToolSpec | undefined;
  list(): ToolSpec[];
}

export function createRegistry(specs: readonly ToolSpec[]): ToolRegistry {
  const byName = new Map(specs.map((s) => [s.name, s]));
  return { get: (n) => byName.get(n), list: () => [...byName.values()] };
}

export function mergeRegistries(...regs: ToolRegistry[]): ToolRegistry {
  return createRegistry(regs.flatMap((r) => r.list()));
}

/** Knows every tool in `base`, and accepts any well-formed tool name with unknown fields. */
export function lenientRegistry(base: ToolRegistry): ToolRegistry {
  return {
    get: (n) => base.get(n) ?? (isValidToolName(n) ? { name: n, connector: n.split(".")[0] as string, label: n, description: "", tags: [], summaryFields: [], fields: [], open: true } : undefined),
    list: () => base.list(),
  };
}

export const BUILTIN_TOOLS: ToolSpec[] = TOOL_NAMES.map((n) => ({
  name: n,
  connector: TOOLS[n].connector,
  label: TOOLS[n].label,
  description: TOOLS[n].description,
  tags: TOOLS[n].tags,
  summaryFields: TOOLS[n].summaryFields,
  fields: Object.keys(TOOL_ARGS[n].shape),
  schema: TOOL_ARGS[n],
}));

export const builtinRegistry = createRegistry(BUILTIN_TOOLS);

const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}\.[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME_RE.test(name);
}

/** A tool discovered at runtime (e.g. from an upstream MCP server), described by JSON Schema. */
export function specFromJsonSchema(input: { name: string; connector: string; description?: string; inputSchema?: Record<string, unknown>; tags?: RiskTag[]; label?: string }): ToolSpec {
  const props = (input.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const fields = Object.keys(props);
  // Display identifiers: short scalar id-like fields only. Never bodies or free text.
  const summaryFields = fields.filter((f) => /(^id$|_id$|^amount$|_amount$|^amount_)/.test(f));
  const short = input.name.split(".").slice(1).join(".");
  return {
    name: input.name,
    connector: input.connector,
    label: input.label ?? short.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    description: input.description ?? "",
    tags: input.tags ?? [],
    summaryFields,
    fields,
    inputSchema: input.inputSchema ?? { type: "object" },
  };
}

/** Validate arguments: zod for built-in tools; for runtime tools, an object with only known top-level fields. */
export function validateArgs(spec: ToolSpec, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (spec.schema) {
    const r = spec.schema.safeParse(args ?? {});
    if (r.success) return { ok: true, args: r.data as Record<string, unknown> };
    const i = r.error.issues[0];
    return { ok: false, error: `${i?.path.length ? `${i.path.join(".")}: ` : ""}${i?.message ?? "invalid"}` };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "arguments must be an object" };
  const schema = spec.inputSchema ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const r of required) if (!(r in (args as object))) return { ok: false, error: `${r}: required` };
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(args as object)) if (!spec.fields.includes(k)) return { ok: false, error: `${k}: not an argument of ${spec.name}` };
  }
  if (JSON.stringify(args).length > 200_000) return { ok: false, error: "arguments are too large" };
  return { ok: true, args: args as Record<string, unknown> };
}
