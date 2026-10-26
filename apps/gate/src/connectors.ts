import { CONNECTOR_LABELS, ConnectorError, type Connector, type ConnectorContext, type ConnectorKind, type ConnectorMode, type OAuthTokens } from "@gate/connectors";
import { decrypt, encrypt } from "@gate/core";
import { forOrg } from "@gate/db";
import type { Deps } from "./deps";

export const tokenAad = (orgId: string, kind: string) => `oauth:${orgId}:${kind}`;

export function sealTokens(deps: Deps, orgId: string, kind: ConnectorKind, tokens: OAuthTokens): string {
  return encrypt(deps.env.GATE_MASTER_KEY, JSON.stringify(tokens), tokenAad(orgId, kind));
}

export type Resolved = { ok: true; connector: Connector; ctx: ConnectorContext } | { ok: false; reason: string };

/** Find the org's connector for a tool and build its context, decrypting tokens in memory only. */
export async function resolveConnector(deps: Deps, orgId: string, kind: ConnectorKind): Promise<Resolved> {
  const row = await forOrg(orgId, deps.db).connector.findFirst({ where: { kind } });
  if (!row || row.status !== "connected") return { ok: false, reason: `${CONNECTOR_LABELS[kind]} is not connected` };
  const mode = row.mode as ConnectorMode;
  const ctx: ConnectorContext = { orgId, meta: (row.meta as Record<string, unknown> | null) ?? {} };
  if (mode === "live") {
    if (!row.tokensEnc) return { ok: false, reason: `${CONNECTOR_LABELS[kind]} needs to be reconnected` };
    ctx.tokens = JSON.parse(decrypt(deps.env.GATE_MASTER_KEY, row.tokensEnc, tokenAad(orgId, kind))) as OAuthTokens;
    ctx.saveTokens = async (t) => {
      await forOrg(orgId, deps.db).connector.update({ where: { id: row.id }, data: { tokensEnc: sealTokens(deps, orgId, kind, t) } });
    };
  }
  try {
    return { ok: true, connector: deps.connector(kind, mode), ctx };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Connector errors are written for people; anything else stays generic so internals never leak to agents. */
export function publicError(e: unknown): string {
  return e instanceof ConnectorError ? e.message : "the connector did not respond as expected";
}
