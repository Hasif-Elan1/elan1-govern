import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, CircleSlash, Clock3, ExternalLink, Fingerprint, KeyRound, Lock, Minus, Radar, RotateCcw, Send, ServerCrash, ShieldAlert, Undo2, UserCheck, Users } from 'lucide-react';
import { api } from '@/api';
import type { Approval, Receipt, Route } from '@/types';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { userName } from '@/mock/users';
import { dateTime, seqLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, CopyButton, Dialog, Field, Select, StatusChip, Textarea, toast } from '@/components/ui';
import { ReceiptLink, Section, When } from '@/components/domain';
import {
  BLAST_LABEL, OUTAGE_SENTENCE, REVERSAL_DAYS, blastRadius, delegations, endOutage, outageActive, outageState, reverseApproval, reverseRight, reversibility, sealWord, stepUpReason,
  type BlastScope,
} from '@/mock/approvalsExt';
import { CHECK_RESULT_LABEL, checkResults, checkSummary, payloadDigestFor, recordDiff, type CheckResult } from './decide';
import { outageStatusLink } from './OutageNotice';
import { SmartLink } from '@/shell/access';

/* ── What changes: before → after ─────────────────────────── */

/** Field-by-field diff of what the call would change against the record as it is now. Unchanged fields sit behind “Show all fields”. */
export function DiffSection({ a }: { a: Approval }) {
  const diff = useMemo(() => recordDiff(a), [a]);
  const [all, setAll] = useState(false);
  const tableId = useId();
  const changed = diff.fields.filter((x) => x.changed);
  const rows = all || diff.readOnly ? diff.fields : changed;
  const hidden = diff.fields.length - changed.length;
  const wiped = a.status === 'expired' && Object.keys(a.args ?? {}).length === 0;
  return (
    <Section title="What changes" aside={!diff.readOnly && hidden > 0 ? (
      <button type="button" aria-expanded={all} aria-controls={tableId} onClick={() => setAll((v) => !v)} className="text-xs font-medium underline underline-offset-2 hover:text-accent-fg focus-visible:outline-2 focus-visible:outline-offset-2">
        {all ? 'Show changed fields only' : `Show all fields (${diff.fields.length})`}
      </button>
    ) : undefined}>
      <p className="text-sm text-muted">
        {diff.readOnly ? 'This call only reads. Nothing is changed.' : <>{diff.record}{diff.exists ? '' : ' — created by this call'} · {changed.length} {changed.length === 1 ? 'field changes' : 'fields change'}{!all && hidden > 0 ? `, ${hidden} unchanged hidden` : ''}.</>}
        {wiped && ' The held arguments were wiped on expiry.'}
      </p>
      <div className="mt-2 overflow-x-auto">
        <table id={tableId} className="w-full min-w-[480px] text-sm border border-line">
          <caption className="sr-only">Fields of {diff.record}: value now and value after the call</caption>
          <thead>
            <tr className="bg-sunken/60 text-left">
              <th scope="col" className="px-3 py-2 label font-normal w-[28%]">Field</th>
              <th scope="col" className="px-3 py-2 label font-normal">Now</th>
              <th scope="col" className="px-3 py-2 label font-normal">After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.key} className={cn('border-t border-line align-top', x.changed && 'bg-held-bg/50')}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    {x.changed ? <ArrowRight className="h-3 w-3 shrink-0 text-held-fg" aria-hidden /> : <Minus className="h-3 w-3 shrink-0 text-subtle" aria-hidden />}
                    <span>{x.label}</span>
                    <span className="sr-only">{x.changed ? '(changes)' : '(unchanged)'}</span>
                  </span>
                </th>
                <td className={cn('px-3 py-2 font-mono text-[12.5px] break-all', x.changed ? 'text-muted line-through decoration-muted/60' : 'text-muted')}>{x.before}</td>
                <td className={cn('px-3 py-2 font-mono text-[12.5px] break-all', x.changed && 'font-semibold text-fg')}>{x.after}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={3} className="px-3 py-2 text-muted">No field changes.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-xs text-muted">Nothing is summarised away: “Show all fields” lists every field of the record this call touches.</p>
    </Section>
  );
}

/* ── Checks before the rule ───────────────────────────────── */

const RESULT_TONE: Record<CheckResult, 'ok' | 'neutral' | 'held'> = { passed: 'ok', not_applicable: 'neutral', off: 'neutral', person: 'held' };
const RESULT_ICON: Record<CheckResult, typeof Check> = { passed: Check, not_applicable: Minus, off: CircleSlash, person: Users };

/** Every check G1–G9 in declared order with its result and declaration version, then the rule and its rulebook version. */
export function ChecksSection({ a, orgIdOverride }: { a: Approval; /** the single-use link page names the organisation in its token */ orgIdOverride?: string }) {
  const sessionOrg = useOrgId();
  const orgId = orgIdOverride ?? sessionOrg;
  const rows = useMemo(() => checkResults(orgId, a), [orgId, a]);
  const sum = checkSummary(rows);
  return (
    <Section title="Every check, with its version" aside={<span className="text-xs text-muted">{sum.text}</span>}>
      <ol className="divide-y divide-line border border-line">
        {rows.map((r) => {
          const Icon = RESULT_ICON[r.result];
          return (
            <li key={r.id} className={cn('grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-2', r.id === 'rule' && 'bg-sunken/50')}>
              <span className="font-mono text-xs text-muted pt-0.5">{r.id === 'rule' ? 'Rule' : r.id}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{r.name}</span>
                  <span className="font-mono text-[11px] text-subtle">{r.version}</span>
                  <StatusChip size="sm" tone={RESULT_TONE[r.result]} icon={<Icon className="h-3 w-3" aria-hidden />} className="ml-auto">{r.id === 'rule' ? 'Ask a person' : CHECK_RESULT_LABEL[r.result]}</StatusChip>
                </div>
                <p className="mt-0.5 text-sm text-muted">{r.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-1.5 text-xs text-muted">Rate, budget and schedule may be declared off for a tool; consent, residency, retention, dual control, counterparty and precondition always run. Every result above is recorded with the hold.</p>
    </Section>
  );
}

/** “7 of 9 checks passed · 2 for a person” for a queue row. */
export function CheckSummaryLine({ a, className }: { a: Approval; className?: string }) {
  const orgId = useOrgId();
  const sum = useMemo(() => checkSummary(checkResults(orgId, a)), [orgId, a]);
  return (
    <span className={cn('inline-flex items-center gap-1 num', className)} title="Checks that ran before the rule asked a person">
      <Radar className="h-3 w-3" aria-hidden />{sum.passed}/{sum.run} checks passed{sum.person ? ` · ${sum.person} for a person` : ''}
    </span>
  );
}

/* ── Blast radius ─────────────────────────────────────────── */

const SCOPES: BlastScope[] = ['single_record', 'account', 'tenant', 'cross_boundary'];

export function BlastRadiusSection({ a, orgIdOverride }: { a: Approval; orgIdOverride?: string }) {
  const sessionOrg = useOrgId();
  const orgId = orgIdOverride ?? sessionOrg;
  const br = blastRadius(a);
  const step = stepUpReason(orgId, a);
  const rev = reversibility(orgId, a);
  return (
    <Section title="Blast radius">
      <ol className="grid grid-cols-4 gap-px bg-line border border-line" aria-label="Blast radius scale, smallest to largest">
        {SCOPES.map((s) => (
          <li key={s} aria-current={s === br.scope ? 'true' : undefined} className={cn('px-2 py-2 text-xs leading-tight', s === br.scope ? 'bg-fg text-canvas font-semibold' : 'bg-surface text-muted')}>
            {BLAST_LABEL[s]}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-sm"><span className="font-medium">{br.label}.</span> <span className="text-muted">{br.why}</span></p>
      {br.dualControl && <p className="mt-1.5 flex items-start gap-1.5 text-sm text-held-fg"><Users className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />A whole-organisation or cross-boundary call always needs two different approvers.</p>}
      <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted"><Undo2 className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />{rev.plan.readOnly ? rev.plan.plan : rev.plan.reversible ? `Reversible for ${REVERSAL_DAYS} days after it runs: ${rev.plan.plan}` : rev.plan.plan}</p>
      {step && a.status === 'pending' && <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted"><KeyRound className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />Approving asks for your password again, whatever your sign-in’s age. {step}</p>}
    </Section>
  );
}

/* ── Payload digest ───────────────────────────────────────── */

export function DigestLine({ digest, className }: { digest: string; className?: string }) {
  const level = useOrgLevel();
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted', className)}>
      <Fingerprint className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>What you are shown has digest</span>
      <span className="font-mono text-fg" title={digest}>sha256:{digest.slice(0, 16)}…</span>
      <CopyButton compact text={digest} label="Copy the digest" />
      <span>· recorded on your decision receipt, {sealWord(level)}.</span>
    </p>
  );
}

/* ── Delegation and same-person banners ───────────────────── */

export function DelegateBanner({ from }: { from: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const dl = delegations(orgId).find((d) => d.active && d.from === from && d.to === user?.id);
  return (
    <Banner className="mt-5" tone="info" title={`You are deciding for ${userName(from)}`}>
      {userName(from)} delegated their approvals to you{dl ? <> until {dateTime(dl.until)} (“{dl.reason}”)</> : null}. Your decision is yours; the receipt records that you decided under the delegation{dl?.seq !== undefined ? <> set up in <ReceiptLink seq={dl.seq} /></> : null}.
    </Banner>
  );
}

/** Same-person rule in forbid mode: the agent's owner cannot approve its action. Send it to someone who can. */
export function SameActorBanner({ a }: { a: Approval }) {
  const orgId = useOrgId();
  const user = useUser();
  const others = useMemo(() => api.allowedApprovers(orgId, a.id).filter((u) => u !== user?.id), [orgId, a.id, user?.id]);
  const [to, setTo] = useState(others[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();
  const send = async () => {
    if (!to || !user) return;
    setBusy(true);
    try {
      // the same send path as every hand-sent link: the outbox message and an approval.link_sent receipt
      const t = await api.approvalLink(orgId, a.id, to, 'email', user.id);
      const seq = (t as { seq?: number }).seq;
      setSent(to);
      toast.ok(`Sent to ${userName(to)}`, `A single-use link by email — see the demo outbox. It works once and expires with the approval.${seq !== undefined ? ` Recorded as receipt ${seqLabel(seq)}.` : ''}`);
    } catch (e) {
      toast.bad('Not sent', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 border border-bad/40 border-l-[3px] border-l-bad bg-bad-bg px-4 py-3 text-sm" role="status">
      <p className="flex items-start gap-2 font-semibold"><ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-bad-fg" aria-hidden />You proposed this, so you cannot also approve it.</p>
      <p className="mt-1 text-fg/80">You set up {a.agentSlug}, and this organisation forbids approving your own agent’s action. You can still reject it. {others.length ? `Send it to: ${others.map((u) => userName(u)).join(', ')}.` : 'Nobody else can decide it yet: ask an owner to re-route it.'}</p>
      {others.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <div className="w-56 max-w-full"><Select size_="sm" aria-label="Send it to" value={to} onChange={(e) => setTo(e.target.value)}>{others.map((u) => <option key={u} value={u}>{userName(u)}</option>)}</Select></div>
          <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" aria-hidden />} loading={busy} onClick={send}>Send to</Button>
          {sent && <span className="text-xs text-muted">Sent to {userName(sent)}.</span>}
        </div>
      )}
    </div>
  );
}

/* ── Outcome, proof, Open the record, Reverse this ─────────── */

export function OutcomeBlock({ a, route, compact }: { a: Approval; route?: Route; compact?: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const q = useQuery(async (o) => reversibility(o, a), [a.id, a.status, a.resultSeq], { kinds: ['approval', 'receipt'] });
  const canDecideRole = useCan('approvals.decide');
  const [open, setOpen] = useState(false);
  if (a.status !== 'approved' || a.resultSeq === undefined) return null;
  const r = q.data ?? reversibility(orgId, a);
  const rev = r.reversal;
  // only owners, admins, the approver and members of the approver group reverse; nobody while approvals are down
  const right = reverseRight(orgId, a, user?.id);
  const down = outageActive(orgId);
  const noReverseWhy = down ? OUTAGE_SENTENCE : right.ok ? undefined : right.why;
  return (
    <div className={cn('border border-line', compact ? 'mt-3' : '')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        {rev ? (
          <StatusChip tone="neutral" icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}>{r.plan.reversed} · reversal {seqLabel(rev.seq)}</StatusChip>
        ) : (
          <StatusChip tone="ok" icon={<Check className="h-3.5 w-3.5" aria-hidden />}>{r.plan.outcome} · proof {seqLabel(a.resultSeq)}</StatusChip>
        )}
        <Link to={`/activity/${a.resultSeq}`} className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2 hover:text-accent-fg">Open the record <ExternalLink className="h-3.5 w-3.5" aria-hidden /></Link>
        {/* a role that decides no approvals (viewer, auditor) does not see the button; an approver outside the group sees it disabled with the reason */}
        {!rev && r.can && (right.ok || (!!user && canDecideRole)) && (
          <Button size="sm" variant="secondary" className="ml-auto" icon={<Undo2 className="h-3.5 w-3.5" aria-hidden />} onClick={() => setOpen(true)} disabled={!!noReverseWhy} title={noReverseWhy}>Reverse this</Button>
        )}
      </div>
      <div className="px-4 pb-3 text-xs text-muted space-y-1">
        {rev ? (
          <>
            <p>Reversed by <span className="text-fg">{userName(rev.by)}</span> <When iso={rev.at} /> · receipt <ReceiptLink seq={rev.seq} /> · {sealWord(level)}.</p>
            <p>“{rev.reason}”</p>
            <p>{rev.plan}{rev.ref ? ` Reversal reference ${rev.ref}.` : route !== 'mcp' ? ' The agent was told to reverse it and reports the outcome.' : ''}</p>
          </>
        ) : r.can ? (
          <>
            <p className="flex items-center gap-1"><Clock3 className="h-3 w-3" aria-hidden />Reverse this until {r.until ? dateTime(r.until) : '—'} ({REVERSAL_DAYS} days). {r.plan.plan}</p>
            {noReverseWhy && <p className="flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden />{noReverseWhy}</p>}
          </>
        ) : (
          <p>{r.why}</p>
        )}
      </div>
      <ReverseDialog a={a} route={route} open={open && !noReverseWhy} onClose={() => setOpen(false)} onDone={() => { setOpen(false); q.refetch(); }} />
    </div>
  );
}

function ReverseDialog({ a, route, open, onClose, onDone }: { a: Approval; route?: Route; open: boolean; onClose: () => void; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const plan = reversibility(orgId, a).plan;
  const go = async () => {
    if (!user) return;
    setBusy(true);
    setErr(undefined);
    try {
      await new Promise((res) => setTimeout(res, 300));
      const rev = reverseApproval(orgId, a.id, user.id, reason, route);
      toast.ok(plan.reversed, `Recorded as receipt ${seqLabel(rev.seq)}. ${route === 'mcp' ? `Elan1 Govern ran the reversal through ${a.connector}.` : 'The agent was told to reverse it; it runs the reversal and reports the outcome.'}`);
      setReason('');
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} tone="danger" title="Reverse this" description={`${a.headline}. ${plan.plan}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Undo2 className="h-4 w-4" aria-hidden />} loading={busy} disabled={reason.trim().length < 10} onClick={go}>Reverse it</Button></>}>
      <Field label="Why is it being reversed?" required htmlFor={`rev-${a.id}`} hint="At least a sentence. Recorded on the reversal receipt." error={err}>
        <Textarea id={`rev-${a.id}`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the bill was already paid by cheque" />
      </Field>
      <p className="mt-3 text-sm text-muted">{route === 'mcp' ? `Elan1 Govern runs the reversal through ${a.connector} and records the result.` : 'This agent is on check and record: the agent is told to reverse it, runs the reversal itself and reports the outcome. The reversal is recorded now.'}</p>
    </Dialog>
  );
}

/**
 * The decision receipt's recorded digest, recomputed against the screen it records (the console decide screen or
 * the single-use link page) as it would show now. Without `a`, it is compared with `current`.
 */
export function RecordedDigest({ result, current, a }: { result?: Receipt; current: string; a?: Approval }) {
  const orgId = useOrgId();
  const recorded = result?.details?.payload_digest ? String(result.details.payload_digest) : undefined;
  const view = result?.details?.payload_view ? String(result.details.payload_view) : undefined;
  const expected = useMemo(() => (a && recorded ? payloadDigestFor(orgId, a, view) : current), [a, recorded, orgId, view, current]);
  if (!recorded) return null;
  const same = recorded === expected;
  const where = view === 'link' ? 'the single-use link page' : 'this screen';
  return (
    <div className="sm:col-span-2">
      <dt className="label">What the approver was shown{view === 'link' ? ' (single-use link page)' : ''}</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-[12.5px]" title={recorded}>sha256:{recorded.slice(0, 16)}…</span>
        <CopyButton compact text={recorded} label="Copy the digest" />
        {same ? <Badge tone="ok" icon={<Check className="h-3 w-3" aria-hidden />}>Matches {where}</Badge> : <Badge tone="held">Differs from {where} now</Badge>}
      </dd>
    </div>
  );
}

/* ── Fail closed: approvals unavailable ───────────────────── */

/** Shown instead of the inbox and every decide screen while the approvals service is down for the organisation. */
export function ApprovalsUnavailable() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const q = useQuery(async (o) => ({ outage: outageState(o), waiting: (await api.approvals(o)).filter((a) => a.status === 'pending').length }), [], { kinds: ['approval', 'receipt'] });
  const [busy, setBusy] = useState(false);
  const admin = role === 'owner' || role === 'admin';
  const end = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await new Promise((res) => setTimeout(res, 300));
      const o = endOutage(orgId, user.id);
      toast.ok('Approvals are back', `It was down for ${o.pausedMinutes ?? 0} minutes. Every waiting approval’s expiry moved by that much. Recorded on the chain.`);
    } catch (e) {
      toast.bad('Could not end the outage', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const o = q.data?.outage;
  const statusLink = outageStatusLink(orgId);
  return (
    <section aria-labelledby="apr-down" className="border border-line border-l-[6px] border-l-bad bg-surface p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <ServerCrash className="h-6 w-6 shrink-0 text-bad-fg" aria-hidden />
        <div className="min-w-0 max-w-[70ch]">
          <p className="label text-bad-fg">Approvals unavailable</p>
          <h2 id="apr-down" className="mt-1 text-2xl font-semibold tracking-tighter2">{OUTAGE_SENTENCE}</h2>
          <p className="mt-3 text-md leading-relaxed">Nothing has been approved in the meantime and nothing expires while this is down. Held calls keep waiting; none of them runs. When the service is back, each one is waiting exactly as it was, with its expiry moved by the time it was down.</p>
          <ul className="mt-4 space-y-1.5 text-sm text-muted">
            {o?.since && <li>Down since {dateTime(o.since)} (<When iso={o.since} />){o.by ? <> · started by {userName(o.by)} as a demonstration</> : null}{o.seq !== undefined && <> · <ReceiptLink seq={o.seq} /></>}</li>}
            {q.data && <li>{q.data.waiting} {q.data.waiting === 1 ? 'call is' : 'calls are'} waiting, unchanged.</li>}
            <li>Approve and reject, re-route, extend, single-use links and reversals are all closed until it is back. Agents keep being refused or held, never allowed by default.</li>
          </ul>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <SmartLink to={statusLink.to} hideWhenBlocked className="inline-flex items-center gap-1 h-10 px-4 text-sm font-medium border border-line-strong/70 hover:border-fg">{statusLink.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>
            {/* owners and admins end the demonstration outage; other roles see no control and no "who can" line */}
            {admin && (
              <Button variant="primary" icon={<UserCheck className="h-4 w-4" aria-hidden />} loading={busy} onClick={end}>End the simulated outage</Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
