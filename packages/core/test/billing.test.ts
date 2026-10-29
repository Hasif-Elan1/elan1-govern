import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ADD_ON_PRICES,
  BILLING_PLANS,
  DISCOUNT_CAP,
  GST_PERCENT,
  PILOT,
  PLAN_IDS,
  SETTLEMENT_FOUNDER_ABOVE,
  SUPPLIER,
  acceptedFrom,
  billable,
  buildInvoices,
  chainCount,
  checkDiscount,
  checkDiscountRequest,
  creditNoteNumber,
  dayOf,
  dayStart,
  discountCovers,
  discountEnd,
  discountPerAction,
  discountState,
  discountsOverlap,
  formatPaise,
  fyLabel,
  fyStartOf,
  gstOn,
  invoicePrefix,
  irnFor,
  isPilotStop,
  isPlatformRefusal,
  latestRuns,
  levelAt,
  mergeWithLedger,
  meterEvents,
  meterFromReceipts,
  monthOf,
  monthStart,
  monthlyInvoice,
  nextMonth,
  pilotActionError,
  pilotPaused,
  pilotRefusalReason,
  pilotState,
  pilotUsage,
  placeOfSupply,
  profileOrders,
  roundDiv,
  seatSpans,
  settlementCredit,
  taxSplit,
  usageOf,
  type BillingInput,
  type ComputedInvoice,
  type MeterReceipt,
  type PlanId,
} from "../src/billing";

const H = 3_600_000;
const D = 24 * H;
const iso = (t: number | string) => new Date(t).toISOString();
const NOW = Date.parse("2026-10-20T08:00:00Z");

let seq = 0;
const dec = (ts: number | string, decision: string, extra: Partial<MeterReceipt> = {}): MeterReceipt => ({ seq: ++seq, ts: iso(ts), kind: "decision", decision, rule_id: "r", ...extra });
const resolve = (ts: number | string, ref: number, result: string): MeterReceipt => ({ seq: ++seq, ts: iso(ts), kind: "approval", decision: "ask", approval: { result }, ref_seq: ref });
const admin = (ts: number | string, action: string, details: Record<string, unknown> = {}): MeterReceipt => ({ seq: ++seq, ts: iso(ts), kind: "admin", action, details });

describe("price book", () => {
  it("prices a refusal at 40% of the per-action rate, and every monthly floor in whole paise", () => {
    for (const id of PLAN_IDS) {
      const p = BILLING_PLANS[id];
      expect(p.refusal * 10).toBe(p.overage * 4);
      expect(Number.isInteger(p.refusal)).toBe(true);
      expect(Number.isInteger(p.floorPerYear / 12)).toBe(true);
    }
    expect(BILLING_PLANS.l1).toMatchObject({ floorPerYear: 18_000_000, includedPerYear: 480_000, overage: 160, refusal: 64 });
    expect(BILLING_PLANS.sovereign).toMatchObject({ includedPerYear: 0, overage: 55, refusal: 22 });
    expect(ADD_ON_PRICES).toEqual({ pack: 13_500_000, profile: 30_000_000, bundle: 250_000, seat: 4_500_000 });
    expect(SUPPLIER.gstin).toBe("29ABCDE1234F1Z5");
  });
});

describe("integer money", () => {
  it("rounds half up like Math.round, for either sign", () => {
    expect(roundDiv(25, 10)).toBe(3);
    expect(roundDiv(24, 10)).toBe(2);
    expect(roundDiv(-25, 10)).toBe(-2);
    expect(roundDiv(-26, 10)).toBe(-3);
  });

  it("takes GST at 18% to the paisa, credit notes symmetric", () => {
    expect(gstOn(125)).toBe(23); // 22.5 rounds up (the console's float gives 22)
    expect(gstOn(1_500_000)).toBe(270_000);
    expect(gstOn(-125)).toBe(-23);
    expect(gstOn(0)).toBe(0);
  });

  it("splits GST into CGST and SGST in Karnataka, IGST elsewhere", () => {
    expect(taxSplit(23, "Karnataka (29)")).toEqual([
      { label: "CGST 9%", amount: 11 },
      { label: "SGST 9%", amount: 12 },
    ]);
    expect(taxSplit(-23, "Karnataka (29)").map((x) => x.amount)).toEqual([-11, -12]);
    expect(taxSplit(23, "Maharashtra (27)")).toEqual([{ label: "IGST 18%", amount: 23 }]);
  });

  it("formats paise in Indian grouping", () => {
    expect(formatPaise(12_345_678)).toBe("₹1,23,456.78");
    expect(formatPaise(-5)).toBe("-₹0.05");
  });

  it("GST is always within half a paisa of 18% and the split adds up", () => {
    fc.assert(
      fc.property(fc.integer({ min: -2e12, max: 2e12 }), fc.constantFrom("Karnataka (29)", "Telangana (36)"), (p, pos) => {
        const g = gstOn(p);
        expect(Number.isInteger(g)).toBe(true);
        expect(Math.abs(g - (p * GST_PERCENT) / 100)).toBeLessThanOrEqual(0.5);
        expect(gstOn(-p) + g).toBe(0);
        expect(taxSplit(g, pos).reduce((s, x) => s + x.amount, 0)).toBe(g);
      }),
    );
  });

  it("GST never falls as the taxable value rises", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 1000 }), (p, d) => gstOn(p + d) >= gstOn(p)));
  });
});

describe("India time", () => {
  it("cuts months and fiscal years at IST midnight", () => {
    expect(monthOf(Date.parse("2026-09-30T18:29:59Z"))).toBe("2026-09");
    expect(monthOf(Date.parse("2026-09-30T18:30:00Z"))).toBe("2026-10");
    expect(iso(monthStart("2026-10"))).toBe("2026-09-30T18:30:00.000Z");
    expect(iso(dayStart("2026-10-02"))).toBe("2026-10-01T18:30:00.000Z");
    expect(dayOf(Date.parse("2026-10-01T18:30:00Z"))).toBe("2026-10-02");
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(nextMonth("2026-09")).toBe("2026-10");
    expect(fyStartOf("2027-03")).toBe("2026-04");
    expect(fyStartOf("2026-04")).toBe("2026-04");
    expect(fyLabel("2027-01")).toBe("FY 2026–27");
  });

  it("finds the level in force at a moment", () => {
    const h = [
      { level: "l2" as PlanId, from: "2026-05-01T00:00:00Z" },
      { level: "l3" as PlanId, from: "2026-08-01T00:00:00Z" },
    ];
    expect(levelAt(undefined, NOW, "l2")).toBe("l2");
    expect(levelAt(h, Date.parse("2026-04-01T00:00:00Z"))).toBe("l1");
    expect(levelAt(h, Date.parse("2026-06-01T00:00:00Z"))).toBe("l2");
    expect(levelAt(h, NOW)).toBe("l3");
  });
});

describe("the meter", () => {
  const t = Date.parse("2026-10-05T06:00:00Z");
  const receipts = (() => {
    const allow = dec(t, "allow");
    const askOk = dec(t + H, "ask");
    const askNo = dec(t + 2 * H, "ask");
    const askLate = dec(t + 3 * H, "ask");
    const askWaiting = dec(t + 4 * H, "ask");
    const refuse = dec(t + 5 * H, "refuse");
    const platform = dec(t + 6 * H, "refuse", { rule_id: "gate-error" });
    const sandbox = dec(t + 7 * H, "allow", { environment: "sandbox" });
    const stop = dec(t + 8 * H, "refuse", { rule_id: PILOT.ruleId });
    return [allow, askOk, askNo, askLate, askWaiting, refuse, platform, sandbox, stop, resolve(t + 9 * H, askOk.seq, "approved"), resolve(t + 9 * H, askNo.seq, "rejected"), resolve(t + 9 * H, askLate.seq, "expired"), resolve(t + 9 * H, askWaiting.seq, "pending"), admin(t + 10 * H, "rulebook.published")];
  })();

  it("reads each decision's outcome from the chain", () => {
    const evs = meterEvents(receipts);
    expect(evs.map((e) => [e.via, e.tenths])).toEqual([
      ["allowed", 10],
      ["approved", 10],
      ["rejected", 4],
      ["expired", 4],
      ["pending", 0],
      ["refused", 4],
      ["refused", 0],
      ["allowed", 0],
    ]);
    expect(evs[1]!.resolvedSeq).toBeDefined();
    expect(evs[6]!.platform).toBe(true);
    expect(evs[7]!.sandbox).toBe(true);
  });

  it("reads the console's approval receipts too", () => {
    const a = dec(t, "ask");
    const b = dec(t, "ask");
    const evs = meterEvents([a, b, { seq: ++seq, ts: iso(t + H), kind: "approval", decision: "allow", ref_seq: a.seq }, { seq: ++seq, ts: iso(t + H), kind: "approval", decision: "refuse", approval: { status: "expired" }, ref_seq: b.seq }]);
    expect(evs.map((e) => e.via)).toEqual(["approved", "expired"]);
  });

  it("knows platform refusals and pilot stops", () => {
    expect(isPlatformRefusal({ decision: "refuse", rule_id: "PLATFORM.LOG_APPEND_FAILED" })).toBe(true);
    expect(isPlatformRefusal({ decision: "refuse", rule_id: "x", details: { code: "PLATFORM.INTERNAL_ERROR" } })).toBe(true);
    expect(isPlatformRefusal({ decision: "refuse", details: { code: 3 } })).toBe(false);
    expect(isPlatformRefusal({ decision: "allow", rule_id: "gate-error" })).toBe(false);
    expect(isPilotStop({ kind: "decision", rule_id: "pilot-limit" })).toBe(true);
    expect(isPilotStop({ kind: "admin", rule_id: "pilot-limit" })).toBe(false);
  });

  it("counts a month: platform refusals shown but not billed, sandbox apart", () => {
    const m = meterFromReceipts(receipts, "2026-10", BILLING_PLANS.l1);
    expect(m).toMatchObject({ month: "2026-10", plan: "l1", allowed: 1, approved: 1, refused: 3, expired: 1, pending: 1, platform: 1, sandbox: 1, events: 7, tenths: 32 });
    expect(m.billable).toEqual({ allowed: 1, approved: 1, refused: 2, expired: 1 });
    expect(meterFromReceipts(receipts, "2026-09", BILLING_PLANS.l1).events).toBe(0);
    const range = meterFromReceipts(receipts, { from: t, to: t + 2 * H }, BILLING_PLANS.l2);
    expect(range).toMatchObject({ month: "2026-10", allowed: 1, approved: 1, events: 2, firstSeq: receipts[0]!.seq, lastSeq: receipts[1]!.seq, plan: "l2" });
    expect(usageOf([], "2026-01").firstSeq).toBeUndefined();
    expect(billable(meterEvents(receipts))).toEqual(m.billable);
  });

  it("counts the chain side of a reconciliation run, and keeps the latest run per period", () => {
    expect(chainCount(receipts, "2026-10")).toEqual({ decisions: 8, tenths: 32 });
    const runs = latestRuns([
      { period: "2026-09", meterEvents: 1, chainDecisions: 2, matched: false, at: "a" },
      { period: "2026-09", meterEvents: 2, chainDecisions: 2, matched: true, at: "b" },
      { period: "2026-10", meterEvents: 1, chainDecisions: 1, matched: true, at: "c" },
    ]);
    expect(runs.get("2026-09")?.matched).toBe(true);
    expect(runs.size).toBe(2);
  });
});

describe("one month at one plan", () => {
  it("draws the allowance with committed actions first, then refusals at 0.4 each", () => {
    const inv = monthlyInvoice(BILLING_PLANS.l1, { allowed: 8, approved: 2, refused: 5, expired: 0 }, 480_000 * 10 - 112);
    // 11.2 actions left: 10 committed inside, then 1.2 left takes 3 refusals; 2 refusals beyond at ₹0.64
    expect(inv.lines.map((l) => [l.kind, l.quantity, l.amount])).toEqual([
      ["floor", 1, 1_500_000],
      ["inside", 10, 0],
      ["refused_inside", 3, 0],
      ["beyond", 0, 0],
      ["refused_beyond", 2, 128],
    ]);
    expect(inv.subtotal).toBe(1_500_128);
    expect(inv.gst).toBe(270_023);
    expect(inv.total).toBe(1_770_151);
  });

  it("bills Sovereign actions from the first one", () => {
    const inv = monthlyInvoice(BILLING_PLANS.sovereign, { allowed: 10, approved: 0, refused: 10, expired: 0 }, 0);
    expect(inv.lines[3]!.amount).toBe(550);
    expect(inv.lines[4]!.amount).toBe(220);
  });

  const usage = fc.record({ allowed: fc.nat(5000), approved: fc.nat(5000), refused: fc.nat(5000), expired: fc.nat(5000) });
  const planId = fc.constantFrom(...PLAN_IDS);

  it("a refusal beyond the allowance costs exactly 40% of a committed action", () => {
    fc.assert(
      fc.property(planId, usage, fc.nat(1e6), (id, u, extra) => {
        const p = BILLING_PLANS[id];
        const used = p.includedPerYear * 10 + extra; // allowance gone
        const inv = monthlyInvoice(p, u, used);
        expect(inv.lines[4]!.amount * 10).toBe((u.refused + u.expired) * p.overage * 4);
        expect(inv.lines[3]!.amount).toBe((u.allowed + u.approved) * p.overage);
      }),
    );
  });

  it("an extra refusal adds either nothing (inside) or 40% of the rate (beyond), never more", () => {
    fc.assert(
      fc.property(planId, usage, fc.nat(480_000 * 10), (id, u, used) => {
        const p = BILLING_PLANS[id];
        const a = monthlyInvoice(p, u, used).subtotal;
        const b = monthlyInvoice(p, { ...u, refused: u.refused + 1 }, used).subtotal;
        expect([0, p.refusal]).toContain(b - a);
      }),
    );
  });

  it("inside the allowance a refusal uses 0.4 of an included action", () => {
    fc.assert(
      fc.property(usage, (u) => {
        const p = BILLING_PLANS.l1;
        const need = (u.allowed + u.approved) * 10 + (u.refused + u.expired) * 4;
        const used = p.includedPerYear * 10 - need; // exactly enough left
        const inv = monthlyInvoice(p, u, used);
        expect(inv.lines[3]!.amount + inv.lines[4]!.amount).toBe(0);
        expect(inv.lines[2]!.quantity).toBe(u.refused + u.expired);
        // one tenth less and something is billed (when there is anything to bill)
        if (need > 0) expect(monthlyInvoice(p, u, used + 1).subtotal).toBeGreaterThan(inv.subtotal);
      }),
    );
  });
});

describe("discounts", () => {
  const ds = { seq: 1, pct: 15, from: "2026-07-01", until: "2027-06-30" };

  it("applies from IST midnight of its first day to the end of its last, or until ended early", () => {
    expect(discountCovers(ds, dayStart("2026-07-01"))).toBe(true);
    expect(discountCovers(ds, dayStart("2026-07-01") - 1)).toBe(false);
    expect(discountEnd(ds)).toBe(dayStart("2027-07-01"));
    expect(discountEnd({ ...ds, endedAt: "2026-08-01T00:00:00Z" })).toBe(Date.parse("2026-08-01T00:00:00Z"));
    expect(discountState(ds, dayStart("2026-06-30"))).toBe("scheduled");
    expect(discountState(ds, NOW)).toBe("active");
    expect(discountState({ ...ds, endedAt: "2026-08-01T00:00:00Z" }, NOW)).toBe("ended");
    expect(discountPerAction(BILLING_PLANS.l1, 15)).toBe(24);
    expect(discountPerAction(BILLING_PLANS.sovereign, 25)).toBe(14);
  });

  it("holds a lead to 20% for 12 months; a founder may go further; every discount has an end", () => {
    const ok = { pct: 15, from: "2026-07-01", until: "2027-06-30", agreedBy: "lead" as const };
    expect(checkDiscount(ok)).toBeUndefined();
    expect(checkDiscount({ ...ok, pct: 0 })).toMatch(/above 0/);
    expect(checkDiscount({ ...ok, pct: 100 })).toMatch(/below 100/);
    expect(checkDiscount({ ...ok, until: "" })).toMatch(/end date/);
    expect(checkDiscount({ ...ok, until: "2026-06-01" })).toMatch(/before the start/);
    expect(checkDiscount({ ...ok, pct: DISCOUNT_CAP.leadPct + 1 })).toMatch(/founder/);
    expect(checkDiscount({ ...ok, until: "2027-08-31" })).toMatch(/12 months/);
    expect(checkDiscount({ ...ok, pct: 40, until: "2028-06-30", agreedBy: "founder" })).toBeUndefined();
  });

  it("starts an accepted offer on the later of its start and the acceptance, and refuses overlaps", () => {
    expect(acceptedFrom("2026-07-01", Date.parse("2026-06-26T08:10:00Z"))).toBe("2026-07-01");
    expect(acceptedFrom("2026-07-01", Date.parse("2026-07-09T08:10:00Z"))).toBe("2026-07-09");
    expect(discountsOverlap(ds, { from: "2027-06-30", until: "2027-12-31" })).toBe(true);
    expect(discountsOverlap(ds, { from: "2027-07-01", until: "2027-12-31" })).toBe(false);
    expect(discountsOverlap(ds, { from: "2026-01-01", until: "2026-06-30" })).toBe(false);
  });

  it("sends a request to a lead within the cap, to a founder beyond it", () => {
    expect(checkDiscountRequest({ pct: 10, months: 6, reason: "Renewal at a higher volume" })).toEqual({ ok: true, needs: "lead" });
    expect(checkDiscountRequest({ pct: 30, months: 6, reason: "Renewal at a higher volume" })).toEqual({ ok: true, needs: "founder" });
    expect(checkDiscountRequest({ pct: 10, months: 18, reason: "Renewal at a higher volume" })).toEqual({ ok: true, needs: "founder" });
    expect(checkDiscountRequest({ pct: 0, months: 6, reason: "Renewal at a higher volume" })).toMatchObject({ ok: false });
    expect(checkDiscountRequest({ pct: 10, months: 1.5, reason: "Renewal at a higher volume" })).toMatchObject({ ok: false });
    expect(checkDiscountRequest({ pct: 10, months: 37, reason: "Renewal at a higher volume" })).toMatchObject({ ok: false });
    expect(checkDiscountRequest({ pct: 10, months: 6, reason: " short " })).toMatchObject({ ok: false });
  });
});

describe("dispute settlements", () => {
  const base = { requested: 0, lineAmount: 1_500_000, alreadyCredited: 0, decidedBy: "billing" as const };

  it("credits the whole line when upheld, nothing when rejected, a part when partly upheld", () => {
    expect(settlementCredit({ ...base, outcome: "upheld" })).toEqual({ ok: true, credit: 1_500_000, needsFounder: false });
    expect(settlementCredit({ ...base, outcome: "upheld", alreadyCredited: 500_000 })).toMatchObject({ credit: 1_000_000 });
    expect(settlementCredit({ ...base, outcome: "rejected", lineAmount: undefined })).toEqual({ ok: true, credit: 0, needsFounder: false });
    expect(settlementCredit({ ...base, outcome: "partly_upheld", requested: 1_000_00.4 })).toMatchObject({ ok: true, credit: 100_000 });
  });

  it("refuses credits that are not on the invoice, already given, or out of range", () => {
    expect(settlementCredit({ ...base, outcome: "upheld", lineAmount: undefined })).toMatchObject({ ok: false });
    expect(settlementCredit({ ...base, outcome: "upheld", alreadyCredited: 1_500_000 })).toMatchObject({ ok: false, error: expect.stringMatching(/in full/) });
    expect(settlementCredit({ ...base, outcome: "partly_upheld", requested: 1_500_000 })).toMatchObject({ ok: false });
    expect(settlementCredit({ ...base, outcome: "partly_upheld", requested: 0 })).toMatchObject({ ok: false });
  });

  it("needs a founder above ₹1,00,000 unless a founder decided it", () => {
    const big = { ...base, lineAmount: 2 * SETTLEMENT_FOUNDER_ABOVE, outcome: "upheld" as const };
    expect(settlementCredit(big)).toMatchObject({ ok: false, error: expect.stringMatching(/founder/) });
    expect(settlementCredit({ ...big, founderApproved: true })).toMatchObject({ ok: true, needsFounder: true });
    expect(settlementCredit({ ...big, decidedBy: "founder" })).toMatchObject({ ok: true, needsFounder: false });
    expect(creditNoteNumber("EG-KAVE-202608", 201)).toBe("CN-KAVE-202608-201");
  });
});

describe("the pilot", () => {
  const t0 = Date.parse("2026-03-02T05:00:00Z");
  const rec = { starts: iso(t0), cap: 3 };
  const chain = [dec(t0 + H, "allow"), dec(t0 + 2 * H, "refuse", { rule_id: "gate-error" }), dec(t0 + 3 * H, "allow", { environment: "sandbox" }), dec(t0 + 4 * H, "ask"), dec(t0 + 5 * H, "refuse"), dec(t0 + 6 * H, "allow")];

  it("counts production actions only, and notes when the cap was reached", () => {
    expect(pilotUsage(chain, rec)).toEqual({ used: 4, capAt: t0 + 5 * H + 1 });
    expect(pilotUsage(chain, { ...rec, cap: undefined })).toEqual({ used: 4 });
    expect(pilotUsage(chain, { ...rec, convertedAt: iso(t0 + 4.5 * H) })).toEqual({ used: 2 });
  });

  it("goes active, stopped, closed; or ended after 90 days; converted lifts it", () => {
    const u = pilotUsage(chain, rec);
    expect(pilotState(rec, { used: 1 }, t0 + D)).toMatchObject({ status: "active", used: 1, remaining: 2, daysLeft: 89 });
    const stopped = pilotState(rec, u, t0 + D);
    expect(stopped).toMatchObject({ status: "stopped", stoppedWhy: "3 governed actions used", stoppedAt: iso(t0 + 5 * H + 1), readOnlyUntil: iso(t0 + 5 * H + 1 + 30 * D) });
    expect(pilotState(rec, u, t0 + 31 * D)).toMatchObject({ status: "closed", closedAt: iso(t0 + 5 * H + 1 + 30 * D) });
    expect(pilotState(rec, { used: 1 }, t0 + 91 * D)).toMatchObject({ status: "ended", stoppedWhy: "90 days ended" });
    const converted = pilotState({ ...rec, convertedAt: iso(t0 + 2 * D) }, u, t0 + 40 * D);
    expect(converted).toMatchObject({ status: "converted", convertedAt: iso(t0 + 2 * D) });
    expect(converted.readOnlyUntil).toBeUndefined();
    expect(pilotState({ ...rec, closedAt: iso(t0 + 3 * D) }, u, t0 + 3 * D)).toMatchObject({ status: "closed", closedAt: iso(t0 + 3 * D) });
    expect(pilotState({ ...rec, stoppedAt: iso(t0 + D), stoppedWhy: "ended early by an owner: moving on", recordedUsed: 9 }, { used: 1 }, t0 + 2 * D)).toMatchObject({ status: "stopped", used: 9, remaining: 0, stoppedAt: iso(t0 + D) });
    expect(pilotState({ starts: iso(t0), stoppedAt: iso(t0 + D) }, { used: 0 }, t0 + 2 * D)).toMatchObject({ status: "stopped", stoppedWhy: "", cap: PILOT.cap });
  });

  it("holds the organisation while stopped, ended or closed, with a plain reason", () => {
    const u = pilotUsage(chain, rec);
    const stopped = pilotState(rec, u, t0 + D);
    expect(pilotPaused(stopped)).toBe(true);
    expect(pilotPaused(undefined)).toBe(false);
    expect(pilotPaused(pilotState(rec, { used: 0 }, t0 + D))).toBe(false);
    expect(pilotRefusalReason(stopped)).toMatch(/has used its 3 governed actions/);
    expect(pilotRefusalReason(pilotState(rec, { used: 0 }, t0 + 91 * D))).toMatch(/ended after 90 days/);
    expect(pilotRefusalReason(pilotState({ ...rec, stoppedAt: iso(t0 + D), stoppedWhy: "ended early by an owner" }, { used: 0 }, t0 + 2 * D))).toMatch(/ended early/);
    expect(pilotRefusalReason(pilotState(rec, u, t0 + 40 * D))).toMatch(/closed/);
  });

  it("says when an owner's pilot action is not allowed", () => {
    const active = pilotState(rec, { used: 0 }, t0 + D);
    const closed = pilotState(rec, pilotUsage(chain, rec), t0 + 40 * D);
    const converted = pilotState({ ...rec, convertedAt: iso(t0 + D) }, { used: 0 }, t0 + 2 * D);
    expect(pilotActionError(undefined, "convert")).toMatch(/not on a pilot/);
    expect(pilotActionError(active, "end_early")).toBeUndefined();
    expect(pilotActionError(closed, "end_early")).toMatch(/no running pilot/);
    expect(pilotActionError(closed, "request_reopen")).toBeUndefined();
    expect(pilotActionError(active, "request_reopen")).toMatch(/closed/);
    expect(pilotActionError(active, "convert")).toBeUndefined();
    expect(pilotActionError(converted, "convert")).toMatch(/already/);
    expect(pilotActionError(closed, "convert")).toMatch(/reopen/);
  });
});

describe("seats and orders", () => {
  it("follows each counterparty's seat changes from the moment they were recorded", () => {
    const since = Date.parse("2026-07-20T06:00:00Z");
    const change1 = admin("2026-08-11T07:00:00Z", "counterparty.seats.changed", { counterparty_id: "cp1", from: 2, to: 5 });
    const change2 = admin("2026-09-02T07:00:00Z", "counterparty.seats.changed", { counterparty: "Kaveri", from: 1, to: 4 });
    const early = admin("2026-01-02T07:00:00Z", "counterparty.seats.changed", { counterparty: "Kaveri", from: 9, to: 9 });
    const spans = seatSpans([early, change1, change2, admin(NOW, "counterparty.seats.changed")], [
      { id: "cp1", name: "Vasant", seats: 5, since: iso(since) },
      { name: "Kaveri", seats: 4, since: "2026-08-15T06:00:00Z" },
      { name: "Quiet", seats: 2, since: "2026-08-15T06:00:00Z" },
    ]);
    expect(spans.map((s) => [s.name, s.seats, s.seq ?? null])).toEqual([
      ["Vasant", 2, null],
      ["Vasant", 5, change1.seq],
      ["Kaveri", 1, null],
      ["Kaveri", 4, change2.seq],
      ["Quiet", 2, null],
    ]);
    expect(spans[1]).toMatchObject({ from: Date.parse(change1.ts), to: Infinity, before: 2 });
  });

  it("reads profile orders and cancellations", () => {
    const o = admin("2026-09-03T06:00:00Z", "billing.addon_ordered", { addon: "profile", profile: "gst" });
    const orders = profileOrders([o, admin("2026-09-04T06:00:00Z", "billing.addon_ordered", { addon: "pack" }), admin("2026-09-21T06:00:00Z", "billing.addon_cancelled", { addon: "profile", profile: "gst" }), admin("2026-09-22T06:00:00Z", "billing.addon_cancelled", { addon: "pack" })]);
    expect(orders).toEqual([{ seq: o.seq, profileId: "gst", at: o.ts, cancelledAt: iso("2026-09-21T06:00:00Z") }]);
  });
});

describe("invoices", () => {
  const org = { prefix: "TEST", name: "Test Traders", level: "l1" as PlanId, createdAt: "2026-08-10T04:30:00Z" };
  const input = (over: Partial<BillingInput> = {}): BillingInput => ({ org, receipts: [dec("2026-08-10T06:00:00Z", "allow")], now: NOW, ...over });

  it("numbers, identifies and addresses every invoice", () => {
    expect(invoicePrefix("demo-traders")).toBe("DEMO");
    expect(invoicePrefix("Kaveri Health")).toBe("KAVE");
    expect(invoicePrefix("--")).toBe("ORG");
    expect(irnFor("EG-DEMO-202610", "2026-10")).toMatch(/^[0-9a-f]{64}$/);
    expect(irnFor("EG-DEMO-202610", "2026-10", "CRN")).not.toBe(irnFor("EG-DEMO-202610", "2026-10"));
    expect(placeOfSupply("Bengaluru")).toBe("Karnataka (29)");
    expect(placeOfSupply("Karnataka")).toBe("Karnataka (29)");
    expect(placeOfSupply("Hyderabad")).toBe("Telangana (36)");
    expect(placeOfSupply("Chennai")).toBe("Tamil Nadu (33)");
    expect(placeOfSupply(undefined)).toBe("Maharashtra (27)");
  });

  it("has nothing to bill before the first receipt", () => {
    expect(buildInvoices(input({ receipts: [] }))).toEqual([]);
  });

  it("bills the first month from the sign-up day, the floor pro rata, and the open month as a draft", () => {
    const invs = buildInvoices(input());
    expect(invs.map((i) => [i.number, i.status])).toEqual([
      ["EG-TEST-202610", "draft"],
      ["EG-TEST-202609", "issued"],
      ["EG-TEST-202608", "issued"],
    ]);
    const aug = invs[2]!;
    expect(aug.segments).toEqual([{ level: "l1", from: "2026-08-10T04:30:00.000Z", to: "2026-08-31T18:30:00.000Z", days: 21.6 }]);
    expect(aug.lines[0]).toMatchObject({ kind: "floor", quantity: 0.697, unit: "21.6 of 31 days", amount: roundDiv(1_500_000 * 216, 310) });
    expect(aug.placeOfSupply).toBe("Maharashtra (27)");
    expect(invs[0]!.periodEnd).toBe(iso(NOW));
  });

  it("an organisation with no sign-up date is billed from its first month; a partial chain is marked", () => {
    const invs = buildInvoices(input({ org: { ...org, createdAt: undefined } }));
    expect(invs.at(-1)!.lines[0]).toMatchObject({ quantity: 1, amount: 1_500_000 });
    expect(invs.at(-1)!.partial).toBe(iso("2026-08-10T06:00:00Z"));
  });

  it("bills packs only from L2, profiles and bundles as add-ons, the L1 auditor pack free", () => {
    const receipts = [dec("2026-08-10T06:00:00Z", "allow"), admin("2026-09-05T06:00:00Z", "evidence.exported", { kind: "pack" })];
    const l1 = buildInvoices(input({ receipts, packs: [{ id: "ledger1", name: "ledger1", installedAt: "2026-08-15T00:00:00Z" }, { id: "x", name: "x" }] }));
    expect(l1.flatMap((i) => i.lines.map((l) => l.kind))).not.toContain("pack");
    expect(l1.find((i) => i.period === "2026-09")!.lines.find((l) => l.id === "exports")).toMatchObject({ amount: 0, quantity: 1 });
  });

  it("re-installing a removed pack bills from the month after the removal; a never-billed removal is free", () => {
    const l2 = { ...org, level: "l2" as PlanId };
    const receipts = [dec("2026-08-10T06:00:00Z", "allow"), admin("2026-08-20T06:00:00Z", "pack.uninstalled", { pack: "p1", installed_at: "2026-08-12T00:00:00Z" }), admin("2026-08-21T06:00:00Z", "pack.uninstalled", { pack: "p2", installed_at: "2026-08-12T00:00:00Z", billing: "never_billed" }), admin("2026-08-22T06:00:00Z", "pack.uninstalled", { pack: "p3" })];
    const invs = buildInvoices(input({ org: l2, receipts, packs: [{ id: "p1", name: "p1", installedAt: "2026-08-25T00:00:00Z" }] }));
    const lines = (period: string) => invs.find((i) => i.period === period)!.lines.filter((l) => l.kind === "pack").map((l) => [l.id, l.amount]);
    // 12 August 00:00 UTC to the end of August IST is 638 thousandths of the month
    expect(lines("2026-08")).toEqual([[`pack-p1-r${receipts[1]!.seq}`, 638 * 1125]]);
    expect(lines("2026-09")).toEqual([["pack-p1", 1_125_000]]);
  });

  it("holds a disputed line, credits a settled one with a credit note no larger than the line", () => {
    const disputes = [
      { seq: 90, invoice: "EG-TEST-202609", line: "l1-floor", reason: "r", by: "u", at: "2026-10-02T00:00:00Z", open: true },
      { seq: 91, invoice: "EG-TEST-202608", line: "l1-floor", reason: "r", by: "u", at: "2026-09-02T00:00:00Z", open: false, settlement: { seq: 92, outcome: "upheld" as const, credit: 99_000_000, creditNote: "CN-TEST-202608-91", at: "2026-09-05T00:00:00Z" } },
      { seq: 93, invoice: "EG-TEST-202608", line: "l1-inside", reason: "r", by: "u", at: "2026-09-02T00:00:00Z", open: false, settlement: { seq: 94, outcome: "rejected" as const, credit: 0, at: "2026-09-05T00:00:00Z" } },
    ];
    const invs = buildInvoices(input({ disputes }));
    const sep = invs.find((i) => i.number === "EG-TEST-202609")!;
    expect(sep.heldAmount).toBe(1_500_000);
    expect(sep.payableNow).toBe(0);
    const aug = invs.find((i) => i.number === "EG-TEST-202608")!;
    const cn = invs.find((i) => i.kind === "credit_note")!;
    expect(cn).toMatchObject({ number: "CN-TEST-202608-91", subtotal: -aug.lines[0]!.amount, gst: gstOn(-aug.lines[0]!.amount), status: "issued", creditFor: { invoice: aug.number, line: "l1-floor", outcome: "upheld" } });
    expect(aug.credits).toEqual([{ number: "CN-TEST-202608-91", amount: aug.lines[0]!.amount }]);
    expect(aug.lines[1]!.settled).toMatchObject({ outcome: "rejected", credit: 0 });
  });

  it("holds the open and due months while their reconciliation does not match, never an older one", () => {
    const run = (period: string) => ({ period, meterEvents: 1, chainDecisions: 2, matched: false, at: "2026-10-02T00:00:00Z" });
    const invs = buildInvoices(input({ reconciliation: [run("2026-10"), run("2026-09"), run("2026-08")] }));
    expect(invs.map((i) => i.status)).toEqual(["held", "held", "issued"]);
    expect(invs[1]).toMatchObject({ heldAmount: invs[1]!.subtotal, payableNow: 0, heldBy: { meterEvents: 1, chainDecisions: 2 } });
  });

  it("invoices a Sovereign deployment in advance every 365 days", () => {
    const sov = { ...org, level: "sovereign" as PlanId, createdAt: "2024-09-01T00:00:00Z" };
    const invs = buildInvoices(input({ org: sov, levelHistory: [{ level: "sovereign", from: "2024-09-01T00:00:00Z" }], receipts: [dec("2026-10-01T06:00:00Z", "allow")] }));
    expect(invs.filter((i) => i.kind === "deployment").map((i) => i.number)).toEqual(["EG-TEST-DEP-2026-3", "EG-TEST-DEP-2025-2", "EG-TEST-DEP-2024"]);
    expect(invs.find((i) => i.kind === "monthly")!.lines.map((l) => l.kind)).toEqual(["beyond"]);
  });

  it("the free pilot covers Guarded only, and its line names the list price", () => {
    const history = [
      { level: "l1" as PlanId, from: "2026-08-10T04:30:00Z" },
      { level: "l2" as PlanId, from: "2026-09-15T00:00:00Z" },
    ];
    const invs = buildInvoices(input({ levelHistory: history, pilot: { starts: "2026-08-10T04:30:00Z" } }));
    expect(invs.find((i) => i.period === "2026-08")).toMatchObject({ subtotal: 0, pilot: { from: "2026-08-10T04:30:00.000Z" } });
    const sep = invs.find((i) => i.period === "2026-09")!;
    expect(sep.lines.map((l) => l.kind)).toEqual(["pilot", "floor"]);
    expect(sep.lines[1]!.label).toMatch(/^L2 · /);
  });

  const arbitraryInput = fc
    .record({
      created: fc.integer({ min: Date.parse("2026-04-01T00:00:00Z"), max: Date.parse("2026-09-30T00:00:00Z") }),
      upgrade: fc.option(fc.record({ after: fc.integer({ min: 1, max: 120 * D }), to: fc.constantFrom<PlanId>("l2", "l3", "sovereign") })),
      decisions: fc.array(fc.record({ at: fc.integer({ min: 0, max: 200 * D }), decision: fc.constantFrom("allow", "refuse", "ask") }), { maxLength: 40 }),
      packs: fc.array(fc.record({ at: fc.integer({ min: -30 * D, max: 200 * D }) }), { maxLength: 3 }),
      seats: fc.array(fc.record({ since: fc.integer({ min: -30 * D, max: 200 * D }), seats: fc.integer({ min: 0, max: 20 }), changes: fc.array(fc.record({ at: fc.integer({ min: 0, max: 200 * D }), to: fc.integer({ min: 0, max: 20 }) }), { maxLength: 3 }) }), { maxLength: 3 }),
      profiles: fc.array(fc.record({ at: fc.integer({ min: 0, max: 200 * D }), cancelAfter: fc.option(fc.integer({ min: 0, max: 60 * D })) }), { maxLength: 2 }),
    })
    .map((x) => {
      const now = Date.parse("2026-10-20T08:00:00Z");
      const t = (o: number) => Math.min(now - H, x.created + o);
      let s = 0;
      const receipts: MeterReceipt[] = [{ seq: ++s, ts: iso(x.created), kind: "admin", action: "org.created" }];
      const timed: { t: number; r: Omit<MeterReceipt, "seq"> }[] = [];
      for (const d of x.decisions) timed.push({ t: t(d.at), r: { ts: iso(t(d.at)), kind: "decision", decision: d.decision, rule_id: "r" } });
      x.seats.forEach((c, i) => c.changes.forEach((ch) => timed.push({ t: t(ch.at), r: { ts: iso(t(ch.at)), kind: "admin", action: "counterparty.seats.changed", details: { counterparty_id: `cp${i}`, from: c.seats, to: ch.to } } })));
      x.profiles.forEach((p, i) => {
        timed.push({ t: t(p.at), r: { ts: iso(t(p.at)), kind: "admin", action: "billing.addon_ordered", details: { addon: "profile", profile: `p${i}` } } });
        if (p.cancelAfter !== null) timed.push({ t: t(p.at + p.cancelAfter), r: { ts: iso(t(p.at + p.cancelAfter)), kind: "admin", action: "billing.addon_cancelled", details: { addon: "profile", profile: `p${i}` } } });
      });
      timed.sort((a, b) => a.t - b.t).forEach((e) => receipts.push({ ...e.r, seq: ++s }));
      const levelHistory = x.upgrade ? [{ level: "l1" as PlanId, from: iso(x.created) }, { level: x.upgrade.to, from: iso(t(x.upgrade.after)) }] : undefined;
      return {
        org: { prefix: "PROP", name: "Prop", level: (x.upgrade?.to ?? "l1") as PlanId, createdAt: iso(x.created) },
        levelHistory,
        receipts,
        packs: x.packs.map((p, i) => ({ id: `k${i}`, name: `k${i}`, installedAt: iso(x.created + p.at) })),
        counterparties: x.seats.map((c, i) => ({ id: `cp${i}`, name: `cp${i}`, seats: c.seats, since: iso(x.created + c.since) })),
        now,
      } satisfies BillingInput;
    });

  it("pro rata lines are never negative and never more than a whole month", () => {
    fc.assert(
      fc.property(arbitraryInput, (inp) => {
        const seatsMax = Math.max(0, ...inp.counterparties.map((c) => c.seats), ...inp.receipts.map((r) => Number(r.details?.to ?? 0))) * inp.counterparties.length;
        for (const inv of buildInvoices(inp)) {
          for (const l of inv.lines) {
            if (l.kind === "floor") expect(l.amount).toBeLessThanOrEqual(BILLING_PLANS[l.level!].floorPerYear / 12);
            if (l.kind === "pack") expect(l.amount).toBeLessThanOrEqual(ADD_ON_PRICES.pack / 12);
            if (l.kind === "profile") expect(l.amount).toBeLessThanOrEqual(ADD_ON_PRICES.profile / 12);
            if (l.kind === "seat") expect(l.amount).toBeLessThanOrEqual((seatsMax * ADD_ON_PRICES.seat) / 12);
            if (["floor", "pack", "profile", "seat"].includes(l.kind)) {
              expect(l.amount).toBeGreaterThanOrEqual(0);
              expect(Number.isInteger(l.amount)).toBe(true);
            }
          }
          expect(inv.total).toBe(inv.subtotal + inv.gst);
          expect(inv.subtotal).toBe(inv.lines.reduce((s, l) => s + l.amount, 0));
        }
      }),
      { numRuns: 150 },
    );
  });

  it("a closed month's invoice never changes when later receipts or seat changes arrive", () => {
    fc.assert(
      fc.property(arbitraryInput, fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 20 }), (inp, n, seats) => {
        const before = buildInvoices({ ...inp, now: Date.parse("2026-09-15T00:00:00Z"), receipts: inp.receipts.filter((r) => Date.parse(r.ts) < Date.parse("2026-09-15T00:00:00Z")) });
        const closed = before.filter((i) => i.kind === "monthly" && i.period < "2026-09");
        // later: more decisions, a seat change for every counterparty, all after 15 September
        let s = Math.max(0, ...inp.receipts.map((r) => r.seq));
        const later: MeterReceipt[] = [
          ...inp.receipts.filter((r) => Date.parse(r.ts) < Date.parse("2026-09-15T00:00:00Z")),
          ...Array.from({ length: n }, (_, i) => ({ seq: ++s, ts: iso(Date.parse("2026-09-15T00:00:00Z") + i * H), kind: "decision", decision: "allow" })),
          ...inp.counterparties.map((c) => ({ seq: ++s, ts: iso(Date.parse("2026-10-01T00:00:00Z")), kind: "admin", action: "counterparty.seats.changed", details: { counterparty_id: c.id, from: c.seats, to: seats } })),
        ];
        const after = buildInvoices({ ...inp, receipts: later });
        for (const c of closed) {
          const a = after.find((x) => x.number === c.number)!;
          expect({ lines: a.lines, subtotal: a.subtotal, gst: a.gst }).toEqual({ lines: c.lines, subtotal: c.subtotal, gst: c.gst });
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("the ledger", () => {
  const computed = (number: string, subtotal: number): ComputedInvoice => ({ number, subtotal } as ComputedInvoice);

  it("keeps issued and void invoices exactly as stored; drafts and held take the new figures", () => {
    const out = mergeWithLedger([computed("A", 1), computed("B", 2), computed("C", 3), computed("D", 4)], [
      { number: "A", status: "issued" as const, subtotal: 100 },
      { number: "B", status: "void" as const, subtotal: 200 },
      { number: "C", status: "draft" as const, subtotal: 300 },
    ]);
    expect(out.map((x) => x.subtotal)).toEqual([100, 200, 3, 4]);
  });

  it("an issued invoice is never rewritten, whatever is computed later", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ number: fc.constantFrom("A", "B", "C", "D"), subtotal: fc.integer() }), { maxLength: 8 }),
        fc.uniqueArray(fc.record({ number: fc.constantFrom("A", "B", "C", "D"), status: fc.constantFrom("draft" as const, "issued" as const, "held" as const, "void" as const), subtotal: fc.integer() }), { selector: (s) => s.number }),
        (comp, stored) => {
          const out = mergeWithLedger(comp.map((c) => computed(c.number, c.subtotal)), stored);
          out.forEach((o, i) => {
            const s = stored.find((x) => x.number === comp[i]!.number);
            if (s && (s.status === "issued" || s.status === "void")) expect(o).toBe(s);
            else expect(o.subtotal).toBe(comp[i]!.subtotal);
          });
        },
      ),
    );
  });
});
