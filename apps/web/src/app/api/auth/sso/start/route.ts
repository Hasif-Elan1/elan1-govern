import { cookies } from "next/headers";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { env } from "@/server/env";
import { LIMITS } from "@/server/ratelimit";
import { SSO_COOKIE, startSso } from "@/server/sso";
import { email, safeNext } from "../../route-helpers";

const Body = z.object({ email, next: z.string().max(500).optional() }).strict();

/** Begin single sign-on for a work email whose domain an org has verified. */
export const POST = route({ auth: "public", body: Body, limit: { name: "login", ...LIMITS.login } }, async ({ body }) => {
  const r = await startSso(body.email, safeNext(body.next));
  if (!r) throw new HttpError(404, "Single sign-on isn't set up for this email domain. Sign in with your password instead.");
  (await cookies()).set(SSO_COOKIE, r.cookie, { httpOnly: true, secure: env().COOKIE_SECURE === "true", sameSite: "lax", path: "/api/auth/sso", maxAge: 600 });
  return { url: r.url };
});
