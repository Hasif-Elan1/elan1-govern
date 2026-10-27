import { z } from "zod";
import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Body = z
  .object({
    confirm: z.literal("STOP", { error: "Type STOP to confirm." }),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

/**
 * The emergency stop: pause every agent in the organisation at once. Owners and admins only,
 * with a sign-in in the last 10 minutes and the word STOP typed, because misused it stops all work.
 */
export const POST = route({ auth: "org", permission: "emergency:stop", fresh: true, body: Body }, async ({ body, ctx }) => {
  return gateOk("POST", `/internal/orgs/${ctx.org.id}/emergency-stop`, { actor: ctx.user.email, ...(body.reason ? { reason: body.reason } : {}) }, "Elan1 Govern could not stop the agents.");
});
