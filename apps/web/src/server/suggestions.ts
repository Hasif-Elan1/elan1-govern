import "server-only";
import { diffLines, type DiffLine, type SuggestionEvidence } from "@gate/core";
import { forOrg } from "@gate/db";

export interface SuggestionView {
  id: string;
  agentSlug: string;
  agentName: string;
  kind: string;
  title: string;
  proposal: string;
  confidence: "high" | "medium";
  explanation: string;
  evidence: SuggestionEvidence;
  savedPerMonth: number;
  medianWait: string | null;
  baseVersion: number;
  /** The YAML change against the version it was drafted from, with a little context. */
  diff: (DiffLine | { type: "gap"; text: string })[];
  createdAt: string;
}

/** "about 3 hours", "about 25 minutes", "about 2 days". */
export function waitWords(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${Math.max(1, m)} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(seconds / 3600);
  if (h < 48) return `about ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(seconds / 86_400);
  return `about ${d} days`;
}

/** Only changed lines plus `context` lines around them; skipped runs become one "gap" line. */
export function compactDiff(lines: DiffLine[], context = 2): SuggestionView["diff"] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.type === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: SuggestionView["diff"] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.at(-1)?.type !== "gap") out.push({ type: "gap", text: "…" });
  });
  return out;
}

/** Stored rulebooks are written by rulebookToYaml with the signature last, like drafts without it. */
const unsigned = (yaml: string) => yaml.replace(/^signature:.*$/m, "").trimEnd();

/** Open suggestions, newest evidence first, optionally for one agent. */
export async function openSuggestions(orgId: string, agentSlug?: string): Promise<SuggestionView[]> {
  const db = forOrg(orgId);
  const agents = await db.agent.findMany({ where: agentSlug ? { slug: agentSlug } : {}, select: { id: true, slug: true, name: true } });
  if (!agents.length) return [];
  const rows = await db.ruleSuggestion.findMany({ where: { status: "new", agentId: { in: agents.map((a) => a.id) } }, orderBy: [{ savedPerMonth: "desc" }, { createdAt: "asc" }] });
  if (!rows.length) return [];
  const books = await db.rulebook.findMany({ where: { OR: rows.map((r) => ({ agentId: r.agentId, version: r.baseVersion })) }, select: { agentId: true, version: true, yaml: true } });
  return rows.map((r) => {
    const agent = agents.find((a) => a.id === r.agentId)!;
    const base = books.find((b) => b.agentId === r.agentId && b.version === r.baseVersion);
    return {
      id: r.id,
      agentSlug: agent.slug,
      agentName: agent.name,
      kind: r.kind,
      title: r.title,
      proposal: r.proposal,
      confidence: r.confidence === "high" ? "high" : "medium",
      explanation: r.explanation,
      evidence: r.evidence as unknown as SuggestionEvidence,
      savedPerMonth: r.savedPerMonth,
      medianWait: waitWords(r.medianWaitSeconds),
      baseVersion: r.baseVersion,
      diff: compactDiff(diffLines(base ? unsigned(base.yaml) : "", r.draftYaml.trimEnd())),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** For the Today page: how many open suggestions, and the approvals a month they could save. */
export async function suggestionTotals(orgId: string): Promise<{ count: number; perMonth: number }> {
  const agg = await forOrg(orgId).ruleSuggestion.aggregate({ where: { status: "new" }, _count: { _all: true }, _sum: { savedPerMonth: true } });
  return { count: agg._count._all, perMonth: agg._sum.savedPerMonth ?? 0 };
}

/** "2 rule suggestions could save about 40 approvals a month." */
export function totalsLine(t: { count: number; perMonth: number }): string | null {
  if (!t.count) return null;
  return `${t.count === 1 ? "1 rule suggestion" : `${t.count} rule suggestions`} could save about ${t.perMonth} approval${t.perMonth === 1 ? "" : "s"} a month.`;
}

/**
 * The drafted rulebook a suggestion opens in the builder: only once it has been opened as a draft
 * (applied), for the same agent, and only while the rulebook is still the version it was drafted from.
 */
export async function suggestionDraft(orgId: string, agentSlug: string, id: string): Promise<{ yaml: string; title: string } | null> {
  const db = forOrg(orgId);
  const agent = await db.agent.findFirst({ where: { slug: agentSlug }, select: { id: true } });
  if (!agent) return null;
  const s = await db.ruleSuggestion.findFirst({ where: { id, agentId: agent.id, status: "applied" } });
  if (!s) return null;
  const latest = await db.rulebook.findFirst({ where: { agentId: agent.id }, orderBy: { version: "desc" }, select: { version: true } });
  if (latest?.version !== s.baseVersion) return null;
  return { yaml: s.draftYaml, title: s.title };
}
