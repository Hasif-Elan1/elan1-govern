import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, Download, PackageOpen, Pause, Play, Waypoints, X } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useUi } from '@/store/ui';
import { useOrgLevel } from '@/store/session';
import type { Decision, Receipt, ReceiptKind } from '@/types';
import { levelRank } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { n, pct, plural, timeShort, TZ } from '@/lib/format';
import { Banner, Button, DataTable, DecisionChip, EmptyState, Field, Hash, PageHeader, Panel, SearchInput, Segmented, Select, Skeleton, toast, type Column } from '@/components/ui';
import { AgentLink, Person, ReceiptLink, When } from '@/components/domain';
import { DecisionBars, Legend, SERIES } from '@/components/charts';
import { D, H, ISSUED_ACTIONS, KindMark, ModeChip, OutcomeCell, RECEIVED_ACTIONS, REFUSAL_CLASSES, REFUSAL_CLASSES_FULL, downloadText, receiptCsvRow, refusalClass, refusalClassFull, toCsv, type RefusalClassFull } from './shared';
import { ReceiptDrawer } from './ReceiptDrawer';
import { ExportRangeDialog } from './ExportRangeDialog';
import { LevelTag } from './UpgradeHint';
import { useScreenAccess } from '@/shell/access';

type RangeId = '1h' | '24h' | '7d' | 'all';
type DecisionFilter = Decision | 'all';
type KindFilter = ReceiptKind | 'all' | 'issued' | 'received';

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: TZ });
const RANGES: Record<RangeId, { ms?: number; label: string; bucket: number; fmt: (iso: string) => string }> = {
  '1h': { ms: H, label: '1 h', bucket: 5 * 60_000, fmt: timeShort },
  '24h': { ms: D, label: '24 h', bucket: H, fmt: timeShort },
  '7d': { ms: 7 * D, label: '7 d', bucket: 6 * H, fmt: (iso) => `${dayFmt.format(new Date(iso))} ${timeShort(iso)}` },
  all: { label: 'All', bucket: D, fmt: (iso) => dayFmt.format(new Date(iso)) },
};
const DEFAULTS: Record<string, string> = { range: '24h', d: 'all', kind: 'all', agent: '', tool: '', q: '', rc: '', open: '', fs: '', ts: '' };

/**
 * The refusal-class filter (?rc=). A plain class id matches the fine class (refusalClassFull), which is what
 * this page, Assurance › Refusals and Work › Not done count by. The folded shared class (refusalClass: 'rule'
 * including autonomy and pack refusals, 'default' including counterparty refusals) is accepted
 * as '<class>.all' (also '<class>.folded'), so a count made with refusalClass opens a list that matches it.
 */
interface RcFilter { id: RefusalClassFull; folded: boolean }
const FOLDED_SUFFIX = /\.(all|folded)$/;
function parseRc(raw: string): RcFilter | undefined {
  if (!raw) return undefined;
  const folded = FOLDED_SUFFIX.test(raw);
  const id = raw.replace(FOLDED_SUFFIX, '') as RefusalClassFull;
  if (!REFUSAL_CLASSES_FULL.some((c) => c.id === id)) return undefined;
  return { id, folded: folded && REFUSAL_CLASSES.some((c) => c.id === id) };
}
function matchRc(r: Receipt, f: RcFilter | undefined) {
  if (!f) return true;
  return f.folded ? refusalClass(r) === f.id : refusalClassFull(r) === f.id;
}
/** Level classes that fold into a shared class. */
const FOLDED_INTO: Partial<Record<RefusalClassFull, RefusalClassFull[]>> = { rule: ['autonomy', 'pack_gate'] };
const classLabel = (id: RefusalClassFull) => REFUSAL_CLASSES_FULL.find((c) => c.id === id)?.label ?? id;
function rcLabel(f: RcFilter | undefined) {
  if (!f) return 'Unknown';
  const folded = f.folded ? FOLDED_INTO[f.id] : undefined;
  return folded ? `${classLabel(f.id)}, including ${folded.map((x) => classLabel(x).toLowerCase()).join(' and ')}` : classLabel(f.id);
}
const PAGE = 100;

export default function ActivityPage() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const liveUpdates = useUi((s) => s.liveUpdates);
  const level = useOrgLevel();
  const a = useScreenAccess();
  const canExport = a.can('evidence.export');
  const l2 = levelRank(level) >= 1;
  const l3 = levelRank(level) >= 2;
  const get =(k: string) => sp.get(k) ?? DEFAULTS[k];
  const range = (RANGES[get('range') as RangeId] ? get('range') : '24h') as RangeId;
  const decision = get('d') as DecisionFilter;
  const rawKind = get('kind') as KindFilter;
  const kind: KindFilter = (rawKind === 'issued' || rawKind === 'received') && !l3 ? 'all' : rawKind;
  const agent = get('agent');
  const tool = get('tool');
  const q = get('q');
  const rc = get('rc');
  const rcFilter = useMemo(() => parseRc(rc), [rc]);
  // ?fs=&ts= limit the list to a sequence range (for example the receipts behind an invoice line)
  const fromSeq = Number(get('fs')) || undefined;
  const toSeq = Number(get('ts')) || undefined;
  const seqRange = fromSeq !== undefined || toSeq !== undefined;
  const openSeq = Number(get('open')) || undefined;

  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (!v || v === DEFAULTS[k]) next.delete(k);
      else next.set(k, v);
    }
    setSp(next, { replace: true });
    if (!('open' in patch)) setPage(1);
  };

  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const t = window.setTimeout(() => set({ q: search.trim() }), 260);
    return () => window.clearTimeout(t);
  }, [search]);

  const [page, setPage] = useState(1);
  const [exportOpen, setExportOpen] = useState(false);
  const crossKind = kind === 'issued' || kind === 'received';

  const { data, loading, error, refetch } = useQuery(
    (o) => api.receipts(o, { kind: crossKind ? 'all' : kind, agent: agent || undefined, tool: tool || undefined, q: q || undefined, from: RANGES[range].ms ? Date.now() - RANGES[range].ms! : undefined }),
    [range, kind, agent, tool, q],
  );
  const agents = useQuery((o) => api.agents(o), [], { kinds: ['agent'] });
  const connectors = useQuery((o) => api.connectors(o), [], { kinds: ['connector', 'receipt'] });
  const chainStart = useQuery(async (o) => (await api.evidence(o)).first, [], { live: false });
  const cross = useQuery((o) => (l3 ? api.crossOrgReceipts(o) : Promise.resolve([])), [l3], { kinds: ['receipt'] });
  const issuedSeqs = useMemo(() => new Set((cross.data ?? []).filter((x) => x.direction === 'issued').map((x) => x.seq)), [cross.data]);

  /* tools: every tool of every connector (including MCP servers added at run time) and every agent's tools */
  const tools = useMemo(() => {
    const s = new Set<string>();
    for (const c of connectors.data ?? []) for (const t of c.tools) s.add(t.name);
    for (const a of agents.data ?? []) for (const t of a.tools) s.add(t);
    if (tool) s.add(tool);
    return [...s].sort();
  }, [connectors.data, agents.data, tool]);

  const items = useMemo(() => {
    let all = data?.items;
    if (all && seqRange) all = all.filter((r) => (fromSeq === undefined || r.seq >= fromSeq) && (toSeq === undefined || r.seq <= toSeq));
    if (!all || !crossKind) return all;
    return all.filter((r) => (kind === 'issued' ? issuedSeqs.has(r.seq) || ISSUED_ACTIONS.includes(r.action ?? '') : RECEIVED_ACTIONS.includes(r.action ?? '')));
  }, [data?.items, crossKind, kind, issuedSeqs, seqRange, fromSeq, toSeq]);

  /* live tail: freeze the view when paused or scrolled, count what arrived since */
  const [paused, setPaused] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [frozenHead, setFrozenHead] = useState<number | null>(null);
  const head = items?.[0]?.seq;
  const live = liveUpdates && !paused && !scrolled;
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 360);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (live) setFrozenHead(null);
    else if (frozenHead === null && head !== undefined) setFrozenHead(head);
  }, [live, head, frozenHead]);

  const seenHead = useRef<number>();
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!items?.length || frozenHead !== null) return;
    const prev = seenHead.current;
    const top = items[0].seq;
    if (prev !== undefined && top > prev) setFresh(new Set(items.filter((r) => r.seq > prev).map((r) => r.seq)));
    seenHead.current = top;
  }, [items, frozenHead]);
  useEffect(() => { seenHead.current = undefined; }, [range, kind, agent, tool, q, fromSeq, toSeq]);

  const scoped = useMemo(() => (items && frozenHead !== null ? items.filter((r) => r.seq <= frozenHead) : items), [items, frozenHead]);
  const newCount = items && frozenHead !== null ? items.filter((r) => r.seq > frozenHead).length : 0;
  const showNew = () => {
    setPaused(false);
    setFrozenHead(head ?? null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const counts = useMemo(() => {
    const c = { all: 0, allow: 0, ask: 0, refuse: 0 };
    for (const r of scoped ?? []) { c.all++; if (r.decision) c[r.decision]++; }
    return c;
  }, [scoped]);

  const rows = useMemo(() => (scoped ?? []).filter((r) => (decision === 'all' || r.decision === decision) && matchRc(r, rcFilter)), [scoped, decision, rcFilter]);

  /* refusal classes shown: the shared six, plus the ones this level has (and any with receipts) */
  const refusals = useMemo(() => {
    const by = Object.fromEntries(REFUSAL_CLASSES_FULL.map((c) => [c.id, 0])) as Record<RefusalClassFull, number>;
    let total = 0;
    for (const r of scoped ?? []) { const c = refusalClassFull(r); if (c) { by[c]++; total++; } }
    const classes = REFUSAL_CLASSES_FULL.filter((c) => !c.level || levelRank(level) >= levelRank(c.level) || by[c.id] > 0);
    return { by, total, classes };
  }, [scoped, level]);

  const firstTs = chainStart.data?.ts;
  const chart = useMemo(() => {
    const cfg = RANGES[range];
    const now = Date.now();
    const list = rows.filter((r) => r.decision);
    const start = cfg.ms ? now - cfg.ms : firstTs ? new Date(firstTs).getTime() : list.length ? new Date(list[list.length - 1].ts).getTime() : now - D;
    const aligned = Math.floor(start / cfg.bucket) * cfg.bucket;
    const nb = Math.max(1, Math.min(240, Math.ceil((now - aligned) / cfg.bucket)));
    const buckets = Array.from({ length: nb }, (_, i) => ({ hour: new Date(aligned + i * cfg.bucket).toISOString(), allow: 0, ask: 0, refuse: 0 }));
    for (const r of list) {
      const i = Math.floor((new Date(r.ts).getTime() - aligned) / cfg.bucket);
      if (i >= 0 && i < nb) buckets[i][r.decision!]++;
    }
    return buckets;
  }, [rows, range, firstTs]);

  const allDays = firstTs ? Math.max(1, Math.round((Date.now() - new Date(firstTs).getTime()) / D)) : undefined;
  const allLabel = allDays ? `All · ${allDays} d` : 'All · —';
  const span = rows.length ? { from: rows[rows.length - 1].seq, to: rows[0].seq } : undefined;

  const exportCsv = () => {
    if (!rows.length) { toast.info('Nothing to export', 'Change the filters to include some receipts.'); return; }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadText(`receipts-${stamp}.csv`, toCsv(rows.map(receiptCsvRow)), 'text/csv;charset=utf-8');
    toast.ok(`Exported ${plural(rows.length, 'receipt')}`, `The CSV holds exactly the rows the filters show. For verifiable evidence, export ${l2 ? 'an evidence bundle' : 'an auditor pack'} for the range.`);
  };

  const filtersOn = decision !== 'all' || kind !== 'all' || agent || tool || q || rc || seqRange;
  const clear = () => { setSearch(''); set({ d: '', kind: '', agent: '', tool: '', q: '', rc: '', fs: '', ts: '' }); };

  const columns: Column<Receipt>[] = [
    { key: 'seq', header: 'Seq', cell: (r) => <ReceiptLink seq={r.seq} />, sort: (r) => r.seq, width: 88 },
    { key: 'time', header: 'Time', cell: (r) => <When iso={r.ts} className="text-sm text-muted" />, sort: (r) => r.ts, hideBelow: 'sm', width: 120 },
    { key: 'kind', header: 'Kind', cell: (r) => <span className="inline-flex items-center gap-1.5"><KindMark kind={r.kind} />{issuedSeqs.has(r.seq) && <span className="text-[10px] uppercase tracking-label text-muted border border-line px-1" title="Issued to a counterparty">Issued</span>}</span>, hideBelow: 'md' },
    { key: 'who', header: 'Agent or person', cell: (r) => (r.kind === 'admin' || (!r.agent && r.actor) ? <Person id={r.actor} size={20} /> : <AgentLink slug={r.agent} />), sort: (r) => r.agent ?? r.actor ?? '' },
    { key: 'what', header: 'Tool or action', cell: (r) => <span className="font-mono text-[12.5px] truncate block max-w-[220px]" title={r.tool ?? r.action}>{r.tool ?? r.action ?? '—'}</span>, hideBelow: 'sm' },
    { key: 'decision', header: 'Decision', cell: (r) => <DecisionChip decision={r.decision} size="sm" />, sort: (r) => r.decision ?? '' },
    { key: 'rule', header: 'Rule', cell: (r) => (r.rule_id ? <span className={cn('font-mono text-[12px]', r.decision === 'refuse' && 'text-bad-fg')}>{r.rule_id}</span> : <span className="text-subtle">—</span>), hideBelow: 'lg' },
    { key: 'mode', header: 'Route', cell: (r) => <ModeChip r={r} />, hideBelow: 'lg' },
    { key: 'outcome', header: 'Outcome', cell: (r) => <OutcomeCell r={r} />, hideBelow: 'lg' },
    { key: 'hash', header: 'Hash', cell: (r) => <Hash value={r.hash} len={10} />, hideBelow: 'md' },
  ];

  return (
    <div>
      <PageHeader
        kicker="Records"
        title="Activity"
        description={l2
          ? 'Every decision, approval, outcome and admin change, as signed, hash-chained receipts. Refusals are evidence too.'
          // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
          : 'Every decision, approval, outcome and admin change, as receipts sealed in a hash chain. Refusals are evidence too.'}
        meta={<span className="inline-flex items-center gap-2 text-sm text-muted"><LevelTag level={level} />{l2 ? 'Receipts from the boundary on are sealed and timestamped by two authorities.' : 'Receipts sealed in a hash chain by Elan1 Govern · not yet externally timestamped.'}</span>}
        actions={
          <>
            {a.canSee('/activity/chain') && <Button variant="secondary" icon={<Waypoints className="h-4 w-4" />} onClick={() => nav('/activity/chain')}>Chain explorer</Button>}
            <Button variant={canExport ? 'secondary' : 'primary'} icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!rows.length} title={!rows.length ? 'No receipts match the filters.' : undefined}>Export CSV</Button>
            {/* owners, admins and auditors export verifiable evidence; other roles do not see the button */}
            {canExport && <Button variant="primary" icon={<PackageOpen className="h-4 w-4" />} onClick={() => setExportOpen(true)} disabled={!span} title={!span ? 'No receipts match the filters.' : undefined}>{l2 ? 'Export evidence bundle' : 'Export auditor pack'}</Button>}
          </>
        }
      />

      {/* filters */}
      <div className="border border-line bg-surface p-3 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="max-w-full overflow-x-auto">
            <Segmented<RangeId> label="Time range" value={range} onChange={(v) => set({ range: v })} options={[
              { value: '1h', label: '1 h' }, { value: '24h', label: '24 h' }, { value: '7d', label: '7 d' }, { value: 'all', label: allLabel },
            ]} />
          </div>
          <div className="max-w-full overflow-x-auto">
            <Segmented<DecisionFilter> label="Decision" value={decision} onChange={(v) => set({ d: v, rc: v === 'refuse' ? rc : '' })} options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'allow', label: 'Allowed', count: counts.allow },
              { value: 'ask', label: 'Asked', count: counts.ask },
              { value: 'refuse', label: 'Refused', count: counts.refuse },
            ]} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className={cn('inline-flex items-center gap-1.5 text-xs', live ? 'text-ok-fg' : 'text-muted')} aria-live="polite">
              <span className={cn('h-2 w-2', live ? 'bg-ok animate-pulse' : 'bg-line-strong')} aria-hidden />
              {!liveUpdates ? 'Live updates off' : live ? 'Live' : scrolled && !paused ? 'Paused while scrolled' : 'Paused'}
            </span>
            <Button size="sm" variant="ghost" icon={paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} onClick={() => setPaused((p) => !p)} disabled={!liveUpdates} title={!liveUpdates ? 'Live updates are off in your preferences' : undefined}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[200px_200px_220px_1fr]">
          <Field label="Kind" htmlFor="f-kind">
            <Select id="f-kind" size_="sm" value={kind} onChange={(e) => set({ kind: e.target.value })}>
              <option value="all">All kinds</option>
              <option value="decision">Decisions</option>
              <option value="approval">Approvals</option>
              <option value="outcome">Outcomes</option>
              <option value="admin">Admin changes</option>
              {l3 && <option value="issued">Issued to counterparty</option>}
              {l3 && <option value="received">Received from counterparty</option>}
            </Select>
          </Field>
          <Field label="Agent" htmlFor="f-agent">
            <Select id="f-agent" size_="sm" value={agent} onChange={(e) => set({ agent: e.target.value })}>
              <option value="">All agents</option>
              {agents.data?.map((a) => <option key={a.slug} value={a.slug}>{a.slug}</option>)}
            </Select>
          </Field>
          <Field label="Tool" htmlFor="f-tool">
            <Select id="f-tool" size_="sm" value={tool} onChange={(e) => set({ tool: e.target.value })} className="font-mono">
              <option value="">All tools</option>
              {tools.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Search" htmlFor="f-q">
            <SearchInput id="f-q" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="#4097, a hash prefix, a vendor, a rule id…" />
          </Field>
        </div>
        {filtersOn && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{n(rows.length)} of {n(counts.all)} receipts match</span>
            {rc && <span className="inline-flex items-center gap-1 border border-line px-2 h-6 text-xs text-fg">Refusal class: {rcLabel(rcFilter)}<button aria-label="Clear refusal class" onClick={() => set({ rc: '' })}><X className="h-3 w-3" /></button></span>}
            {seqRange && <span className="inline-flex items-center gap-1 border border-line px-2 h-6 text-xs text-fg num">Receipts {fromSeq !== undefined ? `#${n(fromSeq)}` : 'start'}–{toSeq !== undefined ? `#${n(toSeq)}` : 'head'}<button aria-label="Clear the receipt range" onClick={() => set({ fs: '', ts: '' })}><X className="h-3 w-3" /></button></span>}
            <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>
          </div>
        )}
      </div>

      {error && <Banner tone="bad" title="Receipts could not be loaded" className="mt-4" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      {/* chart + refusal analytics */}
      <div className="mt-6 grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-7" title="Decisions in this range" actions={<Legend items={[{ label: 'Allowed', color: SERIES.allow }, { label: 'Asked a person', color: SERIES.ask }, { label: 'Refused', color: SERIES.refuse }]} />}>
          {(loading && !data) || (range === 'all' && chainStart.loading) ? <Skeleton className="h-[150px]" /> : <DecisionBars data={chart} height={150} xFmt={RANGES[range].fmt} />}
        </Panel>
        <Panel className="lg:col-span-5" title="Refusals by reason" kicker="Refusals are evidence" flush>
          {loading && !data ? <div className="p-5"><Skeleton className="h-[150px]" /></div> : refusals.total === 0 ? (
            <EmptyState compact title="No refusals in this view" disc="gate">Every call in this range was allowed or held for a person.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {refusals.classes.map((c) => {
                const v = refusals.by[c.id];
                const value = c.id;
                // a folded filter ('rule.all': with autonomy and pack refusals) marks every class it includes
                const on = !!rcFilter && (rcFilter.id === c.id || (rcFilter.folded && !!FOLDED_INTO[rcFilter.id]?.includes(c.id)));
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => set({ rc: rc === value ? '' : value, d: rc === value ? decision : 'refuse' })}
                      disabled={!v}
                      aria-pressed={on}
                      title={c.hint}
                      className={cn('w-full grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-5 py-2 text-left transition-colors disabled:opacity-50', on ? 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--bad))]' : 'hover:bg-sunken/60')}
                    >
                      <span className="text-sm inline-flex items-center gap-1.5">{c.label}{c.level && <LevelTag level={c.level} />}</span>
                      <span className="text-sm num font-medium">{n(v)} <span className="text-xs text-muted font-normal">{pct(v / refusals.total)}</span></span>
                      <span className="col-span-2 h-1 bg-sunken"><span className="block h-full bg-bad" style={{ width: `${(v / refusals.total) * 100}%` }} /></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* table */}
      <div className="mt-6 relative">
        {newCount > 0 && (
          <div className="sticky top-16 z-20 flex justify-center pointer-events-none -mb-10 h-10">
            <Button size="sm" variant="primary" className="pointer-events-auto shadow-e3" icon={<ArrowUp className="h-3.5 w-3.5" />} onClick={showNew}>
              {n(newCount)} new — show
            </Button>
          </div>
        )}
        <DataTable
          caption="Receipts"
          columns={columns}
          rows={loading && !data ? undefined : rows.slice(0, page * PAGE)}
          loading={loading}
          rowKey={(r) => r.seq}
          selectedKey={openSeq}
          onRowClick={(r) => set({ open: String(r.seq) })}
          rowClassName={(r) => (fresh.has(r.seq) ? 'animate-row-in' : undefined)}
          empty={
            <EmptyState compact title={filtersOn ? 'No receipts match these filters' : 'No receipts in this range'} disc="aperture"
              action={filtersOn ? <Button size="sm" onClick={clear}>Clear filters</Button> : range !== 'all' ? <Button size="sm" onClick={() => set({ range: 'all' })}>Show the whole window</Button> : undefined}>
              {crossKind ? (kind === 'issued' ? 'No receipt in this range was issued to a counterparty. Issue one from a receipt’s Signed receipt tab.' : 'No receipt from a counterparty was received or verified in this range.') : filtersOn ? 'Try a wider time range or clear a filter. Search matches a sequence number (#4097), a hash prefix or any text in a receipt.' : 'Agents have not made calls in this time range.'}
            </EmptyState>
          }
        />
        {rows.length > page * PAGE && (
          <div className="flex flex-wrap items-center justify-between gap-3 border border-t-0 border-line bg-surface px-4 py-3 text-sm text-muted">
            <span className="num">Showing {n(page * PAGE)} of {n(rows.length)}</span>
            <Button size="sm" onClick={() => setPage((p) => p + 1)}>Show {n(Math.min(PAGE, rows.length - page * PAGE))} more</Button>
          </div>
        )}
      </div>

      {openSeq !== undefined && <ReceiptDrawer seq={openSeq} onClose={() => set({ open: '' })} />}
      {canExport && <ExportRangeDialog open={exportOpen} onClose={() => setExportOpen(false)} from={span?.from} to={span?.to} matching={rows.length} />}
    </div>
  );
}
