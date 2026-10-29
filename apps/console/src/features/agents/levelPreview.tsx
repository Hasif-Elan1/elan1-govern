/**
 * "Never a dead end": what a level-specific feature does, what it would show here, the price difference and a
 * working route to the upgrade. Owners upgrade; everyone else sees who can.
 */
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Lock } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useRole, useUser } from '@/store/session';
import type { LevelId } from '@/types';
import { LEVEL_INFO } from '@/lib/levels';
import { rupees } from '@/lib/format';
import { Badge, Button, Panel, Skeleton } from '@/components/ui';
import { PlanUpsell, upsellText, useFullPreview } from '@/shell/access';

type UpgradeLinkProps = { to: LevelId; size?: 'sm' | 'md'; label?: string };

/**
 * Owners see one compact line linking to Assurance levels; every other role sees nothing. The button shows only on
 * a screen above the plan that an owner opened (FullPreviewScope).
 */
export function UpgradeLink(props: UpgradeLinkProps) {
  if (!useFullPreview()) return <PlanUpsell to={props.to} what={upsellText(props.label)} />;
  return <UpgradeLinkFull {...props} />;
}

function UpgradeLinkFull({ to, size = 'sm', label }: UpgradeLinkProps) {
  const nav = useNavigate();
  const role = useRole();
  return (
    <Button size={size} variant={role === 'owner' ? 'primary' : 'secondary'} iconRight={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => nav(`/assurance/upgrade?to=${to}`)}>
      {label ?? (role === 'owner' ? `Move to ${LEVEL_INFO[to].label}` : `See ${LEVEL_INFO[to].label}`)}
    </Button>
  );
}

export function LevelTag({ level }: { level: LevelId }) {
  return <Badge tone="neutral" title={`Starts at ${LEVEL_INFO[level].label}`}>{LEVEL_INFO[level].tag}</Badge>;
}

type UpgradePreviewProps = { to: LevelId; title: string; what: ReactNode; children?: ReactNode; className?: string };

/** Owners see one compact line; every other role nothing. The full preview only on a screen above the plan an owner opened. */
export function UpgradePreview(props: UpgradePreviewProps) {
  if (!useFullPreview()) return <PlanUpsell to={props.to} what={upsellText(props.title)} className={props.className} />;
  return <UpgradePreviewFull {...props} />;
}

function UpgradePreviewFull({ to, title, what, children, className }: UpgradePreviewProps) {
  const user = useUser();
  const planQ = useQuery((o) => api.upgradePlan(o, to, user?.id), [to, user?.id], { live: false });
  const membersQ = useQuery((o) => api.members(o), [], { live: false });
  const owners = (membersQ.data ?? []).filter((m) => m.role === 'owner' && m.status === 'active').map((m) => m.user?.name).filter(Boolean) as string[];
  const p = planQ.data;
  return (
    <Panel className={className} kicker={`Starts at ${LEVEL_INFO[to].label}`} title={<span className="inline-flex items-center gap-2"><Lock className="h-4 w-4 text-muted" aria-hidden />{title}</span>}
      actions={<UpgradeLink to={to} />}>
      <div className="space-y-4">
        <div className="text-sm text-muted leading-relaxed max-w-[80ch]">{what}</div>
        {children && <div className="border border-dashed border-line-strong/60 bg-canvas p-4"><p className="label mb-2">Preview · what this shows at {LEVEL_INFO[to].tag}</p>{children}</div>}
        {planQ.loading ? <Skeleton className="h-10" /> : p ? (
          <dl className="grid gap-3 sm:grid-cols-3 text-sm">
            <div><dt className="label">Now</dt><dd className="mt-0.5">{LEVEL_INFO[p.from].label} · {rupees(p.priceBefore.floorPerYear)} a year</dd></div>
            <div><dt className="label">At {LEVEL_INFO[to].tag}</dt><dd className="mt-0.5">{rupees(p.priceAfter.floorPerYear)} a year · {rupees(p.priceAfter.overageRate, { paise: true })} an action (refused {rupees(p.priceAfter.refusalRate, { paise: true })})</dd></div>
            <div><dt className="label">Who can change the level</dt><dd className="mt-0.5">{p.allowed ? 'You (owner)' : owners.length ? `${owners.join(', ')} (owner${owners.length > 1 ? 's' : ''})` : 'An owner of this organisation'}</dd></div>
          </dl>
        ) : null}
        {p && <p className="text-xs text-muted">{p.boundaryNote}</p>}
      </div>
    </Panel>
  );
}
