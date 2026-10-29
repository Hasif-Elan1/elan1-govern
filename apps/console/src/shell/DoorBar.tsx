import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useOrgLevel, useRole } from '@/store/session';
import { doorFor, doorHome, doorItems, visibleTo } from './nav';

/**
 * The door bar: on every console page it names the door you are behind, the question that door answers,
 * and the door's screens. The grammar made visible — you always know which of the four doors you are in.
 */
export function DoorBar({ counts }: { counts: Record<string, number> }) {
  const loc = useLocation();
  const role = useRole();
  const orgLevel = useOrgLevel();
  const hit = doorFor(loc.pathname);
  const navRef = useRef<HTMLElement>(null);
  // on a narrow screen the tab strip scrolls: keep the current screen in view
  // (re-applied when the strip is laid out: it can be hidden while a lazy page loads)
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const apply = () => {
      const el = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!el || nav.scrollWidth <= nav.clientWidth) return;
      const a = el.getBoundingClientRect();
      const b = nav.getBoundingClientRect();
      if (a.left < b.left || a.right > b.right) nav.scrollLeft = Math.max(0, nav.scrollLeft + a.left - b.left - 16);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [loc.pathname, hit?.door.key]);
  if (!hit) return null;
  const { door, item } = hit;
  // a door the role cannot see (the Work door for auditors) shows no bar at all
  if (!visibleTo(door, role)) return null;
  // the one rule: role and the organisation's live level (src/shell/nav.ts)
  const items = doorItems(door, role, orgLevel);

  return (
    <div className="border-b border-line bg-surface">
      <div className="px-4 lg:px-8 max-w-[1480px] mx-auto flex flex-col lg:flex-row lg:items-center gap-x-6">
        <Link to={doorHome(door, role, orgLevel)} className="group flex items-baseline gap-2.5 pt-3 lg:py-0 shrink-0" aria-label={`${door.label} door — ${door.question}`}>
          <span className="num text-[11px] font-semibold text-accent-fg">0{door.number}</span>
          <span className="font-display text-[17px] font-semibold tracking-tightish group-hover:underline underline-offset-4">{door.label}</span>
          <span className="text-sm text-muted">{door.question}</span>
        </Link>
        <span className="hidden lg:block h-6 w-px bg-line" aria-hidden />
        <nav ref={navRef} aria-label={`${door.label} screens`} className="flex items-center gap-1 overflow-x-auto py-2 -mx-1 lg:mx-0 min-w-0">
          {items.map((it) => {
            const on = it.to === item?.to;
            const count = it.badge ? counts[it.badge] ?? 0 : 0;
            return (
              <Link
                key={it.to}
                to={it.to}
                aria-current={on ? 'page' : undefined}
                className={cn('relative inline-flex items-center gap-1.5 h-8 px-2.5 text-sm whitespace-nowrap transition-colors', on ? 'text-fg font-medium bg-sunken' : 'text-muted hover:text-fg hover:bg-sunken/70')}
              >
                <it.icon className="h-3.5 w-3.5" aria-hidden />
                {it.label}
                {count > 0 && <span className={cn('num text-[11px] font-semibold px-1', it.badge === 'alerts' ? 'bg-bad text-white' : 'bg-fg text-canvas')}>{count}</span>}
                <span className={cn('absolute inset-x-1 -bottom-2 h-[2px]', on ? 'bg-fg' : 'bg-transparent')} aria-hidden />
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
