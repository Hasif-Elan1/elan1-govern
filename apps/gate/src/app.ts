import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { hashToken } from "@gate/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { makeDeps, type Deps } from "./deps";
import type { GateEnv } from "./env";
import { registerMcp } from "./mcp";
import { registerAgentApi } from "./routes/agent-api";
import { registerChat } from "./routes/chat";
import { registerConsoleSync } from "./routes/console-sync";
import { registerInternal } from "./routes/internal";
import { registerOAuth } from "./routes/oauth";

export async function buildApp(env: GateEnv, overrides: Partial<Deps> = {}): Promise<{ app: FastifyInstance; deps: Deps }> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-gate-signature"]', 'req.headers["x-slack-signature"]', 'req.headers["x-hub-signature-256"]'], remove: true },
      serializers: {
        // Paths only: query strings can carry OAuth codes and state.
        req: (req: FastifyRequest) => ({ id: req.id, method: req.method, path: req.url.split("?")[0] }),
      },
    },
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[A-Za-z0-9-]{8,64}$/.test(h) ? h : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  const deps = makeDeps(env, app.log, overrides);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Body is not valid JSON"), { statusCode: 400 }), undefined);
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    frameguard: { action: "deny" },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => (typeof req.headers.authorization === "string" ? hashToken(req.headers.authorization).slice(0, 24) : req.ip),
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: status === 500 ? "Something went wrong. It was refused, and nothing ran." : err.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

  app.get("/healthz", async (_req, reply) => {
    let db = "up";
    try {
      await deps.db.$queryRaw`SELECT 1`;
    } catch {
      db = "down";
    }
    const recent = deps.alerts.filter((a) => Date.parse(a.at) > Date.now() - 3_600_000);
    return reply.code(db === "up" ? 200 : 503).send({ ok: db === "up", db, alerts: recent.length });
  });

  registerMcp(app, deps);
  registerAgentApi(app, deps);
  registerInternal(app, deps);
  registerOAuth(app, deps);
  registerChat(app, deps);
  registerConsoleSync(app, deps);
  return { app, deps };
}
