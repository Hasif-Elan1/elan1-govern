import { HttpError, route } from "@/server/api";
import { inviteSummary } from "@/server/console-invites";

/**
 * Public: what an invite link points at, for the invitation page: the organisation's name, who invited them and
 * the role. Nothing else (not the address it was sent to). A link that no longer works (expired, used, withdrawn,
 * replaced or never issued) answers 410 with one sentence, the same for every case.
 */
export const GET = route({ auth: "public", limit: { name: "invite-read", max: 30, windowMs: 60_000 } }, async ({ params }) => {
  const token = params.token ?? "";
  if (token.length < 10 || token.length > 200) throw new HttpError(410, "This invite has expired or was already used. Ask for a new one.");
  return inviteSummary(token);
});
