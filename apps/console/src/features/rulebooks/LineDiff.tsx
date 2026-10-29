import { Fragment, useMemo } from 'react';
import { cn } from '@/lib/cn';

type Op = { t: 'eq' | 'del' | 'add'; a?: string; b?: string; ai?: number; bi?: number };

/** Longest-common-subsequence line diff. Rulebooks are short, so O(n·m) is fine. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'eq', a: a[i], b: b[j], ai: i + 1, bi: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', a: a[i], ai: i + 1 }); i++; }
    else { out.push({ t: 'add', b: b[j], bi: j + 1 }); j++; }
  }
  while (i < n) { out.push({ t: 'del', a: a[i], ai: i + 1 }); i++; }
  while (j < m) { out.push({ t: 'add', b: b[j], bi: j + 1 }); j++; }
  return out;
}

interface SideRow { kind: 'eq' | 'change' | 'gap'; left?: { n: number; text: string; del: boolean }; right?: { n: number; text: string; add: boolean }; hidden?: number }

function sideBySide(ops: Op[]): SideRow[] {
  const rows: SideRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.t === 'eq') { rows.push({ kind: 'eq', left: { n: op.ai!, text: op.a!, del: false }, right: { n: op.bi!, text: op.b!, add: false } }); k++; continue; }
    const dels: Op[] = [], adds: Op[] = [];
    while (k < ops.length && ops[k].t !== 'eq') { (ops[k].t === 'del' ? dels : adds).push(ops[k]); k++; }
    for (let x = 0; x < Math.max(dels.length, adds.length); x++) {
      const d = dels[x], a = adds[x];
      rows.push({ kind: 'change', left: d ? { n: d.ai!, text: d.a!, del: true } : undefined, right: a ? { n: a.bi!, text: a.b!, add: true } : undefined });
    }
  }
  return rows;
}

function collapse<T extends { kind: string }>(rows: T[], context: number, make: (hidden: number) => T): T[] {
  const keep = rows.map(() => false);
  rows.forEach((r, i) => { if (r.kind !== 'eq') for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true; });
  const out: T[] = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (keep[i]) { if (hidden) { out.push(make(hidden)); hidden = 0; } out.push(r); }
    else hidden++;
  });
  if (hidden) out.push(make(hidden));
  return out;
}

// Diff colours: cobalt tint for added and clay tint for removed — never verdigris or crimson, which mean approved and refused.
const ADD = 'bg-info-bg';
const DEL = 'bg-clay-100/60 dark:bg-clay-900/40';

export function LineDiff({ before, after, leftLabel, rightLabel, showAll }: { before: string; after: string; leftLabel: string; rightLabel: string; showAll: boolean }) {
  const ops = useMemo(() => diffLines(before.split('\n'), after.split('\n')), [before, after]);
  const added = ops.filter((o) => o.t === 'add').length;
  const removed = ops.filter((o) => o.t === 'del').length;
  const side = useMemo(() => {
    const r = sideBySide(ops);
    return showAll ? r : collapse(r, 3, (hidden) => ({ kind: 'gap', hidden }) as SideRow);
  }, [ops, showAll]);
  const unified = useMemo(() => {
    const r = ops.map((o) => ({ ...o, kind: o.t === 'eq' ? 'eq' : 'change' }));
    return showAll ? r : collapse(r, 3, (hidden) => ({ t: 'eq' as const, kind: 'gap', hidden }) as typeof r[number] & { hidden?: number });
  }, [ops, showAll]);

  const cell = 'font-mono text-[12px] leading-[1.7] whitespace-pre-wrap break-all px-2 align-top';
  const num = 'font-mono text-[11px] text-subtle text-right select-none px-2 align-top w-10 num';

  return (
    <div className="border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 h-10 border-b border-line bg-sunken/60 text-xs">
        <span className="inline-flex items-center gap-1.5"><span className={cn('inline-flex h-4 w-4 items-center justify-center font-mono font-semibold text-info-fg border border-info/30', ADD)}>+</span>{added} {added === 1 ? 'line' : 'lines'} added</span>
        <span className="inline-flex items-center gap-1.5"><span className={cn('inline-flex h-4 w-4 items-center justify-center font-mono font-semibold text-accent-fg border border-accent/30', DEL)}>−</span>{removed} {removed === 1 ? 'line' : 'lines'} removed</span>
      </div>
      {added + removed === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">The two versions have identical YAML.</p>
      ) : (
        <>
          {/* side by side from md */}
          <div className="hidden md:block overflow-auto max-h-[640px]">
            <table className="w-full border-collapse table-fixed">
              <caption className="sr-only">Line diff of {leftLabel} and {rightLabel}</caption>
              <colgroup><col className="w-10" /><col className="w-5" /><col /><col className="w-10" /><col className="w-5" /><col /></colgroup>
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="border-b border-line">
                  <th colSpan={3} scope="col" className="label text-left px-3 h-8">{leftLabel}</th>
                  <th colSpan={3} scope="col" className="label text-left px-3 h-8 border-l border-line">{rightLabel}</th>
                </tr>
              </thead>
              <tbody>
                {side.map((r, i) => r.kind === 'gap' ? (
                  <tr key={i} className="bg-sunken/50"><td colSpan={6} className="px-3 py-1 text-xs text-muted">… {r.hidden} unchanged {r.hidden === 1 ? 'line' : 'lines'}</td></tr>
                ) : (
                  <tr key={i}>
                    <td className={cn(num, r.left?.del && DEL)}>{r.left?.n}</td>
                    <td className={cn('font-mono text-[12px] text-accent-fg text-center align-top', r.left?.del && DEL)} aria-label={r.left?.del ? 'removed' : undefined}>{r.left?.del ? '−' : ''}</td>
                    <td className={cn(cell, r.left?.del && DEL, !r.left && 'bg-sunken/40')}>{r.left?.text}</td>
                    <td className={cn(num, 'border-l border-line', r.right?.add && ADD)}>{r.right?.n}</td>
                    <td className={cn('font-mono text-[12px] text-info-fg text-center align-top', r.right?.add && ADD)} aria-label={r.right?.add ? 'added' : undefined}>{r.right?.add ? '+' : ''}</td>
                    <td className={cn(cell, r.right?.add && ADD, !r.right && 'bg-sunken/40')}>{r.right?.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* unified below md */}
          <div className="md:hidden overflow-auto max-h-[560px]">
            <table className="w-full border-collapse table-fixed">
              <caption className="sr-only">Unified line diff of {leftLabel} and {rightLabel}</caption>
              <colgroup><col className="w-9" /><col className="w-9" /><col className="w-5" /><col /></colgroup>
              <tbody>
                {unified.map((o, i) => (o as { kind: string }).kind === 'gap' ? (
                  <tr key={i} className="bg-sunken/50"><td colSpan={4} className="px-3 py-1 text-xs text-muted">… {(o as { hidden?: number }).hidden} unchanged lines</td></tr>
                ) : (
                  <Fragment key={i}>
                    <tr className={cn(o.t === 'add' && ADD, o.t === 'del' && DEL)}>
                      <td className={num}>{o.ai}</td>
                      <td className={num}>{o.bi}</td>
                      <td className={cn('font-mono text-[12px] text-center align-top', o.t === 'add' ? 'text-info-fg' : 'text-accent-fg')}>{o.t === 'add' ? '+' : o.t === 'del' ? '−' : ''}</td>
                      <td className={cell}>{o.t === 'add' ? o.b : o.a}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
