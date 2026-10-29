import { useSession } from '@/store/session';

/**
 * 'Keep me signed in'. The choice is a per-browser preference. When it is off, the session ends when the
 * browser is closed: every sign-in sets a browser-session cookie (no expiry, so the browser drops it on close),
 * and on start-up a stored session without that cookie is signed out. With the box ticked, the session stays
 * until it is signed out or the organisation's session lifetime ends it.
 */
export const KEEP_KEY = 'eg:keep-signed-in';
const COOKIE = 'eg_browser_session';

export function keepSignedIn(): boolean {
  try { return localStorage.getItem(KEEP_KEY) !== '0'; } catch { return true; }
}

export function setKeepSignedIn(keep: boolean) {
  try { localStorage.setItem(KEEP_KEY, keep ? '1' : '0'); } catch { /* storage unavailable */ }
  markBrowserSession();
}

/** Called at every sign-in: marks this browser session as live. */
export function markBrowserSession() {
  try { document.cookie = `${COOKIE}=1; path=/; SameSite=Lax`; } catch { /* cookies unavailable */ }
}

function browserSessionLive() {
  try { return document.cookie.split(';').some((c) => c.trim().startsWith(`${COOKIE}=`)); } catch { return true; }
}

/** On start-up: sign out a stored session when 'Keep me signed in' was off and the browser has since been closed. */
export function endSessionIfBrowserClosed() {
  if (typeof window === 'undefined' || keepSignedIn()) return;
  const s = useSession.getState();
  if (!s.user || browserSessionLive()) return;
  s.signOut({ reason: 'Browser closed without “Keep me signed in”' });
  try { sessionStorage.setItem('eg:auth:ended', 'You chose not to stay signed in, so closing the browser ended your session.'); } catch { /* fine */ }
}
