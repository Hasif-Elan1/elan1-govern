import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BILLING_PLANS,
  buildInvoices,
  meterEvents,
  monthlyInvoice,
  pilotState,
  pilotUsage,
  usageOf,
  type AcceptedDiscount,
  type BillableUsage,
  type SeatHolder,
  type DisputeRecord,
  type LevelPeriod,
  type MeterReceipt,
  type PackInstall,
  type PlanId,
  type ReconRun,
} from "../src/billing";

/**
 * The approved console's numbers, frozen by running its own code (scripts/billing-console-fixture.ts) over
 * synthetic organisations. Our port must give the same paise for every line, invoice and credit note.
 */
interface Fixture {
  monthly: { plan: PlanId; usedBeforeTenths: number; usage: BillableUsage; lines: { quantity: number; amount: number }[]; subtotal: number; gst: number }[];
  scenarios: {
    name: string;
    org: { prefix: string; name: string; level: PlanId; createdAt: string; residency: string };
    levelHistory?: LevelPeriod[];
    receipts: MeterReceipt[];
    pilot?: { starts: string; convertedAt?: string };
    discounts: AcceptedDiscount[];
    disputes: DisputeRecord[];
    reconciliation: ReconRun[];
    packs: PackInstall[];
    counterparties: SeatHolder[];
    now: number;
    expect: { months: Record<string, unknown>[]; invoices: (Record<string, unknown> & { lines: Record<string, unknown>[] })[] };
  }[];
  pilots: { name: string; receipts: MeterReceipt[]; states: { now: number; record: { starts: string; ends: string; cap: number }; expect: Record<string, unknown> }[] }[];
}

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/billing-console.json"), "utf8")) as Fixture;
/** JSON drops undefined; so do we before comparing. */
const clean = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** The console's statuses on our ledger: due and paid are both issued (we collect no payments); a credit note is issued. */
const STATUS: Record<string, string> = { draft: "draft", due: "issued", paid: "issued", held: "held", credit: "issued" };

describe("billing matches the approved console", () => {
  it("has cases to compare", () => {
    expect(fixture.monthly.length).toBeGreaterThan(100);
    expect(fixture.scenarios.map((s) => s.name)).toEqual(["pilot-converted", "upgrade-l1-l2", "proven-seats", "sovereign"]);
  });

  it("prices one month exactly as the price book does, around the allowance boundary", () => {
    let floatSlips = 0;
    for (const c of fixture.monthly) {
      const p = BILLING_PLANS[c.plan];
      const inv = monthlyInvoice(p, c.usage, c.usedBeforeTenths);
      // The one place the console's floating point gives a different answer: when the allowance left after
      // committed actions is an exact multiple of 0.4 (0.8 here), 0.8 / 0.4 comes out as 1.9999… and the console
      // floors it to one refusal fewer inside the allowance, billing that refusal at 40% of the rate. We count it inside.
      const slip = inv.lines[2]!.quantity - c.lines[2]!.quantity;
      if (slip !== 0) {
        floatSlips++;
        const remainingAfter = p.includedPerYear * 10 - c.usedBeforeTenths - inv.lines[1]!.quantity * 10;
        expect(slip, JSON.stringify(c)).toBe(1);
        expect(remainingAfter % 4).toBe(0);
        expect(c.lines[4]!.amount - inv.lines[4]!.amount).toBe(p.refusal);
        expect(c.subtotal - inv.subtotal).toBe(p.refusal);
        continue;
      }
      expect(inv.lines.map((l) => l.amount), JSON.stringify(c)).toEqual(c.lines.map((l) => l.amount));
      // quantities are not money: the console's carry floating-point noise (50.40000000002328 for 50.4)
      inv.lines.forEach((l, i) => expect(l.quantity).toBeCloseTo(c.lines[i]!.quantity, 6));
      expect(inv.subtotal).toBe(c.subtotal);
      // The console's monthlyInvoice leaves GST unrounded; ours is rounded half up to the paisa.
      expect(Math.abs(inv.gst - c.gst)).toBeLessThanOrEqual(1);
    }
    // a handful of boundary cases, never the common ones
    expect(floatSlips).toBeLessThan(fixture.monthly.length / 10);
  });

  for (const s of fixture.scenarios) {
    describe(s.name, () => {
      const invoices = buildInvoices({ org: s.org, levelHistory: s.levelHistory, receipts: s.receipts, pilot: s.pilot, discounts: s.discounts, disputes: s.disputes, reconciliation: s.reconciliation, packs: s.packs, counterparties: s.counterparties, now: s.now });

      it("meters every month from the chain the same way", () => {
        const events = meterEvents(s.receipts);
        const months = [...new Set(events.map((e) => e.month))].sort();
        const ours = months.map((m) => {
          const { platform: _platform, ...u } = usageOf(events.filter((e) => e.month === m), m);
          return clean(u);
        });
        expect(ours).toEqual(s.expect.months.map(clean));
      });

      it("builds the same invoices and credit notes, to the paisa", () => {
        expect(invoices.map((i) => i.number)).toEqual(s.expect.invoices.map((i) => i.number));
        invoices.forEach((inv, k) => {
          const want = s.expect.invoices[k]!;
          const got = clean({
            number: inv.number,
            kind: inv.kind,
            period: inv.period,
            status: inv.status,
            subtotal: inv.subtotal,
            gst: inv.gst,
            total: inv.total,
            heldAmount: inv.heldAmount,
            payableNow: inv.payableNow,
            irn: inv.irn,
            placeOfSupply: inv.placeOfSupply,
            events: inv.events,
            fromSeq: inv.fromSeq,
            toSeq: inv.toSeq,
            partial: inv.partial,
            segments: inv.segments,
            credits: inv.credits,
            lines: inv.lines.map((l) => ({ id: l.id, kind: l.kind, quantity: l.quantity, unit: l.unit, rate: l.rate, amount: l.amount, fromSeq: l.fromSeq, toSeq: l.toSeq, held: l.held?.seq, credit: l.settled?.credit })),
          });
          expect(got, inv.number).toEqual(clean({ ...want, status: STATUS[String(want.status)] }));
        });
      });
    });
  }

  it("moves the pilot through the same states", () => {
    for (const p of fixture.pilots) {
      for (const st of p.states) {
        const visible = p.receipts.filter((r) => Date.parse(r.ts) <= st.now);
        const usage = pilotUsage(visible, st.record);
        const s = pilotState(st.record, usage, st.now);
        const got = clean({ status: s.status, used: s.used, remaining: s.remaining, daysLeft: s.daysLeft, stoppedAt: s.stoppedAt, stoppedWhy: s.stoppedWhy, readOnlyUntil: s.readOnlyUntil, closedAt: s.closedAt });
        expect(got, `${p.name} at ${new Date(st.now).toISOString()}`).toEqual(clean(st.expect));
      }
    }
    expect(fixture.pilots.flatMap((p) => p.states.map((s) => s.expect.status))).toEqual(expect.arrayContaining(["active", "stopped", "ended", "closed"]));
  });
});
