import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArrowRight, ClipboardList, ExternalLink, FileDown, MoveRight, Pencil } from 'lucide-react';
import { ModelDocDialog } from './model';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { canExportModelDoc } from '@/mock/records';
import { userName } from '@/mock/users';
import type { Assessment, Lifecycle } from '@/types';
import { atLeast } from '@/lib/levels';
import { isReadOnly } from '@/lib/autonomy';
import { Badge, Banner, Button, DataTable, Dialog, EmptyState, Field, Help, KeyValue, Meter, PageHeader, Panel, Skeleton, Textarea, Timeline, Tooltip, toast, type Column } from '@/components/ui';
import { AgentLink, AgentStatus, Person, ReceiptLink, RouteMode, When } from '@/components/domain';
import { date, n, pct, plural, seqLabel } from '@/lib/format';
import { DecisionChip } from '@/components/ui';
import { useLocalAssessments, effectiveSystem, mergeAssessments, isLocalOnly } from '@/features/assessments/local';
import { StartAssessmentDialog } from '@/features/assessments/StartAssessmentDialog';
import { summarise, variantOf } from '@/features/assessments/templates';
import { coverageOf, indexControls, liveControls, requirementsOf } from '@/features/compliance/evidence';
import { AssessmentStatusChip, IMPACT_META, ImpactBadge, KIND_LABEL, LIFECYCLE_META, LifecycleChip, LifecycleStepper, NextReview, TEMPLATE_LABEL, TIER_HELP, TierChip } from './governance';
import { ChainStrip, type ChainNode } from './ChainStrip';
import { RegisterSystemDrawer } from './RegisterSystemDrawer';
import { extraOf, lifecycleBlock, nextStage, setLifecycle } from './ops';
import { SmartLink } from '@/shell/access';

/** An approved risk assessment (pack admissions are excluded: they do not set a risk tier). */
function isRiskApproval(a: Assessment) {
  return a.status === 'approved' && variantOf(a as Assessment & { variant?: Parameters<typeof variantOf>[0]['variant'] }).kind !== 'admission';
}

export default function AiSystemPage() {
  const { id = '' } = useParams();
  const orgId = useOrgId();
  const nav = useNavigate();
  const canAuthor = useCan('assessments.author');
  const [startOpen, setStartOpen] = useState(false);
  const local = useLocalAssessments(orgId);

  const user = useUser();
  const level = useOrgLevel();
  const canManage = useCan('inventory.manage');
  const [editOpen, setEditOpen] = useState(false);
  const [move, setMove] = useState<Lifecycle>();
  const [docOpen, setDocOpen] = useState(false);
  // the export refuses the approver role (mock/records.ts exportModelDoc); the button says so before anyone presses it
  const canExportDoc = canExportModelDoc(useRole());
  const q = useQuery(async (o) => {
    api.records.ensureSeed(o); // model name and version on seeded systems
    const s = await api.aiSystem(o, id);
    const [agentDetail, comp, grants, proposals, admin, members, agents, inv] = await Promise.all([
      s.agent ? api.agent(o, s.agent.slug).catch(() => undefined) : Promise.resolve(undefined),
      api.compliance(o),
      api.grants(o),
      api.graduationProposals(o),
      api.receipts(o, { kind: 'admin', q: s.system.name }),
      api.members(o),
      api.agents(o),
      api.inventory(o),
    ]);
    return { ...s, agentDetail, comp, grants, proposals, admin: admin.items.filter((r) => r.details?.system === s.system.name).slice(0, 8), members, agents, inv, extra: extraOf(o, s.system.id) };
  }, [id, level]);

  const view = useMemo(() => {
    if (!q.data) return undefined;
    const { system, assessments, comp } = q.data;
    const mine = local.filter((a) => a.aiSystemId === system.id);
    const all = mergeAssessments<Assessment>(assessments, mine, (a) => a).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const sys = effectiveSystem(system, local, assessments);
    const controls = liveControls(orgId, comp.controls);
    const byId = indexControls(controls);
    const fws = comp.frameworks.filter((f) => system.frameworks.includes(f.id));
    // the controls /compliance maps (the level's controls and mappings included), not only the saved mapping
    const controlIds = Array.from(new Set(fws.flatMap((f) => requirementsOf(f, byId).flatMap((r) => r.controlIds)))).sort();
    const tierSource = sys.riskTier === 'unassessed' ? undefined
      : all.filter((a) => isRiskApproval(a) && a.resultTier === sys.riskTier).sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''))[0];
    return { sys, all, fws, byId, controlIds, tierSource };
  }, [q.data, local, orgId]);

  if (q.error) {
    return (
      <div>
        <PageHeader kicker="Records" title="AI system" crumbs={[{ label: 'AI inventory', to: '/inventory' }, { label: 'Not found' }]} />
        <Banner tone="bad" title="This AI system could not be opened" actions={<Button size="sm" onClick={() => nav('/inventory')}>Back to the inventory</Button>}>{q.error.message} It may belong to another organisation.</Banner>
      </div>
    );
  }

  if (!q.data || !view) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-96 max-w-full" />
        <Skeleton className="h-28" />
        <div className="grid gap-6 lg:grid-cols-12"><Skeleton className="h-80 lg:col-span-8" /><Skeleton className="h-80 lg:col-span-4" /></div>
      </div>
    );
  }

  const { agent, agentDetail, receipts, grants, proposals, admin, extra } = q.data;
  const { sys, all, fws, byId, controlIds, tierSource } = view;
  // only an approved risk assessment counts: a pack admission does not set a risk tier
  const approvedAssessment = all.some(isRiskApproval);
  const next = nextStage(sys.lifecycle);
  const nextBlock = next ? lifecycleBlock(next, approvedAssessment) : undefined;
  const l3 = atLeast(level, 'l3');
  // write types only: reads run at every level
  const agentRows = agent ? grants.rows.filter((r) => r.agentSlug === agent.slug && !isReadOnly(r.tags)) : [];
  const openProposals = agent ? proposals.filter((p) => p.agentSlug === agent.slug && p.status === 'open') : [];
  const levelCounts = agentRows.reduce<Record<string, number>>((m, r) => { const k = r.grant ? r.level : 'none'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const noGrant = levelCounts.none ?? 0;
  const graduated = agentRows.filter((r) => r.graduated).length;
  // earned autonomy is part of L3: below it the chain has no autonomy link at all
  const autonomyNode: ChainNode | undefined = !l3
    ? undefined
    : !agent
    ? { key: 'autonomy', label: 'Autonomy', value: 'No agent', sub: 'Autonomy is earned per agent and write type', state: 'missing' }
      : agentRows.length === 0
        ? { key: 'autonomy', label: 'Autonomy', value: grants.noGrantLabel, sub: 'No write type has a level', to: `/agents/autonomy?agent=${agent.slug}`, state: 'missing' }
        : {
          key: 'autonomy', label: 'Autonomy',
          value: <span className="text-[13px]">{Object.entries(levelCounts).filter(([k]) => k !== 'none').sort().map(([k, c]) => `${k} × ${c}`).join(' · ') || grants.noGrantLabel}</span>,
          sub: <>{noGrant ? `${plural(noGrant, 'write type')}: ${grants.noGrantLabel}` : `${graduated} of ${plural(agentRows.length, 'write type')} graduated to A3`}{openProposals.length ? ` · ${plural(openProposals.length, 'graduation proposal')} open` : ''}</>,
          to: `/agents/autonomy?agent=${agent.slug}`, state: noGrant || openProposals.length ? 'warn' : 'ok',
        };
  const rulebook = agentDetail?.rulebook;
  const published = rulebook?.versions.find((v) => v.version === rulebook.currentVersion);
  const latest = all[0];
  const evidenced = controlIds.filter((c) => byId[c]?.status === 'evidenced').length;

  const nodes: ChainNode[] = ([
    { key: 'system', label: 'AI system', value: <span className="line-clamp-2">{sys.name}</span>, sub: `${KIND_LABEL[sys.kind]} · ${LIFECYCLE_META[sys.lifecycle].label}`, to: '#details', state: 'ok' },
    latest
      ? { key: 'assess', label: all.length > 1 ? 'Assessments' : 'Assessment', value: plural(all.length, 'assessment'), sub: `Latest: ${TEMPLATE_LABEL[latest.template]} · ${latest.status === 'submitted' ? 'waiting for sign-off' : latest.status.replace('_', ' ')}`, to: `/assessments/${latest.id}`, state: approvedAssessment ? 'ok' : 'warn' }
      : { key: 'assess', label: 'Assessment', value: 'None yet', sub: 'Start one to set a risk tier', state: 'missing' },
    { key: 'tier', label: 'Risk tier', value: <TierChip tier={sys.riskTier} />, sub: tierSource ? `Set by sign-off ${tierSource.reviewedAt ? date(tierSource.reviewedAt) : ''}` : 'Set only by an approved assessment', to: tierSource ? `/assessments/${tierSource.id}` : undefined, state: sys.riskTier === 'unassessed' ? 'missing' : 'ok' },
    agent
      ? { key: 'agent', label: 'Linked agent', value: <span className="font-medium">{agent.slug}</span>, sub: <span className="inline-flex flex-wrap gap-1">{agent.status === 'active' ? 'Active' : agent.status} · {agent.route === 'mcp' ? 'governed run' : 'check and record'}</span>, to: `/agents/${agent.slug}`, state: agent.status === 'active' ? 'ok' : 'warn' }
      : { key: 'agent', label: 'Linked agent', value: 'Not linked', sub: 'Not governed at runtime', state: 'missing' },
    autonomyNode,
    rulebook && published
      ? { key: 'rulebook', label: 'Rulebook', value: <span className="font-mono text-[13px]">{rulebook.slug} v{rulebook.currentVersion}</span>, sub: `${plural(published.rules.length, 'rule')} · default refuse`, to: `/rulebooks/${rulebook.slug}`, state: 'ok' }
      : { key: 'rulebook', label: 'Rulebook', value: agent ? 'Not found' : 'None', sub: agent ? 'The agent has no published rulebook' : 'Needs a linked agent', state: 'missing' },
    agent && receipts.length
      ? { key: 'receipts', label: 'Receipts', value: <span className="font-mono text-[12.5px]">{seqLabel(receipts[0].seq)}</span>, sub: `${n(agent.stats.calls7d)} decisions in 7 days`, to: `/activity?agent=${agent.slug}&range=7d`, state: 'ok' }
      : { key: 'receipts', label: 'Receipts', value: 'None', sub: agent ? 'No decisions recorded yet' : 'Only linked agents leave receipts', state: 'missing' },
    controlIds.length
      ? { key: 'controls', label: 'Framework controls', value: `${evidenced} of ${plural(controlIds.length, 'control')}`, sub: `evidenced across ${plural(fws.length, 'framework')}`, to: '/compliance', state: evidenced === controlIds.length ? 'ok' : 'warn' }
      : { key: 'controls', label: 'Framework controls', value: 'None mapped', sub: 'Choose the frameworks that apply', state: 'missing' },
  ] as (ChainNode | undefined)[]).filter((x): x is ChainNode => !!x);

  const history = [
    { ts: sys.createdAt, title: `Registered as ${KIND_LABEL[sys.kind].toLowerCase()}`, body: <>Owner {userName(sys.ownerId)} · {sys.businessUnit}</>, tone: 'neutral' as const },
    ...(agent ? [{ ts: agent.createdAt, title: <>Agent <AgentLink slug={agent.slug} /> created</>, body: agent.route === 'mcp' ? 'Governed run — Elan1 Govern holds the credentials.' : 'Check and record — advises and records; the agent runs the call.', tone: 'info' as const }] : []),
    ...all.flatMap((a) => [
      { ts: a.createdAt, title: <><Link className="hover:underline underline-offset-2" to={`/assessments/${a.id}`}>{TEMPLATE_LABEL[a.template]}</Link> started</>, body: `by ${userName(a.authorId)}`, tone: 'neutral' as const },
      ...(a.submittedAt ? [{ ts: a.submittedAt, title: `${TEMPLATE_LABEL[a.template]} submitted for sign-off`, body: `${a.score} of ${a.maxScore} points`, tone: 'held' as const }] : []),
      ...(a.reviewedAt ? [{ ts: a.reviewedAt, title: a.status === 'approved' ? `${TEMPLATE_LABEL[a.template]} approved — tier set to ${a.resultTier}` : `Changes requested on ${TEMPLATE_LABEL[a.template]}`, body: `by ${userName(a.reviewerId)}${a.reviewNote ? ` — “${a.reviewNote}”` : ''}`, tone: a.status === 'approved' ? ('ok' as const) : ('bad' as const) }] : []),
    ]),
    ...admin.map((r) => ({ ts: r.ts, title: <>{r.action === 'inventory.lifecycle_changed' ? `Moved to ${LIFECYCLE_META[r.details?.to as Lifecycle]?.label ?? r.details?.to}` : r.action === 'inventory.retired' ? 'Retired' : r.action} <ReceiptLink seq={r.seq} /></>, body: `by ${userName(r.actor)}${r.details?.reason ? ` — “${r.details.reason}”` : ''}`, tone: (r.action === 'inventory.retired' ? 'bad' : 'neutral') as 'bad' | 'neutral' })),
  ].filter((x) => x.ts).sort((a, b) => b.ts.localeCompare(a.ts));

  const assessmentCols: Column<Assessment>[] = [
    { key: 'template', header: 'Template', cell: (a) => <span className="font-medium">{TEMPLATE_LABEL[a.template]}{isLocalOnly(a.id) && <Badge className="ml-2">This browser</Badge>}</span> },
    { key: 'status', header: 'Status', cell: (a) => <AssessmentStatusChip status={a.status} /> },
    {
      key: 'score', header: 'Score', hideBelow: 'sm', cell: (a) => {
        const s = summarise(a);
        return <div className="w-28"><p className="num text-sm">{s.score} / {s.maxScore}</p><Meter value={s.score / s.maxScore} label="Score" /></div>;
      },
    },
    { key: 'tier', header: 'Result', cell: (a) => (a.status === 'approved' || a.status === 'submitted' ? <TierChip tier={a.resultTier} /> : <span className="text-xs text-subtle">Not final</span>) },
    { key: 'author', header: 'Author', hideBelow: 'md', cell: (a) => <Person id={a.authorId} size={20} /> },
    { key: 'when', header: 'Updated', hideBelow: 'md', align: 'right', cell: (a) => <When iso={a.reviewedAt ?? a.submittedAt ?? a.createdAt} /> },
  ];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        crumbs={[{ label: 'AI inventory', to: '/inventory' }, { label: sys.name }]}
        kicker="Records · AI system"
        title={sys.name}
        description={sys.purpose}
        meta={
          <>
            <Badge>{KIND_LABEL[sys.kind]}</Badge>
            <LifecycleChip stage={sys.lifecycle} size="md" />
            <TierChip tier={sys.riskTier} size="md" />
            <Help text={TIER_HELP} />
            <span className="text-sm text-muted ml-1">Owner</span>
            <Person id={sys.ownerId} size={22} />
          </>
        }
        actions={
          <>
            {/* actions a role cannot take are left out; a rule that blocks a step (no approved assessment, retired) keeps its reason */}
            {canManage && (
              <Tooltip content={sys.lifecycle === 'retired' ? 'Retired: its record is kept as it is' : 'Change name, owner, purpose, linked agent, residency and personal data'}>
                <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} disabled={sys.lifecycle === 'retired'} onClick={() => setEditOpen(true)}>Edit details</Button>
              </Tooltip>
            )}
            {next && canManage && (
              <Tooltip content={nextBlock ?? `Move from ${LIFECYCLE_META[sys.lifecycle].label} to ${LIFECYCLE_META[next].label}`}>
                <Button variant="secondary" icon={<MoveRight className="h-4 w-4" />} disabled={!!nextBlock} onClick={() => setMove(next)}>Move to {LIFECYCLE_META[next].label}</Button>
              </Tooltip>
            )}
            {sys.lifecycle !== 'retired' && canManage && (
              <Tooltip content="No longer in use; kept for the record">
                <Button variant="quiet-danger" icon={<Archive className="h-4 w-4" />} onClick={() => setMove('retired')}>Retire</Button>
              </Tooltip>
            )}
            {canExportDoc && (
              <Tooltip content="Model documentation for an RBI supervisory review: model and version, data, risk tier, sign-off, rules in force and change log">
                <Button variant="secondary" icon={<FileDown className="h-4 w-4" />} onClick={() => setDocOpen(true)}>RBI model documentation</Button>
              </Tooltip>
            )}
            {canAuthor && (
              <Button variant="primary" icon={<ClipboardList className="h-4 w-4" />} onClick={() => setStartOpen(true)}>
                Start an assessment
              </Button>
            )}
          </>
        }
      />
      {docOpen && <ModelDocDialog systems={q.data.inv} initial={[sys.id]} onClose={() => setDocOpen(false)} />}

      {approvedAssessment && (sys.lifecycle === 'proposed' || sys.lifecycle === 'in_review') && canManage && (
        <Banner tone="info" className="mb-6" title="An assessment is approved — the lifecycle has not moved"
          actions={next ? <Button size="sm" variant="secondary" disabled={!!nextBlock} onClick={() => setMove(next)}>Move to {LIFECYCLE_META[next].label}</Button> : undefined}>
          A person moves the stage; approving an assessment never moves it on its own. {next === 'in_review' ? 'In review comes first, then Approved.' : ''}
        </Banner>
      )}
      {sys.lifecycle === 'retired' && <Banner tone="neutral" className="mb-6" title="Retired">No longer in use. Its record, assessments and receipts are kept.</Banner>}

      <section className="mb-6" aria-labelledby="chain-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
          <h2 id="chain-h" className="label">Governance chain — from this system to the evidence</h2>
          <span className="text-xs text-muted">Dashed boxes are missing links</span>
        </div>
        <ChainStrip nodes={nodes} />
      </section>

      {sys.riskTier === 'unassessed' && (
        <Banner tone="held" className="mb-6" title="No approved assessment yet" actions={canAuthor ? <Button size="sm" variant="secondary" onClick={() => setStartOpen(true)}>Start an assessment</Button> : undefined}>
          {sys.lifecycle === 'live' ? 'This system is live without an approved assessment.' : 'Its risk tier stays Unassessed until a different person approves an assessment.'}
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8 space-y-6 min-w-0">
          <Panel id="details" title="Details" flush>
            <div className="px-5 pt-4"><LifecycleStepper stage={sys.lifecycle} /></div>
            <div className="px-5 py-3">
              <KeyValue cols={2} items={[
                { k: 'Kind', v: KIND_LABEL[sys.kind] },
                { k: 'Vendor', v: sys.vendor },
                { k: 'Model', v: sys.modelName ?? <span className="text-subtle">{canManage ? 'Not recorded — edit details' : 'Not recorded'}</span> },
                { k: 'Model version', v: sys.modelVersion ? <span className="font-mono text-[12px] break-all">{sys.modelVersion}</span> : <span className="text-subtle">—</span> },
                { k: 'Owner', v: <Person id={sys.ownerId} size={20} /> },
                { k: 'Business unit', v: sys.businessUnit },
                { k: 'Decision impact', v: <span className="inline-flex items-center gap-1.5"><ImpactBadge impact={sys.decisionImpact} /><Help text={IMPACT_META[sys.decisionImpact].help} /></span> },
                { k: 'Linked agent', v: agent ? <AgentLink slug={agent.slug} /> : <span className="text-subtle">Not linked</span> },
                { k: 'Registered', v: date(sys.createdAt) },
                { k: 'Next review', v: <NextReview iso={sys.nextReview} className="items-end" /> },
                { k: 'Data categories', v: sys.dataCategories.length ? <span className="inline-flex flex-wrap justify-end gap-1">{sys.dataCategories.map((d) => <Badge key={d}>{d}</Badge>)}</span> : '—' },
                { k: 'Affected people', v: sys.affectedPeople.length ? <span className="inline-flex flex-wrap justify-end gap-1">{sys.affectedPeople.map((d) => <Badge key={d}>{d}</Badge>)}</span> : '—' },
                { k: 'Data residency', v: extra?.residency ?? <span className="text-subtle">{canManage ? 'Not recorded — edit details' : 'Not recorded'}</span> },
                { k: 'Personal data (DPDP)', v: extra ? (extra.personalData ? <span className="inline-flex flex-wrap justify-end gap-1">{extra.principals.map((d) => <Badge key={d} tone="info">{d}</Badge>)}<SmartLink to="/records/erasure" hideWhenBlocked className="text-xs underline underline-offset-2 ml-1">Erasure</SmartLink></span> : 'No') : <span className="text-subtle">Not recorded</span> },
              ]} />
            </div>
          </Panel>

          <Panel
            id="assessments"
            title="Assessments"
            actions={<Link to="/assessments" className="text-sm text-muted hover:text-fg inline-flex items-center gap-1">All assessments <ArrowRight className="h-3.5 w-3.5" /></Link>}
            flush
          >
            {all.length === 0 ? (
              <EmptyState compact title="No assessments yet" disc="registration" action={canAuthor ? <Button size="sm" variant="primary" onClick={() => setStartOpen(true)}>Start an assessment</Button> : undefined}>
                A risk triage takes a few minutes. When a different person approves it, the result becomes this system’s risk tier.
              </EmptyState>
            ) : (
              <DataTable className="!border-0"columns={assessmentCols} rows={all} rowKey={(a) => a.id} onRowClick={(a) => nav(`/assessments/${a.id}`)} />
            )}
          </Panel>

          <Panel title="Linked agent" kicker="Runtime" flush>
            {!agent ? (
              <EmptyState compact title="No agent linked" disc="gate">
                This system is registered but not governed at runtime, so it leaves no receipts. Vendor tools and models usually stay unlinked; agents should be linked to their Elan1 Govern agent.
              </EmptyState>
            ) : (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-line">
                  <div className="flex flex-wrap items-center gap-2">
                    <AgentLink slug={agent.slug} className="text-md" />
                    <AgentStatus agent={agent} />
                    <RouteMode route={agent.route} />
                  </div>
                  <div className="flex gap-2">
                    {rulebook && <Button size="sm" variant="secondary" onClick={() => nav(`/rulebooks/${rulebook.slug}`)}>Rulebook v{rulebook.currentVersion}</Button>}
                    <Button size="sm" variant="ghost" iconRight={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => nav(`/activity?agent=${agent.slug}&range=all`)}>All activity</Button>
                  </div>
                </div>
                <AgentStats stats={agent.stats} />
                {receipts.length ? (
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Recent receipts for {agent.slug}</caption>
                    <thead className="bg-sunken/60"><tr className="border-y border-line"><th scope="col" className="label text-left px-4 sm:px-5 h-8">Receipt</th><th scope="col" className="label text-left px-3 h-8 hidden sm:table-cell">Tool</th><th scope="col" className="label text-left px-3 h-8">Decision</th><th scope="col" className="label text-right px-4 sm:px-5 h-8">When</th></tr></thead>
                    <tbody>
                      {receipts.slice(0, 8).map((r) => (
                        <tr key={r.seq} className="border-b border-line last:border-b-0 h-10">
                          <td className="px-4 sm:px-5"><ReceiptLink seq={r.seq} /></td>
                          <td className="px-3 font-mono text-[12px] text-muted truncate max-w-[180px] hidden sm:table-cell">{r.tool ?? r.action ?? '—'}</td>
                          <td className="px-3"><DecisionChip decision={r.decision} size="sm" short /></td>
                          <td className="px-4 sm:px-5 text-right text-muted"><When iso={r.ts} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                ) : <p className="px-5 py-4 text-sm text-muted">No receipts yet for this agent.</p>}
              </div>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-4 space-y-6 min-w-0">
          <Panel title="Risk tier" kicker="From sign-off">
            <div className="flex items-center justify-between gap-3">
              <TierChip tier={sys.riskTier} size="md" />
              <NextReview iso={sys.nextReview} className="items-end" />
            </div>
            <p className="mt-3 text-sm text-muted leading-relaxed">
              {tierSource
                ? <>Set when {userName(tierSource.reviewerId)} approved the <Link to={`/assessments/${tierSource.id}`} className="underline underline-offset-2 hover:text-fg">{TEMPLATE_LABEL[tierSource.template].toLowerCase()}</Link>{tierSource.reviewedAt && <> on {date(tierSource.reviewedAt)}</>}. Nobody can edit it by hand.</>
                : TIER_HELP}
            </p>
          </Panel>

          <Panel title="Frameworks that apply" flush footer={<span>Coverage counts receipts; it is not a test that a control works.</span>}>
            {fws.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No frameworks chosen for this system.</p> : (
              <ul className="divide-y divide-line">
                {fws.map((f) => {
                  const c = coverageOf(f, byId);
                  return (
                    <li key={f.id}>
                      <SmartLink to={`/compliance/${f.id}`} className="block px-5 py-3 hover:bg-sunken/60" plainClassName="block px-5 py-3">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{f.short}</span>
                          {f.enabled ? <span className="text-xs text-muted num">{c.covered} of {c.total} · {pct(c.share)}</span> : <Badge>Turned off</Badge>}
                        </span>
                        <Meter className="mt-2" value={f.enabled ? c.share : 0} label={`${f.short} coverage`} />
                        <span className="block mt-1.5 text-xs text-subtle">{f.jurisdiction} · {f.officialRef}</span>
                      </SmartLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Lifecycle history">
            <Timeline items={history.map((h) => ({ time: <When iso={h.ts} />, title: h.title, body: h.body, tone: h.tone }))} />
            <p className="mt-4 text-xs text-subtle">Derived from the system’s records and receipts on the chain.</p>
          </Panel>
        </div>
      </div>

      {canAuthor && <StartAssessmentDialog open={startOpen} onClose={() => setStartOpen(false)} systems={[sys]} systemId={sys.id} suggested={sys.riskTier === 'unassessed' && !all.length ? 'risk_triage' : extra?.personalData || sys.dataCategories.length ? 'data_protection' : 'impact'} />}
      {canManage && <RegisterSystemDrawer open={editOpen} onClose={() => setEditOpen(false)} edit={q.data.system} agents={q.data.agents} frameworks={q.data.comp.frameworks}
        people={q.data.members.filter((m) => m.role !== 'auditor' && m.status !== 'suspended').map((m) => ({ id: m.userId, name: m.user?.name ?? m.userId, title: m.user?.title ?? m.role, status: m.status }))}
        units={Array.from(new Set(q.data.inv.map((s) => s.businessUnit))).sort()}
        linkedAgentIds={q.data.inv.map((s) => s.linkedAgentId).filter(Boolean) as string[]} />}
      {canManage && <LifecycleDialog to={move} onClose={() => setMove(undefined)} systemId={sys.id} name={sys.name} from={sys.lifecycle} approved={approvedAssessment} userId={user?.id} />}
    </div>
  );
}

function LifecycleDialog({ to, onClose, systemId, name, from, approved, userId }: { to?: Lifecycle; onClose: () => void; systemId: string; name: string; from: Lifecycle; approved: boolean; userId?: string }) {
  const orgId = useOrgId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const retire = to === 'retired';
  const go = async () => {
    if (!to || !userId) return;
    setBusy(true); setErr(undefined);
    try {
      await setLifecycle(orgId, systemId, to, reason, approved, userId);
      toast.ok(retire ? `${name} retired` : `${name} moved to ${LIFECYCLE_META[to].label}`, 'The change is a receipt on the chain.');
      setReason('');
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!to} onClose={onClose} tone={retire ? 'danger' : undefined} title={retire ? `Retire ${name}?` : `Move ${name} to ${to ? LIFECYCLE_META[to].label : ''}?`}
      description={retire ? 'It is no longer in use. The record, its assessments and its receipts are kept; a retired system cannot move again.' : `From ${LIFECYCLE_META[from].label}. ${to ? LIFECYCLE_META[to].help : ''}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={retire ? 'danger' : 'primary'} loading={busy} disabled={retire && reason.trim().length < 4} onClick={go}>{retire ? 'Retire system' : `Move to ${to ? LIFECYCLE_META[to].label : ''}`}</Button></>}>
      <div className="space-y-3">
        {err && <Banner tone="bad" title="Could not change the stage">{err}</Banner>}
        <Field label={retire ? 'Reason' : 'Note (optional)'} required={retire} htmlFor="lc-reason" hint="Recorded on the receipt.">
          <Textarea id="lc-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
      </div>
    </Dialog>
  );
}

function AgentStats({ stats }: { stats: { calls7d: number; allowed7d: number; asked7d: number; refused7d: number } }) {
  const total = stats.calls7d || 1;
  const items = [
    { label: 'Decisions, 7 days', value: stats.calls7d, cls: 'bg-fg' },
    { label: 'Allowed', value: stats.allowed7d, cls: 'bg-ok' },
    { label: 'Asked a person', value: stats.asked7d, cls: 'bg-held' },
    { label: 'Refused', value: stats.refused7d, cls: 'bg-bad' },
  ];
  return (
    <div className="px-5 py-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {items.map((it) => (
          <div key={it.label}>
            <p className="label flex items-center gap-1.5">{it.cls !== 'bg-fg' && <span className={`h-2 w-2 ${it.cls}`} aria-hidden />}{it.label}</p>
            <p className="mt-1 font-display text-2xl font-semibold num">{n(it.value)}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex h-1.5 gap-px bg-line" aria-hidden>
        <div className="bg-ok" style={{ width: `${(stats.allowed7d / total) * 100}%` }} />
        <div className="bg-held" style={{ width: `${(stats.asked7d / total) * 100}%` }} />
        <div className="bg-bad" style={{ width: `${(stats.refused7d / total) * 100}%` }} />
      </div>
    </div>
  );
}
