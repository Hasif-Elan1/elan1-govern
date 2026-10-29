import "server-only";
import { hashToken, randomToken } from "@gate/core";
import { addMembership, forOrg, prisma } from "@gate/db";
import { z } from "zod";
import { HttpError } from "./api";
import { env } from "./env";
import { sendInvite } from "./mail";
import { can, canAssignRole, type Role } from "./policy";

// Shared by OIDC (sso.ts), SAML (saml.ts) and SCIM (scim.ts).

export const domainSchema = z.string().trim().toLowerCase().regex(/^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, "Use a domain like acme.com.");

/** The org's proven domains: its SAML connection's and its OIDC connection's (one TXT proof counts for both). */
export async function orgVerifiedDomains(orgId: string): Promise<string[]> {
  const db = forOrg(orgId);
  const [saml, sso] = await Promise.all([db.samlConnection.findFirst({ select: { verifiedDomains: true } }), db.ssoConnection.findFirst({ select: { verifiedDomains: true } })]);
  return [...new Set([...(saml?.verifiedDomains ?? []), ...(sso?.verifiedDomains ?? [])])];
}

/** The directory switched this person off here (SCIM active=false): single sign-on must not add them back. */
export async function deactivatedByDirectory(orgId: string, userId: string): Promise<boolean> {
  return !!(await forOrg(orgId).scimUser.findFirst({ where: { userId, active: false }, select: { id: true } }));
}

// ---- People: invites, roles, suspension and removal (the API routes and the console's People screen) ----

/** Who acts, as the routes know them. */
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * How a change is recorded. The API routes write the gate's admin event (actor = email); the console writes its
 * own receipt for the operation (console-overrides/wiring/identity.ts) and passes none.
 */
export type Recorder = (action: string, details: Record<string, string | number | boolean | null>) => Promise<unknown>;

const INVITE_DAYS = 7;

async function memberOf(orgId: string, userId: string) {
  const m = await forOrg(orgId).membership.findFirst({ where: { userId } });
  if (!m) throw new HttpError(404, "No such member.");
  return m;
}

const activeOwners = (orgId: string) => forOrg(orgId).membership.count({ where: { role: "owner", status: "active" } });

/**
 * Invite by email. Existing Elan1 Govern users are added at once (the CA with several clients); others get a link
 * by email. `token` is the link's secret when the caller made it (the console shows the link to the inviter).
 */
export async function inviteMember(org: { id: string; name: string }, actor: Actor, input: { email: string; role: Role; token?: string; expiresAt?: Date }, record?: Recorder): Promise<{ added: boolean; link: string | null; userId?: string }> {
  if (!canAssignRole(actor.role, input.role)) throw new HttpError(403, "Only an owner can add another owner.");
  const db = forOrg(org.id);
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (await db.membership.findFirst({ where: { userId: existing.id } })) throw new HttpError(409, "They are already a member.");
    await addMembership({ orgId: org.id, userId: existing.id, role: input.role });
    await record?.("member.joined", { role: input.role });
    return { added: true, link: null, userId: existing.id };
  }
  const token = input.token ?? randomToken();
  // a newer invitation replaces any still pending for the same address
  const now = new Date();
  await db.invite.updateMany({ where: { email, acceptedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
  await db.invite.create({ data: { orgId: org.id, email, role: input.role, tokenHash: hashToken(token), invitedBy: actor.email, expiresAt: input.expiresAt ?? new Date(Date.now() + INVITE_DAYS * 86_400_000) } });
  const link = `${env().WEB_URL}/invite/${token}`;
  await sendInvite(email, org.name, actor.name, link, input.role);
  await record?.("member.invited", { role: input.role });
  return { added: false, link };
}

/** A new link for a pending invitation (the old one stops working), sent again. */
export async function reissueInvite(org: { id: string; name: string }, actor: Actor, email: string, token: string) {
  if (!can(actor.role, "members:manage")) throw new HttpError(403, "Your role does not allow this.");
  const db = forOrg(org.id);
  const inv = await db.invite.findFirst({ where: { email: email.toLowerCase(), acceptedAt: null }, orderBy: { createdAt: "desc" } });
  if (!inv) throw new HttpError(404, "That invitation no longer exists.");
  if (!canAssignRole(actor.role, inv.role as Role)) throw new HttpError(403, "Only an owner can invite an owner.");
  await db.invite.update({ where: { id: inv.id }, data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) } });
  await sendInvite(inv.email, org.name, actor.name, `${env().WEB_URL}/invite/${token}`, inv.role);
}

/** Withdraw a pending invitation; returns whether there was one. */
export async function revokeInvite(orgId: string, actor: Actor, email: string): Promise<boolean> {
  if (!can(actor.role, "members:manage")) throw new HttpError(403, "Your role does not allow this.");
  const db = forOrg(orgId);
  const address = email.toLowerCase();
  const pending = await db.invite.findMany({ where: { email: address, acceptedAt: null } });
  if (pending.some((i) => !canAssignRole(actor.role, i.role as Role))) throw new HttpError(403, "Only an owner can withdraw an owner's invitation.");
  return (await db.invite.deleteMany({ where: { email: address, acceptedAt: null } })).count > 0;
}

/** Change a member's role, or a pending invitation's (named by its email). */
export async function changeMemberRole(orgId: string, actor: Actor, target: { userId: string } | { email: string }, role: Role, record?: Recorder) {
  const db = forOrg(orgId);
  if ("email" in target) {
    const inv = await db.invite.findFirst({ where: { email: target.email.toLowerCase(), acceptedAt: null } });
    if (!inv) throw new HttpError(404, "That invitation no longer exists.");
    if (!canAssignRole(actor.role, role, inv.role as Role)) throw new HttpError(403, "Only an owner can change an owner's role or make someone an owner.");
    await db.invite.updateMany({ where: { email: inv.email, acceptedAt: null }, data: { role } });
    return;
  }
  const m = await memberOf(orgId, target.userId);
  if (!canAssignRole(actor.role, role, m.role as Role)) throw new HttpError(403, "Only an owner can change an owner's role or make someone an owner.");
  if (m.role === "owner" && role !== "owner" && m.status === "active" && (await activeOwners(orgId)) <= 1) throw new HttpError(409, "An organisation needs at least one owner.");
  await db.membership.update({ where: { id: m.id }, data: { role } });
  await record?.("member.role_changed", { role });
}

/** Suspend a member (they keep the row and their history but hold no role and cannot sign in here), or reinstate them. */
export async function setMemberSuspended(orgId: string, actor: Actor, userId: string, suspended: boolean) {
  if (!can(actor.role, "members:manage")) throw new HttpError(403, "Your role does not allow this.");
  const m = await memberOf(orgId, userId);
  if (!canAssignRole(actor.role, m.role as Role, m.role as Role)) throw new HttpError(403, "Only an owner can suspend or reinstate an owner.");
  if (suspended && m.role === "owner" && m.status === "active" && (await activeOwners(orgId)) <= 1) throw new HttpError(409, "The last active owner cannot be suspended.");
  await forOrg(orgId).membership.update({ where: { id: m.id }, data: { status: suspended ? "suspended" : "active" } });
}

/** Remove a member. `ifPresent`: someone already gone is not an error (the console runs an operation again when its chain moved). */
export async function removeMember(orgId: string, actor: Actor, userId: string, record?: Recorder, opts: { ifPresent?: boolean } = {}) {
  const db = forOrg(orgId);
  const m = await db.membership.findFirst({ where: { userId } });
  if (!m) {
    if (opts.ifPresent) return;
    throw new HttpError(404, "No such member.");
  }
  if (!canAssignRole(actor.role, m.role as Role, m.role as Role)) throw new HttpError(403, "Only an owner can remove an owner.");
  if (m.role === "owner" && m.status === "active" && (await activeOwners(orgId)) <= 1) throw new HttpError(409, "An organisation needs at least one owner.");
  await db.membership.delete({ where: { id: m.id } });
  await record?.("member.removed", {});
}
