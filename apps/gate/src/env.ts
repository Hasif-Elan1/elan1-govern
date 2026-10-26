import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hexSecret, loadEnv, registerExampleSecrets } from "@gate/db/env";
import { z } from "zod";

const SECRET_NAMES = ["GATE_MASTER_KEY", "INTERNAL_API_SECRET", "APPROVAL_LINK_SECRET"] as const;

/** The value of NAME= in a dotenv file, without regular expressions. */
function exampleValue(text: string, name: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
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
  MAIL_FROM: z.string().default("Gate <gate@localhost>"),
  CONNECTOR_MODE: z.enum(["mock", "live"]).default("mock"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_ACCOUNTS_URL: z.string().url().default("https://accounts.zoho.in"),
  ZOHO_API_URL: z.string().url().default("https://www.zohoapis.in"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

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
