import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { env } from "@/server/env";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { ConnectorCard } from "./card";
import { OAuthResult } from "./result";
import { UpstreamServers } from "./upstreams";

export const metadata: Metadata = { title: "Connectors" };

export default async function Connectors({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const rows = await forOrg(ctx.org.id).connector.findMany({ select: { kind: true, status: true, mode: true, accountLabel: true } });
  const manage = can(ctx.role, "connectors:manage");
  const db = forOrg(ctx.org.id);
  const servers = await db.upstreamServer.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, slug: true, name: true, url: true, status: true, lastSyncedAt: true, error: true } });
  const tools = await db.upstreamTool.findMany({ orderBy: { name: "asc" }, select: { id: true, serverId: true, name: true, description: true, tags: true, enabled: true } });
  return (
    <>
      <PageHeader title="Connectors" description="The accounts your agents work in. Gate holds the access tokens, encrypted. Agents only ever talk to Gate." />
      <OAuthResult connected={sp.connected} error={sp.error} />
      <div className="grid gap-4 md:grid-cols-2">
        {(["gmail", "zoho"] as const).map((k) => (
          <ConnectorCard key={k} kind={k} row={rows.find((r) => r.kind === k)} manage={manage} liveAvailable={k === "gmail" ? !!env().GOOGLE_CLIENT_ID : !!env().ZOHO_CLIENT_ID} />
        ))}
      </div>
      <p className="mt-6 max-w-[64ch] text-sm text-ink-3">
        Demo data is a pretend inbox with three vendor invoices and a matching Zoho Books ledger, so you can try every rule without touching real money.
      </p>
      <UpstreamServers
        manage={manage}
        servers={servers.map((s) => ({ ...s, lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null, tools: tools.filter((t) => t.serverId === s.id).map(({ serverId: _s, ...t }) => t) }))}
      />
    </>
  );
}
