import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Download, EyeOff, Send } from 'lucide-react';
import { api } from '@/api';
import type { CrossOrgReceipt, DisclosurePackage, Receipt } from '@/types';
import { DISCLOSABLE_FIELDS, FIELD_LABELS, fieldValuesOf, verifyDisclosure, type DisclosableField } from '@/lib/disclosure';
import { levelRank } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { seqLabel } from '@/lib/format';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { useQuery } from '@/hooks/useQuery';
import { Banner, Button, Checkbox, CopyButton, Dialog, EmptyState, Field, Input, Select, Skeleton, StatusChip, toast } from '@/components/ui';
import { downloadText } from './shared';
import { issueRedactedShare, type RedactedShare } from './redaction';
import { CheckList } from './VerifyResult';
import { FirstIssueWarning, useFirstIssue } from '@/features/counterparties/shared';

const DEFAULT_FIELDS: DisclosableField[] = ['seq', 'ts', 'tool', 'decision', 'rulebook_version'];

function FieldPicker({ r, related, picked, onChange }: { r: Receipt; related?: Receipt; picked: DisclosableField[]; onChange: (f: DisclosableField[]) => void }) {
  const values = useMemo(() => fieldValuesOf(r, related), [r, related]);
  return (
    <fieldset>
      <legend className="sr-only">Fields to reveal</legend>
      <ul className="grid gap-px bg-line border border-line sm:grid-cols-2">
        {DISCLOSABLE_FIELDS.map((f) => {
          const on = picked.includes(f);
          return (
            <li key={f} className={cn('bg-surface px-3 py-2 min-w-0', on && 'bg-sunken/60')}>
              <Checkbox checked={on} onChange={(v) => onChange(v ? [...picked, f] : picked.filter((x) => x !== f))}
                label={<span className="flex items-center gap-1.5">{FIELD_LABELS[f]}{!on && <EyeOff className="h-3 w-3 text-subtle" aria-label="hidden" />}</span>}
                description={<span className={cn('font-mono break-all', !on && 'text-subtle')}>{on ? values[f] || '—' : 'committed, not revealed'}</span>} />
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-sm" aria-live="polite">You are revealing <span className="font-semibold num">{picked.length}</span> of <span className="num">{DISCLOSABLE_FIELDS.length}</span> committed fields. The rest stay committed as salted digests: bound by the signature, unreadable without their salts.</p>
    </fieldset>
  );
}

const canShare = (role?: string) => role === 'owner' || role === 'admin';

/**
 * Share a receipt revealing only chosen fields (SD-JWT, RFC 9901). L2: signed and downloaded here, recorded on the chain.
 * L3 and above: a disclosure package with a portal link the recipient opens without an account.
 */
export function RedactedShareDialog({ open, onClose, r, related }: { open: boolean; onClose: () => void; r: Receipt; related?: Receipt }) {
  const orgId = useOrgId();
  const level = useOrgLevel();
  const user = useUser();
  const l3 = levelRank(level) >= 2;
  const [picked, setPicked] = useState<DisclosableField[]>(DEFAULT_FIELDS);
  const [audience, setAudience] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ share?: RedactedShare; pkg?: DisclosurePackage }>();
  useEffect(() => { if (open) { setDone(undefined); setErr(undefined); } }, [open]);
  // L3: the volume and reversal warning before the first package to an audience, acknowledged and recorded
  const aud = audience.trim() || 'ar-org:unspecified';
  const first = useFirstIssue(l3 && open ? aud : undefined, r.seq);
  const [ack, setAck] = useState(false);
  useEffect(() => { setAck(false); }, [aud]);
  const needsAck = l3 && (!!first.info?.first && !ack);

  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      if (l3) {
        const pkg = await api.createDisclosure(orgId, { seq: r.seq, fields: picked, audience: aud, expiresDays: 30 }, user.id, { acknowledgeFirstIssue: ack });
        setDone({ pkg });
        toast.ok('Disclosure created', `Revealing ${pkg.revealed.length} of ${pkg.committed.length} committed fields. Recorded on the chain.`);
      } else {
        const share = issueRedactedShare(orgId, r, picked, audience, user.id, related);
        setDone({ share, pkg: share.pkg });
        toast.ok('Redacted copy signed', `Revealing ${share.revealed} of ${share.committed} committed fields. Recorded as ${seqLabel(share.seq)}.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const check = done?.pkg ? verifyDisclosure(done.pkg) : undefined;
  const portal = done?.pkg?.token ? `${window.location.origin}/counterparty/${done.pkg.token}` : undefined;

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`Share receipt ${seqLabel(r.seq)} with redaction`}
      description="Choose what the recipient may read. Every field is committed as a salted digest and signed; only the fields you reveal travel with their salts."
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<EyeOff className="h-4 w-4" />} loading={busy} disabled={!picked.length || !canShare(user?.role) || needsAck || (l3 && first.loading)} title={!canShare(user?.role) ? 'Owners and admins can share receipts outside the organisation.' : undefined} onClick={submit}>
            {l3 ? 'Create disclosure' : 'Sign and download'}
          </Button>
        </>
      )}>
      {!done ? (
        <div className="space-y-4">
          <FieldPicker r={r} related={related} picked={picked} onChange={setPicked} />
          <Field label="Audience" htmlFor="sh-aud" hint="Who it is for, as ar-org:<their domain>. A verifier checks the audience.">
            <Input id="sh-aud" mono value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="ar-org:auditor.example.in" />
          </Field>
          {l3 && <FirstIssueWarning info={first.info} acknowledged={ack} onChange={setAck} what="disclosure" />}
          {!canShare(user?.role) && <Banner tone="neutral">Owners and admins can share receipts outside the organisation. You can still see what a share would reveal.</Banner>}
          {err && <Banner tone="bad" title="Not shared">{err}</Banner>}
        </div>
      ) : (
        <div className="space-y-4">
          <Banner tone="ok" title={`Revealing ${done.pkg?.revealed.length ?? 0} of ${done.pkg?.committed.length ?? 0} committed fields`}>
            {l3 ? 'Recorded on the chain. The recipient opens the portal link with no account; their browser checks the signature and every revealed digest.' : 'Signed with the key that signed the receipt and recorded on the chain. Download the SD-JWT for the recipient.'}
          </Banner>
          {check && <CheckList checks={check.steps.map((s) => ({ label: s.label, state: s.state, detail: s.detail }))} />}
          <div className="flex flex-wrap gap-2">
            {done.share && <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`receipt-${r.seq}-redacted.sd-jwt`, done.share!.sdJwt, 'application/sd-jwt')}>Download SD-JWT</Button>}
            {done.pkg && <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`receipt-${r.seq}-disclosure.json`, JSON.stringify(done.pkg, null, 2))}>Download package (JSON)</Button>}
            {portal && <CopyButton text={portal} label="Copy portal link" className="h-8 px-3" />}
            {portal && <Link to={`/counterparty/${done.pkg!.token}`} target="_blank" className="inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-2">Open the portal <ArrowUpRight className="h-3.5 w-3.5" /></Link>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** L3: issue this receipt to a counterparty from the register, revealing only chosen fields. */
export function IssueDialog({ open, onClose, r, related, onIssued }: { open: boolean; onClose: () => void; r: Receipt; related?: Receipt; onIssued?: () => void }) {
  const user = useUser();
  const cps = useQuery((o) => api.counterparties(o), [open], { kinds: ['receipt'] });
  const [cpId, setCpId] = useState('');
  const [picked, setPicked] = useState<DisclosableField[]>(DEFAULT_FIELDS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ receipt: CrossOrgReceipt; disclosure: DisclosurePackage }>();
  const list = cps.data?.counterparties ?? [];
  useEffect(() => { if (!cpId && list.length) setCpId(list[0].id); }, [list, cpId]);
  useEffect(() => { if (open) { setDone(undefined); setErr(undefined); } }, [open]);
  const orgId = useOrgId();
  const target = list.find((c) => c.id === cpId);
  // the volume and reversal warning before the first receipt to this counterparty, acknowledged and recorded
  const first = useFirstIssue(open && target ? `ar-org:${target.domain}` : undefined, r.seq);
  const [ack, setAck] = useState(false);
  useEffect(() => { setAck(false); }, [cpId]);
  const needsAck = !!first.info?.first && !ack;

  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const res = await api.issueToCounterparty(orgId, r.seq, cpId, picked, user.id, { acknowledgeFirstIssue: ack });
      setDone(res);
      onIssued?.();
      toast.ok(`Issued to ${res.receipt.counterpartyName}`, `Revealing ${res.disclosure.revealed.length} of ${res.disclosure.committed.length} committed fields.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cp = list.find((c) => c.id === cpId);
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`Issue receipt ${seqLabel(r.seq)} to a counterparty`}
      description="The counterparty receives the receipt’s hash and signature with only the fields you reveal, and verifies it with your key."
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} disabled={!cpId || !picked.length || !canShare(user?.role) || needsAck || first.loading} title={!canShare(user?.role) ? 'Owners and admins can issue receipts to counterparties.' : undefined} onClick={submit}>Issue receipt</Button>
        </>
      )}>
      {cps.loading && !cps.data ? <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-40" /></div>
        : cps.error ? <Banner tone="bad" title="The counterparty register could not be loaded">{cps.error.message}</Banner>
        : !list.length ? <EmptyState compact title="No counterparties registered" disc="orbit" action={<Link to="/assurance/counterparties" className="text-sm font-medium underline underline-offset-2">Open the counterparty register</Link>}>Add the customer, vendor, insurer, lender or regulator first. Each holds a seat.</EmptyState>
        : done ? (
          <div className="space-y-3">
            <Banner tone="ok" title={`Issued to ${done.receipt.counterpartyName}`}>Revealing {done.disclosure.revealed.length} of {done.disclosure.committed.length} committed fields. Recorded on the chain.</Banner>
            <p className="text-sm">Their verifier: <StatusChip tone={done.receipt.verification.state === 'verified' ? 'ok' : done.receipt.verification.state === 'pending' ? 'held' : 'bad'} size="sm">{done.receipt.verification.state === 'verified' ? 'Verified' : done.receipt.verification.state === 'pending' ? 'Not reported yet' : 'Did not verify'}</StatusChip></p>
            {done.receipt.token && <div className="flex flex-wrap items-center gap-2"><CopyButton text={`${window.location.origin}/counterparty/${done.receipt.token}`} label="Copy portal link" className="h-8 px-3" /><Link to={`/counterparty/${done.receipt.token}`} target="_blank" className="inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-2">Open the portal <ArrowUpRight className="h-3.5 w-3.5" /></Link></div>}
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Counterparty" htmlFor="is-cp" hint={cp ? `${cp.kind} · ${cp.domain} · key ${cp.keyFingerprint ? `${cp.keyFingerprint} (${cp.keyRoute.replace('_', ' ')})` : 'not pinned'} · ${cp.seatsUsed} of ${cp.seats} seats used` : undefined}>
              <Select id="is-cp" value={cpId} onChange={(e) => setCpId(e.target.value)}>
                {list.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
              </Select>
            </Field>
            <FieldPicker r={r} related={related} picked={picked} onChange={setPicked} />
            <FirstIssueWarning info={first.info} acknowledged={ack} onChange={setAck} />
            {!canShare(user?.role) && <Banner tone="neutral">Owners and admins can issue receipts to counterparties.</Banner>}
            {err && <Banner tone="bad" title="Not issued">{err}</Banner>}
          </div>
        )}
    </Dialog>
  );
}

/** A received counterparty receipt with its verification steps. */
export function ReceivedCard({ x, onVerify, verifying }: { x: CrossOrgReceipt; onVerify?: () => void; verifying?: boolean }) {
  const st = x.verification.state;
  return (
    <div className="border border-line bg-surface p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="label">Received from</p>
          <p className="font-medium">{x.issuerName}</p>
          <p className="text-xs text-muted break-words">{x.summary}</p>
        </div>
        <StatusChip tone={st === 'verified' ? 'ok' : st === 'pending' ? 'held' : 'bad'} size="sm">{st === 'verified' ? 'Verified' : st === 'pending' ? 'Pending' : st === 'expired' ? 'Expired' : 'Did not verify'}</StatusChip>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span>Their receipt <span className="font-mono text-fg">{seqLabel(x.seq)}</span></span><span>hash <span className="font-mono text-fg">{x.receiptHash.slice(0, 12)}…</span></span><span>key <span className="font-mono text-fg">{x.kid}</span></span>{x.boundSeq && <span>bound here as <Link className="font-mono text-fg underline underline-offset-2" to={`/activity/${x.boundSeq}`}>{seqLabel(x.boundSeq)}</Link></span>}</div>
      {x.verification.steps.length > 0 && <CheckList checks={x.verification.steps.map((s) => ({ label: s.label, state: s.state, detail: s.detail }))} />}
      {onVerify && <Button size="sm" variant="secondary" loading={verifying} onClick={onVerify}>Verify again and record</Button>}
    </div>
  );
}
