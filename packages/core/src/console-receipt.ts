// ── chain ── The approved console's receipt shape (apps/console/src/types.ts) and core's receipt format, mapped
// both ways. The console's screens read `approval.status`, `approval.approver`, `approval.channel`, `outcome.ms`
// and `environment`; core's ReceiptSchema has `approval.result` and `approval.by` and no place for the other three.
// So a receipt the console writes is encoded into core's vocabulary before the gate signs it (the three extra
// values travel in `details` under reserved keys), and a receipt read back from the chain is decoded for the
// console. Hash, signature, previous hash and key id are never touched: a decoded receipt keeps the chain's own
// `sha256:` / `ed25519:` strings, which is how the console's verifier tells a real receipt from its demo ones.
//
// The mapping is exact one way round, which is the one verification needs: for every receipt r the chain holds,
// fromConsoleReceipt(toConsoleReceipt(r)) is r again, so the browser recomputes the hash over the bytes the gate
// signed. A decoded receipt someone changed afterwards encodes to different bytes and fails, as it should.
//
// Browser-safe: no node:crypto. The console hashes the preimages with its own SHA-256.
import { canonicalize } from "./canonical";
import type { Checkpoint, Receipt } from "./receipt";

/** Where the console-only values live in a chain receipt's details. */
export const CONSOLE_DETAIL_KEYS = {
  /** `approved_run_failed`: the console's approval status for an approved call whose run then failed. */
  approvalStatus: "console.approval_status",
  /** The channel an approval was decided in (web, slack, whatsapp, email, phone_link). */
  approvalChannel: "console.approval_channel",
  /** How long the call took, in milliseconds. */
  outcomeMs: "console.outcome_ms",
  /** `sandbox` for a call made with a sandbox agent key. */
  environment: "console.environment",
} as const;

const K = CONSOLE_DETAIL_KEYS;
const RUN_FAILED = "approved_run_failed";

/** A receipt as the console's screens read it. Fields the console does not know (a gate approval's `at`) are kept. */
export interface ConsoleReceipt {
  seq: number;
  ts: string;
  org: string;
  kind: string;
  agent?: string;
  tool?: string;
  args_summary?: Record<string, unknown>;
  args_hash?: string;
  rulebook?: { version: number; hash: string };
  rule_id?: string;
  decision?: string;
  reason?: string;
  approval?: { id: string; status: string; approver?: string; channel?: string; self_approval?: boolean; at?: string; expires_at?: string };
  outcome?: { status: string; ref?: string; ms?: number; error?: string };
  ref_seq?: number;
  actor?: string;
  action?: string;
  details?: Record<string, unknown>;
  environment?: string;
  prev_hash: string;
  kid?: string;
  hash: string;
  sig: string;
}

/** The fields a console receipt may carry. Anything else (an erasure's `redacted`) has no place in a chain receipt. */
const CONSOLE_FIELDS = new Set([
  "seq", "ts", "org", "kind", "agent", "tool", "args_summary", "args_hash", "rulebook", "rule_id", "decision", "reason",
  "approval", "outcome", "ref_seq", "actor", "action", "details", "environment", "prev_hash", "kid", "hash", "sig",
]);

/** What the chain fills in itself: never part of what a writer sends. */
export const CHAIN_FIELDS = ["seq", "ts", "org", "prev_hash", "kid", "hash", "sig"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A console receipt (or the body of one) in core's vocabulary. Throws on a field core's format has no place for, and
 * on a details key the encoding needs that the receipt already uses, so nothing is ever silently dropped or replaced.
 */
export function encodeConsoleReceipt(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extras: [string, unknown][] = [];
  for (const [key, value] of Object.entries(c)) {
    if (value === undefined) continue;
    if (!CONSOLE_FIELDS.has(key)) throw new Error(`a chain receipt has no field "${key}"`);
    if (key === "approval" && isObject(value)) {
      const { status, approver, channel, ...rest } = value;
      const a: Record<string, unknown> = { ...rest };
      if (status === RUN_FAILED) {
        a.result = "approved";
        extras.push([K.approvalStatus, status]);
      } else if (status !== undefined) a.result = status;
      if (approver !== undefined) a.by = approver;
      if (channel !== undefined) extras.push([K.approvalChannel, channel]);
      out.approval = a;
    } else if (key === "outcome" && isObject(value)) {
      const { ms, ...rest } = value;
      if (ms !== undefined) extras.push([K.outcomeMs, ms]);
      out.outcome = rest;
    } else if (key === "environment") {
      extras.push([K.environment, value]);
    } else if (key === "details" && isObject(value)) {
      out.details = { ...value };
    } else out[key] = value;
  }
  if (extras.length) {
    const details = (out.details ??= {}) as Record<string, unknown>;
    for (const [k, v] of extras) {
      if (k in details) throw new Error(`details.${k} is reserved for the console's own value`);
      details[k] = v;
    }
  }
  return out;
}

/** The chain receipt a console receipt stands for (the inverse of toConsoleReceipt). */
export function fromConsoleReceipt(c: ConsoleReceipt | Record<string, unknown>): Receipt {
  return encodeConsoleReceipt(c as Record<string, unknown>) as unknown as Receipt;
}

/** A receipt from the chain as the console reads it. */
export function toConsoleReceipt(r: Receipt): ConsoleReceipt {
  const out: Record<string, unknown> = { ...r };
  const details = r.details ? { ...r.details } : undefined;
  let consumed = false;
  /** Take a reserved value out of details when it is one the encoding writes; leave anything else where it is. */
  const take = (key: string, ok: (v: unknown) => boolean): unknown => {
    if (!details || !Object.prototype.hasOwnProperty.call(details, key) || !ok(details[key])) return undefined;
    const v = details[key];
    delete details[key];
    consumed = true;
    return v;
  };
  if (r.approval) {
    const { result, by, ...rest } = r.approval;
    const failed = result === "approved" ? take(K.approvalStatus, (v) => v === RUN_FAILED) : undefined;
    const channel = take(K.approvalChannel, (v) => typeof v === "string");
    out.approval = { ...rest, status: failed ?? result, ...(by !== undefined ? { approver: by } : {}), ...(channel !== undefined ? { channel } : {}) };
  }
  if (r.outcome) {
    const ms = take(K.outcomeMs, (v) => typeof v === "number");
    out.outcome = ms === undefined ? { ...r.outcome } : { ...r.outcome, ms };
  }
  const environment = take(K.environment, (v) => typeof v === "string");
  if (environment !== undefined) out.environment = environment;
  if (details) {
    if (consumed && !Object.keys(details).length) delete out.details;
    else out.details = details;
  }
  return out as unknown as ConsoleReceipt;
}

/** A receipt in the chain's format: its hash carries the `sha256:` prefix (the console's own demo receipts have none). */
export function isChainFormat(x: unknown): boolean {
  return isObject(x) && typeof x.hash === "string" && x.hash.startsWith("sha256:");
}

/** The text whose SHA-256 is a chain receipt's hash (core's receiptHash), from its console form. */
export function receiptPreimage(c: ConsoleReceipt | Record<string, unknown>): string {
  const { hash: _h, sig: _s, ...body } = encodeConsoleReceipt(c as Record<string, unknown>);
  return canonicalize(body);
}

/* ── Checkpoints ─────────────────────────────────────────── */

/** A checkpoint as the console lists it: an id, and whether a person asked for it. */
export interface ConsoleCheckpoint {
  id: string;
  org: string;
  seq: number;
  hash: string;
  ts: string;
  kid?: string;
  sig: string;
  onDemand?: boolean;
}

export function toConsoleCheckpoint(c: Checkpoint): ConsoleCheckpoint {
  return { id: `cp_${c.seq}`, ...c };
}

export function fromConsoleCheckpoint(c: ConsoleCheckpoint): Checkpoint {
  return { org: c.org, seq: c.seq, hash: c.hash, ts: c.ts, ...(c.kid !== undefined ? { kid: c.kid } : {}), sig: c.sig };
}

/** The text whose SHA-256 a chain checkpoint's signature is over (core's signCheckpoint). */
export function checkpointPreimage(c: ConsoleCheckpoint | Checkpoint): string {
  const { sig: _s, ...unsigned } = fromConsoleCheckpoint(c as ConsoleCheckpoint);
  return canonicalize(unsigned);
}

/* ── Signatures and keys as raw bytes ────────────────────── */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (padding optional) to bytes; undefined when it is not base64. */
function base64Bytes(text: string): Uint8Array | undefined {
  const s = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of s) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A chain signature (`ed25519:<base64>`) as 64 bytes of hex, or undefined when it is not one. */
export function signatureHex(sig: string): string | undefined {
  if (typeof sig !== "string" || !sig.startsWith("ed25519:")) return undefined;
  const bytes = base64Bytes(sig.slice("ed25519:".length));
  return bytes && bytes.length === 64 ? hex(bytes) : undefined;
}

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32-byte key follows it. */
const ED25519_SPKI = "302a300506032b6570032100";

/** An Ed25519 public key PEM (SPKI) as its 32 raw bytes in hex, the form the console's verifier takes. */
export function publicKeyHex(pem: string): string {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const der = base64Bytes(body);
  const h = der ? hex(der) : "";
  if (h.length !== ED25519_SPKI.length + 64 || !h.startsWith(ED25519_SPKI)) throw new Error("not an Ed25519 public key");
  return h.slice(ED25519_SPKI.length);
}
