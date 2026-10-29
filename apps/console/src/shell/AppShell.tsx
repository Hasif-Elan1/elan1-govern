import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import { OctagonX } from 'lucide-react';
import { useUi } from '@/store/ui';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { api, db } from '@/api';
import { userName } from '@/mock/users';
import { relative } from '@/lib/format';
import { LEGAL_ENTITY } from '@/lib/company';
import { cn } from '@/lib/cn';
import { Button, Dialog, Kbd, Toaster, Disc, isModalOpen } from '@/components/ui';
import { Sidebar, useActiveTo } from './Sidebar';
import { TopBar, MobileNavSheet } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { StopDialog, stopCoverage } from './StopDialog';
import { AskPanel } from './AskPanel';
import { ALL_NAV, NAV_FOOT, doorHome, doorItems, doorsFor, navFor } from './nav';
import { ScreenGuard } from './access';
import { DoorBar } from './DoorBar';
import { useSessionLifetime } from '@/features/you/sessionLifetime';

/** Subscribe to the organisation's store so the shell's counts, level tags and the stop banner are always current. */
function useOrgVersion(orgId: string) {
  return useSyncExternalStore(
    (cb) => db.subscribe((o) => o === orgId && cb()),
    () => {
      const d = db.getDB(orgId);
      return `${d.receipts.length}:${d.stop.active}:${d.approvals.filter((a) => a.status === 'pending').length}:${d.alerts.filter((a) => a.status === 'open').length}`;
    },
  );
}

export function PageFallback() {
  return (
    <div className="flex items-center justify-center py-32" role="status" aria-live="polite">
      <Disc kind="orbit" size={40} title="Loading" />
    </div>
  );
}

export function AppShell() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const activeTo = useActiveTo();
  const loc = useLocation();
  const nav = useNavigate();
  useSessionLifetime();
  const version = useOrgVersion(orgId);
  const { liveUpdates, setCommandOpen, setShortcutsOpen, shortcutsOpen, singleKeyShortcuts, density } = useUi();
  const [stopOpen, setStopOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  const d = db.getDB(orgId);
  const orgLevel = useOrgLevel();
  const counts = useMemo(() => ({
    approvals: d.approvals.filter((a) => a.status === 'pending').length,
    alerts: d.alerts.filter((a) => a.status === 'open').length,
    suggestions: d.suggestions.filter((s) => s.status === 'open').length,
    refusals: 0,
    reviews: api.reviewsCount(orgId, user?.id),
  }), [d, version, orgId, user?.id]);

  // live traffic — paused for auditors (read-only review) and when the user turns it off
  useEffect(() => {
    if (!liveUpdates || role === 'auditor') { db.stopLive(); return; }
    db.startLive(orgId);
    return () => db.stopLive();
  }, [orgId, liveUpdates, role]);

  // a link with a #hash leaves the scroll to the target page, which scrolls to its anchor
  useEffect(() => { setMobileNav(false); if (!window.location.hash) window.scrollTo(0, 0); }, [loc.pathname]);
  // the tab title names the screen, so a title set by one page never lingers on the next
  useEffect(() => {
    const label = ALL_NAV.find((n) => n.to === activeTo)?.label;
    document.title = label ? `${label} · Elan1 Govern` : 'Elan1 Govern';
  }, [loc.pathname, activeTo]);

  // keyboard: Ctrl/Cmd+K palette, ? shortcuts, g + key navigation
  // Single-key shortcuts never fire behind an open dialog, drawer, sheet or the palette, and only reach
  // the screens this role can see in the navigation (the same filter as the sidebar and palette).
  useEffect(() => {
    let g = false;
    let gt: number | undefined;
    // the one rule (src/shell/nav.ts): role and the organisation's live level
    const doors = doorsFor(role, orgLevel);
    const items = navFor(role, orgLevel);
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.closest('.cm-editor');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCommandOpen(true); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !singleKeyShortcuts) return;
      const ui = useUi.getState();
      if (isModalOpen() || ui.commandOpen || document.querySelector('[role="dialog"][aria-modal="true"]')) { g = false; return; }
      if (e.key === '?') { e.preventDefault(); setShortcutsOpen(true); return; }
      if (e.key === '/') { e.preventDefault(); setCommandOpen(true); return; }
      if (g) {
        const door = doors.find((dd) => String(dd.number) === e.key);
        if (door) { g = false; e.preventDefault(); nav(doorHome(door, role, orgLevel)); return; }
        const hit = items.find((n) => n.shortcut === e.key.toLowerCase());
        g = false;
        if (hit) { e.preventDefault(); nav(hit.to); }
        return;
      }
      if (e.key.toLowerCase() === 'g') { g = true; window.clearTimeout(gt); gt = window.setTimeout(() => (g = false), 1200); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.clearTimeout(gt); };
  }, [nav, setCommandOpen, setShortcutsOpen, singleKeyShortcuts, role, orgLevel]);

  return (
    <div className={cn('flex min-h-screen', density === 'compact' && 'density-compact')}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-fg focus:text-canvas focus:px-3 focus:py-2">Skip to content</a>
      <Sidebar counts={counts} />
      <MobileNavSheet open={mobileNav} onClose={() => setMobileNav(false)}>
        <nav className="py-3">
          {doorsFor(role, orgLevel).map((g) => (
            <div key={g.label} className="mb-3">
              <p className="px-4 mb-1"><span className="num text-[10.5px] font-semibold text-ember mr-2">0{g.number}</span><span className="font-display font-semibold text-nav-fg">{g.label}</span><span className="block text-[11px] text-nav-muted/80">{g.question}</span></p>
              {doorItems(g, role, orgLevel).map((it) => (
                <Link key={it.to} to={it.to} aria-current={activeTo === it.to ? 'page' : undefined} className={cn('flex items-center gap-3 h-10 px-4 text-sm', activeTo === it.to ? 'bg-nav-hover text-nav-fg' : 'text-nav-muted')}>
                  <it.icon className="h-4 w-4" /><span className="flex-1">{it.label}</span>
                </Link>
              ))}
            </div>
          ))}
          <div className="border-t border-ink-700/70 pt-2">
            {NAV_FOOT.map((it) => (
              <Link key={it.to} to={it.to} aria-current={activeTo === it.to ? 'page' : undefined} className={cn('flex items-center gap-3 h-10 px-4 text-sm', activeTo === it.to ? 'bg-nav-hover text-nav-fg' : 'text-nav-muted')}>
                <it.icon className="h-4 w-4" /><span className="flex-1">{it.label}</span>
              </Link>
            ))}
          </div>
        </nav>
      </MobileNavSheet>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* the stop banner and the top bar stick together, so the banner never covers the top bar's controls */}
        <div className="sticky top-0 z-50">
          {d.stop.active && (
            <div role="alert" className="bg-bad text-white">
              <div className="flex flex-wrap items-center gap-3 px-4 lg:px-6 py-2.5 text-sm">
                <OctagonX className="h-4 w-4 shrink-0" aria-hidden />
                <span className="font-semibold">Emergency stop engaged</span>
                <span className="text-white/85">by {userName(d.stop.by)} {d.stop.since && relative(d.stop.since)} — {stopCoverage(d.stop).refused}. Reason: {d.stop.reason}</span>
                <Button size="sm" variant="inverse" className="ml-auto" onClick={() => nav(`/incidents/${d.stop.incidentId}`)}>Open the incident</Button>
              </div>
            </div>
          )}
          <TopBar onStop={() => setStopOpen(true)} onMobileNav={() => setMobileNav(true)} stopIncidentId={d.stop.active ? d.stop.incidentId ?? '' : undefined} />
        </div>
        <DoorBar counts={counts} />
        <main id="main" className="flex-1 px-4 lg:px-8 py-6 lg:py-8 w-full max-w-[1480px] mx-auto">
          <Suspense fallback={<PageFallback />}>
            {/* the route guard reads the same rules as the menu: 403 for a hidden screen, the plan page above the plan */}
            <ScreenGuard><Outlet /></ScreenGuard>
          </Suspense>
        </main>
        <footer className="px-4 lg:px-8 py-4 border-t border-line text-xs text-subtle flex flex-wrap gap-x-6 gap-y-1">
          <span>Elan1 Govern · {LEGAL_ENTITY}</span>
          <span>Signed as {user?.name}</span>
          <span className="ml-auto">Demonstration data — organisation and figures are seeded, not a customer's</span>
        </footer>
      </div>

      <CommandPalette onStop={() => setStopOpen(true)} stopIncidentId={d.stop.active ? d.stop.incidentId ?? '' : undefined} />
      <StopDialog open={stopOpen} onClose={() => setStopOpen(false)} />
      <AskPanel />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Toaster />
    </div>
  );
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { singleKeyShortcuts, setSingleKeyShortcuts } = useUi();
  const role = useRole();
  const level = useOrgLevel();
  const rows: [string, string[]][] = [
    ['Open the command palette', ['Ctrl', 'K']],
    ['Search', ['/']],
    ['Show this list', ['?']],
    ...doorsFor(role, level).map((dd) => [`Go to the ${dd.label} door`, ['G', String(dd.number)]] as [string, string[]]),
    ...navFor(role, level).filter((n) => n.shortcut).map((n) => [`Go to ${n.label}`, ['G', n.shortcut!.toUpperCase()]] as [string, string[]]),
    ['Approvals: next and previous', ['J', 'K']],
    ['Approvals: approve or reject the open item', ['A', 'R']],
    ['Approvals: commit the decision', ['Ctrl', 'Enter']],
    ['Tables: move between rows', ['↑', '↓']],
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description="Everything in the console can be done from the keyboard. Nothing irreversible has a single-key shortcut." size="md"
      footer={<Button variant="secondary" onClick={() => setSingleKeyShortcuts(!singleKeyShortcuts)}>{singleKeyShortcuts ? 'Turn off single-key shortcuts' : 'Turn on single-key shortcuts'}</Button>}>
      <div className="divide-y divide-line border-y border-line max-h-[50vh] overflow-y-auto">
        {rows.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between py-2 text-sm">
            <span>{label}</span>
            <span className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
