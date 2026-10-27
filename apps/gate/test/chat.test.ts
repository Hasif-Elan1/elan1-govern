import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mockState } from "@gate/connectors";
import type { Receipt } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { expireDue } from "../src/approvals";
import { chatFetch, normalizeNumber, outcomeLine, summaryFields, type ApprovalView } from "../src/chat/common";
import { CHAT_QUEUE, deliverChatMessage, sweepChat } from "../src/chat/outbox";
import { slackApprovalMessage, verifySlackSignature } from "../src/chat/slack";
import { decisionOf, verifyMetaSignature, whatsAppApprovalMessage } from "../src/chat/whatsapp";
import type { Deps, JobQueue } from "../src/deps";
import { readGateEnv } from "../src/env";
import { demoOrg, env, gateMeta, internal, makeUser, tool } from "./helpers";

// ---- Fake Slack Web API and Meta Graph API on one local server ----

interface Call {
  path: string;
  auth?: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let slackUsers: Record<string, { email: string; confirmed?: boolean; bot?: boolean }> = {};
let failNext: { status: number; body: object } | null = null;
let fake: Server;
let base: string;
let tsCounter = 1000;
const SHORT_KEY_S = "s";
const SHORT_KEY_K = "k";

const SIGNING = "8f742231b10e8888abcd99yyyzzz85a5".replace(/[yz]/g, "0");
const BOT = ["xoxb", "1234567890", "abcdefghij"].join("-");
const APP_SECRET = "0123456789abcdef".repeat(2); // gitleaks:allow (made-up test secret)
const WA_TOKEN = "EAAG" + "testaccesstoken0123456789"; // gitleaks:allow (made-up test token)
const PNID = "1098765432109";

const queued: { queue: string; data: object }[] = [];
const queue: JobQueue = { send: async (q, data) => void queued.push({ queue: q, data }) };
let ctx: { app: Awaited<ReturnType<typeof buildApp>>["app"]; deps: Deps };

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      let body: Record<string, unknown> = {};
      if (raw && (req.headers["content-type"] ?? "").includes("json")) body = JSON.parse(raw) as Record<string, unknown>;
      else if (raw) body = Object.fromEntries(new URLSearchParams(raw));
      calls.push({ path: url.pathname + url.search, auth: req.headers.authorization, body });
      const send = (status: number, obj: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));
      if (failNext) {
        const f = failNext;
        failNext = null;
        return send(f.status, f.body);
      }
      const p = url.pathname;
      if (p.startsWith("/api/")) {
        if (req.headers.authorization !== `Bearer ${BOT}`) return send(200, { ok: false, error: "invalid_auth" });
        const m = p.slice(5);
        if (m === "auth.test") return send(200, { ok: true, team_id: "T0ACME", team: "Acme", user_id: "UBOT" });
        if (m === "users.info") {
          const u = slackUsers[String(body.user)];
          if (!u) return send(200, { ok: false, error: "user_not_found" });
          return send(200, { ok: true, user: { id: body.user, is_bot: !!u.bot, is_email_confirmed: u.confirmed ?? true, profile: { email: u.email } } });
        }
        if (m === "chat.postMessage") return send(200, { ok: true, channel: body.channel, ts: `${tsCounter++}.0001` });
        if (m === "chat.update" || m === "chat.postEphemeral") return send(200, { ok: true });
        return send(404, { ok: false, error: "unknown_method" });
      }
      if (p.startsWith("/v21.0/")) {
        if (req.headers.authorization !== `Bearer ${WA_TOKEN}`) return send(401, { error: { code: 190, message: "bad token for +919999999999" } });
        if (p === `/v21.0/${PNID}`) return send(200, { id: PNID });
        if (p === `/v21.0/${PNID}/messages`) return send(200, { messaging_product: "whatsapp", messages: [{ id: `wamid.${tsCounter++}` }] });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const built = await buildApp({ ...env, SLACK_API_URL: `${base}/api`, WHATSAPP_API_URL: `${base}/v21.0` }, { mailer: { send: async () => undefined }, queue });
  await built.app.ready();
  ctx = built;
});
afterAll(async () => {
  await ctx.app.close();
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
});
beforeEach(() => {
  calls = [];
  queued.length = 0;
  failNext = null;
});

const settle = () => Promise.all([...ctx.deps.background]);
/** Runs background work and every due chat message until nothing is left. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    while (ctx.deps.background.size) await settle();
    if (!(await sweepChat(ctx.deps))) return;
  }
}
const slackCalls = (m: string) => calls.filter((c) => c.path === `/api/${m}`);
const waSends = () => calls.filter((c) => c.path === `/v21.0/${PNID}/messages`);

const rulebook = (owner: string, approvers: string[]) => `version: 1
agent: ap-bot
owner: ${owner}
default: refuse
approvers:
  finance: [ ${approvers.join(", ")} ]
rules:
  - { id: read-mail, tool: gmail.read_message, decide: allow }
  - { id: pay-mid, tool: zoho.record_bill_payment, when: { amount_inr: { gt: 50000, lte: 500000 } }, decide: ask, approver: finance, approve_in_chat: true }
  - { id: pay-big, tool: zoho.record_bill_payment, when: { amount_inr: { gt: 500000 } }, decide: ask, approver: finance }
`;

async function setup(opts: { slack?: boolean; whatsapp?: boolean } = { slack: true }) {
  const d = await demoOrg(ctx.deps);
  const approver = await makeUser("approver");
  await prisma.membership.create({ data: { orgId: d.org.id, userId: approver.id, role: "approver" } });
  const pub = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/rulebooks`, { yaml: rulebook(d.owner.email, [d.owner.email, approver.email]), actor: d.owner.email });
  expect(pub.statusCode, pub.body).toBe(200);
  let slackId = "";
  let waId = "";
  let verifyToken = "";
  if (opts.slack) {
    const r = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/slack`, { botToken: BOT, signingSecret: SIGNING, channelId: "C0APPROVALS", actor: d.owner.email });
    expect(r.statusCode, r.body).toBe(200);
    slackId = (r.json() as { id: string }).id;
    expect(r.json()).toMatchObject({ url: `${env.GATE_PUBLIC_URL}/chat/slack/${slackId}/interactions`, team: "Acme" });
  }
  if (opts.whatsapp) {
    const r = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp`, { phoneNumberId: PNID, accessToken: WA_TOKEN, appSecret: APP_SECRET, actor: d.owner.email });
    expect(r.statusCode, r.body).toBe(200);
    ({ id: waId, verifyToken } = r.json() as { id: string; verifyToken: string });
  }
  await settle();
  calls = [];
  return { d, approver, slackId, waId, verifyToken };
}

async function hold(d: Awaited<ReturnType<typeof demoOrg>>, amount = 200000) {
  const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: amount });
  const m = gateMeta(r);
  expect(m).toMatchObject({ status: "pending" });
  await drain();
  return m.approval_id as string;
}

function slackSign(body: string, ts = Math.floor(Date.now() / 1000), secret = SIGNING) {
  return { ts: String(ts), sig: `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}` };
}

async function click(slackId: string, approvalId: string, opts: { user?: string; team?: string; action?: string; ts?: number; secret?: string; sig?: string } = {}) {
  const payload = {
    type: "block_actions",
    team: { id: opts.team ?? "T0ACME" },
    user: { id: opts.user ?? "UOWNER" },
    channel: { id: "C0APPROVALS" },
    actions: [{ action_id: opts.action ?? "gate_approve", value: approvalId }],
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const s = slackSign(body, opts.ts, opts.secret);
  return ctx.app.inject({
    method: "POST",
    url: `/chat/slack/${slackId}/interactions`,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": s.ts, "x-slack-signature": opts.sig ?? s.sig },
    payload: body,
  });
}

async function approvalReceipts(orgId: string, approvalId: string) {
  return (await forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt).filter((r) => r.approval?.id === approvalId);
}

describe("Slack", () => {
  it("connect stores the secrets encrypted and refuses bad input", async () => {
    const { d } = await setup();
    const row = await forOrg(d.org.id).chatChannel.findFirstOrThrow({ where: { kind: "slack" } });
    expect(row.secretsEnc).not.toContain(BOT);
    expect(row.secretsEnc).not.toContain(SIGNING);
    expect(row.config).toMatchObject({ channelId: "C0APPROVALS", teamId: "T0ACME" });
    const bad = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/slack`, { botToken: "xoxp-nope", signingSecret: SIGNING, channelId: "C0APPROVALS", actor: d.owner.email });
    expect(bad.statusCode).toBe(400);
    const wrong = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/slack`, { botToken: "xoxb-9999999999-wrongtoken", signingSecret: SIGNING, channelId: "C0APPROVALS", actor: d.owner.email });
    expect(wrong.json()).toMatchObject({ error: expect.stringMatching(/invalid_auth/) });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/slack`, { botToken: BOT, signingSecret: "zz", channelId: "C0APPROVALS", actor: d.owner.email })).statusCode).toBe(400);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/slack`, { botToken: BOT, signingSecret: SIGNING, channelId: "#general", actor: d.owner.email })).statusCode).toBe(400);
    // The internal API is signed.
    expect((await ctx.app.inject({ method: "POST", url: `/internal/orgs/${d.org.id}/chat/slack`, payload: {} })).statusCode).toBe(401);
  });

  it("posts with Approve/Reject when the rule allows chat approval, and only a link otherwise", async () => {
    const { d } = await setup();
    await hold(d, 200000);
    const [post] = slackCalls("chat.postMessage");
    expect(post?.body.channel).toBe("C0APPROVALS");
    const text = JSON.stringify(post?.body.blocks);
    expect(text).toContain("gate_approve");
    expect(text).toContain("gate_reject");
    expect(text).toContain("Open in Elan1 Govern");
    expect(text).toContain("Pay ₹2,00,000 to Sharma Traders");
    expect(text).toContain("pay-mid");
    expect(text).toContain("<!date^");

    calls = [];
    await hold(d, 600000);
    const big = JSON.stringify(slackCalls("chat.postMessage")[0]?.body.blocks);
    expect(big).not.toContain("gate_approve");
    expect(big).toContain("Open in Elan1 Govern");
    expect(big).toContain("can only be decided in Elan1 Govern");
    expect(queued.filter((q) => q.queue === CHAT_QUEUE).length).toBeGreaterThan(0);
  });

  it("a signed Approve from an approver resolves it, runs it, writes the receipt with the channel and updates the message", async () => {
    const { d, slackId } = await setup();
    slackUsers = { UOWNER: { email: d.owner.email.toUpperCase() } };
    const approvalId = await hold(d);
    const res = await click(slackId, approvalId);
    expect(res.statusCode).toBe(200);
    await drain();
    const a = await d.db.approval.findFirstOrThrow({ where: { id: approvalId } });
    expect(a).toMatchObject({ status: "approved", channel: "slack", channelUser: "T0ACME/UOWNER", resolvedBy: d.owner.email });
    expect(mockState(d.org.id).payments).toHaveLength(1);
    const rs = await approvalReceipts(d.org.id, approvalId);
    expect(rs.at(-1)).toMatchObject({ kind: "approval", approval: { result: "approved", by: d.owner.email }, details: { channel: "slack", channel_user: "T0ACME/UOWNER" } });
    const update = slackCalls("chat.update")[0];
    expect(update?.body.ts).toBeTruthy();
    expect(JSON.stringify(update?.body.blocks)).toContain("in Slack");
    expect(JSON.stringify(update?.body.blocks)).not.toContain("gate_approve");
    expect(slackCalls("chat.postEphemeral")[0]?.body.text).toMatch(/^Approved/);
  });

  it("Reject works the same way and runs nothing", async () => {
    const { d, slackId } = await setup();
    slackUsers = { UOWNER: { email: d.owner.email } };
    const approvalId = await hold(d);
    await click(slackId, approvalId, { action: "gate_reject" });
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("rejected");
    expect(mockState(d.org.id).payments).toHaveLength(0);
  });

  it("refuses a bad signature, an old timestamp and an unknown channel", async () => {
    const { d, slackId } = await setup();
    slackUsers = { UOWNER: { email: d.owner.email } };
    const approvalId = await hold(d);
    expect((await click(slackId, approvalId, { secret: "f".repeat(32) })).statusCode).toBe(401);
    expect((await click(slackId, approvalId, { sig: "v0=abc" })).statusCode).toBe(401);
    const old = await click(slackId, approvalId, { ts: Math.floor(Date.now() / 1000) - 301 });
    expect(old.statusCode).toBe(401);
    expect(old.json()).toEqual({ error: "request too old" });
    const future = await click(slackId, approvalId, { ts: Math.floor(Date.now() / 1000) + 400 });
    expect(future.statusCode).toBe(401);
    const noHeaders = await ctx.app.inject({ method: "POST", url: `/chat/slack/${slackId}/interactions`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "payload=%7B%7D" });
    expect(noHeaders.statusCode).toBe(401);
    expect((await click("nope", approvalId)).statusCode).toBe(404);
    expect((await click("bad id!", approvalId)).statusCode).toBe(404);
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("pending");
  });

  it("rejects a signed but malformed payload and ignores other interactions", async () => {
    const { slackId } = await setup();
    const body = "payload=not-json";
    const s = slackSign(body);
    const r = await ctx.app.inject({ method: "POST", url: `/chat/slack/${slackId}/interactions`, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": s.ts, "x-slack-signature": s.sig }, payload: body });
    expect(r.statusCode).toBe(400);
    expect((await click(slackId, "apr_x", { action: "gate_open" })).statusCode).toBe(200);
    expect((await click(slackId, "bad value!", {})).statusCode).toBe(200);
    await drain();
    expect(slackCalls("users.info")).toHaveLength(0);
  });

  it("a double click (and a replay inside the window) resolves once", async () => {
    const { d, slackId } = await setup();
    slackUsers = { UOWNER: { email: d.owner.email } };
    const approvalId = await hold(d);
    const [a, b] = await Promise.all([click(slackId, approvalId), click(slackId, approvalId, { action: "gate_reject" })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    await drain();
    await click(slackId, approvalId);
    await drain();
    const rs = (await approvalReceipts(d.org.id, approvalId)).filter((r) => r.kind === "approval");
    expect(rs).toHaveLength(1);
    expect(mockState(d.org.id).payments.length).toBeLessThanOrEqual(1);
    expect(slackCalls("chat.postEphemeral").some((c) => /already|Someone else/.test(String(c.body.text)))).toBe(true);
  });

  it("refuses non-approvers, unconfirmed emails, bots and strangers with an ephemeral reply", async () => {
    const { d, slackId } = await setup();
    const viewer = await makeUser("viewer");
    await prisma.membership.create({ data: { orgId: d.org.id, userId: viewer.id, role: "viewer" } });
    slackUsers = { UVIEW: { email: viewer.email }, UUNCONF: { email: d.owner.email, confirmed: false }, UBOT: { email: d.owner.email, bot: true }, UNOBODY: { email: "nobody@else.test" } };
    const approvalId = await hold(d);
    for (const user of ["UVIEW", "UUNCONF", "UBOT", "UNOBODY", "UMISSING"]) {
      expect((await click(slackId, approvalId, { user })).statusCode).toBe(200);
    }
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("pending");
    const replies = slackCalls("chat.postEphemeral");
    expect(replies).toHaveLength(5);
    for (const r of replies) expect(String(r.body.text)).toMatch(/^You can't approve this here/);
  });

  it("refuses a member of another organisation, and clicks from another workspace", async () => {
    const { d, slackId } = await setup();
    const other = await setup();
    // The other org's owner is an approver there, not here.
    slackUsers = { UOTHER: { email: other.d.owner.email } };
    const approvalId = await hold(d);
    await click(slackId, approvalId, { user: "UOTHER" });
    // An approval id from another org through this org's Slack app is unknown here.
    const foreign = await hold(other.d);
    slackUsers.UOWNER = { email: d.owner.email };
    await click(slackId, foreign, { user: "UOWNER" });
    await click(slackId, approvalId, { user: "UOWNER", team: "T0EVIL" });
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("pending");
    expect((await other.d.db.approval.findFirstOrThrow({ where: { id: foreign } })).status).toBe("pending");
    expect(slackCalls("chat.postEphemeral").map((c) => c.body.text)).toEqual([expect.stringMatching(/^You can't approve/), expect.stringMatching(/^You can't approve/)]);
  });

  it("refuses an expired approval and refuses chat approval for an app-only rule", async () => {
    const { d, slackId } = await setup();
    slackUsers = { UOWNER: { email: d.owner.email } };
    const approvalId = await hold(d);
    await d.db.approval.update({ where: { id: approvalId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await click(slackId, approvalId);
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("expired");
    expect(slackCalls("chat.postEphemeral")[0]?.body.text).toMatch(/expired/);
    expect(JSON.stringify(slackCalls("chat.update")[0]?.body.blocks)).toContain("Nobody decided in time");

    calls = [];
    const appOnly = await hold(d, 600000);
    await click(slackId, appOnly);
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: appOnly } })).status).toBe("pending");
    expect(slackCalls("chat.postEphemeral")[0]?.body.text).toMatch(/can only be approved in Elan1 Govern/);
    // The web still decides it, and the Slack message is updated.
    const web = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${appOnly}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "rejected" });
    expect(web.statusCode).toBe(200);
    await drain();
    expect(await d.db.approval.findFirstOrThrow({ where: { id: appOnly } })).toMatchObject({ channel: "web", channelUser: null });
    expect((await approvalReceipts(d.org.id, appOnly)).at(-1)?.details).toEqual({ channel: "web" });
    expect(JSON.stringify(slackCalls("chat.update")[0]?.body.blocks)).toContain("in Elan1 Govern");
  });

  it("expiry by the background job also updates the message; a decision before posting skips the post", async () => {
    const { d } = await setup();
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 });
    const approvalId = gateMeta(r).approval_id as string;
    await settle();
    // Decided before the queued post ran.
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/approvals/${approvalId}/resolve`, { userId: d.owner.id, email: d.owner.email, result: "rejected" });
    await drain();
    expect(slackCalls("chat.postMessage")).toHaveLength(0);
    expect(await d.db.chatMessage.findFirstOrThrow({ where: { approvalId, kind: "slack.post" } })).toMatchObject({ status: "skipped" });

    const second = await hold(d);
    await d.db.approval.update({ where: { id: second }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireDue(ctx.deps)).toBeGreaterThanOrEqual(1);
    await drain();
    expect(slackCalls("chat.update")).toHaveLength(1);
  });

  it("retries Slack failures with backoff and gives up on permanent ones", async () => {
    const { d } = await setup();
    const r = await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 });
    const approvalId = gateMeta(r).approval_id as string;
    await settle();
    const msg = await d.db.chatMessage.findFirstOrThrow({ where: { approvalId } });
    failNext = { status: 500, body: {} };
    expect(await deliverChatMessage(ctx.deps, d.org.id, msg.id)).toBe("retrying");
    const after = await d.db.chatMessage.findFirstOrThrow({ where: { id: msg.id } });
    expect(after).toMatchObject({ status: "pending", attempts: 1, lastError: "Slack answered HTTP 500" });
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await deliverChatMessage(ctx.deps, d.org.id, msg.id)).toBe("skipped"); // not due yet
    await d.db.chatMessage.update({ where: { id: msg.id }, data: { nextAttemptAt: new Date() } });
    failNext = { status: 200, body: { ok: false, error: "channel_not_found" } };
    expect(await deliverChatMessage(ctx.deps, d.org.id, msg.id)).toBe("failed");
    expect((await d.db.chatMessage.findFirstOrThrow({ where: { id: msg.id } })).lastError).toBe("Slack said channel_not_found");
    // A failed doorbell never touches the approval itself.
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("pending");
  });

  it("disconnects, and the guard keeps working with no channel", async () => {
    const { d } = await setup();
    const r = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/slack/remove`, { actor: d.owner.email });
    expect(r.statusCode).toBe(200);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/slack/remove`, { actor: d.owner.email })).statusCode).toBe(404);
    await hold(d);
    expect(slackCalls("chat.postMessage")).toHaveLength(0);
    const receipts = (await forOrg(d.org.id).receipt.findMany()).map((x) => x.body as unknown as Receipt);
    expect(receipts.some((x) => x.action === "chat.disconnected")).toBe(true);
  });
});

describe("WhatsApp", () => {
  const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  async function verifiedApprover(d: Awaited<ReturnType<typeof demoOrg>>, userId: string, email: string, number: string) {
    const start = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId, number });
    expect(start.statusCode, start.body).toBe(200);
    const sent = waSends().at(-1)!;
    const code = /code is (\d{6})/.exec(JSON.stringify(sent.body))![1]!;
    const ok = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/confirm`, { userId, code, actor: email });
    expect(ok.statusCode, ok.body).toBe(200);
    calls = [];
  }

  function webhook(waId: string, from: string, replyId: string, opts: { ts?: number; secret?: string; type?: "interactive" | "button"; pnid?: string } = {}) {
    const message =
      opts.type === "button"
        ? { from, id: "wamid.in", timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)), type: "button", button: { payload: replyId, text: "Approve" } }
        : { from, id: "wamid.in", timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)), type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title: "Approve" } } };
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: opts.pnid ?? PNID }, messages: [message] } }] }] });
    return ctx.app.inject({ method: "POST", url: `/chat/whatsapp/${waId}/webhook`, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, opts.secret) }, payload: body });
  }

  it("webhook verification handshake", async () => {
    const { waId, verifyToken } = await setup({ whatsapp: true });
    expect(verifyToken).toMatch(/^wv_/);
    const ok = await ctx.app.inject({ method: "GET", url: `/chat/whatsapp/${waId}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=1158201444` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("1158201444");
    expect(ok.headers["content-type"]).toMatch(/text\/plain/);
    expect((await ctx.app.inject({ method: "GET", url: `/chat/whatsapp/${waId}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1` })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/chat/whatsapp/${waId}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=<script>` })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/chat/whatsapp/nope/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=1` })).statusCode).toBe(403);
  });

  it("number verification: code sent, hashed, single use, expiring, rate limited", async () => {
    const { d, approver } = await setup({ whatsapp: true });
    const bad = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: approver.id, number: "12345" });
    expect(bad.statusCode).toBe(400);
    const start = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: approver.id, number: "+91 98765 43210" });
    expect(start.json()).toEqual({ ok: true, last4: "3210", verified: false });
    const sent = waSends()[0]!;
    expect(sent.body).toMatchObject({ messaging_product: "whatsapp", to: "919876543210", type: "text" });
    const code = /code is (\d{6})/.exec(JSON.stringify(sent.body))![1]!;
    const row = await d.db.chatNumber.findFirstOrThrow({ where: { userId: approver.id } });
    expect(row.numberEnc).not.toContain("9876543210");
    expect(row.numberHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code);
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/confirm`, { userId: approver.id, code: wrong, actor: approver.email })).statusCode).toBe(400);
    const ok = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/confirm`, { userId: approver.id, code, actor: approver.email });
    expect(ok.json()).toEqual({ ok: true, last4: "3210", verified: true });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/confirm`, { userId: approver.id, code, actor: approver.email })).statusCode).toBe(404);
    // The receipt names a hash of the number, never the number.
    const receipts = JSON.stringify((await forOrg(d.org.id).receipt.findMany()).map((x) => x.body));
    expect(receipts).toContain("chat.number_verified");
    expect(receipts).not.toContain("9876543210");
    expect(receipts).not.toContain("3210\"");

    // Another member cannot claim the same number.
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: d.owner.id, number: "+919876543210" })).statusCode).toBe(409);
    // Codes per window, then attempts per code.
    for (let i = 0; i < 2; i++) expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: approver.id, number: "+919876543210" })).statusCode).toBe(200);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: approver.id, number: "+919876543210" })).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/confirm`, { userId: approver.id, code: "abc", actor: approver.email });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/confirm`, { userId: approver.id, code: "123456", actor: approver.email })).statusCode).toBe(429);
    // Expired codes.
    await d.db.chatNumber.update({ where: { id: row.id }, data: { codeAttempts: 0, codeExpires: new Date(Date.now() - 1) } });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/confirm`, { userId: approver.id, code: "123456", actor: approver.email })).statusCode).toBe(400);
    // Remove.
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/remove`, { userId: approver.id, actor: approver.email })).statusCode).toBe(200);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers/remove`, { userId: approver.id, actor: approver.email })).statusCode).toBe(404);
  });

  it("verification needs WhatsApp to be connected, and reports a failed send", async () => {
    const { d, approver } = await setup({ slack: false });
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: approver.id, number: "+919876500000" })).statusCode).toBe(409);
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp`, { phoneNumberId: PNID, accessToken: WA_TOKEN, appSecret: APP_SECRET, verifyTemplateName: "gate_code", actor: d.owner.email });
    failNext = { status: 400, body: { error: { code: 131026, message: "undeliverable to +919876500000" } } };
    const r = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: approver.id, number: "+919876500000" });
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain("9876500000");
    // With a verification template, the code goes in the template.
    const again = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp/numbers`, { userId: approver.id, number: "+919876500000" });
    expect(again.statusCode).toBe(200);
    expect(waSends().at(-1)?.body).toMatchObject({ type: "template", template: { name: "gate_code" } });
  });

  it("sends reply buttons only when allowed; a signed tap approves with the hashed number on the receipt", async () => {
    const { d, approver, waId } = await setup({ whatsapp: true });
    await verifiedApprover(d, approver.id, approver.email, "+919876543210");
    const approvalId = await hold(d, 200000);
    const msg = waSends()[0]!;
    expect(msg.body).toMatchObject({ to: "919876543210", type: "interactive" });
    expect(JSON.stringify(msg.body)).toContain(`approve:${approvalId}`);

    calls = [];
    await hold(d, 600000);
    expect(waSends()[0]?.body).toMatchObject({ type: "text" });
    expect(JSON.stringify(waSends()[0]?.body)).toContain("/approvals/apr_");

    calls = [];
    expect((await webhook(waId, "919876543210", `approve:${approvalId}`)).statusCode).toBe(200);
    await drain();
    const a = await d.db.approval.findFirstOrThrow({ where: { id: approvalId } });
    expect(a).toMatchObject({ status: "approved", channel: "whatsapp", resolvedBy: approver.email });
    expect(a.channelUser).toMatch(/^wa:[0-9a-f]{16}$/);
    const last = (await approvalReceipts(d.org.id, approvalId)).at(-1)!;
    expect(last.details).toEqual({ channel: "whatsapp", channel_user: a.channelUser });
    expect(JSON.stringify(last)).not.toContain("9876543210");
    expect(JSON.stringify(waSends()[0]?.body)).toContain("Approved. Elan1 Govern recorded");
  });

  it("uses the configured template for approvals, and template quick replies decide too", async () => {
    const { d, approver } = await setup({ slack: false });
    const c = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp`, { phoneNumberId: PNID, accessToken: WA_TOKEN, appSecret: APP_SECRET, templateName: "approval_waiting", templateLanguage: "en_US", actor: d.owner.email });
    const waId = (c.json() as { id: string }).id;
    calls = [];
    await verifiedApprover(d, approver.id, approver.email, "+447700900123");
    const approvalId = await hold(d);
    expect(waSends()[0]?.body).toMatchObject({ type: "template", template: { name: "approval_waiting", language: { code: "en_US" } } });
    expect(JSON.stringify(waSends()[0]?.body)).toContain(`reject:${approvalId}`);
    await webhook(waId, "447700900123", `reject:${approvalId}`, { type: "button" });
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("rejected");
  });

  it("refuses bad signatures, old messages, unknown numbers, app-only rules and double taps", async () => {
    const { d, approver, waId } = await setup({ whatsapp: true });
    await verifiedApprover(d, approver.id, approver.email, "+919876543210");
    const approvalId = await hold(d);
    calls = [];
    expect((await webhook(waId, "919876543210", `approve:${approvalId}`, { secret: "f".repeat(32) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: `/chat/whatsapp/${waId}/webhook`, headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(401);
    const malformed = JSON.stringify({ entry: "x" });
    expect((await ctx.app.inject({ method: "POST", url: `/chat/whatsapp/${waId}/webhook`, headers: { "content-type": "application/json", "x-hub-signature-256": sign(malformed) }, payload: malformed })).statusCode).toBe(400);
    expect((await webhook("nope", "919876543210", `approve:${approvalId}`)).statusCode).toBe(404);
    await webhook(waId, "919876543210", `approve:${approvalId}`, { ts: Math.floor(Date.now() / 1000) - 600 });
    await webhook(waId, "919999999999", `approve:${approvalId}`);
    await webhook(waId, "919876543210", `approve:${approvalId}`, { pnid: "555" });
    await webhook(waId, "919876543210", "hello");
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("pending");
    const replies = waSends().map((c) => JSON.stringify(c.body));
    expect(replies).toHaveLength(2);
    expect(replies[0]).toContain("too late");
    expect(replies[1]).toContain("You can't approve this here");

    calls = [];
    await Promise.all([webhook(waId, "919876543210", `approve:${approvalId}`), webhook(waId, "919876543210", `reject:${approvalId}`)]);
    await drain();
    expect((await approvalReceipts(d.org.id, approvalId)).filter((r) => r.kind === "approval")).toHaveLength(1);

    const appOnly = await hold(d, 600000);
    await webhook(waId, "919876543210", `approve:${appOnly}`);
    await drain();
    expect((await d.db.approval.findFirstOrThrow({ where: { id: appOnly } })).status).toBe("pending");
  });

  it("connect validates input and the token", async () => {
    const { d } = await setup({ slack: false });
    const post = (b: object) => internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/chat/whatsapp`, { phoneNumberId: PNID, accessToken: WA_TOKEN, appSecret: APP_SECRET, actor: d.owner.email, ...b });
    expect((await post({ phoneNumberId: "+91 98" })).statusCode).toBe(400);
    expect((await post({ accessToken: "short" })).statusCode).toBe(400);
    expect((await post({ appSecret: "nothex" })).statusCode).toBe(400);
    expect((await post({ templateName: "Bad Name" })).statusCode).toBe(400);
    expect((await post({ templateName: "ok_name", templateLanguage: "english" })).statusCode).toBe(400);
    const wrong = await post({ accessToken: "EAAGwrongtoken0123456789xx" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain("WhatsApp error 190");
    expect(wrong.body).not.toContain("9999999999");
    expect((await post({ phoneNumberId: "12345678" })).statusCode).toBe(400);
  });
});

describe("pieces", () => {
  const view: ApprovalView = { id: "apr_1", agent: "AP bot", action: "Pay <b>&", rule: "r", reason: "why", expiresAt: new Date(0), url: "http://w/approvals/apr_1", chatApproval: true, status: "pending" };
  it("signatures", () => {
    const now = 1_700_000_000_000;
    const body = "payload=x";
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key -- a made-up key for a signature test
    const sig = `v0=${createHmac("sha256", SHORT_KEY_S).update(`v0:1700000000:${body}`).digest("hex")}`;
    expect(verifySlackSignature("s", "1700000000", sig, body, now)).toBe("ok");
    expect(verifySlackSignature("s", "1700000000", sig, `${body}y`, now)).toBe("bad");
    expect(verifySlackSignature("s", "abc", sig, body, now)).toBe("bad");
    expect(verifySlackSignature("s", undefined, sig, body, now)).toBe("bad");
    expect(verifySlackSignature("s", "1700000000", sig, body, now + 301_000)).toBe("stale");
    expect(verifyMetaSignature("k", undefined, "b")).toBe(false);
    expect(verifyMetaSignature("k", "md5=x", "b")).toBe(false);
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key -- a made-up key for a signature test
    expect(verifyMetaSignature("k", `sha256=${createHmac("sha256", SHORT_KEY_K).update("b").digest("hex")}`, "b")).toBe(true);
  });
  it("messages escape text and show outcomes", () => {
    expect(JSON.stringify(slackApprovalMessage(view).blocks)).toContain("Pay &lt;b&gt;&amp;");
    const done = slackApprovalMessage({ ...view, status: "approved", resolvedBy: "a@b.in", channel: "email", outcome: "done" });
    expect(done.text).toContain("Approved by a@b.in from an email link. Result: done.");
    expect(outcomeLine({ ...view, status: "rejected" })).toBe("Rejected by an approver.");
    expect(outcomeLine(view)).toBe("Waiting for a decision.");
    expect(whatsAppApprovalMessage({ ...view, chatApproval: false }, { phoneNumberId: "1" })).toMatchObject({ type: "text" });
  });
  it("summary fields and numbers", () => {
    expect(summaryFields({ amount_inr: 200000, vendor: "Sharma" })).toEqual({ amount: "₹2,00,000", vendor: "Sharma" });
    expect(summaryFields({ amount: 12.5, vendor_id: "v1" })).toEqual({ amount: "12.5", vendor: "v1" });
    expect(summaryFields({})).toEqual({});
    expect(normalizeNumber("+91 (987) 654-3210")).toBe("919876543210");
    expect(normalizeNumber("0123")).toBeNull();
    expect(decisionOf({ from: "1", id: "x", timestamp: "1", type: "text" })).toBeNull();
    expect(decisionOf({ from: "1", id: "x", timestamp: "1", type: "button", button: { payload: "approve:apr_abc" } })).toEqual({ result: "approved", approvalId: "apr_abc" });
  });
  it("chatFetch never leaves the configured API", async () => {
    await expect(chatFetch(ctx.deps, "slack", "https://evil.example/x", { method: "GET" })).rejects.toThrow(/outside the Slack API/);
    await expect(chatFetch(ctx.deps, "whatsapp", "../../other", { method: "GET" })).rejects.toThrow(/outside the WhatsApp API/);
    await expect(chatFetch({ ...ctx.deps, env: { ...ctx.deps.env, SLACK_API_URL: "http://127.0.0.1:1/api" } }, "slack", "auth.test", { method: "POST" })).rejects.toThrow(/could not reach Slack/);
  });
  it("production only accepts slack.com and graph.facebook.com", () => {
    const prod = { ...process.env, APP_ENV: "production", GATE_MASTER_KEY: randomBytes(32).toString("hex"), INTERNAL_API_SECRET: randomBytes(32).toString("hex"), APPROVAL_LINK_SECRET: randomBytes(32).toString("hex") };
    expect(() => readGateEnv({ ...prod, SLACK_API_URL: "http://127.0.0.1/api" })).toThrow(/SLACK_API_URL: must be an https:\/\/slack.com/);
    expect(() => readGateEnv({ ...prod, WHATSAPP_API_URL: "https://graph.evil.com/v21.0" })).toThrow(/WHATSAPP_API_URL/);
    expect(readGateEnv({ ...prod, SLACK_API_URL: "", WHATSAPP_API_URL: "" }).SLACK_API_URL).toBe("https://slack.com/api");
  });
});
