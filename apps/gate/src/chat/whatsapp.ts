import { createHash, randomInt } from "node:crypto";
import { decrypt, encrypt, randomToken } from "@gate/core";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { adminEvent } from "../admin";
import type { Deps } from "../deps";
import { ChatApiError, chatFetch, expiryWords, hmacHex, normalizeNumber, numberAad, numberHash, sameSignature, sealChatSecrets, whatsappUserId, type ApprovalView } from "./common";

// WhatsApp (Meta WhatsApp Cloud API): an org stores its business phone-number ID, an access token
// and the Meta app secret. Approvers add and verify their own number. Approve/Reject reply buttons
// are sent only when the rule allows chat approval; otherwise a link to Elan1 Govern.

export interface WhatsAppSecrets extends Record<string, string> {
  accessToken: string;
  appSecret: string;
}
export const WhatsAppConfig = z.object({
  phoneNumberId: z.string(),
  /** Approved message template with two quick-reply buttons, for messages outside Meta's 24-hour window. */
  templateName: z.string().optional(),
  templateLanguage: z.string().optional(),
  /** Approved authentication template for the 6-digit number check. */
  verifyTemplateName: z.string().optional(),
});
export type WhatsAppConfig = z.infer<typeof WhatsAppConfig>;

export const CODE_TTL_MS = 10 * 60_000;
export const CODES_PER_WINDOW = 3;
export const CODE_WINDOW_MS = 15 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

// ---- Inbound ----

/** Meta signs the raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaSignature(appSecret: string, header: string | undefined, rawBody: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  return sameSignature(`sha256=${hmacHex(appSecret, rawBody)}`, header);
}

export const verifyTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

const WaMessage = z.object({
  from: z.string().max(20),
  id: z.string().max(200),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string().max(40),
  interactive: z.object({ type: z.string().max(40), button_reply: z.object({ id: z.string().max(256), title: z.string().max(40).optional() }).optional() }).optional(),
  button: z.object({ payload: z.string().max(256).optional(), text: z.string().max(40).optional() }).optional(),
});

/** The part of a Cloud API webhook Elan1 Govern reads. Status updates and other fields are ignored. */
export const WhatsAppWebhook = z.object({
  object: z.string().max(64),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string().max(64).optional(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string().max(40) }).optional(),
                messages: z.array(WaMessage).max(100).optional(),
              }),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});
export type WhatsAppWebhook = z.infer<typeof WhatsAppWebhook>;
export type WaIncoming = z.infer<typeof WaMessage>;

const DECISION_RE = /^(approve|reject):(apr_[A-Za-z0-9_-]{1,40})$/;

/** A reply-button tap (interactive) or a template quick-reply (button) that carries a decision. */
export function decisionOf(m: WaIncoming): { result: "approved" | "rejected"; approvalId: string } | null {
  const raw = m.type === "interactive" ? m.interactive?.button_reply?.id : m.type === "button" ? m.button?.payload : undefined;
  const hit = raw ? DECISION_RE.exec(raw) : null;
  return hit ? { result: hit[1] === "approve" ? "approved" : "rejected", approvalId: hit[2] as string } : null;
}

// ---- Outbound: Graph API ----

const NON_RETRYABLE = new Set([100, 131008, 131009, 131021, 131026, 131030, 131031, 131047, 131051, 132000, 132001, 132012, 133010, 190, 200, 10]);
const WaError = z.object({ error: z.object({ code: z.number().optional() }).passthrough() }).passthrough();

async function waCall(deps: Deps, orgId: string, token: string, path: string, body?: object): Promise<Record<string, unknown>> {
  const res = await chatFetch(deps, orgId, "whatsapp", path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // Only the numeric error code is kept: Meta's messages can repeat the phone number.
    const code = WaError.safeParse(data).data?.error.code;
    throw new ChatApiError(code ? `WhatsApp error ${code}${code === 131047 ? " (more than 24 hours since the approver last wrote; set up a message template)" : ""}` : `WhatsApp answered HTTP ${res.status}`, code ? !NON_RETRYABLE.has(code) : res.status >= 500 || res.status === 429, res.status);
  }
  if (!data || typeof data !== "object") throw new ChatApiError("WhatsApp sent an answer Elan1 Govern could not read");
  return data;
}

export async function waSend(deps: Deps, orgId: string, token: string, phoneNumberId: string, to: string, message: object): Promise<string> {
  const data = await waCall(deps, orgId, token, `${phoneNumberId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to, ...message });
  const id = z.object({ messages: z.array(z.object({ id: z.string().max(200) })).min(1) }).safeParse(data);
  if (!id.success) throw new ChatApiError("WhatsApp did not return a message id");
  return id.data.messages[0]!.id;
}

/** Template parameters may not contain new lines, tabs or more than four spaces in a row. */
const param = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max - 1)}…` : s).replace(/[\n\t]+/g, " ").replace(/ {4,}/g, "   ");
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** What an approver receives. Buttons only when the rule allows deciding in chat. */
export function whatsAppApprovalMessage(v: ApprovalView, cfg: WhatsAppConfig): object {
  const lines = [
    `*Waiting for your approval*`,
    `${v.agent} wants to: ${v.action}`,
    ...(v.amount ? [`Amount: ${v.amount}`] : []),
    ...(v.vendor ? [`Vendor: ${v.vendor}`] : []),
    `Rule: ${v.rule}`,
    `Expires: ${expiryWords(v.expiresAt)}. If nobody decides, it is refused.`,
  ];
  if (!v.chatApproval) {
    return { type: "text", text: { preview_url: false, body: clip([...lines, "", `This one can only be decided in Elan1 Govern: ${v.url}`].join("\n"), 4000) } };
  }
  if (cfg.templateName) {
    // Business-initiated messages outside Meta's 24-hour window must use an approved template.
    return {
      type: "template",
      template: {
        name: cfg.templateName,
        language: { code: cfg.templateLanguage ?? "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: param(`${v.agent}: ${v.action}`) }, { type: "text", text: param(v.rule, 60) }, { type: "text", text: param(expiryWords(v.expiresAt), 60) }] },
          { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `approve:${v.id}` }] },
          { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `reject:${v.id}` }] },
        ],
      },
    };
  }
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: clip(lines.join("\n"), 1000) },
      footer: { text: "Recorded in Elan1 Govern" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `approve:${v.id}`, title: "Approve" } },
          { type: "reply", reply: { id: `reject:${v.id}`, title: "Reject" } },
        ],
      },
    },
  };
}

export const textMessage = (body: string) => ({ type: "text", text: { preview_url: false, body: clip(body, 4000) } });

// ---- Admin ----

export type WhatsAppConnectResult = { ok: true; id: string; url: string; verifyToken: string } | { ok: false; error: string };
const TEMPLATE_RE = /^[a-z0-9_]{1,512}$/;

export async function connectWhatsApp(
  deps: Deps,
  orgId: string,
  input: { phoneNumberId: string; accessToken: string; appSecret: string; templateName?: string; templateLanguage?: string; verifyTemplateName?: string; actor: string },
): Promise<WhatsAppConnectResult> {
  if (!/^\d{5,25}$/.test(input.phoneNumberId)) return { ok: false, error: "The phone-number ID is the long number under WhatsApp → API Setup in your Meta app (not the phone number itself)." };
  if (!/^[A-Za-z0-9_-]{20,1000}$/.test(input.accessToken)) return { ok: false, error: "That access token does not look right. Use a system-user token with the whatsapp_business_messaging permission." };
  if (!/^[a-f0-9]{16,128}$/.test(input.appSecret)) return { ok: false, error: "The app secret is under App settings → Basic in your Meta app." };
  for (const t of [input.templateName, input.verifyTemplateName]) if (t !== undefined && !TEMPLATE_RE.test(t)) return { ok: false, error: "Template names use lowercase letters, numbers and underscores." };
  if (input.templateLanguage !== undefined && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(input.templateLanguage)) return { ok: false, error: "The template language is a code like en or en_US." };
  try {
    const r = z.object({ id: z.string() }).safeParse(await waCall(deps, orgId, input.accessToken, `${input.phoneNumberId}?fields=id`));
    if (!r.success || r.data.id !== input.phoneNumberId) return { ok: false, error: "Meta did not recognise that phone-number ID for this token." };
  } catch (e) {
    return { ok: false, error: `Meta did not accept the access token (${(e as Error).message}).` };
  }
  const verifyToken = randomToken("wv_");
  const config: WhatsAppConfig = {
    phoneNumberId: input.phoneNumberId,
    ...(input.templateName ? { templateName: input.templateName, templateLanguage: input.templateLanguage ?? "en" } : {}),
    ...(input.verifyTemplateName ? { verifyTemplateName: input.verifyTemplateName } : {}),
  };
  const secretsEnc = sealChatSecrets(deps, orgId, "whatsapp", { accessToken: input.accessToken, appSecret: input.appSecret });
  const db = forOrg(orgId, deps.db);
  const row = await db.chatChannel.upsert({
    where: { orgId_kind: { orgId, kind: "whatsapp" } },
    create: { orgId, kind: "whatsapp", config, secretsEnc, verifyHash: verifyTokenHash(verifyToken), createdBy: input.actor },
    update: { config, secretsEnc, verifyHash: verifyTokenHash(verifyToken), enabled: true, createdBy: input.actor },
  });
  await adminEvent(deps, orgId, input.actor, "chat.connected", { channel: "whatsapp" });
  return { ok: true, id: row.id, url: `${deps.env.GATE_PUBLIC_URL}/chat/whatsapp/${row.id}/webhook`, verifyToken };
}

// ---- Approvers' numbers ----

export type NumberResult = { ok: true; last4: string; verified?: boolean } | { ok: false; status: 400 | 404 | 409 | 429 | 502; error: string };

const codeHash = (deps: Deps, rowId: string, code: string) => hmacHex(deps.env.GATE_MASTER_KEY, `wa-code:${rowId}:${code}`);

/** Starts (or restarts) verifying an approver's number: a 6-digit code, sent through the org's WhatsApp number. */
export async function startNumberVerification(deps: Deps, orgId: string, input: { userId: string; number: string }, channel: { config: WhatsAppConfig; secrets: WhatsAppSecrets } | null): Promise<NumberResult> {
  if (!channel) return { ok: false, status: 409, error: "WhatsApp is not connected for this organisation yet. An owner or admin sets it up under Settings → Notifications." };
  const e164 = normalizeNumber(input.number);
  if (!e164) return { ok: false, status: 400, error: "Enter the number with its country code, for example +91 98765 43210." };
  const db = forOrg(orgId, deps.db);
  const hash = numberHash(deps, e164);
  const taken = await db.chatNumber.findFirst({ where: { numberHash: hash, userId: { not: input.userId } }, select: { id: true } });
  if (taken) return { ok: false, status: 409, error: "Another member of this organisation already uses that number." };
  const now = new Date();
  const existing = await db.chatNumber.findFirst({ where: { userId: input.userId } });
  const windowOpen = existing?.windowStart && now.getTime() - existing.windowStart.getTime() < CODE_WINDOW_MS;
  const sent = windowOpen ? (existing?.codesSent ?? 0) : 0;
  if (sent >= CODES_PER_WINDOW) return { ok: false, status: 429, error: "Too many codes. Wait 15 minutes and try again." };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const data = {
    numberEnc: encrypt(deps.env.GATE_MASTER_KEY, e164, numberAad(orgId, input.userId)),
    numberHash: hash,
    last4: e164.slice(-4),
    verifiedAt: null,
    codeExpires: new Date(now.getTime() + CODE_TTL_MS),
    codeAttempts: 0,
    codesSent: sent + 1,
    windowStart: windowOpen ? existing!.windowStart : now,
  };
  const row = existing
    ? await db.chatNumber.update({ where: { id: existing.id }, data: { ...data, codeHash: null } })
    : await db.chatNumber.create({ data: { orgId, userId: input.userId, ...data } });
  await db.chatNumber.update({ where: { id: row.id }, data: { codeHash: codeHash(deps, row.id, code) } });

  const message = channel.config.verifyTemplateName
    ? {
        type: "template",
        template: {
          name: channel.config.verifyTemplateName,
          language: { code: channel.config.templateLanguage ?? "en" },
          components: [
            { type: "body", parameters: [{ type: "text", text: code }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
          ],
        },
      }
    : textMessage(`Your Elan1 Govern code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this message.`);
  try {
    await waSend(deps, orgId, channel.secrets.accessToken, channel.config.phoneNumberId, e164, message);
  } catch (e) {
    deps.log.warn({ job: "whatsapp.verify", orgId, err: (e as Error).message }, "verification code not sent");
    return { ok: false, status: 502, error: `WhatsApp did not deliver the code (${(e as Error).message}).` };
  }
  return { ok: true, last4: row.last4, verified: false };
}

export async function confirmNumber(deps: Deps, orgId: string, input: { userId: string; code: string; actor: string }): Promise<NumberResult> {
  const db = forOrg(orgId, deps.db);
  const row = await db.chatNumber.findFirst({ where: { userId: input.userId } });
  if (!row || !row.codeHash || !row.codeExpires) return { ok: false, status: 404, error: "Ask for a code first." };
  if (row.codeExpires <= new Date()) return { ok: false, status: 400, error: "That code has expired. Ask for a new one." };
  if (row.codeAttempts >= MAX_CODE_ATTEMPTS) return { ok: false, status: 429, error: "Too many wrong codes. Ask for a new one." };
  // Count the attempt before checking, so parallel guesses cannot get past the limit.
  const counted = await db.chatNumber.updateMany({ where: { id: row.id, codeAttempts: { lt: MAX_CODE_ATTEMPTS } }, data: { codeAttempts: { increment: 1 } } });
  if (counted.count !== 1) return { ok: false, status: 429, error: "Too many wrong codes. Ask for a new one." };
  if (!/^\d{6}$/.test(input.code) || !sameSignature(codeHash(deps, row.id, input.code), row.codeHash)) return { ok: false, status: 400, error: "That code is not right." };
  await db.chatNumber.update({ where: { id: row.id }, data: { verifiedAt: new Date(), codeHash: null, codeExpires: null, codeAttempts: 0 } });
  await adminEvent(deps, orgId, input.actor, "chat.number_verified", { channel: "whatsapp", number_id: whatsappUserId(row.numberHash) });
  return { ok: true, last4: row.last4, verified: true };
}

export async function removeNumber(deps: Deps, orgId: string, input: { userId: string; actor: string }): Promise<boolean> {
  const db = forOrg(orgId, deps.db);
  const row = await db.chatNumber.findFirst({ where: { userId: input.userId } });
  if (!row) return false;
  await db.chatNumber.deleteMany({ where: { id: row.id } });
  if (row.verifiedAt) await adminEvent(deps, orgId, input.actor, "chat.number_removed", { channel: "whatsapp", number_id: whatsappUserId(row.numberHash) });
  return true;
}

/** The approver's number, decrypted in memory only to send a message. */
export function openNumber(deps: Deps, orgId: string, row: { userId: string; numberEnc: string }): string {
  return decrypt(deps.env.GATE_MASTER_KEY, row.numberEnc, numberAad(orgId, row.userId));
}
