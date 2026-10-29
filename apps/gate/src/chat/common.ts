import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { decrypt, describeAction, encrypt, formatINR } from "@gate/core";
import { EgressBlocked } from "@gate/db";
import type { Deps } from "../deps";

// Approvals in Slack and WhatsApp. Chat is a doorbell: rules, decisions, receipts and the audit
// trail stay in Elan1 Govern. Everything here is shared by the Slack and WhatsApp code.

export type ChatKind = "slack" | "whatsapp";
export const CHAT_KINDS = ["slack", "whatsapp"] as const;
/** Where a decision was made, as written on the approval row and its receipt. */
export type DecisionChannel = "web" | "email" | ChatKind;

export const CHAT_TIMEOUT_MS = 10_000;
/** Slack's own replay window, also used for WhatsApp message timestamps. */
export const CHAT_MAX_AGE_SECONDS = 300;

export const CHAT_LABELS: Record<ChatKind, string> = { slack: "Slack", whatsapp: "WhatsApp" };

/** A failed call to a chat API. `retry: false` means trying again will not help (bad token, unknown channel). */
export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly retry = true,
    readonly status?: number,
  ) {
    super(message);
  }
}

const secretsAad = (orgId: string, kind: ChatKind) => `chat-secrets:${orgId}:${kind}`;

export function sealChatSecrets(deps: Deps, orgId: string, kind: ChatKind, secrets: Record<string, string>): string {
  return encrypt(deps.env.GATE_MASTER_KEY, JSON.stringify(secrets), secretsAad(orgId, kind));
}

export function openChatSecrets<T extends Record<string, string>>(deps: Deps, orgId: string, kind: ChatKind, sealed: string): T {
  return JSON.parse(decrypt(deps.env.GATE_MASTER_KEY, sealed, secretsAad(orgId, kind))) as T;
}

function baseUrl(deps: Deps, kind: ChatKind): URL {
  const raw = kind === "slack" ? deps.env.SLACK_API_URL : deps.env.WHATSAPP_API_URL;
  // Empty in the sovereign profile unless the operator points it at an internal relay.
  if (!raw) throw new ChatApiError(`${CHAT_LABELS[kind]} is not available in this deployment`, false);
  return new URL(raw.endsWith("/") ? raw : `${raw}/`);
}

/**
 * The only way Elan1 Govern calls Slack or Meta. The URL is always built from the configured base
 * (slack.com or graph.facebook.com in production, checked at startup), any path that would leave
 * it is refused, then the egress gate decides (deny-all in the sovereign profile), redirects are
 * never followed and every call times out.
 */
export async function chatFetch(deps: Deps, orgId: string, kind: ChatKind, path: string, init: RequestInit): Promise<Response> {
  const base = baseUrl(deps, kind);
  const url = new URL(path.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new ChatApiError(`refused to call outside the ${CHAT_LABELS[kind]} API`, false);
  try {
    await deps.egress.check(url, `chat-${kind}`, { orgId });
  } catch (e) {
    if (e instanceof EgressBlocked) throw new ChatApiError(`this deployment's egress policy does not allow ${CHAT_LABELS[kind]}`, false);
    throw e;
  }
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error;
    throw new ChatApiError(err.name === "TimeoutError" ? `${CHAT_LABELS[kind]} did not answer within ${CHAT_TIMEOUT_MS / 1000} seconds` : `could not reach ${CHAT_LABELS[kind]}`);
  }
}

/** Constant-time comparison of two hex or text signatures of any length. */
export function sameSignature(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export const hmacHex = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest("hex");

// ---- WhatsApp numbers: only a keyed hash and the last four digits ever leave the encrypted column ----

/** +919876543210 or 919876543210 or "+91 98765 43210" -> "919876543210" (E.164 digits), or null. */
export function normalizeNumber(raw: string): string | null {
  const digits = raw.replace(/[\s().-]/g, "").replace(/^\+/, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** Keyed hash of a number: matches incoming messages without storing the number in clear. */
export function numberHash(deps: Deps, e164: string): string {
  return hmacHex(createHash("sha256").update(`chat-number:${deps.env.GATE_MASTER_KEY}`).digest("hex"), e164);
}

export const numberAad = (orgId: string, userId: string) => `chat-number:${orgId}:${userId}`;

/** The id a WhatsApp decision is recorded under: a short hash, never the number. */
export const whatsappUserId = (hash: string) => `wa:${hash.slice(0, 16)}`;

// ---- What an approval message says ----

export interface ApprovalView {
  id: string;
  agent: string;
  action: string;
  rule: string;
  reason: string;
  amount?: string;
  vendor?: string;
  expiresAt: Date;
  url: string;
  chatApproval: boolean;
  status: "pending" | "approved" | "rejected" | "expired";
  resolvedBy?: string;
  channel?: string;
  outcome?: string;
}

interface ApprovalLike {
  id: string;
  tool: string;
  argsSummary: unknown;
  ruleId: string;
  reason: string;
  expiresAt: Date;
  chatApproval: boolean;
  status: ApprovalView["status"];
  resolvedBy: string | null;
  channel: string | null;
  result: unknown;
}

/** The amount and vendor summary fields, from the stored (already minimised) summary. */
export function summaryFields(s: Record<string, unknown>): { amount?: string; vendor?: string } {
  const out: { amount?: string; vendor?: string } = {};
  if (typeof s.amount_inr === "number") out.amount = formatINR(s.amount_inr);
  else {
    const key = Object.keys(s).find((k) => /^amount($|_)/.test(k) && typeof s[k] === "number");
    if (key) out.amount = String(s[key]);
  }
  const vendor = typeof s.vendor === "string" ? s.vendor : typeof s.vendor_id === "string" ? s.vendor_id : undefined;
  if (vendor) out.vendor = vendor;
  return out;
}

export function approvalView(deps: Deps, a: ApprovalLike, agentName: string): ApprovalView {
  const summary = (a.argsSummary ?? {}) as Record<string, unknown>;
  const r = a.result as { status?: string; error?: string } | null;
  return {
    id: a.id,
    agent: agentName,
    action: describeAction(a.tool, summary),
    rule: a.ruleId,
    reason: a.reason,
    ...summaryFields(summary),
    expiresAt: a.expiresAt,
    url: `${deps.env.WEB_URL}/approvals/${a.id}`,
    chatApproval: a.chatApproval,
    status: a.status,
    ...(a.resolvedBy ? { resolvedBy: a.resolvedBy } : {}),
    ...(a.channel ? { channel: a.channel } : {}),
    ...(r?.status ? { outcome: r.status === "ok" ? "done" : r.status === "error" ? `did not complete: ${r.error ?? "unknown error"}` : "not run" } : {}),
  };
}

export const CHANNEL_WORDS: Record<string, string> = { web: "in Elan1 Govern", email: "from an email link", slack: "in Slack", whatsapp: "in WhatsApp" };

/** "Approved by priya@acme.in in Slack." */
export function outcomeLine(v: ApprovalView): string {
  if (v.status === "pending") return "Waiting for a decision.";
  if (v.status === "expired") return "Nobody decided in time, so the action was refused.";
  const where = v.channel ? ` ${CHANNEL_WORDS[v.channel] ?? ""}` : "";
  return `${v.status === "approved" ? "Approved" : "Rejected"} by ${v.resolvedBy ?? "an approver"}${where}.${v.status === "approved" && v.outcome ? ` Result: ${v.outcome}.` : ""}`;
}

export function expiryWords(d: Date): string {
  return `${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST`;
}
