import "server-only";
import { hashToken, randomToken } from "@gate/core";
import { allMembershipsForUser, prisma } from "@gate/db";
import { hashPassword } from "./auth";
import { env } from "./env";
import { gate } from "./gate";
import { log } from "./log";
import { sendPasswordReset } from "./mail";
import { passwordBlockedBySso } from "./sso";

// Forgotten passwords: an emailed, single-use link valid for 30 minutes. Only the token's hash is
// stored. Asking never says whether the email has an account; using the link ends every other session.

export const RESET_MINUTES = 30;

/** The one answer to "forgot password", whether or not the email has an account. */
export const FORGOT_REPLY = {
  ok: true,
  message: `If an account uses that email, we have sent it a link to choose a new password. The link works once and expires in ${RESET_MINUTES} minutes.`,
} as const;

/**
 * Emails a reset link when the address has an account that signs in with a password. The same work is
 * done up front for any address, and the email is sent without waiting, so timing says little either way.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const token = randomToken();
  const tokenHash = hashToken(token);
  const [user, ssoOnly] = await Promise.all([prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true } }), passwordBlockedBySso(email)]);
  // An organisation that requires single sign-on refuses passwords, so there is nothing to reset.
  if (!user || ssoOnly) return;
  await prisma.$transaction([
    // A new link replaces any earlier one that was not used.
    prisma.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } }),
    prisma.passwordReset.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000) } }),
  ]);
  void sendPasswordReset(user.email, user.name, `${env().WEB_URL}/reset/${token}`);
}

export type ResetResult = { ok: true; userId: string; sessionsEnded: number; receipts: number } | { ok: false };

/**
 * Sets a new password from a reset link. The link is claimed atomically, so it works once; the
 * account's lock is cleared; every session except `keepSessionId` (this browser, when it is the same
 * person) ends; and an auth.password_reset receipt is written on each organisation the person belongs to.
 */
export async function resetPassword(token: string, newPassword: string, keepSessionId?: string): Promise<ResetResult> {
  const now = new Date();
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.usedAt || row.expiresAt <= now) return { ok: false };
  const passwordHash = await hashPassword(newPassword);
  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordReset.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) return null;
    await tx.passwordReset.deleteMany({ where: { userId: row.userId, usedAt: null } });
    const user = await tx.user.update({ where: { id: row.userId }, data: { passwordHash, failedLogins: 0, lockedUntil: null }, select: { email: true } });
    const ended = await tx.session.deleteMany({ where: { userId: row.userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) } });
    return { email: user.email, sessionsEnded: ended.count };
  });
  if (!done) return { ok: false };

  let receipts = 0;
  for (const m of await allMembershipsForUser(row.userId)) {
    const r = await gate("POST", `/internal/orgs/${m.orgId}/events`, { actor: done.email, action: "auth.password_reset", details: { sessions_ended: done.sessionsEnded } }).catch(() => ({ status: 0 }));
    // The password has already changed; a missing receipt is logged loudly rather than undoing the reset.
    if (r.status === 200) receipts++;
    else log("error", "password reset receipt not written", { orgId: m.orgId, status: r.status });
  }
  return { ok: true, userId: row.userId, sessionsEnded: done.sessionsEnded, receipts };
}
