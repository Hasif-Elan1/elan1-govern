import { hashToken, randomToken } from "@gate/core";
import { addMembership, forOrg, prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { env } from "@/server/env";
import { gate } from "@/server/gate";
import { sendInvite } from "@/server/mail";
import { canAssignRole, ROLES } from "@/server/policy";

const Body = z.object({ email: z.string().trim().toLowerCase().email().max(320), role: z.enum(ROLES) }).strict();

/** Invite by email. Existing Elan1 Govern users are added at once (the CA with several clients); others get a link. */
export const POST = route({ auth: "org", permission: "members:manage", body: Body }, async ({ body, ctx }) => {
  if (!canAssignRole(ctx.role, body.role)) throw new HttpError(403, "Only an owner can add another owner.");
  const db = forOrg(ctx.org.id);
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) {
    if (await db.membership.findFirst({ where: { userId: existing.id } })) throw new HttpError(409, "They are already a member.");
    await addMembership({ orgId: ctx.org.id, userId: existing.id, role: body.role });
    await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "member.joined", details: { role: body.role } });
    return { added: true, link: null };
  }
  const token = randomToken();
  await db.invite.create({ data: { orgId: ctx.org.id, email: body.email, role: body.role, tokenHash: hashToken(token), invitedBy: ctx.user.email, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
  const link = `${env().WEB_URL}/invite/${token}`;
  await sendInvite(body.email, ctx.org.name, ctx.user.name, link, body.role);
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "member.invited", details: { role: body.role } });
  return { added: false, link };
});
