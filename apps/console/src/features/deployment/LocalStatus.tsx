import { useMemo } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';
import { timeShort } from '@/lib/format';
import { Banner, Button, Skeleton } from '@/components/ui';
import { ComponentRow, STATUS_META, StatusLegend, worstOf, type StatusRow } from '@/features/status/parts';
import { sovereignApi } from './sovereignApi';

const ORDER = ['Platform', 'Delivery', 'Keys and storage', 'Timestamping', 'Chain integrity', 'Network'];

/**
 * A Sovereign deployment's own status page: its components measured inside its network, 90 days each, and the
 * integrity of its chain re-checked in this browser. Elan1's public /status never lists an on-premises
 * organisation; this page is reachable only from inside.
 */
export function LocalStatus() {
  const { data, loading, error, refetch, refreshing } = useQuery((o) => sovereignApi.localStatus(o), [], { kinds: ['deployment', 'checkpoint', 'approval'] });
  const groups = useMemo(() => {
    const m = new Map<string, StatusRow[]>();
    for (const c of data?.components ?? []) (m.get(c.group) ?? m.set(c.group, []).get(c.group)!).push(c);
    return [...m.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  }, [data]);
  if (error) return <Banner tone="bad" title="Local status could not be read" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-20" /><Skeleton className="h-64" /></div>;
  if (!data) return null;
  const overall = worstOf(data.components);
  const meta = STATUS_META[overall];
  return (
    <div className="space-y-6">
      <section aria-live="polite" className={cn('border border-line border-l-[6px] bg-surface p-5', overall === 'operational' ? 'border-l-ok' : overall === 'degraded' ? 'border-l-held' : overall === 'outage' ? 'border-l-bad' : 'border-l-info')}>
        <div className="flex flex-wrap items-center gap-3">
          <meta.icon className="h-5 w-5" aria-hidden />
          <p className="font-display text-xl font-semibold">{overall === 'operational' ? 'Every local component is operational' : overall === 'degraded' ? 'Some local components are degraded' : overall === 'outage' ? 'A local component is down' : 'Maintenance in progress'}</p>
          <span className="sm:ml-auto text-sm text-muted num">Checked {timeShort(data.checkedAt)} IST</span>
          <Button size="sm" variant="secondary" icon={<RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />} onClick={refetch}>Check again</Button>
        </div>
        <p className="mt-2 flex items-start gap-2 text-sm text-muted"><Server className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Measured inside your network and shown only here. Elan1’s public status page does not list this deployment, and nothing on this page is sent to Elan1.</p>
      </section>
      <StatusLegend />
      {groups.map(([g, rows]) => (
        <section key={g} aria-labelledby={`ls-${g}`}>
          <h3 id={`ls-${g}`} className="text-lg font-semibold border-b border-line pb-2">{g}</h3>
          <ul className="divide-y divide-line border-x border-b border-line bg-surface">{rows.map((r) => <ComponentRow key={r.id} r={r} />)}</ul>
        </section>
      ))}
    </div>
  );
}
