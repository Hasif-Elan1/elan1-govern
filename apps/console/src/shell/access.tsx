/**
 * The visibility layer every screen shares: what the signed-in role and the organisation's plan (assurance level)
 * let a person see. It reads the same rules as the menu (src/shell/nav.ts), so a link, a button and the address
 * bar never disagree with the sidebar.
 *
 *   useScreenAccess()   role, level, isOwner, canSee(path), can(perm), hasLevel(level)
 *   <IfCan perm>        children only when the role holds the permission (hidden, never greyed out)
 *   <OnlyIf when>       children only when a condition holds (role list, level, path or a plain boolean)
 *   <SmartLink to>      a link when the target is visible to this role and plan, plain text otherwise
 *   <PlanUpsell to>     the one compact line owners see where a feature starts at a higher level; nothing for anyone else
 *   <ScreenGuard>       the route guard: 403 for a hidden screen, the plan page for a screen above the plan
 */
import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Layers } from 'lucide-react';
import type { LevelId, Role } from '@/types';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { roleHas, type AnyPermission } from '@/features/settings/permissions';
import { useOrgLevel, useRole } from '@/store/session';
import { accessFor, canSeePath, homeFor, screenFor } from './nav';

/* ── The hook ──────────────────────────────────────────────────────────────────────────────────────── */

export interface ScreenAccess {
  role: Role | undefined;
  /** The organisation's live level: re-renders when an owner changes the plan. */
  level: LevelId;
  isOwner: boolean;
  /** Owners and admins. */
  isStaff: boolean;
  /** Whether this role at this level may open an address (menu screens and their detail pages). */
  canSee: (path: string) => boolean;
  /** Whether the role holds a permission (base or level permission). Never changes the rules in lib/permissions.ts. */
  can: (perm: AnyPermission) => boolean;
  /** Whether the organisation's plan includes a level. */
  hasLevel: (level: LevelId) => boolean;
}

export function useScreenAccess(): ScreenAccess {
  const role = useRole();
  const level = useOrgLevel();
  return useMemo(() => ({
    role,
    level,
    isOwner: role === 'owner',
    isStaff: role === 'owner' || role === 'admin',
    canSee: (path: string) => canSeePath(path, role, level),
    can: (perm: AnyPermission) => roleHas(role, perm),
    hasLevel: (to: LevelId) => atLeast(level, to),
  }), [role, level]);
}

/** Whether this role at this level may open an address. */
export function useCanSee(path: string): boolean {
  return canSeePath(path, useRole(), useOrgLevel());
}

/* ── Show or hide ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Children only when the role holds the permission. Use it for action buttons, menus and forms: a role without
 * the permission sees nothing (not a disabled control). `fallback` renders instead, for a read-only line.
 */
export function IfCan({ perm, children, fallback = null }: { perm: AnyPermission; children: ReactNode; fallback?: ReactNode }) {
  const role = useRole();
  return <>{roleHas(role, perm) ? children : fallback}</>;
}

/**
 * Children only when every condition given holds:
 *   roles   the role is one of these
 *   level   the organisation's plan includes this level
 *   path    the role and plan can open this address
 *   when    a plain boolean
 */
export function OnlyIf({ roles, level, path, when = true, children, fallback = null }: {
  roles?: Role[]; level?: LevelId; path?: string; when?: boolean; children: ReactNode; fallback?: ReactNode;
}) {
  const a = useScreenAccess();
  const ok = when
    && (!roles || (!!a.role && roles.includes(a.role)))
    && (!level || a.hasLevel(level))
    && (!path || a.canSee(path));
  return <>{ok ? children : fallback}</>;
}

/** Owners only (the people who can change the plan and billing). */
export function OwnerOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return <OnlyIf roles={['owner']} fallback={fallback}>{children}</OnlyIf>;
}

/**
 * A link that is only a link when its target is visible to this role and plan. Otherwise the children render as
 * plain text (or nothing with `hideWhenBlocked`), so no link leads to a 403 or a screen the plan does not include.
 */
export function SmartLink({ to, children, hideWhenBlocked, plainClassName, ...rest }: ComponentProps<typeof Link> & { hideWhenBlocked?: boolean; plainClassName?: string }) {
  const ok = useCanSee(typeof to === 'string' ? to : (to.pathname ?? '/'));
  if (ok) return <Link to={to} {...rest}>{children}</Link>;
  if (hideWhenBlocked) return null;
  return <span className={plainClassName}>{children}</span>;
}

/* ── Plan prompts ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Set by the route guard while an owner opens a screen above the organisation's plan: inside it the shared upgrade
 * components render their full preview (the existing upgrade page). Everywhere else they collapse to PlanUpsell.
 */
const FullPreviewContext = createContext(false);

export function FullPreviewScope({ children }: { children: ReactNode }) {
  return <FullPreviewContext.Provider value>{children}</FullPreviewContext.Provider>;
}

/** True only while an owner is on a screen above the plan (see FullPreviewScope). */
export function useFullPreview(): boolean {
  return useContext(FullPreviewContext);
}

/** "L1 Guarded" */
export function planName(level: LevelId): string {
  return `${LEVEL_INFO[level].tag} ${LEVEL_INFO[level].name}`;
}

/**
 * The one line an owner sees where a feature starts at a higher level than the organisation's plan, linking to
 * Assurance levels. Admins, approvers, viewers and auditors see nothing. Nothing either when the plan includes it.
 */
export function PlanUpsell({ to, what, className }: { to: LevelId; what?: ReactNode; className?: string }) {
  const role = useRole();
  const level = useOrgLevel();
  if (role !== 'owner' || atLeast(level, to)) return null;
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted', className)}>
      <span className="inline-flex h-[18px] items-center border border-line-strong/60 px-1 font-mono text-[10.5px] font-semibold text-fg">{LEVEL_INFO[to].tag}</span>
      <span className="min-w-0">{what ?? `Part of ${LEVEL_INFO[to].label}`}</span>
      <span aria-hidden>·</span>
      <Link to="/assurance/levels" className="link inline-flex items-center gap-0.5 whitespace-nowrap">Change plan<ArrowUpRight className="h-3 w-3" aria-hidden /></Link>
    </p>
  );
}

/** A short text for PlanUpsell from a prompt's title or children: strings only, trimmed to one sentence. */
export function upsellText(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const first = c.trim().split('. ')[0].replace(/\.$/, '');
      return first.length > 90 ? first.slice(0, 88).trimEnd() + '…' : first + '.';
    }
  }
  return undefined;
}

/* ── The route guard ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Wraps every console page (AppShell's outlet). It reads the same rules as the menu:
 *   auditor on Today            → /auditor (the auditor's home)
 *   a screen the role cannot see → /403 ("Your role cannot open this")
 *   a screen above the plan     → owners see the screen's upgrade preview; other roles see NotInPlanPage
 */
export function ScreenGuard({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const role = useRole();
  const level = useOrgLevel();
  // the role is read from the member record; until it is known the page decides for itself
  if (!role) return <>{children}</>;
  if (role === 'auditor' && (loc.pathname === '/' || loc.pathname === '')) return <Navigate to={homeFor(role)} replace />;
  const access = accessFor(loc.pathname, role, level);
  if (access === 'role') {
    const item = screenFor(loc.pathname);
    const q = new URLSearchParams();
    if (item?.roles) q.set('roles', item.roles.join(','));
    if (item) q.set('what', item.label);
    q.set('from', loc.pathname + loc.search);
    return <Navigate to={`/403?${q.toString()}`} replace />;
  }
  if (access === 'plan') {
    if (role === 'owner') return <FullPreviewScope>{children}</FullPreviewScope>;
    return <NotInPlanPage />;
  }
  return <>{children}</>;
}

/** The short page other roles see at the address of a screen the organisation's plan does not include. */
export function NotInPlanPage() {
  const loc = useLocation();
  const role = useRole();
  const level = useOrgLevel();
  const item = screenFor(loc.pathname);
  const home = homeFor(role);
  return (
    <div className="min-h-[50vh] grid place-items-center py-10">
      <div className="w-full max-w-[560px] border border-line bg-surface p-6">
        <p className="label flex items-center gap-2"><Layers className="h-3.5 w-3.5" aria-hidden />{item?.label ?? 'This screen'}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tighter2">Not part of this organisation’s plan ({planName(level)}). Ask an owner.</h1>
        {item?.level && <p className="mt-2 text-sm text-muted">{item.label} is part of {LEVEL_INFO[item.level].label}. Only an owner can change the plan.</p>}
        <Link to={home} className="mt-5 inline-flex items-center gap-1.5 h-9 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">
          <ArrowLeft className="h-4 w-4" aria-hidden />{home === '/' ? 'Back to Today' : 'Back to the Auditor workspace'}
        </Link>
      </div>
    </div>
  );
}
