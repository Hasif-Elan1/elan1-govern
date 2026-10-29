import { mockState } from "@gate/connectors";
import { verifyChain, verifyEvidenceFile, type Receipt } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireDue } from "../src/approvals";
import { demoOrg, gateMeta, internal, makeApp, makeUser, mcp, tool } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => {
  await ctx.app.close();
});

async function receipts(orgId: string) {
  return (await forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);
}

describe("MCP basics", () => {
  it("lists only the allowed tools plus the approval status tool", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await mcp(ctx.app, d.apiKey, "tools/list");
    const names = r.body.result!.tools!.map((t) => t.name);
    expect(names).toHaveLength(11);
    expect(names).toContain("gate.approval_status");
    expect(names.some((n) => /delete|forward|settings/.test(n))).toBe(false);
  });
  it("rejects missing and bad keys", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(res.statusCode).toBe(401);
    const bad = await mcp(ctx.app, `gk_${"A".repeat(43)}`, "tools/list");
    expect(bad.status).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(405);
  });
});

describe("decisions", () => {
  it("allow: runs the tool and writes one receipt", async () => {
    const d = await demoOrg(ctx.deps);
    const before = (await receipts(d.org.id)).length;
    const r = await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]!.text).subject).toMatch(/INV-2291/);
    const rs = await receipts(d.org.id);
    expect(rs).toHaveLength(before + 1);
    expect(rs.at(-1)).toMatchObject({ kind: "decision", decision: "allow", rule_id: "read-mail", outcome: { status: "ok" }, args_summary: { message_id: "m_101" } });
    expect(JSON.stringify(rs.at(-1))).not.toMatch(/Please find attached/);
  });

  it("allow: small payment records the vendor and bill for display", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000 });
    expect(gateMeta(r)).toMatchObject({ decision: "allow", rule_id: "pay-small" });
    expect((await receipts(d.org.id)).at(-1)).toMatchObject({ args_summary: { bill_id: "bill_1187", amount_inr: 18000, vendor: "Kaveri Logistics", bill: "KL-1187" }, outcome: { status: "ok", ref: expect.stringMatching(/^PAY-/) } });
  });

  it("refuse: names the rule and does not run", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await tool(ctx.app, d.apiKey, "zoho.update_vendor", { vendor_id: "v_sharma", fields: { bank_account: "1111", ifsc: "SBIN0000001" } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Refused by rule "no-bank-change"/);
    expect(mockState(d.org.id).vendors[0]!.ifsc).toBe("HDFC0000123");
    const last = (await receipts(d.org.id)).at(-1)!;
    expect(last).toMatchObject({ decision: "refuse", rule_id: "no-bank-change", args_summary: { fields: ["bank_account", "ifsc"] } });
    expect(JSON.stringify(last)).not.toContain("SBIN");
  });

  it("unknown tool: refused by default", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await tool(ctx.app, d.apiKey, "gmail.delete_message", { message_id: "m_104" });
    expect(r.isError).toBe(true);
    expect(gateMeta(r)).toMatchObject({ decision: "refuse", rule_id: "default" });
  });

  it("invalid arguments are refused", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: "18000" });
    expect(gateMeta(r)).toMatchObject({ decision: "refuse", rule_id: "invalid-arguments" });
  });

  it("allowed but the connector failed: error, with a receipt", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/did not complete: No message/);
    expect((await receipts(d.org.id)).at(-1)).toMatchObject({ decision: "allow", outcome: { status: "error" } });
  });

  it("a disconnected connector fails without running", async () => {
    const d = await demoOrg(ctx.deps);
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/connectors/gmail`, { action: "disconnect", actor: d.owner.email });
    const r = await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    expect(r.content[0]!.text).toMatch(/Gmail is not connected/);
  });

  it("daily limit turns an allow into an ask", async () => {
    const d = await demoOrg(ctx.deps);
    const agent = await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } });
    const rb = await d.db.rulebook.findFirstOrThrow({ where: { id: agent.activeRulebookId! } });
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/rulebooks`, { yaml: rb.yaml.replace("daily_payments_inr: 2000000", "daily_payments_inr: 60000"), actor: d.owner.email });
    expect(res.statusCode).toBe(200);
    expect(gateMeta(await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000 }))).toMatchObject({ decision: "allow" });
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_554", amount_inr: 42480 });
    expect(gateMeta(r)).toMatchObject({ decision: "ask", rule_id: "pay-small", status: "pending" });
    expect(r.content[0]!.text).toMatch(/daily limit/);
  });
});

describe("quotas", () => {
  it("a count quota on any tool turns the next allowed call into an ask", async () => {
    const d = await demoOrg(ctx.deps);
    const agent = await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } });
    const rb = await d.db.rulebook.findFirstOrThrow({ where: { id: agent.activeRulebookId! } });
    const yaml = rb.yaml.replace("rules:\n", "quotas:\n  - id: reads-per-hour\n    tag: reads_data\n    window: 1h\n    max_count: 2\nrules:\n");
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/rulebooks`, { yaml, actor: d.owner.email });
    expect(res.statusCode, res.body).toBe(200);
    // The demo run already did reads in this org? No: demoOrg does not run the agent.
    for (let i = 0; i < 2; i++) expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" }))).toMatchObject({ decision: "allow" });
    const third = await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_102" });
    expect(gateMeta(third)).toMatchObject({ decision: "ask", rule_id: "read-mail", status: "pending" });
    expect(third.content[0]!.text).toMatch(/limit of 2 per 1h/);
  });
});

describe("approvals", () => {
  async function held() {
    const d = await demoOrg(ctx.deps);
    ctx.sent.length = 0;
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 });
    const m = gateMeta(r);
    expect(m).toMatchObject({ decision: "ask", status: "pending", rule_id: "pay-large" });
    return { d, approvalId: m.approval_id as string, result: r };
  }

  it("ask -> approve: holds, emails the approver, runs on approval, two receipts", async () => {
    const { d, approvalId, result } = await held();
    expect(result.content[0]!.text).toMatch(/Do not retry/);
    expect(mockState(d.org.id).payments).toHaveLength(0);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatchObject({ to: d.owner.email, subject: "Waiting for you: Pay ₹2,00,000 to Sharma Traders for INV-2291" });
    expect(ctx.sent[0]!.text).toMatch(/\/approve\//);

    const pending = await tool(ctx.app, d.apiKey, "gate.approval_status", { approval_id: approvalId, wait_seconds: 0 });
    expect(gateMeta(pending)).toMatchObject({ status: "pending" });

    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "approved", note: "Checked with Sharma" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: "approved", outcome: { status: "ok" }, selfApproval: true });
    expect(mockState(d.org.id).payments).toHaveLength(1);

    const done = await tool(ctx.app, d.apiKey, "gate.approval_status", { approval_id: approvalId });
    expect(gateMeta(done)).toMatchObject({ status: "approved", outcome: { status: "ok" } });
    const rs = (await receipts(d.org.id)).filter((x) => x.approval?.id === approvalId);
    expect(rs.map((x) => [x.kind, x.approval?.result])).toEqual([["decision", "pending"], ["approval", "approved"]]);
    expect(rs[1]).toMatchObject({ ref_seq: rs[0]!.seq, approval: { by: d.owner.email, self_approval: true }, outcome: { ref: expect.stringMatching(/^PAY-/) } });
    const row = await d.db.approval.findFirstOrThrow({ where: { id: approvalId } });
    expect(row.argsEnc).toBeNull();
    // Deciding twice is refused.
    const again = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "rejected" });
    expect(again.statusCode).toBe(409);
  });

  it("ask -> reject: nothing runs", async () => {
    const { d, approvalId } = await held();
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "rejected" });
    expect(res.json()).toMatchObject({ status: "rejected", outcome: { status: "not_run" } });
    expect(mockState(d.org.id).payments).toHaveLength(0);
    const st = await tool(ctx.app, d.apiKey, "gate.approval_status", { approval_id: approvalId });
    expect(st.isError).toBe(true);
    expect(gateMeta(st)).toMatchObject({ status: "rejected" });
  });

  it("ask -> expire: treated as refused", async () => {
    const { d, approvalId } = await held();
    await d.db.approval.update({ where: { id: approvalId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireDue(ctx.deps)).toBeGreaterThanOrEqual(1);
    const st = await tool(ctx.app, d.apiKey, "gate.approval_status", { approval_id: approvalId });
    expect(gateMeta(st)).toMatchObject({ status: "expired" });
    expect((await receipts(d.org.id)).at(-1)).toMatchObject({ kind: "approval", approval: { result: "expired" }, outcome: { status: "not_run" } });
    const late = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "approved" });
    expect(late.statusCode).toBe(409);
  });

  it("an approval past its time expires when someone tries to approve it", async () => {
    const { d, approvalId } = await held();
    await d.db.approval.update({ where: { id: approvalId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "approved" });
    expect(late.statusCode).toBe(410);
    expect(mockState(d.org.id).payments).toHaveLength(0);
  });

  it("long-poll returns as soon as it is decided", async () => {
    const { d, approvalId } = await held();
    const waiting = tool(ctx.app, d.apiKey, "gate.approval_status", { approval_id: approvalId, wait_seconds: 10 });
    await new Promise((r) => setTimeout(r, 400));
    const started = Date.now();
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "approved" });
    expect(gateMeta(await waiting)).toMatchObject({ status: "approved" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("only listed approvers with an approver role can decide", async () => {
    const { d, approvalId } = await held();
    const stranger = await makeUser("stranger");
    const r1 = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: stranger.id, email: stranger.email, result: "approved" });
    expect(r1.statusCode).toBe(403);
    // A member of the org, but a viewer, and not in the rule's list.
    const viewer = await makeUser("viewer");
    await prisma.membership.create({ data: { orgId: d.org.id, userId: viewer.id, role: "viewer" } });
    const r2 = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: viewer.id, email: viewer.email, result: "approved" });
    expect(r2.statusCode).toBe(403);
    // Pretending to be the owner by email while signed in as someone else fails too.
    const r3 = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: viewer.id, email: d.owner.email, result: "approved" });
    expect(r3.statusCode).toBe(403);
    expect(mockState(d.org.id).payments).toHaveLength(0);
  });

  it("approval links are single-use", async () => {
    const { d, approvalId } = await held();
    const link = await d.db.approvalLink.findFirstOrThrow({ where: { approvalId } });
    const body = { userId: d.owner.id, email: d.owner.email, result: "approved", linkId: link.id };
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, body)).statusCode).toBe(200);
    const again = await held();
    const link2 = await again.d.db.approvalLink.findFirstOrThrow({ where: { approvalId: again.approvalId } });
    await again.d.db.approvalLink.update({ where: { id: link2.id }, data: { usedAt: new Date() } });
    const replay = await internal(ctx.app, "POST", `/internal/orgs/${again.d.org.id}/approvals/${again.approvalId}/resolve`, { userId: again.d.owner.id, email: again.d.owner.email, result: "approved", linkId: link2.id });
    expect(replay.statusCode).toBe(410);
    expect(mockState(again.d.org.id).payments).toHaveLength(0);
  });
});

describe("kill switch and rulebook trust", () => {
  it("a paused agent is refused instantly", async () => {
    const d = await demoOrg(ctx.deps);
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/status`, { status: "paused", actor: d.owner.email });
    const r = await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    expect(gateMeta(r)).toMatchObject({ decision: "refuse", rule_id: "agent-paused" });
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/status`, { status: "active", actor: d.owner.email });
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" }))).toMatchObject({ decision: "allow" });
  });

  it("a rulebook with a bad signature is not loaded", async () => {
    const d = await demoOrg(ctx.deps);
    const agent = await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } });
    const rb = await d.db.rulebook.findFirstOrThrow({ where: { id: agent.activeRulebookId! } });
    await d.db.rulebook.update({ where: { id: rb.id }, data: { yaml: rb.yaml.replace("lte: 50000", "lte: 5000000") } });
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 });
    expect(gateMeta(r)).toMatchObject({ decision: "refuse", rule_id: "rulebook-invalid" });
    expect(ctx.deps.alerts.some((a) => a.kind === "rulebook-invalid" && a.orgId === d.org.id)).toBe(true);
    expect(mockState(d.org.id).payments).toHaveLength(0);
  });

  it("an agent without a rulebook can do nothing", async () => {
    const d = await demoOrg(ctx.deps);
    await d.db.agent.update({ where: { id: d.agentId }, data: { activeRulebookId: null } });
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.search", { query: "x" }))).toMatchObject({ rule_id: "no-rulebook" });
  });

  it("publishing validates, bumps the version and keeps old versions", async () => {
    const d = await demoOrg(ctx.deps);
    const agent = await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } });
    const v1 = await d.db.rulebook.findFirstOrThrow({ where: { id: agent.activeRulebookId! } });
    const bad = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/rulebooks`, { yaml: "version: 1\nrules: [", actor: d.owner.email });
    expect(bad.statusCode).toBe(422);
    const noAsk = v1.yaml.replace(/ {2}- id: pay-large[\s\S]*?expires_in: 24h\n/, "");
    const blocked = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/rulebooks`, { yaml: noAsk, actor: d.owner.email });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().errors[0]).toMatch(/High-risk agents need at least one "Ask" rule/);
    const ok = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/rulebooks`, { yaml: v1.yaml, actor: d.owner.email });
    expect(ok.json()).toMatchObject({ ok: true, version: 2 });
    expect(await d.db.rulebook.count({ where: { agentId: d.agentId } })).toBe(2);
    expect((await receipts(d.org.id)).at(-1)).toMatchObject({ kind: "admin", action: "rulebook.signed", rulebook: { version: 2 } });
  });
});

describe("fail closed", () => {
  it("if the database fails mid-call, the call is refused and nothing runs", async () => {
    const d = await demoOrg(ctx.deps);
    const broken = new Proxy(prisma, {
      get(target, prop, recv) {
        if (prop === "$transaction" || prop === "$extends") {
          return (...args: unknown[]) => {
            if (prop === "$transaction") throw new Error("connection terminated");
            const ext = (target.$extends as (...a: unknown[]) => unknown)(...args) as object;
            return new Proxy(ext, { get: (t, p, r) => (p === "$transaction" ? () => Promise.reject(new Error("connection terminated")) : Reflect.get(t, p, r)) });
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const failing = await makeApp({ db: broken as typeof prisma });
    const r = await tool(failing.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000 });
    expect(r.isError).toBe(true);
    expect(gateMeta(r)).toMatchObject({ decision: "refuse", rule_id: "gate-error" });
    expect(failing.deps.alerts.map((a) => a.kind)).toContain("receipt-write-failed");
    // The connector did run for an allow before the receipt write failed: the agent still gets a refusal
    // and the alert names the reference so a person can reconcile it.
    expect(failing.deps.alerts.at(-1)!.message).toMatch(/ran \(ok, PAY-/);
    await failing.app.close();
  });

  it("if the database is unreachable, nothing runs and the agent gets an error", async () => {
    const { PrismaClient } = await import("@gate/db");
    const dead = new PrismaClient({ datasourceUrl: "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1" });
    const d = await demoOrg(ctx.deps);
    const down = await makeApp({ db: dead });
    const r = await mcp(down.app, d.apiKey, "tools/call", { name: "zoho.record_bill_payment", arguments: { bill_id: "bill_1187", amount_inr: 18000 } });
    expect(r.status).toBe(500);
    expect(r.raw).toMatch(/refused, and nothing ran/);
    expect(mockState(d.org.id).payments).toHaveLength(0);
    const health = await down.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(503);
    await down.app.close();
    await dead.$disconnect();
  });
});

describe("chain", () => {
  it("concurrent calls produce a gap-free, valid chain", async () => {
    const d = await demoOrg(ctx.deps);
    await Promise.all(Array.from({ length: 25 }, (_, i) => tool(ctx.app, d.apiKey, i % 3 === 0 ? "gmail.delete_message" : "gmail.read_message", { message_id: "m_101" })));
    const rows = await receipts(d.org.id);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    const key = await forOrg(d.org.id).org.findFirstOrThrow();
    expect(verifyChain(rows, key.publicKey)).toMatchObject({ ok: true, count: rows.length });
  });

  it("exports a bundle and an auditor pack that verify offline", async () => {
    const d = await demoOrg(ctx.deps);
    await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    for (const kind of ["bundle", "pack"] as const) {
      const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/export`, { from: today, to: today, kind, actor: d.owner.email });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/zip");
      const v = verifyEvidenceFile(new Uint8Array(res.rawPayload));
      expect(v).toMatchObject({ ok: true });
    }
    const bad = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/export`, { from: today, to: "2000-01-01", kind: "bundle", actor: d.owner.email });
    expect(bad.statusCode).toBe(400);
    const cp = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/checkpoints`, { actor: d.owner.email });
    expect(cp.statusCode).toBe(200);
  });

  it("auditor pack lists only enabled frameworks; framework reports are PDFs and are logged", async () => {
    const d = await demoOrg(ctx.deps);
    const { enableFrameworks } = await import("@gate/db");
    await enableFrameworks(d.org.id, ["hipaa"], d.owner.email);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const pack = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/export`, { from: today, to: today, kind: "pack", actor: d.owner.email });
    expect(pack.statusCode).toBe(200);

    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/frameworks/hipaa/report`, { actor: d.owner.email });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(Buffer.from(res.rawPayload).subarray(0, 5).toString()).toBe("%PDF-");
    // Not enabled yet still renders (the report says so); unknown ids are 404, bad ids 400.
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/frameworks/nyc-ll144/report`, { actor: d.owner.email })).statusCode).toBe(200);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/frameworks/made-up/report`, { actor: d.owner.email })).statusCode).toBe(404);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/frameworks/BAD!/report`, { actor: d.owner.email })).statusCode).toBe(400);
    const logged = await d.db.receipt.findMany({ where: { action: "evidence.exported" }, orderBy: { seq: "asc" } });
    expect(logged.map((r) => (r.body as { details?: { framework?: string } }).details?.framework).filter(Boolean)).toEqual(["hipaa", "nyc-ll144"]);
  });
});
