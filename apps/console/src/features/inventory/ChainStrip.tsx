import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CircleDashed } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useScreenAccess } from '@/shell/access';

export interface ChainNode {
  key: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  to?: string;
  state: 'ok' | 'warn' | 'missing';
}

/**
 * "Connecting the dots": one horizontal strip from the AI system to the evidence on the chain.
 * Each node opens the object it names; a missing link is drawn dashed and says what is missing.
 */
export function ChainStrip({ nodes: all }: { nodes: ChainNode[] }) {
  const a = useScreenAccess();
  // a node opens its screen only when this role and plan can open it; otherwise it is read as plain text
  const nodes = all.map((n) => (n.to && !n.to.startsWith('#') && !a.canSee(n.to) ? { ...n, to: undefined } : n));
  return (
    <nav aria-label="Governance chain for this system" className="-mx-1 overflow-x-auto pb-1">
      <ol className="flex items-stretch w-full min-w-max xl:min-w-0 px-1">
        {nodes.map((n, i) => {
          const body = (
            <div className={cn(
              'h-full w-[152px] xl:w-full px-3 py-3 border transition-colors flex flex-col',
              n.state === 'missing' ? 'border-dashed border-line-strong/70 bg-canvas' : 'border-line bg-surface',
              n.to && 'group-hover:border-fg',
              n.state === 'warn' && 'shadow-[inset_0_3px_0_rgb(var(--held))]',
              n.state === 'ok' && i === 0 && 'shadow-[inset_0_3px_0_rgb(var(--accent))]',
            )}>
              <p className="label flex items-center gap-1.5">
                <span className="num text-subtle">{String(i + 1).padStart(2, '0')}</span>
                {n.label}
              </p>
              <div className={cn('mt-2 text-sm font-medium min-w-0', n.state === 'missing' && 'text-muted')}>
                {n.state === 'missing' && typeof n.value === 'string' && <CircleDashed className="inline h-3.5 w-3.5 mr-1 -mt-0.5 text-subtle" aria-hidden />}
                {n.value}
              </div>
              {n.sub && <div className="mt-1 text-xs text-muted leading-snug">{n.sub}</div>}
            </div>
          );
          return (
            <li key={n.key} className="flex items-stretch xl:flex-1 xl:min-w-0">
              <div className="xl:flex-1 xl:min-w-0">
                {n.to?.startsWith('#')
                  ? <a href={n.to} className="group block h-full focus-visible:outline-offset-2">{body}</a>
                  : n.to ? <Link to={n.to} className="group block h-full focus-visible:outline-offset-2">{body}</Link> : body}
              </div>
              {i < nodes.length - 1 && (
                <span className="flex items-center px-1 text-subtle" aria-hidden>
                  <span className="h-px w-2 bg-line-strong/70" />
                  <ChevronRight className="h-3.5 w-3.5 -ml-1" />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
