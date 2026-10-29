/**
 * Hosting profiles 1–4, and profile 2: a dedicated residency domain (from L2). Shown on Agents › Deployment and
 * Agents › Organisation › Residency; the profile is also written into every L2+ evidence bundle manifest
 * (hosting_profile) and onto the RBI model documentation. Each move is a receipt.
 */
import { useState } from 'react';
import { ArrowRightLeft, CheckCircle2, CircleDashed, MapPin, Server, Undo2 } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { DEDICATED_REGIONS } from '@/mock/records';
import { LEVEL_INFO } from '@/lib/levels';
import { date } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Dialog, Field, Panel, RadioCards, Skeleton, StatusChip, Textarea, Tooltip, toast } from '@/components/ui';
import { Person, ReceiptLink } from '@/components/domain';
import { LevelPreview } from '@/features/records/level';

export function HostingProfilePanel({ className }: { className?: string }) {
  const level = useOrgLevel();
  const role = useRole();
  const owner = role === 'owner';
  const q = useQuery((o) => api.records.hosting(o), [level], { kinds: ['deployment', 'receipt', 'open'] });
  const [dialog, setDialog] = useState<'request' | 'activate' | 'return'>();
  const h = q.data;
  const ded = h?.dedicated && h.dedicated.status !== 'returned' ? h.dedicated : undefined;

  return (
    <Panel className={className} title={<span className="inline-flex items-center gap-2"><Server className="h-4 w-4" aria-hidden />Hosting profile</span>}
      kicker={h ? `Profile ${h.current.profile} · ${h.current.name}` : undefined}
      actions={owner && h && (h.eligible || h.suspended) ? (
        // Owner-only: other roles see the profile read-only, with no greyed-out buttons.
        ded?.status === 'active' ? <Tooltip content="Move back to the shared hosted stack"><Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => setDialog('return')}>Return to shared</Button></Tooltip>
          : ded?.status === 'provisioning' ? <Tooltip content="Confirm the cut-over to the dedicated domain"><Button size="sm" variant="primary" icon={<ArrowRightLeft className="h-3.5 w-3.5" />} onClick={() => setDialog('activate')}>Cut over</Button></Tooltip>
            : <Tooltip content="Run in a stack of your own in an Indian region"><Button size="sm" variant="secondary" onClick={() => setDialog('request')}>Move to a dedicated domain</Button></Tooltip>
      ) : undefined}
      flush footer={h ? (h.inBundles
        ? <span>Every evidence bundle states the hosting profile in its manifest (<span className="font-mono">hosting_profile</span>), and so does the RBI model documentation.</span>
        : <span>The RBI model documentation states the hosting profile. Evidence bundles, which state it in their manifest (<span className="font-mono">hosting_profile</span>), start at {LEVEL_INFO.l2.label}; the {LEVEL_INFO.l1.short} auditor pack does not carry it.</span>) : undefined}>
      {q.error ? <p className="px-5 py-4 text-sm text-bad-fg">{q.error.message}</p> : !h ? <div className="p-5"><Skeleton className="h-28" /></div> : (
        <div>
          <ol className="grid sm:grid-cols-2 xl:grid-cols-4 border-b border-line">
            {h.profiles.map((p) => (
              <li key={p.n} className={cn('p-4 border-b sm:border-b-0 sm:border-r last:border-r-0 border-line min-w-0', p.current && 'bg-sunken/60 shadow-[inset_0_3px_0_rgb(var(--fg))]')} aria-current={p.current ? 'true' : undefined}>
                <p className="flex items-center gap-1.5 text-sm font-semibold">{p.current ? <CheckCircle2 className="h-4 w-4 text-ok-fg" aria-hidden /> : <CircleDashed className="h-4 w-4 text-subtle" aria-hidden />}{p.n}. {p.name}</p>
                <p className="mt-1 text-xs text-muted">{p.description}</p>
                <p className="mt-1.5">{p.current ? <Badge tone="inverse">This organisation</Badge> : p.reachable ? <Badge>Available</Badge> : <Badge>From {LEVEL_INFO[p.minLevel].short}</Badge>}</p>
              </li>
            ))}
          </ol>
          <div className="px-5 py-4 space-y-3">
            <p className="flex flex-wrap items-center gap-2 text-sm"><MapPin className="h-4 w-4 text-muted" aria-hidden /><span className="label">Residency domain</span><span className="font-medium break-all">{h.current.residency_domain}</span></p>
            {ded && (
              <div className="space-y-2">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {ded.status === 'active' ? <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" />}>Dedicated domain active</StatusChip> : <StatusChip size="sm" tone="held">Provisioned · waiting for the cut-over</StatusChip>}
                  <span className="font-mono text-[12px] break-all">{ded.domain}</span>
                </p>
                <p className="text-xs text-muted flex flex-wrap items-center gap-1">Asked by <Person id={ded.requestedBy} size={16} /> {date(ded.requestedAt)}{ded.requestSeq !== undefined && <> · <ReceiptLink seq={ded.requestSeq} /></>}{ded.activatedAt && <> · cut over {date(ded.activatedAt)}{ded.activateSeq !== undefined && <> · <ReceiptLink seq={ded.activateSeq} /></>}</>}</p>
                <ul className="grid gap-1 sm:grid-cols-2 text-sm">
                  {h.components.map((c) => <li key={c.name}><span className="label">{c.name}</span><span className="block text-[13px]">{c.where}</span></li>)}
                </ul>
              </div>
            )}
            {h.suspended && <Banner tone="held" title="The dedicated domain does not count below L2">The organisation is on {LEVEL_INFO[h.level].label}, so it is on hosting profile {h.current.profile}. The dedicated domain counts again from {LEVEL_INFO.l2.label}; an owner can return it to the shared stack meanwhile.</Banner>}
            {h.dedicated?.status === 'returned' &&<p className="text-xs text-muted">Returned to the shared stack {h.dedicated.returnedAt ? date(h.dedicated.returnedAt) : ''} — “{h.dedicated.reason}”.{h.dedicated.returnSeq !== undefined && <> <ReceiptLink seq={h.dedicated.returnSeq} /></>}</p>}
            {h.sovereign && <p className="text-sm text-muted">Sovereign: the whole platform runs on your own infrastructure, so profile 4 already gives the organisation its own domain.</p>}
          </div>
          {!h.eligible && !h.sovereign && (
            <LevelPreview className="m-5 mt-0" need="l2" what="A dedicated residency domain: a stack of your own in the Indian region you choose." shows="Hosting profile 2 — own database, key ring, write-once bucket and network, stated in every evidence bundle." />
          )}
        </div>
      )}
      {dialog === 'request' && <RequestDialog onClose={() => setDialog(undefined)} />}
      {dialog === 'activate' && ded && <ActivateDialog domain={ded.domain} region={ded.region} onClose={() => setDialog(undefined)} />}
      {dialog === 'return' && <ReturnDialog onClose={() => setDialog(undefined)} />}
    </Panel>
  );
}

function RequestDialog({ onClose }: { onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [region, setRegion] = useState(DEDICATED_REGIONS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const d = await api.records.requestDedicated(orgId, region, user.id);
      toast.ok('Dedicated domain provisioned', `${d.domain} is ready. Confirm the cut-over when you are ready.`);
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="Move to a dedicated residency domain" description="Hosting profile 2. elan1 provisions a stack of your own — database, key ring, write-once bucket and network — in the region you choose. Nothing changes until you confirm the cut-over."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={run}>Provision the domain</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not provisioned">{err}</Banner>}
        <Field label="Region">
          <RadioCards name="region" cols={2} value={region} onChange={setRegion} options={DEDICATED_REGIONS.map((r) => ({ value: r, label: r, description: r.includes('Mumbai') ? 'Backups in Hyderabad' : 'Backups in Mumbai' }))} />
        </Field>
        <p className="text-sm text-muted">Records written so far stay where they are and keep verifying; the cut-over receipt names the first record written in the new domain. Recorded as <span className="font-mono">hosting.dedicated_requested</span>.</p>
      </div>
    </Dialog>
  );
}

function ActivateDialog({ domain, region, onClose }: { domain: string; region: string; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await api.records.activateDedicated(orgId, user.id);
      toast.ok('Cut over to the dedicated domain', 'Hosting profile 2 is in force. New evidence bundles state it.');
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Cut over to the dedicated domain" description={`${domain} · ${region}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={run}>Cut over now</Button></>}>
      <div className="space-y-3">
        {err && <Banner tone="bad" title="Not cut over">{err}</Banner>}
        <p className="text-sm">From the next record, every receipt, approval and bundle is held in the dedicated domain. The chain continues unbroken across the cut-over. Recorded as <span className="font-mono">hosting.dedicated_activated</span>.</p>
      </div>
    </Dialog>
  );
}

function ReturnDialog({ onClose }: { onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.records.returnToShared(orgId, reason, user.id);
      toast.ok('Back on the shared stack', `Hosting profile ${r.profile} · ${r.profileName}. Recorded on the chain.`);
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} tone="danger" title="Return to the shared hosted stack" description="The dedicated domain is wound down after its records are moved. Records keep verifying."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 8} onClick={run}>Return to shared</Button></>}>
      <div className="space-y-3">
        {err && <Banner tone="bad" title="Not changed">{err}</Banner>}
        <Field label="Why" required htmlFor="hp-r"><Textarea id="hp-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus /></Field>
      </div>
    </Dialog>
  );
}
