import { verifyRequest } from "@gate/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { wiringCtx } from "../console-wiring";
import type { Deps } from "../deps";
import { billingRoutes } from "../wiring/billing";
import { egressRoutes } from "../wiring/egress";
import { webhookRoutes } from "../wiring/webhooks";

// The console's screens on the real backends (apps/gate/src/console-wiring.ts): /internal/orgs/:org/wiring/…,
// signed with INTERNAL_API_SECRET like every internal route.
export function registerConsoleWiring(app: FastifyInstance, deps: Deps) {
  app.register(async (r) => {
    r.addHook("preHandler", async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
      if (!verifyRequest(deps.env.INTERNAL_API_SECRET, req.headers["x-gate-signature"] as string | undefined, req.method, req.url, raw)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    });
    const w = wiringCtx(deps);
    billingRoutes(r, w);
    egressRoutes(r, w);
    webhookRoutes(r, w);
  });
}
