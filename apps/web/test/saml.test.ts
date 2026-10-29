import { randomBytes } from "node:crypto";
import { addMembership, forOrg, prisma } from "@gate/db";
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdp, requestIdOf, samlResponse, type Idp } from "./saml-idp";

// SAML 2.0 sign-in and "Require SAML for everyone". The database, node-saml, the session and the
// routes run for real; the browser's cookie jar and the signed call to the gate service are stand-ins.
const state = vi.hoisted(() => ({ jar: new Map<string, string>(), events: [] as { path: string; body: { actor: string; action: string; details: Record<string, unknown> } }[], gateStatus: 200 }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void state.jar.set(name, value),
    delete: (o: string | { name: string }) => void state.jar.delete(typeof o === "string" ? o : o.name),
  }),
}));
vi.mock("../src/server/gate", () => ({
  gate: async (_method: string, path: string, body: never) => {
    state.events.push({ path, body });
    return { status: state.gateStatus, data: { seq: 1 } };
  },
}));

const { finishSaml, startSaml, samlPasswordPolicy, SamlError, spMetadata, parseIdpCert, SKEW_MS } = await import("../src/server/saml");
const { POST: acs } = await import("../src/app/api/auth/saml/acs/route");
const { POST: login } = await import("../src/app/api/auth/login/route");
const { GET: metadata } = await import("../src/app/api/auth/saml/metadata/route");
const { hashPassword, newTotp } = await import("../src/server/auth");
const { resetRateLimits } = await import("../src/server/ratelimit");

afterAll(() => prisma.$disconnect());
beforeEach(() => {
  resetRateLimits();
  state.jar.clear();
  state.events = [];
  state.gateStatus = 200;
});

type Setup = { orgId: string; domain: string; idp: Idp; sp: string };

async function orgWithSaml(opts: { enforced?: boolean; jit?: boolean; verified?: boolean; defaultRole?: "viewer" | "approver" | "owner"; idp?: Idp } = {}): Promise<Setup> {
  const domain = `${randomBytes(4).toString("hex")}.example`;
  const org = await prisma.org.create({ data: { name: "SAML Co", publicKey: "x", privateKeyEnc: "x" } });
  const idp = opts.idp ?? makeIdp();
  const sp = `https://govern.test/saml/${org.id}`;
  await forOrg(org.id).samlConnection.create({
    data: {
      orgId: org.id,
      idpEntityId: idp.entityId,
      idpSsoUrl: "https://idp.example/sso",
      idpCertPems: [idp.certPem],
      spEntityId: sp,
      domains: [domain],
      verifyToken: "tok",
      verifiedDomains: opts.verified === false ? [] : [domain],
      enforced: opts.enforced ?? false,
      jit: opts.jit ?? true,
      defaultRole: opts.defaultRole ?? "approver",
    },
  });
  return { orgId: org.id, domain, idp, sp };
}

/** finishSaml refused it, for this (internal, never shown) reason. */
async function refused(p: Promise<unknown>, reason: RegExp) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SamlError);
  expect((e as InstanceType<typeof SamlError>).message).toMatch(/did not confirm/);
  expect((e as InstanceType<typeof SamlError>).reason).toMatch(reason);
}

/** Plays the browser: start sign-in, and hand back the request id the IdP would answer. */
async function begin(email: string) {
  const started = await startSaml(email, "/approvals");
  if (!started) throw new Error("no saml");
  return { ...started, requestId: requestIdOf(started.url) };
}

describe("SAML sign-in", () => {
  it("accepts a signed assertion, creates the user with the default role, and reuses them next time", async () => {
    const s = await orgWithSaml();
    const email = `asha@${s.domain}`;
    const f = await begin(email);
    expect(new URL(f.url).origin).toBe("https://idp.example");
    const r = await finishSaml(samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email, attributes: { displayName: "Asha Rao" } }), f.cookie);
    expect(r).toMatchObject({ orgId: s.orgId, next: "/approvals", joined: true });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ name: "Asha Rao" });
    expect(user.passwordHash.startsWith("!saml:")).toBe(true);
    expect((await forOrg(s.orgId).membership.findFirstOrThrow({ where: { userId: user.id } })).role).toBe("approver");
    expect(state.events).toEqual([{ path: `/internal/orgs/${s.orgId}/events`, body: { actor: email, action: "member.joined", details: { role: "approver", via: "saml" } } }]);
    const again = await begin(email);
    const r2 = await finishSaml(samlResponse(s.idp, { inResponseTo: again.requestId, audience: s.sp, email }), again.cookie);
    expect(r2).toMatchObject({ userId: user.id, joined: false });
  });

  it("refuses unsigned assertions and assertions signed by another key", async () => {
    const s = await orgWithSaml();
    const email = `b@${s.domain}`;
    const f = await begin(email);
    await refused(finishSaml(samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email, signWith: null }), f.cookie), /^Invalid signature$/);
    const g = await begin(email);
    await refused(finishSaml(samlResponse(s.idp, { inResponseTo: g.requestId, audience: s.sp, email, signWith: makeIdp(s.idp.entityId) }), g.cookie), /^Invalid signature$/);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses a signed assertion that was edited afterwards", async () => {
    const s = await orgWithSaml();
    const f = await begin(`c@${s.domain}`);
    const xml = Buffer.from(samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email: `c@${s.domain}` }), "base64").toString("utf8");
    const forged = Buffer.from(xml.replaceAll(`c@${s.domain}`, `boss@${s.domain}`)).toString("base64");
    await refused(finishSaml(forged, f.cookie), /^Invalid signature$/);
  });

  it("refuses the wrong audience and the wrong issuer", async () => {
    const s = await orgWithSaml();
    const email = `d@${s.domain}`;
    const f = await begin(email);
    await refused(finishSaml(samlResponse(s.idp, { inResponseTo: f.requestId, audience: "https://someone-else.example", email }), f.cookie), /audience mismatch/);
    const g = await begin(email);
    await expect(finishSaml(samlResponse(s.idp, { inResponseTo: g.requestId, audience: s.sp, email, issuer: "https://other-idp.example" }), g.cookie)).rejects.toThrow(/different identity provider/);
  });

  it("checks NotBefore and NotOnOrAfter with two minutes of skew", async () => {
    const s = await orgWithSaml();
    const email = `e@${s.domain}`;
    const now = Date.now();
    const expired = await begin(email);
    await refused(
      finishSaml(samlResponse(s.idp, { inResponseTo: expired.requestId, audience: s.sp, email, notOnOrAfter: new Date(now - SKEW_MS - 10_000) }), expired.cookie),
      /No valid subject confirmation/,
    );
    const early = await begin(email);
    await refused(finishSaml(samlResponse(s.idp, { inResponseTo: early.requestId, audience: s.sp, email, notBefore: new Date(now + SKEW_MS + 30_000) }), early.cookie), /not yet valid/);
    const conditions = await begin(email);
    await refused(
      finishSaml(samlResponse(s.idp, { inResponseTo: conditions.requestId, audience: s.sp, email, conditionsNotOnOrAfter: new Date(now - SKEW_MS - 10_000) }), conditions.cookie),
      /expired/,
    );
    const open = await begin(email);
    // No expiry at all: refused (node-saml first; finishSaml checks again before the replay cache).
    await refused(finishSaml(samlResponse(s.idp, { inResponseTo: open.requestId, audience: s.sp, email, conditionsNotOnOrAfter: null }), open.cookie), /NotOnOrAfter/);
    // Inside the skew both ways: accepted.
    const skewed = await begin(email);
    await expect(
      finishSaml(samlResponse(s.idp, { inResponseTo: skewed.requestId, audience: s.sp, email, notBefore: new Date(now + 60_000), notOnOrAfter: new Date(now - 60_000) }), skewed.cookie),
    ).resolves.toMatchObject({ orgId: s.orgId });
  });

  it("refuses replays: the same answer twice, and a known assertion id under a new request", async () => {
    const s = await orgWithSaml();
    const email = `f@${s.domain}`;
    const f = await begin(email);
    const answer = samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email, assertionId: "_fixed-assertion" });
    await finishSaml(answer, f.cookie);
    await expect(finishSaml(answer, f.cookie)).rejects.toThrow(/already used/);
    const g = await begin(email);
    await expect(finishSaml(samlResponse(s.idp, { inResponseTo: g.requestId, audience: s.sp, email, assertionId: "_fixed-assertion" }), g.cookie)).rejects.toThrow(/already used/);
    // The replay rows expire with the assertion, and other orgs keep their own.
    const rows = await forOrg(s.orgId).samlReplay.findMany();
    expect(rows.map((r) => r.key).sort()).toEqual(expect.arrayContaining(["a:_fixed-assertion", `r:${f.requestId}`]));
    expect(rows.every((r) => r.expiresAt.getTime() > Date.now())).toBe(true);
  });

  it("refuses unsolicited answers, answers to another request, and missing or forged cookies", async () => {
    const s = await orgWithSaml();
    const email = `g@${s.domain}`;
    const f = await begin(email);
    await refused(finishSaml(samlResponse(s.idp, { inResponseTo: null, audience: s.sp, email }), f.cookie), /InResponseTo is missing/);
    const other = await begin(email);
    await refused(finishSaml(samlResponse(s.idp, { inResponseTo: other.requestId, audience: s.sp, email }), f.cookie), /InResponseTo is not valid/);
    const ok = samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email });
    await expect(finishSaml(ok, undefined)).rejects.toThrow(/too long|another browser/);
    await expect(finishSaml(ok, `${f.cookie.slice(0, -4)}AAAA`)).rejects.toThrow(/could not be checked/);
    await expect(finishSaml(undefined, f.cookie)).rejects.toThrow(/did not send/);
  });

  it("refuses emails outside the org's verified domains, and unverified domains never start SAML", async () => {
    const s = await orgWithSaml();
    const f = await begin(`h@${s.domain}`);
    await expect(finishSaml(samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email: "h@attacker.example" }), f.cookie)).rejects.toThrow(/not a verified domain/);
    expect(await prisma.user.findUnique({ where: { email: "h@attacker.example" } })).toBeNull();
    const unverified = await orgWithSaml({ verified: false });
    expect(await startSaml(`x@${unverified.domain}`)).toBeNull();
    expect(await startSaml("x@nowhere.example")).toBeNull();
  });

  it("a domain verified for OIDC counts for SAML in the same org", async () => {
    const s = await orgWithSaml({ verified: false });
    await forOrg(s.orgId).ssoConnection.create({ data: { orgId: s.orgId, issuer: "https://oidc.example", clientId: "c", clientSecretEnc: "x", domains: [s.domain], verifiedDomains: [s.domain], verifyToken: "tok", enabled: false } });
    const f = await begin(`i@${s.domain}`);
    await expect(finishSaml(samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email: `i@${s.domain}` }), f.cookie)).resolves.toMatchObject({ orgId: s.orgId });
  });

  it("without JIT only existing members get in, and JIT never makes an owner", async () => {
    const closed = await orgWithSaml({ jit: false });
    const f = await begin(`j@${closed.domain}`);
    await expect(finishSaml(samlResponse(closed.idp, { inResponseTo: f.requestId, audience: closed.sp, email: `j@${closed.domain}` }), f.cookie)).rejects.toThrow(/don't have an account/);
    const owners = await orgWithSaml({ defaultRole: "owner" });
    const g = await begin(`k@${owners.domain}`);
    const r = await finishSaml(samlResponse(owners.idp, { inResponseTo: g.requestId, audience: owners.sp, email: `k@${owners.domain}` }), g.cookie);
    expect((await forOrg(owners.orgId).membership.findFirstOrThrow({ where: { userId: r.userId } })).role).toBe("viewer");
  });

  it("the ACS takes the IdP's cross-site form POST, starts a session and sends the browser on", async () => {
    const s = await orgWithSaml();
    const email = `l@${s.domain}`;
    const f = await begin(email);
    state.jar.set("gate_saml", f.cookie);
    const form = new URLSearchParams({ SAMLResponse: samlResponse(s.idp, { inResponseTo: f.requestId, audience: s.sp, email }), RelayState: "" });
    const post = () =>
      acs(new NextRequest("http://localhost:3000/api/auth/saml/acs", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://idp.example", "sec-fetch-site": "cross-site" }, body: form.toString() }), {
        params: Promise.resolve({}),
      });
    const res = await post();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/approvals");
    expect(state.jar.has("gate_session")).toBe(true);
    expect(state.jar.has("gate_saml")).toBe(false); // one use
    // Posting the same answer again (cookie gone): back to the sign-in page with a reason.
    state.jar.delete("gate_session");
    const again = await post();
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toMatch(/\/login\?sso_error=/);
    expect(state.jar.has("gate_session")).toBe(false);
  });

  it("publishes SP metadata with the entity id, the ACS and WantAssertionsSigned", async () => {
    const s = await orgWithSaml();
    const res = await metadata(new NextRequest(`http://localhost:3000/api/auth/saml/metadata?org=${s.orgId}`), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`entityID="${s.sp}"`);
    expect(xml).toContain('Location="http://localhost:3000/api/auth/saml/acs"');
    expect(xml).toContain('WantAssertionsSigned="true"');
    expect(xml).not.toContain("BEGIN CERTIFICATE");
    expect((await metadata(new NextRequest("http://localhost:3000/api/auth/saml/metadata?org=nope"), { params: Promise.resolve({}) })).status).toBe(404);
    expect(spMetadata({ spEntityId: "urn:x" })).toContain('entityID="urn:x"');
  });

  it("checks IdP certificates before they are saved", () => {
    const good = parseIdpCert(makeIdp().certPem);
    expect(good).toMatchObject({ fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) });
    expect(parseIdpCert(makeIdp(undefined, -1).certPem)).toMatchObject({ error: expect.stringMatching(/expired/) });
    expect(parseIdpCert("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")).toMatchObject({ error: expect.stringMatching(/not a PEM certificate/) });
  });

  it("SamlError is what the ACS shows", () => {
    expect(new SamlError("x")).toBeInstanceOf(Error);
  });
});

// ---- "Require SAML for everyone" ----

async function member(orgId: string, email: string, role: "owner" | "admin" | "viewer", opts: { totp?: boolean } = {}) {
  const t = newTotp(email);
  const user = await prisma.user.create({ data: { email, name: "M", passwordHash: await hashPassword("correct horse battery staple"), ...(opts.totp ? { totpEnabled: true, totpSecret: t.secretEnc } : {}) } });
  await addMembership({ orgId, userId: user.id, role });
  return { user, code: () => (OTPAuth.URI.parse(t.uri) as OTPAuth.TOTP).generate() };
}

function loginReq(body: Record<string, unknown>) {
  state.jar.set("gate_csrf", "csrf-1");
  return login(new NextRequest("http://localhost:3000/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-csrf-token": "csrf-1" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({}),
  });
}

describe("Require SAML for everyone", () => {
  it("refuses passwords for the org's verified domains and writes an auth.refused receipt each time", async () => {
    const s = await orgWithSaml({ enforced: true });
    const m = await member(s.orgId, `admin@${s.domain}`, "admin");
    expect(await samlPasswordPolicy(m.user.email)).toEqual({ kind: "refused", orgId: s.orgId });
    for (const password of ["correct horse battery staple", "wrong password!"]) {
      const res = await loginReq({ email: m.user.email, password });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/requires everyone to sign in through its identity provider/), saml: true });
    }
    // Unknown addresses in the domain are refused the same way (no account enumeration).
    expect((await loginReq({ email: `nobody@${s.domain}`, password: "whatever123456" })).status).toBe(403);
    expect(state.events.map((e) => [e.path, e.body.action, e.body.actor, e.body.details])).toEqual([
      [`/internal/orgs/${s.orgId}/events`, "auth.refused", m.user.email, { reason: "saml_required", method: "password" }],
      [`/internal/orgs/${s.orgId}/events`, "auth.refused", m.user.email, { reason: "saml_required", method: "password" }],
      [`/internal/orgs/${s.orgId}/events`, "auth.refused", `nobody@${s.domain}`, { reason: "saml_required", method: "password" }],
    ]);
    // The password was never checked: no failure counted against the account.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.user.id } })).failedLogins).toBe(0);
    expect(state.jar.has("gate_session")).toBe(false);
  });

  it("still refuses when the gate service can't write the receipt", async () => {
    const s = await orgWithSaml({ enforced: true });
    state.gateStatus = 500;
    expect((await loginReq({ email: `v@${s.domain}`, password: "whatever123456" })).status).toBe(403);
  });

  it("lets a break-glass owner with two-step sign-in in with password and code, and records it", async () => {
    const s = await orgWithSaml({ enforced: true });
    const owner = await member(s.orgId, `owner@${s.domain}`, "owner", { totp: true });
    expect(await samlPasswordPolicy(owner.user.email)).toEqual({ kind: "break_glass", orgId: s.orgId });
    const first = await loginReq({ email: owner.user.email, password: "correct horse battery staple" });
    expect(await first.json()).toEqual({ needTotp: true });
    expect((await loginReq({ email: owner.user.email, password: "wrong password!!", totp: owner.code() })).status).toBe(401);
    const ok = await loginReq({ email: owner.user.email, password: "correct horse battery staple", totp: owner.code() });
    expect(ok.status).toBe(200);
    expect(state.jar.has("gate_session")).toBe(true);
    expect(state.events.map((e) => e.body.action)).toEqual(["auth.break_glass"]);
  });

  it("owners without two-step sign-in, and other orgs' owners, are not break-glass", async () => {
    const s = await orgWithSaml({ enforced: true });
    const plain = await member(s.orgId, `owner2@${s.domain}`, "owner");
    expect(await samlPasswordPolicy(plain.user.email)).toMatchObject({ kind: "refused" });
    const elsewhere = await orgWithSaml();
    const outsider = await member(elsewhere.orgId, `owner3@${s.domain}`, "owner", { totp: true });
    expect(await samlPasswordPolicy(outsider.user.email)).toMatchObject({ kind: "refused", orgId: s.orgId });
  });

  it("does nothing when SAML is not required, or for other domains", async () => {
    const s = await orgWithSaml();
    expect(await samlPasswordPolicy(`a@${s.domain}`)).toEqual({ kind: "allowed" });
    expect(await samlPasswordPolicy("someone@elsewhere.example")).toEqual({ kind: "allowed" });
    const unverified = await orgWithSaml({ enforced: true, verified: false });
    expect(await samlPasswordPolicy(`a@${unverified.domain}`)).toEqual({ kind: "allowed" });
  });
});
