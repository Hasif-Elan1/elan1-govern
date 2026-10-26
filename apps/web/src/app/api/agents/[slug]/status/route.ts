import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z.object({ status: z.enum(["active", "paused"]) }).strict();

/** The kill switch. Pausing takes effect on the agent's very next call. */
export const POST = route({ auth: "org", permission: "agents:manage", body: Body }, async ({ body, params, ctx }) => {
  const agent = await forOrg(ctx.org.id).agent.findFirst({ where: { slug: params.slug } });
  if (!agent) throw new HttpError(404, "No such agent.");
  const r = await gate<{ status?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/agents/${agent.id}/status`, { status: body.status, actor: ctx.user.email });
  if (r.status !== 200) throw new HttpError(502, r.data.error ?? "Gate could not change the agent.");
  return { status: r.data.status };
});
