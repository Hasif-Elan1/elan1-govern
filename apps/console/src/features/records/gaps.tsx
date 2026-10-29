/**
 * Chain gaps as sealed gap records. When records could not be written for a window (advisory agents that could not
 * reach the decision service, a write-path failure, an outage), the chain itself stays linked but holds nothing for
 * that window. A gap record says so: the window, the cause, the agents and an estimate of the calls not recorded,
 * hashed and written as a receipt, so an auditor sees the gap declared rather than discovering it.
 * Shown on the chain explorer and on Proof.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, SplitSquareHorizontal } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { GAP_CAUSE_LABEL, type GapCause } from '@/mock/records';
import { dateTime, n, plural, seqLabel } from '@/lib/format';
import { Banner, Button, Checkbox, Dialog, EmptyState, Field, Hash, Input, Panel, Select, Skeleton, Textarea, Tooltip, toast } from '@/components/ui';
import { Person, ReceiptLink } from '@/components/domain';
import { SmartLink } from '@/shell/access';

const minutes = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);

export function ChainGapsPanel({ className, compact }: { className?: string; compact?: boolean }) {
  const level = useOrgLevel();
  const role = useRole();
  const manager = role === 'owner' || role === 'admin';
  const q = useQuery((o) => api.records.gaps(o), [level], { kinds: ['receipt', 'open'] });
  const [open, setOpen] = useState(false);
  const gaps = q.data?.gaps ?? [];
  const signed = level !== 'l1';
  return (
    <>
      <Panel className={className} title={<span className="inline-flex items-center gap-2"><SplitSquareHorizontal className="h-4 w-4" aria-hidden />Gaps in the chain</span>}
        kicker={gaps.length ? `${plural(gaps.length, 'sealed gap record')}` : 'None declared'}
        actions={manager ? <Tooltip content="Declare a window the chain holds no receipts for"><Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>Seal a gap record</Button></Tooltip> : undefined}
        flush footer={`A gap record does not fill the gap: it declares it, with its cause, as a receipt ${signed ? 'signed with the organisation’s key' : 'sealed in the hash chain'}. The chain stays linked across it.`}>
        {q.error ? <p className="px-5 py-4 text-sm text-bad-fg">{q.error.message}</p> : !q.data ? <div className="p-5"><Skeleton className="h-16" /></div> : gaps.length === 0 ? (
          <EmptyState compact title="No gap declared" disc="trail">{manager ? 'When records could not be written for a while, declare the window here so a verifier sees it named, not missing.' : 'When records could not be written for a while, an owner or admin declares the window here, so a verifier sees it named, not missing.'}</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {gaps.slice(0, compact ? 3 : 20).map((g) => (
              <li key={g.id} className="px-5 py-3 text-sm">
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium">{dateTime(g.from)} – {new Date(g.to).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span>
                  <span className="text-muted num">{minutes(g.from, g.to)} min</span>
                  <span className="text-muted">· {GAP_CAUSE_LABEL[g.cause]}</span>
                  {g.seq !== undefined && <span className="ml-auto"><ReceiptLink seq={g.seq} /></span>}
                </p>
                <p className="mt-1 text-fg/85">{g.summary}</p>
                <p className="mt-1 text-xs text-muted">
                  Agents {g.agents.length ? g.agents.join(', ') : 'all'} · about {n(g.estimatedMissed)} calls not recorded · last receipt before it {g.lastSeqBefore ? <Link className="font-mono underline underline-offset-2" to={`/activity/${g.lastSeqBefore}`}>{seqLabel(g.lastSeqBefore)}</Link> : '—'}
                  {g.receiptsInWindow > 0 && <> · <span className="text-held-fg">{plural(g.receiptsInWindow, 'receipt')} from {g.agents.length ? 'these agents' : 'the agents'} inside the window: a partial gap, as sealed</span></>}
                  {g.incidentId && <> · <SmartLink to={`/incidents/${g.incidentId}`} className="underline underline-offset-2">incident</SmartLink></>}
                </p>
                {!compact && <p className="mt-1 text-xs text-muted flex flex-wrap items-center gap-1.5">Sealed by <Person id={g.sealedBy} size={16} /> · digest <Hash value={g.digest} len={12} /></p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {open && q.data && <SealGapDialog agents={q.data.agents} incidents={q.data.incidents} onClose={() => setOpen(false)} />}
    </>
  );
}

const local = (t: number) => { const d = new Date(t - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

function SealGapDialog({ agents, incidents, onClose }: { agents: { slug: string; name: string; route: string }[]; incidents: { id: string; title: string; status: string }[]; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const now = Date.now();
  const [f, setF] = useState({ from: local(now - 2 * 3_600_000), to: local(now - 3_600_000), cause: 'sdk_offline' as GapCause, summary: '', agents: agents.filter((a) => a.route !== 'mcp').map((a) => a.slug), estimated: '0', incidentId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const g = await api.records.sealGap(orgId, { from: new Date(f.from).toISOString(), to: new Date(f.to).toISOString(), cause: f.cause, summary: f.summary, agents: f.agents, estimatedMissed: Number(f.estimated) || 0, incidentId: f.incidentId || undefined }, user.id);
      toast.ok('Gap record sealed', `Receipt ${g.seq !== undefined ? seqLabel(g.seq) : ''} declares ${minutes(g.from, g.to)} minutes with no receipts.`);
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="Seal a gap record" description="Declare a window the chain holds no receipts for. The record is hashed and written to the chain as written; it cannot be edited afterwards."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={f.summary.trim().length < 12} onClick={submit}>Seal the gap record</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not sealed">{err}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From" required htmlFor="gp-from"><Input id="gp-from" type="datetime-local" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="To" required htmlFor="gp-to"><Input id="gp-to" type="datetime-local" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
          <Field label="Cause" htmlFor="gp-cause"><Select id="gp-cause" value={f.cause} onChange={(e) => set('cause', e.target.value as GapCause)}>{(Object.keys(GAP_CAUSE_LABEL) as GapCause[]).map((c) => <option key={c} value={c}>{GAP_CAUSE_LABEL[c]}</option>)}</Select></Field>
          <Field label="Calls not recorded (estimate)" htmlFor="gp-n" hint="From the SDK queue log or the source system. 0 if none."><Input id="gp-n" type="number" min={0} value={f.estimated} onChange={(e) => set('estimated', e.target.value)} /></Field>
        </div>
        <Field label="What happened" required htmlFor="gp-sum" hint="Plain words. Sealed exactly as written."><Textarea id="gp-sum" rows={3} value={f.summary} onChange={(e) => set('summary', e.target.value)} placeholder="The decision service was unreachable from the office network for 14 minutes. Advisory agents went ahead without a receipt." data-autofocus /></Field>
        <Field label="Agents affected">
          <div className="grid gap-2 sm:grid-cols-2 border border-line p-3 max-h-48 overflow-y-auto">
            {agents.map((a) => <Checkbox key={a.slug} checked={f.agents.includes(a.slug)} onChange={(v) => set('agents', v ? [...f.agents, a.slug] : f.agents.filter((x) => x !== a.slug))} label={<span className="font-mono">{a.slug}</span>} description={a.route === 'mcp' ? 'Governed run: refuses when it cannot record' : 'Check and record: runs its own calls'} />)}
          </div>
        </Field>
        {incidents.length > 0 && (
          <Field label="Linked incident" htmlFor="gp-inc"><Select id="gp-inc" value={f.incidentId} onChange={(e) => set('incidentId', e.target.value)}><option value="">None</option>{incidents.map((i) => <option key={i.id} value={i.id}>{i.title} ({i.status})</option>)}</Select></Field>
        )}
        <p className="text-xs text-muted">Written as <span className="font-mono">chain.gap_sealed</span>, {level === 'l1' ? 'sealed in the hash chain' : 'signed with the organisation’s key'}.</p>
      </div>
    </Dialog>
  );
}
