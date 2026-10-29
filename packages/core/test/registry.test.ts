import { describe, expect, it } from "vitest";
import { describeRule } from "../src/describe";
import { decide, quotasFor } from "../src/engine";
import { parseRulebookYaml, publishProblems, quotasOf, rulebookToYaml, validateRulebook, type Rulebook } from "../src/rulebook";
import { loadSignedRulebook, signRulebook } from "../src/rulebook-sign";
import { builtinRegistry, createRegistry, lenientRegistry, mergeRegistries, specFromJsonSchema, suggestTags, validateArgs, isValidToolName, BUILTIN_TOOLS } from "../src/tools";
import { KEYS } from "./fixtures";

// A CRM connector discovered at runtime, e.g. from an upstream MCP server.
const crm = createRegistry([
  specFromJsonSchema({
    name: "crm.issue_refund",
    connector: "crm",
    description: "Refund a customer order",
    tags: ["moves_money", "personal_data"],
    inputSchema: { type: "object", properties: { order_id: { type: "string" }, amount: { type: "number" }, note: { type: "string" } }, required: ["order_id", "amount"], additionalProperties: false },
  }),
  specFromJsonSchema({ name: "crm.delete_contact", connector: "crm", tags: ["deletes", "personal_data"], inputSchema: { type: "object", properties: { contact_id: { type: "string" } } } }),
  specFromJsonSchema({ name: "crm.lookup", connector: "crm" }),
]);
const registry = mergeRegistries(builtinRegistry, crm);

const base = { version: 1, agent: "support-bot", owner: "lead@acme.com", default: "refuse", approvers: { "support-leads": ["lead@acme.com"] } };

function book(extra: Record<string, unknown>): Rulebook {
  const r = validateRulebook({ ...base, ...extra }, registry);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.rulebook;
}

describe("tool registry", () => {
  it("describes runtime tools from JSON Schema", () => {
    const spec = crm.get("crm.issue_refund")!;
    expect(spec).toMatchObject({ label: "Issue refund", fields: ["order_id", "amount", "note"], summaryFields: ["order_id", "amount"], tags: ["moves_money", "personal_data"] });
    expect(crm.get("crm.lookup")).toMatchObject({ fields: [], tags: [], description: "" });
    expect(BUILTIN_TOOLS.find((t) => t.name === "zoho.record_bill_payment")?.tags).toContain("moves_money");
    expect(isValidToolName("crm.issue_refund")).toBe(true);
    expect(isValidToolName("no-dot")).toBe(false);
    expect(isValidToolName("Bad Name.x")).toBe(false);
  });
  it("validates arguments for built-in and runtime tools", () => {
    expect(validateArgs(builtinRegistry.get("zoho.record_bill_payment")!, { bill_id: "b", amount_inr: -1 })).toMatchObject({ ok: false });
    expect(validateArgs(builtinRegistry.get("gmail.search")!, { query: "x" })).toEqual({ ok: true, args: { query: "x" } });
    const refund = crm.get("crm.issue_refund")!;
    expect(validateArgs(refund, { order_id: "o1", amount: 5 })).toMatchObject({ ok: true });
    expect(validateArgs(refund, { order_id: "o1" })).toEqual({ ok: false, error: "amount: required" });
    expect(validateArgs(refund, { order_id: "o1", amount: 1, extra: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/extra/) });
    expect(validateArgs(refund, [1])).toMatchObject({ ok: false });
    expect(validateArgs(refund, null)).toMatchObject({ ok: false });
    expect(validateArgs(crm.get("crm.lookup")!, { big: "x".repeat(200_001) })).toMatchObject({ ok: false, error: "arguments are too large" });
    expect(validateArgs(crm.get("crm.lookup")!, { anything: 1 })).toMatchObject({ ok: true });
  });
  it("lenient registry accepts gone tools when loading but not malformed names", () => {
    const l = lenientRegistry(builtinRegistry);
    expect(l.get("crm.gone")).toMatchObject({ open: true });
    expect(l.get("bad")).toBeUndefined();
    expect(l.list()).toHaveLength(builtinRegistry.list().length);
  });
});

describe("rules by risk tag", () => {
  const rb = book({
    rules: [
      { id: "lookups", tool: "crm.lookup", decide: "allow" },
      { id: "small-refunds", tool: "crm.issue_refund", when: { amount: { lte: 100 } }, decide: "allow" },
      { id: "money-needs-a-lead", tag: "moves_money", when: { amount: { gt: 100 } }, decide: "ask", approver: "support-leads" },
      { id: "never-delete", tag: "deletes", decide: "refuse" },
    ],
  });
  it("matches by tag and keeps strictest-wins", () => {
    const ctx = { registry };
    expect(decide(rb, "crm.issue_refund", { order_id: "o", amount: 50 }, ctx)).toMatchObject({ decision: "allow", ruleId: "small-refunds", argsSummary: { order_id: "o", amount: 50 } });
    expect(decide(rb, "crm.issue_refund", { order_id: "o", amount: 500 }, ctx)).toMatchObject({ decision: "ask", ruleId: "money-needs-a-lead", approvers: ["lead@acme.com"] });
    expect(decide(rb, "crm.delete_contact", { contact_id: "c" }, ctx)).toMatchObject({ decision: "refuse", ruleId: "never-delete" });
    expect(decide(rb, "crm.lookup", {}, ctx).decision).toBe("allow");
    expect(decide(rb, "crm.unknown", {}, ctx)).toMatchObject({ decision: "refuse", ruleId: "default", reason: expect.stringMatching(/not a tool Elan1 Govern knows/) });
    // Without the CRM tools in the registry, tag rules can't see their tags.
    expect(decide(rb, "crm.delete_contact", {}).ruleId).toBe("default");
  });
  it("round-trips tag rules through YAML and describes them", () => {
    const again = parseRulebookYaml(rulebookToYaml(rb), registry);
    expect(again.ok && again.rulebook).toEqual(rb);
    expect(rulebookToYaml(rb)).toContain("tag: moves_money");
    expect(describeRule(rb.rules[2]!)).toBe("Ask support-leads before: any action that moves money, when the amount is over 100");
    expect(describeRule({ tag: "deletes", decide: "refuse" })).toBe("Never allow: any action that deletes data");
  });
  it("validates tool-or-tag and checks fields only for named tools", () => {
    const err = (rules: unknown[]) => {
      const r = validateRulebook({ ...base, rules }, registry);
      return r.ok ? "" : r.errors.join("\n");
    };
    expect(err([{ id: "x", decide: "allow" }])).toMatch(/either a tool or a tag/);
    expect(err([{ id: "x", tool: "crm.lookup", tag: "deletes", decide: "allow" }])).toMatch(/either a tool or a tag/);
    expect(err([{ id: "x", tag: "flies", decide: "allow" }])).not.toBe("");
    expect(err([{ id: "x", tool: "crm.issue_refund", when: { amont: { gt: 1 } }, decide: "allow" }])).toMatch(/no field "amont"/);
    expect(err([{ id: "x", tag: "moves_money", when: { anything: { gt: 1 } }, decide: "allow" }])).toBe("");
    expect(err([{ id: "x", tool: "crm.issue_refund", when: { fields_include: ["a"] }, decide: "allow" }])).toMatch(/has no fields/);
    expect(err([{ id: "x", tag: "writes_data", when: { fields_include: ["Bad Field"] }, decide: "allow" }])).toMatch(/list of field names/);
  });
  it("blocks publishing for high-risk agents by tag", () => {
    const allowOnly = book({ rules: [{ id: "r", tool: "crm.issue_refund", decide: "allow" }] });
    expect(publishProblems(allowOnly, "high", registry)[0]).toMatch(/issue refund \(crm\.issue_refund\), because it moves money/);
    expect(publishProblems(rb, "high", registry)).toEqual([]);
    const delAllowed = book({ rules: [{ id: "r", tag: "deletes", decide: "allow" }] });
    expect(publishProblems(delAllowed, "high", registry)[0]).toMatch(/deletes data/);
  });
  it("loads a signed rulebook whose tool has since disappeared", () => {
    const signed = rulebookToYaml(signRulebook(rb, KEYS.privateKeyPem));
    expect(loadSignedRulebook(signed, KEYS.publicKeyPem, builtinRegistry)).toMatchObject({ ok: true });
  });
});

describe("quotas", () => {
  const rb = book({
    rules: [{ id: "refunds", tool: "crm.issue_refund", decide: "allow" }, { id: "lookups", tool: "crm.lookup", decide: "allow" }],
    quotas: [
      { id: "refund-count", tool: "crm.issue_refund", window: "1h", max_count: 3 },
      { id: "money-per-day", tag: "moves_money", window: "day", max_sum: { field: "amount", value: 1000 }, approver: "support-leads" },
    ],
  });
  const ctx = (usage: Record<string, { count: number; sum: number }>) => ({ registry, usage });
  it("turn an allow into an ask when breached", () => {
    expect(decide(rb, "crm.issue_refund", { order_id: "o", amount: 10 }, ctx({})).decision).toBe("allow");
    expect(decide(rb, "crm.issue_refund", { order_id: "o", amount: 10 }, ctx({ "refund-count": { count: 3, sum: 0 } }))).toMatchObject({ decision: "ask", quotaId: "refund-count", reason: expect.stringMatching(/limit of 3 per 1h/) });
    expect(decide(rb, "crm.issue_refund", { order_id: "o", amount: 300 }, ctx({ "money-per-day": { count: 0, sum: 800 } }))).toMatchObject({ decision: "ask", quotaId: "money-per-day", approverGroup: "support-leads" });
    expect(decide(rb, "crm.lookup", {}, ctx({ "refund-count": { count: 99, sum: 0 } })).decision).toBe("allow");
  });
  it("lists the quotas for a tool, including the legacy daily limit", () => {
    expect(quotasFor(rb, "crm.issue_refund", registry).map((q) => q.id)).toEqual(["refund-count", "money-per-day"]);
    expect(quotasOf({ ...rb, limits: { daily_payments_inr: 5 } }).map((q) => q.id)).toContain("daily-payments");
    expect(rulebookToYaml(rb)).toContain("max_sum: { field: amount, value: 1000 }");
  });
  it("validates quotas", () => {
    const err = (quotas: unknown[]) => {
      const r = validateRulebook({ ...base, rules: [], quotas }, registry);
      return r.ok ? "" : r.errors.join("\n");
    };
    expect(err([{ id: "q", window: "day", max_count: 1 }])).toMatch(/either a tool or a tag/);
    expect(err([{ id: "q", tool: "crm.nope", window: "day", max_count: 1 }])).toMatch(/unknown tool/);
    expect(err([{ id: "q", tool: "crm.lookup", window: "day" }])).toMatch(/max_count or max_sum/);
    expect(err([{ id: "q", tool: "crm.lookup", window: "day", max_count: 1, approver: "nobody" }])).toMatch(/not defined/);
    expect(err([{ id: "q", tool: "crm.lookup", window: "day", max_count: 1 }, { id: "q", tool: "crm.lookup", window: "1h", max_count: 1 }])).toMatch(/duplicate quota/);
    expect(err([{ id: "q", tool: "crm.lookup", window: "weekly", max_count: 1 }])).not.toBe("");
  });
  it("refuses when breached and there is nobody to ask", () => {
    const solo = book({ approvers: {}, rules: [{ id: "r", tool: "crm.lookup", decide: "allow" }], quotas: [{ id: "q", tool: "crm.lookup", window: "day", max_count: 1 }] });
    expect(decide(solo, "crm.lookup", {}, ctx({ q: { count: 1, sum: 0 } }))).toMatchObject({ decision: "refuse", quotaId: "q" });
  });
  it("refuses when breached if the quota says so, even with approvers set", () => {
    const strict = book({ rules: [{ id: "r", tool: "crm.lookup", decide: "allow" }], quotas: [{ id: "q", tool: "crm.lookup", window: "day", max_count: 1, on_breach: "refuse" }] });
    expect(decide(strict, "crm.lookup", {}, ctx({ q: { count: 1, sum: 0 } }))).toMatchObject({ decision: "refuse", quotaId: "q", reason: expect.stringMatching(/refuses calls over this limit/) });
    expect(decide(strict, "crm.lookup", {}, ctx({})).decision).toBe("allow");
    const r = validateRulebook({ ...base, rules: [], quotas: [{ id: "q", tool: "crm.lookup", window: "day", max_count: 1, on_breach: "refuse", approver: "support-leads" }] }, registry);
    expect(r.ok ? "" : r.errors.join("\n")).toMatch(/takes no approver/);
  });
  it("a quota on one rule applies only when that rule decides, and must name an allow rule", () => {
    const rb = book({
      rules: [
        { id: "small", tool: "crm.issue_refund", when: { amount: { lte: 100 } }, decide: "allow" },
        { id: "vip", tool: "crm.issue_refund", when: { amount: { gt: 100 } }, decide: "allow" },
      ],
      quotas: [{ id: "small-quota", tool: "crm.issue_refund", window: "day", max_count: 2, rule: "small", on_breach: "refuse" }],
    });
    const used = ctx({ "small-quota": { count: 2, sum: 0 } });
    expect(decide(rb, "crm.issue_refund", { order_id: "o", amount: 50 }, used)).toMatchObject({ decision: "refuse", quotaId: "small-quota" });
    expect(decide(rb, "crm.issue_refund", { order_id: "o", amount: 500 }, used)).toMatchObject({ decision: "allow", ruleId: "vip" });
    const err = (rule: string) => {
      const r = validateRulebook({ ...base, rules: [{ id: "a", tool: "crm.lookup", decide: "ask", approver: "support-leads" }], quotas: [{ id: "q", tool: "crm.lookup", window: "day", max_count: 1, rule }] }, registry);
      return r.ok ? "" : r.errors.join("\n");
    };
    expect(err("a")).toMatch(/not an allow rule/);
    expect(err("nope")).toMatch(/not an allow rule/);
  });
});

describe("suggested tags", () => {
  it("reads the tool name, splitting snake, kebab and camel case", () => {
    expect(suggestTags("issue_refund")).toEqual(["moves_money", "writes_data"]);
    expect(suggestTags("deleteContact")).toEqual(["deletes", "personal_data"]);
    expect(suggestTags("send-email")).toEqual(["sends_external"]);
    expect(suggestTags("grant_role")).toEqual(["changes_access"]);
    expect(suggestTags("restart_service")).toEqual(["changes_production"]);
    expect(suggestTags("update_ticket")).toEqual(["writes_data"]);
    expect(suggestTags("lookup")).toEqual(["reads_data"]);
    expect(suggestTags("list_patients")).toEqual(["reads_data", "personal_data"]);
    expect(suggestTags("charges")).toEqual(["moves_money"]);
  });
  it("falls back to the description only when the name says nothing", () => {
    expect(suggestTags("crm_thing", "Removes an order")).toEqual(["deletes"]);
    expect(suggestTags("lookup", "Never deletes anything")).toEqual(["reads_data"]);
    expect(suggestTags("frobnicate", "")).toEqual([]);
    expect(suggestTags("frobnicate")).toEqual([]);
  });
});
