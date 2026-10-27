import { RISK_TAGS, type RiskTag } from "@gate/core";
import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { RiskPill } from "@/components/ui/status";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { suggestionDraft } from "@/server/suggestions";
import { Builder, type ExtraTool } from "./builder";

export const metadata: Metadata = { title: "Rulebook" };

const DEMO_VENDOR_DOMAINS = ["sharmatraders.in", "kaverilogistics.in", "nilgirioffice.in"];

export default async function RulebookPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ suggestion?: string }> }) {
  const { slug } = await params;
  const { suggestion } = await searchParams;
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const agent = await db.agent.findFirst({ where: { slug } });
  if (!agent) notFound();
  const versions = await db.rulebook.findMany({ where: { agentId: agent.id }, orderBy: { version: "desc" }, select: { version: true, yaml: true, hash: true, signedBy: true, createdAt: true } });
  const members = await db.membership.findMany({ where: { role: { in: ["owner", "admin", "approver"] } }, include: { user: { select: { email: true } } } });
  // The same enabled MCP server tools that Elan1 Govern validates rulebooks against.
  const upstream = await db.upstreamTool.findMany({ where: { enabled: true }, orderBy: { name: "asc" }, select: { name: true, description: true, inputSchema: true, tags: true } });
  // "Open as draft" from a rule suggestion: the builder starts from its drafted rulebook, unsigned.
  const suggested = typeof suggestion === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(suggestion) ? await suggestionDraft(ctx.org.id, agent.slug, suggestion) : null;
  const extraTools: ExtraTool[] = upstream.map((t) => ({
    name: t.name,
    connector: t.name.slice(0, t.name.indexOf(".")),
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
    tags: t.tags.filter((x): x is RiskTag => (RISK_TAGS as readonly string[]).includes(x)),
  }));
  return (
    <>
      <PageHeader
        back={{ href: "/rulebooks", label: "Rulebooks" }}
        title={<span className="flex flex-wrap items-center gap-3">{agent.name} rulebook <RiskPill tier={agent.riskTier} /></span>}
        description="Rules are checked on every call. When several match, the strictest wins: refuse, then ask, then allow. Anything no rule allows is refused."
      />
      <Builder
        key={`${versions[0]?.version ?? 0}-${suggested ? suggestion : ""}`}
        slug={agent.slug}
        owner={agent.ownerEmail}
        tier={agent.riskTier}
        canPublish={can(ctx.role, "rulebooks:publish")}
        approverEmails={members.map((m) => m.user.email)}
        vendorDomains={DEMO_VENDOR_DOMAINS}
        versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
        extraTools={extraTools}
        {...(suggested ? { suggested } : {})}
      />
    </>
  );
}
