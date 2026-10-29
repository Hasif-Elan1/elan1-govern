/**
 * Agents — backend extension.
 *
 * `src/api` is the data path for every screen. Where it has no call for something the agents screens need
 * (edit an agent, retire or delete it, keys with an expiry, key rotation with a grace period, a governed
 * test call, the add-agent wizard with dual control and a declaration, the tenant's own endpoints), the
 * functions below supply it over the same in-browser store the API uses. Every change writes a signed admin
 * receipt to the organisation's chain and is kept on the organisation's record, so it is shared by everyone
 * in the organisation and survives a reload. A real backend replaces these bodies without touching a screen.
 */
import { api, db } from '@/api';
import type { OrgDB } from '@/mock/db';
import type { Call } from '@/mock/scenarios';
import type { Agent, AgentKey, Receipt, RiskLevel, RiskTag, Rule } from '@/types';
import { rulebookYaml } from '@/mock/catalog';
import { approverGroupsFor, userById, userName } from '@/mock/users';
import { sha256Hex } from '@/lib/crypto';
import { evaluate } from '@/lib/evaluate';
import { atLeast } from '@/lib/levels';
import { autoPauseFor, setAutoPause as setAutoPauseWork } from '@/features/work/backend';
import { startAutonomy } from '@/mock/platform';
import { assertPilotWritable } from '@/mock/billing';
import { devpathState } from '@/mock/devpath';

const H = 3_600_000;
const D = 24 * H;
const wait = (min = 120, max = 320) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const iso = (t = Date.now()) => new Date(t).toISOString();
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');

/* ── Types kept on the agent record ───────────────────────── */

export interface Declaration {
  id: string; // decl.<slug>
  version: number;
  actorKind: 'agent' | 'agent_on_behalf_of_person' | 'service';
  lexicon: string; // e.g. 'elan1.lexicon.v1'
  lexiconHash: string;
  writeTypes: string[];
  recordedAt: string;
  seq?: number;
}

export type ExtKey = AgentKey & { revokeAt?: string; rotatedTo?: string; rotatedFrom?: string; revokedAt?: string; revokedBy?: string };

export type AgentExt = Omit<Agent, 'keys'> & {
  retiredAt?: string;
  retiredBy?: string;
  retireReason?: string;
  retireSeq?: number;
  businessUnit?: string;
  declaration?: Declaration;
  keys: ExtKey[];
};

type DBAgent = Omit<OrgDB['agents'][number], 'keys'> & AgentExt;

/** The caller must hold one of `roles` as an active member of the organisation (its member record decides). */
function requireRole(orgId: string, userId: string, roles: string[], what: string, write = true) {
  const u = userById(userId);
  const role = db.memberRole(orgId, userId);
  if (!u || !role || !roles.includes(role)) throw new Error(`${what} Your role cannot do this.`);
  // read-only after a pilot's hard stop (mock/billing.ts): refused before anything changes
  if (write) assertPilotWritable(orgId, userId, 'write');
  return u;
}

function agentOf(orgId: string, slug: string): DBAgent {
  const a = db.getDB(orgId).agents.find((x) => x.slug === slug) as DBAgent | undefined;
  if (!a) throw new Error(`No agent called ${slug}.`);
  return a;
}

export const isRetired = (a: Pick<AgentExt, 'retiredAt'> | undefined) => !!a?.retiredAt;

/* ── Endpoints from the deployment and residency domain ───── */

export interface Endpoints { host: string; mcpBase: string; checkUrl: string; recordUrl: string; residency: string; sovereign: boolean; note: string }

/**
 * The organisation's own endpoints. Hosted organisations use the regional host for their residency domain
 * (ap-south-1 → Mumbai); a Sovereign deployment answers on the customer's own domain inside its network.
 */
export function endpoints(orgId: string): Endpoints {
  const org = api.org(orgId);
  const sovereign = org.deployment === 'sovereign';
  const residency = org.residency ?? 'ap-south-1 Mumbai';
  const region = (residency.match(/ap-south-\d|eu-\w+-\d|us-\w+-\d/) ?? ['ap-south-1'])[0];
  const host = sovereign ? `govern.${org.domain ?? `${org.slug}.in`}` : `${region}.govern.elan1.ai`;
  return {
    host,
    mcpBase: `https://${host}/mcp/${org.slug}`,
    checkUrl: `https://${host}/v1/check`,
    recordUrl: `https://${host}/v1/record`,
    residency,
    sovereign,
    note: sovereign ? `Inside your network (${residency}). Nothing leaves it.` : `Residency domain ${residency}. Calls and receipts stay in this region.`,
  };
}

/* ── Read helpers ─────────────────────────────────────────── */

/** Finish rotations whose grace period has ended: the old key is revoked, by the system, on the chain. */
export function sweepKeys(orgId: string) {
  const d = db.getDB(orgId);
  const now = Date.now();
  let changed = 0;
  for (const a of d.agents as DBAgent[]) {
    for (const k of a.keys) {
      if (!k.revoked && k.revokeAt && new Date(k.revokeAt).getTime() <= now) {
        k.revoked = true;
        k.revokedAt = iso(now);
        k.revokedBy = 'system';
        db.append(d, { kind: 'admin', actor: 'system', action: 'key.revoked', agent: a.slug, details: { agent: a.slug, key: k.prefix, reason: 'Rotation grace period ended' } });
        changed++;
      }
    }
  }
  return changed;
}

export const keyState = (k: ExtKey, now = Date.now()): 'active' | 'revoked' | 'expired' | 'rotating' =>
  k.revoked ? 'revoked' : k.expiresAt && new Date(k.expiresAt).getTime() <= now ? 'expired' : k.revokeAt ? 'rotating' : 'active';

export function autoPauseOf(orgId: string, slug: string) {
  return autoPauseFor(orgId, slug);
}

/** Every receipt on the chain that names this agent (calls, approvals, admin changes). */
export function receiptCount(orgId: string, slug: string) {
  return db.getDB(orgId).receipts.filter((r) => r.agent === slug).length;
}

/** Decision receipts this agent has on the chain (calls it made). */
export function callCount(orgId: string, slug: string) {
  return db.getDB(orgId).receipts.filter((r) => r.kind === 'decision' && r.agent === slug).length;
}

/* ── Mutations ────────────────────────────────────────────── */

export async function updateAgent(orgId: string, slug: string, patch: { description?: string; ownerId?: string; riskLevel?: RiskLevel; businessUnit?: string }, userId: string) {
  await wait();
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins edit agents.');
  const a = agentOf(orgId, slug);
  if (isRetired(a)) throw new Error(`${slug} is retired. A retired agent keeps its record and cannot be edited.`);
  if (patch.description !== undefined && patch.description.trim().length < 10) throw new Error('Say in a sentence what the agent does (10 characters or more).');
  if (patch.ownerId && !userById(patch.ownerId)) throw new Error('Choose a person in this organisation as the owner.');
  const changed: string[] = [];
  if (patch.description !== undefined && patch.description.trim() !== a.description) { a.description = patch.description.trim(); changed.push('description'); }
  if (patch.ownerId && patch.ownerId !== a.ownerId) { a.ownerId = patch.ownerId; changed.push('owner'); }
  if (patch.riskLevel && patch.riskLevel !== a.riskLevel) { a.riskLevel = patch.riskLevel; changed.push('risk_level'); }
  if (patch.businessUnit !== undefined && patch.businessUnit !== a.businessUnit) { a.businessUnit = patch.businessUnit; changed.push('business_unit'); }
  if (!changed.length) return { agent: clone(a), receipt: undefined as Receipt | undefined, changed };
  const r = db.logAdmin(orgId, userId, 'agent.updated', { agent: slug, fields: changed.join(','), ...(changed.includes('owner') ? { owner: a.ownerId } : {}), ...(changed.includes('risk_level') ? { risk_level: a.riskLevel } : {}) }, slug);
  db.touch(orgId, 'agent');
  return { agent: clone(a), receipt: r, changed };
}

/**
 * Retire an agent: every key is revoked, it stops (calls are refused with agent-paused), its graduations are
 * revoked, and a receipt records it. The agent and all its receipts stay on the chain and keep verifying.
 */
export async function retireAgent(orgId: string, slug: string, reason: string, userId: string) {
  await wait(300, 600);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins retire agents.');
  if (reason.trim().length < 4) throw new Error('Say why the agent is retired — the reason is recorded on the receipt.');
  const a = agentOf(orgId, slug);
  if (isRetired(a)) throw new Error(`${slug} is already retired.`);
  const d = db.getDB(orgId);
  const now = iso();
  const live = a.keys.filter((k) => !k.revoked);
  live.forEach((k) => { k.revoked = true; k.revokedAt = now; k.revokedBy = userId; });
  let grants = 0;
  // the A2 starting level is not a grant a person made; the paused agent's calls are refused anyway
  for (const g of d.platform.grants.filter((x) => x.agentSlug === slug && !x.revokedAt && x.origin !== 'start')) {
    await api.revokeGrant(orgId, g.id, userId);
    grants++;
  }
  a.status = 'paused';
  a.pausedBy = 'owner';
  const r = db.logAdmin(orgId, userId, 'agent.retired', { agent: slug, keys_revoked: live.length, grants_revoked: grants, reason: reason.trim() }, slug);
  a.retiredAt = r.ts;
  a.retiredBy = userId;
  a.retireReason = reason.trim();
  a.retireSeq = r.seq;
  db.touch(orgId, 'agent');
  return { agent: clone(a), receipt: r, keysRevoked: live.length, grantsRevoked: grants };
}

/**
 * Delete an agent. Offered only while it has made no calls: nothing on the chain depends on it.
 * Its creation and its deletion stay on the chain as admin receipts.
 */
export async function deleteAgent(orgId: string, slug: string, userId: string) {
  await wait(300, 600);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins delete agents.');
  const d = db.getDB(orgId);
  const a = agentOf(orgId, slug);
  const calls = callCount(orgId, slug);
  if (calls > 0) throw new Error(`${slug} has ${calls} decision receipts on the chain. Retire it instead; its record must stay verifiable.`);
  if (d.approvals.some((x) => x.agentSlug === slug && x.status === 'pending')) throw new Error('An approval for this agent is still waiting. Decide it first.');
  d.agents = d.agents.filter((x) => x.slug !== slug);
  d.rulebooks = d.rulebooks.filter((x) => x.id !== a.rulebookId);
  d.aiSystems.filter((s) => s.linkedAgentId === a.id).forEach((s) => { delete s.linkedAgentId; });
  const r = db.logAdmin(orgId, userId, 'agent.deleted', { agent: slug, calls: 0, keys: a.keys.length });
  db.touch(orgId, 'agent');
  return r;
}

function newSecret(environment: 'sandbox' | 'production') {
  return `${environment === 'sandbox' ? 'sk_sbx_' : 'gk_'}${randHex(18)}`;
}

/** Issue a key with an optional expiry (30, 90 or 365 days). The secret is returned once. */
export async function issueKey(orgId: string, slug: string, input: { label: string; environment: 'sandbox' | 'production'; expiresDays?: number }, userId: string) {
  await wait(250, 450);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins issue keys.');
  // a production key (gk_) is never self-serve: it is asked for and reviewed by a person (Agents › Path to production)
  if (input.environment === 'production') throw new Error('A production key (gk_) is not issued directly. Ask for one in Agents › Path to production; a person reviews it within 2 working days.');
  const a = agentOf(orgId, slug);
  if (isRetired(a)) throw new Error(`${slug} is retired. Retired agents get no new keys.`);
  if (input.label.trim().length < 3) throw new Error('Give the key a label of at least 3 characters.');
  const secret = newSecret(input.environment);
  const now = Date.now();
  const key: ExtKey = { id: `key_${now.toString(36)}${randHex(2)}`, prefix: secret.slice(0, 12), label: input.label.trim(), createdAt: iso(now), environment: input.environment, ...(input.expiresDays ? { expiresAt: iso(now + input.expiresDays * D) } : {}) };
  a.keys.unshift(key);
  const r = db.logAdmin(orgId, userId, 'key.issued', { agent: slug, key: key.prefix, environment: input.environment, expires: key.expiresAt ? key.expiresAt.slice(0, 10) : 'never' }, slug);
  db.touch(orgId, 'agent');
  return { agent: clone(a), secret, key: clone(key), receipt: r };
}

/**
 * Rotate a key: a replacement with the same label, environment and lifetime is issued now; the old key keeps
 * working for the grace period and is then revoked by the system. Both steps are receipts.
 */
export async function rotateKey(orgId: string, slug: string, keyId: string, graceHours: number, userId: string) {
  await wait(300, 500);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins rotate keys.');
  const a = agentOf(orgId, slug);
  if (isRetired(a)) throw new Error(`${slug} is retired.`);
  const old = a.keys.find((k) => k.id === keyId);
  if (!old || old.revoked) throw new Error('That key is not active.');
  if (old.revokeAt) throw new Error('This key is already being rotated.');
  // a production key (gk_) is never self-serve, and a rotation issues a new one: it needs the same production
  // review as issuing (Agents › Path to production). The approved request is used up by the rotation.
  const review = old.environment === 'production' ? approvedProductionRequest(orgId, slug) : undefined;
  if (old.environment === 'production' && !review) throw new Error('A production key (gk_) is replaced only through the production review. Ask for a replacement key in Agents › Path to production; once a person approves it, rotate here and the old key keeps working for the grace period.');
  const now = Date.now();
  const lifetime = old.expiresAt ? new Date(old.expiresAt).getTime() - new Date(old.createdAt).getTime() : undefined;
  const secret = newSecret(old.environment);
  const key: ExtKey = { id: `key_${now.toString(36)}${randHex(2)}`, prefix: secret.slice(0, 12), label: old.label, createdAt: iso(now), environment: old.environment, rotatedFrom: old.id, ...(lifetime ? { expiresAt: iso(now + lifetime) } : {}) };
  a.keys.unshift(key);
  old.rotatedTo = key.id;
  if (graceHours <= 0) { old.revoked = true; old.revokedAt = iso(now); old.revokedBy = userId; } else old.revokeAt = iso(now + graceHours * H);
  const r = db.logAdmin(orgId, userId, 'key.rotated', { agent: slug, old_key: old.prefix, new_key: key.prefix, environment: key.environment, grace_hours: graceHours, ...(review ? { request: review.id, reviewed_by: review.reviewer ?? '' } : {}) }, slug);
  if (review) {
    review.status = 'issued';
    review.keyPrefix = key.prefix;
    review.issuedAt = r.ts;
    review.issuedBy = userId;
    review.seqs.issued = r.seq;
    db.touch(orgId, 'devpath');
  }
  db.touch(orgId, 'agent');
  return { agent: clone(a), secret, key: clone(key), old: clone(old), receipt: r };
}

/** The agent's approved, not yet collected production-key request (the review a gk_ rotation needs), if any. */
export function approvedProductionRequest(orgId: string, slug: string) {
  return devpathState(orgId).requests.find((x) => x.agentSlug === slug && x.status === 'approved');
}

export async function setAutoPause(orgId: string, slug: string, on: boolean, userId: string) {
  const a = agentOf(orgId, slug);
  if (isRetired(a)) throw new Error(`${slug} is retired.`);
  return setAutoPauseWork(orgId, slug, on, userId);
}

/* ── Test call through the guard ──────────────────────────── */

/** The published version in force now, if any. */
export function publishedVersion(orgId: string, slug: string) {
  const d = db.getDB(orgId);
  const a = d.agents.find((x) => x.slug === slug);
  const rb = d.rulebooks.find((r) => r.id === a?.rulebookId);
  const pubs = rb?.versions.filter((v) => v.status === 'published') ?? [];
  return { rulebook: rb, version: pubs.find((v) => v.version === rb?.currentVersion) ?? pubs[pubs.length - 1] };
}

function tagsOf(d: OrgDB, tool: string): { tags: RiskTag[]; connector?: string } {
  const c = d.connectors.find((x) => x.tools.some((t) => t.name === tool));
  return { tags: c?.tools.find((t) => t.name === tool)?.tags ?? [], connector: c?.name };
}

/**
 * Send one call through the guard (stop → identity → rulebook → autonomy → decide) and record it.
 * The approver group is the one the matched rule names. With no published version the call is refused (no-rulebook).
 */
export async function testCall(orgId: string, slug: string, tool: string, args: Record<string, string | number | boolean>, userId: string) {
  await wait(300, 550);
  // a test call goes to the guard even when writes are paused: it is refused there with POLICY.TENANT_STOPPED
  const user = requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins send test calls.', false);
  const d = db.getDB(orgId);
  const a = agentOf(orgId, slug);
  if (!a.tools.includes(tool)) throw new Error(`${tool} is not one of ${slug}'s tools.`);
  const { version } = publishedVersion(orgId, slug);
  const { tags, connector } = tagsOf(d, tool);
  const ev = version ? evaluate(version.rules, tool, args, tags) : { decision: 'refuse' as const, ruleId: 'no-rulebook', reason: 'No published rulebook version. Every call is refused until a version is published.', matched: [] };
  const rule = version?.rules.find((r) => r.id === ev.ruleId);
  const call: Call = {
    tool, args, decision: ev.decision, ruleId: ev.ruleId, reason: ev.reason, tags, connector: connector ?? 'Unknown',
    approverGroup: rule?.approver, headline: `${slug} wants to call ${tool} (test call)`, effect: `Test call sent from the console by ${user.name}.`, triggeredBy: 'test call from the console', expiresInH: 1,
  };
  const r = db.governCall(d, a, call);
  return { receipt: clone(r), evaluation: ev, approverGroup: rule?.approver };
}

/* ── Create an agent (the add-agent wizard) ───────────────── */

export const LEXICON = 'elan1.lexicon.v1';

export interface CreateInput {
  name: string; slug: string; description: string; framework: Agent['framework']; route: Agent['route']; ownerId: string; riskLevel: RiskLevel;
  connectorIds: string[]; tools: string[]; rules: Rule[]; businessUnit: string; environment: 'sandbox' | 'production'; expiresDays?: number;
  actorKind: Declaration['actorKind']; reviewNote?: string;
}

export interface CreateResult {
  agent: AgentExt; secret: string; mcpUrl: string; endpoints: Endpoints;
  rulebook: { status: 'published' | 'in_review'; version: number; reviewId?: string };
  declaration: Declaration;
  aiSystem?: { id: string; name: string }; aiSystemError?: string;
  /** L3 and Sovereign: write types started at A2 Propose (the platform's starting level; nobody chooses it) */
  autonomyStarted: number;
  receipts: number[];
}

/**
 * Register an agent. L1: rulebook v1 is signed and published by the creator (the review is recorded, not
 * enforced). From L2: dual control is enforced — v1 is created in review and a different person must approve
 * it before anyone publishes it; until then every call is refused (no-rulebook). The declaration (Seal v6
 * F06 declaration_id, F07 declaration_version, F10 actor_kind, F15 lexicon_hash) is recorded on the chain.
 */
export async function createAgent(orgId: string, input: CreateInput, userId: string): Promise<CreateResult> {
  await wait(400, 800);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins add agents.');
  const d = db.getDB(orgId);
  const slugError = db.agentSlugProblem(d, input.slug);
  if (slugError) throw new Error(slugError);
  if (!input.tools.length) throw new Error('Choose at least one tool.');
  if (input.environment === 'production') throw new Error('A new agent starts with a sandbox key. A production key (gk_) is asked for in Agents › Path to production and reviewed by a person.');
  const level = api.levelOf(orgId);
  const dual = atLeast(level, 'l2');
  const id = `ag_${input.slug}`;
  const rbId = `rb_${input.slug}`;
  const now = iso();
  const groups = Array.from(new Set(input.rules.map((r) => r.approver).filter(Boolean) as string[]));
  const yaml = rulebookYaml(input.slug, 1, input.ownerId, input.rules, groups.length ? groups : ['owners']);
  const hash = sha256Hex(yaml);
  const ep = endpoints(orgId);
  const secret = newSecret(input.environment);
  const writeTypes = input.tools.filter((t) => { const tg = tagsOf(d, t).tags; return tg.some((x) => x !== 'reads_data'); });
  const lexiconHash = sha256Hex(`${LEXICON}|${input.tools.slice().sort().join(',')}`);
  const receipts: number[] = [];

  const agent: DBAgent = {
    id, slug: input.slug, name: input.name, description: input.description, framework: input.framework, route: input.route, status: 'active', ownerId: input.ownerId,
    riskLevel: input.riskLevel, rulebookId: rbId, connectorIds: input.connectorIds, tools: input.tools, createdAt: now, businessUnit: input.businessUnit,
    keys: [{ id: `key_${input.slug}_${randHex(2)}`, prefix: secret.slice(0, 12), label: `Created in the wizard · ${input.environment === 'sandbox' ? 'sandbox' : 'production'}`, createdAt: now, environment: input.environment, ...(input.expiresDays ? { expiresAt: iso(Date.now() + input.expiresDays * D) } : {}) }],
    stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 }, scenarioKey: '',
  };
  const rb = {
    id: rbId, slug: input.slug, name: `${input.name} rulebook`, agentId: id, default: 'refuse' as const,
    approverGroups: approverGroupsFor(orgId).filter((g) => (groups.length ? groups : ['owners']).includes(g.id)),
    currentVersion: 1, updatedAt: now,
    versions: [dual
      ? { version: 1, status: 'draft' as const, hash, createdBy: userId, createdAt: now, note: 'Starter rulebook from the add-agent wizard', rules: input.rules, yaml }
      : { version: 1, status: 'published' as const, hash, createdBy: userId, createdAt: now, signedBy: userId, signedAt: now, note: 'Starter rulebook from the add-agent wizard', rules: input.rules, yaml }],
  };
  d.agents.push(agent);
  d.rulebooks.push(rb);
  receipts.push(db.append(d, { kind: 'admin', actor: userId, action: 'agent.created', agent: input.slug, details: { route: input.route, tools: input.tools.length, business_unit: input.businessUnit, key_environment: input.environment } }).seq);

  const decl: Declaration = { id: `decl.${input.slug}`, version: 1, actorKind: input.actorKind, lexicon: LEXICON, lexiconHash, writeTypes, recordedAt: now };
  const dr = db.append(d, { kind: 'admin', actor: userId, action: 'declaration.recorded', agent: input.slug, details: { declaration_id: decl.id, declaration_version: 1, actor_kind: decl.actorKind, lexicon_hash: lexiconHash.slice(0, 16), write_types: writeTypes.length } });
  decl.seq = dr.seq;
  agent.declaration = decl;
  receipts.push(dr.seq);

  let reviewId: string | undefined;
  if (dual) {
    const rv = await api.requestReview(orgId, rbId, userId, input.reviewNote?.trim() || `Starter rulebook v1 for the new agent ${input.slug}.`);
    reviewId = rv.id;
  } else {
    receipts.push(db.append(d, { kind: 'admin', actor: userId, action: 'rulebook.published', agent: input.slug, details: { rulebook: input.slug, version: 1, hash: hash.slice(0, 16), reviewed_by: '', dual_control: 'recorded' } }).seq);
  }

  // join the AI inventory
  let aiSystem: CreateResult['aiSystem'];
  let aiSystemError: string | undefined;
  try {
    const tags = new Set(input.tools.flatMap((t) => tagsOf(d, t).tags));
    const s = await api.addAiSystem(orgId, {
      name: input.name, kind: 'agent', vendor: VENDOR[input.framework], purpose: input.description, ownerId: input.ownerId, businessUnit: input.businessUnit,
      lifecycle: 'live', dataCategories: tags.has('personal_data') ? ['Personal data'] : [], affectedPeople: [],
      decisionImpact: [...tags].some((t) => t !== 'reads_data') ? 'decides' : 'informs', linkedAgentId: id, frameworks: [],
    }, userId);
    agent.aiSystemId = s.id;
    aiSystem = { id: s.id, name: s.name };
  } catch (e) {
    aiSystemError = (e as Error).message;
  }

  // earned autonomy (L3 and Sovereign): no level is chosen here. Each write type starts at A2 Propose — a person
  // approves every write — and reaches A3 only by a two-person graduation once its record meets the thresholds.
  const autonomyStarted = atLeast(level, 'l3') ? startAutonomy(orgId, input.slug) : 0;

  db.touch(orgId, 'agent');
  return {
    agent: clone(agent), secret, mcpUrl: `${ep.mcpBase}/${input.slug}`, endpoints: ep,
    rulebook: { status: dual ? 'in_review' : 'published', version: 1, reviewId }, declaration: clone(decl),
    aiSystem, aiSystemError, autonomyStarted, receipts,
  };
}

export const VENDOR: Record<Agent['framework'], string> = { Claude: 'Anthropic', Cursor: 'Anysphere', LangChain: 'LangChain', 'OpenAI Agents SDK': 'OpenAI', Custom: 'In-house' };

/* ── L2 evidence per receipt ──────────────────────────────── */

export interface EvidenceIndex { sealedFrom?: number; lastAnchoredSeq?: number; authorities: string[]; enabled: boolean }

/** When sealing started (the L2 boundary) and how far the chain is anchored, for chips on receipt lists. */
export async function evidenceIndex(orgId: string): Promise<EvidenceIndex> {
  const level = api.levelOf(orgId);
  if (!atLeast(level, 'l2')) return { enabled: false, authorities: [] };
  const [st, an] = await Promise.all([api.level(orgId), api.anchors(orgId, 1)]);
  const l2 = st.history.find((h) => h.level !== 'l1');
  return { enabled: true, sealedFrom: l2 ? new Date(l2.from).getTime() : undefined, lastAnchoredSeq: an.totals.lastAnchoredSeq, authorities: an.authorities.map((x) => x.name) };
}

export function evidenceOf(ix: EvidenceIndex | undefined, r: Pick<Receipt, 'seq' | 'ts'>): 'l1' | 'sealed' | 'anchored' | undefined {
  if (!ix?.enabled) return undefined;
  if (ix.sealedFrom === undefined || new Date(r.ts).getTime() < ix.sealedFrom) return 'l1';
  return ix.lastAnchoredSeq !== undefined && r.seq <= ix.lastAnchoredSeq ? 'anchored' : 'sealed';
}

/* ── L3: counterparties per agent ─────────────────────────── */

export interface AgentCounterparties { issued: number; received: number; names: string[] }

/** Receipts each agent issued to counterparties (via the issuing receipt's agent), and receipts received. */
export async function counterpartiesByAgent(orgId: string): Promise<{ byAgent: Map<string, AgentCounterparties>; received: number; register: number }> {
  const [rows, reg] = await Promise.all([api.crossOrgReceipts(orgId), api.counterparties(orgId)]);
  const d = db.getDB(orgId);
  const bySeq = new Map(d.receipts.map((r) => [r.seq, r]));
  const byAgent = new Map<string, AgentCounterparties>();
  for (const x of rows) {
    if (x.direction !== 'issued') continue;
    const agent = bySeq.get(x.seq)?.agent;
    if (!agent) continue;
    const e = byAgent.get(agent) ?? { issued: 0, received: 0, names: [] };
    e.issued++;
    if (!e.names.includes(x.counterpartyName)) e.names.push(x.counterpartyName);
    byAgent.set(agent, e);
  }
  return { byAgent, received: rows.filter((x) => x.direction === 'received').length, register: reg.counterparties.length };
}

export const counterpartyText = (c?: AgentCounterparties) => (c ? `${c.issued} issued · ${c.names.slice(0, 2).join(', ')}${c.names.length > 2 ? ` +${c.names.length - 2}` : ''}` : undefined);

/* ── L3: earned autonomy ──────────────────────────────────── */

/**
 * Who may propose, approve or revoke a graduation: owners and admins (the autonomy.grant permission id). No
 * function here sets a level: autonomy is graduation only (src/api proposeGraduation / decideGraduation /
 * revokeGrant). Raise requests kept by earlier versions (`agentsExt.grantRequests`) are no longer read.
 */
export const canGrantAutonomy = (role?: string) => role === 'owner' || role === 'admin';

export { userName };
