import "server-only";
import { hashToken, randomToken } from "@gate/core";
import { addMembership, findInviteByTokenHash, forOrg, prisma } from "@gate/db";
import { HttpError } from "./api";
import { knownConsoleOrg, runOp, serverDoc } from "./console-domain";
import { gate } from "./gate";
import { inviteMember } from "./identity";
import { canAssignRole, type Role } from "./policy";

/*
 * Invitations, one system for both doors (POST /api/members and the console's People and roles): the Invite table
 * holds each one (the link's hash only; the link itself goes by email), and for a console organisation the
 * organisation's document lists it too, through console operations run as the people involved:
 *  - consoleOps.recordInvitation as the inviter (the pending entry and member.invited, with the link's hash);
 *  - consoleOps.ensureInvitedMembership as the person accepting (the member record and member.joined).
 * Those operations write their receipts on the organisation's real chain; for any other organisation the receipts
 * go through the gate's events path, as before.
 */

export const INVITE_DAYS = 7;
const GONE = "This invite has expired or was already used. Ask for a new one.";

export interface Inviter {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * Invite `email` to `org` as `role`. An existing Elan1 Govern user is added at once (the CA with several clients);
 * anyone else gets a single-use link by email, valid 7 days, which replaces any pending link for that address.
 * The link is returned to the inviter (it is also shown in the app).
 */
export async function invitePerson(org: { id: string; name: string }, inviter: Inviter, email: string, role: Role): Promise<{ added: boolean; link: string | null; seq?: number }> {
  if (!canAssignRole(inviter.role, role)) throw new HttpError(403, inviter.role === "admin" ? "Only an owner can add another owner." : "Your role does not allow this.");
  email = email.trim().toLowerCase();
  const db = forOrg(org.id);
  const onConsole = await knownConsoleOrg(org.id);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (await db.membership.findFirst({ where: { userId: existing.id } })) throw new HttpError(409, "They are already a member.");
    let seq: number | undefined;
    if (onConsole) {
      // the document lists and admits them the same way an emailed link would, with a link nobody else ever sees
      const token = randomToken();
      await recordInConsole(org.id, inviter.id, email, role, token);
      seq = ((await runOp(org.id, existing.id, "consoleOps.ensureInvitedMembership", [org.id, token, existing.id])).result as { seq?: number }).seq;
    }
    await addMembership({ orgId: org.id, userId: existing.id, role });
    if (!onConsole) await gate("POST", `/internal/orgs/${org.id}/events`, { actor: inviter.email, action: "member.joined", details: { role } });
    return { added: true, link: null, ...(seq !== undefined ? { seq } : {}) };
  }
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  // the document first: a refusal there (a stopped pilot, a role the inviter no longer holds) leaves no link behind
  const seq = onConsole ? (await recordInConsole(org.id, inviter.id, email, role, token, expiresAt)).seq : undefined;
  // the real invitation and its email (identity.ts); a console organisation's receipt was written by the operation above
  const recorder = onConsole ? undefined : (action: string, details: Record<string, string | number | boolean | null>) => gate("POST", `/internal/orgs/${org.id}/events`, { actor: inviter.email, action, details });
  const { link } = await inviteMember(org, inviter, { email, role, token, expiresAt }, recorder);
  return { added: false, link, ...(seq !== undefined ? { seq } : {}) };
}

async function recordInConsole(orgId: string, inviterId: string, email: string, role: Role, token: string, expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000)) {
  const { result } = await runOp(orgId, inviterId, "consoleOps.recordInvitation", [orgId, { email, role, tokenHash: hashToken(token), expiresAt: expiresAt.toISOString() }, inviterId]);
  return result as { seq: number; memberId: string };
}

type DocInvite = { tokenHash?: string; usedAt?: string; revokedAt?: string; replacedBy?: string };

/** A link that still works: in the Invite table and, for a console organisation, not withdrawn or replaced there. */
async function liveInvite(token: string) {
  const tokenHash = hashToken(token);
  const invite = await findInviteByTokenHash(tokenHash);
  if (!invite) throw new HttpError(410, GONE);
  const onConsole = await knownConsoleOrg(invite.orgId);
  if (onConsole) {
    const { doc } = await serverDoc(invite.orgId);
    const listed = ((doc.orgSettings as { invites?: DocInvite[] } | undefined)?.invites ?? []).find((i) => i.tokenHash === tokenHash);
    if (!listed || listed.usedAt || listed.revokedAt || listed.replacedBy) throw new HttpError(410, GONE);
  }
  return { invite, onConsole };
}

/** What the invitation page shows before anyone signs in: the organisation, who invited them and the role. Nothing else. */
export async function inviteSummary(token: string): Promise<{ orgName: string; inviter: string | null; role: Role }> {
  const { invite } = await liveInvite(token);
  const org = await forOrg(invite.orgId).org.findFirst({ select: { name: true } });
  const inviter = await prisma.user.findUnique({ where: { email: invite.invitedBy }, select: { name: true } });
  return { orgName: org?.name ?? "", inviter: inviter?.name ?? null, role: invite.role as Role };
}

/**
 * Accept an invitation as `user` (signed in, or just signed up), whose email must be the one it was sent to. The
 * link works once. The person becomes a member with the invited role, in the Membership table and, for a console
 * organisation, in its document (member.joined on its chain).
 */
export async function acceptInvite(token: string, user: { id: string; email: string }): Promise<{ orgId: string; role: Role }> {
  const { invite, onConsole } = await liveInvite(token);
  if (invite.email !== user.email.toLowerCase()) throw new HttpError(403, "This invite was sent to another address. Sign in with the address it was sent to.");
  // the document first: it refuses a member suspended there; running it again as the same person changes nothing
  if (onConsole) await runOp(invite.orgId, user.id, "consoleOps.ensureInvitedMembership", [invite.orgId, token, user.id]);
  const claimed = await forOrg(invite.orgId).invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
  if (claimed.count !== 1) throw new HttpError(410, GONE);
  await addMembership({ orgId: invite.orgId, userId: user.id, role: invite.role });
  if (!onConsole) await gate("POST", `/internal/orgs/${invite.orgId}/events`, { actor: user.email, action: "member.joined", details: { role: invite.role } });
  return { orgId: invite.orgId, role: invite.role as Role };
}

/** For a sign-up through an invitation: the link must still work and be for this address (checked before the account is made). */
export async function checkInviteFor(token: string, email: string) {
  const { invite } = await liveInvite(token);
  if (invite.email !== email.toLowerCase()) throw new HttpError(400, "This invite was sent to another address. Use the address it was sent to.");
}
