import { z } from "zod";
import { formatINR } from "./describe";
import { TOOLS, isKnownTool } from "./tools";

// Unusual-behaviour detection: pure functions over an agent's own decision receipts.
// Each finding says, in plain words, what was unusual and the numbers behind it.

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

export const DETECTORS = ["volume_spike", "off_hours", "new_counterparty", "new_tool", "refusal_surge", "amount_outlier"] as const;
export type Detector = (typeof DETECTORS)[number];

export const DETECTOR_LABELS: Record<Detector, string> = {
  volume_spike: "Unusual number of calls",
  off_hours: "Activity at an unusual time",
  new_counterparty: "New counterparty",
  new_tool: "First use of a tool",
  refusal_surge: "Many refused calls",
  amount_outlier: "Unusually large amount",
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** How far back the baseline looks. */
export const BASELINE_DAYS = 14;
/** How far back "seen before" looks for tools and counterparties. */
export const MEMORY_DAYS = 90;

// ---- Settings ----

const ratio = z.number().min(0).max(1);
const multiplier = z.number().min(1).max(1000);
const calls = z.number().int().min(1).max(100_000);

export const BehaviourSettingsSchema = z
  .object({
    learningDays: z.number().int().min(0).max(30),
    volumeSpike: z.object({ enabled: z.boolean(), minCalls: calls, medium: multiplier, high: multiplier }).strict(),
    offHours: z.object({ enabled: z.boolean(), minCalls: calls, maxShare: ratio }).strict(),
    newCounterparty: z.object({ enabled: z.boolean() }).strict(),
    newTool: z.object({ enabled: z.boolean() }).strict(),
    refusalSurge: z.object({ enabled: z.boolean(), minCalls: calls, medium: ratio, high: ratio }).strict(),
    amountOutlier: z.object({ enabled: z.boolean(), minSamples: z.number().int().min(2).max(10_000), medium: multiplier, high: multiplier }).strict(),
  })
  .strict()
  .refine((s) => s.volumeSpike.high >= s.volumeSpike.medium && s.refusalSurge.high >= s.refusalSurge.medium && s.amountOutlier.high >= s.amountOutlier.medium, {
    message: "Each high threshold must be at least its medium threshold.",
  });

export type BehaviourSettings = z.infer<typeof BehaviourSettingsSchema>;

export const BEHAVIOUR_DEFAULTS: BehaviourSettings = {
  learningDays: 7,
  // Robust z-score of the last hour against the agent's busy hours: (calls - median) / max(1.4826 × MAD, √median, 1).
  volumeSpike: { enabled: true, minCalls: 20, medium: 6, high: 12 },
  // An hour of the week (±1 hour) that held at most this share of the baseline's calls.
  offHours: { enabled: true, minCalls: 3, maxShare: 0.005 },
  newCounterparty: { enabled: true },
  newTool: { enabled: true },
  // Refused share in the last hour minus the baseline's refused share.
  refusalSurge: { enabled: true, minCalls: 10, medium: 0.3, high: 0.6 },
  // Robust z-score of an amount against earlier amounts for the same tool.
  amountOutlier: { enabled: true, minSamples: 5, medium: 6, high: 15 },
};

/** Stored settings (any shape) merged over the defaults; anything invalid falls back to the defaults. */
export function resolveSettings(stored: unknown): BehaviourSettings {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return BEHAVIOUR_DEFAULTS;
  const s = stored as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...BEHAVIOUR_DEFAULTS };
  for (const [k, v] of Object.entries(BEHAVIOUR_DEFAULTS)) {
    if (!(k in s)) continue;
    merged[k] = typeof v === "object" && s[k] && typeof s[k] === "object" ? { ...v, ...(s[k] as object) } : s[k];
  }
  const r = BehaviourSettingsSchema.safeParse(merged);
  return r.success ? r.data : BEHAVIOUR_DEFAULTS;
}

// ---- Events ----

/** One decision receipt, reduced to what the detectors need. */
export interface BehaviourEvent {
  seq: number;
  /** Milliseconds since the epoch. */
  ts: number;
  tool: string;
  decision: "allow" | "ask" | "refuse";
  summary: Record<string, unknown>;
}

/** Display identifiers that name who an action deals with, grouped. The first field present in a group wins. */
export const COUNTERPARTY_GROUPS: { group: string; label: string; fields: string[] }[] = [
  { group: "vendor", label: "vendor", fields: ["vendor", "vendor_id"] },
  { group: "domain", label: "recipient domain", fields: ["to_domain", "recipient_domain"] },
  { group: "payee", label: "payee", fields: ["payee", "payee_id"] },
  { group: "account", label: "account", fields: ["account", "account_id"] },
  { group: "customer", label: "customer", fields: ["customer", "customer_id"] },
];

export const COUNTERPARTY_FIELDS = COUNTERPARTY_GROUPS.flatMap((g) => g.fields);

export interface Counterparty {
  /** "vendor:sharma traders" */
  key: string;
  group: string;
  label: string;
  value: string;
}

export function counterpartyKey(group: string, value: string): string {
  return `${group}:${value.trim().toLowerCase()}`;
}

export function counterpartiesOf(summary: Record<string, unknown>): Counterparty[] {
  const out: Counterparty[] = [];
  for (const g of COUNTERPARTY_GROUPS) {
    for (const f of g.fields) {
      const v = summary[f];
      if ((typeof v === "string" && v.trim()) || typeof v === "number") {
        const value = String(v).trim();
        out.push({ key: counterpartyKey(g.group, value), group: g.group, label: g.label, value });
        break;
      }
    }
  }
  return out;
}

const AMOUNT_FIELD = /(^amount($|_)|_amount$)/;

/** The money amount in a summary, if the tool has one. */
export function amountOf(summary: Record<string, unknown>): { field: string; value: number } | null {
  for (const [k, v] of Object.entries(summary)) {
    if (AMOUNT_FIELD.test(k) && typeof v === "number" && Number.isFinite(v)) return { field: k, value: v };
  }
  return null;
}

export function formatAmount(field: string, value: number): string {
  return field === "amount_inr" ? formatINR(value) : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function toolLabel(tool: string): string {
  return isKnownTool(tool) ? `“${TOOLS[tool].label}” (${tool})` : tool;
}

// ---- Robust statistics ----

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Median absolute deviation. */
export function mad(values: readonly number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** Median, MAD and the robust scale (1.4826 × MAD, never below `floor`). */
export function robustStats(values: readonly number[], floor = 1) {
  const m = median(values);
  const d = mad(values);
  return { median: m, mad: d, scale: Math.max(1.4826 * d, floor) };
}

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;
const pct = (r: number) => `${Math.round(r * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- Time ----

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "numeric", hourCycle: "h23" });
    }
    formatters.set(timeZone, f);
  }
  return f;
}

const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Hour of the week in a time zone: 0 = Monday 00:00–01:00, 167 = Sunday 23:00–24:00. */
export function hourOfWeek(ts: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(ts));
  const day = SHORT_DAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Mon");
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  return Math.max(0, day) * 24 + hour;
}

export function hourOfWeekLabel(slot: number): string {
  const h = slot % 24;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAYS[Math.floor(slot / 24) % 7]} ${two(h)}:00–${two((h + 1) % 24)}:00`;
}

// ---- Learning ----

export interface LearningStatus {
  learning: boolean;
  /** Whole days since the agent's first action, capped at `needed`. */
  days: number;
  needed: number;
  label: string;
}

export function learningStatus(firstActivityAt: number | null, now: number, settings: BehaviourSettings): LearningStatus {
  const needed = settings.learningDays;
  const days = firstActivityAt === null ? 0 : Math.min(needed, Math.max(0, Math.floor((now - firstActivityAt) / DAY)));
  const learning = needed > 0 && (firstActivityAt === null || now - firstActivityAt < needed * DAY);
  return { learning, days, needed, label: learning ? `Learning: ${days} of ${needed} days` : "Learning complete" };
}

// ---- Findings ----

export interface Finding {
  detector: Detector;
  /** With the agent and detector, identifies one alert: only one stays open per key. */
  key: string;
  severity: Severity;
  title: string;
  explanation: string;
  numbers: Record<string, number | string>;
  /** Receipts the finding is about (at most 50). */
  seqs: number[];
}

const seqsOf = (events: readonly BehaviourEvent[]) => events.slice(-50).map((e) => e.seq);

export interface EventContext {
  agent: string;
  settings: BehaviourSettings;
  /** Tools the agent used before this event. */
  seenTools: ReadonlySet<string>;
  /** Counterparty keys (see `counterpartyKey`) seen before this event. */
  seenCounterparties: ReadonlySet<string>;
  /** Earlier amounts for this event's tool and amount field. */
  amounts: readonly number[];
}

/** The cheap per-call checks: a new tool, a new counterparty, an outlying amount. */
export function checkEvent(e: BehaviourEvent, ctx: EventContext): Finding[] {
  const out: Finding[] = [];
  const s = ctx.settings;
  const outcome = e.decision === "refuse" ? " It was refused." : e.decision === "ask" ? " It is waiting for a person." : "";
  const amount = amountOf(e.summary);
  if (s.newTool.enabled && !ctx.seenTools.has(e.tool)) {
    out.push({
      detector: "new_tool",
      key: `tool:${e.tool}`,
      severity: "low",
      title: `First use of ${isKnownTool(e.tool) ? `“${TOOLS[e.tool].label}”` : e.tool}`,
      explanation: `${ctx.agent} used ${toolLabel(e.tool)} for the first time (receipt ${e.seq}).${outcome}`,
      numbers: { tool: e.tool, receipt: e.seq, "tools used before": ctx.seenTools.size },
      seqs: [e.seq],
    });
  }
  if (s.newCounterparty.enabled) {
    for (const c of counterpartiesOf(e.summary)) {
      if (ctx.seenCounterparties.has(c.key)) continue;
      const money = amount ? ` for ${formatAmount(amount.field, amount.value)}` : "";
      out.push({
        detector: "new_counterparty",
        key: c.key,
        severity: amount ? "medium" : "low",
        title: `New ${c.label}: ${c.value}`,
        explanation: `${ctx.agent} dealt with the ${c.label} “${c.value}” for the first time: ${toolLabel(e.tool)}${money} (receipt ${e.seq}).${outcome} It has not dealt with this ${c.label} in the last ${MEMORY_DAYS} days.`,
        numbers: { [c.label]: c.value, tool: e.tool, receipt: e.seq, ...(amount ? { amount: amount.value } : {}) },
        seqs: [e.seq],
      });
    }
  }
  if (s.amountOutlier.enabled && amount && ctx.amounts.length >= s.amountOutlier.minSamples) {
    const st = robustStats(ctx.amounts, Math.max(1, 0.1 * Math.abs(median(ctx.amounts))));
    const largest = Math.max(...ctx.amounts);
    const z = (amount.value - st.median) / st.scale;
    if (amount.value > largest && z >= s.amountOutlier.medium) {
      const f = (n: number) => formatAmount(amount.field, n);
      out.push({
        detector: "amount_outlier",
        key: `tool:${e.tool}`,
        severity: z >= s.amountOutlier.high ? "high" : "medium",
        title: `Unusually large amount: ${f(amount.value)}`,
        explanation: `${f(amount.value)} for ${toolLabel(e.tool)} is far above what ${ctx.agent} usually handles: typically ${f(st.median)}, and the largest before was ${f(largest)} (${plural(ctx.amounts.length, "earlier action")}). Receipt ${e.seq}.${outcome}`,
        numbers: { amount: amount.value, median: st.median, largest, samples: ctx.amounts.length, "robust z": round(z) },
        seqs: [e.seq],
      });
    }
  }
  return out;
}

export interface AgentHistory {
  agent: string;
  /** Decision events from at least BASELINE_DAYS before `now` up to `now`, in seq order. */
  events: readonly BehaviourEvent[];
  /** Tools and counterparty keys seen before the earliest event (longer memory). */
  seenTools?: Iterable<string>;
  seenCounterparties?: Iterable<string>;
  firstActivityAt: number | null;
}

export interface AnalyseOptions {
  now: number;
  timeZone: string;
  settings: BehaviourSettings;
  /** Event checks look at events from here on. Default: the last hour. */
  scanFrom?: number;
}

function hourlyCounts(events: readonly BehaviourEvent[]): number[] {
  const byHour = new Map<number, number>();
  for (const e of events) {
    const h = Math.floor(e.ts / HOUR);
    byHour.set(h, (byHour.get(h) ?? 0) + 1);
  }
  return [...byHour.values()];
}

function volumeFinding(agent: string, what: string, key: string, recent: readonly BehaviourEvent[], baseline: readonly BehaviourEvent[], s: BehaviourSettings["volumeSpike"]): Finding | null {
  const counts = hourlyCounts(baseline);
  if (counts.length < 3 || recent.length < s.minCalls) return null;
  // Counts are roughly Poisson, so the spread is never taken as less than √median.
  const st = robustStats(counts, Math.sqrt(median(counts)));
  const z = (recent.length - st.median) / st.scale;
  if (z < s.medium) return null;
  return {
    detector: "volume_spike",
    key,
    severity: z >= s.high ? "high" : "medium",
    title: key === "all" ? "Unusual number of calls" : `Unusual number of calls to ${what}`,
    explanation: `${agent} made ${plural(recent.length, "call")}${key === "all" ? "" : ` to ${what}`} in the last hour. In a typical busy hour over the last ${BASELINE_DAYS} days it made ${round(st.median)} (usual spread ${round(st.mad)}, across ${plural(counts.length, "active hour")}).`,
    numbers: { "calls in the last hour": recent.length, "typical calls per active hour": round(st.median), "median absolute deviation": round(st.mad), "active hours in baseline": counts.length, "robust z": round(z) },
    seqs: seqsOf(recent),
  };
}

/** Every detector over one agent's history. No findings while the agent is still learning. */
export function analyseAgent(h: AgentHistory, o: AnalyseOptions): { learning: LearningStatus; findings: Finding[] } {
  const s = o.settings;
  const learning = learningStatus(h.firstActivityAt, o.now, s);
  if (learning.learning) return { learning, findings: [] };
  const windowStart = o.now - HOUR;
  const baselineStart = o.now - BASELINE_DAYS * DAY;
  const baseline = h.events.filter((e) => e.ts >= baselineStart && e.ts < windowStart);
  const recent = h.events.filter((e) => e.ts >= windowStart && e.ts <= o.now);
  const findings: Finding[] = [];

  if (s.volumeSpike.enabled) {
    const all = volumeFinding(h.agent, "", "all", recent, baseline, s.volumeSpike);
    if (all) findings.push(all);
    for (const tool of new Set(recent.map((e) => e.tool))) {
      const f = volumeFinding(h.agent, toolLabel(tool), `tool:${tool}`, recent.filter((e) => e.tool === tool), baseline.filter((e) => e.tool === tool), s.volumeSpike);
      if (f) findings.push(f);
    }
  }

  if (s.offHours.enabled && baseline.length) {
    const slots = new Array<number>(168).fill(0);
    for (const e of baseline) slots[hourOfWeek(e.ts, o.timeZone)]! += 1;
    const bySlot = new Map<number, BehaviourEvent[]>();
    for (const e of recent) {
      const slot = hourOfWeek(e.ts, o.timeZone);
      const list = bySlot.get(slot) ?? [];
      list.push(e);
      bySlot.set(slot, list);
    }
    for (const [slot, evs] of bySlot) {
      if (evs.length < s.offHours.minCalls) continue;
      const around = slots[(slot + 167) % 168]! + slots[slot]! + slots[(slot + 1) % 168]!;
      const share = around / baseline.length;
      if (share > s.offHours.maxShare) continue;
      findings.push({
        detector: "off_hours",
        key: `hour:${slot}`,
        severity: evs.length >= Math.max(10, s.offHours.minCalls * 3) ? "medium" : "low",
        title: "Activity at an unusual time",
        explanation: `${h.agent} made ${plural(evs.length, "call")} on ${hourOfWeekLabel(slot)} (${o.timeZone}). Over the last ${BASELINE_DAYS} days it made ${around} of its ${baseline.length} calls within an hour of that time of the week.`,
        numbers: { "calls in that hour": evs.length, "baseline calls near this time": around, "baseline calls": baseline.length, "share near this time": pct(share) },
        seqs: seqsOf(evs),
      });
    }
  }

  if (s.refusalSurge.enabled && recent.length >= s.refusalSurge.minCalls && baseline.length) {
    const refusedNow = recent.filter((e) => e.decision === "refuse").length;
    const rateNow = refusedNow / recent.length;
    const rateBase = baseline.filter((e) => e.decision === "refuse").length / baseline.length;
    const diff = rateNow - rateBase;
    if (diff >= s.refusalSurge.medium) {
      findings.push({
        detector: "refusal_surge",
        key: "all",
        severity: diff >= s.refusalSurge.high ? "high" : "medium",
        title: "Many refused calls",
        explanation: `${refusedNow} of ${h.agent}'s ${recent.length} calls in the last hour were refused (${pct(rateNow)}). Over the last ${BASELINE_DAYS} days ${pct(rateBase)} were refused.`,
        numbers: { "refused in the last hour": refusedNow, "calls in the last hour": recent.length, "refused share now": pct(rateNow), "refused share in baseline": pct(rateBase) },
        seqs: seqsOf(recent.filter((e) => e.decision === "refuse")),
      });
    }
  }

  // Per-event checks, in order, each against everything before it.
  const seenTools = new Set(h.seenTools ?? []);
  const seenCounterparties = new Set(h.seenCounterparties ?? []);
  const amounts = new Map<string, number[]>();
  const scanFrom = o.scanFrom ?? windowStart;
  for (const e of h.events) {
    const amount = amountOf(e.summary);
    const amountKey = amount ? `${e.tool}|${amount.field}` : "";
    if (e.ts >= scanFrom && e.ts <= o.now) {
      findings.push(...checkEvent(e, { agent: h.agent, settings: s, seenTools, seenCounterparties, amounts: amounts.get(amountKey) ?? [] }));
    }
    seenTools.add(e.tool);
    for (const c of counterpartiesOf(e.summary)) seenCounterparties.add(c.key);
    if (amount && e.ts >= baselineStart) {
      const list = amounts.get(amountKey) ?? [];
      list.push(amount.value);
      amounts.set(amountKey, list);
    }
  }
  return { learning, findings: dedupe(findings) };
}

/** One finding per detector and key: the most severe, then the first. */
export function dedupe(findings: readonly Finding[]): Finding[] {
  const out = new Map<string, Finding>();
  for (const f of findings) {
    const k = `${f.detector}|${f.key}`;
    const prev = out.get(k);
    if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) out.set(k, f);
  }
  return [...out.values()];
}
