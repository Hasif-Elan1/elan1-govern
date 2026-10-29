import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, KeyRound, RotateCw, ShieldCheck, Users } from 'lucide-react';
import { SmartLink } from '@/shell/access';
import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { useCanDo } from '@/features/settings/permissions';
import { atLeast, levelAt } from '@/lib/levels';
import { date, dateTime, n, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import type { KeyCeremony, LevelId, SigningKey } from '@/types';
import { Banner, Button, Checkbox, CopyButton, DataTable, Dialog, Field, KeyValue, Panel, Skeleton, StatusChip, Textarea, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { CUSTODY_LABEL, UpgradeCallout, custodyOfKey } from './levelGate';
import { compromisePhase, keysApi } from '@/mock/keys';
// the one reading of the open L2 rotation request, shared with the backend: requested and not yet approved, rotated or withdrawn
import { pendingRotationRequest } from '@/mock/platform';
import { KeyStatusChip } from '@/features/keys/KeyWindows';
import { PHASE_LABEL } from '@/features/keys/Compromise';
import { useKeysState } from '@/features/keys/useKeys';
import { KeyChangeRefusalNote } from '@/features/keys/RefusalNote';

export function KeysCustody({ level, signingKeys, loading }: { level: LevelId; signingKeys?: SigningKey[]; loading: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  // one gate on every screen and in the backend: owners and admins manage key custody (keys.custody), read against the member role here
  const ownerOrAdmin = useCanDo('keys.custody');
  const canRotateL1 = ownerOrAdmin;
  const { data: custody, loading: cLoading, error, refetch } = useQuery((o) => api.custody(o), [level], { kinds: ['key', 'level', 'receipt'] });
  const history = db.getDB(orgId).org.levelHistory;
  const [rotateOpen, setRotateOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: ks } = useKeysState();
  const pending = useMemo(() => (level === 'l2' ? pendingRotationRequest(db.getDB(orgId)) : undefined), [orgId, level, custody, signingKeys, ks]);
  // a planned successor bound and waiting to sign (after an approved KMS rotation, a ceremony or "Publish a successor")
  const successor = ks?.bound?.purpose === 'planned' && !ks.compromise ? ks.bound : undefined;
  // no key change while a chain incident (or a key compromise) is open
  const block = ks?.block;
  const l3 = atLeast(level, 'l3');
  // the custody view reads rotations from receipts in this window; fall back to the newest retirement or ceremony
  const lastRotated = custody?.rotation.lastRotatedAt
    ?? [...(signingKeys ?? []).map((k) => k.retiredAt), ...(custody?.ceremonies ?? []).filter((c) => c.kind === 'rotation').map((c) => c.at)].filter((x): x is string => !!x).sort().pop();

  const keyColumns: Column<SigningKey>[] = [
    { key: 'kid', header: 'Key id', cell: (k) => <span className="font-mono text-[12.5px]">{k.kid}</span> },
    { key: 'fp', header: 'Fingerprint', cell: (k) => <span className="inline-flex items-center gap-1 font-mono text-[12px]">{k.fingerprint}<CopyButton text={k.fingerprint} compact label="Copy fingerprint" /></span>, hideBelow: 'sm' },
    { key: 'custody', header: 'Custody', cell: (k) => <span className="text-sm">{custodyOfKey(k.kid, levelAt(history, new Date(k.createdAt).getTime(), 'l1'), !!k.interim)}</span>, hideBelow: 'md' },
    { key: 'status', header: 'Status', cell: (k) => <KeyStatusChip w={{ status: k.status, interim: !!k.interim }} /> },
    { key: 'created', header: 'Created', cell: (k) => <span className="text-sm">{date(k.createdAt)}</span>, hideBelow: 'lg' },
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
    { key: 'signed', header: level === 'l1' ? 'Receipts sealed' : 'Receipts signed', align: 'right', cell: (k) => n(k.receiptsSigned), sort: (k) => k.receiptsSigned },
  ];

  const approveRotation = async () => {
    if (!user || !pending) return;
    setBusy(true);
    try {
      // the approval receipt is written only after KMS has rotated the key: a failed rotation leaves no approval behind
      const { ceremony: c } = await keysApi.approveKmsRotation(orgId, user.id);
      toast.ok('Successor key bound in AWS KMS', <>New key <span className="font-mono">{c.kidAfter}</span> is published as the successor. <span className="font-mono">{c.kidBefore ?? 'The current key'}</span> keeps signing until the switch{c.switchAt ? ` on ${dateTime(c.switchAt)}` : ''}, after the 30-day overlap. Requested by {userName(pending.actor)}, approved by you.</>);
    } catch (e) { toast.bad('The key was not rotated', (e as Error).message); }
    finally { setBusy(false); }
  };
  const withdraw = async () => {
    if (!user || !pending) return;
    // checked again in the backend: only a request still waiting can be withdrawn, and only by the person who asked
    try {
      const r = await keysApi.withdrawKmsRotation(orgId, user.id);
      toast.info('Rotation request withdrawn', `Recorded as ${seqLabel(r.seq)}.`);
    } catch (e) { toast.bad('The request was not withdrawn', (e as Error).message); }
  };

  // key changes are for owners and admins (keys.custody): viewers and auditors see the keys, not the buttons
  const action = !ownerOrAdmin ? undefined : level === 'l1' ? (
    canRotateL1 && <Button size="sm" variant="secondary" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => setRotateOpen(true)} title={block ? `${block} Rotating now is refused and recorded.` : undefined}>Rotate key</Button>
  ) : level === 'l2' ? (
    // not while a request waits for its second person, nor while its successor is bound and waiting to sign
    !pending && !successor && <Button size="sm" variant="secondary" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => setRequestOpen(true)} title={block ? `${block} Asking now is refused and recorded.` : undefined}>Request a KMS rotation</Button>
  ) : (
    <Button size="sm" variant="secondary" icon={<Users className="h-3.5 w-3.5" />} onClick={() => setCeremonyOpen(true)} disabled={!custody} title={block ? `${block} Running one now is refused and recorded.` : undefined}>Run a key ceremony</Button>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-6">
        {ks?.compromise && (
          <Banner tone="bad" title={`Key ${ks.compromise.kid} declared compromised · ${PHASE_LABEL[compromisePhase(ks.compromise)]}`}
            actions={<SmartLink hideWhenBlocked to="/agents/keys?tab=custody" className="text-sm font-medium link whitespace-nowrap">Handle it in Keys</SmartLink>}>
            Records from <ReceiptLink seq={ks.compromise.unsignedFrom} /> are hash-chained but not signed until a new key signs. Notice to {ks.compromise.contact.name} {ks.compromise.notice ? 'sent' : `due by ${dateTime(ks.compromise.noticeDueAt)}`}.
          </Banner>
        )}
        {ks?.block && !ks.compromise && (!successor || ks.chainIncident) && <Banner tone="held" title="Key changes are refused">{ks.block} Trying one now is refused and written to the chain.</Banner>}
        {successor && (
          <Banner tone="held" title={`Successor ${successor.kid} published · signing off`}
            actions={<SmartLink hideWhenBlocked to="/agents/keys?tab=signing" className="text-sm font-medium link whitespace-nowrap">Open the key windows</SmartLink>}>
            Bound by {userName(successor.boundBy)} {dateTime(successor.boundAt)} (<ReceiptLink seq={successor.seq} />), fingerprint <span className="font-mono">{successor.fingerprint}</span>. Its public key is published so verifiers can pin it; <span className="font-mono">{ks?.active?.kid ?? 'the current key'}</span> keeps signing until the switch{successor.switchAt ? ` on ${dateTime(successor.switchAt)}` : ''}, at the end of the overlap.
            {level === 'l2' && (ks?.awaitingSecond
              ? ' A KMS rotation needs two people: a different owner or admin confirms the switch in the key windows, or it does not happen.'
              : successor.confirmedBy ? ` Dual control: ${userName(successor.confirmedBy)} and ${userName(successor.boundBy)}.` : '')}
            {' '}A new rotation can be asked for once it signs.
            {ks?.switchWaiting && <span className="block mt-1 text-bad-fg">The switch is due but waits: {ks.switchWaiting}</span>}
          </Banner>
        )}
        {pending && (
          <Banner tone="held" title={`Rotation requested by ${userName(pending.actor)} · waiting for a second person`}
            actions={<>
              {user?.id === pending.actor
                ? <Button size="sm" variant="ghost" onClick={withdraw}>Withdraw</Button>
                : ownerOrAdmin && <Button size="sm" variant="primary" loading={busy} title={block ? `${block} Approving now is refused and recorded.` : undefined} onClick={approveRotation}>Approve and rotate</Button>}
            </>}>
            {String(pending.details?.reason ?? '')} Requested {dateTime(pending.ts)} (<ReceiptLink seq={pending.seq} />). Dual control: an owner or admin other than the requester approves, then AWS KMS creates the new key.
          </Banner>
        )}
        <Panel title="Signing keys" kicker="Ed25519 · one signing key at a time" actions={action} flush
          footer={level === 'l1' ? 'Every rotation is itself a receipt in the hash chain. Old receipts keep verifying with the key that sealed them.' : level === 'l2' ? 'Rotation in AWS KMS needs two people: one requests, another approves. Each step is a receipt.' : 'Rotation is a key ceremony in your HSM with a quorum of key holders. Each ceremony is a receipt.'}>
          <DataTable caption="Signing keys" className="border-0" columns={keyColumns} rows={signingKeys?.slice().reverse()} loading={loading} rowKey={(k) => k.kid} />
        </Panel>
        <CeremonyList ceremonies={custody?.ceremonies} loading={cLoading && !custody} />
      </div>
      <div className="lg:col-span-5 space-y-6">
        {error && <Banner tone="bad" title="Key custody could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
        <Panel title="Key custody" kicker={custody ? CUSTODY_LABEL[custody.mode] : 'Where the signing key lives'}>
          {!custody ? (cLoading ? <Skeleton className="h-56" /> : <p className="text-sm text-muted">Custody details are not available.</p>) : (
            <>
              <div className="flex flex-wrap gap-1.5 mb-3">
                <StatusChip tone={custody.heldBy === 'customer' ? 'ok' : 'neutral'} size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>{custody.heldBy === 'customer' ? 'Held by you' : 'Held by elan1'}</StatusChip>
              </div>
              <KeyValue items={[
                { k: 'Provider', v: custody.provider },
                { k: 'Location', v: custody.location },
                { k: 'Residency', v: custody.residencyDomain },
                { k: 'Key reference', v: <span className="break-all">{custody.keyRef}</span>, mono: true },
                ...(custody.alias ? [{ k: 'Alias', v: custody.alias, mono: true }] : []),
                { k: custody.signingOff ? (custody.signingOff.ownKeyStatus === 'bound' ? 'Your key (bound, signing off)' : 'Your key (revoked)') : level === 'l1' ? 'Sealing key' : 'Signing key', v: <>{custody.kid} · {custody.fingerprint}</>, mono: true },
                ...(custody.signingOff ? [{ k: 'Sealing now', v: <>Elan1 Govern’s interim chain key {custody.signingOff.interimKid} · hash chain only, not your key</> }] : []),
                { k: 'Rotation', v: custody.rotation.policy },
                { k: 'Last rotated', v: lastRotated ? dateTime(lastRotated) : 'Not yet' },
                ...(custody.rotation.nextDueAt ? [{ k: 'Next due', v: date(custody.rotation.nextDueAt) }] : []),
                ...(custody.quorum ? [{ k: 'Quorum', v: `${custody.quorum.required} of ${custody.quorum.of} key holders` }] : []),
              ]} />
              {custody.holders && custody.holders.length > 0 && (
                <div className="mt-4">
                  <p className="label mb-2">Key holders</p>
                  <ul className="text-sm space-y-1">{custody.holders.map((h) => <li key={h.name} className="flex justify-between gap-3"><span>{h.name}</span><span className="text-muted text-xs">{h.role}</span></li>)}</ul>
                </div>
              )}
              <p className="mt-4 text-sm text-muted leading-relaxed">{custody.note}</p>
            </>
          )}
        </Panel>
        {level === 'l1' && <UpgradeCallout orgId={orgId} to="l2" caps={['kms_custody', 'rfc3161_anchors', 'seal_v6']}>At L1 the signing key is held by Elan1 Govern. From L2 it lives in AWS KMS in ap-south-1 and a rotation needs two people; from L3 it lives in your own HSM.</UpgradeCallout>}
        {level === 'l2' && <UpgradeCallout orgId={orgId} to="l3" caps={['customer_held_keys', 'cross_org_verification', 'selective_disclosure']}>From L3 the signing key is generated in your own HSM — AWS CloudHSM, Thales Luna or Entrust nShield — in a key ceremony with a 3 of 5 quorum. Elan1 Govern can then ask it to sign but can never sign without it.</UpgradeCallout>}
      </div>

      <RotateKeyDialog open={rotateOpen} onClose={() => setRotateOpen(false)} current={signingKeys?.find((k) => k.status === 'active')} userId={user?.id} />
      <RequestRotationDialog open={requestOpen} onClose={() => setRequestOpen(false)} alias={custody?.alias} />
      {l3 && custody && <CeremonyDialog open={ceremonyOpen} onClose={() => setCeremonyOpen(false)} holders={custody.holders ?? []} required={custody.quorum?.required ?? 3} provider={custody.provider} />}
    </div>
  );
}

function CeremonyList({ ceremonies, loading }: { ceremonies?: KeyCeremony[]; loading: boolean }) {
  return (
    <Panel title="Key ceremonies and rotations" kicker="From the chain" flush>
      {loading ? <div className="p-5"><Skeleton className="h-24" /></div> : !ceremonies?.length ? (
        <p className="px-5 py-6 text-sm text-muted">No ceremony recorded yet. The first one is recorded when the key moves into managed custody or is rotated.</p>
      ) : (
        <ul className="divide-y divide-line">
          {ceremonies.slice(0, 12).map((c) => (
            <li key={c.id} className="px-5 py-3">
              <details>
                <summary className="flex flex-wrap items-center justify-between gap-2 cursor-pointer list-none">
                  <span className="min-w-0">
                    <span className="font-medium">{c.kind === 'generation' ? 'Key generated' : c.kind === 'rotation' ? 'Key rotated' : 'Quorum checked'}</span>
                    <span className="text-xs text-muted"> · {dateTime(c.at)} · {c.quorum}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {c.seq !== undefined && <ReceiptLink seq={c.seq} />}
                    {c.outcome === 'completed' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Completed</StatusChip> : <StatusChip tone="held" size="sm">Aborted</StatusChip>}
                  </span>
                </summary>
                <div className="mt-2 text-sm space-y-1.5">
                  <p className="text-muted">Present: {c.participants.map((p) => `${p.name} (${p.role})`).join(', ')}</p>
                  {(c.kidBefore || c.kidAfter) && <p className="font-mono text-[12px]">{c.kidBefore ?? '—'} → {c.kidAfter ?? '—'}</p>}
                  <ol className="border-l border-line pl-3 space-y-1">{c.log.map((l, i) => <li key={i} className="text-xs text-muted"><Clock3 className="inline h-3 w-3 mr-1" aria-hidden />{l.text}</li>)}</ol>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RotateKeyDialog({ open, onClose, current, userId }: { open: boolean; onClose: () => void; current?: SigningKey; userId?: string }) {
  const orgId = useOrgId();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setAck(false); }, [open]);
  const go = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      await api.rotateKey(orgId, userId);
      const fp = db.getDB(orgId).org.keyFingerprint;
      toast.ok('Signing key rotated', <>New fingerprint <span className="font-mono">{fp}</span>. Publish it out of band.</>);
      onClose();
    } catch (e) { toast.bad('The key could not be rotated', (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Rotate the signing key"
      // This dialog is L1 only: L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
      description="A new Ed25519 key seals every receipt from now on. The current key is retired, not deleted."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<RotateCw className="h-4 w-4" />} disabled={!ack || !userId} title={!ack ? 'Confirm you will publish the new fingerprint.' : undefined} loading={busy} onClick={go}>Rotate key</Button></>}>
      <div className="space-y-4 text-sm">
        <ul className="space-y-2 list-disc pl-5 text-muted leading-relaxed">
          <li><span className="text-fg font-medium">Old receipts still verify.</span> Each receipt names its key id, and retired public keys stay in every pack.</li>
          <li>A receipt sealed by <span className="font-mono">{current?.kid ?? 'the old key'}</span> after this moment would fail “key valid when sealed”.</li>
          <li>The rotation is recorded as an admin receipt in the hash chain, sealed by the outgoing key.</li>
          <li>The organisation fingerprint changes. Auditors comparing fingerprints need the new one.</li>
        </ul>
        <Checkbox checked={ack} onChange={setAck} label="I will publish the new fingerprint out of band" description="Website, engagement letter or wherever auditors look for it." />
        <KeyChangeRefusalNote />
      </div>
    </Dialog>
  );
}

function RequestRotationDialog({ open, onClose, alias }: { open: boolean; onClose: () => void; alias?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const go = async () => {
    if (!user || reason.trim().length < 8) return;
    try {
      const r = await keysApi.requestKmsRotation(orgId, user.id, reason, alias);
      toast.held('Rotation requested', <>Recorded as {seqLabel(r.seq)}. An owner or admin other than you approves it.</>);
      onClose();
    } catch (e) { toast.bad('The rotation was not requested', (e as Error).message); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Request a KMS rotation"
      description="When a different owner or admin approves, AWS KMS creates a new Ed25519 key and publishes it as the successor. The current key keeps signing through the 30-day overlap, then signing switches to the new key. The old key stays published, so everything it signed still verifies."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 8} title={reason.trim().length < 8 ? 'Give a reason of a few words.' : undefined} onClick={go}>Request rotation</Button></>}>
      <Field label="Reason" htmlFor="rot-reason" required hint="Recorded on the chain with the request, e.g. “Yearly rotation” or “Operator change”.">
        <Textarea id="rot-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <KeyChangeRefusalNote className="mt-4" />
    </Dialog>
  );
}

function CeremonyDialog({ open, onClose, holders, required, provider }: { open: boolean; onClose: () => void; holders: { name: string; role: string }[]; required: number; provider: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const [present, setPresent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<KeyCeremony>();
  useEffect(() => { if (open) { setPresent([]); setDone(undefined); } }, [open]);
  const enough = present.length >= required;
  const go = async () => {
    if (!user || !enough) return;
    setBusy(true);
    try {
      const c = await api.runKeyCeremony(orgId, user.id, present);
      setDone(c);
      toast.ok('Key ceremony completed', <>New key <span className="font-mono">{c.kidAfter}</span> generated in {provider} and published ahead; it signs after the overlap (Agents › Keys).</>);
    } catch (e) { toast.bad('The ceremony did not complete', (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="md" title={done ? 'Key ceremony completed' : 'Run a key ceremony'}
      description={done ? undefined : `A new signing key is generated inside ${provider}. At least ${required} of ${holders.length} key holders must be present; the key never leaves the HSM.`}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={busy} disabled={!enough} title={!enough ? `Mark at least ${required} key holders present.` : undefined} onClick={go}>Generate the new key</Button></>}>
      {done ? (
        <div className="space-y-3 text-sm">
          <KeyValue items={[
            { k: 'Quorum', v: done.quorum },
            { k: 'Old key', v: done.kidBefore ?? '—', mono: true },
            { k: 'New key', v: done.kidAfter ?? '—', mono: true },
            ...(done.seq !== undefined ? [{ k: 'Recorded as', v: <ReceiptLink seq={done.seq} /> }] : []),
          ]} />
          <ol className="border-l border-line pl-3 space-y-1">{done.log.map((l, i) => <li key={i} className="text-xs text-muted">{l.text}</li>)}</ol>
          <p className="text-muted">Publish the new fingerprint out of band. Old receipts keep verifying with the key that signed them.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="label">Key holders present <span className="num">({present.length} of {required} needed)</span></p>
          {holders.map((h) => (
            <Checkbox key={h.name} checked={present.includes(h.name)} onChange={(v) => setPresent((p) => (v ? [...p, h.name] : p.filter((x) => x !== h.name)))} label={h.name} description={h.role} />
          ))}
          {!holders.length && <p className="text-sm text-muted">No key holders are registered for this HSM.</p>}
          <KeyChangeRefusalNote />
        </div>
      )}
    </Dialog>
  );
}
