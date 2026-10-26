import { forOrg } from "@gate/db";
import { route } from "@/server/api";
import { SystemFields, withReceipt } from "@/server/inventory";

/** Add an AI system to the inventory. It starts unassessed. */
export const POST = route({ auth: "org", permission: "inventory:manage", body: SystemFields }, async ({ body, ctx }) => {
  const db = forOrg(ctx.org.id);
  const system = await withReceipt(
    ctx.org.id,
    ctx.user.email,
    "system.created",
    () => db.aiSystem.create({ data: { ...body, orgId: ctx.org.id } }),
    (s) => ({ system: s.name, kind: s.kind, lifecycle: s.lifecycle }),
    (s) => db.aiSystem.delete({ where: { id: s.id } }),
  );
  return { id: system.id };
});
