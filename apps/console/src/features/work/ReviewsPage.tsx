import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookCheck, Check, ClipboardCheck, Clock3, Eraser, Gauge, KeyRound, Lock, OctagonX, ScanEye, ShieldCheck, Undo2, UserCheck, Users, X } from 'lucide-react';
import { api } from '@/api';
import type { ReviewItem, ReviewRequest } from '@/types';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { countdown, dateTime, n, plural, rupees } from '@/lib/format';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Dialog, EmptyState, Field, Input, Meter, PageHeader, Panel, Segmented, Skeleton, Stat, StatusChip, Switch, Textarea, toast } from '@/components/ui';
import { AgentLink, Money, ReceiptLink, When } from '@/components/domain';
import { SemanticDiffList } from '@/features/rulebooks/parts';
import { publishedOf } from '@/features/rulebooks/lib';
import { dualControl, rejectErasure, secondApprovals, setDualControlL1, setTwoPersonPolicy, twoPersonPolicy } from './backend';
import { reviewAssessment } from '@/features/assessments/backend';
import { heldReason } from '@/features/approvals/lib';
import { LevelBadge, UpgradePath } from './level';
import { SmartLink, useScreenAccess, type ScreenAccess } from '@/shell/access';

/** Safety and operations items (src/mock/ops.ts) and the supervised period's 1-in-10 sampled calls (L3+). */
type OpsKind = 'stop_lift' | 'break_glass' | 'approver_sample' | 'supervised_sample';
type Kind = ReviewItem['kind'] | 'second_approval' | OpsKind;
type Filter = 'all' | Kind;

const KIND_META: Record<Kind, { label: string; plural: string; icon: ReactNode }> = {
  rulebook_review: { label: 'Rulebook review', plural: 'Rulebooks', icon: <BookCheck className="h-3.5 w-3.5" aria-hidden /> },
  second_approval: { label: 'Second approval', plural: 'Second approvals', icon: <Users className="h-3.5 w-3.5" aria-hidden /> },
  assessment_signoff: { label: 'Assessment sign-off', plural: 'Assessments', icon: <ClipboardCheck className="h-3.5 w-3.5" aria-hidden /> },
  erasure_approval: { label: 'Erasure', plural: 'Erasure', icon: <Eraser className="h-3.5 w-3.5" aria-hidden /> },
  graduation_proposal: { label: 'Autonomy graduation', plural: 'Autonomy', icon: <Gauge className="h-3.5 w-3.5" aria-hidden /> },
  supervised_sample: { label: 'Supervised call (1 in 10)', plural: 'Supervised calls', icon: <ScanEye className="h-3.5 w-3.5" aria-hidden /> },
  stop_lift: { label: 'Lift the emergency stop', plural: 'Stop lifts', icon: <OctagonX className="h-3.5 w-3.5" aria-hidden /> },
  break_glass: { label: 'Emergency access', plural: 'Emergency access', icon: <KeyRound className="h-3.5 w-3.5" aria-hidden /> },
  approver_sample: { label: 'Approver sample', plural: 'Approver samples', icon: <UserCheck className="h-3.5 w-3.5" aria-hidden /> },
};
const KIND_ORDER: Kind[] = ['stop_lift', 'break_glass', 'rulebook_review', 'second_approval', 'assessment_signoff', 'erasure_approval', 'graduation_proposal', 'supervised_sample', 'approver_sample'];

/**
 * Whether a role ever decides this kind of item (the rules in lib/permissions.ts, unchanged). A role that never does
 * reads the card without a decide control or a "you cannot" line; a role that normally can, but is blocked by a rule
 * for this item (it asked, it gave the first approval, the stop), keeps the reason.
 */
function roleDecides(kind: Kind, a: ScreenAccess): boolean {
  switch (kind) {
    case 'rulebook_review': return a.can('rulebooks.review');
    case 'second_approval': return a.can('approvals.decide');
    case 'assessment_signoff': return a.can('assessments.signoff');
    case 'supervised_sample': return a.isStaff || a.role === 'approver';
    default: return a.isStaff;
  }
}

/** What kind of control a queue item is, in words: not every item here is two people deciding one thing. */
function controlLabel(row: Pick<Row, 'kind' | 'enforced'>): string {
  // one person looks at a call that already ran: a check after the fact, not a second approval
  if (row.kind === 'supervised_sample') return 'One person, after the call ran';
  // the approver and the person who drew the sample are both kept out of the review
  if (row.kind === 'approver_sample') return 'Not the approver or who drew it, enforced';
  return row.enforced ? 'Two people, enforced' : 'Recorded at L1';
}

interface Row {
  id: string;
  kind: Kind;
  title: string;
  detail: string;
  requestedBy: string;
  requestedAt: string;
  dueAt?: string;
  route: string;
  refId: string;
  canAct: boolean;
  whyNot?: string;
  enforced: boolean;
}

/**
 * Reviews — Work door. The second-person queue: rulebook changes waiting for review (dual control, enforced
 * from L2), large payments waiting for a second approver, assessment sign-offs, DPDP erasure approvals and
 * autonomy graduation proposals. The person who asked never approves their own request.
 */
export default function ReviewsPage() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const now = useNow(30_000);
  const [sp, setSp] = useSearchParams();
  const filter = (sp.get('kind') ?? 'all') as Filter;
  const showParam = sp.get('show');

  const q = useQuery(async (o) => {
    const [items, reviews, rulebooks, erasures, proposals] = await Promise.all([
      user ? api.reviewsQueue(o, user.id) : Promise.resolve([] as ReviewItem[]),
      api.reviews(o),
      api.rulebooks(o),
      api.erasures(o),
      api.graduationProposals(o),
    ]);
    const supervision = await api.supervision(o).catch(() => []);
    return { items, reviews, rulebooks, erasures, proposals, second: secondApprovals(o, user?.id), ops: api.ops.opsWorkItems(o, user?.id), supervision };
  }, [user?.id]);
  const role = useRole();
  const access = useScreenAccess();
  const canReviewSamples = role === 'owner' || role === 'admin' || role === 'approver';
  // a role that decides no kind of review (a viewer) reads the whole queue: no "only mine" switch, no "for you" count
  const readOnly = !KIND_ORDER.some((k) => roleDecides(k, access));

  const rows: Row[] = useMemo(() => {
    if (!q.data) return [];
    const second: Row[] = q.data.second.map((s) => ({
      id: `sa_${s.approval.id}`, kind: 'second_approval', title: s.approval.headline,
      detail: `Approved first by ${userName(s.first.userId)}. ${s.approval.amount !== undefined ? `${rupees(s.approval.amount)} needs two different approvers.` : 'Two different approvers.'}`,
      requestedBy: s.first.userId, requestedAt: s.first.at, dueAt: s.approval.expiresAt, route: `/approvals/${s.approval.id}`, refId: s.approval.id,
      // an emergency stop holds the approval: nobody can give the second approval until it is lifted
      ...(heldReason(orgId, s.approval) ? { canAct: false, whyNot: 'Held by the emergency stop. Nobody can decide it until the stop is lifted; its expiry still runs.' } : { canAct: s.canAct, whyNot: s.whyNot }),
      enforced: true,
    }));
    const ops: Row[] = q.data.ops.map((o) => ({ ...o } as Row));
    // the supervised period's sampled calls, reviewed after they ran (owners, admins and approvers)
    const sampled: Row[] = q.data.supervision.filter((s) => s.active).flatMap((s) => s.sampled.filter((c) => !c.review).map((c): Row => ({
      id: `sup_${s.grant.id}_${c.seq}`, kind: 'supervised_sample', title: `Sampled call #${c.seq}: ${s.grant.agentSlug} on ${s.grant.tool}`,
      detail: `${c.summary ? `${c.summary}. ` : ''}A3, supervised until ${dateTime(s.endsAt)}: 1 in ${s.grant.sampleEvery ?? 10} calls is sampled for a person after it runs.`,
      requestedBy: 'system', requestedAt: c.ts, dueAt: s.endsAt, route: `/agents/autonomy?agent=${s.grant.agentSlug}`, refId: `${s.grant.id}|${c.seq}`,
      // a one-person review after the call ran, not a dual control
      canAct: canReviewSamples, whyNot: canReviewSamples ? undefined : 'Owners, admins and approvers review sampled calls.', enforced: false,
    })));
    return [...ops, ...second, ...q.data.items.map((i) => ({ ...i } as Row)), ...sampled].sort((a, b) => Number(b.canAct) - Number(a.canAct) || (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9') || b.requestedAt.localeCompare(a.requestedAt));
  }, [q.data, orgId, canReviewSamples]);

  // A link that names a kind (?kind=rulebook_review) usually comes from the person who asked for the review.
  // When nothing of that kind is theirs to decide but something is waiting, show everything waiting instead of
  // an empty queue. ?show=all and ?show=mine always win.
  const kindWaiting = filter !== 'all' && rows.some((r) => r.kind === filter);
  const kindForMe = filter !== 'all' && rows.some((r) => r.kind === filter && r.canAct);
  const autoAll = !showParam && kindWaiting && !kindForMe;
  const mine = readOnly || showParam === 'all' ? false : !autoAll;

  const forMe = rows.filter((r) => r.canAct);
  const shown = rows.filter((r) => (filter === 'all' || r.kind === filter) && (!mine || r.canAct));
  const clocks = rows.filter((r) => r.kind === 'erasure_approval' && r.dueAt).sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
  const counts = (k: Kind) => rows.filter((r) => r.kind === k && (!mine || r.canAct)).length;
  const dc = dualControl(orgId);
  const decided = (q.data?.reviews ?? []).filter((r) => r.status !== 'pending').slice(0, 6);

  const setParam = (k: string, v?: string) => {
    const next = new URLSearchParams(sp);
    if (!v) next.delete(k); else next.set(k, v);
    setSp(next, { replace: true });
  };

  return (
    <div className="space-y-6 overflow-x-clip">
      <PageHeader
        kicker="Work"
        title="Reviews"
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        description={`Everything waiting for a second person. The person who asked never approves their own change; each decision is a ${atLeast(level, 'l2') ? 'signed receipt' : 'receipt sealed in the hash chain'}.`}
        meta={
          <>
            <LevelBadge level={level} />
            {dc.enforced
              ? <StatusChip tone="info" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Dual control enforced{dc.enforcedByLevel ? '' : ' by policy'}</StatusChip>
              : <StatusChip tone="neutral" size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>Dual control recorded, not enforced</StatusChip>}
          </>
        }
      />

      {q.error && <Banner tone="bad" title="Reviews could not be loaded" actions={<Button size="sm" variant="secondary" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3" aria-live="polite">
        {q.loading && !q.data ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[120px]" />) : q.data ? (
          <>
            {readOnly ? (
              <>
                <Stat label="Waiting for a second person" value={n(rows.length)} sub={rows.length ? Array.from(new Set(rows.map((r) => KIND_META[r.kind].plural.toLowerCase()))).join(', ') : 'Nothing is waiting'} />
                <Stat label="Decided rulebook reviews" value={n(decided.length)} sub="The most recent are listed on the right" />
              </>
            ) : (
              <>
                <Stat label="Waiting for you" value={n(forMe.length)} sub={forMe.length ? Array.from(new Set(forMe.map((r) => KIND_META[r.kind].plural.toLowerCase()))).join(', ') : 'Nothing needs your decision'} />
                <Stat label="Waiting for someone else" value={n(rows.length - forMe.length)} sub="You asked for these, already decided, or your role cannot" />
              </>
            )}
            <Stat label="Soonest 72-hour clock" value={clocks[0] ? <span className="num">{countdown(clocks[0].dueAt!, now)}</span> : '—'} sub={clocks[0] ? `DPDP erasure ${clocks[0].title.replace(/^(Approve|Execute) erasure /, '')}` : 'No erasure request is running'} to={clocks[0] && access.canSee('/records/erasure') ? '/records/erasure' : undefined} />
          </>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8 min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="overflow-x-auto max-w-full">
              <Segmented<Filter> size="sm" label="Kind" value={filter} onChange={(v) => setParam('kind', v === 'all' ? undefined : v)} options={[
                { value: 'all', label: 'All', count: mine ? forMe.length : rows.length },
                // safety items and samples appear only when something is waiting; autonomy graduation starts at L3,
                // so below L3 its tab is shown only if a row of that kind exists
                ...KIND_ORDER.filter((k) => (k === 'graduation_proposal'
                  ? atLeast(level, 'l3') || rows.some((r) => r.kind === k)
                  : !(['stop_lift', 'break_glass', 'supervised_sample', 'approver_sample'] as Kind[]).includes(k) || rows.some((r) => r.kind === k))).map((k) => ({ value: k, label: KIND_META[k].plural, count: counts(k) })),
              ]} />
            </div>
            {!readOnly && <Switch label="Only what I can decide" checked={mine} onChange={(v) => setParam('show', v ? (autoAll ? 'mine' : undefined) : 'all')} />}
          </div>

          {autoAll && !readOnly && (
            <p className="text-sm text-muted">Nothing in {KIND_META[filter as Kind].plural.toLowerCase()} is yours to decide, so everything waiting is shown — including what you asked for.</p>
          )}

          {q.loading && !q.data ? (
            <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
          ) : q.error && !q.data ? (
            <Panel flush><EmptyState compact title="Nothing to show" disc="aperture">The queue could not be read. Try again above.</EmptyState></Panel>
          ) : shown.length === 0 ? (
            <Panel flush>
              <EmptyState title={mine ? 'Nothing is waiting for you' : 'Nothing is waiting for a second person'} disc="progress"
                action={mine && rows.length ? <Button variant="secondary" onClick={() => setParam('show', 'all')}>Show everything waiting</Button> : <Link to="/rulebooks" className="link text-sm">Rulebooks</Link>}>
                {mine && rows.length ? `${plural(rows.length, 'item')} ${rows.length === 1 ? 'waits' : 'wait'} for someone else.` : 'When someone asks for a rulebook review, an erasure, a sign-off, a large payment or an autonomy change, it appears here for a different person.'}
              </EmptyState>
            </Panel>
          ) : (
            <ul className="space-y-3">
              {shown.map((r) => <ReviewCard key={r.id} row={r} data={q.data!} now={now} onDone={q.refetch} />)}
            </ul>
          )}
        </div>

        <aside className="lg:col-span-4 space-y-6 min-w-0">
          <PoliciesPanel />
          {!atLeast(level, 'l3') && (
            <UpgradePath to="l3" what="Autonomy graduation proposals start at Proven">
              No one sets an agent's autonomy. When a write type's record reaches 90 days, 200 records and 100 approvals, an owner or admin can propose its graduation to A3, and it appears here for a different owner or admin to approve.
            </UpgradePath>
          )}
          <Panel title="Recently decided rulebook reviews" flush>
            {q.loading && !q.data ? <div className="p-5"><Skeleton className="h-20" /></div> : decided.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">No rulebook review has been decided yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {decided.map((r) => <DecidedRow key={r.id} r={r} />)}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function approveLabel(k: Kind) {
  return k === 'rulebook_review' ? 'Approve this version' : k === 'assessment_signoff' ? 'Sign off' : k === 'graduation_proposal' ? 'Agree' : k === 'supervised_sample' ? 'Right for A3' : k === 'break_glass' ? 'Approve as second person' : 'Approve';
}
function changesLabel(k: Kind) {
  return k === 'graduation_proposal' || k === 'break_glass' ? 'Decline' : k === 'erasure_approval' ? 'Send back' : k === 'supervised_sample' ? 'Record a concern' : 'Request changes';
}

function DecidedRow({ r }: { r: ReviewRequest }) {
  const tone = r.status === 'approved' || r.status === 'published' ? 'ok' : 'held';
  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Link to={`/rulebooks/${r.slug}?tab=versions`} className="font-medium hover:underline">{r.slug} v{r.version}</Link>
        <StatusChip tone={tone} size="sm">{r.status === 'published' ? 'Reviewed and published' : r.status === 'approved' ? 'Approved' : 'Changes requested'}</StatusChip>
      </div>
      <p className="mt-0.5 text-xs text-muted">Asked by {userName(r.requestedBy)} · decided by {userName(r.reviewerId)}{r.decidedAt && <> · <When iso={r.decidedAt} /></>}</p>
      {r.decisionNote && <p className="mt-1 text-xs">“{r.decisionNote}”</p>}
    </li>
  );
}

interface Data {
  items: ReviewItem[];
  reviews: ReviewRequest[];
  rulebooks: Awaited<ReturnType<typeof api.rulebooks>>;
  erasures: Awaited<ReturnType<typeof api.erasures>>;
  proposals: Awaited<ReturnType<typeof api.graduationProposals>>;
  second: ReturnType<typeof secondApprovals>;
}

function ReviewCard({ row, data, now, onDone }: { row: Row; data: Data; now: number; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const levelNow = useOrgLevel();
  const [mode, setMode] = useState<'approve' | 'changes' | 'execute' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = KIND_META[row.kind];
  const access = useScreenAccess();
  // a role that never decides this kind sees no "you cannot" line, only the way to the record (when it can open it)
  const decidesKind = roleDecides(row.kind, access);
  const canOpen = access.canSee(row.route);

  const review = row.kind === 'rulebook_review' ? data.reviews.find((r) => r.id === row.refId) : undefined;
  const rb = review ? data.rulebooks.find((b) => b.id === review.rulebookId) : undefined;
  const version = rb?.versions.find((v) => v.version === review?.version);
  const live = rb ? publishedOf(rb) : undefined;
  const erasure = row.kind === 'erasure_approval' ? data.erasures.requests.find((e) => e.id === row.refId) : undefined;
  const proposal = row.kind === 'graduation_proposal' ? data.proposals.find((p) => p.id === row.refId) : undefined;
  const second = row.kind === 'second_approval' ? data.second.find((s) => s.approval.id === row.refId) : undefined;

  // an assessment sign-off always carries a note (what was checked, or what must change), as on the assessment page
  const signoff = row.kind === 'assessment_signoff';
  const needsNote = mode === 'changes' || (signoff && mode === 'approve');
  const minNote = mode === 'changes' ? 10 : 4;
  const noteOk = !needsNote || note.trim().length >= minNote;

  const act = async () => {
    if (!user || !mode || !noteOk) return;
    setBusy(true);
    try {
      const approve = mode === 'approve';
      switch (row.kind) {
        case 'rulebook_review':
          await api.approveReview(orgId, row.refId, user.id, approve, note.trim());
          toast.ok(approve ? 'Review approved' : 'Changes requested', approve ? 'Recorded as review.approved. A different person from you can now sign and publish this version.' : 'Recorded as review.changes_requested. The draft goes back to its author.');
          break;
        case 'assessment_signoff': {
          // the assessments backend checks the status, the sign-off permission, the note and any pack-admission gates
          const res = await reviewAssessment(orgId, row.refId, approve, note.trim(), user.id);
          const admitted = res.assessment.admittedSeq !== undefined;
          toast.ok(
            approve ? (admitted ? 'Pack admitted' : 'Assessment signed off') : 'Changes requested',
            approve ? (admitted ? `Every admission gate is met. Recorded as pack.admitted, receipt #${n(res.assessment.admittedSeq!)}.` : 'The risk tier and the next review date are set from this assessment.') : 'The author sees your note.',
          );
          break;
        }
        case 'erasure_approval':
          if (mode === 'execute') {
            const e = await api.executeErasure(orgId, row.refId, user.id);
            toast.ok('Salts destroyed', `The payload hashes of ${plural(e.affected, 'sealed receipt')} are frozen and their salts destroyed. The values the rules inspected were removed from those receipts; ${atLeast(levelNow, 'l2') ? 'the organisation signed what is left' : 'what is left stays sealed in the hash chain'}. ${e.chainStillVerifies ? 'The chain still verifies.' : 'Check the chain.'}`);
          } else if (approve) {
            const e = await api.approveErasure(orgId, row.refId, user.id);
            toast.ok(`Approval ${e.approvals.length} of ${e.required} recorded`, e.status === 'approved' ? 'Two people have approved. It can be executed now, inside the 72-hour clock.' : 'A different person gives the second approval.');
          } else {
            await rejectErasure(orgId, row.refId, user.id, note.trim());
            toast.info('Erasure sent back', 'Recorded as erasure.rejected with your reason.');
          }
          break;
        case 'graduation_proposal': {
          const p = await api.decideGraduation(orgId, row.refId, approve, user.id, note.trim());
          toast.ok(p.status === 'granted' ? 'Graduated to A3' : 'Proposal declined', p.status === 'granted' ? `${p.agentSlug} now acts at ${p.to} for ${p.tool}, supervised for 30 days. The graduation is a receipt.` : 'Recorded with your note.');
          break;
        }
        case 'supervised_sample': {
          const [grantId, seq] = row.refId.split('|');
          const r = await api.reviewSample(orgId, { grantId, seq: Number(seq), ok: approve, note: note.trim() }, user.id);
          toast.ok(approve ? 'Sampled call reviewed' : 'Concern recorded', approve ? `Right for A3. Receipt #${n(r.reviewSeq ?? 0)}.` : `Receipt #${n(r.reviewSeq ?? 0)}. Revoking the graduation is a separate press on Autonomy.`);
          break;
        }
        case 'break_glass': {
          const b = approve ? api.ops.approveBreakGlass(orgId, row.refId, user.id) : api.ops.declineBreakGlass(orgId, row.refId, user.id, note.trim());
          toast.ok(approve ? 'Emergency access approved' : 'Emergency access declined', approve ? `${userName(b.forUser)} can sign in with a password until ${b.expiresAt ? dateTime(b.expiresAt) : 'the time runs out'}. Receipt #${n(b.approveSeq ?? 0)}.` : 'Recorded with your reason.');
          break;
        }
        default:
          break;
      }
      setMode(null);
      setNote('');
      onDone();
    } catch (e) {
      toast.bad('Not recorded', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const due = row.dueAt ? new Date(row.dueAt).getTime() : undefined;
  const clockShare = erasure ? Math.max(0, Math.min(1, (now - new Date(erasure.requestedAt).getTime()) / (new Date(erasure.dueAt).getTime() - new Date(erasure.requestedAt).getTime()))) : 0;

  return (
    <li className={cn('border border-line bg-surface', row.canAct && 'border-l-[3px] border-l-fg')}>
      <div className="px-5 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <Badge icon={meta.icon}>{meta.label}</Badge>
          <span className="text-xs text-muted">{controlLabel(row)}</span>
          <span className="ml-auto text-xs text-muted">Asked by {row.requestedBy === 'system' ? (row.kind === 'supervised_sample' ? 'Elan1 Govern (1-in-10 sample)' : 'Elan1 Govern (from precedent)') : userName(row.requestedBy)} · <When iso={row.requestedAt} /></span>
        </div>
        <h2 className="text-md font-semibold leading-snug">{row.title}</h2>
        <p className="mt-1 text-sm text-muted">{row.detail}</p>

        {review && (
          <div className="mt-3 space-y-2">
            {version && live ? <SemanticDiffList compact before={live.rules} after={version.rules} emptyText="No rule decides differently; wording or lists changed." /> : <p className="text-sm text-muted">The version could not be compared.</p>}
            <p className="text-xs text-muted">Read the test on past actions and the YAML in the <Link to={`/rulebooks/${review.slug}?tab=publish`} className="link">Publish tab</Link> before you decide. Approving does not publish; a different person from you signs and publishes.</p>
          </div>
        )}

        {erasure && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="label">72-hour clock</p>
              <p className={cn('mt-1 font-display text-xl font-semibold num', due && due - now < 12 * 3.6e6 && 'text-held-fg')}>{due ? countdown(row.dueAt!, now) : '—'}</p>
              <Meter className="mt-1.5" value={1 - clockShare} tone={clockShare > 0.8 ? 'held' : 'inverse'} label="Time left on the 72-hour clock" />
              <p className="mt-1 text-xs text-muted">Ends {dateTime(erasure.dueAt)}</p>
            </div>
            <div className="text-sm">
              <p className="label">Approvals</p>
              <p className="mt-1">{erasure.approvals.length} of {erasure.required}{erasure.approvals.length ? ` — ${erasure.approvals.map((x) => userName(x.userId)).join(', ')}` : ''}</p>
              <p className="mt-1 text-xs text-muted">{n(erasure.affected)} sealed receipts · subject {erasure.subjectRef}. The identifier is hashed; it is never stored.</p>
            </div>
          </div>
        )}

        {proposal && (
          <div className="mt-3">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-line border border-line text-center">
              {([['Days (≥ 90)', proposal.evidence.days], ['Records (≥ 200)', proposal.evidence.records], ['Approvals (≥ 100)', proposal.evidence.approvals], ['Rejections', proposal.evidence.rejections], ['Reversals', proposal.evidence.reversals], ['Median minutes', proposal.evidence.medianMinutesToDecide]] as const).map(([k, v]) => (
                <div key={k} className="bg-surface px-2 py-2"><p className="label text-[10px]">{k}</p><p className="font-display text-lg font-semibold num">{n(v)}</p></div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Numbers only, never a recommendation. Proposed by {userName(proposal.proposedBy ?? proposal.decisions[0]?.userId)}{proposal.decisions[0]?.note ? `: “${proposal.decisions[0].note}”` : ''}. Approving starts A3 with a 30-day supervised period (1 in 10 calls sampled for a person). <Link to={`/agents/autonomy?agent=${proposal.agentSlug}`} className="link">Autonomy</Link></p>
          </div>
        )}

        {second && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <AgentLink slug={second.approval.agentSlug} />
            {second.approval.amount !== undefined && <Money value={second.approval.amount} className="font-semibold" />}
            <span className="text-muted">First approval <ReceiptLink seq={second.first.seq} /></span>
            <span className="text-muted inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" aria-hidden />expires in {countdown(second.approval.expiresAt, now)}</span>
          </div>
        )}
      </div>

      {(row.canAct || decidesKind || canOpen) && <div className="px-5 py-3 border-t border-line bg-sunken/40">
        {!row.canAct ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {decidesKind ? <p className="text-sm text-muted inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" aria-hidden />{row.whyNot ?? 'You cannot decide this one.'}</p> : <span />}
            <SmartLink to={row.route} hideWhenBlocked className="text-sm link inline-flex items-center gap-1">Open <ArrowRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>
          </div>
        ) : row.kind === 'second_approval' || row.kind === 'stop_lift' || row.kind === 'approver_sample' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">{row.kind === 'stop_lift' ? 'Approve or decline the lift on the incident, where you type RESUME and the password is checked.' : row.kind === 'approver_sample' ? 'Read each sampled decision and record whether it was sound.' : 'Give the second approval or reject it in the approval itself, where the password is checked.'}</p>
            <Link to={row.route} className="inline-flex items-center gap-1.5 h-9 px-3 text-sm font-medium bg-fg text-canvas hover:bg-fg/90">{row.kind === 'approver_sample' ? 'Open and review' : 'Open and decide'} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
          </div>
        ) : mode && mode !== 'execute' ? (
          <div className="space-y-3">
            <Field label={mode === 'approve' ? (signoff ? 'What you checked' : 'Note') : row.kind === 'erasure_approval' ? 'Reason for sending it back' : row.kind === 'supervised_sample' ? 'What concerns you' : row.kind === 'break_glass' ? 'Why you decline' : 'What needs to change'} htmlFor={`rv-note-${row.id}`} required={needsNote} hint={!needsNote ? 'Optional. Recorded with your decision.' : mode === 'approve' ? 'Required. Recorded with the sign-off.' : 'At least a sentence. The author reads it; it is recorded.'} error={!noteOk && note ? (mode === 'approve' ? 'Write a few words: what you checked.' : 'Write at least a sentence.') : undefined}>
              <Textarea id={`rv-note-${row.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => { setMode(null); setNote(''); }}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!noteOk} icon={mode === 'approve' ? <Check className="h-4 w-4" aria-hidden /> : <Undo2 className="h-4 w-4" aria-hidden />} onClick={act}>
                {mode === 'approve' ? approveLabel(row.kind) : changesLabel(row.kind)}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SmartLink to={row.route} hideWhenBlocked className="text-sm link inline-flex items-center gap-1">Open the full record <ArrowRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>
            <div className="flex flex-wrap gap-2">
              {erasure?.status === 'approved' ? (
                <Button variant="danger" icon={<Eraser className="h-4 w-4" aria-hidden />} onClick={() => setMode('execute')}>Destroy the salts</Button>
              ) : (
                <>
                  <Button variant="secondary" icon={<X className="h-4 w-4" aria-hidden />} onClick={() => setMode('changes')}>{changesLabel(row.kind)}</Button>
                  <Button variant="primary" icon={<Check className="h-4 w-4" aria-hidden />} onClick={() => setMode('approve')}>{approveLabel(row.kind)}</Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>}

      <Dialog open={mode === 'execute'} onClose={() => setMode(null)} tone="danger" title={`Destroy the salts for ${erasure?.subjectRef ?? ''}`}
        description="The payload hashes of the affected sealed receipts are frozen and their salts destroyed. The receipts, their seals and the chain stay and keep verifying; the receipt bodies themselves are not changed. This cannot be undone."
        footer={<><Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button><Button variant="danger" loading={busy} onClick={act}>Destroy {plural(erasure?.affected ?? 0, 'salt')}</Button></>}>
        <p className="text-sm text-muted">Approved by {erasure?.approvals.map((x) => userName(x.userId)).join(' and ')}. Recorded as erasure.executed.</p>
      </Dialog>
    </li>
  );
}

/** Dual control and the two-person rule: what applies here, and who can change it. */
function PoliciesPanel() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const canSet = useCan('approvals.reroute');
  const [, force] = useState(0);
  const dc = dualControl(orgId);
  const tp = twoPersonPolicy(orgId);
  const [above, setAbove] = useState(String(tp.above));
  const [busy, setBusy] = useState(false);

  const toggleDc = async (on: boolean) => {
    if (!user) return;
    try {
      await setDualControlL1(orgId, on, user.id);
      toast.ok(on ? 'Dual control required' : 'Dual control recorded only', 'Recorded as a policy.dual_control receipt.');
      force((x) => x + 1);
    } catch (e) { toast.bad('Not changed', (e as Error).message); }
  };
  const saveTp = async (patch: { enabled?: boolean; above?: number }) => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await setTwoPersonPolicy(orgId, patch, user.id);
      toast.ok('Two-person rule saved', `${r.policy.enabled ? `Payments of ${rupees(r.policy.above)} or more need two approvers.` : 'Off: one approver decides.'} Recorded as receipt #${n(r.seq)}.`);
      force((x) => x + 1);
    } catch (e) { toast.bad('Not saved', (e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Panel title="Who must agree" kicker="Policies">
      <div className="space-y-5 text-sm">
        <div>
          <p className="font-medium">Rulebook publish — dual control</p>
          <p className="mt-1 text-muted leading-relaxed">
            {dc.enforcedByLevel
              ? 'Enforced at this level: a version is published only after a different person approves its review.'
              : dc.policyL1
                ? 'Required by your policy: the console publishes only after a different person approves the review.'
                : 'At L1 the reviewer is recorded on the version and its receipt, not enforced.'}
          </p>
          {/* owners set the policy; every other role reads it */}
          {!dc.enforcedByLevel && role === 'owner' && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-xs text-muted">Require it here too</span>
              <Switch label="Require a second person before publishing" checked={dc.policyL1} onChange={toggleDc} />
            </div>
          )}
          {level === 'l1' && <UpgradePath className="mt-3" to="l2" compact what="Enforced on every publish at Attested" />}
        </div>
        <div className="border-t border-line pt-4">
          <p className="font-medium">Large payments — two approvers</p>
          <p className="mt-1 text-muted">{tp.enabled ? <>Held calls of <span className="text-fg font-medium">{rupees(tp.above)}</span> or more need two different approvers. The first approval is a receipt; the call runs on the second.</> : 'Off. One member of the approver group decides.'}</p>
          {canSet && (
            <div className="mt-2 space-y-2">
              <Switch label="Two approvers for large amounts" checked={tp.enabled} onChange={(v) => saveTp({ enabled: v })} />
              <div className="flex items-end gap-2">
                <Field label="From amount (₹)" htmlFor="tp-above" className="flex-1">
                  <Input id="tp-above" mono inputMode="numeric" value={above} onChange={(e) => setAbove(e.target.value.replace(/[^\d]/g, ''))} />
                </Field>
                <Button size="sm" variant="secondary" loading={busy} disabled={!tp.enabled || Number(above) === tp.above || !Number(above)} onClick={() => saveTp({ above: Number(above) })}>Save</Button>
              </div>
            </div>
          )}
        </div>
        <div className="border-t border-line pt-4">
          <p className="font-medium">Erasure, sign-offs and autonomy</p>
          <p className="mt-1 text-muted">Always two people: erasure needs two approvers other than the requester inside 72 hours; an assessment is signed off by someone other than its author; a graduation to A3 is proposed by one owner or admin and approved by a different one.</p>
        </div>
      </div>
    </Panel>
  );
}
