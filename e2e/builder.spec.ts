import { expect, test } from "@playwright/test";
import { Client, signInUI } from "./helpers";

test("build a rule visually and keep the YAML in sync, both ways", async ({ page }) => {
  const owner = await Client.owner("Builder Co");
  expect((await owner.send("POST", "/api/demo")).status()).toBe(200);
  await signInUI(page, owner.email);
  await page.goto("/rulebooks/ap-bot");
  const yaml = page.getByTestId("yaml");
  await expect(yaml).toHaveValue(/id: pay-large/);

  // Visual → YAML: add a rule, make it refuse sending replies to anyone.
  await page.getByRole("button", { name: "Add a rule" }).click();
  const rows = page.locator('[data-testid^="rule-"]');
  const row = rows.last();
  await row.getByLabel("Tool").selectOption("gmail.send_reply");
  await row.getByRole("radio", { name: "Refuse" }).click();
  await row.getByLabel("Rule id").fill("no-replies");
  await expect(yaml).toHaveValue(/- id: no-replies\n\s+tool: gmail\.send_reply\n\s+decide: refuse/);

  // YAML → visual: lower both payment thresholds in the text.
  const text = await yaml.inputValue();
  await yaml.fill(text.replace("lte: 50000", "lte: 40000").replace("gt: 50000", "gt: 40000"));
  const paySmall = rows.filter({ has: page.locator('input[value="pay-small"]') });
  await expect(paySmall.getByLabel("Amount in rupees")).toHaveValue("40000");

  // Try an action: ₹45,000 is now over the threshold, so the large-payment rule asks.
  await page.getByRole("tab", { name: "Try an action" }).click();
  await page.fill("#try-amount", "45000");
  const result = page.getByTestId("test-result");
  await expect(result).toContainText("pay-large");
  await expect(result.locator(".stamp")).toHaveText("Waiting");

  // The new refuse rule wins over the vendor-reply ask: strictest wins.
  await page.locator("#try-tool").selectOption("gmail.send_reply");
  await expect(result).toContainText("no-replies");
  await expect(result).toContainText("The strictest one wins");

  // Publish, then the history diff shows the change.
  await page.getByRole("button", { name: "Sign and publish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign and publish" }).click();
  await expect(page.getByText("Version 2 is signed and live.")).toBeVisible();
  await expect(page.getByText("No changes since the published version.")).toBeVisible();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByTestId("diff")).toContainText("+     tool: gmail.send_reply");
});

test("a high-risk agent cannot publish without an ask rule for payments", async ({ page }) => {
  const owner = await Client.owner("Blocked Co");
  await owner.send("POST", "/api/demo");
  await signInUI(page, owner.email);
  await page.goto("/rulebooks/ap-bot");
  const row = page.locator('[data-testid^="rule-"]').filter({ has: page.locator('input[value="pay-large"]') });
  await row.getByRole("button", { name: "Remove rule pay-large" }).click();
  await expect(page.getByText("Publishing is blocked")).toBeVisible();
  await expect(page.getByText(/High-risk agents need at least one "Ask" rule/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign and publish" })).toBeDisabled();
});

test("test a draft on past actions before publishing", async ({ page }) => {
  const owner = await Client.owner("Replay Co");
  expect((await owner.send("POST", "/api/demo")).status()).toBe(200);
  // The demo agent's steps: reads, a small payment, a large one, a bank change, an unknown tool.
  await expect(async () => expect(((await (await owner.get("/api/activity?decision=refuse")).json()).items as unknown[]).length).toBeGreaterThanOrEqual(2)).toPass({ timeout: 30_000 });
  await signInUI(page, owner.email);
  await page.goto("/rulebooks/ap-bot");
  const yaml = page.getByTestId("yaml");
  await expect(yaml).toHaveValue(/id: pay-large/);

  // Lower the payment threshold to ₹10,000: the ₹18,000 payment would now ask a person.
  const text = await yaml.inputValue();
  await yaml.fill(text.replace("lte: 50000", "lte: 10000").replace("gt: 50000", "gt: 10000"));

  await page.getByRole("tab", { name: "Test on past actions" }).click();
  await page.getByRole("radio", { name: "Last 7 days" }).click();
  await page.getByRole("button", { name: "Run test" }).click();
  // The unknown tool was refused before any rule was checked, so it cannot be judged.
  await expect(page.getByTestId("replay-summary")).toHaveText(/^Of \d+ calls, 1 more would ask a person and 1 fewer would be allowed\. 1 could not be judged\.$/);
  const changes = page.getByTestId("replay-changes");
  await expect(changes.getByRole("listitem")).toHaveCount(1);
  await expect(changes).toContainText("Pay ₹18,000 to Kaveri Logistics for KL-1187");
  await expect(changes).toContainText("Allowed");
  await expect(changes).toContainText("Ask a person");
  await expect(changes).toContainText("pay-large");
  await expect(page.getByTestId("replay-counts")).toContainText("Would change");

  // The publish confirmation repeats it for this draft.
  await page.getByRole("button", { name: "Sign and publish" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("publish-replay")).toContainText("1 more would ask a person");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Change the draft again: the result is marked out of date.
  await page.getByRole("tab", { name: "YAML" }).click();
  await yaml.fill((await yaml.inputValue()).replace("lte: 10000", "lte: 9000").replace("gt: 10000", "gt: 9000"));
  await page.getByRole("tab", { name: "Test on past actions" }).click();
  await expect(page.getByText("The rules changed since this test.")).toBeVisible();
});
