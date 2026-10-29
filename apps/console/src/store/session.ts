import { useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { LevelId, Role, User } from '@/types';
import { api, db } from '@/api';
import { ORGS, userById } from '@/mock/users';
import { can as canRole, type Permission } from '@/lib/permissions';
import { hasCapability } from '@/lib/levels';
import type { CapabilityId } from '@/types';
import type { OrgDB } from '@/mock/db';
import type { SessionRecord } from '@/mock/orgSettings';
import { toast } from '@/components/ui/overlay';
import { LIVE } from '@/api/mode';
import { consoleUser, fetchMe, login as liveLogin, logout as liveLogout, selectOrg, type MeMembership } from '@/api/live/session';
import { applySelf, isLoaded, loadOrg, resync, stopStream } from '@/api/live/sync';

interface SessionState {
  user?: User;
  orgId: string;
  /** When this browser signed in. Fixed for the whole session: it starts the session lifetime and names the session record. */
  signedInAt?: number;
  /**
   * The organisation whose session list holds this browser's session record and whose chain carries auth.signed_in.
   * It stays put when the person switches organisation, so sign-out ends that record and writes auth.signed_out on
   * the same chain. Optional: a session saved before this field existed falls back to a search of the open organisations.
   */
  sessionOrgId?: string;
  /** When the person last re-entered their password (the 10-minute re-authentication rule). Never extends the session. */
  reauthAt?: number;
  signIn: (email: string, password: string) => Promise<User>;
  /**
   * Sign this browser out. The session record in Sessions is ended and an auth.signed_out receipt is written,
   * unless the session was already ended elsewhere (lifetime, suspension, reset, another device).
   * Pass a reason to name why (shown in Sessions and on the receipt).
   */
  signOut: (opts?: SignOutOptions) => void;
  /** Open another of the person's organisations. Refused (returns false) where they hold no active membership. */
  switchOrg: (orgId: string) => boolean | void;
  /** Live builds: every organisation the person belongs to, as GET /api/me lists them (suspended ones included). */
  memberships?: MeMembership[];
}

export interface SignOutOptions { reason?: string }

type Stored = Pick<SessionState, 'user' | 'orgId' | 'signedInAt' | 'sessionOrgId' | 'reauthAt'>;

const KEY = 'eg:session';

function load(): Stored {
  // live: the server's session is the truth; nothing about it is kept in this browser (see refreshLiveSession)
  if (LIVE) return { orgId: 'org_demo' };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Stored;
      // refresh the stored user from the directory (memberships change, e.g. an auditor's client list)
      const fresh = s.user ? userById(s.user.id) : undefined;
      if (fresh) s.user = { ...fresh };
      if (s.user && !s.user.orgIds.includes(s.orgId)) s.orgId = s.user.orgIds[0];
      return s;
    }
  } catch { /* storage unavailable */ }
  return { orgId: 'org_demo' };
}

function save(s: Stored) {
  if (LIVE) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ user: s.user, orgId: s.orgId, signedInAt: s.signedInAt, sessionOrgId: s.sessionOrgId, reauthAt: s.reauthAt }));
  } catch { /* fine */ }
}

export const useSession = create<SessionState>((set, get) => ({
  ...load(),
  async signIn(email, password) {
    if (LIVE) {
      await liveLogin(email, password);
      const u = await refreshLiveSession();
      if (!u) throw new Error('Sign in to continue.');
      return u;
    }
    const user = await api.signIn(email, password);
    // open the first organisation where the person is an active member, with the role that membership holds
    const orgId = user.orgIds.find((o) => !!db.memberRole(o, user.id)) ?? user.orgIds[0];
    const role = db.memberRole(orgId, user.id) ?? user.role;
    const next = { user: { ...user, role }, orgId, signedInAt: Date.now(), sessionOrgId: orgId, reauthAt: undefined };
    set(next);
    save(next);
    return next.user;
  },
  signOut(opts) {
    const s = get();
    // an onClick handler passed straight through hands over a click event: only a plain { reason } counts
    const reason = opts && typeof opts === 'object' && typeof (opts as SignOutOptions).reason === 'string' ? (opts as SignOutOptions).reason! : 'Signed out';
    if (LIVE) {
      // the server ends the session; the page then starts again, so nothing of it stays in this tab's memory
      set({ user: undefined, signedInAt: undefined, sessionOrgId: undefined, reauthAt: undefined, memberships: undefined });
      stopStream();
      void liveLogout().finally(() => window.location.replace('/login'));
      return;
    }
    if (s.user && s.signedInAt) endSessionRecords(s.sessionOrgId, s.orgId, s.user.id, s.signedInAt, reason);
    set({ user: undefined, signedInAt: undefined, sessionOrgId: undefined, reauthAt: undefined });
    save({ orgId: s.orgId });
  },
  switchOrg(orgId) {
    const s = get();
    if (LIVE) return switchLiveOrg(orgId);
    // a person suspended or removed in one organisation keeps the others: that one is not opened
    if (s.user && orgId !== s.orgId && s.user.orgIds.includes(orgId)) {
      let role: Role | undefined;
      try { role = db.memberRole(orgId, s.user.id); } catch { role = undefined; }
      if (!role) {
        const name = db.peekDB(orgId)?.org.name ?? 'That organisation';
        const suspended = db.peekDB(orgId)?.members.find((m) => m.userId === s.user!.id)?.status === 'suspended';
        toast.held(`${name} is not open to you`, suspended ? 'Your access there is suspended. Your other organisations are unaffected. An owner or admin there can reinstate you.' : 'You are no longer a member there.');
        return false;
      }
    }
    set({ orgId });
    save({ ...get(), orgId });
    syncMembership();
    return true;
  },
}));

/** This browser's session record (ses_<user>_<signedInAt>) in an organisation, when that organisation is open and holds one. */
export function sessionRecordIn(orgId: string, userId: string, signedInAt: number): SessionRecord | undefined {
  const d = db.peekDB(orgId) as (OrgDB & { orgSettings?: { sessions: SessionRecord[] } }) | undefined;
  return d?.orgSettings?.sessions.find((x) => x.id === `ses_${userId}_${signedInAt}`);
}

/**
 * The organisation that holds this browser's session record: the one it signed in to. A session saved before the
 * sign-in organisation was kept falls back to the open organisation holding the record (the current one first).
 */
export function sessionHomeOrg(s: Pick<SessionState, 'user' | 'orgId' | 'signedInAt' | 'sessionOrgId'> = useSession.getState()): string {
  if (s.sessionOrgId) return s.sessionOrgId;
  if (!s.user || !s.signedInAt) return s.orgId;
  if (sessionRecordIn(s.orgId, s.user.id, s.signedInAt)) return s.orgId;
  return db.orgIds().find((o) => !!sessionRecordIn(o, s.user!.id, s.signedInAt!)) ?? s.orgId;
}

/**
 * End this browser's session and write auth.signed_out on the chain of the organisation it signed in to — the
 * same chain as its auth.signed_in — whichever organisation is open now. The record there is ended; nothing is
 * written there when it was already ended (by the session lifetime, a suspension, a password reset or another
 * device). Any other organisation that listed this session (opened after a switch) has its record ended too, with
 * its own auth.signed_out naming the sign-in organisation, so no organisation keeps a live entry for it.
 */
function endSessionRecords(sessionOrgId: string | undefined, currentOrgId: string, userId: string, signedInAt: number, reason: string) {
  const id = `ses_${userId}_${signedInAt}`;
  const home = sessionHomeOrg({ user: { id: userId } as User, orgId: currentOrgId, signedInAt, sessionOrgId });
  const homeName = db.peekDB(home)?.org.name ?? home;
  const now = Date.now();
  const minutes = Math.max(0, Math.round((now - signedInAt) / 60_000));
  const end = (orgId: string, ses: SessionRecord | undefined, extra: Record<string, string>) => {
    if (ses) { ses.endedAt = new Date(now).toISOString(); ses.endedBy = userId; ses.endReason = reason; }
    const r = db.logAdmin(orgId, userId, 'auth.signed_out', { reason, session: id, minutes, ...extra });
    if (ses) ses.seq = r.seq;
    db.touch(orgId, 'session');
  };
  try {
    if (!db.peekDB(home)) db.getDB(home);
    const ses = sessionRecordIn(home, userId, signedInAt);
    if (!ses?.endedAt) end(home, ses, {});
  } catch { /* the record is best effort; signing out this browser is not */ }
  for (const orgId of db.orgIds()) {
    if (orgId === home) continue;
    try {
      const ses = sessionRecordIn(orgId, userId, signedInAt);
      if (ses && !ses.endedAt) end(orgId, ses, { signed_in_org: homeName });
    } catch { /* best effort */ }
  }
}

/** A person's standing in one organisation: an active member, suspended there, or no longer a member. */
export type OrgAccess = 'active' | 'suspended' | 'removed';

/** Is this organisation open to the person? Suspension and removal are per organisation; the others are unaffected. */
export function orgAccess(orgId: string, userId?: string): OrgAccess {
  if (!userId) return 'removed';
  // live: an organisation whose document this tab has not fetched is judged by the person's memberships
  if (LIVE && !db.peekDB(orgId)) {
    const m = useSession.getState().memberships?.find((x) => x.orgId === orgId);
    return !m ? 'removed' : m.status === 'active' ? 'active' : 'suspended';
  }
  try {
    if (db.memberRole(orgId, userId)) return 'active';
    return db.getDB(orgId).members.find((m) => m.userId === userId)?.status === 'suspended' ? 'suspended' : 'removed';
  } catch { return 'removed'; }
}

/** The signed-in person's access to each of their organisations, re-read when any membership changes. */
export function useOrgAccess(orgIds: string[]): Record<string, OrgAccess> {
  const userId = useSession((s) => s.user?.id);
  const key = orgIds.join(',');
  const snap = useSyncExternalStore(
    (cb) => db.subscribe((o) => { if (orgIds.includes(o)) cb(); }),
    () => orgIds.map((o) => `${o}=${orgAccess(o, userId)}`).join(','),
  );
  return useMemo(() => Object.fromEntries(snap.split(',').filter(Boolean).map((x) => x.split('=') as [string, OrgAccess])), [snap, key]);
}

export const useOrgId = () => useSession((s) => s.orgId);
export const useUser = () => useSession((s) => s.user);

/**
 * The role the signed-in person holds in the current organisation, from its member record (People and roles):
 * a role change applies at once, and a suspended or removed member has none. Re-renders when members change.
 */
export function useRole(): Role | undefined {
  const orgId = useOrgId();
  const userId = useSession((s) => s.user?.id);
  return useSyncExternalStore(
    (cb) => db.subscribe((o) => { if (o === orgId) cb(); }),
    () => (userId ? db.memberRole(orgId, userId) : undefined),
  );
}

/** Can the signed-in person do this in the current organisation? (member-aware; see useRole) */
export const useCan = (perm: Permission) => canRole(useRole(), perm);

/** The role a person holds in an organisation now (member record), for checks outside React. */
export const effectiveRole = (orgId: string, userId?: string): Role | undefined => db.memberRole(orgId, userId);

/**
 * Keep the session's user record in step with the membership, so every check that reads user.role sees the role
 * held in this organisation now. A person suspended or removed here is signed out (their sessions were ended).
 */
function syncMembership() {
  const s = useSession.getState();
  if (!s.user || !db.peekDB(s.orgId)) return;
  const role = db.memberRole(s.orgId, s.user.id);
  if (!role) {
    // someone with other organisations (an auditor) moves to one where they are still active
    const other = s.user.orgIds.find((o) => o !== s.orgId && !!db.peekDB(o) && !!db.memberRole(o, s.user!.id));
    if (other) {
      const name = db.peekDB(s.orgId)?.org.name ?? 'This organisation';
      useSession.setState({ orgId: other, user: { ...s.user, role: db.memberRole(other, s.user.id) ?? s.user.role } });
      save({ ...useSession.getState(), orgId: other });
      toast.held(`${name} closed your access`, 'You were moved to another of your organisations. Your access there is unaffected.');
      return;
    }
    s.signOut({ reason: 'Access suspended or removed' });
    try { sessionStorage.setItem('eg:auth:ended', 'Your access to this organisation was suspended or removed, so you were signed out.'); } catch { /* fine */ }
    return;
  }
  if (role !== s.user.role) useSession.setState({ user: { ...s.user, role } });
}

if (typeof window !== 'undefined') {
  db.subscribe((orgId) => { if (orgId === useSession.getState().orgId) syncMembership(); });
}
// the data layer reads the open organisation's own tool catalogue when a rule is tried without tags
db.setActiveOrg(useSession.getState().orgId);
useSession.subscribe((s) => db.setActiveOrg(s.orgId));

/** The current organisation's assurance level; re-renders when it changes (an upgrade). */
export function useOrgLevel(): LevelId {
  const orgId = useOrgId();
  return useSyncExternalStore(
    (cb) => db.subscribe((o) => o === orgId && cb()),
    () => api.levelOf(orgId),
  );
}

/** Does the current organisation's level include a capability? e.g. useHasCapability('rfc3161_anchors'). */
export function useHasCapability(cap: CapabilityId): boolean {
  return hasCapability(useOrgLevel(), cap);
}

/**
 * Re-ask for the password if it was last entered more than 10 minutes ago (built rule): at sign-in, or at the
 * last re-authentication. Check the password with `reauth` from '@/features/work/backend', then call markReauth.
 */
export const needsReauth = () => {
  const s = useSession.getState();
  const t = Math.max(s.reauthAt ?? 0, s.signedInAt ?? 0);
  return !t || Date.now() - t > 10 * 60_000;
};

/**
 * Record a successful re-authentication. Only the re-authentication time moves: the session keeps its start time,
 * so its lifetime is not extended and its session record (ses_<user>_<signedInAt>) keeps its id.
 */
export const markReauth = () => {
  const s = useSession.getState();
  const reauthAt = Date.now();
  useSession.setState({ reauthAt });
  save({ user: s.user, orgId: s.orgId, signedInAt: s.signedInAt, sessionOrgId: s.sessionOrgId, reauthAt });
};

/* ══ Live builds: the session is the server's ═══════════════════════════ */

/** Organisations the console can open for this person: active memberships of organisations the console knows. */
const openable = (ms: MeMembership[]) => ms.filter((m) => m.status === 'active' && ORGS.some((o) => o.id === m.orgId));

/**
 * Read the session from the server (GET /api/me) and open the person's organisations: each one's document and people
 * are fetched before anything is shown, so no screen ever reads an organisation built from the demonstration seed.
 * Undefined when signed out. `preferOrg` opens that organisation when it is one of theirs.
 */
export async function refreshLiveSession(preferOrg?: string): Promise<User | undefined> {
  const me = await fetchMe();
  if (!me) {
    stopStream();
    useSession.setState({ user: undefined, signedInAt: undefined, sessionOrgId: undefined, reauthAt: undefined, memberships: undefined });
    return undefined;
  }
  const usable = openable(me.memberships);
  const pick = (id?: string | null) => (id && usable.some((m) => m.orgId === id) ? id : undefined);
  const orgId = pick(preferOrg) ?? pick(me.activeOrgId) ?? usable[0]?.orgId;
  if (!orgId) {
    const all = me.memberships.length && me.memberships.every((m) => m.status === 'suspended');
    throw new Error(all ? 'Your access to every organisation you belong to is suspended, so the console cannot open one.' : 'Your account belongs to no organisation the console can open yet.');
  }
  // the open one must load; the others (an auditor's clients) load as well, but one that fails stays closed
  await Promise.all(usable.map((m) => (m.orgId === orgId ? loadOrg(m.orgId) : loadOrg(m.orgId).catch(() => undefined))));
  const user = consoleUser(me, orgId);
  applySelf(user);
  const role = db.memberRole(orgId, user.id) ?? user.role;
  useSession.setState({
    user: { ...user, role },
    orgId,
    signedInAt: Date.parse(me.signedInAt),
    sessionOrgId: orgId,
    reauthAt: Date.parse(me.lastAuthAt),
    memberships: me.memberships,
  });
  // the shell listens to the open organisation's changes (src/shell/AppShell.tsx)
  return { ...user, role };
}

/**
 * The server no longer knows this session (any 401): sign out here and start the sign-in page afresh with the page
 * to come back to. The page reload leaves nothing of the session in this tab's memory.
 */
export function endLiveSessionByServer() {
  const s = useSession.getState();
  if (!s.user) return;
  stopStream();
  useSession.setState({ user: undefined, signedInAt: undefined, sessionOrgId: undefined, reauthAt: undefined, memberships: undefined });
  try { sessionStorage.setItem('eg:auth:ended', 'Your session ended on the server.'); } catch { /* fine */ }
  const here = window.location.pathname + window.location.search + window.location.hash;
  window.location.replace(/^\/login(?:[/?#]|$)/.test(here) ? '/login' : `/login?next=${encodeURIComponent(here)}`);
}

/** Live: open another of the person's organisations (the server's session follows), refusing where they are not active. */
function switchLiveOrg(orgId: string): boolean {
  const s = useSession.getState();
  if (!s.user || orgId === s.orgId) return true;
  const m = s.memberships?.find((x) => x.orgId === orgId);
  const name = db.peekDB(orgId)?.org.name ?? m?.orgName ?? 'That organisation';
  const active = !!m && m.status === 'active' && (!db.peekDB(orgId) || !!db.memberRole(orgId, s.user.id));
  if (!active) {
    const suspended = m?.status === 'suspended' || db.peekDB(orgId)?.members.find((x) => x.userId === s.user!.id)?.status === 'suspended';
    toast.held(`${name} is not open to you`, suspended ? 'Your access there is suspended. Your other organisations are unaffected. An owner or admin there can reinstate you.' : 'You are no longer a member there.');
    return false;
  }
  const open = () => {
    const user = useSession.getState().user;
    if (!user) return;
    useSession.setState({ orgId, user: { ...user, role: db.memberRole(orgId, user.id) ?? user.role } });
  };
  void selectOrg(orgId).catch((e: Error) => toast.bad(`${name} could not be opened`, e.message));
  if (isLoaded(orgId)) {
    open();
    void resync(orgId);
  } else {
    void loadOrg(orgId).then(open, (e: Error) => toast.bad(`${name} could not be opened`, e.message));
  }
  return true;
}
