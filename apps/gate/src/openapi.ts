import { z } from "zod";
import { MCP_TOOLS, STATUS_TOOL } from "./mcp";
import { ApprovalStatusResponse, CheckBody, CheckResponse, ErrorResponse, RecordBody, RecordResponse } from "./routes/schemas";

export const API_VERSION = "1.0.0";
export const DEFAULT_SERVER = "http://localhost:4000";

/** JSON Schema 2020-12 (the dialect OpenAPI 3.1 uses) from a zod schema, without the $schema key. */
function schema(s: z.ZodType, io: "input" | "output" = "output"): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { target: "draft-2020-12", io, unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

const json = (ref: string) => ({ "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } });
const error = (description: string) => ({ description, content: json("Error") });

const ERRORS = {
  "401": error("Missing or invalid agent API key."),
  "429": error("Too many requests for this key (300 a minute)."),
  "500": error("Elan1 Govern failed. Nothing ran, and the action counts as refused."),
};

/**
 * The OpenAPI 3.1 description of the agent-facing API: the REST Event API (/v1) and the MCP
 * endpoint. docs/openapi.json is this, with the default server; a test keeps them in step.
 */
export function openApiSpec(serverUrl: string = DEFAULT_SERVER) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Elan1 Govern agent API",
      version: API_VERSION,
      summary: "Check every action against a signed rulebook before it runs, and record what happened.",
      description:
        "Agents that run their own tools call `POST /v1/check` before acting and `POST /v1/record` after. " +
        "Actions that need a person return `decision: ask`; poll `GET /v1/approvals/{id}?wait=30` for the decision. " +
        "MCP clients use `POST /mcp` instead, where Elan1 Govern runs the tools itself. Every decision is written to a signed, hash-chained receipt.",
      contact: { email: "hello@elan1.ai" },
    },
    servers: [{ url: serverUrl }],
    security: [{ agentKey: [] }],
    tags: [
      { name: "Event API", description: "For agents that run their own tools (the SDK)." },
      { name: "MCP", description: "Model Context Protocol over streamable HTTP. Elan1 Govern runs the tools." },
      { name: "Meta", description: "This description." },
    ],
    paths: {
      "/v1/check": {
        post: {
          operationId: "check",
          tags: ["Event API"],
          summary: "Ask whether an action may run",
          description: "Nothing is run. Writes a decision receipt. An `allow` returns a `check_id` to pass to `/v1/record`.",
          requestBody: { required: true, content: json("CheckRequest") },
          responses: {
            "200": { description: "Elan1 Govern's decision.", content: json("CheckResponse") },
            "400": error("The body is not valid."),
            ...ERRORS,
          },
        },
      },
      "/v1/record": {
        post: {
          operationId: "record",
          tags: ["Event API"],
          summary: "Report what happened after running an allowed or approved action",
          description: "Give exactly one of `check_id` or `approval_id`. Writes an outcome receipt.",
          requestBody: { required: true, content: json("RecordRequest") },
          responses: {
            "200": { description: "Recorded.", content: json("RecordResponse") },
            "400": error("The body is not valid."),
            "404": error("No allowed check or approved action with that id for this agent."),
            "409": error("An outcome was already recorded for this action."),
            ...ERRORS,
          },
        },
      },
      "/v1/approvals/{id}": {
        get: {
          operationId: "approvalStatus",
          tags: ["Event API"],
          summary: "Get, or wait for, a decision on an action that needs a person",
          parameters: [
            { name: "id", in: "path", required: true, description: "The approval_id from a check.", schema: { type: "string", maxLength: 64 } },
            { name: "wait", in: "query", required: false, description: "Seconds to wait for a decision (long poll).", schema: { type: "number", minimum: 0, maximum: 30, default: 0 } },
          ],
          responses: {
            "200": { description: "The approval's status.", content: json("ApprovalStatus") },
            "400": error("The request is not valid."),
            "404": error("No approval with that id for this agent."),
            ...ERRORS,
          },
        },
      },
      "/mcp": {
        post: {
          operationId: "mcp",
          tags: ["MCP"],
          summary: "MCP endpoint (JSON-RPC 2.0, stateless streamable HTTP)",
          description:
            "Send MCP requests such as `initialize`, `tools/list` and `tools/call` with `accept: application/json, text/event-stream`. " +
            "Each tool call is checked by Elan1 Govern: it runs, waits for a person, or is refused. A refusal is a tool result with `isError: true` and " +
            "`structuredContent.gate = { decision, rule_id, reason }`. An action that waits returns an `approval_id`; call `" +
            STATUS_TOOL +
            "` to wait for it. The tools and their input schemas are listed in `x-mcp-tools`.",
          requestBody: { required: true, content: json("JsonRpcRequest") },
          responses: {
            "200": { description: "A JSON-RPC response.", content: json("JsonRpcResponse") },
            "202": { description: "Accepted (a notification, no response body)." },
            "401": { description: "Missing or invalid agent API key.", content: json("JsonRpcResponse") },
            "429": ERRORS["429"],
          },
          "x-mcp-tools": MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      },
      "/v1/openapi.json": {
        get: {
          operationId: "openapi",
          tags: ["Meta"],
          summary: "This OpenAPI description",
          security: [],
          responses: { "200": { description: "OpenAPI 3.1 document.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
    components: {
      securitySchemes: {
        agentKey: { type: "http", scheme: "bearer", bearerFormat: "gk_…", description: "The agent's API key from Agents → your agent → Keys and connection." },
      },
      schemas: {
        CheckRequest: schema(CheckBody, "input"),
        CheckResponse: schema(CheckResponse),
        RecordRequest: schema(RecordBody, "input"),
        RecordResponse: schema(RecordResponse),
        ApprovalStatus: schema(ApprovalStatusResponse),
        Error: schema(ErrorResponse),
        JsonRpcRequest: {
          type: "object",
          required: ["jsonrpc", "method"],
          properties: {
            jsonrpc: { const: "2.0" },
            id: { type: ["string", "integer", "null"] },
            method: { type: "string", examples: ["initialize", "tools/list", "tools/call"] },
            params: { type: "object" },
          },
        },
        JsonRpcResponse: {
          type: "object",
          required: ["jsonrpc"],
          properties: {
            jsonrpc: { const: "2.0" },
            id: { type: ["string", "integer", "null"] },
            result: { type: "object" },
            error: { type: "object", required: ["code", "message"], properties: { code: { type: "integer" }, message: { type: "string" } } },
          },
        },
      },
    },
  };
}

/** The checked-in file's exact text. */
export function openApiText(): string {
  return `${JSON.stringify(openApiSpec(), null, 2)}\n`;
}
