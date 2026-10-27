import { decrypt, rulebookToYaml, parseRulebookYaml, type Rulebook } from "@gate/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeReplay, replayDraft, resetReplayRate, storeReplayCall } from "../src/replay";
import { demoOrg, gateMeta, internal, makeApp, tool } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
const logs: string[] = [];

beforeAll(async () => {
  ctx = await makeApp();
  const log = ctx.deps.log;
  const capture = (obj: unknown, msg?: string) => void logs.push(JSON.stringify(obj) + (msg ?? ""));
  ctx.deps.log = Object.assign(Object.create(log), { info: capture, warn: capture, error: capture });
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(() => resetReplayRate());

/** The demo agent's active rulebook, as YAML a person could edit. */
async function activeYaml(d: Awaited<ReturnType<typeof demoOrg>>) {
  const agent = await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } });
  const row = await d.db.rulebook.findFirstOrThrow({ where: { id: agent.activeRulebookId! } });
  return row.yaml;
}

function edit(yaml: string, fn: (rb: Rulebook) => Rulebook): string {
  const p = parseRulebookYaml(yaml);
  if (!p.ok) throw new Error(p.errors.join());
  const { signature: _s, ...rest } = p.rulebook;
  return rulebookToYaml(fn(rest as Rulebook));
}

const lowerThreshold = (rb: Rulebook): Rulebook => ({
  ...rb,
  rules: rb.rules.map((r) =>
    r.id === "pay-small" ? { ...r, when: { amount_inr: { lte: 10000 } } } : r.id === "pay-large" ? { ...r, when: { amount_inr: { gt: 10000 } } } : r,
  ),
});

const SECRET = "UTR-REPLAY-SECRET-7731";

describe("replay store", () => {
  it("stores each guarded call's arguments encrypted, bound to its org and receipt, and never logs them", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000, reference: SECRET });
    const seq = gateMeta(r).receipt_seq as number;
    const rows = await d.db.replayCall.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ agentId: d.agentId, seq, tool: "zoho.record_bill_payment", decision: "allow", ruleId: "pay-small" });
    // At rest: ciphertext only.
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain("bill_1187");
    expect(JSON.parse(decrypt(ctx.deps.env.GATE_MASTER_KEY, row.argsEnc, `replay-args:${d.org.id}:${seq}`))).toEqual({ bill_id: "bill_1187", amount_inr: 18000, reference: SECRET });
    expect(() => decrypt(ctx.deps.env.GATE_MASTER_KEY, row.argsEnc, `replay-args:other-org:${seq}`)).toThrow();
    // Receipts stay minimal.
    const receipt = await d.db.receipt.findFirstOrThrow({ where: { seq } });
    expect(JSON.stringify(receipt.body)).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("stores refusals and held actions too, but nothing refused before the rules are checked", async () => {
    const d = await demoOrg(ctx.deps);
    await tool(ctx.app, d.apiKey, "zoho.update_vendor", { vendor_id: "v_sharma", fields: { ifsc: "SBIN0000001" } });
    await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 });
    await tool(ctx.app, d.apiKey, "gmail.delete_message", { message_id: "m" });
    await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: 12 });
    const rows = await d.db.replayCall.findMany({ orderBy: { seq: "asc" } });
    expect(rows.map((r) => [r.tool, r.decision])).toEqual([
      ["zoho.update_vendor", "refuse"],
      ["zoho.record_bill_payment", "ask"],
    ]);
  });

  it("writes nothing when the org has the store off, and a write failure never changes the answer", async () => {
    const d = await demoOrg(ctx.deps);
    await d.db.org.update({ where: { id: d.org.id }, data: { replayStore: false } });
    const r = await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    expect(gateMeta(r)).toMatchObject({ decision: "allow" });
    expect(await d.db.replayCall.count()).toBe(0);
    await d.db.org.update({ where: { id: d.org.id }, data: { replayStore: true } });
    const ok = await storeReplayCall(ctx.deps, d.org.id, { agentId: d.agentId, seq: 1, tool: "gmail.read_message", args: { message_id: "x" }, decision: "allow", ruleId: "read-mail" });
    expect(ok).toBe(true);
    // Same seq again: unique per org, so the write fails quietly.
    expect(await storeReplayCall(ctx.deps, d.org.id, { agentId: d.agentId, seq: 1, tool: "gmail.read_message", args: { message_id: SECRET }, decision: "allow", ruleId: "read-mail" })).toBe(false);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("purges rows older than 30 days, and every row of an org that switched the store off", async () => {
    const a = await demoOrg(ctx.deps);
    const b = await demoOrg(ctx.deps);
    await tool(ctx.app, a.apiKey, "gmail.read_message", { message_id: "m_101" });
    await tool(ctx.app, a.apiKey, "gmail.read_message", { message_id: "m_102" });
    await tool(ctx.app, b.apiKey, "gmail.read_message", { message_id: "m_101" });
    const [old] = await a.db.replayCall.findMany({ orderBy: { seq: "asc" } });
    await a.db.replayCall.update({ where: { id: old!.id }, data: { ts: new Date(Date.now() - 31 * 86_400_000) } });
    await b.db.org.update({ where: { id: b.org.id }, data: { replayStore: false } });
    expect(await purgeReplay(ctx.deps)).toBeGreaterThanOrEqual(2);
    expect(await a.db.replayCall.count()).toBe(1);
    expect(await b.db.replayCall.count()).toBe(0);
  });
});

describe("replaying a draft rulebook", () => {
  it("shows what a lower payment threshold would have done, with plain descriptions and no arguments", async () => {
    const d = await demoOrg(ctx.deps);
    await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000, reference: SECRET });
    await tool(ctx.app, d.apiKey, "zoho.update_vendor", { vendor_id: "v_sharma", fields: { ifsc: "SBIN0000001" } });
    const yaml = edit(await activeYaml(d), lowerThreshold);

    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/replay`, { yaml, days: 7, actor: d.owner.email });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report).toMatchObject({ days: 7, storeOn: true, limited: false, total: 3, judged: 3, notJudged: 0, changed: 1, unchanged: 2, more: { ask: 1, allow: 0, refuse: 0 }, fewer: { allow: 1 } });
    expect(report.changes).toEqual([expect.objectContaining({ tool: "zoho.record_bill_payment", from: "allow", to: "ask", fromRule: "pay-small", rule: "pay-large", action: "Pay ₹18,000 to Kaveri Logistics for KL-1187" })]);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("SBIN");

    // The active rulebook over its own history: nothing changes.
    const same = (await replayDraft(ctx.deps, d.org.id, d.agentId, await activeYaml(d), 30)) as { ok: true; report: { changed: number; judged: number } };
    expect(same.report).toMatchObject({ changed: 0, judged: 3 });
    // Nothing was published: the agent still runs on its first version.
    expect((await d.db.rulebook.count({ where: { agentId: d.agentId } }))).toBe(1);
  });

  it("simulates a daily quota in order across the replayed calls, counting only calls that ran", async () => {
    const d = await demoOrg(ctx.deps);
    for (const id of ["m_101", "m_102", "m_103", "m_missing"]) await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: id });
    const yaml = edit(await activeYaml(d), (rb) => ({ ...rb, quotas: [{ id: "two-reads", tool: "gmail.read_message", window: "day", max_count: 2 }] }));
    const r = await replayDraft(ctx.deps, d.org.id, d.agentId, yaml, 30);
    if (!r.ok) throw new Error(r.error);
    // The third and fourth reads go past two a day; the failed fourth read never counted.
    expect(r.report.changes.map((c) => [c.to, c.quotaId])).toEqual([
      ["ask", "two-reads"],
      ["ask", "two-reads"],
    ]);
  });

  it("counts calls without stored arguments as could not be judged", async () => {
    const d = await demoOrg(ctx.deps);
    await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    await tool(ctx.app, d.apiKey, "gmail.delete_message", { message_id: "m" }); // unknown tool: refused before the rules
    await d.db.org.update({ where: { id: d.org.id }, data: { replayStore: false } });
    await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_102" });
    const r = await replayDraft(ctx.deps, d.org.id, d.agentId, await activeYaml(d), 30);
    if (!r.ok) throw new Error(r.error);
    expect(r.report).toMatchObject({ total: 3, judged: 1, notJudged: 2, storeOn: false });
  });

  it("reports an empty history, bad rulebooks, bad periods and too many runs", async () => {
    const d = await demoOrg(ctx.deps);
    const url = `/internal/orgs/${d.org.id}/agents/${d.agentId}/replay`;
    const yaml = await activeYaml(d);
    const empty = await internal(ctx.app, "POST", url, { yaml, actor: d.owner.email });
    expect(empty.json()).toMatchObject({ days: 30, total: 0, changes: [] });
    const bad = await internal(ctx.app, "POST", url, { yaml: "rules: [", actor: d.owner.email });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0]).toMatch(/YAML/);
    const unknownTool = await internal(ctx.app, "POST", url, { yaml: yaml.replace("tool: gmail.read_message", "tool: shell.exec"), actor: d.owner.email });
    expect(unknownTool.statusCode).toBe(422);
    expect((await internal(ctx.app, "POST", url, { yaml, days: 14, actor: d.owner.email })).statusCode).toBe(400);
    // Unsigned HMAC: refused.
    expect((await ctx.app.inject({ method: "POST", url, payload: { yaml, actor: d.owner.email } })).statusCode).toBe(401);
    // Six a minute per org (the two 422s above counted too).
    for (let i = 0; i < 3; i++) expect((await internal(ctx.app, "POST", url, { yaml, actor: d.owner.email })).statusCode).toBe(200);
    expect((await internal(ctx.app, "POST", url, { yaml, actor: d.owner.email })).statusCode).toBe(429);
  });

  it("org A cannot replay over org B's calls", async () => {
    const a = await demoOrg(ctx.deps);
    const b = await demoOrg(ctx.deps);
    await tool(ctx.app, b.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000, reference: SECRET });
    const yaml = edit(await activeYaml(b), lowerThreshold);
    // B's agent through A's org: no such agent.
    const res = await internal(ctx.app, "POST", `/internal/orgs/${a.org.id}/agents/${b.agentId}/replay`, { yaml, actor: a.owner.email });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(SECRET);
    // Even B's ciphertext copied into A's store does not decrypt there: the AAD names the org and receipt.
    await tool(ctx.app, a.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000 });
    const theirs = await b.db.replayCall.findFirstOrThrow();
    const ours = await a.db.replayCall.findFirstOrThrow();
    await a.db.replayCall.update({ where: { id: ours.id }, data: { argsEnc: theirs.argsEnc } });
    const r = await replayDraft(ctx.deps, a.org.id, a.agentId, yaml, 30);
    if (!r.ok) throw new Error(r.error);
    expect(r.report).toMatchObject({ total: 1, judged: 0, notJudged: 1 });
    expect(JSON.stringify(r.report)).not.toContain(SECRET);
  });
});
