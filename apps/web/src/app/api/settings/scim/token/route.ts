import { z } from "zod";
import { route } from "@/server/api";
import { ROLES } from "@/server/policy";
import { rotateScimToken, scimBaseUrl } from "@/server/scim";

const Body = z
  .object({ defaultRole: z.enum(ROLES).refine((r) => r !== "owner" && r !== "auditor", "The directory cannot add owners or auditors.").optional() })
  .strict()
  .optional();

/**
 * Issue a new SCIM bearer token; the old one stops working at once. The token is shown only in this
 * reply and stored as a SHA-256 hash. Owners only (a token can add and remove members), fresh sign-in.
 */
export const POST = route({ auth: "org", permission: "sso:manage", body: Body, fresh: true }, async ({ body, ctx }) => {
  const r = await rotateScimToken(ctx.org.id, ctx.user.email, body?.defaultRole);
  return { token: r.token, prefix: r.prefix, endpoint: scimBaseUrl() };
});
