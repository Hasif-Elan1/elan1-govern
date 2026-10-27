import { DEFAULT_MINE_OPTIONS, evidenceGrewEnough, loadSignedRulebook, mineSuggestions, parseRulebookYaml, rulebookToYaml, type PastApproval, type Rulebook } from "@gate/core";
import { allOrgIds, forOrg } from "@gate/db";
import { chain } from "./chain";
import { resolveConnectorFor } from "./connectors";
import { orgKey, raiseAlert, type Deps } from "./deps";
import { registryFor } from "./registry";

/**
 * Rule suggestions learned from approvals. The miner is pure (core/suggest.ts); this file feeds it
 * each agent's resolved approvals, keeps the results in RuleSuggestion, and records a receipt when
 * a person applies or dismisses one. Nothing here changes a rulebook: applying a suggestion only
 * marks it applied, and the builder opens its drafted rulebook for a person to sign and publish.
 */

export interface RunResult {
  agents: number;
  created: number;
  updated: number;
  removed: number;
  open: number;
}

function usesVendorDomains(rb: Rulebook) {
  return rb.rules.some((r) => r.when?.to_domain_in === "vendor_domains" || r.unless?.to_domain_in === "vendor_domains");
}

/** Look for suggestions for every agent in one org (or one agent), and store them, deduped. */
export async function findSuggestions(deps: Deps, orgId: string, opts: { agentId?: string; now?: Date } = {}): Promise<RunResult> {
  const db = forOrg(orgId, deps.db);
  const now = opts.now ?? new Date();
  const result: RunResult = { agents: 0, created: 0, updated: 0, removed: 0, open: 0 };
  const agents = await db.agent.findMany({ where: { activeRulebookId: { not: null }, ...(opts.agentId ? { id: opts.agentId } : {}) } });
  if (!agents.length) return result;
  const registry = await registryFor(deps, orgId);
  const key = await orgKey(deps, orgId);

  for (const agent of agents) {
    const row = await db.rulebook.findFirst({ where: { id: agent.activeRulebookId as string } });
    if (!row) continue;
    // Only a rulebook whose signature checks out is worth drafting from.
    const loaded = loadSignedRulebook(row.yaml, key.publicKeyPem, registry);
    if (!loaded.ok) continue;
    const rb = loaded.rulebook;
    result.agents++;

    let lists: Record<string, string[]> | undefined;
    if (usesVendorDomains(rb)) {
      const spec = rb.rules.map((r) => (r.tool ? registry.get(r.tool) : undefined)).find((s) => s && (s.connector === "gmail" || s.connector === "zoho"));
      const conn = spec ? await resolveConnectorFor(deps, orgId, spec) : null;
      if (conn?.ok) lists = { vendor_domains: await conn.connector.vendorDomains(conn.ctx).catch(() => []) };
    }

    const since = new Date(now.getTime() - DEFAULT_MINE_OPTIONS.lookbackDays * 86_400_000);
    const rows = await db.approval.findMany({
      where: { agentId: agent.id, status: { in: ["approved", "rejected", "expired"] }, createdAt: { gte: since } },
      select: { id: true, tool: true, ruleId: true, status: true, argsSummary: true, createdAt: true, resolvedAt: true },
    });
    const approvals: PastApproval[] = rows.map((a) => ({ ...a, status: a.status as PastApproval["status"], summary: (a.argsSummary ?? {}) as Record<string, unknown> }));
    const found = mineSuggestions({ rulebook: rb, registry, approvals, now, tier: agent.riskTier, ...(lists ? { lists } : {}) });

    const existing = await db.ruleSuggestion.findMany({ where: { agentId: agent.id } });
    const touched = new Set<string>();
    for (const s of found) {
      const data = {
        ruleId: s.ruleId,
        tool: s.tool,
        title: s.title,
        proposal: s.proposal,
        confidence: s.confidence,
        explanation: s.explanation,
        evidence: s.evidence as object,
        savedPerMonth: s.savings.approvalsPerMonth,
        medianWaitSeconds: s.savings.medianWaitMs === null ? null : Math.round(s.savings.medianWaitMs / 1000),
        covered: s.evidence.covered,
        baseVersion: row.version,
        draftYaml: rulebookToYaml(s.rulebook),
      };
      const same = existing.find((e) => e.kind === s.kind && e.fingerprint === s.fingerprint);
      if (same) {
        touched.add(same.id);
        if (same.status === "applied") continue;
        if (same.status === "dismissed") {
          if (!evidenceGrewEnough(same.covered, s.evidence.covered)) continue;
          await db.ruleSuggestion.update({ where: { id: same.id }, data: { ...data, status: "new", decidedBy: null, decidedAt: null } });
        } else {
          await db.ruleSuggestion.update({ where: { id: same.id }, data });
        }
        result.updated++;
        continue;
      }
      // A different draft for the same rule and kind that someone already dismissed keeps it quiet,
      // until the evidence has grown a lot.
      const dismissed = existing.filter((e) => e.status === "dismissed" && e.ruleId === s.ruleId && e.tool === s.tool && e.kind === s.kind);
      if (dismissed.some((e) => !evidenceGrewEnough(e.covered, s.evidence.covered))) continue;
      const created = await db.ruleSuggestion.create({ data: { ...data, orgId, agentId: agent.id, kind: s.kind, fingerprint: s.fingerprint } });
      touched.add(created.id);
      result.created++;
    }
    // Open suggestions the evidence no longer supports (or that the rulebook has moved past) go away.
    const stale = existing.filter((e) => e.status === "new" && !touched.has(e.id)).map((e) => e.id);
    if (stale.length) result.removed += (await db.ruleSuggestion.deleteMany({ where: { id: { in: stale } } })).count;
  }
  result.open = await db.ruleSuggestion.count({ where: { status: "new", ...(opts.agentId ? { agentId: opts.agentId } : {}) } });
  return result;
}

/** The nightly run: every org. One org's failure never stops the others. */
export async function findAllSuggestions(deps: Deps, now = new Date()): Promise<number> {
  let open = 0;
  for (const orgId of await allOrgIds(deps.db)) {
    try {
      open += (await findSuggestions(deps, orgId, { now })).open;
    } catch (e) {
      await raiseAlert(deps, "suggestions-failed", (e as Error).message, orgId);
    }
  }
  return open;
}

export type DecideSuggestion = { ok: true; agent: string; id: string } | { ok: false; status: 404 | 409; error: string };

async function decideSuggestion(deps: Deps, orgId: string, id: string, actor: string, to: "applied" | "dismissed"): Promise<DecideSuggestion> {
  const db = forOrg(orgId, deps.db);
  const s = await db.ruleSuggestion.findFirst({ where: { id } });
  if (!s) return { ok: false, status: 404, error: "No such suggestion." };
  const agent = await db.agent.findFirst({ where: { id: s.agentId } });
  if (!agent) return { ok: false, status: 404, error: "No such suggestion." };
  // Opening an applied suggestion again is fine: it only loads the draft.
  if (to === "applied" && s.status === "applied") return { ok: true, agent: agent.slug, id };
  if (s.status !== "new") return { ok: false, status: 409, error: s.status === "dismissed" ? "This suggestion was dismissed." : "This suggestion was already opened as a draft." };
  if (to === "applied") {
    const latest = await db.rulebook.findFirst({ where: { agentId: agent.id }, orderBy: { version: "desc" }, select: { version: true } });
    if (latest?.version !== s.baseVersion) return { ok: false, status: 409, error: "The rulebook has changed since this was suggested. Look for suggestions again." };
    if (!parseRulebookYaml(s.draftYaml, await registryFor(deps, orgId)).ok) return { ok: false, status: 409, error: "This draft no longer fits the tools you have. Look for suggestions again." };
  }
  const done = await chain(deps, orgId, async (append, tx) => {
    const claimed = await tx.ruleSuggestion.updateMany({ where: { id, status: "new" }, data: { status: to, decidedBy: actor, decidedAt: new Date() } });
    if (claimed.count !== 1) return false;
    await append({
      kind: "admin",
      actor,
      action: to === "applied" ? "suggestion.applied" : "suggestion.dismissed",
      agent: agent.slug,
      details: { suggestion: id, kind: s.kind, rule: s.ruleId, tool: s.tool, base_version: s.baseVersion, approvals: s.covered },
    });
    return true;
  });
  return done ? { ok: true, agent: agent.slug, id } : { ok: false, status: 409, error: "Someone else already decided this." };
}

/** Mark a suggestion applied and record it. The draft still has to be signed and published by a person. */
export function applySuggestion(deps: Deps, orgId: string, id: string, actor: string) {
  return decideSuggestion(deps, orgId, id, actor, "applied");
}

export function dismissSuggestion(deps: Deps, orgId: string, id: string, actor: string) {
  return decideSuggestion(deps, orgId, id, actor, "dismissed");
}
