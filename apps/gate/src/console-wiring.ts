import { forOrg } from "@gate/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Deps } from "./deps";

/*
 * The approved console's screens on the real backends (wiring). The console's domain runs in the web app
 * (apps/web/src/server/console-domain.ts); an operation the real backend serves itself is overridden there
 * (apps/web/src/server/console-overrides/wiring.ts) and calls these internal routes, HMAC-signed like every
 * internal route (routes/console-wiring.ts). Each route does the real change and writes its receipt on the
 * organisation's chain, in the console's words and with the console's person as the actor (the console's user
 * ids are the real User ids), and returns the receipt's seq; the web app then brings the console's document up
 * to the chain. Reads go the other way: the web app reads the tenant tables itself, through forOrg.
 *
 * One module per area under ./wiring/: billing (the ledger), egress (sovereign egress and updates) and webhooks
 * (webhooks and chat channels). Identity settings need no route here: the web app changes those tables itself.
 */

/** A console person (u_ananya …), as the receipt's actor; or an email, as the web app's own routes send. */
export const wiringActor = z.string().regex(/^[A-Za-z0-9_.:@+-]{1,120}$/);

/** A refusal the console shows as it is. */
export type WiringFail = { ok: false; status: 400 | 403 | 404 | 409 | 422 | 429 | 502; error: string };
export const fail = (status: WiringFail["status"], error: string): WiringFail => ({ ok: false, status, error });

export interface WiringCtx {
  deps: Deps;
  /** The organisation in the path, or a 404 (an organisation the gate does not hold). */
  org(orgId: string): Promise<string>;
  /** The body, checked; a 400 when it does not fit. */
  parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T>;
  /** A route's answer: a refusal as its status and { error }, anything else as it is. */
  send(reply: FastifyReply, r: unknown): unknown;
}

export type WiringRoutes = (r: FastifyInstance, w: WiringCtx) => void;

export function wiringCtx(deps: Deps): WiringCtx {
  return {
    deps,
    async org(orgId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId) || !(await forOrg(orgId, deps.db).org.findFirst({ select: { id: true } }))) throw Object.assign(new Error("no such org"), { statusCode: 404 });
      return orgId;
    },
    parse(schema, body) {
      const r = schema.safeParse(body ?? {});
      if (!r.success) throw Object.assign(new Error(r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), { statusCode: 400 });
      return r.data;
    },
    send(reply, r) {
      if (r && typeof r === "object" && (r as WiringFail).ok === false && typeof (r as WiringFail).status === "number") {
        const f = r as WiringFail;
        return reply.code(f.status).send({ error: f.error });
      }
      return r;
    },
  };
}
