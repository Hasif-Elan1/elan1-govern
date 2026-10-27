import { generateKeyPair, type Receipt } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { afterAll, describe, expect, it } from "vitest";
import { agentBehaviour, alertById, alertFilter, alertList, openAlertCounts, openIncident, orgBehaviourSettings } from "../src/server/alerts";
import { adminTitle } from "../src/server/queries";
import { WEBHOOK_EVENT_LABELS, WEBHOOK_EVENTS } from "../src/lib/webhooks";

afterAll(() => prisma.$disconnect());

const keys = generateKeyPair();
const newOrg = () => prisma.org.create({ data: { name: "Alerts Co", publicKey: keys.publicKeyPem, privateKeyEnc: "x" } });

async function seed() {
  const o = await newOrg();
  const db = forOrg(o.id);
  const agent = await db.agent.create({ data: { orgId: o.id, slug: "ap-bot", name: "AP bot", purpose: "Pays bills", ownerEmail: "o@x.in" } });
  const base = { orgId: o.id, agentId: agent.id, agentSlug: "ap-bot", explanation: "e", numbers: { calls: 3 }, seqs: [4, 5] };
  await db.behaviourAlert.create({ data: { ...base, detector: "new_tool", key: "tool:a", severity: "low", title: "Low one", createdAt: new Date(Date.now() - 3000) } });
  await db.behaviourAlert.create({ data: { ...base, detector: "volume_spike", key: "all", severity: "high", title: "High one", createdAt: new Date(Date.now() - 2000) } });
  await db.behaviourAlert.create({ data: { ...base, detector: "new_counterparty", key: "vendor:x", severity: "medium", title: "Medium one", status: "acknowledged" } });
  await db.behaviourAlert.create({ data: { ...base, detector: "off_hours", key: "hour:2", severity: "weird", title: "Resolved one", status: "resolved" } });
  return { o, agent, db };
}

describe("alerts in the console", () => {
  it("cleans filters from the query string", () => {
    expect(alertFilter({})).toEqual({ show: "open", severity: undefined, agent: undefined });
    expect(alertFilter({ show: "all", severity: "high", agent: "ap-bot" })).toEqual({ show: "all", severity: "high", agent: "ap-bot" });
    expect(alertFilter({ show: "x", severity: "urgent", agent: "Bad Slug!" })).toEqual({ show: "open", severity: undefined, agent: undefined });
  });

  it("lists open alerts most severe first, filters, and counts", async () => {
    const { o } = await seed();
    expect((await alertList(o.id)).map((a) => a.title)).toEqual(["High one", "Medium one", "Low one"]);
    expect((await alertList(o.id, { show: "all" })).map((a) => a.title)).toHaveLength(4);
    expect((await alertList(o.id, { show: "all", severity: "medium" })).map((a) => a.title)).toEqual(["Medium one"]);
    expect(await alertList(o.id, { agent: "other" })).toEqual([]);
    expect(await openAlertCounts(o.id)).toEqual({ total: 3, high: 1, medium: 1, low: 1 });
    const resolved = (await alertList(o.id, { show: "all" })).find((a) => a.status === "resolved")!;
    expect(resolved.severity).toBe("low"); // unknown severities show as low
    const one = await alertById(o.id, resolved.id);
    expect(one).toMatchObject({ detectorLabel: "Activity at an unusual time", numbers: { calls: 3 }, seqs: [4, 5], acknowledgedAt: null });
  });

  it("never shows another organisation's alerts or incidents", async () => {
    const { o } = await seed();
    const other = await newOrg();
    expect(await alertList(other.id, { show: "all" })).toEqual([]);
    expect(await alertById(other.id, (await alertList(o.id))[0]!.id)).toBeNull();
    await forOrg(o.id).incident.create({ data: { orgId: o.id, startedBy: "o@x.in", pausedAgentIds: [] } });
    expect(await openIncident(o.id)).not.toBeNull();
    expect(await openIncident(other.id)).toBeNull();
  });

  it("shows an agent's learning status and recent alerts", async () => {
    const { o, agent, db } = await seed();
    let b = await agentBehaviour(o.id, agent);
    expect(b.learning.label).toBe("Learning: 0 of 7 days");
    expect(b.open).toBe(3);
    expect(b.recent).toHaveLength(4);
    await db.receipt.create({ data: { orgId: o.id, seq: 1, ts: new Date(Date.now() - 3.2 * 86_400_000), kind: "decision", agent: "ap-bot", tool: "x.y", decision: "allow", body: {}, hash: "h" } });
    b = await agentBehaviour(o.id, agent);
    expect(b.learning.label).toBe("Learning: 3 of 7 days");
    await db.org.update({ where: { id: o.id }, data: { behaviourSettings: { learningDays: 2 } } });
    expect((await agentBehaviour(o.id, agent)).learning.label).toBe("Learning complete");
    expect((await orgBehaviourSettings(o.id)).settings.learningDays).toBe(2);
  });

  it("describes the new setup changes in plain words", () => {
    const r = (action: string, details: Record<string, unknown> = {}, agent = "ap-bot") => adminTitle({ kind: "admin", action, details, agent } as unknown as Receipt);
    expect(r("alert.created", { severity: "medium", title: "New vendor: Sharma Traders" })).toBe("Raised a medium alert for ap-bot: New vendor: Sharma Traders");
    expect(r("alert.created", { title: "X" })).toBe("Raised an alert for ap-bot: X");
    expect(r("alert.acknowledged", { title: "X" })).toBe("Acknowledged the alert for ap-bot: X");
    expect(r("alert.resolved", { title: "X" })).toBe("Resolved the alert for ap-bot: X");
    expect(r("alerts.settings_updated")).toBe("Changed the alert settings");
    expect(r("agent.auto_pause_on")).toBe("Turned on automatic pause for ap-bot");
    expect(r("agent.auto_pause_off")).toBe("Turned off automatic pause for ap-bot");
    expect(r("agent.paused", { reason: "auto-pause" })).toBe("Paused ap-bot automatically after a high alert");
    expect(r("agent.paused")).toBe("Paused ap-bot");
    expect(r("emergency.stop", { count: 3 }, "")).toBe("Emergency stop: paused 3 agents");
    expect(r("emergency.stop", { count: 1 }, "")).toBe("Emergency stop: paused 1 agent");
    expect(r("emergency.resumed", { count: 2 }, "")).toBe("Resumed 2 agents after the emergency stop");
  });

  it("offers the alert webhook event", () => {
    expect(WEBHOOK_EVENTS).toContain("alert.created");
    expect(WEBHOOK_EVENT_LABELS["alert.created"].label).toBe("Unusual behaviour alert");
  });
});
