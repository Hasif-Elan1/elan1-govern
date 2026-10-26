import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApprovalCard } from "@/components/approval-card";
import { PageHeader } from "@/components/ui/layout";
import { can } from "@/server/policy";
import { approvalViews } from "@/server/queries";
import { requireCtx } from "@/server/session";

export const metadata: Metadata = { title: "Approval" };

export default async function ApprovalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = await params;
  const { t } = await searchParams;
  const ctx = await requireCtx(`/approvals/${id}`);
  const row = await forOrg(ctx.org.id).approval.findFirst({ where: { id } });
  if (!row) notFound();
  const [a] = await approvalViews(ctx.org.id, [row], ctx.user.id);
  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title={a!.status === "pending" ? "Waiting for a decision" : "Approval"} back={{ href: "/approvals", label: "Approvals" }} />
      <ApprovalCard a={a!} me={ctx.user.email} canDecide={can(ctx.role, "approvals:decide")} token={t} totpEnabled={ctx.user.totpEnabled} expanded />
    </div>
  );
}
