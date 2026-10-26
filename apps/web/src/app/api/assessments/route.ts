import { getTemplate, TEMPLATES } from "@gate/core";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";

const Body = z
  .object({
    systemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    templateKey: z.enum(TEMPLATES.map((t) => t.key) as [string, ...string[]]),
  })
  .strict();

/** Start an assessment of a system as a draft. */
export const POST = route({ auth: "org", permission: "assessments:draft", body: Body }, async ({ body, ctx }) => {
  const db = forOrg(ctx.org.id);
  const system = await db.aiSystem.findFirst({ where: { id: body.systemId } });
  if (!system) throw new HttpError(404, "No such AI system.");
  if (system.lifecycle === "retired") throw new HttpError(409, "This system is retired. Bring it back into use before assessing it.");
  const t = getTemplate(body.templateKey)!;
  const a = await db.assessment.create({ data: { orgId: ctx.org.id, systemId: system.id, templateKey: t.key, templateVersion: t.version, answers: {}, createdBy: ctx.user.email } });
  return { id: a.id };
});
