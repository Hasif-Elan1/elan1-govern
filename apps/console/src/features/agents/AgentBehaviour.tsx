import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SmartLink, useCanSee } from '@/shell/access';
import { Activity, Clock3, Coins, Users, Wrench, GraduationCap } from 'lucide-react';
import { useCan, useOrgId, useUser } from '@/store/session';
import type { Agent, Alert, Detector, Receipt } from '@/types';
import { n, pct, rupees, rupeesShort, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, DataTable, EmptyState, Panel, SeverityChip, StatusChip, Switch, Tooltip, toast, type Column } from '@/components/ui';
import { useQuery } from '@/hooks/useQuery';
import { When } from '@/components/domain';
import { DAY, HOUR, counterpartyOf, decisionsSince, istHour, quantile, share } from './parts';
import { autoPauseOf, isRetired, setAutoPause, type AgentExt } from './backend';

export const DETECTORS: Record<Detector, { label: string; watches: string; threshold: string; canPause: boolean }> = {
  volume_spike: { label: 'Volume spike', watches: 'Calls in the last hour against the usual hourly volume', threshold: 'Median-based z-score 6 medium, 12 high; at least 20 calls', canPause: true },
  refusal_surge: { label: 'Refusal surge', watches: 'Share of calls refused against the usual share', threshold: '30% medium, 60% high; at least 10 calls', canPause: true },
  amount_outlier: { label: 'Amount outlier', watches: 'Amounts against the usual range', threshold: 'Median-based z-score 6 medium, 15 high; at least 5 samples', canPause: true },
  new_counterparty: { label: 'New counterparty', watches: 'Vendors, domains, payees and accounts unseen in 90 days', threshold: 'Medium with an amount, otherwise low', canPause: false },
  new_tool: { label: 'New tool', watches: 'First call to a tool', threshold: 'Always low', canPause: false },
  off_hours: { label: 'Off hours', watches: 'Calls in an hour of the week with 0.5% or less of usual calls', threshold: 'Low or medium', canPause: false },
};

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function deriveBaseline(rs: Receipt[]) {
  const now = Date.now();
  // hourly volume over 14 days
  const slots = new Map<number, number>();
  const byHour = Array.from({ length: 24 }, () => 0);
  const tools = new Map<string, number>();
  const cps = new Map<string, number>();
  const amounts: number[] = [];
  let refused = 0;
  for (const r of rs) {
    const t = new Date(r.ts).getTime();
    const slot = Math.floor((now - t) / HOUR);
    slots.set(slot, (slots.get(slot) ?? 0) + 1);
    byHour[istHour(t)]++;
    if (r.tool) tools.set(r.tool, (tools.get(r.tool) ?? 0) + 1);
    const cp = counterpartyOf(r);
    if (cp) cps.set(cp, (cps.get(cp) ?? 0) + 1);
    const a = r.args_summary?.amount;
    if (typeof a === 'number') amounts.push(a);
    if (r.decision === 'refuse') refused++;
  }
  const perHour = [...slots.values()].sort((a, b) => a - b);
  amounts.sort((a, b) => a - b);
  const total = rs.length;
  // working hours: the busiest hours that together hold 90% of calls, spanned first to last
  const busy: number[] = [];
  let acc = 0;
  for (const x of byHour.map((c, h) => ({ c, h })).filter((x) => x.c > 0).sort((a, b) => b.c - a.c)) {
    if (total && acc / total >= 0.9) break;
    busy.push(x.h);
    acc += x.c;
  }
  const start = busy.length ? Math.min(...busy) : 9;
  const end = busy.length ? Math.max(...busy) + 1 : 18;
  const offHours = byHour.reduce((s, c, h) => s + (h < start || h >= end ? c : 0), 0);
  return {
    total,
    days: rs.length ? Math.max(1, Math.ceil((now - new Date(rs[rs.length - 1].ts).getTime()) / DAY)) : 0,
    medianPerHour: quantile(perHour, 0.5),
    p90PerHour: quantile(perHour, 0.9),
    maxPerHour: perHour[perHour.length - 1] ?? 0,
    byHour,
    working: { start, end, label: `${hh(start)}–${hh(end % 24)} IST`, offHours },
    amounts: amounts.length ? { count: amounts.length, p10: quantile(amounts, 0.1), median: quantile(amounts, 0.5), p90: quantile(amounts, 0.9), max: amounts[amounts.length - 1] } : undefined,
    counterparties: [...cps.entries()].sort((a, b) => b[1] - a[1]),
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]),
    refusedShare: total ? refused / total : 0,
  };
}

export function AgentBehaviour({ agent, rs, alerts }: { agent: Agent; rs: Receipt[] | undefined; alerts: Alert[] }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const canAlerts = useCan('alerts.manage');
  const canAlertsPage = useCanSee('/alerts');
  const apQ = useQuery(async (o) => autoPauseOf(o, agent.slug), [agent.slug], { kinds: ['receipt', 'agent'] });
  const memQ = useQuery(async (o) => {
    const rs90 = decisionsSince(o, 90, agent.slug);
    const cps = new Map<string, number>();
    for (const r of rs90) { const cp = counterpartyOf(r); if (cp) cps.set(cp, (cps.get(cp) ?? 0) + 1); }
    const first = rs90[rs90.length - 1];
    return { counterparties: [...cps.entries()].sort((a, b) => b[1] - a[1]), days: first ? Math.max(1, Math.ceil((Date.now() - new Date(first.ts).getTime()) / DAY)) : 0, total: rs90.length };
  }, [agent.slug]);
  const [busy, setBusy] = useState(false);
  const autoOn = !!apQ.data;
  const retired = isRetired(agent as AgentExt);
  const b = useMemo(() => (rs ? deriveBaseline(rs) : undefined), [rs]);
  const learning = Date.now() - new Date(agent.createdAt).getTime() < 7 * DAY;

  const toggleAuto = async (v: boolean) => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await setAutoPause(orgId, agent.slug, v, user.id);
      apQ.refetch();
      if (v) toast.held('Auto-pause on', `${agent.slug} is paused on the next high-severity alert. Recorded on receipt #${r.seq}.`);
      else toast.ok('Auto-pause off', `High-severity alerts notify people; they do not pause the agent. Recorded on receipt #${r.seq}.`);
    } catch (e) {
      toast.bad('Auto-pause did not change', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const memory = memQ.data;

  const alertCols: Column<Alert>[] = [
    { key: 'sev', header: 'Severity', sort: (a) => ({ low: 1, medium: 2, high: 3 }[a.severity]), cell: (a) => <SeverityChip severity={a.severity} size="sm" /> },
    { key: 'title', header: 'Alert', cell: (a) => <div className="py-1.5 min-w-0"><SmartLink to={`/alerts/${a.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline" plainClassName="font-medium">{a.title}</SmartLink><p className="text-xs text-muted">{DETECTORS[a.detector].label}{a.autoPaused ? ' · paused the agent' : ''}</p></div> },
    { key: 'obs', header: 'Usual → seen', hideBelow: 'lg', cell: (a) => <span className="text-xs text-muted">{a.baseline} → <span className="text-fg">{a.observed}</span></span> },
    { key: 'status', header: 'Status', sort: (a) => a.status, cell: (a) => <StatusChip size="sm" tone={a.status === 'open' ? 'held' : a.status === 'acknowledged' ? 'info' : 'neutral'}>{a.status === 'open' ? 'Open' : a.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}</StatusChip> },
    { key: 'when', header: 'Raised', align: 'right', sort: (a) => a.createdAt, hideBelow: 'sm', cell: (a) => <When iso={a.createdAt} className="text-sm text-muted" /> },
  ];

  const countBy = (d: Detector) => alerts.filter((a) => a.detector === d);
  const baselineFor = (d: Detector) => {
    if (!b) return '—';
    switch (d) {
      case 'volume_spike': return `Median ${n(b.medianPerHour)} a busy hour, 90th percentile ${n(b.p90PerHour)}`;
      case 'refusal_surge': return `${pct(b.refusedShare, 1)} of calls refused`;
      case 'amount_outlier': return b.amounts ? `${rupeesShort(b.amounts.p10)}–${rupeesShort(b.amounts.p90)} usual` : 'No amounts in its calls';
      case 'new_counterparty': return memory ? `${plural(memory.counterparties.length, 'known counterparty', 'known counterparties')} in 90 days` : '…';
      case 'new_tool': return plural(b.tools.length, 'tool') + ' used';
      case 'off_hours': return `Working hours ${b.working.label}`;
    }
  };

  const maxHour = b ? Math.max(1, ...b.byHour) : 1;

  return (
    <div className="space-y-6">
      {learning && (
        <Banner tone="info" title="Still learning">This agent is less than 7 days old. Detectors stay quiet for the first 7 days while the baseline forms.</Banner>
      )}

      <Panel
        title="Pause automatically on high-severity alerts"
        actions={
          canAlerts ? (
            <Tooltip content={retired ? 'This agent is retired; it makes no calls.' : 'Owners and admins change this. The change is a receipt.'}>
              <Switch checked={autoOn} onChange={toggleAuto} label="Pause automatically on high-severity alerts" disabled={busy || apQ.loading || retired} />
            </Tooltip>
          ) : <StatusChip size="sm" tone={autoOn ? 'held' : 'neutral'}>{apQ.loading ? '…' : autoOn ? 'On' : 'Off'}</StatusChip>
        }
      >
        {apQ.error && <Banner tone="bad" className="mb-3" title="Auto-pause setting did not load" actions={<button type="button" className="underline text-sm" onClick={apQ.refetch}>Try again</button>}>{apQ.error.message}</Banner>}
        <p className="text-sm text-muted max-w-[80ch]">
          Off by default. When on, a high-severity volume spike, refusal surge or amount outlier pauses {agent.slug} and opens an incident. Only those 3 of the 6 detectors can reach high. A person resumes the agent; nothing resumes itself.{canAlertsPage ? ' The same setting shows on the Alerts page.' : ''}
        </p>
      </Panel>

      <div>
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <div>
            <h2 className="text-xl font-semibold">What the detectors treat as usual</h2>
            <p className="text-sm text-muted">Volume, amounts and hours from {b ? plural(b.total, 'decision receipt') : '…'} over the last 14 days. Counterparties from {memory ? plural(memory.total, 'decision receipt') : '…'} over the last 90 days{memory && memory.days < 90 ? ` (the chain holds ${plural(memory.days, 'day')} for this agent)` : ''}.</p>
          </div>
        </div>
        {!b ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-[140px]" />)}</div>
        ) : b.total === 0 ? (
          <Panel><EmptyState compact title="No calls yet" disc="trail">The baseline forms from the agent's own decision receipts. Send a call to start it.</EmptyState></Panel>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile icon={<Activity className="h-4 w-4" />} label="Volume per busy hour" value={`${n(b.medianPerHour)}–${n(b.p90PerHour)}`} sub={`Median to 90th percentile. Highest hour: ${n(b.maxPerHour)} calls.`} />
            <Tile icon={<Coins className="h-4 w-4" />} label="Usual amount" value={b.amounts ? `${rupeesShort(b.amounts.p10)}–${rupeesShort(b.amounts.p90)}` : '—'} sub={b.amounts ? `Median ${rupees(b.amounts.median)} · largest ${rupees(b.amounts.max)} · ${plural(b.amounts.count, 'call')} with an amount` : 'Calls from this agent carry no amount.'} />
            <Tile icon={<Clock3 className="h-4 w-4" />} label="Working hours" value={b.working.label.replace(' IST', '')} sub={`IST. ${plural(b.working.offHours, 'call')} outside these hours in 14 days.`} />
            <Tile icon={<Users className="h-4 w-4" />} label="Known counterparties · 90 days" value={memory ? n(memory.counterparties.length) : '…'} sub={memory ? memory.counterparties.slice(0, 3).map(([c]) => c).join(', ') || 'None in its arguments' : 'Counting…'} />
          </div>
        )}
      </div>

      {b && b.total > 0 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
          <Panel className="lg:col-span-7" title="Calls by hour of day (IST)" actions={<span className="text-xs text-muted">Shaded: working hours</span>}>
            <div className="flex items-end gap-[3px] h-36" role="img" aria-label={`Calls by hour of day. Working hours ${b.working.label}.`}>
              {b.byHour.map((c, h) => {
                const inHours = h >= b.working.start && h < b.working.end;
                return (
                  <div key={h} className={cn('flex-1 h-full flex flex-col justify-end', inHours && 'bg-sunken')} title={`${hh(h)} IST · ${n(c)} calls`}>
                    <div className={cn(inHours ? 'bg-fg/80' : 'bg-held')} style={{ height: `${(c / maxHour) * 100}%`, minHeight: c ? 2 : 0 }} />
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-subtle num"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
            <p className="mt-3 text-xs text-muted inline-flex items-center gap-3"><span className="inline-flex items-center gap-1"><span className="h-2 w-2 bg-fg/80" />In working hours</span><span className="inline-flex items-center gap-1"><span className="h-2 w-2 bg-held" />Outside — watched by off hours</span></p>
          </Panel>
          <Panel className="lg:col-span-5" title="Usual tools and counterparties" flush>
            <div className="grid sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x lg:divide-x-0 lg:divide-y xl:divide-y-0 xl:divide-x divide-line">
              <div className="p-4">
                <p className="label mb-2 inline-flex items-center gap-1.5"><Wrench className="h-3 w-3" />Tools</p>
                <ul className="space-y-1.5">
                  {b.tools.slice(0, 6).map(([t, c]) => (
                    <li key={t} className="flex justify-between gap-2 text-sm"><span className="font-mono text-[12px] truncate">{t}</span><span className="num text-muted">{share(c, b.total)}</span></li>
                  ))}
                </ul>
              </div>
              <div className="p-4">
                <p className="label mb-2 inline-flex items-center gap-1.5"><Users className="h-3 w-3" />Counterparties · 14 days</p>
                {b.counterparties.length ? (
                  <ul className="space-y-1.5">
                    {b.counterparties.slice(0, 6).map(([c, k]) => (
                      <li key={c} className="flex justify-between gap-2 text-sm"><span className="truncate">{c}</span><span className="num text-muted">{n(k)}</span></li>
                    ))}
                    {b.counterparties.length > 6 && <li className="text-xs text-subtle">+{b.counterparties.length - 6} more</li>}
                  </ul>
                ) : <p className="text-sm text-muted">None in its arguments.</p>}
              </div>
            </div>
          </Panel>
        </div>
      )}

      <Panel title="The 6 detectors" flush footer={<span className="inline-flex items-center gap-1.5"><GraduationCap className="h-3.5 w-3.5" />Learning period 7 days · baseline 14 days · counterparty memory 90 days. Alerts are deduplicated per agent, detector and subject.</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-sunken/80">
              <tr className="border-b border-line text-left">
                <th scope="col" className="label px-4 h-9">Detector</th>
                <th scope="col" className="label px-4 h-9 hidden md:table-cell">This agent's baseline</th>
                <th scope="col" className="label px-4 h-9 hidden lg:table-cell">Threshold</th>
                <th scope="col" className="label px-4 h-9">Can pause</th>
                <th scope="col" className="label px-4 h-9 text-right">Alerts</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(DETECTORS) as Detector[]).map((d) => {
                const list = countBy(d);
                const open = list.filter((a) => a.status !== 'resolved').length;
                return (
                  <tr key={d} className="border-b border-line last:border-b-0 align-top">
                    <td className="px-4 py-3"><p className="font-medium">{DETECTORS[d].label}</p><p className="text-xs text-muted max-w-[36ch]">{DETECTORS[d].watches}</p></td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted">{baselineFor(d)}</td>
                    <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted">{DETECTORS[d].threshold}</td>
                    <td className="px-4 py-3">{DETECTORS[d].canPause ? <span className={cn('text-sm', autoOn ? 'text-fg' : 'text-muted')}>{autoOn ? 'Yes, on high' : 'If switched on'}</span> : <span className="text-sm text-subtle">No</span>}</td>
                    <td className="px-4 py-3 text-right num">{list.length ? <>{n(list.length)}{open > 0 && <Badge tone="held" className="ml-2">{open} open</Badge>}</> : <span className="text-subtle">0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div>
        <h2 className="text-xl font-semibold mb-3">Alert history</h2>
        <DataTable caption="Alerts for this agent" columns={alertCols} rows={alerts} rowKey={(a) => a.id} onRowClick={canAlertsPage ? (a) => nav(`/alerts/${a.id}`) : undefined} initialSort={{ key: 'when', dir: 'desc' }}
          empty={<EmptyState compact title="No alerts for this agent" disc="aperture">Nothing has stood out from its baseline.</EmptyState>} />
      </div>
    </div>
  );
}

function Tile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div className="bg-surface border border-line p-5 h-full">
      <div className="flex items-center justify-between gap-2 text-subtle"><p className="label">{label}</p>{icon}</div>
      <p className="mt-3 font-display text-2xl font-semibold tracking-tighter2 num leading-none">{value}</p>
      <p className="mt-2 text-xs text-muted leading-relaxed">{sub}</p>
    </div>
  );
}
