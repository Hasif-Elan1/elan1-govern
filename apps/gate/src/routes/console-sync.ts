import { RISK_TAGS, verifyRequest, type GuardSyncPayload } from "@gate/core";
import { forOrg } from "@gate/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { applyGuardSync } from "../console-sync";
import type { Deps } from "../deps";

// The console's governance configuration, from the web app (apps/web/src/server/console-sync.ts). Signed with
// INTERNAL_API_SECRET like every internal route; checked field by field, since it becomes keys, rulebooks and
// decisions.

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
const text = (max: number) => z.string().max(max);
const iso = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)), "a date");
const condition = z.object({ field: text(80), op: text(40), value: z.union([text(500), z.number(), z.array(text(500)).max(500)]) }).strict();
const rule = z
  .object({
    id: text(80),
    match: z.object({ tool: text(130).optional(), tag: text(40).optional() }).strict(),
    when: z.array(condition).max(50).optional(),
    unless: z.array(condition).max(50).optional(),
    decide: text(20),
    approver: text(80).optional(),
    reason: text(2000).default(""),
    expiresIn: text(20).optional(),
    approveInChat: z.boolean().optional(),
    quota: z.object({ kind: text(20), field: text(80).optional(), limit: z.number(), window: text(20) }).strict().optional(),
    mode: text(20).optional(),
  })
  // the console's builder keeps a few display-only fields on a rule (escalation notes and the like)
  .passthrough();

const Payload = z
  .object({
    actor: id.optional(),
    agents: z
      .array(
        z
          .object({
            id,
            slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
            name: text(200),
            description: text(2000),
            ownerId: text(80),
            riskLevel: z.enum(["low", "medium", "high"]),
            active: z.boolean(),
            stopped: z.boolean(),
            tools: z.array(text(130)).max(500),
          })
          .strict(),
      )
      .max(500),
    keys: z
      .array(
        z
          .object({
            id,
            agentId: id,
            prefix: text(40),
            label: text(200),
            environment: z.enum(["production", "sandbox"]),
            expiresAt: iso.optional(),
            revoked: z.boolean(),
            keyHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
          })
          .strict(),
      )
      .max(5000),
    tools: z
      .array(
        z
          .object({
            name: text(130),
            connectorId: text(80),
            connectorName: text(200),
            connectorUrl: text(2000).optional(),
            demo: z.boolean(),
            description: text(2000),
            tags: z.array(z.enum(RISK_TAGS)).max(RISK_TAGS.length),
            enabled: z.boolean(),
            fields: z.array(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/)).max(200),
          })
          .strict(),
      )
      .max(2000),
    groups: z.array(z.object({ id: text(80), name: text(200), members: z.array(text(80)).max(500) }).strict()).max(200),
    lists: z.record(text(80), z.array(text(500)).max(1000)),
    rulebooks: z
      .array(z.object({ id, agentId: id, version: z.number().int().min(1).nullable(), hash: text(128).nullable(), signedBy: text(80).optional(), rules: z.array(rule).max(200) }).strict())
      .max(500),
    stop: z.object({ active: z.boolean(), reason: text(300).optional(), by: text(80).optional(), since: iso.optional(), agentSlugs: z.array(text(80)).max(500).optional() }).strict(),
    approvals: z
      .array(
        z
          .object({
            id,
            status: text(40),
            approverGroup: text(200),
            allowed: z.array(text(80)).max(500),
            expiresAt: iso,
            decidedBy: text(80).optional(),
            decisionReason: text(2000).optional(),
            channel: text(40).optional(),
            override: z.boolean().optional(),
          })
          .strict(),
      )
      .max(1000),
    changes: z
      .object({ rulebooks: z.array(id).max(500), keys: z.array(id).max(5000), agents: z.array(id).max(500), approvals: z.array(id).max(1000), stop: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

export function registerConsoleSync(app: FastifyInstance, deps: Deps) {
  app.register(async (r) => {
    r.addHook("preHandler", async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
      if (!verifyRequest(deps.env.INTERNAL_API_SECRET, req.headers["x-gate-signature"] as string | undefined, req.method, req.url, raw)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    });

    r.post<{ Params: { org: string } }>("/internal/orgs/:org/console-sync", async (req, reply) => {
      const orgId = req.params.org;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId) || !(await forOrg(orgId, deps.db).org.findFirst({ select: { id: true } }))) return reply.code(404).send({ error: "no such org" });
      const parsed = Payload.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return applyGuardSync(deps, orgId, parsed.data as GuardSyncPayload);
    });
  });
}
