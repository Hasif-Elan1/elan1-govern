import { isFrameworkId, type EvidenceKey } from "@gate/core/frameworks";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";
import { forOrg } from "./tenant";

/**
 * Live evidence counts per evidence key, from real receipts on the org's chain.
 *
 * Inventory and assessments are counted from their receipts (`system.created`,
 * `assessment.approved`), not their tables, so this works whether or not those
 * features are installed.
 */
export async function evidenceCounts(orgId: string, range?: { from: Date; to: Date }, client: PrismaClient = defaultClient): Promise<Record<EvidenceKey, number>> {
  const db = forOrg(orgId, client);
  const ts = range ? { ts: { gte: range.from, lte: range.to } } : {};
  const count = (where: object) => db.receipt.count({ where: { ...ts, ...where } });
  const [decisions, defaultRefusals, approvals, selfApprovals, receipts, rulebooks, kill, agents, connectors, settings, members, systems, assessments] = await Promise.all([
    count({ kind: "decision" }),
    count({ kind: "decision", decision: "refuse" }),
    count({ kind: "approval" }),
    count({ kind: "approval", body: { path: ["approval", "self_approval"], equals: true } }),
    count({}),
    count({ action: "rulebook.signed" }),
    count({ action: { in: ["agent.paused", "agent.resumed"] } }),
    count({ action: "agent.created" }),
    count({ action: { in: ["connector.connected", "connector.disconnected"] } }),
    count({ action: "settings.updated" }),
    count({ action: { in: ["member.invited", "member.joined", "member.role_changed", "member.removed"] } }),
    count({ action: "system.created" }),
    count({ action: "assessment.approved" }),
  ]);
  return {
    decisions,
    default_refusals: defaultRefusals,
    approvals,
    self_approvals: selfApprovals,
    receipts,
    rulebooks,
    kill_switch: kill,
    agents,
    connectors,
    settings,
    member_changes: members,
    systems,
    approved_assessments: assessments,
  };
}

/** The frameworks an org has switched on, in the order they were enabled. Unknown ids are skipped. */
export async function enabledFrameworks(orgId: string, client: PrismaClient = defaultClient) {
  const rows = await forOrg(orgId, client).orgFramework.findMany({ orderBy: { enabledAt: "asc" } });
  return rows.filter((r) => isFrameworkId(r.frameworkId));
}

/** Switch frameworks on. Returns the ids that were newly enabled. */
export async function enableFrameworks(orgId: string, frameworkIds: readonly string[], enabledBy: string, client: PrismaClient = defaultClient): Promise<string[]> {
  const db = forOrg(orgId, client);
  const ids = [...new Set(frameworkIds)].filter(isFrameworkId);
  const existing = new Set((await db.orgFramework.findMany({ where: { frameworkId: { in: ids } } })).map((r) => r.frameworkId));
  const added = ids.filter((id) => !existing.has(id));
  if (added.length) await db.orgFramework.createMany({ data: added.map((frameworkId) => ({ orgId, frameworkId, enabledBy })), skipDuplicates: true });
  return added;
}

/** Switch one framework off. Returns whether it was on. */
export async function disableFramework(orgId: string, frameworkId: string, client: PrismaClient = defaultClient): Promise<boolean> {
  return (await forOrg(orgId, client).orgFramework.deleteMany({ where: { frameworkId } })).count > 0;
}
