import {
  GENESIS,
  buildReceipt,
  signCheckpoint,
  type ChainHead,
  type Checkpoint,
  type Receipt,
  type ReceiptInput,
} from "@gate/core";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";
import { forOrg } from "./tenant";

type Tx = Parameters<Parameters<ReturnType<typeof forOrg>["$transaction"]>[0]>[0];
export type Append = (input: ReceiptInput) => Promise<Receipt>;

async function head(tx: Tx): Promise<ChainHead> {
  const last = await tx.receipt.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
  return last ? { seq: last.seq, hash: last.hash } : GENESIS;
}

/**
 * Runs `fn` inside one transaction holding the org's chain lock, so receipts
 * written by concurrent requests get consecutive seq numbers with no gaps.
 * Anything else `fn` writes with `tx` commits or rolls back with the receipts.
 */
export async function withChain<T>(
  orgId: string,
  privateKeyPem: string,
  fn: (append: Append, tx: Tx) => Promise<T>,
  client: PrismaClient = defaultClient,
): Promise<T> {
  const db = forOrg(orgId, client);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gate-chain:${orgId}`}))`;
      let current = await head(tx);
      const append: Append = async (input) => {
        const receipt = buildReceipt(input, { org: orgId, ts: new Date().toISOString(), head: current }, privateKeyPem);
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
      return fn(append, tx);
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
}

export async function appendReceipt(orgId: string, privateKeyPem: string, input: ReceiptInput, client?: PrismaClient) {
  return withChain(orgId, privateKeyPem, (append) => append(input), client);
}

/** Sign the current chain head. Skips if nothing changed since the last checkpoint. */
export async function createCheckpoint(orgId: string, privateKeyPem: string, client: PrismaClient = defaultClient): Promise<Checkpoint | null> {
  const db = forOrg(orgId, client);
  const [h, last] = await Promise.all([head(db as unknown as Tx), db.checkpoint.findFirst({ orderBy: { seq: "desc" } })]);
  if (h.seq === 0 || (last && last.seq === h.seq)) return null;
  const cp = signCheckpoint({ org: orgId, seq: h.seq, hash: h.hash, ts: new Date().toISOString() }, privateKeyPem);
  await db.checkpoint.create({ data: { orgId, seq: cp.seq, hash: cp.hash, ts: new Date(cp.ts), sig: cp.sig } });
  return cp;
}

export function toCheckpoint(row: { orgId: string; seq: number; hash: string; ts: Date; sig: string }): Checkpoint {
  return { org: row.orgId, seq: row.seq, hash: row.hash, ts: row.ts.toISOString(), sig: row.sig };
}

/** Midnight today in an IANA time zone. */
export function startOfDayIn(timeZone: string, now = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offset);
}

/**
 * How much of a quota is used: successful calls of these tools since `since`,
 * and the sum of one numeric summary field. One parameterised query; scoped by orgId.
 */
export async function quotaUsage(orgId: string, tools: string[], since: Date, field?: string, client: PrismaClient = defaultClient): Promise<{ count: number; sum: number }> {
  if (!tools.length) return { count: 0, sum: 0 };
  const f = field ?? "";
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
