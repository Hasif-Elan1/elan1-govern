import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Plus, Search, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { CHANNEL_LABEL, type ConsentChannel, type ConsentPurpose, type G1Result } from '@/mock/records';
import { date, n, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, DataTable, Dialog, EmptyState, Field, Input, LegalDraft, PageHeader, Panel, Segmented, Select, Skeleton, Stat, StatusChip, Tabs, Textarea, Tooltip, toast, type Column } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import { evidenceClaim } from './level';

type View = Awaited<ReturnType<typeof api.records.consents>>;
type Entry = View['entries'][number];
type Tab = 'ledger' | 'purposes' | 'gate';

/** Records › Consent ledger — DPDP consents per data principal and purpose, withdrawals, and G1, the consent check that reads them on live calls. */
export default function ConsentPage() {
  const level = useOrgLevel();
  const role = useRole();
  const manager = role === 'owner' || role === 'admin';
  const q = useQuery((o) => api.records.consents(o), [level], { kinds: ['receipt', 'consent', 'open'] });
  const [tab, setTab] = useState<Tab>('ledger');
  const [recordOpen, setRecordOpen] = useState(false);
  const [withdraw, setWithdraw] = useState<Entry>();
  const [status, setStatus] = useState<'all' | 'active' | 'withdrawn'>('active');
  const [purpose, setPurpose] = useState('');
  const [text, setText] = useState('');
  const signed = level !== 'l1';

  const rows = useMemo(() => (q.data?.entries ?? []).filter((e) =>
    (status === 'all' || e.status === status) && (!purpose || e.purposeId === purpose) &&
    (!text.trim() || `${e.principalRef} ${e.hint} ${e.principalGroup} ${e.purposeLabel}`.toLowerCase().includes(text.trim().toLowerCase())),
  ), [q.data, status, purpose, text]);

  const columns: Column<Entry>[] = [
    { key: 'who', header: 'Data principal', sort: (e) => e.principalRef, cell: (e) => <span className="flex flex-col"><span className="font-mono text-sm font-medium">{e.principalRef}</span><span className="text-xs text-muted">{e.principalGroup} · <span className="font-mono">{e.hint}</span></span></span> },
    { key: 'purpose', header: 'Purpose', sort: (e) => e.purposeLabel, cell: (e) => <span className="flex flex-col"><span className="text-sm">{e.purposeLabel}</span><span className="text-xs text-muted">{CHANNEL_LABEL[e.channel as ConsentChannel]} · notice {e.noticeVersion}</span></span> },
    { key: 'given', header: 'Given', hideBelow: 'md', sort: (e) => e.givenAt, cell: (e) => <span className="flex flex-col"><When iso={e.givenAt} className="text-sm" /><span className="text-xs text-muted">{e.givenVia}{e.expiresAt ? ` · until ${date(e.expiresAt)}` : ''}</span></span> },
    {
      key: 'status', header: 'Status', sort: (e) => e.status, cell: (e) => e.status === 'withdrawn'
        ? <span className="flex flex-col gap-0.5"><StatusChip size="sm" tone="bad" icon={<XCircle className="h-3 w-3" />}>Withdrawn</StatusChip><span className="text-xs text-muted">{e.withdrawnAt ? date(e.withdrawnAt) : ''} · {e.withdrawnVia}</span></span>
        : e.expired ? <StatusChip size="sm" tone="held">Expired</StatusChip> : <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" />}>Active</StatusChip>,
    },
    { key: 'g1', header: 'Calls it covered', align: 'right', hideBelow: 'lg', sort: (e) => e.reliedOn, cell: (e) => e.reliedOn ? <span className="flex flex-col items-end"><span className="num text-sm">{n(e.reliedOn)}</span>{e.lastSeq ? <ReceiptLink seq={e.lastSeq} className="text-xs" /> : null}</span> : <span className="text-xs text-subtle">None in the window</span> },
    { key: 'rec', header: 'Receipt', hideBelow: 'sm', cell: (e) => <span className="flex flex-col gap-0.5">{e.seq !== undefined && <ReceiptLink seq={e.seq} />}{e.withdrawSeq !== undefined && e.withdrawSeq !== e.seq && <ReceiptLink seq={e.withdrawSeq} className="text-xs" />}{e.imported && <span className="text-[11px] text-subtle">Imported</span>}</span> },
    // owners and admins record withdrawals; other roles read the ledger without the action column
    ...(manager ? [{
      key: 'act', header: <span className="sr-only">Actions</span>, align: 'right' as const, cell: (e: Entry) => e.status === 'active' ? (
        <Tooltip content="Record that the person withdrew this consent">
          <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} onClick={(ev) => { ev.stopPropagation(); setWithdraw(e); }}>Withdraw</Button>
        </Tooltip>
      ) : null,
    }] : []),
  ];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="Consent ledger (DPDP)"
        description="Every consent a data principal gave, for which purpose and on which channel, and every withdrawal. G1, the consent check, reads this ledger on every live call that writes to a person and refuses the call when the consent is missing, withdrawn, expired or on another channel. The identifier is hashed and never stored."
        meta={<LegalDraft />}
        actions={manager ? (
          <Tooltip content="Record a consent the person gave">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setRecordOpen(true)}>Record a consent</Button>
          </Tooltip>
        ) : undefined}
      />

      {q.error && <Banner tone="bad" title="The consent ledger did not load" className="mb-6" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      <div className="grid gap-4 grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 mb-6">
        {!q.data ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px]" />) : (
          <>
            <Stat label="Active consents" value={n(q.data.stats.active)} sub={`${plural(q.data.stats.principals, 'data principal')}`} />
            <Stat label="Withdrawn in 30 days" value={n(q.data.stats.withdrawn30d)} sub={q.data.stats.g1Refused ? `G1 refused ${plural(q.data.stats.g1Refused, 'live call')} so far` : 'G1 refuses from the moment of withdrawal'} />
            <Stat label="Purposes" value={n(q.data.purposes.length)} sub={`${q.data.purposes.filter((p) => p.basis === 'legitimate_use').length} legitimate uses, not asked`} />
            <Stat label="Calls the ledger covered" value={n(q.data.stats.reliedOn)} sub="Allowed calls naming a principal, made while the consent was active" to="/activity" />
          </>
        )}
      </div>

      <Tabs<Tab> className="mb-6" label="Consent ledger sections" value={tab} onChange={setTab} items={[
        { value: 'ledger', label: 'Ledger', count: q.data?.entries.length },
        { value: 'purposes', label: 'Purposes', count: q.data?.purposes.length },
        { value: 'gate', label: 'G1 consent check', count: q.data?.stats.g1Checked || undefined },
      ]} />

      {tab === 'ledger' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Segmented<'all' | 'active' | 'withdrawn'> size="sm" label="Status" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'withdrawn', label: 'Withdrawn' }, { value: 'all', label: 'All' }]} />
            <Select size_="sm" aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} className="w-auto">
              <option value="">Every purpose</option>
              {(q.data?.purposes ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
            <div className="relative min-w-[200px] flex-1 max-w-sm">
              <Input aria-label="Search the ledger" value={text} onChange={(e) => setText(e.target.value)} placeholder="Reference, group or purpose" leading={<Search className="h-4 w-4" />} />
            </div>
            <span className="ml-auto text-sm text-muted num">{plural(rows.length, 'entry', 'entries')}</span>
          </div>
          <DataTable caption="Consent ledger" columns={columns} rows={q.data ? rows : undefined} loading={q.loading && !q.data} rowKey={(e) => e.id}
            empty={<EmptyState compact title="No consents match" disc="registration">{manager ? 'Change the filters, or record a consent.' : 'Change the filters.'}</EmptyState>} />
          <p className="text-xs text-muted">Each entry and each withdrawal is a receipt. {evidenceClaim(level)} A withdrawal never changes the calls made before it: they stay as they were recorded.</p>
        </div>
      )}

      {tab === 'purposes' && q.data && (
        <div className="grid gap-4 md:grid-cols-2">
          {q.data.purposes.map((p) => (
            <Panel key={p.id} title={p.label} kicker={p.basis === 'consent' ? 'Consent' : 'Legitimate use (s.7)'} actions={p.pack ? <Badge tone="info">G1 · {p.pack}</Badge> : undefined}>
              <p className="text-sm">{p.description}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div><dt className="label">Data principals</dt><dd>{p.principals}</dd></div>
                <div><dt className="label">Channels</dt><dd>{p.channels.map((c) => CHANNEL_LABEL[c]).join(', ')}</dd></div>
                <div><dt className="label">Active</dt><dd className="num">{n(p.active)}</dd></div>
                <div><dt className="label">Withdrawn</dt><dd className="num">{n(p.withdrawn)}</dd></div>
              </dl>
            </Panel>
          ))}
        </div>
      )}

      {tab === 'gate' && q.data && <GatePanel purposes={q.data.purposes} packs={q.data.g1Packs} g1={q.data.g1} signed={signed} />}

      {manager && recordOpen && q.data && <RecordDialog purposes={q.data.purposes} onClose={() => setRecordOpen(false)} />}
      {manager && withdraw && <WithdrawDialog entry={withdraw} onClose={() => setWithdraw(undefined)} />}
    </div>
  );
}

/* ── G1 ──────────────────────────────────────────────────── */

function GatePanel({ purposes, packs, g1, signed }: { purposes: ConsentPurpose[]; packs: View['g1Packs']; g1: View['g1']; signed: boolean }) {
  const orgId = useOrgId();
  const role = useRole();
  const manager = role === 'owner' || role === 'admin';
  const consentPurposes = purposes;
  const [identifier, setIdentifier] = useState('');
  const [purposeId, setPurposeId] = useState(consentPurposes[0]?.id ?? '');
  const [channel, setChannel] = useState<ConsentChannel>('email');
  const [res, setRes] = useState<G1Result>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const p = purposes.find((x) => x.id === purposeId);
  const run = async () => {
    setBusy(true); setErr(undefined); setRes(undefined);
    try { setRes(await api.records.g1Check(orgId, identifier, purposeId, channel)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-6">
        <Panel title="Check a call against G1" kicker="Nothing is written">
          <p className="text-sm text-muted mb-4">G1 is the consent check, the first of the nine checks a pack declares, and it is never skipped. On every live call that writes to a person (an email, SMS, WhatsApp message or phone call) it looks for an active consent for {g1.contactPurpose.label.toLowerCase()} on the call’s channel. Here you can check any purpose against the ledger; nothing is written. Try an identifier the agents write to, such as an email domain from a receipt.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Identifier on the call" htmlFor="g1-id" className="sm:col-span-2"><Input id="g1-id" mono value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="accounts@prakashretail.in" /></Field>
            <Field label="Purpose" htmlFor="g1-p"><Select id="g1-p" value={purposeId} onChange={(e) => setPurposeId(e.target.value)}>{consentPurposes.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
            <Field label="Channel" htmlFor="g1-c"><Select id="g1-c" value={channel} onChange={(e) => setChannel(e.target.value as ConsentChannel)}>{(['email', 'sms', 'call', 'whatsapp', 'app'] as ConsentChannel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}{p && !p.channels.includes(c) && !p.channels.includes('any') ? ' (not asked for)' : ''}</option>)}</Select></Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} loading={busy} disabled={identifier.trim().length < 3} onClick={run}>Run G1</Button>
            {err && <span className="text-sm text-bad-fg">{err}</span>}
          </div>
          {res && (
            <div className={cn('mt-4 border p-4', res.result === 'passed' ? 'border-ok/50 bg-ok-bg' : 'border-bad/50 bg-bad-bg')} aria-live="polite">
              <p className="flex items-center gap-2 font-medium">{res.result === 'passed' ? <CheckCircle2 className="h-4 w-4 text-ok-fg" aria-hidden /> : <XCircle className="h-4 w-4 text-bad-fg" aria-hidden />}G1 {res.result === 'passed' ? 'passes' : 'refuses'} <span className="font-mono text-xs text-muted">{res.code}</span></p>
              <p className="mt-1 text-sm">{res.detail}</p>
            </div>
          )}
        </Panel>
        <Panel title="G1 on live calls" kicker={g1.live ? 'Latest results on receipts' : 'Not checking yet'} flush
          footer={g1.live ? 'Each result is on the call’s own receipt (g1, and the consent it relied on). A withdrawal takes effect on the next call.' : 'G1 starts checking live calls once the ledger holds its first consent.'}>
          {g1.recent.length === 0 ? <p className="px-5 py-4 text-sm text-muted">{g1.live ? 'No live call has written to a person since the ledger was kept.' : manager ? 'Record a consent to start.' : 'It starts once an owner or admin records the first consent.'}</p> : (
            <ul className="divide-y divide-line">
              {g1.recent.map((x) => (
                <li key={x.seq} className="px-5 py-2.5 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                  {x.decision === 'refuse' ? <StatusChip size="sm" tone="bad" icon={<XCircle className="h-3 w-3" />}>Refused</StatusChip> : <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" />}>Passed</StatusChip>}
                  <span className="font-mono text-xs">{x.code}</span>
                  <span className="min-w-0 truncate"><span className="font-mono">{x.agent}</span>{x.to ? <span className="text-muted"> to {x.to}</span> : null}</span>
                  {x.consent && <span className="text-xs text-muted font-mono">{x.consent}</span>}
                  <span className="ml-auto flex items-center gap-2"><When iso={x.ts} className="text-xs text-muted" /><ReceiptLink seq={x.seq} className="text-xs" /></span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <div className="lg:col-span-5 space-y-6">
        <Panel title="Packs whose G1 reads this ledger" flush>
          {packs.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No regulatory pack for this industry names a consent purpose. G1 still reads the ledger for every purpose listed here.</p> : (
            <ul className="divide-y divide-line">
              {packs.map((x) => (
                <li key={x.pack} className="px-5 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2"><Link to={`/records/packs/${x.pack}`} className="font-mono font-medium hover:underline underline-offset-2">{x.pack}</Link>{x.installed ? <Badge tone="ok">Installed</Badge> : <Badge>Not installed</Badge>}</p>
                  <p className="text-xs text-muted mt-0.5">{x.regime}</p>
                  <p className="mt-1">G1: the {x.purposeLabel.toLowerCase()} consent for the channel is on file.</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="How G1 records its result" tone="sunken">
          <ul className="space-y-2 text-sm text-muted">
            <li>A pass names the consent it relied on; a refusal names what was missing, withdrawn, expired or on another channel.</li>
            <li>A refusal is never relaxed: G1 runs after the rulebook and only ever tightens its decision.</li>
            <li>Both go on the call’s receipt, {signed ? 'signed with the organisation’s key' : 'sealed in the hash chain'}. A refusal is billed at 40% of the per-action rate.</li>
            <li>A legitimate use the Act names passes without consent and says so.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/* ── Dialogs ─────────────────────────────────────────────── */

function RecordDialog({ purposes, onClose }: { purposes: ConsentPurpose[]; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const asked = purposes.filter((p) => p.basis === 'consent');
  const [f, setF] = useState({ principalRef: '', identifier: '', principalGroup: '', purposeId: asked[0]?.id ?? '', channel: (asked[0]?.channels[0] ?? 'email') as ConsentChannel, noticeVersion: 'v3', givenVia: 'Web form', expiresAt: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const p = asked.find((x) => x.id === f.purposeId);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const e = await api.records.recordConsent(orgId, { ...f, principalGroup: f.principalGroup || p?.principals || '', expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : undefined }, user.id);
      toast.ok(`Consent ${e.id} recorded`, 'It is a receipt on the chain. G1 reads it from now on.');
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="Record a consent" description="The identifier is hashed at once and never stored. Only a masked hint is kept beside your reference."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Record the consent</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not recorded">{err}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your reference" htmlFor="rc-ref" hint="Customer or case number. Left blank, one is made."><Input id="rc-ref" value={f.principalRef} onChange={(e) => set('principalRef', e.target.value)} placeholder="CUST-10442" data-autofocus /></Field>
          <Field label="Identifier" required htmlFor="rc-id" hint="Email address, domain or phone number on the calls."><Input id="rc-id" mono value={f.identifier} onChange={(e) => set('identifier', e.target.value)} placeholder="accounts@prakashretail.in" /></Field>
          <Field label="Purpose" htmlFor="rc-p"><Select id="rc-p" value={f.purposeId} onChange={(e) => { const np = asked.find((x) => x.id === e.target.value); setF((x) => ({ ...x, purposeId: e.target.value, channel: (np?.channels[0] ?? 'email') as ConsentChannel })); }}>{asked.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
          <Field label="Channel" htmlFor="rc-c"><Select id="rc-c" value={f.channel} onChange={(e) => set('channel', e.target.value as ConsentChannel)}>{(p?.channels ?? []).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</Select></Field>
          <Field label="Data principals" htmlFor="rc-g"><Input id="rc-g" value={f.principalGroup} onChange={(e) => set('principalGroup', e.target.value)} placeholder={p?.principals} /></Field>
          <Field label="Notice version shown" required htmlFor="rc-n"><Input id="rc-n" value={f.noticeVersion} onChange={(e) => set('noticeVersion', e.target.value)} /></Field>
          <Field label="How it was given" htmlFor="rc-v"><Select id="rc-v" value={f.givenVia} onChange={(e) => set('givenVia', e.target.value)}>{['Web form', 'Mobile app', 'Branch, signed form', 'Consent manager (account aggregator)', 'Email reply', 'Recorded call'].map((v) => <option key={v}>{v}</option>)}</Select></Field>
          <Field label="Valid until" htmlFor="rc-x" hint="Leave blank if it does not lapse."><Input id="rc-x" type="date" value={f.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} /></Field>
        </div>
        {p && <p className="text-xs text-muted">{p.description}</p>}
      </div>
    </Dialog>
  );
}

function WithdrawDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [via, setVia] = useState('Email to the grievance officer');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await api.records.withdrawConsent(orgId, entry.id, { via, reason }, user.id);
      toast.ok('Withdrawal recorded', 'G1 refuses calls that relied on this consent from now on. The receipt is on the chain.');
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`Withdraw consent ${entry.id}`} description={`${entry.principalRef} · ${entry.purposeLabel} · ${CHANNEL_LABEL[entry.channel as ConsentChannel]}`} tone="danger"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={submit}>Record the withdrawal</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not recorded">{err}</Banner>}
        <p className="text-sm">Withdrawing is as easy as giving: record it the moment the person asks. Calls already made stay as they were; calls from now on are refused at G1.</p>
        <Field label="How the person withdrew" required htmlFor="wd-via"><Select id="wd-via" value={via} onChange={(e) => setVia(e.target.value)}>{['Email to the grievance officer', 'SMS reply STOP', 'In the app', 'Consent manager (account aggregator)', 'Letter', 'Phone call to support'].map((v) => <option key={v}>{v}</option>)}</Select></Field>
        <Field label="Note" htmlFor="wd-r" hint="Optional. It goes on the receipt."><Textarea id="wd-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {entry.reliedOn > 0 && <p className="text-xs text-muted">This consent covered {plural(entry.reliedOn, 'call')} in the window this console holds.</p>}
        <p className="text-xs text-muted">Recorded by <Person id={user?.id} size={18} className="inline-flex align-middle" />.</p>
      </div>
    </Dialog>
  );
}
