import { randomToken } from "@gate/core";
import { domainClaimedElsewhere, forOrg, Prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { domainSchema, orgVerifiedDomains } from "@/server/identity";
import { withReceipt } from "@/server/inventory";
import { ROLES } from "@/server/policy";
import { acsUrl, breakGlassOwners, defaultSpEntityId, parseIdpCert } from "@/server/saml";
import { scimBaseUrl } from "@/server/scim";
import { domainVerified } from "@/server/sso";

const Save = z
  .object({
    idpEntityId: z.string().trim().min(1).max(500),
    idpSsoUrl: z.string().trim().url().max(1000),
    // More than one while the IdP rolls its signing key.
    idpCertPems: z.array(z.string().max(20_000)).min(1).max(3),
    spEntityId: z.string().trim().min(1).max(500).optional(),
    domains: z.array(domainSchema).min(1).max(20),
    enforced: z.boolean(),
    jit: z.boolean(),
    defaultRole: z.enum(ROLES).refine((r) => r !== "owner", "New SAML users cannot become owners automatically."),
    enabled: z.boolean(),
  })
  .strict();

/** The SAML connection, what to give the IdP, and the SCIM token's prefix. Nothing here is secret. */
export const GET = route({ auth: "org", permission: "settings:manage" }, async ({ ctx }) => {
  const db = forOrg(ctx.org.id);
  const [conn, scim, owners] = await Promise.all([db.samlConnection.findFirst(), db.scimConnection.findFirst(), breakGlassOwners(ctx.org.id)]);
  const certs = (conn?.idpCertPems ?? []).map((p) => parseIdpCert(p, new Date(0))).map((c) => ("error" in c ? { error: c.error } : { fingerprint: c.fingerprint, expiresAt: c.expiresAt }));
  const spEntityId = conn?.spEntityId ?? defaultSpEntityId(ctx.org.id);
  return {
    saml: conn
      ? { idpEntityId: conn.idpEntityId, idpSsoUrl: conn.idpSsoUrl, certs, domains: conn.domains, verifiedDomains: conn.verifiedDomains, verifyToken: conn.verifyToken, enforced: conn.enforced, jit: conn.jit, defaultRole: conn.defaultRole, enabled: conn.enabled, updatedAt: conn.updatedAt }
      : null,
    sp: { entityId: spEntityId, acsUrl: acsUrl(), metadataUrl: defaultSpEntityId(ctx.org.id), wantAssertionsSigned: true },
    verifiedDomains: await orgVerifiedDomains(ctx.org.id),
    breakGlassOwners: owners,
    scim: { endpoint: scimBaseUrl(), ...(scim ? { tokenPrefix: scim.tokenPrefix, defaultRole: scim.defaultRole, lastUsedAt: scim.lastUsedAt } : {}) },
  };
});

/** Owners set up SAML 2.0 and "Require SAML for everyone", after a fresh sign-in. */
export const PUT = route({ auth: "org", permission: "sso:manage", body: Save, fresh: true }, async ({ body, ctx }) => {
  const orgId = ctx.org.id;
  const db = forOrg(orgId);
  if (process.env.APP_ENV === "production" && !body.idpSsoUrl.startsWith("https://")) throw new HttpError(400, "The identity provider's sign-in URL must use https.");
  const certs: string[] = [];
  for (const pem of body.idpCertPems) {
    const c = parseIdpCert(pem);
    if ("error" in c) throw new HttpError(400, c.error);
    certs.push(c.pem);
  }
  for (const d of body.domains) if (await domainClaimedElsewhere(d, orgId)) throw new HttpError(409, `${d} is already used by another organisation.`);

  const before = await db.samlConnection.findFirst();
  const sso = await db.ssoConnection.findFirst({ select: { verifyToken: true, verifiedDomains: true } });
  const verified = (before?.verifiedDomains ?? []).filter((d) => body.domains.includes(d));
  if (body.enforced) {
    if (!body.enabled) throw new HttpError(400, "Turn SAML sign-in on before requiring it.");
    if (!body.domains.some((d) => verified.includes(d) || sso?.verifiedDomains.includes(d))) throw new HttpError(400, "Verify at least one domain before requiring SAML.");
    // Never lock the org out: someone must be able to get in if the IdP is down.
    if ((await breakGlassOwners(orgId)) === 0) throw new HttpError(400, "Turn on two-step sign-in for at least one owner first. Owners with two-step sign-in are the break-glass way in if the identity provider is down.");
  }
  const data = {
    idpEntityId: body.idpEntityId,
    idpSsoUrl: body.idpSsoUrl,
    idpCertPems: certs,
    spEntityId: body.spEntityId ?? before?.spEntityId ?? defaultSpEntityId(orgId),
    wantAssertionsSigned: true,
    domains: body.domains,
    verifiedDomains: verified,
    enforced: body.enforced,
    jit: body.jit,
    defaultRole: body.defaultRole,
    enabled: body.enabled,
  };
  try {
    await withReceipt(
      orgId,
      ctx.user.email,
      "identity.updated",
      () => (before ? db.samlConnection.update({ where: { id: before.id }, data }) : db.samlConnection.create({ data: { orgId, verifyToken: sso?.verifyToken ?? randomToken(), ...data } })),
      () => ({ saml_enabled: body.enabled, saml_enforced: body.enforced, jit: body.jit, default_role: body.defaultRole, domains: body.domains.length }),
      (t) => {
        if (!before) return db.samlConnection.delete({ where: { id: t.id } });
        const { id: _id, orgId: _org, createdAt: _c, updatedAt: _u, ...prev } = before;
        return db.samlConnection.update({ where: { id: t.id }, data: prev });
      },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "That SP entity id is already used by another organisation.");
    throw e;
  }
  return { ok: true };
});

const Verify = z.object({ domain: domainSchema }).strict();

/** Check the DNS TXT record that proves the org owns a domain listed for SAML. */
export const POST = route({ auth: "org", permission: "sso:manage", body: Verify }, async ({ body, ctx }) => {
  const db = forOrg(ctx.org.id);
  const conn = await db.samlConnection.findFirst();
  if (!conn || !conn.domains.includes(body.domain)) throw new HttpError(404, "Add the domain to SAML sign-in first.");
  if (await domainClaimedElsewhere(body.domain, ctx.org.id)) throw new HttpError(409, `${body.domain} is already verified by another organisation.`);
  if (!(await domainVerified(body.domain, conn.verifyToken))) {
    throw new HttpError(400, `Elan1 Govern could not find the TXT record "gate-verify=${conn.verifyToken}" on ${body.domain}. DNS changes can take a few minutes.`);
  }
  if (!conn.verifiedDomains.includes(body.domain)) {
    await withReceipt(
      ctx.org.id,
      ctx.user.email,
      "identity.updated",
      () => db.samlConnection.update({ where: { id: conn.id }, data: { verifiedDomains: [...conn.verifiedDomains, body.domain] } }),
      () => ({ domain_verified: body.domain }),
      (t) => db.samlConnection.update({ where: { id: t.id }, data: { verifiedDomains: conn.verifiedDomains } }),
    );
  }
  return { verified: true };
});
