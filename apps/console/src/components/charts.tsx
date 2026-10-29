import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Line, LineChart } from 'recharts';
import { timeShort } from '@/lib/format';

/**
 * Charts in the house style: functional colours only for decision outcomes, always with a legend label;
 * other series in ink, slate and graphite. Clay highlights at most one series.
 */
export const SERIES = {
  allow: 'rgb(var(--ok))',
  ask: 'rgb(var(--held))',
  refuse: 'rgb(var(--bad))',
  ink: 'rgb(var(--fg))',
  muted: 'rgb(var(--subtle))',
  accent: 'rgb(var(--accent))',
  info: 'rgb(var(--info))',
  grid: 'rgb(var(--line))',
};

const axis = { fontSize: 11, fill: 'rgb(var(--subtle))', fontFamily: 'IBM Plex Sans' };

function TipBox({ active, payload, label, labelFmt }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; labelFmt?: (l: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ink-800 text-paper border border-ink-700 px-3 py-2 text-xs shadow-e3 min-w-[140px]">
      {label && <p className="text-ink-300 mb-1">{labelFmt ? labelFmt(label) : label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2" style={{ background: p.color }} />{p.name}</span>
          <span className="num font-medium">{p.value.toLocaleString('en-IN')}</span>
        </p>
      ))}
    </div>
  );
}

export function DecisionBars({ data, height = 180, xKey = 'hour', xFmt = (v: string) => timeShort(v) }: { data: { allow: number; ask: number; refuse: number; [k: string]: unknown }[]; height?: number; xKey?: string; xFmt?: (v: string) => string }) {
  return (
    <div style={{ height }} role="img" aria-label="Decisions over time: allowed, asked a person and refused">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} barCategoryGap={2} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} stroke={SERIES.grid} />
          <XAxis dataKey={xKey} tick={axis} tickFormatter={xFmt} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={axis} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
          <Tooltip cursor={{ fill: 'rgb(var(--sunken))' }} content={<TipBox labelFmt={xFmt} />} />
          <Bar dataKey="allow" name="Allowed" stackId="d" fill={SERIES.allow} isAnimationActive={false} />
          <Bar dataKey="ask" name="Asked a person" stackId="d" fill={SERIES.ask} isAnimationActive={false} />
          <Bar dataKey="refuse" name="Refused" stackId="d" fill={SERIES.refuse} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Sparkline({ data, color = SERIES.ink, height = 36, dataKey = 'v' }: { data: Record<string, number>[]; color?: string; height?: number; dataKey?: string }) {
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.08} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendLines({ data, lines, height = 220, xKey, xFmt }: { data: Record<string, unknown>[]; lines: { key: string; name: string; color: string }[]; height?: number; xKey: string; xFmt?: (v: string) => string }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -10 }}>
          <CartesianGrid vertical={false} stroke={SERIES.grid} />
          <XAxis dataKey={xKey} tick={axis} axisLine={false} tickLine={false} tickFormatter={xFmt} />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => Number(v).toLocaleString('en-IN')} />
          <Tooltip content={<TipBox labelFmt={xFmt} />} />
          {lines.map((l) => <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={2} dot={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StackedColumns({ data, keys, height = 220, xKey, xFmt }: { data: Record<string, unknown>[]; keys: { key: string; name: string; color: string }[]; height?: number; xKey: string; xFmt?: (v: string) => string }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -6 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke={SERIES.grid} />
          <XAxis dataKey={xKey} tick={axis} axisLine={false} tickLine={false} tickFormatter={xFmt} />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => Number(v).toLocaleString('en-IN')} />
          <Tooltip cursor={{ fill: 'rgb(var(--sunken))' }} content={<TipBox labelFmt={xFmt} />} />
          {keys.map((k) => <Bar key={k.key} dataKey={k.key} name={k.name} stackId="s" fill={k.color} isAnimationActive={false} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span className="h-2.5 w-2.5" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
