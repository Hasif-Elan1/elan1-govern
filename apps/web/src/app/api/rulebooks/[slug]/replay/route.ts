import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { hit, LIMITS } from "@/server/ratelimit";
import type { ReplayReport } from "@/lib/replay";

const Body = z.object({ yaml: z.string().min(1).max(200_000), days: z.union([z.literal(7), z.literal(30)]).default(30) }).strict();

/** Org-wide cap on top of the per-address one: each test decrypts and decides up to a month of calls. */
const ORG_LIMIT = { max: 10, windowMs: 60_000 };

/**
 * Test a draft on past actions. Only Elan1 Govern can read the stored arguments, so it runs the
 * replay; nothing is executed, signed or published.
 */
export const POST = route({ auth: "org", permission: "rulebooks:publish", body: Body, limit: { name: "replay", ...LIMITS.replay } }, async ({ body, params, ctx }) => {
  const limit = hit(`replay-org:${ctx.org.id}`, ORG_LIMIT.max, ORG_LIMIT.windowMs);
  if (!limit.ok) throw new HttpError(429, `Too many tests in a minute. Try again in ${limit.retryAfter} seconds.`, { retryAfter: limit.retryAfter });
  const agent = await forOrg(ctx.org.id).agent.findFirst({ where: { slug: params.slug }, select: { id: true } });
  if (!agent) throw new HttpError(404, "No such agent.");
  const r = await gate<ReplayReport & { error?: string; errors?: string[] }>("POST", `/internal/orgs/${ctx.org.id}/agents/${agent.id}/replay`, { yaml: body.yaml, days: body.days, actor: ctx.user.email });
  if (r.status === 422) return Response.json({ error: r.data.error ?? "The rulebook has problems.", errors: r.data.errors ?? [] }, { status: 422 });
  if (r.status === 429) throw new HttpError(429, r.data.error ?? "Too many tests in a minute. Try again shortly.");
  if (r.status !== 200) throw new HttpError(502, "Elan1 Govern could not test the rulebook on past actions.");
  return r.data;
});
