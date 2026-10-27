import { BEHAVIOUR_DEFAULTS, type Receipt } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgent } from "../src/admin";
import { actOnAlert, inlineBehaviourCheck, raiseBehaviourAlert, scanAll, scanOrg } from "../src/behaviour";
import { incidentWindow, receiptLine } from "../src/incidents";
import { demoOrg, gateMeta, internal, makeApp, tool } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => {
  await Promise.all([...ctx.deps.background]);
  await ctx.app.close();
});

const settle = async () => {
  // Inline checks can start more background work (emails, webhooks); wait until it is all done.
  for (let i = 0; i < 5 && ctx.deps.background.size; i++) await Promise.all([...ctx.deps.background]);
};

/** A demo org with the learning period off, so the first actions already count. */
async function liveOrg() {
  const d = await demoOrg(ctx.deps);
  const r = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/alert-settings`, { settings: { ...BEHAVIOUR_DEFAULTS, learningDays: 0 }, actor: d.owner.email });
  expect(r.statusCode, r.body).toBe(200);
  return d;
}

const adminReceipts = async (orgId: string, action: string) =>
  (await forOrg(orgId).receipt.findMany({ where: { action }, orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);

describe("unusual-behaviour alerts", () => {
  it("nothing is raised while the agent is learning", async () => {
    const d = await demoOrg(ctx.deps);
    await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 1000 });
    await settle();
    expect(await scanOrg(ctx.deps, d.org.id)).toMatchObject({ agents: 1, raised: 0 });
    expect(await d.db.behaviourAlert.count()).toBe(0);
  });

  it("the guard's inline check raises a new-vendor alert once, with a receipt, a webhook event and an email", async () => {
    const d = await liveOrg();
    const hook = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks`, { url: "http://127.0.0.1:9/in", events: ["alert.created"], actor: d.owner.email });
    expect(hook.statusCode).toBe(200);
    ctx.sent.length = 0;
    const first = gateMeta(await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 1000 }));
    expect(first.decision).toBe("allow");
    await settle();
    await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 1000 });
    await settle();

    const alerts = await d.db.behaviourAlert.findMany({ orderBy: { createdAt: "asc" } });
    const vendor = alerts.filter((a) => a.detector === "new_counterparty");
    expect(vendor).toHaveLength(1);
    expect(vendor[0]).toMatchObject({ key: "vendor:kaveri logistics", severity: "medium", status: "open", title: "New vendor: Kaveri Logistics", agentSlug: "ap-bot" });
    expect(vendor[0]!.explanation).toContain("for ₹1,000");
    expect(alerts.filter((a) => a.detector === "new_tool")).toHaveLength(1);

    const receipts = await adminReceipts(d.org.id, "alert.created");
    expect(receipts.map((r) => r.details?.alert_id).sort()).toEqual(alerts.map((a) => a.id).sort());
    expect(receipts[0]!.actor).toBe("Elan1 Govern");
    expect(vendor[0]!.receiptSeq).toBe(receipts.find((r) => r.details?.alert_id === vendor[0]!.id)!.seq);

    const deliveries = await d.db.webhookDelivery.findMany({ where: { event: "alert.created" } });
    expect(deliveries).toHaveLength(alerts.length);
    expect(JSON.stringify(deliveries.map((x) => x.payload))).toContain("New vendor: Kaveri Logistics");

    // Medium and high alerts email the owners and admins; low ones do not.
    const mails = ctx.sent.filter((m) => m.subject.includes("alert for AP bot"));
    expect(mails.map((m) => m.subject)).toEqual(["Medium alert for AP bot: New vendor: Kaveri Logistics"]);
    expect(mails[0]!.to).toBe(d.owner.email);
    expect(mails[0]!.text).toContain(`/alerts/${vendor[0]!.id}`);
  });

  it("the 5-minute job finds a volume spike and does not raise it twice", async () => {
    const d = await liveOrg();
    // Baseline: three earlier busy hours of 3 calls each.
    for (let i = 0; i < 9; i++) await tool(ctx.app, d.apiKey, "zoho.list_bills", {});
    const old = await d.db.receipt.findMany({ where: { tool: "zoho.list_bills" }, orderBy: { seq: "asc" } });
    for (const [i, r] of old.entries()) await d.db.receipt.updateMany({ where: { id: r.id }, data: { ts: new Date(Date.now() - (2 + Math.floor(i / 3)) * 86_400_000) } });
    for (let i = 0; i < 30; i++) await tool(ctx.app, d.apiKey, "zoho.list_bills", {});
    await settle();

    const first = await scanOrg(ctx.deps, d.org.id);
    expect(first.raised).toBeGreaterThanOrEqual(2);
    const spikes = await d.db.behaviourAlert.findMany({ where: { detector: "volume_spike" } });
    expect(spikes.map((s) => s.key).sort()).toEqual(["all", "tool:zoho.list_bills"]);
    expect(spikes.find((s) => s.key === "all")!.numbers).toMatchObject({ "calls in the last hour": 30, "typical calls per active hour": 3 });
    expect(spikes[0]!.explanation).toMatch(/^ap-bot made 30 calls/);

    // Running again (and the all-org job) changes nothing: one open alert per agent, detector and key.
    expect((await scanOrg(ctx.deps, d.org.id)).raised).toBe(0);
    await scanAll(ctx.deps);
    expect(await d.db.behaviourAlert.count({ where: { detector: "volume_spike" } })).toBe(2);
    // More calls update the open alert instead of opening another.
    await tool(ctx.app, d.apiKey, "zoho.list_bills", {});
    await settle();
    await scanOrg(ctx.deps, d.org.id);
    const all = await d.db.behaviourAlert.findFirstOrThrow({ where: { detector: "volume_spike", key: "all" } });
    expect(all.occurrences).toBe(2);
  });

  it("people acknowledge and resolve alerts, each with a receipt; a resolved alert is not raised again for the same receipts", async () => {
    const d = await liveOrg();
    await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_554", amount_inr: 500 });
    await settle();
    const alert = await d.db.behaviourAlert.findFirstOrThrow({ where: { detector: "new_counterparty" } });
    const url = `/internal/orgs/${d.org.id}/alerts/${alert.id}`;
    expect((await internal(ctx.app, "POST", url, { action: "acknowledge", actor: d.owner.email })).json()).toEqual({ ok: true, status: "acknowledged" });
    expect((await internal(ctx.app, "POST", url, { action: "acknowledge", actor: d.owner.email })).statusCode).toBe(409);
    expect((await internal(ctx.app, "POST", url, { action: "resolve", actor: d.owner.email })).json()).toEqual({ ok: true, status: "resolved" });
    expect((await internal(ctx.app, "POST", url, { action: "resolve", actor: d.owner.email })).statusCode).toBe(409);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/alerts/nope`, { action: "resolve", actor: d.owner.email })).statusCode).toBe(404);
    const row = await d.db.behaviourAlert.findFirstOrThrow({ where: { id: alert.id } });
    expect(row).toMatchObject({ status: "resolved", dedupeKey: null, acknowledgedBy: d.owner.email, resolvedBy: d.owner.email });
    expect((await adminReceipts(d.org.id, "alert.acknowledged")).map((r) => r.details?.alert_id)).toEqual([alert.id]);
    expect((await adminReceipts(d.org.id, "alert.resolved"))[0]!.actor).toBe(d.owner.email);
    // The job looks at the last hour again, but the same receipt is not alerted twice.
    await scanOrg(ctx.deps, d.org.id);
    expect(await d.db.behaviourAlert.count({ where: { detector: "new_counterparty" } })).toBe(1);
  });

  it("auto-pause: a high alert pauses the agent, with a receipt naming the alert", async () => {
    const d = await liveOrg();
    const off = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/auto-pause`, { autoPauseOnHigh: true, actor: d.owner.email });
    expect(off.json()).toEqual({ autoPauseOnHigh: true });
    expect((await adminReceipts(d.org.id, "agent.auto_pause_on")).length).toBe(1);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/nope/auto-pause`, { autoPauseOnHigh: true, actor: d.owner.email })).statusCode).toBe(404);
    for (let i = 0; i < 6; i++) await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 1000 });
    await settle();
    expect((await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } })).status).toBe("active");
    ctx.sent.length = 0;
    const big = gateMeta(await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 }));
    expect(big.decision).toBe("ask");
    await settle();

    const outlier = await d.db.behaviourAlert.findFirstOrThrow({ where: { detector: "amount_outlier" } });
    expect(outlier).toMatchObject({ severity: "high", autoPaused: true });
    expect((await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } })).status).toBe("paused");
    const paused = await adminReceipts(d.org.id, "agent.paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ actor: "Elan1 Govern", agent: "ap-bot", details: { reason: "auto-pause", alert_id: outlier.id, alert: outlier.title } });
    expect(receiptLine(paused[0]!)).toBe("Paused automatically after an alert");
    expect(ctx.sent.some((m) => m.subject.startsWith("High alert for AP bot") && m.text.includes("paused automatically"))).toBe(true);
    // The next call is refused: the pause is the existing kill switch.
    expect(gateMeta(await tool(ctx.app, d.apiKey, "zoho.list_bills", {})).rule_id).toBe("agent-paused");
  });

  it("an alert raised twice at once is stored once", async () => {
    const d = await liveOrg();
    const agent = await d.db.agent.findFirstOrThrow({ where: { id: d.agentId } });
    const f = { detector: "off_hours" as const, key: "hour:3", severity: "low" as const, title: "t", explanation: "e", numbers: {}, seqs: [] };
    const results = await Promise.all([raiseBehaviourAlert(ctx.deps, d.org.id, agent, f), raiseBehaviourAlert(ctx.deps, d.org.id, agent, f)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await d.db.behaviourAlert.count({ where: { key: "hour:3" } })).toBe(1);
  });

  it("alerts stay inside their organisation", async () => {
    const a = await liveOrg();
    const b = await liveOrg();
    await tool(ctx.app, a.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 1000 });
    await settle();
    const alert = await a.db.behaviourAlert.findFirstOrThrow();
    expect(await b.db.behaviourAlert.count()).toBe(0);
    expect(await actOnAlert(ctx.deps, b.org.id, alert.id, "resolve", b.owner.email)).toMatchObject({ ok: false, status: 404 });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${b.org.id}/alerts/${alert.id}`, { action: "acknowledge", actor: b.owner.email })).statusCode).toBe(404);
    expect((await a.db.behaviourAlert.findFirstOrThrow({ where: { id: alert.id } })).status).toBe("open");
  });

  it("settings are validated as a whole", async () => {
    const d = await demoOrg(ctx.deps);
    const bad = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/alert-settings`, { settings: { ...BEHAVIOUR_DEFAULTS, volumeSpike: { ...BEHAVIOUR_DEFAULTS.volumeSpike, high: 1 } }, actor: d.owner.email });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/high threshold/);
    const ok = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/alert-settings`, { settings: { ...BEHAVIOUR_DEFAULTS, learningDays: 3 }, actor: d.owner.email });
    expect(ok.statusCode).toBe(200);
    expect((await adminReceipts(d.org.id, "alerts.settings_updated")).at(-1)?.details).toMatchObject({ changed: "learningDays", learning_days: 3 });
  });

  it("skips receipts that are not decisions or come from a paused agent", async () => {
    const d = await liveOrg();
    const fake = { kind: "decision", agent: "ap-bot", tool: "x.y", decision: "refuse", rule_id: "agent-paused", seq: 1, ts: new Date().toISOString() } as Receipt;
    expect(await inlineBehaviourCheck(ctx.deps, d.org.id, [fake, { ...fake, kind: "admin" } as Receipt])).toBe(0);
    expect(await inlineBehaviourCheck(ctx.deps, d.org.id, [{ ...fake, agent: "nobody", rule_id: "default" } as Receipt])).toBe(0);
  });
});

describe("the guard with behaviour checks", () => {
  it("stays fast and fail-closed: a slow or broken check never delays or fails a call", async () => {
    const slow = await makeApp({ behaviourInline: () => new Promise((r) => setTimeout(r, 3000)) });
    const d = await demoOrg(slow.deps);
    const started = Date.now();
    expect(gateMeta(await tool(slow.app, d.apiKey, "zoho.list_bills", {})).decision).toBe("allow");
    expect(Date.now() - started).toBeLessThan(1500);
    await Promise.all([...slow.deps.background]);
    await slow.app.close();

    const broken = await makeApp({
      behaviourInline: () => {
        throw new Error("detector exploded");
      },
    });
    const e = await demoOrg(broken.deps);
    expect(gateMeta(await tool(broken.app, e.apiKey, "zoho.list_bills", {})).decision).toBe("allow");
    // The decision path itself is unchanged: unknown tools are still refused.
    expect(gateMeta(await tool(broken.app, e.apiKey, "gmail.delete_message", { message_id: "m_1" })).rule_id).toBe("default");
    await Promise.all([...broken.deps.background]);
    expect(broken.deps.alerts.some((a) => a.kind === "behaviour-check-failed" && a.orgId === e.org.id && a.message.includes("detector exploded"))).toBe(true);
    expect(await prisma.healthAlert.count({ where: { orgId: e.org.id, kind: "behaviour-check-failed" } })).toBeGreaterThan(0);
    await broken.app.close();
  });
});

describe("emergency stop", () => {
  it("pauses every agent at once, resumes only those it paused, with receipts, emails and a report", async () => {
    const d = await demoOrg(ctx.deps);
    const two = await createAgent(ctx.deps, d.org.id, { name: "Refund bot", slug: "refund-bot", purpose: "Refunds", ownerEmail: d.owner.email, createdById: d.owner.id, riskTier: "low", actor: d.owner.email });
    const three = await createAgent(ctx.deps, d.org.id, { name: "Old bot", slug: "old-bot", purpose: "Old", ownerEmail: d.owner.email, createdById: d.owner.id, riskTier: "low", actor: d.owner.email });
    if (!two.ok || !three.ok) throw new Error("agents");
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${three.agent.id}/status`, { status: "paused", actor: d.owner.email });
    await tool(ctx.app, d.apiKey, "zoho.list_bills", {});
    ctx.sent.length = 0;

    const stop = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/emergency-stop`, { actor: d.owner.email, reason: "Unexpected payments" });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json()).toMatchObject({ ok: true, paused: 2 });
    expect(await d.db.agent.count({ where: { status: "active" } })).toBe(0);
    const stopReceipts = await adminReceipts(d.org.id, "emergency.stop");
    expect(stopReceipts).toHaveLength(1);
    expect(stopReceipts[0]).toMatchObject({ actor: d.owner.email, details: { count: 2, incident_id: stop.json().incidentId, reason: "Unexpected payments" } });
    expect(gateMeta(await tool(ctx.app, d.apiKey, "zoho.list_bills", {})).rule_id).toBe("agent-paused");
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/emergency-stop`, { actor: d.owner.email })).statusCode).toBe(409);
    await settle();
    expect(ctx.sent.filter((m) => m.subject === "Emergency stop: all agents are paused").map((m) => m.to)).toEqual([d.owner.email]);

    // Resume starts only the two agents the stop paused; the one paused earlier stays paused.
    const resume = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/emergency-stop/resume`, { actor: d.owner.email });
    expect(resume.json()).toMatchObject({ ok: true, resumed: 2 });
    expect((await d.db.agent.findFirstOrThrow({ where: { id: three.agent.id } })).status).toBe("paused");
    expect(await d.db.agent.count({ where: { status: "active" } })).toBe(2);
    expect((await adminReceipts(d.org.id, "emergency.resumed"))[0]).toMatchObject({ details: { count: 2 } });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/emergency-stop/resume`, { actor: d.owner.email })).statusCode).toBe(409);
    const incident = await d.db.incident.findFirstOrThrow({ where: { id: stop.json().incidentId } });
    expect(incident).toMatchObject({ status: "closed", startedBy: d.owner.email, endedBy: d.owner.email, resumedCount: 2 });
    expect(incident.endSeq).toBeGreaterThan(incident.startSeq!);

    const pdf = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/incidents/${incident.id}/report`, { actor: d.owner.email });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await adminReceipts(d.org.id, "evidence.exported")).at(-1)?.details).toMatchObject({ kind: "incident-report", incident_id: incident.id });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/incidents/nope/report`, { actor: d.owner.email })).statusCode).toBe(404);
    // Another org cannot see or end this org's incident.
    const other = await demoOrg(ctx.deps);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${other.org.id}/incidents/${incident.id}/report`, { actor: other.owner.email })).statusCode).toBe(404);
  });

  it("an open stop shows in the report as still paused", async () => {
    const d = await demoOrg(ctx.deps);
    const stop = (await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/emergency-stop`, { actor: d.owner.email })).json();
    const pdf = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/incidents/${stop.incidentId}/report`, { actor: d.owner.email });
    expect(pdf.statusCode).toBe(200);
    const w = incidentWindow({ startedAt: new Date(1_000_000_000), endedAt: null }, new Date(2_000_000_000));
    expect(w).toEqual({ from: new Date(1_000_000_000 - 3_600_000), to: new Date(2_000_000_000) });
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/emergency-stop/resume`, { actor: d.owner.email });
  });
});
