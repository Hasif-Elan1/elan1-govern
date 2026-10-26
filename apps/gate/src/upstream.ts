import { ConnectorError, type Connector, type ToolResult } from "@gate/connectors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { decrypt, encrypt, isValidToolName, suggestTags, type RiskTag } from "@gate/core";
import { forOrg } from "@gate/db";
import { adminEvent } from "./admin";
import type { Deps } from "./deps";
import { allowPrivateUpstreams } from "./env";
import { invalidateRegistry } from "./registry";
import { checkUpstreamUrl, upstreamFetch, UpstreamBlocked } from "./upstream-net";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TOOLS = 500;
const MAX_SCHEMA_BYTES = 100_000;
/** Connector names Gate already uses. */
const RESERVED = new Set(["gate", "gmail", "zoho"]);

export const authAad = (orgId: string, serverId: string) => `upstream-auth:${orgId}:${serverId}`;

interface ServerRow {
  id: string;
  orgId: string;
  slug: string;
  url: string;
  authHeaderEnc: string | null;
}

/** Errors are written for people and agents: never the upstream's own text, which may echo headers. */
function safeError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (e instanceof UpstreamBlocked) return new ConnectorError(e.message, "invalid");
  const name = (e as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return new ConnectorError("the MCP server did not answer in time");
  if (e instanceof StreamableHTTPError && e.code) {
    return new ConnectorError(e.code === 401 || e.code === 403 ? `the MCP server refused Gate's credentials (HTTP ${e.code})` : `the MCP server answered with HTTP ${e.code}`, e.code === 401 || e.code === 403 ? "auth" : "upstream");
  }
  const code = (e as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ?? (e as { code?: unknown })?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EHOSTUNREACH") return new ConnectorError("Gate could not reach the MCP server");
  return new ConnectorError("the MCP server did not respond as expected");
}

/** Replace the secret wherever an upstream echoes it back. */
function redact<T>(value: T, secret: string | undefined): T {
  if (!secret || value === undefined) return value;
  const parts = [secret, ...secret.split(/\s+/).filter((p) => p.length >= 8)];
  let text = JSON.stringify(value);
  if (!parts.some((p) => text.includes(p))) return value;
  for (const p of parts) text = text.split(p).join("[redacted]");
  return JSON.parse(text) as T;
}

async function withUpstream<T>(deps: Deps, row: ServerRow, fn: (client: Client, auth: string | undefined) => Promise<T>): Promise<T> {
  const auth = row.authHeaderEnc ? decrypt(deps.env.GATE_MASTER_KEY, row.authHeaderEnc, authAad(row.orgId, row.id)) : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(row.url), {
    fetch: upstreamFetch({ allowPrivate: allowPrivateUpstreams(deps.env), timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES }),
    requestInit: { headers: auth ? { authorization: auth } : {} },
  });
  const client = new Client({ name: "gate", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    return await fn(client, auth);
  } catch (e) {
    throw safeError(e);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Forwards allowed calls to the upstream server, using the org's stored credentials. */
export function upstreamConnector(deps: Deps, row: ServerRow): Connector {
  return {
    kind: "upstream",
    call: (tool, args) =>
      withUpstream(deps, row, async (client, auth): Promise<ToolResult> => {
        const res = await client.callTool({ name: tool.slice(row.slug.length + 1), arguments: args }, undefined, { timeout: TIMEOUT_MS });
        if (res.isError) throw new ConnectorError("the MCP server reported an error for this call");
        const structured = res.structuredContent as Record<string, unknown> | undefined;
        const ref = structured?.ref ?? structured?.id;
        return {
          data: redact(structured ?? res.content, auth),
          ...((typeof ref === "string" || typeof ref === "number") && String(ref).length <= 100 ? { ref: redact(String(ref), auth) } : {}),
        };
      }),
    describe: async () => ({}),
    evidence: async () => ({}),
    vendorDomains: async () => [],
  };
}

export async function upstreamFor(deps: Deps, orgId: string, slug: string) {
  return forOrg(orgId, deps.db).upstreamServer.findFirst({ where: { slug } });
}

// ---- Admin operations (each writes an admin receipt) ----

export function slugFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
}

export type UpstreamFail = { ok: false; status: number; error: string };

export async function addUpstream(deps: Deps, orgId: string, input: { name: string; url: string; authHeader?: string; slug?: string; actor: string }) {
  let url: URL;
  try {
    url = await checkUpstreamUrl(input.url, allowPrivateUpstreams(deps.env));
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof UpstreamBlocked ? e.message : "That URL cannot be used." } satisfies UpstreamFail;
  }
  const slug = input.slug ?? slugFor(input.name);
  if (!slug || RESERVED.has(slug)) return { ok: false, status: 400, error: "Choose another name: it is used for tool names like <name>.tool." } satisfies UpstreamFail;
  const db = forOrg(orgId, deps.db);
  if (await db.upstreamServer.findFirst({ where: { slug } })) return { ok: false, status: 409, error: `An MCP server called "${slug}" already exists.` } satisfies UpstreamFail;

  // The AAD binds the stored header to the row id, so the row is created first.
  const row = await db.upstreamServer.create({ data: { orgId, slug, name: input.name, url: url.toString() } });
  const authHeaderEnc = input.authHeader ? encrypt(deps.env.GATE_MASTER_KEY, input.authHeader, authAad(orgId, row.id)) : null;
  const saved = authHeaderEnc ? await db.upstreamServer.update({ where: { id: row.id }, data: { authHeaderEnc } }) : row;
  // Only the origin goes into the receipt: query strings can carry keys.
  await adminEvent(deps, orgId, input.actor, "upstream.added", { server: slug, name: input.name, origin: url.origin, auth_header: !!input.authHeader });
  const sync = await syncUpstream(deps, orgId, saved.id, input.actor);
  return { ok: true as const, server: { id: saved.id, slug }, sync };
}

export async function syncUpstream(deps: Deps, orgId: string, serverId: string, actor: string) {
  const db = forOrg(orgId, deps.db);
  const row = await db.upstreamServer.findFirst({ where: { id: serverId } });
  if (!row) return { ok: false, status: 404, error: "No such MCP server." } satisfies UpstreamFail;

  let listed: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
  try {
    listed = await withUpstream(deps, row, async (client) => {
      const out: typeof listed = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: TIMEOUT_MS });
        out.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && out.length < MAX_TOOLS);
      return out.slice(0, MAX_TOOLS);
    });
  } catch (e) {
    const error = safeError(e).message;
    await db.upstreamServer.update({ where: { id: row.id }, data: { status: "error", error } });
    await adminEvent(deps, orgId, actor, "upstream.synced", { server: row.slug, ok: false, error });
    return { ok: false, status: 502, error: `Could not list tools: ${error}.` } satisfies UpstreamFail;
  }

  const existing = new Map((await db.upstreamTool.findMany({ where: { serverId: row.id } })).map((t) => [t.name, t]));
  const seen = new Set<string>();
  let added = 0;
  let skipped = 0;
  for (const t of listed) {
    const name = `${row.slug}.${t.name}`;
    const schema = { ...t.inputSchema, type: "object" };
    if (!isValidToolName(name) || seen.has(name) || JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
      skipped++;
      continue;
    }
    seen.add(name);
    const description = (t.description ?? "").slice(0, 1000);
    if (existing.has(name)) {
      // Keep the person's tags and on/off choice; refresh what the upstream says.
      await db.upstreamTool.update({ where: { id: existing.get(name)!.id }, data: { description, inputSchema: schema } });
    } else {
      await db.upstreamTool.create({ data: { orgId, serverId: row.id, name, description, inputSchema: schema, tags: suggestTags(t.name, description), enabled: false } });
      added++;
    }
  }
  const gone = [...existing.keys()].filter((n) => !seen.has(n));
  if (gone.length) await db.upstreamTool.deleteMany({ where: { serverId: row.id, name: { in: gone } } });
  await db.upstreamServer.update({ where: { id: row.id }, data: { status: "ok", error: null, lastSyncedAt: new Date() } });
  invalidateRegistry(orgId);
  await adminEvent(deps, orgId, actor, "upstream.synced", { server: row.slug, ok: true, tools: seen.size, added, removed: gone.length, skipped });
  return { ok: true as const, tools: seen.size, added, removed: gone.length, skipped };
}

export async function updateUpstreamTool(deps: Deps, orgId: string, serverId: string, toolId: string, input: { enabled?: boolean; tags?: RiskTag[]; actor: string }) {
  const db = forOrg(orgId, deps.db);
  const tool = await db.upstreamTool.findFirst({ where: { id: toolId, serverId } });
  if (!tool) return { ok: false, status: 404, error: "No such tool." } satisfies UpstreamFail;
  const data = { ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.tags ? { tags: [...new Set(input.tags)] } : {}) };
  const saved = await db.upstreamTool.update({ where: { id: tool.id }, data });
  invalidateRegistry(orgId);
  await adminEvent(deps, orgId, input.actor, "upstream.tool_updated", { tool: saved.name, enabled: saved.enabled, tags: saved.tags.join(", ") });
  return { ok: true as const, tool: { id: saved.id, name: saved.name, enabled: saved.enabled, tags: saved.tags } };
}

export async function removeUpstream(deps: Deps, orgId: string, serverId: string, actor: string) {
  const db = forOrg(orgId, deps.db);
  const row = await db.upstreamServer.findFirst({ where: { id: serverId } });
  if (!row) return { ok: false, status: 404, error: "No such MCP server." } satisfies UpstreamFail;
  await db.upstreamTool.deleteMany({ where: { serverId: row.id } });
  await db.upstreamServer.deleteMany({ where: { id: row.id } });
  invalidateRegistry(orgId);
  await adminEvent(deps, orgId, actor, "upstream.removed", { server: row.slug });
  return { ok: true as const };
}
