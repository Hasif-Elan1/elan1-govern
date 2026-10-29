import { useEffect, useState, type FormEvent } from 'react';
import { create } from 'zustand';
import { ShieldCheck } from 'lucide-react';
import { Banner, Button, Dialog, Field, Input } from '@/components/ui';
import { PasswordInput } from '@/features/auth/password';
import { HttpError } from '@/api/http';
import { demoAccounts, reauth } from './session';

/**
 * Live builds: "Confirm it is you", for actions the server holds back until the person signed in within the last
 * 10 minutes (`{ reauth: true }`), and for two-step accounts whose password alone did not do (the 6-digit code).
 * The password goes to POST /api/auth/session, which moves the session's last sign-in time.
 */
interface Ask { password?: string; needTotp?: boolean; resolve: (ok: boolean) => void }

const useAsk = create<{ ask?: Ask }>(() => ({}));

/** Ask the person to confirm it is them. Resolves true once the server accepted it, false when they cancelled. */
export function requestReauth(opts: { password?: string; needTotp?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    useAsk.getState().ask?.resolve(false);
    useAsk.setState({ ask: { ...opts, resolve } });
  });
}

/** Check a password typed into a screen; when the account also needs its code, the dialog asks for it. */
export async function confirmPassword(password: string): Promise<true> {
  try {
    const r = await reauth(password);
    if (r.needTotp && !(await requestReauth({ password, needTotp: true }))) throw new Error('Enter the 6-digit code from your authenticator to confirm it is you.');
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) throw new Error(e.message === 'That password is not right.' ? 'That password does not match your account. Try again.' : e.message);
    throw e;
  }
}

export function ReauthDialog({ email }: { email?: string }) {
  const ask = useAsk((s) => s.ask);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [demoCode, setDemoCode] = useState<string>();

  useEffect(() => {
    if (!ask) return;
    setPassword(ask.password ?? '');
    setCode('');
    setNeedTotp(!!ask.needTotp);
    setError(undefined);
  }, [ask]);

  // the demonstration's published code for this account, where the server publishes one (never in production)
  useEffect(() => {
    if (!ask || !needTotp || !email) return;
    let on = true;
    const load = () => void demoAccounts().then((d) => {
      const a = d?.groups.flatMap((g) => g.accounts).find((x) => x.email === email);
      if (on) setDemoCode(a?.code ?? undefined);
    });
    load();
    const t = window.setInterval(load, 10_000);
    return () => { on = false; window.clearInterval(t); };
  }, [ask, needTotp, email]);

  const close = (ok: boolean) => {
    ask?.resolve(ok);
    useAsk.setState({ ask: undefined });
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!password) { setError('Enter your password to confirm it is you.'); return; }
    if (needTotp && !/^\d{6}$/.test(code)) { setError('Enter the 6-digit code from your app.'); return; }
    setBusy(true);
    setError(undefined);
    try {
      const r = await reauth(password, needTotp ? code : undefined);
      if (r.needTotp) { setNeedTotp(true); return; }
      close(true);
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof HttpError && err.data.needTotp) { setNeedTotp(true); setCode(''); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!ask} onClose={() => close(false)} size="sm" title="Confirm it is you" description="Asked because your last sign-in was more than 10 minutes ago."
      footer={<>
        <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} icon={!busy ? <ShieldCheck className="h-4 w-4" /> : undefined} onClick={() => void submit()}>Confirm</Button>
      </>}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Your password" htmlFor="reauth-pw">
          <PasswordInput id="reauth-pw" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-autofocus />
        </Field>
        {needTotp && (
          <Field label="Authentication code" htmlFor="reauth-totp" hint="The 6-digit code from your authenticator app.">
            <Input id="reauth-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </Field>
        )}
        {needTotp && demoCode && (
          <p className="text-xs text-muted">Demo authenticator: <span className="font-mono text-fg">{demoCode}</span> <button type="button" className="link" onClick={() => setCode(demoCode)}>Use this code</button></p>
        )}
        {error && <div role="alert"><Banner tone="bad">{error}</Banner></div>}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
