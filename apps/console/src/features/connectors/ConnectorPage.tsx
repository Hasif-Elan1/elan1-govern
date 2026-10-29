import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RefreshCw, Lock, AlertTriangle, Info, Waypoints, ArrowRight, Sparkles, Settings2, Plug, KeyRound, Globe, Unplug, Trash2, FlaskConical, MapPin } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useUser } from '@/store/session';
import type { ConnectorTool, Receipt, RiskTag } from '@/types';
import { n, plural, dateTime, tagLabel } from '@/lib/format';
import { Banner, Button, DataTable, DecisionChip, Dialog, EmptyState, KeyValue, Menu, PageHeader, Panel, SearchInput, Segmented, Skeleton, Switch, Tooltip, toast, type Column } from '@/components/ui';
import { AgentLink, ReceiptLink, TagList, When } from '@/components/domain';
import { MixBar, emptyMix } from '@/features/agents/parts';
import { ConnectorStatus, DEMO_NOTE, ModeBadge, TagEditor, agentsOnConnector, agentsUsing, custodyOf, kindLabel, usageByTool } from './parts';
import { PACK_CONNECTORS, isPackConnector, packOfConnector, reconnect, setToolTags, switchToDemo, syncConnector, type SyncDiff } from './ops';
import { loadConnectors, useConnectorEnv } from './env';
import { AddressDialog, CredentialDialog, DisconnectDialog, LiveDialog, RemoveDialog, SyncDiffDialog } from './dialogs';

type DialogId = 'live' | 'cred' | 'addr' | 'disc' | 'rm';

export default function ConnectorPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const orgId = useOrgId();
  const user = useUser();
  const canManage = useCan('connectors.manage');
  const consQ = useQuery((o) => loadConnectors(o), []);
  const envQ = useConnectorEnv();
  const agentsQ = useQuery((o) => api.agents(o), [], { kinds: ['agent'] });
  const usageQ = useQuery(async (o) => usageByTool(o), []);
  const c = consQ.data?.find((x) => x.id === id);
  const recentQ = useQuery(async (o) => {
    const cons = await api.connectors(o);
    const names = new Set(cons.find((x) => x.id === id)?.tools.map((t) => t.name) ?? []);
    const rs = await api.receipts(o, { kind: 'decision', from: Date.now() - 30 * 864e5 });
    return rs.items.filter((r) => r.tool && names.has(r.tool)).slice(0, 15);
  }, [id]);

  const [q, setQ] = useState('');
  const [f, setF] = useState<'all' | 'on' | 'off'>('all');
  const [confirm, setConfirm] = useState<ConnectorTool>();
  const [busyTool, setBusyTool] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [diff, setDiff] = useState<SyncDiff>();
  const [dialog, setDialog] = useState<DialogId>();
  const [working, setWorking] = useState(false);

  const upstream = c?.kind === 'mcp_upstream';
  const pack = c ? packOfConnector(c) : undefined;
  const tagsEditable = !!c && upstream && !pack;
  const env = envQ.data;

  const setEnabled = async (t: ConnectorTool, on: boolean) => {
    if (!user || !c) return;
    setBusyTool(t.name);
    try {
      await api.setToolEnabled(orgId, c.id, t.name, on, user.id);
      if (on) toast.ok(`${t.name} switched on`, 'Agents can call it where a rule allows. The change is recorded.');
      else toast.info(`${t.name} switched off`, 'Every call to it is now refused by default.');
    } catch (e) {
      toast.bad('Could not change the tool', (e as Error).message);
    } finally {
      setBusyTool(undefined);
    }
  };

  const onToggle = (t: ConnectorTool, on: boolean) => {
    if (on && c?.status === 'disconnected') { toast.bad('Reconnect first', `${c.name} is disconnected; its tools stay off until it is reconnected.`); return; }
    if (on && !t.tags.length) { setConfirm(t); return; }
    void setEnabled(t, on);
  };

  const saveTags = async (t: ConnectorTool, tags: RiskTag[]) => {
    if (!user || !c) return;
    try {
      await setToolTags(orgId, c.id, t.name, tags, user.id);
      toast.ok('Risk tags saved', tags.length ? `${t.name}: ${tags.map((x) => tagLabel[x]).join(', ')}. Tag rules now match it.` : `${t.name} has no tags; only rules naming it will match.`);
    } catch (e) {
      toast.bad('Could not save the tags', (e as Error).message);
    }
  };

  const sync = async () => {
    if (!user || !c) return;
    setSyncing(true);
    try {
      setDiff(await syncConnector(orgId, c.id, user.id));
    } catch (e) {
      toast.bad('Sync failed', (e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const doReconnect = async () => {
    if (!user || !c) return;
    setWorking(true);
    try {
      await reconnect(orgId, c.id, user.id);
      toast.ok(`${c.name} reconnected`, 'Its tools stay off until someone switches them on.');
    } catch (e) { toast.bad('Could not reconnect', (e as Error).message); } finally { setWorking(false); }
  };
  const doDemo = async () => {
    if (!user || !c) return;
    setWorking(true);
    try {
      await switchToDemo(orgId, c.id, user.id);
      toast.info(`${c.name} back in demo mode`, 'Calls run against seeded demonstration data again.');
    } catch (e) { toast.bad('Could not switch', (e as Error).message); } finally { setWorking(false); }
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return c?.tools.filter((t) => (f === 'all' || (f === 'on' ? t.enabled : !t.enabled)) && (!needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)));
  }, [c, q, f]);

  if (consQ.loading && !c) {
    return <div className="space-y-6"><Skeleton className="h-10 w-80" /><Skeleton className="h-5 w-[30rem] max-w-full" /><Skeleton className="h-[220px]" /><Skeleton className="h-[320px]" /></div>;
  }
  if (consQ.error) return <Banner tone="bad" title="Could not load the connector" actions={<Button size="sm" onClick={consQ.refetch}>Try again</Button>}>{consQ.error.message}</Banner>;
  if (!c) {
    return (
      <div className="min-w-0 overflow-x-clip">
        <PageHeader kicker="Records" crumbs={[{ label: 'Connectors', to: '/connectors' }, { label: id }]} title="Connector not found" />
        <div className="border border-line bg-surface">
          <EmptyState title="No such connector" disc="registration" action={<Button variant="secondary" onClick={() => nav('/connectors')}>Back to connectors</Button>}>It may belong to another organisation or have been removed.</EmptyState>
        </div>
      </div>
    );
  }

  const enabledCount = c.tools.filter((t) => t.enabled).length;
  const users = agentsOnConnector(agentsQ.data, c);
  const totalMix = c.tools.reduce((m, t) => { const u = usageQ.data?.get(t.name); return u ? { allow: m.allow + u.allow, ask: m.ask + u.ask, refuse: m.refuse + u.refuse, total: m.total + u.total } : m; }, emptyMix());
  const custody = env ? custodyOf(env.level, env.deployment, env.residency, env.secrets) : undefined;
  const canLive = c.mode === 'demo' && (c.kind !== 'mcp_upstream' || !!pack);
  const disconnected = c.status === 'disconnected';

  const menuItems = [
    ...(canLive ? [{ label: 'Connect live account', icon: <Plug className="h-4 w-4" />, onSelect: () => setDialog('live') }] : []),
    ...(c.mode === 'live' && (c.kind !== 'mcp_upstream' || pack) ? [{ label: 'Switch back to demo mode', icon: <FlaskConical className="h-4 w-4" />, onSelect: () => { void doDemo(); } }] : []),
    ...(upstream && !pack ? [{ label: 'Replace credential', icon: <KeyRound className="h-4 w-4" />, onSelect: () => setDialog('cred') }, { label: 'Change address', icon: <Globe className="h-4 w-4" />, onSelect: () => setDialog('addr') }] : []),
    'sep' as const,
    disconnected
      ? { label: 'Reconnect', icon: <Plug className="h-4 w-4" />, onSelect: () => { void doReconnect(); } }
      : { label: 'Disconnect', icon: <Unplug className="h-4 w-4" />, danger: true, onSelect: () => setDialog('disc') },
    ...(c.kind === 'mcp_upstream' && !pack ? [{ label: 'Remove', icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: () => setDialog('rm') }] : []),
  ];

  const cols: Column<ConnectorTool>[] = [
    {
      key: 'name', header: 'Tool', sort: (t) => t.name,
      cell: (t) => (
        <div className="py-2 min-w-0 max-w-[42ch]">
          <p className="font-mono text-[12.5px] font-medium break-all">{t.name}</p>
          <p className="text-xs text-muted">{t.description}</p>
        </div>
      ),
    },
    {
      key: 'tags', header: 'Risk tags',
      cell: (t) => (
        <div className="py-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {t.tags.length ? <TagList tags={t.tags} max={5} /> : <span className="inline-flex items-center gap-1 text-xs text-held-fg"><AlertTriangle className="h-3 w-3" />No risk tags</span>}
            {tagsEditable && canManage && <TagEditor tool={t.name} value={t.tags} suggested={t.suggestedTags} onSave={(tags) => { void saveTags(t, tags); }} />}
          </div>
          {tagsEditable && t.suggestedTags && t.suggestedTags.some((s) => !t.tags.includes(s)) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-info-fg inline-flex items-center gap-1"><Sparkles className="h-3 w-3" />Suggested:</span>
              <span className="text-muted">{t.suggestedTags.map((s) => tagLabel[s]).join(', ')}</span>
              {canManage && <button type="button" className="underline text-muted hover:text-fg" onClick={() => { void saveTags(t, Array.from(new Set([...t.tags, ...(t.suggestedTags ?? [])]))); }}>Apply</button>}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'calls', header: 'Calls · 7d', align: 'right', sort: (t) => usageQ.data?.get(t.name)?.total ?? 0, hideBelow: 'md',
      cell: (t) => {
        const u = usageQ.data?.get(t.name) ?? emptyMix();
        return <div className="flex flex-col items-end gap-1"><span className="num">{n(u.total)}</span><MixBar mix={u} className="w-20" /></div>;
      },
    },
    {
      key: 'agents', header: 'Used by', hideBelow: 'lg',
      cell: (t) => {
        const as = agentsUsing(agentsQ.data, t.name);
        return as.length ? <div className="flex flex-col gap-0.5">{as.slice(0, 3).map((a) => <AgentLink key={a.slug} slug={a.slug} className="text-sm" />)}{as.length > 3 && <span className="text-xs text-muted">+{as.length - 3} more</span>}</div> : <span className="text-xs text-subtle">No agent</span>;
      },
    },
    {
      key: 'enabled', header: 'Enabled', align: 'right', sort: (t) => (t.enabled ? 1 : 0),
      // owners and admins switch tools; other roles read whether each one is on
      cell: (t) => canManage ? (
        <Tooltip content={disconnected ? 'Reconnect the connector first' : t.enabled ? 'Switch off: every call to it is refused' : 'Switch on: agents may call it where a rule allows'}>
          <Switch checked={t.enabled} onChange={(v) => onToggle(t, v)} label={`${t.enabled ? 'Switch off' : 'Switch on'} ${t.name}`} disabled={busyTool === t.name || (disconnected && !t.enabled)} />
        </Tooltip>
      ) : <span className={t.enabled ? 'text-sm font-medium' : 'text-sm text-muted'}>{t.enabled ? 'On' : 'Off'}</span>,
    },
  ];

  const recentCols: Column<Receipt>[] = [
    { key: 'seq', header: 'Receipt', cell: (r) => <ReceiptLink seq={r.seq} /> },
    { key: 'agent', header: 'Agent', cell: (r) => <AgentLink slug={r.agent} /> },
    { key: 'tool', header: 'Tool', hideBelow: 'md', cell: (r) => <span className="font-mono text-[12px]">{r.tool}</span> },
    { key: 'dec', header: 'Decision', cell: (r) => <DecisionChip decision={r.decision} size="sm" /> },
    { key: 'when', header: 'When', align: 'right', hideBelow: 'sm', cell: (r) => <When iso={r.ts} className="text-sm text-muted" /> },
  ];

  const description = pack
    ? `${PACK_CONNECTORS[pack].purpose} Installed with the ${pack} regulatory pack.`
    : upstream ? 'An MCP server you run, behind Elan1 Govern. Agents see its tools only where a rule allows them; they never see its credential.'
    : `Built-in connector. ${c.kind === 'gmail' ? 'Read and send email from a shared mailbox.' : 'Bills, payments and vendors in Zoho Books.'}`;

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        crumbs={[{ label: 'Connectors', to: '/connectors' }, { label: c.name }]}
        title={c.name}
        description={description}
        meta={<><ConnectorStatus c={c} />{c.mode === 'live' && <ModeBadge c={c} />}<span className="text-xs text-muted border border-line h-6 px-1.5 inline-flex items-center">{kindLabel(c)}</span>{pack && <Link to={`/records/packs/${pack}`} className="text-xs underline underline-offset-2 text-muted hover:text-fg">Open the {pack} pack</Link>}</>}
        actions={
          <>
            <Button variant="secondary" icon={<Waypoints className="h-4 w-4" />} onClick={() => nav('/agents/map')}>Agent map</Button>
            {canManage && (
              <Menu width={260} items={menuItems} trigger={({ open, toggle }) => (
                <Button variant="secondary" icon={<Settings2 className="h-4 w-4" />} loading={working} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>Manage</Button>
              )} />
            )}
            {canManage && (
              <Tooltip content={disconnected ? 'Reconnect it first' : 'List the server\'s tools again and look for changed names or descriptions'}>
                <Button variant="primary" icon={<RefreshCw className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />} disabled={syncing || disconnected} onClick={sync}>{syncing ? 'Syncing…' : 'Sync now'}</Button>
              </Tooltip>
            )}
          </>
        }
      />

      {c.mode === 'demo' && (
        <Banner tone="info" className="mb-6" title="Demo mode" actions={canManage && canLive ? <Button size="sm" variant="secondary" icon={<Plug className="h-3.5 w-3.5" />} onClick={() => setDialog('live')}>Connect live account</Button> : undefined}>
          {DEMO_NOTE} Live mode uses your own OAuth app or API client{canManage ? '' : '; an owner or admin connects it'}.
        </Banner>
      )}
      {c.status === 'error' && <Banner tone="bad" className="mb-6" title="The server is not answering" actions={canManage && upstream && !pack ? <Button size="sm" variant="secondary" onClick={() => setDialog('cred')}>Replace credential</Button> : undefined}>Last good sync {c.lastSyncAt ? <When iso={c.lastSyncAt} /> : 'unknown'}. Calls to its tools are refused and recorded until it answers. Agents see a general error, never the upstream detail.</Banner>}
      {disconnected && <Banner tone="neutral" className="mb-6" title="Disconnected" actions={canManage ? <Button size="sm" variant="secondary" loading={working} onClick={doReconnect}>Reconnect</Button> : undefined}>Every tool is off, so every call to them is refused by default. Its receipts stay on the chain.</Banner>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0 mb-6">
        <Panel className="lg:col-span-7" title="Details">
          <KeyValue items={[
            { k: 'Kind', v: kindLabel(c) },
            ...(c.url ? [{ k: 'Address', v: c.url, mono: true }] : []),
            ...(c.authHeader ? [{ k: 'Authentication', v: c.authHeader, mono: true }] : []),
            { k: 'Connected', v: dateTime(c.connectedAt) },
            { k: 'Last sync', v: c.lastSyncAt ? <When iso={c.lastSyncAt} /> : '—' },
            { k: 'Tools switched on', v: <span className="num">{enabledCount} of {c.tools.length}</span> },
            {
              k: 'Credential',
              v: !c.heldCredential ? 'Held by the agent' : custody ? (
                <span className="inline-flex flex-col items-end text-right">
                  <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" aria-hidden />{custody.holder} — the agent never sees it</span>
                  <span className="text-xs text-muted">{custody.detail}</span>
                </span>
              ) : envQ.error ? <span className="text-bad-fg">Custody details did not load</span> : <Skeleton className="h-5 w-48" />,
            },
            { k: 'Residency domain', v: env ? <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" aria-hidden />{c.region && c.region !== env.residency ? `${c.region} · ` : ''}{env.residency}</span> : '—' },
          ]} />
        </Panel>
        <div className="lg:col-span-5 space-y-6">
          <Panel title="Last 7 days">
            {usageQ.error ? <Banner tone="bad" title="Usage did not load" actions={<Button size="sm" onClick={usageQ.refetch}>Try again</Button>}>{usageQ.error.message}</Banner> : (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-4xl font-semibold num">{n(totalMix.total)}</span>
                  <span className="text-sm text-muted">calls to its tools</span>
                </div>
                <MixBar mix={totalMix} height={8} className="mt-3" />
                <p className="mt-2 text-xs text-muted num">{n(totalMix.allow)} allowed · {n(totalMix.ask)} asked a person · {n(totalMix.refuse)} refused</p>
              </>
            )}
          </Panel>
          <Panel title="Agents using it" flush>
            {agentsQ.error ? <div className="p-4"><Banner tone="bad" title="Agents did not load" actions={<Button size="sm" onClick={agentsQ.refetch}>Try again</Button>}>{agentsQ.error.message}</Banner></div>
              : users.length === 0 ? <p className="p-5 text-sm text-muted">No agent uses this connector yet. Choose its tools when you add an agent.</p> : (
              <ul className="divide-y divide-line">
                {users.map((a) => (
                  <li key={a.slug} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <AgentLink slug={a.slug} />
                    <span className="text-xs text-muted">{plural(a.tools.filter((t) => c.tools.some((x) => x.name === t)).length, 'tool')}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xl font-semibold">Tools</h2>
          <p className="text-sm text-muted">{tagsEditable ? 'Tag each tool before switching it on. Tag rules (for example “anything that moves money asks finance”) only match tagged tools.' : pack ? 'Pack tools carry the risk tags their declaration fixes. Writes start switched off.' : 'Built-in tools carry fixed risk tags.'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools" aria-label="Search tools" className="w-full sm:w-56" />
          <Segmented label="Filter tools" size="sm" value={f} onChange={setF} options={[{ value: 'all', label: 'All', count: c.tools.length }, { value: 'on', label: 'On', count: enabledCount }, { value: 'off', label: 'Off', count: c.tools.length - enabledCount }]} />
        </div>
      </div>
      <DataTable caption={`Tools on ${c.name}`} columns={cols} rows={rows} rowKey={(t) => t.name} className="mb-8"
        empty={c.tools.length === 0
          ? <EmptyState compact title="The server lists no tools" disc="aperture" action={canManage ? <Button size="sm" onClick={sync}>Sync now</Button> : undefined}>Sync it to list them again.</EmptyState>
          : <EmptyState compact title="No tools match" disc="aperture">Change the search or filter.</EmptyState>} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-8">
          <div className="flex items-end justify-between mb-3">
            <h2 className="text-lg font-semibold">Recent receipts for its tools</h2>
            <Link to="/activity" className="text-sm text-muted hover:text-fg inline-flex items-center gap-1">All activity <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          {recentQ.error ? (
            <Banner tone="bad" title="Recent receipts did not load" actions={<Button size="sm" onClick={recentQ.refetch}>Try again</Button>}>{recentQ.error.message}</Banner>
          ) : (
            <DataTable caption="Recent decisions on this connector's tools" columns={recentCols} rows={recentQ.data} loading={recentQ.loading} rowKey={(r) => r.seq} onRowClick={(r) => nav(`/activity/${r.seq}`)}
              empty={<EmptyState compact title="No calls in 30 days" disc="trail">When an agent calls one of these tools, the decision appears here.</EmptyState>} />
          )}
        </div>
        <Panel className="lg:col-span-4 self-start" title="Disclosed limits" tone="sunken">
          <ul className="space-y-3 text-sm">
            <li className="flex gap-2"><Info className="h-4 w-4 mt-0.5 shrink-0 text-muted" />Upstream authentication is a single header.</li>
            <li className="flex gap-2"><Info className="h-4 w-4 mt-0.5 shrink-0 text-muted" />Upstream tool descriptions are passed to agents as they are. A sync that finds a changed description switches that tool off until someone reviews it.</li>
            <li className="flex gap-2"><Info className="h-4 w-4 mt-0.5 shrink-0 text-muted" />Suggested risk tags come from a fixed word list. A person confirms them.</li>
            <li className="flex gap-2"><Info className="h-4 w-4 mt-0.5 shrink-0 text-muted" />{env?.sovereign ? 'Egress is denied: a public address is refused and recorded as egress.blocked. Your own domain is inside the network; private addresses are allowed only for hosts on your internal allow-list; loopback and link-local are always refused.' : 'Private network addresses are refused on the hosted service.'}</li>
            {c.mode === 'demo' && <li className="flex gap-2"><Info className="h-4 w-4 mt-0.5 shrink-0 text-muted" />{DEMO_NOTE}</li>}
          </ul>
        </Panel>
      </div>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(undefined)}
        title="Switch on a tool with no risk tags?"
        description="Tag rules will not match it. Only a rule that names this tool can allow or hold it; anything no rule allows is still refused."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(undefined)}>Cancel</Button>
            {confirm?.suggestedTags?.length ? <Button variant="secondary" onClick={async () => { const t = confirm!; setConfirm(undefined); await saveTags(t, t.suggestedTags!); void setEnabled(t, true); }}>Apply suggested tags and switch on</Button> : null}
            <Button variant="primary" onClick={() => { const t = confirm!; setConfirm(undefined); void setEnabled(t, true); }}>Switch on without tags</Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3 text-sm">
            <p className="font-mono text-[12.5px]">{confirm.name}</p>
            <p className="text-muted">{confirm.description}</p>
            {confirm.suggestedTags?.length ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-info-fg">Suggested</span><TagList tags={confirm.suggestedTags} /></div> : null}
          </div>
        )}
      </Dialog>

      <SyncDiffDialog diff={diff} onClose={() => setDiff(undefined)} />
      <LiveDialog open={dialog === 'live'} onClose={() => setDialog(undefined)} c={c} />
      <CredentialDialog open={dialog === 'cred'} onClose={() => setDialog(undefined)} c={c} />
      <AddressDialog open={dialog === 'addr'} onClose={() => setDialog(undefined)} c={c} env={env} />
      <DisconnectDialog open={dialog === 'disc'} onClose={() => setDialog(undefined)} c={c} />
      {!isPackConnector(c) && <RemoveDialog open={dialog === 'rm'} onClose={() => setDialog(undefined)} c={c} />}
    </div>
  );
}
