/**
 * The chain's standing in one line, wherever it is shown (Today's chain panel, the Proof hero). "Continuous" is never
 * claimed with a tick or over a range the integrity runs have not reached: the line says how far the runs checked
 * the links, and the records written since are shown as "not checked over #a–#b".
 */
import { Link } from 'react-router-dom';
import { OctagonX, ScanSearch, Waypoints } from 'lucide-react';
import { seqLabel } from '@/lib/format';
import type { ContinuityReport } from '@/mock/evidence';
import { UncheckedChip } from './IntegrityRuns';
import { cn } from '@/lib/cn';

export function ContinuityLine({ headSeq, firstSeq, report, inverse, runsHref = '/evidence?tab=integrity', onOpenRuns }: {
  headSeq: number;
  firstSeq?: number;
  report?: ContinuityReport;
  /** on the dark hero: plain text instead of chips */
  inverse?: boolean;
  runsHref?: string;
  /** open the integrity runs in place instead of following runsHref */
  onOpenRuns?: () => void;
}) {
  const failed = report?.failures[0];
  const checkedTo = report ? (report.unchecked ? report.unchecked.from - 1 : report.headSeq ?? headSeq) : undefined;
  const nothingChecked = checkedTo !== undefined && firstSeq !== undefined && checkedTo < firstSeq;
  const head = <Link to={`/activity/${headSeq}`} className="font-mono underline-offset-2 hover:underline">{seqLabel(headSeq)}</Link>;
  const runsLink = (label: string) => onOpenRuns
    ? <button type="button" className="underline underline-offset-2 hover:opacity-80" onClick={onOpenRuns}>{label}</button>
    : <Link to={runsHref} className="underline underline-offset-2 hover:opacity-80">{label}</Link>;

  const main = !report ? <>Head {head}</>
    : failed ? <>Integrity run failed{failed.brokenAt !== undefined ? <> at <span className="font-mono">{seqLabel(failed.brokenAt)}</span></> : null} · head {head}</>
    : nothingChecked ? <>Not yet checked by an integrity run · head {head}</>
    : checkedTo !== undefined && checkedTo < headSeq ? <>Links checked to <span className="font-mono">{seqLabel(checkedTo)}</span> · head {head}</>
    : <>Links checked to the head, {head}</>;

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-3 gap-y-1', inverse ? 'text-ink-200' : 'text-muted')}>
      <span className={cn('inline-flex items-center gap-1.5 font-medium', inverse ? 'text-paper' : 'text-fg')}>
        {failed ? <OctagonX className="h-4 w-4" aria-hidden /> : <Waypoints className="h-4 w-4" aria-hidden />}
        {main}
      </span>
      {report?.unchecked && !failed && (inverse
        ? <span className="inline-flex items-center gap-1"><ScanSearch className="h-3.5 w-3.5" aria-hidden />{runsLink(`Not checked over ${seqLabel(report.unchecked.from)}–${seqLabel(report.unchecked.to)}`)}</span>
        : <span className="inline-flex items-center gap-2"><UncheckedChip report={report} />{runsLink('Integrity runs')}</span>)}
      {report && !report.unchecked && !failed && !inverse && <UncheckedChip report={report} />}
    </span>
  );
}
