import { forOrg } from "@gate/db";
import { z } from "zod";
import { adminEvent } from "../admin";
import type { Deps } from "../deps";
import { CHAT_MAX_AGE_SECONDS, ChatApiError, chatFetch, expiryWords, hmacHex, outcomeLine, sameSignature, sealChatSecrets, type ApprovalView } from "./common";

// Slack: an org connects its own Slack app (bot token + signing secret) and picks a channel.
// Elan1 Govern posts each waiting approval there; buttons appear only when the rule allows it.

export interface SlackSecrets extends Record<string, string> {
  botToken: string;
  signingSecret: string;
}
export const SlackConfig = z.object({ channelId: z.string(), teamId: z.string(), teamName: z.string().optional() });
export type SlackConfig = z.infer<typeof SlackConfig>;

export const SLACK_ACTIONS = { approve: "gate_approve", reject: "gate_reject", open: "gate_open" } as const;
export const SLACK_CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;

// ---- Inbound: request signatures (v0) ----

/**
 * Slack signs `v0:{timestamp}:{raw body}` with the app's signing secret (HMAC-SHA256) and sends
 * `X-Slack-Request-Timestamp` and `X-Slack-Signature: v0=<hex>`. Requests older than five minutes
 * are refused so a captured request cannot be replayed later.
 */
export function verifySlackSignature(signingSecret: string, timestamp: string | undefined, signature: string | undefined, rawBody: string, now = Date.now()): "ok" | "stale" | "bad" {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return "bad";
  if (Math.abs(now / 1000 - Number(timestamp)) > CHAT_MAX_AGE_SECONDS) return "stale";
  return sameSignature(`v0=${hmacHex(signingSecret, `v0:${timestamp}:${rawBody}`)}`, signature) ? "ok" : "bad";
}

/** The part of a block_actions payload Elan1 Govern reads. Anything else is ignored. */
export const SlackInteraction = z.object({
  type: z.string().max(64),
  team: z.object({ id: z.string().max(32) }).optional(),
  user: z.object({ id: z.string().regex(/^[UW][A-Z0-9]{2,30}$/) }).optional(),
  channel: z.object({ id: z.string().max(32) }).optional(),
  actions: z.array(z.object({ action_id: z.string().max(255), value: z.string().max(2000).optional() })).max(5).optional(),
});
export type SlackInteraction = z.infer<typeof SlackInteraction>;

// ---- Outbound: the Web API ----

const RETRYABLE = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);
const SlackOk = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();

async function slackCall(deps: Deps, token: string, method: string, body: Record<string, unknown>, form = false): Promise<Record<string, unknown>> {
  const res = await chatFetch(deps, "slack", method, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });
  if (res.status === 429) throw new ChatApiError("Slack is limiting how fast Elan1 Govern can post", true, 429);
  if (!res.ok) throw new ChatApiError(`Slack answered HTTP ${res.status}`, res.status >= 500, res.status);
  const parsed = SlackOk.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ChatApiError("Slack sent an answer Elan1 Govern could not read");
  if (!parsed.data.ok) {
    // Slack error codes are short fixed words; anything else is not repeated.
    const code = parsed.data.error && /^[a-z_]{1,60}$/.test(parsed.data.error) ? parsed.data.error : "unknown_error";
    throw new ChatApiError(`Slack said ${code}`, RETRYABLE.has(code));
  }
  return parsed.data;
}

export async function slackAuthTest(deps: Deps, token: string): Promise<{ teamId: string; teamName?: string }> {
  const r = z.object({ team_id: z.string().max(32), team: z.string().max(200).optional() }).safeParse(await slackCall(deps, token, "auth.test", {}, true));
  if (!r.success) throw new ChatApiError("Slack did not say which workspace this token belongs to", false);
  return { teamId: r.data.team_id, ...(r.data.team ? { teamName: r.data.team } : {}) };
}

const SlackUser = z.object({
  user: z.object({
    id: z.string(),
    deleted: z.boolean().optional(),
    is_bot: z.boolean().optional(),
    is_email_confirmed: z.boolean().optional(),
    profile: z.object({ email: z.string().email().max(320).optional() }).passthrough(),
  }),
});

/**
 * The Slack user's email, only if Slack has confirmed it (needs users:read and users:read.email).
 * Bots, deactivated users and unconfirmed emails get null, so they can never decide.
 */
export async function slackUserEmail(deps: Deps, token: string, userId: string): Promise<string | null> {
  const r = SlackUser.safeParse(await slackCall(deps, token, "users.info", { user: userId }, true));
  if (!r.success) return null;
  const u = r.data.user;
  if (u.deleted || u.is_bot || u.is_email_confirmed !== true || !u.profile.email) return null;
  return u.profile.email.toLowerCase();
}

export async function slackPost(deps: Deps, token: string, channel: string, message: SlackMessage): Promise<{ ts: string; channel: string }> {
  const r = z.object({ ts: z.string().max(40), channel: z.string().max(32) }).safeParse(await slackCall(deps, token, "chat.postMessage", { channel, ...message, unfurl_links: false, unfurl_media: false }));
  if (!r.success) throw new ChatApiError("Slack did not return the message id");
  return r.data;
}

export async function slackUpdate(deps: Deps, token: string, channel: string, ts: string, message: SlackMessage): Promise<void> {
  await slackCall(deps, token, "chat.update", { channel, ts, ...message });
}

export async function slackEphemeral(deps: Deps, token: string, channel: string, user: string, text: string): Promise<void> {
  await slackCall(deps, token, "chat.postEphemeral", { channel, user, text });
}

// ---- Messages (Block Kit) ----

export interface SlackMessage {
  text: string;
  blocks: object[];
}

/** Slack mrkdwn needs &, < and > escaped; everything shown comes from the minimised summary. */
const esc = (s: string, max = 1500) => (s.length > max ? `${s.slice(0, max - 1)}…` : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
const plain = (s: string, max = 75) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The approval as a Slack message. While it is pending: Approve and Reject only when the rule
 * allows chat approval, and always a link to Elan1 Govern. Once decided: the outcome, no buttons.
 */
export function slackApprovalMessage(v: ApprovalView): SlackMessage {
  const unix = Math.floor(v.expiresAt.getTime() / 1000);
  const fields = [
    { type: "mrkdwn", text: `*Agent*\n${esc(v.agent, 200)}` },
    { type: "mrkdwn", text: `*Rule*\n\`${esc(v.rule, 100)}\`` },
    ...(v.amount ? [{ type: "mrkdwn", text: `*Amount*\n${esc(v.amount, 100)}` }] : []),
    ...(v.vendor ? [{ type: "mrkdwn", text: `*Vendor*\n${esc(v.vendor, 200)}` }] : []),
    { type: "mrkdwn", text: `*Expires*\n<!date^${unix}^{date_short_pretty} {time}|${esc(expiryWords(v.expiresAt))}>` },
  ];
  const open = { type: "button", action_id: SLACK_ACTIONS.open, text: { type: "plain_text", text: "Open in Elan1 Govern" }, url: v.url };
  const pending = v.status === "pending";
  const decide = v.chatApproval
    ? [
        {
          type: "button",
          action_id: SLACK_ACTIONS.approve,
          style: "primary",
          value: v.id,
          text: { type: "plain_text", text: "Approve" },
          confirm: {
            title: { type: "plain_text", text: "Approve this action?" },
            text: { type: "plain_text", text: plain(v.action, 280) },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        { type: "button", action_id: SLACK_ACTIONS.reject, style: "danger", value: v.id, text: { type: "plain_text", text: "Reject" } },
      ]
    : [];
  const blocks: object[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${esc(v.action, 500)}*\n${esc(v.reason, 500)}` } },
    { type: "section", fields },
    pending
      ? { type: "actions", block_id: "gate_decide", elements: [...decide, open] }
      : { type: "section", text: { type: "mrkdwn", text: `*${esc(outcomeLine(v), 600)}*` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: !pending
            ? "Recorded in Elan1 Govern with a signed receipt."
            : v.chatApproval
              ? "Your decision here is recorded in Elan1 Govern with a signed receipt. If nobody decides in time, the action is refused."
              : "This one can only be decided in Elan1 Govern. If nobody decides in time, the action is refused.",
        },
      ],
    },
  ];
  if (!pending) blocks.push({ type: "actions", block_id: "gate_open", elements: [open] });
  const text = pending ? `Waiting for approval: ${plain(v.action, 200)}` : `${plain(v.action, 200)}: ${outcomeLine(v)}`;
  return { text, blocks };
}

// ---- Admin ----

export type ConnectResult = { ok: true; id: string; url: string; team: string } | { ok: false; error: string };

export async function connectSlack(deps: Deps, orgId: string, input: { botToken: string; signingSecret: string; channelId: string; actor: string }): Promise<ConnectResult> {
  if (!/^xoxb-[A-Za-z0-9-]{10,250}$/.test(input.botToken)) return { ok: false, error: "The bot token should start with xoxb-. Find it under OAuth & Permissions in your Slack app." };
  if (!/^[a-f0-9]{16,128}$/.test(input.signingSecret)) return { ok: false, error: "The signing secret is the hex value under Basic Information → App Credentials." };
  if (!SLACK_CHANNEL_RE.test(input.channelId)) return { ok: false, error: "The channel ID looks like C0123456789. In Slack, open the channel's details to copy it." };
  let team: { teamId: string; teamName?: string };
  try {
    team = await slackAuthTest(deps, input.botToken);
  } catch (e) {
    return { ok: false, error: `Slack did not accept the bot token (${(e as Error).message}).` };
  }
  const db = forOrg(orgId, deps.db);
  const config: SlackConfig = { channelId: input.channelId, teamId: team.teamId, ...(team.teamName ? { teamName: team.teamName } : {}) };
  const secretsEnc = sealChatSecrets(deps, orgId, "slack", { botToken: input.botToken, signingSecret: input.signingSecret });
  const row = await db.chatChannel.upsert({
    where: { orgId_kind: { orgId, kind: "slack" } },
    create: { orgId, kind: "slack", config, secretsEnc, createdBy: input.actor },
    update: { config, secretsEnc, enabled: true, createdBy: input.actor },
  });
  await adminEvent(deps, orgId, input.actor, "chat.connected", { channel: "slack", team: team.teamId });
  return { ok: true, id: row.id, url: `${deps.env.GATE_PUBLIC_URL}/chat/slack/${row.id}/interactions`, team: team.teamName ?? team.teamId };
}
