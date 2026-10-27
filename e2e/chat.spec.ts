import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { Client, signInUI } from "./helpers";

// Approvals in Slack and WhatsApp: Settings → Notifications, and the rule builder's chat switch.
// When the gate runs with SLACK_API_URL pointing at 127.0.0.1, a fake Slack Web API answers here
// so the connect flow runs end to end; otherwise only validation is checked.

const slackApi = process.env.SLACK_API_URL ?? "";
const fakeSlack = /^http:\/\/127\.0\.0\.1:\d+\/api$/.test(slackApi) ? new URL(slackApi) : null;
let server: Server | null = null;

test.beforeAll(async () => {
  if (!fakeSlack) return;
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const ok = req.url === "/api/auth.test" && req.headers.authorization === "Bearer xoxb-1234567890-e2etoken";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ok ? { ok: true, team_id: "T0E2E", team: "E2E Workspace" } : { ok: false, error: "invalid_auth" }));
    });
  });
  await new Promise<void>((r) => server!.listen(Number(fakeSlack.port), "127.0.0.1", r));
});
test.afterAll(() => (server ? new Promise((r) => server!.close(r)) : undefined));

test("connect Slack in settings, and mark a rule as approvable in chat only where it is allowed", async ({ page }) => {
  const owner = await Client.owner("Chat Traders");
  expect((await owner.send("POST", "/api/demo")).status()).toBe(200);
  await signInUI(page, owner.email);

  // ---- Settings → Notifications ----
  await page.goto("/settings");
  await page.getByRole("link", { name: "Set up notifications" }).click();
  await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
  await expect(page.getByText("WhatsApp is not connected for this organisation yet.")).toBeVisible();
  await page.fill("#slack-token", "xoxp-not-a-bot-token");
  await page.fill("#slack-secret", "0123456789abcdef0123456789abcdef");
  await page.fill("#slack-channel", "C0E2EAPPROVALS");
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await expect(page.getByTestId("slack-form").getByRole("alert")).toContainText("The bot token starts with xoxb-");
  if (fakeSlack) {
    await page.fill("#slack-token", "xoxb-1234567890-e2etoken");
    await page.getByRole("button", { name: "Connect Slack" }).click();
    await expect(page.getByText("Slack is connected.")).toBeVisible();
    await expect(page.getByText(/\/chat\/slack\/[A-Za-z0-9_-]+\/interactions/).first()).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("slack-card")).toContainText("E2E Workspace, channel C0E2EAPPROVALS");
    // The secrets never come back to the browser.
    expect(await page.content()).not.toContain("xoxb-1234567890-e2etoken");
  }

  // ---- Rule builder ----
  await page.goto("/rulebooks/ap-bot");
  const yaml = page.getByTestId("yaml");
  const rows = page.locator('[data-testid^="rule-"]');
  const index = async (id: string) => {
    const n = await rows.count();
    for (let i = 0; i < n; i++) if ((await rows.nth(i).locator('input[id^="rule-id-"]').inputValue()) === id) return i;
    throw new Error(`no rule ${id}`);
  };

  // Emails to vendors touch personal data: app-only, switch disabled with the reason.
  const reply = await index("reply-vendor");
  await expect(page.getByTestId(`chat-${reply}`)).toBeDisabled();
  await expect(page.getByTestId(`chat-reason-${reply}`)).toContainText("touches personal data");

  // Large payments with no upper amount: disabled until the rule has a cap.
  const pay = await index("pay-large");
  await expect(page.getByTestId(`chat-${pay}`)).toBeDisabled();
  await expect(page.getByTestId(`chat-reason-${pay}`)).toContainText("no upper amount");
  await yaml.fill((await yaml.inputValue()).replace("when: { amount_inr: { gt: 50000 } }", "when: { amount_inr: { gt: 50000, lte: 200000 } }"));
  await expect(page.getByTestId(`chat-${pay}`)).toBeEnabled();
  await expect(page.getByTestId(`chat-reason-${pay}`)).toHaveCount(0);

  // Visual → YAML.
  await page.getByTestId(`chat-${pay}`).check();
  await expect(yaml).toHaveValue(/id: pay-large[\s\S]*?approve_in_chat: true/);
  // YAML → visual, and publishing refuses it on an app-only rule.
  await yaml.fill((await yaml.inputValue()).replace('reason: Emails to vendors are read by a person before they go out.', 'reason: Emails to vendors are read by a person before they go out.\n    approve_in_chat: true'));
  await expect(page.getByTestId(`chat-${reply}`)).toBeChecked();
  await expect(page.getByRole("alert").filter({ hasText: 'Rule "reply-vendor" cannot be approved in Slack or WhatsApp.' })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign and publish" })).toBeDisabled();
  // A blocked rule can still be switched off.
  await page.getByTestId(`chat-${reply}`).uncheck();
  await expect(yaml).not.toHaveValue(/reason: Emails to vendors are read by a person before they go out.\n\s+approve_in_chat/);

  await page.getByRole("button", { name: "Sign and publish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign and publish" }).click();
  await expect(page.getByText("Version 2 is signed and live.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId(`chat-${pay}`)).toBeChecked();
});
