import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isKnownTool, TOOLS, TOOL_ARGS, TOOL_NAMES } from "@gate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { waitForApproval } from "./approvals";
import { authenticateAgent } from "./auth";
import type { Deps } from "./deps";
import { guard, type AgentIdentity, type GuardResult } from "./guard";
import { registryFor } from "./registry";

export const STATUS_TOOL = "gate.approval_status";

function jsonSchema(tool: (typeof TOOL_NAMES)[number]) {
  const { $schema: _s, ...schema } = z.toJSONSchema(TOOL_ARGS[tool], { target: "draft-7" }) as Record<string, unknown>;
  return schema as { type: "object"; [k: string]: unknown };
}

const CHECKED = "Every call is checked by Gate: it may run, wait for a person, or be refused.";

export const MCP_TOOLS = [
  ...TOOL_NAMES.map((name) => ({
    name,
    description: `${TOOLS[name].description} ${CHECKED}`,
    inputSchema: jsonSchema(name),
  })),
  {
    name: STATUS_TOOL,
    description: "Check on an action that is waiting for approval. Waits up to wait_seconds (max 30) for a decision. When approved, returns the action's result.",
    inputSchema: {
      type: "object" as const,
      properties: { approval_id: { type: "string" }, wait_seconds: { type: "number", minimum: 0, maximum: 30 } },
      required: ["approval_id"],
      additionalProperties: false,
    },
  },
];

/** Built-in tools, the org's enabled upstream tools (with the upstream's input schemas), and the status tool. */
async function listTools(deps: Deps, orgId: string) {
  const upstream = (await registryFor(deps, orgId))
    .list()
    .filter((s) => !isKnownTool(s.name))
    .map((s) => ({ name: s.name, description: `${s.description} ${CHECKED}`.trim(), inputSchema: { ...s.inputSchema, type: "object" as const } }));
  return [...MCP_TOOLS.slice(0, -1), ...upstream, MCP_TOOLS[MCP_TOOLS.length - 1]!];
}

const text = (t: string) => [{ type: "text" as const, text: t }];

export function toMcpResult(r: GuardResult): CallToolResult {
  switch (r.status) {
    case "ok":
      return { content: text(JSON.stringify(r.result ?? null, null, 2)), structuredContent: { gate: { decision: "allow", rule_id: r.ruleId, receipt_seq: r.seq, ref: r.ref ?? null } } };
    case "pending":
      return {
        content: text(
          `Waiting for approval. ${r.reason}\napproval_id: ${r.approvalId}\nA person can decide here: ${r.approvalUrl}\nCall ${STATUS_TOOL} with this approval_id to wait for the decision. Do not retry the action.`,
        ),
        structuredContent: { gate: { decision: "ask", status: "pending", rule_id: r.ruleId, approval_id: r.approvalId, approval_url: r.approvalUrl, expires_at: r.expiresAt, receipt_seq: r.seq } },
      };
    case "refused":
      return { isError: true, content: text(`Refused by rule "${r.ruleId}": ${r.reason}`), structuredContent: { gate: { decision: "refuse", rule_id: r.ruleId, reason: r.reason, receipt_seq: r.seq ?? null } } };
    case "failed":
      return { isError: true, content: text(r.reason), structuredContent: { gate: { decision: "allow", status: "failed", rule_id: r.ruleId, receipt_seq: r.seq } } };
  }
}

function buildServer(deps: Deps, who: AgentIdentity) {
  const server = new Server({ name: "gate", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(deps, who.orgId) }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    if (name === STATUS_TOOL) {
      const a = (args ?? {}) as { approval_id?: unknown; wait_seconds?: unknown };
      if (typeof a.approval_id !== "string" || a.approval_id.length > 64) return { isError: true, content: text("approval_id is required") };
      const wait = typeof a.wait_seconds === "number" ? a.wait_seconds : 30;
      const status = await waitForApproval(deps, who.orgId, who.agentId, a.approval_id, wait);
      if (!status) return { isError: true, content: text("No approval with that id for this agent.") };
      const failed = status.status === "rejected" || status.status === "expired";
      return { isError: failed, content: text(`${status.message}\n${JSON.stringify(status, null, 2)}`), structuredContent: { gate: status } };
    }
    return toMcpResult(await guard(deps, who, name, args ?? {}, "execute"));
  });
  return server;
}

export function registerMcp(app: FastifyInstance, deps: Deps) {
  app.post("/mcp", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (req, reply) => {
    const who = await authenticateAgent(deps, req.headers.authorization);
    if (!who) {
      return reply.code(401).header("www-authenticate", 'Bearer realm="gate"').send({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid agent API key" }, id: null });
    }
    const server = buildServer(deps, who);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST. This server is stateless." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
