import "server-only";
import { randomUUID } from "node:crypto";
import { safeEqual } from "@gate/core";
import { cookies, headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { env } from "./env";
import { log } from "./log";
import { can, type Permission } from "./policy";
import { hit, LIMIT_MULTIPLIER, LIMITS } from "./ratelimit";
import { CSRF_COOKIE, currentCtx, currentSession, isFresh, type Ctx } from "./session";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export const fail = (status: number, message: string, extra?: Record<string, unknown>) => {
  throw new HttpError(status, message, extra);
};

type Limit = { max: number; windowMs: number };

interface Opts<S extends z.ZodType> {
  /** "public": no session. "user": signed in, org optional. "org": signed in with an active org. */
  auth: "public" | "user" | "org";
  permission?: Permission;
  /** Needs a sign-in within the last 10 minutes. */
  fresh?: boolean;
  body?: S;
  limit?: Limit & { name: string };
}

type HandlerCtx<S extends z.ZodType, A extends Opts<S>["auth"]> = {
  req: NextRequest;
  body: z.infer<S>;
  params: Record<string, string>;
  ctx: A extends "org" ? Ctx : Ctx | null;
  userId: string | null;
  ip: string;
};

/** The caller's address. Forwarded headers are trusted only behind a known proxy (TRUST_PROXY=true). */
async function clientIp(): Promise<string> {
  const h = await headers();
  if (process.env.TRUST_PROXY === "true") return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  // Without a trusted proxy every header is client-controlled, so all callers share one bucket.
  return "direct";
}

/** Same-origin check for every state-changing request, on top of the CSRF token. */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  const allowed = new Set([new URL(env().WEB_URL).origin, req.nextUrl.origin]);
  return allowed.has(origin);
}

/**
 * Every API route goes through here: rate limit → CSRF → session → permission →
 * fresh sign-in → zod-validated body. Errors come back as { error } with a plain message.
 */
export function route<S extends z.ZodType = z.ZodUndefined, A extends Opts<S>["auth"] = "org">(
  opts: Opts<S> & { auth: A },
  fn: (h: HandlerCtx<S, A>) => Promise<Response | Record<string, unknown> | unknown[]>,
) {
  return async (req: NextRequest, segment: { params: Promise<Record<string, string>> }) => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const started = Date.now();
    let userId: string | null = null;
    try {
      const ip = await clientIp();
      const lim = opts.limit ?? (req.method === "GET" ? undefined : { name: "mutation", ...LIMITS.mutation });
      if (lim) {
        const r = hit(`${lim.name}:${ip}`, lim.max * LIMIT_MULTIPLIER, lim.windowMs);
        if (!r.ok) throw new HttpError(429, `Too many requests. Try again in ${r.retryAfter} seconds.`, { retryAfter: r.retryAfter });
      }

      const ctxOrNull = await currentCtx();
      const ctx = ctxOrNull && ctxOrNull !== "no-org" ? ctxOrNull : null;
      const session = await currentSession();
      userId = session?.userId ?? null;
      const signedIn = session !== null;

      if (req.method !== "GET" && req.method !== "HEAD") {
        if (!sameOrigin(req)) throw new HttpError(403, "This request came from another site, so it was blocked.");
        // Signed in: the token bound to the session. Signed out (login, sign-up): the double-submit cookie.
        const sent = req.headers.get("x-csrf-token") ?? "";
        const expected = session ? session.csrfToken : (await cookies()).get(CSRF_COOKIE)?.value;
        if (!sent || !expected || !safeEqual(sent, expected)) {
          throw new HttpError(403, "Your session token is missing or out of date. Reload the page and try again.");
        }
      }

      if (opts.auth !== "public" && !signedIn) throw new HttpError(401, "Sign in to continue.");
      if (opts.auth === "org" && !ctx) throw new HttpError(403, "Create or join an organisation first.");
      if (opts.permission && (!ctx || !can(ctx.role, opts.permission))) throw new HttpError(403, "Your role does not allow this.");
      if (opts.fresh && (!ctx || !isFresh(ctx.session.lastAuthAt))) throw new HttpError(401, "Confirm it's you to continue.", { reauth: true });

      let body: unknown = undefined;
      if (opts.body) {
        const raw = await req.json().catch(() => undefined);
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) {
          const i = parsed.error.issues[0];
          throw new HttpError(400, i ? `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` : "Invalid request.");
        }
        body = parsed.data;
      }
      const params = await segment.params;
      const out = await fn({ req, body, params, ctx: ctx as HandlerCtx<S, A>["ctx"], userId, ip } as HandlerCtx<S, A>);
      const res = out instanceof Response ? out : NextResponse.json(out);
      res.headers.set("x-request-id", requestId);
      res.headers.set("cache-control", "no-store");
      log("info", "api", { requestId, method: req.method, path: req.nextUrl.pathname, status: res.status, ms: Date.now() - started, userId });
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : "Something went wrong on our side. Nothing was changed.";
      log(status >= 500 ? "error" : "warn", "api", { requestId, method: req.method, path: req.nextUrl.pathname, status, userId, err: status >= 500 ? (e as Error).message : undefined });
      return NextResponse.json({ error: message, ...(e instanceof HttpError ? e.extra : {}) }, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
    }
  };
}
