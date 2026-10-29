/**
 * Sovereign deployments (deny-all egress, on premises). Everything here is kept with the organisation's own
 * records under an optional `sovereign` field, created on first read, so state saved before it still loads.
 *
 *  - Egress: the cluster's egress firewall denies everything. Only hosts inside the organisation's network
 *    that an owner or admin put on the internal allow-list can be reached (an on-premises SIEM, the mail relay).
 *    Every blocked attempt is logged with its destination, time and component; attempts made from the console
 *    are also receipts.
 *  - The meter leaves the building on media: a usage statement for a period, signed with the organisation's
 *    key, exported to removable media and handed to Elan1. Each step is a receipt.
 *  - Rollback of an applied update bundle to the version before it (recorded).
 *  - The deployment's own local status (Elan1's public /status never lists an on-premises organisation).
 */
import type { OrgDB } from './db';
import { NOW0, append, getDB, memberRole, touch } from './db';
import { canonical, sha256Hex, signText, verifySig } from '@/lib/crypto';
import { makeRand } from '@/lib/prng';
import { levelOfOrg, LEVEL_INFO } from '@/lib/levels';
import type { ComponentStatus, UpdateBundle } from '@/types';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/* ── State ─────────────────────────────────────────────────────────────── */

export interface EgressAttempt {
  id: string;
  at: string;
  /** host:port as the firewall saw it */
  destination: string;
  /** the Elan1 Govern component (or node) that tried to connect */
  component: string;
  /** the pod or host it came from */
  source: string;
  /** why it was tried, when known */
  note?: string;
  /** a person in the console caused it (then it is also a receipt) */
  by?: string;
  seq?: number;
}

export interface InternalHost { host: string; purpose: string; addedAt: string; addedBy: string; seq?: number }

export interface UsageStatement {
  id: string;
  format: 'elan1.usage.statement.v1';
  org: string;
  orgName: string;
  period: { from: string; to: string; label: string };
  /** sandbox: sandbox calls in the period, left out of every other count and billed at 0 (as the Billing meter does) */
  counts: { decisions: number; committed: number; refused: number; pending: number; sandbox?: number };
  /** committed = 1, refused = 0.4 of the per-action rate, pending = 0 */
  units: number;
  head: { seq: number; hash: string };
  meterDigest: string;
  digest: string;
  kid: string;
  publicKey: string;
  sig: string;
  createdAt: string;
  createdBy: string;
  media: string;
  seq: number;
  handover?: { at: string; by: string; to: string; ref: string; seq: number };
}

export interface RollbackEntry { id: string; updateId: string; fromVersion: string; toVersion: string; at: string; by: string; reason: string; seq: number }

export interface SovereignState { v: 1; internalHosts: InternalHost[]; egress: EgressAttempt[]; statements: UsageStatement[]; rollbacks: RollbackEntry[] }

type WithSov = OrgDB & { sovereign?: SovereignState };

export const isSovereign = (orgId: string) => getDB(orgId).org.deployment === 'sovereign';

/** The organisation's internal mail and SIEM names: Deccan's own, or neutral ones for an organisation that upgraded. */
function internalDomain(d: OrgDB) {
  return d.org.id === 'org_deccan' ? 'deccanbank.internal' : `${(d.org.slug || d.org.id).replace(/[^a-z0-9-]/gi, '').toLowerCase()}.internal`;
}

function seedState(d: OrgDB): SovereignState {
  const dom = internalDomain(d);
  const owner = d.members.find((m) => m.role === 'owner')?.userId ?? 'system';
  const created = new Date(d.org.createdAt ?? iso(NOW0 - 90 * D)).getTime();
  const at = iso(Math.max(created, NOW0 - 60 * D));
  return {
    v: 1,
    internalHosts: [
      { host: `siem.${dom}`, purpose: 'Splunk HTTP Event Collector in the security operations centre (receipt events)', addedAt: at, addedBy: owner },
      { host: `smtp-relay.${dom}`, purpose: 'Internal mail relay for approval and sign-in emails', addedAt: at, addedBy: owner },
      { host: `itsm.${dom}`, purpose: 'On-premises ServiceNow (incident tickets from alerts)', addedAt: at, addedBy: owner },
    ],
    egress: [],
    statements: [],
    rollbacks: [],
  };
}

/** The Sovereign state, created on first read (Sovereign organisations only). */
export function sovState(orgId: string): SovereignState {
  const d = getDB(orgId) as WithSov;
  // before the SIEM endpoint below is considered, so Deccan does not end up with two
  confineSeededEndpoints(d);
  if (!d.sovereign || d.sovereign.v !== 1) {
    d.sovereign = seedState(d);
    // one endpoint to the internal SIEM, so the Webhooks screen shows what an allowed destination looks like
    if (d.org.id === 'org_deccan' && !d.webhooks.some((w) => w.url.includes('.internal'))) {
      d.webhooks.push({ id: 'wh_dcb_siem', url: `https://siem.${internalDomain(d)}/services/collector/event`, events: ['receipt.created'], status: 'active', secretPrefix: 'whsec_Dc7q', createdAt: iso(NOW0 - 40 * D), deliveries: Array.from({ length: 10 }, (_, i) => ({ id: `del_dcb_${i}`, event: 'receipt.created' as const, ts: iso(NOW0 - i * 37 * M), status: 200, attempts: 1, ms: 18 + ((i * 7) % 23) })) });
      const id = d.org.id;
      setTimeout(() => touch(id, 'webhook'), 0); // saved, and the Webhooks screen picks it up
    }
  }
  d.sovereign.internalHosts ??= [];
  d.sovereign.egress ??= [];
  d.sovereign.statements ??= [];
  d.sovereign.rollbacks ??= [];
  return d.sovereign;
}

/**
 * The seeded demo endpoints (every organisation gets wh_siem and wh_ops) point at public hosts. Deccan runs with
 * deny-all egress, so its copies deliver to its own allow-listed SIEM and on-premises ServiceNow instead. Saved state
 * from before this rule is corrected on read: the endpoint, its delivery log and its dead letters keep their history
 * but name the internal host. Endpoints a person added are never rewritten — the egress guard handles those.
 */
function confineSeededEndpoints(d: OrgDB) {
  if (d.org.id !== 'org_deccan') return;
  const dom = internalDomain(d);
  const to: Record<string, string> = {
    wh_siem: `https://siem.${dom}:8088/services/collector/event`,
    wh_ops: `https://itsm.${dom}/api/now/elan1/events`,
  };
  let changed = false;
  for (const w of d.webhooks) {
    const url = to[w.id];
    if (!url || w.url === url || hostOf(w.url).endsWith(`.${dom}`)) continue;
    const old = w.url;
    w.url = url;
    changed = true;
    for (const l of d.orgSettings?.deadLetter ?? []) if (l.webhookId === w.id || l.url === old) l.url = url;
  }
  if (changed) { const id = d.org.id; setTimeout(() => touch(id, 'webhook'), 0); }
}

function requireOwnerAdmin(orgId: string, userId: string, what: string) {
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what}: owners and admins can do this; your role cannot.`);
}

function requireSov(orgId: string, what: string) {
  if (!isSovereign(orgId)) throw new Error(`${what} is for Sovereign deployments, which run on your own infrastructure.`);
}

/* ── Egress ────────────────────────────────────────────────────────────── */

/** What the firewall blocks in a normal week: components still configured for the internet, and nodes phoning home. */
const BACKGROUND: { destination: string; component: string; source: (dom: string) => string; note: string; weight: number }[] = [
  { destination: 'api.openai.com:443', component: 'Workload outside Elan1 Govern', source: () => 'procurement-scripts-02', note: 'A script with an unregistered model key (see AI inventory › Discovery)', weight: 30 },
  { destination: 'hooks.slack.com:443', component: 'Approvals delivery', source: () => 'approvals-delivery-7f9c', note: 'A copied rulebook still names a Slack channel; Slack is not available here', weight: 14 },
  { destination: 'graph.facebook.com:443', component: 'Approvals delivery', source: () => 'approvals-delivery-7f9c', note: 'WhatsApp delivery is switched off under deny-all egress', weight: 8 },
  { destination: 'timestamp.digicert.com:80', component: 'Anchoring worker', source: () => 'anchoring-worker-2', note: 'Fallback to a public timestamp authority is disabled; the local TSAs answered', weight: 6 },
  { destination: 'ntp.ubuntu.com:123', component: 'Node operating system', source: (dom) => `wk-3.govern.${dom}`, note: 'Time comes from the bank’s own NTP servers', weight: 10 },
  { destination: 'registry-1.docker.io:443', component: 'Node operating system', source: (dom) => `wk-1.govern.${dom}`, note: 'Images come from the internal registry, loaded from the update bundle', weight: 5 },
  { destination: 'telemetry.ceph.com:443', component: 'Ceph object gateway', source: (dom) => `st-2.govern.${dom}`, note: 'Ceph telemetry module is off; this was the daily check', weight: 4 },
  { destination: 'o450.ingest.sentry.io:443', component: 'Decision service', source: () => 'decision-svc-5d2a', note: 'Error reporting to a third party is disabled in this build', weight: 3 },
  { destination: 'fonts.googleapis.com:443', component: 'Console', source: () => 'console-6b1e', note: 'Fonts are served from the console itself', weight: 2 },
];

const SLOT = 7 * M;

/** The firewall's background attempts in [from, to]: deterministic per 7-minute slot, so the log is the same on every load. */
function background(d: OrgDB, from: number, to: number): EgressAttempt[] {
  const dom = d.org.domain ?? 'example.in';
  const out: EgressAttempt[] = [];
  const start = Math.ceil(from / SLOT);
  const end = Math.floor(to / SLOT);
  const items = BACKGROUND.map((b) => [b, b.weight] as const);
  for (let s = start; s <= end; s++) {
    const r = makeRand(s * 7919 + d.org.id.length);
    const n = r.chance(0.4) ? (r.chance(0.15) ? 2 : 1) : 0;
    for (let i = 0; i < n; i++) {
      const b = r.weighted(items);
      const at = s * SLOT + r.int(0, SLOT - 1);
      if (at > to || at < from) continue;
      out.push({ id: `eg_${s}_${i}`, at: iso(at), destination: b.destination, component: b.component, source: b.source(dom), note: b.note });
    }
  }
  return out;
}

/** The egress log, newest first: blocked attempts in the last `days` days (at most 30). */
export function egressLog(orgId: string, days = 7): EgressAttempt[] {
  requireSov(orgId, 'The egress log');
  const d = getDB(orgId);
  const st = sovState(orgId);
  const now = Date.now();
  const from = now - Math.min(30, Math.max(1, days)) * D;
  const sovFrom = new Date(d.org.levelHistory?.find((p) => p.level === 'sovereign')?.from ?? d.org.createdAt ?? iso(now - 90 * D)).getTime();
  const bg = background(d, Math.max(from, sovFrom), now);
  const mine = st.egress.filter((e) => new Date(e.at).getTime() >= from);
  return [...mine, ...bg].sort((a, b) => b.at.localeCompare(a.at));
}

export function blockedInLast(orgId: string, hours: number) {
  return egressLog(orgId, Math.ceil(hours / 24)).filter((e) => new Date(e.at).getTime() >= Date.now() - hours * H).length;
}

export function internalHosts(orgId: string): InternalHost[] {
  return isSovereign(orgId) ? clone(sovState(orgId).internalHosts) : [];
}

const PRIVATE_IP = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

function hostOf(urlOrHost: string) {
  const t = urlOrHost.trim();
  try { return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return t.toLowerCase(); }
}

/** Whether a name is inside the organisation's own network (its internal zone, its own domain, or a private address). */
export function isInternalName(orgId: string, host: string) {
  const d = getDB(orgId);
  const h = hostOf(host);
  const own = (d.org.domain ?? '').toLowerCase();
  return h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.lan') || (!!own && (h === own || h.endsWith(`.${own}`))) || PRIVATE_IP.test(h) || h.endsWith(internalDomain(d));
}

export interface EgressCheck { allowed: boolean; host: string; reason?: string }

/** Can this organisation reach `url`? Hosted organisations: yes. Sovereign: only allow-listed internal hosts. */
export function checkDestination(orgId: string, url: string): EgressCheck {
  const host = hostOf(url);
  if (!isSovereign(orgId)) return { allowed: true, host };
  const st = sovState(orgId);
  if (st.internalHosts.some((h) => h.host === host)) return { allowed: true, host };
  const d = getDB(orgId);
  if (isInternalName(orgId, host)) return { allowed: false, host, reason: `${host} is inside ${d.org.name}’s network but is not on the internal allow-list. An owner or admin adds it under Agents › Deployment › Egress first.` };
  return { allowed: false, host, reason: `Egress is denied: ${host} is outside ${d.org.name}’s network. A Sovereign deployment sends nothing to the internet; only allow-listed internal hosts can be reached.` };
}

/**
 * The console tried to reach a destination for a person (a webhook endpoint, a Slack install). Allowed: returns.
 * Blocked: logs the attempt, writes egress.blocked and throws with the reason and the receipt.
 */
export function guardDestination(orgId: string, url: string, component: string, userId: string) {
  const c = checkDestination(orgId, url);
  if (c.allowed) return c;
  const d = getDB(orgId);
  const st = sovState(orgId);
  const r = append(d, { kind: 'admin', actor: userId, action: 'egress.blocked', details: { destination: c.host, component, policy: 'deny_all' } });
  st.egress.unshift({ id: `eg_c_${Date.now().toString(36)}`, at: r.ts, destination: `${c.host}:443`, component, source: 'console', note: 'Attempted from the console', by: userId, seq: r.seq });
  touch(orgId, 'deployment');
  throw new Error(`${c.reason} Nothing was sent. Recorded as receipt #${r.seq}.`);
}

/**
 * The webhook outbox, before it connects to an endpoint. Returns true when the firewall would drop the delivery
 * (Sovereign, host not on the internal allow-list): nothing is delivered and nothing is logged against the endpoint
 * as delivered. The attempt goes in the egress log, once per outbox run per endpoint, so the security team sees the
 * dispatcher still holds an outside address. It is the system, not a person, so it is not a receipt.
 */
export function dispatchBlocked(orgId: string, w: { url: string }, events = 0): boolean {
  if (!isSovereign(orgId)) return false;
  const st = sovState(orgId); // first, so a seeded endpoint is already pointed inside the network
  const c = checkDestination(orgId, w.url);
  if (c.allowed) return false;
  if (events > 0) {
    st.egress.unshift({ id: `eg_o_${Date.now().toString(36)}_${st.egress.length}`, at: iso(Date.now()), destination: `${c.host}:443`, component: 'Webhook dispatcher', source: 'webhook-dispatcher', note: `${events === 1 ? 'One event' : `${events} events`} for this endpoint not sent: it is outside the network. Disable or delete it in Assurance › Exports › Webhooks.` });
    st.egress = st.egress.slice(0, 1000);
    setTimeout(() => touch(orgId, 'deployment'), 0);
  }
  return true;
}

/** The endpoints a Sovereign deployment cannot deliver to (outside the network, or internal but not allow-listed). */
export function blockedEndpointIds(orgId: string, endpoints: { id: string; url: string }[]): string[] {
  if (!isSovereign(orgId)) return [];
  sovState(orgId);
  return endpoints.filter((w) => !checkDestination(orgId, w.url).allowed).map((w) => w.id);
}

export function addInternalHost(orgId: string, host: string, purpose: string, userId: string) {
  requireSov(orgId, 'The internal allow-list');
  requireOwnerAdmin(orgId, userId, 'Changing the internal allow-list');
  const h = hostOf(host);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && !PRIVATE_IP.test(h)) throw new Error('Enter a host name such as siem.bank.internal, or a private address.');
  if (!isInternalName(orgId, h)) throw new Error(`${h} is not inside your network. The allow-list takes internal names (.internal, .local, your own domain) and private addresses only; the internet stays denied.`);
  if (purpose.trim().length < 6) throw new Error('Say what the host is for, in a few words.');
  const st = sovState(orgId);
  if (st.internalHosts.some((x) => x.host === h)) throw new Error(`${h} is already on the allow-list.`);
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'egress.internal_host_added', details: { host: h, purpose: purpose.trim().slice(0, 120) } });
  st.internalHosts.push({ host: h, purpose: purpose.trim(), addedAt: r.ts, addedBy: userId, seq: r.seq });
  touch(orgId, 'deployment');
  return { seq: r.seq, host: h };
}

export function removeInternalHost(orgId: string, host: string, userId: string) {
  requireSov(orgId, 'The internal allow-list');
  requireOwnerAdmin(orgId, userId, 'Changing the internal allow-list');
  const d = getDB(orgId);
  const st = sovState(orgId);
  const i = st.internalHosts.findIndex((x) => x.host === host);
  if (i < 0) throw new Error('That host is not on the allow-list.');
  const using = d.webhooks.filter((w) => w.status !== 'disabled' && hostOf(w.url) === host);
  if (using.length) throw new Error(`An active webhook endpoint (${using[0].url}) delivers to ${host}. Disable or delete it in Assurance › Exports › Webhooks first.`);
  st.internalHosts.splice(i, 1);
  const r = append(d, { kind: 'admin', actor: userId, action: 'egress.internal_host_removed', details: { host } });
  touch(orgId, 'deployment');
  return { seq: r.seq };
}

/** The egress log as CSV for the bank's own SIEM or an auditor. Writes egress.log_exported. */
export function exportEgressLog(orgId: string, days: number, userId: string) {
  requireSov(orgId, 'The egress log');
  const role = memberRole(orgId, userId);
  if (!role || role === 'approver') throw new Error('Owners, admins, viewers and auditors export the egress log.');
  const rows = egressLog(orgId, days);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['time_utc,destination,component,source,verdict,note,receipt', ...rows.map((e) => [e.at, e.destination, e.component, e.source, 'blocked', e.note ?? '', e.seq ?? ''].map(esc).join(','))].join('\n');
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'egress.log_exported', details: { days, attempts: rows.length, digest: sha256Hex(csv).slice(0, 16) } });
  touch(orgId, 'deployment');
  return { csv, seq: r.seq, count: rows.length };
}

/* ── The meter, carried out on media ───────────────────────────────────── */

export interface StatementPeriod { id: string; label: string; from: number; to: number }

/** The periods a statement can cover: the month so far and the three months before it. */
export function statementPeriods(now = Date.now()): StatementPeriod[] {
  const IST = 5.5 * H;
  const t = new Date(now + IST);
  const out: StatementPeriod[] = [];
  for (let i = 0; i < 4; i++) {
    const y = t.getUTCFullYear();
    const m = t.getUTCMonth() - i;
    const from = Date.UTC(y, m, 1) - IST;
    const to = i === 0 ? now : Date.UTC(y, m + 1, 1) - IST - 1;
    const label = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + (i === 0 ? ' (to date)' : '');
    out.push({ id: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7), label, from, to });
  }
  return out;
}

/** Count governed actions in a period from the chain: allowed and approved = 1, refused, rejected and expired = 0.4, waiting = 0. */
export function meterFor(orgId: string, from: number, to: number) {
  const d = getDB(orgId);
  const inRange = d.receipts.filter((r) => { const t = new Date(r.ts).getTime(); return t >= from && t <= to; });
  // the same rule as the Billing meter (features/billing/chainMeter.ts): sandbox calls bill at 0 and stay out of the counts
  const allDecisions = inRange.filter((r) => r.kind === 'decision' && !!r.decision);
  const decisions = allDecisions.filter((r) => r.environment !== 'sandbox');
  const sandbox = allDecisions.length - decisions.length;
  const resolved = new Map<number, string>();
  for (const r of d.receipts) if (r.kind === 'approval' && r.ref_seq !== undefined) resolved.set(r.ref_seq, r.decision ?? '');
  let committed = 0; let refused = 0; let pending = 0;
  const lines: string[] = [];
  for (const r of decisions) {
    let q = 0;
    if (r.decision === 'allow') { committed++; q = 1; }
    else if (r.decision === 'refuse') { refused++; q = 0.4; }
    else if (r.decision === 'ask') {
      const res = resolved.get(r.seq);
      if (res === undefined) pending++;
      else if (res === 'allow') { committed++; q = 1; }
      else { refused++; q = 0.4; }
    }
    lines.push(`${r.seq}:${q}`);
  }
  const units = Math.round((committed + refused * 0.4) * 10) / 10;
  const head = inRange[inRange.length - 1] ?? [...d.receipts].reverse().find((r) => new Date(r.ts).getTime() <= to) ?? d.receipts[0];
  return { counts: { decisions: decisions.length, committed, refused, pending, sandbox }, units, head: { seq: head.seq, hash: head.hash }, meterDigest: sha256Hex(lines.join('|')) };
}

export function usageStatements(orgId: string): UsageStatement[] {
  return isSovereign(orgId) ? clone(sovState(orgId).statements) : [];
}

/**
 * Sign a usage statement for a period with the organisation's key and export it to removable media. Nothing is
 * sent: the file is handed to Elan1 on the media. Writes meter.statement_exported.
 */
export function exportUsageStatement(orgId: string, periodId: string, media: string, userId: string) {
  requireSov(orgId, 'A usage statement on media');
  requireOwnerAdmin(orgId, userId, 'Exporting a usage statement');
  const p = statementPeriods().find((x) => x.id === periodId);
  if (!p) throw new Error('Choose a period.');
  if (media.trim().length < 3) throw new Error('Name the media it is written to, for example the serial printed on the USB drive.');
  const d = getDB(orgId);
  const m = meterFor(orgId, p.from, p.to);
  const key = d.keys[d.keys.length - 1].key;
  const body = { format: 'elan1.usage.statement.v1' as const, org: d.org.id, orgName: d.org.name, period: { from: iso(p.from), to: iso(p.to), label: p.label }, counts: m.counts, units: m.units, head: m.head, meterDigest: m.meterDigest };
  const digest = sha256Hex(canonical(body));
  const sig = signText(digest, key);
  const r = append(d, { kind: 'admin', actor: userId, action: 'meter.statement_exported', details: { period: p.id, units: m.units, decisions: m.counts.decisions, refused: m.counts.refused, head_seq: m.head.seq, digest: digest.slice(0, 16), media: media.trim().slice(0, 60) } });
  const st: UsageStatement = { id: `us_${p.id}_${Date.now().toString(36)}`, ...body, digest, kid: key.kid, publicKey: key.publicKeyHex, sig, createdAt: r.ts, createdBy: userId, media: media.trim(), seq: r.seq };
  sovState(orgId).statements.unshift(st);
  touch(orgId, 'deployment');
  return { statement: clone(st), seq: r.seq };
}

/** Record that the media was handed to Elan1 (who took it, a courier or hand-over reference). Writes meter.statement_handed_over. */
export function recordHandover(orgId: string, statementId: string, to: string, ref: string, userId: string) {
  requireSov(orgId, 'A usage statement hand-over');
  requireOwnerAdmin(orgId, userId, 'Recording a hand-over');
  const s = sovState(orgId).statements.find((x) => x.id === statementId);
  if (!s) throw new Error('No such statement.');
  if (s.handover) throw new Error('The hand-over of this statement is already recorded.');
  if (to.trim().length < 3) throw new Error('Name the Elan1 person who received it.');
  if (ref.trim().length < 3) throw new Error('Give the courier or hand-over reference.');
  const r = append(getDB(orgId), { kind: 'admin', actor: userId, action: 'meter.statement_handed_over', details: { period: s.period.label, digest: s.digest.slice(0, 16), to: to.trim().slice(0, 60), ref: ref.trim().slice(0, 60), statement_seq: s.seq } });
  s.handover = { at: r.ts, by: userId, to: to.trim(), ref: ref.trim(), seq: r.seq };
  touch(orgId, 'deployment');
  return { seq: r.seq };
}

/** Re-check a statement file as Elan1 would: the digest over its content and the signature with the key it names. */
export function checkStatement(s: Pick<UsageStatement, 'format' | 'org' | 'orgName' | 'period' | 'counts' | 'units' | 'head' | 'meterDigest' | 'digest' | 'sig' | 'publicKey'>) {
  const body = { format: s.format, org: s.org, orgName: s.orgName, period: s.period, counts: s.counts, units: s.units, head: s.head, meterDigest: s.meterDigest };
  const digestOk = sha256Hex(canonical(body)) === s.digest;
  const sigOk = digestOk && verifySig(s.digest, s.sig, s.publicKey);
  return { digestOk, sigOk };
}

/* ── Rollback of an applied update ─────────────────────────────────────── */

export function rollbacks(orgId: string): RollbackEntry[] {
  return isSovereign(orgId) ? clone(sovState(orgId).rollbacks) : [];
}

const appliedOrder = (d: OrgDB) => d.platform.updates.filter((u) => u.status === 'applied').sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''));

/** The applied bundle a rollback would leave, if `id` is the one running now. */
export function rollbackTarget(orgId: string, id: string): UpdateBundle | undefined {
  const d = getDB(orgId);
  const order = appliedOrder(d);
  return order[0]?.id === id ? order[1] : undefined;
}

/**
 * Roll the running bundle back to the one applied before it (Sovereign). The rolled-back bundle stays verified
 * and staged, so it can be applied again. Writes update.rolled_back.
 */
export function rollbackUpdate(orgId: string, id: string, reason: string, userId: string) {
  requireSov(orgId, 'Rolling back an update');
  requireOwnerAdmin(orgId, userId, 'Rolling back an update');
  const d = getDB(orgId);
  const order = appliedOrder(d);
  const u = d.platform.updates.find((x) => x.id === id) as (UpdateBundle & { rolledBackAt?: string; rolledBackBy?: string; rollbackSeq?: number; rollbackReason?: string }) | undefined;
  if (!u) throw new Error('No such update bundle.');
  if (u.status !== 'applied' || order[0]?.id !== id) throw new Error('Only the bundle running now can be rolled back.');
  const prev = order[1];
  if (!prev) throw new Error('There is no earlier applied bundle to return to.');
  if (reason.trim().length < 10) throw new Error('Give the reason for the rollback (at least 10 characters).');
  const r = append(d, { kind: 'admin', actor: userId, action: 'update.rolled_back', details: { version: u.version, to_version: prev.version, digest: u.digest.slice(0, 16), reason: reason.trim().slice(0, 140) } });
  u.status = 'staged';
  u.rolledBackAt = r.ts;
  u.rolledBackBy = userId;
  u.rollbackSeq = r.seq;
  u.rollbackReason = reason.trim();
  // the earlier bundle is running again from now: appliedAt/appliedBy/seq now say who returned it to service, when,
  // and under which receipt; its first apply is kept (only once, so a second rollback to it keeps the original)
  if (!prev.firstAppliedAt) { prev.firstAppliedAt = prev.appliedAt; prev.firstAppliedBy = prev.appliedBy; prev.firstAppliedSeq = prev.seq; }
  prev.appliedAt = r.ts;
  prev.appliedBy = userId;
  prev.seq = r.seq;
  prev.restoredFrom = u.version;
  sovState(orgId).rollbacks.unshift({ id: `rb_${Date.now().toString(36)}`, updateId: u.id, fromVersion: u.version, toVersion: prev.version, at: r.ts, by: userId, reason: reason.trim(), seq: r.seq });
  touch(orgId, 'deployment');
  return { seq: r.seq, from: u.version, to: prev.version };
}

/* ── Local status (the deployment's own status page) ───────────────────── */

export interface LocalComponent { id: string; name: string; group: string; status: ComponentStatus; detail: string; days: { date: string; status: ComponentStatus | 'nodata'; note?: string }[]; facts?: { label: string; value: string }[] }

function localDays(seed: number, bad: { daysAgo: number; status: ComponentStatus; note: string }[] = [], since?: number) {
  const r = makeRand(seed);
  const now = Date.now();
  const out: LocalComponent['days'] = [];
  for (let i = 89; i >= 0; i--) {
    const t = now - i * D;
    const date = new Date(t + 5.5 * H).toISOString().slice(0, 10);
    if (since !== undefined && t < since - D) { r.next(); out.push({ date, status: 'nodata' }); continue; }
    const b = bad.find((x) => x.daysAgo === i);
    if (b) { r.next(); out.push({ date, status: b.status, note: b.note }); continue; }
    const blip = r.chance(0.008);
    out.push({ date, status: blip ? 'degraded' : 'operational', note: blip ? 'Elevated latency for 3 minutes during a node drain' : undefined });
  }
  return out;
}

/** The deployment's own components with 90 days each, measured inside the network. Nothing here is published by Elan1. */
export function localStatus(orgId: string): { components: LocalComponent[]; checkedAt: string } {
  requireSov(orgId, 'Local status');
  const d = getDB(orgId);
  const since = new Date(d.org.createdAt ?? iso(Date.now() - 90 * D)).getTime();
  // the chain: last 200 receipts link, the head and the last checkpoint verify with the organisation's key
  const rs = d.receipts.slice(-200);
  let linked = true;
  for (let i = 1; i < rs.length; i++) if (rs[i].prev_hash !== rs[i - 1].hash || rs[i].seq !== rs[i - 1].seq + 1) { linked = false; break; }
  const head = rs[rs.length - 1];
  const headOk = verifySig(head.hash, head.sig, d.publicKeys[head.kid]);
  const cp = d.checkpoints[d.checkpoints.length - 1];
  const cpOk = !cp || verifySig(canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid }), cp.sig, d.publicKeys[cp.kid]);
  const chainOk = linked && headOk && cpOk;
  const blocked = blockedInLast(orgId, 24);
  const dom = d.org.domain ?? 'example.in';
  const lv = LEVEL_INFO[levelOfOrg(d.org)].label;
  const c = (id: string, name: string, group: string, seed: number, detail: string, bad: Parameters<typeof localDays>[1] = [], status: ComponentStatus = 'operational', facts?: LocalComponent['facts']): LocalComponent => ({ id, name, group, status, detail, days: localDays(seed, bad, since), facts });
  // the approvals service (mock/approvalsExt outage): fail closed, shown here because /status never lists this deployment
  const ax = (d as OrgDB & { approvalsExt?: { outage?: { active?: boolean; since?: string; history?: { since: string; endedAt: string; minutes: number; extended: number }[] } } }).approvalsExt?.outage;
  const apDown = !!ax?.active;
  const apBad: Parameters<typeof localDays>[1] = [
    ...(apDown ? [{ daysAgo: 0, status: 'outage' as const, note: 'Approvals service down now (demonstration): nothing can be approved and nothing expires' }] : []),
    ...(ax?.history ?? []).map((h) => ({ daysAgo: Math.max(0, Math.floor((Date.now() - new Date(h.since).getTime()) / D)), status: 'outage' as const, note: `Approvals service down for ${h.minutes} minutes (demonstration); nothing was approved, ${h.extended} waiting approvals had their expiry moved` })).filter((b) => b.daysAgo < 90),
  ];
  const apSince = ax?.since ? new Date(new Date(ax.since).getTime() + 5.5 * H).toISOString().slice(11, 16) : undefined;
  const pendingNow = d.approvals.filter((a) => a.status === 'pending').length;
  return {
    checkedAt: iso(Date.now()),
    components: [
      c('l_decide', 'Decision service', 'Platform', 101, 'Decides before each tool call. Median 31 ms, 95th percentile 96 ms on your workers.'),
      c('l_writer', 'Receipt writer', 'Platform', 102, `Seals and appends every governed write before the call returns. Writes without a receipt in 30 days: 0.`, [], 'operational', [{ label: 'Chain head', value: `#${head.seq}` }]),
      c('l_meter', 'Meter', 'Platform', 103, 'Counts governed actions from your own chain. It leaves the network only as a signed usage statement on media.'),
      c('l_console', 'Console', 'Platform', 104, `Served from console.govern.${dom} inside your network.`, [{ daysAgo: 12, status: 'maintenance', note: 'Update 2026.10.1 applied by your administrators' }]),
      c('l_approvals', 'Approvals service', 'Platform', 114, apDown ? `Down since ${apSince ?? 'now'} IST (demonstration). We cannot check a change right now, so nothing is approved, rejected, re-routed or extended, single-use links are closed and nothing expires until it is back.` : 'Checks each change before a decision is recorded. If it cannot, every decide screen and single-use link closes; nothing is approved by default.', apBad, apDown ? 'outage' : 'operational', [{ label: 'Waiting approvals', value: String(pendingNow) }]),
      c('l_mail', 'Approvals by email (internal relay)', 'Delivery', 105, 'Approval links through your own mail relay. Slack and WhatsApp are not available under deny-all egress.'),
      c('l_hsm', 'Signing key in your HSM', 'Keys and storage', 106, `The newest receipt (#${head.seq}) is signed by ${head.kid} and ${headOk ? 'verifies' : 'does not verify'}. FIPS 140-3 Level 3.`, [], headOk ? 'operational' : 'outage'),
      c('l_pg', 'PostgreSQL 16 (row-level security)', 'Keys and storage', 107, 'Three nodes under Patroni; every query scoped to the organisation.'),
      c('l_bao', 'OpenBao', 'Keys and storage', 108, 'Secrets, unsealed by your key holders.'),
      c('l_ceph', 'Object-lock store (Ceph)', 'Keys and storage', 109, 'Receipts, seals and bundles under S3 Object Lock in compliance mode for 8 years.'),
      c('l_tsa1', 'Local timestamp authority 1', 'Timestamping', 110, 'RFC 3161 inside your network.'),
      c('l_tsa2', 'Local timestamp authority 2', 'Timestamping', 111, 'RFC 3161 at your DR site.', [{ daysAgo: 19, status: 'degraded', note: 'DR drill: TSA 2 failed over for 22 minutes; batches kept both timestamps' }]),
      c('l_chain', `Chain integrity — ${d.org.name}`, 'Chain integrity', 112, chainOk ? `Last ${rs.length} receipts link, the head #${head.seq} verifies${cp ? ` and checkpoint #${cp.seq} verifies` : ''}. ${lv}. Re-checked in this browser now.` : `Verification failed near #${head.seq}.`, [], chainOk ? 'operational' : 'outage'),
      c('l_egress', 'Egress firewall (deny all)', 'Network', 113, `${blocked} connection attempts blocked in the last 24 hours; nothing left the network.`, [], 'operational', [{ label: 'Allow-list', value: `${sovState(orgId).internalHosts.length} internal hosts` }]),
    ],
  };
}
