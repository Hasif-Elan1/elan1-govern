import { prisma } from "@gate/db";
import QRCode from "qrcode";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { newTotp, verifyTotp } from "@/server/auth";
import { gate } from "@/server/gate";

// Two-step setup: start (stores a pending secret, returns a QR code), then enable with a code.
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("enable"), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }).strict(),
  z.object({ action: z.literal("disable"), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }).strict(),
]);

export const POST = route({ auth: "org", body: Body, fresh: true }, async ({ body, ctx }) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (body.action === "start") {
    if (user.totpEnabled) throw new HttpError(409, "Two-step sign-in is already on.");
    const t = newTotp(user.email);
    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: t.secretEnc } });
    return { qr: await QRCode.toDataURL(t.uri, { margin: 1, width: 200 }), secret: t.uri.match(/secret=([A-Z2-7]+)/)?.[1] ?? "" };
  }
  if (!user.totpSecret || !verifyTotp(user.totpSecret, body.code)) throw new HttpError(400, "That code did not match. Try the newest code in your app.");
  const enabled = body.action === "enable";
  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: enabled, ...(enabled ? {} : { totpSecret: null }) } });
  await gate("POST", `/internal/orgs/${ctx.org.id}/events`, { actor: ctx.user.email, action: enabled ? "user.2fa_enabled" : "user.2fa_disabled", details: {} });
  return { enabled };
});
