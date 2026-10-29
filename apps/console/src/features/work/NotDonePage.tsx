import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookCheck, Check, CircleSlash, FlaskConical, Gauge, Package, Play, RotateCcw, Undo2, Wrench } from 'lucide-react';
import { api, db } from '@/api';
import { chainMeter, type ChainMeter } from '@/features/billing/chainMeter';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { REFUSAL_FACTOR } from '@/lib/pricing';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { channelLabel, n, plural, relative, rupees } from '@/lib/format';
import { cn } from '@/lib/cn';
import { userName } from '@/mock/users';
import {
  ApprovalChip, Badge, Banner, Button, Checkbox, DecisionChip, Dialog, EmptyState, Field, PageHeader, Panel, Segmented, Select, Skeleton, Stat, Textarea, toast,
} from '@/components/ui';
import { AgentLink, Person, ReceiptLink, When } from '@/components/domain';
import { CLASSES, RANGES, classMeta, clusterItems, istStartOfDay, type NotDoneClass, type NotDoneCluster, type NotDoneData, type RangeId } from './notDone';
import { useExplained } from './useExplained';
import { notDone } from './backend';
import { SmartLink, useScreenAccess } from '@/shell/access';

type ClassFilter = NotDoneClass | 'all';

function duration(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return plural(m, 'minute');
  const h = Math.round(m / 60);
  if (h < 48) return plural(h, 'hour');
  return plural(Math.round(h / 24), 'day');
}

/**
 * Not done — Work door. The queue of refusals that need explaining or acting on: each one in the words of the
 * attempted action, grouped by why it was not done, with the operator step that would change the outcome.
 * Explanations are shared by the organisation and recorded as receipts.
 */
export default function NotDonePage() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const canPause = useCan('agents.pause');
  const canEditRules = useCan('rulebooks.edit');
  const canExplain = useCan('approvals.decide') || canEditRules;
  const now = useNow(60_000);
  const [sp, setSp] = useSearchParams();
  const range = (sp.get('range') && sp.get('range')! in RANGES ? sp.get('range') : '7d') as RangeId;
  const cls = ((sp.get('class') && CLASSES.some((c) => c.id === sp.get('class'))) ? sp.get('class') : 'all') as ClassFilter;
  const agentFilter = sp.get('agent') ?? '';
  const showExplained = sp.get('explained') === '1';
  const setParam = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(sp);
    if (!v) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const { data, loading, error, refetch } = useQuery((o) => notDone(o), []);
  // the allowance left this year comes from the chain meter, the same figures /billing prints
  const access = useScreenAccess();
  const meterQ = useQuery(async (o) => ({ ...(await api.meter(o)), chain: chainMeter(db.getDB(o)) }), [], { kinds: ['receipt', 'level'] });
  const { explained, notes, mark } = useExplained(orgId);
  const [resume, setResume] = useState<string>();
  const [explaining, setExplaining] = useState<{ keys: string[]; label: string }>();

  const view = useMemo(() => {
    if (!data) return undefined;
    const since = now - RANGES[range].ms;
    const inRange = data.items.filter((i) => new Date(i.ts).getTime() >= since);
    const scoped = agentFilter ? inRange.filter((i) => i.agent === agentFilter) : inRange;
    const open = scoped.filter((i) => !explained.has(i.key));
    const startToday = istStartOfDay(now);
    const byClass = Object.fromEntries(CLASSES.map((c) => [c.id, { total: scoped.filter((i) => i.cls === c.id).length, open: open.filter((i) => i.cls === c.id).length }])) as Record<NotDoneClass, { total: number; open: number }>;
    const clusters = clusterItems(scoped);
    const rulebookOpen = open.filter((i) => i.cls === 'rule' || i.cls === 'default');
    return {
      inRange, scoped, open, byClass, clusters,
      today: data.items.filter((i) => new Date(i.ts).getTime() >= startToday && (!agentFilter || i.agent === agentFilter)).length,
      rulebook: { items: rulebookOpen.length, patterns: clusterItems(rulebookOpen).length, agents: new Set(rulebookOpen.map((i) => i.agent)).size },
      paused: scoped.filter((i) => i.cls === 'paused').length,
      pausedNow: data.agents.filter((a) => a.status === 'paused' || a.status === 'stopped').length,
      agentsInRange: [...new Set(inRange.map((i) => i.agent))].sort(),
    };
  }, [data, range, agentFilter, explained, now]);

  const onMark = async (keys: string[], on: boolean, note = '') => {
    try {
      const r = await mark(orgId, keys, on, note);
      if (on) toast.ok(keys.length === 1 ? 'Marked explained' : `${n(keys.length)} marked explained`, `Shared with everyone in the organisation and recorded as receipt #${n(r.seq ?? 0)}. The refusal receipts are unchanged.`, { label: 'Undo', onClick: () => { void mark(orgId, keys, false); } });
      else toast.info('Put back in the queue', 'Recorded as refusal.explanation_withdrawn.');
    } catch (e) {
      toast.bad('Not recorded', (e as Error).message);
    }
  };

  const noteRequired = atLeast(level, 'l2');
  // reasons that belong to a level above the organisation's plan are left out (no level tags, no empty groups)
  const planClasses = CLASSES.filter((c) => !c.level || atLeast(level, c.level));
  const shownClasses = planClasses.filter((c) => cls === 'all' || c.id === cls);
  const refusedCalls = view ? view.scoped.filter((i) => i.cls !== 'rejected' && i.cls !== 'expiry').length : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Work"
        title="Not done"
        description="Every refused action and every held call that closed without a yes, written in the words of what the agent tried to do — with the step that would change the outcome."
        actions={
          <Segmented<RangeId> label="Time range" value={range} onChange={(v) => setParam('range', v === '7d' ? undefined : v)}
            options={(Object.keys(RANGES) as RangeId[]).map((k) => ({ value: k, label: RANGES[k].label }))} />
        }
      />

      {data?.stop.active && (
        <Banner tone="bad" title="Emergency stop engaged"
          actions={data.stop.incidentId ? <Link to={`/incidents/${data.stop.incidentId}`} className="inline-flex items-center gap-1 h-8 px-3 text-sm font-medium border border-line-strong/70 bg-surface hover:border-fg">Open the incident <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link> : undefined}>
          Every new agent call is refused and recorded until the stop is lifted. Reason: {data.stop.reason}
        </Banner>
      )}

      {error && <Banner tone="bad" title="The queue could not be loaded" actions={<Button size="sm" variant="secondary" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-live="polite">
        {loading && !view ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[132px]" />) : view ? (
          <>
            <Stat label="Not done today" value={n(view.today)} sub="Refused calls, rejections and expiries since midnight IST" />
            <Stat label="Needing a rulebook change" value={n(view.rulebook.items)}
              sub={view.rulebook.items ? `${plural(view.rulebook.patterns, 'pattern')} across ${plural(view.rulebook.agents, 'agent')}, not yet explained` : 'Nothing waiting on a rule'} />
            <Stat label="From paused agents" value={n(view.paused)} sub={`${plural(view.pausedNow, 'agent')} paused or stopped now`} to="/agents" />
            <Stat label="Left to explain" value={n(view.open.length)} sub={view.scoped.length ? `of ${n(view.scoped.length)} in ${RANGES[range].long}` : `Nothing in ${RANGES[range].long}`} />
          </>
        ) : (
          <div className="sm:col-span-2 xl:col-span-4 border border-line bg-surface px-5 py-4 text-sm text-muted">Figures appear when the queue loads.</div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-4 space-y-6 min-w-0">
          <Panel title="Why it was not done" flush>
            {loading && !view ? <div className="p-5 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div> : !view ? (
              <p className="px-5 py-4 text-sm text-muted">The reasons could not be counted.</p>
            ) : (
              <ul className="divide-y divide-line">
                <li>
                  <ReasonButton active={cls === 'all'} onClick={() => setParam('class', undefined)} label="All reasons" open={view.open.length} total={view.scoped.length} />
                </li>
                {planClasses.map((c) => (
                  <li key={c.id}>
                    <ReasonButton active={cls === c.id} onClick={() => setParam('class', cls === c.id ? undefined : c.id)} label={c.label} hint={c.action}
                      open={view.byClass[c.id].open} total={view.byClass[c.id].total} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel tone="sunken" title="A refusal is evidence">
            {/* the meter's figures are for owners and admins (the Meter screen's roles); everyone else reads what a refusal proves */}
            {access.isStaff ? (
              <RefusalPrice refused={refusedCalls} rangeLong={RANGES[range].long} meter={meterQ.data} loading={meterQ.loading} error={meterQ.error} hasView={!!view} />
            ) : (
              // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
              <p className="text-sm text-muted leading-relaxed">Each refusal here is {atLeast(level, 'l2') ? 'a signed, hash-chained receipt' : 'a receipt sealed in the hash chain'} — proof the agent asked and was told no.</p>
            )}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
              <SmartLink to="/assurance/refusals" hideWhenBlocked className="link inline-flex items-center gap-1">Refusals in Assurance <ArrowRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>
              <SmartLink to="/billing" hideWhenBlocked className="link">Meter</SmartLink>
            </div>
          </Panel>
        </div>

        <div className="lg:col-span-8 min-w-0 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Agent" htmlFor="nd-agent" className="w-[220px] max-w-full">
                <Select id="nd-agent" size_="sm" value={agentFilter} onChange={(e) => setParam('agent', e.target.value || undefined)}>
                  <option value="">All agents</option>
                  {(view?.agentsInRange ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
                  {agentFilter && view && !view.agentsInRange.includes(agentFilter) && <option value={agentFilter}>{agentFilter}</option>}
                </Select>
              </Field>
              <div className="pb-1.5">
                <Checkbox checked={showExplained} onChange={(v) => setParam('explained', v ? '1' : undefined)} label="Show explained" />
              </div>
            </div>
            {view && view.open.length > 0 && canExplain && (
              <Button size="sm" variant="ghost" icon={<Check className="h-4 w-4" aria-hidden />}
                onClick={() => setExplaining({ keys: view.open.filter((i) => cls === 'all' || i.cls === cls).map((i) => i.key), label: 'every refusal shown' })}>
                Mark all shown explained
              </Button>
            )}
          </div>

          {loading && !view ? (
            <Panel flush><div className="p-5 space-y-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div></Panel>
          ) : !view ? (
            <Panel flush>
              <EmptyState title="The queue is not available" disc="aperture" action={<Button variant="secondary" onClick={refetch}>Try again</Button>}>
                The refusals could not be read. Nothing has changed in the receipts.
              </EmptyState>
            </Panel>
          ) : view.scoped.length === 0 ? (
            <Panel flush>
              <EmptyState title="Nothing was refused in this range." disc="aperture"
                action={range !== '21d' ? <Button variant="secondary" onClick={() => setParam('range', '21d')}>Look at 21 days</Button> : <Link to="/activity" className="link">Open activity</Link>}>
                {agentFilter ? `${agentFilter} had no refused calls, rejections or expiries in ${RANGES[range].long}.` : `No agent call was refused, rejected or left to expire in ${RANGES[range].long}.`}
              </EmptyState>
            </Panel>
          ) : view.open.filter((i) => cls === 'all' || i.cls === cls).length === 0 && !showExplained ? (
            <Panel flush>
              <EmptyState title="Queue worked down to zero" disc="progress"
                action={<Button variant="secondary" onClick={() => setParam('explained', '1')}>Show explained</Button>}>
                Every refusal {cls !== 'all' ? `in “${classMeta(cls).label.toLowerCase()}” ` : ''}in {RANGES[range].long} has been explained. New ones will appear here as they are recorded.
              </EmptyState>
            </Panel>
          ) : (
            shownClasses.map((c) => {
              const clusters = view.clusters.filter((k) => k.cls === c.id && (showExplained || k.items.some((i) => !explained.has(i.key))));
              if (!clusters.length) return null;
              return (
                <Panel key={c.id} flush
                  title={<span className="inline-flex items-center gap-2">{c.label}<Badge>{n(view.byClass[c.id].open)}{showExplained && view.byClass[c.id].total !== view.byClass[c.id].open ? ` of ${n(view.byClass[c.id].total)}` : ''}</Badge></span>}
                  actions={<Link to={`/activity?d=refuse&rc=${c.id}&range=${RANGES[range].activity}${agentFilter ? `&agent=${agentFilter}` : ''}`} className="text-sm link whitespace-nowrap">In activity</Link>}>
                  <p className="px-5 pt-3 text-sm text-muted">{c.hint} <span className="text-fg">{c.action}</span></p>
                  <ul className="divide-y divide-line">
                    {clusters.map((k) => (
                      <ClusterRow key={k.key} cluster={k} data={data!} explained={explained} notes={notes} showExplained={showExplained} range={range}
                        canPause={canPause} canEditRules={canEditRules} canExplain={canExplain} onResume={setResume}
                        onMark={(cl, on) => (on ? setExplaining({ keys: cl.items.filter((i) => !explained.has(i.key)).map((i) => i.key), label: cl.items[0].attempt }) : void onMark(cl.items.map((i) => i.key), false))} now={now} />
                    ))}
                  </ul>
                </Panel>
              );
            })
          )}
        </div>
      </div>

      <ExplainDialog target={explaining} required={noteRequired} level={level} onClose={() => setExplaining(undefined)} onConfirm={async (note) => { if (explaining) await onMark(explaining.keys, true, note); setExplaining(undefined); }} />
      <ResumeDialog slug={resume} onClose={() => setResume(undefined)} orgId={orgId} userId={user?.id} />
    </div>
  );
}

/** The price of the refusals in range, from the meter: 40% of the per-action rate, or 0.4 of an included action inside the allowance. */
function RefusalPrice({ refused, rangeLong, meter, loading, error, hasView }: { refused: number; rangeLong: string; meter?: Awaited<ReturnType<typeof api.meter>> & { chain: ChainMeter }; loading: boolean; error?: Error; hasView: boolean }) {
  if (loading && !meter) return <Skeleton className="h-16" />;
  if (error && !meter) return <p className="text-sm text-bad-fg">The meter could not be read. {error.message}</p>;
  if (!meter) return null;
  const plan = meter.plan;
  const sovereign = plan.id === 'sovereign' || plan.includedPerYear === 0;
  // what /billing shows as left of this allowance year, from the chain meter
  const remaining = Math.floor(meter.chain.fy.remaining);
  const inside = !sovereign && remaining > 0;
  return (
    <>
      <p className="text-sm text-muted leading-relaxed">
        {/* L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided. */}
        Each refusal here is {plan.id === 'l1' ? 'a receipt sealed in the hash chain' : 'a signed, hash-chained receipt'} — proof the agent asked and was told no. A refused action costs 40% of the per-action rate:
        {' '}<span className="text-fg font-medium num">{rupees(plan.refusalRate, { paise: true })}</span> on {plan.name}{plan.id !== 'sovereign' ? ` (${LEVEL_INFO[plan.id].tag})` : ''}{sovereign ? `, against ${rupees(plan.overageRate, { paise: true })} for a committed action. There is no yearly allowance on Sovereign.` : `, and ${REFUSAL_FACTOR} of an included action inside the yearly allowance.`}
      </p>
      {hasView && (
        <p className="mt-3 text-sm">
          <span className="num font-medium">{n(refused)}</span> refused calls in {rangeLong}
          {sovereign
            ? <> = <span className="num font-medium">{rupees(refused * plan.refusalRate, { paise: true })}</span> on this month’s invoice.</>
            : inside
              ? <> use <span className="num font-medium">{n(Math.round(refused * REFUSAL_FACTOR))}</span> included actions; {n(remaining)} remain in {meter.chain.fy.label}, so nothing is charged for them.</>
              : <> = <span className="num font-medium">{rupees(refused * plan.refusalRate, { paise: true })}</span> beyond the allowance.</>}
        </p>
      )}
      <p className="mt-2 text-xs text-muted">From the meter: {n(meter.window.refused)} refusals counted at 0.4 in the chain window · reconciled with {n(meter.reconciliation.chainDecisions)} decisions.</p>
    </>
  );
}

function ReasonButton({ active, onClick, label, hint, open, total, startsAt }: { active: boolean; onClick: () => void; label: string; hint?: string; open: number; total: number; startsAt?: 'l1' | 'l2' | 'l3' | 'sovereign' }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn('w-full text-left px-5 py-3 flex items-start justify-between gap-3 transition-colors border-l-[3px]', active ? 'bg-sunken border-l-fg' : 'border-l-transparent hover:bg-sunken/60')}>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium">{label}{startsAt && <span className="font-mono text-[10px] border border-line-strong/60 px-1 text-muted">{LEVEL_INFO[startsAt].tag}</span>}</span>
        {hint && <span className="block text-xs text-muted mt-0.5">{startsAt ? `Starts at ${LEVEL_INFO[startsAt].name}. ` : ''}{hint}</span>}
      </span>
      <span className="shrink-0 text-right">
        <span className={cn('block num text-sm font-semibold', open === 0 && 'text-subtle')}>{n(open)}</span>
        {total !== open && <span className="block num text-[11px] text-subtle">of {n(total)}</span>}
      </span>
    </button>
  );
}

/** A step button that leads to another screen; left out when the role or plan cannot open that screen. */
function ActionLink({ to, icon, children }: { to: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <SmartLink to={to} hideWhenBlocked className="inline-flex items-center gap-1.5 h-8 px-3 text-sm font-medium border border-line-strong/70 bg-surface hover:border-fg hover:bg-sunken/60 whitespace-nowrap">
      {icon}{children}
    </SmartLink>
  );
}

function ClusterRow({ cluster: c, data, explained, notes, showExplained, range, canPause, canEditRules, canExplain, onResume, onMark, now }: {
  cluster: NotDoneCluster; data: NotDoneData; explained: Set<string>; notes: Record<string, { by: string; at: string; note: string; seq?: number }>; showExplained: boolean; range: RangeId;
  canPause: boolean; canEditRules: boolean; canExplain: boolean; onResume: (slug: string) => void; onMark: (c: NotDoneCluster, on: boolean) => void; now: number;
}) {
  const visible = showExplained ? c.items : c.items.filter((i) => !explained.has(i.key));
  const openCount = c.items.filter((i) => !explained.has(i.key)).length;
  const done = openCount === 0;
  const latest = visible[0] ?? c.items[0];
  const agent = data.agents.find((a) => a.slug === c.agent);
  const more = visible.length - 3;
  const activityHref = `/activity?d=refuse&agent=${c.agent}${c.cls === 'paused' ? '' : `&tool=${encodeURIComponent(c.tool)}`}&rc=${c.cls}&range=${RANGES[range].activity}`;
  const tools = [...new Set(visible.map((i) => i.tool))];
  const ap = latest.approval;
  const note = done ? notes[c.items[0].key] : undefined;

  let reason: ReactNode;
  switch (c.cls) {
    case 'rule':
      reason = <>Rule <Link to={`/rulebooks/${c.agent}?tab=rules`} className="font-mono text-[12.5px] text-fg hover:underline">{c.ruleId}</Link>: {latest.reason}</>;
      break;
    case 'default':
      reason = <>No rule allows it. Anything not explicitly allowed is refused.</>;
      break;
    case 'invalid':
      reason = <>Invalid arguments: <span className="font-mono text-[12.5px] text-fg">{latest.reason}</span></>;
      break;
    case 'rejected':
      reason = (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
          Rejected by {ap?.decidedBy ? <Person id={ap.decidedBy} size={18} /> : 'an approver'}
          {ap?.channel && <span>in {channelLabel[ap.channel] ?? ap.channel}</span>}
          {ap?.decisionReason || latest.reason ? <span>— “{ap?.decisionReason || latest.reason}”</span> : <span>— no reason given</span>}
        </span>
      );
      break;
    case 'expiry':
      reason = ap
        ? <>Waited {duration(new Date(ap.expiresAt).getTime() - new Date(ap.createdAt).getTime())} for {ap.approverGroup}; no one decided. Expiry is a refusal.</>
        : <>{latest.reason}</>;
      break;
    default:
      reason = <>{latest.reason}{c.ruleId ? <> <span className="font-mono text-[12px] text-subtle">({c.ruleId})</span></> : null}</>;
  }

  let action: ReactNode;
  switch (c.cls) {
    case 'rule':
      action = (
        <>
          <p className="text-sm">If this should run, {canEditRules ? 'change' : 'an owner or admin changes'} rule <span className="font-mono text-[12.5px]">{c.ruleId}</span>.</p>
          <div className="flex flex-wrap gap-2"><ActionLink to={`/rulebooks/${c.agent}?tab=rules`} icon={<BookCheck className="h-3.5 w-3.5" aria-hidden />}>Open the rule</ActionLink></div>
        </>
      );
      break;
    case 'default':
      action = (
        <>
          <p className="text-sm">{canEditRules ? 'Add a rule that allows it, then test it on past actions before you publish.' : 'An owner or admin adds a rule that allows it, tested on past actions before it is published.'}</p>
          <div className="flex flex-wrap gap-2">
            {canEditRules ? (
              <>
                <ActionLink to={`/rulebooks/${c.agent}?tab=try`} icon={<Play className="h-3.5 w-3.5" aria-hidden />}>Try this action</ActionLink>
                <ActionLink to={`/rulebooks/${c.agent}?tab=test`} icon={<FlaskConical className="h-3.5 w-3.5" aria-hidden />}>Test on past actions</ActionLink>
              </>
            ) : <ActionLink to={`/rulebooks/${c.agent}`} icon={<BookCheck className="h-3.5 w-3.5" aria-hidden />}>Open the rulebook</ActionLink>}
          </div>
        </>
      );
      break;
    case 'paused': {
      const stillStopped = data.stop.active;
      const stillPaused = agent && (agent.status === 'paused' || agent.status === 'stopped');
      action = stillStopped ? (
        <>
          <p className="text-sm">The emergency stop is still engaged. Lift it from the incident once the cause is dealt with.</p>
          {data.stop.incidentId && <div className="flex flex-wrap gap-2"><ActionLink to={`/incidents/${data.stop.incidentId}`} icon={<CircleSlash className="h-3.5 w-3.5" aria-hidden />}>Open the incident</ActionLink></div>}
        </>
      ) : stillPaused ? (
        <>
          <p className="text-sm">
            {c.agent} is {agent!.status === 'stopped' ? 'stopped' : agent!.pausedBy === 'auto-pause' ? 'paused by auto-pause' : 'paused'}. {canPause ? 'Resume the agent once the cause is dealt with.' : 'An owner or admin resumes it once the cause is dealt with.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {canPause && <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />} onClick={() => onResume(c.agent)}>Resume {c.agent}</Button>}
            {agent!.pausedBy === 'auto-pause' && <ActionLink to={`/alerts`}>See the alert</ActionLink>}
            <ActionLink to={`/agents/${c.agent}`}>Open the agent</ActionLink>
          </div>
        </>
      ) : (
        <p className="text-sm">{c.agent} is active again. Nothing to change — explain these and move on.</p>
      );
      break;
    }
    case 'invalid':
      action = (
        <>
          <p className="text-sm">Fix the agent’s call: the arguments must match the tool’s input schema. {agent && <span className="text-muted">Owner: {userName(agent.ownerId)}.</span>}</p>
          <div className="flex flex-wrap gap-2"><ActionLink to="/developers/errors" icon={<Wrench className="h-3.5 w-3.5" aria-hidden />}>Error reference</ActionLink></div>
        </>
      );
      break;
    case 'rejected':
      action = (
        <>
          <p className="text-sm">If the person was right, nothing to change. If the agent should stop asking, tighten rule <span className="font-mono text-[12.5px]">{c.ruleId ?? ap?.ruleId}</span>.</p>
          <div className="flex flex-wrap gap-2">
            {ap && <ActionLink to={`/approvals/${ap.id}`}>Open the approval</ActionLink>}
            <ActionLink to={`/rulebooks/${c.agent}?tab=rules`} icon={<BookCheck className="h-3.5 w-3.5" aria-hidden />}>Open the rule</ActionLink>
          </div>
        </>
      );
      break;
    case 'expiry':
      action = (
        <>
          <p className="text-sm">{canEditRules ? 'Set' : 'An owner or admin can set'} automatic re-routing for {ap?.approverGroup ?? 'the group'}, or shorten the expiry on rule <span className="font-mono text-[12.5px]">{c.ruleId}</span> so it fails fast.</p>
          <div className="flex flex-wrap gap-2">
            <ActionLink to="/work/channels#routing">Routing and escalation</ActionLink>
            <ActionLink to={`/rulebooks/${c.agent}?tab=rules`} icon={<BookCheck className="h-3.5 w-3.5" aria-hidden />}>Approver groups and expiry</ActionLink>
          </div>
        </>
      );
      break;
    case 'autonomy':
      action = (
        <>
          <p className="text-sm">{c.agent} has no grant above A0 Observe for {c.tool}. No one sets a level: write types start at A2 Propose at L3, and A3 comes only from a two-person graduation.</p>
          <div className="flex flex-wrap gap-2"><ActionLink to={`/agents/autonomy?agent=${c.agent}`} icon={<Gauge className="h-3.5 w-3.5" aria-hidden />}>Autonomy for {c.agent}</ActionLink></div>
        </>
      );
      break;
    case 'pack_gate':
      action = (
        <>
          <p className="text-sm">An installed regulatory pack does not admit this write. Read its declaration and admission checks G-A to G-E before changing anything.</p>
          <div className="flex flex-wrap gap-2"><ActionLink to="/records/packs" icon={<Package className="h-3.5 w-3.5" aria-hidden />}>Regulatory packs</ActionLink></div>
        </>
      );
      break;
  }

  const verdict = c.cls === 'rejected' ? 'not done.' : c.cls === 'expiry' ? 'not done: no one decided in time.' : '— not done.';

  return (
    <li className={cn('px-5 py-4', done && 'bg-sunken/40')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            {ap ? <ApprovalChip status={ap.status} size="sm" /> : <DecisionChip decision="refuse" size="sm" />}
            {visible.length > 1 && <Badge tone="neutral" title={`${visible.length} times in this range`}>{n(visible.length)} times</Badge>}
            {done && <Badge tone="ok" icon={<Check className="h-3 w-3" aria-hidden />}>Explained</Badge>}
            {!done && showExplained && openCount < c.items.length && <Badge tone="held">{n(openCount)} new since explained</Badge>}
          </div>
          <p className={cn('text-md font-medium leading-snug', done && 'text-muted')}>
            {latest.attempt}{c.cls === 'rejected' || c.cls === 'expiry' ? ' — ' : ' '}{verdict}
          </p>
          <p className="mt-1 text-sm text-muted">{reason}</p>
        </div>
        <div className="shrink-0 text-right text-sm text-muted">
          <When iso={latest.ts} />
          {visible.length > 1 && <span className="block text-xs">first {relative(visible[visible.length - 1].ts, now)}</span>}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <AgentLink slug={c.agent} />
        <span className="font-mono text-[12px] text-muted break-all" title={tools.join(', ')}>{tools.length > 1 ? `${latest.tool} +${tools.length - 1}` : latest.tool}</span>
        <span className="inline-flex flex-wrap items-center gap-x-2 text-muted">
          <span className="sr-only">Receipts:</span>
          {visible.slice(0, 3).map((i) => <ReceiptLink key={i.key} seq={i.seq} />)}
          {more > 0 && <Link to={activityHref} className="text-xs link">+{n(more)} more</Link>}
        </span>
        {latest.heldSeq !== undefined && <span className="text-xs text-muted inline-flex items-center gap-1">held as <ReceiptLink seq={latest.heldSeq} /></span>}
      </div>

      {!done && (
        <div className="mt-3 flex flex-col gap-3 border-l-2 border-line-strong bg-sunken/50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-2">{action}</div>
          {canExplain && (
            <Button size="sm" variant="ghost" className="self-start sm:self-center shrink-0" icon={<Check className="h-4 w-4" aria-hidden />} onClick={() => onMark(c, true)}
              aria-label={`Mark explained: ${latest.attempt}`}>
              Mark explained
            </Button>
          )}
        </div>
      )}
      {done && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {note && <p className="text-xs text-muted">Explained by {userName(note.by)} <When iso={note.at} />{note.note ? <> — “{note.note}”</> : null}{note.seq !== undefined && <> · <ReceiptLink seq={note.seq} /></>}</p>}
          {canExplain && <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" aria-hidden />} onClick={() => onMark(c, false)} aria-label={`Put back in the queue: ${latest.attempt}`}>Put back in the queue</Button>}
        </div>
      )}
    </li>
  );
}

function ExplainDialog({ target, required, level, onClose, onConfirm }: { target?: { keys: string[]; label: string }; required: boolean; level: string; onClose: () => void; onConfirm: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = !required || note.trim().length >= 8;
  const close = () => { setNote(''); onClose(); };
  return (
    <Dialog open={!!target} onClose={close} title={target && target.keys.length > 1 ? `Explain ${n(target.keys.length)} refusals` : 'Explain this refusal'} description={target?.label}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={async () => { setBusy(true); try { await onConfirm(note.trim()); setNote(''); } finally { setBusy(false); } }}>Mark explained</Button></>}>
      <Field label="Operator note" htmlFor="nd-note" required={required}
        hint={required ? `Required at ${level === 'l2' ? 'Attested' : level === 'l3' ? 'Proven' : 'Sovereign'}: auditors read why each refusal was accepted. Recorded on a refusal.explained receipt.` : 'Optional. Recorded on a refusal.explained receipt and shown to everyone in the organisation.'}>
        <Textarea id="nd-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus placeholder="For example: the vendor is not approved yet; procurement is onboarding them this week." />
      </Field>
    </Dialog>
  );
}

function ResumeDialog({ slug, onClose, orgId, userId }: { slug?: string; onClose: () => void; orgId: string; userId?: string }) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async () => {
    if (!slug || !userId) return;
    setPending(true);
    try {
      await api.setAgentStatus(orgId, slug, 'active', userId, reason.trim() || 'Resumed from Not done');
      toast.ok(`${slug} resumed`, 'Its calls are decided by its published rulebook again. The resume is recorded as an admin receipt.');
      setReason('');
      onClose();
    } catch (e) {
      toast.bad('Could not resume the agent', (e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={!!slug} onClose={onClose} title={`Resume ${slug ?? ''}`}
      description="New calls from this agent will be decided by its published rulebook again. Refusals already recorded stay as they are."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={pending} onClick={submit}>Resume agent</Button></>}>
      <Field label="Why it is safe to resume" htmlFor="nd-resume" hint="Recorded on the admin receipt with your name.">
        <Textarea id="nd-resume" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The alert was checked with the treasury team; the transfer was expected." />
      </Field>
    </Dialog>
  );
}
