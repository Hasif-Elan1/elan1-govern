import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { forOrg } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDemoHistory } from "../src/demo/history";
import { noQueue } from "../src/deps";
import { QUEUES, runLogged, startJobs, sweepWebhooks, type Jobs } from "../src/jobs";
import { demoOrg, gateMeta, internal, makeApp, tool } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
let jobs: Jobs;
let server: Server;
let base: string;
const bodies: string[] = [];
const logs: { obj: Record<string, unknown>; msg: string }[] = [];

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(b);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx = await makeApp();
  const log = ctx.deps.log;
  ctx.deps.log = Object.assign(Object.create(log), {
    info: (obj: Record<string, unknown>, msg: string) => void logs.push({ obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => void logs.push({ obj, msg }),
  });
  jobs = await startJobs(ctx.deps, { pollingIntervalSeconds: 0.5 });
}, 60_000);

afterAll(async () => {
  await jobs?.stop();
  await ctx.app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("background jobs (pg-boss)", () => {
  it("registers the cron schedules in the database", async () => {
    const names = (await jobs.boss.getSchedules()).map((s) => s.name).sort();
    expect(names).toEqual([QUEUES.anchors, QUEUES.behaviour, QUEUES.checkpoints, QUEUES.expire, QUEUES.sweep, QUEUES.replayPurge, QUEUES.suggestions].sort());
    expect(names).toEqual([QUEUES.behaviour, QUEUES.checkpoints, QUEUES.expire, QUEUES.sweep, QUEUES.replayPurge, QUEUES.suggestions, QUEUES.egressPurge].sort());
    expect(ctx.deps.queue).not.toBe(noQueue);
  });

  it("the expiry job expires due approvals and logs without personal data", async () => {
    const d = await demoOrg(ctx.deps);
    const held = gateMeta(await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 }));
    await d.db.approval.updateMany({ where: { id: held.approval_id as string }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await jobs.boss.send(QUEUES.expire, {});
    await until(async () => (await d.db.approval.findFirst({ where: { id: held.approval_id as string, status: "expired" } })) ?? null);
    const line = await until(async () => logs.find((l) => l.obj.job === QUEUES.expire && typeof l.obj.expired === "number"));
    expect(line.msg).toBe("job done");
    expect(JSON.stringify(line.obj)).not.toMatch(/@/);
  });

  it("the checkpoint job signs every org's chain head", async () => {
    const d = await demoOrg(ctx.deps);
    await jobs.boss.send(QUEUES.checkpoints, {});
    await until(async () => (await d.db.checkpoint.count()) > 0);
  });

  it("the nightly suggestions job looks at every org and logs only a count", async () => {
    const d = await demoOrg(ctx.deps);
    await addDemoHistory(ctx.deps, d.org.id, d.owner.email);
    await d.db.ruleSuggestion.deleteMany({});
    await jobs.boss.send(QUEUES.suggestions, {});
    await until(async () => (await d.db.ruleSuggestion.count({ where: { status: "new" } })) > 0);
    const line = await until(async () => logs.find((l) => l.obj.job === QUEUES.suggestions && typeof l.obj.open === "number"));
    expect(JSON.stringify(line.obj)).not.toMatch(/@/);
  });

  it("webhook deliveries go through the queue", async () => {
    const d = await demoOrg(ctx.deps);
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks`, { url: `${base}/in`, events: ["receipt.created"], actor: d.owner.email });
    expect(res.statusCode).toBe(200);
    await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    await Promise.all([...ctx.deps.background]);
    const db = forOrg(d.org.id);
    await until(async () => (await db.webhookDelivery.count({ where: { status: "delivered" } })) >= 2);
    expect(bodies.some((b) => b.includes('"tool":"gmail.read_message"'))).toBe(true);
  });

  it("the sweep picks up deliveries whose job was lost", async () => {
    const d = await demoOrg(ctx.deps);
    const db = forOrg(d.org.id);
    const hook = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks`, { url: `${base}/sweep`, events: ["approval.pending"], actor: d.owner.email });
    const row = await db.webhookDelivery.create({ data: { orgId: d.org.id, webhookId: hook.json().id, event: "webhook.test", payload: {}, nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await sweepWebhooks(ctx.deps)).toBeGreaterThanOrEqual(1);
    expect((await db.webhookDelivery.findFirstOrThrow({ where: { id: row.id } })).status).toBe("delivered");
  });

  it("a failing job is logged and rethrown", async () => {
    await expect(runLogged(ctx.deps, "test-queue", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(logs.some((l) => l.obj.job === "test-queue" && l.msg === "job failed")).toBe(true);
    await runLogged(ctx.deps, "test-void", async () => undefined);
    expect(logs.some((l) => l.obj.job === "test-void" && l.msg === "job done")).toBe(true);
  });
});
