import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Network, LayoutGrid, Rows3, Lock, ArrowRightLeft, Bot, BookOpenCheck, Archive } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgLevel } from '@/store/session';
import type { Agent } from '@/types';
import { atLeast } from '@/lib/levels';
import { AutonomyChip, highestGrant } from './AgentAutonomy';
import { counterpartiesByAgent, counterpartyText, isRetired, type AgentExt } from './backend';
import { n, plural, pct } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Banner, Button, DataTable, EmptyState, PageHeader, SearchInput, Segmented, Skeleton, Stat, StatusChip, Tooltip, type Column } from '@/components/ui';
import { AgentStatus, Person, RouteMode, When } from '@/components/domain';
import { MixBar, MixNumbers, RiskLevelMark, decisionsSince, emptyMix, mixByAgent, type Mix } from './parts';
import { SmartLink } from '@/shell/access';

type View = 'table' | 'cards';
type StatusFilter = 'all' | 'active' | 'paused';
type RouteFilter = 'all' | 'governed' | 'advisory';

const VIEW_KEY = 'eg:agents:view';
const readView = (): View => { try { return (localStorage.getItem(VIEW_KEY) as View) || 'table'; } catch { return 'table'; } };

interface Row extends Agent { mix: Mix; rbVersion?: number; rbDraft?: number; rbSlug?: string }

export default function AgentsPage() {
  const nav = useNavigate();
  const canManage = useCan('agents.manage');
  const level = useOrgLevel();
  const l3 = atLeast(level, 'l3');
  const agentsQ = useQuery((o) => api.agents(o), []);
  const rbQ = useQuery((o) => api.rulebooks(o), [], { kinds: ['rulebook', 'agent'] });
  const statsQ = useQuery(async (o) => mixByAgent(decisionsSince(o, 7)), []);
  const gQ = useQuery((o) => (atLeast(api.levelOf(o), 'l3') ? api.grants(o) : Promise.resolve(undefined)), [level], { kinds: ['autonomy', 'receipt', 'level'] });
  const cpQ = useQuery((o) => (atLeast(api.levelOf(o), 'l3') ? counterpartiesByAgent(o) : Promise.resolve(undefined)), [level], { kinds: ['receipt', 'counterparty', 'level'] });

  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* fine */ } };
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [route, setRoute] = useState<RouteFilter>('all');

  const rows: Row[] | undefined = useMemo(() => {
    if (!agentsQ.data) return undefined;
    return agentsQ.data.map((a) => {
      const rb = rbQ.data?.find((r) => r.id === a.rulebookId);
      const draft = rb?.versions.find((v) => v.status !== 'published');
      return { ...a, mix: statsQ.data?.get(a.slug) ?? emptyMix(), rbVersion: rb?.currentVersion, rbDraft: draft?.version, rbSlug: rb?.slug };
    });
  }, [agentsQ.data, rbQ.data, statsQ.data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows?.filter((a) =>
      (status === 'all' || (status === 'active' ? a.status === 'active' : a.status !== 'active')) &&
      (route === 'all' || (route === 'governed' ? a.route === 'mcp' : a.route !== 'mcp')) &&
      (!needle || [a.name, a.slug, a.framework, a.description].some((s) => s.toLowerCase().includes(needle))),
    );
  }, [rows, q, status, route]);

  const all = rows ?? [];
  const active = all.filter((a) => a.status === 'active').length;
  const halted = all.filter((a) => a.status === 'paused' || a.status === 'stopped').length;
  const autoPaused = all.filter((a) => a.pausedBy === 'auto-pause').length;
  const governed = all.filter((a) => a.route === 'mcp').length;
  const total = all.reduce((m, a) => ({ calls: m.calls + a.mix.total, refuse: m.refuse + a.mix.refuse, ask: m.ask + a.mix.ask }), { calls: 0, refuse: 0, ask: 0 });

  const columns: Column<Row>[] = [
    {
      key: 'name', header: 'Agent', sort: (a) => a.name,
      cell: (a) => (
        <div className="min-w-0 py-1.5">
          <Link to={`/agents/${a.slug}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline underline-offset-2">{a.name}</Link>
          <p className="font-mono text-[12px] text-muted truncate">{a.slug}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sort: (a) => (isRetired(a as AgentExt) ? 'zz' : a.status), cell: (a) => isRetired(a as AgentExt) ? <StatusChip size="sm" tone="neutral" icon={<Archive className="h-3 w-3" aria-hidden />}>Retired</StatusChip> : <AgentStatus agent={a} /> },
    { key: 'route', header: 'Route', sort: (a) => a.route, hideBelow: 'md', cell: (a) => <RouteMode route={a.route} compact /> },
    { key: 'framework', header: 'Framework', sort: (a) => a.framework, hideBelow: 'lg', cell: (a) => <span className="text-sm text-muted">{a.framework}</span> },
    { key: 'owner', header: 'Owner', sort: (a) => a.ownerId, hideBelow: 'lg', cell: (a) => <Person id={a.ownerId} size={22} /> },
    { key: 'risk', header: 'Risk', sort: (a) => ({ low: 1, medium: 2, high: 3 }[a.riskLevel]), hideBelow: 'md', cell: (a) => <RiskLevelMark level={a.riskLevel} /> },
    ...(l3 ? [
      {
        key: 'autonomy', header: 'Autonomy', hideBelow: 'md' as const, sort: (a: Row) => { const t = highestGrant(gQ.data?.rows, a.slug); return t?.hasGrant ? Number(t.level.slice(1)) : -1; },
        cell: (a: Row) => {
          if (gQ.error) return <span className="text-xs text-subtle" title={gQ.error.message}>Unavailable</span>;
          const t = highestGrant(gQ.data?.rows, a.slug);
          if (!t) return <span className="text-xs text-subtle">…</span>;
          return (
            <Link to={`/agents/autonomy?agent=${a.slug}`} onClick={(e) => e.stopPropagation()} className="inline-flex flex-col gap-0.5" title={`${t.graduated} of ${t.tools} write types graduated to A3; the others are at A2 Propose. Highest shown.`}>
              <AutonomyChip level={t.level} hasGrant={t.hasGrant} supervised={t.supervised > 0 && t.level === 'A3'} />
              {t.graduated > 0 && t.graduated < t.tools && <span className="text-[11px] text-muted">{t.graduated} of {t.tools} graduated</span>}
            </Link>
          );
        },
      },
      {
        key: 'counterparties', header: 'Counterparties', hideBelow: 'lg' as const, sort: (a: Row) => cpQ.data?.byAgent.get(a.slug)?.issued ?? 0,
        cell: (a: Row) => {
          if (cpQ.error) return <span className="text-xs text-subtle" title={cpQ.error.message}>Unavailable</span>;
          const c = cpQ.data?.byAgent.get(a.slug);
          return c ? <SmartLink to="/assurance/counterparties" onClick={(e) => e.stopPropagation()} className="text-xs hover:underline underline-offset-2" plainClassName="text-xs">{counterpartyText(c)}</SmartLink> :<span className="text-xs text-subtle">{cpQ.data ? 'None issued' : '…'}</span>;
        },
      },
    ] : []),
    {
      key: 'rulebook', header: 'Rulebook', hideBelow: 'lg', sort: (a) => a.rbVersion ?? 0,
      cell: (a) => rbQ.error ? <span className="text-xs text-subtle" title={rbQ.error.message}>Unavailable</span> : a.rbSlug ? (
        <Link to={`/rulebooks/${a.rbSlug}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 text-sm hover:underline underline-offset-2">
          <span className="font-mono">v{a.rbVersion}</span>
          {a.rbDraft && <span className="text-xs text-held-fg">· draft v{a.rbDraft}</span>}
        </Link>
      ) : <span className="text-subtle">—</span>,
    },
    {
      key: 'calls', header: 'Calls · 7 days', align: 'right', sort: (a) => a.mix.total, width: 180,
      cell: (a) => statsQ.error ? <span className="text-xs text-subtle" title={statsQ.error.message}>Unavailable</span> : (
        <div className="flex flex-col items-end gap-1 py-1.5 min-w-[120px]">
          <span className="num font-medium">{statsQ.data ? n(a.mix.total) : '…'}</span>
          <MixBar mix={a.mix} className="w-28" />
        </div>
      ),
    },
    { key: 'last', header: 'Last call', align: 'right', sort: (a) => a.mix.last ?? a.lastCallAt ?? '', hideBelow: 'sm', cell: (a) => <When iso={a.mix.last ?? a.lastCallAt} className="text-sm text-muted" /> },
  ];

  // roles that cannot add agents read the registry: the button is left out, not greyed out
  const addButton = canManage ? (
    <Tooltip content="Register an agent, choose its tools and get its key">
      <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/agents/new')}>Add an agent</Button>
    </Tooltip>
  ) : null;

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Agents"
        title="Agents"
        description="Every agent that calls a tool through Elan1 Govern, who owns it, how it connects and what its rulebook decided this week."
        actions={
          <>
            <Button variant="secondary" icon={<Network className="h-4 w-4" />} onClick={() => nav('/agents/map')}>Agent map</Button>
            {addButton}
          </>
        }
      />

      {agentsQ.error && <Banner tone="bad" title="Could not load agents" className="mb-6" actions={<Button size="sm" onClick={agentsQ.refetch}>Try again</Button>}>{agentsQ.error.message}</Banner>}
      {rbQ.error && <Banner tone="bad" title="Rulebooks did not load — the Rulebook column is unavailable" className="mb-4" actions={<Button size="sm" onClick={rbQ.refetch}>Try again</Button>}>{rbQ.error.message}</Banner>}
      {statsQ.error && <Banner tone="bad" title="The 7-day decision mix did not load — call counts are unavailable" className="mb-4" actions={<Button size="sm" onClick={statsQ.refetch}>Try again</Button>}>{statsQ.error.message}</Banner>}
      {l3 && (gQ.error || cpQ.error) && <Banner tone="bad" title="Autonomy or counterparties did not load" className="mb-4" actions={<Button size="sm" onClick={() => { gQ.refetch(); cpQ.refetch(); }}>Try again</Button>}>{(gQ.error ?? cpQ.error)?.message}</Banner>}

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-6" aria-live="polite">
        {agentsQ.loading ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[132px]" />) : (
          <>
            <Stat label="Active" value={n(active)} sub={`of ${plural(all.length, 'agent')}`} icon={<Bot className="h-4 w-4 text-subtle" />} />
            <Stat label="Paused or stopped" value={n(halted)} sub={autoPaused ? `${autoPaused} auto-paused after an alert` : halted ? 'Calls refused with agent-paused' : 'None'} />
            <Stat label="Governed run · advisory" value={<>{n(governed)}<span className="text-subtle font-normal"> · {n(all.length - governed)}</span></>}
              sub={<span className="inline-flex flex-wrap gap-x-3"><span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />MCP enforced</span><span className="inline-flex items-center gap-1"><ArrowRightLeft className="h-3 w-3" />REST/SDK advises</span></span>} />
            <Stat label="Calls · 7 days" value={n(total.calls)} sub={`${pct(total.calls ? total.refuse / total.calls : 0, 1)} refused · ${pct(total.calls ? total.ask / total.calls : 0, 1)} asked`} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, slug or framework" aria-label="Search agents" className="w-full sm:w-72" />
        <Segmented label="Status" size="sm" value={status} onChange={setStatus} options={[
          { value: 'all', label: 'All', count: all.length },
          { value: 'active', label: 'Active', count: active },
          { value: 'paused', label: 'Paused', count: all.length - active },
        ]} />
        <Segmented label="Route" size="sm" value={route} onChange={setRoute} options={[
          { value: 'all', label: 'Any route' },
          { value: 'governed', label: 'Governed run' },
          { value: 'advisory', label: 'Advisory' },
        ]} />
        <div className="ml-auto">
          <Segmented label="View" size="sm" value={view} onChange={setView} options={[
            { value: 'table', label: <><Rows3 className="h-3.5 w-3.5" aria-hidden /><span className="sr-only sm:not-sr-only">Table</span></> },
            { value: 'cards', label: <><LayoutGrid className="h-3.5 w-3.5" aria-hidden /><span className="sr-only sm:not-sr-only">Cards</span></> },
          ]} />
        </div>
      </div>

      {!agentsQ.loading && all.length === 0 ? (
        <div className="border border-line bg-surface">
          <EmptyState title="No agents yet" disc="gate" action={canManage ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/agents/new')}>Add your first agent</Button> : undefined}>
            Add an agent, choose the tools it may call and connect it with one key. Anything no rule allows is refused.
          </EmptyState>
        </div>
      ) : view === 'table' ? (
        <DataTable
          caption="Agents"
          columns={columns}
          rows={filtered}
          loading={agentsQ.loading}
          rowKey={(a) => a.slug}
          onRowClick={(a) => nav(`/agents/${a.slug}`)}
          initialSort={{ key: 'calls', dir: 'desc' }}
          empty={<EmptyState compact title="No agents match" disc="aperture" action={<Button size="sm" variant="secondary" onClick={() => { setQ(''); setStatus('all'); setRoute('all'); }}>Clear filters</Button>}>Change the search or filters.</EmptyState>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {agentsQ.loading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[240px]" />)}
          {filtered?.map((a) => <AgentCard key={a.slug} a={a} />)}
          {filtered && filtered.length === 0 && (
            <div className="sm:col-span-2 xl:col-span-3 border border-line bg-surface">
              <EmptyState compact title="No agents match" disc="aperture">Change the search or filters.</EmptyState>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentCard({ a }: { a: Row }) {
  return (
    <Link to={`/agents/${a.slug}`} className={cn('group flex flex-col bg-surface border border-line p-5 hover:border-line-strong transition-colors', a.status !== 'active' && 'border-l-[3px] border-l-held')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold truncate group-hover:underline underline-offset-2">{a.name}</h3>
          <p className="font-mono text-[12px] text-muted truncate">{a.slug}</p>
        </div>
        <AgentStatus agent={a} />
      </div>
      <p className="mt-3 text-sm text-muted leading-relaxed line-clamp-2 min-h-[40px]">{a.description}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <RouteMode route={a.route} compact />
        <span className="text-xs text-muted border border-line h-6 px-1.5 inline-flex items-center">{a.framework}</span>
        <RiskLevelMark level={a.riskLevel} className="text-xs ml-auto" />
      </div>
      <div className="mt-4 pt-4 border-t border-line">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="label">Calls · 7 days</span>
          <span className="font-display text-xl font-semibold num">{n(a.mix.total)}</span>
        </div>
        <MixBar mix={a.mix} height={8} />
        <div className="mt-1.5"><MixNumbers mix={a.mix} /></div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-sm">
        <Person id={a.ownerId} size={22} />
        <span className="inline-flex items-center gap-3 text-muted">
          {a.rbVersion !== undefined && <span className="inline-flex items-center gap-1 font-mono text-[12px]"><BookOpenCheck className="h-3.5 w-3.5" aria-hidden />v{a.rbVersion}</span>}
          <When iso={a.mix.last ?? a.lastCallAt} className="text-xs" />
        </span>
      </div>
    </Link>
  );
}
