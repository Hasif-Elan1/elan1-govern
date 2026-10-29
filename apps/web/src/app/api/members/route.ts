import { z } from "zod";
import { route } from "@/server/api";
import { gate } from "@/server/gate";
import { inviteMember } from "@/server/identity";
import { ROLES } from "@/server/policy";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(320), role: z.enum(ROLES) }).strict();

/** Invite by email. Existing Elan1 Govern users are added at once (the CA with several clients); others get a link. */
export const POST = route({ auth: "org", permission: "members:manage", body: Body }, async ({ body, ctx }) => {
  const actor = { ...ctx.user, role: ctx.role };
  const r = await inviteMember(ctx.org, actor, body, (action, details) => gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action, details }));
  return { added: r.added, link: r.link };
});
