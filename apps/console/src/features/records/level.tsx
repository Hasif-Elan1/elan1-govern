/**
 * Level-aware pieces shared by the Records door screens (records, packs, erasure, connectors, inventory):
 * the evidence claim for the organisation's level, and the upgrade preview a level-specific feature shows
 * to an organisation below it — never a dead end.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Layers } from 'lucide-react';
import type { LevelId, Receipt } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useRole, useUser } from '@/store/session';
import { LEVEL_INFO, levelAt } from '@/lib/levels';
import { plural, rupees } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Skeleton } from '@/components/ui';
import { PlanUpsell, upsellText, useFullPreview } from '@/shell/access';

/** The evidence claim, worded for the level the record was written at. */
export function evidenceClaim(level: LevelId): string {
  switch (level) {
    case 'l2': return 'Sealed, signed with a key in AWS KMS and timestamped by two authorities.';
    case 'l3': return 'Signed with a key you hold in your HSM and timestamped by two authorities.';
    case 'sovereign': return 'Signed in your own HSM and timestamped by your own two authorities.';
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
    default: return 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped.';
  }
}

/** The level in force when a receipt was written (records before a boundary keep the lower level). */
export function levelOfReceipt(r: Pick<Receipt, 'ts'>, history: { level: LevelId; from: string }[] | undefined, current: LevelId): LevelId {
  return levelAt(history, new Date(r.ts).getTime(), current);
}

/** Where the key is held, in a short sentence that names the custody, for receipts written now. */
export function custodyPhrase(level: LevelId): string {
  switch (level) {
    case 'l2': return 'a key in AWS KMS (ap-south-1)';
    case 'l3': return 'a key you hold in your HSM';
    case 'sovereign': return 'a key in your own HSM';
    default: return 'a key Elan1 Govern holds';
  }
}

type LevelPreviewProps = { need: LevelId; what: ReactNode; shows?: ReactNode; children?: ReactNode; className?: string };

/**
 * A feature above the organisation's plan. Owners see one compact line linking to Assurance levels; every other
 * role sees nothing. The full preview shows only on a screen above the plan that an owner opened.
 */
export function LevelPreview(props: LevelPreviewProps) {
  if (!useFullPreview()) return <PlanUpsell to={props.need} what={upsellText(props.what)} className={props.className} />;
  return <LevelPreviewFull {...props} />;
}

/**
 * The full preview: one line on what it does, what it would show here, what the upgrade adds and costs (from
 * api.upgradePlan), and a working link to the upgrade.
 */
function LevelPreviewFull({ need, what, shows, children, className }: LevelPreviewProps) {
  const user = useUser();
  const role = useRole();
  const planQ = useQuery((o) => api.upgradePlan(o, need, user?.id), [need, user?.id], { kinds: ['receipt'] });
  const membersQ = useQuery((o) => api.members(o), [], { live: false });
  const owners = (membersQ.data ?? []).filter((m) => m.role === 'owner' && m.user).map((m) => m.user!.name);
  const info = LEVEL_INFO[need];
  const plan = planQ.data;
  return (
    <section className={cn('border border-line border-l-[3px] border-l-accent bg-surface', className)} aria-label={`Starts at ${info.label}`}>
      <div className="px-5 py-4 grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
        <div className="min-w-0">
          <p className="label flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" aria-hidden />Starts at {info.label}</p>
          <p className="mt-1.5 text-md font-medium">{what}</p>
          {shows && <p className="mt-1 text-sm text-muted">{shows}</p>}
          {planQ.loading ? <Skeleton className="mt-3 h-5 w-72 max-w-full" /> : plan ? (
            <p className="mt-2 text-sm text-muted">
              Moving to {info.label} adds {plural(plan.adds.length, 'capability', 'capabilities')} · yearly floor {rupees(plan.priceAfter.floorPerYear)}
              {plan.floorDifference > 0 && <> (<span className="num">{rupees(plan.floorDifference)}</span> more a year)</>}. {plan.boundaryNote}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-start md:items-end gap-1.5">
          <Link to={`/assurance/upgrade?to=${need}`} className="inline-flex items-center justify-center gap-2 h-10 px-4 font-medium bg-fg text-canvas border border-fg hover:bg-fg/90 whitespace-nowrap">
            {role === 'owner' ? `Upgrade to ${info.label}` : `See the upgrade to ${info.label}`}
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
          {role !== 'owner' && (
            <span className="text-xs text-muted max-w-[260px] md:text-right">
              Owners upgrade the organisation{owners.length ? <>: {owners.join(', ')}</> : '.'}
            </span>
          )}
        </div>
      </div>
      {children && <div className="border-t border-line">{children}</div>}
    </section>
  );
}

/** Save text as a file in the viewer's browser. */
export function downloadText(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
