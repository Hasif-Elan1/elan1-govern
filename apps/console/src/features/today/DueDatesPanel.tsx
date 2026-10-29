import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, ClipboardCheck, Clock3, Eraser, Gauge, Inbox, KeyRound, Package, ShieldAlert, Siren, Wrench } from 'lucide-react';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { countdown, dateTime, n } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, EmptyState, Panel, Segmented, Skeleton, toast } from '@/components/ui';
import { activeMaintenance, nextMaintenance, startMaintenanceNow, subscribeMaintenance } from '@/mock/opsMaintenance';
import { isSovereign } from '@/mock/sovereign';
import { useScreenAccess } from '@/shell/access';
import { DUE_LABEL, dueDates, type DueItem, type DueKind } from './dueDates';

const ICON: Record<DueKind, ReactNode> = {
  assessment: <ClipboardCheck className="h-3.5 w-3.5" aria-hidden />,
  key: <KeyRound className="h-3.5 w-3.5" aria-hidden />,
  pack: <Package className="h-3.5 w-3.5" aria-hidden />,
  erasure: <Eraser className="h-3.5 w-3.5" aria-hidden />,
  approval: <Inbox className="h-3.5 w-3.5" aria-hidden />,
  supervision: <Gauge className="h-3.5 w-3.5" aria-hidden />,
  certin: <Siren className="h-3.5 w-3.5" aria-hidden />,
  break_glass: <ShieldAlert className="h-3.5 w-3.5" aria-hidden />,
  maintenance: <Wrench className="h-3.5 w-3.5" aria-hidden />,
};

const DAY = 86_400_000;
/** Midnight IST of the day containing t. */
const istMidnight = (t: number) => { const x = new Date(t + 5.5 * 3.6e6); x.setUTCHours(0, 0, 0, 0); return x.getTime() - 5.5 * 3.6e6; };

function bucket(at: string, now: number): 'overdue' | 'today' | 'week' | 'later' {
  const t = new Date(at).getTime();
  if (t < now) return 'overdue';
  if (t < istMidnight(now) + DAY) return 'today';
  if (t < istMidnight(now) + 7 * DAY) return 'week';
  return 'later';
}
const BUCKET_LABEL = { overdue: 'Overdue', today: 'Today', week: 'Next 7 days', later: 'Later' } as const;

/**
 * Today's due-dates panel — the obligations calendar: what falls due, from the organisation's own records, grouped
 * into overdue, today, the next seven days and later (up to 45 days).
 */
export function DueDatesPanel({ now, className }: { now: number; className?: string }) {
  const level = useOrgLevel();
  const [range, setRange] = useState<'7' | '45'>('45');
  const q = useQuery((o) => dueDates(o, level, 45), [level], { kinds: ['receipt', 'approval', 'incident', 'session', 'autonomy', 'key', 'level'] });
  // only the obligations behind screens this role and plan can open (an approver does not see key rotations)
  const access = useScreenAccess();
  const visible = useMemo(() => (q.data ?? []).filter((d) => access.canSee(d.to)), [q.data, access]);
  const items = useMemo(() => visible.filter((d) => range === '45' || new Date(d.at).getTime() < istMidnight(now) + 7 * DAY), [visible, range, now]);
  const groups = useMemo(() => {
    const m = new Map<string, DueItem[]>();
    for (const d of items) { const b = bucket(d.at, now); (m.get(b) ?? m.set(b, []).get(b)!).push(d); }
    return (['overdue', 'today', 'week', 'later'] as const).filter((b) => m.has(b)).map((b) => [b, m.get(b)!] as const);
  }, [items, now]);
  const statutory = items.filter((d) => d.statutory && new Date(d.at).getTime() >= now).length;

  return (
    <Panel
      className={className}
      title="Due dates"
      kicker="Obligations calendar"
      flush
      actions={<Segmented size="sm" label="Range" value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '45', label: '45 days', count: q.data ? visible.length : undefined }]} />}
      footer={<span>From your own records: assessment reviews, key rotations and expiries, pack pilots, erasure deadlines, approval expiries, supervised periods, CERT-In reports, emergency access and maintenance.{statutory ? ` ${n(statutory)} statutory ${statutory === 1 ? 'clock is' : 'clocks are'} running.` : ''}</span>}
    >
      {q.loading && !q.data ? <div className="p-5 space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        : q.error ? <div className="p-5"><Banner tone="bad" title="Due dates could not be read" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner></div>
        : items.length === 0 ? <EmptyState compact title={range === '7' ? 'Nothing due in the next 7 days' : 'Nothing due in the next 45 days'} disc="progress">Dated obligations from your records appear here as they come up.</EmptyState>
        : (
          <div className="max-h-[440px] overflow-y-auto">
            {groups.map(([b, list]) => (
              <section key={b} aria-label={BUCKET_LABEL[b]}>
                <p className={cn('label px-5 pt-3 pb-1', b === 'overdue' && 'text-bad-fg')}>{BUCKET_LABEL[b]} · {list.length}</p>
                <ul className="divide-y divide-line">
                  {list.map((d) => (
                    <li key={d.id}>
                      <Link to={d.to} className="flex items-start gap-3 px-5 py-2.5 hover:bg-sunken/60">
                        <span className={cn('mt-0.5', d.statutory ? 'text-bad-fg' : 'text-muted')}>{ICON[d.kind]}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium leading-snug line-clamp-2">{d.title}</span>
                          <span className="block text-xs text-muted line-clamp-1">{DUE_LABEL[d.kind]} · {d.detail}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className={cn('block text-xs num', b === 'overdue' ? 'text-bad-fg font-medium' : b === 'today' ? 'text-held-fg font-medium' : 'text-muted')}>{b === 'overdue' ? 'Overdue' : countdown(d.at, now)}</span>
                          <span className="block text-[11px] text-subtle num">{dateTime(d.at).replace(' IST', '')}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
    </Panel>
  );
}

/** The next planned maintenance window, announced ahead; owners can start it now for a demonstration. */
export function MaintenanceNotice({ now }: { now: number }) {
  const nav = useNavigate();
  const role = useRole();
  const user = useUser();
  const orgId = useOrgId();
  const level = useOrgLevel();
  useSyncExternalStore(subscribeMaintenance, () => `${activeMaintenance()?.id ?? ''}:${nextMaintenance()?.from ?? ''}`);
  // Elan1's hosted maintenance windows never reach a Sovereign deployment: it runs on the bank's own cluster and
  // applies its own update bundles (Agents › Deployment), and Elan1's public status page does not list it
  if (level === 'sovereign' || isSovereign(orgId)) return null;
  const next = nextMaintenance(now);
  if (!next || new Date(next.from).getTime() - now > 7 * DAY) return null;
  const start = () => {
    try {
      const w = startMaintenanceNow({ userId: user?.id, orgId });
      toast.info('Maintenance window started', `The console closes for everyone while it is open. Agents keep being governed.${w.startedBy?.seq !== undefined ? ` Recorded as receipt #${w.startedBy.seq}.` : ''}`);
      nav(`/maintenance?next=${encodeURIComponent(window.location.pathname)}`);
    } catch (e) {
      toast.bad('Not started', (e as Error).message);
    }
  };
  return (
    <Banner tone="neutral" title={<span className="inline-flex items-center gap-2"><CalendarClock className="h-4 w-4" aria-hidden />Planned maintenance {new Date(next.from).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}, {dateTime(next.from).split(', ').pop()?.replace(' IST', '')}–{dateTime(next.to).split(', ').pop()}</span>}
      actions={<>
        <Button size="sm" variant="secondary" icon={<Clock3 className="h-3.5 w-3.5" />} onClick={() => nav('/status')}>Status</Button>
        {role === 'owner' && <Button size="sm" variant="ghost" onClick={start}>Start it now (demonstration)</Button>}
      </>}>
      {next.note} The console shows a maintenance page while it runs; approvals wait in the queue with their clocks running. <Badge>in {countdown(next.from, now)}</Badge>
    </Banner>
  );
}
