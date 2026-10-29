import { verifyRequest } from "@gate/core";
import { findChatChannel, forOrg } from "@gate/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminEvent } from "../admin";
import { resolveApproval, type ResolveResult } from "../approvals";
import { background } from "../chain";
import { CHAT_KINDS, CHAT_MAX_AGE_SECONDS, numberHash, openChatSecrets, sameSignature, whatsappUserId, type ChatKind } from "../chat/common";
import { connectSlack, SLACK_ACTIONS, SlackConfig, SlackInteraction, slackEphemeral, slackUserEmail, verifySlackSignature, type SlackSecrets } from "../chat/slack";
import {
  confirmNumber,
  connectWhatsApp,
  decisionOf,
  removeNumber,
  startNumberVerification,
  textMessage,
  verifyMetaSignature,
  verifyTokenHash,
  waSend,
  WhatsAppConfig,
  WhatsAppWebhook,
  type WaIncoming,
  type WhatsAppSecrets,
} from "../chat/whatsapp";
import type { Deps } from "../deps";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const email = z.string().email().max(320).transform((e) => e.toLowerCase());
const INBOUND_LIMIT = { rateLimit: { max: 300, timeWindow: "1 minute" } };
const CANT = "You can't approve this here.";

type Raw = FastifyRequest & { rawBody?: string };

// ---- Deciding from chat: both channels end in the same resolveApproval as the web ----

function chatReply(r: ResolveResult): string {
  if (r.ok) return `${r.status === "approved" ? "Approved" : "Rejected"}. Elan1 Govern recorded your decision with a signed receipt.${r.status === "approved" && r.outcome.status === "error" ? " The action did not complete; see Elan1 Govern for details." : ""}`;
  if (r.code === "not_approver" || r.code === "not_found" || r.code === "link_invalid") return `${CANT} Only the approvers named in the rule can decide it.`;
  if (r.code === "app_only") return `${CANT} This action can only be approved in Elan1 Govern.`;
  return r.message;
}

async function slackDecision(deps: Deps, orgId: string, secrets: SlackSecrets, cfg: SlackConfig, p: SlackInteraction, result: "approved" | "rejected", approvalId: string) {
  const user = p.user!.id;
  const channel = p.channel?.id ?? cfg.channelId;
  const reply = (text: string) => slackEphemeral(deps, orgId, secrets.botToken, channel, user, text).catch((e: Error) => deps.log.warn({ job: "slack.reply", orgId, err: e.message }, "slack reply failed"));
  const mail = await slackUserEmail(deps, orgId, secrets.botToken, user).catch(() => null);
  const member = mail ? await deps.db.user.findUnique({ where: { email: mail }, select: { id: true, email: true } }) : null;
  if (!member) return reply(`${CANT} Elan1 Govern could not match your Slack account to an approver in this organisation by a confirmed email.`);
  const r = await resolveApproval(deps, orgId, approvalId, { userId: member.id, email: member.email, result, channel: "slack", channelUser: `${cfg.teamId}/${user}` });
  deps.log.info({ job: "slack.decision", orgId, approvalId, outcome: r.ok ? r.status : r.code }, "slack decision");
  return reply(chatReply(r));
}

async function whatsappDecision(deps: Deps, orgId: string, secrets: WhatsAppSecrets, cfg: WhatsAppConfig, m: WaIncoming) {
  const d = decisionOf(m);
  if (!d) return;
  const hash = numberHash(deps, m.from);
  const reply = (text: string) => waSend(deps, orgId, secrets.accessToken, cfg.phoneNumberId, m.from, textMessage(text)).catch((e: Error) => deps.log.warn({ job: "whatsapp.reply", orgId, err: e.message }, "whatsapp reply failed"));
  if (Math.abs(Date.now() / 1000 - Number(m.timestamp)) > CHAT_MAX_AGE_SECONDS) {
    deps.log.warn({ job: "whatsapp.decision", orgId, approvalId: d.approvalId, outcome: "stale" }, "whatsapp decision too old");
    return reply("That answer arrived too late to count. Open Elan1 Govern to decide.");
  }
  const number = await forOrg(orgId, deps.db).chatNumber.findFirst({ where: { numberHash: hash, verifiedAt: { not: null } } });
  const user = number ? await deps.db.user.findUnique({ where: { id: number.userId }, select: { id: true, email: true } }) : null;
  if (!user) return reply(`${CANT} This number is not a verified approver's number in Elan1 Govern.`);
  const r = await resolveApproval(deps, orgId, d.approvalId, { userId: user.id, email: user.email, result: d.result, channel: "whatsapp", channelUser: whatsappUserId(hash) });
  deps.log.info({ job: "whatsapp.decision", orgId, approvalId: d.approvalId, outcome: r.ok ? r.status : r.code }, "whatsapp decision");
  return reply(chatReply(r));
}

export function registerChat(app: FastifyInstance, deps: Deps) {
  // ---- Inbound from Slack and Meta ----
  app.register(async (scope) => {
    // Slack sends interactions form-encoded (payload=<json>); the raw text is kept for the signature.
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 256 * 1024 }, (req, body, done) => {
      (req as Raw).rawBody = body as string;
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    scope.post<{ Params: { channel: string } }>("/chat/slack/:channel/interactions", { config: INBOUND_LIMIT }, async (req, reply) => {
      if (!id.safeParse(req.params.channel).success) return reply.code(404).send({ error: "not found" });
      const ch = await findChatChannel(req.params.channel, "slack", deps.db);
      if (!ch) return reply.code(404).send({ error: "not found" });
      const secrets = openChatSecrets<SlackSecrets>(deps, ch.orgId, "slack", ch.secretsEnc);
      const h = (n: string) => (typeof req.headers[n] === "string" ? (req.headers[n] as string) : undefined);
      const sig = verifySlackSignature(secrets.signingSecret, h("x-slack-request-timestamp"), h("x-slack-signature"), (req as Raw).rawBody ?? "");
      if (sig !== "ok") return reply.code(401).send({ error: sig === "stale" ? "request too old" : "bad signature" });

      const raw = (req.body as Record<string, unknown> | undefined)?.payload;
      let json: unknown;
      try {
        json = typeof raw === "string" ? JSON.parse(raw) : undefined;
      } catch {
        json = undefined;
      }
      const p = SlackInteraction.safeParse(json);
      if (!p.success) return reply.code(400).send({ error: "unreadable payload" });
      const action = p.data.actions?.[0];
      if (p.data.type !== "block_actions" || !action || !p.data.user || (action.action_id !== SLACK_ACTIONS.approve && action.action_id !== SLACK_ACTIONS.reject)) return reply.code(200).send();
      const cfg = SlackConfig.parse(ch.config);
      // A click from another workspace that shares the app is never this org's to decide.
      if (p.data.team?.id !== cfg.teamId) {
        deps.log.warn({ job: "slack.decision", orgId: ch.orgId, outcome: "other_workspace" }, "slack click from another workspace");
        return reply.code(200).send();
      }
      const approvalId = id.safeParse(action.value);
      if (!approvalId.success) return reply.code(200).send();
      // Slack wants an answer within 3 seconds; the decision (which may run the action) continues after it.
      background(deps, slackDecision(deps, ch.orgId, secrets, cfg, p.data, action.action_id === SLACK_ACTIONS.approve ? "approved" : "rejected", approvalId.data));
      return reply.code(200).send();
    });
  });

  // Meta's webhook check: echo the challenge only for the right verify token.
  app.get<{ Params: { channel: string }; Querystring: Record<string, string> }>("/chat/whatsapp/:channel/webhook", { config: INBOUND_LIMIT }, async (req, reply) => {
    const q = z.object({ "hub.mode": z.literal("subscribe"), "hub.verify_token": z.string().min(1).max(200), "hub.challenge": z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).safeParse(req.query);
    if (!id.safeParse(req.params.channel).success || !q.success) return reply.code(403).send({ error: "forbidden" });
    const ch = await findChatChannel(req.params.channel, "whatsapp", deps.db);
    if (!ch?.verifyHash || !sameSignature(verifyTokenHash(q.data["hub.verify_token"]), ch.verifyHash)) return reply.code(403).send({ error: "forbidden" });
    return reply.type("text/plain").send(q.data["hub.challenge"]);
  });

  app.post<{ Params: { channel: string } }>("/chat/whatsapp/:channel/webhook", { config: INBOUND_LIMIT }, async (req, reply) => {
    if (!id.safeParse(req.params.channel).success) return reply.code(404).send({ error: "not found" });
    const ch = await findChatChannel(req.params.channel, "whatsapp", deps.db);
    if (!ch) return reply.code(404).send({ error: "not found" });
    const secrets = openChatSecrets<WhatsAppSecrets>(deps, ch.orgId, "whatsapp", ch.secretsEnc);
    const header = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
    if (!verifyMetaSignature(secrets.appSecret, header, (req as Raw).rawBody ?? "")) return reply.code(401).send({ error: "bad signature" });
    const body = WhatsAppWebhook.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "unreadable payload" });
    const cfg = WhatsAppConfig.parse(ch.config);
    for (const entry of body.data.entry) {
      for (const change of entry.changes) {
        if (change.value.metadata?.phone_number_id !== cfg.phoneNumberId) continue;
        for (const m of change.value.messages ?? []) background(deps, whatsappDecision(deps, ch.orgId, secrets, cfg, m));
      }
    }
    return reply.code(200).send();
  });

  // ---- Internal admin API (HMAC-signed by the web app, like /internal in internal.ts) ----
  app.register(async (internal) => {
    internal.addHook("preHandler", async (req, reply) => {
      if (!verifyRequest(deps.env.INTERNAL_API_SECRET, req.headers["x-gate-signature"] as string | undefined, req.method, req.url, (req as Raw).rawBody ?? "")) {
        return reply.code(401).send({ error: "bad signature" });
      }
    });
    const parse = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
      const r = schema.safeParse(body ?? {});
      if (!r.success) throw Object.assign(new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), { statusCode: 400 });
      return r.data;
    };
    const org = async (orgId: string) => {
      if (!id.safeParse(orgId).success || !(await forOrg(orgId, deps.db).org.findFirst())) throw Object.assign(new Error("no such org"), { statusCode: 404 });
      return orgId;
    };
    type P = { Params: { org: string; kind: string } };
    const secret = (max: number) => z.string().trim().min(1).max(max);

    internal.post<P>("/internal/orgs/:org/chat/slack", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(z.object({ botToken: secret(300), signingSecret: secret(200), channelId: z.string().trim().max(40), actor: email }).strict(), req.body);
      const r = await connectSlack(deps, orgId, b);
      return r.ok ? r : reply.code(400).send({ error: r.error });
    });

    internal.post<P>("/internal/orgs/:org/chat/whatsapp", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(
        z
          .object({
            phoneNumberId: z.string().trim().max(40),
            accessToken: secret(1000),
            appSecret: secret(200),
            templateName: z.string().trim().max(512).optional(),
            templateLanguage: z.string().trim().max(10).optional(),
            verifyTemplateName: z.string().trim().max(512).optional(),
            actor: email,
          })
          .strict(),
        req.body,
      );
      const r = await connectWhatsApp(deps, orgId, b);
      return r.ok ? r : reply.code(400).send({ error: r.error });
    });

    internal.post<P>("/internal/orgs/:org/chat/:kind/remove", async (req, reply) => {
      const orgId = await org(req.params.org);
      const kind = parse(z.enum(CHAT_KINDS), req.params.kind) as ChatKind;
      const b = parse(z.object({ actor: email }).strict(), req.body);
      const gone = await forOrg(orgId, deps.db).chatChannel.deleteMany({ where: { kind } });
      if (!gone.count) return reply.code(404).send({ error: "Not connected." });
      await adminEvent(deps, orgId, b.actor, "chat.disconnected", { channel: kind });
      return { removed: true };
    });

    internal.post<P>("/internal/orgs/:org/chat/whatsapp/numbers", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(z.object({ userId: id, number: z.string().trim().min(6).max(30) }).strict(), req.body);
      const ch = await forOrg(orgId, deps.db).chatChannel.findFirst({ where: { kind: "whatsapp", enabled: true } });
      const channel = ch ? { config: WhatsAppConfig.parse(ch.config), secrets: openChatSecrets<WhatsAppSecrets>(deps, orgId, "whatsapp", ch.secretsEnc) } : null;
      const r = await startNumberVerification(deps, orgId, b, channel);
      return r.ok ? r : reply.code(r.status).send({ error: r.error });
    });

    internal.post<P>("/internal/orgs/:org/chat/whatsapp/numbers/confirm", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(z.object({ userId: id, code: z.string().trim().max(10), actor: email }).strict(), req.body);
      const r = await confirmNumber(deps, orgId, b);
      return r.ok ? r : reply.code(r.status).send({ error: r.error });
    });

    internal.post<P>("/internal/orgs/:org/chat/whatsapp/numbers/remove", async (req, reply) => {
      const orgId = await org(req.params.org);
      const b = parse(z.object({ userId: id, actor: email }).strict(), req.body);
      return (await removeNumber(deps, orgId, b)) ? { removed: true } : reply.code(404).send({ error: "No number on file." });
    });
  });
}
