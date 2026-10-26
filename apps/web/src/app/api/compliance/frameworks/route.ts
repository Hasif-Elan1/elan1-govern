import { FRAMEWORK_IDS } from "@gate/core/frameworks";
import { disableFramework, enableFrameworks } from "@gate/db";
import { z } from "zod";
import { route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z.object({ framework: z.enum(FRAMEWORK_IDS as [string, ...string[]], { error: "Unknown framework." }), enabled: z.boolean() }).strict();

/** Switch one framework on or off for the org. Each change is a receipt. */
export const POST = route({ auth: "org", permission: "compliance:manage", body: Body }, async ({ body, ctx }) => {
  const changed = body.enabled ? (await enableFrameworks(ctx.org.id, [body.framework], ctx.user.email)).length > 0 : await disableFramework(ctx.org.id, body.framework);
  if (changed) {
    await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: body.enabled ? "framework.enabled" : "framework.disabled", details: { framework: body.framework } });
  }
  return { framework: body.framework, enabled: body.enabled, changed };
});
