/**
 * Live builds: switch the console onto the real backend. Imported first by src/main.tsx (before the screens), so
 * the domain's store is the server's cache from its first use:
 *
 *  - the persistence hook (sync.ts) replaces localStorage;
 *  - every operation goes through the live engine (engine.ts);
 *  - the HTTP client's hooks open the re-authentication dialog, end the session on a 401 and show the console's
 *    offline screen when the server cannot be reached;
 *  - the operations that mean something else against the real backend are served by it: checking a password
 *    again (work.reauth) and signing in (api.signIn).
 *
 * bootLive() then reads the session (GET /api/me) and opens the person's organisations before the first render.
 */
import { LIVE } from '@/api/mode';
import { setHttpHooks } from '@/api/http';
import { endLiveSessionByServer, refreshLiveSession, useSession } from '@/store/session';
import { __live } from './call';
import { engine, override } from './engine';
import { installPersistence } from './sync';
import { confirmPassword, requestReauth } from './ReauthDialog';
import { login } from './session';

let installed = false;

export function installLive() {
  if (!LIVE || installed) return;
  installed = true;
  installPersistence();
  __live.install(engine);
  setHttpHooks({
    reauth: () => requestReauth(),
    signedOut: () => endLiveSessionByServer(),
    // the console's own offline screen (SystemWatch listens for these)
    offline: () => window.dispatchEvent(new Event('offline')),
    online: () => window.dispatchEvent(new Event('online')),
  });
  // "Confirm it's you" before approvals, the stop and key changes: the real password (and code)
  override('work.reauth', async (args) => confirmPassword(String(args[1] ?? '')));
  // api.signIn checks a password: signed in, that is a re-authentication; signed out, a sign-in
  override('api.signIn', async (args) => {
    const [email, password] = [String(args[0] ?? ''), String(args[1] ?? '')];
    const s = useSession.getState();
    if (s.user) {
      await confirmPassword(password);
      return { ...s.user };
    }
    const r = await login(email, password);
    if (r.needTotp) throw new Error('Enter the 6-digit code from your authenticator on the sign-in page.');
    const user = await refreshLiveSession();
    if (!user) throw new Error('Sign in to continue.');
    return user;
  });
}

installLive();

/** Read the session and open the person's organisations. Never rejects: a failure leaves the console signed out. */
export async function bootLive(): Promise<void> {
  try {
    await refreshLiveSession();
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[live] the session could not be opened:', (e as Error).message);
  }
}
