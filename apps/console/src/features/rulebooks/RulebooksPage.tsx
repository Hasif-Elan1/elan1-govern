import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lightbulb, ArrowRight, BookCheck, ShieldCheck, Lock } from 'lucide-react';
import type { Agent, Rulebook } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { n, plural } from '@/lib/format';
import { Banner, Button, DataTable, EmptyState, PageHeader, SearchInput, Segmented, StatusChip, type Column } from '@/components/ui';
import { useOrgId, useOrgLevel } from '@/store/session';
import { dualControl } from '@/features/work/backend';
import { claimFor } from '@/features/work/level';
import { AgentLink, AgentStatus, Person, RouteMode, When } from '@/components/domain';
import { draftOf, publishedOf } from './lib';
import { DefaultRefuseChip, VersionStatus } from './parts';
import { useScreenAccess } from '@/shell/access';

type Row = Rulebook & { agent?: Agent; suggestions: number };
type Filter = 'all' | 'drafts' | 'published';

export default function RulebooksPage() {
  const nav = useNavigate();
  const orgId = useOrgId();
  const level = useOrgLevel();
  const dc = dualControl(orgId);
  const canAddAgent = useScreenAccess().can('agents.manage');
  const { data, loading, error, refetch } = useQuery((o) => api.rulebooks(o), []);
  const sug = useQuery((o) => api.suggestions(o), []);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((r) => {
      if (filter === 'drafts' && !draftOf(r)) return false;
      if (filter === 'published' && draftOf(r)) return false;
      return !needle || r.slug.includes(needle) || r.name.toLowerCase().includes(needle) || (r.agent?.name.toLowerCase().includes(needle) ?? false);
    });
  }, [data, filter, q]);

  const openSuggestions = (sug.data ?? []).filter((s) => s.status === 'open').length;
  const drafts = (data ?? []).filter((r) => draftOf(r)).length;
  const totalRules = (data ?? []).reduce((a, r) => a + (publishedOf(r)?.rules.length ?? 0), 0);
  const lastPublished = (data ?? []).map((r) => publishedOf(r)?.signedAt).filter((x): x is string => !!x).sort().slice(-1)[0];

  const columns: Column<Row>[] = [
    {
      key: 'agent', header: 'Agent', sort: (r) => r.slug,
      cell: (r) => (
        <span className="flex flex-col gap-0.5 min-w-0 py-1">
          <AgentLink slug={r.slug} />
          <span className="text-xs text-muted truncate">{r.agent?.name ?? r.name}</span>
        </span>
      ),
    },
    {
      key: 'version', header: 'Version', sort: (r) => r.currentVersion, width: 110,
      cell: (r) => {
        const d = draftOf(r);
        return (
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-[13px] font-semibold">v{r.currentVersion}</span>
            {d && <span className="font-mono text-[11px] text-muted">v{d.version} {d.status === 'in_review' ? 'in review' : 'draft'}</span>}
          </span>
        );
      },
    },
    {
      key: 'status', header: 'Status', sort: (r) => (draftOf(r)?.status ?? 'published'),
      cell: (r) => {
        const d = draftOf(r);
        return d ? <VersionStatus status={d.status} /> : <VersionStatus status="published" />;
      },
    },
    { key: 'rules', header: 'Rules', align: 'right', sort: (r) => publishedOf(r)?.rules.length ?? 0, cell: (r) => <span className="num">{publishedOf(r)?.rules.length ?? 0}</span>, width: 72 },
    {
      key: 'published', header: 'Last published', sort: (r) => publishedOf(r)?.signedAt ?? '', hideBelow: 'md',
      cell: (r) => {
        const p = publishedOf(r);
        return p ? <span className="flex flex-col gap-1"><When iso={p.signedAt} className="text-sm" /><Person id={p.signedBy} size={18} className="text-xs" /></span> : <span className="text-subtle">—</span>;
      },
    },
    { key: 'route', header: 'Route', hideBelow: 'lg', cell: (r) => (r.agent ? <span className="flex flex-col items-start gap-1"><RouteMode route={r.agent.route} compact /><AgentStatus agent={r.agent} /></span> : null) },
    { key: 'default', header: 'Default', hideBelow: 'lg', cell: () => <DefaultRefuseChip /> },
    {
      key: 'sug', header: 'Suggestions', align: 'right', sort: (r) => r.suggestions, width: 110,
      cell: (r) => {
        const open = (sug.data ?? []).filter((s) => s.rulebookId === r.id && s.status === 'open').length;
        return open ? (
          <Link to="/rulebooks/suggestions" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline"><Lightbulb className="h-3.5 w-3.5" aria-hidden />{open} open</Link>
        ) : <span className="text-subtle">—</span>;
      },
    },
  ];

  return (
    <div className="overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="Rulebooks"
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        description={`One rulebook per agent. Every published version is ${level === 'l1' ? 'sealed' : 'signed'} and verified on every call. Anything no rule allows is refused.`}
        actions={<Link to="/rulebooks/suggestions" className="inline-flex items-center gap-2 h-10 px-4 text-base font-medium border border-line-strong/70 bg-surface hover:border-fg"><Lightbulb className="h-4 w-4" aria-hidden />Rule suggestions{openSuggestions > 0 && <span className="num text-[11px] px-1 border border-fg/30">{openSuggestions}</span>}</Link>}
      />

      {openSuggestions > 0 && (
        <Banner tone="info" className="mb-6" title={`${plural(openSuggestions, 'rule suggestion')} from approvals people already made`}
          actions={<Link to="/rulebooks/suggestions" className="inline-flex items-center gap-1 text-sm font-medium hover:underline">Review <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
          Each comes from at least 10 consistent approvals over 30 days. A suggestion never publishes itself — a person opens it as a draft, tests it on past actions and publishes it.
        </Banner>
      )}

      <div className="mb-6 grid gap-px bg-line border border-line grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Rulebooks', value: data ? n(data.length) : '—', sub: 'one per agent', icon: <BookCheck className="h-4 w-4 text-muted" aria-hidden /> },
          { label: 'Published rules', value: data ? n(totalRules) : '—', sub: 'across live versions', icon: <ShieldCheck className="h-4 w-4 text-muted" aria-hidden /> },
          { label: 'Drafts in progress', value: data ? n(drafts) : '—', sub: drafts ? (level === 'l1' ? 'not live until published' : 'not live until signed') : 'nothing waiting', icon: null },
          { label: 'Last published', value: lastPublished ? <When iso={lastPublished} /> : '—', sub: level === 'l1' ? 'sealed and recorded' : 'signed and recorded', icon: <Lock className="h-4 w-4 text-muted" aria-hidden /> },
        ].map((s) => (
          <div key={s.label} className="bg-surface p-4 min-w-0">
            <div className="flex items-center justify-between"><p className="label">{s.label}</p>{s.icon}</div>
            <p className="mt-2 font-display text-2xl font-semibold num truncate">{s.value}</p>
            <p className="text-xs text-muted mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>

      {error && <Banner tone="bad" className="mb-4" title="Rulebooks could not be loaded" actions={<Button size="sm" variant="secondary" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {sug.error && <Banner tone="bad" className="mb-4" title="Rule suggestions could not be loaded" actions={<Button size="sm" variant="secondary" onClick={sug.refetch}>Try again</Button>}>{sug.error.message} The rulebooks below are unaffected.</Banner>}

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <Segmented label="Filter rulebooks" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All', count: data?.length },
          { value: 'drafts', label: 'With a draft', count: drafts },
          { value: 'published', label: 'Published only', count: data ? data.length - drafts : undefined },
        ]} />
        <div className="w-full sm:w-72"><SearchInput aria-label="Search rulebooks" placeholder="Search by agent" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/rulebooks/${r.slug}`)}
        caption="Rulebooks, one per agent"
        empty={
          <EmptyState compact title={q || filter !== 'all' ? 'No rulebook matches' : 'No rulebooks yet'} disc="gate" action={!q && filter === 'all' && canAddAgent ? <Link to="/agents/new" className="link text-sm">Add an agent</Link> : undefined}>
            {q || filter !== 'all' ? 'Clear the search or choose All.' : 'Each agent gets a starter rulebook when you add it.'}
          </EmptyState>
        }
      />
      <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <StatusChip tone="neutral" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Default: refuse</StatusChip>
        is fixed in every rulebook. {claimFor(level)}.{dc.enforced ? ' A different person approves each version before it is published.' : ' The reviewer of each version is recorded.'}
      </p>
    </div>
  );
}
