import type { AddressInfo } from "node:net";
import { consoleState, prisma } from "@gate/db";

/*
 * The console's receipts are written by the real gate service (apps/web/src/server/console-chain.ts), so the
 * console tests run one: the gate's own app, in this process, on a free port. The web app's gate() calls reach it
 * through GATE_INTERNAL_URL, signed as in production. The console's four demo organisations are seeded into the
 * test database (once, whichever test file gets there first).
 *
 * The gate's sources compile under their own settings, so they are loaded by path rather than imported: only the
 * little this file uses is typed here.
 */

interface GateDeps {
  background: Set<Promise<unknown>>;
}
interface GateApp {
  listen(o: { port: number; host: string }): Promise<string>;
  close(): Promise<void>;
  server: { address(): AddressInfo | string | null };
}
interface GateModules {
  app: { buildApp(env: unknown, overrides: { mailer: { send(m: unknown): Promise<void> } }): Promise<{ app: GateApp; deps: GateDeps }> };
  env: { readGateEnv(): unknown };
  seed: { seedConsoleDemo(deps: GateDeps, opts: { password: string; webEncKey: string }): Promise<unknown> };
}

const gateModule = async <K extends keyof GateModules>(name: K): Promise<GateModules[K]> =>
  (await import(/* @vite-ignore */ new URL(`../../gate/src/${name}.ts`, import.meta.url).href)) as GateModules[K];

export interface GateService {
  deps: GateDeps;
  close: () => Promise<void>;
}

export async function startGate(): Promise<GateService> {
  const [{ buildApp }, { readGateEnv }, { seedConsoleDemo }] = await Promise.all([gateModule("app"), gateModule("env"), gateModule("seed")]);
  const { app, deps } = await buildApp(readGateEnv(), { mailer: { send: async () => undefined } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  // read by the web app's env() on its first call, which comes after this
  process.env.GATE_INTERNAL_URL = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('console-test-seed'))`;
      // the password apps/gate/test/console-seed.test.ts checks: whichever test seeds first, both see the same accounts
      await seedConsoleDemo(deps, { password: "seed test demo password", webEncKey: process.env.WEB_ENC_KEY! });
    },
    { maxWait: 60_000, timeout: 120_000 },
  );
  return {
    deps,
    close: async () => {
      for (let i = 0; i < 5 && deps.background.size; i++) await Promise.all([...deps.background]);
      await app.close();
    },
  };
}

/**
 * Put a console organisation back to where the seed left it: its chain without the imported demo history and
 * everything after it, and no saved document. The next operation builds it (and imports the history) again.
 */
export async function resetConsoleOrg(orgId: string) {
  const marker = await prisma.receipt.findFirst({ where: { orgId, action: "console.history_imported" } });
  const from = (marker?.body as { details?: { from_seq?: number } } | undefined)?.details?.from_seq;
  if (from) {
    await prisma.receipt.deleteMany({ where: { orgId, seq: { gte: from } } });
    await prisma.checkpoint.deleteMany({ where: { orgId, seq: { gte: from } } });
  }
  await prisma.$executeRaw`DELETE FROM "ConsoleState" WHERE "orgId" = ${orgId}`;
  return consoleState.version(orgId);
}
