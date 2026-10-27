import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { describeRule } from "../src/describe";
import { decide } from "../src/engine";
import { packById, starterRulebook } from "../src/frameworks";
import { parseRulebookYaml, rulebookToYaml, validateRulebook, type Rule, type Rulebook } from "../src/rulebook";
import { argsFromSummary, evidenceGrewEnough, mineSuggestions, niceFloor, type PastApproval } from "../src/suggest";
import { builtinRegistry, createRegistry, mergeRegistries, specFromJsonSchema } from "../src/tools";

const DAY = 86_400_000;
const NOW = new Date("2026-10-27T10:00:00Z");
const VENDORS = ["Sharma Traders", "Kaveri Logistics", "Nilgiri Office", "Deccan Steel", "Malabar Spices", "Coromandel Paper"];

const demo = (): Rulebook => structuredClone(starterRulebook(packById("finance")!, { agent: "ap-bot", owner: "o@x.in", approvers: ["o@x.in"] })) as Rulebook;

let n = 0;
function past(p: Partial<PastApproval> & { summary: Record<string, unknown> }, daysAgo: number, waitH = 2): PastApproval {
  const createdAt = new Date(NOW.getTime() - daysAgo * DAY);
  return { id: `a${n++}`, tool: "zoho.record_bill_payment", ruleId: "pay-large", status: "approved", resolvedAt: new Date(createdAt.getTime() + waitH * 3_600_000), createdAt, ...p };
}

/** 41 approved payments between ₹52,000 and ₹1,00,000 to six vendors over 28 days. */
function demoHistory(): PastApproval[] {
  const out: PastApproval[] = [];
  for (let i = 0; i < 41; i++) out.push(past({ summary: { bill_id: `b${i}`, amount_inr: i === 0 ? 100000 : 52000 + ((i * 1171) % 47000), vendor: VENDORS[i % 6], bill: `INV-${i}` } }, 1 + i * 0.68, 1 + (i % 5)));
  out.push(past({ status: "rejected", summary: { bill_id: "x", amount_inr: 240000, vendor: "Unknown Co" } }, 5));
  out.push(past({ status: "expired", summary: { bill_id: "y", amount_inr: 150000 } }, 9));
  return out;
}

const refundTool = specFromJsonSchema({
  name: "pay.refund",
  connector: "pay",
  tags: ["moves_money"],
  inputSchema: { type: "object", properties: { amount: { type: "number" }, customer_id: { type: "string" }, order_id: { type: "string" } } },
});
const quoteTool = specFromJsonSchema({ name: "crm.send_quote", connector: "crm", tags: ["sends_external"], inputSchema: { type: "object", properties: { customer_id: { type: "string" }, quote_id: { type: "string" } } } });
const deleteTool = specFromJsonSchema({ name: "crm.delete_note", connector: "crm", tags: ["deletes"], inputSchema: { type: "object", properties: { amount: { type: "number" }, customer_id: { type: "string" } } } });
const registry = mergeRegistries(builtinRegistry, createRegistry([refundTool, quoteTool, deleteTool]));

function book(rules: Rule[]): Rulebook {
  const r = validateRulebook({ version: 3, agent: "ops-bot", owner: "o@x.in", default: "refuse", approvers: { ops: ["o@x.in"] }, rules }, registry);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.rulebook;
}

describe("unless: exceptions to an ask rule", () => {
  const rb = book([
    { id: "refund-ask", tool: "pay.refund", decide: "ask", approver: "ops", unless: { amount: { lte: 5000 }, customer_id: { in: ["c1"] } } },
    { id: "refund-ok", tool: "pay.refund", when: { amount: { lte: 5000 }, customer_id: { in: ["c1"] } }, decide: "allow" },
  ]);
  it("stands aside only when every condition holds", () => {
    expect(decide(rb, "pay.refund", { amount: 100, customer_id: "c1" }, { registry }).decision).toBe("allow");
    expect(decide(rb, "pay.refund", { amount: 100, customer_id: "c2" }, { registry }).decision).toBe("ask");
    expect(decide(rb, "pay.refund", { amount: 9000, customer_id: "c1" }, { registry }).decision).toBe("ask");
    // A missing value never satisfies an exception, so the ask still applies.
    expect(decide(rb, "pay.refund", { customer_id: "c1" }, { registry }).decision).toBe("ask");
  });
  it("records the values the exception looked at", () => {
    expect(decide(rb, "pay.refund", { amount: 100, customer_id: "c1", order_id: "o1" }, { registry }).argsSummary).toMatchObject({ amount: 100, customer_id: "c1" });
  });
  it("is only for ask rules, and needs a condition", () => {
    const base = { version: 1, agent: "a", owner: "o@x.in", default: "refuse", approvers: { ops: ["o@x.in"] } };
    const bad = (rule: Record<string, unknown>) => validateRulebook({ ...base, rules: [rule] }, registry);
    expect(bad({ id: "r", tool: "pay.refund", decide: "refuse", unless: { amount: { lte: 1 } } })).toMatchObject({ ok: false, errors: [expect.stringMatching(/only ask rules can have exceptions/)] });
    expect(bad({ id: "r", tool: "pay.refund", decide: "ask", approver: "ops", unless: {} })).toMatchObject({ ok: false, errors: [expect.stringMatching(/at least one condition/)] });
    expect(bad({ id: "r", tool: "zoho.record_bill_payment", decide: "ask", approver: "ops", unless: { colour: { eq: "red" } } }).ok).toBe(false);
  });
  it("round-trips through YAML and reads as a sentence", () => {
    const text = rulebookToYaml(rb);
    expect(text).toContain("unless: { amount: { lte: 5000 }, customer_id: { in: [ c1 ] } }");
    expect(parseRulebookYaml(text, registry)).toMatchObject({ ok: true });
    expect(describeRule(rb.rules[0]!)).toBe("Ask ops before: pay.refund, unless the amount is up to 5000 and customer id is one of c1");
  });
});

describe("mineSuggestions: the accounts-payable demo", () => {
  const rb = demo();
  const [s, ...rest] = mineSuggestions({ rulebook: rb, approvals: demoHistory(), now: NOW, tier: "high" });

  it("proposes raising the payment threshold to the largest always-approved amount", () => {
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ kind: "raise_limit", tool: "zoho.record_bill_payment", ruleId: "pay-large", confidence: "high" });
    expect(s!.title).toBe("Raise the no-approval limit for payments from ₹50,000 to ₹1,00,000");
    expect(s!.proposal).toBe("In the last 30 days people approved all 41 payments over ₹50,000 and up to ₹1,00,000, to 6 vendors (none rejected). Allow payments up to ₹1,00,000 without asking?");
    expect(s!.explanation).toMatch(/^Strong evidence: 41 approvals over 27 days, every one approved and none rejected, the latest yesterday\. 2 other requests from the same rule \(including 1 rejected and 1 that nobody answered in time\) would still wait/);
  });
  it("moves the line between the allow and ask rules and keeps the reason true", () => {
    const rules = Object.fromEntries(s!.rulebook.rules.map((r) => [r.id, r]));
    expect(rules["pay-small"]!.when).toEqual({ amount_inr: { lte: 100000 } });
    expect(rules["pay-large"]!.when).toEqual({ amount_inr: { gt: 100000 } });
    expect(rules["pay-large"]!.reason).toBe("Payments over ₹1,00,000 need someone in finance to approve them.");
    expect(rules["no-bank-change"]).toEqual(rb.rules.find((r) => r.id === "no-bank-change"));
    expect(s!.rulebook.rules).toHaveLength(rb.rules.length);
    expect(validateRulebook(s!.rulebook).ok).toBe(true);
  });
  it("reports the evidence and the time saved", () => {
    expect(s!.evidence).toMatchObject({ approved: 41, rejected: 1, expired: 1, covered: 41, stillAsked: 2, cap: 100000, previousCap: 50000, maxApproved: 100000, field: "amount_inr", lookbackDays: 30 });
    expect(s!.evidence.displayNames).toEqual([...VENDORS].sort());
    expect(s!.savings.approvalsPerMonth).toBe(44);
    expect(s!.savings.medianWaitMs).toBe(3 * 3_600_000);
    expect(s!.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Same evidence, same draft, same fingerprint.
    expect(mineSuggestions({ rulebook: rb, approvals: demoHistory(), now: NOW })[0]!.fingerprint).toBe(s!.fingerprint);
  });
  it("keeps the cap below a refuse threshold", () => {
    const rules = rb.rules.map((r) => r);
    rules.push({ id: "no-huge", tool: "zoho.record_bill_payment", when: { amount_inr: { gte: 90000 } }, decide: "refuse" });
    const [t] = mineSuggestions({ rulebook: { ...rb, rules }, approvals: demoHistory().map((a) => ({ ...a, summary: { ...a.summary, amount_inr: Math.min(a.summary.amount_inr as number, 89999) } })), now: NOW });
    expect(t!.evidence.cap).toBeLessThan(90000);
    expect(t!.evidence.cap).toBe(89000);
  });
  it("stays quiet without enough evidence", () => {
    const h = demoHistory();
    expect(mineSuggestions({ rulebook: rb, approvals: h.slice(0, 9), now: NOW })).toEqual([]); // too few
    expect(mineSuggestions({ rulebook: rb, approvals: h.map((a) => ({ ...a, createdAt: new Date(NOW.getTime() - DAY) })), now: NOW })).toEqual([]); // one day only
    expect(mineSuggestions({ rulebook: rb, approvals: h, now: new Date(NOW.getTime() + 20 * DAY), options: { lookbackDays: 60 } })).toEqual([]); // not recent
    expect(mineSuggestions({ rulebook: rb, approvals: h.map((a) => ({ ...a, status: "rejected" as const })), now: NOW })).toEqual([]);
    expect(mineSuggestions({ rulebook: rb, approvals: [], now: NOW })).toEqual([]);
  });
  it("stops the cap below the smallest rejected amount", () => {
    const h = demoHistory();
    h.push(past({ status: "rejected", summary: { bill_id: "z", amount_inr: 70000 } }, 3));
    const [t] = mineSuggestions({ rulebook: rb, approvals: h, now: NOW });
    expect(t!.evidence.cap).toBeLessThan(70000);
    expect(t!.evidence.covered).toBeLessThan(41);
  });
  it("ignores approvals the rule would no longer ask for", () => {
    const h = demoHistory().map((a) => ({ ...a, summary: { ...a.summary, amount_inr: 20000 } }));
    expect(mineSuggestions({ rulebook: rb, approvals: h, now: NOW })).toEqual([]);
  });
  it("a rejection filed under the rule's old name still blocks a draft that would allow it", () => {
    const h = demoHistory();
    h.push(past({ ruleId: "pay-large-old", status: "rejected", summary: { bill_id: "z", amount_inr: 60000 } }, 2));
    expect(mineSuggestions({ rulebook: rb, approvals: h, now: NOW })).toEqual([]);
  });
});

describe("mineSuggestions: other shapes", () => {
  const history = (tool: string, ruleId: string, make: (i: number) => Record<string, unknown>, count = 20) => Array.from({ length: count }, (_, i) => past({ tool, ruleId, summary: make(i) }, 1 + i * 0.6));

  it("narrows a lone ask rule and adds an allow rule just after it", () => {
    const rb = book([
      { id: "read", tool: "gmail.read_message", decide: "allow" },
      { id: "pay-ask", tool: "zoho.record_bill_payment", when: { amount_inr: { gte: 10000 } }, decide: "ask", approver: "ops" },
    ]);
    const [s] = mineSuggestions({ rulebook: rb, registry, approvals: history("zoho.record_bill_payment", "pay-ask", (i) => ({ bill_id: `b${i}`, amount_inr: 10000 + i * 1000 })), now: NOW });
    expect(s!.kind).toBe("allow_under_amount");
    expect(s!.rulebook.rules.map((r) => r.id)).toEqual(["read", "pay-ask", "pay-ask-allow"]);
    expect(s!.rulebook.rules[1]!.when).toEqual({ amount_inr: { gt: 29000 } });
    expect(s!.rulebook.rules[2]).toMatchObject({ decide: "allow", when: { amount_inr: { gte: 10000, lte: 29000 } } });
    expect(s!.title).toBe("Allow payments over ₹10,000 and up to ₹29,000 without asking");
    expect(s!.proposal).toMatch(/Make those automatic\?$/);
    expect(s!.confidence).toBe("medium");
  });

  it("uses an exception when the ask rule has no amount condition", () => {
    const rb = book([{ id: "refund-ask", tool: "pay.refund", decide: "ask", approver: "ops" }]);
    const h = history("pay.refund", "refund-ask", (i) => ({ amount: 100 + i * 10, order_id: `o${i}` }));
    h.push(past({ tool: "pay.refund", ruleId: "refund-ask", status: "rejected", summary: { amount: 9000, order_id: "x" } }, 2));
    const [s] = mineSuggestions({ rulebook: rb, registry, approvals: h, now: NOW });
    expect(s).toMatchObject({ kind: "allow_under_amount", title: "Allow “Refund” actions up to 290 without asking" });
    expect(s!.rulebook.rules[0]).toMatchObject({ id: "refund-ask", unless: { amount: { lte: 290 } } });
    expect(s!.rulebook.rules[1]).toMatchObject({ id: "refund-ask-allow", when: { amount: { lte: 290 } }, decide: "allow" });
  });

  it("lists known counterparties for tools that do not move money", () => {
    const rb = book([{ id: "quote-ask", tool: "crm.send_quote", decide: "ask", approver: "ops" }]);
    const h = history("crm.send_quote", "quote-ask", (i) => ({ customer_id: `c${i % 3}`, quote_id: `q${i}` }));
    h.push(past({ tool: "crm.send_quote", ruleId: "quote-ask", status: "rejected", summary: { customer_id: "c9", quote_id: "q" } }, 3));
    h.push(past({ tool: "crm.send_quote", ruleId: "quote-ask", summary: { customer_id: "c8", quote_id: "q" } }, 3)); // once only: not "known"
    const [s] = mineSuggestions({ rulebook: rb, registry, approvals: h, now: NOW });
    expect(s).toMatchObject({ kind: "allow_for_known_counterparties", evidence: { counterparties: ["c0", "c1", "c2"], counterpartyField: "customer_id", covered: 20 } });
    expect(s!.title).toBe("Allow “Send quote” actions to 3 known customers without asking");
    expect(s!.proposal).toContain("to these 3 customers (c0, c1 and c2)");
    expect(s!.rulebook.rules[0]!.unless).toEqual({ customer_id: { in: ["c0", "c1", "c2"] } });
  });

  it("combines a cap with known counterparties when money moves", () => {
    const rb = book([{ id: "refund-ask", tool: "pay.refund", decide: "ask", approver: "ops" }]);
    const h = history("pay.refund", "refund-ask", (i) => ({ amount: 1000 + i * 100, customer_id: `c${i % 4}` }), 24);
    // A small refund to a stranger was rejected: amount alone would cap at almost nothing.
    h.push(past({ tool: "pay.refund", ruleId: "refund-ask", status: "rejected", summary: { amount: 50, customer_id: "evil" } }, 2));
    const out = mineSuggestions({ rulebook: rb, registry, approvals: h, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "allow_combined", evidence: { cap: 3300, counterparties: ["c0", "c1", "c2", "c3"], covered: 24 } });
    expect(out[0]!.rulebook.rules[0]!.unless).toEqual({ customer_id: { in: ["c0", "c1", "c2", "c3"] }, amount: { lte: 3300 } });
    expect(out[0]!.title).toBe("Allow “Refund” actions up to 3,300 to 4 known customers without asking");
  });

  it("never touches deletes, tag rules, rules with exceptions or refuse rules", () => {
    const h = (tool: string, ruleId: string) => history(tool, ruleId, (i) => ({ amount: 100 + i, customer_id: `c${i % 2}` }));
    expect(mineSuggestions({ rulebook: book([{ id: "del", tool: "crm.delete_note", decide: "ask", approver: "ops" }]), registry, approvals: h("crm.delete_note", "del"), now: NOW })).toEqual([]);
    expect(mineSuggestions({ rulebook: book([{ id: "money", tag: "moves_money", decide: "ask", approver: "ops" }]), registry, approvals: h("pay.refund", "money"), now: NOW })).toEqual([]);
    expect(mineSuggestions({ rulebook: book([{ id: "r", tool: "pay.refund", decide: "ask", approver: "ops", unless: { amount: { lte: 1 } } }]), registry, approvals: h("pay.refund", "r"), now: NOW })).toEqual([]);
    expect(mineSuggestions({ rulebook: book([{ id: "r", tool: "pay.refund", decide: "refuse" }]), registry, approvals: h("pay.refund", "r"), now: NOW })).toEqual([]);
  });

  it("uses reply domains as counterparties", () => {
    const rb = book([{ id: "reply-ask", tool: "gmail.send_reply", decide: "ask", approver: "ops" }]);
    const [s] = mineSuggestions({ rulebook: rb, registry, approvals: history("gmail.send_reply", "reply-ask", (i) => ({ message_id: `m${i}`, to_domain: i % 2 ? "a.in" : "b.in" })), now: NOW });
    expect(s).toMatchObject({ kind: "allow_for_known_counterparties", evidence: { counterparties: ["a.in", "b.in"] } });
    expect(s!.rulebook.rules[0]!.unless).toEqual({ to_domain_in: ["a.in", "b.in"] });
    expect(decide(s!.rulebook, "gmail.send_reply", { message_id: "m", to: "x@a.in", body: "" }).decision).toBe("allow");
    expect(decide(s!.rulebook, "gmail.send_reply", { message_id: "m", to: "x@c.in", body: "" }).decision).toBe("ask");
  });
});

describe("helpers", () => {
  it("rebuilds replayable arguments from a summary", () => {
    expect(argsFromSummary({ to_domain: "a.in", fields: ["ifsc"] })).toEqual({ to_domain: "a.in", to: "someone@a.in", fields: { ifsc: "" } });
  });
  it("rounds caps to two significant figures", () => {
    expect([98750, 100000, 1234, 7, 0, -5].map(niceFloor)).toEqual([98000, 100000, 1200, 7, 0, -5]);
  });
  it("brings a dismissed suggestion back only when the evidence has at least doubled", () => {
    expect(evidenceGrewEnough(12, 23)).toBe(false);
    expect(evidenceGrewEnough(12, 24)).toBe(true);
    expect(evidenceGrewEnough(4, 9)).toBe(false);
    expect(evidenceGrewEnough(4, 14)).toBe(true);
  });
});

// ---- Safety properties ----

// Mostly approved, so drafts actually appear and the properties are exercised.
const status = fc.oneof({ arbitrary: fc.constant<PastApproval["status"]>("approved"), weight: 12 }, { arbitrary: fc.constantFrom<PastApproval["status"]>("rejected", "expired"), weight: 1 });

describe("safety properties", () => {
  const historyArb = fc.array(
    fc.record({ amount: fc.integer({ min: 50001, max: 400000 }), days: fc.double({ min: 0, max: 29.9, noNaN: true }), status, vendor: fc.integer({ min: 0, max: 7 }), wait: fc.integer({ min: 1, max: 48 }), big: fc.boolean() }),
    { minLength: 15, maxLength: 70, size: "max" },
  );

  it("a draft only allows what was in fact approved, and never what a refuse rule refuses", () => {
    let drafts = 0;
    fc.assert(
      fc.property(historyArb, fc.option(fc.integer({ min: 60000, max: 300000 })), fc.array(fc.integer({ min: 0, max: 500000 }), { minLength: 20, maxLength: 20 }), (h, refuseAt, probes) => {
        const rb = demo();
        if (refuseAt !== null) rb.rules.push({ id: "no-huge", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: refuseAt } }, decide: "refuse" });
        const approvals = h.map((x, i) => past({ status: x.status, summary: { bill_id: `b${i}`, amount_inr: x.status !== "approved" && x.big ? x.amount + 300000 : x.amount, vendor: VENDORS[x.vendor % 6] } }, x.days, x.wait));
        for (const s of mineSuggestions({ rulebook: rb, approvals, now: NOW, tier: "high" })) {
          drafts++;
          expect(validateRulebook(s.rulebook).ok).toBe(true);
          const maxApproved = Math.max(...approvals.filter((a) => a.status === "approved").map((a) => a.summary.amount_inr as number));
          expect(s.evidence.cap!).toBeLessThanOrEqual(maxApproved);
          if (refuseAt !== null) expect(s.evidence.cap!).toBeLessThan(refuseAt);
          for (const a of approvals) {
            const d1 = decide(s.rulebook, a.tool, argsFromSummary(a.summary));
            if (d1.decision === "allow") expect(a.status).toBe("approved");
          }
          for (const amount of probes) {
            const args = { bill_id: "p", amount_inr: amount };
            const d0 = decide(rb, "zoho.record_bill_payment", args);
            const d1 = decide(s.rulebook, "zoho.record_bill_payment", args);
            if (d0.decision === "refuse") expect(d1.decision).toBe("refuse");
            if (d1.decision !== d0.decision) expect([d0.decision, d1.decision]).toEqual(["ask", "allow"]);
          }
        }
      }),
      { numRuns: 150 },
    );
    expect(drafts).toBeGreaterThan(3); // the generators reach the miner; how often varies by seed
  });

  it("holds for exceptions with counterparties too", () => {
    let drafts = 0;
    fc.assert(
      fc.property(
        fc.array(fc.record({ amount: fc.integer({ min: 1, max: 12000 }), customer: fc.integer({ min: 0, max: 6 }), days: fc.double({ min: 0, max: 29.9, noNaN: true }), status, stranger: fc.boolean() }), { minLength: 15, maxLength: 60, size: "max" }),
        fc.integer({ min: 6000, max: 15000 }),
        fc.array(fc.record({ amount: fc.integer({ min: 0, max: 30000 }), customer: fc.integer({ min: 0, max: 8 }) }), { minLength: 20, maxLength: 20 }),
        (h, refuseAt, probes) => {
          const rb = book([
            { id: "refund-ask", tool: "pay.refund", decide: "ask", approver: "ops" },
            { id: "no-big", tool: "pay.refund", when: { amount: { gt: refuseAt } }, decide: "refuse" },
            { id: "no-c4", tool: "pay.refund", when: { customer_id: { eq: "c4" } }, decide: "refuse" },
          ]);
          const approvals = h.map((x, i) => past({ tool: "pay.refund", ruleId: "refund-ask", status: x.status, summary: { amount: x.amount, customer_id: `c${x.status !== "approved" && x.stranger ? 5 : x.customer % 5}`, order_id: `o${i}` } }, x.days));
          for (const s of mineSuggestions({ rulebook: rb, registry, approvals, now: NOW })) {
            drafts++;
            expect(s.rulebook.rules.filter((r) => r.decide === "refuse")).toEqual(rb.rules.filter((r) => r.decide === "refuse"));
            for (const a of approvals) if (decide(s.rulebook, a.tool, argsFromSummary(a.summary), { registry }).decision === "allow") expect(a.status).toBe("approved");
            for (const p of probes) {
              const args = { amount: p.amount, customer_id: `c${p.customer}` };
              const d0 = decide(rb, "pay.refund", args, { registry });
              const d1 = decide(s.rulebook, "pay.refund", args, { registry });
              if (d0.decision === "refuse") expect(d1.decision).toBe("refuse");
              if (d1.decision !== d0.decision) expect([d0.decision, d1.decision]).toEqual(["ask", "allow"]);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
    expect(drafts).toBeGreaterThan(3); // the generators reach the miner; how often varies by seed
  });
});
