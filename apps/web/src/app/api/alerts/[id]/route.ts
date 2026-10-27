import { z } from "zod";
import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Body = z.object({ action: z.enum(["acknowledge", "resolve"]) }).strict();

/** Acknowledge or resolve an unusual-behaviour alert. Owners, admins and approvers; a receipt records it. */
export const POST = route({ auth: "org", permission: "alerts:acknowledge", body: Body }, async ({ body, params, ctx }) => {
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(params.id ?? "") ? params.id! : "none";
  return gateOk("POST", `/internal/orgs/${ctx.org.id}/alerts/${id}`, { action: body.action, actor: ctx.user.email }, "Elan1 Govern could not update the alert.");
});
