import { describe, expect, it } from "vitest";
import { GateError, createGate } from "../src";

function fake(responses: Record<string, unknown[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const key = `${init.method} ${new URL(String(url)).pathname}`;
    const next = responses[key]?.shift() as { status?: number; body: unknown } | undefined;
    return new Response(JSON.stringify(next?.body ?? {}), { status: next?.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe("sdk", () => {
  it("checks and records", async () => {
    const { f, calls } = fake({
      "POST /v1/check": [{ body: { decision: "allow", rule_id: "pay-small", reason: "ok", check_id: 7 } }, { body: { decision: "ask", rule_id: "pay-large", reason: "r", check_id: 8, approval_id: "apr_1", approval_url: "http://w/approvals/apr_1", expires_at: "t" } }],
      "POST /v1/record": [{ body: { recorded: true, receipt_seq: 9 } }, { body: { recorded: true, receipt_seq: 10 } }],
    });
    const gate = createGate({ url: "http://gate/", apiKey: "gk_x", fetch: f });
    expect(await gate.check("zoho.record_bill_payment", { amount_inr: 1 })).toEqual({ decision: "allow", ruleId: "pay-small", reason: "ok", checkId: 7 });
    expect(calls[0]!.url).toBe("http://gate/v1/check");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer gk_x");
    expect(await gate.check("zoho.record_bill_payment")).toMatchObject({ decision: "ask", approvalId: "apr_1", approvalUrl: "http://w/approvals/apr_1" });
    expect(await gate.record({ checkId: 7, status: "ok", ref: "PAY-1" })).toEqual({ receiptSeq: 9 });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ check_id: 7, status: "ok", ref: "PAY-1" });
    await gate.record({ approvalId: "apr_1", status: "error", error: "bank down" });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ approval_id: "apr_1", status: "error", error: "bank down" });
  });

  it("waits for approval with long-polling", async () => {
    const { f, calls } = fake({ "GET /v1/approvals/apr_1": [{ body: { status: "pending" } }, { body: { status: "approved", message: "ok" } }] });
    const gate = createGate({ url: "http://gate", apiKey: "k", fetch: f });
    expect(await gate.waitForApproval("apr_1")).toMatchObject({ status: "approved" });
    expect(calls[0]!.url).toMatch(/wait=30$/);
    const { f: slow } = fake({ "GET /v1/approvals/apr_2": [{ body: { status: "pending" } }] });
    expect(await createGate({ url: "http://gate", apiKey: "k", fetch: slow }).waitForApproval("apr_2", 0)).toMatchObject({ status: "pending" });
  });

  it("throws GateError with the server message", async () => {
    const { f } = fake({ "POST /v1/check": [{ status: 401, body: { error: "Missing or invalid agent API key" } }, { status: 500, body: {} }] });
    const gate = createGate({ url: "http://gate", apiKey: "bad", fetch: f });
    await expect(gate.check("x")).rejects.toEqual(new GateError("Missing or invalid agent API key", 401));
    await expect(gate.check("x")).rejects.toThrow("Gate returned 500");
  });
});
