import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, Plus, Server, Mail, BookOpen, Globe, MapPin, Scale, ShieldAlert } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgLevel } from '@/store/session';
import type { Agent, Connector } from '@/types';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { n, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Banner, Button, EmptyState, PageHeader, Skeleton, Tooltip } from '@/components/ui';
import { When } from '@/components/domain';
import { MixBar, emptyMix, type Mix } from '@/features/agents/parts';
import { ConnectorStatus, DEMO_NOTE, ModeBadge, agentsOnConnector, custodyOf, usageByTool } from './parts';
import { AddServerDialog } from './AddServerDialog';
import { AllowlistDialog } from './dialogs';
import { loadConnectors, useConnectorEnv, type ConnectorEnv } from './env';
import { PACK_CONNECTORS, isPackConnector, packOfConnector } from './ops';

export default function ConnectorsPage() {
  const canManage = useCan('connectors.manage');
  const level = useOrgLevel();
  const consQ = useQuery((o) => loadConnectors(o), []);
  const envQ = useConnectorEnv();
  const agentsQ = useQuery((o) => api.agents(o), [], { kinds: ['agent', 'stop'] });
  const usageQ = useQuery(async (o) => usageByTool(o), []);
  const packsQ = useQuery((o) => api.packs(o), [level], { kinds: ['receipt'] });
  const [addOpen, setAddOpen] = useState(false);
  const [allowOpen, setAllowOpen] = useState(false);
  const env = envQ.data;

  const builtIn = consQ.data?.filter((c) => c.kind !== 'mcp_upstream') ?? [];
  const packCons = consQ.data?.filter((c) => isPackConnector(c)) ?? [];
  const upstream = consQ.data?.filter((c) => c.kind === 'mcp_upstream' && !isPackConnector(c)) ?? [];
  const notInstalled = (packsQ.data ?? []).filter((p) => !p.installed);
  const demoCount = builtIn.filter((c) => c.mode === 'demo').length;

  // owners and admins connect systems; other roles read the page without the button
  const addBtn = canManage ? (
    <Tooltip content="Put an MCP server you run behind Elan1 Govern">
      <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAddOpen(true)}>Add an MCP server</Button>
    </Tooltip>
  ) : undefined;

  const loadErrors = [agentsQ.error && { what: 'Agents', e: agentsQ.error, retry: agentsQ.refetch }, usageQ.error && { what: '7-day usage', e: usageQ.error, retry: usageQ.refetch }, envQ.error && { what: 'Deployment and custody details', e: envQ.error, retry: envQ.refetch }].filter(Boolean) as { what: string; e: Error; retry: () => void }[];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="Connectors"
        description="The systems agents reach through Elan1 Govern. Credentials stay here; agents get a governed tool, never the key behind it."
        actions={addBtn}
      />

      {consQ.error && <Banner tone="bad" title="Could not load connectors" className="mb-6" actions={<Button size="sm" onClick={consQ.refetch}>Try again</Button>}>{consQ.error.message}</Banner>}
      {loadErrors.map((x) => (
        <Banner key={x.what} tone="bad" title={`${x.what} did not load — counts below may read 0`} className="mb-4" actions={<Button size="sm" onClick={x.retry}>Try again</Button>}>{x.e.message}</Banner>
      ))}

      {env && <CustodyStrip env={env} canManage={canManage} onAllow={() => setAllowOpen(true)} />}

      <section className="mb-10">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <div>
            <h2 className="text-xl font-semibold">Built-in connectors</h2>
            <p className="text-sm text-muted">{demoCount ? `${plural(demoCount, 'connector')} in demo mode. ${DEMO_NOTE}` : 'Connected to your own accounts.'}</p>
          </div>
        </div>
        {consQ.loading ? (
          <div className="grid gap-4 md:grid-cols-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[230px]" />)}</div>
        ) : builtIn.length === 0 ? (
          <div className="border border-line bg-surface">
            <EmptyState title="No built-in connectors" disc="registration">Gmail and Zoho Books are not set up for this organisation. Your MCP servers below work without them.</EmptyState>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">{builtIn.map((c) => <ConnectorCard key={c.id} c={c} agents={agentsQ.data} usage={usageQ.data} env={env} />)}</div>
        )}
      </section>

      <section className="mb-10">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <div>
            <h2 className="text-xl font-semibold">Regulatory pack connectors</h2>
            <p className="text-sm text-muted">Each installed pack brings the connector its declaration governs. They start in demo mode with tagged tools and writes switched off.</p>
          </div>
        </div>
        {consQ.loading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-[230px]" /></div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {packCons.map((c) => <ConnectorCard key={c.id} c={c} agents={agentsQ.data} usage={usageQ.data} env={env} />)}
            {notInstalled.map((p) => (
              <Link key={p.id} to={`/records/packs/${p.id}`} className="flex flex-col border border-dashed border-line-strong/70 bg-canvas p-5 hover:border-fg transition-colors">
                <span className="inline-flex items-center gap-2 text-sm font-medium"><Scale className="h-4 w-4 text-muted" aria-hidden />{PACK_CONNECTORS[p.id].name}</span>
                <span className="mt-1 text-xs text-muted">{PACK_CONNECTORS[p.id].purpose}</span>
                <span className="mt-3 text-xs text-muted">{plural(PACK_CONNECTORS[p.id].tools.length, 'tool')} · arrives when {p.name} is installed{atLeast(level, 'l2') ? '' : ` (a dry run until ${LEVEL_INFO.l2.label})`}</span>
                <span className="mt-auto pt-3 text-sm font-medium underline underline-offset-2">Open {p.name}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <div>
            <h2 className="text-xl font-semibold">Your MCP servers</h2>
            <p className="text-sm text-muted">Upstream MCP servers behind Elan1 Govern. New tools start switched off until someone reviews their risk tags.</p>
          </div>
          {upstream.length > 0 && <span className="text-sm text-muted num">{plural(upstream.length, 'server')} · {plural(upstream.reduce((s, c) => s + c.tools.length, 0), 'tool')}</span>}
        </div>
        {consQ.loading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[230px]" />)}</div>
        ) : upstream.length === 0 ? (
          <div className="border border-line bg-surface">
            <EmptyState title="No MCP servers yet" disc="registration" action={canManage ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAddOpen(true)}>Add an MCP server</Button> : undefined}>
              Add the address of an MCP server you run and the one header it needs. Elan1 Govern lists its tools, switched off, with suggested risk tags.
            </EmptyState>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {upstream.map((c) => <ConnectorCard key={c.id} c={c} agents={agentsQ.data} usage={usageQ.data} env={env} />)}
          </div>
        )}
      </section>

      {canManage && <AddServerDialog open={addOpen} onClose={() => setAddOpen(false)} existing={consQ.data ?? []} env={env} onOpenAllowlist={() => { setAddOpen(false); setAllowOpen(true); }} />}
      {canManage && <AllowlistDialog open={allowOpen} onClose={() => setAllowOpen(false)} env={env} />}
    </div>
  );
}

function CustodyStrip({ env, canManage, onAllow }: { env: ConnectorEnv; canManage: boolean; onAllow: () => void }) {
  const cust = custodyOf(env.level, env.deployment, env.residency, env.secrets);
  return (
    <div className="mb-8 grid gap-px bg-line border border-line md:grid-cols-[1fr_1fr_auto]">
      <div className="bg-surface p-4 min-w-0">
        <p className="label flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" aria-hidden />Credentials held in</p>
        <p className="mt-1 text-sm font-medium">{cust.holder}</p>
        <p className="text-xs text-muted">{cust.detail}</p>
      </div>
      <div className="bg-surface p-4 min-w-0">
        <p className="label flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" aria-hidden />Residency domain</p>
        <p className="mt-1 text-sm font-medium">{env.residency}</p>
        <p className="text-xs text-muted">{env.sovereign ? 'Your own infrastructure · egress denied by default' : `Hosted by elan1 · ${LEVEL_INFO[env.level].label}`}</p>
      </div>
      <div className="bg-surface p-4 min-w-0 md:max-w-[340px]">
        <p className="label flex items-center gap-1.5"><ShieldAlert className="h-3.5 w-3.5" aria-hidden />Internal hosts</p>
        {env.sovereign ? (
          <>
            <p className="mt-1 text-sm"><span className="num font-medium">{plural(env.allow.length, 'entry', 'entries')}</span> on the allow-list</p>
            <p className="text-xs text-muted truncate font-mono" title={env.allow.join(', ')}>{env.allow.join(', ') || 'None yet — private addresses are refused'}</p>
            {canManage && (
              <Tooltip content="Hosts and ranges on your network that upstream MCP servers may use">
                <Button size="sm" variant="secondary" className="mt-2" onClick={onAllow}>Edit internal hosts</Button>
              </Tooltip>
            )}
          </>
        ) : (
          <p className="mt-1 text-xs text-muted">Private network addresses are refused on the hosted service. A Sovereign deployment can allow internal hosts.</p>
        )}
      </div>
    </div>
  );
}

function ConnectorCard({ c, agents, usage, env }: { c: Connector; agents?: Agent[]; usage?: Map<string, Mix>; env?: ConnectorEnv }) {
  const nav = useNavigate();
  const enabled = c.tools.filter((t) => t.enabled).length;
  const mix = useMemo(() => {
    const m = emptyMix();
    for (const t of c.tools) {
      const u = usage?.get(t.name);
      if (u) { m.allow += u.allow; m.ask += u.ask; m.refuse += u.refuse; m.total += u.total; }
    }
    return m;
  }, [c.tools, usage]);
  const users = agentsOnConnector(agents, c);
  const untagged = c.tools.filter((t) => !t.tags.length).length;
  const pack = packOfConnector(c);
  const Icon = c.kind === 'gmail' ? Mail : c.kind === 'zoho_books' ? BookOpen : pack ? Scale : Server;
  const cust = env ? custodyOf(env.level, env.deployment, env.residency, env.secrets) : undefined;

  return (
    <article
      onClick={() => nav(`/connectors/${c.id}`)}
      className={cn('group flex flex-col bg-surface border border-line p-5 cursor-pointer hover:border-line-strong transition-colors', c.status === 'error' && 'border-l-[3px] border-l-bad')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="h-9 w-9 shrink-0 inline-flex items-center justify-center border border-line bg-sunken"><Icon className="h-4 w-4 text-muted" aria-hidden /></span>
          <div className="min-w-0">
            <Link to={`/connectors/${c.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-md leading-snug hover:underline underline-offset-2 block">{c.name}</Link>
            <p className="mt-0.5 text-xs text-muted inline-flex items-center gap-1 min-w-0 max-w-full">
              {c.url ? <><Globe className="h-3 w-3 shrink-0" /><span className="font-mono truncate">{c.url.replace(/^https:\/\//, '')}</span></> : <><MapPin className="h-3 w-3 shrink-0" />{c.region ?? env?.residency ?? (c.kind === 'gmail' ? 'Google Workspace' : '—')}</>}
            </p>
          </div>
        </div>
        <ConnectorStatus c={c} />
      </div>

      {c.mode === 'demo' && <p className="mt-3 text-xs text-info-fg bg-info-bg border border-info/30 px-2 py-1.5">Demo mode. {DEMO_NOTE}</p>}
      {c.status === 'error' && <p className="mt-3 text-xs text-bad-fg bg-bad-bg border border-bad/30 px-2 py-1.5">Last sync failed {c.lastSyncAt ? <When iso={c.lastSyncAt} /> : ''}. Calls to its tools are refused until it answers.</p>}
      {c.status === 'disconnected' && <p className="mt-3 text-xs text-muted bg-sunken border border-line px-2 py-1.5">Disconnected. Every tool is off; calls are refused by default.</p>}

      <dl className="mt-4 grid grid-cols-3 gap-px bg-line border border-line">
        <div className="bg-surface p-3"><dt className="label">Tools on</dt><dd className="mt-1 font-display text-xl font-semibold num">{enabled}<span className="text-subtle text-base font-normal">/{c.tools.length}</span></dd></div>
        <div className="bg-surface p-3"><dt className="label">Calls · 7d</dt><dd className="mt-1 font-display text-xl font-semibold num">{n(mix.total)}</dd></div>
        <div className="bg-surface p-3"><dt className="label">Agents</dt><dd className="mt-1 font-display text-xl font-semibold num">{n(users.length)}</dd></div>
      </dl>
      <MixBar mix={mix} className="mt-3" />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {c.mode === 'live' && <ModeBadge c={c} />}
        {pack && <span className="text-xs text-muted border border-line h-6 px-1.5 inline-flex items-center">Pack · {pack}</span>}
        {untagged > 0 && <span className="text-xs text-held-fg">{plural(untagged, 'tool')} without risk tags</span>}
        <span className="ml-auto text-xs text-muted">Synced <When iso={c.lastSyncAt} /></span>
      </div>

      {c.heldCredential && (
        <p className="mt-4 pt-3 border-t border-line flex items-start gap-2 text-xs text-muted">
          <Lock className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
          <span>Credential in {cust ? cust.holder.replace(/^Your /, 'your ') : 'the Elan1 Govern vault'}{env ? ` · ${env.residency}` : ''} — the agent never sees it</span>
        </p>
      )}
    </article>
  );
}
