import { connectorFor, type Connector, type ConnectorKind, type ConnectorMode, type LiveConfig } from "@gate/connectors";
import { decrypt } from "@gate/core";
import { forOrg, prisma as defaultPrisma, recordHealthAlert, type Db } from "@gate/db";
import type { FastifyBaseLogger } from "fastify";
import type { GateEnv } from "./env";
import { createMailer, type Mailer } from "./mailer";

export interface Deps {
  env: GateEnv;
  db: Db;
  mailer: Mailer;
  live: LiveConfig;
  log: FastifyBaseLogger;
  /** Override in tests to swap connectors. */
  connector: (kind: ConnectorKind, mode: ConnectorMode) => Connector;
  /** Health alerts raised when even a refusal receipt cannot be written. */
  alerts: { at: string; kind: string; message: string; orgId?: string }[];
  /** Background demo runs, kept so tests and shutdown can await them. */
  background: Set<Promise<unknown>>;
}

export function makeDeps(env: GateEnv, log: FastifyBaseLogger, overrides: Partial<Deps> = {}): Deps {
  const live: LiveConfig = {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    ...(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET
      ? { zoho: { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, accountsUrl: env.ZOHO_ACCOUNTS_URL, apiUrl: env.ZOHO_API_URL } }
      : {}),
  };
  return {
    env,
    db: defaultPrisma,
    mailer: createMailer(env),
    live,
    log,
    connector: (kind, mode) => connectorFor(kind, mode, live),
    alerts: [],
    background: new Set(),
    ...overrides,
  };
}

const keyCache = new Map<string, string>();

/** The org's Ed25519 private key, decrypted with the master key. Never leaves this process. */
export async function orgKey(deps: Deps, orgId: string): Promise<{ privateKeyPem: string; publicKeyPem: string; name: string }> {
  const org = await forOrg(orgId, deps.db).org.findFirstOrThrow();
  let pem = keyCache.get(orgId);
  if (!pem) {
    pem = decrypt(deps.env.GATE_MASTER_KEY, org.privateKeyEnc, `org-key:${orgId}`);
    keyCache.set(orgId, pem);
  }
  return { privateKeyPem: pem, publicKeyPem: org.publicKey, name: org.name };
}

/** Record that Gate could not do its job. Never throws. */
export async function raiseAlert(deps: Deps, kind: string, message: string, orgId?: string) {
  deps.alerts.push({ at: new Date().toISOString(), kind, message, orgId });
  if (deps.alerts.length > 100) deps.alerts.shift();
  deps.log.error({ alert: kind, orgId }, message);
  try {
    await recordHealthAlert({ orgId, kind, message }, deps.db);
  } catch {
    // The database may be the thing that is down; the in-memory alert still shows on /healthz.
  }
}
