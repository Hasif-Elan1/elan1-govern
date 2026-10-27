import { canonicalize } from "./canonical";
import { hashCanonical } from "./crypto";
import { formatINR } from "./describe";
import { decide, ruleMatches, type DecideContext } from "./engine";
import { publishProblems, ruleTargets, validateRulebook, type Rule, type Rulebook, type RiskTier } from "./rulebook";
import { builtinRegistry, isKnownTool, TOOLS, type RiskTag, type ToolRegistry, type ToolSpec } from "./tools";

/**
 * Rule suggestions learned from approvals.
 *
 * People approve the same kinds of actions again and again. This looks at the approvals one ask
 * rule produced and, when a clear subset was always approved, drafts the smallest rulebook change
 * that would let that subset through without asking. It is pure: no I/O, no clock (the caller
 * passes `now`). A person still reviews, signs and publishes the draft.
 *
 * Safety, by construction and checked again on every draft before it is returned:
 * - Only ask rules that name one tool are touched. Refuse rules are never changed, and the
 *   strictest-wins engine keeps them effective whatever allow rule is added.
 * - Tools tagged deletes, changes_access or changes_production are never suggested.
 * - An amount cap is at most the largest approved amount and below any refuse threshold.
 * - Replaying every past approval against the draft: it allows only ones a person approved,
 *   and every other decision stays exactly as it was.
 */

export const SUGGESTION_KINDS = ["allow_under_amount", "allow_for_known_counterparties", "allow_combined", "raise_limit"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** Never suggested, whatever the evidence: a person always looks at these. */
export const NEVER_SUGGEST_TAGS: RiskTag[] = ["deletes", "changes_access", "changes_production"];

export interface PastApproval {
  id: string;
  tool: string;
  ruleId: string;
  status: "approved" | "rejected" | "expired";
  /** The stored argument summary: display identifiers and the values rules inspected. Nothing else. */
  summary: Record<string, unknown>;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface MineOptions {
  /** How far back to look. */
  lookbackDays: number;
  /** At least this many approvals the drafted rule would have allowed… */
  minApprovals: number;
  /** …spread over at least this many days… */
  minSpanDays: number;
  /** …with the latest one this recent. */
  recentDays: number;
  /** A list of known counterparties longer than this is not "known" any more. */
  maxCounterparties: number;
}

export const DEFAULT_MINE_OPTIONS: MineOptions = { lookbackDays: 30, minApprovals: 10, minSpanDays: 7, recentDays: 14, maxCounterparties: 25 };

export interface MineInput {
  /** The agent's active rulebook. */
  rulebook: Rulebook;
  registry?: ToolRegistry;
  /** Lists Elan1 Govern fills in at decision time (vendor_domains), so past decisions can be replayed. */
  lists?: Record<string, string[]>;
  /** The agent's risk tier: a draft that could not be published for it is not suggested. */
  tier?: RiskTier;
  /** Resolved approvals of this agent (any rule). Pending ones are ignored. */
  approvals: PastApproval[];
  now: Date;
  options?: Partial<MineOptions>;
}

export interface SuggestionEvidence {
  /** Every approval the ask rule produced in the period, by result. */
  approved: number;
  rejected: number;
  expired: number;
  /** Approvals the drafted rule would have allowed. All of them were approved. */
  covered: number;
  /** Approvals that would still wait for a person. */
  stillAsked: number;
  firstAt: string;
  lastAt: string;
  spanDays: number;
  lookbackDays: number;
  /** Median time from asking to a person's answer, for the covered approvals. */
  medianWaitMs: number | null;
  field?: string;
  /** The new cap, and the cap it replaces (raise_limit). */
  cap?: number;
  previousCap?: number;
  maxApproved?: number;
  counterpartyField?: string;
  counterparties?: string[];
  /** Names already stored for display (for example the vendor), for people to read. Never used by the rule. */
  displayNames?: string[];
}

export interface RuleSuggestion {
  kind: SuggestionKind;
  tool: string;
  /** The ask rule it narrows. */
  ruleId: string;
  /** Stable for the same drafted change: sha256 of the kind, tool, rule and the changed rules. */
  fingerprint: string;
  /** One line, for a list. */
  title: string;
  /** The proposal in a sentence, with the evidence behind it. */
  proposal: string;
  confidence: "high" | "medium";
  /** Why we think this is safe to propose, in plain English. */
  explanation: string;
  evidence: SuggestionEvidence;
  /** What a month like this one would have saved. */
  savings: { approvalsPerMonth: number; medianWaitMs: number | null };
  /** The rules as they are and as drafted (only the ones that change or are added). */
  before: Rule[];
  after: Rule[];
  /** The whole drafted rulebook, unsigned. Publishing gives it the next version. */
  rulebook: Rulebook;
}

const DAY = 86_400_000;
const AMOUNT_RE = /^amount($|_)|_amount$/;
const COUNTERPARTY_RE = /^(vendor|supplier|customer|client|payee|recipient|merchant|contact|account|party|counterparty)(_id|_domain|_code)?$/;
const COUNTERPARTY_NOUN: Record<string, string> = {
  vendor: "vendors",
  supplier: "suppliers",
  customer: "customers",
  client: "clients",
  payee: "payees",
  recipient: "recipients",
  merchant: "merchants",
  contact: "contacts",
  account: "accounts",
  party: "parties",
  counterparty: "counterparties",
  to_domain: "email domains",
};
const ACTION_NOUN: Record<string, string> = {
  "zoho.record_bill_payment": "payments",
  "zoho.create_bill": "bills",
  "gmail.send_reply": "replies",
  "gmail.draft_reply": "draft replies",
};

type Cond = Record<string, unknown>;
const RESOLVED: string[] = ["approved", "rejected", "expired"];
type Args = Record<string, unknown>;

/** Rebuild just enough arguments from a stored summary to replay a decision on it. */
export function argsFromSummary(summary: Record<string, unknown>): Args {
  const args: Args = { ...summary };
  if (typeof summary.to_domain === "string" && args.to === undefined) args.to = `someone@${summary.to_domain}`;
  if (Array.isArray(summary.fields)) args.fields = Object.fromEntries(summary.fields.map((f) => [String(f), ""]));
  return args;
}

/** Round down to two significant figures, so a cap reads like one a person would pick: 98,750 -> 98,000. */
export function niceFloor(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return x;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 1);
  return Math.floor(x / step) * step;
}

function ago(ms: number): string {
  const d = Math.floor(ms / DAY);
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

const isCond = (v: unknown): v is Cond => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A numeric condition with exactly one operator, e.g. { gt: 50000 }. */
function single(cond: unknown): { op: string; value: number } | null {
  if (!isCond(cond)) return null;
  const keys = Object.keys(cond);
  if (keys.length !== 1) return null;
  const value = num(cond[keys[0] as string]);
  return value === undefined ? null : { op: keys[0] as string, value };
}

function without(when: Cond | undefined, key: string): Cond {
  const { [key]: _drop, ...rest } = when ?? {};
  return rest;
}

const fmtValue = (field: string, v: number) => (field === "amount_inr" ? formatINR(v) : v.toLocaleString("en-IN"));

function listWords(items: string[], max = 3): string {
  if (items.length <= max) return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

function noun(tool: string, spec: ToolSpec): string {
  return ACTION_NOUN[tool] ?? `“${isKnownTool(tool) ? TOOLS[tool].label : spec.label}” actions`;
}

function counterpartyNoun(field: string): string {
  return COUNTERPARTY_NOUN[field] ?? COUNTERPARTY_NOUN[field.replace(/_(id|domain|code)$/, "")] ?? "counterparties";
}

/** The lowest amount at which a refuse rule for this tool starts (by its `gt`/`gte` on the field). */
function refuseThreshold(rb: Rulebook, spec: ToolSpec, field: string): number {
  let t = Infinity;
  for (const r of rb.rules) {
    if (r.decide !== "refuse" || !ruleTargets(r, spec, spec.name)) continue;
    const c = r.when?.[field];
    if (!isCond(c)) continue;
    for (const op of ["gt", "gte"]) {
      const v = num(c[op]);
      if (v !== undefined) t = Math.min(t, v);
    }
  }
  return t;
}

/** The ask rule's own upper bound on the field, if it has one: a cap must stay below it. */
function upperBound(cond: unknown): number {
  if (!isCond(cond)) return Infinity;
  return Math.min(num(cond.lt) ?? Infinity, num(cond.lte) ?? Infinity);
}

function lowerBound(cond: unknown): number {
  if (!isCond(cond)) return -Infinity;
  return Math.max(num(cond.gt) ?? -Infinity, num(cond.gte) ?? -Infinity);
}

/**
 * The highest cap such that every approval at or under it was approved: below the smallest amount
 * that was rejected or expired, at most the largest approved amount, and below `ceiling`.
 */
function capFor(items: PastApproval[], field: string, ceiling: number, floor: number): number | null {
  const bad = Math.min(...items.filter((a) => a.status !== "approved").map((a) => num(a.summary[field]) ?? -Infinity), Infinity);
  const ok = items.filter((a) => a.status === "approved").map((a) => num(a.summary[field])).filter((v): v is number => v !== undefined && v < bad && v < ceiling);
  if (!ok.length) return null;
  const raw = Math.max(...ok);
  const nice = niceFloor(raw);
  return nice > floor ? nice : raw;
}

/** Counterparty values seen at least twice and never rejected or left to expire. */
function knownValues(items: PastApproval[], key: string, max: number): string[] | null {
  const seen = new Map<string, { n: number; bad: boolean }>();
  for (const a of items) {
    const v = a.summary[key];
    if (typeof v !== "string" || !v) return null;
    const s = seen.get(v) ?? { n: 0, bad: false };
    s.n++;
    if (a.status !== "approved") s.bad = true;
    seen.set(v, s);
  }
  const list = [...seen.entries()].filter(([, s]) => !s.bad && s.n >= 2).map(([v]) => v).sort();
  return list.length && list.length <= max ? list : null;
}

function uniqueId(rb: Rulebook, base: string): string {
  const stem = base.slice(0, 56).replace(/-+$/, "");
  let id = stem;
  for (let i = 2; rb.rules.some((r) => r.id === id); i++) id = `${stem}-${i}`;
  return id;
}

/** Keep a rule's reason true when its threshold moves: "over ₹50,000" becomes "over ₹1,00,000". */
function retitle(rule: Rule, field: string, from: number, to: number): Pick<Rule, "reason"> {
  if (!rule.reason) return {};
  const a = fmtValue(field, from);
  return { reason: rule.reason.split(a).join(fmtValue(field, to)) };
}

interface Draft {
  kind: SuggestionKind;
  /** Replacements for existing rules (by id), and rules to insert straight after the ask rule. */
  replace: Rule[];
  add: Rule[];
  field?: string;
  cap?: number;
  previousCap?: number;
  counterpartyField?: string;
  counterparties?: string[];
}

function apply(rb: Rulebook, d: Draft, askId: string): Rulebook {
  const rules: Rule[] = [];
  for (const r of rb.rules) {
    rules.push(d.replace.find((x) => x.id === r.id) ?? r);
    if (r.id === askId) rules.push(...d.add);
  }
  const { signature: _s, ...rest } = rb;
  return { ...rest, rules };
}

/** Amount kinds: a cap on the field. */
function amountDraft(rb: Rulebook, ask: Rule, spec: ToolSpec, field: string, cap: number): Draft {
  const own = ask.when?.[field];
  const lower = single(own);
  const reason = `A person approved these every time before, so they no longer wait.`;
  if (lower && (lower.op === "gt" || lower.op === "gte")) {
    const narrowed: Rule = { ...ask, when: { ...ask.when, [field]: { gt: cap } }, ...retitle(ask, field, lower.value, cap) };
    // The classic split: an allow rule up to the old threshold and this ask above it. Move the line.
    const pairOp = lower.op === "gt" ? "lte" : "lt";
    const rest = canonicalize(without(ask.when, field));
    const pair = rb.rules.find((r) => {
      const s = single(r.when?.[field]);
      return r.decide === "allow" && r.tool === spec.name && r.unless === undefined && s?.op === pairOp && s.value === lower.value && canonicalize(without(r.when, field)) === rest;
    });
    if (pair) {
      const raised: Rule = { ...pair, when: { ...pair.when, [field]: { lte: cap } }, ...retitle(pair, field, lower.value, cap) };
      return { kind: "raise_limit", replace: [narrowed, raised], add: [], field, cap, previousCap: lower.value };
    }
    const added: Rule = { id: uniqueId(rb, `${ask.id}-allow`), tool: spec.name, when: { ...ask.when, [field]: { [lower.op]: lower.value, lte: cap } }, decide: "allow", reason };
    return { kind: "allow_under_amount", replace: [narrowed], add: [added], field, cap };
  }
  // No simple lower bound: carve the subset out of the ask with an exception, and allow exactly it.
  const excepted: Rule = { ...ask, unless: { [field]: { lte: cap } } };
  const added: Rule = { id: uniqueId(rb, `${ask.id}-allow`), tool: spec.name, when: { ...ask.when, [field]: { ...(isCond(own) ? own : {}), lte: cap } }, decide: "allow", reason };
  return { kind: "allow_under_amount", replace: [excepted], add: [added], field, cap };
}

function counterpartyCond(key: string, list: string[]): [string, unknown] {
  return key === "to_domain" ? ["to_domain_in", list] : [key, { in: list }];
}

function counterpartyDraft(rb: Rulebook, ask: Rule, spec: ToolSpec, key: string, list: string[], amount?: { field: string; cap: number }): Draft {
  const [ck, cv] = counterpartyCond(key, list);
  const unless: Cond = { [ck]: cv };
  const when: Cond = { ...ask.when, [ck]: cv };
  if (amount) {
    unless[amount.field] = { lte: amount.cap };
    const own = ask.when?.[amount.field];
    when[amount.field] = { ...(isCond(own) ? own : {}), lte: amount.cap };
  }
  const excepted: Rule = { ...ask, unless };
  const added: Rule = { id: uniqueId(rb, `${ask.id}-known-${counterpartyNoun(key).split(" ").pop()}`), tool: spec.name, when, decide: "allow", reason: "A person approved these every time before, so they no longer wait." };
  return {
    kind: amount ? "allow_combined" : "allow_for_known_counterparties",
    replace: [excepted],
    add: [added],
    counterpartyField: key,
    counterparties: list,
    ...(amount ? { field: amount.field, cap: amount.cap } : {}),
  };
}

function words(d: Draft, tool: string, spec: ToolSpec, ask: Rule, n: number, days: number, displayNames: string[]): { title: string; proposal: string } {
  const what = noun(tool, spec);
  const capText = d.field && d.cap !== undefined ? fmtValue(d.field, d.cap) : "";
  const low = d.field ? lowerBound(ask.when?.[d.field]) : -Infinity;
  const range = d.field && d.cap !== undefined ? (Number.isFinite(low) ? `over ${fmtValue(d.field, low)} and up to ${capText}` : `up to ${capText}`) : "";
  const who = d.counterparties ? `${d.counterparties.length === 1 ? "this" : `these ${d.counterparties.length}`} ${d.counterparties.length === 1 ? counterpartyNoun(d.counterpartyField as string).replace(/s$/, "") : counterpartyNoun(d.counterpartyField as string)} (${listWords(d.counterparties)})` : "";
  // Stored display names (the vendor) are context for people only; the rule never looks at them.
  const named = displayNames.length && !d.counterparties ? `, to ${displayNames.length === 1 ? displayNames[0] : `${displayNames.length} vendors`}` : "";
  const all = `${n === 1 ? "the 1" : `all ${n}`}`;
  const period = `In the last ${days} days`;
  switch (d.kind) {
    case "raise_limit":
      return {
        title: `Raise the no-approval limit for ${what} from ${fmtValue(d.field as string, d.previousCap as number)} to ${capText}`,
        proposal: `${period} people approved ${all} ${what} ${range}${named} (none rejected). Allow ${what} up to ${capText} without asking?`,
      };
    case "allow_under_amount":
      return { title: `Allow ${what} ${range} without asking`, proposal: `${period} people approved ${all} ${what} ${range}${named} (none rejected). Make those automatic?` };
    case "allow_for_known_counterparties":
      return { title: `Allow ${what} to ${d.counterparties!.length} known ${counterpartyNoun(d.counterpartyField as string)} without asking`, proposal: `${period} people approved ${all} ${what} to ${who} (none rejected). Make those automatic?` };
    default:
      return {
        title: `Allow ${what} ${range} to ${d.counterparties!.length} known ${counterpartyNoun(d.counterpartyField as string)} without asking`,
        proposal: `${period} people approved ${all} ${what} ${range} to ${who} (none rejected). Make those automatic?`,
      };
  }
}

/** Every decision is unchanged, except asks this draft turns into allows, and those were all approved. */
function replaySafe(before: Rulebook, after: Rulebook, approvals: PastApproval[], ctx: DecideContext): boolean {
  for (const a of approvals) {
    const args = argsFromSummary(a.summary);
    const d0 = decide(before, a.tool, args, ctx);
    const d1 = decide(after, a.tool, args, ctx);
    if (d1.decision === d0.decision) continue;
    if (!(d0.decision === "ask" && d1.decision === "allow" && a.status === "approved")) return false;
  }
  return true;
}

/** Look for rule suggestions in one agent's resolved approvals. */
export function mineSuggestions(input: MineInput): RuleSuggestion[] {
  const o = { ...DEFAULT_MINE_OPTIONS, ...input.options };
  const registry = input.registry ?? builtinRegistry;
  const ctx: DecideContext = { registry, ...(input.lists ? { lists: input.lists } : {}) };
  const rb = input.rulebook;
  const now = input.now.getTime();
  const since = now - o.lookbackDays * DAY;
  const resolved = input.approvals.filter((a) => RESOLVED.includes(a.status) && a.createdAt.getTime() >= since && a.createdAt.getTime() <= now);
  const out: RuleSuggestion[] = [];

  for (const ask of rb.rules) {
    if (ask.decide !== "ask" || ask.tool === undefined || ask.unless !== undefined) continue;
    const spec = registry.get(ask.tool);
    if (!spec || spec.tags.some((t) => NEVER_SUGGEST_TAGS.includes(t))) continue;
    const tool = ask.tool;
    // Only approvals this rule would still ask for today: the rulebook may have changed since.
    const group = resolved.filter((a) => {
      if (a.tool !== tool || a.ruleId !== ask.id) return false;
      const args = argsFromSummary(a.summary);
      return ruleMatches(ask, tool, args, rb, ctx) && decide(rb, tool, args, ctx).decision === "ask";
    });
    if (group.filter((a) => a.status === "approved").length < o.minApprovals) continue;

    const usable = (k: string) => spec.open || spec.fields.includes(k);
    const keys = [...new Set(group.flatMap((a) => Object.keys(a.summary)))];
    const amountField = [...Object.keys(ask.when ?? {}), ...keys].find((k) => AMOUNT_RE.test(k) && usable(k) && group.every((a) => num(a.summary[k]) !== undefined));
    const partyField = keys.find((k) => (k === "to_domain" ? usable("to") && ask.when?.to_domain_in === undefined : COUNTERPARTY_RE.test(k) && usable(k) && (ask.when?.[k] === undefined || isCond(ask.when[k]))));
    const movesMoney = spec.tags.includes("moves_money");

    const drafts: Draft[] = [];
    if (amountField) {
      const ceiling = Math.min(refuseThreshold(rb, spec, amountField), upperBound(ask.when?.[amountField]));
      const cap = capFor(group, amountField, ceiling, lowerBound(ask.when?.[amountField]));
      if (cap !== null) drafts.push(amountDraft(rb, ask, spec, amountField, cap));
    }
    if (partyField) {
      const list = knownValues(group, partyField, o.maxCounterparties);
      if (list) {
        // Counterparties alone are never enough to move money: a known vendor still needs a cap.
        if (!movesMoney) drafts.push(counterpartyDraft(rb, ask, spec, partyField, list));
        if (amountField) {
          const subset = group.filter((a) => list.includes(a.summary[partyField] as string));
          const ceiling = Math.min(refuseThreshold(rb, spec, amountField), upperBound(ask.when?.[amountField]));
          const cap = capFor(subset, amountField, ceiling, lowerBound(ask.when?.[amountField]));
          if (cap !== null) drafts.push(counterpartyDraft(rb, ask, spec, partyField, list, { field: amountField, cap }));
        }
      }
    }

    let best: RuleSuggestion | null = null;
    for (const d of drafts) {
      const s = finish(rb, ask, spec, d, group, resolved, ctx, input, o);
      // Most approvals saved wins; on a tie the narrower draft (amount and counterparty together).
      if (s && (!best || s.evidence.covered > best.evidence.covered || (s.evidence.covered === best.evidence.covered && s.kind === "allow_combined"))) best = s;
    }
    if (best) out.push(best);
  }
  return out;
}

function finish(rb: Rulebook, ask: Rule, spec: ToolSpec, d: Draft, group: PastApproval[], all: PastApproval[], ctx: DecideContext, input: MineInput, o: MineOptions): RuleSuggestion | null {
  const draft = apply(rb, d, ask.id);
  const valid = validateRulebook(draft, ctx.registry);
  if (!valid.ok) return null;
  if (input.tier && publishProblems(valid.rulebook, input.tier, ctx.registry).length) return null;
  if (!replaySafe(rb, valid.rulebook, all, ctx)) return null;

  const covered = group.filter((a) => decide(valid.rulebook, a.tool, argsFromSummary(a.summary), ctx).decision === "allow");
  if (covered.length < o.minApprovals || covered.some((a) => a.status !== "approved")) return null;
  const times = covered.map((a) => a.createdAt.getTime());
  const first = Math.min(...times);
  const last = Math.max(...times);
  const spanDays = Math.floor((last - first) / DAY);
  const now = input.now.getTime();
  if (spanDays < o.minSpanDays || now - last > o.recentDays * DAY) return null;

  const waits = covered.filter((a) => a.resolvedAt).map((a) => (a.resolvedAt as Date).getTime() - a.createdAt.getTime());
  const medianWaitMs = median(waits);
  const activeDays = Math.max(o.minSpanDays, Math.min(o.lookbackDays, (now - first) / DAY));
  const perMonth = Math.round((covered.length * 30) / activeDays);
  const count = (s: PastApproval["status"]) => group.filter((a) => a.status === s).length;
  const displayNames = [...new Set(covered.map((a) => a.summary.vendor).filter((v): v is string => typeof v === "string" && !!v))].sort();
  const maxApproved = d.field ? Math.max(...group.filter((a) => a.status === "approved").map((a) => num(a.summary[d.field as string]) as number)) : undefined;
  const { title, proposal } = words(d, ask.tool as string, spec, ask, covered.length, o.lookbackDays, displayNames);

  const stillAsked = group.length - covered.length;
  const high = covered.length >= 30 && spanDays >= 21;
  const leftover = stillAsked
    ? ` ${stillAsked === 1 ? "1 other request" : `${stillAsked} other requests`} from the same rule ${count("rejected") + count("expired") ? `(including ${[count("rejected") ? `${count("rejected")} rejected` : "", count("expired") ? `${count("expired")} that nobody answered in time` : ""].filter(Boolean).join(" and ")}) ` : ""}would still wait for a person.`
    : "";
  const explanation =
    `${high ? "Strong evidence" : "Some evidence"}: ${covered.length} approvals over ${spanDays} days, every one approved and none rejected, the latest ${ago(now - last)}.` +
    leftover +
    ` Rules that refuse stay as they are, and nothing changes until someone signs and publishes the draft.`;

  const before = d.replace.map((r) => rb.rules.find((x) => x.id === r.id) as Rule);
  const after = [...d.replace, ...d.add];
  return {
    kind: d.kind,
    tool: ask.tool as string,
    ruleId: ask.id,
    fingerprint: hashCanonical({ kind: d.kind, tool: ask.tool, rule: ask.id, after }),
    title,
    proposal,
    confidence: high ? "high" : "medium",
    explanation,
    evidence: {
      approved: count("approved"),
      rejected: count("rejected"),
      expired: count("expired"),
      covered: covered.length,
      stillAsked,
      firstAt: new Date(first).toISOString(),
      lastAt: new Date(last).toISOString(),
      spanDays,
      lookbackDays: o.lookbackDays,
      medianWaitMs,
      ...(d.field ? { field: d.field, cap: d.cap, maxApproved } : {}),
      ...(d.previousCap !== undefined ? { previousCap: d.previousCap } : {}),
      ...(d.counterparties ? { counterpartyField: d.counterpartyField, counterparties: d.counterparties } : {}),
      ...(displayNames.length ? { displayNames } : {}),
    },
    savings: { approvalsPerMonth: perMonth, medianWaitMs },
    before,
    after,
    rulebook: valid.rulebook,
  };
}

/**
 * A dismissed suggestion stays dismissed until the evidence has grown a lot: at least twice as many
 * approvals behind it as when it was dismissed, and at least 10 more.
 */
export function evidenceGrewEnough(coveredAtDismissal: number, coveredNow: number): boolean {
  return coveredNow >= 2 * coveredAtDismissal && coveredNow - coveredAtDismissal >= 10;
}
