import { useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { date, n, relative } from '@/lib/format';
import { userName } from '@/mock/users';
import { keysApi, type ReconDay, type SignDiscrepancy } from '@/mock/keys';
import { useCanDo } from '@/features/settings/permissions';
import { receiptNote } from '@/features/settings/shared';
import { PlanUpsell } from '@/shell/access';
import { Badge, Banner, Button, DataTable, Dialog, Field, Panel, Skeleton, StatusChip, Textarea, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { DeclareCompromiseDialog } from './Compromise';
import { errMsg } from './useKeys';

/**
 * KMS Sign-call reconciliation (L2; the HSM audit log at L3 and Sovereign): every use of the signing key in the
 * key-use log, day by day, against the receipts and checkpoints signed in the chain. A use with no signature
 * behind it is flagged until a person explains it or declares a compromise.
 */
export function SignReconciliationPanel() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const canCustody = useCanDo('keys.custody');
  const l2 = atLeast(level, 'l2');
  const { data: v, loading, error, refetch } = useQuery((o) => (l2 ? keysApi.reconciliation(o) : Promise.resolve(undefined)), [l2], { kinds: ['key', 'checkpoint', 'level'] });
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState<SignDiscrepancy>();
  const [declare, setDeclare] = useState<SignDiscrepancy>();

  // part of L2: below it owners see one line, everyone else nothing
  if (!l2) return <PlanUpsell to="l2" what="Custody in AWS KMS and Sign-call reconciliation start at L2 Attested." />;
  if (error) return <Banner tone="bad" title="The reconciliation could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (loading || !v) return <Skeleton className="h-72" />;

  const run = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await keysApi.runReconciliation(orgId, user.id);
      toast[r.totals.open ? 'held' : 'ok']('Reconciliation recorded', `${n(r.totals.calls)} ${r.logName} against ${n(r.totals.signed)} signatures over ${r.days.length} days; ${r.totals.open ? `${r.totals.open} discrepancy open` : 'no discrepancy open'}. ${r.runs[0]?.seq ? receiptNote(r.runs[0].seq) : ''}`);
    } catch (e) { toast.bad('The reconciliation did not run', errMsg(e)); }
    finally { setBusy(false); }
  };

  const open = v.discrepancies.filter((q) => q.status === 'open');
  const cols: Column<ReconDay>[] = [
    { key: 'day', header: 'Day (IST)', cell: (d) => <span className="text-sm">{date(`${d.day}T12:00:00+05:30`)}</span> },
    { key: 'calls', header: v.logName, align: 'right', cell: (d) => <span className="num">{n(d.calls)}</span> },
    { key: 'receipts', header: 'Receipts signed', align: 'right', hideBelow: 'sm', cell: (d) => <span className="num">{n(d.receipts)}</span> },
    { key: 'cps', header: 'Checkpoints', align: 'right', hideBelow: 'md', cell: (d) => <span className="num">{n(d.checkpoints)}</span> },
    { key: 'delta', header: 'Difference', align: 'right', cell: (d) => d.delta === 0 ? <span className="text-muted">0</span> : <span className={`num font-medium ${d.discrepancy?.status === 'open' ? 'text-bad-fg' : 'text-muted'}`}>{d.delta > 0 ? '+' : ''}{d.delta}</span> },
    { key: 'state', header: 'Status', cell: (d) => !d.discrepancy ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Matched</StatusChip>
      : d.discrepancy.status === 'open' ? <StatusChip tone="bad" size="sm" icon={<AlertTriangle className="h-3 w-3" aria-hidden />}>Discrepancy</StatusChip>
      : d.discrepancy.status === 'explained' ? <StatusChip tone="neutral" size="sm">Explained</StatusChip>
      : <StatusChip tone="bad" size="sm">Compromise declared</StatusChip> },
  ];
  const last = v.runs[0];

  return (
    <div className="space-y-4">
      {open.map((q) => (
        <Banner key={q.id} tone="bad" title={`${q.delta > 0 ? `${q.delta} ${v.logName} with no signature in the chain` : `${-q.delta} signatures with no ${v.logName.replace(/s$/, '')}`} · ${date(`${q.day}T12:00:00+05:30`)}`}
          actions={canCustody && <>
            <Button size="sm" variant="ghost" onClick={() => setExplain(q)}>Explain</Button>
            <Button size="sm" variant="danger" icon={<ShieldAlert className="h-4 w-4" />} onClick={() => setDeclare(q)}>Declare a compromise</Button>
          </>}>
          {q.detail} Principal: <span className="font-mono text-[12px] break-all">{q.principal}</span>.
        </Banner>
      ))}
      <Panel title="Sign-call reconciliation" kicker={v.source} flush
        actions={<>
          {open.length > 0 ? <Badge tone="bad">{open.length} open</Badge> : <Badge tone="ok">Matched</Badge>}
          {canCustody && <Button size="sm" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={busy} onClick={run}>Run now</Button>}
        </>}
        footer={<>Every Sign call should match one receipt or checkpoint signature. More calls than signatures means the key was used for something the chain does not hold. {last && <>Last run {relative(last.at)} by {userName(last.by)}{last.seq ? <> · <ReceiptLink seq={last.seq} /></> : ' (nightly at 02:00 IST)'}.</>}</>}>
        <div className="grid grid-cols-3 gap-px bg-line border-b border-line">
          <div className="bg-surface p-4"><p className="label">{v.logName} · 14 days</p><p className="mt-1 font-display text-2xl font-semibold num">{n(v.totals.calls)}</p></div>
          <div className="bg-surface p-4"><p className="label">Signatures in the chain</p><p className="mt-1 font-display text-2xl font-semibold num">{n(v.totals.signed)}</p></div>
          <div className="bg-surface p-4"><p className="label">Discrepancies</p><p className={`mt-1 font-display text-2xl font-semibold num ${open.length ? 'text-bad-fg' : ''}`}>{n(open.length)} <span className="text-sm font-normal text-muted">open · {n(v.totals.explained)} explained</span></p></div>
        </div>
        <DataTable caption="Sign calls against signatures, by day" className="border-0" columns={cols} rows={v.days} rowKey={(d) => d.day}
          rowClassName={(d) => (d.discrepancy?.status === 'open' ? 'bg-bad-bg/40' : undefined)} />
        {v.discrepancies.some((q) => q.status !== 'open') && (
          <ul className="divide-y divide-line border-t border-line">
            {v.discrepancies.filter((q) => q.status !== 'open').map((q) => (
              <li key={q.id} className="px-5 py-3 text-sm">
                <span className="font-medium">{date(`${q.day}T12:00:00+05:30`)} · {q.delta > 0 ? '+' : ''}{q.delta}</span>{' '}
                <span className="text-muted">{q.status === 'explained' ? `explained by ${userName(q.by)}` : 'compromise declared'}{q.at ? ` ${relative(q.at)}` : ''}: {q.note}</span>
                {q.seq !== undefined && <> · <ReceiptLink seq={q.seq} /></>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <ExplainDialog q={explain} onClose={() => setExplain(undefined)} />
      <DeclareCompromiseDialog open={!!declare} onClose={() => setDeclare(undefined)} discrepancyId={declare?.id}
        prefill={declare ? `${declare.delta} ${v.logName} on ${declare.day} by ${declare.principal} with no signature in the chain.` : undefined} />
    </div>
  );
}

function ExplainDialog({ q, onClose }: { q?: SignDiscrepancy; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const go = async () => {
    if (!user || !q) return;
    setBusy(true);
    try { await keysApi.explainDiscrepancy(orgId, user.id, q.id, note); toast.ok('Discrepancy explained', 'Recorded on the chain.'); setNote(''); onClose(); }
    catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={!!q} onClose={() => { setErr(undefined); onClose(); }} title="Explain the discrepancy" description={q ? `${q.delta > 0 ? '+' : ''}${q.delta} on ${q.day}, principal ${q.principal}.` : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={note.trim().length < 12} onClick={go}>Record the explanation</Button></>}>
      <div className="space-y-3">
        <Field label="What were the calls?" htmlFor="sr-note" required hint="Name a ticket, change or CloudTrail event id that someone else can check. If you cannot account for them, declare a compromise instead.">
          <Textarea id="sr-note" value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />
        </Field>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}
