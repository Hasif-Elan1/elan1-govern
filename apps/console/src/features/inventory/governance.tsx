/**
 * Shared governance vocabulary for the inventory, assessments and compliance screens:
 * lifecycle stages, risk tiers, kinds, decision impact, and the review-date marker.
 * Status colour always travels with an icon and a label.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, Ban, CalendarClock, CircleDashed, CircleDot, Archive, CheckCircle2, Rocket, ShieldAlert, ShieldCheck, ShieldQuestion, Search } from 'lucide-react';
import type { AiSystem, AssessmentStatus, AssessmentTemplate, Lifecycle, RiskTier } from '@/types';
import { StatusChip, Badge, type Tone } from '@/components/ui';
import { date } from '@/lib/format';
import { cn } from '@/lib/cn';

const ic = 'h-3.5 w-3.5 shrink-0';

export const LIFECYCLE_ORDER: Lifecycle[] = ['proposed', 'in_review', 'approved', 'live', 'retired'];

export const LIFECYCLE_META: Record<Lifecycle, { label: string; tone: Tone; icon: ReactNode; help: string }> = {
  proposed: { label: 'Proposed', tone: 'neutral', icon: <CircleDashed className={ic} aria-hidden />, help: 'Registered as an idea. Not built or bought yet.' },
  in_review: { label: 'In review', tone: 'held', icon: <Search className={ic} aria-hidden />, help: 'Being assessed before it may go live.' },
  approved: { label: 'Approved', tone: 'info', icon: <CheckCircle2 className={ic} aria-hidden />, help: 'Assessment signed off; not yet in use.' },
  live: { label: 'Live', tone: 'ok', icon: <Rocket className={ic} aria-hidden />, help: 'In use in the business.' },
  retired: { label: 'Retired', tone: 'neutral', icon: <Archive className={ic} aria-hidden />, help: 'No longer in use. Kept for the record.' },
};

export function LifecycleChip({ stage, size = 'sm' }: { stage: Lifecycle; size?: 'sm' | 'md' }) {
  const m = LIFECYCLE_META[stage];
  return <StatusChip tone={m.tone} size={size} icon={m.icon}>{m.label}</StatusChip>;
}

export const TIER_ORDER: RiskTier[] = ['unacceptable', 'high', 'limited', 'minimal', 'unassessed'];

export const TIER_META: Record<RiskTier, { label: string; tone: Tone; icon: ReactNode; rank: number }> = {
  unacceptable: { label: 'Unacceptable', tone: 'bad', icon: <Ban className={ic} aria-hidden />, rank: 4 },
  high: { label: 'High risk', tone: 'bad', icon: <ShieldAlert className={ic} aria-hidden />, rank: 3 },
  limited: { label: 'Limited risk', tone: 'held', icon: <AlertTriangle className={ic} aria-hidden />, rank: 2 },
  minimal: { label: 'Minimal risk', tone: 'ok', icon: <ShieldCheck className={ic} aria-hidden />, rank: 1 },
  unassessed: { label: 'Unassessed', tone: 'neutral', icon: <ShieldQuestion className={ic} aria-hidden />, rank: 0 },
};

export function TierChip({ tier, size = 'sm', className }: { tier: RiskTier; size?: 'sm' | 'md'; className?: string }) {
  const m = TIER_META[tier];
  return <StatusChip tone={m.tone} size={size} icon={m.icon} className={className}>{m.label}</StatusChip>;
}

export const TIER_HELP = 'The risk tier is set only when a different person approves an assessment of this system. Nobody can type it in, and new systems start as Unassessed.';

export const KIND_LABEL: Record<AiSystem['kind'], string> = {
  agent: 'Agent',
  model: 'Model',
  vendor_tool: 'Vendor tool',
  internal_app: 'Internal app',
};

export const IMPACT_META: Record<AiSystem['decisionImpact'], { label: string; help: string }> = {
  none: { label: 'No decisions', help: 'Produces content a person uses; it does not decide anything.' },
  informs: { label: 'Informs decisions', help: 'A person reads its output and decides.' },
  decides: { label: 'Makes decisions', help: 'It commits the business without a person in the moment.' },
};

export function ImpactBadge({ impact }: { impact: AiSystem['decisionImpact'] }) {
  const m = IMPACT_META[impact];
  return <Badge tone={impact === 'decides' ? 'accent' : 'neutral'} title={m.help}>{m.label}</Badge>;
}

export const STATUS_META: Record<AssessmentStatus, { label: string; tone: Tone; icon: ReactNode }> = {
  draft: { label: 'Draft', tone: 'neutral', icon: <CircleDot className={ic} aria-hidden /> },
  submitted: { label: 'Waiting for sign-off', tone: 'held', icon: <CalendarClock className={ic} aria-hidden /> },
  approved: { label: 'Approved', tone: 'ok', icon: <ShieldCheck className={ic} aria-hidden /> },
  changes_requested: { label: 'Changes requested', tone: 'bad', icon: <AlertTriangle className={ic} aria-hidden /> },
};

export function AssessmentStatusChip({ status, size = 'sm' }: { status: AssessmentStatus; size?: 'sm' | 'md' }) {
  const m = STATUS_META[status];
  return <StatusChip tone={m.tone} size={size} icon={m.icon}>{m.label}</StatusChip>;
}

export const TEMPLATE_LABEL: Record<AssessmentTemplate, string> = {
  risk_triage: 'Risk triage',
  impact: 'Impact assessment',
  data_protection: 'Data-protection check',
};

/** Days until a review date; negative when overdue. */
export function daysUntil(iso?: string, now = Date.now()) {
  if (!iso) return undefined;
  return Math.floor((new Date(iso).getTime() - now) / 864e5);
}

export function reviewState(iso?: string): 'none' | 'overdue' | 'soon' | 'ok' {
  const d = daysUntil(iso);
  if (d === undefined) return 'none';
  if (d < 0) return 'overdue';
  if (d <= 60) return 'soon';
  return 'ok';
}

/** Next review with an overdue / due-soon marker. Squares, not dots. */
export function NextReview({ iso, className }: { iso?: string; className?: string }) {
  const st = reviewState(iso);
  if (st === 'none') return <span className={cn('text-sm text-subtle', className)}>Not set</span>;
  const d = daysUntil(iso)!;
  return (
    <span className={cn('inline-flex flex-col leading-tight', className)} title={date(iso!)}>
      <span className="num text-sm">{date(iso!)}</span>
      {st === 'overdue' && <span className="inline-flex items-center gap-1 text-xs font-medium text-bad-fg"><AlertTriangle className="h-3 w-3" aria-hidden />Overdue by {Math.abs(d)} {Math.abs(d) === 1 ? 'day' : 'days'}</span>}
      {st === 'soon' && <span className="inline-flex items-center gap-1 text-xs font-medium text-held-fg"><CalendarClock className="h-3 w-3" aria-hidden />Due in {d} {d === 1 ? 'day' : 'days'}</span>}
      {st === 'ok' && <span className="text-xs text-muted num">in {d} days</span>}
    </span>
  );
}

/** Horizontal lifecycle stepper: proposed → in review → approved → live → retired. */
export function LifecycleStepper({ stage }: { stage: Lifecycle }) {
  const at = LIFECYCLE_ORDER.indexOf(stage);
  return (
    <ol className="grid grid-cols-5 gap-px bg-line border border-line" aria-label="Lifecycle stage">
      {LIFECYCLE_ORDER.map((s, i) => {
        const done = i < at;
        const now = i === at;
        return (
          <li key={s} aria-current={now ? 'step' : undefined} className={cn('bg-surface px-2 py-2.5 min-w-0', now && 'bg-sunken')}>
            <span className={cn('block h-[3px] mb-2', now ? 'bg-fg' : done ? 'bg-line-strong' : 'bg-line')} aria-hidden />
            <span className={cn('block text-xs truncate', now ? 'font-semibold text-fg' : done ? 'text-muted' : 'text-subtle')}>{LIFECYCLE_META[s].label}</span>
          </li>
        );
      })}
    </ol>
  );
}
