/**
 * Declarations other than rulebooks, by version, and withdrawing a version (Records › Declarations):
 *  - the agent declaration decl.<slug> (Seal v6 F06 declaration_id, F07 declaration_version, F10 actor_kind,
 *    F15 lexicon_hash), recorded when an agent is added (features/agents/backend.ts) and re-recorded here;
 *  - the regulatory-pack declaration decl.<pack>: the parameters its checks G1–G9 run with, a new version per
 *    configuration (features/packs/config.ts).
 * A withdrawn version stays in the history and the receipts that named it keep verifying; no call made afterwards
 * uses it. When it was the version in force, the newest version not withdrawn takes over. Every write is a receipt.
 *
 * State: agent declaration versions under platform.recordsDecl; pack withdrawals beside the pack's parameters
 * (platform.recordsDoor.packConfig[pack].withdrawn / .highest). Every field is optional on read, so state saved
 * before this file existed loads unchanged.
 */
import type { Agent, LevelId, PackId } from '@/types';
import { sha256Hex } from '@/lib/crypto';
import { levelOfOrg } from '@/lib/levels';
import { PACKS } from '@/lib/packs';
import { append, getDB, memberRole, touch, type OrgDB } from './db';

/** The lexicon every declaration is written in (the same constant as features/agents/backend.ts LEXICON). */
const LEXICON = 'elan1.lexicon.v1';
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wait = (min = 120, max = 320) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

export type ActorKind = 'agent' | 'agent_on_behalf_of_person' | 'service';
export const ACTOR_KIND_LABEL: Record<ActorKind, string> = { agent: 'Agent acting for itself', agent_on_behalf_of_person: 'Agent acting for a named person', service: 'Automated service' };

export interface Withdrawal { at: string; by: string; reason: string; seq?: number; fallbackVersion?: number }

export interface AgentDeclVersion {
  version: number;
  actorKind: ActorKind;
  lexicon: string;
  lexiconHash: string;
  writeTypes: string[];
  recordedAt: string;
  recordedBy?: string;
  note?: string;
  seq?: number;
  withdrawn?: Withdrawal;
}

/** The declaration kept on the agent record (features/agents/backend.ts Declaration). */
interface AgentDeclaration { id: string; version: number; actorKind: ActorKind; lexicon: string; lexiconHash: string; writeTypes: string[]; recordedAt: string; seq?: number }
type AgentWithDecl = Agent & { declaration?: AgentDeclaration; retiredAt?: string };

interface DeclState { agents: Record<string, AgentDeclVersion[]>; agentsSeeded?: boolean; withdrawalSeeded?: boolean; packSeeded?: boolean }

interface PackCfg { values: Record<string, number>; version: number; updatedAt: string; updatedBy: string; highest?: number; withdrawn?: (Withdrawal & { version: number })[] }

function st(d: OrgDB): DeclState {
  const p = d.platform as unknown as { recordsDecl?: Partial<DeclState> };
  const x = (p.recordsDecl ??= {});
  x.agents ??= {};
  return x as DeclState;
}

function packCfgs(d: OrgDB): Partial<Record<PackId, PackCfg>> {
  const p = d.platform as unknown as { recordsDoor?: { packConfig?: Partial<Record<PackId, PackCfg>> } };
  // the same shape features/records/ext.ts doorState creates; only packConfig is touched here
  const door = (p.recordsDoor ??= { packConfig: {}, allowlist: { entries: [] }, aiExtra: {}, registeredTools: [] } as unknown as { packConfig: Partial<Record<PackId, PackCfg>> });
  door.packConfig ??= {};
  return door.packConfig;
}

function requireManager(orgId: string, userId: string, what: string) {
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what} — owners and admins can do this; your role cannot.`);
}

const ownerOf = (d: OrgDB) => d.members.find((m) => m.role === 'owner' && m.status === 'active')?.userId ?? 'system';

/* ══ Agent declarations ══════════════════════════════════════════════════ */

/** The write types an agent declares: every tool it may call that is not read-only. */
function writeTypesOf(d: OrgDB, a: Agent) {
  return a.tools.filter((t) => {
    const tool = d.connectors.flatMap((c) => c.tools).find((x) => x.name === t);
    const tags = (tool?.tags ?? []) as string[];
    return !tags.length ? !/\.(list|read|get|search)_/.test(t) : tags.some((x) => x !== 'reads_data');
  });
}

const lexiconHashOf = (a: Agent) => sha256Hex(`${LEXICON}|${a.tools.slice().sort().join(',')}`);

/** The agent's versions, starting from the declaration on its record when nothing is kept here yet. */
function versionsOf(d: OrgDB, a: AgentWithDecl): AgentDeclVersion[] {
  const s = st(d);
  const list = (s.agents[a.slug] ??= []);
  const decl = a.declaration;
  if (decl && !list.some((v) => v.version === decl.version)) {
    list.push({ version: decl.version, actorKind: decl.actorKind, lexicon: decl.lexicon, lexiconHash: decl.lexiconHash, writeTypes: decl.writeTypes, recordedAt: decl.recordedAt, seq: decl.seq });
    list.sort((x, y) => x.version - y.version);
  }
  return list;
}

function setInForce(a: AgentWithDecl, v: AgentDeclVersion) {
  a.declaration = { id: `decl.${a.slug}`, version: v.version, actorKind: v.actorKind, lexicon: v.lexicon, lexiconHash: v.lexiconHash, writeTypes: v.writeTypes.slice(), recordedAt: v.recordedAt, seq: v.seq };
}

function writeDeclaration(d: OrgDB, a: AgentWithDecl, actorKind: ActorKind, userId: string, note?: string) {
  const list = versionsOf(d, a);
  const version = Math.max(0, ...list.map((v) => v.version)) + 1;
  const writeTypes = writeTypesOf(d, a);
  const lexiconHash = lexiconHashOf(a);
  const r = append(d, { kind: 'admin', actor: userId, action: 'declaration.recorded', agent: a.slug, details: { declaration_id: `decl.${a.slug}`, declaration_version: version, actor_kind: actorKind, lexicon_hash: lexiconHash.slice(0, 16), write_types: writeTypes.length, ...(note ? { note } : {}) } });
  const v: AgentDeclVersion = { version, actorKind, lexicon: LEXICON, lexiconHash, writeTypes, recordedAt: r.ts, recordedBy: userId, note, seq: r.seq };
  list.push(v);
  setInForce(a, v);
  return v;
}

/** The newest version that is not withdrawn, other than `version` (undefined: none would be left). */
function agentFallback(list: AgentDeclVersion[], version: number) {
  return list.filter((v) => v.version !== version && !v.withdrawn).sort((x, y) => x.version - y.version).pop();
}

/* ══ Pack declarations ═══════════════════════════════════════════════════ */

export interface PackDeclVersion {
  version: number;
  at?: string;
  by?: string;
  seq?: number;
  /** the parameters this version set; undefined for version 1 (the pack's defaults) */
  values?: Record<string, number>;
  changed?: string[];
  withdrawn?: Withdrawal;
  inForce: boolean;
}

/** Every version of an installed pack's declaration: v1 at installation (the defaults), then one per pack.configured receipt. */
function packVersions(d: OrgDB, pack: PackId): PackDeclVersion[] {
  const inst = d.platform.packs.find((p) => p.id === pack);
  const cfg = packCfgs(d)[pack];
  const inForce = cfg?.version ?? 1;
  const byVersion = new Map<number, PackDeclVersion>();
  byVersion.set(1, { version: 1, at: inst?.installedAt, by: inst?.installedBy, inForce: false });
  for (const r of d.receipts) {
    if (r.kind !== 'admin' || r.action !== 'pack.configured' || r.details?.pack !== pack) continue;
    const version = Number(r.details.version);
    if (!Number.isFinite(version) || version < 2) continue;
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.details)) if (typeof v === 'number' && k !== 'version') values[k] = v;
    const changed = typeof r.details.changed === 'string' && r.details.changed !== 'none' ? r.details.changed.split(',') : [];
    byVersion.set(version, { version, at: r.ts, by: r.actor, seq: r.seq, values, changed, inForce: false });
  }
  for (const w of cfg?.withdrawn ?? []) {
    const v = byVersion.get(w.version);
    if (v) v.withdrawn = { at: w.at, by: w.by, reason: w.reason, seq: w.seq, fallbackVersion: w.fallbackVersion };
  }
  const list = [...byVersion.values()].sort((a, b) => b.version - a.version);
  list.forEach((v) => { v.inForce = v.version === inForce; });
  return list;
}

/* ══ Seeding (once per organisation) ═════════════════════════════════════ */

/** Seed the demo data this file owns. Safe on every read; each part runs once. Called from mock/records.ts ensureRecordsSeed. */
export function ensureDeclSeed(d: OrgDB) {
  const s = st(d);
  if (d.fresh) { s.agentsSeeded = s.withdrawalSeeded = s.packSeeded = true; return; }
  if (!s.agentsSeeded) {
    s.agentsSeeded = true;
    // agents added before the declaration register get their first version, recorded when the register was switched on
    const owner = ownerOf(d);
    for (const a of d.agents as AgentWithDecl[]) {
      if (a.declaration || a.retiredAt) continue;
      writeDeclaration(d, a, a.framework === 'Custom' ? 'service' : 'agent', owner, 'Recorded when the declaration register was switched on');
    }
  }
  if (!s.withdrawalSeeded) {
    s.withdrawalSeeded = true;
    // L2 and L3 demo organisations: one agent re-declared (acting for a named person) and its first version withdrawn
    if (d.org.id === 'org_northbank' || d.org.id === 'org_kaveri') {
      const a = (d.agents as AgentWithDecl[]).find((x) => x.declaration && !x.retiredAt && writeTypesOf(d, x).length);
      if (a) {
        const owner = ownerOf(d);
        const old = versionsOf(d, a).find((v) => !v.withdrawn);
        writeDeclaration(d, a, 'agent_on_behalf_of_person', owner, 'Acts for the named finance manager who approves its runs');
        if (old) {
          const reason = 'Declared the agent as acting for itself; it acts for a named person, so receipts must say so. Never to be restored.';
          const r = append(d, { kind: 'admin', actor: owner, action: 'declaration.version_withdrawn', agent: a.slug, details: { declaration: `decl.${a.slug}`, version: old.version, reason, was_in_force: false, now_in_force: a.declaration!.version } });
          old.withdrawn = { at: r.ts, by: owner, reason, seq: r.seq };
        }
      }
    }
  }
  if (!s.packSeeded) {
    s.packSeeded = true;
    // L2 and above: a pack declaration version that loosened a check, withdrawn the same week; v1 is in force again
    if (d.org.id === 'org_northbank' || d.org.id === 'org_kaveri' || d.org.id === 'org_deccan') seedPackWithdrawal(d);
  }
}

const LOOSER: Record<PackId, { values: Record<string, number>; changed: string; reason: string }> = {
  ledger1: { values: { dualControlAbove: 500000, retentionYears: 8 }, changed: 'dualControlAbove', reason: 'Raised the second-person threshold to ₹5,00,000 without the audit committee’s sign-off. Withdrawn; version 1 is in force again.' },
  invoice1: { values: { ratePerMinute: 240, cancelWindowHours: 24 }, changed: 'ratePerMinute', reason: 'The IRP rate was set above the GSP’s contracted limit. Withdrawn; version 1 is in force again.' },
  collect1: { values: { windowFrom: 8, windowTo: 19, dailyCap: 5 }, changed: 'dailyCap', reason: 'Five contacts a day per borrower is more than the lender’s fair-practices code allows. Withdrawn; version 1 is in force again.' },
};

function seedPackWithdrawal(d: OrgDB) {
  const cfgs = packCfgs(d);
  const inst = d.platform.packs.find((p) => !cfgs[p.id] || (cfgs[p.id]!.version ?? 1) === 1);
  if (!inst) return;
  const owner = ownerOf(d);
  const admin = d.members.find((m) => m.role === 'admin' && m.status === 'active')?.userId ?? owner;
  const pk = LOOSER[inst.id];
  const c = append(d, { kind: 'admin', actor: admin, action: 'pack.configured', details: { pack: inst.id, declaration: `decl.${inst.id}`, version: 2, changed: pk.changed, ...pk.values } });
  const w = append(d, { kind: 'admin', actor: owner, action: 'pack.declaration_withdrawn', details: { pack: inst.id, declaration: `decl.${inst.id}`, version: 2, reason: pk.reason, was_in_force: true, now_in_force: 1 } });
  cfgs[inst.id] = { values: {}, version: 1, updatedAt: w.ts, updatedBy: owner, highest: 2, withdrawn: [{ version: 2, at: w.ts, by: owner, reason: pk.reason, seq: w.seq, fallbackVersion: 1 }] };
  void c;
}

/* ══ Views and writes ════════════════════════════════════════════════════ */

export interface AgentDeclRow { slug: string; name: string; status: string; retired: boolean; inForce?: number; currentTools: number; drift: boolean; versions: (AgentDeclVersion & { inForce: boolean })[] }
export interface PackDeclRow { id: PackId; name: string; regime: string; installed: boolean; inForce: number; versions: PackDeclVersion[] }

export function declarationsExt(orgId: string): { level: LevelId; agents: AgentDeclRow[]; packs: PackDeclRow[] } {
  const d = getDB(orgId);
  ensureDeclSeed(d);
  const agents = (d.agents as AgentWithDecl[]).map((a) => {
    const list = versionsOf(d, a);
    const inForce = a.declaration?.version;
    const cur = list.find((v) => v.version === inForce);
    return {
      slug: a.slug, name: a.name, status: a.status, retired: !!a.retiredAt, inForce, currentTools: a.tools.length,
      // the agent's tools changed since the version in force: its write types or lexicon hash no longer match
      drift: !!cur && cur.lexiconHash !== lexiconHashOf(a),
      versions: list.slice().sort((x, y) => y.version - x.version).map((v) => ({ ...v, inForce: v.version === inForce })),
    };
  });
  const installed = new Set(d.platform.packs.map((p) => p.id));
  const packs = PACKS.filter((p) => installed.has(p.id)).map((p) => ({ id: p.id, name: p.name, regime: p.regime, installed: true, inForce: packCfgs(d)[p.id]?.version ?? 1, versions: packVersions(d, p.id) }));
  return clone({ level: levelOfOrg(d.org), agents, packs });
}

/** Record a new version of an agent's declaration from its current tools. It is in force from the next call. */
export function recordAgentDeclaration(orgId: string, slug: string, input: { actorKind: ActorKind; note: string }, userId: string) {
  const d = getDB(orgId);
  ensureDeclSeed(d);
  requireManager(orgId, userId, 'Recording a declaration');
  const a = (d.agents as AgentWithDecl[]).find((x) => x.slug === slug);
  if (!a) throw new Error(`No agent called ${slug}.`);
  if (a.retiredAt) throw new Error('A retired agent makes no calls; its declarations stay as they were.');
  if (!ACTOR_KIND_LABEL[input.actorKind]) throw new Error('Choose who the agent acts for.');
  if (input.note.trim().length < 8) throw new Error('Say why there is a new version, in a sentence. It goes on the receipt.');
  const v = writeDeclaration(d, a, input.actorKind, userId, input.note.trim());
  touch(orgId, 'agent');
  return clone(v);
}

/** Withdraw a version of an agent's declaration. When it is in force, the newest version not withdrawn takes over. */
export function withdrawAgentDeclaration(orgId: string, slug: string, version: number, reason: string, userId: string) {
  const d = getDB(orgId);
  ensureDeclSeed(d);
  requireManager(orgId, userId, 'Withdrawing a declaration version');
  const a = (d.agents as AgentWithDecl[]).find((x) => x.slug === slug);
  if (!a) throw new Error(`No agent called ${slug}.`);
  const list = versionsOf(d, a);
  const v = list.find((x) => x.version === version);
  if (!v) throw new Error(`No version ${version} of decl.${slug}.`);
  if (v.withdrawn) throw new Error(`Version ${version} was withdrawn ${v.withdrawn.at.slice(0, 10)}.`);
  if (reason.trim().length < 8) throw new Error('Say why the version is withdrawn, in a sentence. The reason goes on the receipt.');
  const wasInForce = a.declaration?.version === version;
  const fallback = agentFallback(list, version);
  if (wasInForce && !fallback) throw new Error(`Version ${version} is the only version of decl.${slug}. Record a new version first — withdrawing it would leave the agent with no declaration.`);
  const r = append(d, { kind: 'admin', actor: userId, action: 'declaration.version_withdrawn', agent: slug, details: { declaration: `decl.${slug}`, version, reason: reason.trim(), was_in_force: wasInForce, now_in_force: wasInForce ? fallback!.version : a.declaration?.version ?? 0 } });
  v.withdrawn = { at: r.ts, by: userId, reason: reason.trim(), seq: r.seq, fallbackVersion: wasInForce ? fallback!.version : undefined };
  if (wasInForce) setInForce(a, fallback!);
  touch(orgId, 'agent');
  return { seq: r.seq, wasInForce, nowInForce: a.declaration?.version };
}

/** Withdraw a version of an installed pack's declaration. When it is in force, the newest version not withdrawn takes over with its parameters. */
export function withdrawPackDeclaration(orgId: string, pack: PackId, version: number, reason: string, userId: string) {
  const d = getDB(orgId);
  ensureDeclSeed(d);
  requireManager(orgId, userId, 'Withdrawing a pack declaration version');
  if (!d.platform.packs.some((p) => p.id === pack)) throw new Error(`${pack} is not installed.`);
  const versions = packVersions(d, pack);
  const v = versions.find((x) => x.version === version);
  if (!v) throw new Error(`No version ${version} of decl.${pack}.`);
  if (v.withdrawn) throw new Error(`Version ${version} was withdrawn ${v.withdrawn.at.slice(0, 10)}.`);
  if (reason.trim().length < 8) throw new Error('Say why the version is withdrawn, in a sentence. The reason goes on the receipt.');
  const fallback = versions.filter((x) => x.version !== version && !x.withdrawn).sort((a, b) => a.version - b.version).pop();
  if (v.inForce && !fallback) throw new Error(`Version ${version} is the only version of decl.${pack} left. Configure a new version first — the pack’s checks always run under a declaration.`);
  const r = append(d, { kind: 'admin', actor: userId, action: 'pack.declaration_withdrawn', details: { pack, declaration: `decl.${pack}`, version, reason: reason.trim(), was_in_force: v.inForce, now_in_force: v.inForce ? fallback!.version : versions.find((x) => x.inForce)?.version ?? 1 } });
  const cfgs = packCfgs(d);
  const highest = Math.max(...versions.map((x) => x.version));
  const cfg: PackCfg = cfgs[pack] ?? { values: {}, version: 1, updatedAt: r.ts, updatedBy: userId };
  cfg.highest = Math.max(cfg.highest ?? 0, highest);
  (cfg.withdrawn ??= []).push({ version, at: r.ts, by: userId, reason: reason.trim(), seq: r.seq, fallbackVersion: v.inForce ? fallback!.version : undefined });
  if (v.inForce) {
    // the parameters of the version that takes over (version 1: the pack's defaults)
    cfg.values = { ...(fallback!.values ?? {}) };
    cfg.version = fallback!.version;
    cfg.updatedAt = r.ts;
    cfg.updatedBy = userId;
  }
  cfgs[pack] = cfg;
  touch(orgId, 'pack');
  return { seq: r.seq, wasInForce: v.inForce, nowInForce: cfg.version };
}

/** What the Declarations screen calls (with the small wait every mock call has). */
export const declApi = {
  async view(orgId: string) { await wait(); return declarationsExt(orgId); },
  async recordAgent(orgId: string, slug: string, input: { actorKind: ActorKind; note: string }, userId: string) { await wait(250, 450); return recordAgentDeclaration(orgId, slug, input, userId); },
  async withdrawAgent(orgId: string, slug: string, version: number, reason: string, userId: string) { await wait(250, 450); return withdrawAgentDeclaration(orgId, slug, version, reason, userId); },
  async withdrawPack(orgId: string, pack: PackId, version: number, reason: string, userId: string) { await wait(250, 450); return withdrawPackDeclaration(orgId, pack, version, reason, userId); },
};
