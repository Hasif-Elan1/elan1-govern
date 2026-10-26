import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { checkPassword } from "@/server/auth";
import { hit, LIMITS } from "@/server/ratelimit";
import { startSession } from "@/server/session";
import { email, password, safeNext, totp } from "../route-helpers";

const Body = z.object({ email, password, totp, next: z.string().max(500).optional() }).strict();

export const POST = route({ auth: "public", body: Body, limit: { name: "login", ...LIMITS.login } }, async ({ body }) => {
  if (!hit(`login-email:${body.email}`, 10, 15 * 60_000).ok) throw new HttpError(429, "Too many attempts for this account. Wait 15 minutes and try again.");
  const r = await checkPassword(body.email, body.password, body.totp);
  if (!r.ok) {
    if (r.reason === "totp_required") return { needTotp: true };
    if (r.reason === "locked") throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((r.retryAfter ?? 60) / 60)} min.`);
    if (r.reason === "totp_invalid") throw new HttpError(401, "That code did not match. Check the time on your phone and try again.", { needTotp: true });
    throw new HttpError(401, "That email and password do not match.");
  }
  await startSession(r.userId);
  return { next: safeNext(body.next) };
});
