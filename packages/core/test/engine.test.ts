import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, ruleMatches, summarizeArgs } from "../src/engine";
import { validateRulebook, type Rule, type Rulebook } from "../src/rulebook";
import { sampleRulebook } from "./fixtures";

const rb = sampleRulebook();
const pay = (amount_inr: number) => ({ bill_id: "b1", amount_inr });

describe("decide: documented example", () => {
  it("allows reading mail", () => {
    const d = decide(rb, "gmail.read_message", { message_id: "m1" });
    expect(d).toMatchObject({ decision: "allow", ruleId: "read-mail", argsSummary: { message_id: "m1" } });
  });
  it("allows small payments and asks for large ones", () => {
    expect(decide(rb, "zoho.record_bill_payment", pay(18000))).toMatchObject({ decision: "allow", ruleId: "pay-small" });
    expect(decide(rb, "zoho.record_bill_payment", pay(50000)).decision).toBe("allow");
    const large = decide(rb, "zoho.record_bill_payment", pay(200000));
    expect(large).toMatchObject({ decision: "ask", ruleId: "pay-large", approverGroup: "finance", expiresInMs: 86_400_000 });
    expect(large.approvers).toEqual(["priya@acme.in", "ca@sharma-ca.in"]);
  });
  it("refuses bank changes and names the rule", () => {
    const d = decide(rb, "zoho.update_vendor", { vendor_id: "v1", fields: { ifsc: "HDFC0001234" } });
    expect(d).toMatchObject({ decision: "refuse", ruleId: "no-bank-change", argsSummary: { vendor_id: "v1", fields: ["ifsc"] } });
    expect(JSON.stringify(d.argsSummary)).not.toContain("HDFC");
  });
  it("refuses unknown tools and unmatched calls by default", () => {
    const unknown = decide(rb, "shell.exec", { cmd: "ls" });
    expect(unknown).toMatchObject({ decision: "refuse", ruleId: "default", argsSummary: {} });
    expect(unknown.reason).toMatch(/not a tool Elan1 Govern knows/);
    const unmatched = decide(rb, "zoho.update_vendor", { vendor_id: "v1", fields: { phone: "1" } });
    expect(unmatched).toMatchObject({ decision: "refuse", ruleId: "default" });
    expect(unmatched.reason).toMatch(/No rule allows/);
  });
  it("asks for replies to vendor domains, using context lists", () => {
    const args = { message_id: "m", to: "Accounts@Sharma.in", body: "secret body" };
    expect(decide(rb, "gmail.send_reply", args, { lists: { vendor_domains: ["sharma.in"] } })).toMatchObject({
      decision: "ask",
      argsSummary: { message_id: "m", to_domain: "sharma.in" },
    });
    expect(decide(rb, "gmail.send_reply", args).decision).toBe("refuse");
    expect(JSON.stringify(decide(rb, "gmail.send_reply", args).argsSummary)).not.toContain("secret");
  });
});

describe("decide: strictest wins", () => {
  const book = (rules: Rule[]): Rulebook => ({ ...rb, limits: undefined, rules });
  it("refuse beats ask beats allow regardless of order", () => {
    const rules: Rule[] = [
      { id: "a", tool: "gmail.search", decide: "allow" },
      { id: "b", tool: "gmail.search", decide: "ask", approver: "finance" },
      { id: "c", tool: "gmail.search", decide: "refuse" },
    ];
    expect(decide(book(rules), "gmail.search", { query: "x" }).ruleId).toBe("c");
    expect(decide(book([...rules].reverse()), "gmail.search", { query: "x" }).ruleId).toBe("c");
    expect(decide(book(rules.slice(0, 2)), "gmail.search", { query: "x" }).ruleId).toBe("b");
    expect(decide(book(rules.slice(0, 2)), "gmail.search", { query: "x" }).matched).toEqual(["a", "b"]);
  });
  it("uses a rule's reason when given", () => {
    const d = decide(book([{ id: "x", tool: "gmail.search", decide: "refuse", reason: "Not today." }]), "gmail.search", { query: "" });
    expect(d.reason).toBe("Not today.");
  });
});

describe("decide: limits", () => {
  it("turns an allow into an ask when the daily limit would be passed", () => {
    const d = decide(rb, "zoho.record_bill_payment", pay(40000), { usage: { daily_payments_inr: 470000 } });
    expect(d).toMatchObject({ decision: "ask", ruleId: "pay-small", approverGroup: "finance" });
    expect(d.reason).toMatch(/daily limit/);
    expect(decide(rb, "zoho.record_bill_payment", pay(30000), { usage: { daily_payments_inr: 470000 } }).decision).toBe("allow");
  });
  it("refuses when the limit is hit and nobody can approve", () => {
    const noApprovers: Rulebook = { ...rb, approvers: {}, rules: rb.rules.filter((r) => r.decide !== "ask") };
    expect(decide(noApprovers, "zoho.record_bill_payment", pay(40000), { usage: { daily_payments_inr: 480000 } }).decision).toBe("refuse");
  });
  it("ignores limits for other tools and without a limit", () => {
    expect(decide({ ...rb, limits: undefined }, "zoho.record_bill_payment", pay(40000), { usage: { daily_payments_inr: 9e9 } }).decision).toBe("allow");
    expect(decide(rb, "gmail.read_message", { message_id: "m" }, { usage: { daily_payments_inr: 9e9 } }).decision).toBe("allow");
  });
});

describe("conditions", () => {
  const match = (when: Record<string, unknown>, args: Record<string, unknown>) =>
    ruleMatches({ id: "r", tool: "zoho.create_bill", when, decide: "allow" }, "zoho.create_bill", args, rb);
  it("supports eq, in, lt, gte", () => {
    expect(match({ bill_number: { eq: "A" } }, { bill_number: "A" })).toBe(true);
    expect(match({ bill_number: { eq: "A" } }, { bill_number: "B" })).toBe(false);
    expect(match({ vendor_id: { in: ["v1", "v2"] } }, { vendor_id: "v2" })).toBe(true);
    expect(match({ vendor_id: { in: ["v1"] } }, { vendor_id: "v2" })).toBe(false);
    expect(match({ amount_inr: { lt: 10 } }, { amount_inr: 9 })).toBe(true);
    expect(match({ amount_inr: { lt: 10 } }, { amount_inr: 10 })).toBe(false);
    expect(match({ amount_inr: { gte: 10 } }, { amount_inr: 10 })).toBe(true);
    expect(match({ amount_inr: { gte: 10 } }, { amount_inr: 9 })).toBe(false);
    expect(match({ amount_inr: { gt: 10 } }, { amount_inr: 10 })).toBe(false);
    expect(match({ amount_inr: { lte: 10 } }, { amount_inr: 11 })).toBe(false);
  });
  it("fails closed on missing or mistyped values", () => {
    expect(match({ amount_inr: { lt: 10 } }, {})).toBe(false);
    expect(match({ amount_inr: { lt: 10 } }, { amount_inr: "5" })).toBe(false);
    expect(match({ amount_inr: { lt: 10 } }, { amount_inr: null })).toBe(false);
    expect(match({ amount_inr: "bogus" }, { amount_inr: 1 })).toBe(false);
    expect(ruleMatches(rb.rules[4]!, "zoho.update_vendor", { vendor_id: "v" }, rb)).toBe(false);
    expect(ruleMatches(rb.rules[4]!, "zoho.update_vendor", { vendor_id: "v", fields: { ifsc: "x" } }, rb)).toBe(true);
    expect(ruleMatches({ ...rb.rules[4]!, when: { fields_include: "ifsc" } }, "zoho.update_vendor", { fields: { ifsc: "x" } }, rb)).toBe(false);
    expect(ruleMatches(rb.rules[1]!, "gmail.send_reply", { to: "no-at-sign" }, rb, { lists: { vendor_domains: ["x"] } })).toBe(false);
    expect(ruleMatches({ ...rb.rules[1]!, when: { to_domain_in: 7 } }, "gmail.send_reply", { to: "a@x" }, rb)).toBe(false);
  });
  it("supports inline domain lists and rulebook lists", () => {
    const rule: Rule = { id: "r", tool: "gmail.send_reply", when: { to_domain_in: ["acme.in"] }, decide: "allow" };
    expect(ruleMatches(rule, "gmail.send_reply", { to: "a@acme.in" }, rb)).toBe(true);
    const listed = { ...rb, lists: { partners: ["p.in"] } };
    expect(ruleMatches({ ...rule, when: { to_domain_in: "partners" } }, "gmail.send_reply", { to: "a@p.in" }, listed)).toBe(true);
  });
  it("summaries keep only scalar fields", () => {
    expect(summarizeArgs("zoho.create_bill", { vendor_id: { nested: 1 }, bill_number: "B", amount_inr: 5 }, rb)).toEqual({ bill_number: "B", amount_inr: 5 });
    expect(summarizeArgs("gmail.send_reply", { to: "bad" }, rb)).toEqual({});
    expect(summarizeArgs("zoho.update_vendor", { vendor_id: "v" }, rb)).toEqual({ vendor_id: "v" });
  });
});

describe("properties", () => {
  const decisions = fc.constantFrom("allow" as const, "ask" as const, "refuse" as const);
  const ruleArb = fc.record({
    decide: decisions,
    lte: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
  });
  const bookArb = fc.array(ruleArb, { maxLength: 8 }).map((rs) => {
    const parsed = validateRulebook({
      ...rb,
      limits: undefined,
      rules: rs.map((r, i) => ({
        id: `r${i}`,
        tool: "zoho.record_bill_payment",
        ...(r.lte !== undefined ? { when: { amount_inr: { lte: r.lte } } } : {}),
        decide: r.decide,
        ...(r.decide === "ask" ? { approver: "finance" } : {}),
      })),
    });
    if (!parsed.ok) throw new Error(parsed.errors.join());
    return parsed.rulebook;
  });
  const RANK = { allow: 0, ask: 1, refuse: 2 };

  it("the outcome is the strictest matching rule, or refuse when none match", () => {
    fc.assert(
      fc.property(bookArb, fc.integer({ min: 0, max: 1_000_000 }), (book, amount) => {
        const d = decide(book, "zoho.record_bill_payment", pay(amount));
        const matching = book.rules.filter((r) => ruleMatches(r, "zoho.record_bill_payment", pay(amount), book));
        if (matching.length === 0) return d.decision === "refuse" && d.ruleId === "default";
        const strictest = Math.max(...matching.map((r) => RANK[r.decide]));
        return RANK[d.decision] === strictest && matching.some((r) => r.id === d.ruleId);
      }),
    );
  });

  it("adding a rule never makes a decision less strict, unless nothing matched before", () => {
    fc.assert(
      fc.property(bookArb, ruleArb, fc.integer({ min: 0, max: 1_000_000 }), (book, extra, amount) => {
        const before = decide(book, "zoho.record_bill_payment", pay(amount));
        const after = decide(
          {
            ...book,
            rules: [
              ...book.rules,
              {
                id: "extra",
                tool: "zoho.record_bill_payment",
                ...(extra.lte !== undefined ? { when: { amount_inr: { lte: extra.lte } } } : {}),
                decide: extra.decide,
                ...(extra.decide === "ask" ? { approver: "finance" } : {}),
              },
            ],
          },
          "zoho.record_bill_payment",
          pay(amount),
        );
        return before.ruleId === "default" || RANK[after.decision] >= RANK[before.decision];
      }),
    );
  });

  it("limits never loosen a decision", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600_000 }), fc.integer({ min: 0, max: 600_000 }), (amount, used) => {
        const plain = decide({ ...rb, limits: undefined }, "zoho.record_bill_payment", pay(amount));
        const limited = decide(rb, "zoho.record_bill_payment", pay(amount), { usage: { daily_payments_inr: used } });
        return RANK[limited.decision] >= RANK[plain.decision];
      }),
    );
  });
});
