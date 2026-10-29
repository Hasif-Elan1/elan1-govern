import {
  GENESIS,
  hashCanonical,
  prepareReceipt,
  signText,
  startOfDayIn,
  type ChainHead,
  type Checkpoint,
  type Receipt,
  type ReceiptInput,
} from "@gate/core";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";
import { forOrg } from "./tenant";

export type ChainTx = Parameters<Parameters<ReturnType<typeof forOrg>["$transaction"]>[0]>[0];
type Tx = ChainTx;
export type Append = (input: ReceiptInput) => Promise<Receipt>;

/**
 * A signing key and its id (fingerprint) to stamp on what it signs. Either the private key itself,
 * or a `sign` function for a key held inside a custody boundary (an HSM) that never hands it out.
 */
export type ChainKey = { kid?: string } & ({ privateKeyPem: string; sign?: undefined } | { sign: (text: string) => Promise<string>; privateKeyPem?: undefined });

/** Signs `text` (a hash) with a chain key, wherever the key is held. */
export async function signWithKey(key: ChainKey, text: string): Promise<string> {
  return key.sign ? key.sign(text) : signText(key.privateKeyPem, text);
}

/**
 * Where the signing key comes from. A function is called after the chain lock is taken, so a
 * key rotation that commits while this call waits for the lock is always seen: nothing is ever
 * signed with a key that was retired before the write.
 */
export type KeySource = string | ChainKey | ((tx: ChainTx) => Promise<ChainKey>);

async function resolveKey(key: KeySource, tx: Tx): Promise<ChainKey> {
  if (typeof key === "string") return { privateKeyPem: key };
  if (typeof key === "function") return key(tx);
  return key;
}

async function head(tx: Tx): Promise<ChainHead> {
  const last = await tx.receipt.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
  return last ? { seq: last.seq, hash: last.hash } : GENESIS;
}

const lock = (tx: Tx, orgId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gate-chain:${orgId}`}))`;

/**
 * Runs `fn` inside one transaction holding the org's chain lock, so receipts
 * written by concurrent requests get consecutive seq numbers with no gaps.
 * Anything else `fn` writes with `tx` commits or rolls back with the receipts.
 */
export async function withChain<T>(
  orgId: string,
  key: KeySource,
  fn: (append: Append, tx: Tx, signer: ChainKey) => Promise<T>,
  client: PrismaClient = defaultClient,
): Promise<T> {
  const db = forOrg(orgId, client);
  return db.$transaction(
    async (tx) => {
      await lock(tx, orgId);
      const signer = await resolveKey(key, tx);
      let current = await head(tx);
      const append: Append = async (input) => {
        const unsigned = prepareReceipt(input, { org: orgId, ts: new Date().toISOString(), head: current, kid: signer.kid });
        const receipt: Receipt = { ...unsigned, sig: await signWithKey(signer, unsigned.hash) };
        const amount = receipt.args_summary?.amount_inr;
        await tx.receipt.create({
          data: {
            orgId,
            seq: receipt.seq,
            ts: new Date(receipt.ts),
            kind: receipt.kind,
            agent: receipt.agent ?? null,
            tool: receipt.tool ?? null,
            decision: receipt.decision ?? null,
            amountInr: typeof amount === "number" ? amount : null,
            outcome: receipt.outcome?.status ?? null,
            action: receipt.action ?? null,
            body: receipt as object,
            hash: receipt.hash,
          },
        });
        current = { seq: receipt.seq, hash: receipt.hash };
        return receipt;
      };
      return fn(append, tx, signer);
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
}

export async function appendReceipt(orgId: string, key: KeySource, input: ReceiptInput, client?: PrismaClient) {
  return withChain(orgId, key, (append) => append(input), client);
}

/** Sign the current chain head. Skips if nothing changed since the last checkpoint. Takes the chain lock. */
export async function createCheckpoint(orgId: string, key: KeySource, client: PrismaClient = defaultClient): Promise<Checkpoint | null> {
  return forOrg(orgId, client).$transaction(async (tx) => {
    await lock(tx, orgId);
    const [h, last] = await Promise.all([head(tx), tx.checkpoint.findFirst({ orderBy: { seq: "desc" } })]);
    if (h.seq === 0 || (last && last.seq === h.seq)) return null;
    const signer = await resolveKey(key, tx);
    const unsigned = { org: orgId, seq: h.seq, hash: h.hash, ts: new Date().toISOString(), ...(signer.kid ? { kid: signer.kid } : {}) };
    const cp: Checkpoint = { ...unsigned, sig: await signWithKey(signer, hashCanonical(unsigned)) }; // as signCheckpoint does
    await tx.checkpoint.create({ data: { orgId, seq: cp.seq, hash: cp.hash, ts: new Date(cp.ts), kid: cp.kid ?? null, sig: cp.sig } });
    return cp;
  });
}

export function toCheckpoint(row: { orgId: string; seq: number; hash: string; ts: Date; kid?: string | null; sig: string }): Checkpoint {
  return { org: row.orgId, seq: row.seq, hash: row.hash, ts: row.ts.toISOString(), ...(row.kid ? { kid: row.kid } : {}), sig: row.sig };
}

/** Midnight today in an IANA time zone (the same function the replay uses). */
export { startOfDayIn };

/**
 * How much of a quota is used: successful calls of these tools since `since`,
 * and the sum of one numeric summary field. One parameterised query; scoped by orgId.
 */
/**
 * What a quota has used since `since`: completed calls of these tools, or, for a quota on one rule (`rule`), the
 * calls that rule allowed for that agent (as the console counts them).
 */
export async function quotaUsage(orgId: string, tools: string[], since: Date, field?: string, client: PrismaClient = defaultClient, rule?: { agent: string; ruleId: string }): Promise<{ count: number; sum: number }> {
  if (!tools.length) return { count: 0, sum: 0 };
  const f = field ?? "";
  if (rule) {
    const rows = await client.$queryRaw<{ count: number; sum: number }[]>`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(CASE WHEN (body->'args_summary'->>${f}) ~ '^-?[0-9]+([.][0-9]+)?$'
                               THEN (body->'args_summary'->>${f})::numeric ELSE 0 END), 0)::float AS sum
      FROM "Receipt"
      WHERE "orgId" = ${orgId} AND tool = ANY(${tools}) AND kind = 'decision' AND decision = 'allow'
        AND agent = ${rule.agent} AND body->>'rule_id' = ${rule.ruleId}
        AND ts >= (${since}::timestamptz AT TIME ZONE 'UTC')`;
    return rows[0] ?? { count: 0, sum: 0 };
  }
  const rows = await client.$queryRaw<{ count: number; sum: number }[]>`
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(CASE WHEN (body->'args_summary'->>${f}) ~ '^-?[0-9]+([.][0-9]+)?$'
                             THEN (body->'args_summary'->>${f})::numeric ELSE 0 END), 0)::float AS sum
    FROM "Receipt"
    WHERE "orgId" = ${orgId} AND tool = ANY(${tools}) AND outcome = 'ok'
      AND ts >= (${since}::timestamptz AT TIME ZONE 'UTC')`; // Prisma stores DateTime as UTC in a plain "timestamp"
  return rows[0] ?? { count: 0, sum: 0 };
}

/** Start of "today" in India (IST, UTC+05:30), used for daily limits and the Today screen. */
export function startOfDayIST(now = new Date()): Date {
  const offset = 330 * 60_000;
  const ist = new Date(now.getTime() + offset);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - offset);
}

export async function paymentsToday(orgId: string, client: PrismaClient = defaultClient, now = new Date()): Promise<number> {
  const agg = await forOrg(orgId, client).receipt.aggregate({
    _sum: { amountInr: true },
    where: { tool: "zoho.record_bill_payment", outcome: "ok", ts: { gte: startOfDayIST(now) } },
  });
  return agg._sum.amountInr ?? 0;
}
