import { createHash } from "node:crypto";
import { z } from "zod";

// Fingerprints of the dev-only values shipped in .env.example. They are fine on a
// laptop and refused when NODE_ENV=production.
export const EXAMPLE_SECRET_FINGERPRINTS = new Set<string>();

const fp = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16);

export function hexSecret(name: string) {
  return z
    .string({ required_error: `${name} is required` })
    .regex(/^[0-9a-f]{64}$/i, `${name} must be 64 hex characters (32 random bytes). Generate one with: openssl rand -hex 32`)
    .refine((v) => new Set(v.toLowerCase()).size >= 8, `${name} looks weak; generate a random value`)
    .refine(
      (v) => process.env.NODE_ENV !== "production" || !EXAMPLE_SECRET_FINGERPRINTS.has(fp(v)),
      `${name} is the example value from .env.example; set a real secret in production`,
    );
}

export function registerExampleSecrets(values: string[]) {
  for (const v of values) EXAMPLE_SECRET_FINGERPRINTS.add(fp(v));
}

/** Parse env against a schema or exit with a readable message. Secret values are never printed. */
export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Configuration error:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
