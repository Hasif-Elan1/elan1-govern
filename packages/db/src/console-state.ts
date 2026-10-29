import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";

// The console's organisation documents (ConsoleState). Parameterised SQL that always names the orgId. The
// document travels as JSON text both ways, so it is stored exactly as the console wrote it (key order kept)
// and never parsed here. ConsoleState is a tenant model: code outside this package reaches it only through
// these functions.

/** The raw client or a transaction: anything that runs SQL. */
type Sql = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
export type ConsoleSql = Sql;

/** The Postgres channel a saved document is announced on (payload: {"orgId", "kind", "version"}). */
export const CONSOLE_CHANNEL = "console_events";

export class ConsoleStateConflict extends Error {
  constructor(readonly orgId: string) {
    super(`The console document of ${orgId} was changed by someone else at the same time.`);
    this.name = "ConsoleStateConflict";
  }
}

export const consoleState = {
  /** Every stored document's version, by orgId. Reads no documents. */
  async versions(client: Sql = defaultClient): Promise<Map<string, number>> {
    const rows = await client.$queryRaw<{ orgId: string; version: number }[]>`SELECT "orgId", version FROM "ConsoleState"`;
    return new Map(rows.map((r) => [r.orgId, r.version]));
  },

  /** One organisation's stored version, or null before its first save. */
  async version(orgId: string, client: Sql = defaultClient): Promise<number | null> {
    const rows = await client.$queryRaw<{ version: number }[]>`SELECT version FROM "ConsoleState" WHERE "orgId" = ${orgId}`;
    return rows[0]?.version ?? null;
  },

  /** One organisation's document as JSON text, with its version; null before its first save. */
  async load(orgId: string, client: Sql = defaultClient): Promise<{ version: number; json: string } | null> {
    const rows = await client.$queryRaw<{ version: number; json: string }[]>`
      SELECT version, doc::text AS json FROM "ConsoleState" WHERE "orgId" = ${orgId}`;
    return rows[0] ?? null;
  },

  /**
   * Save a document (JSON text) only if the stored version is still `expectedVersion` (0: nothing stored yet).
   * Returns the new version; throws ConsoleStateConflict when someone else saved first.
   */
  async save(orgId: string, json: string, expectedVersion: number, client: Sql = defaultClient): Promise<number> {
    // Prisma stores DateTime as UTC in a plain "timestamp"
    const rows =
      expectedVersion === 0
        ? await client.$queryRaw<{ version: number }[]>`
            INSERT INTO "ConsoleState" ("orgId", doc, version, "updatedAt")
            VALUES (${orgId}, ${json}::json, 1, now() AT TIME ZONE 'UTC')
            ON CONFLICT ("orgId") DO NOTHING
            RETURNING version`
        : await client.$queryRaw<{ version: number }[]>`
            UPDATE "ConsoleState" SET doc = ${json}::json, version = version + 1, "updatedAt" = now() AT TIME ZONE 'UTC'
            WHERE "orgId" = ${orgId} AND version = ${expectedVersion}
            RETURNING version`;
    if (!rows[0]) throw new ConsoleStateConflict(orgId);
    return rows[0].version;
  },

  /**
   * Runs `fn` in one transaction holding the organisation's console lock, so operations on one organisation
   * from every web process run one at a time. Saves made with `tx` commit or roll back together. The lock is
   * the console's own (never the gate's chain lock), so a long console operation never holds up the guard.
   */
  withLock<T>(orgId: string, fn: (tx: Sql) => Promise<T>, client: PrismaClient = defaultClient): Promise<T> {
    return client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`console-state:${orgId}`}))`;
        return fn(tx);
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  },

  /** Announce a saved document to every LISTEN console_events connection. Call after the save committed. */
  async notify(event: { orgId: string; kind: string; version: number }, client: Sql = defaultClient): Promise<void> {
    await client.$executeRaw`SELECT pg_notify(${CONSOLE_CHANNEL}, ${JSON.stringify(event)})`;
  },
};
