/**
 * Derived views for the Assurance door: chain standing (with the level, boundary, anchoring and key
 * custody), refusal analytics and links into Activity.
 * Everything here is computed from the organisation's own records (db.getDB) and the API — nothing is typed in.
 */
import { api, db } from '@/api';
import type { AnchorsView, KeyCustody, LevelBoundary, LevelId, LevelState, Receipt } from '@/types';
import { atLeast, levelAt, LEVELS } from '@/lib/levels';
import { REFUSAL_CLASSES, REFUSAL_CLASSES_FULL, refusalClass, refusalClassFull, type RefusalClass, type RefusalClassFull, D, H } from '@/features/activity/shared';

export type OrgData = ReturnType<typeof db.getDB>;

/* ── Chain standing ───────────────────────────────────────── */

export interface ChainStanding {
  total: number;
  first?: Receipt;
  head?: Receipt;
  /** links where seq is not consecutive or prev_hash does not match the previous hash */
  breaks: number;
  firstBreak?: number;
  lastCheckpoint?: OrgData['checkpoints'][number];
  checkpoints: number;
  /** receipts after the last signed checkpoint */
  unanchored: number;
  fingerprint: string;
  activeKid?: string;
  activePublicKey?: string;
  keys: number;
  agents: { total: number; governed: number; advisory: number };
  /** the organisation's level now, and the receipts in this window written at each level */
  level: LevelId;
  atLevel: Record<LevelId, number>;
  /** the first receipt at the current level, when the boundary falls inside this window */
  boundarySeq?: number;
}

/** A cheap continuity check of the whole window (sequence numbers and hash links). Signatures are checked in the chain explorer. */
export function chainStanding(d: OrgData): ChainStanding {
  const rs = d.receipts;
  let breaks = 0;
  let firstBreak: number | undefined;
  for (let i = 1; i < rs.length; i++) {
    if (rs[i].seq !== rs[i - 1].seq + 1 || rs[i].prev_hash !== rs[i - 1].hash) {
      breaks++;
      if (firstBreak === undefined) firstBreak = rs[i].seq;
    }
  }
  const head = rs[rs.length - 1];
  const lastCheckpoint = d.checkpoints[d.checkpoints.length - 1];
  const active = d.signingKeys.find((k) => k.status === 'active');
  const live = d.agents.filter((a) => a.status !== 'draft');
  const level = d.org.plan as LevelId;
  const history = d.org.levelHistory?.length ? d.org.levelHistory : [{ level, from: d.org.createdAt }];
  const atLevel = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<LevelId, number>;
  for (const r of rs) atLevel[levelAt(history, new Date(r.ts).getTime(), history[0].level)]++;
  const since = new Date(history[history.length - 1].from).getTime();
  const boundarySeq = history.length > 1 ? rs.find((r) => new Date(r.ts).getTime() >= since)?.seq : undefined;
  return {
    level,
    atLevel,
    boundarySeq: boundarySeq !== undefined && boundarySeq !== rs[0]?.seq ? boundarySeq : undefined,
    total: rs.length,
    first: rs[0],
    head,
    breaks,
    firstBreak,
    lastCheckpoint,
    checkpoints: d.checkpoints.length,
    unanchored: head ? (lastCheckpoint ? Math.max(0, head.seq - lastCheckpoint.seq) : rs.length) : 0,
    fingerprint: d.org.keyFingerprint,
    activeKid: active?.kid,
    activePublicKey: active ? d.publicKeys[active.kid] : undefined,
    keys: d.signingKeys.length,
    agents: { total: live.length, governed: live.filter((a) => a.route === 'mcp').length, advisory: live.filter((a) => a.route !== 'mcp').length },
  };
}

/* ── Level facts: anchoring, custody, boundary, counterparties ── */

export interface LevelFacts {
  lv: LevelState;
  anchors: AnchorsView;
  custody: KeyCustody;
  /** the most recent boundary, if the organisation has moved up */
  boundary?: LevelBoundary;
  /** cross-organisation receipts (L3 and Sovereign) */
  cross?: { issued: number; received: number; verified: number; failed: number; last?: string };
}

/** Everything level-specific the Assurance door shows, from the API. Anchors and cross-organisation receipts only load where the level has them. */
export async function levelFacts(orgId: string): Promise<LevelFacts> {
  const [lv, anchors, custody] = await Promise.all([api.level(orgId), api.anchors(orgId, 3), api.custody(orgId)]);
  let cross: LevelFacts['cross'];
  if (atLeast(lv.level, 'l3')) {
    const xs = await api.crossOrgReceipts(orgId);
    cross = {
      issued: xs.filter((x) => x.direction === 'issued').length,
      received: xs.filter((x) => x.direction === 'received').length,
      verified: xs.filter((x) => x.verification.state === 'verified').length,
      failed: xs.filter((x) => x.verification.state === 'failed').length,
      last: xs.map((x) => x.issuedAt).sort().pop(),
    };
  }
  return { lv, anchors, custody, boundary: lv.boundaries[lv.boundaries.length - 1], cross };
}

/** Raw 32-byte Ed25519 public key → SubjectPublicKeyInfo PEM, as `govern verify --key` expects. */
export function publicKeyPem(hex: string) {
  const der = '302a300506032b6570032100' + hex;
  const bytes = (der.match(/../g) ?? []).map((h) => parseInt(h, 16));
  return `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PUBLIC KEY-----\n`;
}

/* ── Refusal analytics ────────────────────────────────────── */

/**
 * The windows match Activity's own ranges exactly (rolling 24 hours, rolling 7 days, the whole chain window),
 * so every count here equals the list its link opens in Activity.
 */
export type RangeId = '24h' | '7d' | 'all';

export const RANGES: Record<RangeId, { label: string; long: string; days?: number; activity: string }> = {
  '24h': { label: '24 h', long: 'the last 24 hours', activity: '24h' },
  '7d': { label: '7 d', long: 'the last 7 days', days: 7, activity: '7d' },
  all: { label: 'All', long: 'the whole chain window', activity: 'all' },
};

/** Read a range from a URL value; the retired '21d' opened Activity's whole window, so it maps to 'all'. */
export function parseRange(v: string | null, fallback: RangeId = '7d'): RangeId {
  if (v === '21d') return 'all';
  return v && v in RANGES ? (v as RangeId) : fallback;
}

/** Start of today in IST, as epoch ms. */
export function istMidnight(now = Date.now()) {
  const t = new Date(now + 5.5 * H);
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime() - 5.5 * H;
}

/**
 * Window bounds and buckets: hourly for 24 h; IST calendar days otherwise (today included, the first day cut at the
 * window start). 7 d is a rolling 7 × 24 hours and 'all' starts at the first receipt (`first`), as in Activity.
 */
export function windowFor(range: RangeId, now = Date.now(), first?: number) {
  const r = RANGES[range];
  if (range === '24h') {
    const from = now - D;
    const buckets = Array.from({ length: 24 }, (_, i) => {
      const end = now - (23 - i) * H;
      return { start: end - H, end, key: new Date(end).toISOString() };
    });
    return { from, to: now, buckets, hourly: true };
  }
  const from = r.days ? now - r.days * D : Math.min(first ?? now - D, now);
  const buckets: { start: number; end: number; key: string }[] = [];
  for (let day = istMidnight(from); day < now; day += D) {
    const start = Math.max(day, from);
    buckets.push({ start, end: Math.min(day + D, now), key: new Date(day).toISOString() });
  }
  return { from, to: now, buckets, hourly: false };
}

export interface AgentRow { slug: string; refused: number; calls: number; last?: Receipt; topRule?: string; topRuleCount: number }
/** `cls` is the fine class (Activity's `rc` filter), so the row's count equals the list its link opens. */
export interface RuleRow { key: string; agent?: string; ruleId: string; cls: RefusalClassFull; count: number; last: Receipt }
export interface ToolRow { tool: string; count: number; agents: string[]; last: Receipt }

export interface RefusalStats {
  refused: Receipt[];
  calls: number;
  share: number;
  prevRefused: number;
  prevCalls: number;
  /** whether the chain window reaches back over the whole previous period */
  prevCovered: boolean;
  /** by the six shared classes (the chart) */
  byClass: Record<RefusalClass, number>;
  /** by the fine classes Activity filters on (the class links) */
  byClassFull: Record<RefusalClassFull, number>;
  trend: Record<string, string | number>[];
  agents: AgentRow[];
  rules: RuleRow[];
  tools: ToolRow[];
}

const emptyClasses = () => Object.fromEntries(REFUSAL_CLASSES.map((c) => [c.id, 0])) as Record<RefusalClass, number>;
const emptyClassesFull = () => Object.fromEntries(REFUSAL_CLASSES_FULL.map((c) => [c.id, 0])) as Record<RefusalClassFull, number>;

/** Start of the chain window (the first receipt), for the 'all' range. */
export const firstTs = (receipts: Receipt[]) => (receipts[0] ? new Date(receipts[0].ts).getTime() : undefined);

export function refusalStats(receipts: Receipt[], range: RangeId, now = Date.now()): RefusalStats {
  const w = windowFor(range, now, firstTs(receipts));
  const span = w.to - w.from;
  const prevFrom = w.from - span;
  const inRange: Receipt[] = [];
  let prevRefused = 0;
  let prevCalls = 0;
  for (const r of receipts) {
    const t = new Date(r.ts).getTime();
    if (t >= w.from && t <= w.to) inRange.push(r);
    else if (t >= prevFrom && t < w.from) {
      if (r.kind === 'decision') prevCalls++;
      if (r.decision === 'refuse') prevRefused++;
    }
  }
  const refused = inRange.filter((r) => r.decision === 'refuse');
  const calls = inRange.filter((r) => r.kind === 'decision').length;

  const byClass = emptyClasses();
  const byClassFull = emptyClassesFull();
  const trendRows = w.buckets.map((b) => ({ key: b.key, start: b.start, end: b.end, ...emptyClasses() }));
  type AgentAcc = AgentRow & { ruleCounts: Map<string, number> };
  const newAgent = (slug: string): AgentAcc => ({ slug, refused: 0, calls: 0, topRuleCount: 0, ruleCounts: new Map() });
  const agentMap = new Map<string, AgentAcc>();
  const ruleMap = new Map<string, RuleRow>();
  const toolMap = new Map<string, { tool: string; count: number; agents: Set<string>; last: Receipt }>();

  for (const r of inRange) {
    if (r.kind === 'decision' && r.agent) {
      const a = agentMap.get(r.agent) ?? newAgent(r.agent);
      a.calls++;
      agentMap.set(r.agent, a);
    }
  }
  const bySeq = new Map<number, Receipt>();
  if (refused.some((r) => r.kind === 'approval' && !r.rule_id)) for (const r of receipts) bySeq.set(r.seq, r);
  for (const r of refused) {
    const cls = refusalClass(r) ?? 'rule';
    const fine = refusalClassFull(r) ?? 'rule';
    byClass[cls]++;
    byClassFull[fine]++;
    const t = new Date(r.ts).getTime();
    const b = trendRows.find((x) => t > x.start && t <= x.end) ?? (t <= trendRows[0]?.start ? trendRows[0] : undefined);
    if (b) b[cls]++;

    const slug = r.agent ?? 'unknown';
    const a = agentMap.get(slug) ?? newAgent(slug);
    a.refused++;
    if (!a.last || r.seq > a.last.seq) a.last = r;
    // an approval refusal belongs to the rule that held the call for a person
    const held = r.kind === 'approval' && r.ref_seq !== undefined ? bySeq.get(r.ref_seq) : undefined;
    const rid = r.rule_id ?? held?.rule_id ?? (cls === 'expiry' ? 'approval-expired' : cls === 'rejected' ? 'approval-rejected' : 'default');
    a.ruleCounts.set(rid, (a.ruleCounts.get(rid) ?? 0) + 1);
    agentMap.set(slug, a);

    const key = `${slug}::${rid}::${fine}`;
    const rr = ruleMap.get(key);
    if (rr) { rr.count++; if (r.seq > rr.last.seq) rr.last = r; }
    else ruleMap.set(key, { key, agent: r.agent, ruleId: rid, cls: fine, count: 1, last: r });

    if (r.tool) {
      const tt = toolMap.get(r.tool);
      if (tt) { tt.count++; if (r.agent) tt.agents.add(r.agent); if (r.seq > tt.last.seq) tt.last = r; }
      else toolMap.set(r.tool, { tool: r.tool, count: 1, agents: new Set(r.agent ? [r.agent] : []), last: r });
    }
  }

  const agents: AgentRow[] = [...agentMap.values()].filter((a) => a.refused > 0).map((a) => {
    let top: string | undefined;
    let topN = 0;
    a.ruleCounts.forEach((v, k) => { if (v > topN) { top = k; topN = v; } });
    return { slug: a.slug, refused: a.refused, calls: a.calls, last: a.last, topRule: top, topRuleCount: topN };
  }).sort((x, y) => y.refused - x.refused);

  return {
    refused,
    calls,
    share: calls ? refused.length / calls : 0,
    prevRefused,
    prevCalls,
    prevCovered: receipts.length > 0 && new Date(receipts[0].ts).getTime() <= prevFrom,
    byClass,
    byClassFull,
    trend: trendRows.map((row) => { const out: Record<string, string | number> = { key: row.key }; for (const c of REFUSAL_CLASSES) out[c.id] = row[c.id]; return out; }),
    agents,
    rules: [...ruleMap.values()].sort((x, y) => y.count - x.count),
    tools: [...toolMap.values()].map((t) => ({ tool: t.tool, count: t.count, agents: [...t.agents].sort(), last: t.last })).sort((x, y) => y.count - x.count),
  };
}

/** Link to Activity filtered to refusals. `rc` is the fine class, which is what Activity's filter matches. */
export function activityHref(range: RangeId, f: { agent?: string; tool?: string; rc?: RefusalClassFull; q?: string } = {}) {
  const p = new URLSearchParams({ d: 'refuse' });
  const ar = RANGES[range].activity;
  if (ar !== '24h') p.set('range', ar);
  if (f.agent) p.set('agent', f.agent);
  if (f.tool) p.set('tool', f.tool);
  if (f.rc) p.set('rc', f.rc);
  if (f.q) p.set('q', f.q);
  return `/activity?${p.toString()}`;
}

export function classLabel(c: RefusalClassFull) {
  return REFUSAL_CLASSES_FULL.find((x) => x.id === c)?.label ?? c;
}
