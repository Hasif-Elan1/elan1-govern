import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { Receipt } from '@/types';
import { useUi } from '@/store/ui';
import { useOrgLevel } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { userName } from '@/mock/users';
import { time } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, DecisionChip, Panel } from '@/components/ui';
import { AgentLink, ReceiptLink } from '@/components/domain';

const KIND_LABEL: Record<Receipt['kind'], string> = { decision: 'Decision', approval: 'Approval', outcome: 'Outcome', admin: 'Admin' };

/** The most recent receipts. Rows that arrive after the first render flash in once (animate-row-in). */
export function LiveFeed({ receipts, paused, className }: { receipts: Receipt[]; paused?: boolean; className?: string }) {
  const liveUpdates = useUi((s) => s.liveUpdates);
  const seen = useRef<Set<number> | null>(null);
  const fresh = new Set<number>();
  if (seen.current === null) {
    seen.current = new Set(receipts.map((r) => r.seq));
  } else {
    for (const r of receipts) if (!seen.current.has(r.seq)) fresh.add(r.seq);
  }
  useEffect(() => {
    receipts.forEach((r) => seen.current?.add(r.seq));
  }, [receipts]);

  const live = liveUpdates && !paused;
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signed = atLeast(useOrgLevel(), 'l2');

  return (
    <Panel
      className={className}
      title="Live feed"
      flush
      actions={
        <>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
            <span className={cn('h-2 w-2', live ? 'bg-ok animate-pulse' : 'bg-line-strong')} aria-hidden />
            {live ? 'Live' : 'Paused'}
          </span>
          <Link to="/activity" className="text-sm font-medium hover:underline underline-offset-2">All activity</Link>
        </>
      }
      footer={<span>{signed ? 'Every row is a signed, hash-chained receipt.' : 'Every row is a receipt sealed in the hash chain.'}</span>}
    >
      {receipts.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">No receipts yet. When an agent calls a tool through Elan1 Govern, the decision appears here.</p>
      ) : (
        <ul className="divide-y divide-line" aria-label="Most recent receipts">
          {receipts.map((r) => (
            <li key={r.seq} className={cn('grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5', fresh.has(r.seq) && 'animate-row-in')}>
              <time dateTime={r.ts} className="text-xs text-muted num font-mono">{time(r.ts)}</time>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0 text-sm">
                  {r.agent ? <AgentLink slug={r.agent} className="min-w-0" /> : <span className="font-medium truncate">{userName(r.actor)}</span>}
                </div>
                <p className="font-mono text-[12px] text-muted truncate">{r.tool ?? r.action ?? KIND_LABEL[r.kind]}{r.kind === 'approval' && r.approval ? ` · ${r.approval.status}` : ''}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {r.kind === 'admin' ? <Badge>{KIND_LABEL[r.kind]}</Badge> : <DecisionChip decision={r.decision} size="sm" short />}
                <ReceiptLink seq={r.seq} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
