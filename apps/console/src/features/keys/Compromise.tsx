import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertOctagon, CheckCircle2, Circle, KeyRound, Mail, Power, ShieldAlert, UserRound } from 'lucide-react';
import { api } from '@/api';
import { useQuery, useNow } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { countdown, dateTime, plural, relative, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { compromisePhase, keysApi, noticeText, type KeyCompromise } from '@/mock/keys';
import { pushMail } from '@/features/auth/registry';
import { useCanDo } from '@/features/settings/permissions';
import { receiptNote } from '@/features/settings/shared';
import { PlanUpsell } from '@/shell/access';
import { Badge, Banner, Button, Checkbox, Dialog, Field, Input, Panel, Select, Skeleton, StatusChip, Textarea, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { errMsg, useKeysState } from './useKeys';
import { KeyChangeRefusalNote } from './RefusalNote';

export const PHASE_LABEL: Record<ReturnType<typeof compromisePhase>, string> = {
  signing_off: 'Signing off',
  key_bound: 'Key bound · signing off',
  signing_on: 'Signing on · to close',
  closed: 'Closed',
};

/**
 * The key-compromise procedure (L2+): declare → signing stops and records keep being written unsigned → notice to the
 * named contact within 24 hours → bind a new key ("Key bound · signing off") → turn signing on → close.
 */
export function KeyCompromisePanel() {
  const level = useOrgLevel();
  const user = useUser();
  const canCustody = useCanDo('keys.custody');
  const { data: s, error, refetch } = useKeysState();
  const { data: custody } = useQuery((o) => api.custody(o), [], { kinds: ['key', 'level'] });
  const now = useNow(30_000);
  const [declare, setDeclare] = useState(false);
  const [notice, setNotice] = useState(false);
  const [bind, setBind] = useState(false);
  const [close, setClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const orgId = useOrgId();

  // the recorded compromise procedure is part of L2: below it owners see one line, everyone else nothing
  if (!atLeast(level, 'l2')) return <PlanUpsell to="l2" what="A recorded key-compromise procedure starts at L2 Attested." />;
  if (error) return <Banner tone="bad" title="Key state could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (!s) return <Skeleton className="h-48" />;
  const c = s.compromise;

  const turnOn = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const seq = await keysApi.signingOn(orgId, user.id);
      toast.ok('Signing is on', `Receipts are signed with the new key from here. ${receiptNote(seq)}`);
    } catch (e) { toast.bad('Signing was not turned on', errMsg(e)); }
    finally { setBusy(false); }
  };

  if (!c) {
    return (
      <>
        <Panel title="Key compromise" kicker="Procedure"
          actions={canCustody ? <Button size="sm" variant="danger" icon={<ShieldAlert className="h-4 w-4" />} disabled={!s.contact} title={!s.contact ? 'Name a contact for key notices first.' : undefined} onClick={() => setDeclare(true)}>Declare a key compromise</Button> : undefined}>
          <ol className="grid gap-3 sm:grid-cols-5 text-sm">
            {[
              ['Stop signing', 'The key is revoked at once. Records keep being written and linked into the hash chain, unsigned.'],
              ['Tell the named contact', `Within 24 hours, to ${s.contact ? s.contact.name : 'the named contact'}.`],
              ['Bind a new key', atLeast(level, 'l3') ? 'Generated in your HSM with 3 of 5 key holders. Key bound · signing off.' : 'Created in AWS KMS. Key bound · signing off.'],
              ['Turn signing on', level === 'l2' ? 'A second owner or admin turns signing on (dual control).' : 'An owner or admin turns signing on.'],
              ['Close', 'The closing receipt records the unsigned interval.'],
            ].map(([t, b], i) => (
              <li key={t} className="border border-line p-3">
                <p className="label">Step {i + 1}</p>
                <p className="mt-1 font-medium">{t}</p>
                <p className="mt-1 text-xs text-muted leading-relaxed">{b}</p>
              </li>
            ))}
          </ol>
          {s.pastCompromises.length > 0 && (
            <div className="mt-5">
              <p className="label mb-2">Closed</p>
              <ul className="divide-y divide-line border border-line text-sm">
                {s.pastCompromises.map((p) => (
                  <li key={p.id} className="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-[12.5px]">{p.kid}</span>
                    <span className="text-muted">declared {dateTime(p.declaredAt)}</span>
                    <span>unsigned <span className="font-mono">{seqLabel(p.unsignedFrom)}–{seqLabel(p.unsignedTo ?? p.unsignedFrom)}</span></span>
                    <span className="ml-auto text-xs text-muted">notice {p.notice?.late ? 'late' : 'within 24 h'} · closed <ReceiptLink seq={p.closed?.seq} /></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
        <DeclareCompromiseDialog open={declare} onClose={() => setDeclare(false)} />
      </>
    );
  }

  const phase = compromisePhase(c);
  const due = new Date(c.noticeDueAt).getTime();
  const overdue = !c.notice && now > due;
  const bound = s.bound && s.bound.compromiseId === c.id ? s.bound : undefined;
  const l2DualBlock = level === 'l2' && bound && bound.boundBy === user?.id;

  return (
    <div className="space-y-4">
      <Banner tone="bad" title={<span className="inline-flex items-center gap-2"><AlertOctagon className="h-4 w-4" aria-hidden />Key {c.kid} declared compromised · {PHASE_LABEL[phase]}</span>}>
        {c.reason} Declared by {userName(c.declaredBy)} {relative(c.declaredAt)} (<ReceiptLink seq={c.declSeq} />). Records from <Link to={`/activity/${c.unsignedFrom}`} className="font-mono link">{seqLabel(c.unsignedFrom)}</Link> are hash-chained but not signed{c.unsignedTo ? <> up to <Link to={`/activity/${c.unsignedTo}`} className="font-mono link">{seqLabel(c.unsignedTo)}</Link></> : ' until a new key signs'}.
      </Banner>
      <Panel title="Key compromise" kicker={`Opened ${dateTime(c.declaredAt)}`} actions={<StatusChip tone={phase === 'signing_on' ? 'held' : 'bad'} size="sm">{PHASE_LABEL[phase]}</StatusChip>}>
        <ol className="space-y-0">
          <Step done title="Signing stopped" detail={<>Key <span className="font-mono">{c.kid}</span> ({c.fingerprint}) is revoked and signs nothing more. Elan1 Govern’s interim chain key <span className="font-mono">{c.interimKid}</span> keeps each record linked into the hash chain.</>} seq={c.unsignedFrom} />
          <Step done={!!c.notice} bad={overdue} title={`Notice to ${c.contact.name} within 24 hours`}
            detail={c.notice
              ? <>Sent to {c.notice.to}{c.notice.cc ? ` (copy to ${c.notice.cc})` : ''} by {userName(c.notice.by)} {relative(c.notice.at)}{c.notice.late ? ' — after the 24-hour limit' : ''}.</>
              : overdue ? <>The 24 hours ran out {relative(c.noticeDueAt)}. Send it now; the receipt records that it was late.</> : <>Due by {dateTime(c.noticeDueAt)} · {countdown(c.noticeDueAt, now)} left. {c.contact.email}.</>}
            seq={c.notice?.seq}
            action={canCustody && !c.notice && <Button size="sm" variant={overdue ? 'danger' : 'primary'} icon={<Mail className="h-4 w-4" />} onClick={() => setNotice(true)}>Send the notice</Button>} />
          <Step done={!!c.successor} title={c.successor && !c.signingOn ? 'Key bound · signing off' : 'Bind a new key'}
            detail={c.successor
              ? <>New key <span className="font-mono">{c.successor.kid}</span> · fingerprint <span className="font-mono">{c.successor.fingerprint}</span>, bound by {userName(c.successor.boundBy)} {relative(c.successor.boundAt)}{c.successor.holders?.length ? ` with ${c.successor.holders.length} key holders present` : ''}. Its public key is published; it signs nothing until signing is turned on.</>
              : <>{atLeast(level, 'l3') ? `Generated in ${custody?.provider ?? 'your HSM'} with 3 of 5 key holders present.` : 'AWS KMS creates a new Ed25519 key in ap-south-1.'} The key is bound and published first; signing stays off.</>}
            seq={c.successor?.seq}
            action={canCustody && !c.successor && <Button size="sm" variant="primary" icon={<KeyRound className="h-4 w-4" />} title={s.chainIncident ? `${s.block} Binding now is refused and recorded.` : undefined} onClick={() => setBind(true)}>Bind a new key</Button>} />
          <Step done={!!c.signingOn} title="Turn signing on"
            detail={c.signingOn
              ? <>Turned on by {userName(c.signingOn.by)} {relative(c.signingOn.at)}. Receipts after <span className="font-mono">{seqLabel(c.unsignedTo ?? c.signingOn.seq)}</span> are signed with <span className="font-mono">{c.successor?.kid}</span>.</>
              : <>{level === 'l2' ? 'A different owner or admin from the one who bound the key turns signing on (dual control).' : 'An owner or admin turns signing on.'} The unsigned interval ends here.</>}
            seq={c.signingOn?.seq}
            action={canCustody && !c.signingOn && c.successor && <Button size="sm" variant="primary" icon={<Power className="h-4 w-4" />} loading={busy} disabled={!!l2DualBlock} title={l2DualBlock ? 'You bound this key. A different owner or admin turns signing on.' : s.chainIncident ? `${s.block} Turning signing on now is refused and recorded.` : undefined} onClick={turnOn}>Turn signing on</Button>} />
          <Step done={!!c.closed} last title="Close"
            detail={<>The closing receipt records the revoked key, the new key and the unsigned interval{c.signingOn ? <> — <span className="font-mono">{seqLabel(c.unsignedFrom)}–{seqLabel(c.unsignedTo ?? c.unsignedFrom)}</span>, {plural((c.unsignedTo ?? c.unsignedFrom) - c.unsignedFrom + 1, 'receipt')}</> : ''}.</>}
            action={canCustody && c.signingOn && <Button size="sm" variant="primary" disabled={!c.notice} title={!c.notice ? 'Send the notice first.' : undefined} onClick={() => setClose(true)}>Close the compromise</Button>} />
        </ol>
        {s.chainIncident && <Banner tone="held" className="mt-4" title="A chain incident is open">{s.block}</Banner>}
      </Panel>
      <NoticeDialog open={notice} onClose={() => setNotice(false)} compromise={c} />
      {bind && <BindKeyDialog open onClose={() => setBind(false)} purpose="compromise" holders={custody?.holders ?? []} provider={custody?.provider ?? ''} />}
      <CloseDialog open={close} onClose={() => setClose(false)} compromise={c} />
    </div>
  );
}

function Step({ done, bad, title, detail, seq, action, last }: { done: boolean; bad?: boolean; title: string; detail: ReactNode; seq?: number; action?: ReactNode; last?: boolean }) {
  return (
    <li className={`flex gap-3 py-3 ${last ? '' : 'border-b border-line'}`}>
      {done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-ok mt-0.5" aria-label="Done" /> : <Circle className={`h-5 w-5 shrink-0 mt-0.5 ${bad ? 'text-bad' : 'text-subtle'}`} aria-label="To do" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">{title}</p>
        <p className="mt-0.5 text-sm text-muted leading-relaxed">{detail}</p>
      </div>
      <div className="flex shrink-0 items-start gap-2">{seq !== undefined && <ReceiptLink seq={seq} />}{action}</div>
    </li>
  );
}

/** Declare a compromise. `discrepancyId` when it comes from a Sign-call reconciliation finding. */
export function DeclareCompromiseDialog({ open, onClose, discrepancyId, prefill }: { open: boolean; onClose: () => void; discrepancyId?: string; prefill?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const { data: s } = useKeysState();
  const [reason, setReason] = useState('');
  const [since, setSince] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setReason(prefill ?? ''); setSince(''); setAck(false); setErr(undefined); } }, [open, prefill]);
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const c = await keysApi.declareCompromise(orgId, user.id, { reason, suspectedSince: since ? new Date(since).toISOString() : undefined, discrepancyId });
      toast.held('Signing stopped', `Key ${c.kid} is revoked. Records from #${c.unsignedFrom} are hash-chained, unsigned. Send the notice to ${c.contact.name} within 24 hours.`);
      onClose();
    } catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} tone="danger" size="md" title="Declare a key compromise"
      description={`Signing with ${s?.active?.kid ?? 'the current key'} stops the moment you confirm. This cannot be undone: the key is revoked for good.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 8 || !ack} title={!ack ? 'Confirm you understand signing stops.' : undefined} onClick={go}>Stop signing now</Button></>}>
      <div className="space-y-4">
        <Field label="What happened" htmlFor="kc-reason" required hint="Recorded on the chain and sent in the notice.">
          <Textarea id="kc-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
        <Field label="Suspected since (optional)" htmlFor="kc-since" hint="When you think the key may first have been used by someone else.">
          <Input id="kc-since" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
        </Field>
        <ul className="list-[square] pl-5 space-y-1 text-sm text-muted">
          <li>The key is revoked. Receipts it signed before now still verify with its published public key.</li>
          <li>Governed calls carry on. Each record is still written and linked into the hash chain, but not signed, until a new key is bound and signing is turned on.</li>
          <li>{s?.contact ? <>{s.contact.name} ({s.contact.email})</> : 'The named contact'} must be told within 24 hours.</li>
          <li>{atLeast(level, 'l3') ? 'The new key is generated in your HSM with 3 of 5 key holders present.' : 'AWS KMS creates the new key; a second owner or admin turns signing on.'}</li>
        </ul>
        <Checkbox checked={ack} onChange={setAck} label="Signing stops now, and the unsigned interval shows on the chain and on every receipt in it" />
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

function NoticeDialog({ open, onClose, compromise }: { open: boolean; onClose: () => void; compromise: KeyCompromise }) {
  const orgId = useOrgId();
  const user = useUser();
  const { data: s } = useKeysState();
  // the copy goes only to this organisation's own auditor of record, when it has one
  const auditor = s?.auditor;
  const [cc, setCc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const orgName = api.org(orgId).name;
  const text = noticeText(orgName, compromise);
  useEffect(() => { if (open) { setErr(undefined); setCc(!!auditor); } }, [open, auditor]);
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const copyTo = cc && auditor ? auditor.email : undefined;
      const c = await keysApi.sendNotice(orgId, user.id, compromise.id, copyTo);
      pushMail({ channel: 'email', to: c.contact.email, subject: text.subject, body: text.body, link: '/agents/keys?tab=custody', orgId });
      if (copyTo) pushMail({ channel: 'email', to: copyTo, subject: text.subject, body: text.body, orgId });
      toast.ok('Notice sent', `To ${c.contact.name}${c.notice?.late ? ', after the 24-hour limit' : ', within 24 hours'}. ${receiptNote(c.notice!.seq)}`);
      onClose();
    } catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Send the key-compromise notice" description={`To ${compromise.contact.name}, ${compromise.contact.role}. Due by ${dateTime(compromise.noticeDueAt)}.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Mail className="h-4 w-4" />} loading={busy} onClick={go}>Send notice</Button></>}>
      <div className="space-y-4">
        <div className="border border-line bg-sunken/60 p-4 text-sm">
          <p className="text-xs text-muted">To {compromise.contact.email}{cc && auditor ? `, copy to ${auditor.email}` : ''}</p>
          <p className="mt-2 font-semibold">{text.subject}</p>
          <p className="mt-2 leading-relaxed">{text.body}</p>
        </div>
        {auditor
          ? <Checkbox checked={cc} onChange={setCc} label="Copy the auditor of record" description={`${auditor.name}, ${auditor.role} · ${auditor.email}`} />
          : <p className="text-xs text-muted">This organisation has no auditor of record, so the notice goes to the named contact only.</p>}
        <p className="text-xs text-muted">The notice is written to the chain with the time it was sent and whether it was within 24 hours.</p>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

/** Bind a new key, published but not signing: for a compromise, or a planned successor published ahead (the overlap). */
export function BindKeyDialog({ open, onClose, purpose, holders, provider }: { open: boolean; onClose: () => void; purpose: 'planned' | 'compromise'; holders: { name: string; role: string }[]; provider: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const l3 = atLeast(level, 'l3');
  const [reason, setReason] = useState(purpose === 'compromise' ? 'Replacement key after a declared compromise' : 'Yearly rotation: successor published ahead');
  const [overlap, setOverlap] = useState('30');
  const [present, setPresent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const need = l3 ? 3 : 0;
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const b = await keysApi.bindKey(orgId, user.id, { reason, purpose, holders: l3 ? present : undefined, overlapDays: Number(overlap) });
      toast.ok('Key bound · signing off', `${b.kid} · fingerprint ${b.fingerprint}. ${receiptNote(b.seq)}`);
      onClose();
    } catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="md" title={purpose === 'compromise' ? 'Bind a replacement key' : 'Publish a successor key'}
      description={`${provider || 'Custody'} creates a new Ed25519 key. It is bound and its public key is published now; it signs nothing until signing is turned on.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={busy} disabled={reason.trim().length < 6 || present.length < need} title={present.length < need ? `Mark ${need} key holders present.` : undefined} onClick={go}>Bind the key</Button></>}>
      <div className="space-y-4">
        <Field label="Reason" htmlFor="bk-reason" required hint="Recorded on the chain with the binding.">
          <Input id="bk-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {purpose === 'planned' && (
          <Field label="Overlap before signing switches" htmlFor="bk-overlap" hint="Verifiers can pin the new fingerprint during the overlap; the current key keeps signing until then.">
            <Select id="bk-overlap" value={overlap} onChange={(e) => setOverlap(e.target.value)}>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days (the policy)</option>
            </Select>
          </Field>
        )}
        {l3 && (
          <fieldset>
            <legend className="text-sm font-medium mb-2">Key holders present <span className="font-normal text-muted num">({present.length} of {need} needed)</span></legend>
            <div className="border border-line divide-y divide-line">
              {holders.map((h) => <div key={h.name} className="px-3 py-2"><Checkbox checked={present.includes(h.name)} onChange={(v) => setPresent((p) => (v ? [...p, h.name] : p.filter((x) => x !== h.name)))} label={h.name} description={h.role} /></div>)}
            </div>
          </fieldset>
        )}
        <p className="text-xs text-muted">{level === 'l2'
          ? purpose === 'planned'
            ? 'At L2 a KMS rotation needs two people: a different owner or admin confirms the switch, or turns signing on. Without that, the successor does not switch at the end of the overlap.'
            : 'At L2 a different owner or admin turns signing on (dual control).'
          : 'Signing is turned on as a separate, recorded step.'}</p>
        <KeyChangeRefusalNote allowCompromise={purpose === 'compromise'} />
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

function CloseDialog({ open, onClose, compromise }: { open: boolean; onClose: () => void; compromise: KeyCompromise }) {
  const orgId = useOrgId();
  const user = useUser();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setNote(''); setErr(undefined); } }, [open]);
  const count = (compromise.unsignedTo ?? compromise.unsignedFrom) - compromise.unsignedFrom + 1;
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const c = await keysApi.closeCompromise(orgId, user.id, compromise.id, note);
      toast.ok('Key compromise closed', `Unsigned interval #${c.unsignedFrom}–#${c.unsignedTo}. ${receiptNote(c.closed!.seq)}`);
      onClose();
    } catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Close the key compromise" description={`Revoked ${compromise.kid} · signing with ${compromise.successor?.kid ?? '—'} · ${plural(count, 'receipt')} unsigned.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={note.trim().length < 6} onClick={go}>Close</Button></>}>
      <div className="space-y-3">
        <Field label="Closing note" htmlFor="kc-close" required hint="What was found and what changed. Recorded on the chain.">
          <Textarea id="kc-close" value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />
        </Field>
        <p className="text-sm text-muted">Publish the new fingerprint out of band once this is closed: the printable page and the DNS TXT record are on the Signing keys tab.</p>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

/** The named contact for key notices (the 24-hour compromise notice goes here). */
export function KeyContactPanel() {
  const orgId = useOrgId();
  const user = useUser();
  const canCustody = useCanDo('keys.custody');
  const { data: s } = useKeysState();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', email: '', role: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const start = () => { setF({ name: s?.contact?.name ?? '', email: s?.contact?.email ?? '', role: s?.contact?.role ?? '', phone: s?.contact?.phone ?? '' }); setErr(undefined); setOpen(true); };
  const save = async () => {
    if (!user) return;
    setBusy(true);
    try { await keysApi.setContact(orgId, user.id, f); toast.ok('Contact named', 'Recorded on the chain.'); setOpen(false); }
    catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Panel title="Contact for key notices" actions={canCustody && <Button size="sm" variant="ghost" onClick={start}>Change</Button>}>
      {!s ? <Skeleton className="h-16" /> : s.contact ? (
        <div className="flex items-start gap-3 text-sm">
          <UserRound className="h-5 w-5 text-muted shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">{s.contact.name}</p>
            <p className="text-muted break-all">{s.contact.email}{s.contact.phone ? ` · ${s.contact.phone}` : ''}</p>
            <p className="text-xs text-muted">{s.contact.role}</p>
            {s.contact.seq !== undefined && <p className="mt-1 text-xs text-muted">Named by {userName(s.contact.setBy)} · <ReceiptLink seq={s.contact.seq} /></p>}
          </div>
        </div>
      ) : <p className="text-sm text-muted">Nobody is named. A key compromise cannot be declared until someone is.</p>}
      <p className="mt-3 text-xs text-muted">A key-compromise notice goes to this person within 24 hours of the declaration.</p>
      <Dialog open={open} onClose={() => setOpen(false)} title="Contact for key notices"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
        <div className="space-y-3">
          <Field label="Name" htmlFor="kn-name" required><Input id="kn-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email" htmlFor="kn-email" required><Input id="kn-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role" htmlFor="kn-role"><Input id="kn-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
          <Field label="Phone (optional)" htmlFor="kn-phone"><Input id="kn-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          {err && <Banner tone="bad">{err}</Banner>}
        </div>
      </Dialog>
    </Panel>
  );
}

/** One-line state for headers: "Key bound · signing off", "Signing off", or nothing. */
export function SigningStateBadge() {
  const { data: s } = useKeysState();
  if (!s) return null;
  if (s.compromise) return <Badge tone="bad">{PHASE_LABEL[compromisePhase(s.compromise)]}</Badge>;
  if (s.bound) return <Badge tone="held">Key bound · signing off</Badge>;
  if (s.upgradeBound) return <Badge tone="held">Key bound · signing off</Badge>;
  return null;
}
