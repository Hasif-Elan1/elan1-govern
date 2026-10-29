// Selective disclosure packages in the SD-JWT style (RFC 9901), the part of the console's lib/disclosure.ts the
// verifier checks: every committed field is a salted digest, SHA-256 over canonical([salt, name, value]). The
// issuer signs the sorted list of digests with its Ed25519 key. A counterparty receives only the revealed fields
// with their salts, recomputes each digest, checks it is in the signed list, and checks the issuer's signature with
// a key it pinned out of band. Fields not revealed stay hidden but are still bound by the signature.
import { canonical, keyFingerprintOf, randomHex, sha256Hex, verifySig } from "./primitives";
import type { DisclosureField, DisclosurePackage, Receipt, RevealedField, VerifyStep } from "./types";

/** The 11 fields a receipt commits to in a disclosure package. */
export const DISCLOSABLE_FIELDS = ["seq", "ts", "agent", "tool", "decision", "rule_id", "reason", "rulebook_version", "approval", "outcome", "amount"] as const;
export type DisclosableField = (typeof DISCLOSABLE_FIELDS)[number];

export const FIELD_LABELS: Record<DisclosableField, string> = {
  seq: "Sequence number", ts: "Time", agent: "Agent", tool: "Tool", decision: "Decision", rule_id: "Rule", reason: "Reason",
  rulebook_version: "Rulebook version", approval: "Approval (status and approver)", outcome: "Outcome", amount: "Amount",
};

/** The value of each committed field, as a string. */
export function fieldValuesOf(r: Receipt, approvalResult?: Receipt): Record<DisclosableField, string> {
  const ap = approvalResult?.approval ?? r.approval;
  const out = approvalResult?.outcome ?? r.outcome;
  return {
    seq: String(r.seq),
    ts: r.ts,
    agent: r.agent ?? r.actor ?? "",
    tool: r.tool ?? r.action ?? "",
    decision: approvalResult ? `${r.decision} → ${approvalResult.decision}` : r.decision ?? "",
    rule_id: r.rule_id ?? "",
    reason: r.reason ?? "",
    rulebook_version: r.rulebook ? `v${r.rulebook.version} · ${r.rulebook.hash.slice(0, 16)}` : "",
    approval: ap ? `${ap.status}${ap.approver ? ` by ${ap.approver}` : ""}${ap.channel ? ` via ${ap.channel}` : ""}` : "none",
    outcome: out ? `${out.status}${out.ref ? ` · ${out.ref}` : ""}` : "not reported",
    amount: r.args_summary?.amount !== undefined ? String(r.args_summary.amount) : "",
  };
}

export function disclosureDigest(salt: string, name: string, value: string) {
  return sha256Hex(canonical([salt, name, value]));
}

export const randomSalt = (): string => randomHex(16);

/** The message the issuer signs. */
export function disclosureMessage(p: Pick<DisclosurePackage, "orgId" | "seq" | "receiptHash" | "audience" | "expiresAt" | "committed">) {
  return sha256Hex(canonical({ iss: p.orgId, seq: p.seq, receipt_hash: p.receiptHash, aud: p.audience, exp: p.expiresAt, digests: p.committed.map((c) => c.digest).sort() }));
}

/** Commit every field with a fresh salt; return the digests and the salts (the issuer keeps the salts). */
export function commitFields(values: Record<string, string>): { committed: DisclosureField[]; salts: Record<string, string> } {
  const salts: Record<string, string> = {};
  const committed = Object.keys(values).sort().map((name) => {
    salts[name] = randomSalt();
    return { name, digest: disclosureDigest(salts[name], name, values[name]!) };
  });
  return { committed, salts };
}

export interface DisclosureCheck {
  valid: boolean;
  steps: VerifyStep[];
  revealedCount: number;
  committedCount: number;
}

/**
 * Verify a disclosure package as a counterparty would: audience → expiry → pinned key →
 * issuer signature → each revealed field's digest is in the signed list.
 */
export function verifyDisclosure(p: DisclosurePackage, opts: { pinnedFingerprint?: string; audience?: string; now?: number } = {}): DisclosureCheck {
  const steps: VerifyStep[] = [];
  const now = opts.now ?? Date.now();
  steps.push({ label: "Audience", state: !opts.audience || opts.audience === p.audience ? "pass" : "fail", detail: `Issued to ${p.audience}.` });
  const expired = new Date(p.expiresAt).getTime() < now;
  steps.push({ label: "Expiry", state: expired ? "fail" : "pass", detail: expired ? `Expired ${p.expiresAt}.` : `Valid until ${p.expiresAt}.` });
  // a package signed with a real chain key names it by its fingerprint (keyFingerprintOf)
  const fp = keyFingerprintOf(p.kid, p.publicKey);
  steps.push({ label: "Issuer key", state: opts.pinnedFingerprint ? (opts.pinnedFingerprint === fp ? "pass" : "fail") : "skip", detail: opts.pinnedFingerprint ? `Fingerprint ${fp} ${opts.pinnedFingerprint === fp ? "matches" : "does not match"} the pinned ${opts.pinnedFingerprint}.` : `Key fingerprint ${fp}. Compare it with one you obtained from the issuer directly.` });
  const sigOk = verifySig(disclosureMessage(p), p.sig, p.publicKey);
  steps.push({ label: "Issuer signature", state: sigOk ? "pass" : "fail", detail: sigOk ? `Ed25519 signature over ${p.committed.length} committed digests verifies.` : "The signature does not verify — the package was changed or signed by another key." });
  const set = new Set(p.committed.map((c) => c.digest));
  const bad = p.revealed.filter((f: RevealedField) => !set.has(disclosureDigest(f.salt, f.name, f.value)));
  steps.push({ label: "Revealed fields", state: bad.length ? "fail" : "pass", detail: bad.length ? `${bad.length} revealed field${bad.length === 1 ? "" : "s"} (${bad.map((b) => b.name).join(", ")}) do not match a committed digest.` : `You are revealing ${p.revealed.length} of ${p.committed.length} committed fields; each recomputes to a signed digest.` });
  const valid = steps.every((s) => s.state !== "fail");
  return { valid, steps, revealedCount: p.revealed.length, committedCount: p.committed.length };
}
