import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { allowlist, ensurePackConnectors, syncCatalogue } from './ops';

/**
 * Where connectors run for this organisation: level, deployment (hosted or Sovereign), residency domain,
 * the secrets store that holds credentials, and the Sovereign internal-host allow-list.
 */
export async function loadConnectorEnv(orgId: string) {
  const [lv, dep] = await Promise.all([api.level(orgId), api.deployment(orgId).catch(() => undefined)]);
  const allow = allowlist(orgId);
  return {
    level: lv.level,
    deployment: lv.deployment,
    residency: lv.residency,
    secrets: dep?.secrets ? `${dep.secrets.backend}` : undefined,
    sovereign: lv.deployment === 'sovereign',
    allow: allow.entries,
    /** the organisation's own domain: at Sovereign its hosts are inside the network */
    domain: db.getDB(orgId).org.domain,
    allowMeta: allow,
  };
}

export type ConnectorEnv = Awaited<ReturnType<typeof loadConnectorEnv>>;

export function useConnectorEnv() {
  return useQuery((o) => loadConnectorEnv(o), [], { kinds: ['receipt'] });
}

/** Load connectors, adding any installed pack's connector first and keeping the tool catalogue in step. */
export async function loadConnectors(orgId: string) {
  ensurePackConnectors(orgId);
  syncCatalogue(orgId);
  return api.connectors(orgId);
}
