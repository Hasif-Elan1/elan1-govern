import { forOrg } from "@gate/db";
import { z } from "zod";
import { chain } from "../chain";
import { openChatSecrets } from "../chat/common";
import { connectSlack, SlackConfig } from "../chat/slack";
import { confirmNumber, removeNumber, startNumberVerification, WhatsAppConfig, type WhatsAppSecrets } from "../chat/whatsapp";
import { fail, wiringActor, type WiringRoutes } from "../console-wiring";
import {
  createWebhook,
  removeWebhook,
  replayDeadLetters,
  resendWebhookDelivery,
  rollWebhookSecret,
  setWebhookActive,
  testWebhook,
  WEBHOOK_EVENTS,
  type WebhookEvent,
} from "../webhooks";

/*
 * The console's webhook and chat-channel screens (Exports › Webhooks, Channels, You › Approve in chat) on the
 * real Webhook, WebhookDelivery, WebhookSecretRoll, ChatChannel and ChatNumber rows. Receipts are the console's
 * (webhook.added, webhook.enabled …, channel.slack_disconnected), with the console's person as the actor; the
 * real chat functions this reuses write their own (chat.connected, chat.number_verified, chat.number_removed).
 * No receipt carries a full URL or a phone number: hosts and number hashes only, as everywhere in the gate.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const actorOnly = z.object({ actor: wiringActor }).strict();

const EVENT_WORDS: Record<WebhookEvent, string> = {
  "receipt.created": "every receipt",
  "approval.pending": "approvals waiting",
  "approval.resolved": "approvals decided",
  "alert.created": "unusual-behaviour alerts",
};

const schemas = {
  add: z.object({ url: z.string().trim().min(1).max(2000), events: z.array(z.string().max(60)).min(1).max(20), actor: wiringActor }).strict(),
  status: z.object({ active: z.boolean(), actor: wiringActor }).strict(),
  replay: z.object({ webhookId: id.optional(), actor: wiringActor }).strict(),
  slack: z.object({ botToken: z.string().trim().min(1).max(300), signingSecret: z.string().trim().min(1).max(200), channelId: z.string().trim().max(40), actor: wiringActor }).strict(),
  number: z.object({ userId: id, number: z.string().trim().min(6).max(30) }).strict(),
  confirm: z.object({ userId: id, code: z.string().trim().max(10), actor: wiringActor }).strict(),
  remove: z.object({ userId: id, actor: wiringActor }).strict(),
};

/** The console offers more events than Elan1 Govern sends today: an endpoint for one it does not send is refused, not saved half-subscribed. */
export function unsupportedEvents(events: readonly string[]): string | undefined {
  const other = [...new Set(events)].filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (!other.length) return undefined;
  const sent = WEBHOOK_EVENTS.map((e) => `${e} (${EVENT_WORDS[e]})`).join(", ");
  return `Elan1 Govern sends these events to webhooks: ${sent}. It does not send ${other.join(", ")} yet, so untick ${other.length === 1 ? "it" : "them"} and add the endpoint again. Nothing was saved.`;
}

export const webhookRoutes: WiringRoutes = (r, w) => {
  const { deps } = w;
  type P = { Params: { org: string; id: string; delivery: string } };
  const gone = fail(404, "That endpoint no longer exists.");

  // ---- Webhooks ----

  r.post<P>("/internal/orgs/:org/wiring/webhooks/add", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.add, req.body);
    const problem = unsupportedEvents(b.events);
    if (problem) return w.send(reply, fail(400, problem));
    const res = await createWebhook(deps, orgId, { url: b.url, events: b.events as WebhookEvent[], actor: b.actor, action: "webhook.added" });
    return w.send(reply, res.ok ? res : fail(400, res.error));
  });

  r.post<P>("/internal/orgs/:org/wiring/webhooks/:id/status", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.status, req.body);
    return w.send(reply, (await setWebhookActive(deps, orgId, w.parse(id, req.params.id), b.active, b.actor)) ?? gone);
  });

  r.post<P>("/internal/orgs/:org/wiring/webhooks/:id/delete", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(actorOnly, req.body);
    return w.send(reply, (await removeWebhook(deps, orgId, w.parse(id, req.params.id), b.actor)) ?? gone);
  });

  r.post<P>("/internal/orgs/:org/wiring/webhooks/:id/roll", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(actorOnly, req.body);
    return w.send(reply, (await rollWebhookSecret(deps, orgId, w.parse(id, req.params.id), b.actor)) ?? gone);
  });

  // a test event and a resend write no receipt (the console's neither): the delivery row is the record
  r.post<P>("/internal/orgs/:org/wiring/webhooks/:id/test", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    w.parse(actorOnly, req.body);
    const hookId = w.parse(id, req.params.id);
    const hook = await forOrg(orgId, deps.db).webhook.findFirst({ where: { id: hookId }, select: { active: true } });
    if (!hook) return w.send(reply, gone);
    if (!hook.active) return w.send(reply, fail(409, "Enable the endpoint first."));
    return w.send(reply, (await testWebhook(deps, orgId, hookId)) ?? gone);
  });

  r.post<P>("/internal/orgs/:org/wiring/webhooks/:id/deliveries/:delivery/resend", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    w.parse(actorOnly, req.body);
    const hookId = w.parse(id, req.params.id);
    const hook = await forOrg(orgId, deps.db).webhook.findFirst({ where: { id: hookId }, select: { active: true } });
    if (!hook) return w.send(reply, gone);
    if (!hook.active) return w.send(reply, fail(409, "Enable the endpoint first."));
    return w.send(reply, (await resendWebhookDelivery(deps, orgId, hookId, w.parse(id, req.params.delivery))) ?? fail(404, "That delivery is no longer in the log."));
  });

  r.post<P>("/internal/orgs/:org/wiring/webhooks/replay", async (req) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.replay, req.body);
    return replayDeadLetters(deps, orgId, { actor: b.actor, ...(b.webhookId ? { webhookId: b.webhookId } : {}) });
  });

  // ---- Slack ----

  r.post<P>("/internal/orgs/:org/wiring/chat/slack/connect", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.slack, req.body);
    const res = await connectSlack(deps, orgId, b);
    return w.send(reply, res.ok ? res : fail(400, res.error));
  });

  r.post<P>("/internal/orgs/:org/wiring/chat/slack/disconnect", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(actorOnly, req.body);
    const out = await chain(deps, orgId, async (append, tx) => {
      const row = await tx.chatChannel.findFirst({ where: { kind: "slack" } });
      if (!row) return null;
      const cfg = SlackConfig.safeParse(row.config);
      await tx.chatChannel.deleteMany({ where: { kind: "slack" } });
      const rec = await append({ kind: "admin", actor: b.actor, action: "channel.slack_disconnected", details: { workspace: cfg.success ? (cfg.data.teamName ?? cfg.data.teamId) : "", team: cfg.success ? cfg.data.teamId : "" } });
      return { seq: rec.seq };
    });
    return w.send(reply, out ?? fail(404, "Slack is not connected."));
  });

  // ---- An approver's own WhatsApp number ----

  r.post<P>("/internal/orgs/:org/wiring/chat/whatsapp/numbers", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.number, req.body);
    const ch = await forOrg(orgId, deps.db).chatChannel.findFirst({ where: { kind: "whatsapp", enabled: true } });
    const channel = ch ? { config: WhatsAppConfig.parse(ch.config), secrets: openChatSecrets<WhatsAppSecrets>(deps, orgId, "whatsapp", ch.secretsEnc) } : null;
    const res = await startNumberVerification(deps, orgId, b, channel);
    return w.send(reply, res.ok ? res : fail(res.status, res.error));
  });

  r.post<P>("/internal/orgs/:org/wiring/chat/whatsapp/numbers/confirm", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const res = await confirmNumber(deps, orgId, w.parse(schemas.confirm, req.body));
    return w.send(reply, res.ok ? res : fail(res.status, res.error));
  });

  r.post<P>("/internal/orgs/:org/wiring/chat/whatsapp/numbers/remove", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const removed = await removeNumber(deps, orgId, w.parse(schemas.remove, req.body));
    return w.send(reply, removed ? { removed: true } : fail(404, "No number on file."));
  });
};
