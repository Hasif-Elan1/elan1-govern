import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";

// Reads for unusual-behaviour detection. Parameterised SQL over one org's receipts, always
// filtered by orgId and agent (the (orgId, agent) index), and only decision receipts.

export interface EventRow {
  seq: number;
  ts: Date;
  tool: string;
  decision: "allow" | "ask" | "refuse";
  summary: Record<string, unknown> | null;
}

/** An agent's decision receipts since `since`, oldest first (the newest `limit` if there are more). */
export async function behaviourEvents(orgId: string, agent: string, since: Date, client: PrismaClient = defaultClient, limit = 20_000): Promise<EventRow[]> {
  const rows = await client.$queryRaw<EventRow[]>`
    SELECT seq, ts, tool, decision, body->'args_summary' AS summary
    FROM "Receipt"
    WHERE "orgId" = ${orgId} AND agent = ${agent} AND kind = 'decision' AND tool IS NOT NULL AND decision IS NOT NULL
      AND ts >= (${since}::timestamptz AT TIME ZONE 'UTC')
    ORDER BY seq DESC
    LIMIT ${limit}`;
  return rows.reverse();
}

/** When the agent first acted, or null. */
export async function firstActivity(orgId: string, agent: string, client: PrismaClient = defaultClient): Promise<Date | null> {
  const rows = await client.$queryRaw<{ first: Date | null }[]>`
    SELECT MIN(ts) AS first FROM "Receipt" WHERE "orgId" = ${orgId} AND agent = ${agent} AND kind = 'decision'`;
  return rows[0]?.first ?? null;
}

/** Tools, and (field, value) pairs of the given summary fields, the agent used in [since, beforeSeq). */
export async function seenBefore(
  orgId: string,
  agent: string,
  opts: { since: Date; beforeSeq: number; fields: string[]; tools?: string[]; values?: string[] },
  client: PrismaClient = defaultClient,
): Promise<{ tools: string[]; pairs: { field: string; value: string }[] }> {
  const tools = await client.$queryRaw<{ tool: string }[]>`
    SELECT DISTINCT tool FROM "Receipt"
    WHERE "orgId" = ${orgId} AND agent = ${agent} AND kind = 'decision' AND tool IS NOT NULL AND seq < ${opts.beforeSeq}
      AND ts >= (${opts.since}::timestamptz AT TIME ZONE 'UTC')
      AND (${opts.tools ?? null}::text[] IS NULL OR tool = ANY(${opts.tools ?? []}::text[]))`;
  const pairs = opts.fields.length
    ? await client.$queryRaw<{ field: string; value: string }[]>`
        SELECT DISTINCT k.key AS field, k.value AS value
        FROM "Receipt" r, jsonb_each_text(COALESCE(r.body->'args_summary', '{}'::jsonb)) k
        WHERE r."orgId" = ${orgId} AND r.agent = ${agent} AND r.kind = 'decision' AND r.seq < ${opts.beforeSeq}
          AND r.ts >= (${opts.since}::timestamptz AT TIME ZONE 'UTC')
          AND k.key = ANY(${opts.fields}::text[])
          AND (${opts.values ?? null}::text[] IS NULL OR lower(trim(k.value)) = ANY(${opts.values ?? []}::text[]))`
    : [];
  return { tools: tools.map((t) => t.tool), pairs };
}

/** Earlier numeric values of one summary field for one tool, in [since, beforeSeq). */
export async function earlierAmounts(orgId: string, agent: string, opts: { tool: string; field: string; since: Date; beforeSeq: number }, client: PrismaClient = defaultClient): Promise<number[]> {
  const rows = await client.$queryRaw<{ v: number }[]>`
    SELECT (body->'args_summary'->>${opts.field})::float AS v
    FROM "Receipt"
    WHERE "orgId" = ${orgId} AND agent = ${agent} AND kind = 'decision' AND tool = ${opts.tool} AND seq < ${opts.beforeSeq}
      AND ts >= (${opts.since}::timestamptz AT TIME ZONE 'UTC')
      AND (body->'args_summary'->>${opts.field}) ~ '^-?[0-9]+([.][0-9]+)?$'
    ORDER BY seq DESC
    LIMIT 5000`;
  return rows.map((r) => r.v);
}
