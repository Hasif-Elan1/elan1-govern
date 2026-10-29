/**
 * The real sign-in, for live builds: the console's session is the server's (an httpOnly cookie). These are the
 * calls; the session store (src/store/session.ts) keeps what GET /api/me says.
 */
import type { LevelId, Role, User } from '@/types';
import { del, get, HttpError, post, put, setCsrfToken } from '@/api/http';

export interface MeMembership {
  orgId: string;
  orgName: string;
  /** null where the membership is suspended */
  role: Role | null;
  heldRole: Role;
  status: 'active' | 'suspended' | string;
  level: LevelId | string;
}

export interface Me {
  user: { id: string; name: string; email: string; initials: string; title: string | null; mfa: boolean; lastSignIn: string | null };
  memberships: MeMembership[];
  activeOrgId: string | null;
  signedInAt: string;
  lastAuthAt: string;
  csrfToken?: string;
}

/** The signed-in person, or undefined when this browser is signed out. */
export async function fetchMe(): Promise<Me | undefined> {
  try {
    const me = await get<Me>('/api/me', { noSignOut: true });
    setCsrfToken(me.csrfToken);
    return me;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      setCsrfToken(undefined);
      return undefined;
    }
    throw e;
  }
}

/** The console's User for the person in one of their organisations. */
export function consoleUser(me: Me, orgId: string | undefined): User {
  const m = me.memberships.find((x) => x.orgId === orgId);
  return {
    id: me.user.id,
    name: me.user.name,
    email: me.user.email,
    role: (m?.role ?? m?.heldRole ?? me.memberships.find((x) => x.role)?.role ?? 'viewer') as Role,
    title: me.user.title ?? '',
    initials: me.user.initials,
    orgIds: me.memberships.map((x) => x.orgId),
    mfa: me.user.mfa,
    ...(me.user.lastSignIn ? { lastSignIn: me.user.lastSignIn } : {}),
  };
}

export type LoginAnswer = { needTotp?: boolean; next?: string };

/** Password (and the 6-digit code when asked) → a session cookie. Refusals are HttpErrors with the server's flags. */
export function login(email: string, password: string, totp?: string, next?: string): Promise<LoginAnswer> {
  return post<LoginAnswer>('/api/auth/login', { email, password, ...(totp ? { totp } : {}), ...(next ? { next } : {}) }, { noSignOut: true, noReauth: true });
}

/** End this browser's session on the server. */
export async function logout(): Promise<void> {
  try { await del('/api/auth/session', { noSignOut: true }); } catch { /* signed out already, or offline: the cookie goes either way */ }
  setCsrfToken(undefined);
}

/** Confirm it's you: the password again (and the code for two-step accounts). `needTotp` when the code is missing. */
export function reauth(password: string, totp?: string): Promise<{ ok?: boolean; needTotp?: boolean }> {
  return post('/api/auth/session', { password, ...(totp ? { totp } : {}) }, { noSignOut: true, noReauth: true });
}

/** Make another of the person's organisations the session's active one. */
export function selectOrg(orgId: string): Promise<unknown> {
  return put('/api/orgs', { orgId });
}

export interface DemoAccount { userId: string; name: string; email: string; title: string | null; role: Role; status: string; journey: string; twoStep: boolean; code: string | null }
export interface DemoAccounts { password: string | null; step: number; codeValidFor: number; groups: { level: LevelId; orgId: string; orgName: string; accounts: DemoAccount[] }[] }

/** The demonstration accounts, only where the server publishes them (never in production: 404 there). */
export async function demoAccounts(): Promise<DemoAccounts | undefined> {
  try { return await get<DemoAccounts>('/api/dev/demo-accounts', { noSignOut: true }); } catch { return undefined; }
}

export function forgot(email: string): Promise<{ ok?: boolean; message?: string }> {
  return post('/api/auth/forgot', { email }, { noSignOut: true });
}

export function reset(token: string, password: string): Promise<{ ok: boolean; sessionsEnded: number }> {
  return post('/api/auth/reset', { token, password }, { noSignOut: true });
}

/**
 * Single sign-on: SAML first, then OpenID Connect, for the email's verified domain. Resolves with the identity
 * provider's address to go to; rejects with the server's sentence when neither is set up.
 */
export async function ssoStart(email: string, next?: string): Promise<string> {
  const body = { email, ...(next ? { next } : {}) };
  try {
    return (await post<{ url: string }>('/api/auth/saml/start', body, { noSignOut: true })).url;
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 404) throw e;
  }
  return (await post<{ url: string }>('/api/auth/sso/start', body, { noSignOut: true })).url;
}
