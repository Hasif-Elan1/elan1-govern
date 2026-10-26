import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Receipt } from "@gate/core";
import { forOrg } from "@gate/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { isPrivateAddress } from "../src/upstream-net";
import { env, gateMeta, internal, makeApp, makeUser, mcp, tool } from "./helpers";
import { createOrg } from "../src/admin";

// A small CRM that speaks MCP, standing in for any customer's server.
const TOKEN = `Bearer up_${randomBytes(18).toString("hex")}`;
const calls: { tool: string; args: Record<string, unknown> }[] = [];
const seenAuth = new Set<string | undefined>();

function crm() {
  const s = new McpServer({ name: "crm", version: "1.0.0" });
  const record = (tool: string, args: Record<string, unknown>) => void calls.push({ tool, args });
  s.registerTool("lookup", { description: "Look up an order", inputSchema: { order_id: z.string() } }, async (a) => {
    record("lookup", a);
    return { content: [{ type: "text", text: "shipped" }], structuredContent: { order_id: a.order_id, status: "shipped", total: 250 } };
  });
  s.registerTool("issue_refund", { description: "Refund an order", inputSchema: { order_id: z.string(), amount: z.number() } }, async (a) => {
    record("issue_refund", a);
    return { content: [{ type: "text", text: "refunded" }], structuredContent: { id: `RF-${calls.length}`, refunded: a.amount } };
  });
  s.registerTool("delete_contact", { description: "Delete a contact", inputSchema: { contact_id: z.string() } }, async (a) => {
    record("delete_contact", a);
    return { content: [{ type: "text", text: "deleted" }] };
  });
  s.registerTool("export_all", { description: "Export every record", inputSchema: {} }, async () => {
    record("export_all", {});
    return { content: [{ type: "text", text: "everything" }] };
  });
  // A careless upstream that echoes the credentials it was sent.
  s.registerTool("echo_headers", { description: "Get the request headers", inputSchema: {} }, async (_a, extra) => {
    record("echo_headers", {});
    return { content: [{ type: "text", text: JSON.stringify(extra.requestInfo?.headers ?? {}) }] };
  });
  return s;
}

let upstream: Server;
let upstreamUrl: string;
let ctx: Awaited<ReturnType<typeof makeApp>>;
let strict: Awaited<ReturnType<typeof makeApp>>;
const bodies: string[] = [];

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    seenAuth.add(req.headers.authorization);
    if (req.headers.authorization !== TOKEN) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: `bad token ${req.headers.authorization}` }));
    if (req.method !== "POST") return void res.writeHead(405).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const server = crm();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(raw));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
  ctx = await makeApp();
  strict = await makeApp({ env: { ...env, UPSTREAM_ALLOW_PRIVATE: "false" } });
});
afterAll(async () => {
  await ctx.app.close();
  await strict.app.close();
  await new Promise((r) => upstream.close(r));
});

/** Internal API call that keeps every response body, to check for leaked secrets at the end. */
async function admin(path: string, body: unknown) {
  const res = await internal(ctx.app, "POST", path, body);
  bodies.push(res.body);
  return res;
}
async function call(key: string, name: string, args: Record<string, unknown> = {}) {
  const r = await tool(ctx.app, key, name, args);
  bodies.push(JSON.stringify(r));
  return r;
}

async function setUp() {
  const owner = await makeUser();
  const org = await createOrg(ctx.deps, { name: "Acme Support", ownerUserId: owner.id, ownerEmail: owner.email });
  const added = await admin(`/internal/orgs/${org.id}/upstreams`, { name: "CRM", url: upstreamUrl, authHeader: TOKEN, actor: owner.email });
  expect(added.statusCode, added.body).toBe(200);
  const server = added.json() as { server: { id: string; slug: string }; sync: { ok: boolean; tools: number; added: number } };
  return { owner, org, server: server.server, sync: server.sync, db: forOrg(org.id) };
}

const RULEBOOK = (owner: string) => `version: 1
agent: support-bot
owner: ${owner}
default: refuse
approvers:
  leads: [${owner}]
rules:
  - id: read-anything
    tag: reads_data
    decide: allow
  - id: small-refunds
    tag: moves_money
    when: { amount: { lte: 100 } }
    decide: allow
  - id: large-refunds
    tag: moves_money
    when: { amount: { gt: 100 } }
    decide: ask
    approver: leads
  - id: never-delete
    tag: deletes
    decide: refuse
  - id: exports
    tool: crm.export_all
    decide: allow
`;

describe("upstream MCP servers", () => {
  it("adds, syncs, governs and forwards calls end to end", async () => {
    const { owner, org, server, sync, db } = await setUp();
    expect(server.slug).toBe("crm");
    expect(sync).toMatchObject({ ok: true, tools: 5, added: 5 });
    expect(seenAuth.has(TOKEN)).toBe(true);

    // New tools are off, with suggested tags.
    const tools = await db.upstreamTool.findMany({ orderBy: { name: "asc" } });
    expect(tools.map((t) => [t.name, t.tags, t.enabled])).toEqual([
      ["crm.delete_contact", ["deletes", "personal_data"], false],
      ["crm.echo_headers", ["reads_data"], false],
      ["crm.export_all", [], false],
      ["crm.issue_refund", ["moves_money", "writes_data"], false],
      ["crm.lookup", ["reads_data"], false],
    ]);
    // A second sync keeps them and adds nothing.
    expect((await admin(`/internal/orgs/${org.id}/upstreams/${server.id}/sync`, { actor: owner.email })).json()).toMatchObject({ ok: true, tools: 5, added: 0, removed: 0 });

    // The stored header is encrypted.
    const row = await db.upstreamServer.findFirstOrThrow({ where: { id: server.id } });
    expect(row.authHeaderEnc).toBeTruthy();
    expect(row.authHeaderEnc).not.toContain(TOKEN.slice(7));

    for (const t of tools) {
      const res = await admin(`/internal/orgs/${org.id}/upstreams/${server.id}/tools/${t.id}`, { enabled: true, actor: owner.email });
      expect(res.statusCode, res.body).toBe(200);
    }
    const bad = await admin(`/internal/orgs/${org.id}/upstreams/${server.id}/tools/${tools[0]!.id}`, { tags: ["nonsense"], actor: owner.email });
    expect(bad.statusCode).toBe(400);

    const created = await admin(`/internal/orgs/${org.id}/agents`, {
      name: "Support bot",
      slug: "support-bot",
      purpose: "Answers customers and issues refunds.",
      ownerEmail: owner.email,
      createdById: owner.id,
      riskTier: "medium",
      yaml: RULEBOOK(owner.email),
      actor: owner.email,
    });
    const agent = created.json() as { agentId: string; apiKey: string; rulebook: { ok: boolean; errors?: string[] } };
    expect(agent.rulebook, created.body).toMatchObject({ ok: true });
    const key = agent.apiKey;

    // Gate lists the upstream tools with their input schemas.
    const listed = (await mcp(ctx.app, key, "tools/list")).body.result!.tools as unknown as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["crm.lookup", "crm.issue_refund", "crm.delete_contact", "gmail.search", "gate.approval_status"]));
    expect(listed.find((t) => t.name === "crm.issue_refund")!.inputSchema.properties).toMatchObject({ amount: { type: "number" } });

    // Allowed: forwarded, the upstream's data comes back, one receipt.
    const lookup = await call(key, "crm.lookup", { order_id: "A1" });
    expect(lookup.isError).toBeFalsy();
    expect(JSON.parse(lookup.content[0]!.text)).toMatchObject({ status: "shipped", total: 250 });
    expect(calls.at(-1)).toEqual({ tool: "lookup", args: { order_id: "A1" } });
    const receipts = async () => (await db.receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);
    expect((await receipts()).at(-1)).toMatchObject({ tool: "crm.lookup", decision: "allow", rule_id: "read-anything", outcome: { status: "ok" }, args_summary: { order_id: "A1" } });

    // Small refund: allowed by the tag rule, ref from the upstream.
    const small = await call(key, "crm.issue_refund", { order_id: "A1", amount: 40 });
    expect(gateMeta(small)).toMatchObject({ decision: "allow", rule_id: "small-refunds", ref: expect.stringMatching(/^RF-/) });
    expect((await receipts()).at(-1)).toMatchObject({ args_summary: { order_id: "A1", amount: 40 } });

    // Large refund: held, nothing reaches the upstream until a person approves.
    const before = calls.length;
    const held = await call(key, "crm.issue_refund", { order_id: "A2", amount: 500 });
    expect(gateMeta(held)).toMatchObject({ decision: "ask", status: "pending", rule_id: "large-refunds" });
    expect(calls.length).toBe(before);
    const approvalId = gateMeta(held).approval_id as string;
    const resolved = await admin(`/internal/orgs/${org.id}/approvals/${approvalId}/resolve`, { userId: owner.id, email: owner.email, result: "approved" });
    expect(resolved.json()).toMatchObject({ ok: true, status: "approved", outcome: { status: "ok" } });
    expect(calls.at(-1)).toEqual({ tool: "issue_refund", args: { order_id: "A2", amount: 500 } });
    const status = await call(key, "gate.approval_status", { approval_id: approvalId });
    expect(gateMeta(status)).toMatchObject({ status: "approved", result: { refunded: 500 } });

    // Refused by tag: never reaches the upstream.
    const n = calls.length;
    const del = await call(key, "crm.delete_contact", { contact_id: "c_1" });
    expect(gateMeta(del)).toMatchObject({ decision: "refuse", rule_id: "never-delete" });
    expect(calls.length).toBe(n);

    // Invalid arguments are refused against the upstream's schema.
    expect(gateMeta(await call(key, "crm.issue_refund", { order_id: "A3" }))).toMatchObject({ decision: "refuse", rule_id: "invalid-arguments" });

    // A disabled tool is refused, even though a rule names it, and disappears from the list.
    expect(gateMeta(await call(key, "crm.export_all"))).toMatchObject({ decision: "allow" });
    const exportTool = tools.find((t) => t.name === "crm.export_all")!;
    await admin(`/internal/orgs/${org.id}/upstreams/${server.id}/tools/${exportTool.id}`, { enabled: false, actor: owner.email });
    const m = calls.length;
    expect(gateMeta(await call(key, "crm.export_all"))).toMatchObject({ decision: "refuse", rule_id: "default" });
    expect(calls.length).toBe(m);
    expect(((await mcp(ctx.app, key, "tools/list")).body.result!.tools ?? []).map((t) => t.name)).not.toContain("crm.export_all");

    // An upstream that echoes the auth header does not leak it.
    const echo = await call(key, "crm.echo_headers");
    expect(echo.isError).toBeFalsy();
    expect(echo.content[0]!.text).toContain("[redacted]");

    // The auth header never appears in any response, receipt or approval.
    const secret = TOKEN.slice(7);
    for (const b of bodies) expect(b).not.toContain(secret);
    expect(JSON.stringify(await receipts())).not.toContain(secret);
    expect(JSON.stringify(await db.approval.findMany())).not.toContain(secret);

    // Every admin change has a receipt.
    const actions = (await receipts()).filter((r) => r.kind === "admin").map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["upstream.added", "upstream.synced", "upstream.tool_updated"]));

    // Removing the server takes its tools away.
    expect((await admin(`/internal/orgs/${org.id}/upstreams/${server.id}/remove`, { actor: owner.email })).statusCode).toBe(200);
    expect(await db.upstreamTool.count()).toBe(0);
    expect(gateMeta(await call(key, "crm.lookup", { order_id: "A1" }))).toMatchObject({ decision: "refuse", rule_id: "default" });
    expect((await receipts()).some((r) => r.action === "upstream.removed")).toBe(true);
  });

  it("reports a rejected auth header without echoing anything", async () => {
    const owner = await makeUser();
    const org = await createOrg(ctx.deps, { name: "Wrong Key Ltd", ownerUserId: owner.id, ownerEmail: owner.email });
    const wrong = "Bearer wrong_key_value_123456";
    const res = await admin(`/internal/orgs/${org.id}/upstreams`, { name: "CRM", url: upstreamUrl, authHeader: wrong, actor: owner.email });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sync: { ok: false, error: expect.stringMatching(/refused Gate's credentials \(HTTP 401\)/) } });
    expect(res.body).not.toContain("wrong_key_value");
    const row = await forOrg(org.id).upstreamServer.findFirstOrThrow();
    expect(row).toMatchObject({ status: "error" });
    expect(row.error).not.toContain("wrong_key_value");
    expect((await admin(`/internal/orgs/${org.id}/upstreams`, { name: "CRM", url: upstreamUrl, actor: owner.email })).statusCode).toBe(409);
    expect((await admin(`/internal/orgs/${org.id}/upstreams`, { name: "Gmail", url: upstreamUrl, actor: owner.email })).statusCode).toBe(400);
  });

  it("refuses private, loopback and non-http addresses when private upstreams are off", async () => {
    const owner = await makeUser();
    const org = await createOrg(strict.deps, { name: "Strict Ltd", ownerUserId: owner.id, ownerEmail: owner.email });
    const add = (url: string) => internal(strict.app, "POST", `/internal/orgs/${org.id}/upstreams`, { name: `S ${randomBytes(3).toString("hex")}`, url, actor: owner.email });
    for (const url of [upstreamUrl, "http://localhost:1/mcp", "http://[::1]/mcp", "http://169.254.169.254/latest", "http://10.1.2.3/mcp"]) {
      const res = await add(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toMatch(/private network/);
    }
    expect((await add("ftp://example.com/mcp")).json().error).toMatch(/http or https/);
    expect((await add("http://user:pw@example.com/mcp")).json().error).toMatch(/auth header/);
    expect((await add("not a url")).json().error).toMatch(/not a valid URL/);
    expect(await forOrg(org.id).upstreamServer.count()).toBe(0);
  });

  it("checks the address again on every connection", async () => {
    // Saved while private addresses were allowed; the strict service still will not connect.
    const { owner, org, server, db } = await setUp();
    const t = await db.upstreamTool.findFirstOrThrow({ where: { name: "crm.lookup" } });
    await admin(`/internal/orgs/${org.id}/upstreams/${server.id}/tools/${t.id}`, { enabled: true, actor: owner.email });
    const res = await internal(strict.app, "POST", `/internal/orgs/${org.id}/upstreams/${server.id}/sync`, { actor: owner.email });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/private network/);
  });

  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "not-an-ip"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
