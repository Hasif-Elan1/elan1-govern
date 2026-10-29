import { membershipsForUser, prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { invitePerson } from "@/server/console-invites";
import { can, ROLES, type Role } from "@/server/policy";

const Body = z
  .object({
    orgId: z.string().min(1).max(64),
    emails: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(20),
    role: z.enum(ROLES),
  })
  .strict();

/**
 * The console's People and roles: invite one or more people to an organisation the signed-in owner or admin
 * belongs to (the organisation open in the console, not necessarily the session's active one). Each address is
 * handled as POST /api/members handles one; resending is inviting the same address again (the old link stops
 * working). The links come back to the inviter.
 */
export const POST = route({ auth: "user", body: Body }, async ({ body, userId }) => {
  if (!userId) throw new HttpError(401, "Sign in to continue.");
  const m = (await membershipsForUser(userId)).find((x) => x.orgId === body.orgId);
  if (!m) throw new HttpError(403, "You are not a member of this organisation.");
  if (!can(m.role as Role, "members:manage")) throw new HttpError(403, "Owners and admins invite people.");
  const emails = [...new Set(body.emails)];
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, name: true } });
  const invites: { email: string; added: boolean; link: string | null; seq?: number }[] = [];
  for (const email of emails) {
    try {
      invites.push({ email, ...(await invitePerson({ id: m.orgId, name: m.org.name }, { ...user, role: m.role as Role }, email, body.role)) });
    } catch (e) {
      if (!(e instanceof HttpError) || !invites.length) throw e;
      throw new HttpError(e.status, `${email}: ${e.message} The invitations before it were sent.`, { sent: invites.map((i) => i.email) });
    }
  }
  return { invites, seq: invites[invites.length - 1]?.seq ?? null };
});
