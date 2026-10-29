import { useMemo, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, BadgeCheck, BookCheck, ClipboardCheck, Clock3, Eraser, Gauge, Handshake, HeartPulse, Inbox, KeyRound, Lightbulb, OctagonX, Receipt as ReceiptIcon, Server, ShieldCheck, Siren, Stamp, Users } from 'lucide-react';
import { api } from '@/api';
import { DOORS, doorHome, doorsFor, type DoorKey } from '@/shell/nav';
import { IfCan, PlanUpsell, SmartLink, useScreenAccess } from '@/shell/access';
import type { Agent, Approval, Decision, LevelId } from '@/types';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { userName } from '@/mock/users';
import { isReadOnly } from '@/lib/autonomy';
import { LEVEL_INFO, atLeast, nextLevel } from '@/lib/levels';
import { countdown, n, pct, plural, relative, rupees, rupeesShort, seqLabel, timeShort, TZ } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, DECISION_META, Hash, KeyValue, LegalDraft, Meter, PageHeader, Panel, ProgressArc, Skeleton, Stat, StatusChip } from '@/components/ui';
import { AgentLink, AgentStatus, Money, ReceiptLink, RouteMode, When } from '@/components/domain';
import { DecisionBars, Legend, SERIES } from '@/components/charts';
import { OnboardingChecklist } from './OnboardingChecklist';
import { LiveFeed } from './LiveFeed';
import { heldReason, isInGroup } from '../approvals/lib';
import { workQueues } from '@/features/work/backend';
import { LevelBadge, claimFor } from '@/features/work/level';
import { DueDatesPanel, MaintenanceNotice } from './DueDatesPanel';
import { loadMeter } from '@/features/billing/summary';
import { ContinuityLine } from '@/features/evidence/ContinuityLine';
import { useIntegrity } from '@/features/evidence/IntegrityRuns';
import { stopCoverage } from '@/shell/StopDialog';
import { frameworkCoverage } from '@/features/compliance/evidence';

type TodayData = Awaited<ReturnType<typeof api.today>>;
type Queues = Awaited<ReturnType<typeof workQueues>>;

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof']);

function firstName(full?: string) {
  if (!full) return '';
  const parts = full.split(/\s+/);
  return (HONORIFICS.has(parts[0].replace('.', '').toLowerCase()) ? parts[1] : parts[0]) ?? full;
}

function greeting(now: number) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }).format(new Date(now)));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const longDate = (now: number) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(new Date(now));

/** Level-specific evidence, loaded only for the levels that have it. */
async function levelExtras(orgId: string, level: LevelId, withMeter: boolean) {
  const l2 = atLeast(level, 'l2');
  const l3 = atLeast(level, 'l3');
  const [state, anchors, custody, deployment, cross, grants, proposals, meter] = await Promise.all([
    api.level(orgId),
    l2 ? api.anchors(orgId, 4).catch(() => undefined) : undefined,
    l2 ? api.custody(orgId).catch(() => undefined) : undefined,
    l2 ? api.deployment(orgId).catch(() => undefined) : undefined,
    l3 ? api.crossOrgReceipts(orgId).catch(() => undefined) : undefined,
    l3 ? api.grants(orgId).catch(() => undefined) : undefined,
    l3 ? api.graduationProposals(orgId).catch(() => undefined) : undefined,
    // the same source as /billing: the chain meter and the invoices built from it (features/billing/summary.ts)
    withMeter ? loadMeter(orgId).catch(() => undefined) : undefined,
  ]);
  return { state, anchors, custody, deployment, cross, grants, proposals, meter };
}
type Extras = Awaited<ReturnType<typeof levelExtras>>;

/**
 * Today — the operator's morning view: what the agents did in the last 24 hours, what is waiting for a person
 * (approvals, second-person reviews, erasure clocks, counterparty receipts), the organisation's assurance level
 * with its own evidence tiles, the chain, the meter and the first-week set-up steps.
 */
export default function TodayPage() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const canDecide = useCan('approvals.decide');
  const nav = useNavigate();
  const now = useNow(30_000);
  const ownerAdmin = role === 'owner' || role === 'admin';
  const { data, loading, error, refetch } = useQuery((o) => api.today(o), []);
  const queues = useQuery((o) => workQueues(o, user?.id), [user?.id]);
  const extras = useQuery((o) => levelExtras(o, level, ownerAdmin), [level, ownerAdmin], { kinds: ['receipt', 'level', 'approval', 'autonomy', 'checkpoint', 'key'] });

  // the page changes with the role: an approver sees their own queue first (approvals, reviews, alerts); a viewer
  // sees the read-only summary; owners and admins see everything. Auditors never land here (their home is /auditor).
  const hero = role === 'approver';
  const viewer = role === 'viewer';
  const next = nextLevel(level);

  return (
    <div className="space-y-6 overflow-x-clip">
      {data?.stop.active && (
        <Banner tone="bad" title="Emergency stop engaged" actions={data.stop.incidentId ? <Button size="sm" variant="secondary" onClick={() => nav(`/incidents/${data.stop.incidentId}`)}>Open the incident</Button> : undefined}>
          Engaged by {userName(data.stop.by)}{data.stop.since && <> {relative(data.stop.since, now)}</>}. {stopCoverage(data.stop).all ? 'Every new agent call is refused and recorded. Approvals already waiting are held' : `New ${stopCoverage(data.stop).refused}. Their approvals already waiting are held`} until the stop is lifted; nobody can decide them, and their expiry still runs. Reason: {data.stop.reason}
        </Banner>
      )}
      {data?.activeIncidents.filter((i) => i.id !== data.stop.incidentId).map((i) => (
        <Banner key={i.id} tone="held" title={i.title} actions={<Button size="sm" variant="secondary" onClick={() => nav(`/incidents/${i.id}`)}>Open</Button>}>
          {i.kind === 'auto_pause' ? 'Auto-paused' : i.kind === 'health' ? 'Health incident' : 'Active incident'} since {relative(i.startedAt, now)}{i.agentSlugs.length ? <> · {i.agentSlugs.join(', ')}</> : null}. {i.reason}
        </Banner>
      ))}

      <PageHeader
        className="mb-0"
        kicker="Work"
        title={`${greeting(now)}${user ? `, ${firstName(user.name)}` : ''}`}
        description={<>{longDate(now)} · India Standard Time. {hero ? 'What is waiting for your decision, then what your agents did.' : viewer ? 'What your agents did, and what is waiting for a person. Read-only: you can open every record here, and owners and admins make the changes.' : 'What your agents did, and what is waiting for a person.'}</>}
        meta={
          <>
            <LevelBadge level={level} />
            <span className="text-xs text-muted">{claimFor(level)}.</span>
            {next && role === 'owner' && <Link to={`/assurance/upgrade?to=${next}`} className="text-xs link">Upgrade to {LEVEL_INFO[next].name}</Link>}
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => nav('/activity')}>Activity</Button>
            {canDecide && (
              <Button variant="primary" icon={<Inbox className="h-4 w-4" aria-hidden />} onClick={() => nav('/approvals')}>
                Approvals{data ? ` · ${n(data.pending.length)}` : ''}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Banner tone="bad" title="Today could not be loaded" actions={<Button size="sm" variant="secondary" onClick={refetch}>Try again</Button>}>{error.message}</Banner>
      )}

      <MaintenanceNotice now={now} />

      {ownerAdmin && <OnboardingChecklist key={orgId} orgId={orgId} level={level} version={data?.head?.seq} />}

      {loading && !data ? <TodaySkeleton /> : data ? (
        <>
          {hero ? (
            // an approver's Today opens on their own queue: approvals and reviews, then the alerts to acknowledge
            <div className="grid gap-6 lg:grid-cols-12">
              <WaitingPanel data={data} queues={queues.data} now={now} orgId={orgId} userId={user?.id} hero className="lg:col-span-8" />
              <AlertsPanel data={data} queues={queues.data} now={now} className="lg:col-span-4" />
            </div>
          ) : null}
          <KpiRow data={data} queues={queues.data} now={now} />
          <LevelTiles level={level} extras={extras.data} loading={extras.loading} error={extras.error} ownerAdmin={ownerAdmin} now={now} />
          <FourDoors data={data} queues={queues.data} orgId={orgId} userId={user?.id} canDecide={canDecide} now={now} />
          {hero ? (
            // approvers do not open the Assurance screens behind the chain and coverage panels, so those are left out
            <div className="grid gap-6 lg:grid-cols-12">
              <DecisionsPanel data={data} className="lg:col-span-7" />
              <SuggestionsPanel data={data} proposals={extras.data?.proposals} level={level} className="lg:col-span-5" />
              <AgentsPanel agents={data.agents} grants={extras.data?.grants} level={level} className="lg:col-span-7" />
              <LiveFeed receipts={data.recent} className="lg:col-span-5" />
              <DueDatesPanel now={now} className="lg:col-span-12" />
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-12">
              <DecisionsPanel data={data} className="lg:col-span-8" />
              <WaitingPanel data={data} queues={queues.data} now={now} orgId={orgId} userId={user?.id} readOnly={viewer || !canDecide} className="lg:col-span-4" />
              <AgentsPanel agents={data.agents} grants={extras.data?.grants} level={level} className="lg:col-span-7" />
              <LiveFeed receipts={data.recent} className="lg:col-span-5" />
              <ChainPanel data={data} level={level} extras={extras.data} className="lg:col-span-4" />
              <CoveragePanel data={data} className="lg:col-span-4" />
              <SuggestionsPanel data={data} proposals={extras.data?.proposals} level={level} className="lg:col-span-4" />
              <DueDatesPanel now={now} className="lg:col-span-12" />
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/* ── KPI row ──────────────────────────────────────────────── */

function Delta({ cur, prev, unit }: { cur: number; prev: number; unit: string }) {
  if (!prev) return <span>No {unit} in the 24 h before</span>;
  const d = (cur - prev) / prev;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {d >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
      <span className="num font-medium text-fg">{d >= 0 ? '+' : '−'}{pct(Math.abs(d))}</span>
      <span>vs {n(prev)} the 24 h before</span>
    </span>
  );
}

function DecisionIcon({ d }: { d: Decision }) {
  const tone = { allow: 'text-ok-fg', ask: 'text-held-fg', refuse: 'text-bad-fg' }[d];
  return <span className={tone}>{DECISION_META[d].icon}</span>;
}

function KpiRow({ data, queues, now }: { data: TodayData; queues?: Queues; now: number }) {
  const c = data.counts.last24;
  const share = (v: number) => (c.total ? pct(v / c.total, 1) : '—');
  const soonest = data.pending[0];
  // behavioural alerts plus, from L2, the assurance-health alerts — the same set the Alerts page counts
  const openAlerts: { severity: string; status: string }[] = [...data.openAlerts, ...(queues?.assuranceAlerts ?? [])];
  const highAlerts = openAlerts.filter((a) => a.severity === 'high').length;
  const unacked = openAlerts.filter((a) => a.status === 'open').length;
  return (
    <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Decisions · 24 h" value={n(c.total)} sub={<Delta cur={c.total} prev={data.counts.prev24.total} unit="decisions" />} to="/activity" />
      <Stat label="Allowed" icon={<DecisionIcon d="allow" />} value={n(c.allow)} sub={`${share(c.allow)} of decisions`} to="/activity" />
      <Stat label="Asked a person" icon={<DecisionIcon d="ask" />} value={n(c.ask)} sub={`${share(c.ask)} of decisions`} to="/approvals" />
      <Stat label="Refused" icon={<DecisionIcon d="refuse" />} value={n(c.refuse)} sub={<span>{share(c.refuse)} · {n(data.counts.prev24.refuse)} the 24 h before</span>} to="/work/not-done" />
      <Stat
        label="Waiting approvals"
        icon={<Clock3 className="h-3.5 w-3.5 text-held-fg" aria-hidden />}
        value={n(data.pending.length)}
        sub={soonest ? <>Soonest expires in <span className="num font-medium text-fg">{countdown(soonest.expiresAt, now)}</span></> : 'Nothing waiting'}
        to="/approvals"
      />
      <Stat
        label="Open alerts"
        icon={<Siren className="h-3.5 w-3.5 text-muted" aria-hidden />}
        value={n(openAlerts.length)}
        sub={openAlerts.length ? `${n(highAlerts)} high · ${n(unacked)} not acknowledged` : 'No open alerts'}
        to="/alerts"
      />
    </div>
  );
}

/* ── Level-specific tiles ─────────────────────────────────── */

function Tile({ icon, label, value, sub, to, tone }: { icon: ReactNode; label: string; value: ReactNode; sub: ReactNode; to: string; tone?: 'ok' | 'held' | 'bad' }) {
  return (
    <li className="bg-surface">
      <Link to={to} className="group flex h-full flex-col gap-2 p-4 hover:bg-sunken/60">
        <span className="flex items-center gap-2 text-sm font-semibold"><span className="text-muted group-hover:text-fg">{icon}</span>{label}{tone && <span className={cn('ml-auto h-2 w-2', tone === 'ok' ? 'bg-ok' : tone === 'held' ? 'bg-held' : 'bg-bad')} aria-hidden />}</span>
        <span className="text-2xl font-semibold tracking-tight num">{value}</span>
        <span className="text-xs text-muted leading-snug">{sub}</span>
      </Link>
    </li>
  );
}

/** One row of tiles that changes with the level: the meter, anchoring lag (L2), counterparty receipts (L3), cluster health (Sovereign). */
function LevelTiles({ level, extras, loading, error, ownerAdmin, now: _now }: { level: LevelId; extras?: Extras; loading: boolean; error?: Error; ownerAdmin: boolean; now: number }) {
  const access = useScreenAccess();
  const all: ReactNode[] = [];
  // a tile is shown only to the roles that can open the screen it leads to (no tile leads to a 403)
  const tiles = { push: (el: ReactElement<{ to: string }>) => { if (access.canSee(el.props.to)) all.push(el); } };
  const meter = extras?.meter;
  if (ownerAdmin && meter) {
    // the same figures as /billing: allowance year from April, the draft invoice of the open month, Sovereign's yearly licence
    const { plan, cm, draft, yearFrac, projectedOver: over, pilot, held, actionCharge } = meter;
    tiles.push(
      <Tile key="meter" icon={<ReceiptIcon className="h-4 w-4" aria-hidden />} label="Meter" to="/billing" tone={held.length || pilot?.status === 'stopped' || pilot?.status === 'ended' || pilot?.status === 'closed' ? 'bad' : plan.includedPerYear && cm.fy.share > yearFrac + 0.1 ? 'held' : undefined}
        value={pilot && pilot.status !== 'converted' ? `${n(pilot.used)} / ${n(pilot.cap)}` : plan.includedPerYear ? pct(cm.fy.share) : n(Math.round(cm.fy.units))}
        sub={pilot && pilot.status !== 'converted'
          ? <>pilot actions used · {pilot.status === 'active' ? `free for ${pilot.daysLeft} more days, Guarded only` : pilot.status === 'closed' ? 'the organisation is closed after its pilot' : `writes are paused (POLICY.TENANT_STOPPED) · read-only${pilot.readOnlyUntil ? ` until ${new Date(pilot.readOnlyUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}` : ''} unless an owner moves to the paid plan`}</>
          : !plan.includedPerYear
            ? <>units metered in {cm.fy.label} (committed 1, refused 0.4) · governed actions this month so far {rupeesShort(actionCharge)} before GST · every action at {rupees(plan.overageRate, { paise: true })}, a refused one at {rupees(plan.refusalRate, { paise: true })} · deployment licence {rupeesShort(plan.floorPerYear)} a year, invoiced yearly</>
          : <>of {n(plan.includedPerYear)} included actions used in {cm.fy.label} (from April) · refusals count 0.4 ({n(Math.round(cm.fy.refused * 0.4))} for {n(cm.fy.refused)} refused) · {over > 0 ? `projected ${rupeesShort(over * plan.overageRate)} beyond the allowance` : 'no overage projected'}{draft ? ` · this month so far ${rupeesShort(draft.subtotal)} before GST` : ''}{held.length ? ' · an invoice is held until its period reconciles' : ''}</>} />,
    );
  }
  if (atLeast(level, 'l2') && extras?.anchors?.enabled) {
    const a = extras.anchors;
    const last = a.batches[0];
    const maxDelay = last ? Math.max(...last.tokens.map((t) => t.delaySeconds)) : undefined;
    const open = a.incidents.some((i) => i.status === 'open');
    tiles.push(
      <Tile key="anchors" icon={<Stamp className="h-4 w-4" aria-hidden />} label="Timestamps" to="/assurance/anchors" tone={open ? 'bad' : maxDelay !== undefined && maxDelay > 15 * 60 ? 'held' : 'ok'}
        value={maxDelay !== undefined ? `${Math.max(1, Math.round(maxDelay / 60))} min` : '—'}
        sub={<>lag on the last batch from {a.authorities.map((x) => x.name.replace(/ \(.*\)$/, '')).join(' and ')} · {n(a.totals.unanchoredTail)} records in the open window · {pct(a.totals.withinTargetPct)} of batches within 15 minutes</>} />,
    );
  }
  if (atLeast(level, 'l3') && extras?.cross) {
    const received = extras.cross.filter((x) => x.direction === 'received');
    const pending = received.filter((x) => x.verification.state === 'pending').length;
    const failed = received.filter((x) => x.verification.state === 'failed').length;
    tiles.push(
      <Tile key="cross" icon={<Handshake className="h-4 w-4" aria-hidden />} label="Counterparty receipts" to="/assurance/counterparties" tone={failed ? 'bad' : pending ? 'held' : 'ok'}
        value={n(received.length)}
        sub={<>received · {n(pending)} to verify · {n(failed)} failed · {n(extras.cross.filter((x) => x.direction === 'issued').length)} issued by you</>} />,
    );
  }
  if (level === 'sovereign' && extras?.deployment) {
    const dep = extras.deployment;
    const ready = dep.cluster.nodes.filter((x) => x.status === 'ready').length;
    const degraded = dep.components.filter((c) => c.status !== 'running').length;
    tiles.push(
      <Tile key="cluster" icon={<Server className="h-4 w-4" aria-hidden />} label="Your cluster" to="/agents/deployment" tone={ready < dep.cluster.nodes.length || degraded ? 'bad' : 'ok'}
        value={`${ready} of ${dep.cluster.nodes.length}`}
        sub={<>nodes ready · {degraded ? `${plural(degraded, 'component')} degraded` : 'every component running'} · HSM {dep.hsm.provider} · {dep.tsa.length} local TSAs · egress {dep.egress.policy === 'deny_all' ? 'denied' : 'managed'}</>} />,
    );
  }
  // below L2 owners see one line about timestamps (PlanUpsell renders nothing for any other role)
  const upsell = access.isOwner && !access.hasLevel('l2') ? <PlanUpsell to="l2" what="Timestamps: every record sealed and timestamped by eMudhra TSA and a global authority within 15 minutes." /> : null;
  // the loading frame only when a tile could be shown to this role at this level (an approver sees none: no flash)
  const anyTile = (ownerAdmin && access.canSee('/billing'))
    || (atLeast(level, 'l2') && access.canSee('/assurance/anchors'))
    || (atLeast(level, 'l3') && access.canSee('/assurance/counterparties'))
    || (level === 'sovereign' && access.canSee('/agents/deployment'));
  if (loading && !extras) return anyTile ? <div className="grid gap-px bg-line border border-line sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[120px]" />)}</div> : null;
  if (error && !extras) return ownerAdmin ? <Banner tone="bad" title="Level evidence could not be loaded">{error.message}</Banner> : null;
  if (!all.length) return upsell;
  return (
    <section aria-labelledby="level-tiles-h">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="level-tiles-h" className="label">{LEVEL_INFO[level].label}</h2>
        <SmartLink to="/assurance/levels" hideWhenBlocked className="hidden sm:inline text-xs text-muted hover:text-fg">What this level proves</SmartLink>
      </div>
      <ul className={cn('grid gap-px bg-line border border-line sm:grid-cols-2', all.length >= 3 && 'xl:grid-cols-4')}>{all}</ul>
      {upsell && <div className="mt-2">{upsell}</div>}
    </section>
  );
}

/* ── The four doors ───────────────────────────────────────── */

const pad2 = (v: number) => String(v).padStart(2, '0');

/** One live figure per door, each linking to that door. The page itself is the Work door's home. */
function FourDoors({ data, queues, orgId, userId, canDecide, now }: { data: TodayData; queues?: Queues; orgId: string; userId?: string; canDecide: boolean; now: number }) {
  const head = data.head;
  // approvals in your groups that you can act on now: not held by a stop, and not one where you gave the first of two approvals
  const firstByMe = new Set((queues?.secondApprovals ?? []).filter((s) => s.first.userId === userId).map((s) => s.approval.id));
  const mineIds = new Set(canDecide ? data.pending.filter((a) => isInGroup(orgId, userId, a.approverGroup) && !heldReason(orgId, a) && !firstByMe.has(a.id)).map((a) => a.id) : []);
  const mine = mineIds.size;
  const access = useScreenAccess();
  // a role that decides nothing and acknowledges nothing (a viewer) sees what is waiting on a person, not on them
  const readOnly = !canDecide && !access.can('alerts.respond');
  const unacked = data.openAlerts.filter((a) => a.status === 'open').length + (queues?.assuranceAlerts.filter((a) => a.status === 'open').length ?? 0);
  const incidents = data.activeIncidents.length;
  // second approvals already counted as one of your approvals are not counted again
  const seconds = (queues?.secondApprovals ?? []).filter((s) => s.canAct && !heldReason(orgId, s.approval) && !mineIds.has(s.approval.id)).length;
  // stop lifts, emergency access and approver samples for a second person; supervised calls sampled 1 in 10
  const reviews = (queues?.reviewsForMe.length ?? 0) + seconds + (queues?.opsForMe.length ?? 0) + (queues?.supervisedSamples.filter((s) => s.canAct).length ?? 0);
  // counterparty receipts and the key ceremony are counted only for the roles that open those screens and act on them
  const verify = access.isStaff && access.canSee('/assurance/counterparties') ? queues?.counterpartyToVerify.length ?? 0 : 0;
  const ceremony = access.isStaff && queues?.keyCeremony ? 1 : 0;
  const waiting = readOnly ? data.pending.length + unacked + incidents : mine + unacked + incidents + reviews + verify + ceremony;
  const active = data.agents.filter((a) => a.status === 'active').length;
  const paused = data.agents.filter((a) => a.status === 'paused' || a.status === 'stopped').length;
  const cp = data.lastCheckpoint;
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const cpVerb = atLeast(useOrgLevel(), 'l2') ? 'signed' : 'sealed';
  const touched = queues?.touchedToday;

  const figures: Record<DoorKey, { to: string; value: ReactNode; sub: ReactNode; aria: string }> = {
    work: readOnly ? {
      to: data.pending.length ? '/approvals' : unacked ? '/alerts' : incidents ? '/incidents' : '/work/not-done',
      value: n(waiting),
      sub: waiting
        ? [data.pending.length ? plural(data.pending.length, 'approval') : null, unacked ? `${plural(unacked, 'alert')} not acknowledged` : null, incidents ? plural(incidents, 'incident') : null].filter(Boolean).join(' · ') + ' waiting on a person'
        : 'Nothing waiting on a person',
      aria: `${n(waiting)} items waiting on a person`,
    } : {
      to: waiting ? (mine ? '/approvals' : reviews ? '/work/reviews' : unacked ? '/alerts' : incidents ? '/incidents' : verify ? '/assurance/counterparties' : '/agents/keys') : '/work/not-done',
      value: n(waiting),
      sub: waiting
        ? [canDecide && mine ? plural(mine, 'approval') : null, reviews ? plural(reviews, 'review') : null, unacked ? `${plural(unacked, 'alert')} to acknowledge` : null, incidents ? plural(incidents, 'incident') : null, verify ? `${plural(verify, 'counterparty receipt')} to verify` : null, ceremony ? 'key ceremony due' : null].filter(Boolean).join(' · ')
        : 'Nothing waiting on you',
      aria: `${n(waiting)} items waiting on you`,
    },
    records: {
      to: '/records',
      value: touched ? n(touched.total) : '—',
      sub: touched ? <>Records touched since midnight · {n(touched.decisions)} decisions</> : 'Counting today’s records',
      aria: `${touched ? n(touched.total) : 'Some'} records touched today`,
    },
    agents: {
      to: '/agents',
      value: n(active),
      sub: <>Active agents · {n(paused)} paused or stopped · {n(data.agents.length)} in all</>,
      aria: `${n(active)} active agents`,
    },
    // a role that cannot open Overview or Chain (an approver) reads the Refusals figure its Assurance card opens
    assurance: !access.canSee('/assurance') && access.canSee('/assurance/refusals') ? {
      to: '/assurance/refusals',
      value: n(data.counts.last24.refuse),
      sub: <>Refused in the last 24 hours · {n(data.counts.prev24.refuse)} the 24 hours before</>,
      aria: `${n(data.counts.last24.refuse)} refused in the last 24 hours`,
    } : {
      to: '/assurance',
      value: head ? <span className="font-mono">{seqLabel(head.seq)}</span> : '—',
      sub: head ? (cp ? <>Chain head · checkpoint {seqLabel(cp.seq)} {cpVerb} {relative(cp.ts, now)}</> : 'Chain head · no checkpoint yet') : 'No receipts yet',
      aria: head ? `Chain head ${seqLabel(head.seq)}${cp ? `, last checkpoint ${seqLabel(cp.seq)} ${relative(cp.ts, now)}` : ''}` : 'No receipts yet',
    },
  };

  return (
    <section aria-labelledby="four-doors-h">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="four-doors-h" className="label">The four doors</h2>
        <span className="hidden sm:inline text-xs text-muted">Every screen sits behind one of these</span>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-px bg-line border border-line">
        {DOORS.filter((d) => doorsFor(access.role, access.level).includes(d)).map((d) => {
          const f = figures[d.key];
          // a door card opens a screen this role and plan can see (an approver's Assurance card opens Refusals)
          const to = access.canSee(f.to) ? f.to : doorHome(d, access.role, access.level);
          return (
            <li key={d.key} className="bg-surface">
              <Link to={to} aria-label={`${d.label} door. ${d.question} ${f.aria}`} className="group flex h-full flex-col gap-3 p-4 sm:p-5 hover:bg-sunken/60">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-subtle num">{pad2(d.number)}</span>
                  <d.icon className="h-4 w-4 text-muted group-hover:text-fg" aria-hidden />
                  <span className="text-sm font-semibold">{d.label}</span>
                  <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-subtle group-hover:text-fg" aria-hidden />
                </div>
                <p className="text-sm text-muted leading-snug">{d.question}</p>
                <div className="mt-auto">
                  <p className="text-2xl font-semibold tracking-tight num" aria-live="polite">{f.value}</p>
                  <p className="mt-1 text-xs text-muted leading-snug">{f.sub}</p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ── Decisions chart ──────────────────────────────────────── */

function DecisionsPanel({ data, className }: { data: TodayData; className?: string }) {
  const peak = useMemo(() => data.byHour.reduce((best, h) => (h.allow + h.ask + h.refuse > best.allow + best.ask + best.refuse ? h : best), data.byHour[0]), [data.byHour]);
  const peakTotal = peak ? peak.allow + peak.ask + peak.refuse : 0;
  const today = data.counts.today;
  return (
    <Panel
      className={className}
      title="Decisions, last 24 hours"
      actions={<Legend items={[{ label: 'Allowed', color: SERIES.allow }, { label: 'Asked a person', color: SERIES.ask }, { label: 'Refused', color: SERIES.refuse }]} />}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Since midnight IST: <span className="num text-fg">{n(today.allow)}</span> allowed · <span className="num text-fg">{n(today.ask)}</span> asked · <span className="num text-fg">{n(today.refuse)}</span> refused
          </span>
          {peakTotal > 0 && <span>Busiest hour ending {timeShort(peak.hour)} · <span className="num">{n(peakTotal)}</span> decisions</span>}
        </div>
      }
    >
      <DecisionBars data={data.byHour} height={240} />
    </Panel>
  );
}

/* ── Waiting for you ──────────────────────────────────────── */

interface OtherItem { id: string; icon: ReactNode; title: string; sub: ReactNode; to: string; dueAt?: string }

function WaitingPanel({ data, queues, now, orgId, userId, hero, readOnly, className }: { data: TodayData; queues?: Queues; now: number; orgId: string; userId?: string; hero?: boolean; readOnly?: boolean; className?: string }) {
  const access = useScreenAccess();
  const items = useMemo(() => {
    const mine = data.pending.filter((a) => isInGroup(orgId, userId, a.approverGroup));
    const others = data.pending.filter((a) => !isInGroup(orgId, userId, a.approverGroup));
    return hero ? [...mine, ...others] : data.pending;
  }, [data.pending, userId, hero, orgId]);
  const other: OtherItem[] = useMemo(() => {
    if (!queues) return [];
    // a read-only role has nothing of its own here; the approvals it can read are listed above
    if (readOnly) return [];
    const icon = (k: string) => (k === 'rulebook_review' ? <BookCheck className="h-3.5 w-3.5" aria-hidden /> : k === 'assessment_signoff' ? <ClipboardCheck className="h-3.5 w-3.5" aria-hidden /> : k === 'erasure_approval' ? <Eraser className="h-3.5 w-3.5" aria-hidden /> : <Gauge className="h-3.5 w-3.5" aria-hidden />);
    return [
      ...queues.secondApprovals.filter((s) => s.canAct && !heldReason(orgId, s.approval)).map((s) => ({ id: `sa_${s.approval.id}`, icon: <Users className="h-3.5 w-3.5" aria-hidden />, title: `Second approval: ${s.approval.headline}`, sub: <>First approved by {userName(s.first.userId)}</>, to: `/approvals/${s.approval.id}`, dueAt: s.approval.expiresAt })),
      ...queues.reviewsForMe.map((r) => ({ id: r.id, icon: icon(r.kind), title: r.title, sub: r.detail, to: r.kind === 'erasure_approval' || r.kind === 'rulebook_review' || r.kind === 'graduation_proposal' ? '/work/reviews' : r.route, dueAt: r.dueAt })),
      ...queues.counterpartyToVerify.map((x) => ({ id: x.id, icon: <Handshake className="h-3.5 w-3.5" aria-hidden />, title: `Verify a receipt from ${x.counterpartyName}`, sub: x.summary || 'Received; not yet verified and bound into your chain', to: '/assurance/counterparties' })),
      // an approver's alerts have their own panel beside this one
      ...queues.assuranceAlerts.filter((a) => a.status === 'open' && !hero).map((a) => ({ id: a.id, icon: <HeartPulse className="h-3.5 w-3.5" aria-hidden />, title: a.title, sub: 'Assurance health alert', to: `/alerts/${a.id}` })),
      ...(queues.keyCeremony ? [{ id: 'ceremony', icon: <KeyRound className="h-3.5 w-3.5" aria-hidden />, title: 'Key ceremony due', sub: <>{queues.keyCeremony.provider} · due <When iso={queues.keyCeremony.dueAt} /></>, to: '/agents/keys' }] : []),
      // a second person for a stop lift, emergency access or an approver sample (src/mock/ops.ts)
      ...queues.opsForMe.map((o) => ({ id: o.id, icon: o.kind === 'stop_lift' ? <OctagonX className="h-3.5 w-3.5" aria-hidden /> : o.kind === 'break_glass' ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <Users className="h-3.5 w-3.5" aria-hidden />, title: o.title, sub: o.detail, to: o.kind === 'stop_lift' || o.kind === 'approver_sample' ? o.route : `/work/reviews?kind=${o.kind}` })),
      // the supervised period's 1-in-10 sampled calls, reviewed after they ran
      ...queues.supervisedSamples.filter((s) => s.canAct).map((s) => ({ id: s.id, icon: <Gauge className="h-3.5 w-3.5" aria-hidden />, title: `Review sampled call #${s.seq}: ${s.agentSlug} on ${s.tool}`, sub: <>Supervised A3 · 1 in 10 calls sampled{s.summary ? ` · ${s.summary}` : ''}</>, to: '/work/reviews?kind=supervised_sample', dueAt: s.endsAt })),
    // only what this role can open: counterparty receipts and the key ceremony stay with owners and admins
    ].filter((o) => (o.id !== 'ceremony' && !o.to.startsWith('/assurance/counterparties')) || access.isStaff).filter((o) => access.canSee(o.to));
  }, [queues, orgId, readOnly, access, hero]);
  const limit = hero ? 6 : 5;
  const shown = items.slice(0, limit);
  const otherShown = other.slice(0, Math.max(2, limit - shown.length));
  const mineCount = data.pending.filter((a) => isInGroup(orgId, userId, a.approverGroup)).length;
  return (
    <Panel
      className={cn(className, hero && 'border-fg/40')}
      kicker={hero ? `${n(mineCount)} for your groups · ${n(data.pending.length)} in all` : readOnly ? 'Read-only' : undefined}
      title={readOnly ? 'Waiting for a person' : 'Waiting for you'}
      flush
      actions={<Link to="/approvals" className="text-sm font-medium hover:underline underline-offset-2">{readOnly ? 'All approvals' : 'Open the inbox'}</Link>}
    >
      {shown.length === 0 && otherShown.length === 0 ? (
        <div className="px-5 py-8">
          <p className="font-medium">{readOnly ? 'Nothing is waiting for a person.' : 'Nothing is waiting for you.'}</p>
          <p className="mt-1 text-sm text-muted">Agents are running inside their rulebooks. Anything that needs a person will appear here.</p>
        </div>
      ) : (
        <>
          {shown.length > 0 && (
            <ul className={cn('divide-y divide-line', hero && 'md:grid md:grid-cols-2 md:divide-y-0 md:gap-px md:bg-line')}>
              {shown.map((a) => <WaitingRow key={a.id} a={a} now={now} mine={isInGroup(orgId, userId, a.approverGroup)} held={!!heldReason(orgId, a)} hero={hero} />)}
            </ul>
          )}
          {items.length > shown.length && (
            <Link to="/approvals" className="block border-t border-line px-5 py-2.5 text-sm text-muted hover:text-fg">+{n(items.length - shown.length)} more approvals waiting</Link>
          )}
          {otherShown.length > 0 && (
            <>
              <p className="label px-5 pt-3 pb-1 border-t border-line">Also for you</p>
              <ul className="divide-y divide-line">
                {otherShown.map((o) => (
                  <li key={o.id}>
                    <Link to={o.to} className="flex items-start gap-3 px-5 py-2.5 hover:bg-sunken/60">
                      <span className="mt-0.5 text-muted">{o.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium leading-snug line-clamp-2">{o.title}</span>
                        <span className="block text-xs text-muted line-clamp-1">{o.sub}</span>
                      </span>
                      {o.dueAt && <span className="shrink-0 text-xs text-muted num">{countdown(o.dueAt, now)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
              {other.length > otherShown.length && <Link to="/work/reviews" className="block border-t border-line px-5 py-2.5 text-sm text-muted hover:text-fg">+{n(other.length - otherShown.length)} more in Reviews</Link>}
            </>
          )}
        </>
      )}
    </Panel>
  );
}

function WaitingRow({ a, now, mine, held, hero }: { a: Approval; now: number; mine: boolean; held: boolean; hero?: boolean }) {
  const left = new Date(a.expiresAt).getTime() - now;
  const urgent = left <= 3.6e6;
  return (
    <li className="bg-surface">
      <Link to={`/approvals/${a.id}`} className={cn('block px-5 hover:bg-sunken/60', hero ? 'py-4' : 'py-3')}>
        <div className="flex items-start justify-between gap-3">
          <p className={cn('font-medium leading-snug min-w-0', hero ? 'text-md' : 'text-sm')}>{a.headline}</p>
          {a.amount !== undefined && <Money value={a.amount} className={cn('shrink-0 font-semibold', hero ? 'text-md' : 'text-sm')} />}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <AgentLink slug={a.agentSlug} plain className="font-normal" />
          <span className="font-mono">{a.ruleId}</span>
          <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" aria-hidden />{a.approverGroup}</span>
          {mine && <Badge tone="info">Your group</Badge>}
          {held && <Badge tone="bad" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Held by the stop</Badge>}
          <span className={cn('ml-auto inline-flex items-center gap-1 num', urgent && 'text-held-fg font-medium')}>
            <Clock3 className="h-3 w-3" aria-hidden />{left <= 0 ? 'Expiring now' : `${countdown(a.expiresAt, now)} left`}
          </span>
        </div>
      </Link>
    </li>
  );
}

/* ── Alerts (an approver's Today) ─────────────────────────── */

const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** The alerts an approver acknowledges and resolves: open ones first, then by severity and age. */
function AlertsPanel({ data, queues, now, className }: { data: TodayData; queues?: Queues; now: number; className?: string }) {
  const list = useMemo(() => {
    const all: { id: string; title: string; severity: 'high' | 'medium' | 'low'; status: string; createdAt: string; who: string }[] = [
      ...data.openAlerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, createdAt: a.createdAt, who: a.agentSlug })),
      ...(queues?.assuranceAlerts ?? []).map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, createdAt: a.createdAt, who: 'Assurance' })),
    ];
    return all.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.createdAt.localeCompare(a.createdAt));
  }, [data.openAlerts, queues]);
  const open = list.filter((a) => a.status === 'open').length;
  const shown = list.slice(0, 6);
  return (
    <Panel
      className={className}
      title="Alerts"
      kicker={list.length ? `${n(open)} to acknowledge · ${n(list.length)} open` : undefined}
      flush
      actions={<Link to="/alerts" className="text-sm font-medium hover:underline underline-offset-2">All alerts</Link>}
    >
      {shown.length === 0 ? (
        <div className="px-5 py-8">
          <p className="font-medium">No open alerts.</p>
          <p className="mt-1 text-sm text-muted">An alert appears here when an agent behaves outside its usual pattern.</p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {shown.map((a) => (
              <li key={a.id}>
                <Link to={`/alerts/${a.id}`} className="flex items-start gap-3 px-5 py-2.5 hover:bg-sunken/60">
                  <Siren className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', a.severity === 'high' ? 'text-bad-fg' : 'text-muted')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-snug line-clamp-2">{a.title}</span>
                    <span className="block text-xs text-muted line-clamp-1">{a.who} · {a.severity} · {a.status === 'open' ? 'not acknowledged' : 'acknowledged'}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted num">{relative(a.createdAt, now)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {list.length > shown.length && <Link to="/alerts" className="block border-t border-line px-5 py-2.5 text-sm text-muted hover:text-fg">+{n(list.length - shown.length)} more alerts</Link>}
        </>
      )}
    </Panel>
  );
}

/* ── Agents ───────────────────────────────────────────────── */

function MixBar({ allow, ask, refuse }: { allow: number; ask: number; refuse: number }) {
  const total = allow + ask + refuse;
  const w = (v: number) => (total ? `${(v / total) * 100}%` : '0%');
  return (
    <div className="flex h-1.5 w-full bg-sunken overflow-hidden" role="img" aria-label={`${n(allow)} allowed, ${n(ask)} asked a person, ${n(refuse)} refused in 7 days`}>
      <span className="h-full bg-ok" style={{ width: w(allow) }} />
      <span className="h-full bg-held" style={{ width: w(ask) }} />
      <span className="h-full bg-bad" style={{ width: w(refuse) }} />
    </div>
  );
}

type Grants = NonNullable<Extras['grants']>;

/** The agent's autonomy across its write types (reads run at every level): the levels in force, and how many have none. */
function autonomyOf(slug: string, grants?: Grants) {
  const rows = grants?.rows.filter((r) => r.agentSlug === slug && !isReadOnly(r.tags)) ?? [];
  if (!rows.length) return undefined;
  const none = rows.filter((r) => !r.grant).length;
  const levels = rows.filter((r) => r.grant).map((r) => r.level).sort();
  const lo = levels[0];
  const hi = levels[levels.length - 1];
  const label = !levels.length ? grants!.noGrantLabel : lo === hi ? rows.find((r) => r.level === lo && r.grant)!.label : `${lo}–${hi}`;
  return { label, none, tools: rows.length, graduated: rows.filter((r) => r.graduated).length };
}

function AgentsPanel({ agents, grants, level, className }: { agents: Agent[]; grants?: Grants; level: LevelId; className?: string }) {
  const sorted = useMemo(() => agents.slice().sort((a, b) => b.stats.calls7d - a.stats.calls7d), [agents]);
  const l3 = atLeast(level, 'l3');
  return (
    <Panel
      className={className}
      title="Agents"
      flush
      actions={<Link to={l3 ? '/agents/autonomy' : '/agents'} className="text-sm font-medium hover:underline underline-offset-2">{l3 ? 'Autonomy' : 'All agents'}</Link>}
      footer={<span>Bars show allowed, asked a person and refused over 7 days.{l3 ? ' Autonomy: every write type starts at A2 Propose and reaches A3 only by a two-person graduation.' : ''}</span>}
    >
      {sorted.length === 0 ? (
        <div className="px-5 py-8">
          <p className="font-medium">No agents yet.</p>
          <IfCan perm="agents.manage" fallback={<p className="mt-1 text-sm text-muted">An owner or admin adds agents. Each gets a key, a route and a rulebook.</p>}>
            <p className="mt-1 text-sm text-muted">Add an agent to give it a key, a route and a rulebook.</p>
            <Link to="/agents/new" className="mt-3 inline-block text-sm font-medium underline underline-offset-2">Add an agent</Link>
          </IfCan>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {sorted.map((a) => {
            const s = a.stats;
            const refusal = s.calls7d ? s.refused7d / s.calls7d : 0;
            const auto = l3 ? autonomyOf(a.slug, grants) : undefined;
            return (
              <li key={a.id} className="grid gap-x-6 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_220px] items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <AgentLink slug={a.slug} />
                    <AgentStatus agent={a} />
                    <RouteMode route={a.route} compact />
                    {auto && (
                      <Link to={`/agents/autonomy?agent=${a.slug}`} title={`${auto.tools} write types${auto.none ? `, ${auto.none} with no level` : ''} · ${auto.graduated} graduated to A3`}>
                        <StatusChip tone={auto.none === auto.tools ? 'neutral' : 'info'} size="sm" icon={<Gauge className="h-3 w-3" aria-hidden />}>{auto.label}{auto.none && auto.none < auto.tools ? ` · ${auto.none} no grant` : ''}</StatusChip>
                      </Link>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted truncate">{a.name} · owner {userName(a.ownerId)}</p>
                </div>
                <div>
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                    <span className="num"><span className="font-medium text-fg">{n(s.calls7d)}</span> <span className="text-muted">calls · 7 d</span></span>
                    <span className={cn('num', refusal >= 0.1 ? 'text-bad-fg font-medium' : 'text-muted')}>{pct(refusal, 1)} refused</span>
                  </div>
                  <MixBar allow={s.allowed7d} ask={s.asked7d} refuse={s.refused7d} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ── Chain ────────────────────────────────────────────────── */

function ChainPanel({ data, level, extras, className }: { data: TodayData; level: LevelId; extras?: Extras; className?: string }) {
  const nav = useNavigate();
  const integrity = useIntegrity();
  const cp = data.lastCheckpoint;
  const head = data.head;
  const l2 = atLeast(level, 'l2');
  const batch = extras?.anchors?.batches[0];
  const boundary = extras?.state?.boundaries.find((b) => b.to === 'l2' || (b.from === 'l1' && b.to !== 'l1'));
  const items: { k: ReactNode; v: ReactNode }[] = head ? [
    { k: 'Head receipt', v: <ReceiptLink seq={head.seq} /> },
    { k: 'Head hash', v: <Hash value={head.hash} len={14} /> },
    { k: 'Last checkpoint', v: cp ? <span className="num">{seqLabel(cp.seq)} · {relative(cp.ts)}</span> : <span className="text-muted">None yet</span> },
    { k: 'Behind the checkpoint', v: cp ? <span className="num">{n(Math.max(0, head.seq - cp.seq))} receipts</span> : '—' },
    { k: 'Signing key', v: <span className="font-mono text-[12px] break-all">{head.kid}</span> },
  ] : [];
  if (l2 && extras) {
    if (batch) {
      items.push({ k: 'Last Merkle batch', v: <Link to="/assurance/anchors" className="hover:underline"><span className="num">{seqLabel(batch.firstSeq)}–{seqLabel(batch.lastSeq)}</span> · <Hash value={batch.root} len={10} copy={false} /></Link> });
      for (const t of batch.tokens) items.push({ k: t.tsaName.replace(/ \(.*\)$/, ''), v: <span className="num">{timeShort(t.genTime)} · {Math.max(1, Math.round(t.delaySeconds / 60))} min{t.status === 'granted_late' ? ' · late' : ''}</span> });
    }
    if (extras.custody) items.push({ k: 'Key custody', v: <span className="text-sm">{extras.custody.provider} · {extras.custody.residencyDomain}{extras.custody.alias ? <span className="block font-mono text-[11px] text-muted break-all">{extras.custody.alias}</span> : null}</span> });
    if (extras.deployment) items.push({ k: 'Write-once storage', v: <span className="text-sm">{extras.deployment.storage.backend} · {extras.deployment.storage.objectLock} mode · {extras.deployment.storage.retentionYears} years</span> });
    if (boundary) items.push({ k: 'L1 → L2 boundary', v: boundary.beforeWindow ? <span className="text-sm text-muted">Before this window · every record here is sealed</span> : <span className="text-sm"><ReceiptLink seq={boundary.firstSeq} /> · {n(boundary.recordsBefore)} before, {n(boundary.recordsAfter)} after</span> });
  }
  if (level === 'sovereign' && extras?.deployment) {
    const dep = extras.deployment;
    items.push({ k: 'Cluster', v: <span className="text-sm">{dep.cluster.nodes.filter((x) => x.status === 'ready').length} of {dep.cluster.nodes.length} nodes ready · {dep.cluster.distribution}</span> });
    items.push({ k: 'HSM', v: <span className="text-sm">{dep.hsm.provider} {dep.hsm.model} · {dep.hsm.fips}</span> });
    items.push({ k: 'Local TSAs', v: <span className="text-sm">{dep.tsa.map((t) => `${t.name.replace(/ \(.*\)$/, '')} ${t.status === 'operational' ? 'up' : 'degraded'}`).join(' · ')}</span> });
    const lastApplied = dep.updates.find((u) => u.status === 'applied');
    if (lastApplied) items.push({ k: 'Last update bundle', v: <span className="text-sm">{lastApplied.version} · signature verified · applied <When iso={lastApplied.appliedAt} /></span> });
  }
  return (
    <Panel
      className={className}
      title="Chain"
      kicker={LEVEL_INFO[level].label}
      footer={
        <div className="space-y-2">
          <p className="text-xs">{claimFor(level)}.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />} onClick={() => nav('/evidence')}>Proof</Button>
            <Button size="sm" variant="secondary" icon={<BadgeCheck className="h-3.5 w-3.5" aria-hidden />} onClick={() => nav('/verify')}>Verify a pack</Button>
            {l2 && <Button size="sm" variant="ghost" icon={<Stamp className="h-3.5 w-3.5" aria-hidden />} onClick={() => nav('/assurance/anchors')}>Timestamps</Button>}
          </div>
        </div>
      }
    >
      {head ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted">
            {/* never "continuous" over a range the integrity runs have not reached (features/evidence/ContinuityLine) */}
            <ContinuityLine headSeq={head.seq} report={integrity.data} />
            {cp && <span>Last {l2 ? 'signed' : 'sealed'} checkpoint {relative(cp.ts)}</span>}
          </div>
          <KeyValue className="mt-4" items={items} />
          <PlanUpsell to="l2" what="Seals, two timestamps and KMS custody start at Attested." className="mt-3" />
        </>
      ) : (
        <p className="text-sm text-muted">No receipts yet. The chain starts with the first decision.</p>
      )}
    </Panel>
  );
}

/* ── Coverage ─────────────────────────────────────────────── */

function CoveragePanel({ data, className }: { data: TodayData; className?: string }) {
  const orgId = useOrgId();
  // the same computation as /compliance (live evidence, the level's controls and mappings), not the stored share
  const fws = useMemo(() => {
    const cov = frameworkCoverage(orgId, data.frameworks);
    return data.frameworks.map((f) => ({ ...f, coverage: cov[f.id]?.share ?? 0 }));
  }, [orgId, data.frameworks]);
  const avg = fws.length ? fws.reduce((s, f) => s + f.coverage, 0) / fws.length : 0;
  return (
    <Panel
      className={className}
      title="Coverage"
      actions={<LegalDraft />}
      footer={<span>Coverage is a count of receipts, not a test that a control works.</span>}
    >
      {fws.length === 0 ? (
        <div>
          <p className="font-medium">No frameworks enabled.</p>
          <p className="mt-1 text-sm text-muted">Enable a framework to map receipts to its requirements.</p>
          <Link to="/compliance" className="mt-3 inline-block text-sm font-medium underline underline-offset-2">Open coverage</Link>
        </div>
      ) : (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="flex flex-col items-center shrink-0">
            <ProgressArc value={avg} size={84} label={`Average coverage ${pct(avg)}`} />
            <p className="mt-1.5 text-xs text-muted">Mean of {fws.length}</p>
          </div>
          <ul className="flex-1 min-w-0 space-y-3">
            {fws.map((f) => (
              <li key={f.id}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <Link to={`/compliance/${f.id}`} className="min-w-0 truncate font-medium hover:underline underline-offset-2" title={f.name}>{f.short}</Link>
                  <span className="num text-muted">{pct(f.coverage)}</span>
                </div>
                <Meter value={f.coverage} label={`${f.name} coverage`} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

/* ── Suggestions and graduation proposals ─────────────────── */

type Proposals = NonNullable<Extras['proposals']>;

function SuggestionsPanel({ data, proposals, level, className }: { data: TodayData; proposals?: Proposals; level: LevelId; className?: string }) {
  // graduation proposals are decided by owners and admins; everyone else reads them
  const decides = useScreenAccess().isStaff;
  const open = (proposals ?? []).filter((p) => p.status === 'open');
  const items = data.suggestions.slice(0, open.length ? 2 : 4);
  const slugFor = (rulebookId: string) => data.agents.find((a) => a.rulebookId === rulebookId)?.slug;
  return (
    <Panel
      className={className}
      title="Suggestions"
      flush
      actions={<Link to="/rulebooks/suggestions" className="text-sm font-medium hover:underline underline-offset-2">All suggestions</Link>}
      footer={<span>Numbers only, never a recommendation. A suggestion never publishes itself, and a graduation needs two different people.</span>}
    >
      {items.length === 0 && open.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">No rule suggestions{atLeast(level, 'l3') ? ' or graduation proposals' : ''}. They appear when people keep approving the same kind of call.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((s) => {
            const slug = slugFor(s.rulebookId);
            return (
              <li key={s.id} className="px-5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <Link to="/rulebooks/suggestions" className="text-sm font-medium leading-snug hover:underline underline-offset-2 inline-flex gap-2">
                    <Lightbulb className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted" aria-hidden />
                    {s.title}
                  </Link>
                  <Badge tone={s.status === 'drafted' ? 'info' : 'neutral'}>{s.status === 'drafted' ? 'Drafted' : 'Rule'}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted num" style={{ paddingLeft: 22 }}>
                  {n(s.evidence.approvals)} approvals in {n(s.evidence.days)} days · {n(s.evidence.counterparties)} counterparties · {n(s.evidence.rejections)} rejections
                  {slug && <> · <Link to={`/rulebooks/${slug}`} className="underline underline-offset-2 hover:text-fg">{slug} rulebook</Link></>}
                </p>
              </li>
            );
          })}
          {open.slice(0, 3).map((p) => (
            <li key={p.id} className="px-5 py-3">
              <div className="flex items-start justify-between gap-3">
                <Link to={`/agents/autonomy?proposal=${p.id}`} className="text-sm font-medium leading-snug hover:underline underline-offset-2 inline-flex gap-2">
                  <Gauge className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted" aria-hidden />
                  {p.agentSlug}: {p.tool} {p.from} → {p.to}
                </Link>
                <Badge tone="info">Autonomy</Badge>
              </div>
              <p className="mt-1 text-xs text-muted num" style={{ paddingLeft: 22 }}>
                {n(p.evidence.days)} days · {n(p.evidence.records)} records · {n(p.evidence.approvals)} approvals · {n(p.evidence.rejections)} rejections · proposed by {userName(p.proposedBy ?? p.decisions[0]?.userId)}; a different owner or admin approves{decides && <> · <Link to="/work/reviews?kind=graduation_proposal" className="underline underline-offset-2 hover:text-fg">decide</Link></>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ── Loading ──────────────────────────────────────────────── */

function TodaySkeleton(): ReactNode {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading today">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-surface border border-line p-5 space-y-3"><Skeleton className="h-3 w-24" /><Skeleton className="h-8 w-20" /><Skeleton className="h-3 w-32" /></div>
        ))}
      </div>
      <Skeleton className="h-[148px]" />
      <div className="grid gap-6 lg:grid-cols-12">
        <Skeleton className="h-[340px] lg:col-span-8" />
        <Skeleton className="h-[340px] lg:col-span-4" />
        <Skeleton className="h-[300px] lg:col-span-7" />
        <Skeleton className="h-[300px] lg:col-span-5" />
      </div>
    </div>
  );
}
