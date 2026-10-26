import { reviewProblem, type AssessmentStatus } from "@gate/core";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { applyApprovedTier, withReceipt } from "@/server/inventory";
import { loadAssessment } from "../../helpers";

const Body = z
  .object({
    decision: z.enum(["approve", "request_changes"]),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((b) => b.decision === "approve" || (b.note?.length ?? 0) >= 3, { message: "Say what needs to change.", path: ["note"] });

/**
 * Approve an assessment or send it back. The person who submitted it cannot review it
 * (separation of duties). Approving sets the system's risk tier and next review date.
 */
export const POST = route({ auth: "org", permission: "assessments:approve", body: Body }, async ({ body, params, ctx }) => {
  const { a, template } = await loadAssessment(ctx.org.id, params.id);
  const problem = reviewProblem({ status: a.status as AssessmentStatus, submittedById: a.submittedById }, ctx.user.id);
  if (problem) throw new HttpError(a.status === "submitted" ? 403 : 409, problem);

  const db = forOrg(ctx.org.id);
  const approve = body.decision === "approve";
  const system = await db.aiSystem.findFirstOrThrow({ where: { id: a.systemId } });
  const out = await withReceipt(
    ctx.org.id,
    ctx.user.email,
    approve ? "assessment.approved" : "assessment.changes_requested",
    async () => {
      // Only moves a submitted assessment, and never for its own submitter, even if two reviews race.
      const r = await db.assessment.updateMany({
        where: { id: a.id, status: "submitted", NOT: { submittedById: ctx.user.id } },
        data: { status: approve ? "approved" : "changes_requested", reviewedBy: ctx.user.email, reviewedAt: new Date(), reviewNote: body.note || null },
      });
      if (r.count !== 1) throw new HttpError(409, "Someone else reviewed this assessment first. Reload the page.");
      return approve ? await applyApprovedTier(ctx.org.id, a.systemId) : null;
    },
    (applied) => ({
      system: a.system.name,
      assessment: template.name,
      tier: a.resultTier,
      ...(applied ? { system_tier: applied.tier, next_review: applied.nextReviewAt.toISOString().slice(0, 10) } : {}),
    }),
    async () => {
      await db.assessment.update({ where: { id: a.id }, data: { status: "submitted", reviewedBy: a.reviewedBy, reviewedAt: a.reviewedAt, reviewNote: a.reviewNote } });
      if (approve) await db.aiSystem.update({ where: { id: system.id }, data: { riskTier: system.riskTier, nextReviewAt: system.nextReviewAt } });
    },
  );
  return { ok: true, status: approve ? "approved" : "changes_requested", ...(out ? { tier: out.tier, nextReviewAt: out.nextReviewAt.toISOString() } : {}) };
});
