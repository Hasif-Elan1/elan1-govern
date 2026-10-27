import { forOrg } from "@gate/db";
import { z } from "zod";
import { route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    notifyEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    retentionDays: z.number().int().refine((d) => [365, 1095, 2555, 3650].includes(d), "Pick one of the offered periods.").optional(),
    replayStore: z.boolean().optional(),
  })
  .strict();

export const PATCH = route({ auth: "org", permission: "settings:manage", body: Body }, async ({ body, ctx }) => {
  await forOrg(ctx.org.id).org.update({ where: { id: ctx.org.id }, data: body });
  // Switching the replay store off deletes what it holds (the hourly purge catches any call in flight).
  if (body.replayStore === false) await forOrg(ctx.org.id).replayCall.deleteMany({});
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, {
    actor: ctx.user.email,
    action: "settings.updated",
    details: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, k === "notifyEmail" ? (v ? "set" : "cleared") : (v as string | number | boolean)])),
  });
  return { ok: true };
});
