import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z.object({ revokeKeyId: z.string().max(64).optional() }).strict();

/** Create a new API key (shown once) or revoke one. */
export const POST = route({ auth: "org", permission: "agents:manage", body: Body }, async ({ body, params, ctx }) => {
  const agent = await forOrg(ctx.org.id).agent.findFirst({ where: { slug: params.slug } });
  if (!agent) throw new HttpError(404, "No such agent.");
  if (body.revokeKeyId && !(await forOrg(ctx.org.id).apiKey.findFirst({ where: { id: body.revokeKeyId, agentId: agent.id } }))) throw new HttpError(404, "No such key.");
  const r = await gate<{ apiKey?: string | null; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/agents/${agent.id}/keys`, { actor: ctx.user.email, ...(body.revokeKeyId ? { revokeKeyId: body.revokeKeyId } : {}) });
  if (r.status !== 200) throw new HttpError(502, r.data.error ?? "Elan1 Govern could not change the keys.");
  return { apiKey: r.data.apiKey ?? null };
});
