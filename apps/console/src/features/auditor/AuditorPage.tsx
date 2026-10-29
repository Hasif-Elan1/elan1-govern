import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, Check, ClipboardList, FileJson, FileSpreadsheet, Link2, OctagonX, PackageOpen, RefreshCw, ShieldCheck, Shuffle, Upload, Waypoints } from 'lucide-react';
import { api } from '@/api';
import { useCan, useOrgAccess, useOrgId, useRole, useSession, useUser, type OrgAccess } from '@/store/session';
import { useQuery } from '@/hooks/useQuery';
import type { CrossOrgReceipt, Org, Receipt } from '@/types';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { date, dateTime, n, pct, plural, relative, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { Badge, Banner, Button, Checkbox, DataTable, DecisionChip, Dialog, EmptyState, Field, Input, LegalDraft, Meter, PageHeader, Panel, Select, Skeleton, StatusChip, toast, type Column } from '@/components/ui';
import { AgentLink, Person, ReceiptLink } from '@/components/domain';
import { KindMark, downloadText, toCsv } from '@/features/activity/shared';
import { verifyReceipt, type CheckLine, type L2Context, type ReceiptVerification, type Verdict } from '@/features/activity/verify';
import { CheckList, CodeChip, SectionChip, SixCodeRunner, VERDICT_META, VerdictLine } from '@/features/activity/VerifyResult';
import { claimFor, CUSTODY_MODE_LABEL, levelOfReceipt } from '@/features/activity/assurance';
import { LevelTag, UpgradeHint } from '@/features/activity/UpgradeHint';
import type { SixCodeResult } from '@/features/activity/bundle';
import { POPULATIONS, drawSample, emptyPapers, papersApi, type L2Summary, type Population, type WorkingPapers } from './sampling';
import { INDUSTRY_LABEL, checkCrossOrg, loadStanding, type ClientStanding } from './standing';
import { EvidenceRequestsPanel } from './EvidenceRequests';

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

type StandingState = { data?: ClientStanding; error?: string; loading: boolean };

export default function AuditorPage() {
  const user = useUser();
  const role = useRole();
  const orgId = useOrgId();
  const switchOrg = useSession((s) => s.switchOrg);
  const nav = useNavigate();
  const canExport = useCan('evidence.export');
  const orgs = useMemo(() => api.orgs(user?.orgIds ?? [orgId]), [user, orgId]);
  const [standing, setStanding] = useState<Record<string, StandingState>>({});
  // suspension and removal are per organisation: a closed client shows no standing and cannot be opened
  const access = useOrgAccess(orgs.map((o) => o.id));
  const openIds = orgs.filter((o) => access[o.id] === 'active').map((o) => o.id).join(',');

  const load = useCallback((id: string) => {
    setStanding((s) => ({ ...s, [id]: { ...s[id], loading: true, error: undefined } }));
    loadStanding(id)
      .then((d) => setStanding((s) => ({ ...s, [id]: { data: d, loading: false } })))
      .catch((e: Error) => setStanding((s) => ({ ...s, [id]: { ...s[id], loading: false, error: e.message } })));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ids = openIds ? openIds.split(',') : [];
    // drop anything already loaded for a client that is no longer open
    setStanding((s) => Object.fromEntries(Object.entries(s).filter(([id]) => ids.includes(id))));
    const timers = ids.map((id, i) => window.setTimeout(() => { if (!cancelled) load(id); }, 40 + i * 80));
    return () => { cancelled = true; timers.forEach((t) => window.clearTimeout(t)); };
  }, [openIds, load]);

  const open = (o: Org) => {
    if (o.id === orgId) return;
    if (switchOrg(o.id) === false) return; // refused: switchOrg already said why
    toast.info(`Now reviewing ${o.name}`, 'Activity, evidence and the sample below now show this organisation.');
  };

  const current = orgs.find((o) => o.id === orgId) ?? api.org(orgId);
  const currentLevel = standing[orgId]?.data?.level.level ?? api.levelOf(orgId);
  const byLevel = useMemo(() => [...orgs].sort((a, b) => levelRank(a.plan) - levelRank(b.plan)), [orgs]);

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Auditor workspace"
        description="Your client organisations and their standing, a reproducible sample of receipts verified in this browser, verifier profiles and counterparty receipts, and working papers you can hand on."
        meta={user && <span className="inline-flex items-center gap-2 text-sm text-muted"><Person id={user.id} size={22} showTitle /></span>}
        actions={
          <>
            <Button variant="secondary" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => nav('/verify')}>Verify a bundle</Button>
            {canExport && <Button variant="primary" icon={<PackageOpen className="h-4 w-4" />} onClick={() => nav('/evidence?export=1')}>{levelRank(currentLevel) >= 1 ? 'Export evidence bundle' : 'Export auditor pack'}</Button>}
          </>
        }
      />

      {role === 'auditor' ? (
        <Banner tone="info" title="You cannot change the client’s records." className="mb-6">
          Checks and samples you run here are not written to the client’s chain. What you ask of the client is: every bundle or pack you export, every evidence request you make or withdraw, and every one you collect is a receipt on their chain.
        </Banner>
      ) : (
        <Banner tone="neutral" title="Built for external auditors" className="mb-6">You are seeing it with your own role’s permissions. Auditors can read across their client organisations and ask them for evidence, which is recorded on the client’s chain; they cannot change a record.</Banner>
      )}

      <section aria-label="Client organisations" className="mb-8">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
          <div><p className="label mb-1">Clients</p><h2 className="text-xl font-semibold">{plural(orgs.filter((o) => access[o.id] === 'active').length, 'organisation')} you can review</h2>{orgs.some((o) => access[o.id] && access[o.id] !== 'active') && <p className="text-sm text-muted mt-0.5">{plural(orgs.filter((o) => access[o.id] && access[o.id] !== 'active').length, 'client')} closed to you: access there is suspended or ended.</p>}</div>
          <span className="text-xs text-muted">Coverage is a count of receipts, not a test that a control works.</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {byLevel.map((o) => (
            <ClientCard key={o.id} org={o} st={standing[o.id]} access={access[o.id] ?? 'active'} current={o.id === orgId} onOpen={() => open(o)} onRetry={() => load(o.id)} />
          ))}
        </div>
      </section>

      <section aria-label="Evidence requests" className="mb-8">
        <EvidenceRequestsPanel key={orgId} mode={role === 'auditor' ? 'auditor' : 'org'} compact={role !== 'auditor'} />
      </section>

      <SamplingTool key={`${orgId}:${user?.id}`} orgId={orgId} orgName={current.name} orgSlug={current.slug} orgDomain={current.domain} />
    </div>
  );
}

/* ── Client card ──────────────────────────────────────────── */

function StandingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 py-1.5 border-b border-line last:border-b-0 text-sm min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function ClientCard({ org, st, access, current, onOpen, onRetry }: { org: Org; st?: StandingState; access: OrgAccess; current: boolean; onOpen: () => void; onRetry: () => void }) {
  const nav = useNavigate();
  if (access !== 'active') {
    const suspended = access === 'suspended';
    return (
      <article className="border border-line bg-sunken/40 flex flex-col min-w-0" aria-label={`${org.name}: ${suspended ? 'access suspended' : 'no longer a client'}`}>
        <div className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-display text-lg font-semibold text-muted"><Building2 className="h-4 w-4 shrink-0" aria-hidden /><span className="truncate">{org.name}</span></p>
            <p className="text-xs text-muted mt-0.5">{INDUSTRY_LABEL[org.industry]} · {org.regions.join(', ')}</p>
          </div>
          <StatusChip tone="held" size="sm">{suspended ? 'Suspended' : 'Access ended'}</StatusChip>
        </div>
        <div className="mx-5 my-4">
          <Banner tone="neutral" title={suspended ? `Your access to ${org.name} is suspended` : `You are no longer a member of ${org.name}`}>
            {suspended
              ? `Its standing, coverage, refusals and chain are not shown and it cannot be opened while you are suspended there. Your other clients are unaffected. An owner or admin at ${org.name} can reinstate you under People and roles.`
              : `Its records are no longer open to you. Your other clients are unaffected. An owner or admin at ${org.name} can invite you again.`}
          </Banner>
        </div>
      </article>
    );
  }
  const s = st?.data;
  const lv = s?.level.level ?? org.plan;
  const boundary = s?.level.boundaries.filter((b) => !b.beforeWindow).slice(-1)[0];
  return (
    <article className={cn('border bg-surface flex flex-col min-w-0', current ? 'border-fg shadow-[0_0_0_1px_rgb(var(--fg))]' : 'border-line')}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-display text-lg font-semibold"><Building2 className="h-4 w-4 text-muted shrink-0" aria-hidden /><span className="truncate">{org.name}</span></p>
          <p className="text-xs text-muted mt-0.5">{INDUSTRY_LABEL[org.industry]} · {org.regions.join(', ')} · client since {date(org.createdAt)}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <LevelTag level={lv} />
          {current && <Badge tone="inverse">Reviewing</Badge>}
        </div>
      </div>
      <p className="px-5 mt-2 text-sm"><span className="font-medium">{LEVEL_INFO[lv].label}</span>{s && <span className="text-muted"> since {date(s.level.since)}{s.level.deployment === 'sovereign' ? ` · ${s.level.residency}` : ''}</span>}</p>
      {st?.error ? (
        <div className="mx-5 mt-4"><Banner tone="bad" title="Standing could not be loaded" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>{st.error}</Banner></div>
      ) : !s ? (
        <div className="mx-5 mt-4"><Skeleton className="h-[260px]" /></div>
      ) : (
        <>
          <dl className="mx-5 mt-3 grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border border-line text-sm">
            <div className="bg-surface p-3"><dt className="label">Receipts</dt><dd className="mt-1 font-display text-xl font-semibold num">{n(s.receipts)}</dd></div>
            <div className="bg-surface p-3"><dt className="label">Refusals</dt><dd className="mt-1 font-display text-xl font-semibold num">{n(s.refusals)}</dd></div>
            <div className="bg-surface p-3"><dt className="label">Controls</dt><dd className="mt-1 font-display text-xl font-semibold num">{s.controls.evidenced}<span className="text-sm text-muted font-normal"> / {s.controls.total}</span></dd></div>
            <div className="bg-surface p-3"><dt className="label">Coverage</dt><dd className="mt-1 font-display text-xl font-semibold num">{pct(s.coverage.share)}</dd><dd className="mt-1"><Meter value={s.coverage.share} label={`Average coverage across ${s.coverage.frameworks} frameworks`} /></dd></div>
          </dl>
          <dl className="mx-5 mt-3">
            <StandingRow label="Chain">{s.head ? <><Link to={`/activity/${s.head.seq}`} onClick={(e) => { if (!current) { e.preventDefault(); onOpen(); } }} className="font-mono hover:underline underline-offset-2">{seqLabel(s.head.seq)}</Link> <span className="text-muted">head, {relative(s.head.ts)} · {s.lastCpAt ? `checkpoint ${relative(s.lastCpAt)}, ${n(s.sinceCheckpoint)} since` : 'no checkpoint yet'}</span></> : <span className="text-muted">No receipts yet.</span>}</StandingRow>
            <StandingRow label="Boundary">{boundary ? <span>{LEVEL_INFO[boundary.from].short} → {LEVEL_INFO[boundary.to].short} on {date(boundary.at)}: <span className="num">{n(boundary.recordsBefore)}</span> before, <span className="num">{n(boundary.recordsAfter)}</span> after</span> : <span className="text-muted">Every receipt held was written at {LEVEL_INFO[lv].short}.</span>}</StandingRow>
            <StandingRow label="Anchors">{s.anchors ? <span>{n(s.anchors.batches)} batches · {s.anchors.unanchored ? `${n(s.anchors.unanchored)} waiting` : 'nothing waiting'} · {Math.round(s.anchors.withinTargetPct * 100)}% within 15 min<span className="block text-xs text-muted truncate">{s.anchors.authorities.join(' and ')}</span></span> : <span className="text-muted">Not timestamped — L1 records are sealed in a hash chain by Elan1 Govern.</span>}</StandingRow>
            <StandingRow label="Custody"><span>{s.custody.provider}</span><span className="block text-xs text-muted">{CUSTODY_MODE_LABEL[s.custody.mode]} · {s.custody.residencyDomain}{s.custody.quorum ? ` · quorum ${s.custody.quorum.required} of ${s.custody.quorum.of}` : ''}</span></StandingRow>
            <StandingRow label="Profiles">{s.profiles ? <span>{n(s.profiles.available)} available{s.profiles.viaPack ? `, ${s.profiles.viaPack} via installed packs` : ''}{s.profiles.lastRun && <span className="block text-xs text-muted">Last run: {s.profiles.lastRun.name} — {s.profiles.lastRun.result === 'pass' ? 'pass' : 'fail'}, {relative(s.profiles.lastRun.ranAt)}</span>}</span> : <span className="text-muted">Not part of this client’s plan.</span>}</StandingRow>
            {s.crossOrg && <StandingRow label="Counterparties"><span>{n(s.crossOrg.issued)} issued · {n(s.crossOrg.received)} received</span></StandingRow>}
          </dl>
        </>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <span className="text-xs text-muted">{s ? `${n(s.agents)} agents · ${n(s.pending)} held calls waiting` : st?.loading ? 'Loading…' : ''}</span>
        {current ? <Button size="sm" variant="ghost" iconRight={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => nav('/evidence')}>Proof</Button>
          : <Button size="sm" variant="primary" iconRight={<ArrowRight className="h-3.5 w-3.5" />} onClick={onOpen}>Open</Button>}
      </div>
    </article>
  );
}

/* ── Sampling ─────────────────────────────────────────────── */

interface ChainCtx {
  receipts: Receipt[];
  bySeq: Map<number, Receipt>;
  publicKeys: Record<string, string>;
  checkpoints: import('@/types').Checkpoint[];
  signingKeys: import('@/types').SigningKey[];
  state: import('@/types').LevelState;
  authorities: import('@/types').TsaAuthority[];
}

const l2Summary = (checks: CheckLine[]): L2Summary | undefined => {
  const l2 = checks.filter((c) => c.level === 'l2');
  if (!l2.length) return undefined;
  const by = (p: (c: CheckLine) => boolean) => l2.find(p)?.state ?? 'skip';
  const ts = l2.filter((c) => c.label.startsWith('Timestamp —'));
  return {
    seal: by((c) => c.label.startsWith('Sealed')),
    timestamps: ts.some((c) => c.state === 'fail') ? 'fail' : ts.every((c) => c.state === 'pass') ? 'pass' : 'skip',
    within15: by((c) => c.label.startsWith('Timestamps within')),
    inclusion: by((c) => c.label.startsWith('Merkle')),
  };
};

function SamplingTool({ orgId, orgName, orgSlug, orgDomain }: { orgId: string; orgName: string; orgSlug: string; orgDomain?: string }) {
  const user = useUser();
  const nav = useNavigate();
  const auditorId = user?.id ?? 'anonymous';
  const chain = useQuery<ChainCtx>(async (o) => {
    const slice = api.chainSlice(o);
    const [ev, state, anchors] = await Promise.all([api.evidence(o), api.level(o), api.anchors(o, 1)]);
    return { receipts: slice.receipts, bySeq: new Map(slice.receipts.map((r) => [r.seq, r])), publicKeys: slice.publicKeys, checkpoints: slice.checkpoints, signingKeys: ev.signingKeys, state, authorities: [...anchors.authorities, ...(anchors.previousAuthorities ?? [])] };
  }, [], { kinds: ['receipt', 'checkpoint', 'key', 'level'] });
  const c = chain.data;
  const first = c?.receipts[0]?.seq ?? 0;
  const head = c?.receipts[c.receipts.length - 1]?.seq ?? 0;
  const level = c?.state.level ?? api.levelOf(orgId);
  const l2 = levelRank(level) >= 1;
  const l3 = levelRank(level) >= 2;

  const [papers, setPapers] = useState<WorkingPapers>(() => emptyPapers(auditorId, orgId));
  const [papersLoaded, setPapersLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    papersApi.get(auditorId, orgId).then((p) => { if (live) { setPapers(p); setPapersLoaded(true); } });
    return () => { live = false; };
  }, [auditorId, orgId]);
  const update = useCallback((next: WorkingPapers | ((p: WorkingPapers) => WorkingPapers)) => {
    setPapers((p) => papersApi.save(typeof next === 'function' ? next(p) : next));
  }, []);

  const [stale, setStale] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [size, setSize] = useState('25');
  const [seed, setSeed] = useState(`${orgSlug}-${today()}`);
  const [population, setPopulation] = useState<Population>('all');
  const [detail, setDetail] = useState<{ seq: number; v: ReceiptVerification; level: import('@/types').LevelId; anchored?: boolean }>();
  const [verifying, setVerifying] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // fill the form from the papers (or the chain) once both are loaded
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || !c || !papersLoaded) return;
    filled.current = true;
    setFrom(String(papers.config?.from ?? first));
    setTo(String(papers.config?.to ?? head));
    if (papers.config) { setSize(String(papers.config.size)); setSeed(papers.config.seed); setPopulation(papers.config.population); }
    // a regenerated demo chain re-uses sequence numbers; drop a sample whose hashes no longer match
    if (papers.sample.some((s) => c.bySeq.get(s.seq)?.hash !== s.hash)) { setStale(true); update((p) => ({ ...p, sample: [], results: {}, reviews: {}, l2: {} })); }
  }, [c, papersLoaded, papers, first, head, update]);

  const f = Number(from.replace(/[#,\s]/g, ''));
  const t = Number(to.replace(/[#,\s]/g, ''));
  const k = Number(size);
  const err = !c ? undefined : !c.receipts.length ? 'This client has no receipts yet.' : !f || !t ? 'Enter a sequence range.' : f > t ? 'The first number must not be after the last.' : t < first || f > head ? `The chain runs from ${seqLabel(first)} to ${seqLabel(head)}.` : !k || k < 1 || k > 500 ? 'Sample between 1 and 500 receipts.' : !seed.trim() ? 'Enter a seed.' : undefined;
  const poolSize = useMemo(() => {
    if (err || !c) return 0;
    const test = POPULATIONS.find((p) => p.value === population)!.test;
    return c.receipts.filter((r) => r.seq >= f && r.seq <= t && test(r)).length;
  }, [f, t, population, err, c]);

  const draw = () => {
    if (err || !c) return;
    const cfg = { from: f, to: t, size: k, seed: seed.trim(), population };
    const { picked, population: pop } = drawSample(c.receipts, cfg);
    setStale(false);
    update((p) => ({ ...p, config: cfg, drawnAt: new Date().toISOString(), sample: picked.map((r) => ({ seq: r.seq, hash: r.hash })), population: pop, reviews: {}, results: {}, l2: {} }));
    toast.ok(`Drew ${plural(picked.length, 'receipt')}`, `From ${plural(pop, 'receipt')} in ${seqLabel(f)}–${seqLabel(t)} with seed “${cfg.seed}”.`);
  };

  const rows = useMemo(() => (c ? papers.sample.map((s) => c.bySeq.get(s.seq)).filter((r, i): r is Receipt => !!r && r.hash === papers.sample[i].hash) : []), [papers.sample, c]);

  const verifyOne = async (r: Receipt): Promise<{ v: ReceiptVerification; level: import('@/types').LevelId; anchored?: boolean }> => {
    if (!c) throw new Error('The chain is not loaded yet.');
    const cp = c.checkpoints.find((x) => x.seq >= r.seq);
    const lv = levelOfReceipt(r, c.state.history, c.state.level);
    let l2ctx: L2Context | undefined = { level: lv, l2Since: c.state.history.find((h) => levelRank(h.level) >= 1)?.from, authorities: c.authorities };
    if (levelRank(lv) >= 1) {
      const sv = await api.seal(orgId, r.seq);
      let proofError: string | undefined;
      const proof = sv.sealed ? await api.inclusionProof(orgId, r.seq).catch((e: Error) => { proofError = e.message; return undefined; }) : undefined;
      l2ctx = { ...l2ctx, seal: sv.sealed ? sv.seal : undefined, proof, proofError };
    }
    const between = cp ? c.receipts.filter((x) => x.seq > r.seq && x.seq <= cp.seq) : undefined;
    const v = verifyReceipt(r, { publicKeys: c.publicKeys, prev: c.bySeq.get(r.seq - 1), signingKeys: c.signingKeys, checkpoint: cp, between, l2: l2 ? l2ctx : undefined });
    return { v, level: lv, anchored: levelRank(lv) >= 1 ? !!l2ctx?.proof : undefined };
  };

  const verifyRow = async (r: Receipt) => {
    try {
      const res = await verifyOne(r);
      const sum = l2Summary(res.v.checks);
      update((p) => ({ ...p, results: { ...p.results, [r.seq]: res.v.verdict }, l2: sum ? { ...p.l2, [r.seq]: sum } : p.l2 }));
      setDetail({ seq: r.seq, ...res });
    } catch (e) { toast.bad('Not verified', (e as Error).message); }
  };

  const verifyAll = async () => {
    setVerifying(true);
    const results: Record<number, Verdict> = {};
    const sums: Record<number, L2Summary> = {};
    try {
      for (let i = 0; i < rows.length; i++) {
        const res = await verifyOne(rows[i]);
        results[rows[i].seq] = res.v.verdict;
        const sum = l2Summary(res.v.checks);
        if (sum) sums[rows[i].seq] = sum;
      }
      update((p) => ({ ...p, results: { ...p.results, ...results }, l2: { ...p.l2, ...sums } }));
      const failed = Object.values(results).filter((v) => v === 'failed').length;
      if (failed) toast.bad(`${plural(failed, 'receipt')} failed verification`, 'Open the result to see which check failed.');
      else toast.ok(`All ${plural(rows.length, 'sampled receipt')} verified`, l2 ? 'Signature, key, hash, link, checkpoint, seal, both timestamps and the inclusion proof.' : 'Ed25519 seal, key, content hash, link and checkpoint inclusion.');
    } catch (e) { toast.bad('Verification stopped', (e as Error).message); } finally { setVerifying(false); }
  };

  const setReview = (seq: number, patch: Partial<{ reviewed: boolean; note: string }>) => {
    update((p) => {
      const prev = p.reviews[seq] ?? { reviewed: false, note: '' };
      return { ...p, reviews: { ...p.reviews, [seq]: { ...prev, ...patch, at: new Date().toISOString() } } };
    });
  };

  const onProfileResult = (res: SixCodeResult, profileId: string) => {
    if (!papers.config) return;
    const sampled = new Set(rows.map((r) => r.seq));
    const failingSampled = Array.from(new Set((res.profile?.results ?? []).flatMap((x) => x.failingSeqs).filter((s) => sampled.has(s)))).sort((a, b) => a - b);
    update((p) => ({
      ...p,
      profileRuns: [{
        at: new Date().toISOString(), profileId, profileName: res.profile ? `${res.profile.name} v${res.profile.version}` : 'No profile — integrity only', code: res.code, exitCode: res.exitCode, label: res.label, headline: res.headline,
        range: { from: p.config!.from, to: p.config!.to }, sections: res.sections.map((s) => ({ number: s.number, title: s.title, state: s.state, detail: s.detail })), failingSampled, bundleDigest: res.reproduction.bundleDigest,
      }, ...p.profileRuns].slice(0, 12),
    }));
  };

  const reviewed = rows.filter((r) => papers.reviews[r.seq]?.reviewed).length;
  const verified = rows.filter((r) => papers.results[r.seq] === 'verified').length;
  const failed = rows.filter((r) => papers.results[r.seq] === 'failed').length;
  const lastRun = papers.profileRuns[0];

  const exportCsv = () => {
    const cfg = papers.config!;
    const csv = toCsv(rows.map((r) => {
      const rv = papers.reviews[r.seq];
      const s2 = papers.l2[r.seq];
      return {
        client: orgName, org_id: orgId, level: LEVEL_INFO[c ? levelOfReceipt(r, c.state.history, c.state.level) : level].label, seed: cfg.seed, population: cfg.population, range: `${cfg.from}-${cfg.to}`, population_size: papers.population ?? '', sample_size: rows.length,
        seq: r.seq, ts: r.ts, time_ist: dateTime(r.ts), kind: r.kind, agent: r.agent ?? '', actor: r.actor ? userName(r.actor) : '', tool: r.tool ?? '', action: r.action ?? '',
        decision: r.decision ?? '', rule_id: r.rule_id ?? '', kid: r.kid, hash: r.hash,
        verification: papers.results[r.seq] ?? 'not run', seal_v6: s2?.seal ?? '', timestamps: s2?.timestamps ?? '', within_15_min: s2?.within15 ?? '', inclusion_proof: s2?.inclusion ?? '',
        profile: lastRun?.profileName ?? '', profile_result_code: lastRun?.code ?? '', profile_exit_code: lastRun?.exitCode ?? '', failing_profile_rule_here: lastRun?.failingSampled.includes(r.seq) ? 'yes' : '',
        reviewed: rv?.reviewed ? 'yes' : 'no', note: rv?.note ?? '', reviewer: user?.name ?? '', reviewed_at: rv?.at ?? '', exported_at: new Date().toISOString(),
      };
    }));
    downloadText(`working-papers-${orgSlug}-${today()}.csv`, csv, 'text/csv;charset=utf-8');
    toast.ok('Working papers exported (CSV)', 'The sample, each receipt’s checks, the verifier result code and your notes.');
  };
  const exportJson = () => {
    downloadText(`working-papers-${orgSlug}-${today()}.json`, papersApi.exportJson(papers, { auditorName: user?.name ?? '', clientName: orgName }));
    toast.ok('Working papers exported (JSON)', 'A colleague can load this file into their own workspace for the same client.');
  };

  const columns: Column<Receipt>[] = [
    { key: 'seq', header: 'Seq', cell: (r) => <ReceiptLink seq={r.seq} />, sort: (r) => r.seq, width: 84 },
    { key: 'ts', header: 'Time', cell: (r) => <span className="text-sm text-muted whitespace-nowrap">{dateTime(r.ts)}</span>, hideBelow: 'md' },
    { key: 'kind', header: 'Kind', cell: (r) => <KindMark kind={r.kind} />, hideBelow: 'lg' },
    { key: 'who', header: 'Agent or person', cell: (r) => (r.kind === 'admin' || (!r.agent && r.actor) ? <Person id={r.actor} size={20} /> : <AgentLink slug={r.agent} />), hideBelow: 'sm' },
    { key: 'decision', header: 'Decision', cell: (r) => <DecisionChip decision={r.decision} size="sm" short />, hideBelow: 'sm' },
    ...(l2 ? [{ key: 'level', header: 'Level', cell: (r: Receipt) => c ? <LevelTag level={levelOfReceipt(r, c.state.history, c.state.level)} /> : null, hideBelow: 'md' as const }] : []),
    {
      key: 'verify', header: 'Verification', cell: (r) => {
        const v = papers.results[r.seq];
        if (!v) return <Button size="sm" variant="secondary" icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => verifyRow(r)}>Verify</Button>;
        const m = VERDICT_META[v];
        const Icon = m.icon;
        const s2 = papers.l2[r.seq];
        return (
          <button onClick={() => verifyRow(r)} className="focus-visible:outline-2 text-left" aria-label={`${m.label}. Show the checks`}>
            <StatusChip tone={v === 'verified' ? 'ok' : v === 'failed' ? 'bad' : 'held'} size="sm" icon={<Icon className="h-3 w-3" aria-hidden />}>{m.label}</StatusChip>
            {s2 && <span className="block mt-0.5 text-[11px] text-muted">{s2.seal === 'pass' ? 'sealed' : s2.seal === 'skip' ? 'L1' : 'seal failed'} · {s2.timestamps === 'pass' ? `stamped${s2.within15 === 'warn' ? ' (late)' : ''}` : s2.timestamps === 'skip' ? 'not stamped yet' : 'stamp failed'}</span>}
          </button>
        );
      },
    },
    { key: 'reviewed', header: 'Reviewed', align: 'center', cell: (r) => <span className="inline-flex justify-center"><Checkbox checked={!!papers.reviews[r.seq]?.reviewed} onChange={(v) => setReview(r.seq, { reviewed: v })} label={<span className="sr-only">Reviewed {seqLabel(r.seq)}</span>} /></span>, width: 90 },
    { key: 'note', header: 'Note', cell: (r) => <NoteInput seq={r.seq} value={papers.reviews[r.seq]?.note ?? ''} onCommit={(note) => setReview(r.seq, { note })} />, hideBelow: 'md', width: '26%' },
  ];

  return (
    <section aria-label="Sampling" className="space-y-6">
      <div><p className="label mb-1 flex items-center gap-2">{orgName}<LevelTag level={level} /></p><h2 className="text-xl font-semibold">Sample and verify receipts</h2></div>
      {chain.error && <Banner tone="bad" title="The client’s chain could not be loaded" actions={<Button size="sm" onClick={chain.refetch}>Try again</Button>}>{chain.error.message}</Banner>}
      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-4" title="Draw a sample" kicker="Reproducible">
          {!c ? <Skeleton className="h-72" /> : (
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); draw(); }}>
              <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
                <Field label="From" htmlFor="s-from"><Input id="s-from" mono value={from} onChange={(e) => setFrom(e.target.value)} inputMode="numeric" /></Field>
                <Field label="To" htmlFor="s-to"><Input id="s-to" mono value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" /></Field>
              </div>
              <Field label="Population" htmlFor="s-pop">
                <Select id="s-pop" value={population} onChange={(e) => setPopulation(e.target.value as Population)}>
                  {POPULATIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-[96px_1fr] gap-3 [&>*]:min-w-0">
                <Field label="Size" htmlFor="s-size"><Input id="s-size" value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></Field>
                <Field label="Seed" htmlFor="s-seed" aside={<button type="button" className="text-xs text-muted hover:text-fg underline underline-offset-2" onClick={() => setSeed(`${orgSlug}-${Math.floor(Math.random() * 900000 + 100000)}`)}>New seed</button>}>
                  <Input id="s-seed" mono value={seed} onChange={(e) => setSeed(e.target.value)} />
                </Field>
              </div>
              {err ? <p className="text-xs text-bad-fg" role="alert">{err}</p> : <p className="text-xs text-muted">{plural(poolSize, 'receipt')} in the population; {n(Math.min(k, poolSize))} will be drawn.</p>}
              <Button type="submit" variant="primary" block icon={<Shuffle className="h-4 w-4" />} disabled={!!err || poolSize === 0}>{papers.sample.length ? 'Draw a new sample' : 'Draw sample'}</Button>
              <p className="text-xs text-muted leading-relaxed">Seeded shuffle (mulberry32 over the SHA-256 of the seed). Anyone with the same seed, range and population draws the same receipts — record the seed in your working papers.</p>
            </form>
          )}
        </Panel>

        <div className="lg:col-span-8 space-y-6 min-w-0">
          {stale && <Banner tone="neutral" title="Your previous sample was cleared">The demonstration chain was regenerated since you drew it, so its sequence numbers now point to different receipts. Draw the sample again with the same seed.</Banner>}
          <Panel
            title={papers.config ? `Sample of ${plural(rows.length, 'receipt')}` : 'Sample'}
            kicker={papers.config ? `Seed ${papers.config.seed} · ${seqLabel(papers.config.from)}–${seqLabel(papers.config.to)} · ${POPULATIONS.find((p) => p.value === papers.config!.population)?.label}` : undefined}
            actions={rows.length > 0 && <Button size="sm" variant="secondary" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={verifying} onClick={verifyAll}>Verify all</Button>}
            flush
          >
            {rows.length > 0 && (
              <div className="grid grid-cols-3 gap-px bg-line border-b border-line">
                <div className="bg-surface px-5 py-3"><p className="label">Reviewed</p><p className="mt-1 text-sm num"><span className="font-display text-xl font-semibold">{reviewed}</span> of {rows.length}</p><Meter className="mt-2" value={rows.length ? reviewed / rows.length : 0} label="Share reviewed" /></div>
                <div className="bg-surface px-5 py-3"><p className="label">Verified</p><p className="mt-1 text-sm num"><span className="font-display text-xl font-semibold text-ok-fg">{verified}</span> of {rows.length}</p></div>
                <div className="bg-surface px-5 py-3"><p className="label">Failed</p><p className={cn('mt-1 text-sm num', failed ? 'text-bad-fg' : '')}><span className="font-display text-xl font-semibold inline-flex items-center gap-1">{failed > 0 && <OctagonX className="h-4 w-4" aria-hidden />}{failed}</span></p></div>
              </div>
            )}
            {!papersLoaded || !c ? <div className="p-5"><Skeleton className="h-40" /></div> : rows.length === 0 ? (
              <EmptyState compact title="No sample drawn yet" disc="registration">Pick a sequence range, a population and a size, then draw. Each sampled receipt can be verified here and marked as reviewed with a note.</EmptyState>
            ) : (
              <DataTable caption="Sampled receipts" className="border-0" columns={columns} rows={rows} rowKey={(r) => r.seq} maxHeight={620} />
            )}
          </Panel>

          {/* verifier profiles are part of a client's plan from L2: below it the panel is left out */}
          {l2 && <Panel title="Verifier profile on the sample range" kicker="Six result codes · nine sections">
            {!papers.config ? (
              <p className="text-sm text-muted">Draw a sample first. The profile runs over the sample’s whole range, and the working papers note which sampled receipts a failing rule names.</p>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted">Runs over {seqLabel(papers.config.from)}–{seqLabel(papers.config.to)} (the sample’s range), assembled from the client’s records. Nothing is written to the client’s chain.</p>
                <SixCodeRunner key={`${papers.config.from}-${papers.config.to}`} orgId={orgId} from={papers.config.from} to={papers.config.to} onResult={onProfileResult} compactIntro />
                {papers.profileRuns.length > 0 && (
                  <div>
                    <p className="label mb-2">Recorded in your working papers</p>
                    <ul className="border border-line divide-y divide-line">
                      {papers.profileRuns.map((p) => (
                        <li key={p.at} className="px-3 py-2.5 text-sm">
                          <div className="flex flex-wrap items-center gap-2"><CodeChip code={p.code} /><span className="font-medium">{p.profileName}</span><span className="text-xs text-muted">{seqLabel(p.range.from)}–{seqLabel(p.range.to)} · {dateTime(p.at)}</span></div>
                          <p className="mt-1 text-xs text-muted">{p.headline}{p.failingSampled.length ? ` Sampled receipts a failing rule names: ${p.failingSampled.map(seqLabel).join(', ')}.` : ''}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1">{p.sections.map((s) => <span key={s.number} title={`${s.number}. ${s.title}: ${s.detail}`}><SectionChip state={s.state} /></span>)}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Panel>}

          {/* receipts between organisations are part of a client's plan from L3 */}
          {l3 && <CrossOrgPanel orgId={orgId} orgName={orgName} orgDomain={orgDomain} l3={l3} papers={papers} update={update} level={level} />}

          <Panel title="Working papers" kicker={papers.updatedAt ? `Saved ${relative(papers.updatedAt)}${papers.digest ? ` · digest ${papers.digest}` : ''}` : 'Not saved yet'}>
            <p className="text-sm text-muted">Yours for this client: the sample and its seed, each receipt’s checks, profile results with their codes, counterparty checks and your notes. They are kept for you ({user?.name ?? 'this auditor'}) and this client only, and are never written to the client’s chain.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<FileSpreadsheet className="h-3.5 w-3.5" />} onClick={exportCsv} disabled={!rows.length} title={!rows.length ? 'Draw a sample first.' : undefined}>Export CSV</Button>
              <Button size="sm" variant="secondary" icon={<FileJson className="h-3.5 w-3.5" />} onClick={exportJson}>Export JSON (to hand on)</Button>
              <Button size="sm" variant="ghost" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => setImportOpen(true)}>Load a colleague’s papers</Button>
            </div>
          </Panel>

          <Panel title="Next steps" flush>
            <ul className="divide-y divide-line text-sm">
              <QuickLink icon={<PackageOpen className="h-4 w-4" />} title={l2 ? 'Export an evidence bundle' : 'Export an auditor pack'} body={l2 ? 'Eight members: manifest, receipts, seals, checkpoints, anchors, keys, declarations, profile. Recorded on the client’s chain.' : 'Receipts, checkpoints and keys for offline verification. Recorded on the client’s chain.'} to="/evidence?export=1" />
              <QuickLink icon={<ShieldCheck className="h-4 w-4" />} title="Verify a bundle in the browser" body="Drop the file on the verifier, or run govern verify offline." to="/verify" />
              <QuickLink icon={<Waypoints className="h-4 w-4" />} title="Walk the chain" body={l2 ? 'Linked blocks with checkpoints, Merkle batches and the level boundary.' : 'Linked blocks with checkpoints; verify the whole chain here.'} to="/activity/chain" />
              <QuickLink icon={<OctagonX className="h-4 w-4" />} title="Read the refusals" body="Every call that was refused, by rule, default, pause or expiry." to="/activity?d=refuse&range=all" />
              <QuickLink icon={<ClipboardList className="h-4 w-4" />} title="Compliance coverage" body="Which controls have receipts as evidence." to="/compliance" />
            </ul>
            <div className="px-5 py-3 border-t border-line flex flex-wrap items-center gap-3"><LegalDraft /><span className="text-xs text-muted">Coverage is a count of receipts, not a test that a control works.</span></div>
          </Panel>
        </div>
      </div>

      <Dialog open={!!detail} onClose={() => setDetail(undefined)} title={detail ? `Receipt ${seqLabel(detail.seq)}` : ''} description="Checked in this browser against the organisation’s published keys." size="md"
        footer={<><Button variant="ghost" onClick={() => setDetail(undefined)}>Close</Button>{detail && <Button variant="primary" iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => nav(`/activity/${detail.seq}?tab=signed`)}>Open the receipt</Button>}</>}>
        {detail && (
          <div className="space-y-3">
            <VerdictLine verdict={detail.v.verdict}>{detail.v.fingerprint && <>Key fingerprint <span className="font-mono">{detail.v.fingerprint}</span>. </>}{claimFor(detail.level, { anchored: detail.anchored })}</VerdictLine>
            <CheckList checks={detail.v.checks} grouped />
          </div>
        )}
      </Dialog>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={(text) => { const p = papersApi.importJson(text, auditorId, orgId); setPapers(p); filled.current = false; toast.ok('Working papers loaded', `${plural(p.sample.length, 'sampled receipt')}, ${plural(p.profileRuns.length, 'profile run')}.`); }} />
    </section>
  );
}

/* ── Cross-organisation receipts (L3) ─────────────────────── */

function CrossOrgPanel({ orgId: _orgId, orgName, orgDomain, l3, papers, update, level }: { orgId: string; orgName: string; orgDomain?: string; l3: boolean; papers: WorkingPapers; update: (fn: (p: WorkingPapers) => WorkingPapers) => void; level: import('@/types').LevelId }) {
  const data = useQuery(async (o) => {
    if (!l3) return undefined;
    const [cross, cps] = await Promise.all([api.crossOrgReceipts(o), api.counterparties(o)]);
    return { cross, cps: cps.counterparties };
  }, [l3], { kinds: ['receipt'] });
  const [open, setOpen] = useState<string>();
  if (!l3) {
    return (
      <Panel title="Receipts between organisations">
        <UpgradeHint to="l3" title={`${orgName} is on ${LEVEL_INFO[level].label}: it does not issue or receive receipts from counterparties yet.`}>
          From L3 Proven a client issues receipts to customers, vendors, insurers, lenders and regulators, and receives theirs. You verify each received receipt here against the key the client pinned for that counterparty.
        </UpgradeHint>
      </Panel>
    );
  }
  const received = (data.data?.cross ?? []).filter((x) => x.direction === 'received');
  const issued = (data.data?.cross ?? []).filter((x) => x.direction === 'issued');
  const verifyX = (x: CrossOrgReceipt) => {
    const pinned = data.data?.cps.find((c) => c.id === x.counterpartyId)?.keyFingerprint;
    const res = checkCrossOrg(x, { domain: orgDomain, pinnedFingerprint: pinned });
    update((p) => ({ ...p, crossOrg: { ...p.crossOrg, [x.id]: { at: new Date().toISOString(), issuer: x.issuerName, seq: x.seq, state: res.state, steps: res.steps } } }));
    setOpen(x.id);
    if (res.state === 'verified') toast.ok(`Receipt from ${x.issuerName} verifies`, 'Recorded in your working papers.');
    else toast.bad(`Receipt from ${x.issuerName} does not verify`, 'See which check failed.');
  };
  return (
    <Panel title="Receipts between organisations" kicker={`${n(received.length)} received · ${n(issued.length)} issued`} flush>
      {data.error && <div className="p-5"><Banner tone="bad">{data.error.message}</Banner></div>}
      {data.loading && !data.data ? <div className="p-5"><Skeleton className="h-32" /></div> : !received.length && !issued.length ? (
        <EmptyState compact title="No counterparty receipts yet" disc="orbit">The client has not issued or received any. They appear here when it does.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {received.map((x) => {
            const paper = papers.crossOrg[x.id];
            return (
              <li key={x.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5 text-muted" aria-hidden />From {x.issuerName} <span className="font-mono text-xs text-muted">{seqLabel(x.seq)}</span></p>
                    <p className="text-xs text-muted break-words">{x.summary}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {paper && <StatusChip tone={paper.state === 'verified' ? 'ok' : 'bad'} size="sm" icon={paper.state === 'verified' ? <Check className="h-3 w-3" aria-hidden /> : <OctagonX className="h-3 w-3" aria-hidden />}>{paper.state === 'verified' ? 'Verified by you' : 'Failed for you'}</StatusChip>}
                    <Button size="sm" variant="secondary" icon={paper ? <RefreshCw className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />} onClick={() => verifyX(x)}>{paper ? 'Check again' : 'Verify in this browser'}</Button>
                  </div>
                </div>
                {paper && open === x.id && <div className="mt-3"><CheckList checks={paper.steps.map((s) => ({ label: s.label, state: s.state as 'pass' | 'fail' | 'skip', detail: s.detail }))} /></div>}
                {paper && open !== x.id && <button type="button" className="mt-1 text-xs text-muted underline underline-offset-2" onClick={() => setOpen(x.id)}>Show the checks ({dateTime(paper.at)})</button>}
              </li>
            );
          })}
          {issued.map((x) => (
            <li key={x.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">Issued to {x.counterpartyName} · <Link to={`/activity/${x.seq}`} className="font-mono text-xs underline underline-offset-2">{seqLabel(x.seq)}</Link></p>
                <p className="text-xs text-muted break-words">{x.summary}</p>
              </div>
              <StatusChip tone={x.verification.state === 'verified' ? 'ok' : x.verification.state === 'pending' ? 'held' : 'bad'} size="sm">{x.verification.state === 'verified' ? 'Their verifier: pass' : x.verification.state === 'pending' ? 'Not reported yet' : 'Their verifier: fail'}</StatusChip>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ImportDialog({ open, onClose, onImport }: { open: boolean; onClose: () => void; onImport: (text: string) => void }) {
  const [err, setErr] = useState<string>();
  const [name, setName] = useState<string>();
  const [text, setText] = useState<string>();
  useEffect(() => { if (open) { setErr(undefined); setName(undefined); setText(undefined); } }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title="Load a colleague’s working papers" description="A JSON file exported from this workspace for the same client. It replaces your papers for this client; export yours first if you want to keep them." size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!text} onClick={() => { try { onImport(text!); onClose(); } catch (e) { setErr((e as Error).message); } }}>Load</Button></>}>
      <Field label="Working papers file" htmlFor="wp-file" error={err}>
        <input id="wp-file" type="file" accept="application/json,.json" className="block w-full text-sm file:mr-3 file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm" onChange={async (e) => { const f = e.target.files?.[0]; setErr(undefined); if (!f) return; setName(f.name); setText(await f.text()); }} />
      </Field>
      {name && <p className="mt-2 text-xs text-muted">Selected: <span className="font-mono">{name}</span></p>}
    </Dialog>
  );
}

function NoteInput({ seq, value, onCommit }: { seq: number; value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(false);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v !== value) { onCommit(v); setSaved(true); window.setTimeout(() => setSaved(false), 1200); } };
  return (
    <div className="relative">
      <Input aria-label={`Note for ${seqLabel(seq)}`} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} placeholder="Add a note" className="h-8 text-sm pr-7" />
      {saved && <Check className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ok" aria-label="Saved" />}
    </div>
  );
}

function QuickLink({ icon, title, body, to }: { icon: ReactNode; title: string; body: string; to: string }) {
  return (
    <li>
      <Link to={to} className="flex items-start gap-3 px-5 py-3 hover:bg-sunken/60 group">
        <span className="mt-0.5 text-muted">{icon}</span>
        <span className="flex-1 min-w-0"><span className="block font-medium">{title}</span><span className="block text-xs text-muted mt-0.5">{body}</span></span>
        <ArrowRight className="h-4 w-4 text-subtle group-hover:text-fg mt-0.5" aria-hidden />
      </Link>
    </li>
  );
}
