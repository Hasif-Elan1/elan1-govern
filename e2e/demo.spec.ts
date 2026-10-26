import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { Client, signInUI } from "./helpers";

test("pnpm demo: five steps, approval in the UI lets the payment finish, and the evidence matches", async ({ page }) => {
  const owner = await Client.owner("Demo Run Co");
  const demo = (await (await owner.send("POST", "/api/demo")).json()) as { apiKey: string };
  // Wait for the background run that "Try the demo agent" starts, so the two runs don't overlap.
  await expect(async () => expect(((await (await owner.get("/api/activity?decision=refuse")).json()).items as unknown[]).length).toBeGreaterThanOrEqual(2)).toPass({ timeout: 30_000 });

  const proc = spawn("pnpm", ["demo"], { env: { ...process.env, DEMO_AGENT_KEY: demo.apiKey, FORCE_COLOR: "0" } });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number>((r) => proc.on("exit", (c) => r(c ?? 1)));

  await expect.poll(() => /\/approvals\/(apr_[\w-]+)/.exec(out)?.[1], { timeout: 60_000 }).toBeTruthy();
  const id = /\/approvals\/(apr_[\w-]+)/.exec(out)![1];
  expect(out).toMatch(/1\s+Read 3 invoice emails\s+allowed\s+read-mail/);
  expect(out).toMatch(/2\s+Pay ₹18,000 to Kaveri Logistics.*allowed\s+pay-small/);

  await signInUI(page, owner.email);
  await page.goto(`/approvals/${id}`);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".stamp").getByText("Approved")).toBeVisible();

  expect(await exited, out).toBe(0);
  expect(out).toMatch(/3\s+Pay ₹2,00,000 to Sharma Traders.*waiting\s+pay-large\s+approved · PAY-/);
  expect(out).toMatch(/4\s+Change Sharma Traders' bank account and IFSC\s+refused\s+no-bank-change/);
  expect(out).toMatch(/5\s+Delete an email.*refused\s+default/);
  expect(out).toContain("All 5 steps behaved as the rulebook says.");

  // Today reflects it, and the exported bundle verifies.
  // (The background run from "Try the demo agent" still has its own payment waiting.)
  await page.goto("/");
  await expect(page.getByText("Intact")).toBeVisible();
  await page.goto("/approvals");
  await expect(page.getByRole("link", { name: /Pay ₹2,00,000 to Sharma Traders.*approved by/ })).toBeVisible();
  await page.goto("/evidence");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Evidence bundle only" }).click()]);
  const file = join(mkdtempSync(join(tmpdir(), "gate-bundle-")), download.suggestedFilename());
  await download.saveAs(file);
  expect(execFileSync("node", ["packages/cli/bin/gate.mjs", "verify", file], { encoding: "utf8" })).toMatch(/^Chain intact: \d+ receipts/);
});
