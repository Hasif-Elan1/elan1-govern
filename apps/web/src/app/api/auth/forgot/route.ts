import { z } from "zod";
import { route } from "@/server/api";
import { hit, LIMITS } from "@/server/ratelimit";
import { FORGOT_REPLY, requestPasswordReset } from "@/server/reset";
import { email } from "../route-helpers";

const Body = z.object({ email }).strict();

/** Ask for a reset link. The answer is the same whether or not the email has an account. */
export const POST = route({ auth: "public", body: Body, limit: { name: "forgot", ...LIMITS.forgot } }, async ({ body }) => {
  // Past the per-email limit nothing more is sent, but the answer does not change (it would say the address is in use).
  if (hit(`forgot-email:${body.email}`, 3, 15 * 60_000).ok) await requestPasswordReset(body.email);
  return { ...FORGOT_REPLY };
});
