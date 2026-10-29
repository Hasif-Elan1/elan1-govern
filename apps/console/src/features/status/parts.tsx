import { AlertTriangle, CheckCircle2, OctagonX, Wrench } from 'lucide-react';
import type { ComponentStatus } from '@/types';
import { pct } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, StatusChip } from '@/components/ui';

/**
 * The pieces of a status page: one row per component with 90 days of history. Used by Elan1's public /status
 * and by a Sovereign deployment's own local status (Agents › Deployment), which Elan1 never publishes.
 */
export type DayState = ComponentStatus | 'nodata';
export interface StatusRow { id: string; name: string; group: string; status: ComponentStatus; detail: string; uptime?: number; days: { date: string; status: DayState; note?: string }[]; facts?: { label: string; value: string }[]; level?: string; to?: string }

export const STATUS_META: Record<ComponentStatus, { tone: 'ok' | 'held' | 'bad' | 'info'; label: string; icon: typeof CheckCircle2 }> = {
  operational: { tone: 'ok', label: 'Operational', icon: CheckCircle2 },
  degraded: { tone: 'held', label: 'Degraded', icon: AlertTriangle },
  outage: { tone: 'bad', label: 'Outage', icon: OctagonX },
  maintenance: { tone: 'info', label: 'Maintenance', icon: Wrench },
};
export const DAY_CLS: Record<DayState, string> = { operational: 'bg-ok', degraded: 'bg-held', outage: 'bg-bad', maintenance: 'bg-info', nodata: 'bg-line' };
const D = 864e5;

/** 90 days of a derived component from the days records were written (no record that day = no data). */
export function daysFromTimes(times: number[], now = Date.now()) {
  const set = new Set(times.map((t) => new Date(t + 5.5 * 3.6e6).toISOString().slice(0, 10)));
  const out: StatusRow['days'] = [];
  for (let i = 89; i >= 0; i--) {
    const date = new Date(now - i * D + 5.5 * 3.6e6).toISOString().slice(0, 10);
    out.push({ date, status: set.has(date) ? 'operational' : 'nodata' });
  }
  return out;
}

export function worstOf(rows: { status: ComponentStatus }[]): ComponentStatus {
  return rows.some((r) => r.status === 'outage') ? 'outage' : rows.some((r) => r.status === 'degraded') ? 'degraded' : rows.some((r) => r.status === 'maintenance') ? 'maintenance' : 'operational';
}

export function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted" aria-label="Legend">
      {(['operational', 'degraded', 'outage', 'maintenance', 'nodata'] as DayState[]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5"><span className={cn('h-3 w-2', DAY_CLS[s])} aria-hidden />{s === 'nodata' ? 'No records that day' : STATUS_META[s as ComponentStatus].label}</span>
      ))}
      <span>Each bar is one day, oldest on the left. Every bar has a text equivalent.</span>
    </div>
  );
}

export function ComponentRow({ r }: { r: StatusRow }) {
  const meta = STATUS_META[r.status];
  const withData = r.days.filter((d) => d.status !== 'nodata');
  const uptime = r.uptime ?? (withData.length ? withData.filter((d) => d.status === 'operational').length / withData.length : undefined);
  const notes = r.days.filter((d) => d.note);
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-md font-semibold flex flex-wrap items-center gap-2">{r.name}{r.level && <Badge>{r.level}</Badge>}</p>
          <p className="mt-0.5 text-sm text-muted leading-relaxed">{r.detail}</p>
        </div>
        <StatusChip tone={meta.tone} icon={<meta.icon className="h-3.5 w-3.5" aria-hidden />}>{meta.label}</StatusChip>
      </div>
      {r.facts && (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {r.facts.map((f) => <div key={f.label} className="flex gap-2 min-w-0"><dt className="text-muted shrink-0">{f.label}:</dt><dd className="min-w-0 break-words">{f.value}</dd></div>)}
        </dl>
      )}
      <div className="mt-3">
        <div className="flex h-7 items-stretch gap-[2px]" role="img" aria-label={`${r.name}: last 90 days. ${withData.length} days with data${uptime !== undefined ? `, ${pct(uptime, 2)} operational` : ''}.${notes.length ? ` ${notes.length} day${notes.length === 1 ? '' : 's'} with notes.` : ''}`}>
          {r.days.map((d) => (
            <span key={d.date} title={`${d.date}: ${d.status === 'nodata' ? 'no records' : STATUS_META[d.status as ComponentStatus].label}${d.note ? ` — ${d.note}` : ''}`} className={cn('flex-1 min-w-[1px]', DAY_CLS[d.status], d.status === 'nodata' && 'opacity-60')} />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-muted num">
          <span>90 days ago</span>
          <span>{uptime !== undefined ? `${pct(uptime, 2)} ${r.uptime !== undefined ? 'uptime' : 'of days with records'}` : 'No records yet'}</span>
          <span>Today</span>
        </div>
        {notes.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-muted">
            {notes.slice(-3).map((d) => <li key={d.date}><span className="num">{d.date}</span> — {d.note}</li>)}
          </ul>
        )}
      </div>
    </li>
  );
}
