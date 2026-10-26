import { nextStatus, scoreAssessment, type Answers, type AssessmentStatus } from "@gate/core";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { withReceipt } from "@/server/inventory";
import { AnswersBody, loadAssessment, requireValidAnswers } from "../../helpers";

const Body = z.object({ answers: AnswersBody }).strict();

/** Save the final answers, score them and send the assessment for review. */
export const POST = route({ auth: "org", permission: "assessments:draft", body: Body }, async ({ body, params, ctx }) => {
  const { a, template } = await loadAssessment(ctx.org.id, params.id);
  if (!nextStatus(a.status as AssessmentStatus, "submit")) throw new HttpError(409, "This assessment was already submitted.");
  requireValidAnswers(template, body.answers, true);
  const result = scoreAssessment(template, body.answers as Answers);
  const db = forOrg(ctx.org.id);
  await withReceipt(
    ctx.org.id,
    ctx.user.email,
    "assessment.submitted",
    async () => {
      const r = await db.assessment.updateMany({
        where: { id: a.id, status: a.status },
        data: { answers: body.answers, score: result.score, resultTier: result.tier, status: "submitted", submittedBy: ctx.user.email, submittedById: ctx.user.id, submittedAt: new Date() },
      });
      if (r.count !== 1) throw new HttpError(409, "Someone else changed this assessment. Reload the page.");
    },
    () => ({ system: a.system.name, assessment: template.name, tier: result.tier, score: result.score }),
    () => db.assessment.update({ where: { id: a.id }, data: { answers: a.answers as object, score: a.score, resultTier: a.resultTier, status: a.status, submittedBy: a.submittedBy, submittedById: a.submittedById, submittedAt: a.submittedAt } }),
  );
  return { ok: true, score: result.score, tier: result.tier };
});
