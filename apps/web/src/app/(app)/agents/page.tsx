import { forOrg } from "@gate/db";
import { Bot, Plus } from "lucide-react";
import { ConnectorIcons, connectorsOf } from "@/components/agent-bits";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Pill, RiskPill } from "@/components/ui/status";
import { relative } from "@/lib/utils";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";

export const metadata: Metadata = { title: "Agents" };

export default async function Agents() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const agents = await db.agent.findMany({ orderBy: { createdAt: "asc" } });
  const rulebooks = await db.rulebook.findMany({ where: { id: { in: agents.map((a) => a.activeRulebookId).filter((x): x is string => !!x) } } });
  const manage = can(ctx.role, "agents:manage");

  return (
    <>
      <PageHeader
        title="Agents"
        description="Every AI agent that can act for your company, who owns it, how risky it is, and what it can reach."
        actions={
          manage ? (
            <Link href="/agents/new" className={buttonVariants({ variant: "primary" })}>
              <Plus /> Add agent
            </Link>
          ) : null
        }
      />
      {agents.length === 0 ? (
        <EmptyState icon={<Bot />} title="No agents yet" body="Add an agent to get an MCP address and a key. Gate checks each of its actions against your rules." action={manage ? { href: "/agents/new", label: "Add your first agent" } : undefined} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="hidden border-b border-line bg-sunken/60 text-left text-[13px] whitespace-nowrap text-ink-3 md:table-header-group">
              <tr>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Owner</th>
                <th className="px-4 py-2.5 font-medium">Risk</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Connectors</th>
                <th className="px-4 py-2.5 font-medium">Last action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {agents.map((a) => {
                const rb = rulebooks.find((r) => r.id === a.activeRulebookId);
                return (
                  <tr key={a.id} className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3.5 hover:bg-sunken/50 md:table-row md:p-0">
                    <td className="col-span-2 md:px-4 md:py-3.5">
                      <Link href={`/agents/${a.slug}`} className="font-medium text-ink hover:underline">
                        {a.name}
                      </Link>
                      <p className="mt-0.5 line-clamp-1 max-w-[42ch] text-[13px] text-ink-3">{a.purpose}</p>
                    </td>
                    <td className="col-span-2 text-ink-2 md:px-4 md:py-3.5">{a.ownerEmail}</td>
                    <td className="md:px-4 md:py-3.5">
                      <RiskPill tier={a.riskTier} />
                    </td>
                    <td className="md:px-4 md:py-3.5">{a.status === "active" ? <Pill tone="ok">Active</Pill> : <Pill tone="no">Paused</Pill>}</td>
                    <td className="col-span-2 md:px-4 md:py-3.5">
                      <ConnectorIcons kinds={connectorsOf(rb?.yaml)} />
                    </td>
                    <td className="col-span-2 text-ink-3 md:px-4 md:py-3.5">{relative(a.lastActionAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
