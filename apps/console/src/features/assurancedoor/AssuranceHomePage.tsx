import { Children, cloneElement, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PlanUpsell, SmartLink, useScreenAccess } from '@/shell/access';
import {
  ArrowRight, ArrowUpRight, BadgeCheck, Briefcase, CheckCircle2, CircleSlash, FileDown, Fingerprint, Handshake, Layers, OctagonX, PackageOpen, Receipt as ReceiptIcon,
  Scale, ShieldCheck, Stamp, Terminal, Waypoints,
} from 'lucide-react';
import { api, db } from '@/api';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useRole } from '@/store/session';
import type { LevelId } from '@/types';
import { PLANS, REFUSAL_FACTOR } from '@/lib/pricing';
import { LEVELS, LEVEL_INFO, atLeast, levelRank } from '@/lib/levels';
import { CODE_LABELS, EXIT_CODES, REPORT_SECTION_TITLES } from '@/lib/verify6';
import { date, n, pct, plural, relative, rupees, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import { Banner, Button, CopyButton, LegalDraft, PageHeader, Panel, Skeleton, StatusChip } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { ExportPackDialog } from '@/features/evidence/ExportPackDialog';
import { coverageOf, indexControls, liveControls } from '@/features/compliance/evidence';
import { chainMeter } from '@/features/billing/chainMeter';
import { claimFor, LEVEL_COPY, limitsFor } from '@/features/assurance/levelModel';
import { chainStanding, classLabel, levelFacts, refusalStats } from './model';
import { ENFORCEMENT_LABEL, enforcementOf } from '@/mock/evidence';
import { IntegritySummary, UncheckedChip } from '@/features/evidence/IntegrityRuns';

/**
 * Door 04 · Assurance — home. Answers "Can I show someone this was done properly?" in plain words,
 * for an auditor, a CISO or a CFO, from the organisation's own chain and at the organisation's level.
 */
export default function AssuranceHomePage() {
  const nav = useNavigate();
  const role = useRole();
  const canExport = useCan('evidence.export');
  const now = useNow(30_000);
  const [exportOpen, setExportOpen] = useState(false);
  const ownerAdmin = role === 'owner' || role === 'admin';
  const { canSee, isOwner } = useScreenAccess();

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [ev, comp, facts, integrity, cps] = await Promise.all([api.evidence(o), api.compliance(o), levelFacts(o), api.integrityRuns(o), api.counterparties(o).catch(() => undefined)]);
    const d = db.getDB(o);
    const weekAgo = Date.now() - 7 * 24 * 3_600_000;
    const controls = liveControls(o, comp.controls);
    const byId = indexControls(controls);
    const enabled = comp.frameworks.filter((f) => f.enabled);
    const cov = enabled.map((f) => ({ f, c: coverageOf(f, byId) }));
    return {
      ev,
      facts,
      meter: chainMeter(d),
      standing: chainStanding(d),
      refusals: refusalStats(d.receipts, '7d'),
      coverage: { frameworks: cov, all: comp.frameworks.length, covered: cov.reduce((s, x) => s + x.c.covered, 0), total: cov.reduce((s, x) => s + x.c.total, 0) },
      exports: d.exports.slice().sort((a, b) => b.ts.localeCompare(a.ts)),
      orgName: d.org.name,
      integrity,
      // the read-only register below L3 (decision 6d): counterparties named in governed calls
      counterparties: cps?.fromChain?.length ?? 0,
      // the enforcement mode of the last 7 days' decisions: governed run (enforced), check and record (advisory), or both
      enforcement: enforcementOf(d, d.receipts.filter((r) => new Date(r.ts).getTime() >= weekAgo)),
      // the same, per write type (the tool a decision names), over the same 7 days
      byWriteType: writeTypeModes(d.receipts.filter((r) => new Date(r.ts).getTime() >= weekAgo)),
    };
  }, []);

  const s = data?.standing;
  const f = data?.facts;
  const level: LevelId = f?.lv.level ?? 'l1';
  const plan = PLANS[level];
  const lastExport = data?.exports[0];
  const lastBatch = f?.anchors.batches[0];
  const topClass = useMemo(() => {
    if (!data) return undefined;
    const entries = Object.entries(data.refusals.byClass).sort((a, b) => b[1] - a[1]);
    return entries[0] && entries[0][1] > 0 ? { id: entries[0][0] as Parameters<typeof classLabel>[0], count: entries[0][1] } : undefined;
  }, [data]);

  const answer = useMemo(() => {
    if (!s || !f) return undefined;
    if (!s.head || !s.first) return { tone: 'none' as const, lead: 'Not yet.', text: 'There are no receipts in this organisation, so there is nothing to show anyone.' };
    if (s.breaks > 0) {
      return { tone: 'bad' as const, lead: 'Not cleanly.', text: `The continuity check found ${plural(s.breaks, 'broken link')} in ${n(s.total)} receipts, the first at ${seqLabel(s.firstBreak!)}. Open the chain to see exactly where, before you hand anything over.` };
    }
    const range = `${n(s.total)} receipts continuous from ${seqLabel(s.first.seq)} to ${seqLabel(s.head.seq)}`;
    if (level === 'l1') {
      // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
      const cp = s.lastCheckpoint ? `last checkpoint ${relative(s.lastCheckpoint.ts, now)}` : 'no sealed checkpoint yet';
      return { tone: 'ok' as const, lead: 'Yes, within stated limits:', text: `${range}, sealed in a hash chain by Elan1 Govern, ${cp}. Not yet externally timestamped.` };
    }
    // The current level's claim holds only from the start of the current level; earlier spans above L1 keep their own claim.
    const since = f.boundary && !f.boundary.beforeWindow ? ` Since ${date(f.lv.since)} every record is` : ' Every record is';
    const hist = f.lv.history;
    const earlier = f.boundary && !f.boundary.beforeWindow
      ? hist.slice(0, -1).map((h, i) => ({ h, to: hist[i + 1].from })).filter((x) => x.h.level !== 'l1' && x.h.level !== level)
        .map((x) => ` Records from ${date(x.h.from)} to ${date(x.to)} are ${claimFor(x.h.level)}.`).join('')
      : '';
    const anchor = lastBatch ? ` The last batch was timestamped ${relative(lastBatch.windowEnd, now)} by ${lastBatch.tokens.map((t) => t.tsaName).join(' and ')}${f.anchors.totals.unanchoredTail ? `; ${plural(f.anchors.totals.unanchoredTail, 'record')} wait in the unanchored tail` : ''}.` : '';
    return { tone: 'ok' as const, lead: 'Yes, within stated limits:', text: `${range}.${since} ${claimFor(level)} (${f.custody.provider}, ${f.custody.residencyDomain}).${earlier}${anchor}` };
  }, [s, f, level, now, lastBatch]);

  const fps = data ? Object.keys(data.ev.publicKeys).length : 0;

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Assurance overview"
        description="The plain answer for an auditor, a CISO or a CFO: what the record shows at this organisation’s level, what an outsider can check for themselves, and what it does not prove."
        meta={f && <StatusChip tone="inverse" icon={<Layers className="h-3.5 w-3.5" aria-hidden />}>{LEVEL_INFO[level].label}</StatusChip>}
        actions={
          <>
            {role === 'auditor' && <Button variant="secondary" icon={<Briefcase className="h-4 w-4" />} onClick={() => nav('/auditor')}>Auditor workspace</Button>}
            <Button variant="secondary" icon={<Waypoints className="h-4 w-4" />} onClick={() => nav('/activity/chain')}>Verify the chain</Button>
            {/* viewers cannot export: no button rather than a disabled one */}
            {canExport && <Button variant="primary" icon={<PackageOpen className="h-4 w-4" />} onClick={() => setExportOpen(true)}>{atLeast(level, 'l2') ? 'Export evidence bundle' : 'Export auditor pack'}</Button>}
          </>
        }
      />

      {error && <Banner tone="bad" title="The assurance overview could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      {role === 'auditor' && (
        <Banner tone="neutral" className="mb-6" title="You are signed in as an auditor" actions={<Button size="sm" variant="secondary" iconRight={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => nav('/auditor')}>Open workspace</Button>}>
          Your workspace keeps samples, working papers and the client organisations you hold. Everything here is read-only for you, with these exceptions, each recorded on the client’s chain: exporting evidence or the continuity report, asking for evidence and collecting it, and the three pack-pilot steps the pilot gives to the auditor — the day-0 necessity statement, the day-77 offline verifier run and the day-80 verdict. Integrity checks and profile runs you start are shown to you and are not recorded.
        </Banner>
      )}

      {/* hero — the one-sentence answer */}
      <Panel tone="inverse" className="mb-6" bodyClassName="p-5 sm:p-7">
        {loading && !data ? (
          <div className="space-y-3"><Skeleton className="h-4 w-48 opacity-20" /><Skeleton className="h-8 w-full opacity-20" /><Skeleton className="h-8 w-2/3 opacity-20" /></div>
        ) : error && !data ? (
          <p className="text-paper/90">The answer needs the chain, and it could not be loaded. Try again above.</p>
        ) : answer && s ? (
          <div className="grid gap-6 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-9 min-w-0">
              <p className="label text-ink-300 mb-3">Can I show someone this was done properly? · {data?.orgName} · {LEVEL_INFO[level].label}</p>
              <p className="font-display text-2xl sm:text-[28px] leading-snug font-semibold tracking-tighter2 text-paper" aria-live="polite">
                <span className={cn(answer.tone === 'bad' && 'text-bad', answer.tone === 'none' && 'text-ink-300')}>{answer.lead}</span>{' '}
                <span className="text-paper/90">{answer.text}</span>
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-200">
                {answer.tone === 'ok' && <span className="inline-flex items-center gap-1.5"><Waypoints className="h-4 w-4" aria-hidden />Sequence and hash links checked in this browser just now</span>}
                {answer.tone === 'bad' && <span className="inline-flex items-center gap-1.5"><OctagonX className="h-4 w-4" aria-hidden />Continuity check failed</span>}
                {data?.integrity.unchecked && <Link to="/evidence?tab=integrity" className="underline underline-offset-2 hover:text-paper">Not checked over {seqLabel(data.integrity.unchecked.from)}–{seqLabel(data.integrity.unchecked.to)} by an integrity run</Link>}
                {s.unanchored > 0 && <span>{plural(s.unanchored, 'receipt')} after the last checkpoint</span>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-200">
                <span className="inline-flex items-center gap-1.5 border border-ink-300/40 px-2 py-0.5 text-paper" title="Governed run (MCP): Elan1 Govern holds the credential and a refused call cannot run. Check and record (REST, SDK): Elan1 Govern advises and records; the agent runs the call."><ShieldCheck className="h-3.5 w-3.5" aria-hidden />Enforcement mode: {data ? ENFORCEMENT_LABEL[data.enforcement.mode] : '—'}</span>
                <span>Enforced on the MCP route for {n(s.agents.governed)} of {plural(s.agents.total, 'agent')}; advisory on REST and SDK for {n(s.agents.advisory)}{data && data.enforcement.mode !== 'none' ? ` · last 7 days: ${n(data.enforcement.governed_run)} governed-run and ${n(data.enforcement.check_and_record)} check-and-record decisions` : ''}</span>
              </div>
            </div>
            <div className="lg:col-span-3 flex flex-wrap lg:justify-end gap-2">
              <Button variant="inverse" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => nav('/activity/chain')}>{atLeast(level, 'l2') ? 'Check signatures' : 'Check the seals'}</Button>
            </div>
          </div>
        ) : null}
      </Panel>

      {/* tiles in the door's order */}
      <h2 className="sr-only">Assurance at a glance</h2>
      <TileGrid className="mb-8">
        <Tile to="/activity/chain" label="Chain standing" icon={<Waypoints className="h-4 w-4" aria-hidden />} cta="Verify the chain" loading={!data}
          value={s?.head ? <span className="font-mono text-[26px]">{seqLabel(s.head.seq)}</span> : '—'}
          status={s ? (s.breaks === 0
            // "Continuous" is never shown with a tick: what no integrity run has reached says so
            ? <><StatusChip tone="neutral" size="sm" icon={<Waypoints className="h-3 w-3" aria-hidden />}>Links continuous</StatusChip><UncheckedChip report={data?.integrity} /></>
            : <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>{plural(s.breaks, 'break')}</StatusChip>) : undefined}>
          {s && <>
            <p>Head of {n(s.total)} receipts</p>
            <p>{s.lastCheckpoint ? <>Checkpoint at <span className="font-mono">{seqLabel(s.lastCheckpoint.seq)}</span> · {relative(s.lastCheckpoint.ts, now)}</> : `No ${atLeast(level, 'l2') ? 'signed' : 'sealed'} checkpoint yet`}</p>
          </>}
        </Tile>

        {/* timestamps are part of the plan from L2: below it the tile is left out (owners get one line under the grid) */}
        {f && f.anchors.enabled && (
          <Tile to="/assurance/anchors" label="Timestamps" icon={<Stamp className="h-4 w-4" aria-hidden />} cta="Anchors and inclusion proofs" loading={!data}
            value={n(f.anchors.totals.anchoredRecords)}
            status={<StatusChip tone={f.anchors.totals.withinTargetPct >= 0.99 ? 'ok' : 'held'} size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>{pct(f.anchors.totals.withinTargetPct)} within {f.anchors.totals.targetMinutes} min</StatusChip>}>
            <p>Records in {plural(f.anchors.totals.batches, 'Merkle batch', 'Merkle batches')}, each stamped by 2 authorities</p>
            {lastBatch && <p>Last {relative(lastBatch.windowEnd, now)}: {lastBatch.tokens.map((t) => t.tsaName).join(' · ')}</p>}
            <p>{plural(f.anchors.totals.unanchoredTail, 'record')} in the unanchored tail</p>
          </Tile>
        )}

        <Tile to="/assurance/levels" label="Level and boundary" icon={<Layers className="h-4 w-4" aria-hidden />} cta="The ladder" loading={!data}
          value={<span className="text-[30px]">{LEVEL_INFO[level].short}</span>}
          status={f && <StatusChip tone="neutral" size="sm">Since {date(f.lv.since)}</StatusChip>}>
          {s && f && (f.boundary ? <>
            <p>{LEVEL_INFO[f.boundary.from].short} → {LEVEL_INFO[f.boundary.to].short} on {date(f.boundary.at)}{f.boundary.firstSeq ? <> at <span className="font-mono">{seqLabel(f.boundary.firstSeq)}</span></> : ''}</p>
            <p>{LEVELS.filter((l) => s.atLevel[l] > 0).map((l) => `${n(s.atLevel[l])} at ${LEVEL_INFO[l].short}`).join(' · ')}</p>
          </> : <p>{n(s.total)} receipts, all at {LEVEL_INFO[level].short}. No boundary yet.</p>)}
        </Tile>

        <Tile to="/assurance/refusals" label="Refusals · 7 d" icon={<CircleSlash className="h-4 w-4" aria-hidden />} cta="Refusal analytics" loading={!data}
          value={data ? n(data.refusals.refused.length) : '—'}>
          {data && <>
            <p>{pct(data.refusals.share, 1)} of {plural(data.refusals.calls, 'call')}</p>
            {topClass && <p>Most: {classLabel(topClass.id).toLowerCase()} ({n(topClass.count)})</p>}
            <p>{atLeast(level, 'l2') ? 'Each one is a signed receipt' : 'Each one is a receipt sealed in the hash chain'}</p>
          </>}
        </Tile>

        <Tile to="/compliance" label="Coverage" icon={<Scale className="h-4 w-4" aria-hidden />} cta="Frameworks and controls" loading={!data}
          value={data ? (data.coverage.frameworks.length ? <>{n(data.coverage.covered)}<span className="text-xl text-muted font-normal"> of {n(data.coverage.total)}</span></> : '0') : '—'}
          status={<LegalDraft className="h-5 text-[11px]" />}>
          {data && (data.coverage.frameworks.length ? <>
            <p>Requirements with live evidence across {plural(data.coverage.frameworks.length, 'enabled framework')} of {n(data.coverage.all)}</p>
            <p>A count of receipts, not a test that a control works</p>
          </> : <p>No framework is enabled yet. Enable one to see which requirements the chain evidences.</p>)}
        </Tile>

        {/* the meter is a money screen: owners and admins only */}
        {ownerAdmin && (
          <Tile to="/billing" label="Meter" icon={<ReceiptIcon className="h-4 w-4" aria-hidden />} cta="Meter and invoices" loading={!data}
            value={data ? n(Math.round(data.meter.fy.units)) : '—'}>
            {data && <>
              <p>{plan.includedPerYear ? <>Included actions used in {data.meter.fy.label} of {n(plan.includedPerYear)} ({pct(data.meter.fy.share, 2)})</> : <>Units metered in {data.meter.fy.label}; Sovereign has no allowance</>}</p>
              <p>{n(data.meter.fy.committed)} committed · {n(data.meter.fy.refused)} refused at {REFUSAL_FACTOR} each ({rupees(plan.refusalRate, { paise: true })} beyond the allowance)</p>
              <p>Read from the chain</p>
            </>}
          </Tile>
        )}

        {canSee('/assurance/exports') && (
          <Tile to="/assurance/exports" label="Exports" icon={<FileDown className="h-4 w-4" aria-hidden />} cta={ownerAdmin ? 'Bundles, webhooks and data' : atLeast(level, 'l2') ? 'Evidence bundles' : 'Auditor packs'} loading={!data}
            value={data ? n(data.exports.length) : '—'}>
            {data && (lastExport ? <>
              <p>Last {lastExport.format === 'elan1.evidence.bundle.v1' ? 'evidence bundle' : 'auditor pack'} <When iso={lastExport.ts} /></p>
              <p>by {userName(lastExport.by)} · <span className="font-mono">{seqLabel(lastExport.firstSeq)}–{seqLabel(lastExport.lastSeq)}</span></p>
              <p>{atLeast(level, 'l2') ? `${rupees(2500)} per bundle` : 'Auditor packs are free'}</p>
            </> : <p>No evidence has left the console yet.</p>)}
          </Tile>
        )}

        {f?.cross ? (
          <Tile to="/assurance/counterparties" label="Counterparties" icon={<Handshake className="h-4 w-4" aria-hidden />} cta="Cross-organisation receipts" loading={!data}
            value={<>{n(f.cross.issued)}<span className="text-xl text-muted font-normal"> / {n(f.cross.received)}</span></>}
            status={f.cross.failed ? <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>{n(f.cross.failed)} failed</StatusChip> : <StatusChip tone="ok" size="sm" icon={<BadgeCheck className="h-3 w-3" aria-hidden />}>{n(f.cross.verified)} verified</StatusChip>}>
            <p>Receipts issued to counterparties / received from them</p>
            {f.cross.last && <p>Latest {relative(f.cross.last, now)}</p>}
          </Tile>
        ) : (
          <Tile to="/assurance/counterparties" label="Counterparties" icon={<Handshake className="h-4 w-4" aria-hidden />} cta="Read-only register" loading={!data} value={data ? n(data.counterparties) : '—'}>
            <p>Counterparties your agents acted on, listed read-only from the chain</p>
          </Tile>
        )}
      </TileGrid>
      {f && !f.anchors.enabled && <PlanUpsell to="l2" what="Timestamps: from L2 two authorities stamp every 15-minute Merkle batch." className="-mt-5 mb-8" />}

      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-7 space-y-6">
          <Panel title="What an outsider can check" kicker="No account, no elan1 process">
            {error && !data ? <p className="text-sm text-muted">This needs the chain and key facts, which could not be loaded.</p> : !s || !f ? <Skeleton className="h-40" /> : (
              <ol className="space-y-5">
                {atLeast(level, 'l2') ? (
                  <Check icon={<Terminal className="h-4 w-4" aria-hidden />} title="Verify an evidence bundle offline">
                    <p>The bundle has 8 members — manifest, receipts, seals, checkpoints, anchors, keys, declarations and the profile with VERIFY.txt — and a lexicon that names every rule and refusal id it uses. On their own machine the auditor runs:</p>
                    <p className="mt-2 font-mono text-[12.5px] bg-sunken/70 border border-line px-3 py-2 break-all">govern verify bundle.json --fingerprint {s.fingerprint} --profile in-mca-audit-trail</p>
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2 text-[13px]">
                      {(Object.keys(EXIT_CODES) as (keyof typeof EXIT_CODES)[]).map((c) => <li key={c}><span className="font-mono text-fg">{EXIT_CODES[c]} {c}</span> — {CODE_LABELS[c]}</li>)}
                    </ul>
                    <p className="mt-2">The report has 9 sections: {REPORT_SECTION_TITLES.join(', ')}. Integrity lists the verifier’s own checks: the bundle and manifest, keys, signatures, hash chain, checkpoints, anchors, seals and disclosure. <code className="font-mono">--profile</code> checks a regime’s rules, reported under Clause results; without it no regime is claimed.</p>
                  </Check>
                ) : (
                  <Check icon={<Terminal className="h-4 w-4" aria-hidden />} title="Verify an auditor pack offline">
                    <p>The pack is a ZIP: the receipts, the sealed checkpoints and the public keys, a PDF summary, a compliance map and a README, under a manifest sealed over the last hash, the counts and every file’s digest. On their own machine the auditor runs:</p>
                    <p className="mt-2 font-mono text-[12.5px] bg-sunken/70 border border-line px-3 py-2 break-all">govern verify auditor-pack.zip --fingerprint {s.fingerprint}</p>
                    <p className="mt-2">Exit 0 is PASS_L1_INTERNAL: intact, and internal evidence only. Exit 1 names the first broken receipt, an edited manifest or a cut-off tail. Exit 3 INCOMPLETE means something needed to check is missing: a file, a seal or a key. Exit 5 USAGE means the input is not a pack, or an option is wrong. The pack is free.</p>
                    <PlanUpsell to="l2" what="From L2 the verifier adds timestamps, seals and verifier profiles per regime." className="mt-2" />
                  </Check>
                )}
                <Check icon={<BadgeCheck className="h-4 w-4" aria-hidden />} title="Check a receipt or a bundle in the web verifier">
                  <p>Anyone can paste a receipt or drop a pack or bundle into the <Link to="/verify" className="link">public verifier</Link>. It runs in their browser and needs no account.</p>
                </Check>
                {atLeast(level, 'l2') && (
                  <Check icon={<Stamp className="h-4 w-4" aria-hidden />} title="Check a record’s timestamp">
                    <p>Each sealed record has a Merkle inclusion proof to a batch root stamped by {f.anchors.authorities.map((a) => a.name).join(' and ')}. <SmartLink to="/assurance/anchors" className="link">Timestamps</SmartLink> shows the proof for any record.</p>
                  </Check>
                )}
                <Check icon={<Fingerprint className="h-4 w-4" aria-hidden />} title="Compare the key fingerprint, obtained out of band">
                  <p>Send the fingerprint by a separate channel from the evidence — a call, a signed letter, your letterhead — so the auditor does not have to trust the key inside the file.</p>
                  <div className="mt-2 flex items-center gap-2 border border-line bg-sunken/60 px-3 py-2">
                    <span className="font-mono text-sm tracking-wide break-all flex-1">{s.fingerprint}</span>
                    <CopyButton text={s.fingerprint} label="Copy" />
                  </div>
                  <p className="mt-1.5 text-xs text-subtle">{f.custody.provider} · {f.custody.heldBy === 'customer' ? 'held by you' : 'held by elan1'} · {plural(fps, 'public key')} in this window{canSee('/agents/keys') && <> · <Link to="/agents/keys?tab=signing" className="link">Signing keys</Link></>}</p>
                </Check>
              </ol>
            )}
          </Panel>

          <WriteTypePanel rows={data?.byWriteType} loading={loading} />

          <Panel title="Assurance levels" kicker="Where this organisation stands" actions={<Button size="sm" variant="ghost" iconRight={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => nav('/assurance/levels')}>See the ladder</Button>} flush>
            {!f ? (error ? <p className="p-5 text-sm text-muted">The level could not be loaded.</p> : <div className="p-5"><Skeleton className="h-40" /></div>) : (
              <ul className="divide-y divide-line">
                {LEVELS.map((l) => {
                  const rank = levelRank(l) - levelRank(level);
                  const reached = f.lv.history.find((h) => h.level === l);
                  return (
                    // the upgrade preview is for owners, who can change the plan
                    <LevelRow key={l} code={LEVEL_INFO[l].tag} name={PLANS[l].name} state={rank === 0 ? 'here' : rank < 0 ? 'included' : 'available'} since={reached?.from} to={rank > 0 && isOwner ? `/assurance/upgrade?to=${l}` : undefined}>
                      {LEVEL_COPY[l].question} Records are {claimFor(l)}.
                    </LevelRow>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-5 space-y-6">
          <Panel title="What it does not prove" kicker={`Stated limits at ${LEVEL_INFO[level].short}`} footer="Say these out loud when you hand evidence over. They are part of the claim, not small print.">
            {error && !data ? <p className="text-sm text-muted">The limits depend on the level, which could not be loaded.</p> : !s || !f ? <Skeleton className="h-56" /> : (
              <ul className="space-y-4 text-sm">
                {limitsFor(level).map((x) => <Limit key={x.title} title={x.title}>{x.text}</Limit>)}
                {s.unanchored > 0 && <Limit title="After the last checkpoint">{plural(s.unanchored, 'receipt')} after the last checkpoint are {atLeast(level, 'l2') ? 'signed' : 'sealed'} and linked, but a cut-off tail is only detectable once a checkpoint{atLeast(level, 'l2') ? ' or a timestamped batch' : ''} covers it.</Limit>}
                <Limit title="Enforcement everywhere">Only the MCP governed run holds the credential and refuses before the call. On REST and SDK, Elan1 Govern advises and records; the agent runs the call. {s.agents.advisory > 0 ? `${plural(s.agents.advisory, 'agent')} here use${s.agents.advisory === 1 ? 's' : ''} that route.` : 'No agent here uses that route.'}</Limit>
                <Limit title="Calls that never reached the guard">Calls rejected before the guard — an invalid key or the rate limit — leave no receipt.</Limit>
              </ul>
            )}
          </Panel>

          <Panel title="Integrity runs" kicker="Nightly at 02:00 IST" footer={<Link to="/evidence?tab=integrity" className="link">Runs, the continuity report and a check on demand</Link>}>
            {error && !data ? <p className="text-sm text-muted">The runs need the chain, which could not be loaded.</p> : <IntegritySummary report={data?.integrity} />}
          </Panel>

          {data && data.refusals.refused.length > 0 && canSee('/assurance/refusals') && (
            <Panel title="Latest refusals" kicker="Refusals are evidence" flush footer={<Link to="/assurance/refusals" className="link">All refusals and what they cost</Link>}>
              <ul className="divide-y divide-line">
                {data.refusals.refused.slice(-4).reverse().map((r) => (
                  <li key={r.seq} className="px-5 py-3 flex items-start gap-3">
                    <ReceiptLink seq={r.seq} className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="truncate"><span className="font-medium">{r.agent ?? 'Elan1 Govern'}</span> <span className="text-muted">· {r.tool ?? r.action}</span></p>
                      <p className="text-xs text-muted truncate">{r.reason ?? r.rule_id}</p>
                    </div>
                    <When iso={r.ts} className="text-xs text-subtle shrink-0" />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      <ExportPackDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}

/* ── Enforcement mode per write type ──────────────────────── */

interface WriteTypeMode { writeType: string; governed: number; advisory: number; mode: 'enforced' | 'advisory' | 'mixed' }

/** Decisions per write type (the tool a decision names): governed run (MCP, enforced) and check and record (REST or SDK, advisory). */
function writeTypeModes(receipts: { kind: string; tool?: string; details?: Record<string, string | number | boolean> }[]): WriteTypeMode[] {
  const by = new Map<string, { governed: number; advisory: number }>();
  for (const r of receipts) {
    if (r.kind !== 'decision' || !r.tool) continue;
    const m = r.details?.mode;
    if (m !== 'governed_run' && m !== 'check_and_record') continue;
    const row = by.get(r.tool) ?? { governed: 0, advisory: 0 };
    if (m === 'governed_run') row.governed++; else row.advisory++;
    by.set(r.tool, row);
  }
  return Array.from(by.entries())
    .map(([writeType, x]) => ({ writeType, ...x, mode: x.governed && x.advisory ? 'mixed' as const : x.governed ? 'enforced' as const : 'advisory' as const }))
    .sort((a, b) => b.governed + b.advisory - (a.governed + a.advisory) || a.writeType.localeCompare(b.writeType));
}

const WRITE_TYPE_MODE: Record<WriteTypeMode['mode'], { label: string; tone: 'ok' | 'held' | 'neutral' }> = {
  enforced: { label: 'Enforced · Governed run', tone: 'ok' },
  advisory: { label: 'Advisory · Check and record', tone: 'held' },
  mixed: { label: 'Both routes', tone: 'neutral' },
};

function WriteTypePanel({ rows, loading }: { rows?: WriteTypeMode[]; loading: boolean }) {
  return (
    <Panel title="Enforcement mode by write type" kicker="Last 7 days · from the chain" flush
      footer="Governed run (MCP): Elan1 Govern holds the credential, so a refused call cannot run. Check and record (REST or SDK): Elan1 Govern decides and records; the agent runs the call with its own credentials. Every export states the mode for its range.">
      {loading && !rows ? <div className="p-5"><Skeleton className="h-28" /></div> : !rows?.length ? (
        <p className="px-5 py-4 text-sm text-muted">No agent decisions in the last 7 days.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Enforcement mode for each write type over the last 7 days</caption>
            <thead className="bg-sunken/60"><tr className="border-b border-line">
              <th scope="col" className="label text-left px-5 h-8">Write type</th>
              <th scope="col" className="label text-left px-3 h-8">Mode</th>
              <th scope="col" className="label text-right px-3 h-8">Governed run</th>
              <th scope="col" className="label text-right px-5 h-8">Check and record</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 12).map((r) => (
                <tr key={r.writeType} className="border-b border-line last:border-b-0 h-10">
                  <td className="px-5 font-mono text-[12.5px] break-all">{r.writeType}</td>
                  <td className="px-3"><StatusChip size="sm" tone={WRITE_TYPE_MODE[r.mode].tone}>{WRITE_TYPE_MODE[r.mode].label}</StatusChip></td>
                  <td className="px-3 text-right num">{n(r.governed)}</td>
                  <td className="px-5 text-right num">{n(r.advisory)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 12 && <p className="px-5 py-2 text-xs text-muted border-t border-line">Showing the 12 busiest of {n(rows.length)} write types.</p>}
        </div>
      )}
    </Panel>
  );
}

/* ── Pieces ───────────────────────────────────────────────── */

/**
 * The tiles a role and plan can open, numbered in order. The grid is filled to whole rows with blank cells, so a
 * tile left out (a screen above the plan, or one the role cannot open) leaves no grey hole.
 */
function TileGrid({ children, className }: { children: ReactNode; className?: string }) {
  const tiles = Children.toArray(children).filter(isValidElement) as ReactElement<{ n?: number }>[];
  const k = tiles.length;
  const smFill = k % 2 ? 1 : 0;
  const xlFill = (4 - (k % 4)) % 4;
  return (
    <div className={cn('grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-px bg-line border border-line', className)}>
      {tiles.map((t, i) => cloneElement(t, { n: i + 1 }))}
      {Array.from({ length: Math.max(smFill, xlFill) }).map((_, i) => (
        <div key={`fill-${i}`} aria-hidden className={cn('hidden bg-surface', i < smFill && 'sm:block', i < xlFill ? 'xl:block' : 'xl:hidden')} />
      ))}
    </div>
  );
}

function Tile({ n: num = 0, label, icon, value, status, children, to, cta, tag, loading }: {
  n?: number; label: string; icon: ReactNode; value: ReactNode; status?: ReactNode; children?: ReactNode; to?: string; cta: string; tag?: string; loading?: boolean;
}) {
  const body = (
    <div className={cn('group relative h-full bg-surface p-5 flex flex-col', to && 'hover:bg-sunken/40 transition-colors')}>
      <div className="flex items-center justify-between gap-2">
        <p className="label inline-flex items-center gap-1.5"><span className="num text-accent-fg">{String(num).padStart(2, '0')}</span>{label}{tag && <span className="ml-1 inline-flex h-4 items-center border border-line-strong px-1 text-[10px] font-mono text-muted" title={`Starts at ${tag}`}>{tag}</span>}</p>
        <span className="text-muted">{icon}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2 min-h-[40px]">
        {loading ? <Skeleton className="h-8 w-24" /> : <span className={cn('font-display text-4xl font-semibold tracking-tighter2 num leading-none', tag && 'text-muted')}>{value}</span>}
      </div>
      {status && !loading && <div className="mt-2 flex flex-wrap items-center gap-1.5">{status}</div>}
      <div className="mt-3 space-y-1 text-sm text-muted leading-snug">
        {loading ? <><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /></> : children}
      </div>
      <p className={cn('mt-auto pt-4 inline-flex items-center gap-1 text-sm font-medium', to ? 'text-fg' : 'text-subtle')}>
        {to ? <>{cta}{tag ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />}</> : 'Owners and admins only'}
      </p>
    </div>
  );
  return to ? <Link to={to} className="block h-full focus-visible:relative focus-visible:z-10" aria-label={`${label}: ${cta}`}>{body}</Link> : <div className="h-full">{body}</div>;
}

function Check({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center border border-line bg-sunken/60 text-fg">{icon}</span>
      <div className="min-w-0 flex-1 text-sm text-muted leading-relaxed">
        <p className="font-medium text-fg mb-1">{title}</p>
        {children}
      </div>
    </li>
  );
}

function Limit({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="border-l-[3px] border-line-strong pl-3">
      <p className="font-medium text-fg">{title}</p>
      <p className="mt-0.5 text-muted leading-relaxed">{children}</p>
    </li>
  );
}

function LevelRow({ code, name, state, since, to, children }: { code: string; name: string; state: 'here' | 'included' | 'available'; since?: string; to?: string; children: ReactNode }) {
  return (
    <li className={cn('px-5 py-4 flex gap-4', state === 'here' && 'bg-sunken/40')}>
      <span className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center font-display text-sm font-semibold border', state === 'here' ? 'bg-fg text-canvas border-fg' : 'border-line text-muted')}>{code}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{name}</p>
          {state === 'here' && <StatusChip size="sm" tone="inverse" icon={<Layers className="h-3 w-3" aria-hidden />}>Here{since ? ` since ${date(since)}` : ''}</StatusChip>}
          {state === 'included' && <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Included</StatusChip>}
          {state === 'available' && to && <Link to={to} className="text-sm link inline-flex items-center gap-1">Preview the upgrade<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}
        </div>
        <p className="mt-1 text-sm text-muted leading-relaxed">{children}</p>
      </div>
    </li>
  );
}
