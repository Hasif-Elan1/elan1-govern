import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Info, AlertTriangle, OctagonX, CheckCircle2, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Disc, type DiscKind } from './disc';

/* ── Page header ──────────────────────────────────────────── */

export interface Crumb { label: string; to?: string }

export function PageHeader({ kicker, title, description, actions, crumbs, meta, className }: {
  kicker?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: Crumb[]; meta?: ReactNode; className?: string;
}) {
  return (
    <header className={cn('mb-6', className)}>
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-sm text-muted">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-subtle" aria-hidden />}
              {c.to ? <Link to={c.to} className="hover:text-fg hover:underline underline-offset-2">{c.label}</Link> : <span className="text-fg">{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {kicker && <p className="label text-accent-fg mb-1.5">{kicker}</p>}
          <h1 className="text-3xl font-bold tracking-tighter2 leading-tight">{title}</h1>
          {description && <p className="mt-2 max-w-[72ch] text-md text-muted leading-relaxed">{description}</p>}
          {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/* ── Panel ────────────────────────────────────────────────── */

export function Panel({ title, kicker, actions, children, className, bodyClassName, footer, id, flush, tone }: {
  title?: ReactNode; kicker?: string; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; footer?: ReactNode; id?: string; flush?: boolean; tone?: 'default' | 'sunken' | 'inverse';
}) {
  return (
    <section id={id} className={cn('border border-line', id && 'scroll-mt-24', tone === 'sunken' ? 'bg-sunken/60' : tone === 'inverse' ? 'bg-ink-800 text-paper border-ink-700' : 'bg-surface', className)}>
      {(title || actions || kicker) && (
        <div className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3.5 border-b', tone === 'inverse' ? 'border-ink-700' : 'border-line')}>
          <div className="min-w-0">
            {kicker && <p className="label mb-0.5">{kicker}</p>}
            {title && <h2 className="text-lg font-semibold truncate">{title}</h2>}
          </div>
          {/* actions wrap under the title on narrow screens instead of pushing past the edge */}
          {actions && <div className="flex flex-wrap items-center gap-2 min-w-0 ml-auto">{actions}</div>}
        </div>
      )}
      <div className={cn(!flush && 'p-5', bodyClassName)}>{children}</div>
      {footer && <div className="px-5 py-3 border-t border-line text-sm text-muted">{footer}</div>}
    </section>
  );
}

/* ── Stat tile ────────────────────────────────────────────── */

export function Stat({ label, value, sub, delta, deltaGood, to, chart, icon, className }: {
  label: string; value: ReactNode; sub?: ReactNode; delta?: number; deltaGood?: 'up' | 'down'; to?: string; chart?: ReactNode; icon?: ReactNode; className?: string;
}) {
  const good = delta === undefined ? undefined : deltaGood === 'down' ? delta <= 0 : delta >= 0;
  const body = (
    <div className={cn('group relative bg-surface border border-line p-5 h-full flex flex-col', to && 'hover:border-line-strong transition-colors', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="label">{label}</p>
        {icon}
      </div>
      <div className="mt-3 flex items-end gap-3">
        <span className="font-display text-4xl font-semibold tracking-tighter2 num leading-none">{value}</span>
        {delta !== undefined && (
          <span className={cn('mb-0.5 inline-flex items-center text-sm font-medium num', good ? 'text-ok-fg' : 'text-bad-fg')}>
            {delta >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
            {Math.abs(delta).toFixed(0)}%
          </span>
        )}
      </div>
      {sub && <p className="mt-2 text-sm text-muted">{sub}</p>}
      {chart && <div className="mt-auto pt-3">{chart}</div>}
      {to && <ChevronRight className="absolute right-3 bottom-3 h-4 w-4 text-subtle opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden />}
    </div>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}

/* ── Key–value list ───────────────────────────────────────── */

export function KeyValue({ items, cols = 1, className }: { items: { k: ReactNode; v: ReactNode; mono?: boolean }[]; cols?: 1 | 2 | 3; className?: string }) {
  return (
    <dl className={cn('grid gap-x-8', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3', className)}>
      {items.map((it, i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-2 border-b border-line last:border-b-0 min-w-0">
          <dt className="text-sm text-muted shrink-0">{it.k}</dt>
          <dd className={cn('text-sm text-right min-w-0 break-words', it.mono && 'font-mono text-[12.5px]')}>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Empty state ──────────────────────────────────────────── */

export function EmptyState({ title, children, action, disc = 'aperture', className, compact }: { title: string; children?: ReactNode; action?: ReactNode; disc?: DiscKind; className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'py-8 px-4' : 'py-14 px-6', className)}>
      <Disc kind={disc} size={compact ? 40 : 56} />
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      {children && <p className="mt-1.5 max-w-[52ch] text-sm text-muted leading-relaxed">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ── Banner ───────────────────────────────────────────────── */

export function Banner({ tone = 'info', title, children, actions, className }: { tone?: 'info' | 'held' | 'bad' | 'ok' | 'neutral'; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  const map = {
    info: { cls: 'border-info/40 bg-info-bg', icon: <Info className="h-4 w-4 text-info-fg" aria-hidden /> },
    held: { cls: 'border-held/50 bg-held-bg', icon: <AlertTriangle className="h-4 w-4 text-held-fg" aria-hidden /> },
    bad: { cls: 'border-bad/40 bg-bad-bg', icon: <OctagonX className="h-4 w-4 text-bad-fg" aria-hidden /> },
    ok: { cls: 'border-ok/40 bg-ok-bg', icon: <CheckCircle2 className="h-4 w-4 text-ok-fg" aria-hidden /> },
    neutral: { cls: 'border-line bg-sunken/70', icon: <Info className="h-4 w-4 text-muted" aria-hidden /> },
  }[tone];
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('flex items-start gap-3 border px-4 py-3', map.cls, className)}>
      <span className="mt-0.5 shrink-0">{map.icon}</span>
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-semibold text-fg">{title}</p>}
        {children && <div className="text-fg/80 mt-0.5">{children}</div>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ── Section heading inside a page ────────────────────────── */

export function SectionTitle({ children, kicker, actions, className }: { children: ReactNode; kicker?: string; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-end justify-between gap-3 mb-3', className)}>
      <div>
        {kicker && <p className="label mb-1">{kicker}</p>}
        <h2 className="text-xl font-semibold">{children}</h2>
      </div>
      {actions}
    </div>
  );
}

/* ── Timeline ─────────────────────────────────────────────── */

export function Timeline({ items }: { items: { time?: ReactNode; title: ReactNode; body?: ReactNode; tone?: 'ok' | 'held' | 'bad' | 'info' | 'neutral' }[] }) {
  const c = { ok: 'bg-ok', held: 'bg-held', bad: 'bg-bad', info: 'bg-info', neutral: 'bg-line-strong' };
  return (
    <ol className="relative">
      {items.map((it, i) => (
        <li key={i} className="relative pl-6 pb-5 last:pb-0">
          {i < items.length - 1 && <span className="absolute left-[4px] top-3 bottom-0 w-px bg-line" aria-hidden />}
          <span className={cn('absolute left-0 top-1.5 h-[9px] w-[9px]', c[it.tone ?? 'neutral'])} aria-hidden />
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-sm font-medium">{it.title}</span>
            {it.time && <span className="text-xs text-muted num">{it.time}</span>}
          </div>
          {it.body && <div className="mt-1 text-sm text-muted">{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}

/** A thin rule with a folio-style label, used between page sections. */
export function Rule({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 my-8" role="separator">
      {label && <span className="label">{label}</span>}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
