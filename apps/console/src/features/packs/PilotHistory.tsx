import { History } from 'lucide-react';
import type { earlierPilots } from '@/mock/packsFactory';
import { LEVEL_INFO } from '@/lib/levels';
import { date, n } from '@/lib/format';
import { Badge } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';

type Earlier = ReturnType<typeof earlierPilots>[number];

export const OUTCOME_LABEL = { relies: 'Relies on the evidence', relies_with_limits: 'Relies, with the limits stated', does_not_rely: 'Does not rely on it' } as const;

/** Earlier pilots of the pack, kept for ever: who, when, the verdict verbatim and the G-D answer. */
export function PilotHistory({ pilots }: { pilots: Earlier[] }) {
  if (!pilots.length) return null;
  return (
    <div className="border-t border-line">
      <p className="px-5 pt-4 pb-2 label inline-flex items-center gap-1.5"><History className="h-3.5 w-3.5" aria-hidden />Earlier pilots · kept for ever</p>
      <ol className="divide-y divide-line">
        {pilots.map((p) => (
          <li key={p.startedAt} className="px-5 py-3 text-sm space-y-1.5">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{date(p.startedAt)} to {date(p.endedAt)}</span>
              <span className="text-muted">· {p.auditor.name}, {p.auditor.firm} · started at {LEVEL_INFO[p.startLevel].label}</span>
              {p.status === 'closed' ? <Badge tone={p.gd?.answer === 'yes' ? 'ok' : 'bad'}>Closed day {p.endedDay} · G-D {p.gd?.answer === 'yes' ? 'yes' : 'no'}</Badge> : <Badge tone="bad">Stopped day {p.endedDay}</Badge>}
              {p.startSeq !== undefined && <ReceiptLink seq={p.startSeq} />}
            </p>
            {p.selfExport && <p className="text-xs text-muted">Day 76: {n(p.selfExport.receipts)} records exported, {p.selfExport.help ? `help was needed — ${p.selfExport.note}` : 'no help needed'}.</p>}
            {p.airGap && <p className="text-xs text-muted">Day 77: the customer’s bundle exit {p.airGap.goodExit} {p.airGap.goodCode}; tampered copy exit {p.airGap.tamperedExit} {p.airGap.tamperedCode}.</p>}
            {p.verdict && <div className="text-xs"><Badge tone={p.verdict.outcome === 'does_not_rely' ? 'bad' : p.verdict.outcome === 'relies' ? 'ok' : 'held'}>{OUTCOME_LABEL[p.verdict.outcome]}</Badge> <span className="text-muted">— {p.verdict.auditor}, verbatim:</span><blockquote className="mt-1 border-l-2 border-line-strong pl-3 text-muted">{p.verdict.words}</blockquote></div>}
            {p.gd && <p className="text-xs text-muted">Day 85: “{p.gd.note}”{p.gd.seq !== undefined && <> · <ReceiptLink seq={p.gd.seq} /></>}</p>}
            {p.status === 'stopped' && p.stoppedReason && <p className="text-xs text-bad-fg">{p.stoppedReason}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
