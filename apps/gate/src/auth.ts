import { AGENT_KEY_RE, hashToken, safeEqual } from "@gate/core";
import { findApiKeyByHash, forOrg } from "@gate/db";
import type { Deps } from "./deps";
import type { AgentIdentity } from "./guard";

/**
 * Agent API key -> identity. Keys are stored as SHA-256 hashes; the raw key is shown once. Keys are the gate's
 * own gk_ keys and the console's gk_ (production) and sk_sbx_ (sandbox) keys; a revoked or expired key never matches.
 */
export async function authenticateAgent(deps: Deps, header: string | undefined): Promise<(AgentIdentity & { keyId: string; environment: string }) | null> {
  const m = /^Bearer (\S+)$/.exec(header ?? "");
  if (!m || !AGENT_KEY_RE.test(m[1] as string)) return null;
  const hash = hashToken(m[1] as string);
  const row = await findApiKeyByHash(hash, deps.db);
  if (!row || !safeEqual(row.keyHash, hash)) return null;
  await forOrg(row.orgId, deps.db)
    .apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { orgId: row.orgId, agentId: row.agentId, keyId: row.id, environment: row.environment };
}
