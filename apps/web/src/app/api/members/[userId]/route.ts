import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { canAssignRole, ROLES, type Role } from "@/server/policy";

async function target(orgId: string, userId: string | undefined) {
  const m = await forOrg(orgId).membership.findFirst({ where: { userId } });
  if (!m) throw new HttpError(404, "No such member.");
  return m;
}

async function ownersLeft(orgId: string) {
  return forOrg(orgId).membership.count({ where: { role: "owner", status: "active" } });
}

const Body = z.object({ role: z.enum(ROLES) }).strict();

export const PATCH = route({ auth: "org", permission: "members:manage", body: Body }, async ({ body, params, ctx }) => {
  const m = await target(ctx.org.id, params.userId);
  if (!canAssignRole(ctx.role, body.role, m.role as Role)) throw new HttpError(403, "Only an owner can change an owner's role or make someone an owner.");
  if (m.role === "owner" && body.role !== "owner" && (await ownersLeft(ctx.org.id)) <= 1) throw new HttpError(409, "An organisation needs at least one owner.");
  await forOrg(ctx.org.id).membership.update({ where: { id: m.id }, data: { role: body.role } });
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "member.role_changed", details: { role: body.role } });
  return { ok: true };
});

export const DELETE = route({ auth: "org", permission: "members:manage" }, async ({ params, ctx }) => {
  const m = await target(ctx.org.id, params.userId);
  if (!canAssignRole(ctx.role, m.role as Role, m.role as Role)) throw new HttpError(403, "Only an owner can remove an owner.");
  if (m.role === "owner" && (await ownersLeft(ctx.org.id)) <= 1) throw new HttpError(409, "An organisation needs at least one owner.");
  await forOrg(ctx.org.id).membership.delete({ where: { id: m.id } });
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "member.removed", details: {} });
  return { ok: true };
});
