import { forOrg } from "@gate/db";
import { initialsOf } from "@gate/db/console-demo";
import { HttpError, route } from "@/server/api";
import { consoleMember } from "@/server/console-domain";

/**
 * The console organisation's people as the directory shows them (names, titles, roles), for the console's live
 * builds: its screens name people through the directory (userName, userById), filled from here. Only for members.
 * No secrets, sign-in state or contact details beyond the work email every member already sees in People and roles.
 */
export const GET = route({ auth: "user" }, async ({ req, userId }) => {
  const orgId = req.nextUrl.searchParams.get("org") ?? "";
  if (!userId || !(await consoleMember(userId, orgId))) throw new HttpError(403, "You are not a member of this organisation.");
  const rows = await forOrg(orgId).membership.findMany({
    include: { user: { select: { id: true, name: true, email: true, title: true, totpEnabled: true } } },
    orderBy: { createdAt: "asc" },
  });
  return {
    people: rows.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      title: m.user.title,
      initials: initialsOf(m.user.name),
      mfa: m.user.totpEnabled,
      role: m.role,
      status: m.status,
    })),
  };
});
