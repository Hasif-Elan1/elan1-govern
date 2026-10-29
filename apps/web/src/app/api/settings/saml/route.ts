import { domainClaimedElsewhere, forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { domainSchema, orgVerifiedDomains } from "@/server/identity";
import { withReceipt } from "@/server/inventory";
import { ROLES } from "@/server/policy";
import { acsUrl, breakGlassOwners, defaultSpEntityId, parseIdpCert, saveSamlConnection } from "@/server/saml";
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
  await saveSamlConnection(ctx.org.id, body, { receiptBy: ctx.user.email });
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
