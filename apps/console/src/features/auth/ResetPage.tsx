import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Clock3, KeyRound } from 'lucide-react';
import { relative } from '@/lib/format';
import { Banner, Button, Field } from '@/components/ui';
import { AuthHeading, AuthLayout } from './AuthLayout';
import { PasswordChecklist, PasswordInput, passwordChecks, passwordOk } from './password';
import { RESET_MINUTES, resetInfo, resetPassword } from './registry';
import { LIVE } from '@/api/mode';
import { reset } from '@/api/live/session';

export default function ResetPage() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ email: string; ended: number }>();
  const [error, setError] = useState<string>();
  // live builds: only the server knows the link; it says whether the link still works when the password is sent
  const info = useMemo(() => (LIVE ? { state: 'valid' as const, reset: undefined } : resetInfo(token)), [token, done]);

  useEffect(() => { document.title = 'Choose a new password · Elan1 Govern'; }, []);

  const email = info.reset?.email;
  const checks = [...passwordChecks(password, { email }), { id: 'match', label: 'Both passwords match', ok: confirm.length > 0 && confirm === password, required: true }];
  const ok = passwordOk(password, { email }) && confirm === password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!ok) return;
    setBusy(true);
    setError(undefined);
    try {
      if (LIVE) {
        const r = await reset(token, password);
        setDone({ email: '', ended: r.sessionsEnded });
      } else setDone(await resetPassword(token, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = { expired: 'This reset link has expired', used: 'This reset link was already used', replaced: 'A newer reset link replaced this one', unknown: 'This reset link is not valid' } as const;

  return (
    <AuthLayout statement={<>Every action, answerable.</>} sub={<p>Changing your password signs out every other session. Approvals already waiting stay in the inbox.</p>}>
      {done ? (
        <div role="status" aria-live="polite">
          <span className="inline-flex h-11 w-11 items-center justify-center border border-ok/40 bg-ok-bg"><CheckCircle2 className="h-5 w-5 text-ok-fg" aria-hidden /></span>
          <AuthHeading title="Password changed">
            {done.ended ? `${done.ended} other session${done.ended === 1 ? ' was' : 's were'} signed out.` : 'No other session was open.'} The link has been used and no longer works. Sign in with the new password.
          </AuthHeading>
          <Button className="mt-2" variant="primary" size="lg" block onClick={() => nav('/login', { replace: true })}>Sign in</Button>
        </div>
      ) : info.state !== 'valid' ? (
        <div>
          <span className="inline-flex h-11 w-11 items-center justify-center border border-line bg-surface"><Clock3 className="h-5 w-5" aria-hidden /></span>
          <AuthHeading title={title[info.state]}>
            Reset links work once and expire after {RESET_MINUTES} minutes; asking again replaces the earlier link.{info.reset?.usedAt ? ` It was used ${relative(info.reset.usedAt)}.` : ''} Ask for a new link.
          </AuthHeading>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => nav('/forgot')}>Send a new link</Button>
            <Button variant="secondary" onClick={() => nav('/login')}>Back to sign in</Button>
          </div>
        </div>
      ) : (
        <>
          <AuthHeading kicker="Password recovery" title="Choose a new password">
            {email ? <>For <span className="text-fg font-medium break-all">{email}</span>. </> : null}Pick something you do not use anywhere else. A password manager helps.
          </AuthHeading>
          <form onSubmit={submit} noValidate className="space-y-4">
            <Field label="New password" htmlFor="pw" required>
              <PasswordInput id="pw" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={submitted && !passwordOk(password, { email })} aria-describedby="pw-checks" autoFocus />
            </Field>
            <Field label="Repeat the new password" htmlFor="pw2" required error={submitted && confirm !== password ? 'The two passwords differ.' : undefined}>
              <PasswordInput id="pw2" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={submitted && confirm !== password} />
            </Field>
            <PasswordChecklist id="pw-checks" checks={checks} />
            {error && <div role="alert"><Banner tone="bad">{error}</Banner></div>}
            <Button type="submit" variant="primary" size="lg" block loading={busy} icon={!busy ? <KeyRound className="h-4 w-4" /> : undefined}>Change password</Button>
          </form>
          <p className="mt-4 text-xs text-muted">Link <span className="font-mono">{token.slice(0, 12)}…</span> · single use · {info.reset ? `expires ${relative(info.reset.expiresAt)}` : `works for ${RESET_MINUTES} minutes after it was sent`}.</p>
          <Link to="/login" className="mt-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Back to sign in</Link>
        </>
      )}
    </AuthLayout>
  );
}
