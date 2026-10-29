import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Download, FileInput, PackageCheck, Send, Undo2, XCircle } from 'lucide-react';
import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { date, dateTime, n, relative, seqLabel } from '@/lib/format';
import { userById, userName } from '@/mock/users';
import { keysApi, type EvidenceRequest } from '@/mock/keys';
import { pushMail } from '@/features/auth/registry';
import { downloadText } from '@/features/activity/shared';
import { useMemberRole } from '@/features/settings/permissions';
import { Badge, Banner, Button, Dialog, EmptyState, Field, Input, PageHeader, Panel, Segmented, Select, Skeleton, StatusChip, Textarea, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { BUNDLE_CHARGE, ExportPackDialog, type ExportedSummary } from '@/features/evidence/ExportPackDialog';
import { rupees } from '@/lib/format';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const receiptNote = (seq: number) => `Recorded as receipt #${new Intl.NumberFormat('en-IN').format(seq)}.`;

export function RequestStatus({ q }: { q: EvidenceRequest }) {
  const overdue = q.status === 'open' && Date.now() > new Date(q.dueBy).getTime();
  switch (q.status) {
    case 'open': return <StatusChip tone={overdue ? 'bad' : 'held'} size="sm">{overdue ? 'Overdue' : 'Waiting for the organisation'}</StatusChip>;
    case 'fulfilled': return <StatusChip tone="info" size="sm">Sent · not yet collected</StatusChip>;
    case 'received': return <StatusChip tone="ok" size="sm">Collected</StatusChip>;
    case 'declined': return <StatusChip tone="bad" size="sm">Declined</StatusChip>;
    default: return <StatusChip tone="neutral" size="sm">Withdrawn</StatusChip>;
  }
}

const formatLabel = (f: EvidenceRequest['format']) => (f === 'auditor-pack/1' ? 'Auditor pack' : '8-member evidence bundle');

/**
 * The auditor's evidence requests, as recorded writes both ways: the auditor asks for a range (a receipt), the
 * organisation fulfils it with an export (a receipt) or declines it with a reason (a receipt), and the auditor's
 * collection closes the loop (a receipt). `mode` decides which side's controls show.
 */
export function EvidenceRequestsPanel({ mode, compact }: { mode: 'auditor' | 'org'; compact?: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useMemberRole();
  const canFulfil = role === 'owner' || role === 'admin';
  const { data: list, loading, error, refetch } = useQuery((o) => keysApi.evidenceRequests(o), [], { kinds: ['key', 'open'] });
  const [ask, setAsk] = useState(false);
  const [decline, setDecline] = useState<EvidenceRequest>();
  const [busy, setBusy] = useState<string>();
  const org = api.org(orgId);

  // "Export and send" opens the export dialog on the requested range: the same checks as every console export (size
  // split, chain break, integrity run, residency, consent, declarations), "Verify it yourself first", the charge
  // before the click and ZIP or JSON. Once the file is made, the request is linked to that export.
  const [sending, setSending] = useState<EvidenceRequest>();
  const fulfil = async (q: EvidenceRequest, x: ExportedSummary) => {
    if (!user) return;
    setBusy(q.id);
    try {
      const r = await keysApi.fulfilRequest(orgId, user.id, q.id, { exportIds: x.exportIds ?? [x.exportId], receipts: x.receipts, firstSeq: x.firstSeq, lastSeq: x.lastSeq, jsons: x.jsons, exportSeq: x.seq });
      const to = userById(q.requestedBy);
      if (to) pushMail({ channel: 'email', to: to.email, subject: `${org.name} sent the evidence you asked for`, body: `${formatLabel(q.format)} for receipts #${q.fromSeq}–#${q.toSeq} (${n(r.fulfilled?.receipts ?? 0)} receipts), sent by ${userName(user.id)}. Collect it from the Auditor workspace; collecting it is recorded on their chain.`, link: '/auditor', orgId });
      toast.ok('Evidence sent', `${formatLabel(q.format)} of ${n(r.fulfilled?.receipts ?? 0)} receipts to ${userName(q.requestedBy)}. ${receiptNote(r.fulfilled!.seq)}`);
    } catch (e) { toast.bad('The request was not fulfilled', errMsg(e)); }
    finally { setBusy(undefined); }
  };
  const collect = async (q: EvidenceRequest) => {
    if (!user) return;
    setBusy(q.id);
    try {
      const r = await keysApi.collectRequest(orgId, user.id, q.id);
      // every part of the export that was sent, byte for byte
      for (const f of r.files) downloadText(f.filename, f.json);
      const named = r.files.length > 1 ? `${r.files.length} files (${r.files.map((f) => f.filename).join(', ')})` : r.filename;
      toast.ok(q.status === 'received' ? 'Copy downloaded' : 'Evidence collected', q.status === 'received' ? `${named}. A copy of the export already sent: no new export and no charge; the download is recorded on the client’s chain.` : `${named}. ${r.request.received ? receiptNote(r.request.received.seq) : ''}`);
    } catch (e) { toast.bad('The evidence could not be collected', errMsg(e)); }
    finally { setBusy(undefined); }
  };
  const withdraw = async (q: EvidenceRequest) => {
    if (!user) return;
    setBusy(q.id);
    try { await keysApi.withdrawRequest(orgId, user.id, q.id); toast.info('Request withdrawn', 'Recorded on the chain.'); }
    catch (e) { toast.bad('The request was not withdrawn', errMsg(e)); }
    finally { setBusy(undefined); }
  };

  const shown = (list ?? []).filter((q) => mode === 'org' || q.requestedBy === user?.id || role !== 'auditor');
  const open = shown.filter((q) => q.status === 'open').length;

  return (
    <Panel title={mode === 'auditor' ? `Evidence requests to ${org.name}` : 'Evidence requests'} kicker={mode === 'auditor' ? 'Recorded on the client’s chain' : 'From your auditor'} flush
      actions={<>
        {open > 0 && <Badge tone="held">{open} open</Badge>}
        {role === 'auditor' && <Button size="sm" variant="primary" icon={<FileInput className="h-4 w-4" />} onClick={() => setAsk(true)}>Request evidence</Button>}
        {compact && mode === 'org' && <Link to="/assurance/evidence-requests" className="text-sm inline-flex items-center gap-1 link">All requests<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}
      </>}>
      {error ? <div className="p-5"><Banner tone="bad" title="Requests could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner></div>
        : loading && !list ? <div className="p-5"><Skeleton className="h-24" /></div>
        : !shown.length ? <EmptyState compact title="No evidence requests" disc="trail">{role === 'auditor' ? 'Ask for a range of receipts; the request is written to the organisation’s chain.' : 'When your auditor asks for evidence it appears here, with a receipt.'}</EmptyState>
        : (
          <ul className="divide-y divide-line">
            {(compact ? shown.slice(0, 3) : shown).map((q) => (
              <li key={q.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{q.purpose}</span>
                      <RequestStatus q={q} />
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {formatLabel(q.format)} · receipts <span className="font-mono">{seqLabel(q.fromSeq)}–{seqLabel(q.toSeq)}</span>
                      {q.fromDate && q.toDate && <> ({date(q.fromDate)} – {date(q.toDate)})</>} · asked by {userName(q.requestedBy)} {relative(q.requestedAt)} · due {date(q.dueBy)}
                    </p>
                    <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                      <li>Requested {q.seq !== undefined && q.seq > 0 ? <ReceiptLink seq={q.seq} /> : <span>before this window</span>}</li>
                      {q.fulfilled && <li>Sent by {userName(q.fulfilled.by)} {relative(q.fulfilled.at)} · {q.fulfilled.seq ? <ReceiptLink seq={q.fulfilled.seq} /> : <span>export {q.fulfilled.exportId}</span>}</li>}
                      {q.received && <li>Collected {relative(q.received.at)}{q.received.seq ? <> · <ReceiptLink seq={q.received.seq} /></> : ''}</li>}
                      {q.declined && <li>Declined by {userName(q.declined.by)}: “{q.declined.reason}” · <ReceiptLink seq={q.declined.seq} /></li>}
                      {q.withdrawn && <li>Withdrawn · <ReceiptLink seq={q.withdrawn.seq} /></li>}
                    </ol>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {mode === 'org' && q.status === 'open' && canFulfil && <>
                      <Button size="sm" variant="ghost" icon={<XCircle className="h-4 w-4" />} disabled={!!busy} onClick={() => setDecline(q)}>Decline</Button>
                      <Button size="sm" variant="primary" icon={<Send className="h-4 w-4" />} loading={busy === q.id} disabled={!!busy && busy !== q.id} onClick={() => setSending(q)}
                        title={q.format === 'elan1.evidence.bundle.v1' ? `Opens the export: checks, verify first, then ${rupees(BUNDLE_CHARGE)} a bundle` : 'Opens the export: the auditor pack is free'}>
                        Export and send · {q.format === 'elan1.evidence.bundle.v1' ? `${rupees(BUNDLE_CHARGE)} a bundle` : 'free'}
                      </Button>
                    </>}
                    {mode === 'org' && q.status === 'open' && !canFulfil && <Badge>Owners and admins fulfil</Badge>}
                    {role === 'auditor' && q.status === 'open' && q.requestedBy === user?.id && <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} loading={busy === q.id} onClick={() => withdraw(q)}>Withdraw</Button>}
                    {role === 'auditor' && (q.status === 'fulfilled' || q.status === 'received') && q.held === false && <span className="text-xs text-muted max-w-[34ch]">{q.status === 'received' ? 'The file that was sent is not held in this browser: the copy you collected is the record.' : 'The file that was sent is not held in this browser. Ask the organisation to send it again.'}</span>}
                    {role === 'auditor' && (q.status === 'fulfilled' || q.status === 'received') && q.held !== false && <Button size="sm" variant={q.status === 'fulfilled' ? 'primary' : 'secondary'} icon={q.status === 'fulfilled' ? <PackageCheck className="h-4 w-4" /> : <Download className="h-4 w-4" />} loading={busy === q.id} onClick={() => collect(q)}>{q.status === 'fulfilled' ? 'Collect' : 'Download again'}</Button>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      <RequestDialog open={ask} onClose={() => setAsk(false)} />
      <DeclineDialog q={decline} onClose={() => setDecline(undefined)} />
      <ExportPackDialog open={!!sending} requireVerify onClose={() => setSending(undefined)} initialFrom={sending?.fromSeq} initialTo={sending?.toSeq}
        title={sending ? `Export for ${userName(sending.requestedBy)}` : undefined}
        note={sending ? <>“{sending.purpose}” · receipts {seqLabel(sending.fromSeq)}–{seqLabel(sending.toSeq)}. Once the file is made it is sent to {userName(sending.requestedBy)}, who collects it from the Auditor workspace.</> : undefined}
        onExported={(x) => { const q = sending; if (q) void fulfil(q, x); }} />
    </Panel>
  );
}

type RangeMode = '7' | '30' | 'all' | 'seq';

function RequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const { data: range } = useQuery((o) => keysApi.chainRange(o), [open], { live: false });
  const [purpose, setPurpose] = useState('');
  const [mode, setMode] = useState<RangeMode>('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [due, setDue] = useState('5');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setPurpose(''); setMode('30'); setErr(undefined); } }, [open]);
  useEffect(() => { if (range) { setFrom(String(range.first)); setTo(String(range.head)); } }, [range]);

  const bounds = (): [number, number] | undefined => {
    if (!range) return undefined;
    if (mode === 'all') return [range.first, range.head];
    if (mode === 'seq') return [Number(from), Number(to)];
    return [range.seqAt(Date.now() - Number(mode) * 864e5), range.head];
  };
  const b = bounds();
  const go = async () => {
    if (!user || !b) return;
    setBusy(true);
    try {
      const q = await keysApi.requestEvidence(orgId, user.id, { purpose, fromSeq: b[0], toSeq: b[1], dueDays: Number(due) });
      const d = db.getDB(orgId);
      for (const m of d.members.filter((x) => x.status === 'active' && (x.role === 'owner' || x.role === 'admin'))) {
        const u = userById(m.userId);
        if (u) pushMail({ channel: 'email', to: u.email, subject: `${userName(user.id)} asked for evidence`, body: `${q.purpose}. ${formatLabel(q.format)} for receipts #${q.fromSeq}–#${q.toSeq}, due ${date(q.dueBy)}. The request is recorded on your chain.`, link: '/assurance/evidence-requests', orgId });
      }
      toast.ok('Evidence requested', `Receipts #${q.fromSeq}–#${q.toSeq}. ${q.seq ? receiptNote(q.seq) : ''}`);
      onClose();
    } catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="md" title="Request evidence" description={`The organisation’s owners and admins are told, and the request is written to their chain. They send ${atLeast(level, 'l2') ? 'an 8-member evidence bundle' : 'an auditor pack'}.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<FileInput className="h-4 w-4" />} loading={busy} disabled={purpose.trim().length < 6 || !b} onClick={go}>Send request</Button></>}>
      <div className="space-y-4">
        <Field label="What it is for" htmlFor="er-purpose" required hint="Recorded with the request, for example “Quarterly review of payments over ₹10 lakh”.">
          <Input id="er-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} data-autofocus />
        </Field>
        <div>
          <p className="text-sm font-medium mb-1.5">Range</p>
          <Segmented<RangeMode> label="Range" value={mode} onChange={setMode} options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: 'all', label: 'Everything held' }, { value: 'seq', label: 'Receipts' }]} />
          {mode === 'seq' && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="From receipt" htmlFor="er-from"><Input id="er-from" inputMode="numeric" mono value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ''))} /></Field>
              <Field label="To receipt" htmlFor="er-to"><Input id="er-to" inputMode="numeric" mono value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} /></Field>
            </div>
          )}
          {b && range && <p className="mt-2 text-xs text-muted">Receipts <span className="font-mono">{seqLabel(Math.min(b[0], b[1]))}–{seqLabel(Math.max(b[0], b[1]))}</span>. This console holds {seqLabel(range.first)} to {seqLabel(range.head)}{range.firstAt ? ` (${date(range.firstAt)} onwards)` : ''}.</p>}
        </div>
        <Field label="Needed within" htmlFor="er-due">
          <Select id="er-due" value={due} onChange={(e) => setDue(e.target.value)}>
            <option value="2">2 days</option><option value="5">5 days</option><option value="10">10 days</option><option value="30">30 days</option>
          </Select>
        </Field>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

function DeclineDialog({ q, onClose }: { q?: EvidenceRequest; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (q) { setReason(''); setErr(undefined); } }, [q]);
  const go = async () => {
    if (!user || !q) return;
    setBusy(true);
    try {
      const r = await keysApi.declineRequest(orgId, user.id, q.id, reason);
      const to = userById(q.requestedBy);
      if (to) pushMail({ channel: 'email', to: to.email, subject: `${api.org(orgId).name} declined an evidence request`, body: `“${q.purpose}” was declined by ${userName(user.id)}: ${reason.trim()}`, link: '/auditor', orgId });
      toast.info('Request declined', receiptNote(r.declined!.seq));
      onClose();
    } catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={!!q} onClose={onClose} title="Decline the request" description={q ? `${q.purpose} · receipts #${q.fromSeq}–#${q.toSeq}, asked by ${userName(q.requestedBy)} ${dateTime(q.requestedAt)}.` : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 8} onClick={go}>Decline</Button></>}>
      <div className="space-y-3">
        <Field label="Reason" htmlFor="er-decline" required hint="The auditor sees this, and it is written to the chain.">
          <Textarea id="er-decline" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

/** Assurance › Evidence requests: the organisation's side (auditors see their own and can ask). */
export default function EvidenceRequestsPage() {
  const role = useMemberRole();
  useEffect(() => { document.title = 'Evidence requests · Elan1 Govern'; }, []);
  return (
    <div>
      <PageHeader kicker="Assurance" title="Evidence requests"
        description="Your auditor asks for a range of receipts; you send an export of it or decline with a reason. The request, the reply and the auditor’s collection are each a receipt on your chain." />
      <EvidenceRequestsPanel mode={role === 'auditor' ? 'auditor' : 'org'} />
    </div>
  );
}
