import "server-only";
import { DETECTOR_LABELS, learningStatus, resolveSettings, SEVERITIES, type Detector, type LearningStatus, type Severity } from "@gate/core";
import { firstActivity, forOrg } from "@gate/db";

export interface AlertView {
  id: string;
  agentId: string;
  agentSlug: string;
  detector: Detector;
  detectorLabel: string;
  key: string;
  severity: Severity;
  status: "open" | "acknowledged" | "resolved";
  title: string;
  explanation: string;
  numbers: Record<string, number | string>;
  seqs: number[];
  receiptSeq: number | null;
  occurrences: number;
  autoPaused: boolean;
  createdAt: string;
  lastSeenAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

type Row = Awaited<ReturnType<ReturnType<typeof forOrg>["behaviourAlert"]["findFirstOrThrow"]>>;

export function toAlertView(a: Row): AlertView {
  return {
    id: a.id,
    agentId: a.agentId,
    agentSlug: a.agentSlug,
    detector: a.detector as Detector,
    detectorLabel: DETECTOR_LABELS[a.detector as Detector] ?? a.detector,
    key: a.key,
    severity: (SEVERITIES as readonly string[]).includes(a.severity) ? (a.severity as Severity) : "low",
    status: a.status as AlertView["status"],
    title: a.title,
    explanation: a.explanation,
    numbers: (a.numbers ?? {}) as Record<string, number | string>,
    seqs: a.seqs,
    receiptSeq: a.receiptSeq,
    occurrences: a.occurrences,
    autoPaused: a.autoPaused,
    createdAt: a.createdAt.toISOString(),
    lastSeenAt: a.lastSeenAt.toISOString(),
    acknowledgedBy: a.acknowledgedBy,
    acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
    resolvedBy: a.resolvedBy,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  };
}

export interface AlertFilter {
  /** "open" (open or acknowledged, the default) or "all". */
  show?: string;
  severity?: string;
  agent?: string;
}

/** Cleans filter values from the query string. */
export function alertFilter(sp: Record<string, string | undefined>): Required<Pick<AlertFilter, "show">> & AlertFilter {
  return {
    show: sp.show === "all" ? "all" : "open",
    severity: (SEVERITIES as readonly string[]).includes(sp.severity ?? "") ? sp.severity : undefined,
    agent: sp.agent && /^[a-z0-9][a-z0-9-]{0,62}$/.test(sp.agent) ? sp.agent : undefined,
  };
}

export async function alertList(orgId: string, f: AlertFilter = {}, take = 200): Promise<AlertView[]> {
  const where: Record<string, unknown> = {};
  if (f.show !== "all") where.status = { in: ["open", "acknowledged"] };
  if (f.severity) where.severity = f.severity;
  if (f.agent) where.agentSlug = f.agent;
  const rows = await forOrg(orgId).behaviourAlert.findMany({ where, orderBy: { createdAt: "desc" }, take });
  // Most severe first among the unresolved, newest first within that.
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return rows.map(toAlertView).sort((a, b) => (f.show === "all" ? 0 : (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)) || b.createdAt.localeCompare(a.createdAt));
}

export async function alertById(orgId: string, id: string): Promise<AlertView | null> {
  const row = await forOrg(orgId).behaviourAlert.findFirst({ where: { id } });
  return row ? toAlertView(row) : null;
}

/** Counts of unresolved alerts by severity. */
export async function openAlertCounts(orgId: string): Promise<{ total: number; high: number; medium: number; low: number }> {
  const groups = await forOrg(orgId).behaviourAlert.groupBy({ by: ["severity"], where: { status: { in: ["open", "acknowledged"] } }, _count: true });
  const n = (s: string) => groups.find((g) => g.severity === s)?._count ?? 0;
  return { total: n("high") + n("medium") + n("low"), high: n("high"), medium: n("medium"), low: n("low") };
}

export async function openIncident(orgId: string) {
  return forOrg(orgId).incident.findFirst({ where: { status: "open" }, orderBy: { startedAt: "desc" } });
}

export async function orgBehaviourSettings(orgId: string) {
  const org = await forOrg(orgId).org.findFirstOrThrow({ select: { behaviourSettings: true, timezone: true } });
  return { settings: resolveSettings(org.behaviourSettings), timeZone: org.timezone };
}

/** The agent page's behaviour section: learning status and recent alerts. */
export async function agentBehaviour(orgId: string, agent: { id: string; slug: string }): Promise<{ learning: LearningStatus; recent: AlertView[]; open: number }> {
  const [{ settings }, first, rows, open] = await Promise.all([
    orgBehaviourSettings(orgId),
    firstActivity(orgId, agent.slug),
    forOrg(orgId).behaviourAlert.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: "desc" }, take: 5 }),
    forOrg(orgId).behaviourAlert.count({ where: { agentId: agent.id, status: { in: ["open", "acknowledged"] } } }),
  ]);
  return { learning: learningStatus(first?.getTime() ?? null, Date.now(), settings), recent: rows.map(toAlertView), open };
}
