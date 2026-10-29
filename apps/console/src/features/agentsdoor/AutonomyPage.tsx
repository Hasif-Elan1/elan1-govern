import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BookCheck, Check, FlaskConical, GraduationCap, Hand, History, Lock, ShieldCheck, Undo2 } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgLevel, useUser } from '@/store/session';
import type { Agent, AutonomyGrant, AutonomyLevel, Condition, Decision, GraduationProposal, Receipt, RiskTag, Rule, Rulebook, RulebookVersion } from '@/types';
import { evaluate } from '@/lib/evaluate';
import { COOLDOWN_DAYS, GRADUATION, NO_GRANT_LABEL, NOT_YET_AVAILABLE, autonomyRank, isAvailableLevel } from '@/lib/autonomy';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { date, n, rupees, tagLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { toolByName } from '@/mock/catalog';
import { Badge, Banner, Button, DecisionChip, EmptyState, PageHeader, Panel, Segmented, Skeleton, StatusChip, Tabs, Tooltip } from '@/components/ui';
import { AgentLink, AgentStatus, ReceiptLink, RouteMode, TagList, When } from '@/components/domain';
import { UpgradePath } from '@/features/settings/shared';
import { effectiveGroups } from '@/features/settings/orgApi';
import { useCanDo, useMemberRole } from '@/features/settings/permissions';
import { DecideGraduationDialog, ProposeDialog, RecordChecks, RevokeButton, SupervisionPanel, type Candidate, type Supervision } from '@/features/agents/AgentAutonomy';
import { TabPanel, usePageTitle, useTabParam, word } from './shared';
import { BreachesPanel } from './AutonomyBreaches';
import { IfCan } from '@/shell/access';

/*
 * Agents › Autonomy. Autonomy is graduation only (lib/autonomy.ts): nothing here sets or raises a level.
 * Every write type starts at A2 Propose at L3; one owner or admin proposes a graduation to A3 when the record
 * meets the thresholds and a different one approves it; the first 30 days are supervised (1 in 10 calls sampled
 * for a person); any owner or admin revokes in one press. A4 and A5 are listed as not yet available.
 */

/* ── The ladder ─────────────────────────────────────────────────────────── */

const LADDER: { id: AutonomyLevel; name: string; line: string }[] = [
  { id: 'A0', name: 'Observe', line: 'Reads only. A write type with no level is A0.' },
  { id: 'A1', name: 'Draft', line: 'Prepares drafts; a person sends them.' },
  { id: 'A2', name: 'Propose', line: 'Where every write type starts at L3: a named person commits each write.' },
  { id: 'A3', name: 'Act reversible', line: 'Reached only by a two-person graduation. The rulebook decides unchanged.' },
  { id: 'A4', name: 'Act bounded', line: 'Not yet available. No agent can reach it.' },
  { id: 'A5', name: 'Act broad', line: 'Not yet available. No agent can reach it.' },
];
const label = (l: AutonomyLevel) => `${l} ${LADDER[autonomyRank(l)].name}`;

const WRITE_TAGS: RiskTag[] = ['writes_data', 'moves_money', 'sends_external', 'deletes', 'changes_access', 'changes_production'];
const IRREVERSIBLE: RiskTag[] = ['moves_money', 'deletes', 'changes_access'];
const DAY = 864e5;
const WINDOW_DAYS = 21;

const WINDOWS: Record<string, string> = { day: 'a day', '1h': 'an hour', '30m': 'per 30 minutes', '7d': 'a week' };
const OPS: Record<string, string> = { eq: 'is', lt: '<', lte: '≤', gt: '>', gte: '≥', in: 'in', to_domain_in: 'domain in', fields_include: 'includes' };
function valueText(field: string, v: string | number | string[]): string {
  if (Array.isArray(v)) return v.length > 2 ? `${v.slice(0, 2).join(', ')} +${v.length - 2}` : v.join(', ');
  if (typeof v === 'number') return /amount/i.test(field) ? rupees(v) : n(v);
  return v.replace(/_/g, ' ');
}
const condText = (c: Condition) => `${c.field.replace(/_/g, ' ')} ${OPS[c.op] ?? c.op} ${valueText(c.field, c.value)}`;
function conditionsText(rule: Rule): string {
  const when = (rule.when ?? []).map(condText).join(' and ');
  const unless = (rule.unless ?? []).map(condText).join(' and ');
  if (when && unless) return `When ${when}, unless ${unless}`;
  if (when) return `When ${when}`;
  if (unless) return `Unless ${unless}`;
  return 'Always';
}
function quotaText(rule: Rule): string | undefined {
  const q = rule.quota;
  if (!q) return undefined;
  const per = WINDOWS[q.window] ?? `per ${q.window}`;
  return q.kind === 'max_sum' ? `at most ${/amount/i.test(q.field ?? '') ? rupees(q.limit) : n(q.limit)} ${per}` : `at most ${n(q.limit)} ${word(q.limit, 'call')} ${per}`;
}

/* ── Reading a rulebook: how far it lets an agent act on one write type ──── */

interface Reading { title: string; sub: string; noRule?: boolean; paths: { rule: Rule; text: string }[] }

/**
 * What the rulebook allows on one write type. This is never an autonomy level: a level exists only from L3,
 * where every write type starts at A2 Propose and reaches A3 only by a two-person graduation. Shown beside the
 * level in force from L3, and on its own below L3.
 *   refused by a rule, or no rule        → Refused
 *   a draft-only tool the rulebook allows → Drafts only
 *   only ask                              → Asks a person
 *   allow (with or without limits)        → Acts within limits / Acts with no limit
 */
function readRulebook(rules: Rule[], tool: string, tags: RiskTag[], groupName: (id?: string) => string): Reading {
  const live = rules.filter((r) => r.mode !== 'simulate');
  const e = evaluate(live, tool, {}, tags);
  const applicable = e.matched.filter((m) => m.outcome !== 'not_applicable').map((m) => m.rule);
  const conditional = e.matched.filter((m) => m.outcome === 'unknown_field').map((m) => m.rule);
  const rank: Record<Decision, number> = { refuse: 0, ask: 1, allow: 2 };
  const paths = applicable.slice().sort((a, b) => rank[b.decide] - rank[a.decide]).map((rule) => {
    const bits = [conditionsText(rule)];
    const quota = quotaText(rule);
    if (quota) bits.push(quota);
    if (rule.decide === 'ask') bits.push(`a person in ${groupName(rule.approver)} commits · expires in ${rule.expiresIn ?? '24h'}`);
    return { rule, text: bits.join(' · ') };
  });
  if (!applicable.length) return { title: 'Refused', sub: 'No rule names this write type, so the default refuses it.', noRule: true, paths };
  if (e.decision === 'refuse' && e.ruleId !== 'default') return { title: 'Refused', sub: `Refused by rule ${e.ruleId}.`, paths };
  const allows = applicable.filter((r) => r.decide === 'allow');
  const asks = applicable.filter((r) => r.decide === 'ask');
  const allowShadowed = e.decision === 'ask' && allows.every((r) => !r.when?.length);
  if (allows.length && !allowShadowed) {
    if (/draft/i.test(tool.split('.').pop() ?? '')) return { title: 'Drafts only', sub: 'Prepares a draft; a person sends it.', paths };
    const unbounded = e.decision === 'allow' && conditional.length === 0 && !allows.some((r) => r.quota);
    const irreversible = tags.some((t) => IRREVERSIBLE.includes(t));
    if (unbounded && !irreversible) return { title: 'Acts with no limit', sub: 'Allowed with no conditions on a write that can be undone.', paths };
    if (unbounded) return { title: 'Acts with no limit', sub: `Allowed with no limit on a write that cannot be undone (${tags.filter((t) => IRREVERSIBLE.includes(t)).map((t) => tagLabel[t].toLowerCase()).join(', ')}). Add a limit to the rule.`, paths };
    return { title: 'Acts within limits', sub: asks.length ? 'Acts inside the rule’s limits; outside them a person commits.' : 'Acts inside the rule’s limits below.', paths };
  }
  if (asks.length) return { title: 'Asks a person', sub: 'Every call waits for a named person.', paths };
  return { title: 'Refused', sub: 'Only refusals apply to this write type.', paths };
}

/* ── Data ───────────────────────────────────────────────────────────────── */

interface ToolRow {
  tool: string; description: string; tags: RiskTag[]; write: boolean;
  reading: Reading;
  grant?: AutonomyGrant; history: AutonomyGrant[];
  candidate?: Candidate; graduated: boolean; supervised: boolean;
  effective: AutonomyLevel; effectiveTitle: string; noGrant: boolean;
  observed: Record<Decision, number>;
}
interface AgentRow { agent: Agent; rulebook?: Rulebook; published?: RulebookVersion; draftAhead?: RulebookVersion; tools: ToolRow[] }

async function load(orgId: string) {
  const since = Date.now() - WINDOW_DAYS * DAY;
  const [grants, candidates, proposals, supervision, agents, rulebooks, connectors, receipts, admin] = await Promise.all([
    api.grants(orgId), api.graduationCandidates(orgId), api.graduationProposals(orgId), api.supervision(orgId), api.agents(orgId), api.rulebooks(orgId), api.connectors(orgId),
    api.receipts(orgId, { kind: 'decision', from: since }), api.receipts(orgId, { kind: 'admin', from: Date.now() - 180 * DAY }),
  ]);
  const enforced = grants.enforced;
  const toolInfo = new Map<string, { tags: RiskTag[]; description: string }>();
  for (const c of connectors) for (const t of c.tools) toolInfo.set(t.name, { tags: t.tags, description: t.description });
  const groups = effectiveGroups(orgId);

  const rows: AgentRow[] = agents.map((agent) => {
    const rb = rulebooks.find((r) => r.id === agent.rulebookId);
    const published = rb?.versions.filter((v) => v.status === 'published').sort((a, b) => b.version - a.version)[0];
    const draftAhead = rb?.versions.filter((v) => v.status !== 'published' && v.version > (published?.version ?? 0)).sort((a, b) => b.version - a.version)[0];
    const groupName = (id?: string) => rb?.approverGroups.find((g) => g.id === id)?.name ?? groups.find((g) => g.id === id)?.name ?? 'A person';
    const tools = agent.tools.map((tool): ToolRow => {
      const info = toolInfo.get(tool) ?? { tags: toolByName(tool)?.tags ?? [], description: toolByName(tool)?.description ?? '' };
      const g = grants.rows.find((x) => x.agentSlug === agent.slug && x.tool === tool);
      const observed: Record<Decision, number> = { allow: 0, ask: 0, refuse: 0 };
      for (const r of receipts.items) if (r.agent === agent.slug && r.tool === tool && r.decision && r.rule_id !== 'agent-paused') observed[r.decision]++;
      const reading = readRulebook(published?.rules ?? [], tool, info.tags, groupName);
      // below L3 there is no autonomy level: the rulebook's reading is what it allows, never a grant. Each write
      // type is placed where it starts at the upgrade (A2 Propose, set by the platform), as the agent's own tab says.
      const effective: AutonomyLevel = enforced ? (g?.level ?? 'A0') : GRADUATION.from;
      return {
        tool, description: info.description, tags: info.tags, write: info.tags.some((t) => WRITE_TAGS.includes(t)),
        reading, grant: g?.grant, history: g?.history ?? [], candidate: candidates.find((c) => c.agentSlug === agent.slug && c.tool === tool),
        graduated: !!g?.graduated, supervised: !!g?.supervised, effective,
        effectiveTitle: enforced ? (g?.grant ? label(g.grant.level) : NO_GRANT_LABEL) : `No level until L3 · starts at ${label(GRADUATION.from)} at the upgrade`,
        noGrant: enforced ? !g?.grant : true,
        observed,
      };
    });
    return { agent, rulebook: rb, published, draftAhead, tools };
  });

  const history = admin.items.filter((r) => (r.action ?? '').startsWith('autonomy.') || r.action === 'level.upgraded').slice(0, 60);
  return { rows, enforced, candidates, proposals, supervision, history };
}

/* ── Marks ──────────────────────────────────────────────────────────────── */

/** The level as a square code plus a five-step ladder. Ink only: a level is not a status. */
function LevelMark({ level, noGrant, compact }: { level: AutonomyLevel; noGrant?: boolean; compact?: boolean }) {
  const r = autonomyRank(level);
  const off = !isAvailableLevel(level);
  return (
    <span className="inline-flex items-center gap-2" aria-label={`${label(level)}${noGrant ? ' (no grant)' : ''}${off ? ` (${NOT_YET_AVAILABLE.toLowerCase()})` : ''}`}>
      <span className={cn('inline-flex h-6 min-w-[30px] items-center justify-center border px-1 font-mono text-[12px] font-semibold', off ? 'border-dashed border-line-strong/60 text-subtle' : r === 0 ? 'border-line-strong/60 bg-sunken text-muted' : r === 3 ? 'border-fg bg-fg text-canvas' : 'border-fg text-fg')}>{level}</span>
      {!compact && <span className="hidden sm:inline-flex items-center gap-[3px]" aria-hidden>{[1, 2, 3, 4, 5].map((i) => <span key={i} className={cn('h-2 w-2 border', i <= r ? 'border-fg bg-fg' : 'border-line-strong/50')} />)}</span>}
    </span>
  );
}

function Observed({ o, slug, tool }: { o: Record<Decision, number>; slug: string; tool: string }) {
  const total = o.allow + o.ask + o.refuse;
  if (!total) return <span className="text-xs text-subtle">No calls in {WINDOW_DAYS} days</span>;
  return <Link to={`/activity?agent=${encodeURIComponent(slug)}&tool=${encodeURIComponent(tool)}&range=all`} className="text-xs text-muted hover:text-fg hover:underline underline-offset-2 num">{n(o.allow)} allowed · {n(o.ask)} asked · {n(o.refuse)} refused</Link>;
}

/* ── Page ───────────────────────────────────────────────────────────────── */

type TabId = 'agents' | 'matrix' | 'history';
const TABS = ['agents', 'matrix', 'history'] as const;

export default function AutonomyPage() {
  usePageTitle('Autonomy');
  const level = useOrgLevel();
  const role = useMemberRole();
  // owners and admins propose, approve and revoke (the autonomy.grant permission id); approvers also review samples
  const canGrant = useCanDo('autonomy.grant');
  const canReview = role === 'owner' || role === 'admin' || role === 'approver';
  const [tab, setTab] = useTabParam<TabId>(TABS);
  const [sp, setSp] = useSearchParams();
  const show = sp.get('show') === 'all' ? 'all' : 'writes';
  const levelParam = sp.get('level');
  const levelFilter = levelParam && /^A[0-5]$/.test(levelParam) ? (levelParam as AutonomyLevel) : undefined;
  // ?agent=<slug> narrows the page to one agent; ?proposal=<id> scrolls to and marks a graduation proposal
  const agentParam = sp.get('agent') ?? undefined;
  const proposalParam = sp.get('proposal') ?? undefined;
  const setParam = (k: string, v?: string) => setSp((p) => { const x = new URLSearchParams(p); if (v === undefined) x.delete(k); else x.set(k, v); return x; }, { replace: true });
  const [proposing, setProposing] = useState<Candidate>();
  const [deciding, setDeciding] = useState<GraduationProposal>();

  const { data, loading, error, refetch } = useQuery(load, [], { kinds: ['agent', 'rulebook', 'connector', 'receipt', 'autonomy', 'approval'] });
  const enforced = data?.enforced ?? atLeast(level, 'l3');
  const agentKnown = !agentParam || !data || data.rows.some((r) => r.agent.slug === agentParam);
  const shownRows = useMemo(() => (data?.rows ?? []).filter((r) => !agentParam || r.agent.slug === agentParam), [data, agentParam]);

  const counts = useMemo(() => {
    const c: Record<AutonomyLevel, number> = { A0: 0, A1: 0, A2: 0, A3: 0, A4: 0, A5: 0 };
    let noGrant = 0;
    for (const r of shownRows) for (const t of r.tools) if (t.write) { c[t.effective]++; if (t.noGrant) noGrant++; }
    return { c, noGrant, total: Object.values(c).reduce((a, b) => a + b, 0) };
  }, [shownRows]);

  const visible = (t: ToolRow) => (show === 'all' || t.write) && (!levelFilter || (t.write && t.effective === levelFilter));
  const byAgent = <T extends { agentSlug: string }>(xs: T[]) => xs.filter((x) => !agentParam || x.agentSlug === agentParam);
  // a linked proposal is always listed, even when the agent filter would hide it
  const shownProposals = (data?.proposals ?? []).filter((p) => !agentParam || p.agentSlug === agentParam || p.id === proposalParam);
  const shownCandidates = byAgent(data?.candidates ?? []);
  const shownSupervision = (data?.supervision ?? []).filter((r) => !agentParam || r.grant.agentSlug === agentParam);
  const shownHistory = (data?.history ?? []).filter((r) => !agentParam || r.agent === agentParam);

  return (
    <div className="space-y-6 overflow-x-clip">
      <PageHeader
        kicker="Agents"
        title="Autonomy"
        description="How far each agent may act on each write type. No one sets a level: every write type starts at A2 Propose, and reaches A3 only by a graduation one owner or admin proposes and a different one approves. Revoking is one press. An agent never approves."
        meta={enforced
          ? <StatusChip tone="ok" size="sm" icon={<ShieldCheck className="h-3 w-3" />}>Levels enforced by the guard · {LEVEL_INFO[level].label}</StatusChip>
          : <StatusChip tone="info" size="sm" icon={<BookCheck className="h-3 w-3" />}>Read from today’s rulebooks · enforced from L3</StatusChip>}
        actions={<Link to="/rulebooks/suggestions" className="inline-flex items-center gap-1.5 h-10 px-4 border border-line-strong/70 bg-surface text-sm font-medium hover:border-fg">Rule suggestions<ArrowUpRight className="h-4 w-4" aria-hidden /></Link>}
      />

      {error && <Banner tone="bad" title="Autonomy could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {agentParam && (agentKnown ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>Showing <AgentLink slug={agentParam} /> only.</span>
          <button type="button" className="link" onClick={() => setParam('agent')}>Show every agent</button>
        </p>
      ) : (
        <Banner tone="neutral" title={`No agent called ${agentParam}`} actions={<Button size="sm" onClick={() => setParam('agent')}>Show every agent</Button>}>
          It may have been deleted before it made a call, or the link is for another organisation.
        </Banner>
      ))}
      {!enforced && (
        <UpgradePath to="l3">
          The guard enforces autonomy from L3 Proven. Until then there is no autonomy level: each agent acts as its rulebook allows (shown below each write type). At the upgrade every write type starts at A2 Propose, set by the platform, and reaches A3 only by graduation; the record kept until then counts towards it.
        </UpgradePath>
      )}

      <section aria-labelledby="ladder-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ladder-title" className="text-lg font-semibold">The ladder</h2>
          <p className="text-sm text-muted">
            {loading && !data ? 'Counting write types…' : enforced
              ? <><span className="num">{n(counts.total)}</span> agent write types · <span className="num">{n(counts.noGrant)}</span> with no level</>
              : <><span className="num">{n(counts.total)}</span> agent write types · no level until L3; each starts at A2 Propose at the upgrade</>}
            {levelFilter && <> · <button type="button" className="link" onClick={() => setParam('level')}>Clear the {levelFilter} filter</button></>}
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 border-l border-t border-line">
          {LADDER.map((step) => {
            const on = levelFilter === step.id;
            const off = !isAvailableLevel(step.id);
            const inner = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <LevelMark level={step.id} compact />
                  {off ? <Badge>{NOT_YET_AVAILABLE}</Badge> : <span className="font-display text-2xl font-semibold num leading-none">{loading && !data ? '–' : n(counts.c[step.id])}</span>}
                </div>
                <p className={cn('mt-3 text-sm font-semibold', off && 'text-muted')}>{step.name}</p>
                <p className="mt-1 text-xs text-muted leading-relaxed">{step.line}</p>
              </>
            );
            return off ? (
              <div key={step.id} className="border-r border-b border-line p-4 min-w-0 bg-canvas" aria-disabled="true">{inner}</div>
            ) : (
              <button key={step.id} type="button" aria-pressed={on}
                onClick={() => { setParam('level', on ? undefined : step.id); if (tab !== 'agents') setTab('agents'); }}
                className={cn('group text-left border-r border-b border-line p-4 transition-colors min-w-0', on ? 'bg-sunken shadow-[inset_0_-2px_0_rgb(var(--fg))]' : 'bg-surface hover:bg-sunken/60')}>
                {inner}
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="xl:col-span-8 min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Tabs<TabId> label="Autonomy views" value={tab} onChange={setTab} className="flex-1 min-w-[220px]"
              items={[{ value: 'agents', label: 'By agent' }, { value: 'matrix', label: 'Matrix' }, { value: 'history', label: 'History', count: data ? shownHistory.length : undefined }]} />
            {tab !== 'history' && <Segmented size="sm" label="Which tools" value={show} onChange={(v) => setParam('show', v === 'writes' ? undefined : v)} options={[{ value: 'writes', label: 'Write types' }, { value: 'all', label: 'All tools' }]} />}
          </div>

          {tab === 'agents' && (
            <TabPanel label="By agent">
              {loading && !data ? <div className="space-y-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-48" />)}</div>
                : !data?.rows.length ? <EmptyState title="No agents yet" action={<IfCan perm="agents.manage"><Link to="/agents/new" className="link">Add an agent</Link></IfCan>}>Agents appear here once one is added and its rulebook is published.</EmptyState>
                  : <div className="space-y-6">{shownRows.map((row) => <AgentBlock key={row.agent.id} row={row} rows={row.tools.filter(visible)} filtered={!!levelFilter} enforced={enforced} canGrant={canGrant} onPropose={setProposing} />)}</div>}
            </TabPanel>
          )}
          {tab === 'matrix' && <TabPanel label="Matrix">{loading && !data ? <Skeleton className="h-96" /> : data && <Matrix rows={shownRows} show={show} enforced={enforced} />}</TabPanel>}
          {tab === 'history' && <TabPanel label="History">{loading && !data ? <Skeleton className="h-64" /> : data && <HistoryList items={shownHistory} />}</TabPanel>}
        </div>

        <aside className="xl:col-span-4 space-y-6 min-w-0" aria-label="Graduations, the supervised period and the rules">
          {data && <GraduationPanel proposals={shownProposals} candidates={shownCandidates} enforced={enforced} canGrant={canGrant} focus={proposalParam} onClearFocus={() => setParam('proposal')} onPropose={setProposing} onDecide={setDeciding} />}
          {data && enforced && <SupervisionPanel rows={shownSupervision as Supervision[]} canReview={canReview} showAgent />}
          {data && enforced && <BreachesPanel agentSlug={agentParam} graduated={shownRows.flatMap((r) => r.tools.filter((t) => t.graduated && t.grant).map((t) => t.grant!))} />}

          <Panel title="3 rules that do not bend">
            <ul className="space-y-4 text-sm">
              <Principle icon={<Hand className="h-4 w-4" aria-hidden />} title="An agent never approves">Approvals are human, named and expire. The approval receipt names the person; an expired approval is refused and recorded.</Principle>
              <Principle icon={<Lock className="h-4 w-4" aria-hidden />} title="No one sets a level">Every write type starts at A2 Propose. A3 is reached only by a graduation: at least {GRADUATION.minDays} days, {GRADUATION.minRecords} records and {GRADUATION.minApprovals} approvals, proposed by one owner or admin and approved by a different one, then {GRADUATION.supervisedDays} days supervised. A4 and A5 are not yet available.</Principle>
              <Principle icon={<Undo2 className="h-4 w-4" aria-hidden />} title="Revoking is one press">Any owner or admin, alone, at any time. It takes effect at the next call and the write type goes back to A2, with no new proposal for {COOLDOWN_DAYS} days. An autonomy breach revokes automatically. {enforced ? 'A refusal from the rulebook is never relaxed by a level.' : 'Anything a rulebook does not allow is refused by default.'}</Principle>
            </ul>
          </Panel>

          <Banner tone="neutral" title="How the rulebook is read">
            Refused, or no rule: refused. A draft-only tool it allows: drafts only. Ask only: asks a person. Allow: acts within any limits the rule sets. This is what the rulebook allows, never an autonomy level: a rule cannot grant A3, only a graduation can. Where an allow and an ask both match, the stricter applies — <span className="whitespace-nowrap">Try an action</span> on the rulebook gives the exact decision.
          </Banner>
        </aside>
      </div>

      <ProposeDialog candidate={proposing} onClose={() => setProposing(undefined)} />
      <DecideGraduationDialog prop={deciding} onClose={() => setDeciding(undefined)} />
    </div>
  );
}

function Principle({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center border border-line bg-sunken text-fg">{icon}</span>
      <div className="min-w-0"><p className="font-semibold">{title}</p><p className="mt-0.5 text-muted leading-relaxed">{children}</p></div>
    </li>
  );
}

/* ── By agent ───────────────────────────────────────────────────────────── */

function AgentBlock({ row, rows, filtered, enforced, canGrant, onPropose }: { row: AgentRow; rows: ToolRow[]; filtered: boolean; enforced: boolean; canGrant: boolean; onPropose: (c: Candidate) => void }) {
  const { agent, rulebook, published, draftAhead } = row;
  if (filtered && rows.length === 0) return null;
  const advisory = agent.route !== 'mcp';
  return (
    <Panel flush
      title={<span className="flex flex-wrap items-center gap-x-3 gap-y-1"><AgentLink slug={agent.slug} className="text-lg" /><span className="text-sm font-normal text-muted truncate">{agent.name}</span></span>}
      actions={rulebook && <Link to={`/rulebooks/${rulebook.slug}`} className="hidden sm:inline-flex items-center gap-1 text-sm link whitespace-nowrap"><BookCheck className="h-3.5 w-3.5" aria-hidden />{published ? `Rulebook v${published.version}` : 'Rulebook'}</Link>}>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-line bg-sunken/40 text-sm">
        <AgentStatus agent={agent} />
        <RouteMode route={agent.route} compact />
        {draftAhead && <Badge tone="neutral">v{draftAhead.version} {draftAhead.status === 'in_review' ? 'in review' : 'draft'} · not yet counted</Badge>}
      </div>
      {agent.status !== 'active' && <p className="px-5 py-2.5 border-b border-line text-sm text-fg/85">{agent.status === 'stopped' ? 'Stopped by the emergency stop.' : agent.pausedBy === 'auto-pause' ? 'Paused by auto-pause.' : 'Paused by its owner.'} Every call is refused and recorded until a person resumes it; the levels below apply once it runs again.</p>}
      {rows.length === 0 ? <p className="px-5 py-4 text-sm text-muted">This agent has no write types. It only reads, which A0 Observe covers.</p> : (
        <ul className="divide-y divide-line">
          {rows.map((t) => (
            <li key={t.tool} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] md:gap-6">
              <div className="min-w-0">
                <p className="font-mono text-[13px] break-all">{t.tool}</p>
                {t.description && <p className="mt-0.5 text-xs text-muted">{t.description}</p>}
                <div className="mt-2"><TagList tags={t.tags} max={3} /></div>
              </div>
              <div className="min-w-0">
                {t.write ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3">
                      <LevelMark level={t.effective} noGrant={t.noGrant} />
                      <span className="text-sm font-semibold">{t.effectiveTitle}</span>
                      {t.supervised && <Badge tone="held">Supervised</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {enforced
                        ? t.grant
                          ? t.graduated
                            ? <>Graduated {date(t.grant.grantedAt)}, approved by {userName(t.grant.grantedBy)}{t.grant.seq && <>, receipt <ReceiptLink seq={t.grant.seq} /></>}{t.supervised && t.grant.supervisedUntil && <> · supervised until {date(t.grant.supervisedUntil)}, 1 in {t.grant.sampleEvery ?? GRADUATION.sampleEvery} calls sampled</>}. What the rulebook allows: {t.reading.title}.</>
                            : <>Starting level since {date(t.grant.grantedAt)}, set by the platform at L3: a person approves every write. What the rulebook allows: {t.reading.title}.</>
                          : <>No level for this write type, so the guard refuses its writes. What the rulebook allows: {t.reading.title}.</>
                        : <>What rulebook v{published?.version ?? '—'} allows: <span className="font-medium text-fg">{t.reading.title}</span>. {t.reading.sub} This is not an autonomy level; A3 comes only by graduation from L3.</>}
                    </p>
                    {enforced && t.candidate && !t.graduated && t.effective === GRADUATION.from && (
                      <div className="mt-2.5">
                        <RecordChecks checks={t.candidate.checks} record={t.candidate.precedent} className="max-w-[560px]" />
                        {t.candidate.openProposalId && <p className="mt-1.5 text-xs"><Badge tone="held">Proposed · waiting for a second person</Badge></p>}
                        {t.candidate.cooldownUntil && <p className="mt-1.5 text-xs"><Badge tone="held">Cooldown until {date(t.candidate.cooldownUntil)}</Badge> <span className="text-muted">{t.candidate.whyNot}</span></p>}
                      </div>
                    )}
                    {enforced && canGrant && (t.graduated || t.candidate?.eligible) && (
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {t.candidate?.eligible && <Button size="sm" variant="secondary" icon={<GraduationCap className="h-3.5 w-3.5" />} onClick={() => onPropose(t.candidate!)}>Propose A3</Button>}
                        {t.graduated && t.grant && <RevokeButton grant={t.grant} />}
                      </div>
                    )}
                  </>
                ) : <p className="text-sm"><span className="font-semibold">Read</span> <span className="text-muted">— not a write type; reads run at every level, A0 included.</span></p>}
                {t.reading.paths.length > 0 && (
                  <ul className="mt-2.5 space-y-1.5">
                    {t.reading.paths.map((p) => (
                      <li key={p.rule.id} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs">
                        <DecisionChip decision={p.rule.decide} size="sm" short />
                        <span className="min-w-0 flex-1 text-fg/85">{p.text} <span className="font-mono text-subtle">· {p.rule.id}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2.5"><Observed o={t.observed} slug={agent.slug} tool={t.tool} /></div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rulebook && published && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 border-t border-line text-sm">
          <Link to={`/rulebooks/${rulebook.slug}?tab=try`} className="inline-flex items-center gap-1 link"><FlaskConical className="h-3.5 w-3.5" aria-hidden />Try an action</Link>
          <span className="text-xs text-muted">Rulebook v{published.version}{published.signedBy && <>, signed by {userName(published.signedBy)}</>}.{advisory && ' On check and record the levels advise; the agent runs the call.'}</span>
        </div>
      )}
    </Panel>
  );
}

/* ── Graduations ────────────────────────────────────────────────────────── */

function GraduationPanel({ proposals, candidates, enforced, canGrant, focus, onClearFocus, onPropose, onDecide }: {
  proposals: GraduationProposal[]; candidates: Candidate[]; enforced: boolean; canGrant: boolean; focus?: string; onClearFocus?: () => void;
  onPropose: (c: Candidate) => void; onDecide: (p: GraduationProposal) => void;
}) {
  const user = useUser();
  const open = proposals.filter((p) => p.status === 'open');
  // the 5 most recent decided ones, plus a linked one that is older
  const decided = proposals.filter((p) => p.status !== 'open').filter((p, i) => i < 5 || p.id === focus);
  const eligible = candidates.filter((c) => c.eligible);
  // closest to the thresholds first, so the numbers people watch are at the top (below L3: a preview of every write type)
  const close = candidates.filter((c) => (enforced ? !c.met && c.level === GRADUATION.from : true)).sort((a, b) => b.checks.filter((k) => k.met).length - a.checks.filter((k) => k.met).length || b.precedent.approvals - a.precedent.approvals).slice(0, 3);
  const focused = focus ? proposals.find((p) => p.id === focus) : undefined;
  useEffect(() => {
    if (!focused) return;
    const t = window.setTimeout(() => document.getElementById(`proposal-${focused.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
    return () => window.clearTimeout(t);
  }, [focused?.id]);
  const proposerOf = (p: GraduationProposal) => p.proposedBy ?? p.decisions[0]?.userId;
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><GraduationCap className="h-4 w-4" aria-hidden />Graduation to A3</span>} actions={<Badge tone={open.length ? 'held' : 'neutral'}>{open.length} open</Badge>}>
      <p className="text-sm text-fg/85 leading-relaxed">A write type at A2 can graduate once its record shows at least <span className="num">{GRADUATION.minDays}</span> days, <span className="num">{GRADUATION.minRecords}</span> records and <span className="num">{GRADUATION.minApprovals}</span> approvals. <span className="font-medium text-fg">The numbers are shown, never a recommendation: one owner or admin proposes, a different one approves.</span></p>
      {!enforced && <p className="mt-2 text-xs text-muted">Below L3 the numbers are a preview; graduation starts at L3.</p>}
      {focus && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className={focused ? 'text-fg' : 'text-muted'}>{focused ? <>Linked proposal: <span className="font-mono">{focused.agentSlug}</span> · {focused.tool} · {focused.status === 'open' ? 'waiting for a second person' : focused.status}</> : 'The linked proposal is no longer listed. It may have been decided some time ago.'}</span>
          {onClearFocus && <button type="button" className="link" onClick={onClearFocus}>Clear</button>}
        </p>
      )}

      {open.length > 0 && (
        <ul className="mt-4 space-y-3">
          {open.map((p) => {
            const proposer = proposerOf(p);
            const mine = proposer === user?.id;
            return (
              <li key={p.id} id={`proposal-${p.id}`} aria-current={p.id === focus ? 'true' : undefined} className={cn('border p-3 text-sm scroll-mt-24', p.id === focus ? 'border-fg bg-sunken shadow-[inset_3px_0_0_rgb(var(--accent))]' : 'border-line')}>
                <p><span className="font-mono">{p.agentSlug}</span> · <span className="font-mono text-[12.5px] break-all">{p.tool}</span></p>
                <p className="mt-1 flex items-center gap-2"><LevelMark level={p.from} compact /><span aria-hidden>→</span><LevelMark level={p.to} compact /><span className="text-xs text-muted">Proposed by {userName(proposer)} <When iso={p.createdAt} /></span></p>
                <p className="mt-1.5 text-xs text-muted num">{n(p.evidence.days)} days · {n(p.evidence.records)} records · {n(p.evidence.approvals)} approvals · {n(p.evidence.rejections)} rejected · {n(p.evidence.reversals)} reversed</p>
                {p.decisions[0]?.note && <p className="mt-1 text-xs">“{p.decisions[0].note}”</p>}
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {enforced && canGrant
                    ? <Button size="sm" variant={mine ? 'ghost' : 'primary'} icon={mine ? undefined : <Check className="h-3.5 w-3.5" />} onClick={() => onDecide(p)}>{mine ? 'Withdraw' : 'Decide'}</Button>
                    : <span className="text-xs text-muted">An owner or admin other than {userName(proposer)} approves.</span>}
                  {mine && <span className="text-xs text-muted">You proposed it; a different owner or admin approves.</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {enforced && eligible.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-2">Eligible, not yet proposed</p>
          <ul className="space-y-3">
            {eligible.map((c) => (
              <li key={`${c.agentSlug}|${c.tool}`} className="text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0"><span className="font-mono">{c.agentSlug}</span> · <span className="font-mono text-[12.5px] break-all">{c.tool}</span></p>
                  {canGrant
                    ? <Button size="sm" variant="secondary" icon={<GraduationCap className="h-3.5 w-3.5" />} onClick={() => onPropose(c)}>Propose A3</Button>
                    : <span className="text-xs text-muted">Owners and admins propose</span>}
                </div>
                <RecordChecks checks={c.checks} record={c.precedent} className="mt-1.5" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {enforced && candidates.some((c) => c.cooldownUntil) && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-2">In the {COOLDOWN_DAYS}-day cooldown</p>
          <ul className="space-y-2 text-sm">
            {candidates.filter((c) => c.cooldownUntil).map((c) => (
              <li key={`${c.agentSlug}|${c.tool}`}>
                <p><span className="font-mono">{c.agentSlug}</span> · <span className="font-mono text-[12.5px] break-all">{c.tool}</span></p>
                <p className="mt-0.5 text-xs text-muted">{c.whyNot}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {close.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-2">Closest to the thresholds</p>
          <ul className="space-y-3">
            {close.map((c) => (
              <li key={`${c.agentSlug}|${c.tool}`} className="text-sm">
                <p><span className="font-mono">{c.agentSlug}</span> · <span className="font-mono text-[12.5px] break-all">{c.tool}</span></p>
                <RecordChecks checks={c.checks} record={c.precedent} className="mt-1.5" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {open.length === 0 && eligible.length === 0 && close.length === 0 && <p className="mt-4 text-sm text-muted">No write type is at A2 with a record to show yet.</p>}

      {decided.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-2">Decided</p>
          <ul className="space-y-1.5 text-xs">{decided.map((p) => <li key={p.id} id={`proposal-${p.id}`} aria-current={p.id === focus ? 'true' : undefined} className={cn('scroll-mt-24', p.id === focus && 'bg-sunken px-1.5 py-1 shadow-[inset_3px_0_0_rgb(var(--accent))]')}><span className="font-mono">{p.agentSlug}</span> · {p.tool} {p.from}→{p.to} · {p.status === 'granted' ? 'graduated' : p.status}{p.seq && <> · <ReceiptLink seq={p.seq} /></>}</li>)}</ul>
        </div>
      )}
      {!enforced && <UpgradePath to="l3" compact className="mt-4">Two-person graduation, the supervised period and levels the guard enforces start at L3.</UpgradePath>}
    </Panel>
  );
}

/* ── History ────────────────────────────────────────────────────────────── */

const ACTION_TEXT: Record<string, string> = {
  'autonomy.started': 'started write types at the A2 starting level', 'autonomy.graduation_proposed': 'proposed a graduation', 'autonomy.graduated': 'approved a graduation',
  'autonomy.graduation_withdrawn': 'withdrew a graduation proposal', 'autonomy.graduation.declined': 'declined a graduation', 'autonomy.sample_reviewed': 'reviewed a sampled call',
  'autonomy.revoked': 'revoked', 'autonomy.breach_revoke_confirmed': 'confirmed the revoke a breach report asked for', 'level.upgraded': 'changed the assurance level',
  // written before autonomy became graduation only; kept so older receipts still read
  'autonomy.granted': 'granted', 'autonomy.graduation.approved': 'approved a graduation', 'autonomy.grant_requested': 'asked a second person to grant',
  'autonomy.grant_declined': 'declined a grant request', 'autonomy.grant_recorded': 'recorded for L3', 'autonomy.grant_withdrawn': 'withdrew',
};

function HistoryList({ items }: { items: Receipt[] }) {
  if (!items.length) return <EmptyState compact title="No autonomy changes yet" disc="trail">Starting levels, graduation proposals and decisions, sampled-call reviews and revocations appear here as receipts.</EmptyState>;
  return (
    <ol className="border border-line bg-surface divide-y divide-line">
      {items.map((r) => {
        const d = r.details ?? {};
        return (
          <li key={r.seq} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3 text-sm">
            <History className="h-4 w-4 mt-0.5 text-muted shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p><span className="font-medium">{userName(r.actor)}</span> {ACTION_TEXT[r.action ?? ''] ?? r.action}{r.agent && <> · <AgentLink slug={r.agent} /></>}{d.tool && <> · <span className="font-mono text-[12.5px]">{String(d.tool)}</span></>}{d.level && <> → <span className="font-semibold">{String(d.level)}</span></>}{d.to && !d.level && <> → <span className="font-semibold">{String(d.to)}</span></>}{d.falls_back_to && <> · back to {String(d.falls_back_to)}</>}{d.call_seq !== undefined && <> · call <ReceiptLink seq={Number(d.call_seq)} /> ({String(d.outcome)})</>}</p>
              {(d.reason || d.justification || d.note) && <p className="text-xs text-muted mt-0.5">“{String(d.justification ?? d.reason ?? d.note)}”</p>}
              {d.supervised_until && <p className="text-xs text-muted mt-0.5">Supervised until {date(String(d.supervised_until))} · {String(d.sample ?? `1 in ${GRADUATION.sampleEvery}`)} calls sampled</p>}
            </div>
            <span className="text-xs text-muted whitespace-nowrap"><When iso={r.ts} /> · <ReceiptLink seq={r.seq} /></span>
          </li>
        );
      })}
    </ol>
  );
}

/* ── Matrix ─────────────────────────────────────────────────────────────── */

function Matrix({ rows, show, enforced }: { rows: AgentRow[]; show: 'writes' | 'all'; enforced: boolean }) {
  const tools = useMemo(() => {
    const m = new Map<string, { tags: RiskTag[]; write: boolean }>();
    for (const r of rows) for (const t of r.tools) if (show === 'all' || t.write) m.set(t.tool, { tags: t.tags, write: t.write });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, show]);
  if (!rows.length || !tools.length) return <EmptyState compact title="Nothing to show">No agent holds a write type yet.</EmptyState>;
  return (
    <div className="border border-line bg-surface overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{enforced ? 'Autonomy level in force for each agent on each write type' : 'Starting level at the L3 upgrade for each agent on each write type, with what the published rulebook allows'}</caption>
        <thead><tr className="border-b border-line bg-sunken/60">
          <th scope="col" className="sticky left-0 z-10 bg-sunken text-left px-4 py-3 label font-semibold min-w-[200px]">Write type</th>
          {rows.map((r) => <th key={r.agent.id} scope="col" className="px-3 py-3 text-left font-medium whitespace-nowrap"><AgentLink slug={r.agent.slug} /></th>)}
        </tr></thead>
        <tbody>
          {tools.map(([tool, info]) => (
            <tr key={tool} className="border-b border-line last:border-b-0 hover:bg-sunken/40">
              <th scope="row" className="sticky left-0 z-10 bg-surface text-left px-4 py-2.5 font-normal">
                <span className="block font-mono text-[12.5px]">{tool}</span>
                <span className="block text-[11px] text-subtle">{info.tags.filter((t) => t !== 'reads_data').map((t) => tagLabel[t]).join(' · ') || 'Reads data'}</span>
              </th>
              {rows.map((r) => {
                const t = r.tools.find((x) => x.tool === tool);
                if (!t) return <td key={r.agent.id} className="px-3 py-2.5 text-subtle" aria-label="Not one of this agent’s tools">—</td>;
                if (!t.write) return <td key={r.agent.id} className="px-3 py-2.5 text-xs text-muted">Read</td>;
                return (
                  <td key={r.agent.id} className="px-3 py-2.5">
                    <Tooltip content={<span className="block max-w-[260px]"><span className="font-semibold">{t.effectiveTitle}{t.supervised ? ' · supervised' : ''}</span><br />{enforced ? (t.graduated && t.grant ? `Graduated ${date(t.grant.grantedAt)}, approved by ${userName(t.grant.grantedBy)}` : t.grant ? 'Starting level, set by the platform at L3' : 'No level') : `What the rulebook allows: ${t.reading.title}. ${t.reading.sub}`}</span>}>
                      <span tabIndex={0} className="inline-flex"><LevelMark level={t.effective} noGrant={t.noGrant} compact /></span>
                    </Tooltip>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-3 border-t border-line text-xs text-muted">“—” means the write type is not one of the agent’s tools. Hover or focus a level for its source. Paused agents keep their levels; nothing runs until they are resumed.</p>
    </div>
  );
}
