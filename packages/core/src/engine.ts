import { ConditionSchema, durationMs, type Condition, type Decision, type Rule, type Rulebook } from "./rulebook";
import { LIMIT_TOOLS, TOOLS, isKnownTool } from "./tools";

export const DEFAULT_ASK_EXPIRY = "24h";
const RANK: Record<Decision, number> = { allow: 0, ask: 1, refuse: 2 };

export interface DecideContext {
  /** Running totals for today, used for limits. */
  usage?: { daily_payments_inr?: number };
  /** Lists Gate knows about at decision time (e.g. vendor_domains). */
  lists?: Record<string, string[]>;
}

export interface DecisionResult {
  decision: Decision;
  /** The rule that decided, or "default" when nothing matched. */
  ruleId: string;
  reason: string;
  matched: string[];
  approverGroup?: string;
  approvers?: string[];
  expiresInMs?: number;
  /** Only the arguments the rules looked at plus display identifiers. Safe to store. */
  argsSummary: Record<string, unknown>;
}

type Args = Record<string, unknown>;

function domainOf(addr: unknown): string | undefined {
  if (typeof addr !== "string") return undefined;
  const at = addr.lastIndexOf("@");
  return at > 0 ? addr.slice(at + 1).toLowerCase() : undefined;
}

function matchCondition(value: unknown, c: Condition): boolean {
  if (value === undefined || value === null) return false;
  if (c.eq !== undefined && value !== c.eq) return false;
  if (c.in !== undefined && !c.in.some((x) => x === value)) return false;
  const numeric = [c.lt, c.lte, c.gt, c.gte].some((x) => x !== undefined);
  if (numeric) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (c.lt !== undefined && !(value < c.lt)) return false;
    if (c.lte !== undefined && !(value <= c.lte)) return false;
    if (c.gt !== undefined && !(value > c.gt)) return false;
    if (c.gte !== undefined && !(value >= c.gte)) return false;
  }
  return true;
}

function resolveList(ref: unknown, rb: Rulebook, ctx: DecideContext): string[] {
  if (Array.isArray(ref)) return ref.map(String);
  if (typeof ref === "string") return rb.lists?.[ref] ?? ctx.lists?.[ref] ?? [];
  return [];
}

export function ruleMatches(rule: Rule, tool: string, args: Args, rb: Rulebook, ctx: DecideContext = {}): boolean {
  if (rule.tool !== tool) return false;
  for (const [key, cond] of Object.entries(rule.when ?? {})) {
    if (key === "to_domain_in") {
      const domain = domainOf(args.to);
      const list = resolveList(cond, rb, ctx).map((d) => d.toLowerCase());
      if (!domain || !list.includes(domain)) return false;
    } else if (key === "fields_include") {
      const changed = args.fields && typeof args.fields === "object" ? Object.keys(args.fields) : [];
      const wanted = Array.isArray(cond) ? cond : [];
      if (!wanted.some((f) => changed.includes(String(f)))) return false;
    } else {
      const parsed = ConditionSchema.safeParse(cond);
      if (!parsed.success || !matchCondition(args[key], parsed.data)) return false;
    }
  }
  return true;
}

/** Build the privacy-safe summary: display identifiers plus whatever the tool's rules inspect. */
export function summarizeArgs(tool: string, args: Args, rb: Rulebook): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isKnownTool(tool)) return out;
  const keep = (k: string) => {
    const v = args[k];
    if (v === undefined) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  };
  TOOLS[tool].summaryFields.forEach(keep);
  for (const rule of rb.rules.filter((r) => r.tool === tool)) {
    for (const key of Object.keys(rule.when ?? {})) {
      if (key === "to_domain_in") {
        const d = domainOf(args.to);
        if (d) out.to_domain = d;
      } else if (key === "fields_include") {
        // Names of changed fields only, never their values.
        if (args.fields && typeof args.fields === "object") out.fields = Object.keys(args.fields).sort();
      } else keep(key);
    }
  }
  const limit = Object.values(LIMIT_TOOLS).find((l) => l.tool === tool);
  if (limit) keep(limit.field);
  return out;
}

function plainReason(rule: Rule, decision: Decision): string {
  if (rule.reason) return rule.reason;
  const label = TOOLS[rule.tool as keyof typeof TOOLS]?.label.toLowerCase() ?? rule.tool;
  if (decision === "allow") return `Rule "${rule.id}" allows ${label}.`;
  if (decision === "ask") return `Rule "${rule.id}" needs a person to approve ${label}.`;
  return `Rule "${rule.id}" never allows ${label}.`;
}

export function decide(rb: Rulebook, tool: string, args: Args, ctx: DecideContext = {}): DecisionResult {
  const argsSummary = summarizeArgs(tool, args, rb);
  const matched = rb.rules.filter((r) => ruleMatches(r, tool, args, rb, ctx));

  if (matched.length === 0) {
    return {
      decision: "refuse",
      ruleId: "default",
      reason: isKnownTool(tool)
        ? "No rule allows this action, so it is refused by default."
        : `"${tool}" is not a tool Gate knows, so it is refused by default.`,
      matched: [],
      argsSummary,
    };
  }

  // Strictest wins; ties go to the first rule in the rulebook.
  let winner = matched[0] as Rule;
  for (const r of matched) if (RANK[r.decide] > RANK[winner.decide]) winner = r;
  const result: DecisionResult = {
    decision: winner.decide,
    ruleId: winner.id,
    reason: plainReason(winner, winner.decide),
    matched: matched.map((r) => r.id),
    argsSummary,
  };

  if (winner.decide === "allow") {
    const breach = limitBreach(rb, tool, args, ctx);
    if (breach) {
      const group = Object.keys(rb.approvers)[0];
      if (!group) {
        return { ...result, decision: "refuse", reason: `${breach} No approvers are set, so it is refused.` };
      }
      return withApprovers({ ...result, decision: "ask", reason: `${breach} A person needs to approve it.` }, rb, group, DEFAULT_ASK_EXPIRY);
    }
  }
  if (winner.decide === "ask") {
    return withApprovers(result, rb, winner.approver as string, winner.expires_in ?? DEFAULT_ASK_EXPIRY);
  }
  return result;
}

function withApprovers(r: DecisionResult, rb: Rulebook, group: string, expires: string): DecisionResult {
  return { ...r, approverGroup: group, approvers: rb.approvers[group] ?? [], expiresInMs: durationMs(expires) };
}

function limitBreach(rb: Rulebook, tool: string, args: Args, ctx: DecideContext): string | null {
  const limit = rb.limits?.daily_payments_inr;
  const spec = LIMIT_TOOLS.daily_payments_inr;
  if (limit === undefined || tool !== spec.tool) return null;
  const amount = args[spec.field];
  if (typeof amount !== "number") return null;
  const used = ctx.usage?.daily_payments_inr ?? 0;
  if (used + amount <= limit) return null;
  return `This would take today's payments past the daily limit.`;
}
