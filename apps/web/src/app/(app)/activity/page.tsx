import { TOOL_NAMES, TOOLS } from "@gate/core";
import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { activity } from "@/server/queries";
import { requireCtx } from "@/server/session";
import { ActivityView } from "./view";

export const metadata: Metadata = { title: "Activity" };

type Search = { agent?: string; decision?: string; tool?: string; from?: string; to?: string; q?: string; r?: string };

export default async function Activity({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const decision = ["allow", "ask", "refuse", "admin"].includes(sp.decision ?? "") ? sp.decision : undefined;
  const filter = { agent: sp.agent?.slice(0, 64), decision, tool: sp.tool?.slice(0, 100), from: sp.from?.slice(0, 10), to: sp.to?.slice(0, 10), q: sp.q?.slice(0, 200) };
  const [items, agents] = await Promise.all([activity(ctx.org.id, filter), forOrg(ctx.org.id).agent.findMany({ select: { slug: true, name: true }, orderBy: { name: "asc" } })]);
  return (
    <>
      <PageHeader title="Activity" description="Every decision Elan1 Govern made, newest first. Each one is a signed receipt linked to the one before it." />
      <ActivityView
        items={items}
        filter={filter}
        agents={agents}
        tools={TOOL_NAMES.map((t) => ({ value: t, label: `${TOOLS[t].connector === "gmail" ? "Gmail" : "Zoho Books"}: ${TOOLS[t].label}` }))}
        openSeq={sp.r && /^\d+$/.test(sp.r) ? Number(sp.r) : null}
      />
    </>
  );
}
