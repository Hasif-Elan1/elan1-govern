import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { OctagonX, Play, ArrowRight, Siren, HeartPulse, Megaphone, FileX2, Clock3 } from 'lucide-react';
import { api } from '@/api';
import { useQuery, useNow } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Incident } from '@/types';
import { atLeast } from '@/lib/levels';
import { countdown, dateTime, n, relative } from '@/lib/format';
import { userName } from '@/mock/users';
import { PageHeader, Panel, Banner, Button, Segmented, Select, DataTable, EmptyState, Skeleton, Dialog, Tooltip, StatusChip, toast, type Column } from '@/components/ui';
import { DeclareDialog } from './DeclareDialog';
import { BreakGlassPanel } from '@/features/work/BreakGlassPanel';
import { Person, When } from '@/components/domain';
import { StopDialog } from '@/shell/StopDialog';
import { KindBadge, IncidentStatusChip, duration, scopeLabel, refusedDuring } from './util';
import { LiftStopForm } from './ResumeFlows';
import { incidents as loadIncidents, runChecks, stopState, SECURITY_KINDS, type WorkIncident } from '@/features/work/backend';
import { UpgradePath } from '@/features/work/level';

export default function IncidentsPage() {
  const nav = useNavigate();
  const orgId = useOrgId();
  const level = useOrgLevel();
  const now = useNow(30_000);
  const canStop = useCan('stop.engage');
  const [status, setStatus] = useState<'all' | Incident['status']>('all');
  const [kind, setKind] = useState<'all' | Incident['kind'] | 'security'>('all');
  const [stopOpen, setStopOpen] = useState(false);
  const [liftOpen, setLiftOpen] = useState(false);
  const [declareOpen, setDeclareOpen] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const user = useUser();

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [incidents, agents, paused, approvals, stop] = await Promise.all([
      loadIncidents(o), api.agents(o), api.receipts(o, { kind: 'decision', q: 'agent-paused' }), api.approvals(o), stopState(o),
    ]);
    const certIn = Object.fromEntries(api.ops.certInAll(o).map((c) => [c.incidentId, c]));
    return { incidents, agents, pausedReceipts: paused.items.filter((r) => r.rule_id === 'agent-paused'), pendingNow: approvals.filter((a) => a.status === 'pending').length, stop, certIn, lift: api.ops.pendingLift(o), dual: api.ops.liftNeedsSecond(o) };
  }, [], { kinds: ['receipt', 'incident', 'stop', 'agent'] });
  const drill = async () => {
    if (!user) return;
    setDrilling(true);
    try {
      api.ops.startWriteDrill(orgId, user.id);
      await runChecks(orgId);
      refetch();
      toast.bad('Write-failure drill started', 'For two minutes the receipt writer is failed: the guard refuses every agent call and runs none. A health incident is open; resolve it with its checks once receipts are written again.');
    } catch (e) {
      toast.bad('The drill did not start', (e as Error).message);
    } finally {
      setDrilling(false);
    }
  };
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      await runChecks(orgId);
      refetch();
      toast.ok('Health checks run', 'Open high-severity assurance problems have an incident; recovered ones are kept as history.');
    } catch (e) {
      toast.bad('Checks did not run', (e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const incidents = data?.incidents ?? [];
  const isSecurity = (i: WorkIncident) => i.kind === 'health' && !!i.subkind && SECURITY_KINDS.includes(i.subkind);
  const rows = useMemo(() => incidents
    .filter((i) => (status === 'all' || i.status === status) && (kind === 'all' || (kind === 'security' ? isSecurity(i) : i.kind === kind && !(kind === 'health' && isSecurity(i)))))
    .sort((a, b) => (a.status === b.status ? b.startedAt.localeCompare(a.startedAt) : a.status === 'active' ? -1 : 1)), [incidents, status, kind]);

  const stopIncident = data?.stop.active ? incidents.find((i) => i.id === data.stop.incidentId) : undefined;
  const resumable = (data?.agents ?? []).filter((a) => a.pausedBy === 'emergency-stop');
  const otherPaused = (data?.agents ?? []).filter((a) => a.status === 'paused');
  const activeAutoPause = incidents.filter((i) => i.status === 'active' && i.kind !== 'emergency_stop');
  const refusedOf = (i: Incident) => refusedDuring(i, data?.pausedReceipts ?? []);

  const columns: Column<WorkIncident>[] = [
    {
      key: 'title', header: 'Incident', cell: (i) => (
        <div className="py-2 min-w-0">
          <Link to={`/incidents/${i.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline underline-offset-2">{i.title}</Link>
          <p className="text-xs text-muted line-clamp-1 max-w-[46ch]">{i.reason}</p>
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', hideBelow: 'md', cell: (i) => <KindBadge kind={i.kind} subkind={i.subkind} />, sort: (i) => i.kind },
    { key: 'status', header: 'Status', cell: (i) => <IncidentStatusChip status={i.status} />, sort: (i) => i.status },
    { key: 'scope', header: 'Scope', hideBelow: 'lg', cell: (i) => <span className="text-sm">{scopeLabel(i)}</span> },
    { key: 'by', header: 'Started by', hideBelow: 'md', cell: (i) => <Person id={i.startedBy} size={22} /> },
    { key: 'started', header: 'Started', hideBelow: 'sm', cell: (i) => <When iso={i.startedAt} className="text-muted" />, sort: (i) => i.startedAt },
    { key: 'dur', header: 'Duration', hideBelow: 'lg', cell: (i) => <span className="num">{i.status === 'active' ? <>{duration(i.startedAt, undefined, now)} <span className="text-xs text-bad-fg">and counting</span></> : duration(i.startedAt, i.resolvedAt)}</span>, sort: (i) => (i.resolvedAt ? new Date(i.resolvedAt).getTime() : now) - new Date(i.startedAt).getTime() },
    { key: 'refused', header: 'Refused while stopped', align: 'right', hideBelow: 'sm', cell: (i) => (i.kind === 'health' ? <span className="text-subtle">—</span> : n(refusedOf(i))), sort: (i) => refusedOf(i) },
    {
      key: 'certin', header: 'CERT-In', hideBelow: 'md', cell: (i) => {
        const c = data?.certIn[i.id];
        if (!c) return <span className="text-subtle">—</span>;
        if (c.submittedAt) return <StatusChip tone={c.late ? 'held' : 'ok'} size="sm">{c.late ? 'Reported late' : 'Reported'}</StatusChip>;
        if (c.notReportable) return <span className="text-xs text-muted">Not reportable</span>;
        const left = new Date(c.dueAt).getTime() - now;
        return <StatusChip tone={left <= 0 ? 'bad' : left < 2 * 3.6e6 ? 'held' : 'info'} size="sm" icon={<Clock3 className="h-3 w-3" aria-hidden />}>{left <= 0 ? 'Overdue' : `${countdown(c.dueAt, now)} left`}</StatusChip>;
      },
    },
  ];
  const openClocks = incidents.filter((i) => { const c = data?.certIn[i.id]; return c && !c.submittedAt && !c.notReportable; });

  return (
    <div>
      <PageHeader
        kicker="Work"
        title="Incidents"
        description="Every emergency stop, auto-pause, health problem and security incident, with who started it, what was refused while agents were stopped, the CERT-In clock where it applies, and how it ended."
        actions={
          <>
            {canStop && <Button variant="secondary" icon={<HeartPulse className="h-4 w-4" />} loading={checking} onClick={check}>Run health checks</Button>}
            {canStop && <Button variant="secondary" icon={<Megaphone className="h-4 w-4" />} onClick={() => setDeclareOpen(true)}>Declare an incident</Button>}
            <Button variant="secondary" icon={<Siren className="h-4 w-4" />} onClick={() => nav('/alerts')}>Alerts</Button>
            {canStop && (
              <span className="inline-flex" title={data?.stop.active ? 'A stop is already engaged. Only one stop is open at a time.' : 'Pauses agents in one transaction.'}>
                <Button variant="quiet-danger" icon={<OctagonX className="h-4 w-4" />} disabled={!!data?.stop.active} onClick={() => setStopOpen(true)}>Emergency stop</Button>
              </span>
            )}
          </>
        }
      />

      {error && <Banner tone="bad" title="Incidents could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      {loading && !data && <Skeleton className="h-40 mb-6" />}

      {data?.stop.active && (
        <section aria-labelledby="stop-hero" className="mb-6 bg-ink-800 text-paper border border-ink-700 border-t-[3px] border-t-bad">
          <div className="p-5 sm:p-6 grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7 min-w-0">
              <p className="label text-ember flex items-center gap-1.5"><OctagonX className="h-3.5 w-3.5" aria-hidden />Emergency stop engaged</p>
              <h2 id="stop-hero" className="mt-2 text-2xl font-semibold leading-tight text-paper">{data.stop.reason}</h2>
              <p className="mt-2 text-sm text-ink-200">
                Engaged by {userName(data.stop.by)} {data.stop.since && relative(data.stop.since)} — every call from a stopped agent is refused with <span className="font-mono">agent-paused</span> and recorded.
              </p>
              {data.dual && (
                <p className="mt-2 text-sm text-ink-200" aria-live="polite">
                  {data.lift
                    ? <>Lift requested by {userName(data.lift.requestedBy)} {relative(data.lift.requestedAt, now)} — waiting for a second owner or admin to approve.</>
                    : <>Engaging took one person. Lifting needs two: one asks, a different owner or admin approves.</>}
                </p>
              )}
              <div className="mt-5 flex flex-wrap gap-2">
                {canStop && (
                  <Tooltip content={data.dual ? (data.lift ? 'Approve or decline the request, or withdraw it if it is yours.' : 'Checklist, a note and RESUME; then a different owner or admin approves.') : 'Checklist, a note and RESUME. Only the agents the stop paused will resume.'}>
                    <Button variant="inverse" icon={<Play className="h-4 w-4" />} onClick={() => setLiftOpen(true)}>{data.dual ? (data.lift ? (data.lift.requestedBy === user?.id ? 'Lift requested' : 'Approve the lift') : 'Ask to lift the stop') : 'Lift the stop'}</Button>
                  </Tooltip>
                )}
                {stopIncident && (
                  <Button variant="ghost" className="text-paper hover:bg-ink-700 border-ink-600" iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => nav(`/incidents/${stopIncident.id}`)}>Open the incident</Button>
                )}
              </div>
            </div>
            <dl className="lg:col-span-5 grid grid-cols-3 gap-px bg-ink-700 border border-ink-700 self-start">
              <div className="bg-ink-800 p-3">
                <dt className="label text-ink-300">Agents stopped</dt>
                <dd className="mt-1 font-display text-3xl font-semibold num">{n(resumable.length)}</dd>
              </div>
              <div className="bg-ink-800 p-3">
                <dt className="label text-ink-300">Refused since</dt>
                <dd className="mt-1 font-display text-3xl font-semibold num" aria-live="polite">{stopIncident ? n(refusedOf(stopIncident)) : '—'}</dd>
              </div>
              <div className="bg-ink-800 p-3">
                <dt className="label text-ink-300">Approvals waiting</dt>
                <dd className="mt-1 font-display text-3xl font-semibold num">{n(data.pendingNow)}</dd>
              </div>
              <div className="col-span-3 bg-ink-800 px-3 py-2 text-xs text-ink-200">
                Running for {data.stop.since ? duration(data.stop.since, undefined, now) : '—'}. Waiting approvals are held: nobody can decide them until the stop is lifted, and their expiry still runs — <Link to="/approvals" className="underline underline-offset-2 text-paper">see them</Link>.
              </div>
            </dl>
          </div>
        </section>
      )}

      {openClocks.map((i) => {
        const c = data!.certIn[i.id];
        const late = new Date(c.dueAt).getTime() <= now;
        return (
          <Banner key={`ci_${i.id}`} tone="bad" className="mb-4" title={`CERT-In report ${late ? 'overdue' : `due in ${countdown(c.dueAt, now)}`} — ${i.title}`}
            actions={<Button size="sm" variant="secondary" onClick={() => nav(`/incidents/${i.id}`)}>Open the report</Button>}>
            Report within six hours of noticing: due {dateTime(c.dueAt)}. The incident stays open until the submission is recorded.
          </Banner>
        );
      })}

      {activeAutoPause.map((i) => (
        <Banner key={i.id} tone={i.kind === 'health' ? 'bad' : 'held'} className="mb-4" title={`${i.title} — active ${duration(i.startedAt, undefined, now)}`}
          actions={<Button size="sm" variant="secondary" onClick={() => nav(`/incidents/${i.id}`)}>{i.kind === 'health' ? 'Work through the checks' : 'Review and resume'}</Button>}>
          {i.kind === 'health' ? i.reason : <>{i.reason} {i.agentSlugs.join(', ')} stays paused until a person resumes it.</>}
        </Banner>
      ))}

      <Panel title="All incidents" flush>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
          <Segmented
            label="Incident status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All', count: incidents.length },
              { value: 'active', label: 'Active', count: incidents.filter((i) => i.status === 'active').length },
              { value: 'resolved', label: 'Resolved', count: incidents.filter((i) => i.status === 'resolved').length },
            ]}
          />
          <div className="w-[180px]">
            <Select size_="sm" aria-label="Incident kind" value={kind} onChange={(e) => setKind(e.target.value as 'all' | Incident['kind'] | 'security')}>
              <option value="all">All kinds</option>
              <option value="emergency_stop">Emergency stops</option>
              <option value="auto_pause">Auto-pauses</option>
              <option value="health">Health</option>
              <option value="security">Security</option>
            </Select>
          </div>
        </div>
        <DataTable
          className="border-0"
          caption="Incidents"
          columns={columns}
          rows={rows}
          loading={loading}
          rowKey={(i) => i.id}
          onRowClick={(i) => nav(`/incidents/${i.id}`)}
          rowClassName={(i) => (i.status === 'active' ? 'shadow-[inset_3px_0_0_rgb(var(--bad))]' : undefined)}
          empty={
            <EmptyState compact title={incidents.length ? 'No incidents match' : 'No incidents yet'} disc="control-plane">
              {incidents.length ? 'Change the filters to see more.' : 'An incident opens when someone engages the emergency stop, when auto-pause pauses an agent, when Elan1 Govern cannot write a receipt, or when someone declares one.'}
            </EmptyState>
          }
        />
      </Panel>

      <p className="mt-4 text-xs text-muted">Each incident has a PDF report: who stopped and resumed, the timeline, and the receipts from one hour before the start to the resume{atLeast(level, 'l2') ? ', with the timestamps and Merkle batches that cover them' : ''}.</p>
      {/* drills and emergency access are owner and admin tools (emergency access also lives in Organisation › Sessions) */}
      {canStop && (
        <div className="mt-6 grid gap-6 lg:grid-cols-12">
          <Panel className="lg:col-span-6" title="Drills and health" kicker="At every level">
            <p className="text-sm text-muted leading-relaxed">A break in the chain or a receipt the store would not take opens a health incident at every level, L1 included: the guard refuses any call it cannot record. Run a drill to practise the response — the receipt writer is treated as failed for two minutes and the incident opens with its checks.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" icon={<FileX2 className="h-4 w-4" />} loading={drilling} onClick={drill}>Run a write-failure drill</Button>
            </div>
          </Panel>
          <BreakGlassPanel className="lg:col-span-6" compact />
        </div>
      )}

      {!atLeast(level, 'l2') && (
        <UpgradePath className="mt-4" to="l2" what="Health incidents for timestamps, signing keys and write-once storage start at Attested">
          When an authority is unreachable, the KMS key cannot sign or storage stops being write-once, an incident opens with guided checks for that kind of failure. From Attested, lifting the emergency stop also needs a second owner or admin.
        </UpgradePath>
      )}

      <StopDialog open={stopOpen} onClose={() => setStopOpen(false)} />
      <DeclareDialog open={declareOpen} onClose={() => setDeclareOpen(false)} agents={data?.agents ?? []} />
      <Dialog open={liftOpen} onClose={() => setLiftOpen(false)} size="lg" title={data?.dual ? 'Lift the emergency stop — two people' : 'Lift the emergency stop'} description={data?.dual ? 'One owner or admin works through the checks and asks; a different owner or admin approves and types RESUME. Only the agents the stop paused will resume.' : 'Work through the checks, write what you found, and type RESUME. Only the agents the stop paused will resume.'}>
        {data && <LiftStopForm pendingNow={data.pendingNow} resumable={resumable} otherPaused={otherPaused} onDone={() => { setLiftOpen(false); refetch(); }} />}
      </Dialog>
    </div>
  );
}
