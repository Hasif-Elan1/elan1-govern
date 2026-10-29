import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Clock3, OctagonX, RotateCcw, Settings2, Users } from 'lucide-react';
import { api, db } from '@/api';
import type { Approval, ReviewItem } from '@/types';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useUser } from '@/store/session';
import { mayDecide, secondApprovals } from '@/features/work/backend';
import { useUi } from '@/store/ui';
import { countdown, n } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ApprovalChip, Banner, Button, EmptyState, Kbd, PageHeader, SearchInput, Segmented, Select, Skeleton } from '@/components/ui';
import { AgentLink, Money, TagList } from '@/components/domain';
import { blastRadius, outageActive, reversalOf } from '@/mock/approvalsExt';
import { ensureRecordsSeed } from '@/mock/records';
import { ApprovalDetail } from './ApprovalDetail';
import { ApprovalsUnavailable, CheckSummaryLine } from './DecidePanels';
import type { DecisionMode } from './DecisionForm';
import { URGENCY_LABEL, groupByUrgency, heldReason, isInGroup, matchesQuery, sortForInbox, urgencyOf } from './lib';

const KIND_LABEL: Record<ReviewItem['kind'], string> = {
  rulebook_review: 'rulebook reviews',
  assessment_signoff: 'assessment sign-offs',
  erasure_approval: 'erasure approvals',
  graduation_proposal: 'autonomy graduations',
};

type View = 'waiting' | 'decided' | 'all';
const VIEWS: View[] = ['waiting', 'decided', 'all'];

function useMediaQuery(q: string) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : true);
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

/**
 * Approvals — a split inbox. List on the left grouped by urgency, the selected approval on the right.
 * J/K move, A/R open the decision form, Ctrl+Enter commits, Esc cancels. Filters live in the URL.
 */
export default function ApprovalsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  // ?agent=<slug> narrows the inbox to one agent (linked from the agent page as "all approvals for this agent")
  const agentParam = params.get('agent')?.trim() || '';
  const defaultView: View = agentParam ? 'all' : 'waiting';
  const viewParam = params.get('view') as View | null;
  const view: View = viewParam && VIEWS.includes(viewParam) ? viewParam : defaultView;
  const q = params.get('q') ?? '';
  // filters live in the URL so a view can be pasted: waiting on me, expiring within an hour, tool, counterparty
  const mineOnly = params.get('mine') === '1';
  const soonOnly = params.get('soon') === '1';
  const toolParam = params.get('tool') ?? '';
  const cpParam = params.get('cp') ?? '';
  // raised by: an agent acting for itself (or an automated service), or a person through an agent that declares it acts for one
  const byParam = (['agent', 'person'] as const).find((x) => x === params.get('by')) ?? '';
  const user = useUser();
  const canDecide = useCan('approvals.decide');
  const singleKey = useUi((s) => s.singleKeyShortcuts);
  const now = useNow(15_000);
  const wide = useMediaQuery('(min-width: 1024px)');
  const orgId = useOrgId();
  // the agents' declarations (who raised each call) are seeded with the records door; done here, never while rendering
  const { data, loading, error, refetch } = useQuery(async (o) => { try { ensureRecordsSeed(o); } catch { /* the filter falls back to "agent" */ } return api.approvals(o); }, []);
  const others = useQuery(async (o) => {
    const items = user ? await api.reviewsQueue(o, user.id) : [];
    return { items, second: secondApprovals(o, user?.id) };
  }, [user?.id], { kinds: ['receipt', 'approval', 'rulebook', 'erasure', 'autonomy', 'assessment'] });
  const secondIds = useMemo(() => new Set((others.data?.second ?? []).map((s) => s.approval.id)), [others.data]);
  const forMe = (others.data?.items ?? []).filter((x) => x.canAct);
  const [mode, setMode] = useState<DecisionMode>(null);

  useEffect(() => { setMode(null); }, [id]);

  const outage = useQuery(async (o) => outageActive(o), [], { kinds: ['approval', 'receipt'] });
  const byAgent = useMemo(() => (data ?? []).filter((a) => !agentParam || a.agentSlug === agentParam), [data, agentParam]);
  const tools = useMemo(() => Array.from(new Set(byAgent.map((a) => a.tool))).sort(), [byAgent]);
  const cps = useMemo(() => Array.from(new Set(byAgent.map((a) => a.counterparty).filter((c): c is string => !!c))).sort(), [byAgent]);
  const waitingOnMe = useCallback((a: Approval) => {
    if (a.status !== 'pending' || !user) return false;
    const w = mayDecide(orgId, a, user.id);
    return w.ok && (w.member || !!w.delegateFor) && !heldReason(orgId, a);
  }, [orgId, user]);
  const all = useMemo(() => byAgent.filter((a) =>
    (!mineOnly || waitingOnMe(a))
    && (!soonOnly || (a.status === 'pending' && new Date(a.expiresAt).getTime() - now <= 3.6e6))
    && (!toolParam || a.tool === toolParam)
    && (!cpParam || a.counterparty === cpParam)
    && (!byParam || raisedBy(orgId, a.agentSlug) === byParam)), [byAgent, mineOnly, soonOnly, toolParam, cpParam, byParam, waitingOnMe, now, orgId]);
  const filterCount = [mineOnly, soonOnly, !!toolParam, !!cpParam, !!byParam].filter(Boolean).length;
  const clearFilters = () => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      ['mine', 'soon', 'tool', 'cp', 'by'].forEach((k) => next.delete(k));
      return next;
    }, { replace: true });
  };
  const counts = useMemo(() => ({
    waiting: all.filter((a) => a.status === 'pending').length,
    decided: all.filter((a) => a.status !== 'pending').length,
    all: all.length,
  }), [all]);

  const filtered = useMemo(() => sortForInbox(all.filter((a) => (view === 'all' ? true : view === 'waiting' ? a.status === 'pending' : a.status !== 'pending')).filter((a) => matchesQuery(a, q))), [all, view, q]);
  const groups = useMemo(() => groupByUrgency(filtered, now), [filtered, now]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const search = params.toString() ? `?${params.toString()}` : '';
  const backHref = `/approvals${search}`;

  const go = useCallback((aid: string, replace = false) => nav({ pathname: `/approvals/${aid}`, search }, { replace }), [nav, search]);

  const setParam = (k: string, v: string | null) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
      return next;
    }, { replace: true });
  };

  // dropping the agent filter keeps the view the person was looking at
  const clearAgent = () => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete('agent');
      if (view === 'waiting') next.delete('view');
      else next.set('view', view);
      return next;
    }, { replace: true });
  };

  // wide screens open the first item so the right pane is never empty
  useEffect(() => {
    if (wide && !id && flat.length) go(flat[0].id, true);
  }, [wide, id, flat, go]);

  // keep the selected row in view
  useEffect(() => {
    if (id) document.getElementById(`apr-row-${id}`)?.scrollIntoView({ block: 'nearest' });
  }, [id]);

  const nextWaiting = useCallback(() => {
    const waiting = sortForInbox(all.filter((a) => a.status === 'pending' && a.id !== id));
    if (waiting[0]) go(waiting[0].id);
  }, [all, id, go]);

  // single-key shortcuts: J/K move, A/R decide. Skipped while typing, in dialogs, after the shell's "g" prefix, or when turned off.
  const lastG = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest?.('.cm-editor');
      if (e.metaKey || e.ctrlKey || e.altKey || typing || !singleKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'g') { lastG.current = Date.now(); return; }
      if (Date.now() - lastG.current < 1200) { lastG.current = 0; return; }
      if (k === 'j' || k === 'k') {
        if (!flat.length) return;
        e.preventDefault();
        const i = flat.findIndex((a) => a.id === id);
        const j = i < 0 ? 0 : k === 'j' ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1);
        if (flat[j] && flat[j].id !== id) go(flat[j].id);
      } else if ((k === 'a' || k === 'r') && id && canDecide) {
        e.preventDefault();
        setMode(k === 'a' ? 'approve' : 'reject');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, id, go, singleKey, canDecide]);

  return (
    <div className="overflow-x-clip">
      <PageHeader
        kicker="Work"
        title="Approvals"
        description={canDecide
          ? 'Actions your agents asked a person to decide. Nothing held runs until someone approves; expiry is a refusal.'
          : 'Actions your agents asked a person to decide. Read-only: approvers, admins and owners decide them. Nothing held runs until someone approves; expiry is a refusal.'}
        actions={
          <>
            <div className="hidden md:flex items-center gap-3 text-xs text-muted" aria-label="Keyboard shortcuts">
              <span className="inline-flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
              {canDecide && <span className="inline-flex items-center gap-1"><Kbd>A</Kbd><Kbd>R</Kbd> decide</span>}
              {canDecide && <span className="inline-flex items-center gap-1"><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> commit</span>}
            </div>
            <Link to="/approvals/settings" className="inline-flex items-center gap-1.5 h-8 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg"><Settings2 className="h-3.5 w-3.5" aria-hidden />Delegates and safeguards</Link>
          </>
        }
      />

      {outage.data ? <ApprovalsUnavailable /> : (<>
      {error && (
        <Banner tone="bad" title="Approvals could not be loaded" className="mb-4" actions={<Button size="sm" variant="secondary" onClick={refetch}>Try again</Button>}>
          {error.message}
        </Banner>
      )}

      {forMe.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-line bg-surface px-4 py-3">
          <p className="text-sm min-w-0">
            <span className="font-medium">{n(forMe.length)} more {forMe.length === 1 ? 'decision waits' : 'decisions wait'} for a second person</span>
            <span className="text-muted"> — {Array.from(new Set(forMe.map((x) => KIND_LABEL[x.kind]))).join(', ')}. The author never approves their own change.</span>
          </p>
          <Link to="/work/reviews" className="inline-flex items-center gap-1 h-8 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">Open reviews <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] border border-line bg-surface lg:h-[calc(100vh-14.5rem)] lg:min-h-[600px]">
        {/* List */}
        <aside aria-label="Approvals list" className={cn('flex-col min-h-0 lg:border-r border-line', id ? 'hidden lg:flex' : 'flex')}>
          <div className="p-3 border-b border-line space-y-2.5 bg-surface">
            <div className="overflow-x-auto">
              <Segmented<View>
                label="Show"
                value={view}
                onChange={(v) => setParam('view', v === defaultView ? null : v)}
                options={[
                  { value: 'waiting', label: 'Waiting', count: counts.waiting },
                  { value: 'decided', label: 'Decided', count: counts.decided },
                  { value: 'all', label: 'All', count: counts.all },
                ]}
              />
            </div>
            <SearchInput aria-label="Search approvals" placeholder="Search agent, rule, counterparty, amount" value={q} onChange={(e) => setParam('q', e.target.value)} />
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
              {(canDecide || mineOnly) && <button type="button" aria-pressed={mineOnly} onClick={() => setParam('mine', mineOnly ? null : '1')} className={cn('h-7 px-2.5 text-xs font-medium border transition-colors', mineOnly ? 'bg-fg text-canvas border-fg' : 'border-line text-muted hover:text-fg hover:border-line-strong')}>Waiting on me</button>}
              <button type="button" aria-pressed={soonOnly} onClick={() => setParam('soon', soonOnly ? null : '1')} className={cn('h-7 px-2.5 text-xs font-medium border transition-colors', soonOnly ? 'bg-fg text-canvas border-fg' : 'border-line text-muted hover:text-fg hover:border-line-strong')}>Expiring within an hour</button>
              {filterCount > 0 && <button type="button" onClick={clearFilters} className="h-7 px-1.5 text-xs font-medium underline underline-offset-2 text-muted hover:text-fg">Clear {filterCount === 1 ? 'filter' : `${filterCount} filters`}</button>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select size_="sm" aria-label="Tool" value={toolParam} onChange={(e) => setParam('tool', e.target.value)}>
                <option value="">Every tool</option>
                {Array.from(new Set([...tools, ...(toolParam ? [toolParam] : [])])).map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
              <Select size_="sm" aria-label="Counterparty" value={cpParam} onChange={(e) => setParam('cp', e.target.value)}>
                <option value="">Every counterparty</option>
                {Array.from(new Set([...cps, ...(cpParam ? [cpParam] : [])])).map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
              <Select size_="sm" aria-label="Raised by" value={byParam} onChange={(e) => setParam('by', e.target.value)}>
                <option value="">Raised by anyone</option>
                <option value="agent">Raised by an agent</option>
                <option value="person">Raised by a person</option>
              </Select>
            </div>
            {agentParam && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="text-muted">Showing</span>
                <AgentLink slug={agentParam} plain className="font-medium" />
                <span className="text-muted">only ·</span>
                <button type="button" className="font-medium underline underline-offset-2 hover:text-fg" onClick={clearAgent}>Show every agent</button>
              </p>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto" aria-live="polite" aria-busy={loading}>
            {loading && !data ? (
              <ListSkeleton />
            ) : flat.length === 0 ? (
              q ? (
                <EmptyState compact title="No approvals match" action={<Button size="sm" variant="secondary" onClick={() => setParam('q', null)}>Clear search</Button>}>
                  Nothing in “{view === 'all' ? 'All' : view === 'waiting' ? 'Waiting' : 'Decided'}” matches “{q}”.
                </EmptyState>
              ) : filterCount > 0 ? (
                <EmptyState compact title="No approvals match these filters" action={<Button size="sm" variant="secondary" onClick={clearFilters}>Clear filters</Button>}>
                  {mineOnly ? 'Nothing here is waiting on you' : 'Nothing here matches'}{soonOnly ? ' and expires within an hour' : ''}{toolParam ? ` for ${toolParam}` : ''}{cpParam ? ` with ${cpParam}` : ''}{byParam ? ` raised by ${byParam === 'person' ? 'a person' : 'an agent'}` : ''}.
                </EmptyState>
              ) : agentParam ? (
                <EmptyState compact title={`No ${view === 'all' ? '' : `${view} `}approvals for ${agentParam}`} action={<Button size="sm" variant="secondary" onClick={clearAgent}>Show every agent</Button>}>
                  {view === 'waiting' ? 'Nothing from this agent is waiting for a person.' : view === 'decided' ? 'No approval from this agent has been decided yet.' : 'This agent has not asked a person to decide anything yet.'}
                </EmptyState>
              ) : view === 'waiting' ? (
                <EmptyState compact title={canDecide ? 'Nothing is waiting for you' : 'Nothing is waiting for a person'} action={<Link to="/rulebooks" className="text-sm font-medium underline underline-offset-2">See what escalates to a person</Link>}>
                  Agents are running inside their rulebooks. Anything that needs a person will appear here.
                </EmptyState>
              ) : (
                <EmptyState compact title="No decided approvals yet">Approvals appear here once someone approves or rejects them, or they expire.</EmptyState>
              )
            ) : (
              groups.map((g) => (
                <section key={g.key} aria-label={URGENCY_LABEL[g.key]}>
                  <h3 className={cn('sticky top-0 z-[1] flex items-center justify-between px-4 py-1.5 border-b border-line bg-sunken/95 backdrop-blur-[2px] label', g.key === 'hour' && 'text-held-fg')}>
                    <span>{URGENCY_LABEL[g.key]}</span>
                    <span className="num">{n(g.items.length)}</span>
                  </h3>
                  <ul>
                    {g.items.map((a) => <Row key={a.id} a={a} by={raisedBy(orgId, a.agentSlug)} selected={a.id === id} now={now} mine={isInGroup(orgId, user?.id, a.approverGroup) || waitingOnMe(a)} firstApproval={!!secondIds?.has(a.id)} held={!!heldReason(orgId, a)} reversed={!!reversalOf(orgId, a.id)} to={{ pathname: `/approvals/${a.id}`, search }} />)}
                  </ul>
                </section>
              ))
            )}
          </div>
          <div className="px-4 py-2 border-t border-line text-xs text-muted flex items-center justify-between">
            <span>{n(flat.length)} shown</span>
            <span>Expiry is a refusal</span>
          </div>
        </aside>

        {/* Detail */}
        <section aria-label="Approval detail" className={cn('min-h-0 min-w-0 flex-col', id ? 'flex' : 'hidden lg:flex')}>
          {id ? (
            <ApprovalDetail key={id} id={id} mode={mode} setMode={setMode} onNext={nextWaiting} backHref={backHref} hasNext={all.some((a) => a.status === 'pending' && a.id !== id)} />
          ) : loading ? (
            <div className="p-6 space-y-4"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-48" /></div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-muted">{canDecide ? 'Select an approval to see why it was held and what happens if you approve.' : 'Select an approval to see why it was held and how it was decided.'}</p>
            </div>
          )}
        </section>
      </div>
      </>)}
    </div>
  );
}

/**
 * Who raised a held call, from the agent's declaration in force: a person (the agent declares it acts for a named
 * person who started the task) or an agent (acting for itself, or an automated service). Read-only.
 */
function raisedBy(orgId: string, slug: string): 'agent' | 'person' {
  const ag = db.getDB(orgId).agents.find((x) => x.slug === slug) as { declaration?: { actorKind?: string } } | undefined;
  return ag?.declaration?.actorKind === 'agent_on_behalf_of_person' ? 'person' : 'agent';
}

function Row({ a, by, selected, now, mine, firstApproval, held, reversed, to }: { a: Approval; by: 'agent' | 'person'; selected: boolean; now: number; mine: boolean; firstApproval: boolean; held: boolean; reversed: boolean; to: { pathname: string; search: string } }) {
  const urgent = urgencyOf(a, now) === 'hour';
  const br = blastRadius(a);
  return (
    <li id={`apr-row-${a.id}`}>
      <Link
        to={to}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'block px-4 py-3 border-b border-line transition-colors focus:outline-none focus-visible:shadow-[inset_3px_0_0_rgb(var(--fg))]',
          selected ? 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--accent))]' : 'hover:bg-sunken/60',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium leading-snug line-clamp-2 min-w-0">{a.headline}</p>
          {a.amount !== undefined && <Money value={a.amount} className="shrink-0 text-sm font-semibold" />}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1">{by === 'person' ? 'Raised by a person through' : 'Raised by agent'} <AgentLink slug={a.agentSlug} plain className="font-normal" /></span>
          <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" aria-hidden />{a.approverGroup}{mine && <span className="text-info-fg">· yours</span>}</span>
          {held && <span className="inline-flex items-center gap-1 text-bad-fg font-medium"><OctagonX className="h-3 w-3" aria-hidden />Held by the stop</span>}
          {firstApproval && a.status === 'pending' && <span className="text-held-fg font-medium">1 of 2 approved</span>}
          {a.escalations?.some((e) => e.by === 'system') && <span>re-routed</span>}
          {a.status === 'pending' ? (
            <span className={cn('inline-flex items-center gap-1 num', urgent && 'text-held-fg font-medium')}>
              <Clock3 className="h-3 w-3" aria-hidden />{countdown(a.expiresAt, now) === 'expired' ? 'Expiring now' : `${countdown(a.expiresAt, now)} left`}
            </span>
          ) : (
            <ApprovalChip status={a.status} size="sm" />
          )}
          {reversed && <span className="inline-flex items-center gap-1 font-medium text-fg"><RotateCcw className="h-3 w-3" aria-hidden />Reversed</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <CheckSummaryLine a={a} />
          <span className={cn(br.dualControl && 'text-held-fg font-medium')}>{br.label}{br.dualControl ? ' · two people' : ''}</span>
        </div>
        {a.riskTags.length > 0 && <div className="mt-2"><TagList tags={a.riskTags} max={3} /></div>}
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y divide-line">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="px-4 py-3 space-y-2">
          <Skeleton className="h-4" style={{ width: `${70 + (i % 3) * 8}%` }} />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
