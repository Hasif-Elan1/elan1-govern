import { z } from "zod";
import { omit } from "./canonical";
import { GENESIS_HASH, hashCanonical, signText, verifyText } from "./crypto";
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
    hash: z.string(),
    sig: z.string(),
  })
  .strict();

export type Receipt = z.infer<typeof ReceiptSchema>;
/** What a caller supplies; the chain fills in seq, ts, prev_hash, hash and sig. */
export type ReceiptInput = Omit<Receipt, "seq" | "ts" | "org" | "prev_hash" | "hash" | "sig">;

export function receiptHash(r: Omit<Receipt, "hash" | "sig"> | Receipt): string {
  return hashCanonical(omit(r as Receipt, ["hash", "sig"]));
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export const GENESIS: ChainHead = { seq: 0, hash: GENESIS_HASH };

export function buildReceipt(
  input: ReceiptInput,
  meta: { org: string; ts: string; head: ChainHead },
  privateKeyPem: string,
): Receipt {
  const body = dropUndefined({ ...input, seq: meta.head.seq + 1, ts: meta.ts, org: meta.org, prev_hash: meta.head.hash });
  const hash = receiptHash(body as Receipt);
  return { ...(body as Omit<Receipt, "hash" | "sig">), hash, sig: signText(privateKeyPem, hash) };
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---- Checkpoints: a signed statement of the chain head at a moment ----

export const CheckpointSchema = z
  .object({ org: z.string(), seq: z.number().int().min(0), hash: z.string(), ts: z.string(), sig: z.string() })
  .strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export function signCheckpoint(c: Omit<Checkpoint, "sig">, privateKeyPem: string): Checkpoint {
  return { ...c, sig: signText(privateKeyPem, hashCanonical(c)) };
}

export function verifyCheckpoint(c: Checkpoint, publicKeyPem: string): boolean {
  return verifyText(publicKeyPem, hashCanonical(omit(c, ["sig"])), c.sig);
}

// ---- Chain verification ----

export type VerifyResult =
  | { ok: true; count: number; firstSeq: number | null; lastSeq: number; lastHash: string; checkpoints: number }
  | { ok: false; seq: number | null; reason: string };

/**
 * Walks receipts in the order given. Reports the first problem with the seq it was found at:
 * edits (hash or signature mismatch), deletions (gap in seq), reordering and inserted rows
 * (seq out of place or prev_hash link broken).
 */
export function verifyChain(
  receipts: readonly unknown[],
  publicKeyPem: string,
  opts: { anchor?: ChainHead; checkpoints?: readonly Checkpoint[] } = {},
): VerifyResult {
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
    if (!verifyText(publicKeyPem, r.hash, r.sig)) return { ok: false, seq: r.seq, reason: `receipt ${r.seq} has an invalid signature` };
    hashes.set(r.seq, r.hash);
    prev = r.hash;
    expected++;
  }

  const checkpoints = opts.checkpoints ?? [];
  for (const c of checkpoints) {
    if (!verifyCheckpoint(c, publicKeyPem)) return { ok: false, seq: c.seq, reason: `checkpoint at ${c.seq} has an invalid signature` };
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
