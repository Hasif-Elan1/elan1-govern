import { randomBytes } from "node:crypto";
import { signRequest } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import type { FastifyInstance } from "fastify";
import { setUpDemoAgent, createOrg } from "../src/admin";
import { buildApp } from "../src/app";
import type { Deps } from "../src/deps";
import { readGateEnv } from "../src/env";
import type { Mail } from "../src/mailer";

export const env = readGateEnv();

export async function makeApp(overrides: Partial<Deps> = {}) {
  const sent: Mail[] = [];
  const { app, deps } = await buildApp(env, { mailer: { send: async (m) => void sent.push(m) }, ...overrides });
  await app.ready();
  return { app, deps, sent };
}

export async function makeUser(prefix = "owner") {
  const email = `${prefix}-${randomBytes(4).toString("hex")}@test.in`;
  return prisma.user.create({ data: { email, name: prefix, passwordHash: "x" } });
}

/** An org with the demo AP agent, its signed rulebook and mock connectors. */
export async function demoOrg(deps: Deps) {
  const owner = await makeUser();
  const org = await createOrg(deps, { name: "Test Traders", ownerUserId: owner.id, ownerEmail: owner.email });
  const demo = await setUpDemoAgent(deps, org.id, owner);
  return { org, owner, ...demo, db: forOrg(org.id) };
}

export async function internal(app: FastifyInstance, method: "GET" | "POST", url: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return app.inject({
    method,
    url,
    headers: { "content-type": "application/json", "x-gate-signature": signRequest(env.INTERNAL_API_SECRET, method, url, payload) },
    ...(payload ? { payload } : {}),
  });
}

let rpcId = 1;
export async function mcp(app: FastifyInstance, key: string, method: string, params: unknown = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return { status: res.statusCode, body: res.json() as { result?: McpResult; error?: { message: string } }, raw: res.body };
}

export interface McpResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: { gate: Record<string, unknown> };
  tools?: { name: string }[];
}

export async function tool(app: FastifyInstance, key: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(app, key, "tools/call", { name, arguments: args });
  if (!r.body.result) throw new Error(`MCP error: ${r.raw}`);
  return r.body.result;
}

export const gateMeta = (r: McpResult) => r.structuredContent?.gate ?? {};
