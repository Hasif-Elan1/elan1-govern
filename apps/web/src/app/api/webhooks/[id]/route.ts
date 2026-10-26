import { forOrg } from "@gate/db";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

/** Delete an endpoint and its delivery history. */
export const DELETE = route({ auth: "org", permission: "webhooks:manage" }, async ({ params, ctx }) => {
  if (!(await forOrg(ctx.org.id).webhook.findFirst({ where: { id: params.id }, select: { id: true } }))) throw new HttpError(404, "No such webhook.");
  const r = await gate("POST", `/internal/orgs/${ctx.org.id}/webhooks/${params.id}/delete`, { actor: ctx.user.email });
  if (r.status !== 200) throw new HttpError(502, "Gate could not delete the endpoint.");
  return { ok: true };
});
