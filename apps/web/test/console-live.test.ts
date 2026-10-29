import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The console on this origin (plans/console-app.md, Phase 1): the middleware hands page paths to the console's
// start page, which carries the request's CSP nonce, and the directory route names an organisation's people for
// its members only. The session lookup and the request headers are stand-ins; the database is the test one.

const state = vi.hoisted(() => ({ userId: "", nonce: "" as string | null, shell: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.nonce ? { "x-nonce": state.nonce } : {}),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("../src/server/session", () => ({
  CSRF_COOKIE: "gate_csrf",
  isFresh: () => true,
  currentSession: async () => (state.userId ? { userId: state.userId, csrfToken: "csrf-1", lastAuthAt: new Date() } : null),
  currentCtx: async () => (state.userId ? "no-org" : null),
}));

// membership as the Membership table says (the console-organisation rule itself is console.test.ts's): any org will do
vi.mock("../src/server/console-domain", async () => {
  const { membershipsForUser } = await import("@gate/db");
  return { consoleMember: async (userId: string, orgId: string) => (await membershipsForUser(userId)).some((m) => m.orgId === orgId) };
});

const { middleware } = await import("../src/middleware");
const shell = await import("../src/server/console-shell");
const people = await import("../src/app/api/console/people/route");

const seg = { params: Promise.resolve({}) };
const tag = () => randomBytes(4).toString("hex");

describe("the middleware", () => {
  const run = (path: string, init: { method?: string; cookie?: string } = {}) =>
    middleware(new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers: init.cookie ? { cookie: init.cookie } : {} }));
  afterEach(() => vi.unstubAllEnvs());

  it("hands every page path to the console's start page, with the nonce the policy names", () => {
    for (const path of ["/", "/login?next=%2Fapprovals", "/approvals/apr_1", "/approve/tok", "/alerts/al_1", "/invite/tok", "/agents/organisation", "/records/2026.q3"]) {
      const res = run(path);
      expect(res.headers.get("x-middleware-rewrite"), path).toBe("http://localhost:3000/console-shell");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(/script-src 'self' 'nonce-[\w-]{16,}' 'strict-dynamic'/);
      expect(res.headers.get("x-middleware-request-x-nonce")).toBe(/'nonce-([\w-]+)'/.exec(csp)![1]);
      expect(res.status).toBe(200);
    }
  });

  it("leaves the API, Next.js and the console's built files alone, and never redirects to sign in", () => {
    for (const path of ["/api/me", "/api", "/_next/data/x.json", "/assets/index-abc.js", "/icons/icon-192.png", "/sw.js", "/sw-assets.json", "/favicon.svg", "/manifest.webmanifest"]) {
      const res = run(path);
      expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    }
    // only reads are pages: a POST to a page path is not rewritten
    expect(run("/approvals/apr_1", { method: "POST" }).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("sets the double-submit CSRF cookie once", () => {
    expect(run("/login").cookies.get("gate_csrf")?.value).toMatch(/^[\w-]{40,}$/);
    expect(run("/login", { cookie: "gate_csrf=x" }).cookies.get("gate_csrf")).toBeUndefined();
  });

  it("keeps the old pages, and their sign-in redirect, only with LEGACY_UI=true", () => {
    vi.stubEnv("LEGACY_UI", "true");
    const res = run("/approvals/apr_1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fapprovals%2Fapr_1");
    const signedIn = run("/approvals/apr_1", { cookie: "gate_session=s" });
    expect(signedIn.headers.get("x-middleware-rewrite")).toBeNull();
    expect(signedIn.headers.get("content-security-policy")).toMatch(/'strict-dynamic'/);
  });
});

describe("the console's start page", () => {
  const built = [
    "<!doctype html><head>",
    '<meta property="csp-nonce" nonce="__GOVERN_CSP_NONCE__">',
    '<script type="module" crossorigin src="/assets/index-a.js" nonce="__GOVERN_CSP_NONCE__"></script>',
    '<link rel="modulepreload" href="/assets/react-b.js" nonce="__GOVERN_CSP_NONCE__">',
    "</head><body><div id=\"root\"></div><script>navigator.serviceWorker?.register('/sw.js')</script></body>",
  ].join("\n");

  it("puts the request's nonce on every script, preload and the nonce meta tag", () => {
    const out = shell.withNonce(built, "AbCdEfGhIjKlMnOp_-12");
    expect(out).not.toContain("__GOVERN_CSP_NONCE__");
    expect(out.match(/nonce="AbCdEfGhIjKlMnOp_-12"/g)).toHaveLength(4);
    for (const t of out.match(/<script\b[^>]*>/g)!) expect(t).toContain('nonce="AbCdEfGhIjKlMnOp_-12"');
  });

  it("refuses a nonce that is not one the middleware makes", () => {
    expect(() => shell.withNonce(built, 'x" onload="alert(1)')).toThrow(/expected form/);
    expect(() => shell.withNonce(built, "short")).toThrow(/expected form/);
  });

  it("reads the copied build, and says so when there is none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-shell-"));
    try {
      expect(await shell.consoleShell(dir)).toBeUndefined();
      mkdirSync(join(dir, "console-dist"));
      writeFileSync(join(dir, shell.SHELL_FILE), built);
      expect(await shell.consoleShell(dir)).toBe(built);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(shell.NOT_BUILT).toMatch(/not built yet/);
  });
});

describe("the start page route", () => {
  it("serves the page with the middleware's nonce, refuses without one, and says when it is not built", async () => {
    vi.resetModules();
    vi.doMock("../src/server/console-shell", async (orig) => ({ ...(await orig<typeof shell>()), consoleShell: async () => state.shell }));
    const route = await import("../src/app/console-shell/route");
    state.shell = undefined;
    state.nonce = "AbCdEfGhIjKlMnOp_-12";
    expect((await route.GET()).status).toBe(503);
    state.shell = '<script type="module" src="/assets/a.js" nonce="__GOVERN_CSP_NONCE__"></script>';
    const ok = await route.GET();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.text()).toContain('nonce="AbCdEfGhIjKlMnOp_-12"');
    state.nonce = null;
    expect((await route.GET()).status).toBe(500);
    vi.doUnmock("../src/server/console-shell");
  });
});

describe("GET /api/console/people", () => {
  const created: string[] = [];
  let org = "";
  let member = "";
  let suspended = "";
  let outsider = "";

  beforeAll(async () => {
    org = (await prisma.org.create({ data: { name: `People ${tag()}`, publicKey: "x", privateKeyEnc: "x" } })).id;
    const user = (name: string, title: string, totpEnabled = false) => prisma.user.create({ data: { email: `p-${tag()}@console-live.test`, name, title, passwordHash: "x", totpEnabled, totpSecret: totpEnabled ? "secret" : null } });
    const a = await user("Dr Asha Verma", "Head of Risk", true);
    const b = await user("Ravi Kumar", "Analyst");
    const c = await user("Out Sider", "Elsewhere");
    created.push(a.id, b.id, c.id);
    await prisma.membership.create({ data: { userId: a.id, orgId: org, role: "admin" } });
    await prisma.membership.create({ data: { userId: b.id, orgId: org, role: "viewer", status: "suspended" } });
    [member, suspended, outsider] = [a.id, b.id, c.id];
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.org.delete({ where: { id: org } });
    await prisma.$disconnect();
  });

  const ask = (orgId: string) => people.GET(new NextRequest(`http://localhost:3000/api/console/people?org=${orgId}`), seg);

  it("names the organisation's people (no secrets) for a member", async () => {
    state.userId = member;
    const res = await ask(org);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { people: Record<string, unknown>[] };
    expect(body.people).toHaveLength(2);
    expect(body.people).toEqual(expect.arrayContaining([
      { id: member, name: "Dr Asha Verma", email: expect.stringMatching(/@console-live\.test$/), title: "Head of Risk", initials: "AV", mfa: true, role: "admin", status: "active" },
      { id: suspended, name: "Ravi Kumar", email: expect.any(String), title: "Analyst", initials: "RK", mfa: false, role: "viewer", status: "suspended" },
    ]));
    for (const p of body.people) expect(Object.keys(p).sort()).toEqual(["email", "id", "initials", "mfa", "name", "role", "status", "title"]);
    expect(body.people.some((p) => p.id === outsider)).toBe(false);
  });

  it("is refused to anyone who is not an active member, and needs a sign-in", async () => {
    for (const who of [outsider, suspended]) {
      state.userId = who;
      expect((await ask(org)).status).toBe(403);
    }
    state.userId = member;
    expect((await ask("org_nowhere")).status).toBe(403);
    state.userId = "";
    expect((await ask(org)).status).toBe(401);
  });
});
