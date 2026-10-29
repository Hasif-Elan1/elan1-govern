/**
 * Nightly integrity runs and the continuity report (Assurance › Proof › Integrity runs, summarised on the
 * Assurance overview). Each night at 02:00 IST a run picks up at the record after the previous run's head and
 * recomputes every content hash and link and every checkpoint up to the head. A run on demand also checks every
 * signature (L2+) or seal (L1) across the window, and is written to the chain as evidence.integrity_run.
 * "Continuous" is never shown with a tick: what a run did not reach is shown as "not checked over this range".
 * L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
 */
import { Link } from 'react-router-dom';
import { CalendarClock, FileDown, OctagonX, Play, ScanSearch } from 'lucide-react';
import { api, db } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { n, plural, relative, seqLabel } from '@/lib/format';
import { pdfBlob } from '@/lib/pdf';
import { continuityPdf, type ContinuityReport, type IntegrityRun } from '@/mock/evidence';
import { userName } from '@/mock/users';
import { Banner, Button, DataTable, Panel, Skeleton, Stat, StatusChip, toast, type Column } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { downloadBlob, verifyBundleOffThread } from '@/features/verify/bundle';

/** The state of the range a run has not reached: shown wherever the chain's standing is. */
export function UncheckedChip({ report }: { report?: ContinuityReport }) {
  if (!report) return null;
  if (report.failures.length) return <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Integrity run failed</StatusChip>;
  if (report.unchecked) return <StatusChip tone="held" size="sm" icon={<ScanSearch className="h-3 w-3" aria-hidden />}>Not checked over {seqLabel(report.unchecked.from)}–{seqLabel(report.unchecked.to)}</StatusChip>;
  return <StatusChip tone="neutral" size="sm" icon={<CalendarClock className="h-3 w-3" aria-hidden />}>Checked to the head</StatusChip>;
}

/**
 * Run the integrity check over the whole window now: signatures are checked in the verifier's worker, so the page
 * stays responsive; the result is then recorded as evidence.integrity_run. Used here and by the export dialog, which
 * needs a completed run over the range before an L2+ bundle leaves.
 */
export async function runIntegrityCheck(orgId: string, userId: string) {
  const d = db.getDB(orgId);
  const rs = d.receipts.slice();
  if (!rs.length) throw new Error('There are no receipts to check yet.');
  const head = rs[rs.length - 1].seq;
  const res = await verifyBundleOffThread({ manifest: {}, public_keys: { ...d.publicKeys }, receipts: rs, checkpoints: d.checkpoints.filter((c) => c.seq <= head) }, {});
  const c = res.chain;
  if (!c) throw new Error('The check returned no chain report.');
  return api.runIntegrity(orgId, userId, {
    fromSeq: rs[0].seq, toSeq: head, records: rs.length, hashes: c.checks.filter((x) => x.hash === 'pass').length, signatures: c.checks.filter((x) => x.signature === 'pass').length,
    checkpoints: c.checkpoints.total, checkpointsValid: c.checkpoints.valid, brokenAt: c.brokenAt, reason: c.brokenReason, ms: res.ms,
  });
}

export function useIntegrity() {
  return useQuery((o) => api.integrityRuns(o), [], { kinds: ['receipt', 'checkpoint'] });
}

export function IntegrityRunsPanel() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const canRun = useCan('evidence.export');
  const { data, loading, error, refetch } = useIntegrity();
  // the signatures are checked in the verifier's worker, so the page stays responsive; the result is then recorded
  const run = useMutation(() => runIntegrityCheck(orgId, user?.id ?? ''));

  const runNow = async () => {
    try {
      const r = await run.mutate();
      refetch();
      // an auditor's check is read-only: shown to them, not written to the client's chain, so it clears no export
      const recorded = r.readOnly ? 'Not recorded: your check as an auditor is read-only on the client’s chain, so it does not clear an export.' : `Recorded as ${r.seq !== undefined ? seqLabel(r.seq) : 'a receipt'}.`;
      if (r.result === 'pass') toast.ok('Integrity check passed', `${plural(r.records, 'record')} ${seqLabel(r.fromSeq)}–${seqLabel(r.toSeq)}: ${n(r.checked.hashes)} hashes, ${n(r.checked.signatures)} ${l2 ? 'signatures' : 'seals'}, ${n(r.checked.checkpoints)} checkpoints. ${recorded}`);
      else toast.bad('Integrity check failed', `${r.reason ?? 'The chain does not verify'}${r.brokenAt !== undefined ? ` (at ${seqLabel(r.brokenAt)})` : ''}. ${recorded}`);
    } catch (e) { toast.bad('The check could not run', (e as Error).message); }
  };

  const downloadReport = () => {
    if (!data || !user) return;
    const d = db.getDB(orgId);
    const pdf = continuityPdf(d, data, user.name);
    downloadBlob(`continuity-report-${d.org.slug}-${new Date().toISOString().slice(0, 10)}-DRAFT.pdf`, pdfBlob(pdf));
    const r = db.logAdmin(orgId, user.id, 'evidence.continuity_report', { runs: data.runs.length, covered_from: data.coveredFrom ?? 0, covered_to: data.coveredTo ?? 0, gaps: data.gaps.length, failures: data.failures.length, unchecked: data.unchecked?.count ?? 0 });
    refetch();
    toast.ok('Continuity report downloaded', `Marked “Draft — needs legal review”. The download is ${seqLabel(r.seq)}.`);
  };

  const cols: Column<IntegrityRun>[] = [
    { key: 'at', header: 'Run', sort: (r) => r.at, cell: (r) => <span className="block"><When iso={r.at} className="text-sm" /><span className="block text-xs text-muted">{r.kind === 'nightly' ? 'Nightly, 02:00 IST' : `On demand${r.by ? ` · ${userName(r.by)}` : ''}`}</span></span> },
    { key: 'range', header: 'Range', cell: (r) => (r.records ? <span className="font-mono text-[12px] whitespace-nowrap">{seqLabel(r.fromSeq)}–{seqLabel(r.toSeq)}</span> : <span className="text-xs text-muted">Nothing new · head {seqLabel(r.toSeq)}</span>) },
    { key: 'records', header: 'Records', align: 'right', sort: (r) => r.records, cell: (r) => n(r.records) },
    { key: 'checks', header: 'Recomputed', hideBelow: 'md', cell: (r) => <span className="text-xs text-muted">{n(r.checked.hashes)} hashes · {n(r.checked.links)} links · {n(r.checked.checkpoints)} checkpoints{r.checked.signatures ? ` · ${n(r.checked.signatures)} ${l2 ? 'signatures' : 'seals'}` : ''}</span> },
    { key: 'result', header: 'Result', cell: (r) => (r.result === 'pass'
      ? <StatusChip tone="neutral" size="sm">Pass</StatusChip>
      : <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Fail at {r.brokenAt !== undefined ? seqLabel(r.brokenAt) : '—'}</StatusChip>) },
    { key: 'seq', header: 'Receipt', hideBelow: 'lg', cell: (r) => (r.seq !== undefined ? <ReceiptLink seq={r.seq} /> : <span className="text-xs text-subtle">Integrity log</span>) },
  ];

  const nightly = data?.runs.filter((r) => r.kind === 'nightly') ?? [];
  const lastNightly = nightly[0];

  return (
    <div className="space-y-6">
      {error && <Banner tone="bad" title="Integrity runs could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Stat label="Last nightly run" value={lastNightly ? relative(lastNightly.at) : '—'} sub={lastNightly ? (lastNightly.records ? `${plural(lastNightly.records, 'record')} new` : 'Nothing new that night') : loading ? undefined : 'No run yet'} />
        <Stat label="Covered without a gap" value={data?.coveredFrom !== undefined ? <span className="font-mono text-2xl">{seqLabel(data.coveredFrom)}</span> : '—'} sub={data?.coveredTo !== undefined ? <>to <span className="font-mono">{seqLabel(data.coveredTo)}</span> · {plural(nightly.length, 'night')}</> : undefined} />
        <Stat label="Gaps and failures" value={data ? n(data.gaps.length + data.failures.length) : '—'} sub={data ? (data.gaps.length + data.failures.length ? 'See the runs below' : 'Each run began where the last one ended') : undefined} />
        <Stat label="Not checked yet" value={data ? n(data.unchecked?.count ?? 0) : '—'} sub={data?.unchecked ? <span className="font-mono">{seqLabel(data.unchecked.from)}–{seqLabel(data.unchecked.to)}</span> : data ? 'The last run reached the head' : undefined} />
      </div>

      <Panel title="Integrity runs" kicker="Nightly at 02:00 IST, and on demand" flush
        actions={canRun ? (
          // owners, admins and auditors: viewers read the runs without the buttons
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<FileDown className="h-3.5 w-3.5" />} onClick={downloadReport} disabled={!data}>Continuity report (PDF)</Button>
            <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={run.pending} onClick={runNow}>Run the check now</Button>
          </div>
        ) : undefined}
        footer={<>Each nightly run recomputes the content hash and link of every record written since the previous run, and every checkpoint. A run on demand also checks every {l2 ? 'signature' : 'Ed25519 seal'} in the window and is written to the chain; an auditor’s run is a read-only check and is not. A pass shows the records are unaltered and continuous; it does not show the underlying actions happened. <Link to="/activity/chain" className="link">Open the chain explorer</Link>.</>}>
        {data?.unchecked && (
          <div className="px-5 py-3 border-b border-line bg-held-bg/30 text-sm flex flex-wrap items-center gap-2">
            <ScanSearch className="h-4 w-4 text-held-fg" aria-hidden />
            <span><span className="font-medium">Not checked over {seqLabel(data.unchecked.from)}–{seqLabel(data.unchecked.to)}.</span> <span className="text-muted">{plural(data.unchecked.count, 'record')} written since the last run; the next nightly run picks them up, or run the check now.</span></span>
          </div>
        )}
        {loading && !data ? <div className="p-5"><Skeleton className="h-40" /></div> : (
          <DataTable caption="Integrity runs" className="border-0" columns={cols} rows={data?.runs} rowKey={(r) => r.id} loading={loading && !data} />
        )}
      </Panel>
    </div>
  );
}

/** A compact block for the Assurance overview: the last run and the range it has not reached. */
export function IntegritySummary({ report }: { report?: ContinuityReport }) {
  if (!report) return <Skeleton className="h-16" />;
  const last = report.lastRun;
  return (
    <div className="text-sm text-muted space-y-1.5">
      <p>
        {last ? <>Last run {relative(last.at)} ({last.kind === 'nightly' ? 'nightly' : 'on demand'}): {last.result === 'pass' ? 'no break found' : `broken at ${last.brokenAt !== undefined ? seqLabel(last.brokenAt) : '—'}`}, up to <span className="font-mono">{seqLabel(last.toSeq)}</span>.</> : 'No integrity run yet.'}
      </p>
      {report.coveredFrom !== undefined && <p>Nightly runs cover <span className="font-mono">{seqLabel(report.coveredFrom)}</span>–<span className="font-mono">{seqLabel(report.coveredTo!)}</span> with {report.gaps.length ? plural(report.gaps.length, 'gap') : 'no gap'}.</p>}
      <div className="flex flex-wrap items-center gap-2 pt-0.5"><UncheckedChip report={report} />{report.failures.length === 0 && !report.unchecked && <span className="text-xs">The head is covered.</span>}</div>
    </div>
  );
}
