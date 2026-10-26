import { generateKeyPair } from "../src/crypto";
import { parseRulebookYaml, type Rulebook } from "../src/rulebook";

export const SAMPLE_YAML = `version: 7
agent: ap-bot
owner: priya@acme.in
default: refuse
approvers:
  finance: [priya@acme.in, ca@sharma-ca.in]
limits:
  daily_payments_inr: 500000
rules:
  - id: read-mail
    tool: gmail.read_message
    decide: allow
  - id: reply-vendor
    tool: gmail.send_reply
    when: { to_domain_in: vendor_domains }
    decide: ask
    approver: finance
  - id: pay-small
    tool: zoho.record_bill_payment
    when: { amount_inr: { lte: 50000 } }
    decide: allow
  - id: pay-large
    tool: zoho.record_bill_payment
    when: { amount_inr: { gt: 50000 } }
    decide: ask
    approver: finance
    expires_in: 24h
  - id: no-bank-change
    tool: zoho.update_vendor
    when: { fields_include: [bank_account, ifsc] }
    decide: refuse
`;

export function sampleRulebook(): Rulebook {
  const r = parseRulebookYaml(SAMPLE_YAML);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.rulebook;
}

export const KEYS = generateKeyPair();
export const OTHER_KEYS = generateKeyPair();
