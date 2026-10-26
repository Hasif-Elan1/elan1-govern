import { keyFingerprint, verifyText } from "./crypto";

/**
 * An org's public signing keys, past and present. A key id (`kid`) is always the key's
 * fingerprint, so a verifier recomputes it from the PEM and never trusts a label.
 */
export interface PublicKeyInfo {
  kid?: string;
  publicKeyPem: string;
  createdAt?: string;
  /** When the key stopped signing. Anything it signed with a later timestamp is rejected. */
  retiredAt?: string | null;
}

/** One PEM (a single, never-rotated key) or a list of keys. */
export type KeyInput = string | readonly PublicKeyInfo[];

export type SigCheck = { ok: true; kid: string } | { ok: false; reason: string };

interface Entry {
  kid: string;
  pem: string;
  retiredAt: number | null;
}

const time = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

export class KeyRing {
  private readonly byKid = new Map<string, Entry>();

  constructor(input: KeyInput) {
    const list = typeof input === "string" ? [{ publicKeyPem: input }] : input;
    for (const k of list) {
      const kid = keyFingerprint(k.publicKeyPem);
      if (k.kid !== undefined && k.kid !== kid) throw new Error(`key ${k.kid} does not match its fingerprint ${kid}`);
      this.byKid.set(kid, { kid, pem: k.publicKeyPem, retiredAt: time(k.retiredAt) });
    }
  }

  get size() {
    return this.byKid.size;
  }

  has(kid: string) {
    return this.byKid.has(kid);
  }

  /** Mark a key retired at `at`, keeping the earlier time if one is already known. */
  retire(kid: string, at: string) {
    const e = this.byKid.get(kid);
    const t = time(at);
    if (!e || t === null) return;
    if (e.retiredAt === null || t < e.retiredAt) e.retiredAt = t;
  }

  /**
   * Checks a signature made at `ts` by the key `kid`. Without a kid (receipts written before key
   * rotation existed) any key that was not yet retired at `ts` may have signed it.
   */
  verify(text: string, sig: string, ts: string, kid?: string): SigCheck {
    const at = time(ts);
    const live = (e: Entry) => e.retiredAt === null || (at !== null && at <= e.retiredAt);
    if (kid !== undefined) {
      const e = this.byKid.get(kid);
      if (!e) return { ok: false, reason: `signed with an unknown key (${kid})` };
      if (!live(e)) return { ok: false, reason: `signed with key ${kid} after it was retired` };
      return verifyText(e.pem, text, sig) ? { ok: true, kid } : { ok: false, reason: "has an invalid signature" };
    }
    for (const e of this.byKid.values()) {
      if (live(e) && verifyText(e.pem, text, sig)) return { ok: true, kid: e.kid };
    }
    return { ok: false, reason: "has an invalid signature" };
  }
}

/** The admin action whose receipt hands signing over from one key to the next. */
export const KEY_ROTATED_ACTION = "key.rotated";
