import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BEHAVIOUR_DEFAULTS,
  BehaviourSettingsSchema,
  amountOf,
  analyseAgent,
  checkEvent,
  counterpartiesOf,
  counterpartyKey,
  dedupe,
  formatAmount,
  hourOfWeek,
  hourOfWeekLabel,
  learningStatus,
  mad,
  median,
  resolveSettings,
  robustStats,
  toolLabel,
  type BehaviourEvent,
  type BehaviourSettings,
  type Finding,
} from "../src/behaviour";

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Wednesday 2026-10-21 12:00 IST.
const NOW = Date.parse("2026-10-21T06:30:00Z");
const TZ = "Asia/Kolkata";
const S = BEHAVIOUR_DEFAULTS;

let seq = 0;
const ev = (ts: number, tool = "zoho.list_bills", decision: BehaviourEvent["decision"] = "allow", summary: Record<string, unknown> = {}): BehaviourEvent => ({ seq: ++seq, ts, tool, decision, summary });

/** Ten days of office-hours work: 3 calls an hour, 10:00–17:00 IST on weekdays, paying two known vendors. */
function history(days = 10): BehaviourEvent[] {
  const out: BehaviourEvent[] = [];
  for (let d = days; d >= 1; d--) {
    const day = NOW - d * DAY;
    const weekday = new Date(day + 5.5 * HOUR).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (let h = -2; h <= 5; h++) {
      const at = day + h * HOUR;
      out.push(ev(at, "zoho.list_bills"));
      out.push(ev(at + 60_000, "gmail.read_message", "allow", { from_domain: "kaveri.in" }));
      out.push(ev(at + 120_000, "zoho.record_bill_payment", "allow", { bill_id: `b${seq}`, amount_inr: 15000 + (seq % 7) * 1000, vendor: seq % 2 ? "Kaveri Logistics" : "Mehta Steel" }));
    }
  }
  return out;
}

const run = (events: BehaviourEvent[], settings: BehaviourSettings = S, extra: Partial<Parameters<typeof analyseAgent>[0]> = {}) =>
  analyseAgent({ agent: "ap-bot", events, firstActivityAt: events[0]?.ts ?? null, ...extra }, { now: NOW, timeZone: TZ, settings });

const of = (findings: Finding[], detector: Finding["detector"]) => findings.filter((f) => f.detector === detector);

describe("robust statistics", () => {
  it("median and MAD", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
    expect(robustStats([5, 5, 5])).toEqual({ median: 5, mad: 0, scale: 1 });
    expect(robustStats([5, 5, 5], 3).scale).toBe(3);
  });

  it("the median and MAD ignore a single wild value (properties)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 5, maxLength: 60 }), fc.integer({ min: 1_000_000, max: 1e9 }), (xs, wild) => {
        const m = median(xs);
        const withWild = median([...xs, wild]);
        const sorted = [...xs].sort((a, b) => a - b);
        expect(withWild).toBeGreaterThanOrEqual(m);
        expect(withWild).toBeLessThanOrEqual(sorted[Math.ceil(xs.length / 2)] ?? m);
        expect(mad(xs)).toBeGreaterThanOrEqual(0);
        expect(Math.min(...xs) <= m && m <= Math.max(...xs)).toBe(true);
      }),
    );
  });
});

describe("settings", () => {
  it("defaults are valid and stored values merge over them", () => {
    expect(BehaviourSettingsSchema.safeParse(S).success).toBe(true);
    expect(resolveSettings(null)).toBe(S);
    expect(resolveSettings([1])).toBe(S);
    const r = resolveSettings({ learningDays: 3, volumeSpike: { minCalls: 5 }, unknown: 1 });
    expect(r.learningDays).toBe(3);
    expect(r.volumeSpike).toEqual({ ...S.volumeSpike, minCalls: 5 });
  });
  it("invalid values fall back to the defaults", () => {
    expect(resolveSettings({ learningDays: -1 })).toBe(S);
    expect(resolveSettings({ volumeSpike: { medium: 10, high: 5 } })).toBe(S);
    expect(resolveSettings({ refusalSurge: { medium: 2 } })).toBe(S);
  });
});

describe("summaries", () => {
  it("finds counterparties by group, preferring the name", () => {
    expect(counterpartiesOf({ vendor: "Sharma Traders", vendor_id: "v1", to_domain: "Sharma.in", bill: "X" })).toEqual([
      { key: "vendor:sharma traders", group: "vendor", label: "vendor", value: "Sharma Traders" },
      { key: "domain:sharma.in", group: "domain", label: "recipient domain", value: "Sharma.in" },
    ]);
    expect(counterpartiesOf({ account_id: 42, vendor: " " })).toEqual([{ key: "account:42", group: "account", label: "account", value: "42" }]);
    expect(counterpartiesOf({ from_domain: "x.in" })).toEqual([]);
    expect(counterpartyKey("vendor", " Sharma ")).toBe("vendor:sharma");
  });
  it("finds amounts", () => {
    expect(amountOf({ amount_inr: 5 })).toEqual({ field: "amount_inr", value: 5 });
    expect(amountOf({ refund_amount: 2 })).toEqual({ field: "refund_amount", value: 2 });
    expect(amountOf({ amount: "5" })).toBeNull();
    expect(amountOf({ amounts: 5 })).toBeNull();
    expect(formatAmount("amount_inr", 200000)).toBe("₹2,00,000");
    expect(formatAmount("amount", 1234.5)).toBe("1,234.5");
    expect(toolLabel("zoho.record_bill_payment")).toBe("“Record a payment” (zoho.record_bill_payment)");
    expect(toolLabel("crm.refund")).toBe("crm.refund");
  });
});

describe("time", () => {
  it("hour of the week in the org's time zone", () => {
    expect(hourOfWeek(NOW, TZ)).toBe(2 * 24 + 12); // Wednesday 12:00 IST
    expect(hourOfWeek(NOW, "UTC")).toBe(2 * 24 + 6);
    expect(hourOfWeek(NOW, "Not/AZone")).toBe(2 * 24 + 6);
    expect(hourOfWeekLabel(0)).toBe("Monday 00:00–01:00");
    expect(hourOfWeekLabel(167)).toBe("Sunday 23:00–00:00");
  });
  it("is always 0–167 (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 4e12 }), fc.constantFrom("UTC", TZ, "America/New_York"), (t, tz) => {
      const h = hourOfWeek(t, tz);
      expect(Number.isInteger(h) && h >= 0 && h < 168).toBe(true);
    }));
  });
});

describe("learning", () => {
  it("counts days since the first action", () => {
    expect(learningStatus(null, NOW, S)).toMatchObject({ learning: true, days: 0, label: "Learning: 0 of 7 days" });
    expect(learningStatus(NOW - 3.5 * DAY, NOW, S)).toMatchObject({ learning: true, days: 3, label: "Learning: 3 of 7 days" });
    expect(learningStatus(NOW - 8 * DAY, NOW, S)).toMatchObject({ learning: false, days: 7, label: "Learning complete" });
    expect(learningStatus(null, NOW, { ...S, learningDays: 0 }).learning).toBe(false);
  });
  it("no findings during the learning period, whatever happens (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ dt: fc.integer({ min: 0, max: 6 * DAY }), tool: fc.constantFrom("a.x", "b.y"), refuse: fc.boolean(), amount: fc.integer({ min: 1, max: 1e9 }) }), { maxLength: 80 }), (rows) => {
        const events = rows.map((r) => ev(NOW - r.dt, r.tool, r.refuse ? "refuse" : "allow", { amount: r.amount, vendor: `v${r.amount}` })).sort((a, b) => a.ts - b.ts);
        expect(analyseAgent({ agent: "a", events, firstActivityAt: NOW - 6 * DAY }, { now: NOW, timeZone: TZ, settings: S }).findings).toEqual([]);
      }),
    );
  });
});

describe("detectors", () => {
  it("a normal hour raises nothing", () => {
    const h = history();
    const now = [ev(NOW - 30 * 60_000, "zoho.list_bills"), ev(NOW - 20 * 60_000, "zoho.record_bill_payment", "allow", { amount_inr: 17000, vendor: "Kaveri Logistics" })];
    const r = run([...h, ...now]);
    expect(r.learning.learning).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("volume spike: overall and per tool, with the numbers", () => {
    const burst = Array.from({ length: 60 }, (_, i) => ev(NOW - 50 * 60_000 + i * 1000, "zoho.list_bills"));
    const f = of(run([...history(), ...burst]).findings, "volume_spike");
    expect(f.map((x) => x.key).sort()).toEqual(["all", "tool:zoho.list_bills"]);
    const all = f.find((x) => x.key === "all")!;
    expect(all.severity).toBe("high");
    expect(all.numbers["calls in the last hour"]).toBe(60);
    expect(all.numbers["typical calls per active hour"]).toBe(3);
    expect(all.explanation).toMatch(/^ap-bot made 60 calls in the last hour\. In a typical busy hour over the last 14 days it made 3/);
    expect(all.seqs.length).toBe(50);
    // A smaller burst is medium; below minCalls nothing.
    const medium = Array.from({ length: 20 }, (_, i) => ev(NOW - 50 * 60_000 + i * 1000, "zoho.list_bills"));
    expect(of(run([...history(), ...medium]).findings, "volume_spike").find((x) => x.key === "all")?.severity).toBe("medium");
    expect(of(run([...history(), ...medium], { ...S, volumeSpike: { ...S.volumeSpike, minCalls: 50 } }).findings, "volume_spike")).toEqual([]);
    expect(of(run([...history(), ...burst], { ...S, volumeSpike: { ...S.volumeSpike, enabled: false } }).findings, "volume_spike")).toEqual([]);
  });

  it("off-hours: activity when the agent is never active, in the org's time zone", () => {
    // Wednesday 03:00 IST.
    const night = NOW - 9 * HOUR;
    const calls = [0, 1, 2, 3].map((i) => ev(night + i * 60_000, "zoho.list_bills"));
    const r = analyseAgent({ agent: "ap-bot", events: [...history(), ...calls], firstActivityAt: NOW - 10 * DAY }, { now: night + 30 * 60_000, timeZone: TZ, settings: S });
    const f = of(r.findings, "off_hours");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: `hour:${2 * 24 + 3}`, severity: "low" });
    expect(f[0]!.explanation).toContain("Wednesday 03:00–04:00 (Asia/Kolkata)");
    expect(f[0]!.numbers["baseline calls near this time"]).toBe(0);
    // In UTC the same calls are at 21:30, still unusual; in office hours nothing.
    expect(of(run([...history(), ...[0, 1, 2, 3].map((i) => ev(NOW - 40 * 60_000 + i * 60_000))]).findings, "off_hours")).toEqual([]);
  });

  it("refusal surge: refused share far above the baseline", () => {
    const refused = Array.from({ length: 12 }, (_, i) => ev(NOW - 40 * 60_000 + i * 60_000, "zoho.update_vendor", i < 10 ? "refuse" : "allow"));
    const seen = { seenTools: ["zoho.update_vendor"] };
    const f = of(run([...history(), ...refused], S, seen).findings, "refusal_surge");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: "all", severity: "high" });
    expect(f[0]!.explanation).toBe("10 of ap-bot's 12 calls in the last hour were refused (83%). Over the last 14 days 0% were refused.");
    const few = refused.slice(0, 9);
    expect(of(run([...history(), ...few], S, seen).findings, "refusal_surge")).toEqual([]);
  });

  it("new counterparty and new tool: first time only, money makes it medium", () => {
    const h = history();
    const pay = ev(NOW - 10 * 60_000, "zoho.record_bill_payment", "ask", { bill_id: "b9", amount_inr: 18000, vendor: "Sharma Traders" });
    const reply = ev(NOW - 5 * 60_000, "gmail.send_reply", "refuse", { to_domain: "sharma.in" });
    const f = run([...h, pay, reply]).findings;
    const cp = of(f, "new_counterparty");
    expect(cp.map((x) => [x.key, x.severity])).toEqual([
      ["vendor:sharma traders", "medium"],
      ["domain:sharma.in", "low"],
    ]);
    expect(cp[0]!.title).toBe("New vendor: Sharma Traders");
    expect(cp[0]!.explanation).toContain("for ₹18,000");
    expect(cp[0]!.explanation).toContain("It is waiting for a person.");
    const tools = of(f, "new_tool");
    expect(tools.map((x) => x.key)).toEqual(["tool:gmail.send_reply"]);
    expect(tools[0]!.explanation).toBe("ap-bot used “Send a reply” (gmail.send_reply) for the first time (receipt " + reply.seq + "). It was refused.");
    // Seen before (longer memory) means not new.
    expect(of(run([...h, pay, reply], S, { seenCounterparties: ["vendor:sharma traders", "domain:sharma.in"], seenTools: ["gmail.send_reply"] }).findings, "new_counterparty")).toEqual([]);
    // Switched off.
    expect(run([...h, pay, reply], { ...S, newCounterparty: { enabled: false }, newTool: { enabled: false } }).findings).toEqual([]);
  });

  it("amount outlier: far above the usual, for the same tool", () => {
    const big = ev(NOW - 10 * 60_000, "zoho.record_bill_payment", "ask", { amount_inr: 200000, vendor: "Kaveri Logistics" });
    const f = of(run([...history(), big]).findings, "amount_outlier");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: "tool:zoho.record_bill_payment", severity: "high" });
    expect(f[0]!.explanation).toMatch(/^₹2,00,000 for “Record a payment” \(zoho.record_bill_payment\) is far above what ap-bot usually handles: typically ₹1[0-9],000, and the largest before was ₹21,000/);
    const medium = ev(NOW - 10 * 60_000, "zoho.record_bill_payment", "allow", { amount_inr: 40000, vendor: "Kaveri Logistics" });
    expect(of(run([...history(), medium]).findings, "amount_outlier")[0]?.severity).toBe("medium");
    const usual = ev(NOW - 10 * 60_000, "zoho.record_bill_payment", "allow", { amount_inr: 21000, vendor: "Kaveri Logistics" });
    expect(of(run([...history(), usual]).findings, "amount_outlier")).toEqual([]);
    // Too few earlier amounts: no judgement.
    expect(checkEvent(big, { agent: "a", settings: S, seenTools: new Set(["zoho.record_bill_payment"]), seenCounterparties: new Set(["vendor:kaveri logistics"]), amounts: [1, 2] })).toEqual([]);
  });

  it("dedupe keeps the most severe finding per key", () => {
    const base: Finding = { detector: "new_tool", key: "k", severity: "low", title: "", explanation: "", numbers: {}, seqs: [] };
    expect(dedupe([base, { ...base, severity: "high" }, { ...base, severity: "medium" }, { ...base, key: "j" }]).map((f) => f.severity)).toEqual(["high", "low"]);
  });

  it("findings are well-formed for any history (property)", () => {
    const row = fc.record({
      dt: fc.integer({ min: 0, max: 14 * DAY }),
      tool: fc.constantFrom("zoho.record_bill_payment", "gmail.read_message", "crm.refund"),
      decision: fc.constantFrom("allow" as const, "ask" as const, "refuse" as const),
      amount: fc.option(fc.integer({ min: 0, max: 1e7 }), { nil: undefined }),
      vendor: fc.option(fc.constantFrom("A", "B", "C", "D"), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 150 }), (rows) => {
        const events = rows
          .map((r) => ({ ts: NOW - r.dt, tool: r.tool, decision: r.decision, summary: { ...(r.amount !== undefined ? { amount: r.amount } : {}), ...(r.vendor ? { vendor: r.vendor } : {}) } }))
          .sort((a, b) => a.ts - b.ts)
          .map((e, i) => ({ ...e, seq: i + 1 }));
        const r = analyseAgent({ agent: "a", events, firstActivityAt: NOW - 20 * DAY }, { now: NOW, timeZone: TZ, settings: S });
        const keys = new Set<string>();
        for (const f of r.findings) {
          expect(["low", "medium", "high"]).toContain(f.severity);
          expect(f.explanation.length).toBeGreaterThan(10);
          expect(f.seqs.length).toBeLessThanOrEqual(50);
          const k = `${f.detector}|${f.key}`;
          expect(keys.has(k)).toBe(false);
          keys.add(k);
          // Event findings only point at events in the scan window.
          if (["new_tool", "new_counterparty", "amount_outlier"].includes(f.detector)) for (const s of f.seqs) expect(events[s - 1]!.ts).toBeGreaterThanOrEqual(NOW - HOUR);
        }
      }),
    );
  });

  it("a known tool, vendor and usual amount never alert (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 15000, max: 21000 }), (amount) => {
        const e = ev(NOW - 60_000, "zoho.record_bill_payment", "allow", { amount_inr: amount, vendor: "Kaveri Logistics" });
        const amounts = Array.from({ length: 20 }, (_, i) => 15000 + (i % 7) * 1000);
        expect(checkEvent(e, { agent: "a", settings: S, seenTools: new Set(["zoho.record_bill_payment"]), seenCounterparties: new Set(["vendor:kaveri logistics"]), amounts })).toEqual([]);
      }),
    );
  });
});
