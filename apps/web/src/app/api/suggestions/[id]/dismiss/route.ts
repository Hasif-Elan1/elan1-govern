import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Dismiss a suggestion. It stays dismissed until the evidence behind it has at least doubled. */
export const POST = route({ auth: "org", permission: "suggestions:manage", body: z.object({}).strict() }, async ({ params, ctx }) => {
  if (!Id.safeParse(params.id).success) throw new HttpError(404, "No such suggestion.");
  await gateOk("POST", `/internal/orgs/${ctx.org.id}/suggestions/${params.id}/dismiss`, { actor: ctx.user.email }, "Elan1 Govern could not dismiss the suggestion.");
  return { ok: true };
});
