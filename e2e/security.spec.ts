import { hmacSign } from "@gate/core";
import { request as pwRequest, expect, test } from "@playwright/test";
import { approvalLinkFor, Client, signInUI, WEB } from "./helpers";

// HTTP-level security tests against the running web app. The gate service has its own
// integration tests (fail-closed, token isolation, signature checks).

type Role = "owner" | "admin" | "approver" | "viewer" | "auditor";
const ROLES: Role[] = ["owner", "admin", "approver", "viewer", "auditor"];

let users: Record<Role, Client>;
let other: Client;
let orgA: string;
let approvalId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const owner = await Client.owner("Matrix Traders");
  expect((await owner.send("POST", "/api/demo")).status()).toBe(200);
  users = { owner, admin: await owner.invite("admin"), approver: await owner.invite("approver"), viewer: await owner.invite("viewer"), auditor: await owner.invite("auditor") };
  other = await Client.owner("Other Co");
  orgA = ((await (await owner.get("/api/receipts/1")).json()) as { receipt: { org: string } }).receipt.org;
  await expect
    .poll(async () => ((await (await owner.get("/api/activity?decision=ask")).json()).items as { approvalId?: string }[])[0]?.approvalId, { timeout: 30_000 })
    .toBeTruthy();
  approvalId = ((await (await owner.get("/api/activity?decision=ask")).json()).items as { approvalId: string }[])[0]!.approvalId;
});

// ---- Authorisation matrix: every role against every route ----

type RouteCase = { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown; allowed: Role[] };
const ALL = ROLES;
const ADMINS: Role[] = ["owner", "admin"];
// Bodies are deliberately invalid: an allowed role gets past the permission check and fails validation (400),
// a denied role is stopped first (403). Nothing is changed either way.
const API: RouteCase[] = [
  { method: "GET", path: "/api/activity", allowed: ALL },
  { method: "GET", path: "/api/receipts/1", allowed: ALL },
  { method: "POST", path: "/api/agents", body: {}, allowed: ADMINS },
  { method: "POST", path: "/api/agents/ap-bot/status", body: {}, allowed: ADMINS },
  { method: "POST", path: "/api/agents/ap-bot/keys", body: { nope: 1 }, allowed: ADMINS },
  { method: "POST", path: "/api/rulebooks/ap-bot", body: {}, allowed: ADMINS },
  { method: "POST", path: "/api/connectors/gmail", body: {}, allowed: ADMINS },
  { method: "POST", path: "/api/evidence/export", body: {}, allowed: ["owner", "admin", "auditor"] },
  { method: "PATCH", path: "/api/settings", body: { name: 1 }, allowed: ADMINS },
  { method: "POST", path: "/api/members", body: {}, allowed: ADMINS },
  { method: "PATCH", path: "/api/members/nobody", body: {}, allowed: ADMINS },
  { method: "POST", path: "/api/approvals/apr_none", body: {}, allowed: ["owner", "admin", "approver"] },
  { method: "POST", path: "/api/webhooks", body: {}, allowed: ADMINS },
  { method: "DELETE", path: "/api/webhooks/wh_none", allowed: ADMINS },
  { method: "POST", path: "/api/webhooks/wh_none/test", allowed: ADMINS },
  // Owners only, with a fresh sign-in; the empty body fails validation (400), so nothing rotates.
  { method: "POST", path: "/api/signing-key", body: {}, allowed: ["owner"] },
];

test("authz matrix: API routes", async () => {
  const failures: string[] = [];
  for (const r of API) {
    for (const role of ROLES) {
      const c = users[role];
      const res = r.method === "GET" ? await c.get(r.path) : await c.send(r.method, r.path, r.body);
      const allowed = r.allowed.includes(role);
      const ok = allowed ? res.status() !== 403 && res.status() !== 401 : res.status() === 403;
      if (!ok) failures.push(`${role} ${r.method} ${r.path} -> ${res.status()} (expected ${allowed ? "allowed" : "403"})`);
    }
  }
  expect(failures).toEqual([]);
});

test("authz matrix: side-effect routes", async () => {
  for (const role of ROLES) {
    const checkpoint = await users[role].send("POST", "/api/evidence/checkpoint");
    expect(checkpoint.status(), `${role} checkpoint`).toBe(["owner", "admin", "auditor"].includes(role) ? 200 : 403);
    const del = await users[role].send("DELETE", "/api/members/nobody");
    expect(del.status(), `${role} delete member`).toBe(ADMINS.includes(role) ? 404 : 403);
    if (!ADMINS.includes(role)) expect((await users[role].send("POST", "/api/demo")).status(), `${role} demo`).toBe(403);
  }
});

test("authz matrix: pages", async () => {
  const pages = ["/", "/approvals", "/activity", "/agents", "/agents/ap-bot", "/rulebooks", "/rulebooks/ap-bot", "/connectors", "/evidence", "/settings"];
  const anon = await Client.anonymous();
  for (const p of [...pages, "/agents/new"]) {
    const res = await anon.get(p);
    expect(res.status(), `anonymous ${p}`).toBe(307);
    expect(res.headers().location, `anonymous ${p}`).toMatch(/\/login/);
  }
  for (const role of ROLES) {
    for (const p of pages) expect((await users[role].get(p)).status(), `${role} ${p}`).toBe(200);
    expect((await users[role].get("/agents/new")).status(), `${role} /agents/new`).toBe(ADMINS.includes(role) ? 200 : 307);
  }
  // Anonymous API calls are refused, not redirected.
  expect((await anon.get("/api/activity")).status()).toBe(401);
});

// ---- Tenant isolation ----

test("another org cannot see or act on this org's data", async () => {
  expect((await other.get(`/approvals/${approvalId}`)).status()).toBe(404);
  expect((await other.send("POST", `/api/approvals/${approvalId}`, { result: "approved" })).status()).toBe(404);
  expect((await other.send("POST", "/api/agents/ap-bot/status", { status: "paused" })).status()).toBe(404);
  expect((await other.get("/agents/ap-bot")).status()).toBe(404);
  expect((await other.send("PUT", "/api/orgs", { orgId: orgA })).status()).toBe(403);
  const r1 = (await (await other.get("/api/receipts/1")).json()) as { receipt: { org: string } };
  expect(r1.receipt.org).not.toBe(orgA);
  const act = (await (await other.get("/api/activity?q=Sharma")).json()) as { items: unknown[] };
  expect(act.items).toHaveLength(0);
  // An emailed link for org A's approval does not work for org B's user.
  const link = await approvalLinkFor(users.owner.email);
  const page = await other.get(new URL(link).pathname);
  expect(await page.text()).toContain("This approval is for another organisation");
});

// ---- Approval links, approvers, self-approval ----

test("approval links: forged, expired and wrong-approver attempts fail; the right approver succeeds once", async () => {
  const link = await approvalLinkFor(users.owner.email);
  const token = decodeURIComponent(link.split("/approve/")[1]!);
  const body = (t: string) => ({ result: "approved", token: t });

  expect((await users.owner.send("POST", `/api/approvals/${approvalId}`, body(`${token}x`))).status()).toBe(400);
  const parts = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()) as { o: string; a: string; l: string };
  const expired = hmacSign(process.env.APPROVAL_LINK_SECRET!, { ...parts, x: Math.floor(Date.now() / 1000) - 60 });
  expect((await users.owner.send("POST", `/api/approvals/${approvalId}`, body(expired))).status()).toBe(410);
  const otherApproval = hmacSign(process.env.APPROVAL_LINK_SECRET!, { ...parts, a: "apr_other", x: Math.floor(Date.now() / 1000) + 600 });
  expect((await users.owner.send("POST", `/api/approvals/${approvalId}`, body(otherApproval))).status()).toBe(400);

  // Roles that cannot approve, and an approver who is not named in the rule.
  expect((await users.viewer.send("POST", `/api/approvals/${approvalId}`, body(token))).status()).toBe(403);
  expect((await users.auditor.send("POST", `/api/approvals/${approvalId}`, body(token))).status()).toBe(403);
  const notListed = await users.approver.send("POST", `/api/approvals/${approvalId}`, { result: "approved" });
  expect(notListed.status()).toBe(403);
  expect((await notListed.json()).error).toMatch(/not one of the approvers/);

  // The owner set up this agent: allowed, but flagged.
  const ok = await users.owner.send("POST", `/api/approvals/${approvalId}`, { ...body(token), note: "ok" });
  expect(ok.status(), await ok.text()).toBe(200);
  expect(await ok.json()).toMatchObject({ status: "approved", selfApproval: true, outcome: { status: "ok" } });

  // Replay: the link and the approval are both spent.
  expect((await users.owner.send("POST", `/api/approvals/${approvalId}`, body(token))).status()).toBe(409);
  expect(await (await users.owner.get(new URL(link).pathname)).text()).toContain("This link was already used");
  const receipt = (await (await users.owner.get(`/api/activity?q=${approvalId}`)).json()) as { items: { kind: string; selfApproval?: boolean }[] };
  expect(receipt.items.find((i) => i.kind === "approval")?.selfApproval).toBe(true);
});

// ---- CSRF, origin, headers, rate limits ----

test("CSRF: writes need the session token and a same-site origin", async () => {
  const c = users.owner;
  const noToken = await c.ctx.fetch("/api/evidence/checkpoint", { method: "POST", headers: { "content-type": "application/json", origin: WEB } });
  expect(noToken.status()).toBe(403);
  expect((await c.send("POST", "/api/evidence/checkpoint", undefined, { "x-csrf-token": "forged" })).status()).toBe(403);
  expect((await c.send("POST", "/api/evidence/checkpoint", undefined, { origin: "https://evil.example" })).status()).toBe(403);
  const anon = await Client.anonymous();
  const login = await anon.ctx.fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: WEB }, data: JSON.stringify({ email: c.email, password: "x" }) });
  expect(login.status()).toBe(403);
});

test("security headers are set", async () => {
  const fresh = await pwRequest.newContext({ baseURL: WEB });
  const res = await fresh.get("/login");
  const h = res.headers();
  expect(h["content-security-policy"]).toMatch(/default-src 'self'/);
  expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[\w-]+' 'strict-dynamic'/);
  expect(h["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-powered-by"]).toBeUndefined();
  const cookie = (await res.headersArray()).find((x) => x.name.toLowerCase() === "set-cookie")?.value ?? "";
  expect(cookie).toMatch(/SameSite=lax/i);
});

test("session cookie is httpOnly and secure", async () => {
  const anon = await Client.anonymous();
  const res = await anon.send("POST", "/api/auth/login", { email: users.viewer.email, password: "quiet monsoon ledger 7" });
  expect(res.status()).toBe(200);
  const set = (await res.headersArray()).filter((x) => x.name.toLowerCase() === "set-cookie").map((x) => x.value);
  const session = set.find((v) => v.startsWith("gate_session="))!;
  expect(session).toMatch(/HttpOnly/i);
  expect(session).toMatch(/Secure/i);
  expect(session).toMatch(/SameSite=lax/i);
});

test("login is rate limited per account", async () => {
  const victim = await Client.signUp("victim");
  const anon = await Client.anonymous();
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await anon.send("POST", "/api/auth/login", { email: victim.email, password: `wrong-${i}` })).status());
  expect(statuses.slice(0, 4).every((s) => s === 401)).toBe(true); // the 5th wrong password locks the account
  expect(statuses).toContain(429);
  expect(statuses.at(-1)).toBe(429);
});

// ---- Injection ----

const XSS = `<img src=x onerror="alert('xss')"><script>alert(1)</script>`;
const SQLI = `Robert'); DROP TABLE "User";-- ' OR '1'='1`;

test("SQL injection and XSS payloads in text fields are stored as text and rendered escaped", async ({ page }) => {
  const c = await Client.owner(`${SQLI} Pvt Ltd`);
  expect((await c.send("PATCH", "/api/settings", { name: `${XSS} Ltd` })).status()).toBe(200);
  const agent = await c.send("POST", "/api/agents", {
    name: `Bot ${XSS}`,
    purpose: `Pays ${SQLI} and ${XSS}`,
    ownerEmail: c.email,
    answers: { money: "no", external: "no", personal: "no", amount: "small", oversight: "always" },
  });
  expect(agent.status(), await agent.text()).toBe(200);
  expect((await c.send("POST", "/api/members", { email: `${XSS}@x.in`, role: "viewer" })).status()).toBe(400);
  expect((await c.send("POST", "/api/auth/signup", { name: SQLI, email: `a'--@x.in`, password: "quiet monsoon ledger 7" })).status()).toBeLessThan(500);
  expect((await c.get(`/api/activity?q=${encodeURIComponent(SQLI)}`)).status()).toBe(200);
  expect((await c.get(`/api/activity?agent=${encodeURIComponent(SQLI)}&tool=${encodeURIComponent(XSS)}`)).status()).toBe(200);
  expect((await c.get(`/api/receipts/${encodeURIComponent("1 OR 1=1")}`)).status()).toBe(400);
  const yaml = `version: 1\nagent: x\nowner: a@b.in\ndefault: refuse\nrules:\n  - id: r\n    tool: gmail.search\n    decide: allow\n    reason: "${XSS.replace(/"/g, '\\"')}"\n`;
  const slug = ((await agent.json()) as { slug: string }).slug;
  expect((await c.send("POST", `/api/rulebooks/${slug}`, { yaml })).status()).toBe(200);

  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await signInUI(page, c.email);
  for (const p of ["/", "/settings", "/agents", `/agents/${slug}`, "/activity", `/rulebooks/${slug}`, "/evidence"]) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
  }
  await page.goto("/agents");
  await expect(page.getByText(`Bot ${XSS}`)).toBeVisible();
  await page.goto(`/rulebooks/${slug}`);
  await expect(page.getByTestId("yaml")).toHaveValue(/onerror/);
  expect(dialogs).toEqual([]);
  // The users table is still there: signing in again works.
  expect((await (await Client.anonymous()).send("POST", "/api/auth/login", { email: c.email, password: "quiet monsoon ledger 7" })).status()).toBe(200);
});
