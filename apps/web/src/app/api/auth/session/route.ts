import { prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { checkPassword } from "@/server/auth";
import { LIMITS } from "@/server/ratelimit";
import { currentSession, endSession } from "@/server/session";
import { password, totp } from "../route-helpers";

// DELETE: sign out. POST: confirm it's you (re-auth) before sensitive actions such as approving.

export const DELETE = route({ auth: "user" }, async () => {
  await endSession();
  return { ok: true };
});

const Reauth = z.object({ password, totp }).strict();

export const POST = route({ auth: "user", body: Reauth, limit: { name: "login", ...LIMITS.login } }, async ({ body }) => {
  const s = await currentSession();
  if (!s) throw new HttpError(401, "Sign in to continue.");
  const r = await checkPassword(s.user.email, body.password, body.totp);
  if (!r.ok) {
    if (r.reason === "totp_required") return { needTotp: true };
    if (r.reason === "locked") throw new HttpError(429, "Too many wrong passwords. Wait a few minutes and try again.");
    throw new HttpError(401, r.reason === "totp_invalid" ? "That code did not match." : "That password is not right.", r.reason === "totp_invalid" ? { needTotp: true } : {});
  }
  await prisma.session.update({ where: { id: s.id }, data: { lastAuthAt: new Date() } });
  return { ok: true };
});
