import { randomBytes } from "node:crypto";
import { hashToken } from "@gate/core";
import { prisma } from "@gate/db";
import { CONSOLE_ORGS } from "@gate/db/console-demo";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The routes and the real session code run against the test database. Only the cookie jar, the
// signed call to the gate service and the mailer are stand-ins.
const state = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  calls: [] as { path: string; body: { actor: string; action: string; details: Record<string, unknown> } }[],
  mails: [] as { to: string; name: string; link: string }[],
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void state.jar.set(name, value),
    delete: (name: string) => void state.jar.delete(name),
  }),
}));
vi.mock("../src/server/gate", () => ({
  gate: async (_method: string, path: string, body: (typeof state.calls)[number]["body"]) => {
    state.calls.push({ path, body });
    return { status: 200, data: { seq: 1 } };
  },
}));
vi.mock("../src/server/mail", () => ({
  sendInvite: async () => undefined,
  sendPasswordReset: async (to: string, name: string, link: string) => void state.mails.push({ to, name, link }),
}));

const me = await import("../src/app/api/me/route");
const forgot = await import("../src/app/api/auth/forgot/route");
const reset = await import("../src/app/api/auth/reset/route");
const login = await import("../src/app/api/auth/login/route");
const orgs = await import("../src/app/api/orgs/route");
const demo = await import("../src/app/api/dev/demo-accounts/route");
const { startSession, currentCtx, SESSION_COOKIE, CSRF_COOKIE } = await import("../src/server/session");
const { checkPassword, hashPassword, verifyTotp } = await import("../src/server/auth");
const { resetRateLimits } = await import("../src/server/ratelimit");
const { FORGOT_REPLY } = await import("../src/server/reset");

const seg = { params: Promise.resolve({}) };
const tag = () => randomBytes(4).toString("hex");

function req(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = { origin: "http://localhost:3000" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = state.jar.get(CSRF_COOKIE) ?? "";
  return new NextRequest(`http://localhost:3000${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const signOut = () => {
  state.jar.clear();
  state.jar.set(CSRF_COOKIE, "signed-out-csrf"); // the middleware's double-submit cookie
};

async function person(opts: { password?: string; title?: string } = {}) {
  const email = `p-${tag()}@identity.test`;
  return prisma.user.create({ data: { email, name: "Asha Verma", title: opts.title ?? "Finance Controller", passwordHash: await hashPassword(opts.password ?? "first password 1") } });
}
const org = (name: string, level = "l1") => prisma.org.create({ data: { name, publicKey: "x", privateKeyEnc: "x", level } });

beforeEach(() => {
  resetRateLimits();
  state.calls = [];
  state.mails = [];
  signOut();
});
afterAll(() => prisma.$disconnect());

describe("GET /api/me", () => {
  it("needs a sign-in", async () => {
    const res = await me.GET(req("/api/me"), seg);
    expect(res.status).toBe(401);
  });

  it("returns the person, every membership with its level, the active org and the session's times", async () => {
    const u = await person();
    const a = await org("Active Co", "l2");
    const b = await org("Suspended Co", "sovereign");
    await prisma.membership.create({ data: { userId: u.id, orgId: a.id, role: "owner" } });
    await prisma.membership.create({ data: { userId: u.id, orgId: b.id, role: "approver", status: "suspended" } });
    await startSession(u.id);

    const res = await me.GET(req("/api/me"), seg);
    expect(res.status).toBe(200);
    const body = await res.json();
    const session = await prisma.session.findFirstOrThrow({ where: { userId: u.id } });
    expect(body).toEqual({
      user: { id: u.id, name: "Asha Verma", email: u.email, initials: "AV", title: "Finance Controller", mfa: false, lastSignIn: expect.any(String) },
      memberships: [
        { orgId: a.id, orgName: "Active Co", role: "owner", heldRole: "owner", status: "active", level: "l2" },
        { orgId: b.id, orgName: "Suspended Co", role: null, heldRole: "approver", status: "suspended", level: "sovereign" },
      ],
      activeOrgId: a.id,
      signedInAt: session.createdAt.toISOString(),
      lastAuthAt: session.lastAuthAt.toISOString(),
    });
    expect(Date.parse(body.user.lastSignIn)).toBeGreaterThan(Date.now() - 60_000);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a suspended membership grants no role: not in the session's orgs, not switchable, never active", async () => {
    const u = await person();
    const a = await org("Still Here Co");
    const b = await org("Paused Co");
    await prisma.membership.create({ data: { userId: u.id, orgId: a.id, role: "viewer" } });
    await prisma.membership.create({ data: { userId: u.id, orgId: b.id, role: "admin", status: "suspended" } });
    await startSession(u.id, b.id); // a stale active org pointing at the suspended one

    const ctx = await currentCtx();
    expect(ctx).not.toBeNull();
    expect(ctx !== "no-org" && ctx!.memberships.map((m) => m.orgId)).toEqual([a.id]);
    expect(ctx !== "no-org" && [ctx!.org.id, ctx!.role]).toEqual([a.id, "viewer"]);
    expect((await (await me.GET(req("/api/me"), seg)).json()).activeOrgId).toBe(a.id);
    expect((await orgs.PUT(req("/api/orgs", "PUT", { orgId: b.id }), seg)).status).toBe(403);

    // suspended everywhere: no org at all
    await prisma.membership.updateMany({ where: { userId: u.id }, data: { status: "suspended" } });
    expect(await currentCtx()).toBe("no-org");
    const body = await (await me.GET(req("/api/me"), seg)).json();
    expect(body.activeOrgId).toBeNull();
    expect(body.memberships.every((m: { role: unknown }) => m.role === null)).toBe(true);
  });
});

describe("signing in while suspended", () => {
  it("refuses a person suspended in every org they belong to, and records the refusal there", async () => {
    const u = await person({ password: "right password 9" });
    const b = await org("Northbank Test");
    await prisma.membership.create({ data: { userId: u.id, orgId: b.id, role: "viewer", status: "suspended" } });
    const res = await login.POST(req("/api/auth/login", "POST", { email: u.email, password: "right password 9" }), seg);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ suspended: true, error: expect.stringMatching(/Northbank Test is suspended/) });
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(0);
    expect(state.calls).toEqual([{ path: `/internal/orgs/${b.id}/events`, body: { actor: u.email, action: "auth.sign_in_refused", details: { reason: "suspended" } } }]);

    // still active somewhere else: signs in there
    const a = await org("Other Client");
    await prisma.membership.create({ data: { userId: u.id, orgId: a.id, role: "auditor" } });
    expect((await login.POST(req("/api/auth/login", "POST", { email: u.email, password: "right password 9" }), seg)).status).toBe(200);
    expect((await prisma.session.findFirstOrThrow({ where: { userId: u.id } })).activeOrgId).toBe(a.id);
  });
});

describe("forgotten password", () => {
  it("emails a single-use link and stores only the token's hash", async () => {
    const u = await person();
    const res = await forgot.POST(req("/api/auth/forgot", "POST", { email: u.email.toUpperCase() }), seg);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FORGOT_REPLY);
    expect(state.mails).toHaveLength(1);
    expect(state.mails[0]!.to).toBe(u.email);
    const token = state.mails[0]!.link.match(/^http:\/\/localhost:3000\/reset\/([A-Za-z0-9_-]{43})$/)![1]!;
    const row = await prisma.passwordReset.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  });

  it("answers an unknown email exactly like a known one, and sends nothing", async () => {
    const u = await person();
    const known = await forgot.POST(req("/api/auth/forgot", "POST", { email: u.email }), seg);
    const unknown = await forgot.POST(req("/api/auth/forgot", "POST", { email: `nobody-${tag()}@identity.test` }), seg);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    expect(state.mails.map((m) => m.to)).toEqual([u.email]);
  });

  it("limits requests per email without changing the answer, and per address", async () => {
    const u = await person();
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(await forgot.POST(req("/api/auth/forgot", "POST", { email: u.email }), seg));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(state.mails).toHaveLength(3);
    // a new link replaces the old one: only the latest is outstanding
    expect(await prisma.passwordReset.count({ where: { userId: u.id, usedAt: null } })).toBe(1);
    // the per-address limit (5 a minute) does answer 429: it says nothing about any one email
    expect((await forgot.POST(req("/api/auth/forgot", "POST", { email: `other-${tag()}@identity.test` }), seg)).status).toBe(200);
    expect((await forgot.POST(req("/api/auth/forgot", "POST", { email: u.email }), seg)).status).toBe(429);
  });

  it("sends nothing to an address whose organisation requires single sign-on", async () => {
    const domain = `sso-${tag()}.example`;
    const u = await prisma.user.create({ data: { email: `asha@${domain}`, name: "Asha", passwordHash: await hashPassword("first password 1") } });
    const o = await org("SSO Only Co");
    await prisma.ssoConnection.create({ data: { orgId: o.id, issuer: "https://idp.example", clientId: "c", clientSecretEnc: "x", domains: [domain], verifiedDomains: [domain], verifyToken: "t", enforce: true, enabled: true } });
    const res = await forgot.POST(req("/api/auth/forgot", "POST", { email: u.email }), seg);
    expect(await res.json()).toEqual(FORGOT_REPLY);
    expect(state.mails).toHaveLength(0);
  });
});

describe("resetting the password", () => {
  async function linkFor(email: string) {
    state.mails = [];
    await forgot.POST(req("/api/auth/forgot", "POST", { email }), seg);
    return state.mails[0]!.link.split("/reset/")[1]!;
  }

  it("sets the new password, ends every other session, clears the lock and writes a receipt on each org", async () => {
    const u = await person();
    const a = await org("Client A");
    const b = await org("Client B");
    await prisma.membership.create({ data: { userId: u.id, orgId: a.id, role: "auditor" } });
    await prisma.membership.create({ data: { userId: u.id, orgId: b.id, role: "auditor", status: "suspended" } });
    for (let i = 0; i < 2; i++) await prisma.session.create({ data: { tokenHash: hashToken(`other-${tag()}`), userId: u.id, csrfToken: "c", expiresAt: new Date(Date.now() + 86_400_000) } });
    const someoneElse = await person();
    await prisma.session.create({ data: { tokenHash: hashToken(`else-${tag()}`), userId: someoneElse.id, csrfToken: "c", expiresAt: new Date(Date.now() + 86_400_000) } });
    await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 7, lockedUntil: new Date(Date.now() + 3_600_000) } });

    const token = await linkFor(u.email);
    state.calls = [];
    const res = await reset.POST(req("/api/auth/reset", "POST", { token, password: "a brand new password" }), seg);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionsEnded: 2 });
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: someoneElse.id } })).toBe(1);
    expect(await checkPassword(u.email, "first password 1")).toMatchObject({ ok: false });
    await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 0 } });
    expect(await checkPassword(u.email, "a brand new password")).toMatchObject({ ok: true });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(state.calls.map((c) => c.path).sort()).toEqual([`/internal/orgs/${a.id}/events`, `/internal/orgs/${b.id}/events`].sort());
    expect(state.calls[0]!.body).toEqual({ actor: u.email, action: "auth.password_reset", details: { sessions_ended: 2 } });
  });

  it("keeps this browser's session when the same person resets while signed in", async () => {
    const u = await person();
    const a = await org("Signed In Co");
    await prisma.membership.create({ data: { userId: u.id, orgId: a.id, role: "owner" } });
    await prisma.session.create({ data: { tokenHash: hashToken(`other-${tag()}`), userId: u.id, csrfToken: "c", expiresAt: new Date(Date.now() + 86_400_000) } });
    const token = await linkFor(u.email);
    await startSession(u.id);
    const mine = state.jar.get(SESSION_COOKIE)!;
    const res = await reset.POST(req("/api/auth/reset", "POST", { token, password: "a brand new password" }), seg);
    expect(await res.json()).toEqual({ ok: true, sessionsEnded: 1 });
    expect((await prisma.session.findMany({ where: { userId: u.id } })).map((s) => s.tokenHash)).toEqual([hashToken(mine)]);
  });

  it("works once: a used, replaced, expired or made-up link is refused the same way", async () => {
    const u = await person();
    const refused = { error: "This reset link has expired or was already used. Ask for a new one." };
    const old = await linkFor(u.email);
    const token = await linkFor(u.email);
    expect(old).not.toBe(token);
    const replaced = await reset.POST(req("/api/auth/reset", "POST", { token: old, password: "a brand new password" }), seg);
    expect([replaced.status, await replaced.json()]).toEqual([400, refused]);

    expect((await reset.POST(req("/api/auth/reset", "POST", { token, password: "a brand new password" }), seg)).status).toBe(200);
    const reused = await reset.POST(req("/api/auth/reset", "POST", { token, password: "another new password" }), seg);
    expect([reused.status, await reused.json()]).toEqual([400, refused]);
    expect(await checkPassword(u.email, "a brand new password")).toMatchObject({ ok: true });

    const late = await linkFor(u.email);
    await prisma.passwordReset.updateMany({ where: { tokenHash: hashToken(late) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await reset.POST(req("/api/auth/reset", "POST", { token: late, password: "another new password" }), seg);
    expect([expired.status, await expired.json()]).toEqual([400, refused]);

    const madeUp = await reset.POST(req("/api/auth/reset", "POST", { token: "A".repeat(43), password: "another new password" }), seg);
    expect([madeUp.status, await madeUp.json()]).toEqual([400, refused]);
    expect((await reset.POST(req("/api/auth/reset", "POST", { token: "../../x", password: "another new password" }), seg)).status).toBe(400);
  });

  it("checks the new password before using up the link", async () => {
    const u = await person();
    const token = await linkFor(u.email);
    const weak = await reset.POST(req("/api/auth/reset", "POST", { token, password: "short" }), seg);
    expect([weak.status, (await weak.json()).error]).toEqual([400, "Use at least 12 characters."]);
    expect((await reset.POST(req("/api/auth/reset", "POST", { token, password: "long enough now 1" }), seg)).status).toBe(200);
  });

  it("refuses requests from another site and without the CSRF token", async () => {
    const r = new NextRequest("http://localhost:3000/api/auth/reset", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", "x-csrf-token": "signed-out-csrf" }, body: JSON.stringify({ token: "A".repeat(43), password: "another new password" }) });
    expect((await reset.POST(r, seg)).status).toBe(403);
    state.jar.delete(CSRF_COOKIE);
    expect((await forgot.POST(req("/api/auth/forgot", "POST", { email: "a@b.in" }), seg)).status).toBe(403);
  });
});

describe("GET /api/dev/demo-accounts", () => {
  const appEnv = process.env.APP_ENV;
  afterAll(() => {
    process.env.APP_ENV = appEnv;
  });

  it("does not exist in production", async () => {
    process.env.APP_ENV = "production";
    const res = await demo.GET(req("/api/dev/demo-accounts"), seg);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/password|code|demotraders/i);
  });

  it("lists the seeded demo accounts by level with the demo password and current two-step codes", async () => {
    process.env.APP_ENV = "development";
    const res = await demo.GET(req("/api/dev/demo-accounts"), seg);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.password).toBe(process.env.DEMO_CONSOLE_PASSWORD || null);
    expect(body.groups.map((g: { level: string; orgId: string }) => [g.level, g.orgId])).toEqual(CONSOLE_ORGS.map((o) => [o.level, o.id]));
    // whatever this install has seeded: each two-step account carries the code its authenticator shows now
    for (const g of body.groups) {
      for (const a of g.accounts) {
        const u = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
        expect(a.twoStep).toBe(u.totpEnabled);
        if (a.twoStep) expect(verifyTotp(u.totpSecret!, a.code)).toBe(true);
        else expect(a.code).toBeNull();
      }
    }
  });
});
