import { AFFECTED_PEOPLE, DATA_CATEGORIES, DECISION_IMPACTS, getTemplate, labelOf, REVIEW_MONTHS, SYSTEM_KINDS } from "@gate/core";
import { forOrg } from "@gate/db";
import { ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssessmentStatusPill, LifecyclePill, ReviewDue, TierPill } from "@/components/inventory-bits";
import { Card, EmptyState, KeyValue, PageHeader, Section } from "@/components/ui/layout";
import { Pill } from "@/components/ui/status";
import { fmtDate, relative } from "@/lib/utils";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { SystemDialog } from "../system-form";
import { RetireButton, StartAssessment } from "./client";

export const metadata: Metadata = { title: "AI system" };

const list = (pairs: readonly (readonly [string, string])[], xs: string[]) => (xs.length ? xs.map((x) => labelOf(pairs, x)).join(", ") : "Not recorded");

export default async function SystemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const s = await db.aiSystem.findFirst({ where: { id } });
  if (!s) notFound();
  const [agent, assessments] = await Promise.all([
    s.agentId ? db.agent.findFirst({ where: { id: s.agentId }, select: { slug: true, name: true, status: true } }) : null,
    db.assessment.findMany({ where: { systemId: s.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const manage = can(ctx.role, "inventory:manage");
  const draft = can(ctx.role, "assessments:draft") && s.lifecycle !== "retired";

  return (
    <>
      <PageHeader
        back={{ href: "/inventory", label: "Inventory" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {s.name}
            <LifecyclePill lifecycle={s.lifecycle} />
          </span>
        }
        description={`${labelOf(SYSTEM_KINDS, s.kind)}${s.vendor ? ` from ${s.vendor}` : ""}, owned by ${s.ownerEmail}`}
        actions={
          manage ? (
            <>
              <RetireButton id={s.id} name={s.name} retired={s.lifecycle === "retired"} />
              <SystemDialog
                id={s.id}
                me={ctx.user.email}
                linkedAgent={!!s.agentId}
                trigger="edit"
                initial={{ name: s.name, kind: s.kind, vendor: s.vendor ?? "", purpose: s.purpose, ownerEmail: s.ownerEmail, businessUnit: s.businessUnit ?? "", lifecycle: s.lifecycle, dataCategories: s.dataCategories, affectedPeople: s.affectedPeople, decisionImpact: s.decisionImpact }}
              />
            </>
          ) : null
        }
      />
      <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
        <Section title="About">
          <Card className="p-5">
            <p className="mb-5 text-[15px]">{s.purpose}</p>
            <KeyValue
              items={[
                ["Owner", s.ownerEmail],
                ["Business unit", s.businessUnit ?? "Not recorded"],
                ["Data", list(DATA_CATEGORIES, s.dataCategories)],
                ["Affects", list(AFFECTED_PEOPLE, s.affectedPeople)],
                ["Decisions", labelOf(DECISION_IMPACTS, s.decisionImpact)],
                [
                  "Gate agent",
                  agent ? (
                    <Link key="a" href={`/agents/${agent.slug}`} className="font-medium text-accent hover:underline">
                      {agent.name}
                    </Link>
                  ) : s.agentId ? (
                    "The linked agent was removed"
                  ) : (
                    "Not guarded by Gate"
                  ),
                ],
                ["Added", fmtDate(s.createdAt)],
                ["Last changed", relative(s.updatedAt)],
              ]}
            />
          </Card>
        </Section>
        <Section title="Risk">
          <Card className="p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <TierPill tier={s.riskTier} />
              {s.agentId && !assessments.some((a) => a.status === "approved") ? <span className="text-sm text-ink-3">from the agent's setup questions</span> : null}
            </div>
            <KeyValue items={[["Next review", <ReviewDue key="r" at={s.nextReviewAt} />]]} />
            <p className="mt-4 text-[13px] text-ink-3">
              Approving an assessment sets the tier and the next review: {REVIEW_MONTHS.high} months for high risk, {REVIEW_MONTHS.medium} for medium, {REVIEW_MONTHS.low} for low.
            </p>
          </Card>
        </Section>
      </div>

      <Section className="mt-10" title="Assessments" actions={draft && assessments.length ? <StartAssessment systemId={s.id} /> : null}>
        {assessments.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck />}
            title="Not assessed yet"
            body={draft ? "Start with the AI risk triage. It takes a few minutes and sets a risk tier once someone else approves it." : s.lifecycle === "retired" ? "This system is retired." : "An owner, admin or approver can start an assessment."}
            action={draft ? <StartAssessment systemId={s.id} label="Start the first assessment" /> : undefined}
          />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
            {assessments.map((a) => (
              <li key={a.id}>
                <Link href={`/assessments/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-sunken">
                  <span className="min-w-0 flex-1 font-medium">{getTemplate(a.templateKey)?.name ?? a.templateKey}</span>
                  {a.resultTier ? <TierPill tier={a.resultTier} /> : <Pill>No result yet</Pill>}
                  <AssessmentStatusPill status={a.status} />
                  <span className="w-28 text-right text-[13px] text-ink-3">{relative(a.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
