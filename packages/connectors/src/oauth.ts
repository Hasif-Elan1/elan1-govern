import type { ConnectorKind, OAuthTokens } from "./types";

export type Fetch = typeof fetch;

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Zoho only: accounts server for the data centre, https://accounts.zoho.in for India. */
  accountsUrl?: string;
}

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

// Read mail and create drafts/replies. No delete, no settings.
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
export const ZOHO_SCOPES = ["ZohoBooks.bills.ALL", "ZohoBooks.contacts.READ", "ZohoBooks.contacts.UPDATE", "ZohoBooks.vendorpayments.CREATE", "ZohoBooks.settings.READ"];

export function authorizeUrl(kind: ConnectorKind, cfg: ProviderConfig, redirectUri: string, state: string): string {
  const base = kind === "gmail" ? GOOGLE_AUTH : `${cfg.accountsUrl ?? "https://accounts.zoho.in"}/oauth/v2/auth`;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    state,
    scope: (kind === "gmail" ? GMAIL_SCOPES : ZOHO_SCOPES).join(kind === "gmail" ? " " : ","),
  });
  return `${base}?${params.toString()}`;
}

function tokenUrl(kind: ConnectorKind, cfg: ProviderConfig) {
  return kind === "gmail" ? GOOGLE_TOKEN : `${cfg.accountsUrl ?? "https://accounts.zoho.in"}/oauth/v2/token`;
}

async function tokenRequest(kind: ConnectorKind, cfg: ProviderConfig, body: Record<string, string>, f: Fetch): Promise<OAuthTokens> {
  const res = await f(tokenUrl(kind, cfg), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    throw new Error(`token request failed (${res.status}${typeof json.error === "string" ? `: ${json.error}` : ""})`);
  }
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : body.refresh_token,
    expires_at: Date.now() + (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000,
  };
}

export function exchangeCode(kind: ConnectorKind, cfg: ProviderConfig, code: string, redirectUri: string, f: Fetch = fetch) {
  return tokenRequest(kind, cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, f);
}

export function refreshTokens(kind: ConnectorKind, cfg: ProviderConfig, refreshToken: string, f: Fetch = fetch) {
  return tokenRequest(kind, cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, f);
}
