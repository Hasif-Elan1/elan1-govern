import { builtinRegistry, createRegistry, mergeRegistries, RISK_TAGS, specFromJsonSchema, type RiskTag, type ToolRegistry } from "@gate/core";
import { forOrg } from "@gate/db";
import type { Deps } from "./deps";

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; registry: ToolRegistry }>();
const isTag = (t: string): t is RiskTag => (RISK_TAGS as readonly string[]).includes(t);

/**
 * The tools an org's agents can ask for: the built-in Gmail and Zoho Books tools,
 * plus the tools the org has enabled from its upstream MCP servers.
 * Cached for a few seconds per org; admin changes call `invalidateRegistry`.
 */
export async function registryFor(deps: Deps, orgId: string): Promise<ToolRegistry> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.registry;
  const rows = await forOrg(orgId, deps.db).upstreamTool.findMany({ where: { enabled: true }, orderBy: { name: "asc" } });
  const upstream = rows.map((r) =>
    specFromJsonSchema({
      name: r.name,
      connector: r.name.slice(0, r.name.indexOf(".")),
      description: r.description,
      inputSchema: r.inputSchema as Record<string, unknown>,
      tags: r.tags.filter(isTag),
    }),
  );
  const registry = upstream.length ? mergeRegistries(builtinRegistry, createRegistry(upstream)) : builtinRegistry;
  cache.set(orgId, { at: Date.now(), registry });
  return registry;
}

export function invalidateRegistry(orgId: string) {
  cache.delete(orgId);
}
