import type { Condition, Decision, Quota, Receipt, RiskTag, Rule } from '@/types';
import { toolByName } from '@/mock/catalog';

/**
 * The decision step, as built: pure, no I/O. Strictest matching rule wins (refuse > ask > allow);
 * no matching rule refuses ("default"). Used by Try an action and Test on past actions.
 */
const RANK: Record<Decision, number> = { allow: 0, ask: 1, refuse: 2 };

const LISTS: Record<string, string[]> = {
  approved_vendors: ['northwind traders', 'kalyani metals', 'surya packaging', 'blue dart logistics', 'indigo print works', 'northwind', 'kalyanimetals', 'suryapack', 'bluedartlogistics', 'indigoprint'],
  own_accounts: ['HDFC-OPS-0042', 'ICICI-FD-1180'],
};

function test(c: Condition, args: Record<string, unknown>): boolean | undefined {
  const raw = args[c.field] ?? (c.field === 'to' ? args.to_domain : undefined);
  if (raw === undefined) return undefined;
  const v = typeof raw === 'string' && !isNaN(Number(raw)) && c.op !== 'eq' && c.op !== 'in' ? Number(raw) : raw;
  const expand = (vals: unknown): string[] => (Array.isArray(vals) ? vals : [vals]).flatMap((x) => (typeof x === 'string' && LISTS[x] ? LISTS[x] : [String(x)])).map((s) => s.toLowerCase());
  switch (c.op) {
    case 'eq': return String(v).toLowerCase() === String(c.value).toLowerCase();
    case 'lt': return Number(v) < Number(c.value);
    case 'lte': return Number(v) <= Number(c.value);
    case 'gt': return Number(v) > Number(c.value);
    case 'gte': return Number(v) >= Number(c.value);
    case 'in': return expand(c.value).includes(String(v).toLowerCase());
    case 'to_domain_in': {
      const d = String(v).includes('@') ? String(v).split('@')[1] : String(v);
      return expand(c.value).includes(d.toLowerCase());
    }
    case 'fields_include': return expand(c.value).every((f) => f in args);
  }
}

export interface Evaluation {
  decision: Decision;
  ruleId: string;
  reason: string;
  matched: { rule: Rule; outcome: 'matched' | 'conditions_failed' | 'not_applicable' | 'unknown_field' }[];
  /** Set when the winning allow rule's quota was used up: the allow became an ask (or a refuse without an approver group). */
  quota?: { rule: string; kind: Quota['kind']; limit: number; window: string; used: number; field?: string };
}

const IST = 5.5 * 3_600_000;

/** When a quota window that ends now began: 'day' is since midnight IST; '30m', '1h', '7d' are rolling. */
export function quotaWindowStart(window: string, now = Date.now()): number {
  if (window === 'day') { const d = new Date(now + IST); d.setUTCHours(0, 0, 0, 0); return d.getTime() - IST; }
  const m = /^(\d+)\s*(m|h|d)$/.exec(window.trim());
  const n = m ? Number(m[1]) : 1;
  const unit = m?.[2] === 'm' ? 60_000 : m?.[2] === 'h' ? 3_600_000 : 86_400_000;
  return now - n * unit;
}

/**
 * How much of a rule's quota its earlier allowed calls used in the current window: a count of calls, or the sum
 * of the quota's field. `history` is the agent's receipts; only decisions the rule allowed count.
 */
export function quotaUsed(rule: Rule, history: Receipt[], now = Date.now()): number {
  const q = rule.quota;
  if (!q) return 0;
  const from = quotaWindowStart(q.window, now);
  const prior = history.filter((r) => r.kind === 'decision' && r.rule_id === rule.id && r.decision === 'allow' && new Date(r.ts).getTime() >= from);
  return q.kind === 'max_count' ? prior.length : prior.reduce((s, r) => s + (Number(r.args_summary?.[q.field ?? 'amount']) || 0), 0);
}

/** Where tags come from when the caller passes none: the open organisation's own catalogue (set by the data layer). */
let tagResolver: ((tool: string) => RiskTag[] | undefined) | undefined;
export function setToolTagResolver(fn: (tool: string) => RiskTag[] | undefined) {
  tagResolver = fn;
}

export function evaluate(rules: Rule[], tool: string, args: Record<string, unknown>, tags?: RiskTag[], opts: { history?: Receipt[]; now?: number; includeSimulate?: boolean } = {}): Evaluation {
  const toolTags = tags ?? tagResolver?.(tool) ?? toolByName(tool)?.tags ?? [];
  const trace: Evaluation['matched'] = [];
  let best: Rule | undefined;
  // simulate-only rules (an L1 pack section is a dry run) never decide: not in the guard, Try an action or replay
  for (const rule of opts.includeSimulate ? rules : rules.filter((r) => r.mode !== 'simulate')) {
    const applies = rule.match.tool ? rule.match.tool === tool : rule.match.tag ? toolTags.includes(rule.match.tag) : false;
    if (!applies) { trace.push({ rule, outcome: 'not_applicable' }); continue; }
    const results = (rule.when ?? []).map((c) => test(c, args));
    if (results.some((x) => x === undefined)) { trace.push({ rule, outcome: 'unknown_field' }); continue; }
    if (results.some((x) => x === false)) { trace.push({ rule, outcome: 'conditions_failed' }); continue; }
    if (rule.decide === 'ask' && rule.unless?.length && rule.unless.every((c) => test(c, args) === true)) { trace.push({ rule, outcome: 'conditions_failed' }); continue; }
    trace.push({ rule, outcome: 'matched' });
    if (!best || RANK[rule.decide] > RANK[best.decide]) best = rule;
  }
  if (!best) return { decision: 'refuse', ruleId: 'default', reason: 'No rule allows this call. Anything not explicitly allowed is refused.', matched: trace };
  // a quota only tightens: past its limit in the window, an allow becomes an ask (a refuse without an approver group)
  if (best.decide === 'allow' && best.quota && opts.history) {
    const q = best.quota;
    const used = quotaUsed(best, opts.history, opts.now);
    const add = q.kind === 'max_count' ? 1 : Number(args[q.field ?? 'amount']) || 0;
    if (used + add > q.limit) {
      const what = q.kind === 'max_count' ? `${q.limit.toLocaleString('en-IN')} calls` : `${q.limit.toLocaleString('en-IN')} in ${q.field ?? 'amount'}`;
      const per = q.window === 'day' ? 'a day' : `per ${q.window}`;
      return {
        decision: best.approver ? 'ask' : 'refuse', ruleId: best.id, matched: trace,
        reason: `${best.reason} Over the limit of ${what} ${per} (${used.toLocaleString('en-IN')} used in this window)${best.approver ? ', so a person decides.' : '; the rule names no approver group, so it is refused.'}`,
        quota: { rule: best.id, kind: q.kind, limit: q.limit, window: q.window, used, field: q.field },
      };
    }
  }
  return { decision: best.decide, ruleId: best.id, reason: best.reason, matched: trace };
}

export interface ReplayResult {
  total: number;
  judged: number;
  unjudged: number;
  changed: { seq: number; ts: string; tool: string; agent: string; from: Decision; to: Decision; ruleFrom?: string; ruleTo: string }[];
  counts: { moreRefused: number; moreAsk: number; fewerAsk: number; fewerRefused: number; moreAllow: number };
}

/** Decisions that were not the rulebook's: a stop or pause, a receipt write that failed, a switched-off tool, no rulebook. */
const NOT_RULEBOOK = ['agent-paused', 'gate-error', 'tool-disabled', 'no-rulebook'];

/**
 * Test on past actions: re-decide each past decision receipt under a draft rulebook. Each receipt is compared
 * with what the rulebook decided at the time (details.rulebook_decision when autonomy or a quota changed the final
 * decision), so only rulebook changes show; stop, pause, gate-error and switched-off-tool refusals are left out.
 */
export function replay(receipts: Receipt[], rules: Rule[], prior: Receipt[] = []): ReplayResult {
  const decisions = receipts.filter((r) => r.kind === 'decision' && r.tool && r.decision && !NOT_RULEBOOK.includes(r.rule_id ?? '')).sort((a, b) => a.seq - b.seq);
  const changed: ReplayResult['changed'] = [];
  let unjudged = 0;
  const counts = { moreRefused: 0, moreAsk: 0, fewerAsk: 0, fewerRefused: 0, moreAllow: 0 };
  // Quotas are counted as the draft would have counted them: the calls the draft itself allowed earlier in the
  // replay, on top of the decisions recorded before the replayed range (`prior`, which may start a window).
  const sim: Receipt[] = prior.filter((r) => r.kind === 'decision');
  for (const r of decisions) {
    if (!r.args_summary) { unjudged++; continue; }
    const tags = r.details?.tags ? (String(r.details.tags).split(',') as RiskTag[]) : undefined;
    const e = evaluate(rules, r.tool!, r.args_summary, tags, { history: sim, now: new Date(r.ts).getTime() });
    sim.push({ ...r, rule_id: e.ruleId, decision: e.decision });
    if (e.matched.some((m) => m.outcome === 'unknown_field') && e.ruleId === 'default') { unjudged++; continue; }
    // what the rulebook decided at the time, quota included: a quota that held the call is the rulebook's decision;
    // autonomy and a switched-off tool are not (details.rulebook_decision keeps the decision before them)
    const rb = r.details?.quota_decision ?? (r.details?.quota ? r.decision : r.details?.rulebook_decision);
    const before = (rb === 'allow' || rb === 'ask' || rb === 'refuse' ? rb : r.decision) as Decision;
    if (e.decision !== before) {
      changed.push({ seq: r.seq, ts: r.ts, tool: r.tool!, agent: r.agent ?? '', from: before, to: e.decision, ruleFrom: r.rule_id, ruleTo: e.ruleId });
      if (e.decision === 'refuse') counts.moreRefused++;
      if (e.decision === 'ask') counts.moreAsk++;
      if (before === 'ask') counts.fewerAsk++;
      if (before === 'refuse') counts.fewerRefused++;
      if (e.decision === 'allow') counts.moreAllow++;
    }
  }
  return { total: decisions.length, judged: decisions.length - unjudged, unjudged, changed, counts };
}

/** Semantic diff between two rule sets: which rules are new, removed, tighter or looser. */
export function semanticDiff(before: Rule[], after: Rule[]) {
  const out: { id: string; change: 'added' | 'removed' | 'tighter' | 'looser' | 'changed'; text: string }[] = [];
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  for (const [id, r] of a) {
    const old = b.get(id);
    if (!old) { out.push({ id, change: 'added', text: `New rule ${id}: ${r.decide} — ${r.reason}` }); continue; }
    if (JSON.stringify(old) === JSON.stringify(r)) continue;
    if (RANK[r.decide] !== RANK[old.decide]) {
      out.push({ id, change: RANK[r.decide] > RANK[old.decide] ? 'tighter' : 'looser', text: `${id}: ${old.decide} → ${r.decide}` });
      continue;
    }
    const num = (rule: Rule) => rule.when?.find((c) => typeof c.value === 'number');
    const on = num(old); const nn = num(r);
    if (on && nn && on.field === nn.field && on.value !== nn.value && on.op === nn.op && ['lt', 'lte', 'gt', 'gte'].includes(nn.op)) {
      const raised = Number(nn.value) > Number(on.value);
      // raising an upper bound (lt/lte) matches more calls; raising a lower bound (gt/gte) matches fewer
      const matchesMore = ['lt', 'lte'].includes(nn.op) ? raised : !raised;
      // matching more is looser for an allow, tighter for an ask or a refuse
      const looser = r.decide === 'allow' ? matchesMore : !matchesMore;
      out.push({ id, change: looser ? 'looser' : 'tighter', text: `${id}: ${on.field} ${on.op} ${on.value} → ${nn.op} ${nn.value}` });
    } else if (on && nn && on.field === nn.field && on.value !== nn.value) {
      out.push({ id, change: 'changed', text: `${id}: ${on.field} ${on.op} ${on.value} → ${nn.op} ${nn.value}` });
    } else out.push({ id, change: 'changed', text: `${id}: conditions or wording changed` });
  }
  for (const id of b.keys()) if (!a.has(id)) out.push({ id, change: 'removed', text: `Rule ${id} removed` });
  return out;
}
