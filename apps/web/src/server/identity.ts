import "server-only";
import { forOrg } from "@gate/db";
import { z } from "zod";

// Shared by OIDC (sso.ts), SAML (saml.ts) and SCIM (scim.ts).

export const domainSchema = z.string().trim().toLowerCase().regex(/^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, "Use a domain like acme.com.");

/** The org's proven domains: its SAML connection's and its OIDC connection's (one TXT proof counts for both). */
export async function orgVerifiedDomains(orgId: string): Promise<string[]> {
  const db = forOrg(orgId);
  const [saml, sso] = await Promise.all([db.samlConnection.findFirst({ select: { verifiedDomains: true } }), db.ssoConnection.findFirst({ select: { verifiedDomains: true } })]);
  return [...new Set([...(saml?.verifiedDomains ?? []), ...(sso?.verifiedDomains ?? [])])];
}

/** The directory switched this person off here (SCIM active=false): single sign-on must not add them back. */
export async function deactivatedByDirectory(orgId: string, userId: string): Promise<boolean> {
  return !!(await forOrg(orgId).scimUser.findFirst({ where: { userId, active: false }, select: { id: true } }));
}
