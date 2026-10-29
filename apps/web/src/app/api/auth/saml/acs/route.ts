import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { route } from "@/server/api";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { LIMITS } from "@/server/ratelimit";
import { finishSaml, SAML_COOKIE, SAML_COOKIE_PATH, SamlError } from "@/server/saml";
import { startSession } from "@/server/session";

const MAX_BODY = 512 * 1024;

/**
 * The assertion consumer service: the identity provider's browser form POSTs the signed answer here.
 * It is cross-site by design, so route() skips the same-origin and CSRF-token checks for this one
 * route (crossSitePost); finishSaml authenticates it with the signature, InResponseTo the request
 * id in the flow cookie, and the one-time assertion id.
 */
export const POST = route({ auth: "public", crossSitePost: "saml-acs", limit: { name: "login", ...LIMITS.login } }, async ({ req }) => {
  const jar = await cookies();
  const cookie = jar.get(SAML_COOKIE)?.value;
  jar.delete({ name: SAML_COOKIE, path: SAML_COOKIE_PATH });
  const base = env().WEB_URL;
  try {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new SamlError("The answer from your identity provider is too large.");
    const raw = await req.text();
    if (raw.length > MAX_BODY) throw new SamlError("The answer from your identity provider is too large.");
    const samlResponse = new URLSearchParams(raw).get("SAMLResponse") ?? undefined;
    const r = await finishSaml(samlResponse, cookie);
    await startSession(r.userId, r.orgId);
    // 303: the browser follows with a GET, so the form is not re-posted on reload.
    return NextResponse.redirect(new URL(r.next, base), 303);
  } catch (e) {
    const message = e instanceof SamlError ? e.message : "SAML sign-in did not work. Try again, or ask your admin.";
    if (!(e instanceof SamlError)) log("error", "saml acs failed", { err: (e as Error).message });
    return NextResponse.redirect(new URL(`/login?sso_error=${encodeURIComponent(message)}`, base), 303);
  }
});
