import { Banner } from '@/components/ui';
import { useKeysState } from './useKeys';

/**
 * Shown inside a key-change dialog (rotation, ceremony, successor, signing on) while key changes are refused: the
 * attempt is still allowed, and it is refused and recorded on the chain as key.change_refused.
 */
export function KeyChangeRefusalNote({ className, allowBound, allowCompromise }: { className?: string; allowBound?: boolean; allowCompromise?: boolean }) {
  const { data: s } = useKeysState();
  if (!s?.block) return null;
  // the flow's own step goes ahead: a bound successor's switch, or the compromise procedure's binding and switch
  if (!s.chainIncident && ((allowCompromise && s.compromise) || (allowBound && !s.compromise && s.bound))) return null;
  return (
    <Banner tone="held" className={className} title="Key changes are refused now">
      {s.block} If you go ahead, the attempt is refused and written to the chain as a receipt.
    </Banner>
  );
}
