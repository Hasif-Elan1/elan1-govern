import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, KeyRound, Lock, Mail, ShieldCheck } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { markReauth, useOrgId, useUser } from '@/store/session';
import { date, n, plural, rupees, rupeesShort, seqLabel } from '@/lib/format';
import { Banner, Button, Checkbox, Field, Input, Panel, Skeleton, toast } from '@/components/ui';
import type { StageDef, UpgradeRun } from '../levelModel';
import { noticeLeadDays, plannedStart } from '@/mock/upgrade';
import { groupFp, useCloseout } from './shared';

/**
 * The L1 → L2 confirm screen. Before anything changes it names the instant: the record the bound key signs first
 * ("Signing on at #N"), the key and its fingerprint, the notices, and the records that stay at L1. The switch is
 * refused if the chain has moved since the number was named.
 */
export function SignOnConfirm({ run, stages, orgName, isOwner, owners }: { run: UpgradeRun; stages: StageDef[]; orgName: string; isOwner: boolean; owners: string[] }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const ids = { p: useId(), t: useId() };
  const q = useCloseout();
  const v = q.data;
  const plan = useQuery((o) => api.upgradePlan(o, 'l2', user?.id), [user?.id], { live: false });
  const [pw, setPw] = useState('');
  const [typed, setTyped] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const missing = stages.filter((s) => !run.stages[s.id]);
  const fourteen = v?.notices.find((x) => x.kind === 'fourteen_day' && x.status === 'sent');
  // the planned date is an IST calendar day: early means before it has begun in India (as the switch checks)
  const planned = fourteen?.plannedBoundary ? plannedStart(fourteen.plannedBoundary) : undefined;
  const early = planned !== undefined && Date.now() < planned;
  const daysEarly = fourteen?.plannedBoundary ? noticeLeadDays(fourteen.plannedBoundary, Date.now()) : 0;
  const atBoundary = v?.notices.filter((x) => x.status === 'scheduled' && x.sendAt === 'boundary') ?? [];
  const nameOk = typed.trim() === orgName;
  const ready = isOwner && !!v && missing.length === 0 && nameOk && pw.length >= 4 && (!early || agreed);
  const N = v?.nextSigningSeq;

  const confirm = async () => {
    if (!user || !v || N === undefined) return;
    setBusy(true);
    setErr(undefined);
    try {
      try { await api.signIn(user.email, pw); } catch { throw new Error('That password is not right. Nothing was changed.'); }
      markReauth();
      const r = await api.switchToL2(orgId, user.id, N, agreed);
      toast.ok(`${orgName} is now on L2 Attested`, r.matched ? `Signing started at ${seqLabel(r.seq)}, as named.` : `Signing started at ${seqLabel(r.seq)}; ${seqLabel(N)} was named.`);
      nav('/assurance/upgrade/closeout');
    } catch (e) {
      setErr((e as Error).message);
      q.refetch();
    } finally { setBusy(false); }
  };

  return (
    <Panel kicker="Final stage · owner only" title="Confirm the move to Attested">
      {!v ? <Skeleton className="h-40" /> : (
        <>
          <div className="border-2 border-fg p-5 mb-5">
            <p className="label">The named instant</p>
            <p className="mt-1 font-display text-3xl font-semibold num">Signing on at {seqLabel(N!)}</p>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              When you confirm, {seqLabel(N! - 2)} records the boundary and {seqLabel(N! - 1)} hands over to the new key, both sealed with the current key.
              The first record signed with <span className="font-mono text-fg">{v.key?.kid ?? 'the bound key'}</span> is {seqLabel(N!)}. Everything up to {seqLabel(N! - 1)} stays at L1 for ever: sealed in a hash chain.
            </p>
            <p className="mt-2 text-xs text-muted">If any record is written before you confirm, this number moves and the switch is refused until you confirm the new one.</p>
          </div>

          {plan.data && (
            <div className="grid sm:grid-cols-3 gap-px bg-line border border-line mb-5">
              <Fig k="Records staying at L1" v={n(v.recordsNow + 2)} sub={`up to ${seqLabel(N! - 1)}, with the boundary and handover`} />
              <Fig k="Floor a year" v={rupeesShort(plan.data.priceAfter.floorPerYear)} sub={`${plan.data.floorDifference >= 0 ? '+' : ''}${rupees(plan.data.floorDifference)}`} />
              <Fig k="Per action" v={rupees(plan.data.priceAfter.overageRate, { paise: true })} sub={`Refused ${rupees(plan.data.priceAfter.refusalRate, { paise: true })}`} />
            </div>
          )}

          <ul className="space-y-2.5 text-sm mb-5">
            <li className="flex gap-2"><KeyRound className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />
              {v.key?.comparedSeq ? <span>Bound key <span className="font-mono">{v.key.kid}</span>, fingerprint <span className="font-mono">{groupFp(v.key.fingerprint)}</span>, compared out of band ({seqLabel(v.key.comparedSeq)}).</span> : <span className="text-bad-fg">No key is bound yet: record the key stage first.</span>}
            </li>
            <li className="flex gap-2"><Mail className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />
              {fourteen ? <span>14-day notice sent to {fourteen.toName} on {date(fourteen.sentAt!)}{planned ? `, naming ${date(fourteen.plannedBoundary!)} as the boundary` : ''}. {atBoundary.length ? `${plural(atBoundary.length, 'notice')} go${atBoundary.length === 1 ? 'es' : ''} when signing starts: ${atBoundary.map((x) => `${x.kind === 'auditor_note' ? 'auditor note' : 'confirmation'} to ${x.toName}`).join(', ')}.` : 'No boundary-day confirmation or auditor note is scheduled; you can still send them afterwards.'}</span> : <span className="text-bad-fg">The 14-day notice has not been sent.</span>}
            </li>
            <li className="flex gap-2"><Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />Until the closing record is written, a failed upgrade can be rolled back: records signed by then stay as a signed island and the organisation returns to L1.</li>
          </ul>

          {early && (
            <Banner tone="held" className="mb-4" title={`${daysEarly} day${daysEarly === 1 ? '' : 's'} before the date in the notice`}>
              <span className="block mb-2">The 14-day notice told {fourteen!.toName} the boundary would be {date(fourteen!.plannedBoundary!)}. Switch now only if they agreed to an earlier date.</span>
              {isOwner && <Checkbox checked={agreed} onChange={setAgreed} label={`${fourteen!.toName} agreed to the earlier boundary`} description="Recorded with the signing-on record." />}
            </Banner>
          )}
          {missing.length > 0 && <Banner tone="held" className="mb-4" title={`${plural(missing.length, 'stage')} still to record`}>{missing.map((s) => s.title).join(', ')}.</Banner>}
          {!isOwner && <Banner tone="neutral" className="mb-4" title="Only an owner confirms">Owners here: {owners.join(', ') || '—'}. Ask one of them to open this page.</Banner>}

          {/* the confirm form is an owner's: other roles see who confirms, not a disabled form */}
          {isOwner && <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={<>Type <span className="font-mono">{orgName}</span> to confirm</>} htmlFor={ids.t} error={typed && !nameOk ? 'The name must match exactly.' : undefined}>
                <Input id={ids.t} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Your password" htmlFor={ids.p} hint="Checked again before a change that starts signing.">
                <Input id={ids.p} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
              </Field>
            </div>
            {err && <Banner tone="bad" className="mt-4">{err}</Banner>}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="primary" size="lg" icon={<ShieldCheck className="h-4 w-4" />} iconRight={<ArrowRight className="h-4 w-4" />} disabled={!ready} loading={busy} onClick={confirm}
                title={missing.length ? 'Record every stage first.' : undefined}>
                Sign on at {seqLabel(N!)} now
              </Button>
              <span className="text-xs text-muted">Writes level.upgraded, the key handover and level.signing_on, then opens the close-out.</span>
            </div>
          </>}
        </>
      )}
    </Panel>
  );
}

function Fig({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="bg-surface p-3 min-w-0">
      <p className="label">{k}</p>
      <p className="mt-1 font-display text-lg font-semibold num break-words">{v}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}
