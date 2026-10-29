import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pause, Play, KeyRound, ShieldAlert, AlertTriangle, RefreshCw, Archive, Trash2 } from 'lucide-react';
import { api } from '@/api';
import { useOrgId, useUser } from '@/store/session';
import type { Agent, AgentKey, Alert, Incident } from '@/types';
import { date, dateTime, plural } from '@/lib/format';
import { Banner, Button, Checkbox, CopyButton, Dialog, Field, Input, RadioCards, Select, Textarea, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { deleteAgent, issueKey, retireAgent, rotateKey, type ExtKey } from './backend';
import { useQuery } from '@/hooks/useQuery';
import { devpathApi } from '@/mock/devpath';
import { RequestForm } from '@/features/developers/console/RequestForm';

/* ── Pause / resume ───────────────────────────────────────── */

export function PauseDialog({ open, onClose, agent, alert, incident }: { open: boolean; onClose: () => void; agent: Agent; alert?: Alert; incident?: Incident }) {
  const orgId = useOrgId();
  const user = useUser();
  const pausing = agent.status === 'active';
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setReason(''); }, [open]);

  const ready = pausing ? reason.trim().length >= 4 : true;

  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await api.setAgentStatus(orgId, agent.slug, pausing ? 'paused' : 'active', user.id, reason.trim() || undefined);
      if (pausing) toast.held(`${agent.slug} paused`, 'Every new call is refused with agent-paused and recorded.');
      else toast.ok(`${agent.slug} resumed`, incident ? 'The auto-pause incident is resolved.' : 'New calls are decided by its rulebook again.');
      onClose();
    } catch (e) {
      toast.bad('Could not change the agent', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      tone={pausing ? 'danger' : undefined}
      title={pausing ? `Pause ${agent.slug}` : `Resume ${agent.slug}`}
      description={pausing
        ? 'While paused, every call this agent makes is refused with the reason agent-paused and written to the chain. Approvals already waiting are not cancelled.'
        : 'New calls are decided by the published rulebook again. The resume is recorded as a receipt.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={pausing ? 'danger' : 'primary'} icon={pausing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} disabled={!ready} loading={busy} onClick={go}>
            {pausing ? 'Pause agent' : 'Resume agent'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!pausing && agent.pausedBy === 'auto-pause' && (
          <Banner tone="held" title="This agent was paused automatically">
            {alert ? <>A high-severity <Link className="underline" to={`/alerts/${alert.id}`}>{alert.detector.replace('_', ' ')} alert</Link> paused it. </> : 'A high-severity alert paused it. '}
            Resuming resolves {incident ? <Link className="underline" to={`/incidents/${incident.id}`}>the incident</Link> : 'the incident'}. Check the alert first.
          </Banner>
        )}
        <Field label="Reason" required={pausing} hint="Recorded on the receipt so the next person knows why.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={pausing ? 'For example: rulebook under review after a near miss' : 'For example: alert reviewed with the owner — transfers were a test'} data-autofocus />
        </Field>
      </div>
    </Dialog>
  );
}

/* ── Shown-once secret ────────────────────────────────────── */

function SecretOnce({ secret, stored, setStored, extra }: { secret: string; stored: boolean; setStored: (v: boolean) => void; extra?: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border border-line bg-sunken/70 p-3">
        <code className="flex-1 min-w-0 break-all font-mono text-[13px]">{secret}</code>
        <CopyButton text={secret} label="Copy key" />
      </div>
      {extra}
      <Banner tone="held" title="It will not be shown again">If you lose it, revoke it and issue a new one. Never paste it into a chat or a ticket.</Banner>
      <Checkbox checked={stored} onChange={setStored} label="I have stored this key somewhere safe" />
    </div>
  );
}

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
];

/* ── Issue key ────────────────────────────────────────────── */

export function IssueKeyDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const orgId = useOrgId();
  const user = useUser();
  const [label, setLabel] = useState('');
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [expiry, setExpiry] = useState('90');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [seq, setSeq] = useState<number>();
  const [stored, setStored] = useState(false);
  const [error, setError] = useState<string>();
  const [asked, setAsked] = useState(false);
  // production keys are asked for and reviewed, never issued here (the path to production)
  const { data: path } = useQuery((o) => devpathApi.view(o), [open], { kinds: ['devpath', 'agent'] });
  const openReq = path?.state.requests.find((r) => r.agentSlug === agent.slug && (r.status === 'in_review' || r.status === 'approved'));

  useEffect(() => { if (open) { setLabel(''); setEnv('sandbox'); setExpiry('90'); setSecret(undefined); setStored(false); setError(undefined); setSeq(undefined); setAsked(false); } }, [open]);

  const issue = async () => {
    if (!user || env === 'production') return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await issueKey(orgId, agent.slug, { label: label.trim(), environment: env, expiresDays: expiry === 'never' ? undefined : Number(expiry) }, user.id);
      setSecret(r.secret);
      setSeq(r.receipt.seq);
      toast.ok('Key issued', `${label.trim()} · ${env === 'sandbox' ? 'Sandbox' : 'Production'}${r.key.expiresAt ? ` · expires ${date(r.key.expiresAt)}` : ''}. The issue is recorded.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={secret && !stored ? () => toast.held('Store the key first', 'Tick the box once the key is in your secret manager. It will not be shown again.') : onClose}
      size={env === 'production' && !secret ? 'lg' : undefined}
      title={secret ? 'Copy the key now' : env === 'production' ? `Ask for a production key for ${agent.slug}` : `Issue a key for ${agent.slug}`}
      description={secret ? 'This is the only time the full key is shown. Elan1 Govern keeps only a hash and the prefix.' : env === 'production' ? 'A production key (gk_) is never issued directly. Your request is recorded and a person reviews it within 2 working days; once approved, you collect the key once on Path to production.' : 'Each key identifies this agent on every call. Use sandbox keys while you build.'}
      footer={secret ? (
        <Button variant="primary" disabled={!stored} onClick={onClose}>Done</Button>
      ) : env === 'production' ? (
        <Button variant={asked ? 'primary' : 'ghost'} onClick={onClose}>{asked ? 'Done' : 'Cancel'}</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} disabled={label.trim().length < 3} loading={busy} onClick={issue}>Issue key</Button>
        </>
      )}
    >
      {secret ? (
        <SecretOnce secret={secret} stored={stored} setStored={setStored} extra={seq ? <p className="text-sm text-muted">Recorded on <ReceiptLink seq={seq} />.</p> : undefined} />
      ) : (
        <div className="space-y-4">
          {error && <Banner tone="bad" title="The key was not issued">{error}</Banner>}
          {env === 'sandbox' && (
            <Field label="Label" required hint="Where the key is used, so you know what breaks if you revoke it." htmlFor="key-label">
              <Input id="key-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="For example: LangChain worker — staging" data-autofocus />
            </Field>
          )}
          <Field label="Environment">
            <RadioCards
              name="env"
              cols={2}
              value={env}
              onChange={setEnv}
              options={[
                { value: 'sandbox', label: 'Sandbox', description: 'Key starts sk_sbx_. Issued now, for building and tests. Metered at 0.' },
                { value: 'production', label: 'Production', description: 'Key starts gk_. Asked for and reviewed by a person within 2 working days.' },
              ]}
            />
          </Field>
          {env === 'sandbox' ? (
            <Field label="Expires" htmlFor="key-expiry" hint="After the expiry the key stops working and shows as Expired. Rotate before then to keep the agent connected.">
              <Select id="key-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
          ) : openReq ? (
            <Banner tone={openReq.status === 'approved' ? 'ok' : 'held'} title={openReq.status === 'approved' ? 'Approved — ready to collect' : 'A request is already in review'}>
              {openReq.status === 'approved' ? 'The production key for this agent was approved. Collect it once' : `Asked ${dateTime(openReq.submittedAt ?? openReq.requestedAt)}; a decision is due by ${dateTime(openReq.dueBy ?? openReq.requestedAt)}. Follow it`} on <Link to="/agents/production?tab=keys" className="underline" onClick={onClose}>Path to production</Link>.
            </Banner>
          ) : path ? (
            <RequestForm view={path} agentSlug={agent.slug} lockAgent onDone={() => setAsked(true)} />
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

/* ── Rotate key ───────────────────────────────────────────── */

export function RotateKeyDialog({ keyItem, onClose, agent }: { keyItem?: ExtKey; onClose: () => void; agent: Agent }) {
  const orgId = useOrgId();
  const user = useUser();
  const [grace, setGrace] = useState('24');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [revokeAt, setRevokeAt] = useState<string>();
  const [seq, setSeq] = useState<number>();
  const [stored, setStored] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (keyItem) { setGrace('24'); setSecret(undefined); setStored(false); setError(undefined); setRevokeAt(undefined); setSeq(undefined); } }, [keyItem]);
  // a production key (gk_) is rotated only with an approved production review (the path to production)
  const prod = keyItem?.environment === 'production';
  const { data: path } = useQuery((o) => devpathApi.view(o), [!!keyItem], { kinds: ['devpath', 'agent'] });
  const prodReq = path?.state.requests.find((r) => r.agentSlug === agent.slug && (r.status === 'in_review' || r.status === 'approved'));
  const reviewed = !prod || prodReq?.status === 'approved';

  const rotate = async () => {
    if (!user || !keyItem || !reviewed) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await rotateKey(orgId, agent.slug, keyItem.id, Number(grace), user.id);
      setSecret(r.secret);
      setRevokeAt(r.old.revokeAt);
      setSeq(r.receipt.seq);
      toast.ok('Key rotated', Number(grace) ? `The old key keeps working until ${dateTime(r.old.revokeAt!)}, then it is revoked.` : 'The old key is revoked now.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!keyItem}
      onClose={secret && !stored ? () => toast.held('Store the key first', 'Tick the box once the new key is in your secret manager.') : onClose}
      title={secret ? 'Copy the new key now' : 'Rotate this key'}
      size={prod && !reviewed && !prodReq && !secret ? 'lg' : undefined}
      description={secret ? 'Replace the old key wherever the agent uses it. This is the only time the full key is shown.' : prod ? 'A production key (gk_) is replaced only after the production review approves it, the same as issuing one. Once approved, the replacement is issued here and the old key keeps working for the grace period, then the system revokes it. Every step is a receipt.' : 'A replacement with the same label, environment and lifetime is issued now. The old key keeps working for the grace period, then the system revokes it. Both steps are receipts.'}
      footer={secret ? <Button variant="primary" disabled={!stored} onClick={onClose}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} disabled={!reviewed} loading={busy} onClick={rotate}>Rotate key</Button>
        </>
      )}
    >
      {keyItem && (secret ? (
        <SecretOnce secret={secret} stored={stored} setStored={setStored} extra={<p className="text-sm text-muted">{revokeAt ? <>Old key <span className="font-mono">{keyItem.prefix}…</span> is revoked at {dateTime(revokeAt)}. </> : <>Old key <span className="font-mono">{keyItem.prefix}…</span> is revoked. </>}{seq && <>Recorded on <ReceiptLink seq={seq} />.</>}</p>} />
      ) : (
        <div className="space-y-4">
          {error && <Banner tone="bad" title="The key was not rotated">{error}</Banner>}
          <p className="text-sm"><span className="font-mono">{keyItem.prefix}…</span> · {keyItem.label} · {keyItem.environment === 'production' ? 'Production' : 'Sandbox'}</p>
          {prod && (prodReq ? (
            <Banner tone={prodReq.status === 'approved' ? 'ok' : 'held'} title={prodReq.status === 'approved' ? 'Production review approved' : 'The production review is in progress'}>
              {prodReq.status === 'approved' ? 'Rotating uses this approval: the replacement gk_ key is issued once, here.' : `Asked ${dateTime(prodReq.submittedAt ?? prodReq.requestedAt)}; a decision is due by ${dateTime(prodReq.dueBy ?? prodReq.requestedAt)}. You can rotate once it is approved.`} Follow it on <Link to="/agents/production?tab=keys" className="underline" onClick={onClose}>Path to production</Link>.
            </Banner>
          ) : path ? (
            <>
              <Banner tone="held" title="Ask for a reviewed replacement first">A person checks the request within 2 working days. Once it is approved, come back and rotate; the old key keeps working until then.</Banner>
              <RequestForm view={path} agentSlug={agent.slug} lockAgent />
            </>
          ) : null)}
          <Field label="Grace period for the old key" htmlFor="rot-grace" hint="Long enough to deploy the new key everywhere the agent runs.">
            <Select id="rot-grace" value={grace} onChange={(e) => setGrace(e.target.value)}>
              <option value="0">None — revoke the old key now</option>
              <option value="1">1 hour</option>
              <option value="24">24 hours</option>
              <option value="72">72 hours</option>
              <option value="168">7 days</option>
            </Select>
          </Field>
        </div>
      ))}
    </Dialog>
  );
}

/* ── Revoke key ───────────────────────────────────────────── */

export function RevokeKeyDialog({ keyItem, onClose, agent }: { keyItem?: AgentKey; onClose: () => void; agent: Agent }) {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const live = agent.keys.filter((k) => !k.revoked);
  const last = keyItem && live.length === 1 && live[0].id === keyItem.id;

  const revoke = async () => {
    if (!user || !keyItem) return;
    setBusy(true);
    try {
      await api.revokeKey(orgId, agent.slug, keyItem.id, user.id);
      toast.ok('Key revoked', `${keyItem.prefix}… stops working on the next call. The revocation is recorded.`);
      onClose();
    } catch (e) {
      toast.bad('Could not revoke the key', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!keyItem}
      onClose={onClose}
      tone="danger"
      size="sm"
      title="Revoke this key?"
      description="Calls with this key are refused from now on. You cannot undo a revocation; issue a new key instead."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<ShieldAlert className="h-4 w-4" />} loading={busy} onClick={revoke}>Revoke key</Button>
        </>
      }
    >
      {keyItem && (
        <div className="space-y-3 text-sm">
          <p><span className="font-mono">{keyItem.prefix}…</span> · {keyItem.label}</p>
          {last && (
            <p className="flex items-start gap-1.5 text-held-fg"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />This is the agent's last active key. The agent cannot connect until you issue another.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ── Retire ───────────────────────────────────────────────── */

export function RetireDialog({ open, onClose, agent, receipts, grants }: { open: boolean; onClose: () => void; agent: Agent; receipts: number; grants: number }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setReason(''); setConfirm(''); setError(undefined); } }, [open]);
  const keys = agent.keys.filter((k) => !k.revoked).length;

  const go = async () => {
    if (!user) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await retireAgent(orgId, agent.slug, reason, user.id);
      toast.ok(`${agent.slug} retired`, `${plural(r.keysRevoked, 'key')} revoked${r.grantsRevoked ? `, ${plural(r.grantsRevoked, 'graduation')} to A3 revoked` : ''}. Receipt #${r.receipt.seq}.`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} tone="danger" title={`Retire ${agent.slug}`}
      description="Retiring stops the agent for good. Its record, rulebook versions and every receipt stay on the chain and keep verifying."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Archive className="h-4 w-4" />} loading={busy} disabled={reason.trim().length < 4 || confirm !== agent.slug} onClick={go}>Retire agent</Button></>}>
      <div className="space-y-4">
        {error && <Banner tone="bad" title="The agent was not retired">{error}</Banner>}
        <ul className="text-sm space-y-1.5 list-disc pl-5">
          <li>{plural(keys, 'active key')} revoked now; calls with them are refused.</li>
          <li>Every later call is refused with <span className="font-mono">agent-paused</span> and recorded.</li>
          {grants > 0 && <li>{plural(grants, 'graduation')} to A3 revoked, each with a receipt.</li>}
          <li>{plural(receipts, 'receipt')} for this agent stay verifiable.</li>
        </ul>
        <Field label="Reason" required htmlFor="ret-reason" hint="Recorded on the agent.retired receipt.">
          <Textarea id="ret-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: replaced by the payables-v2 agent" data-autofocus />
        </Field>
        <Field label={<>Type <span className="font-mono">{agent.slug}</span> to confirm</>} htmlFor="ret-confirm">
          <Input id="ret-confirm" mono value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ── Delete (only an agent that never made a call) ───────── */

export function DeleteAgentDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setConfirm(''); setError(undefined); } }, [open]);

  const go = async () => {
    if (!user) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await deleteAgent(orgId, agent.slug, user.id);
      toast.ok(`${agent.slug} deleted`, `It made no calls. The deletion is receipt #${r.seq}.`);
      onClose();
      nav('/agents');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} tone="danger" size="sm" title={`Delete ${agent.slug}?`}
      description="This agent has made no calls, so nothing on the chain depends on it. Its keys and rulebook are removed. The creation and the deletion stay on the chain."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Trash2 className="h-4 w-4" />} loading={busy} disabled={confirm !== agent.slug} onClick={go}>Delete agent</Button></>}>
      <div className="space-y-4">
        {error && <Banner tone="bad" title="The agent was not deleted">{error}</Banner>}
        <Field label={<>Type <span className="font-mono">{agent.slug}</span> to confirm</>} htmlFor="del-confirm">
          <Input id="del-confirm" mono value={confirm} onChange={(e) => setConfirm(e.target.value)} data-autofocus />
        </Field>
      </div>
    </Dialog>
  );
}
