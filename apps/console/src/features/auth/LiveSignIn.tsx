/**
 * Sign-in against the real backend (live builds): the same page as the demonstration's (LoginPage.tsx), with the
 * same layout and wording, but every check is the server's:
 *  - POST /api/auth/login with the password, then the 6-digit code when the account has two-step sign-in;
 *  - the lock after repeated failures, single sign-on only domains, "SAML required" and suspension are refused
 *    there, and their sentences are shown here;
 *  - the "Demo accounts" panel and the demo authenticator come from GET /api/dev/demo-accounts, and appear only
 *    where the server publishes them (never in production);
 *  - single sign-on goes to the identity provider the server names (SAML or OpenID Connect).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Ban, Building2, Check, Fingerprint, KeyRound, LogIn, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { refreshLiveSession, useSession, useUser } from '@/store/session';
import { ROLE_INFO } from '@/lib/permissions';
import { LEVEL_INFO, LEVELS } from '@/lib/levels';
import type { LevelId, Role, User } from '@/types';
import { cn } from '@/lib/cn';
import { Avatar, Badge, Banner, Button, Checkbox, Dialog, Field, Input, Meter, toast } from '@/components/ui';
import { HttpError } from '@/api/http';
import { demoAccounts, login, ssoStart, type DemoAccount, type DemoAccounts } from '@/api/live/session';
import { AuthHeading, AuthLayout, OrRule } from './AuthLayout';
import { PasswordInput, emailProblem } from './password';
import { keepSignedIn, setKeepSignedIn } from './keepSignedIn';
import { safeNext } from './safeNext';
import { takeEndedReason } from './registry';

/** Where to go after sign-in: a same-site `next` path (see safeNext), never back to the sign-in page. */
function destination(user: User, next: string | null) {
  const safe = safeNext(next);
  if (safe && safe !== '/' && !/^\/login(?:[/?#]|$)/.test(safe)) return safe;
  return user.role === 'auditor' ? '/auditor' : '/';
}

/** A refusal the server explained: its own sentence, under the console's heading for that kind. */
type Refused = { kind: 'sso' | 'saml' | 'suspended'; text: string };

function refusedFrom(e: unknown): Refused | undefined {
  if (!(e instanceof HttpError)) return undefined;
  if (e.data.saml) return { kind: 'saml', text: e.message };
  if (e.data.sso) return { kind: 'sso', text: e.message };
  if (e.data.suspended) return { kind: 'suspended', text: e.message };
  return undefined;
}

function RefusedBanner({ refused, onSso }: { refused: Refused; onSso: () => void }) {
  if (refused.kind === 'suspended') {
    return <div id="signin-error" role="alert"><Banner tone="bad" title="Your access is suspended">{refused.text}</Banner></div>;
  }
  return (
    <div id="signin-error" role="alert">
      <Banner tone="held" title={refused.kind === 'saml' ? 'SAML sign-in required' : 'Single sign-on required'}
        actions={<Button size="sm" variant="primary" icon={<Fingerprint className="h-3.5 w-3.5" />} onClick={onSso}>Continue with single sign-on</Button>}>
        {refused.text}
      </Banner>
    </div>
  );
}

/** The server's demonstration accounts, refreshed for the current two-step codes; undefined where it publishes none. */
function useDemoAccounts(): DemoAccounts | undefined {
  const [d, setD] = useState<DemoAccounts>();
  useEffect(() => {
    let on = true;
    let t = 0;
    const load = () => void demoAccounts().then((x) => {
      if (!on) return;
      setD(x);
      if (x) t = window.setTimeout(load, Math.max(2, x.codeValidFor) * 1000);
    });
    load();
    return () => { on = false; window.clearTimeout(t); };
  }, []);
  return d;
}

export function LivePasswordSignIn() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  const signOut = useSession((s) => s.signOut);
  const current = useUser();
  const demo = useDemoAccounts();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(keepSignedIn);
  const [error, setError] = useState<string>();
  const [refused, setRefused] = useState<Refused>();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [code, setCode] = useState('');
  const [ssoOpen, setSsoOpen] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [ended] = useState(() => takeEndedReason());

  const submitRef = useRef<HTMLButtonElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { document.title = 'Sign in · Elan1 Govern'; }, []);
  useEffect(() => { if (step === 'totp') window.setTimeout(() => codeRef.current?.focus(), 30); }, [step]);

  const finish = async () => {
    setKeepSignedIn(keep);
    const user = await refreshLiveSession();
    if (!user) throw new Error('The sign-in did not hold. Try again.');
    toast.ok(`Signed in as ${user.name}`);
    nav(destination(user, next), { replace: true });
  };

  const fail = (err: unknown) => {
    const r = refusedFrom(err);
    if (r) {
      setRefused(r);
      setStep('password');
      setPassword('');
      setCode('');
      return;
    }
    setError((err as Error).message);
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setError(undefined);
    setRefused(undefined);
    setBusy(true);
    try {
      const r = await login(email.trim(), password, undefined, safeNext(next) ?? undefined);
      if (r.needTotp) { setStep('totp'); setCode(''); return; }
      await finish();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e?: FormEvent, value?: string) => {
    e?.preventDefault();
    if (busy) return;
    const v = value ?? code;
    setBusy(true);
    setError(undefined);
    try {
      const r = await login(email.trim(), password, v, safeNext(next) ?? undefined);
      if (r.needTotp) { setError('Enter the 6-digit code from your app.'); return; }
      await finish();
    } catch (err) {
      setCode('');
      // a lock or a refusal sends the person back to the first step, as the demonstration does
      if (refusedFrom(err) || (err instanceof HttpError && err.status === 429)) { setStep('password'); setPassword(''); }
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const fill = (a: DemoAccount) => {
    setEmail(a.email);
    setPassword(demo?.password ?? '');
    setPicked(a.userId);
    setError(undefined);
    setRefused(undefined);
    setStep('password');
    window.setTimeout(() => submitRef.current?.focus(), 20);
  };

  const demoCode = demo?.groups.flatMap((g) => g.accounts).find((a) => a.email.toLowerCase() === email.trim().toLowerCase())?.code ?? undefined;

  return (
    <AuthLayout
      wide={step === 'password'}
      statement={<>Every action, answerable.</>}
      sub={
        <>
          <p>Before an agent’s tool call runs, Elan1 Govern checks a published rulebook and answers: allow, ask a person, or refuse. Anything not written down is refused.</p>
          <ul className="mt-6 grid grid-cols-3 gap-px bg-ink-700 border border-ink-700 text-[12.5px]">
            {[['Default', 'Refuse'], ['Every decision', 'Hash-chained receipt'], ['Auditors', 'Verify offline']].map(([k, v]) => (
              <li key={k} className="bg-ink-800 px-3 py-2.5">
                <span className="block text-ink-300">{k}</span>
                <span className="block text-paper font-medium mt-0.5">{v}</span>
              </li>
            ))}
          </ul>
        </>
      }
    >
      {ended && step === 'password' && <Banner tone="held" className="mb-6" title="You were signed out">{ended} Sign in again to continue.</Banner>}
      {current && step === 'password' && (
        <Banner
          tone="neutral"
          className="mb-6"
          title={`Signed in as ${current.name}`}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => signOut()}>Sign out</Button>
              <Button size="sm" variant="primary" onClick={() => nav(destination(current, next))}>Continue</Button>
            </>
          }
        >
          {ROLE_INFO[current.role].label} · {current.email}
        </Banner>
      )}

      {step === 'password' ? (
        <>
          <AuthHeading kicker="Sign in" title="Sign in to Elan1 Govern">
            Use your work email. New organisation? <Link to="/signup" className="link">Create one</Link>.
          </AuthHeading>

          <form onSubmit={submitPassword} noValidate className="space-y-4" aria-describedby={error || refused ? 'signin-error' : undefined}>
            <Field label="Work email" htmlFor="email">
              <Input id="email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); setPicked(undefined); setError(undefined); setRefused(undefined); }} placeholder="name@company.com" invalid={!!error && !email} autoFocus />
            </Field>
            <Field label="Password" htmlFor="password" aside={<Link to="/forgot" className="text-sm text-muted hover:text-fg underline underline-offset-2">Forgot password?</Link>}>
              <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setPicked(undefined); }} invalid={!!error && !password} />
            </Field>
            <Checkbox checked={keep} onChange={(v) => { setKeep(v); setKeepSignedIn(v); }} label="Keep me signed in" description="On this browser. Untick it and closing the browser signs you out. A fresh sign-in is still asked for before approvals, the emergency stop and key rotation if the last one is older than 10 minutes." />

            {error && <div id="signin-error" role="alert"><Banner tone="bad">{error}</Banner></div>}
            {!error && refused && <RefusedBanner refused={refused} onSso={() => setSsoOpen(true)} />}

            <Button ref={submitRef} type="submit" variant="primary" size="lg" block loading={busy} icon={!busy ? <LogIn className="h-4 w-4" /> : undefined}>Sign in</Button>
          </form>

          <OrRule>or</OrRule>

          <Button variant="secondary" block size="lg" icon={<Fingerprint className="h-4 w-4" />} onClick={() => setSsoOpen(true)} aria-haspopup="dialog">Sign in with single sign-on</Button>
          <p className="mt-2 text-xs text-muted">SAML 2.0 or OpenID Connect. Only the identity providers your organisation has connected are offered.</p>

          {demo && demo.groups.some((g) => g.accounts.length) && <LiveDemoAccounts demo={demo} picked={picked} onPick={fill} />}
        </>
      ) : (
        <LiveTotpStep email={email.trim()} code={code} demoCode={demoCode}
          setCode={(v) => { setCode(v); setError(undefined); }} codeRef={codeRef} busy={busy} error={error} onSubmit={submitCode}
          onBack={() => { setStep('password'); setError(undefined); setCode(''); }} />
      )}

      <LiveSsoDialog open={ssoOpen} initialEmail={email} next={next} onClose={() => setSsoOpen(false)} />
    </AuthLayout>
  );
}

function LiveTotpStep({ email, code, demoCode, setCode, codeRef, busy, error, onSubmit, onBack }: {
  email: string; code: string; demoCode?: string; setCode: (v: string) => void; codeRef: React.RefObject<HTMLInputElement>; busy: boolean; error?: string; onSubmit: (e?: FormEvent, value?: string) => void; onBack: () => void;
}) {
  const digits = code.padEnd(6, ' ').split('');
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);
  const left = 30 - Math.floor((Date.now() / 1000) % 30);
  return (
    <>
      <AuthHeading kicker="Step 2 of 2" title="Enter your 6-digit code">
        Open your authenticator app and enter the code for <span className="text-fg font-medium">{email}</span>. Codes change every 30 seconds and work once.
      </AuthHeading>

      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <Field label="Authentication code" htmlFor="totp" hint="Checked against your authenticator’s secret (RFC 6238). A wrong code counts towards the same lock as a wrong password.">
          <div className="relative group">
            <input
              ref={codeRef}
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(v);
                if (v.length === 6) window.setTimeout(() => onSubmit(undefined, v), 60);
              }}
              aria-invalid={!!error || undefined}
              className="absolute inset-0 z-10 w-full h-full opacity-0 cursor-text"
            />
            <div className="grid grid-cols-6 gap-2" aria-hidden>
              {digits.map((d, i) => (
                <span key={i} className={cn('h-14 flex items-center justify-center border border-line-strong/70 bg-surface font-mono text-2xl', i === Math.min(code.length, 5) && 'group-focus-within:border-fg group-focus-within:shadow-[inset_0_0_0_1px_rgb(var(--fg))]', i === 2 && 'mr-2')}>
                  {d.trim()}
                </span>
              ))}
            </div>
          </div>
        </Field>

        {error && <div role="alert"><Banner tone="bad">{error}</Banner></div>}

        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={code.length !== 6} icon={!busy ? <ShieldCheck className="h-4 w-4" /> : undefined}>Verify and sign in</Button>

        {demoCode && (
          <section className="border border-dashed border-line-strong/70 bg-sunken/40 p-4" aria-labelledby="demo-auth">
            <div className="flex items-center justify-between gap-3">
              <p id="demo-auth" className="label">Demo authenticator for this account</p>
              <span className="text-xs text-muted num">{left}s</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="font-mono text-2xl tracking-[0.25em]" aria-live="polite">{demoCode}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setCode(demoCode); onSubmit(undefined, demoCode); }}>Use this code</Button>
            </div>
            <Meter value={left / 30} className="mt-2 h-1" label="Time left for this code" />
            <p className="mt-2 text-xs text-muted">Published for the demonstration so you can sign in without a phone. Each account has its own secret; enrol your own authenticator on the You page.</p>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Use a different account</button>
          <span className="inline-flex items-center gap-1.5 text-muted"><Smartphone className="h-3.5 w-3.5" aria-hidden />Lost your device? Ask an owner to reset two-step sign-in.</span>
        </div>
      </form>
    </>
  );
}

const ROLE_ORDER: Role[] = ['owner', 'admin', 'approver', 'viewer', 'auditor'];
const initialsOf = (name: string) => name.replace(/^Dr /, '').split(/\s+/).map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase();

function LiveDemoAccounts({ demo, picked, onPick }: { demo: DemoAccounts; picked?: string; onPick: (a: DemoAccount) => void }) {
  // the auditor holds every client organisation: one row of its own, as in the demonstration
  const auditors = new Map<string, DemoAccount & { orgs: number }>();
  for (const g of demo.groups) for (const a of g.accounts) if (a.role === 'auditor') {
    const seen = auditors.get(a.userId);
    auditors.set(a.userId, { ...a, orgs: (seen?.orgs ?? 0) + 1 });
  }
  const groups = LEVELS.map((lv: LevelId) => {
    const gs = demo.groups.filter((g) => g.level === lv);
    const accts = gs.flatMap((g) => g.accounts.filter((a) => a.role !== 'auditor').map((a) => ({ ...a, orgName: g.orgName })))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    return { lv, orgName: gs[0]?.orgName, accts };
  }).filter((g) => g.accts.length);

  return (
    <section aria-labelledby="demo-accounts" className="mt-8 border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-line">
        <h3 id="demo-accounts" className="text-sm font-semibold">Demo accounts by assurance level</h3>
        <span className="text-xs text-muted">One click fills the form</span>
      </div>
      {groups.map((g) => (
        <div key={g.lv} className="border-b border-line last:border-b-0">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-sunken/60">
            <Badge tone="inverse">{LEVEL_INFO[g.lv].tag}</Badge>
            <span className="text-sm font-semibold">{LEVEL_INFO[g.lv].name}</span>
            <span className="text-xs text-muted inline-flex items-center gap-1 min-w-0"><Building2 className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{g.orgName}</span></span>
          </div>
          <ul className="divide-y divide-line">
            {g.accts.map((a) => <LiveAccountRow key={a.userId} a={a} sub={a.orgName} on={picked === a.userId} onPick={onPick} />)}
          </ul>
        </div>
      ))}
      {[...auditors.values()].map((a) => (
        <div key={a.userId} className="border-b border-line">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-sunken/60">
            <Badge>L1 · L2 · L3 · SOV</Badge>
            <span className="text-sm font-semibold">Auditor across all four</span>
          </div>
          <ul><LiveAccountRow a={a} sub={`${a.orgs} client organisation${a.orgs === 1 ? '' : 's'}`} on={picked === a.userId} onPick={onPick} /></ul>
        </div>
      ))}
      <p className="px-4 py-3 text-xs text-muted bg-sunken/50">Demonstration accounts{demo.password ? ', all with the demonstration password' : ''}. Accounts with two-step sign-in show their current code on the next step.</p>
    </section>
  );
}

function LiveAccountRow({ a, sub, on, onPick }: { a: DemoAccount; sub?: string; on: boolean; onPick: (a: DemoAccount) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onPick(a)} aria-pressed={on}
        className={cn('group w-full text-left px-4 py-3 flex items-start gap-3 transition-colors hover:bg-sunken/60 focus-visible:bg-sunken/60', on && 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--accent))]')}>
        <Avatar initials={initialsOf(a.name)} size={32} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={on ? 'inverse' : 'neutral'}>{ROLE_INFO[a.role].label}</Badge>
            <span className="text-sm font-semibold">{a.name}</span>
            {a.twoStep && <span className="inline-flex items-center gap-1 text-[11px] text-muted" title="Two-step sign-in is on for this account"><KeyRound className="h-3 w-3" aria-hidden />2-step</span>}
            {a.status === 'suspended' && <span className="inline-flex items-center gap-1 text-[11px] text-bad-fg" title="Suspended: sign-in is refused"><Ban className="h-3 w-3" aria-hidden />Suspended</span>}
          </span>
          <span className="block text-xs text-muted mt-1 truncate">{a.title}{sub ? ` · ${sub}` : ''}</span>
          <span className="block text-[13px] text-fg/85 mt-1 leading-snug">{a.journey}</span>
        </span>
        <span className="shrink-0 mt-1 text-muted group-hover:text-fg" aria-hidden>{on ? <Check className="h-4 w-4 text-ok-fg" /> : <ArrowRight className="h-4 w-4" />}</span>
      </button>
    </li>
  );
}

/** Single sign-on: the server finds the organisation from the email's verified domain and names its identity provider. */
function LiveSsoDialog({ open, initialEmail, next, onClose }: { open: boolean; initialEmail: string; next: string | null; onClose: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setEmail(initialEmail);
    setError(undefined);
  }, [open, initialEmail]);

  const go = async (e?: FormEvent) => {
    e?.preventDefault();
    const p = emailProblem(email);
    if (p) { setError(p); return; }
    setBusy(true);
    setError(undefined);
    try {
      const url = await ssoStart(email.trim(), safeNext(next) ?? undefined);
      window.location.assign(url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Sign in with single sign-on" description="We find your organisation from your email domain and offer only the identity providers it has connected."
      footer={<Button variant="ghost" onClick={onClose}>Use a password instead</Button>}>
      <form onSubmit={go} noValidate className="space-y-3">
        <Field label="Work email" htmlFor="sso-email">
          <div className="flex gap-2">
            <Input id="sso-email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(undefined); }} placeholder="name@company.com" data-autofocus />
            <Button type="submit" variant="primary" loading={busy}>Continue</Button>
          </div>
        </Field>
        {error && <Banner tone="bad">{error}</Banner>}
      </form>
    </Dialog>
  );
}
