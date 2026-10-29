import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Moon, Sun, LogOut, User, Keyboard, Sparkles, OctagonX, Check, ChevronsUpDown, Settings, Menu as MenuIcon, Radio, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useOrgAccess, useOrgLevel, useRole, useSession, useUser } from '@/store/session';
import { LEVEL_INFO, levelOfOrg } from '@/lib/levels';
import { useUi, type Theme } from '@/store/ui';
import { api, db } from '@/api';
import { can } from '@/lib/permissions';
import { ROLE_INFO } from '@/lib/permissions';
import { Avatar, Button, IconButton, Kbd } from '@/components/ui/core';
import { Menu, useFocusTrap } from '@/components/ui/overlay';
import { Disc } from '@/components/ui/disc';
import { SmartLink } from './access';
import { canSeePath } from './nav';

/**
 * `stopIncidentId` is set while an emergency stop is engaged. The stop button then reads 'Stop is on' and opens
 * the stop's incident, where it is lifted: only one stop is open at a time, so it cannot be engaged twice.
 */
export function TopBar({ onStop, onMobileNav, stopIncidentId }: { onStop: () => void; onMobileNav: () => void; stopIncidentId?: string }) {
  const user = useUser();
  const role = useRole();
  const { orgId, switchOrg, signOut } = useSession();
  const { theme, setTheme, setCommandOpen, setShortcutsOpen, openAsk, liveUpdates, setLiveUpdates } = useUi();
  const dark = useResolvedDark(theme);
  const nav = useNavigate();
  const level = useOrgLevel();
  const stopOn = stopIncidentId !== undefined;
  const orgs = user ? api.orgs(user.orgIds) : [];
  const access = useOrgAccess(user?.orgIds ?? []);
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0];
  const multi = orgs.length > 1;
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  return (
    <header className="sticky top-0 z-40 h-14 bg-canvas/90 backdrop-blur border-b border-line flex items-center gap-3 px-4 lg:px-6">
      <IconButton className="md:hidden" label="Open navigation" onClick={onMobileNav}><MenuIcon className="h-5 w-5" /></IconButton>

      {/* organisation and environment */}
      <Menu
        align="left"
        width={320}
        trigger={({ toggle }) => (
          <button onClick={multi ? toggle : undefined} className={cn('flex items-center gap-2.5 h-9 pl-1 pr-2 min-w-0', multi && 'hover:bg-sunken')} aria-label={multi ? 'Switch organisation' : undefined}>
            <span className="inline-flex h-7 w-7 items-center justify-center bg-ink-800 text-paper text-[11px] font-semibold shrink-0">{org?.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>
            <span className="text-left min-w-0 hidden sm:block">
              <span className="flex items-center gap-2 min-w-0">
                <span className="block text-sm font-semibold leading-tight truncate max-w-[220px]">{org?.name}</span>
              </span>
              <span className="block text-[11px] text-muted leading-tight">{org?.deployment === 'sovereign' ? 'Own infrastructure' : 'Production'} · {org?.regions.join(', ')}</span>
            </span>
            {multi && <ChevronsUpDown className="h-3.5 w-3.5 text-muted" aria-hidden />}
          </button>
        )}
        items={[
          { heading: 'Client organisations' },
          ...orgs.map((o) => ({
            label: (
              <span className="flex items-center justify-between gap-2 w-full">
                <span className="min-w-0">
                  <span className="block truncate">{o.name}</span>
                  <span className="block text-[11px] text-muted">{LEVEL_INFO[levelOfOrg(o)].label}</span>
                </span>
                {o.id === orgId ? <Check className="h-3.5 w-3.5 shrink-0" aria-label="Current organisation" />
                  : access[o.id] && access[o.id] !== 'active' && <span className="shrink-0 border border-line-strong/60 px-1 text-[10.5px] font-medium leading-[16px] text-held-fg">{access[o.id] === 'suspended' ? 'Suspended' : 'Access ended'}</span>}
              </span>
            ),
            // a refused switch (suspended or removed there) stays where it is; switchOrg says why
            onSelect: () => { if (switchOrg(o.id) !== false) nav(user?.role === 'auditor' ? '/auditor' : '/'); },
          })),
        ]}
      />

      {/* the organisation's plan, on every page at every width; it follows an upgrade at once (live level) */}
      <SmartLink
        to="/assurance/levels"
        title={`This organisation's plan: ${LEVEL_INFO[level].label}`}
        className="shrink-0 inline-flex items-center h-6 border border-line-strong px-1.5 text-[11px] font-semibold leading-none text-fg whitespace-nowrap hover:border-fg"
        plainClassName="shrink-0 inline-flex items-center h-6 border border-line-strong px-1.5 text-[11px] font-semibold leading-none text-fg whitespace-nowrap"
      >
        <span className="sr-only">Plan: </span>{LEVEL_INFO[level].label}
      </SmartLink>

      <button
        onClick={() => setCommandOpen(true)}
        className="ml-2 hidden sm:flex items-center gap-2 h-9 flex-1 min-w-0 max-w-[440px] px-3 border border-line bg-surface text-sm text-subtle hover:border-line-strong transition-colors"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1 min-w-0 truncate text-left">Search, jump to a receipt or run a command</span>
        <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd><Kbd>K</Kbd>
      </button>
      <IconButton className="sm:hidden" label="Search" onClick={() => setCommandOpen(true)}><Search className="h-5 w-5" /></IconButton>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button onClick={() => setLiveUpdates(!liveUpdates)} title={liveUpdates ? 'Live updates on — click to pause' : 'Live updates paused'} className="hidden lg:inline-flex items-center gap-1.5 h-8 px-2 text-xs font-medium text-muted hover:text-fg hover:bg-sunken">
          <Radio className={cn('h-3.5 w-3.5', liveUpdates ? 'text-ok' : 'text-subtle')} aria-hidden />
          {liveUpdates ? 'Live' : 'Paused'}
        </button>
        <Button size="sm" variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => openAsk({ kind: 'general', title: 'Ask Govern' })} className="hidden xl:inline-flex">Ask Govern</Button>
        <IconButton className="hidden md:inline-flex xl:hidden" label="Ask Govern" onClick={() => openAsk({ kind: 'general', title: 'Ask Govern' })}><Sparkles className="h-[18px] w-[18px]" /></IconButton>
        {can(role, 'stop.engage') && (stopOn ? (
          <Button
            size="sm"
            variant="danger"
            icon={<OctagonX className="h-4 w-4" />}
            onClick={() => nav(stopIncidentId ? `/incidents/${stopIncidentId}` : '/incidents')}
            title="A stop is engaged. Only one stop is open at a time. Open its incident to lift it."
            aria-label="Stop is on. Open the incident to lift it"
          >
            <span className="hidden sm:inline">Stop is on · lift</span>
          </Button>
        ) : (
          <Button size="sm" variant="quiet-danger" icon={<OctagonX className="h-4 w-4" />} onClick={onStop} aria-label="Emergency stop">
            <span className="hidden sm:inline">Emergency stop</span>
          </Button>
        ))}
        <IconButton label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
          {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </IconButton>
        <Menu
          width={280}
          trigger={({ toggle }) => (
            <button onClick={toggle} className="flex items-center gap-2 h-9 pl-1 pr-1 hover:bg-sunken" aria-label="Account menu">
              <Avatar initials={user?.initials ?? '?'} size={30} />
            </button>
          )}
          items={[
            { heading: user ? `${user.name} · ${ROLE_INFO[role ?? user.role].label}` : '' },
            { label: 'Your preferences', icon: <User className="h-4 w-4" />, onSelect: () => nav('/you') },
            // only offered to the roles that can open it (owners and admins)
            ...(canSeePath('/agents/organisation', role, level) ? [{ label: 'Organisation (Agents door)', icon: <Settings className="h-4 w-4" />, onSelect: () => nav('/agents/organisation') }] : []),
            { label: 'Keyboard shortcuts', icon: <Keyboard className="h-4 w-4" />, hint: '?', onSelect: () => setShortcutsOpen(true) },
            { label: 'Reset demo data', icon: <RotateCcw className="h-4 w-4" />, onSelect: () => { if (window.confirm('Reset every demo organisation to its seeded state? Approvals, publishes and stops you made in this browser are cleared.')) db.resetDemo(); } },
            'sep',
            { label: 'Sign out', icon: <LogOut className="h-4 w-4" />, onSelect: () => { signOut(); nav('/login'); } },
          ]}
        />
      </div>
    </header>
  );
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Whether the page is dark right now: an explicit 'dark', or 'system' while the operating system is dark. */
export function useResolvedDark(theme: Theme): boolean {
  const osDark = useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia(DARK_QUERY);
      mq.addEventListener?.('change', cb);
      return () => mq.removeEventListener?.('change', cb);
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DARK_QUERY).matches),
  );
  return theme === 'dark' || (theme === 'system' && osDark);
}

/** The navigation sheet on narrow screens: a modal layer with Escape, a focus trap and a name. */
export function MobileNavSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden bg-ink-900/50" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Navigation" className="h-full w-[280px] bg-nav text-nav-fg overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="h-14 flex items-center justify-between px-4 border-b border-ink-700">
          <span className="flex items-center"><Disc kind="mark" size={22} /><span className="ml-2 font-display font-semibold">Elan1 Govern</span></span>
          <IconButton tone="nav" size="sm" label="Close navigation" onClick={onClose}><X className="h-4 w-4" /></IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
