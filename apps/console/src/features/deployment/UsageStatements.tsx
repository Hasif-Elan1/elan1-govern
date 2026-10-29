import { useEffect, useState } from 'react';
import { CheckCircle2, Download, FileSignature, HardDriveDownload, Truck, XCircle } from 'lucide-react';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { useCanDo } from '@/features/settings/permissions';
import { checkStatement, type UsageStatement } from '@/mock/sovereign';
import { userName } from '@/mock/users';
import { dateTime, n, shortHash } from '@/lib/format';
import { Badge, Banner, Button, CodeBlock, Dialog, EmptyState, Field, Input, Panel, Select, Skeleton, StatusChip, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { downloadFile, errText, receiptNote } from '@/features/settings/shared';
import { sovereignApi } from './sovereignApi';

const fileOf = (s: UsageStatement) => {
  const { id: _i, createdAt: _c, createdBy: _b, media: _m, seq: _s, handover: _h, ...body } = s;
  return JSON.stringify(body, null, 2);
};

/**
 * Carrying the meter to Elan1 with no egress. A Sovereign deployment counts governed actions from its own chain
 * and signs a usage statement for a period with its own key; the statement is written to removable media and
 * handed to Elan1, which checks the signature and invoices the licence and any overage from it. Exporting and
 * the hand-over are receipts. Refused actions count at 40% of the per-action rate, as everywhere.
 */
export function UsageStatements() {
  const orgId = useOrgId();
  const user = useUser();
  const canManage = useCanDo('deployment.manage');
  const { data, loading, error, refetch } = useQuery((o) => sovereignApi.statements(o), [], { kinds: ['deployment', 'receipt'] });
  const [period, setPeriod] = useState<string>();
  const [media, setMedia] = useState('');
  const [handover, setHandover] = useState<UsageStatement>();
  const [shown, setShown] = useState<UsageStatement>();
  const exp = useMutation(sovereignApi.exportStatement);
  const pid = period ?? data?.periods[1]?.id ?? data?.periods[0]?.id;
  const preview = useQuery((o) => (pid ? sovereignApi.preview(o, pid) : Promise.resolve(undefined)), [pid], { kinds: ['receipt'] });

  const doExport = async () => {
    if (!user || !pid) return;
    try {
      const r = await exp.mutate(orgId, pid, media, user.id);
      downloadFile(`usage-statement-${r.statement.period.label.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '').toLowerCase()}.json`, fileOf(r.statement));
      toast.ok(`Statement for ${r.statement.period.label} written`, `Copy the file to ${r.statement.media} and hand it to Elan1. ${receiptNote(r.seq)}`);
      setMedia('');
    } catch (e) { toast.bad('Not exported', errText(e)); }
  };

  if (error) return <Banner tone="bad" title="Usage statements could not be read" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-7 min-w-0" title={<span className="inline-flex items-center gap-2"><FileSignature className="h-4 w-4" aria-hidden />New usage statement</span>}
          footer={<>Nothing is sent: the statement is a file you copy to removable media. Elan1 checks the signature against your published key fingerprint and invoices from it.</>}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Period" htmlFor="us-period">
              <Select id="us-period" value={pid} onChange={(e) => setPeriod(e.target.value)}>
                {data.periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Media it is written to" htmlFor="us-media" hint="The serial on the drive or disc">
              <Input id="us-media" value={media} onChange={(e) => setMedia(e.target.value)} placeholder="USB DCB-0412 (encrypted)" />
            </Field>
          </div>
          <div className="mt-4 border border-line bg-sunken/40 p-4">
            {!preview.data ? <Skeleton className="h-16" /> : (
              <dl className="grid gap-3 sm:grid-cols-4 text-sm">
                <div><dt className="label">Governed actions</dt><dd className="mt-0.5 font-display text-xl font-semibold num">{n(preview.data.counts.decisions)}</dd></div>
                <div><dt className="label">Allowed</dt><dd className="mt-0.5 num">{n(preview.data.counts.committed)}</dd></div>
                <div><dt className="label">Refused (× 0.4)</dt><dd className="mt-0.5 num">{n(preview.data.counts.refused)}</dd></div>
                <div><dt className="label">Units</dt><dd className="mt-0.5 font-display text-xl font-semibold num">{n(preview.data.units)}</dd></div>
                <div className="sm:col-span-4 text-xs text-muted">Chain head #{preview.data.head.seq} · {shortHash(preview.data.head.hash, 16)} · {n(preview.data.counts.pending)} still waiting for a person count 0 until decided.{preview.data.counts.sandbox ? ` ${n(preview.data.counts.sandbox)} sandbox calls are left out and billed at 0, as on the Billing meter.` : ''}</div>
              </dl>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<HardDriveDownload className="h-4 w-4" />} loading={exp.pending} disabled={!canManage || !user || media.trim().length < 3} title={!canManage ? 'Owners and admins export usage statements.' : media.trim().length < 3 ? 'Name the media first.' : undefined} onClick={doExport}>Sign and write to media</Button>
            <span className="text-xs text-muted">Signed with your key in your HSM. Recorded as meter.statement_exported.</span>
          </div>
        </Panel>
        <Panel className="xl:col-span-5" tone="sunken" title="How the meter leaves without egress">
          <ol className="list-decimal pl-5 space-y-1.5 text-sm text-fg/85">
            <li>The meter counts governed actions from your own chain.</li>
            <li>An owner or admin signs a statement for the period with the organisation’s key.</li>
            <li>The file goes on removable media; the export is a receipt naming the media.</li>
            <li>The media is handed to Elan1; the hand-over is a receipt naming who took it.</li>
            <li>Elan1 checks the signature offline and invoices the yearly licence and any overage from the statement.</li>
          </ol>
          <p className="mt-3 text-xs text-muted">Allowed and approved actions count 1; refused, rejected and expired ones count 0.4 — refused actions are billed at 40% of the per-action rate.</p>
        </Panel>
      </div>

      <Panel title="Statements written" flush>
        {data.statements.length === 0 ? <EmptyState compact title="No statement yet" disc="trail">Write the first one above. Each appears here with its signature and hand-over.</EmptyState> : (
          <ul className="divide-y divide-line">
            {data.statements.map((s) => {
              const c = checkStatement(s);
              return (
                <li key={s.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{s.period.label}</span>
                    <Badge>{n(s.units)} units</Badge>
                    {c.sigOk ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Signature verifies</StatusChip> : <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" aria-hidden />}>Does not verify</StatusChip>}
                    {s.handover ? <StatusChip tone="info" size="sm" icon={<Truck className="h-3 w-3" aria-hidden />}>Handed to Elan1</StatusChip> : <StatusChip tone="held" size="sm">Not handed over yet</StatusChip>}
                    <span className="ml-auto flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadFile(`usage-statement-${s.period.from.slice(0, 7)}.json`, fileOf(s))}>File</Button>
                      <Button size="sm" variant="ghost" onClick={() => setShown(s)}>View</Button>
                      {!s.handover && <Button size="sm" variant="secondary" disabled={!canManage} title={!canManage ? 'Owners and admins record hand-overs.' : undefined} onClick={() => setHandover(s)}>Record hand-over</Button>}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{n(s.counts.decisions)} governed actions · {n(s.counts.committed)} allowed · {n(s.counts.refused)} refused{s.counts.sandbox ? ` · ${n(s.counts.sandbox)} sandbox calls left out` : ''} · head #{s.head.seq} · digest {shortHash(s.digest, 16)} · key {s.kid}</p>
                  <p className="mt-1 text-xs text-muted">Written to {s.media} by {userName(s.createdBy)}, {dateTime(s.createdAt)} · <ReceiptLink seq={s.seq} />
                    {s.handover && <> · handed to {s.handover.to} (ref. {s.handover.ref}) by {userName(s.handover.by)}, {dateTime(s.handover.at)} · <ReceiptLink seq={s.handover.seq} /></>}</p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {handover && <HandoverDialog s={handover} onClose={() => setHandover(undefined)} />}
      <Dialog open={!!shown} onClose={() => setShown(undefined)} size="lg" title={shown ? `Usage statement · ${shown.period.label}` : ''} description="Exactly what is on the media. Elan1 recomputes the digest over everything above it and checks the signature with the public key it names."
        footer={<Button variant="primary" onClick={() => setShown(undefined)}>Close</Button>}>
        {shown && <CodeBlock title="usage-statement.json" code={fileOf(shown)} maxHeight={420} />}
      </Dialog>
    </div>
  );
}

function HandoverDialog({ s, onClose }: { s: UsageStatement; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [to, setTo] = useState('');
  const [ref, setRef] = useState('');
  const [err, setErr] = useState<string>();
  const m = useMutation(sovereignApi.handover);
  useEffect(() => setErr(undefined), [to, ref]);
  const submit = async () => {
    if (!user) return;
    try { const r = await m.mutate(orgId, s.id, to, ref, user.id); toast.ok('Hand-over recorded', receiptNote(r.seq)); onClose(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <Dialog open onClose={onClose} title={`Hand over · ${s.period.label}`} description={`The statement on ${s.media} is going to Elan1. Record who took it.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.pending} onClick={submit}>Record hand-over</Button></>}>
      <div className="space-y-4">
        <Field label="Received by (Elan1)" htmlFor="ho-to" required><Input id="ho-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Priya Raman, Elan1 customer operations" data-autofocus /></Field>
        <Field label="Courier or hand-over reference" htmlFor="ho-ref" required><Input id="ho-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="BlueDart 71204455 / in person at BKC" /></Field>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}
