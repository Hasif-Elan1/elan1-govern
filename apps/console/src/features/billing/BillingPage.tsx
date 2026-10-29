import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BadgeCheck, BadgePercent, CalendarClock, CheckCircle2, Layers, Lock, MapPin, OctagonX, Receipt as ReceiptIcon, Scale, Server, ShieldAlert, Users } from 'lucide-react';
import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useRole, useUser } from '@/store/session';
import type { MeterEvent, PlanId } from '@/types';
import { n, pct, date, INR_PER_USD, seqLabel, relative } from '@/lib/format';
import { PLANS, REFUSAL_FACTOR, GST_RATE } from '@/lib/pricing';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { PageHeader, Panel, Banner, Button, Segmented, Meter, DataTable, EmptyState, Skeleton, Badge, StatusChip, DecisionChip, toast, type Column } from '@/components/ui';
import { AgentLink, ReceiptLink, When } from '@/components/domain';
import { StackedColumns, TrendLines, Legend, SERIES } from '@/components/charts';
import { money, rate, monthLabel, monthLabelLong, type Currency } from './model';
import { profileOrders, type ChainInvoice } from './chainMeter';
import { InvoiceDrawer, InvoiceStatus } from './InvoiceDrawer';
import { PlanComparison, CostCalculator, PLAN_QUESTION } from './PlanSections';
import { printInvoice } from './invoicePrint';
import { loadMeter } from './summary';
import { DiscountsPanel, ListPriceNote, PilotPanel, PublishedMonthly, ReconciliationRuns } from './TermsSections';
import { LIST_PRICE, PILOT, openDisputesOf } from '@/mock/billing';
import { BillingDeskPanel } from './BillingDeskPanel';
import { PlanUpsell } from '@/shell/access';

export default function BillingPage() {
  const role = useRole();
  if (role !== 'owner' && role !== 'admin') return <Forbidden />;
  return <Meter_ />;
}

function Forbidden() {
  const nav = useNavigate();
  return (
    <div>
      <PageHeader kicker="Assurance" title="Meter" description="The meter behind every receipt, the yearly allowance and every invoice line." />
      <EmptyState disc="registration" title="Owners and admins see the meter and invoices"
        action={<div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={() => nav('/assurance/refusals')}>Refusals and what they cost</Button><Button variant="secondary" onClick={() => nav('/assurance/levels')}>Assurance levels and prices</Button></div>}>
        Your role reads the chain but not the invoices. The price of every level, and what refusals cost at 40% of the per-action rate, are on the pages below.
      </EmptyState>
    </div>
  );
}

function Meter_() {
  const nav = useNavigate();
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canManage = useCan('billing.manage');
  const [sp, setSp] = useSearchParams();
  const [cur, setCur] = useState<Currency>('INR');
  const [view, setView] = useState<'month' | 'day'>('month');
  const [outcome, setOutcome] = useState<'all' | MeterEvent['outcome']>('all');
  const openId = sp.get('invoice') ?? undefined;
  const setOpenId = (id?: string) => { const next = new URLSearchParams(sp); if (id) next.set('invoice', id); else next.delete('invoice'); setSp(next, { replace: true }); };

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [meter, lv, profiles, members, ms] = await Promise.all([api.meter(o), api.level(o), api.profiles(o), api.members(o), loadMeter(o)]);
    const d = db.getDB(o);
    const cm = ms.cm;
    // only L2+ evidence bundles are ₹2,500 each; the L1 auditor pack is free and not counted here
    const exportsInFy = d.receipts.filter((r) => r.action === 'evidence.exported' && r.ts.slice(0, 7) >= cm.fy.start);
    return {
      meter, lv, packs: ms.packs, cps: ms.cps, profiles, cm, ms, fresh: !!d.fresh,
      invoices: ms.invoices,
      // disputes still open: neither withdrawn nor decided by elan1 (the demo billing desk lists them)
      disputes: openDisputesOf(d),
      orders: profileOrders(d).filter((x) => x.active),
      exportsFy: exportsInFy.filter((r) => r.details?.format === 'elan1.evidence.bundle.v1').length,
      auditorPacksFy: exportsInFy.filter((r) => r.details?.format !== 'elan1.evidence.bundle.v1').length,
      owners: members.filter((m) => m.role === 'owner' && m.status === 'active').map((m) => m.user?.name ?? m.userId).join(', '),
    };
  }, []);

  const plan = data?.lv.plan;
  const level = data?.lv.level;
  const cm = data?.cm;
  const invoices = data?.invoices ?? [];
  const openInvoice = invoices.find((i) => i.id === openId);
  const conv = (v: number) => (cur === 'INR' ? Math.round(v) : Math.round((v / INR_PER_USD) * 100) / 100);

  // the same projection the Today tile prints (summary.ts meterFacts): this allowance year's units per elapsed day, to 31 March
  const proj = data?.ms.projection;

  const usageData = (cm?.months ?? []).map((u) => ({ month: u.month, allowed: u.allowed, approved: u.approved, refused: u.refused, expired: u.expired, pending: u.pending }));
  const dayData = (cm?.days ?? []).map((x) => ({ day: x.day, committed: x.committed, refused: x.refused, pending: x.pending }));
  const monthly = invoices.filter((i) => i.kind === 'monthly').slice().reverse();
  const costData = monthly.map((inv) => ({
    month: inv.period,
    total: conv(inv.subtotal),
    floor: conv(inv.lines.filter((l) => l.kind === 'floor').reduce((s, l) => s + l.amount, 0)),
    metered: conv(inv.lines.filter((l) => l.kind === 'beyond' || l.kind === 'refused_beyond' || l.kind === 'discount').reduce((s, l) => s + l.amount, 0)),
    addons: conv(inv.lines.filter((l) => ['pack', 'seat', 'profile'].includes(l.kind)).reduce((s, l) => s + l.amount, 0)),
  }));

  const columns: Column<ChainInvoice>[] = [
    { key: 'period', header: 'Period', cell: (i) => <span className="font-medium">{i.kind === 'credit_note' ? `Credit note · ${monthLabelLong(i.period)}` : i.kind === 'deployment' ? `Deployment licence ${date(i.periodStart)}` : monthLabelLong(i.period)}{i.kind === 'credit_note' && i.creditFor && <span className="block text-xs text-muted">Against {i.creditFor.invoice}</span>}{i.segments.length > 1 && <span className="block text-xs text-muted">{i.segments.map((s) => (s.pilot ? 'Pilot' : LEVEL_INFO[s.level].short)).join(' → ')}</span>}</span>, sort: (i) => i.periodStart },
    { key: 'id', header: 'Invoice', hideBelow: 'md', cell: (i) => <span className="font-mono text-[12px] text-muted">{i.number}</span> },
    { key: 'status', header: 'Status', cell: (i) => <span className="inline-flex flex-wrap gap-1"><InvoiceStatus status={i.status} />{i.status !== 'held' && i.heldAmount > 0 && <Badge tone="held">Line held</Badge>}{i.credits?.length ? <Badge tone="info">Credited</Badge> : null}</span> },
    { key: 'events', header: 'Actions', align: 'right', hideBelow: 'lg', cell: (i) => (i.kind === 'monthly' ? n(i.events) : '—') },
    { key: 'subtotal', header: 'Taxable', align: 'right', hideBelow: 'sm', cell: (i) => money(i.subtotal, cur), sort: (i) => i.subtotal },
    { key: 'gst', header: `GST ${pct(GST_RATE)}`, align: 'right', hideBelow: 'lg', cell: (i) => money(i.gst, cur) },
    { key: 'total', header: 'Total', align: 'right', cell: (i) => <span className="font-semibold">{money(i.total, cur)}</span>, sort: (i) => i.total },
  ];

  const events = (data?.meter.events ?? []).filter((e) => outcome === 'all' || e.outcome === outcome);
  const eventCols: Column<MeterEvent>[] = [
    { key: 'seq', header: 'Receipt', cell: (e) => <ReceiptLink seq={e.seq} />, sort: (e) => e.seq },
    { key: 'ts', header: 'When', hideBelow: 'sm', cell: (e) => <When iso={e.ts} className="text-sm" /> },
    { key: 'agent', header: 'Agent', hideBelow: 'md', cell: (e) => (e.agent ? <AgentLink slug={e.agent} /> : '—') },
    { key: 'tool', header: 'Tool', hideBelow: 'lg', cell: (e) => <span className="font-mono text-[12px]">{e.tool ?? '—'}</span> },
    { key: 'decision', header: 'Decision', cell: (e) => <DecisionChip decision={e.decision} size="sm" short /> },
    { key: 'outcome', header: 'Metered as', cell: (e) => <span className="text-sm">{e.outcome === 'committed' ? 'Committed' : e.outcome === 'refused' ? 'Refused' : 'Waiting for a person'}</span> },
    { key: 'q', header: 'Units', align: 'right', cell: (e) => <span className="num">{e.quantity}</span>, sort: (e) => e.quantity },
  ];

  const rec = data?.meter.reconciliation;
  const heldPeriods = data?.ms.held ?? [];
  const unitsAgree = rec && cm ? Math.abs(rec.units - cm.totals.units) < 0.05 && heldPeriods.length === 0 : false;

  const changePlan = () => {
    if (data?.lv.next) nav(`/assurance/upgrade?to=${data.lv.next}`);
  };

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Meter"
        description="The meter behind every receipt: what a governed action costs, how much of the yearly allowance is used, and every line on every invoice — read from this organisation’s chain."
        meta={plan && level && (
          <>
            <StatusChip tone="inverse" icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}>{LEVEL_INFO[level].label}</StatusChip>
            {rec && <StatusChip tone={rec.matched && unitsAgree ? 'ok' : 'held'} icon={rec.matched && unitsAgree ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> : <ShieldAlert className="h-3.5 w-3.5" aria-hidden />}>{rec.matched && unitsAgree ? 'Meter reconciled with the chain' : heldPeriods.length ? `${heldPeriods.map(monthLabel).join(', ')} held — meter and chain differ` : 'Meter and chain differ'}</StatusChip>}
            <StatusChip tone="neutral" icon={<CalendarClock className="h-3.5 w-3.5" aria-hidden />}>{LIST_PRICE.label}</StatusChip>
          </>
        )}
        actions={
          <>
            <Segmented size="sm" label="Currency" value={cur} onChange={setCur} options={[{ value: 'INR', label: '₹ INR' }, { value: 'USD', label: 'US$' }]} />
            {/* change plan is an owner's: admins see no button */}
            {data?.lv.next ? (
              canManage && <Button variant="secondary" icon={<Layers className="h-4 w-4" />} onClick={changePlan}>Change plan</Button>
            ) : data && (
              <Button variant="secondary" icon={<Server className="h-4 w-4" />} onClick={() => nav('/agents/deployment')}>Your deployment</Button>
            )}
          </>
        }
      />

      {cur === 'USD' && <Banner tone="neutral" className="mb-6" title={`US$ figures are for reference at ₹${INR_PER_USD} to US$1`}>Invoices are issued in INR.</Banner>}
      {error && <Banner tone="bad" title="The meter could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {data && level && (data.ms.pilot || data.fresh) && <PilotPanel className="mb-6" pilot={data.ms.pilot} fresh={data.fresh} level={level} />}

      {loading && !data ? (
        <div className="grid gap-6 lg:grid-cols-12 mb-6"><Skeleton className="h-72 lg:col-span-5" /><Skeleton className="h-72 lg:col-span-7" /></div>
      ) : data && plan && level && cm && (
        cm.totals.events === 0 && invoices.length === 0 ? (
          <EmptyState disc="progress" title="No governed actions yet">The meter starts with the first governed action. Each decision becomes one meter event, read from its receipt.</EmptyState>
        ) : (
          <>
            <div className="grid gap-6 lg:grid-cols-12 mb-6 [&>*]:min-w-0">
              <Panel className="lg:col-span-5" kicker="Current plan" title={<span className="flex flex-wrap items-center gap-2">{plan.level} · {plan.name}<StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Active since {date(data.lv.since)}</StatusChip></span>}>
                <p className="text-sm text-muted italic">“{PLAN_QUESTION[plan.id]}”</p>
                <dl className="mt-4 grid grid-cols-2 gap-px bg-line border border-line">
                  <PlanFact k={level === 'sovereign' ? 'Deployment licence' : 'Platform floor'} v={money(plan.floorPerYear, cur)} sub={level === 'sovereign' ? 'a year, per deployment' : 'a year · never discounted'} />
                  <PlanFact k="Included actions" v={plan.includedPerYear ? n(plan.includedPerYear) : 'None'} sub={plan.includedPerYear ? 'a year' : 'every action metered'} />
                  <PlanFact k="Per action" v={rate(plan.overageRate, cur)} sub={plan.includedPerYear ? 'beyond the allowance' : 'every action'} />
                  <PlanFact k="Refused action" v={rate(plan.refusalRate, cur)} sub={`${pct(REFUSAL_FACTOR)} of the per-action rate`} accent />
                </dl>
                {data.lv.boundaries.length > 0 && (
                  <p className="mt-4 text-sm text-muted">
                    {data.lv.boundaries.map((b) => `${LEVEL_INFO[b.from].short} → ${LEVEL_INFO[b.to].short} on ${date(b.at)}`).join(' · ')}. Invoices for a month that crosses a boundary carry both plans, each for its days.
                  </p>
                )}
                <p className="mt-2 text-xs text-muted">Bought by: {plan.buyer}. {data.lv.deployment === 'sovereign' ? 'Runs on your infrastructure.' : `Hosted by elan1 in ${data.lv.residency}.`}</p>
                {data.ms.activeDiscount && <p className="mt-2 text-sm"><BadgePercent className="inline h-3.5 w-3.5 mr-1 align-[-2px]" aria-hidden />{data.ms.activeDiscount.pct}% off governed actions beyond the allowance until {date(`${data.ms.activeDiscount.until}T12:00:00Z`)}.</p>}
                <ListPriceNote planId={plan.id} cur={cur} />
              </Panel>

              <Panel className="lg:col-span-7" kicker={cm.fy.label} title={plan.includedPerYear ? 'Yearly allowance' : 'Metered this year'} actions={<span className="text-xs text-muted">April to March</span>}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="font-display text-4xl font-semibold num tracking-tighter2">{plan.includedPerYear ? pct(cm.fy.share, cm.fy.share < 0.01 ? 2 : 1) : n(Math.round(cm.fy.units))}</p>
                    <p className="text-sm text-muted num">{plan.includedPerYear ? `${n(cm.fy.units)} of ${n(plan.includedPerYear)} included actions used` : 'units metered (committed 1, refused 0.4)'}</p>
                    {!plan.includedPerYear && <p className="text-sm num">Governed actions this month so far: <span className="font-semibold">{money(data.ms.actionCharge, cur)}</span> <span className="text-muted">before GST</span></p>}
                  </div>
                  {proj && plan.includedPerYear > 0 && (proj.runsOut
                    ? <StatusChip tone="held" icon={<CalendarClock className="h-3 w-3" aria-hidden />}>Projected to run out {proj.runOutAt ? date(proj.runOutAt) : ''}</StatusChip>
                    : <StatusChip tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Projected to last the year</StatusChip>)}
                </div>
                {plan.includedPerYear > 0 && <Meter className="mt-4 h-2.5" value={Math.max(cm.fy.share, 0.004)} tone={cm.fy.share > 0.85 ? 'held' : 'inverse'} label="Share of the yearly allowance used" />}
                <dl className="mt-5 grid sm:grid-cols-3 gap-px bg-line border border-line">
                  <PlanFact k="Allowed and approved" v={n(cm.fy.committed)} sub="1 included action each" />
                  <PlanFact k="Refused or expired" v={n(cm.fy.refused)} sub={`${REFUSAL_FACTOR} each = ${n(Math.round(cm.fy.refused * REFUSAL_FACTOR * 10) / 10)}`} />
                  <PlanFact k="Run rate" v={proj ? n(Math.round(proj.perMonth)) : '—'} sub="units a month, from the chain" />
                </dl>
                {cm.fy.coveredFrom && <p className="mt-3 text-xs text-muted">Counted from {date(cm.fy.coveredFrom)}, where this console’s copy of the chain starts.</p>}
              </Panel>
            </div>

            <section aria-labelledby="rule-h" className="mb-6 border border-line bg-surface grid lg:grid-cols-12">
              <div className="lg:col-span-5 p-5 border-b lg:border-b-0 lg:border-r border-line">
                <p className="label mb-1">The pricing rule</p>
                <h2 id="rule-h" className="text-xl font-semibold leading-snug">A refused action costs {pct(REFUSAL_FACTOR)} of the per-action rate.</h2>
                <p className="mt-2 text-sm text-muted leading-relaxed">Every refusal is decided, {level === 'l1' ? 'sealed' : 'signed'} and kept in the chain like any other action, so it is metered — at less than half the rate. Refusals are never free and never the full price.</p>
              </div>
              <div className="lg:col-span-7 grid sm:grid-cols-2">
                <div className="p-5 border-b sm:border-b-0 sm:border-r border-line">
                  <p className="label mb-2 flex items-center gap-1.5"><OctagonX className="h-3.5 w-3.5" aria-hidden />Inside the allowance</p>
                  <p className="text-sm">A refusal uses <span className="font-semibold">{REFUSAL_FACTOR}</span> of an included action.</p>
                  <p className="mt-1 text-xs text-muted num">{plan.includedPerYear ? `1,000 refusals use 400 of your ${n(plan.includedPerYear)} included actions.` : 'Sovereign has no allowance: every action is metered.'}</p>
                </div>
                <div className="p-5">
                  <p className="label mb-2 flex items-center gap-1.5"><ReceiptIcon className="h-3.5 w-3.5" aria-hidden />Beyond the allowance</p>
                  <p className="text-sm">A refusal costs <span className="font-semibold num">{rate(plan.refusalRate, cur)}</span>, against <span className="num">{rate(plan.overageRate, cur)}</span> for an action.</p>
                  <p className="mt-1 text-xs text-muted num">1,000 refusals cost {money(1000 * plan.refusalRate, cur)}. Expired approvals count as refusals.</p>
                </div>
              </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-12 mb-6 [&>*]:min-w-0">
              <Panel className="lg:col-span-7" title="Governed actions" kicker={view === 'month' ? 'By month, from the chain' : 'Last 30 days, IST'}
                actions={<Segmented size="sm" label="Period" value={view} onChange={setView} options={[{ value: 'month', label: 'Months' }, { value: 'day', label: '30 days' }]} />}>
                {view === 'month' ? (
                  <>
                    <StackedColumns data={usageData} xKey="month" xFmt={monthLabel} height={240} keys={[
                      { key: 'allowed', name: 'Allowed', color: SERIES.allow },
                      { key: 'approved', name: 'Approved by a person', color: SERIES.ask },
                      { key: 'refused', name: 'Refused', color: SERIES.refuse },
                      { key: 'expired', name: 'Expired — refused', color: SERIES.muted },
                      { key: 'pending', name: 'Waiting for a person', color: SERIES.ink },
                    ]} />
                    <div className="mt-3"><Legend items={[
                      { label: 'Allowed', color: SERIES.allow },
                      { label: 'Approved by a person', color: SERIES.ask },
                      { label: 'Refused', color: SERIES.refuse },
                      { label: 'Expired — refused', color: SERIES.muted },
                      { label: 'Waiting (not metered yet)', color: SERIES.ink },
                    ]} /></div>
                  </>
                ) : (
                  <>
                    <StackedColumns data={dayData} xKey="day" xFmt={(d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} height={240} keys={[
                      { key: 'committed', name: 'Committed', color: SERIES.allow },
                      { key: 'refused', name: 'Refused', color: SERIES.refuse },
                      { key: 'pending', name: 'Waiting for a person', color: SERIES.ink },
                    ]} />
                    <div className="mt-3"><Legend items={[{ label: 'Committed', color: SERIES.allow }, { label: 'Refused', color: SERIES.refuse }, { label: 'Waiting', color: SERIES.ink }]} /></div>
                  </>
                )}
                <p className="mt-3 text-xs text-muted">{n(cm.totals.events)} governed actions from {seqLabel(cm.window.firstSeq ?? 0)} to {seqLabel(cm.window.lastSeq ?? 0)}; months before {cm.window.from ? date(cm.window.from) : 'the chain'} are outside this console’s copy of the chain.</p>
              </Panel>
              <Panel className="lg:col-span-5" title="Cost by month" kicker={`Before GST · ${cur === 'INR' ? '₹' : 'US$'}`}>
                {costData.length === 0 ? <EmptyState compact title="No monthly invoice yet" disc="registration">The first one is drafted with the first governed action of the month.</EmptyState> : (
                  <>
                    <TrendLines data={costData} xKey="month" xFmt={monthLabel} height={240} lines={[
                      { key: 'total', name: 'Taxable value', color: SERIES.ink },
                      { key: 'floor', name: 'Floor', color: SERIES.muted },
                      { key: 'metered', name: 'Beyond allowance', color: SERIES.accent },
                      { key: 'addons', name: 'Add-ons', color: SERIES.ask },
                    ]} />
                    <div className="mt-3"><Legend items={[
                      { label: 'Taxable value', color: SERIES.ink },
                      { label: 'Floor', color: SERIES.muted },
                      { label: 'Beyond allowance', color: SERIES.accent },
                      { label: 'Add-ons', color: SERIES.ask },
                    ]} /></div>
                  </>
                )}
              </Panel>
            </div>

            <Panel title="Invoices" flush className="mb-6" kicker={level === 'sovereign' ? 'Deployment licence yearly · actions monthly' : 'Monthly, per plan in force'}
              footer={<span>Open an invoice for every line, the records behind it, GST details, the PDF, and to dispute a line.</span>}>
              <DataTable className="border-0" caption="Invoices" columns={columns} rows={invoices} rowKey={(i) => i.id} selectedKey={openId} onRowClick={(i) => setOpenId(i.id)}
                empty={<EmptyState compact title="No invoices yet" disc="registration">The first invoice is drafted with the first governed action.</EmptyState>} />
            </Panel>

            <div className="grid gap-6 lg:grid-cols-12 mb-8 [&>*]:min-w-0">
              <Panel className="lg:col-span-8" title="Meter events" kicker="Newest 200 · one per governed action" flush
                actions={<Segmented<'all' | MeterEvent['outcome']> size="sm" label="Metered as" value={outcome} onChange={setOutcome} options={[{ value: 'all', label: 'All' }, { value: 'committed', label: 'Committed' }, { value: 'refused', label: 'Refused' }, { value: 'pending', label: 'Waiting' }]} />}>
                <DataTable className="border-0" caption="Meter events" columns={eventCols} rows={events} rowKey={(e) => e.id} maxHeight={420} onRowClick={(e) => nav(`/activity/${e.seq}`)}
                  empty={<EmptyState compact title="No events match" disc="aperture">Try another filter.</EmptyState>} />
              </Panel>
              <Panel className="lg:col-span-4" title="Reconciliation" kicker="Meter against the chain">
                {rec && (
                  <>
                    <StatusChip tone={rec.matched && unitsAgree ? 'ok' : 'held'} icon={rec.matched && unitsAgree ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> : <ShieldAlert className="h-3.5 w-3.5" aria-hidden />}>{rec.matched && unitsAgree ? 'Matched' : `Differs by ${n(rec.difference)}`}</StatusChip>
                    <dl className="mt-4 border border-line divide-y divide-line text-sm">
                      <Row k="Meter events" v={n(rec.meterEvents)} />
                      <Row k="Decisions in the chain" v={n(rec.chainDecisions)} />
                      <Row k="Units (meter)" v={n(rec.units)} />
                      <Row k="Units (recounted here)" v={n(cm.totals.units)} />
                      <Row k="Up to" v={seqLabel(rec.headSeq)} />
                    </dl>
                    <p className="mt-3 text-xs text-muted break-all">Digest <span className="font-mono">{rec.digest.slice(0, 32)}…</span> · checked {relative(rec.checkedAt)}</p>
                    <p className="mt-2 text-xs text-muted leading-relaxed">Every meter event carries its receipt sequence; a line without one cannot be invoiced. The nightly run counts the meter against the chain both ways. If they disagree for a period, its invoice is held — never issued on the lower number — until the period reconciles. Sandbox calls (sk_sbx_) are metered at 0{cm.totals.sandbox ? `: ${n(cm.totals.sandbox)} in this window` : ''}.</p>
                    <ReconciliationRuns runs={data.ms.runs} invoices={invoices} />
                  </>
                )}
              </Panel>
            </div>

            <div className="grid gap-6 lg:grid-cols-12 mb-6 [&>*]:min-w-0">
              <PublishedMonthly className="lg:col-span-7" cm={cm} invoices={invoices} cur={cur} />
              <DiscountsPanel className="lg:col-span-5" offers={data.ms.offers} requests={data.ms.requests} cur={cur} />
            </div>

            <BillingDeskPanel className="mb-6" disputes={data.disputes} requests={data.ms.requests} pilot={data.ms.pilot} invoices={invoices} cur={cur} />

            <section className="mb-8" aria-labelledby="plans-h">
              <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
                <div>
                  <p className="label mb-1">Plans</p>
                  <h2 id="plans-h" className="text-xl font-semibold">Compare the levels</h2>
                </div>
                <Link to="/assurance/levels" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">What each level proves<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
              </div>
              <PlanComparison plans={Object.values(PLANS)} currentId={plan.id} cur={cur} canUpgrade={role === 'owner'} owners={data.owners || '—'} onUpgrade={(id: PlanId) => nav(`/assurance/upgrade?to=${id}`)} />
            </section>

            <div className="mb-8">
              <CostCalculator cur={cur} defaultPlan={plan.id} defaultActions={proj ? Math.max(100, Math.round(proj.perMonth)) : undefined} defaultShare={cm.totals.events ? Math.round((cm.totals.refused / cm.totals.events) * 1000) / 10 : undefined} />
            </div>

            <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
              <AddOnsPanel className="lg:col-span-7" data={data} cur={cur} level={level} orgId={orgId} userId={user?.id} role={role} canManage={canManage} />
              <Panel className="lg:col-span-5" title="The rules, plainly" kicker="Price book">
                <ul className="space-y-3 text-sm">
                  <RuleItem icon={<Users className="h-4 w-4" />} title="No per-seat pricing">Invite every approver, auditor and viewer you need. People are never counted. A counterparty seat is a verifying organisation, not a person.</RuleItem>
                  <RuleItem icon={<Lock className="h-4 w-4" />} title="The floor is never discounted">Discounts, where agreed, apply to metered usage and carry an end date.</RuleItem>
                  <RuleItem icon={<CalendarClock className="h-4 w-4" />} title="Modelled list prices, flat to March 2029">{LIST_PRICE.note} The rates on this page do not rise before 31 March 2029; from April 2029 they rise 4% a year.</RuleItem>
                  <RuleItem icon={<BadgePercent className="h-4 w-4" />} title="Discounts are capped and end">Only elan1 offers a discount, and an owner accepts it here. An elan1 lead may discount overage by up to 20% for up to 12 months; only a founder may go further. Never the floor, a refusal or the evidence line.</RuleItem>
                  <RuleItem icon={<Lock className="h-4 w-4" />} title={`Pilot: ${PILOT.days} days free, ${n(PILOT.cap)} actions`}>Guarded only. A hard stop at the limit: writes are paused ({PILOT.code}) and the organisation is read-only for {PILOT.readOnlyDays} days, then closed, unless an owner moves it to the paid plan. An upgrade ends the pilot at the boundary.</RuleItem>
                  <RuleItem icon={<OctagonX className="h-4 w-4" />} title={`A refusal costs ${pct(REFUSAL_FACTOR)} of an action`}>Inside the allowance it uses {REFUSAL_FACTOR} of an included action. Expired approvals count as refusals.</RuleItem>
                  <RuleItem icon={<BadgePercent className="h-4 w-4" />} title="Prices exclude GST">GST at {pct(GST_RATE)} is added to every invoice: CGST and SGST in the same state, IGST across states.</RuleItem>
                  <RuleItem icon={<Scale className="h-4 w-4" />} title="The offline verifier is free">To anyone, at every level, for ever.</RuleItem>
                </ul>
              </Panel>
            </div>
          </>
        )
      )}

      <InvoiceDrawer invoice={openInvoice} cur={cur} onClose={() => setOpenId(undefined)} onOpen={(id) => setOpenId(id)} onPrint={(inv) => { if (!printInvoice(inv, cur)) toast.bad('The PDF window was blocked', 'Allow pop-ups for this site, then try again.'); }} />
    </div>
  );
}

/* ── Add-ons ─────────────────────────────────────────────── */

interface BillingData {
  packs: Awaited<ReturnType<typeof api.packs>>;
  profiles: Awaited<ReturnType<typeof api.profiles>>;
  cps: Awaited<ReturnType<typeof api.counterparties>>;
  orders: ReturnType<typeof profileOrders>;
  exportsFy: number;
  auditorPacksFy: number;
  owners: string;
}

function AddOnsPanel({ data, cur, level, orgId, userId, role, canManage, className }: { data: BillingData; cur: Currency; level: string; orgId: string; userId?: string; role?: string; canManage: boolean; className?: string }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState<string>();
  const l2 = atLeast(level as PlanId, 'l2');
  const l3 = atLeast(level as PlanId, 'l3');
  const ownerAdmin = role === 'owner' || role === 'admin';

  const install = async (id: Parameters<typeof api.installPack>[1], name: string) => {
    if (!userId) return;
    setBusy(id);
    try { await api.installPack(orgId, id, userId); toast.ok(l2 ? `${name} installed` : `${name} installed as a dry run`, l2 ? 'It appears on the next invoice at ₹1,35,000 a year. Its verifier profile is ordered and billed separately.' : 'Its rules run and its reports say “dry run — no regulatory claim until L2”. It is billed at ₹1,35,000 a year from the move to L2.'); } catch (e) { toast.bad('The pack could not be installed', (e as Error).message); } finally { setBusy(undefined); }
  };
  // through the same server checks as the profile and pack pages: issued and not withdrawn, not ordered twice, the owner's
  // role; billing is re-derived and the order or cancellation is a receipt (mock/packsFactory.ts)
  const order = async (profileId: string, on: boolean) => {
    if (!userId) return;
    setBusy(`profile:${profileId}`);
    try {
      const r = on ? await api.orderProfile(orgId, profileId, userId) : await api.cancelProfileOrder(orgId, profileId, userId);
      toast.ok(on ? 'Verifier profile ordered' : 'Verifier profile cancelled', `${on ? 'Billed from today at ₹3,00,000 a year, on its own line.' : 'Billed to the end of this month, and not from next month.'} Receipt ${seqLabel(r.seq)}.`);
    } catch (e) { toast.bad(on ? 'The profile could not be ordered' : 'The order could not be cancelled', (e as Error).message); } finally { setBusy(undefined); }
  };

  return (
    <Panel className={className} title="Add-ons" kicker="Priced separately · what this organisation has" flush>
      <ul className="divide-y divide-line">
        <li className="px-5 py-4">
          <AddOnHead name="Regulatory packs" price={`${money(135000, cur)} per pack a year`} note={l2 ? 'ledger1 · invoice1 · collect1, each admitted only after five admission checks (A to E)' : 'At L1 a pack installs as a dry run — no regulatory claim and no charge until L2'} />
          {(
            <ul className="mt-3 space-y-2">
              {data.packs.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span><Link className="link font-medium" to={`/records/packs/${p.id}`}>{p.name}</Link> <span className="text-muted">· {p.regime}</span></span>
                  {p.installed ? <StatusChip size="sm" tone={l2 ? 'ok' : 'info'} icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>{l2 ? 'Installed' : 'Dry run'}{p.installedAt ? ` ${date(p.installedAt)}` : ''}</StatusChip>
                    : <Button size="sm" variant="secondary" loading={busy === p.id} disabled={!ownerAdmin} title={!ownerAdmin ? 'Owners and admins install packs.' : undefined} onClick={() => install(p.id, p.name)}>Install</Button>}
                </li>
              ))}
            </ul>
          )}
        </li>
        {/* add-ons above the plan: owners see one compact line, admins nothing (no heading above an empty slot) */}
        {!l2 ? (role === 'owner' && <li className="px-5 py-3"><Preview to="l2" what="Verifier profiles start at L2." /></li>) : (
        <li className="px-5 py-4">
          <AddOnHead name="Verifier profiles" price={`${money(300000, cur)} per regime a year`} note="Billed as its own line — not included with a regulatory pack" />
          {(
            <ul className="mt-3 space-y-2">
              {data.profiles.map((p) => {
                const ordered = data.orders.find((o) => o.profileId === p.id);
                const ent = p.entitlement;
                // only an issued profile that is not withdrawn is ordered; a withdrawn one with an open order is flagged
                const blocked = ent?.withdrawn ? 'Withdrawn — it cannot be ordered, run or claimed.' : ent && ent.issued === false ? 'Not issued yet — a draft is ordered once a second person issues it.' : undefined;
                return (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0"><span className="font-medium">{p.name}</span> <span className="text-muted">· {p.regime}</span>{ordered && ent?.withdrawn && <span className="block text-xs text-bad-fg">Withdrawn with its order still open: it is billed until the order is cancelled.</span>}</span>
                    {ordered ? <span className="inline-flex items-center gap-2"><StatusChip size="sm" tone={ent?.withdrawn ? 'bad' : 'ok'} icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Ordered {date(ordered.at)}</StatusChip>{canManage && <button type="button" className="text-xs underline underline-offset-2 text-muted hover:text-fg disabled:opacity-50" disabled={busy === `profile:${p.id}`} onClick={() => order(p.id, false)}>Cancel</button>}</span>
                        : blocked ? <StatusChip size="sm" tone={ent?.withdrawn ? 'bad' : 'neutral'}>{ent?.withdrawn ? 'Withdrawn' : 'Not issued'}</StatusChip>
                        : canManage ? <Button size="sm" variant="secondary" loading={busy === `profile:${p.id}`} onClick={() => order(p.id, true)}>Order</Button>
                        : <StatusChip size="sm" tone="neutral">Not ordered</StatusChip>}
                    {!ordered && blocked && <span className="basis-full text-xs text-muted">{blocked}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </li>
        )}
        {!l3 ? (role === 'owner' && <li className="px-5 py-3"><Preview to="l3" what="Counterparty seats start at L3." /></li>) : (
          <li className="px-5 py-4">
            <AddOnHead name="Counterparty verification seats" price={`${money(45000, cur)} per seat a year`} note="One per organisation that verifies your receipts" />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>{n(data.cps.seatsTotal)} seats across {n(data.cps.counterparties.length)} counterparties · {money(data.cps.seatsTotal * 45000, cur)} a year</span>
              <Button size="sm" variant="secondary" onClick={() => nav('/assurance/counterparties')}>Register a counterparty</Button>
            </div>
          </li>
        )}
        {l2 ? (
          <li className="px-5 py-4">
            <AddOnHead name="Evidence bundles" price={`${money(2500, cur)} per L2+ bundle`} note="The L1 auditor pack is free" />
            <p className="mt-2 text-sm">{`${n(data.exportsFy)} L2+ ${data.exportsFy === 1 ? 'bundle' : 'bundles'} this fiscal year at ${money(2500, cur)} each = ${money(data.exportsFy * 2500, cur)}`}{data.auditorPacksFy ? ` · ${n(data.auditorPacksFy)} L1 auditor ${data.auditorPacksFy === 1 ? 'pack' : 'packs'}, free` : ''} · <Link className="link" to="/assurance/exports">Exports</Link></p>
          </li>
        ) : (
          <li className="px-5 py-4">
            <AddOnHead name="Auditor packs" price="Free" note="What this organisation exports at L1" />
            <p className="mt-2 text-sm">{n(data.auditorPacksFy)} auditor {data.auditorPacksFy === 1 ? 'pack' : 'packs'} this fiscal year · <Link className="link" to="/assurance/exports">Exports</Link></p>
          </li>
        )}
      </ul>
    </Panel>
  );
}

function AddOnHead({ name, price, note }: { name: string; price: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="min-w-0"><p className="font-medium">{name}</p><p className="text-xs text-muted">{note}</p></div>
      <p className="text-sm num font-semibold">{price}</p>
    </div>
  );
}

/** An add-on above the plan: owners see one compact line linking to Assurance levels; admins see nothing. */
function Preview({ to, what }: { to: 'l2' | 'l3'; what: string }) {
  return <PlanUpsell to={to} what={what} />;
}

function PlanFact({ k, v, sub, accent }: { k: string; v: string; sub?: string; accent?: boolean }) {
  return (
    <div className={'bg-surface p-3 min-w-0 ' + (accent ? 'shadow-[inset_3px_0_0_rgb(var(--fg))]' : '')}>
      <dt className="label">{k}</dt>
      <dd className="mt-1 font-display text-xl font-semibold num truncate">{v}</dd>
      {sub && <dd className="text-xs text-muted">{sub}</dd>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex items-baseline justify-between gap-3 px-3 py-2"><dt className="text-muted">{k}</dt><dd className="num font-medium text-right">{v}</dd></div>;
}

function RuleItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center border border-line bg-sunken text-fg">{icon}</span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-muted">{children}</span>
      </span>
    </li>
  );
}
