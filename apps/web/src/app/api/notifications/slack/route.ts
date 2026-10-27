import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { SlackBody } from "@/lib/notifications";

/** Connect the organisation's Slack app. The token and signing secret go to Elan1 Govern and are never shown again. */
export const POST = route({ auth: "org", permission: "notifications:manage", fresh: true, body: SlackBody }, async ({ body, ctx }) => {
  const r = await gate<{ id?: string; url?: string; team?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/chat/slack`, { ...body, actor: ctx.user.email });
  if (r.status === 400) throw new HttpError(400, r.data.error ?? "Slack could not be connected.");
  if (r.status !== 200 || !r.data.url) throw new HttpError(502, "Elan1 Govern could not connect Slack.");
  return { url: r.data.url, team: r.data.team };
});

export const DELETE = route({ auth: "org", permission: "notifications:manage", fresh: true }, async ({ ctx }) => {
  const r = await gate("POST", `/internal/orgs/${ctx.org.id}/chat/slack/remove`, { actor: ctx.user.email });
  if (r.status === 404) throw new HttpError(404, "Slack is not connected.");
  if (r.status !== 200) throw new HttpError(502, "Elan1 Govern could not disconnect Slack.");
  return { ok: true };
});
