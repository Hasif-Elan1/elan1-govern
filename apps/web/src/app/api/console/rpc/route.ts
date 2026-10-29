import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { consoleMember, opFor, runOp } from "@/server/console-domain";

const Body = z.object({ op: z.string().min(1).max(120), args: z.array(z.unknown()).max(32) }).strict();

/**
 * Runs one console operation as the signed-in user. The operation must be in the build's manifest; whoever the
 * arguments name as acting, the session user acts; the organisation argument must be one the user belongs to.
 * The domain's own permission checks then run as that user, and a refusal comes back as 400 { error }.
 */
export const POST = route({ auth: "user", body: Body, limit: { name: "console-rpc", max: 600, windowMs: 60_000 } }, async ({ body, userId }) => {
  if (!userId) throw new HttpError(401, "Sign in to continue.");
  const op = await opFor(body.op);
  const orgId = op.org === null ? null : body.args[op.org];
  if (op.org !== null && (typeof orgId !== "string" || !(await consoleMember(userId, orgId)))) throw new HttpError(403, "You are not a member of this organisation.");
  return runOp(typeof orgId === "string" ? orgId : null, userId, op.name, body.args);
});
