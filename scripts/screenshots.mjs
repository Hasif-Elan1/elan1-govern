// Screenshots of every main screen for the README: node scripts/screenshots.mjs
// Needs the stack running (pnpm dev) and the seeded demo org (pnpm db:seed).
import { mkdirSync } from "node:fs";
import { chromium, devices } from "@playwright/test";
import { loadEnv, root } from "./lib.mjs";

const env = loadEnv();
const WEB = env.WEB_URL ?? "http://localhost:3000";
const OUT = `${root}docs/screenshots`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function signedIn(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...options });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`);
  await page.fill("#email", "owner@demo.test");
  await page.fill("#password", env.DEMO_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return { ctx, page };
}

async function shot(page, name, path, { full = false, before } = {}) {
  await page.goto(`${WEB}${path}`, { waitUntil: "networkidle" });
  if (before) await before(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log(`  ${name}.png`);
}

// Signed out
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await shot(page, "01-sign-in", "/login");
  await ctx.close();
}

const { ctx, page } = await signedIn();
// Make sure something is waiting: run the demo agent once.
await page.evaluate(async () => {
  const csrf = /(?:^|;\s*)gate_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? "";
  await fetch("/api/demo", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": decodeURIComponent(csrf) } });
});
await page.waitForTimeout(6000);

await shot(page, "02-today", "/");
await shot(page, "03-approvals", "/approvals");
await shot(page, "04-activity", "/activity", {
  before: async (p) => {
    await p.getByRole("button", { name: /Pay ₹2,00,000/ }).first().click();
    await p.getByRole("button", { name: "Verify this receipt" }).click();
  },
});
await shot(page, "05-agents", "/agents");
await shot(page, "06-agent", "/agents/ap-bot");
await shot(page, "07-add-agent", "/agents/new", {
  before: async (p) => {
    await p.fill("#agent-name", "Support bot");
    await p.fill("#agent-purpose", "Answers customer emails and drafts replies for the support team.");
    await p.getByRole("button", { name: "Continue" }).click();
    for (const label of ["No", "Yes", "Yes", "Under ₹50,000", "Now and then"]) {
      const groups = p.locator("fieldset");
      for (let i = 0; i < (await groups.count()); i++) {
        const g = groups.nth(i);
        if (!(await g.locator("label.border-accent").count())) {
          await g.getByText(label, { exact: true }).click();
          break;
        }
      }
    }
  },
});
await shot(page, "08-rule-builder", "/rulebooks/ap-bot", { before: async (p) => p.getByRole("tab", { name: "Try an action" }).click() });
await shot(page, "09-connectors", "/connectors");
await shot(page, "10-evidence", "/evidence");
await shot(page, "11-settings", "/settings");
await shot(page, "15-inventory", "/inventory");
await shot(page, "16-assessments", "/assessments");
await shot(page, "17-compliance", "/compliance");
await shot(page, "18-compliance-eu-ai-act", "/compliance/eu-ai-act");
await shot(page, "19-single-sign-on", "/settings/sso");
await ctx.close();

// Dark mode
{
  const { ctx: dark, page: p } = await signedIn({ colorScheme: "dark" });
  await shot(p, "12-today-dark", "/");
  await shot(p, "13-rule-builder-dark", "/rulebooks/ap-bot");
  await dark.close();
}

// Phone: the approval page
{
  const { ctx: phone, page: p } = await signedIn({ ...devices["Pixel 7"], viewport: undefined, deviceScaleFactor: 2 });
  await p.goto(`${WEB}/approvals`, { waitUntil: "networkidle" });
  const link = p.getByRole("link", { name: /Pay ₹2,00,000/ }).first();
  const href = await link.getAttribute("href");
  await shot(p, "14-approval-phone", href ?? "/approvals", { full: true, before: async (pp) => pp.getByRole("button", { name: /Show the invoice/ }).click().catch(() => undefined) });
  await phone.close();
}

await browser.close();
console.log(`Saved to docs/screenshots`);
