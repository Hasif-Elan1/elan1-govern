import YAML from "yaml";
import { z } from "zod";
import { builtinRegistry, HIGH_IMPACT_TAGS, RISK_TAGS, RISK_TAG_LABELS, VENDOR_FIELDS, type RiskTag, type ToolRegistry, type ToolSpec } from "./tools";

export const DECISIONS = ["allow", "ask", "refuse"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Lists Elan1 Govern fills in at decision time, so a rulebook can say `to_domain_in: vendor_domains`. */
export const CONTEXT_LISTS = ["vendor_domains"] as const;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, numbers and dashes");
const fieldName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
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

export const WhenSchema = z.record(fieldName, z.unknown());
export type When = Record<string, unknown>;

export const RuleSchema = z
  .object({
    id: slug,
    /** One tool, e.g. zoho.record_bill_payment … */
    tool: z.string().min(1).max(130).optional(),
    /** … or every tool with a risk tag, e.g. moves_money. */
    tag: z.enum(RISK_TAGS).optional(),
    when: WhenSchema.optional(),
    decide: z.enum(DECISIONS),
    approver: slug.optional(),
    expires_in: z.string().regex(durationRe, "use a duration like 30m, 24h or 2d").optional(),
    reason: z.string().max(300).optional(),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

/** A limit on how often or how much, e.g. at most 50 refunds, or ₹5,00,000 in payments, a day. */
export const QuotaSchema = z
  .object({
    id: slug,
    tool: z.string().min(1).max(130).optional(),
    tag: z.enum(RISK_TAGS).optional(),
    /** "day" resets at midnight in the org's time zone; or a rolling window like 1h. */
    window: z.union([z.literal("day"), z.string().regex(durationRe, "use day, or a duration like 1h")]),
    max_count: z.number().int().positive().optional(),
    max_sum: z.object({ field: fieldName, value: z.number().finite().positive() }).strict().optional(),
    approver: slug.optional(),
  })
  .strict();
export type Quota = z.infer<typeof QuotaSchema>;

function makeSchema(registry: ToolRegistry) {
  return z
    .object({
      version: z.number().int().min(1),
      agent: slug,
      owner: z.string().email(),
      default: z.literal("refuse", { error: "default must be refuse" }),
      approvers: z.record(slug, z.array(z.string().email()).min(1).max(50)).default({}),
      lists: z.record(fieldName, z.array(z.string().max(253)).max(500)).optional(),
      limits: z.object({ daily_payments_inr: z.number().finite().positive().optional() }).strict().optional(),
      quotas: z.array(QuotaSchema).max(50).optional(),
      rules: z.array(RuleSchema).max(200),
      signature: z.string().optional(),
    })
    .strict()
    .superRefine((rb, ctx) => {
      const ids = new Set<string>();
      rb.rules.forEach((rule, i) => {
        const at = (msg: string, ...path: (string | number)[]) => ctx.addIssue({ code: "custom", message: msg, path: ["rules", i, ...path] });
        if (ids.has(rule.id)) at(`duplicate rule id "${rule.id}"`, "id");
        ids.add(rule.id);
        if ((rule.tool === undefined) === (rule.tag === undefined)) return at("a rule needs either a tool or a tag", "tool");
        const spec = rule.tool !== undefined ? registry.get(rule.tool) : undefined;
        if (rule.tool !== undefined && !spec) return at(`unknown tool "${rule.tool}"`, "tool");
        if (rule.decide === "ask") {
          if (!rule.approver) at("an ask rule needs an approver group", "approver");
          else if (!rb.approvers[rule.approver]) at(`approver group "${rule.approver}" is not defined`, "approver");
        } else {
          if (rule.approver) at("only ask rules take an approver", "approver");
          if (rule.expires_in) at("only ask rules can expire", "expires_in");
        }
        if (rule.expires_in && durationRe.test(rule.expires_in) && durationMs(rule.expires_in) > 30 * 86_400_000) at("expiry can be at most 30 days", "expires_in");
        for (const msg of checkWhen(spec, rule.when ?? {}, rb.lists ?? {})) at(msg, "when");
      });
      const qids = new Set<string>();
      (rb.quotas ?? []).forEach((q, i) => {
        const at = (msg: string) => ctx.addIssue({ code: "custom", message: msg, path: ["quotas", i] });
        if (qids.has(q.id)) at(`duplicate quota id "${q.id}"`);
        qids.add(q.id);
        if ((q.tool === undefined) === (q.tag === undefined)) at("a quota needs either a tool or a tag");
        if (q.tool !== undefined && !registry.get(q.tool)) at(`unknown tool "${q.tool}"`);
        if (q.max_count === undefined && q.max_sum === undefined) at("a quota needs max_count or max_sum");
        if (q.approver && !rb.approvers[q.approver]) at(`approver group "${q.approver}" is not defined`);
      });
    });
}

const BUILTIN_SCHEMA = makeSchema(builtinRegistry);
export const RulebookSchema = BUILTIN_SCHEMA;
export type Rulebook = z.infer<typeof BUILTIN_SCHEMA>;

const schemaFor = (registry: ToolRegistry) => (registry === builtinRegistry ? BUILTIN_SCHEMA : makeSchema(registry));

/** Tool-specific checks. Rules that target a tag accept any field; a missing field simply doesn't match. */
function checkWhen(spec: ToolSpec | undefined, when: When, lists: Record<string, string[]>): string[] {
  const errors: string[] = [];
  const fields = spec && !spec.open ? spec.fields : undefined;
  const name = spec?.name ?? "this tag";
  for (const [key, value] of Object.entries(when)) {
    if (key === "to_domain_in") {
      if (fields && !fields.includes("to")) errors.push(`${name} has no recipient, so to_domain_in does not apply`);
      if (typeof value === "string") {
        if (!lists[value] && !(CONTEXT_LISTS as readonly string[]).includes(value)) errors.push(`list "${value}" is not defined`);
      } else if (!z.array(z.string().max(253)).min(1).safeParse(value).success) {
        errors.push("to_domain_in takes a list name or a list of domains");
      }
    } else if (key === "fields_include") {
      if (fields && !fields.includes("fields")) errors.push(`${name} has no fields, so fields_include does not apply`);
      const vendor = spec?.name === "zoho.update_vendor";
      const ok = (vendor ? z.array(z.enum(VENDOR_FIELDS)) : z.array(fieldName)).min(1).safeParse(value).success;
      if (!ok) errors.push(vendor ? `fields_include takes a list of: ${VENDOR_FIELDS.join(", ")}` : "fields_include takes a list of field names");
    } else {
      if (fields && !fields.includes(key)) errors.push(`${name} has no field "${key}"`);
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

export function validateRulebook(value: unknown, registry: ToolRegistry = builtinRegistry): ParseResult {
  const parsed = schemaFor(registry).safeParse(value);
  return parsed.success ? { ok: true, rulebook: parsed.data } : { ok: false, errors: formatIssues(parsed.error) };
}

export function parseRulebookYaml(text: string, registry: ToolRegistry = builtinRegistry): ParseResult {
  if (text.length > 200_000) return { ok: false, errors: ["rulebook is too large"] };
  let doc: unknown;
  try {
    doc = YAML.parse(text, { schema: "core", uniqueKeys: true, maxAliasCount: 0 });
  } catch (e) {
    return { ok: false, errors: [`YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  return validateRulebook(doc, registry);
}

const KEY_ORDER = ["version", "agent", "owner", "default", "approvers", "lists", "limits", "quotas", "rules", "signature"] as const;
const RULE_KEY_ORDER = ["id", "tool", "tag", "when", "decide", "approver", "expires_in", "reason"] as const;

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
      if ((key === "when" || key === "approvers" || key === "lists" || key === "max_sum") && YAML.isCollection(pair.value)) {
        // Keep `when` short like the docs; group lists stay inline.
        if (key === "when" || key === "max_sum") pair.value.flow = true;
        else YAML.visit(pair.value, { Seq(_, seq) { seq.flow = true; } });
      }
    },
  });
  return doc.toString({ lineWidth: 0 });
}

export type RiskTier = "low" | "medium" | "high";

/** Does this rule (or quota) apply to this tool, by name or by one of its risk tags? */
export function ruleTargets(rule: { tool?: string; tag?: RiskTag }, spec: ToolSpec | undefined, toolName: string): boolean {
  if (rule.tool !== undefined) return rule.tool === toolName;
  return rule.tag !== undefined && !!spec?.tags.includes(rule.tag);
}

/** The rulebook's quotas, with the legacy `limits.daily_payments_inr` expressed as one. */
export function quotasOf(rb: Rulebook): Quota[] {
  const out = [...(rb.quotas ?? [])];
  const daily = rb.limits?.daily_payments_inr;
  if (daily !== undefined) out.push({ id: "daily-payments", tool: "zoho.record_bill_payment", window: "day", max_sum: { field: "amount_inr", value: daily } });
  return out;
}

/** Checks that block publishing, beyond schema validity. */
export function publishProblems(rb: Rulebook, tier: RiskTier, registry: ToolRegistry = builtinRegistry): string[] {
  const problems: string[] = [];
  if (tier !== "high") return problems;
  for (const spec of registry.list().filter((t) => t.tags.some((tag) => HIGH_IMPACT_TAGS.includes(tag)))) {
    const rules = rb.rules.filter((r) => ruleTargets(r, spec, spec.name));
    const allowsSome = rules.some((r) => r.decide === "allow");
    const asksSome = rules.some((r) => r.decide === "ask");
    if (allowsSome && !asksSome) {
      const why = spec.tags.filter((t) => HIGH_IMPACT_TAGS.includes(t)).map((t) => RISK_TAG_LABELS[t]).join(" and ");
      problems.push(`High-risk agents need at least one "Ask" rule for ${spec.label.toLowerCase()} (${spec.name}), because it ${why}.`);
    }
  }
  return problems;
}
