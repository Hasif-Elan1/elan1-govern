import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, KeyRound, MessageSquareText, OctagonX, ScanLine } from 'lucide-react';
import { api } from '@/api';
import { useOrgId, useUser } from '@/store/session';
import { dateTime, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { Banner, Button, Field, Input, KeyValue, Skeleton, toast } from '@/components/ui';
import { groupFp, useCloseout } from './shared';

/**
 * Stage 1 of L1 → L2, as its own step: create the signing key in AWS KMS before the switch, then compare the
 * fingerprint KMS reports with the one elan1 sends by a separate channel. Only a match records the stage.
 */
export function KeyBindStage({ canAct, slug }: { canAct: boolean; slug: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const q = useCloseout();
  const v = q.data;
  const key = v?.key;
  const compared = !!key?.comparedSeq;
  const fid = useId();
  const [busy, setBusy] = useState<'create' | 'compare'>();
  const [typed, setTyped] = useState('');
  const [showMsg, setShowMsg] = useState(false);
  const [mismatch, setMismatch] = useState<string>();
  const norm = typed.toLowerCase().replace(/[^0-9a-f]/g, '');

  const create = async () => {
    if (!user) return;
    setBusy('create');
    setMismatch(undefined);
    try {
      const r = await api.createUpgradeKey(orgId, user.id);
      setTyped('');
      setShowMsg(false);
      toast.ok('Key created in AWS KMS', `${r.kid} · receipt ${seqLabel(r.seq)}. elan1 sent its fingerprint by ${r.channel.toLowerCase()} to ${r.to}.`);
    } catch (e) { toast.bad('The key could not be created', (e as Error).message); } finally { setBusy(undefined); }
  };

  const compare = async () => {
    if (!user) return;
    setBusy('compare');
    try {
      const r = await api.compareUpgradeFingerprint(orgId, user.id, typed);
      if (r.match) { setMismatch(undefined); toast.ok('The fingerprints match', `The key stage is recorded as ${seqLabel(r.seq)}.`); }
      else { setMismatch(norm); toast.bad('The fingerprints do not match', `Recorded as ${seqLabel(r.seq)}. Do not use this key.`); }
    } catch (e) { toast.bad('The comparison could not be recorded', (e as Error).message); } finally { setBusy(undefined); }
  };

  if (q.error) return <Banner tone="bad" title="The key could not be loaded" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>;
  if (!v) return <Skeleton className="h-48" />;

  return (
    <div className="space-y-5">
      <ol className="grid gap-px bg-line border border-line sm:grid-cols-3 text-sm" aria-label="Key binding steps">
        {[
          { t: 'Create the key in AWS KMS', done: !!key },
          { t: 'Receive the fingerprint out of band', done: !!key },
          { t: 'Compare, and record the match', done: compared },
        ].map((s, i) => (
          <li key={s.t} className="bg-surface p-3 flex items-start gap-2">
            <span className={s.done ? 'inline-flex h-5 w-5 shrink-0 items-center justify-center bg-ok-bg text-ok-fg border border-ok/40' : 'inline-flex h-5 w-5 shrink-0 items-center justify-center border border-line-strong font-mono text-[11px] text-muted'}>
              {s.done ? <CheckCircle2 className="h-3.5 w-3.5" aria-label="Done" /> : i + 1}
            </span>
            <span>{s.t}</span>
          </li>
        ))}
      </ol>

      {/* 1 · the key */}
      <div>
        <p className="label mb-2">The key</p>
        <KeyValue items={[
          { k: 'Service', v: 'AWS KMS' },
          { k: 'Residency domain', v: 'ap-south-1 (Mumbai)' },
          { k: 'Key alias', v: <span className="font-mono text-[12.5px] break-all">{key?.alias ?? `alias/elan1/${slug}/signing`}</span> },
          { k: 'Algorithm', v: 'Ed25519 (ECC_NIST_EDWARDS25519)' },
          ...(key ? [
            { k: 'Key id', v: <span className="font-mono text-[12.5px]">{key.kid}</span> },
            { k: 'Key ARN', v: <span className="font-mono text-[12px] break-all">{key.keyRef}</span> },
            { k: 'Fingerprint KMS reports', v: <span className="font-mono text-[15px] tracking-wider font-semibold">{groupFp(key.fingerprint)}</span> },
            { k: 'Created', v: <span>{userName(key.createdBy)} · {dateTime(key.createdAt)} · <Link className="link font-mono" to={`/activity/${key.createdSeq}`}>{seqLabel(key.createdSeq)}</Link>{key.replaced ? ` · replaced ${key.replaced} earlier key${key.replaced === 1 ? '' : 's'}` : ''}</span> },
          ] : [
            { k: 'When it signs', v: 'From the record named on the confirm screen. Nothing is signed with it before the switch.' },
          ]),
        ]} />
        {/* owners and admins bind the key: other roles see the key, not the controls */}
        {!compared && canAct && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant={key ? 'secondary' : 'primary'} icon={<KeyRound className="h-4 w-4" />} loading={busy === 'create'} onClick={create}>
              {key ? 'Create a new key instead' : 'Create the key in AWS KMS'}
            </Button>
            {key && <span className="text-xs text-muted">A new key replaces this one before anything is signed; the replacement is recorded.</span>}
          </div>
        )}
      </div>

      {/* 2 · the out-of-band message */}
      {key && v.outOfBand && (
        <div className="border border-line">
          <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 bg-sunken/50">
            <p className="text-sm inline-flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-muted" aria-hidden />elan1 sent the fingerprint by {v.outOfBand.channel === 'SMS' ? 'SMS' : 'email'} to {v.outOfBand.to} · {dateTime(v.outOfBand.sentAt)}</p>
            {canAct && <Button size="sm" variant="ghost" onClick={() => setShowMsg((x) => !x)} aria-expanded={showMsg}>{showMsg ? 'Hide the message' : 'Show the message (demo)'}</Button>}
          </div>
          {showMsg && (
            <div className="px-4 py-3 border-t border-line">
              <p className="text-xs text-muted mb-1">In a real upgrade this arrives on the phone or mailbox above, never on this screen.</p>
              <p className="font-mono text-[13px] leading-relaxed">elan1: the fingerprint of the new signing key for {v.orgName} is {groupFp(key.fingerprint)}. Compare it in the console. Do not reply with it.</p>
            </div>
          )}
        </div>
      )}

      {/* 3 · compare */}
      {key && !compared && canAct && (
        <div>
          <Field label="Fingerprint you received out of band" htmlFor={fid} hint="16 characters; spaces do not matter." error={typed && norm.length !== 16 ? `${norm.length} of 16 characters` : undefined}>
            <Input id={fid} mono value={typed} onChange={(e) => { setTyped(e.target.value); setMismatch(undefined); }} placeholder="0000 0000 0000 0000" autoComplete="off" />
          </Field>
          {mismatch && (
            <Banner tone="bad" className="mt-3" title="They do not match">
              <span className="block">Received <span className="font-mono">{groupFp(mismatch)}</span>; KMS reports <span className="font-mono">{groupFp(key.fingerprint)}</span>. The mismatch is recorded. Check the message again, or create a new key.</span>
            </Banner>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<ScanLine className="h-4 w-4" />} loading={busy === 'compare'} disabled={norm.length !== 16} onClick={compare}>Compare and record</Button>
            {key.mismatches > 0 && <span className="text-xs text-bad-fg inline-flex items-center gap-1"><OctagonX className="h-3.5 w-3.5" aria-hidden />{key.mismatches} mismatch{key.mismatches === 1 ? '' : 'es'} recorded for this key</span>}
          </div>
        </div>
      )}
      {compared && key && (
        <Banner tone="ok" title={`Bound: ${key.kid}`}>
          Fingerprint <span className="font-mono">{groupFp(key.fingerprint)}</span> compared by {userName(key.comparedBy ?? '')} {key.comparedAt ? dateTime(key.comparedAt) : ''}{key.channel ? ` against the ${key.channel}` : ''}. It signs from the record named on the confirm screen. To use a different key, cancel this upgrade and start again.
        </Banner>
      )}
    </div>
  );
}
