import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Bot, FileDown, Plus, X } from 'lucide-react';
import { ModelDocDialog } from './model';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useRole, useUser } from '@/store/session';
import { canExportModelDoc } from '@/mock/records';
import type { Agent, AiSystem, DiscoveryFinding, Lifecycle, RiskTier } from '@/types';
import { Banner, Button, DataTable, EmptyState, Help, PageHeader, SearchInput, Select, Skeleton, Stat, Tooltip, type Column } from '@/components/ui';
import { AgentLink, Person } from '@/components/domain';
import { n, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useLocalAssessments, effectiveSystem } from '@/features/assessments/local';
import { ImpactBadge, KIND_LABEL, LIFECYCLE_META, LIFECYCLE_ORDER, LifecycleChip, NextReview, TIER_HELP, TIER_META, TIER_ORDER, TierChip, daysUntil, reviewState } from './governance';
import { RegisterSystemDrawer, type OwnerOption, type RegisterPrefill } from './RegisterSystemDrawer';
import { DiscoveryPanel, prefillFromFinding } from './Discovery';

type Row = Awaited<ReturnType<typeof api.inventory>>[number] & { tierFrom?: string };

const FRAMEWORK_TO_VENDOR: Record<string, string> = { Claude: 'Anthropic (Claude)', Cursor: 'Cursor', LangChain: 'LangChain', 'OpenAI Agents SDK': 'OpenAI Agents SDK', Custom: 'In-house' };

export default function InventoryPage() {
  const orgId = useOrgId();
  const nav = useNavigate();
  const canManage = useCan('inventory.manage');
  const [params, setParams] = useSearchParams();
  const user = useUser();
  const [drawer, setDrawer] = useState<{ open: boolean; prefill?: RegisterPrefill; findingId?: string }>({ open: false });
  const [queue, setQueue] = useState<Agent[]>([]);

  const [docOpen, setDocOpen] = useState(false);
  // the export refuses the approver role (mock/records.ts exportModelDoc); the button says so before anyone presses it
  const canExportDoc = canExportModelDoc(useRole());
  const inv = useQuery((o) => { api.records.ensureSeed(o); return api.inventory(o); });
  const agents = useQuery((o) => api.agents(o));
  const comp = useQuery((o) => api.compliance(o), [], { kinds: ['receipt'] });
  const membersQ = useQuery((o) => api.members(o), [], { kinds: ['receipt'] });
  const local = useLocalAssessments(orgId);

  const systems: Row[] = useMemo(() => (inv.data ?? []).map((s) => effectiveSystem(s, local, s.assessments)), [inv.data, local]);

  const q = params.get('q') ?? '';
  const kind = params.get('kind') ?? 'all';
  const stage = params.get('lifecycle') ?? 'all';
  const tier = params.get('tier') ?? 'all';
  const unit = params.get('unit') ?? 'all';
  const due = params.get('due') === '60';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (!v || v === 'all') next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };
  const filtersOn = q || kind !== 'all' || stage !== 'all' || tier !== 'all' || unit !== 'all' || due;

  const units = useMemo(() => Array.from(new Set(systems.map((s) => s.businessUnit))).sort(), [systems]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return systems.filter((s) =>
      (kind === 'all' || s.kind === kind) &&
      (stage === 'all' || s.lifecycle === stage) &&
      (tier === 'all' || (tier === HIGH_PLUS ? s.riskTier === 'high' || s.riskTier === 'unacceptable' : s.riskTier === tier)) &&
      (unit === 'all' || s.businessUnit === unit) &&
      (!due || ['overdue', 'soon'].includes(reviewState(s.nextReview))) &&
      (!needle || [s.name, s.vendor, s.purpose, s.businessUnit, s.agent?.slug].join(' ').toLowerCase().includes(needle)));
  }, [systems, q, kind, stage, tier, unit, due]);

  const stats = useMemo(() => ({
    total: systems.length,
    live: systems.filter((s) => s.lifecycle === 'live').length,
    high: systems.filter((s) => s.riskTier === 'high' || s.riskTier === 'unacceptable').length,
    unassessed: systems.filter((s) => s.riskTier === 'unassessed').length,
    due: systems.filter((s) => ['overdue', 'soon'].includes(reviewState(s.nextReview))).length,
    overdue: systems.filter((s) => reviewState(s.nextReview) === 'overdue').length,
  }), [systems]);

  const linkedAgentIds = systems.map((s) => s.linkedAgentId).filter(Boolean) as string[];
  const unregistered = (agents.data ?? []).filter((a) => !linkedAgentIds.includes(a.id) && !systems.some((s) => s.id === a.aiSystemId));
  const people: OwnerOption[] = useMemo(() => (membersQ.data ?? [])
    .filter((m) => m.role !== 'auditor' && m.status !== 'suspended')
    .map((m) => ({ id: m.userId, name: m.user?.name ?? m.userId, title: m.user?.title ?? m.role, status: m.status })), [membersQ.data]);

  const openRegister = (prefill?: RegisterPrefill) => setDrawer({ open: true, prefill });
  const agentPrefill = (a: Agent): RegisterPrefill => ({ name: a.name, kind: 'agent', vendor: FRAMEWORK_TO_VENDOR[a.framework] ?? a.framework, purpose: a.description, ownerId: a.ownerId, linkedAgentId: a.id, lifecycle: 'in_review', modelName: a.modelName, modelVersion: a.modelVersion });
  const registerAgent = (a: Agent) => { setQueue([]); openRegister(agentPrefill(a)); };
  const registerAll = () => { setQueue(unregistered.slice(1)); openRegister(agentPrefill(unregistered[0])); };
  const registerFinding = (f: DiscoveryFinding) => { setQueue([]); setDrawer({ open: true, prefill: prefillFromFinding(f, user?.id), findingId: f.id }); };
  const afterRegistered = () => {
    // "Register all": open the next agent once this one is saved
    const [next, ...rest] = queue;
    if (next) window.setTimeout(() => { setQueue(rest); openRegister(agentPrefill(next)); }, 50);
  };

  const columns: Column<Row>[] = [
    {
      key: 'name', header: 'AI system', sort: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <div className="min-w-0 py-1.5 max-w-[320px]">
          <Link to={`/inventory/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline underline-offset-2">{r.name}</Link>
          <p className="text-xs text-muted truncate" title={r.purpose}>{KIND_LABEL[r.kind]} · {r.vendor}</p>
        </div>
      ),
    },
    {
      key: 'model', header: 'Model · version', hideBelow: 'lg', sort: (r) => r.modelName ?? '~',
      cell: (r) => r.modelName ? <div className="py-1.5 max-w-[220px]"><p className="text-sm truncate" title={r.modelName}>{r.modelName}</p><p className="font-mono text-[11px] text-muted truncate" title={r.modelVersion}>{r.modelVersion ?? '—'}</p></div> : <span className="text-xs text-subtle">Not recorded</span>,
    },
    {
      key: 'owner', header: 'Owner · unit', hideBelow: 'md', sort: (r) => `${r.businessUnit} ${r.ownerId}`,
      cell: (r) => <div className="py-1.5"><Person id={r.ownerId} size={22} /><p className="text-xs text-muted mt-0.5 pl-[30px]">{r.businessUnit}</p></div>,
    },
    { key: 'lifecycle', header: 'Lifecycle', sort: (r) => LIFECYCLE_ORDER.indexOf(r.lifecycle), cell: (r) => <LifecycleChip stage={r.lifecycle} /> },
    {
      key: 'tier', header: <span className="inline-flex items-center gap-1">Risk tier <Help text={TIER_HELP} /></span>, sort: (r) => TIER_META[r.riskTier].rank,
      cell: (r) => <TierChip tier={r.riskTier} />,
    },
    { key: 'impact', header: 'Decision impact', hideBelow: 'lg', sort: (r) => ['none', 'informs', 'decides'].indexOf(r.decisionImpact), cell: (r) => <ImpactBadge impact={r.decisionImpact} /> },
    { key: 'agent', header: 'Linked agent', hideBelow: 'md', sort: (r) => r.agent?.slug ?? '~', cell: (r) => (r.agent ? <AgentLink slug={r.agent.slug} /> : <span className="text-xs text-subtle">Not linked</span>) },
    { key: 'review', header: 'Next review', hideBelow: 'sm', sort: (r) => daysUntil(r.nextReview) ?? 99999, cell: (r) => <NextReview iso={r.nextReview} /> },
  ];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="AI inventory"
        description="Every AI system the business uses — agents, models, vendor tools and internal apps — with an owner, a purpose, a lifecycle stage and a risk tier set by an approved assessment."
        actions={
          <>
            <Button variant="secondary" onClick={() => nav('/assessments')}>Assessments</Button>
            {/* approvers do not export model documentation; only owners and admins register systems */}
            {canExportDoc && (
              <Tooltip content={systems.length ? 'Model documentation for an RBI supervisory review, for some or all AI systems' : 'Register an AI system first'}>
                <Button variant="secondary" icon={<FileDown className="h-4 w-4" />} disabled={!systems.length} onClick={() => setDocOpen(true)}>RBI model documentation</Button>
              </Tooltip>
            )}
            {canManage && (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openRegister()}>
                Register an AI system
              </Button>
            )}
          </>
        }
      />

      {!canManage && <p className="-mt-3 mb-5 text-xs text-muted">Owners and admins register and edit AI systems. Your role can read the inventory.</p>}
      {canExportDoc && docOpen && <ModelDocDialog systems={systems} onClose={() => setDocOpen(false)} />}

      {inv.error && <Banner tone="bad" title="The inventory did not load" className="mb-6" actions={<Button size="sm" onClick={inv.refetch}>Try again</Button>}>{inv.error.message}</Banner>}

      {/* Stats */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 mb-6">
        {inv.loading ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[118px]" />) : (
          <>
            <Stat label="AI systems" value={n(stats.total)} sub={`${plural(units.length, 'business unit')}`} />
            <Stat label="Live" value={n(stats.live)} sub="In use today" to="/inventory?lifecycle=live" />
            <Stat label="High risk" value={n(stats.high)} sub="From approved assessments" to={`/inventory?tier=${HIGH_PLUS}`} />
            <Stat label="Unassessed" value={n(stats.unassessed)} sub={stats.unassessed ? 'Need an assessment' : 'All assessed'} to="/inventory?tier=unassessed" />
            <Stat label="Reviews due" value={n(stats.due)} sub={stats.overdue ? `${n(stats.overdue)} overdue · within 60 days` : 'Within 60 days'} to="/inventory?due=60" />
          </>
        )}
      </div>

      {/* Tier mix */}
      {!inv.loading && systems.length > 0 && <TierMix systems={systems} onPick={(t) => setParam('tier', tier === t ? 'all' : t)} active={tier} />}

      {/* Connecting the dots: agents not yet in the inventory */}
      {agents.error && <Banner tone="bad" title="Agents did not load" className="mb-4" actions={<Button size="sm" onClick={agents.refetch}>Try again</Button>}>{agents.error.message}</Banner>}
      {unregistered.length > 0 && (
        <Banner
          tone="info"
          className="mb-4"
          title={`${plural(unregistered.length, 'agent')} governed by Elan1 Govern ${unregistered.length === 1 ? 'is' : 'are'} not in the inventory`}
          actions={canManage && unregistered.length > 1 ? (
            <Button size="sm" variant="secondary" icon={<Bot className="h-3.5 w-3.5" />} onClick={registerAll}>Register all {unregistered.length}</Button>
          ) : undefined}
        >
          <span className="block mb-2">They are governed at runtime but have no owner, purpose or risk tier on record. {canManage ? 'Register each one; the drawer starts with what the agent already says.' : 'Owners and admins register them.'}</span>
          <span className="flex flex-wrap gap-2">
            {unregistered.map((a) => canManage ? (
              <Button key={a.id} size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => registerAgent(a)}>Register {a.slug}</Button>
            ) : <span key={a.id} className="font-mono text-[12.5px] border border-line px-2 py-1">{a.slug}</span>)}
          </span>
          {queue.length > 0 && <span className="block mt-2 text-xs" aria-live="polite">{plural(queue.length, 'more agent')} to register after this one.</span>}
        </Banner>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="w-full sm:w-64"><SearchInput aria-label="Search the inventory" placeholder="Search name, vendor, purpose" value={q} onChange={(e) => setParam('q', e.target.value)} /></div>
        <FilterSelect label="Kind" value={kind} onChange={(v) => setParam('kind', v)} options={Object.entries(KIND_LABEL).map(([v, l]) => ({ v, l }))} />
        <FilterSelect label="Lifecycle" value={stage} onChange={(v) => setParam('lifecycle', v)} options={LIFECYCLE_ORDER.map((v) => ({ v, l: LIFECYCLE_META[v as Lifecycle].label }))} />
        <FilterSelect label="Risk tier" value={tier} onChange={(v) => setParam('tier', v)} options={[...TIER_ORDER.map((v) => ({ v, l: TIER_META[v as RiskTier].label })), { v: HIGH_PLUS, l: 'High or unacceptable' }]} />
        <FilterSelect label="Unit" value={unit} onChange={(v) => setParam('unit', v)} options={units.map((v) => ({ v, l: v }))} />
        {due && <Button size="sm" variant="secondary" iconRight={<X className="h-3.5 w-3.5" />} onClick={() => setParam('due', '')}>Reviews due in 60 days</Button>}
        {filtersOn && <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</Button>}
        <span className="ml-auto text-sm text-muted num" aria-live="polite">{rows.length === systems.length ? plural(systems.length, 'system') : `${n(rows.length)} of ${plural(systems.length, 'system')}`}</span>
      </div>

      <DataTable
        caption="AI systems"
        columns={columns}
        rows={inv.data ? rows : undefined}
        loading={inv.loading}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/inventory/${r.id}`)}
        initialSort={{ key: 'tier', dir: 'desc' }}
        empty={systems.length === 0 ? (
          <EmptyState title="No AI systems registered yet" disc="aperture" action={canManage ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openRegister()}>Register an AI system</Button> : undefined}>
            Register the agents, models and vendor tools the business uses. Each one gets an owner, a purpose and a risk tier from an approved assessment.
          </EmptyState>
        ) : (
          <EmptyState compact title="No systems match these filters" disc="aperture" action={<Button size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</Button>}>
            Try a different kind, stage or risk tier.
          </EmptyState>
        )}
      />

      <div className="mt-6">
        <DiscoveryPanel canManage={canManage} onRegister={registerFinding} />
      </div>

      <div className="mt-6 grid gap-4">
        <div className="flex items-start gap-3 border border-line bg-surface p-4">
          <div className="text-sm">
            <p className="font-medium">How the risk tier is set</p>
            <p className="text-muted mt-1">An author answers an <Link to="/assessments" className="underline underline-offset-2 hover:text-fg">assessment</Link>; the points give a tier. When a different person approves it, the tier is written to the system and the next review is set — 6 months for high risk, 12 months for limited risk, 24 months for minimal risk.</p>
          </div>
        </div>
      </div>

      <RegisterSystemDrawer
        open={drawer.open}
        onClose={() => { setDrawer({ open: false }); }}
        onDone={afterRegistered}
        findingId={drawer.findingId}
        prefill={drawer.prefill}
        agents={agents.data ?? []}
        frameworks={comp.data?.frameworks ?? []}
        people={people}
        units={units}
        linkedAgentIds={linkedAgentIds}
      />
    </div>
  );
}

/** Filter value for the 'High risk' stat: high and unacceptable together, matching its count. */
const HIGH_PLUS = 'high_plus';

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <div className="w-[calc(50%-4px)] sm:w-auto sm:min-w-[150px]">
      <Select size_="sm" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cn(value !== 'all' && 'border-fg font-medium')}>
        <option value="all">{label}: all</option>
        {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </Select>
    </div>
  );
}

/** One horizontal bar of the tier mix. Each segment is labelled and clickable; colour is never the only signal. */
function TierMix({ systems, onPick, active }: { systems: AiSystem[]; onPick: (t: RiskTier) => void; active: string }) {
  const counts = TIER_ORDER.map((t) => ({ t, c: systems.filter((s) => s.riskTier === t).length })).filter((x) => x.c > 0);
  const bg: Record<RiskTier, string> = { unacceptable: 'bg-bad', high: 'bg-bad/75', limited: 'bg-held', minimal: 'bg-ok', unassessed: 'bg-line-strong/60' };
  return (
    <div className="mb-6 border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2.5">
        <p className="label">Risk tier mix</p>
        <p className="text-xs text-muted">Select a tier to filter the register</p>
      </div>
      <div className="flex h-2.5 w-full gap-px bg-line" aria-hidden>
        {counts.map(({ t, c }) => <div key={t} className={cn(bg[t], active !== 'all' && active !== t && 'opacity-35')} style={{ width: `${(c / systems.length) * 100}%` }} />)}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {counts.map(({ t, c }) => (
          <button key={t} type="button" onClick={() => onPick(t)} aria-pressed={active === t} className={cn('inline-flex items-center gap-2 text-sm hover:text-fg', active === t ? 'text-fg font-semibold' : 'text-muted')}>
            <span className={cn('h-2.5 w-2.5', bg[t])} aria-hidden />
            {TIER_META[t].label}
            <span className="num text-fg">{c}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
