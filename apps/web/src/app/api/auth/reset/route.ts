import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { passwordProblem } from "@/server/auth";
import { LIMITS } from "@/server/ratelimit";
import { resetPassword } from "@/server/reset";
import { currentSession } from "@/server/session";

const Body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, "That reset link is not valid."), password: z.string().min(1, "Choose a new password.").max(200) }).strict();

/** Choose a new password with the emailed link. Ends the person's other sessions. */
export const POST = route({ auth: "public", body: Body, limit: { name: "reset", ...LIMITS.reset } }, async ({ body }) => {
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, problem);
  // This browser's session survives when it is the same person's; only that person's sessions are ever ended.
  const s = await currentSession();
  const r = await resetPassword(body.token, body.password, s?.id);
  if (!r.ok) throw new HttpError(400, "This reset link has expired or was already used. Ask for a new one.");
  return { ok: true, sessionsEnded: r.sessionsEnded };
});
