import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, X, KeyRound, Users, FilePlus2 } from 'lucide-react';
import type { Approval, Channel, Receipt, Route } from '@/types';
import { useOrgId, useUser, needsReauth, markReauth } from '@/store/session';
import { Button, Field, Input, Kbd, Textarea, toast } from '@/components/ui';
import { rupees, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { decide, firstApprovalOf, needsTwo, reauth as checkPassword, twoPersonReason, type DecideExtra, type DecideResult } from '@/features/work/backend';
import { markStepUp, stepUpReason } from '@/mock/approvalsExt';

export type DecisionMode = 'approve' | 'reject' | null;

export const MIN_REASON = 10;

export interface DecisionDone { approve: boolean; partial: boolean; receipt: Receipt; approval: Approval }

/**
 * Inline decision form. Reject needs a reason of at least a sentence; Approve takes an optional note.
 * The password is asked when the sign-in is older than 10 minutes, and — step-up — for every irreversible or
 * high-value approval whatever the sign-in's age; it is checked before anything is recorded. The digest of what
 * the approver was shown is recorded on the receipt.
 * When the organisation's two-person rule applies, the first approval is recorded and the call waits for a
 * second, different approver. Ctrl+Enter commits, Esc cancels.
 */
export function DecisionForm({ approval, route, mode, selfApproval, onCancel, onDone, channel = 'web', orgIdOverride, compact, submit, payloadDigest, draftRule }: {
  approval: Approval;
  route?: Route;
  mode: 'approve' | 'reject';
  selfApproval?: boolean;
  onCancel: () => void;
  onDone: (result: DecisionDone) => void;
  channel?: Channel;
  orgIdOverride?: string;
  compact?: boolean;
  /** Decide another way (a single-use link); defaults to the console decision. */
  submit?: (approve: boolean, reason: string, extra: DecideExtra) => Promise<DecideResult>;
  /** The digest of exactly what the approver was shown; recorded on the decision receipt. */
  payloadDigest?: string;
  /** "Approve and draft a rule": after the approval is recorded, a draft rule opens in the agent's rulebook. */
  draftRule?: boolean;
}) {
  const sessionOrg = useOrgId();
  const orgId = orgIdOverride ?? sessionOrg;
  const user = useUser();
  const [text, setText] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [sessionOld] = useState(() => needsReauth());
  // step-up: irreversible or high-value approvals ask for the password whatever the session's age
  const stepUp = mode === 'approve' ? stepUpReason(orgId, approval) : undefined;
  const reauth = sessionOld || !!stepUp;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [pwError, setPwError] = useState<string>();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const formId = useId();
  const approve = mode === 'approve';
  const enforced = route === 'mcp';
  const two = needsTwo(orgId, approval);
  const first = two ? firstApprovalOf(orgId, approval.id) : undefined;

  const reasonOk = approve || text.trim().length >= MIN_REASON;
  const passwordOk = !reauth || password.length > 0;
  const ready = reasonOk && passwordOk && !!user;

  useEffect(() => {
    const t = window.setTimeout(() => textRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [mode]);

  const commitRef = useRef<() => void>(() => undefined);
  const commit = async () => {
    setTouched(true);
    if (!ready || pending || !user) return;
    setPending(true);
    setError(undefined);
    setPwError(undefined);
    try {
      if (reauth) {
        try {
          await checkPassword(user.id, password);
        } catch (e) {
          setPwError((e as Error).message);
          return;
        }
        if (sessionOld) markReauth();
        if (stepUp) markStepUp(user.id, approval.id);
      }
      const extra: DecideExtra = payloadDigest ? { payloadDigest } : {};
      const res = submit ? await submit(approve, text.trim(), extra) : await decide(orgId, approval.id, approve, user.id, text.trim(), channel, extra);
      if (res.partial) {
        toast.held('First approval recorded', `Waiting for a second approver — not you. Receipt ${seqLabel(res.receipt.seq)}.`);
      } else if (approve) {
        toast.ok('Approved', enforced ? `The call ran through ${approval.connector}. Receipt ${seqLabel(res.receipt.seq)}.` : `The agent may now run the call. Receipt ${seqLabel(res.receipt.seq)}.`);
      } else {
        toast.info('Rejected', `The call did not run. Receipt ${seqLabel(res.receipt.seq)}.`);
      }
      onDone({ approve, partial: res.partial, receipt: res.receipt, approval: res.approval });
    } catch (e) {
      setError((e as Error).message);
      toast.bad('The decision was not recorded', (e as Error).message);
    } finally {
      setPending(false);
    }
  };
  commitRef.current = commit;

  // Ctrl/Cmd+Enter commits and Esc cancels, wherever focus is inside the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitRef.current(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); commit(); };
  const secondStep = approve && two && !!first;

  return (
    <form id={formId} onSubmit={onSubmit} className="space-y-4 animate-rise-in" aria-label={approve ? 'Approve this action' : 'Reject this action'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-display text-lg font-semibold">
            {approve ? <Check className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
            {approve ? (two ? (secondStep ? 'Give the second approval' : 'Give the first approval') : 'Approve this action') : 'Reject this action'}
          </p>
          <p className="mt-0.5 text-sm text-muted max-w-[68ch]">
            {approve
              ? two && !secondStep
                ? `${twoPersonReason(orgId, approval) === 'scope' ? 'This call reaches beyond one record or account' : `This call is ${approval.amount !== undefined ? rupees(approval.amount) : 'above the limit'}`}, so two different people approve it. Your approval is recorded; the call keeps waiting for a second approver.`
                : enforced
                  ? `On approval Elan1 Govern runs the call immediately through ${approval.connector} and records the outcome.`
                  : 'On approval the agent is told it may proceed. This agent is on check and record: it runs the call itself and Elan1 Govern records the outcome.'
              : 'The call does not run. The agent receives a refusal that carries your reason, and the rejection is written to the chain.'}
          </p>
        </div>
        {!compact && (
          <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted">
            <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> commit · <Kbd>Esc</Kbd> cancel
          </span>
        )}
      </div>

      {secondStep && first && (
        <p className="flex items-start gap-2 border border-line bg-sunken/60 px-3 py-2 text-sm">
          <Users className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />
          <span>Approved first by <span className="font-medium">{userName(first.userId)}</span> (receipt {seqLabel(first.seq)}). Yours is the second approval; the call {enforced ? 'runs' : 'may proceed'} when you commit.</span>
        </p>
      )}

      {selfApproval && approve && (
        <p className="border border-held/50 bg-held-bg px-3 py-2 text-sm text-held-fg">
          You own this agent — your approval will be flagged on the receipt as a self-approval.
        </p>
      )}

      <Field
        label={approve ? 'Note' : 'Reason'}
        required={!approve}
        htmlFor={`${formId}-reason`}
        hint={approve ? 'Optional. Recorded on the approval receipt.' : `Required, at least a sentence (${MIN_REASON} characters). Recorded on the receipt and sent back to the agent.`}
        error={touched && !reasonOk ? 'Write the reason for rejecting — at least a sentence.' : undefined}
      >
        <Textarea
          id={`${formId}-reason`}
          ref={textRef}
          rows={compact ? 3 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          invalid={touched && !reasonOk}
          placeholder={approve ? 'For example: confirmed with the vendor on their known number' : 'For example: vendor did not confirm this payment on the phone'}
        />
      </Field>

      {approve && draftRule && (
        <p className="flex items-start gap-2 border border-line bg-sunken/60 px-3 py-2 text-sm">
          <FilePlus2 className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />
          <span>After your approval is recorded, the {approval.agentSlug} rulebook opens with a draft rule that allows calls like this one. Nothing is live until a person publishes it.</span>
        </p>
      )}

      {reauth && (
        <Field label="Your password" required htmlFor={`${formId}-pw`} hint={stepUp ? `Asked for this approval whatever your sign-in’s age. ${stepUp}` : 'Asked because your last sign-in was more than 10 minutes ago.'} error={pwError ?? (touched && !passwordOk ? 'Enter your password to confirm it is you.' : undefined)}>
          <Input id={`${formId}-pw`} type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setPwError(undefined); }} leading={<KeyRound className="h-4 w-4" aria-hidden />} invalid={!!pwError || (touched && !passwordOk)} />
        </Field>
      )}

      {error && <p className="text-sm text-bad-fg" role="alert">{error}</p>}

      <div className={compact ? 'grid grid-cols-1 gap-3' : 'flex flex-wrap items-center justify-end gap-3'}>
        {!compact && <Button type="button" variant="ghost" size="lg" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" size="lg" block={compact} loading={pending} className="min-w-[180px]" icon={approve ? <Check className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}>
          {approve ? (two && !secondStep ? (draftRule ? 'Record first approval and draft a rule' : 'Record first approval') : draftRule ? 'Approve and draft a rule' : enforced ? 'Approve and run' : 'Approve') : 'Reject'}
        </Button>
        {compact && <Button type="button" variant="ghost" size="lg" block onClick={onCancel}>Back</Button>}
      </div>
    </form>
  );
}
