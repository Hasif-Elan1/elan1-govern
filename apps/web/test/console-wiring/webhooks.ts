import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encrypt } from "@gate/core";
import { forOrg } from "@gate/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lastReceipt, type Doc, type Harness } from "./harness";

// a made-up 16-hex secret for the form checks, built at run time so the secret scanners see no literal
const FAKE_SECRET = Array.from({ length: 8 }, (_, i) => (0xa1 + i * 0x11).toString(16).slice(-2)).join("");

// Exports › Webhooks, Channels › Slack and You › Approve in WhatsApp on the real Webhook, WebhookDelivery,
// WebhookSecretRoll, ChatChannel and ChatNumber rows (apps/web/src/server/console-overrides/wiring/webhooks.ts).
// Deliveries and WhatsApp's API go to a server on 127.0.0.1; nothing leaves this machine.
const ORG = "org_demo";
const OWNER = "u_ananya";
const ADMIN = "u_rahul";
const APPROVER = "u_venkat";
const VIEWER = "u_meera";

interface Hit {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Endpoint = { id: string; url: string; status: string; secretPrefix: string; deliveries: { id: string; event: string; status: number; attempts: number }[] };
const mac = (secret: string, t: string, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const endpointsOf = (d: Doc) => d.webhooks as Endpoint[];

export function webhookCases(h: Harness) {
  let server: Server;
  let base: string;
  let hits: Hit[] = [];
  let status = 200;
  const db = forOrg(ORG);
  const gateEnv = () => (h.gate.deps as unknown as { env: Record<string, unknown> }).env;
  let whatsappUrl: unknown;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ url: req.url ?? "", headers: req.headers, body });
        // the stand-in for Meta's Graph API: a sent message's id
        if (req.url?.startsWith("/v21.0/")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ messages: [{ id: "wamid.test" }] }));
        res.writeHead(status).end("ignored");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    whatsappUrl = gateEnv().WHATSAPP_API_URL;
    gateEnv().WHATSAPP_API_URL = `${base}/v21.0`;
    // what an earlier run of this file left behind
    await db.webhook.deleteMany({});
    await db.chatChannel.deleteMany({});
    await db.chatNumber.deleteMany({});
    await h.reset(ORG);
  });
  afterAll(async () => {
    gateEnv().WHATSAPP_API_URL = whatsappUrl;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    hits = [];
    status = 200;
  });

  describe("webhooks on the real Webhook and WebhookDelivery rows", () => {
    it("adds an endpoint as an owner or admin: it lands in Webhook, its receipt names the host only, and the state shows it", async () => {
      const url = `https://127.0.0.1:${new URL(base).port}/hook?token=hidden-from-receipts`;
      const viewer = await h.rpc("orgApi.addWebhook", [ORG, url, ["receipt.created"], VIEWER], VIEWER);
      expect(viewer.status).toBe(400);
      expect(viewer.body.error).toMatch(/owners and admins can do this/);
      expect((await h.rpc("orgApi.addWebhook", [ORG, url.replace("https", "http"), ["receipt.created"], ADMIN], ADMIN)).body.error).toMatch(/https:\/\//);
      const other = await h.rpc("orgApi.addWebhook", [ORG, url, ["receipt.created", "stop.engaged"], ADMIN], ADMIN);
      expect(other.status).toBe(400);
      expect(other.body.error).toMatch(/does not send stop\.engaged/);
      expect(await db.webhook.count()).toBe(0);

      const ok = await h.rpc("orgApi.addWebhook", [ORG, url, ["receipt.created", "approval.pending"], OWNER], ADMIN);
      expect(ok.status, ok.body.error).toBe(200);
      const r = ok.body.result as { webhook: Endpoint; secret: string; seq: number };
      expect(r.secret).toMatch(/^whsec_/);
      const row = await db.webhook.findFirstOrThrow({ where: { id: r.webhook.id } });
      expect(row).toMatchObject({ events: ["receipt.created", "approval.pending"], active: true, secretPrefix: r.secret.slice(0, 10), createdBy: ADMIN });
      expect(row.secretEnc).not.toContain(r.secret);
      expect(r.webhook).toMatchObject({ id: row.id, status: "active", secretPrefix: r.secret.slice(0, 10) });

      const { status: code, doc } = await h.state(ORG, ADMIN);
      expect(code).toBe(200);
      expect(endpointsOf(doc).map((w) => w.id)).toEqual([row.id]);
      const receipt = doc.receipts.find((x) => x.seq === r.seq);
      expect(receipt).toMatchObject({ action: "webhook.added", actor: ADMIN, details: { webhook_id: row.id, host: new URL(url).host } });
      expect(JSON.stringify(receipt)).not.toContain("hidden-from-receipts");
      // the same URL twice is refused
      expect((await h.rpc("orgApi.addWebhook", [ORG, url, ["receipt.created"], ADMIN], ADMIN)).body.error).toMatch(/already has an endpoint/);
      expect(await db.webhook.count()).toBe(1);
    });

    it("tests, rolls the secret, turns off and on, replays and resends on the real rows, as an owner or admin", async () => {
      // an endpoint on this machine over plain http, as the web app's own route may add one (the console's form asks for https)
      const { gate } = await import("../../src/server/gate");
      const made = await gate<{ id: string; secret: string }>("POST", `/internal/orgs/${ORG}/webhooks`, { url: `${base}/local`, events: ["receipt.created"], actor: "rahul.menon@demotraders.in" });
      expect(made.status).toBe(200);
      const { id, secret } = made.data;

      // everyone who sees the screen reads the endpoints; only owners and admins act on them
      const read = await h.rpc("orgApi.webhooks", [ORG], VIEWER);
      expect(read.status, read.body.error).toBe(200);
      expect((read.body.result as { endpoints: Endpoint[] }).endpoints.map((w) => w.id)).toContain(id);
      expect((await h.rpc("orgApi.sendTestEvent", [ORG, id, VIEWER], VIEWER)).body.error).toMatch(/owners and admins can do this/);

      const tested = await h.rpc("orgApi.sendTestEvent", [ORG, id, ADMIN], ADMIN);
      expect(tested.status, tested.body.error).toBe(200);
      const delivery = tested.body.result as { id: string; event: string; status: number; attempts: number };
      expect(delivery).toMatchObject({ event: "webhook.test", status: 200, attempts: 1 });
      const hit = hits.find((x) => x.url === "/local")!;
      const [, t, v] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hit.headers["gate-signature"]))!;
      expect(v).toBe(mac(secret, t!, hit.body));
      expect(await db.webhookDelivery.findFirstOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: "delivered", responseStatus: 200 });
      expect(endpointsOf((await h.state(ORG, ADMIN)).doc).find((w) => w.id === id)?.deliveries.find((x) => x.id === delivery.id)).toMatchObject({ id: delivery.id, status: 200 });

      // a rolled secret: shown once, and the previous one still signs, as a second v1 value
      const rolled = await h.rpc("orgApi.rollSecret", [ORG, id, ADMIN], OWNER);
      expect(rolled.status, rolled.body.error).toBe(200);
      const roll = rolled.body.result as { secret: string; previousValidUntil: string; seq: number };
      expect(roll.secret).not.toBe(secret);
      expect((await db.webhook.findFirstOrThrow({ where: { id } })).secretPrefix).toBe(roll.secret.slice(0, 10));
      let doc = (await h.state(ORG, OWNER)).doc;
      expect(doc.orgSettings.secretRolls[0]).toMatchObject({ webhookId: id, newPrefix: roll.secret.slice(0, 10), previousPrefix: secret.slice(0, 10), by: OWNER, seq: roll.seq });
      expect(lastReceipt(doc, "webhook.secret_rolled")).toMatchObject({ seq: roll.seq, actor: OWNER, details: { webhook_id: id, previous_valid_until: roll.previousValidUntil } });
      hits = [];
      expect((await h.rpc("orgApi.sendTestEvent", [ORG, id, ADMIN], ADMIN)).status).toBe(200);
      const both = /^t=(\d+),v1=([0-9a-f]{64}),v1=([0-9a-f]{64})$/.exec(String(hits[0]!.headers["gate-signature"]))!;
      expect([both[2], both[3]]).toEqual([mac(roll.secret, both[1]!, hits[0]!.body), mac(secret, both[1]!, hits[0]!.body)]);

      // off: nothing is sent to it
      const off = await h.rpc("orgApi.setWebhookStatus", [ORG, id, "disabled", ADMIN], ADMIN);
      expect(off.status, off.body.error).toBe(200);
      expect((await db.webhook.findFirstOrThrow({ where: { id } })).active).toBe(false);
      doc = (await h.state(ORG, ADMIN)).doc;
      expect(endpointsOf(doc).find((w) => w.id === id)?.status).toBe("disabled");
      expect(lastReceipt(doc, "webhook.disabled")).toMatchObject({ seq: (off.body.result as { seq: number }).seq, actor: ADMIN });
      expect((await h.rpc("orgApi.sendTestEvent", [ORG, id, ADMIN], ADMIN)).body.error).toMatch(/Enable the endpoint first/);

      // back on, and failing: the console shows it as failing, and a delivery that gave up as a dead letter
      expect((await h.rpc("orgApi.setWebhookStatus", [ORG, id, "active", ADMIN], ADMIN)).status).toBe(200);
      status = 503;
      const failing = (await h.rpc("orgApi.sendTestEvent", [ORG, id, ADMIN], ADMIN)).body.result as { id: string; status: number };
      expect(failing.status).toBe(503);
      expect(endpointsOf((await h.state(ORG, ADMIN)).doc).find((w) => w.id === id)?.status).toBe("failing");
      await db.webhookDelivery.updateMany({ where: { id: failing.id }, data: { status: "failed", attempts: 8, nextAttemptAt: null } });
      const listed = (await h.rpc("orgApi.webhooks", [ORG], ADMIN)).body.result as { deadLetter: { id: string; webhookId: string; lastStatus: number }[] };
      expect(listed.deadLetter).toContainEqual(expect.objectContaining({ id: failing.id, webhookId: id, lastStatus: 503 }));
      expect((await h.state(ORG, ADMIN)).doc.orgSettings.deadLetter.map((x: { id: string }) => x.id)).toContain(failing.id);

      status = 200;
      expect((await h.rpc("orgApi.replayDeadLetters", [ORG, VIEWER, id], VIEWER)).status).toBe(400);
      const replayed = await h.rpc("orgApi.replayDeadLetters", [ORG, ADMIN, id], ADMIN);
      expect(replayed.status, replayed.body.error).toBe(200);
      expect(replayed.body.result).toMatchObject({ ok: 1, failed: 0 });
      expect(await db.webhookDelivery.findFirstOrThrow({ where: { id: failing.id } })).toMatchObject({ status: "delivered", responseStatus: 200 });
      doc = (await h.state(ORG, ADMIN)).doc;
      expect(doc.orgSettings.deadLetter.map((x: { id: string }) => x.id)).not.toContain(failing.id);
      expect(lastReceipt(doc, "webhook.dead_letter_replayed")).toMatchObject({ actor: ADMIN, details: { delivered: 1, failed: 0 } });

      // a resend goes out under the delivery's own id
      hits = [];
      const resent = await h.rpc("orgApi.resendDelivery", [ORG, id, delivery.id, ADMIN], ADMIN);
      expect(resent.status, resent.body.error).toBe(200);
      expect(resent.body.result).toMatchObject({ id: delivery.id, status: 200 });
      expect(JSON.parse(hits[0]!.body)).toMatchObject({ id: delivery.id, type: "webhook.test" });
      expect((await h.rpc("orgApi.resendDelivery", [ORG, id, "del_missing", ADMIN], ADMIN)).body.error).toMatch(/no longer in the log/);

      // and deleting it removes the row, its deliveries and its rolls
      expect((await h.rpc("orgApi.deleteWebhook", [ORG, id, VIEWER], VIEWER)).status).toBe(400);
      const del = await h.rpc("orgApi.deleteWebhook", [ORG, id, ADMIN], ADMIN);
      expect(del.status, del.body.error).toBe(200);
      expect(await db.webhook.count({ where: { id } })).toBe(0);
      expect(await db.webhookSecretRoll.count({ where: { webhookId: id } })).toBe(0);
      doc = (await h.state(ORG, ADMIN)).doc;
      expect(endpointsOf(doc).map((w) => w.id)).not.toContain(id);
      expect(lastReceipt(doc, "webhook.deleted")).toMatchObject({ seq: (del.body.result as { seq: number }).seq, actor: ADMIN, details: { webhook_id: id } });
      expect((await h.rpc("orgApi.deleteWebhook", [ORG, id, ADMIN], ADMIN)).body.error).toMatch(/no longer exists/);
    });

    it("keeps each organisation's endpoints to itself", async () => {
      const mine = await db.webhook.findMany({ select: { id: true } });
      expect(mine.length).toBeGreaterThan(0);
      // another organisation's people cannot reach these at the door
      expect((await h.rpc("orgApi.webhooks", [ORG], "u_rohan")).status).toBe(403);
      expect((await h.rpc("orgApi.deleteWebhook", [ORG, mine[0]!.id, "u_rohan"], "u_rohan")).status).toBe(403);
      // and their own organisation's list never holds them
      const theirs = await h.rpc("orgApi.webhooks", ["org_northbank"], "u_rohan");
      expect(theirs.status, theirs.body.error).toBe(200);
      const ids = (theirs.body.result as { endpoints: Endpoint[] }).endpoints.map((w) => w.id);
      for (const m of mine) expect(ids).not.toContain(m.id);
      // nor can they act on them through their own organisation
      expect((await h.rpc("orgApi.deleteWebhook", ["org_northbank", mine[0]!.id, "u_rohan"], "u_rohan")).body.error).toMatch(/no longer exists/);
      expect(await db.webhook.count({ where: { id: mine[0]!.id } })).toBe(1);
    });
  });

  describe("Slack on the real ChatChannel", () => {
    it("shows the real connection, disconnects it as an owner or admin, and asks for the app's credentials to connect", async () => {
      await db.chatChannel.create({ data: { orgId: ORG, kind: "slack", config: { channelId: "C0123456789", teamId: "T0DEMO42", teamName: "Demo Traders" }, secretsEnc: "not-read-here", createdBy: OWNER } });
      const notify = await h.rpc("orgApi.notify", [ORG], VIEWER);
      expect(notify.status, notify.body.error).toBe(200);
      expect((notify.body.result as { slack: Record<string, unknown> }).slack).toMatchObject({ connected: true, workspace: "Demo Traders", team: "T0DEMO42", channelId: "C0123456789" });
      expect((await h.state(ORG, VIEWER)).doc.orgSettings.notify.slack).toMatchObject({ connected: true, workspace: "Demo Traders" });

      const viewer = await h.rpc("orgApi.completeSlackInstall", [ORG, VIEWER, { state: "x", decision: "allow", workspace: "Demo" }], VIEWER);
      expect(viewer.body.error).toMatch(/owners and admins can do this/);
      const noToken = await h.rpc("orgApi.completeSlackInstall", [ORG, ADMIN, { state: "x", decision: "allow", workspace: "Demo" }], ADMIN);
      expect(noToken.status).toBe(400);
      expect(noToken.body.error).toMatch(/bot token .*signing secret .*approvals channel/);
      const badToken = await h.rpc("orgApi.completeSlackInstall", [ORG, ADMIN, { state: "x", decision: "allow", workspace: "Demo", botToken: "nope", signingSecret: FAKE_SECRET, channelId: "C0123456789" }], ADMIN);
      expect(badToken.body.error).toMatch(/xoxb-/);

      expect((await h.rpc("orgApi.disconnectSlack", [ORG, VIEWER], VIEWER)).status).toBe(400);
      const off = await h.rpc("orgApi.disconnectSlack", [ORG, ADMIN], ADMIN);
      expect(off.status, off.body.error).toBe(200);
      expect(await db.chatChannel.count({ where: { kind: "slack" } })).toBe(0);
      const doc = (await h.state(ORG, ADMIN)).doc;
      expect(doc.orgSettings.notify.slack.connected).toBe(false);
      expect(lastReceipt(doc, "channel.slack_disconnected")).toMatchObject({ seq: (off.body.result as { seq: number }).seq, actor: ADMIN, details: { workspace: "Demo Traders", team: "T0DEMO42" } });
      expect((await h.rpc("orgApi.disconnectSlack", [ORG, ADMIN], ADMIN)).body.error).toMatch(/not connected/);
    });
  });

  describe("an approver's own WhatsApp number on the real ChatNumber", () => {
    it("sends a code through the organisation's number, verifies it, and forgets it; the document holds no digits", async () => {
      // the organisation has not connected WhatsApp yet
      const none = await h.rpc("orgApi.sendWhatsAppCode", [ORG, APPROVER, "+91 98450 11203"], APPROVER);
      expect(none.status).toBe(400);
      expect(none.body.error).toMatch(/WhatsApp is not connected for this organisation/);
      // a viewer decides nothing, so has no number to verify
      expect((await h.rpc("orgApi.sendWhatsAppCode", [ORG, VIEWER, "+91 98450 11203"], VIEWER)).body.error).toMatch(/can do this; your role cannot/);

      const key = process.env.GATE_MASTER_KEY!;
      await db.chatChannel.create({
        data: { orgId: ORG, kind: "whatsapp", config: { phoneNumberId: "1234567890" }, secretsEnc: encrypt(key, JSON.stringify({ accessToken: "test-access-token-0123456789", appSecret: FAKE_SECRET }), `chat-secrets:${ORG}:whatsapp`), createdBy: OWNER },
      });
      const sent = await h.rpc("orgApi.sendWhatsAppCode", [ORG, OWNER, "+91 98450 11203"], APPROVER);
      expect(sent.status, sent.body.error).toBe(200);
      expect(sent.body.result).toEqual({ sentTo: "•••• 1203" });
      const msg = hits.find((x) => x.url === "/v21.0/1234567890/messages")!;
      const code = /code is (\d{6})/.exec(JSON.parse(msg.body).text.body as string)![1]!;
      expect(await db.chatNumber.findFirstOrThrow({ where: { userId: APPROVER } })).toMatchObject({ last4: "1203", verifiedAt: null });
      expect((await h.rpc("orgApi.whatsapp", [ORG, APPROVER], APPROVER)).body.result).toMatchObject({ number: "•••• 1203", verified: false, pending: { attempts: 0 } });

      expect((await h.rpc("orgApi.verifyWhatsAppCode", [ORG, APPROVER, code === "000000" ? "111111" : "000000"], APPROVER)).body.error).toMatch(/not right/);
      const ok = await h.rpc("orgApi.verifyWhatsAppCode", [ORG, APPROVER, code], APPROVER);
      expect(ok.status, ok.body.error).toBe(200);
      expect((await db.chatNumber.findFirstOrThrow({ where: { userId: APPROVER } })).verifiedAt).not.toBeNull();
      let doc = (await h.state(ORG, VIEWER)).doc;
      expect(doc.members.find((m: { userId: string }) => m.userId === APPROVER)?.whatsappVerified).toBe(true);
      expect(doc.orgSettings.whatsapp[APPROVER]).toMatchObject({ verifiedAt: expect.any(String) });
      expect(JSON.stringify(doc.orgSettings.whatsapp)).not.toContain("1203");
      expect(lastReceipt(doc, "chat.number_verified")).toMatchObject({ seq: (ok.body.result as { seq: number }).seq, actor: APPROVER });
      expect((await h.rpc("orgApi.whatsapp", [ORG, APPROVER], APPROVER)).body.result).toEqual({ number: "•••• 1203", verified: true });

      const forgot = await h.rpc("orgApi.forgetWhatsApp", [ORG, APPROVER], APPROVER);
      expect(forgot.status, forgot.body.error).toBe(200);
      expect(await db.chatNumber.count({ where: { userId: APPROVER } })).toBe(0);
      doc = (await h.state(ORG, APPROVER)).doc;
      expect(doc.members.find((m: { userId: string }) => m.userId === APPROVER)?.whatsappVerified).toBe(false);
      expect(lastReceipt(doc, "chat.number_removed")).toMatchObject({ seq: (forgot.body.result as { seq: number }).seq, actor: APPROVER });
    });
  });
}
