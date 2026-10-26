import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { forOrg } from "@gate/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Deps, JobQueue } from "../src/deps";
import {
  backoffSeconds,
  BlockedAddressError,
  checkWebhookUrl,
  deliverWebhook,
  describeError,
  eventsFor,
  isPrivateAddress,
  MAX_ATTEMPTS,
  postJson,
  signWebhook,
} from "../src/webhooks";
import { demoOrg, gateMeta, internal, makeApp, tool } from "./helpers";

interface Hit {
  headers: IncomingMessage["headers"];
  body: string;
}

let hits: Hit[] = [];
let status = 200;
let server: Server;
let base: string;
const sent: { queue: string; data: object; opts?: { startAfter?: number; singletonKey?: string } }[] = [];
const queue: JobQueue = { send: async (q, data, opts) => void sent.push({ queue: q, data, opts }) };
let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/hang") return; // never answers
      hits.push({ headers: req.headers, body });
      res.writeHead(req.url === "/redirect" ? 302 : status, req.url === "/redirect" ? { location: "http://169.254.169.254/" } : {}).end("ignored");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx = await makeApp({ queue });
});
afterAll(async () => {
  await ctx.app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  hits = [];
  status = 200;
  sent.length = 0;
});

const settle = (deps: Deps) => Promise.all([...deps.background]);
const mac = (secret: string, t: string, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

async function withHook(events = ["receipt.created", "approval.pending", "approval.resolved"], path = "/hook") {
  const d = await demoOrg(ctx.deps);
  await settle(ctx.deps);
  const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks`, { url: `${base}${path}`, events, actor: d.owner.email });
  expect(res.statusCode).toBe(200);
  const { id, secret } = res.json() as { id: string; secret: string };
  await settle(ctx.deps);
  const db = forOrg(d.org.id);
  // The endpoint is told about its own webhook.created receipt; start each test from a clean slate.
  expect(await db.webhookDelivery.count({ where: { event: "receipt.created" } })).toBe(events.includes("receipt.created") ? 1 : 0);
  await db.webhookDelivery.deleteMany({});
  return { d, id, secret, db };
}

describe("webhook admin", () => {
  it("creates an endpoint, shows the secret once, stores it encrypted and writes admin receipts", async () => {
    const { d, id, secret, db } = await withHook(["receipt.created"]);
    expect(secret).toMatch(/^whsec_/);
    const row = await db.webhook.findFirstOrThrow({ where: { id } });
    expect(row.secretEnc).not.toContain(secret);
    expect(row.events).toEqual(["receipt.created"]);
    const created = await db.receipt.findFirstOrThrow({ where: { action: "webhook.created" } });
    expect(created.body).toMatchObject({ details: { webhook_id: id, host: new URL(base).host, events: "receipt.created" } });
    expect(JSON.stringify(created.body)).not.toContain("/hook");

    const del = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks/${id}/delete`, { actor: d.owner.email });
    expect(del.json()).toEqual({ deleted: true });
    expect(await db.webhook.count()).toBe(0);
    expect(await db.webhookDelivery.count()).toBe(0);
    expect(await db.receipt.count({ where: { action: "webhook.deleted" } })).toBe(1);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks/${id}/delete`, { actor: d.owner.email })).statusCode).toBe(404);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks/${id}/test`, { actor: d.owner.email })).statusCode).toBe(404);
  });

  it("validates URLs and events", async () => {
    const d = await demoOrg(ctx.deps);
    const post = (body: unknown) => internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks`, body);
    expect((await post({ url: "ftp://x.example/", events: ["receipt.created"], actor: d.owner.email })).json().error).toMatch(/https:\/\//);
    expect((await post({ url: "https://u:p@x.example/", events: ["receipt.created"], actor: d.owner.email })).json().error).toMatch(/credentials/);
    expect((await post({ url: "not a url", events: ["receipt.created"], actor: d.owner.email })).statusCode).toBe(400);
    expect((await post({ url: "https://x.example/", events: ["nope"], actor: d.owner.email })).statusCode).toBe(400);
    expect((await post({ url: "https://x.example/", events: [], actor: d.owner.email })).statusCode).toBe(400);
  });
});

describe("delivery", () => {
  it("receipt.created: enqueued after commit, signed Stripe-style, delivered once", async () => {
    const { d, secret, db } = await withHook(["receipt.created"]);
    sent.length = 0;
    await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });
    await settle(ctx.deps);
    const rows = await db.webhookDelivery.findMany({ where: { event: "receipt.created" } });
    expect(rows).toHaveLength(1);
    expect(sent).toEqual([{ queue: "webhook-deliver", data: { orgId: d.org.id, deliveryId: rows[0]!.id }, opts: { singletonKey: `${rows[0]!.id}:0` } }]);

    expect(await deliverWebhook(ctx.deps, d.org.id, rows[0]!.id)).toBe("delivered");
    expect(await deliverWebhook(ctx.deps, d.org.id, rows[0]!.id)).toBe("skipped");
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.headers["content-type"]).toBe("application/json");
    expect(h.headers["gate-event"]).toBe("receipt.created");
    expect(h.headers["gate-delivery"]).toBe(rows[0]!.id);
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(h.headers["gate-signature"]))!;
    expect(m).not.toBeNull();
    expect(m[2]).toBe(mac(secret, m[1]!, h.body));
    const body = JSON.parse(h.body);
    expect(body).toMatchObject({ id: rows[0]!.id, type: "receipt.created", org: d.org.id, data: { kind: "decision", tool: "gmail.read_message", decision: "allow" } });
    const after = await db.webhookDelivery.findFirstOrThrow({ where: { id: rows[0]!.id } });
    expect(after).toMatchObject({ status: "delivered", attempts: 1, responseStatus: 200, lastError: null, nextAttemptAt: null });
  });

  it("approval.pending and approval.resolved", async () => {
    const { d, db } = await withHook(["approval.pending", "approval.resolved"]);
    const held = gateMeta(await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 }));
    await settle(ctx.deps);
    const pending = await db.webhookDelivery.findFirstOrThrow({ where: { event: "approval.pending" } });
    expect(pending.payload).toMatchObject({ approval_id: held.approval_id, status: "pending", rule_id: "pay-large", expires_at: expect.any(String) });
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${held.approval_id as string}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "rejected" });
    await settle(ctx.deps);
    const resolved = await db.webhookDelivery.findFirstOrThrow({ where: { event: "approval.resolved" } });
    expect(resolved.payload).toMatchObject({ approval_id: held.approval_id, status: "rejected", by: d.owner.email, outcome: { status: "not_run" } });
    expect(await db.webhookDelivery.count({ where: { event: "receipt.created" } })).toBe(0);
  });

  it("retries with backoff, then gives up after 8 attempts", async () => {
    const { d, db, id } = await withHook(["receipt.created"]);
    status = 500;
    await tool(ctx.app, d.apiKey, "gmail.search", { query: "x" });
    await settle(ctx.deps);
    const row = await db.webhookDelivery.findFirstOrThrow({ where: { webhookId: id, event: "receipt.created" } });
    sent.length = 0;
    expect(await deliverWebhook(ctx.deps, d.org.id, row.id)).toBe("retrying");
    let r = await db.webhookDelivery.findFirstOrThrow({ where: { id: row.id } });
    expect(r).toMatchObject({ status: "pending", attempts: 1, responseStatus: 500, lastError: "the endpoint answered HTTP 500" });
    expect(r.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(sent[0]).toMatchObject({ queue: "webhook-deliver", opts: { startAfter: 30, singletonKey: `${row.id}:1` } });
    // Not due yet: another worker skips it.
    expect(await deliverWebhook(ctx.deps, d.org.id, row.id)).toBe("skipped");
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      await db.webhookDelivery.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      expect(await deliverWebhook(ctx.deps, d.org.id, row.id)).toBe(i === MAX_ATTEMPTS ? "failed" : "retrying");
    }
    r = await db.webhookDelivery.findFirstOrThrow({ where: { id: row.id } });
    expect(r).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, nextAttemptAt: null });
    expect(hits).toHaveLength(MAX_ATTEMPTS);
  });

  it("does not follow redirects, and a turned-off endpoint fails at once", async () => {
    const { d, db, id } = await withHook(["receipt.created"], "/redirect");
    const test = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks/${id}/test`, { actor: d.owner.email });
    expect(test.json()).toMatchObject({ outcome: "retrying" });
    expect((await db.webhookDelivery.findFirstOrThrow({ where: { event: "webhook.test" } })).lastError).toBe("the endpoint answered HTTP 302");
    await db.webhook.update({ where: { id }, data: { active: false } });
    const t2 = await db.webhookDelivery.create({ data: { orgId: d.org.id, webhookId: id, event: "webhook.test", payload: {}, nextAttemptAt: new Date() } });
    expect(await deliverWebhook(ctx.deps, d.org.id, t2.id)).toBe("failed");
    expect((await db.webhookDelivery.findFirstOrThrow({ where: { id: t2.id } })).lastError).toBe("the endpoint is turned off");
    // Inactive endpoints get no new events.
    await tool(ctx.app, d.apiKey, "gmail.search", { query: "x" });
    await settle(ctx.deps);
    expect(await db.webhookDelivery.count({ where: { event: "receipt.created" } })).toBe(0);
  });

  it("the test event is delivered at once", async () => {
    const { d, id, secret } = await withHook(["receipt.created"]);
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/webhooks/${id}/test`, { actor: d.owner.email });
    expect(res.json()).toMatchObject({ deliveryId: expect.any(String), outcome: "delivered" });
    const h = hits.at(-1)!;
    expect(JSON.parse(h.body)).toMatchObject({ type: "webhook.test", data: { message: expect.stringMatching(/test event/) } });
    const [, t, v] = /^t=(\d+),v1=(.+)$/.exec(String(h.headers["gate-signature"]))!;
    expect(v).toBe(mac(secret, t!, h.body));
  });

  it("SSRF: private addresses are refused when WEBHOOK_ALLOW_PRIVATE is off", async () => {
    const { d, id, db } = await withHook(["receipt.created"]);
    const strict = { ...ctx.deps, env: { ...ctx.deps.env, WEBHOOK_ALLOW_PRIVATE: false } };
    const row = await db.webhookDelivery.create({ data: { orgId: d.org.id, webhookId: id, event: "webhook.test", payload: {}, nextAttemptAt: new Date() } });
    expect(await deliverWebhook(strict, d.org.id, row.id)).toBe("retrying");
    expect((await db.webhookDelivery.findFirstOrThrow({ where: { id: row.id } })).lastError).toMatch(/private or reserved/);
    // A host name that resolves to loopback is refused after DNS, too.
    const named = new URL(base.replace("127.0.0.1", "localhost"));
    await expect(postJson(named, "{}", {}, { allowPrivate: false })).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(postJson(new URL("http://[::1]:9/"), "{}", {}, { allowPrivate: false })).rejects.toBeInstanceOf(BlockedAddressError);
    expect(hits).toHaveLength(0);
    // Allowed in development: the same host name connects.
    expect((await postJson(named, "{}", {}, { allowPrivate: true })).status).toBe(200);
  });

  it("times out and describes network errors without details", async () => {
    await expect(postJson(new URL(`${base}/hang`), "{}", {}, { allowPrivate: true, timeoutMs: 200 })).rejects.toSatisfy((e: unknown) => describeError(e) === "no response within 10 seconds");
    const refused = await postJson(new URL("http://127.0.0.1:9/"), "{}", {}, { allowPrivate: true }).catch((e: unknown) => e);
    expect(describeError(refused)).toBe("the connection was refused");
    const missing = await postJson(new URL("http://does-not-exist.invalid/"), "{}", {}, { allowPrivate: true }).catch((e: unknown) => e);
    expect(describeError(missing)).toBe("the host name could not be resolved");
    expect(describeError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("the connection was reset");
    expect(describeError(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toBe("the TLS certificate was not accepted");
    expect(describeError(Object.assign(new Error("x"), { code: "EPIPE" }))).toBe("network error (EPIPE)");
    expect(describeError(new Error("x"))).toBe("network error");
  });
});

describe("helpers", () => {
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "not-an-ip", "fe80::1%eth0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("checks URLs, backs off, signs and maps receipts to events", () => {
    expect(checkWebhookUrl("https://siem.example.com/in?token=x")).toMatchObject({ ok: true });
    expect(checkWebhookUrl(`https://x.example/${"a".repeat(2001)}`)).toMatchObject({ ok: false, error: "The URL is too long." });
    expect([1, 2, 3, 7, 20].map(backoffSeconds)).toEqual([30, 60, 120, 1920, 21600]);
    const sig = signWebhook("s", "{}", 1_700_000_000_000);
    expect(sig).toBe(`t=1700000000,v1=${mac("s", "1700000000", "{}")}`);
    const base = { seq: 1, ts: "t", org: "o", prev_hash: "p", hash: "h", sig: "s" };
    expect(eventsFor({ ...base, kind: "admin", action: "x" }).map((e) => e.event)).toEqual(["receipt.created"]);
    expect(eventsFor({ ...base, kind: "decision", decision: "ask", approval: { id: "a", result: "pending" } }).map((e) => e.event)).toEqual(["receipt.created", "approval.pending"]);
    expect(eventsFor({ ...base, kind: "approval", ref_seq: 1, approval: { id: "a", result: "approved", by: "x@y.in", at: "t", self_approval: true }, outcome: { status: "ok" } })[1]).toMatchObject({
      event: "approval.resolved",
      payload: { approval_id: "a", status: "approved", self_approval: true, held_seq: 1 },
    });
  });
});
