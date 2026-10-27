import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { CodeBody, NumberBody } from "@/lib/notifications";

// An approver's own WhatsApp number: send a code, confirm it, or remove the number.
const limit = { name: "whatsapp-number", max: 10, windowMs: 60_000 };
const pass = (r: { status: number; data: { error?: string } }, fallback: string) => {
  if ([400, 404, 409, 429].includes(r.status)) throw new HttpError(r.status, r.data.error ?? fallback);
  if (r.status !== 200) throw new HttpError(502, r.data.error ?? fallback);
};

export const POST = route({ auth: "org", permission: "approvals:decide", body: NumberBody, limit }, async ({ body, ctx }) => {
  const r = await gate<{ last4?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/chat/whatsapp/numbers`, { userId: ctx.user.id, number: body.number });
  pass(r, "The code could not be sent.");
  return { last4: r.data.last4 };
});

export const PUT = route({ auth: "org", permission: "approvals:decide", body: CodeBody, limit }, async ({ body, ctx }) => {
  const r = await gate<{ last4?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/chat/whatsapp/numbers/confirm`, { userId: ctx.user.id, code: body.code, actor: ctx.user.email });
  pass(r, "The code could not be checked.");
  return { last4: r.data.last4, verified: true };
});

export const DELETE = route({ auth: "org", permission: "approvals:decide" }, async ({ ctx }) => {
  const r = await gate<{ error?: string }>("POST", `/internal/orgs/${ctx.org.id}/chat/whatsapp/numbers/remove`, { userId: ctx.user.id, actor: ctx.user.email });
  pass(r, "The number could not be removed.");
  return { ok: true };
});
