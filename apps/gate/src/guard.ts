import {
  decide,
  durationMs,
  hashCanonical,
  loadSignedRulebook,
  quotasFor,
  validateArgs,
  type DecideContext,
  type QuotaUsage,
  type ReceiptInput,
  type Rulebook,
  type ToolRegistry,
} from "@gate/core";
import { forOrg, quotaUsage, startOfDayIn } from "@gate/db";
import { holdForApproval } from "./approvals";
import { record } from "./chain";
import { publicError, resolveConnectorFor } from "./connectors";
import { registryFor } from "./registry";
import { orgKey, raiseAlert, type Deps } from "./deps";

export interface AgentIdentity {
  orgId: string;
  agentId: string;
}

/** execute: Elan1 Govern runs the tool (MCP). check: Elan1 Govern only decides; the agent runs it (SDK). */
export type GuardMode = "execute" | "check";

export type GuardResult =
  | { status: "ok"; ruleId: string; reason: string; seq: number; result?: unknown; ref?: string }
  | { status: "pending"; ruleId: string; reason: string; seq: number; approvalId: string; expiresAt: string; approvalUrl: string }
  | { status: "refused"; ruleId: string; reason: string; seq?: number }
  | { status: "failed"; ruleId: string; reason: string; seq: number };

export const GATE_ERROR_REASON = "Elan1 Govern could not check this action safely, so it was refused.";

function usesList(rb: Rulebook, tool: string, list: string) {
  return rb.rules.some((r) => (r.tool === tool || r.tag !== undefined) && r.when?.to_domain_in === list);
}

/** Current usage of every quota that applies to this tool, in each quota's own window. */
async function usageFor(deps: Deps, orgId: string, rb: Rulebook, tool: string, registry: ToolRegistry): Promise<Record<string, QuotaUsage>> {
  const quotas = quotasFor(rb, tool, registry);
  if (!quotas.length) return {};
  const org = await forOrg(orgId, deps.db).org.findFirstOrThrow({ select: { timezone: true } });
  const out: Record<string, QuotaUsage> = {};
  for (const q of quotas) {
    const tools = q.tool !== undefined ? [q.tool] : registry.list().filter((t) => q.tag && t.tags.includes(q.tag)).map((t) => t.name);
    const since = q.window === "day" ? startOfDayIn(org.timezone) : new Date(Date.now() - durationMs(q.window));
    out[q.id] = await quotaUsage(orgId, tools, since, q.max_sum?.field, deps.db);
  }
  return out;
}

function argsHashOf(tool: string, args: unknown): string {
  try {
    return hashCanonical({ tool, args: args ?? null });
  } catch {
    return hashCanonical({ tool, args: "unhashable" });
  }
}

export async function guard(deps: Deps, who: AgentIdentity, tool: string, rawArgs: unknown, mode: GuardMode = "execute"): Promise<GuardResult> {
  const { orgId, agentId } = who;
  const args_hash = argsHashOf(tool, rawArgs);
  let base: ReceiptInput = { kind: "decision", tool, args_hash };

  try {
    const db = forOrg(orgId, deps.db);
    const agent = await db.agent.findFirstOrThrow({ where: { id: agentId } });
    const key = await orgKey(deps, orgId);
    base = { ...base, agent: agent.slug };
    const touch = () => db.agent.update({ where: { id: agent.id }, data: { lastActionAt: new Date() } }).catch(() => undefined);

    const refuse = async (ruleId: string, reason: string, extra: Partial<ReceiptInput> = {}): Promise<GuardResult> => {
      const r = await record(deps, orgId, { ...base, args_summary: {}, rule_id: ruleId, decision: "refuse", reason, ...extra });
      await touch();
      return { status: "refused", ruleId, reason, seq: r.seq };
    };

    if (agent.status === "paused") return refuse("agent-paused", "This agent is paused. Every action is refused until someone resumes it.");

    const rbRow = agent.activeRulebookId ? await db.rulebook.findFirst({ where: { id: agent.activeRulebookId } }) : null;
    if (!rbRow) return refuse("no-rulebook", "This agent has no published rulebook, so nothing is allowed.");
    const registry = await registryFor(deps, orgId);
    const loaded = loadSignedRulebook(rbRow.yaml, key.publicKeyPem, registry);
    if (!loaded.ok) {
      await raiseAlert(deps, "rulebook-invalid", `Agent ${agent.slug}: ${loaded.reason}`, orgId);
      return refuse("rulebook-invalid", `The rulebook could not be trusted (${loaded.reason}), so the action was refused.`);
    }
    const rb = loaded.rulebook;
    const rulebook = { version: rbRow.version, hash: rbRow.hash };

    // Unknown, removed or disabled tools: refused, whatever a rule naming them says.
    const spec = registry.get(tool);
    if (!spec) return refuse("default", `"${tool}" is not a tool Elan1 Govern knows, so it is refused by default.`, { rulebook });
    const v = validateArgs(spec, rawArgs ?? {});
    if (!v.ok) return refuse("invalid-arguments", `The arguments are not valid (${v.error}).`, { rulebook });
    const args = v.args;

    const conn = await resolveConnectorFor(deps, orgId, spec);
    const ctx: DecideContext = { registry, usage: await usageFor(deps, orgId, rb, tool, registry) };
    if (conn.ok && usesList(rb, tool, "vendor_domains")) ctx.lists = { vendor_domains: await conn.connector.vendorDomains(conn.ctx) };

    const d = decide(rb, tool, args, ctx);
    const display = conn.ok ? await conn.connector.describe(tool, args, conn.ctx).catch(() => ({})) : {};
    const common: ReceiptInput = { ...base, args_summary: { ...d.argsSummary, ...display }, rulebook, rule_id: d.ruleId, reason: d.reason };

    if (d.decision === "refuse") {
      const r = await record(deps, orgId, { ...common, decision: "refuse" });
      await touch();
      return { status: "refused", ruleId: d.ruleId, reason: d.reason, seq: r.seq };
    }

    if (d.decision === "ask") {
      const held = await holdForApproval(deps, { orgId, agentId: agent.id, agentName: agent.name, tool, args, receipt: common, decision: d, connector: conn, executor: mode === "execute" ? "gate" : "agent" });
      await touch();
      return held;
    }

    if (mode === "check") {
      const r = await record(deps, orgId, { ...common, decision: "allow" });
      await touch();
      return { status: "ok", ruleId: d.ruleId, reason: d.reason, seq: r.seq };
    }

    let outcome: NonNullable<ReceiptInput["outcome"]>;
    let result: unknown;
    if (!conn.ok) {
      outcome = { status: "error", error: conn.reason };
    } else {
      try {
        const res = await conn.connector.call(tool, args, conn.ctx);
        outcome = { status: "ok", ...(res.ref ? { ref: res.ref } : {}) };
        result = res.data;
      } catch (e) {
        outcome = { status: "error", error: publicError(e) };
      }
    }

    let seq: number;
    try {
      seq = (await record(deps, orgId, { ...common, decision: "allow", outcome })).seq;
    } catch (e) {
      await raiseAlert(deps, "receipt-write-failed", `${tool} ran (${outcome.status}${outcome.ref ? `, ${outcome.ref}` : ""}) but its receipt could not be written: ${(e as Error).message}`, orgId);
      return { status: "refused", ruleId: "gate-error", reason: GATE_ERROR_REASON };
    }
    await touch();
    if (outcome.status === "ok") return { status: "ok", ruleId: d.ruleId, reason: d.reason, seq, result, ...(outcome.ref ? { ref: outcome.ref } : {}) };
    return { status: "failed", ruleId: d.ruleId, reason: `Allowed by rule "${d.ruleId}", but it did not complete: ${outcome.error}.`, seq };
  } catch (e) {
    deps.log.error({ err: e, orgId, tool }, "guard failed; refusing");
    try {
      const r = await record(deps, orgId, { ...base, args_summary: {}, rule_id: "gate-error", decision: "refuse", reason: GATE_ERROR_REASON });
      return { status: "refused", ruleId: "gate-error", reason: GATE_ERROR_REASON, seq: r.seq };
    } catch (e2) {
      await raiseAlert(deps, "receipt-write-failed", `A refusal for ${tool} could not be written: ${(e2 as Error).message}`, orgId);
      return { status: "refused", ruleId: "gate-error", reason: GATE_ERROR_REASON };
    }
  }
}
