export type ConnectorKind = "gmail" | "zoho";

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at?: number;
}

export interface ConnectorContext {
  orgId: string;
  tokens?: OAuthTokens;
  meta?: Record<string, unknown>;
  /** Called when a live connector refreshes its access token. */
  saveTokens?: (tokens: OAuthTokens) => Promise<void>;
}

export interface ToolResult {
  data: unknown;
  /** A short reference for the receipt, e.g. a payment id. */
  ref?: string;
}

/** What an approver sees next to an ask: the vendor, the bill and the invoice. */
export interface Evidence {
  vendor?: { id: string; name: string; email?: string; gstin?: string; bank?: string; ifsc?: string; city?: string };
  bill?: { id: string; number: string; date: string; due_date?: string; total_inr: number; balance_inr: number; status: string };
  invoice?: InvoiceDoc;
}

export interface InvoiceDoc {
  filename: string;
  number: string;
  date: string;
  seller: { name: string; gstin: string; address: string };
  buyer: { name: string; gstin: string; address: string };
  lines: { description: string; hsn: string; qty: number; rate: number; amount: number }[];
  taxable_inr: number;
  cgst_inr: number;
  sgst_inr: number;
  igst_inr: number;
  total_inr: number;
}

export interface Connector {
  kind: ConnectorKind | "upstream";
  call(tool: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult>;
  /** Display names for a receipt summary (vendor and bill numbers, never bodies). */
  describe(tool: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<Record<string, string>>;
  evidence(tool: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<Evidence>;
  /** Domains of known vendors, for `to_domain_in: vendor_domains`. */
  vendorDomains(ctx: ConnectorContext): Promise<string[]>;
}

/**
 * Asked before every live request, with the calling organisation (the egress gate in
 * packages/db/src/egress.ts). Throws to stop the request; nothing is sent.
 */
export type EgressHook = (url: string, orgId: string) => Promise<void>;

export class ConnectorError extends Error {
  constructor(message: string, readonly code: "not_found" | "invalid" | "auth" | "upstream" = "upstream") {
    super(message);
  }
}
