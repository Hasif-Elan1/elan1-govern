import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookCheck, Boxes, Check, CircleHelp, Clock3, Phone, Shuffle, Users, X, Lock, Waypoints, Link2, ShieldCheck, Stamp, Gauge, Handshake, TimerReset, Pencil, OctagonX, FilePlus2, Radar } from 'lucide-react';
import { api } from '@/api';
import type { Agent, Approval, Channel, Receipt } from '@/types';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { useUi } from '@/store/ui';
import { ROLE_INFO } from '@/lib/permissions';
import { userName } from '@/mock/users';
import { atLeast } from '@/lib/levels';
import { channelLabel, countdown, dateTime, n, rupees, seqLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ApprovalChip, Badge, Banner, Button, CopyButton, Hash, InlineCode, Kbd, Meter, Select, Skeleton, StatusChip, Switch, Textarea, toast } from '@/components/ui';import { AgentLink, ArgsTable, Money, Person, ReceiptLink, RouteMode, Section, TagList, When } from '@/components/domain';
import { DecisionForm, type DecisionMode } from './DecisionForm';
import { ApprovalOutbox } from './ApprovalOutbox';
import { LINK_CHANNELS, approverGroup, heldReason, needsCallBack, preciseCountdown, windowElapsed } from './lib';
import { firstApprovalOf, linksFor, mayDecide, needsTwo, ruleEscalation, twoPersonPolicy, twoPersonReason } from '@/features/work/backend';
import { UpgradePath } from '@/features/work/level';
import { SmartLink } from '@/shell/access';
import { blastRadius, ruleDraftOf, sameActorBlocks } from '@/mock/approvalsExt';
import { chatBlocker, chatButtonsFor } from '@/mock/approvalNotify';
import { consoleHost } from '@/features/settings/orgApi';
import { checkResults, checkSummary, draftRuleFromApproval, payloadDigest } from './decide';
import { BlastRadiusSection, ChecksSection, DelegateBanner, DiffSection, DigestLine, OutcomeBlock, RecordedDigest, SameActorBanner } from './DecidePanels';

type Detail = Awaited<ReturnType<typeof api.approval>>;
type Done = { approve: boolean; partial: boolean; receipt: Receipt };

export function ApprovalDetail({ id, mode, setMode, onNext, backHref, hasNext }: {
  id: string;
  mode: DecisionMode;
  setMode: (m: DecisionMode) => void;
  onNext: () => void;
  backHref: string;
  hasNext: boolean;
}) {
  const { data, loading, error } = useQuery((o) => api.approval(o, id), [id]);
  const [done, setDone] = useState<Done>();

  if (error) {
    return (
      <div className="p-5">
        <BackLink to={backHref} />
        <Banner tone="bad" title="This approval could not be opened">{error.message}</Banner>
      </div>
    );
  }
  if (loading || !data || data.approval.id !== id) return <DetailSkeleton backHref={backHref} />;
  return <DetailBody data={data} mode={mode} setMode={setMode} onNext={onNext} backHref={backHref} hasNext={hasNext} done={done} setDone={setDone} />;
}

function BackLink({ to }: { to: string }) {
  return (
    <Link to={to} className="lg:hidden mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft className="h-4 w-4" aria-hidden /> All approvals
    </Link>
  );
}

function DetailSkeleton({ backHref }: { backHref: string }) {
  return (
    <div className="p-5 lg:p-6 space-y-5" aria-busy="true" aria-label="Loading approval">
      <BackLink to={backHref} />
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-8 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}

function DetailBody({ data, mode, setMode, onNext, backHref, hasNext, done, setDone }: {
  data: Detail; mode: DecisionMode; setMode: (m: DecisionMode) => void; onNext: () => void; backHref: string; hasNext: boolean;
  done?: Done; setDone: (d: Done) => void;
}) {
  const { approval: a, agent, history, receipts } = data;
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canDecideRole = useCan('approvals.decide');
  const canReroute = useCan('approvals.reroute');
  const openAsk = useUi((s) => s.openAsk);
  const now = useNow(1000);
  const pending = a.status === 'pending';
  const expiredNow = pending && new Date(a.expiresAt).getTime() <= now;
  const who = mayDecide(orgId, a, user?.id);
  const two = needsTwo(orgId, a);
  const first = firstApprovalOf(orgId, a.id);
  const firstIsMe = !!first && first.userId === user?.id;
  // an emergency stop holds waiting approvals: nobody can decide them until it is lifted (expiry still runs)
  const held = heldReason(orgId, a);
  const decidable = pending && !held && !expiredNow && canDecideRole && who.ok;
  // same-person rule in forbid mode: the agent's owner may reject but not approve
  const forbidSelf = sameActorBlocks(orgId, a, user?.id);
  const approvable = decidable && !(two && firstIsMe) && !forbidSelf;
  const selfApproval = !!agent && !!user && agent.ownerId === user.id;
  const nav = useNavigate();
  const canDraft = useCan('rulebooks.edit');
  const [draftRule, setDraftRule] = useState(false);
  const digest = useMemo(() => payloadDigest(orgId, a), [orgId, a]);
  const checks = useMemo(() => checkSummary(checkResults(orgId, a)), [orgId, a]);
  const br = blastRadius(a);
  const twoWhy = twoPersonReason(orgId, a);
  const drafted = ruleDraftOf(orgId, a.id);
  useEffect(() => { if (!mode) setDraftRule(false); }, [mode]);
  const onDecided = async (r: { approve: boolean; partial: boolean; receipt: Receipt }) => {
    setMode(null);
    setDone({ approve: r.approve, partial: r.partial, receipt: r.receipt });
    if (!(draftRule && r.approve && user)) return;
    try {
      const res = await draftRuleFromApproval(orgId, a, user.id);
      toast.ok(`Draft rule ${res.ruleId} opened in v${res.version}`, 'Nothing is live yet. Test it on past actions, then a person publishes it.');
      nav(`/rulebooks/${res.slug}?tab=rules`);
    } catch (e) {
      toast.bad('Approved, but the draft rule was not opened', (e as Error).message);
    }
  };
  const enforced = agent?.route === 'mcp';
  const holdReceipt = receipts.find((r) => r.seq === a.seq);
  const resultReceipt = receipts.find((r) => r.seq === a.resultSeq);
  const noDecideWhy = held ? 'Held by the emergency stop. Lift the stop to decide it.' : !canDecideRole ? 'Your role cannot decide approvals' : !who.ok ? who.why : expiredNow ? 'This approval has expired' : undefined;
  const stopIncident = a.heldByStop?.incidentId;

  // a decision form can only be open while the item is decidable
  useEffect(() => {
    if (mode && (!decidable || (mode === 'approve' && !approvable))) setMode(null);
  }, [mode, decidable, approvable, setMode]);

  const explain = () => openAsk({ kind: 'approval', title: a.headline, payload: a });

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex-1 min-h-0 lg:overflow-y-auto">
        <div className="p-5 lg:p-6">
          <BackLink to={backHref} />

          <header>
            <div className="flex flex-wrap items-center gap-2">
              <ApprovalChip status={expiredNow ? 'expired' : a.status} />
              {pending && first && <Badge tone="held" icon={<Users className="h-3 w-3" aria-hidden />}>1 of 2 approvals</Badge>}
              {held && <Badge tone="bad" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Held by the stop</Badge>}
              <Badge tone={br.dualControl ? 'held' : 'neutral'} title={br.why}>Blast radius: {br.label.toLowerCase()}</Badge>
              <Badge icon={<Radar className="h-3 w-3" aria-hidden />}>{checks.text}</Badge>
              <span className="font-mono text-xs text-subtle">{a.id}</span>
              <span className="text-xs text-muted">Held <When iso={a.createdAt} /></span>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="secondary" icon={<CircleHelp className="h-3.5 w-3.5" aria-hidden />} onClick={explain}>Explain</Button>
              </div>
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tighter2 leading-snug">{a.headline}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <AgentLink slug={a.agentSlug} />
              {agent && <RouteMode route={agent.route} />}
              <span className="font-mono text-[12.5px] text-muted break-all">{a.tool}</span>
              {a.counterparty && <span className="text-muted">Counterparty <span className="text-fg font-medium">{a.counterparty}</span></span>}
            </div>
            {a.amount !== undefined && (
              <p className="mt-4 font-display text-4xl font-semibold tracking-tighter2"><Money value={a.amount} /></p>
            )}
          </header>

          {done && (
            <Banner
              className="mt-5"
              tone={done.partial ? 'held' : done.approve ? 'ok' : 'neutral'}
              title={done.partial ? 'First approval recorded — waiting for a second approver' : done.approve ? (enforced ? 'Approved — the call ran' : 'Approved — the agent may run the call') : 'Rejected — the call did not run'}
              actions={hasNext ? <Button size="sm" variant="secondary" iconRight={<ArrowRight className="h-3.5 w-3.5" aria-hidden />} onClick={onNext}>Next waiting</Button> : undefined}
            >
              {done.partial ? <>Your approval is receipt <ReceiptLink seq={done.receipt.seq} />. A different member of {a.approverGroup} gives the second approval; it is in Work › Reviews for them.</> : <>Your decision is recorded as receipt <ReceiptLink seq={done.receipt.seq} />, hash-chained to the hold at <ReceiptLink seq={a.seq} />.</>}
              {done.approve && !done.partial && a.status === 'approved' && <OutcomeBlock a={a} route={agent?.route} compact />}
            </Banner>
          )}

          {pending && forbidSelf && !done && <SameActorBanner a={a} />}

          {pending && who.delegateFor && canDecideRole && !done && <DelegateBanner from={who.delegateFor} />}

          {drafted && (
            <Banner className="mt-5" tone="neutral" title={`A draft rule was opened from this approval: ${drafted.rule}`}
              actions={<Link to={`/rulebooks/${drafted.rulebook}?tab=rules`} className="inline-flex items-center gap-1 h-8 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">Open the draft <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
              By {userName(drafted.by)} <When iso={drafted.at} /> in the {drafted.rulebook} rulebook, draft v{drafted.version} · <ReceiptLink seq={drafted.seq} />. Nothing is live until a person publishes it.
            </Banner>
          )}

          {held && !done && (
            <Banner
              className="mt-5"
              tone="held"
              title="Nobody can decide this until the stop is lifted"
              actions={stopIncident ? <Link to={`/incidents/${stopIncident}`} className="inline-flex items-center gap-1 h-8 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">Open the incident <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link> : <Link to="/incidents" className="inline-flex items-center gap-1 h-8 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">Incidents <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}
            >
              {held}
            </Banner>
          )}

          {pending && two && first && !done && (
            <Banner className="mt-5" tone="held" title={`Approved by ${userName(first.userId)} — waiting for a second approver${firstIsMe ? ' (not you)' : ''}`}>
              {twoWhy === 'scope' ? `A call whose blast radius is “${br.label.toLowerCase()}” needs two different people.` : `Payments of ${rupees(twoPersonPolicy(orgId).above)} or more need two different people.`} The first approval is receipt <ReceiptLink seq={first.seq} />{first.reason ? <> with the note “{first.reason}”</> : null}.
            </Banner>
          )}

          {pending && who.ownerOverride && canDecideRole && (
            <Banner className="mt-5" tone="held" title={`You are not in ${a.approverGroup}`}>
              As an owner you can still decide. The receipt records that an owner decided outside the approver group. Re-routing to a group that should decide is usually better.
            </Banner>
          )}

          {pending && selfApproval && !forbidSelf && (
            <Banner className="mt-5" tone="held" title="You own this agent — your approval will be flagged">
              You set up {a.agentSlug}. If you approve, the receipt records that you approved your own agent's action. Consider re-routing to someone else in {a.approverGroup}.
            </Banner>
          )}

          {pending && needsCallBack(a) && (
            <div className="mt-5 flex items-start gap-3 border border-held/50 border-l-[3px] border-l-held bg-held-bg px-4 py-3 text-sm">
              <Phone className="h-4 w-4 mt-0.5 text-held-fg shrink-0" aria-hidden />
              <p><span className="font-semibold text-held-fg">Confirm by phone with a contact you already hold.</span> <span className="text-fg/80">Do not use a number or address from the request itself — bank-detail changes and payments are the most common fraud route.</span></p>
            </div>
          )}

          <div className="mt-6 grid gap-x-8 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0">
              <Section title="Why it was held">
                <p className="text-sm">
                  Rule <InlineCode>{a.ruleId}</InlineCode> in the <Link to={`/rulebooks/${a.agentSlug}`} className="underline underline-offset-2 hover:text-accent-fg">{a.agentSlug} rulebook</Link>
                  {holdReceipt?.rulebook && <span className="text-muted"> · version {holdReceipt.rulebook.version}</span>} said ask a person.
                </p>
                <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-md leading-relaxed">“{a.ruleReason}”</blockquote>
                {a.triggeredBy && (
                  <p className="mt-2 text-sm text-muted">Triggered because <span className="text-fg font-medium">{a.triggeredBy}</span>.</p>
                )}
              </Section>

              <DiffSection a={a} />

              <ChecksSection a={a} />

              <Section title={canDecideRole ? 'What happens if you approve' : 'What happens on approval'}>
                {a.effect && <p className="text-md leading-relaxed">{a.effect}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <Badge icon={<Waypoints className="h-3 w-3" aria-hidden />}>{a.connector}</Badge>
                  {agent && <RouteMode route={agent.route} compact />}
                  {two && <Badge tone="held" icon={<Users className="h-3 w-3" aria-hidden />}>Two approvers</Badge>}
                </div>
                <p className="mt-2 text-sm text-muted leading-relaxed">
                  {enforced
                    ? <>Governed run: Elan1 Govern holds the credential and <span className="text-fg">runs the call immediately on {two ? 'the second' : ''} approval</span>. If you reject, or nobody decides before expiry, the call cannot run.</>
                    : <>Check and record: Elan1 Govern advises and records; <span className="text-fg">on approval the agent runs the call itself</span> with its own credentials and reports the outcome.</>}
                  {two && <> {twoWhy === 'scope' ? 'Its blast radius needs' : 'This amount needs'} two different approvers: the first approval is recorded and the call keeps waiting until a second person approves.</>}
                </p>
              </Section>

              <BlastRadiusSection a={a} />

              <Section title="Arguments" aside={a.status === 'expired' ? <span className="text-xs text-muted">Wiped on expiry</span> : undefined}>
                {Object.keys(a.args).length ? <ArgsTable args={a.args} /> : <p className="text-sm text-muted">No arguments are held for this approval.</p>}
              </Section>

              <Section title="Risk tags">
                <TagList tags={a.riskTags} max={8} />
              </Section>

              <Section title="Similar decisions under this rule" aside={<span className="text-xs text-muted">Last 30 days · numbers, not a recommendation</span>}>
                <div className="grid grid-cols-3 gap-px bg-line border border-line">
                  {([['Approved', a.similar.approved], ['Rejected', a.similar.rejected], ['Reversed', a.similar.reversed]] as const).map(([k, v]) => (
                    <div key={k} className="bg-surface px-3 py-2.5">
                      <p className="label">{k}</p>
                      <p className="mt-1 font-display text-2xl font-semibold num">{n(v)}</p>
                    </div>
                  ))}
                </div>
                {history.length > 0 ? (
                  <ul className="mt-3 divide-y divide-line border border-line">
                    {history.map((h) => <HistoryRow key={h.id} h={h} />)}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-muted">No earlier decisions under <span className="font-mono">{a.ruleId}</span> yet.</p>
                )}
              </Section>
            </div>

            <aside className="min-w-0 xl:border-l xl:border-line xl:pl-6">
              <Section title="Expiry">
                {pending ? (
                  <>
                    <p className={cn('font-display text-2xl font-semibold num', windowElapsed(a, now) > 0.85 && 'text-held-fg')} aria-live="off">
                      {preciseCountdown(a.expiresAt, now)}
                    </p>
                    <Meter className="mt-2" value={1 - windowElapsed(a, now)} tone={windowElapsed(a, now) > 0.85 ? 'held' : 'inverse'} label="Time left before this approval expires" />
                    <p className="mt-2 text-xs text-muted">Expires {dateTime(a.expiresAt)}. Expiry is a refusal; nothing runs.</p>
                    {/* only roles that decide approvals see the extension; a rule that blocks this case (the stop, another group) keeps it disabled with its reason */}
                    {!expiredNow && (canDecideRole || !!a.extension) && <Extension a={a} canExtend={decidable} why={noDecideWhy} />}
                  </>
                ) : (
                  <p className="text-sm text-muted">Was due {dateTime(a.expiresAt)}{a.extension && <> · extended once by {userName(a.extension.by)}</>}</p>
                )}
              </Section>

              <ApproverGroupSection a={a} now={now} canReroute={canReroute} />

              {pending && <LinksSection a={a} held={held} />}

              <Section title="Notified">
                <div className="flex flex-wrap gap-1.5">
                  {a.notified.map((c) => <Badge key={c}>{channelLabel[c] ?? c}</Badge>)}
                </div>
                <p className="mt-2 text-xs text-muted">{a.approveInChat ? 'This rule lets a person decide from a chat link.' : 'This rule does not allow deciding in chat; chat messages link to the console.'}</p>
              </Section>

              <ConnectedRecords a={a} agentAiSystemId={agent?.aiSystemId} agentOwnerId={agent?.ownerId} />
            </aside>
          </div>

          {!pending && <DecidedBlock a={a} result={resultReceipt} enforced={enforced} route={agent?.route} digest={digest} />}
        </div>
      </div>

      {pending && !expiredNow && (
        <div className="sticky bottom-0 z-10 border-t border-line bg-surface/95 backdrop-blur-[2px] px-5 lg:px-6 py-4">
          {mode && decidable && (mode === 'reject' || approvable) ? (
            <>
              <DigestLine digest={digest} className="mb-3" />
              <DecisionForm
                approval={a}
                route={agent?.route}
                mode={mode}
                selfApproval={selfApproval}
                payloadDigest={digest}
                draftRule={mode === 'approve' && draftRule}
                onCancel={() => setMode(null)}
                onDone={onDecided}
              />
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <DigestLine digest={digest} className="w-full" />
              <div className="mr-auto min-w-0 text-sm">
                {held ? (
                  <p className="text-muted"><OctagonX className="inline h-3.5 w-3.5 mr-1 -mt-0.5 text-bad-fg" aria-hidden />Held by the emergency stop. Nobody can decide it until the stop is lifted; it expires in <span className="text-fg font-medium num">{preciseCountdown(a.expiresAt, now)}</span>.</p>
                ) : !canDecideRole ? (
                  <p className="text-muted"><Lock className="inline h-3.5 w-3.5 mr-1 -mt-0.5" aria-hidden />Read-only as {role ? ROLE_INFO[role].label.toLowerCase() : 'a guest'}. Expires in <span className="text-fg font-medium num">{preciseCountdown(a.expiresAt, now)}</span>; approvers, admins and owners decide it.</p>
                ) : !who.ok ? (
                  <p className="text-muted"><Lock className="inline h-3.5 w-3.5 mr-1 -mt-0.5" aria-hidden />{who.why}</p>
                ) : (
                  <p className="text-muted"><Clock3 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" aria-hidden />Expires in <span className="text-fg font-medium num">{preciseCountdown(a.expiresAt, now)}</span>{who.ownerOverride && <> · owner override, recorded</>}{two && firstIsMe && <> · you gave the first approval</>}</p>
                )}
              </div>
              {/* a role that never decides approvals sees no decide buttons; an approver blocked by a rule (the stop,
                  another group, the same-person or two-person rule) keeps them disabled with the reason */}
              {canDecideRole && (
                <div className="flex w-full flex-wrap sm:w-auto sm:ml-auto items-center gap-3">
                  <Button variant="secondary" size="lg" className="flex-1 sm:flex-none min-w-[128px]" disabled={!decidable} title={noDecideWhy} icon={<X className="h-4 w-4" aria-hidden />} onClick={() => setMode('reject')}>
                    Reject <Kbd className="hidden sm:inline-flex ml-1">R</Kbd>
                  </Button>
                  {canDraft && (
                    <>
                      <span className="h-8 w-px bg-line" aria-hidden />
                      <Button variant="ghost" size="lg" className="flex-1 sm:flex-none" disabled={!approvable}
                        title={noDecideWhy ?? (forbidSelf ? 'You own the agent that proposed this, so you cannot also approve it.' : 'Approve, then open a pre-filled draft rule in this agent’s rulebook')}
                        icon={<FilePlus2 className="h-4 w-4" aria-hidden />} onClick={() => { setDraftRule(true); setMode('approve'); }}>
                        Approve and draft a rule
                      </Button>
                    </>
                  )}
                  <Button variant="primary" size="lg" className="flex-1 sm:flex-none min-w-[140px]" disabled={!approvable} title={noDecideWhy ?? (forbidSelf ? 'You own the agent that proposed this, so you cannot also approve it.' : two && firstIsMe ? 'You gave the first approval; a different person gives the second.' : undefined)} icon={<Check className="h-4 w-4" aria-hidden />} onClick={() => { setDraftRule(false); setMode('approve'); }}>
                    {two && !first ? 'First approval' : 'Approve'} <Kbd className="hidden sm:inline-flex ml-1 bg-transparent text-canvas/70 border-canvas/30">A</Kbd>
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ h }: { h: Approval }) {
  return (
    <li>
      <Link to={`/approvals/${h.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-sunken/60">
        <ApprovalChip status={h.status} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm">{h.headline}</span>
        <span className="hidden sm:block shrink-0 text-xs text-muted">{h.decidedBy ? userName(h.decidedBy) : 'Expiry'}</span>
        <When iso={h.decidedAt ?? h.createdAt} className="shrink-0 text-xs text-muted" />
      </Link>
    </li>
  );
}

const AFTER_OPTIONS = [15, 30, 60, 120, 240, 480, 1440];
const minutesLabel = (m: number) => (m < 60 ? `${m} minutes` : m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : `${m / 60} hour${m === 60 ? '' : 's'}`);

/** The group, its members, the escalation step with its countdown, the policy (editable by owners and admins), and manual re-route. */
function ApproverGroupSection({ a, now, canReroute }: { a: Approval; now: number; canReroute: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const esc = useQuery((o) => api.escalation(o), [], { kinds: ['receipt', 'approval'] });
  const group = approverGroup(orgId, a.approverGroup);
  const members = useQuery((o) => api.members(o), [], { live: false });
  const statusOf = (uid: string) => members.data?.find((m) => m.userId === uid)?.status;
  const pending = a.status === 'pending';
  const policy = esc.data?.policies.find((p) => p.groupId === group?.id);
  const ruleEsc = ruleEscalation(orgId, a);
  const escalatedBySystem = a.escalations?.some((e) => e.by === 'system');
  const policyAt = policy?.enabled ? new Date(a.createdAt).getTime() + policy.afterMinutes * 60_000 : undefined;
  const nextAt = escalatedBySystem ? undefined : [ruleEsc?.atMs, policyAt].filter((x): x is number => x !== undefined).sort((x, y) => x - y)[0];
  const nextTo = nextAt === ruleEsc?.atMs ? ruleEsc?.toName : policy?.backupGroupName;
  const [editing, setEditing] = useState(false);

  return (
    <Section title="Approver group">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium"><Users className="h-4 w-4 text-muted" aria-hidden />{a.approverGroup}{group?.members.includes(user?.id ?? '') && <Badge tone="info">Your group</Badge>}</p>
      <ul className="mt-2 space-y-1.5">
        {(group?.members ?? []).map((m) => (
          <li key={m} className="flex items-center justify-between gap-2">
            <Person id={m} size={20} />
            {statusOf(m) && statusOf(m) !== 'active' && <Badge tone="held">{statusOf(m) === 'suspended' ? 'Suspended' : 'Invited'}</Badge>}
          </li>
        ))}
        {!group?.members.length && <li className="text-sm text-bad-fg">This group has no members. Re-route it.</li>}
      </ul>
      {a.originalGroup && a.originalGroup !== a.approverGroup && <p className="mt-2 text-xs text-muted">First routed to {a.originalGroup}; its members can still decide.</p>}

      <div className="mt-4 border-t border-line pt-3 space-y-2">
        <p className="text-sm font-medium flex items-center gap-1.5"><TimerReset className="h-3.5 w-3.5 text-muted" aria-hidden />Automatic re-routing</p>
        {esc.loading && !esc.data ? <Skeleton className="h-10" /> : esc.error ? (
          <p className="text-xs text-bad-fg">The escalation policy could not be loaded. {esc.error.message}</p>
        ) : (
          <>
            {a.escalations?.length ? (
              <ol className="space-y-1.5">
                {a.escalations.map((e, i) => (
                  <li key={i} className="text-xs text-muted">
                    <span className="text-fg">{e.from} → {e.to}</span> · {e.by === 'system' ? `automatically${e.afterMinutes ? ` after ${minutesLabel(e.afterMinutes)}` : ''}` : `by ${userName(e.by)}`} · <When iso={e.at} />{e.seq !== undefined && <> · <ReceiptLink seq={e.seq} /></>}
                  </li>
                ))}
              </ol>
            ) : null}
            {pending && nextAt !== undefined && nextTo ? (
              <p className="text-sm">
                {nextAt > now
                  ? <>Re-routes to <span className="font-medium">{nextTo}</span> in <span className="num font-medium">{countdown(new Date(nextAt).toISOString(), now)}</span> if nobody decides.</>
                  : <>Due to re-route to <span className="font-medium">{nextTo}</span> now; it happens on the next check.</>}
                {nextAt === ruleEsc?.atMs && <span className="block text-xs text-muted">Set on rule {a.ruleId}: escalate after {ruleEsc.after}.</span>}
              </p>
            ) : pending && escalatedBySystem ? (
              <p className="text-xs text-muted">Already re-routed once automatically. It expires as a refusal if nobody decides.</p>
            ) : pending ? (
              <p className="text-xs text-muted">No automatic re-routing for {a.approverGroup}{policy && !policy.enabled ? ' — switched off' : ''}. It expires as a refusal if nobody decides.</p>
            ) : null}
            {policy && (
              <p className="text-xs text-muted">Policy for {policy.groupName}: {policy.enabled ? <>after {minutesLabel(policy.afterMinutes)} to {policy.backupGroupName}</> : 'off'} · triggered {n(policy.triggered)} times{policy.lastTriggeredAt && <>, last <When iso={policy.lastTriggeredAt} /></>}.</p>
            )}
            {policy && canReroute && !editing && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} onClick={() => setEditing(true)}>Edit the policy</Button>}
            {policy && editing && <PolicyEditor groupId={policy.groupId} afterMinutes={policy.afterMinutes} backupGroupId={policy.backupGroupId} enabled={policy.enabled} onDone={() => { setEditing(false); esc.refetch(); }} />}
          </>
        )}
      </div>

      {/* owners and admins re-route; nobody else sees the control */}
      {pending && canReroute && <Reroute a={a} canReroute={canReroute} />}
    </Section>
  );
}

function PolicyEditor({ groupId, afterMinutes, backupGroupId, enabled, onDone }: { groupId: string; afterMinutes: number; backupGroupId: string; enabled: boolean; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const groups = api.approverGroups(orgId).filter((g) => g.id !== groupId);
  const [after, setAfter] = useState(afterMinutes);
  const [backup, setBackup] = useState(backupGroupId);
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await api.setEscalation(orgId, groupId, { afterMinutes: after, backupGroupId: backup, enabled: on }, user.id);
      toast.ok('Escalation policy saved', 'Recorded as an escalation.updated receipt. It applies to calls already waiting.');
      onDone();
    } catch (e) {
      toast.bad('Policy not saved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border border-line bg-sunken/40 p-3 space-y-3">
      <Switch label="Re-route automatically" checked={on} onChange={setOn} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor={`esc-after-${groupId}`}>After</label>
          <Select id={`esc-after-${groupId}`} size_="sm" value={String(after)} onChange={(e) => setAfter(Number(e.target.value))} disabled={!on}>
            {Array.from(new Set([...AFTER_OPTIONS, afterMinutes])).sort((x, y) => x - y).map((m) => <option key={m} value={m}>{minutesLabel(m)}</option>)}
          </Select>
        </div>
        <div>
          <label className="label" htmlFor={`esc-to-${groupId}`}>Backup group</label>
          <Select id={`esc-to-${groupId}`} size_="sm" value={backup} onChange={(e) => setBackup(e.target.value)} disabled={!on}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={save}>Save policy</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/** One declared extension per approval: 24 more hours, with a reason, recorded on the chain. */
function Extension({ a, canExtend, why }: { a: Approval; canExtend: boolean; why?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (a.extension) {
    return (
      <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
        Extended once by <span className="text-fg">{userName(a.extension.by)}</span> <When iso={a.extension.at} /> from {dateTime(a.extension.from)} · <ReceiptLink seq={a.extension.seq} />
        <span className="block mt-1">“{a.extension.reason}” It cannot be extended again.</span>
      </p>
    );
  }
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await api.extendApproval(orgId, a.id, reason, user.id);
      toast.ok('Extended by 24 hours', 'The extension and your reason are recorded on the chain. It cannot be extended again.');
      setOpen(false);
    } catch (e) {
      toast.bad('Could not extend', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 border-t border-line pt-3 space-y-2">
      {!open ? (
        <>
          <Button size="sm" variant="ghost" icon={<TimerReset className="h-3.5 w-3.5" aria-hidden />} disabled={!canExtend} title={why} onClick={() => setOpen(true)}>Extend once by 24 hours</Button>
          <p className="text-xs text-muted">An approval can be extended once, with a reason. The extension is a receipt.</p>
        </>
      ) : (
        <>
          <label htmlFor={`ext-${a.id}`} className="text-sm font-medium">Why does it need more time?</label>
          <Textarea id={`ext-${a.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: waiting for the vendor to confirm the bank details by phone" />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={go} loading={busy} disabled={reason.trim().length < 5}>Extend by 24 hours</Button>
            <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setReason(''); }}>Cancel</Button>
          </div>
        </>
      )}
    </div>
  );
}

function Reroute({ a, canReroute }: { a: Approval; canReroute: boolean }) {
  const user = useUser();
  const orgId = useOrgId();
  // never offer a group you sit in: a re-route into your own group would let you approve what your group could not
  const options = api.approverGroups(orgId).filter((g) => g.name.toLowerCase() !== a.approverGroup.toLowerCase() && g.members.length > 0 && !(user && g.members.includes(user.id)));
  const [to, setTo] = useState(options[0]?.name ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!options.some((g) => g.name === to)) setTo(options[0]?.name ?? ''); }, [a.approverGroup]);
  const go = async () => {
    if (!user || !to) return;
    setBusy(true);
    try {
      await api.reroute(orgId, a.id, to, user.id);
      toast.ok('Re-routed', `Now waiting on ${to}. The re-route is recorded on the chain.`);
    } catch (e) {
      toast.bad('Could not re-route', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 border-t border-line pt-3 space-y-2">
      <p className="text-sm font-medium flex items-center gap-1.5"><Shuffle className="h-3.5 w-3.5 text-muted" aria-hidden />Re-route now</p>
      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Select size_="sm" aria-label="Approver group to re-route to" value={to} onChange={(e) => setTo(e.target.value)} disabled={!canReroute}>
            {options.map((g) => <option key={g.id} value={g.name}>{g.name} ({g.members.length})</option>)}
          </Select>
        </div>
        <Button size="sm" variant="secondary" onClick={go} loading={busy} disabled={!canReroute || !to} title={!canReroute ? 'Owners and admins re-route; approvers decide.' : undefined}>Re-route</Button>
      </div>
      {!canReroute && <p className="text-xs text-muted">Owners and admins re-route; approvers decide.</p>}
      {canReroute && !options.length && <p className="text-xs text-muted">No other group can take it. Groups you belong to are not offered: you cannot re-route an approval to yourself.</p>}
      {canReroute && options.length > 0 && <p className="text-xs text-muted">Groups you belong to are not offered, and you cannot decide an approval you re-routed.</p>}
    </div>
  );
}

/** Issue single-use links to members and see each one's state: sent, used (when and by whom), expired. */
function LinksSection({ a, held }: { a: Approval; held?: string }) {
  const orgId = useOrgId();
  const canReroute = useCan('approvals.reroute');
  const canDecideRole = useCan('approvals.decide');
  const user = useUser();
  const group = approverGroup(orgId, a.approverGroup);
  const owners = useQuery((o) => api.members(o), [], { live: false });
  const recipients = Array.from(new Set([...(group?.members ?? []), ...api.allowedApprovers(orgId, a.id), ...(owners.data ?? []).filter((m) => m.role === 'owner' && m.status === 'active').map((m) => m.userId)]));
  const linksQ = useQuery(async (o) => linksFor(o, a.id), [a.id], { kinds: ['approval', 'receipt'] });
  // Sovereign denies all egress: links go by email through the organisation's own mail relay, or as a phone link that
  // opens the console over the bank's own network (Work › Channels) — never Slack or WhatsApp
  const sov = useOrgLevel() === 'sovereign';
  const channels: Channel[] = sov ? ['email', 'phone_link'] : LINK_CHANNELS;
  const sovHost = sov ? consoleHost(orgId) : undefined;
  // chat buttons follow the same rule as the send path (mock/approvalNotify chatButtonsFor) and decideInChat
  const chatBlockerReason = sov ? 'sovereign' : chatBlocker(orgId, a);
  const [to, setTo] = useState(recipients[0] ?? '');
  const [channel, setChannel] = useState<Channel>(sov ? 'email' : 'phone_link');
  const [busy, setBusy] = useState(false);
  const canIssue = canReroute || (!!user && recipients.includes(user.id));
  const issue = async () => {
    if (!to) return;
    setBusy(true);
    try {
      const t = await api.approvalLink(orgId, a.id, to, channels.includes(channel) ? channel : channels[0], user?.id);
      linksQ.refetch();
      const seq = (t as { seq?: number }).seq;
      toast.ok(`Single-use link for ${userName(to)}`, `${t.channel === 'phone_link' ? (sov ? 'Ready to copy below; it opens the console over your own network' : 'Ready to copy below') : `Sent by ${channelLabel[t.channel]}${sov ? ' through your mail relay' : ''} — see the demo outbox below`}. It works once and expires with the approval.${seq !== undefined ? ` Recorded as receipt ${seqLabel(seq)}.` : ''}`);
    } catch (e) {
      toast.bad('Link not issued', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const links = linksQ.data ?? [];
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Section title="Single-use links">
      {links.length > 0 ? (
        <ul className="space-y-2 mb-3">
          {links.map((l) => {
            const expired = !l.usedAt && new Date(l.expiresAt).getTime() < Date.now();
            return (
              <li key={l.token} className="border border-line px-2.5 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-sm">{userName(l.issuedTo)}</span>
                  {l.usedAt ? <StatusChip tone="neutral" size="sm" icon={<Check className="h-3 w-3" aria-hidden />}>Used</StatusChip> : expired ? <StatusChip tone="neutral" size="sm" icon={<Clock3 className="h-3 w-3" aria-hidden />}>Expired</StatusChip> : <StatusChip tone="info" size="sm" icon={<Link2 className="h-3 w-3" aria-hidden />}>Sent</StatusChip>}
                </div>
                <p className="mt-1 text-muted">{channelLabel[l.channel]} · issued <When iso={l.issuedAt} />{l.usedAt && <> · used {dateTime(l.usedAt)} by {userName(l.usedBy)}{l.usedSeq !== undefined && <> · <ReceiptLink seq={l.usedSeq} /></>}</>}</p>
                {!l.usedAt && !expired && canDecideRole && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <Link to={`/approve/${l.token}`} className="font-mono text-[11px] text-muted hover:text-fg truncate">/approve/{l.token.slice(0, 22)}…</Link>
                    <CopyButton compact text={`${sovHost ?? origin}/approve/${l.token}`} label="Copy link" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : linksQ.loading ? <Skeleton className="h-10 mb-3" /> : <p className="text-xs text-muted mb-3">No link issued yet. Each link is signed for one person and one channel, and works once.</p>}
      <div className="mb-3"><ApprovalOutbox a={a} links={links} onDecided={linksQ.refetch} /></div>
      {held ? (
        <p className="text-xs text-muted"><OctagonX className="inline h-3 w-3 mr-1 -mt-0.5 text-bad-fg" aria-hidden />Held by the stop: no new link can be sent until it is lifted, and links already sent cannot be used.</p>
      ) : canIssue ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Select size_="sm" aria-label="Send the link to" value={to} onChange={(e) => setTo(e.target.value)}>
              {recipients.map((m) => <option key={m} value={m}>{userName(m)}</option>)}
            </Select>
            <Select size_="sm" aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              {channels.map((c) => <option key={c} value={c}>{sov && c === 'email' ? 'Email (internal relay)' : sov && c === 'phone_link' ? 'Phone link (internal network)' : channelLabel[c]}</option>)}
            </Select>
          </div>
          <p className="text-xs text-muted">
            {sov
              ? <>Deny-all egress: links go by email through your own mail relay, or as a phone link to copy, which opens the console at {sovHost} over your own network (a phone on the bank’s Wi-Fi or VPN). Nothing goes through an outside service; Slack and WhatsApp are not available.</>
              : !chatBlockerReason
                ? 'This rule is approvable in chat: a Slack or WhatsApp message carries Approve and Reject buttons for the person it is sent to, when the routing reaches them there with a linked Slack account or a verified WhatsApp number. Anyone else gets an "Open in Elan1 Govern" link.'
                : 'A Slack or WhatsApp message carries an "Open in Elan1 Govern" link; this call is not approved in chat.'}
          </p>
          {!sov && !chatBlockerReason && to && (channel === 'slack' || channel === 'whatsapp') && !chatButtonsFor(orgId, a, to, channel) && (
            <p className="text-xs text-held-fg">{userName(to)} is not reached on {channelLabel[channel]} by the routing for this group, so this message carries an "Open in Elan1 Govern" link, not buttons.</p>
          )}
          <Button size="sm" variant="secondary" icon={<Link2 className="h-3.5 w-3.5" aria-hidden />} loading={busy} disabled={!to} onClick={issue}>Send a single-use link</Button>
        </div>
      ) : canDecideRole ? <p className="text-xs text-muted">Owners, admins and members of {a.approverGroup} send links.</p> : null}
    </Section>
  );
}

/** Hold and decision receipts, and from L2 their seals, timestamps and Merkle batch; from L3 the counterparty and the agent's autonomy. */
function ConnectedRecords({ a, agentAiSystemId, agentOwnerId }: { a: Approval; agentAiSystemId?: string; agentOwnerId?: string }) {
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const l3 = atLeast(level, 'l3');
  const ev = useQuery(async (o) => {
    if (!l2) return undefined;
    const seqs = [a.seq, a.resultSeq].filter((x): x is number => x !== undefined);
    const rows = await Promise.all(seqs.map(async (seq) => {
      const [seal, proof] = await Promise.all([api.seal(o, seq).catch(() => undefined), api.inclusionProof(o, seq).catch((e: Error) => e)]);
      return { seq, seal, proof };
    }));
    const [cps, grants] = l3 ? await Promise.all([api.counterparties(o).catch(() => undefined), api.grants(o).catch(() => undefined)]) : [undefined, undefined];
    const cp = a.counterparty ? cps?.counterparties.find((c) => c.name.toLowerCase() === a.counterparty!.toLowerCase() || a.counterparty!.toLowerCase().includes(c.name.toLowerCase().split(' ')[0])) : undefined;
    const grant = grants?.rows.find((r) => r.agentSlug === a.agentSlug && r.tool === a.tool);
    return { rows, cp, grant, noGrantLabel: grants?.noGrantLabel };
  }, [a.seq, a.resultSeq, l2, l3], { kinds: ['approval', 'autonomy', 'level'] });

  const evidence = useMemo(() => ev.data?.rows ?? [], [ev.data]);
  return (
    <Section title="Connected records">
      <ul className="space-y-2 text-sm">
        <li className="flex items-center justify-between gap-2"><span className="text-muted">Hold receipt</span><ReceiptLink seq={a.seq} /></li>
        {a.resultSeq !== undefined && <li className="flex items-center justify-between gap-2"><span className="text-muted">Decision receipt</span><ReceiptLink seq={a.resultSeq} /></li>}
        <li><Link className="inline-flex items-center gap-1.5 hover:underline underline-offset-2" to={`/rulebooks/${a.agentSlug}`}><BookCheck className="h-3.5 w-3.5 text-muted" aria-hidden />Rulebook · {a.agentSlug}</Link></li>
        <li><AgentLink slug={a.agentSlug} /></li>
        {agentAiSystemId && <li><Link className="inline-flex items-center gap-1.5 hover:underline underline-offset-2" to={`/inventory/${agentAiSystemId}`}><Boxes className="h-3.5 w-3.5 text-muted" aria-hidden />AI system record</Link></li>}
        {agentOwnerId && <li className="text-xs text-muted">Agent owner: {userName(agentOwnerId)}</li>}
      </ul>

      {l2 ? (
        <div className="mt-4 border-t border-line pt-3 space-y-3">
          <p className="label">Sealed and timestamped</p>
          {ev.loading && !ev.data ? <Skeleton className="h-16" /> : ev.error ? <p className="text-xs text-bad-fg">{ev.error.message}</p> : evidence.map(({ seq, seal, proof }) => (
            <div key={seq} className="space-y-1.5 text-xs">
              <p className="flex items-center justify-between gap-2"><span className="text-muted">{seq === a.seq ? 'Hold' : 'Decision'} <ReceiptLink seq={seq} /></span>
                {seal?.sealed ? <StatusChip tone="ok" size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>Sealed v6</StatusChip> : <StatusChip tone="neutral" size="sm">L1 — not sealed</StatusChip>}</p>
              {seal?.sealed && <p className="text-muted">Record {String(seal.seal.fields.find((f) => f.name === 'record_id')?.value ?? seal.seal.seq)} · v{String(seal.seal.fields.find((f) => f.name === 'record_version')?.value ?? '1')} · digest <Hash value={seal.seal.digest} len={10} /></p>}
              {!seal?.sealed && seal && 'reason' in seal && <p className="text-muted">{seal.reason}</p>}
              {proof instanceof Error ? (
                <p className="text-muted">{proof.message}</p>
              ) : proof ? (
                <>
                  {proof.tokens.map((t) => (
                    <p key={t.tsaId} className="flex items-center gap-1.5 text-muted"><Stamp className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{t.tsaName}</span><span className="ml-auto num whitespace-nowrap">{Math.round(t.delaySeconds / 60)} min{t.status === 'granted_late' ? ' · late' : ''}</span></p>
                  ))}
                  {proof.tokens.length === 2 && <p className="text-muted">The two timestamps are {Math.abs(Math.round((new Date(proof.tokens[0].genTime).getTime() - new Date(proof.tokens[1].genTime).getTime()) / 1000))} seconds apart.</p>}
                  <p className="text-muted">Merkle batch <SmartLink to="/assurance/anchors" className="font-mono hover:underline" plainClassName="font-mono">{proof.batchId}</SmartLink> · leaf {n(proof.leafIndex + 1)} of {n(proof.treeSize)} · {proof.verified ? 'proof verifies' : 'proof fails'}</p>
                </>
              ) : null}
            </div>
          ))}
          {l3 && ev.data && (
            <div className="space-y-1.5 text-xs border-t border-line pt-3">
              <p className="flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5 text-muted" aria-hidden /><span className="text-muted">Autonomy for {a.tool}:</span> <Link to={`/agents/autonomy?agent=${a.agentSlug}`} className="font-medium hover:underline">{ev.data.grant?.label ?? ev.data.noGrantLabel ?? 'A0 Observe (no grant)'}</Link></p>
              {a.counterparty && (
                <p className="flex items-center gap-1.5"><Handshake className="h-3.5 w-3.5 text-muted" aria-hidden /><span className="text-muted">Counterparty:</span> {ev.data.cp ? <SmartLink to="/assurance/counterparties" className="font-medium hover:underline" plainClassName="font-medium">{ev.data.cp.name} · {ev.data.cp.verification === 'verified' ? 'verified' : ev.data.cp.verification.replace('_', ' ')}</SmartLink> : <span>{a.counterparty} — not in the counterparty register</span>}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <UpgradePath className="mt-4" to="l2" compact what="Seals and two timestamps start at Attested" />
      )}
    </Section>
  );
}

function DecidedBlock({ a, result, enforced, route, digest }: { a: Approval; result?: Receipt; enforced: boolean; route?: Agent['route']; digest: string }) {
  const orgId = useOrgId();
  const self = result?.approval?.self_approval;
  const first = result?.details?.first_approver ? String(result.details.first_approver) : undefined;
  const link = result?.details?.link ? String(result.details.link) : undefined;
  void orgId;
  return (
    <div className="mt-6 border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-line bg-sunken/50">
        <p className="label">Decision</p>
        <ApprovalChip status={a.status} />
      </div>
      <div className="p-4 space-y-4">
        {a.status === 'expired' && <p className="text-sm">No one decided before {dateTime(a.expiresAt)}. Expiry is a refusal; the call did not run and the held arguments were wiped.</p>}
        {a.status === 'approved_run_failed' && <Banner tone="bad" title="Your approval was recorded. The call itself did not complete.">Nothing was changed in {a.connector}. The failure is on the result receipt.</Banner>}
        {a.status === 'approved' && (
          <p className="text-sm">{enforced ? `Elan1 Govern ran the call through ${a.connector} on approval.` : 'The agent was told it may proceed; it runs the call itself and records the outcome.'}</p>
        )}
        {a.status === 'approved' && <OutcomeBlock a={a} route={route} />}
        {a.status === 'rejected' && <p className="text-sm">The call did not run. The agent received a refusal with the reason below.</p>}
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div><dt className="label">Decided by</dt><dd className="mt-1">{a.decidedBy ? <Person id={a.decidedBy} showTitle /> : <span className="text-sm">Expiry (system)</span>}</dd></div>
          <div><dt className="label">When</dt><dd className="mt-1 text-sm num">{a.decidedAt ? dateTime(a.decidedAt) : '—'}</dd></div>
          {first && <div><dt className="label">First approval</dt><dd className="mt-1 flex items-center gap-2"><Person id={first} size={20} />{result?.details?.first_approval_seq !== undefined && <ReceiptLink seq={Number(result.details.first_approval_seq)} />}</dd></div>}
          <div><dt className="label">Channel</dt><dd className="mt-1 text-sm">{a.channel ? channelLabel[a.channel] : a.status === 'expired' ? 'Expiry' : '—'}{link && <span className="text-muted"> · single-use link …{link}</span>}</dd></div>
          <div><dt className="label">Result receipt</dt><dd className="mt-1 flex items-center gap-2"><ReceiptLink seq={a.resultSeq} />{result?.outcome && <StatusChip size="sm" tone={result.outcome.status === 'ok' ? 'ok' : result.outcome.status === 'error' ? 'bad' : 'neutral'}>{result.outcome.status === 'ok' ? 'Ran' : result.outcome.status === 'error' ? 'Run failed' : 'Not run'}</StatusChip>}</dd></div>
          <div className="sm:col-span-2"><dt className="label">Reason</dt><dd className="mt-1 text-sm">{a.decisionReason ? `“${a.decisionReason}”` : <span className="text-muted">No note</span>}</dd></div>
          <RecordedDigest result={result} current={digest} a={a} />
        </dl>
        <div className="flex flex-wrap gap-2">
          {result?.details?.delegated_from && <Badge tone="info">Decided under a delegation from {userName(String(result.details.delegated_from))}</Badge>}
          {result?.details?.step_up && <Badge>Password re-entered (step-up)</Badge>}
          {self && <Badge tone="held">Self-approval flagged — the approver owns this agent</Badge>}
          {a.override && <Badge tone="held">Owner decided outside {a.originalGroup ?? a.approverGroup} — recorded</Badge>}
          {result?.details?.two_person && <Badge tone="info">Two approvers</Badge>}
        </div>
        {a.resultSeq !== undefined && <p className="text-xs text-muted">Receipt {seqLabel(a.resultSeq)} is hash-chained to the hold at {seqLabel(a.seq)}.</p>}
      </div>
    </div>
  );
}
