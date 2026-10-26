import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hexSecret, loadEnv, registerExampleSecrets } from "@gate/db/env";
import { z } from "zod";

const Schema = z.object({
  DATABASE_URL: z.string().url(),
  WEB_ENC_KEY: hexSecret("WEB_ENC_KEY"),
  INTERNAL_API_SECRET: hexSecret("INTERNAL_API_SECRET"),
  APPROVAL_LINK_SECRET: hexSecret("APPROVAL_LINK_SECRET"),
  WEB_URL: z.string().url().default("http://localhost:3000"),
  GATE_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  GATE_INTERNAL_URL: z.string().url().default("http://localhost:4000"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  MAIL_FROM: z.string().default("Elan1 Govern <gate@localhost>"),
  CONNECTOR_MODE: z.enum(["mock", "live"]).default("mock"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_ID: z.string().optional(),
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
});

/** The value of NAME= in a dotenv file, without regular expressions. */
function exampleValue(text: string, name: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

export type WebEnv = z.infer<typeof Schema>;
let cached: WebEnv | undefined;

/** Validated config. Called at server start (instrumentation.ts) so a bad secret stops the server. */
export function env(): WebEnv {
  if (cached) return cached;
  for (const dir of [process.cwd(), resolve(process.cwd(), "../..")]) {
    const file = resolve(dir, ".env.example");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    registerExampleSecrets(
      ["WEB_ENC_KEY", "INTERNAL_API_SECRET", "APPROVAL_LINK_SECRET"].map((n) => exampleValue(text, n)).filter(Boolean),
    );
    break;
  }
  const source = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]));
  cached = loadEnv(Schema, source as NodeJS.ProcessEnv);
  return cached;
}
