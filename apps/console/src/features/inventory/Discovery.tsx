import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Globe, KeyRound, PackageSearch, Puzzle, Radar, Server, XCircle } from 'lucide-react';
import type { DiscoveryFinding } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { n, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Dialog, EmptyState, Field, Panel, Segmented, Skeleton, StatusChip, Textarea, Tooltip, toast } from '@/components/ui';
import { When } from '@/components/domain';
import type { RegisterPrefill } from './RegisterSystemDrawer';

const KIND: Record<DiscoveryFinding['kind'], { label: string; icon: typeof Bot }> = {
  api_key: { label: 'AI API key in use', icon: KeyRound },
  bot: { label: 'Bot or copilot', icon: Bot },
  mcp_server: { label: 'MCP server', icon: Server },
  browser_extension: { label: 'Browser extension', icon: Puzzle },
  saas_feature: { label: 'AI feature in a SaaS app', icon: Globe },
};

/** What the drawer should start with when a finding is registered. */
export function prefillFromFinding(f: DiscoveryFinding, ownerId?: string): RegisterPrefill {
  const kind = f.kind === 'bot' || f.kind === 'api_key' ? 'internal_app' : f.kind === 'mcp_server' ? 'agent' : 'vendor_tool';
  return {
    name: f.name, kind, vendor: f.vendor, ownerId, lifecycle: 'in_review',
    purpose: `Found by AI discovery (${f.source}): ${f.evidence}`,
    decisionImpact: 'informs',
    frameworks: ['iso42001'],
    personalData: /personal|salary|leave|contact|hr|cv|patient|borrower|customer/i.test(f.evidence),
  };
}

/**
 * AI discovery: scans connected sources (connector and MCP tool listings, the identity provider's app
 * catalogue, egress logs) for AI the business uses but has not registered. Each finding can be registered
 * (a prefilled drawer) or dismissed with a reason; both are receipts.
 */
export function DiscoveryPanel({ canManage, onRegister }: { canManage: boolean; onRegister: (f: DiscoveryFinding) => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const q = useQuery((o) => api.discover(o), []);
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<'unregistered' | 'all'>('unregistered');
  const [dismissing, setDismissing] = useState<DiscoveryFinding>();

  const scan = async () => {
    if (!user) return;
    setScanning(true);
    try {
      const r = await api.runDiscovery(orgId, user.id);
      const un = r.findings.filter((f) => f.status === 'unregistered').length;
      toast.ok('Discovery scan finished', `${plural(r.sources.filter((s) => s.scanned).length, 'source')} scanned · ${plural(un, 'unregistered finding')}. The scan is a receipt.`);
    } catch (e) {
      toast.bad('The scan did not finish', (e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const findings = useMemo(() => (q.data?.findings ?? []).filter((f) => view === 'all' || f.status === 'unregistered'), [q.data, view]);
  const counts = useMemo(() => ({
    unregistered: q.data?.findings.filter((f) => f.status === 'unregistered').length ?? 0,
    all: q.data?.findings.length ?? 0,
  }), [q.data]);

  return (
    <Panel
      title={<span className="inline-flex items-center gap-2"><Radar className="h-4 w-4 text-muted" aria-hidden />AI discovery</span>}
      kicker={q.data ? `Last scan ${new Date(q.data.scannedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST · ${plural(q.data.sources.length, 'source')}` : 'AI the business uses without registering it'}
      flush
      actions={canManage ? (
        <Tooltip content="Scan connector and MCP tool listings, the identity provider app catalogue and egress logs now">
          <Button size="sm" variant="primary" icon={<PackageSearch className="h-3.5 w-3.5" />} loading={scanning} onClick={scan}>Run a discovery scan</Button>
        </Tooltip>
      ) : undefined}
    >
      {q.error && <div className="p-4"><Banner tone="bad" title="Discovery results did not load" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner></div>}
      {q.data && (
        <div className="px-5 py-3 border-b border-line flex flex-wrap items-center justify-between gap-3">
          <ul className="flex flex-wrap gap-1.5" aria-label="Sources scanned">
            {q.data.sources.map((s) => (
              <li key={s.name}><Badge tone={s.scanned ? 'neutral' : 'held'} title={s.scanned ? 'Scanned' : 'Not scanned — the source is disconnected'}>{s.name}{s.scanned ? '' : ' · not scanned'}</Badge></li>
            ))}
          </ul>
          <Segmented size="sm" label="Show findings" value={view} onChange={setView} options={[{ value: 'unregistered', label: 'Unregistered', count: counts.unregistered }, { value: 'all', label: 'All', count: counts.all }]} />
        </div>
      )}
      {q.loading && !q.data ? <div className="p-5 space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div> : findings.length === 0 ? (
        <EmptyState compact disc="aperture" title={view === 'unregistered' ? 'Nothing unregistered found' : 'No findings yet'} action={canManage ? <Button size="sm" onClick={scan}>Scan again</Button> : undefined}>
          {view === 'unregistered' ? 'Every AI use the last scan found is registered or dismissed.' : canManage ? 'Run a scan to look for AI the business uses without registering it.' : 'An owner or admin runs a scan to look for AI the business uses without registering it.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {findings.map((f) => {
            const K = KIND[f.kind];
            return (
              <li key={f.id} className={cn('px-5 py-4 grid gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto] items-start', f.status !== 'unregistered' && 'opacity-80')}>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <K.icon className="h-4 w-4 text-muted shrink-0" aria-hidden />
                    <span className="font-medium">{f.name}</span>
                    <StatusChip size="sm" tone={f.risk === 'high' ? 'bad' : f.risk === 'medium' ? 'held' : 'neutral'}>{f.risk === 'high' ? 'High risk' : f.risk === 'medium' ? 'Medium risk' : 'Low risk'}</StatusChip>
                    {f.status === 'registered' && f.aiSystemId && <Link to={`/inventory/${f.aiSystemId}`}><Badge tone="ok">Registered</Badge></Link>}
                    {f.status === 'dismissed' && <Badge>Dismissed</Badge>}
                  </p>
                  <p className="text-sm mt-1">{f.evidence}</p>
                  <p className="text-xs text-muted mt-1">{K.label} · {f.vendor} · seen in {f.source} · first <When iso={f.firstSeen} />, last <When iso={f.lastSeen} />{f.callsSeen ? <> · <span className="num">{n(f.callsSeen)}</span> calls seen</> : null}</p>
                </div>
                {f.status === 'unregistered' && canManage && (
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <Tooltip content="Register it in the inventory with these details prefilled">
                      <Button size="sm" variant="secondary" onClick={() => onRegister(f)}>Register</Button>
                    </Tooltip>
                    <Tooltip content="Dismiss with a reason (recorded)">
                      <Button size="sm" variant="ghost" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setDismissing(f)}>Dismiss</Button>
                    </Tooltip>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-5 py-3 border-t border-line text-xs text-muted">Discovery reads metadata only — tool listings, app registrations and connection logs — never message or document content. It finds candidates; a person decides.</p>
      {canManage && <DismissDialog f={dismissing} onClose={() => setDismissing(undefined)} />}
    </Panel>
  );
}

function DismissDialog({ f, onClose }: { f?: DiscoveryFinding; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (f) { setReason(''); setErr(undefined); } }, [f]);
  const go = async () => {
    if (!user || !f) return;
    setBusy(true); setErr(undefined);
    try {
      await api.dismissFinding(orgId, f.id, user.id, reason.trim());
      toast.info('Finding dismissed', 'The reason is on the receipt. A later scan shows it under All.');
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!f} onClose={onClose} title="Dismiss this finding?" description={f?.name}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 6} onClick={go}>Dismiss with this reason</Button></>}>
      <div className="space-y-3">
        {err && <Banner tone="bad" title="Could not dismiss">{err}</Banner>}
        <Field label="Reason" required htmlFor="dismiss-r" hint="For example: approved personal use only, or already covered by another registered system.">
          <Textarea id="dismiss-r" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
      </div>
    </Dialog>
  );
}
