import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ban, CheckCircle2, Clock3, KeyRound } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useRole } from '@/store/session';
import type { Agent, AgentKey } from '@/types';
import { date, plural } from '@/lib/format';
import { Badge, Banner, Button, Checkbox, DataTable, EmptyState, SearchInput, Segmented, Stat, StatusChip, type Column } from '@/components/ui';
import { AgentLink, RouteMode, When } from '@/components/domain';
import { ReadOnlyNote, SectionHeader } from '../shared';

type Row = AgentKey & { agent: Agent };
const DAY = 864e5;

function keyState(k: AgentKey): 'revoked' | 'expired' | 'unused' | 'active' {
  if (k.revoked) return 'revoked';
  if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) return 'expired';
  if (!k.lastUsedAt || Date.now() - new Date(k.lastUsedAt).getTime() > 30 * DAY) return 'unused';
  return 'active';
}

export function ApiKeysSection() {
  const nav = useNavigate();
  const role = useRole();
  const canKeys = useCan('agents.keys');
  const { data, loading, error, refetch } = useQuery((o) => api.agents(o), [], { kinds: ['agent', 'key', 'receipt'] });
  const [env, setEnv] = useState<'all' | 'production' | 'sandbox'>('all');
  const [showRevoked, setShowRevoked] = useState(false);
  const [q, setQ] = useState('');

  const all = useMemo<Row[]>(() => (data ?? []).flatMap((a) => a.keys.map((k) => ({ ...k, agent: a }))), [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((k) => (env === 'all' || k.environment === env) && (showRevoked || !k.revoked) && (!needle || `${k.prefix} ${k.label} ${k.agent.slug} ${k.agent.name}`.toLowerCase().includes(needle)));
  }, [all, env, showRevoked, q]);

  // live: not revoked and not past its expiry (the agent page counts the same way)
  const live = all.filter((k) => { const s = keyState(k); return s !== 'revoked' && s !== 'expired'; });
  const stale = live.filter((k) => keyState(k) === 'unused');

  const columns: Column<Row>[] = [
    { key: 'prefix', header: 'Key', sort: (k) => k.prefix, cell: (k) => <span className="block py-1.5"><span className="font-mono text-[12.5px]">{k.prefix}…</span><span className="block text-xs text-muted truncate max-w-[220px]">{k.label}</span></span> },
    { key: 'agent', header: 'Agent', sort: (k) => k.agent.slug, cell: (k) => <AgentLink slug={k.agent.slug} /> },
    { key: 'route', header: 'Route', hideBelow: 'lg', cell: (k) => <RouteMode route={k.agent.route} compact /> },
    { key: 'env', header: 'Environment', sort: (k) => k.environment, cell: (k) => <Badge tone={k.environment === 'production' ? 'inverse' : 'neutral'}>{k.environment === 'production' ? 'Production' : 'Sandbox'}</Badge> },
    { key: 'created', header: 'Created', hideBelow: 'md', sort: (k) => k.createdAt, cell: (k) => <span className="text-sm">{date(k.createdAt)}</span> },
    { key: 'used', header: 'Last used', sort: (k) => k.lastUsedAt ?? '', hideBelow: 'sm', cell: (k) => <When iso={k.lastUsedAt} className="text-sm" /> },
    {
      key: 'state', header: 'Status', sort: (k) => keyState(k),
      cell: (k) => {
        const s = keyState(k);
        return s === 'revoked' ? <StatusChip tone="neutral" size="sm" icon={<Ban className="h-3 w-3" />}>Revoked</StatusChip>
          : s === 'expired' ? <StatusChip tone="neutral" size="sm" icon={<Clock3 className="h-3 w-3" />}>Expired</StatusChip>
          : s === 'unused' ? <StatusChip tone="held" size="sm" icon={<Clock3 className="h-3 w-3" />}>Unused 30 days</StatusChip>
          : <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>In use</StatusChip>;
      },
    },
  ];

  return (
    <div>
      <SectionHeader
        title="API keys"
        description="Every agent key across the organisation. Keys start with sk_sbx_ for sandbox and gk_ for production; the full key is shown once when issued, then only its prefix."
      />
      {!canKeys && <ReadOnlyNote role={role} who="Owners and admins">Keys are issued, rotated and revoked on each agent’s Keys tab.</ReadOnlyNote>}
      {error && <Banner tone="bad" className="mb-6" title="Keys could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-6">
        <Stat label="Live keys" value={loading && !data ? '—' : live.length} sub={`${plural(new Set(live.map((k) => k.agent.slug)).size, 'agent')}`} />
        <Stat label="Production" value={loading && !data ? '—' : live.filter((k) => k.environment === 'production').length} sub="gk_" />
        <Stat label="Sandbox" value={loading && !data ? '—' : live.filter((k) => k.environment === 'sandbox').length} sub="sk_sbx_" />
        <Stat label="Unused 30 days" value={loading && !data ? '—' : stale.length} sub={stale.length ? 'Consider revoking' : 'None'} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SearchInput aria-label="Search keys" placeholder="Search prefix, label or agent" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-64" />
        <Segmented size="sm" label="Environment" value={env} onChange={setEnv} options={[{ value: 'all', label: 'All' }, { value: 'production', label: 'Production' }, { value: 'sandbox', label: 'Sandbox' }]} />
        <Checkbox checked={showRevoked} onChange={setShowRevoked} label="Show revoked" />
      </div>

      <DataTable
        caption="Agent keys"
        columns={columns}
        rows={data ? rows : undefined}
        loading={loading}
        rowKey={(k) => k.id}
        onRowClick={(k) => nav(`/agents/${k.agent.slug}?tab=keys`)}
        initialSort={{ key: 'used', dir: 'desc' }}
        empty={<EmptyState compact title="No keys match" disc="aperture" action={<Button size="sm" variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => nav('/agents')}>Go to agents</Button>}>Keys are issued per agent. Open an agent to issue one.</EmptyState>}
      />
      <p className="mt-2 text-xs text-muted">Select a row to open the agent’s Keys tab, where keys are issued, rotated and revoked. Rotate issues a replacement with the same label and lifetime, shown once; the old key keeps working for the grace period you choose (up to 7 days), then the system revokes it. Sandbox keys (sk_sbx_) keep the old key for the grace period too; they only skip the production review. A production key (gk_) comes only through the path-to-production review, and replacing one needs that review’s approval too. Each step writes a receipt to the chain.</p>
    </div>
  );
}
