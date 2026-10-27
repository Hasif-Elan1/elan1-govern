import { forOrg, openHealthAlerts } from "@gate/db";
import { RISK_TAGS, verifyRequest } from "@gate/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminEvent,
  connectConnector,
  createAgent,
  createOrg,
  disconnectConnector,
  publishRulebook,
  rotateKey,
  setAgentStatus,
  setUpDemoAgent,
} from "../admin";
import { resolveApproval } from "../approvals";
import { authenticateAgent } from "../auth";
import { resetMockState } from "@gate/connectors";
import { runDemoAgent } from "../demo/agent";
import { checkpoint } from "../chain";
import type { Deps } from "../deps";
import { exportBundle, exportFrameworkReport, exportPack } from "../evidence";
import { rotateSigningKey } from "../keys";
import { addUpstream, removeUpstream, syncUpstream, updateUpstreamTool, type UpstreamFail } from "../upstream";
import { createWebhook, deleteWebhook, testWebhook, WEBHOOK_EVENTS } from "../webhooks";
import { replayAllowed, replayDraft } from "../replay";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const email = z.string().email().max(320).transform((e) => e.toLowerCase());
const actor = email;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Admin actions the web app may log on its own (it writes the row; Elan1 Govern writes the receipt). */
export const WEB_EVENTS = [
  "settings.updated",
  "member.invited",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "user.2fa_enabled",
  "user.2fa_disabled",
  "system.created",
  "system.updated",
  "assessment.submitted",
  "assessment.approved",
  "assessment.changes_requested",
  "org.industry_set",
  "framework.enabled",
  "framework.disabled",
] as const;

const schemas = {
  org: z.object({ name: z.string().trim().min(1).max(120), ownerUserId: id, ownerEmail: email }).strict(),
  event: z.object({ actor, action: z.enum(WEB_EVENTS), details: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).default({}) }).strict(),
  agent: z
    .object({
      name: z.string().trim().min(1).max(80),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      purpose: z.string().trim().min(1).max(500),
      ownerEmail: email,
      createdById: id,
      riskTier: z.enum(["low", "medium", "high"]),
      riskAnswers: z.record(z.string(), z.string().max(20)).optional(),
      yaml: z.string().max(200_000).optional(),
      actor,
    })
    .strict(),
  rulebook: z.object({ yaml: z.string().max(200_000), actor }).strict(),
  keys: z.object({ actor, revokeKeyId: id.optional() }).strict(),
  status: z.object({ status: z.enum(["active", "paused"]), actor }).strict(),
  resolve: z.object({ userId: id, email, result: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional(), linkId: id.optional() }).strict(),
  checkpoint: z.object({ actor }).strict(),
  export: z.object({ from: day, to: day, kind: z.enum(["bundle", "pack"]), actor }).strict(),
  report: z.object({ actor }).strict(),
  connector: z.object({ action: z.enum(["connect", "disconnect"]), mode: z.enum(["mock", "live"]).optional(), actor }).strict(),
  demo: z.object({ userId: id, email, run: z.boolean().default(true) }).strict(),
  upstream: z
    .object({
      name: z.string().trim().min(1).max(80),
      url: z.string().trim().min(1).max(2000),
      authHeader: z.string().trim().min(1).max(4000).optional(),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
      actor,
    })
    .strict(),
  actorOnly: z.object({ actor }).strict(),
  upstreamTool: z.object({ enabled: z.boolean().optional(), tags: z.array(z.enum(RISK_TAGS)).max(RISK_TAGS.length).optional(), actor }).strict(),
  webhook: z.object({ url: z.string().trim().min(1).max(2000), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length), actor }).strict(),
  replay: z.object({ yaml: z.string().max(200_000), days: z.union([z.literal(7), z.literal(30)]).default(30), actor }).strict(),
};

export function registerInternal(app: FastifyInstance, deps: Deps) {
  app.register(async (internal) => {
    internal.addHook("preHandler", async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
      if (!verifyRequest(deps.env.INTERNAL_API_SECRET, req.headers["x-gate-signature"] as string | undefined, req.method, req.url, raw)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    });

    const parse = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
      const r = schema.safeParse(body ?? {});
      if (!r.success) throw Object.assign(new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), { statusCode: 400 });
      return r.data;
    };
    const org = async (orgId: string) => {
      if (!id.safeParse(orgId).success || !(await forOrg(orgId, deps.db).org.findFirst())) throw Object.assign(new Error("no such org"), { statusCode: 404 });
      return orgId;
    };
    type P = { Params: { org: string; id: string; kind: string; tool: string } };
    const done = (reply: FastifyReply, r: { ok: true } | UpstreamFail) => (r.ok ? r : reply.code(r.status).send({ error: r.error }));

    internal.get("/internal/health", async () => ({ ok: true, alerts: deps.alerts.slice(-10), stored: await openHealthAlerts(deps.db).catch(() => []) }));

    internal.post("/internal/orgs", async (req) => {
      const b = parse(schemas.org, req.body);
      const o = await createOrg(deps, b);
      return { orgId: o.id };
    });

    internal.post<P>("/internal/orgs/:org/events", async (req) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.event, req.body);
      const r = await adminEvent(deps, orgId, b.actor, b.action, b.details);
      return { seq: r.seq };
    });

    internal.post<P>("/internal/orgs/:org/agents", async (req, reply) => {
      const orgId = await org(req.params.org);
      const { yaml, ...b } = parse(schemas.agent, req.body);
      const r = await createAgent(deps, orgId, b);
      if (!r.ok) return reply.code(409).send({ error: r.error });
      const published = yaml ? await publishRulebook(deps, orgId, r.agent.id, yaml, b.actor) : undefined;
      return { agentId: r.agent.id, apiKey: r.apiKey, rulebook: published };
    });

    internal.post<P>("/internal/orgs/:org/agents/:id/rulebooks", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.rulebook, req.body);
      const r = await publishRulebook(deps, orgId, parse(id, req.params.id), b.yaml, b.actor);
      return r.ok ? r : reply.code(422).send(r);
    });

    internal.post<P>("/internal/orgs/:org/agents/:id/keys", async (req) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.keys, req.body);
      return rotateKey(deps, orgId, parse(id, req.params.id), b.actor, b.revokeKeyId);
    });

    internal.post<P>("/internal/orgs/:org/agents/:id/status", async (req) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.status, req.body);
      const a = await setAgentStatus(deps, orgId, parse(id, req.params.id), b.status, b.actor);
      return { status: a.status };
    });

    internal.post<P>("/internal/orgs/:org/approvals/:id/resolve", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.resolve, req.body);
      const r = await resolveApproval(deps, orgId, parse(id, req.params.id), b);
      if (r.ok) return r;
      const code = { not_found: 404, not_pending: 409, expired: 410, not_approver: 403, link_invalid: 410 }[r.code];
      return reply.code(code).send(r);
    });

    internal.post<P>("/internal/orgs/:org/checkpoints", async (req) => {
      const orgId = await org(req.params.org);
      parse(schemas.checkpoint, req.body);
      const cp = await checkpoint(deps, orgId);
      return { checkpoint: cp };
    });

    // ---- Signing keys ----

    internal.post<P>("/internal/orgs/:org/signing-key/rotate", async (req) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.actorOnly, req.body);
      return rotateSigningKey(deps, orgId, b.actor);
    });

    // ---- Webhooks ----

    internal.post<P>("/internal/orgs/:org/webhooks", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.webhook, req.body);
      const r = await createWebhook(deps, orgId, b);
      return r.ok ? r : reply.code(400).send({ error: r.error });
    });

    internal.post<P>("/internal/orgs/:org/webhooks/:id/delete", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.actorOnly, req.body);
      return (await deleteWebhook(deps, orgId, parse(id, req.params.id), b.actor)) ? { deleted: true } : reply.code(404).send({ error: "No such webhook." });
    });

    internal.post<P>("/internal/orgs/:org/webhooks/:id/test", async (req, reply) => {
      const orgId = await org(req.params.org);
      parse(schemas.actorOnly, req.body);
      const r = await testWebhook(deps, orgId, parse(id, req.params.id));
      return r ?? reply.code(404).send({ error: "No such webhook." });
    });

    internal.post<P>("/internal/orgs/:org/export", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.export, req.body);
      if (b.from > b.to) return reply.code(400).send({ error: "from must be on or before to" });
      const bytes = b.kind === "pack" ? await exportPack(deps, orgId, b, b.actor) : await exportBundle(deps, orgId, b, b.actor);
      return reply.type("application/zip").send(Buffer.from(bytes));
    });

    internal.post<P>("/internal/orgs/:org/frameworks/:id/report", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.report, req.body);
      const bytes = await exportFrameworkReport(deps, orgId, parse(z.string().regex(/^[a-z0-9-]{1,64}$/), req.params.id), b.actor);
      if (!bytes) return reply.code(404).send({ error: "no such framework" });
      return reply.type("application/pdf").send(Buffer.from(bytes));
    });

    internal.post<P>("/internal/orgs/:org/connectors/:kind", async (req, reply) => {
      const orgId = await org(req.params.org);
      const kind = parse(z.enum(["gmail", "zoho"]), req.params.kind);
      const b = parse(schemas.connector, req.body);
      const r = b.action === "connect" ? await connectConnector(deps, orgId, kind, b.actor, b.mode) : await disconnectConnector(deps, orgId, kind, b.actor);
      return r.ok ? r : reply.code(400).send(r);
    });

    // Upstream MCP servers. Elan1 Govern keeps the auth header; it never comes back out.
    internal.post<P>("/internal/orgs/:org/upstreams", async (req, reply) => {
      const orgId = await org(req.params.org);
      const { actor: a, ...b } = parse(schemas.upstream, req.body);
      return done(reply, await addUpstream(deps, orgId, { ...b, actor: a }));
    });

    internal.post<P>("/internal/orgs/:org/upstreams/:id/sync", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.actorOnly, req.body);
      return done(reply, await syncUpstream(deps, orgId, parse(id, req.params.id), b.actor));
    });

    internal.post<P>("/internal/orgs/:org/upstreams/:id/remove", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.actorOnly, req.body);
      return done(reply, await removeUpstream(deps, orgId, parse(id, req.params.id), b.actor));
    });

    internal.post<P>("/internal/orgs/:org/upstreams/:id/tools/:tool", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.upstreamTool, req.body);
      return done(reply, await updateUpstreamTool(deps, orgId, parse(id, req.params.id), parse(id, req.params.tool), b));
    });

    // Test a draft rulebook on past actions: a simulation over the replay store. Nothing runs or is published.
    internal.post<P>("/internal/orgs/:org/agents/:id/replay", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.replay, req.body);
      if (!replayAllowed(orgId)) return reply.code(429).send({ error: "Too many tests in a minute. Try again shortly." });
      const r = await replayDraft(deps, orgId, parse(id, req.params.id), b.yaml, b.days);
      if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.errors ? { errors: r.errors } : {}) });
      deps.log.info({ orgId, days: b.days, total: r.report.total, changed: r.report.changed }, "rulebook replayed");
      return r.report;
    });

    // Dev only: give the demo agent's org a fresh mock mailbox and ledger.
    internal.post("/internal/demo/reset", async (req, reply) => {
      if (deps.env.NODE_ENV === "production") return reply.code(404).send({ error: "not found" });
      const who = await authenticateAgent(deps, req.headers.authorization);
      if (!who) return reply.code(401).send({ error: "Missing or invalid agent API key" });
      resetMockState(who.orgId);
      return { reset: true };
    });

    internal.post<P>("/internal/orgs/:org/demo", async (req) => {
      const orgId = await org(req.params.org);
      const b = parse(schemas.demo, req.body);
      const r = await setUpDemoAgent(deps, orgId, { id: b.userId, email: b.email });
      if (b.run) {
        const run = runDemoAgent({ url: `${deps.env.GATE_INTERNAL_URL}/mcp`, apiKey: r.apiKey, waitForApproval: false, log: (m) => deps.log.info({ demo: orgId }, m) }).catch((e: Error) =>
          deps.log.warn({ err: e.message }, "demo run failed"),
        );
        deps.background.add(run);
        void run.finally(() => deps.background.delete(run));
      }
      return r;
    });
  });
}
