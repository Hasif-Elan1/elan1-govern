/**
 * The API contract the console uses. Today every call is served from the in-memory mock (src/mock);
 * a real backend replaces the bodies of these functions without touching any screen.
 * Calls resolve after a short latency so loading states are real.
 */
import type {
  Channel, Counterparty, Decision, EscalationPolicy, IdentityConfig, LevelId, PackId, ReceiptKind, Rule,
} from '@/types';
import * as db from '@/mock/db';
import * as platform from '@/mock/platform';
import * as evidenceMock from '@/mock/evidence';
import * as evidenceGuards from '@/mock/evidenceGuards';
import * as ops from '@/mock/ops';
import { replay, evaluate } from '@/lib/evaluate';
import { userById, USERS, ORGS, DEMO_ACCOUNTS } from '@/mock/users';
import { effectiveGroupsOf, replayOnOf, replaySinceOf } from '@/mock/orgSettings';
import { PLANS } from '@/lib/pricing';
import { CAPABILITIES, capabilitiesFor, hasCapability, levelOfOrg } from '@/lib/levels';
import { verifyBundle as verifyBundle6, type VerifyBundleOptions } from '@/lib/verify6';
import { can, ROLE_INFO, type Permission } from '@/lib/permissions';
import { TOOLS } from '@/mock/catalog';
import { assertKeyChangeAllowed, ceremonySuccessor } from '@/mock/keys';
import { recordsApi } from '@/mock/records';
// registers the regulatory pack checks with the guard (addRecordedCheck), after G1
import '@/mock/packChecks';
import { upgradeCloseoutApi } from './upgradeCloseout';
import { l3ExtrasApi } from './l3extras';
import { prepareCrossOrg } from '@/mock/l3crossorg';
import { enforceAutonomyBreaches } from '@/mock/l3autonomy';
import { packsFactoryApi } from './packsFactory';
import * as packsFactory from '@/mock/packsFactory';
import { assertPilotWritable } from '@/mock/billing';
import * as billingMock from '@/mock/billing';
import { approvalsExt } from '@/mock/approvalsExt';
import type { Approval } from '@/types';

/**
 * "Similar decisions under this rule": counted from this organisation's own approvals held by the same rule and
 * decided in the last 30 days (reversed = approved and later reversed), so the numbers always match the records.
 */
function withSimilar(orgId: string, all: Approval[], a: Approval): Approval {
  const since = Date.now() - 30 * 86_400_000;
  const reversed = approvalsExt(orgId).reversals;
  const same = all.filter((x) => x.ruleId === a.ruleId && x.id !== a.id && x.decidedAt && new Date(x.decidedAt).getTime() >= since);
  return { ...a, similar: {
    approved: same.filter((x) => x.status === 'approved' || x.status === 'approved_run_failed').length,
    rejected: same.filter((x) => x.status === 'rejected').length,
    reversed: same.filter((x) => reversed[x.id]).length,
  } };
}

const wait =(min = 90, max = 260) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const copy = <T,>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

/**
 * Server-side permission check for a mutation: the caller's role is the one their member record holds in this
 * organisation now (a suspended, removed or demoted person loses it at once), checked against lib/permissions.
 */
function requirePerm(orgId: string, userId: string, perm: Permission, what: string) {
  const role = db.memberRole(orgId, userId);
  if (!can(role, perm)) throw new Error(`${what} — ${role ? `${ROLE_INFO[role].label}s cannot do this` : 'you hold no active role in this organisation'}.`);
  // read-only after a pilot's hard stop: refused before anything changes (exports and the emergency stop still work)
  assertPilotWritable(orgId, userId, perm.startsWith('evidence.') || perm.startsWith('stop.') ? perm : 'write');
  return role!;
}

/** The caller must be an owner or admin of the organisation (level features: keys, custody). */
function requireOwnerOrAdmin(orgId: string, userId: string, what: string) {
  const role = db.memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what} — owners and admins can do this; your role cannot.`);
  assertPilotWritable(orgId, userId, 'write');
  return role;
}

/** Test on past actions was refused because the organisation switched the replay store off (Settings › Data). */
export class ReplayStoreOffError extends Error {
  readonly code = 'replay_store_off' as const;
  constructor(public switchedOffAt?: string) {
    super(`The replay store is off for this organisation${switchedOffAt ? ` (switched off ${new Date(switchedOffAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })})` : ''}, so no past arguments are kept to replay. Nothing was tested. An owner or admin can switch it on in Assurance › Exports › Data and retention; calls made after that can be tested.`);
    this.name = 'ReplayStoreOffError';
  }
}

export interface ReceiptQuery {
  agent?: string;
  decision?: Decision | 'all';
  kind?: ReceiptKind | 'all';
  tool?: string;
  q?: string;
  from?: number; // ms
  to?: number;
  limit?: number;
}

/** The organisation's current level without building its database. */
function levelOfId(orgId: string): LevelId {
  return levelOfOrg(db.peekDB(orgId)?.org ?? ORGS.find((o) => o.id === orgId));
}

export const api = {
  /* L1 → L2 upgrade close-out (api/upgradeCloseout.ts) */
  ...upgradeCloseoutApi,
  /* L3 extras: disclosure profiles and bundles, first-issue warning, acceptance, revoke, dispute, autonomy breaches (api/l3extras.ts) */
  ...l3ExtrasApi,
  /* pack factory: portfolio, tests, pilot, reconciliation, profile lifecycle and entitlement (api/packsFactory.ts) */
  ...packsFactoryApi,

  /* auth (mocked) */
  async signIn(email: string, password: string) {
    await wait(300, 600);
    const acct = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
    if (!acct || acct.password !== password) throw new Error('That email and password do not match a demo account.');
    const user = userById(acct.userId);
    if (!user) throw new Error('That email and password do not match a demo account.');
    // sign-in is refused when the person holds no active membership in any of their organisations (suspended or removed)
    if (user.orgIds.length && !user.orgIds.some((o) => !!db.memberRole(o, user.id))) throw new Error('This account is suspended or was removed from its organisation. Ask an owner to reinstate it.');
    return copy(user);
  },

  orgs(orgIds: string[]) {
    return ORGS.filter((o) => orgIds.includes(o.id));
  },

  /* today */
  async today(orgId: string) {
    await wait();
    db.expireDue(orgId);
    const d = db.getDB(orgId);
    const startOfDay = (() => { const t = new Date(Date.now() + 5.5 * 3.6e6); t.setUTCHours(0, 0, 0, 0); return t.getTime() - 5.5 * 3.6e6; })();
    const todays = d.receipts.filter((r) => r.kind === 'decision' && new Date(r.ts).getTime() >= startOfDay);
    const last24 = d.receipts.filter((r) => r.kind === 'decision' && Date.now() - new Date(r.ts).getTime() < 864e5);
    const prev24 = d.receipts.filter((r) => r.kind === 'decision' && Date.now() - new Date(r.ts).getTime() >= 864e5 && Date.now() - new Date(r.ts).getTime() < 2 * 864e5);
    const byHour: { hour: string; allow: number; ask: number; refuse: number }[] = [];
    for (let i = 23; i >= 0; i--) {
      const end = Date.now() - i * 3.6e6;
      const rs = d.receipts.filter((r) => r.kind === 'decision' && new Date(r.ts).getTime() <= end && new Date(r.ts).getTime() > end - 3.6e6);
      byHour.push({ hour: new Date(end).toISOString(), allow: rs.filter((r) => r.decision === 'allow').length, ask: rs.filter((r) => r.decision === 'ask').length, refuse: rs.filter((r) => r.decision === 'refuse').length });
    }
    return copy({
      counts: {
        today: { allow: todays.filter((r) => r.decision === 'allow').length, ask: todays.filter((r) => r.decision === 'ask').length, refuse: todays.filter((r) => r.decision === 'refuse').length },
        last24: { total: last24.length, allow: last24.filter((r) => r.decision === 'allow').length, ask: last24.filter((r) => r.decision === 'ask').length, refuse: last24.filter((r) => r.decision === 'refuse').length },
        prev24: { total: prev24.length, refuse: prev24.filter((r) => r.decision === 'refuse').length },
      },
      byHour,
      pending: d.approvals.filter((a) => a.status === 'pending').sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
      openAlerts: d.alerts.filter((a) => a.status !== 'resolved'),
      activeIncidents: d.incidents.filter((i) => i.status === 'active'),
      head: d.receipts[d.receipts.length - 1],
      lastCheckpoint: d.checkpoints[d.checkpoints.length - 1],
      agents: d.agents,
      frameworks: d.frameworks.filter((f) => f.enabled),
      recent: d.receipts.slice(-12).reverse(),
      suggestions: d.suggestions.filter((s) => s.status !== 'dismissed'),
      stop: d.stop,
    });
  },

  /* receipts */
  async receipts(orgId: string, q: ReceiptQuery = {}) {
    await wait(60, 180);
    const d = db.getDB(orgId);
    const needle = q.q?.trim().toLowerCase();
    let rs = d.receipts.filter((r) =>
      (!q.agent || r.agent === q.agent) &&
      (!q.decision || q.decision === 'all' || r.decision === q.decision) &&
      (!q.kind || q.kind === 'all' || r.kind === q.kind) &&
      (!q.tool || r.tool === q.tool) &&
      (!q.from || new Date(r.ts).getTime() >= q.from) &&
      (!q.to || new Date(r.ts).getTime() <= q.to) &&
      (!needle || String(r.seq) === needle.replace('#', '').replace(/,/g, '') || r.hash.startsWith(needle) || JSON.stringify(r).toLowerCase().includes(needle)),
    );
    rs = rs.slice().reverse();
    return copy({ total: rs.length, items: q.limit ? rs.slice(0, q.limit) : rs });
  },

  async receipt(orgId: string, seq: number) {
    await wait(60, 160);
    const d = db.getDB(orgId);
    const i = d.receipts.findIndex((r) => r.seq === seq);
    if (i < 0) throw new Error(`No receipt #${seq} in this organisation.`);
    const r = d.receipts[i];
    const related = d.receipts.filter((x) => x.ref_seq === r.seq || (r.ref_seq && (x.seq === r.ref_seq || x.ref_seq === r.ref_seq) && x.seq !== r.seq));
    const checkpoint = d.checkpoints.find((c) => c.seq >= r.seq);
    const rb = d.rulebooks.find((b) => b.slug === r.agent);
    const version = rb?.versions.find((v) => v.version === r.rulebook?.version);
    const rule = version?.rules.find((x) => x.id === r.rule_id);
    const approval = r.approval ? d.approvals.find((a) => a.id === r.approval!.id) : undefined;
    return copy({ receipt: r, prev: d.receipts[i - 1], next: d.receipts[i + 1], related, checkpoint, rulebook: rb ? { id: rb.id, slug: rb.slug, version } : undefined, rule, approval, publicKey: d.publicKeys[r.kid] });
  },

  chainSlice(orgId: string, fromSeq?: number, toSeq?: number) {
    const d = db.getDB(orgId);
    return copy({ receipts: d.receipts.filter((r) => (fromSeq === undefined || r.seq >= fromSeq) && (toSeq === undefined || r.seq <= toSeq)), checkpoints: d.checkpoints, publicKeys: d.publicKeys });
  },

  /* approvals */
  async approvals(orgId: string) {
    await wait();
    db.expireDue(orgId); // expiry runs for every organisation, live tick or not
    const d = db.getDB(orgId);
    return copy(d.approvals.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((a) => withSimilar(orgId, d.approvals, a)));
  },
  /** One approval with its receipts, agent and history. `id` may also be a single-use link token (lnk.…). */
  async approval(orgId: string, id: string) {
    await wait(60, 160);
    if (id.startsWith('lnk.')) {
      const link = platform.resolveApprovalLink(id);
      orgId = link.orgId;
      id = link.approvalId;
    }
    db.expireDue(orgId);
    const d = db.getDB(orgId);
    const a = d.approvals.find((x) => x.id === id);
    if (!a) throw new Error('This approval does not exist or belongs to another organisation.');
    const receipts = d.receipts.filter((r) => r.seq === a.seq || r.seq === a.resultSeq);
    const agent = d.agents.find((x) => x.slug === a.agentSlug);
    const history = d.approvals.filter((x) => x.ruleId === a.ruleId && x.id !== a.id && x.status !== 'pending').slice(-6).reverse();
    return copy({ approval: withSimilar(orgId, d.approvals, a), receipts, agent, history });
  },
  async decide(orgId: string, id: string, approve: boolean, userId: string, reason: string, channel: Channel = 'web') {
    await wait(250, 500);
    return copy(db.decideApproval(orgId, id, approve, userId, reason, channel));
  },
  /** Re-route a waiting approval to another approver group (owners and admins; the person who re-routes it does not then decide it as a member of that group). */
  async reroute(orgId: string, id: string, group: string, userId: string) {
    await wait();
    return copy(db.reroute(orgId, id, group, userId));
  },
  /** Extend a waiting approval once, by 24 hours, with a declared reason (recorded on the chain). */
  async extendApproval(orgId: string, id: string, reason: string, userId: string) {
    await wait();
    return copy(db.extendApproval(orgId, id, reason, userId));
  },

  /* agents */
  async agents(orgId: string) {
    await wait();
    return copy(db.getDB(orgId).agents);
  },
  async agent(orgId: string, slug: string) {
    await wait(60, 160);
    const d = db.getDB(orgId);
    const a = d.agents.find((x) => x.slug === slug);
    if (!a) throw new Error(`No agent called ${slug}.`);
    const receipts = d.receipts.filter((r) => r.agent === slug).slice(-200).reverse();
    return copy({ agent: a, rulebook: d.rulebooks.find((r) => r.id === a.rulebookId), receipts, alerts: d.alerts.filter((x) => x.agentSlug === slug), aiSystem: d.aiSystems.find((s) => s.id === a.aiSystemId || s.linkedAgentId === a.id), connectors: d.connectors.filter((c) => a.connectorIds.includes(c.id)), approvals: d.approvals.filter((x) => x.agentSlug === slug).slice(-20).reverse() });
  },
  async setAgentStatus(orgId: string, slug: string, status: 'active' | 'paused', userId: string, reason?: string) {
    await wait(200, 400);
    requirePerm(orgId, userId, 'agents.pause', status === 'paused' ? 'Pausing an agent' : 'Resuming an agent');
    return copy(db.setAgentStatus(orgId, slug, status, userId, reason));
  },
  async createAgent(orgId: string, input: Parameters<typeof db.createAgent>[1], userId: string) {
    await wait(400, 800);
    requirePerm(orgId, userId, 'agents.manage', 'Adding an agent');
    return copy(db.createAgent(orgId, input, userId));
  },
  async revokeKey(orgId: string, slug: string, keyId: string, userId: string) {
    await wait();
    requirePerm(orgId, userId, 'agents.keys', 'Revoking an agent key');
    const a = db.getDB(orgId).agents.find((x) => x.slug === slug);
    if (!a) throw new Error(`No agent called ${slug}.`);
    const k = a.keys.find((x) => x.id === keyId);
    if (!k) throw new Error('That key does not exist on this agent.');
    if (k.revoked) throw new Error('That key is already revoked.');
    k.revoked = true;
    db.logAdmin(orgId, userId, 'key.revoked', { agent: slug, key: k.prefix }, slug);
    return copy(a);
  },
  async issueKey(orgId: string, slug: string, label: string, environment: 'sandbox' | 'production', userId: string) {
    await wait(300, 500);
    requirePerm(orgId, userId, 'agents.keys', 'Issuing an agent key');
    // a production key (gk_) is never issued directly: it is asked for, reviewed by a person, then collected (mock/devpath.ts collectKey)
    if (environment === 'production') throw new Error('A production key (gk_) is not issued directly. Ask for one in Agents › Path to production; a person reviews it within 2 working days.');
    const a = db.getDB(orgId).agents.find((x) => x.slug === slug);
    if (!a) throw new Error(`No agent called ${slug}.`);
    const secret = `${environment === 'sandbox' ? 'sk_sbx_' : 'gk_'}${Array.from(crypto.getRandomValues(new Uint8Array(18))).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    a.keys.unshift({ id: `key_${Date.now()}`, prefix: secret.slice(0, 12), label, createdAt: new Date().toISOString(), environment });
    db.logAdmin(orgId, userId, 'key.issued', { agent: slug, environment }, slug);
    return { agent: copy(a), secret };
  },

  /* rulebooks */
  async rulebooks(orgId: string) {
    await wait();
    recordsApi.ensureSeed(orgId); // the seeded withdrawn versions show wherever rulebooks are read (mock/records.ts)
    const d = db.getDB(orgId);
    return copy(d.rulebooks.map((rb) => ({ ...rb, agent: d.agents.find((a) => a.id === rb.agentId), suggestions: d.suggestions.filter((s) => s.rulebookId === rb.id && s.status !== 'dismissed').length })));
  },
  async rulebook(orgId: string, slug: string) {
    await wait(60, 160);
    recordsApi.ensureSeed(orgId); // the seeded withdrawn versions show on the Versions tab too (mock/records.ts)
    const d = db.getDB(orgId);
    const rb = d.rulebooks.find((r) => r.slug === slug);
    if (!rb) throw new Error(`No rulebook for ${slug}.`);
    return copy({ rulebook: rb, agent: d.agents.find((a) => a.id === rb.agentId), suggestions: d.suggestions.filter((s) => s.rulebookId === rb.id) });
  },
  async suggestions(orgId: string) {
    await wait();
    return copy(db.getDB(orgId).suggestions);
  },
  async setSuggestion(orgId: string, id: string, status: 'drafted' | 'dismissed', userId: string) {
    await wait();
    requirePerm(orgId, userId, 'rulebooks.edit', status === 'dismissed' ? 'Dismissing a suggestion' : 'Drafting a suggestion');
    const s = db.getDB(orgId).suggestions.find((x) => x.id === id);
    if (!s) throw new Error('This suggestion no longer exists.');
    s.status = status;
    db.logAdmin(orgId, userId, status === 'dismissed' ? 'suggestion.dismissed' : 'suggestion.drafted', { suggestion: id });
    return copy(s);
  },
  /**
   * Decide a made-up call under `rules`. Quotas are counted: with `ctx`, against that agent's recorded decisions in
   * the window (as the live guard counts them); without it, against this call alone, so a single call over a
   * max_sum limit is still held.
   */
  tryAction(rules: Rule[], tool: string, args: Record<string, unknown>, ctx?: { orgId: string; agentSlug: string }) {
    const since = Date.now() - 8 * 864e5;
    const history = ctx ? db.getDB(ctx.orgId).receipts.filter((r) => r.agent === ctx.agentSlug && r.kind === 'decision' && new Date(r.ts).getTime() >= since) : [];
    return evaluate(rules, tool, args, undefined, { history });
  },
  /**
   * Test on past actions: re-decide this agent's past calls under draft rules. Replays the replay store, so it
   * respects Settings › Data: with the store switched off there are no stored arguments and the test is refused
   * with ReplayStoreOffError (a sentence the Rulebook's Test tab shows in its "The test did not run" banner).
   * After the store is switched back on, only calls made since then can be replayed.
   */
  async testOnPast(orgId: string, agentSlug: string, rules: Rule[], days: 7 | 30) {
    await wait(500, 900);
    const d = db.getDB(orgId);
    if (!replayOnOf(d)) throw new ReplayStoreOffError(d.orgSettings?.replay.changedAt);
    const since = replaySinceOf(d);
    const from = Math.max(Date.now() - days * 864e5, since ? new Date(since).getTime() : 0);
    const mine = d.receipts.filter((r) => r.agent === agentSlug);
    // decisions in the 8 days before the range can start a quota window that the range runs into
    const prior = mine.filter((r) => { const t = new Date(r.ts).getTime(); return t < from && t >= from - 8 * 864e5; });
    return replay(mine.filter((r) => new Date(r.ts).getTime() >= from), rules, prior);
  },
  async saveDraft(orgId: string, rulebookId: string, yaml: string, rules: Rule[], note: string, userId: string) {
    await wait(200, 400);
    requirePerm(orgId, userId, 'rulebooks.edit', 'Saving a rulebook draft');
    return copy(db.saveDraft(orgId, rulebookId, yaml, rules, note, userId));
  },
  /** Sign and publish. From L2 the text must be exactly the draft a different person reviewed (dual control). */
  async publish(orgId: string, rulebookId: string, yaml: string, rules: Rule[], note: string, userId: string, reviewerId?: string) {
    await wait(500, 900);
    requirePerm(orgId, userId, 'rulebooks.publish', 'Publishing a rulebook');
    return copy(db.publishRulebook(orgId, rulebookId, yaml, rules, note, userId, reviewerId));
  },

  /* connectors */
  async connectors(orgId: string) {
    await wait();
    return copy(db.getDB(orgId).connectors);
  },
  async setToolEnabled(orgId: string, connectorId: string, tool: string, enabled: boolean, userId: string) {
    await wait(120, 260);
    requirePerm(orgId, userId, 'connectors.manage', enabled ? 'Switching a tool on' : 'Switching a tool off');
    const c = db.getDB(orgId).connectors.find((x) => x.id === connectorId);
    if (!c) throw new Error('This connector no longer exists in this organisation.');
    const t = c.tools.find((x) => x.name === tool);
    if (!t) throw new Error(`No tool ${tool} on ${c.name}.`);
    t.enabled = enabled;
    db.logAdmin(orgId, userId, enabled ? 'tool.enabled' : 'tool.disabled', { connector: c.name, tool });
    return copy(c);
  },
  async addUpstream(orgId: string, name: string, url: string, userId: string) {
    await wait(800, 1400);
    requirePerm(orgId, userId, 'connectors.manage', 'Connecting an MCP server');
    const d = db.getDB(orgId);
    const c = {
      id: `con_${Date.now().toString(36)}`, kind: 'mcp_upstream' as const, name, status: 'connected' as const, mode: 'live' as const, url, authHeader: 'Authorization: Bearer ••••••••' + Math.random().toString(16).slice(2, 6),
      connectedAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), heldCredential: true,
      tools: [
        { name: 'crm.search_accounts', description: 'Search customer accounts', tags: [], suggestedTags: ['reads_data' as const], enabled: false, calls7d: 0 },
        { name: 'crm.update_opportunity', description: 'Update an opportunity stage and value', tags: [], suggestedTags: ['writes_data' as const], enabled: false, calls7d: 0 },
        { name: 'crm.export_contacts', description: 'Export contacts as CSV', tags: [], suggestedTags: ['reads_data' as const, 'personal_data' as const, 'sends_external' as const], enabled: false, calls7d: 0 },
      ],
    };
    d.connectors.push(c);
    db.logAdmin(orgId, userId, 'connector.added', { connector: name, tools: c.tools.length, enabled: 0 });
    return copy(c);
  },
  /** The tool catalogue. With an organisation: the shared catalogue with that organisation's own tools and tags over it. */
  tools(orgId?: string) {
    return orgId ? db.orgToolDefs(orgId) : TOOLS;
  },

  /* evidence */
  async evidence(orgId: string) {
    await wait();
    const d = db.getDB(orgId);
    return copy({ head: d.receipts[d.receipts.length - 1], first: d.receipts[0], total: d.receipts.length, checkpoints: d.checkpoints.slice().reverse(), exports: d.exports, signingKeys: d.signingKeys, publicKeys: d.publicKeys, org: d.org });
  },
  /** Sign a checkpoint over the chain head now. Pass the person: owners and admins sign checkpoints on demand. */
  async signCheckpoint(orgId: string, userId: string) {
    await wait(300, 600);
    requirePerm(orgId, userId, 'evidence.checkpoint', 'Signing a checkpoint');
    return copy(db.signCheckpointNow(db.getDB(orgId)));
  },
  /**
   * Export evidence for a range. L1: the auditor pack (auditor-pack/1). L2 and above: the 8-member evidence
   * bundle (elan1.evidence.bundle.v1 — manifest, receipts, seals, checkpoints, anchors, keys, declarations,
   * profile + VERIFY.txt), a superset of the L1 pack. `profileId` claims a verifier profile ('none' or omitted: no claim).
   * Returns { bundle, json, export } and writes an evidence.exported receipt.
   */
  async exportPack(orgId: string, userId: string, fromSeq?: number, toSeq?: number, profileId?: string, opts?: evidenceMock.ExportOptions) {
    await wait(700, 1300);
    requirePerm(orgId, userId, 'evidence.export', 'Exporting evidence');
    if (levelOfId(orgId) !== 'l1') packsFactory.guardClaim(orgId, profileId); // claiming a profile needs an order (mock/packsFactory.ts)
    // L2+: size, range, residency, consent and declarations are enforced here, whichever screen asked (mock/evidenceGuards.ts)
    evidenceGuards.assertExportAllowed(db.getDB(orgId), fromSeq, toSeq, opts);
    return db.exportAuditorPack(orgId, userId, fromSeq, toSeq, profileId, opts);
  },
  /** Build the pack or bundle an export would produce, without writing anything (for "Verify it yourself first"). */
  async previewPack(orgId: string, userId: string, fromSeq?: number, toSeq?: number, profileId?: string, opts?: evidenceMock.ExportOptions) {
    await wait(200, 400);
    requirePerm(orgId, userId, 'evidence.export', 'Checking an export');
    if (levelOfId(orgId) !== 'l1') packsFactory.guardClaim(orgId, profileId);
    const d = db.getDB(orgId);
    return levelOfOrg(d.org) === 'l1' ? evidenceMock.buildAuditorPack(d, userId, fromSeq, toSeq, opts) : platform.buildEvidenceBundle(d, userId, fromSeq, toSeq, profileId, opts);
  },
  /** Nightly and on-demand integrity runs, newest first, with the continuity report. */
  async integrityRuns(orgId: string) {
    await wait();
    const d = db.getDB(orgId);
    return copy(evidenceMock.continuityReport(d));
  },
  /**
   * Run the integrity check over the whole window now (hashes, links, signatures, checkpoints); writes an
   * evidence.integrity_run receipt. `outcome` is the result of the same check run in the verifier's worker.
   */
  async runIntegrity(orgId: string, userId: string, outcome?: evidenceMock.IntegrityOutcome): Promise<evidenceMock.IntegrityRun & { readOnly?: boolean }> {
    await wait(300, 600);
    const role = requirePerm(orgId, userId, 'evidence.export', 'Running an integrity check');
    // an auditor is read-only on the client's chain: their check is shown to them and nothing is written, so it does
    // not count as a completed run for an export (an owner or admin runs that one)
    if (role === 'auditor') {
      if (!outcome) throw new Error('An auditor’s integrity check runs in this browser and is not written to the client’s chain. Run it from Assurance › Proof › Integrity runs.');
      const ok = outcome.brokenAt === undefined && outcome.checkpointsValid === outcome.checkpoints;
      return {
        id: `ir_ro_${Date.now().toString(36)}`, at: new Date().toISOString(), kind: 'on_demand', by: userId, fromSeq: outcome.fromSeq, toSeq: outcome.toSeq, records: outcome.records,
        checked: { links: Math.max(0, outcome.records - 1), hashes: outcome.hashes, signatures: outcome.signatures, checkpoints: outcome.checkpoints },
        result: ok ? 'pass' : 'fail', brokenAt: outcome.brokenAt, reason: outcome.reason ?? (outcome.checkpointsValid !== outcome.checkpoints ? `${outcome.checkpoints - outcome.checkpointsValid} checkpoints do not match` : undefined), ms: outcome.ms, readOnly: true,
      };
    }
    return copy(evidenceMock.runIntegrityNow(orgId, userId, outcome));
  },
  /** Rotate the signing key at L1 (owners and admins, the same people who run key ceremonies). From L2 use runKeyCeremony. */
  async rotateKey(orgId: string, userId: string) {
    await wait(500, 900);
    requireOwnerOrAdmin(orgId, userId, 'Rotating the signing key');
    if (db.getDB(orgId).org.plan !== 'l1') throw new Error('From L2 the signing key is rotated in its custody (AWS KMS or your HSM), through a key ceremony.');
    assertKeyChangeAllowed(orgId, userId, 'rotate the signing key'); // refused (and recorded) while a chain incident is open
    db.rotateKey(orgId, userId);
  },

  /* governance */
  async inventory(orgId: string) {
    await wait();
    const d = db.getDB(orgId);
    return copy(d.aiSystems.map((s) => ({ ...s, assessments: d.assessments.filter((a) => a.aiSystemId === s.id), agent: d.agents.find((a) => a.id === s.linkedAgentId) })));
  },
  async aiSystem(orgId: string, id: string) {
    await wait(60, 160);
    const d = db.getDB(orgId);
    const s = d.aiSystems.find((x) => x.id === id);
    if (!s) throw new Error('No such AI system.');
    const agent = d.agents.find((a) => a.id === s.linkedAgentId);
    return copy({ system: s, assessments: d.assessments.filter((a) => a.aiSystemId === id), agent, receipts: agent ? d.receipts.filter((r) => r.agent === agent.slug).slice(-10).reverse() : [], frameworks: d.frameworks.filter((f) => s.frameworks.includes(f.id)) });
  },
  async addAiSystem(orgId: string, sys: Omit<import('@/types').AiSystem, 'id' | 'createdAt' | 'riskTier'>, userId: string) {
    await wait(200, 400);
    requirePerm(orgId, userId, 'inventory.manage', 'Registering an AI system');
    const d = db.getDB(orgId);
    const s = { ...sys, id: `ai_${Date.now().toString(36)}`, createdAt: new Date().toISOString(), riskTier: 'unassessed' as const };
    d.aiSystems.unshift(s);
    // the model it runs on is recorded on the registration receipt itself when one is given
    db.logAdmin(orgId, userId, 'inventory.added', { system: s.name, ...(s.modelName ? { model: s.modelName, version: s.modelVersion || 'Not recorded' } : {}) });
    return copy(s);
  },
  async assessments(orgId: string) {
    await wait();
    const d = db.getDB(orgId);
    return copy(d.assessments.map((a) => ({ ...a, system: d.aiSystems.find((s) => s.id === a.aiSystemId) })));
  },
  async assessment(orgId: string, id: string) {
    await wait(60, 160);
    const d = db.getDB(orgId);
    const a = d.assessments.find((x) => x.id === id);
    if (!a) throw new Error('No such assessment.');
    return copy({ assessment: a, system: d.aiSystems.find((s) => s.id === a.aiSystemId) });
  },
  /**
   * Sign off (or send back) a submitted assessment. One implementation for every screen: the assessments backend
   * (assessments.signoff, a different person from the author, a note, pack-admission gates, the next review date).
   */
  async reviewAssessment(orgId: string, id: string, approve: boolean, userId: string, note: string) {
    const { reviewAssessment } = await import('@/features/assessments/backend');
    const res = await reviewAssessment(orgId, id, approve, note, userId);
    return copy(res.assessment);
  },
  async compliance(orgId: string) {
    await wait();
    const d = db.getDB(orgId);
    return copy({ frameworks: d.frameworks, controls: d.controls });
  },
  async setFramework(orgId: string, id: string, enabled: boolean, userId: string) {
    await wait();
    requirePerm(orgId, userId, 'compliance.manage', enabled ? 'Enabling a framework' : 'Switching a framework off');
    const f = db.getDB(orgId).frameworks.find((x) => x.id === id);
    if (!f) throw new Error('There is no such framework.');
    f.enabled = enabled;
    db.logAdmin(orgId, userId, enabled ? 'framework.enabled' : 'framework.disabled', { framework: f.short });
    return copy(f);
  },

  /* respond */
  async alerts(orgId: string) {
    await wait();
    return copy(db.getDB(orgId).alerts);
  },
  async setAlertStatus(orgId: string, id: string, status: 'acknowledged' | 'resolved', userId: string) {
    await wait();
    requirePerm(orgId, userId, 'alerts.respond', status === 'resolved' ? 'Resolving an alert' : 'Acknowledging an alert');
    const a = db.getDB(orgId).alerts.find((x) => x.id === id) as (import('@/types').Alert & { resolvedBy?: string }) | undefined;
    if (!a) throw new Error('There is no alert with this id in this organisation.');
    if (a.status === 'resolved') throw new Error('This alert is already resolved.');
    a.status = status;
    if (status === 'acknowledged') a.acknowledgedBy = userId;
    else { a.resolvedAt = new Date().toISOString(); a.resolvedBy = userId; }
    db.logAdmin(orgId, userId, `alert.${status}`, { alert: id, detector: a.detector }, a.agentSlug);
    return copy(a);
  },
  async incidents(orgId: string) {
    await wait();
    return copy(db.getDB(orgId).incidents);
  },
  async stopPreview(orgId: string) {
    await wait(60, 120);
    const d = db.getDB(orgId);
    return copy({ agents: d.agents.filter((a) => a.status === 'active'), pending: d.approvals.filter((a) => a.status === 'pending').length });
  },
  /** Engage the emergency stop (owners and admins). Only one stop is open at a time. */
  async engageStop(orgId: string, userId: string, reason: string, slugs?: string[]) {
    await wait(400, 700);
    requirePerm(orgId, userId, 'stop.engage', 'Engaging the emergency stop');
    return copy(db.engageStop(orgId, userId, reason, slugs));
  },
  /** Widen an engaged selected-agents stop: add agents (`slugs`) or cover every agent (none). One owner or admin; writes stop.widened. */
  async widenStop(orgId: string, userId: string, reason: string, slugs?: string[]) {
    await wait(300, 500);
    requirePerm(orgId, userId, 'stop.engage', 'Widening the emergency stop');
    return copy(db.widenStop(orgId, userId, reason, slugs));
  },
  /** Lift the stop. At L1 one owner or admin lifts it; from L2 a lift needs a second person (ops.requestLift → ops.approveLift). */
  async liftStop(orgId: string, userId: string, note: string) {
    await wait(400, 700);
    requirePerm(orgId, userId, 'stop.engage', 'Lifting the emergency stop');
    if (ops.liftNeedsSecond(orgId)) throw new Error('Dual control: from L2 a lift needs a second owner or admin. Ask to lift the stop; a different owner or admin approves it.');
    db.liftStop(orgId, userId, note);
  },
  /** Stop lifts, emergency access and approver samples: dual-control requests and their decisions (src/mock/ops.ts). */
  ops,
  /** Consent ledger, erasure plans, declaration withdrawal, gap records, model documentation, hosting profiles (src/mock/records.ts). */
  records: recordsApi,

  /* account */
  async billing(orgId: string) {
    await wait();
    const d = db.getDB(orgId);
    db.deriveBilling(d); // the draft month picks up bundles exported and profiles ordered since; issued invoices are kept
    return copy({ plan: PLANS[d.org.plan], plans: Object.values(PLANS), usage: d.usage, invoices: d.invoices });
  },
  /** Disputes (owners only, checked here as well as on screen) and the demo elan1 billing desk (mock/billing.ts). Each writes a receipt. */
  async openDispute(orgId: string, userId: string, input: { invoice: string; line: string; reason: string; fromSeq?: number; toSeq?: number }) { await wait(200, 400); return copy(billingMock.openDispute(orgId, userId, input)); },
  async withdrawDispute(orgId: string, userId: string, disputeSeq: number) { await wait(200, 400); return copy(billingMock.withdrawDispute(orgId, userId, disputeSeq)); },
  billingDesk: {
    async settleDispute(orgId: string, userId: string, input: Parameters<typeof billingMock.deskSettleDispute>[2]) { await wait(200, 400); return copy(billingMock.deskSettleDispute(orgId, userId, input)); },
    async decideDiscountRequest(orgId: string, userId: string, input: Parameters<typeof billingMock.deskDecideDiscountRequest>[2]) { await wait(200, 400); return copy(billingMock.deskDecideDiscountRequest(orgId, userId, input)); },
    async decideReopen(orgId: string, userId: string, input: Parameters<typeof billingMock.deskDecideReopen>[2]) { await wait(200, 400); return copy(billingMock.deskDecideReopen(orgId, userId, input)); },
  },
  async members(orgId: string) {
    await wait();
    const d = db.getDB(orgId);
    return copy(d.members.map((m) => ({ ...m, user: USERS.find((u) => u.id === m.userId) })));
  },
  async webhooks(orgId: string) {
    await wait();
    return copy(db.getDB(orgId).webhooks);
  },
  org(orgId: string) {
    return db.getDB(orgId).org;
  },

  /* ═══ Assurance levels ═══════════════════════════════════════════════ */

  /** Sync: the organisation's current level ('l1' | 'l2' | 'l3' | 'sovereign'). Cheap; safe in render. */
  levelOf(orgId: string): LevelId {
    return levelOfId(orgId);
  },

  /** Sync: does the organisation's level include this capability? (see lib/levels CAPABILITIES) */
  can(orgId: string, cap: Parameters<typeof hasCapability>[1]): boolean {
    return hasCapability(levelOfId(orgId), cap);
  },

  /**
   * The organisation's level. Returns LevelState:
   * { orgId, level, plan, deployment, residency, history: [{level, from, by?, seq?}], since,
   *   boundaries: [{from, to, at, firstSeq?, recordsBefore, recordsAfter, beforeWindow}],
   *   capabilities: (Capability & {enabled, since?})[], next? }
   */
  async level(orgId: string) {
    await wait(60, 140);
    return copy(platform.levelState(orgId));
  },

  /** Capabilities the organisation has now: { level, all: Capability[] with enabled, enabled: Capability[] }. */
  async capabilities(orgId: string) {
    await wait(40, 100);
    const level = levelOfId(orgId);
    return copy({ level, all: CAPABILITIES.map((c) => ({ ...c, enabled: hasCapability(level, c.id) })), enabled: capabilitiesFor(level) });
  },

  /**
   * What moving to `to` means. Returns UpgradePlan:
   * { orgId, from, to, allowed, whyNot?, adds: Capability[], priceBefore, priceAfter, floorDifference, steps: UpgradeStep[], boundaryNote }.
   */
  async upgradePlan(orgId: string, to: LevelId, userId?: string) {
    await wait(80, 180);
    return copy(platform.upgradePlan(orgId, to, userId));
  },

  /**
   * Move the organisation up a level (owner only; never down). Records level.upgraded and the boundary,
   * moves signing into KMS (L2) or a customer HSM key ceremony (L3/Sovereign), and starts every agent write
   * type at autonomy A2 Propose when crossing into L3 (A3 only by graduation). Returns the new LevelState.
   */
  async upgradeLevel(orgId: string, to: LevelId, userId: string) {
    await wait(700, 1200);
    return copy(platform.upgradeLevel(orgId, to, userId));
  },

  /* ═══ L2: seals, anchors, custody, verifier, profiles ════════════════ */

  /**
   * Seal v6 for one receipt. Returns either
   * { sealed: true, receipt, seal: SealRecord, check: {structure, digest, signature, binding}, fieldsDoc, payloadUnbound, level }
   * or { sealed: false, receipt, level, boundary?, reason, fieldsDoc } for receipts before the L2 boundary.
   */
  async seal(orgId: string, seq: number) {
    await wait(60, 140);
    return copy(platform.sealView(orgId, seq));
  },

  /** The 64 Seal v6 test vectors run in this browser (TypeScript) with the recorded Python results. Returns TestVectorSuite. */
  async testVectors() {
    await wait(200, 400);
    return copy(platform.testVectors());
  },

  /**
   * Merkle batches and RFC 3161 timestamps. Returns AnchorsView:
   * { orgId, enabled, level, since?, authorities: TsaAuthority[], batches: AnchorBatch[] (newest first),
   *   totals: {batches, anchoredRecords, unanchoredTail, lastAnchoredSeq?, headSeq, withinTargetPct, targetMinutes}, incidents: AnchorIncident[] }.
   */
  async anchors(orgId: string, limit = 60) {
    await wait(120, 260);
    return copy(platform.anchorsView(orgId, limit));
  },
  /**
   * "Anchor now" (owners and admins, L2+): timestamp every sealed record after the last timestamped batch, by both
   * authorities, and record it as anchor.on_demand. An export then carries the batch in anchors.json.
   */
  async anchorNow(orgId: string, userId: string) {
    await wait(400, 700);
    requireOwnerOrAdmin(orgId, userId, 'Anchoring on demand');
    return copy(platform.anchorOnDemand(orgId, userId));
  },

  /** Inclusion proof for a sealed receipt. Returns InclusionProof { seq, receiptHash, leafHash, leafIndex, treeSize, batchId, root, path, tokens, verified }. Throws for L1 or unanchored receipts. */
  async inclusionProof(orgId: string, seq: number) {
    await wait(80, 180);
    return copy(platform.inclusionProof(orgId, seq));
  },

  /** Key custody. Returns KeyCustody { mode, provider, location, keyRef, alias?, heldBy, kid, fingerprint, rotation, quorum?, holders?, ceremonies, note }. */
  async custody(orgId: string) {
    await wait();
    return copy(platform.custodyView(orgId));
  },

  /**
   * Run a key ceremony (L3/Sovereign: at least 3 of 5 named holders), a KMS rotation (L2) or a recorded
   * rotation (L1). At L1 the key rotates at once (key.ceremony + key.rotated). From L2 the new key is published
   * as a successor with the 30-day overlap (key.ceremony + key.bound: "Key bound · signing off"); key.rotated
   * follows at the switch. Returns KeyCeremony (with switchAt from L2).
   *
   * `{ firstKey: true }` is for set-up only: the ceremony that creates an L3 or Sovereign organisation's first
   * customer-held key. That key signs at once (key.ceremony + key.rotated), because there is no earlier customer-held
   * key to overlap with, so no successor is left bound. Refused once the organisation already signs with its own key
   * (platform.firstKeyCeremonyBlock); every later rotation keeps the successor and the 30-day overlap.
   */
  async runKeyCeremony(orgId: string, userId: string, participantNames?: string[], opts: { firstKey?: boolean } = {}) {
    await wait(900, 1400);
    assertKeyChangeAllowed(orgId, userId, 'run a key ceremony'); // refused (and recorded) while a chain incident is open
    if (opts.firstKey) return copy(platform.runKeyCeremony(orgId, userId, participantNames, 'generation', { firstKey: true }));
    if (levelOfOrg(db.getDB(orgId).org) !== 'l1') return copy(ceremonySuccessor(orgId, userId, participantNames)) as ReturnType<typeof ceremonySuccessor>;
    return copy(platform.runKeyCeremony(orgId, userId, participantNames));
  },

  /**
   * Verify an evidence bundle (L2) or an L1 auditor pack, offline, in the browser.
   * Returns VerifyBundleResult { code, exitCode, label, headline, variants, sections: VerifySection[9], notes, limits,
   *   chain (L1 VerifyReport), profile?, counts, fingerprint, keySource, reproduction, ms }.
   */
  async verifyBundle(bundle: unknown, opts: VerifyBundleOptions = {}) {
    await wait(100, 200);
    return verifyBundle6(bundle, opts);
  },

  /** Verifier profiles: VerifierProfile[] each with { enabled (L2+), viaPack?, lastRun?: ProfileRunResult }. */
  async profiles(orgId: string) {
    await wait();
    packsFactory.ensureSeed(orgId);
    // each profile with this organisation's lifecycle (author, issuer, withdrawn) and its entitlement (order or L1 trial)
    return copy(platform.profilesView(orgId).map((p) => ({ ...packsFactory.decorateProfile(orgId, p), entitlement: packsFactory.entitlement(orgId, p.id) })));
  },

  /** Run a profile against the whole chain. Returns ProfileRunResult { result: pass|fail, rules: ProfileRuleResult[], digest, seq? }. Writes profile.run when userId is given. */
  async runProfile(orgId: string, profileId: string, userId?: string) {
    await wait(400, 800);
    packsFactory.ensureSeed(orgId);
    // the order (or the L1 trial) and the role are checked; L1 previews are never recorded
    const recordAs = packsFactory.guardRun(orgId, profileId, userId);
    const r = platform.runProfile(orgId, profileId, recordAs);
    return copy({ ...r, rules: [...r.rules, ...packsFactory.extraRuleResults(orgId, profileId, r.rules.map((x) => x.id))] });
  },

  /* ═══ L3: counterparties, cross-org receipts, disclosure ════════════ */

  /** Counterparty register: { enabled (L3+), seatPrice, counterparties: Counterparty[], seatsTotal }. */
  async counterparties(orgId: string) {
    await wait();
    prepareCrossOrg(orgId);
    return copy(platform.counterpartiesView(orgId));
  },

  /** Add a counterparty (owner/admin, L3+). Returns Counterparty; writes counterparty.added. */
  async addCounterparty(orgId: string, input: { name: string; kind: Counterparty['kind']; domain: string; seats: number; contact: string; keyFingerprint?: string }, userId: string) {
    await wait(300, 600);
    return copy(platform.addCounterparty(orgId, input, userId));
  },

  /**
   * Change a counterparty's verification seats (owner/admin, L3+; 1–50, never below the seats in use).
   * Writes counterparty.seats.changed and re-derives the invoices. Returns the Counterparty.
   */
  async setCounterpartySeats(orgId: string, counterpartyId: string, seats: number, userId: string) {
    await wait(300, 550);
    return copy(platform.setCounterpartySeats(orgId, counterpartyId, seats, userId));
  },

  /** Receipts issued to and received from counterparties: CrossOrgReceipt[]. Received ones from other demo organisations are verified for real. */
  async crossOrgReceipts(orgId: string) {
    await wait(150, 300);
    prepareCrossOrg(orgId);
    return copy(platform.crossOrgView(orgId));
  },

  /**
   * Issue a receipt to a counterparty revealing only `fields` (of the 11 committed). Returns { receipt: CrossOrgReceipt, disclosure: DisclosurePackage }.
   * The first issue to an audience is refused unless the caller showed the volume and reversal warning and passes
   * acknowledgeFirstIssue; the acknowledgement is recorded (counterparty.first_issue.acknowledged). See l3extras.ts.
   */
  async issueToCounterparty(orgId: string, seq: number, counterpartyId: string, fields: string[], userId: string, opts: { acknowledgeFirstIssue?: boolean; expiresDays?: number } = {}) {
    return l3ExtrasApi.issueToCounterpartyChecked(orgId, seq, counterpartyId, fields, userId, { acknowledgeFirstIssue: !!opts.acknowledgeFirstIssue, expiresDays: opts.expiresDays });
  },

  /** Re-verify a received receipt and bind it into this chain (counterparty.receipt.verified). Returns CrossOrgReceipt. */
  async verifyReceived(orgId: string, id: string, userId: string) {
    await wait(300, 600);
    requireOwnerOrAdmin(orgId, userId, 'Recording a received receipt');
    prepareCrossOrg(orgId);
    return copy(platform.verifyReceived(orgId, id, userId));
  },

  /** Disclosure packages issued by this organisation: DisclosurePackage[] (revealed fields only; salts of hidden fields are never returned). */
  async disclosures(orgId: string) {
    await wait();
    prepareCrossOrg(orgId); // seeded revocations withdraw their packages before the list is read
    return platform.disclosuresView(orgId);
  },

  /**
   * Create a disclosure package: commit all 11 fields, reveal `fields`. Returns DisclosurePackage with its portal token.
   * As issueToCounterparty, the first package to an audience needs acknowledgeFirstIssue (the warning was shown).
   */
  async createDisclosure(orgId: string, input: { seq: number; fields: string[]; audience: string; counterpartyId?: string; expiresDays?: number }, userId: string, opts: { acknowledgeFirstIssue?: boolean } = {}) {
    return l3ExtrasApi.createDisclosureChecked(orgId, input, userId, { acknowledgeFirstIssue: !!opts.acknowledgeFirstIssue });
  },

  /** Withdraw a disclosure package; its portal link stops working. */
  async revokeDisclosure(orgId: string, id: string, userId: string) {
    await wait();
    return platform.revokeDisclosure(orgId, id, userId);
  },

  /**
   * Public (no sign-in): the disclosure behind a counterparty portal token.
   * Returns { package: DisclosurePackage, issuer: {name, fingerprint, level}, counterparty?, check: {valid, steps, revealedCount, committedCount}, limits }.
   */
  async disclosureByToken(token: string) {
    await wait(200, 400);
    return copy(platform.disclosureByToken(token));
  },

  /* ═══ L3: earned autonomy ═══════════════════════════════════════════ */

  /*
   * Autonomy is graduation only: no call here takes a level. Every write type starts at A2 Propose at L3; A3 is
   * reached by a graduation one owner or admin proposes and a different one approves; revoking is one press.
   */

  /**
   * Autonomy per agent per tool: { enforced (L3+), levels, unavailable (A4, A5), noGrantLabel, rows: [{agentSlug, agentName,
   * tool, tags, grant?, level, label, graduated, supervised, history}] }. Missing grant = "A0 Observe (no grant)".
   */
  async grants(orgId: string) {
    await wait();
    enforceAutonomyBreaches(orgId); // an open autonomy_breach incident revokes its graduations (mock/l3autonomy.ts)
    return copy(platform.grantsView(orgId));
  },

  /** Revoke a graduation (one press, one owner or admin, effective at once). Writes autonomy.revoked; the tool falls back to A2. Returns { grant, seq, fallsBackTo }. */
  async revokeGrant(orgId: string, grantId: string, userId: string) {
    await wait(200, 400);
    return copy(platform.revokeGrant(orgId, grantId, userId));
  },

  /** Every agent write type with its record against the thresholds (≥ 90 days, ≥ 200 records, ≥ 100 approvals): GraduationCandidate[]. */
  async graduationCandidates(orgId: string) {
    await wait();
    enforceAutonomyBreaches(orgId);
    return copy(platform.graduationCandidates(orgId));
  },

  /** Graduation proposals, open and decided (each proposed by a person): GraduationProposal[]. */
  async graduationProposals(orgId: string) {
    await wait();
    return platform.graduationProposals(orgId);
  },

  /** An owner or admin proposes graduating a write type from A2 to A3, with their own justification. Writes autonomy.graduation_proposed. Returns GraduationProposal. */
  async proposeGraduation(orgId: string, input: { agentSlug: string; tool: string; justification: string }, userId: string) {
    await wait(300, 600);
    return platform.proposeGraduation(orgId, input, userId);
  },

  /**
   * A different owner or admin approves or declines (with a note); the proposer may only withdraw (approve=false).
   * Approving writes the A3 grant with a 30-day supervised period (autonomy.graduated). Returns GraduationProposal.
   */
  async decideGraduation(orgId: string, id: string, approve: boolean, userId: string, note: string) {
    await wait(300, 600);
    return platform.decideGraduation(orgId, id, approve, userId, note);
  },

  /** Graduated grants with their supervised period: calls, the 1-in-10 sample and its reviews. SupervisionRow[]. */
  async supervision(orgId: string) {
    await wait();
    enforceAutonomyBreaches(orgId);
    return copy(platform.supervisionView(orgId));
  },

  /** A person (owner, admin or approver) reviews a sampled call: ok, or a concern with a note. Writes autonomy.sample_reviewed. */
  async reviewSample(orgId: string, input: { grantId: string; seq: number; ok: boolean; note: string }, userId: string) {
    await wait(200, 400);
    return platform.reviewSample(orgId, input, userId);
  },

  /* ═══ Regulatory packs ══════════════════════════════════════════════ */

  /** ledger1, invoice1, collect1: RegulatoryPack[] with gates G-A…G-E, profile, price, installed state and coverage. */
  async packs(orgId: string) {
    await wait();
    packsFactory.ensureSeed(orgId);
    // gates evaluated from each pack's facts and this organisation's pilot answer, never hard-coded
    return copy(platform.packsView(orgId).map((p) => ({ ...p, gates: packsFactory.packGates(orgId, p.id) })));
  },

  /** One pack with its verifier profile: { pack: RegulatoryPack, profile: VerifierProfile | undefined }. */
  async pack(orgId: string, id: PackId) {
    await wait(60, 160);
    packsFactory.ensureSeed(orgId);
    const pk = platform.packsView(orgId).find((x) => x.id === id);
    if (!pk) throw new Error(`No pack called ${id}.`);
    const pr = platform.profilesView(orgId).find((x) => x.id === pk.profileId);
    return copy({ pack: { ...pk, gates: packsFactory.packGates(orgId, pk.id) }, profile: pr ? packsFactory.decorateProfile(orgId, pr) : undefined });
  },

  /** Install a pack (owner/admin, L2+). Writes pack.installed and adds the pack line to invoices. Returns RegulatoryPack. */
  async installPack(orgId: string, id: PackId, userId: string) {
    await wait(500, 900);
    return copy(platform.installPack(orgId, id, userId));
  },

  /** Generate a regime export from the chain (e.g. MCA audit-trail CSV). Returns PackExport { filename, mime, text, rows, seq }. */
  async packExport(orgId: string, packId: PackId, exportId: string, userId: string) {
    await wait(400, 800);
    return platform.packExport(orgId, packId, exportId, userId);
  },

  /* ═══ DPDP erasure ══════════════════════════════════════════════════ */

  /** { enabled (L2+), requests: ErasureRequest[], destroyedSalts }. */
  async erasures(orgId: string) {
    await wait();
    // requests opened before erasure plans existed get their plan, with statutory retention held back (mock/records.ts)
    recordsApi.ensureSeed(orgId);
    return platform.erasuresView(orgId);
  },

  /**
   * Open a request; the identifier is hashed and never stored. Returns ErasureRequest (affected sealed receipts listed).
   * Goes through the erasure plan (mock/records.ts): records under statutory retention are held back, and when every
   * matching record is held the request is refused, the refusal recorded, and an error thrown.
   */
  async createErasure(orgId: string, input: { subjectRef: string; identifier: string; reason: string }, userId: string) {
    const r = await recordsApi.openErasure(orgId, input, userId);
    if (r.outcome === 'refused') throw new Error(`Refused and recorded: every matching record is held by statutory retention (${r.refusal.bases.join(', ')}) until ${r.refusal.holdUntil.slice(0, 10)}.`);
    return r.request;
  },

  /** Approve: two different people, neither the requester. Returns ErasureRequest. */
  async approveErasure(orgId: string, id: string, userId: string) {
    await wait(200, 400);
    return platform.approveErasure(orgId, id, userId);
  },

  /** Destroy the salts for an approved request. The chain still verifies (re-checked). Returns ErasureRequest. */
  async executeErasure(orgId: string, id: string, userId: string) {
    await wait(600, 1000);
    recordsApi.ensureSeed(orgId); // a request without a plan is narrowed to what retention lets go first
    return platform.executeErasure(orgId, id, userId);
  },

  /* ═══ Approvals: escalation, membership, single-use links ═══════════ */

  /** Escalation policies per approver group: { policies: EscalationPolicy[], groups: ApproverGroup[], recent: escalations[] }. Applied automatically in the live tick. */
  async escalation(orgId: string) {
    await wait();
    return copy(platform.escalationView(orgId));
  },

  /** Change a group's escalation (minutes, backup group, on/off). Writes escalation.updated. */
  async setEscalation(orgId: string, groupId: string, patch: Partial<Pick<EscalationPolicy, 'afterMinutes' | 'backupGroupId' | 'enabled'>>, userId: string) {
    await wait(200, 400);
    return platform.setEscalation(orgId, groupId, patch, userId);
  },

  /**
   * Approver groups of an organisation with their current members (the edits saved in People and roles ›
   * Approver groups applied), and who may decide a given approval.
   */
  approverGroups(orgId: string) {
    return copy(effectiveGroupsOf(db.getDB(orgId)));
  },
  allowedApprovers(orgId: string, approvalId: string): string[] {
    const a = db.getDB(orgId).approvals.find((x) => x.id === approvalId);
    return a ? db.allowedApprovers(orgId, a) : [];
  },
  /** Sync: why a waiting approval cannot be decided now (an emergency stop holds it), or undefined. */
  decisionBlocked(orgId: string, approvalId: string): string | undefined {
    const a = db.getDB(orgId).approvals.find((x) => x.id === approvalId);
    return a ? db.decisionBlocked(orgId, a) : undefined;
  },

  /**
   * Issue a single-use approval link for a person. Returns ApprovalLinkToken { token, approvalId, issuedTo, channel, expiresAt }.
   * With the person sending it (`byUserId`), the link also goes to the demo outbox and is recorded as approval.link_sent;
   * at Sovereign a Slack or WhatsApp link is refused and recorded as egress.blocked.
   */
  async approvalLink(orgId: string, approvalId: string, issuedTo: string, channel: Channel = 'phone_link', byUserId?: string) {
    await wait(150, 300);
    if (byUserId) {
      const { sendApprovalLink } = await import('@/mock/approvalNotify');
      return sendApprovalLink(orgId, approvalId, issuedTo, channel, byUserId);
    }
    return platform.issueApprovalLink(orgId, approvalId, issuedTo, channel);
  },

  /** Public: what a link token points at (and whether it was used). */
  async resolveApprovalLink(token: string) {
    await wait(60, 140);
    return copy(platform.resolveApprovalLink(token));
  },

  /** Decide through a single-use link; a second use is refused. Returns { approval, receipt, link }. */
  async decideByLink(token: string, approve: boolean, reason: string) {
    await wait(250, 500);
    return copy(platform.decideByLink(token, approve, reason));
  },

  /* ═══ Dual control and reviews ══════════════════════════════════════ */

  /** Everything waiting for a second person, for this user: ReviewItem[] (rulebook reviews, assessment sign-offs, erasure approvals, graduation proposals). */
  async reviewsQueue(orgId: string, userId: string) {
    await wait();
    return copy(platform.reviewsQueue(orgId, userId));
  },
  /** Sync count of items this user can act on (for badges). */
  reviewsCount(orgId: string, userId?: string) {
    if (!userId) return 0;
    let extra = 0;
    try { extra = ops.opsWorkItems(orgId, userId, false).filter((x) => x.canAct).length; } catch { /* the ops queue never breaks the badge */ }
    // supervised A3 periods (L3 and Sovereign): 1 in 10 calls sampled for owners, admins and approvers, as Today and Reviews count them
    try {
      const role = db.memberRole(orgId, userId);
      if ((role === 'owner' || role === 'admin' || role === 'approver') && ['l3', 'sovereign'].includes(levelOfOrg(db.getDB(orgId).org))) {
        extra += platform.supervisionView(orgId).filter((s) => s.active).reduce((n, s) => n + s.sampled.filter((c) => !c.review).length, 0);
      }
    } catch { /* supervision never breaks the badge */ }
    try { return platform.reviewsQueue(orgId, userId).filter((x) => x.canAct).length + extra; } catch { return extra; }
  },

  /** Rulebook reviews (ReviewRequest[]) for an organisation, newest first. */
  async reviews(orgId: string) {
    await wait(60, 140);
    return copy(db.getDB(orgId).platform.reviews);
  },

  /** Ask a different person to review the current draft. Returns ReviewRequest; writes review.requested. */
  async requestReview(orgId: string, rulebookId: string, userId: string, note: string) {
    await wait(200, 400);
    return platform.requestReview(orgId, rulebookId, userId, note);
  },

  /** Approve or send back a review (reviewer ≠ requester). From L2 api.publish needs an approved review by another person. */
  async approveReview(orgId: string, reviewId: string, userId: string, approve: boolean, note: string) {
    await wait(300, 500);
    return platform.approveReview(orgId, reviewId, userId, approve, note);
  },

  /* ═══ Meter ═════════════════════════════════════════════════════════ */

  /**
   * The meter from the chain. Returns MeterView { plan, window: {decisions, committed, refused, pending, units, valueAtOverage},
   *   events: MeterEvent[] (newest 200; refused = 0.4), months (modelled, labelled), modelledNote, invoices, allowance, reconciliation }.
   */
  async meter(orgId: string) {
    await wait(150, 300);
    return copy(platform.meterView(orgId));
  },

  /* ═══ Deployment (Sovereign and hosted) ═════════════════════════════ */

  /** DeploymentView: cluster, components, database, secrets, storage, HSM, TSAs, egress, backup, updates, release key. */
  async deployment(orgId: string) {
    await wait();
    return copy(platform.deploymentView(orgId));
  },

  /** Verify an update bundle's signature against the elan1 release key and stage it (Sovereign). Returns UpdateBundle (status staged or rejected). */
  async stageUpdate(orgId: string, id: string, userId: string) {
    await wait(800, 1300);
    return platform.stageUpdate(orgId, id, userId);
  },

  /** Apply a staged bundle (Sovereign). Writes update.applied. Returns UpdateBundle. */
  async applyUpdate(orgId: string, id: string, userId: string) {
    await wait(900, 1500);
    return platform.applyUpdate(orgId, id, userId);
  },

  /** ResidencyView: domain, stores, cross-border, and a residency statement signed with the organisation's key. */
  async residency(orgId: string) {
    await wait();
    return copy(platform.residencyView(orgId));
  },

  /* ═══ Identity: SAML and SCIM ═══════════════════════════════════════ */

  /** IdentityConfig { saml: {...}, scim: {...} }. */
  async identityConfig(orgId: string) {
    await wait();
    return platform.identityConfig(orgId);
  },

  /** Owner only. Writes identity.updated. Returns IdentityConfig. */
  async setIdentityConfig(orgId: string, patch: { saml?: Partial<IdentityConfig['saml']>; scim?: Partial<IdentityConfig['scim']> }, userId: string) {
    await wait(300, 500);
    return platform.setIdentityConfig(orgId, patch, userId);
  },

  /** Owner only. Returns { secret (shown once), config }. */
  async rotateScimToken(orgId: string, userId: string) {
    await wait(300, 500);
    return platform.rotateScimToken(orgId, userId);
  },

  /* ═══ AI discovery ══════════════════════════════════════════════════ */

  /** The last discovery scan: DiscoveryScan { scannedAt, sources, findings: DiscoveryFinding[] }. */
  async discover(orgId: string) {
    await wait();
    return platform.discoveryView(orgId);
  },

  /** Re-scan now. Writes discovery.scanned. Returns DiscoveryScan. */
  async runDiscovery(orgId: string, userId: string) {
    await wait(900, 1500);
    return platform.runDiscovery(orgId, userId);
  },

  /** Register a finding in the AI inventory. Returns { finding, system }. */
  async registerFinding(orgId: string, id: string, userId: string) {
    await wait(300, 500);
    return platform.registerFinding(orgId, id, userId);
  },

  /** Dismiss a finding with a reason (recorded). */
  async dismissFinding(orgId: string, id: string, userId: string, reason: string) {
    await wait(200, 400);
    return platform.dismissFinding(orgId, id, userId, reason);
  },

  /* ═══ Public status ═════════════════════════════════════════════════ */

  /** Public (no sign-in): StatusView { updatedAt, overall, components: StatusComponent[] (incl. chain integrity per organisation), incidents }. */
  async status() {
    await wait(200, 400);
    return copy(platform.statusView());
  },
};

export type Api = typeof api;
export { db };
