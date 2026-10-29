import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, CheckCheck, Pause, Play, OctagonX, LifeBuoy, Sparkles, ArrowRight, BookCheck, Boxes, ScrollText, ArrowLeftRight, Mail, Webhook, MonitorDot, HeartPulse, Hash, MessageCircle } from 'lucide-react';
import { api } from '@/api';
import { useQuery, useMutation } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { useUi } from '@/store/ui';
import type { Agent, Incident, Receipt } from '@/types';
import { dateTime, n, plural, rupees } from '@/lib/format';
import { userName } from '@/mock/users';
import {
  PageHeader, Panel, Banner, Button, DataTable, EmptyState, Skeleton, SeverityChip, DecisionChip, Badge, Timeline, KeyValue, Dialog, Field, Textarea, Tooltip, StatusChip, toast,
  type Column,
} from '@/components/ui';
import { AgentLink, AgentStatus, Person, ReceiptLink, RouteMode, When } from '@/components/domain';
import { StopDialog } from '@/shell/StopDialog';
import { AlertStatusChip, detectorMeta } from './detectors';
import { useAlertSettings } from './settings';
import { SmartLink, useScreenAccess } from '@/shell/access';
import { alertBundle, setAlertStatus, stopState, type Delivery, type WorkAlert } from '@/features/work/backend';

export default function AlertPage() {
  const { id = '' } = useParams();
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const openAsk = useUi((s) => s.openAsk);
  // acknowledge and resolve: owners, admins and approvers (detector and auto-pause settings stay alerts.manage)
  const canManage = useCan('alerts.respond');
  const canPause = useCan('agents.pause');
  const canStop = useCan('stop.engage');
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signedLevel = useOrgLevel() !== 'l1';
  const [pauseOpen, setPauseOpen] = useState<'pause' | 'resume' | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const settings = useAlertSettings();
  const access = useScreenAccess();

  const { data, loading, error, refetch } = useQuery((o) => alertBundle(o, id), [id], { kinds: ['receipt', 'agent', 'alert', 'incident'] });
  // only one emergency stop is open at a time: a second one would orphan the first incident
  const stop = useQuery((o) => stopState(o), [], { kinds: ['stop'] });
  const stopActive = !!stop.data?.active;

  const setStatus = useMutation((status: 'acknowledged' | 'resolved') => setAlertStatus(orgId, data!.alert, status, user!.id));

  const act = async (status: 'acknowledged' | 'resolved') => {
    try {
      const r = await setStatus.mutate(status);
      refetch();
      toast.ok(status === 'acknowledged' ? 'Alert acknowledged' : 'Alert resolved', `Recorded as receipt #${n(r.seq)}${status === 'resolved' ? '. The agent keeps its current status.' : '.'}`);
    } catch (e) {
      toast.bad('Could not update the alert', (e as Error).message);
    }
  };

  if (error) {
    return (
      <div>
        <PageHeader kicker="Work" title="Alert" crumbs={[{ label: 'Alerts', to: '/alerts' }, { label: id }]} />
        <Banner tone="bad" title="This alert could not be opened" actions={<Button size="sm" onClick={() => nav('/alerts')}>Back to alerts</Button>}>{error.message}</Banner>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-4 w-40 mb-4" />
        <Skeleton className="h-9 w-2/3 mb-3" />
        <Skeleton className="h-4 w-1/2 mb-8" />
        <div className="grid gap-6 lg:grid-cols-12">
          <Skeleton className="h-64 lg:col-span-8" />
          <Skeleton className="h-64 lg:col-span-4" />
        </div>
      </div>
    );
  }

  const { alert, agent, related, trail, incident } = data;
  const det = detectorMeta(alert.detector);
  const assurance = alert.family === 'assurance';
  const apOn = alert.agentSlug ? settings.autoPause(alert.agentSlug) : false;
  const busy = setStatus.pending;
  const noPause = 'Owners and admins pause and resume agents.';

  // the evidence screen behind an assurance alert may be above this role or plan (an approver and the timestamps page)
  const evidenceOpen = !!alert.evidence && access.canSee(alert.evidence.to);
  const connected: ConnRow[] = ([
    alert.agentSlug ? { to: `/agents/${alert.agentSlug}`, icon: <ScrollText className="h-4 w-4" />, label: 'Agent page', sub: 'Keys, baseline and recent calls' } : null,
    data.rulebookId ? { to: `/rulebooks/${data.rulebookId}`, icon: <BookCheck className="h-4 w-4" />, label: 'Rulebook', sub: 'Tighten a rule if this should not recur' } : null,
    data.aiSystem ? { to: `/inventory/${data.aiSystem.id}`, icon: <Boxes className="h-4 w-4" />, label: data.aiSystem.name, sub: 'AI system in the inventory' } : null,
    alert.evidence ? { to: alert.evidence.to, icon: <HeartPulse className="h-4 w-4" />, label: alert.evidence.label, sub: 'The evidence this alert reads' } : null,
    incident ? { to: `/incidents/${incident.id}`, icon: <LifeBuoy className="h-4 w-4" />, label: incident.title, sub: incident.status === 'active' ? 'Incident — active' : 'Incident — resolved' } : null,
  ] as (ConnRow | null)[]).filter((c): c is ConnRow => !!c && access.canSee(c.to));

  const timeline = buildTimeline(alert, related, trail);
  const refusedCount = related.filter((r) => r.decision === 'refuse').length;

  const columns: Column<Receipt>[] = [
    { key: 'seq', header: 'Receipt', width: 96, cell: (r) => <ReceiptLink seq={r.seq} />, sort: (r) => r.seq },
    { key: 'ts', header: 'When', hideBelow: 'md', cell: (r) => <When iso={r.ts} className="text-muted" />, sort: (r) => r.ts },
    { key: 'tool', header: 'Tool', cell: (r) => <span className="font-mono text-[12px] break-all">{r.tool ?? r.action ?? '—'}</span> },
    { key: 'args', header: 'Arguments', hideBelow: 'lg', cell: (r) => <ArgsInline args={r.args_summary} /> },
    { key: 'decision', header: 'Decision', cell: (r) => (r.kind === 'admin' ? <span className="text-xs text-muted">Admin</span> : <DecisionChip decision={r.decision} size="sm" />) },
    { key: 'rule', header: 'Rule', hideBelow: 'md', cell: (r) => (r.rule_id ? <span className="font-mono text-[12px] text-muted">{r.rule_id}</span> : <span className="text-subtle">—</span>) },
  ];

  return (
    <div>
      <PageHeader
        kicker="Work · Alert"
        crumbs={[{ label: 'Alerts', to: '/alerts' }, { label: alert.title }]}
        title={alert.title}
        meta={
          <>
            <SeverityChip severity={alert.severity} />
            <AlertStatusChip status={alert.status} />
            <Badge icon={det.icon}>{det.label}</Badge>
            {assurance && <Badge icon={<HeartPulse className="h-3 w-3" aria-hidden />}>Assurance health</Badge>}
            {alert.autoPaused && <Badge tone="held" icon={<Pause className="h-3 w-3" aria-hidden />}>Auto-paused the agent</Badge>}
            <span className="text-sm text-muted">Raised <When iso={alert.createdAt} /> · <span className="font-mono text-[12px] break-all">{alert.id}</span></span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => openAsk({ kind: 'alert', title: alert.title, payload: alert })}>Ask Govern</Button>
            {/* owners, admins and approvers acknowledge and resolve; other roles do not see the buttons */}
            {canManage && alert.status === 'open' && (
              <span className="inline-flex" title="Tell the team someone is looking. Writes a receipt.">
                <Button variant="secondary" icon={<Check className="h-4 w-4" />} loading={busy} onClick={() => act('acknowledged')}>Acknowledge</Button>
              </span>
            )}
            {canManage && alert.status !== 'resolved' && (
              <span className="inline-flex" title={incident?.status === 'active' ? 'Resolving the alert does not close its incident; resolve the incident when its checks are done.' : 'Close the alert. The agent keeps its current status.'}>
                <Button variant="primary" icon={<CheckCheck className="h-4 w-4" />} loading={busy} onClick={() => act('resolved')}>Resolve</Button>
              </span>
            )}
          </>
        }
      />

      {alert.autoPaused && incident && (
        <Banner tone="held" className="mb-6" title={`${alert.agentSlug} was paused by this alert`}
          actions={<Button size="sm" variant="secondary" icon={<LifeBuoy className="h-4 w-4" />} onClick={() => nav(`/incidents/${incident.id}`)}>Open the incident</Button>}>
          Auto-pause was on for this agent and the alert was high severity. Every new call is refused with <span className="font-mono">agent-paused</span> and recorded. A person resumes it from the incident or below.
        </Banner>
      )}
      {assurance && incident && (
        <Banner tone={incident.status === 'active' ? 'bad' : 'neutral'} className="mb-6" title={incident.status === 'active' ? 'A health incident is open for this' : 'A health incident recorded this'}
          actions={<Button size="sm" variant="secondary" icon={<LifeBuoy className="h-4 w-4" />} onClick={() => nav(`/incidents/${incident.id}`)}>Open the incident</Button>}>
          {incident.status === 'active' ? 'Work through its checks to resolve it. Each step and the resolution are recorded.' : `Resolved ${incident.resolvedAt ? dateTime(incident.resolvedAt) : ''}.`}
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8 space-y-6 min-w-0">
          <Panel title="What changed" kicker={det.label}>
            <div className="grid sm:grid-cols-2 gap-px bg-line border border-line">
              <div className="bg-sunken/50 p-4">
                <p className="label">{assurance ? 'Expected' : 'Baseline'}</p>
                <p className="mt-2 font-display text-xl font-semibold leading-snug">{alert.baseline}</p>
                <p className="mt-1 text-xs text-muted">{assurance ? 'What this assurance level holds to' : "This agent's own behaviour over the last 14 days"}</p>
              </div>
              <div className="bg-surface p-4 border-l-[3px] border-l-held sm:border-l-[3px]">
                <p className="label flex items-center gap-1.5"><ArrowLeftRight className="h-3 w-3" aria-hidden />Observed</p>
                <p className="mt-2 font-display text-xl font-semibold leading-snug break-words">{alert.observed}</p>
                <p className="mt-1 text-xs text-muted">At the time the alert was raised</p>
              </div>
            </div>
            <p className="mt-4 text-md leading-relaxed">{alert.detail}</p>
            <div className="mt-4 border-t border-line pt-4 grid sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="label mb-1">What this detector watches</p>
                <p className="text-muted leading-relaxed">{det.watches}</p>
              </div>
              <div>
                <p className="label mb-1">When it fires</p>
                <p className="text-muted leading-relaxed">{det.trigger}</p>
              </div>
            </div>
          </Panel>

          <Panel
            title="Receipts behind this alert"
            flush
            actions={alert.agentSlug ? <Link to={`/activity?agent=${encodeURIComponent(alert.agentSlug)}&range=all`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">All activity for {alert.agentSlug}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link> : alert.evidence ? <SmartLink to={alert.evidence.to} hideWhenBlocked className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">{alert.evidence.label}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></SmartLink> : undefined}
            footer={related.length ? <span>{plural(related.length, 'receipt')} · {n(refusedCount)} refused · each one {signedLevel ? 'signed and hash-chained' : 'sealed in the hash chain'}</span> : undefined}
          >
            <DataTable
              className="border-0"
              caption="Receipts behind this alert"
              columns={columns}
              rows={related}
              rowKey={(r) => r.seq}
              onRowClick={(r) => nav(`/activity/${r.seq}`)}
              empty={<EmptyState compact title="No receipts linked" disc="registration">{assurance ? `This alert is about the evidence itself.${evidenceOpen ? ' Open it from the link above.' : ''}` : "The detector recorded no individual calls for this alert. Open the agent's activity to see the window around it."}</EmptyState>}
            />
          </Panel>

          <Panel title="Who was told" kicker="Deliveries" flush footer={<span>From the delivery record: each person and channel told about this alert, and every webhook subscribed to alert.created.</span>}>
            <DeliveryList deliveries={alert.deliveries} />
          </Panel>

          <Panel title="Timeline">
            <Timeline items={timeline} />
          </Panel>
        </div>

        <aside className="lg:col-span-4 space-y-6">
          {assurance ? (
            <Panel title="Evidence" kicker="What this is about">
              <p className="text-sm text-muted leading-relaxed">Assurance alerts are about the evidence, not an agent. Nothing is paused by them; a high one opens a health incident with guided checks.</p>
              {alert.evidence && <SmartLink to={alert.evidence.to} hideWhenBlocked className="mt-3 inline-flex items-center gap-1 h-9 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">Open {alert.evidence.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>}
              {alert.agentSlug && <div className="mt-3"><AgentLink slug={alert.agentSlug} /></div>}
            </Panel>
          ) : (
            <Panel title="Agent" kicker="Who this is about">
              {agent ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <AgentLink slug={agent.slug} className="text-md" />
                      <p className="mt-0.5 text-sm text-muted line-clamp-2">{agent.name}</p>
                    </div>
                    <AgentStatus agent={agent} />
                  </div>
                  <RouteMode route={agent.route} />
                  <KeyValue items={[
                    { k: 'Owner', v: <Person id={agent.ownerId} size={20} /> },
                    { k: 'Auto-pause', v: apOn ? <Badge tone="held">On</Badge> : <Badge>Off (default)</Badge> },
                    { k: 'Calls, 7 days', v: <span className="num">{n(agent.stats.calls7d)}</span> },
                    { k: 'Refused, 7 days', v: <span className="num">{n(agent.stats.refused7d)}</span> },
                  ]} />
                  <AgentActions agent={agent} canPause={canPause} noPause={noPause} incident={incident} onPause={() => setPauseOpen('pause')} onResume={() => setPauseOpen('resume')} />
                </div>
              ) : (
                <EmptyState compact title="Agent not found" disc="gate">The agent {alert.agentSlug} is no longer registered in this organisation.</EmptyState>
              )}
            </Panel>
          )}

          {/* only the records this role and plan can open; with none, the panel is left out rather than shown empty */}
          {connected.length > 0 && (
            <Panel title="Connected records" flush>
              <ul className="divide-y divide-line text-sm">
                {connected.map((c) => <ConnLink key={c.to} {...c} />)}
              </ul>
            </Panel>
          )}

          {/* the stop panel is for the roles that engage it; anyone else sees only the engaged stop's incident */}
          {canStop ? (
            <Panel tone="sunken" title="If this is worse than it looks">
              <p className="text-sm text-muted leading-relaxed">The emergency stop pauses every agent, or the ones you pick, in one transaction. Every new call is refused and recorded. Approvals already waiting are held until the stop is lifted; their expiry still runs.</p>
              <Tooltip content={stopActive ? 'A stop is already engaged. Only one stop is open at a time.' : 'Opens the emergency stop. You will type STOP to confirm.'}>
                <Button className="mt-4" variant="quiet-danger" icon={<OctagonX className="h-4 w-4" aria-hidden />} disabled={stopActive} onClick={() => setStopOpen(true)}>Open emergency stop</Button>
              </Tooltip>
              {stopActive && stop.data?.incidentId && <Link to={`/incidents/${stop.data.incidentId}`} className="mt-2 block text-sm link">A stop is engaged — open its incident</Link>}
            </Panel>
          ) : stopActive && stop.data?.incidentId ? (
            <Panel tone="sunken" title="Emergency stop engaged">
              <Link to={`/incidents/${stop.data.incidentId}`} className="text-sm link">Open its incident</Link>
            </Panel>
          ) : null}
        </aside>
      </div>

      {agent && pauseOpen && (
        <PauseDialog mode={pauseOpen} agent={agent} alert={alert} onClose={() => setPauseOpen(null)} onDone={refetch} />
      )}
      <StopDialog open={stopOpen} onClose={() => setStopOpen(false)} />
    </div>
  );
}

function DeliveryList({ deliveries }: { deliveries: Delivery[] }) {
  if (!deliveries.length) return <EmptyState compact title="Nobody was notified" disc="registration">No owner, admin or webhook was set up to receive this alert.</EmptyState>;
  const CHANNEL: Record<Delivery['channel'], { icon: ReactNode; label: string }> = {
    email: { icon: <Mail className="h-3.5 w-3.5" aria-hidden />, label: 'Email' },
    slack: { icon: <Hash className="h-3.5 w-3.5" aria-hidden />, label: 'Slack' },
    whatsapp: { icon: <MessageCircle className="h-3.5 w-3.5" aria-hidden />, label: 'WhatsApp' },
    webhook: { icon: <Webhook className="h-3.5 w-3.5" aria-hidden />, label: 'Webhook' },
    console: { icon: <MonitorDot className="h-3.5 w-3.5" aria-hidden />, label: 'Console' },
  };
  const icon = (c: Delivery['channel']) => <span title={CHANNEL[c].label}>{CHANNEL[c].icon}<span className="sr-only">{CHANNEL[c].label}: </span></span>;
  return (
    <ul className="divide-y divide-line">
      {deliveries.map((d) => (
        <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium"><span className="text-muted">{icon(d.channel)}</span><span className="truncate">{d.target}</span></p>
            <p className="mt-0.5 text-xs text-muted">{d.detail}</p>
          </div>
          <div className="shrink-0 text-right">
            {d.status === 'delivered' ? <StatusChip tone="ok" size="sm" icon={<Check className="h-3 w-3" aria-hidden />}>Delivered{d.code ? ` · ${d.code}` : ''}</StatusChip>
              : d.status === 'failed' ? <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Failed{d.code ? ` · ${d.code}` : ''}</StatusChip>
                : <StatusChip tone="neutral" size="sm">Not sent</StatusChip>}
            <p className="mt-1 text-xs text-muted">{dateTime(d.at)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AgentActions({ agent, canPause, noPause, incident, onPause, onResume }: { agent: Agent; canPause: boolean; noPause: string; incident?: Incident; onPause: () => void; onResume: () => void }) {
  if (agent.status === 'stopped') {
    return (
      <div className="border border-line bg-bad-bg/40 p-3 text-sm">
        <p className="font-medium">Stopped by the emergency stop</p>
        <p className="mt-1 text-muted">It resumes when the stop is lifted.</p>
        {incident && <Link to={`/incidents/${incident.id}`} className="mt-2 inline-flex items-center gap-1 font-medium hover:underline underline-offset-2">Go to the incident<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}
      </div>
    );
  }
  // owners and admins pause and resume; other roles see the status above, not a disabled button
  if (!canPause) return null;
  if (agent.status === 'paused') {
    return (
      <Tooltip content={canPause ? 'Resumes this agent. New calls are decided by its rulebook again.' : noPause}>
        <Button block variant="primary" icon={<Play className="h-4 w-4" />} disabled={!canPause} onClick={onResume}>Resume agent</Button>
      </Tooltip>
    );
  }
  if (agent.status === 'active') {
    return (
      <Tooltip content={canPause ? 'Pauses only this agent. New calls are refused and recorded.' : noPause}>
        <Button block variant="secondary" icon={<Pause className="h-4 w-4" />} disabled={!canPause} onClick={onPause}>Pause agent</Button>
      </Tooltip>
    );
  }
  return null;
}

function PauseDialog({ mode, agent, alert, onClose, onDone }: { mode: 'pause' | 'resume'; agent: Agent; alert: WorkAlert; onClose: () => void; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signedLevel = useOrgLevel() !== 'l1';
  const [reason, setReason] = useState(mode === 'pause' ? `Paused while investigating alert ${alert.id} (${alert.detector})` : '');
  const m = useMutation(() => api.setAgentStatus(orgId, agent.slug, mode === 'pause' ? 'paused' : 'active', user!.id, reason.trim()));
  const ok = reason.trim().length >= 4;
  const go = async () => {
    try {
      await m.mutate();
      if (mode === 'pause') toast.held(`${agent.slug} paused`, 'Every new call is refused with agent-paused and recorded.');
      else toast.ok(`${agent.slug} resumed`, 'New calls are decided by its rulebook again. The resume is recorded.');
      onDone();
      onClose();
    } catch (e) {
      toast.bad('Could not change the agent', (e as Error).message);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'pause' ? `Pause ${agent.slug}` : `Resume ${agent.slug}`}
      description={mode === 'pause'
        ? 'Only this agent pauses. Its new calls are refused with agent-paused and each one is recorded. Approvals it is already waiting on stay waiting.'
        : `The agent starts calling tools again and each call is decided by its ${signedLevel ? 'signed' : 'published'} rulebook. The resume is written to the chain with your note.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={mode === 'pause' ? 'danger' : 'primary'} icon={mode === 'pause' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} disabled={!ok} loading={m.pending} onClick={go}>
            {mode === 'pause' ? 'Pause agent' : 'Resume agent'}
          </Button>
        </>
      }
    >
      <Field label={mode === 'pause' ? 'Reason' : 'What was checked'} htmlFor="pause-reason" required hint="Recorded on the receipt.">
        <Textarea id="pause-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder={mode === 'pause' ? 'Why the agent is being paused' : 'For example: transfers reviewed with treasury; external account blocked in the rulebook'} />
      </Field>
    </Dialog>
  );
}

interface ConnRow { to: string; icon: ReactNode; label: string; sub: string }

/** One connected record; the caller has already left out records behind a screen this role or plan cannot open. */
function ConnLink({ to, icon, label, sub }: ConnRow) {
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 px-5 py-3 hover:bg-sunken/60 group">
        <span className="text-muted group-hover:text-fg">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium truncate">{label}</span>
          <span className="block text-xs text-muted truncate">{sub}</span>
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-subtle group-hover:text-fg" aria-hidden />
      </Link>
    </li>
  );
}

function ArgsInline({ args }: { args?: Receipt['args_summary'] }) {
  if (!args) return <span className="text-subtle">—</span>;
  const entries = Object.entries(args).slice(0, 2);
  return (
    <span className="block max-w-[170px] xl:max-w-[220px] truncate font-mono text-[12px] text-muted" title={JSON.stringify(args)}>
      {entries.map(([k, v]) => `${k}=${typeof v === 'number' && /amount|sum|total|value/i.test(k) ? rupees(v) : String(v)}`).join(' · ')}
    </span>
  );
}

function buildTimeline(alert: WorkAlert, related: Receipt[], trail: Receipt[]) {
  type Item = { at: number; time: ReactNode; title: ReactNode; body?: ReactNode; tone: 'ok' | 'held' | 'bad' | 'info' | 'neutral' };
  const items: Item[] = [];
  const stamp = (iso: string) => <span title={dateTime(iso)}>{dateTime(iso)}</span>;
  if (related[0]) {
    items.push({ at: new Date(related[0].ts).getTime(), time: stamp(related[0].ts), tone: 'neutral', title: <>First call in the window <ReceiptLink seq={related[0].seq} className="ml-1" /></>, body: `${related[0].tool ?? related[0].action ?? 'Call'} — ${related[0].decision === 'refuse' ? 'refused' : related[0].decision === 'ask' ? 'held for a person' : related[0].decision === 'allow' ? 'allowed' : 'recorded'}` });
  }
  const c = new Date(alert.createdAt).getTime();
  const created = trail.find((r) => r.action === 'alert.created');
  // what the saved notification routing actually sent, channel by channel (deliveries are planned from it)
  const people = alert.deliveries.filter((d) => d.channel === 'email' || d.channel === 'slack' || d.channel === 'whatsapp');
  const sent = (ch: Delivery['channel']) => people.filter((d) => d.channel === ch && d.status === 'delivered').length;
  const hooks = alert.deliveries.filter((d) => d.channel === 'webhook');
  const failed = hooks.filter((d) => d.status === 'failed').length;
  const told = ([['email', 'emailed'], ['slack', 'sent on Slack'], ['whatsapp', 'sent on WhatsApp']] as const)
    .filter(([ch]) => sent(ch) > 0).map(([ch, verb]) => `${plural(sent(ch), 'person', 'people')} ${verb}`);
  const body = [
    told.length ? told.join(', ') : `Nobody notified: the saved routing for ${alert.severity} alerts sends it only to the Alerts queue`,
    hooks.length ? `${plural(hooks.length, 'webhook')} called${failed ? `, ${failed} failed` : ''}` : 'No webhook subscribed',
  ].join('; ');
  items.push({ at: c, time: stamp(alert.createdAt), tone: alert.severity === 'high' ? 'bad' : alert.severity === 'medium' ? 'held' : 'info', title: <>{detectorMeta(alert.detector).label} raised at {alert.severity} severity{created && <ReceiptLink seq={created.seq} className="ml-1" />}</>, body });
  let ackSeen = false, resSeen = false;
  for (const r of trail) {
    const at = new Date(r.ts).getTime();
    const who = r.actor ? (r.actor === 'system' ? 'Elan1 Govern' : userName(r.actor)) : 'Someone';
    if (r.action === 'alert.acknowledged') { ackSeen = true; items.push({ at, time: stamp(r.ts), tone: 'held', title: <>Acknowledged by {who} <ReceiptLink seq={r.seq} className="ml-1" /></> }); }
    else if (r.action === 'alert.resolved') { resSeen = true; items.push({ at, time: stamp(r.ts), tone: 'ok', title: <>Resolved by {who} <ReceiptLink seq={r.seq} className="ml-1" /></> }); }
    else if (r.action === 'agent.paused') items.push({ at, time: stamp(r.ts), tone: 'held', title: <>{r.actor === 'system' ? 'Auto-pause paused' : `${who} paused`} {r.agent} <ReceiptLink seq={r.seq} className="ml-1" /></>, body: typeof r.details?.reason === 'string' ? r.details.reason : undefined });
    else if (r.action === 'agent.resumed') items.push({ at, time: stamp(r.ts), tone: 'ok', title: <>{who} resumed {r.agent} <ReceiptLink seq={r.seq} className="ml-1" /></>, body: typeof r.details?.reason === 'string' ? r.details.reason : undefined });
  }
  if (alert.autoPaused && !trail.some((r) => r.action === 'agent.paused')) items.push({ at: c + 1, time: stamp(alert.createdAt), tone: 'held', title: `Auto-pause paused ${alert.agentSlug}`, body: 'Auto-pause was on for this agent.' });
  if (alert.acknowledgedBy && !ackSeen) items.push({ at: c + 2, time: undefined, tone: 'held', title: `Acknowledged by ${userName(alert.acknowledgedBy)}` });
  if (alert.resolvedAt && !resSeen) items.push({ at: new Date(alert.resolvedAt).getTime(), time: stamp(alert.resolvedAt), tone: 'ok', title: alert.resolvedBy && alert.resolvedBy !== 'system' ? `Resolved by ${userName(alert.resolvedBy)}` : 'Recovered' });
  if (alert.status !== 'resolved') items.push({ at: Number.MAX_SAFE_INTEGER, time: undefined, tone: 'neutral', title: alert.status === 'open' ? 'Waiting for someone to acknowledge' : 'Waiting to be resolved' });
  return items.sort((a, b) => a.at - b.at).map(({ time, title, body, tone }) => ({ time, title, body, tone }));
}
