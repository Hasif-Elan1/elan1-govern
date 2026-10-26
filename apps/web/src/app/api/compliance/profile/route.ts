import { PACK_IDS, packById, recommendedFrameworks, REGIONS } from "@gate/core/frameworks";
import { enableFrameworks, forOrg } from "@gate/db";
import { z } from "zod";
import { route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z
  .object({
    industry: z.enum(PACK_IDS as [string, ...string[]], { error: "Pick the kind of work your agents do." }),
    regions: z.array(z.enum(REGIONS)).min(1, "Pick at least one place you operate.").max(REGIONS.length),
    /** Switch on the pack's recommended frameworks for these regions (onboarding does). */
    enableRecommended: z.boolean().default(true),
  })
  .strict();

/** Records the org's industry and where it operates, and switches on the recommended frameworks. */
export const PUT = route({ auth: "org", permission: "compliance:manage", body: Body }, async ({ body, ctx }) => {
  const regions = [...new Set(body.regions)];
  await forOrg(ctx.org.id).org.update({ where: { id: ctx.org.id }, data: { industry: body.industry, regions } });
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "org.industry_set", details: { industry: body.industry, regions: regions.join(", ") } });
  const enabled = body.enableRecommended ? await enableFrameworks(ctx.org.id, recommendedFrameworks(packById(body.industry)!, regions), ctx.user.email) : [];
  for (const framework of enabled) {
    await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: "framework.enabled", details: { framework } });
  }
  return { industry: body.industry, regions, enabled };
});
