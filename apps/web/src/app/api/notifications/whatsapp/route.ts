import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { WhatsAppBody } from "@/lib/notifications";

/** Connect the organisation's WhatsApp business number. The webhook verify token comes back once. */
export const POST = route({ auth: "org", permission: "notifications:manage", fresh: true, body: WhatsAppBody }, async ({ body, ctx }) => {
  const r = await gate<{ url?: string; verifyToken?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/chat/whatsapp`, { ...body, actor: ctx.user.email });
  if (r.status === 400) throw new HttpError(400, r.data.error ?? "WhatsApp could not be connected.");
  if (r.status !== 200 || !r.data.verifyToken) throw new HttpError(502, "Elan1 Govern could not connect WhatsApp.");
  return { url: r.data.url, verifyToken: r.data.verifyToken };
});

export const DELETE = route({ auth: "org", permission: "notifications:manage", fresh: true }, async ({ ctx }) => {
  const r = await gate("POST", `/internal/orgs/${ctx.org.id}/chat/whatsapp/remove`, { actor: ctx.user.email });
  if (r.status === 404) throw new HttpError(404, "WhatsApp is not connected.");
  if (r.status !== 200) throw new HttpError(502, "Elan1 Govern could not disconnect WhatsApp.");
  return { ok: true };
});
