import { ConditionSchema, durationMs, quotasOf, ruleTargets, type Condition, type Decision, type Quota, type Rule, type Rulebook } from "./rulebook";
import { builtinRegistry, type ToolRegistry } from "./tools";

export const DEFAULT_ASK_EXPIRY = "24h";
const RANK: Record<Decision, number> = { allow: 0, ask: 1, refuse: 2 };

export interface QuotaUsage {
  count: number;
  sum: number;
}

export interface DecideContext {
  /**
   * What has already been used in each quota's current window, keyed by quota id.
   * (The legacy shape `{ daily_payments_inr: number }` is still accepted.)
   */
  usage?: Record<string, QuotaUsage | number | undefined>;
  /** Lists Elan1 Govern knows about at decision time (e.g. vendor_domains). */
  lists?: Record<string, string[]>;
  /** Tools beyond the built-in Gmail and Zoho Books ones. */
  registry?: ToolRegistry;
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
  /** A quota that turned an allow into an ask. */
  quotaId?: string;
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
  const registry = ctx.registry ?? builtinRegistry;
  if (!ruleTargets(rule, registry.get(tool), tool)) return false;
  if (!conditionsHold(rule.when ?? {}, args, rb, ctx)) return false;
  // An exception: the rule stands aside only when every `unless` condition holds. A missing value never holds.
  const unless = rule.unless ?? {};
  return !(Object.keys(unless).length > 0 && conditionsHold(unless, args, rb, ctx));
}

function conditionsHold(when: Record<string, unknown>, args: Args, rb: Rulebook, ctx: DecideContext): boolean {
  for (const [key, cond] of Object.entries(when)) {
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

/** Quotas that apply to this tool. */
export function quotasFor(rb: Rulebook, tool: string, registry: ToolRegistry = builtinRegistry): Quota[] {
  const spec = registry.get(tool);
  return quotasOf(rb).filter((q) => ruleTargets(q, spec, tool));
}

/** Build the privacy-safe summary: display identifiers plus whatever the tool's rules and quotas inspect. */
export function summarizeArgs(tool: string, args: Args, rb: Rulebook, registry: ToolRegistry = builtinRegistry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const spec = registry.get(tool);
  if (!spec) return out;
  const keep = (k: string) => {
    const v = args[k];
    if (v === undefined) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  };
  spec.summaryFields.forEach(keep);
  for (const rule of rb.rules.filter((r) => ruleTargets(r, spec, tool))) {
    for (const key of [...Object.keys(rule.when ?? {}), ...Object.keys(rule.unless ?? {})]) {
      if (key === "to_domain_in") {
        const d = domainOf(args.to);
        if (d) out.to_domain = d;
      } else if (key === "fields_include") {
        // Names of changed fields only, never their values.
        if (args.fields && typeof args.fields === "object") out.fields = Object.keys(args.fields).sort();
      } else keep(key);
    }
  }
  for (const q of quotasFor(rb, tool, registry)) if (q.max_sum) keep(q.max_sum.field);
  return out;
}

function plainReason(rule: Rule, decision: Decision): string {
  if (rule.reason) return rule.reason;
  if (decision === "allow") return "Your rules allow this.";
  if (decision === "ask") return "Your rules say a person must approve this first.";
  return "Your rules never allow this.";
}

export function decide(rb: Rulebook, tool: string, args: Args, ctx: DecideContext = {}): DecisionResult {
  const registry = ctx.registry ?? builtinRegistry;
  const argsSummary = summarizeArgs(tool, args, rb, registry);
  const matched = rb.rules.filter((r) => ruleMatches(r, tool, args, rb, ctx));

  if (matched.length === 0) {
    return {
      decision: "refuse",
      ruleId: "default",
      reason: registry.get(tool) ? "No rule allows this action, so it is refused by default." : `"${tool}" is not a tool Elan1 Govern knows, so it is refused by default.`,
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
    const breach = quotaBreach(rb, tool, args, ctx, registry, winner.id);
    if (breach) {
      if (breach.quota.on_breach === "refuse") return { ...result, decision: "refuse", quotaId: breach.quota.id, reason: `${breach.message} The rulebook refuses calls over this limit.` };
      const group = breach.quota.approver ?? Object.keys(rb.approvers)[0];
      if (!group) return { ...result, decision: "refuse", quotaId: breach.quota.id, reason: `${breach.message} No approvers are set, so it is refused.` };
      return withApprovers({ ...result, decision: "ask", quotaId: breach.quota.id, reason: `${breach.message} A person needs to approve it.` }, rb, group, DEFAULT_ASK_EXPIRY);
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

function usageOf(ctx: DecideContext, q: Quota): QuotaUsage {
  const legacy = q.id === "daily-payments" ? ctx.usage?.daily_payments_inr : undefined;
  const u = ctx.usage?.[q.id] ?? legacy;
  if (typeof u === "number") return { count: 0, sum: u };
  return u ?? { count: 0, sum: 0 };
}

function quotaBreach(rb: Rulebook, tool: string, args: Args, ctx: DecideContext, registry: ToolRegistry, ruleId: string): { quota: Quota; message: string } | null {
  // a quota on one rule applies only when that rule decides
  for (const q of quotasFor(rb, tool, registry).filter((x) => x.rule === undefined || x.rule === ruleId)) {
    const used = usageOf(ctx, q);
    if (q.max_count !== undefined && used.count + 1 > q.max_count) {
      return { quota: q, message: `This would go over the limit of ${q.max_count} per ${q.window === "day" ? "day" : q.window} ("${q.id}").` };
    }
    if (q.max_sum) {
      // a call with no amount adds nothing; a quota on one rule (the console's) still holds it once the sum is past the limit
      const raw = args[q.max_sum.field];
      const value = typeof raw === "number" ? raw : q.rule !== undefined ? 0 : undefined;
      if (value !== undefined && used.sum + value > q.max_sum.value) {
        return { quota: q, message: q.id === "daily-payments" ? "This would take today's payments past the daily limit." : `This would go over the "${q.id}" limit.` };
      }
    }
  }
  return null;
}
