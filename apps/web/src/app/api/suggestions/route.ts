import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Body = z.object({ agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional() }).strict();

/** "Look for suggestions": the same miner the nightly job runs, now. Nothing changes in any rulebook. */
export const POST = route({ auth: "org", permission: "suggestions:manage", body: Body }, async ({ body, ctx }) => {
  let agentId: string | undefined;
  if (body.agent) {
    const agent = await forOrg(ctx.org.id).agent.findFirst({ where: { slug: body.agent }, select: { id: true } });
    if (!agent) throw new HttpError(404, "No such agent.");
    agentId = agent.id;
  }
  const r = await gateOk<{ created: number; open: number }>("POST", `/internal/orgs/${ctx.org.id}/suggestions/run`, { actor: ctx.user.email, ...(agentId ? { agentId } : {}) }, "Elan1 Govern could not look for suggestions.");
  return { open: r.open, created: r.created };
});
