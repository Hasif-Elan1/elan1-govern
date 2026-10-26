import { forOrg } from "@gate/db";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

/** Send a test event to one endpoint now. */
export const POST = route({ auth: "org", permission: "webhooks:manage" }, async ({ params, ctx }) => {
  if (!(await forOrg(ctx.org.id).webhook.findFirst({ where: { id: params.id }, select: { id: true } }))) throw new HttpError(404, "No such webhook.");
  const r = await gate<{ outcome?: string }>("POST", `/internal/orgs/${ctx.org.id}/webhooks/${params.id}/test`, { actor: ctx.user.email });
  if (r.status !== 200) throw new HttpError(502, "Gate could not send the test event.");
  return { outcome: r.data.outcome };
});
