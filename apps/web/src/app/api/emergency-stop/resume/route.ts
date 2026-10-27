import { z } from "zod";
import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Body = z.object({ confirm: z.literal(true) }).strict();

/** Ends the emergency stop: resumes only the agents it paused. Owners and admins, fresh sign-in. */
export const POST = route({ auth: "org", permission: "emergency:stop", fresh: true, body: Body }, async ({ ctx }) => {
  return gateOk("POST", `/internal/orgs/${ctx.org.id}/emergency-stop/resume`, { actor: ctx.user.email }, "Elan1 Govern could not resume the agents.");
});
