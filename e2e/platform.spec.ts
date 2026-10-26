import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Client, signInUI } from "./helpers";

// Settings: webhooks (add, secret shown once, test event, delete) and signing-key rotation.
// The receiver runs on 127.0.0.1, which is allowed outside production (WEBHOOK_ALLOW_PRIVATE).

let server: Server;
let receiver: string;
const received: { headers: Record<string, unknown>; body: string }[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  receiver = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gate-events`;
});
test.afterAll(() => new Promise((r) => server.close(r)));

test("an owner adds a webhook, sends a test event, deletes it and rotates the signing key", async ({ page }) => {
  const owner = await Client.owner("Webhook Traders");
  await signInUI(page, owner.email);
  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();
  await page.fill("#wh-url", receiver);
  await page.getByLabel(/Action waiting for approval/).check();
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await expect(page.getByText("Copy it now: Elan1 Govern will not show it again.")).toBeVisible();
  const secret = await page.locator("code", { hasText: "whsec_" }).innerText();
  expect(secret).toMatch(/^whsec_/);
  await expect(page.getByText("127.0.0.1", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Send a test event" }).click();
  await expect(page.getByText("Test event delivered.")).toBeVisible();
  await expect.poll(() => received.some((r) => r.body.includes('"type":"webhook.test"'))).toBe(true);
  await expect(page.getByText("Delivered").first()).toBeVisible();

  // Reloading never shows the secret again.
  await page.reload();
  await expect(page.locator("code", { hasText: "whsec_" })).toHaveCount(0);

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog", { name: "Delete this endpoint?" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Endpoint deleted.")).toBeVisible();
  await expect(page.getByText("No endpoints yet.")).toBeVisible();

  // Signing keys: one in use; rotate with a confirm dialog; the old one is kept as retired.
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Signing keys" }) });
  await expect(section.getByText("In use")).toHaveCount(1);
  await page.getByRole("button", { name: "Rotate signing key" }).click();
  await expect(page.getByRole("dialog", { name: "Rotate the signing key?" })).toBeVisible();
  await page.getByRole("button", { name: "Rotate key" }).click();
  await expect(page.getByText(/New signing key [0-9a-f]{16} is in use/)).toBeVisible();
  await expect(section.getByText("In use")).toHaveCount(1);
  await expect(section.getByText(/^Retired/)).toHaveCount(1);

  // The chain still verifies across the rotation.
  await page.goto("/evidence");
  await expect(page.getByText("Intact")).toBeVisible();
});

test("only owners see the rotate button; admins manage webhooks; viewers see neither control", async ({ page }) => {
  const owner = await Client.owner("Roles Traders");
  const admin = await owner.invite("admin");
  const viewer = await owner.invite("viewer");
  await signInUI(page, admin.email);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rotate signing key" })).toHaveCount(0);
  await expect(page.getByText("Only owners can rotate the signing key.")).toBeVisible();
  await page.context().clearCookies();
  await signInUI(page, viewer.email);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Signing keys" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Webhooks" })).toHaveCount(0);
});
