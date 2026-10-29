import { verifyRequest } from "@gate/core";
import { forOrg } from "@gate/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ChainHeadInput, ChainMoved, ConsoleReceiptInput } from "../console-chain";
import { anchorNow, flushSigned, sealUpTo, SealInput, SignatureRequest, SigningRefused, withdrawSuccessor } from "../console-signing";
import { activateSuccessor, planSuccessor, settleSuccessor } from "../custody";
import type { Deps } from "../deps";

// What the org key signs for the approved console besides receipts (apps/gate/src/console-signing.ts). Signed with
// INTERNAL_API_SECRET like every internal route. No route here signs bytes or a digest it is handed: each takes a
// structured request, and the message is built and checked against the organisation's chain in console-signing.ts.

const actor = z.string().trim().min(1).max(200);
const schemas = {
  flush: z
    .object({
      base: ChainHeadInput,
      receipts: z.array(ConsoleReceiptInput).max(500),
      checkpoint: z.boolean().default(false),
      requests: z.array(SignatureRequest).min(1).max(50),
      actor,
    })
    .strict(),
  seal: SealInput,
  anchor: z.object({ actor }).strict(),
  withdraw: z.object({ actor, reason: z.string().trim().min(1).max(300) }).strict(),
  settle: z.object({}).strict(),
};

/** An evidence bundle's manifest request carries the whole bundle (about 2 MB per 1,000 sealed receipts). */
const FLUSH_BODY_LIMIT = 48 * 1024 * 1024;

export function registerConsoleSigning(app: FastifyInstance, deps: Deps) {
  app.register(async (r) => {
    r.addHook("preHandler", async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
      if (!verifyRequest(deps.env.INTERNAL_API_SECRET, req.headers["x-gate-signature"] as string | undefined, req.method, req.url, raw)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    });
    const parse = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
      const p = schema.safeParse(body ?? {});
      if (!p.success) throw Object.assign(new Error(p.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), { statusCode: 400 });
      return p.data;
    };
    const org = async (orgId: string) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId) || !(await forOrg(orgId, deps.db).org.findFirst())) throw Object.assign(new Error("no such org"), { statusCode: 404 });
      return orgId;
    };
    const refused = (reply: FastifyReply, e: unknown) => {
      if (e instanceof ChainMoved) return reply.code(409).send({ error: e.message, head: e.head });
      if (e instanceof SigningRefused) return reply.code(422).send({ error: e.message });
      throw e;
    };
    type P = { Params: { org: string } };

    // a console operation that asked for signatures (or an erasure): its receipts and those, in one chain write
    r.post<P>("/internal/orgs/:org/console-signing/flush", { bodyLimit: FLUSH_BODY_LIMIT }, async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.flush, req.body);
      return flushSigned(deps, orgId, b).catch((e: unknown) => refused(reply, e));
    });

    // Seal v6 records for every receipt up to the head (from the organisation's L2 boundary)
    r.post<P>("/internal/orgs/:org/console-signing/seal", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.seal, req.body);
      const out = await sealUpTo(deps, orgId, b).catch((e: unknown) => refused(reply, e));
      if (!out || !("seals" in out)) return out;
      return { sealed: out.seals.length, ...(out.receipt ? { receipt: out.receipt } : {}) };
    });

    // successor keys (custody.ts): bound with the active provider, confirmed by a second person, switched after the overlap
    const custodyRefused = (reply: FastifyReply, e: unknown) => {
      // custody's refusals are sentences for the person (a successor already bound, the binder confirming …)
      if (e instanceof Error && !e.name.startsWith("Prisma") && !(e instanceof ChainMoved)) return reply.code(422).send({ error: e.message });
      throw e;
    };
    r.post<P>("/internal/orgs/:org/console-signing/successor", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.anchor, req.body);
      const level = (await forOrg(orgId, deps.db).org.findFirstOrThrow({ select: { level: true } })).level;
      if (level === "l1") return reply.code(422).send({ error: "Publishing a successor ahead of signing starts at L2. At L1 the key rotates at once." });
      return planSuccessor(deps, orgId, b.actor).catch((e: unknown) => custodyRefused(reply, e));
    });
    r.post<P>("/internal/orgs/:org/console-signing/successor/confirm", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.anchor, req.body);
      return activateSuccessor(deps, orgId, b.actor).catch((e: unknown) => custodyRefused(reply, e));
    });
    r.post<P>("/internal/orgs/:org/console-signing/successor/withdraw", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.withdraw, req.body);
      return withdrawSuccessor(deps, orgId, b.actor, b.reason).catch((e: unknown) => refused(reply, e));
    });
    r.post<P>("/internal/orgs/:org/console-signing/successor/settle", async (req) => {
      const orgId = await org(req.params.org);
      parse(schemas.settle, req.body);
      return { seq: await settleSuccessor(deps, orgId) };
    });

    // "Anchor now": timestamp the organisation's new receipts with the configured authorities
    r.post<P>("/internal/orgs/:org/console-signing/anchor", async (req, reply) => {
      const orgId = await org(req.params.org);
      parse(schemas.anchor, req.body);
      const out = await anchorNow(deps, orgId).catch((e: unknown) => refused(reply, e));
      if (!Array.isArray(out)) return out;
      return { batches: out.map((b) => ({ id: b.id, fromSeq: b.fromSeq, toSeq: b.toSeq, root: b.root, status: b.status, receiptSeq: b.receiptSeq })) };
    });
  });
}
