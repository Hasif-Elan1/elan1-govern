import { hashToken, safeEqual } from "@gate/core";
import { findApiKeyByHash, forOrg } from "@gate/db";
import type { Deps } from "./deps";
import type { AgentIdentity } from "./guard";

const KEY_RE = /^Bearer (gk_[A-Za-z0-9_-]{43})$/;

/** Agent API key -> identity. Keys are stored as SHA-256 hashes; the raw key is shown once. */
export async function authenticateAgent(deps: Deps, header: string | undefined): Promise<(AgentIdentity & { keyId: string }) | null> {
  const m = KEY_RE.exec(header ?? "");
  if (!m) return null;
  const hash = hashToken(m[1] as string);
  const row = await findApiKeyByHash(hash, deps.db);
  if (!row || !safeEqual(row.keyHash, hash)) return null;
  await forOrg(row.orgId, deps.db)
    .apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { orgId: row.orgId, agentId: row.agentId, keyId: row.id };
}
