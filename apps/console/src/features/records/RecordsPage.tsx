import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, BadgeCheck, BookCheck, Boxes, ClipboardCheck, Clock3, Eraser, Plug, ScrollText, Scale, type LucideIcon } from 'lucide-react';
import type { Counterparty } from '@/types';
import { api } from '@/api';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useOrgLevel } from '@/store/session';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { countdown, n, plural, rupees } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, DataTable, EmptyState, PageHeader, Panel, SearchInput, Segmented, Skeleton, Stat, StatusChip, type Column } from '@/components/ui';
import { AgentLink, ReceiptLink, When } from '@/components/domain';
import { D, GROUPS, TYPE_META, eventLabel, loadRecords, recordPath, summarise, type RecordEvent, type RecordGroup, type RecordSummary } from './lib';
import { Count, RecordLink, StateChip, TypeLabel } from './parts';
import { matchCounterparties } from './actions';
import { PlanUpsell, SmartLink, useScreenAccess } from '@/shell/access';

type RangeId = '24h' | '7d' | 'all';
type GroupId = RecordGroup | 'all';
const RANGES: Record<RangeId, { ms?: number; label: string; phrase: string }> = {
  '24h': { ms: D, label: '24 h', phrase: 'in the last 24 hours' },
  '7d': { ms: 7 * D, label: '7 d', phrase: 'in the last 7 days' },
  all: { label: 'All', phrase: 'in the whole window' },
};
const PAGE = 50;

/**
 * Records — the door home for "What is the state of things?".
 * Every business record an agent's call named (vendors, bills, accounts, services…), derived from the chain,
 * with its current state and the count of governed writes, escalations and refusals behind it.
 */
export default function RecordsPage() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const range = (RANGES[sp.get('range') as RangeId] ? sp.get('range') : '7d') as RangeId;
  const group = (GROUPS.some((g) => g.id === sp.get('type')) ? sp.get('type') : 'all') as GroupId;
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [page, setPage] = useState(1);
  const now = useNow(60_000);

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (!v || (k === 'range' && v === '7d') || (k === 'type' && v === 'all')) next.delete(k);
      else next.set(k, v);
    }
    setSp(next, { replace: true });
    setPage(1);
  };

  const { data, loading, error, refetch } = useQuery((o) => loadRecords(o), []);
  const level = useOrgLevel();
  const a = useScreenAccess();
  const l3 = atLeast(level, 'l3');
  const cpQ = useQuery(async (o) => {
    const [reg, xs] = await Promise.all([api.counterparties(o), api.crossOrgReceipts(o)]);
    return { ...reg, crossOrg: xs };
  }, [level], { kinds: ['receipt'] });
  const from = RANGES[range].ms ? now - RANGES[range].ms! : undefined;

  const all = useMemo(() => (data ? Array.from(data.records.values()).map((e) => summarise(e, from)) : undefined), [data, from]);
  const touched = useMemo(() => all?.filter((s) => s.inRange.length > 0), [all]);

  const groupCounts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const s of touched ?? []) {
      c.all++;
      const g = TYPE_META[s.ref.type].group;
      c[g] = (c[g] ?? 0) + 1;
    }
    return c;
  }, [touched]);

  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => (touched ?? []).filter((s) =>
    (group === 'all' || TYPE_META[s.ref.type].group === group) &&
    (!needle || s.ref.name.toLowerCase().includes(needle) || s.ref.id.toLowerCase().includes(needle) || TYPE_META[s.ref.type].label.toLowerCase().includes(needle) || s.agents.some((a) => a.includes(needle)) || s.state.label.toLowerCase().includes(needle)),
  ), [touched, group, needle]);

  const stats = useMemo(() => {
    if (!touched || !all) return undefined;
    return {
      touched: touched.length,
      flagged: touched.filter((s) => s.asked + s.refused > 0).length,
      counterparties: touched.filter((s) => TYPE_META[s.ref.type].group === 'counterparties').length,
      waiting: all.filter((s) => s.waiting.length > 0).length,
      writes: touched.reduce((t, s) => t + s.committed, 0),
      refusals: touched.reduce((t, s) => t + s.refused, 0),
    };
  }, [touched, all]);

  /** record key → registered counterparties it matches (L3) */
  const registered = useMemo(() => {
    const m = new Map<string, Counterparty[]>();
    if (!cpQ.data?.enabled || !data) return m;
    for (const e of data.records.values()) {
      const hit = matchCounterparties(e, cpQ.data.counterparties);
      if (hit.length) m.set(e.ref.key, hit);
    }
    return m;
  }, [cpQ.data, data]);

  // one row per governed call, naming every record it touched (a payment names a vendor and a bill)
  const waitingAll = useMemo(() => (data?.events ?? [])
    .filter((e) => e.status === 'waiting')
    .sort((a, b) => (a.approval?.expiresAt ?? a.ts).localeCompare(b.approval?.expiresAt ?? b.ts)), [data]);
  const waiting = waitingAll.slice(0, 6);

  const recent = useMemo(() => (data?.events ?? [])
    .filter((e) => !(e.read && e.decision === 'allow') && e.status !== 'waiting')
    .slice(0, 6), [data]);

  const columns: Column<RecordSummary>[] = [
    {
      key: 'record', header: 'Record', sort: (s) => s.ref.name.toLowerCase(),
      cell: (s) => {
        const reg = registered.get(s.ref.key);
        return (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <RecordLink refx={s.ref} sub className="max-w-[260px]" />
            {reg?.map((c) => (
              <SmartLink key={c.id} to="/assurance/counterparties" onClick={(e) => e.stopPropagation()} title={`${c.name}: ${c.seatsUsed} of ${c.seats} seats · ${c.issued} issued · ${c.received} received`}>
                <Badge tone="info" icon={<BadgeCheck className="h-3 w-3" aria-hidden />}>Registered · {c.issued} issued · {c.received} received</Badge>
              </SmartLink>
            ))}
          </span>
        );
      },
    },
    { key: 'type', header: 'Type', cell: (s) => <TypeLabel type={s.ref.type} />, sort: (s) => TYPE_META[s.ref.type].label, hideBelow: 'md' },
    { key: 'last', header: 'Last event', cell: (s) => <When iso={s.last} className="text-sm text-muted" />, sort: (s) => s.last ?? '', hideBelow: 'sm', width: 130 },
    { key: 'committed', header: <span title="Writes allowed by a rule or approved by a person. On check-and-record routes the agent runs the call itself.">Committed</span>, cell: (s) => <Count value={s.committed} tone="ok" />, sort: (s) => s.committed, align: 'right', hideBelow: 'lg' },
    { key: 'asked', header: <span title="Calls held for a person to decide">Asked</span>, cell: (s) => <Count value={s.asked} tone="held" />, sort: (s) => s.asked, align: 'right', hideBelow: 'lg' },
    { key: 'refused', header: <span title="Refused by a rule, rejected by a person, or expired unanswered">Refused</span>, cell: (s) => <Count value={s.refused} tone="bad" />, sort: (s) => s.refused, align: 'right', hideBelow: 'md' },
    { key: 'state', header: 'Current state', cell: (s) => <StateChip label={s.state.label} tone={s.state.tone} className="max-w-[260px]" />, sort: (s) => `${s.state.tone}:${s.state.label}` },
    {
      key: 'agents', header: 'Agents', hideBelow: 'lg',
      cell: (s) => (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {s.agents.slice(0, 2).map((a) => <AgentLink key={a} slug={a} />)}
          {s.agents.length > 2 && <span className="text-xs text-muted">+{s.agents.length - 2}</span>}
        </span>
      ),
    },
  ];

  // the other lists behind this door, only those this role and plan can open
  const otherLists = ([
    { to: '/activity', icon: ScrollText, title: 'Activity', sub: data ? `${n(data.totals.receipts)} ${atLeast(level, 'l2') ? 'signed' : 'sealed'} receipts` : undefined },
    { to: '/rulebooks', icon: BookCheck, title: 'Rulebooks', sub: data ? plural(data.totals.rulebooks, 'rulebook') : undefined },
    { to: '/connectors', icon: Plug, title: 'Connectors', sub: data ? plural(data.totals.connectors, 'connector') : undefined },
    { to: '/inventory', icon: Boxes, title: 'AI inventory', sub: data ? plural(data.totals.aiSystems, 'AI system') : undefined },
    { to: '/assessments', icon: ClipboardCheck, title: 'Assessments', sub: data ? plural(data.totals.assessments, 'assessment') : undefined },
    { to: '/records/packs', icon: Scale, title: 'Regulatory packs', sub: atLeast(level, 'l2') ? 'ledger1, invoice1, collect1' : `ledger1, invoice1, collect1 · dry run until ${LEVEL_INFO.l2.label}` },
    { to: '/records/erasure', icon: Eraser, title: 'Erasure (DPDP)', sub: 'Requests and salt destruction' },
  ] as { to: string; icon: LucideIcon; title: string; sub?: string }[]).filter((o) => a.canSee(o.to));

  const filtersOn = group !== 'all' || !!needle;
  const clear = () => { setQ(''); set({ type: 'all' }); };

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="Records"
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        description={`The state of every vendor, bill, account and service your agents touched — derived from ${atLeast(level, 'l2') ? 'signed receipts' : 'receipts sealed in a hash chain'}, with every governed write, refusal and escalation behind it.`}
        actions={<Button variant="secondary" icon={<ScrollText className="h-4 w-4" aria-hidden />} onClick={() => nav('/activity')}>All receipts</Button>}
      />

      {error && <Banner tone="bad" title="Records could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <Segmented<RangeId> label="Time range" value={range} onChange={(v) => set({ range: v })} options={(Object.keys(RANGES) as RangeId[]).map((k) => ({ value: k, label: RANGES[k].label }))} />
        <p className="text-sm text-muted">Counts are {RANGES[range].phrase}. Current state uses every receipt.</p>
      </div>

      {/* stats */}
      <div className="grid gap-4 grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4">
        {!stats ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[124px]" />) : (
          <>
            <Stat label="Records touched" value={n(stats.touched)} sub={`${plural(stats.writes, 'governed write')} committed`} />
            <Stat label="With a refusal or escalation" value={n(stats.flagged)} sub={`${plural(stats.refusals, 'refusal')} on these records`} to={a.canSee('/assurance/refusals') ? '/assurance/refusals' : undefined} />
            {l3 && cpQ.data?.enabled ? (
              <Stat label="Counterparties" value={n(stats.counterparties)} to={a.canSee('/assurance/counterparties') ? '/assurance/counterparties' : undefined}
                sub={`${plural(cpQ.data.counterparties.length, 'in the register', 'in the register')} · ${n(cpQ.data.counterparties.reduce((t, c) => t + c.seatsUsed, 0))} of ${plural(cpQ.data.seatsTotal, 'seat')} in use`} />
            ) : (
              <Stat label="Counterparties" value={n(stats.counterparties)} sub="Vendors, customers and outside addresses" />
            )}
            <Stat label="Waiting on a person" value={n(stats.waiting)} sub={stats.waiting ? 'Records with a held call' : 'Nothing held right now'} to={a.canSee('/approvals') ? '/approvals' : undefined} />
          </>
        )}
      </div>

      {/* counterparty register (L3) */}
      {cpQ.error && <Banner tone="bad" title="The counterparty register could not be loaded" className="mt-6" actions={<Button size="sm" onClick={cpQ.refetch}>Try again</Button>}>{cpQ.error.message}</Banner>}
      {l3 && cpQ.data?.enabled ? (
        <Panel className="mt-6" title="Counterparties that verify your receipts" kicker={`Register · ${plural(cpQ.data.counterparties.length, 'counterparty', 'counterparties')} · seat ${rupees(cpQ.data.seatPrice)} a year`} flush
          actions={<SmartLink to="/assurance/counterparties" hideWhenBlocked className="text-sm text-muted hover:text-fg hover:underline underline-offset-2">Open the register</SmartLink>}>
          {cpQ.data.counterparties.length === 0 ? (
            <EmptyState compact disc="orbit" title="No counterparties registered"
              action={a.can('counterparty.manage') && a.canSee('/assurance/counterparties') ? <Button size="sm" onClick={() => nav('/assurance/counterparties')}>Add a counterparty</Button> : undefined}>
              {a.can('counterparty.manage') ? 'Add a vendor, customer, insurer or regulator with its key, then issue receipts to it from a record.' : 'Owners and admins add the vendors, customers, insurers and regulators that verify your receipts.'}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {cpQ.data.counterparties.map((c) => {
                const recs = Array.from(registered.entries()).filter(([, cs]) => cs.some((x) => x.id === c.id)).map(([k]) => data?.records.get(k)?.ref).filter(Boolean);
                const issued = cpQ.data!.crossOrg.filter((x) => x.counterpartyId === c.id && x.direction === 'issued').length;
                const received = cpQ.data!.crossOrg.filter((x) => x.counterpartyId === c.id && x.direction === 'received').length;
                return (
                  <li key={c.id} className="px-5 py-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_auto] items-center">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        <StatusChip size="sm" tone={c.verification === 'verified' ? 'ok' : c.verification === 'failed' ? 'bad' : c.verification === 'pending' ? 'held' : 'neutral'} icon={<BadgeCheck className="h-3 w-3" aria-hidden />}>
                          {c.verification === 'verified' ? 'Verifies' : c.verification === 'pending' ? 'Verification pending' : c.verification === 'failed' ? 'Verification failed' : 'Not started'}
                        </StatusChip>
                      </span>
                      <span className="block text-xs text-muted mt-0.5">{c.kind} · <span className="font-mono">{c.domain}</span>{recs.length > 0 && <> · record {recs.map((r) => <Link key={r!.key} to={recordPath(r!.key)} className="text-fg hover:underline underline-offset-2 ml-1">{r!.name}</Link>)}</>}</span>
                    </span>
                    <span className="text-sm text-muted num whitespace-nowrap">{c.seatsUsed} of {plural(c.seats, 'seat')} · {n(Math.max(issued, c.issued))} issued · {n(Math.max(received, c.received))} received</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      ) : !cpQ.loading && (
        <>
          {a.canSee('/assurance/counterparties') && (
            <p className="mt-4 text-sm text-muted">
              Every counterparty your agents acted on is listed, read-only, in the <Link to="/assurance/counterparties" className="text-fg underline underline-offset-2">counterparty register</Link>.
            </p>
          )}
          <PlanUpsell to="l3" className="mt-2" what="Issuing receipts to counterparties, with verification seats, is part of L3 Proven." />
        </>
      )}

      {/* strips */}
      <div className="mt-6 grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-6" title="Waiting on a person" kicker="Held — nothing runs until someone decides" flush
          actions={<SmartLink to="/approvals" hideWhenBlocked className="text-sm text-muted hover:text-fg hover:underline underline-offset-2">Approvals</SmartLink>}>
          {loading && !data ? <StripSkeleton /> : waiting.length === 0 ? (
            <EmptyState compact disc="gate" title="No record is waiting">Every held call on a record has been decided or has expired.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {waiting.map((ev) => (
                <li key={ev.seq} className="px-5 py-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 items-start">
                  <Refs ev={ev} />
                  <span className="inline-flex items-center gap-1 text-xs text-held-fg num whitespace-nowrap" title="Time left before it expires. Expiry is a refusal.">
                    <Clock3 className="h-3.5 w-3.5" aria-hidden />{ev.approval ? countdown(ev.approval.expiresAt, now) : '—'}
                  </span>
                  <p className="text-sm text-muted min-w-0 truncate" title={ev.approval?.headline}>{ev.approval?.headline ?? `${ev.agent} asked to call ${ev.tool}`}</p>
                  <span className="flex items-center gap-2 justify-self-end">
                    <ReceiptLink seq={ev.seq} />
                    {ev.approval && <SmartLink to={`/approvals/${ev.approval.id}`} hideWhenBlocked className="text-sm font-medium hover:underline underline-offset-2">Open</SmartLink>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {waitingAll.length > waiting.length && (
            <p className="px-5 py-3 border-t border-line text-sm text-muted">{plural(waitingAll.length - waiting.length, 'more held call')}{a.canSee('/approvals') && <> — <Link to="/approvals" className="text-fg hover:underline underline-offset-2">see every approval</Link></>}</p>
          )}
        </Panel>

        <Panel className="lg:col-span-6" title="Recently changed" kicker="Last write, refusal or decision" flush>
          {loading && !data ? <StripSkeleton /> : recent.length === 0 ? (
            <EmptyState compact disc="trail" title="No changes yet">When an agent writes to a record, or is refused, it shows here.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((ev) => {
                const l = eventLabel(ev);
                return (
                  <li key={ev.seq} className="px-5 py-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 items-center">
                    <Refs ev={ev} />
                    <When iso={ev.ts} className="text-xs text-muted" />
                    <StateChip label={l.label} tone={l.tone} className="justify-self-start max-w-[300px]" />
                    <span className="flex items-center gap-3 justify-self-end text-sm"><AgentLink slug={ev.agent} className="hidden sm:inline-flex" /><ReceiptLink seq={ev.seq} /></span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* index */}
      <div className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
          <div>
            <h2 className="text-xl font-semibold">Every record</h2>
            <p className="text-sm text-muted mt-0.5">Open a record for its pinned fields and full timeline, refusals included.</p>
          </div>
        </div>
        <div className="border border-line bg-surface p-3 sm:p-4 flex flex-wrap items-center gap-3">
          <div className="max-w-full overflow-x-auto">
            <Segmented<GroupId> label="Record type" value={group} onChange={(v) => set({ type: v })} options={GROUPS.map((g) => ({ value: g.id, label: <span className="whitespace-nowrap">{g.label}</span>, count: groupCounts[g.id] ?? 0 }))} />
          </div>
          <div className="w-full sm:w-auto sm:flex-1 sm:min-w-[220px] sm:max-w-[360px] sm:ml-auto">
            <label htmlFor="records-q" className="sr-only">Search records</label>
            <SearchInput id="records-q" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Northwind, BILL-9127, billing-api, an agent…" />
          </div>
        </div>
        {filtersOn && touched && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted mt-2" aria-live="polite">
            <span>{n(rows.length)} of {n(touched.length)} records match</span>
            <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>
          </div>
        )}
        <DataTable
          className="mt-3"
          caption="Records touched by agents"
          columns={columns}
          rows={loading && !data ? undefined : rows.slice(0, page * PAGE)}
          loading={loading}
          rowKey={(s) => s.ref.key}
          onRowClick={(s) => nav(recordPath(s.ref.key))}
          initialSort={{ key: 'last', dir: 'desc' }}
          empty={
            data && data.records.size === 0 ? (
              <EmptyState compact disc="aperture" title="No records yet" action={<Button size="sm" onClick={() => nav('/agents')}>Go to agents</Button>}>
                A record appears the first time an agent's call names a vendor, bill, account or service.
              </EmptyState>
            ) : (
              <EmptyState compact disc="aperture" title={filtersOn ? 'No records match' : `No records touched ${RANGES[range].phrase}`}
                action={filtersOn ? <Button size="sm" onClick={clear}>Clear filters</Button> : range !== 'all' ? <Button size="sm" onClick={() => set({ range: 'all' })}>Show the whole window</Button> : undefined}>
                {filtersOn ? 'Try another type or a shorter search.' : 'Widen the time range to see older records.'}
              </EmptyState>
            )
          }
        />
        {rows.length > page * PAGE && (
          <div className="flex flex-wrap items-center justify-between gap-3 border border-t-0 border-line bg-surface px-4 py-3 text-sm text-muted">
            <span className="num">Showing {n(page * PAGE)} of {n(rows.length)}</span>
            <Button size="sm" onClick={() => setPage((p) => p + 1)}>Show {n(Math.min(PAGE, rows.length - page * PAGE))} more</Button>
          </div>
        )}
      </div>

      {/* the other lists behind this door */}
      <section className="mt-8" aria-labelledby="other-lists">
        <h2 id="other-lists" className="label mb-3">Also in Records</h2>
        <div className="grid gap-px bg-line border border-line sm:grid-cols-2 lg:grid-cols-4">
          {otherLists.map((o, i) => <OtherList key={o.to} {...o} className={fillRow(i, otherLists.length)} />)}
        </div>
      </section>
    </div>
  );
}

/** The last tile stretches to the end of its row, so a shorter list for a role leaves no empty cell. */
function fillRow(i: number, count: number): string | undefined {
  if (i !== count - 1) return undefined;
  const lg = count % 4;
  return cn(count % 2 === 1 && 'sm:col-span-2', lg === 1 ? 'lg:col-span-4' : lg === 2 ? 'lg:col-span-3' : lg === 3 ? 'lg:col-span-2' : count % 2 === 1 ? 'lg:col-span-1' : undefined);
}

function OtherList({ to, icon: Icon, title, sub, className }: { to: string; icon: LucideIcon; title: string; sub?: string; className?: string }) {
  return (
    <Link to={to} className={cn('group bg-surface p-4 flex items-center gap-3 hover:bg-sunken/60 transition-colors min-w-0', className)}>
      <Icon className="h-4 w-4 text-muted shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted truncate num">{sub ?? '…'}</span>
      </span>
      <ArrowRight className="h-4 w-4 text-subtle group-hover:text-fg transition-colors shrink-0" aria-hidden />
    </Link>
  );
}

/** The records one call names: the first in full, the rest as small links. */
function Refs({ ev }: { ev: RecordEvent }) {
  const [first, ...rest] = ev.refs;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
      <RecordLink refx={first} className="min-w-0 max-w-full" />
      {rest.map((r) => (
        <Link key={r.key} to={recordPath(r.key)} className="font-mono text-[12px] text-muted hover:text-fg hover:underline underline-offset-2 truncate" title={TYPE_META[r.type].label}>{r.name}</Link>
      ))}
    </span>
  );
}

function StripSkeleton() {
  return (
    <div className="p-5 space-y-4">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9" />)}
    </div>
  );
}
