import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, MailCheck, Send } from 'lucide-react';
import { Banner, Button, Field, Input } from '@/components/ui';
import { AuthHeading, AuthLayout } from './AuthLayout';
import { emailProblem } from './password';
import { RESET_MINUTES, requestPasswordReset } from './registry';
import { DemoOutbox } from './Outbox';

export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const problem = emailProblem(email);

  useEffect(() => { document.title = 'Reset your password · Elan1 Govern'; }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (problem) return;
    setBusy(true);
    setError(undefined);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout statement={<>Every action, answerable.</>} sub={<p>Recovery links work once and expire after {RESET_MINUTES} minutes. Asking again replaces the earlier link. Changing your password signs out your other sessions.</p>}>
      {!sent ? (
        <>
          <AuthHeading kicker="Password recovery" title="Reset your password">
            Enter the email you sign in with. If an account exists, we send a single-use link to reset the password.
          </AuthHeading>
          <form onSubmit={submit} noValidate className="space-y-4">
            <Field label="Work email" htmlFor="email" error={submitted ? problem : undefined}>
              <Input id="email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} invalid={submitted && !!problem} placeholder="name@company.com" autoFocus />
            </Field>
            {error && <Banner tone="bad">{error}</Banner>}
            <Button type="submit" variant="primary" size="lg" block loading={busy} icon={!busy ? <Send className="h-4 w-4" /> : undefined}>Send reset link</Button>
          </form>
          <p className="mt-6 text-sm text-muted">
            Your organisation uses single sign-on? Reset the password with your identity provider instead — Elan1 Govern does not hold it.
          </p>
          <Link to="/login" className="mt-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Back to sign in</Link>
        </>
      ) : (
        <div role="status" aria-live="polite">
          <span className="inline-flex h-11 w-11 items-center justify-center border border-line bg-surface"><MailCheck className="h-5 w-5" aria-hidden /></span>
          <AuthHeading title="If an account exists, we sent a link">
            Check the inbox for <span className="text-fg font-medium break-all">{email.trim()}</span>. The link works once and expires in {RESET_MINUTES} minutes. For your safety we do not say whether an account exists.
          </AuthHeading>
          <DemoOutbox to={email} title="Demo outbox for this address" limit={3} empty="No message for this address — no account uses it. That is what an unknown address looks like; the page above reads the same either way." />
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => { setSent(false); setSubmitted(false); }}>Use a different email</Button>
          </div>
          <Link to="/login" className="mt-8 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Back to sign in</Link>
        </div>
      )}
    </AuthLayout>
  );
}
