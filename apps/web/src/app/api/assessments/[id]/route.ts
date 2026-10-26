import { nextStatus, type AssessmentStatus } from "@gate/core";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { AnswersBody, loadAssessment, requireValidAnswers } from "../helpers";

const Body = z.object({ answers: AnswersBody }).strict();

/** Save a draft. Partial answers are fine; the status does not change. */
export const PATCH = route({ auth: "org", permission: "assessments:draft", body: Body }, async ({ body, params, ctx }) => {
  const { a, template } = await loadAssessment(ctx.org.id, params.id);
  if (!nextStatus(a.status as AssessmentStatus, "save")) throw new HttpError(409, "This assessment is no longer a draft, so it cannot be changed.");
  requireValidAnswers(template, body.answers, false);
  const r = await forOrg(ctx.org.id).assessment.updateMany({ where: { id: a.id, status: a.status }, data: { answers: body.answers } });
  if (r.count !== 1) throw new HttpError(409, "Someone else changed this assessment. Reload the page.");
  return { ok: true };
});
