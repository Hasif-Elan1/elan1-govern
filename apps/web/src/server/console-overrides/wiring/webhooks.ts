import "server-only";
import { forOrg } from "@gate/db";
import { maskedNumber, SlackBody } from "@/lib/notifications";
import { docOf, iso, override, requireFresh, requireRole, touch, wire, type Ctx, type Doc } from "./common";

/*
 * The console's webhook and chat-channel screens on the real backends (wiring, area 4):
 *  - Exports › Webhooks: endpoints, deliveries, dead letters and rolled secrets are the real Webhook,
 *    WebhookDelivery and WebhookSecretRoll rows; add, enable/disable, delete, test, resend, replay and roll go to
 *    the gate (apps/gate/src/wiring/webhooks.ts). The console's own outbox (syncOutbox) never runs: the gate
 *    fans every receipt out to the endpoints itself.
 *  - Channels › Slack: connected or not is the real ChatChannel; disconnecting removes it. Connecting needs the
 *    Slack app's bot token, signing secret and channel id, which the console's install dialog does not ask for.
 *  - You › Approve in WhatsApp: the person's number is the real ChatNumber (the code goes out through the
 *    organisation's WhatsApp number and is never shown here).
 * The document is brought in line after each of these, so the screens' synchronous reads (d.webhooks, the
 * dead-letter list, notify.slack, a member's whatsappVerified) show the real rows.
 * Left to the document (no real counterpart yet): the Slack install's state value, the approvals channel name,
 * email on/off and the routing table, and each person's "Slack linked" flag.
 */

const OWNER_ADMIN = ["owner", "admin"] as const;
/** The real route for an approver's own number asks for approvals:decide. */
const DECIDERS = ["owner", "admin", "approver"] as const;
const DELIVERIES_SHOWN = 50;
const DEAD_LETTERS_SHOWN = 300;

interface ConsoleDelivery {
  id: string;
  event: string;
  ts: string;
  status: number;
  attempts: number;
  ms: number;
}

interface ConsoleWebhook {
  id: string;
  url: string;
  events: string[];
  status: "active" | "failing" | "disabled";
  secretPrefix: string;
  createdAt: string;
  deliveries: ConsoleDelivery[];
}

type DeliveryRow = { id: string; event: string; status: string; attempts: number; responseStatus: number | null; deliveredAt: Date | null; createdAt: Date; payload: unknown };

/** The organisation's settings document (orgApi.orgState creates it on first read). */
const settings = (ctx: Ctx): Doc => (ctx.domain as unknown as { orgApi: { orgState(orgId: string): Doc } }).orgApi.orgState(ctx.orgId);

/** The HTTP status the console shows: what the endpoint answered, 200 for a delivery without one recorded, 0 for none yet. */
const httpStatus = (d: DeliveryRow) => d.responseStatus ?? (d.status === "delivered" ? 200 : 0);

const consoleDelivery = (d: DeliveryRow): ConsoleDelivery => ({ id: d.id, event: d.event, ts: (d.deliveredAt ?? d.createdAt).toISOString(), status: httpStatus(d), attempts: d.attempts, ms: 0 });

/** The receipt seq an event's payload names (the receipt itself, or the approval's). */
function seqOf(payload: unknown): number | undefined {
  const p = payload as { seq?: unknown; receipt_seq?: unknown } | null;
  const s = typeof p?.seq === "number" ? p.seq : p?.receipt_seq;
  return typeof s === "number" ? s : undefined;
}

/** Failing: the endpoint's most recent attempt failed (it gave up, or is being retried). Deliveries not tried yet say nothing. */
const failing = (rows: readonly DeliveryRow[]) => {
  const tried = rows.find((r) => r.attempts > 0);
  return !!tried && tried.status !== "delivered";
};

/** Read the real endpoints, deliveries, dead letters and rolls, and put them in the document. */
async function refreshWebhooks(ctx: Ctx) {
  const db = forOrg(ctx.orgId);
  const hooks = await db.webhook.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, url: true, events: true, active: true, secretPrefix: true, createdAt: true } });
  const select = { id: true, event: true, status: true, attempts: true, responseStatus: true, deliveredAt: true, createdAt: true, payload: true, webhookId: true } as const;
  const endpoints: ConsoleWebhook[] = [];
  for (const h of hooks) {
    const rows = await db.webhookDelivery.findMany({ where: { webhookId: h.id }, orderBy: { createdAt: "desc" }, take: DELIVERIES_SHOWN, select });
    endpoints.push({
      id: h.id,
      url: h.url,
      events: h.events,
      status: !h.active ? "disabled" : failing(rows) ? "failing" : "active",
      secretPrefix: h.secretPrefix,
      createdAt: h.createdAt.toISOString(),
      deliveries: rows.map(consoleDelivery),
    });
  }
  const urls = new Map(hooks.map((h) => [h.id, h.url]));
  const dead = await db.webhookDelivery.findMany({ where: { status: "failed" }, orderBy: { createdAt: "desc" }, take: DEAD_LETTERS_SHOWN, select });
  const rolls = await db.webhookSecretRoll.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, webhookId: true, previousPrefix: true, validUntil: true, createdBy: true, createdAt: true } });

  const d = docOf(ctx);
  const receipts = d.receipts as { seq: number; action?: string; details?: Record<string, unknown> }[];
  const rolledSeq = new Map(receipts.filter((r) => r.action === "webhook.secret_rolled").map((r) => [String(r.details?.roll_id ?? ""), r.seq]));
  // each roll's new prefix: the endpoint's current one for its newest roll, else the previous one of the roll after it
  const nextPrefix = new Map<string, string>();
  const s = settings(ctx);
  d.webhooks = endpoints;
  s.deadLetter = dead.map((x) => ({
    id: x.id,
    webhookId: x.webhookId,
    url: urls.get(x.webhookId) ?? "",
    event: x.event,
    ts: (x.deliveredAt ?? x.createdAt).toISOString(),
    attempts: x.attempts,
    lastStatus: httpStatus(x),
    ...(seqOf(x.payload) !== undefined ? { seq: seqOf(x.payload) } : {}),
  }));
  s.secretRolls = rolls.map((x) => {
    const newPrefix = nextPrefix.get(x.webhookId) ?? hooks.find((h) => h.id === x.webhookId)?.secretPrefix ?? "";
    nextPrefix.set(x.webhookId, x.previousPrefix);
    const seq = rolledSeq.get(x.id);
    return { webhookId: x.webhookId, newPrefix, previousPrefix: x.previousPrefix, previousValidUntil: x.validUntil.toISOString(), at: x.createdAt.toISOString(), by: x.createdBy, ...(seq !== undefined ? { seq } : {}) };
  });
  return { endpoints, deadLetter: s.deadLetter as unknown[], rolls: s.secretRolls as unknown[] };
}

/** The real delivery a test or a resend made, as the console's delivery log shows it. */
async function deliveryView(ctx: Ctx, id: string): Promise<ConsoleDelivery> {
  const row = await forOrg(ctx.orgId).webhookDelivery.findFirst({ where: { id } });
  if (!row) throw new Error("That delivery is no longer in the log.");
  return consoleDelivery(row);
}

/** Read the real Slack connection into notify.slack (the approvals channel name stays the document's). */
async function refreshSlack(ctx: Ctx) {
  const row = await forOrg(ctx.orgId).chatChannel.findFirst({ where: { kind: "slack", enabled: true } });
  const notify = settings(ctx).notify as { slack: Record<string, unknown> };
  const channel = notify.slack.channel ?? "#govern-approvals";
  if (!row) {
    notify.slack = { connected: false, channel };
    return;
  }
  const cfg = row.config as { teamId?: string; teamName?: string; channelId?: string };
  notify.slack = {
    connected: true,
    team: cfg.teamId ?? "",
    workspace: cfg.teamName ?? cfg.teamId ?? "",
    channel,
    channelId: cfg.channelId ?? "",
    installedAt: row.createdAt.toISOString(),
    ...(row.createdBy ? { installedBy: row.createdBy } : {}),
    scopes: ["chat:write", "commands", "users:read.email"],
  };
}

/**
 * Read the real WhatsApp numbers into the document: who has a verified number (members' whatsappVerified, and a
 * verifiedAt per person, which is what the console's routing reads). The document goes to every member, so it
 * holds no digits of anyone's number: a person sees their own last four through orgApi.whatsapp only.
 */
async function refreshNumbers(ctx: Ctx) {
  const rows = await forOrg(ctx.orgId).chatNumber.findMany({ select: { userId: true, verifiedAt: true } });
  const verified = new Map(rows.filter((r) => r.verifiedAt).map((r) => [r.userId, r.verifiedAt!]));
  for (const m of docOf(ctx).members as { userId: string; whatsappVerified?: boolean }[]) m.whatsappVerified = verified.has(m.userId);
  const s = settings(ctx);
  s.whatsapp = Object.fromEntries([...verified].map(([id, at]) => [id, { number: "", verifiedAt: iso(at) }]));
}

/** The person's own number as You › Approve in chat shows it: the last four digits, and a code waiting if one is. */
async function ownNumber(ctx: Ctx) {
  const r = await forOrg(ctx.orgId).chatNumber.findFirst({ where: { userId: ctx.actorUserId }, select: { last4: true, verifiedAt: true, codeExpires: true, codeAttempts: true } });
  if (!r) return { number: "", verified: false };
  const waiting = !r.verifiedAt && r.codeExpires && r.codeExpires > new Date();
  return {
    number: maskedNumber(r.last4),
    verified: !!r.verifiedAt,
    ...(waiting ? { pending: { sentAt: new Date(r.codeExpires!.getTime() - 10 * 60_000).toISOString(), attempts: r.codeAttempts } } : {}),
  };
}

/** The newest receipt with this action in the document (the real chat functions return no seq). */
function lastSeq(ctx: Ctx, action: string): number | undefined {
  return (docOf(ctx).receipts as { seq: number; action?: string }[]).findLast((r) => r.action === action)?.seq;
}

const arg = <T>(ctx: Ctx, i: number) => ctx.args[i] as T;

// ---- Webhooks ----

override("orgApi.webhooks", async (ctx) => {
  const out = await refreshWebhooks(ctx);
  return structuredClone(out);
});

override("api.webhooks", async (ctx) => structuredClone((await refreshWebhooks(ctx)).endpoints));

override("orgApi.addWebhook", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Adding an endpoint");
  const url = String(arg<string>(ctx, 1) ?? "").trim();
  const events = (arg<string[] | undefined>(ctx, 2) ?? []).map(String);
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url)) throw new Error("Enter an https:// URL. Plain http is not accepted.");
  const existing = await forOrg(ctx.orgId).webhook.findMany({ select: { url: true } });
  const same = (a: string) => {
    try {
      return new URL(a).toString() === new URL(url).toString();
    } catch {
      return a === url;
    }
  };
  if (existing.some((w) => same(w.url))) throw new Error("That URL already has an endpoint.");
  if (!events.length) throw new Error("Choose at least one event.");
  const r = await wire<{ id: string; secret: string; seq: number }>(ctx, "webhooks/add", { url, events, actor: ctx.actorUserId });
  const { endpoints } = await refreshWebhooks(ctx);
  touch(ctx, "webhook");
  return { webhook: structuredClone(endpoints.find((w) => w.id === r.id)), secret: r.secret, seq: r.seq };
});

override("orgApi.setWebhookStatus", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Changing an endpoint");
  const status = arg<string>(ctx, 2);
  if (status !== "active" && status !== "disabled") throw new Error("An endpoint is either on (active) or off (disabled).");
  const r = await wire<{ seq: number }>(ctx, `webhooks/${encodeURIComponent(String(arg(ctx, 1)))}/status`, { active: status === "active", actor: ctx.actorUserId });
  await refreshWebhooks(ctx);
  touch(ctx, "webhook");
  return { seq: r.seq };
});

override("orgApi.deleteWebhook", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Deleting an endpoint");
  const r = await wire<{ seq: number }>(ctx, `webhooks/${encodeURIComponent(String(arg(ctx, 1)))}/delete`, { actor: ctx.actorUserId });
  await refreshWebhooks(ctx);
  touch(ctx, "webhook");
  return { seq: r.seq };
});

override("orgApi.sendTestEvent", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Sending a test event");
  const r = await wire<{ deliveryId: string }>(ctx, `webhooks/${encodeURIComponent(String(arg(ctx, 1)))}/test`, { actor: ctx.actorUserId });
  await refreshWebhooks(ctx);
  touch(ctx, "webhook");
  return deliveryView(ctx, r.deliveryId);
});

override("orgApi.resendDelivery", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Resending a delivery");
  const path = `webhooks/${encodeURIComponent(String(arg(ctx, 1)))}/deliveries/${encodeURIComponent(String(arg(ctx, 2)))}/resend`;
  const r = await wire<{ deliveryId: string }>(ctx, path, { actor: ctx.actorUserId });
  await refreshWebhooks(ctx);
  touch(ctx, "webhook");
  return deliveryView(ctx, r.deliveryId);
});

override("orgApi.replayDeadLetters", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Replaying deliveries");
  const webhookId = arg<string | undefined>(ctx, 2);
  const r = await wire<{ delivered: number; failed: number; seq: number }>(ctx, "webhooks/replay", { ...(webhookId ? { webhookId: String(webhookId) } : {}), actor: ctx.actorUserId });
  await refreshWebhooks(ctx);
  touch(ctx, "webhook");
  return { ok: r.delivered, failed: r.failed, seq: r.seq };
});

override("orgApi.rollSecret", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Rolling a secret");
  const r = await wire<{ secret: string; previousValidUntil: string; seq: number }>(ctx, `webhooks/${encodeURIComponent(String(arg(ctx, 1)))}/roll`, { actor: ctx.actorUserId });
  await refreshWebhooks(ctx);
  touch(ctx, "webhook");
  return { secret: r.secret, previousValidUntil: r.previousValidUntil, seq: r.seq };
});

// ---- Slack ----

override("orgApi.notify", async (ctx) => {
  await refreshSlack(ctx);
  await refreshNumbers(ctx);
  return ctx.original(...ctx.args);
});

override("orgApi.completeSlackInstall", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Connecting Slack");
  const input = (arg<Record<string, unknown> | undefined>(ctx, 2) ?? {}) as { decision?: string; botToken?: unknown; signingSecret?: unknown; channelId?: unknown };
  if (input.decision === "deny") throw new Error("Slack reported access_denied: the workspace admin did not allow the app. Nothing was connected.");
  if (input.botToken === undefined || input.signingSecret === undefined || input.channelId === undefined) {
    throw new Error("Connecting Slack needs your Slack app's bot token (it starts with xoxb-), its signing secret and the ID of the approvals channel (it looks like C0123456789). Nothing was connected.");
  }
  const body = SlackBody.safeParse({ botToken: input.botToken, signingSecret: input.signingSecret, channelId: input.channelId });
  if (!body.success) throw new Error(body.error.issues[0]?.message ?? "Check the Slack details and try again.");
  // the real route asks for a fresh sign-in before secrets go to Elan1 Govern
  await requireFresh();
  await wire(ctx, "chat/slack/connect", { ...body.data, actor: ctx.actorUserId });
  await refreshSlack(ctx);
  touch(ctx, "channel");
  const slack = (settings(ctx).notify as { slack: Record<string, unknown> }).slack;
  return { slack: structuredClone(slack), seq: lastSeq(ctx, "chat.connected") };
});

override("orgApi.disconnectSlack", async (ctx) => {
  await requireRole(ctx, OWNER_ADMIN, "Disconnecting Slack");
  const r = await wire<{ seq: number }>(ctx, "chat/slack/disconnect", { actor: ctx.actorUserId });
  await refreshSlack(ctx);
  touch(ctx, "channel");
  return { seq: r.seq };
});

// ---- The person's own WhatsApp number ----

override("orgApi.whatsapp", async (ctx) => {
  await refreshNumbers(ctx);
  return ownNumber(ctx);
});

override("orgApi.sendWhatsAppCode", async (ctx) => {
  await requireRole(ctx, DECIDERS, "Approving in WhatsApp");
  const r = await wire<{ last4: string }>(ctx, "chat/whatsapp/numbers", { userId: ctx.actorUserId, number: String(arg(ctx, 2) ?? "").trim() });
  await refreshNumbers(ctx);
  touch(ctx, "channel");
  // the code goes to the phone only; nothing here can read it
  return { sentTo: maskedNumber(r.last4) };
});

override("orgApi.verifyWhatsAppCode", async (ctx) => {
  await requireRole(ctx, DECIDERS, "Approving in WhatsApp");
  await wire(ctx, "chat/whatsapp/numbers/confirm", { userId: ctx.actorUserId, code: String(arg(ctx, 2) ?? "").trim(), actor: ctx.actorUserId });
  await refreshNumbers(ctx);
  touch(ctx, "member");
  return { seq: lastSeq(ctx, "chat.number_verified") };
});

override("orgApi.forgetWhatsApp", async (ctx) => {
  await requireRole(ctx, DECIDERS, "Approving in WhatsApp");
  const had = await forOrg(ctx.orgId).chatNumber.findFirst({ where: { userId: ctx.actorUserId }, select: { verifiedAt: true } });
  if (had) await wire(ctx, "chat/whatsapp/numbers/remove", { userId: ctx.actorUserId, actor: ctx.actorUserId });
  await refreshNumbers(ctx);
  touch(ctx, "member");
  return { seq: had?.verifiedAt ? lastSeq(ctx, "chat.number_removed") : undefined };
});
