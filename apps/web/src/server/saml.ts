import "server-only";
import { randomBytes, X509Certificate } from "node:crypto";
import { decrypt, encrypt, randomToken } from "@gate/core";
import { addMembership, findSamlForDomain, forOrg, Prisma, prisma, type SamlConnection } from "@gate/db";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { z } from "zod";
import { env } from "./env";
import { gate } from "./gate";
import { log } from "./log";
import type { Role } from "./policy";
import { deactivatedByDirectory, orgVerifiedDomains } from "./identity";
import { domainOf } from "./sso";

// SAML 2.0 single sign-on, next to OIDC (sso.ts). Elan1 Govern is the service provider: it sends
// an AuthnRequest with the HTTP-Redirect binding and takes the answer at one assertion consumer
// (ACS) with the HTTP-POST binding. Only SP-initiated sign-in: the request id travels in an
// AES-GCM-encrypted, httpOnly cookie, and an answer must be InResponseTo it. IdP-initiated
// (unsolicited) responses are refused, as login CSRF and replay are much harder to stop there.

export const SAML_COOKIE = "gate_saml";
export const SAML_COOKIE_PATH = "/api/auth/saml";
const FLOW_TTL_MS = 10 * 60_000;
/** Clock skew allowed on NotBefore and NotOnOrAfter. */
export const SKEW_MS = 2 * 60_000;
const flowAad = "saml-flow";

/**
 * The flow cookie must come back on the IdP's cross-site form POST to the ACS, which a Lax cookie
 * would not. So, over https, it alone is SameSite=None; Secure, httpOnly, scoped to /api/auth/saml
 * and gone after ten minutes or one use. Without https (local dev) it is Lax: a local IdP on
 * another port of localhost is same-site anyway. The session cookie stays Lax.
 */
export function samlCookieOptions() {
  const secure = env().COOKIE_SECURE === "true";
  return { httpOnly: true, secure, sameSite: secure ? ("none" as const) : ("lax" as const), path: SAML_COOKIE_PATH, maxAge: FLOW_TTL_MS / 1000 };
}

export const acsUrl = () => `${env().WEB_URL}/api/auth/saml/acs`;
export const defaultSpEntityId = (orgId: string) => `${env().WEB_URL}/api/auth/saml/metadata?org=${orgId}`;

type Flow = { orgId: string; requestId: string; issuedAt: string; next: string; exp: number };

export class SamlError extends Error {
  /** Why, for logs and tests; never shown to the person signing in. */
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

type Conn = Pick<SamlConnection, "idpSsoUrl" | "idpCertPems" | "spEntityId">;

function samlFor(conn: Conn, requestId: string, cacheProvider: CacheProvider) {
  return new SAML({
    entryPoint: conn.idpSsoUrl,
    issuer: conn.spEntityId,
    callbackUrl: acsUrl(),
    idpCert: conn.idpCertPems,
    audience: conn.spEntityId,
    // The assertion itself must carry a valid signature by a stored certificate, whatever the
    // response does. Never switched off (the column only records it for the metadata).
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: SKEW_MS,
    maxAssertionAgeMs: FLOW_TTL_MS,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: FLOW_TTL_MS,
    cacheProvider,
    generateUniqueId: () => requestId,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    // Let the IdP choose how people authenticate (passwordless, MFA): no RequestedAuthnContext.
    disableRequestedAuthnContext: true,
    signatureAlgorithm: "sha256",
  });
}

/** Step 1: the IdP URL to send the browser to, and the sealed cookie that remembers the request. */
export async function startSaml(email: string, next = "/"): Promise<{ url: string; cookie: string } | null> {
  const conn = await findSamlForDomain(domainOf(email));
  if (!conn || !conn.idpCertPems.length) return null;
  const requestId = `_${randomBytes(20).toString("hex")}`;
  let issuedAt = new Date().toISOString();
  const cache: CacheProvider = {
    saveAsync: async (_key, value) => ((issuedAt = value), { value, createdAt: Date.now() }),
    getAsync: async () => null,
    removeAsync: async () => null,
  };
  const url = await samlFor(conn, requestId, cache).getAuthorizeUrlAsync("", undefined, {});
  const flow: Flow = { orgId: conn.orgId, requestId, issuedAt, next, exp: Date.now() + FLOW_TTL_MS };
  return { url, cookie: encrypt(env().WEB_ENC_KEY, JSON.stringify(flow), flowAad) };
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const EMAIL_ATTRS = ["email", "mail", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3"];
const NAME_ATTRS = ["displayName", "http://schemas.microsoft.com/identity/claims/displayname", "name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];

const firstString = (v: unknown): string | undefined => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);

/** The email the assertion vouches for: an email attribute, else an emailAddress-format NameID. */
function emailOf(profile: Profile): string {
  for (const a of EMAIL_ATTRS) {
    const r = emailSchema.safeParse(firstString(profile[a]));
    if (r.success) return r.data;
  }
  if (profile.nameIDFormat === "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress") {
    const r = emailSchema.safeParse(profile.nameID);
    if (r.success) return r.data;
  }
  return "";
}

type AssertionXml = { Assertion?: { $?: { ID?: string }; Conditions?: { $?: { NotOnOrAfter?: string } }[] } };

/** Marks a key used; false if it already was (a replay). */
async function useOnce(orgId: string, key: string, expiresAt: Date): Promise<boolean> {
  try {
    await forOrg(orgId).samlReplay.create({ data: { orgId, key: key.slice(0, 300), expiresAt } });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
}

/**
 * Step 2 (the ACS): check the IdP's answer, then find or create the user and their membership.
 * Checks: the assertion's signature against the stored certificates (node-saml, xml-crypto, which
 * reads only the signed content); InResponseTo equals the request id in this browser's cookie;
 * NotBefore/NotOnOrAfter within 2 minutes of skew; audience is our SP entity id; issuer is the IdP's
 * entity id; the assertion id and request id were never used before; the email is in a verified domain.
 */
export async function finishSaml(samlResponse: string | undefined, cookie: string | undefined): Promise<{ userId: string; orgId: string; next: string; joined: boolean }> {
  if (!cookie) throw new SamlError("The sign-in took too long or started in another browser. Try again.");
  let flow: Flow;
  try {
    flow = JSON.parse(decrypt(env().WEB_ENC_KEY, cookie, flowAad)) as Flow;
  } catch {
    throw new SamlError("The sign-in could not be checked. Try again.");
  }
  if (flow.exp < Date.now()) throw new SamlError("The sign-in took too long. Try again.");
  if (!samlResponse) throw new SamlError("Your identity provider did not send an answer.");
  const conn = await forOrg(flow.orgId).samlConnection.findFirst();
  if (!conn || !conn.enabled || !conn.idpCertPems.length) throw new SamlError("SAML sign-in is no longer set up for this organisation.");

  // node-saml asks this cache whether it issued the request id; only the one in this cookie counts.
  const cache: CacheProvider = {
    saveAsync: async () => null,
    getAsync: async (key) => (key === flow.requestId ? flow.issuedAt : null),
    removeAsync: async () => null,
  };
  let profile: Profile | null;
  try {
    ({ profile } = await samlFor(conn, flow.requestId, cache).validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (e) {
    const reason = (e as Error).message.slice(0, 160);
    log("warn", "saml response refused", { orgId: conn.orgId, err: reason });
    throw new SamlError("Your identity provider did not confirm the sign-in.", reason);
  }
  if (!profile) throw new SamlError("Your identity provider did not confirm the sign-in.");
  if (profile.issuer !== conn.idpEntityId) throw new SamlError("The answer came from a different identity provider than the one set up.");
  const assertion = (profile.getAssertion?.() ?? {}) as AssertionXml;
  const assertionId = assertion.Assertion?.$?.ID;
  const notOnOrAfter = Date.parse(assertion.Assertion?.Conditions?.[0]?.$?.NotOnOrAfter ?? "");
  if (!assertionId || !Number.isFinite(notOnOrAfter)) throw new SamlError("Your identity provider's answer has no id or expiry, so it was refused.");

  const db = forOrg(conn.orgId);
  await db.samlReplay.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  if (!(await useOnce(conn.orgId, `r:${flow.requestId}`, new Date(flow.exp + SKEW_MS)))) throw new SamlError("This sign-in was already used. Start again.");
  if (!(await useOnce(conn.orgId, `a:${assertionId}`, new Date(notOnOrAfter + SKEW_MS)))) throw new SamlError("This sign-in was already used. Start again.");

  const email = emailOf(profile);
  if (!email) throw new SamlError("Your identity provider did not share an email address. Ask your admin to send the email attribute.");
  if (!(await orgVerifiedDomains(conn.orgId)).includes(domainOf(email))) throw new SamlError(`${domainOf(email)} is not a verified domain for this organisation.`);

  const name = (NAME_ATTRS.map((a) => firstString(profile[a])).find((v) => v?.trim()) ?? email.split("@")[0]!).trim().slice(0, 80);
  let user = await prisma.user.findUnique({ where: { email } });
  const member = user ? await db.membership.findFirst({ where: { userId: user.id } }) : null;
  let joined = false;
  if (!member) {
    if (user && (await deactivatedByDirectory(conn.orgId, user.id))) throw new SamlError("Your directory has deactivated your account in this organisation. Ask your admin.");
    if (!conn.jit) throw new SamlError("You don't have an account in this organisation yet. Ask an admin to invite you.");
    // SAML users get an unusable password: argon2 can never verify it.
    user ??= await prisma.user.create({ data: { email, name, passwordHash: `!saml:${randomToken()}` } });
    const role: Role = conn.defaultRole === "owner" ? "viewer" : conn.defaultRole;
    await addMembership({ orgId: conn.orgId, userId: user.id, role });
    joined = true;
    await event(conn.orgId, email, "member.joined", { role, via: "saml" });
  }
  await prisma.user.update({ where: { id: user!.id }, data: { failedLogins: 0, lockedUntil: null } });
  return { userId: user!.id, orgId: conn.orgId, next: flow.next, joined };
}

/** Best-effort receipt: sign-in must not depend on the gate service being up; a miss is logged. */
async function event(orgId: string, actor: string, action: string, details: Record<string, string | number | boolean>) {
  const r = await gate("POST", `/internal/orgs/${orgId}/events`, { actor, action, details }).catch(() => ({ status: 0 }));
  if (r.status !== 200) log("error", "receipt not written", { orgId, action, status: r.status });
  return r.status === 200;
}

// ---- "Require SAML for everyone" ----

export type PasswordPolicy = { kind: "allowed" } | { kind: "break_glass"; orgId: string } | { kind: "refused"; orgId: string };

/**
 * Asked before a password is checked. When the org that verified this email's domain requires SAML,
 * passwords are refused, except for that org's owners with two-step sign-in (break-glass, so the
 * org is never locked out when its IdP is down). Their password and TOTP code are still checked.
 */
export async function samlPasswordPolicy(email: string): Promise<PasswordPolicy> {
  const conn = await findSamlForDomain(domainOf(email));
  if (!conn?.enforced) return { kind: "allowed" };
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, totpEnabled: true, totpSecret: true } });
  if (user?.totpEnabled && user.totpSecret) {
    const m = await forOrg(conn.orgId).membership.findFirst({ where: { userId: user.id }, select: { role: true } });
    if (m?.role === "owner") return { kind: "break_glass", orgId: conn.orgId };
  }
  return { kind: "refused", orgId: conn.orgId };
}

/** Every refused password sign-in is a receipt naming the address tried (never the password). */
export const recordPasswordRefused = (orgId: string, email: string) => event(orgId, email.toLowerCase(), "auth.refused", { reason: "saml_required", method: "password" });

/** A break-glass sign-in is a receipt too, so the org can see the IdP was bypassed. */
export const recordBreakGlass = (orgId: string, email: string) => event(orgId, email.toLowerCase(), "auth.break_glass", { method: "password_totp", saml_required: true });

/** Owners with two-step sign-in who could still sign in with a password while SAML is required. */
export async function breakGlassOwners(orgId: string): Promise<number> {
  const owners = await forOrg(orgId).membership.findMany({ where: { role: "owner" }, select: { userId: true } });
  if (!owners.length) return 0;
  return prisma.user.count({ where: { id: { in: owners.map((o) => o.userId) }, totpEnabled: true, totpSecret: { not: null } } });
}

// ---- Settings helpers ----

/** Parse and check an IdP signing certificate. Returns the normalised PEM, or why it can't be used. */
export function parseIdpCert(pem: string, now = new Date()): { pem: string; fingerprint: string; expiresAt: string } | { error: string } {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem.trim());
  } catch {
    return { error: "That is not a PEM certificate. Paste the identity provider's signing certificate, including the BEGIN and END lines." };
  }
  if (new Date(cert.validTo) < now) return { error: `That certificate expired on ${new Date(cert.validTo).toISOString().slice(0, 10)}.` };
  if (cert.publicKey.asymmetricKeyType !== "rsa" && cert.publicKey.asymmetricKeyType !== "ec") return { error: "Use an RSA or EC signing certificate." };
  return { pem: cert.toString(), fingerprint: cert.fingerprint256, expiresAt: new Date(cert.validTo).toISOString() };
}

/** The SP metadata the IdP admin imports: entity id, ACS (HTTP-POST), NameID format, WantAssertionsSigned. */
export function spMetadata(conn: { spEntityId: string; idpSsoUrl?: string; idpCertPems?: string[] }): string {
  // node-saml needs an IdP certificate to construct; the metadata never includes it.
  const placeholder: CacheProvider = { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null };
  const saml = samlFor({ spEntityId: conn.spEntityId, idpSsoUrl: conn.idpSsoUrl ?? "", idpCertPems: conn.idpCertPems?.length ? conn.idpCertPems : ["unused"] }, "_", placeholder);
  return saml.generateServiceProviderMetadata(null, null);
}
