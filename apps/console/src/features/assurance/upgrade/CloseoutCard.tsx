import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { date, n, seqLabel } from '@/lib/format';
import { Button, Panel, StatusChip } from '@/components/ui';
import { useCloseout } from './shared';

/**
 * A short summary of the newest L1 → L2 close-out, with a link to it. Renders nothing when there is no switched upgrade
 * and no signed island to show.
 */
export function CloseoutCard({ className }: { className?: string }) {
  const nav = useNavigate();
  const { data: v } = useCloseout();
  if (!v || (v.phase === 'none' || v.phase === 'preparing') && v.islands.length === 0) return null;
  const passing = v.checks.filter((c) => c.state === 'pass').length;
  const switched = v.phase !== 'none' && v.phase !== 'preparing';
  return (
    <Panel className={className} title="L1 → L2 close-out" kicker={switched && v.boundary ? `Boundary ${date(v.boundary.at)}` : 'Signed islands'}
      actions={<Button size="sm" variant="secondary" iconRight={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => nav('/assurance/upgrade/closeout')}>Open the close-out</Button>}>
      {switched ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <StatusChip tone={v.phase === 'closed' ? 'ok' : v.phase === 'rolled_back' ? 'bad' : 'held'}>{v.phase === 'closed' ? 'Closed' : v.phase === 'rolled_back' ? 'Rolled back' : 'In close-out'}</StatusChip>
          {v.signing && <span>Signing on at <span className="font-mono">{seqLabel(v.signing.seq)}</span></span>}
          {v.phase !== 'rolled_back' && <span>{passing} of 7 closing checks pass</span>}
          {v.closed && <span>Closing record <span className="font-mono">{seqLabel(v.closed.seq)}</span></span>}
          {v.rolledBack && <span>Island {seqLabel(v.rolledBack.firstSeq)}–{seqLabel(v.rolledBack.lastSeq)} ({n(v.rolledBack.records)} records)</span>}
        </div>
      ) : (
        <p className="text-sm">{v.islands.length} signed island{v.islands.length === 1 ? '' : 's'} from rolled-back upgrades: {v.islands.map((i) => `${seqLabel(i.firstSeq)}–${seqLabel(i.lastSeq)}`).join(', ')}.</p>
      )}
    </Panel>
  );
}
