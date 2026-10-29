/**
 * The organisation's session lifetime (Agents door › Sessions › sign-in policy), applied to this browser's
 * console session. The lifetime is read from the organisation's settings through orgApi; a session older
 * than it is ended on the organisation's session list, this browser is signed out, and the sign-in page
 * says why.
 *
 * Organisations created in this browser have no settings of their own yet, so no lifetime applies to them.
 */
import { useEffect } from 'react';
import { db } from '@/api';
import { useSession } from '@/store/session';
import { lifetimeMs, orgState, type Lifetime } from '@/features/settings/orgApi';
import { createdOrg } from '@/features/auth/registry';

export const LIFETIME_LABEL: Record<Lifetime, string> = { '8h': '8 hours', '12h': '12 hours', '24h': '24 hours', '7d': '7 days' };

const ENDED_KEY = 'eg:auth:ended';

/** The lifetime that applies to a session in an organisation, and when that session ends. */
export function sessionLimit(orgId: string, signedInAt?: number): { lifetime: Lifetime; label: string; expiresAt: number } | undefined {
  if (!signedInAt || createdOrg(orgId)) return undefined;
  try {
    const lifetime = orgState(orgId).sessionPolicy.lifetime;
    return { lifetime, label: LIFETIME_LABEL[lifetime], expiresAt: signedInAt + lifetimeMs(lifetime) };
  } catch {
    return undefined;
  }
}

/**
 * End this browser's session when it is older than the organisation's lifetime. Records the end on the
 * organisation's session list and signs out. Returns the reason to show, or undefined when nothing ended.
 */
export function endExpiredSession(): string | undefined {
  const s = useSession.getState();
  if (!s.user || !s.signedInAt) return undefined;
  const lim = sessionLimit(s.orgId, s.signedInAt);
  if (!lim || Date.now() < lim.expiresAt) return undefined;
  try {
    const ses = orgState(s.orgId).sessions.find((x) => x.id === `ses_${s.user!.id}_${s.signedInAt}`);
    if (ses && !ses.endedAt) {
      ses.endedAt = new Date(lim.expiresAt).toISOString();
      ses.endReason = `Expired after the ${lim.lifetime} session lifetime`;
      db.touch(s.orgId, 'session');
    }
  } catch { /* the session list is best effort; signing out is not */ }
  // ends the record in the organisation signed in to as well (with auth.signed_out on its chain) after a switch
  s.signOut({ reason: `Expired after the ${lim.lifetime} session lifetime` });
  return `Your organisation ends sessions after ${lim.label}, and this one reached that limit.`;
}

/**
 * Watch the current session against the lifetime while mounted: checks now and every 30 seconds, and
 * sends the browser to the sign-in page with the reason when the session ends. Mount once in the shell.
 */
export function useSessionLifetime() {
  useEffect(() => {
    const check = () => {
      const reason = endExpiredSession();
      if (!reason) return;
      try { sessionStorage.setItem(ENDED_KEY, reason); } catch { /* fine */ }
      window.location.assign('/login');
    };
    check();
    const t = window.setInterval(check, 30_000);
    return () => window.clearInterval(t);
  }, []);
}
