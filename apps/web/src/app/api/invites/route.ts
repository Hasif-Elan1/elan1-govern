import { hashToken } from "@gate/core";
import { addMembership, findInviteByTokenHash, forOrg, prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { currentSession } from "@/server/session";

const Body = z.object({ token: z.string().min(10).max(200) }).strict();

/** A signed-in user accepts an invite addressed to their email. */
export const POST = route({ auth: "user", body: Body }, async ({ body }) => {
  const s = await currentSession();
  if (!s) throw new HttpError(401, "Sign in to continue.");
  const invite = await findInviteByTokenHash(hashToken(body.token));
  if (!invite) throw new HttpError(410, "This invite has expired or was already used.");
  if (invite.email !== s.user.email) throw new HttpError(403, `This invite is for ${invite.email}. Sign in with that address.`);
  await addMembership({ orgId: invite.orgId, userId: s.userId, role: invite.role });
  await forOrg(invite.orgId).invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
  await prisma.session.update({ where: { id: s.id }, data: { activeOrgId: invite.orgId } });
  await gate("POST", `/internal/orgs/${invite.orgId}/events`, { actor: s.user.email, action: "member.joined", details: { role: invite.role } });
  return { ok: true };
});
