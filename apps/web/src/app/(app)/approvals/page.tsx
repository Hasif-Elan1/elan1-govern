import { forOrg } from "@gate/db";
import { Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalCard } from "@/components/approval-card";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { DecisionPill } from "@/components/ui/status";
import { fmtDateTime } from "@/lib/utils";
import { can } from "@/server/policy";
import { approvalViews } from "@/server/queries";
import { requireCtx } from "@/server/session";

export const metadata: Metadata = { title: "Approvals" };

export default async function Approvals() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const [pendingRows, doneRows] = await Promise.all([
    db.approval.findMany({ where: { status: "pending", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" } }),
    db.approval.findMany({ where: { OR: [{ status: { not: "pending" } }, { expiresAt: { lte: new Date() } }] }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const [pending, done] = await Promise.all([approvalViews(ctx.org.id, pendingRows, ctx.user.id), approvalViews(ctx.org.id, doneRows, ctx.user.id)]);
  const canDecide = can(ctx.role, "approvals:decide");

  return (
    <>
      <PageHeader title="Approvals" description="Actions your agents stopped and asked about. Nothing happens until an approver decides, and anything not decided in time is refused." />
      {pending.length ? (
        <div className="grid gap-5">
          {pending.map((a) => (
            <ApprovalCard key={a.id} a={a} me={ctx.user.email} canDecide={canDecide} totpEnabled={ctx.user.totpEnabled} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Inbox />}
          title="Nothing is waiting"
          body="When a rule says a person must decide, such as a large payment, a refund or a production change, the action waits here and the approvers get an email."
          action={{ href: "/rulebooks", label: "See your rules" }}
        />
      )}

      {done.length ? (
        <Section title="Decided" className="mt-12">
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {done.map((a) => (
              <li key={a.id}>
                <Link href={`/approvals/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-sunken">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.action}</span>
                    <span className="block text-[13px] text-ink-3">
                      {a.agentName}
                      {a.resolvedBy ? `, ${a.status} by ${a.resolvedBy}` : ""}
                      {a.selfApproval ? " (set up this agent)" : ""}
                    </span>
                  </span>
                  <span className="text-[13px] text-ink-3">{fmtDateTime(a.resolvedAt ?? a.expiresAt)}</span>
                  <DecisionPill kind={a.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
