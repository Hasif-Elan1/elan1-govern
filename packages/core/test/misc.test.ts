import { describe, expect, it } from "vitest";
import { describeAction, formatINR } from "../src/describe";
import { diffLines } from "../src/diff";
import { validateRulebook } from "../src/rulebook";
import { RISK_QUESTIONS, riskScore, riskTier, suggestRules, type RiskAnswers } from "../src/risk";
import { TOOLS, TOOL_ARGS, TOOL_NAMES, isKnownTool } from "../src/tools";
import { sampleRulebook } from "./fixtures";

describe("formatINR", () => {
  it.each([
    [0, "₹0"],
    [999, "₹999"],
    [18000, "₹18,000"],
    [200000, "₹2,00,000"],
    [12345678, "₹1,23,45,678"],
    [1234.5, "₹1,234.50"],
    [-50000, "-₹50,000"],
    [NaN, "₹—"],
  ])("%s -> %s", (n, s) => expect(formatINR(n)).toBe(s));
});

describe("describeAction", () => {
  it("writes plain sentences", () => {
    expect(describeAction("zoho.record_bill_payment", { vendor: "Sharma Traders", bill: "INV-2291", amount_inr: 200000 })).toBe(
      "Pay ₹2,00,000 to Sharma Traders for INV-2291",
    );
    expect(describeAction("zoho.record_bill_payment", {})).toBe("Pay an amount to a vendor");
    expect(describeAction("zoho.update_vendor", { vendor: "Sharma Traders", fields: ["bank_account", "ifsc"] })).toBe(
      "Change the bank account and IFSC for Sharma Traders",
    );
    expect(describeAction("zoho.update_vendor", { vendor_id: "v1", fields: ["x"] })).toBe("Change the x for vendor v1");
    expect(describeAction("zoho.update_vendor", { vendor_id: "v1" })).toBe("Update vendor v1");
    expect(describeAction("zoho.create_bill", { bill_number: "B1", amount_inr: 5, vendor: "V" })).toBe("Create bill B1 for ₹5 from V");
    expect(describeAction("zoho.list_bills", {})).toMatch(/List bills/);
    expect(describeAction("zoho.get_vendor", { vendor: "V" })).toBe("Look up V");
    expect(describeAction("gmail.search", {})).toBe("Search the mailbox");
    expect(describeAction("gmail.read_message", {})).toBe("Read an email");
    expect(describeAction("gmail.read_message", { subject: "Invoice" })).toBe("Read an email: Invoice");
    expect(describeAction("gmail.get_attachment", {})).toMatch(/attachment/);
    expect(describeAction("gmail.draft_reply", {})).toBe("Draft a reply");
    expect(describeAction("gmail.send_reply", { to_domain: "x.in" })).toBe("Send a reply to x.in");
    expect(describeAction("gmail.send_reply", {})).toBe("Send a reply");
    expect(describeAction("shell.exec", {})).toBe("Use an unknown tool “shell.exec”");
  });
});

describe("risk questionnaire", () => {
  const base: RiskAnswers = { money: "no", external: "no", personal: "no", amount: "small", oversight: "always" };
  it("has five questions", () => expect(RISK_QUESTIONS).toHaveLength(5));
  it("sets the tier", () => {
    expect(riskScore(base)).toBe(0);
    expect(riskTier(base)).toBe("low");
    expect(riskTier({ ...base, external: "yes", personal: "yes" })).toBe("medium");
    expect(riskTier({ ...base, money: "yes", amount: "medium", oversight: "sometimes", personal: "yes" })).toBe("high");
    expect(riskTier({ ...base, money: "yes", amount: "large" })).toBe("high");
  });
  it("suggests rules that validate and pass publish checks", () => {
    for (const answers of [base, { ...base, money: "yes" as const, external: "yes" as const, amount: "large" as const }]) {
      const tier = riskTier(answers);
      const rules = suggestRules(answers, tier);
      const rb = validateRulebook({ ...sampleRulebook(), rules });
      expect(rb.ok).toBe(true);
    }
    const high = suggestRules({ ...base, money: "yes", amount: "large" }, "high");
    expect(high.find((r) => r.id === "pay-small")?.when).toEqual({ amount_inr: { lte: 25000 } });
    expect(high.find((r) => r.id === "create-bills")?.decide).toBe("ask");
    expect(suggestRules(base, "low").some((r) => r.tool === "zoho.record_bill_payment")).toBe(false);
  });
});

describe("tools", () => {
  it("expose exactly the allowed tools", () => {
    expect(TOOL_NAMES.sort()).toEqual(
      [
        "gmail.draft_reply",
        "gmail.get_attachment",
        "gmail.read_message",
        "gmail.search",
        "gmail.send_reply",
        "zoho.create_bill",
        "zoho.get_vendor",
        "zoho.list_bills",
        "zoho.record_bill_payment",
        "zoho.update_vendor",
      ].sort(),
    );
    expect(Object.keys(TOOLS).sort()).toEqual(TOOL_NAMES.sort());
    expect(isKnownTool("gmail.delete")).toBe(false);
    expect(isKnownTool("toString")).toBe(false);
  });
  it("validate arguments strictly", () => {
    expect(TOOL_ARGS["zoho.record_bill_payment"].safeParse({ bill_id: "b", amount_inr: -1 }).success).toBe(false);
    expect(TOOL_ARGS["zoho.update_vendor"].safeParse({ vendor_id: "v", fields: { password: "x" } }).success).toBe(false);
    expect(TOOL_ARGS["gmail.send_reply"].safeParse({ message_id: "m", to: "not-an-email", body: "" }).success).toBe(false);
  });
});

describe("diffLines", () => {
  it("marks adds and removes", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { type: "same", text: "a" },
      { type: "remove", text: "b" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
    expect(diffLines("x", "y")).toEqual([
      { type: "remove", text: "x" },
      { type: "add", text: "y" },
    ]);
    expect(diffLines("a\nb", "a")).toEqual([
      { type: "same", text: "a" },
      { type: "remove", text: "b" },
    ]);
  });
});
