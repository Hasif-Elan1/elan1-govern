import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Clock3, Copy, EyeOff, Hourglass, KeyRound, MinusCircle, OctagonX, Scale, ShieldCheck, UserCheck, Undo2 } from 'lucide-react';
import { api } from '@/api';
import type { CapabilityId, Counterparty, CounterpartyKind, CrossOrgReceipt, DisclosurePackage, LevelId, Receipt, Role, VerifyStep } from '@/types';
import { useQuery } from '@/hooks/useQuery';
import { useOrgLevel, useUser } from '@/store/session';
import { CAPABILITIES, LEVEL_INFO, atLeast } from '@/lib/levels';
import { DISCLOSABLE_FIELDS, FIELD_LABELS, PURPOSE_LABEL, fieldValuesOf, type DisclosureProfile } from '@/lib/disclosure';
import { REPLAY_CODE, standingOf } from '@/lib/crossorg';
import { n, rupees } from '@/lib/format';
import { cn } from '@/lib/cn';
import { USERS } from '@/mock/users';
import { Badge, Banner, Button, Checkbox, Panel, Skeleton, StatusChip } from '@/components/ui';
import { PlanUpsell, useFullPreview } from '@/shell/access';

/* ── Constants ─────────────────────────────────────────────── */

export const SEAT_PRICE = 45000;
export const TOTAL_FIELDS = DISCLOSABLE_FIELDS.length;

export const KIND_LABEL: Record<CounterpartyKind, string> = {
  customer: 'Customer', vendor: 'Vendor', insurer: 'Insurer', lender: 'Lender', regulator: 'Regulator',
};

export const KEY_ROUTE: Record<Counterparty['keyRoute'], { label: string; detail: string }> = {
  pinned: { label: 'Pinned fingerprint', detail: 'A fingerprint obtained from the issuer directly and pinned here.' },
  well_known: { label: '/.well-known/action-receipt-keys', detail: 'The key set the issuer publishes at its own domain.' },
  trust_anchor: { label: 'Trust anchor', detail: 'A key list held by a body both sides trust.' },
};

export const LIMITS_LINE = 'This establishes that the issuer’s governed write path produced this record under these rules at this time. It does not establish that the underlying transaction occurred.';

/** The evidence claim for a level (BUILD-GUIDE: never hard-code the L1 sentence). */
export function evidenceClaim(level: LevelId): string {
  if (level === 'sovereign') return 'Signed in your own HSM and timestamped by your own two authorities.';
  if (level === 'l3') return 'Signed with a key you hold in your HSM and timestamped by two authorities.';
  if (level === 'l2') return 'Sealed, signed with a key in AWS KMS and timestamped by two authorities.';
  return 'Sealed in a hash chain by Elan1 Govern and not yet externally timestamped.'; // never "signed" at L1 until DR-017 is decided
}

export const canManage = (role?: Role) => role === 'owner' || role === 'admin';
export const MANAGE_REASON = 'Owners and admins do this; your role can read it.';

export const ownersOf = (orgId: string) => USERS.filter((u) => u.role === 'owner' && u.orgIds.includes(orgId));

export function portalUrl(token: string) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/counterparty/${token}`;
}

export function packageStatus(p: Pick<DisclosurePackage, 'status' | 'expiresAt'>, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (p.status === 'revoked') return 'revoked';
  if (p.status === 'expired' || new Date(p.expiresAt).getTime() < now) return 'expired';
  return 'active';
}

/* ── Chips ─────────────────────────────────────────────────── */

export function CrossOrgChip({ state }: { state: CrossOrgReceipt['verification']['state'] }) {
  if (state === 'verified') return <StatusChip tone="ok" size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>Verified</StatusChip>;
  if (state === 'failed') return <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Failed</StatusChip>;
  if (state === 'expired') return <StatusChip tone="neutral" size="sm" icon={<Clock3 className="h-3 w-3" aria-hidden />}>Expired</StatusChip>;
  return <StatusChip tone="held" size="sm" icon={<Hourglass className="h-3 w-3" aria-hidden />}>Pending</StatusChip>;
}

export function KeyCheckChip({ state }: { state: Counterparty['verification'] }) {
  if (state === 'verified') return <StatusChip tone="ok" size="sm" icon={<KeyRound className="h-3 w-3" aria-hidden />}>Key checked</StatusChip>;
  if (state === 'failed') return <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Key mismatch</StatusChip>;
  if (state === 'pending') return <StatusChip tone="held" size="sm" icon={<Hourglass className="h-3 w-3" aria-hidden />}>Checking</StatusChip>;
  return <StatusChip tone="neutral" size="sm" icon={<MinusCircle className="h-3 w-3" aria-hidden />}>Not started</StatusChip>;
}

/** What happened to a cross-organisation receipt beyond its check: revoked, disputed, replayed, accepted. Nothing when none applies. */
export function StandingChip({ x }: { x: CrossOrgReceipt }) {
  const s = standingOf(x);
  if (s === 'revoked') return <StatusChip tone="bad" size="sm" icon={<Ban className="h-3 w-3" aria-hidden />}>{x.issuerRevoked ? 'Revoked by issuer' : 'Revoked'}</StatusChip>;
  if (s === 'disputed') return <StatusChip tone="held" size="sm" icon={<Scale className="h-3 w-3" aria-hidden />}>Disputed</StatusChip>;
  if (s === 'replayed') return <StatusChip tone="bad" size="sm" icon={<Copy className="h-3 w-3" aria-hidden />} >Replayed · {REPLAY_CODE}</StatusChip>;
  if (s === 'dispute_upheld') return <StatusChip tone="neutral" size="sm" icon={<Scale className="h-3 w-3" aria-hidden />}>Dispute upheld</StatusChip>;
  if (s === 'accepted') return <StatusChip tone="ok" size="sm" icon={<UserCheck className="h-3 w-3" aria-hidden />}>Accepted by two</StatusChip>;
  if (s === 'accept_pending') return <StatusChip tone="held" size="sm" icon={<UserCheck className="h-3 w-3" aria-hidden />}>1 of 2 accepted</StatusChip>;
  if (s === 'accept_refused') return <StatusChip tone="neutral" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Not accepted</StatusChip>;
  if (s === 'dispute_rejected') return <StatusChip tone="neutral" size="sm" icon={<Scale className="h-3 w-3" aria-hidden />}>Dispute closed</StatusChip>;
  return null;
}

/* ── Volume and reversal warning before the first issue to a new audience ── */

export type FirstIssueInfo = Awaited<ReturnType<typeof api.firstIssueInfo>>;

/** Whether an audience is new to this organisation (nothing issued, shared or bundled to it yet). */
export function useFirstIssue(audience: string | undefined, seq?: number) {
  const { data, loading } = useQuery((o) => (audience ? api.firstIssueInfo(o, audience, seq) : Promise.resolve(undefined)), [audience, seq], { kinds: ['counterparty', 'disclosure', 'receipt'] });
  return { info: audience ? data : undefined, loading };
}

/**
 * Shown before the first receipt, package or bundle to an audience. The person ticks it before the issue button
 * works, and the acknowledgement is recorded with the issue (counterparty.first_issue.acknowledged).
 */
export function FirstIssueWarning({ info, acknowledged, onChange, what = 'receipt' }: { info?: FirstIssueInfo; acknowledged: boolean; onChange: (v: boolean) => void; what?: string }) {
  if (!info?.first) return null;
  const rate = info.toolMonthly ?? info.monthly;
  return (
    <Banner tone="held" title={<span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4" aria-hidden />First {what} to {info.audience}</span>}>
      <div className="space-y-2">
        <p><strong>Volume.</strong> From now on {info.audience} can count what you send it. {info.tool ? <>Your agents made about <span className="num">{n(rate)}</span> calls of <span className="font-mono text-xs">{info.tool}</span> in the last 30 days</> : <>Your agents made about <span className="num">{n(rate)}</span> governed decisions in the last 30 days</>}; receipts sent at that rate tell them roughly <span className="num">{n(info.yearly)}</span> a year, even with every field withheld.</p>
        <p><strong>Reversal.</strong> Once issued it is signed and theirs to keep. You can revoke it, and they can dispute it, but a copy they saved still verifies: revoking stops the link and is recorded, it does not unsign the record.</p>
        <Checkbox checked={acknowledged} onChange={onChange} label="I have read this. Record that I acknowledged it with the issue." />
      </div>
    </Banner>
  );
}

/* ── Saved disclosure profiles ── */

export function useDisclosureProfiles() {
  return useQuery((o) => api.disclosureProfiles(o), [], { kinds: ['disclosure'] });
}

export function PackageChip({ status }: { status: 'active' | 'revoked' | 'expired' }) {
  if (status === 'active') return <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Active</StatusChip>;
  if (status === 'revoked') return <StatusChip tone="bad" size="sm" icon={<Undo2 className="h-3 w-3" aria-hidden />}>Withdrawn</StatusChip>;
  return <StatusChip tone="neutral" size="sm" icon={<Clock3 className="h-3 w-3" aria-hidden />}>Expired</StatusChip>;
}

/* ── Verification steps ────────────────────────────────────── */

export function VerifySteps({ steps, className }: { steps: VerifyStep[]; className?: string }) {
  if (!steps.length) return <p className="text-sm text-muted">No checks have run yet.</p>;
  return (
    <ol className={cn('divide-y divide-line border border-line bg-surface', className)}>
      {steps.map((s, i) => (
        <li key={`${s.label}-${i}`} className="flex items-start gap-3 px-3 py-2.5">
          <span className="num mt-0.5 w-5 shrink-0 text-xs text-subtle">{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{s.label}</span>
              <StepState state={s.state} />
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted break-words">{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StepState({ state }: { state: VerifyStep['state'] }) {
  if (state === 'pass') return <span className="inline-flex items-center gap-1 text-xs font-medium text-ok-fg"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Pass</span>;
  if (state === 'fail') return <span className="inline-flex items-center gap-1 text-xs font-medium text-bad-fg"><OctagonX className="h-3.5 w-3.5" aria-hidden />Fail</span>;
  return <span className="inline-flex items-center gap-1 text-xs font-medium text-muted"><MinusCircle className="h-3.5 w-3.5" aria-hidden />Not checked</span>;
}

/* ── Reveal summary and field picker ───────────────────────── */

export function RevealSummary({ revealed, total = TOTAL_FIELDS, className, who }: { revealed: number; total?: number; className?: string; who?: string }) {
  return (
    <div className={cn('border border-line bg-sunken/60 px-3 py-2.5', className)}>
      <p className="flex items-start gap-2 text-sm" aria-live="polite">
        <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span>
          {who ? `${who} is revealing` : 'You are revealing'} <strong className="num">{revealed} of {total}</strong> committed fields.{' '}
          <span className="text-muted">{total - revealed === 0 ? 'Nothing is withheld.' : `${total - revealed} stay withheld as salted digests, still bound by the signature.`}</span>
        </span>
      </p>
      <div className="mt-2 flex gap-0.5" aria-hidden>
        {Array.from({ length: total }, (_, i) => <span key={i} className={cn('h-1.5 flex-1', i < revealed ? 'bg-fg' : 'bg-line-strong/50')} />)}
      </div>
    </div>
  );
}

const PRESETS: { label: string; fields: string[] }[] = [
  { label: 'Decision only', fields: ['decision'] },
  { label: 'Auditor', fields: ['seq', 'ts', 'decision', 'rule_id', 'rulebook_version', 'approval'] },
  { label: 'Lender', fields: ['ts', 'tool', 'decision', 'approval', 'amount'] },
  { label: 'All 11', fields: [...DISCLOSABLE_FIELDS] },
];

/** Choose which of the 11 committed fields to reveal. `values` shows what each field holds for the chosen receipt. */
export function FieldPicker({ value, onChange, values, loadingValues, profiles, profileId, onProfile }: {
  value: string[]; onChange: (v: string[]) => void; values?: Record<string, string>; loadingValues?: boolean;
  /** saved disclosure profiles, offered beside the presets; choosing one sets its fields (and tells the caller) */
  profiles?: DisclosureProfile[]; profileId?: string; onProfile?: (p?: DisclosureProfile) => void;
}) {
  const toggle = (f: string, on: boolean) => { onProfile?.(undefined); onChange(on ? DISCLOSABLE_FIELDS.filter((x) => x === f || value.includes(x)) : value.filter((x) => x !== f)); };
  const chosen = profiles?.find((p) => p.id === profileId);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="label mr-1">Presets</span>
        {PRESETS.map((p) => (
          <Button key={p.label} type="button" size="sm" variant="ghost" className="border-line" onClick={() => { onProfile?.(undefined); onChange(DISCLOSABLE_FIELDS.filter((f) => p.fields.includes(f))); }}>{p.label}</Button>
        ))}
      </div>
      {profiles && profiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">Saved profiles</span>
          {profiles.map((p) => (
            <Button key={p.id} type="button" size="sm" variant={p.id === profileId ? 'secondary' : 'ghost'} className={cn('border-line', p.id === profileId && 'border-fg')} aria-pressed={p.id === profileId}
              title={`${PURPOSE_LABEL[p.purpose]} · ${p.fields.length} fields · ${p.expiresDays} days`} onClick={() => { onChange(DISCLOSABLE_FIELDS.filter((f) => p.fields.includes(f))); onProfile?.(p); }}>
              {p.name}
            </Button>
          ))}
        </div>
      )}
      {chosen && <p className="text-xs text-muted">Profile “{chosen.name}” ({PURPOSE_LABEL[chosen.purpose].toLowerCase()}): {chosen.description || `${chosen.fields.length} fields`} Expires after {chosen.expiresDays} days. Changing a field leaves the profile.</p>}
      <fieldset>
        <legend className="sr-only">Fields to reveal</legend>
        <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {DISCLOSABLE_FIELDS.map((f) => {
            const v = values?.[f];
            return (
              <li key={f} className="min-w-0">
                <Checkbox
                  checked={value.includes(f)}
                  onChange={(on) => toggle(f, on)}
                  label={FIELD_LABELS[f]}
                  description={loadingValues ? <Skeleton className="h-3 w-24" /> : values ? <span className="block truncate font-mono text-[11.5px]" title={v}>{v ? v : 'empty'}</span> : <span className="font-mono text-[11.5px]">{f}</span>}
                />
              </li>
            );
          })}
        </ul>
      </fieldset>
      <RevealSummary revealed={value.length} />
    </div>
  );
}

/** The 11 values a receipt commits to (with the approval result folded in, as the issuer does). */
export function useReceiptValues(orgId: string, seq?: number) {
  const [state, setState] = useState<{ values?: Record<string, string>; receipt?: Receipt; loading: boolean; error?: string }>({ loading: false });
  useEffect(() => {
    if (seq === undefined || !Number.isFinite(seq)) { setState({ loading: false }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    api.receipt(orgId, seq)
      .then((d) => {
        if (!live) return;
        const result = d.related.find((x) => x.kind === 'approval' && x.ref_seq === seq);
        setState({ values: fieldValuesOf(d.receipt, result), receipt: d.receipt, loading: false });
      })
      .catch((e: Error) => live && setState({ loading: false, error: e.message }));
    return () => { live = false; };
  }, [orgId, seq]);
  return state;
}

export function receiptLabel(r: Receipt) {
  return r.tool ?? r.action ?? r.kind;
}

/* ── Level gate: preview and a working upgrade path ────────── */

/**
 * Shown to organisations below L3: what the capability does, what it would show here, what the move adds
 * and costs (from api.upgradePlan), and a working route to /assurance/upgrade?to=l3. Never a dead end.
 */
type UpgradePathProps = { caps: CapabilityId[]; what: ReactNode; children?: ReactNode };

/**
 * Below L3 on an in-plan screen (the read-only Counterparties register) owners see one compact line linking to
 * Assurance levels, and every other role nothing; the preview children are not shown. The full block shows only
 * on a screen above the plan that an owner opened (Disclosure, FullPreviewScope).
 */
export function UpgradePath(props: UpgradePathProps) {
  if (!useFullPreview()) return <PlanUpsell to="l3" what="Issuing and receiving receipts, verification seats and portals." />;
  return <UpgradePathFull {...props} />;
}

function UpgradePathFull({ caps, what, children }: UpgradePathProps) {
  const nav = useNavigate();
  const user = useUser();
  const level = useOrgLevel();
  const { data: plan, loading, error } = useQuery((o) => api.upgradePlan(o, 'l3', user?.id), [user?.id, level]);
  const owners = plan ? ownersOf(plan.orgId) : [];
  const isOwner = user?.role === 'owner';
  const list = CAPABILITIES.filter((c) => caps.includes(c.id));

  return (
    <div className="space-y-6">
      <Panel kicker={`Starts at ${LEVEL_INFO.l3.label}`} title={`This organisation is on ${LEVEL_INFO[level].label}`} className="border-l-[3px] border-l-fg">
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7 space-y-4">
            <p className="text-md leading-relaxed">{what}</p>
            <ul className="space-y-3">
              {list.map((c) => (
                <li key={c.id} className="flex gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 bg-fg" aria-hidden />
                  <span>
                    <span className="block text-sm font-medium">{c.label}</span>
                    <span className="block text-sm text-muted leading-relaxed">{c.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 lg:col-span-5">
            <div className="border border-line bg-sunken/50 p-4 space-y-3">
              <p className="label">What the move to {LEVEL_INFO.l3.short} adds</p>
              {loading && !plan ? (
                <div className="space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-56" /><Skeleton className="h-4 w-32" /></div>
              ) : error ? (
                <p className="text-sm text-bad-fg">{error.message}</p>
              ) : plan ? (
                <>
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3"><dt className="text-muted">Capabilities added</dt><dd className="num font-medium">{plan.adds.length}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Yearly floor now</dt><dd className="num">{rupees(plan.priceBefore.floorPerYear)}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Yearly floor at {LEVEL_INFO.l3.short}</dt><dd className="num">{rupees(plan.priceAfter.floorPerYear)}</dd></div>
                    <div className="flex justify-between gap-3 border-t border-line pt-1.5"><dt className="font-medium">Difference</dt><dd className="num font-semibold">+{rupees(plan.floorDifference)} a year</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Each verification seat</dt><dd className="num">{rupees(SEAT_PRICE)} a year</dd></div>
                  </dl>
                  <p className="text-xs text-muted leading-relaxed">{plan.boundaryNote}</p>
                </>
              ) : null}
              <Button variant="primary" block iconRight={<ArrowRight className="h-4 w-4" aria-hidden />} onClick={() => nav('/assurance/upgrade?to=l3')}>
                {isOwner ? `Upgrade to ${LEVEL_INFO.l3.label}` : 'See the upgrade path'}
              </Button>
              {!isOwner && (
                <p className="text-xs text-muted leading-relaxed">
                  Only an owner can change the level{owners.length ? <>: {owners.map((o) => o.name).join(', ')}</> : ''}. You can see what changes and send them the link.
                </p>
              )}
            </div>
          </div>
        </div>
      </Panel>
      {children}
    </div>
  );
}

/** true when the current organisation includes L3 (Sovereign includes it). */
export function useIsL3() {
  return atLeast(useOrgLevel(), 'l3');
}

/* Seats are changed through api.setCounterpartySeats (src/api), which writes counterparty.seats.changed. */

/* ── Small layout helpers ──────────────────────────────────── */

export function Figure({ label, value, sub, loading }: { label: string; value: ReactNode; sub?: ReactNode; loading?: boolean }) {
  return (
    <div className="bg-surface px-4 py-3.5 min-w-0">
      <p className="label truncate">{label}</p>
      {loading ? <Skeleton className="mt-2 h-7 w-16" /> : <p className="mt-1 font-display text-2xl font-semibold tracking-tighter2 num">{value}</p>}
      {sub && !loading && <p className="mt-0.5 text-xs text-muted truncate">{sub}</p>}
    </div>
  );
}

export function LinkedBadge() {
  return <Badge tone="info" title="Another organisation in this console: receipts between you verify for real">In this console</Badge>;
}
