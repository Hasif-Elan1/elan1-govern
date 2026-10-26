import "server-only";
import { describeAction, keyFingerprint, verifyChain, type Receipt } from "@gate/core";
import { forOrg, startOfDayIST, toCheckpoint } from "@gate/db";
import type { ApprovalView } from "@/components/approval-card";
import type { DecisionKind } from "@/components/ui/status";

export interface ReceiptView {
  seq: number;
  ts: string;
  kind: Receipt["kind"];
  status: DecisionKind;
  title: string;
  agent?: string;
  tool?: string;
  ruleId?: string;
  reason?: string;
  hash: string;
  approvalId?: string;
  by?: string;
  selfApproval?: boolean;
  outcome?: Receipt["outcome"];
  actor?: string;
  refSeq?: number;
}

const CONNECTOR_NAME: Record<string, string> = { gmail: "Gmail", zoho: "Zoho Books" };

export function adminTitle(r: Receipt): string {
  const d = (r.details ?? {}) as Record<string, unknown>;
  const agent = r.agent ? ` for ${r.agent}` : "";
  switch (r.action) {
    case "org.created":
      return `Created the organisation ${String(d.name ?? "")}`.trim();
    case "agent.created":
      return `Added the agent ${r.agent ?? ""}`;
    case "agent.paused":
      return `Paused ${r.agent ?? "an agent"}`;
    case "agent.resumed":
      return `Resumed ${r.agent ?? "an agent"}`;
    case "rulebook.signed":
      return `Signed and published rulebook v${r.rulebook?.version ?? "?"}${agent}`;
    case "key.created":
      return `Created an API key${agent}`;
    case "key.revoked":
      return `Revoked an API key${agent}`;
    case "connector.connected":
      return `Connected ${CONNECTOR_NAME[String(d.connector)] ?? "a connector"}${d.mode === "mock" ? " with demo data" : ""}`;
    case "connector.disconnected":
      return `Disconnected ${CONNECTOR_NAME[String(d.connector)] ?? "a connector"}`;
    case "evidence.exported":
      return `Downloaded evidence for ${String(d.from)} to ${String(d.to)}`;
    case "member.invited":
      return `Invited someone as ${String(d.role ?? "a member")}`;
    case "member.joined":
      return `A new member joined as ${String(d.role ?? "a member")}`;
    case "member.role_changed":
      return `Changed a member's role to ${String(d.role ?? "?")}`;
    case "member.removed":
      return "Removed a member";
    case "settings.updated":
      return "Changed organisation settings";
    case "user.2fa_enabled":
      return "Turned on two-step sign-in";
    case "user.2fa_disabled":
      return "Turned off two-step sign-in";
    default:
      return r.action ?? "Setup change";
  }
}

export function toView(r: Receipt): ReceiptView {
  let status: DecisionKind;
  if (r.kind === "admin") status = "admin";
  else if (r.kind === "outcome") status = r.outcome?.status === "error" ? "error" : "outcome";
  else if (r.kind === "approval") status = (r.approval?.result as DecisionKind) ?? "pending";
  else if (r.decision === "allow" && r.outcome?.status === "error") status = "error";
  else status = (r.decision as DecisionKind) ?? "admin";

  const title =
    r.kind === "admin"
      ? adminTitle(r)
      : r.kind === "outcome"
        ? `Reported: ${describeAction(r.tool ?? "", r.args_summary ?? {})}`
        : describeAction(r.tool ?? "", r.args_summary ?? {});
  return {
    seq: r.seq,
    ts: r.ts,
    kind: r.kind,
    status,
    title,
    agent: r.agent,
    tool: r.tool,
    ruleId: r.rule_id,
    reason: r.reason,
    hash: r.hash,
    approvalId: r.approval?.id,
    by: r.approval?.by,
    selfApproval: r.approval?.self_approval,
    outcome: r.outcome,
    actor: r.actor,
    refSeq: r.ref_seq,
  };
}

export async function chainStatus(orgId: string) {
  const db = forOrg(orgId);
  const [org, rows, cps] = await Promise.all([
    db.org.findFirstOrThrow({ select: { publicKey: true } }),
    db.receipt.findMany({ orderBy: { seq: "asc" }, select: { body: true } }),
    db.checkpoint.findMany({ orderBy: { seq: "asc" } }),
  ]);
  const r = verifyChain(
    rows.map((x) => x.body as unknown as Receipt),
    org.publicKey,
    { checkpoints: cps.map(toCheckpoint) },
  );
  return { ...r, fingerprint: keyFingerprint(org.publicKey), lastCheckpoint: cps.at(-1) ?? null };
}

export async function todayStats(orgId: string) {
  const db = forOrg(orgId);
  const since = startOfDayIST();
  const groups = await db.receipt.groupBy({ by: ["decision"], where: { kind: "decision", ts: { gte: since } }, _count: true });
  const n = (d: string) => groups.find((g) => g.decision === d)?._count ?? 0;
  const waiting = await db.approval.count({ where: { status: "pending", expiresAt: { gt: new Date() } } });
  return { total: n("allow") + n("ask") + n("refuse"), allowed: n("allow"), asked: n("ask"), refused: n("refuse"), waiting };
}

export interface ActivityFilter {
  agent?: string;
  decision?: string;
  tool?: string;
  from?: string;
  to?: string;
  q?: string;
  after?: number;
  limit?: number;
}

export async function activity(orgId: string, f: ActivityFilter = {}): Promise<ReceiptView[]> {
  const db = forOrg(orgId);
  const where: Record<string, unknown> = {};
  if (f.agent) where.agent = f.agent;
  if (f.tool) where.tool = f.tool;
  if (f.after) where.seq = { gt: f.after };
  if (f.decision === "allow" || f.decision === "refuse" || f.decision === "ask") where.decision = f.decision;
  if (f.decision === "admin") where.kind = "admin";
  const ts: Record<string, Date> = {};
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) ts.gte = startOfDayIST(new Date(`${f.from}T12:00:00+05:30`));
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) ts.lte = new Date(startOfDayIST(new Date(`${f.to}T12:00:00+05:30`)).getTime() + 86_400_000 - 1);
  if (Object.keys(ts).length) where.ts = ts;
  const rows = await db.receipt.findMany({ where, orderBy: { seq: "desc" }, take: f.q ? 1000 : Math.min(f.limit ?? 200, 500), select: { body: true } });
  let views = rows.map((r) => toView(r.body as unknown as Receipt));
  if (f.q) {
    const q = f.q.toLowerCase();
    views = views.filter((v) => [v.title, v.ruleId, v.agent, v.tool, v.reason, v.by, v.actor, v.outcome?.ref, v.approvalId, String(v.seq)].some((s) => s?.toLowerCase().includes(q))).slice(0, f.limit ?? 200);
  }
  return views;
}

export async function receiptBySeq(orgId: string, seq: number) {
  const row = await forOrg(orgId).receipt.findFirst({ where: { seq } });
  return row ? (row.body as unknown as Receipt) : null;
}

// ---- Approvals ----


type ApprovalRow = Awaited<ReturnType<ReturnType<typeof forOrg>["approval"]["findFirstOrThrow"]>>;

export async function approvalViews(orgId: string, rows: ApprovalRow[], userId: string): Promise<ApprovalView[]> {
  const agents = await forOrg(orgId).agent.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.agentId))] } } });
  return rows.map((a) => {
    const agent = agents.find((x) => x.id === a.agentId);
    const summary = a.argsSummary as Record<string, unknown>;
    const result = (a.result ?? null) as { status?: string; ref?: string; error?: string } | null;
    return {
      id: a.id,
      agentName: agent?.name ?? "Agent",
      agentSlug: agent?.slug ?? "",
      action: describeAction(a.tool, summary),
      ruleId: a.ruleId,
      reason: a.reason,
      status: a.status === "pending" && a.expiresAt <= new Date() ? "expired" : a.status,
      expiresAt: a.expiresAt.toISOString(),
      createdAt: a.createdAt.toISOString(),
      approvers: a.approvers,
      resolvedBy: a.resolvedBy,
      resolvedAt: a.resolvedAt?.toISOString() ?? null,
      note: a.note,
      selfApproval: a.selfApproval,
      setUpByYou: agent?.createdById === userId,
      outcome: result ? { status: result.status, ref: result.ref, error: result.error } : null,
      evidence: (a.evidence ?? {}) as ApprovalView["evidence"],
      amount: typeof summary.amount_inr === "number" ? summary.amount_inr : undefined,
    };
  });
}
