import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ROLE_INFO } from '@/lib/permissions';
import { LEVEL_INFO } from '@/lib/levels';
import type { LevelId, Role } from '@/types';
import { Badge } from '@/components/ui';
import { useRole } from '@/store/session';
import { PlanUpsell, SmartLink, upsellText, useFullPreview } from '@/shell/access';

/** Heading for a settings section: title, one line on what it is for, optional actions and marks. */
export function SectionHeader({ title, description, actions, marks }: { title: string; description: ReactNode; actions?: ReactNode; marks?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tighter2">{title}</h2>
          {marks}
        </div>
        <p className="mt-1.5 max-w-[72ch] text-md text-muted leading-relaxed">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Shown when the signed-in role can read a section but not change it. Says who can, and why. */
export function ReadOnlyNote({ role, who, children, className }: { role?: Role; who: string; children?: ReactNode; className?: string }) {
  return (
    <div role="note" className={cn('mb-6 flex items-start gap-3 border border-line bg-sunken/70 px-4 py-3 text-sm', className)}>
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
      <p className="text-fg/85">
        <span className="font-semibold text-fg">Read-only for your role.</span>{' '}
        {who} can change this.{role && <> You are signed in as {/^[aeiou]/i.test(role) ? 'an' : 'a'} {ROLE_INFO[role].label.toLowerCase()}.</>}
        {children && <> {children}</>}
        {' '}<SmartLink to="/agents/people?tab=roles" className="link" hideWhenBlocked>See role permissions</SmartLink>
      </p>
    </div>
  );
}

/** One labelled setting: label and help on the left, the control on the right. Stacks on small screens. */
export function SettingRow({ label, help, children, htmlFor, className, aside }: { label: ReactNode; help?: ReactNode; children: ReactNode; htmlFor?: string; className?: string; aside?: ReactNode }) {
  return (
    <div className={cn('grid gap-3 py-4 border-b border-line last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:gap-8', className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {htmlFor ? <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label> : <p className="text-sm font-medium">{label}</p>}
          {aside}
        </div>
        {help && <p className="mt-1 text-xs text-muted leading-relaxed max-w-[52ch]">{help}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={role === 'owner' ? 'inverse' : 'neutral'}>{ROLE_INFO[role].label}</Badge>;
}

/** A small square level tag (L2, L3, SOV) for features that start at a level. */
export function LevelTag({ level, className }: { level: LevelId; className?: string }) {
  return <span className={cn('inline-flex h-5 items-center border border-line-strong/70 px-1 font-mono text-[10.5px] font-semibold text-muted', className)} title={`Starts at ${LEVEL_INFO[level].label}`}>{LEVEL_INFO[level].tag}</span>;
}

type UpgradePathProps = { to: LevelId; children?: ReactNode; className?: string; compact?: boolean };

/**
 * A feature the organisation's level does not include yet. Owners see one compact line linking to Assurance
 * levels; every other role sees nothing. The full block shows only on a screen above the plan an owner opened.
 */
export function UpgradePath(props: UpgradePathProps) {
  if (!useFullPreview()) return <PlanUpsell to={props.to} what={upsellText(props.children)} className={props.className} />;
  return <UpgradePathFull {...props} />;
}

function UpgradePathFull({ to, children, className, compact }: UpgradePathProps) {
  const role = useRole();
  const owner = role === 'owner';
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border border-line bg-sunken/50', compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm', className)}>
      <LevelTag level={to} />
      <span className="min-w-0 flex-1 text-fg/85">{children ?? `Starts at ${LEVEL_INFO[to].label}.`}</span>
      {owner
        ? <Link to={`/assurance/upgrade?to=${to}`} className="inline-flex items-center gap-1 font-medium link whitespace-nowrap">Upgrade to {LEVEL_INFO[to].short}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
        : <Link to={`/assurance/upgrade?to=${to}`} className="inline-flex items-center gap-1 link whitespace-nowrap text-muted">What {LEVEL_INFO[to].short} adds · owners upgrade<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}
    </div>
  );
}

export function downloadFile(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function randomHex(bytes = 8) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fresh text for a toast that names the receipt a change wrote. */
export function receiptNote(seq: number) {
  return `Recorded as receipt #${new Intl.NumberFormat('en-IN').format(seq)}.`;
}

/** The message of an error thrown by the API, for a toast or banner. */
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
