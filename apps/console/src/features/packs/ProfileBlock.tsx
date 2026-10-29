import { useState } from 'react';
import { CheckCircle2, CircleSlash, Play, ShoppingCart, XCircle } from 'lucide-react';
import type { PackId, ProfileRunResult, VerifierProfile } from '@/types';
import { api } from '@/api';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { date, plural, rupees, seqLabel } from '@/lib/format';
import { PACK_TEMPLATE } from '@/lib/packs';
import { PROFILE_STATUS_LABEL, RULE_STATE_LABEL } from '@/lib/profiles';
import { userName } from '@/mock/users';
import type { Entitlement } from '@/mock/packsFactory';
import { Banner, Button, DataTable, EmptyState, KeyValue, StatusChip, Tooltip, toast, type Column } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { BlockPanel } from './blocks';
import { DryRunChip } from './parts';
import { SmartLink } from '@/shell/access';

export function RuleStateChip({ state }: { state: ProfileRunResult['rules'][number]['state'] }) {
  if (state === 'pass') return <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Pass</StatusChip>;
  if (state === 'fail') return <StatusChip size="sm" tone="bad" icon={<XCircle className="h-3 w-3" aria-hidden />}>Fail</StatusChip>;
  return <StatusChip size="sm" tone={state === 'not_measurable' ? 'held' : 'neutral'} icon={<CircleSlash className="h-3 w-3" aria-hidden />}>{RULE_STATE_LABEL[state]}</StatusChip>;
}

/**
 * Block 8: the profile the pack binds, its author and issuer, the order that entitles a run, and a run against the
 * chain. The run has the same rules as the Verifier profiles screen: owners, admins and auditors run it; at L1 it is
 * a trial preview that is never recorded; from L2 it needs an order and is recorded.
 */
export function ProfileBlock({ packId, installed, profile, entitlement }: { packId: PackId; installed: boolean; profile?: VerifierProfile & { lastRun?: ProfileRunResult }; entitlement?: Entitlement }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const canRun = useCan('evidence.export');
  const l2 = atLeast(level, 'l2');
  const [running, setRunning] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [run, setRun] = useState<ProfileRunResult>();
  const last = run ?? profile?.lastRun;
  const binding = PACK_TEMPLATE[packId].profileBinding;

  // the same rule as the Verifier profiles screen and the server's guardRun: at L1 any profile runs as a trial preview,
  // installed or not; from L2 it needs an order (a draft runs as an unrecorded preview)
  // roles that do not run profiles do not see the button; a missing order or a withdrawal keeps its reason
  const why = !profile ? undefined
    : entitlement && !entitlement.canRun ? entitlement.why
    : undefined;
  const preview = !l2 || !!entitlement?.preview;

  const doRun = async () => {
    if (!profile) return;
    setRunning(true);
    try {
      // L1: a trial preview, never recorded; L2+: recorded as the person running it (a draft's preview is not)
      const r = await api.runProfile(orgId, profile.id, l2 ? user?.id : undefined);
      setRun(r);
      const failing = r.rules.filter((x) => x.state === 'fail').length;
      toast[r.result === 'pass' ? 'ok' : 'held'](`${profile.name}: ${r.result === 'pass' ? 'every rule passes' : `${plural(failing, 'rule')} failing`}`, r.seq ? <>Recorded as {seqLabel(r.seq)}.</> : 'Preview run — not recorded.');
    } catch (e) {
      toast.bad('Could not run the profile', (e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const order = async () => {
    if (!user || !profile) return;
    setOrdering(true);
    try {
      const r = await api.orderProfile(orgId, profile.id, user.id);
      toast.ok(`${profile.name} ordered`, `Billed from this month at ${rupees(300000)} a year, on its own line. Receipt ${seqLabel(r.seq)}.`);
    } catch (e) {
      toast.bad('Could not order the profile', (e as Error).message);
    } finally {
      setOrdering(false);
    }
  };

  const cols: Column<ProfileRunResult['rules'][number]>[] = [
    { key: 'id', header: 'Rule', cell: (r) => <span className="font-mono text-[12.5px]">{r.id}</span>, width: 70 },
    { key: 'text', header: 'Checks', cell: (r) => <div className="py-1.5"><p className="text-sm">{r.text}</p><p className="text-xs text-muted">{r.clause} · {r.detail}</p></div> },
    { key: 'state', header: 'Result', align: 'right', cell: (r) => <span className="inline-flex flex-col items-end gap-1"><RuleStateChip state={r.state} />{r.state === 'fail' && r.failingSeqs[0] !== undefined && <span className="text-xs">first at <ReceiptLink seq={r.failingSeqs[0]} /></span>}</span> },
  ];

  return (
    <BlockPanel id="profile_binding" flush
      actions={profile && (
        <>
          <SmartLink to={`/assurance/profiles?id=${profile.id}`} hideWhenBlocked className="text-sm font-medium hover:underline underline-offset-2">Open the profile →</SmartLink>
          {canRun && (
            <Tooltip content={why ?? (!preview ? 'Run every rule against the whole chain; the run is recorded' : `A ${l2 ? 'preview of the draft' : 'trial preview'} against the chain${installed ? '' : `, whether or not ${packId} is installed`}; not recorded`)}>
              <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} loading={running} disabled={!!why} onClick={doRun}>{preview ? 'Preview against the chain' : 'Run against the chain'}</Button>
            </Tooltip>
          )}
        </>
      )}>
      {!profile ? <EmptyState compact title="No profile" disc="registration">This pack has no verifier profile in this deployment.</EmptyState> : (
        <>
          <div className="px-5 py-4 border-b border-line">
            <KeyValue cols={2} items={[
              { k: 'Profile', v: <span className="font-mono">{profile.id} v{profile.version}</span> },
              { k: 'Status', v: PROFILE_STATUS_LABEL[profile.status] },
              { k: 'Author', v: profile.author ?? (l2 ? 'Not yet signed' : 'Not yet recorded') },
              { k: 'Issuer (never the author)', v: profile.certifier ?? '—' },
              { k: 'Rule as at', v: date(`${binding.ruleAsAt}T00:00:00Z`) },
              { k: 'Applies to records from', v: date(`${binding.appliesToRecordsFrom}T00:00:00Z`) },
              { k: 'Minimum level', v: LEVEL_INFO.l2.label },
              { k: 'Refusals required', v: binding.refusalsRequired ? 'Yes' : 'No' },
            ]} />
          </div>
          {entitlement && (
            entitlement.withdrawn ? <Banner tone="bad" className="m-5" title="Withdrawn">{entitlement.why}{entitlement.ordered && role === 'owner' ? ' Cancel it on the profile’s page.' : ''}</Banner>
            : entitlement.trial ? <Banner tone="info" className="m-5" title="Trial at L1 — preview only">{entitlement.why}</Banner>
            : entitlement.preview ? <Banner tone="held" className="m-5" title="Not issued — preview only">{entitlement.why}</Banner>
            : !entitlement.ordered ? (
              <Banner tone="held" className="m-5" title="Not ordered" actions={role === 'owner' ? <Button size="sm" variant="primary" icon={<ShoppingCart className="h-3.5 w-3.5" />} loading={ordering} onClick={order}>Order for {rupees(300000)} a year</Button> : undefined}>
                {entitlement.why} {role !== 'owner' && 'An owner orders it here or under Billing.'}
              </Banner>
            ) : (
              <p className="px-5 py-3 border-b border-line text-sm text-muted">Ordered <When iso={entitlement.order!.at} /> by {userName(entitlement.order!.by)} · <ReceiptLink seq={entitlement.order!.seq} /> · {rupees(300000)} a year, its own line.</p>
            )
          )}
          {last ? (
            <>
              <div className="px-5 py-3 border-b border-line flex flex-wrap items-center gap-3 text-sm">
                {last.result === 'pass' ? <StatusChip tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" />}>Pass</StatusChip> : <StatusChip tone="bad" icon={<XCircle className="h-3.5 w-3.5" />}>Fail — FAIL_PROFILE</StatusChip>}
                {!l2 && <DryRunChip />}
                <span className="text-muted">Ran <When iso={last.ranAt} />{last.ranBy ? ` by ${userName(last.ranBy)}` : ''} over <span className="num">{plural(last.range.count, 'receipt')}</span> (<ReceiptLink seq={last.range.firstSeq} />–<ReceiptLink seq={last.range.lastSeq} />)</span>
                {last.seq !== undefined ? <span className="text-muted">· receipt <ReceiptLink seq={last.seq} /></span> : <span className="text-muted">· preview, not recorded</span>}
              </div>
              <DataTable className="!border-0" caption={`${profile.name} rules`} columns={cols} rows={last.rules} rowKey={(r) => r.id} />
            </>
          ) : (
            <ul className="divide-y divide-line">
              {profile.rules.map((r) => (
                <li key={r.id} className="px-5 py-2.5 text-sm flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0"><span className="font-mono text-xs text-muted mr-2">{r.id}</span>{r.text} <span className="text-xs text-muted">· {r.clause}</span></span>
                  {r.disposition && r.disposition !== 'bound' && <RuleStateChip state={r.disposition} />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </BlockPanel>
  );
}
