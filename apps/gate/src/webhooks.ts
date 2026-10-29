import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { decrypt, encrypt, type Receipt } from "@gate/core";
import { EgressBlocked, forOrg } from "@gate/db";
import { adminEvent } from "./admin";
import { chain } from "./chain";
import type { Deps } from "./deps";

export const WEBHOOK_EVENTS = ["receipt.created", "approval.pending", "approval.resolved", "alert.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const TEST_EVENT = "webhook.test";
export const DELIVER_QUEUE = "webhook-deliver";
export const MAX_ATTEMPTS = 8;
export const TIMEOUT_MS = 10_000;
/** How long one attempt may hold a delivery before another worker may take it over. */
const LEASE_MS = 60_000;

const secretAad = (webhookId: string) => `webhook-secret:${webhookId}`;

/** Delay before attempt n+1 after n failures: 30 s, 1, 2, 4, 8, 16, 32 minutes (capped at 6 h). */
export function backoffSeconds(failures: number): number {
  return Math.min(30 * 2 ** Math.max(0, failures - 1), 6 * 3600);
}

// ---- Signing (Stripe-style): gate-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>"> ----

/**
 * The signature header. After a secret is rolled, the previous secrets still valid sign too, each as a further
 * `v1` value (the current one first), so a receiver can switch over without missing a delivery.
 */
export function signWebhook(secret: string, body: string, now = Date.now(), previous: readonly string[] = []): string {
  const t = Math.floor(now / 1000);
  const v1 = (s: string) => `v1=${createHmac("sha256", s).update(`${t}.${body}`).digest("hex")}`;
  return [`t=${t}`, v1(secret), ...previous.map(v1)].join(",");
}

/** How long the previous secret keeps signing after a roll. */
export const ROLL_GRACE_MS = 24 * 3_600_000;

// ---- SSRF protection ----

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible range
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) PRIVATE.addSubnet(net, prefix, "ipv6");

/** Loopback, private, link-local, CGNAT, multicast, documentation and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE.check(ip, "ipv4");
  if (family !== 6) return true;
  let canonical: string;
  try {
    // The URL parser writes IPv6 in one canonical form, e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1.
    canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const hi = parseInt(mapped[1] as string, 16);
    const lo = parseInt(mapped[2] as string, 16);
    return PRIVATE.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return PRIVATE.check(canonical, "ipv6");
}

export class BlockedAddressError extends Error {
  constructor() {
    super("the address is private or reserved, so Elan1 Govern did not connect");
  }
}

/** Webhook URLs: http(s), no credentials, a real host, at most 2000 characters. */
export function checkWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  if (raw.length > 2000) return { ok: false, error: "The URL is too long." };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "The URL must start with https:// or http://." };
  if (url.username || url.password) return { ok: false, error: "Put credentials in the signing secret, not in the URL." };
  if (!url.hostname) return { ok: false, error: "The URL needs a host name." };
  return { ok: true, url };
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * DNS lookup that refuses private addresses. The connection uses exactly the address checked
 * here, so a DNS answer that changes between check and connect (rebinding) cannot slip through.
 */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCb) => {
    dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) return cb(err, []);
      const list = addresses as LookupAddress[];
      if (!list.length) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), []);
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) return cb(new BlockedAddressError(), []);
      if (options.all) return cb(null, list);
      const first = list[0] as LookupAddress;
      return cb(null, first.address, first.family);
    });
  };
}

export interface PostResult {
  status: number;
}

/** POST a JSON body. Never follows redirects. Resolves with the status; rejects on network errors. */
export function postJson(url: URL, body: string, headers: Record<string, string>, opts: { allowPrivate: boolean; timeoutMs?: number }): Promise<PostResult> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) return Promise.reject(new BlockedAddressError());
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        lookup: guardedLookup(opts.allowPrivate) as never,
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
        agent: false,
      },
      (res) => {
        res.resume(); // the body is not read or stored
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A short, PII-free reason for a failed attempt (no URLs, headers or response bodies). */
export function describeError(e: unknown): string {
  const err = e as Error & { code?: string; name?: string };
  if (err instanceof BlockedAddressError) return err.message;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `no response within ${TIMEOUT_MS / 1000} seconds`;
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") return "the host name could not be resolved";
  if (err?.code === "ECONNREFUSED") return "the connection was refused";
  if (err?.code === "ECONNRESET") return "the connection was reset";
  if (typeof err?.code === "string" && err.code.startsWith("ERR_TLS") || err?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || err?.code === "CERT_HAS_EXPIRED") return "the TLS certificate was not accepted";
  return typeof err?.code === "string" ? `network error (${err.code})` : "network error";
}

// ---- Events from receipts ----

function approvalPayload(r: Receipt) {
  const a = r.approval as NonNullable<Receipt["approval"]>;
  return {
    approval_id: a.id,
    status: a.result,
    agent: r.agent,
    tool: r.tool,
    rule_id: r.rule_id,
    reason: r.reason,
    args_summary: r.args_summary,
    ...(a.expires_at ? { expires_at: a.expires_at } : {}),
    ...(a.by ? { by: a.by } : {}),
    ...(a.at ? { at: a.at } : {}),
    ...(a.self_approval ? { self_approval: true } : {}),
    ...(r.outcome ? { outcome: r.outcome } : {}),
    receipt_seq: r.seq,
    ...(r.ref_seq ? { held_seq: r.ref_seq } : {}),
  };
}

/** The events a receipt produces. Payloads are built from the receipt, which is already minimised. */
export function eventsFor(r: Receipt): { event: WebhookEvent; payload: object }[] {
  const out: { event: WebhookEvent; payload: object }[] = [{ event: "receipt.created", payload: r }];
  if (r.kind === "decision" && r.decision === "ask" && r.approval?.result === "pending") out.push({ event: "approval.pending", payload: approvalPayload(r) });
  if (r.kind === "approval" && r.approval) out.push({ event: "approval.resolved", payload: approvalPayload(r) });
  if (r.kind === "admin" && r.action === "alert.created") {
    const d = (r.details ?? {}) as Record<string, unknown>;
    out.push({ event: "alert.created", payload: { alert_id: d.alert_id, agent: r.agent, detector: d.detector, severity: d.severity, title: d.title, explanation: d.explanation, receipts: d.receipts, receipt_seq: r.seq } });
  }
  return out;
}

/** After a chain write commits: one delivery row per subscribed endpoint and event, then a job each. */
export async function enqueueReceiptEvents(deps: Deps, orgId: string, receipts: readonly Receipt[]): Promise<number> {
  const db = forOrg(orgId, deps.db);
  const hooks = await db.webhook.findMany({ where: { active: true }, select: { id: true, events: true } });
  if (!hooks.length) return 0;
  const rows: { orgId: string; webhookId: string; event: string; payload: object; nextAttemptAt: Date }[] = [];
  const now = new Date();
  for (const r of receipts) {
    for (const e of eventsFor(r)) {
      for (const h of hooks) if (h.events.includes(e.event)) rows.push({ orgId, webhookId: h.id, event: e.event, payload: e.payload, nextAttemptAt: now });
    }
  }
  if (!rows.length) return 0;
  const created = await db.webhookDelivery.createManyAndReturn({ data: rows, select: { id: true } });
  for (const d of created) await deps.queue.send(DELIVER_QUEUE, { orgId, deliveryId: d.id }, { singletonKey: `${d.id}:0` });
  return created.length;
}

// ---- Delivery ----

export type DeliveryOutcome = "delivered" | "retrying" | "failed" | "skipped";

export function webhookBody(d: { id: string; event: string; createdAt: Date; payload: unknown }, orgId: string): string {
  return JSON.stringify({ id: d.id, type: d.event, created_at: d.createdAt.toISOString(), org: orgId, data: d.payload });
}

/** One delivery attempt. Safe to call twice at once: the attempt is claimed first. */
export async function deliverWebhook(deps: Deps, orgId: string, deliveryId: string): Promise<DeliveryOutcome> {
  const db = forOrg(orgId, deps.db);
  const now = new Date();
  const claimed = await db.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "pending", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return "skipped";
  const d = await db.webhookDelivery.findFirstOrThrow({ where: { id: deliveryId }, include: { webhook: true } });
  const attempts = d.attempts + 1;
  const finish = async (ok: boolean, info: { error?: string; status?: number }, final = false): Promise<DeliveryOutcome> => {
    const outcome: DeliveryOutcome = ok ? "delivered" : final || attempts >= MAX_ATTEMPTS || !d.webhook.active ? "failed" : "retrying";
    const delay = backoffSeconds(attempts);
    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts,
        status: outcome === "retrying" ? "pending" : outcome,
        lastError: info.error ?? null,
        responseStatus: info.status ?? null,
        nextAttemptAt: outcome === "retrying" ? new Date(Date.now() + delay * 1000) : null,
        deliveredAt: ok ? new Date() : null,
      },
    });
    if (outcome === "retrying") await deps.queue.send(DELIVER_QUEUE, { orgId, deliveryId }, { startAfter: delay, singletonKey: `${deliveryId}:${attempts}` });
    deps.log.info({ job: "webhook.deliver", orgId, webhookId: d.webhookId, deliveryId, event: d.event, attempt: attempts, outcome, status: info.status }, "webhook delivery");
    return outcome;
  };
  if (!d.webhook.active) return finish(false, { error: "the endpoint is turned off" });

  const checked = checkWebhookUrl(d.webhook.url);
  if (!checked.ok) return finish(false, { error: checked.error });
  // The deployment's egress policy, before connecting; the address checks still run at connect time.
  // A denied host is not retried: nothing changes until the allow-list does.
  try {
    await deps.egress.check(checked.url, "webhook", { orgId });
  } catch (e) {
    if (e instanceof EgressBlocked) return finish(false, { error: e.message }, true);
    throw e;
  }
  const body = webhookBody(d, orgId);
  let secret: string;
  let previous: string[];
  try {
    secret = decrypt(deps.env.GATE_MASTER_KEY, d.webhook.secretEnc, secretAad(d.webhookId));
    const rolls = await db.webhookSecretRoll.findMany({ where: { webhookId: d.webhookId, validUntil: { gt: new Date() } }, orderBy: { createdAt: "desc" }, select: { previousSecretEnc: true } });
    previous = rolls.map((x) => decrypt(deps.env.GATE_MASTER_KEY, x.previousSecretEnc, secretAad(d.webhookId)));
  } catch {
    return finish(false, { error: "the signing secret could not be read" });
  }
  try {
    const res = await postJson(
      checked.url,
      body,
      { "content-type": "application/json", "user-agent": "Elan1 Govern-Webhooks/1", "gate-signature": signWebhook(secret, body, Date.now(), previous), "gate-event": d.event, "gate-delivery": d.id },
      { allowPrivate: deps.env.WEBHOOK_ALLOW_PRIVATE },
    );
    if (res.status >= 200 && res.status < 300) return finish(true, { status: res.status });
    return finish(false, { status: res.status, error: `the endpoint answered HTTP ${res.status}` });
  } catch (e) {
    return finish(false, { error: describeError(e) });
  }
}

// ---- Admin ----

export type CreateWebhookResult = { ok: true; id: string; secret: string; secretPrefix: string; seq: number } | { ok: false; error: string };

/** The part of a secret shown afterwards (whsec_4fK2): enough to tell secrets apart, too little to sign with. */
export const secretPrefixOf = (secret: string) => secret.slice(0, 10);

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

/** `action` names the receipt: webhook.created from the web app's routes, webhook.added from the console's screens. */
export async function createWebhook(deps: Deps, orgId: string, input: { url: string; events: WebhookEvent[]; actor: string; action?: "webhook.created" | "webhook.added" }): Promise<CreateWebhookResult> {
  const checked = checkWebhookUrl(input.url);
  if (!checked.ok) return checked;
  const egress = await deps.egress.decide(checked.url, "webhook", { orgId, actor: input.actor });
  if (!egress.allowed) return { ok: false, error: `${checked.url.host} is not on this deployment's egress allow-list, so Elan1 Govern cannot deliver to it. Nothing was saved.` };
  const events = [...new Set(input.events)].filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (!events.length) return { ok: false, error: "Pick at least one event." };
  const db = forOrg(orgId, deps.db);
  if ((await db.webhook.count()) >= 20) return { ok: false, error: "An organisation can have up to 20 webhook endpoints." };
  const id = `wh_${randomBytes(12).toString("base64url")}`;
  const secret = newSecret();
  const secretPrefix = secretPrefixOf(secret);
  await db.webhook.create({ data: { id, orgId, url: checked.url.toString(), secretEnc: encrypt(deps.env.GATE_MASTER_KEY, secret, secretAad(id)), secretPrefix, events, createdBy: input.actor } });
  // The receipt names the host only: paths and query strings can carry tokens.
  const r = await adminEvent(deps, orgId, input.actor, input.action ?? "webhook.created", { webhook_id: id, host: checked.url.host, events: events.join(",") });
  return { ok: true, id, secret, secretPrefix, seq: r.seq };
}

/** Deletes an endpoint (its deliveries and rolled secrets go with it) and writes the receipt, in one transaction. */
export async function removeWebhook(deps: Deps, orgId: string, id: string, actor: string): Promise<{ seq: number } | null> {
  return chain(deps, orgId, async (append, tx) => {
    const hook = await tx.webhook.findFirst({ where: { id } });
    if (!hook) return null;
    await tx.webhookSecretRoll.deleteMany({ where: { webhookId: id } });
    await tx.webhook.deleteMany({ where: { id } });
    const r = await append({ kind: "admin", actor, action: "webhook.deleted", details: { webhook_id: id, host: new URL(hook.url).host } });
    return { seq: r.seq };
  });
}

export async function deleteWebhook(deps: Deps, orgId: string, id: string, actor: string): Promise<boolean> {
  return !!(await removeWebhook(deps, orgId, id, actor));
}

/** Turns an endpoint on or off. An endpoint that is off is sent nothing; what waits for it fails. One transaction with its receipt. */
export async function setWebhookActive(deps: Deps, orgId: string, id: string, active: boolean, actor: string): Promise<{ seq: number } | null> {
  return chain(deps, orgId, async (append, tx) => {
    const hook = await tx.webhook.findFirst({ where: { id } });
    if (!hook) return null;
    await tx.webhook.updateMany({ where: { id }, data: { active } });
    const r = await append({ kind: "admin", actor, action: active ? "webhook.enabled" : "webhook.disabled", details: { webhook_id: id, host: new URL(hook.url).host } });
    return { seq: r.seq };
  });
}

export interface RolledSecret {
  secret: string;
  secretPrefix: string;
  previousPrefix: string;
  previousValidUntil: string;
  rollId: string;
  seq: number;
}

/**
 * A new signing secret, shown once. The previous one keeps signing, as a second `v1` value, for ROLL_GRACE_MS.
 * The new secret, the roll and the receipt are one transaction.
 */
export async function rollWebhookSecret(deps: Deps, orgId: string, id: string, actor: string, now = new Date()): Promise<RolledSecret | null> {
  return chain(deps, orgId, async (append, tx) => {
    const hook = await tx.webhook.findFirst({ where: { id } });
    if (!hook) return null;
    const secret = newSecret();
    const secretPrefix = secretPrefixOf(secret);
    const validUntil = new Date(now.getTime() + ROLL_GRACE_MS);
    await tx.webhook.updateMany({ where: { id }, data: { secretEnc: encrypt(deps.env.GATE_MASTER_KEY, secret, secretAad(id)), secretPrefix } });
    const roll = await tx.webhookSecretRoll.create({ data: { orgId, webhookId: id, previousSecretEnc: hook.secretEnc, previousPrefix: hook.secretPrefix, validUntil, createdBy: actor } });
    const r = await append({ kind: "admin", actor, action: "webhook.secret_rolled", details: { webhook_id: id, host: new URL(hook.url).host, previous_valid_until: validUntil.toISOString(), roll_id: roll.id } });
    return { secret, secretPrefix, previousPrefix: hook.secretPrefix, previousValidUntil: validUntil.toISOString(), rollId: roll.id, seq: r.seq };
  });
}

/** Sends a `webhook.test` event to one endpoint now and reports how it went. Failures retry as usual. */
export async function testWebhook(deps: Deps, orgId: string, id: string): Promise<{ deliveryId: string; outcome: DeliveryOutcome } | null> {
  const db = forOrg(orgId, deps.db);
  const hook = await db.webhook.findFirst({ where: { id } });
  if (!hook) return null;
  const d = await db.webhookDelivery.create({
    data: { orgId, webhookId: id, event: TEST_EVENT, payload: { message: "This is a test event from Elan1 Govern. No action happened." }, nextAttemptAt: new Date() },
  });
  return { deliveryId: d.id, outcome: await deliverWebhook(deps, orgId, d.id) };
}

/**
 * Sends one delivery again now, under its own id (the body's `id`), so the endpoint can tell it is the same event.
 * One more attempt: a delivery that gave up gets just this one; one still retrying keeps the attempts it has left.
 */
export async function resendWebhookDelivery(deps: Deps, orgId: string, webhookId: string, deliveryId: string): Promise<{ deliveryId: string; outcome: DeliveryOutcome } | null> {
  const db = forOrg(orgId, deps.db);
  const d = await db.webhookDelivery.findFirst({ where: { id: deliveryId, webhookId } });
  if (!d) return null;
  const attempts = d.status === "pending" ? d.attempts : Math.max(d.attempts, MAX_ATTEMPTS - 1);
  await db.webhookDelivery.updateMany({ where: { id: deliveryId }, data: { status: "pending", attempts, nextAttemptAt: new Date(), deliveredAt: null } });
  return { deliveryId, outcome: await deliverWebhook(deps, orgId, deliveryId) };
}

/** How many dead letters one replay sends (each waits for its endpoint, up to TIMEOUT_MS). */
export const REPLAY_BATCH = 20;

/**
 * Sends the deliveries that gave up (failed) again, one attempt each, to endpoints that are on, oldest first; the
 * receipt says how many got through. A delivery that fails again stays failed, for the next replay.
 */
export async function replayDeadLetters(deps: Deps, orgId: string, input: { webhookId?: string; actor: string }): Promise<{ delivered: number; failed: number; seq: number }> {
  const db = forOrg(orgId, deps.db);
  const dead = await db.webhookDelivery.findMany({
    where: { status: "failed", ...(input.webhookId ? { webhookId: input.webhookId } : {}), webhook: { active: true } },
    orderBy: { createdAt: "asc" },
    take: REPLAY_BATCH,
    select: { id: true },
  });
  let delivered = 0;
  let failed = 0;
  for (const d of dead) {
    const claimed = await db.webhookDelivery.updateMany({ where: { id: d.id, status: "failed" }, data: { status: "pending", attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date() } });
    if (!claimed.count) continue;
    if ((await deliverWebhook(deps, orgId, d.id)) === "delivered") delivered++;
    else failed++;
  }
  const r = await adminEvent(deps, orgId, input.actor, "webhook.dead_letter_replayed", { delivered, failed, ...(input.webhookId ? { webhook_id: input.webhookId } : {}) });
  return { delivered, failed, seq: r.seq };
}
