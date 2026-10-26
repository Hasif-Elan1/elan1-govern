import { RISK_TAGS } from "@gate/core";
import { z } from "zod";
import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Body = z.object({ enabled: z.boolean().optional(), tags: z.array(z.enum(RISK_TAGS)).max(RISK_TAGS.length).optional() }).strict();

/** Switch a tool on or off for agents, or change its risk tags. */
export const PATCH = route({ auth: "org", permission: "connectors:manage", body: Body }, async ({ body, params, ctx }) =>
  gateOk(
    "POST",
    `/internal/orgs/${ctx.org.id}/upstreams/${encodeURIComponent(params.id ?? "")}/tools/${encodeURIComponent(params.toolId ?? "")}`,
    { ...body, actor: ctx.user.email },
    "Gate could not change the tool.",
  ),
);
