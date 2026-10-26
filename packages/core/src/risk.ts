import type { RiskTier, Rule } from "./rulebook";

export const RISK_QUESTIONS = [
  { id: "money", text: "Can this agent record or make payments?", options: [["no", "No"], ["yes", "Yes"]] },
  { id: "external", text: "Can it send email to people outside your company?", options: [["no", "No"], ["yes", "Yes"]] },
  { id: "personal", text: "Will it see personal details, such as PAN, phone numbers or bank accounts?", options: [["no", "No"], ["yes", "Yes"]] },
  { id: "amount", text: "What is the largest single amount it could touch?", options: [["small", "Under ₹50,000"], ["medium", "₹50,000 to ₹5,00,000"], ["large", "More than ₹5,00,000"]] },
  { id: "oversight", text: "Does someone check its work today?", options: [["always", "Every action"], ["sometimes", "Now and then"], ["never", "No"]] },
] as const;

export type RiskAnswers = {
  money: "no" | "yes";
  external: "no" | "yes";
  personal: "no" | "yes";
  amount: "small" | "medium" | "large";
  oversight: "always" | "sometimes" | "never";
};

export function riskScore(a: RiskAnswers): number {
  return (
    (a.money === "yes" ? 2 : 0) +
    (a.external === "yes" ? 1 : 0) +
    (a.personal === "yes" ? 1 : 0) +
    { small: 0, medium: 1, large: 2 }[a.amount] +
    { always: 0, sometimes: 1, never: 2 }[a.oversight]
  );
}

export function riskTier(a: RiskAnswers): RiskTier {
  if (a.money === "yes" && a.amount === "large") return "high";
  const score = riskScore(a);
  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

const SMALL_PAYMENT: Record<RiskTier, number> = { low: 100000, medium: 50000, high: 25000 };

/** Starter rules the wizard proposes. The user can change all of them before publishing. */
export function suggestRules(a: RiskAnswers, tier: RiskTier): Rule[] {
  const rules: Rule[] = [
    { id: "read-mail", tool: "gmail.read_message", decide: "allow" },
    { id: "search-mail", tool: "gmail.search", decide: "allow" },
    { id: "open-attachments", tool: "gmail.get_attachment", decide: "allow" },
    { id: "list-bills", tool: "zoho.list_bills", decide: "allow" },
    { id: "look-up-vendor", tool: "zoho.get_vendor", decide: "allow" },
    { id: "draft-replies", tool: "gmail.draft_reply", decide: "allow" },
  ];
  if (a.external === "yes") {
    rules.push({ id: "reply-vendor", tool: "gmail.send_reply", when: { to_domain_in: "vendor_domains" }, decide: "ask", approver: "finance" });
  }
  rules.push({ id: "create-bills", tool: "zoho.create_bill", decide: tier === "high" ? "ask" : "allow", ...(tier === "high" ? { approver: "finance" } : {}) });
  if (a.money === "yes") {
    const limit = SMALL_PAYMENT[tier];
    rules.push(
      { id: "pay-small", tool: "zoho.record_bill_payment", when: { amount_inr: { lte: limit } }, decide: "allow" },
      { id: "pay-large", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: limit } }, decide: "ask", approver: "finance", expires_in: "24h" },
    );
  }
  rules.push({ id: "no-bank-change", tool: "zoho.update_vendor", when: { fields_include: ["bank_account", "ifsc"] }, decide: "refuse" });
  return rules;
}
