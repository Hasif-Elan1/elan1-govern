import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { env } from "@/server/env";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { Wizard } from "./wizard";

export const metadata: Metadata = { title: "Add agent" };

export default async function NewAgent() {
  const ctx = await requireCtx();
  if (!can(ctx.role, "agents:manage")) redirect("/agents");
  const connectors = await forOrg(ctx.org.id).connector.findMany({ select: { kind: true, status: true, mode: true, accountLabel: true } });
  return (
    <div className="mx-auto max-w-[720px]">
      <PageHeader back={{ href: "/agents", label: "Agents" }} title="Add an agent" description="Three short steps. You get an address and a key to give the agent, and a starter rulebook you can change." />
      <Wizard
        me={ctx.user.email}
        connectors={connectors}
        mcpUrl={`${env().GATE_PUBLIC_URL}/mcp`}
        gateUrl={env().GATE_PUBLIC_URL}
        liveAvailable={{ gmail: !!env().GOOGLE_CLIENT_ID, zoho: !!env().ZOHO_CLIENT_ID }}
      />
    </div>
  );
}
