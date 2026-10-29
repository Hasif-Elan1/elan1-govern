import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Building2, CheckCircle2, MapPin, OctagonX, Server, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgLevel, useRole } from '@/store/session';
import { userName } from '@/mock/users';
import { LEGAL_ENTITY } from '@/lib/company';
import { LEVEL_INFO } from '@/lib/levels';
import { verifySig } from '@/lib/crypto';
import { date, dateTime, n, relative } from '@/lib/format';
import { Badge, Banner, Button, CopyButton, EmptyState, PageHeader, Panel, Skeleton, StatusChip, Tabs } from '@/components/ui';
import { industryById } from '@/features/onboarding/industries';
import { OrganisationSection } from '@/features/settings/sections/Organisation';
import { SsoSection } from '@/features/settings/sections/Sso';
import { SessionsSection } from '@/features/settings/sections/Sessions';
import { TabPanel, usePageTitle, useTabParam, word } from './shared';
import { HostingProfilePanel } from '@/features/hosting/HostingProfilePanel';

type TabId = 'organisation' | 'residency' | 'sso' | 'sessions';
const TABS = ['organisation', 'residency', 'sso', 'sessions'] as const;

async function loadTenant(orgId: string) {
  const [evidence, agents, members, incidents, today, level, dep] = await Promise.all([
    api.evidence(orgId), api.agents(orgId), api.members(orgId), api.incidents(orgId), api.today(orgId), api.level(orgId), api.deployment(orgId),
  ]);
  const activeKey = evidence.signingKeys.find((k) => k.status === 'active');
  const lastStop = incidents.filter((i) => i.kind === 'emergency_stop').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return {
    org: evidence.org, activeKey, stop: today.stop, lastStop, level, dep,
    agents: agents.length, activeAgents: agents.filter((a) => a.status === 'active').length,
    members: members.filter((m) => m.status === 'active').length,
  };
}

/**
 * Organisation — the tenant every actor acts on behalf of: its record, its assurance level and where it
 * runs, where its data lives, how people sign in and the sessions open against it.
 */
export default function OrganisationPage() {
  usePageTitle('Organisation');
  const role = useRole();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const orgLevel = useOrgLevel();
  const [tab, setTab] = useTabParam<TabId>(TABS);
  const { data, loading, error, refetch } = useQuery(loadTenant, [], { kinds: ['org', 'key', 'stop', 'incident', 'agent', 'member', 'deployment'] });
  const owner = role === 'owner';
  const l2Boundary = data?.level.boundaries.find((b) => b.to === 'l2' || (b.from === 'l1' && b.to !== 'l1'));
  const sov = data?.dep.mode === 'sovereign';
  const appliedVersion = data?.dep.updates.filter((u) => u.status === 'applied').sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))[0]?.version;

  return (
    <div className="overflow-x-clip">
      <PageHeader kicker="Agents" title="Organisation" description={`The organisation every actor acts on behalf of. Every agent, person and receipt belongs to exactly one organisation, and its signing key ${orgLevel === 'l1' ? 'seals' : 'signs'} the record.`} />

      {error && <Banner tone="bad" className="mb-6" title="The organisation could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      <Panel className="mb-8" flush
        title={<span className="inline-flex items-center gap-2"><Building2 className="h-4 w-4 text-muted" aria-hidden />{data?.org.name ?? 'Organisation'}</span>}
        actions={data && <Badge tone="inverse">{LEVEL_INFO[data.level.level].label}</Badge>}>
        {loading && !data ? <div className="p-5 grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div> : data && (
          <>
            <div className="grid md:grid-cols-3">
              <Cell label="The tenant">
                <Row k="Legal entity">{data.org.name}</Row>
                <Row k="Organisation id"><span className="inline-flex items-center gap-1 font-mono text-[12.5px]">{data.org.id}<CopyButton text={data.org.id} compact label="Copy organisation id" /></span></Row>
                <Row k="Industry">{industryById(data.org.industry).label}</Row>
                <Row k="Since">{date(data.org.createdAt)}</Row>
              </Cell>
              <Cell label="Where it runs">
                <Row k="Deployment">{sov ? 'Sovereign — your infrastructure' : 'Hosted by elan1'}</Row>
                <Row k="Residency domain">{data.level.residency}</Row>
                <Row k="Regions (frameworks)"><span className="inline-flex flex-wrap justify-end gap-1">{data.org.regions.map((r) => <Badge key={r} tone="neutral">{r}</Badge>)}</span></Row>
                <p className="mt-2 text-xs text-muted">Time zone {data.org.timezone} · currency {data.org.currency}</p>
                <Link to="/agents/deployment" className="mt-2 inline-flex items-center gap-1 text-sm link">Deployment<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
              </Cell>
              <Cell label="Who acts for it">
                <Row k="Agents"><Link to="/agents" className="link num">{n(data.activeAgents)} active of {n(data.agents)}</Link></Row>
                <Row k="People"><Link to="/agents/people" className="link num">{n(data.members)} {word(data.members, 'member')}</Link></Row>
                <Row k="Signing key"><Link to="/agents/keys?tab=custody" className="link font-mono text-[12.5px]">{data.activeKey?.kid ?? '—'}</Link></Row>
                <p className="mt-1 flex items-center gap-1 font-mono text-[11.5px] text-muted break-all">{data.org.keyFingerprint || '—'}{data.org.keyFingerprint && <CopyButton text={data.org.keyFingerprint} compact label="Copy fingerprint" />}</p>
              </Cell>
            </div>

            <div className="grid gap-4 border-t border-line px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2"><span className="label">Assurance level</span><span className="font-semibold">{LEVEL_INFO[data.level.level].label}</span><span className="text-sm text-muted">since {date(data.level.since)}</span></p>
                <p className="mt-1 text-sm text-muted">
                  {data.level.history.map((h, i) => <span key={h.from}>{i > 0 && ' → '}{LEVEL_INFO[h.level].short} {date(h.from)}{h.by && ` (${userName(h.by)})`}</span>)}
                </p>
                {l2Boundary && (
                  <p className="mt-1 text-sm">
                    <span className="font-medium">L1 → L2 boundary {dateTime(l2Boundary.at)}</span>
                    {l2Boundary.firstSeq !== undefined && <> at receipt <Link to={`/activity/${l2Boundary.firstSeq}`} className="link num">#{n(l2Boundary.firstSeq)}</Link></>}:
                    <span className="num"> {n(l2Boundary.recordsBefore)}</span> L1 {word(l2Boundary.recordsBefore, 'record')} before (sealed in a hash chain, no Seal v6) ·
                    <span className="num"> {n(l2Boundary.recordsAfter)}</span> Seal v6 {word(l2Boundary.recordsAfter, 'record')} after{l2Boundary.beforeWindow && ' (the boundary is before the oldest receipt held here)'}.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to="/assurance/levels" className="inline-flex items-center gap-1 h-9 px-3 border border-line-strong/70 bg-surface text-sm font-medium hover:border-fg">Assurance levels</Link>
                {/* changing the plan is the owner's alone: admins see the level and Assurance levels, not an upgrade */}
                {data.level.next && owner && (
                  <Link to={`/assurance/upgrade?to=${data.level.next}`} className="inline-flex items-center gap-1 h-9 px-3 border border-fg bg-fg text-canvas text-sm font-medium hover:bg-fg/90">
                    Change level<ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                )}
              </div>
            </div>

            {sov && (
              <div className="border-t border-line px-5 py-4">
                <p className="label mb-2 inline-flex items-center gap-1.5"><Server className="h-3.5 w-3.5" aria-hidden />Sovereign deployment</p>
                <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                  <Row k="Cluster">{data.dep.cluster.name} · {data.dep.cluster.distribution} {data.dep.cluster.version}</Row>
                  <Row k="Database">{data.dep.database.engine}{data.dep.database.rowLevelSecurity && ', row-level security on'}</Row>
                  <Row k="Secrets">{data.dep.secrets.backend} {data.dep.secrets.version}</Row>
                  <Row k="Object-lock store">{data.dep.storage.backend} ({data.dep.storage.objectLock}, {data.dep.storage.retentionYears} y)</Row>
                  <Row k="Timestamp authorities">{data.dep.tsa.map((t) => t.name).join(' · ')}</Row>
                  <Row k="HSM">{data.dep.hsm.provider}</Row>
                  <Row k="Update bundle">{appliedVersion ?? '—'}</Row>
                  <Row k="Telemetry egress">{data.dep.egress.telemetry === 'none' ? 'Off — egress denied by default' : data.dep.egress.telemetry}</Row>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 border-t border-line px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-wrap items-center gap-3 min-w-0">
                <span className="label">Emergency stop</span>
                {data.stop.active ? <StatusChip tone="bad" icon={<OctagonX className="h-3.5 w-3.5" aria-hidden />}>Engaged</StatusChip> : <StatusChip tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>Not engaged</StatusChip>}
                <span className="text-sm text-muted">
                  {data.stop.active ? <>By {userName(data.stop.by)}{data.stop.since && <> {relative(data.stop.since)}</>}. Every new agent call is refused and recorded.</>
                    : data.lastStop ? <>Last used {relative(data.lastStop.startedAt)}: {data.lastStop.title.toLowerCase()}.</> : 'Never used in this organisation.'}
                </span>
              </div>
              <Link to={data.stop.active && data.stop.incidentId ? `/incidents/${data.stop.incidentId}` : '/incidents'} className="inline-flex items-center gap-1 text-sm font-medium link whitespace-nowrap">
                {data.stop.active ? 'Open the incident' : 'Incidents'}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
          </>
        )}
      </Panel>

      <Tabs<TabId> label="Organisation settings" value={tab} onChange={setTab}
        items={[{ value: 'organisation', label: 'Organisation' }, { value: 'residency', label: 'Residency' }, { value: 'sso', label: 'Single sign-on' }, { value: 'sessions', label: 'Sessions' }]} />
      {tab === 'organisation' && <TabPanel label="Organisation"><OrganisationSection /></TabPanel>}
      {tab === 'residency' && <TabPanel label="Residency"><ResidencyTab /></TabPanel>}
      {tab === 'sso' && <TabPanel label="Single sign-on"><SsoSection /></TabPanel>}
      {tab === 'sessions' && <TabPanel label="Sessions"><SessionsSection /></TabPanel>}

      <p className="mt-10 border-t border-line pt-4 text-xs text-muted">
        Elan1 Govern is provided by {LEGAL_ENTITY}. The emergency stop is engaged from the top bar by owners and admins and is written to the chain as a receipt.
      </p>
    </div>
  );
}

/* ── Residency ──────────────────────────────────────────────────────────── */

function ResidencyTab() {
  const { data: r, loading, error, refetch } = useQuery((o) => api.residency(o), [], { kinds: ['deployment', 'key', 'org'] });
  const { data: ev } = useQuery((o) => api.evidence(o), [], { kinds: ['key'] });
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signedLevel = useOrgLevel() !== 'l1';
  if (error) return <Banner tone="bad" title="Residency could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (loading || !r) return <Skeleton className="h-80" />;
  const pub = ev?.publicKeys[r.proof.kid];
  const sigOk = pub ? verifySig(r.proof.digest, r.proof.sig, pub) : undefined;
  return (
    <div className="grid gap-6 xl:grid-cols-12">
      <div className="xl:col-span-8 space-y-6 min-w-0">
        <HostingProfilePanel />
        <Panel title={<span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4" aria-hidden />{r.domain}</span>} actions={<Badge tone="inverse">{r.deployment === 'sovereign' ? 'Your infrastructure' : 'Hosted by elan1'}</Badge>} flush
          footer="Each store is placed in the residency domain when the organisation is created or moved, and the signing key is held in the same domain.">
          {r.stores.length === 0 ? <EmptyState compact title="No stores listed">The deployment did not report its stores.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <caption className="sr-only">Where each store is held</caption>
                <thead className="bg-sunken/80"><tr className="border-b border-line">{['Store', 'Where', 'Provider', 'Holds'].map((h) => <th key={h} scope="col" className="h-10 px-4 text-left label font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {r.stores.map((s) => (
                    <tr key={s.name} className="border-b border-line last:border-b-0">
                      <th scope="row" className="px-4 py-2.5 text-left font-medium">{s.name}</th>
                      <td className="px-4 py-2.5">{s.location}</td>
                      <td className="px-4 py-2.5">{s.provider}</td>
                      <td className="px-4 py-2.5 text-muted">{s.holds}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Cross-border transfers" actions={r.crossBorder.allowed ? <StatusChip tone="held" size="sm">Allowed</StatusChip> : <StatusChip tone="ok" size="sm" icon={<ShieldCheck className="h-3 w-3" />}>Not allowed</StatusChip>}>
          <p className="text-sm"><span className="font-display text-2xl font-semibold num">{n(r.crossBorder.transfers30d)}</span> <span className="text-muted">transfers out of the domain in 30 days</span></p>
          <p className="mt-2 text-sm text-muted">{r.crossBorder.note}</p>
        </Panel>
      </div>
      <div className="xl:col-span-4 space-y-6 min-w-0">
        <Panel title="Residency statement" actions={sigOk === undefined ? undefined : sigOk ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>{signedLevel ? 'Signature verifies' : 'Seal verifies'}</StatusChip> : <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>Does not verify</StatusChip>}>
          <p className="text-sm">{r.proof.statement}</p>
          <dl className="mt-4 space-y-2 text-xs">
            <div><dt className="label">SHA-256</dt><dd className="mt-0.5 font-mono break-all flex items-start gap-1">{r.proof.digest}<CopyButton text={r.proof.digest} compact label="Copy digest" /></dd></div>
            <div><dt className="label">{signedLevel ? 'Signed with' : 'Sealed with'}</dt><dd className="mt-0.5 font-mono">{r.proof.kid} · {dateTime(r.proof.signedAt)}</dd></div>
            <div><dt className="label">{signedLevel ? 'Ed25519 signature' : 'Ed25519 seal'}</dt><dd className="mt-0.5 font-mono break-all">{r.proof.sig.slice(0, 48)}…</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted">Checked in this browser against the organisation’s published public key. Hand it to a customer or regulator with the public key; they can check it offline.</p>
        </Panel>
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b md:border-b-0 md:border-r last:border-r-0 last:border-b-0 border-line p-5 min-w-0">
      <p className="label mb-2">{label}</p>
      {children}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm min-w-0">
      <span className="text-muted shrink-0">{k}</span>
      <span className="text-right min-w-0 break-words">{children}</span>
    </div>
  );
}
