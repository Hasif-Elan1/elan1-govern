import "server-only";
import { decrypt, encrypt, randomToken } from "@gate/core";
import { addMembership, EgressBlocked, findSsoForDomain, forOrg, prisma } from "@gate/db";
import * as oidc from "openid-client";
import { webFetch } from "./egress";
import { env } from "./env";
import { deactivatedByDirectory } from "./identity";

// OIDC single sign-on (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak…).
// Authorization code flow with PKCE, state and nonce. The transient values travel in an
// encrypted, httpOnly cookie that lives ten minutes.

export const SSO_COOKIE = "gate_sso";
const FLOW_TTL_MS = 10 * 60_000;
const flowAad = "sso-flow";
const secretAad = (orgId: string) => `sso-secret:${orgId}`;

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** Plain-http issuers are only allowed outside production (local Keycloak, tests). */
const insecureAllowed = () => process.env.APP_ENV !== "production";

export function sealClientSecret(orgId: string, secret: string) {
  return encrypt(env().WEB_ENC_KEY, secret, secretAad(orgId));
}

/**
 * Discovery, JWKS and token requests all go through the egress gate (deny-all in the sovereign
 * profile): openid-client keeps the discovery fetch on the configuration for every later request.
 */
function discover(issuer: string, clientId: string, secret: string, egress: { orgId?: string; actor?: string }) {
  return oidc.discovery(new URL(issuer), clientId, secret, undefined, {
    timeout: 10,
    // Same shape at run time; the DOM typings only disagree about Uint8Array bodies.
    [oidc.customFetch]: webFetch("oidc", egress) as unknown as oidc.CustomFetch,
    ...(insecureAllowed() && issuer.startsWith("http://") ? { execute: [oidc.allowInsecureRequests] } : {}),
  });
}

async function configFor(conn: { orgId: string; issuer: string; clientId: string; clientSecretEnc: string }) {
  return discover(conn.issuer, conn.clientId, decrypt(env().WEB_ENC_KEY, conn.clientSecretEnc, secretAad(conn.orgId)), { orgId: conn.orgId });
}

export const callbackUrl = () => `${env().WEB_URL}/api/auth/sso/callback`;

type Flow = { orgId: string; email: string; verifier: string; state: string; nonce: string; next: string; exp: number };

/** Is this email's domain bound to an org's SSO? (Only verified domains count.) */
export async function ssoFor(email: string) {
  return findSsoForDomain(domainOf(email));
}

/** Step 1: where to send the browser, and the sealed cookie that remembers the flow. */
export async function startSso(email: string, next = "/"): Promise<{ url: string; cookie: string } | null> {
  const conn = await ssoFor(email);
  if (!conn) return null;
  const config = await configFor(conn);
  const verifier = oidc.randomPKCECodeVerifier();
  const flow: Flow = { orgId: conn.orgId, email: email.toLowerCase(), verifier, state: oidc.randomState(), nonce: oidc.randomNonce(), next, exp: Date.now() + FLOW_TTL_MS };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(),
    scope: "openid email profile",
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state: flow.state,
    nonce: flow.nonce,
    login_hint: flow.email,
  });
  return { url: url.href, cookie: encrypt(env().WEB_ENC_KEY, JSON.stringify(flow), flowAad) };
}

export class SsoError extends Error {}

/**
 * Step 2: validate the IdP's answer (state, nonce, PKCE, id_token signature and audience),
 * then find or create the user and their membership (just-in-time provisioning).
 */
export async function finishSso(currentUrl: URL, cookie: string | undefined): Promise<{ userId: string; orgId: string; next: string }> {
  if (!cookie) throw new SsoError("The sign-in took too long or started in another browser. Try again.");
  let flow: Flow;
  try {
    flow = JSON.parse(decrypt(env().WEB_ENC_KEY, cookie, flowAad)) as Flow;
  } catch {
    throw new SsoError("The sign-in could not be checked. Try again.");
  }
  if (flow.exp < Date.now()) throw new SsoError("The sign-in took too long. Try again.");
  const conn = await forOrg(flow.orgId).ssoConnection.findFirst();
  if (!conn || !conn.enabled) throw new SsoError("Single sign-on is no longer set up for this organisation.");

  const config = await configFor(conn);
  let claims: oidc.IDToken | undefined;
  try {
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
    claims = tokens.claims();
  } catch {
    throw new SsoError("Your identity provider did not confirm the sign-in.");
  }
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) throw new SsoError("Your identity provider did not share an email address. Ask your admin to add the email scope.");
  if (claims?.email_verified === false) throw new SsoError("Your identity provider says this email is not verified.");
  if (!conn.verifiedDomains.includes(domainOf(email))) throw new SsoError(`${domainOf(email)} is not a verified domain for this organisation.`);

  const name = typeof claims?.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 80) : email.split("@")[0]!;
  // SSO users get an unusable password: argon2 can never verify it.
  const user = (await prisma.user.findUnique({ where: { email } })) ?? (await prisma.user.create({ data: { email, name, passwordHash: `!sso:${randomToken()}` } }));
  const member = await forOrg(conn.orgId).membership.findFirst({ where: { userId: user.id } });
  if (!member && (await deactivatedByDirectory(conn.orgId, user.id))) throw new SsoError("Your directory has deactivated your account in this organisation. Ask your admin.");
  if (!member) await addMembership({ orgId: conn.orgId, userId: user.id, role: conn.defaultRole });
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  return { userId: user.id, orgId: conn.orgId, next: flow.next };
}

/** Password sign-in is refused for verified domains whose org requires SSO. */
export async function passwordBlockedBySso(email: string): Promise<boolean> {
  const conn = await ssoFor(email);
  return !!conn?.enforce;
}

// ---- Domain ownership ----

export type TxtResolver = (host: string) => Promise<string[][]>;

/** A domain is verified when a DNS TXT record on it contains `gate-verify=<token>`. */
export async function domainVerified(domain: string, token: string, resolveTxt?: TxtResolver): Promise<boolean> {
  const resolver = resolveTxt ?? (await import("node:dns/promises")).resolveTxt;
  try {
    const records = await resolver(domain);
    return records.some((chunks) => chunks.join("") === `gate-verify=${token}`);
  } catch {
    return false;
  }
}

/** Check the issuer answers OpenID discovery with these credentials before saving them. */
export async function checkIssuer(issuer: string, clientId: string, clientSecret: string, by?: { orgId: string; actor: string }): Promise<string | null> {
  try {
    await discover(issuer, clientId, clientSecret, by ?? {});
    return null;
  } catch (e) {
    // openid-client wraps what its fetch threw.
    if (e instanceof EgressBlocked || (e as { cause?: unknown }).cause instanceof EgressBlocked) return `${new URL(issuer).host} is not on this deployment's egress allow-list, so Elan1 Govern cannot reach your identity provider.`;
    return `Elan1 Govern could not read the identity provider's settings at ${issuer} (${(e as Error).message.slice(0, 120)}).`;
  }
}
