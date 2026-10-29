import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronsRight, Flag, Layers, Search, Stamp } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import type { AnchorBatch, Checkpoint, LevelBoundary, LevelId, Receipt } from '@/types';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { date, dateTime, n, relative, seqLabel, timeShort } from '@/lib/format';
import { Banner, Button, EmptyState, Input, PageHeader, Panel, Segmented, Skeleton, Stat } from '@/components/ui';
import { Legend, SERIES } from '@/components/charts';
import { KIND_META } from './shared';
import { ChainVerifier } from './VerifyResult';
import { CLAIM_L1, claimFor, levelOfReceipt } from './assurance';
import { UpgradeHint } from './UpgradeHint';
import { UnsignedIntervalsBanner } from '@/features/keys/UnsignedInterval';
import { ChainGapsPanel } from '@/features/records/gaps';

type Size = '30' | '60' | '120';

export default function ChainPage() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const size = (['30', '60', '120'].includes(sp.get('n') ?? '') ? sp.get('n') : '60') as Size;
  const at = Number(sp.get('at')) || undefined;
  const [jump, setJump] = useState('');

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [ev, state, anchors] = await Promise.all([api.evidence(o), api.level(o), api.anchors(o, 600)]);
    const head = ev.head?.seq ?? 0;
    const first = ev.first?.seq ?? 0;
    const k = Number(size);
    const to = at ? Math.min(head, at + Math.floor(k / 2)) : head;
    const from = Math.max(first, to - k + 1);
    const slice = api.chainSlice(o, from, to);
    const prevOfFirst = from > first ? api.chainSlice(o, from - 1, from - 1).receipts[0] : undefined;
    return { receipts: slice.receipts, checkpoints: ev.checkpoints, head, first, total: ev.total, lastCp: ev.checkpoints[0] as Checkpoint | undefined, state, anchors, prevOfFirst };
  }, [size, at], { kinds: ['receipt', 'checkpoint', 'key', 'level'] });

  const cpBySeq = useMemo(() => {
    const m = new Map<number, Checkpoint[]>();
    for (const c of data?.checkpoints ?? []) m.set(c.seq, [...(m.get(c.seq) ?? []), c]);
    return m;
  }, [data?.checkpoints]);
  const batchByLast = useMemo(() => new Map((data?.anchors.batches ?? []).map((b) => [b.lastSeq, b])), [data?.anchors]);
  const boundaryByFirst = useMemo(() => new Map((data?.state.boundaries ?? []).filter((b) => b.firstSeq !== undefined).map((b) => [b.firstSeq!, b])), [data?.state]);

  const scroller = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef<number>();
  useEffect(() => {
    const el = scroller.current;
    if (!el || !data?.receipts.length) return;
    const last = data.receipts[data.receipts.length - 1].seq;
    if (at) {
      const target = el.querySelector<HTMLElement>(`[data-seq="${at}"]`);
      if (target && lastSeqRef.current === undefined) el.scrollLeft = target.offsetLeft - el.clientWidth / 2 + target.clientWidth / 2;
    } else if (lastSeqRef.current === undefined || el.scrollWidth - el.scrollLeft - el.clientWidth < 400) {
      el.scrollTo({ left: el.scrollWidth, behavior: lastSeqRef.current === undefined ? 'auto' : 'smooth' });
    }
    lastSeqRef.current = last;
  }, [data, at]);
  useEffect(() => { lastSeqRef.current = undefined; }, [at, size]);

  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setSp(next, { replace: true });
  };

  const unanchored = data && data.lastCp ? data.head - data.lastCp.seq : undefined;
  const level: LevelId = data?.state.level ?? 'l1';
  const l2 = levelRank(level) >= 1;
  const lastAnchored = data?.anchors.totals.lastAnchoredSeq;
  const shownBoundaries = (data?.state.boundaries ?? []).filter((b) => !b.beforeWindow);

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Proof', to: '/evidence' }, { label: 'Chain explorer' }]}
        kicker="Assurance"
        title="Chain explorer"
        description={l2
          ? 'The most recent receipts as linked blocks, with signed checkpoints, 15-minute Merkle batches timestamped by two authorities, and the level boundary.'
          : 'The most recent receipts as linked blocks. Each block names the hash of the one before it; sealed checkpoints fix the chain head every hour and on demand.'}
        actions={
          <>
            {l2 && <Button variant="secondary" icon={<Layers className="h-4 w-4" />} onClick={() => nav('/assurance/anchors')}>Timestamps</Button>}
            <Button variant="secondary" icon={<Stamp className="h-4 w-4" />} onClick={() => nav('/evidence')}>Checkpoints and keys</Button>
          </>
        }
      />

      <UnsignedIntervalsBanner />

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-6">
        <Stat label="Chain head" value={data ? <Link to={`/activity/${data.head}`} className="font-mono hover:underline underline-offset-2">{seqLabel(data.head)}</Link> : '—'} sub={data && `${n(data.total)} receipts held in this console`} />
        <Stat label="First receipt" value={data ? <span className="font-mono">{seqLabel(data.first)}</span> : '—'} sub={data ? (data.first > 1 ? `Receipts before ${seqLabel(data.first)} are outside the window this console holds` : 'The chain starts here') : undefined} />
        <Stat label="Last checkpoint" value={data?.lastCp ? <span className="font-mono">{seqLabel(data.lastCp.seq)}</span> : '—'} sub={data ? (data.lastCp ? `${l2 ? 'Signed' : 'Sealed'} ${relative(data.lastCp.ts)} by ${data.lastCp.kid}` : 'None yet') : undefined} />
        <Stat label="Since last checkpoint" value={unanchored !== undefined ? n(unanchored) : '—'} sub={data ? (unanchored ? `Receipts not yet under a ${l2 ? 'signed' : 'sealed'} checkpoint` : 'The head is covered') : undefined} />
      </div>

      {data && l2 && (
        <div className="mb-6 grid gap-px bg-line border border-line md:grid-cols-3">
          <div className="bg-surface p-4">
            <p className="label">Level</p>
            <p className="mt-1 font-display text-lg font-semibold">{LEVEL_INFO[level].label}</p>
            <p className="text-xs text-muted">since {date(data.state.since)}</p>
          </div>
          <div className="bg-surface p-4">
            <p className="label">Boundary</p>
            {shownBoundaries.length ? shownBoundaries.map((b) => (
              <p key={b.at} className="mt-1 text-sm"><span className="font-medium">{LEVEL_INFO[b.from].short} → {LEVEL_INFO[b.to].short}</span> on {date(b.at)}: <span className="num">{n(b.recordsBefore)}</span> records before, <span className="num">{n(b.recordsAfter)}</span> after{b.firstSeq !== undefined && <> · <button type="button" className="font-mono underline underline-offset-2" onClick={() => set({ at: String(b.firstSeq) })}>{seqLabel(b.firstSeq)}</button></>}</p>
            )) : <p className="mt-1 text-sm text-muted">Every receipt this console holds was written at {LEVEL_INFO[level].short}{data.state.boundaries.length ? ' (the boundary is earlier than the first receipt held)' : ''}.</p>}
          </div>
          <div className="bg-surface p-4">
            <p className="label">Timestamped batches</p>
            <p className="mt-1 text-sm"><span className="font-display text-lg font-semibold num">{n(data.anchors.totals.batches)}</span> batches, <span className="num">{n(data.anchors.totals.anchoredRecords)}</span> records</p>
            <p className="text-xs text-muted">{data.anchors.totals.unanchoredTail ? `${n(data.anchors.totals.unanchoredTail)} newest records wait for their batch to close` : 'Nothing waiting'} · {Math.round(data.anchors.totals.withinTargetPct * 100)}% within 15 minutes</p>
          </div>
        </div>
      )}

      <Panel
        title="Linked blocks"
        kicker={data?.receipts.length ? `${seqLabel(data.receipts[0].seq)} – ${seqLabel(data.receipts[data.receipts.length - 1].seq)}` : undefined}
        actions={<Segmented<Size> size="sm" label="Blocks shown" value={size} onChange={(v) => set({ n: v === '60' ? undefined : v })} options={[{ value: '30', label: '30' }, { value: '60', label: '60' }, { value: '120', label: '120' }]} />}
        flush
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-line">
          <Legend items={[{ label: 'Allowed', color: SERIES.allow }, { label: 'Asked a person', color: SERIES.ask }, { label: 'Refused', color: SERIES.refuse }, { label: 'No decision (admin, outcome)', color: 'rgb(var(--line-strong))' }]} />
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); const s = Number(jump.replace(/[#,\s]/g, '')); if (s) set({ at: String(s) }); }}>
            <Input aria-label="Jump to a sequence number" mono value={jump} onChange={(e) => setJump(e.target.value)} placeholder="#3412" className="h-8 w-28 text-sm" />
            <Button size="sm" type="submit" icon={<Search className="h-3.5 w-3.5" />}>Jump</Button>
            {at && <Button size="sm" variant="ghost" icon={<ChevronsRight className="h-3.5 w-3.5" />} onClick={() => { setJump(''); set({ at: undefined }); }}>Latest</Button>}
          </form>
        </div>
        {l2 && <p className="px-5 py-2 border-b border-line text-xs text-muted flex flex-wrap gap-x-4 gap-y-1"><span className="inline-flex items-center gap-1"><Stamp className="h-3 w-3" aria-hidden />Signed checkpoint</span><span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" aria-hidden />Merkle batch, timestamped by two authorities</span><span className="inline-flex items-center gap-1"><Flag className="h-3 w-3" aria-hidden />Level boundary</span></p>}
        {error && <div className="p-5"><Banner tone="bad" title="The chain could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner></div>}
        {loading && !data ? (
          <div className="flex gap-3 p-5 overflow-hidden">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[200px] w-[176px] shrink-0" />)}</div>
        ) : data && data.receipts.length === 0 ? (
          <EmptyState compact title="No receipts in this range" disc="trail">The chain is empty here. Pick a different sequence number.</EmptyState>
        ) : data && (
          <div ref={scroller} className="overflow-x-auto" tabIndex={0} aria-label="Receipt chain, scroll horizontally">
            <ol className="flex items-stretch gap-0 px-5 py-6 w-max">
              <li className="flex items-center pr-2" aria-hidden>
                <div className="flex flex-col items-center text-center w-24 text-xs text-muted">
                  <span className="font-mono">{data.prevOfFirst ? seqLabel(data.prevOfFirst.seq) : 'before window'}</span>
                  <span className="mt-1 font-mono text-[10.5px] text-subtle">{data.receipts[0].prev_hash.slice(0, 8)}…</span>
                </div>
              </li>
              {data.receipts.map((r, i) => {
                const prev = i === 0 ? data.prevOfFirst : data.receipts[i - 1];
                const linked = !prev || prev.hash === r.prev_hash;
                const lv = levelOfReceipt(r, data.state.history, level);
                const sealed = levelRank(lv) >= 1;
                return (
                  <BlockWithLink key={r.seq} r={r} linked={linked} highlight={at === r.seq} checkpoints={cpBySeq.get(r.seq)} batch={batchByLast.get(r.seq)}
                    boundary={boundaryByFirst.get(r.seq)} signedCp={sealed} levelNote={l2 ? (sealed ? (lastAnchored !== undefined && r.seq <= lastAnchored ? 'Sealed · timestamped' : 'Sealed · batch open') : `${LEVEL_INFO[lv].short} · no Seal v6`) : undefined} />
                );
              })}
            </ol>
          </div>
        )}
        <p className="px-5 py-3 border-t border-line text-xs text-muted">Click a block to open the receipt. Arrows point backwards: each receipt carries the hash of the one before it, so changing any receipt breaks every link after it.</p>
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-7" title="Verify the whole chain" kicker="In this browser">
          <p className="text-sm text-muted mb-4">{l2
            ? 'Runs the offline verifier over this organisation’s records: six result codes, a nine-section report and the verifier profile you choose. The quick check covers signatures, hashes, links and checkpoints.'
            : <>Runs the same checks as <span className="font-mono">govern verify</span> over every receipt and checkpoint this browser holds for the organisation: Ed25519 seal, key valid when sealed, content hash, previous-hash link and checkpoint inclusion.</>}</p>
          <ChainVerifier />
        </Panel>
        <ProvesPanel level={level} boundary={shownBoundaries[0]} />
      </div>

      <ChainGapsPanel className="mt-6" />
    </div>
  );
}

function ProvesPanel({ level, boundary }: { level: LevelId; boundary?: LevelBoundary }) {
  const l2 = levelRank(level) >= 1;
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signed = l2 ? 'signed' : 'sealed';
  return (
    <Panel className="lg:col-span-5" title="What this proves — and what it does not" tone="sunken">
      <div className="space-y-4 text-sm leading-relaxed">
        <div>
          <p className="label mb-1.5">Proves</p>
          <ul className="list-disc pl-4 space-y-1 text-fg/85">
            <li>No receipt in the window was changed after it was {signed}.</li>
            <li>None was removed, reordered or inserted between the first and the last.</li>
            <li>The {signed} checkpoints match the chain heads they name, so a cut-off tail shows.</li>
            {l2 && <li>Every sealed record’s 16 fields are as signed, and it existed no later than the time two independent authorities stamped its batch.</li>}
            {levelRank(level) >= 2 && <li>The key is yours: it lives in your HSM, so Elan1 Govern cannot sign as you.</li>}
          </ul>
        </div>
        <div>
          <p className="label mb-1.5">Does not prove</p>
          <ul className="list-disc pl-4 space-y-1 text-fg/85">
            {!l2 && <li>Who held the key. {CLAIM_L1} The key-holder could re-seal a rewritten chain.</li>}
            {level === 'l2' && <li>Who used the key. {claimFor('l2')} Elan1 Govern operates the KMS key, so an insider could sign new records — but could not back-date them past both timestamps.</li>}
            {l2 && <li>Anything in the newest batch before both authorities stamp it (the unanchored tail).</li>}
            {l2 && boundary && <li>More than L1 for records before {date(boundary.at)}: they are sealed in a hash chain by a key Elan1 Govern held, with no Seal v6 record and no timestamp.</li>}
            <li>That the underlying transactions happened, or that the rules were the right rules.</li>
            <li>Calls rejected before the guard (bad key, rate limit) — they produce no receipt.</li>
          </ul>
        </div>
        {!l2 && <UpgradeHint compact to="l2" title="Timestamps from two authorities close the key-holder gap.">From L2 Attested every 15-minute batch is timestamped by eMudhra and a global authority, and the key moves into AWS KMS.</UpgradeHint>}
        <p className="text-xs text-muted">{l2 ? 'For an independent check' : 'To check it outside the console'}, export {l2 ? 'an evidence bundle' : 'an auditor pack'} and run <span className="font-mono">govern verify</span> offline with the organisation’s published key. <Link to="/verify" className="underline underline-offset-2 hover:text-fg">Open the web verifier</Link>.</p>
      </div>
    </Panel>
  );
}

function BlockWithLink({ r, linked, highlight, checkpoints, batch, boundary, levelNote, signedCp }: { r: Receipt; linked: boolean; highlight: boolean; checkpoints?: Checkpoint[]; batch?: AnchorBatch; boundary?: LevelBoundary; levelNote?: string; signedCp?: boolean }) {
  const meta = KIND_META[r.kind];
  const Icon = meta.icon;
  const edge = r.decision === 'allow' ? 'border-l-ok' : r.decision === 'ask' ? 'border-l-held' : r.decision === 'refuse' ? 'border-l-bad' : 'border-l-line-strong';
  const label = r.decision === 'allow' ? 'Allowed' : r.decision === 'ask' ? 'Asked' : r.decision === 'refuse' ? 'Refused' : 'Recorded';
  const labelTone = r.decision === 'allow' ? 'text-ok-fg' : r.decision === 'ask' ? 'text-held-fg' : r.decision === 'refuse' ? 'text-bad-fg' : 'text-muted';
  return (
    <>
      {boundary && (
        <li className="flex items-stretch shrink-0 pr-2" title={`Level boundary: ${LEVEL_INFO[boundary.from].label} → ${LEVEL_INFO[boundary.to].label} on ${dateTime(boundary.at)}`}>
          <div className="flex flex-col items-center justify-center gap-1 w-[104px] border-x-2 border-fg bg-sunken/60 px-1 text-center">
            <Flag className="h-4 w-4" aria-hidden />
            <span className="text-[10px] font-semibold uppercase tracking-label">{LEVEL_INFO[boundary.from].tag} → {LEVEL_INFO[boundary.to].tag}</span>
            <span className="text-[10px] text-muted num">{n(boundary.recordsBefore)} before</span>
            <span className="text-[10px] text-muted num">{n(boundary.recordsAfter)} after</span>
          </div>
        </li>
      )}
      <li className="flex items-center w-9 shrink-0" aria-hidden>
        <span className={cn('relative h-px w-full', linked ? 'bg-fg/60' : 'bg-bad')}>
          <ChevronLeft className={cn('absolute -left-1 -top-[7px] h-3.5 w-3.5', linked ? 'text-fg/60' : 'text-bad')} />
        </span>
      </li>
      <li data-seq={r.seq} className="shrink-0">
        <Link
          to={`/activity/${r.seq}?tab=chain`}
          className={cn('block w-[176px] h-full border border-l-[4px] bg-surface p-3 transition-colors hover:border-line-strong hover:bg-sunken/40 focus-visible:outline-2', edge, highlight ? 'border-fg shadow-[0_0_0_1px_rgb(var(--fg))]' : 'border-y-line border-r-line', 'animate-row-in')}
          aria-label={`Receipt ${seqLabel(r.seq)}, ${meta.label}, ${label}${levelNote ? `, ${levelNote}` : ''}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm font-semibold">{seqLabel(r.seq)}</span>
            <span className={cn('text-[11px] font-semibold uppercase tracking-label', labelTone)}>{label}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{r.agent ?? r.action ?? meta.label}</span>
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-subtle truncate" title={r.tool ?? r.action}>{r.tool ?? r.action ?? '—'}</p>
          <p className="mt-0.5 text-[11px] text-subtle num">{timeShort(r.ts)} IST</p>
          <div className="mt-2 space-y-1">
            <p className="flex items-center justify-between gap-2 text-[10.5px]"><span className="uppercase tracking-label text-subtle">hash</span><span className="font-mono text-fg">{r.hash.slice(0, 10)}</span></p>
            <p className="flex items-center justify-between gap-2 text-[10.5px]"><span className="uppercase tracking-label text-subtle">prev</span><span className={cn('font-mono', linked ? 'text-muted' : 'text-bad-fg')}>{r.prev_hash.slice(0, 10)}</span></p>
          </div>
          {levelNote && <p className="mt-1.5 border-t border-line pt-1 text-[10px] uppercase tracking-label text-muted truncate">{levelNote}</p>}
        </Link>
      </li>
      {checkpoints?.map((cp) => (
        <li key={cp.id} className="flex items-stretch shrink-0 pl-2" title={`Checkpoint at ${seqLabel(cp.seq)}, ${signedCp ? 'signed' : 'sealed'} ${dateTime(cp.ts)} by ${cp.kid}${cp.onDemand ? ' (on demand)' : ''}`}>
          <Link to="/evidence" className="flex flex-col items-center justify-center gap-1 w-[76px] border-x border-dashed border-line-strong text-muted hover:text-fg hover:bg-sunken/50" aria-label={`Checkpoint at ${seqLabel(cp.seq)}`}>
            <Stamp className="h-4 w-4" aria-hidden />
            <span className="text-[10px] font-semibold uppercase tracking-label">{cp.onDemand ? 'On demand' : 'Checkpoint'}</span>
            <span className="text-[10px] num">{timeShort(cp.ts)}</span>
          </Link>
        </li>
      ))}
      {batch && (
        <li className="flex items-stretch shrink-0 pl-2" title={`Merkle batch ${batch.id}: ${batch.count} receipts ${seqLabel(batch.firstSeq)}–${seqLabel(batch.lastSeq)}, root ${batch.root.slice(0, 16)}…, timestamped by ${batch.tokens.map((t) => t.tsaName).join(' and ')}`}>
          <Link to="/assurance/anchors" className={cn('flex flex-col items-center justify-center gap-1 w-[84px] border-x border-line-strong bg-sunken/40 text-muted hover:text-fg hover:bg-sunken', batch.status === 'late' && 'border-held')} aria-label={`Merkle batch of ${batch.count} receipts ending at ${seqLabel(batch.lastSeq)}, ${batch.tokens.length} timestamps${batch.status === 'late' ? ', late' : ''}`}>
            <Layers className="h-4 w-4" aria-hidden />
            <span className="text-[10px] font-semibold uppercase tracking-label">Batch · {batch.count}</span>
            <span className="text-[10px] num">{batch.tokens.length} stamps{batch.status === 'late' ? ' · late' : ''}</span>
            <span className="text-[10px] num">{timeShort(batch.windowEnd)}</span>
          </Link>
        </li>
      )}
    </>
  );
}
