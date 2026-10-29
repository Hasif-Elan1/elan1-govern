import { consoleState } from "@gate/db";
import { HttpError, route } from "@/server/api";
import { consoleMember } from "@/server/console-domain";
import { eventStream } from "@/server/console-events";

export const dynamic = "force-dynamic";

/** Server-Sent Events: each saved change of the organisation's console document (see server/console-events.ts). */
export const GET = route({ auth: "user", limit: { name: "console-stream", max: 30, windowMs: 60_000 } }, async ({ req, userId }) => {
  const orgId = req.nextUrl.searchParams.get("org") ?? "";
  if (!userId || !(await consoleMember(userId, orgId))) throw new HttpError(403, "You are not a member of this organisation.");
  return eventStream(orgId, req.signal, { orgId, kind: "hello", version: (await consoleState.version(orgId)) ?? 0 });
});
