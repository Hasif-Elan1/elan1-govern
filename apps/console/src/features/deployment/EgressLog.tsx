import { useMemo, useState } from 'react';
import { Download, Lock, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { useCanDo, useMemberRole } from '@/features/settings/permissions';
import { userName } from '@/mock/users';
import type { EgressAttempt, InternalHost } from '@/mock/sovereign';
import { dateTime, n, plural } from '@/lib/format';
import { Badge, Banner, Button, DataTable, Dialog, EmptyState, Field, Input, Panel, Segmented, Select, Skeleton, Stat, StatusChip, toast, type Column } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { downloadFile, errText, receiptNote } from '@/features/settings/shared';
import { sovereignApi } from './sovereignApi';

const SHOWN = 400;

/**
 * The egress log of a Sovereign deployment: every connection the firewall refused, with its destination, time
 * and the component that tried, and the internal allow-list (hosts inside the network the deployment may reach).
 * Nothing on the internet can be allow-listed.
 */
export function EgressLog() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useMemberRole();
  const canManage = useCanDo('deployment.manage');
  const [days, setDays] = useState<'1' | '7' | '30'>('7');
  const [component, setComponent] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const { data, loading, error, refetch } = useQuery((o) => sovereignApi.egress(o, Number(days)), [days], { kinds: ['deployment', 'receipt', 'webhook'] });
  const exp = useMutation(sovereignApi.exportEgress);
  const remove = useMutation(sovereignApi.removeHost);

  const components = useMemo(() => Array.from(new Set((data?.log ?? []).map((e) => e.component))).sort(), [data]);
  const rows = useMemo(() => (data?.log ?? []).filter((e) => component === 'all' || e.component === component), [data, component]);
  const byDest = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data?.log ?? []) m.set(e.destination, (m.get(e.destination) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [data]);

  const cols: Column<EgressAttempt>[] = [
    { key: 'at', header: 'Time', sort: (e) => e.at, cell: (e) => <span className="text-sm num whitespace-nowrap">{dateTime(e.at)}</span> },
    { key: 'dest', header: 'Destination', sort: (e) => e.destination, cell: (e) => <span className="font-mono text-[12.5px] break-all">{e.destination}</span> },
    { key: 'comp', header: 'Component', sort: (e) => e.component, cell: (e) => <span className="text-sm">{e.component}<span className="block font-mono text-[11px] text-subtle break-all">{e.source}</span></span> },
    { key: 'why', header: 'Note', hideBelow: 'lg', cell: (e) => <span className="text-xs text-muted">{e.note}{e.by && <> · {userName(e.by)}</>}</span> },
    { key: 'v', header: 'Verdict', cell: (e) => <span className="flex flex-col gap-0.5"><StatusChip tone="ok" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Blocked</StatusChip>{e.seq !== undefined && <ReceiptLink seq={e.seq} />}</span> },
  ];
  const hostCols: Column<InternalHost>[] = [
    { key: 'host', header: 'Internal host', cell: (h) => <span className="font-mono text-[12.5px] break-all">{h.host}</span> },
    { key: 'purpose', header: 'For', hideBelow: 'md', cell: (h) => <span className="text-sm text-muted">{h.purpose}</span> },
    { key: 'added', header: 'Added', hideBelow: 'sm', cell: (h) => <span className="text-xs text-muted">{userName(h.addedBy)} · <When iso={h.addedAt} />{h.seq !== undefined && <> · <ReceiptLink seq={h.seq} /></>}</span> },
    {
      key: 'rm', header: <span className="sr-only">Remove</span>, align: 'right', cell: (h) => (
        <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={!canManage || !user} loading={remove.pending} title={!canManage ? 'Owners and admins change the allow-list.' : undefined}
          onClick={async () => { if (!user) return; try { const r = await remove.mutate(orgId, h.host, user.id); toast.ok(`${h.host} removed`, receiptNote(r.seq)); } catch (e) { toast.bad('Not removed', errText(e)); } }}>Remove</Button>
      ),
    },
  ];

  const doExport = async () => {
    if (!user) return;
    try {
      const r = await exp.mutate(orgId, Number(days), user.id);
      downloadFile(`egress-log-last-${days}-days.csv`, r.csv, 'text/csv');
      toast.ok(`Egress log exported (${plural(r.count, 'attempt')})`, receiptNote(r.seq));
    } catch (e) { toast.bad('Not exported', errText(e)); }
  };

  if (error) return <Banner tone="bad" title="The egress log could not be read" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (loading && !data) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-80" /></div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Stat label="Policy" value="Deny all" sub="No telemetry to Elan1" icon={<ShieldOff className="h-4 w-4" aria-hidden />} />
        <Stat label="Blocked in 24 hours" value={n(data.blocked24h)} sub="Nothing left the network" />
        <Stat label={`Blocked in ${days === '1' ? '24 hours' : `${days} days`}`} value={n(data.log.length)} sub={`${components.length} components tried`} />
        <Stat label="Internal allow-list" value={n(data.hosts.length)} sub="Hosts inside your network" />
      </div>

      <div className="grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8 min-w-0" title="Egress log" kicker="Blocked connection attempts" flush
          actions={<>
            <Segmented size="sm" label="Period" value={days} onChange={setDays} options={[{ value: '1', label: '24 h' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />
            <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={exp.pending} disabled={!user || role === 'approver'} title={role === 'approver' ? 'Owners, admins, viewers and auditors export the log.' : undefined} onClick={doExport}>Export CSV</Button>
          </>}
          footer={<>From the cluster’s egress firewall. Attempts made from the console (a webhook to an outside address, for example) are also receipts. Exporting the log is recorded.</>}>
          <div className="px-5 py-3 border-b border-line flex flex-wrap items-center gap-2">
            <label className="label" htmlFor="eg-comp">Component</label>
            <Select id="eg-comp" size_="sm" className="w-56" value={component} onChange={(e) => setComponent(e.target.value)}>
              <option value="all">All components</option>
              {components.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
            <span className="text-xs text-muted ml-auto">{plural(rows.length, 'attempt')}{rows.length > SHOWN ? ` · newest ${SHOWN} shown; the export has every one` : ''}</span>
          </div>
          <DataTable caption="Blocked egress attempts" className="border-0" columns={cols} rows={rows.slice(0, SHOWN)} rowKey={(e) => e.id} maxHeight={520}
            empty={<EmptyState compact title="No blocked attempts" disc="trail">Nothing tried to leave the network in this period.</EmptyState>} />
        </Panel>

        <div className="xl:col-span-4 space-y-6 min-w-0">
          <Panel title="Most refused destinations">
            {byDest.length === 0 ? <p className="text-sm text-muted">None in this period.</p> : (
              <ul className="space-y-2 text-sm">
                {byDest.map(([d, c]) => <li key={d} className="flex justify-between gap-3"><span className="font-mono text-[12px] break-all">{d}</span><span className="num text-muted">{n(c)}</span></li>)}
              </ul>
            )}
          </Panel>
          <Panel tone="sunken" title="What deny-all means here">
            <ul className="list-[square] pl-5 space-y-1 text-sm text-fg/85">
              <li>Slack and WhatsApp are not available; approvals go by the console and your internal mail relay.</li>
              <li>Webhooks reach only hosts on the internal allow-list.</li>
              <li>Timestamps come from your two local authorities, never a public one.</li>
              <li>Updates arrive on media; usage leaves on media as a signed statement.</li>
            </ul>
          </Panel>
        </div>
      </div>

      <Panel title="Internal allow-list" kicker="Inside your network" flush
        actions={<Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} disabled={!canManage} title={!canManage ? 'Owners and admins change the allow-list.' : undefined} onClick={() => setAddOpen(true)}>Add internal host</Button>}
        footer={<>Only names inside your network can be added (.internal, .local, your own domain, or a private address). The internet stays denied whatever is listed here. Each change is a receipt.</>}>
        <DataTable caption="Internal allow-list" className="border-0" columns={hostCols} rows={data.hosts} rowKey={(h) => h.host}
          empty={<EmptyState compact title="No internal hosts" disc="gate">Nothing outside the cluster can be reached, not even inside your network.</EmptyState>} />
      </Panel>
      {addOpen && <AddHostDialog onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function AddHostDialog({ onClose }: { onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [host, setHost] = useState('');
  const [purpose, setPurpose] = useState('');
  const add = useMutation(sovereignApi.addHost);
  const [err, setErr] = useState<string>();
  const submit = async () => {
    if (!user) return;
    try { const r = await add.mutate(orgId, host, purpose, user.id); toast.ok(`${r.host} added to the internal allow-list`, receiptNote(r.seq)); onClose(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <Dialog open onClose={onClose} title="Add an internal host" description="A host inside your network that Elan1 Govern may connect to, such as your SIEM or mail relay."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={add.pending} disabled={!host.trim() || !purpose.trim()} onClick={submit}>Add host</Button></>}>
      <div className="space-y-4">
        <Field label="Host name or private address" htmlFor="ih-host" required><Input id="ih-host" mono value={host} onChange={(e) => { setHost(e.target.value); setErr(undefined); }} placeholder="soc-archive.bank.internal" data-autofocus /></Field>
        <Field label="What it is for" htmlFor="ih-purpose" required><Input id="ih-purpose" value={purpose} onChange={(e) => { setPurpose(e.target.value); setErr(undefined); }} placeholder="Archive copy of receipt events for the SOC" /></Field>
        {err && <Banner tone="bad">{err}</Banner>}
        <p className="text-xs text-muted inline-flex items-center gap-1.5"><Badge>Deny all</Badge>Public names such as hooks.slack.com are refused, however they are written.</p>
      </div>
    </Dialog>
  );
}
