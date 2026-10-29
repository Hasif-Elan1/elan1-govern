import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Bot, ShieldCheck, User } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { userById } from '@/mock/users';
import { n } from '@/lib/format';
import { ROLE_INFO } from '@/lib/permissions';
import { Avatar, Banner, Button, PageHeader, Skeleton, Tabs, Tooltip } from '@/components/ui';
import { MembersSection } from '@/features/settings/sections/Members';
import { RolesSection } from '@/features/settings/sections/Roles';
import { ApproverGroupsSection } from '@/features/settings/sections/ApproverGroups';
import { TabPanel, usePageTitle, useTabParam, word } from './shared';
import { SmartLink } from '@/shell/access';

type TabId = 'members' | 'groups' | 'roles';
const TABS = ['members', 'groups', 'roles'] as const;
const DAY = 864e5;
const WINDOW_DAYS = 21;

/** Counts the three kinds of actor the chain names, over the last 21 days. */
async function loadActors(orgId: string) {
  const since = Date.now() - WINDOW_DAYS * DAY;
  const [receipts, agents, members] = await Promise.all([api.receipts(orgId, { from: since }), api.agents(orgId), api.members(orgId)]);
  const people = new Map<string, { approved: number; published: number; other: number }>();
  const actingAgents = new Set<string>();
  let agentCalls = 0;
  const system = { expiries: 0, pauses: 0, other: 0 };
  for (const r of receipts.items) {
    if (r.kind === 'decision' && r.agent) { actingAgents.add(r.agent); agentCalls++; }
    const a = r.actor;
    if (!a) continue;
    if (a === 'system') {
      if (r.approval?.status === 'expired') system.expiries++;
      else if (r.action === 'agent.paused') system.pauses++;
      else system.other++;
      continue;
    }
    const p = people.get(a) ?? { approved: 0, published: 0, other: 0 };
    if (r.kind === 'approval') p.approved++;
    else if (r.action === 'rulebook.published') p.published++;
    else p.other++;
    people.set(a, p);
  }
  const deciders = [...people.entries()].filter(([, p]) => p.approved + p.published > 0).sort((x, y) => (y[1].approved + y[1].published) - (x[1].approved + x[1].published));
  return {
    deciders,
    otherPeople: people.size - deciders.length,
    approvals: deciders.reduce((s, [, p]) => s + p.approved, 0),
    publishes: deciders.reduce((s, [, p]) => s + p.published, 0),
    actingAgents: actingAgents.size,
    agentCalls,
    totalAgents: agents.length,
    system,
    activeMembers: members.filter((m) => m.status === 'active').length,
    invited: members.filter((m) => m.status === 'invited').length,
  };
}

/**
 * People and roles — "who is acting here" includes people. Members and their roles sit behind the
 * Agents door beside the agents, because every receipt names an actor: a person, an agent or the system.
 */
export default function PeoplePage() {
  usePageTitle('People and roles');
  const [tab, setTab] = useTabParam<TabId>(TABS);
  // ?member=<userId> (from the agent map and elsewhere) highlights and scrolls to that person on Members
  const [sp, setSp] = useSearchParams();
  const member = sp.get('member') ?? undefined;
  const clearMember = () => setSp((p) => { const x = new URLSearchParams(p); x.delete('member'); return x; }, { replace: true });
  const { data, loading, error, refetch } = useQuery(loadActors, [], { kinds: ['receipt', 'approval', 'member', 'agent', 'rulebook'] });
  const systemTotal = data ? data.system.expiries + data.system.pauses + data.system.other : 0;

  return (
    <div className="overflow-x-clip">
      <PageHeader
        kicker="Agents"
        title="People and roles"
        description="The people in this organisation, what their role lets them do, and how they sign in. People are actors too: they approve held actions and publish rulebooks, and the chain names them each time."
      />

      <section aria-labelledby="actors-title" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="actors-title" className="text-lg font-semibold">Actors</h2>
          <p className="text-sm text-muted">Every receipt names an actor of one of 3 kinds · last {WINDOW_DAYS} days</p>
        </div>
        {error && <Banner tone="bad" className="mb-4" title="Actor counts could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
        <div className="grid md:grid-cols-3 border-l border-t border-line">
          <ActorCard
            icon={<User className="h-4 w-4" aria-hidden />}
            kind="Human"
            loading={loading && !data}
            value={data?.deciders.length}
            unit={data && word(data.deciders.length, 'person', 'people')}
            line={data && <>decided held actions or published rulebooks: <span className="num">{n(data.approvals)}</span> {word(data.approvals, 'decision')}, <span className="num">{n(data.publishes)}</span> {word(data.publishes, 'publish', 'publishes')}.{data.otherPeople > 0 && <> {n(data.otherPeople)} more made other changes.</>}</>}
            extra={data && data.deciders.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="People who decided or published">
                {data.deciders.slice(0, 8).map(([id, p]) => {
                  const u = userById(id);
                  return (
                    <Tooltip key={id} content={`${u?.name ?? id} · ${p.approved} ${word(p.approved, 'decision')}, ${p.published} ${word(p.published, 'publish', 'publishes')}`}>
                      <span tabIndex={0} className="inline-flex"><Avatar initials={u?.initials ?? '?'} size={26} title={u?.name ?? id} /></span>
                    </Tooltip>
                  );
                })}
              </div>
            )}
            to="/activity?kind=approval&range=all"
            linkLabel="See approval receipts"
          />
          <ActorCard
            icon={<Bot className="h-4 w-4" aria-hidden />}
            kind="Agent"
            loading={loading && !data}
            value={data?.actingAgents}
            unit={data && `of ${n(data.totalAgents)} ${word(data.totalAgents, 'agent')}`}
            line={data && <>made <span className="num">{n(data.agentCalls)}</span> {word(data.agentCalls, 'call')}. An agent never approves; it proposes, and a person commits.</>}
            to="/agents"
            linkLabel="Open agents"
            secondary={{ to: '/agents/autonomy', label: 'Autonomy' }}
          />
          <ActorCard
            icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
            kind="System"
            loading={loading && !data}
            value={data ? systemTotal : undefined}
            unit={data && word(systemTotal, 'action')}
            line={data && <>by Elan1 Govern itself: <span className="num">{n(data.system.expiries)}</span> approval {word(data.system.expiries, 'expiry', 'expiries')}, <span className="num">{n(data.system.pauses)}</span> auto-{word(data.system.pauses, 'pause')}{data.system.other > 0 && <>, {n(data.system.other)} other</>}. Auto-pause is off by default.</>}
            to={`/activity?range=all&q=${encodeURIComponent('"actor":"system"')}`}
            linkLabel="See system receipts"
          />
        </div>
      </section>

      <Tabs<TabId>
        label="People and roles"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'members', label: 'Members' },
          { value: 'groups', label: 'Approver groups' },
          { value: 'roles', label: 'Roles and permissions', count: Object.keys(ROLE_INFO).length },
        ]}
      />
      {tab === 'members' && <TabPanel label="Members"><MembersSection focus={member} onClearFocus={clearMember} /></TabPanel>}
      {tab === 'groups' && <TabPanel label="Approver groups"><ApproverGroupsSection /></TabPanel>}
      {tab === 'roles' && <TabPanel label="Roles and permissions"><RolesSection /></TabPanel>}
    </div>
  );
}

function ActorCard({ icon, kind, loading, value, unit, line, extra, to, linkLabel, secondary }: {
  icon: ReactNode; kind: string; loading: boolean; value?: number; unit?: ReactNode; line?: ReactNode; extra?: ReactNode;
  to: string; linkLabel: string; secondary?: { to: string; label: string };
}) {
  return (
    <div className="flex flex-col border-r border-b border-line bg-surface p-5 min-w-0">
      <p className="flex items-center gap-2 label">{icon}{kind}</p>
      {loading ? (
        <div className="mt-3 space-y-2"><Skeleton className="h-8 w-24" /><Skeleton className="h-4 w-full" /></div>
      ) : (
        <>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="font-display text-3xl font-semibold tracking-tighter2 num leading-none">{n(value ?? 0)}</span>
            <span className="text-sm text-muted">{unit}</span>
          </p>
          <p className="mt-2 text-sm text-fg/85 leading-relaxed">{line}</p>
          {extra && <div className="mt-3">{extra}</div>}
        </>
      )}
      <div className="mt-auto pt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link to={to} className="inline-flex items-center gap-1 link">{linkLabel}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
        {secondary && <SmartLink to={secondary.to} hideWhenBlocked className="inline-flex items-center gap-1 link">{secondary.label}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>}
      </div>
    </div>
  );
}
