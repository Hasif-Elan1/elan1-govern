import { z } from "zod";
import { omit } from "./canonical";
import { GENESIS_HASH, hashCanonical, signText } from "./crypto";
import { KEY_ROTATED_ACTION, KeyRing, type KeyInput } from "./keys";
import { DECISIONS } from "./rulebook";

export const RECEIPT_KINDS = ["decision", "approval", "outcome", "admin"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const ReceiptSchema = z
  .object({
    seq: z.number().int().min(1),
    ts: z.string(),
    org: z.string(),
    kind: z.enum(RECEIPT_KINDS),
    agent: z.string().optional(),
    tool: z.string().optional(),
    args_summary: z.record(z.string(), z.unknown()).optional(),
    args_hash: z.string().optional(),
    rulebook: z.object({ version: z.number().int(), hash: z.string() }).optional(),
    rule_id: z.string().optional(),
    decision: z.enum(DECISIONS).optional(),
    reason: z.string().optional(),
    approval: z
      .object({
        id: z.string(),
        result: z.enum(["pending", "approved", "rejected", "expired"]),
        by: z.string().optional(),
        at: z.string().optional(),
        expires_at: z.string().optional(),
        self_approval: z.boolean().optional(),
      })
      .optional(),
    outcome: z
      .object({ status: z.enum(["ok", "error", "not_run"]), ref: z.string().optional(), error: z.string().optional() })
      .optional(),
    ref_seq: z.number().int().optional(),
    actor: z.string().optional(),
    action: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    prev_hash: z.string(),
    /** Id (fingerprint) of the key that signed it. Absent on receipts written before key rotation. */
    kid: z.string().optional(),
    hash: z.string(),
    sig: z.string(),
  })
  .strict();

export type Receipt = z.infer<typeof ReceiptSchema>;
/** What a caller supplies; the chain fills in seq, ts, prev_hash, hash and sig. */
export type ReceiptInput = Omit<Receipt, "seq" | "ts" | "org" | "prev_hash" | "kid" | "hash" | "sig">;

export function receiptHash(r: Omit<Receipt, "hash" | "sig"> | Receipt): string {
  return hashCanonical(omit(r as Receipt, ["hash", "sig"]));
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export const GENESIS: ChainHead = { seq: 0, hash: GENESIS_HASH };

export type ReceiptMeta = { org: string; ts: string; head: ChainHead; kid?: string };

/** The receipt with its hash, ready to sign: for signers that keep the key elsewhere (an HSM). The signature is over `hash`. */
export function prepareReceipt(input: ReceiptInput, meta: ReceiptMeta): Omit<Receipt, "sig"> {
  const body = dropUndefined({ ...input, seq: meta.head.seq + 1, ts: meta.ts, org: meta.org, prev_hash: meta.head.hash, kid: meta.kid });
  return { ...(body as Omit<Receipt, "hash" | "sig">), hash: receiptHash(body as Receipt) };
}

export function buildReceipt(input: ReceiptInput, meta: ReceiptMeta, privateKeyPem: string): Receipt {
  const unsigned = prepareReceipt(input, meta);
  return { ...unsigned, sig: signText(privateKeyPem, unsigned.hash) };
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---- Checkpoints: a signed statement of the chain head at a moment ----

export const CheckpointSchema = z
  .object({ org: z.string(), seq: z.number().int().min(0), hash: z.string(), ts: z.string(), kid: z.string().optional(), sig: z.string() })
  .strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export function signCheckpoint(c: Omit<Checkpoint, "sig">, privateKeyPem: string): Checkpoint {
  return { ...c, sig: signText(privateKeyPem, hashCanonical(c)) };
}

export function verifyCheckpoint(c: Checkpoint, keys: KeyInput | KeyRing): boolean {
  const ring = keys instanceof KeyRing ? keys : new KeyRing(keys);
  return ring.verify(hashCanonical(omit(c, ["sig"])), c.sig, c.ts, c.kid).ok;
}

// ---- Chain verification ----

export type VerifyResult =
  | { ok: true; count: number; firstSeq: number | null; lastSeq: number; lastHash: string; checkpoints: number }
  | { ok: false; seq: number | null; reason: string };

/**
 * Walks receipts in the order given. Reports the first problem with the seq it was found at:
 * edits (hash or signature mismatch), deletions (gap in seq), reordering and inserted rows
 * (seq out of place or prev_hash link broken).
 *
 * `keys` is one public key, or every key the org has used. Each receipt is checked with the key
 * its `kid` names, and that key must not have been retired before the receipt's time. A
 * `key.rotated` receipt retires the key that signed it, so the chain itself records the handover.
 */
export function verifyChain(
  receipts: readonly unknown[],
  keys: KeyInput,
  opts: { anchor?: ChainHead; checkpoints?: readonly Checkpoint[] } = {},
): VerifyResult {
  let ring: KeyRing;
  try {
    ring = new KeyRing(keys);
  } catch (e) {
    return { ok: false, seq: null, reason: (e as Error).message };
  }
  const anchor = opts.anchor ?? GENESIS;
  let expected = anchor.seq + 1;
  let prev = anchor.hash;
  const hashes = new Map<number, string>();

  for (const raw of receipts) {
    const parsed = ReceiptSchema.safeParse(raw);
    const rawSeq = typeof (raw as { seq?: unknown })?.seq === "number" ? (raw as { seq: number }).seq : null;
    if (!parsed.success) return { ok: false, seq: rawSeq ?? expected, reason: "receipt is malformed" };
    const r = parsed.data;
    if (r.seq > expected) return { ok: false, seq: expected, reason: `receipt ${expected} is missing (next one found is ${r.seq})` };
    if (r.seq < expected) return { ok: false, seq: r.seq, reason: `receipt ${r.seq} is out of order or duplicated` };
    if (r.prev_hash !== prev) return { ok: false, seq: r.seq, reason: `receipt ${r.seq} does not link to the one before it` };
    if (receiptHash(r) !== r.hash) return { ok: false, seq: r.seq, reason: `receipt ${r.seq} was changed after it was written` };
    const sig = ring.verify(r.hash, r.sig, r.ts, r.kid);
    if (!sig.ok) return { ok: false, seq: r.seq, reason: `receipt ${r.seq} ${sig.reason}` };
    if (r.kind === "admin" && r.action === KEY_ROTATED_ACTION) {
      const next = r.details?.new_kid;
      if (typeof next !== "string" || next === sig.kid) return { ok: false, seq: r.seq, reason: `receipt ${r.seq} rotates the signing key but does not name a new one` };
      ring.retire(sig.kid, r.ts);
    }
    hashes.set(r.seq, r.hash);
    prev = r.hash;
    expected++;
  }

  const checkpoints = opts.checkpoints ?? [];
  for (const c of checkpoints) {
    if (!verifyCheckpoint(c, ring)) return { ok: false, seq: c.seq, reason: `checkpoint at ${c.seq} has an invalid signature` };
    const h = hashes.get(c.seq);
    if (h !== undefined && h !== c.hash) return { ok: false, seq: c.seq, reason: `receipt ${c.seq} does not match its signed checkpoint` };
  }

  return {
    ok: true,
    count: receipts.length,
    firstSeq: receipts.length ? anchor.seq + 1 : null,
    lastSeq: expected - 1,
    lastHash: prev,
    checkpoints: checkpoints.length,
  };
}
