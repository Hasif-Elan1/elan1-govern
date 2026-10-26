import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

/** Sign the current head of the chain now, instead of waiting for the hourly checkpoint. */
export const POST = route({ auth: "org", permission: "evidence:checkpoint" }, async ({ ctx }) => {
  const r = await gate<{ checkpoint?: { seq: number } | null }>("POST", `/internal/orgs/${ctx.org.id}/checkpoints`, { actor: ctx.user.email });
  if (r.status !== 200) throw new HttpError(502, "Elan1 Govern could not sign a checkpoint.");
  return { seq: r.data.checkpoint?.seq ?? null };
});
