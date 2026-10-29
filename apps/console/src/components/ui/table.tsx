import { useMemo, useState, type ReactNode, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useUi } from '@/store/ui';
import { Skeleton } from './core';
import { EmptyState } from './layout';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  sort?: (row: T) => string | number;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  hideBelow?: 'sm' | 'md' | 'lg';
}

/**
 * Dense, accessible data table: sortable headers, keyboard row navigation (↑ ↓ Enter),
 * sticky header, density from user preference, skeleton and empty states.
 */
export function DataTable<T>({ columns, rows, onRowClick, rowKey, loading, empty, selectedKey, className, rowClassName, maxHeight, caption, initialSort }: {
  columns: Column<T>[]; rows: T[] | undefined; onRowClick?: (row: T) => void; rowKey: (row: T) => string | number; loading?: boolean;
  empty?: ReactNode; selectedKey?: string | number; className?: string; rowClassName?: (row: T) => string | undefined; maxHeight?: number | string; caption?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
}) {
  const density = useUi((s) => s.density);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | undefined>(initialSort);
  const sorted = useMemo(() => {
    if (!rows || !sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const s = [...rows].sort((a, b) => {
      const x = col.sort!(a), y = col.sort!(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.dir === 'desc' ? s.reverse() : s;
  }, [rows, sort, columns]);

  const rowH = density === 'compact' ? 'h-9' : 'h-12';
  const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    const tr = e.currentTarget;
    if (e.key === 'ArrowDown') { e.preventDefault(); (tr.nextElementSibling as HTMLElement | null)?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (tr.previousElementSibling as HTMLElement | null)?.focus(); }
    if (e.key === 'Enter' && onRowClick) onRowClick(row);
  };

  return (
    <div className={cn('relative overflow-auto border border-line bg-surface', className)} style={{ maxHeight }}>
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 z-10 bg-sunken/95 backdrop-blur-[2px]">
          <tr className="border-b border-line">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={{ width: c.width }}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn('h-9 px-3 text-left label whitespace-nowrap font-semibold', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideBelow && hide[c.hideBelow])}
                >
                  {c.sort ? (
                    <button className={cn('inline-flex items-center gap-1 hover:text-fg', active && 'text-fg')} onClick={() => setSort(active && sort!.dir === 'desc' ? { key: c.key, dir: 'asc' } : { key: c.key, dir: 'desc' })}>
                      {c.header}
                      {active ? (sort!.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ChevronsUpDown className="h-3 w-3 opacity-40" />}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && !rows?.length
            ? Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className={cn('border-b border-line', rowH)}>
                  {columns.map((c) => <td key={c.key} className={cn('px-3', c.hideBelow && hide[c.hideBelow])}><Skeleton className="h-3.5" style={{ width: `${40 + ((i * 7 + c.key.length * 13) % 50)}%` }} /></td>)}
                </tr>
              ))
            : sorted?.map((row, i) => {
                const k = rowKey(row);
                return (
                  <tr
                    key={k}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => onKey(e, row) : undefined}
                    aria-selected={selectedKey === k || undefined}
                    className={cn(
                      'border-b border-line last:border-b-0 transition-colors', rowH,
                      onRowClick && 'cursor-pointer hover:bg-sunken/60 focus:bg-sunken/80 focus:outline-none focus-visible:shadow-[inset_3px_0_0_rgb(var(--fg))]',
                      selectedKey === k && 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--accent))]',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-3 align-middle', c.align === 'right' && 'text-right num', c.align === 'center' && 'text-center', c.hideBelow && hide[c.hideBelow], c.className)}>
                        {c.cell(row, i)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
      {!loading && rows && rows.length === 0 && (empty ?? <EmptyState compact title="Nothing to show" disc="aperture">Change the filters or the time range.</EmptyState>)}
    </div>
  );
}
