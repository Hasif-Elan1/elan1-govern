import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = [/^\/login/, /^\/signup/, /^\/forgot/, /^\/reset\//, /^\/invite\//, /^\/approve\//, /^\/api\//, /^\/_next\//, /^\/favicon/, /^\/icon/, /^\/robots\.txt$/];

function b64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const signedIn = req.cookies.has("gate_session");

  if (!signedIn && !PUBLIC.some((r) => r.test(pathname))) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ].join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("content-security-policy", csp);

  // Double-submit CSRF cookie for signed-out forms (login, sign-up). Signed-in requests use the session's token.
  if (!req.cookies.has("gate_csrf")) {
    res.cookies.set("gate_csrf", b64(crypto.getRandomValues(new Uint8Array(32))), {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE !== "false",
      path: "/",
    });
  }
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
