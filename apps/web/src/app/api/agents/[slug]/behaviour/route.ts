import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Body = z.object({ autoPauseOnHigh: z.boolean() }).strict();

/** "Pause automatically on high-severity alerts", per agent. */
export const POST = route({ auth: "org", permission: "agents:manage", body: Body }, async ({ body, params, ctx }) => {
  const agent = await forOrg(ctx.org.id).agent.findFirst({ where: { slug: params.slug } });
  if (!agent) throw new HttpError(404, "No such agent.");
  return gateOk("POST", `/internal/orgs/${ctx.org.id}/agents/${agent.id}/auto-pause`, { autoPauseOnHigh: body.autoPauseOnHigh, actor: ctx.user.email }, "Elan1 Govern could not change the setting.");
});
