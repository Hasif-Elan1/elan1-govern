import YAML from "yaml";
import { z } from "zod";
import { canonicalize, omit } from "./canonical";
import { hashCanonical, signText, verifyText } from "./crypto";
import { TOOL_ARGS, TOOLS, VENDOR_FIELDS, isKnownTool, type ToolName } from "./tools";

export const DECISIONS = ["allow", "ask", "refuse"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Lists Gate fills in at decision time, so a rulebook can say `to_domain_in: vendor_domains`. */
export const CONTEXT_LISTS = ["vendor_domains"] as const;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, numbers and dashes");
const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const durationRe = /^(\d{1,4})(m|h|d)$/;

export const ConditionSchema = z
  .object({
    eq: scalar.optional(),
    lt: z.number().finite().optional(),
    lte: z.number().finite().optional(),
    gt: z.number().finite().optional(),
    gte: z.number().finite().optional(),
    in: z.array(scalar).min(1).max(200).optional(),
  })
  .strict()
  .refine((c) => Object.values(c).some((v) => v !== undefined), "a condition needs at least one operator");
export type Condition = z.infer<typeof ConditionSchema>;

export const WhenSchema = z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), z.unknown());
export type When = Record<string, unknown>;

export const RuleSchema = z
  .object({
    id: slug,
    tool: z.string().min(1).max(100),
    when: WhenSchema.optional(),
    decide: z.enum(DECISIONS),
    approver: slug.optional(),
    expires_in: z.string().regex(durationRe, "use a duration like 30m, 24h or 2d").optional(),
    reason: z.string().max(300).optional(),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

export const RulebookSchema = z
  .object({
    version: z.number().int().min(1),
    agent: slug,
    owner: z.string().email(),
    default: z.literal("refuse", { errorMap: () => ({ message: "default must be refuse" }) }),
    approvers: z.record(slug, z.array(z.string().email()).min(1).max(50)).default({}),
    lists: z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), z.array(z.string().max(253)).max(500)).optional(),
    limits: z.object({ daily_payments_inr: z.number().finite().positive().optional() }).strict().optional(),
    rules: z.array(RuleSchema).max(200),
    signature: z.string().optional(),
  })
  .strict()
  .superRefine((rb, ctx) => {
    const ids = new Set<string>();
    rb.rules.forEach((rule, i) => {
      const at = (msg: string, ...path: (string | number)[]) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ["rules", i, ...path] });
      if (ids.has(rule.id)) at(`duplicate rule id "${rule.id}"`, "id");
      ids.add(rule.id);
      if (!isKnownTool(rule.tool)) return at(`unknown tool "${rule.tool}"`, "tool");
      if (rule.decide === "ask") {
        if (!rule.approver) at("an ask rule needs an approver group", "approver");
        else if (!rb.approvers[rule.approver]) at(`approver group "${rule.approver}" is not defined`, "approver");
      } else {
        if (rule.approver) at("only ask rules take an approver", "approver");
        if (rule.expires_in) at("only ask rules can expire", "expires_in");
      }
      if (rule.expires_in && durationRe.test(rule.expires_in) && durationMs(rule.expires_in) > 30 * 86_400_000) at("expiry can be at most 30 days", "expires_in");
      for (const msg of checkWhen(rule.tool, rule.when ?? {}, rb.lists ?? {})) at(msg, "when");
    });
  });
export type Rulebook = z.infer<typeof RulebookSchema>;

function argFields(tool: ToolName): string[] {
  return Object.keys(TOOL_ARGS[tool].shape);
}

function checkWhen(tool: ToolName, when: When, lists: Record<string, string[]>): string[] {
  const errors: string[] = [];
  const fields = argFields(tool);
  for (const [key, value] of Object.entries(when)) {
    if (key === "to_domain_in") {
      if (!fields.includes("to")) errors.push(`${tool} has no recipient, so to_domain_in does not apply`);
      if (typeof value === "string") {
        if (!lists[value] && !(CONTEXT_LISTS as readonly string[]).includes(value)) errors.push(`list "${value}" is not defined`);
      } else if (!z.array(z.string().max(253)).min(1).safeParse(value).success) {
        errors.push("to_domain_in takes a list name or a list of domains");
      }
    } else if (key === "fields_include") {
      if (!fields.includes("fields")) errors.push(`${tool} has no fields, so fields_include does not apply`);
      const parsed = z.array(z.enum(VENDOR_FIELDS)).min(1).safeParse(value);
      if (!parsed.success) errors.push(`fields_include takes a list of: ${VENDOR_FIELDS.join(", ")}`);
    } else {
      if (!fields.includes(key)) errors.push(`${tool} has no field "${key}"`);
      const parsed = ConditionSchema.safeParse(value);
      if (!parsed.success) errors.push(`"${key}": ${parsed.error.issues[0]?.message ?? "invalid condition"}`);
    }
  }
  return errors;
}

export function durationMs(d: string): number {
  const m = durationRe.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

export type ParseResult = { ok: true; rulebook: Rulebook } | { ok: false; errors: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
}

export function validateRulebook(value: unknown): ParseResult {
  const parsed = RulebookSchema.safeParse(value);
  return parsed.success ? { ok: true, rulebook: parsed.data } : { ok: false, errors: formatIssues(parsed.error) };
}

export function parseRulebookYaml(text: string): ParseResult {
  if (text.length > 200_000) return { ok: false, errors: ["rulebook is too large"] };
  let doc: unknown;
  try {
    doc = YAML.parse(text, { schema: "core", uniqueKeys: true, maxAliasCount: 0 });
  } catch (e) {
    return { ok: false, errors: [`YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  return validateRulebook(doc);
}

const KEY_ORDER = ["version", "agent", "owner", "default", "approvers", "lists", "limits", "rules", "signature"] as const;
const RULE_KEY_ORDER = ["id", "tool", "when", "decide", "approver", "expires_in", "reason"] as const;

export function rulebookToYaml(rb: Rulebook): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = rb[k];
    if (v === undefined) continue;
    if (k === "approvers" && Object.keys(rb.approvers).length === 0) continue;
    ordered[k] =
      k === "rules"
        ? rb.rules.map((r) => Object.fromEntries(RULE_KEY_ORDER.filter((rk) => r[rk] !== undefined).map((rk) => [rk, r[rk]])))
        : v;
  }
  const doc = new YAML.Document(ordered);
  YAML.visit(doc, {
    Pair(_, pair) {
      const key = YAML.isScalar(pair.key) ? pair.key.value : undefined;
      if ((key === "when" || key === "approvers" || key === "lists") && YAML.isCollection(pair.value)) {
        // Keep `when` short like the docs; group lists stay inline.
        if (key === "when") pair.value.flow = true;
        if (key !== "when") YAML.visit(pair.value, { Seq(_, seq) { seq.flow = true; } });
      }
    },
  });
  return doc.toString({ lineWidth: 0 });
}

/** The exact bytes a rulebook signature covers. */
export function rulebookSigningPayload(rb: Rulebook): string {
  return canonicalize(omit(rb, ["signature"]));
}

export function rulebookHash(rb: Rulebook): string {
  return hashCanonical(omit(rb, ["signature"]));
}

export function signRulebook(rb: Rulebook, privateKeyPem: string): Rulebook {
  return { ...rb, signature: signText(privateKeyPem, rulebookSigningPayload(rb)) };
}

export function verifyRulebook(rb: Rulebook, publicKeyPem: string): boolean {
  return typeof rb.signature === "string" && verifyText(publicKeyPem, rulebookSigningPayload(rb), rb.signature);
}

export type LoadResult = { ok: true; rulebook: Rulebook } | { ok: false; reason: string };

/** Parse, validate and verify. Gate only ever runs a rulebook that passes this. */
export function loadSignedRulebook(text: string, publicKeyPem: string): LoadResult {
  const parsed = parseRulebookYaml(text);
  if (!parsed.ok) return { ok: false, reason: `invalid rulebook: ${parsed.errors.join("; ")}` };
  if (!parsed.rulebook.signature) return { ok: false, reason: "rulebook is not signed" };
  if (!verifyRulebook(parsed.rulebook, publicKeyPem)) return { ok: false, reason: "rulebook signature does not match" };
  return { ok: true, rulebook: parsed.rulebook };
}

export type RiskTier = "low" | "medium" | "high";

/** Checks that block publishing, beyond schema validity. */
export function publishProblems(rb: Rulebook, tier: RiskTier): string[] {
  const problems: string[] = [];
  if (tier === "high") {
    for (const tool of Object.values(TOOLS).filter((t) => t.movesMoney)) {
      const rules = rb.rules.filter((r) => r.tool === tool.name);
      const allowsSome = rules.some((r) => r.decide === "allow");
      const asksSome = rules.some((r) => r.decide === "ask");
      if (allowsSome && !asksSome) {
        problems.push(`High-risk agents need at least one "Ask" rule for ${tool.label.toLowerCase()} (${tool.name}).`);
      }
    }
  }
  return problems;
}
