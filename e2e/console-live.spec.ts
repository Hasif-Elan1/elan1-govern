import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

// The approved console (apps/console) on the real backend, through the same origin (plans/console-app.md, Phase 1):
// the seeded demo people sign in through the console's own sign-in page, the organisation's document comes from the
// server, a change one person makes is saved (it survives a reload) and reaches another person's open console live,
// and the server refuses it, in the console's words, for a role that may not make it.

const PASSWORD = process.env.DEMO_CONSOLE_PASSWORD ?? "";
const RAHUL = "rahul.menon@demotraders.in"; // admin, Demo Traders (two-step sign-in)
const ANANYA = "ananya.rao@demotraders.in"; // owner
const MEERA = "meera.shah@demotraders.in"; // viewer (no two-step)
const FRAMEWORK = "HIPAA";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  test.skip(!PASSWORD, "DEMO_CONSOLE_PASSWORD is not set, so the console's demo people are not seeded.");
  // the console's four demo organisations and their people (idempotent); same database as the servers
  execFileSync("pnpm", ["db:seed"], { stdio: "inherit", env: process.env });
});

/** Problems the browser reports: a CSP refusal, a script error, a console error other than the first signed-out /api/me. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute)/i.test(t)) problems.push(`csp: ${t}`);
    else if (m.type() === "error" && !/status of 401/.test(t)) problems.push(`console: ${t}`);
  });
  return problems;
}

/** Sign in through the console's sign-in page; two-step accounts use the demo authenticator the server publishes. */
async function signIn(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page; problems: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto("/login?next=%2Fcompliance");
  await expect(page.getByRole("heading", { name: "Sign in to Elan1 Govern" })).toBeVisible();
  // the demo accounts panel comes from the server (GET /api/dev/demo-accounts)
  await expect(page.getByRole("heading", { name: "Demo accounts by assurance level" })).toBeVisible();
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const step2 = page.getByRole("heading", { name: "Enter your 6-digit code" });
  await expect(step2.or(page.getByRole("heading", { name: "Coverage" }))).toBeVisible();
  if (await step2.isVisible()) await page.getByRole("button", { name: "Use this code" }).click();
  await page.waitForURL("**/compliance");
  await expect(page.getByRole("heading", { name: "Coverage" })).toBeVisible();
  return { context, page, problems };
}

const frameworkSwitch = (page: Page) => page.getByRole("switch", { name: new RegExp(`^${FRAMEWORK} (on|off)$`) });
const isOn = async (page: Page) => (await frameworkSwitch(page).getAttribute("aria-checked")) === "true";

test("the start page is the console, served with this request's CSP nonce", async ({ request }) => {
  const res = await request.get("/approvals/apr_does_not_exist", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[\w-]+' 'strict-dynamic'/);
  const nonce = /'nonce-([\w-]+)'/.exec(csp)![1]!;
  const html = await res.text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).not.toContain("__GOVERN_CSP_NONCE__");
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${nonce}"`);
  // the built files are plain same-origin files; the API is still the API
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect((await request.get("/api/me")).status()).toBe(401);
});

test("a change is saved, survives a reload, reaches another person live, and is refused to a viewer", async ({ browser }) => {
  const rahul = await signIn(browser, RAHUL);
  const ananya = await signIn(browser, ANANYA);
  await expect(frameworkSwitch(rahul.page)).toBeVisible();
  await expect(frameworkSwitch(ananya.page)).toBeVisible();
  const before = await isOn(rahul.page);
  expect(await isOn(ananya.page)).toBe(before);

  // Rahul turns the framework on (or off, if an earlier run left it on): the server runs it as him
  await frameworkSwitch(rahul.page).click();
  await expect(rahul.page.getByText(`${FRAMEWORK} ${before ? "turned off" : "turned on"}`)).toBeVisible();
  await expect(frameworkSwitch(rahul.page)).toHaveAttribute("aria-checked", String(!before));

  // Ananya's console, open all along, shows it without a reload (the live stream)
  await expect(frameworkSwitch(ananya.page)).toHaveAttribute("aria-checked", String(!before), { timeout: 20_000 });

  // and it was saved: a reload reads it back from the server
  await rahul.page.reload();
  await expect(frameworkSwitch(rahul.page)).toHaveAttribute("aria-checked", String(!before));

  // and it is on the record: the newest receipt is the change, by Rahul (named from the server's directory)
  await rahul.page.goto("/activity");
  await expect(rahul.page.getByRole("row", { name: new RegExp(`just now Admin change RM Rahul Menon framework\\.${before ? "disabled" : "enabled"}`) }).first()).toBeVisible();

  // Meera is a viewer: the console offers her no switch, and the server refuses the action in the console's words
  const meera = await signIn(browser, MEERA);
  await expect(frameworkSwitch(meera.page)).toHaveCount(0);
  const refused = await meera.page.evaluate(async (short) => {
    const csrf = decodeURIComponent(/(?:^|;\s*)gate_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? "");
    const call = async (op: string, args: unknown[]) => {
      const r = await fetch("/api/console/rpc", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ op, args }) });
      return { status: r.status, body: (await r.json()) as { result?: { frameworks: { id: string; short: string; enabled: boolean }[] }; error?: string } };
    };
    const list = await call("api.compliance", ["org_demo"]);
    const f = list.body.result!.frameworks.find((x) => x.short === short)!;
    // she even names Rahul as the actor: the server acts as her
    return { ...(await call("api.setFramework", ["org_demo", f.id, !f.enabled, "u_rahul"])), enabled: f.enabled };
  }, FRAMEWORK);
  expect(refused.enabled).toBe(!before);
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/^(Enabling a framework|Switching a framework off) — Viewers cannot do this\.$/);

  // nothing changed for anyone
  await rahul.page.goto("/compliance");
  await expect(frameworkSwitch(rahul.page)).toHaveAttribute("aria-checked", String(!before));

  for (const p of [rahul, ananya]) expect(p.problems).toEqual([]);
  // (Meera's page logged the refusal it asked for, a 400, and nothing else)
  expect(meera.problems.filter((x) => !/status of 400/.test(x))).toEqual([]);
  for (const p of [rahul, ananya, meera]) await p.context.close();
});

test("signing out ends the server's session", async ({ browser }) => {
  const meera = await signIn(browser, MEERA);
  await meera.page.getByRole("button", { name: "Account menu" }).click();
  await meera.page.getByRole("menuitem", { name: "Sign out" }).click();
  await meera.page.waitForURL("**/login");
  expect((await meera.page.request.get("/api/me")).status()).toBe(401);
  // a console page now asks for sign-in again, and comes back after it
  await meera.page.goto("/compliance");
  await meera.page.waitForURL(/\/login\?next=%2Fcompliance/);
  await meera.context.close();
});
