import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { startSession } from "@/server/session";
import { finishSso, SSO_COOKIE, SsoError } from "@/server/sso";

/** The identity provider sends the browser back here with a one-time code. */
export async function GET(req: NextRequest) {
  const jar = await cookies();
  const cookie = jar.get(SSO_COOKIE)?.value;
  jar.delete({ name: SSO_COOKIE, path: "/api/auth/sso" });
  const base = env().WEB_URL;
  // Validate against the public URL the IdP was given, not an internal host.
  const current = new URL(`${base}${req.nextUrl.pathname}${req.nextUrl.search}`);
  try {
    const r = await finishSso(current, cookie);
    await startSession(r.userId, r.orgId);
    return NextResponse.redirect(new URL(r.next, base));
  } catch (e) {
    const message = e instanceof SsoError ? e.message : "Single sign-on did not work. Try again, or ask your admin.";
    if (!(e instanceof SsoError)) log("error", "sso callback failed", { err: (e as Error).message });
    return NextResponse.redirect(new URL(`/login?sso_error=${encodeURIComponent(message)}`, base));
  }
}
