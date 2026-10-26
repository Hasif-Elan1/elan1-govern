import { randomToken } from "@gate/core";
import { domainClaimedElsewhere, forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { ROLES } from "@/server/policy";
import { checkIssuer, domainVerified, sealClientSecret } from "@/server/sso";

const domain = z.string().trim().toLowerCase().regex(/^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, "Use a domain like acme.com.");

const Save = z
  .object({
    issuer: z.string().trim().url().max(500),
    clientId: z.string().trim().min(1).max(300),
    clientSecret: z.string().max(1000).optional(),
    domains: z.array(domain).min(1).max(20),
    enforce: z.boolean(),
    defaultRole: z.enum(ROLES).refine((r) => r !== "owner", "New SSO users cannot become owners automatically."),
    enabled: z.boolean(),
  })
  .strict();

/** Owners set up OIDC single sign-on for their organisation. */
export const PUT = route({ auth: "org", permission: "sso:manage", body: Save, fresh: true }, async ({ body, ctx }) => {
  const db = forOrg(ctx.org.id);
  const existing = await db.ssoConnection.findFirst();
  if (!existing && !body.clientSecret) throw new HttpError(400, "Enter the client secret.");
  for (const d of body.domains) if (await domainClaimedElsewhere(d, ctx.org.id)) throw new HttpError(409, `${d} is already used by another organisation.`);
  if (process.env.APP_ENV === "production" && !body.issuer.startsWith("https://")) throw new HttpError(400, "The issuer must use https.");
  const problem = body.clientSecret ? await checkIssuer(body.issuer, body.clientId, body.clientSecret) : null;
  if (problem) throw new HttpError(400, problem);

  const verified = (existing?.verifiedDomains ?? []).filter((d) => body.domains.includes(d));
  const data = {
    issuer: body.issuer,
    clientId: body.clientId,
    domains: body.domains,
    verifiedDomains: verified,
    enforce: body.enforce,
    defaultRole: body.defaultRole,
    enabled: body.enabled,
    ...(body.clientSecret ? { clientSecretEnc: sealClientSecret(ctx.org.id, body.clientSecret) } : {}),
  };
  if (existing) await db.ssoConnection.update({ where: { id: existing.id }, data });
  else await db.ssoConnection.create({ data: { orgId: ctx.org.id, verifyToken: randomToken(), clientSecretEnc: "", ...data } });
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "settings.updated", details: { sso: body.enabled ? "on" : "off", enforce: body.enforce } });
  return { ok: true };
});

const Verify = z.object({ domain }).strict();

/** Check the DNS TXT record that proves the org owns a domain. */
export const POST = route({ auth: "org", permission: "sso:manage", body: Verify }, async ({ body, ctx }) => {
  const db = forOrg(ctx.org.id);
  const conn = await db.ssoConnection.findFirst();
  if (!conn || !conn.domains.includes(body.domain)) throw new HttpError(404, "Add the domain to single sign-on first.");
  if (await domainClaimedElsewhere(body.domain, ctx.org.id)) throw new HttpError(409, `${body.domain} is already verified by another organisation.`);
  if (!(await domainVerified(body.domain, conn.verifyToken))) {
    throw new HttpError(400, `Elan1 Govern could not find the TXT record "gate-verify=${conn.verifyToken}" on ${body.domain}. DNS changes can take a few minutes.`);
  }
  await db.ssoConnection.update({ where: { id: conn.id }, data: { verifiedDomains: [...new Set([...conn.verifiedDomains, body.domain])] } });
  return { verified: true };
});
