import { useState } from 'react';
import { Ban, CalendarClock, CheckCircle2, KeyRound, Lock, Power, Undo2 } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { date, dateTime, n, relative } from '@/lib/format';
import { userName } from '@/mock/users';
import { keysApi, type KeyWindow } from '@/mock/keys';
import { useCanDo } from '@/features/settings/permissions';
import { receiptNote } from '@/features/settings/shared';
import { Banner, Button, Panel, Skeleton, StatusChip, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { BindKeyDialog } from './Compromise';
import { SmartLink } from '@/shell/access';
import { errMsg, useKeysState } from './useKeys';

export function KeyStatusChip({ w }: { w: Pick<KeyWindow, 'status' | 'interim'> }) {
  // L1 copy says "sealed in a hash chain", never "signed"
  const l1 = !atLeast(useOrgLevel(), 'l2');
  if (w.status === 'active' && !w.interim && l1) return <StatusChip tone="ok" size="sm" icon={<KeyRound className="h-3 w-3" aria-hidden />}>Sealing</StatusChip>;
  if (w.status === 'bound') return <StatusChip tone="held" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Key bound · signing off</StatusChip>;
  if (w.status === 'revoked') return <StatusChip tone="bad" size="sm" icon={<Ban className="h-3 w-3" aria-hidden />}>Revoked</StatusChip>;
  if (w.interim) return w.status === 'active'
    ? <StatusChip tone="bad" size="sm">Signing off · hash chain only</StatusChip>
    : <StatusChip tone="neutral" size="sm">Interim · hash chain only</StatusChip>;
  if (w.status === 'active') return <StatusChip tone="ok" size="sm" icon={<KeyRound className="h-3 w-3" aria-hidden />}>Signing</StatusChip>;
  return <StatusChip tone="neutral" size="sm">Retired · verifies</StatusChip>;
}

/**
 * Key windows: when each key was published, when it signed, the overlap with its predecessor, revocations,
 * a successor bound ahead of signing, and whether key changes are allowed now (not while a chain incident is open).
 */
export function KeyWindowsPanel() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const canCustody = useCanDo('keys.custody');
  const { data: s, error, refetch } = useKeysState();
  const { data: custody } = useQuery((o) => api.custody(o), [], { kinds: ['key', 'level'] });
  const [bind, setBind] = useState(false);
  const [busy, setBusy] = useState<string>();
  const l1 = !atLeast(level, 'l2');

  if (error) return <Banner tone="bad" title="Key windows could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (!s) return <Skeleton className="h-64" />;

  const ws = s.windows;
  const now = Date.now();
  const t0 = Math.min(...ws.map((w) => new Date(w.publishedAt).getTime()), now - 30 * 864e5);
  const t1 = Math.max(now, ...ws.map((w) => (s.bound?.switchAt && w.kid === s.bound.kid ? new Date(s.bound.switchAt).getTime() : 0)));
  const pos = (iso?: string) => (iso ? ((new Date(iso).getTime() - t0) / Math.max(1, t1 - t0)) * 100 : 100);
  const planned = s.bound && s.bound.purpose === 'planned' ? s.bound : undefined;
  const dualBlock = level === 'l2' && planned && planned.boundBy === user?.id;

  const turnOn = async () => {
    if (!user) return;
    setBusy('on');
    try { const seq = await keysApi.signingOn(orgId, user.id); toast.ok('Signing switched to the successor', receiptNote(seq)); }
    catch (e) { toast.bad('Signing was not switched', errMsg(e)); }
    finally { setBusy(undefined); }
  };
  // L2 dual control: a successor one person published switches only after a different owner or admin confirms it
  const confirm = async () => {
    if (!user) return;
    setBusy('confirm');
    try { const seq = await keysApi.confirmSwitch(orgId, user.id); toast.ok('Switch confirmed', `The successor switches at the end of the overlap. ${receiptNote(seq)}`); }
    catch (e) { toast.bad('The switch was not confirmed', errMsg(e)); }
    finally { setBusy(undefined); }
  };
  const withdraw = async () => {
    if (!user) return;
    setBusy('withdraw');
    try { await keysApi.withdrawBound(orgId, user.id, 'Withdrawn before it signed'); toast.info('Bound key withdrawn', 'It is revoked and never signed. Recorded on the chain.'); }
    catch (e) { toast.bad('The key was not withdrawn', errMsg(e)); }
    finally { setBusy(undefined); }
  };

  return (
    <div className="space-y-4">
      {s.upgradeBound && (
        <Banner tone="held" title={<span className="inline-flex items-center gap-1.5"><Lock className="h-4 w-4" aria-hidden />Key bound · signing off: {s.upgradeBound.kid}</span>}
          actions={<SmartLink to="/assurance/upgrade" hideWhenBlocked className="text-sm font-medium link whitespace-nowrap">Open the upgrade</SmartLink>}>
          Created in AWS KMS for the move to L2 {relative(s.upgradeBound.at)} (<ReceiptLink seq={s.upgradeBound.seq} />), fingerprint <span className="font-mono">{s.upgradeBound.fingerprint}</span>{s.upgradeBound.compared ? ', compared out of band' : ', not yet compared out of band'}. It signs nothing until signing is turned on at the boundary; until then <span className="font-mono">{s.active?.kid}</span> seals the chain.
        </Banner>
      )}
      {planned && (
        <Banner tone="held" title={<span className="inline-flex items-center gap-1.5"><Lock className="h-4 w-4" aria-hidden />Key bound · signing off: {planned.kid}</span>}
          actions={canCustody && <>
            <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} loading={busy === 'withdraw'} onClick={withdraw}>Withdraw</Button>
            {s.awaitingSecond && <Button size="sm" variant="primary" icon={<CheckCircle2 className="h-4 w-4" />} loading={busy === 'confirm'} disabled={!!dualBlock} title={dualBlock ? 'You published this successor. A different owner or admin confirms the switch.' : s.chainIncident ? `${s.block} Confirming now is refused and recorded.` : undefined} onClick={confirm}>Confirm the switch</Button>}
            <Button size="sm" variant={s.awaitingSecond ? 'secondary' : 'primary'} icon={<Power className="h-4 w-4" />} loading={busy === 'on'} disabled={!!dualBlock} title={dualBlock ? 'You bound this key. A different owner or admin turns signing on.' : s.chainIncident ? `${s.block} Turning signing on now is refused and recorded.` : undefined} onClick={turnOn}>Turn signing on</Button>
          </>}>
          Fingerprint <span className="font-mono">{planned.fingerprint}</span>, bound by {userName(planned.boundBy)} {relative(planned.boundAt)} (<ReceiptLink seq={planned.seq} />). Its public key is published so verifiers can pin it during the overlap; <span className="font-mono">{s.active?.kid}</span> keeps signing{planned.switchAt ? ` until the switch, planned for ${dateTime(planned.switchAt)}${s.awaitingSecond ? '' : ', when signing moves to it on its own'}` : ''}.
          {s.awaitingSecond
            ? ' At L2 a KMS rotation needs two people: the switch happens only after a different owner or admin confirms it. Without that confirmation it waits.'
            : level === 'l2' && planned.confirmedBy ? ` Dual control: confirmed by ${userName(planned.confirmedBy)}.` : ''}
          {level === 'l2' ? ' A different owner or admin can turn signing on sooner.' : ''} Other key changes are refused while it is bound.
          {s.switchWaiting && <span className="block mt-1 text-bad-fg">The switch is due but waits: {s.switchWaiting}</span>}
        </Banner>
      )}

      <Panel title="Key windows" kicker={l1 ? 'Published · sealing · retired' : 'Published · signing · overlap · revoked'} flush
        actions={canCustody && !l1 && !planned && !s.compromise && <Button size="sm" variant="secondary" icon={<CalendarClock className="h-4 w-4" />} title={s.block ? `${s.block} Publishing one now is refused and recorded.` : undefined} onClick={() => setBind(true)}>Publish a successor</Button>}
        footer={l1
          ? 'At L1 a rotation takes effect at once: the new key seals from the rotation receipt and the old one is retired, with no overlap.'
          : `From L2 a successor is published ahead of signing (30 days by policy), so verifiers can pin it before it signs.${level === 'l2' ? ' At L2 two people are needed: a successor one owner or admin publishes switches only after a different one confirms it.' : ''} A revoked key signs nothing after its revocation; receipts it signed before still verify.`}>
        <div className="px-5 pt-4 pb-2" aria-hidden>
          <div className="relative h-4 text-[10px] text-muted">
            <span className="absolute left-0">{date(new Date(t0).toISOString())}</span>
            <span className="absolute right-0">{date(new Date(t1).toISOString())}</span>
          </div>
        </div>
        <ul className="divide-y divide-line">
          {ws.slice().reverse().map((w) => {
            const pubL = pos(w.publishedAt);
            const signL = w.signingFrom ? pos(w.signingFrom) : undefined;
            const signR = pos(w.signingUntil ?? (w.status === 'active' ? undefined : w.revokedAt));
            const boundEnd = w.status === 'bound' ? pos(planned?.kid === w.kid ? planned.switchAt : undefined) : undefined;
            return (
              <li key={w.kid} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-mono text-[12.5px]">{w.kid}</span>
                  <KeyStatusChip w={w} />
                  <span className="font-mono text-[12px] text-muted">{w.fingerprint}</span>
                  <span className="ml-auto text-xs text-muted num">{n(w.receiptsSigned)} {l1 || w.interim ? 'sealed' : 'signed'}</span>
                </div>
                <div className="relative mt-2 h-3 bg-sunken border border-line" role="img" aria-label={`Published ${date(w.publishedAt)}${w.signingFrom ? `, ${l1 || w.interim ? 'sealing' : 'signing'} from ${date(w.signingFrom)}` : ''}${w.signingUntil ? ` until ${date(w.signingUntil)}` : ''}`}>
                  {/* published, not yet signing: the overlap (or the whole bar for a bound key) */}
                  <span className="absolute inset-y-0 bg-held/40" style={{ left: `${pubL}%`, width: `${Math.max(0.6, (signL ?? boundEnd ?? 100) - pubL)}%` }} />
                  {signL !== undefined && <span className={`absolute inset-y-0 ${w.interim ? 'bg-bad/60' : w.status === 'revoked' ? 'bg-bad' : 'bg-fg'}`} style={{ left: `${signL}%`, width: `${Math.max(0.6, signR - signL)}%` }} />}
                  {w.revokedAt && <span className="absolute inset-y-[-3px] w-[2px] bg-bad" style={{ left: `${pos(w.revokedAt)}%` }} />}
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  Published {dateTime(w.publishedAt)}
                  {w.signingFrom ? <> · {w.interim ? 'sealing' : l1 ? 'sealing' : 'signing'} from {dateTime(w.signingFrom)}</> : ' · not signing yet'}
                  {w.signingUntil ? <> to {dateTime(w.signingUntil)}</> : w.signingFrom ? ' to now' : ''}
                  {w.overlapDays > 0 && <> · overlap {w.overlapDays} {w.overlapDays === 1 ? 'day' : 'days'}</>}
                  {w.revokedAt && <> · <span className="text-bad-fg">revoked {dateTime(w.revokedAt)}{w.revokedReason ? ` — ${w.revokedReason}` : ''}</span></>}
                </p>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-5 py-2.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 bg-held/40 border border-line" />Published, not signing (overlap)</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 bg-fg" />{l1 ? 'Sealing' : 'Signing'}</span>
          {(!l1 || ws.some((w) => w.interim)) && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 bg-bad/60" />Unsigned interval (hash chain only)</span>}
          {(!l1 || ws.some((w) => w.status === 'revoked')) && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-[2px] bg-bad" />Revoked</span>}
        </div>
      </Panel>

      <Panel title="Key changes" kicker={l1 ? 'Refused while a chain incident is open' : 'Refused while a chain incident, a compromise or a bound successor is open'}>
        {s.chainIncident ? (
          <Banner tone="bad" title={`Refused now · ${s.chainIncident.title}`}>{s.block} <SmartLink hideWhenBlocked className="link" to={`/incidents/${s.chainIncident.id}`}>Open the incident.</SmartLink></Banner>
        ) : s.compromise ? (
          <Banner tone="held" title="Only the compromise procedure may change keys now">{s.block}</Banner>
        ) : s.block ? (
          <Banner tone="held" title="Refused now · a successor is bound">{s.block}</Banner>
        ) : (
          <p className="text-sm">Allowed: no chain incident is open{l1 ? '' : ', no compromise is being handled and no successor is bound'}. {l1 ? 'A rotation' : 'A rotation, a successor, a ceremony or a level change'} would be refused, and the attempt recorded, while one is.</p>
        )}
        {s.block && canCustody && (
          <p className="mt-3 text-sm text-muted">The controls stay available: {l1 ? 'rotating the key' : 'a rotation, a ceremony or a level change'} tried now is refused and written to the chain as a receipt, listed below. <SmartLink className="link" to="/agents/keys?tab=custody">Custody</SmartLink></p>
        )}
        {s.refusals.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border border-line text-sm" aria-label="Refused key changes">
            {s.refusals.map((r) => (
              <li key={r.seq} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
                <span>{userName(r.by)} tried to {r.what}</span>
                {r.incident && <span className="text-xs text-muted font-mono">{r.incident}</span>}
                <span className="text-xs text-muted">{relative(r.at)}</span>
                <span className="ml-auto"><ReceiptLink seq={r.seq} /></span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-xs text-muted">No key change has been refused.</p>}
      </Panel>
      {bind && <BindKeyDialog open onClose={() => setBind(false)} purpose="planned" holders={custody?.holders ?? []} provider={custody?.provider ?? ''} />}
    </div>
  );
}
