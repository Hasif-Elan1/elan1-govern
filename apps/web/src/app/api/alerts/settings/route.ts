import { BehaviourSettingsSchema } from "@gate/core";
import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

/** The organisation's alert thresholds. Owners and admins; a receipt records what changed. */
export const PUT = route({ auth: "org", permission: "alerts:configure", body: BehaviourSettingsSchema }, async ({ body, ctx }) => {
  return gateOk("POST", `/internal/orgs/${ctx.org.id}/alert-settings`, { settings: body, actor: ctx.user.email }, "Elan1 Govern could not save the alert settings.");
});
