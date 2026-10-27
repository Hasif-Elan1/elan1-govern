import { expect, test } from "@playwright/test";
import { Client, signInUI } from "./helpers";

// The emergency stop: typed confirmation, a red banner on every page, and a resume that
// starts only the agents the stop paused.

test("an owner stops every agent with a typed confirmation, sees the banner, and resumes", async ({ page }) => {
  const owner = await Client.owner("Stop Traders");
  expect((await owner.send("POST", "/api/demo", {})).status()).toBe(200);
  const viewer = await owner.invite("viewer");
  await signInUI(page, owner.email);

  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Alerts", exact: true })).toBeVisible();
  await expect(page.getByText("No open alerts")).toBeVisible();
  await page.getByRole("button", { name: "Emergency stop" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop every agent now?" });
  await expect(dialog).toBeVisible();
  const stop = dialog.getByRole("button", { name: "Stop all agents" });
  await expect(stop).toBeDisabled();
  await page.fill("#stop-confirm", "stop");
  await expect(stop).toBeDisabled();
  await page.fill("#stop-reason", "Checking a strange payment");
  await page.fill("#stop-confirm", "STOP");
  await stop.click();
  await expect(page.getByText("Emergency stop in place. 1 agent is paused.")).toBeVisible();

  // The banner shows on every page, and the agent is paused.
  const banner = page.getByRole("alert").filter({ hasText: "Emergency stop in place." });
  await expect(banner).toBeVisible();
  await page.goto("/agents/ap-bot");
  await expect(banner).toBeVisible();
  await expect(page.getByText("This agent is paused.")).toBeVisible();
  await page.goto("/activity?decision=admin");
  await expect(page.getByText("Emergency stop: paused 1 agent")).toBeVisible();

  // A viewer sees the banner but cannot resume, and has no stop button.
  const other = await page.context().browser()!.newContext();
  const vpage = await other.newPage();
  await signInUI(vpage, viewer.email);
  await vpage.goto("/alerts");
  await expect(vpage.getByRole("alert").filter({ hasText: "Emergency stop in place." })).toBeVisible();
  await expect(vpage.getByRole("button", { name: "Resume agents" })).toHaveCount(0);
  await expect(vpage.getByRole("button", { name: "Emergency stop" })).toHaveCount(0);
  await other.close();

  // Resume: one receipt, only the agents the stop paused.
  await page.goto("/alerts");
  await banner.getByRole("button", { name: "Resume agents" }).click();
  await page.getByRole("dialog", { name: "Resume the agents?" }).getByRole("button", { name: "Resume agents" }).click();
  await expect(page.getByText("1 agent is running again.")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.getByText("Emergency stops")).toBeVisible();
  await expect(page.getByText(/Resumed by/)).toBeVisible();
  await page.goto("/agents/ap-bot");
  await expect(page.getByText("This agent is paused.")).toHaveCount(0);
  await expect(page.getByText("Pause automatically on high-severity alerts")).toBeVisible();
  await expect(page.getByText(/Learning: 0 of 7 days/)).toBeVisible();
});
