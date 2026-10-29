import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Eye, Mail, PenLine, Send } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { date, dateTime, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { fillNotice, istDatePlus, noticeLeadDays, noticeTemplate, NOTICE_INFO, type CloseoutView, type NoticeKind, type UpgradeNotice } from '@/mock/upgrade';
import { Banner, Button, Dialog, Field, Input, Segmented, Select, StatusChip, Textarea, toast } from '@/components/ui';

const KINDS: NoticeKind[] = ['fourteen_day', 'boundary_day', 'auditor_note'];

/**
 * The three customer notices of an L1 → L2 upgrade: a 14-day notice to a named contact, the boundary-day confirmation
 * and a note to the auditor. Each is composed here, scheduled, sent and recorded as a receipt.
 */
export function NoticesPanel({ view, canAct }: { view: CloseoutView; canAct: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const [compose, setCompose] = useState<NoticeKind>();
  const [reading, setReading] = useState<UpgradeNotice>();
  const [busy, setBusy] = useState<string>();
  const switched = !!view.upgrade;
  const closed = view.phase === 'closed' || view.phase === 'rolled_back';

  const act = async (n: UpgradeNotice, what: 'send' | 'cancel') => {
    if (!user) return;
    setBusy(n.id + what);
    try {
      const r = what === 'send' ? await api.sendUpgradeNotice(orgId, user.id, n.id) : await api.cancelUpgradeNotice(orgId, user.id, n.id);
      toast.ok(what === 'send' ? `${NOTICE_INFO[n.kind].label} sent to ${n.toName}` : `${NOTICE_INFO[n.kind].label} cancelled`, `Receipt ${seqLabel(r.seq)}.`);
    } catch (e) { toast.bad(what === 'send' ? 'The notice could not be sent' : 'The notice could not be cancelled', (e as Error).message); } finally { setBusy(undefined); }
  };

  return (
    <div>
      <ul className="border border-line divide-y divide-line">
        {KINDS.map((k) => {
          const all = view.notices.filter((n) => n.kind === k);
          const live = [...all].reverse().find((n) => n.status !== 'cancelled');
          const cancelled = all.filter((n) => n.status === 'cancelled').length;
          return (
            <li key={k} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium inline-flex items-center gap-2"><Mail className="h-4 w-4 text-muted" aria-hidden />{NOTICE_INFO[k].label}</p>
                  <p className="text-xs text-muted">{NOTICE_INFO[k].when}</p>
                </div>
                {live ? (
                  <StatusChip size="sm" tone={live.status === 'sent' ? 'ok' : 'held'}>{live.status === 'sent' ? 'Sent' : 'Scheduled'}</StatusChip>
                ) : <StatusChip size="sm" tone="neutral">Not composed</StatusChip>}
              </div>
              {live && (
                <div className="mt-2 text-sm">
                  <p>To <span className="font-medium">{live.toName}</span>{live.toRole ? <span className="text-muted"> · {live.toRole}</span> : null} <span className="text-muted">· {live.toEmail}</span></p>
                  <p className="text-xs text-muted mt-0.5">
                    {live.status === 'sent'
                      ? <>Sent {dateTime(live.sentAt!)} · <Link className="link font-mono" to={`/activity/${live.sentSeq}`}>{seqLabel(live.sentSeq!)}</Link></>
                      : <>{live.sendAt === 'boundary' ? 'Goes when signing starts' : `Goes ${dateTime(live.sendAt)}`} · scheduled by {userName(live.scheduledBy)} · <Link className="link font-mono" to={`/activity/${live.scheduledSeq}`}>{seqLabel(live.scheduledSeq)}</Link></>}
                    {live.plannedBoundary ? ` · planned boundary ${date(live.plannedBoundary)}` : ''}
                    {cancelled ? ` · ${cancelled} cancelled earlier` : ''}
                  </p>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {live && <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => setReading(live)}>Read it</Button>}
                {/* owners and admins compose, send and cancel: other roles read the notices only */}
                {canAct && !live && !closed && (k === 'fourteen_day' ? !switched : true) && (
                  <Button size="sm" variant={k === 'fourteen_day' ? 'primary' : 'secondary'} icon={<PenLine className="h-3.5 w-3.5" />} onClick={() => setCompose(k)}>Compose</Button>
                )}
                {canAct && live?.status === 'scheduled' && !closed && (
                  <>
                    {(k === 'fourteen_day' || switched) && <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" />} loading={busy === live.id + 'send'} onClick={() => act(live, 'send')}>Send now</Button>}
                    <Button size="sm" variant="quiet-danger" icon={<Ban className="h-3.5 w-3.5" />} loading={busy === live.id + 'cancel'} onClick={() => act(live, 'cancel')}>Cancel</Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {compose && <Composer kind={compose} view={view} onClose={() => setCompose(undefined)} />}
      <Dialog open={!!reading} onClose={() => setReading(undefined)} size="lg" title={reading?.subject ?? ''}
        description={reading ? `${NOTICE_INFO[reading.kind].label} · to ${reading.toName} <${reading.toEmail}>${reading.status === 'sent' ? ` · sent ${dateTime(reading.sentAt!)}` : ' · not sent yet'}` : undefined}
        footer={<Button variant="ghost" onClick={() => setReading(undefined)}>Close</Button>}>
        {reading && (
          <>
            {reading.status !== 'sent' && /\{\w+\}/.test(reading.body) && <Banner tone="info" className="mb-3">Words in braces are filled in when it is sent: the boundary date, the first signed record, the counts each side and the fingerprint.</Banner>}
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed border border-line bg-sunken/40 p-4">{reading.body}</pre>
          </>
        )}
      </Dialog>
    </div>
  );
}

function Composer({ kind, view, onClose }: { kind: NoticeKind; view: CloseoutView; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const contacts = useQuery((o) => api.upgradeContacts(o), [], { live: false });
  const people = contacts.data ?? [];
  const ids = { who: useId(), name: useId(), email: useId(), role: useId(), planned: useId(), at: useId(), subj: useId(), body: useId() };
  const fourteen = view.notices.find((n) => n.kind === 'fourteen_day' && n.status !== 'cancelled');
  const defaultWho = useMemo(() => {
    if (kind === 'auditor_note') return people.find((p) => p.isAuditor);
    if (kind === 'boundary_day' && fourteen) return people.find((p) => p.name === fourteen.toName) ?? people.find((p) => p.isOwner && p.id !== view.run?.by);
    return people.find((p) => p.isOwner && p.id !== view.run?.by) ?? people.find((p) => p.isOwner);
  }, [people, kind, fourteen, view.run?.by]);
  const [who, setWho] = useState<string>('');
  const [f, setF] = useState({ name: '', email: '', role: '' });
  const [planned, setPlanned] = useState(istDatePlus(Date.now(), 14));
  const [when, setWhen] = useState<'now' | 'boundary' | 'later'>(kind === 'fourteen_day' ? 'now' : 'boundary');
  const [at, setAt] = useState(istDatePlus(Date.now(), 1));
  const [text, setText] = useState<{ subject: string; body: string }>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  // pick the default contact once the members load
  const picked = who || defaultWho?.id || 'other';
  const person = people.find((p) => p.id === picked);
  const name = person ? person.name : f.name;
  const email = person ? person.email : f.email;
  const role = person ? person.role : f.role;
  const facts = { org: view.orgName, plannedBoundary: kind === 'fourteen_day' ? planned : fourteen?.plannedBoundary, boundaryAt: view.boundary?.at, signingSeq: view.signing?.seq, before: view.boundary?.recordsBefore, after: view.boundary?.recordsAfter, fingerprint: view.signing?.fingerprint ?? view.key?.fingerprint, contact: name };
  const tpl = noticeTemplate(kind, facts);
  const subject = text?.subject ?? tpl.subject;
  const body = text?.body ?? tpl.body;
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const whenOptions = kind === 'fourteen_day'
    ? [{ value: 'now' as const, label: 'Send now' }, { value: 'later' as const, label: 'On a date' }]
    : kind === 'boundary_day' ? [{ value: 'boundary' as const, label: 'When signing starts' }]
      : view.upgrade ? [{ value: 'now' as const, label: 'Send now' }, { value: 'later' as const, label: 'On a date' }] : [{ value: 'boundary' as const, label: 'When signing starts' }, { value: 'later' as const, label: 'On a later date' }];
  const w = whenOptions.some((o) => o.value === when) ? when : whenOptions[0].value;
  const atTime = at ? new Date(`${at}T09:30:00+05:30`).getTime() : NaN;
  const sendAt = w === 'now' ? new Date().toISOString() : w === 'boundary' ? 'boundary' : isNaN(atTime) ? '' : new Date(atTime).toISOString();
  // the 14 days count in IST calendar days from the day the notice goes (as the mock's scheduleNotice checks)
  const sendTime = w === 'later' && !isNaN(atTime) ? Math.max(Date.now(), atTime) : Date.now();
  const lead = planned ? noticeLeadDays(planned, sendTime) : 0;
  const minPlanned = istDatePlus(sendTime, 14);
  const plannedOk = kind !== 'fourteen_day' || (!!planned && lead >= 14);
  const ready = !!name.trim() && emailOk && plannedOk && !!subject.trim() && !!body.trim() && (w !== 'later' || !!sendAt);

  const submit = async () => {
    if (!user) return;
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.scheduleUpgradeNotice(orgId, user.id, { kind, toName: name.trim(), toEmail: email.trim(), toRole: role.trim(), subject, body, sendAt, plannedBoundary: kind === 'fourteen_day' ? planned : undefined });
      toast.ok(r.sentSeq ? `${NOTICE_INFO[kind].label} sent to ${name}` : `${NOTICE_INFO[kind].label} scheduled`, r.sentSeq ? `Receipts ${seqLabel(r.seq)} and ${seqLabel(r.sentSeq)}.` : `Receipt ${seqLabel(r.seq)}.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} size="xl" title={`Compose the ${NOTICE_INFO[kind].label.toLowerCase()}`} description={NOTICE_INFO[kind].when}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} disabled={!ready} onClick={submit}>{w === 'now' ? 'Send and record' : 'Schedule and record'}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Named contact" htmlFor={ids.who}>
          <Select id={ids.who} value={picked} onChange={(e) => setWho(e.target.value)}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}
            <option value="other">Someone else…</option>
          </Select>
        </Field>
        {!person && (
          <>
            <Field label="Name" htmlFor={ids.name}><Input id={ids.name} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Priya Shah" /></Field>
            <Field label="Email" htmlFor={ids.email} error={f.email && !emailOk ? 'Enter an email address' : undefined}><Input id={ids.email} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="priya.shah@customer.in" /></Field>
            <Field label="Role" htmlFor={ids.role}><Input id={ids.role} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="Head of Finance, customer" /></Field>
          </>
        )}
        {person && <Field label="Email"><p className="h-10 flex items-center text-sm font-mono">{person.email}</p></Field>}
        {kind === 'fourteen_day' && (
          <Field label="Planned boundary date" htmlFor={ids.planned}
            error={!plannedOk ? (planned ? `${lead} days after the notice goes: the boundary must be at least 14 days after it, ${date(minPlanned)} or later.` : 'Choose the planned boundary date.') : undefined}
            hint={plannedOk ? `${lead} days after the notice goes${w === 'later' && sendAt ? ` on ${date(sendAt)}` : ' today'}.` : undefined}>
            <Input id={ids.planned} type="date" value={planned} min={minPlanned} onChange={(e) => { setPlanned(e.target.value); setText(undefined); }} />
          </Field>
        )}
        <Field label="When it is sent">
          <Segmented<'now' | 'boundary' | 'later'> label="When it is sent" value={w} onChange={setWhen} options={whenOptions} />
        </Field>
        {w === 'later' && (
          <Field label="Send on" htmlFor={ids.at} hint="At 09:30 IST.">
            <Input id={ids.at} type="date" value={at} min={istDatePlus(Date.now(), 0)} onChange={(e) => setAt(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="mt-4 space-y-3">
        <Field label="Subject" htmlFor={ids.subj}><Input id={ids.subj} value={subject} onChange={(e) => setText({ subject: e.target.value, body })} /></Field>
        <Field label="Body" htmlFor={ids.body} hint="Words in braces, such as {signing_seq}, are filled in when it is sent." aside={text ? <button type="button" className="text-xs link" onClick={() => setText(undefined)}>Reset to the template</button> : undefined}>
          <Textarea id={ids.body} rows={12} value={body} onChange={(e) => setText({ subject, body: e.target.value })} className="font-sans text-sm" />
        </Field>
        {/\{\w+\}/.test(body) && view.upgrade && (
          <details className="border border-line p-3 text-sm">
            <summary className="cursor-pointer font-medium">Preview with today’s facts</summary>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed">{fillNotice(body, facts)}</pre>
          </details>
        )}
      </div>
      {err && <Banner tone="bad" className="mt-4">{err}</Banner>}
    </Dialog>
  );
}
