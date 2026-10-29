import {
  LayoutDashboard, Inbox, Bot, BookCheck, Plug, ScrollText, ShieldCheck, Scale, Boxes, ClipboardCheck, Siren, LifeBuoy, Receipt, Layers,
  Briefcase, Code2, BadgeCheck, CircleSlash, BellRing, Network, KeyRound, Users, Building2, Gauge, Waypoints, FileDown, FolderSearch, Sparkles,
  ListChecks, Database, ShieldQuestion, FileCheck2, Package, Eraser, Server, Stamp, ScanSearch, Handshake, EyeOff, UserCheck, type LucideIcon,
} from 'lucide-react';
import { FileInput } from 'lucide-react';
import { Rocket } from 'lucide-react';
import { Megaphone as MegaphoneIcon } from 'lucide-react';
import { FilePen as FileSignatureIcon, FileStack as ScrollTextIcon } from 'lucide-react';
import type { LevelId, Role } from '@/types';
import { atLeast } from '@/lib/levels';

/* ── Who sees what: role lists used by the items below ─────────────────────────────────────────────── */
const ALL_ROLES: Role[] = ['owner', 'admin', 'approver', 'viewer', 'auditor'];
/** Owners and admins: administration screens. */
const STAFF: Role[] = ['owner', 'admin'];
/** Everyone who works the queues (the Work door): not auditors. */
const WORKERS: Role[] = ['owner', 'admin', 'approver', 'viewer'];
/** Read-only across the console, plus owners and admins: everyone but approvers. */
const READERS: Role[] = ['owner', 'admin', 'viewer', 'auditor'];
/** Owners, admins and auditors: evidence handed outside, keys and fingerprints. */
const EVIDENCE: Role[] = ['owner', 'admin', 'auditor'];

/**
 * The Four Doors — the console's grammar (Technology Memorandum §8.1).
 * "Every module presents the Four Doors and nothing else. There is no fifth door and no Settings tab
 * floating outside the grammar." Each door answers one question and admits one shape of content.
 * Organisation settings live inside the doors; personal preferences live in the account menu.
 */
export type DoorKey = 'work' | 'records' | 'agents' | 'assurance';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: 'approvals' | 'alerts' | 'suggestions' | 'refusals' | 'reviews';
  /** The roles that see this screen (menu, palette, shortcuts and the route guard). No list means everyone. */
  roles?: Role[];
  /** Kept for older imports; no screen is planned any more. */
  planned?: boolean;
  /**
   * The assurance level the screen is part of. Below it the screen is left out of the menu, the palette and the
   * shortcuts; typing its address shows owners the upgrade preview and everyone else "not part of this plan".
   */
  level?: Exclude<LevelId, 'l1'>;
  shortcut?: string; // g + key
  /** extra path prefixes that belong to this screen */
  also?: string[];
}

export interface Door {
  key: DoorKey;
  label: string;
  question: string;
  shapes: string;
  home: string;
  icon: LucideIcon;
  number: 1 | 2 | 3 | 4;
  items: NavItem[];
  roles?: Role[];
}

/** Kept for older imports: a door is a navigation group. */
export type NavGroup = Door;

export const DOORS: Door[] = [
  {
    // auditors never see the Work door: their home is the Auditor workspace
    key: 'work', number: 1, label: 'Work', icon: Inbox, home: '/', roles: WORKERS,
    question: 'What needs me now?',
    shapes: 'Queues — approvals, reviews, refusals to explain, alerts and incidents',
    items: [
      { to: '/', label: 'Today', icon: LayoutDashboard, shortcut: 't', roles: WORKERS },
      { to: '/approvals', label: 'Approvals', icon: Inbox, badge: 'approvals', shortcut: 'a', roles: WORKERS },
      { to: '/work/reviews', label: 'Reviews', icon: FileCheck2, badge: 'reviews', shortcut: 'v', roles: WORKERS },
      { to: '/work/approvers', label: 'Approvers', icon: UserCheck, roles: STAFF },
      { to: '/work/not-done', label: 'Not done', icon: CircleSlash, shortcut: 'd', roles: WORKERS },
      { to: '/alerts', label: 'Alerts', icon: Siren, badge: 'alerts', shortcut: 'l', roles: WORKERS },
      { to: '/incidents', label: 'Incidents', icon: LifeBuoy, shortcut: 'x', roles: WORKERS },
      { to: '/work/channels', label: 'Channels', icon: BellRing, roles: STAFF },
    ],
  },
  {
    key: 'records', number: 2, label: 'Records', icon: FolderSearch, home: '/records',
    question: 'What is the state of things?',
    shapes: 'Lists, forms and pinned fields — every record with its full timeline',
    items: [
      { to: '/records', label: 'Records', icon: FolderSearch, shortcut: 'o', roles: ALL_ROLES },
      { to: '/activity', label: 'Activity', icon: ScrollText, shortcut: 'y', roles: ALL_ROLES },
      { to: '/rulebooks', label: 'Rulebooks', icon: BookCheck, badge: 'suggestions', shortcut: 'r', roles: ALL_ROLES },
      { to: '/connectors', label: 'Connectors', icon: Plug, shortcut: 'n', roles: ['owner', 'admin', 'viewer'] },
      { to: '/inventory', label: 'AI inventory', icon: Boxes, shortcut: 'i', roles: ALL_ROLES },
      { to: '/assessments', label: 'Assessments', icon: ClipboardCheck, shortcut: 's', roles: ALL_ROLES },
      // packs install from L1 as a dry run (no regulatory claim until L2); erasure works from L1 (decisions 5, 6c)
      { to: '/records/packs', label: 'Regulatory packs', icon: Package, roles: READERS },
      { to: '/records/erasure', label: 'Erasure', icon: Eraser, roles: READERS },
      // records area: the DPDP consent ledger and declaration versions (both from L1)
      { to: '/records/consent', label: 'Consent ledger', icon: FileSignatureIcon, roles: READERS },
      { to: '/records/declarations', label: 'Declarations', icon: ScrollTextIcon, roles: READERS },
    ],
  },
  {
    key: 'agents', number: 3, label: 'Agents', icon: Bot, home: '/agents',
    question: 'Who and what is acting here?',
    shapes: 'Agents, people, keys, autonomy and where it all runs',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot, shortcut: 'g', roles: ALL_ROLES },
      { to: '/agents/map', label: 'Agent map', icon: Network, roles: ALL_ROLES },
      { to: '/agents/autonomy', label: 'Autonomy', icon: Gauge, level: 'l3', roles: ALL_ROLES },
      // auditors read public keys and fingerprints; viewers and approvers do not see keys
      { to: '/agents/keys', label: 'Keys', icon: KeyRound, shortcut: 'k', roles: EVIDENCE },
      { to: '/agents/people', label: 'People and roles', icon: Users, shortcut: 'p', roles: STAFF },
      { to: '/agents/organisation', label: 'Organisation', icon: Building2, roles: STAFF },
      { to: '/agents/deployment', label: 'Deployment', icon: Server, roles: STAFF },
      { to: '/agents/production', label: 'Path to production', icon: Rocket, roles: STAFF },
      { to: '/agents/notices', label: 'Notices from Elan1', icon: MegaphoneIcon, roles: STAFF },
    ],
  },
  {
    key: 'assurance', number: 4, label: 'Assurance', icon: ShieldCheck, home: '/assurance',
    question: 'Can I show someone this was done properly?',
    shapes: 'Chain standing, timestamps, refusals, coverage, profiles, counterparties, meter and exports',
    items: [
      // the auditor's home; owners and admins see every item, so they can open it too (with their own role's permissions)
      { to: '/auditor', label: 'Auditor workspace', icon: Briefcase, roles: EVIDENCE, shortcut: 'w' },
      { to: '/assurance', label: 'Overview', icon: ShieldQuestion, shortcut: 'u', roles: READERS },
      { to: '/evidence', label: 'Proof', icon: ShieldCheck, shortcut: 'e', roles: READERS },
      { to: '/activity/chain', label: 'Chain', icon: Waypoints, roles: READERS },
      { to: '/assurance/anchors', label: 'Timestamps', icon: Stamp, level: 'l2', roles: READERS },
      { to: '/assurance/refusals', label: 'Refusals', icon: ListChecks, shortcut: 'f', roles: ALL_ROLES },
      { to: '/compliance', label: 'Coverage', icon: Scale, shortcut: 'c', roles: READERS },
      { to: '/assurance/profiles', label: 'Verifier profiles', icon: ScanSearch, level: 'l2', roles: READERS },
      // the register works from L1 (read-only below L3); issuing and verifying receipts, seats and portals stay L3 (decision 6d)
      { to: '/assurance/counterparties', label: 'Counterparties', icon: Handshake, roles: READERS },
      { to: '/assurance/disclosure', label: 'Disclosure', icon: EyeOff, level: 'l3', roles: READERS },
      { to: '/billing', label: 'Meter', icon: Receipt, roles: STAFF, shortcut: 'b' },
      { to: '/assurance/exports', label: 'Exports', icon: FileDown, roles: EVIDENCE },
      { to: '/assurance/evidence-requests', label: 'Evidence requests', icon: FileInput, roles: EVIDENCE },
      { to: '/assurance/levels', label: 'Assurance levels', icon: Layers, also: ['/assurance/upgrade'], roles: READERS },
    ],
  },
];

export const NAV = DOORS;

export const NAV_FOOT: NavItem[] = [
  { to: '/developers', label: 'Developers', icon: Code2 },
  { to: '/verify', label: 'Verify a receipt', icon: BadgeCheck },
];

/** Personal pages reached from the account menu — not a door. */
export const PERSONAL: NavItem[] = [{ to: '/you', label: 'Your preferences', icon: Sparkles, shortcut: ',' }];

export const ALL_NAV = [...DOORS.flatMap((d) => d.items), ...PERSONAL, ...NAV_FOOT];

/* ── The one visibility rule ────────────────────────────────────────────────────────────────────────
 * Every consumer (sidebar, door bar, mobile menu, command palette, keyboard shortcuts, route guard, SmartLink)
 * reads these functions, so the menu and the address bar never disagree.
 *   role:  NavItem.roles (no list = everyone)
 *   plan:  NavItem.level (the screen is part of the organisation's plan from that level)
 */

/** Whether a role may see a nav item or door (no `roles` means everyone). Role only — the plan is not read. */
export function visibleTo(entry: { roles?: Role[] }, role: Role | undefined): boolean {
  return !entry.roles || (!!role && entry.roles.includes(role));
}

/** Whether the organisation's level includes a screen (no `level` means every level). */
export function inPlan(entry: { level?: LevelId }, level: LevelId | undefined): boolean {
  return !entry.level || atLeast(level ?? 'l1', entry.level);
}

/** Whether a screen appears for this role at this level. */
export function canSee(item: Pick<NavItem, 'roles' | 'level'>, role: Role | undefined, level: LevelId | undefined): boolean {
  return visibleTo(item, role) && inPlan(item, level);
}

/** A door's screens for this role and level. */
export function doorItems(door: Door, role: Role | undefined, level?: LevelId): NavItem[] {
  return door.items.filter((it) => (level === undefined ? visibleTo(it, role) : canSee(it, role, level)));
}

/** The doors a role can see (a door with no screen left for this role and level is left out). */
export function doorsFor(role: Role | undefined, level?: LevelId): Door[] {
  return DOORS.filter((d) => visibleTo(d, role) && doorItems(d, role, level).length > 0);
}

/** Where a door opens for this role: its home when visible, otherwise its first visible screen. */
export function doorHome(door: Door, role: Role | undefined, level?: LevelId): string {
  const items = doorItems(door, role, level);
  return items.some((it) => it.to === door.home) ? door.home : items[0]?.to ?? door.home;
}

/**
 * Every screen a role can reach from the navigation at this level: the same filter the sidebar, door bar and
 * palette apply. Keyboard shortcuts and the shortcuts list use it so they never advertise or open a hidden screen.
 */
export function navFor(role: Role | undefined, level?: LevelId): NavItem[] {
  return [...doorsFor(role, level).flatMap((d) => doorItems(d, role, level)), ...PERSONAL, ...NAV_FOOT];
}

/** The landing page for a role: auditors land on the Auditor workspace, everyone else on Today. */
export function homeFor(role: Role | undefined): string {
  return role === 'auditor' ? '/auditor' : '/';
}

/** The menu screen an address belongs to (detail pages resolve to their parent screen), if any. */
export function screenFor(pathname: string): NavItem | undefined {
  const path = (pathname.split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/';
  return doorFor(path)?.item;
}

/** Why an address can or cannot be opened: 'ok', 'role' (the role cannot see it) or 'plan' (above the organisation's level). */
export type ScreenAccess = 'ok' | 'role' | 'plan';

export function accessFor(pathname: string, role: Role | undefined, level: LevelId | undefined): ScreenAccess {
  const path = (pathname.split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/';
  // personal pages, the footer and pages outside the doors (403, /you, /settings redirects) are open to everyone
  if (PERSONAL.concat(NAV_FOOT).some((n) => path === n.to || path.startsWith(n.to + '/'))) return 'ok';
  const hit = doorFor(path);
  if (!hit) return 'ok';
  if (!visibleTo(hit.door, role)) return 'role';
  if (!hit.item) return 'ok';
  if (!visibleTo(hit.item, role)) return 'role';
  if (!inPlan(hit.item, level)) return 'plan';
  return 'ok';
}

/** Whether this role at this level may open an address (menu screens and their detail pages). */
export function canSeePath(pathname: string, role: Role | undefined, level: LevelId | undefined): boolean {
  return accessFor(pathname, role, level) === 'ok';
}

/** Which door a path belongs to. Longest matching screen wins; record pages fall back by prefix. */
export function doorFor(pathname: string): { door: Door; item?: NavItem } | undefined {
  let best: { door: Door; item: NavItem; len: number } | undefined;
  for (const door of DOORS) {
    for (const item of door.items) {
      const prefixes = [item.to, ...(item.also ?? [])];
      for (const p of prefixes) {
        const hit = p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(p + '/');
        if (hit && (!best || p.length > best.len)) best = { door, item, len: p.length };
      }
    }
  }
  if (best) return { door: best.door, item: best.item };
  if (pathname.startsWith('/work')) return { door: DOORS[0] };
  if (pathname.startsWith('/records')) return { door: DOORS[1] };
  return undefined;
}

/**
 * Kept for older imports. The menu no longer tags screens with a level: a screen above the organisation's
 * plan is left out of the menu altogether, so there is never a tag to show.
 */
export function levelTagFor(_item: Pick<NavItem, 'level'>, _orgLevel: LevelId | undefined): string | undefined {
  return undefined;
}

/** Where the retired Settings sections now live. */
export const SETTINGS_REDIRECTS: Record<string, string> = {
  '': '/agents/organisation',
  organisation: '/agents/organisation',
  sso: '/agents/organisation?tab=sso',
  sessions: '/agents/organisation?tab=sessions',
  members: '/agents/people',
  roles: '/agents/people?tab=roles',
  'api-keys': '/agents/keys',
  'signing-keys': '/agents/keys?tab=signing',
  notifications: '/work/channels',
  webhooks: '/assurance/exports?tab=webhooks',
  data: '/assurance/exports?tab=data',
  preferences: '/you',
};

export { Database };
