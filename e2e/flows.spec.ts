import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import { PASSWORD, uniqueEmail } from "./helpers";

test("sign up, run the demo agent, approve on a phone, see it in Activity, download and verify the auditor pack", async ({ browser }) => {
  const email = uniqueEmail("founder");

  // 1. Sign up and onboard on a laptop.
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await desk.newPage();
  const started = Date.now();
  await page.goto("/signup");
  await page.fill("#name", "Kavya Iyer");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
  await page.fill("#org", "Iyer Textiles Pvt Ltd");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/onboarding?step=industry");
  await page.getByText("Finance and accounting").click();
  await page.getByText("India", { exact: true }).click();
  await expect(page.getByText(/Gate will turn on: .*RBI FREE-AI/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/onboarding?step=demo");
  await page.getByRole("button", { name: "Try the demo agent" }).click();
  await page.waitForURL("**/?demo=1");
  expect(Date.now() - started, "onboarding takes under two minutes").toBeLessThan(120_000);

  // The demo agent runs in the background; the waiting card appears when it asks.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("1 action is waiting for you")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText("Pay ₹2,00,000 to Sharma Traders for INV-2291").first()).toBeVisible();
  await expect(page.getByText("Intact")).toBeVisible();

  // 2. Approve on a phone, signed in as the same person.
  const phone = await browser.newContext({ ...devices["Pixel 7"], storageState: await desk.storageState() });
  const m = await phone.newPage();
  await m.goto("/approvals");
  await expect(m.getByRole("heading", { name: "Pay ₹2,00,000 to Sharma Traders for INV-2291" })).toBeVisible();
  await expect(m.getByText("You set up this agent")).toBeVisible();
  await m.getByRole("button", { name: "Show the invoice (INV-2291.pdf)" }).click();
  await expect(m.getByText("Tax invoice")).toBeVisible();
  await m.fill("textarea", "Called Sharma Traders, amount and bank match.");
  await m.getByRole("button", { name: "Approve" }).click();
  await expect(m.getByText(/Approved\. .* is done \(PAY-/)).toBeVisible();
  await m.waitForURL(/\/approvals\/apr_/);
  await expect(m.locator(".stamp").getByText("Approved")).toBeVisible();
  await m.screenshot({ path: "test-results/approval-mobile.png" });
  await phone.close();

  // 3. Activity shows the approval and the payment's reference.
  await page.goto("/activity?decision=ask");
  await expect(page.getByText(/approved by .*PAY-/)).toBeVisible();
  await page.getByRole("button", { name: /Pay ₹2,00,000 to Sharma Traders/ }).first().click();
  await page.getByRole("button", { name: "Verify this receipt" }).click();
  await expect(page.getByText("Signed with this organisation's key")).toBeVisible();
  await page.keyboard.press("Escape");

  // 4. Download the auditor pack and verify it offline with the CLI.
  await page.goto("/evidence");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download auditor pack" }).click()]);
  const file = join(mkdtempSync(join(tmpdir(), "gate-pack-")), download.suggestedFilename());
  await download.saveAs(file);
  expect(download.suggestedFilename()).toMatch(/^auditor-pack-.*\.zip$/);
  const out = execFileSync("node", ["packages/cli/bin/gate.mjs", "verify", file], { encoding: "utf8" });
  expect(out).toMatch(/^Chain intact: \d+ receipts/);
  await desk.close();
});
