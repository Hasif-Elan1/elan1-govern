import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, FileJson, FileSpreadsheet, Info, MapPin, PackageCheck, PackagePlus, CircleCheck, CircleX, Hourglass } from 'lucide-react';
import { api, db } from '@/api';
import { useQuery, useMutation } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Framework, PackId } from '@/types';
import { Badge, Banner, Button, DataTable, EmptyState, Help, LegalDraft, Menu, Meter, PageHeader, Panel, ProgressArc, Skeleton, Stat, StatusChip, Switch, Tooltip, toast, type Column } from '@/components/ui';
import { When } from '@/components/domain';
import { n, plural, rupees } from '@/lib/format';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { packAdmissions } from '@/features/assessments/backend';
import { UpgradeLink } from '@/features/agents/levelPreview';
import { DryRunChip } from '@/features/packs/parts';
import { COVERAGE_NOTE, buildReport, coverageOf, download, evidenceClaim, indexControls, isIndia, liveControls, reportCsv, requirementsOf, type LiveControl } from './evidence';
import { packFrameworks, type PackFramework } from './regimes';
import { ControlDrawer, ControlStatusChip, ProfileVerify } from './parts';
import { FileText } from 'lucide-react';
import { complianceReportPdf, downloadPdf } from '@/features/evidence/frameworkPdf';

export default function CompliancePage() {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const canManage = useCan('compliance.manage');
  const canExportEvidence = useCan('evidence.export');
  const canExport = canManage || canExportEvidence;
  const canAdmit = useCan('assessments.author');
  const [params, setParams] = useSearchParams();

  const q = useQuery((o) => api.compliance(o));
  const packsQ = useQuery((o) => api.packs(o), [level], { kinds: ['pack', 'receipt', 'level'] });
  const admQ = useQuery((o) => packAdmissions(o), [], { kinds: ['assessment', 'receipt'] });
  const toggle = useMutation((id: string, on: boolean) => api.setFramework(orgId, id, on, user!.id));
  const install = useMutation((id: PackId) => api.installPack(orgId, id, user!.id));
  const [installing, setInstalling] = useState<PackId>();

  const controls: LiveControl[] = useMemo(() => (q.data ? liveControls(orgId, q.data.controls) : []), [q.data, orgId, level]);
  const byId = useMemo(() => indexControls(controls), [controls]);
  const frameworks = q.data?.frameworks ?? [];
  const installed = (packsQ.data ?? []).filter((p) => p.installed).map((p) => p.id);
  const packFws: PackFramework[] = useMemo(() => packFrameworks(installed), [installed.join(',')]);
  const allFws: Framework[] = [...frameworks, ...packFws];
  const enabled = allFws.filter((f) => f.enabled);
  const covs = useMemo(() => Object.fromEntries(allFws.map((f) => [f.id, coverageOf(f, byId)])), [allFws, byId]);
  const totals = enabled.reduce((s, f) => ({ covered: s.covered + covs[f.id].covered, total: s.total + covs[f.id].total, gaps: s.gaps + covs[f.id].gaps }), { covered: 0, total: 0, gaps: 0 });
  const openControl = params.get('control') ?? undefined;

  // Receipt pages link to a control as /compliance#<controlId>: open that control's drawer, select its row and scroll to the controls.
  const { hash } = useLocation();
  const hashControl = hash ? decodeURIComponent(hash.slice(1)) : undefined;
  useEffect(() => {
    if (!hashControl || !byId[hashControl]) return;
    const p = new URLSearchParams(params);
    p.set('control', hashControl);
    setParams(p, { replace: true }); // drops the hash, so this runs once per link
    window.setTimeout(() => document.getElementById('controls')?.scrollIntoView({ block: 'start' }), 0);
  }, [hashControl, byId]);
  const controlRange = controls.length ? `${controls[0].id} to ${controls[controls.length - 1].id}` : '';

  const onToggle = async (f: Framework, on: boolean) => {
    try {
      await toggle.mutate(f.id, on);
      toast.ok(`${f.short} ${on ? 'turned on' : 'turned off'}`, on ? 'Its requirements now count in coverage and the crosswalk.' : 'It no longer counts in coverage. Mappings are kept.');
    } catch (e) {
      toast.bad('The framework did not change', (e as Error).message);
    }
  };

  const onInstall = async (id: PackId) => {
    setInstalling(id);
    try {
      await install.mutate(id);
      toast.ok(l2 ? `${id} installed` : `${id} installed as a dry run`, l2
        ? `Its regime now counts in coverage. Admit it for each agent with an admission assessment. ${rupees(135000)} a year is added to invoices.`
        : `It runs as a dry run at ${LEVEL_INFO.l1.label}, with no regulatory claim and no charge until ${LEVEL_INFO.l2.label}. Admit it for each agent with an admission assessment.`);
    } catch (e) {
      toast.bad(`${id} was not installed`, (e as Error).message);
    } finally {
      setInstalling(undefined);
    }
  };

  const exportReport = (kind: 'json' | 'csv' | 'pdf') => {
    if (!user) return;
    const report = buildReport(api.org(orgId).name, allFws, controls, user.name, level);
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'json') download(`compliance-report-DRAFT-${stamp}.json`, JSON.stringify(report, null, 2), 'application/json');
    else if (kind === 'pdf') downloadPdf(`compliance-report-DRAFT-${stamp}.pdf`, complianceReportPdf(report));
    else download(`compliance-report-DRAFT-${stamp}.csv`, reportCsv(report), 'text/csv');
    const r = db.logAdmin(orgId, user.id, 'compliance.report_exported', { format: kind, frameworks: enabled.length, level });
    toast.ok('Compliance report downloaded', `Marked “Draft — needs legal review” inside the file. The export is receipt #${r.seq}.`);
  };

  const controlCols: Column<LiveControl>[] = [
    { key: 'id', header: 'Control', width: 92, sort: (c) => c.id, cell: (c) => <span className="inline-flex flex-col gap-1"><span className="font-mono text-[12.5px] font-medium">{c.id}</span>{c.level && <Badge title={`Starts at ${LEVEL_INFO[c.level].label}`}>{LEVEL_INFO[c.level].tag}</Badge>}</span> },
    {
      key: 'name', header: 'What it does', sort: (c) => c.name,
      cell: (c) => (
        <div className="py-2 min-w-[220px] max-w-[420px]">
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted leading-relaxed">{c.description}</p>
          {c.note && <p className="mt-1 text-xs text-held-fg leading-relaxed">{c.note}</p>}
        </div>
      ),
    },
    { key: 'kind', header: 'Counts as evidence', hideBelow: 'lg', cell: (c) => <span className="text-sm text-muted">{c.evidenceKind}</span> },
    { key: 'count', header: 'Evidence', align: 'right', sort: (c) => c.evidenceCount, cell: (c) => <span className="font-medium">{n(c.evidenceCount)}</span> },
    { key: 'last', header: 'Last evidence', hideBelow: 'md', sort: (c) => c.lastEvidenceAt ?? '', cell: (c) => <When iso={c.lastEvidenceAt} className="text-sm text-muted" /> },
    { key: 'status', header: 'Status', sort: (c) => ['no_evidence', 'partial', 'evidenced'].indexOf(c.status), cell: (c) => <ControlStatusChip status={c.status} /> },
  ];

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Coverage"
        description={`How the receipts on your chain map to the frameworks you follow — ${q.data ? plural(controls.length, 'control') : 'the controls'}, each counted from receipts and crosswalked to every framework's requirements, with the verifier profile an auditor runs for each.`}
        meta={<LegalDraft />}
        // owners, admins and auditors export reports; viewers read the page without the menu
        actions={canExport ? (
          <Menu
            width={260}
            trigger={({ toggle: t }) => (
              <Tooltip content={!q.data ? 'Loading the frameworks…' : 'Download the coverage report'}>
                <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={t} disabled={!q.data}>Compliance report</Button>
              </Tooltip>
            )}
            items={[
              { heading: 'Download — marked Draft' },
              { label: 'JSON (full report)', icon: <FileJson className="h-4 w-4" />, onSelect: () => exportReport('json') },
              { label: 'CSV (requirements)', icon: <FileSpreadsheet className="h-4 w-4" />, onSelect: () => exportReport('csv') },
              { label: 'PDF (report to file)', icon: <FileText className="h-4 w-4" />, onSelect: () => exportReport('pdf') },
            ]}
          />
        ) : undefined}
      />

      <Banner tone="held" className="mb-6" title="How to read coverage">
        {COVERAGE_NOTE} The mappings are Elan1 Govern’s reading of each framework and need legal review before you rely on them. {evidenceClaim(level)}
      </Banner>

      {q.error && <Banner tone="bad" className="mb-6" title="Compliance did not load" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      {/* Summary */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-8">
        {q.loading ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px]" />) : (
          <>
            <Stat label="Frameworks on" value={`${enabled.length}`} sub={`of ${plural(allFws.length, 'framework')}${packFws.length ? `, ${installed.length} from packs` : ''}`} />
            <Stat label="Requirements covered" value={`${n(totals.covered)}`} sub={`of ${n(totals.total)} across frameworks that are on`} />
            <Stat label="Controls evidenced" value={`${controls.filter((c) => c.status === 'evidenced').length}`} sub={`of ${controls.length} · ${controls.filter((c) => c.status === 'partial').length} partial`} />
            <Stat label="Gaps" value={`${n(totals.gaps)}`} sub="Requirements with no mapped control" />
          </>
        )}
      </div>

      {/* Frameworks */}
      <section aria-labelledby="fw-h" className="mb-10">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <h2 id="fw-h" className="text-xl font-semibold">Frameworks</h2>
        </div>
        {q.loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[180px]" />)}</div>
        ) : frameworks.length === 0 ? (
          <EmptyState title="No frameworks available" disc="registration">Frameworks appear here once your organisation is set up.</EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {frameworks.map((f) => (
              <FrameworkCard key={f.id} f={f} c={covs[f.id]}
                control={canManage
                  ? <Switch label={`${f.short} ${f.enabled ? 'on' : 'off'}`} checked={f.enabled} disabled={toggle.pending} onChange={(v) => onToggle(f, v)} />
                  : <span className="text-xs text-muted">{f.enabled ? 'On' : 'Off'}</span>} />
            ))}
          </div>
        )}
      </section>

      {/* Regulatory packs */}
      <section aria-labelledby="pk-h" className="mb-10">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <div>
            <h2 id="pk-h" className="text-xl font-semibold inline-flex items-center gap-2">Regulatory packs {!l2 && <DryRunChip />}</h2>
            <p className="text-sm text-muted mt-0.5">One declaration, one verifier profile and one regime export per pack. A pack's regime counts in coverage once installed; its rules apply to an agent only after an admission assessment (gates G-A to G-E) is approved.</p>
          </div>
          <Link to="/records/packs" className="text-sm text-muted hover:text-fg underline underline-offset-2">All packs</Link>
        </div>
        {!l2 && (
          <Banner tone="info" className="mb-3" title={`Packs run as a dry run at ${LEVEL_INFO.l1.label}, with no regulatory claim until ${LEVEL_INFO.l2.label}`} actions={<UpgradeLink to="l2" />}>
            You can install ledger1 (MCA audit trail), invoice1 (GST e-invoicing) and collect1 (RBI collections conduct) now. Their checks run on every governed write and their reports are produced, each marked dry run, and nothing is charged. A regulatory claim needs externally timestamped records, which start at {LEVEL_INFO.l2.label}.
          </Banner>
        )}
        {packsQ.error && <Banner tone="bad" className="mb-3" title="Packs did not load" actions={<Button size="sm" onClick={packsQ.refetch}>Try again</Button>}>{packsQ.error.message}</Banner>}
        {packsQ.loading ? <div className="grid gap-3 lg:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[260px]" />)}</div> : (
          <div className="grid gap-3 lg:grid-cols-3">
            {(packsQ.data ?? []).map((pk) => {
              const fw = packFws.find((x) => x.packId === pk.id)!;
              const c = coverageOf(fw, byId);
              const admitted = (admQ.data ?? []).filter((a) => a.packId === pk.id && a.status === 'admitted').length;
              const pending = (admQ.data ?? []).filter((a) => a.packId === pk.id && (a.status === 'submitted' || a.status === 'draft')).length;
              return (
                <article key={pk.id} className={cn('flex flex-col border bg-surface p-5', pk.installed ? 'border-line' : 'border-dashed border-line-strong/60')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold font-mono"><Link to={`/compliance/${fw.id}`} className="hover:underline underline-offset-2">{pk.name}</Link></h3>
                      <p className="mt-0.5 text-xs text-muted">{pk.regime}</p>
                    </div>
                    {pk.installed && pk.dryRun ? <DryRunChip /> : pk.installed
                      ? <StatusChip size="sm" tone="ok" icon={<PackageCheck className="h-3 w-3" />}>Installed</StatusChip>
                      : <StatusChip size="sm" tone="neutral" icon={<PackagePlus className="h-3 w-3" />}>Not installed</StatusChip>}
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    {pk.installed ? <ProgressArc value={c.share} size={52} label={`${fw.short} coverage`} /> : <div className="h-[52px] w-[52px] flex items-center justify-center border border-dashed border-line-strong/60 text-[11px] text-subtle">Off</div>}
                    <p className="text-sm"><span className="font-display text-xl font-semibold num">{c.covered}</span> <span className="text-muted">of {plural(c.total, 'requirement')}{pk.installed ? '' : ' would be covered'}</span></p>
                  </div>
                  <ul className="mt-3 grid grid-cols-5 gap-1" aria-label="Admission gates">
                    {pk.gates.map((g) => (
                      <li key={g.id} title={`${g.id} ${g.label}: ${g.evidence}`} className={cn('border px-1 py-1 text-center text-[11px] font-mono', g.state === 'met' ? 'border-ok/40 text-ok-fg' : g.state === 'provisional' ? 'border-held/40 text-held-fg' : 'border-bad/40 text-bad-fg')}>
                        <span className="inline-flex items-center gap-0.5">{g.state === 'met' ? <CircleCheck className="h-3 w-3" aria-hidden /> : g.state === 'provisional' ? <Hourglass className="h-3 w-3" aria-hidden /> : <CircleX className="h-3 w-3" aria-hidden />}{g.id}</span>
                        <span className="sr-only">{g.state === 'met' ? 'met' : g.state === 'provisional' ? 'provisional until the pilot answers it' : 'not met'}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted">{plural(admitted, 'agent')} admitted{pending ? ` · ${pending} admission${pending === 1 ? '' : 's'} open` : ''} · {n(pk.coverage?.writes ?? 0)} governed writes, {n(pk.coverage?.refusals ?? 0)} refused</p>
                  {l2 && <div className="mt-2"><ProfileVerify frameworkId={fw.id} compact /></div>}
                  <div className="mt-auto pt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => nav(`/records/packs/${pk.id}`)}>{pk.installed && canManage ? 'Configure' : 'Open pack'}</Button>
                    {!pk.installed && canManage && (
                      <Tooltip content={l2 ? `Install ${pk.name}: ${rupees(pk.price)} a year` : `A dry run until ${LEVEL_INFO.l2.label}; billed ${rupees(pk.price)} a year from then`}>
                        <Button size="sm" variant="primary" loading={installing === pk.id} disabled={!!installing} onClick={() => onInstall(pk.id)}>{l2 ? 'Install' : 'Install as a dry run'}</Button>
                      </Tooltip>
                    )}
                    {pk.installed && canAdmit && <Button size="sm" variant="ghost" onClick={() => nav(`/assessments?start=pack_${pk.id}`)}>Admit an agent</Button>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Controls */}
      <section id="controls" aria-labelledby="ctl-h" className="mb-10 scroll-mt-24">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <div>
            <h2 id="ctl-h" className="text-xl font-semibold">Controls</h2>
            <p className="text-sm text-muted mt-0.5">Counted live from the chain and records. Select a control to see its receipts and the requirements it serves.{controls.some((c) => c.level) ? ` Controls tagged ${LEVEL_INFO.l2.tag} or ${LEVEL_INFO.l3.tag} come with your level.` : ''}</p>
          </div>
        </div>
        <DataTable caption={controlRange ? `Controls ${controlRange}` : 'Controls'} columns={controlCols} rows={q.data ? controls : undefined} loading={q.loading} rowKey={(c) => c.id} onRowClick={(c) => setParams({ control: c.id }, { replace: true })} selectedKey={openControl}
          empty={<EmptyState compact title="No controls" disc="registration">Controls appear once your organisation is set up.</EmptyState>} />
      </section>

      {/* Crosswalk */}
      <section aria-labelledby="xw-h">
        <Panel
          title={<span id="xw-h" className="inline-flex items-center gap-2">Crosswalk <Help text="Each cell is the number of a framework's requirements that the control maps to. Select a cell to open those requirements." /></span>}
          kicker="Controls × frameworks that are on"
          flush
          footer={<span className="inline-flex items-center gap-1.5"><Info className="h-3.5 w-3.5" aria-hidden />One control can serve many requirements; one piece of evidence counts for each of them.</span>}
        >
          {q.loading ? <div className="p-5"><Skeleton className="h-64" /></div> : enabled.length === 0 ? (
            <EmptyState compact title="No frameworks are on" disc="registration">Turn on a framework above to see how the controls map to it.</EmptyState>
          ) : (
            <Crosswalk controls={controls} frameworks={enabled} onCell={(fw, ctl) => nav(`/compliance/${fw}${ctl ? `?control=${ctl}` : '?status=gap'}`)} onControl={(id) => setParams({ control: id }, { replace: true })} />
          )}
        </Panel>
      </section>

      <ControlDrawer control={openControl ? byId[openControl] : undefined} frameworks={allFws} onClose={() => { const p = new URLSearchParams(params); p.delete('control'); setParams(p, { replace: true }); }} />
    </div>
  );
}

function FrameworkCard({ f, c, control }: { f: Framework; c: ReturnType<typeof coverageOf>; control: React.ReactNode }) {
  // verifier profiles are part of L2: below it the line (and its spacing) is left out
  const l2 = atLeast(useOrgLevel(), 'l2');
  return (
    <article className={cn('relative flex flex-col border bg-surface p-5 transition-colors hover:border-line-strong', f.enabled ? 'border-line' : 'border-dashed border-line-strong/60 bg-canvas')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-tight">
            <Link to={`/compliance/${f.id}`} className="hover:underline underline-offset-2 after:absolute after:inset-0 after:content-['']">{f.short}</Link>
          </h3>
          <p className="mt-0.5 text-xs text-muted line-clamp-2">{f.name}</p>
        </div>
        <div className="relative z-10 shrink-0" onClick={(e) => e.stopPropagation()}>{control}</div>
      </div>
      <div className="mt-4 flex items-center gap-4">
        {f.enabled ? <ProgressArc value={c.share} size={64} label={`${f.short} coverage ${Math.round(c.share * 100)}%`} /> : <div className="h-16 w-16 flex items-center justify-center border border-dashed border-line-strong/60 text-xs text-subtle">Off</div>}
        <div className="min-w-0">
          <p className="text-sm"><span className="font-display text-2xl font-semibold num">{c.covered}</span> <span className="text-muted">of {plural(c.total, 'requirement')}</span></p>
          <p className="text-xs text-muted mt-0.5">{c.gaps ? `${plural(c.gaps, 'gap')} with no mapped control` : 'Every requirement has a mapped control'}</p>
        </div>
      </div>
      {l2 && <div className="relative z-10 mt-3"><ProfileVerify frameworkId={f.id} compact /></div>}
      <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{f.jurisdiction}</span>
        <span className="font-mono text-[11px]">{f.officialRef}</span>
        {isIndia(f) && <Badge tone="accent" icon={<MapPin className="h-3 w-3" aria-hidden />}>India</Badge>}
      </div>
    </article>
  );
}

function Crosswalk({ controls, frameworks, onCell, onControl }: { controls: LiveControl[]; frameworks: Framework[]; onCell: (fw: string, ctl?: string) => void; onControl: (id: string) => void }) {
  const shade = (k: number) => (k === 0 ? '' : k === 1 ? 'bg-fg/[0.06]' : k === 2 ? 'bg-fg/[0.12]' : 'bg-fg/[0.2]');
  const byId = Object.fromEntries(controls.map((c) => [c.id, c]));
  const reqs = Object.fromEntries(frameworks.map((f) => [f.id, requirementsOf(f, byId)]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Number of framework requirements each control maps to</caption>
        <thead>
          <tr className="border-b border-line bg-sunken/70">
            <th scope="col" className="sticky left-0 z-10 bg-sunken text-left label px-4 h-10 min-w-[200px]">Control</th>
            {frameworks.map((f) => (
              <th key={f.id} scope="col" className="label px-2 h-10 text-center whitespace-nowrap min-w-[84px]">
                <Link to={`/compliance/${f.id}`} className="hover:text-fg">{f.short}</Link>
              </th>
            ))}
            <th scope="col" className="label px-3 h-10 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {controls.map((c) => {
            const counts = frameworks.map((f) => reqs[f.id].filter((r) => r.controlIds.includes(c.id)).length);
            const total = counts.reduce((s, k) => s + k, 0);
            return (
              <tr key={c.id} className="border-b border-line">
                <th scope="row" className="sticky left-0 z-10 bg-surface text-left font-normal px-4 py-2">
                  <button type="button" onClick={() => onControl(c.id)} className="flex items-center gap-2 text-left hover:underline underline-offset-2">
                    <span className={cn('h-2 w-2 shrink-0', c.status === 'evidenced' ? 'bg-ok' : c.status === 'partial' ? 'bg-held' : 'bg-bad')} aria-hidden />
                    <span className="font-mono text-[12px]">{c.id}</span>
                    <span className="text-xs text-muted truncate max-w-[200px] hidden md:inline">{c.name}</span>
                    <span className="sr-only">{c.status === 'evidenced' ? 'evidenced' : c.status === 'partial' ? 'partial evidence' : 'no evidence'}</span>
                  </button>
                </th>
                {frameworks.map((f, i) => (
                  <td key={f.id} className="p-0 text-center border-l border-line">
                    {counts[i] > 0 ? (
                      <button type="button" onClick={() => onCell(f.id, c.id)} aria-label={`${c.id} maps to ${counts[i]} ${f.short} requirements`} className={cn('w-full h-10 num font-medium hover:outline hover:outline-1 hover:outline-fg -outline-offset-1', shade(counts[i]))}>
                        {counts[i]}
                      </button>
                    ) : <span className="text-subtle" aria-label="none">·</span>}
                  </td>
                ))}
                <td className="px-3 text-right num text-muted">{total}</td>
              </tr>
            );
          })}
          <tr className="bg-sunken/50">
            <th scope="row" className="sticky left-0 z-10 bg-sunken text-left px-4 py-2 font-medium text-bad-fg">No mapped control</th>
            {frameworks.map((f) => {
              const g = reqs[f.id].filter((r) => r.controlIds.length === 0).length;
              return (
                <td key={f.id} className="p-0 text-center border-l border-line">
                  {g > 0 ? <button type="button" onClick={() => onCell(f.id)} aria-label={`${g} ${f.short} requirements with no mapped control`} className="w-full h-10 num font-semibold text-bad-fg hover:bg-bad-bg">{g}</button> : <span className="text-subtle">0</span>}
                </td>
              );
            })}
            <td className="px-3 text-right num text-bad-fg font-semibold">{frameworks.reduce((s, f) => s + reqs[f.id].filter((r) => r.controlIds.length === 0).length, 0)}</td>
          </tr>
          <tr>
            <th scope="row" className="sticky left-0 z-10 bg-surface text-left px-4 py-2 label">Coverage</th>
            {frameworks.map((f) => {
              const c = coverageOf(f, byId);
              return (
                <td key={f.id} className="px-2 py-2 border-l border-line">
                  <p className="text-xs num text-center">{c.covered}/{c.total}</p>
                  <Meter className="mt-1" value={c.share} label={`${f.short} coverage`} />
                </td>
              );
            })}
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
