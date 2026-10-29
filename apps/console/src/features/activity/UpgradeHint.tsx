import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import type { LevelId } from '@/types';
import { LEVEL_INFO } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { useRole } from '@/store/session';
import { Button } from '@/components/ui';
import { PlanUpsell, upsellText, useFullPreview } from '@/shell/access';

/** A square level tag: L2, L3, SOV. */
export function LevelTag({ level, className, title }: { level: LevelId; className?: string; title?: string }) {
  return (
    <span title={title ?? LEVEL_INFO[level].label} className={cn('inline-flex items-center h-5 px-1.5 text-[10px] font-semibold uppercase tracking-label border border-line-strong text-fg bg-surface', className)}>
      {LEVEL_INFO[level].tag}
    </span>
  );
}

type UpgradeHintProps = { to: LevelId; title: ReactNode; children?: ReactNode; preview?: ReactNode; className?: string; compact?: boolean };

/**
 * A capability above the organisation's plan. Owners see one compact line linking to Assurance levels; every
 * other role sees nothing. The full preview shows only on a screen above the plan that an owner opened.
 */
export function UpgradeHint(props: UpgradeHintProps) {
  if (!useFullPreview()) return <PlanUpsell to={props.to} what={upsellText(props.title, props.children)} className={props.className} />;
  return <UpgradeHintFull {...props} />;
}

/** The full preview: what a capability does, what it would show here, and the way up. */
function UpgradeHintFull({ to, title, children, preview, className, compact }: UpgradeHintProps) {
  const nav = useNavigate();
  const role = useRole();
  const owner = role === 'owner';
  return (
    <div className={cn('border border-dashed border-line-strong bg-sunken/40', compact ? 'p-3' : 'p-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-[68ch]">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold"><LevelTag level={to} />{title}</p>
          {children && <div className="mt-1 text-sm text-muted leading-relaxed">{children}</div>}
        </div>
        <div className="flex flex-col items-start gap-1 min-w-0 max-w-full">
          <Button size="sm" variant={owner ? 'primary' : 'secondary'} iconRight={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => nav(`/assurance/upgrade?to=${to}`)}>
            {owner ? `Upgrade to ${LEVEL_INFO[to].short}` : `See what ${LEVEL_INFO[to].short} adds`}
          </Button>
          {!owner && <span className="text-xs text-muted">An owner of the organisation decides the level.</span>}
        </div>
      </div>
      {preview && <div className="mt-3">{preview}</div>}
    </div>
  );
}
