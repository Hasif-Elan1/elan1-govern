import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z.object({ confirm: z.literal(true) }).strict();

/** Rotate the organisation's signing key. Owners only, with a recent sign-in. */
export const POST = route({ auth: "org", permission: "keys:rotate", fresh: true, body: Body }, async ({ ctx }) => {
  const r = await gate<{ kid?: string; previousKid?: string }>("POST", `/internal/orgs/${ctx.org.id}/signing-key/rotate`, { actor: ctx.user.email });
  if (r.status !== 200 || !r.data.kid) throw new HttpError(502, "Gate could not rotate the signing key. Nothing was changed.");
  return { kid: r.data.kid, previousKid: r.data.previousKid };
});
