import type { PlanId } from '@/types';
import { LIST_PRICE, listPriceLine } from '@/lib/pricing';
import { cn } from '@/lib/cn';

/**
 * The label every list price carries, wherever it is shown (levels, upgrade, sign-up, onboarding, the meter):
 * "Modelled list price", the level's target date, and the +4% a year after March 2029.
 */
export function ListPriceTag({ planId, className, long }: { planId: PlanId; className?: string; long?: boolean }) {
  return (
    <span className={cn('block text-[11px] leading-snug text-muted', className)} title={LIST_PRICE.note}>
      {long ? `${LIST_PRICE.label} · ${LIST_PRICE.targets[planId]} · ${LIST_PRICE.escalationNote}` : listPriceLine(planId)}
    </span>
  );
}
