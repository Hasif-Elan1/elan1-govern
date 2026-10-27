import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * "Open as draft": marks the suggestion applied (with a receipt) and sends the person to the builder,
 * which loads the drafted rulebook. Nothing is signed or published here.
 */
export const POST = route({ auth: "org", permission: "suggestions:manage", body: z.object({}).strict() }, async ({ params, ctx }) => {
  if (!Id.safeParse(params.id).success) throw new HttpError(404, "No such suggestion.");
  const r = await gateOk<{ agent: string; id: string }>("POST", `/internal/orgs/${ctx.org.id}/suggestions/${params.id}/apply`, { actor: ctx.user.email }, "Elan1 Govern could not open the draft.");
  return { href: `/rulebooks/${r.agent}?suggestion=${r.id}` };
});
