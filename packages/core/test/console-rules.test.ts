import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { consoleGroupSlug, consoleRulesToRulebook, type ConsoleCondition, type ConsoleRule, type ConsoleRulebookInput } from "../src/console-rules";
import { decide } from "../src/engine";
import { rulebookToYaml, parseRulebookYaml, type Rulebook } from "../src/rulebook";
import { builtinRegistry, createRegistry, mergeRegistries, specFromJsonSchema, type RiskTag } from "../src/tools";

// The console's tools as the guard registers them (apps/gate/src/console-sync.ts): open argument lists naming the
// fields the rules look at.
const props = (...fields: string[]) => ({ type: "object", properties: Object.fromEntries(fields.map((f) => [f, {}])) });
const TOOLS: { name: string; tags: RiskTag[]; fields: string[] }[] = [
  { name: "gmail.read_inbox", tags: ["reads_data", "personal_data"], fields: [] },
  { name: "gmail.send_email", tags: ["sends_external"], fields: ["to", "template"] },
  { name: "zoho_books.list_invoices", tags: ["reads_data"], fields: [] },
  { name: "zoho_books.create_bill", tags: ["writes_data"], fields: ["amount"] },
  { name: "zoho_books.record_payment", tags: ["moves_money", "writes_data"], fields: ["amount", "vendor"] },
  { name: "zoho_books.delete_bill", tags: ["deletes"], fields: [] },
  { name: "procure.create_vendor", tags: ["writes_data", "personal_data"], fields: ["gstin_verified"] },
];
/** The tools with the fields their rules name added, as the gate keeps them (GuardSyncTool.fields). */
const registryFor = (rules: readonly ConsoleRule[] = []) =>
  mergeRegistries(
    builtinRegistry,
    createRegistry(
      TOOLS.map((t) => {
        const named = rules.filter((r) => r.match.tool === t.name).flatMap((r) => [...(r.when ?? []), ...(r.unless ?? [])].map((c) => (c.op === "to_domain_in" ? "to" : c.field)));
        return specFromJsonSchema({ name: t.name, connector: t.name.split(".")[0]!, tags: t.tags, inputSchema: props(...new Set([...t.fields, ...named])) });
      }),
    ),
  );
const registry = registryFor();
const tagsOf = (tool: string) => TOOLS.find((t) => t.name === tool)?.tags ?? [];

const VENDOR_DOMAINS = ["northwind.in", "kalyanimetals.com", "suryapack.in"];
const GROUPS = [
  { id: "finance", name: "Finance", emails: ["venkat.iyer@demotraders.in", "tom.whitfield@demotraders.eu"] },
  { id: "owners", name: "Owners", emails: ["ananya.rao@demotraders.in"] },
  { id: "procurement", name: "Procurement", emails: ["arjun.nair@demotraders.in"] },
];
const LISTS = { approved_vendors: ["northwind", "kalyanimetals", "suryapack"], own_accounts: ["HDFC-OPS-0042"] };

/** invoice-bot's published rules in the console's seed (apps/console/src/mock/catalog.ts). */
const INVOICE: ConsoleRule[] = [
  { id: "read-ledger", match: { tag: "reads_data" }, decide: "allow", reason: "Reading invoices and the AP inbox is routine." },
  { id: "draft-bills", match: { tool: "zoho_books.create_bill" }, when: [{ field: "amount", op: "lte", value: 500000 }], decide: "allow", reason: "Bills up to ₹5,00,000 are drafted without a person." },
  {
    id: "pay-small",
    match: { tag: "moves_money" },
    when: [{ field: "amount", op: "lte", value: 50000 }, { field: "vendor", op: "in", value: ["approved_vendors"] }],
    decide: "allow",
    reason: "Small payments to approved vendors run within the daily cap.",
    quota: { kind: "max_sum", field: "amount", limit: 300000, window: "day" },
  },
  { id: "pay-large", match: { tag: "moves_money" }, when: [{ field: "amount", op: "gt", value: 50000 }], decide: "ask", approver: "finance", reason: "Payments over ₹50,000 need the finance controller.", expiresIn: "24h", approveInChat: false },
  { id: "email-vendors", match: { tool: "gmail.send_email" }, when: [{ field: "to", op: "to_domain_in", value: VENDOR_DOMAINS }], decide: "allow", reason: "Replies to known vendor domains are routine." },
  { id: "email-other", match: { tag: "sends_external" }, unless: [{ field: "to", op: "to_domain_in", value: VENDOR_DOMAINS }], decide: "ask", approver: "finance", reason: "Email to an unknown domain is checked by a person.", expiresIn: "4h", approveInChat: true },
  { id: "no-deletes", match: { tag: "deletes" }, decide: "refuse", reason: "Bills are cancelled by a person in Zoho Books, never deleted by an agent." },
];

const input = (rules: ConsoleRule[], extra: Partial<ConsoleRulebookInput> = {}): ConsoleRulebookInput => ({ agent: "invoice-bot", owner: "rahul.menon@demotraders.in", version: 7, rules, groups: GROUPS, lists: LISTS, registry, ...extra });

function translate(rules: ConsoleRule[], extra: Partial<ConsoleRulebookInput> = {}): Rulebook {
  const r = consoleRulesToRulebook(input(rules, extra));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.rulebook;
}
const errorsOf = (rules: ConsoleRule[], extra: Partial<ConsoleRulebookInput> = {}) => {
  const r = consoleRulesToRulebook(input(rules, extra));
  return r.ok ? [] : r.errors;
};
const ask = (over: Partial<ConsoleRule> = {}): ConsoleRule => ({ id: "r", match: { tool: "zoho_books.record_payment" }, decide: "ask", approver: "finance", reason: "Ask.", ...over });

describe("consoleRulesToRulebook: invoice-bot's seeded rules", () => {
  const rb = translate(INVOICE);

  it("keeps every rule, in order, with its id, target, decision and reason", () => {
    expect(rb).toMatchObject({ version: 7, agent: "invoice-bot", owner: "rahul.menon@demotraders.in", default: "refuse" });
    expect(rb.rules.map((r) => [r.id, r.tool ?? r.tag, r.decide])).toEqual(INVOICE.map((r) => [r.id, r.match.tool ?? r.match.tag, r.decide]));
    expect(rb.rules[0]!.reason).toBe("Reading invoices and the AP inbox is routine.");
    // only the groups the rules name, with the emails of the people who can approve
    expect(rb.approvers).toEqual({ finance: GROUPS[0]!.emails });
  });

  it("writes conditions the guard's way: by field, lists written out in every spelling", () => {
    expect(rb.rules.find((r) => r.id === "draft-bills")!.when).toEqual({ amount: { lte: 500000 } });
    const small = rb.rules.find((r) => r.id === "pay-small")!.when!;
    expect(small.amount).toEqual({ lte: 50000 });
    expect((small.vendor as { in: string[] }).in).toEqual(expect.arrayContaining(["northwind", "NORTHWIND", "Northwind", "suryapack"]));
    expect(rb.rules.find((r) => r.id === "email-vendors")!.when).toEqual({ to_domain_in: VENDOR_DOMAINS });
    expect(rb.rules.find((r) => r.id === "email-other")).toMatchObject({ unless: { to_domain_in: VENDOR_DOMAINS }, approver: "finance", expires_in: "4h", approve_in_chat: true });
    expect(rb.rules.find((r) => r.id === "pay-large")).toMatchObject({ approver: "finance", expires_in: "24h" });
    expect(rb.rules.find((r) => r.id === "pay-large")).not.toHaveProperty("approve_in_chat");
  });

  it("turns the rule's quota into a rulebook quota that refuses over the limit (the rule names no approver)", () => {
    expect(rb.quotas).toEqual([{ id: "pay-small-quota", tag: "moves_money", window: "day", rule: "pay-small", max_sum: { field: "amount", value: 300000 }, on_breach: "refuse" }]);
  });

  it("decides calls as the console does", () => {
    const d = (tool: string, args: Record<string, unknown>, usage = {}) => decide(rb, tool, args, { registry, usage });
    expect(d("gmail.read_inbox", {})).toMatchObject({ decision: "allow", ruleId: "read-ledger" });
    expect(d("zoho_books.record_payment", { amount: 18000, vendor: "Northwind" })).toMatchObject({ decision: "allow", ruleId: "pay-small" });
    expect(d("zoho_books.record_payment", { amount: 240000, vendor: "Northwind" })).toMatchObject({ decision: "ask", ruleId: "pay-large", approverGroup: "finance", approvers: GROUPS[0]!.emails, expiresInMs: 86_400_000 });
    // an unknown vendor is not a small payment, and nothing else allows it
    expect(d("zoho_books.record_payment", { amount: 18000, vendor: "Shady Co" })).toMatchObject({ decision: "refuse", ruleId: "default" });
    expect(d("zoho_books.record_payment", { amount: 18000, vendor: "northwind" }, { "pay-small-quota": { count: 3, sum: 290000 } })).toMatchObject({ decision: "refuse", quotaId: "pay-small-quota" });
    expect(d("zoho_books.delete_bill", { bill_id: "b1" })).toMatchObject({ decision: "refuse", ruleId: "no-deletes" });
    expect(d("gmail.send_email", { to: "ap@northwind.in" })).toMatchObject({ decision: "allow", ruleId: "email-vendors" });
    expect(d("gmail.send_email", { to: "someone@example.com" })).toMatchObject({ decision: "ask", ruleId: "email-other", expiresInMs: 4 * 3_600_000 });
  });

  it("round-trips through YAML, as the gate signs and loads it", () => {
    const back = parseRulebookYaml(rulebookToYaml(rb), registry);
    expect(back.ok && back.rulebook).toEqual(rb);
  });
});

describe("consoleRulesToRulebook: what the guard says the same way", () => {
  it("compares eq and in without regard to case, and as the number or true/false a value spells", () => {
    const rb = translate([
      { id: "a", match: { tool: "procure.create_vendor" }, when: [{ field: "gstin_verified", op: "eq", value: "true" }], decide: "allow", reason: "" },
      { id: "b", match: { tool: "zoho_books.record_payment" }, when: [{ field: "amount", op: "eq", value: 500 }], decide: "allow", reason: "" },
    ]);
    const d = (tool: string, args: Record<string, unknown>) => decide(rb, tool, args, { registry }).decision;
    for (const v of [true, "true", "TRUE", "True"]) expect(d("procure.create_vendor", { gstin_verified: v })).toBe("allow");
    for (const v of [false, "false", "yes"]) expect(d("procure.create_vendor", { gstin_verified: v })).toBe("refuse");
    expect(d("zoho_books.record_payment", { amount: 500 })).toBe("allow");
    expect(d("zoho_books.record_payment", { amount: "500" })).toBe("allow");
    expect(d("zoho_books.record_payment", { amount: 501 })).toBe("refuse");
    // an empty reason is left to the guard's own wording
    expect(rb.rules[0]).not.toHaveProperty("reason");
  });

  it("combines conditions on one field: bounds tighten, value lists intersect", () => {
    const rb = translate([
      {
        id: "band",
        match: { tool: "zoho_books.record_payment" },
        when: [
          { field: "amount", op: "gt", value: 100 },
          { field: "amount", op: "gt", value: 200 },
          { field: "amount", op: "lte", value: "5000" },
          { field: "amount", op: "lte", value: 3000 },
          { field: "vendor", op: "in", value: ["approved_vendors"] },
          { field: "vendor", op: "in", value: ["northwind", "other"] },
        ],
        decide: "allow",
        reason: "",
      },
    ]);
    expect(rb.rules[0]!.when).toEqual({ amount: { gt: 200, lte: 3000 }, vendor: { in: ["northwind", "NORTHWIND", "Northwind"] } });
    const tight = translate([{ id: "t", match: { tool: "gmail.send_email" }, when: [{ field: "to", op: "to_domain_in", value: VENDOR_DOMAINS }, { field: "to", op: "to_domain_in", value: "Northwind.in" }], decide: "allow", reason: "" }]);
    expect(tight.rules[0]!.when).toEqual({ to_domain_in: ["northwind.in"] });
  });

  it("leaves out what never decides in the console: dry-run rules and rules with no tool or tag", () => {
    const rb = translate([
      { id: "dry", match: { tag: "deletes" }, decide: "refuse", reason: "", mode: "simulate" },
      { id: "nothing", match: {}, decide: "allow", reason: "" },
      { id: "kept", match: { tag: "deletes" }, decide: "refuse", reason: "", mode: "enforce" },
    ]);
    expect(rb.rules.map((r) => r.id)).toEqual(["kept"]);
  });

  it("reads the tool when a rule names a tool and a tag, as the console does", () => {
    const rb = translate([{ id: "both", match: { tool: "gmail.read_inbox", tag: "deletes" }, decide: "allow", reason: "" }]);
    expect(rb.rules[0]).toMatchObject({ tool: "gmail.read_inbox" });
    expect(rb.rules[0]).not.toHaveProperty("tag");
  });

  it("keeps ask-only settings off other rules, as the console ignores them there", () => {
    const rb = translate([
      { id: "x", match: { tag: "deletes" }, unless: [{ field: "amount", op: "lt", value: 1 }], decide: "refuse", approver: "finance", expiresIn: "2h", approveInChat: true, reason: "" },
      { id: "q", match: { tag: "reads_data" }, decide: "ask", approver: "finance", reason: "", quota: { kind: "max_count", limit: 2, window: "day" } },
    ]);
    expect(rb.rules[0]).toEqual({ id: "x", tag: "deletes", decide: "refuse" });
    // a quota on an ask rule never counts in the console
    expect(rb.quotas).toBeUndefined();
  });

  it("routes an ask with no group to Owners (else the first group), as the console does", () => {
    expect(translate([ask({ approver: undefined })]).rules[0]!.approver).toBe("owners");
    expect(translate([ask({ approver: undefined })], { groups: [GROUPS[2]!] }).rules[0]!.approver).toBe("procurement");
  });

  it("finds a group by id or by name, and gives every group its own approver name", () => {
    expect(translate([ask({ approver: "Finance" })]).approvers).toEqual({ finance: GROUPS[0]!.emails });
    const r = consoleRulesToRulebook(input([ask({ approver: "Ops_Team" }), ask({ id: "r2", approver: "ops team" })], { groups: [{ id: "Ops_Team", name: "Ops", emails: ["a@x.in"] }, { id: "ops-team", name: "ops team", emails: ["b@x.in"] }] }));
    expect(r.ok && r.rulebook.approvers).toEqual({ "ops-team": ["a@x.in"], "ops-team-2": ["b@x.in"] });
    expect(r.ok && r.groupNames).toEqual({ "ops-team": "Ops", "ops-team-2": "ops team" });
    expect(consoleGroupSlug("__")).toBe("group");
    expect(consoleGroupSlug("Finance Team")).toBe("finance-team");
  });

  it("gives an allow rule's quota its approver group, and normalises windows and expiries", () => {
    const rb = translate([
      { id: "c", match: { tool: "gmail.send_email" }, decide: "allow", approver: "finance", reason: "", quota: { kind: "max_count", limit: 120, window: "30 m" } },
      ask({ expiresIn: "0002h" }),
    ]);
    expect(rb.quotas).toEqual([{ id: "c-quota", tool: "gmail.send_email", window: "30m", rule: "c", max_count: 120, approver: "finance" }]);
    expect(rb.rules[1]!.expires_in).toBe("2h");
    expect(rb.rules[0]).not.toHaveProperty("approver");
  });
});

describe("consoleRulesToRulebook: refuses what the guard cannot say", () => {
  const cond = (c: ConsoleCondition): ConsoleRule[] => [{ id: "r", match: { tool: "gmail.send_email" }, when: [c], decide: "allow", reason: "" }];

  it("explains each problem in plain words", () => {
    expect(errorsOf(cond({ field: "fields", op: "fields_include", value: ["bank_account"] }))[0]).toMatch(/checks which arguments a call has/);
    expect(errorsOf(cond({ field: "cc", op: "to_domain_in", value: VENDOR_DOMAINS }))[0]).toMatch(/only on the recipient \(to\)/);
    expect(errorsOf(cond({ field: "to", op: "to_domain_in", value: [] }))[0]).toMatch(/lists no domain/);
    expect(errorsOf([{ id: "r", match: { tool: "gmail.send_email" }, when: [{ field: "to", op: "to_domain_in", value: ["a.in"] }, { field: "to", op: "to_domain_in", value: ["b.in"] }], decide: "allow", reason: "" }])[0]).toMatch(/share no domain/);
    expect(errorsOf(cond({ field: "amount", op: "lt", value: "lots" }))[0]).toMatch(/needs a number/);
    expect(errorsOf(cond({ field: "Amount", op: "eq", value: 1 }))[0]).toMatch(/not a field name/);
    expect(errorsOf(cond({ field: "to_domain_in", op: "eq", value: 1 }))[0]).toMatch(/not a field name/);
    expect(errorsOf(cond({ field: "x", op: "eq", value: ["a", "b"] }))[0]).toMatch(/takes one value/);
    expect(errorsOf(cond({ field: "x", op: "in", value: [] }))[0]).toMatch(/lists no value/);
    expect(errorsOf(cond({ field: "x", op: "in", value: ["a".repeat(501)] }))[0]).toMatch(/longer than 500/);
    expect(errorsOf(cond({ field: "x", op: "in", value: Array.from({ length: 70 }, (_, i) => `ab${i}`) }))[0]).toMatch(/200 values/);
    expect(errorsOf(cond({ field: "x", op: "regex" as never, value: "a" }))[0]).toMatch(/not a condition the guard knows/);
    expect(errorsOf([{ id: "r", match: { tool: "gmail.send_email" }, when: [{ field: "x", op: "eq", value: "a" }, { field: "x", op: "eq", value: "b" }], decide: "allow", reason: "" }])[0]).toMatch(/can never both hold/);
  });

  it("refuses rules it could not route to a person", () => {
    expect(errorsOf([ask({ approver: "legal" })])[0]).toMatch(/no approver group called "legal"/);
    expect(errorsOf([ask({ approver: undefined })], { groups: [] })[0]).toMatch(/no approver groups/);
    expect(errorsOf([ask()], { groups: [{ id: "finance", name: "Finance", emails: [" "] }] })[0]).toMatch(/nobody in the Finance approver group can approve/);
    expect(errorsOf([ask()], { groups: [{ id: "finance", name: "Finance", emails: Array.from({ length: 51 }, (_, i) => `p${i}@x.in`) }] })[0]).toMatch(/more than the guard's 50 people/);
    expect(errorsOf([{ id: "c", match: { tool: "gmail.send_email" }, decide: "allow", approver: "legal", reason: "", quota: { kind: "max_count", limit: 1, window: "day" } }])[0]).toMatch(/no approver group called "legal"/);
  });

  it("refuses ids, tags, decisions, expiries, reasons and quotas outside the guard's rules", () => {
    expect(errorsOf([ask({ id: "Pay_Large" })])[0]).toMatch(/rule id uses lowercase/);
    expect(errorsOf([ask({ decide: "maybe" as never })])[0]).toMatch(/not allow, ask or refuse/);
    expect(errorsOf([ask({ match: { tag: "explodes" } })])[0]).toMatch(/not a risk tag/);
    expect(errorsOf([ask({ expiresIn: "soon" })])[0]).toMatch(/not a duration/);
    expect(errorsOf([ask({ expiresIn: "12345h" })])[0]).toMatch(/not a duration/);
    expect(errorsOf([ask({ expiresIn: "31d" })])[0]).toMatch(/at most 30 days/);
    expect(errorsOf([ask({ reason: "x".repeat(301) })])[0]).toMatch(/longer than the guard's 300/);
    const quota = (q: ConsoleRule["quota"], id = "q") => errorsOf([{ id, match: { tool: "gmail.send_email" }, decide: "allow", reason: "", quota: q }]);
    expect(quota({ kind: "max_count", limit: 1.5, window: "day" })[0]).toMatch(/whole number/);
    expect(quota({ kind: "max_sum", limit: 0, window: "day" })[0]).toMatch(/limit above 0/);
    expect(quota({ kind: "max_sum", field: "Amount", limit: 5, window: "day" })[0]).toMatch(/not a field name/);
    expect(quota({ kind: "per_hour" as never, limit: 5, window: "day" })[0]).toMatch(/not a quota the guard knows/);
    expect(quota({ kind: "max_count", limit: 5, window: "weekly" })[0]).toMatch(/not a duration/);
    expect(quota({ kind: "max_count", limit: 5, window: "day" }, "q".repeat(60))[0]).toMatch(/too long to carry a quota/);
    expect(errorsOf([ask()], { agent: "Invoice Bot" })[0]).toMatch(/agent's name/);
  });

  it("passes on what the guard's own checks refuse (an unknown tool, a duplicate id)", () => {
    expect(errorsOf([ask({ match: { tool: "nope.tool" } })]).join("\n")).toMatch(/unknown tool/);
    expect(errorsOf([ask(), ask()]).join("\n")).toMatch(/duplicate rule id/);
    // without a registry, any well-formed tool name is accepted
    expect(consoleRulesToRulebook({ ...input([ask({ match: { tool: "nope.tool" } })]), registry: undefined }).ok).toBe(true);
  });

  it("lists every problem, not just the first", () => {
    expect(errorsOf([ask({ id: "BAD" }), ask({ id: "r2", approver: "legal" }), ask({ id: "r3", expiresIn: "x" })])).toHaveLength(3);
  });
});

describe("consoleRulesToRulebook: where the guard is stricter than the console", () => {
  const rb = translate(INVOICE);
  const d = (args: Record<string, unknown>) => decide(rb, "zoho_books.record_payment", args, { registry });
  it("compares amounts as numbers only: an amount sent as text matches no bound, so it is refused", () => {
    // the console reads "240000" as a number and asks Finance; the guard refuses it by default
    expect(d({ amount: "240000", vendor: "northwind" })).toMatchObject({ decision: "refuse", ruleId: "default" });
  });
  it("matches the spellings it lists: an unusual capitalisation is not an approved vendor", () => {
    expect(d({ amount: 100, vendor: "NorthWind" })).toMatchObject({ decision: "refuse", ruleId: "default" });
  });
});

// ---- Property: the guard decides as the console's evaluate (apps/console/src/lib/evaluate.ts) ----

/** The console's decision step, as built, with the organisation's named lists. Quotas are left to the next test. */
function consoleEvaluate(rules: ConsoleRule[], tool: string, args: Record<string, unknown>, lists: Record<string, string[]>) {
  const RANK = { allow: 0, ask: 1, refuse: 2 } as const;
  const test = (c: ConsoleCondition): boolean | undefined => {
    const raw = args[c.field] ?? (c.field === "to" ? args.to_domain : undefined);
    if (raw === undefined) return undefined;
    const v = typeof raw === "string" && !isNaN(Number(raw)) && c.op !== "eq" && c.op !== "in" ? Number(raw) : raw;
    const expand = (vals: unknown): string[] => (Array.isArray(vals) ? vals : [vals]).flatMap((x) => (typeof x === "string" && lists[x] ? lists[x] : [String(x)])).map((s) => s.toLowerCase());
    switch (c.op) {
      case "eq": return String(v).toLowerCase() === String(c.value).toLowerCase();
      case "lt": return Number(v) < Number(c.value);
      case "lte": return Number(v) <= Number(c.value);
      case "gt": return Number(v) > Number(c.value);
      case "gte": return Number(v) >= Number(c.value);
      case "in": return expand(c.value).includes(String(v).toLowerCase());
      case "to_domain_in": {
        const d = String(v).includes("@") ? String(v).split("@")[1]! : String(v);
        return expand(c.value).includes(d.toLowerCase());
      }
      default: return undefined;
    }
  };
  const tags = tagsOf(tool);
  let best: ConsoleRule | undefined;
  for (const rule of rules.filter((r) => r.mode !== "simulate")) {
    const applies = rule.match.tool ? rule.match.tool === tool : rule.match.tag ? tags.includes(rule.match.tag as RiskTag) : false;
    if (!applies) continue;
    const results = (rule.when ?? []).map(test);
    if (results.some((x) => x === undefined) || results.some((x) => x === false)) continue;
    if (rule.decide === "ask" && rule.unless?.length && rule.unless.every((c) => test(c) === true)) continue;
    if (!best || RANK[rule.decide] > RANK[best.decide]) best = rule;
  }
  return best ? { decision: best.decide, ruleId: best.id } : { decision: "refuse" as const, ruleId: "default" };
}

const VENDORS = ["northwind", "kalyanimetals", "suryapack", "shady"];
const spell = (s: string) => fc.constantFrom(s, s.toUpperCase(), s.charAt(0).toUpperCase() + s.slice(1));
const amount = fc.integer({ min: 0, max: 600000 });
const condition: fc.Arbitrary<ConsoleCondition> = fc.oneof(
  fc.record({ field: fc.constant("amount"), op: fc.constantFrom("lt", "lte", "gt", "gte", "eq") as fc.Arbitrary<ConsoleCondition["op"]>, value: amount }),
  fc.record({ field: fc.constant("vendor"), op: fc.constant("eq" as const), value: fc.constantFrom(...VENDORS) }),
  fc.record({ field: fc.constant("vendor"), op: fc.constant("in" as const), value: fc.oneof(fc.constant<string[]>(["approved_vendors"]), fc.subarray(VENDORS, { minLength: 1 })) }),
  fc.record({ field: fc.constant("gstin_verified"), op: fc.constant("eq" as const), value: fc.constantFrom("true", "false") }),
  fc.record({ field: fc.constant("to"), op: fc.constant("to_domain_in" as const), value: fc.subarray(VENDOR_DOMAINS, { minLength: 1 }) }),
);
const target = fc.oneof(fc.record({ tool: fc.constantFrom(...TOOLS.map((t) => t.name)) }), fc.record({ tag: fc.constantFrom<RiskTag>("reads_data", "moves_money", "sends_external", "writes_data", "deletes") }));
const rule = (i: number): fc.Arbitrary<ConsoleRule> =>
  fc.record({
    id: fc.constant(`r${i}`),
    match: target,
    when: fc.array(condition, { maxLength: 3 }),
    unless: fc.array(condition, { maxLength: 2 }),
    decide: fc.constantFrom("allow", "ask", "refuse") as fc.Arbitrary<ConsoleRule["decide"]>,
    approver: fc.constantFrom("finance", "owners", "Procurement"),
    reason: fc.constant("Because."),
    mode: fc.constantFrom<ConsoleRule["mode"]>("enforce", "enforce", "simulate"),
  });
const rules = fc.integer({ min: 1, max: 6 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => rule(i))));
const args = fc.record({
  amount: fc.oneof(amount, amount.map(String)),
  vendor: fc.constantFrom(...VENDORS).chain(spell),
  gstin_verified: fc.constantFrom(true, false, "true", "false", "TRUE", "False"),
  to: fc.constantFrom(...VENDOR_DOMAINS, "example.com").map((d) => `ap@${d}`),
}, { requiredKeys: [] });

describe("properties", () => {
  it("the guard decides every call as the console does (decision and rule)", () => {
    fc.assert(
      fc.property(rules, fc.constantFrom(...TOOLS.map((t) => t.name)), args, (rs, tool, a) => {
        const reg = registryFor(rs as ConsoleRule[]);
        const r = consoleRulesToRulebook(input(rs as ConsoleRule[], { registry: reg }));
        // contradictory value conditions are refused rather than signed; they can never match in the console either
        if (!r.ok) return r.errors.every((e) => /can never both hold|share no domain/.test(e));
        const want = consoleEvaluate(rs as ConsoleRule[], tool, a, LISTS);
        const got = decide(r.rulebook, tool, a, { registry: reg });
        // the console coerces "60000" for a bound; the guard compares numbers only (a stricter result, see below)
        if (typeof a.amount === "string" && rs.some((x) => [...(x.when ?? []), ...(x.unless ?? [])].some((c) => c.field === "amount" && c.op !== "eq"))) return true;
        return got.decision === want.decision && got.ruleId === want.ruleId;
      }),
      { numRuns: 600 },
    );
  });

  it("a rule's quota decides as the console's: counted for that rule, applied when it decides", () => {
    const withQuota = rules.chain((rs) =>
      fc.tuple(fc.constant(rs as ConsoleRule[]), fc.integer({ min: 0, max: rs.length - 1 }), fc.record({ kind: fc.constantFrom("max_count", "max_sum") as fc.Arbitrary<"max_count" | "max_sum">, limit: fc.integer({ min: 1, max: 400000 }), window: fc.constantFrom("day", "1h") }), fc.boolean(), fc.integer({ min: 0, max: 400000 })),
    );
    fc.assert(
      fc.property(withQuota, fc.constantFrom(...TOOLS.map((t) => t.name)), args, ([rs, at, q, withApprover, used], tool, a) => {
        const all = rs.map((x, i) => (i === at ? { ...x, decide: "allow" as const, mode: "enforce" as const, quota: { ...q, field: "amount" }, approver: withApprover ? "finance" : undefined } : x));
        const reg = registryFor(all);
        const r = consoleRulesToRulebook(input(all, { registry: reg }));
        if (!r.ok || typeof a.amount === "string") return true;
        const base = consoleEvaluate(all, tool, a, LISTS);
        // the console's quota step on its winner
        const winner = all.find((x) => x.id === base.ruleId);
        let want: string = base.decision;
        if (winner?.quota && base.decision === "allow") {
          const add = winner.quota.kind === "max_count" ? 1 : Number(a.amount) || 0;
          if (used + add > winner.quota.limit) want = winner.approver ? "ask" : "refuse";
        }
        const got = decide(r.rulebook, tool, a, { registry: reg, usage: { [`r${at}-quota`]: { count: used, sum: used } } });
        return got.decision === want && (got.decision === "refuse" || got.ruleId === base.ruleId);
      }),
      { numRuns: 400 },
    );
  });

  it("every translation is a valid rulebook that survives YAML", () => {
    fc.assert(
      fc.property(rules, (rs) => {
        const reg = registryFor(rs as ConsoleRule[]);
        const r = consoleRulesToRulebook(input(rs as ConsoleRule[], { registry: reg }));
        if (!r.ok) return true;
        const back = parseRulebookYaml(rulebookToYaml(r.rulebook), reg);
        return back.ok && JSON.stringify(back.rulebook) === JSON.stringify(r.rulebook);
      }),
      { numRuns: 200 },
    );
  });
});
