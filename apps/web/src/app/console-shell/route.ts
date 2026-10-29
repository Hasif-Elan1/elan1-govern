import { headers } from "next/headers";
import { consoleShell, NONCE, NOT_BUILT, withNonce } from "@/server/console-shell";

/** The console's start page, with this request's CSP nonce (see server/console-shell.ts). Every page path lands here. */
export const dynamic = "force-dynamic";

async function page() {
  const nonce = (await headers()).get("x-nonce") ?? "";
  const html = await consoleShell();
  const h = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (!html) return new Response(NOT_BUILT, { status: 503, headers: h });
  // without the middleware's nonce no script could run under the policy: refuse rather than serve a broken page
  if (!NONCE.test(nonce)) return new Response("This page is served through the middleware only.", { status: 500, headers: { ...h, "content-type": "text/plain; charset=utf-8" } });
  return new Response(withNonce(html, nonce), { headers: h });
}

export const GET = page;
export const HEAD = page;
