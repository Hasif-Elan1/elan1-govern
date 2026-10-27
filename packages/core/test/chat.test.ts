import { describe, expect, it } from "vitest";
import { APP_ONLY_TAGS, chatApprovalAllowed, chatApprovalBlocker, chatApprovalProblems, hasAmountCap } from "../src/chat";
import { decide } from "../src/engine";
import { parseRulebookYaml, publishProblems, rulebookToYaml, validateRulebook, type Rule, type Rulebook } from "../src/rulebook";
import { builtinRegistry, createRegistry, mergeRegistries, specFromJsonSchema } from "../src/tools";
import { sampleRulebook } from "./fixtures";

const ask = (r: Partial<Rule> & { id: string }): Rule => ({ decide: "ask", approver: "finance", approve_in_chat: true, ...r }) as Rule;
const book = (rules: Rule[]): Rulebook => ({ ...sampleRulebook(), rules });

// An upstream refunds tool (moves money, field "amount") and a CRM tool that touches personal data.
const registry = mergeRegistries(
  builtinRegistry,
  createRegistry([
    specFromJsonSchema({ name: "pay.refund", connector: "pay", inputSchema: { type: "object", properties: { order_id: { type: "string" }, amount: { type: "number" } } }, tags: ["moves_money"] }),
    specFromJsonSchema({ name: "crm.export", connector: "crm", inputSchema: { type: "object", properties: { list: { type: "string" } } }, tags: ["reads_data", "personal_data"] }),
    specFromJsonSchema({ name: "ops.deploy", connector: "ops", inputSchema: { type: "object", properties: {} }, tags: ["changes_production"] }),
    specFromJsonSchema({ name: "tickets.reply", connector: "tickets", inputSchema: { type: "object", properties: { ticket_id: { type: "string" } } }, tags: ["sends_external"] }),
  ]),
);

describe("approve_in_chat in the rulebook", () => {
  it("is optional, defaults to off, and round-trips through YAML after the other rule keys", () => {
    const rb = book([ask({ id: "small-pay", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 50000, lte: 200000 } } })]);
    const yaml = rulebookToYaml(rb);
    expect(yaml).toMatch(/approver: finance\n\s+approve_in_chat: true/);
    const back = parseRulebookYaml(yaml);
    expect(back.ok && back.rulebook.rules[0]?.approve_in_chat).toBe(true);
    expect(sampleRulebook().rules.every((r) => r.approve_in_chat === undefined)).toBe(true);
  });
  it("is only for ask rules", () => {
    const r = validateRulebook({ ...sampleRulebook(), rules: [{ id: "a", tool: "gmail.search", decide: "allow", approve_in_chat: true }] });
    expect(!r.ok && r.errors.join()).toMatch(/only ask rules can be approved in Slack or WhatsApp/);
    // false is harmless anywhere.
    expect(validateRulebook({ ...sampleRulebook(), rules: [{ id: "a", tool: "gmail.search", decide: "allow", approve_in_chat: false }] }).ok).toBe(true);
    expect(validateRulebook({ ...sampleRulebook(), rules: [{ id: "a", tool: "gmail.search", decide: "allow", approve_in_chat: "yes" }] }).ok).toBe(false);
  });
});

describe("hasAmountCap", () => {
  it("needs lt or lte on an amount field", () => {
    expect(hasAmountCap({ when: { amount_inr: { lte: 1 } } })).toBe(true);
    expect(hasAmountCap({ when: { amount: { gt: 10, lt: 500 } } })).toBe(true);
    expect(hasAmountCap({ when: { amount_usd: { lt: 5 } } })).toBe(true);
    expect(hasAmountCap({ when: { amount_inr: { gt: 50000 } } })).toBe(false);
    expect(hasAmountCap({ when: { amount_inr: { gte: 1 } } })).toBe(false);
    expect(hasAmountCap({ when: { quantity: { lt: 5 } } })).toBe(false);
    expect(hasAmountCap({ when: { amounts: { lt: 5 } } })).toBe(false);
    expect(hasAmountCap({ when: { amount: [1, 2] } })).toBe(false);
    expect(hasAmountCap({ when: { amount: null } })).toBe(false);
    expect(hasAmountCap({ when: { amount: { lt: "5" } } })).toBe(false);
    expect(hasAmountCap({})).toBe(false);
  });
});

describe("chatApprovalBlocker", () => {
  it("allows asks for tools that only contact people or change ordinary records", () => {
    expect(chatApprovalBlocker(ask({ id: "a", tool: "zoho.create_bill" }))).toBeNull();
    expect(chatApprovalBlocker(ask({ id: "a", tool: "tickets.reply" }), registry)).toBeNull();
    expect(chatApprovalBlocker(ask({ id: "a", tag: "sends_external" }), registry)).not.toBeNull(); // gmail.send_reply touches personal data
  });
  it("refuses non-ask rules", () => {
    expect(chatApprovalBlocker({ id: "a", tool: "zoho.create_bill", decide: "allow" })).toMatch(/Only rules that ask a person/);
  });
  it("money: only with an upper amount", () => {
    expect(chatApprovalBlocker(ask({ id: "p", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 50000 } } }))).toMatch(/moves money with no upper amount/);
    expect(chatApprovalBlocker(ask({ id: "p", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 50000, lte: 200000 } } }))).toBeNull();
    expect(chatApprovalBlocker(ask({ id: "p", tag: "moves_money" }), registry)).toMatch(/no upper amount/);
    expect(chatApprovalBlocker(ask({ id: "p", tag: "moves_money", when: { amount: { lt: 5000 } } }), registry)).toBeNull();
    expect(chatApprovalBlocker(ask({ id: "p", tool: "pay.refund", when: { amount: { lte: 2000 } } }), registry)).toBeNull();
    // A tag rule that reaches a payment tool through another tag still needs the cap.
    expect(chatApprovalBlocker(ask({ id: "w", tool: "pay.refund" }), registry)).toMatch(/no upper amount/);
  });
  it("app-only tags, by the rule's own tag or a tool it reaches", () => {
    for (const tag of APP_ONLY_TAGS) {
      expect(chatApprovalBlocker(ask({ id: "t", tag }), registry), tag).toMatch(/can only be approved in Elan1 Govern/);
    }
    expect(chatApprovalBlocker(ask({ id: "v", tool: "zoho.update_vendor" }))).toBe("This rule covers update a vendor (zoho.update_vendor), which touches personal data, so it can only be approved in Elan1 Govern.");
    expect(chatApprovalBlocker(ask({ id: "d", tool: "ops.deploy" }), registry)).toMatch(/changes production systems/);
    expect(chatApprovalBlocker(ask({ id: "x", tool: "crm.export" }), registry)).toMatch(/touches personal data/);
    // writes_data reaches record_bill_payment (money, no cap) and update_vendor (personal data).
    expect(chatApprovalBlocker(ask({ id: "w", tag: "writes_data" }))).toMatch(/touches personal data/);
    // Even a capped amount does not open personal-data tools.
    expect(chatApprovalBlocker(ask({ id: "w", tag: "writes_data", when: { amount_inr: { lte: 10 } } }))).toMatch(/personal data/);
  });
  it("a tool that is not in the registry has no tags to block on", () => {
    expect(chatApprovalBlocker(ask({ id: "u", tool: "gone.tool" }))).toBeNull();
  });
});

describe("publishing", () => {
  it("refuses approve_in_chat where it is not allowed, for every risk tier, with plain messages", () => {
    const rb = book([
      ask({ id: "big-pay", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 50000 } } }),
      ask({ id: "bank", tool: "zoho.update_vendor", when: { fields_include: ["bank_account"] } }),
      ask({ id: "bills", tool: "zoho.create_bill" }),
      { id: "off", tool: "zoho.update_vendor", decide: "ask", approver: "finance", approve_in_chat: false },
    ]);
    for (const tier of ["low", "medium", "high"] as const) {
      const problems = publishProblems(rb, tier);
      expect(problems.filter((p) => p.includes("Slack or WhatsApp"))).toEqual([
        'Rule "big-pay" cannot be approved in Slack or WhatsApp. This rule moves money with no upper amount, so it can only be approved in Elan1 Govern. Add an "up to" or "under" amount to the rule to allow approving it in Slack or WhatsApp.',
        'Rule "bank" cannot be approved in Slack or WhatsApp. This rule covers update a vendor (zoho.update_vendor), which touches personal data, so it can only be approved in Elan1 Govern.',
      ]);
    }
    expect(chatApprovalProblems(book([ask({ id: "bills", tool: "zoho.create_bill" })]))).toEqual([]);
  });
  it("accepts a capped payment rule", () => {
    expect(publishProblems(book([ask({ id: "mid-pay", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 50000, lte: 200000 } } })]), "high")).toEqual([]);
  });
  it("uses the org's own tools and tags", () => {
    const rb = book([ask({ id: "refunds", tool: "pay.refund", when: { amount: { gt: 100 } } })]);
    expect(publishProblems(rb, "low", registry)).toHaveLength(1);
  });
});

describe("chatApprovalAllowed (decision time)", () => {
  const rb = book([
    { id: "small", tool: "zoho.record_bill_payment", when: { amount_inr: { lte: 50000 } }, decide: "allow" },
    ask({ id: "mid", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 50000, lte: 200000 } } }),
    { id: "big", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 200000 } }, decide: "ask", approver: "finance" },
    ask({ id: "bills", tool: "zoho.create_bill" }),
  ]);
  it("follows the deciding rule", () => {
    expect(chatApprovalAllowed(rb, decide(rb, "zoho.record_bill_payment", { bill_id: "b", amount_inr: 100000 }))).toBe(true);
    expect(chatApprovalAllowed(rb, decide(rb, "zoho.record_bill_payment", { bill_id: "b", amount_inr: 300000 }))).toBe(false);
    expect(chatApprovalAllowed(rb, decide(rb, "zoho.record_bill_payment", { bill_id: "b", amount_inr: 100 }))).toBe(false);
    expect(chatApprovalAllowed(rb, { decision: "ask", ruleId: "missing" })).toBe(false);
  });
  it("never for a quota ask", () => {
    expect(chatApprovalAllowed(rb, { decision: "ask", ruleId: "bills", quotaId: "per-day" })).toBe(false);
    expect(chatApprovalAllowed(rb, { decision: "ask", ruleId: "bills" })).toBe(true);
  });
  it("re-checks against today's tags", () => {
    const retagged = createRegistry(builtinRegistry.list().map((t) => (t.name === "zoho.create_bill" ? { ...t, tags: [...t.tags, "deletes" as const] } : t)));
    expect(chatApprovalAllowed(rb, { decision: "ask", ruleId: "bills" }, retagged)).toBe(false);
  });
});
