import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";

// The few queries that must run before the org is known. Each one starts from a
// secret (a hashed key or token) or a signed-in user, never from user-supplied ids.

/** Agent API key -> key, agent and org. Revoked keys never match. */
export function findApiKeyByHash(keyHash: string, client: PrismaClient = defaultClient) {
  return client.apiKey.findFirst({ where: { keyHash, revokedAt: null }, include: { agent: true } });
}

export function findInviteByTokenHash(tokenHash: string, client: PrismaClient = defaultClient) {
  return client.invite.findFirst({ where: { tokenHash, acceptedAt: null, expiresAt: { gt: new Date() } } });
}

/** The orgs a signed-in user belongs to (for the client switcher). */
export function membershipsForUser(userId: string, client: PrismaClient = defaultClient) {
  return client.membership.findMany({ where: { userId }, include: { org: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } });
}

/** Background jobs (expiry sweeper, hourly checkpoints) walk every org. */
export async function allOrgIds(client: PrismaClient = defaultClient): Promise<string[]> {
  return (await client.org.findMany({ select: { id: true } })).map((o) => o.id);
}

export function dueApprovals(now: Date, client: PrismaClient = defaultClient) {
  return client.approval.findMany({ where: { status: "pending", expiresAt: { lte: now } }, select: { id: true, orgId: true }, take: 200 });
}

export function createOrgRow(data: { name: string; publicKey: string; privateKeyEnc: string; notifyEmail?: string }, client: PrismaClient = defaultClient) {
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

/** A domain belongs to the one organisation that verified it (unverified claims don't block anyone). */
export function domainClaimedElsewhere(domain: string, orgId: string, client: PrismaClient = defaultClient) {
  return client.ssoConnection.findFirst({ where: { verifiedDomains: { has: domain.toLowerCase() }, orgId: { not: orgId } }, select: { id: true } });
}
