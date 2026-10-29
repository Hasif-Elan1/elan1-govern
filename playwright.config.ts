import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// Load .env so tests and the servers they start share one configuration.
for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const GATE = process.env.GATE_PUBLIC_URL ?? "http://localhost:4000";
// the web app listens where WEB_URL says (next dev / next start read PORT)
const serverEnv = { ...(process.env as Record<string, string>), RATE_LIMIT_MULTIPLIER: "50", LOG_LEVEL: "warn", PORT: new URL(WEB).port || "3000" };

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL: WEB, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "e2e", testMatch: /flows\.spec\.ts|builder\.spec\.ts|demo\.spec\.ts|governance\.spec\.ts|platform\.spec\.ts|chat\.spec\.ts|suggestions\.spec\.ts|alerts\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "security", testMatch: /security\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    // the approved console on the real backend (plans/console-app.md, Phase 1)
    { name: "console", testMatch: /console-live\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    { command: "pnpm --filter @gate/gate start", url: `${GATE}/healthz`, reuseExistingServer: true, env: serverEnv, timeout: 60_000 },
    {
      // the console is built (when its sources changed) and copied into the web app first: it serves every page
      command: process.env.CI ? "pnpm --filter @gate/web console:assets && pnpm --filter @gate/web start" : "pnpm --filter @gate/web dev",
      url: `${WEB}/login`,
      reuseExistingServer: true,
      env: serverEnv,
      timeout: 180_000,
    },
  ],
});
