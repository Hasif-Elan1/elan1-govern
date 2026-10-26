import { canonicalize, omit } from "./canonical";
import { hashCanonical, signText, verifyText } from "./crypto";
import { parseRulebookYaml, type Rulebook } from "./rulebook";

/** The exact bytes a rulebook signature covers. */
export function rulebookSigningPayload(rb: Rulebook): string {
  return canonicalize(omit(rb, ["signature"]));
}

export function rulebookHash(rb: Rulebook): string {
  return hashCanonical(omit(rb, ["signature"]));
}

export function signRulebook(rb: Rulebook, privateKeyPem: string): Rulebook {
  return { ...rb, signature: signText(privateKeyPem, rulebookSigningPayload(rb)) };
}

export function verifyRulebook(rb: Rulebook, publicKeyPem: string): boolean {
  return typeof rb.signature === "string" && verifyText(publicKeyPem, rulebookSigningPayload(rb), rb.signature);
}

export type LoadResult = { ok: true; rulebook: Rulebook } | { ok: false; reason: string };

/** Parse, validate and verify. Gate only ever runs a rulebook that passes this. */
export function loadSignedRulebook(text: string, publicKeyPem: string): LoadResult {
  const parsed = parseRulebookYaml(text);
  if (!parsed.ok) return { ok: false, reason: `invalid rulebook: ${parsed.errors.join("; ")}` };
  if (!parsed.rulebook.signature) return { ok: false, reason: "rulebook is not signed" };
  if (!verifyRulebook(parsed.rulebook, publicKeyPem)) return { ok: false, reason: "rulebook signature does not match" };
  return { ok: true, rulebook: parsed.rulebook };
}

