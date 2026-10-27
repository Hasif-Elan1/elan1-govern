import type { Rule, Rulebook } from "./rulebook";
import { builtinRegistry, RISK_TAG_LABELS, type RiskTag, type ToolRegistry, type ToolSpec } from "./tools";

// Approving in Slack or WhatsApp. Chat is a doorbell: the rule, the decision, the receipt and the
// audit trail stay in Elan1 Govern. Only low-impact asks may be decided from a chat button.

/** Actions that are always decided in Elan1 Govern itself, never from a chat button. */
export const APP_ONLY_TAGS: readonly RiskTag[] = ["deletes", "changes_access", "changes_production", "personal_data"];

const AMOUNT_FIELD = /^amount($|_)/;

/** Does the rule cap the amount (an "under" or "up to" condition on an amount field)? */
export function hasAmountCap(rule: Pick<Rule, "when">): boolean {
  return Object.entries(rule.when ?? {}).some(([field, cond]) => {
    if (!AMOUNT_FIELD.test(field) || !cond || typeof cond !== "object" || Array.isArray(cond)) return false;
    const c = cond as Record<string, unknown>;
    return [c.lt, c.lte].some((v) => typeof v === "number" && Number.isFinite(v));
  });
}

/** The tools a rule applies to: the one it names, or every tool carrying its tag. */
function targetsOf(rule: Pick<Rule, "tool" | "tag">, registry: ToolRegistry): ToolSpec[] {
  if (rule.tool !== undefined) {
    const spec = registry.get(rule.tool);
    return spec ? [spec] : [];
  }
  return registry.list().filter((t) => rule.tag !== undefined && t.tags.includes(rule.tag));
}

const label = (spec: ToolSpec) => `${spec.label.toLowerCase()} (${spec.name})`;

/**
 * Why this rule may not be approved in chat, in plain English, or null when it may.
 * Ignores whether `approve_in_chat` is set, so the rule builder can explain a disabled switch.
 */
export function chatApprovalBlocker(rule: Pick<Rule, "id" | "tool" | "tag" | "when" | "decide">, registry: ToolRegistry = builtinRegistry): string | null {
  if (rule.decide !== "ask") return "Only rules that ask a person can be approved in Slack or WhatsApp.";
  const tools = targetsOf(rule, registry);
  const ownTag = rule.tag && APP_ONLY_TAGS.includes(rule.tag) ? rule.tag : undefined;
  if (ownTag) return `This rule covers actions that ${RISK_TAG_LABELS[ownTag]}, so they can only be approved in Elan1 Govern.`;
  for (const spec of tools) {
    const tag = spec.tags.find((t) => APP_ONLY_TAGS.includes(t));
    if (tag) return `This rule covers ${label(spec)}, which ${RISK_TAG_LABELS[tag]}, so it can only be approved in Elan1 Govern.`;
  }
  const movesMoney = rule.tag === "moves_money" || tools.some((t) => t.tags.includes("moves_money"));
  if (movesMoney && !hasAmountCap(rule)) {
    return "This rule moves money with no upper amount, so it can only be approved in Elan1 Govern. Add an \"up to\" or \"under\" amount to the rule to allow approving it in Slack or WhatsApp.";
  }
  return null;
}

/** Publishing refuses any rule that turns on chat approval where it is not allowed. */
export function chatApprovalProblems(rb: Pick<Rulebook, "rules">, registry: ToolRegistry = builtinRegistry): string[] {
  const out: string[] = [];
  for (const rule of rb.rules) {
    if (rule.approve_in_chat !== true) continue;
    const why = chatApprovalBlocker(rule, registry);
    if (why) out.push(`Rule "${rule.id}" cannot be approved in Slack or WhatsApp. ${why}`);
  }
  return out;
}

/**
 * At decision time: may this held action be decided from a chat button? Only when an ask rule
 * (not a quota) decided it, that rule turns chat approval on, and the check still passes against
 * today's tools and tags (a tool's tags can change after the rulebook was published).
 */
export function chatApprovalAllowed(rb: Pick<Rulebook, "rules">, decision: { decision: string; ruleId: string; quotaId?: string }, registry: ToolRegistry = builtinRegistry): boolean {
  if (decision.decision !== "ask" || decision.quotaId) return false;
  const rule = rb.rules.find((r) => r.id === decision.ruleId);
  return !!rule && rule.approve_in_chat === true && chatApprovalBlocker(rule, registry) === null;
}
