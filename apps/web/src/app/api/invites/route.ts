import { prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { hashPassword, passwordProblem } from "@/server/auth";
import { acceptInvite, checkInviteFor } from "@/server/console-invites";
import { LIMITS } from "@/server/ratelimit";
import { currentSession, startSession } from "@/server/session";
import { email } from "../auth/route-helpers";

const Body = z
  .object({
    token: z.string().min(10).max(200),
    // signed out: the account to make, for the address the invite was sent to
    name: z.string().trim().min(1, "Enter your name.").max(80).optional(),
    email: email.optional(),
    password: z.string().max(200).optional(),
  })
  .strict();

/**
 * Accept an invite (single use). Signed in: the invite must be addressed to the signed-in user's email. Signed
 * out: the account is made for the invite's address (name, email, password) and signed in. Either way the person
 * becomes a member with the invited role (for a console organisation, in its document too) and that organisation
 * becomes the session's active one.
 */
export const POST = route({ auth: "public", body: Body, limit: { name: "invite-accept", ...LIMITS.signup } }, async ({ body }) => {
  const s = await currentSession();
  if (s) {
    const { orgId } = await acceptInvite(body.token, { id: s.userId, email: s.user.email });
    await prisma.session.update({ where: { id: s.id }, data: { activeOrgId: orgId } });
    return { ok: true, orgId };
  }
  if (!body.name || !body.email || body.password === undefined) throw new HttpError(401, "Sign in, or enter your name, email and a password, to accept.");
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, problem);
  if (await prisma.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, "An account with this email already exists. Sign in to accept the invite.");
  await checkInviteFor(body.token, body.email);
  const user = await prisma.user.create({ data: { name: body.name, email: body.email, passwordHash: await hashPassword(body.password) } });
  const { orgId } = await acceptInvite(body.token, user);
  await startSession(user.id, orgId);
  return { ok: true, orgId };
});
