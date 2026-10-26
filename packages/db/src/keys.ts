import { keyFingerprint, type PublicKeyInfo } from "@gate/core";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";
import { forOrg } from "./tenant";

/**
 * Every public signing key the org has had, oldest first, with retirement times. Falls back to
 * the legacy Org.publicKey column for an org whose keys have not been copied to OrgKey yet.
 */
export async function orgPublicKeys(orgId: string, client: PrismaClient = defaultClient): Promise<(PublicKeyInfo & { kid: string; createdAt: string })[]> {
  const db = forOrg(orgId, client);
  const rows = await db.orgKey.findMany({ orderBy: { createdAt: "asc" }, select: { kid: true, publicKey: true, createdAt: true, retiredAt: true } });
  if (rows.length) {
    return rows.map((r) => ({ kid: r.kid, publicKeyPem: r.publicKey, createdAt: r.createdAt.toISOString(), retiredAt: r.retiredAt?.toISOString() ?? null }));
  }
  const org = await db.org.findFirstOrThrow({ select: { publicKey: true, createdAt: true } });
  return [{ kid: keyFingerprint(org.publicKey), publicKeyPem: org.publicKey, createdAt: org.createdAt.toISOString(), retiredAt: null }];
}

