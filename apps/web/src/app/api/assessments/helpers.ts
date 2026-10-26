import "server-only";
import { checkAnswers, getTemplate, type Answers } from "@gate/core";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError } from "@/server/api";

export const AnswersBody = z.record(z.string().max(64), z.union([z.string().max(2000), z.array(z.string().max(64)).max(20)])).refine((a) => Object.keys(a).length <= 100, "Too many answers.");

/** The assessment, its system and its template, or a 404/409 with a plain message. */
export async function loadAssessment(orgId: string, id: string | undefined) {
  const a = await forOrg(orgId).assessment.findFirst({ where: { id }, include: { system: { select: { id: true, name: true } } } });
  if (!a) throw new HttpError(404, "No such assessment.");
  const template = getTemplate(a.templateKey);
  if (!template || template.version !== a.templateVersion) throw new HttpError(409, "This assessment's template has changed. Start a new assessment.");
  return { a, template };
}

/** Throws 400 when an answer is not allowed. With `complete`, also when a required question is unanswered. */
export function requireValidAnswers(template: NonNullable<ReturnType<typeof getTemplate>>, answers: Answers, complete: boolean) {
  const { errors, missing } = checkAnswers(template, answers);
  if (errors.length) throw new HttpError(400, errors[0]!);
  if (complete && missing.length) {
    throw new HttpError(400, `Answer every question before submitting. ${missing.length === 1 ? "One question is" : `${missing.length} questions are`} still open.`, { missing });
  }
}
