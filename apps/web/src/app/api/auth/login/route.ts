import { allMembershipsForUser } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { checkPassword } from "@/server/auth";
import { gate } from "@/server/gate";
import { hit, LIMITS } from "@/server/ratelimit";
import { startSession } from "@/server/session";
import { passwordBlockedBySso } from "@/server/sso";
import { email, password, safeNext, totp } from "../route-helpers";

const Body = z.object({ email, password, totp, next: z.string().max(500).optional() }).strict();

export const POST = route({ auth: "public", body: Body, limit: { name: "login", ...LIMITS.login } }, async ({ body }) => {
  if (!hit(`login-email:${body.email}`, 10, 15 * 60_000).ok) throw new HttpError(429, "Too many attempts for this account. Wait 15 minutes and try again.");
  if (await passwordBlockedBySso(body.email)) throw new HttpError(403, "Your company signs in with single sign-on.", { sso: true });
  const r = await checkPassword(body.email, body.password, body.totp);
  if (!r.ok) {
    if (r.reason === "totp_required") return { needTotp: true };
    if (r.reason === "locked") throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((r.retryAfter ?? 60) / 60)} min.`);
    if (r.reason === "totp_invalid") throw new HttpError(401, "That code did not match. Check the time on your phone and try again.", { needTotp: true });
    throw new HttpError(401, "That email and password do not match.");
  }
  // Suspended everywhere they belong: the sign-in is refused, and each of those organisations records the refusal.
  const ms = await allMembershipsForUser(r.userId);
  if (ms.length && ms.every((m) => m.status === "suspended")) {
    for (const m of ms) await gate("POST", `/internal/orgs/${m.orgId}/events`, { actor: body.email, action: "auth.sign_in_refused", details: { reason: "suspended" } }).catch(() => undefined);
    const names = ms.map((m) => m.org.name).join(", ");
    throw new HttpError(403, `Your access to ${names} is suspended, so you cannot sign in. Your role and history are kept. Ask an owner or admin there to reinstate you.`, { suspended: true });
  }
  await startSession(r.userId);
  return { next: safeNext(body.next) };
});
