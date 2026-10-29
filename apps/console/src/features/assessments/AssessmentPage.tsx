import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, MessageSquareText, RotateCcw, Send, ShieldCheck, Trash2, UserX, X } from 'lucide-react';
import { api } from '@/api';
import { useQuery, useMutation } from '@/hooks/useQuery';
import { useCan, useOrgId, useUser } from '@/store/session';
import { useUi } from '@/store/ui';
import { userName } from '@/mock/users';
import type { AiSystem, AssessmentQuestion } from '@/types';
import { Badge, Banner, Button, Dialog, KeyValue, Meter, PageHeader, Panel, Skeleton, Field, Textarea, toast } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import { date, dateTime, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AssessmentStatusChip, KIND_LABEL, LifecycleChip, TIER_META, TierChip } from '@/features/inventory/governance';
import { admissionOf, bands, isAnswered, nextReviewDate, optionsFor, reviewMonths, summarise, variantOf, type AnswerOption } from './templates';
import { answerAssessment, assessment as loadAssessment, discardAssessment, reopenAssessment, reviewAssessment, submitAssessment, type ExtAssessment } from './backend';
import { SmartLink, useCanSee } from '@/shell/access';

export default function AssessmentPage() {
  const { id = '' } = useParams();
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const canAuthor = useCan('assessments.author');
  const canSign = useCan('assessments.signoff');
  const canSeePacks = useCanSee('/records/packs');
  const openAsk = useUi((s) => s.openAsk);
  const [note, setNote] = useState('');
  const [noteTried, setNoteTried] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState<string>();

  const q = useQuery((o) => loadAssessment(o, id), [id], { kinds: ['assessment', 'receipt', 'inventory'] });
  const inv = useQuery((o) => api.inventory(o));
  const review = useMutation((approve: boolean, text: string) => reviewAssessment(orgId, id, approve, text, user!.id));
  const submit = useMutation(() => submitAssessment(orgId, id, user!.id));
  const reopen = useMutation(() => reopenAssessment(orgId, id, user!.id));
  const discard = useMutation(() => discardAssessment(orgId, id, user!.id));

  const a = q.data?.assessment as ExtAssessment | undefined;
  const system: AiSystem | undefined = inv.data?.find((s) => s.id === a?.aiSystemId) ?? q.data?.system;

  const summary = useMemo(() => (a ? summarise(a) : undefined), [a]);
  const perQ = a ? Math.max(2, Math.round(a.maxScore / Math.max(1, a.questions.length))) : 5;
  const sections = useMemo(() => {
    if (!a) return [];
    const m = new Map<string, AssessmentQuestion[]>();
    a.questions.forEach((x) => m.set(x.section, [...(m.get(x.section) ?? []), x]));
    return Array.from(m.entries());
  }, [a]);

  /* ── states ─────────────────────────────────────────────── */

  if (q.error && !a) {
    return (
      <div>
        <PageHeader kicker="Records" title="Assessment" crumbs={[{ label: 'Assessments', to: '/assessments' }, { label: 'Not found' }]} />
        <Banner tone="bad" title="This assessment could not be opened" actions={<><Button size="sm" variant="secondary" onClick={q.refetch}>Try again</Button><Button size="sm" onClick={() => nav('/assessments')}>All assessments</Button></>}>{q.error.message}</Banner>
      </div>
    );
  }
  if (!a || !summary) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-10 w-[28rem] max-w-full" />
        <div className="grid gap-6 lg:grid-cols-12"><Skeleton className="h-[480px] lg:col-span-8" /><Skeleton className="h-[480px] lg:col-span-4" /></div>
      </div>
    );
  }

  const tpl = variantOf(a);
  const admission = tpl.kind === 'admission';
  const adm = admission ? admissionOf(a) : undefined;
  const editable = a.status === 'draft' && canAuthor;
  // the author or whoever submitted it: neither signs it off
  const isAuthor = user?.id === a.authorId || (!!user && user.id === a.submittedBy);
  const resultTier = a.status === 'draft' || a.status === 'changes_requested' ? summary.tier : a.resultTier;
  const months = reviewMonths(resultTier);
  const reviewDate = nextReviewDate(resultTier);

  /* ── actions ────────────────────────────────────────────── */

  const answer = async (qq: AssessmentQuestion, opt: AnswerOption) => {
    if (!user) return;
    setSaving(qq.id);
    try {
      await answerAssessment(orgId, a.id, qq.id, opt.label, user.id);
      q.refetch();
    } catch (e) {
      toast.bad('The answer was not saved', (e as Error).message);
    } finally {
      setSaving(undefined);
    }
  };

  const onSubmit = async () => {
    if (!user || !summary.complete) return;
    try {
      const r = await submit.mutate();
      toast.ok('Submitted for sign-off', admission ? `${adm!.met} of ${adm!.total} gates met. A different person must approve before ${tpl.packId} is admitted. Receipt #${r.submittedSeq}.` : `${summary.score} of ${a.maxScore} points — ${TIER_META[summary.tier].label}. A different person must sign it off. Receipt #${r.submittedSeq}.`);
    } catch (e) { toast.bad('Not submitted', (e as Error).message); }
  };

  const decide = async (approve: boolean) => {
    setNoteTried(true);
    if (!user || note.trim().length < 4) return;
    try {
      const r = await review.mutate(approve, note.trim());
      setNote('');
      setNoteTried(false);
      if (approve && admission) toast.ok(`${tpl.packId} admitted`, `${system?.name ?? 'The system'}'s agent may now have ${tpl.packId}'s rules enabled. The admission is receipt #${r.assessment.admittedSeq}.`);
      else if (approve) toast.ok('Assessment approved', `${system?.name ?? 'The system'} is now ${TIER_META[r.assessment.resultTier].label.toLowerCase()}. Next review ${r.system?.nextReview ? date(r.system.nextReview) : date(reviewDate)}. Receipt #${r.assessment.reviewSeq}.`);
      else toast.held('Changes requested', `${userName(a.authorId)} can reopen the draft and answer again.`);
    } catch { /* shown in the panel */ }
  };

  const onReopen = async () => {
    try { await reopen.mutate(); toast.info('Draft reopened', 'Change the answers, then submit again.'); }
    catch (e) { toast.bad('Not reopened', (e as Error).message); }
  };

  const onDiscard = async () => {
    try { await discard.mutate(); setConfirmDiscard(false); toast.info('Draft discarded', 'The started receipt stays on the chain.'); nav('/assessments'); }
    catch (e) { toast.bad('Not discarded', (e as Error).message); }
  };

  const firstUnanswered = a.questions.find((x) => !isAnswered(x));

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Assessments', to: '/assessments' }, ...(system ? [{ label: system.name, to: `/inventory/${system.id}` }] : []), { label: tpl.label }]}
        kicker="Records · Assessment"
        title={<>{tpl.label}{system && <span className="text-muted font-semibold"> — {system.name}</span>}</>}
        description={tpl.purpose}
        meta={
          <>
            <AssessmentStatusChip status={a.status} size="md" />
            {admission ? <Badge tone={adm!.admitted ? 'ok' : 'neutral'}>{adm!.met} of {adm!.total} gates met</Badge> : <TierChip tier={resultTier} size="md" />}
            {(a.status === 'draft' || a.status === 'changes_requested') && <span className="text-xs text-muted">Provisional result</span>}
            {tpl.profileId && <SmartLink to="/assurance/profiles" plainClassName="text-xs text-muted" className="text-xs text-muted underline underline-offset-2">Profile <span className="font-mono">{tpl.profileId}</span></SmartLink>}
            <span className="text-sm text-muted ml-1">Author</span><Person id={a.authorId} size={22} />
          </>
        }
        actions={
          <>
            <Button variant="ghost" icon={<MessageSquareText className="h-4 w-4" />} onClick={() => openAsk({ kind: 'assessment', title: `Explain the ${tpl.label.toLowerCase()} result for ${system?.name ?? 'this system'}`, payload: { assessment: a, systemName: system?.name } })}>Ask about this result</Button>
            {admission && tpl.packId && canSeePacks && <Button variant="secondary" onClick={() => nav(`/records/packs/${tpl.packId}`)}>Open {tpl.packId}</Button>}
            {system && <Button variant="secondary" onClick={() => nav(`/inventory/${system.id}`)}>Open AI system</Button>}
          </>
        }
      />

      {a.status === 'changes_requested' && (
        <Banner tone="bad" className="mb-6" title={`Changes requested by ${userName(a.reviewerId)}`} actions={canAuthor ? <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={reopen.pending} onClick={onReopen}>Reopen as draft</Button> : undefined}>
          {a.reviewNote ? <>“{a.reviewNote}”</> : 'No note was recorded.'} {a.reviewedAt && <span className="text-muted">— {dateTime(a.reviewedAt)}</span>}
        </Banner>
      )}
      {a.status === 'draft' && !canAuthor && (
        <Banner tone="neutral" className="mb-6" title="Read-only">Owners, admins and approvers answer assessments. Your role can read them.</Banner>
      )}
      {inv.error && <Banner tone="bad" className="mb-6" title="The AI inventory did not load" actions={<Button size="sm" onClick={inv.refetch}>Try again</Button>}>{inv.error.message}</Banner>}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Questions */}
        <div className="lg:col-span-8 space-y-6 min-w-0">
          {editable && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-sunken/50 px-4 py-3 text-sm">
              <span><span className="font-medium">{summary.answered} of {plural(summary.total, admission ? 'gate' : 'question')} answered.</span> <span className="text-muted">Each answer is saved to the organisation's record as you choose it; everyone sees the same draft.</span></span>
              {firstUnanswered && <a href={`#q-${firstUnanswered.id}`} className="text-sm font-medium underline underline-offset-2">Next unanswered</a>}
            </div>
          )}

          {sections.map(([section, qs]) => {
            const sub = qs.reduce((s, x) => s + (isAnswered(x) ? x.points : 0), 0);
            const subMax = qs.reduce((s, x) => s + Math.max(x.points, ...optionsFor(x, a.template, perQ).map((o) => o.points)), 0);
            return (
              <Panel key={section} kicker={admission ? 'Gate' : 'Section'} title={section} actions={admission ? undefined : <span className="text-sm num text-muted"><span className="text-fg font-semibold">{sub}</span> of {subMax} points</span>} flush>
                <ol className="divide-y divide-line">
                  {qs.map((x) => {
                    const idx = a.questions.indexOf(x) + 1;
                    const opts = optionsFor(x, a.template, perQ);
                    const max = Math.max(x.points, ...opts.map((o) => o.points));
                    const answered = isAnswered(x);
                    const chosen = opts.find((o) => o.label === x.answer);
                    const why = x.explanation && x.explanation !== 'Unanswered.' ? x.explanation : chosen?.explanation;
                    return (
                      <li key={x.id} id={`q-${x.id}`} className="px-5 py-4 scroll-mt-24">
                        <div className="flex items-start gap-4">
                          <span className="font-mono text-xs text-subtle mt-0.5 w-6 shrink-0">{String(idx).padStart(2, '0')}</span>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium leading-snug">{x.text}</p>
                            {editable && answered && !chosen && (
                              <p className="mt-1.5 text-sm">{x.answer} <span className="text-xs text-muted">— recorded answer; choose below to replace it</span></p>
                            )}
                            {editable ? (
                              <div role="radiogroup" aria-label={x.text} aria-busy={saving === x.id} className="mt-3 grid gap-1.5">
                                {opts.map((opt) => {
                                  const on = x.answer === opt.label;
                                  return (
                                    <button key={opt.label} type="button" role="radio" aria-checked={on} disabled={!!saving} aria-label={admission ? opt.label : `${opt.label}, ${opt.points} ${opt.points === 1 ? 'point' : 'points'}`} onClick={() => answer(x, opt)}
                                      className={cn('flex items-center justify-between gap-3 border px-3 py-2 text-left text-sm transition-colors disabled:opacity-70', on ? 'border-fg bg-surface shadow-[inset_0_0_0_1px_rgb(var(--fg))]' : 'border-line hover:border-line-strong bg-surface')}>
                                      <span className="flex items-center gap-2 min-w-0">
                                        <span className={cn('h-3.5 w-3.5 border flex items-center justify-center shrink-0', on ? 'border-fg' : 'border-line-strong')}>{on && <span className="h-1.5 w-1.5 bg-fg" />}</span>
                                        <span>{opt.label}</span>
                                        {opt.prohibited && <Badge tone="bad">Unacceptable</Badge>}
                                      </span>
                                      {!admission && <span className="num text-xs text-muted shrink-0">+{opt.points}</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className={cn('mt-1.5 text-sm', answered ? 'text-fg' : 'text-subtle italic')}>{answered ? x.answer : 'Unanswered'}</p>
                            )}
                            {answered && (
                              <p className="mt-2 text-xs text-muted leading-relaxed"><span className="label mr-1.5">Why</span>{why || `Scored ${x.points} of ${max} on this question’s answer scale.`}</p>
                            )}
                          </div>
                          <div className="w-16 shrink-0 text-right">
                            {admission ? (
                              <p className={cn('text-sm font-semibold', !answered ? 'text-subtle' : x.answer === 'Met' ? 'text-ok-fg' : 'text-bad-fg')}>{!answered ? '—' : x.answer === 'Met' ? 'Met' : 'Not met'}</p>
                            ) : (
                              <>
                                <p className={cn('font-display text-xl font-semibold num leading-none', !answered && 'text-subtle')}>{answered ? `+${x.points}` : '—'}</p>
                                <p className="text-[11px] text-subtle num mt-1">of {max}</p>
                                <Meter className="mt-1.5" value={answered ? x.points / Math.max(1, max) : 0} tone="inverse" label={`${x.points} of ${max} points`} />
                              </>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Panel>
            );
          })}

          {editable && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-surface px-5 py-4">
              <div className="text-sm">
                <p className="font-medium">{summary.complete ? 'Ready to submit' : `${summary.total - summary.answered} ${summary.total - summary.answered === 1 ? 'answer' : 'answers'} left`}</p>
                <p className="text-muted">Submitting records an <span className="font-mono">assessment.submitted</span> receipt and asks a different person to sign off.</p>
              </div>
              <div className="flex gap-2">
                <Button variant="quiet-danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDiscard(true)}>Discard draft</Button>
                <Button variant="primary" icon={<Send className="h-4 w-4" />} disabled={!summary.complete} loading={submit.pending} title={summary.complete ? undefined : 'Answer every question first'} onClick={onSubmit}>Submit for sign-off</Button>
              </div>
            </div>
          )}
          {a.status === 'submitted' && isAuthor && canAuthor && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-surface px-5 py-4 text-sm">
              <p className="text-muted">Need to change an answer? Take it back to draft; it leaves the sign-off queue until you submit again.</p>
              <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} loading={reopen.pending} onClick={onReopen}>Take back to draft</Button>
            </div>
          )}
        </div>

        {/* Score and sign-off */}
        <div className="lg:col-span-4 min-w-0">
          <div className="space-y-6 lg:sticky lg:top-20">
            {admission ? (
              <Panel kicker="Result" title="Admission gates">
                <p className="font-display text-5xl font-semibold tracking-tighter2 num leading-none" aria-live="polite">{adm!.met}<span className="text-xl text-muted font-medium"> / {adm!.total} met</span></p>
                <ul className="mt-4 space-y-1.5 text-sm">
                  {a.questions.map((x) => (
                    <li key={x.id} className="flex items-center justify-between gap-3">
                      <a href={`#q-${x.id}`} className="min-w-0 text-muted hover:text-fg truncate">{x.section}</a>
                      <span className={cn('shrink-0 text-xs font-medium inline-flex items-center gap-1', x.answer === 'Met' ? 'text-ok-fg' : x.answer ? 'text-bad-fg' : 'text-subtle')}>{x.answer === 'Met' ? <Check className="h-3 w-3" aria-hidden /> : x.answer ? <X className="h-3 w-3" aria-hidden /> : null}{x.answer || 'Unanswered'}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 pt-3 border-t border-line text-xs text-muted">All 5 gates must be met. Approval admits {tpl.packId} for this system's agent; it does not change the system's risk tier.</p>
              </Panel>
            ) : (
              <Panel kicker="Score" title={a.status === 'draft' ? 'Live score' : 'Total score'}>
                <div className="flex items-end justify-between gap-3">
                  <p className="font-display text-5xl font-semibold tracking-tighter2 num leading-none" aria-live="polite">{summary.score}<span className="text-xl text-muted font-medium"> / {a.maxScore}</span></p>
                  <TierChip tier={resultTier} size="md" />
                </div>
                <ThresholdScale score={summary.score} max={a.maxScore} />
                {!summary.complete && <p className="mt-3 text-xs text-held-fg">Provisional: {summary.answered} of {summary.total} answered. Unanswered questions add 0.</p>}
                {summary.prohibited && <p className="mt-3 text-xs text-bad-fg font-medium">A prohibited-practice answer makes the result Unacceptable whatever the total.</p>}
                <div className="mt-5">
                  <p className="label mb-2">Every answer that added to the score</p>
                  <ul className="space-y-1.5">
                    {a.questions.filter((x) => isAnswered(x) && x.points > 0).sort((p, r) => r.points - p.points).map((x) => (
                      <li key={x.id} className="flex items-start justify-between gap-3 text-sm">
                        <a href={`#q-${x.id}`} className="min-w-0 text-muted hover:text-fg line-clamp-2">{x.text}</a>
                        <span className="num font-medium shrink-0">+{x.points}</span>
                      </li>
                    ))}
                    {a.questions.every((x) => !isAnswered(x) || x.points === 0) && <li className="text-sm text-subtle">No answer has added points yet.</li>}
                  </ul>
                </div>
                <p className="mt-4 pt-3 border-t border-line text-xs text-muted">Deterministic: the same answers always give the same score. No model is involved in scoring.</p>
              </Panel>
            )}

            <SignOff
              a={a}
              admission={admission}
              admitted={!!adm?.admitted}
              canSign={canSign}
              isAuthor={isAuthor}
              systemName={system?.name}
              resultTier={resultTier}
              reviewDate={reviewDate}
              months={months}
              note={note}
              setNote={setNote}
              noteError={noteTried && note.trim().length < 4 ? 'Write a note for the record: what you checked, or what must change.' : undefined}
              error={review.error?.message}
              pending={review.pending}
              onDecide={decide}
              nextReview={system?.nextReview}
            />

            {system && (
              <Panel title="AI system" flush>
                <Link to={`/inventory/${system.id}`} className="block px-5 py-4 hover:bg-sunken/60">
                  <p className="font-medium">{system.name}</p>
                  <p className="text-xs text-muted mt-0.5">{KIND_LABEL[system.kind]} · {system.businessUnit}</p>
                  <div className="mt-3 flex flex-wrap gap-2"><LifecycleChip stage={system.lifecycle} /><TierChip tier={system.riskTier} /></div>
                </Link>
              </Panel>
            )}

            <Panel title="On the chain">
              <KeyValue items={[
                { k: 'Started', v: a.startedSeq ? <ReceiptLink seq={a.startedSeq} /> : date(a.createdAt) },
                ...(a.submittedSeq ? [{ k: 'Submitted', v: <ReceiptLink seq={a.submittedSeq} /> }] : []),
                ...(a.reviewSeq ? [{ k: a.status === 'approved' ? 'Approved' : 'Reviewed', v: <ReceiptLink seq={a.reviewSeq} /> }] : []),
                ...(a.admittedSeq ? [{ k: 'Pack admitted', v: <ReceiptLink seq={a.admittedSeq} /> }] : []),
              ]} />
            </Panel>
          </div>
        </div>
      </div>

      <Dialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} size="sm" tone="danger"
        title="Discard this draft?"
        description="The draft and its answers are removed for everyone. The assessment.started receipt stays on the chain, and the discard is recorded."
        footer={<><Button variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep it</Button><Button variant="danger" loading={discard.pending} onClick={onDiscard}>Discard</Button></>}
      />
    </div>
  );
}

/** A 0…max scale with the three bands and a marker at the score. */
function ThresholdScale({ score, max }: { score: number; max: number }) {
  const b = bands(max);
  const tone = { minimal: 'bg-ok/70', limited: 'bg-held/80', high: 'bg-bad/75' } as Record<string, string>;
  const at = Math.min(100, (score / max) * 100);
  return (
    <div className="mt-5" aria-label={`Score ${score} of ${max}. Thresholds: ${b.map((x) => `${TIER_META[x.tier].label} ${x.from} to ${x.to}`).join(', ')}.`} role="img">
      <div className="relative">
        <div className="flex h-2.5 gap-px">
          {b.map((x) => <div key={x.tier} className={tone[x.tier]} style={{ width: `${((x.to - x.from + 1) / (max + 1)) * 100}%` }} />)}
        </div>
        <span className="absolute -top-1.5 h-[22px] w-[3px] bg-fg" style={{ left: `calc(${at}% - 1.5px)` }} aria-hidden />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        {b.map((x) => (
          <div key={x.tier} className={cn(score >= x.from && score <= x.to ? 'text-fg font-semibold' : 'text-muted')}>
            <span className="block">{TIER_META[x.tier].label.replace(' risk', '')}</span>
            <span className="num">{x.from}–{x.to}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SignOff({ a, admission, admitted, canSign, isAuthor, systemName, resultTier, reviewDate, months, note, setNote, noteError, error, pending, onDecide, nextReview }: {
  a: ExtAssessment; admission: boolean; admitted: boolean; canSign: boolean; isAuthor: boolean; systemName?: string; resultTier: ExtAssessment['resultTier']; reviewDate: string; months: number;
  note: string; setNote: (v: string) => void; noteError?: string; error?: string; pending: boolean; onDecide: (approve: boolean) => void; nextReview?: string;
}) {
  if (a.status === 'approved') {
    return (
      <Panel kicker="Sign-off" title={admission ? 'Admitted' : 'Approved'} tone="default">
        <div className="flex items-center gap-2 text-sm text-ok-fg font-medium mb-3"><ShieldCheck className="h-4 w-4" aria-hidden />Signed off by a different person</div>
        <KeyValue items={[
          { k: 'Approved by', v: <Person id={a.reviewerId} size={20} /> },
          { k: 'Approved', v: a.reviewedAt ? <span title={dateTime(a.reviewedAt)}>{date(a.reviewedAt)}</span> : '—' },
          { k: 'Written by', v: <Person id={a.authorId} size={20} /> },
          { k: 'Submitted', v: a.submittedAt ? date(a.submittedAt) : '—' },
          ...(admission ? [{ k: 'Pack', v: <span className="font-mono">{a.packId}</span> }] : [
            { k: 'Tier set on the system', v: <TierChip tier={a.resultTier} /> },
            { k: 'Next review', v: nextReview ? date(nextReview) : '—' },
          ]),
        ]} />
        {a.reviewNote && <blockquote className="mt-4 border-l-[3px] border-line-strong pl-3 text-sm text-muted">“{a.reviewNote}”</blockquote>}
      </Panel>
    );
  }
  if (a.status === 'draft' || a.status === 'changes_requested') {
    return (
      <Panel kicker="Sign-off" title="Not submitted">
        <p className="text-sm text-muted leading-relaxed">When every {admission ? 'gate' : 'question'} is answered, the author submits it. Then an owner or admin who did not write it approves it or asks for changes, with a note.</p>
        <ol className="mt-4 space-y-2 text-sm">
          {(admission ? ['Answer every gate', 'Submit for sign-off', 'A different person approves', 'The pack is admitted for the agent'] : ['Answer every question', 'Submit for sign-off', 'A different person approves', 'Tier and next review are set']).map((s, i) => (
            <li key={s} className="flex items-center gap-2.5"><span className={cn('inline-flex h-5 w-5 items-center justify-center text-[11px] font-semibold border num', i === 0 && a.status === 'draft' ? 'bg-fg text-canvas border-fg' : 'border-line-strong text-muted')}>{i + 1}</span>{s}</li>
          ))}
        </ol>
      </Panel>
    );
  }
  // submitted
  return (
    <Panel kicker="Sign-off" title="Waiting for sign-off">
      <KeyValue items={[
        { k: 'Written by', v: <Person id={a.authorId} size={20} /> },
        { k: 'Submitted', v: <When iso={a.submittedAt} /> },
        { k: 'Result', v: admission ? (admitted ? 'All gates met' : 'Gates not met') : <TierChip tier={resultTier} /> },
      ]} />
      {isAuthor ? (
        <div className="mt-4 flex items-start gap-2.5 border border-held/50 bg-held-bg px-3 py-3 text-sm">
          <UserX className="h-4 w-4 text-held-fg shrink-0 mt-0.5" aria-hidden />
          <p><span className="font-semibold">You {a.submittedBy && a.submittedBy !== a.authorId ? 'wrote or submitted' : 'wrote'} this assessment. A different person must sign off.</span> <span className="text-fg/80">Ask an owner or admin to review it. It is in their Work › Reviews queue.</span></p>
        </div>
      ) : !canSign ? (
        <p className="mt-4 text-sm text-muted border border-line bg-sunken/50 px-3 py-3">Owners and admins sign off assessments, and never their own. Your role can read this one.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {error && <Banner tone="bad" title="Sign-off was not recorded">{error}</Banner>}
          <p className="text-sm text-muted leading-relaxed">
            {admission
              ? admitted ? <>Approving admits <span className="text-fg font-medium font-mono">{a.packId}</span> for {systemName ?? 'the system'}'s agent and records a <span className="font-mono">pack.admitted</span> receipt.</> : <>Some gates are not met, so the pack cannot be admitted. Request changes.</>
              : <>Approving sets <span className="text-fg font-medium">{systemName ?? 'the system'}</span> to <span className="text-fg font-medium">{TIER_META[resultTier].label.toLowerCase()}</span> and its next review to <span className="text-fg font-medium num">{date(reviewDate)}</span> ({months} months).</>}
          </p>
          <Field label="Note for the record" required htmlFor="signoff-note" error={noteError} hint="Recorded with the sign-off receipt.">
            <Textarea id="signoff-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, or what must change" invalid={!!noteError} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="quiet-danger" size="lg" icon={<X className="h-4 w-4" />} disabled={pending} onClick={() => onDecide(false)}>Request changes</Button>
            <Button variant="primary" size="lg" icon={<Check className="h-4 w-4" />} loading={pending} disabled={admission && !admitted} title={admission && !admitted ? 'Every gate must be met before a pack is admitted' : undefined} onClick={() => onDecide(true)}>Approve</Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
