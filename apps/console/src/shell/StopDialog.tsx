import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { OctagonX, AlertTriangle } from 'lucide-react';
import { api, db } from '@/api';
import { useCan, useOrgId, useUser, needsReauth, markReauth } from '@/store/session';
import { reauth } from '@/features/work/backend';
import type { Agent } from '@/types';
import { Button, Dialog, Field, Input, Textarea, RadioCards, Checkbox, Banner, toast } from '@/components/ui';
import { AgentStatus } from '@/components/domain';

/**
 * Who an engaged stop covers, in words for the banners: every agent, or the selected agents by name
 * (up to three) or by count.
 */
export function stopCoverage(stop: { scope?: 'all_agents' | 'selected_agents'; agentSlugs?: string[] }): { all: boolean; refused: string } {
  const slugs = stop.scope === 'selected_agents' ? stop.agentSlugs ?? [] : [];
  if (!slugs.length) return { all: true, refused: 'every agent call is refused and recorded' };
  const who = slugs.length <= 3 ? slugs.join(', ') : `${slugs.length} selected agents`;
  return { all: false, refused: `calls from ${who} are refused and recorded; other agents run as normal` };
}

/**
 * Widen an engaged stop on selected agents: add agents to it, or make it a stop on every agent. One owner or admin
 * at every level — widening only stops more agents, so (like engaging) it needs no second person. Password if
 * sign-in is older than 10 minutes, as for engaging. Writes stop.widened and updates the incident. Lifting is
 * unchanged. Shown on the stop's incident page and in the stop dialog while a selected-agents stop is on.
 */
export function WidenStopForm({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const canWiden = useCan('stop.engage');
  const stop = db.getDB(orgId).stop;
  const [agents, setAgents] = useState<Agent[]>();
  const [mode, setMode] = useState<'add' | 'all'>('add');
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needPw = needsReauth();
  useEffect(() => { api.stopPreview(orgId).then((p) => setAgents(p.agents)).catch(() => setAgents([])); }, [orgId, stop.agentSlugs?.length, stop.scope]);
  if (!stop.active || stop.scope !== 'selected_agents') return null;
  // owners and admins widen the stop; no other role sees the form or a note about it
  if (!canWiden) return null;
  const covered = stop.agentSlugs ?? [];
  const candidates = (agents ?? []).filter((a) => !covered.includes(a.slug));
  const count = mode === 'all' ? candidates.length : picked.length;
  const ready = reason.trim().length >= 4 && (mode === 'all' || picked.length > 0) && (!needPw || password.length > 0);

  const widen = async () => {
    if (!user || !ready) return;
    setBusy(true);
    try {
      if (needPw) {
        try { await reauth(user.id, password); } catch (e) { setPwError((e as Error).message); return; }
        markReauth();
      }
      const r = await api.widenStop(orgId, user.id, reason.trim(), mode === 'all' ? undefined : picked);
      toast.bad('Stop widened', `${r.added.length} more ${r.added.length === 1 ? 'agent' : 'agents'} paused${mode === 'all' ? '; the stop now covers every agent' : ''}.${r.held ? ` ${r.held} more waiting ${r.held === 1 ? 'approval is' : 'approvals are'} held.` : ''} Recorded as receipt #${r.seq}.`);
      setPicked([]); setReason(''); setPassword('');
      onDone?.();
    } catch (e) {
      toast.bad('The stop was not widened', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {!compact && <p className="text-sm text-muted leading-relaxed">The stop covers {covered.length ? covered.join(', ') : 'the selected agents'}. Widening only stops more agents, so one owner or admin does it; lifting still follows the usual rule.</p>}
      <RadioCards
        name="widen-mode"
        value={mode}
        onChange={setMode}
        cols={2}
        options={[
          { value: 'add', label: 'Add agents', description: 'Stop the agents you choose below as well.' },
          { value: 'all', label: 'Every agent', description: 'Make this a stop on all agents.' },
        ]}
      />
      {mode === 'add' && (
        candidates.length ? (
          <div className="border border-line divide-y divide-line max-h-48 overflow-y-auto">
            {candidates.map((a) => (
              <div key={a.slug} className="flex items-center justify-between px-3 py-2">
                <Checkbox checked={picked.includes(a.slug)} onChange={(v) => setPicked((p) => (v ? [...p, a.slug] : p.filter((x) => x !== a.slug)))} label={a.slug} description={a.name} />
                <AgentStatus agent={a} />
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-muted">{agents ? 'No other active agent to add.' : 'Reading agents…'}</p>
      )}
      <Field label="Reason" required hint="Recorded on the stop.widened receipt and the incident.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the same supplier details reached ledger-bot too" rows={2} />
      </Field>
      {needPw && (
        <Field label="Your password" required hint="Asked because your last sign-in was more than 10 minutes ago." error={pwError} htmlFor="widen-pw">
          <Input id="widen-pw" type="password" value={password} invalid={!!pwError} onChange={(e) => { setPassword(e.target.value); setPwError(undefined); }} autoComplete="current-password" />
        </Field>
      )}
      <Button variant="danger" icon={<OctagonX className="h-4 w-4" />} disabled={!ready} loading={busy} onClick={widen}>
        {mode === 'all' ? 'Widen to every agent' : `Stop ${count} more ${count === 1 ? 'agent' : 'agents'}`}
      </Button>
    </div>
  );
}

/**
 * Emergency stop, as built: owners and admins, password if sign-in is older than 10 minutes (checked against
 * the account, not just its length), type STOP. One transaction pauses the agents and opens an incident.
 * Approvals already waiting are held by the stop: nobody can decide them until it is lifted, and their
 * expiry still runs. Only one stop is open at a time: while one is on, this dialog cannot engage another.
 */
export function StopDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const [preview, setPreview] = useState<{ agents: Agent[]; pending: number }>();
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needPw = open && needsReauth();
  const stop = open ? db.getDB(orgId).stop : undefined;
  const alreadyOn = !!stop?.active;
  // dual control: engaging is one person at every level (safety first); from L2 the lift needs a second owner or admin
  const liftDual = open && api.ops.liftNeedsSecond(orgId);
  // nobody else to be the second person: engaging still works (safety first), but say plainly what lifting will need
  const noSecond = liftDual && api.ops.liftApprovers(orgId, user?.id).length === 0;

  useEffect(() => {
    if (!open) return;
    setScope('all'); setPicked([]); setReason(''); setTyped(''); setPassword(''); setPwError(undefined);
    api.stopPreview(orgId).then(setPreview);
  }, [open, orgId]);

  const count = scope === 'all' ? preview?.agents.length ?? 0 : picked.length;
  // the field shows capitals, so compare the way it looks: "stop" typed reads STOP and counts
  const typedOk = typed.trim().toUpperCase() === 'STOP';
  const ready = !alreadyOn && typedOk && reason.trim().length >= 4 && count > 0 && (!needPw || password.length > 0);

  const engage = async () => {
    if (!user || !ready) return;
    if (db.getDB(orgId).stop.active) { toast.bad('A stop is already engaged', 'Only one stop is open at a time. Lift it from its incident before engaging another.'); return; }
    setBusy(true);
    try {
      if (needPw) {
        try {
          await reauth(user.id, password);
        } catch (e) {
          setPwError((e as Error).message);
          return;
        }
        markReauth();
      }
      const inc = await api.engageStop(orgId, user.id, reason.trim(), scope === 'all' ? undefined : picked);
      toast.bad('Emergency stop engaged', `${inc.agentSlugs.length} agents paused. Every new call is refused and recorded.`);
      onClose();
      nav(`/incidents/${inc.id}`);
    } catch (e) {
      toast.bad('The stop was not engaged', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      tone="danger"
      size="lg"
      title="Emergency stop"
      description={liftDual
        ? 'Pauses agents in one transaction. Every new call they make is refused and written to the chain. Engaging takes one person; lifting it takes two at this level — you ask, a different owner or admin approves. Only the agents it paused are resumed.'
        : 'Pauses agents in one transaction. Every new call they make is refused and written to the chain. You can lift the stop afterwards; only the agents it paused are resumed.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{alreadyOn ? 'Close' : 'Cancel'}</Button>
          {!alreadyOn && (
            <Button variant="danger" icon={<OctagonX className="h-4 w-4" />} disabled={!ready} loading={busy} onClick={engage}>
              Stop {count} {count === 1 ? 'agent' : 'agents'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {alreadyOn && (
          <Banner tone="bad" title="A stop is already engaged">
            Only one stop is open at a time. {stop?.scope === 'selected_agents'
              ? 'It covers selected agents: widen it below, or from its incident, to add agents or cover every agent. Lift it from its incident.'
              : 'It covers every agent. Lift it from its incident.'}{' '}
            {stop?.incidentId && <Link to={`/incidents/${stop.incidentId}`} onClick={onClose} className="font-semibold underline underline-offset-2">Open the incident</Link>}
          </Banner>
        )}
        {alreadyOn && stop?.scope === 'selected_agents' && (
          <WidenStopForm compact onDone={() => { onClose(); if (stop.incidentId) nav(`/incidents/${stop.incidentId}`); }} />
        )}
        {noSecond && !alreadyOn && (
          <Banner tone="held" title="Nobody else can approve lifting this stop">
            You are the only active owner or admin, and at this level a second one approves the lift. Engage it if you need to: the agents stay stopped until you invite another owner or admin in{' '}
            <Link to="/agents/people" onClick={onClose} className="font-semibold underline underline-offset-2">People and roles</Link> and they approve your request to lift it.
          </Banner>
        )}
        {!alreadyOn && (<>
        <RadioCards
          name="scope"
          value={scope}
          onChange={setScope}
          cols={2}
          options={[
            { value: 'all', label: 'Every active agent', description: 'Use when you do not yet know which agent is at fault.' },
            { value: 'selected', label: 'Selected agents', description: 'Stop only the agents you choose below.' },
          ]}
        />
        {scope === 'selected' && (
          <div className="border border-line divide-y divide-line max-h-48 overflow-y-auto">
            {preview?.agents.map((a) => (
              <div key={a.slug} className="flex items-center justify-between px-3 py-2">
                <Checkbox checked={picked.includes(a.slug)} onChange={(v) => setPicked((p) => (v ? [...p, a.slug] : p.filter((x) => x !== a.slug)))} label={a.slug} description={a.name} />
                <AgentStatus agent={a} />
              </div>
            ))}
          </div>
        )}

        <div className="grid sm:grid-cols-3 gap-px bg-line border border-line">
          <div className="bg-surface p-4"><p className="label">Agents that stop</p><p className="mt-1 font-display text-3xl font-semibold num">{count}</p></div>
          <div className="bg-surface p-4"><p className="label">New calls</p><p className="mt-1 text-sm">Refused with <span className="font-mono">agent-paused</span>, each recorded</p></div>
          <div className="bg-surface p-4"><p className="label">Waiting approvals</p><p className="mt-1 font-display text-3xl font-semibold num">{preview?.pending ?? 0}</p></div>
        </div>

        {(preview?.pending ?? 0) > 0 && (
          <Banner tone="held" title={`${preview?.pending} ${preview?.pending === 1 ? 'approval is' : 'approvals are'} held by the stop`}>
            Nobody can approve or reject them until the stop is lifted. Their expiry still runs, and an expiry is a refusal.
          </Banner>
        )}

        <Field label="Reason" required hint="Recorded on the stop receipt and the incident.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: treasury-sweeper is moving money to an unknown account" rows={2} />
        </Field>

        {needPw && (
          <Field label="Your password" required hint="Asked because your last sign-in was more than 10 minutes ago." error={pwError} htmlFor="stop-pw">
            <Input id="stop-pw" type="password" value={password} invalid={!!pwError} onChange={(e) => { setPassword(e.target.value); setPwError(undefined); }} autoComplete="current-password" />
          </Field>
        )}

        <Field label={<>Type <span className="font-mono font-semibold">STOP</span> to confirm</>} required hint={typed.trim() && !typedOk ? 'Type the word STOP exactly. Capitals are not needed.' : undefined}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="STOP" className="font-mono tracking-widest uppercase" aria-describedby="stop-help" data-autofocus />
        </Field>
        <p id="stop-help" className="flex items-center gap-1.5 text-xs text-muted"><AlertTriangle className="h-3.5 w-3.5" />No keyboard shortcut triggers the stop.</p>
        </>)}
      </div>
    </Dialog>
  );
}
