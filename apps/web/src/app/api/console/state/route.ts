import { HttpError, route } from "@/server/api";
import { consoleMember, stateFor } from "@/server/console-domain";

/** The console organisation's document and its version, for the console's synchronous reads (Phase 1.3). */
export const GET = route({ auth: "user" }, async ({ req, userId }) => {
  const orgId = req.nextUrl.searchParams.get("org") ?? "";
  if (!userId || !(await consoleMember(userId, orgId))) throw new HttpError(403, "You are not a member of this organisation.");
  return stateFor(orgId, userId);
});
