/**
 * Model name and version on agents and AI systems, and the RBI model-documentation export from the AI inventory.
 * The model is recorded as a receipt (agent.model_recorded, inventory.model_recorded, or inside inventory.updated);
 * the export is recorded as inventory.model_doc_exported with the digest of the file.
 */
import { useEffect, useState } from 'react';
import { Cpu, FileDown, Pencil } from 'lucide-react';
import type { Agent, AiSystem } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { modelOf } from '@/mock/records';
import { pdfBlob } from '@/lib/pdf';
import { date, plural } from '@/lib/format';
import { Banner, Button, Checkbox, Dialog, Field, Hash, Input, KeyValue, LegalDraft, Panel, RadioCards, Skeleton, Tooltip, toast } from '@/components/ui';
import { Person, ReceiptLink } from '@/components/domain';
import { downloadText } from '@/features/records/level';

/** "Claude Sonnet 4.5 · claude-sonnet-4-5-20250929", or a quiet "Not recorded". */
export function ModelLabel({ x, className }: { x?: { modelName?: string; modelVersion?: string }; className?: string }) {
  const m = modelOf(x);
  if (!m) return <span className={className ?? 'text-subtle'}>Not recorded</span>;
  return <span className={className}><span className="font-medium">{m.name}</span> <span className="font-mono text-[12px] text-muted break-all">{m.version}</span></span>;
}

/** Record or change the model of an agent (its linked AI system follows) or of an AI system. */
export function SetModelDialog({ target, current, title, onClose }: { target: { kind: 'agent' | 'ai_system'; id: string }; current?: { modelName?: string; modelVersion?: string }; title: string; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const [name, setName] = useState(current?.modelName ?? '');
  const [version, setVersion] = useState(current?.modelVersion ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await api.records.setModel(orgId, target, { name, version }, user.id);
      toast.ok('Model recorded', `${name} ${version}. The change is a receipt on the chain.`);
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={title} description="Name the model and the exact version or snapshot it runs. A change of model is a change an auditor and the RBI documentation will ask about."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Record the model</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not recorded">{err}</Banner>}
        <Field label="Model name" required htmlFor="md-name"><Input id="md-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Sonnet 4.5" data-autofocus /></Field>
        <Field label="Version or snapshot" required htmlFor="md-ver" hint="The id the provider gives the snapshot. “Not disclosed by the vendor” is an answer too."><Input id="md-ver" mono value={version} onChange={(e) => setVersion(e.target.value)} placeholder="claude-sonnet-4-5-20250929" /></Field>
        <p className="text-xs text-muted">{target.kind === 'agent' ? 'The linked AI system is updated too. ' : ''}Recorded as a receipt, {level === 'l1' ? 'sealed in the hash chain' : 'signed with the organisation’s key'}.</p>
      </div>
    </Dialog>
  );
}

/** On the agent page: the model the agent runs, with a way to record a change. */
export function AgentModelPanel({ agent }: { agent: Pick<Agent, 'id' | 'slug' | 'framework' | 'modelName' | 'modelVersion'> }) {
  const role = useRole();
  const manager = role === 'owner' || role === 'admin';
  const [open, setOpen] = useState(false);
  // older saved agents get the demo model on first read
  useSeed();
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Cpu className="h-4 w-4" aria-hidden />Model</span>} kicker="What it runs on"
      actions={manager ? <Tooltip content="Record the model and version"><Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>{agent.modelName ? 'Change' : 'Record'}</Button></Tooltip> : undefined}>
      <KeyValue items={[
        { k: 'Model', v: agent.modelName ?? <span className="text-subtle">Not recorded</span> },
        { k: 'Version', v: agent.modelVersion ? <span className="font-mono text-[12px] break-all">{agent.modelVersion}</span> : <span className="text-subtle">—</span> },
        { k: 'Framework', v: agent.framework },
      ]} />
      {manager && open && <SetModelDialog target={{ kind: 'agent', id: agent.id }} current={agent} title={`Model of ${agent.slug}`} onClose={() => setOpen(false)} />}
    </Panel>
  );
}

/** Make sure the demo model data exists for this organisation (runs once per organisation). */
export function useSeed() {
  const orgId = useOrgId();
  useEffect(() => { try { api.records.ensureSeed(orgId); } catch { /* fine */ } }, [orgId]);
}

/** The RBI model-documentation export: choose systems and format, download, recorded on the chain. */
export function ModelDocDialog({ systems, initial, onClose }: { systems: Pick<AiSystem, 'id' | 'name' | 'lifecycle' | 'riskTier' | 'modelName' | 'modelVersion'>[]; initial?: string[]; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const [picked, setPicked] = useState<string[]>(initial ?? systems.filter((s) => s.lifecycle !== 'retired').map((s) => s.id));
  const [format, setFormat] = useState<'pdf' | 'json'>('pdf');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ filename: string; digest: string; seq: number }>();
  const hist = useQuery((o) => api.records.modelDocHistory(o), [done?.seq], { live: false });
  const missing = systems.filter((s) => picked.includes(s.id) && !s.modelName).length;
  const run = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.records.exportModelDoc(orgId, { systemIds: picked, format }, user.id);
      if (format === 'pdf') {
        const url = URL.createObjectURL(pdfBlob(r.text));
        const a = document.createElement('a');
        a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else downloadText(r.filename, r.text, r.mime);
      setDone({ filename: r.filename, digest: r.digest, seq: r.seq });
      toast.ok('Model documentation downloaded', `${plural(r.systems, 'AI system')}. Recorded on the chain.`);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="RBI model documentation" description="One document per AI system for a supervisory review: model and version, purpose, owner, data, risk tier and who signed it off, the rules in force, recent activity and the change log — taken from the inventory and the chain."
      footer={<><Button variant="ghost" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button><Button variant="primary" icon={<FileDown className="h-4 w-4" />} loading={busy} disabled={!picked.length} onClick={run}>{done ? 'Export again' : 'Export'}</Button></>}>
      <div className="space-y-5">
        <div className="flex items-center gap-2"><LegalDraft /></div>
        {err && <Banner tone="bad" title="Not exported">{err}</Banner>}
        {done && <Banner tone="ok" title={done.filename}>Recorded as <ReceiptLink seq={done.seq} />. SHA-256 <Hash value={done.digest} len={16} /> — give the digest with the file so the reader can check it is unchanged.</Banner>}
        <Field label={`AI systems (${picked.length} of ${systems.length})`}>
          <div className="grid gap-2 sm:grid-cols-2 border border-line p-3 max-h-60 overflow-y-auto">
            {systems.map((s) => (
              <Checkbox key={s.id} checked={picked.includes(s.id)} onChange={(v) => setPicked((p) => (v ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                label={s.name} description={<>{s.modelName ? `${s.modelName} · ${s.modelVersion ?? ''}` : 'Model not recorded'} · {s.riskTier}{s.lifecycle === 'retired' ? ' · retired' : ''}</>} />
            ))}
          </div>
        </Field>
        {missing > 0 && <Banner tone="held" title={`${plural(missing, 'system')} without a recorded model`}>The document says “Not recorded” for them. Record the model on the system page first if you can.</Banner>}
        <Field label="Format">
          <RadioCards name="mdformat" cols={2} value={format} onChange={setFormat} options={[
            { value: 'pdf', label: 'PDF', description: 'To read and file with the review.' },
            { value: 'json', label: 'JSON', description: 'The same content, for a regulator’s tooling.' },
          ]} />
        </Field>
        <p className="text-xs text-muted">{level === 'l1' ? 'Changes listed in it are sealed in the hash chain by Elan1 Govern and not yet externally timestamped.' : 'Changes listed in it are signed with the organisation’s key and timestamped.'} The hosting profile and residency domain are stated on the first page.</p>
        {hist.loading && !hist.data ? <Skeleton className="h-10" /> : hist.data && hist.data.length > 0 && (
          <div>
            <p className="label mb-1">Earlier exports</p>
            <ul className="space-y-1 text-sm">
              {hist.data.slice(0, 5).map((h) => <li key={h.id} className="flex flex-wrap items-center gap-2"><span>{date(h.at)}</span><Person id={h.by} size={16} /><span className="text-muted">{plural(h.systems, 'system')} · {h.format.toUpperCase()}</span>{h.seq !== undefined && <ReceiptLink seq={h.seq} />}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
