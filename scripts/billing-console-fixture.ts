/**
 * Freezes the approved console's billing numbers into a JSON fixture that @gate/core's billing tests compare
 * against (packages/core/test/fixtures/billing-console.json). It runs the console's own code, unchanged:
 *
 *   node_modules/.bin/tsx --tsconfig apps/console/tsconfig.json scripts/billing-console-fixture.ts
 *
 * The organisations below are synthetic and deterministic (a seeded PRNG and a fixed `now`), so running it again
 * gives the same file. Money is written in paise (Math.round(rupees * 100)); allowance in tenths of an action.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The console's mock reads localStorage and window timers at import; a Map is enough here.
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), key: () => null, length: 0 };
g.window = globalThis;

const { buildInvoices, chainMeter, disputesOf } = await import("../apps/console/src/features/billing/chainMeter");
const { discountsOf, pilotOf, reconRunsOf } = await import("../apps/console/src/mock/billing");
const { monthlyInvoice, PLANS } = await import("../apps/console/src/lib/pricing");

type Rec = Record<string, unknown> & { seq: number; ts: string; kind: string };
const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse("2026-10-20T08:00:00.000Z");
const paise = (rupees: number) => Math.round(rupees * 100);
const iso = (s: string | number) => new Date(s).toISOString();

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Another entry's seq, filled in once the chain is in time order. */
interface Ref {
  ref: Entry;
  fmt?: (seq: number) => string;
}
interface Entry {
  t: number;
  rec: Omit<Rec, "seq">;
  refSeq?: Entry;
  refs?: Record<string, Ref>;
  seq?: number;
}

/** A chain builder: decisions with their approvals, and admin receipts, put in time order (seq follows ts) at the end. */
function chain(seed: number) {
  const rand = rng(seed);
  const entries: Entry[] = [];
  const add = (e: Entry) => {
    entries.push(e);
    return e;
  };
  return {
    admin(t: number, action: string, details: Record<string, unknown>, actor = "u_owner", refs?: Record<string, Ref>) {
      return add({ t, rec: { ts: iso(t), kind: "admin", actor, action, details }, ...(refs ? { refs } : {}) });
    },
    /** `n` decisions spread over [from, to): mostly allowed, some asked (approved, rejected, expired, pending), some refused. */
    decisions(n: number, from: number, to: number, opts: { sandbox?: number; platform?: number; until?: number } = {}) {
      const ts = Array.from({ length: n }, () => from + rand() * (to - from)).sort((a, b) => a - b);
      for (const t of ts) {
        const x = rand();
        const env = rand() < (opts.sandbox ?? 0) ? { environment: "sandbox" } : {};
        const base = { ts: iso(t), kind: "decision", agent: "ap-bot", ...env };
        if (x < 0.6) add({ t, rec: { ...base, tool: "zoho.list_bills", decision: "allow", rule_id: "read" } });
        else if (x < 0.8) {
          const d = add({ t, rec: { ...base, tool: "zoho.record_bill_payment", decision: "ask", rule_id: "pay-large" } });
          const y = rand();
          const at = t + (0.2 + rand() * 30) * H;
          if (y < 0.1 || at >= (opts.until ?? NOW)) continue; // still waiting for a person
          const status = y < 0.7 ? "approved" : y < 0.9 ? "rejected" : "expired";
          add({ t: at, rec: { ts: iso(at), kind: "approval", agent: "ap-bot", decision: status === "approved" ? "allow" : "refuse", approval: { id: `apr_${entries.length}`, status } }, refSeq: d });
        } else if (rand() < (opts.platform ?? 0)) add({ t, rec: { ...base, tool: "zoho.record_bill_payment", decision: "refuse", rule_id: "gate-error" } });
        else add({ t, rec: { ...base, tool: "gmail.send", decision: "refuse", rule_id: "no-external" } });
      }
    },
    /** The receipts in time order with every reference resolved; only those at or before `until`. */
    receipts(until = Infinity): Rec[] {
      const sorted = entries.filter((e) => e.t <= until).sort((a, b) => a.t - b.t);
      sorted.forEach((e, i) => (e.seq = i + 1));
      return sorted.map((e) => {
        const r = { ...e.rec, seq: e.seq! } as Rec;
        if (e.refSeq?.seq !== undefined) r.ref_seq = e.refSeq.seq;
        if (e.refs) r.details = { ...(r.details as object), ...Object.fromEntries(Object.entries(e.refs).map(([k, v]) => [k, v.fmt ? v.fmt(v.ref.seq!) : v.ref.seq])) };
        return r;
      });
    },
  };
}

const org = (id: string, slug: string, name: string, plan: string, createdAt: string, residency: string, levelHistory?: { level: string; from: string }[]) => ({ id, slug, name, plan, createdAt: iso(createdAt), residency, ...(levelHistory ? { levelHistory } : {}) });

interface Scenario {
  name: string;
  org: ReturnType<typeof org>;
  receipts: Rec[];
  ctx: { packs: { id: string; name: string; installedAt?: string }[]; counterparties: { id?: string; name: string; seats: number; since: string }[] };
  now: number;
}

const scenarios: Scenario[] = [];

// 1. A sign-up organisation on the pilot (cap 150 here so the fixture stays small): stopped at the cap, moved to the paid plan.
{
  const c = chain(11);
  const t0 = Date.parse("2026-06-02T05:00:00Z");
  c.admin(t0, "billing.pilot_started", { starts: iso(t0), ends: iso(t0 + 90 * D), cap: 150, list_plan: "l1" }, "system");
  c.decisions(160, t0 + H, t0 + 40 * D, { sandbox: 0.08, platform: 0.3 });
  const conv = t0 + 43 * D + 6 * H;
  c.admin(conv, "billing.pilot_converted", { plan: "l1", via: "owner", used: 150, cap: 150, at: iso(conv) });
  c.decisions(180, conv + H, NOW - H, { sandbox: 0.05, platform: 0.2 });
  c.admin(Date.parse("2026-09-10T06:00:00Z"), "evidence.exported", { kind: "pack" });
  c.admin(Date.parse("2026-10-05T06:00:00Z"), "evidence.exported", { kind: "pack" });
  scenarios.push({ name: "pilot-converted", org: org("org_demo", "demo-traders", "Demo Traders", "l1", "2026-06-02T05:00:00Z", "ap-south-1 Mumbai"), receipts: c.receipts(NOW), ctx: { packs: [], counterparties: [] }, now: NOW });
}

// 2. Guarded then Attested mid-month: an accepted lead discount, packs from L2, profile orders and a cancellation,
//    bundles, last month held by an unmatched reconciliation run, an open dispute on a floor line.
{
  const c = chain(22);
  const t0 = Date.parse("2026-05-14T04:30:00Z");
  const up = Date.parse("2026-08-17T09:00:00Z");
  c.decisions(120, t0 + H, up, { platform: 0.2 });
  const offer = c.admin(Date.parse("2026-06-24T06:30:00Z"), "billing.discount_offered", { pct: 15, from: "2026-07-01", until: "2027-06-30", reference: "NB-COMM-2026-07" }, "elan1:meera.iyer");
  c.admin(Date.parse("2026-06-26T08:10:00Z"), "billing.discount_accepted", { pct: 15, until: "2027-06-30" }, "u_owner", { offer: { ref: offer } });
  c.admin(up, "level.upgraded", { from: "l1", to: "l2" });
  c.admin(Date.parse("2026-08-20T06:00:00Z"), "billing.addon_ordered", { addon: "profile", profile: "mca-audit-trail" });
  c.admin(Date.parse("2026-09-03T06:00:00Z"), "billing.addon_ordered", { addon: "profile", profile: "gst-einvoice" });
  c.admin(Date.parse("2026-09-21T06:00:00Z"), "billing.addon_cancelled", { addon: "profile", profile: "gst-einvoice" });
  c.admin(Date.parse("2026-10-04T06:00:00Z"), "billing.addon_ordered", { addon: "profile", profile: "gst-einvoice" });
  c.decisions(260, up + H, NOW - H, { sandbox: 0.05 });
  c.admin(Date.parse("2026-09-12T06:00:00Z"), "evidence.exported", { format: "elan1.evidence.bundle.v1" });
  c.admin(Date.parse("2026-09-13T06:00:00Z"), "evidence.exported", { format: "elan1.evidence.bundle.v1" });
  c.admin(Date.parse("2026-09-14T06:00:00Z"), "evidence.exported", { kind: "pack" });
  c.admin(Date.parse("2026-10-02T06:00:00Z"), "billing.reconciliation_run", { period: "2026-09", meter_events: 80, chain_decisions: 83, meter_units: 70, chain_units: 72.4, matched: false }, "system");
  c.admin(Date.parse("2026-10-03T06:00:00Z"), "billing.reconciliation_run", { period: "2026-08", meter_events: 50, chain_decisions: 51, meter_units: 40, chain_units: 41, matched: false }, "system");
  c.admin(Date.parse("2026-10-06T06:00:00Z"), "billing.dispute_opened", { invoice: "EG-NORT-202610", line: "l2-floor", reason: "Floor charged while the upgrade ceremony was open." });
  scenarios.push({
    name: "upgrade-l1-l2",
    org: org("org_northbank", "northbank-finance", "Northbank Finance", "l2", "2026-05-14T04:30:00Z", "ap-south-1 Mumbai", [
      { level: "l1", from: iso("2026-05-14T04:30:00Z") },
      { level: "l2", from: iso(up) },
    ]),
    receipts: c.receipts(NOW),
    ctx: { packs: [{ id: "ledger1", name: "ledger1", installedAt: iso("2026-07-01T06:00:00Z") }, { id: "invoice1", name: "invoice1", installedAt: iso("2026-09-09T13:00:00Z") }], counterparties: [] },
    now: NOW,
  });
}

// 3. Proven in Bengaluru (intra-state GST): counterparty seats changing mid-month, a pack removed and installed again,
//    a dispute partly upheld with a credit note, another withdrawn.
{
  const c = chain(33);
  const t0 = Date.parse("2026-07-03T04:30:00Z");
  c.decisions(300, t0 + H, NOW - H, { sandbox: 0.1, platform: 0.1 });
  c.admin(Date.parse("2026-08-11T07:00:00Z"), "counterparty.seats.changed", { counterparty_id: "cp1", counterparty: "Vasant Bank", from: 2, to: 5 });
  c.admin(Date.parse("2026-09-25T07:00:00Z"), "counterparty.seats.changed", { counterparty_id: "cp1", counterparty: "Vasant Bank", from: 5, to: 3 });
  c.admin(Date.parse("2026-09-02T07:00:00Z"), "counterparty.seats.changed", { counterparty: "Kaveri Insurance", from: 1, to: 4 });
  c.admin(Date.parse("2026-08-18T10:00:00Z"), "pack.uninstalled", { pack: "collect1", installed_at: iso("2026-07-10T06:00:00Z") });
  const opened = c.admin(Date.parse("2026-09-04T06:00:00Z"), "billing.dispute_opened", { invoice: "EG-KAVE-202608", line: "l3-floor", reason: "Floor charged for days the custody ceremony was open." });
  c.admin(Date.parse("2026-09-10T06:00:00Z"), "billing.dispute_settled", { invoice: "EG-KAVE-202608", line: "l3-floor", outcome: "partly_upheld", credit_amount: 12903.23, note: "Two of the three days are credited." }, "elan1:farah.khan", { dispute: { ref: opened }, credit_note: { ref: opened, fmt: (seq) => `CN-KAVE-202608-${seq}` } });
  const opened2 = c.admin(Date.parse("2026-10-07T06:00:00Z"), "billing.dispute_opened", { invoice: "EG-KAVE-202609", line: "seats", reason: "Seat count looks wrong for September." });
  c.admin(Date.parse("2026-10-08T06:00:00Z"), "billing.dispute_withdrawn", { invoice: "EG-KAVE-202609", line: "seats" }, "u_owner", { dispute: { ref: opened2 } });
  c.admin(Date.parse("2026-10-09T06:00:00Z"), "evidence.exported", { format: "elan1.evidence.bundle.v1" });
  c.admin(Date.parse("2026-10-11T06:00:00Z"), "billing.reconciliation_run", { period: "2026-10", meter_events: 10, chain_decisions: 10, meter_units: 9, chain_units: 9, matched: true }, "system");
  scenarios.push({
    name: "proven-seats",
    org: org("org_kaveri", "kaveri-health", "Kaveri Health", "l3", "2026-07-03T04:30:00Z", "Bengaluru, Karnataka"),
    receipts: c.receipts(NOW),
    ctx: {
      packs: [{ id: "collect1", name: "collect1", installedAt: iso("2026-09-15T06:00:00Z") }],
      counterparties: [
        { id: "cp1", name: "Vasant Bank", seats: 3, since: iso("2026-07-20T06:00:00Z") },
        { name: "Kaveri Insurance", seats: 4, since: iso("2026-08-15T06:00:00Z") },
      ],
    },
    now: NOW,
  });
}

// 4. Proven then Sovereign: the yearly deployment licence, every action beyond at ₹0.55 (refusals ₹0.22), a lead's
//    discount ended early, a founder's 25% discount, an upheld dispute on the deployment line with a credit note.
{
  const c = chain(44);
  const t0 = Date.parse("2026-06-20T04:30:00Z");
  const sov = Date.parse("2026-08-01T00:00:00Z");
  c.decisions(150, t0 + H, sov, { platform: 0.1 });
  const early = c.admin(Date.parse("2026-07-28T06:00:00Z"), "billing.discount_offered", { pct: 10, from: "2026-08-02", until: "2026-08-20", reference: "DCB-AUG" }, "elan1:meera.iyer");
  c.admin(Date.parse("2026-08-02T06:00:00Z"), "billing.discount_accepted", { pct: 10, until: "2026-08-20" }, "u_owner", { offer: { ref: early } });
  c.admin(Date.parse("2026-08-12T06:00:00Z"), "billing.discount_ended", { reason: "Ended early" }, "u_owner", { discount: { ref: early } });
  const offer = c.admin(Date.parse("2026-08-25T06:00:00Z"), "billing.discount_offered", { pct: 25, from: "2026-09-01", until: "2027-08-31", reference: "DCB-SOV-LAUNCH" }, "elan1:founder");
  c.admin(Date.parse("2026-08-27T06:00:00Z"), "billing.discount_accepted", { pct: 25, until: "2027-08-31" }, "u_owner", { offer: { ref: offer } });
  c.decisions(420, sov + H, NOW - H, { sandbox: 0.05, platform: 0.1 });
  const d = c.admin(Date.parse("2026-09-03T06:00:00Z"), "billing.dispute_opened", { invoice: "EG-DECC-DEP-2026", line: "deployment", reason: "Licence started before go-live was signed off." });
  c.admin(Date.parse("2026-09-20T06:00:00Z"), "billing.dispute_settled", { invoice: "EG-DECC-DEP-2026", line: "deployment", outcome: "upheld", credit_amount: 12000000, note: "Go-live sign-off was late.", approved_by: "elan1:founder" }, "elan1:farah.khan", { dispute: { ref: d }, credit_note: { ref: d, fmt: (seq) => `CN-DECC-DEP-2026-${seq}` } });
  c.admin(Date.parse("2026-10-12T06:00:00Z"), "billing.dispute_opened", { invoice: "EG-DECC-202610", line: "sovereign-beyond", reason: "Actions counted twice during the cutover." });
  scenarios.push({
    name: "sovereign",
    org: org("org_deccan", "deccan-coop-bank", "Deccan Co-operative Bank", "sovereign", "2026-06-20T04:30:00Z", "On premises · Hyderabad", [
      { level: "l3", from: iso("2026-06-20T04:30:00Z") },
      { level: "sovereign", from: iso(sov) },
    ]),
    receipts: c.receipts(NOW),
    ctx: { packs: [], counterparties: [] },
    now: NOW,
  });
}

const orgDb = (o: unknown, receipts: Rec[]) => ({ org: o, receipts, members: [], platform: {} }) as never;

const out = {
  generatedBy: "scripts/billing-console-fixture.ts (the console's own pricing, chain meter and billing code)",
  now: iso(NOW),
  monthly: [] as unknown[],
  scenarios: [] as unknown[],
  pilots: [] as unknown[],
};

// monthlyInvoice: every plan, around the allowance boundary, with fractional allowance already used.
for (const id of ["l1", "l2", "l3", "sovereign"] as const) {
  const p = PLANS[id];
  for (const usedBefore of [0, 1000.4, p.includedPerYear - 50.4, p.includedPerYear - 3, p.includedPerYear - 0.8, p.includedPerYear, p.includedPerYear + 10]) {
    for (const [allowed, approved, refused, expired] of [[0, 0, 0, 0], [20, 5, 7, 2], [100, 0, 0, 0], [0, 0, 9, 0], [1, 2, 3, 4]] as const) {
      const inv = monthlyInvoice(p, { month: "2026-10", allowed, approved, refused, expired }, usedBefore);
      out.monthly.push({
        plan: id,
        usedBeforeTenths: Math.round(usedBefore * 10),
        usage: { allowed, approved, refused, expired },
        lines: inv.lines.map((l) => ({ quantity: l.quantity, amount: paise(l.amount) })),
        subtotal: paise(inv.subtotal),
        // the console's monthlyInvoice leaves GST unrounded; buildInvoices rounds it to the paisa
        gst: paise(inv.gst),
      });
    }
  }
}

for (const s of scenarios) {
  const d = orgDb(s.org, s.receipts);
  const cm = chainMeter(d, s.now);
  const invoices = buildInvoices(d, cm, s.ctx, s.now);
  const pilot = pilotOf(d, s.now);
  out.scenarios.push({
    name: s.name,
    org: { prefix: s.org.slug.split("-")[0]!.toUpperCase().slice(0, 4), name: s.org.name, level: s.org.plan, createdAt: s.org.createdAt, residency: s.org.residency },
    levelHistory: s.org.levelHistory,
    receipts: s.receipts,
    pilot: pilot ? { starts: pilot.starts, ...(pilot.convertedAt ? { convertedAt: pilot.convertedAt } : {}) } : undefined,
    discounts: discountsOf(d).map((x) => ({ seq: x.seq, pct: x.pct, from: x.from, until: x.until, ...(x.endedAt ? { endedAt: x.endedAt } : {}) })),
    disputes: disputesOf(d).map((x) => ({ seq: x.seq, invoice: x.invoice, line: x.line, reason: x.reason, by: x.by, at: x.at, open: x.open, ...(x.settlement ? { settlement: { seq: x.settlement.seq, outcome: x.settlement.outcome, credit: paise(x.settlement.credit), creditNote: x.settlement.creditNote, at: x.settlement.at } } : {}) })),
    reconciliation: reconRunsOf(d).map((r) => ({ seq: r.seq, period: r.period, meterEvents: r.meterEvents, chainDecisions: r.chainDecisions, matched: r.matched, at: r.at })),
    packs: s.ctx.packs,
    counterparties: s.ctx.counterparties,
    now: s.now,
    expect: {
      months: cm.months.map((m) => ({ month: m.month, allowed: m.allowed, approved: m.approved, refused: m.refused, expired: m.expired, pending: m.pending, tenths: Math.round(m.units * 10), events: m.events, sandbox: m.sandbox, firstSeq: m.firstSeq, lastSeq: m.lastSeq })),
      invoices: invoices.map((i) => ({
        number: i.number,
        kind: i.kind,
        period: i.period,
        status: i.status,
        subtotal: paise(i.subtotal),
        gst: paise(i.gst),
        total: paise(i.total),
        heldAmount: paise(i.heldAmount),
        payableNow: paise(i.payableNow),
        irn: i.irn,
        placeOfSupply: i.placeOfSupply,
        events: i.events,
        fromSeq: i.fromSeq,
        toSeq: i.toSeq,
        partial: i.partial,
        segments: i.segments,
        credits: i.credits?.map((x) => ({ number: x.number, amount: paise(x.amount) })),
        lines: i.lines.map((l) => ({ id: l.id, kind: l.kind, quantity: l.quantity, unit: l.unit, rate: paise(l.rate ?? 0), amount: paise(l.amount), fromSeq: l.fromSeq, toSeq: l.toSeq, held: l.held?.seq, credit: l.settled ? paise(l.settled.credit) : undefined })),
      })),
    },
  });
}

// The pilot over time: active, stopped at the cap, closed after 30 read-only days; and a quiet pilot that ends at 90 days.
{
  const t0 = Date.parse("2026-03-02T05:00:00Z");
  const busy = chain(55);
  busy.admin(t0, "billing.pilot_started", { starts: iso(t0), ends: iso(t0 + 90 * D), cap: 120, list_plan: "l1" }, "system");
  busy.decisions(170, t0 + H, t0 + 30 * D, { sandbox: 0.1, platform: 0.2, until: t0 + 31 * D });
  const quiet = chain(56);
  quiet.admin(t0, "billing.pilot_started", { starts: iso(t0), ends: iso(t0 + 90 * D), cap: 120, list_plan: "l1" }, "system");
  quiet.decisions(40, t0 + H, t0 + 60 * D, { until: t0 + 61 * D });
  for (const [name, ch] of [["cap", busy], ["days", quiet]] as const) {
    const receipts = ch.receipts();
    const states = [5, 29, 45, 70, 95, 119, 130].map((days) => {
      const now = t0 + days * D;
      const p = pilotOf(orgDb({ id: `org_pilot_${name}`, slug: "pilot", name: "Pilot", plan: "l1", createdAt: iso(t0) }, receipts.filter((r) => Date.parse(r.ts) <= now)), now)!;
      return { now, record: { starts: p.starts, ends: p.ends, cap: p.cap }, expect: { status: p.status, used: p.used, remaining: p.remaining, daysLeft: p.daysLeft, stoppedAt: p.stoppedAt, stoppedWhy: p.stoppedWhy, readOnlyUntil: p.readOnlyUntil, closedAt: p.closedAt } };
    });
    out.pilots.push({ name, receipts, states });
  }
}

const file = join(import.meta.dirname, "../packages/core/test/fixtures/billing-console.json");
writeFileSync(file, `${JSON.stringify(out)}\n`);
console.log(`wrote ${file}: ${out.monthly.length} price-book cases, ${out.scenarios.length} organisations, ${out.pilots.length} pilot states`);
