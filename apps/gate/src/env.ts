import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GATE_PROFILES, sovereignProblems, type EgressTarget } from "@gate/db";
import { hexSecret, loadEnv, registerExampleSecrets } from "@gate/db/env";
import { z } from "zod";

const SECRET_NAMES = ["GATE_MASTER_KEY", "INTERNAL_API_SECRET", "APPROVAL_LINK_SECRET"] as const;

/** The value of NAME= in a dotenv file, without regular expressions. */
function exampleValue(text: string, name: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
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
  for (const [name, host] of [["SLACK_API_URL", "slack.com"], ["WHATSAPP_API_URL", "graph.facebook.com"]] as const) {
    const u = new URL(e[name] ?? CHAT_DEFAULTS[name]);
    if (u.protocol !== "https:" || u.hostname !== host) ctx.addIssue({ code: "custom", path: [name], message: `must be an https://${host}/ URL in production` });
  }
}).transform((e) => ({
  ...e,
  WEBHOOK_ALLOW_PRIVATE: e.WEBHOOK_ALLOW_PRIVATE ? e.WEBHOOK_ALLOW_PRIVATE === "true" : e.APP_ENV !== "production",
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
