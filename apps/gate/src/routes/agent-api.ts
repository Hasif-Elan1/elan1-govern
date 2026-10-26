import { appendReceipt, forOrg } from "@gate/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { waitForApproval } from "../approvals";
import { authenticateAgent } from "../auth";
import { orgKey, type Deps } from "../deps";
import { guard } from "../guard";

const CheckBody = z.object({ tool: z.string().min(1).max(100), args: z.record(z.unknown()).default({}) }).strict();
const RecordBody = z
  .object({
    check_id: z.number().int().positive().optional(),
    approval_id: z.string().max(64).optional(),
    status: z.enum(["ok", "error"]),
    ref: z.string().max(200).optional(),
    error: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => (b.check_id === undefined) !== (b.approval_id === undefined), "give exactly one of check_id or approval_id");

const limit = { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } };

/** REST Event API for agents that run their own tools (the SDK): check first, record after. */
export function registerAgentApi(app: FastifyInstance, deps: Deps) {
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const who = await authenticateAgent(deps, req.headers.authorization);
    if (!who) {
      await reply.code(401).header("www-authenticate", 'Bearer realm="gate"').send({ error: "Missing or invalid agent API key" });
      return null;
    }
    return who;
  };

  app.post("/v1/check", limit, async (req, reply) => {
    const who = await auth(req, reply);
    if (!who) return;
    const body = CheckBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    const r = await guard(deps, who, body.data.tool, body.data.args, "check");
    const base = { rule_id: r.ruleId, reason: r.reason, check_id: r.seq ?? null };
    if (r.status === "ok") return { decision: "allow", ...base };
    if (r.status === "pending") return { decision: "ask", ...base, approval_id: r.approvalId, approval_url: r.approvalUrl, expires_at: r.expiresAt };
    return { decision: "refuse", ...base };
  });

  app.post("/v1/record", limit, async (req, reply) => {
    const who = await auth(req, reply);
    if (!who) return;
    const body = RecordBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    const db = forOrg(who.orgId, deps.db);
    const agent = await db.agent.findFirstOrThrow({ where: { id: who.agentId } });

    let refSeq: number | undefined;
    if (body.data.check_id !== undefined) {
      const row = await db.receipt.findFirst({ where: { seq: body.data.check_id, kind: "decision", decision: "allow", agent: agent.slug, outcome: null } });
      if (!row) return reply.code(404).send({ error: "No allowed check with that id for this agent." });
      refSeq = row.seq;
    } else {
      const a = await db.approval.findFirst({ where: { id: body.data.approval_id, agentId: agent.id, status: "approved", executor: "agent" } });
      if (!a) return reply.code(404).send({ error: "No approved action with that id for this agent." });
      refSeq = a.heldSeq;
    }
    const held = await db.receipt.findFirstOrThrow({ where: { seq: refSeq } });
    const dup = await db.receipt.findFirst({ where: { kind: "outcome", body: { path: ["ref_seq"], equals: refSeq } } });
    if (dup) return reply.code(409).send({ error: "An outcome was already recorded for this action." });

    const heldBody = held.body as { tool?: string; args_summary?: Record<string, unknown>; rule_id?: string };
    const key = await orgKey(deps, who.orgId);
    const receipt = await appendReceipt(
      who.orgId,
      key.privateKeyPem,
      {
        kind: "outcome",
        agent: agent.slug,
        tool: heldBody.tool,
        args_summary: heldBody.args_summary,
        rule_id: heldBody.rule_id,
        outcome: { status: body.data.status, ...(body.data.ref ? { ref: body.data.ref } : {}), ...(body.data.error ? { error: body.data.error } : {}) },
        ref_seq: refSeq,
      },
      deps.db,
    );
    return { recorded: true, receipt_seq: receipt.seq };
  });

  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>("/v1/approvals/:id", limit, async (req, reply) => {
    const who = await auth(req, reply);
    if (!who) return;
    const id = z.string().max(64).safeParse(req.params.id);
    const wait = z.coerce.number().min(0).max(30).default(0).safeParse(req.query.wait);
    if (!id.success || !wait.success) return reply.code(400).send({ error: "invalid request" });
    const status = await waitForApproval(deps, who.orgId, who.agentId, id.data, wait.data);
    if (!status) return reply.code(404).send({ error: "No approval with that id for this agent." });
    return status;
  });
}
