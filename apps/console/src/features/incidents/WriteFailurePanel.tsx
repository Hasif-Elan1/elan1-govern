import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { countdown, plural, timeShort } from '@/lib/format';
import { Badge, Panel, StatusChip } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';

/**
 * A receipt-write failure, from the guard's side: while the writer was failed every agent call was refused and none
 * ran. The refusals could not be written then; the recovery receipt counts them, and this panel lists them.
 */
export function WriteFailurePanel({ alertId }: { alertId: string }) {
  const id = alertId.replace(/^as_write_/, '');
  const [now, setNow] = useState(Date.now());
  const q = useQuery((o) => Promise.resolve(api.ops.writeFailures(o).find((f) => f.id === id)), [id, now], { kinds: ['receipt', 'incident'] });
  const f = q.data;
  const down = !!f && !f.recoveredSeq && (f.source === 'drill' ? !!f.endedAt && new Date(f.endedAt).getTime() > now : !f.endedAt);
  // while it is failing, look again every few seconds so the panel follows the guard
  useEffect(() => {
    if (!down) return;
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, [down]);
  if (!f) return null;
  const calls = f.calls ?? [];
  return (
    <Panel title="Calls while receipts failed" kicker={f.source === 'drill' ? 'Write-failure drill' : 'Receipt writer'} flush
      footer={<span>The guard runs nothing it cannot record. These refusals could not be written while the writer was failed; {f.recoveredSeq !== undefined ? 'the recovery receipt counts them.' : 'they are written as one receipt when it is back.'}</span>}>
      <div className="px-5 py-4 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {down
            ? <StatusChip tone="bad" size="sm">Writer failed{f.source === 'drill' && f.endedAt ? ` · back in ${countdown(f.endedAt, now)}` : ''}</StatusChip>
            : <StatusChip tone="ok" size="sm">Receipts written again</StatusChip>}
          <Badge>{plural(f.refused ?? 0, 'call')} refused · 0 ran</Badge>
          {f.recoveredSeq !== undefined && <span className="text-xs text-muted">Recovery <ReceiptLink seq={f.recoveredSeq} /></span>}
        </div>
        <p className="text-xs text-muted">From {timeShort(f.at)}{f.endedAt ? ` to ${timeShort(f.endedAt)}` : ''} IST. {f.error}</p>
      </div>
      {calls.length > 0 ? (
        <ul className="divide-y divide-line border-t border-line max-h-56 overflow-y-auto">
          {calls.slice().reverse().map((c, i) => (
            <li key={`${c.ts}_${i}`} className="px-5 py-2 flex items-center gap-3 text-xs">
              <span className="num text-muted shrink-0">{timeShort(c.ts)}</span>
              <span className="font-mono truncate">{c.agent}</span>
              <span className="font-mono text-muted truncate">{c.tool}</span>
              <span className="ml-auto shrink-0 text-bad-fg">Refused, not run</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pb-4 text-xs text-muted">{down ? 'No agent call has arrived since the writer failed. Any that does is refused and listed here.' : 'No agent call arrived while the writer was failed.'}</p>
      )}
    </Panel>
  );
}
