import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../src/engine";
import { quotaTools, quotaWindowStart, replayCounts, replayLookbackMs, replayRulebook, startOfDayIn, type ReplayCall, type UsageEvent } from "../src/replay";
import { durationMs, quotasOf, ruleTargets, validateRulebook, type Decision, type Quota, type Rulebook } from "../src/rulebook";
import { builtinRegistry, createRegistry, mergeRegistries, specFromJsonSchema } from "../src/tools";
import { sampleRulebook } from "./fixtures";

const rb = sampleRulebook();
const T0 = Date.parse("2026-10-20T04:00:00Z"); // 09:30 in India
const H = 3_600_000;
const pay = (amount_inr: number) => ({ bill_id: "b1", amount_inr });

function call(seq: number, ts: number, tool: string, args: Record<string, unknown> | undefined, decision: Decision, ruleId: string, ran = decision === "allow"): ReplayCall {
  return { seq, ts, tool, ...(args ? { args } : {}), original: { decision, ruleId }, ran };
}

function parse(doc: unknown): Rulebook {
  const r = validateRulebook(doc);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.rulebook;
}

const base = { version: 1, agent: "ap-bot", owner: "o@x.in", default: "refuse", approvers: { finance: ["o@x.in"] } };

describe("replayRulebook", () => {
  it("reports nothing for no history", () => {
    expect(replayRulebook({ rulebook: rb, calls: [], timeZone: "Asia/Kolkata" })).toMatchObject({ total: 0, judged: 0, notJudged: 0, changed: 0, changes: [], truncated: false });
  });

  it("finds calls a lower threshold would send for approval, and counts calls without arguments", () => {
    const draft = parse({ ...base, rules: [{ id: "pay-small", tool: "zoho.record_bill_payment", when: { amount_inr: { lte: 10000 } }, decide: "allow" }, { id: "pay-large", tool: "zoho.record_bill_payment", when: { amount_inr: { gt: 10000 } }, decide: "ask", approver: "finance" }] });
    const r = replayRulebook({
      rulebook: draft,
      timeZone: "Asia/Kolkata",
      calls: [
        call(1, T0, "zoho.record_bill_payment", pay(18000), "allow", "pay-small"),
        call(2, T0 + 1, "zoho.record_bill_payment", pay(5000), "allow", "pay-small"),
        call(3, T0 + 2, "zoho.record_bill_payment", undefined, "allow", "pay-small"),
        call(4, T0 + 3, "gmail.read_message", { message_id: "m" }, "allow", "read-mail"),
      ],
    });
    expect(r).toMatchObject({ total: 4, judged: 3, notJudged: 1, unchanged: 1, changed: 2 });
    expect(r.more).toEqual({ allow: 0, ask: 1, refuse: 1 });
    expect(r.fewer).toEqual({ allow: 2, ask: 0, refuse: 0 });
    expect(r.before).toEqual({ allow: 3, ask: 0, refuse: 0 });
    expect(r.after).toEqual({ allow: 1, ask: 1, refuse: 1 });
    expect(r.changes.map((c) => [c.seq, c.from, c.to, c.rule])).toEqual([
      [1, "allow", "ask", "pay-large"],
      [4, "allow", "refuse", "default"],
    ]);
    expect(r.changes[0]).toMatchObject({ fromRule: "pay-small", tool: "zoho.record_bill_payment", ts: T0 });
  });

  it("simulates a daily sum quota in order, in the org's time zone", () => {
    const draft = parse({ ...base, limits: { daily_payments_inr: 100000 }, rules: [{ id: "pay", tool: "zoho.record_bill_payment", decide: "allow" }] });
    const calls = [
      call(1, T0, "zoho.record_bill_payment", pay(60000), "allow", "pay"),
      call(2, T0 + H, "zoho.record_bill_payment", pay(30000), "allow", "pay"),
      call(3, T0 + 2 * H, "zoho.record_bill_payment", pay(20000), "allow", "pay"), // 1,10,000 today: over
      call(4, T0 + 15 * H, "zoho.record_bill_payment", pay(90000), "allow", "pay"), // 19:00 UTC = 00:30 the next day in India
    ];
    const r = replayRulebook({ rulebook: draft, calls, timeZone: "Asia/Kolkata" });
    expect(r.changes).toEqual([expect.objectContaining({ seq: 3, to: "ask", quotaId: "daily-payments", rule: "pay" })]);
    // In UTC the fourth call is still the same day.
    expect(replayRulebook({ rulebook: draft, calls, timeZone: "UTC" }).changes.map((c) => c.seq)).toEqual([3, 4]);
  });

  it("counts usage from other agents and older calls, and lets a rolling window expire", () => {
    const draft = parse({ ...base, quotas: [{ id: "two-an-hour", tag: "moves_money", window: "1h", max_count: 2 }], rules: [{ id: "pay", tag: "moves_money", decide: "allow" }] });
    const usage: UsageEvent[] = [{ ts: T0 - 30 * 60_000, tool: "zoho.record_bill_payment", values: {} }];
    const calls = [
      call(1, T0, "zoho.record_bill_payment", pay(1), "allow", "pay"), // 1 used: fine
      call(2, T0 + 60_000, "zoho.record_bill_payment", pay(1), "allow", "pay"), // 2 used: over
      call(3, T0 + 45 * 60_000, "zoho.record_bill_payment", pay(1), "allow", "pay"), // the older one left the window
    ];
    const r = replayRulebook({ rulebook: draft, calls, usage, timeZone: "UTC" });
    expect(r.changes.map((c) => [c.seq, c.to, c.reason])).toEqual([[2, "ask", 'This would go over the limit of 2 per 1h ("two-an-hour"). A person needs to approve it.']]);
  });

  it("refuses over a quota when there are no approvers", () => {
    const draft = parse({ ...base, approvers: {}, quotas: [{ id: "one", tool: "gmail.read_message", window: "day", max_count: 1 }], rules: [{ id: "read", tool: "gmail.read_message", decide: "allow" }] });
    const r = replayRulebook({ rulebook: draft, timeZone: "UTC", calls: [call(1, T0, "gmail.read_message", { message_id: "a" }, "allow", "read"), call(2, T0 + 1, "gmail.read_message", { message_id: "b" }, "allow", "read")] });
    expect(r.changes).toEqual([expect.objectContaining({ seq: 2, to: "refuse", quotaId: "one" })]);
  });

  it("does not count failed, refused or unapproved calls towards a quota", () => {
    const draft = parse({ ...base, quotas: [{ id: "one", tool: "zoho.record_bill_payment", window: "day", max_count: 1 }], rules: [{ id: "pay", tool: "zoho.record_bill_payment", decide: "allow" }] });
    const calls = [
      call(1, T0, "zoho.record_bill_payment", pay(1), "allow", "pay", false), // allowed but failed: it would fail again
      call(2, T0 + 1, "zoho.record_bill_payment", pay(1), "allow", "pay", true),
      call(3, T0 + 2, "zoho.record_bill_payment", pay(1), "allow", "pay", true),
    ];
    expect(replayRulebook({ rulebook: draft, calls, timeZone: "UTC" }).changes.map((c) => c.seq)).toEqual([3]);
  });

  it("passes lists for each tool and keeps the order of calls at the same moment", () => {
    const r = replayRulebook({
      rulebook: rb,
      timeZone: "UTC",
      lists: (tool) => (tool === "gmail.send_reply" ? { vendor_domains: ["sharma.in"] } : undefined),
      calls: [call(2, T0, "gmail.send_reply", { message_id: "m", to: "a@sharma.in", body: "" }, "refuse", "default"), call(1, T0, "gmail.send_reply", { message_id: "m", to: "a@other.in", body: "" }, "refuse", "default")],
    });
    expect(r.changes.map((c) => [c.seq, c.to])).toEqual([[2, "ask"]]);
  });

  it("returns at most maxChanges changed calls and says so", () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(i + 1, T0 + i, "zoho.update_vendor", { vendor_id: "v", fields: { ifsc: "X" } }, "allow", "old"));
    const r = replayRulebook({ rulebook: rb, calls, timeZone: "UTC", maxChanges: 2 });
    expect(r).toMatchObject({ changed: 5, truncated: true });
    expect(r.changes.map((c) => c.seq)).toEqual([1, 2]);
    expect(JSON.stringify(r)).not.toContain('"X"');
  });

  it("matches quotas on tools that are no longer in the registry", () => {
    const extra = createRegistry([specFromJsonSchema({ name: "crm.refund", connector: "crm", description: "", inputSchema: { type: "object", properties: { amount: { type: "number" } } }, tags: ["moves_money"] })]);
    const registry = mergeRegistries(builtinRegistry, extra);
    const r = validateRulebook({ ...base, quotas: [{ id: "q", tool: "crm.refund", window: "2h", max_sum: { field: "amount", value: 100 } }], rules: [{ id: "r", tool: "crm.refund", decide: "allow" }] }, registry);
    if (!r.ok) throw new Error(r.errors.join());
    expect(quotaTools(r.rulebook, registry)).toEqual(["crm.refund"]);
    // Replayed against the built-in registry only, a rule and quota naming the tool still apply.
    const out = replayRulebook({ rulebook: r.rulebook, timeZone: "UTC", calls: [call(1, T0, "crm.refund", { amount: 80 }, "allow", "r"), call(2, T0 + 1, "crm.refund", { amount: 80 }, "allow", "r")] });
    expect(out.changes.map((c) => [c.seq, c.to, c.quotaId])).toEqual([[2, "ask", "q"]]);
    const known = replayRulebook({ rulebook: r.rulebook, registry, timeZone: "UTC", calls: [call(1, T0, "crm.refund", { amount: 80 }, "allow", "r"), call(2, T0 + 1, "crm.refund", { amount: 80 }, "allow", "r")] });
    expect(known.changes.map((c) => [c.seq, c.to])).toEqual([[2, "ask"]]);
  });
});

describe("replay helpers", () => {
  it("decides which replayed calls use up quota", () => {
    expect(replayCounts("allow", { original: { decision: "allow", ruleId: "x" }, ran: true })).toBe(true);
    expect(replayCounts("allow", { original: { decision: "allow", ruleId: "x" }, ran: false })).toBe(false);
    expect(replayCounts("allow", { original: { decision: "refuse", ruleId: "x" }, ran: false })).toBe(true);
    expect(replayCounts("ask", { original: { decision: "ask", ruleId: "x" }, ran: true })).toBe(true);
    expect(replayCounts("ask", { original: { decision: "allow", ruleId: "x" }, ran: true })).toBe(false);
    expect(replayCounts("refuse", { original: { decision: "allow", ruleId: "x" }, ran: true })).toBe(false);
  });
  it("finds window starts and how far back to load usage", () => {
    expect(quotaWindowStart({ window: "1h" }, T0, "UTC")).toBe(T0 - H);
    expect(quotaWindowStart({ window: "day" }, T0, "Asia/Kolkata")).toBe(Date.parse("2026-10-19T18:30:00Z"));
    expect(startOfDayIn("UTC", new Date(T0)).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(replayLookbackMs(parse({ ...base, rules: [] }))).toBe(0);
    expect(replayLookbackMs(rb)).toBe(25 * H);
    expect(replayLookbackMs(parse({ ...base, quotas: [{ id: "q", tool: "gmail.search", window: "7d", max_count: 9 }], rules: [] }))).toBe(7 * 86_400_000);
    expect(replayLookbackMs(parse({ ...base, quotas: [{ id: "q", tool: "gmail.search", window: "999d", max_count: 9 }], rules: [] }))).toBe(90 * 86_400_000);
    expect(quotaTools(parse({ ...base, quotas: [{ id: "q", tag: "sends_external", window: "day", max_count: 9 }], rules: [] }))).toEqual(["gmail.send_reply"]);
  });
});

// ---- Properties ----

const TOOLS = ["zoho.record_bill_payment", "zoho.create_bill", "gmail.read_message", "gmail.send_reply"] as const;
const ZONES = ["Asia/Kolkata", "UTC", "America/New_York"];

type Of<A> = A extends fc.Arbitrary<infer T> ? T : never;

const ruleArb = fc.record({
  target: fc.constantFrom<string>(...TOOLS, "tag:moves_money", "tag:reads_data"),
  op: fc.constantFrom("none", "lte", "gt"),
  value: fc.integer({ min: 0, max: 100_000 }),
  decide: fc.constantFrom<Decision>("allow", "ask", "refuse"),
});
const quotaArb = fc.record({
  target: fc.constantFrom<string>("zoho.record_bill_payment", "tag:moves_money", "gmail.read_message"),
  window: fc.constantFrom("day", "1h", "6h", "30m"),
  count: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
  sum: fc.option(fc.integer({ min: 1, max: 300_000 }), { nil: undefined }),
  approver: fc.boolean(),
});

function makeRulebook(rules: Of<typeof ruleArb>[], quotas: Of<typeof quotaArb>[]): Rulebook {
  const target = (t: string) => (t.startsWith("tag:") ? { tag: t.slice(4) } : { tool: t });
  return parse({
    ...base,
    rules: rules.map((r, i) => ({
      id: `r${i}`,
      ...target(r.target),
      ...(r.op !== "none" && (r.target.includes("zoho") || r.target === "tag:moves_money") ? { when: { amount_inr: { [r.op]: r.value } } } : {}),
      decide: r.decide,
      ...(r.decide === "ask" ? { approver: "finance" } : {}),
    })),
    quotas: quotas.map((q, i) => ({
      id: `q${i}`,
      ...target(q.target),
      window: q.window,
      ...(q.count !== undefined || q.sum === undefined ? { max_count: q.count ?? 3 } : {}),
      ...(q.sum !== undefined ? { max_sum: { field: "amount_inr", value: q.sum } } : {}),
      ...(q.approver ? { approver: "finance" } : {}),
    })),
  });
}

const callArb = fc.record({
  gap: fc.integer({ min: 0, max: 4 * H }),
  tool: fc.constantFrom(...TOOLS),
  amount: fc.integer({ min: 0, max: 200_000 }),
  outcome: fc.constantFrom("ok", "failed", "rejected"),
  stored: fc.boolean(),
  other: fc.boolean(), // another agent's call: fixed usage, not decided again
});

function argsFor(tool: string, amount: number, i: number): Record<string, unknown> {
  if (tool === "zoho.record_bill_payment") return { bill_id: `b${i}`, amount_inr: amount };
  if (tool === "zoho.create_bill") return { vendor_id: "v", bill_number: `B${i}`, bill_date: "2026-10-20", amount_inr: amount };
  if (tool === "gmail.send_reply") return { message_id: `m${i}`, to: i % 2 ? "a@vendor.in" : "a@else.in", body: "" };
  return { message_id: `m${i}` };
}

/**
 * The guard, simplified: decide each call with the usage of everything that ran before it in each
 * quota's window, computed naively from the whole history.
 */
function liveHistory(rbk: Rulebook, specs: Of<typeof callArb>[], tz: string) {
  const lists = { vendor_domains: ["vendor.in"] };
  const ran: { ts: number; tool: string; values: Record<string, unknown> }[] = [];
  const calls: ReplayCall[] = [];
  const usage: UsageEvent[] = [];
  let ts = T0;
  specs.forEach((s, i) => {
    ts += s.gap;
    const args = argsFor(s.tool, s.amount, i);
    const quotas = quotasOf(rbk).filter((q: Quota) => ruleTargets(q, builtinRegistry.get(s.tool), s.tool));
    const used = Object.fromEntries(
      quotas.map((q) => {
        const start = q.window === "day" ? startOfDayIn(tz, new Date(ts)).getTime() : ts - durationMs(q.window);
        const inWindow = ran.filter((e) => e.ts >= start && ruleTargets(q, builtinRegistry.get(e.tool), e.tool));
        const field = q.max_sum?.field ?? "";
        return [q.id, { count: inWindow.length, sum: inWindow.reduce((n, e) => n + (typeof e.values[field] === "number" ? (e.values[field] as number) : 0), 0) }];
      }),
    );
    const d = decide(rbk, s.tool, args, { usage: used, lists });
    const didRun = (d.decision === "allow" && s.outcome !== "failed") || (d.decision === "ask" && s.outcome === "ok");
    if (didRun) ran.push({ ts, tool: s.tool, values: args });
    if (s.other) {
      if (didRun) usage.push({ ts, tool: s.tool, values: args });
    } else {
      calls.push({ seq: i + 1, ts, tool: s.tool, original: { decision: d.decision, ruleId: d.ruleId }, ran: didRun, ...(s.stored ? { args } : {}) });
      // A call without stored arguments still used its quota, as its receipt shows.
      if (!s.stored && didRun) usage.push({ ts, tool: s.tool, values: args });
    }
  });
  return { calls, usage, lists };
}

describe("replay properties", () => {
  it("replaying the active rulebook over its own history reproduces every decision, quotas included", () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 6 }), fc.array(quotaArb, { maxLength: 3 }), fc.array(callArb, { maxLength: 40 }), fc.constantFrom(...ZONES), (rules, quotas, specs, tz) => {
        const rbk = makeRulebook(rules, quotas);
        const { calls, usage, lists } = liveHistory(rbk, specs, tz);
        const r = replayRulebook({ rulebook: rbk, calls, usage, timeZone: tz, lists: () => lists });
        expect(r.changed).toBe(0);
        expect(r.changes).toEqual([]);
        expect(r.before).toEqual(r.after);
        expect(r.judged).toBe(calls.filter((c) => c.args).length);
      }),
      { numRuns: 300 },
    );
  });

  it("without quotas, each call is decided on its own, and the counts add up", () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 6 }), fc.array(ruleArb, { maxLength: 6 }), fc.array(callArb, { maxLength: 40 }), fc.integer({ min: 0, max: 50 }), (oldRules, newRules, specs, max) => {
        const before = makeRulebook(oldRules, []);
        const draft = makeRulebook(newRules, []);
        const { calls } = liveHistory(before, specs, "UTC");
        const shuffled = [...calls].reverse();
        const r = replayRulebook({ rulebook: draft, calls: shuffled, timeZone: "UTC", maxChanges: max });
        const sum = (c: Record<Decision, number>) => c.allow + c.ask + c.refuse;
        expect(r.total).toBe(calls.length);
        expect(r.judged + r.notJudged).toBe(r.total);
        expect(r.changed + r.unchanged).toBe(r.judged);
        expect(sum(r.more)).toBe(r.changed);
        expect(sum(r.fewer)).toBe(r.changed);
        expect(sum(r.before)).toBe(r.judged);
        for (const d of ["allow", "ask", "refuse"] as const) expect(r.after[d] - r.before[d]).toBe(r.more[d] - r.fewer[d]);
        expect(r.changes.length).toBe(Math.min(r.changed, max));
        expect(r.truncated).toBe(r.changed > max);
        // Changes come back in time order and each matches a fresh decision.
        for (const c of r.changes) {
          const orig = calls.find((x) => x.seq === c.seq)!;
          expect(decide(draft, orig.tool, orig.args!).decision).toBe(c.to);
          expect(c.from).toBe(orig.original.decision);
        }
        expect(r.changes.map((c) => c.ts)).toEqual([...r.changes.map((c) => c.ts)].sort((a, b) => a - b));
      }),
      { numRuns: 200 },
    );
  });
});
