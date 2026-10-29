import { cookies } from "next/headers";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { LIMITS } from "@/server/ratelimit";
import { samlCookieOptions, SAML_COOKIE, startSaml } from "@/server/saml";
import { email, safeNext } from "../../route-helpers";

const Body = z.object({ email, next: z.string().max(500).optional() }).strict();

/** Begin SAML sign-in for a work email whose domain an org has verified. Returns the IdP URL. */
export const POST = route({ auth: "public", body: Body, limit: { name: "login", ...LIMITS.login } }, async ({ body }) => {
  const r = await startSaml(body.email, safeNext(body.next));
  if (!r) throw new HttpError(404, "SAML sign-in isn't set up for this email domain.");
  (await cookies()).set(SAML_COOKIE, r.cookie, samlCookieOptions());
  return { url: r.url };
});
