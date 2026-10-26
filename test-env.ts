import { loadEnv } from "vite";

/** .env values for tests, pointed at the test database. */
export function testEnv(): Record<string, string> {
  const env = loadEnv("test", __dirname, "");
  return { ...env, DATABASE_URL: env.TEST_DATABASE_URL ?? env.DATABASE_URL ?? "", NODE_ENV: "test", LOG_LEVEL: "silent" };
}
