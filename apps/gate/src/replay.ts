import {
  decrypt,
  describeAction,
  DECISIONS,
  encrypt,
  parseRulebookYaml,
  quotaTools,
  replayLookbackMs,
  replayRulebook,
  type Decision,
  type ReplayCall,
  type ReplayResult,
  type UsageEvent,
} from "@gate/core";
import { forOrg, purgeReplayCalls } from "@gate/db";
import { resolveConnectorFor } from "./connectors";
import type { Deps } from "./deps";
import { usesList } from "./guard";
import { registryFor } from "./registry";

// "Test this rulebook on past actions". The gate keeps each guarded call's validated arguments,
// encrypted, for 30 days (the replay store), and replays a draft rulebook over them on request.
// Arguments are decrypted only here, in memory, and never logged or returned.

export const REPLAY_RETENTION_DAYS = 30;
const DAY = 86_400_000;
/** At most this many past calls are replayed (the most recent). */
export const REPLAY_MAX_CALLS = 50_000;

/** Binds a stored row to its org and receipt: a ciphertext copied anywhere else does not decrypt. */
const replayAad = (orgId: string, seq: number) => `replay-args:${orgId}:${seq}`;

export interface StoredCall {
  agentId: string;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  decision: Decision;
  ruleId: string;
}

/** Keep one call for replay, if the org has the store on. Never throws: the guard's answer does not depend on it. */
export async function storeReplayCall(deps: Deps, orgId: string, call: StoredCall): Promise<boolean> {
  try {
    const db = forOrg(orgId, deps.db);
    const org = await db.org.findFirst({ select: { replayStore: true } });
    if (!org?.replayStore) return false;
    await db.replayCall.create({
      data: {
        orgId,
        agentId: call.agentId,
        seq: call.seq,
        tool: call.tool,
        decision: call.decision,
        ruleId: call.ruleId,
        argsEnc: encrypt(deps.env.GATE_MASTER_KEY, JSON.stringify(call.args), replayAad(orgId, call.seq)),
      },
    });
    return true;
  } catch (e) {
    // The error's code only: a database error message can quote the values it was given.
    deps.log.warn({ orgId, tool: call.tool, err: (e as { code?: string }).code ?? (e as Error).name }, "replay store write failed");
    return false;
  }
}

/** Retention: rows older than 30 days, and rows of orgs that switched the store off. */
export function purgeReplay(deps: Deps, now = new Date()): Promise<number> {
  return purgeReplayCalls(new Date(now.getTime() - REPLAY_RETENTION_DAYS * DAY), deps.db);
}

// Replays are expensive: a few per org per minute, on top of the web app's own limit.
const recent = new Map<string, number[]>();
export const REPLAY_RATE = { max: 6, windowMs: 60_000 };

export function replayAllowed(orgId: string, now = Date.now()): boolean {
  const hits = (recent.get(orgId) ?? []).filter((t) => t > now - REPLAY_RATE.windowMs);
  if (hits.length >= REPLAY_RATE.max) {
    recent.set(orgId, hits);
    return false;
  }
  hits.push(now);
  recent.set(orgId, hits);
  return true;
}

export function resetReplayRate() {
  recent.clear();
}

export interface ReplayChangeView {
  seq: number;
  at: string;
  tool: string;
  /** Plain words, from the receipt's minimal summary (never the stored arguments). */
  action: string;
  from: Decision;
  to: Decision;
  fromRule: string;
  rule: string;
  quotaId?: string;
  reason: string;
}

export type ReplayReport = Omit<ReplayResult, "changes"> & {
  days: number;
  since: string;
  /** The org keeps arguments for replay. When off, every call counts as could not be judged. */
  storeOn: boolean;
  /** More calls than REPLAY_MAX_CALLS: only the most recent were replayed. */
  limited: boolean;
  changes: ReplayChangeView[];
};

export type ReplayOutcome = { ok: true; report: ReplayReport } | { ok: false; status: 404 | 422; error: string; errors?: string[] };

type Body = { rule_id?: unknown; args_summary?: unknown; ref_seq?: unknown };
const summaryOf = (body: unknown): Record<string, unknown> => {
  const s = (body as Body | null)?.args_summary;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
};

/** What a draft rulebook would have decided for this agent's calls over the last `days` days. Nothing runs. */
export async function replayDraft(deps: Deps, orgId: string, agentId: string, yaml: string, days: number, now = new Date()): Promise<ReplayOutcome> {
  const db = forOrg(orgId, deps.db);
  const agent = await db.agent.findFirst({ where: { id: agentId }, select: { id: true, slug: true } });
  if (!agent) return { ok: false, status: 404, error: "No such agent." };
  const registry = await registryFor(deps, orgId);
  // A draft: unsigned is fine, nothing is executed or published.
  const parsed = parseRulebookYaml(yaml, registry);
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.errors[0] ?? "The rulebook has problems.", errors: parsed.errors };
  const rb = parsed.rulebook;
  const org = await db.org.findFirstOrThrow({ select: { timezone: true, replayStore: true } });
  const since = new Date(now.getTime() - days * DAY);

  const receipts = (
    await db.receipt.findMany({
      where: { kind: "decision", agent: agent.slug, ts: { gte: since, lte: now } },
      orderBy: { seq: "desc" },
      take: REPLAY_MAX_CALLS,
      select: { seq: true, ts: true, tool: true, decision: true, body: true },
    })
  ).reverse();
  const first = receipts[0]?.seq ?? 0;

  const args = new Map<number, Record<string, unknown>>();
  if (receipts.length) {
    const rows = await db.replayCall.findMany({ where: { agentId: agent.id, seq: { gte: first } }, select: { seq: true, argsEnc: true } });
    for (const row of rows) {
      try {
        args.set(row.seq, JSON.parse(decrypt(deps.env.GATE_MASTER_KEY, row.argsEnc, replayAad(orgId, row.seq))) as Record<string, unknown>);
      } catch {
        // Unreadable (tampered, or moved from another org): that call cannot be judged.
      }
    }
  }

  // Quota usage: what ran successfully in each quota's window. Calls being replayed are counted by
  // the replay itself; everything else (other agents, older calls, calls without stored arguments)
  // counts as its receipt recorded it.
  const ran = new Set<number>();
  const usage: UsageEvent[] = [];
  const tools = quotaTools(rb, registry);
  if (tools.length && receipts.length) {
    const replayed = new Set(receipts.filter((r) => args.has(r.seq)).map((r) => r.seq));
    const ok = await db.receipt.findMany({
      where: { outcome: "ok", tool: { in: tools }, ts: { gte: new Date(since.getTime() - replayLookbackMs(rb)), lte: now } },
      orderBy: { seq: "asc" },
      select: { seq: true, ts: true, tool: true, body: true },
    });
    for (const r of ok) {
      const refSeq = (r.body as Body | null)?.ref_seq;
      const ref = typeof refSeq === "number" ? refSeq : r.seq;
      if (replayed.has(ref)) ran.add(ref);
      else usage.push({ ts: r.ts.getTime(), tool: r.tool ?? "", values: summaryOf(r.body) });
    }
  }

  // Lists Elan1 Govern fills in at decision time, per tool, from its connector.
  const lists = new Map<string, Record<string, string[]>>();
  for (const tool of new Set(receipts.filter((r) => args.has(r.seq)).map((r) => r.tool ?? ""))) {
    const spec = registry.get(tool);
    if (!spec || !usesList(rb, tool, "vendor_domains")) continue;
    const conn = await resolveConnectorFor(deps, orgId, spec);
    if (conn.ok) lists.set(tool, { vendor_domains: await conn.connector.vendorDomains(conn.ctx).catch(() => []) });
  }

  const calls: ReplayCall[] = receipts.map((r) => {
    const decision = (DECISIONS as readonly string[]).includes(r.decision ?? "") ? (r.decision as Decision) : "refuse";
    const ruleId = (r.body as Body | null)?.rule_id;
    const a = args.get(r.seq);
    return { seq: r.seq, ts: r.ts.getTime(), tool: r.tool ?? "", ...(a ? { args: a } : {}), original: { decision, ruleId: typeof ruleId === "string" ? ruleId : "default" }, ran: ran.has(r.seq) };
  });
  const result = replayRulebook({ rulebook: rb, calls, usage, timeZone: org.timezone, registry, lists: (tool) => lists.get(tool) });

  const bySeq = new Map(receipts.map((r) => [r.seq, r]));
  const changes = result.changes.map((c): ReplayChangeView => ({
    seq: c.seq,
    at: new Date(c.ts).toISOString(),
    tool: c.tool,
    action: describeAction(c.tool, summaryOf(bySeq.get(c.seq)?.body)),
    from: c.from,
    to: c.to,
    fromRule: c.fromRule,
    rule: c.rule,
    ...(c.quotaId ? { quotaId: c.quotaId } : {}),
    reason: c.reason,
  }));
  return { ok: true, report: { ...result, days, since: since.toISOString(), storeOn: org.replayStore, limited: receipts.length === REPLAY_MAX_CALLS, changes } };
}
