import { useId, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BadgeCheck, Download, FileCheck2, ListChecks, OctagonX, PlayCircle, RotateCcw, ShieldCheck, Stamp } from 'lucide-react';
import { api } from '@/api';
import { useRole, useUser, useOrgId } from '@/store/session';
import { date, dateTime, n, seqLabel } from '@/lib/format';
import { LEVEL_INFO } from '@/lib/levels';
import { userName } from '@/mock/users';
import type { CloseoutView, FirstBundleRun } from '@/mock/upgrade';
import { Banner, Button, CodeBlock, Dialog, EmptyState, Field, Input, PageHeader, Panel, Skeleton, StatusChip, Textarea, toast } from '@/components/ui';
import { downloadText } from '@/features/activity/shared';
import { BUNDLE_CHARGE, ExportPackDialog, type ExportedSummary } from '@/features/evidence/ExportPackDialog';
import { bundleToZip, downloadBlob } from '@/features/verify/bundle';
import type { EvidenceBundle } from '@/lib/verify6';
import { rupees } from '@/lib/format';
import { CheckChip, groupFp, Mark, useCloseout } from './upgrade/shared';
import { NoticesPanel } from './upgrade/NoticesPanel';

/**
 * Door 04 · Assurance — the close-out of an L1 → L2 upgrade: signing on at the named sequence, the first-ten-records
 * check, the tenant's own first bundle and a tampered copy that exits 1, the customer notices, the closing record with
 * its seven checks, and the signed-island rollback for an upgrade that failed. Every step is a receipt.
 */
export default function CloseoutPage() {
  const nav = useNavigate();
  const role = useRole();
  const q = useCloseout();
  const v = q.data;
  const canAct = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  const phaseChip = v && v.phase !== 'none' && (
    <StatusChip tone={v.phase === 'closed' ? 'ok' : v.phase === 'rolled_back' ? 'bad' : v.phase === 'switched' ? 'held' : 'neutral'}>
      {v.phase === 'closed' ? 'Closed' : v.phase === 'rolled_back' ? 'Rolled back' : v.phase === 'switched' ? 'In close-out' : 'Being prepared'}
    </StatusChip>
  );

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Upgrade close-out"
        description="After the switch from L1 to L2: check the first signed records, export and verify your own first bundle, tell the people who rely on your records, and write the closing record. Until then a failed upgrade can be rolled back."
        crumbs={[{ label: 'Assurance levels', to: '/assurance/levels' }, { label: 'Upgrade', to: '/assurance/upgrade' }, { label: 'Close-out' }]}
        meta={phaseChip || undefined}
        actions={<Button variant="secondary" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => nav('/assurance/levels')}>Assurance levels</Button>}
      />
      {q.error && <Banner tone="bad" className="mb-6" title="The close-out could not be loaded" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}
      {q.loading && !v && <div className="grid gap-6 lg:grid-cols-12"><Skeleton className="h-96 lg:col-span-8" /><Skeleton className="h-96 lg:col-span-4" /></div>}
      {v && (v.phase === 'none' ? <NoUpgrade v={v} canAct={canAct} /> : v.phase === 'preparing' ? <Preparing v={v} canAct={canAct} /> : <Switched v={v} canAct={canAct} isOwner={isOwner} />)}
      {v && v.islands.length > 0 && <Islands v={v} />}
    </div>
  );
}

/* ── No L1 → L2 upgrade in this console ───────────────────────── */

function NoUpgrade({ v, canAct }: { v: CloseoutView; canAct: boolean }) {
  const nav = useNavigate();
  return (
    <EmptyState title={v.level === 'l1' ? 'No upgrade to L2 yet' : 'No L1 → L2 close-out recorded here'}
      action={v.level === 'l1'
        // the upgrade is prepared by owners and admins: no upgrade button for other roles
        ? (canAct ? <Button variant="primary" iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => nav('/assurance/upgrade?to=l2')}>See the upgrade to Attested</Button> : undefined)
        : <Button variant="secondary" onClick={() => nav('/assurance/levels#boundaries')}>Level boundaries</Button>}>
      {v.level === 'l1'
        ? `${v.orgName} is on L1 Guarded. The close-out starts at the switch to L2 Attested: the first-ten check, your first bundle, the notices and the closing record.`
        : `${v.orgName} is on ${LEVEL_INFO[v.level].label}. ${v.level === 'sovereign' ? 'It started on its own infrastructure, so there was no move from L1 to L2.' : 'It reached L2 before the close-out was recorded in this console; its boundary and counts are under Level boundaries.'}`}
    </EmptyState>
  );
}

/* ── Before the switch ────────────────────────────────────────── */

function Preparing({ v, canAct }: { v: CloseoutView; canAct: boolean }) {
  const nav = useNavigate();
  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-8 space-y-6">
        <Banner tone="info" title="The switch has not happened yet" actions={canAct ? <Button size="sm" variant="primary" onClick={() => nav('/assurance/upgrade?to=l2')}>Continue the upgrade</Button> : undefined}>
          The upgrade to Attested was started by {userName(v.run!.by)} on {date(v.run!.at)}. The close-out begins when an owner signs on at the named record.
        </Banner>
        <Panel title="Customer notices" kicker="Before and on the boundary"><NoticesPanel view={v} canAct={canAct} /></Panel>
      </div>
      <div className="lg:col-span-4 space-y-6">
        <Panel title="So far" kicker="From the chain">
          <ul className="space-y-2 text-sm">
            <li>Pre-flight: {v.preflight ? <Link className="link font-mono" to={`/activity/${v.preflight.seq}`}>{seqLabel(v.preflight.seq)}</Link> : 'not run'}</li>
            <li>Key: {v.key ? <><span className="font-mono">{v.key.kid}</span> {v.key.comparedSeq ? '· compared' : '· not compared yet'}</> : 'not created'}</li>
            <li>Would sign on at <span className="font-mono">{seqLabel(v.nextSigningSeq)}</span> if confirmed now</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/* ── After the switch ─────────────────────────────────────────── */

function Switched({ v, canAct, isOwner }: { v: CloseoutView; canAct: boolean; isOwner: boolean }) {
  const frozen = v.phase === 'closed' || v.phase === 'rolled_back';
  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-8 space-y-6">
        {v.phase === 'rolled_back' && v.rolledBack && (
          <Banner tone="bad" title={`Rolled back ${dateTime(v.rolledBack.at)} by ${userName(v.rolledBack.by)}`}>
            {v.rolledBack.reason} Records {seqLabel(v.rolledBack.firstSeq)}–{seqLabel(v.rolledBack.lastSeq)} stay as a signed island; {v.orgName} is on L1 Guarded again and its records are sealed in a hash chain.
          </Banner>
        )}
        <BoundaryStrip v={v} />
        <SigningOn v={v} />
        <FirstTen v={v} canAct={canAct && !frozen} />
        <FirstBundle v={v} canAct={canAct && v.phase !== 'rolled_back'} />
        <Panel title="Customer notices" kicker="4 · Tell the people who rely on your records"><NoticesPanel view={v} canAct={canAct} /></Panel>
      </div>
      <div className="lg:col-span-4 space-y-6">
        <Closing v={v} canAct={canAct} />
        <Rollback v={v} isOwner={isOwner} />
      </div>
    </div>
  );
}

function BoundaryStrip({ v }: { v: CloseoutView }) {
  return (
    <div className="grid sm:grid-cols-4 gap-px bg-line border border-line">
      <Fig k="Boundary" v={v.boundary ? date(v.boundary.at) : '—'} sub={v.upgrade ? <>by {userName(v.upgrade.by)} · <Link className="link font-mono" to={`/activity/${v.upgrade.seq}`}>{seqLabel(v.upgrade.seq)}</Link></> : undefined} />
      <Fig k="Before · L1" v={n(v.boundary?.recordsBefore ?? 0)} sub="sealed in a hash chain, for ever" />
      <Fig k={v.phase === 'rolled_back' ? 'Island · L2' : 'After · L2'} v={n(v.phase === 'rolled_back' ? v.rolledBack?.records ?? 0 : v.boundary?.recordsAfter ?? 0)} sub={v.phase === 'rolled_back' ? 'signed, kept as an island' : 'sealed, signed and timestamped'} />
      <Fig k="Signing on" v={v.signing ? seqLabel(v.signing.seq) : '—'} sub={v.signing?.namedSeq !== undefined ? (v.signing.namedSeq === v.signing.seq ? 'as named before the switch' : `${seqLabel(v.signing.namedSeq)} was named`) : 'first record with the bound key'} />
    </div>
  );
}

function SigningOn({ v }: { v: CloseoutView }) {
  const sg = v.signing;
  return (
    <Panel title="Signing on" kicker="1 · The named instant">
      {!sg ? <p className="text-sm text-muted">No record has been signed with the new key yet.</p> : (
        <div className="space-y-3 text-sm">
          <p>
            The first record signed with <span className="font-mono">{sg.kid}</span> is <Link className="link font-mono" to={`/activity/${sg.seq}`}>{seqLabel(sg.seq)}</Link>, written {dateTime(sg.at)}.
            {sg.namedSeq !== undefined && (sg.namedSeq === sg.seq ? ' It is the record the confirm screen named before the switch.' : ` The confirm screen named ${seqLabel(sg.namedSeq)}.`)}
          </p>
          <div className="grid sm:grid-cols-2 gap-px bg-line border border-line">
            <Fig k="Fingerprint compared out of band" v={<span className="font-mono text-base">{groupFp(v.key?.fingerprint)}</span>} sub={v.key?.channel ?? (v.key?.comparedSeq ? 'compared before the switch' : 'not compared')} />
            <Fig k="Fingerprint of the signing key" v={<span className="font-mono text-base">{groupFp(sg.fingerprint)}</span>} sub={v.key?.fingerprint && v.key.fingerprint === sg.fingerprint ? 'the same key' : 'differs from the bound key'} />
          </div>
          {sg.leadDays !== undefined && <p className="text-xs text-muted">The 14-day notice went {sg.leadDays} day{sg.leadDays === 1 ? '' : 's'} before the switch{sg.earlyAgreed ? '; the named contact agreed to the earlier date, and the signing-on record says so' : ''}.</p>}
        </div>
      )}
    </Panel>
  );
}

function FirstTen({ v, canAct }: { v: CloseoutView; canAct: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const rows = v.firstTen.rows;
  const rec = v.firstTen.recorded;
  const run = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await api.runFirstTen(orgId, user.id);
      (r.pass ? toast.ok : toast.bad)(r.pass ? 'All ten records pass' : 'The first-ten check failed', `Recorded as ${seqLabel(r.seq)}.`);
    } catch (e) { toast.bad('The check could not run', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Panel title="First ten records" kicker="2 · Fingerprint check after the switch" flush
      footer="Each record: signed by the bound key, whose fingerprint matches the one compared out of band; content hash recomputed; signature verified; linked to the record before it.">
      {rows.length === 0 ? <p className="p-5 text-sm text-muted">No signed records yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">The first ten records signed with the new key</caption>
            <thead className="bg-sunken/60 text-left">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:label [&>th]:font-normal">
                <th scope="col">Record</th><th scope="col">What</th><th scope="col">Key</th><th scope="col">Fingerprint</th><th scope="col">Hash</th><th scope="col">Signature</th><th scope="col">Link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.seq} className="[&>td]:px-3 [&>td]:py-2 align-top">
                  <td><Link className="link font-mono" to={`/activity/${r.seq}`}>{seqLabel(r.seq)}</Link></td>
                  <td className="font-mono text-[12px] break-all">{r.what}</td>
                  <td><Mark ok={r.kidOk} label="Bound key" /></td>
                  <td><span className="font-mono text-[12px] block">{groupFp(r.fingerprint)}</span><Mark ok={r.fingerprintOk} label="Fingerprint matches" /></td>
                  <td><Mark ok={r.hashOk} label="Hash" /></td>
                  <td><Mark ok={r.sigOk} label="Signature" /></td>
                  <td><Mark ok={r.linkOk} label="Linked" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-5 py-4 border-t border-line flex flex-wrap items-center gap-3">
        {rec && <StatusChip tone={rec.result === 'pass' ? 'ok' : 'bad'} icon={rec.result === 'pass' ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> : <OctagonX className="h-3.5 w-3.5" aria-hidden />}>{rec.result === 'pass' ? 'All ten pass' : 'Failed'} · <Link className="underline underline-offset-2 font-mono" to={`/activity/${rec.seq}`}>{seqLabel(rec.seq)}</Link></StatusChip>}
        {rec && <span className="text-xs text-muted">Recorded by {userName(rec.by)} · {dateTime(rec.at)}</span>}
        {canAct && <Button variant={rec ? 'secondary' : 'primary'} icon={<ListChecks className="h-4 w-4" />} loading={busy} disabled={rows.length < 10} onClick={run}
          title={rows.length < 10 ? `${rows.length} of 10 records signed so far.` : undefined}>
          {rec ? 'Run it again' : 'Run the check and record it'}
        </Button>}
        {rows.length < 10 && <span className="text-xs text-muted">{rows.length} of 10 records signed so far.</span>}
      </div>
    </Panel>
  );
}

function FirstBundle({ v, canAct }: { v: CloseoutView; canAct: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<FirstBundleRun>();
  const [err, setErr] = useState<string>();
  const rec = v.firstBundle;
  const file = `${v.slug}-first-bundle.json`;
  const bad = `${v.slug}-first-bundle-tampered.json`;
  // the bundle leaves through the export dialog, with every export check, "Verify it yourself first", the charge and ZIP
  const [exporting, setExporting] = useState(false);
  const go = async (x: ExportedSummary) => {
    if (!user) return;
    const json = x.jsons?.[0];
    if (!json) { setErr('The export returned no bundle to verify.'); return; }
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.runFirstBundle(orgId, user.id, { exportId: x.exportIds?.[0] ?? x.exportId, json });
      setRun(r);
      const good = r.result.exitCode === 0 && r.tampered.exitCode === 1;
      (good ? toast.ok : toast.bad)(good ? 'Your bundle exits 0; the tampered copy exits 1' : 'The first bundle did not behave as expected', `Recorded as ${seqLabel(r.seq)}.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const terminal = (name: string, res: FirstBundleRun['result'], fp: string) => [
    `$ govern verify ${name} --fingerprint ${fp}`,
    ...res.sections.filter((s) => s.state !== 'not_applicable').map((s) => `  ${s.state === 'pass' ? 'ok  ' : s.state === 'fail' ? 'FAIL' : s.state === 'warn' ? 'warn' : '--  '} ${s.number}. ${s.title}${s.state === 'fail' ? ` — ${s.detail}` : ''}`),
    `${res.code}: ${res.headline}`,
    `exit ${res.exitCode}`,
  ].join('\n');
  return (
    <Panel title="Your first bundle, and a tampered copy" kicker="3 · Before anyone else checks it" footer="If it does not pass for you, it will not pass for your auditor. The tampered copy shows the verifier refusing a changed record.">
      <p className="text-sm text-muted">Exports an evidence bundle from {v.signing ? seqLabel(v.signing.seq) : 'the signing-on record'} to the head, as you would hand it over, and verifies it here with the fingerprint you compared out of band. Then one value in one record of a copy is changed and the copy is verified the same way.</p>
      {err && <Banner tone="bad" className="mt-3">{err}</Banner>}
      {run ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2"><p className="font-medium">Your bundle</p><StatusChip tone={run.result.exitCode === 0 ? 'ok' : 'bad'}>{run.result.code} · exit {run.result.exitCode}</StatusChip></div>
            <CodeBlock code={terminal(file, run.result, run.fingerprint)} wrap maxHeight={260} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadBlob(file.replace(/\.json$/, '.zip'), bundleToZip(JSON.parse(run.json) as EvidenceBundle))}>Download the bundle (ZIP)</Button>
              <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(file, run.json)}>JSON</Button>
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2"><p className="font-medium">Tampered copy</p><StatusChip tone={run.tampered.exitCode === 1 ? 'ok' : 'bad'}>{run.tampered.code} · exit {run.tampered.exitCode}</StatusChip></div>
            <CodeBlock code={terminal(bad, run.tampered, run.fingerprint)} wrap maxHeight={260} />
            <p className="mt-2 text-xs text-muted">Changed {seqLabel(run.tamperedSeq)} {run.field}: “{run.before}” → “{run.after}”. {run.tampered.exitCode === 1 ? 'The verifier refused it, as it should.' : 'The verifier should have exited 1.'}</p>
            <Button className="mt-2" size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(bad, run.tamperedJson)}>Download the tampered copy</Button>
          </div>
        </div>
      ) : rec ? (
        <div className="mt-4 grid gap-px bg-line border border-line sm:grid-cols-2">
          <Fig k="Your bundle" v={`${rec.code} · exit ${rec.exitCode}`} sub={<>{rec.receipts ? `${n(rec.receipts)} records · ` : ''}by {userName(rec.by)} {dateTime(rec.at)} · <Link className="link font-mono" to={`/activity/${rec.seq}`}>{seqLabel(rec.seq)}</Link></>} />
          <Fig k="Tampered copy" v={`${rec.tamperedCode} · exit ${rec.tamperedExitCode}`} sub={`${rec.tamperedSeq ? `${seqLabel(rec.tamperedSeq)} ` : ''}${rec.tamperedField ?? ''} changed`} />
        </div>
      ) : null}
      {canAct && <>
        <Button className="mt-4" variant={rec ? 'secondary' : 'primary'} icon={<PlayCircle className="h-4 w-4" />} loading={busy} disabled={!v.signing} onClick={() => setExporting(true)}
          title={`Opens the export: its checks, verify it yourself first, then ${rupees(BUNDLE_CHARGE)} for the bundle`}>
          {rec || run ? `Export and run both again · ${rupees(BUNDLE_CHARGE)}` : `Export, verify, and run the tampered copy · ${rupees(BUNDLE_CHARGE)}`}
        </Button>
        <p className="mt-2 text-xs text-muted">An evidence bundle is {rupees(BUNDLE_CHARGE)}, added to this month’s invoice. The export runs the same checks as every other export first.</p>
      </>}
      {!canAct && !rec && !run && <p className="mt-3 text-sm text-muted">Not run yet.</p>}
      <ExportPackDialog open={exporting} requireVerify onClose={() => setExporting(false)} initialFrom={v.signing?.seq} title="Your first bundle"
        note={<>From the signing-on record {v.signing ? seqLabel(v.signing.seq) : ''} to the head, as you would hand it over. Once it is made, it is verified here with your fingerprint and a tampered copy is checked too.</>}
        onExported={(x) => void go(x)} />
    </Panel>
  );
}

function Closing({ v, canAct }: { v: CloseoutView; canAct: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const passing = v.checks.filter((c) => c.state === 'pass').length;
  const write = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await api.writeClosingRecord(orgId, user.id);
      toast.ok('The closing record is written', `${seqLabel(r.seq)}: 7 of 7 checks pass. The upgrade is final.`);
    } catch (e) { toast.bad('The closing record was not written', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Panel title="Closing record" kicker={`5 · Seven checks · ${passing} of 7 pass`} flush>
      <ol className="divide-y divide-line">
        {v.checks.map((c) => (
          <li key={c.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium"><span className="font-mono text-muted mr-1.5">{c.n}</span>{c.label}</p>
              <CheckChip state={c.state} />
            </div>
            <p className="mt-0.5 text-xs text-muted">{c.detail}{c.seq ? <> · <Link className="link font-mono" to={`/activity/${c.seq}`}>{seqLabel(c.seq)}</Link></> : null}</p>
          </li>
        ))}
      </ol>
      <div className="px-4 py-4 border-t border-line">
        {v.closed ? (
          <Banner tone="ok" title={`Closed ${dateTime(v.closed.at)}`}>
            Written by {userName(v.closed.by)} as <Link className="link font-mono" to={`/activity/${v.closed.seq}`}>{seqLabel(v.closed.seq)}</Link>: {v.closed.checks} checks pass. The upgrade is final; it can no longer be rolled back.
          </Banner>
        ) : v.phase === 'rolled_back' ? (
          <p className="text-sm text-muted">This upgrade was rolled back, so it has no closing record.</p>
        ) : (
          <>
            {canAct && <Button variant="primary" block icon={<FileCheck2 className="h-4 w-4" />} loading={busy} disabled={passing < 7} onClick={write}
              title={passing < 7 ? 'Every check must pass first.' : undefined}>
              Write the closing record
            </Button>}
            <p className="mt-2 text-xs text-muted">{passing < 7 ? `${7 - passing} check${7 - passing === 1 ? '' : 's'} to go. ` : ''}The record names all seven results; after it, the upgrade cannot be rolled back.</p>
          </>
        )}
      </div>
    </Panel>
  );
}

function Rollback({ v, isOwner }: { v: CloseoutView; isOwner: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const ids = { r: useId(), t: useId() };
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const role = useRole();
  const canPrepare = role === 'owner' || role === 'admin';
  if (v.phase === 'rolled_back') {
    const rb = v.rolledBack;
    return (
      <Panel title="Rolled back" kicker="The rollback record">
        {rb ? (
          <>
            <p className="text-sm leading-relaxed">{userName(rb.by)} rolled this upgrade back {dateTime(rb.at)}, before its closing record. Nothing was deleted.</p>
            <ul className="mt-3 text-sm space-y-1.5">
              <li>Signed island: <span className="font-mono">{seqLabel(rb.firstSeq)}–{seqLabel(rb.lastSeq)}</span>, {n(rb.records)} records signed with <span className="font-mono">{rb.kid}</span>. They keep verifying.</li>
              <li>The KMS key is retired for signing; its public key stays in keys.json.</li>
              <li>{v.orgName} is on L1 Guarded; its records are sealed in a hash chain by an Elan1 Govern process key.</li>
              <li>The L2 period is withdrawn from the level history and from billing.</li>
            </ul>
            <p className="mt-3 text-xs text-muted">Recorded as <Link className="link font-mono" to={`/activity/${rb.seq}`}>{seqLabel(rb.seq)}</Link>.</p>
          </>
        ) : <p className="text-sm text-muted">This upgrade was rolled back.</p>}
        {v.level === 'l1' && canPrepare && <Button className="mt-3" variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => nav('/assurance/upgrade?to=l2')}>Prepare a new upgrade</Button>}
      </Panel>
    );
  }
  const go = async () => {
    if (!user) return;
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.rollbackUpgrade(orgId, user.id, reason);
      toast.info('Upgrade rolled back', `Records ${seqLabel(r.islandFirst)}–${seqLabel(r.islandLast)} stay as a signed island. Recorded as ${seqLabel(r.seq)}.`);
      setOpen(false);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const ready = reason.trim().length >= 10 && typed.trim() === v.orgName;
  return (
    <Panel title="Roll back a failed upgrade" kicker="Until the closing record">
      <p className="text-sm text-muted leading-relaxed">If a check fails and cannot be fixed, roll back. Nothing is deleted: the records signed with {v.signing?.kid ?? 'the new key'} stay in the chain as a signed island and keep verifying. {v.orgName} returns to L1 Guarded, a new Elan1 Govern key seals from then on, and the L2 period is withdrawn from the level history and from billing.</p>
      {/* only an owner rolls back: other roles see the note below, not a disabled button */}
      {v.canRollBack
        ? (isOwner && <Button className="mt-3" variant="danger" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setOpen(true)}>Roll back to L1</Button>)
        : <p className="mt-3 text-xs text-muted">{v.whyNoRollback}</p>}
      {v.canRollBack && !isOwner && <p className="mt-2 text-xs text-muted">Only an owner rolls back an upgrade.</p>}
      <Dialog open={open} onClose={() => setOpen(false)} tone="danger" title="Roll back the upgrade to Attested?"
        description={`Records ${v.signing ? seqLabel(v.signing.seq) : ''} to the head become a signed island. ${v.orgName} returns to L1 Guarded.`}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Keep the upgrade</Button><Button variant="danger" icon={<RotateCcw className="h-4 w-4" />} loading={busy} disabled={!ready} onClick={go}>Roll back now</Button></>}>
        <div className="space-y-4">
          <Field label="Why it is rolled back" htmlFor={ids.r} hint="Goes into the rollback record." error={reason && reason.trim().length < 10 ? 'At least 10 characters.' : undefined}>
            <Textarea id={ids.r} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The first bundle failed with FAIL_INTEGRITY at a seal; we are not confident in the new key." />
          </Field>
          <Field label={<>Type <span className="font-mono">{v.orgName}</span> to confirm</>} htmlFor={ids.t} error={typed && typed.trim() !== v.orgName ? 'The name must match exactly.' : undefined}>
            <Input id={ids.t} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
          <ul className="text-xs text-muted space-y-1 list-disc pl-4">
            <li>Scheduled notices are cancelled; tell your named contact and auditor yourself.</li>
            <li>The KMS key is retired for signing; its public key stays in keys.json so the island verifies.</li>
            <li>You can start a new upgrade later; it will name a new boundary.</li>
          </ul>
          {err && <Banner tone="bad">{err}</Banner>}
          <Button size="sm" variant="ghost" icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => nav('/verify')}>Open the verifier</Button>
        </div>
      </Dialog>
    </Panel>
  );
}

function Islands({ v }: { v: CloseoutView }) {
  return (
    <section className="mt-8" aria-labelledby="islands-h">
      <Panel title={<span id="islands-h">Signed islands</span>} kicker="Rolled-back upgrades" flush footer="An island is a run of records signed with a key from an upgrade that was rolled back. They stay in the chain and keep verifying; the records around them are sealed in a hash chain at L1.">
        <ul className="divide-y divide-line">
          {v.islands.map((i) => (
            <li key={i.seq} className="px-5 py-4 grid gap-2 sm:grid-cols-12 text-sm">
              <div className="sm:col-span-4"><p className="font-medium inline-flex items-center gap-1.5"><Stamp className="h-4 w-4 text-muted" aria-hidden />{seqLabel(i.firstSeq)}–{seqLabel(i.lastSeq)}</p><p className="text-xs text-muted">{n(i.records)} records · rolled back {dateTime(i.at)} by {userName(i.by)}</p></div>
              <div className="sm:col-span-4"><p className="label">Key</p><p className="font-mono text-[12.5px]">{i.kid}</p><p className="font-mono text-[12px] text-muted">{groupFp(i.fingerprint)}</p></div>
              <div className="sm:col-span-4"><p className="label">Reason</p><p>{i.reason}</p><Link className="link text-xs font-mono" to={`/activity/${i.seq}`}>{seqLabel(i.seq)}</Link></div>
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

function Fig({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="bg-surface p-3 min-w-0">
      <p className="label">{k}</p>
      <p className="mt-1 font-display text-lg font-semibold num break-words">{v}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}
