import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { gate } from "@/server/gate";

const Body = z
  .object({
    url: z.string().trim().url("Enter a full URL, starting with https://").max(2000),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Pick at least one event.").max(WEBHOOK_EVENTS.length),
  })
  .strict();

/** Add a webhook endpoint. The signing secret comes back once and is never shown again. */
export const POST = route({ auth: "org", permission: "webhooks:manage", body: Body }, async ({ body, ctx }) => {
  const r = await gate<{ id?: string; secret?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/webhooks`, { ...body, actor: ctx.user.email });
  if (r.status === 400) throw new HttpError(400, r.data.error ?? "That endpoint could not be added.");
  if (r.status !== 200 || !r.data.secret) throw new HttpError(502, "Elan1 Govern could not add the endpoint.");
  return { id: r.data.id, secret: r.data.secret };
});
