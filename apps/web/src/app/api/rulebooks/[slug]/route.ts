import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z.object({ yaml: z.string().min(1).max(200_000) }).strict();

/** Sign and publish: Elan1 Govern validates, checks the risk-tier rules, signs with the org key and makes it active. */
export const POST = route({ auth: "org", permission: "rulebooks:publish", body: Body }, async ({ body, params, ctx }) => {
  const agent = await forOrg(ctx.org.id).agent.findFirst({ where: { slug: params.slug } });
  if (!agent) throw new HttpError(404, "No such agent.");
  const r = await gate<{ ok: boolean; version?: number; hash?: string; errors?: string[] }>("POST", `/internal/orgs/${ctx.org.id}/agents/${agent.id}/rulebooks`, { yaml: body.yaml, actor: ctx.user.email });
  if (r.status === 422) return Response.json({ error: r.data.errors?.[0] ?? "The rulebook has problems.", errors: r.data.errors ?? [] }, { status: 422 });
  if (r.status !== 200) throw new HttpError(502, "Elan1 Govern could not publish the rulebook.");
  return { version: r.data.version, hash: r.data.hash };
});
