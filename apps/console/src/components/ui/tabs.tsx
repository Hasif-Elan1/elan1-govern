import { useRef, type ReactNode, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<T extends string> { value: T; label: ReactNode; count?: number; disabled?: boolean }

/** Underline tabs. Arrow keys move between tabs (WAI-ARIA tabs pattern). The active rule is ink, not clay, so clay stays the page's one accent. */
export function Tabs<T extends string>({ value, onChange, items, className, label }: { value: T; onChange: (v: T) => void; items: TabItem<T>[]; className?: string; label?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    let j = i;
    do { j = (j + dir + items.length) % items.length; } while (items[j].disabled && j !== i);
    refs.current[j]?.focus();
    onChange(items[j].value);
  };
  return (
    <div role="tablist" aria-label={label} className={cn('flex items-end gap-6 border-b border-line overflow-x-auto', className)}>
      {items.map((t, i) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => (refs.current[i] = el)}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(t.value)}
            className={cn('relative -mb-px inline-flex items-center gap-1.5 h-10 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-40', on ? 'text-fg' : 'text-muted hover:text-fg')}
          >
            {t.label}
            {t.count !== undefined && <span className={cn('num text-[11px] px-1 border', on ? 'border-fg/30 text-fg' : 'border-line text-subtle')}>{t.count}</span>}
            <span className={cn('absolute inset-x-0 bottom-0 h-[2px] transition-colors', on ? 'bg-fg' : 'bg-transparent')} />
          </button>
        );
      })}
    </div>
  );
}
