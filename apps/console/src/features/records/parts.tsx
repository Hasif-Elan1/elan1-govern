import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Eye, Hourglass, Info, OctagonX } from 'lucide-react';
import { StatusChip, type Tone } from '@/components/ui';
import { cn } from '@/lib/cn';
import { TYPE_META, recordPath, type RecordRef, type RecordType, type StateTone } from './lib';

const STATE_ICON: Record<StateTone, ReactNode> = {
  ok: <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  held: <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  bad: <OctagonX className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  info: <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  neutral: <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />,
};

/** The record's current state: coloured edge, icon and words — never colour alone. */
export function StateChip({ label, tone, size = 'sm', className }: { label: string; tone: StateTone; size?: 'sm' | 'md'; className?: string }) {
  return (
    <StatusChip tone={tone as Tone} size={size} icon={STATE_ICON[tone]} className={cn('max-w-full', className)}>
      <span className="truncate">{label}</span>
    </StatusChip>
  );
}

export function TypeIcon({ type, className }: { type: RecordType; className?: string }) {
  const Icon = TYPE_META[type].icon;
  return <Icon className={cn('h-4 w-4 shrink-0 text-muted', className)} aria-hidden />;
}

export function TypeLabel({ type, className }: { type: RecordType; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm text-muted whitespace-nowrap', className)} title={TYPE_META[type].hint}>
      <TypeIcon type={type} className="h-3.5 w-3.5" />
      {TYPE_META[type].label}
    </span>
  );
}

/** A record named with its type glyph; links to the record page. */
export function RecordLink({ refx, className, sub }: { refx: RecordRef; className?: string; sub?: boolean }) {
  const showId = sub && refx.name !== refx.id;
  return (
    <Link to={recordPath(refx.key)} onClick={(e) => e.stopPropagation()} className={cn('group inline-flex items-center gap-2 min-w-0 hover:underline underline-offset-2', className)}>
      <TypeIcon type={refx.type} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-fg">{refx.name}</span>
        {showId && <span className="block truncate font-mono text-[11.5px] text-muted">{refx.id}</span>}
      </span>
    </Link>
  );
}

/** Small numeric cell that greys out zeroes. */
export function Count({ value, tone }: { value: number; tone?: 'bad' | 'held' | 'ok' }) {
  if (!value) return <span className="text-subtle num">0</span>;
  return <span className={cn('num font-medium', tone === 'bad' && 'text-bad-fg', tone === 'held' && 'text-held-fg', tone === 'ok' && 'text-fg')}>{new Intl.NumberFormat('en-IN').format(value)}</span>;
}
