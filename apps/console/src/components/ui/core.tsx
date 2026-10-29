import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, CircleHelp, Clock3, Hourglass, Loader2, OctagonX, ShieldCheck, ShieldQuestion, X, AlertTriangle, Info, Ban, CircleSlash } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ApprovalStatus, Decision, Severity, BuildStatus } from '@/types';

/* ── Button ───────────────────────────────────────────────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet-danger' | 'inverse';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  block?: boolean;
}

const variants: Record<Variant, string> = {
  // Actions are neutral; outcomes are coloured. Primary is ink, never clay (clay fails 4.5:1 for labels).
  primary: 'bg-fg text-canvas hover:bg-fg/90 active:bg-fg/80 border border-fg',
  secondary: 'bg-surface text-fg border border-line-strong/70 hover:border-fg hover:bg-sunken/60',
  ghost: 'text-fg hover:bg-sunken border border-transparent',
  danger: 'bg-bad text-white border border-bad hover:bg-bad/90',
  'quiet-danger': 'bg-surface text-bad-fg border border-bad/50 hover:bg-bad-bg',
  inverse: 'bg-canvas text-fg border border-canvas hover:bg-canvas/90',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-base gap-2',
  lg: 'h-12 px-5 text-md gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-colors duration-100 ease-std',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        variants[variant], sizes[size], block && 'w-full', className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md'; tone?: 'default' | 'nav' }>(
  function IconButton({ label, size = 'md', tone = 'default', className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        className={cn(
          'inline-flex items-center justify-center transition-colors duration-100',
          size === 'sm' ? 'h-7 w-7' : 'h-9 w-9',
          tone === 'nav' ? 'text-nav-muted hover:text-nav-fg hover:bg-nav-hover' : 'text-muted hover:text-fg hover:bg-sunken',
          'disabled:opacity-40',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

/* ── Tones, badges and status chips ───────────────────────── */

export type Tone = 'neutral' | 'ok' | 'held' | 'bad' | 'info' | 'accent' | 'inverse';

const toneCls: Record<Tone, string> = {
  neutral: 'bg-sunken text-muted border-line',
  ok: 'bg-ok-bg text-ok-fg border-ok/30',
  held: 'bg-held-bg text-held-fg border-held/40',
  bad: 'bg-bad-bg text-bad-fg border-bad/30',
  info: 'bg-info-bg text-info-fg border-info/30',
  accent: 'bg-clay-100/60 text-accent-fg border-accent/30 dark:bg-clay-900/40',
  inverse: 'bg-fg text-canvas border-fg',
};

export function Badge({ tone = 'neutral', children, className, icon, title }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 h-[22px] px-1.5 text-xs font-medium border whitespace-nowrap', toneCls[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

/** Edge-marked status chip: 3px coloured edge + icon + label. Colour is never the only signal. */
export function StatusChip({ tone, icon, children, className, size = 'md' }: { tone: Tone; icon?: ReactNode; children: ReactNode; className?: string; size?: 'sm' | 'md' }) {
  const edge: Record<Tone, string> = { neutral: 'border-l-line-strong', ok: 'border-l-ok', held: 'border-l-held', bad: 'border-l-bad', info: 'border-l-info', accent: 'border-l-accent', inverse: 'border-l-fg' };
  const text: Record<Tone, string> = { neutral: 'text-muted', ok: 'text-ok-fg', held: 'text-held-fg', bad: 'text-bad-fg', info: 'text-info-fg', accent: 'text-accent-fg', inverse: 'text-fg' };
  return (
    <span className={cn('inline-flex items-center gap-1.5 border border-line border-l-[3px] bg-surface font-medium whitespace-nowrap', size === 'sm' ? 'h-6 px-1.5 text-xs' : 'h-7 px-2 text-sm', edge[tone], text[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

const ic = 'h-3.5 w-3.5 shrink-0';

export const DECISION_META: Record<Decision, { tone: Tone; label: string; icon: ReactNode }> = {
  allow: { tone: 'ok', label: 'Allowed', icon: <Check className={ic} aria-hidden /> },
  ask: { tone: 'held', label: 'Asked a person', icon: <Hourglass className={ic} aria-hidden /> },
  refuse: { tone: 'bad', label: 'Refused', icon: <OctagonX className={ic} aria-hidden /> },
};

export function DecisionChip({ decision, size, short }: { decision?: Decision; size?: 'sm' | 'md'; short?: boolean }) {
  if (!decision) return <StatusChip tone="neutral" size={size} icon={<Info className={ic} aria-hidden />}>Recorded</StatusChip>;
  const m = DECISION_META[decision];
  return <StatusChip tone={m.tone} size={size} icon={m.icon}>{short ? { allow: 'Allow', ask: 'Ask', refuse: 'Refuse' }[decision] : m.label}</StatusChip>;
}

export const APPROVAL_META: Record<ApprovalStatus, { tone: Tone; label: string; icon: ReactNode }> = {
  pending: { tone: 'held', label: 'Waiting', icon: <Clock3 className={ic} aria-hidden /> },
  approved: { tone: 'ok', label: 'Approved', icon: <ShieldCheck className={ic} aria-hidden /> },
  rejected: { tone: 'bad', label: 'Rejected', icon: <X className={ic} aria-hidden /> },
  expired: { tone: 'neutral', label: 'Expired — refused', icon: <CircleSlash className={ic} aria-hidden /> },
  approved_run_failed: { tone: 'bad', label: 'Approved, run failed', icon: <AlertTriangle className={ic} aria-hidden /> },
};

export function ApprovalChip({ status, size }: { status: ApprovalStatus; size?: 'sm' | 'md' }) {
  const m = APPROVAL_META[status];
  return <StatusChip tone={m.tone} size={size} icon={m.icon}>{m.label}</StatusChip>;
}

export const SEVERITY_META: Record<Severity, { tone: Tone; label: string; icon: ReactNode }> = {
  high: { tone: 'bad', label: 'High', icon: <AlertTriangle className={ic} aria-hidden /> },
  medium: { tone: 'held', label: 'Medium', icon: <ShieldQuestion className={ic} aria-hidden /> },
  low: { tone: 'info', label: 'Low', icon: <Info className={ic} aria-hidden /> },
};

export function SeverityChip({ severity, size }: { severity: Severity; size?: 'sm' | 'md' }) {
  const m = SEVERITY_META[severity];
  return <StatusChip tone={m.tone} size={size} icon={m.icon}>{m.label}</StatusChip>;
}

/** Status marks from the memoranda: what is built, partial, planned or only specified. */
export function BuildMark({ status, className }: { status: BuildStatus; className?: string }) {
  const map: Record<BuildStatus, { label: string; cls: string }> = {
    built: { label: 'Built', cls: 'text-ok-fg border-ok/40' },
    partial: { label: 'Partial', cls: 'text-held-fg border-held/50' },
    planned: { label: 'Planned', cls: 'text-info-fg border-info/40' },
    specified: { label: 'Specified', cls: 'text-muted border-line-strong/60' },
  };
  const m = map[status];
  return <span className={cn('inline-flex items-center h-5 px-1.5 text-[10px] font-semibold uppercase tracking-label border', m.cls, className)}>{m.label}</span>;
}

export function PlannedBadge({ className }: { className?: string }) {
  return <BuildMark status="planned" className={className} />;
}

export function LegalDraft({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 h-6 px-2 text-xs border border-held/50 bg-held-bg text-held-fg', className)}>
      <AlertTriangle className="h-3 w-3" aria-hidden /> Draft — needs legal review
    </span>
  );
}

/* ── Small bits ───────────────────────────────────────────── */

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex items-center justify-center min-w-[20px] h-5 px-1 text-[11px] font-mono border border-line-strong/50 bg-surface text-muted', className)}>{children}</kbd>;
}

export function Avatar({ initials, size = 28, className, title }: { initials: string; size?: number; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center justify-center bg-ink-700 text-paper font-semibold shrink-0 select-none', className)} style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted', className)} aria-label="Loading" />;
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('skeleton', className)} style={style} aria-hidden />;
}

export function Dot({ tone }: { tone: Tone }) {
  const c: Record<Tone, string> = { neutral: 'bg-line-strong', ok: 'bg-ok', held: 'bg-held', bad: 'bg-bad', info: 'bg-info', accent: 'bg-accent', inverse: 'bg-fg' };
  return <span className={cn('inline-block h-2 w-2 shrink-0', c[tone])} aria-hidden />;
}

export function Meter({ value, tone = 'inverse', className, label }: { value: number; tone?: Tone; className?: string; label?: string }) {
  const c: Record<Tone, string> = { neutral: 'bg-line-strong', ok: 'bg-ok', held: 'bg-held', bad: 'bg-bad', info: 'bg-info', accent: 'bg-accent', inverse: 'bg-fg' };
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={cn('h-1.5 w-full bg-sunken overflow-hidden', className)} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <div className={cn('h-full transition-[width] duration-500 ease-std', c[tone])} style={{ width: `${v * 100}%` }} />
    </div>
  );
}

export function Help({ text }: { text: string }) {
  return (
    <span className="inline-flex text-subtle hover:text-fg cursor-help align-middle" title={text} aria-label={text}>
      <CircleHelp className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

export function Blocked({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <Ban className="h-3 w-3" aria-hidden />
      {children}
    </span>
  );
}
