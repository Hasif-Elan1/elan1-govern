import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gavel } from 'lucide-react';
import { api } from '@/api';
import { useOrgId, useRole, useUser } from '@/store/session';
import { n, seqLabel } from '@/lib/format';
import { DESK_DEFAULT, DISCOUNT_CAP, ELAN1_STAFF, OUTCOME_LABEL, SETTLEMENT_FOUNDER_ABOVE, type DiscountRequest, type OpenDispute, type PilotState, type SettlementOutcome } from '@/mock/billing';
import { Banner, Button, Field, Input, Panel, Select, StatusChip, Textarea, toast } from '@/components/ui';
import { money, type Currency } from './model';
import type { ChainInvoice } from './chainMeter';

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
/** The last day of a span of whole months that starts on `from` (IST days, inclusive). */
function untilAfter(from: string, months: number) {
  const [y, m, d] = from.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d - 1)).toISOString().slice(0, 10);
}

/**
 * Demo only: elan1's billing desk. In service elan1 decides disputes, discount requests and requests to reopen outside
 * this console. Here an owner records the decision elan1 made, so the rest of the flow can be followed: a settlement
 * writes the credit note, a granted request becomes an offer, an approved reopening moves the organisation to the paid
 * plan. Each decision is a receipt written as elan1's, and names the owner who recorded it.
 */
export function BillingDeskPanel({ disputes, requests, pilot, invoices, cur, className }: {
  disputes: OpenDispute[]; requests: DiscountRequest[]; pilot?: PilotState; invoices: ChainInvoice[]; cur: Currency; className?: string;
}) {
  const role = useRole();
  const ids = { by: useId() };
  const [decidedBy, setDecidedBy] = useState(DESK_DEFAULT);
  if (role !== 'owner') return null;
  const pending = requests.filter((q) => q.status === 'with_elan1');
  const reopen = pilot?.status === 'closed' && pilot.reopenRequestedSeq ? pilot : undefined;
  const nothing = !disputes.length && !pending.length && !reopen;
  return (
    <Panel className={className} kicker="Demo only · not part of the service" title="Elan1 billing desk" flush
      actions={<StatusChip size="sm" tone="held" icon={<Gavel className="h-3 w-3" aria-hidden />}>Demo</StatusChip>}
      footer="In service, elan1 decides these outside this console and the decision arrives as a receipt. This panel lets an owner record that decision in the demo. The receipt is written as elan1’s and names you as the person who recorded it.">
      <div className="px-5 py-4 border-b border-line grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,260px)] sm:items-end">
        <p className="text-sm text-muted">Requests waiting for elan1: {n(disputes.length)} {disputes.length === 1 ? 'dispute' : 'disputes'}, {n(pending.length)} discount {pending.length === 1 ? 'request' : 'requests'}{reopen ? ', 1 request to reopen' : ''}.</p>
        <Field label="Decided by" htmlFor={ids.by} hint="The elan1 person the decision is recorded for.">
          <Select id={ids.by} value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)}>
            {ELAN1_STAFF.map((s) => <option key={s.id} value={s.id}>{s.title === 'elan1 billing desk' ? 'elan1 billing desk' : `${s.name} — ${s.title}`}</option>)}
          </Select>
        </Field>
      </div>
      {nothing && <p className="px-5 py-4 text-sm text-muted">Nothing is waiting for elan1. Dispute an invoice line, ask for a discount or, after a closed pilot, ask to reopen, and the request appears here.</p>}
      {disputes.map((q) => <DisputeDecision key={q.seq} q={q} invoices={invoices} cur={cur} decidedBy={decidedBy} />)}
      {pending.map((q) => <DiscountDecision key={q.seq} q={q} decidedBy={decidedBy} />)}
      {reopen && <ReopenDecision seq={reopen.reopenRequestedSeq!} decidedBy={decidedBy} />}
    </Panel>
  );
}

function useDesk() {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async (fn: (orgId: string, userId: string) => Promise<{ seq: number }>, ok: string, sub: string) => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try { const r = await fn(orgId, user.id); toast.ok(ok, `${sub} Receipt ${seqLabel(r.seq)}.`); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return { busy, err, run };
}

function DisputeDecision({ q, invoices, cur, decidedBy }: { q: OpenDispute; invoices: ChainInvoice[]; cur: Currency; decidedBy: string }) {
  const ids = { o: useId(), c: useId(), n: useId(), f: useId() };
  const { busy, err, run } = useDesk();
  const [outcome, setOutcome] = useState<SettlementOutcome>('upheld');
  const [creditS, setCredit] = useState('');
  const [note, setNote] = useState('');
  const [founder, setFounder] = useState(false);
  // shown here for the person recording the decision only: the desk reads the line's amount from the invoice itself and caps the credit at it
  const line = invoices.find((i) => i.number === q.invoice)?.lines.find((l) => l.id === q.line);
  const amount = line?.amount ?? 0;
  const credit = outcome === 'upheld' ? amount : outcome === 'rejected' ? 0 : Number(creditS) || 0;
  const needsFounder = credit > SETTLEMENT_FOUNDER_ABOVE && decidedBy !== 'elan1:founder';
  const ok = note.trim().length >= 10 && (outcome !== 'partly_upheld' || (credit > 0 && credit < amount)) && (!needsFounder || founder) && (amount > 0 || outcome === 'rejected');
  return (
    <div className="px-5 py-4 border-b border-line text-sm space-y-3">
      <div>
        <p className="font-medium">Dispute <Link className="link font-mono" to={`/activity/${q.seq}`}>{seqLabel(q.seq)}</Link> · {line?.label ?? q.line} on {q.invoice}</p>
        <p className="text-muted">Line {amount ? money(amount, cur, true) : 'not found on a current invoice'} · “{q.reason}”</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Decision" htmlFor={ids.o}>
          <Select id={ids.o} value={outcome} onChange={(e) => setOutcome(e.target.value as SettlementOutcome)}>
            {(['upheld', 'partly_upheld', 'rejected'] as SettlementOutcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
          </Select>
        </Field>
        <Field label="Credit, before GST" htmlFor={ids.c} hint={outcome === 'upheld' ? 'The whole line.' : outcome === 'rejected' ? 'No credit: the line stands.' : `More than ${money(0, cur)} and less than the line.`}>
          <Input id={ids.c} className="num" inputMode="decimal" disabled={outcome !== 'partly_upheld'} value={outcome === 'partly_upheld' ? creditS : String(credit)} onChange={(e) => setCredit(e.target.value)} />
        </Field>
      </div>
      <Field label="elan1’s reason" htmlFor={ids.n} hint="At least 10 characters. It is written on the receipt and shown with the line."><Textarea id={ids.n} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {needsFounder && (
        <label className="flex items-start gap-2 text-sm">
          <input id={ids.f} type="checkbox" className="mt-1" checked={founder} onChange={(e) => setFounder(e.target.checked)} />
          <span>An elan1 founder approved this credit (a credit above {money(SETTLEMENT_FOUNDER_ABOVE, 'INR')} needs one).</span>
        </label>
      )}
      {err && <Banner tone="bad">{err}</Banner>}
      <Button size="sm" variant="primary" loading={busy} disabled={!ok}
        onClick={() => run((o, u) => api.billingDesk.settleDispute(o, u, { dispute: q.seq, outcome, credit, note, decidedBy, ...(needsFounder && founder ? { approvedBy: 'elan1:founder' } : {}) }), `Dispute ${OUTCOME_LABEL[outcome].toLowerCase()}`, credit > 0 ? 'A credit note is issued against the invoice.' : 'The line stands and is payable.')}>
        Record elan1’s decision
      </Button>
    </div>
  );
}

function DiscountDecision({ q, decidedBy }: { q: DiscountRequest; decidedBy: string }) {
  const ids = { p: useId(), f: useId(), u: useId(), r: useId() };
  const { busy, err, run } = useDesk();
  const [mode, setMode] = useState<'grant' | 'decline'>('grant');
  const [pctS, setPct] = useState(String(q.pct));
  const [from, setFrom] = useState(todayIst());
  const [until, setUntil] = useState(untilAfter(todayIst(), q.months));
  const [reason, setReason] = useState('');
  const p = Number(pctS);
  const okGrant = p > 0 && p < 100 && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(until) && until >= from;
  return (
    <div className="px-5 py-4 border-b border-line text-sm space-y-3">
      <div>
        <p className="font-medium">Discount request <Link className="link font-mono" to={`/activity/${q.seq}`}>{seqLabel(q.seq)}</Link> · {q.pct}% for {q.months} {q.months === 1 ? 'month' : 'months'}</p>
        <p className="text-muted">“{q.reason}” · {q.needs === 'founder' ? `beyond the ${DISCOUNT_CAP.leadPct}% / ${DISCOUNT_CAP.leadMonths}-month cap, so a founder decides` : 'within the cap'}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Decision">
        <Button size="sm" variant={mode === 'grant' ? 'primary' : 'secondary'} aria-pressed={mode === 'grant'} onClick={() => setMode('grant')}>Grant</Button>
        <Button size="sm" variant={mode === 'decline' ? 'primary' : 'secondary'} aria-pressed={mode === 'decline'} onClick={() => setMode('decline')}>Decline</Button>
      </div>
      {mode === 'grant' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Discount, %" htmlFor={ids.p}><Input id={ids.p} className="num" inputMode="decimal" value={pctS} onChange={(e) => setPct(e.target.value)} /></Field>
            <Field label="From" htmlFor={ids.f}><Input id={ids.f} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Until" htmlFor={ids.u}><Input id={ids.u} type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
          </div>
          <p className="text-xs text-muted">Granted, it becomes an offer from elan1 that an owner accepts under Discounts. The billing desk and account leads stay within {DISCOUNT_CAP.leadPct}% for {DISCOUNT_CAP.leadMonths} months; only a founder goes further.</p>
        </>
      ) : (
        <Field label="elan1’s reason" htmlFor={ids.r} hint="At least 10 characters."><Textarea id={ids.r} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      )}
      {err && <Banner tone="bad">{err}</Banner>}
      <Button size="sm" variant="primary" loading={busy} disabled={mode === 'grant' ? !okGrant : reason.trim().length < 10}
        onClick={() => run((o, u) => api.billingDesk.decideDiscountRequest(o, u, mode === 'grant' ? { request: q.seq, grant: true, pct: p, from, until, decidedBy } : { request: q.seq, grant: false, reason, decidedBy }), mode === 'grant' ? 'Request granted' : 'Request declined', mode === 'grant' ? 'An offer is waiting for an owner under Discounts.' : 'The owner sees elan1’s reason.')}>
        Record elan1’s decision
      </Button>
    </div>
  );
}

function ReopenDecision({ seq, decidedBy }: { seq: number; decidedBy: string }) {
  const ids = { n: useId() };
  const { busy, err, run } = useDesk();
  const [note, setNote] = useState('');
  const ok = note.trim().length >= 10;
  return (
    <div className="px-5 py-4 border-b border-line text-sm space-y-3">
      <p className="font-medium">Request to reopen <Link className="link font-mono" to={`/activity/${seq}`}>{seqLabel(seq)}</Link> · a new order on the paid Guarded plan</p>
      <Field label="elan1’s reason" htmlFor={ids.n} hint="At least 10 characters."><Textarea id={ids.n} rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {err && <Banner tone="bad">{err}</Banner>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={!ok} onClick={() => run((o, u) => api.billingDesk.decideReopen(o, u, { approve: true, note, decidedBy }), 'Reopening approved', 'The organisation is on the paid Guarded plan from today; writes resume.')}>Approve</Button>
        <Button size="sm" variant="secondary" loading={busy} disabled={!ok} onClick={() => run((o, u) => api.billingDesk.decideReopen(o, u, { approve: false, note, decidedBy }), 'Reopening declined', 'The owner may ask again.')}>Decline</Button>
      </div>
    </div>
  );
}
