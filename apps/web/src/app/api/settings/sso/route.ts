import { z } from "zod";
import { route } from "@/server/api";
import { gate } from "@/server/gate";
import { ROLES } from "@/server/policy";
import { saveSsoConnection, verifySsoDomain } from "@/server/sso";

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
  await saveSsoConnection(ctx.org.id, body, { actor: ctx.user.email });
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "settings.updated", details: { sso: body.enabled ? "on" : "off", enforce: body.enforce } });
  return { ok: true };
});

const Verify = z.object({ domain }).strict();

/** Check the DNS TXT record that proves the org owns a domain. */
export const POST = route({ auth: "org", permission: "sso:manage", body: Verify }, async ({ body, ctx }) => {
  await verifySsoDomain(ctx.org.id, body.domain);
  return { verified: true };
});
