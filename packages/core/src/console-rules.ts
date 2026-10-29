import { validateRulebook, type Condition, type Quota, type Rule, type Rulebook } from "./rulebook";
import { builtinRegistry, lenientRegistry, RISK_TAGS, type RiskTag, type ToolRegistry } from "./tools";

// The approved console's rules (apps/console/src/types.ts Rule) as the guard's signed rulebook. The console
// decides a call with apps/console/src/lib/evaluate.ts; this keeps that decision wherever the guard's engine can
// say the same thing, and refuses (with a sentence a person can act on) wherever it cannot:
//  - matching, strictest-wins, ties to the first rule and the default refuse are the same in both;
//  - `when` conditions on one field are combined (the guard keys conditions by field), `unless` stays on ask rules;
//  - eq and in compare text without regard to case in the console and exactly in the guard: each value becomes
//    the spellings an agent sends (as written, lower case, upper case, capitalised) plus the number or the
//    true/false it spells, so `gstin_verified eq true` holds for true and "true";
//  - named lists (approved_vendors …) are written out, so the signed rulebook says what it allowed;
//  - a rule's quota becomes a rulebook quota on that rule: it counts the calls the rule allowed this agent and
//    applies when the rule decides; over the limit the rule's approver group decides, or, with none, the call is
//    refused (as in the console);
//  - simulate rules (a dry run) never decide, so they are left out, as is a rule that names no tool or tag.

export type ConsoleConditionOp = "eq" | "lt" | "lte" | "gt" | "gte" | "in" | "to_domain_in" | "fields_include";

export interface ConsoleCondition {
  field: string;
  op: ConsoleConditionOp;
  value: string | number | string[];
}

export interface ConsoleQuota {
  kind: "max_count" | "max_sum";
  field?: string;
  limit: number;
  window: string;
}

export interface ConsoleRule {
  id: string;
  match: { tool?: string; tag?: string };
  when?: ConsoleCondition[];
  unless?: ConsoleCondition[];
  decide: "allow" | "ask" | "refuse";
  approver?: string;
  reason: string;
  expiresIn?: string;
  approveInChat?: boolean;
  quota?: ConsoleQuota;
  mode?: "enforce" | "simulate";
}

/** A console approver group with the people in it who can decide in Elan1 Govern. */
export interface ConsoleApproverGroup {
  id: string;
  name: string;
  emails: string[];
}

export interface ConsoleRulebookInput {
  /** The agent's slug. */
  agent: string;
  /** The agent owner's email. */
  owner: string;
  /** The console's version number; the signed rulebook carries it. */
  version: number;
  rules: readonly ConsoleRule[];
  groups: readonly ConsoleApproverGroup[];
  /** The organisation's named lists (approved_vendors, own_accounts …). */
  lists?: Readonly<Record<string, readonly string[]>>;
  /** Checks tool names and fields. Default: built-in tools strictly, any other well-formed tool name. */
  registry?: ToolRegistry;
}

export type ConsoleTranslation =
  | { ok: true; rulebook: Rulebook; /** approver name in the rulebook → the console group's name */ groupNames: Record<string, string> }
  | { ok: false; errors: string[] };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELD = /^[a-z_][a-z0-9_]{0,62}$/;
const DURATION = /^(\d+)\s*(m|h|d)$/;
const MAX_EXPIRY_MS = 30 * 86_400_000;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const isTag = (t: string): t is RiskTag => (RISK_TAGS as readonly string[]).includes(t);

/** The approver name a console group gets in the signed rulebook: its id, as lowercase letters, numbers and dashes. */
export function consoleGroupSlug(id: string): string {
  const s = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return s || "group";
}

/** Approver names for a list of console group ids, in order: each its own, a number added where two would clash. */
export function consoleGroupSlugs(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    let s = consoleGroupSlug(id);
    for (let i = 2; [...out.values()].includes(s); i++) s = `${consoleGroupSlug(id).slice(0, 58)}-${i}`;
    out.set(id, s);
  }
  return out;
}

type Scalar = string | number | boolean;
const keyOf = (v: Scalar) => `${typeof v}:${String(v)}`;

/** Every spelling an agent may send for a console value that compares as text without regard to case. */
function spellings(text: string): Scalar[] {
  const lower = text.toLowerCase();
  const out: Scalar[] = [text, lower, text.toUpperCase(), lower.charAt(0).toUpperCase() + lower.slice(1)];
  const n = Number(text);
  if (text.trim() !== "" && Number.isFinite(n) && String(n) === text) out.push(n);
  if (lower === "true") out.push(true);
  if (lower === "false") out.push(false);
  const seen = new Set<string>();
  return out.filter((v) => !seen.has(keyOf(v)) && !!seen.add(keyOf(v)));
}

interface FieldConditions {
  values?: Scalar[];
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
}

/**
 * Turn one rule's `when` (or `unless`) into the guard's form. Pushes a message for anything that cannot be said;
 * returns undefined for no conditions.
 */
function conditionsOf(conds: readonly ConsoleCondition[] | undefined, lists: Readonly<Record<string, readonly string[]>>, at: string, errors: string[]): Record<string, unknown> | undefined {
  if (!conds?.length) return undefined;
  const fields = new Map<string, FieldConditions>();
  let domains: string[] | undefined;
  const fail = (msg: string) => errors.push(`${at}: ${msg}`);
  const expand = (v: ConsoleCondition["value"]): string[] => (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "string" && lists[x] ? [...lists[x]!] : [String(x)]));

  for (const c of conds) {
    const field = String(c.field ?? "");
    if (c.op === "fields_include") {
      fail(`"${field} includes fields" checks which arguments a call has, which the guard cannot check. Use a condition on a field's value instead.`);
      continue;
    }
    if (c.op === "to_domain_in") {
      if (field !== "to") {
        fail(`"is to a domain in" works only on the recipient (to), not on "${field}".`);
        continue;
      }
      const list = [...new Set(expand(c.value).map((d) => d.trim().toLowerCase()).filter(Boolean))];
      const next = domains ? domains.filter((d) => list.includes(d)) : list;
      if (!next.length) {
        fail(list.length ? "two recipient-domain conditions share no domain, so the rule could never apply." : "the recipient-domain condition lists no domain.");
        continue;
      }
      domains = next;
      continue;
    }
    if (!FIELD.test(field) || field === "to_domain_in" || field === "fields_include") {
      fail(`"${field}" is not a field name the guard accepts (lowercase letters, numbers and underscores).`);
      continue;
    }
    const f = fields.get(field) ?? {};
    fields.set(field, f);
    if (c.op === "eq" || c.op === "in") {
      if (c.op === "eq" && Array.isArray(c.value)) {
        fail(`"${field} is" takes one value, not a list. Use "is one of".`);
        continue;
      }
      const raw = c.op === "eq" ? [String(c.value)] : expand(c.value);
      if (!raw.length) {
        fail(`"${field} is one of" lists no value.`);
        continue;
      }
      if (raw.some((v) => v.length > 500)) {
        fail(`a value for "${field}" is longer than 500 characters.`);
        continue;
      }
      const alts = [...new Map(raw.flatMap(spellings).map((v) => [keyOf(v), v])).values()];
      const next = f.values ? f.values.filter((v) => alts.some((a) => keyOf(a) === keyOf(v))) : alts;
      if (!next.length) {
        fail(`two conditions on "${field}" can never both hold.`);
        continue;
      }
      if (next.length > 200) {
        fail(`"${field} is one of" has more than the guard's 200 values (named lists are written out with each spelling).`);
        continue;
      }
      f.values = next;
    } else if (c.op === "lt" || c.op === "lte" || c.op === "gt" || c.op === "gte") {
      const n = typeof c.value === "number" ? c.value : typeof c.value === "string" && c.value.trim() !== "" ? Number(c.value) : NaN;
      if (!Number.isFinite(n)) {
        fail(`"${field} ${c.op}" needs a number.`);
        continue;
      }
      const prev = f[c.op];
      // AND of two bounds of the same kind is the tighter one
      f[c.op] = prev === undefined ? n : c.op === "lt" || c.op === "lte" ? Math.min(prev, n) : Math.max(prev, n);
    } else {
      fail(`"${String(c.op)}" is not a condition the guard knows.`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [field, f] of fields) {
    const cond: Condition = {};
    if (f.values) cond.in = f.values;
    for (const op of ["lt", "lte", "gt", "gte"] as const) if (f[op] !== undefined) cond[op] = f[op];
    if (Object.keys(cond).length) out[field] = cond;
  }
  if (domains) out.to_domain_in = domains;
  return Object.keys(out).length ? out : undefined;
}

/** "24h", "30 m", "2d" → the guard's form ("24h"), at most 30 days. */
function durationOf(text: string, what: string, at: string, errors: string[]): string | undefined {
  const m = DURATION.exec(text.trim());
  if (!m || m[1]!.length > 4) {
    errors.push(`${at}: the ${what} "${text}" is not a duration like 30m, 24h or 2d.`);
    return undefined;
  }
  return `${Number(m[1])}${m[2]}`;
}

/**
 * The console's rules for one agent, as the guard's rulebook. Fails (every reason, in plain words) rather than
 * sign a rulebook that decides differently in a way the guard cannot express.
 */
export function consoleRulesToRulebook(input: ConsoleRulebookInput): ConsoleTranslation {
  const errors: string[] = [];
  const lists = input.lists ?? {};
  const slugs = consoleGroupSlugs(input.groups.map((g) => g.id)); // console group id → approver name
  const used = new Map<string, string[]>(); // approver name → emails
  const groupNames: Record<string, string> = {};
  const groupFor = (ref: string) => {
    const k = ref.trim().toLowerCase();
    return input.groups.find((g) => g.id === ref) ?? input.groups.find((g) => g.id.toLowerCase() === k || g.name.toLowerCase() === k);
  };
  /** The approver name for a group a rule names, recording it; undefined (with a message) if it cannot approve. */
  const approverFor = (g: ConsoleApproverGroup | undefined, ref: string | undefined, at: string): string | undefined => {
    if (!g) {
      errors.push(ref ? `${at}: there is no approver group called "${ref}".` : `${at}: it asks a person, but this organisation has no approver groups.`);
      return undefined;
    }
    const emails = [...new Set(g.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (!emails.length) {
      errors.push(`${at}: nobody in the ${g.name} approver group can approve in Elan1 Govern. Add an owner, admin or approver to it.`);
      return undefined;
    }
    if (emails.length > 50) {
      errors.push(`${at}: the ${g.name} approver group has more than the guard's 50 people.`);
      return undefined;
    }
    const slug = slugs.get(g.id)!;
    used.set(slug, emails);
    groupNames[slug] = g.name;
    return slug;
  };
  // as the console does when an ask rule names no group: Owners, else the first group
  const defaultGroup = () => input.groups.find((g) => g.id === "owners") ?? input.groups[0];

  const rules: Rule[] = [];
  const quotas: Quota[] = [];
  for (const r of input.rules) {
    if (r.mode === "simulate") continue; // a dry run never decides
    const id = String(r.id ?? "");
    const at = `Rule "${id}"`;
    if (!SLUG.test(id)) {
      errors.push(`${at}: a rule id uses lowercase letters, numbers and dashes (at most 63).`);
      continue;
    }
    if (r.decide !== "allow" && r.decide !== "ask" && r.decide !== "refuse") {
      errors.push(`${at}: "${String(r.decide)}" is not allow, ask or refuse.`);
      continue;
    }
    // the console reads the tool when a rule names both; a rule that names neither never applies
    const tool = r.match?.tool || undefined;
    const tag = tool ? undefined : r.match?.tag || undefined;
    if (!tool && !tag) continue;
    if (tag && !isTag(tag)) {
      errors.push(`${at}: "${tag}" is not a risk tag.`);
      continue;
    }
    const target = tool ? { tool } : { tag: tag as RiskTag };
    const before = errors.length;
    const rule: Rule = { id, ...target, decide: r.decide };
    const when = conditionsOf(r.when, lists, at, errors);
    if (when) rule.when = when;
    if (r.decide === "ask") {
      // the console reads `unless` on ask rules only
      const unless = conditionsOf(r.unless, lists, `${at} (unless)`, errors);
      if (unless) rule.unless = unless;
      const approver = approverFor(r.approver ? groupFor(r.approver) : defaultGroup(), r.approver, at);
      if (approver) rule.approver = approver;
      if (r.expiresIn) {
        const d = durationOf(r.expiresIn, "expiry", at, errors);
        if (d && Number(/^\d+/.exec(d)![0]) * UNIT_MS[d.slice(-1) as keyof typeof UNIT_MS] > MAX_EXPIRY_MS) errors.push(`${at}: an approval can wait at most 30 days.`);
        else if (d) rule.expires_in = d;
      }
      if (r.approveInChat === true) rule.approve_in_chat = true;
    }
    const reason = (r.reason ?? "").trim();
    if (reason.length > 300) errors.push(`${at}: the reason is longer than the guard's 300 characters.`);
    else if (reason) rule.reason = reason;
    // a quota only ever tightens an allow (the console counts it only when this rule allowed the call)
    if (r.decide === "allow" && r.quota) {
      const q = r.quota;
      const qid = `${id}-quota`;
      const window = q.window?.trim() === "day" ? "day" : durationOf(String(q.window ?? ""), "quota window", at, errors);
      // it counts what this rule allowed for this agent, and applies when this rule decides (as the console's)
      const quota: Quota = { id: qid, ...target, window: window ?? "day", rule: id };
      if (!SLUG.test(qid)) errors.push(`${at}: the rule id is too long to carry a quota (at most 57 characters).`);
      if (q.kind === "max_count") {
        if (!Number.isInteger(q.limit) || q.limit < 1) errors.push(`${at}: a call-count quota needs a whole number of at least 1.`);
        else quota.max_count = q.limit;
      } else if (q.kind === "max_sum") {
        const field = q.field ?? "amount";
        if (!FIELD.test(field)) errors.push(`${at}: the quota adds up "${field}", which is not a field name the guard accepts.`);
        else if (!Number.isFinite(q.limit) || q.limit <= 0) errors.push(`${at}: a sum quota needs a limit above 0.`);
        else quota.max_sum = { field, value: q.limit };
      } else {
        errors.push(`${at}: "${String(q.kind)}" is not a quota the guard knows.`);
      }
      // over the limit the console asks the rule's own approver group, or refuses when it names none
      if (r.approver) {
        const approver = approverFor(groupFor(r.approver), r.approver, at);
        if (approver) quota.approver = approver;
      } else quota.on_breach = "refuse";
      quotas.push(quota);
    }
    if (errors.length === before) rules.push(rule);
  }

  if (!SLUG.test(input.agent)) errors.push(`The agent's name "${input.agent}" is not lowercase letters, numbers and dashes.`);
  if (errors.length) return { ok: false, errors };
  const rulebook = {
    version: input.version,
    agent: input.agent,
    owner: input.owner,
    default: "refuse" as const,
    approvers: Object.fromEntries(used),
    rules,
    ...(quotas.length ? { quotas } : {}),
  };
  const checked = validateRulebook(rulebook, input.registry ?? lenientRegistry(builtinRegistry));
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, rulebook: checked.rulebook, groupNames };
}
