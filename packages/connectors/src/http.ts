import { refreshTokens, type Fetch, type ProviderConfig } from "./oauth";
import { ConnectorError, type ConnectorContext, type ConnectorKind, type EgressHook } from "./types";

/** Authenticated JSON request with one refresh-and-retry on expiry or 401. */
export async function authedJson(
  kind: ConnectorKind,
  cfg: ProviderConfig,
  ctx: ConnectorContext,
  url: string,
  init: RequestInit & { authScheme: "Bearer" | "Zoho-oauthtoken" },
  raw: Fetch,
  egress?: EgressHook,
): Promise<unknown> {
  if (!ctx.tokens?.access_token) throw new ConnectorError("This connector is not connected", "auth");
  // Token refreshes and API calls alike go through the egress gate first.
  const f: Fetch = egress ? async (u, i) => (await egress(u instanceof Request ? u.url : String(u), ctx.orgId), raw(u, i)) : raw;
  let tokens = ctx.tokens;

  const refresh = async () => {
    if (!tokens.refresh_token) throw new ConnectorError("Access expired; reconnect this connector", "auth");
    tokens = await refreshTokens(kind, cfg, tokens.refresh_token, f);
    ctx.tokens = tokens;
    await ctx.saveTokens?.(tokens);
  };
  if (tokens.expires_at && tokens.expires_at < Date.now() + 30_000) await refresh();

  const send = () =>
    f(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `${init.authScheme} ${tokens.access_token}` },
      signal: AbortSignal.timeout(20_000),
    });
  let res = await send();
  if (res.status === 401) {
    await refresh();
    res = await send();
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg = typeof body?.message === "string" ? body.message : `HTTP ${res.status}`;
    throw new ConnectorError(`${kind === "gmail" ? "Gmail" : "Zoho Books"} said: ${msg}`, res.status === 404 ? "not_found" : "upstream");
  }
  return body;
}
