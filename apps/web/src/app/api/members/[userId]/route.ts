import { z } from "zod";
import { route } from "@/server/api";
import { gate } from "@/server/gate";
import { changeMemberRole, removeMember, type Recorder } from "@/server/identity";
import { ROLES } from "@/server/policy";
import type { Ctx } from "@/server/session";

const Body = z.object({ role: z.enum(ROLES) }).strict();

const recorder = (ctx: Ctx): Recorder => (action, details) => gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action, details });

export const PATCH = route({ auth: "org", permission: "members:manage", body: Body }, async ({ body, params, ctx }) => {
  await changeMemberRole(ctx.org.id, { ...ctx.user, role: ctx.role }, { userId: params.userId ?? "" }, body.role, recorder(ctx));
  return { ok: true };
});

export const DELETE = route({ auth: "org", permission: "members:manage" }, async ({ params, ctx }) => {
  await removeMember(ctx.org.id, { ...ctx.user, role: ctx.role }, params.userId ?? "", recorder(ctx));
  return { ok: true };
});
