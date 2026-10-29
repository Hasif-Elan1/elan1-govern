import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check } from 'lucide-react';
import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useUser } from '@/store/session';
import { CAPABILITIES, LEVEL_INFO } from '@/lib/levels';
import { n, rupees } from '@/lib/format';
import { userName } from '@/mock/users';
import type { CapabilityId, CustodyMode, LevelId } from '@/types';
import { Badge, Button, Panel, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { PlanUpsell, upsellText, useFullPreview } from '@/shell/access';

/** The evidence claim for each level (BUILD-GUIDE wording). */
export const CLAIM: Record<LevelId, string> = {
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  l1: 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped',
  l2: 'Sealed, signed with a key in AWS KMS and timestamped by two authorities',
  l3: 'Signed with a key you hold in your HSM and timestamped by two authorities',
  sovereign: 'Signed in your own HSM and timestamped by your own two authorities',
};

export const CUSTODY_LABEL: Record<CustodyMode, string> = {
  env_master: 'Elan1 Govern process key',
  aws_kms: 'AWS KMS',
  customer_hsm_cloud: 'Your HSM (cloud)',
  customer_hsm_onprem: 'Your HSM (on premises)',
};

/** Custody a key was created under, read from its key id and the level in force when it was created. */
export function custodyOfKey(kid: string, levelAtCreation: LevelId, interim?: boolean): string {
  // Elan1 Govern's interim chain key during a key compromise (k_<org>_hc_…): never the organisation's custody key
  if (interim || /_hc(_|$)/.test(kid)) return 'Elan1 Govern interim chain key · hash chain only';
  if (/_hsm(_|$)/.test(kid)) return levelAtCreation === 'sovereign' ? 'Your HSM (on premises)' : 'Your HSM';
  if (/_kms(_|$)/.test(kid)) return 'AWS KMS · ap-south-1';
  if (levelAtCreation === 'sovereign') return 'Your HSM (on premises)';
  if (levelAtCreation === 'l3') return 'Your HSM';
  if (levelAtCreation === 'l2') return 'AWS KMS · ap-south-1';
  return 'Elan1 Govern process key';
}

/** Active owners of an organisation, by name (who can change the level). */
export function ownerNames(orgId: string): string[] {
  try {
    return db.getDB(orgId).members.filter((m) => m.role === 'owner' && m.status === 'active').map((m) => userName(m.userId));
  } catch {
    return [];
  }
}

/** First moment of a level in the organisation's history (ms), or undefined. */
export function levelStartMs(orgId: string, level: LevelId): number | undefined {
  const order: LevelId[] = ['l1', 'l2', 'l3', 'sovereign'];
  const hist = db.getDB(orgId).org.levelHistory ?? [];
  const p = hist.find((h) => order.indexOf(h.level) >= order.indexOf(level));
  return p ? new Date(p.from).getTime() : undefined;
}

/**
 * The upgrade path for a capability the organisation's level does not include yet.
 * Never a dead end: one line on what it does, what the level adds, the price difference and a working
 * button to /assurance/upgrade?to=<level>. Non-owners see who can make the change.
 */
type UpgradeCalloutProps = { orgId: string; to: LevelId; caps?: CapabilityId[]; title?: ReactNode; children?: ReactNode; className?: string };

/**
 * Owners see one compact line linking to Assurance levels; every other role sees nothing. The full callout shows
 * only on a screen above the plan that an owner opened (FullPreviewScope).
 */
export function UpgradeCallout(props: UpgradeCalloutProps) {
  if (!useFullPreview()) return <PlanUpsell to={props.to} what={upsellText(props.title, props.children)} className={props.className} />;
  return <UpgradeCalloutFull {...props} />;
}

function UpgradeCalloutFull({ orgId, to, caps, title, children, className }: UpgradeCalloutProps) {
  const user = useUser();
  const nav = useNavigate();
  const { data, loading, error } = useQuery((o) => api.upgradePlan(o, to, user?.id), [to, user?.id], { live: false });
  const owners = ownerNames(orgId);
  const info = LEVEL_INFO[to];
  const adds = data ? (caps?.length ? data.adds.filter((c) => caps.includes(c.id)) : data.adds).slice(0, 6) : (caps ?? []).map((id) => CAPABILITIES.find((c) => c.id === id)!).filter(Boolean);
  const rest = data ? data.adds.length - adds.length : 0;
  return (
    <Panel className={cn('border-l-[3px] border-l-fg', className)} kicker={`Starts at ${info.label}`} title={title ?? `What ${info.name} adds here`}>
      {children && <p className="text-sm leading-relaxed mb-4">{children}</p>}
      <ul className="space-y-2 text-sm">
        {adds.map((c) => (
          <li key={c.id} className="flex items-start gap-2.5">
            <Check className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />
            <span><span className="font-medium">{c.label}.</span> <span className="text-muted">{c.description}</span></span>
          </li>
        ))}
        {rest > 0 && <li className="text-xs text-muted pl-6.5" style={{ paddingLeft: 26 }}>And {rest} more {rest === 1 ? 'capability' : 'capabilities'} on the upgrade page.</li>}
      </ul>
      <div className="mt-4 border-t border-line pt-4 flex flex-wrap items-end justify-between gap-4">
        <div className="text-sm min-w-0">
          {loading && !data ? <Skeleton className="h-10 w-64" /> : error ? <p className="text-bad-fg">{error.message}</p> : data && (
            <>
              <p><span className="font-semibold num">{rupees(data.priceAfter.floorPerYear)}</span> <span className="text-muted">a year</span>{data.priceAfter.includedPerYear > 0 && <span className="text-muted"> · {n(data.priceAfter.includedPerYear)} actions included</span>}</p>
              <p className="text-xs text-muted mt-0.5 num">Now {rupees(data.priceBefore.floorPerYear)} a year · {rupees(data.priceAfter.overageRate, { paise: true })} an action beyond the allowance, {rupees(data.priceAfter.refusalRate, { paise: true })} a refused action</p>
            </>
          )}
        </div>
        <div className="flex flex-col items-start sm:items-end gap-1.5">
          <Button variant="primary" iconRight={<ArrowUpRight className="h-4 w-4" />} onClick={() => nav(`/assurance/upgrade?to=${to}`)}>
            {data?.allowed ? `Move to ${info.name} · ${info.short}` : `See the move to ${info.short}`}
          </Button>
          {data && !data.allowed && data.whyNot && (
            <p className="text-xs text-muted max-w-[320px] sm:text-right">{data.whyNot}{owners.length > 0 && !data.whyNot.includes('already') ? ` Ask ${owners.join(' or ')}.` : ''}</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** A small "preview" mark used on read-only previews of a higher level. */
export function PreviewMark({ to }: { to: LevelId }) {
  return <Badge tone="neutral">Preview · {LEVEL_INFO[to].tag}</Badge>;
}
