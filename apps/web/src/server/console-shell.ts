import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/*
 * The console's start page (apps/console's build). The middleware hands every page path to app/console-shell and
 * the console routes itself. Its other built files (scripts, styles, fonts, icons, the service worker) are copied
 * into public/ by scripts/console-assets.mjs and served from this origin as they are; this page is the one file that
 * is not, since every script tag in it needs the request's CSP nonce. The live build writes a placeholder there
 * (apps/console/vite.config.ts, html.cspNonce) and it is replaced per request. The policy is unchanged
 * (script-src 'self' 'nonce-…' 'strict-dynamic'): the entry script carries the nonce and the modules it imports
 * inherit the trust; Vite's preload helper reads the nonce from the page's csp-nonce meta tag.
 */

const PLACEHOLDER = "__GOVERN_CSP_NONCE__";
export const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/** Where scripts/console-assets.mjs puts the start page, relative to this app (where Next.js runs). */
export const SHELL_FILE = join("console-dist", "index.html");

let cached: string | undefined;

/** The built start page, or undefined when the console has not been built and copied here. */
export async function consoleShell(dir = process.cwd()): Promise<string | undefined> {
  // development re-reads it, so a new console build shows without a restart
  if (cached !== undefined && process.env.NODE_ENV === "production") return cached;
  try {
    cached = await readFile(join(dir, SHELL_FILE), "utf8");
    return cached;
  } catch {
    return undefined;
  }
}

/** The start page with the nonce in every script, preload and stylesheet tag; a script tag without one is given it. */
export function withNonce(html: string, nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error("The CSP nonce is not in the expected form.");
  return html.split(PLACEHOLDER).join(nonce).replace(/<script(?![^>]*\snonce=)/g, `<script nonce="${nonce}"`);
}

export const NOT_BUILT = `<!doctype html><html lang="en-GB"><meta charset="utf-8"><title>Elan1 Govern</title><body style="font:16px system-ui;padding:24px"><h1>The console is not built yet</h1><p>Run <code>pnpm --filter @gate/web build</code> (it builds the console and copies it here), or <code>pnpm --filter @gate/console build</code> then <code>node apps/web/scripts/console-assets.mjs</code>.</p></body></html>`;
