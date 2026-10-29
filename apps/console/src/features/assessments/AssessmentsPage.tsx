import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardList, Scale, Sigma, UserCheck } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgLevel, useUser } from '@/store/session';
import type { AiSystem, AssessmentStatus } from '@/types';
import { Badge, Banner, Blocked, Button, DataTable, EmptyState, Help, Meter, PageHeader, SearchInput, StatusChip, Tabs, Tooltip, type Column } from '@/components/ui';
import { Person, When } from '@/components/domain';
import { date, n, plural } from '@/lib/format';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { AssessmentStatusChip, TIER_META, TierChip } from '@/features/inventory/governance';
import { VARIANTS, VARIANT_ORDER, admissionOf, bands, summarise, variantOf, type VariantId } from './templates';
import { assessments, type ExtAssessment } from './backend';
import { StartAssessmentDialog } from './StartAssessmentDialog';
import { PlanUpsell, SmartLink } from '@/shell/access';

type Row = ExtAssessment & { system?: AiSystem };
type TabKey = 'all' | AssessmentStatus;

const TABS: { value: TabKey; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'submitted', label: 'Waiting for sign-off' },
  { value: 'approved', label: 'Approved' },
  { value: 'changes_requested', label: 'Changes requested' },
];

/** Result cell: risk tier for risk and framework templates; gates met for pack admission. */
export function ResultCell({ a }: { a: ExtAssessment }) {
  const def = variantOf(a);
  if (def.kind === 'admission') {
    const adm = admissionOf(a);
    if (a.status === 'approved') return <StatusChip size="sm" tone="ok">Admitted · {adm.met}/{adm.total} gates</StatusChip>;
    if (!adm.complete) return <span className="text-xs text-muted num">{adm.met} of {adm.total} gates met so far</span>;
    return <StatusChip size="sm" tone={adm.admitted ? 'info' : 'bad'}>{adm.admitted ? 'All gates met' : `${adm.total - adm.met} gates not met`}</StatusChip>;
  }
  return a.status === 'draft' || a.status === 'changes_requested'
    ? <span className="inline-flex items-center gap-1.5 text-xs text-muted">Provisional <TierChip tier={summarise(a).tier} /></span>
    : <TierChip tier={a.resultTier} />;
}

export default function AssessmentsPage() {
  const user = useUser();
  const nav = useNavigate();
  const level = useOrgLevel();
  const canAuthor = useCan('assessments.author');
  const canSign = useCan('assessments.signoff');
  const canRegister = useCan('inventory.manage');
  const [params, setParams] = useSearchParams();
  const [startOpen, setStartOpen] = useState(false);
  const [startWith, setStartWith] = useState<{ variant?: VariantId; system?: string }>({});
  const [needle, setNeedle] = useState('');

  const q = useQuery((o) => assessments(o), [], { kinds: ['assessment', 'receipt', 'inventory'] });
  const inv = useQuery((o) => api.inventory(o));

  // deep link from an agent or pack: /assessments?start=pack_collect1&system=ai_…
  useEffect(() => {
    const start = params.get('start') as VariantId | null;
    if (start && VARIANTS[start] && canAuthor && inv.data?.length) {
      setStartWith({ variant: start, system: params.get('system') ?? undefined });
      setStartOpen(true);
      const p = new URLSearchParams(params);
      p.delete('start');
      p.delete('system');
      setParams(p, { replace: true });
    }
  }, [params, canAuthor, inv.data, setParams]);

  const rows: Row[] = q.data ?? [];
  const tab = (params.get('status') as TabKey) ?? (rows.some((r) => r.status === 'submitted') ? 'submitted' : 'all');
  const counts = Object.fromEntries(TABS.map((t) => [t.value, t.value === 'all' ? rows.length : rows.filter((r) => r.status === t.value).length])) as Record<TabKey, number>;
  const shown = rows.filter((r) => (tab === 'all' || r.status === tab) && (!needle.trim() || `${r.system?.name ?? ''} ${variantOf(r).label}`.toLowerCase().includes(needle.trim().toLowerCase())));
  const waitingForMe = rows.filter((r) => r.status === 'submitted' && r.authorId !== user?.id && (r as { submittedBy?: string }).submittedBy !== user?.id).length;
  const unassessed = (inv.data ?? []).filter((s) => s.riskTier === 'unassessed' && !rows.some((r) => r.aiSystemId === s.id && r.status === 'approved' && variantOf(r).kind !== 'admission'));
  const noSystems = !!inv.data && inv.data.length === 0;
  const startBlocked = !canAuthor ? 'Owners, admins and approvers write assessments; your role can read them.' : inv.loading ? 'Loading the AI inventory…' : noSystems ? 'Register an AI system first' : inv.error ? 'The AI inventory did not load' : undefined;
  const usage = useMemo(() => Object.fromEntries(VARIANT_ORDER.map((v) => [v, rows.filter((r) => variantOf(r).id === v).length])), [rows]);
  const isAbove = (v: VariantId) => !!VARIANTS[v].level && !atLeast(level, VARIANTS[v].level!);
  const inPlan = VARIANT_ORDER.filter((v) => !isAbove(v));
  const abovePlan = VARIANT_ORDER.filter(isAbove);

  const columns: Column<Row>[] = [
    {
      key: 'system', header: 'AI system', sort: (r) => r.system?.name ?? '',
      cell: (r) => (
        <div className="py-1.5 min-w-0">
          {r.system ? <Link to={`/inventory/${r.system.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline underline-offset-2">{r.system.name}</Link> : <span className="text-muted">Unknown system</span>}
          <p className="text-xs text-muted sm:hidden">{variantOf(r).label}</p>
        </div>
      ),
    },
    { key: 'template', header: 'Template', hideBelow: 'sm', sort: (r) => variantOf(r).label, cell: (r) => <span className="inline-flex items-center gap-2 whitespace-nowrap">{variantOf(r).label}{variantOf(r).kind === 'admission' && <Badge>Pack</Badge>}</span> },
    { key: 'status', header: 'Status', sort: (r) => ['draft', 'changes_requested', 'submitted', 'approved'].indexOf(r.status), cell: (r) => <AssessmentStatusChip status={r.status} /> },
    {
      key: 'score', header: 'Score', hideBelow: 'md', sort: (r) => summarise(r).score / r.maxScore,
      cell: (r) => {
        const s = summarise(r);
        return (
          <div className="w-32">
            <div className="flex items-baseline justify-between text-sm num"><span>{s.score} / {s.maxScore}</span>{!s.complete && <span className="text-xs text-subtle">{s.answered}/{s.total} answered</span>}</div>
            <Meter value={s.score / s.maxScore} tone={s.tier === 'high' || s.tier === 'unacceptable' ? 'bad' : s.tier === 'limited' ? 'held' : 'ok'} label={`Score ${s.score} of ${s.maxScore}`} />
          </div>
        );
      },
    },
    {
      key: 'tier', header: <span className="inline-flex items-center gap-1">Result <Help text="Risk and framework templates: the tier the points give, written to the system only when a different person approves. Pack admission: the gates met." /></span>,
      sort: (r) => (variantOf(r).kind === 'admission' ? -1 : TIER_META[r.status === 'draft' ? summarise(r).tier : r.resultTier].rank),
      cell: (r) => <ResultCell a={r} />,
    },
    { key: 'author', header: 'Author', hideBelow: 'lg', sort: (r) => r.authorId, cell: (r) => <Person id={r.authorId} size={20} /> },
    { key: 'reviewer', header: 'Reviewer', hideBelow: 'lg', cell: (r) => (r.reviewerId ? <Person id={r.reviewerId} size={20} /> : <span className="text-xs text-subtle">{r.status === 'submitted' ? 'Not yet' : '—'}</span>) },
    {
      key: 'dates', header: 'Dates', hideBelow: 'md', align: 'right', sort: (r) => r.reviewedAt ?? r.submittedAt ?? r.createdAt,
      cell: (r) => (
        <div className="text-xs leading-tight py-1 whitespace-nowrap">
          <p className="text-fg">
            {r.reviewedAt ? (r.status === 'approved' ? 'Approved ' : 'Reviewed ') : r.submittedAt ? 'Submitted ' : 'Started '}
            <When iso={r.reviewedAt ?? r.submittedAt ?? r.createdAt} />
          </p>
          {(r.reviewedAt || r.submittedAt) && <p className="text-muted mt-0.5">Started {date(r.createdAt)}</p>}
        </div>
      ),
    },
  ];

  const startButton = (
    <Button variant="primary" icon={<ClipboardList className="h-4 w-4" />} disabled={!!startBlocked} onClick={() => { setStartWith({}); setStartOpen(true); }}>
      Start an assessment
    </Button>
  );

  return (
    <div>
      <PageHeader
        kicker="Records"
        title="Assessments"
        description="Explained, deterministic scores. Each answer adds fixed points; the total against the thresholds gives the tier. A different person must sign off before the tier is written to the AI system or a regulatory pack is admitted."
        // roles that do not write assessments read the page without the button
        actions={!canAuthor ? undefined : startBlocked ? <Tooltip content={startBlocked}>{startButton}</Tooltip> : startButton}
      />

      {noSystems && canAuthor && (
        <Banner tone="info" className="mb-6" title="Register an AI system first" actions={<Button size="sm" variant="secondary" onClick={() => nav('/inventory')}>Open the AI inventory</Button>}>
          An assessment is always of a system in the inventory. Agents join it automatically when they are added.
        </Banner>
      )}
      {(q.error || inv.error) && <Banner tone="bad" className="mb-6" title="Assessments did not load" actions={<Button size="sm" onClick={() => { q.refetch(); inv.refetch(); }}>Try again</Button>}>{(q.error ?? inv.error)?.message}</Banner>}

      {/* Templates explained */}
      <section aria-labelledby="tpl-h" className="mb-8">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <h2 id="tpl-h" className="text-xl font-semibold">{inPlan.length} templates, scored the same way every time</h2>
          <p className="text-sm text-muted">No model scores an assessment. Points are fixed per answer.</p>
        </div>
        <div className="grid gap-px bg-line border border-line sm:grid-cols-2 xl:grid-cols-4">
          {inPlan.map((v) => <TemplateCard key={v} v={v} inUse={usage[v] ?? 0} />)}
        </div>
        {/* templates above the plan are left out; owners see one line each on the plan that adds them */}
        {abovePlan.map((v) => <PlanUpsell key={v} to={VARIANTS[v].level!} className="mt-2" what={`${VARIANTS[v].label} is part of ${LEVEL_INFO[VARIANTS[v].level!].label}.`} />)}
        <div className="mt-3 grid gap-3 sm:grid-cols-3 text-sm">
          <p className="flex items-start gap-2 text-muted"><Sigma className="h-4 w-4 mt-0.5 shrink-0 text-fg" aria-hidden />Total points against the thresholds give Minimal, Limited or High. A prohibited practice gives Unacceptable whatever the total. Pack admission passes only when all 5 gates are met.</p>
          <p className="flex items-start gap-2 text-muted"><UserCheck className="h-4 w-4 mt-0.5 shrink-0 text-fg" aria-hidden />The author cannot sign off their own assessment. Owners and admins sign off; the check is by person, not by role.</p>
          <p className="flex items-start gap-2 text-muted"><Scale className="h-4 w-4 mt-0.5 shrink-0 text-fg" aria-hidden />Approval sets the system’s risk tier and its next review: 6 months for high and unacceptable, 12 months for limited, 24 months for minimal.</p>
        </div>
      </section>

      {canSign && waitingForMe > 0 && (
        <Banner tone="held" className="mb-4" title={`${plural(waitingForMe, 'assessment')} waiting for sign-off`} actions={tab !== 'submitted' ? <Button size="sm" variant="secondary" onClick={() => setParams({ status: 'submitted' }, { replace: true })}>Show them</Button> : undefined}>
          You can sign off any assessment you did not write. They are also in Work › Reviews.
        </Banner>
      )}
      {unassessed.length > 0 && (
        <p className="mb-4 text-sm text-muted">
          {plural(unassessed.length, 'AI system')} {unassessed.length === 1 ? 'has' : 'have'} no approved risk assessment: {unassessed.slice(0, 4).map((s, i) => <span key={s.id}>{i > 0 && ', '}<Link to={`/inventory/${s.id}`} className="text-fg underline underline-offset-2">{s.name}</Link></span>)}{unassessed.length > 4 && ` and ${n(unassessed.length - 4)} more`}.
        </p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <Tabs<TabKey> label="Filter by status" value={tab} onChange={(v) => setParams(v === 'all' ? { status: 'all' } : { status: v }, { replace: true })} items={TABS.map((t) => ({ ...t, count: q.data ? counts[t.value] : undefined }))} className="flex-1 min-w-0 overflow-y-hidden" />
        <div className="w-full sm:w-60"><SearchInput aria-label="Search assessments" placeholder="Search system or template" value={needle} onChange={(e) => setNeedle(e.target.value)} /></div>
      </div>

      <DataTable
        caption="Assessments"
        columns={columns}
        rows={q.data ? shown : undefined}
        loading={q.loading}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/assessments/${r.id}`)}
        initialSort={{ key: 'dates', dir: 'desc' }}
        empty={rows.length === 0 ? (
          <EmptyState title="No assessments yet" disc="registration" action={canAuthor && !noSystems ? <Button variant="primary" onClick={() => setStartOpen(true)}>Start an assessment</Button> : noSystems && canRegister ? <Button variant="secondary" onClick={() => nav('/inventory')}>Register an AI system first</Button> : undefined}>
            Start with a risk triage for each AI system in the inventory.
          </EmptyState>
        ) : (
          <EmptyState compact title={`No assessments ${tab === 'all' ? 'match' : `in “${TABS.find((t) => t.value === tab)?.label}”`}`} disc="registration">
            {tab === 'submitted' ? 'Nothing is waiting for sign-off.' : 'Try another tab or clear the search.'}
          </EmptyState>
        )}
      />
      {startBlocked && canAuthor && noSystems && <p className="mt-2"><Blocked>Register an AI system first — <Link to="/inventory" className="underline">AI inventory</Link></Blocked></p>}

      {canAuthor && <StartAssessmentDialog open={startOpen} onClose={() => setStartOpen(false)} systems={inv.data ?? []} systemId={startWith.system} suggested={startWith.variant} />}
    </div>
  );
}

function TemplateCard({ v, inUse }: { v: VariantId; inUse: number }) {
  const def = VARIANTS[v];
  const b = bands(def.maxScore);
  const sections = Array.from(new Set(def.questions.map((q) => q.section)));
  const tone = { minimal: 'bg-ok', limited: 'bg-held', high: 'bg-bad' } as Record<string, string>;
  return (
    <article className="bg-surface p-5 flex flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold leading-snug">{def.label}</h3>
        <span className="text-xs text-muted num shrink-0">{plural(inUse, 'assessment')}</span>
      </div>
      <p className="mt-1.5 text-sm text-muted leading-relaxed">{def.purpose}</p>
      <p className="mt-2 text-xs text-subtle">{def.when}</p>
      {def.profileId && <p className="mt-2 text-xs text-muted">Profile <SmartLink to="/assurance/profiles" plainClassName="font-mono" className="font-mono underline underline-offset-2">{def.profileId}</SmartLink></p>}
      <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="label">{def.kind === 'admission' ? 'Gates' : 'Questions'}</dt><dd className="num font-medium mt-0.5">{def.questions.length}</dd></div>
        <div><dt className="label">Points</dt><dd className="num font-medium mt-0.5">{def.maxScore}</dd></div>
        <div><dt className="label">Sections</dt><dd className="num font-medium mt-0.5">{sections.length}</dd></div>
      </dl>
      <div className="mt-auto pt-4">
        <div className="pt-4 border-t border-line">
          {def.kind === 'admission' ? (
            <p className="text-xs text-muted">Admitted when all 5 gates are met (0 points) and a different person approves. Any unmet gate keeps the pack's rules off for the agent.</p>
          ) : (
            <>
              <p className="label mb-2">Thresholds</p>
              <div className="flex h-2 gap-px" aria-hidden>
                {b.map((x) => <div key={x.tier} className={cn(tone[x.tier], 'opacity-80')} style={{ width: `${((x.to - x.from + 1) / (def.maxScore + 1)) * 100}%` }} />)}
              </div>
              <ul className="mt-2 grid grid-cols-3 gap-2 text-xs">
                {b.map((x) => <li key={x.tier}><span className="block font-medium">{TIER_META[x.tier].label.replace(' risk', '')}</span><span className="num text-muted">{x.from}–{x.to}</span></li>)}
              </ul>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
