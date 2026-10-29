import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { OctagonX, PauseCircle, LifeBuoy, RefreshCw, HeartPulse } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Agent, Alert, Severity } from '@/types';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { n, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  PageHeader, Panel, Stat, Banner, Button, Segmented, Select, SearchInput, DataTable, EmptyState, Switch, Badge, SeverityChip, Skeleton, StatusChip, Tooltip, toast,
  type Column,
} from '@/components/ui';
import { AgentLink, AgentStatus, When } from '@/components/domain';
import { StopDialog } from '@/shell/StopDialog';
import { DETECTORS, DetectorName, AlertStatusChip, detectorMeta, type DetectorMeta } from './detectors';
import { useAlertSettings, SENSITIVITY_LABEL, type Sensitivity } from './settings';
import { alerts as loadAlerts, runChecks, simulateRefusalSurge, setDetector, setSensitivity, stopState, type AnyDetector, type WorkAlert } from '@/features/work/backend';
// auto-pause is written through the Agents screens' call (same per-organisation store; refuses retired agents)
import { setAutoPause } from '@/features/agents/backend';
import { UpgradePath } from '@/features/work/level';

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export default function AlertsPage() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const nav = useNavigate();
  const canManage = useCan('alerts.manage');
  const canStop = useCan('stop.engage');
  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [alerts, agents, stop] = await Promise.all([loadAlerts(o), api.agents(o), stopState(o)]);
    return { alerts, agents, stop };
  }, [], { kinds: ['receipt', 'agent', 'stop', 'update', 'alert', 'incident'] });

  const [status, setStatus] = useState<Alert['status']>('open');
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [detector, setDetectorFilter] = useState<AnyDetector | 'all'>('all');
  const [family, setFamily] = useState<'all' | 'behaviour' | 'assurance'>('all');
  const [q, setQ] = useState('');
  const [stopOpen, setStopOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [drilling, setDrilling] = useState(false);

  const alerts = data?.alerts ?? [];
  const counts = useMemo(() => ({
    open: alerts.filter((a) => a.status === 'open').length,
    acknowledged: alerts.filter((a) => a.status === 'acknowledged').length,
    resolved: alerts.filter((a) => a.status === 'resolved').length,
    highOpen: alerts.filter((a) => a.status !== 'resolved' && a.severity === 'high').length,
    assuranceOpen: alerts.filter((a) => a.family === 'assurance' && a.status !== 'resolved').length,
  }), [alerts]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return alerts
      .filter((a) => a.status === status && (severity === 'all' || a.severity === severity) && (detector === 'all' || a.detector === detector) && (family === 'all' || a.family === family))
      .filter((a) => !needle || `${a.title} ${a.agentSlug} ${a.detail} ${a.detector}`.toLowerCase().includes(needle))
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.createdAt.localeCompare(a.createdAt));
  }, [alerts, status, severity, detector, family, q]);

  const autoPausedAgents = (data?.agents ?? []).filter((a) => a.status === 'paused' && a.pausedBy === 'auto-pause');
  // only one emergency stop is open at a time (read from the stop itself, not from which agents it paused)
  const stopActive = !!data?.stop.active || (data?.agents ?? []).some((a) => a.pausedBy === 'emergency-stop');

  const check = async () => {
    setChecking(true);
    try {
      const after = await runChecks(orgId);
      refetch();
      const open = after.filter((a) => a.family === 'assurance' && a.status !== 'resolved').length;
      toast.ok('Checks run', atLeast(level, 'l2') ? `${plural(open, 'assurance alert')} open. Behavioural detectors scanned every new call.` : 'Behavioural detectors scanned every new call.');
    } catch (e) {
      toast.bad('Checks did not run', (e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const drill = async () => {
    if (!user) return;
    setDrilling(true);
    try {
      const r = await simulateRefusalSurge(orgId, user.id);
      refetch();
      if (r.alertId) {
        toast.held('Refusal surge raised', `${plural(r.calls, 'refused call')} from ${r.agent}. Open the alert to investigate, then stop the agent if needed.`);
        nav(`/alerts/${r.alertId}`);
      } else toast.info('Drill sent', `${plural(r.calls, 'refused call')} from ${r.agent}; the detector did not raise an alert at its current sensitivity.`);
    } catch (e) {
      toast.bad('The drill did not run', (e as Error).message);
    } finally {
      setDrilling(false);
    }
  };

  const columns: Column<WorkAlert>[] = [
    { key: 'sev', header: 'Severity', width: 110, cell: (a) => <SeverityChip severity={a.severity} size="sm" />, sort: (a) => SEV_RANK[a.severity] },
    {
      key: 'title', header: 'Alert', cell: (a) => (
        <div className="min-w-0 py-1.5 flex items-center gap-2">
          <div className="min-w-0">
            <Link to={`/alerts/${a.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline underline-offset-2 line-clamp-1">{a.title}</Link>
            <p className="text-xs text-muted line-clamp-1 sm:hidden">{a.agentSlug || 'Assurance'} · {detectorMeta(a.detector).label}</p>
          </div>
          {a.autoPaused && (
            <Tooltip content="Auto-pause was on for this agent, so this high-severity alert paused it.">
              <Badge tone="held" icon={<PauseCircle className="h-3 w-3" aria-hidden />}>Auto-paused</Badge>
            </Tooltip>
          )}
          {a.family === 'assurance' && <Badge icon={<HeartPulse className="h-3 w-3" aria-hidden />}>Assurance</Badge>}
        </div>
      ),
    },
    { key: 'agent', header: 'Agent', hideBelow: 'sm', cell: (a) => (a.agentSlug ? <AgentLink slug={a.agentSlug} /> : <span className="text-muted text-sm">Evidence</span>), sort: (a) => a.agentSlug },
    { key: 'detector', header: 'Detector', hideBelow: 'md', cell: (a) => <DetectorName id={a.detector} />, sort: (a) => a.detector },
    { key: 'created', header: 'Raised', hideBelow: 'md', cell: (a) => <When iso={a.createdAt} className="text-muted" />, sort: (a) => a.createdAt },
    { key: 'status', header: 'Status', hideBelow: 'lg', cell: (a) => <AlertStatusChip status={a.status} /> },
  ];

  return (
    <div>
      <PageHeader
        kicker="Work"
        title="Alerts"
        description={atLeast(level, 'l2')
          ? '6 detectors compare each agent with its own baseline, and the assurance detectors watch the evidence itself. An alert asks a person to look; it changes nothing unless auto-pause is on for that agent.'
          : '6 detectors compare each agent with its own baseline. An alert asks a person to look; it changes nothing unless auto-pause is on for that agent.'}
        actions={
          <>
            {canManage && <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={checking} onClick={check}>Run checks now</Button>}
            {canManage && (
              <Tooltip content="Demo drill: sends a burst of calls your rulebook refuses through the real guard, from the agent with the most rule refusals. The refusal-surge detector then raises its alert as it would in production. Nothing runs; every call is a recorded refusal.">
                <Button variant="ghost" icon={<OctagonX className="h-4 w-4" />} loading={drilling} onClick={drill}>Simulate a refusal surge</Button>
              </Tooltip>
            )}
            <Button variant="secondary" icon={<LifeBuoy className="h-4 w-4" />} onClick={() => nav('/incidents')}>Incidents</Button>
            {/* owners and admins engage the stop; while one is engaged the button stays, disabled with the reason */}
            {canStop && (
              <span className="inline-flex" title={stopActive ? 'A stop is already engaged. Only one stop is open at a time.' : 'Pauses agents in one transaction.'}>
                <Button variant="quiet-danger" icon={<OctagonX className="h-4 w-4" />} disabled={stopActive} onClick={() => setStopOpen(true)}>Emergency stop</Button>
              </span>
            )}
          </>
        }
      />

      {error && <Banner tone="bad" title="Alerts could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6" aria-live="polite">
        {loading && !data ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[112px]" />) : (
          <>
            <Stat label="Open" value={n(counts.open)} sub="Waiting for someone to look" />
            <Stat label="Acknowledged" value={n(counts.acknowledged)} sub="Someone is on it" />
            <Stat label="High severity, unresolved" value={n(counts.highOpen)} sub={atLeast(level, 'l2') ? `${n(counts.assuranceOpen)} from the assurance detectors` : 'Only volume, refusal and amount detectors reach high'} />
            <Stat label="Auto-paused agents" value={n(autoPausedAgents.length)} sub={autoPausedAgents.length ? autoPausedAgents.map((a) => a.slug).join(', ') : 'None paused by an alert'} to={autoPausedAgents.length ? '/incidents' : undefined} />
          </>
        )}
      </div>

      <Panel
        title="Alert queue"
        flush
        actions={<span className="hidden sm:inline text-xs text-muted">Checked as calls arrive · no alerts in an agent's first 7 days</span>}
      >
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
          <Segmented
            label="Alert status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'open', label: 'Open', count: counts.open },
              { value: 'acknowledged', label: 'Acknowledged', count: counts.acknowledged },
              { value: 'resolved', label: 'Resolved', count: counts.resolved },
            ]}
          />
          {(
            <div className="w-[160px]">
              <Select size_="sm" aria-label="Family" value={family} onChange={(e) => setFamily(e.target.value as typeof family)}>
                <option value="all">All families</option>
                <option value="behaviour">Agent behaviour</option>
                <option value="assurance">Assurance health</option>
              </Select>
            </div>
          )}
          <div className="w-[150px]">
            <Select size_="sm" aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | 'all')}>
              <option value="all">All severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
          </div>
          <div className="w-[190px]">
            <Select size_="sm" aria-label="Detector" value={detector} onChange={(e) => setDetectorFilter(e.target.value as AnyDetector | 'all')}>
              <option value="all">All detectors</option>
              {DETECTORS.filter((d) => atLeast(level, d.level)).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </Select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <SearchInput placeholder="Search alerts, agents, details" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search alerts" />
          </div>
        </div>
        <DataTable
          className="border-0"
          caption="Alerts"
          columns={columns}
          rows={rows}
          loading={loading && !data}
          rowKey={(a) => a.id}
          onRowClick={(a) => nav(`/alerts/${a.id}`)}
          rowClassName={(a) => (a.severity === 'high' && a.status !== 'resolved' ? 'shadow-[inset_3px_0_0_rgb(var(--bad))]' : undefined)}
          empty={
            <EmptyState compact title={status === 'open' ? 'No open alerts' : status === 'acknowledged' ? 'Nothing acknowledged and waiting' : 'No resolved alerts match'} disc="aperture">
              {status === 'open'
                ? 'Every agent is behaving like its own baseline. The detectors keep watching; new alerts appear here, and each one lists who was told and on which channel.'
                : 'Change the filters to see more.'}
            </EmptyState>
          }
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-12 mt-8">
        <section className="lg:col-span-8" aria-labelledby="detectors-h">
          <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
            <div>
              <p className="label mb-1">What is watched</p>
              <h2 id="detectors-h" className="text-xl font-semibold">Detectors</h2>
            </div>
            <p className="text-xs text-muted max-w-[46ch]">Each behavioural detector learns from 14 days of the agent's own calls. Settings apply to everyone in the organisation, and every change is a receipt.</p>
          </div>
          <DetectorGrid alerts={alerts} canManage={canManage} orgId={orgId} userId={user?.id} family="behaviour" />
          <div className="mt-8 mb-3">
            <p className="label mb-1">{atLeast(level, 'l2') ? `Chain and receipt writes from ${LEVEL_INFO.l1.label}; the rest from ${LEVEL_INFO.l2.label}` : 'Chain and receipt writes'}</p>
            <h3 className="text-lg font-semibold">Assurance health</h3>
          </div>
          <DetectorGrid alerts={alerts} canManage={canManage} orgId={orgId} userId={user?.id} family="assurance" />
          {!atLeast(level, 'l2') && (
            <UpgradePath className="mt-4" to="l2" what="The other assurance-health detectors start at Attested">
              A break in the chain or a receipt the store would not take opens a health incident at every level. From Attested they also watch a timestamp from either authority more than 15 minutes late, the signing key in KMS, write-once storage, the TypeScript and Python implementations agreeing, and inclusion proofs. At Proven they also watch counterparties and autonomy; on Sovereign, your cluster and update bundles.
            </UpgradePath>
          )}
        </section>

        <aside className="lg:col-span-4">
          <AutoPausePanel agents={data?.agents} canManage={canManage} orgId={orgId} userId={user?.id} loading={loading} />
        </aside>
      </div>

      <StopDialog open={stopOpen} onClose={() => setStopOpen(false)} />
    </div>
  );
}

function DetectorGrid({ alerts, canManage, orgId, userId, family }: { alerts: WorkAlert[]; canManage: boolean; orgId: string; userId?: string; family: 'behaviour' | 'assurance' }) {
  const level = useOrgLevel();
  const settings = useAlertSettings();
  const [busy, setBusy] = useState<string>();
  // detectors above the organisation's plan are left out (owners see one Change plan line below the grid)
  const list = DETECTORS.filter((d) => d.family === family && atLeast(level, d.level));

  const toggle = async (d: DetectorMeta, v: boolean) => {
    if (!userId) return;
    setBusy(d.id);
    try {
      const r = await setDetector(orgId, d.id, v, userId);
      settings.refetch();
      toast.info(v ? `${d.label} turned on` : `${d.label} turned off`, `${v ? 'New alerts from this detector will appear in the queue.' : 'Existing alerts stay. No new alerts from this detector until it is turned on.'} Receipt #${n(r.seq)}.`);
    } catch (e) {
      toast.bad('Not changed', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const tune = async (d: DetectorMeta, v: Sensitivity) => {
    if (!userId) return;
    setBusy(d.id);
    try {
      const r = await setSensitivity(orgId, d.id, v, userId);
      settings.refetch();
      toast.info(`${d.label}: ${SENSITIVITY_LABEL[v].toLowerCase()}`, `Thresholds move one step from the defaults above. Receipt #${n(r.seq)}.`);
    } catch (e) {
      toast.bad('Not changed', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {settings.error && <p className="sm:col-span-2 text-sm text-bad-fg">The detector settings could not be loaded. {settings.error.message}</p>}
      {list.map((d) => {
        const available = atLeast(level, d.level);
        const on = settings.detectorOn(d.id);
        const sens = settings.sensitivity(d.id);
        const mine = alerts.filter((a) => a.detector === d.id);
        const open = mine.filter((a) => a.status !== 'resolved').length;
        return (
          <article key={d.id} className={cn('border border-line bg-surface p-4 flex flex-col gap-3 transition-opacity', (!on || !available) && 'opacity-70')}>
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-7 w-7 items-center justify-center border border-line bg-sunken text-fg">{d.icon}</span>
                  <h3 className="text-md font-semibold">{d.label}</h3>
                </div>
                <p className="mt-1 font-mono text-[11.5px] text-subtle">{d.id}{d.level !== 'l1' && <> · from {LEVEL_INFO[d.level].tag}</>}</p>
              </div>
              {canManage ? (
                <Switch checked={on} disabled={busy === d.id || settings.loading} label={`${d.label} detector`} onChange={(v) => toggle(d, v)} />
              ) : (
                <StatusChip size="sm" tone={on ? 'ok' : 'neutral'}>{on ? 'On' : 'Off'}</StatusChip>
              )}
            </header>
            <p className="text-sm text-fg/90 leading-relaxed">{d.watches}</p>
            <p className="text-xs text-muted leading-relaxed">{d.trigger}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted mr-1">Can raise</span>
              {d.severities.map((s) => <SeverityChip key={s} severity={s} size="sm" />)}
              {d.family === 'assurance'
                ? (d.canHigh ? <Badge tone="held" className="ml-auto" title="A high alert opens a health incident">Opens an incident</Badge> : <Badge className="ml-auto">Alert only</Badge>)
                : d.canHigh ? <Badge tone="held" className="ml-auto" title="A high-severity alert from this detector can pause the agent when auto-pause is on">Can auto-pause</Badge> : <Badge className="ml-auto" title="This detector never reaches high, so it never pauses an agent">Never pauses</Badge>}
            </div>
            <div className="mt-auto pt-3 border-t border-line flex flex-wrap items-center justify-between gap-2">
              {d.family === 'behaviour' && !canManage ? (
                <span className="text-xs text-muted">Sensitivity: <span className="text-fg">{SENSITIVITY_LABEL[sens]}</span></span>
              ) : d.family === 'behaviour' ? (
                <Segmented<Sensitivity>
                  size="sm"
                  label={`${d.label} sensitivity`}
                  value={sens}
                  onChange={(v) => { if (!canManage || v === sens) return; void tune(d, v); }}
                  options={[{ value: 'fewer', label: 'Fewer' }, { value: 'default', label: 'Default' }, { value: 'more', label: 'More' }]}
                />
              ) : <span className="text-xs text-muted">Thresholds are fixed by the assurance level.</span>}
              <span className="text-xs text-muted num">{plural(mine.length, 'alert')}{open ? ` · ${n(open)} unresolved` : ''}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function AutoPausePanel({ agents, canManage, orgId, userId, loading }: { agents?: Agent[]; canManage: boolean; orgId: string; userId?: string; loading: boolean }) {
  const settings = useAlertSettings();
  const [busy, setBusy] = useState<string>();
  const list = (agents ?? []).filter((a) => a.status !== 'draft');
  const onCount = list.filter((a) => settings.autoPause(a.slug)).length;
  const flip = async (slug: string, v: boolean) => {
    if (!userId) return;
    setBusy(slug);
    try {
      const r = await setAutoPause(orgId, slug, v, userId);
      settings.refetch();
      if (v) toast.held(`Auto-pause on for ${slug}`, `A high-severity alert will now pause this agent until a person resumes it. Receipt #${n(r.seq)}.`);
      else toast.info(`Auto-pause off for ${slug}`, `Alerts will still be raised and sent; the agent keeps running. Receipt #${n(r.seq)}.`);
    } catch (e) {
      toast.bad('Not changed', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Panel
      kicker="Per agent"
      title="Auto-pause"
      flush
      footer={<span>A pause writes an <span className="font-mono">agent.paused</span> receipt naming the alert and opens an incident. A person resumes the agent.</span>}
    >
      <div className="px-5 py-4 border-b border-line space-y-2">
        <p className="text-sm font-medium">Auto-pause — off by default. When on, a high-severity alert pauses the agent.</p>
        <p className="text-xs text-muted leading-relaxed">Only volume spike, refusal surge and amount outlier can raise high severity, so only those three can pause an agent. {n(onCount)} of {n(list.length)} agents have it on.</p>
      </div>
      {(loading && !agents) || (settings.loading && !settings.error) ? (
        <div className="p-5 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : settings.error ? (
        <p className="px-5 py-4 text-sm text-bad-fg">Auto-pause settings could not be loaded. {settings.error.message}</p>
      ) : list.length === 0 ? (
        <EmptyState compact title="No agents yet" disc="gate">Add an agent and its auto-pause switch appears here.</EmptyState>
      ) : (
        <ul className="divide-y divide-line max-h-[460px] overflow-y-auto">
          {list.map((a) => (
            <li key={a.slug} className="flex items-center justify-between gap-3 px-5 py-2.5">
              <div className="min-w-0">
                <AgentLink slug={a.slug} className="text-sm" />
                <div className="mt-1"><AgentStatus agent={a} /></div>
              </div>
              {canManage
                ? <Switch checked={settings.autoPause(a.slug)} disabled={busy === a.slug} label={`Auto-pause for ${a.slug}`} onChange={(v) => flip(a.slug, v)} />
                : <StatusChip size="sm" tone={settings.autoPause(a.slug) ? 'held' : 'neutral'}>{settings.autoPause(a.slug) ? 'Auto-pause on' : 'Off'}</StatusChip>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
