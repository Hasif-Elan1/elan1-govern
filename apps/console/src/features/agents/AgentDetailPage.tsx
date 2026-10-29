import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Pause, Play, PencilLine, KeyRound, Plus, OctagonX, ScrollText, Boxes, ShieldAlert, Trash2, ArrowRight, MoreHorizontal, Waypoints, PlugZap, Lock, Archive, RefreshCw, Stamp, ShieldCheck, Users, Hourglass, FileCheck2 } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Agent, Approval, Condition, Receipt, RiskLevel, RiskTier, Rule } from '@/types';
import { userName } from '@/mock/users';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { n, pct, plural, rupees, tagLabel, dateTime, date } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  ApprovalChip, Badge, Banner, Button, DataTable, DecisionChip, EmptyState, Field, Hash, IconButton, KeyValue, Menu, PageHeader, Panel,
  Segmented, Select, Skeleton, Stat, StatusChip, Tabs, Textarea, Timeline, Tooltip, toast, type Column,
} from '@/components/ui';
import { AgentStatus, Person, ReceiptLink, RouteMode, When } from '@/components/domain';
import { AgentModelPanel } from '@/features/inventory/model';
import { DecisionBars, Legend, SERIES } from '@/components/charts';
import { BUSINESS_UNITS, DAY, MixBar, RiskLevelMark, byDay, dayLabel, decisionsSince, emptyMix, addDecision, mixOf, type Mix } from './parts';
import { PauseDialog, IssueKeyDialog, RevokeKeyDialog, RotateKeyDialog, RetireDialog, DeleteAgentDialog } from './AgentDialogs';
import { AgentBehaviour } from './AgentBehaviour';
import { AgentAutonomy, AutonomyChip, highestGrant } from './AgentAutonomy';
import { callCount, receiptCount, evidenceIndex, evidenceOf, isRetired, keyState, sweepKeys, updateAgent, type AgentExt, type EvidenceIndex, type ExtKey } from './backend';
import { packAdmissionsFor } from '@/features/assessments/backend';
import { PlanUpsell, SmartLink, useScreenAccess } from '@/shell/access';

type TabId = 'overview' | 'rulebook' | 'keys' | 'autonomy' | 'behaviour' | 'approvals' | 'settings';
const TAB_IDS: TabId[] = ['overview', 'rulebook', 'keys', 'autonomy', 'behaviour', 'approvals', 'settings'];

const TIER: Record<RiskTier, { label: string; tone: 'ok' | 'held' | 'bad' | 'neutral' }> = {
  minimal: { label: 'Minimal risk', tone: 'ok' },
  limited: { label: 'Limited risk', tone: 'held' },
  high: { label: 'High risk', tone: 'bad' },
  unacceptable: { label: 'Unacceptable', tone: 'bad' },
  unassessed: { label: 'Unassessed', tone: 'neutral' },
};

const OP: Record<Condition['op'], string> = { eq: 'is', lt: '<', lte: '≤', gt: '>', gte: '≥', in: 'is in', to_domain_in: 'domain is in', fields_include: 'includes' };

export function conditionText(c: Condition) {
  const v = Array.isArray(c.value) ? (c.value.length > 3 ? `${c.value.slice(0, 3).join(', ')} +${c.value.length - 3}` : c.value.join(', ')) : typeof c.value === 'number' && /amount/i.test(c.field) ? rupees(c.value) : String(c.value);
  return `${c.field} ${OP[c.op]} ${v}`;
}

/** Seal and timestamp status of a receipt (L2 and above), always an icon and a label. */
export function EvidenceChip({ ix, r }: { ix?: EvidenceIndex; r: Pick<Receipt, 'seq' | 'ts'> }) {
  const s = evidenceOf(ix, r);
  if (!s) return null;
  if (s === 'l1') return <StatusChip size="sm" tone="neutral" icon={<FileCheck2 className="h-3 w-3" aria-hidden />}>L1 · hash chain, no Seal v6</StatusChip>;
  if (s === 'sealed') return <StatusChip size="sm" tone="info" icon={<Hourglass className="h-3 w-3" aria-hidden />}>Sealed · batch pending</StatusChip>;
  return <StatusChip size="sm" tone="ok" icon={<Stamp className="h-3 w-3" aria-hidden />}>Sealed · timestamped</StatusChip>;
}

export default function AgentDetailPage() {
  const { slug = '' } = useParams();
  const nav = useNavigate();
  const orgId = useOrgId();
  const level = useOrgLevel();
  const access = useScreenAccess();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab') as TabId | null;
  const autonomyTab = atLeast(level, 'l3');
  const approvalsTab = access.canSee('/approvals');
  const tabShown = (t: TabId) => (t !== 'autonomy' || autonomyTab) && (t !== 'approvals' || approvalsTab);
  const tab: TabId = rawTab && TAB_IDS.includes(rawTab) && tabShown(rawTab) ? rawTab : 'overview';
  const setTab = (t: TabId) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });

  const q = useQuery(async (o) => { sweepKeys(o); return api.agent(o, slug); }, [slug]);
  const rsQ = useQuery(async (o) => decisionsSince(o, 14, slug), [slug]);
  const incQ = useQuery((o) => api.incidents(o), []);
  const asmQ = useQuery((o) => api.assessments(o), [], { kinds: ['assessment', 'receipt'] });
  const gQ = useQuery((o) => (atLeast(api.levelOf(o), 'l3') ? api.grants(o) : Promise.resolve(undefined)), [level], { kinds: ['autonomy', 'receipt', 'level'] });

  const canPause = useCan('agents.pause');
  const canEditRb = useCan('rulebooks.edit');
  const [pauseOpen, setPauseOpen] = useState(false);

  const data = q.data;
  const agent = data?.agent as AgentExt | undefined;
  const retired = isRetired(agent);
  const autoAlert = data?.alerts.find((a) => a.autoPaused && a.status !== 'resolved') ?? data?.alerts.find((a) => a.autoPaused);
  const incident = incQ.data?.find((i) => i.status === 'active' && i.agentSlugs.includes(slug) && (i.kind === 'auto_pause' || i.kind === 'emergency_stop'));
  const pausedReceipt = data?.receipts.find((r) => r.kind === 'admin' && r.action === 'agent.paused');
  const top = highestGrant(gQ.data?.rows, slug);

  const rs7 = useMemo(() => rsQ.data?.filter((r) => Date.now() - new Date(r.ts).getTime() < 7 * DAY), [rsQ.data]);
  const rsPrev = useMemo(() => rsQ.data?.filter((r) => Date.now() - new Date(r.ts).getTime() >= 7 * DAY), [rsQ.data]);

  if (q.error && !data) {
    const notFound = /No agent called/.test(q.error.message);
    return (
      <div className="min-w-0 overflow-x-clip">
        <PageHeader kicker="Agents" crumbs={[{ label: 'Agents', to: '/agents' }, { label: slug }]} title={notFound ? 'Agent not found' : 'Agent did not load'} />
        {notFound ? (
          <Panel>
            <EmptyState title={`No agent called ${slug}`} disc="registration" action={<Button variant="secondary" onClick={() => nav('/agents')}>Back to agents</Button>}>
              It may belong to another organisation, the slug is mistyped, or it was deleted before it made a call. Agents with calls are retired, never deleted.
            </EmptyState>
          </Panel>
        ) : <Banner tone="bad" title="Could not load this agent" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}
      </div>
    );
  }

  if (!agent || !data) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-5 w-[32rem] max-w-full" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[120px]" />)}</div>
        <Skeleton className="h-[280px]" />
      </div>
    );
  }

  const stopped = agent.status === 'stopped';
  const pending = data.approvals.filter((a) => a.status === 'pending').length;
  const openAlerts = data.alerts.filter((a) => a.status !== 'resolved').length;
  const liveKeys = agent.keys.filter((k) => keyState(k) === 'active' || keyState(k) === 'rotating').length;
  const rbDraft = data.rulebook?.versions.find((v) => v.status !== 'published');

  // roles that cannot pause see no pause or resume control; a role that can is told why a rule blocks it here
  const pauseBtn = !canPause ? null : retired ? (
    <Tooltip content={`Retired ${agent.retiredAt ? date(agent.retiredAt) : ''}. A retired agent cannot be resumed; register a new agent instead.`}>
      <Button variant="secondary" icon={<Play className="h-4 w-4" />} disabled>Resume</Button>
    </Tooltip>
  ) : agent.status === 'active' ? (
    <Tooltip content="Refuse every new call from this agent until resumed">
      <Button variant="quiet-danger" icon={<Pause className="h-4 w-4" />} onClick={() => setPauseOpen(true)}>Pause</Button>
    </Tooltip>
  ) : (
    <Tooltip content={stopped ? 'Stopped by the emergency stop. Lift the stop from its incident; only agents the stop paused resume.' : 'Decide new calls by the rulebook again'}>
      <Button variant="secondary" icon={<Play className="h-4 w-4" />} disabled={stopped} onClick={() => setPauseOpen(true)}>Resume</Button>
    </Tooltip>
  );

  const sideErrors = [rsQ.error && ['Calls over the last 14 days', rsQ], incQ.error && ['Incidents', incQ], asmQ.error && ['Assessments', asmQ], gQ.error && ['Autonomy grants', gQ]].filter(Boolean) as [string, { error?: Error; refetch: () => void }][];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Agents"
        crumbs={[{ label: 'Agents', to: '/agents' }, { label: agent.slug }]}
        title={agent.name}
        description={agent.description}
        meta={
          <>
            <span className="font-mono text-[12.5px] text-muted border border-line h-6 px-1.5 inline-flex items-center">{agent.slug}</span>
            {retired ? <StatusChip tone="neutral" icon={<Archive className="h-3 w-3" aria-hidden />}>Retired</StatusChip> : <AgentStatus agent={agent} />}
            <RouteMode route={agent.route} />
            <span className="text-sm text-muted border border-line h-6 px-1.5 inline-flex items-center">{agent.framework}</span>
            <RiskLevelMark level={agent.riskLevel} className="text-xs border border-line h-6 px-1.5" />
            {top && <button type="button" onClick={() => setTab('autonomy')} className="inline-flex" title={`Highest autonomy in force: ${top.graduated} of ${plural(top.tools, 'write type')} graduated to A3`}><AutonomyChip level={top.level} hasGrant={top.hasGrant} supervised={top.supervised > 0 && top.level === 'A3'} /></button>}
            <span className="inline-flex items-center gap-1.5 text-sm text-muted">Owner <Person id={agent.ownerId} size={20} /></span>
          </>
        }
        actions={
          <>
            {pauseBtn}
            <Button variant="primary" icon={<PencilLine className="h-4 w-4" />} onClick={() => nav(`/rulebooks/${data.rulebook?.slug ?? agent.slug}`)}>{canEditRb && !retired ? 'Edit rulebook' : 'View rulebook'}</Button>
            <Menu
              trigger={({ toggle }) => <IconButton label="More actions" onClick={toggle}><MoreHorizontal className="h-4 w-4" /></IconButton>}
              items={[
                { label: 'All receipts for this agent', icon: <ScrollText className="h-4 w-4" />, onSelect: () => nav(`/activity?agent=${agent.slug}&range=all`) },
                ...(access.canSee('/approvals') ? [{ label: 'All approvals for this agent', icon: <Users className="h-4 w-4" />, onSelect: () => nav(`/approvals?agent=${agent.slug}`) }] : []),
                { label: 'Show on the agent map', icon: <Waypoints className="h-4 w-4" />, onSelect: () => nav(`/agents/map?agent=${agent.slug}`) },
                ...(data.aiSystem ? [{ label: 'Open in AI inventory', icon: <Boxes className="h-4 w-4" />, onSelect: () => nav(`/inventory/${data.aiSystem!.id}`) }] : []),
              ]}
            />
          </>
        }
      />

      {retired && (
        <Banner tone="neutral" className="mb-6" title={`Retired by ${userName(agent.retiredBy)}${agent.retiredAt ? ` on ${date(agent.retiredAt)}` : ''}`}>
          {agent.retireReason ? <>“{agent.retireReason}” · </> : null}{agent.retireSeq ? <>recorded on <ReceiptLink seq={agent.retireSeq} /> · </> : null}Its keys are revoked and every call is refused. Its record and receipts stay on the chain and keep verifying.
        </Banner>
      )}
      {!retired && agent.pausedBy === 'auto-pause' && agent.status !== 'active' && (
        <Banner tone="held" className="mb-6" title="Paused automatically after a high-severity alert"
          actions={canPause ? <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} onClick={() => setPauseOpen(true)}>Review and resume</Button> : undefined}>
          {autoAlert ? <><SmartLink className="underline font-medium" plainClassName="font-medium" to={`/alerts/${autoAlert.id}`}>{autoAlert.title}</SmartLink> — {autoAlert.observed} against a usual {autoAlert.baseline.toLowerCase()}. </> : null}
          Auto-pause was switched on for this agent. Every call is refused with <span className="font-mono">agent-paused</span> and recorded{incident && access.canSee('/incidents') ? <> · <Link className="underline" to={`/incidents/${incident.id}`}>open the incident</Link></> : ''}.
        </Banner>
      )}
      {!retired && agent.pausedBy === 'owner' && agent.status === 'paused' && (
        <Banner tone="held" className="mb-6" title={`Paused by ${pausedReceipt?.actor ? userName(pausedReceipt.actor) : 'its owner'}`}>
          {pausedReceipt?.details?.reason ? <>“{String(pausedReceipt.details.reason)}” · </> : null}
          {pausedReceipt && <>recorded on <ReceiptLink seq={pausedReceipt.seq} /> · </>}Every call is refused with <span className="font-mono">agent-paused</span> until someone resumes it.
        </Banner>
      )}
      {stopped && (
        <Banner tone="bad" className="mb-6" title="Stopped by the emergency stop">
          Every call is refused and recorded. {incident && access.canSee('/incidents') ? <Link className="underline" to={`/incidents/${incident.id}`}>Open the incident</Link> : 'Lift the stop from the incident'} to resume; only agents the stop paused are resumed.
        </Banner>
      )}
      {sideErrors.map(([what, qq]) => (
        <Banner key={what} tone="bad" className="mb-4" title={`${what} did not load`} actions={<Button size="sm" onClick={qq.refetch}>Try again</Button>}>{qq.error?.message}</Banner>
      ))}

      <Tabs<TabId>
        label="Agent sections"
        className="mb-6"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'rulebook', label: 'Rulebook' },
          { value: 'keys', label: 'Keys', count: liveKeys },
          // autonomy is part of L3 and the approvals inbox is a Work screen: each tab shows only where it can open
          ...(autonomyTab ? [{ value: 'autonomy' as const, label: 'Autonomy' }] : []),
          { value: 'behaviour', label: 'Behaviour', count: openAlerts || undefined },
          ...(approvalsTab ? [{ value: 'approvals' as const, label: 'Approvals', count: pending || undefined }] : []),
          { value: 'settings', label: 'Details' },
        ]}
      />

      {tab === 'overview' && <Overview agent={agent} data={data} rs7={rs7} rsPrev={rsPrev} rsError={!!rsQ.error} assessments={asmQ.data} />}
      {tab === 'rulebook' && <RulebookTab data={data} draftVersion={rbDraft?.version} />}
      {tab === 'keys' && <KeysTab agent={agent} />}
      {tab === 'autonomy' && autonomyTab && <AgentAutonomy agent={agent} />}
      {tab === 'behaviour' && <AgentBehaviour agent={agent} rs={rsQ.data} alerts={data.alerts} />}
      {tab === 'approvals' && approvalsTab && <ApprovalsTab slug={agent.slug} />}
      {tab === 'settings' && <SettingsTab agent={agent} receipts={receiptCount(orgId, agent.slug)} grants={top?.graduated ?? 0} />}

      <PauseDialog open={pauseOpen} onClose={() => setPauseOpen(false)} agent={agent} alert={autoAlert} incident={incident} />
    </div>
  );
}

type AgentData = Awaited<ReturnType<typeof api.agent>>;

/* ── Overview ─────────────────────────────────────────────── */

function Overview({ agent, data, rs7, rsPrev, rsError, assessments }: { agent: Agent; data: AgentData; rs7?: Receipt[]; rsPrev?: Receipt[]; rsError: boolean; assessments?: Awaited<ReturnType<typeof api.assessments>> }) {
  const nav = useNavigate();
  const level = useOrgLevel();
  const access = useScreenAccess();
  const ixQ = useQuery((o) => evidenceIndex(o), [level], { kinds: ['receipt', 'level'] });
  const packsQ = useQuery(async (o) => (data.aiSystem ? packAdmissionsFor(o, data.aiSystem.id) : []), [data.aiSystem?.id], { kinds: ['assessment', 'receipt', 'pack'] });
  const m = useMemo(() => (rs7 ? mixOf(rs7) : undefined), [rs7]);
  const prev = useMemo(() => (rsPrev ? mixOf(rsPrev) : undefined), [rsPrev]);
  const days = useMemo(() => (rs7 ? byDay(rs7, 7) : []), [rs7]);
  const tools = useMemo(() => {
    const map = new Map<string, Mix>();
    for (const r of rs7 ?? []) { if (!r.tool) continue; if (!map.has(r.tool)) map.set(r.tool, emptyMix()); addDecision(map.get(r.tool)!, r.decision); }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [rs7]);
  const delta = (cur: number, before?: number) => (before ? ((cur - before) / before) * 100 : undefined);
  const sys = data.aiSystem;
  const sysAssessments = (assessments ?? []).filter((a) => a.aiSystemId === sys?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = sysAssessments[0];
  const openAlerts = data.alerts.filter((a) => a.status !== 'resolved');
  const l2 = atLeast(level, 'l2');

  const recentCols: Column<Receipt>[] = [
    { key: 'seq', header: 'Receipt', cell: (r) => <ReceiptLink seq={r.seq} /> },
    { key: 'what', header: 'Call or action', cell: (r) => r.kind === 'admin' ? <span className="text-sm">{r.action} <span className="text-muted">· {userName(r.actor)}</span></span> : <span className="font-mono text-[12.5px]">{r.tool}</span> },
    { key: 'dec', header: 'Decision', cell: (r) => r.kind === 'admin' ? <StatusChip tone="neutral" size="sm">Admin</StatusChip> : <DecisionChip decision={r.decision} size="sm" /> },
    { key: 'rule', header: 'Rule', hideBelow: 'md', cell: (r) => <span className="font-mono text-[12px] text-muted">{r.rule_id ?? '—'}</span> },
    ...(l2 ? [{ key: 'proof', header: 'Seal and timestamp', hideBelow: 'lg' as const, cell: (r: Receipt) => <Link to={`/activity/${r.seq}`} onClick={(e) => e.stopPropagation()} className="inline-flex" title="Open the receipt and its proof">{ixQ.data ? <EvidenceChip ix={ixQ.data} r={r} /> : <span className="text-xs text-subtle">…</span>}</Link> }] : []),
    { key: 'when', header: 'When', align: 'right', cell: (r) => <When iso={r.ts} className="text-sm text-muted" /> },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4" aria-live="polite">
        {rsError ? (
          <div className="col-span-2 lg:col-span-4 border border-line bg-surface p-5 text-sm text-muted">Call counts are unavailable until the last 14 days of receipts load.</div>
        ) : !m ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[132px]" />) : (
          <>
            <Stat label="Calls · 7 days" value={n(m.total)} delta={delta(m.total, prev?.total)} deltaGood="up" sub={prev ? `${n(prev.total)} the week before` : undefined} />
            <Stat label="Allowed" value={n(m.allow)} sub={m.total ? `${pct(m.allow / m.total, 1)} of calls` : 'No calls'} icon={<span className="h-2.5 w-2.5 bg-ok" aria-hidden />} />
            <Stat label="Asked a person" value={n(m.ask)} sub={m.total ? `${pct(m.ask / m.total, 1)} of calls` : 'No calls'} icon={<span className="h-2.5 w-2.5 bg-held" aria-hidden />} to={access.canSee('/approvals') ? `/approvals?agent=${agent.slug}` : undefined} />
            <Stat label="Refused" value={n(m.refuse)} delta={delta(m.refuse, prev?.refuse)} deltaGood="down" sub={m.total ? `${pct(m.refuse / m.total, 1)} of calls` : 'No calls'} icon={<span className="h-2.5 w-2.5 bg-bad" aria-hidden />} to={`/activity?agent=${agent.slug}&d=refuse&range=7d`} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-8" title="Decisions by day" actions={<span className="text-xs text-muted">IST · 7 days</span>}>
          <div className="mb-3"><Legend items={[{ label: 'Allowed', color: SERIES.allow }, { label: 'Asked a person', color: SERIES.ask }, { label: 'Refused', color: SERIES.refuse }]} /></div>
          {rsError ? <p className="text-sm text-muted">The chart is unavailable until the receipts load.</p> : !rs7 ? <Skeleton className="h-[220px]" /> : m?.total ? <DecisionBars data={days} xKey="day" xFmt={dayLabel} height={220} /> : <EmptyState compact title="No calls in 7 days" disc="trail">When this agent calls a tool, each decision is drawn here by day (IST).</EmptyState>}
        </Panel>
        <Panel className="lg:col-span-4" title="Top tools" flush>
          {tools.length === 0 ? <p className="p-5 text-sm text-muted">No tool calls in 7 days.</p> : (
            <ul className="divide-y divide-line">
              {tools.slice(0, 7).map(([t, mx]) => (
                <li key={t} className="px-5 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link to={`/activity?agent=${agent.slug}&tool=${encodeURIComponent(t)}&range=7d`} className="font-mono text-[12.5px] truncate hover:underline">{t}</Link>
                    <span className="num text-sm">{n(mx.total)}</span>
                  </div>
                  <MixBar mix={mx} className="mt-1.5" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-8 space-y-3">
          <div className="flex items-end justify-between">
            <h2 className="text-lg font-semibold">Recent receipts</h2>
            <Link to={`/activity?agent=${agent.slug}&range=all`} className="text-sm text-muted hover:text-fg inline-flex items-center gap-1">All activity <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          {l2 && ixQ.error && <Banner tone="bad" title="Seal and timestamp status did not load" actions={<Button size="sm" onClick={ixQ.refetch}>Try again</Button>}>{ixQ.error.message}</Banner>}
          <DataTable caption="Recent receipts for this agent" columns={recentCols} rows={data.receipts.slice(0, 10)} rowKey={(r) => r.seq} onRowClick={(r) => nav(`/activity/${r.seq}`)}
            empty={<EmptyState compact title="No receipts yet" disc="trail">Every call and every admin change for this agent writes a receipt to the hash chain.</EmptyState>} />
          {l2 && ixQ.data && <p className="text-xs text-muted">From {LEVEL_INFO.l2.label} each record is sealed (Seal v6) and its 15-minute batch is timestamped by {ixQ.data.authorities.join(' and ') || 'two authorities'}. Records from before the boundary stay L1: sealed in a hash chain, with no Seal v6 record and no timestamp.</p>}
        </div>

        <div className="lg:col-span-4 space-y-6">
          <Panel title="Open alerts" actions={<SmartLink to="/alerts" hideWhenBlocked className="text-sm text-muted hover:text-fg">All alerts</SmartLink>} flush>
            {openAlerts.length === 0 ? <p className="p-5 text-sm text-muted">No open alerts. Its calls look like its baseline.</p> : (
              <ul className="divide-y divide-line">
                {openAlerts.map((a) => (
                  <li key={a.id}>
                    <SmartLink to={`/alerts/${a.id}`} className="block px-5 py-3 hover:bg-sunken/60" plainClassName="block px-5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <StatusChip size="sm" tone={a.severity === 'high' ? 'bad' : a.severity === 'medium' ? 'held' : 'info'} icon={<ShieldAlert className="h-3 w-3" />}>{a.severity === 'high' ? 'High' : a.severity === 'medium' ? 'Medium' : 'Low'}</StatusChip>
                        <When iso={a.createdAt} className="text-xs text-muted" />
                      </div>
                      <p className="mt-1.5 text-sm font-medium">{a.title}</p>
                      {a.autoPaused && <p className="text-xs text-held-fg mt-0.5">Paused this agent</p>}
                    </SmartLink>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <AgentModelPanel agent={agent} />

          <Panel title="AI system" kicker="Inventory">
            {sys ? (
              <div className="space-y-3">
                <Link to={`/inventory/${sys.id}`} className="font-medium hover:underline">{sys.name}</Link>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip size="sm" tone={TIER[sys.riskTier].tone}>{TIER[sys.riskTier].label}</StatusChip>
                  <Badge>{sys.lifecycle.replace('_', ' ')}</Badge>
                </div>
                <KeyValue items={[
                  { k: 'Latest assessment', v: latest ? <Link to={`/assessments/${latest.id}`} className="hover:underline">{latest.template.replace('_', ' ')} · {latest.status.replace('_', ' ')}</Link> : <Link to="/assessments" className="text-muted hover:underline">None yet</Link> },
                  { k: 'Next review', v: sys.nextReview ? date(sys.nextReview) : '—' },
                  { k: 'Decision impact', v: sys.decisionImpact },
                ]} />
                <p className="text-xs text-muted">Risk tier comes only from an approved assessment.</p>
              </div>
            ) : (
              <div className="text-sm text-muted space-y-2">
                <p>This agent is not linked to an AI system.</p>
                <Link to="/inventory" className="text-fg underline">Open the AI inventory</Link>
              </div>
            )}
          </Panel>

          {sys && (
            <Panel title="Regulatory packs" kicker={atLeast(level, 'l2') ? 'Admission per agent' : 'Dry run at L1'} flush
              footer={atLeast(level, 'l2')
                ? "A pack's checks run for an agent only after its admission assessment (G-A to G-E) is approved by a different person."
                : `A pack's checks run for an agent only after its admission assessment (G-A to G-E) is approved by a different person. At L1 they never refuse or hold a call: each receipt records what would have happened.`}>
              {packsQ.error ? <p className="p-5 text-sm text-bad-fg">{packsQ.error.message}</p> : !packsQ.data ? <div className="p-5"><Skeleton className="h-16" /></div> : (
                <ul className="divide-y divide-line">
                  {packsQ.data.map((p) => (
                    <li key={p.packId} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                      <SmartLink to={`/records/packs/${p.packId}`} className="font-mono hover:underline" plainClassName="font-mono">{p.packId}</SmartLink>
                      {p.assessmentId ? (
                        <Link to={`/assessments/${p.assessmentId}`} className="inline-flex">
                          <StatusChip size="sm" tone={p.status === 'admitted' ? 'ok' : p.status === 'refused' ? 'bad' : 'held'} icon={p.status === 'admitted' ? <ShieldCheck className="h-3 w-3" /> : <Hourglass className="h-3 w-3" />}>{p.label}</StatusChip>
                        </Link>
                      ) : access.can('assessments.author') ? <Link to={`/assessments?start=pack_${p.packId}&system=${sys.id}`} className="text-xs text-muted underline underline-offset-2">Start admission</Link> : <span className="text-xs text-muted">Not admitted</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          <Panel title="Connectors" flush>
            {data.connectors.length === 0 ? <p className="p-5 text-sm text-muted">No connectors.</p> : (
              <ul className="divide-y divide-line">
                {data.connectors.map((c) => {
                  const used = c.tools.filter((t) => agent.tools.includes(t.name));
                  return (
                    <li key={c.id}>
                      <SmartLink to={`/connectors/${c.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-sunken/60" plainClassName="flex items-center justify-between gap-3 px-5 py-3">
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 text-sm font-medium truncate"><PlugZap className="h-3.5 w-3.5 text-muted shrink-0" />{c.name}</span>
                          <span className="block text-xs text-muted">{plural(used.length, 'tool')} used · {c.mode === 'demo' ? 'demo mode' : 'live'}</span>
                        </span>
                        {c.heldCredential && <Lock className="h-3.5 w-3.5 text-muted shrink-0" aria-label="Credential held by Elan1 Govern" />}
                      </SmartLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ── Rulebook ─────────────────────────────────────────────── */

function RulebookTab({ data, draftVersion }: { data: AgentData; draftVersion?: number }) {
  const nav = useNavigate();
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const canEdit = useCan('rulebooks.edit');
  const dual = atLeast(level, 'l2');
  const rb = data.rulebook;
  const custodyQ = useQuery((o) => api.custody(o), [level], { kinds: ['key', 'level'] });
  const reviewsQ = useQuery((o) => api.reviews(o), [], { kinds: ['rulebook', 'receipt'] });
  const published = rb?.versions.filter((x) => x.status === 'published') ?? [];
  const v = rb ? published.find((x) => x.version === rb.currentVersion) ?? published[published.length - 1] : undefined;
  const pubReceipt = useMemo(() => {
    if (!v || !rb) return undefined;
    const rs = api.chainSlice(orgId).receipts;
    for (let i = rs.length - 1; i >= 0; i--) { const r = rs[i]; if (r.action === 'rulebook.published' && r.agent === rb.slug && Number(r.details?.version) === v.version) return r; }
    return undefined;
  }, [orgId, rb, v]);
  const proofQ = useQuery(async (o) => {
    if (!pubReceipt || !atLeast(api.levelOf(o), 'l2')) return undefined;
    try { return await api.inclusionProof(o, pubReceipt.seq); } catch (e) { return { error: (e as Error).message }; }
  }, [pubReceipt?.seq, level], { kinds: ['receipt', 'level'] });
  const request = useMutation((note: string) => api.requestReview(orgId, rb!.id, user!.id, note));

  if (!rb) return <Panel><EmptyState title="No rulebook" disc="gate">Without a rulebook every call is refused with no-rulebook.</EmptyState></Panel>;
  const draft = rb.versions.find((x) => x.status !== 'published');
  const reviews = (reviewsQ.data ?? []).filter((x) => x.rulebookId === rb.id);
  const draftReview = draft ? reviews.find((x) => x.version === draft.version && (x.status === 'pending' || x.status === 'approved')) : undefined;
  const ruleCols: Column<Rule>[] = [
    { key: 'id', header: 'Rule', cell: (r) => <div className="py-2"><p className="font-mono text-[12.5px] font-medium">{r.id}</p><p className="text-xs text-muted max-w-[52ch]">{r.reason}</p></div> },
    { key: 'match', header: 'Matches', cell: (r) => r.match.tool ? <span className="font-mono text-[12px]">{r.match.tool}</span> : <span className="text-sm">Any tool tagged <Badge tone={['moves_money', 'deletes', 'changes_access', 'changes_production'].includes(r.match.tag!) ? 'accent' : 'neutral'}>{tagLabel[r.match.tag!]}</Badge></span> },
    { key: 'when', header: 'When', hideBelow: 'md', cell: (r) => r.when?.length || r.unless?.length ? (
      <div className="text-xs text-muted space-y-0.5 py-1">
        {r.when?.map((c, i) => <p key={i}>{conditionText(c)}</p>)}
        {r.unless?.map((c, i) => <p key={`u${i}`}>unless {conditionText(c)}</p>)}
        {r.quota && <p>limit {r.quota.kind === 'max_sum' ? rupees(r.quota.limit) : n(r.quota.limit)} per {r.quota.window}</p>}
      </div>
    ) : <span className="text-xs text-subtle">Always</span> },
    { key: 'decide', header: 'Decides', cell: (r) => <DecisionChip decision={r.decide} size="sm" short /> },
    { key: 'approver', header: 'Approver', hideBelow: 'lg', cell: (r) => r.approver ? <span className="text-sm">{rb.approverGroups.find((g) => g.id === r.approver)?.name ?? r.approver}{r.expiresIn ? <span className="text-muted"> · {r.expiresIn}</span> : ''}</span> : <span className="text-subtle">—</span> },
  ];
  const proof = proofQ.data && !('error' in proofQ.data) ? proofQ.data : undefined;
  const proofErr = proofQ.data && 'error' in proofQ.data ? proofQ.data.error : undefined;

  const askReview = async () => {
    if (!user || !draft) return;
    try {
      await request.mutate(`Review of ${rb.slug} v${draft.version} requested from the agent page.`);
      toast.ok('Review requested', 'A different person reviews it in Work › Reviews before anyone publishes it.');
    } catch (e) { toast.bad('No review was requested', (e as Error).message); }
  };

  return (
    <div className="space-y-6">
      {draftVersion && (
        <Banner tone="info" title={`Version ${draftVersion} is ${draft?.status === 'in_review' ? 'in review' : 'a draft'}`} actions={<Button size="sm" variant="secondary" onClick={() => nav(`/rulebooks/${rb.slug}`)}>Open the draft</Button>}>
          {v ? <>Calls are still decided by the published version {v.version} until the draft is published.</> : <>No version is published yet, so every call is refused (no-rulebook) until a version is published.</>}
          {dual && <> At {LEVEL_INFO[level].label} a different person must approve its review before it can be published.</>}
        </Banner>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-8" title={v ? `Version ${v.version} · published` : 'No published version'} actions={<Button size="sm" variant="secondary" icon={<PencilLine className="h-3.5 w-3.5" />} onClick={() => nav(`/rulebooks/${rb.slug}`)}>{canEdit ? 'Open in editor' : 'Open the rulebook'}</Button>} flush>
          {v ? <DataTable caption="Rules in the current version" columns={ruleCols} rows={v.rules} rowKey={(r) => r.id} className="!border-0" /> : <p className="p-5 text-sm text-muted">Every call is refused until a version is published.</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-line bg-sunken/50">
            <p className="text-sm"><span className="font-medium">default</span> — Anything no rule allows is refused.</p>
            <DecisionChip decision="refuse" size="sm" short />
          </div>
        </Panel>
        <div className="lg:col-span-4 space-y-6">
          <Panel title="Signature">
            {v ? (
              <>
                <KeyValue items={[
                  { k: 'Hash', v: <Hash value={v.hash} /> },
                  { k: 'Signed by', v: <Person id={v.signedBy} size={20} /> },
                  { k: 'Signed', v: v.signedAt ? dateTime(v.signedAt) : '—' },
                  { k: 'Reviewed by', v: v.reviewedBy ? <Person id={v.reviewedBy} size={20} /> : <span className="text-muted">{dual ? 'Published before dual control applied' : 'Not reviewed — recorded at L1, not enforced'}</span> },
                  { k: 'Rules', v: n(v.rules.length) },
                  ...(pubReceipt ? [{ k: 'Publish receipt', v: <ReceiptLink seq={pubReceipt.seq} /> }] : []),
                ]} />
                <p className="mt-3 text-sm text-muted">“{v.note}”</p>
              </>
            ) : <p className="text-sm text-muted">Nothing is published yet.</p>}
          </Panel>

          <Panel title="Dual control" kicker={dual ? 'Enforced' : 'Recorded'}>
            <div className="space-y-3 text-sm">
              {dual ? (
                <p className="flex items-start gap-2"><ShieldCheck className="h-4 w-4 text-ok-fg mt-0.5 shrink-0" aria-hidden /><span><span className="font-medium">Dual control required.</span> A version is published only after a different person approves its review; one person alone cannot publish.</span></p>
              ) : (
                <>
                  <p className="text-muted">At {LEVEL_INFO.l1.label} the reviewer is recorded on the publish receipt when there is one, but one person may publish.</p>
                  <PlanUpsell to="l2" what="A second person to publish starts at L2 Attested." />
                </>
              )}
              {draft ? (
                draftReview ? (
                  <p>v{draft.version}: review {draftReview.status === 'pending' ? <>asked by {userName(draftReview.requestedBy)}, waiting for a reviewer</> : <>approved by {userName(draftReview.reviewerId)}{draftReview.decidedAt ? ` on ${date(draftReview.decidedAt)}` : ''} — ready for a different person to publish</>}. <SmartLink to="/work/reviews" hideWhenBlocked className="underline underline-offset-2">Reviews</SmartLink></p>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-muted">v{draft.version} has no review yet.</span>
                    {canEdit && (
                      <Tooltip content="Ask a different person to review this draft">
                        <Button size="sm" variant="secondary" loading={request.pending} onClick={askReview}>Request review</Button>
                      </Tooltip>
                    )}
                  </div>
                )
              ) : <p className="text-muted">No draft is waiting.</p>}
            </div>
          </Panel>

          <Panel title="Signing key and timestamps">
            {custodyQ.error ? <p className="text-sm text-bad-fg">{custodyQ.error.message}</p> : !custodyQ.data ? <Skeleton className="h-24" /> : (
              <div className="space-y-3">
                <KeyValue items={[
                  { k: 'Custody', v: custodyQ.data.provider },
                  { k: 'Held by', v: custodyQ.data.heldBy === 'customer' ? 'You' : 'elan1' },
                  { k: 'Residency', v: custodyQ.data.residencyDomain },
                  { k: 'Key', v: <span className="font-mono text-[12px]">{custodyQ.data.kid}</span> },
                ]} />
                {dual ? (
                  proof ? (
                    <ul className="border-t border-line pt-3 space-y-1.5 text-xs">
                      {proof.tokens.map((t) => <li key={t.serial} className="flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1.5"><Stamp className="h-3 w-3" aria-hidden />{t.tsaName}</span><span className="text-muted">{dateTime(t.genTime)}</span></li>)}
                      <li className="text-muted">Merkle batch {proof.batchId} · inclusion proof {proof.verified ? 'checks' : 'does not check'}</li>
                    </ul>
                  ) : <p className="text-xs text-muted border-t border-line pt-3">{proofQ.loading ? 'Checking timestamps…' : pubReceipt ? (proofErr ?? 'The publish receipt is in the current batch; timestamps arrive within 15 minutes.') : 'The publish receipt is outside the records this console holds.'}</p>
                ) : (
                  <div className="border-t border-line pt-3 space-y-2">
                    <p className="text-xs text-muted">Sealed in a hash chain by Elan1 Govern and not externally timestamped.</p>
                    <PlanUpsell to="l2" what="Timestamps from two authorities start at L2 Attested." />
                  </div>
                )}
                <SmartLink to="/agents/keys" hideWhenBlocked className="text-xs underline underline-offset-2 text-muted hover:text-fg">Keys and custody</SmartLink>
              </div>
            )}
          </Panel>

          <Panel title="Versions">
            <Timeline items={rb.versions.slice().reverse().map((x) => ({
              title: <span>v{x.version} <span className="text-muted font-normal">· {x.status === 'published' ? (x.version === rb.currentVersion ? 'current' : 'published') : x.status === 'in_review' ? 'in review' : 'draft'}</span></span>,
              time: x.signedAt ? date(x.signedAt) : date(x.createdAt),
              body: x.note,
              tone: x.version === rb.currentVersion && x.status === 'published' ? 'ok' : x.status === 'published' ? 'neutral' : 'info',
            }))} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ── Keys ─────────────────────────────────────────────────── */

function KeysTab({ agent }: { agent: AgentExt }) {
  const canKeys = useCan('agents.keys');
  const access = useScreenAccess();
  const retired = isRetired(agent);
  const [issueOpen, setIssueOpen] = useState(false);
  const [revoke, setRevoke] = useState<ExtKey>();
  const [rotate, setRotate] = useState<ExtKey>();
  const why = retired ? 'This agent is retired; its keys are revoked.' : undefined;
  const cols: Column<ExtKey>[] = [
    { key: 'label', header: 'Label', sort: (k) => k.label, cell: (k) => <div className="py-1.5"><p className={cn('font-medium', k.revoked && 'text-muted line-through')}>{k.label}</p><p className="font-mono text-[12px] text-muted">{k.prefix}…</p></div> },
    { key: 'env', header: 'Environment', sort: (k) => k.environment, cell: (k) => k.environment === 'production' ? <Badge tone="inverse">Production</Badge> : <Badge>Sandbox</Badge> },
    {
      key: 'status', header: 'Status', sort: (k) => keyState(k),
      cell: (k) => {
        const s = keyState(k);
        if (s === 'revoked') return <StatusChip size="sm" tone="bad" icon={<OctagonX className="h-3 w-3" />}>Revoked</StatusChip>;
        if (s === 'expired') return <StatusChip size="sm" tone="held" icon={<Hourglass className="h-3 w-3" />}>Expired</StatusChip>;
        if (s === 'rotating') return <span className="inline-flex flex-col gap-0.5"><StatusChip size="sm" tone="held" icon={<RefreshCw className="h-3 w-3" />}>Rotating</StatusChip><span className="text-[11px] text-muted">revoked {dateTime(k.revokeAt!)}</span></span>;
        return <StatusChip size="sm" tone="ok" icon={<KeyRound className="h-3 w-3" />}>Active</StatusChip>;
      },
    },
    { key: 'expires', header: 'Expires', sort: (k) => k.expiresAt ?? '9', hideBelow: 'md', cell: (k) => <span className={cn('text-sm', k.expiresAt && new Date(k.expiresAt).getTime() - Date.now() < 14 * DAY && !k.revoked ? 'text-held-fg' : 'text-muted')}>{k.expiresAt ? date(k.expiresAt) : 'Never'}</span> },
    { key: 'created', header: 'Created', sort: (k) => k.createdAt, hideBelow: 'lg', cell: (k) => <span className="text-sm text-muted">{date(k.createdAt)}</span> },
    { key: 'used', header: 'Last used', sort: (k) => k.lastUsedAt ?? '', hideBelow: 'sm', cell: (k) => k.lastUsedAt ? <When iso={k.lastUsedAt} className={cn('text-sm', Date.now() - new Date(k.lastUsedAt).getTime() > 30 * DAY ? 'text-held-fg' : 'text-muted')} /> : <span className="text-sm text-subtle">Never</span> },
    // roles that cannot issue or revoke keys read the list without an actions column
    ...(!canKeys ? [] : [{
      key: 'act', header: <span className="sr-only">Actions</span>, align: 'right' as const,
      cell: (k: ExtKey) => k.revoked ? null : (
        <div className="flex justify-end gap-2">
          {!k.revokeAt && (
            <Tooltip content={k.environment === 'production' ? 'Replace this production key once the production review approves it; revoke this key after a grace period' : 'Issue a replacement now; revoke this key after a grace period'}>
              <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRotate(k)}>Rotate</Button>
            </Tooltip>
          )}
          <Tooltip content="Stop this key working on the next call">
            <Button size="sm" variant="quiet-danger" onClick={() => setRevoke(k)}>Revoke</Button>
          </Tooltip>
        </div>
      ),
    }]),
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted max-w-[72ch]">Keys start with <span className="font-mono">sk_sbx_</span> (sandbox) or <span className="font-mono">gk_</span> (production). Each is shown once; Elan1 Govern stores only a hash and the prefix. A production key is issued, and replaced, only through the production review. Issuing, rotating and revoking are each recorded on the chain. {access.canSee('/agents/keys') && <> The organisation's signing key is under <Link to="/agents/keys" className="underline underline-offset-2">Agents › Keys</Link>.</>}</p>
        {canKeys && (
          <Tooltip content={why ?? 'Create a new key for this agent'}>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={retired} onClick={() => setIssueOpen(true)}>Issue key</Button>
          </Tooltip>
        )}
      </div>
      <DataTable caption="Agent keys" columns={cols} rows={agent.keys} rowKey={(k) => k.id}
        empty={<EmptyState compact title="No keys" disc="gate" action={canKeys && !retired ? <Button size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setIssueOpen(true)}>Issue the first key</Button> : undefined}>Without a key the agent cannot connect.</EmptyState>} />
      <IssueKeyDialog open={issueOpen} onClose={() => setIssueOpen(false)} agent={agent} />
      <RotateKeyDialog keyItem={rotate} onClose={() => setRotate(undefined)} agent={agent} />
      <RevokeKeyDialog keyItem={revoke} onClose={() => setRevoke(undefined)} agent={agent} />
    </div>
  );
}

/* ── Approvals ────────────────────────────────────────────── */

const PAGE = 25;

function ApprovalsTab({ slug }: { slug: string }) {
  const nav = useNavigate();
  const q = useQuery((o) => api.approvals(o), [], { kinds: ['approval', 'receipt'] });
  const [f, setF] = useState<'all' | 'pending' | 'decided'>('all');
  const [page, setPage] = useState(0);
  const approvals = useMemo(() => (q.data ?? []).filter((a) => a.agentSlug === slug), [q.data, slug]);
  const rows = approvals.filter((a) => f === 'all' || (f === 'pending' ? a.status === 'pending' : a.status !== 'pending'));
  useEffect(() => setPage(0), [f]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const cols: Column<Approval>[] = [
    { key: 'head', header: 'Held action', cell: (a) => <div className="py-2 min-w-0"><p className="font-medium">{a.headline}</p><p className="text-xs text-muted font-mono">{a.tool} · rule {a.ruleId}</p></div> },
    { key: 'status', header: 'Status', cell: (a) => <ApprovalChip status={a.status} size="sm" /> },
    { key: 'group', header: 'Approver', hideBelow: 'md', cell: (a) => a.decidedBy ? <Person id={a.decidedBy} size={20} /> : <span className="text-sm text-muted">{a.approverGroup}</span> },
    { key: 'created', header: 'Held', align: 'right', hideBelow: 'sm', cell: (a) => <When iso={a.createdAt} className="text-sm text-muted" /> },
    { key: 'seq', header: 'Receipt', align: 'right', hideBelow: 'lg', cell: (a) => <ReceiptLink seq={a.seq} /> },
  ];
  return (
    <div className="space-y-4">
      {q.error && <Banner tone="bad" title="Approvals did not load" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Filter approvals" size="sm" value={f} onChange={setF} options={[
          { value: 'all', label: 'All', count: approvals.length },
          { value: 'pending', label: 'Waiting', count: approvals.filter((a) => a.status === 'pending').length },
          { value: 'decided', label: 'Decided', count: approvals.filter((a) => a.status !== 'pending').length },
        ]} />
        <Link to={`/approvals?agent=${slug}`} className="text-sm text-muted hover:text-fg inline-flex items-center gap-1">All approvals for this agent in the inbox <ArrowRight className="h-3.5 w-3.5" /></Link>
      </div>
      <DataTable caption={`Approvals for ${slug}`} columns={cols} rows={q.data ? shown : undefined} loading={q.loading} rowKey={(a) => a.id} onRowClick={(a) => nav(`/approvals/${a.id}`)}
        empty={<EmptyState compact title="No approvals" disc="aperture">When a rule asks a person, the held action appears here and in the approvals inbox.</EmptyState>} />
      {rows.length > PAGE && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted num">{page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {n(rows.length)}, newest first</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Newer</Button>
            <Button size="sm" variant="secondary" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Older</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Details ──────────────────────────────────────────────── */

function SettingsTab({ agent, receipts, grants }: { agent: AgentExt; receipts: number; grants: number }) {
  const orgId = useOrgId();
  const user = useUser();
  const canManage = useCan('agents.manage');
  const retired = isRetired(agent);
  const editable = canManage && !retired;
  const membersQ = useQuery((o) => api.members(o), [], { live: false });
  const callsQ = useQuery(async (o) => callCount(o, agent.slug), [agent.slug]);
  const [desc, setDesc] = useState(agent.description);
  const [owner, setOwner] = useState(agent.ownerId);
  const [risk, setRisk] = useState<RiskLevel>(agent.riskLevel);
  const [unit, setUnit] = useState(agent.businessUnit ?? '');
  const [retireOpen, setRetireOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const save = useMutation((patch: Parameters<typeof updateAgent>[2]) => updateAgent(orgId, agent.slug, patch, user!.id));
  useEffect(() => { setDesc(agent.description); setOwner(agent.ownerId); setRisk(agent.riskLevel); setUnit(agent.businessUnit ?? ''); }, [agent.description, agent.ownerId, agent.riskLevel, agent.businessUnit]);

  const changed = [desc.trim() !== agent.description && 'description', owner !== agent.ownerId && 'owner', risk !== agent.riskLevel && 'risk level', unit.trim() !== (agent.businessUnit ?? '') && 'business unit'].filter(Boolean) as string[];

  const onSave = async () => {
    if (!user || !changed.length) return;
    try {
      const r = await save.mutate({ description: desc, ownerId: owner, riskLevel: risk, businessUnit: unit.trim() });
      toast.ok('Agent updated', `Changed ${changed.join(', ')}.${r.receipt ? ` Receipt #${r.receipt.seq}.` : ''}`);
    } catch { /* shown below */ }
  };

  const owners = (membersQ.data ?? []).filter((m) => m.status === 'active' && m.user && m.role !== 'auditor');
  const calls = callsQ.data;
  const readOnlyNote = retired ? 'This agent is retired. Its details are kept as they were.' : !canManage ? 'Owners and admins edit agents. Your role can read these settings.' : undefined;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <Panel className={canManage ? 'lg:col-span-8' : 'lg:col-span-12'} title="Details" footer={readOnlyNote}>
        <div className="space-y-5">
          {save.error && <Banner tone="bad" title="Nothing was saved">{save.error.message}</Banner>}
          {membersQ.error && <Banner tone="bad" title="Members did not load" actions={<Button size="sm" onClick={membersQ.refetch}>Try again</Button>}>{membersQ.error.message}</Banner>}
          {editable ? (
            <>
              <Field label="What it does" htmlFor="set-desc" hint="Shown in the registry and used as the purpose in the AI inventory.">
                <Textarea id="set-desc" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Owner" htmlFor="set-owner" hint="The accountable person. An owner who approves their own agent's action is flagged on the receipt.">
                  <Select id="set-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                    {!owners.some((m) => m.userId === owner) && <option value={owner}>{userName(owner)}</option>}
                    {owners.map((m) => <option key={m.userId} value={m.userId}>{m.user!.name} · {m.user!.title}</option>)}
                  </Select>
                </Field>
                <Field label="Business unit" htmlFor="set-unit" hint="Also shown on its AI inventory entry.">
                  <Select id="set-unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                    {!BUSINESS_UNITS.includes(unit) && <option value={unit}>{unit || 'Not set'}</option>}
                    {BUSINESS_UNITS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </Select>
                </Field>
              </div>
            </>
          ) : (
            // Read-only roles (and retired agents) get the details as plain text, not disabled form controls.
            <>
              <Field label="What it does">
                <p className="text-sm whitespace-pre-line">{agent.description || <span className="text-muted">Not described</span>}</p>
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Owner"><p className="text-sm">{userName(agent.ownerId)}</p></Field>
                <Field label="Business unit"><p className="text-sm">{agent.businessUnit || <span className="text-muted">Not set</span>}</p></Field>
              </div>
            </>
          )}
          <Field label="Risk level" hint={editable ? 'High-risk agents need a person or a refusal on every high-impact tool.' : 'Owners and admins change the risk level.'}>
            {editable ? (
              <Segmented label="Risk level" value={risk} onChange={setRisk} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
            ) : <span className="inline-flex items-center gap-2 h-10 px-3 border border-line bg-sunken/50" aria-readonly><RiskLevelMark level={agent.riskLevel} /><span className="text-xs text-muted">read-only</span></span>}
          </Field>
          <KeyValue cols={2} items={[
            { k: 'Slug', v: agent.slug, mono: true },
            { k: 'Agent id', v: agent.id, mono: true },
            { k: 'Route', v: <RouteMode route={agent.route} compact /> },
            { k: 'Created', v: date(agent.createdAt) },
            ...(agent.declaration ? [
              { k: 'Declaration', v: <span className="font-mono text-[12px]">{agent.declaration.id} v{agent.declaration.version}</span> },
              { k: 'Actor kind', v: agent.declaration.actorKind.replace(/_/g, ' ') },
              { k: 'Lexicon hash', v: <Hash value={agent.declaration.lexiconHash} /> },
              { k: 'Declared', v: agent.declaration.seq ? <ReceiptLink seq={agent.declaration.seq} /> : date(agent.declaration.recordedAt) },
            ] : []),
          ]} />
        </div>
        {editable && (
          <div className="mt-6 pt-5 border-t border-line flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={!changed.length || save.pending} onClick={() => { setDesc(agent.description); setOwner(agent.ownerId); setRisk(agent.riskLevel); setUnit(agent.businessUnit ?? ''); }}>Discard</Button>
            <Button variant="primary" disabled={!changed.length} loading={save.pending} onClick={onSave}>Save changes</Button>
          </div>
        )}
      </Panel>

      {/* retire and delete are left out for roles that cannot manage agents */}
      {canManage && <div className="lg:col-span-4 space-y-6">
        <section className="border border-bad/40 bg-surface">
          <div className="px-5 py-3.5 border-b border-bad/30"><h2 className="text-lg font-semibold text-bad-fg">Retire or delete</h2></div>
          <div className="p-5 space-y-5">
            <div className="space-y-2">
              <p className="text-sm font-medium">Retire agent</p>
              <p className="text-sm text-muted">Revokes its keys{grants ? ' and its graduations to A3' : ''}, refuses every call and records it. {agent.slug} keeps its {plural(receipts, 'receipt')} on the chain, all verifiable.</p>
              <Tooltip content={retired ? 'Already retired.' : 'Stop this agent for good, on the record'}>
                <Button variant="quiet-danger" icon={<Archive className="h-4 w-4" />} disabled={retired} onClick={() => setRetireOpen(true)}>Retire agent</Button>
              </Tooltip>
            </div>
            <div className="space-y-2 pt-4 border-t border-line">
              <p className="text-sm font-medium">Delete agent</p>
              <p className="text-sm text-muted">{calls === undefined ? 'Counting its calls…' : calls === 0 ? 'It has made no calls, so it can be deleted. Its creation and deletion stay on the chain.' : `It has made ${plural(calls, 'call')}. An agent with calls is retired, never deleted, so its record stays verifiable.`}</p>
              <Tooltip content={calls === undefined ? 'Counting its calls' : calls > 0 ? `Has ${plural(calls, 'decision receipt')} on the chain — retire it instead` : 'Delete this agent and its keys'}>
                <Button variant="quiet-danger" icon={<Trash2 className="h-4 w-4" />} disabled={calls === undefined || calls > 0} onClick={() => setDeleteOpen(true)}>Delete agent</Button>
              </Tooltip>
            </div>
            <p className="text-xs text-muted inline-flex items-start gap-1.5"><OctagonX className="h-3.5 w-3.5 mt-0.5 shrink-0" />To stop it for now, pause it, or revoke its keys on the Keys tab.</p>
          </div>
        </section>
      </div>}
      <RetireDialog open={retireOpen} onClose={() => setRetireOpen(false)} agent={agent} receipts={receipts} grants={grants} />
      <DeleteAgentDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} agent={agent} />
    </div>
  );
}
