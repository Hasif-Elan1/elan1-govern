import { z } from "zod";
import { route } from "@/server/api";
import { invitePerson } from "@/server/console-invites";
import { ROLES } from "@/server/policy";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(320), role: z.enum(ROLES) }).strict();

/** Invite by email. Existing Elan1 Govern users are added at once (the CA with several clients); others get a link. */
export const POST = route({ auth: "org", permission: "members:manage", body: Body }, async ({ body, ctx }) =>
  invitePerson(ctx.org, { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, role: ctx.role }, body.email, body.role),
);
