import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Ban, CheckCircle2, CircleDashed, Clock3, FileDown, FileMinus, Flag, Gavel, Hourglass, RefreshCw, ShieldAlert, Undo2 } from 'lucide-react';
import { api } from '@/api';
import { useCan, useOrgId, useRole, useUser } from '@/store/session';
import { n, pct, date, seqLabel } from '@/lib/format';
import { GST_RATE, REFUSAL_FACTOR } from '@/lib/pricing';
import { LEVEL_INFO } from '@/lib/levels';
import { userName } from '@/mock/users';
import { BILLING_DESK, OUTCOME_LABEL, SETTLEMENT_FOUNDER_ABOVE, elan1Person, rerunReconciliation } from '@/mock/billing';
import { Banner, Button, Drawer, Field, Input, KeyValue, StatusChip, Textarea, toast } from '@/components/ui';
import { money, rate, monthLabelLong, type Currency } from './model';
import { SUPPLIER, linesHref, taxSplit, type ChainInvoice, type ChainInvoiceStatus, type ChainLine } from './chainMeter';

export const INVOICE_STATUS: Record<ChainInvoiceStatus, { tone: 'ok' | 'held' | 'neutral' | 'info' | 'bad'; label: string; icon: React.ReactNode }> = {
  paid: { tone: 'ok', label: 'Paid', icon: <CheckCircle2 className="h-3 w-3" aria-hidden /> },
  due: { tone: 'held', label: 'Due', icon: <Hourglass className="h-3 w-3" aria-hidden /> },
  draft: { tone: 'neutral', label: 'Draft — month open', icon: <CircleDashed className="h-3 w-3" aria-hidden /> },
  preview: { tone: 'info', label: 'Preview', icon: <Clock3 className="h-3 w-3" aria-hidden /> },
  held: { tone: 'bad', label: 'Held — not reconciled', icon: <ShieldAlert className="h-3 w-3" aria-hidden /> },
  credit: { tone: 'info', label: 'Credit note', icon: <FileMinus className="h-3 w-3" aria-hidden /> },
};

export function InvoiceStatus({ status }: { status: ChainInvoiceStatus }) {
  const m = INVOICE_STATUS[status];
  return <StatusChip tone={m.tone} size="sm" icon={m.icon}>{m.label}</StatusChip>;
}

/** Plain words for each invoice line, with the refusal rule stated where it applies. */
export function lineText(l: ChainLine, cur: Currency): { title: string; sub?: string; refusal?: boolean } {
  const tag = l.level && l.label.startsWith(`${LEVEL_INFO[l.level].short} · `) ? `${LEVEL_INFO[l.level].short} · ` : '';
  switch (l.kind) {
    case 'refused_beyond': return { title: `${tag}Refused actions beyond allowance — ${n(l.quantity ?? 0)} × ${rate(l.rate ?? 0, cur)} = ${money(l.amount, cur, true)}`, sub: `A refused action costs ${pct(REFUSAL_FACTOR)} of the per-action rate.`, refusal: true };
    case 'refused_inside': return { title: `${tag}Refused actions inside allowance — uses ${REFUSAL_FACTOR} of an included action each`, sub: `${n(l.quantity ?? 0)} ${l.quantity === 1 ? 'refusal' : 'refusals'} drew ${n(Math.round((l.quantity ?? 0) * REFUSAL_FACTOR * 10) / 10)} included actions from the yearly allowance.`, refusal: true };
    case 'inside': return { title: l.label, sub: `${n(l.quantity ?? 0)} ${l.quantity === 1 ? 'action' : 'actions'} drew 1 included action each.` };
    case 'beyond': return { title: `${l.label} — ${n(l.quantity ?? 0)} × ${rate(l.rate ?? 0, cur)}`, sub: 'Allowed actions and approved actions that ran.' };
    case 'floor': return { title: l.label, sub: l.unit === 'month' ? 'One twelfth of the yearly floor. The floor is never discounted.' : `One twelfth of the yearly floor, pro rata for ${l.unit} at this level. The floor is never discounted.` };
    case 'discount': return { title: `${l.label}${l.quantity ? ` — ${n(l.quantity)} × ${rate(Math.abs(l.rate ?? 0), cur)}` : ''}`, sub: l.note };
    case 'pilot': return { title: l.label, sub: `${n(l.quantity ?? 0)} governed ${l.quantity === 1 ? 'action' : 'actions'} at ${money(0, cur)}. ${l.note ?? ''}` };
    case 'sandbox': return { title: l.label, sub: l.note };
    case 'credit': return { title: l.label, sub: l.note };
    case 'pack':
    case 'profile': return { title: l.label, sub: `${l.unit === 'month' ? 'One twelfth of the yearly price' : `One twelfth of the yearly price, pro rata for ${l.unit}`}${l.note ? ` · ${l.note}` : ''}` };
    default: return { title: l.label, sub: l.quantity && l.rate ? `${n(l.quantity)} ${l.unit ?? ''} × ${rate(l.rate, cur)}${l.note ? ` · ${l.note}` : ''}` : l.note };
  }
}

const DISPUTABLE = new Set(['floor', 'beyond', 'refused_beyond', 'pack', 'seat', 'profile', 'exports', 'deployment']);

export function InvoiceDrawer({ invoice, cur, onClose, onPrint, onOpen }: { invoice?: ChainInvoice; cur: Currency; onClose: () => void; onPrint: (inv: ChainInvoice) => void; onOpen?: (id: string) => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canManage = useCan('billing.manage');
  const ownerAdmin = role === 'owner' || role === 'admin';
  const [disputing, setDisputing] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!invoice) return null;
  const tax = taxSplit(invoice);
  const credit = invoice.kind === 'credit_note';

  const withdraw = async (l: ChainLine) => {
    if (!user || !l.held) return;
    // owners only: checked by mock/billing.ts withdrawDispute, not only on screen
    try {
      const r = await api.withdrawDispute(orgId, user.id, l.held.seq);
      toast.ok('Dispute withdrawn', `The line is payable again. Receipt ${seqLabel(r.seq)}.`);
    } catch (e) { toast.bad('The dispute was not withdrawn', (e as Error).message); }
  };
  const reconcile = () => {
    if (!user) return;
    setBusy(true);
    try {
      const r = rerunReconciliation(orgId, user.id, invoice.period);
      toast.ok('Period reconciled', `The meter was rebuilt from the chain and the invoice is released. Receipt ${seqLabel(r.seq)}.`);
    } catch (e) { toast.bad('The reconciliation did not run', (e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      kicker={`${credit ? 'Credit note' : 'Tax invoice'} · ${invoice.number}`}
      title={credit ? `Credit against ${invoice.creditFor?.invoice}` : invoice.kind === 'deployment' ? 'Sovereign deployment licence' : monthLabelLong(invoice.period)}
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="secondary" icon={<FileDown className="h-4 w-4" />} onClick={() => onPrint(invoice)}>Download PDF</Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <InvoiceStatus status={invoice.status} />
        {invoice.status !== 'held' && invoice.heldAmount > 0 && <StatusChip size="sm" tone="held" icon={<Flag className="h-3 w-3" aria-hidden />}>{money(invoice.heldAmount, cur, true)} held in dispute</StatusChip>}
        <span className="text-xs text-muted">{invoice.status === 'draft' ? `Issues on ${date(invoice.issuedAt)}` : invoice.status === 'held' ? 'Not issued until the period reconciles' : `Issued ${date(invoice.issuedAt)}`}{invoice.dueAt && invoice.status === 'due' ? ` · due ${date(invoice.dueAt)}` : ''}</span>
      </div>

      {invoice.status === 'held' && invoice.heldBy && (
        <Banner tone="bad" className="mb-4" title="This invoice is held: the meter and the chain disagree for this period"
          actions={ownerAdmin ? <Button size="sm" variant="primary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy} onClick={reconcile}>Run the reconciliation again</Button> : undefined}>
          The nightly run (<Link className="link font-mono" to={`/activity/${invoice.heldBy.seq}`}>{seqLabel(invoice.heldBy.seq)}</Link>) counted {n(invoice.heldBy.meterEvents)} meter events against {n(invoice.heldBy.chainDecisions)} decisions in the chain. The invoice is not issued on either number until the period reconciles; nothing is payable meanwhile.
          {!ownerAdmin && ' Owners and admins run the reconciliation.'}
        </Banner>
      )}

      {credit && invoice.creditFor && (
        <Banner tone="info" className="mb-4" title={`${OUTCOME_LABEL[invoice.creditFor.outcome]} dispute — credit note`}>
          Credits the line “{invoice.creditFor.lineLabel}” on{' '}
          {onOpen ? <button type="button" className="link font-mono" onClick={() => onOpen(invoice.creditFor!.invoice)}>{invoice.creditFor.invoice}</button> : <span className="font-mono">{invoice.creditFor.invoice}</span>}.
          {' '}Dispute <Link className="link font-mono" to={`/activity/${invoice.creditFor.disputeSeq}`}>{seqLabel(invoice.creditFor.disputeSeq)}</Link>, settled in <Link className="link font-mono" to={`/activity/${invoice.creditFor.settlementSeq}`}>{seqLabel(invoice.creditFor.settlementSeq)}</Link>. GST is reversed with it.
        </Banner>
      )}

      <div className="grid gap-px bg-line border border-line sm:grid-cols-2 mb-5 text-sm">
        <div className="bg-surface p-3">
          <p className="label mb-1">Supplier</p>
          <p className="font-medium">{SUPPLIER.name}</p>
          <p className="text-muted">{SUPPLIER.address}</p>
          <p className="text-muted">GSTIN <span className="font-mono">{SUPPLIER.gstin}</span></p>
        </div>
        <div className="bg-surface p-3">
          <p className="label mb-1">Bill to</p>
          <p className="font-medium">{invoice.customer.name}</p>
          <p className="text-muted">Place of supply: {invoice.placeOfSupply}</p>
          <p className="text-muted">SAC <span className="font-mono">{SUPPLIER.sac}</span> · {SUPPLIER.sacLabel}</p>
        </div>
      </div>

      {invoice.kind === 'monthly' && (
        <p className="text-sm text-muted mb-4">
          Every line is computed from {plural2(invoice.events, 'governed action')} in this organisation’s chain{invoice.fromSeq ? <> (<Link className="link font-mono" to={`/activity/${invoice.fromSeq}`}>{seqLabel(invoice.fromSeq)}</Link>–<Link className="link font-mono" to={`/activity/${invoice.toSeq}`}>{seqLabel(invoice.toSeq!)}</Link>)</> : null}
          {invoice.segments.length > 1 ? `, under ${invoice.segments.map((s) => `${s.pilot ? 'the pilot' : LEVEL_INFO[s.level].short} for ${s.days} days`).join(' and ')}` : ''}.
          {invoice.partial && <> Metered from {date(invoice.partial)}, where this console’s copy of the chain starts.</>}
        </p>
      )}

      <table className="w-full text-sm border border-line">
        <caption className="sr-only">{credit ? 'Credit note lines' : 'Invoice lines'}</caption>
        <thead className="bg-sunken/80">
          <tr className="border-b border-line">
            <th scope="col" className="label text-left px-3 h-9">Line</th>
            <th scope="col" className="label text-right px-3 h-9 w-[130px]">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => {
            const t = lineText(l, cur);
            return (
              <tr key={l.id} className={'border-b border-line align-top ' + (l.held ? 'bg-held-bg/40' : t.refusal ? 'bg-bad-bg/20' : '')}>
                <td className="px-3 py-3">
                  <p className="font-medium">{t.title}</p>
                  {t.sub && <p className="mt-0.5 text-xs text-muted">{t.sub}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {(l.quantity ?? 0) > 0 && ['inside', 'beyond', 'refused_inside', 'refused_beyond', 'exports', 'discount', 'pilot', 'sandbox'].includes(l.kind) && (
                      <Link to={linesHref(l)} className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-2">
                        Show the records behind this line{l.fromSeq ? ` (${seqLabel(l.fromSeq)}–${seqLabel(l.toSeq!)})` : ''}<ArrowUpRight className="h-3 w-3" aria-hidden />
                      </Link>
                    )}
                    {l.discount && <Link to={`/activity/${l.discount.seq}`} className="text-muted hover:text-fg underline underline-offset-2">Discount recorded in {seqLabel(l.discount.seq)}</Link>}
                    {!credit && !l.held && !l.settled && l.amount > 0 && DISPUTABLE.has(l.kind) && invoice.status !== 'paid' && (
                      canManage
                        ? <button type="button" className="text-muted hover:text-fg underline underline-offset-2" onClick={() => setDisputing(disputing === l.id ? undefined : l.id)}>Dispute this line</button>
                        : <span className="text-subtle" title="Owners dispute invoice lines.">Owners dispute lines</span>
                    )}
                  </div>
                  {l.held && (
                    <div className="mt-2 border-l-[3px] border-held pl-2 text-xs">
                      <p className="font-medium text-held-fg inline-flex items-center gap-1"><Flag className="h-3 w-3" aria-hidden />Held — disputed by {userName(l.held.by)} on {date(l.held.at)} (<Link className="link font-mono" to={`/activity/${l.held.seq}`}>{seqLabel(l.held.seq)}</Link>)</p>
                      <p className="text-muted">{l.held.reason}{l.held.fromSeq ? ` · receipts ${seqLabel(l.held.fromSeq)}–${seqLabel(l.held.toSeq ?? l.held.fromSeq)}` : ''}</p>
                      <p className="mt-1 inline-flex items-center gap-1 text-muted"><Gavel className="h-3 w-3" aria-hidden />With {elan1Person(BILLING_DESK)?.name}, {elan1Person(BILLING_DESK)?.title}. elan1 decides against the records — upheld, partly upheld or rejected — and the decision is written here{l.amount > SETTLEMENT_FOUNDER_ABOVE ? `; a credit above ${money(SETTLEMENT_FOUNDER_ABOVE, 'INR')} also needs an elan1 founder’s approval` : ''}. Nobody in this organisation can decide it. In this demo, an owner records elan1’s decision in the Elan1 billing desk panel on this page.</p>
                      {canManage && (
                        <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                          <button type="button" className="inline-flex items-center gap-1 underline underline-offset-2" onClick={() => withdraw(l)}><Undo2 className="h-3 w-3" aria-hidden />Withdraw the dispute</button>
                        </span>
                      )}
                    </div>
                  )}
                  {l.settled && (
                    <div className={'mt-2 border-l-[3px] pl-2 text-xs ' + (l.settled.outcome === 'rejected' ? 'border-line' : 'border-ok')}>
                      <p className="font-medium inline-flex items-center gap-1">
                        {l.settled.outcome === 'rejected' ? <Ban className="h-3 w-3" aria-hidden /> : <CheckCircle2 className="h-3 w-3" aria-hidden />}
                        Dispute {OUTCOME_LABEL[l.settled.outcome].toLowerCase()} by {l.settled.decidedBy}{l.settled.approvedBy ? `, approved by ${l.settled.approvedBy}` : ''} on {date(l.settled.at)} (<Link className="link font-mono" to={`/activity/${l.settled.seq}`}>{seqLabel(l.settled.seq)}</Link>)
                      </p>
                      <p className="text-muted">Disputed: {l.settled.reason}</p>
                      <p className="text-muted">Decision: {l.settled.note}</p>
                      <p className="text-muted">
                        {l.settled.outcome === 'rejected' ? 'No credit: the line stands as invoiced and is payable.' : <>Credit note {onOpen && l.settled.creditNote ? <button type="button" className="link font-mono" onClick={() => onOpen(l.settled!.creditNote!)}>{l.settled.creditNote}</button> : <span className="font-mono">{l.settled.creditNote}</span>} for {money(l.settled.credit, cur, true)} plus GST.</>}
                      </p>
                    </div>
                  )}
                  {disputing === l.id && <DisputeForm invoice={invoice} line={l} onDone={() => setDisputing(undefined)} />}
                </td>
                <td className="px-3 py-3 text-right num whitespace-nowrap">{l.amount === 0 ? <span className="text-muted">{money(0, cur)}</span> : money(l.amount, cur, true)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <KeyValue className="mt-4" items={[
        { k: 'Taxable value', v: <span className="num">{money(invoice.subtotal, cur, true)}</span> },
        ...tax.map((x) => ({ k: x.label, v: <span className="num">{money(x.amount, cur, true)}</span> })),
        { k: <span className="font-semibold text-fg">{credit ? 'Total credited' : 'Total'}</span>, v: <span className="num font-display text-lg font-semibold">{money(invoice.total, cur, true)}</span> },
        ...(invoice.credits?.length ? invoice.credits.map((c) => ({ k: <span>Credit note {onOpen ? <button type="button" className="link font-mono" onClick={() => onOpen(c.number)}>{c.number}</button> : c.number}</span>, v: <span className="num">−{money(c.amount * (1 + GST_RATE), cur, true)}</span> })) : []),
        ...(invoice.status === 'held' ? [{ k: 'Payable now', v: <span className="num font-semibold">{money(0, cur, true)} — held</span> }] : invoice.heldAmount > 0 ? [{ k: 'Payable now (held lines excluded)', v: <span className="num font-semibold">{money(invoice.payableNow, cur, true)}</span> }] : []),
      ]} />

      <div className="mt-5 grid gap-px bg-line border border-line sm:grid-cols-2 text-sm">
        <div className="bg-surface p-3 min-w-0">
          <p className="label mb-1">GST e-invoice</p>
          <p className="text-xs text-muted">IRN (SHA-256 of GSTIN, financial year, type and number, as the Invoice Registration Portal derives it)</p>
          <p className="mt-1 font-mono text-[11.5px] break-all">{invoice.irn}</p>
        </div>
        <div className="bg-surface p-3">
          <p className="label mb-1">{credit ? 'Settlement' : 'Payment'}</p>
          <p>{credit ? 'Set against the next payment, or refunded by bank transfer if nothing is due.' : invoice.status === 'paid' ? 'Received by bank transfer.' : invoice.status === 'due' ? `By bank transfer quoting ${invoice.number}, by ${date(invoice.dueAt!)}.` : invoice.status === 'held' ? 'Not issued: the period is held until the meter and the chain agree.' : 'Not yet issued — the month is still open.'}</p>
          <p className="mt-1 text-xs text-muted">The status changes when elan1 records the payment. GST at {pct(GST_RATE)} {tax.length > 1 ? 'is split CGST and SGST (same state)' : 'is IGST (another state)'}.</p>
        </div>
      </div>
    </Drawer>
  );
}

function plural2(count: number, one: string) { return `${n(count)} ${count === 1 ? one : one + 's'}`; }

function DisputeForm({ invoice, line, onDone }: { invoice: ChainInvoice; line: ChainLine; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const ids = { f: useId(), t: useId(), r: useId() };
  const [from, setFrom] = useState(String(line.fromSeq ?? invoice.fromSeq ?? ''));
  const [to, setTo] = useState(String(line.toSeq ?? invoice.toSeq ?? ''));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string>();
  const f = Number(from);
  const t = Number(to);
  const hasRange = line.fromSeq !== undefined || invoice.fromSeq !== undefined;
  const rangeOk = !hasRange || (Number.isInteger(f) && Number.isInteger(t) && f <= t && f >= (invoice.fromSeq ?? f) && t <= (invoice.toSeq ?? t));
  const ok = rangeOk && reason.trim().length >= 10;
  const submit = async () => {
    if (!user || !ok) return;
    // owners only: checked by mock/billing.ts openDispute, not only on screen
    try {
      const r = await api.openDispute(orgId, user.id, { invoice: invoice.number, line: line.id, reason: reason.trim(), ...(hasRange ? { fromSeq: f, toSeq: t } : {}) });
      toast.held('Line held in dispute', `The rest of the invoice proceeds. Receipt ${seqLabel(r.seq)}.`);
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="mt-3 border border-line bg-sunken/40 p-3 space-y-3">
      <p className="text-xs text-muted">Name the receipts you disagree with. The line is held while the rest of the invoice proceeds; the dispute is itself a receipt. elan1 settles it against the records: upheld (a credit note), partly upheld (a credit note for part) or rejected.</p>
      {hasRange && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="From receipt" htmlFor={ids.f}><Input id={ids.f} mono inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To receipt" htmlFor={ids.t} error={!rangeOk ? `A range inside ${seqLabel(invoice.fromSeq ?? 0)}–${seqLabel(invoice.toSeq ?? 0)}` : undefined}><Input id={ids.t} mono inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      )}
      <Field label="Why" htmlFor={ids.r} hint="At least 10 characters."><Textarea id={ids.r} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {err && <Banner tone="bad">{err}</Banner>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" icon={<Flag className="h-3.5 w-3.5" />} disabled={!ok} onClick={submit}>Hold this line</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
