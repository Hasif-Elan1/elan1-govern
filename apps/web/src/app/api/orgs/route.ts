import { membershipsForUser, prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { currentSession } from "@/server/session";

const Create = z.object({ name: z.string().trim().min(2, "Enter your company's name.").max(120) }).strict();

/** Create an organisation (Gate makes its signing key) and switch to it. */
export const POST = route({ auth: "user", body: Create }, async ({ body }) => {
  const s = await currentSession();
  if (!s) throw new HttpError(401, "Sign in to continue.");
  const r = await gate<{ orgId?: string; error?: string }>("POST", "/internal/orgs", { name: body.name, ownerUserId: s.userId, ownerEmail: s.user.email });
  if (r.status !== 200 || !r.data.orgId) throw new HttpError(502, r.data.error ?? "Gate could not create the organisation.");
  await prisma.session.update({ where: { id: s.id }, data: { activeOrgId: r.data.orgId } });
  return { orgId: r.data.orgId };
});

const Switch = z.object({ orgId: z.string().max(64) }).strict();

/** Switch the active org (the client switcher). Only to orgs you belong to. */
export const PUT = route({ auth: "user", body: Switch }, async ({ body }) => {
  const s = await currentSession();
  if (!s) throw new HttpError(401, "Sign in to continue.");
  const ms = await membershipsForUser(s.userId);
  if (!ms.some((m) => m.orgId === body.orgId)) throw new HttpError(403, "You are not a member of that organisation.");
  await prisma.session.update({ where: { id: s.id }, data: { activeOrgId: body.orgId } });
  return { ok: true };
});
