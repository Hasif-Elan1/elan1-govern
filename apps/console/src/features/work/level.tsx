/**
 * Level-aware pieces shared by the Work door and the rulebooks screens: the evidence claim for the
 * organisation's assurance level, the level badge, and the upgrade path shown where a capability starts
 * at a higher level (never a dead end).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Layers } from 'lucide-react';
import type { LevelId } from '@/types';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { useOrgLevel, useRole } from '@/store/session';
import { cn } from '@/lib/cn';
import { PlanUpsell, SmartLink, upsellText, useFullPreview } from '@/shell/access';

/** The evidence claim for a level (BUILD-GUIDE wording). Never hard-code the L1 sentence on a screen any organisation can open. */
export function claimFor(level: LevelId): string {
  switch (level) {
    case 'l2': return 'Sealed, signed with a key in AWS KMS and timestamped by two authorities';
    case 'l3': return 'Signed with a key you hold in your HSM and timestamped by two authorities';
    case 'sovereign': return 'Signed in your own HSM and timestamped by your own two authorities';
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
    default: return 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped';
  }
}

/** The claim with the authorities named when they are known: eMudhra TSA and the global authority, or the customer's local TSAs. */
export function claimDetail(level: LevelId, tsas?: string[], custody?: string): string {
  if (level === 'l1') return 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped.';
  const who = tsas?.length ? tsas.join(' and ') : level === 'sovereign' ? 'your two local timestamp authorities' : 'eMudhra TSA (India) and a global timestamp authority';
  if (level === 'l2') return `Sealed, signed with a key in ${custody ?? 'AWS KMS (ap-south-1)'} and timestamped by ${who}.`;
  if (level === 'l3') return `Signed with a key you hold in ${custody ?? 'your HSM'} and timestamped by ${who}.`;
  return `Signed in ${custody ?? 'your own HSM'} and timestamped by ${who}.`;
}

export function LevelBadge({ level, className, link = true }: { level: LevelId; className?: string; link?: boolean }) {
  const body = (
    <span className={cn('inline-flex items-center gap-1.5 h-[22px] px-1.5 text-xs font-medium border border-line-strong/60 bg-surface text-fg whitespace-nowrap', className)}>
      <Layers className="h-3 w-3" aria-hidden />
      <span className="font-mono text-[11px]">{LEVEL_INFO[level].tag}</span>
      <span>{LEVEL_INFO[level].name}</span>
    </span>
  );
  // a role that cannot open Assurance levels (approvers) gets the badge without the link
  return link ? <SmartLink to="/assurance/levels" title="Assurance levels" className="hover:opacity-80">{body}</SmartLink> : body;
}

/**
 * Shown where a capability starts at a higher level than the organisation's: what it does, and a working
 * path to the upgrade (owners upgrade; others see who can).
 */
type UpgradePathProps = { to: LevelId; what: string; children?: ReactNode; className?: string; compact?: boolean };

/**
 * Owners see one compact line linking to Assurance levels; every other role sees nothing. The full block shows only
 * on a screen above the plan that an owner opened (FullPreviewScope).
 */
export function UpgradePath(props: UpgradePathProps) {
  if (!useFullPreview()) return <PlanUpsell to={props.to} what={upsellText(props.what)} className={props.className} />;
  return <UpgradePathFull {...props} />;
}

function UpgradePathFull({ to, what, children, className, compact }: UpgradePathProps) {
  const role = useRole();
  const level = useOrgLevel();
  if (atLeast(level, to)) return null;
  return (
    <div className={cn('border border-line border-l-[3px] border-l-line-strong bg-sunken/50 px-4 py-3 text-sm', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium flex flex-wrap items-center gap-2"><span className="font-mono text-[11px] border border-line-strong/60 px-1">{LEVEL_INFO[to].tag}</span>{what}</p>
          {!compact && children && <div className="mt-1 text-muted leading-relaxed">{children}</div>}
        </div>
        <Link to={`/assurance/upgrade?to=${to}`} className="shrink-0 inline-flex items-center gap-1 h-8 px-3 text-sm font-medium border border-line-strong/70 bg-surface hover:border-fg">
          {role === 'owner' ? `Upgrade to ${LEVEL_INFO[to].name}` : `See ${LEVEL_INFO[to].name}`}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      {role !== 'owner' && !compact && <p className="mt-1.5 text-xs text-muted">Only an owner of this organisation can change its level.</p>}
    </div>
  );
}
