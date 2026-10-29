import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Dices, MessageSquare, UserCheck } from 'lucide-react';
import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { channelLabel, dateTime, n, pct, plural } from '@/lib/format';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, DataTable, Dialog, EmptyState, Field, PageHeader, Panel, Segmented, Select, Skeleton, Stat, StatusChip, Textarea, toast, type Column } from '@/components/ui';
import { AgentLink, Money, Person, ReceiptLink, When } from '@/components/domain';
import type { ApproverSample, ApproverStats } from '@/mock/ops';
import { LevelBadge } from './level';

const minutes = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : m < 120 ? `${Math.round(m * 10) / 10} min` : `${Math.round((m / 60) * 10) / 10} h`);

/**
 * Approvers — Work door. Approver telemetry (time to decide, decisions made without opening the full record, the
 * channels used) and rubber-stamp sampling: an owner or admin draws a sample of one approver's past approvals and a
 * different person reviews each one as sound or a concern. Every draw, review and close is a receipt.
 */
export default function ApproversPage() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const fid = useId();
  const [sp, setSp] = useSearchParams();
  const [days, setDays] = useState<'30' | '90'>('90');
  const canAct = role === 'owner' || role === 'admin';
  const q = useQuery(async (o) => ({ stats: api.ops.approverTelemetry(o, Number(days)), samples: api.ops.approverSamples(o) }), [days], { kinds: ['approval', 'receipt'] });
  const [drawFor, setDrawFor] = useState<string>();
  const [size, setSize] = useState('5');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const focus = sp.get('sample');

  useEffect(() => {
    if (!focus || !q.data) return;
    const t = window.setTimeout(() => document.getElementById(`sample-${focus}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    return () => window.clearTimeout(t);
  }, [focus, q.data]);

  const stats = q.data?.stats ?? [];
  const totals = useMemo(() => {
    const decided = stats.reduce((s, x) => s + x.decided, 0);
    const without = stats.reduce((s, x) => s + x.withoutOpening, 0);
    const meds = stats.map((x) => x.medianMinutes).sort((a, b) => a - b);
    return { decided, without, median: meds.length ? meds[Math.floor(meds.length / 2)] : 0, flagged: stats.filter((x) => x.rubberStamp).length };
  }, [stats]);
  const open = (q.data?.samples ?? []).filter((s) => s.status === 'open');
  const closed = (q.data?.samples ?? []).filter((s) => s.status === 'closed');

  const draw = async () => {
    if (!user || !drawFor) return;
    setBusy(true);
    try {
      const s = api.ops.drawApproverSample(orgId, drawFor, Number(size), reason, user.id);
      toast.ok('Sample drawn', `${plural(s.approvalIds.length, 'approval')} by ${userName(s.approverId)} to review. Receipt #${n(s.drawSeq ?? 0)}. It is in Reviews for ${api.ops.sampleReviewers(orgId, s).map((u) => userName(u)).join(', ')}: an owner or admin other than you and the approver reviews it.`);
      setDrawFor(undefined);
      setReason('');
      setSp((p) => { const x = new URLSearchParams(p); x.set('sample', s.id); return x; }, { replace: true });
      q.refetch();
    } catch (e) {
      toast.bad('No sample drawn', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<ApproverStats>[] = [
    { key: 'who', header: 'Approver', cell: (s) => <span className="inline-flex items-center gap-2"><Person id={s.userId} size={22} />{s.rubberStamp && <Badge tone="held" icon={<AlertTriangle className="h-3 w-3" aria-hidden />}>Look closer</Badge>}</span>, sort: (s) => userName(s.userId) },
    { key: 'dec', header: 'Decided', align: 'right', cell: (s) => <span className="num">{n(s.decided)}</span>, sort: (s) => s.decided },
    { key: 'appr', header: 'Approved', align: 'right', hideBelow: 'sm', cell: (s) => <span className="num">{pct(s.approved / s.decided)}</span>, sort: (s) => s.approved / s.decided },
    { key: 'med', header: 'Median time to decide', align: 'right', cell: (s) => <span className={cn('num', s.medianMinutes < 2 && 'text-held-fg font-medium')}>{minutes(s.medianMinutes)}</span>, sort: (s) => s.medianMinutes },
    { key: 'p90', header: '90th percentile', align: 'right', hideBelow: 'lg', cell: (s) => <span className="num text-muted">{minutes(s.p90Minutes)}</span>, sort: (s) => s.p90Minutes },
    { key: 'fast', header: 'Under a minute', align: 'right', hideBelow: 'md', cell: (s) => <span className="num">{n(s.underOneMinute)}</span>, sort: (s) => s.underOneMinute },
    { key: 'wo', header: 'Without opening the record', align: 'right', cell: (s) => <span className={cn('num', s.withoutOpening / s.decided >= 0.4 && 'text-held-fg font-medium')}>{n(s.withoutOpening)} · {pct(s.withoutOpening / s.decided)}</span>, sort: (s) => s.withoutOpening / s.decided },
    { key: 'ch', header: 'Channels', hideBelow: 'lg', cell: (s) => <span className="text-xs text-muted">{Object.entries(s.channels).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${channelLabel[c] ?? c} ${k}`).join(' · ')}</span> },
    {
      key: 'act', header: '', align: 'right', cell: (s) => canAct && s.userId !== user?.id ? (
        <Button size="sm" variant="secondary" icon={<Dices className="h-3.5 w-3.5" />} onClick={(e) => { e.stopPropagation(); setDrawFor(s.userId); setReason(s.rubberStamp ? 'Fast approvals and decisions made without opening the record.' : ''); }}>Sample</Button>
      ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Work"
        title="Approvers"
        description="How each approver decides: time from held to decided, decisions made without opening the full record, and the channels they use. Draw a sample of anyone's past approvals for a second person to review — numbers to look at, never a verdict."
        meta={<><LevelBadge level={level} /><span className="text-xs text-muted">Each sample is {atLeast(level, 'l2') ? 'a signed receipt' : 'a receipt sealed in the hash chain'}.</span></>}
        actions={<Segmented size="sm" label="Window" value={days} onChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />}
      />

      {q.error && <Banner tone="bad" title="Approver figures could not be loaded" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4" aria-live="polite">
        {q.loading && !q.data ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[112px]" />) : (
          <>
            <Stat label="Decisions" value={n(totals.decided)} sub={`By ${plural(stats.length, 'approver')} in ${days} days`} />
            <Stat label="Median time to decide" value={minutes(totals.median)} sub="Middle approver, from held to decided" />
            <Stat label="Without opening the record" value={totals.decided ? pct(totals.without / totals.decided) : '—'} sub={`${n(totals.without)} decided from a message or the list`} />
            <Stat label="Samples open" value={n(open.length)} sub={totals.flagged ? `${plural(totals.flagged, 'approver')} worth a closer look` : 'No approver stands out'} to={open.length ? '/work/reviews?kind=approver_sample' : undefined} />
          </>
        )}
      </div>

      <Panel title="Approver telemetry" flush footer={<span>“Without opening” counts decisions where the approver did not open the approval’s full record first — Slack and WhatsApp buttons, or the list. Opening it in the console or on its approval-link page counts as opening it. “Look closer” marks 90% or more approved with a median under three minutes or 40% decided without opening.</span>}>
        <DataTable
          className="border-0"
          caption="Approver telemetry"
          columns={columns}
          rows={stats}
          loading={q.loading && !q.data}
          rowKey={(s) => s.userId}
          empty={<EmptyState compact title="No decisions in this window" disc="aperture">When approvers decide held calls, their figures appear here.</EmptyState>}
        />
      </Panel>

      <section aria-labelledby="samples-h" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="label mb-1">Rubber-stamp sampling</p>
            <h2 id="samples-h" className="text-xl font-semibold">Samples</h2>
          </div>
          <p className="text-xs text-muted max-w-[52ch]">An owner or admin other than the approver and the person who drew the sample reviews each sampled approval; the console enforces it. Nobody samples or reviews their own decisions. A concern changes nothing on its own; it is recorded for the approver and their manager.</p>
        </div>
        {q.loading && !q.data ? <Skeleton className="h-40" /> : open.length === 0 && closed.length === 0 ? (
          <Panel flush><EmptyState compact title="No samples yet" disc="progress">Choose Sample on an approver above to draw some of their past approvals for review.</EmptyState></Panel>
        ) : (
          <div className="space-y-4">
            {open.map((s) => <SampleCard key={s.id} sample={s} focused={focus === s.id} onDone={q.refetch} />)}
            {closed.length > 0 && (
              <Panel title="Closed samples" flush>
                <ul className="divide-y divide-line">
                  {closed.map((s) => {
                    const concerns = s.reviews.filter((v) => !v.ok).length;
                    return (
                      <li key={s.id} id={`sample-${s.id}`} className="px-5 py-3 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
                        <Person id={s.approverId} size={20} />
                        <StatusChip tone={concerns ? 'held' : 'ok'} size="sm">{concerns ? plural(concerns, 'concern') : 'All sound'}</StatusChip>
                        <span className="text-xs text-muted">{plural(s.approvalIds.length, 'approval')} · drawn by {userName(s.drawnBy)} {dateTime(s.drawnAt)}{s.closedAt ? ` · closed ${dateTime(s.closedAt)}` : ''}</span>
                        {s.closeSeq !== undefined && <ReceiptLink seq={s.closeSeq} className="text-xs" />}
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            )}
          </div>
        )}
      </section>

      <Dialog open={!!drawFor} onClose={() => setDrawFor(undefined)} title={drawFor ? `Sample ${userName(drawFor)}’s approvals` : ''}
        description="Approved decisions from the last 90 days, weighted towards the fastest ones and those made without opening the record. You draw the sample; a different owner or admin reviews each one."
        footer={<><Button variant="ghost" onClick={() => setDrawFor(undefined)}>Cancel</Button><Button variant="primary" icon={<Dices className="h-4 w-4" />} loading={busy} disabled={reason.trim().length < 6} onClick={draw}>Draw the sample</Button></>}>
        <div className="space-y-4">
          <Field label="How many" htmlFor={`${fid}-size`}>
            <Select id={`${fid}-size`} value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="3">3 approvals</option>
              <option value="5">5 approvals</option>
              <option value="10">10 approvals</option>
            </Select>
          </Field>
          <Field label="Why" htmlFor={`${fid}-why`} required hint="Recorded on the approver.sample_drawn receipt. The approver can read it.">
            <Textarea id={`${fid}-why`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function SampleCard({ sample: s, focused, onDone }: { sample: ApproverSample; focused: boolean; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const drew = s.drawnBy === user?.id;
  const canReview = (role === 'owner' || role === 'admin') && s.approverId !== user?.id && !drew;
  const reviewers = api.ops.sampleReviewers(orgId, s);
  const approvals = db.getDB(orgId).approvals;
  const rows = s.approvalIds.map((id) => approvals.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  const done = s.reviews.length;
  return (
    <div id={`sample-${s.id}`} className={cn('border border-line bg-surface', focused && 'border-l-[3px] border-l-fg')}>
      <div className="px-5 pt-4 pb-3 border-b border-line">
        <div className="flex flex-wrap items-center gap-2">
          <UserCheck className="h-4 w-4 text-muted" aria-hidden />
          <span className="font-semibold">Sample of {userName(s.approverId)}’s approvals</span>
          <StatusChip tone="held" size="sm">{done} of {s.approvalIds.length} reviewed</StatusChip>
          <span className="ml-auto text-xs text-muted">Drawn by {userName(s.drawnBy)} <When iso={s.drawnAt} />{s.drawSeq !== undefined && <> · <ReceiptLink seq={s.drawSeq} /></>}</span>
        </div>
        <p className="mt-1 text-sm text-muted">“{s.reason}”</p>
        {!canReview && <p className="mt-2 text-xs text-muted">{s.approverId === user?.id ? 'These are your decisions: a different owner or admin reviews them.' : drew ? `You drew this sample, so you do not review it. ${reviewers.length ? `Who can: ${reviewers.map((u) => userName(u)).join(', ')}.` : 'Nobody else holds the owner or admin role yet — invite one in People and roles.'}` : 'Owners and admins review sampled approvals.'}</p>}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((a) => <SampleRow key={a.id} sampleId={s.id} approval={a} review={s.reviews.find((v) => v.approvalId === a.id)} canReview={canReview} onDone={onDone} />)}
      </ul>
    </div>
  );
}

function SampleRow({ sampleId, approval: a, review, canReview, onDone }: { sampleId: string; approval: ReturnType<typeof db.getDB>['approvals'][number]; review?: ApproverSample['reviews'][number]; canReview: boolean; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const fid = useId();
  const [concern, setConcern] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const mins = a.decidedAt ? (new Date(a.decidedAt).getTime() - new Date(a.createdAt).getTime()) / 60_000 : 0;
  const opened = api.ops.openedBeforeDeciding(orgId, a);
  const go = async (ok: boolean) => {
    if (!user) return;
    setBusy(true);
    try {
      const s = api.ops.reviewSampledApproval(orgId, sampleId, a.id, ok, note, user.id);
      toast.ok(ok ? 'Recorded as sound' : 'Concern recorded', s.status === 'closed' ? `Every approval in the sample is reviewed; the sample is closed. Receipt #${n(s.closeSeq ?? 0)}.` : `Receipt #${n(s.reviews[s.reviews.length - 1].seq ?? 0)}.`);
      setConcern(false);
      setNote('');
      onDone();
    } catch (e) {
      toast.bad('Not recorded', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={cn('px-5 py-3', review && (review.ok ? 'bg-ok-bg/30' : 'bg-held-bg/30'))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/approvals/${a.id}`} className="text-sm font-medium hover:underline underline-offset-2">{a.headline}</Link>
          <p className="mt-0.5 text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <AgentLink slug={a.agentSlug} plain className="font-normal" />
            <span className="font-mono">{a.ruleId}</span>
            {a.amount !== undefined && <Money value={a.amount} />}
            <span>Decided in {minutes(mins)} via {channelLabel[a.channel ?? 'web'] ?? a.channel}</span>
            {!opened && <Badge tone="held">Record not opened</Badge>}
            {a.decisionReason && <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" aria-hidden />“{a.decisionReason}”</span>}
          </p>
        </div>
        {review ? (
          <span className="text-xs text-muted shrink-0">{review.ok ? 'Sound' : 'Concern'} · {userName(review.by)}{review.seq !== undefined && <> · <ReceiptLink seq={review.seq} /></>}</span>
        ) : canReview && !concern ? (
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="secondary" onClick={() => setConcern(true)}>Concern</Button>
            <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy} onClick={() => go(true)}>Sound</Button>
          </div>
        ) : null}
      </div>
      {review && !review.ok && review.note && <p className="mt-1 text-xs">“{review.note}”</p>}
      {concern && !review && (
        <div className="mt-3 space-y-2">
          <Field label="What concerns you" htmlFor={`${fid}-c`} required hint="Recorded on the approver.sample_reviewed receipt."><Textarea id={`${fid}-c`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus /></Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setConcern(false); setNote(''); }}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} disabled={note.trim().length < 8} onClick={() => go(false)}>Record the concern</Button>
          </div>
        </div>
      )}
    </li>
  );
}
