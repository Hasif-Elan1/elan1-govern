import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, Download, Stamp } from 'lucide-react';
import { api, db } from '@/api';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { merkleRoot } from '@/lib/merkle';
import { date, dateTime, n, pct, plural, seqLabel, timeShort } from '@/lib/format';
import type { TsaAuthority } from '@/types';
import { Badge, Banner, Button, DataTable, EmptyState, Hash, PageHeader, Panel, Segmented, Skeleton, Stat, StatusChip, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { downloadText } from '@/features/activity/shared';
import { UpgradeCallout, levelStartMs } from '@/features/evidence/levelGate';
import { anchorNow, nextWindowEnd, onDemandBatches, pendingToAnchor, TARGET_SECONDS, tsaShort, WINDOW_MS, type ViewBatch } from './anchorLocal';
import { delayText } from './proof';
import { BatchDrawer, InclusionLookup, LagChart } from './parts';

export default function AnchorsPage() {
  const orgId = useOrgId();
  const level = useOrgLevel();
  const enabled = atLeast(level, 'l2');
  const { data, loading, error, refetch } = useQuery((o) => api.anchors(o, 100000), [level], { kinds: ['receipt', 'level', 'anchor'] });

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Timestamps"
        description="Every 15 minutes the new receipts are batched into a Merkle tree and its root is timestamped by two independent authorities, so nobody — including the key-holder — can back-date a rewrite."
        meta={data?.since ? <Badge>Since {date(data.since)}</Badge> : undefined}
      />
      {error && <Banner tone="bad" title="Timestamps could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {loading && !data ? <Skeleton className="h-64" /> : data && (enabled && data.enabled ? <Live view={data} orgId={orgId} /> : <Preview orgId={orgId} authorities={data.authorities} />)}
    </div>
  );
}

/* ── L2 and above ──────────────────────────────────────────── */

function Live({ view, orgId }: { view: Awaited<ReturnType<typeof api.anchors>>; orgId: string }) {
  const user = useUser();
  const canAnchor = useCan('evidence.checkpoint');
  const now = useNow(15_000);
  const [sp, setSp] = useSearchParams();
  const [filter, setFilter] = useState<'all' | 'late' | 'demand'>('all');
  const [shown, setShown] = useState(25);
  const [open, setOpen] = useState<ViewBatch>();
  const level = useOrgLevel();
  const sealedFrom = levelStartMs(orgId, 'l2') ?? 0;
  const lastRegular = view.totals.lastAnchoredSeq ?? 0;
  const onDemand = useMemo(() => onDemandBatches(orgId, lastRegular), [orgId, lastRegular, view]);
  const [anchoring, setAnchoring] = useState(false);

  const pending = useMemo(() => pendingToAnchor(orgId, lastRegular, sealedFrom),
    [orgId, view, onDemand, lastRegular, sealedFrom]);

  const sealedFromSeq = db.getDB(orgId).receipts.find((r) => new Date(r.ts).getTime() >= sealedFrom)?.seq;
  const rows: ViewBatch[] = useMemo(() => {
    const all = [...onDemand.filter((b) => !b.covered), ...view.batches];
    return filter === 'late' ? all.filter((b) => b.status === 'late') : filter === 'demand' ? onDemand : all;
  }, [onDemand, view.batches, filter]);

  const doAnchor = async () => {
    if (!user) return;
    setAnchoring(true);
    try {
      // owners and admins only, checked by the API as well as here; an export then carries the batch in anchors.json
      const b = await anchorNow(orgId, user.id);
      toast.ok(`${plural(b.count, 'record')} timestamped now`, <>Root {b.root.slice(0, 12)}… timestamped by both authorities. Recorded as {seqLabel(b.recordedSeq!)}; exports from now on carry this batch.</>);
    } catch (e) { toast.bad('Nothing was anchored', (e as Error).message); }
    finally { setAnchoring(false); }
  };

  const incident = view.incidents[0];
  const hhmm = (iso: string) => timeShort(iso);
  const auth = view.authorities;
  /** Every authority whose tokens appear here, including the hosted pair that stamped batches before a move to Sovereign. */
  const checkAuth = view.previousAuthorities?.length ? [...auth, ...view.previousAuthorities] : auth;
  const sovereign = level === 'sovereign';
  // owners and admins anchor on demand; other roles see no button (only the "nothing waiting" case stays disabled)
  const anchorWhy = pending === 0 ? 'Every sealed record is already timestamped.' : undefined;

  const cols: Column<ViewBatch>[] = [
    { key: 'win', header: 'Batch closed', cell: (b) => <span className="text-sm whitespace-nowrap" title={`${dateTime(b.windowStart)} – ${timeShort(b.windowEnd)}`}>{dateTime(b.windowEnd)}</span>, sort: (b) => b.windowEnd },
    { key: 'range', header: 'Records', cell: (b) => <span className="font-mono text-[12px] whitespace-nowrap">{seqLabel(b.firstSeq)}–{seqLabel(b.lastSeq)} <span className="text-muted">({n(b.count)})</span></span> },
    { key: 'root', header: 'Merkle root', cell: (b) => <Hash value={b.root} len={10} />, hideBelow: 'md' },
    ...auth.map((a, i): Column<ViewBatch> => ({
      key: `t${i}`, header: tsaShort(a.name), hideBelow: i === 0 ? 'sm' : 'lg',
      cell: (b) => { const t = b.tokens[i]; return t ? <span className="text-sm num whitespace-nowrap">{hhmm(t.genTime)} <span className="text-muted">+{delayText(t.delaySeconds)}</span></span> : <span className="text-subtle">—</span>; },
    })),
    { key: 'status', header: 'Status', cell: (b) => b.onDemand ? <StatusChip tone="info" size="sm" icon={<Stamp className="h-3 w-3" aria-hidden />}>On demand</StatusChip> : b.status === 'late'
      ? <StatusChip tone="held" size="sm" icon={<AlertTriangle className="h-3 w-3" aria-hidden />}>Late, recovered</StatusChip>
      : <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Both within 15 min</StatusChip> },
  ];

  return (
    <div className="space-y-6">
      {incident && (
        <Banner tone={incident.status === 'open' ? 'held' : 'neutral'}
          title={`Anchoring degraded since ${hhmm(incident.from)} IST on ${date(incident.from)} — ${plural(incident.records, 'record')} unanchored`}
          actions={incident.status === 'recovered' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Recovered {incident.to ? `at ${hhmm(incident.to)}` : ''}</StatusChip> : undefined}>
          {incident.summary}
        </Banner>
      )}

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Stat label="Batches timestamped" value={n(view.totals.batches + onDemand.length)} sub={onDemand.length ? `${n(onDemand.length)} on demand` : 'One per 15-minute window with records'} />
        <Stat label="Records timestamped" value={n(view.totals.anchoredRecords)} sub={view.totals.lastAnchoredSeq ? <>Up to <ReceiptLink seq={view.totals.lastAnchoredSeq} /></> : 'None yet'} />
        <Stat label="Within 15 minutes" value={pct(view.totals.withinTargetPct, view.totals.withinTargetPct < 1 ? 1 : 0)} sub="Batches where both tokens arrived in time" />
        <Stat label="Waiting for a batch" value={n(pending)} sub={pending ? `Next batch at ${timeShort(new Date(nextWindowEnd(now)).toISOString())} IST` : 'Nothing waiting'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-8 space-y-6">
          <Panel title="Minutes from batch close to timestamp" kicker={`Last ${Math.min(48, view.batches.length)} batches`}>
            <LagChart batches={view.batches} authorities={auth} />
          </Panel>

          <Panel title="Merkle batches" kicker="RFC 6962 roots · RFC 3161 tokens" flush
            actions={<>
              <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`anchors-${db.getDB(orgId).org.slug}.json`, JSON.stringify({ authorities: auth, batches: rows }, null, 2))}>JSON</Button>
              {canAnchor && <Button size="sm" variant="primary" icon={<Stamp className="h-3.5 w-3.5" />} loading={anchoring} disabled={!!anchorWhy} title={anchorWhy} onClick={doAnchor}>Anchor now</Button>}
            </>}
            footer={rows.length > shown ? (
              <div className="flex items-center justify-between gap-3"><span className="num">Showing {n(shown)} of {n(rows.length)}</span><Button size="sm" variant="ghost" onClick={() => setShown((s) => s + 50)}>Show more</Button></div>
            ) : undefined}>
            <div className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-line">
              <Segmented size="sm" label="Filter batches" value={filter} onChange={(v) => { setFilter(v); setShown(25); }} options={[
                { value: 'all', label: 'All' }, { value: 'late', label: 'Late', count: view.batches.filter((b) => b.status === 'late').length }, { value: 'demand', label: 'On demand', count: onDemand.length },
              ]} />
              <span className="text-xs text-muted">{!canAnchor ? `${plural(pending, 'record')} waiting for the next batch.` : anchorWhy ?? `Anchor now closes the open window early: ${plural(pending, 'record')} waiting.`}</span>
            </div>
            <DataTable caption="Merkle batches" className="border-0" columns={cols} rows={rows.slice(0, shown)} rowKey={(b) => b.id} onRowClick={setOpen}
              empty={<EmptyState compact title={filter === 'all' ? 'No batch yet' : 'None in this filter'} disc="trail">{filter === 'demand' && canAnchor ? 'Use Anchor now to timestamp the open window before it closes.' : 'The first batch is timestamped when its 15-minute window closes.'}</EmptyState>} />
          </Panel>

          <Panel title="Inclusion proof for a receipt" kicker="Recomputed in this browser">
            <p className="text-sm text-muted mb-4">Each receipt’s hash is a leaf of its batch’s tree. The audit path below rebuilds the root one hash at a time; if it ends at the timestamped root, the receipt existed in this form no later than both genTimes.</p>
            <InclusionLookup initialSeq={Number(sp.get('seq')) || undefined} onDemand={onDemand} authorities={checkAuth} sealedFromSeq={sealedFromSeq} />
            {sp.get('seq') && <button className="mt-3 text-xs text-muted underline underline-offset-2" onClick={() => { const x = new URLSearchParams(sp); x.delete('seq'); setSp(x, { replace: true }); }}>Clear the receipt from the address</button>}
          </Panel>
        </div>

        <div className="lg:col-span-4 space-y-6">
          <AuthoritiesPanel authorities={auth} latest={view.batches[0]} sovereign={sovereign} />
          <Panel title="What a timestamp shows" tone="sunken">
            <ul className="space-y-2.5 text-sm leading-relaxed">
              <li><span className="font-medium">Existed no later than genTime.</span> <span className="text-muted">The root — and so every receipt under it — existed in this form when the authority signed.</span></li>
              <li><span className="font-medium">Two authorities, one in India.</span> <span className="text-muted">{sovereign ? 'Both run inside your network; their certificates are yours to publish.' : 'eMudhra (India) and one global authority. One answering alone is the degraded state.'}</span></li>
              <li><span className="font-medium">Not what happened.</span> <span className="text-muted">A timestamp does not show that the underlying action took place or was right; the receipt and its rulebook do that.</span></li>
            </ul>
          </Panel>
        </div>
      </div>

      <BatchDrawer batch={open} authorities={checkAuth} onClose={() => setOpen(undefined)} />
    </div>
  );
}

function AuthoritiesPanel({ authorities, latest, sovereign }: { authorities: TsaAuthority[]; latest?: ViewBatch; sovereign?: boolean }) {
  return (
    <Panel title={sovereign ? 'Your timestamp authorities' : 'Timestamp authorities'} kicker={`${authorities.length} independent · RFC 3161`} flush>
      <ul className="divide-y divide-line">
        {authorities.map((a, i) => {
          const t = latest?.tokens.find((x) => x.tsaId === a.id);
          return (
            <li key={a.id} className="px-5 py-4 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium min-w-0">{a.name}</p>
                {a.status === 'operational'
                  ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Operational</StatusChip>
                  : <StatusChip tone="held" size="sm" icon={<AlertTriangle className="h-3 w-3" aria-hidden />}>Degraded</StatusChip>}
              </div>
              <div className="flex flex-wrap gap-1.5"><Badge>{a.scope}</Badge><Badge>Authority {i + 1}</Badge></div>
              <p className="font-mono text-[12px] text-muted break-all">{a.url}</p>
              <p className="text-xs text-muted">Policy <span className="font-mono">{a.policyOid}</span> · key <span className="font-mono">{a.fingerprint}</span></p>
              {t && <p className="text-xs text-muted inline-flex items-center gap-1"><Clock3 className="h-3 w-3" aria-hidden />Last token {dateTime(t.genTime)}</p>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ── Below L2: a working preview and the upgrade path ─────── */

function Preview({ orgId, authorities }: { orgId: string; authorities: TsaAuthority[] }) {
  const windows = useMemo(() => {
    const rs = db.getDB(orgId).receipts;
    const groups = new Map<number, typeof rs>();
    for (const r of rs.slice(-400)) {
      const w = Math.floor(new Date(r.ts).getTime() / WINDOW_MS);
      (groups.get(w) ?? groups.set(w, []).get(w)!).push(r);
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]).slice(0, 6).map(([w, list]) => ({
      id: String(w), end: new Date((w + 1) * WINDOW_MS).toISOString(), first: list[0].seq, last: list[list.length - 1].seq, count: list.length, root: merkleRoot(list.map((r) => r.hash)),
    }));
  }, [orgId]);
  type W = (typeof windows)[number];
  const cols: Column<W>[] = [
    { key: 'end', header: 'Window closes', cell: (w) => <span className="text-sm whitespace-nowrap">{dateTime(w.end)}</span> },
    { key: 'range', header: 'Records', cell: (w) => <span className="font-mono text-[12px] whitespace-nowrap">{seqLabel(w.first)}–{seqLabel(w.last)} <span className="text-muted">({n(w.count)})</span></span> },
    { key: 'root', header: 'Merkle root, computed now', cell: (w) => <Hash value={w.root} len={14} />, hideBelow: 'sm' },
    { key: 'tsa', header: 'Timestamps', cell: () => <span className="text-xs text-muted">From {LEVEL_INFO.l2.short}</span>, hideBelow: 'md' },
  ];
  return (
    <div className="space-y-6">
      <UpgradeCallout orgId={orgId} to="l2" caps={['rfc3161_anchors', 'merkle_batches', 'seal_v6', 'kms_custody', 'evidence_bundle_8', 'six_code_verifier']}>
        {/* L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided. */}
        At {LEVEL_INFO.l1.label} receipts are sealed in a hash chain by Elan1 Govern, and an hourly checkpoint seals the head — not yet externally timestamped. From L2 every 15-minute batch is timestamped by {authorities.map((a) => tsaShort(a.name)).join(' and ')}, so the key-holder cannot back-date a rewrite. This page then lists each batch, both tokens, the anchoring lag and an inclusion proof for any receipt.
      </UpgradeCallout>
      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-8" title="Your last windows, batched as L2 would batch them" kicker="Preview from your own chain · read only" flush
          footer="The roots are real RFC 6962 roots over your current receipts. Nothing is sent to a timestamp authority at L1, and nothing here is recorded.">
          <DataTable caption="Preview of Merkle batches" className="border-0" columns={cols} rows={windows} rowKey={(w) => w.id} empty={<EmptyState compact title="No receipts yet" disc="trail">Batches appear once agents make calls.</EmptyState>} />
        </Panel>
        <div className="lg:col-span-4">
          <AuthoritiesPanel authorities={authorities} />
        </div>
      </div>
      <p className="text-xs text-muted">Timestamp target {TARGET_SECONDS / 60} minutes per batch. Records before the upgrade stay L1 — sealed in a hash chain, not timestamped — and keep verifying.</p>
    </div>
  );
}
