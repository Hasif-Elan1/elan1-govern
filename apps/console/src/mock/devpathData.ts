/**
 * The developer path — reference catalogues the developer portal and the console share.
 *
 *  - the refusal-code register (47 core codes: 17 POLICY, 20 GATE, 10 PLATFORM; 30 from L1, 17 from L2; plus 5 at L3),
 *  - the built-in MCP tool catalogue (34 tools: 18 read, 10 stage, 6 act),
 *  - the conformance suite C1–C14 and the Action Receipt conformance levels CL-1 … CL-D,
 *  - the glossary, the support tiers and the offline-verifier releases.
 *
 * Wire spellings (GATE.*, POLICY.*, PLATFORM.*) are protocol identifiers and stay as written; prose never calls a
 * pre-write check a "gate".
 */
import type { LevelId } from '@/types';

/* ══ Refusal-code register ═══════════════════════════════════════════════ */

export type RefusalFamily = 'POLICY' | 'GATE' | 'PLATFORM';

/** Where on the decision path a code is raised. */
export const RUNGS: Record<string, { n: string; name: string; what: string }> = {
  stop: { n: '0b', name: 'Stop', what: 'An emergency stop, a pause or a hard limit on the whole organisation.' },
  identity: { n: '1', name: 'Identity', what: 'Who is acting, from the key; delegation never confers autonomy.' },
  door: { n: '2', name: 'Write door', what: 'The rulebook or declaration in force, at an explicit version; the write type and the channel.' },
  checks: { n: '3', name: 'Pre-write checks', what: 'Consent, residency, retention, dual control, rate, budget, counterparty, schedule and precondition, in declared order.' },
  rules: { n: '4', name: 'Rules', what: 'Your versioned rules over the declared fields. No model sits here: allow, ask a person, or refuse.' },
  guardrail: { n: '5', name: 'Guardrail', what: 'Allow-lists and blast radius: one record, one counterparty, a batch, the tenant, across a boundary.' },
  autonomy: { n: '6', name: 'Autonomy and approval', what: 'The agent’s grant for this write; approvals and their expiry.' },
  act: { n: '7', name: 'Act', what: 'Governed run only: the call is run with a short-lived credential Elan1 Govern holds.' },
  record: { n: '8', name: 'Record', what: 'The receipt is written to the chain. If it cannot be written, nothing is said to have happened.' },
  receipt: { n: 'R', name: 'Receiving a receipt', what: 'L3: checking an Action Receipt another organisation sent you.' },
  define: { n: 'D', name: 'Define', what: 'Before any call: a rulebook or declaration version is validated, numbered and certified before it can be put in force. No step can be skipped.' },
};

export interface RefusalCode {
  /** permanent number, REF-01 … REF-52. Numbers are never reused or renumbered, so the list is grouped by family, not by number. */
  ref: string;
  /** dotted wire spelling, e.g. GATE.PRECONDITION_FAILED */
  wire: string;
  family: RefusalFamily;
  rung: keyof typeof RUNGS;
  activeFrom: LevelId;
  /** a short title in plain words */
  title: string;
  means: string;
  /** what the operator (the person who owns the agent) does about it */
  action: string;
  /** the system refusal id the console shows today, when one maps to this code */
  builtId?: string;
  /** an example reason, as the response carries it */
  example: string;
  /** in the core register (false only for the 5 L3 codes raised when receiving an Action Receipt) */
  core: boolean;
}

/** Core unless raised when receiving an Action Receipt from another organisation (rung 'receipt', L3). */
const isCore = (rung: keyof typeof RUNGS) => rung !== 'receipt';
const P = (ref: number, name: string, rung: keyof typeof RUNGS, activeFrom: LevelId, title: string, means: string, action: string, example: string, builtId?: string): RefusalCode =>
  ({ ref: `REF-${String(ref).padStart(2, '0')}`, wire: `POLICY.${name}`, family: 'POLICY', rung, activeFrom, title, means, action, example, builtId, core: isCore(rung) });
const G = (ref: number, name: string, rung: keyof typeof RUNGS, activeFrom: LevelId, title: string, means: string, action: string, example: string, builtId?: string): RefusalCode =>
  ({ ref: `REF-${String(ref).padStart(2, '0')}`, wire: `GATE.${name}`, family: 'GATE', rung, activeFrom, title, means, action, example, builtId, core: isCore(rung) });
const F = (ref: number, name: string, rung: keyof typeof RUNGS, activeFrom: LevelId, title: string, means: string, action: string, example: string, builtId?: string): RefusalCode =>
  ({ ref: `REF-${String(ref).padStart(2, '0')}`, wire: `PLATFORM.${name}`, family: 'PLATFORM', rung, activeFrom, title, means, action, example, builtId, core: isCore(rung) });

export const REFUSAL_CODES: RefusalCode[] = [
  // POLICY — 17 (10 from L1, 7 from L2): 14 on the decision path, and 3 raised at define (REF-50 … REF-52)
  P(1, 'TENANT_STOPPED', 'stop', 'l1', 'The organisation is stopped', 'An emergency stop, the pilot’s hard stop, or a regulator directive covers this organisation. Nothing runs until it is lifted. (A sandbox key over its limit is GATE.SANDBOX_LIMIT_REACHED.)', 'An emergency stop: find it in the Work door, under Incidents, and lift it there once the cause is dealt with. The pilot’s hard stop: an owner moves the organisation to the paid plan on the Meter page (Assurance › Meter); the refusal itself writes no record. A regulator directive: lifted only when the directive is withdrawn.', 'Emergency stop engaged by Ananya Rao: suspected duplicate vendor payments.', 'agent-paused'),
  P(2, 'AGENT_PAUSED', 'stop', 'l1', 'The agent is paused', 'This agent was paused by its owner or by auto-pause on a high-severity alert. Other agents are not affected.', 'Read why it was paused on the agent page, then resume it there.', 'Agent paused by its owner pending the impact assessment.', 'agent-paused'),
  P(3, 'ACTOR_NOT_PERMITTED', 'identity', 'l1', 'This agent may not make this kind of write', 'The key identifies an agent whose kind is not granted this write type in the rulebook in force.', 'Grant it in a new rulebook version, or make the call as an agent that is permitted.', 'invoice-bot is not granted vendor.update_bank_details.'),
  P(4, 'DELEGATION_INVALID', 'identity', 'l2', 'Acting for someone who has not delegated', 'The call says it acts on behalf of a person whose delegation is missing, expired or revoked.', 'Ask the person to renew the delegation, then send the call again.', 'Delegation from u_fatima expired on 2026-10-20.'),
  P(5, 'WRITE_TYPE_UNKNOWN', 'door', 'l1', 'The tool or write type is not declared', 'The tool is not in the agent’s rulebook or not known to Elan1 Govern. Anything not declared is refused. (A known tool switched off on its connector is GATE.TOOL_DISABLED.)', 'Declare the tool in a new rulebook version, or stop calling it.', 'bank.initiate_transfer is not a tool this agent has.', 'default'),
  P(6, 'CHANNEL_NOT_PERMITTED', 'door', 'l2', 'Not through this channel', 'The write type is declared, but not for the channel the call came through (for example REST rather than MCP).', 'Send it through a channel the declaration permits.', 'payment_entry.submit is declared for mcp only; this call came through rest.'),
  P(7, 'DECLARATION_UNRESOLVED', 'door', 'l1', 'No rulebook in force, or it does not verify', 'There is no published rulebook version, or the version in force does not verify: its hash, and from L2 its signature against the organisation’s key.', 'Publish a version (with dual control from L2). If the hash or signature fails, open an incident: the rulebook may have been altered.', 'No published rulebook version. Every call is refused until a version is published.', 'no-rulebook'),
  P(8, 'ARGUMENTS_INVALID', 'door', 'l1', 'The arguments do not match the tool', 'The arguments do not match the tool’s schema: a missing field, a wrong type, an amount that is not a number.', 'Fix the call. Nothing about the rules changed.', 'amount must be a number; got "forty thousand".', 'invalid-arguments'),
  P(9, 'DENIED_BY_RULE', 'rules', 'l1', 'A rule refused it', 'One of your rules matched and its decision is refuse. The response names the rule and its reason.', 'Change the request, or change the rule in a new rulebook version if the rule is wrong.', 'Rule no-delete: Deleting a bill is never done by an agent.'),
  P(10, 'NO_RULE_MATCHED', 'rules', 'l1', 'No rule allows it', 'No rule covers this call, so the default applies. The default is always refuse.', 'Write a rule for it. Never widen the default.', 'No rule allows this call. Anything not explicitly allowed is refused.', 'default'),
  P(11, 'BLAST_RADIUS_EXCEEDED', 'guardrail', 'l2', 'It reaches further than declared', 'The write would touch more than its declared radius allows (one record, one counterparty, a batch, the tenant).', 'Narrow the call, or raise the radius in a new version, which then needs dual control.', 'Declared one_counterparty; this batch touches 14 counterparties.'),
  P(12, 'AUTONOMY_INSUFFICIENT', 'autonomy', 'l2', 'The agent’s autonomy is too low', 'The write needs more autonomy than the agent holds for it, and it cannot be routed to a person.', 'Route it to approval, or graduate the agent through the two-person process (L3).', 'Write needs A3; the grant is A1 Draft.'),
  P(13, 'APPROVAL_DECLINED', 'autonomy', 'l1', 'A person rejected it', 'The call was held for a person, and they rejected it. Their reason is on the approval receipt.', 'Read the reason. Address it and make a new call; never resend the same one.', 'Rejected by Venkat Iyer: the bill is a duplicate of BILL-2026-0412.', 'rejected'),
  P(14, 'OBLIGATION_EXPIRED', 'autonomy', 'l1', 'Nobody decided in time', 'The call was held for a person and the approval expired (24 hours unless the rule says otherwise). Its arguments were wiped.', 'Make the call again if it is still needed, and check who the rule names as approver.', 'Approval apr_9f2k1c expired after 24 h. Arguments wiped.', 'expired'),
  // Raised at define, when a version is checked before it can be put in force (Technology Memorandum §4.19)
  P(50, 'DECLARATION_INVALID', 'define', 'l2', 'The rulebook or declaration does not validate', 'A version put forward for publishing fails validation: the YAML does not parse, a rule names something that is not declared, or a field is blank. Every field needs a value, out_of_scope or not_measurable — never a blank.', 'Fix what the check lists and put the version forward again. The version in force does not change.', 'write_types[2] has no reversal_plan and is not marked irreversible.'),
  P(51, 'VERSION_NOT_SEQUENTIAL', 'define', 'l2', 'The version number is out of order', 'A version was put forward with a number that does not follow the latest one. Versions are numbered one after another, with no gaps and no reuse.', 'Start from the latest version and put the change forward as the next number.', 'Version 9 was put forward; the latest is version 7, so the next must be 8.'),
  P(52, 'NOT_CERTIFIED', 'define', 'l2', 'The version has not been certified', 'A version was put forward to be in force before it had been validated, simulated and certified. None of these steps can be skipped.', 'Run the simulation, have a second person certify the version, then publish it.', 'Version 8 was simulated but has not been certified.'),
  // GATE — 20 (13 from L1, 7 from L2). The consent check (G1) runs from L1, once the organisation keeps a consent ledger.
  G(15, 'CONSENT_MISSING', 'checks', 'l1', 'No consent for this purpose', 'The person the write is about has not consented to this purpose, or has consented only on another channel (system rule ids G1_NO_CONSENT and G1_CHANNEL).', 'Capture consent through your own process, then send the call again.', 'No consent on record for purpose collections_contact.', 'G1_NO_CONSENT'),
  G(16, 'CONSENT_EXPIRED', 'checks', 'l1', 'Consent has lapsed', 'Consent existed but has expired or was withdrawn (system rule ids G1_EXPIRED and G1_WITHDRAWN).', 'Capture it again. Do not reuse the old consent.', 'Consent for marketing_contact withdrawn on 2026-10-02.', 'G1_EXPIRED'),
  G(17, 'RESIDENCY_MISMATCH', 'checks', 'l1', 'The data would leave its residency domain', 'The write would put data outside the organisation’s residency domain (ap-south-1 Mumbai, or your own data centre).', 'Never override. Follow the residency runbook; change the target, not the check.', 'Target eu-west-1 is outside the residency domain ap-south-1 Mumbai.'),
  G(18, 'RETENTION_WINDOW_CLOSED', 'checks', 'l2', 'Outside the retention window', 'The record the write touches is past its retention window.', 'Do not write. The record should be archived or erased, not changed.', 'Invoice INV-2019-0042 is past its 7-year retention window.'),
  G(19, 'DUAL_CONTROL_PENDING', 'checks', 'l1', 'A second person has not approved yet', 'The write needs two named people and only one has approved.', 'Ask the second approver. The call stays held until they decide or it expires.', 'Payments over ₹2,00,000 need a second approver; 1 of 2 so far.'),
  G(20, 'DUAL_CONTROL_SAME_ACTOR', 'checks', 'l1', 'The approver is the requester', 'The person who approved is the same person who asked. Dual control needs two different people.', 'Find a second named person.', 'u_venkat requested and approved the same payment.'),
  G(21, 'RATE_EXCEEDED', 'checks', 'l1', 'Too many writes too quickly', 'The agent is over its declared rate for this write type.', 'Wait, or raise the rate in a new rulebook version.', 'More than 20 payments in 10 minutes for this agent.'),
  G(22, 'BUDGET_EXHAUSTED', 'checks', 'l1', 'The budget for the period is used up', 'The write would take the agent over its budget for the period.', 'Raise the budget in a new version, or wait for the next period. Never split the write to fit.', 'Daily payment budget ₹10,00,000 used: ₹9,62,000 so far.'),
  G(23, 'COUNTERPARTY_SANCTIONED', 'checks', 'l2', 'The counterparty is on a sanctions list', 'The counterparty matches a sanctions list the organisation screens against.', 'Never override. Escalate to compliance.', 'Counterparty matches a consolidated sanctions list entry.'),
  G(49, 'COUNTERPARTY_UNKNOWN', 'checks', 'l2', 'The counterparty is not registered', 'The payee, recipient or organisation the write is for is not in your counterparty register. (When receiving an Action Receipt at L3, the same code is raised for an issuer you have not registered.)', 'Register the counterparty in the Assurance door, under Counterparties, then send the call again.', 'Payee vendor_7781 is not a registered counterparty.'),
  G(24, 'OUTSIDE_SCHEDULE', 'checks', 'l2', 'Outside the operating window', 'The write type is only allowed in a declared window, for example collections calls 08:00–19:00 IST.', 'Wait for the window, or change it in a new version.', 'collections contact attempted at 19:42 IST; window is 08:00–19:00.'),
  G(25, 'PRECONDITION_FAILED', 'checks', 'l1', 'The record is not in the state the write needs', 'A declared precondition does not hold, for example the invoice is over the customer’s credit limit.', 'Fix the record’s state, then send the call again.', 'Sales invoice ₹4,20,000 exceeds the credit limit of ₹3,00,000.'),
  G(26, 'SANDBOX_DIVERGED', 'act', 'l2', 'The dry run and the live run disagreed', 'Governed run: the write produced different bytes in the shadow run than it would live. The snapshot was restored and nothing was applied.', 'Investigate the target system. Do not retry until the difference is understood.', 'Shadow run produced a different journal total (₹1,240 difference).'),
  G(27, 'TOOL_DISABLED', 'checks', 'l1', 'The tool is switched off', 'The tool exists but is switched off on its connector. New tools from your own MCP servers start switched off.', 'Switch it on in the Records door, under Connectors, once its risk tags are confirmed.', 'zoho_books.delete_bill is switched off on its connector.', 'tool-disabled'),
  G(28, 'QUOTA_EXCEEDED', 'checks', 'l1', 'A quota is used up and nobody can approve', 'A count or sum quota is used up and the rule names no approver group, so the call cannot be held for a person.', 'Name an approver group on the rule, or raise the quota in a new version.', 'max_count 50 per day used: 50 of 50.'),
  G(29, 'SANDBOX_LIMIT_REACHED', 'checks', 'l1', 'The sandbox limit is reached', 'A sandbox key (sk_sbx_) is over 10 writes a minute, 2 at once, or 5,000 a month. The refusal is recorded on a sandbox receipt; sandbox calls are never billed.', 'Wait for the calls in flight to finish, for the minute or for the month to pass, or ask for a production key.', 'Sandbox hard stop: 5,000 calls this month.', 'sandbox-limit'),
  G(30, 'ERASED_SUBJECT', 'checks', 'l1', 'The person was erased', 'The write is about a person whose personal data was erased under DPDP. Their salts were destroyed; the write would re-identify them.', 'Do not write. If the person has come back, record them as a new subject.', 'Subject cust_8812 was erased on 2026-09-30.'),
  G(31, 'PAYLOAD_TOO_LARGE', 'checks', 'l1', 'The arguments are too large', 'The arguments are over 256 KB. Large documents are referenced, not sent.', 'Send a reference (an id or a hash) instead of the document.', 'Arguments are 1.2 MB; the limit is 256 KB.'),
  G(32, 'REVERSAL_WINDOW_CLOSED', 'checks', 'l2', 'Too late to reverse', 'A reversal was asked for after the declared reversal window (30 days by default).', 'Make a correcting write instead, recorded as its own action.', 'Payment proof #4,097 is outside its 30-day reversal window.'),
  G(33, 'IRREVERSIBLE_UNDECLARED', 'checks', 'l2', 'No reversal plan and not declared irreversible', 'The write type has neither a reversal plan nor an explicit irreversible flag.', 'Add one of the two to the declaration. A blank is never accepted.', 'customer.update has no reversal_plan and no irreversible flag.'),
  // PLATFORM — 10 (7 from L1, 3 from L2). We failed: never billed, always pages on-call.
  F(34, 'REGISTRY_UNAVAILABLE', 'door', 'l1', 'We could not read the rulebook registry', 'Elan1 Govern could not load the rulebook or declaration. Nothing ran.', 'Retry the same intent with backoff. We have been paged.', 'Registry read timed out after 2 s.'),
  F(35, 'POLICY_UNAVAILABLE', 'rules', 'l1', 'We could not evaluate the rules', 'The rule engine did not answer. Elan1 Govern never defaults to allow.', 'Retry the same intent with backoff. We have been paged.', 'Rule evaluation did not complete.'),
  F(36, 'TARGET_UNREACHABLE', 'act', 'l1', 'The target system did not answer', 'Governed run: the system the call writes to could not be reached. Nothing was applied.', 'Retry the same intent once the target is back. We have been paged.', 'zoho_books did not answer within 10 s.'),
  F(37, 'TOKEN_MINT_FAILED', 'act', 'l2', 'We could not mint the short-lived credential', 'Governed run: the 10-minute credential for the target could not be issued. Nothing was applied.', 'Retry the same intent. We have been paged.', 'Credential mint for con_zoho failed.'),
  F(38, 'WRITER_LOCK_LOST', 'act', 'l2', 'The single writer lost its lock', 'Governed run: the single-writer lock on the target was lost mid-write. The snapshot was restored.', 'Retry the same intent. We have been paged.', 'Writer lock on erp.ar lost after 1.4 s; snapshot restored.'),
  F(39, 'LOG_APPEND_FAILED', 'record', 'l1', 'The receipt could not be written', 'The receipt could not be appended to the chain, so the call is refused rather than let through unrecorded.', 'Retry the same intent. The outbox retries on our side too. We have been paged.', 'Receipt append failed: the chain store did not acknowledge.', 'gate-error'),
  F(40, 'CHAIN_HEAD_CONFLICT', 'record', 'l1', 'Two writers reached the chain head', 'Two writers tried to extend the chain at once. This is a P0: the organisation is stopped until it is resolved.', 'Do nothing. We stop the organisation and open an incident.', 'Chain head conflict at #6,240.'),
  F(41, 'INTERNAL_ERROR', 'record', 'l1', 'Something unexpected failed before the call ran', 'An unexpected failure before the call ran. It is refused rather than let through.', 'Retry the same intent with backoff. We have been paged.', 'Unexpected failure before the call ran.', 'gate-error'),
  F(42, 'KEY_UNAVAILABLE', 'record', 'l2', 'The signing key could not be reached', 'The organisation’s signing key in AWS KMS or your HSM did not answer, so no receipt could be made.', 'Retry the same intent. For an HSM you hold, check it is reachable. We have been paged.', 'KMS sign call timed out.'),
  F(43, 'CLOCK_UNTRUSTED', 'record', 'l1', 'The clock could not be trusted', 'The time source drifted beyond tolerance, so a receipt’s time could not be stated honestly.', 'Retry the same intent. We have been paged.', 'Clock drift 2.8 s against the reference; tolerance 1 s.'),
  // L3 — 5 more, for Action Receipts between organisations (an unregistered issuer is GATE.COUNTERPARTY_UNKNOWN, above)
  P(44, 'RECEIPT_AUDIENCE_MISMATCH', 'receipt', 'l3', 'The receipt was issued to someone else', 'The Action Receipt names a different audience from the organisation presenting it.', 'Ask the issuer for a receipt addressed to you.', 'audience ar-org:kaveri.in; presented by ar-org:northbank.co.in.'),
  P(45, 'RECEIPT_EXPIRED', 'receipt', 'l3', 'The receipt has expired', 'The Action Receipt is past its expires_at.', 'Ask the issuer for a fresh receipt.', 'expires_at 2026-10-20T00:00:00Z has passed.'),
  P(46, 'TRUST_ANCHOR_UNKNOWN', 'receipt', 'l3', 'We do not know the issuer’s key', 'The issuer’s key is not in your trust anchors, and could not be fetched from its well-known address.', 'Add the issuer as a counterparty and compare its key fingerprint out of band.', 'kid k_dcb_hsm_3 is not a trust anchor.'),
  P(47, 'RECEIPT_UNVERIFIED', 'receipt', 'l3', 'The receipt did not verify', 'The Action Receipt’s digest, signature or anchor did not verify.', 'Do not act on it. Tell the issuer; keep the receipt as evidence.', 'Signature over digest did not verify for kid k_nb_kms_2.'),
  G(48, 'RECEIPT_REPLAYED', 'receipt', 'l3', 'The receipt was already used', 'The Action Receipt’s nonce has already been presented.', 'Ask the issuer for a new receipt; never re-present one.', 'nonce n_7f2c… was presented on 2026-10-26.'),
];

export const CORE_CODES = REFUSAL_CODES.filter((c) => c.core);

/** How a family is billed and retried. Refusals cost 40% of the per-action rate; platform failures are ours and never billed. */
export const FAMILY_INFO: Record<RefusalFamily, { label: string; billed: string; retry: string; pages: string; blurb: string }> = {
  POLICY: { label: 'Policy', billed: 'Billed at 40% of the per-action rate', retry: 'Do not retry the same intent. Change the request, the rule or the grant first.', pages: 'No', blurb: 'Your rules, your rulebook and the people who approve said no.' },
  GATE: { label: 'Pre-write checks', billed: 'Billed at 40% of the per-action rate', retry: 'Do not retry the same intent. Fix the state the check found, then make a new call.', pages: 'No', blurb: 'A check that runs before any write said no: consent, residency, retention, dual control, rate, budget, counterparty, schedule or precondition.' },
  PLATFORM: { label: 'Platform', billed: 'Never billed — the meter counts it at 0', retry: 'Retry the same intent_id with backoff. It is safe: nothing was applied.', pages: 'Yes — on-call is paged', blurb: 'We failed. Nothing ran, the refusal is recorded, and it is never billed.' },
};

/**
 * Where one code is billed or recorded differently from the rest of its family. The meter follows these
 * (features/billing/chainMeter.ts: sandbox calls and PLATFORM refusals at 0; the pilot hard stop writes nothing).
 */
export const CODE_BILLING: Record<string, { billed: boolean; text: string; recorded: string }> = {
  'POLICY.TENANT_STOPPED': {
    billed: true,
    text: 'An emergency stop or a regulator directive: billed at 40% of the per-action rate, like any policy refusal. The pilot’s hard stop: not billed — no receipt is written, so nothing is metered.',
    recorded: 'An emergency stop or a directive: yes, a refusal receipt (system rule id agent-paused). The pilot’s hard stop: no — the stop event is recorded once, and the refused calls after it write nothing; the console counts them.',
  },
  'GATE.SANDBOX_LIMIT_REACHED': {
    billed: false,
    text: 'Never billed: calls made with a sandbox key (sk_sbx_) are metered at 0.',
    recorded: 'Yes — a sandbox refusal receipt (system rule id sandbox-limit), marked sandbox inside the receipt body.',
  },
  ...Object.fromEntries(['POLICY.DECLARATION_INVALID', 'POLICY.VERSION_NOT_SEQUENTIAL', 'POLICY.NOT_CERTIFIED'].map((w) => [w, {
    billed: false,
    text: 'Not billed: it is raised when a version is checked before publishing, not on an agent’s call, so there is no governed action to meter.',
    recorded: 'The version is not put in force, and the person publishing sees why. No agent call was made, so no decision receipt is written.',
  }])),
};

/**
 * What the L3 receipt codes record (mock/platform.ts checkReceived and verifyReceived, mock/l3crossorg.ts
 * acceptReceived): no refusal receipt is written, and the received receipt never enters the receiver's chain. The
 * chain records the check: counterparty.receipt.received (verified: false) on arrival, and counterparty.receipt.verified
 * with result failed or expired each time it is verified and recorded again. A copy whose check failed cannot be accepted.
 */
export const RECEIVED_CHECK_RECORDED = 'No refusal receipt, and the receipt you were sent is not added to your chain: it stays in your counterparty register marked failed (or expired) and cannot be accepted. Your chain records the check instead — counterparty.receipt.received (verified: false) when it arrives, and counterparty.receipt.verified with the result each time it is verified and recorded again.';

/** How one code is billed and whether it writes a receipt. */
export function billingOf(c: RefusalCode): { billed: boolean; text: string; recorded: string } {
  const base = CODE_BILLING[c.wire] ?? { billed: c.family !== 'PLATFORM', text: FAMILY_INFO[c.family].billed, recorded: 'Yes — a refusal receipt on the chain, like any other' };
  return c.rung === 'receipt' ? { ...base, recorded: RECEIVED_CHECK_RECORDED } : base;
}

export const refusalByWire = (wire: string) => REFUSAL_CODES.find((c) => c.wire.toLowerCase() === wire.toLowerCase() || c.ref.toLowerCase() === wire.toLowerCase());

/* ══ Built-in MCP tool catalogue ═════════════════════════════════════════ */

export type McpScope = 'govern:read' | 'govern:stage' | 'govern:act';

export interface McpTool { name: string; scope: McpScope; does: string; args: string; level?: LevelId; billed: string }

const R = (name: string, does: string, args: string, level?: LevelId): McpTool => ({ name, scope: 'govern:read', does, args, level, billed: 'Not metered' });
const S = (name: string, does: string, args: string, level?: LevelId): McpTool => ({ name, scope: 'govern:stage', does, args, level, billed: 'Not metered' });
const A = (name: string, does: string, args: string, level?: LevelId, billed = 'One governed action; a refusal costs 40% of the per-action rate'): McpTool => ({ name, scope: 'govern:act', does, args, level, billed });

export const MCP_TOOLS: McpTool[] = [
  // 18 read-only
  R('read.records', 'List records of a write type, filtered by state or counterparty.', 'write_type, filter?, limit?'),
  R('read.record', 'One record with its full timeline of receipts.', 'record_key'),
  R('read.receipts', 'Receipts in a range, newest first.', 'from_seq?, to_seq?, agent?, decision?'),
  R('read.receipt', 'One receipt by its number.', 'seq'),
  R('read.evidence', 'What evidence exists for a range: receipts, checkpoints, timestamps, unanchored head.', 'from_seq, to_seq'),
  R('read.proof', 'The inclusion proof and both timestamp tokens for one receipt.', 'seq', 'l2'),
  R('read.declaration', 'The rulebook or declaration in force, at its explicit version.', 'agent?, version?'),
  R('read.rulebook_diff', 'The plain-language difference between two rulebook versions.', 'agent, from_version, to_version'),
  R('read.meter', 'This month’s governed actions, refusals (at 40%) and allowance used.', 'month?'),
  R('read.approvals', 'Approvals waiting, with who can decide and when they expire.', 'status?, agent?'),
  R('read.approval_status', 'The state of one held call. Long-polls up to 30 seconds. (Also answered as govern.approval_status.)', 'approval_id, wait?'),
  R('read.refusals', 'Refusals by code, rule and agent for a period.', 'from, to, code?'),
  R('read.chain_head', 'The chain head: number, hash and the last checkpoint.', '—'),
  R('read.agents', 'Agents with their route, status and autonomy.', 'status?'),
  R('read.autonomy', 'The autonomy grants for an agent, per write type.', 'agent', 'l3'),
  R('read.counterparties', 'Registered counterparties and their key fingerprints.', 'q?'),
  R('read.status', 'Service status and chain integrity, as the status page shows it.', '—'),
  R('read.tools', 'The tools this agent may call, with their risk tags.', '—'),
  // 10 staging — prepare a write, never apply it
  S('stage.write', 'Prepare a write: validate the arguments and run every pre-write check, without applying anything. Returns a staged_id and what would be decided.', 'write_type, args, intent_id'),
  S('stage.update', 'Change the arguments of a staged write. The checks run again.', 'staged_id, args'),
  S('stage.validate', 'Check arguments against the write type’s schema only.', 'write_type, args'),
  S('stage.simulate', 'Run the staged write against the rules in force and a draft version side by side.', 'staged_id, draft_version?'),
  S('stage.diff', 'What the write would change in the target record, field by field.', 'staged_id'),
  S('stage.attach_evidence', 'Attach a reference (document id or hash) a person will see when approving.', 'staged_id, ref, label'),
  S('stage.comment', 'Leave a note for the approver on a staged write.', 'staged_id, text'),
  S('stage.list', 'Staged writes this agent has open.', '—'),
  S('stage.get', 'One staged write, with its checks.', 'staged_id'),
  S('stage.withdraw', 'Drop a staged write. Nothing was applied, so nothing is billed.', 'staged_id'),
  // 6 act — the only tools that can change something
  A('act.write', 'Commit a staged write. The full decision path runs again on the same bytes; allowed writes run with a 10-minute credential.', 'staged_id'),
  A('act.escalate', 'Ask a person to decide a staged write now, before it is refused.', 'staged_id, reason'),
  A('act.reverse', 'Reverse a committed write inside its reversal window.', 'seq, reason'),
  A('act.retry', 'Retry a write refused with a PLATFORM.* code, with the same intent_id.', 'intent_id', undefined, 'Billed once, when it commits; the platform failure is never billed'),
  A('act.withdraw_escalation', 'Withdraw a held call before a person decides.', 'approval_id', undefined, 'Not metered'),
  A('act.record_outcome', 'Check and record only: report what happened after your code ran an allowed call.', 'seq, status, ref?', undefined, 'Not metered (the decision was)'),
];

export const MCP_SCOPES: Record<McpScope, { label: string; count: number; what: string }> = {
  'govern:read': { label: 'Read', count: MCP_TOOLS.filter((t) => t.scope === 'govern:read').length, what: 'Reads records, receipts, rules and the meter. Changes nothing.' },
  'govern:stage': { label: 'Stage', count: MCP_TOOLS.filter((t) => t.scope === 'govern:stage').length, what: 'Prepares writes and runs every pre-write check. Applies nothing.' },
  'govern:act': { label: 'Act', count: MCP_TOOLS.filter((t) => t.scope === 'govern:act').length, what: 'Commits, escalates, reverses and retries. Every call takes the full decision path.' },
};

/* ══ Conformance ═════════════════════════════════════════════════════════ */

export interface ConformanceTest { id: string; title: string; checks: string; how: string }

export const CONFORMANCE_TESTS: ConformanceTest[] = [
  { id: 'C1', title: 'Sandbox key and authentication', checks: 'The integration authenticates with an sk_sbx_ key; a missing or revoked key is a 401 with no receipt.', how: 'The agent holds a live sandbox key, and the harness sends one call with no key.' },
  { id: 'C2', title: 'An allowed call', checks: 'At least one call was allowed and its receipt is on the chain.', how: 'Sandbox receipts for the agent with decision allow.' },
  { id: 'C3', title: 'A refusal, honoured', checks: 'At least one call was refused, read as an answer (HTTP 200 or an isError tool result), and not run.', how: 'Sandbox refusals with no ok outcome recorded against them.' },
  { id: 'C4', title: 'An escalation resolved by a person', checks: 'At least one call was held, and a named person in the organisation decided it.', how: 'Sandbox asks whose approval was decided by a member, not by expiry.' },
  { id: 'C5', title: 'One outcome per decision', checks: 'Check and record: every allowed call has exactly one outcome; a second record is a 409 and is not retried.', how: 'Outcome receipts counted per decision.' },
  { id: 'C6', title: 'Fails closed', checks: 'When Elan1 Govern cannot be reached or answers 5xx, the integration does not run the call.', how: 'Governed run and the SDK fail closed by design; a REST client must state that it treats a timeout as a refusal.' },
  { id: 'C7', title: 'Rate limits', checks: 'A 429 is waited out for Retry-After seconds, never hammered.', how: 'The harness answers 429 with Retry-After: 2 and times the next request.' },
  { id: 'C8', title: 'Waiting for approval', checks: 'Held calls are followed with approval_status or waitForApproval, waiting at most 30 seconds per poll.', how: 'Polls made while sandbox approvals were waiting.' },
  { id: 'C9', title: 'Webhook signatures', checks: 'X-Elan1-Signature is verified; a bad signature or a timestamp older than 5 minutes is rejected.', how: 'The harness sends one good, one forged and one stale delivery.' },
  { id: 'C10', title: 'The record verifies', checks: 'The sandbox receipts verify: content hashes, chain links and keys.', how: 'The chain verifier run over the sample.' },
  { id: 'C11', title: 'Every refusal family handled', checks: 'POLICY.*, GATE.* and PLATFORM.* are told apart; only PLATFORM.* is retried with the same intent; an unknown code is treated as a refusal.', how: 'The harness returns one code of each family and one unknown code.' },
  { id: 'C12', title: 'Declared tools only', checks: 'Every tool called is declared in the rulebook in force at an explicit version.', how: 'Tools on the sample receipts against the published rulebook.' },
  { id: 'C13', title: 'Mode stated truthfully', checks: 'A check-and-record integration is described as advisory; only a governed run says calls are stopped.', how: 'The route on the receipts against the copy you supply.' },
  { id: 'C14', title: 'No banned claims in rendered copy', checks: 'Rendered copy has no banned claims for the level. At L1: “signed”, “tamper-proof”, “independently verifiable”. At any level: “immutable”, “court-ready”, “legally admissible”.', how: 'The copy your integration shows people, scanned word by word.' },
];

export interface ConformanceLevel { id: 'CL-1' | 'CL-2' | 'CL-3' | 'CL-4' | 'CL-D'; name: string; members: string; means: string; minLevel: LevelId }

export const CONFORMANCE_LEVELS: ConformanceLevel[] = [
  { id: 'CL-1', name: 'Structural', members: 'format, seal_suite, sealed_fields, digest, issuer, limits', means: 'The receipt has every always-present member and its digest recomputes from the sealed fields.', minLevel: 'l1' },
  { id: 'CL-2', name: 'Attested', members: '+ signature, key_id', means: 'A key bound to the issuing organisation signed the digest, and the key is published.', minLevel: 'l2' },
  { id: 'CL-3', name: 'Anchored', members: '+ anchor', means: 'The digest is in a Merkle batch timestamped by two RFC 3161 authorities.', minLevel: 'l2' },
  { id: 'CL-4', name: 'Addressed', members: '+ audience, nonce, expires_at', means: 'The receipt is addressed to one recipient, used once and dated to expire.', minLevel: 'l3' },
  { id: 'CL-D', name: 'Disclosing', members: '+ disclosure_suite, disclosures', means: 'Fields can be disclosed selectively (elan1-sd-v1, RFC 9901 style) and each disclosure verifies.', minLevel: 'l3' },
];

/** Banned claims, by the level of the copy being scanned (C14). */
export function bannedClaims(level: LevelId): string[] {
  const always = ['tamper-proof', 'immutable', 'court-ready', 'legally admissible', 'independently verifiable'];
  return level === 'l1' ? ['signed', ...always] : always;
}

/* ══ Glossary ════════════════════════════════════════════════════════════ */

export interface GlossaryTerm { term: string; def: string; see?: string; spec?: string }

export const GLOSSARY: GlossaryTerm[] = [
  { term: 'Action Receipt', def: 'The portable receipt one organisation sends another for a write it made. Fourteen members (six always present, the rest by level); graded by conformance level CL-1 to CL-D.', see: '/developers/standard', spec: 'Action Receipt' },
  { term: 'Allow · Ask a person · Refuse', def: 'The three answers. There is no “warn”: asking a person is the honest version of a warning.', see: '/developers/overview' },
  { term: 'Approval', def: 'A held call routed to a named person, on the web, by a single-use email or phone link, on Slack or on WhatsApp. It expires after 24 hours unless the rule says otherwise, and can be extended once with a declared reason.', see: '/developers/mcp' },
  { term: 'Approver group', def: 'The people a rule names to decide a held call. Membership is checked when they decide.' },
  { term: 'Assurance level', def: 'L1 Guarded, L2 Attested, L3 Proven or Sovereign. Each includes everything below it; records keep the level they were made at.' },
  { term: 'Auditor pack', def: 'The L1 export, with 7 members: a sealed manifest, keys, receipts, checkpoints, a PDF summary, a compliance map and a README. Checked offline with govern verify.', see: '/developers/receipts' },
  { term: 'Autonomy (A0–A5)', def: 'How much an agent may do for one write type without a person. A3 is reached only by a two-person graduation; no API sets a level.', see: '/developers/autonomy' },
  { term: 'Blast radius', def: 'How far a write may reach: one record, one counterparty, a batch, the tenant, or across a boundary.' },
  { term: 'Boundary', def: 'The receipt from which a higher assurance level applies. Records before it keep their level and keep verifying.' },
  { term: 'Bypass proof', def: 'Evidence that every path to the target other than Elan1 Govern fails — a direct API call, the service account, the network and stored tokens — each with what was tried and what came back. It is kept on the promotion request and summarised on its receipt. With at least 30 days of advisory traffic, it is needed to promote an agent from advisory to enforced.', see: '/developers/path-to-production' },
  { term: 'Chain', def: 'Every receipt links to the previous one by its hash, in one sequence per organisation. A gap or an edit shows.' },
  { term: 'Check and record', def: 'The advisory route (REST or SDK): Elan1 Govern answers and records; your code runs the call. An agent that skips the check is not stopped. Technical name: Mode B, attested advisory.', see: '/developers/api' },
  { term: 'Checkpoint', def: 'A periodic statement of the chain head (number and hash), made every hour.' },
  { term: 'Conformance suite', def: 'Tests C1–C14 an integration passes before it asks for a production key.', see: '/developers/conformance' },
  { term: 'Counterparty', def: 'Another organisation you exchange Action Receipts with. The register is listed from L1; issuing is L3.' },
  { term: 'Declaration', def: 'The L2 form of a rulebook: identity, shape, permissions, write types, checks, proof binding and channels. Every field has a value, out_of_scope or not_measurable — never a blank.' },
  { term: 'Deprecation and Sunset headers', def: 'Response headers that say a behaviour is deprecated (Deprecation, RFC 9745) and when it stops (Sunset, RFC 8594).', see: '/developers/changelog#deprecation' },
  { term: 'Dual control', def: 'Two different named people: one requests or reviews, the other approves or publishes. Recorded at L1, enforced from L2.' },
  { term: 'Emergency stop', def: 'Refuses every call from every agent (or the agents it names) until a person lifts it. Engaging it is typed, recorded and announced everywhere.' },
  { term: 'Evidence bundle', def: 'The L2+ export with eight members — manifest, receipts, seals, checkpoints, anchors, keys, declarations and the profile — and, from 28 October 2026, an optional lexicon (lexicon.json) listed in the signed manifest.', see: '/developers/seal' },
  { term: 'Governed action', def: 'One tool call decided by Elan1 Govern: the billing unit. A refusal costs 40% of the per-action rate; a platform failure is never billed.' },
  { term: 'Governed run', def: 'The enforced route (MCP): Elan1 Govern holds the credentials and runs the allowed call. The only route that can say a call was stopped. Technical name: Mode A, enforced.', see: '/developers/mcp' },
  { term: 'Intent id', def: 'Your id for one intended write. Retrying a PLATFORM.* refusal with the same intent id is safe.' },
  { term: 'Key prefix', def: 'Agent keys start gk_ (production, issued after review) or sk_sbx_ (sandbox, self-serve). Shown once, then only the prefix.' },
  { term: 'Meter', def: 'Governed actions counted from the chain. Sandbox calls are metered at 0.' },
  { term: 'Production-key review', def: 'A person checks four things — the conformance result file, the declaration version, the target and residency, and a named production owner — within 2 working days. On a hosted organisation the reviewer is at Elan1; on a Sovereign installation an owner or admin of your organisation other than the requester reviews. Nobody reviews their own request.', see: '/developers/path-to-production' },
  { term: 'Promotion', def: 'Moving an agent from check and record (advisory) to a governed run (enforced), after at least 30 days of advisory traffic (counted from its first check-and-record decision) and a bypass proof.', see: '/developers/path-to-production' },
  { term: 'Receipt', def: 'The record of one decision, approval, outcome or admin change. At L1 it is sealed in a hash chain; from L2 it is signed with a key bound to your organisation and timestamped.', see: '/developers/receipts' },
  { term: 'Refusal code', def: 'The permanent, numbered reason for a refusal: 47 codes in three families — policy, pre-write checks and platform (wire prefixes POLICY.*, GATE.*, PLATFORM.*) — and 5 more at L3.', see: '/developers/refusal-codes' },
  { term: 'Residency domain', def: 'Where calls and receipts stay: ap-south-1 Mumbai for hosted organisations, or your own data centre for Sovereign.' },
  { term: 'Risk tag', def: 'One of 8 labels on a tool: reads data, writes data, moves money, sends external, personal data, deletes, changes access, changes production.', see: '/developers/risk-tags' },
  { term: 'Rulebook', def: 'The rules for one agent, in YAML, with default: refuse. Every version is published, kept and checked on every call; from L2 each published version is also signed.', see: '/developers/rulebooks' },
  { term: 'Sandbox tenant', def: 'A self-serve tenant with fixtures, for building and testing with sk_sbx_ keys. 10 writes a minute, 2 at once, 5,000 a month; a call over a limit is refused (GATE.SANDBOX_LIMIT_REACHED) and recorded. Never billed.', see: '/developers/path-to-production' },
  { term: 'Seal v6', def: 'The L2 record: 16 frozen fields, a length-prefixed preimage, a SHA-256 digest and a signature.', see: '/developers/seal' },
  { term: 'Selective disclosure', def: 'Showing a recipient only some fields of a receipt, with proof the rest exist (L3).', see: '/developers/cross-org' },
  { term: 'Support tier', def: 'How fast we answer and how: Community, Standard, Business, Premier and Sovereign.', see: '/developers/support' },
  { term: 'Test vectors', def: '64 published inputs and expected digests (28 meant to fail) that two implementations of the seal must agree on.', see: '/developers/verifier-release' },
  { term: 'Verifier', def: 'govern verify: checks an export offline, with no account, and answers with one of six result codes.', see: '/developers/verifier' },
  { term: 'Verifier profile', def: 'The rules of one regime (for example in-mca-audit-trail) applied to a bundle. Billed as its own line.', see: '/developers/verifier' },
];

/* ══ Support tiers ═══════════════════════════════════════════════════════ */

export interface SupportTier { id: string; name: string; who: string; hours: string; channels: string; s1: string; s2: string; s3: string; s4: string; named: string; level?: LevelId }

export const SUPPORT_TIERS: SupportTier[] = [
  { id: 'community', name: 'Community', who: 'Sandbox tenants and anyone using the docs', hours: 'Best effort, Monday to Friday', channels: 'Forum, docs, status page', s1: '—', s2: '—', s3: '3 working days', s4: '5 working days', named: 'No' },
  { id: 'standard', name: 'Standard', who: 'L1 Guarded', hours: '09:00–19:00 IST, Monday to Saturday', channels: 'Email, console', s1: '4 hours', s2: '1 working day', s3: '2 working days', s4: '5 working days', named: 'No', level: 'l1' },
  { id: 'business', name: 'Business', who: 'L2 Attested', hours: '24 × 7 for S1; 08:00–22:00 IST otherwise', channels: 'Email, console, phone for S1', s1: '1 hour', s2: '4 hours', s3: '1 working day', s4: '3 working days', named: 'A named support engineer', level: 'l2' },
  { id: 'premier', name: 'Premier', who: 'L3 Proven', hours: '24 × 7', channels: 'Email, console, phone, a shared Slack channel', s1: '30 minutes', s2: '2 hours', s3: '8 hours', s4: '2 working days', named: 'A named engineer and a technical account manager', level: 'l3' },
  { id: 'sovereign', name: 'Sovereign', who: 'Sovereign installations', hours: '24 × 7, with on-site visits by arrangement', channels: 'Phone, a shared channel, signed update bundles', s1: '30 minutes', s2: '2 hours', s3: '8 hours', s4: '2 working days', named: 'A named engineer cleared for your site', level: 'sovereign' },
];

export const SEVERITIES: { id: string; name: string; means: string }[] = [
  { id: 'S1', name: 'Critical', means: 'Calls cannot be decided, receipts cannot be written, or the chain does not verify. Production is down.' },
  { id: 'S2', name: 'Major', means: 'A feature is failing for many calls, for example approvals not reaching people. There is a workaround, but a poor one.' },
  { id: 'S3', name: 'Minor', means: 'Something is wrong for some calls or one screen; work continues.' },
  { id: 'S4', name: 'Question', means: 'How do I, documentation, a feature request.' },
];

/* ══ Deprecations (Deprecation and Sunset headers) ═══════════════════════ */

export interface Deprecation { id: string; what: string; replacement: string; deprecatedOn: string; sunset: string; affects: string }

/** Behaviour that still works but will stop. Responses that use it carry Deprecation (RFC 9745), Sunset (RFC 8594) and a Link. */
export const DEPRECATIONS: Deprecation[] = [
  { id: 'eg-key-prefixes', what: 'Agent keys that start eg_live_ or eg_test_', replacement: 'gk_ (production) and sk_sbx_ (sandbox) — the same key, with its new prefix', deprecatedOn: '2026-10-28', sunset: '2027-10-28', affects: 'Every endpoint: /v1/check, /v1/record, /v1/approvals/{id} and /mcp' },
];

export const DEPRECATION_LINK = 'https://govern.elan1.ai/developers/changelog#deprecation';

/** The headers a response carries when a request uses a deprecated behaviour. */
export function deprecationHeaders(dep: Deprecation): Record<string, string> {
  return {
    deprecation: `@${Math.floor(new Date(`${dep.deprecatedOn}T00:00:00Z`).getTime() / 1000)}`,
    sunset: new Date(`${dep.sunset}T00:00:00Z`).toUTCString(),
    link: `<${DEPRECATION_LINK}>; rel="deprecation"; type="text/html"`,
  };
}

/* ══ Offline-verifier releases ═══════════════════════════════════════════ */

export interface VerifierRelease { version: string; date: string; status: 'current' | 'superseded'; note: string; supersededOn?: string; why?: string }

export const VERIFIER_RELEASES: VerifierRelease[] = [
  { version: '2.0.0', date: '2026-10-27', status: 'current', note: 'Six result codes (exit 0–5) and the nine-section report; --fingerprint, --profile and --report; a batch timestamped by one authority reports degraded, not failed.' },
  { version: '1.4.2', date: '2026-08-20', status: 'superseded', supersededOn: '2026-10-27', note: 'Three result codes. Checks L1 auditor packs and checkpoints.', why: 'Exit 2 meant “cannot verify”; in 2.0.0 that is INCOMPLETE (exit 3) and exit 2 is FAIL_PROFILE. 1.4.2 still verifies every pack it verified before.' },
  { version: '1.3.0', date: '2026-06-02', status: 'superseded', supersededOn: '2026-08-20', note: 'First public release.', why: 'Did not check that a retired key stopped signing at its rotation. Upgrade.' },
];

export const RELEASE_PLATFORMS = ['linux-amd64', 'linux-arm64', 'darwin-arm64', 'darwin-amd64', 'windows-amd64'] as const;
