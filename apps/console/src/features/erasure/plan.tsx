/**
 * The erasure plan: what an erasure would touch — the fields removed from each receipt, the systems that hold the
 * data, the exports already made that cover it, the consents on record — and what statutory retention holds back.
 * Shown before a request is opened and kept with it. When every matching record is under retention, the request is
 * refused and the refusal recorded (erasure.refused).
 */
import { Ban, Database, FileDown, Gavel, Plug, Scale } from 'lucide-react';
import { SmartLink } from '@/shell/access';
import type { ErasurePlan, ErasureRefusal } from '@/mock/records';
import { RETENTION_BASES } from '@/mock/records';
import { date, n, plural, seqLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, EmptyState, Hash, Panel, StatusChip } from '@/components/ui';
import { Person, ReceiptLink } from '@/components/domain';
import { useOrgLevel } from '@/store/session';
import { atLeast } from '@/lib/levels';

const OUTCOME: Record<ErasurePlan['outcome'], { tone: 'ok' | 'held' | 'bad' | 'neutral'; label: string }> = {
  proceed: { tone: 'ok', label: 'Can be erased' },
  partial: { tone: 'held', label: 'Partly held by statutory retention' },
  refused: { tone: 'bad', label: 'Refused — every record is under statutory retention' },
  nothing: { tone: 'neutral', label: 'No record matches' },
};

export function PlanOutcome({ plan }: { plan: ErasurePlan }) {
  const o = OUTCOME[plan.outcome];
  return <StatusChip size="sm" tone={o.tone} icon={plan.outcome === 'refused' ? <Ban className="h-3 w-3" /> : plan.outcome === 'partial' ? <Scale className="h-3 w-3" /> : undefined}>{o.label}</StatusChip>;
}

export function ErasurePlanView({ plan, className }: { plan: ErasurePlan; className?: string }) {
  // L1 records are sealed; "signed" from L2
  const signed = atLeast(useOrgLevel(), 'l2');
  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <PlanOutcome plan={plan} />
        <span className="text-muted"><span className="num font-medium text-fg">{n(plan.matched)}</span> matching · <span className="num font-medium text-fg">{n(plan.erasable.length)}</span> to erase · <span className="num font-medium text-fg">{n(plan.held.length)}</span> held</span>
        <span className="ml-auto text-xs text-muted inline-flex items-center gap-1">Plan digest <Hash value={plan.digest} len={12} /></span>
      </div>

      {plan.bases.length > 0 && (
        <Banner tone={plan.outcome === 'refused' ? 'bad' : 'held'} title={plan.outcome === 'refused' ? 'Erasure refused: the law requires these records to be kept' : `${plural(plan.held.length, 'record')} held back by statutory retention`}>
          <ul className="space-y-1">
            {plan.bases.map((b) => <li key={b.law}><span className="font-medium">{b.law}</span> — {b.label} ({b.cite}). {plural(b.receipts, 'record')}, held until {date(b.holdUntil)}.</li>)}
          </ul>
          <p className="mt-1">{plan.outcome === 'refused' ? 'Nothing is erased. The refusal is recorded with the plan, and the person is told which law applies and until when.' : 'These records are left as they are; the rest are erased.'}</p>
        </Banner>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="label mb-1.5">Fields removed from each receipt</p>
          {plan.fields.length ? (
            <ul className="flex flex-wrap gap-1">{plan.fields.map((f) => <li key={f.name}><Badge><span className="font-mono">{f.name}</span> <span className="text-subtle num">× {f.receipts}</span></Badge></li>)}</ul>
          ) : <p className="text-sm text-muted">None — no record would be erased.</p>}
          <p className="mt-1.5 text-xs text-muted">The values the rules inspected. Hashes, {signed ? 'signatures' : 'seals'} and the chain links stay.</p>
        </div>
        <div>
          <p className="label mb-1.5">Systems that hold this data</p>
          {plan.systems.length ? (
            <ul className="space-y-1.5 text-sm">
              {plan.systems.map((s) => (
                <li key={`${s.kind}:${s.name}`} className="flex items-start gap-2">
                  {s.kind === 'connector' ? <Plug className="h-3.5 w-3.5 mt-0.5 text-muted shrink-0" aria-hidden /> : <Database className="h-3.5 w-3.5 mt-0.5 text-muted shrink-0" aria-hidden />}
                  <span className="min-w-0">{s.to ? <SmartLink to={s.to} plainClassName="font-medium" className="font-medium hover:underline underline-offset-2">{s.name}</SmartLink> : <span className="font-medium">{s.name}</span>}{s.receipts ? <span className="text-muted num"> · {plural(s.receipts, 'record')}</span> : null}<span className="block text-xs text-muted">{s.note}</span></span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">None.</p>}
        </div>
        <div>
          <p className="label mb-1.5">Exports already made that cover it</p>
          {plan.exports.length ? (
            <ul className="space-y-1 text-sm">
              {plan.exports.map((x) => <li key={x.id} className="flex items-start gap-2"><FileDown className="h-3.5 w-3.5 mt-0.5 text-muted shrink-0" aria-hidden /><span><span className="font-mono">{seqLabel(x.firstSeq)}–{seqLabel(x.lastSeq)}</span> · {date(x.ts)} · {plural(x.covered, 'record')}<span className="block text-xs text-muted">{x.format}. Copies already handed over keep the values; tell whoever holds them.</span></span></li>)}
            </ul>
          ) : <p className="text-sm text-muted">No export covers these records. New exports leave the values out.</p>}
        </div>
        <div>
          <p className="label mb-1.5">Consents on record for this person</p>
          {plan.consents.length ? (
            <ul className="space-y-1 text-sm">{plan.consents.map((c) => <li key={c.id}><SmartLink to="/records/consent" plainClassName="font-mono" className="font-mono hover:underline underline-offset-2">{c.id}</SmartLink> · {c.purpose.replace(/_/g, ' ')} · {c.status}</li>)}</ul>
          ) : <p className="text-sm text-muted">None in the consent ledger for this exact identifier.</p>}
        </div>
      </div>
    </div>
  );
}

export function RefusalsPanel({ refusals }: { refusals: ErasureRefusal[] | undefined }) {
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Gavel className="h-4 w-4" aria-hidden />Refused for statutory retention</span>} kicker="Recorded refusals" flush
      footer={<span>Retention rules applied: {RETENTION_BASES.map((b) => `${b.law} ${b.years} years`).join(' · ')}.</span>}>
      {!refusals ? null : refusals.length === 0 ? (
        <EmptyState compact title="No erasure refused" disc="registration">A request is refused only when every matching record must be kept by law.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {refusals.map((r) => (
            <li key={r.id} className="px-5 py-3 text-sm">
              <p className="flex flex-wrap items-center gap-2"><span className="font-mono font-semibold">{r.subjectRef}</span>{r.bases.map((b) => <Badge key={b} tone="bad">{b}</Badge>)}{r.seq !== undefined && <span className="ml-auto"><ReceiptLink seq={r.seq} /></span>}</p>
              <p className="mt-0.5">{r.reason}</p>
              <p className="mt-0.5 text-xs text-muted inline-flex flex-wrap items-center gap-1">{plural(r.matched, 'record')} held until {r.holdUntil ? date(r.holdUntil) : '—'} · asked by <Person id={r.requestedBy} size={16} /> · {date(r.at)}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
