import type { ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, CircleSlash, Info, OctagonX, ScrollText } from 'lucide-react';
import { api, db } from '@/api';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useOrgLevel, useRole } from '@/store/session';
import { PLANS, REFUSAL_FACTOR } from '@/lib/pricing';
import { levelRank } from '@/lib/levels';
import { n, pct, plural, rupees, timeShort, TZ } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, DataTable, EmptyState, PageHeader, Panel, Segmented, Skeleton, StatusChip, type Column } from '@/components/ui';
import { AgentLink, ReceiptLink, When } from '@/components/domain';
import { useScreenAccess } from '@/shell/access';
import { Legend, SERIES, StackedColumns } from '@/components/charts';
import { REFUSAL_CLASSES, REFUSAL_CLASSES_FULL, SYSTEM_RULES, isGuardRule, type RefusalClass, type RefusalClassFull } from '@/features/activity/shared';
import { buildInvoices, chainMeter, refusalCost } from '@/features/billing/chainMeter';
import { RANGES, activityHref, classLabel, firstTs, parseRange, refusalStats, windowFor, type AgentRow, type RangeId, type RuleRow, type ToolRow } from './model';

/** Where the chart draws each level class (the same fold as refusalClass). */
const LEVEL_FOLD: Partial<Record<RefusalClassFull, RefusalClass>> = { autonomy: 'rule', pack_gate: 'rule' };

const CLASS_COLOUR: Record<RefusalClass, string> = {
  rule: SERIES.refuse,
  default: SERIES.ink,
  paused: 'rgb(var(--fg) / 0.5)',
  invalid: SERIES.muted,
  rejected: SERIES.accent,
  expiry: 'rgb(var(--subtle) / 0.45)',
};

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: TZ });

/**
 * Door 04 · Assurance — Refusals. Refusals are evidence: every "no" is a signed receipt that names the rule.
 * Analytics across the chain by reason, agent, rule and tool, with the metered cost at 40% of the per-action rate.
 */
export default function RefusalsPage() {
  const nav = useNavigate();
  const role = useRole();
  const [sp, setSp] = useSearchParams();
  const level = useOrgLevel();
  const range = parseRange(sp.get('range'));
  const setRange = (r: RangeId) => { const next = new URLSearchParams(sp); if (r === '7d') next.delete('range'); else next.set('range', r); setSp(next, { replace: true }); };
  const now = useNow(60_000);

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const lv = await api.level(o);
    const d = db.getDB(o);
    const meter = chainMeter(d);
    const w = windowFor(range, Date.now(), firstTs(d.receipts));
    return {
      stats: refusalStats(d.receipts, range),
      plan: PLANS[lv.level],
      cost: refusalCost(meter, w.from, w.to),
      invoices: buildInvoices(d, meter, { packs: [], counterparties: [] }).filter((i) => i.kind === 'monthly').map((i) => ({ id: i.id, period: i.period })),
      rulebooks: Object.fromEntries(d.rulebooks.map((rb) => [rb.slug, rb.slug])) as Record<string, string>,
    };
  }, [range, Math.floor(now / 60_000)]);

  const st = data?.stats;
  const r = RANGES[range];
  const delta = st && st.prevCovered && st.prevRefused > 0 ? ((st.refused.length - st.prevRefused) / st.prevRefused) * 100 : undefined;
  const xFmt = (iso: string) => (range === '24h' ? timeShort(iso) : dayFmt.format(new Date(iso)));

  const agentCols: Column<AgentRow>[] = [
    { key: 'agent', header: 'Agent', cell: (a) => <AgentLink slug={a.slug} /> },
    { key: 'refused', header: 'Refused', align: 'right', sort: (a) => a.refused, cell: (a) => <Link className="link num" to={activityHref(range, { agent: a.slug })} onClick={(e) => e.stopPropagation()} aria-label={`${n(a.refused)} refusals by ${a.slug} in Activity`}>{n(a.refused)}</Link> },
    { key: 'share', header: 'Of its calls', align: 'right', sort: (a) => (a.calls ? a.refused / a.calls : 0), hideBelow: 'sm', cell: (a) => <span className="num">{a.calls ? pct(a.refused / a.calls, 1) : '—'}</span> },
    { key: 'top', header: 'Most often', hideBelow: 'md', cell: (a) => (a.topRule ? <span className="font-mono text-[12px]">{a.topRule} <span className="text-subtle">×{n(a.topRuleCount)}</span></span> : '—') },
    { key: 'last', header: 'Last', align: 'right', sort: (a) => a.last?.seq ?? 0, hideBelow: 'sm', cell: (a) => (a.last ? <span className="inline-flex items-center gap-2"><ReceiptLink seq={a.last.seq} /><When iso={a.last.ts} className="text-xs text-muted" /></span> : '—') },
  ];

  const ruleCols: Column<RuleRow>[] = [
    { key: 'rule', header: 'Rule', cell: (x) => (
      <span className="min-w-0">
        <span className="block font-mono text-[12.5px] truncate" title={(isGuardRule(x.ruleId) ? SYSTEM_RULES[x.ruleId] : undefined) ?? x.last.reason}>{x.ruleId}</span>
        <span className="block text-xs text-muted truncate max-w-[34ch]">{x.cls === 'rejected' ? (isGuardRule(x.ruleId) ? 'Held by the guard; a person rejected it' : 'Held by this rule; a person rejected it') : x.cls === 'expiry' ? (isGuardRule(x.ruleId) ? 'Held by the guard; no one decided in time' : 'Held by this rule; no one decided in time') : isGuardRule(x.ruleId) ? 'Refused by the guard itself' : x.last.reason ?? classLabel(x.cls)}</span>
      </span>
    ) },
    { key: 'class', header: 'Reason', hideBelow: 'lg', cell: (x) => <Badge>{classLabel(x.cls)}</Badge> },
    { key: 'agent', header: 'Agent', hideBelow: 'md', cell: (x) => <AgentLink slug={x.agent} /> },
    { key: 'count', header: 'Refused', align: 'right', sort: (x) => x.count, cell: (x) => <Link className="link num" onClick={(e) => e.stopPropagation()} to={activityHref(range, { agent: x.agent, rc: x.cls, q: x.cls === 'rejected' || x.cls === 'expiry' || x.cls === 'paused' || x.cls === 'invalid' ? undefined : x.ruleId })}>{n(x.count)}</Link> },
    { key: 'last', header: 'Last', align: 'right', sort: (x) => x.last.seq, hideBelow: 'sm', cell: (x) => <span className="inline-flex items-center gap-2"><ReceiptLink seq={x.last.seq} /><When iso={x.last.ts} className="text-xs text-muted" /></span> },
    { key: 'rb', header: <span className="sr-only">Rulebook</span>, align: 'right', hideBelow: 'sm', cell: (x) => (x.agent && data?.rulebooks[x.agent] && !isGuardRule(x.ruleId) && !x.ruleId.startsWith('approval-')
      ? <Link className="link text-xs whitespace-nowrap" onClick={(e) => e.stopPropagation()} to={`/rulebooks/${x.agent}`}>Rulebook</Link>
      : <span className="text-xs text-subtle">—</span>) },
  ];

  const toolCols: Column<ToolRow>[] = [
    { key: 'tool', header: 'Tool', cell: (t) => <span className="font-mono text-[12.5px]">{t.tool}</span> },
    { key: 'agents', header: 'Agents', hideBelow: 'md', cell: (t) => <span className="text-sm text-muted truncate">{t.agents.join(', ') || '—'}</span> },
    { key: 'count', header: 'Refused', align: 'right', sort: (t) => t.count, cell: (t) => <Link className="link num" onClick={(e) => e.stopPropagation()} to={activityHref(range, { tool: t.tool })}>{n(t.count)}</Link> },
    { key: 'last', header: 'Last', align: 'right', sort: (t) => t.last.seq, hideBelow: 'sm', cell: (t) => <ReceiptLink seq={t.last.seq} /> },
  ];

  const plan = data?.plan;
  const cost = data?.cost;
  const refusedCount = st?.refused.length ?? 0;
  const ownerAdmin = role === 'owner' || role === 'admin';
  const { canSee } = useScreenAccess();
  const canBilling = ownerAdmin && canSee('/billing');

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Refusals"
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        description={`Refusals are evidence. Every refused call is a ${levelRank(level) >= 1 ? 'signed receipt' : 'receipt sealed in the hash chain'} that names the rule, the agent and the reason — proof the guard said no, not only that it said yes.`}
        actions={
          <>
            <Segmented<RangeId> label="Time range" value={range} onChange={setRange} options={(Object.keys(RANGES) as RangeId[]).map((k) => ({ value: k, label: RANGES[k].label }))} />
            {/* the Work door is not an auditor's: no Not done button for them */}
            {canSee('/work/not-done') && <Button variant="secondary" icon={<CircleSlash className="h-4 w-4" />} onClick={() => nav('/work/not-done')}>Not done queue</Button>}
          </>
        }
      />

      {error && <Banner tone="bad" title="Refusals could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      {/* headline numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-line border border-line mb-6" aria-live="polite">
        <Figure label={`Refused · ${r.label}`} loading={!st}
          value={st ? <Link to={activityHref(range)} className="hover:underline underline-offset-4">{n(refusedCount)}</Link> : '—'}
          sub={st && (delta === undefined ? (range === 'all' ? 'Across the whole chain window' : st.prevCovered ? 'No refusals in the period before' : `The chain window does not reach the ${r.label} before`) :<span className={cn('num', delta > 0 ? 'text-bad-fg' : 'text-ok-fg')}>{delta > 0 ? '+' : ''}{delta.toFixed(0)}% on the {r.label} before ({n(st.prevRefused)})</span>)} />
        <Figure label="Share of calls" loading={!st} value={st ? pct(st.share, 1) : '—'} sub={st && `of ${plural(st.calls, 'decided call')}`} />
        <Figure label="Agents refused" loading={!st} value={st ? n(st.agents.length) : '—'} sub={st && `${plural(st.rules.length, 'rule and reason', 'rules and reasons')}`} />
        <Figure label="Metered cost" loading={!cost} value={cost ? rupees(cost.cost, { paise: cost.cost < 100 }) : '—'} sub={cost && (cost.beyond ? `${n(cost.beyond)} beyond the allowance at ${pct(REFUSAL_FACTOR)} of the rate` : `${n(cost.inside)} inside the allowance: ${n(cost.unitsInside)} included actions`)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-8 space-y-6">
          <Panel
            title="Refusals by reason"
            kicker={range === '24h' ? 'By hour, IST' : 'By day, IST'}
            actions={<Link to={activityHref(range)} className="link text-sm whitespace-nowrap">Open in Activity</Link>}
          >
            {!st ? (error ? <p className="text-sm text-muted">The chart could not be drawn because the chain could not be loaded.</p> : <Skeleton className="h-[240px]" />) : refusedCount === 0 ? (
              <EmptyState compact disc="aperture" title={`No refusals in ${r.long}`} action={range !== 'all' ? <Button size="sm" onClick={() => setRange('all')}>Look at the whole window</Button> : undefined}>
                Every call in this window was allowed or held for a person. Refusals appear here as soon as the guard says no.
              </EmptyState>
            ) : (
              <>
                <div role="img" aria-label={`Refusals ${range === '24h' ? 'per hour' : 'per day'} over ${r.long}, split by reason: ${REFUSAL_CLASSES.map((c) => `${c.label} ${st.byClass[c.id]}`).join(', ')}.`}>
                  <StackedColumns data={st.trend} xKey="key" xFmt={xFmt} height={240} keys={REFUSAL_CLASSES.map((c) => ({ key: c.id, name: c.label, color: CLASS_COLOUR[c.id] }))} />
                </div>
                <div className="mt-3"><Legend items={REFUSAL_CLASSES.filter((c) => st.byClass[c.id] > 0).map((c) => ({ label: c.label, color: CLASS_COLOUR[c.id] }))} /></div>
                {/* Counted by the fine class Activity filters on, so each number equals the list its link opens.
                    Level classes (autonomy, packs, counterparties, erased data) are drawn in the chart under 'By a rule' or 'Default'. */}
                <ul className="mt-5 grid gap-px bg-line border border-line sm:grid-cols-2 lg:grid-cols-3">
                  {REFUSAL_CLASSES_FULL.filter((c) => !c.level || levelRank(level) >= levelRank(c.level) || st.byClassFull[c.id] > 0).map((c) => {
                    const v = st.byClassFull[c.id];
                    const colour = CLASS_COLOUR[(LEVEL_FOLD[c.id] ?? c.id) as RefusalClass];
                    return (
                      <li key={c.id} className="bg-surface">
                        <Link to={activityHref(range, { rc: c.id })} className={cn('block h-full p-3 hover:bg-sunken/50 transition-colors', v === 0 && 'opacity-60')} title={c.hint}>
                          <span className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-sm font-medium"><span className="h-2.5 w-2.5 shrink-0" style={{ background: colour }} aria-hidden />{c.label}</span>
                            <span className="num font-semibold">{n(v)}</span>
                          </span>
                          <span className="mt-1 block text-xs text-muted leading-snug">{c.hint}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Panel>

          <Panel title="By agent" kicker="Who was told no" flush>
            <DataTable caption="Refusals by agent" className="border-0" columns={agentCols} rows={st?.agents} loading={loading} rowKey={(a) => a.slug} initialSort={{ key: 'refused', dir: 'desc' }}
              onRowClick={(a) => nav(activityHref(range, { agent: a.slug }))}
              empty={<EmptyState compact title="No agent was refused" disc="aperture">Nothing in {r.long}.</EmptyState>} />
          </Panel>

          <Panel title="By rule" kicker="Which rule said no" flush footer="Rule ids in monospace are your rulebook’s. agent-paused, default and invalid-arguments come from the guard itself.">
            <DataTable caption="Refusals by rule" className="border-0" columns={ruleCols} rows={st?.rules} loading={loading} rowKey={(x) => x.key} initialSort={{ key: 'count', dir: 'desc' }}
              onRowClick={(x) => nav(`/activity/${x.last.seq}`)}
              empty={<EmptyState compact title="No rule refused anything" disc="aperture">Nothing in {r.long}.</EmptyState>} />
          </Panel>

          <Panel title="By tool" kicker="What was attempted" flush>
            <DataTable caption="Refusals by tool" className="border-0" columns={toolCols} rows={st?.tools} loading={loading} rowKey={(t) => t.tool} initialSort={{ key: 'count', dir: 'desc' }}
              onRowClick={(t) => nav(activityHref(range, { tool: t.tool }))}
              empty={<EmptyState compact title="No tool was refused" disc="aperture">Nothing in {r.long}.</EmptyState>} />
          </Panel>
        </div>

        <div className="lg:col-span-4 space-y-6">
          <Panel title="What these refusals cost" kicker={`Metered from the chain · ${r.label}`}>
            {error && !data ? <p className="text-sm text-muted">The cost needs the meter, which could not be loaded. Try again above.</p> : !plan || !cost ? <Skeleton className="h-40" /> : (
              <>
                <p className="text-sm text-muted leading-relaxed">A refused action is decided, {levelRank(level) >= 1 ? 'signed' : 'sealed'} and kept like any other, so it is metered — at {pct(REFUSAL_FACTOR)} of the per-action rate. Refusals are never free and never the full price.</p>
                <dl className="mt-4 border border-line divide-y divide-line text-sm">
                  <Row k="Plan now" v={`${plan.name} (${plan.level})`} />
                  {cost.byLevel.map((b) => <Row key={b.level} k={`Refused at ${PLANS[b.level].level} (${rupees(b.rate, { paise: true })})`} v={n(b.refused)} />)}
                  <Row k="Metered refusals" v={n(cost.refused)} />
                  <Row k="Inside the allowance" v={`${n(cost.inside)} · ${n(cost.unitsInside)} included actions`} />
                  <Row k="Beyond the allowance" v={`${n(cost.beyond)} · ${rupees(cost.cost, { paise: true })}`} />
                </dl>
                <p className="mt-3 text-xs text-muted leading-relaxed">
                  Metered once per governed action, at the decision: a held call a person rejected or that expired counts here once. {refusedCount !== cost.refused && `The ${n(refusedCount)} refusal receipts above include approval receipts for the same calls.`} At the full rate the same calls would be {rupees(cost.atFullRate, { paise: true })}. Before GST.
                </p>
                {/* invoice numbers are billing references: only for the roles that can open the Meter */}
                {canBilling && cost.months.length > 0 && (
                  <div className="mt-4">
                    <p className="label mb-1.5">On the invoices for</p>
                    <ul className="flex flex-wrap gap-2">
                      {cost.months.map((m) => {
                        const inv = data?.invoices.find((i) => i.period === m);
                        return <li key={m}>{inv ? <Link className="link text-sm font-mono" to={`/billing?invoice=${inv.id}`}>{inv.id}</Link> : <span className="text-sm font-mono">{m}</span>}</li>;
                      })}
                    </ul>
                  </div>
                )}
                {canBilling && <Link to="/billing" className="mt-4 inline-flex items-center gap-1 text-sm font-medium link">Meter and invoices <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}
              </>
            )}
          </Panel>

          {canSee('/work/not-done') ? (
            <Panel title="Act on them" kicker="Work · Not done">
              <p className="text-sm text-muted leading-relaxed">Refusals an operator should explain or follow up — a payment that did not go, an email that was not sent — wait in the Not done queue.</p>
              <Button className="mt-4" variant="primary" block icon={<CircleSlash className="h-4 w-4" />} onClick={() => nav('/work/not-done')}>Open Not done</Button>
              <Button className="mt-2" variant="secondary" block icon={<ScrollText className="h-4 w-4" />} onClick={() => nav(activityHref(range))}>Every refusal in Activity</Button>
            </Panel>
          ) : (
            // auditors: no Work door, so only the read-only trail
            <Panel title="Read them in full" kicker="Records · Activity">
              <p className="text-sm text-muted leading-relaxed">Every refusal in this range, with its receipt, rule and reason.</p>
              <Button className="mt-4" variant="secondary" block icon={<ScrollText className="h-4 w-4" />} onClick={() => nav(activityHref(range))}>Every refusal in Activity</Button>
            </Panel>
          )}

          <Panel title="How a refusal is counted" kicker="Disclosed limits">
            <ul className="space-y-3 text-sm text-muted leading-relaxed">
              <li className="flex gap-2"><OctagonX className="h-4 w-4 mt-0.5 shrink-0 text-bad-fg" aria-hidden /><span><span className="text-fg font-medium">Counted:</span> decision receipts refused by a rule, by the default (no rule allowed it), while the agent was paused, or for invalid arguments; and approval receipts rejected by a person or expired.</span></li>
              <li className="flex gap-2"><Info className="h-4 w-4 mt-0.5 shrink-0 text-info-fg" aria-hidden /><span><span className="text-fg font-medium">Not counted:</span> calls rejected before the guard — an invalid key or the rate limit (300 a minute per key) — produce no receipt, so they never appear here.</span></li>
              <li className="flex gap-2"><Info className="h-4 w-4 mt-0.5 shrink-0 text-info-fg" aria-hidden /><span><span className="text-fg font-medium">What “refused” means:</span> on the MCP governed run a refused call does not run. On REST and SDK, Elan1 Govern advises and records; the agent runs the call.</span></li>
            </ul>
            <div className="mt-4"><StatusChip tone="neutral" size="sm" icon={<Info className="h-3 w-3" aria-hidden />}>Counts from this organisation’s chain</StatusChip></div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Figure({ label, value, sub, loading }: { label: string; value: ReactNode; sub?: ReactNode; loading?: boolean }) {
  return (
    <div className="bg-surface p-4 sm:p-5 min-w-0">
      <p className="label">{label}</p>
      {loading ? <Skeleton className="mt-3 h-8 w-20" /> : <p className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tighter2 num leading-none">{value}</p>}
      {sub && !loading && <p className="mt-2 text-xs sm:text-sm text-muted">{sub}</p>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <dt className="text-muted">{k}</dt>
      <dd className="num font-medium text-right">{v}</dd>
    </div>
  );
}
