import { Link, useLocation } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useUi } from '@/store/ui';
import { useOrgLevel, useRole } from '@/store/session';
import { ProductMark, Disc } from '@/components/ui/disc';
import { IconButton } from '@/components/ui/core';
import { ALL_NAV, NAV_FOOT, doorFor, doorHome, doorItems, doorsFor, type Door, type NavItem } from './nav';

export type NavCounts = { approvals: number; alerts: number; suggestions: number; refusals: number; reviews: number };

/** Small square tag naming the level a screen needs when the organisation is below it (L2, L3, SOV). */
export function LevelTag({ tag, tone = 'nav', className }: { tag: string; tone?: 'nav' | 'surface'; className?: string }) {
  return (
    <span
      title={`Starts at ${tag === 'SOV' ? 'Sovereign' : tag}. Open the screen to see what it adds and how to upgrade.`}
      className={cn('num text-[9px] font-semibold uppercase tracking-label px-1 leading-[14px] border', tone === 'nav' ? 'text-nav-muted/90 border-nav-muted/40' : 'text-subtle border-line-strong/60', className)}
    >
      {tag}
    </span>
  );
}

/** The screen a path belongs to — one per path, so detail pages (/agents/:slug, /records/:key) light their parent. */
export function useActiveTo(): string | undefined {
  const loc = useLocation();
  const hit = doorFor(loc.pathname);
  if (hit?.item) return hit.item.to;
  return ALL_NAV.find((n) => loc.pathname === n.to || loc.pathname.startsWith(n.to + '/'))?.to;
}

function NavRow({ it, collapsed, count, indent }: { it: NavItem; collapsed: boolean; count: number; indent?: boolean }) {
  const isActive = useActiveTo() === it.to;
  return (
    <li>
      <Link
        to={it.to}
        aria-current={isActive ? 'page' : undefined}
        title={collapsed ? it.label : undefined}
        className={cn(
          'group relative flex items-center gap-3 h-8 text-[13px] transition-colors',
          collapsed ? 'justify-center px-0' : indent ? 'pl-9 pr-3' : 'px-3',
          isActive ? 'bg-nav-hover text-nav-fg font-medium' : 'text-nav-muted hover:text-nav-fg hover:bg-nav-hover/60',
        )}
      >
        {(
          <>
            {/* clay rule marks the active screen — the shell's one accent */}
            <span className={cn('absolute left-0 top-0 bottom-0 w-[3px]', isActive ? 'bg-accent' : 'bg-transparent')} aria-hidden />
            <it.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
            {!collapsed && <span className="flex-1 truncate">{it.label}</span>}
            {count > 0 && (
              <span className={cn('num text-[11px] font-semibold min-w-[20px] h-[18px] px-1 inline-flex items-center justify-center', it.badge === 'alerts' ? 'bg-bad text-white' : 'bg-paper text-ink-800', collapsed && 'absolute top-0 right-1 min-w-[16px] h-[15px] text-[10px]')}>
                {count}
              </span>
            )}
          </>
        )}
      </Link>
    </li>
  );
}

/** One door: its number, name and question, then its screens. */
function DoorBlock({ door, collapsed, counts, current }: { door: Door; collapsed: boolean; counts: NavCounts; current: boolean }) {
  const role = useRole();
  const level = useOrgLevel();
  // the one rule: role and the organisation's live level (src/shell/nav.ts)
  const items = doorItems(door, role, level);
  const home = doorHome(door, role, level);
  return (
    <div className={cn('mb-2 pb-2', !collapsed && 'border-b border-ink-700/50 last:border-b-0')}>
      {collapsed ? (
        <Link to={home} title={`${door.label} — ${door.question}`} className={cn('mx-auto mb-1 mt-1 flex h-7 w-9 items-center justify-center text-[11px] font-semibold num border', current ? 'border-accent text-nav-fg' : 'border-ink-600 text-nav-muted hover:text-nav-fg')}>
          {door.number}
        </Link>
      ) : (
        <Link to={home} className="group block px-4 pt-3 pb-2" aria-label={`${door.label} door: ${door.question}`}>
          <span className="flex items-baseline gap-2">
            <span className={cn('num text-[10.5px] font-semibold tracking-label', current ? 'text-ember' : 'text-nav-muted/70')}>0{door.number}</span>
            <span className={cn('font-display text-[15px] font-semibold tracking-tightish', current ? 'text-nav-fg' : 'text-nav-fg/85 group-hover:text-nav-fg')}>{door.label}</span>
          </span>
          <span className="block pl-[26px] text-[11px] leading-snug text-nav-muted/80">{door.question}</span>
        </Link>
      )}
      <ul className="space-y-px">
        {items.map((it) => <NavRow key={it.to} it={it} collapsed={collapsed} count={it.badge ? counts[it.badge] : 0} />)}
      </ul>
    </div>
  );
}

export function Sidebar({ counts }: { counts: NavCounts }) {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  const loc = useLocation();
  const current = doorFor(loc.pathname)?.door.key;
  const role = useRole();
  const level = useOrgLevel();

  return (
    <aside className={cn('hidden md:flex flex-col bg-nav text-nav-fg shrink-0 h-screen sticky top-0 transition-[width] duration-200 ease-std', collapsed ? 'w-[60px]' : 'w-[248px]')} aria-label="The four doors">
      <div className={cn('flex items-center h-14 border-b border-ink-700/70 shrink-0', collapsed ? 'justify-center' : 'justify-between px-4')}>
        {collapsed ? <Disc kind="mark" size={26} title="Elan1 Govern" /> : <ProductMark inverse />}
        {!collapsed && <IconButton tone="nav" size="sm" label="Collapse navigation" onClick={toggle}><PanelLeftClose className="h-4 w-4" /></IconButton>}
      </div>
      <nav className="flex-1 overflow-y-auto py-1">
        {doorsFor(role, level).map((d) => <DoorBlock key={d.key} door={d} collapsed={collapsed} counts={counts} current={current === d.key} />)}
      </nav>
      <div className="border-t border-ink-700/70 py-2 shrink-0">
        <ul className="space-y-px">{NAV_FOOT.map((it) => <NavRow key={it.to} it={it} collapsed={collapsed} count={0} />)}</ul>
        {collapsed && (
          <div className="flex justify-center pt-1">
            <IconButton tone="nav" size="sm" label="Expand navigation" onClick={toggle}><PanelLeftOpen className="h-4 w-4" /></IconButton>
          </div>
        )}
        {!collapsed && <p className="px-4 pt-2 pb-1 text-[10.5px] text-nav-muted/70 leading-snug">Four doors, never a fifth. Decisions are made in code — no model sits on the decision path.</p>}
      </div>
    </aside>
  );
}
