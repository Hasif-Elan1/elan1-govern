import "server-only";
import { createHash } from "node:crypto";
import { forOrg, parseAllowList } from "@gate/db";
import { env } from "../../env";
import { gate } from "../../gate";
import { docOf, override, realRole, touch, wire, type Ctx, type Doc } from "./common";

/*
 * Sovereign deployment (wiring): the console's Deployment screens for a Sovereign organisation on the real egress
 * gate and the real update records.
 *  - The internal allow-list is the organisation's EgressRule rows (the console's "what it is for" is the rule's
 *    note); the egress log is its EgressLog rows the gate blocked. The console's own figures of blocked traffic
 *    (a deterministic background it generates) are not shown by these operations.
 *  - Update bundles are the deployment's UpdateRecord rows (platform-wide, imported from UPDATE_IMPORT_DIR):
 *    verified → available, staged → staged, active → applied (running), inactive → applied (before), rolled back →
 *    staged again in the console's words ("still verified; it can be applied again"), which the gate stages anew
 *    before applying. Rollbacks are the update.rolled_back receipts on this organisation's chain.
 * Each read brings the document in line (d.sovereign.internalHosts, d.sovereign.egress, d.sovereign.rollbacks,
 * d.platform.updates), so the screens' synchronous reads (internal hosts, the rollback target) show the real rows.
 * Signed usage statements (statements, preview, exportStatement, handover) stay the console's own (signing scope).
 */

const D = 86_400_000;
const H = 3_600_000;

interface InternalHost {
  host: string;
  purpose: string;
  addedAt: string;
  addedBy: string;
  seq?: number;
}
interface EgressAttempt {
  id: string;
  at: string;
  destination: string;
  component: string;
  source: string;
  note?: string;
  by?: string;
  seq?: number;
}
interface RollbackEntry {
  id: string;
  updateId: string;
  fromVersion: string;
  toVersion: string;
  at: string;
  by: string;
  reason: string;
  seq: number;
}
interface Sov {
  v: 1;
  internalHosts: InternalHost[];
  egress: EgressAttempt[];
  statements: unknown[];
  rollbacks: RollbackEntry[];
}
type DocReceipt = { seq: number; ts: string; actor?: string; action?: string; details?: Record<string, unknown> };

/** An UpdateRecord as the gate sends it (apps/gate/src/wiring/egress.ts recordJson). */
interface UpdateRecordJson {
  id: string;
  version: string;
  manifest: { createdAt?: string; notes?: string | string[]; signature?: string };
  manifestSha256: string;
  kid: string;
  status: "verified" | "staged" | "active" | "inactive" | "rolled_back";
  previousVersion: string | null;
  importedBy: string;
  importedAt: string;
  stagedBy: string | null;
  stagedAt: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  rolledBackBy: string | null;
  rolledBackAt: string | null;
  rollbackReason: string | null;
}
interface UpdatesState {
  records: UpdateRecordJson[];
  release: { kid: string; fingerprint: string; publicKey: string } | null;
  importDir: boolean;
}
type Bundle = Record<string, unknown> & { id: string; version: string; status: string };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isSov = (d: Doc) => d.org?.deployment === "sovereign";

/** The console's own sentences (apps/console/src/mock/sovereign.ts). */
function requireSov(ctx: Ctx, what: string) {
  if (!isSov(docOf(ctx))) throw new Error(`${what} is for Sovereign deployments, which run on your own infrastructure.`);
}
async function requireOwnerAdmin(ctx: Ctx, what: string) {
  const role = await realRole(ctx.orgId, ctx.actorUserId);
  if (role !== "owner" && role !== "admin") throw new Error(`${what}: owners and admins can do this; your role cannot.`);
}

/** The Sovereign state in the document (created empty: its hosts and log come from the real tables). */
function sovOf(d: Doc): Sov {
  if (!d.sovereign || d.sovereign.v !== 1) d.sovereign = { v: 1, internalHosts: [], egress: [], statements: [], rollbacks: [] };
  const s = d.sovereign as Sov;
  s.internalHosts ??= [];
  s.egress ??= [];
  s.statements ??= [];
  s.rollbacks ??= [];
  return s;
}

/* ── The internal allow-list and the egress log ─────────────────────────── */

const PRIVATE_IP = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function hostOf(urlOrHost: string) {
  const t = urlOrHost.trim();
  try {
    return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase();
  } catch {
    return t.toLowerCase();
  }
}

/** Inside the organisation's own network, as the console's allow-list screen takes it (the gate checks again). */
function internalName(d: Doc, h: string) {
  const own = String(d.org?.domain ?? "").toLowerCase();
  const zone = d.org?.id === "org_deccan" ? "deccanbank.internal" : `${String(d.org?.slug || d.org?.id).replace(/[^a-z0-9-]/gi, "").toLowerCase()}.internal`;
  return h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".lan") || (!!own && (h === own || h.endsWith(`.${own}`))) || PRIVATE_IP.test(h) || h.endsWith(zone);
}

/** The allow-list from EgressRule: one entry per host (the console allows by host), oldest first. */
async function syncHosts(ctx: Ctx): Promise<InternalHost[]> {
  const d = docOf(ctx);
  const rules = await forOrg(ctx.orgId).egressRule.findMany({ orderBy: { createdAt: "asc" } });
  const receipts = d.receipts as DocReceipt[];
  const hosts = new Map<string, InternalHost>();
  for (const r of rules) {
    if (hosts.has(r.host)) continue;
    const seq = receipts.findLast((x) => x.action === "egress.internal_host_added" && x.details?.rule_id === r.id)?.seq;
    const purpose = r.note ?? (r.purpose ? `${r.purpose} only` : "");
    hosts.set(r.host, { host: r.host, purpose, addedAt: r.createdAt.toISOString(), addedBy: r.createdBy, ...(seq !== undefined ? { seq } : {}) });
  }
  const list = [...hosts.values()];
  sovOf(d).internalHosts = list;
  return list;
}

/** Which part of the deployment tried to connect, by the egress purpose. */
const COMPONENT: Record<string, string> = {
  webhook: "Webhook dispatcher",
  "upstream-mcp": "MCP upstream server",
  "chat-slack": "Approvals delivery (Slack)",
  "chat-whatsapp": "Approvals delivery (WhatsApp)",
  connector: "Connector",
  oidc: "Single sign-on",
  smtp: "Mail relay",
  tsa: "Anchoring worker",
};

/** The blocked connection attempts of the last 30 days (the console's longest window), newest first. */
async function syncEgress(ctx: Ctx): Promise<EgressAttempt[]> {
  const rows = await forOrg(ctx.orgId).egressLog.findMany({ where: { decision: "blocked", at: { gte: new Date(Date.now() - 30 * D) } }, orderBy: [{ at: "desc" }, { id: "asc" }], take: 1000 });
  const log = rows.map(
    (e): EgressAttempt => ({
      id: e.id,
      at: e.at.toISOString(),
      destination: `${e.host}:${e.port}`,
      component: COMPONENT[e.purpose] ?? e.purpose,
      source: e.actor ? "console" : "Elan1 Govern",
      ...(e.reason ? { note: e.reason } : {}),
      ...(e.actor ? { by: e.actor } : {}),
      ...(e.receiptSeq !== null ? { seq: e.receiptSeq } : {}),
    }),
  );
  sovOf(docOf(ctx)).egress = log;
  return log;
}

const days = (v: unknown, fallback = 7) => Math.min(30, Math.max(1, Math.floor(Number(v)) || fallback));
const within = (log: EgressAttempt[], ms: number) => log.filter((e) => Date.parse(e.at) >= Date.now() - ms);

override("sovereign.egress", async (ctx) => {
  requireSov(ctx, "The egress log");
  const hosts = await syncHosts(ctx);
  const log = await syncEgress(ctx);
  return { log: clone(within(log, days(ctx.args[1]) * D)), hosts: clone(hosts), blocked24h: within(log, 24 * H).length };
});

override("sovereign.addHost", async (ctx) => {
  const [, host, purpose] = ctx.args as [string, unknown, unknown];
  requireSov(ctx, "The internal allow-list");
  await requireOwnerAdmin(ctx, "Changing the internal allow-list");
  const d = docOf(ctx);
  const h = hostOf(String(host ?? ""));
  if (!HOST_NAME.test(h) && !PRIVATE_IP.test(h)) throw new Error("Enter a host name such as siem.bank.internal, or a private address.");
  if (!internalName(d, h)) throw new Error(`${h} is not inside your network. The allow-list takes internal names (.internal, .local, your own domain) and private addresses only; the internet stays denied.`);
  const what = String(purpose ?? "").trim();
  if (what.length < 6) throw new Error("Say what the host is for, in a few words.");
  if ((await syncHosts(ctx)).some((x) => x.host === h)) throw new Error(`${h} is already on the allow-list.`);
  const r = await wire<{ seq: number; host: string }>(ctx, "egress/hosts", { actor: ctx.actorUserId, host: h, note: what.slice(0, 200) });
  await syncHosts(ctx);
  touch(ctx, "deployment");
  return { seq: r.seq, host: r.host };
});

override("sovereign.removeHost", async (ctx) => {
  const [, host] = ctx.args as [string, unknown];
  requireSov(ctx, "The internal allow-list");
  await requireOwnerAdmin(ctx, "Changing the internal allow-list");
  const h = String(host ?? "").trim().toLowerCase();
  if (!(await syncHosts(ctx)).some((x) => x.host === h)) throw new Error("That host is not on the allow-list.");
  // an endpoint still delivering there would start failing at once: the real webhooks, as the gate holds them
  const using = (await forOrg(ctx.orgId).webhook.findMany({ where: { active: true }, select: { url: true }, orderBy: { createdAt: "asc" } })).filter((w) => hostOf(w.url) === h);
  if (using.length) throw new Error(`An active webhook endpoint (${using[0]!.url}) delivers to ${h}. Disable or delete it in Assurance › Exports › Webhooks first.`);
  const r = await wire<{ seq: number }>(ctx, "egress/hosts/remove", { actor: ctx.actorUserId, host: h });
  await syncHosts(ctx);
  touch(ctx, "deployment");
  return { seq: r.seq };
});

override("sovereign.exportEgress", async (ctx) => {
  requireSov(ctx, "The egress log");
  const role = await realRole(ctx.orgId, ctx.actorUserId);
  if (!role || role === "approver") throw new Error("Owners, admins, viewers and auditors export the egress log.");
  const n = days(ctx.args[1]);
  const rows = within(await syncEgress(ctx), n * D);
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["time_utc,destination,component,source,verdict,note,receipt", ...rows.map((e) => [e.at, e.destination, e.component, e.source, "blocked", e.note ?? "", e.seq ?? ""].map(esc).join(","))].join("\n");
  const digest = createHash("sha256").update(csv).digest("hex").slice(0, 16);
  const r = await wire<{ seq: number }>(ctx, "egress/export", { actor: ctx.actorUserId, days: n, attempts: rows.length, digest });
  touch(ctx, "deployment");
  return { csv, seq: r.seq, count: rows.length };
});

// the console's local status page: its own (synthetic) components, with the egress firewall's real figures
override("sovereign.localStatus", async (ctx) => {
  if (!isSov(docOf(ctx))) return ctx.original(...ctx.args);
  const hosts = await syncHosts(ctx);
  const blocked = within(await syncEgress(ctx), 24 * H).length;
  const out = (await ctx.original(...ctx.args)) as { components: { id: string; detail: string; facts?: { label: string; value: string }[] }[] };
  const c = out.components.find((x) => x.id === "l_egress");
  if (c) {
    c.detail = `${blocked} connection attempts blocked in the last 24 hours; nothing left the network.`;
    c.facts = [{ label: "Allow-list", value: `${hosts.length} internal hosts` }];
  }
  return out;
});

/* ── Signed update bundles ─────────────────────────────────────────────── */

async function updatesState(ctx: Ctx): Promise<UpdatesState> {
  let r: { status: number; data: UpdatesState & { error?: string } };
  try {
    r = await gate<UpdatesState & { error?: string }>("POST", `/internal/orgs/${encodeURIComponent(ctx.orgId)}/wiring/updates/state`, {});
  } catch {
    throw new Error("Elan1 Govern is not reachable, so the update bundles cannot be read. Try again in a moment.");
  }
  if (r.status !== 200) throw new Error(r.data.error ?? "Elan1 Govern could not read the update bundles.");
  return r.data;
}

const CONSOLE_STATUS: Record<UpdateRecordJson["status"], string> = { verified: "available", staged: "staged", active: "applied", inactive: "applied", rolled_back: "staged" };

/** An update record as the console's Deployment screen shows a bundle; seqs from this organisation's chain. */
function bundleOf(r: UpdateRecordJson, receipts: DocReceipt[]): Bundle {
  const about = (action: string, key = "version") => receipts.filter((x) => x.action === action && x.details?.[key] === r.version);
  const notes = Array.isArray(r.manifest.notes) ? r.manifest.notes : r.manifest.notes ? [r.manifest.notes] : [];
  const status = CONSOLE_STATUS[r.status];
  const step = { verified: "update.imported", staged: "update.staged", rolled_back: "update.rolled_back", active: "update.applied", inactive: "update.applied" }[r.status];
  // returned to service by a rollback (its apply was overwritten then): the rollback names it, and its first apply is kept
  const lastApplied = about("update.applied").at(-1);
  const restored = r.status === "active" ? about("update.rolled_back", "to_version").at(-1) : undefined;
  const byRollback = restored && (!lastApplied || restored.seq > lastApplied.seq) ? restored : undefined;
  const first = about("update.applied")[0];
  const seq = byRollback?.seq ?? (r.status === "rolled_back" ? about("update.staged").at(-1)?.seq : about(step).at(-1)?.seq);
  const rolledBack = about("update.rolled_back").at(-1);
  return {
    id: r.id,
    version: r.version,
    publishedAt: r.manifest.createdAt ?? r.importedAt,
    sizeMb: 0,
    digest: r.manifestSha256,
    kid: r.kid,
    fingerprint: r.kid,
    sig: r.manifest.signature ?? "",
    transport: "air-gapped media",
    status,
    ...(status !== "available" ? { verified: true } : {}),
    ...(r.stagedAt ? { stagedAt: r.stagedAt, stagedBy: r.stagedBy ?? undefined } : {}),
    ...(r.appliedAt && status === "applied" ? { appliedAt: r.appliedAt, appliedBy: r.appliedBy ?? undefined } : {}),
    ...(seq !== undefined ? { seq } : {}),
    notes: notes.length ? notes : ["Imported from removable media"],
    ...(r.rolledBackAt ? { rolledBackAt: r.rolledBackAt, rolledBackBy: r.rolledBackBy ?? undefined, rollbackReason: r.rollbackReason ?? undefined, ...(rolledBack ? { rollbackSeq: rolledBack.seq } : {}) } : {}),
    ...(byRollback ? { restoredFrom: String(byRollback.details?.version ?? ""), ...(first ? { firstAppliedAt: first.ts, firstAppliedBy: first.actor, firstAppliedSeq: first.seq } : {}) } : {}),
  };
}

/** Each update.rolled_back on this organisation's chain, newest first. */
function rollbacksOf(records: UpdateRecordJson[], receipts: DocReceipt[]): RollbackEntry[] {
  const idOf = new Map(records.map((r) => [r.version, r.id]));
  return receipts
    .filter((x) => x.action === "update.rolled_back")
    .map((x) => ({
      id: `rb_${x.seq}`,
      updateId: idOf.get(String(x.details?.version ?? "")) ?? "",
      fromVersion: String(x.details?.version ?? ""),
      toVersion: String(x.details?.to_version ?? ""),
      at: x.ts,
      by: x.actor ?? "",
      reason: String(x.details?.reason ?? ""),
      seq: x.seq,
    }))
    .reverse();
}

/** Bring the document's bundles and rollbacks in line with the real records. Sovereign organisations only. */
async function syncUpdates(ctx: Ctx): Promise<{ state: UpdatesState; bundles: Bundle[] }> {
  const d = docOf(ctx);
  const state = await updatesState(ctx);
  const receipts = d.receipts as DocReceipt[];
  const bundles = state.records.map((r) => bundleOf(r, receipts));
  d.platform.updates = bundles;
  sovOf(d).rollbacks = rollbacksOf(state.records, receipts);
  return { state, bundles };
}

async function bundleFor(ctx: Ctx, id: unknown): Promise<{ record: UpdateRecordJson; bundle: Bundle }> {
  const { state, bundles } = await syncUpdates(ctx);
  const i = state.records.findIndex((r) => r.id === id);
  if (i < 0) throw new Error("No such update bundle.");
  return { record: state.records[i]!, bundle: bundles[i]! };
}

/** The bundle as it now stands, after a real step (the document holds the step's receipt). */
async function after(ctx: Ctx, id: string): Promise<Bundle> {
  const { bundles } = await syncUpdates(ctx);
  touch(ctx, "deployment");
  return clone(bundles.find((b) => b.id === id)!);
}

async function requireUpdateRole(ctx: Ctx) {
  const role = await realRole(ctx.orgId, ctx.actorUserId);
  if (role !== "owner" && role !== "admin") throw new Error("Owners and Admins can do this; your role cannot.");
}

/** The manifest's version pattern (apps/gate/src/updates.ts UPDATE_VERSION): the folder a bundle is imported from. */
const UPDATE_VERSION = /^\d{4}\.\d{1,3}\.\d{1,4}(?:[-.][a-z0-9]{1,20})?$/;

override("api.deployment", async (ctx) => {
  const d = docOf(ctx);
  if (!isSov(d)) return ctx.original(...ctx.args);
  const { state } = await syncUpdates(ctx);
  await syncHosts(ctx);
  const blocked = within(await syncEgress(ctx), 24 * H).length;
  // the console's own description of the cluster and its services, with the real bundles, release key and egress
  const view = (await ctx.original(...ctx.args)) as Record<string, unknown> & { egress: Record<string, unknown> };
  view.updates = clone(d.platform.updates);
  view.release = state.release ?? { kid: "none", fingerprint: "no release key is configured (UPDATE_SIGNING_PUBLIC_KEYS)", publicKey: "" };
  const allow = parseAllowList(env().EGRESS_ALLOW).entries.map((e) => `${e.wildcard ? "*." : ""}${e.host}${e.port !== null ? `:${e.port}` : ""}`);
  view.egress = { ...view.egress, allowList: allow, blockedLast24h: blocked };
  return view;
});

override("deployment.importBundle", async (ctx) => {
  const [, m] = ctx.args as [string, { version?: unknown } | undefined];
  if (!isSov(docOf(ctx))) throw new Error("elan1 applies updates to hosted organisations; bundles are imported on Sovereign deployments.");
  const role = await realRole(ctx.orgId, ctx.actorUserId);
  if (role !== "owner" && role !== "admin") throw new Error("Owners and admins import update bundles; your role cannot.");
  const version = String(m?.version ?? "");
  if (!UPDATE_VERSION.test(version)) throw new Error("No version like 2026.10.4 in the manifest.");
  // the real bundle (its signed manifest and every artifact) is read from the deployment's update folder and checked there
  const r = await wire<{ record: UpdateRecordJson; seq: number | null }>(ctx, "updates/import", { actor: ctx.actorUserId, version });
  const bundle = await after(ctx, r.record.id);
  return { bundle, ...(r.seq !== null ? { seq: r.seq } : {}) };
});

override("api.stageUpdate", async (ctx) => {
  if (!isSov(docOf(ctx))) throw new Error("elan1 applies updates to hosted organisations. Staging is for Sovereign deployments.");
  await requireUpdateRole(ctx);
  const { record, bundle } = await bundleFor(ctx, ctx.args[1]);
  if (bundle.status !== "available") throw new Error(`This bundle is ${bundle.status}.`);
  await wire(ctx, "updates/stage", { actor: ctx.actorUserId, version: record.version });
  return after(ctx, record.id);
});

override("api.applyUpdate", async (ctx) => {
  if (!isSov(docOf(ctx))) throw new Error("elan1 applies updates to hosted organisations.");
  await requireUpdateRole(ctx);
  const { record, bundle } = await bundleFor(ctx, ctx.args[1]);
  if (bundle.status !== "staged") throw new Error("Stage and verify the bundle first.");
  await wire(ctx, "updates/apply", { actor: ctx.actorUserId, version: record.version });
  return after(ctx, record.id);
});

override("sovereign.rollback", async (ctx) => {
  const [, id, reason] = ctx.args as [string, unknown, unknown];
  requireSov(ctx, "Rolling back an update");
  await requireOwnerAdmin(ctx, "Rolling back an update");
  const { record } = await bundleFor(ctx, id);
  if (record.status !== "active") throw new Error("Only the bundle running now can be rolled back.");
  const why = String(reason ?? "").trim();
  if (why.length < 10) throw new Error("Give the reason for the rollback (at least 10 characters).");
  const r = await wire<{ seq: number | null; from: string; to: string }>(ctx, "updates/rollback", { actor: ctx.actorUserId, version: record.version, reason: why });
  await syncUpdates(ctx);
  touch(ctx, "deployment");
  return { ...(r.seq !== null ? { seq: r.seq } : {}), from: r.from, to: r.to };
});

override("sovereign.rollbacks", async (ctx) => {
  if (!isSov(docOf(ctx))) return [];
  await syncUpdates(ctx);
  return clone(sovOf(docOf(ctx)).rollbacks);
});
