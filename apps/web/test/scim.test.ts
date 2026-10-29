import { randomBytes } from "node:crypto";
import { hashToken } from "@gate/core";
import { addMembership, forOrg, prisma } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../src/server/policy";
import { makeIdp, requestIdOf, samlResponse } from "./saml-idp";

// SCIM 2.0 provisioning and the SAML/SCIM settings routes. The routes, the database and the
// receipts' undo run for real; the signed-in session and the signed call to the gate service are stand-ins.
const state = vi.hoisted(() => ({ role: "owner" as string, orgId: "", events: [] as { path: string; body: { actor: string; action: string; details: Record<string, unknown> } }[], gateStatus: 200 }));

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));
vi.mock("../src/server/session", () => ({
  CSRF_COOKIE: "gate_csrf",
  isFresh: () => true,
  currentSession: async () => ({ userId: "u1", csrfToken: "csrf-1", lastAuthAt: new Date() }),
  currentCtx: async () => ({
    user: { id: "u1", email: "owner@test.in", name: "O", totpEnabled: true },
    session: { id: "s1", csrfToken: "csrf-1", lastAuthAt: new Date() },
    org: { id: state.orgId, name: "SCIM Co" },
    role: state.role as Role,
    memberships: [],
  }),
}));
vi.mock("../src/server/gate", () => ({
  gate: async (_method: string, path: string, body: never) => {
    state.events.push({ path, body });
    return { status: state.gateStatus, data: { seq: 1 } };
  },
}));

const users = await import("../src/app/api/scim/v2/Users/route");
const user = await import("../src/app/api/scim/v2/Users/[id]/route");
const spc = await import("../src/app/api/scim/v2/ServiceProviderConfig/route");
const samlSettings = await import("../src/app/api/settings/saml/route");
const scimToken = await import("../src/app/api/settings/scim/token/route");
const { rotateScimToken } = await import("../src/server/scim");
const { deactivatedByDirectory } = await import("../src/server/identity");
const { finishSaml, startSaml } = await import("../src/server/saml");
const { resetRateLimits } = await import("../src/server/ratelimit");

afterAll(() => prisma.$disconnect());
beforeEach(() => {
  resetRateLimits();
  state.events = [];
  state.gateStatus = 200;
  state.role = "owner";
});

const idp = makeIdp();

async function newOrg() {
  const domain = `${randomBytes(4).toString("hex")}.example`;
  const org = await prisma.org.create({ data: { name: "SCIM Co", publicKey: "x", privateKeyEnc: "x" } });
  await forOrg(org.id).samlConnection.create({
    data: { orgId: org.id, idpEntityId: idp.entityId, idpSsoUrl: "https://idp.example/sso", idpCertPems: [idp.certPem], spEntityId: `urn:sp:${org.id}`, domains: [domain], verifiedDomains: [domain], verifyToken: "tok", defaultRole: "approver" },
  });
  const { token } = await rotateScimToken(org.id, "owner@test.in", "approver");
  state.events = [];
  return { orgId: org.id, domain, token };
}

type Handler = (req: NextRequest, seg: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(h: Handler, method: string, path: string, o: { token?: string | null; body?: unknown; id?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/scim+json" };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const res = await h(new NextRequest(`http://localhost:3000/api/scim/v2${path}`, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) }), { params: Promise.resolve<Record<string, string>>(o.id ? { id: o.id } : {}) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

const newUser = (email: string, extra: Record<string, unknown> = {}) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, name: { givenName: "Ravi", familyName: "Iyer" }, emails: [{ value: email, primary: true }], active: true, ...extra });
const patch = (Operations: unknown[]) => ({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations });
const roleOf = async (orgId: string, email: string) => {
  const u = await prisma.user.findUnique({ where: { email } });
  return u ? ((await forOrg(orgId).membership.findFirst({ where: { userId: u.id } }))?.role ?? null) : null;
};

describe("SCIM bearer token", () => {
  it("refuses requests without the token, with a wrong one, or with a rotated one", async () => {
    const a = await newOrg();
    for (const token of [null, "scim_wrongwrongwrongwrongwrongwrongwrong", "not-even-a-token"]) {
      const r = await call(users.GET, "GET", "/Users", { token });
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Bearer realm="scim"');
      expect(r.json).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    }
    expect((await call(spc.GET, "GET", "/ServiceProviderConfig", { token: a.token })).json).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
    const { token: next } = await rotateScimToken(a.orgId, "owner@test.in");
    expect((await call(users.GET, "GET", "/Users", { token: a.token })).status).toBe(401);
    expect((await call(users.GET, "GET", "/Users", { token: next })).status).toBe(200);
    // Only the hash is kept.
    const row = await forOrg(a.orgId).scimConnection.findFirstOrThrow();
    expect(row.tokenHash).toBe(hashToken(next));
    expect(JSON.stringify(row)).not.toContain(next);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("is rate limited per address before the token is even looked at", async () => {
    let last = 0;
    for (let i = 0; i < 301; i++) last = (await call(spc.GET, "GET", "/ServiceProviderConfig")).status;
    expect(last).toBe(429);
  });
});

describe("SCIM users", () => {
  it("creates a member with the token's default role and finds them by userName", async () => {
    const a = await newOrg();
    const email = `ravi@${a.domain}`;
    const r = await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(email.toUpperCase(), { externalId: "00u1" }) });
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toBe("application/scim+json");
    expect(r.json).toMatchObject({ userName: email, externalId: "00u1", active: true, meta: { resourceType: "User" } });
    expect(r.headers.get("location")).toBe(`http://localhost:3000/api/scim/v2/Users/${r.json!.id}`);
    expect(await roleOf(a.orgId, email)).toBe("approver");
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash.startsWith("!scim:")).toBe(true);
    expect(state.events).toEqual([{ path: `/internal/orgs/${a.orgId}/events`, body: { actor: "scim@directory.invalid", action: "scim.user_provisioned", details: { role: "approver", linked: false, active: true } } }]);

    expect((await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(email) })).json).toMatchObject({ status: "409", scimType: "uniqueness" });
    const found = await call(users.GET, "GET", `/Users?filter=${encodeURIComponent(`userName eq "${email.toUpperCase()}"`)}`, { token: a.token });
    expect(found.json).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 1, Resources: [{ id: r.json!.id }] });
    expect((await call(users.GET, "GET", `/Users?filter=${encodeURIComponent('userName eq "nobody@x.example"')}`, { token: a.token })).json).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await call(users.GET, "GET", `/Users?filter=${encodeURIComponent('emails co "x"')}`, { token: a.token })).json).toMatchObject({ status: "400", scimType: "invalidFilter" });
    expect((await call(user.GET, "GET", `/Users/${r.json!.id}`, { token: a.token, id: String(r.json!.id) })).json).toMatchObject({ userName: email });
  });

  it("refuses emails outside the org's verified domains and bad bodies", async () => {
    const a = await newOrg();
    expect((await call(users.POST, "POST", "/Users", { token: a.token, body: newUser("mallory@attacker.example") })).json).toMatchObject({ status: "400", scimType: "invalidValue" });
    expect((await call(users.POST, "POST", "/Users", { token: a.token, body: newUser("not-an-email", { emails: [] }) })).status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: "mallory@attacker.example" } })).toBeNull();
    const bad = await users.POST(new NextRequest("http://localhost:3000/api/scim/v2/Users", { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: "{nope" }), { params: Promise.resolve({}) });
    expect(bad.status).toBe(400);
  });

  it("active=false removes the membership and keeps SSO from adding it back; active=true restores it", async () => {
    const a = await newOrg();
    const email = `asha@${a.domain}`;
    const { json } = await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(email) });
    const id = json!.id as string;
    // Microsoft Entra ID sends booleans as strings.
    const off = await call(user.PATCH, "PATCH", `/Users/${id}`, { token: a.token, id, body: patch([{ op: "Replace", path: "active", value: "False" }]) });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ active: false });
    expect(await roleOf(a.orgId, email)).toBeNull();
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await deactivatedByDirectory(a.orgId, u.id)).toBe(true);
    // SAML just-in-time sign-in does not bring them back.
    const started = (await startSaml(email))!;
    await expect(finishSaml(samlResponse(idp, { inResponseTo: requestIdOf(started.url), audience: `urn:sp:${a.orgId}`, email }), started.cookie)).rejects.toThrow(/deactivated/);
    expect(await roleOf(a.orgId, email)).toBeNull();

    const on = await call(user.PATCH, "PATCH", `/Users/${id}`, { token: a.token, id, body: patch([{ op: "replace", value: { active: true, displayName: "Asha R" } }]) });
    expect(on.json).toMatchObject({ active: true, displayName: "Asha R" });
    expect(await roleOf(a.orgId, email)).toBe("approver");
    // PUT can deactivate too, and userName cannot change.
    expect((await call(user.PUT, "PUT", `/Users/${id}`, { token: a.token, id, body: newUser(email, { active: false }) })).json).toMatchObject({ active: false });
    expect((await call(user.PUT, "PUT", `/Users/${id}`, { token: a.token, id, body: newUser(`other@${a.domain}`) })).json).toMatchObject({ scimType: "mutability" });
    expect((await call(user.PATCH, "PATCH", `/Users/${id}`, { token: a.token, id, body: patch([{ op: "move", path: "active", value: true }]) })).status).toBe(400);
    expect(state.events.map((e) => e.body.action)).toEqual(["scim.user_provisioned", "scim.user_deactivated", "scim.user_reactivated", "scim.user_deactivated"]);
  });

  it("DELETE removes the membership; the account stays", async () => {
    const a = await newOrg();
    const email = `del@${a.domain}`;
    const id = (await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(email) })).json!.id as string;
    expect((await call(user.DELETE, "DELETE", `/Users/${id}`, { token: a.token, id })).status).toBe(204);
    expect(await roleOf(a.orgId, email)).toBeNull();
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
    expect((await call(user.GET, "GET", `/Users/${id}`, { token: a.token, id })).status).toBe(404);
    expect(state.events.at(-1)?.body).toMatchObject({ action: "scim.user_removed", details: { role: "approver" } });
  });

  it("one org's token never reaches another org's users", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const id = (await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(`x@${a.domain}`) })).json!.id as string;
    expect((await call(user.GET, "GET", `/Users/${id}`, { token: b.token, id })).status).toBe(404);
    expect((await call(user.PATCH, "PATCH", `/Users/${id}`, { token: b.token, id, body: patch([{ op: "replace", path: "active", value: false }]) })).status).toBe(404);
    expect((await call(user.DELETE, "DELETE", `/Users/${id}`, { token: b.token, id })).status).toBe(404);
    expect((await call(users.GET, "GET", "/Users", { token: b.token })).json).toMatchObject({ totalResults: 0 });
    // B cannot provision into A's domain either.
    expect((await call(users.POST, "POST", "/Users", { token: b.token, body: newUser(`y@${a.domain}`) })).status).toBe(400);
    expect(await roleOf(a.orgId, `x@${a.domain}`)).toBe("approver");
  });

  it("links existing owners but never deactivates or removes them", async () => {
    const a = await newOrg();
    const email = `boss@${a.domain}`;
    const owner = await prisma.user.create({ data: { email, name: "Boss", passwordHash: "x" } });
    await addMembership({ orgId: a.orgId, userId: owner.id, role: "owner" });
    const r = await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(email) });
    expect(r.status).toBe(201);
    const id = r.json!.id as string;
    expect(state.events[0]?.body.details).toEqual({ role: "owner", linked: true, active: true });
    expect((await call(user.PATCH, "PATCH", `/Users/${id}`, { token: a.token, id, body: patch([{ op: "replace", path: "active", value: false }]) })).status).toBe(403);
    expect((await call(user.DELETE, "DELETE", `/Users/${id}`, { token: a.token, id })).status).toBe(403);
    expect(await roleOf(a.orgId, email)).toBe("owner");
  });

  it("undoes the change when the receipt cannot be written", async () => {
    const a = await newOrg();
    const email = `undo@${a.domain}`;
    state.gateStatus = 500;
    expect((await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(email) })).status).toBe(500);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(await forOrg(a.orgId).scimUser.count()).toBe(0);
    state.gateStatus = 200;
    const id = (await call(users.POST, "POST", "/Users", { token: a.token, body: newUser(email) })).json!.id as string;
    state.gateStatus = 500;
    expect((await call(user.PATCH, "PATCH", `/Users/${id}`, { token: a.token, id, body: patch([{ op: "replace", path: "active", value: false }]) })).status).toBe(500);
    expect(await roleOf(a.orgId, email)).toBe("approver");
    expect((await forOrg(a.orgId).scimUser.findFirstOrThrow()).active).toBe(true);
  });
});

// ---- Settings routes ----

function req(path: string, body: unknown, method = "PUT") {
  return new NextRequest(`http://localhost:3000${path}`, { method, headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-csrf-token": "csrf-1" }, body: JSON.stringify(body) });
}
const seg = { params: Promise.resolve({}) };

async function settingsOrg() {
  const org = await prisma.org.create({ data: { name: "Settings Co", publicKey: "x", privateKeyEnc: "x" } });
  state.orgId = org.id;
  return { orgId: org.id, domain: `${randomBytes(4).toString("hex")}.example` };
}
const save = (domain: string, extra: Record<string, unknown> = {}) => ({ idpEntityId: idp.entityId, idpSsoUrl: "https://idp.example/sso", idpCertPems: [idp.certPem], domains: [domain], enforced: false, jit: true, defaultRole: "viewer", enabled: true, ...extra });

describe("PUT /api/settings/saml", () => {
  it("owners save the connection with a receipt; admins cannot", async () => {
    const o = await settingsOrg();
    state.role = "admin";
    expect((await samlSettings.PUT(req("/api/settings/saml", save(o.domain)), seg)).status).toBe(403);
    state.role = "owner";
    const res = await samlSettings.PUT(req("/api/settings/saml", save(o.domain)), seg);
    expect(res.status).toBe(200);
    const row = await forOrg(o.orgId).samlConnection.findFirstOrThrow();
    expect(row).toMatchObject({ spEntityId: `http://localhost:3000/api/auth/saml/metadata?org=${o.orgId}`, wantAssertionsSigned: true, verifiedDomains: [], defaultRole: "viewer" });
    expect(state.events.map((e) => [e.body.action, e.body.details])).toEqual([["identity.updated", { saml_enabled: true, saml_enforced: false, jit: true, default_role: "viewer", domains: 1 }]]);
    const view = (await (await samlSettings.GET(new NextRequest("http://localhost:3000/api/settings/saml"), seg)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ saml: { idpEntityId: idp.entityId, certs: [{ fingerprint: expect.any(String) }] }, sp: { acsUrl: "http://localhost:3000/api/auth/saml/acs" }, scim: { endpoint: "http://localhost:3000/api/scim/v2" } });
  });

  it("refuses owner as the default role, bad or expired certificates, and other orgs' domains", async () => {
    const o = await settingsOrg();
    expect((await samlSettings.PUT(req("/api/settings/saml", save(o.domain, { defaultRole: "owner" })), seg)).status).toBe(400);
    expect(await (await samlSettings.PUT(req("/api/settings/saml", save(o.domain, { idpCertPems: [makeIdp(undefined, -1).certPem] })), seg)).json()).toMatchObject({ error: expect.stringMatching(/expired/) });
    expect((await samlSettings.PUT(req("/api/settings/saml", save(o.domain, { idpCertPems: ["hello"] })), seg)).status).toBe(400);
    const other = await prisma.org.create({ data: { name: "Other", publicKey: "x", privateKeyEnc: "x" } });
    await forOrg(other.id).ssoConnection.create({ data: { orgId: other.id, issuer: "https://o.example", clientId: "c", clientSecretEnc: "x", domains: [o.domain], verifiedDomains: [o.domain], verifyToken: "t" } });
    expect((await samlSettings.PUT(req("/api/settings/saml", save(o.domain)), seg)).status).toBe(409);
    expect(await forOrg(o.orgId).samlConnection.count()).toBe(0);
  });

  it("requiring SAML needs a verified domain and a break-glass owner with two-step sign-in", async () => {
    const o = await settingsOrg();
    await samlSettings.PUT(req("/api/settings/saml", save(o.domain)), seg);
    expect(await (await samlSettings.PUT(req("/api/settings/saml", save(o.domain, { enforced: true })), seg)).json()).toMatchObject({ error: expect.stringMatching(/Verify at least one domain/) });
    await forOrg(o.orgId).samlConnection.updateMany({ data: { verifiedDomains: [o.domain] } });
    expect(await (await samlSettings.PUT(req("/api/settings/saml", save(o.domain, { enforced: true })), seg)).json()).toMatchObject({ error: expect.stringMatching(/two-step sign-in for at least one owner/) });
    const owner = await prisma.user.create({ data: { email: `owner@${o.domain}`, name: "O", passwordHash: "x", totpEnabled: true, totpSecret: "enc" } });
    await addMembership({ orgId: o.orgId, userId: owner.id, role: "owner" });
    expect((await samlSettings.PUT(req("/api/settings/saml", save(o.domain, { enforced: true })), seg)).status).toBe(200);
    expect((await forOrg(o.orgId).samlConnection.findFirstOrThrow()).enforced).toBe(true);
    // Saving keeps the proof for domains still listed.
    expect((await forOrg(o.orgId).samlConnection.findFirstOrThrow()).verifiedDomains).toEqual([o.domain]);
  });

  it("undoes the change when the receipt cannot be written", async () => {
    const o = await settingsOrg();
    await samlSettings.PUT(req("/api/settings/saml", save(o.domain)), seg);
    state.gateStatus = 500;
    expect((await samlSettings.PUT(req("/api/settings/saml", save(o.domain, { jit: false, idpEntityId: "https://changed.example" })), seg)).status).toBe(500);
    expect(await forOrg(o.orgId).samlConnection.findFirstOrThrow()).toMatchObject({ jit: true, idpEntityId: idp.entityId });
  });
});

describe("POST /api/settings/scim/token", () => {
  it("shows a new token once, stores its hash and records only the prefix", async () => {
    const o = await settingsOrg();
    state.role = "admin";
    expect((await scimToken.POST(req("/api/settings/scim/token", {}, "POST"), seg)).status).toBe(403);
    state.role = "owner";
    expect((await scimToken.POST(req("/api/settings/scim/token", { defaultRole: "owner" }, "POST"), seg)).status).toBe(400);
    const res = await scimToken.POST(req("/api/settings/scim/token", { defaultRole: "admin" }, "POST"), seg);
    const body = (await res.json()) as { token: string; prefix: string; endpoint: string };
    expect(body.token).toMatch(/^scim_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(body.token.slice(0, 12));
    const row = await forOrg(o.orgId).scimConnection.findFirstOrThrow();
    expect(row).toMatchObject({ tokenHash: hashToken(body.token), defaultRole: "admin" });
    expect(state.events).toEqual([{ path: `/internal/orgs/${o.orgId}/events`, body: { actor: "owner@test.in", action: "identity.scim_token_rotated", details: { prefix: body.prefix, default_role: "admin" } } }]);
    expect(JSON.stringify(state.events)).not.toContain(body.token);
    // Without a body the role stays.
    await scimToken.POST(new NextRequest("http://localhost:3000/api/settings/scim/token", { method: "POST", headers: { origin: "http://localhost:3000", "x-csrf-token": "csrf-1" } }), seg);
    expect((await forOrg(o.orgId).scimConnection.findFirstOrThrow()).defaultRole).toBe("admin");
  });
});
