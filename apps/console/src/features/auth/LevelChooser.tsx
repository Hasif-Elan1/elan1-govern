import { Check } from 'lucide-react';
import type { LevelId } from '@/types';
import { PLANS, listPriceLine } from '@/lib/pricing';
import { LEVEL_INFO, LEVELS } from '@/lib/levels';
import { n, rupees, rupeesShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ListPriceTag } from '@/features/billing/ListPriceTag';

/** Price lines for a level, from the price book (refused actions at 40% of the per-action rate). */
export function priceLines(level: LevelId) {
  const p = PLANS[level];
  return {
    floor: level === 'sovereign' ? `${rupeesShort(p.floorPerYear)} per deployment a year` : `${rupees(p.floorPerYear)} a year`,
    included: p.includedPerYear ? `${n(p.includedPerYear)} actions included` : 'Metered from the first action',
    perAction: `${rupees(p.overageRate, { paise: true })} an action beyond that · refused ${rupees(p.refusalRate, { paise: true })}`,
    listPrice: listPriceLine(level),
  };
}

/** What each level lets you show someone, in one line. */
export const LEVEL_PROVES: Record<LevelId, string> = {
  l1: 'Decided before the call, approved by a named person, sealed in a hash chain by Elan1 Govern and checkable offline; not yet externally timestamped. Regulatory packs run as a dry run.',
  l2: 'Signed, sealed records timestamped by two authorities, keys in AWS KMS, regulatory packs live, verifier profiles per regime, dual control.',
  l3: 'Receipts other organisations can verify, selective disclosure, earned autonomy up to A3 by two-person graduation, keys in your own HSM.',
  sovereign: 'All of Proven on your own infrastructure: your cluster, HSM and timestamp authorities, no egress.',
};

/**
 * Four assurance levels as selectable cards (a radio group). Each card carries the price, the allowance,
 * the per-action and refused-action rates, and what the level proves.
 */
export function LevelChooser({ value, onChange, name = 'level', min, compact }: { value: LevelId; onChange: (l: LevelId) => void; name?: string; min?: LevelId; compact?: boolean }) {
  const minRank = min ? LEVELS.indexOf(min) : 0;
  return (
    <div role="radiogroup" aria-label="Assurance level" className={cn('grid gap-2', compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2')}>
      {LEVELS.map((lv, i) => {
        const on = value === lv;
        const p = priceLines(lv);
        const below = i < minRank;
        return (
          <label key={lv} className={cn('relative flex cursor-pointer flex-col border bg-surface p-4 transition-colors focus-within:shadow-[0_0_0_2px_rgb(var(--fg))]',
            on ? 'border-fg shadow-[inset_0_0_0_1px_rgb(var(--fg))]' : 'border-line hover:border-line-strong', below && 'cursor-not-allowed opacity-55')}>
            <input type="radio" name={name} value={lv} checked={on} disabled={below} onChange={() => onChange(lv)} className="sr-only" />
            <span className="flex items-start justify-between gap-2">
              <span>
                <span className="label">{LEVEL_INFO[lv].tag}</span>
                <span className="block font-display text-lg font-semibold leading-tight">{LEVEL_INFO[lv].name}</span>
              </span>
              <span className={cn('mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center border', on ? 'border-fg bg-fg text-canvas' : 'border-line-strong')} aria-hidden>{on && <Check className="h-3 w-3" strokeWidth={3} />}</span>
            </span>
            <span className="mt-2 text-sm font-semibold num">{p.floor}</span>
            <span className="text-xs text-muted num">{p.included}</span>
            <span className="text-xs text-muted num">{p.perAction}</span>
            <ListPriceTag planId={lv} className="mt-1" />
            {!compact && <span className="mt-2 text-sm text-fg/85 leading-snug">{LEVEL_PROVES[lv]}</span>}
            {below && <span className="mt-2 text-xs text-muted">Below your current level — levels only go up.</span>}
          </label>
        );
      })}
    </div>
  );
}
