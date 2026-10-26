// Elan1 Govern SDK for agents with their own tool loop. Ask Elan1 Govern before acting, tell it after.
//
//   const gate = createGate({ url: "http://localhost:4000", apiKey: process.env.GATE_KEY! });
//   const check = await gate.check("zoho.record_bill_payment", { bill_id, amount_inr });
//   if (check.decision === "allow") { const ref = await pay(); await gate.record({ checkId: check.checkId, status: "ok", ref }); }

export type Decision = "allow" | "ask" | "refuse";

export interface CheckResult {
  decision: Decision;
  ruleId: string;
  reason: string;
  /** Pass to record() after you run an allowed action. */
  checkId: number | null;
  approvalId?: string;
  approvalUrl?: string;
  expiresAt?: string;
}

export interface ApprovalStatus {
  approval_id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  expires_at: string;
  rule_id: string;
  message: string;
}

export class GateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface GateOptions {
  /** Base URL of the Elan1 Govern service, e.g. http://localhost:4000 */
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export function createGate(opts: GateOptions) {
  const f = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, "");

  async function req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new GateError(typeof json.error === "string" ? json.error : `Elan1 Govern returned ${res.status}`, res.status);
    return json as T;
  }

  return {
    /** Ask Elan1 Govern whether the agent may run this tool with these arguments. Nothing is run. */
    async check(tool: string, args: Record<string, unknown> = {}): Promise<CheckResult> {
      const r = await req<Record<string, unknown>>("POST", "/v1/check", { tool, args });
      return {
        decision: r.decision as Decision,
        ruleId: String(r.rule_id),
        reason: String(r.reason),
        checkId: typeof r.check_id === "number" ? r.check_id : null,
        ...(typeof r.approval_id === "string" ? { approvalId: r.approval_id, approvalUrl: String(r.approval_url), expiresAt: String(r.expires_at) } : {}),
      };
    },

    /** Tell Elan1 Govern what happened after you ran an allowed (or approved) action. */
    async record(input: { checkId?: number; approvalId?: string; status: "ok" | "error"; ref?: string; error?: string }): Promise<{ receiptSeq: number }> {
      const r = await req<{ receipt_seq: number }>("POST", "/v1/record", {
        ...(input.checkId !== undefined ? { check_id: input.checkId } : {}),
        ...(input.approvalId !== undefined ? { approval_id: input.approvalId } : {}),
        status: input.status,
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.error ? { error: input.error } : {}),
      });
      return { receiptSeq: r.receipt_seq };
    },

    /** Wait for a person to decide. Long-polls Elan1 Govern in 30-second steps. */
    async waitForApproval(approvalId: string, timeoutMs = 10 * 60_000): Promise<ApprovalStatus> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const left = Math.max(0, Math.min(30, Math.ceil((until - Date.now()) / 1000)));
        const s = await req<ApprovalStatus>("GET", `/v1/approvals/${encodeURIComponent(approvalId)}?wait=${left}`);
        if (s.status !== "pending" || Date.now() >= until) return s;
      }
    },
  };
}

export type Gate = ReturnType<typeof createGate>;

export { verifyWebhook } from "./webhook";
