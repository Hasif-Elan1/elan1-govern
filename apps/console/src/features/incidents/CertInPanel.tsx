import { useEffect, useId, useState } from 'react';
import { Clock3, Copy, FileCheck2, Send } from 'lucide-react';
import { api } from '@/api';
import { useNow } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { countdown, dateTime, n } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Banner, Button, Dialog, Field, Input, Meter, Panel, RadioCards, Select, Textarea, toast } from '@/components/ui';
import { Person, ReceiptLink } from '@/components/domain';
import { CERT_IN_ALWAYS, CERT_IN_CATEGORY, CERT_IN_HOURS, type CertInDraft, type CertInReport, type DeclaredClass } from '@/mock/ops';

const CATEGORIES = Array.from(new Set([...Object.values(CERT_IN_CATEGORY), 'Data breach', 'Data leak', 'Identity theft, spoofing or phishing', 'Attacks on cloud computing systems, services or applications']));

/** The report as plain text, for the email to incident@cert-in.org.in or the portal form. */
export function certInText(rep: CertInReport, d: CertInDraft, orgName: string, incidentId: string) {
  return [
    `Incident report to CERT-In — ${orgName}`,
    `Incident reference: ${incidentId}`,
    `Category: ${d.category}`,
    `Time noticed: ${dateTime(rep.noticedAt)}`,
    `What happened: ${d.summary}`,
    `Systems affected: ${d.systems}`,
    `Indicators: ${d.indicators || 'None yet'}`,
    `Actions taken: ${d.actions}`,
    `Point of contact: ${d.contactName} <${d.contactEmail}>`,
  ].join('\n');
}

/**
 * The CERT-In six-hour reporting clock on a qualifying incident (key compromise, isolation breach, or one declared
 * reportable): the deadline, the report draft (saved as a receipt), and the recorded submission with CERT-In's reference.
 * An incident with an open clock cannot be resolved until the report is recorded or an owner records why it is not reportable.
 */
export function CertInPanel({ incidentId, subkind, orgName, onChange }: { incidentId: string; subkind?: string; orgName: string; onChange?: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const now = useNow(15_000);
  const fid = useId();
  const canEdit = role === 'owner' || role === 'admin';
  const [rep, setRep] = useState<CertInReport | undefined>(() => api.ops.certInOf(orgId, incidentId));
  const [draft, setDraft] = useState<CertInDraft | undefined>(rep?.draft);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [nrOpen, setNrOpen] = useState(false);
  const [method, setMethod] = useState<'email' | 'portal'>('email');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string>();

  useEffect(() => { const r = api.ops.certInOf(orgId, incidentId); setRep(r); setDraft(r?.draft); }, [orgId, incidentId]);
  if (!rep || !draft) return null;

  const due = new Date(rep.dueAt).getTime();
  const start = new Date(rep.noticedAt).getTime();
  const used = Math.max(0, Math.min(1, (now - start) / (due - start)));
  const overdue = now > due;
  const done = !!rep.submittedAt || !!rep.notReportable;
  const always = !!subkind && CERT_IN_ALWAYS.includes(subkind as DeclaredClass);
  const set = (k: keyof CertInDraft, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const changed = JSON.stringify(draft) !== JSON.stringify(rep.draft);

  const act = async (kind: 'save' | 'submit' | 'not') => {
    if (!user) return;
    setBusy(kind);
    try {
      if (kind === 'save') {
        const r = api.ops.saveCertInDraft(orgId, incidentId, draft, user.id);
        setRep(r);
        toast.ok('Draft saved', `Recorded as receipt #${n(r.draftSeq ?? 0)}.`);
      } else if (kind === 'submit') {
        const r = api.ops.submitCertIn(orgId, incidentId, { method, reference, draft }, user.id);
        setRep(r);
        setSubmitOpen(false);
        toast.ok('Submission recorded', `${r.late ? 'After the six-hour deadline. ' : 'Inside six hours. '}Receipt #${n(r.submitSeq ?? 0)}.`);
      } else {
        const r = api.ops.markCertInNotReportable(orgId, incidentId, reason, user.id);
        setRep(r);
        setNrOpen(false);
        toast.info('Recorded as not reportable', `Receipt #${n(r.notReportable?.seq ?? 0)}. The incident can now be resolved.`);
      }
      onChange?.();
    } catch (e) {
      toast.bad('Not recorded', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(certInText(rep, draft, orgName, incidentId));
      toast.ok('Report copied', 'Paste it into the email to incident@cert-in.org.in or the CERT-In portal.');
    } catch {
      toast.bad('Could not copy', 'Your browser did not allow it. Select the fields and copy them by hand.');
    }
  };

  return (
    <Panel title="CERT-In report" kicker={`${CERT_IN_HOURS}-hour reporting clock`} className={cn(!done && overdue && 'border-bad')}>
      {rep.submittedAt ? (
        <div className="space-y-3 text-sm">
          <Banner tone={rep.late ? 'held' : 'ok'} title={rep.late ? 'Reported after the six-hour deadline' : 'Reported inside six hours'}>
            {rep.method === 'email' ? 'Email to incident@cert-in.org.in' : 'CERT-In portal'} · reference <span className="font-mono">{rep.reference}</span>
          </Banner>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-muted">Noticed</dt><dd>{dateTime(rep.noticedAt)}</dd>
            <dt className="text-muted">Due by</dt><dd>{dateTime(rep.dueAt)}</dd>
            <dt className="text-muted">Reported</dt><dd>{dateTime(rep.submittedAt)}{rep.submitSeq !== undefined && <> · <ReceiptLink seq={rep.submitSeq} /></>}</dd>
            <dt className="text-muted">By</dt><dd><Person id={rep.submittedBy} size={18} /></dd>
            <dt className="text-muted">Category</dt><dd>{rep.draft.category}</dd>
          </dl>
          <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={copy}>Copy the report as sent</Button>
        </div>
      ) : rep.notReportable ? (
        <Banner tone="neutral" title="Recorded as not reportable">
          By <Person id={rep.notReportable.by} size={18} /> on {dateTime(rep.notReportable.at)}: “{rep.notReportable.reason}”{rep.notReportable.seq !== undefined && <> · <ReceiptLink seq={rep.notReportable.seq} /></>}
        </Banner>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className={cn('font-display text-3xl font-semibold num', overdue ? 'text-bad-fg' : used > 0.66 ? 'text-held-fg' : '')} aria-live="polite">
                <Clock3 className="inline h-5 w-5 mr-1.5 align-[-2px]" aria-hidden />{overdue ? `Overdue by ${countdown(new Date(now).toISOString(), due)}` : countdown(rep.dueAt, now)}
              </p>
              <span className="text-xs text-muted">due {dateTime(rep.dueAt)}</span>
            </div>
            <Meter className="mt-2" value={1 - used} tone={overdue ? 'bad' : used > 0.66 ? 'held' : 'inverse'} label="Time left on the six-hour clock" />
            <p className="mt-1.5 text-xs text-muted">Noticed {dateTime(rep.noticedAt)}. CERT-In Directions of 28 April 2022: report within six hours of noticing. {rep.draftSavedAt ? <>Draft saved {dateTime(rep.draftSavedAt)}{rep.draftSavedBy ? <> by {rep.draftSavedBy && <Person id={rep.draftSavedBy} size={16} />}</> : null}.</> : 'No draft saved yet.'}</p>
          </div>

          {/* owners and admins write the report; every other role reads the draft as text, not as a greyed-out form */}
          {!canEdit ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">Category</dt><dd>{draft.category || '—'}</dd>
              <dt className="text-muted">What happened</dt><dd className="whitespace-pre-line">{draft.summary || '—'}</dd>
              <dt className="text-muted">Systems</dt><dd>{draft.systems || '—'}</dd>
              {draft.indicators && <><dt className="text-muted">Indicators</dt><dd className="whitespace-pre-line">{draft.indicators}</dd></>}
              <dt className="text-muted">Actions taken</dt><dd className="whitespace-pre-line">{draft.actions || '—'}</dd>
              <dt className="text-muted">Contact</dt><dd>{[draft.contactName, draft.contactEmail].filter(Boolean).join(' · ') || '—'}</dd>
            </dl>
          ) : (
          <div className="space-y-3">
            <Field label="Category" htmlFor={`${fid}-cat`}>
              <Select id={`${fid}-cat`} value={draft.category} disabled={!canEdit} onChange={(e) => set('category', e.target.value)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="What happened" htmlFor={`${fid}-sum`} required>
              <Textarea id={`${fid}-sum`} rows={3} value={draft.summary} disabled={!canEdit} onChange={(e) => set('summary', e.target.value)} />
            </Field>
            <Field label="Systems affected" htmlFor={`${fid}-sys`} required>
              <Input id={`${fid}-sys`} value={draft.systems} disabled={!canEdit} onChange={(e) => set('systems', e.target.value)} />
            </Field>
            <Field label="Indicators" htmlFor={`${fid}-ind`} hint="Key prefixes, addresses, log references. Optional at first report.">
              <Textarea id={`${fid}-ind`} rows={2} value={draft.indicators} disabled={!canEdit} onChange={(e) => set('indicators', e.target.value)} />
            </Field>
            <Field label="Actions taken" htmlFor={`${fid}-act`} required>
              <Textarea id={`${fid}-act`} rows={2} value={draft.actions} disabled={!canEdit} onChange={(e) => set('actions', e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Point of contact" htmlFor={`${fid}-cn`} required><Input id={`${fid}-cn`} value={draft.contactName} disabled={!canEdit} onChange={(e) => set('contactName', e.target.value)} /></Field>
              <Field label="Contact email" htmlFor={`${fid}-ce`} required><Input id={`${fid}-ce`} type="email" value={draft.contactEmail} disabled={!canEdit} onChange={(e) => set('contactEmail', e.target.value)} /></Field>
            </div>
          </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={copy}>Copy</Button>
            {canEdit && <Button size="sm" variant="secondary" loading={busy === 'save'} disabled={!changed} onClick={() => act('save')}>Save draft</Button>}
            {canEdit && <Button size="sm" variant="primary" icon={<Send className="h-3.5 w-3.5" />} onClick={() => setSubmitOpen(true)}>Record the submission</Button>}
          </div>
          {role === 'owner' && !always && <button type="button" className="text-xs link" onClick={() => setNrOpen(true)}>Not reportable to CERT-In?</button>}
          {always && <p className="text-xs text-muted">A {subkind === 'key_compromise' ? 'key compromise' : 'isolation breach'} is always reportable.</p>}
        </div>
      )}

      <Dialog open={submitOpen} onClose={() => setSubmitOpen(false)} title="Record the CERT-In submission"
        description="Send the report to CERT-In first, then record how it went and the reference they gave. The submission is a receipt on the chain."
        footer={<><Button variant="ghost" onClick={() => setSubmitOpen(false)}>Cancel</Button><Button variant="primary" icon={<FileCheck2 className="h-4 w-4" />} loading={busy === 'submit'} disabled={reference.trim().length < 4} onClick={() => act('submit')}>Record the submission</Button></>}>
        <div className="space-y-4">
          <RadioCards name="certin-method" value={method} onChange={setMethod} cols={2} options={[
            { value: 'email', label: 'Email', description: 'To incident@cert-in.org.in' },
            { value: 'portal', label: 'CERT-In portal', description: 'The incident reporting form' },
          ]} />
          <Field label="Acknowledgement or reference" htmlFor={`${fid}-ref`} required hint="The reference CERT-In returned, or the sent time and subject of your email.">
            <Input id={`${fid}-ref`} mono value={reference} onChange={(e) => setReference(e.target.value)} placeholder="CERTIn-IR-2026-…" data-autofocus />
          </Field>
          <p className="text-xs text-muted">{overdue ? 'The six-hour deadline has passed; the receipt records that it was late.' : `Recorded now, this is ${countdown(rep.dueAt, now)} before the deadline.`}</p>
        </div>
      </Dialog>

      <Dialog open={nrOpen} onClose={() => setNrOpen(false)} title="Not reportable to CERT-In" size="sm"
        description="Only an owner records this, with a reason. The incident can then be resolved without a report."
        footer={<><Button variant="ghost" onClick={() => setNrOpen(false)}>Cancel</Button><Button variant="primary" loading={busy === 'not'} disabled={reason.trim().length < 12} onClick={() => act('not')}>Record</Button></>}>
        <Field label="Why it is not reportable" htmlFor={`${fid}-nr`} required>
          <Textarea id={`${fid}-nr`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: a drill; no system or data outside the test environment was touched." />
        </Field>
      </Dialog>
    </Panel>
  );
}
