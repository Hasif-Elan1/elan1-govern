import { describe, expect, it } from "vitest";
import {
  durationMs,
  loadSignedRulebook,
  parseRulebookYaml,
  publishProblems,
  rulebookHash,
  rulebookToYaml,
  signRulebook,
  validateRulebook,
  verifyRulebook,
  type Rulebook,
} from "../src/rulebook";
import { KEYS, OTHER_KEYS, SAMPLE_YAML, sampleRulebook } from "./fixtures";

function withRules(rules: unknown[], extra: Record<string, unknown> = {}) {
  return validateRulebook({ ...sampleRulebook(), rules, ...extra });
}

describe("parsing", () => {
  it("parses the documented example", () => {
    const rb = sampleRulebook();
    expect(rb.version).toBe(7);
    expect(rb.rules).toHaveLength(5);
    expect(rb.approvers.finance).toEqual(["priya@acme.in", "ca@sharma-ca.in"]);
  });
  it("round-trips through YAML", () => {
    const rb = sampleRulebook();
    const again = parseRulebookYaml(rulebookToYaml(rb));
    expect(again.ok && again.rulebook).toEqual(rb);
    expect(rulebookToYaml(rb)).toContain("when: { amount_inr: { lte: 50000 } }");
    expect(rulebookToYaml(rb)).toContain("finance: [ priya@acme.in, ca@sharma-ca.in ]");
  });
  it("omits empty approvers when serialising", () => {
    const rb: Rulebook = { ...sampleRulebook(), approvers: {}, rules: [{ id: "r", tool: "gmail.search", decide: "allow" }] };
    expect(rulebookToYaml(rb)).not.toContain("approvers");
  });
  it("reports YAML syntax errors, duplicate keys and aliases", () => {
    expect(parseRulebookYaml("a: [").ok).toBe(false);
    const dup = parseRulebookYaml("version: 1\nversion: 2\n");
    expect(!dup.ok && dup.errors[0]).toMatch(/YAML/);
    expect(parseRulebookYaml("a: &x 1\nb: *x\n").ok).toBe(false);
    expect(parseRulebookYaml("x".repeat(200_001)).ok).toBe(false);
  });
  it("requires default: refuse", () => {
    const r = parseRulebookYaml(SAMPLE_YAML.replace("default: refuse", "default: allow"));
    expect(!r.ok && r.errors.join()).toMatch(/default must be refuse/);
  });
  it("rejects unknown keys (no custom code)", () => {
    expect(validateRulebook({ ...sampleRulebook(), script: "rm -rf" }).ok).toBe(false);
    expect(withRules([{ id: "a", tool: "gmail.search", decide: "allow", eval: "1" }]).ok).toBe(false);
  });
});

describe("rule validation", () => {
  const err = (rules: unknown[], extra?: Record<string, unknown>) => {
    const r = withRules(rules, extra);
    return r.ok ? "" : r.errors.join("\n");
  };
  it("catches duplicate ids and unknown tools", () => {
    expect(err([{ id: "a", tool: "gmail.search", decide: "allow" }, { id: "a", tool: "gmail.search", decide: "allow" }])).toMatch(/duplicate rule id/);
    expect(err([{ id: "a", tool: "gmail.delete", decide: "allow" }])).toMatch(/unknown tool/);
  });
  it("checks approver wiring", () => {
    expect(err([{ id: "a", tool: "gmail.search", decide: "ask" }])).toMatch(/needs an approver/);
    expect(err([{ id: "a", tool: "gmail.search", decide: "ask", approver: "legal" }])).toMatch(/not defined/);
    expect(err([{ id: "a", tool: "gmail.search", decide: "allow", approver: "finance" }])).toMatch(/only ask rules take/);
    expect(err([{ id: "a", tool: "gmail.search", decide: "refuse", expires_in: "1h" }])).toMatch(/only ask rules can expire/);
    expect(err([{ id: "a", tool: "gmail.search", decide: "ask", approver: "finance", expires_in: "31d" }])).toMatch(/at most 30 days/);
    expect(err([{ id: "a", tool: "gmail.search", decide: "ask", approver: "finance", expires_in: "1w" }])).toMatch(/duration/);
  });
  it("checks conditions against the tool", () => {
    expect(err([{ id: "a", tool: "gmail.search", when: { to_domain_in: ["x.in"] }, decide: "allow" }])).toMatch(/no recipient/);
    expect(err([{ id: "a", tool: "gmail.send_reply", when: { to_domain_in: "nope" }, decide: "allow" }])).toMatch(/list "nope"/);
    expect(err([{ id: "a", tool: "gmail.send_reply", when: { to_domain_in: 5 }, decide: "allow" }])).toMatch(/list name or a list/);
    expect(err([{ id: "a", tool: "gmail.search", when: { fields_include: ["ifsc"] }, decide: "allow" }])).toMatch(/no fields/);
    expect(err([{ id: "a", tool: "zoho.update_vendor", when: { fields_include: ["password"] }, decide: "allow" }])).toMatch(/fields_include takes/);
    expect(err([{ id: "a", tool: "zoho.record_bill_payment", when: { amount: { lt: 1 } }, decide: "allow" }])).toMatch(/no field "amount"/);
    expect(err([{ id: "a", tool: "zoho.record_bill_payment", when: { amount_inr: {} }, decide: "allow" }])).toMatch(/at least one operator/);
    expect(err([{ id: "a", tool: "zoho.record_bill_payment", when: { amount_inr: { lt: "5" } }, decide: "allow" }])).not.toBe("");
  });
  it("accepts list names from the rulebook and from context", () => {
    expect(err([{ id: "a", tool: "gmail.send_reply", when: { to_domain_in: "partners" }, decide: "allow" }], { lists: { partners: ["x.in"] } })).toBe("");
    expect(err([{ id: "a", tool: "gmail.send_reply", when: { to_domain_in: "vendor_domains" }, decide: "allow" }])).toBe("");
  });
  it("parses durations", () => {
    expect(durationMs("30m")).toBe(1_800_000);
    expect(durationMs("24h")).toBe(86_400_000);
    expect(durationMs("2d")).toBe(172_800_000);
    expect(() => durationMs("soon")).toThrow();
  });
});

describe("signatures", () => {
  it("signs over everything except the signature", () => {
    const rb = signRulebook(sampleRulebook(), KEYS.privateKeyPem);
    expect(verifyRulebook(rb, KEYS.publicKeyPem)).toBe(true);
    expect(verifyRulebook(rb, OTHER_KEYS.publicKeyPem)).toBe(false);
    expect(verifyRulebook({ ...rb, version: 8 }, KEYS.publicKeyPem)).toBe(false);
    expect(verifyRulebook(sampleRulebook(), KEYS.publicKeyPem)).toBe(false);
    expect(rulebookHash(rb)).toBe(rulebookHash(sampleRulebook()));
  });
  it("loads only signed, valid rulebooks", () => {
    const signed = rulebookToYaml(signRulebook(sampleRulebook(), KEYS.privateKeyPem));
    const ok = loadSignedRulebook(signed, KEYS.publicKeyPem);
    expect(ok.ok).toBe(true);
    const unsigned = loadSignedRulebook(SAMPLE_YAML, KEYS.publicKeyPem);
    expect(!unsigned.ok && unsigned.reason).toBe("rulebook is not signed");
    const wrongKey = loadSignedRulebook(signed, OTHER_KEYS.publicKeyPem);
    expect(!wrongKey.ok && wrongKey.reason).toMatch(/does not match/);
    const tampered = loadSignedRulebook(signed.replace("lte: 50000", "lte: 5000000"), KEYS.publicKeyPem);
    expect(tampered.ok).toBe(false);
    const invalid = loadSignedRulebook("version: x", KEYS.publicKeyPem);
    expect(!invalid.ok && invalid.reason).toMatch(/invalid rulebook/);
  });
});

describe("publish checks", () => {
  it("high-risk agents need an ask rule for money-moving tools", () => {
    const rb = sampleRulebook();
    expect(publishProblems(rb, "high")).toEqual([]);
    const allowOnly = { ...rb, rules: rb.rules.filter((r) => r.id !== "pay-large") };
    expect(publishProblems(allowOnly, "high")[0]).toMatch(/at least one "Ask" rule/);
    expect(publishProblems(allowOnly, "medium")).toEqual([]);
    const none = { ...rb, rules: rb.rules.filter((r) => r.tool !== "zoho.record_bill_payment") };
    expect(publishProblems(none, "high")).toEqual([]);
  });
});
