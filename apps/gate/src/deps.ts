import { connectorFor, type Connector, type ConnectorKind, type ConnectorMode, type LiveConfig } from "@gate/connectors";
import { forOrg, prisma as defaultPrisma, recordHealthAlert, type Db, type Egress } from "@gate/db";
import type { FastifyBaseLogger } from "fastify";
import { makeEgress } from "./egress";
import type { GateEnv } from "./env";
import { activePublicKey, envKeyProvider, type KeyProvider } from "./keys";
import { AwsKmsKeyProvider, kmsClient, type KmsSender } from "./kms";
import { SoftHsmKeyProvider } from "./soft-hsm";
import { createMailer, type Mailer } from "./mailer";

/** Where background work is queued. pg-boss in the running service; a no-op until jobs start. */
export interface JobQueue {
  send(queue: string, data: object, opts?: { startAfter?: number; singletonKey?: string }): Promise<void>;
}

export const noQueue: JobQueue = { send: async () => undefined };

export interface Deps {
  env: GateEnv;
  db: Db;
  /** Wraps (or holds) new org signing keys: KEY_PROVIDER (env master key, AWS KMS or the software HSM). */
  keys: KeyProvider;
  /** Other providers whose rows may still exist, so rows wrapped by each can be used side by side. `env` is always available. */
  keyProviders?: readonly KeyProvider[];
  queue: JobQueue;
  mailer: Mailer;
  /** Every outbound connection asks this first (packages/db/src/egress.ts). */
  egress: Egress;
  live: LiveConfig;
  log: FastifyBaseLogger;
  /** Override in tests to swap connectors. */
  connector: (kind: ConnectorKind, mode: ConnectorMode) => Connector;
  /** Health alerts raised when even a refusal receipt cannot be written. */
  alerts: { at: string; kind: string; message: string; orgId?: string }[];
  /** Background demo runs, kept so tests and shutdown can await them. */
  background: Set<Promise<unknown>>;
  /** Override in tests: the post-commit behaviour check for new decision receipts (see behaviour.ts). */
  behaviourInline?: (deps: Deps, orgId: string, receipts: readonly import("@gate/core").Receipt[]) => Promise<unknown>;
  /** Override in tests: the organisations a platform-wide event (an update step) is receipted to. Default: every org. */
  platformOrgs?: () => Promise<string[]>;
}

/**
 * The key providers this environment can use: the env master key and the software HSM always, AWS
 * KMS when a key id and region are set (`kms` overrides the client, for tests). `active` is
 * KEY_PROVIDER, the one new keys go to.
 */
export function keyProvidersFromEnv(env: GateEnv, db: Db, kms?: KmsSender): { active: KeyProvider; all: KeyProvider[] } {
  const all: KeyProvider[] = [envKeyProvider(env.GATE_MASTER_KEY), new SoftHsmKeyProvider(env.GATE_MASTER_KEY, db)];
  if (env.AWS_KMS_KEY_ID && env.AWS_REGION) all.push(new AwsKmsKeyProvider({ keyId: env.AWS_KMS_KEY_ID, client: kms ?? kmsClient(env.AWS_REGION) }));
  const active = all.find((p) => p.name === env.KEY_PROVIDER);
  if (!active) throw new Error(`KEY_PROVIDER=${env.KEY_PROVIDER} is not configured`);
  return { active, all };
}

export function makeDeps(env: GateEnv, log: FastifyBaseLogger, overrides: Partial<Deps> = {}): Deps {
  const db = overrides.db ?? defaultPrisma;
  const providers = keyProvidersFromEnv(env, db);
  // The egress gate writes receipts through the finished deps, so it is bound late.
  const egress = overrides.egress ?? makeEgress(env, log, () => self);
  const live: LiveConfig = {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    ...(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET
      ? { zoho: { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, accountsUrl: env.ZOHO_ACCOUNTS_URL, apiUrl: env.ZOHO_API_URL } }
      : {}),
    // Live connectors ask the egress gate before every request, for the calling organisation.
    egress: (url, orgId) => egress.check(url, "connector", { orgId }).then(() => undefined),
  };
  const self: Deps = {
    env,
    db,
    mailer: createMailer(env, egress),
    egress,
    live,
    log,
    connector: (kind, mode) => connectorFor(kind, mode, live),
    alerts: [],
    background: new Set(),
    keys: providers.active,
    keyProviders: providers.all,
    queue: noQueue,
    ...overrides,
  };
  return self;
}

/**
 * The org's active key id and public key, and the org's name. The private key is not touched:
 * chain writes sign under the chain lock (see `signer` in keys.ts), and the few in-process signers
 * that need the private key ask `activeKey` for it.
 */
export async function orgKey(deps: Deps, orgId: string): Promise<{ kid: string; publicKeyPem: string; name: string }> {
  const org = await forOrg(orgId, deps.db).org.findFirstOrThrow({ select: { name: true } });
  return { ...(await activePublicKey(deps, orgId)), name: org.name };
}

/** Record that Elan1 Govern could not do its job. Never throws. */
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
