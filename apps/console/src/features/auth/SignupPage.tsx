import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { LevelId } from '@/types';
import { LEVEL_INFO } from '@/lib/levels';
import { Banner, Button, Checkbox, Field, Input } from '@/components/ui';
import { AuthHeading, AuthLayout } from './AuthLayout';
import { PasswordChecklist, PasswordInput, emailProblem, passwordChecks, passwordOk } from './password';
import { LevelChooser, priceLines } from './LevelChooser';
import { signUp } from './registry';

export default function SignupPage() {
  const nav = useNavigate();
  const [company, setCompany] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [level, setLevel] = useState<LevelId>('l1');
  const [terms, setTerms] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { document.title = 'Create an organisation · Elan1 Govern'; }, []);

  const checks = passwordChecks(password, { email, name });
  const errors = {
    company: company.trim().length < 2 ? 'Enter your company’s name.' : undefined,
    name: name.trim().length < 2 ? 'Enter your full name.' : undefined,
    email: emailProblem(email, true),
    password: !passwordOk(password, { email, name }) ? 'Choose a password that meets the checks below.' : undefined,
    terms: !terms ? 'Accept the terms and the data processing agreement to create the organisation.' : undefined,
  };
  const show = (k: keyof typeof errors) => (submitted || touched[k]) && errors[k];
  const valid = Object.values(errors).every((e) => !e);
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await signUp({ company, name, email, password, level });
      nav('/onboarding', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const p = priceLines(level);

  return (
    <AuthLayout wide statement={<>The agent drafts it. A person commits it.</>} sub={<p>Create an organisation, choose how much you need to prove, and put your first agent behind a published rulebook. Anything not written down is refused.</p>}>
      <AuthHeading kicker="Create an organisation" title="Start with Elan1 Govern">
        Already have an account? <Link to="/login" className="link">Sign in</Link>.
      </AuthHeading>

      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Company" htmlFor="company" required error={show('company')}>
          <Input id="company" autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} onBlur={blur('company')} invalid={!!show('company')} placeholder="Shree Ganesh Traders Pvt Ltd" autoFocus />
        </Field>
        <Field label="Your name" htmlFor="name" required error={show('name')}>
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} onBlur={blur('name')} invalid={!!show('name')} />
        </Field>
        <Field label="Work email" htmlFor="email" required error={show('email')} hint="You become the owner. Your email domain identifies the organisation for single sign-on.">
          <Input id="email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={blur('email')} invalid={!!show('email')} placeholder="name@company.com" />
        </Field>
        <Field label="Password" htmlFor="password" required error={submitted ? errors.password : undefined}>
          <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={submitted && !!errors.password} aria-describedby="pw-checks" />
          <PasswordChecklist id="pw-checks" checks={checks} />
        </Field>

        <fieldset className="pt-2">
          <legend className="text-sm font-medium">Assurance level</legend>
          <p className="mt-1 mb-3 text-xs text-muted">Start on Guarded and upgrade later, or start higher. Levels only go up; records keep the level they were made at.</p>
          <LevelChooser value={level} onChange={setLevel} compact />
          <p className="mt-2 text-xs text-muted" aria-live="polite">{LEVEL_INFO[level].label}: {p.floor} · {p.included} · {p.perAction}. Prices exclude GST. {p.listPrice}.{level === 'l1' ? ' A new Guarded organisation starts on the free 90-day pilot (up to 2,000 governed actions).' : ''}</p>
        </fieldset>

        <div>
          <Checkbox checked={terms} onChange={setTerms}
            label={<>I accept the <Link to="/developers/legal#terms" target="_blank" className="link">terms of service</Link> and the <Link to="/developers/legal#dpa" target="_blank" className="link">data processing agreement</Link></>}
            description={<>Draft — needs legal review. Elan1 Govern stores receipts and rulebooks for your organisation; it never holds your agents’ model prompts. How we handle your own details: <Link to="/legal/privacy" target="_blank" className="link">privacy notice</Link>, <Link to="/legal/cookies" target="_blank" className="link">cookie policy</Link> and <Link to="/legal/sub-processors" target="_blank" className="link">sub-processors</Link>.</>} />
          {show('terms') && <p className="mt-1.5 text-xs text-bad-fg" role="alert">{errors.terms}</p>}
        </div>

        {error && <div role="alert"><Banner tone="bad">{error}</Banner></div>}

        <Button type="submit" variant="primary" size="lg" block loading={busy} iconRight={!busy ? <ArrowRight className="h-4 w-4" /> : undefined}>Create organisation</Button>
        <p className="text-xs text-muted leading-relaxed">
          Creates the organisation and you as its owner, signs you in and opens set-up. The account works in this browser; it is a demonstration and nothing is sent anywhere.
        </p>
      </form>
    </AuthLayout>
  );
}
