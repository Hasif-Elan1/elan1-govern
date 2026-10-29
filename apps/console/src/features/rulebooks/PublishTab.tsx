import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Circle, AlertTriangle, PenTool, ShieldCheck, ArrowRight, Lock, Send, Undo2, Users } from 'lucide-react';
import type { Agent, ReviewRequest, Rule, Rulebook, RulebookVersion, RuleSuggestion } from '@/types';
import { api } from '@/api';
import { can } from '@/lib/permissions';
import { atLeast } from '@/lib/levels';
import { autonomyRank } from '@/lib/autonomy';
import { userName } from '@/mock/users';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser, needsReauth, markReauth } from '@/store/session';
import { cn } from '@/lib/cn';
import { n, relative } from '@/lib/format';
import { Banner, Button, Field, Hash, Input, Panel, Skeleton, Textarea, toast } from '@/components/ui';
import { AgentLink, Person, ReceiptLink, RouteMode, When } from '@/components/domain';
import { builderExtra, diffSummary, replayHeadline, semDiff, toolsForRule, validateRules, type Problem } from './lib';
import { SemanticDiffList } from './parts';
import { useReplayOff, type TestRun } from './TestTab';
import type { Extras } from './yamlSync';
import { dualControl, reauth as checkPassword } from '@/features/work/backend';
import { claimDetail, UpgradePath } from '@/features/work/level';
import { SmartLink } from '@/shell/access';

type State = 'pass' | 'fail' | 'warn' | 'todo';

function StateIcon({ s }: { s: State }) {
  const map: Record<State, { icon: ReactNode; cls: string; label: string }> = {
    pass: { icon: <Check className="h-3.5 w-3.5" aria-hidden />, cls: 'bg-ok-bg text-ok-fg border-ok/40', label: 'Done' },
    fail: { icon: <X className="h-3.5 w-3.5" aria-hidden />, cls: 'bg-bad-bg text-bad-fg border-bad/40', label: 'Blocking' },
    warn: { icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />, cls: 'bg-held-bg text-held-fg border-held/50', label: 'Attention' },
    todo: { icon: <Circle className="h-3 w-3" aria-hidden />, cls: 'bg-surface text-muted border-line-strong/60', label: 'To do' },
  };
  const m = map[s];
  return <span className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center border', m.cls)} title={m.label} aria-label={m.label}>{m.icon}</span>;
}

function Item({ state, title, summary, children, action }: { state: State; title: string; summary: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <li className="relative pl-10 pb-6 last:pb-0">
      <span className="absolute left-[11px] top-7 bottom-0 w-px bg-line" aria-hidden />
      <span className="absolute left-0 top-0"><StateIcon s={state} /></span>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-md font-semibold leading-6">{title}</h3>
          <div className="text-sm text-muted mt-0.5">{summary}</div>
        </div>
        {action}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </li>
  );
}

/**
 * Sign and publish, with dual control. The author sends the draft for review; a different person reads the change
 * and the test result and approves it (or asks for changes); only then is the version signed and published.
 * From L2 Attested this is enforced; at L1 Guarded the review is recorded on the version and its receipt, and an
 * owner can make it required by policy.
 */
export function PublishTab({ rb, agent, rules, extras, yaml, yamlOk, dirty, draft, draftVersionNo, published, testRun, rulesKey, canPublish, readOnlyReason, suggestion, goTab, onPublished, reviews, onReviewsChanged }: {
  rb: Rulebook; agent: Agent; rules: Rule[]; extras: Extras; yaml: string; yamlOk: boolean; dirty: boolean; draft?: RulebookVersion; draftVersionNo: number; published?: RulebookVersion;
  testRun?: TestRun; rulesKey: string; canPublish: boolean; readOnlyReason?: string; suggestion?: RuleSuggestion;
  goTab: (t: 'rules' | 'yaml' | 'test') => void; onPublished: () => void; reviews: ReviewRequest[]; onReviewsChanged: () => void;
}) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided: at L1 a version is sealed and published.
  const sl = atLeast(level, 'l2');
  const signsAndPublishes = sl ? 'signs and publishes' : 'publishes';
  const canEdit = useCan('rulebooks.edit');
  const cleanNote = (s?: string) => { const x = (s ?? '').replace(/^Draft:\s*/i, ''); return x.charAt(0).toUpperCase() + x.slice(1); };
  const [note, setNote] = useState(cleanNote(draft?.note));
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string>();
  const [busy, setBusy] = useState<'publish' | 'request' | 'review' | undefined>();
  const [reviewNote, setReviewNote] = useState('');
  const [done, setDone] = useState<{ v: RulebookVersion; seq?: number }>();
  const [reauth] = useState(() => needsReauth());
  const dc = dualControl(orgId);

  useEffect(() => { setNote(cleanNote(draft?.note)); }, [draft?.version, draft?.note]);

  const membersQ = useQuery((o) => api.members(o), [], { live: false });
  const evidenceQ = useQuery(async (o) => {
    if (!atLeast(level, 'l2')) return undefined;
    const [anchors, custody, grants] = await Promise.all([api.anchors(o, 1).catch(() => undefined), api.custody(o).catch(() => undefined), atLeast(level, 'l3') ? api.grants(o).catch(() => undefined) : undefined]);
    return { tsas: anchors?.authorities.map((a) => a.name), custody: custody?.provider, grants };
  }, [level], { live: false });

  const diff = useMemo(() => semDiff(published?.rules ?? [], rules), [published, rules]);
  const textChanged = yaml.trim() !== (published?.yaml ?? '').trim();
  const problems: Problem[] = useMemo(() => {
    const out = validateRules(rules, agent, extras.rules);
    // earned autonomy (L3): a rule's minimum autonomy against the agent's grants for the tools it reaches
    const rows = evidenceQ.data?.grants?.rows.filter((r) => r.agentSlug === agent.slug) ?? [];
    if (rows.length) {
      for (const r of rules) {
        const min = builderExtra(extras.rules[r.id]).requires_autonomy;
        if (!min) continue;
        const below = toolsForRule(r, agent.tools).map((t) => rows.find((x) => x.tool === t.name)).filter((x): x is NonNullable<typeof x> => !!x && autonomyRank(x.level) < autonomyRank(min as 'A0'));
        if (below.length) out.push({ level: 'warning', ruleId: r.id, text: `${r.id}: needs ${min}, but ${agent.slug} has ${below.map((b) => `${b.label} for ${b.tool}`).join(', ')}. No one sets a level: until the write type graduates (Agents › Autonomy) the calls stay refused or held.` });
      }
    }
    return out;
  }, [rules, agent, extras.rules, evidenceQ.data]);
  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warning');
  const tested = testRun && testRun.key === rulesKey;
  // replay store off: no test is possible, so the step is a recorded note rather than a dead end
  const replayOff = useReplayOff();
  const testWaived = !tested && replayOff;

  // dual control: the review for this version
  const mine = reviews.filter((r) => r.rulebookId === rb.id && r.version === draftVersionNo);
  const pending = mine.find((r) => r.status === 'pending');
  const approved = mine.find((r) => r.status === 'approved');
  const sentBack = mine.find((r) => r.status === 'changes_requested');
  const requester = pending?.requestedBy ?? approved?.requestedBy ?? draft?.createdBy;
  const reviewers = (membersQ.data ?? []).filter((m) => m.status === 'active' && can(m.role, 'rulebooks.review') && m.userId !== requester && m.userId !== user?.id);
  const iAmReviewer = !!pending && !!user && pending.requestedBy !== user.id && can(user.role, 'rulebooks.review');
  const iReviewed = !!approved && approved.reviewerId === user?.id;

  let reviewState: State;
  let reviewSummary: ReactNode;
  if (dirty && (pending || approved)) {
    reviewState = dc.enforced ? 'fail' : 'warn';
    reviewSummary = 'The rules changed after the review was asked for. Send the draft for review again.';
  } else if (approved) {
    reviewState = dc.enforced && iReviewed ? 'fail' : 'pass';
    reviewSummary = <>Approved by <span className="text-fg font-medium">{userName(approved.reviewerId)}</span>{approved.decidedAt && <> {relative(approved.decidedAt)}</>}{approved.decisionNote ? <> — “{approved.decisionNote}”</> : null}.{dc.enforced && iReviewed ? ` You reviewed this version; a different person ${signsAndPublishes} it.` : ''}</>;
  } else if (pending) {
    reviewState = 'todo';
    reviewSummary = <>Waiting for a second person since {relative(pending.requestedAt)}. Asked by {userName(pending.requestedBy)}.</>;
  } else if (sentBack) {
    reviewState = dc.enforced ? 'fail' : 'warn';
    reviewSummary = <>{userName(sentBack.reviewerId)} asked for changes{sentBack.decisionNote ? <>: “{sentBack.decisionNote}”</> : ''}. Change the draft and send it again.</>;
  } else {
    reviewState = dc.enforced ? 'todo' : 'warn';
    reviewSummary = dc.enforced ? `Required. A different person approves this version before it can be ${sl ? 'signed' : 'published'}.` : 'Recorded at L1, not enforced. Without a review the receipt records reviewed_by as empty.';
  }

  const states = {
    changes: (diff.length || textChanged ? 'pass' : 'fail') as State,
    checks: (errors.length ? 'fail' : warnings.length ? 'warn' : 'pass') as State,
    yaml: (yamlOk ? 'pass' : 'fail') as State,
    test: (tested ? 'pass' : testWaived ? 'warn' : testRun ? 'fail' : 'todo') as State,
    review: reviewState,
    reauth: (!reauth || password.length > 0 ? 'pass' : 'todo') as State,
    note: (note.trim().length >= 4 ? 'pass' : 'todo') as State,
  };
  const ready = canPublish && Object.values(states).every((s) => s === 'pass' || s === 'warn');
  const canRequest = canEdit && !!user && (!pending || dirty) && yamlOk && (diff.length > 0 || textChanged) && note.trim().length >= 4;

  const requestReview = async () => {
    if (!user) return;
    setBusy('request');
    try {
      if (dirty || !draft) await api.saveDraft(orgId, rb.id, yaml, rules, `Draft: ${note.trim()}`, user.id);
      await api.requestReview(orgId, rb.id, user.id, note.trim());
      onReviewsChanged();
      toast.ok('Sent for review', `Draft v${draftVersionNo} is in review. It appears in Work › Reviews for ${reviewers.length ? reviewers.map((r) => userName(r.userId)).slice(0, 3).join(', ') : 'a different owner or admin'}. Recorded as review.requested.`);
    } catch (e) {
      toast.bad('Not sent for review', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const decideReview = async (approve: boolean) => {
    if (!user || !pending) return;
    if (!approve && reviewNote.trim().length < 10) { toast.bad('Say what needs to change', 'Write at least a sentence for the author.'); return; }
    setBusy('review');
    try {
      await api.approveReview(orgId, pending.id, user.id, approve, reviewNote.trim());
      setReviewNote('');
      onReviewsChanged();
      toast.ok(approve ? 'Version approved' : 'Changes requested', approve ? `Recorded as review.approved. A different person from you can now ${sl ? 'sign and publish' : 'publish'}.` : 'Recorded as review.changes_requested. The draft goes back to its author.');
    } catch (e) {
      toast.bad('Review not recorded', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const publish = async () => {
    if (!user || !ready) return;
    setBusy('publish');
    setPwError(undefined);
    try {
      if (reauth) {
        try {
          await checkPassword(user.id, password);
        } catch (e) {
          setPwError((e as Error).message);
          return;
        }
        markReauth();
      }
      if (dc.enforced && !approved) throw new Error('Dual control: a different person must approve a review of this version before it is published.');
      const v = await api.publish(orgId, rb.id, yaml, rules, note.trim(), user.id, approved?.reviewerId);
      const rec = await api.receipts(orgId, { agent: rb.slug, kind: 'admin', q: 'rulebook.published', limit: 1 });
      setDone({ v, seq: rec.items[0]?.seq });
      setPassword('');
      onReviewsChanged();
      toast.ok(`Version ${v.version} ${sl ? 'signed and published' : 'published'}`, `Every call from ${rb.slug} now verifies this ${sl ? 'signature' : 'version’s seal'}.`);
      onPublished();
    } catch (e) {
      toast.bad('Not published', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const claim = claimDetail(level, evidenceQ.data?.tsas, evidenceQ.data?.custody);

  if (done) {
    return (
      <Panel tone="inverse" className="max-w-3xl">
        <div className="flex items-start gap-4">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center border border-ink-600 text-ember"><ShieldCheck className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0 space-y-3">
            <p className="label text-ink-300">Published</p>
            <h2 className="text-2xl font-semibold text-paper">Version {done.v.version} is live for {rb.slug}</h2>
            <p className="text-ink-200 text-sm leading-relaxed">{sl ? 'Signed' : 'Published'} by {userName(done.v.signedBy)}{done.v.reviewedBy ? `, reviewed by ${userName(done.v.reviewedBy)}` : ', with no second-person review recorded'}. {sl
              ? 'The guard verifies this signature on every call; a call is decided only against a rulebook whose signature checks out.'
              : 'The guard verifies this version’s Ed25519 seal on every call; a call is decided only against a rulebook whose seal checks out.'}</p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="text-ink-300">Hash <span className="font-mono text-paper break-all">{done.v.hash}</span></span>
              {done.seq && <span className="text-ink-300">Recorded as receipt <Link className="font-mono text-paper underline underline-offset-2" to={`/activity/${done.seq}`}>#{n(done.seq)}</Link></span>}
            </div>
            <p className="text-xs text-ink-300">{claim}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="inverse" size="sm" onClick={() => { setDone(undefined); goTab('rules'); }}>Back to the rules</Button>
              <Link to={`/agents/${rb.slug}`} className="inline-flex items-center gap-1 h-8 px-3 text-sm text-paper border border-ink-600 hover:bg-ink-700">Open {rb.slug} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
            </div>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="lg:col-span-8 min-w-0">
        {!canPublish && (
          <Banner tone="neutral" className="mb-5" title="Read only">{readOnlyReason ?? `Owners and admins ${sl ? 'sign and publish' : 'publish'} rulebooks.`} You can read every check below.</Banner>
        )}
        <Panel title={`${sl ? 'Sign and publish' : 'Publish'} version ${draftVersionNo}`} kicker="Publish checklist">
          <ol>
            <Item state={states.changes} title="Changes since the live version" action={<Button size="sm" variant="ghost" onClick={() => goTab('rules')}>Open rules</Button>}
              summary={diff.length ? `${diffSummary(diff)} against published v${published?.version}.` : textChanged ? 'Wording, lists or comments changed; no rule decides differently.' : `Nothing to publish — the draft matches published v${published?.version}.`}>
              {published && diff.length > 0 && <SemanticDiffList before={published.rules} after={rules} />}
            </Item>

            <Item state={states.checks} title="Rulebook checks" action={<Button size="sm" variant="ghost" onClick={() => goTab('rules')}>Fix in rules</Button>}
              summary={errors.length ? `${errors.length} ${errors.length === 1 ? 'problem blocks' : 'problems block'} publishing.` : warnings.length ? `Passes, with ${warnings.length} ${warnings.length === 1 ? 'note' : 'notes'}.` : 'Tool names are known, every ask has an approver group with members, backup groups are valid, approve-in-chat is only where allowed, and high-impact tools are held or refused.'}>
              {problems.length > 0 && (
                <ul className="border border-line divide-y divide-line">
                  {problems.map((p, i) => (
                    <li key={i} className="flex items-start gap-2 px-3 py-2 text-sm">
                      {p.level === 'error' ? <X className="h-4 w-4 text-bad-fg mt-0.5 shrink-0" aria-label="Blocking" /> : <AlertTriangle className="h-4 w-4 text-held-fg mt-0.5 shrink-0" aria-label="Note" />}
                      <span>{p.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Item>

            <Item state={states.yaml} title="YAML is valid" action={!yamlOk ? <Button size="sm" variant="ghost" onClick={() => goTab('yaml')}>Open YAML</Button> : undefined}
              summary={yamlOk ? `The YAML parses, and the ${sl ? 'signed' : 'published'} text matches the rules shown in the builder.` : `The YAML has errors. Fix them in the YAML tab; publishing ${sl ? 'signs' : 'seals'} the text exactly.`} />

            <Item state={states.test} title="Tested on past actions" action={testWaived ? <Button size="sm" variant="ghost" onClick={() => goTab('test')}>Why</Button> : <Button size="sm" variant={tested ? 'ghost' : 'secondary'} onClick={() => goTab('test')}>{tested ? 'See results' : testRun ? 'Run again' : 'Run the test'}</Button>}
              summary={tested ? <>Last {testRun!.days} days, run {relative(new Date(testRun!.at).toISOString())}. {replayHeadline(testRun!.result)}</> : testWaived ? `Not possible: the replay store is switched off, so no past call can be decided again. Review and ${sl ? 'signing' : 'publishing'} go ahead, and the receipt records that no replay test was possible.` : testRun ? 'The rules changed after the last test. Run it again on the rules as they are now.' : 'Required. Re-decide recent real calls under this draft and read what would change.'} />

            <Item state={states.note} title="Version note" summary="One line on what changes and why. It is stored with the version, shown to the reviewer and in the history.">
              {canEdit
                ? <Textarea aria-label="Version note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Raise the no-approval limit to ₹1,00,000 for approved vendors" />
                : <p className="text-sm">{note.trim() || <span className="text-muted">No note yet.</span>}</p>}
            </Item>

            <Item state={states.review} title={dc.enforced ? 'Second-person review — dual control' : 'Second-person review'} summary={reviewSummary}
              action={canRequest && (!pending || dirty) && !approved ? <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" aria-hidden />} loading={busy === 'request'} onClick={requestReview}>{dirty ? 'Save and send for review' : 'Send for review'}</Button>
                : canRequest && approved && dirty ? <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" aria-hidden />} loading={busy === 'request'} onClick={requestReview}>Save and send again</Button> : undefined}>
              <div className="space-y-3">
                <p className="text-sm text-muted">A different person from the author approves before it can be {sl ? 'signed' : 'published'}.{dc.enforced ? (dc.enforcedByLevel ? ' Enforced at this level.' : ' Required by your organisation’s policy.') : ''}</p>
                {iAmReviewer && !dirty && (
                  <div className="border border-line bg-sunken/50 p-3 space-y-3">
                    <p className="text-sm font-medium flex items-center gap-1.5"><Users className="h-4 w-4 text-muted" aria-hidden />You are asked to review this version</p>
                    <p className="text-xs text-muted">Read the changes and the test result above. Approving does not publish; {dc.enforced ? `a different person from you ${signsAndPublishes}.` : `anyone who can publish then ${sl ? 'signs' : 'publishes'}.`}</p>
                    <Field label="Note" htmlFor="rv-note" hint="Optional when approving; required when asking for changes.">
                      <Textarea id="rv-note" rows={2} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
                    </Field>
                    <div className="flex flex-wrap gap-2 justify-end">
                      <Button size="sm" variant="secondary" icon={<Undo2 className="h-3.5 w-3.5" aria-hidden />} loading={busy === 'review'} onClick={() => decideReview(false)}>Request changes</Button>
                      <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" aria-hidden />} loading={busy === 'review'} onClick={() => decideReview(true)} disabled={!tested && !testWaived} title={!tested && !testWaived ? 'Run the test on past actions first, so you approve what it shows.' : undefined}>Approve this version</Button>
                    </div>
                  </div>
                )}
                {pending && user && pending.requestedBy === user.id && <p className="text-xs text-muted">You asked for this review, so you cannot approve it. It is in Work › Reviews for the people below.</p>}
                <div>
                  <p className="label mb-1.5">Who can review</p>
                  {membersQ.loading && !membersQ.data ? <Skeleton className="h-6 w-48" /> : membersQ.error ? <p className="text-xs text-bad-fg">{membersQ.error.message}</p> : reviewers.length ? (
                    <div className="flex flex-wrap gap-3">{reviewers.map((m) => <Person key={m.userId} id={m.userId} size={20} />)}</div>
                  ) : <p className="text-xs text-bad-fg">No other active owner or admin can review. Invite one in Agents › People and roles; dual control needs two people.</p>}
                </div>
                {level === 'l1' && <UpgradePath to="l2" compact what="Dual control is enforced on every publish at Attested" />}
              </div>
            </Item>

            {reauth && canPublish && (
              <Item state={states.reauth} title="Confirm it is you" summary={`Asked because your last sign-in was more than 10 minutes ago. Checked before anything is ${sl ? 'signed' : 'published'}.`}>
                <Field label="Your password" htmlFor="pub-pw" className="max-w-sm" error={pwError}>
                  <Input id="pub-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setPwError(undefined); }} invalid={!!pwError} />
                </Field>
              </Item>
            )}
          </ol>

          <div className="mt-6 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted max-w-[52ch]">Publishing {sl ? 'signs' : 'seals'} this exact YAML with the organisation's Ed25519 key{evidenceQ.data?.custody ? ` in ${evidenceQ.data.custody}` : level === 'l1' ? ', held by Elan1 Govern' : ''} and writes a receipt. The live version changes for the next call; calls already decided keep the version they were decided under.</p>
            {canPublish && (
              <Button variant="primary" size="lg" icon={<PenTool className="h-4 w-4" />} disabled={!ready} loading={busy === 'publish'} onClick={publish}>{sl ? 'Sign and publish' : 'Publish'} version {draftVersionNo}</Button>
            )}
          </div>
        </Panel>
      </div>

      <aside className="lg:col-span-4 space-y-6 min-w-0">
        <Panel title="What publishing does" kicker={`For ${rb.slug}`}>
          <dl className="space-y-3 text-sm">
            <div><dt className="label">Agent</dt><dd className="mt-1 flex flex-wrap items-center gap-2"><AgentLink slug={agent.slug} /><RouteMode route={agent.route} compact /></dd></div>
            <div><dt className="label">Live now</dt><dd className="mt-1">v{published?.version} · <Hash value={published?.hash} len={10} /></dd></div>
            <div><dt className="label">After publishing</dt><dd className="mt-1 text-muted">v{draftVersionNo} becomes live. Every call checks its {sl ? 'signature' : 'seal'} before any rule runs.</dd></div>
            <div><dt className="label">Default</dt><dd className="mt-1 inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-muted" aria-hidden />Refuse anything not explicitly allowed</dd></div>
            {agent.route !== 'mcp' && <div><dt className="label">Route</dt><dd className="mt-1 text-muted">This agent uses check and record: Elan1 Govern advises and records; the agent runs the call.</dd></div>}
          </dl>
        </Panel>
        {mine.length > 0 && (
          <Panel title="Reviews of this version" flush>
            <ul className="divide-y divide-line">
              {mine.map((r) => (
                <li key={r.id} className="px-5 py-3 text-sm">
                  <p className="font-medium">{r.status === 'pending' ? 'Waiting' : r.status === 'approved' ? 'Approved' : r.status === 'published' ? 'Approved and published' : 'Changes requested'}</p>
                  <p className="text-xs text-muted">Asked by {userName(r.requestedBy)} <When iso={r.requestedAt} />{r.reviewerId && <> · decided by {userName(r.reviewerId)}</>}</p>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {suggestion && (
          <Panel title="From a rule suggestion" kicker="Provenance">
            <p className="text-sm font-medium">{suggestion.title}</p>
            <p className="text-sm text-muted mt-1">{suggestion.rationale}</p>
            <Link to="/rulebooks/suggestions?tab=drafted" className="link text-sm mt-2 inline-block">Open the suggestion</Link>
          </Panel>
        )}
        <Panel title={sl ? 'Signed so it can be checked' : 'Sealed so it can be checked'} kicker="Evidence">
          <p className="text-sm text-muted">The version hash is written into every decision receipt, so an auditor can see which rules decided each call. <SmartLink to="/evidence" hideWhenBlocked className="link">Proof</SmartLink></p>
          <p className="mt-2 text-xs text-muted">{claim}</p>
          {published && <p className="mt-2 text-xs text-muted">Last publish: <ReceiptLinkByHash rb={rb} /></p>}
        </Panel>
      </aside>
    </div>
  );
}

function ReceiptLinkByHash({ rb }: { rb: Rulebook }) {
  const orgId = useOrgId();
  const [seq, setSeq] = useState<number>();
  useEffect(() => {
    let live = true;
    api.receipts(orgId, { agent: rb.slug, kind: 'admin', q: 'rulebook.published', limit: 1 }).then((r) => live && setSeq(r.items[0]?.seq)).catch(() => undefined);
    return () => { live = false; };
  }, [orgId, rb.slug, rb.currentVersion]);
  return seq ? <ReceiptLink seq={seq} /> : <span>—</span>;
}
