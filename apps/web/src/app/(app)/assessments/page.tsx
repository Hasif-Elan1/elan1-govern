import { getTemplate, type AssessmentStatus } from "@gate/core";
import { forOrg } from "@gate/db";
import { ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AssessmentStatusPill, TierPill } from "@/components/inventory-bits";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { relative } from "@/lib/utils";
import { requireCtx } from "@/server/session";

export const metadata: Metadata = { title: "Assessments" };

const GROUPS: { status: AssessmentStatus; title: string; description: string }[] = [
  { status: "submitted", title: "Waiting for review", description: "An owner or admin who did not submit it signs each one off." },
  { status: "changes_requested", title: "Changes requested", description: "The reviewer sent these back with a note." },
  { status: "draft", title: "Drafts", description: "Started, not yet submitted." },
  { status: "approved", title: "Approved", description: "Signed off. Each approval set the system's risk tier and next review." },
];

export default async function Assessments() {
  const ctx = await requireCtx();
  const rows = await forOrg(ctx.org.id).assessment.findMany({ orderBy: { updatedAt: "desc" }, take: 500, include: { system: { select: { name: true } } } });

  return (
    <>
      <PageHeader title="Assessments" description="Structured risk and impact reviews of the AI systems in your inventory, each signed off by a second person and recorded as a receipt." />
      {rows.length === 0 ? (
        <EmptyState icon={<ClipboardCheck />} title="No assessments yet" body="Open a system in the inventory and start an assessment. The AI risk triage is a good first one." action={{ href: "/inventory", label: "Open the inventory" }} />
      ) : (
        <div className="grid gap-10">
          {GROUPS.map((g) => {
            const items = rows.filter((r) => r.status === g.status);
            if (!items.length) return null;
            return (
              <Section key={g.status} title={`${g.title} (${items.length})`} description={g.description}>
                <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
                  {items.map((a) => (
                    <li key={a.id}>
                      <Link href={`/assessments/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-sunken">
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{a.system.name}</span>
                          <span className="block text-[13px] text-ink-3">
                            {getTemplate(a.templateKey)?.name ?? a.templateKey}
                            {a.submittedBy ? `, submitted by ${a.submittedBy}` : `, started by ${a.createdBy}`}
                          </span>
                        </span>
                        {a.resultTier ? <TierPill tier={a.resultTier} /> : null}
                        <AssessmentStatusPill status={a.status} />
                        <span className="text-[13px] text-ink-3">{relative(a.updatedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            );
          })}
        </div>
      )}
    </>
  );
}
