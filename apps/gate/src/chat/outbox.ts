import { dueChatMessages, forOrg } from "@gate/db";
import type { Deps } from "../deps";
import { backoffSeconds } from "../webhooks";
import { approvalView, ChatApiError, openChatSecrets, type ChatKind } from "./common";
import { slackApprovalMessage, slackPost, slackUpdate, SlackConfig, type SlackSecrets } from "./slack";
import { openNumber, waSend, WhatsAppConfig, whatsAppApprovalMessage, type WhatsAppSecrets } from "./whatsapp";

// Outgoing chat messages: one row per message, sent by a pg-boss job with its own retry state
// (like webhook deliveries), so a slow or failing Slack or Meta never holds up the guard.

export const CHAT_QUEUE = "chat-send";
export const CHAT_MAX_ATTEMPTS = 6;
const LEASE_MS = 60_000;
const APPROVER_ROLES = ["owner", "admin", "approver"] as const;

export type ChatOutcome = "sent" | "retrying" | "failed" | "skipped";

async function enqueue(deps: Deps, orgId: string, rows: { channelId: string; approvalId: string; kind: string; recipientUserId?: string }[]): Promise<number> {
  if (!rows.length) return 0;
  const created = await forOrg(orgId, deps.db).chatMessage.createManyAndReturn({ data: rows.map((r) => ({ orgId, ...r, nextAttemptAt: new Date() })), select: { id: true } });
  for (const m of created) await deps.queue.send(CHAT_QUEUE, { orgId, messageId: m.id }, { singletonKey: `${m.id}:0` });
  return created.length;
}

/** After an approval is held: a Slack post, and a WhatsApp message to each listed approver with a verified number. */
export async function notifyChat(deps: Deps, orgId: string, approvalId: string): Promise<number> {
  const db = forOrg(orgId, deps.db);
  const channels = await db.chatChannel.findMany({ where: { enabled: true }, select: { id: true, kind: true } });
  if (!channels.length) return 0;
  const approval = await db.approval.findFirstOrThrow({ where: { id: approvalId }, select: { approvers: true } });
  const rows: { channelId: string; approvalId: string; kind: string; recipientUserId?: string }[] = [];
  for (const ch of channels) {
    if (ch.kind === "slack") rows.push({ channelId: ch.id, approvalId, kind: "slack.post" });
    if (ch.kind === "whatsapp" && approval.approvers.length) {
      const users = await deps.db.user.findMany({ where: { email: { in: approval.approvers } }, select: { id: true } });
      const members = await db.membership.findMany({ where: { userId: { in: users.map((u) => u.id) }, role: { in: [...APPROVER_ROLES] }, status: "active" }, select: { userId: true } });
      const numbers = await db.chatNumber.findMany({ where: { userId: { in: members.map((m) => m.userId) }, verifiedAt: { not: null } }, select: { userId: true } });
      for (const n of numbers) rows.push({ channelId: ch.id, approvalId, kind: "whatsapp.send", recipientUserId: n.userId });
    }
  }
  return enqueue(deps, orgId, rows);
}

/** After a decision or expiry, wherever it was made: update the Slack message so its buttons go away. */
export async function chatResolved(deps: Deps, orgId: string, approvalId: string): Promise<number> {
  const posts = await forOrg(orgId, deps.db).chatMessage.findMany({ where: { approvalId, kind: "slack.post", status: { in: ["pending", "sent"] } }, select: { channelId: true } });
  return enqueue(deps, orgId, posts.map((p) => ({ channelId: p.channelId, approvalId, kind: "slack.update" })));
}

/** One attempt at one message. Safe to call twice at once: the attempt is claimed first. */
export async function deliverChatMessage(deps: Deps, orgId: string, messageId: string): Promise<ChatOutcome> {
  const db = forOrg(orgId, deps.db);
  const now = new Date();
  const claimed = await db.chatMessage.updateMany({
    where: { id: messageId, status: "pending", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return "skipped";
  const m = await db.chatMessage.findFirstOrThrow({ where: { id: messageId }, include: { channel: true } });
  const attempts = m.attempts + 1;
  const finish = async (outcome: ChatOutcome, info: { error?: string; externalId?: string; externalChannel?: string } = {}): Promise<ChatOutcome> => {
    const final = outcome === "retrying" && attempts >= CHAT_MAX_ATTEMPTS ? "failed" : outcome;
    const delay = backoffSeconds(attempts);
    await db.chatMessage.update({
      where: { id: messageId },
      data: {
        attempts,
        status: final === "retrying" ? "pending" : final,
        lastError: info.error ?? null,
        nextAttemptAt: final === "retrying" ? new Date(Date.now() + delay * 1000) : null,
        ...(final === "sent" ? { sentAt: new Date() } : {}),
        ...(info.externalId ? { externalId: info.externalId } : {}),
        ...(info.externalChannel ? { externalChannel: info.externalChannel } : {}),
      },
    });
    if (final === "retrying") await deps.queue.send(CHAT_QUEUE, { orgId, messageId }, { startAfter: delay, singletonKey: `${messageId}:${attempts}` });
    // No names, emails, numbers or message text in logs.
    deps.log.info({ job: "chat.send", orgId, messageId, kind: m.kind, attempt: attempts, outcome: final }, "chat message");
    return final;
  };

  const approval = await db.approval.findFirst({ where: { id: m.approvalId } });
  if (!approval) return finish("failed", { error: "the approval no longer exists" });
  if (!m.channel.enabled) return finish("failed", { error: "the channel is turned off" });
  const agent = await db.agent.findFirst({ where: { id: approval.agentId }, select: { name: true } });
  const view = approvalView(deps, approval, agent?.name ?? "An agent");

  try {
    const secrets = openChatSecrets(deps, orgId, m.channel.kind as ChatKind, m.channel.secretsEnc);
    if (m.kind === "slack.post") {
      if (view.status !== "pending") return finish("skipped", { error: "already decided before it was posted" });
      const cfg = SlackConfig.parse(m.channel.config);
      const posted = await slackPost(deps, (secrets as SlackSecrets).botToken, cfg.channelId, slackApprovalMessage(view));
      const out = await finish("sent", { externalId: posted.ts, externalChannel: posted.channel });
      // Decided while we were posting: replace the buttons straight away.
      const fresh = await db.approval.findFirst({ where: { id: m.approvalId }, select: { status: true } });
      if (fresh && fresh.status !== "pending") await chatResolved(deps, orgId, m.approvalId);
      return out;
    }
    if (m.kind === "slack.update") {
      const post = await db.chatMessage.findFirst({ where: { approvalId: m.approvalId, channelId: m.channelId, kind: "slack.post" }, orderBy: { createdAt: "asc" } });
      if (!post || post.status === "failed" || post.status === "skipped") return finish("skipped", { error: "the first message was never posted" });
      if (!post.externalId || !post.externalChannel) return finish("retrying", { error: "waiting for the first message to be posted" });
      await slackUpdate(deps, (secrets as SlackSecrets).botToken, post.externalChannel, post.externalId, slackApprovalMessage(view));
      return finish("sent");
    }
    if (m.kind === "whatsapp.send") {
      if (view.status !== "pending") return finish("skipped", { error: "already decided before it was sent" });
      const number = m.recipientUserId ? await db.chatNumber.findFirst({ where: { userId: m.recipientUserId, verifiedAt: { not: null } } }) : null;
      if (!number) return finish("skipped", { error: "the approver no longer has a verified number" });
      const cfg = WhatsAppConfig.parse(m.channel.config);
      const id = await waSend(deps, (secrets as WhatsAppSecrets).accessToken, cfg.phoneNumberId, openNumber(deps, orgId, number), whatsAppApprovalMessage(view, cfg));
      return finish("sent", { externalId: id });
    }
    return finish("failed", { error: `unknown message kind ${m.kind}` });
  } catch (e) {
    if (e instanceof ChatApiError) return finish(e.retry ? "retrying" : "failed", { error: e.message });
    return finish("retrying", { error: "the message could not be prepared" });
  }
}

/** Re-sends chat messages that are due but whose job was lost (a crash, or written before jobs ran). */
export async function sweepChat(deps: Deps): Promise<number> {
  let n = 0;
  for (const m of await dueChatMessages(new Date(), deps.db)) {
    if ((await deliverChatMessage(deps, m.orgId, m.id).catch(() => "skipped")) !== "skipped") n++;
  }
  return n;
}
