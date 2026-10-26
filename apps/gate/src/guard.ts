import {
  LIMIT_TOOLS,
  TOOLS,
  TOOL_ARGS,
  decide,
  hashCanonical,
  isKnownTool,
  loadSignedRulebook,
  type DecideContext,
  type ReceiptInput,
  type Rulebook,
} from "@gate/core";
import { appendReceipt, forOrg, paymentsToday } from "@gate/db";
import { holdForApproval } from "./approvals";
import { publicError, resolveConnector } from "./connectors";
import { orgKey, raiseAlert, type Deps } from "./deps";

export interface AgentIdentity {
  orgId: string;
  agentId: string;
}

/** execute: Gate runs the tool (MCP). check: Gate only decides; the agent runs it (SDK). */
export type GuardMode = "execute" | "check";

export type GuardResult =
  | { status: "ok"; ruleId: string; reason: string; seq: number; result?: unknown; ref?: string }
  | { status: "pending"; ruleId: string; reason: string; seq: number; approvalId: string; expiresAt: string; approvalUrl: string }
  | { status: "refused"; ruleId: string; reason: string; seq?: number }
  | { status: "failed"; ruleId: string; reason: string; seq: number };

export const GATE_ERROR_REASON = "Gate could not check this action safely, so it was refused.";

function usesList(rb: Rulebook, tool: string, list: string) {
  return rb.rules.some((r) => r.tool === tool && r.when?.to_domain_in === list);
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
  let privateKeyPem: string | undefined;

  try {
    const db = forOrg(orgId, deps.db);
    const agent = await db.agent.findFirstOrThrow({ where: { id: agentId } });
    const key = await orgKey(deps, orgId);
    privateKeyPem = key.privateKeyPem;
    base = { ...base, agent: agent.slug };
    const touch = () => db.agent.update({ where: { id: agent.id }, data: { lastActionAt: new Date() } }).catch(() => undefined);

    const refuse = async (ruleId: string, reason: string, extra: Partial<ReceiptInput> = {}): Promise<GuardResult> => {
      const r = await appendReceipt(orgId, key.privateKeyPem, { ...base, args_summary: {}, rule_id: ruleId, decision: "refuse", reason, ...extra }, deps.db);
      await touch();
      return { status: "refused", ruleId, reason, seq: r.seq };
    };

    if (agent.status === "paused") return refuse("agent-paused", "This agent is paused. Every action is refused until someone resumes it.");

    const rbRow = agent.activeRulebookId ? await db.rulebook.findFirst({ where: { id: agent.activeRulebookId } }) : null;
    if (!rbRow) return refuse("no-rulebook", "This agent has no published rulebook, so nothing is allowed.");
    const loaded = loadSignedRulebook(rbRow.yaml, key.publicKeyPem);
    if (!loaded.ok) {
      await raiseAlert(deps, "rulebook-invalid", `Agent ${agent.slug}: ${loaded.reason}`, orgId);
      return refuse("rulebook-invalid", `The rulebook could not be trusted (${loaded.reason}), so the action was refused.`);
    }
    const rb = loaded.rulebook;
    const rulebook = { version: rbRow.version, hash: rbRow.hash };

    let args = (rawArgs ?? {}) as Record<string, unknown>;
    if (isKnownTool(tool)) {
      const parsed = TOOL_ARGS[tool].safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        return refuse("invalid-arguments", `The arguments are not valid (${where}${issue?.message ?? "invalid"}).`, { rulebook });
      }
      args = parsed.data as Record<string, unknown>;
    } else if (typeof args !== "object" || Array.isArray(args)) {
      args = {};
    }

    const conn = isKnownTool(tool) ? await resolveConnector(deps, orgId, TOOLS[tool].connector) : undefined;
    const ctx: DecideContext = {};
    if (conn?.ok && usesList(rb, tool, "vendor_domains")) ctx.lists = { vendor_domains: await conn.connector.vendorDomains(conn.ctx) };
    if (tool === LIMIT_TOOLS.daily_payments_inr.tool && rb.limits?.daily_payments_inr !== undefined) {
      ctx.usage = { daily_payments_inr: await paymentsToday(orgId, deps.db) };
    }

    const d = decide(rb, tool, args, ctx);
    const display = conn?.ok && isKnownTool(tool) ? await conn.connector.describe(tool, args, conn.ctx).catch(() => ({})) : {};
    const common: ReceiptInput = { ...base, args_summary: { ...d.argsSummary, ...display }, rulebook, rule_id: d.ruleId, reason: d.reason };

    if (d.decision === "refuse") {
      const r = await appendReceipt(orgId, key.privateKeyPem, { ...common, decision: "refuse" }, deps.db);
      await touch();
      return { status: "refused", ruleId: d.ruleId, reason: d.reason, seq: r.seq };
    }

    if (d.decision === "ask") {
      const held = await holdForApproval(deps, { orgId, agentId: agent.id, agentName: agent.name, privateKeyPem: key.privateKeyPem, tool, args, receipt: common, decision: d, connector: conn, executor: mode === "execute" ? "gate" : "agent" });
      await touch();
      return held;
    }

    if (mode === "check") {
      const r = await appendReceipt(orgId, key.privateKeyPem, { ...common, decision: "allow" }, deps.db);
      await touch();
      return { status: "ok", ruleId: d.ruleId, reason: d.reason, seq: r.seq };
    }

    let outcome: NonNullable<ReceiptInput["outcome"]>;
    let result: unknown;
    if (!conn?.ok) {
      outcome = { status: "error", error: conn?.reason ?? "no connector" };
    } else {
      try {
        const res = await conn.connector.call(tool as keyof typeof TOOLS, args, conn.ctx);
        outcome = { status: "ok", ...(res.ref ? { ref: res.ref } : {}) };
        result = res.data;
      } catch (e) {
        outcome = { status: "error", error: publicError(e) };
      }
    }

    let seq: number;
    try {
      seq = (await appendReceipt(orgId, key.privateKeyPem, { ...common, decision: "allow", outcome }, deps.db)).seq;
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
      const key = privateKeyPem ?? (await orgKey(deps, orgId)).privateKeyPem;
      const r = await appendReceipt(orgId, key, { ...base, args_summary: {}, rule_id: "gate-error", decision: "refuse", reason: GATE_ERROR_REASON }, deps.db);
      return { status: "refused", ruleId: "gate-error", reason: GATE_ERROR_REASON, seq: r.seq };
    } catch (e2) {
      await raiseAlert(deps, "receipt-write-failed", `A refusal for ${tool} could not be written: ${(e2 as Error).message}`, orgId);
      return { status: "refused", ruleId: "gate-error", reason: GATE_ERROR_REASON };
    }
  }
}
