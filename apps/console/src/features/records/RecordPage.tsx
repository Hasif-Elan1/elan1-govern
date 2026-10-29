import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, BookCheck, Clock3, Download, Eraser, Link2, Loader2, ScrollText, Send, Share2, Waypoints } from 'lucide-react';
import type { ErasureRequest } from '@/types';
import { api } from '@/api';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { countdown, date, n, plural, rupees } from '@/lib/format';
import { cn } from '@/lib/cn';
import { userName } from '@/mock/users';
import { toolByName } from '@/mock/catalog';
import { ApprovalChip, Badge, Banner, Button, DecisionChip, EmptyState, KeyValue, Menu, PageHeader, Panel, Skeleton, Switch, Tooltip, toast } from '@/components/ui';
import { AgentLink, ReceiptLink, When } from '@/components/domain';
import { ModeChip, channelPhrase, later } from '../activity/shared';
import {
  GROUPS, TYPE_META, actOf, describeEvent, eventLabel, holdsPersonalData, isCommitted, isEscalation, isRefusal, loadRecords, makeKey, parseKey, pinnedFields, relatedRecords, summarise,
  type RecordEntry, type RecordEvent, type StateTone,
} from './lib';
import { RecordLink, StateChip, TypeIcon, TypeLabel } from './parts';
import { evidenceClaim } from './level';
import { useRecordVerify, type RecordVerify } from './verify';
import { ErasureDialog, ErasureStatus, IssueDialog, ShareDialog, erasedSeqs, erasedText, erasuresFor, exportRecordEvidence, matchCounterparties } from './actions';
import { SmartLink, useCanSee } from '@/shell/access';

const EDGE: Record<StateTone, string> = { ok: 'border-l-ok', held: 'border-l-held', bad: 'border-l-bad', info: 'border-l-info', neutral: 'border-l-line-strong' };
const MARK: Record<StateTone, string> = { ok: 'bg-ok', held: 'bg-held', bad: 'bg-bad', info: 'bg-info', neutral: 'bg-line-strong' };
const PAGE = 25;

/**
 * Record — the specified "Record" screen: current state, pinned fields, and a timeline of every governed write,
 * refusal and escalation. A timeline of successes only lies by omission, so refusals are shown by default.
 */
export default function RecordPage() {
  const params = useParams();
  const nav = useNavigate();
  const parsed = parseKey(params.key);
  const key = parsed ? makeKey(parsed.type, parsed.id) : undefined;
  const { data, loading, error, refetch } = useQuery((o) => loadRecords(o), []);
  const entry = key ? data?.records.get(key) : undefined;

  if (error) {
    return (
      <div>
        <PageHeader kicker="Records" title="Record" crumbs={[{ label: 'Records', to: '/records' }, { label: parsed?.id ?? 'Record' }]} />
        <Banner tone="bad" title="This record could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>
      </div>
    );
  }

  if (loading && !data) return <RecordSkeleton name={parsed?.id} />;

  if (!parsed || !entry) {
    return (
      <div>
        <PageHeader kicker="Records" title="Record not found" crumbs={[{ label: 'Records', to: '/records' }, { label: 'Not found' }]} />
        <Panel>
          <EmptyState disc="aperture" title={parsed ? `No receipts name ${parsed.id}` : 'This is not a record address'}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<ArrowLeft className="h-4 w-4" aria-hidden />} onClick={() => nav('/records')}>All records</Button>
                {parsed && <Button variant="secondary" onClick={() => nav(`/activity?range=all&q=${encodeURIComponent(parsed.id)}`)}>Search receipts</Button>}
              </div>
            }>
            {parsed
              ? `No agent call in this organisation's chain names this ${TYPE_META[parsed.type].label.toLowerCase()}. It may belong to another organisation, or the name may be spelt differently.`
              : 'Record addresses look like vendor:Northwind Traders or bill:BILL-9127.'}
          </EmptyState>
        </Panel>
      </div>
    );
  }

  return <RecordView key={entry.ref.key} entry={entry} publicKeys={data!.publicKeys} />;
}

/* ── The record ───────────────────────────────────────────── */

function RecordView({ entry, publicKeys }: { entry: RecordEntry; publicKeys: Record<string, string> }) {
  const nav = useNavigate();
  const now = useNow(30_000);
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const canExport = useCan('evidence.export');
  const canShare = role === 'owner' || role === 'admin';
  const canSeeApprovals = useCanSee('/approvals');
  const levelQ = useQuery((o) => api.level(o), [level], { kinds: ['receipt'] });
  const erasuresQ = useQuery((o) => api.erasures(o), []);
  const cpQ = useQuery((o) => api.counterparties(o), [level], { kinds: ['receipt'] });
  const history = levelQ.data?.history;
  const [dialog, setDialog] = useState<'share' | 'issue' | 'erase'>();
  const [exporting, setExporting] = useState(false);
  const personal = holdsPersonalData(entry.ref.type);
  const isCounterparty = TYPE_META[entry.ref.type].group === 'counterparties';
  const matched = useMemo(() => (cpQ.data?.enabled ? matchCounterparties(entry, cpQ.data.counterparties) : []), [cpQ.data, entry]);
  const erased = useMemo(() => erasedSeqs(entry, erasuresQ.data?.requests), [entry, erasuresQ.data]);
  const myErasures = useMemo(() => erasuresFor(entry, erasuresQ.data?.requests), [entry, erasuresQ.data]);
  const s = useMemo(() => summarise(entry), [entry]);
  const ref = entry.ref;
  const meta = TYPE_META[ref.type];
  const pinned = useMemo(() => pinnedFields(ref, entry.events), [ref, entry.events]);
  const related = useMemo(() => relatedRecords(ref, entry.events), [ref, entry.events]);
  const approvals = useMemo(() => entry.events.filter((e) => e.approval).map((e) => ({ ev: e, a: e.approval! })), [entry.events]);
  const groupLabel = GROUPS.find((g) => g.id === meta.group)?.label ?? 'Records';

  const money = useMemo(() => {
    let committed = 0, committedN = 0, refused = 0, refusedN = 0;
    for (const e of entry.events) {
      const amt = typeof e.args.amount === 'number' ? e.args.amount : undefined;
      if (amt === undefined || !e.tool || !toolByName(e.tool)?.tags.includes('moves_money')) continue;
      if (isCommitted(e)) { committed += amt; committedN++; }
      else if (isRefusal(e)) { refused += amt; refusedN++; }
    }
    return { committed, committedN, refused, refusedN };
  }, [entry.events]);

  const agents = useMemo(() => {
    const m = new Map<string, { slug: string; events: number; versions: Set<number> }>();
    for (const e of entry.events) {
      if (!e.agent) continue;
      const x = m.get(e.agent) ?? { slug: e.agent, events: 0, versions: new Set<number>() };
      x.events++;
      if (e.rulebook) x.versions.add(e.rulebook.version);
      m.set(e.agent, x);
    }
    return Array.from(m.values()).sort((a, b) => b.events - a.events);
  }, [entry.events]);

  const activityQ = ref.type === 'pr' ? ref.id.split('#')[0] : ref.id;

  /* verification of just this record's receipts */
  const verifier = useRecordVerify(orgId, entry, publicKeys, level, history);

  const doExport = async () => {
    if (!user) return;
    setExporting(true);
    try {
      const r = await exportRecordEvidence(orgId, user.id, entry, publicKeys, level, history, erasuresQ.data?.requests);
      toast.ok('Record evidence saved', `${plural(r.receipts, 'receipt')}${r.seals ? `, ${plural(r.seals, 'seal')} and ${plural(r.proofs, 'inclusion proof')}` : ''}. The export is recorded on the chain.`);
    } catch (e) {
      toast.bad('Could not export the evidence', (e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const l2 = atLeast(level, 'l2');
  const l3 = atLeast(level, 'l3');
  // sharing outside the organisation starts at L2 (redaction) and L3 (issuing): below that the menu is left out
  const shareItems = [
    ...(l2 ? [{ label: 'Share with redaction', icon: <Share2 className="h-4 w-4" aria-hidden />, onSelect: () => setDialog('share') }] : []),
    ...(isCounterparty && l3 ? [{ label: matched[0] ? `Issue receipts to ${matched[0].name}` : `Issue receipts to ${entry.ref.name}`, icon: <Send className="h-4 w-4" aria-hidden />, hint: matched[0] ? 'Registered' : undefined, onSelect: () => setDialog('issue') }] : []),
  ];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker={`Records · ${meta.label}`}
        crumbs={[{ label: 'Records', to: '/records' }, { label: groupLabel, to: `/records?type=${meta.group}&range=all` }, { label: ref.name }]}
        title={<span className="inline-flex items-center gap-3 min-w-0 break-words"><TypeIcon type={ref.type} className="h-6 w-6 text-fg" />{ref.name}</span>}
        description={<>{meta.hint}{ref.name !== ref.id && <> Recorded as <span className="font-mono text-[13px] text-fg">{ref.id}</span>.</>}</>}
        meta={
          <>
            <StateChip label={s.state.label} tone={s.state.tone} size="md" />
            {s.state.seq !== undefined && <span className="text-sm text-muted">as of <ReceiptLink seq={s.state.seq} /></span>}
            <span className="text-sm text-muted">· {plural(entry.events.length, 'governed call')} since {s.first ? date(s.first) : '—'}</span>
            {personal && <Badge title="DPDP: a data principal can ask for this to be erased.">Personal data</Badge>}
            {matched.map((c) => <SmartLink key={c.id} to="/assurance/counterparties"><Badge tone="info" title={`${c.seatsUsed} of ${c.seats} verification seats in use`}>Registered counterparty · {c.verification.replace('_', ' ')}</Badge></SmartLink>)}
          </>
        }
        actions={
          <>
            <Button variant="secondary" icon={<ScrollText className="h-4 w-4" aria-hidden />} onClick={() => nav(`/activity?range=all&q=${encodeURIComponent(activityQ)}`)}>Receipts in Activity</Button>
            {canExport && (
              <Tooltip content="Receipts, keys and — from L2 — seals and inclusion proofs for this record, in one file">
                <Button variant="secondary" icon={<Download className="h-4 w-4" aria-hidden />} loading={exporting} onClick={doExport}>Export record evidence</Button>
              </Tooltip>
            )}
            {canShare && shareItems.length > 0 && (
              <Menu width={280} trigger={({ open, toggle }) => (
                <Button variant="secondary" icon={<Share2 className="h-4 w-4" aria-hidden />} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>Share</Button>
              )} items={shareItems} />
            )}
            {personal && canShare && (
              <Tooltip content="Open a DPDP erasure request: two approvers, a 72-hour clock, then salt destruction">
                <Button variant="secondary" icon={<Eraser className="h-4 w-4" aria-hidden />} onClick={() => setDialog('erase')}>Request erasure (DPDP)</Button>
              </Tooltip>
            )}
            <Button variant="primary" icon={verifier.state === 'running' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <BadgeCheck className="h-4 w-4" aria-hidden />} onClick={verifier.run} disabled={verifier.state === 'running'}>
              {verifier.state === 'running' ? `Verifying ${verifier.done} of ${verifier.total}` : "Verify this record's receipts"}
            </Button>
          </>
        }
      />

      <VerifyResult v={verifier} />

      <ErasureStatus requests={myErasures} className="mb-6" />

      {canShare && <ShareDialog open={dialog === 'share'} onClose={() => setDialog(undefined)} entry={entry} level={level} defaultAudience={isCounterparty ? `ar-org:${matched[0]?.domain ?? (entry.ref.id.includes('.') ? entry.ref.id : entry.ref.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}` : 'ar-org:auditor'} />}
      {canShare && <IssueDialog open={dialog === 'issue'} onClose={() => setDialog(undefined)} entry={entry} level={level} register={cpQ.data} matched={matched} />}
      {personal && canShare && <ErasureDialog open={dialog === 'erase'} onClose={() => setDialog(undefined)} entry={entry} level={level} history={history} />}

      {s.waiting.length > 0 && (
        <Banner tone="held" className="mb-6" title={`${plural(s.waiting.length, 'call')} on this record ${s.waiting.length === 1 ? 'is' : 'are'} waiting for a person`}
          actions={s.waiting[0].approval && canSeeApprovals ? <Button size="sm" variant="secondary" onClick={() => nav(`/approvals/${s.waiting[0].approval!.id}`)}>Open the approval</Button> : undefined}>
          {s.waiting[0].approval?.headline ?? `${s.waiting[0].agent} asked to ${describeEvent(s.waiting[0])}`}. Nothing runs until someone decides
          {s.waiting[0].approval && <> — expires {countdown(s.waiting[0].approval.expiresAt, now) === 'expired' ? 'now' : `in ${countdown(s.waiting[0].approval.expiresAt, now)}`}</>}. Expiry is a refusal.
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        {/* pinned fields */}
        <Panel className="lg:col-span-8" title="Pinned fields" kicker="Latest committed values" flush
          footer="Each value comes from the newest write that went through. A newer attempt that was refused or is still waiting is shown beside it, never in its place.">
          {pinned.length === 0 && money.committedN === 0 && money.refusedN === 0 ? (
            <EmptyState compact disc="registration" title="No fields to pin">The calls on this record carried no values beyond its name.</EmptyState>
          ) : (
            <dl className="divide-y divide-line">
              {money.committedN > 0 && (
                <PinRow label="Money moved" value={rupees(money.committed)} sub={plural(money.committedN, 'committed payment or transfer', 'committed payments and transfers')} />
              )}
              {money.refusedN > 0 && (
                <PinRow label="Money refused" value={<span className="text-bad-fg">{rupees(money.refused)}</span>} sub={`${plural(money.refusedN, 'call')} refused, rejected or expired — never moved`} />
              )}
              {pinned.map((p) => {
                const att = p.attempted;
                const attLabel = att ? eventLabel(att.ev) : undefined;
                const gone = erased.get(p.ev.seq);
                if (gone) {
                  return (
                    <PinRow key={`${p.field}:${p.label}:${p.ev.seq}`} label={p.label}
                      value={<span className="inline-flex items-center gap-1.5 text-muted font-sans"><Eraser className="h-3.5 w-3.5" aria-hidden />{erasedText(gone)}</span>}
                      sub={<>from <ReceiptLink seq={p.ev.seq} /> · the value was removed from the receipt and its payload hash can no longer be linked to the person ({gone.subjectRef}); the receipt and its seal still verify</>} />
                  );
                }
                return (
                  <PinRow key={`${p.field}:${p.label}:${p.ev.seq}`} label={p.label}
                    value={p.value ? p.value : <span className="text-subtle font-sans">No committed value</span>}
                    mono={!['amount', 'amount_due'].includes(p.field)}
                    sub={p.value ? <>from <ReceiptLink seq={p.ev.seq} /> · <span className="font-mono">{p.ev.tool}</span> · <When iso={p.ev.ts} /></> : undefined}
                    extra={att && attLabel ? (
                      <span className="flex flex-wrap items-center gap-2 mt-1.5">
                        <span className="text-xs text-muted">Newer attempt</span>
                        <span className="font-mono text-[12.5px]">{att.value}</span>
                        <StateChip label={attLabel.label} tone={attLabel.tone} />
                        <ReceiptLink seq={att.ev.seq} />
                      </span>
                    ) : undefined}
                  />
                );
              })}
            </dl>
          )}
        </Panel>

        {/* counts */}
        <Panel className="lg:col-span-4" title="At a glance" kicker="Every receipt on this record">
          <KeyValue items={[
            { k: 'Writes committed', v: <span className="num font-medium">{n(s.committed)}</span> },
            { k: 'Asked a person', v: <span className="num font-medium text-held-fg">{n(s.asked)}</span> },
            { k: 'Refused, rejected or expired', v: <span className={cn('num font-medium', s.refused && 'text-bad-fg')}>{n(s.refused)}</span> },
            { k: 'Tool errors', v: <span className="num">{n(s.failed)}</span> },
            { k: 'Reads (not writes)', v: <span className="num">{n(s.reads)}</span> },
            { k: 'First seen', v: <When iso={s.first} /> },
            { k: 'Last event', v: <When iso={s.last} /> },
            { k: 'Type', v: <TypeLabel type={ref.type} className="justify-end" /> },
          ]} />
        </Panel>

        {/* timeline */}
        <div className="lg:col-span-8">
          <RecordTimeline entry={entry} now={now} erased={erased} />
        </div>

        {/* side column */}
        <div className="lg:col-span-4 space-y-6 min-w-0">
          <Panel title="Approvals" kicker={plural(approvals.length, 'held call')} flush>
            {approvals.length === 0 ? (
              <EmptyState compact disc="gate" title="No calls held for a person">No rule asked a person about this record.</EmptyState>
            ) : <ApprovalList items={approvals} now={now} />}
          </Panel>

          <Panel title="Agents and rulebooks" kicker="Who acted, under which rules" flush>
            <ul className="divide-y divide-line">
              {agents.map((a) => (
                <li key={a.slug} className="px-5 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <AgentLink slug={a.slug} />
                  <span className="text-xs text-muted num">{plural(a.events, 'call')}</span>
                  <Link to={`/rulebooks/${a.slug}`} className="w-full inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg hover:underline underline-offset-2">
                    <BookCheck className="h-3.5 w-3.5" aria-hidden />
                    {a.slug} rulebook{a.versions.size > 0 && <span className="num"> · v{Array.from(a.versions).sort((x, y) => x - y).join(', v')}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Related records" kicker="Named in the same calls" flush>
            {related.length === 0 ? (
              <EmptyState compact disc="orbit" title="No related records">The calls on this record name nothing else.</EmptyState>
            ) : <RelatedList items={related} />}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function PinRow({ label, value, sub, extra, mono }: { label: string; value: ReactNode; sub?: ReactNode; extra?: ReactNode; mono?: boolean }) {
  return (
    <div className="px-5 py-3 grid gap-x-6 gap-y-1 sm:grid-cols-[180px_1fr] items-baseline">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0">
        <span className={cn('text-md font-medium break-words', mono && 'font-mono text-[13.5px]')}>{value}</span>
        {sub && <span className="block text-xs text-muted mt-0.5">{sub}</span>}
        {extra}
      </dd>
    </div>
  );
}

/* ── Timeline ─────────────────────────────────────────────── */

function RecordTimeline({ entry, now, erased }: { entry: RecordEntry; now: number; erased: Map<number, ErasureRequest> }) {
  const [showFlags, setShowFlags] = useState(true);
  const [showReads, setShowReads] = useState(false);
  const [page, setPage] = useState(1);
  const flagged = entry.events.filter((e) => isRefusal(e) || isEscalation(e) || e.status === 'failed');
  const reads = entry.events.filter((e) => e.status === 'read');
  const visible = entry.events.filter((e) => {
    if (e.status === 'read') return showReads;
    if (!showFlags && (isRefusal(e) || isEscalation(e) || e.status === 'failed')) return false;
    return true;
  });

  return (
    <Panel title="Timeline — every governed write, refusal and escalation" kicker={`${plural(entry.events.length, 'call')} · newest first`} flush>
      <div className="px-5 py-4 border-b border-line space-y-3">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="flex items-start gap-3 min-w-0 max-w-[460px]">
            <Switch checked={showFlags} onChange={(v) => { setShowFlags(v); setPage(1); }} label="Show refusals and escalations" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Show refusals and escalations <span className="text-muted font-normal num">({n(flagged.length)})</span></p>
              <p className="text-xs text-muted leading-relaxed mt-0.5">On by default. A timeline of successes only lies by omission: it hides what an agent tried and was stopped from doing, and what a person had to decide.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch checked={showReads} onChange={(v) => { setShowReads(v); setPage(1); }} label="Show reads" />
            <div>
              <p className="text-sm font-medium">Show reads <span className="text-muted font-normal num">({n(reads.length)})</span></p>
              <p className="text-xs text-muted mt-0.5">Reads change nothing, so they are off.</p>
            </div>
          </div>
        </div>
        {!showFlags && flagged.length > 0 && (
          <Banner tone="held" title={`${plural(flagged.length, 'refusal or escalation', 'refusals and escalations')} hidden`}
            actions={<Button size="sm" variant="secondary" onClick={() => setShowFlags(true)}>Show them</Button>}>
            You are looking at committed writes only. Turn refusals and escalations back on before you rely on this view.
          </Banner>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState compact disc="trail" title="Nothing to show with these switches">Turn on refusals and escalations, or reads.</EmptyState>
      ) : (
        <ol className="relative px-5 py-5" aria-label="Record timeline">
          {visible.slice(0, page * PAGE).map((ev, i, arr) => <TimelineItem key={ev.seq} ev={ev} last={i === arr.length - 1} now={now} self={entry.ref.key} erasedBy={erased.get(ev.seq)} />)}
        </ol>
      )}
      {visible.length > page * PAGE && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm text-muted">
          <span className="num">Showing {n(page * PAGE)} of {n(visible.length)}</span>
          <Button size="sm" onClick={() => setPage((p) => p + 1)}>Show {n(Math.min(PAGE, visible.length - page * PAGE))} more</Button>
        </div>
      )}
    </Panel>
  );
}

function TimelineItem({ ev, last, now, self, erasedBy }: { ev: RecordEvent; last: boolean; now: number; self: string; erasedBy?: ErasureRequest }) {
  const l = eventLabel(ev);
  const decision = ev.receipts[0];
  const apr = ev.approvalReceipt;
  const out = ev.outcomeReceipt;
  const governed = ev.mode === 'governed_run';
  const others = ev.refs.filter((r) => r.key !== self);
  const ran = apr?.outcome ?? decision.outcome;

  let outcome: ReactNode = null;
  if (ev.status === 'committed' || ev.status === 'approved') {
    if (governed) outcome = <>Elan1 Govern ran it{ran?.ms ? <span className="num"> in {n(ran.ms)} ms</span> : null}.</>;
    else if (out) outcome = <>The agent ran the call itself and reported the outcome {later(ev.ts, out.ts)} · <ReceiptLink seq={out.seq} /></>;
    else outcome = <>Advised and recorded. The agent runs the call itself.</>;
  } else if (ev.status === 'advised') outcome = <>Advised and recorded. The agent runs the call itself; no outcome reported.</>;
  else if (ev.status === 'failed') outcome = <>The tool returned an error{out ? <> · <ReceiptLink seq={out.seq} /></> : null}.</>;
  else if (ev.status === 'waiting') outcome = governed ? <>Held. Nothing runs until someone approves.</> : <>Held. Elan1 Govern advises the agent to wait for a person.</>;
  else if (ev.status === 'refused' || ev.status === 'rejected' || ev.status === 'expired') outcome = governed ? <>The call did not run — Elan1 Govern holds the credential.</> : <>Refusal advised and recorded; the agent holds its own credentials.</>;

  let person: ReactNode = null;
  if (ev.decision === 'ask') {
    const st = apr?.approval?.status ?? ev.approval?.status;
    const approver = apr?.approval?.approver ?? ev.approval?.decidedBy;
    const channel = apr?.approval?.channel ?? ev.approval?.channel;
    const group = ev.approval?.approverGroup ?? 'a person';
    if (st === 'approved' || st === 'approved_run_failed' || st === 'rejected') {
      person = (
        <>
          <span className="font-medium text-fg">{userName(approver)}</span> {st === 'rejected' ? 'rejected it' : 'approved it'}{channelPhrase(channel)}{apr ? ` ${later(ev.ts, apr.ts)}` : ''}
          {apr && <> · <ReceiptLink seq={apr.seq} /></>}
          {(apr?.reason ?? ev.approval?.decisionReason) && <span className="block text-muted">“{apr?.reason ?? ev.approval?.decisionReason}”</span>}
        </>
      );
    } else if (st === 'expired') {
      person = <>Asked {group}. No one decided within {String(decision.details?.expires_in ?? 'the expiry')}, so it expired. Expiry is a refusal.{apr && <> · <ReceiptLink seq={apr.seq} /></>}</>;
    } else {
      person = (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Asked {group}.</span>
          {ev.approval && <span className="inline-flex items-center gap-1 text-held-fg num"><Clock3 className="h-3.5 w-3.5" aria-hidden />{countdown(ev.approval.expiresAt, now) === 'expired' ? 'Expired — refusal being recorded' : `Expires in ${countdown(ev.approval.expiresAt, now)}`}</span>}
          {ev.approval && <SmartLink to={`/approvals/${ev.approval.id}`} hideWhenBlocked className="font-medium text-fg hover:underline underline-offset-2">Open the approval</SmartLink>}
        </span>
      );
    }
  }

  return (
    <li className={cn('relative pl-7', !last && 'pb-4')}>
      {!last && <span className="absolute left-[5px] top-4 bottom-0 w-px bg-line" aria-hidden />}
      <span className={cn('absolute left-0 top-3 h-[11px] w-[11px]', MARK[l.tone])} aria-hidden />
      <article className={cn('border border-line border-l-[3px] bg-surface p-4', EDGE[l.tone])}>
        <header className="flex flex-wrap items-center justify-between gap-2">
          <StateChip label={l.label} tone={l.tone} />
          <span className="flex items-center gap-3 text-xs text-muted">
            <When iso={ev.ts} />
            <ReceiptLink seq={ev.seq} />
          </span>
        </header>
        <p className="mt-2.5 text-sm">
          <AgentLink slug={ev.agent} /> <span className="text-muted">asked to</span>{' '}
          {erasedBy
            ? <span className="font-medium">{actOf(ev.tool).noun} <span className="text-muted font-normal">— details {erasedText(erasedBy).toLowerCase()} ({erasedBy.subjectRef})</span></span>
            : <span className="font-medium">{describeEvent(ev)}</span>}
        </p>
        <div className="mt-2 grid gap-1.5 text-sm text-muted">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <DecisionChip decision={ev.decision} size="sm" />
            {ev.ruleId && (
              <span>
                rule{' '}
                {ev.agent ? (
                  <Link to={`/rulebooks/${ev.agent}`} className={cn('font-mono text-[12.5px] hover:underline underline-offset-2', ev.decision === 'refuse' ? 'text-bad-fg' : 'text-fg')}>{ev.ruleId}</Link>
                ) : <span className="font-mono text-[12.5px]">{ev.ruleId}</span>}
                {ev.rulebook && <span className="num"> · rulebook v{ev.rulebook.version}</span>}
              </span>
            )}
            <span className="hidden sm:inline"><ModeChip r={decision} /></span>
            {ev.tool && <span className="font-mono text-[12px] text-subtle">{ev.tool}</span>}
          </p>
          {ev.reason && <p>{ev.reason}</p>}
          {person && <p className="text-fg/90">{person}</p>}
          {outcome && <p>{outcome}</p>}
          {others.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
              <span className="label">Also names</span>
              {others.map((r) => <RecordLink key={r.key} refx={r} className="text-sm" />)}
            </p>
          )}
        </div>
      </article>
    </li>
  );
}

/* ── Side lists ───────────────────────────────────────────── */

function ApprovalList({ items, now }: { items: { ev: RecordEvent; a: NonNullable<RecordEvent['approval']> }[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 6);
  return (
    <>
      <ul className="divide-y divide-line">
        {shown.map(({ ev, a }) => (
          <li key={a.id}>
            {/* auditors read the approvals on a record but do not open the Approvals screen: plain rows for them */}
            <SmartLink to={`/approvals/${a.id}`} className="block px-5 py-3 hover:bg-sunken/60 transition-colors" plainClassName="block px-5 py-3">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <ApprovalChip status={a.status} size="sm" />
                <When iso={a.createdAt} className="text-xs text-muted" />
              </span>
              <span className="block mt-1.5 text-sm line-clamp-2">{a.headline}</span>
              <span className="block mt-1 text-xs text-muted">
                {a.status === 'pending'
                  ? `${a.approverGroup} · ${countdown(a.expiresAt, now) === 'expired' ? 'expired' : `expires in ${countdown(a.expiresAt, now)}`}`
                  : a.decidedBy ? `${userName(a.decidedBy)}${channelPhrase(a.channel)}` : a.status === 'expired' ? 'No one decided in time' : a.approverGroup}
                {' · '}<span className="font-mono">#{new Intl.NumberFormat('en-IN').format(ev.seq)}</span>
              </span>
            </SmartLink>
          </li>
        ))}
      </ul>
      {items.length > 6 && (
        <div className="px-5 py-3 border-t border-line">
          <Button size="sm" variant="ghost" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${n(items.length)}`}</Button>
        </div>
      )}
    </>
  );
}

function RelatedList({ items }: { items: ReturnType<typeof relatedRecords> }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 8);
  return (
    <>
      <ul className="divide-y divide-line">
        {shown.map((r) => (
          <li key={r.ref.key} className="px-5 py-2.5 flex items-center justify-between gap-3 min-w-0">
            <RecordLink refx={r.ref} className="min-w-0 text-sm" />
            <span className="text-xs text-muted whitespace-nowrap num" title={TYPE_META[r.ref.type].label}>{TYPE_META[r.ref.type].label} · {plural(r.count, 'call')}</span>
          </li>
        ))}
      </ul>
      {items.length > 8 && (
        <div className="px-5 py-3 border-t border-line">
          <Button size="sm" variant="ghost" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${n(items.length)}`}</Button>
        </div>
      )}
    </>
  );
}

/* ── Verify this record's receipts ────────────────────────── */

function VerifyResult({ v }: { v: RecordVerify }) {
  if (v.state === 'idle') return null;
  if (v.state === 'running') {
    return (
      <Banner tone="neutral" className="mb-6" title={`Checking ${n(v.total)} ${v.l2 !== undefined || atLeast(v.level, 'l2') ? 'receipts, seals and proofs' : 'receipts'} one by one`}>
        <span className="num" aria-live="polite">{n(v.done)} of {n(v.total)} checked</span>
      </Banner>
    );
  }
  const result = v.failed.length ? 'failed' : v.noKey.length ? 'cannot_verify' : 'verified';
  const tone = result === 'verified' ? 'ok' : result === 'failed' ? 'bad' : 'held';
  const receipts = v.receipts;
  const l2 = v.l2;
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const sigWord = atLeast(v.level, 'l2') ? 'signature' : 'Ed25519 seal';
  const title = result === 'verified'
    ? l2 && l2.sealed
      ? `Verified — every hash, signature, seal${l2.anchored ? ', inclusion proof and timestamp' : ''} checks out`
      : `Verified — every content hash matches and every ${sigWord} verifies`
    : result === 'failed' ? `Failed — ${plural(new Set(v.failed.map((f) => f.seq)).size, 'receipt')} did not check out` : `Cannot verify ${plural(v.noKey.length, 'receipt')} — the signing key is not available`;
  const allProven = !!l2 && l2.beforeBoundary === 0 && l2.unanchored.length === 0 && l2.anchored > 0;
  return (
    <Banner tone={tone} className="mb-6" title={title}
      actions={<SmartLink to="/activity/chain" hideWhenBlocked className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline underline-offset-2 whitespace-nowrap"><Waypoints className="h-4 w-4" aria-hidden />Check the whole chain</SmartLink>}>
      <div className="space-y-1.5">
        {v.failed.length > 0 && (
          <ul className="space-y-0.5">
            {v.failed.slice(0, 6).map((f, i) => <li key={`${f.seq}:${i}`}><ReceiptLink seq={f.seq} /> — {f.why}</li>)}
            {v.failed.length > 6 && <li>and {n(v.failed.length - 6)} more</li>}
          </ul>
        )}
        <p>
          Checked <span className="num">{n(receipts)}</span> receipts from <ReceiptLink seq={v.first} /> to <ReceiptLink seq={v.last} /> individually{v.ms !== undefined && <span className="num"> in {n(v.ms)} ms</span>}: SHA-256 over canonical JSON against the stored hash, then the {atLeast(v.level, 'l2') ? 'Ed25519 signature' : 'Ed25519 seal'} against key{v.kids.length > 1 ? 's' : ''} <span className="font-mono text-[12.5px]">{v.kids.join(', ')}</span>.
        </p>
        {l2 && (
          <p>
            {l2.sealed > 0 && <>Seal v6: <span className="num">{n(l2.sealsOk)} of {n(l2.sealed)}</span> seals recompute (16 fields, length-prefixed SHA-256) and verify{l2.payloadUnbound ? <> — <span className="num">{n(l2.payloadUnbound)}</span> with the payload salt destroyed by an erasure</> : null}. </>}
            {l2.anchored > 0 && <>Merkle: <span className="num">{n(l2.proofsOk)} of {n(l2.anchored)}</span> inclusion proofs lead to their batch root (RFC 6962); <span className="num">{n(l2.tokensOk)} of {n(l2.tokens)}</span> RFC 3161 timestamps verify{l2.authorities.length ? <> from {l2.authorities.join(' and ')}</> : null}. </>}
            {l2.unanchored.length > 0 && <><span className="num">{plural(l2.unanchored.length, 'receipt')}</span> {l2.unanchored.length === 1 ? 'is' : 'are'} in the newest batch, not yet timestamped (batches close every 15 minutes). </>}
            {l2.beforeBoundary > 0 && <><span className="num">{plural(l2.beforeBoundary, 'receipt')}</span> {l2.beforeBoundary === 1 ? 'is' : 'are'} from before the L2 boundary: L1 — sealed in a hash chain, no Seal v6 record. </>}
          </p>
        )}
        {allProven ? (
          <p>Each receipt is proven inside a Merkle batch that two authorities timestamped, so removing or changing any of them would change a root those authorities signed.</p>
        ) : (
          <p>
            <strong className="font-semibold">Links between {l2?.anchored ? 'the unsealed or untimestamped ones' : 'them'} are not checked here.</strong> These receipts are not consecutive in the chain — each one's previous-hash points at a receipt about something else — so this cannot show that nothing was removed between them. The chain check does that.
          </p>
        )}
        <p className="inline-flex items-center gap-1.5 text-muted"><Link2 className="h-3.5 w-3.5" aria-hidden />{evidenceClaim(v.level)}{l2?.beforeBoundary ? ` Receipts before the boundary: ${evidenceClaim('l1').toLowerCase()}` : ''}</p>
      </div>
    </Banner>
  );
}

/* ── Loading ──────────────────────────────────────────────── */

function RecordSkeleton({ name }: { name?: string }) {
  return (
    <div aria-busy="true">
      <PageHeader kicker="Records" title={name ?? 'Record'} crumbs={[{ label: 'Records', to: '/records' }, { label: name ?? '…' }]} meta={<Skeleton className="h-7 w-56" />} />
      <div className="grid gap-6 lg:grid-cols-12">
        <Skeleton className="h-[260px] lg:col-span-8" />
        <Skeleton className="h-[260px] lg:col-span-4" />
        <Skeleton className="h-[520px] lg:col-span-8" />
        <Skeleton className="h-[520px] lg:col-span-4" />
      </div>
    </div>
  );
}
