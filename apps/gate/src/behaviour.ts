import {
  BASELINE_DAYS,
  BehaviourSettingsSchema,
  COUNTERPARTY_FIELDS,
  COUNTERPARTY_GROUPS,
  MEMORY_DAYS,
  PILOT,
  amountOf,
  analyseAgent,
  checkEvent,
  counterpartiesOf,
  counterpartyKey,
  learningStatus,
  resolveSettings,
  type BehaviourEvent,
  type BehaviourSettings,
  type Finding,
  type Receipt,
} from "@gate/core";
import { allOrgIds, behaviourEvents, earlierAmounts, firstActivity, forOrg, Prisma, seenBefore, type EventRow } from "@gate/db";
import { background, chain } from "./chain";
import { raiseAlert, type Deps } from "./deps";
import { noticeEmail, ownersAndAdmins, sendAll } from "./notices";

/** Who receipts name when Elan1 Govern itself acts (an alert, an automatic pause). */
export const SYSTEM_ACTOR = "Elan1 Govern";

const HOUR = 3_600_000;
const DAY = 86_400_000;

const groupOf = (field: string) => COUNTERPARTY_GROUPS.find((g) => g.fields.includes(field))?.group ?? field;

function toEvent(r: { seq: number; ts: Date | string | number; tool: string; decision: string; summary?: Record<string, unknown> | null }): BehaviourEvent {
  return { seq: r.seq, ts: new Date(r.ts).getTime(), tool: r.tool, decision: r.decision as BehaviourEvent["decision"], summary: r.summary ?? {} };
}

export async function orgSettings(deps: Deps, orgId: string): Promise<{ settings: BehaviourSettings; timeZone: string }> {
  const org = await forOrg(orgId, deps.db).org.findFirstOrThrow({ select: { behaviourSettings: true, timezone: true } });
  return { settings: resolveSettings(org.behaviourSettings), timeZone: org.timezone };
}

// The first action never changes once it exists, so it is cached per process.
const firstSeen = new Map<string, number>();

async function firstActivityAt(deps: Deps, orgId: string, agent: string): Promise<number | null> {
  const k = `${orgId}|${agent}`;
  const cached = firstSeen.get(k);
  if (cached !== undefined) return cached;
  const first = await firstActivity(orgId, agent, deps.db);
  if (!first) return null;
  if (firstSeen.size > 10_000) firstSeen.clear();
  firstSeen.set(k, first.getTime());
  return first.getTime();
}

/** An agent's learning status, for the console. */
export async function agentLearning(deps: Deps, orgId: string, agent: string) {
  const { settings } = await orgSettings(deps, orgId);
  return learningStatus(await firstActivityAt(deps, orgId, agent), Date.now(), settings);
}

type AgentRow = { id: string; slug: string; name: string; status: string; autoPauseOnHigh: boolean };

export type RaiseResult = { created: true; id: string; autoPaused: boolean } | { created: false; id?: string };

/**
 * Stores a finding as an alert, unless one is already open for the same agent, detector and key
 * (then it is updated), or an earlier alert already covered the same receipts. A new alert and
 * its `alert.created` receipt are written in one transaction; with auto-pause on, a high alert
 * pauses the agent in the same transaction, with an `agent.paused` receipt naming the alert.
 */
export async function raiseBehaviourAlert(deps: Deps, orgId: string, agent: AgentRow, f: Finding): Promise<RaiseResult> {
  const db = forOrg(orgId, deps.db);
  const dedupeKey = `${agent.id}|${f.detector}|${f.key}`;
  const open = await db.behaviourAlert.findFirst({ where: { dedupeKey } });
  if (open) {
    const fresh = f.seqs.filter((s) => !open.seqs.includes(s));
    if (fresh.length) {
      await db.behaviourAlert.updateMany({ where: { id: open.id }, data: { occurrences: { increment: 1 }, lastSeenAt: new Date(), seqs: [...open.seqs, ...fresh].slice(-50), numbers: f.numbers } });
    }
    return { created: false, id: open.id };
  }
  if (f.seqs.length && (await db.behaviourAlert.findFirst({ where: { agentId: agent.id, detector: f.detector, key: f.key, seqs: { hasSome: f.seqs } }, select: { id: true } }))) {
    return { created: false };
  }
  try {
    const out = await chain(deps, orgId, async (append, tx) => {
      const row = await tx.behaviourAlert.create({
        data: { orgId, agentId: agent.id, agentSlug: agent.slug, detector: f.detector, key: f.key, dedupeKey, severity: f.severity, title: f.title, explanation: f.explanation, numbers: f.numbers, seqs: f.seqs },
      });
      const r = await append({
        kind: "admin",
        actor: SYSTEM_ACTOR,
        action: "alert.created",
        agent: agent.slug,
        details: { alert_id: row.id, detector: f.detector, severity: f.severity, title: f.title, explanation: f.explanation, receipts: f.seqs.join(",") },
      });
      let autoPaused = false;
      if (f.severity === "high" && agent.autoPauseOnHigh) {
        const current = await tx.agent.findFirst({ where: { id: agent.id }, select: { status: true } });
        if (current?.status === "active") {
          await tx.agent.update({ where: { id: agent.id }, data: { status: "paused" } });
          await append({ kind: "admin", actor: SYSTEM_ACTOR, action: "agent.paused", agent: agent.slug, details: { reason: "auto-pause", alert_id: row.id, alert: f.title, alert_seq: r.seq } });
          autoPaused = true;
        }
      }
      await tx.behaviourAlert.update({ where: { id: row.id }, data: { receiptSeq: r.seq, autoPaused } });
      return { id: row.id, autoPaused };
    });
    if (f.severity !== "low") background(deps, notifyAlert(deps, orgId, agent, f, out.id, out.autoPaused));
    return { created: true, ...out };
  } catch (e) {
    // Another check raised the same alert at the same moment: the unique dedupe key kept one.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { created: false };
    throw e;
  }
}

async function notifyAlert(deps: Deps, orgId: string, agent: AgentRow, f: Finding, id: string, autoPaused: boolean) {
  const recipients = await ownersAndAdmins(deps, orgId);
  const sev = f.severity === "high" ? "High" : "Medium";
  await sendAll(
    deps,
    recipients,
    (to) =>
      noticeEmail({
        to,
        kicker: `${sev.toLowerCase()} alert`,
        title: `${sev} alert for ${agent.name}: ${f.title}`,
        body: [f.explanation, ...(autoPaused ? [`${agent.name} was paused automatically, as its settings ask. Every call it makes is refused until someone resumes it.`] : [])],
        link: `${deps.env.WEB_URL}/alerts/${id}`,
        linkLabel: "Open the alert",
        urgent: f.severity === "high",
      }),
    "alert",
    orgId,
  );
}

/**
 * The cheap checks for receipts just written by the guard: a new tool, a new counterparty, an
 * outlying amount. Runs after the receipt commits, in the background, so it never slows or fails
 * the call; the decision itself has already been made.
 */
export async function inlineBehaviourCheck(deps: Deps, orgId: string, receipts: readonly Receipt[]): Promise<number> {
  const todo = receipts.filter((r) => r.kind === "decision" && r.agent && r.tool && r.decision && r.rule_id !== "agent-paused" && r.rule_id !== PILOT.ruleId);
  if (!todo.length) return 0;
  const { settings } = await orgSettings(deps, orgId);
  const db = forOrg(orgId, deps.db);
  let raised = 0;
  for (const r of todo) {
    const slug = r.agent as string;
    const at = Date.parse(r.ts);
    if (learningStatus(await firstActivityAt(deps, orgId, slug), at, settings).learning) continue;
    const agent = await db.agent.findFirst({ where: { slug }, select: { id: true, slug: true, name: true, status: true, autoPauseOnHigh: true } });
    if (!agent) continue;
    const e = toEvent({ seq: r.seq, ts: at, tool: r.tool as string, decision: r.decision as string, summary: r.args_summary });
    const cps = settings.newCounterparty.enabled ? counterpartiesOf(e.summary) : [];
    const seen = await seenBefore(
      orgId,
      slug,
      { since: new Date(at - MEMORY_DAYS * DAY), beforeSeq: r.seq, fields: cps.length ? COUNTERPARTY_FIELDS : [], tools: [e.tool], values: cps.map((c) => c.value.trim().toLowerCase()) },
      deps.db,
    );
    const amount = settings.amountOutlier.enabled ? amountOf(e.summary) : null;
    const amounts = amount ? await earlierAmounts(orgId, slug, { tool: e.tool, field: amount.field, since: new Date(at - BASELINE_DAYS * DAY), beforeSeq: r.seq }, deps.db) : [];
    const findings = checkEvent(e, {
      agent: slug,
      settings,
      seenTools: new Set(seen.tools),
      seenCounterparties: new Set(seen.pairs.map((p) => counterpartyKey(groupOf(p.field), p.value))),
      amounts,
    });
    for (const f of findings) if ((await raiseBehaviourAlert(deps, orgId, agent, f)).created) raised++;
  }
  return raised;
}

/** Every detector, for every active agent in one org that acted in the last hour. */
export async function scanOrg(deps: Deps, orgId: string, now = new Date()): Promise<{ agents: number; raised: number }> {
  const { settings, timeZone } = await orgSettings(deps, orgId);
  const db = forOrg(orgId, deps.db);
  const agents = await db.agent.findMany({ where: { status: "active" }, select: { id: true, slug: true, name: true, status: true, autoPauseOnHigh: true } });
  let scanned = 0;
  let raised = 0;
  for (const agent of agents) {
    const recent = await db.receipt.count({ where: { agent: agent.slug, kind: "decision", ts: { gte: new Date(now.getTime() - HOUR), lte: now } } });
    if (!recent) continue;
    scanned++;
    const rows: EventRow[] = await behaviourEvents(orgId, agent.slug, new Date(now.getTime() - BASELINE_DAYS * DAY), deps.db);
    const events = rows.filter((r) => r.ts.getTime() <= now.getTime()).map(toEvent);
    const before = events[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    const seen = await seenBefore(orgId, agent.slug, { since: new Date(now.getTime() - MEMORY_DAYS * DAY), beforeSeq: before, fields: COUNTERPARTY_FIELDS }, deps.db);
    const { findings } = analyseAgent(
      {
        agent: agent.slug,
        events,
        seenTools: seen.tools,
        seenCounterparties: seen.pairs.map((p) => counterpartyKey(groupOf(p.field), p.value)),
        firstActivityAt: await firstActivityAt(deps, orgId, agent.slug),
      },
      { now: now.getTime(), timeZone, settings },
    );
    for (const f of findings) if ((await raiseBehaviourAlert(deps, orgId, agent, f)).created) raised++;
  }
  return { agents: scanned, raised };
}

/** The 5-minute job: each org separately, so one org's failure never stops the others. */
export async function scanAll(deps: Deps): Promise<{ orgs: number; raised: number }> {
  let orgs = 0;
  let raised = 0;
  for (const orgId of await allOrgIds(deps.db)) {
    try {
      raised += (await scanOrg(deps, orgId)).raised;
      orgs++;
    } catch (e) {
      await raiseAlert(deps, "behaviour-scan-failed", (e as Error).message, orgId);
    }
  }
  return { orgs, raised };
}

// ---- People acting on alerts ----

export type AlertActionResult = { ok: true; status: string } | { ok: false; status: 404 | 409; error: string };

/** Acknowledge (open → acknowledged) or resolve (open or acknowledged → resolved), with a receipt. */
export async function actOnAlert(deps: Deps, orgId: string, id: string, action: "acknowledge" | "resolve", actor: string): Promise<AlertActionResult> {
  return chain(deps, orgId, async (append, tx) => {
    const a = await tx.behaviourAlert.findFirst({ where: { id } });
    if (!a) return { ok: false as const, status: 404 as const, error: "No such alert." };
    const allowed = action === "acknowledge" ? a.status === "open" : a.status !== "resolved";
    if (!allowed) return { ok: false as const, status: 409 as const, error: action === "acknowledge" ? "This alert is not open any more." : "This alert is already resolved." };
    const now = new Date();
    const data =
      action === "acknowledge"
        ? { status: "acknowledged", acknowledgedBy: actor, acknowledgedAt: now }
        : { status: "resolved", resolvedBy: actor, resolvedAt: now, dedupeKey: null, ...(a.acknowledgedAt ? {} : { acknowledgedBy: actor, acknowledgedAt: now }) };
    await tx.behaviourAlert.update({ where: { id }, data });
    await append({ kind: "admin", actor, action: action === "acknowledge" ? "alert.acknowledged" : "alert.resolved", agent: a.agentSlug, details: { alert_id: a.id, detector: a.detector, severity: a.severity, title: a.title } });
    return { ok: true as const, status: data.status };
  });
}

export async function setAutoPause(deps: Deps, orgId: string, agentId: string, on: boolean, actor: string) {
  return chain(deps, orgId, async (append, tx) => {
    const agent = await tx.agent.findFirst({ where: { id: agentId } });
    if (!agent) return null;
    await tx.agent.update({ where: { id: agentId }, data: { autoPauseOnHigh: on } });
    await append({ kind: "admin", actor, action: on ? "agent.auto_pause_on" : "agent.auto_pause_off", agent: agent.slug, details: {} });
    return { autoPauseOnHigh: on };
  });
}

/** Saves the org's thresholds (validated as a whole) with a receipt listing what changed. */
export async function updateBehaviourSettings(deps: Deps, orgId: string, input: unknown, actor: string) {
  const parsed = BehaviourSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Those settings are not valid." };
  const { settings: before } = await orgSettings(deps, orgId);
  const changed = (Object.keys(parsed.data) as (keyof BehaviourSettings)[]).filter((k) => JSON.stringify(parsed.data[k]) !== JSON.stringify(before[k]));
  await chain(deps, orgId, async (append, tx) => {
    await tx.org.update({ where: { id: orgId }, data: { behaviourSettings: parsed.data } });
    await append({ kind: "admin", actor, action: "alerts.settings_updated", details: { changed: changed.join(",") || "nothing", learning_days: parsed.data.learningDays } });
  });
  return { ok: true as const, settings: parsed.data };
}
