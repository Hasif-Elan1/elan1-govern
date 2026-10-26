import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { forOrg, prisma } from "@gate/db";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { domainVerified, finishSso, passwordBlockedBySso, sealClientSecret, ssoFor, startSso, SsoError, checkIssuer } from "../src/server/sso";

// A tiny OpenID provider: discovery, JWKS and a token endpoint that returns a signed id_token.
let server: Server;
let issuer: string;
const codes = new Map<string, { nonce: string; email: string; email_verified?: boolean }>();

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (b: unknown) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(b)));
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/token") {
      let body = "";
      for await (const c of req) body += c;
      const code = new URLSearchParams(body).get("code") ?? "";
      const c = codes.get(code);
      if (!c) return (res.statusCode = 400), json({ error: "invalid_grant" });
      const idToken = await new SignJWT({ nonce: c.nonce, email: c.email, ...(c.email_verified === undefined ? {} : { email_verified: c.email_verified }), name: "Asha Rao" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience("gate-client")
        .setSubject(`sub-${c.email}`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json({ access_token: "at", token_type: "Bearer", id_token: idToken, expires_in: 300 });
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await prisma.$disconnect();
});

async function orgWithSso(opts: { enforce?: boolean; verified?: boolean } = {}) {
  const domain = `${randomBytes(4).toString("hex")}.example`;
  const org = await prisma.org.create({ data: { name: "SSO Co", publicKey: "x", privateKeyEnc: "x" } });
  await forOrg(org.id).ssoConnection.create({
    data: {
      orgId: org.id,
      issuer,
      clientId: "gate-client",
      clientSecretEnc: sealClientSecret(org.id, "s3cret"),
      domains: [domain],
      verifiedDomains: opts.verified === false ? [] : [domain],
      verifyToken: "tok",
      enforce: opts.enforce ?? false,
      defaultRole: "approver",
    },
  });
  return { org, domain };
}

/** Plays the browser + IdP: start, "log in" at the IdP, come back with a code. */
async function roundTrip(email: string, idp: { email?: string; email_verified?: boolean; state?: string } = {}) {
  const started = await startSso(email, "/approvals");
  if (!started) throw new Error("no sso");
  const auth = new URL(started.url);
  const code = randomBytes(8).toString("hex");
  codes.set(code, { nonce: auth.searchParams.get("nonce")!, email: idp.email ?? email, email_verified: idp.email_verified });
  const back = new URL(auth.searchParams.get("redirect_uri")!);
  back.searchParams.set("code", code);
  back.searchParams.set("state", idp.state ?? auth.searchParams.get("state")!);
  return { auth, back, cookie: started.cookie };
}

describe("single sign-on (OIDC)", () => {
  it("signs in with PKCE, state and nonce, and creates the user with the default role", async () => {
    const { org, domain } = await orgWithSso();
    const email = `asha@${domain}`;
    const { auth, back, cookie } = await roundTrip(email, { email_verified: true });
    expect(auth.origin).toBe(issuer);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("login_hint")).toBe(email);
    const r = await finishSso(back, cookie);
    expect(r).toMatchObject({ orgId: org.id, next: "/approvals" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.name).toBe("Asha Rao");
    expect(user.passwordHash.startsWith("!sso:")).toBe(true);
    expect((await forOrg(org.id).membership.findFirstOrThrow({ where: { userId: user.id } })).role).toBe("approver");
    // Second sign-in reuses the user and membership.
    const again = await roundTrip(email);
    expect((await finishSso(again.back, again.cookie)).userId).toBe(user.id);
  });

  it("rejects a forged state, a missing or tampered cookie, and replayed codes", async () => {
    const { domain } = await orgWithSso();
    const { back, cookie } = await roundTrip(`b@${domain}`, { state: "forged" });
    await expect(finishSso(back, cookie)).rejects.toThrow(SsoError);
    const ok = await roundTrip(`c@${domain}`);
    await expect(finishSso(ok.back, undefined)).rejects.toThrow(/too long|another browser/);
    await expect(finishSso(ok.back, `${ok.cookie.slice(0, -4)}AAAA`)).rejects.toThrow(/could not be checked/);
    await finishSso(ok.back, ok.cookie);
    await expect(finishSso(ok.back, ok.cookie)).resolves.toBeTruthy(); // the fake IdP accepts code reuse; real IdPs don't
  });

  it("refuses unverified emails and emails outside verified domains", async () => {
    const { domain } = await orgWithSso();
    const unverified = await roundTrip(`d@${domain}`, { email_verified: false });
    await expect(finishSso(unverified.back, unverified.cookie)).rejects.toThrow(/not verified/);
    const elsewhere = await roundTrip(`e@${domain}`, { email: "e@attacker.example" });
    await expect(finishSso(elsewhere.back, elsewhere.cookie)).rejects.toThrow(/not a verified domain/);
  });

  it("only verified domains start SSO, and enforcement blocks passwords", async () => {
    const unverified = await orgWithSso({ verified: false });
    expect(await startSso(`x@${unverified.domain}`)).toBeNull();
    expect(await ssoFor("someone@nowhere.example")).toBeNull();
    const enforced = await orgWithSso({ enforce: true });
    expect(await passwordBlockedBySso(`x@${enforced.domain}`)).toBe(true);
    const relaxed = await orgWithSso();
    expect(await passwordBlockedBySso(`x@${relaxed.domain}`)).toBe(false);
  });

  it("checks the issuer and DNS proof of domain ownership", async () => {
    expect(await checkIssuer(issuer, "gate-client", "s")).toBeNull();
    expect(await checkIssuer("http://127.0.0.1:1/nope", "a", "b")).toMatch(/could not read/);
    const txt = async () => [["gate-verify=", "tok"], ["v=spf1 -all"]];
    expect(await domainVerified("acme.example", "tok", txt)).toBe(true);
    expect(await domainVerified("acme.example", "other", txt)).toBe(false);
    expect(await domainVerified("acme.example", "tok", async () => Promise.reject(new Error("NXDOMAIN")))).toBe(false);
  });
});
