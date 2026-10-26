import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/layout";
import { RiskPill } from "@/components/ui/status";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { Builder } from "./builder";

export const metadata: Metadata = { title: "Rulebook" };

const DEMO_VENDOR_DOMAINS = ["sharmatraders.in", "kaverilogistics.in", "nilgirioffice.in"];

export default async function RulebookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const agent = await db.agent.findFirst({ where: { slug } });
  if (!agent) notFound();
  const versions = await db.rulebook.findMany({ where: { agentId: agent.id }, orderBy: { version: "desc" }, select: { version: true, yaml: true, hash: true, signedBy: true, createdAt: true } });
  const members = await db.membership.findMany({ where: { role: { in: ["owner", "admin", "approver"] } }, include: { user: { select: { email: true } } } });
  return (
    <>
      <PageHeader
        back={{ href: "/rulebooks", label: "Rulebooks" }}
        title={<span className="flex flex-wrap items-center gap-3">{agent.name} rulebook <RiskPill tier={agent.riskTier} /></span>}
        description="Rules are checked on every call. When several match, the strictest wins: refuse, then ask, then allow. Anything no rule allows is refused."
      />
      <Builder
        key={versions[0]?.version ?? 0}
        slug={agent.slug}
        owner={agent.ownerEmail}
        tier={agent.riskTier}
        canPublish={can(ctx.role, "rulebooks:publish")}
        approverEmails={members.map((m) => m.user.email)}
        vendorDomains={DEMO_VENDOR_DOMAINS}
        versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
      />
    </>
  );
}
