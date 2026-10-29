import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";

// SAML and SCIM lookups that run before the org is known. Like lookups.ts, each one starts
// from a verified email domain or a hashed secret, never from a user-supplied id.

/** The org that has proven it owns this domain, through its OIDC or its SAML connection. */
export async function orgForVerifiedDomain(domain: string, client: PrismaClient = defaultClient): Promise<string | null> {
  const d = domain.toLowerCase();
  const saml = await client.samlConnection.findFirst({ where: { verifiedDomains: { has: d } }, select: { orgId: true } });
  if (saml) return saml.orgId;
  const sso = await client.ssoConnection.findFirst({ where: { verifiedDomains: { has: d } }, select: { orgId: true } });
  return sso?.orgId ?? null;
}

/** SAML before sign-in: the enabled SAML connection of the org that verified this email domain, if any. */
export async function findSamlForDomain(domain: string, client: PrismaClient = defaultClient) {
  const orgId = await orgForVerifiedDomain(domain, client);
  return orgId ? client.samlConnection.findFirst({ where: { orgId, enabled: true } }) : null;
}

/** SCIM requests carry a bearer token; its hash names the org. */
export function findScimByTokenHash(tokenHash: string, client: PrismaClient = defaultClient) {
  return client.scimConnection.findUnique({ where: { tokenHash } });
}
