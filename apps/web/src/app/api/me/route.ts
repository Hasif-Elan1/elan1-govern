import { allMembershipsForUser } from "@gate/db";
import { initialsOf } from "@gate/db/console-demo";
import { HttpError, route } from "@/server/api";
import { currentSession } from "@/server/session";

/**
 * The signed-in person, every organisation they belong to and this session's times (the console's session
 * store). A suspended membership is listed with its status but holds no role: `role` is null there, and it
 * is never the active organisation.
 */
export const GET = route({ auth: "user" }, async () => {
  const s = await currentSession();
  if (!s) throw new HttpError(401, "Sign in to continue.");
  const memberships = (await allMembershipsForUser(s.userId)).map((m) => ({
    orgId: m.orgId,
    orgName: m.org.name,
    role: m.status === "active" ? m.role : null,
    heldRole: m.role,
    status: m.status,
    level: m.org.level,
  }));
  const active = memberships.filter((m) => m.status === "active");
  const activeOrgId = (active.find((m) => m.orgId === s.activeOrgId) ?? active[0])?.orgId ?? null;
  return {
    user: {
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      initials: initialsOf(s.user.name),
      title: s.user.title,
      mfa: s.user.totpEnabled,
      lastSignIn: s.user.lastSignInAt?.toISOString() ?? null,
    },
    memberships,
    activeOrgId,
    signedInAt: s.createdAt.toISOString(),
    lastAuthAt: s.lastAuthAt.toISOString(),
  };
});
