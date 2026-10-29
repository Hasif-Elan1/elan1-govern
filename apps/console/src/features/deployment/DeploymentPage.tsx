import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2, CircleDashed, Cloud, Database, Download, FileUp, HardDrive, KeyRound, Lock, PackageCheck, RotateCcw, Server, ShieldCheck, ShieldOff, Timer, XCircle } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { DeploymentView, UpdateBundle } from '@/types';
import { LEVEL_INFO } from '@/lib/levels';
import { date, dateTime, n, pct, relative } from '@/lib/format';
import { userName } from '@/mock/users';
import { Badge, Banner, Button, CodeBlock, DataTable, Dialog, EmptyState, Meter, PageHeader, Panel, Skeleton, Stat, StatusChip, Tabs, Textarea, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { downloadFile, errText, receiptNote } from '@/features/settings/shared';
import { PlanUpsell, SmartLink } from '@/shell/access';
import { useCanDo } from '@/features/settings/permissions';
import { TabPanel, useTabParam } from '@/features/agentsdoor/shared';
import { blockedInLast, rollbackTarget } from '@/mock/sovereign';
import { deploymentApi, manifestOf, parseManifest } from './deploymentApi';
import { sovereignApi } from './sovereignApi';
import { EgressLog } from './EgressLog';
import { LocalStatus } from './LocalStatus';
import { UsageStatements } from './UsageStatements';
import { HostingProfilePanel } from '@/features/hosting/HostingProfilePanel';

type SovTab = 'overview' | 'status' | 'egress' | 'meter';
const SOV_TABS = ['overview', 'status', 'egress', 'meter'] as const;

type Node = DeploymentView['cluster']['nodes'][number];
type Component = DeploymentView['components'][number];

/** Deployment — where Elan1 Govern runs for this organisation: the cluster, keys, timestamp authorities, egress, backups and updates. */
export default function DeploymentPage() {
  useEffect(() => { document.title = 'Deployment · Elan1 Govern'; }, []);
  const level = useOrgLevel();
  const { data: d, loading, error, refetch } = useQuery((o) => api.deployment(o), [], { kinds: ['deployment', 'key', 'receipt'] });
  const { data: residency } = useQuery((o) => api.residency(o), [], { kinds: ['deployment', 'key'] });
  const sov = d?.mode === 'sovereign';
  const orgId = useOrgId();
  const [tab, setTab] = useTabParam<SovTab>(SOV_TABS);
  const blocked24h = sov ? blockedInLast(orgId, 24) : d?.egress.blockedLast24h ?? 0;

  const nodeCols: Column<Node>[] = [
    { key: 'name', header: 'Node', sort: (x) => x.name, cell: (x) => <span className="font-mono text-[12.5px] break-all">{x.name}</span> },
    { key: 'role', header: 'Role', sort: (x) => x.role, cell: (x) => <span className="text-sm">{x.role === 'control-plane' ? 'Control plane' : x.role === 'storage' ? 'Storage' : 'Worker'}</span> },
    { key: 'zone', header: 'Zone', hideBelow: 'sm', sort: (x) => x.zone, cell: (x) => <span className="text-sm">{x.zone}</span> },
    { key: 'size', header: 'Size', hideBelow: 'md', cell: (x) => <span className="text-sm num">{x.cpu} vCPU · {x.memoryGb} GB</span> },
    { key: 'status', header: 'Status', cell: (x) => x.status === 'ready' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Ready</StatusChip> : <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>Not ready</StatusChip> },
  ];
  const compCols: Column<Component>[] = [
    { key: 'name', header: 'Component', cell: (x) => <span className="text-sm font-medium">{x.name}</span> },
    { key: 'version', header: 'Version', cell: (x) => <span className="font-mono text-[12.5px]">{x.version}</span> },
    { key: 'replicas', header: 'Replicas', align: 'right', cell: (x) => <span className="num">{x.replicas}</span> },
    { key: 'status', header: 'Status', cell: (x) => x.status === 'running' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Running</StatusChip> : <StatusChip tone="held" size="sm">Degraded</StatusChip> },
  ];

  return (
    <div className="overflow-x-clip space-y-6">
      <PageHeader
        kicker="Agents"
        title="Deployment"
        description={sov ? 'Elan1 Govern runs on your own infrastructure: your cluster, your database, your HSM and your timestamp authorities. Updates arrive as signed bundles that you verify, stage and apply.' : 'Where Elan1 Govern runs for this organisation: the cluster elan1 operates, where your data and keys live, what leaves the network and how updates reach it.'}
        meta={d && <>
          <Badge tone="inverse">{sov ? 'Sovereign — your infrastructure' : 'Hosted by elan1'}</Badge>
          <Badge>{LEVEL_INFO[level].label}</Badge>
          <span className="text-sm text-muted">{d.location}</span>
        </>}
      />

      {error && <Banner tone="bad" title="The deployment could not be read" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {loading && !d ? <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-80" /></div> : d && (
        <>
          {sov && (
            <Tabs<SovTab> label="Deployment" value={tab} onChange={setTab} items={[
              { value: 'overview', label: 'Overview' },
              { value: 'status', label: 'Local status' },
              { value: 'egress', label: 'Egress', count: blocked24h },
              { value: 'meter', label: 'Usage statements' },
            ]} />
          )}
          {sov && tab === 'status' && <TabPanel label="Local status"><LocalStatus /></TabPanel>}
          {sov && tab === 'egress' && <TabPanel label="Egress"><EgressLog /></TabPanel>}
          {sov && tab === 'meter' && <TabPanel label="Usage statements"><UsageStatements /></TabPanel>}
          {(!sov || tab === 'overview') && <div className="space-y-6">
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <Stat label="Nodes ready" value={`${d.cluster.nodes.filter((x) => x.status === 'ready').length} / ${d.cluster.nodes.length}`} sub={`${d.cluster.distribution} ${d.cluster.version}`} icon={<Server className="h-4 w-4" aria-hidden />} />
            <Stat label="CPU in use" value={pct(d.cluster.cpuUsedPct)} chart={<Meter value={d.cluster.cpuUsedPct} label="CPU in use" />} />
            <Stat label="Memory in use" value={pct(d.cluster.memoryUsedPct)} chart={<Meter value={d.cluster.memoryUsedPct} label="Memory in use" />} />
            <Stat label="Version" value={<span className="font-mono text-xl">{d.updates.filter((u) => u.status === 'applied').sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))[0]?.version ?? '—'}</span>} sub={sov ? 'Applied by you' : 'Applied by elan1'} icon={<PackageCheck className="h-4 w-4" aria-hidden />} />
          </div>

          <div className="grid gap-6 xl:grid-cols-12">
            <div className="xl:col-span-8 space-y-6 min-w-0">
              <HostingProfilePanel />
              <Panel title={<span className="inline-flex items-center gap-2"><Server className="h-4 w-4" aria-hidden />{d.cluster.name}</span>} kicker={`Operated by ${d.operator}`} flush>
                <DataTable caption="Cluster nodes" columns={nodeCols} rows={d.cluster.nodes} rowKey={(x) => x.name} className="border-0" />
              </Panel>
              <Panel title="Components" flush>
                <DataTable caption="Running components" columns={compCols} rows={d.components} rowKey={(x) => x.name} className="border-0" />
              </Panel>
              <UpdatesPanel d={d} />
            </div>

            <div className="xl:col-span-4 space-y-6 min-w-0">
              <Panel title={<span className="inline-flex items-center gap-2"><Database className="h-4 w-4" aria-hidden />Data</span>}>
                <Facts items={[
                  ['Database', d.database.engine],
                  ['Row-level security', d.database.rowLevelSecurity ? 'On — every query is scoped to the organisation' : 'Off'],
                  ['Size', `${n(d.database.sizeGb)} GB · ${d.database.replicas} replicas`],
                  ['Secrets', `${d.secrets.backend}${d.secrets.version !== 'managed' ? ` ${d.secrets.version}` : ''} · ${d.secrets.sealed ? 'sealed' : 'unsealed'}`],
                ]} />
              </Panel>
              <Panel title={<span className="inline-flex items-center gap-2"><HardDrive className="h-4 w-4" aria-hidden />Evidence store</span>}>
                <Facts items={[
                  ['Backend', d.storage.backend],
                  ['Write-once lock', d.storage.objectLock === 'compliance' ? `Compliance mode, ${d.storage.retentionYears} years` : `Governance mode, ${d.storage.retentionYears} year`],
                  ['Used', d.storage.capacityTb ? `${d.storage.usedTb} of ${d.storage.capacityTb} TB` : `${d.storage.usedTb} TB`],
                ]} />
                {d.storage.capacityTb > 0 && <Meter className="mt-3" value={d.storage.usedTb / d.storage.capacityTb} label="Store used" />}
              </Panel>
              <Panel title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden />Signing key</span>} actions={<Link to="/agents/keys?tab=custody" className="text-sm link inline-flex items-center gap-1">Custody<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
                <Facts items={[['Held in', d.hsm.provider], ['Model', d.hsm.model], ['Validation', d.hsm.fips], ['Location', d.hsm.location], ['Held by', d.hsm.heldBy === 'customer' ? 'You' : 'elan1']]} />
              </Panel>
              {/* timestamp authorities are part of L2: below it the panel is left out and owners see one line */}
              {d.tsa.length === 0 ? <PlanUpsell to="l2" what="Two RFC 3161 timestamp authorities (eMudhra in India and one global) start at L2 Attested." /> : (
              <Panel title={<span className="inline-flex items-center gap-2"><Timer className="h-4 w-4" aria-hidden />Timestamp authorities</span>} actions={<SmartLink to="/assurance/anchors" hideWhenBlocked className="text-sm link inline-flex items-center gap-1">Timestamps<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>}>
                  <ul className="space-y-3 text-sm">
                    {d.tsa.map((t) => (
                      <li key={t.id}>
                        <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{t.name}</span><Badge>{t.scope}</Badge>{t.status === 'operational' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Operational</StatusChip> : <StatusChip tone="held" size="sm">Degraded</StatusChip>}</p>
                        <p className="font-mono text-[11.5px] text-muted break-all">{t.url} · {t.fingerprint}</p>
                      </li>
                    ))}
                  </ul>
              </Panel>
              )}
              <Panel title={<span className="inline-flex items-center gap-2">{d.egress.policy === 'deny_all' ? <ShieldOff className="h-4 w-4" aria-hidden /> : <Cloud className="h-4 w-4" aria-hidden />}Egress</span>}
                actions={d.egress.policy === 'deny_all' ? <StatusChip tone="ok" size="sm" icon={<Lock className="h-3 w-3" />}>Deny all</StatusChip> : <Badge>Managed by elan1</Badge>}>
                <Facts items={[
                  ['Telemetry to elan1', d.egress.telemetry === 'none' ? 'None' : d.egress.telemetry],
                  [sov ? 'Internet allow-list' : 'Allow-list', d.egress.allowList.length ? `${d.egress.allowList.length} hosts` : 'Empty'],
                  ['Blocked in 24 hours', n(blocked24h)],
                ]} />
                {d.egress.allowList.length > 0 && <ul className="mt-3 space-y-1 font-mono text-[12px]">{d.egress.allowList.map((h) => <li key={h} className="break-all">{h}</li>)}</ul>}
                {sov && <button type="button" className="mt-3 text-sm link inline-flex items-center gap-1" onClick={() => setTab('egress')}>Egress log and internal allow-list<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></button>}
              </Panel>
              <Panel title="Backups and recovery">
                <Facts items={[
                  ['Last backup', `${relative(d.backup.lastBackupAt)} · ${dateTime(d.backup.lastBackupAt)}`],
                  ['Recovery point', `${d.backup.rpoMinutes} minutes`],
                  ['Recovery time', `${d.backup.rtoMinutes} minutes`],
                  ['Recovery site', d.backup.site],
                ]} />
                <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <span className="label">Last DR drill</span>
                  {d.backup.drillResult === 'passed' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Passed</StatusChip> : <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>Failed</StatusChip>}
                  <span className="text-muted">{date(d.backup.lastDrillAt)} ({relative(d.backup.lastDrillAt)})</span>
                </p>
              </Panel>
              {residency && (
                <Panel title="Residency" actions={<Link to="/agents/organisation?tab=residency" className="text-sm link inline-flex items-center gap-1">Statement<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
                  <p className="text-sm font-medium">{residency.domain}</p>
                  <p className="mt-1 text-xs text-muted">{residency.stores.length} stores in the domain · {n(residency.crossBorder.transfers30d)} cross-border transfers in 30 days.</p>
                </Panel>
              )}
              {/* Sovereign is a higher plan: owners see one line, other roles nothing */}
              {!sov && <PlanUpsell to="sovereign" what="Run it yourselves: the platform, your HSM and two timestamp authorities in your data centre." />}
            </div>
          </div>
          </div>}
        </>
      )}
    </div>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="space-y-2 text-sm">
      {items.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted shrink-0">{k}</dt><dd className="text-right min-w-0 break-words">{v}</dd></div>)}
    </dl>
  );
}


/* ── Updates ────────────────────────────────────────────────────────────── */

function UpdatesPanel({ d }: { d: DeploymentView }) {
  const orgId = useOrgId();
  const user = useUser();
  const canManage = useCanDo('deployment.manage');
  const sov = d.mode === 'sovereign';
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [rollback, setRollback] = useState<{ u: UpdateBundle; to: UpdateBundle }>();
  const updates = d.updates.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const running = d.updates.filter((u) => u.status === 'applied').sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))[0];
  const rbTarget = sov && running ? rollbackTarget(orgId, running.id) : undefined;

  const stage = async (u: UpdateBundle) => {
    if (!user) return;
    setBusy(u.id);
    try {
      const r = await api.stageUpdate(orgId, u.id, user.id);
      if (r.status === 'staged') toast.ok(`${r.version} verified and staged`, `The digest and the Ed25519 signature match the elan1 release key ${d.release.fingerprint}. ${r.seq ? receiptNote(r.seq) : ''}`);
      else toast.bad(`${r.version} rejected`, `The signature does not verify against the elan1 release key. The bundle cannot be applied. ${r.seq ? receiptNote(r.seq) : ''}`);
    } catch (e) { toast.bad('Not staged', errText(e)); } finally { setBusy(undefined); }
  };
  const apply = async (u: UpdateBundle) => {
    if (!user) return;
    setBusy(u.id);
    try { const r = await api.applyUpdate(orgId, u.id, user.id); toast.ok(`${r.version} applied`, r.seq ? receiptNote(r.seq) : undefined); } catch (e) { toast.bad('Not applied', errText(e)); } finally { setBusy(undefined); }
  };

  const steps = (u: UpdateBundle) => {
    const done = { imported: true, verified: u.status === 'staged' || u.status === 'applied', staged: u.status === 'staged' || u.status === 'applied', applied: u.status === 'applied' };
    return (
      <ol className="flex flex-wrap items-center gap-1.5 text-[11.5px]" aria-label="Progress">
        {(['imported', 'verified', 'staged', 'applied'] as const).map((s) => (
          <li key={s} className={`inline-flex items-center gap-1 border px-1.5 h-6 ${u.status === 'rejected' && s === 'verified' ? 'border-bad/50 text-bad-fg' : done[s] ? 'border-line-strong text-fg' : 'border-line text-subtle'}`}>
            {u.status === 'rejected' && s === 'verified' ? <XCircle className="h-3 w-3" aria-hidden /> : done[s] ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <CircleDashed className="h-3 w-3" aria-hidden />}
            {s === 'verified' && u.status === 'rejected' ? 'signature failed' : s}
          </li>
        ))}
      </ol>
    );
  };

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><PackageCheck className="h-4 w-4" aria-hidden />{sov ? 'Air-gapped update bundles' : 'Updates'}</span>}
      actions={sov && canManage && <Button size="sm" variant="secondary" icon={<FileUp className="h-3.5 w-3.5" />} onClick={() => setImportOpen(true)}>Import a bundle</Button>}
      flush footer={<>Release key <span className="font-mono">{d.release.kid}</span> · fingerprint <span className="font-mono">{d.release.fingerprint}</span>. {sov ? 'A bundle is applied only after its signature verifies against this key; each step is a receipt.' : 'elan1 verifies each release against this key before rolling it out.'}</>}>
      {updates.length === 0 ? <EmptyState compact title="No updates yet" disc="trail">{sov ? 'Import a bundle from the media elan1 sends.' : 'Releases appear here as elan1 rolls them out.'}</EmptyState> : (
        <ul className="divide-y divide-line">
          {updates.map((u) => (
            <li key={u.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm font-semibold">{u.version}</span>
                {u.status === 'applied' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Applied</StatusChip>
                  : u.status === 'staged' ? <StatusChip tone="info" size="sm" icon={<ShieldCheck className="h-3 w-3" />}>Verified and staged</StatusChip>
                    : u.status === 'rejected' ? <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>Rejected</StatusChip>
                      : <StatusChip tone="held" size="sm" icon={<CircleDashed className="h-3 w-3" />}>Not verified yet</StatusChip>}
                <span className="text-xs text-muted">{u.transport} · {u.sizeMb ? `${n(u.sizeMb)} MB · ` : ''}published {date(u.publishedAt)}</span>
                <span className="ml-auto flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadFile(`elan1-govern-${u.version}.manifest.json`, JSON.stringify(manifestOf(u), null, 2))}>Manifest</Button>
                  {sov && u.status === 'available' && <Button size="sm" variant="primary" loading={busy === u.id} disabled={!canManage} title={!canManage ? 'Owners and admins verify and stage bundles.' : undefined} onClick={() => stage(u)}>Verify signature and stage</Button>}
                  {sov && u.status === 'staged' && <Button size="sm" variant="primary" loading={busy === u.id} disabled={!canManage} title={!canManage ? 'Owners and admins apply bundles.' : undefined} onClick={() => apply(u)}>{u.rolledBackAt ? 'Apply again' : 'Apply'}</Button>}
                  {sov && running?.id === u.id && rbTarget && <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={!canManage} title={!canManage ? 'Owners and admins roll back bundles.' : undefined} onClick={() => setRollback({ u, to: rbTarget })}>Roll back to {rbTarget.version}</Button>}
                </span>
              </div>
              {sov && running?.id === u.id && <p className="mt-1 text-xs font-medium">Running now</p>}
              {u.rolledBackAt && (
                <p className="mt-1 text-xs text-held-fg">Rolled back {dateTime(u.rolledBackAt)}{u.rolledBackBy && ` by ${userName(u.rolledBackBy)}`}{u.rollbackReason && ` — “${u.rollbackReason}”`}. {u.status === 'staged' ? 'Still verified; it can be applied again.' : 'Applied again since.'} {u.rollbackSeq !== undefined && <ReceiptLink seq={u.rollbackSeq} />}</p>
              )}
              <div className="mt-2">{steps(u)}</div>
              <ul className="mt-2 list-[square] pl-5 text-xs text-muted space-y-0.5">{u.notes.map((x) => <li key={x}>{x}</li>)}</ul>
              <p className="mt-2 font-mono text-[11px] text-subtle break-all">sha256 {u.digest} · signed by {u.kid}</p>
              {(u.stagedAt || u.appliedAt) && (
                <p className="mt-1 text-xs text-muted">
                  {u.stagedAt && <>Checked {dateTime(u.stagedAt)}{u.stagedBy && ` by ${userName(u.stagedBy)}`}. </>}
                  {u.restoredFrom
                    ? <>{u.firstAppliedAt && <>First applied {dateTime(u.firstAppliedAt)}{u.firstAppliedBy && ` by ${userName(u.firstAppliedBy)}`}{u.firstAppliedSeq !== undefined && <> <ReceiptLink seq={u.firstAppliedSeq} /></>}. </>}</>
                    : <>{u.appliedAt && <>Applied {dateTime(u.appliedAt)}{u.appliedBy && ` by ${userName(u.appliedBy)}`}. </>}{u.seq && <ReceiptLink seq={u.seq} />}</>}
                </p>
              )}
              {u.restoredFrom && u.appliedAt && (
                <p className="mt-1 text-xs text-muted">Returned to service {dateTime(u.appliedAt)}{u.appliedBy && ` by ${userName(u.appliedBy)}`}, by rolling back {u.restoredFrom}. {u.seq !== undefined && <ReceiptLink seq={u.seq} />}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
      {rollback && <RollbackDialog u={rollback.u} to={rollback.to} onClose={() => setRollback(undefined)} />}
    </Panel>
  );
}

/** Roll the running bundle back to the one applied before it. Recorded as update.rolled_back. */
function RollbackDialog({ u, to, onClose }: { u: UpdateBundle; to: UpdateBundle; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string>();
  const m = useMutation(sovereignApi.rollback);
  const submit = async () => {
    if (!user) return;
    try { const r = await m.mutate(orgId, u.id, reason, user.id); toast.ok(`Rolled back to ${r.to}`, `${r.from} stays verified and staged; apply it again once the problem is fixed. ${receiptNote(r.seq)}`); onClose(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <Dialog open onClose={onClose} tone="danger" title={`Roll back ${u.version}`} description={`The cluster returns to ${to.version}, which was applied ${to.appliedAt ? dateTime(to.appliedAt) : 'before it'}. Receipts written meanwhile stay on the chain; nothing is rewritten.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<RotateCcw className="h-4 w-4" />} loading={m.pending} disabled={reason.trim().length < 10} onClick={submit}>Roll back to {to.version}</Button></>}>
      <div className="space-y-4">
        <ul className="list-[square] pl-5 space-y-1 text-sm text-fg/85">
          <li>The decision service, console and workers restart on {to.version}, one replica at a time.</li>
          <li>{u.version} is kept, verified, and can be applied again.</li>
          <li>The rollback is a receipt naming you, both versions and your reason.</li>
        </ul>
        <div>
          <label className="label" htmlFor="rb-reason">Reason</label>
          <Textarea id="rb-reason" rows={3} value={reason} onChange={(e) => { setReason(e.target.value); setErr(undefined); }} placeholder="The reviews queue times out on our PostgreSQL 16.3 replicas" />
          <p className="mt-1 text-xs text-muted">At least 10 characters.</p>
        </div>
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [text, setText] = useState('');
  const [err, setErr] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  const imp = useMutation(deploymentApi.importBundle);
  let parsed: ReturnType<typeof parseManifest> | undefined;
  let parseErr: string | undefined;
  if (text.trim()) { try { parsed = parseManifest(text); } catch (e) { parseErr = errText(e); } }
  const submit = async () => {
    if (!user || !parsed) return;
    try { const r = await imp.mutate(orgId, parsed, user.id); toast.ok(`${r.bundle.version} imported`, `Not trusted yet: verify its signature before staging. ${receiptNote(r.seq)}`); onClose(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="Import an update bundle" description="Read the manifest from the removable media elan1 sent. Importing trusts nothing: the signature is checked when you stage it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={imp.pending} disabled={!parsed} onClick={submit}>Import</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".json,application/json" className="sr-only" aria-label="Manifest file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = ''; }} />
          <Button size="sm" variant="secondary" icon={<FileUp className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Choose manifest file</Button>
          <span className="text-xs text-muted">or paste it below</span>
        </div>
        <Textarea aria-label="Manifest JSON" rows={8} className="font-mono text-[12px]" value={text} onChange={(e) => { setText(e.target.value); setErr(undefined); }} placeholder='{ "format": "elan1.update.manifest.v1", "version": "2026.10.4", "digest": "…", "sig": "…", "kid": "rel_2026_10" }' invalid={!!parseErr} />
        {parseErr && <p className="text-xs text-bad-fg" role="alert">{parseErr}</p>}
        {parsed && <CodeBlock title="Read from the manifest" code={`version  ${parsed.version}\ndigest   ${parsed.digest}\nkid      ${parsed.kid}\nsize     ${parsed.sizeMb ?? '—'} MB`} />}
        {err && <Banner tone="bad">{err}</Banner>}
        <p className="text-xs text-muted">Any bundle’s manifest can be downloaded from its row (Manifest), for example to move it between sites.</p>
      </div>
    </Dialog>
  );
}
