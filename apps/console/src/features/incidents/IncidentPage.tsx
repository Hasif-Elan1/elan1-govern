import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileDown, Sparkles, ArrowRight, BookCheck, CheckCircle2, Inbox } from 'lucide-react';
import { api } from '@/api';
import { useQuery, useNow } from '@/hooks/useQuery';
import { useCan, useOrgId, useUser } from '@/store/session';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/cn';
import type { Receipt } from '@/types';
import { dateTime, n, plural } from '@/lib/format';
import {
  PageHeader, Panel, Banner, Button, Stat, DataTable, EmptyState, Skeleton, Timeline, KeyValue, Segmented, DecisionChip, SeverityChip, toast,
  type Column,
} from '@/components/ui';
import { AgentLink, AgentStatus, Person, ReceiptLink, When } from '@/components/domain';
import { KindBadge, IncidentStatusChip, kindLabel, duration, scopeLabel, refusedDuring, incidentReportPdf, startedByName, type ReportEvidence } from './util';
import { downloadBlob } from '@/features/verify/bundle';
import { LiftStopForm, ResolveHealthForm, ResumeAgentForm } from './ResumeFlows';
import { WidenStopForm } from '@/shell/StopDialog';
import { CertInPanel } from './CertInPanel';
import { WriteFailurePanel } from './WriteFailurePanel';
import { userName } from '@/mock/users';
import { HEALTH_META, alerts as loadAlerts, incidentBundle, logIncidentReport } from '@/features/work/backend';

export default function IncidentPage() {
  const { id = '' } = useParams();
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const now = useNow(30_000);
  const openAsk = useUi((s) => s.openAsk);
  // lift, widen and resolve are stop.engage; resuming an auto-paused agent is agents.pause (lib/permissions.ts)
  const canStop = useCan('stop.engage');
  const canPause = useCan('agents.pause');
  const [filter, setFilter] = useState<'all' | 'refuse' | 'admin'>('all');
  const [reporting, setReporting] = useState(false);

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const bundle = await incidentBundle(o, id);
    const incident = bundle.incident;
    const from = new Date(incident.startedAt).getTime() - 3.6e6;
    const to = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() + 1 : undefined;
    const [agents, approvals, windowed, alerts] = await Promise.all([
      api.agents(o), api.approvals(o), api.receipts(o, { from, to }), loadAlerts(o),
    ]);
    const start = new Date(incident.startedAt).getTime();
    const end = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : Date.now();
    const relatedAlerts = alerts.filter((a) => a.id === incident.alertId || (a.agentSlug && incident.agentSlugs.includes(a.agentSlug) && new Date(a.createdAt).getTime() >= start - 864e5 && new Date(a.createdAt).getTime() <= end));
    return {
      incident, agents, relatedAlerts, level: bundle.level,
      receipts: windowed.items.slice().reverse(), // oldest first
      pendingNow: approvals.filter((a) => a.status === 'pending').length,
      isCurrentStop: bundle.stop.active && bundle.stop.incidentId === incident.id,
      orgName: bundle.orgName, keyFingerprint: bundle.keyFingerprint,
      certIn: api.ops.certInOf(o, incident.id),
      lift: api.ops.pendingLift(o),
    };
  }, [id], { kinds: ['receipt', 'incident', 'stop', 'agent', 'alert'] });

  const receipts = data?.receipts ?? [];
  const shown = useMemo(() => {
    const rs = filter === 'refuse' ? receipts.filter((r) => r.decision === 'refuse') : filter === 'admin' ? receipts.filter((r) => r.kind === 'admin' || r.kind === 'approval') : receipts;
    return rs.slice().reverse();
  }, [receipts, filter]);

  if (error) {
    return (
      <div>
        <PageHeader kicker="Work" title="Incident" crumbs={[{ label: 'Incidents', to: '/incidents' }, { label: id }]} />
        <Banner tone="bad" title="This incident could not be opened" actions={<Button size="sm" onClick={() => nav('/incidents')}>Back to incidents</Button>}>{error.message}</Banner>
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-4 w-40 mb-4" />
        <Skeleton className="h-9 w-1/2 mb-8" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[112px]" />)}</div>
        <div className="grid gap-6 lg:grid-cols-12"><Skeleton className="h-80 lg:col-span-8" /><Skeleton className="h-80 lg:col-span-4" /></div>
      </div>
    );
  }

  const { incident: inc, agents } = data;
  const affected = inc.agentSlugs.map((s) => agents.find((a) => a.slug === s)).filter((a): a is NonNullable<typeof a> => !!a);
  const refused = refusedDuring(inc, receipts);
  const active = inc.status === 'active';
  const resumable = agents.filter((a) => a.pausedBy === 'emergency-stop');
  const otherPaused = agents.filter((a) => a.status === 'paused');
  const refusedBy = (slug: string) => receipts.filter((r) => r.agent === slug && r.rule_id === 'agent-paused' && new Date(r.ts) >= new Date(inc.startedAt)).length;
  const autoAgent = inc.kind === 'auto_pause' ? affected[0] : undefined;
  const autoAlert = data.relatedAlerts.find((a) => a.autoPaused) ?? data.relatedAlerts[0];

  const download = async () => {
    setReporting(true);
    try {
      const evidence: ReportEvidence = { level: data.level };
      if (data.level !== 'l1') {
        const lo = receipts[0]?.seq ?? 0;
        const hi = receipts[receipts.length - 1]?.seq ?? 0;
        const [anchors, profiles, custody] = await Promise.all([api.anchors(orgId, 400).catch(() => undefined), api.profiles(orgId).catch(() => []), api.custody(orgId).catch(() => undefined)]);
        evidence.batches = (anchors?.batches ?? []).filter((b) => b.lastSeq >= lo && b.firstSeq <= hi).sort((a, b) => a.firstSeq - b.firstSeq);
        const run = profiles.filter((p) => p.lastRun).sort((a, b) => (b.lastRun!.ranAt).localeCompare(a.lastRun!.ranAt))[0];
        if (run?.lastRun) evidence.profile = { ...run.lastRun, name: run.name };
        evidence.custody = custody ? `${custody.provider}, ${custody.residencyDomain}` : undefined;
      }
      const pdf = incidentReportPdf({
        incident: inc, orgName: data.orgName, agents, receipts, refused, pendingNow: data.pendingNow, generatedBy: user?.name ?? 'a member', keyFingerprint: data.keyFingerprint, evidence,
      });
      downloadBlob(`incident-report-${inc.id}.pdf`, pdf.blob);
      const r = user ? await logIncidentReport(orgId, inc.id, user.id, pdf.rows) : undefined;
      toast.ok('Incident report downloaded', `Saved as a PDF with ${plural(pdf.rows, 'receipt')}.${r ? ` Recorded as receipt #${n(r.seq)}.` : ''}`);
    } catch (e) {
      toast.bad('The report could not be generated', (e as Error).message);
    } finally {
      setReporting(false);
    }
  };

  const timeline = [
    ...inc.timeline.map((t, i) => {
      const lower = t.text.toLowerCase();
      const tone = lower.includes('lifted') || lower.includes('resumed') ? 'ok' as const : i === 0 && inc.kind === 'emergency_stop' ? 'bad' as const : lower.includes('paused') || lower.includes('refused') || lower.includes('raised') ? 'held' as const : 'neutral' as const;
      return {
        time: t.ts ? dateTime(t.ts) : undefined,
        title: t.text,
        tone,
        body: (t.actor || t.seq !== undefined) ? (
          <span className="inline-flex flex-wrap items-center gap-3">
            {t.actor && <Person id={t.actor} size={18} />}
            {t.seq !== undefined && <span className="text-xs">Receipt <ReceiptLink seq={t.seq} /></span>}
          </span>
        ) : undefined,
      };
    }),
    ...(active ? [{ time: undefined, title: `Still active — ${duration(inc.startedAt, undefined, now)} so far`, tone: 'bad' as const, body: inc.kind === 'emergency_stop' ? 'Lift the stop when the checks below are done.' : inc.kind === 'health' ? 'Resolve it when the checks for its kind are done.' : 'Resume the agent when the checks are done.' }] : []),
  ];

  const columns: Column<Receipt>[] = [
    { key: 'seq', header: 'Receipt', width: 96, cell: (r) => <ReceiptLink seq={r.seq} />, sort: (r) => r.seq },
    { key: 'ts', header: 'When', hideBelow: 'sm', cell: (r) => <When iso={r.ts} className="text-muted" />, sort: (r) => r.ts },
    { key: 'who', header: 'Agent or person', cell: (r) => (r.agent && r.kind !== 'admin' ? <AgentLink slug={r.agent} /> : r.actor ? <Person id={r.actor} size={20} /> : <AgentLink slug={r.agent} />) },
    { key: 'what', header: 'Tool or action', hideBelow: 'md', cell: (r) => <span className="font-mono text-[12px]">{r.tool ?? r.action ?? '—'}</span> },
    { key: 'dec', header: 'Decision', cell: (r) => (r.kind === 'admin' ? <span className="text-xs text-muted">Admin</span> : <DecisionChip decision={r.decision} size="sm" />) },
    { key: 'rule', header: 'Rule', hideBelow: 'lg', cell: (r) => (r.rule_id ? <span className="font-mono text-[12px] text-muted">{r.rule_id}</span> : <span className="text-subtle">—</span>) },
  ];

  return (
    <div>
      <PageHeader
        kicker="Work · Incident"
        crumbs={[{ label: 'Incidents', to: '/incidents' }, { label: inc.title }]}
        title={inc.title}
        description={inc.reason}
        meta={
          <>
            <IncidentStatusChip status={inc.status} size="md" />
            <KindBadge kind={inc.kind} subkind={inc.subkind} />
            <span className="text-sm text-muted">{scopeLabel(inc)} · started {dateTime(inc.startedAt)} by {startedByName(inc.startedBy, inc.kind)}</span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => openAsk({ kind: 'incident', title: inc.title, payload: {
              incident: inc, refused, kindLabel: kindLabel(inc.kind, inc.subkind),
              checks: inc.kind !== 'emergency_stop' && inc.subkind && HEALTH_META[inc.subkind] ? HEALTH_META[inc.subkind].checks.map((c) => ({ label: c.label, done: !!inc.checksDone?.includes(c.id) })) : undefined,
              relatedAlerts: data.relatedAlerts.map((x) => ({ id: x.id, title: x.title, severity: x.severity })),
              isCurrentStop: data.isCurrentStop, pendingNow: data.pendingNow,
            } })}>Ask Govern</Button>
            <Button variant="secondary" icon={<FileDown className="h-4 w-4" />} loading={reporting} onClick={download}>Download incident report</Button>
          </>
        }
      />

      {data.isCurrentStop && (
        <Banner tone="bad" className="mb-6" title="This emergency stop is still engaged">
          Every call from a stopped agent is refused and recorded. Work through the guided resume on this page to lift it.
          {data.level !== 'l1' && (data.lift ? <> A lift was requested by {userName(data.lift.requestedBy)} and waits for a second owner or admin.</> : <> At this level a second owner or admin approves the lift.</>)}
        </Banner>
      )}
      {data.certIn && !data.certIn.submittedAt && !data.certIn.notReportable && (
        <Banner tone="bad" className="mb-6" title={new Date(data.certIn.dueAt).getTime() > now ? `CERT-In report due by ${dateTime(data.certIn.dueAt)}` : 'The CERT-In report is overdue'}>
          Six hours from notice ({dateTime(data.certIn.noticedAt)}). Draft and record the submission in the CERT-In panel; the incident stays open until it is recorded.
        </Banner>
      )}

      {inc.kind === 'health' ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6" aria-live="polite">
          <Stat label="Kind" value={<span className="text-xl">{inc.subkind && HEALTH_META[inc.subkind] ? HEALTH_META[inc.subkind].label : 'Health'}</span>} sub={inc.declared ? `Declared by hand${inc.agentSlugs.length ? ` · ${plural(inc.agentSlugs.length, 'agent')} involved` : ''}` : 'No agent is paused by a health incident'} />
          <Stat label="Receipts in the window" value={n(receipts.length)} sub="One hour before the start to now or the resolution" />
          <Stat label="Related alerts" value={n(data.relatedAlerts.length)} sub="From the assurance detectors" to="/alerts" />
          <Stat label="Duration" value={active ? duration(inc.startedAt, undefined, now) : duration(inc.startedAt, inc.resolvedAt)} sub={active ? 'Still active' : `Resolved ${inc.resolvedAt ? dateTime(inc.resolvedAt) : ''}`} />
        </div>
      ) : (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6" aria-live="polite">
        <Stat label="Agents paused" value={n(inc.agentSlugs.length)} sub={inc.scope === 'all_agents' ? 'Every agent that was active' : 'Chosen agents only'} />
        <Stat label="Calls refused while stopped" value={n(refused)} sub={<>Each one a receipt with rule <span className="font-mono">agent-paused</span></>} />
        <Stat label="Approvals waiting at stop" value={n(inc.pendingApprovalsAtStop)} sub={`${n(data.pendingNow)} waiting now`} to="/approvals" />
        <Stat label="Duration" value={active ? duration(inc.startedAt, undefined, now) : duration(inc.startedAt, inc.resolvedAt)} sub={active ? 'Still active' : `Resolved ${inc.resolvedAt ? dateTime(inc.resolvedAt) : ''}`} />
      </div>
      )}

      {inc.kind === 'emergency_stop' && (
        <Banner tone="held" className="mb-6" title={active ? 'Waiting approvals are held by the stop' : 'Waiting approvals were held by the stop'}
          actions={<Button size="sm" variant="secondary" icon={<Inbox className="h-4 w-4" aria-hidden />} onClick={() => nav('/approvals')}>{active ? 'See held approvals' : 'Open approvals'}</Button>}>
          {n(inc.pendingApprovalsAtStop)} {inc.pendingApprovalsAtStop === 1 ? 'approval was' : 'approvals were'} waiting when the stop was engaged. {active
            ? <>Nobody can approve or reject {inc.pendingApprovalsAtStop === 1 ? 'it' : 'them'} until the stop is lifted; their expiry still runs, and an expiry is a refusal.</>
            : <>Nobody could decide {inc.pendingApprovalsAtStop === 1 ? 'it' : 'them'} while the stop was on; any still waiting became decidable when it was lifted.</>}
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7 xl:col-span-8 space-y-6 min-w-0">
          <Panel title="Timeline" kicker="What happened, in order">
            <Timeline items={timeline} />
          </Panel>

          <Panel
            title="Receipts in the incident window"
            flush
            actions={<span className="hidden sm:inline text-xs text-muted">One hour before the start to {inc.resolvedAt ? 'the resume' : 'now'}</span>}
            footer={<span>{plural(receipts.length, 'receipt')} in the window · the report includes up to 300</span>}
          >
            <div className="px-4 py-3 border-b border-line">
              <Segmented size="sm" label="Receipt filter" value={filter} onChange={setFilter} options={[
                { value: 'all', label: 'All', count: receipts.length },
                { value: 'refuse', label: 'Refused', count: receipts.filter((r) => r.decision === 'refuse').length },
                { value: 'admin', label: 'People and approvals', count: receipts.filter((r) => r.kind === 'admin' || r.kind === 'approval').length },
              ]} />
            </div>
            <DataTable
              className="border-0"
              caption="Receipts in the incident window"
              columns={columns}
              rows={shown}
              rowKey={(r) => r.seq}
              maxHeight={520}
              onRowClick={(r) => nav(`/activity/${r.seq}`)}
              empty={<EmptyState compact title="No receipts in this window" disc="registration">Nothing was recorded between one hour before the start and {inc.resolvedAt ? 'the resume' : 'now'}.</EmptyState>}
            />
          </Panel>
        </div>

        <aside className="lg:col-span-5 xl:col-span-4 space-y-6">
          {data.certIn && <CertInPanel key={inc.id} incidentId={inc.id} subkind={inc.subkind} orgName={data.orgName} onChange={refetch} />}
          {inc.subkind === 'receipt_write' && inc.alertId?.startsWith('as_write_') && <WriteFailurePanel key={`wf_${inc.id}`} alertId={inc.alertId} />}
          {/* the guided forms are for owners and admins; every other role reads where the incident stands */}
          {data.isCurrentStop && inc.scope === 'selected_agents' && canStop && (
            <Panel title="Widen the stop" kicker="More agents, or every agent">
              <WidenStopForm onDone={refetch} />
            </Panel>
          )}
          {data.isCurrentStop ? (
            canStop ? (
              <Panel title="Guided resume" kicker="Lift the stop">
                <LiftStopForm pendingNow={data.pendingNow} resumable={resumable} otherPaused={otherPaused} onDone={refetch} />
              </Panel>
            ) : (
              <Panel title="Engaged" kicker="Status">
                <p className="text-sm text-muted leading-relaxed">An owner or admin lifts the stop with the guided resume once the cause is understood. {resumable.length ? `${plural(resumable.length, 'agent')} resume${resumable.length === 1 ? 's' : ''} when it is lifted.` : ''}</p>
              </Panel>
            )
          ) : active && inc.kind === 'auto_pause' && autoAgent ? (
            autoAgent.status === 'paused' ? (
              <Panel title={canPause ? `Resume ${autoAgent.slug}` : `${autoAgent.slug} is paused`} kicker="Auto-pause">
                <p className={cn('text-sm text-muted leading-relaxed', canPause && 'mb-4')}>Auto-pause paused this agent because a high-severity alert fired while its switch was on. It stays paused until {canPause ? 'a person resumes it' : 'an owner or admin resumes it'}.</p>
                {canPause && <ResumeAgentForm agent={autoAgent} alertId={autoAlert?.id} onDone={refetch} />}
              </Panel>
            ) : (
              <Panel title="Agent no longer paused" kicker="Auto-pause">
                <p className="text-sm text-muted">{autoAgent.slug} is {autoAgent.status}. The incident closes when the agent is resumed from here or its page.</p>
              </Panel>
            )
          ) : active && inc.kind !== 'emergency_stop' ? (
            canStop ? (
              <Panel title="Guided resolution" kicker={inc.subkind ? HEALTH_META[inc.subkind].label : 'Health'}>
                <p className="text-sm text-muted mb-4 leading-relaxed">{inc.kind === 'auto_pause' ? 'The agent is no longer paused. Work through the checks to close the incident.' : 'Nothing is paused by a health incident. Work through the checks for its kind, then resolve it; the checks and your note are recorded.'}</p>
                <ResolveHealthForm incident={inc} onDone={refetch} />
              </Panel>
            ) : (
              <Panel title="Open" kicker={inc.subkind ? HEALTH_META[inc.subkind].label : 'Health'}>
                <p className="text-sm text-muted leading-relaxed">An owner or admin works through the checks for its kind and resolves it.</p>
                {inc.subkind && HEALTH_META[inc.subkind] && <ul className="mt-3 text-xs text-muted space-y-0.5">{HEALTH_META[inc.subkind].checks.map((c) => <li key={c.id}>{inc.checksDone?.includes(c.id) ? '✓' : '—'} {c.label}</li>)}</ul>}
              </Panel>
            )
          ) : (
            <Panel title={active ? 'Open' : 'Resolution'} kicker={active ? 'Status' : 'How it ended'}>
              {active ? (
                <p className="text-sm text-muted">Only the current stop can be lifted from the console. <Link to="/incidents" className="link">Incidents</Link></p>
              ) : (
                <div className="space-y-3">
                  <p className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />Resolved {inc.resolvedAt && <When iso={inc.resolvedAt} />}</p>
                  <KeyValue items={[
                    { k: 'Resolved by', v: inc.resolvedBy === 'system' ? <span className="text-sm">Recovered (Elan1 Govern)</span> : <Person id={inc.resolvedBy} size={20} /> },
                    { k: 'Resolved at', v: inc.resolvedAt ? dateTime(inc.resolvedAt) : '—' },
                    { k: 'Duration', v: duration(inc.startedAt, inc.resolvedAt) },
                    ...(inc.kind === 'health' ? [] : [{ k: 'Refused while stopped', v: <span className="num">{n(refused)}</span> }]),
                  ]} />
                  {inc.resolutionNote && <p className="text-sm">“{inc.resolutionNote}”</p>}
                  {inc.checksDone && inc.subkind && <ul className="text-xs text-muted space-y-0.5">{HEALTH_META[inc.subkind].checks.map((c) => <li key={c.id}>{inc.checksDone!.includes(c.id) ? '✓' : '—'} {c.label}</li>)}</ul>}
                  {inc.kind === 'emergency_stop' && <p className="text-xs text-muted">Only the agents the stop paused were resumed. Agents paused for other reasons stayed paused.</p>}
                </div>
              )}
            </Panel>
          )}

          <Panel title="Agents affected" flush footer={<span>Status is as of now; refusals counted from the chain.</span>}>
            {affected.length === 0 ? (
              <EmptyState compact title="No agents recorded" disc="gate">This incident did not pause any agent.</EmptyState>
            ) : (
              <ul className="divide-y divide-line max-h-[420px] overflow-y-auto">
                {affected.map((a) => (
                  <li key={a.slug} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <AgentLink slug={a.slug} className="text-sm" />
                      <p className="mt-0.5 text-xs text-muted num">{plural(refusedBy(a.slug), 'call')} refused in this incident</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <AgentStatus agent={a} />
                      <Link to={`/rulebooks/${a.slug}`} aria-label={`Rulebook for ${a.slug}`} title="Rulebook" className="inline-flex h-7 w-7 items-center justify-center text-muted hover:text-fg hover:bg-sunken"><BookCheck className="h-4 w-4" /></Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Related alerts" flush>
            {data.relatedAlerts.length === 0 ? (
              <EmptyState compact title="No alerts for these agents" disc="aperture">No detector fired for the affected agents in the day before or during this incident.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {data.relatedAlerts.map((a) => (
                  <li key={a.id}>
                    <Link to={`/alerts/${a.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-sunken/60 group">
                      <SeverityChip severity={a.severity} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium line-clamp-2">{a.title}</span>
                        <span className="block text-xs text-muted">{a.agentSlug || 'Assurance health'} · <When iso={a.createdAt} /></span>
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 mt-1 text-subtle group-hover:text-fg" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
