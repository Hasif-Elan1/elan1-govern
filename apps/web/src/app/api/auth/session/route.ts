import { consoleState, membershipsForUser, prisma } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { checkPassword } from "@/server/auth";
import { knownConsoleOrg, runOp } from "@/server/console-domain";
import { gate } from "@/server/gate";
import { log } from "@/server/log";
import { LIMITS } from "@/server/ratelimit";
import { currentSession, endSession } from "@/server/session";
import { password, totp } from "../route-helpers";

// DELETE: sign out. POST: confirm it's you (re-auth) before sensitive actions such as approving.

/**
 * Sign out: auth.signed_out on the organisation the session was using (its active one, which is where it signed
 * in unless the person switched since), and the session's record (ses_<user>_<signed-in time>) ended in every
 * console organisation of theirs that lists it. Both are best effort: signing out never fails because of them.
 */
export const DELETE = route({ auth: "user" }, async () => {
  const s = await currentSession();
  if (s) await recordSignOut(s).catch((e: Error) => log("error", "sign-out receipt not written", { userId: s.userId, err: e.message }));
  await endSession();
  return { ok: true };
});

async function recordSignOut(s: { userId: string; activeOrgId: string | null; createdAt: Date; user: { email: string } }) {
  const ms = await membershipsForUser(s.userId);
  const home = ms.find((m) => m.orgId === s.activeOrgId)?.orgId ?? ms[0]?.orgId;
  if (!home) return;
  const session = `ses_${s.userId}_${s.createdAt.getTime()}`;
  const minutes = Math.max(0, Math.round((Date.now() - s.createdAt.getTime()) / 60_000));
  const r = await gate<{ seq?: number }>("POST", `/internal/orgs/${home}/events`, { actor: s.user.email, action: "auth.signed_out", details: { reason: "Signed out", session, minutes } });
  if (r.status !== 200) log("error", "sign-out receipt not written", { orgId: home, status: r.status });
  for (const m of ms) {
    // only a saved document can list the session: none is built for this
    if (!(await knownConsoleOrg(m.orgId)) || !(await consoleState.version(m.orgId))) continue;
    const seq = m.orgId === home && r.status === 200 ? r.data.seq : undefined;
    await runOp(m.orgId, s.userId, "consoleOps.endSignedOutSession", [m.orgId, { session, ...(seq !== undefined ? { seq } : {}) }, s.userId]).catch((e: Error) =>
      log("warn", "console session record not ended", { orgId: m.orgId, err: e.message }),
    );
  }
}

const Reauth = z.object({ password, totp }).strict();

export const POST = route({ auth: "user", body: Reauth, limit: { name: "login", ...LIMITS.login } }, async ({ body }) => {
  const s = await currentSession();
  if (!s) throw new HttpError(401, "Sign in to continue.");
  const r = await checkPassword(s.user.email, body.password, body.totp);
  if (!r.ok) {
    if (r.reason === "totp_required") return { needTotp: true };
    if (r.reason === "locked") throw new HttpError(429, "Too many wrong passwords. Wait a few minutes and try again.");
    throw new HttpError(401, r.reason === "totp_invalid" ? "That code did not match." : "That password is not right.", r.reason === "totp_invalid" ? { needTotp: true } : {});
  }
  await prisma.session.update({ where: { id: s.id }, data: { lastAuthAt: new Date() } });
  return { ok: true };
});
