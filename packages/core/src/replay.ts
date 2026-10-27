import { decide, type QuotaUsage } from "./engine";
import { durationMs, quotasOf, ruleTargets, type Decision, type Quota, type Rulebook } from "./rulebook";
import { builtinRegistry, type ToolRegistry } from "./tools";

// ---- Replay: what a draft rulebook would have decided over past calls ----
//
// Pure: the gate service loads the calls (and decrypts their stored arguments), this
// decides them again in order, with quota usage built up as it goes.

type Args = Record<string, unknown>;

/** One past call of the agent whose rulebook is being tested. */
export interface ReplayCall {
  /** Receipt sequence number of the original decision. */
  seq: number;
  /** When it happened, in milliseconds since the epoch. */
  ts: number;
  tool: string;
  /** The validated arguments, if they were stored. Without them the call cannot be judged. */
  args?: Args;
  original: { decision: Decision; ruleId: string };
  /** It ran successfully at the time (allowed and done, or approved and done). */
  ran: boolean;
}

/** Something that used up quota and is not being decided again: other agents, older calls, calls without arguments. */
export interface UsageEvent {
  ts: number;
  tool: string;
  /** Field values for sum quotas (from the receipt's summary). */
  values: Args;
}

export interface ReplayInput {
  rulebook: Rulebook;
  calls: ReplayCall[];
  usage?: UsageEvent[];
  /** IANA zone for "day" quotas. */
  timeZone: string;
  registry?: ToolRegistry;
  /** Lists known at decision time (vendor_domains), per tool. */
  lists?: (tool: string) => Record<string, string[]> | undefined;
  /** How many changed calls to return. */
  maxChanges?: number;
}

export interface ReplayChange {
  seq: number;
  ts: number;
  tool: string;
  from: Decision;
  to: Decision;
  fromRule: string;
  /** The rule (or quota) that would decide now; "default" when none matches. */
  rule: string;
  quotaId?: string;
  reason: string;
}

export type DecisionCounts = Record<Decision, number>;

export interface ReplayResult {
  total: number;
  judged: number;
  notJudged: number;
  unchanged: number;
  changed: number;
  /** Changed calls that now end in each decision. */
  more: DecisionCounts;
  /** Changed calls that used to end in each decision. */
  fewer: DecisionCounts;
  /** Judged calls by decision, then and now. */
  before: DecisionCounts;
  after: DecisionCounts;
  changes: ReplayChange[];
  /** More calls changed than `changes` holds. */
  truncated: boolean;
}

export const REPLAY_MAX_CHANGES = 200;

const zero = (): DecisionCounts => ({ allow: 0, ask: 0, refuse: 0 });

/** Midnight in an IANA time zone on the day of `now`. */
export function startOfDayIn(timeZone: string, now = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offset);
}

/** Where a quota's window starts for a call at `ts`: local midnight for "day", else a rolling duration back. */
export function quotaWindowStart(q: Pick<Quota, "window">, ts: number, timeZone: string): number {
  return q.window === "day" ? startOfDayIn(timeZone, new Date(ts)).getTime() : ts - durationMs(q.window);
}

/** How far before the first replayed call usage still matters, so the caller can load it. */
export function replayLookbackMs(rb: Rulebook, cap = 90 * 86_400_000): number {
  let ms = 0;
  for (const q of quotasOf(rb)) ms = Math.max(ms, q.window === "day" ? 25 * 3_600_000 : durationMs(q.window));
  return Math.min(ms, cap);
}

/**
 * Does a replayed call use up quota? An allow does if it would have run: it did at the time, or it
 * was not allowed then (so nothing had failed). An ask only does if it was an ask then and a person
 * approved it. A refusal never does.
 */
export function replayCounts(to: Decision, call: Pick<ReplayCall, "original" | "ran">): boolean {
  if (to === "allow") return call.ran || call.original.decision !== "allow";
  if (to === "ask") return call.original.decision === "ask" && call.ran;
  return false;
}

interface Window {
  quota: Quota;
  entries: { ts: number; value: number }[];
  head: number;
  count: number;
  sum: number;
}

type Item = { kind: "call"; ts: number; order: number; call: ReplayCall } | { kind: "usage"; ts: number; order: number; event: UsageEvent };

export function replayRulebook(input: ReplayInput): ReplayResult {
  const registry = input.registry ?? builtinRegistry;
  const rb = input.rulebook;
  const max = input.maxChanges ?? REPLAY_MAX_CHANGES;
  const out: ReplayResult = { total: input.calls.length, judged: 0, notJudged: 0, unchanged: 0, changed: 0, more: zero(), fewer: zero(), before: zero(), after: zero(), changes: [], truncated: false };

  // Every quota keeps the entries that count towards it, oldest first; the window start only moves forward.
  const windows: Window[] = quotasOf(rb).map((quota) => ({ quota, entries: [], head: 0, count: 0, sum: 0 }));
  const applies = new Map<string, Window[]>();
  const windowsFor = (tool: string) => {
    let w = applies.get(tool);
    if (!w) {
      const spec = registry.get(tool);
      w = windows.filter((x) => ruleTargets(x.quota, spec, tool));
      applies.set(tool, w);
    }
    return w;
  };
  const add = (tool: string, ts: number, values: Args) => {
    for (const w of windowsFor(tool)) {
      const field = w.quota.max_sum?.field;
      const v = field !== undefined ? values[field] : undefined;
      const value = typeof v === "number" && Number.isFinite(v) ? v : 0;
      w.entries.push({ ts, value });
      w.count++;
      w.sum += value;
    }
  };
  const usageAt = (tool: string, ts: number): Record<string, QuotaUsage> => {
    const usage: Record<string, QuotaUsage> = {};
    for (const w of windowsFor(tool)) {
      const start = quotaWindowStart(w.quota, ts, input.timeZone);
      while (w.head < w.entries.length && (w.entries[w.head] as { ts: number }).ts < start) {
        const e = w.entries[w.head++] as { ts: number; value: number };
        w.count--;
        w.sum -= e.value;
      }
      usage[w.quota.id] = { count: w.count, sum: w.sum };
    }
    return usage;
  };

  const items: Item[] = [
    ...(input.usage ?? []).map((event, i): Item => ({ kind: "usage", ts: event.ts, order: i, event })),
    ...input.calls.map((call, i): Item => ({ kind: "call", ts: call.ts, order: i, call })),
  ];
  // Time order; at the same moment, usage first (it was recorded before), then calls by seq.
  items.sort((a, b) => a.ts - b.ts || (a.kind === b.kind ? (a.kind === "call" && b.kind === "call" ? a.call.seq - b.call.seq : a.order - b.order) : a.kind === "usage" ? -1 : 1));

  for (const item of items) {
    if (item.kind === "usage") {
      add(item.event.tool, item.ts, item.event.values);
      continue;
    }
    const call = item.call;
    if (!call.args) {
      out.notJudged++;
      continue;
    }
    out.judged++;
    const d = decide(rb, call.tool, call.args, { registry, usage: usageAt(call.tool, call.ts), lists: input.lists?.(call.tool) });
    const from = call.original.decision;
    out.before[from]++;
    out.after[d.decision]++;
    if (replayCounts(d.decision, call)) add(call.tool, call.ts, call.args);
    if (d.decision === from) {
      out.unchanged++;
      continue;
    }
    out.changed++;
    out.more[d.decision]++;
    out.fewer[from]++;
    if (out.changes.length < max) {
      out.changes.push({ seq: call.seq, ts: call.ts, tool: call.tool, from, to: d.decision, fromRule: call.original.ruleId, rule: d.ruleId, ...(d.quotaId ? { quotaId: d.quotaId } : {}), reason: d.reason });
    } else out.truncated = true;
  }
  return out;
}

/** Which tools a rulebook's quotas cover, so the caller loads only that usage. */
export function quotaTools(rb: Rulebook, registry: ToolRegistry = builtinRegistry): string[] {
  const tools = new Set<string>();
  for (const q of quotasOf(rb)) {
    if (q.tool !== undefined) tools.add(q.tool);
    else for (const spec of registry.list()) if (ruleTargets(q, spec, spec.name)) tools.add(spec.name);
  }
  return [...tools].sort();
}
