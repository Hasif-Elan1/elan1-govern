import { createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GATE_PROFILES, sovereignProblems, type EgressTarget } from "@gate/db";
import { hexSecret, isExampleSecret, loadEnv, registerExampleSecrets } from "@gate/db/env";
import { z } from "zod";
import { isTsaId, TSA_CATALOG, TSA_IDS, type TsaCatalogEntry, type TsaId } from "./tsa/catalog";

const SECRET_NAMES = ["GATE_MASTER_KEY", "INTERNAL_API_SECRET", "APPROVAL_LINK_SECRET", "DEMO_CONSOLE_PASSWORD"] as const;

/** The value of NAME= in a dotenv file, without regular expressions. */
function exampleValue(text: string, name: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

const tsaIds = (list: string) => list.split(",").map((s) => s.trim()).filter(Boolean);
const unescapePem = (v: string | undefined) => v?.replaceAll("\\n", "\n");

/** True when the text holds at least one PEM certificate and every one of them parses. */
function pemCertsParse(pem: string): boolean {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  try {
    for (const b of blocks) new X509Certificate(b);
    return blocks.length > 0;
  } catch {
    return false;
  }
}

const CHAT_DEFAULTS = { SLACK_API_URL: "https://slack.com/api", WHATSAPP_API_URL: "https://graph.facebook.com/v21.0" } as const;

/** UPDATE_SIGNING_PUBLIC_KEYS as a list of base64 entries. */
export const releaseKeyList = (raw: string | undefined) => (raw ?? "").split(/[\s,]+/).filter(Boolean);

/** A base64 SPKI DER Ed25519 public key as PEM, or null if it is not one. */
export function releaseKeyPem(b64: string): string | null {
  try {
    const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key.export({ type: "spki", format: "pem" }).toString() : null;
  } catch {
    return null;
  }
}

export const GateEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  GATE_MASTER_KEY: hexSecret("GATE_MASTER_KEY"),
  INTERNAL_API_SECRET: hexSecret("INTERNAL_API_SECRET"),
  APPROVAL_LINK_SECRET: hexSecret("APPROVAL_LINK_SECRET"),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  GATE_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  GATE_INTERNAL_URL: z.string().url().default("http://localhost:4000"),
  GATE_PORT: z.coerce.number().int().default(4000),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  MAIL_FROM: z.string().default("Elan1 Govern <govern@localhost>"),
  CONNECTOR_MODE: z.enum(["mock", "live"]).default("mock"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_ACCOUNTS_URL: z.string().url().default("https://accounts.zoho.in"),
  ZOHO_API_URL: z.string().url().default("https://www.zohoapis.in"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_ENV: z.enum(["development", "production"]).default("development"),
  /** Let upstream MCP servers live on private, loopback or link-local addresses. Defaults to on outside production. */
  UPSTREAM_ALLOW_PRIVATE: z.enum(["true", "false"]).optional(),
  /** Let webhooks reach private, loopback and link-local addresses. Default: only outside production. */
  WEBHOOK_ALLOW_PRIVATE: z.enum(["true", "false"]).optional(),
  /** Postgres schema for the pg-boss job tables. */
  JOBS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default("pgboss"),
  /** The one password every console demo account gets from `pnpm db:seed`. Optional; without it the console's orgs are not seeded. */
  DEMO_CONSOLE_PASSWORD: z.string().min(12, "DEMO_CONSOLE_PASSWORD must be at least 12 characters").max(200).optional(),
  /** Who wraps (or holds) new org signing keys: the env master key, AWS KMS, or the software HSM. Rows keep the provider that wrapped them. */
  KEY_PROVIDER: z.enum(["env", "aws-kms", "soft-hsm"]).default("env"),
  /** The AWS KMS key (id, ARN or alias) for envelope encryption. Credentials come from the standard AWS chain. */
  AWS_KMS_KEY_ID: z.string().optional(),
  AWS_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/).optional(),
  /** Timestamp authorities for L2+ Merkle batches, comma-separated ids from tsa/catalog.ts; at least two. */
  TSA_AUTHORITIES: z.string().default("local-a,local-b"),
  /** Pinned CA certificate(s), PEM (newlines may be written as \n), that FreeTSA and DigiCert tokens must chain to. */
  TSA_FREETSA_CA_PEM: z.string().optional().transform(unescapePem),
  TSA_DIGICERT_CA_PEM: z.string().optional().transform(unescapePem),
  /** Slack Web API base URL. Only slack.com in production; tests point it at a local fake. Unset in the sovereign profile: no Slack. */
  SLACK_API_URL: z.string().url().optional(),
  /** WhatsApp Cloud API (Meta Graph API) base URL, with its version. Only graph.facebook.com in production. Unset in the sovereign profile: no WhatsApp. */
  WHATSAPP_API_URL: z.string().url().optional(),
  /** standard: Elan1-hosted or a normal install. sovereign: deny-all egress except EGRESS_ALLOW (see packages/db/src/egress.ts). */
  GATE_PROFILE: z.enum(GATE_PROFILES).default("standard"),
  /** Hosts outbound connections may reach in the sovereign profile: host, host:port or *.zone, comma separated. */
  EGRESS_ALLOW: z.string().optional(),
  /** Extra zones that count as inside the network (besides .internal, .local, private addresses...), e.g. corp.bank.co.in. */
  EGRESS_INTERNAL_DOMAINS: z.string().optional(),
  /** How long EgressLog rows are kept. */
  EGRESS_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** Elan1 release keys that sign update bundles: base64 SPKI DER Ed25519 public keys, comma separated. */
  UPDATE_SIGNING_PUBLIC_KEYS: z.string().optional(),
  /**
   * ── wiring ── The folder the operator copies update bundles into from the removable media (one sub-folder per
   * version). The console imports `<UPDATE_IMPORT_DIR>/<version>`; unset, bundles cannot be imported from the console.
   */
  UPDATE_IMPORT_DIR: z.string().optional(),
}).superRefine((e, ctx) => {
  const ids = tsaIds(e.TSA_AUTHORITIES);
  const problem = (message: string, path = "TSA_AUTHORITIES") => ctx.addIssue({ code: "custom", path: [path], message });
  const unknown = ids.filter((id) => !isTsaId(id));
  if (unknown.length) problem(`unknown timestamp authority ${unknown.join(", ")}; use ${TSA_IDS.join(", ")}`);
  if (new Set(ids).size !== ids.length) problem("lists an authority twice");
  if (new Set(ids).size < 2) problem("needs at least two timestamp authorities (one alone leaves every batch degraded)");
  for (const id of ids.filter(isTsaId)) {
    const entry: TsaCatalogEntry = TSA_CATALOG[id];
    if (entry.kind !== "http") continue;
    const pem = e[entry.caEnv];
    if (!pem) problem(`is required when TSA_AUTHORITIES includes ${id}: the CA its tokens must chain to`, entry.caEnv);
    else if (!pemCertsParse(pem)) problem("must hold one or more PEM certificates", entry.caEnv);
  }
}).superRefine((e, ctx) => {
  if (e.KEY_PROVIDER === "aws-kms") {
    for (const name of ["AWS_KMS_KEY_ID", "AWS_REGION"] as const) if (!e[name]) ctx.addIssue({ code: "custom", path: [name], message: "is required when KEY_PROVIDER=aws-kms" });
  }
}).superRefine((e, ctx) => {
  for (const k of releaseKeyList(e.UPDATE_SIGNING_PUBLIC_KEYS)) {
    if (!releaseKeyPem(k)) ctx.addIssue({ code: "custom", path: ["UPDATE_SIGNING_PUBLIC_KEYS"], message: "each entry must be a base64 Ed25519 public key (SPKI DER)" });
  }
  if (e.GATE_PROFILE === "sovereign") {
    // Deny-all egress: every configured endpoint must be an internal host on the allow-list,
    // the way production refuses sample secrets. Public SaaS (Slack, Meta, Google) is refused.
    const endpoints: { name: string; target: EgressTarget }[] = [{ name: "SMTP_HOST", target: { host: e.SMTP_HOST, port: e.SMTP_PORT } }];
    if (e.SLACK_API_URL) endpoints.push({ name: "SLACK_API_URL", target: e.SLACK_API_URL });
    if (e.WHATSAPP_API_URL) endpoints.push({ name: "WHATSAPP_API_URL", target: e.WHATSAPP_API_URL });
    if (e.CONNECTOR_MODE === "live" && e.GOOGLE_CLIENT_ID) ctx.addIssue({ code: "custom", path: ["GOOGLE_CLIENT_ID"], message: "Gmail is a public service; live Gmail is not available in the sovereign profile" });
    if (e.CONNECTOR_MODE === "live" && e.ZOHO_CLIENT_ID) endpoints.push({ name: "ZOHO_ACCOUNTS_URL", target: e.ZOHO_ACCOUNTS_URL }, { name: "ZOHO_API_URL", target: e.ZOHO_API_URL });
    for (const p of sovereignProblems({ allow: e.EGRESS_ALLOW, internalDomains: e.EGRESS_INTERNAL_DOMAINS }, endpoints)) ctx.addIssue({ code: "custom", path: [p.name], message: `${p.message} (GATE_PROFILE=sovereign)` });
    return;
  }
  if (e.APP_ENV !== "production") return;
  if (e.DEMO_CONSOLE_PASSWORD && isExampleSecret(e.DEMO_CONSOLE_PASSWORD)) {
    ctx.addIssue({ code: "custom", path: ["DEMO_CONSOLE_PASSWORD"], message: "DEMO_CONSOLE_PASSWORD is the example value from .env.example; set a real secret in production" });
  }
  for (const [name, host] of [["SLACK_API_URL", "slack.com"], ["WHATSAPP_API_URL", "graph.facebook.com"]] as const) {
    const u = new URL(e[name] ?? CHAT_DEFAULTS[name]);
    if (u.protocol !== "https:" || u.hostname !== host) ctx.addIssue({ code: "custom", path: [name], message: `must be an https://${host}/ URL in production` });
  }
}).transform((e) => ({
  ...e,
  WEBHOOK_ALLOW_PRIVATE: e.WEBHOOK_ALLOW_PRIVATE ? e.WEBHOOK_ALLOW_PRIVATE === "true" : e.APP_ENV !== "production",
  TSA_AUTHORITIES: tsaIds(e.TSA_AUTHORITIES) as TsaId[],
  // "" = not available (the sovereign profile with no internal relay configured).
  SLACK_API_URL: e.SLACK_API_URL ?? (e.GATE_PROFILE === "sovereign" ? "" : CHAT_DEFAULTS.SLACK_API_URL),
  WHATSAPP_API_URL: e.WHATSAPP_API_URL ?? (e.GATE_PROFILE === "sovereign" ? "" : CHAT_DEFAULTS.WHATSAPP_API_URL),
}));

export const allowPrivateUpstreams = (env: GateEnv) => (env.UPSTREAM_ALLOW_PRIVATE ? env.UPSTREAM_ALLOW_PRIVATE === "true" : env.APP_ENV !== "production");

export type GateEnv = z.infer<typeof GateEnvSchema>;

/** Reads the dev sample secrets from .env.example so production can refuse them. */
function registerExamples() {
  for (const dir of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "../..")]) {
    const file = resolve(dir, ".env.example");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    registerExampleSecrets(SECRET_NAMES.map((n) => exampleValue(text, n)).filter(Boolean));
    return;
  }
}

export function readGateEnv(source: NodeJS.ProcessEnv = process.env): GateEnv {
  registerExamples();
  const empty = (v: string | undefined) => (v === "" ? undefined : v);
  return loadEnv(GateEnvSchema, Object.fromEntries(Object.entries(source).map(([k, v]) => [k, empty(v)])));
}
