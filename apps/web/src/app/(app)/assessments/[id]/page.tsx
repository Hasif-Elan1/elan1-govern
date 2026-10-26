import { getTemplate, nextStatus, reviewProblem, type Answers, type AssessmentStatus } from "@gate/core";
import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssessmentStatusPill, LegalReviewNote } from "@/components/inventory-bits";
import { Card, KeyValue, PageHeader } from "@/components/ui/layout";
import { fmtDateTime } from "@/lib/utils";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { Questionnaire, ReviewPanel } from "./client";

export const metadata: Metadata = { title: "Assessment" };

export default async function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const a = await forOrg(ctx.org.id).assessment.findFirst({ where: { id }, include: { system: { select: { id: true, name: true } } } });
  if (!a) notFound();
  const template = getTemplate(a.templateKey);
  if (!template) notFound();
  const status = a.status as AssessmentStatus;
  const editable = can(ctx.role, "assessments:draft") && nextStatus(status, "save") !== null && template.version === a.templateVersion;
  const reviewer = can(ctx.role, "assessments:approve");
  const problem = reviewProblem({ status, submittedById: a.submittedById }, ctx.user.id);

  const history: [string, React.ReactNode][] = [["Started", `${fmtDateTime(a.createdAt)} by ${a.createdBy}`]];
  if (a.submittedAt) history.push(["Submitted", `${fmtDateTime(a.submittedAt)} by ${a.submittedBy}`]);
  if (a.reviewedAt) history.push([status === "approved" ? "Approved" : "Reviewed", `${fmtDateTime(a.reviewedAt)} by ${a.reviewedBy}`]);

  return (
    <>
      <PageHeader
        back={{ href: `/inventory/${a.system.id}`, label: a.system.name }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {template.name}
            <AssessmentStatusPill status={status} />
          </span>
        }
        description={template.description}
      />
      <div className="-mt-3 mb-7 flex flex-wrap items-center gap-3 text-sm text-ink-3">
        <LegalReviewNote />
        <span>
          For{" "}
          <Link href={`/inventory/${a.system.id}`} className="font-medium text-accent hover:underline">
            {a.system.name}
          </Link>
          , version {a.templateVersion} of this template.
        </span>
      </div>

      {status === "changes_requested" && a.reviewNote ? (
        <div className="mb-7 rounded-lg border border-no-line bg-no-soft px-4 py-3 text-sm">
          <p className="font-medium">{a.reviewedBy} asked for changes</p>
          <p className="mt-1 whitespace-pre-line text-ink-2">{a.reviewNote}</p>
        </div>
      ) : null}

      {status === "submitted" ? (
        <div className="mb-8">
          {reviewer && !problem ? (
            <ReviewPanel id={a.id} />
          ) : (
            <p className="rounded-lg border border-wait-line bg-wait-soft px-4 py-3 text-sm">
              {reviewer && problem ? problem : "Waiting for an owner or admin to review it. The person who submitted it cannot approve it."}
            </p>
          )}
        </div>
      ) : null}

      <Questionnaire id={a.id} template={template} initial={(a.answers ?? {}) as Answers} editable={editable} />

      <Card className="mt-10 p-5">
        <KeyValue items={[...history, ...(status === "approved" && a.reviewNote ? ([["Reviewer's note", a.reviewNote]] as [string, React.ReactNode][]) : [])]} />
      </Card>
    </>
  );
}
