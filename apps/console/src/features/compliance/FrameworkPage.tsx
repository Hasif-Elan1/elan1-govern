import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Download, MapPin, Unlink, X, Eraser, Clock3, PackageCheck } from 'lucide-react';
import { api, db } from '@/api';
import { useMutation, useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Framework, Requirement } from '@/types';
import { Banner, Button, DataTable, EmptyState, LegalDraft, PageHeader, Panel, ProgressArc, Segmented, Skeleton, StatusChip, Switch, Tooltip, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { countdown, n, plural } from '@/lib/format';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { TierChip } from '@/features/inventory/governance';
import { COVERAGE_NOTE, DRAFT_LABEL, INDIA_NOTE, REQ_STATUS_LABEL, coverageOf, download, evidenceClaim, indexControls, isIndia, liveControls, requirementStatus, requirementsOf, type LiveControl, type ReqStatus } from './evidence';
import { packFrameworkById, packFrameworks, type PackFramework } from './regimes';
import { ControlChip, ControlDrawer, ControlStatusChip, ProfileVerify, ReqStatusChip } from './parts';
import { downloadPdf, frameworkReportPdf } from '@/features/evidence/frameworkPdf';
import { PlanUpsell, useScreenAccess } from '@/shell/access';

type Row = Requirement & { status: ReqStatus; evidence: number; example?: number; activity?: string };
type Filter = 'all' | 'covered' | 'partial' | 'gap';

export default function FrameworkPage() {
  const { framework = '' } = useParams();
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const level = useOrgLevel();
  const canManage = useCan('compliance.manage');
  const canExportEvidence = useCan('evidence.export');
  const canExport = canManage || canExportEvidence;
  const l2 = atLeast(level, 'l2');
  const access = useScreenAccess();
  const [params, setParams] = useSearchParams();
  const [drawer, setDrawer] = useState<string>();
  const packDef = packFrameworkById(framework);

  const q = useQuery((o) => api.compliance(o));
  const inv = useQuery((o) => api.inventory(o));
  const packsQ = useQuery((o) => (packDef ? api.packs(o) : Promise.resolve(undefined)), [framework, level], { kinds: ['pack', 'receipt', 'level'] });
  const toggle = useMutation((on: boolean) => api.setFramework(orgId, framework, on, user!.id));

  const controls: LiveControl[] = useMemo(() => (q.data ? liveControls(orgId, q.data.controls) : []), [q.data, orgId, level]);
  const byId = useMemo(() => indexControls(controls), [controls]);
  const pack = packsQ.data?.find((p) => p.id === packDef?.packId);
  const f: Framework | PackFramework | undefined = packDef ? packFrameworks(pack?.installed ? [pack.id] : []).find((x) => x.id === framework) : q.data?.frameworks.find((x) => x.id === framework);
  const reqs = useMemo(() => (f ? requirementsOf(f, byId) : []), [f, byId]);

  const rows: Row[] = useMemo(() => reqs.map((r) => {
    const cs = r.controlIds.map((id) => byId[id]).filter(Boolean);
    const example = cs.flatMap((c) => c.examples).sort((a, b) => b - a)[0];
    return { ...r, status: requirementStatus(r, byId), evidence: cs.reduce((s, c) => s + c.evidenceCount, 0), example, activity: cs.find((c) => c.evidenceCount > 0)?.activity };
  }), [reqs, byId]);

  const filter = (params.get('status') as Filter) ?? 'all';
  const controlFilter = params.get('control') ?? undefined;
  const setParam = (k: string, v?: string) => { const p = new URLSearchParams(params); if (!v || v === 'all') p.delete(k); else p.set(k, v); setParams(p, { replace: true }); };
  const shown = rows.filter((r) =>
    (filter === 'all' || (filter === 'partial' ? r.status === 'partial' || r.status === 'unevidenced' : r.status === filter)) &&
    (!controlFilter || r.controlIds.includes(controlFilter)));

  const systems = useMemo(() => (inv.data ?? []).filter((s) => s.frameworks.includes(framework)), [inv.data, framework]);

  // Receipt pages link to a control as /compliance/<framework>#<controlId>: filter the requirements to it, open its drawer and scroll there.
  const { hash } = useLocation();
  const hashControl = hash ? decodeURIComponent(hash.slice(1)) : undefined;
  useEffect(() => {
    if (!hashControl || !byId[hashControl]) return;
    const mapped = reqs.some((r) => r.controlIds.includes(hashControl));
    const p = new URLSearchParams(params);
    if (mapped) p.set('control', hashControl);
    setParams(p, { replace: true }); // drops the hash, so this runs once per link
    setDrawer(hashControl);
    window.setTimeout(() => document.getElementById('requirements')?.scrollIntoView({ block: 'start' }), 0);
  }, [hashControl, byId, reqs]);

  const totalFrameworks = (q.data?.frameworks.length ?? 0) + packFrameworks([]).length;

  if (q.error) return <div><PageHeader kicker="Assurance · Coverage" title="Framework" crumbs={[{ label: 'Coverage', to: '/compliance' }, { label: 'Error' }]} /><Banner tone="bad" title="This framework did not load" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner></div>;
  if (q.loading || (packDef && packsQ.loading)) return <div className="space-y-6" aria-busy><Skeleton className="h-4 w-40" /><Skeleton className="h-10 w-96 max-w-full" /><Skeleton className="h-40" /><Skeleton className="h-96" /></div>;
  if (!f) {
    return (
      <div>
        <PageHeader kicker="Assurance · Coverage" title="Framework not found" crumbs={[{ label: 'Coverage', to: '/compliance' }, { label: framework }]} />
        <EmptyState title={`No framework called “${framework}”`} disc="registration" action={<Button onClick={() => nav('/compliance')}>All frameworks</Button>}>
          Elan1 Govern maps {plural(totalFrameworks, 'framework')}, {packFrameworks([]).length} of them from the regulatory packs. Pick one from the Coverage page.
        </EmptyState>
      </div>
    );
  }

  const cov = coverageOf(f, byId);
  const gaps = rows.filter((r) => r.status === 'gap');
  const usedControls = Array.from(new Set(reqs.flatMap((r) => r.controlIds))).sort().map((id) => byId[id]).filter(Boolean);
  const counts = { all: rows.length, covered: rows.filter((r) => r.status === 'covered').length, partial: rows.filter((r) => r.status === 'partial' || r.status === 'unevidenced').length, gap: gaps.length };

  const onToggle = async (on: boolean) => {
    try {
      await toggle.mutate(on);
      toast.ok(`${f.short} ${on ? 'turned on' : 'turned off'}`, on ? 'It now counts in coverage and the crosswalk.' : 'It no longer counts in coverage. Mappings are kept.');
    } catch (e) { toast.bad('The framework did not change', (e as Error).message); }
  };

  const exportCsv = () => {
    if (!user) return;
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [`# ${DRAFT_LABEL}`, `# ${f.name} (${f.officialRef}) — ${cov.covered} of ${cov.total} requirements covered — ${LEVEL_INFO[level].label} — generated ${new Date().toISOString()}`, `# ${COVERAGE_NOTE}`, `# ${evidenceClaim(level)}`,
      'requirement,title,mapped_controls,status,evidence_count,latest_receipt',
      ...rows.map((r) => [r.id, r.title, r.controlIds.join(' '), REQ_STATUS_LABEL[r.status], r.evidence, r.example ?? ''].map(esc).join(','))];
    download(`${f.id}-coverage-DRAFT-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv');
    const r = db.logAdmin(orgId, user.id, 'compliance.report_exported', { format: 'csv', framework: f.short });
    toast.ok(`${f.short} coverage downloaded`, `Marked “Draft — needs legal review” inside the file. Receipt #${r.seq}.`);
  };

  const exportPdf = () => {
    if (!user) return;
    downloadPdf(`${f.id}-coverage-DRAFT-${new Date().toISOString().slice(0, 10)}.pdf`, frameworkReportPdf({
      organisation: api.org(orgId).name, level: LEVEL_INFO[level].label, by: user.name, draftLabel: DRAFT_LABEL, note: COVERAGE_NOTE, claim: evidenceClaim(level),
      framework: { name: f.name, short: f.short, officialRef: f.officialRef, jurisdiction: f.jurisdiction }, covered: cov.covered, total: cov.total,
      rows: rows.map((r) => ({ id: r.id, title: r.title, controls: r.controlIds, status: REQ_STATUS_LABEL[r.status], evidence: r.evidence, example: r.example })),
    }));
    const r = db.logAdmin(orgId, user.id, 'compliance.report_exported', { format: 'pdf', framework: f.short });
    toast.ok(`${f.short} coverage downloaded as PDF`, `Marked “Draft — needs legal review” on every page. Receipt #${r.seq}.`);
  };

  const cols: Column<Row>[] = [
    { key: 'id', header: 'Requirement', width: 140, sort: (r) => r.id, cell: (r) => <span className="font-mono text-[12.5px] font-medium whitespace-nowrap">{r.id}</span> },
    { key: 'title', header: 'Title', sort: (r) => r.title, cell: (r) => <span className="block py-2 min-w-[160px]">{r.title}</span> },
    {
      key: 'controls', header: 'Mapped controls',
      cell: (r) => r.controlIds.length
        ? <span className="flex flex-wrap gap-1">{r.controlIds.map((id) => <ControlChip key={id} id={id} status={byId[id]?.status} onClick={() => setDrawer(id)} />)}</span>
        : <span className="inline-flex items-center gap-1 text-xs font-medium text-bad-fg"><Unlink className="h-3 w-3" aria-hidden />No mapped control</span>,
    },
    { key: 'status', header: 'Evidence', sort: (r) => ['gap', 'unevidenced', 'partial', 'covered'].indexOf(r.status), cell: (r) => <ReqStatusChip status={r.status} /> },
    { key: 'count', header: 'Receipts', align: 'right', hideBelow: 'sm', sort: (r) => r.evidence, cell: (r) => (r.controlIds.length ? n(r.evidence) : <span className="text-subtle">—</span>) },
    {
      key: 'example', header: 'Example', hideBelow: 'md',
      cell: (r) => r.example ? <ReceiptLink seq={r.example} /> : r.activity && access.canSee(r.activity) ? <Link to={r.activity} onClick={(e) => e.stopPropagation()} className="text-xs text-muted hover:text-fg underline underline-offset-2">View</Link> : <span className="text-subtle">—</span>,
    },
  ];

  const onSwitch = packDef ? (
    <span className="inline-flex items-center gap-2 h-10 px-3 border border-line bg-surface text-sm">
      {pack?.installed ? <><PackageCheck className="h-4 w-4" aria-hidden />On with <Link to={`/records/packs/${packDef.packId}`} className="font-mono underline underline-offset-2">{packDef.packId}</Link> installed</> : <>Counts once <Link to={`/records/packs/${packDef.packId}`} className="font-mono underline underline-offset-2">{packDef.packId}</Link> is installed</>}
    </span>
  ) : canManage ? (
    <Tooltip content="Count this framework in coverage and the crosswalk">
      <span className="inline-flex items-center gap-2 h-10 px-3 border border-line bg-surface text-sm">
        Counts in coverage <Switch label={`${f.short} ${f.enabled ? 'on' : 'off'}`} checked={f.enabled} disabled={toggle.pending} onChange={onToggle} />
      </span>
    </Tooltip>
  ) : (
    // roles that cannot turn frameworks on or off read whether it counts
    <span className="inline-flex items-center gap-2 h-10 px-3 border border-line bg-surface text-sm">Counts in coverage: {f.enabled ? 'on' : 'off'}</span>
  );

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Coverage', to: '/compliance' }, { label: f.short }]}
        kicker="Assurance · Coverage"
        title={f.name}
        description={<>{f.jurisdiction} · <span className="font-mono text-sm">{f.officialRef}</span></>}
        meta={<><LegalDraft />{isIndia(f) && <span className="inline-flex items-center gap-1 text-xs text-accent-fg font-medium"><MapPin className="h-3.5 w-3.5" aria-hidden />India</span>}</>}
        actions={
          <>
            {onSwitch}
            {canExport && (
              <Tooltip content="Download the requirements and their evidence">
                <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export CSV</Button>
              </Tooltip>
            )}
            {canExport && (
              <Tooltip content="Download the coverage report as a PDF to file">
                <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportPdf}>Export PDF</Button>
              </Tooltip>
            )}
          </>
        }
      />

      {INDIA_NOTE[f.id] && <Banner tone="info" className="mb-4" title="India-specific note">{INDIA_NOTE[f.id]}</Banner>}
      {/* packs install from L1 as a dry run, with no regulatory claim until L2 (decision 5) */}
      {packDef && !atLeast(level, 'l2') && (
        <Banner tone="info" className="mb-4" title={`${packDef.packId} runs as a dry run at ${LEVEL_INFO[level].label}`} actions={<Button size="sm" variant="secondary" onClick={() => nav(`/records/packs/${packDef.packId}`)}>Open {packDef.packId}</Button>}>Its rules run and its reports are produced, each marked “dry run — no regulatory claim until {LEVEL_INFO.l2.label}”. The mapping below shows what this regime covers.</Banner>
      )}
      {!f.enabled && !packDef && <Banner tone="neutral" className="mb-4" title="This framework is turned off">Its requirements do not count in the organisation’s coverage or the crosswalk. The mapping below still shows what the evidence would cover.</Banner>}
      {packDef && atLeast(level, 'l2') && !pack?.installed && <Banner tone="neutral" className="mb-4" title={`${packDef.packId} is not installed`} actions={<Button size="sm" variant="secondary" onClick={() => nav(`/records/packs/${packDef.packId}`)}>Open {packDef.packId}</Button>}>This regime does not count in coverage until the pack is installed.</Banner>}
      {packsQ.error && <Banner tone="bad" className="mb-4" title="The pack did not load" actions={<Button size="sm" onClick={packsQ.refetch}>Try again</Button>}>{packsQ.error.message}</Banner>}

      {/* Summary */}
      <div className="grid gap-6 lg:grid-cols-12 mb-6">
        <Panel className={l2 ? 'lg:col-span-5' : 'lg:col-span-6'} kicker="Coverage" title={`${cov.covered} of ${plural(cov.total, 'requirement')} covered`}>
          <div className="flex items-center gap-5">
            <ProgressArc value={cov.share} size={96} label={`${f.short} coverage`} />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm flex-1">
              <div><dt className="text-muted">Covered</dt><dd className="font-display text-xl font-semibold num">{counts.covered}</dd></div>
              <div><dt className="text-muted">Partial or no evidence</dt><dd className="font-display text-xl font-semibold num">{counts.partial}</dd></div>
              <div><dt className="text-muted">Gaps</dt><dd className="font-display text-xl font-semibold num text-bad-fg">{counts.gap}</dd></div>
              <div><dt className="text-muted">Controls used</dt><dd className="font-display text-xl font-semibold num">{usedControls.length}</dd></div>
            </dl>
          </div>
          <p className="mt-4 text-xs text-muted leading-relaxed">{COVERAGE_NOTE} Rounded down.</p>
        </Panel>

        <Panel className={l2 ? 'lg:col-span-4' : 'lg:col-span-6'} kicker="Controls used" title="Evidence behind this framework" flush>
          <ul className="divide-y divide-line max-h-[248px] overflow-y-auto">
            {usedControls.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setDrawer(c.id)} className="w-full flex items-center justify-between gap-3 px-5 py-2.5 text-left hover:bg-sunken/60">
                  <span className="min-w-0"><span className="font-mono text-xs mr-2">{c.id}</span><span className="text-sm">{c.name}</span></span>
                  <span className="flex items-center gap-2 shrink-0"><span className="num text-xs text-muted">{n(c.evidenceCount)}</span><ControlStatusChip status={c.status} /></span>
                </button>
              </li>
            ))}
            {!usedControls.length && <li className="px-5 py-4 text-sm text-muted">No control maps to this framework yet.</li>}
          </ul>
        </Panel>

        {/* verifier profiles are part of L2: below it the panel is left out */}
        {l2 && (
          <Panel className="lg:col-span-3" kicker="Verifier profile" title="Check it like an auditor">
            <ProfileVerify frameworkId={f.id} />
          </Panel>
        )}
      </div>
      {!l2 && <PlanUpsell to="l2" className="-mt-3 mb-6" what="Verifier profiles, to check this framework like an auditor, are part of L2 Attested." />}

      {f.id === 'dpdp' && <ErasurePanel />}

      <Panel className="mb-6" kicker="In scope" title="AI systems" flush>
        {inv.error ? <p className="px-5 py-4 text-sm text-bad-fg">{inv.error.message} <button type="button" className="underline" onClick={inv.refetch}>Try again</button></p> : inv.loading ? <div className="p-5"><Skeleton className="h-24" /></div> : systems.length ? (
          <ul className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
            {systems.map((s) => (
              <li key={s.id} className="bg-surface">
                <Link to={`/inventory/${s.id}`} className="flex flex-col gap-1.5 px-5 py-2.5 hover:bg-sunken/60">
                  <span className="text-sm font-medium">{s.name}</span>
                  <TierChip tier={s.riskTier} />
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 py-4 text-sm text-muted">No AI system lists this framework. Choose frameworks when you <Link to="/inventory" className="underline underline-offset-2">register a system</Link>.</p>}
      </Panel>

      {/* Requirements */}
      <div id="requirements" className="flex flex-wrap items-center gap-2 mb-3 scroll-mt-24">
        <Segmented<Filter> label="Filter requirements" value={filter} onChange={(v) => setParam('status', v)} options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'covered', label: 'Covered', count: counts.covered },
          { value: 'partial', label: 'Partial', count: counts.partial },
          { value: 'gap', label: 'Gaps', count: counts.gap },
        ]} />
        {controlFilter && <Button size="sm" variant="secondary" iconRight={<X className="h-3.5 w-3.5" />} onClick={() => setParam('control')}>Mapped to {controlFilter}</Button>}
        <span className="ml-auto text-sm text-muted num">{shown.length === rows.length ? plural(rows.length, 'requirement') : `${shown.length} of ${plural(rows.length, 'requirement')}`}</span>
      </div>
      <DataTable
        caption={`${f.short} requirements`}
        columns={cols}
        rows={shown}
        rowKey={(r) => r.id}
        rowClassName={(r) => (r.status === 'gap' ? 'shadow-[inset_3px_0_0_rgb(var(--bad))]' : undefined)}
        empty={<EmptyState compact title="No requirements match" disc="registration">{filter === 'gap' ? 'Every requirement has at least one mapped control.' : 'Try another filter.'}</EmptyState>}
      />

      {/* Gaps */}
      <Panel className="mt-6" kicker="Gaps" title={gaps.length ? `${plural(gaps.length, 'requirement')} with no mapped control` : 'No gaps'}
        footer={gaps.length ? 'These need a process outside Elan1 Govern, or a control mapping your counsel agrees with. Coverage will not count them until then.' : undefined}>
        {gaps.length ? (
          <ul className="grid gap-px bg-line border border-line sm:grid-cols-2">
            {gaps.map((r) => (
              <li key={r.id} className="bg-surface px-4 py-3 flex items-start gap-3">
                <Unlink className="h-4 w-4 text-bad-fg mt-0.5 shrink-0" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm"><span className="font-mono text-xs mr-2">{r.id}</span>{r.title}</p>
                  <p className="text-xs text-bad-fg mt-0.5">No mapped control</p>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">Every requirement of {f.short} maps to at least one control. Coverage still depends on live evidence.</p>}
      </Panel>

      <div className="mt-6 flex justify-end">
        <Link to="/compliance" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">All frameworks and the crosswalk <ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>

      <ControlDrawer control={drawer ? byId[drawer] : undefined} frameworks={f ? [f] : []} onClose={() => setDrawer(undefined)} />
    </div>
  );
}

/** DPDP: erasure by salt destruction — two approvers, a 72-hour clock, and the chain still verifies. */
function ErasurePanel() {
  const nav = useNavigate();
  const level = useOrgLevel();
  const now = useNow(60_000);
  // erasure is available from L1 (decision 6c): every record is salted from the first L1 record
  const q = useQuery((o) => api.erasures(o), [level], { kinds: ['erasure', 'receipt', 'level'] });
  const open = (q.data?.requests ?? []).filter((r) => r.status === 'awaiting_approval' || r.status === 'approved');
  const executed = (q.data?.requests ?? []).filter((r) => r.status === 'executed');
  return (
    <Panel className="mb-6" kicker="DPDP s.8(7) and s.12" title="Erasure by salt destruction"
      actions={<Button size="sm" variant="secondary" icon={<Eraser className="h-3.5 w-3.5" />} onClick={() => nav('/records/erasure')}>Open erasure requests</Button>}
      footer={`Two different people approve, neither the requester; the 72-hour clock starts when the request is opened. Destroying the salt makes the payload unlinkable while the chain still verifies${atLeast(level, 'l2') ? ', and every Seal v6 record marks its payload unbound' : ''}.`}>
      {q.error ? <Banner tone="bad" title="Erasure requests did not load" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>
        : q.loading ? <Skeleton className="h-20" /> : (
        <div className="space-y-3">
          <div className="grid gap-3 grid-cols-3 text-sm">
            <div><p className="label">Open</p><p className="font-display text-2xl font-semibold num">{open.length}</p></div>
            <div><p className="label">Executed</p><p className="font-display text-2xl font-semibold num">{executed.length}</p></div>
            <div><p className="label">Salts destroyed</p><p className="font-display text-2xl font-semibold num">{n(q.data?.destroyedSalts ?? 0)}</p></div>
          </div>
          {open.length > 0 && (
            <ul className="divide-y divide-line border border-line">
              {open.slice(0, 4).map((r) => {
                const overdue = new Date(r.dueAt).getTime() <= now;
                return (
                  <li key={r.id}>
                    <Link to={`/records/erasure?id=${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-sunken/60">
                      <span className="font-mono text-[12.5px]">{r.subjectRef}</span>
                      <span className="text-xs text-muted">{r.approvals.length} of {r.required} approvals · {plural(r.affected, 'receipt')}</span>
                      <StatusChip size="sm" tone={overdue ? 'bad' : 'held'} icon={<Clock3 className="h-3 w-3" />}>{overdue ? '72 hours passed' : `${countdown(r.dueAt, now)} left`}</StatusChip>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {executed[0]?.seq && <p className="text-xs text-muted">Last executed {executed[0].subjectRef} · <ReceiptLink seq={executed[0].seq} />{executed[0].chainStillVerifies ? ' · the chain re-verified after the salt was destroyed' : ''}</p>}
        </div>
      )}
    </Panel>
  );
}
