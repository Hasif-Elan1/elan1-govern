import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Play, ShieldCheck, Users } from 'lucide-react';
import { api, db } from '@/api';
import { userName } from '@/mock/users';
import type { LiftRequest } from '@/mock/ops';
import { useMutation } from '@/hooks/useQuery';
import { useCan, useOrgId, useUser, needsReauth, markReauth } from '@/store/session';
import type { Agent } from '@/types';
import { n, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Banner, Button, Checkbox, Field, Input, Textarea, toast } from '@/components/ui';
import { AgentStatus, Person, ReceiptLink, When } from '@/components/domain';
import { HEALTH_META, reauth as checkPassword, resolveIncident, type WorkIncident } from '@/features/work/backend';

function CheckRow({ checked, onChange, label, children, link, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; children: ReactNode; link?: { to: string; label: string }; disabled?: boolean }) {
  return (
    <li className={cn('flex items-start justify-between gap-3 px-4 py-3', checked && 'bg-ok-bg/40')}>
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={label} description={children} />
      {link && (
        <Link to={link.to} className="shrink-0 inline-flex items-center gap-1 text-sm font-medium text-fg hover:underline underline-offset-2">
          {link.label}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      )}
    </li>
  );
}

/** The field shows capitals, so "resume" typed reads RESUME and counts. */
const typedResume = (typed: string) => typed.trim().toUpperCase() === 'RESUME';
const resumeHint = (typed: string) => (typed.trim() && !typedResume(typed) ? 'Type the word RESUME exactly. Capitals are not needed.' : undefined);

/** Re-render when the organisation's records change (a lift requested, approved or declined elsewhere). */
function useOrgTick() {
  const orgId = useOrgId();
  return useSyncExternalStore((cb) => db.subscribe((o) => { if (o === orgId) cb(); }), () => {
    const d = db.getDB(orgId);
    return `${d.receipts.length}:${d.stop.active}`;
  });
}

/**
 * Guided resume after an emergency stop: three checks, a note, type RESUME (and the password if the sign-in
 * is older than 10 minutes). Lifting the stop resumes only the agents the stop paused.
 *
 * Dual control: engaging is one person at every level. From L2 Attested (and on Sovereign) lifting needs a second,
 * different owner or admin: the first person asks to lift (stop.lift_requested), the second approves
 * (stop.lift_approved, then stop.lifted) or declines. At L1 one owner or admin lifts it.
 */
export function LiftStopForm({ pendingNow, resumable, otherPaused, onDone }: { pendingNow: number; resumable: Agent[]; otherPaused: Agent[]; onDone?: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  useOrgTick();
  const canLift = useCan('stop.engage');
  const dual = api.ops.liftNeedsSecond(orgId);
  const pending = dual ? api.ops.pendingLift(orgId) : undefined;
  const [cause, setCause] = useState(false);
  const [approvals, setApprovals] = useState(false);
  const [rules, setRules] = useState(false);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string>();
  const [reauth] = useState(() => needsReauth());
  const [busy, setBusy] = useState(false);
  const fid = useId();
  const lift = useMutation(() => api.liftStop(orgId, user!.id, note.trim()));
  const checks = [cause, approvals, rules].filter(Boolean).length;
  const seconds = api.ops.liftApprovers(orgId, user?.id);
  // dual control with nobody to be the second person: the request would wait for ever, so it is not offered
  const noSecond = dual && seconds.length === 0;
  const ready = canLift && !noSecond && checks === 3 && note.trim().length >= 8 && typedResume(typed) && (!reauth || password.length > 0);

  const passwordOk = async () => {
    if (!reauth || !user) return true;
    try {
      await checkPassword(user.id, password);
    } catch (e) {
      setPwError((e as Error).message);
      return false;
    }
    markReauth();
    return true;
  };

  const go = async () => {
    if (!user) return;
    try {
      if (!(await passwordOk())) return;
      if (dual) {
        setBusy(true);
        const r = api.ops.requestLift(orgId, user.id, note.trim(), checks);
        toast.ok('Lift requested', `Recorded as receipt #${n(r.requestSeq ?? 0)}. ${seconds.map((u) => userName(u)).join(', ')} can approve it; the agents stay stopped until then.`);
        setTyped('');
      } else {
        await lift.mutate();
        toast.ok('Stop lifted', `${plural(resumable.length, 'agent')} resumed — only those the stop paused. The lift is recorded with your note.`);
      }
      onDone?.();
    } catch (e) {
      toast.bad(dual ? 'The lift was not requested' : 'The stop could not be lifted', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (dual && pending) {
    return <SecondPersonLift request={pending} resumable={resumable} pendingNow={pendingNow} onDone={onDone} />;
  }

  return (
    <div className="space-y-5">
      {dual && !noSecond && (
        <Banner tone="info" title="Two people lift the stop at this level">
          You ask to lift it; a different owner or admin approves before any agent resumes. Engaging the stop stays one person.
          {' '}Who can approve: {seconds.map((u) => userName(u)).join(', ')}.
        </Banner>
      )}
      {noSecond && canLift && (
        <Banner tone="held" title="Nobody else can approve the lift yet">
          At this level a second owner or admin approves lifting the stop, and you are the only active one. Invite another owner or admin, then ask to lift it here and they approve it. The agents stay stopped until then.
          {' '}<Link to="/agents/people" className="font-semibold underline underline-offset-2">People and roles</Link>
        </Banner>
      )}
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <p className="label">Before you resume</p>
          <span className="text-xs text-muted num" aria-live="polite">{checks} of 3 done</span>
        </div>
        <ol className="border border-line divide-y divide-line bg-surface">
          <CheckRow checked={cause} onChange={setCause} disabled={!canLift} label="The cause is understood" link={{ to: '/alerts', label: 'Alerts' }}>
            You know what the agents did and why. The receipts and any open alerts say what happened.
          </CheckRow>
          <CheckRow checked={approvals} onChange={setApprovals} disabled={!canLift} label="Waiting approvals reviewed" link={{ to: '/approvals', label: `Approvals (${n(pendingNow)})` }}>
            {pendingNow ? `${plural(pendingNow, 'approval')} ${pendingNow === 1 ? 'is' : 'are'} waiting.` : 'No approvals are waiting.'} The stop holds them: they become decidable when it is lifted. Know which ones should not run, and reject them then.
          </CheckRow>
          <CheckRow checked={rules} onChange={setRules} disabled={!canLift} label="Rulebook changes made, if needed" link={{ to: '/rulebooks', label: 'Rulebooks' }}>
            If a rule let this through, tighten it and sign and publish a new version first.
          </CheckRow>
        </ol>
      </div>

      <div className="border border-line bg-sunken/50 p-4 text-sm">
        <p className="font-medium flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden />What lifting the stop does</p>
        <p className="mt-1 text-muted leading-relaxed">
          Only the {plural(resumable.length, 'agent')} the stop paused will resume.{pendingNow ? ' Approvals the stop held can be decided again.' : ''} {otherPaused.length > 0 ? `${plural(otherPaused.length, 'agent')} paused for another reason ${otherPaused.length === 1 ? 'stays' : 'stay'} paused (${otherPaused.map((a) => a.slug).join(', ')}).` : 'Agents paused for other reasons stay paused.'} One receipt records the lift.
        </p>
        {resumable.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {resumable.map((a) => <li key={a.slug} className="inline-flex items-center gap-2 border border-line bg-surface px-2 py-1"><span className="font-mono text-[12px]">{a.slug}</span><AgentStatus agent={a} /></li>)}
          </ul>
        )}
      </div>

      <Field label="Note for the record" htmlFor={`${fid}-note`} required hint="What was found and what changed. Recorded on the lift receipt and in the incident report.">
        <Textarea id={`${fid}-note`} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canLift} rows={3} placeholder="For example: external account blocked in treasury-sweeper v4; 2 waiting transfers rejected" />
      </Field>

      {reauth && canLift && (
        <Field label="Your password" htmlFor={`${fid}-pw`} required hint="Asked because your last sign-in was more than 10 minutes ago. Checked before the stop is lifted." error={pwError}>
          <Input id={`${fid}-pw`} type="password" value={password} onChange={(e) => { setPassword(e.target.value); setPwError(undefined); }} autoComplete="current-password" invalid={!!pwError} />
        </Field>
      )}

      <Field label={<>Type <span className="font-mono font-semibold">RESUME</span> to confirm</>} htmlFor={`${fid}-typed`} required hint={resumeHint(typed)}>
        <Input id={`${fid}-typed`} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={!canLift} placeholder="RESUME" className="font-mono tracking-widest uppercase" autoComplete="off" />
      </Field>

      {!canLift && <Banner tone="neutral">Owners and admins lift the emergency stop. Your role can read the incident.</Banner>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="primary" size="lg" icon={dual ? <Users className="h-4 w-4" /> : <Play className="h-4 w-4" />} disabled={!ready} title={noSecond ? 'No other owner or admin can approve the lift yet' : undefined} loading={lift.pending || busy} onClick={go}>
          {dual ? 'Ask a second person to lift the stop' : `Lift the stop and resume ${plural(resumable.length, 'agent')}`}
        </Button>
      </div>
    </div>
  );
}

/** The lift is waiting for a second person: the requester sees who can approve and may withdraw; another owner or admin approves or declines. */
function SecondPersonLift({ request, resumable, pendingNow, onDone }: { request: LiftRequest; resumable: Agent[]; pendingNow: number; onDone?: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const canLift = useCan('stop.engage');
  const mine = request.requestedBy === user?.id;
  const [agree, setAgree] = useState(false);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string>();
  const [reauth] = useState(() => needsReauth());
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'decline' | 'withdraw'>();
  const fid = useId();
  const seconds = api.ops.ownersAndAdmins(orgId).filter((u) => u !== request.requestedBy);
  const ready = canLift && !mine && agree && typedResume(typed) && (!reauth || password.length > 0);

  const run = async (kind: 'approve' | 'decline' | 'withdraw') => {
    if (!user) return;
    setBusy(kind);
    try {
      if (kind === 'approve') {
        if (reauth) {
          try { await checkPassword(user.id, password); } catch (e) { setPwError((e as Error).message); return; }
          markReauth();
        }
        const r = api.ops.approveLift(orgId, request.id, user.id, note.trim());
        toast.ok('Stop lifted by two people', `${plural(resumable.length, 'agent')} resumed — only those the stop paused. Approval #${n(r.decisionSeq ?? 0)} and lift #${n(r.liftSeq ?? 0)} are on the chain.`);
      } else if (kind === 'decline') {
        api.ops.declineLift(orgId, request.id, user.id, reason.trim());
        toast.info('Lift declined', 'The stop stays on. Your reason is recorded on the incident.');
      } else {
        api.ops.withdrawLift(orgId, request.id, user.id);
        toast.info('Lift request withdrawn', 'Recorded. You can ask again when ready.');
      }
      onDone?.();
    } catch (e) {
      toast.bad('Not recorded', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="space-y-5">
      <div className="border border-line bg-sunken/50 p-4 text-sm">
        <p className="label">Lift requested</p>
        <p className="mt-1 flex flex-wrap items-center gap-2"><Person id={request.requestedBy} size={20} /> <span className="text-muted">asked <When iso={request.requestedAt} />{request.requestSeq !== undefined && <> · receipt <ReceiptLink seq={request.requestSeq} /></>}</span></p>
        <p className="mt-2">“{request.note}”</p>
        <p className="mt-2 text-xs text-muted">{request.checks} of 3 checks done by the person who asked. {pendingNow ? `${plural(pendingNow, 'approval')} held by the stop will become decidable.` : ''} {plural(resumable.length, 'agent')} will resume.</p>
      </div>

      {mine ? (
        <>
          <Banner tone="held" title="Waiting for a second person">
            A different owner or admin approves the lift: {seconds.length ? seconds.map((u) => userName(u)).join(', ') : 'nobody else holds that role yet — invite one in People and roles'}. It is in their Reviews queue and on Today.
          </Banner>
          <div className="flex justify-end">
            <Button variant="secondary" loading={busy === 'withdraw'} onClick={() => run('withdraw')}>Withdraw the request</Button>
          </div>
        </>
      ) : !canLift ? (
        <Banner tone="neutral">A different owner or admin approves the lift. Your role can read the incident.</Banner>
      ) : declining ? (
        <div className="space-y-3">
          <Field label="Why the stop should stay on" htmlFor={`${fid}-reason`} required hint="Recorded on the stop.lift_declined receipt and the incident.">
            <Textarea id={`${fid}-reason`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => { setDeclining(false); setReason(''); }}>Cancel</Button>
            <Button variant="danger" loading={busy === 'decline'} disabled={reason.trim().length < 8} onClick={() => run('decline')}>Decline the lift</Button>
          </div>
        </div>
      ) : (
        <>
          <ol className="border border-line divide-y divide-line bg-surface">
            <CheckRow checked={agree} onChange={setAgree} label="I have read the incident and agree the stop can be lifted" link={{ to: '/alerts', label: 'Alerts' }}>
              You are the second person. The cause, the held approvals and any rulebook change are as the request says.
            </CheckRow>
          </ol>
          <Field label="Your note" htmlFor={`${fid}-note2`} hint="Optional. Recorded on the stop.lift_approved receipt.">
            <Textarea id={`${fid}-note2`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {reauth && (
            <Field label="Your password" htmlFor={`${fid}-pw2`} required hint="Asked because your last sign-in was more than 10 minutes ago." error={pwError}>
              <Input id={`${fid}-pw2`} type="password" value={password} onChange={(e) => { setPassword(e.target.value); setPwError(undefined); }} autoComplete="current-password" invalid={!!pwError} />
            </Field>
          )}
          <Field label={<>Type <span className="font-mono font-semibold">RESUME</span> to confirm</>} htmlFor={`${fid}-typed2`} required hint={resumeHint(typed)}>
            <Input id={`${fid}-typed2`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RESUME" className="font-mono tracking-widest uppercase" autoComplete="off" />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeclining(true)}>Decline</Button>
            <Button variant="primary" size="lg" icon={<Play className="h-4 w-4" />} disabled={!ready} loading={busy === 'approve'} onClick={() => run('approve')}>
              Approve and lift · resume {plural(resumable.length, 'agent')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Resolve a health incident (receipt write failure, timestamp authority or key outage, storage, a chain break, a
 * rejected update bundle, a node down, a counterparty dispute, an autonomy breach): the guided checks for its kind,
 * a note, then an incident.resolved receipt.
 */
export function ResolveHealthForm({ incident, onDone }: { incident: WorkIncident; onDone?: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const canResolve = useCan('stop.engage');
  const meta = incident.subkind ? HEALTH_META[incident.subkind] : undefined;
  const checks = meta?.checks ?? [{ id: 'fixed', label: 'The underlying problem is fixed', detail: 'What failed works again and is recorded.' }];
  const [done, setDone] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const fid = useId();
  useOrgTick();
  // a reportable incident stays open until CERT-In has the report, or an owner records why it is not reportable
  const certIn = api.ops.certInBlocker(orgId, incident.id);
  const ready = canResolve && !certIn && checks.every((c) => done.includes(c.id)) && note.trim().length >= 8;
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await resolveIncident(orgId, incident.id, note.trim(), done, user.id);
      toast.ok('Incident resolved', 'Recorded as an incident.resolved receipt with your checks and note.');
      onDone?.();
    } catch (e) {
      toast.bad('Not resolved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <p className="label">Before you resolve</p>
          <span className="text-xs text-muted num" aria-live="polite">{done.length} of {checks.length} done</span>
        </div>
        <ol className="border border-line divide-y divide-line bg-surface">
          {checks.map((c) => (
            <CheckRow key={c.id} checked={done.includes(c.id)} disabled={!canResolve} label={c.label} link={c.to ? { to: c.to, label: 'Open' } : undefined}
              onChange={(v) => setDone((d) => (v ? Array.from(new Set([...d, c.id])) : d.filter((x) => x !== c.id)))}>
              {c.detail}
            </CheckRow>
          ))}
        </ol>
      </div>
      <Field label="What was found and what changed" htmlFor={`${fid}-note`} required hint="Recorded on the incident.resolved receipt and in the incident report.">
        <Textarea id={`${fid}-note`} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canResolve} rows={3} placeholder="For example: eMudhra answered again at 11:52 IST; the 11 late batches carry both tokens; the chain verifies across the window." />
      </Field>
      {certIn && <Banner tone="held" title="CERT-In report outstanding">{certIn}</Banner>}
      {!canResolve && <Banner tone="neutral">Owners and admins resolve incidents. Your role can read it.</Banner>}
      <div className="flex justify-end">
        <Button variant="primary" size="lg" icon={<ShieldCheck className="h-4 w-4" />} disabled={!ready} loading={busy} onClick={go}>Resolve the incident</Button>
      </div>
    </div>
  );
}

/** Resume path for an auto-paused agent: two checks and a note, then the agent resumes and the incident closes. */
export function ResumeAgentForm({ agent, alertId, onDone }: { agent: Agent; alertId?: string; onDone?: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const canPause = useCan('agents.pause');
  const [alertOk, setAlertOk] = useState(false);
  const [rulesOk, setRulesOk] = useState(false);
  const [note, setNote] = useState('');
  const rid = useId();
  const m = useMutation(() => api.setAgentStatus(orgId, agent.slug, 'active', user!.id, note.trim()));
  const ready = canPause && alertOk && rulesOk && note.trim().length >= 8;
  const go = async () => {
    try {
      await m.mutate();
      toast.ok(`${agent.slug} resumed`, 'New calls are decided by its rulebook again. The incident is resolved and the resume is recorded.');
      onDone?.();
    } catch (e) {
      toast.bad('Could not resume the agent', (e as Error).message);
    }
  };
  return (
    <div className="space-y-5">
      <ol className="border border-line divide-y divide-line bg-surface">
        <CheckRow checked={alertOk} onChange={setAlertOk} disabled={!canPause} label="The alert is understood" link={alertId ? { to: `/alerts/${alertId}`, label: 'Open the alert' } : { to: '/alerts', label: 'Alerts' }}>
          Baseline and observed behaviour compared; the calls behind it read.
        </CheckRow>
        <CheckRow checked={rulesOk} onChange={setRulesOk} disabled={!canPause} label="Rulebook checked" link={{ to: `/rulebooks/${agent.slug}`, label: 'Rulebook' }}>
          If this should not happen again, tighten a rule and sign and publish it before resuming.
        </CheckRow>
      </ol>
      <Field label="Note for the record" htmlFor={rid} required hint="Recorded on the agent.resumed receipt.">
        <Textarea id={rid} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canPause} rows={3} placeholder="What was checked and what changed" />
      </Field>
      {!canPause && <Banner tone="neutral">Owners and admins resume agents. Your role can read the incident.</Banner>}
      <div className="flex justify-end">
        <Button variant="primary" size="lg" icon={<Play className="h-4 w-4" />} disabled={!ready} loading={m.pending} onClick={go}>Resume {agent.slug}</Button>
      </div>
    </div>
  );
}
