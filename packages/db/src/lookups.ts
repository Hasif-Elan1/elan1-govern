import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";

// The few queries that must run before the org is known. Each one starts from a
// secret (a hashed key or token) or a signed-in user, never from user-supplied ids.

/** Agent API key -> key, agent and org. Revoked and expired keys never match. */
export function findApiKeyByHash(keyHash: string, client: PrismaClient = defaultClient) {
  return client.apiKey.findFirst({ where: { keyHash, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, include: { agent: true } });
}

export function findInviteByTokenHash(tokenHash: string, client: PrismaClient = defaultClient) {
  return client.invite.findFirst({ where: { tokenHash, acceptedAt: null, expiresAt: { gt: new Date() } } });
}

/** The orgs a signed-in user is an active member of (for the client switcher). Suspended memberships hold no role. */
export function membershipsForUser(userId: string, client: PrismaClient = defaultClient) {
  return client.membership.findMany({ where: { userId, status: "active" }, include: { org: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } });
}

/** Every membership a user holds, suspended ones included, with each org's level (GET /api/me reports them all). */
export function allMembershipsForUser(userId: string, client: PrismaClient = defaultClient) {
  return client.membership.findMany({ where: { userId }, include: { org: { select: { id: true, name: true, level: true } } }, orderBy: { createdAt: "asc" } });
}

/** Background jobs (expiry sweeper, hourly checkpoints) walk every org. */
export async function allOrgIds(client: PrismaClient = defaultClient): Promise<string[]> {
  return (await client.org.findMany({ select: { id: true } })).map((o) => o.id);
}

export function dueApprovals(now: Date, client: PrismaClient = defaultClient) {
  return client.approval.findMany({ where: { status: "pending", expiresAt: { lte: now } }, select: { id: true, orgId: true }, take: 200 });
}

/** Webhook deliveries that are due (or whose worker vanished mid-attempt), oldest first. */
export function dueWebhookDeliveries(now: Date, client: PrismaClient = defaultClient, take = 200) {
  return client.webhookDelivery.findMany({ where: { status: "pending", nextAttemptAt: { lte: now } }, select: { id: true, orgId: true }, orderBy: { nextAttemptAt: "asc" }, take });
}

/** `id` is only passed by the seed, which gives the console's demo organisations their fixed ids (org_demo …). */
export function createOrgRow(data: { id?: string; name: string; publicKey: string; privateKeyEnc: string; notifyEmail?: string }, client: PrismaClient = defaultClient) {
  return client.org.create({ data });
}

export function addMembership(data: { orgId: string; userId: string; role: "owner" | "admin" | "approver" | "viewer" | "auditor" }, client: PrismaClient = defaultClient) {
  return client.membership.upsert({ where: { userId_orgId: { userId: data.userId, orgId: data.orgId } }, create: data, update: { role: data.role } });
}

export function recordHealthAlert(data: { orgId?: string; kind: string; message: string }, client: PrismaClient = defaultClient) {
  return client.healthAlert.create({ data });
}

export function openHealthAlerts(client: PrismaClient = defaultClient) {
  return client.healthAlert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: "desc" }, take: 20 });
}

/** SSO before sign-in: the connection that has verified this email domain, if any. */
export function findSsoForDomain(domain: string, client: PrismaClient = defaultClient) {
  return client.ssoConnection.findFirst({ where: { verifiedDomains: { has: domain.toLowerCase() }, enabled: true } });
}

/** A domain belongs to the one organisation that verified it, for OIDC or SAML (unverified claims don't block anyone). */
export async function domainClaimedElsewhere(domain: string, orgId: string, client: PrismaClient = defaultClient) {
  const where = { verifiedDomains: { has: domain.toLowerCase() }, orgId: { not: orgId } };
  return (await client.ssoConnection.findFirst({ where, select: { id: true } })) ?? (await client.samlConnection.findFirst({ where, select: { id: true } }));
}

/**
 * Replay store retention, for every org at once: drop rows older than `before`, and any row of an
 * org that has the store switched off (a call in flight when it was switched off may have added one).
 */
export async function purgeReplayCalls(before: Date, client: PrismaClient = defaultClient): Promise<number> {
  const off = (await client.org.findMany({ where: { replayStore: false }, select: { id: true } })).map((o) => o.id);
  const r = await client.replayCall.deleteMany({ where: { OR: [{ ts: { lt: before } }, ...(off.length ? [{ orgId: { in: off } }] : [])] } });
  return r.count;
}

/** Inbound Slack and WhatsApp requests name their channel in the URL; that channel's own secret then verifies the request. */
export function findChatChannel(id: string, kind: string, client: PrismaClient = defaultClient) {
  return client.chatChannel.findFirst({ where: { id, kind, enabled: true } });
}

/** Chat messages that are due (or whose worker vanished mid-attempt), oldest first. */
export function dueChatMessages(now: Date, client: PrismaClient = defaultClient, take = 200) {
  return client.chatMessage.findMany({ where: { status: "pending", nextAttemptAt: { lte: now } }, select: { id: true, orgId: true }, orderBy: { nextAttemptAt: "asc" }, take });
}
