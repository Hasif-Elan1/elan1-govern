import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Ban, Copy, ExternalLink, FlaskConical, Handshake, Inbox, KeyRound, Landmark, Minus, Plus, RefreshCw, Scale, Send, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { api } from '@/api';
import type { Counterparty, CounterpartyKind, CrossOrgReceipt, DisclosurePackage, Receipt, VerifyStep } from '@/types';
import { useMutation, useNow, useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { LEVEL_INFO } from '@/lib/levels';
import { receiptHash, sha256Hex, verifySig } from '@/lib/crypto';
import { REPLAY_CODE, isReplayed, replayStep } from '@/lib/crossorg';
import { date, dateTime, n, plural, rupees, seqLabel } from '@/lib/format';
import { ORGS, userName } from '@/mock/users';
import {
  Banner, Button, CopyButton, DataTable, Dialog, Drawer, EmptyState, Field, Hash, Input, JsonView, PageHeader, Panel, Select, Skeleton, Tabs, Textarea, toast, type Column,
} from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { SmartLink } from '@/shell/access';
import {
  CrossOrgChip, FieldPicker, Figure, FirstIssueWarning, KEY_ROUTE, KIND_LABEL, KeyCheckChip, LIMITS_LINE, LinkedBadge, SEAT_PRICE, StandingChip, TOTAL_FIELDS, UpgradePath,
  VerifySteps, canManage, evidenceClaim, packageStatus, portalUrl, receiptLabel, useDisclosureProfiles, useFirstIssue, useIsL3, useReceiptValues,
} from './shared';

type TabId = 'register' | 'issued' | 'received' | 'portals';
const TABS: TabId[] = ['register', 'issued', 'received', 'portals'];

/**
 * Door 04 · Assurance — Counterparties (L3). The register of organisations that verify your receipts (each holds
 * a seat at ₹45,000 a year), receipts issued to them and received from them, and the regulator and partner portals.
 * Received receipts from another organisation in this console are verified for real against its published key.
 */
export default function CounterpartiesPage() {
  const l3 = useIsL3();
  const level = useOrgLevel();
  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Counterparties"
        description="Receipts you issue to customers, vendors, insurers, lenders and regulators, and the ones they send you — each checked against the issuer’s published key."
        actions={l3 ? <HeaderActions /> : undefined}
      />
      {l3 ? <Register level={level} /> : <Preview />}
    </div>
  );
}

/* ── Header actions (open the dialogs through the URL so they are linkable) ── */

function HeaderActions() {
  const role = useRole();
  const [sp, setSp] = useSearchParams();
  const open = (d: string) => { const next = new URLSearchParams(sp); next.set('dialog', d); setSp(next, { replace: true }); };
  // viewers and auditors read the register: no buttons, and no note about buttons they cannot have
  if (!canManage(role)) return null;
  return (
    <>
      <Button variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => open('add')}>Add counterparty</Button>
      <Button variant="primary" icon={<Send className="h-4 w-4" aria-hidden />} onClick={() => open('issue')}>Issue a receipt</Button>
    </>
  );
}

/* ── L3 and Sovereign: the register ───────────────────────── */

function Register({ level }: { level: ReturnType<typeof useOrgLevel> }) {
  const nav = useNavigate();
  const role = useRole();
  const orgId = useOrgId();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.includes(sp.get('tab') as TabId) ? sp.get('tab') : 'register') as TabId;
  const setParam = (k: string, v?: string) => { const next = new URLSearchParams(sp); if (v) next.set(k, v); else next.delete(k); setSp(next, { replace: true }); };
  const dialog = sp.get('dialog');

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [reg, xs, ds, custody] = await Promise.all([api.counterparties(o), api.crossOrgReceipts(o), api.disclosures(o), api.custody(o)]);
    return { reg, xs, ds, custody };
  });

  const [cpOpen, setCpOpen] = useState<string>();
  const [issuedOpen, setIssuedOpen] = useState<string>();
  const [receivedOpen, setReceivedOpen] = useState<string>();
  const [seatsFor, setSeatsFor] = useState<string>();

  const cps = data?.reg.counterparties ?? [];

  // Deep links name a counterparty with ?id= (the agent map): open it on the register once the register has loaded.
  const linkedId = sp.get('id') ?? undefined;
  const linkedKnown = !!linkedId && cps.some((c) => c.id === linkedId);
  useEffect(() => {
    if (!linkedId || !linkedKnown) return;
    setCpOpen(linkedId);
    if (tab !== 'register') setParam('tab', undefined);
  }, [linkedId, linkedKnown]);
  const closeCp = () => { setCpOpen(undefined); if (sp.get('id')) setParam('id', undefined); };

  const issued = useMemo(() => (data?.xs ?? []).filter((x) => x.direction === 'issued'), [data]);
  const received = useMemo(() => (data?.xs ?? []).filter((x) => x.direction === 'received'), [data]);
  const verifiedIn = received.filter((x) => x.verification.state === 'verified').length;
  const seatsTotal = data?.reg.seatsTotal ?? 0;
  const seatPrice = data?.reg.seatPrice ?? SEAT_PRICE;

  const cpCols: Column<Counterparty>[] = [
    { key: 'name', header: 'Counterparty', sort: (c) => c.name, cell: (c) => (
      <span className="block min-w-0">
        <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{c.name}</span>{c.orgId && <LinkedBadge />}</span>
        <span className="block truncate font-mono text-[11.5px] text-muted">ar-org:{c.domain}</span>
      </span>
    ) },
    { key: 'kind', header: 'Kind', sort: (c) => c.kind, hideBelow: 'sm', cell: (c) => <KindLabel kind={c.kind} /> },
    { key: 'key', header: 'Their key', hideBelow: 'lg', cell: (c) => (
      <span className="block min-w-0">
        <span className="block text-xs text-muted">{KEY_ROUTE[c.keyRoute].label}</span>
        {c.keyFingerprint ? <span className="font-mono text-[11.5px]">{c.keyFingerprint}</span> : <span className="text-xs text-subtle">No fingerprint pinned</span>}
      </span>
    ) },
    { key: 'check', header: 'Key check', hideBelow: 'md', cell: (c) => <KeyCheckChip state={c.verification} /> },
    { key: 'seats', header: 'Seats', align: 'right', sort: (c) => c.seats, cell: (c) => <span className="num">{c.seatsUsed} of {c.seats}</span> },
    { key: 'issued', header: 'Issued', align: 'right', sort: (c) => c.issued, hideBelow: 'md', cell: (c) => <span className="num">{n(c.issued)}</span> },
    { key: 'received', header: 'Received', align: 'right', sort: (c) => c.received, hideBelow: 'md', cell: (c) => <span className="num">{n(c.received)}</span> },
    { key: 'since', header: 'Since', align: 'right', sort: (c) => c.since, hideBelow: 'lg', cell: (c) => <span className="num text-sm text-muted">{date(c.since)}</span> },
  ];

  const issuedCols: Column<CrossOrgReceipt>[] = [
    { key: 'at', header: 'Issued', sort: (x) => x.issuedAt, cell: (x) => <When iso={x.issuedAt} className="text-sm" /> },
    { key: 'to', header: 'To', sort: (x) => x.counterpartyName, cell: (x) => <span className="block max-w-[22ch] truncate font-medium" title={x.counterpartyName}>{x.counterpartyName}</span> },
    { key: 'seq', header: 'Receipt', sort: (x) => x.seq, cell: (x) => <ReceiptLink seq={x.seq} /> },
    { key: 'what', header: 'What', hideBelow: 'lg', cell: (x) => <span className="block max-w-[40ch] truncate text-sm text-muted" title={x.summary}>{x.summary}</span> },
    { key: 'exp', header: 'Expires', hideBelow: 'md', sort: (x) => x.expiresAt, cell: (x) => <span className="num text-sm text-muted">{date(x.expiresAt)}</span> },
    { key: 'state', header: 'Their check', cell: (x) => <span className="flex flex-wrap items-center gap-1"><CrossOrgChip state={x.verification.state} /><StandingChip x={x} /></span> },
    { key: 'portal', header: <span className="sr-only">Portal link</span>, align: 'right', hideBelow: 'sm', cell: (x) => (x.token
      ? <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}><CopyButton text={portalUrl(x.token)} label="Copy portal link" compact /><a className="link text-xs" href={`/counterparty/${x.token}`} target="_blank" rel="noreferrer">Portal</a></span>
      : <span className="text-xs text-subtle">Full receipt</span>) },
  ];

  const receivedCols: Column<CrossOrgReceipt>[] = [
    { key: 'at', header: 'Received', sort: (x) => x.receivedAt ?? x.issuedAt, cell: (x) => ((x.receivedAt ?? x.issuedAt) ? <When iso={(x.receivedAt ?? x.issuedAt)!} className="text-sm" /> : <span className="text-subtle">—</span>) },
    { key: 'from', header: 'From', sort: (x) => x.issuerName, cell: (x) => <span className="block max-w-[22ch] truncate font-medium" title={x.issuerName}>{x.issuerName}</span> },
    { key: 'seq', header: 'Their receipt', sort: (x) => x.seq, cell: (x) => <span className="font-mono text-[12.5px]">{seqLabel(x.seq)}</span> },
    { key: 'what', header: 'What', hideBelow: 'lg', cell: (x) => <span className="block max-w-[40ch] truncate text-sm text-muted" title={x.summary}>{x.summary}</span> },
    { key: 'state', header: 'Our check', cell: (x) => <span className="flex flex-wrap items-center gap-1"><CrossOrgChip state={x.verification.state} /><StandingChip x={x} /></span> },
    { key: 'bound', header: 'In our chain', hideBelow: 'md', cell: (x) => (x.boundSeq ? <ReceiptLink seq={x.boundSeq} /> : <span className="text-xs text-subtle">Not recorded yet</span>) },
  ];

  if (error) return <Banner tone="bad" title="Counterparties could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4" aria-live="polite">
        <Figure label="Counterparties" loading={loading} value={n(cps.length)} sub={`${cps.filter((c) => c.kind === 'regulator').length} regulator${cps.filter((c) => c.kind === 'regulator').length === 1 ? '' : 's'}`} />
        <Figure label="Verification seats" loading={loading} value={n(seatsTotal)} sub={`${rupees(seatsTotal * seatPrice)} a year`} />
        <Figure label="Receipts issued" loading={loading} value={n(issued.length)} sub={`${issued.filter((x) => x.verification.state === 'verified').length} verified · ${issued.filter((x) => x.revoked).length} revoked · ${issued.filter((x) => x.dispute?.status === 'open').length} disputed`} />
        <Figure label="Receipts received" loading={loading} value={n(received.length)} sub={`${verifiedIn} verified · ${received.filter((x) => x.acceptance?.state === 'pending').length} to accept · ${received.filter(isReplayed).length} replayed`} />
      </div>

      <p className="flex items-start gap-2 text-sm text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{LEVEL_INFO[level].label}: every receipt you issue is {evidenceClaim(level).charAt(0).toLowerCase() + evidenceClaim(level).slice(1)}</span>
      </p>

      <Tabs<TabId>
        label="Counterparty views"
        value={tab}
        onChange={(t) => setParam('tab', t === 'register' ? undefined : t)}
        items={[
          { value: 'register', label: 'Register', count: cps.length },
          { value: 'issued', label: 'Issued', count: issued.length },
          { value: 'received', label: 'Received', count: received.length },
          { value: 'portals', label: 'Portals' },
        ]}
      />

      {tab === 'register' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-8 space-y-6">
            <Panel flush title="Register" actions={canManage(role) ? <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" aria-hidden />} onClick={() => setParam('dialog', 'add')}>Add</Button> : undefined}>
              <DataTable
                caption="Counterparties that verify your receipts"
                columns={cpCols}
                rows={data?.reg.counterparties}
                loading={loading}
                rowKey={(c) => c.id}
                onRowClick={(c) => setCpOpen(c.id)}
                selectedKey={cpOpen}
                empty={
                  <EmptyState title="No counterparties yet" disc="registration" compact action={canManage(role) ? <Button variant="primary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setParam('dialog', 'add')}>Add the first counterparty</Button> : undefined}>
                    Add a customer, vendor, insurer, lender or regulator. Each one that verifies your receipts holds a seat at {rupees(SEAT_PRICE)} a year.
                  </EmptyState>
                }
              />
            </Panel>
            <SeatsPanel cps={cps} seatPrice={seatPrice} loading={loading} onChange={(id) => setSeatsFor(id)} />
          </div>
          <div className="min-w-0 lg:col-span-4 space-y-6">
            <Panel title="Your published key" kicker="What counterparties check">
              {!data ? <Skeleton className="h-16 w-full" /> : (
                <div className="space-y-3 text-sm">
                  <div>
                    <p className="label">Fingerprint</p>
                    <p className="mt-1 flex items-center gap-2"><span className="font-mono text-md">{data.custody.fingerprint}</span><CopyButton text={data.custody.fingerprint} label="Copy fingerprint" compact /></p>
                  </div>
                  <p className="text-muted leading-relaxed">Key <span className="font-mono text-xs">{data.custody.kid}</span> · {data.custody.provider} · {data.custody.location}</p>
                  <p className="text-muted leading-relaxed">Read this fingerprint to a counterparty over a channel you already trust, so they can pin it. Keys are also published at <span className="font-mono text-xs">/.well-known/action-receipt-keys</span>.</p>
                  <SmartLink hideWhenBlocked to="/agents/keys" className="link text-sm">Keys and custody</SmartLink>
                </div>
              )}
            </Panel>
            <Panel title="How they find your key" kicker="Never a hint inside the receipt">
              <ol className="space-y-3 text-sm">
                {(['pinned', 'well_known', 'trust_anchor'] as const).map((k, i) => (
                  <li key={k} className="flex gap-3">
                    <span className="num w-4 shrink-0 text-subtle">{i + 1}</span>
                    <span><span className="block font-medium break-all">{KEY_ROUTE[k].label}</span><span className="block text-muted">{KEY_ROUTE[k].detail}</span></span>
                  </li>
                ))}
              </ol>
            </Panel>
          </div>
        </div>
      )}

      {tab === 'issued' && (
        <Panel flush title="Receipts you issued" actions={canManage(role) ? <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" aria-hidden />} onClick={() => setParam('dialog', 'issue')}>Issue a receipt</Button> : undefined}>
          <DataTable
            caption="Receipts issued to counterparties"
            columns={issuedCols}
            rows={issued}
            loading={loading}
            rowKey={(x) => x.id}
            onRowClick={(x) => setIssuedOpen(x.id)}
            initialSort={{ key: 'at', dir: 'desc' }}
            empty={
              <EmptyState title="Nothing issued yet" disc="trail" compact action={canManage(role) && cps.length ? <Button variant="primary" icon={<Send className="h-4 w-4" aria-hidden />} onClick={() => setParam('dialog', 'issue')}>Issue a receipt</Button> : undefined}>
                {cps.length ? 'Issue a receipt to a counterparty, revealing only the fields they need.' : 'Add a counterparty first, then issue receipts to them.'}
              </EmptyState>
            }
          />
        </Panel>
      )}

      {tab === 'received' && (
        <Panel flush title="Receipts you received" footer={<p className="text-xs text-muted leading-relaxed">{LIMITS_LINE}</p>}>
          <DataTable
            caption="Receipts received from counterparties"
            columns={receivedCols}
            rows={received}
            loading={loading}
            rowKey={(x) => x.id}
            onRowClick={(x) => setReceivedOpen(x.id)}
            empty={
              <EmptyState title="Nothing received yet" disc="orbit" compact>
                When a counterparty issues a receipt addressed to <span className="font-mono">ar-org:{ORGS.find((o) => o.id === orgId)?.domain ?? 'your domain'}</span>, it arrives here and is checked against their published key.
              </EmptyState>
            }
          />
        </Panel>
      )}

      {tab === 'portals' && <Portals cps={cps} ds={data?.ds} loading={loading} onShare={(id) => nav(`/assurance/disclosure?cp=${id}`)} />}

      <CounterpartyDrawer cp={cps.find((c) => c.id === cpOpen)} xs={data?.xs ?? []} ds={data?.ds ?? []} onClose={closeCp} onSeats={(id) => setSeatsFor(id)} onIssue={(id) => { setCpOpen(undefined); const next = new URLSearchParams(sp); next.delete('id'); next.set('dialog', 'issue'); next.set('cp', id); setSp(next, { replace: true }); }} />
      <IssuedDrawer x={issued.find((x) => x.id === issuedOpen)} onClose={() => setIssuedOpen(undefined)} />
      <ReceivedDrawer x={received.find((x) => x.id === receivedOpen)} all={received} cp={cps.find((c) => c.id === received.find((x) => x.id === receivedOpen)?.counterpartyId)} onClose={() => setReceivedOpen(undefined)} />
      <SeatsDialog cp={cps.find((c) => c.id === seatsFor)} seatPrice={seatPrice} onClose={() => setSeatsFor(undefined)} />
      {dialog === 'add' && canManage(role) && <AddDialog onClose={() => setParam('dialog')} />}
      {dialog === 'issue' && data && canManage(role) && <IssueDialog cps={cps} initialCp={sp.get('cp') ?? undefined} onClose={() => { const next = new URLSearchParams(sp); next.delete('dialog'); next.delete('cp'); setSp(next, { replace: true }); }} />}
    </div>
  );
}

function KindLabel({ kind }: { kind: CounterpartyKind }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {kind === 'regulator' ? <Landmark className="h-3.5 w-3.5 text-muted" aria-hidden /> : <Handshake className="h-3.5 w-3.5 text-muted" aria-hidden />}
      {KIND_LABEL[kind]}
    </span>
  );
}

/* ── Seats ─────────────────────────────────────────────────── */

function SeatsPanel({ cps, seatPrice, loading, onChange }: { cps: Counterparty[]; seatPrice: number; loading: boolean; onChange: (id: string) => void }) {
  const role = useRole();
  const total = cps.reduce((s, c) => s + c.seats, 0);
  const used = cps.reduce((s, c) => s + c.seatsUsed, 0);
  return (
    <Panel
      title="Verification seats"
      kicker={`${rupees(seatPrice)} per seat per year`}
      actions={<SmartLink hideWhenBlocked to="/billing" className="link text-sm">Meter and invoices</SmartLink>}
      footer={<p className="text-xs text-muted">Seats appear on each monthly invoice as “Counterparty verification seats”, at one twelfth of the yearly price for a full month, and pro rata by day in a month when seats change. Past months are never rewritten.</p>}
    >
      {loading ? <Skeleton className="h-24 w-full" /> : !cps.length ? (
        <p className="text-sm text-muted">No seats yet. Each counterparty you add starts with the seats you choose.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <p><span className="font-display text-3xl font-semibold num">{n(total)}</span> <span className="text-sm text-muted">seats · {n(used)} in use</span></p>
            <p className="text-sm"><span className="font-semibold num">{rupees(total * seatPrice)}</span> <span className="text-muted">a year</span></p>
          </div>
          <ul className="divide-y divide-line border-y border-line">
            {cps.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                <span className="num text-sm text-muted">{c.seatsUsed} of {c.seats} in use</span>
                <span className="num w-28 text-right text-sm">{rupees(c.seats * seatPrice)}</span>
                {canManage(role) && <Button size="sm" variant="ghost" onClick={() => onChange(c.id)} aria-label={`Change seats for ${c.name}`}>Change</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function SeatsDialog({ cp, seatPrice, onClose }: { cp?: Counterparty; seatPrice: number; onClose: () => void }) {
  const user = useUser();
  const orgId = useOrgId();
  const [seats, setSeatsValue] = useState(1);
  const m = useMutation((o: string, id: string, next: number, u: string) => api.setCounterpartySeats(o, id, next, u));
  useEffect(() => { if (cp) setSeatsValue(cp.seats); }, [cp]);
  if (!cp) return null;
  const delta = (seats - cp.seats) * seatPrice;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      await m.mutate(orgId, cp.id, seats, user!.id);
      toast.ok('Seats changed', `${cp.name} now holds ${plural(seats, 'seat')}. A receipt records the change.`);
      onClose();
    } catch { /* shown below */ }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Seats for ${cp.name}`}
      description={`Each seat lets one verifier at ${cp.name} check your receipts. ${rupees(seatPrice)} per seat per year.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.pending} disabled={seats === cp.seats} onClick={() => submit()}>Save {plural(seats, 'seat')}</Button></>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Seats" htmlFor="seat-count" hint={`${cp.seatsUsed} in use. You cannot go below that.`}>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" aria-label="One seat fewer" onClick={() => setSeatsValue((s) => Math.max(1, s - 1))} icon={<Minus className="h-4 w-4" aria-hidden />} />
            <Input id="seat-count" type="number" min={Math.max(1, cp.seatsUsed)} max={50} value={seats} onChange={(e) => setSeatsValue(Number(e.target.value) || 0)} className="w-24 text-center num" />
            <Button type="button" variant="secondary" aria-label="One seat more" onClick={() => setSeatsValue((s) => Math.min(50, s + 1))} icon={<Plus className="h-4 w-4" aria-hidden />} />
          </div>
        </Field>
        <dl className="space-y-1 border border-line bg-sunken/50 p-3 text-sm">
          <div className="flex justify-between"><dt className="text-muted">Now</dt><dd className="num">{rupees(cp.seats * seatPrice)} a year</dd></div>
          <div className="flex justify-between"><dt className="text-muted">After</dt><dd className="num">{rupees(Math.max(0, seats) * seatPrice)} a year</dd></div>
          <div className="flex justify-between border-t border-line pt-1 font-medium"><dt>Change</dt><dd className="num">{delta >= 0 ? '+' : '−'}{rupees(Math.abs(delta))} a year</dd></div>
        </dl>
        {m.error && <Banner tone="bad">{m.error.message}</Banner>}
      </form>
    </Dialog>
  );
}

/* ── Portals ───────────────────────────────────────────────── */

function Portals({ cps, ds, loading, onShare }: { cps: Counterparty[]; ds?: DisclosurePackage[]; loading: boolean; onShare: (cpId: string) => void }) {
  const role = useRole();
  const now = useNow(60_000);
  const groups: { title: string; kicker: string; icon: React.ReactNode; rows: Counterparty[] }[] = [
    { title: 'Regulator portals', kicker: 'Read-only, no sign-in', icon: <Landmark className="h-4 w-4" aria-hidden />, rows: cps.filter((c) => c.kind === 'regulator') },
    { title: 'Partner portals', kicker: 'Customers, vendors, insurers and lenders', icon: <Users className="h-4 w-4" aria-hidden />, rows: cps.filter((c) => c.kind !== 'regulator') },
  ];
  if (loading) return <Skeleton className="h-48 w-full" />;
  return (
    <div className="space-y-6">
      <p className="max-w-[78ch] text-sm text-muted leading-relaxed">
        A portal is a page at <span className="font-mono text-xs">/counterparty/&lt;token&gt;</span> that a regulator or partner opens without signing in. It shows only the fields you revealed, shows the rest as withheld digests, and checks your signature in their browser.
      </p>
      {groups.map((g) => (
        <Panel key={g.title} flush title={<span className="inline-flex items-center gap-2">{g.icon}{g.title}</span>} kicker={g.kicker}>
          {!g.rows.length ? (
            <p className="px-5 py-6 text-sm text-muted">{g.title === 'Regulator portals' ? 'No regulator in the register. Add one from the Register tab.' : 'No partner in the register yet.'}</p>
          ) : (
            <ul className="divide-y divide-line">
              {g.rows.map((c) => {
                const mine = (ds ?? []).filter((p) => p.counterpartyId === c.id);
                const active = mine.filter((p) => packageStatus(p, now) === 'active');
                const views = mine.reduce((s, p) => s + p.views, 0);
                const latest = active[0];
                return (
                  <li key={c.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">{c.name}{c.orgId && <LinkedBadge />}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {KIND_LABEL[c.kind]} · {plural(active.length, 'active disclosure')} · {plural(views, 'view')}{latest ? <> · latest expires {date(latest.expiresAt)}</> : null}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {latest ? (
                        <>
                          <CopyButton text={portalUrl(latest.token)} label={`Copy portal link for ${c.name}`} compact />
                          <a href={`/counterparty/${latest.token}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 border border-line-strong/70 bg-surface px-3 text-sm hover:border-fg">
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden />Open portal
                          </a>
                        </>
                      ) : <span className="text-xs text-subtle">Nothing shared yet</span>}
                      {canManage(role) && <Button size="sm" variant="secondary" onClick={() => onShare(c.id)}>Share a disclosure</Button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      ))}
    </div>
  );
}

/* ── Drawers ───────────────────────────────────────────────── */

function CounterpartyDrawer({ cp, xs, ds, onClose, onSeats, onIssue }: { cp?: Counterparty; xs: CrossOrgReceipt[]; ds: DisclosurePackage[]; onClose: () => void; onSeats: (id: string) => void; onIssue: (id: string) => void }) {
  const role = useRole();
  if (!cp) return null;
  const mine = xs.filter((x) => x.counterpartyId === cp.id);
  const pkgs = ds.filter((p) => p.counterpartyId === cp.id);
  return (
    <Drawer open onClose={onClose} kicker={`Assurance · Counterparty · ${KIND_LABEL[cp.kind]}`} title={cp.name}
      footer={canManage(role) ? <div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={() => onSeats(cp.id)}>Change seats</Button><Button variant="primary" icon={<Send className="h-4 w-4" aria-hidden />} onClick={() => onIssue(cp.id)}>Issue a receipt</Button></div> : undefined}>
      <div className="space-y-6">
        {cp.orgId && <Banner tone="info" title="Another organisation in this console">Receipts you issue to {cp.name} arrive in its register and are checked there against your published key; receipts it issues to you are checked here against its key.</Banner>}
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="label">Identity</dt><dd className="mt-1 font-mono text-xs break-all">ar-org:{cp.domain}</dd></div>
          <div><dt className="label">Contact</dt><dd className="mt-1">{cp.contact}</dd></div>
          <div><dt className="label">Key route</dt><dd className="mt-1 break-all">{KEY_ROUTE[cp.keyRoute].label}</dd></div>
          <div><dt className="label">Pinned fingerprint</dt><dd className="mt-1 font-mono text-xs">{cp.keyFingerprint ?? 'None — fetched from their domain'}</dd></div>
          <div><dt className="label">Key check</dt><dd className="mt-1"><KeyCheckChip state={cp.verification} /></dd></div>
          <div><dt className="label">Seats</dt><dd className="mt-1 num">{cp.seatsUsed} of {cp.seats} in use · {rupees(cp.seats * SEAT_PRICE)} a year</dd></div>
          <div><dt className="label">In the register since</dt><dd className="mt-1 num">{date(cp.since)}</dd></div>
          <div><dt className="label">Receipts</dt><dd className="mt-1 num">{n(cp.issued)} issued · {n(cp.received)} received</dd></div>
        </dl>
        <div>
          <p className="label mb-2">Receipts between you</p>
          {!mine.length ? <p className="text-sm text-muted">None yet.</p> : (
            <ul className="divide-y divide-line border border-line">
              {mine.slice(0, 12).map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  {x.direction === 'issued' ? <Send className="h-3.5 w-3.5 text-muted" aria-label="Issued" /> : <Inbox className="h-3.5 w-3.5 text-muted" aria-label="Received" />}
                  {x.direction === 'issued' ? <ReceiptLink seq={x.seq} /> : <span className="font-mono text-[12.5px]">{seqLabel(x.seq)}</span>}
                  <span className="min-w-0 flex-1 truncate text-muted" title={x.summary}>{x.summary}</span>
                  <CrossOrgChip state={x.verification.state} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="label mb-2">Disclosure packages</p>
          {!pkgs.length ? <p className="text-sm text-muted">None shared with {cp.name}.</p> : (
            <ul className="divide-y divide-line border border-line">
              {pkgs.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <ReceiptLink seq={p.seq} />
                  <span className="flex-1 text-muted">{p.revealed.length} of {p.committed.length} fields · {plural(p.views, 'view')}</span>
                  <Link className="link text-xs" to={`/assurance/disclosure?pkg=${p.id}`}>Open</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}

type IssuedAction = 'revoke' | 'record' | 'resolve';

function IssuedDrawer({ x, onClose }: { x?: CrossOrgReceipt; onClose: () => void }) {
  const role = useRole();
  const [action, setAction] = useState<IssuedAction>();
  useEffect(() => { setAction(undefined); }, [x?.id]);
  if (!x) return null;
  const manage = canManage(role);
  const open = x.dispute?.status === 'open';
  return (
    <>
    <Drawer open onClose={onClose} kicker="Assurance · Issued receipt" title={`${seqLabel(x.seq)} to ${x.counterpartyName}`}
      footer={manage ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {open && <Button variant="primary" icon={<Scale className="h-4 w-4" aria-hidden />} onClick={() => setAction('resolve')}>Resolve the dispute</Button>}
          {!open && !x.revoked && <Button variant="secondary" icon={<Scale className="h-4 w-4" aria-hidden />} onClick={() => setAction('record')}>Record a dispute they raised</Button>}
          {!x.revoked && <Button variant="quiet-danger" icon={<Ban className="h-4 w-4" aria-hidden />} onClick={() => setAction('revoke')}>Revoke</Button>}
        </div>
      ) : undefined}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2"><CrossOrgChip state={x.verification.state} /><StandingChip x={x} /></div>
        {x.revoked && (
          <Banner tone="bad" title={`Revoked ${dateTime(x.revoked.at)} by ${userName(x.revoked.by)}`}>
            {x.revoked.reason} {x.token ? 'Its portal link no longer opens.' : ''} A copy {x.counterpartyName} saved still verifies; revoking is recorded{x.revoked.seq ? <> as <ReceiptLink seq={x.revoked.seq} /></> : ''}, it does not unsign the record.
          </Banner>
        )}
        {x.dispute && <DisputeBlock d={x.dispute} who={x.counterpartyName} />}
        <p className="text-sm leading-relaxed">{x.summary}</p>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="label">Audience</dt><dd className="mt-1 font-mono text-xs break-all">{x.audience}</dd></div>
          <div><dt className="label">Nonce</dt><dd className="mt-1 font-mono text-xs">{x.nonce}</dd></div>
          <div><dt className="label">Issued</dt><dd className="mt-1 num">{dateTime(x.issuedAt)}</dd></div>
          <div><dt className="label">Expires</dt><dd className="mt-1 num">{dateTime(x.expiresAt)}</dd></div>
          <div><dt className="label">Receipt hash</dt><dd className="mt-1"><Hash value={x.receiptHash} len={20} /></dd></div>
          <div><dt className="label">Key</dt><dd className="mt-1 font-mono text-xs">{x.kid} · {sha256Hex(x.publicKey ?? '').slice(0, 16)}</dd></div>
        </dl>
        <div>
          <p className="label mb-2">Their verifier</p>
          <VerifySteps steps={x.verification.steps} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/activity/${x.seq}`} className="inline-flex h-8 items-center border border-line-strong/70 px-3 text-sm hover:border-fg">Open the receipt</Link>
          {x.token && <a href={`/counterparty/${x.token}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 border border-line-strong/70 px-3 text-sm hover:border-fg"><ExternalLink className="h-3.5 w-3.5" aria-hidden />Open their portal page</a>}
          {x.token && <CopyButton text={portalUrl(x.token)} label="Copy portal link" />}
          {x.disclosureId && <Link to={`/assurance/disclosure?pkg=${x.disclosureId}`} className="inline-flex h-8 items-center border border-line-strong/70 px-3 text-sm hover:border-fg">Disclosure package</Link>}
        </div>
      </div>
    </Drawer>
    {action && <IssuedActionDialog x={x} action={action} onClose={() => setAction(undefined)} />}
    </>
  );
}

/** A dispute about a receipt: who raised it, what, and how it was resolved. */
function DisputeBlock({ d, who }: { d: NonNullable<CrossOrgReceipt['dispute']>; who: string }) {
  const raiser = d.side === 'counterparty' ? d.raisedBy : userName(d.raisedBy);
  return (
    <Banner tone={d.status === 'open' ? 'held' : 'neutral'} title={d.status === 'open' ? `Disputed by ${raiser}` : d.closedBy === 'revocation' ? 'Dispute closed: the issuer revoked the receipt' : d.closedBy === 'receiver' ? (d.status === 'upheld' ? 'Dispute closed by the receiver: the issuer agreed' : 'Dispute withdrawn by the receiver') : d.status === 'upheld' ? 'Dispute upheld' : 'Dispute rejected'}>
      <span className="block">“{d.reason}” · raised {dateTime(d.raisedAt)}{d.side === 'counterparty' ? ` by ${who}` : ''}{d.seq ? <> · <ReceiptLink seq={d.seq} /></> : null}</span>
      {d.status !== 'open' && <span className="mt-1 block">Resolved {d.resolvedAt ? dateTime(d.resolvedAt) : ''}{d.resolvedBy ? ` by ${d.resolvedBy.includes(',') ? d.resolvedBy : userName(d.resolvedBy)}` : ''}: {d.resolution}{d.resolveSeq ? <> · <ReceiptLink seq={d.resolveSeq} /></> : null}</span>}
    </Banner>
  );
}

function IssuedActionDialog({ x, action, onClose }: { x: CrossOrgReceipt; action: IssuedAction; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [text, setText] = useState('');
  const [who, setWho] = useState('');
  const [outcome, setOutcome] = useState<'upheld' | 'rejected'>('rejected');
  const m = useMutation(async () => {
    if (action === 'revoke') return api.revokeIssued(orgId, x.id, user!.id, text);
    if (action === 'record') return api.recordDispute(orgId, x.id, user!.id, { raisedBy: who, reason: text });
    return api.resolveDispute(orgId, x.id, user!.id, outcome, text);
  });
  const go = async () => {
    try {
      const res = await m.mutate();
      const told = 'peerTold' in res && res.peerTold ? ` ${x.counterpartyName} is told in its console${action === 'revoke' && x.dispute?.status === 'open' ? ', and the open dispute is closed on both sides' : ''}.` : action === 'revoke' && x.dispute?.status === 'open' ? ' The open dispute is closed by the revocation.' : '';
      toast.ok(action === 'revoke' ? 'Receipt revoked' : action === 'record' ? 'Dispute recorded' : outcome === 'upheld' ? 'Dispute upheld; the receipt is revoked' : 'Dispute rejected; the receipt stands', `A receipt in your chain records it.${told}`);
      onClose();
    } catch { /* shown below */ }
  };
  const title = action === 'revoke' ? `Revoke ${seqLabel(x.seq)} issued to ${x.counterpartyName}?` : action === 'record' ? `Record a dispute from ${x.counterpartyName}` : `Resolve the dispute about ${seqLabel(x.seq)}`;
  return (
    <Dialog open onClose={onClose} tone={action === 'revoke' ? 'danger' : undefined} title={title}
      description={action === 'revoke' ? 'The portal link stops and the counterparty is told. A copy they saved still verifies: revoking does not unsign it.' : action === 'record' ? 'For a counterparty outside this console that raised it by phone, email or letter.' : 'Upheld revokes the receipt. Rejected keeps it, with your reason. Both sides see the outcome.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={action === 'revoke' || (action === 'resolve' && outcome === 'upheld') ? 'danger' : 'primary'} loading={m.pending} onClick={go}>{action === 'revoke' ? 'Revoke' : action === 'record' ? 'Record the dispute' : outcome === 'upheld' ? 'Uphold and revoke' : 'Reject the dispute'}</Button></>}>
      <div className="space-y-4">
        {x.dispute && action === 'resolve' && <p className="text-sm">“{x.dispute.reason}” — {x.dispute.side === 'counterparty' ? x.dispute.raisedBy : userName(x.dispute.raisedBy)}</p>}
        {action === 'resolve' && (
          <Field label="Outcome" htmlFor="dispute-outcome">
            <Select id="dispute-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as 'upheld' | 'rejected')}>
              <option value="rejected">Rejected — the receipt stands</option>
              <option value="upheld">Upheld — revoke the receipt</option>
            </Select>
          </Field>
        )}
        {action === 'record' && (
          <Field label="Raised by" htmlFor="dispute-who" required hint="Name and role at the counterparty.">
            <Input id="dispute-who" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Claims audit desk, Star Health" />
          </Field>
        )}
        <Field label={action === 'revoke' ? 'Reason' : action === 'record' ? 'What they dispute' : 'What was decided and why'} htmlFor="issued-note" required hint={action === 'revoke' ? `${x.counterpartyName} sees this reason.` : 'Recorded on the receipt.'}>
          <Textarea id="issued-note" rows={3} value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
        </Field>
        {m.error && <Banner tone="bad">{m.error.message}</Banner>}
      </div>
    </Dialog>
  );
}

interface LocalCheck { steps: VerifyStep[]; ok: boolean; ms: number; tampered: boolean; resent?: boolean }

/**
 * Check a received receipt in this browser: audience → expiry → key from the issuer's published set → content hash →
 * signature → nonce (replay) → timestamp. `resent` checks a second copy of the same signed receipt arriving now.
 */
function checkLocally(x0: CrossOrgReceipt, cp: Counterparty | undefined, myDomain: string, tamper: boolean, all: CrossOrgReceipt[] = [], resent = false): LocalCheck {
  // a resent copy: the same signed receipt and nonce, arriving now, after the copy already held
  const x: CrossOrgReceipt = resent ? { ...x0, id: `${x0.id}_resent_local`, receivedAt: new Date().toISOString() } : x0;
  const list = resent ? [x, ...all] : all.includes(x0) ? all : [x0, ...all];
  const t0 = performance.now();
  const steps: VerifyStep[] = [];
  steps.push({ label: 'Audience', state: x.audience === `ar-org:${myDomain}` ? 'pass' : 'fail', detail: `Addressed to ${x.audience}; this organisation is ar-org:${myDomain}.` });
  const expired = new Date(x.expiresAt).getTime() < Date.now();
  steps.push({ label: 'Expiry', state: expired ? 'fail' : 'pass', detail: expired ? `Expired ${dateTime(x.expiresAt)}.` : `Valid until ${dateTime(x.expiresAt)}.` });
  // the issuer's published key set (/.well-known/action-receipt-keys at its domain) — never the key the receipt carries
  let published: string | undefined;
  try { published = api.chainSlice(x.issuerOrgId, x.seq, x.seq).publicKeys[x.kid]; } catch { published = undefined; }
  const fp = published ? sha256Hex(published).slice(0, 16) : undefined;
  const pinned = cp?.keyFingerprint;
  const keyState: VerifyStep['state'] = !published ? 'fail' : pinned ? (pinned === fp ? 'pass' : 'fail') : 'pass';
  steps.push({
    label: 'Issuer key', state: keyState,
    detail: !published
      ? `Key ${x.kid} is not in ${x.issuerName}’s published key set.`
      : `Key ${x.kid} found in ${x.issuerName}’s published key set; fingerprint ${fp}${pinned ? (pinned === fp ? `, matching the pinned ${pinned}` : `, not the pinned ${pinned}`) : ' (no fingerprint pinned)'}.`,
  });
  const body: Receipt | undefined = x.receipt ? (tamper ? { ...x.receipt, reason: `${x.receipt.reason ?? ''} (edited)`, args_summary: { ...(x.receipt.args_summary ?? {}), amount: Number(x.receipt.args_summary?.amount ?? 0) + 100000 } } : x.receipt) : undefined;
  const hashOk = !!body && receiptHash(body) === x.receiptHash;
  steps.push({ label: 'Content hash', state: hashOk ? 'pass' : 'fail', detail: hashOk ? 'SHA-256 over the canonical receipt recomputes to the hash it carries.' : tamper ? 'The changed copy no longer recomputes to the signed hash.' : 'The receipt does not match its hash.' });
  const sigOk = !!published && verifySig(x.receiptHash, x.sig, published);
  steps.push({ label: 'Signature', state: sigOk ? 'pass' : 'fail', detail: sigOk ? 'Ed25519 signature verifies against the published key.' : 'The signature does not verify against the published key.' });
  steps.push(replayStep(list, x));
  const ts = x.verification.steps.find((s) => s.label === 'Timestamp');
  steps.push(ts ?? { label: 'Timestamp', state: 'skip', detail: 'UNANCHORED — no timestamp token for this receipt.' });
  const ok = steps.every((s) => s.state !== 'fail');
  return { steps, ok, ms: Math.max(1, Math.round(performance.now() - t0)), tampered: tamper, resent };
}

type ReceivedAction = 'accept' | 'refuse' | 'dispute' | 'close';

function ReceivedDrawer({ x, all, cp, onClose }: { x?: CrossOrgReceipt; all: CrossOrgReceipt[]; cp?: Counterparty; onClose: () => void }) {
  const role = useRole();
  const user = useUser();
  const orgId = useOrgId();
  const [local, setLocal] = useState<LocalCheck>();
  const [running, setRunning] = useState(false);
  const [action, setAction] = useState<ReceivedAction>();
  const rec = useMutation((o: string, id: string, u: string) => api.verifyReceivedChecked(o, id, u));
  useEffect(() => { setLocal(undefined); setAction(undefined); }, [x?.id]);
  if (!x) return null;
  const myDomain = ORGS.find((o) => o.id === orgId)?.domain ?? '';
  const run = (tamper: boolean, resent = false) => {
    setRunning(true);
    window.setTimeout(() => { setLocal(checkLocally(x, cp, myDomain, tamper, all, resent)); setRunning(false); }, 30);
  };
  const manage = canManage(role);
  const replayed = isReplayed(x);
  const acc = x.acceptance;
  const firstIsMe = acc?.state === 'pending' && acc.first?.userId === user?.id;
  const canAccept = !replayed && !x.issuerRevoked && x.dispute?.status !== 'open' && x.verification.state === 'verified' && acc?.state !== 'accepted' && acc?.state !== 'refused';
  const record = async () => {
    try {
      const r = await rec.mutate(orgId, x.id, user!.id);
      toast.ok(r.verification.state === 'verified' ? 'Verified and recorded' : `Checked: ${r.verification.state}`, r.boundSeq ? `Receipt ${seqLabel(r.boundSeq)} in your chain binds it.` : undefined);
    } catch { /* shown below */ }
  };
  return (
    <>
    <Drawer open onClose={onClose} width={640} kicker={`Assurance · Received from ${x.issuerName}`} title={`Their receipt ${seqLabel(x.seq)}`}
      footer={manage
        ? <div className="flex flex-wrap items-center justify-end gap-2"><span className="mr-auto text-xs text-muted">Recording writes a receipt in your chain that binds this one.</span><Button variant="primary" icon={<ShieldCheck className="h-4 w-4" aria-hidden />} loading={rec.pending} onClick={record}>Verify and record</Button></div>
        : undefined}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2"><CrossOrgChip state={x.verification.state} /><StandingChip x={x} /></div>
        {replayed && (
          <Banner tone="bad" title={`Refused: ${REPLAY_CODE}`}>
            {x.issuerName} signed this receipt, and the signature verifies, but a copy with the same nonce ({x.nonce}) arrived first. This copy is not counted or accepted again.
          </Banner>
        )}
        {x.issuerRevoked && (
          <Banner tone="bad" title={`${x.issuerName} revoked this receipt`}>
            {x.issuerRevoked.reason} · {dateTime(x.issuerRevoked.at)}{x.issuerRevoked.seq ? <> · <ReceiptLink seq={x.issuerRevoked.seq} /></> : null}. It still verifies as signed; do not rely on it.
          </Banner>
        )}
        {x.dispute && <DisputeBlock d={x.dispute} who={x.issuerName} />}
        <p className="text-sm leading-relaxed">{x.summary}</p>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="label">Issuer</dt><dd className="mt-1">{x.issuerName}</dd></div>
          <div><dt className="label">Audience</dt><dd className="mt-1 font-mono text-xs break-all">{x.audience}</dd></div>
          <div><dt className="label">Receipt hash</dt><dd className="mt-1"><Hash value={x.receiptHash} len={20} /></dd></div>
          <div><dt className="label">Key</dt><dd className="mt-1 font-mono text-xs">{x.kid}</dd></div>
          <div><dt className="label">Issued by them</dt><dd className="mt-1 num">{x.issuedAt ? dateTime(x.issuedAt) : '—'}</dd></div>
          <div><dt className="label">This copy arrived</dt><dd className="mt-1 num">{x.receivedAt ? dateTime(x.receivedAt) : '—'}</dd></div>
          <div><dt className="label">Nonce</dt><dd className="mt-1 font-mono text-xs">{x.nonce || '—'}</dd></div>
          <div><dt className="label">Expires</dt><dd className="mt-1 num">{dateTime(x.expiresAt)}</dd></div>
          <div><dt className="label">In your chain</dt><dd className="mt-1">{x.boundSeq ? <ReceiptLink seq={x.boundSeq} /> : <span className="text-muted">Not recorded yet</span>}</dd></div>
        </dl>
        {rec.error && <Banner tone="bad">{rec.error.message}</Banner>}

        <section aria-labelledby="local-check">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 id="local-check" className="text-md font-semibold">Check it in this browser</h3>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />} loading={running} onClick={() => run(false)}>Run the check</Button>
              <Button size="sm" variant="ghost" className="border-line" icon={<FlaskConical className="h-3.5 w-3.5" aria-hidden />} disabled={running} onClick={() => run(true)}>Try a changed copy</Button>
              <Button size="sm" variant="ghost" className="border-line" icon={<Copy className="h-3.5 w-3.5" aria-hidden />} disabled={running || replayed} onClick={() => run(false, true)}>Try a resent copy</Button>
            </div>
          </div>
          {local ? (
            <div className="space-y-2" aria-live="polite">
              <Banner tone={local.ok ? 'ok' : 'bad'} title={local.ok ? 'Verified in this browser' : local.tampered ? 'The changed copy fails, as it should' : local.resent ? `The resent copy is refused as ${REPLAY_CODE}, as it should be` : 'Did not verify'}>
                {local.ok ? `Signed by ${x.issuerName}’s published key and unchanged since it was signed.` : local.resent ? 'Same signature, same nonce: the signature still verifies, but the nonce was already received, so the copy is not counted twice.' : 'At least one check failed; see the steps below.'} {local.ms} ms.
              </Banner>
              <VerifySteps steps={local.steps} />
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted">Last recorded check{x.verification.checkedAt ? <> · {dateTime(x.verification.checkedAt)}</> : null}</p>
              <VerifySteps steps={x.verification.steps} />
            </div>
          )}
        </section>

        <section aria-labelledby="accept-title" className="space-y-2">
          <h3 id="accept-title" className="text-md font-semibold">Accept it</h3>
          <p className="text-sm text-muted leading-relaxed">Accepting a received receipt crosses the boundary between you and {x.issuerName}, so it takes two people: one owner or admin starts it and a different one completes it. Only a verified copy that is not revoked, disputed or replayed can be accepted.</p>
          {acc?.first && (
            <ol className="divide-y divide-line border border-line text-sm">
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"><UserCheck className="h-3.5 w-3.5 text-muted" aria-hidden /><span className="font-medium">{userName(acc.first.userId)}</span><span className="text-muted">{acc.state === 'refused' && !acc.second ? 'refused' : 'started'} · {dateTime(acc.first.at)}</span>{acc.first.seq && <ReceiptLink seq={acc.first.seq} />}{acc.first.note && <span className="w-full text-xs text-muted">“{acc.first.note}”</span>}</li>
              {acc.second ? (
                <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"><UserCheck className="h-3.5 w-3.5 text-muted" aria-hidden /><span className="font-medium">{userName(acc.second.userId)}</span><span className="text-muted">{acc.state === 'refused' ? 'refused' : 'completed'} · {dateTime(acc.second.at)}</span>{acc.second.seq && <ReceiptLink seq={acc.second.seq} />}{acc.second.note && <span className="w-full text-xs text-muted">“{acc.second.note}”</span>}</li>
              ) : <li className="px-3 py-2 text-muted">Waiting for a second owner or admin{firstIsMe ? ' — not you: you started it' : ''}.</li>}
            </ol>
          )}
          {manage ? (
            <div className="flex flex-wrap gap-2">
              {canAccept && <Button size="sm" variant={acc?.state === 'pending' ? 'primary' : 'secondary'} icon={<UserCheck className="h-3.5 w-3.5" aria-hidden />} disabled={firstIsMe} onClick={() => setAction('accept')}>{acc?.state === 'pending' ? 'Complete acceptance' : 'Start acceptance'}</Button>}
              {acc?.state !== 'accepted' && acc?.state !== 'refused' && <Button size="sm" variant="ghost" className="border-line" onClick={() => setAction('refuse')}>Refuse it</Button>}
              {!canAccept && acc?.state !== 'accepted' && acc?.state !== 'refused' && <span className="self-center text-xs text-muted">{replayed ? `A replayed copy is never accepted.` : x.issuerRevoked ? 'Revoked by the issuer.' : x.dispute?.status === 'open' ? 'Resolve the dispute first.' : `The recorded check is ${x.verification.state}; verify and record it again first.`}</span>}
            </div>
          ) : null}
        </section>

        {/* raising a dispute is for owners, admins and approvers: viewers and auditors do not see the section */}
        {(role === 'owner' || role === 'admin' || role === 'approver') && (
          <section aria-labelledby="dispute-title" className="space-y-2">
            <h3 id="dispute-title" className="text-md font-semibold">Dispute it</h3>
            <p className="text-sm text-muted leading-relaxed">If the record does not match what you know, dispute it. {x.issuerName} is told{ORGS.some((o) => o.id === x.issuerOrgId) ? ' in its console' : ''} and resolves it; the outcome is recorded on both sides.</p>
            <div className="flex flex-wrap gap-2">
              {x.dispute?.status !== 'open' && !x.issuerRevoked && <Button size="sm" variant="secondary" icon={<Scale className="h-3.5 w-3.5" aria-hidden />} onClick={() => setAction('dispute')}>Raise a dispute</Button>}
              {x.dispute?.status === 'open' && manage && <Button size="sm" variant="ghost" className="border-line" onClick={() => setAction('close')}>Close our side</Button>}
            </div>
          </section>
        )}

        {x.receipt && (
          <details className="border border-line">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">The receipt as they sent it</summary>
            <div className="border-t border-line p-3"><JsonView value={x.receipt} maxHeight={320} /></div>
          </details>
        )}
        <p className="text-xs text-muted leading-relaxed">{LIMITS_LINE}</p>
      </div>
    </Drawer>
    {action && <ReceivedActionDialog x={x} action={action} onClose={() => setAction(undefined)} />}
    </>
  );
}

function ReceivedActionDialog({ x, action, onClose }: { x: CrossOrgReceipt; action: ReceivedAction; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<'upheld' | 'rejected'>('rejected');
  const pending = x.acceptance?.state === 'pending';
  // an issuer in this console decides the dispute itself: from here the receiver can only withdraw its side
  const issuerHere = ORGS.some((o) => o.id === x.issuerOrgId);
  const m = useMutation(async (): Promise<{ r: CrossOrgReceipt; told?: boolean }> => {
    if (action === 'accept') return { r: await api.acceptReceived(orgId, x.id, user!.id, text) };
    if (action === 'refuse') return { r: await api.refuseReceived(orgId, x.id, user!.id, text) };
    if (action === 'dispute') { const d = await api.disputeReceived(orgId, x.id, user!.id, text); return { r: d.receipt, told: d.issuerTold }; }
    const res = await api.resolveDispute(orgId, x.id, user!.id, outcome, text);
    return { r: res, told: res.peerTold };
  });
  const go = async () => {
    try {
      const { r, told } = await m.mutate();
      const toldLine = told ? `${x.issuerName} is told in its console.` : `${x.issuerName} is not in this console, so it was not told here: send it this through your usual contact.`;
      const msg = action === 'accept'
        ? r.acceptance?.state === 'accepted' ? ['Accepted by two people', `${userName(r.acceptance.first?.userId)} and ${userName(r.acceptance.second?.userId)}. Receipt ${seqLabel(r.acceptance.second?.seq ?? 0)}.`] : ['Acceptance started', 'A different owner or admin completes it.']
        : action === 'refuse' ? ['Refused', 'Recorded in your chain.'] : action === 'dispute' ? ['Dispute raised', `${toldLine} Recorded in your chain.`] : [outcome === 'rejected' ? 'Dispute withdrawn' : 'Your side closed', `${toldLine} Recorded in your chain.`];
      toast.ok(msg[0], msg[1]);
      onClose();
    } catch { /* shown below */ }
  };
  const title = action === 'accept' ? (pending ? `Complete accepting ${seqLabel(x.seq)} from ${x.issuerName}` : `Start accepting ${seqLabel(x.seq)} from ${x.issuerName}`) : action === 'refuse' ? 'Refuse to accept this receipt' : action === 'dispute' ? `Dispute ${seqLabel(x.seq)} from ${x.issuerName}` : 'Close the dispute on your side';
  return (
    <Dialog open onClose={onClose} tone={action === 'refuse' ? 'danger' : undefined} title={title}
      description={action === 'accept' ? (pending ? `${userName(x.acceptance?.first?.userId)} started it. You are the second person.` : 'You are the first of two people. A different owner or admin completes it.') : action === 'dispute' ? `${x.issuerName} sees what you write.` : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={action === 'refuse' ? 'danger' : 'primary'} loading={m.pending} onClick={go}>{action === 'accept' ? (pending ? 'Complete acceptance' : 'Start acceptance') : action === 'refuse' ? 'Refuse' : action === 'dispute' ? 'Raise the dispute' : 'Close our side'}</Button></>}>
      <div className="space-y-4">
        {action === 'close' && (
          <Field label="Outcome" htmlFor="close-outcome">
            <Select id="close-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as 'upheld' | 'rejected')}>
              <option value="rejected">We withdraw the dispute</option>
              {!issuerHere && <option value="upheld">{x.issuerName} agreed with us</option>}
            </Select>
          </Field>
        )}
        {action === 'close' && issuerHere && <p className="text-xs text-muted">{x.issuerName} is in this console and decides the dispute on its side; its outcome reaches you here. Withdrawing closes the dispute on both sides.</p>}
        <Field label={action === 'accept' ? 'Note (optional)' : action === 'refuse' ? 'Why you refuse it' : action === 'dispute' ? 'What you dispute' : 'What was agreed'} htmlFor="received-note" required={action !== 'accept'}>
          <Textarea id="received-note" rows={3} value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
        </Field>
        {m.error && <Banner tone="bad">{m.error.message}</Banner>}
      </div>
    </Dialog>
  );
}

/* ── Dialogs ───────────────────────────────────────────────── */

function AddDialog({ onClose }: { onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CounterpartyKind>('customer');
  const [domain, setDomain] = useState('');
  const [seats, setSeatsN] = useState(1);
  const [contact, setContact] = useState('');
  const [fp, setFp] = useState('');
  const [fetching, setFetching] = useState(false);
  const [touched, setTouched] = useState(false);
  const m = useMutation((o: string, input: Parameters<typeof api.addCounterparty>[1], u: string) => api.addCounterparty(o, input, u));

  const dom = domain.trim().toLowerCase().replace(/^ar-org:/, '');
  const linked = ORGS.find((o) => o.domain === dom && o.id !== orgId);
  const errs = {
    name: !name.trim() ? 'Give the organisation’s legal name.' : undefined,
    domain: !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom) ? 'A domain such as acmetextiles.in — it becomes ar-org:<domain>.' : undefined,
    seats: seats < 1 || seats > 50 ? 'Between 1 and 50 seats.' : undefined,
    contact: !contact.trim() ? 'Who at the counterparty you deal with.' : undefined,
    fp: fp && !/^[0-9a-f]{16}$/.test(fp.trim()) ? '16 lower-case hex characters, or leave it empty.' : undefined,
  };
  const valid = Object.values(errs).every((e) => !e);

  const fetchKey = async () => {
    if (!linked) return;
    setFetching(true);
    try { const c = await api.custody(linked.id); setFp(c.fingerprint); } catch (e) { toast.bad('Could not fetch the key', (e as Error).message); } finally { setFetching(false); }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (!valid) return;
    try {
      const c = await m.mutate(orgId, { name: name.trim(), kind, domain: dom, seats, contact: contact.trim(), keyFingerprint: fp.trim() || undefined }, user!.id);
      toast.ok('Counterparty added', `${c.name} holds ${plural(c.seats, 'seat')} (${rupees(c.seats * SEAT_PRICE)} a year). A receipt records it.`);
      onClose();
    } catch { /* shown below */ }
  };

  return (
    <Dialog open onClose={onClose} size="lg" title="Add a counterparty" description="An organisation that verifies the receipts you issue, or issues receipts to you."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.pending} onClick={() => submit()}>Add counterparty</Button></>}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Name" htmlFor="cp-name" required error={touched && errs.name} className="sm:col-span-2">
          <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Textiles Pvt Ltd" invalid={touched && !!errs.name} />
        </Field>
        <Field label="Kind" htmlFor="cp-kind">
          <Select id="cp-kind" value={kind} onChange={(e) => setKind(e.target.value as CounterpartyKind)}>
            {(Object.keys(KIND_LABEL) as CounterpartyKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="Domain" htmlFor="cp-domain" required error={touched && errs.domain} hint={!errs.domain && dom ? <span className="font-mono">ar-org:{dom}</span> : 'Try kaverihealth.in, northbank.co.in or deccanbank.coop.in'}>
          <Input id="cp-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acmetextiles.in" mono invalid={touched && !!errs.domain} autoCapitalize="none" spellCheck={false} />
        </Field>
        {linked && (
          <div className="sm:col-span-2">
            <Banner tone="info" title={`${linked.name} is in this console`} actions={<Button size="sm" variant="secondary" loading={fetching} icon={<KeyRound className="h-3.5 w-3.5" aria-hidden />} onClick={fetchKey}>Fetch its published key</Button>}>
              Receipts you issue arrive in its register and verify there for real. Its level: {LEVEL_INFO[linked.plan as keyof typeof LEVEL_INFO]?.label ?? linked.plan}.
            </Banner>
          </div>
        )}
        <Field label="Contact" htmlFor="cp-contact" required error={touched && errs.contact}>
          <Input id="cp-contact" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Name, role" invalid={touched && !!errs.contact} />
        </Field>
        <Field label="Seats" htmlFor="cp-seats" error={touched && errs.seats} hint={`${rupees(Math.max(0, seats) * SEAT_PRICE)} a year`}>
          <Input id="cp-seats" type="number" min={1} max={50} value={seats} onChange={(e) => setSeatsN(Number(e.target.value) || 0)} className="num" />
        </Field>
        <Field label="Their key fingerprint" htmlFor="cp-fp" error={touched && errs.fp} className="sm:col-span-2"
          hint="Optional. Obtain it from them directly and it is pinned. Without it, their key is fetched from /.well-known/action-receipt-keys at their domain.">
          <Input id="cp-fp" value={fp} onChange={(e) => setFp(e.target.value.trim().toLowerCase())} placeholder="16 hex characters" mono invalid={touched && !!errs.fp} spellCheck={false} />
        </Field>
        {m.error && <div className="sm:col-span-2"><Banner tone="bad">{m.error.message}</Banner></div>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function IssueDialog({ cps, initialCp, onClose }: { cps: Counterparty[]; initialCp?: string; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [cpId, setCpId] = useState(initialCp && cps.some((c) => c.id === initialCp) ? initialCp : cps[0]?.id ?? '');
  // the register may arrive after the dialog opens (a deep link): pick the requested or first counterparty then
  useEffect(() => {
    if (cps.some((c) => c.id === cpId)) return;
    const want = initialCp && cps.some((c) => c.id === initialCp) ? initialCp : cps[0]?.id;
    if (want) setCpId(want);
  }, [cps, cpId, initialCp]);
  const [seq, setSeq] = useState<number>();
  const [fields, setFields] = useState<string[]>(['tool', 'decision', 'approval']);
  const [done, setDone] = useState<Awaited<ReturnType<typeof api.issueToCounterparty>>>();
  const { data: recent, loading } = useQuery((o) => api.receipts(o, { kind: 'decision', limit: 60 }), [], { live: false });
  useEffect(() => { if (seq === undefined && recent?.items.length) setSeq(recent.items[0].seq); }, [recent, seq]);
  const vals = useReceiptValues(orgId, seq);
  const m = useMutation((o: string, s: number, c: string, f: string[], u: string, opts: { acknowledgeFirstIssue: boolean; profileId?: string; expiresDays?: number }) => api.issueToCounterpartyChecked(o, s, c, f, u, opts));
  const cp = cps.find((c) => c.id === cpId);
  const profiles = useDisclosureProfiles();
  const [profileId, setProfileId] = useState<string>();
  // a profile sets the fields and the expiry; the expiry can still be changed here
  const [expiresDays, setExpiresDays] = useState(30);
  const expiryChoices = [...new Set([7, 30, 90, 180, 365, expiresDays])].sort((a, b) => a - b);
  const first = useFirstIssue(cp ? `ar-org:${cp.domain}` : undefined, seq);
  const [ack, setAck] = useState(false);
  useEffect(() => { setAck(false); }, [cpId]);
  const needsAck = !!first.info?.first && !ack;

  const submit = async () => {
    try {
      const r = await m.mutate(orgId, seq!, cpId, fields, user!.id, { acknowledgeFirstIssue: ack, profileId, expiresDays });
      setDone(r);
      toast.ok('Receipt issued', `${seqLabel(r.receipt.seq)} to ${r.receipt.counterpartyName}, revealing ${r.disclosure.revealed.length} of ${r.disclosure.committed.length} fields.`);
    } catch { /* shown below */ }
  };

  if (!cps.length) {
    return (
      <Dialog open onClose={onClose} title="Issue a receipt" footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
        <p className="text-sm text-muted">Add a counterparty first. Receipts are issued to an organisation in the register.</p>
      </Dialog>
    );
  }

  if (done) {
    const x = done.receipt;
    return (
      <Dialog open onClose={onClose} size="lg" title={`Issued ${seqLabel(x.seq)} to ${x.counterpartyName}`} description={x.summary}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3"><span className="text-sm text-muted">Their check</span><CrossOrgChip state={x.verification.state} /></div>
          <VerifySteps steps={x.verification.steps} />
          {x.token && (
            <div className="border border-line bg-sunken/50 p-3">
              <p className="label">Portal link for {x.counterpartyName}</p>
              <p className="mt-1 flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-xs">{portalUrl(x.token)}</span><CopyButton text={portalUrl(x.token)} label="Copy portal link" /></p>
              <a href={`/counterparty/${x.token}`} target="_blank" rel="noreferrer" className="link mt-2 inline-flex items-center gap-1 text-sm"><ExternalLink className="h-3.5 w-3.5" aria-hidden />Open it as they will see it</a>
            </div>
          )}
          {done.disclosure.seqCreated && <p className="text-sm text-muted">Recorded as <ReceiptLink seq={done.disclosure.seqCreated} /> in your chain.</p>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} size="lg" title="Issue a receipt to a counterparty" description="All 11 fields are committed as salted digests and signed. Only the fields you tick are revealed."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send className="h-4 w-4" aria-hidden />} loading={m.pending} disabled={!seq || !cpId || !fields.length || needsAck || first.loading} onClick={submit}>Issue to {cp?.name ?? 'counterparty'}</Button></>}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Counterparty" htmlFor="issue-cp" hint={cp ? <span className="font-mono">ar-org:{cp.domain}</span> : undefined}>
            <Select id="issue-cp" value={cpId} onChange={(e) => setCpId(e.target.value)}>
              {cps.map((c) => <option key={c.id} value={c.id}>{c.name} · {KIND_LABEL[c.kind]}</option>)}
            </Select>
          </Field>
          <Field label="Receipt" htmlFor="issue-seq" hint={vals.error ?? (vals.receipt ? `${vals.receipt.agent ?? 'admin'} · ${dateTime(vals.receipt.ts)}` : undefined)}>
            {loading ? <Skeleton className="h-10 w-full" /> : (
              <Select id="issue-seq" value={seq ?? ''} onChange={(e) => setSeq(Number(e.target.value))}>
                {(recent?.items ?? []).map((r) => <option key={r.seq} value={r.seq}>{seqLabel(r.seq)} · {receiptLabel(r)} · {r.decision}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <FieldPicker value={fields} onChange={setFields} values={vals.values} loadingValues={vals.loading} profiles={profiles.data} profileId={profileId} onProfile={(p) => { setProfileId(p?.id); if (p) setExpiresDays(p.expiresDays); }} />
        <div className="grid gap-4 sm:grid-cols-[200px_1fr] sm:items-end">
          <Field label="Expires for them after" htmlFor="issue-expiry">
            <Select id="issue-expiry" value={String(expiresDays)} onChange={(e) => setExpiresDays(Number(e.target.value))}>
              {expiryChoices.map((d) => <option key={d} value={d}>{plural(d, 'day')}</option>)}
            </Select>
          </Field>
          <p className="text-xs text-muted">The receipt and its portal link expire for them in {plural(expiresDays, 'day')}{profileId ? ', as the profile sets' : ''}. {TOTAL_FIELDS - fields.length > 0 ? 'Withheld is not missing, and missing is not altered.' : ''}</p>
        </div>
        <FirstIssueWarning info={first.info} acknowledged={ack} onChange={setAck} />
        {m.error && <Banner tone="bad">{m.error.message}</Banner>}
      </div>
    </Dialog>
  );
}

/* ── Below L3: preview and upgrade path ────────────────────── */

function Preview() {
  const orgId = useOrgId();
  const org = ORGS.find((o) => o.id === orgId);
  const { data, loading } = useQuery((o) => api.receipts(o, { kind: 'decision', limit: 4 }), [], { live: false });
  const reg = useQuery((o) => api.counterparties(o), []);
  const listed = reg.data?.fromChain ?? [];
  return (
    <>
    {/* the register is listed read-only from L1 (decision 6d); seats, issuing and receiving start at L3 */}
    <Panel className="mb-6" title="Counterparty register" kicker="Read-only below L3 · from the chain" flush
      footer={<>Every counterparty your agents acted on, counted from the receipts.</>}>
      {reg.loading && !reg.data ? <Skeleton className="h-28 m-5" /> : reg.error ? (
        <div className="p-5"><Banner tone="bad" title="The register did not load">{reg.error.message}</Banner></div>
      ) : !listed.length ? (
        <p className="px-5 py-4 text-sm text-muted">No governed call has named a counterparty yet.</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Counterparties named in governed calls</caption>
          <thead className="bg-sunken/60"><tr className="border-b border-line"><th scope="col" className="label text-left px-5 h-8">Counterparty</th><th scope="col" className="label text-right px-3 h-8">Receipts</th><th scope="col" className="label text-right px-3 h-8">Refused</th><th scope="col" className="label text-right px-5 h-8">Last</th></tr></thead>
          <tbody>
            {listed.slice(0, 12).map((c) => (
              <tr key={c.name} className="border-b border-line last:border-b-0 h-10">
                <td className="px-5 font-medium">{c.name}</td>
                <td className="px-3 text-right num">{n(c.receipts)}</td>
                <td className="px-3 text-right num">{n(c.refused)}</td>
                <td className="px-5 text-right whitespace-nowrap"><ReceiptLink seq={c.lastSeq} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
    <UpgradePath
      caps={['cross_org_verification', 'counterparty_register', 'regulator_portal', 'action_receipt_format']}
      what={<>At {LEVEL_INFO.l3.label} this page adds verification seats, the receipts you issue to counterparties and receive from them — each checked against the issuer’s published key — and the read-only portals your regulators and partners open.</>}
    >
      <Panel title="What it would look like for you" kicker="Preview from your own receipts">
        <p className="mb-4 text-sm text-muted leading-relaxed">
          Your organisation would be addressed as <span className="font-mono text-fg">ar-org:{org?.domain ?? 'your-domain'}</span>. These are recent receipts you could issue to a counterparty; each would carry an audience, a nonce and a 30-day expiry, and reveal only the fields you choose.
        </p>
        {loading ? <Skeleton className="h-28 w-full" /> : !data?.items.length ? <p className="text-sm text-muted">No decisions yet.</p> : (
          <ul className="divide-y divide-line border border-line">
            {data.items.map((r) => (
              <li key={r.seq} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
                <ReceiptLink seq={r.seq} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{receiptLabel(r)}</span>
                <span className="text-xs text-muted">{r.decision} · <When iso={r.ts} /></span>
                <span className="text-xs text-subtle">Would reveal 3 of {TOTAL_FIELDS} fields</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">{LIMITS_LINE}</p>
      </Panel>
    </UpgradePath>
    </>
  );
}
