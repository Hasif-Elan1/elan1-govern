import {
  consoleGroupSlugs,
  consoleRulesToRulebook,
  createRegistry,
  isValidToolName,
  RISK_TAGS,
  rulebookToYaml,
  specFromJsonSchema,
  type GuardSyncChanges,
  type GuardSyncPayload,
  type RiskTag,
  type ToolRegistry,
} from "@gate/core";
import { forOrg, Prisma } from "@gate/db";
import { adminEvent, publishRulebook } from "./admin";
import { expireApproval, resolveApproval } from "./approvals";
import type { DecisionChannel } from "./chat/common";
import { chain } from "./chain";
import { boundedExpiry } from "./console-approvals";
import { raiseAlert, type Deps } from "./deps";
import { invalidateRegistry } from "./registry";

// The approved console's governance configuration, applied to the guard (POST /internal/orgs/:org/console-sync,
// sent by apps/web/src/server/console-sync.ts after every console operation that changes it). The console
// document is the source; the gate's rows carry the console's ids, so applying the same message twice changes
// nothing. In order:
//  1. tools and risk tags: each console connector's tools, as MCP servers named by the tool prefix (demo
//     connectors are answered by the guard; console-approvals.ts);
//  2. agents: name, owner, risk tier, and paused or active (a pause, the emergency stop's included, always applies;
//     an agent the guard paused itself, such as an auto-pause, is resumed only when the console resumes it);
//  3. approver groups: who is in each now, for routing held calls;
//  4. keys: a key issued in the console becomes a real key from the hash of its secret; revoked and expiring keys
//     follow the console;
//  5. the emergency stop, as an incident;
//  6. rulebooks: the version in force, translated (packages/core/src/console-rules.ts) and signed with the
//     console's version number;
//  7. approvals the guard holds: who may decide them and until when, and the console's decision (resolveApproval).
// Every change writes a receipt, in the gate's usual words.

export interface GuardSyncResult {
  /** Per console rulebook: the signed version in force, none, or why it could not be applied. */
  rulebooks: Record<string, { ok: true; version: number | null; hash?: string } | { ok: false; errors: string[] }>;
  /** Per held approval the console decided or re-routed: applied, or why not. */
  approvals: Record<string, { ok: true; status: string } | { ok: false; code: string; error: string }>;
  /** Console keys made real in this message, and those that have no secret here (the seed's, for example). */
  keys: { created: string[]; unbacked: string[] };
  /** What was left as it was, and why. */
  problems: string[];
}

const APPROVER_ROLES = new Set(["owner", "admin", "approver"]);
const isTag = (t: string): t is RiskTag => (RISK_TAGS as readonly string[]).includes(t);
const NO_CHANGES: GuardSyncChanges = { rulebooks: [], keys: [], agents: [], approvals: [], stop: false };

interface Person {
  email: string;
  role: string;
  active: boolean;
}

type Db = ReturnType<typeof forOrg>;
type AgentRow = Awaited<ReturnType<Db["agent"]["findFirstOrThrow"]>>;

interface Ctx {
  deps: Deps;
  orgId: string;
  db: Db;
  p: GuardSyncPayload;
  changes: GuardSyncChanges;
  people: Map<string, Person>;
  /** The email receipts name for a console user id (or the org's own owner when the console's actor is not a member). */
  who(userId: string | undefined): string;
  out: GuardSyncResult;
}

export async function applyGuardSync(deps: Deps, orgId: string, p: GuardSyncPayload): Promise<GuardSyncResult> {
  const db = forOrg(orgId, deps.db);
  const members = await db.membership.findMany({ include: { user: { select: { email: true } } } });
  const people = new Map(members.map((m) => [m.userId, { email: m.user.email.toLowerCase(), role: m.role, active: m.status === "active" }]));
  const owner = members.find((m) => m.role === "owner" && m.status === "active")?.user.email.toLowerCase() ?? "console";
  const ctx: Ctx = {
    deps,
    orgId,
    db,
    p,
    changes: p.changes ?? NO_CHANGES,
    people,
    who: (id) => (id && people.get(id)?.email) || (p.actor && people.get(p.actor)?.email) || owner,
    out: { rulebooks: {}, approvals: {}, keys: { created: [], unbacked: [] }, problems: [] },
  };
  await syncTools(ctx);
  const { agents, stopPaused } = await syncAgents(ctx);
  await syncGroups(ctx);
  await syncKeys(ctx, agents);
  await syncStop(ctx, stopPaused);
  await syncRulebooks(ctx, agents);
  await syncApprovals(ctx);
  return ctx.out;
}

// ---- 1. Tools ----

async function syncTools(c: Ctx) {
  const { db, orgId, deps } = c;
  const bySlug = new Map<string, GuardSyncPayload["tools"]>();
  for (const t of c.p.tools) {
    if (!isValidToolName(t.name)) {
      c.out.problems.push(`${t.name} is not a tool name the guard accepts, so it was left out.`);
      continue;
    }
    const slug = t.name.slice(0, t.name.indexOf("."));
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), t]);
  }
  const servers = await db.upstreamServer.findMany({ include: { tools: true } });
  let changed = false;
  for (const [slug, tools] of bySlug) {
    const first = tools[0]!;
    const consoleId = `${first.connectorId}/${slug}`;
    const url = first.demo || !/^https?:\/\/[^\s]+$/i.test(first.connectorUrl ?? "") || !URL.canParse(first.connectorUrl!) ? `console://${first.connectorId}` : first.connectorUrl!;
    let row = servers.find((s) => s.slug === slug);
    if (row && !row.consoleId) {
      c.out.problems.push(`An MCP server called "${slug}" was connected outside the console; its tools were left as they are.`);
      continue;
    }
    let added = 0;
    let updated = 0;
    if (!row) {
      row = { ...(await db.upstreamServer.create({ data: { orgId, slug, name: first.connectorName, url, status: "ok", consoleId, lastSyncedAt: new Date() } })), tools: [] };
      await adminEvent(deps, orgId, c.who(c.p.actor), "upstream.added", { server: slug, name: first.connectorName, origin: url.startsWith("console://") ? "demo" : new URL(url).origin, via: "console" });
      changed = true;
    } else if (row.name !== first.connectorName || row.url !== url || row.consoleId !== consoleId) {
      await db.upstreamServer.update({ where: { id: row.id }, data: { name: first.connectorName, url, consoleId } });
      changed = true;
    }
    for (const t of tools) {
      const old = row.tools.find((x) => x.name === t.name);
      // fields are only ever added: a signed rulebook that names one must keep loading
      const props = { ...((old?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}), ...Object.fromEntries(t.fields.map((f) => [f, {}])) };
      const data = { description: t.description.slice(0, 1000), inputSchema: { type: "object", properties: props } as object, tags: [...new Set(t.tags.filter(isTag))], enabled: t.enabled };
      if (!old) {
        await db.upstreamTool.create({ data: { orgId, serverId: row.id, name: t.name, ...data } });
        added++;
      } else if (JSON.stringify({ d: old.description, s: old.inputSchema, t: old.tags, e: old.enabled }) !== JSON.stringify({ d: data.description, s: data.inputSchema, t: data.tags, e: data.enabled })) {
        await db.upstreamTool.update({ where: { id: old.id }, data });
        updated++;
      }
    }
    const gone = row.tools.filter((x) => !tools.some((t) => t.name === x.name)).map((x) => x.name);
    if (gone.length) await db.upstreamTool.deleteMany({ where: { serverId: row.id, name: { in: gone } } });
    if (added || updated || gone.length) {
      changed = true;
      await adminEvent(deps, orgId, c.who(c.p.actor), "upstream.synced", { server: slug, ok: true, tools: tools.length, added, updated, removed: gone.length, via: "console" });
    }
  }
  for (const s of servers.filter((x) => x.consoleId && !bySlug.has(x.slug))) {
    await db.upstreamTool.deleteMany({ where: { serverId: s.id } });
    await db.upstreamServer.deleteMany({ where: { id: s.id } });
    await adminEvent(deps, orgId, c.who(c.p.actor), "upstream.removed", { server: s.slug, via: "console" });
    changed = true;
  }
  if (changed) invalidateRegistry(orgId);
}

// ---- 2. Agents ----

async function syncAgents(c: Ctx): Promise<{ agents: Map<string, AgentRow>; stopPaused: string[] }> {
  const { db, orgId, deps } = c;
  const rows = await db.agent.findMany();
  const agents = new Map<string, AgentRow>();
  const stopPaused: string[] = [];
  const orgOwner = c.who(undefined);
  for (const a of c.p.agents) {
    const ownerEmail = c.people.get(a.ownerId)?.email ?? orgOwner;
    const status = a.active ? ("active" as const) : ("paused" as const);
    let row = rows.find((r) => r.consoleId === a.id);
    if (!row) {
      if (rows.some((r) => r.slug === a.slug)) {
        c.out.problems.push(`An agent called "${a.slug}" was added outside the console, so the console's ${a.slug} was not applied.`);
        continue;
      }
      row = await db.agent.create({
        data: { orgId, slug: a.slug, name: a.name.slice(0, 80) || a.slug, purpose: (a.description || a.name).slice(0, 500), ownerEmail, createdById: c.people.has(a.ownerId) ? a.ownerId : null, riskTier: a.riskLevel, status, consoleId: a.id },
      });
      await adminEvent(deps, orgId, c.who(c.p.actor), "agent.created", { name: row.name, risk_tier: row.riskTier, owner: ownerEmail, status, via: "console" }, { agent: row.slug });
      agents.set(a.id, row);
      continue;
    }
    const patch: Partial<Pick<AgentRow, "slug" | "name" | "purpose" | "ownerEmail" | "riskTier">> = {};
    if (row.slug !== a.slug && !rows.some((r) => r.slug === a.slug)) patch.slug = a.slug;
    if (row.name !== (a.name.slice(0, 80) || a.slug)) patch.name = a.name.slice(0, 80) || a.slug;
    if (row.purpose !== (a.description || a.name).slice(0, 500)) patch.purpose = (a.description || a.name).slice(0, 500);
    if (row.ownerEmail !== ownerEmail) patch.ownerEmail = ownerEmail;
    if (row.riskTier !== a.riskLevel) patch.riskTier = a.riskLevel;
    if (Object.keys(patch).length) {
      row = await db.agent.update({ where: { id: row.id }, data: patch });
      await adminEvent(deps, orgId, c.who(c.p.actor), "agent.updated", { fields: Object.keys(patch).join(","), via: "console" }, { agent: row.slug });
    }
    // a pause always applies; a resume only when the console resumed it in this operation (the guard may have
    // paused it itself, as an auto-pause does)
    const resume = row.status === "paused" && status === "active" && c.changes.agents.includes(a.id);
    if ((row.status === "active" && status === "paused") || resume) {
      row = await db.agent.update({ where: { id: row.id }, data: { status } });
      if (status === "paused" && a.stopped) stopPaused.push(row.id);
      await adminEvent(deps, orgId, c.who(c.p.actor), status === "paused" ? "agent.paused" : "agent.resumed", { reason: a.stopped ? "emergency-stop" : "console", via: "console" }, { agent: row.slug });
    }
    agents.set(a.id, row);
  }
  // an agent deleted in the console stops at once and its keys stop working; its row and receipts stay
  for (const r of rows.filter((x) => x.consoleId && !c.p.agents.some((a) => a.id === x.consoleId))) {
    const revoked = await db.apiKey.updateMany({ where: { agentId: r.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.status === "active" || revoked.count) {
      await db.agent.update({ where: { id: r.id }, data: { status: "paused" } });
      await adminEvent(deps, orgId, c.who(c.p.actor), "agent.paused", { reason: "removed in the console", keys_revoked: revoked.count, via: "console" }, { agent: r.slug });
    }
  }
  return { agents, stopPaused };
}

// ---- 3. Approver groups ----

async function syncGroups(c: Ctx) {
  const { db, orgId } = c;
  const slugs = consoleGroupSlugs(c.p.groups.map((g) => g.id));
  const existing = await db.consoleApproverGroup.findMany();
  for (const g of c.p.groups) {
    const emails = [...new Set(g.members.map((id) => c.people.get(id)).filter((m): m is Person => !!m && m.active && APPROVER_ROLES.has(m.role)).map((m) => m.email))];
    const data = { slug: slugs.get(g.id)!, name: g.name, memberIds: [...g.members], emails };
    const old = existing.find((x) => x.consoleId === g.id);
    if (!old) {
      // a slug another (since renamed) group held is freed first
      await db.consoleApproverGroup.deleteMany({ where: { slug: data.slug } });
      await db.consoleApproverGroup.create({ data: { orgId, consoleId: g.id, ...data } });
    } else if (JSON.stringify([old.slug, old.name, old.memberIds, old.emails]) !== JSON.stringify([data.slug, data.name, data.memberIds, data.emails])) {
      await db.consoleApproverGroup.update({ where: { id: old.id }, data });
    }
  }
  const gone = existing.filter((x) => !c.p.groups.some((g) => g.id === x.consoleId)).map((x) => x.id);
  if (gone.length) await db.consoleApproverGroup.deleteMany({ where: { id: { in: gone } } });
}

/** Emails of the active members who can decide, for console user ids. */
function deciders(c: Ctx, ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => c.people.get(id)).filter((m): m is Person => !!m && m.active && APPROVER_ROLES.has(m.role)).map((m) => m.email))];
}

// ---- 4. Keys ----

async function syncKeys(c: Ctx, agents: Map<string, AgentRow>) {
  const { db, orgId, deps } = c;
  const rows = await db.apiKey.findMany({ where: { consoleId: { not: null } } });
  const now = new Date();
  for (const k of c.p.keys) {
    const agent = agents.get(k.agentId);
    if (!agent) continue;
    const row = rows.find((r) => r.consoleId === k.id);
    const expiresAt = k.expiresAt ? new Date(k.expiresAt) : null;
    if (!row) {
      if (!k.keyHash) {
        c.out.keys.unbacked.push(k.id);
        continue;
      }
      try {
        await db.apiKey.create({ data: { orgId, agentId: agent.id, label: (k.label || "Console key").slice(0, 120), prefix: k.prefix, keyHash: k.keyHash, environment: k.environment, expiresAt, consoleId: k.id, revokedAt: k.revoked ? now : null } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          c.out.problems.push(`The key ${k.prefix}… could not be registered: that secret is already in use.`);
          continue;
        }
        throw e;
      }
      await adminEvent(deps, orgId, c.who(c.p.actor), "key.created", { prefix: k.prefix, environment: k.environment, ...(expiresAt ? { expires: expiresAt.toISOString().slice(0, 10) } : {}), via: "console" }, { agent: agent.slug });
      c.out.keys.created.push(k.id);
      continue;
    }
    // a revoked key is never brought back
    if (k.revoked && !row.revokedAt) {
      await db.apiKey.update({ where: { id: row.id }, data: { revokedAt: now } });
      await adminEvent(deps, orgId, c.who(c.p.actor), "key.revoked", { key_id: row.id, prefix: row.prefix, via: "console" }, { agent: agent.slug });
    } else if ((expiresAt?.getTime() ?? null) !== (row.expiresAt?.getTime() ?? null) && !row.revokedAt) {
      await db.apiKey.update({ where: { id: row.id }, data: { expiresAt } });
      await adminEvent(deps, orgId, c.who(c.p.actor), "key.updated", { prefix: row.prefix, expires: expiresAt ? expiresAt.toISOString() : "never", via: "console" }, { agent: agent.slug });
    }
  }
  for (const r of rows.filter((x) => !x.revokedAt && !c.p.keys.some((k) => k.id === x.consoleId))) {
    await db.apiKey.update({ where: { id: r.id }, data: { revokedAt: now } });
    await adminEvent(deps, orgId, c.who(c.p.actor), "key.revoked", { key_id: r.id, prefix: r.prefix, reason: "removed in the console", via: "console" });
  }
}

// ---- 5. The emergency stop ----

async function syncStop(c: Ctx, stopPaused: string[]) {
  const { orgId, deps, p } = c;
  const open = await c.db.incident.findFirst({ where: { status: "open", kind: "emergency_stop" } });
  const actor = c.who(p.stop.by ?? p.actor);
  if (p.stop.active && !open) {
    await chain(deps, orgId, async (append, tx) => {
      const incident = await tx.incident.create({ data: { orgId, startedBy: actor, reason: p.stop.reason ?? null, pausedAgentIds: stopPaused } });
      const r = await append({ kind: "admin", actor, action: "emergency.stop", details: { count: stopPaused.length, incident_id: incident.id, scope: p.stop.agentSlugs ? "selected_agents" : "all_agents", ...(p.stop.reason ? { reason: p.stop.reason } : {}), via: "console" } });
      await tx.incident.update({ where: { id: incident.id }, data: { startSeq: r.seq } });
    });
  } else if (!p.stop.active && open && c.changes.stop) {
    // only the console lifting its stop closes one (agents resume through their own status above)
    await chain(deps, orgId, async (append, tx) => {
      const still = await tx.agent.count({ where: { id: { in: open.pausedAgentIds }, status: "active" } });
      const r = await append({ kind: "admin", actor, action: "emergency.resumed", details: { count: still, incident_id: open.id, via: "console" } });
      await tx.incident.update({ where: { id: open.id }, data: { status: "closed", endedBy: actor, endedAt: new Date(), endSeq: r.seq, resumedCount: still } });
    });
  } else if (p.stop.active && open && stopPaused.length) {
    await c.db.incident.update({ where: { id: open.id }, data: { pausedAgentIds: [...new Set([...open.pausedAgentIds, ...stopPaused])] } });
  }
}

// ---- 6. Rulebooks ----

/**
 * The tools a publish is checked against: this agent's console tools, switched off or not. (The built-in Gmail
 * and Zoho Books tools are not the console's; its agents cannot call them.)
 */
async function publishRegistry(c: Ctx, tools: Set<string>): Promise<ToolRegistry> {
  const rows = await c.db.upstreamTool.findMany({ where: { name: { in: [...tools] }, server: { consoleId: { not: null } } } });
  return createRegistry(rows.map((r) => specFromJsonSchema({ name: r.name, connector: r.name.slice(0, r.name.indexOf(".")), description: r.description, inputSchema: r.inputSchema as Record<string, unknown>, tags: r.tags.filter(isTag) })));
}

async function syncRulebooks(c: Ctx, agents: Map<string, AgentRow>) {
  const { db, orgId, deps, p } = c;
  for (const rb of p.rulebooks) {
    const agent = agents.get(rb.agentId);
    if (!agent) continue;
    const strict = c.changes.rulebooks.includes(rb.id);
    const active = agent.activeRulebookId ? await db.rulebook.findFirst({ where: { id: agent.activeRulebookId } }) : null;
    const setActive = async (id: string | null, action: string, version: number | null) => {
      await db.agent.update({ where: { id: agent.id }, data: { activeRulebookId: id } });
      agent.activeRulebookId = id;
      await adminEvent(deps, orgId, c.who(rb.signedBy ?? p.actor), action, { version: version ?? 0, via: "console" }, { agent: agent.slug });
    };
    if (rb.version === null) {
      if (active) await setActive(null, "rulebook.withdrawn", active.version);
      c.out.rulebooks[rb.id] = { ok: true, version: null };
      continue;
    }
    if (active?.consoleId === rb.id && active.version === rb.version && active.consoleHash === rb.hash) {
      c.out.rulebooks[rb.id] = { ok: true, version: active.version, hash: active.hash };
      continue;
    }
    const fail = async (errors: string[]) => {
      c.out.rulebooks[rb.id] = { ok: false, errors };
      // a version this operation published is refused, and the guard stays as it was; any other version the
      // guard cannot apply leaves the agent with no rulebook, so every call is refused until it is fixed
      if (!strict && active) {
        await setActive(null, "rulebook.withdrawn", active.version);
        await raiseAlert(deps, "console-rulebook-invalid", `Agent ${agent.slug}: version ${rb.version} of its console rulebook cannot be applied, so every call is refused. ${errors.join(" ")}`, orgId);
      }
    };
    const signed = await db.rulebook.findFirst({ where: { agentId: agent.id, version: rb.version } });
    if (signed) {
      if (signed.consoleId !== rb.id || signed.consoleHash !== rb.hash) {
        await fail([`Version ${rb.version} of this rulebook was already signed in Elan1 Govern with other rules.`]);
        continue;
      }
      // a version signed before (the console withdrew a later one and fell back to it): in force again
      await setActive(signed.id, "rulebook.activated", signed.version);
      c.out.rulebooks[rb.id] = { ok: true, version: signed.version, hash: signed.hash };
      continue;
    }
    const tools = new Set([...(p.agents.find((a) => a.id === rb.agentId)?.tools ?? []), ...rb.rules.map((r) => r.match?.tool).filter((t): t is string => !!t)]);
    const registry = await publishRegistry(c, tools);
    const groups = p.groups.map((g) => ({ id: g.id, name: g.name, emails: deciders(c, g.members) }));
    const t = consoleRulesToRulebook({ agent: agent.slug, owner: agent.ownerEmail, version: rb.version, rules: rb.rules, groups, lists: p.lists, registry });
    if (!t.ok) {
      await fail(t.errors);
      continue;
    }
    const published = await publishRulebook(deps, orgId, agent.id, rulebookToYaml(t.rulebook), c.who(rb.signedBy ?? p.actor), { version: rb.version, registry, console: { id: rb.id, hash: rb.hash ?? "" } });
    if (!published.ok) {
      await fail(published.errors);
      continue;
    }
    agent.activeRulebookId = (await db.agent.findFirstOrThrow({ where: { id: agent.id }, select: { activeRulebookId: true } })).activeRulebookId;
    c.out.rulebooks[rb.id] = { ok: true, version: published.version, hash: published.hash };
  }
}

// ---- 7. Held approvals ----

const CHANNELS: Record<string, DecisionChannel> = { web: "web", email: "email", phone_link: "web", slack: "slack", whatsapp: "whatsapp" };

async function syncApprovals(c: Ctx) {
  const { db, orgId, deps, p } = c;
  const groups = await db.consoleApproverGroup.findMany();
  for (const a of p.approvals) {
    const real = await db.approval.findFirst({ where: { id: a.id } });
    if (!real) {
      c.out.approvals[a.id] = { ok: false, code: "not_found", error: "The guard has no such approval." };
      continue;
    }
    // decided or expired in the guard already: the console is told by the gate (console-approvals.ts)
    if (real.status !== "pending") {
      if (a.status !== "pending" && a.status !== real.status) c.out.approvals[a.id] = { ok: false, code: "not_pending", error: `The guard already has this approval as ${real.status}.` };
      continue;
    }
    // who may decide it now and until when: the console's groups (re-routes and escalations included)
    const decider = a.decidedBy ? c.people.get(a.decidedBy) : undefined;
    const approvers = deciders(c, a.allowed);
    // an owner deciding outside the group is the console's override; the guard checks the role itself
    if (a.override && decider?.active && decider.role === "owner" && !approvers.includes(decider.email)) approvers.push(decider.email);
    const k = a.approverGroup.trim().toLowerCase();
    const group = groups.find((g) => g.consoleId === a.approverGroup || g.name.toLowerCase() === k || g.consoleId.toLowerCase() === k);
    const expiresAt = Number.isFinite(Date.parse(a.expiresAt)) ? boundedExpiry(new Date(a.expiresAt)) : real.expiresAt;
    const routing = { approvers, approverGroup: group?.slug ?? real.approverGroup, expiresAt };
    if (JSON.stringify([real.approvers, real.approverGroup, real.expiresAt.getTime()]) !== JSON.stringify([routing.approvers, routing.approverGroup, routing.expiresAt.getTime()])) {
      await db.approval.update({ where: { id: real.id }, data: routing });
      await adminEvent(deps, orgId, c.who(p.actor), "approval.updated", { approval: real.id, approver_group: routing.approverGroup, approvers: approvers.length, expires_at: expiresAt.toISOString(), via: "console" });
    }
    if (a.status === "approved" || a.status === "rejected") {
      if (!a.decidedBy || !decider) {
        c.out.approvals[a.id] = { ok: false, code: "not_approver", error: "The person who decided is not a member of this organisation in Elan1 Govern." };
        continue;
      }
      const r = await resolveApproval(deps, orgId, a.id, { userId: a.decidedBy, email: decider.email, result: a.status, ...(a.decisionReason ? { note: a.decisionReason.slice(0, 1000) } : {}), channel: CHANNELS[a.channel ?? "web"] ?? "web" });
      c.out.approvals[a.id] = r.ok ? { ok: true, status: r.status } : { ok: false, code: r.code, error: r.message };
    } else if (a.status === "expired") {
      const expired = await expireApproval(deps, orgId, a.id);
      c.out.approvals[a.id] = expired ? { ok: true, status: "expired" } : { ok: false, code: "not_due", error: "The guard's approval has not expired yet." };
    } else c.out.approvals[a.id] = { ok: true, status: "pending" };
  }
}
