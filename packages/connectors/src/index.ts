import { TOOLS, type ToolName } from "@gate/core";
import { gmailConnector } from "./gmail";
import { mockGmail, mockZoho } from "./mock";
import type { Fetch } from "./oauth";
import type { Connector, ConnectorKind } from "./types";
import { zohoConnector, type ZohoConfig } from "./zoho";

export * from "./types";
export * from "./oauth";
export { mockState, resetMockState } from "./mock";
export { seedMockState } from "./mock-data";
export { gmailConnector } from "./gmail";
export { zohoConnector, zohoOrganizations, type ZohoConfig } from "./zoho";

export type ConnectorMode = "mock" | "live";

export interface LiveConfig {
  google?: { clientId: string; clientSecret: string };
  zoho?: ZohoConfig;
  fetch?: Fetch;
}

export function connectorFor(kind: ConnectorKind, mode: ConnectorMode, live: LiveConfig): Connector {
  if (mode === "mock") return kind === "gmail" ? mockGmail : mockZoho;
  if (kind === "gmail") {
    if (!live.google) throw new Error("Gmail is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    return gmailConnector(live.google, live.fetch);
  }
  if (!live.zoho) throw new Error("Zoho Books is not configured: set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET");
  return zohoConnector(live.zoho, live.fetch);
}

export function connectorKindOf(tool: ToolName): ConnectorKind {
  return TOOLS[tool].connector;
}

export const CONNECTOR_LABELS: Record<ConnectorKind, string> = { gmail: "Gmail", zoho: "Zoho Books" };
