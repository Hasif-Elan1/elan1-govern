import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Megaphone } from 'lucide-react';
import { api } from '@/api';
import { useOrgId, useUser } from '@/store/session';
import type { Agent } from '@/types';
import { n } from '@/lib/format';
import { Banner, Button, Checkbox, Dialog, Field, Input, RadioCards, Textarea, toast } from '@/components/ui';
import { CERT_IN_ALWAYS, type DeclaredClass } from '@/mock/ops';

const CLASSES: { value: DeclaredClass; label: string; description: string }[] = [
  { value: 'key_compromise', label: 'Key compromise', description: 'An agent key, API key or signing key was exposed or used by someone else.' },
  { value: 'isolation_breach', label: 'Isolation breach', description: 'Data or calls crossed a tenant, network or cluster boundary.' },
  { value: 'receipt_write', label: 'Receipt write failure', description: 'Receipts could not be written; the guard refused what it could not record.' },
  { value: 'chain_break', label: 'Chain integrity break', description: 'A receipt does not link to the one before it, or its hash is wrong.' },
  { value: 'security_other', label: 'Other security incident', description: 'Anything else that needs an owner, a record and a report.' },
];

/** The local date-time value for an <input type="datetime-local">, in India Standard Time. */
function istLocal(t: number) {
  return new Date(t + 5.5 * 3.6e6).toISOString().slice(0, 16);
}
function fromIstLocal(v: string) {
  const t = Date.parse(`${v}:00Z`);
  return Number.isFinite(t) ? new Date(t - 5.5 * 3.6e6).toISOString() : '';
}

/**
 * Declare an incident by hand: its class, what happened, when it was noticed, the agents involved (optionally paused
 * now) and whether it is reportable to CERT-In. A key compromise or an isolation breach always starts the six-hour clock.
 */
export function DeclareDialog({ open, onClose, agents }: { open: boolean; onClose: () => void; agents: Agent[] }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const fid = useId();
  const [cls, setCls] = useState<DeclaredClass>('key_compromise');
  const [title, setTitle] = useState('');
  const [what, setWhat] = useState('');
  const [noticed, setNoticed] = useState(istLocal(Date.now()));
  const [picked, setPicked] = useState<string[]>([]);
  const [pause, setPause] = useState(true);
  const [certIn, setCertIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const always = CERT_IN_ALWAYS.includes(cls);

  useEffect(() => {
    if (!open) return;
    setCls('key_compromise'); setTitle(''); setWhat(''); setNoticed(istLocal(Date.now())); setPicked([]); setPause(true); setCertIn(true);
  }, [open]);

  const ready = title.trim().length >= 4 && what.trim().length >= 10 && !!fromIstLocal(noticed);
  const go = async () => {
    if (!user || !ready) return;
    setBusy(true);
    try {
      const inc = api.ops.declareIncident(orgId, { cls, title, what, noticedAt: fromIstLocal(noticed), agents: picked, pause: pause && picked.length > 0, certIn: always || certIn }, user.id);
      toast.bad('Incident declared', `${inc.title}. Recorded on the chain${always || certIn ? '; the CERT-In six-hour clock is running' : ''}.`);
      onClose();
      nav(`/incidents/${inc.id}`);
    } catch (e) {
      toast.bad('Not declared', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Declare an incident"
      description="For what the detectors cannot see: a leaked key, a broken boundary, a failure you found yourself. Declaring opens the incident with its guided checks and is a receipt on the chain."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Megaphone className="h-4 w-4" />} disabled={!ready} loading={busy} onClick={go}>Declare the incident</Button></>}>
      <div className="space-y-5">
        <RadioCards name="incident-class" value={cls} onChange={setCls} cols={2} options={CLASSES.map((c) => ({ value: c.value, label: c.label, description: c.description }))} />
        <Field label="Title" htmlFor={`${fid}-t`} required>
          <Input id={`${fid}-t`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Agent API key exposed in a CI build log" data-autofocus />
        </Field>
        <Field label="What happened" htmlFor={`${fid}-w`} required hint="What you know now. You add to it as you work through the checks.">
          <Textarea id={`${fid}-w`} rows={3} value={what} onChange={(e) => setWhat(e.target.value)} />
        </Field>
        <Field label="Noticed at (IST)" htmlFor={`${fid}-n`} required hint="The CERT-In clock runs six hours from when it was noticed, not from when it is declared.">
          <Input id={`${fid}-n`} type="datetime-local" value={noticed} max={istLocal(Date.now())} onChange={(e) => setNoticed(e.target.value)} />
        </Field>
        <div>
          <p className="label mb-2">Agents involved</p>
          {agents.length === 0 ? <p className="text-sm text-muted">No agents in this organisation.</p> : (
            <div className="border border-line divide-y divide-line max-h-44 overflow-y-auto">
              {agents.map((a) => (
                <div key={a.slug} className="px-3 py-2">
                  <Checkbox checked={picked.includes(a.slug)} onChange={(v) => setPicked((p) => (v ? [...p, a.slug] : p.filter((x) => x !== a.slug)))} label={a.slug} description={`${a.name} · ${a.status}`} />
                </div>
              ))}
            </div>
          )}
          {picked.length > 0 && (
            <div className="mt-2">
              <Checkbox checked={pause} onChange={setPause} label={`Pause ${n(picked.length)} ${picked.length === 1 ? 'agent' : 'agents'} now`} description="Each pause is its own receipt. A person resumes them when the checks are done." />
            </div>
          )}
        </div>
        {always ? (
          <Banner tone="held" title="Reportable to CERT-In within six hours">A {cls === 'key_compromise' ? 'key compromise' : 'isolation breach'} always starts the clock. The report is drafted on the incident.</Banner>
        ) : (
          <Checkbox checked={certIn} onChange={setCertIn} label="Reportable to CERT-In" description="Starts the six-hour clock and a report draft. An owner can later record why it is not reportable." />
        )}
      </div>
    </Dialog>
  );
}
