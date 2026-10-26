import { hashToken } from "@gate/core";
import { addMembership, findInviteByTokenHash, forOrg, prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { hashPassword, passwordProblem } from "@/server/auth";
import { gate } from "@/server/gate";
import { LIMITS } from "@/server/ratelimit";
import { startSession } from "@/server/session";
import { email } from "../route-helpers";

const Body = z
  .object({
    name: z.string().trim().min(1, "Enter your name.").max(80),
    email,
    password: z.string().max(200),
    invite: z.string().max(200).optional(),
  })
  .strict();

export const POST = route({ auth: "public", body: Body, limit: { name: "signup", ...LIMITS.signup } }, async ({ body }) => {
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, problem);
  if (await prisma.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, "An account with this email already exists. Sign in instead.");

  const invite = body.invite ? await findInviteByTokenHash(hashToken(body.invite)) : null;
  if (body.invite && !invite) throw new HttpError(410, "This invite has expired or was already used. Ask for a new one.");
  if (invite && invite.email !== body.email) throw new HttpError(400, `This invite is for ${invite.email}.`);

  const user = await prisma.user.create({ data: { name: body.name, email: body.email, passwordHash: await hashPassword(body.password) } });
  if (invite) {
    await addMembership({ orgId: invite.orgId, userId: user.id, role: invite.role });
    await forOrg(invite.orgId).invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    await gate("POST", `/internal/orgs/${invite.orgId}/events`, { actor: user.email, action: "member.joined", details: { role: invite.role } });
  }
  await startSession(user.id, invite?.orgId ?? null);
  return { next: invite ? "/" : "/onboarding" };
});
