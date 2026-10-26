import { forOrg } from "@gate/db";
import { HttpError, route } from "@/server/api";
import { SystemFields, withReceipt } from "@/server/inventory";

const Body = SystemFields.partial().refine((b) => Object.keys(b).length > 0, "Change at least one field.");

/** Edit an AI system, including retiring it (lifecycle: retired). */
export const PATCH = route({ auth: "org", permission: "inventory:manage", body: Body }, async ({ body, params, ctx }) => {
  const db = forOrg(ctx.org.id);
  const before = await db.aiSystem.findFirst({ where: { id: params.id } });
  if (!before) throw new HttpError(404, "No such AI system.");
  if (before.agentId && body.kind && body.kind !== "agent") throw new HttpError(400, "This system is an Elan1 Govern agent, so its kind stays Agent.");
  const changed = (Object.keys(body) as (keyof typeof body)[]).filter((k) => JSON.stringify(body[k]) !== JSON.stringify(before[k]));
  if (!changed.length) return { ok: true, changed };
  const previous = Object.fromEntries(changed.map((k) => [k, before[k]]));
  await withReceipt(
    ctx.org.id,
    ctx.user.email,
    "system.updated",
    () => db.aiSystem.update({ where: { id: before.id }, data: body }),
    (s) => ({ system: s.name, changed: changed.join(", "), lifecycle: s.lifecycle }),
    () => db.aiSystem.update({ where: { id: before.id }, data: previous }),
  );
  return { ok: true, changed };
});
