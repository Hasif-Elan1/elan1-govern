import { randomInt } from "node:crypto";
import type { Connector } from "@gate/connectors";
import { isKnownTool, type DecisionResult, type ToolRegistry } from "@gate/core";
import { consoleState, forOrg } from "@gate/db";
import { raiseAlert, type Deps } from "./deps";
import { registryFor } from "./registry";

// The guard's side of the console link that runs on every call (see console-sync.ts for the configuration):
//  - a held call is routed to the console's approver group as it is now;
//  - a tool on a console demo connector is answered by the guard itself;
//  - every approval the guard holds, decides or expires is written into the console's organisation document,
//    in the console's own Approval shape, so the Approvals screens show it and decide it.

/** The people a held call goes to: the console group the rule names, with its members now (not when it was signed). */
export async function routeToConsoleGroup(deps: Deps, orgId: string, d: DecisionResult): Promise<DecisionResult> {
  if (d.decision !== "ask" || !d.approverGroup) return d;
  const group = await forOrg(orgId, deps.db).consoleApproverGroup.findFirst({ where: { slug: d.approverGroup } });
  return group ? { ...d, approvers: group.emails } : d;
}

/**
 * The tools a console agent can ask for: the console's own. The built-in Gmail and Zoho Books tools are not in
 * the console's catalogue, so for its agents they are unknown and refused (as the console refuses them).
 */
export function consoleScopedRegistry(agent: { consoleId: string | null }, registry: ToolRegistry): ToolRegistry {
  if (!agent.consoleId) return registry;
  return { get: (n) => (isKnownTool(n) ? undefined : registry.get(n)), list: () => registry.list().filter((s) => !isKnownTool(s.name)) };
}

interface ServerRow {
  slug: string;
  url: string;
  consoleId: string | null;
}

/**
 * A console connector the guard answers for: a demo connector (its address is console://…), or any console
 * connector while CONNECTOR_MODE=mock. Nothing is sent anywhere; the result says so. Null for other servers.
 */
export function consoleConnectorFor(deps: Deps, server: ServerRow): Connector | null {
  if (!server.consoleId || (!server.url.startsWith("console://") && deps.env.CONNECTOR_MODE !== "mock")) return null;
  return {
    kind: "upstream",
    call: async (tool) => ({
      data: { ok: true, demo: true, tool, message: "Demo connector: Elan1 Govern recorded the call. Nothing was sent anywhere." },
      ref: `${server.slug}-demo-${randomInt(100000, 1000000)}`,
    }),
    describe: async () => ({}),
    evidence: async () => ({}),
    vendorDomains: async () => [],
  };
}

// ---- Approvals into the console document ----

type Json = Record<string, unknown>;
const H = 3_600_000;

/** The console's Approval for a real one (apps/console/src/types.ts Approval), or the fields to update on it. */
async function consoleApproval(deps: Deps, orgId: string, approvalId: string): Promise<{ full: Json; status: Json } | null> {
  const db = forOrg(orgId, deps.db);
  const a = await db.approval.findFirst({ where: { id: approvalId } });
  if (!a) return null;
  const agent = await db.agent.findFirst({ where: { id: a.agentId } });
  if (!agent?.consoleId) return null; // an agent the console does not know
  const summary = (a.argsSummary ?? {}) as Record<string, unknown>;
  const args = Object.fromEntries(Object.entries(summary).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)));
  const spec = (await registryFor(deps, orgId)).get(a.tool);
  const server = await db.upstreamServer.findFirst({ where: { slug: a.tool.split(".")[0] } });
  const group = await db.consoleApproverGroup.findFirst({ where: { slug: a.approverGroup } });
  const people = await db.membership.findMany({ include: { user: { select: { id: true, email: true } } } });
  const idOf = (email: string | null) => (email ? (people.find((m) => m.user.email.toLowerCase() === email.toLowerCase())?.user.id ?? email) : undefined);
  const decided = a.status === "pending" ? undefined : await db.receipt.findFirst({ where: { kind: "approval", body: { path: ["ref_seq"], equals: a.heldSeq } }, orderBy: { seq: "desc" }, select: { seq: true } });
  const result = (a.result ?? undefined) as { status?: string } | undefined;
  const status = a.status === "approved" && result?.status && result.status !== "ok" && result.status !== "not_run" ? "approved_run_failed" : a.status;
  const past = await db.approval.groupBy({ by: ["status"], where: { agentId: a.agentId, ruleId: a.ruleId, id: { not: a.id } }, _count: true });
  const count = (s: string) => past.find((p) => p.status === s)?._count ?? 0;
  const amount = [summary.amount, summary.amount_inr].find((v): v is number => typeof v === "number");
  const counterparty = [summary.vendor, summary.counterparty, summary.to_domain, summary.customer].find((v): v is string => typeof v === "string");
  const what = [amount !== undefined ? `amount ${amount.toLocaleString("en-IN")}` : "", counterparty ? `for ${counterparty}` : ""].filter(Boolean).join(" ");

  const statusFields: Json = {
    status,
    ...(a.resolvedAt ? { decidedAt: a.resolvedAt.toISOString() } : {}),
    ...(a.resolvedBy ? { decidedBy: idOf(a.resolvedBy) } : {}),
    ...(a.channel ? { channel: a.channel } : {}),
    ...(a.note ? { decisionReason: a.note } : a.status === "expired" ? { decisionReason: "No one decided within the expiry. Expiry is a refusal." } : {}),
    ...(decided ? { resultSeq: decided.seq } : {}),
  };
  const full: Json = {
    id: a.id,
    seq: a.heldSeq,
    agentSlug: agent.slug,
    tool: a.tool,
    connector: server?.name ?? a.tool.split(".")[0],
    headline: `${agent.slug} wants to call ${a.tool}${what ? ` (${what})` : ""}`,
    ruleId: a.ruleId,
    ruleReason: a.reason,
    triggeredBy: a.reason,
    approverGroup: group?.name ?? a.approverGroup,
    args,
    effect: a.executor === "agent" ? "If approved, the agent may run this call and records the outcome." : `If approved, Elan1 Govern runs ${a.tool} with these details and records the outcome.`,
    riskTags: spec?.tags ?? [],
    createdAt: a.createdAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    similar: { approved: count("approved"), rejected: count("rejected"), reversed: 0 },
    approveInChat: a.chatApproval,
    ...(amount !== undefined ? { amount } : {}),
    ...(counterparty ? { counterparty } : {}),
    notified: a.approvers.length ? ["email"] : [],
    notifiedTo: a.approvers.map((e) => ({ userId: idOf(e), channels: ["email"] })),
    // marks an approval the guard holds: deciding it in the console decides the real one (console-sync.ts)
    source: "guard",
    ...statusFields,
  };
  return { full, status: statusFields };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write one real approval into the organisation's console document: added the first time, its status after.
 * Waits its turn for the console's lock without holding a connection (the web app may hold the lock while it
 * asks the gate to decide this very approval). Does nothing for an organisation without a console document.
 */
export async function mirrorApproval(deps: Deps, orgId: string, approvalId: string): Promise<void> {
  const db = deps.db;
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await consoleState.version(orgId, db)) === null) return;
    const view = await consoleApproval(deps, orgId, approvalId);
    if (!view) return;
    const out = await db.$transaction(
      async (tx) => {
        const got = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`console-state:${orgId}`})) AS ok`;
        if (!got[0]?.ok) return "busy" as const;
        const row = await consoleState.load(orgId, tx);
        if (!row) return "none" as const;
        const doc = JSON.parse(row.json) as { approvals?: Json[] };
        const list = (doc.approvals ??= []);
        const at = list.findIndex((x) => x.id === approvalId);
        if (at < 0) list.push(view.full);
        else {
          const cur = list[at]!;
          // the console's own routing (re-route, extension, escalation) stays; the guard's outcome wins
          const next = { ...cur, ...view.status, ...(view.status.status !== "pending" ? { heldByStop: undefined } : {}) };
          if (JSON.stringify(next) === JSON.stringify(cur)) return "same" as const;
          list[at] = next;
        }
        return consoleState.save(orgId, JSON.stringify(doc), row.version, tx);
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
    if (out === "none" || out === "same") return;
    if (out !== "busy") {
      await consoleState.notify({ orgId, kind: "approval", version: out }, db).catch(() => undefined);
      return;
    }
    await sleep(Math.min(100 * (attempt + 1), 1_000));
  }
  await raiseAlert(deps, "console-sync-failed", `Approval ${approvalId} could not be written into the console: its document stayed locked.`, orgId);
}

/** For the expiry of approvals far in the future (a console extension): never more than 30 days from now. */
export function boundedExpiry(at: Date, now = Date.now()): Date {
  return new Date(Math.min(at.getTime(), now + 30 * 24 * H));
}
