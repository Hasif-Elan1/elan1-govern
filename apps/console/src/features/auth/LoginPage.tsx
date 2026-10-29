import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Ban, Building2, Check, Fingerprint, KeyRound, Loader2, LogIn, LogOut, RotateCcw, ShieldCheck, Smartphone } from 'lucide-react';
import { db } from '@/api';
import { useSession, useUser } from '@/store/session';
import { DEMO_ACCOUNTS, ORGS, userById, type DemoAccount } from '@/mock/users';
import { ROLE_INFO } from '@/lib/permissions';
import { LEVEL_INFO, LEVELS } from '@/lib/levels';
import { dateTime } from '@/lib/format';
import type { LevelId, User } from '@/types';
import { cn } from '@/lib/cn';
import { Avatar, Badge, Banner, Button, Checkbox, Dialog, Field, Input, Meter, Select, toast } from '@/components/ui';
import { orgApi, orgState } from '@/features/settings/orgApi';
import { endExpiredSession, sessionLimit } from '@/features/you/sessionLifetime';
import { AuthHeading, AuthLayout, OrRule } from './AuthLayout';
import { PasswordInput, emailProblem } from './password';
import { keepSignedIn, setKeepSignedIn } from './keepSignedIn';
import { safeNext } from './safeNext';
import {
  LockedError, PORTAL_ACCOUNTS, PORTAL_INFO, assertSso, beginSso, changedPasswords, checkPassword, checkSecondStep, completeSso, createdAccounts,
  createdOrg, endPortalSession, groupForPerson, lockState, orgForEmail, portalTokenFor, restorePublishedPasswords, ssoProviders, ssoState, startPortalSession,
  startSession, subscribeRegistry, takeEndedReason, totpAt, totpSecretFor, totpStep, type PortalAccount, type SsoProvider,
} from './registry';
import { breakGlassSignIn, policyFor, recordRefusal, samlRequired, ssoOnlyFor, type BreakGlassInfo, type Refusal } from './signInPolicy';
import { usePortalSession } from './PortalSession';
import { RefusalBanner } from './RefusalBanner';
import { LivePasswordSignIn } from './LiveSignIn';
import { LIVE } from '@/api/mode';

/** Where to go after sign-in: a same-site `next` path (see safeNext), never back to the sign-in page. */
function destination(user: User, next: string | null) {
  const safe = safeNext(next);
  if (safe && safe !== '/' && !/^\/login(?:[/?#]|$)/.test(safe)) return safe;
  return user.role === 'auditor' ? '/auditor' : '/';
}

function useRegistry() {
  return useSyncExternalStore(subscribeRegistry, () => JSON.stringify([createdAccounts().length, changedPasswords().length]));
}

/* ── The organisation's sign-in policy: one module (signInPolicy.ts) shared with the approve-by-link page ── */

/** Is two-step sign-in on for a demo account? From the organisation's records once they are open in this browser. */
function twoStepFor(a: DemoAccount, u: User) {
  if (createdOrg(a.orgId)) return !!u.mfa;
  const d = db.peekDB(a.orgId) as (ReturnType<typeof db.getDB> & { orgSettings?: unknown }) | undefined;
  if (!d?.orgSettings) return !!u.mfa;
  return orgApi.mfaOn(a.orgId, u.id) || orgState(a.orgId).sessionPolicy.require2step;
}

function ssoOnlyOrg(orgId: string) {
  const d = db.peekDB(orgId) as (ReturnType<typeof db.getDB> & { orgSettings?: { oidc?: { ssoOnly?: boolean } } }) | undefined;
  return !createdOrg(orgId) && !!d?.orgSettings?.oidc?.ssoOnly;
}

/** SAML required in an organisation whose records are already open (no build from the sign-in page's render). */
function samlOnlyOrg(orgId: string) {
  return !createdOrg(orgId) && !!db.peekDB(orgId) && samlRequired(orgId).required;
}

function suspendedIn(orgId: string, userId: string) {
  return db.peekDB(orgId)?.members.find((m) => m.userId === userId)?.status === 'suspended';
}

export default function LoginPage() {
  // live builds: the same page, checked by the server (LiveSignIn.tsx)
  if (LIVE) return <LivePasswordSignIn />;
  return <DemoLoginPage />;
}

function DemoLoginPage() {
  const [params] = useSearchParams();
  const sso = params.get('sso');
  const acs = params.get('acs');
  if (sso) return <IdentityProviderPage state={sso} />;
  if (acs) return <AcsPage state={acs} next={params.get('next')} />;
  return <PasswordSignIn />;
}

/* ══ Password and two-step sign-in ═════════════════════════════════════ */

function PasswordSignIn() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  const signOut = useSession((s) => s.signOut);
  const current = useUser();
  useRegistry();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(keepSignedIn);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [pending, setPending] = useState<{ user: User; orgId: string; breakGlass?: boolean; bg?: BreakGlassInfo }>();
  const portal = usePortalSession();
  const [code, setCode] = useState('');
  const [ssoOpen, setSsoOpen] = useState(false);
  const [ssoAuto, setSsoAuto] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [ended, setEnded] = useState(() => takeEndedReason());
  const [refusal, setRefusal] = useState<Refusal>();

  const submitRef = useRef<HTMLButtonElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const lock = lockState(email, now);
  const locked = !!lock.lockedUntil;
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => { document.title = 'Sign in · Elan1 Govern'; }, []);
  // a session older than the organisation's lifetime is not offered as "Continue"
  useEffect(() => { const r = endExpiredSession(); if (r) setEnded(r); }, []);
  useEffect(() => { if (step === 'totp') window.setTimeout(() => codeRef.current?.focus(), 30); }, [step]);

  /** Refuse under the organisation's policy: back to the first step, password cleared, refusal recorded. */
  const refuse = (p: Refusal, user?: User, orgId?: string) => {
    setRefusal(p);
    setBusy(false);
    setStep('password');
    setPending(undefined);
    setPassword('');
    setCode('');
    if (user && orgId) recordRefusal(user.id, orgId, p, 'login');
  };

  const finish = (user: User, orgId: string, method: string) => {
    // the policy is asked again here: a suspension, SSO-only or SAML switch between the two steps still counts
    const p = policyFor(user, orgId, email);
    if (!p.ok) { refuse(p, user, orgId); return; }
    setKeepSignedIn(keep);
    // break-glass: an owner keeping a password under SAML, or an emergency-access grant (named on the receipt)
    const bgs = breakGlassSignIn(p.bg);
    const started = startSession(user, orgId, bgs ? `${method}${bgs.suffix}` : method, bgs ? bgs.details : {});
    const lim = sessionLimit(orgId, started.signedInAt);
    if (bgs) toast.held(`Signed in as ${user.name} with a password`, `${bgs.text}`);
    else if (lim) toast.ok(`Signed in as ${user.name}`, `Your organisation ends sessions after ${lim.label}. This one ends ${dateTime(new Date(lim.expiresAt).toISOString())}.`);
    nav(destination(user, next), { replace: true });
  };

  const openPortal = async (p: PortalAccount) => {
    const token = await portalTokenFor(p);
    if (!token) { setError(`${p.employer} has no live disclosure from its issuer right now. The issuer can share one from Assurance › Disclosure.`); return; }
    // a portal session of its own, recorded on the issuer's chain; it never opens the console
    startPortalSession(p);
    toast.ok(`Signed in to the ${PORTAL_INFO[p.kind].label.toLowerCase()} portal`, `${p.name} · ${p.employer}. Only what was shared with you is shown.`);
    nav(`/counterparty/${token}`, { replace: true });
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (locked || busy) return;
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setError(undefined);
    setRefusal(undefined);
    // SSO-only organisations: send the person to their identity provider before any password is tried
    const sso = ssoOnlyFor(email);
    if (sso && !sso.ok) { refuse(sso); return; }
    setBusy(true);
    try {
      const r = await checkPassword(email, password);
      if (r.kind === 'portal') { await openPortal(r.account); return; }
      if (r.kind === 'refused') { refuse(r.refusal, r.checked ? r.user : undefined, r.orgId); return; }
      setPending({ user: r.user, orgId: r.orgId, breakGlass: r.breakGlass, bg: r.bg });
      if (r.mfa) { setStep('totp'); setCode(''); }
      else finish(r.user, r.orgId, 'Password');
    } catch (err) {
      setError((err as Error).message);
      setNow(Date.now());
      if (err instanceof LockedError) setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e?: FormEvent, value?: string) => {
    e?.preventDefault();
    if (busy || !pending) return;
    const v = value ?? code;
    setBusy(true);
    setError(undefined);
    try {
      await checkSecondStep(email, pending.user, pending.orgId, v);
      finish(pending.user, pending.orgId, 'Password and 2-step code');
    } catch (err) {
      setError((err as Error).message);
      setCode('');
      setNow(Date.now());
      if (err instanceof LockedError) { setStep('password'); setPending(undefined); setPassword(''); }
      setBusy(false);
    }
  };

  const fill = (a: { email: string; password: string; id: string }) => {
    setEmail(a.email);
    setPassword(a.password);
    setPicked(a.id);
    setError(undefined);
    setRefusal(undefined);
    setStep('password');
    window.setTimeout(() => submitRef.current?.focus(), 20);
  };

  const lockLeft = locked ? Math.ceil((lock.lockedUntil! - now) / 1000) : 0;

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
              <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => { signOut(); toast.ok('Signed out', 'Your session ended and the sign-out was recorded as a receipt.'); }}>Sign out</Button>
              <Button size="sm" variant="primary" onClick={() => nav(destination(current, next))}>Continue</Button>
            </>
          }
        >
          {ROLE_INFO[current.role].label} · {current.email}
        </Banner>
      )}
      {portal && step === 'password' && (
        <Banner
          tone="neutral"
          className="mb-6"
          title={`Signed in to the ${PORTAL_INFO[portal.account.kind].label.toLowerCase()} portal as ${portal.account.name}`}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => { endPortalSession(); toast.ok('Signed out of the portal', 'Recorded on the issuer’s chain.'); }}>Sign out</Button>
              <Button size="sm" variant="primary" onClick={() => { void portalTokenFor(portal.account).then((t) => { if (t) nav(`/counterparty/${t}`); else setError(`${portal.account.employer} has no live disclosure from its issuer right now.`); }); }}>Open the portal</Button>
            </>
          }
        >
          {portal.account.employer} · {portal.account.email}
        </Banner>
      )}

      {step === 'password' ? (
        <>
          <AuthHeading kicker="Sign in" title="Sign in to Elan1 Govern">
            Use your work email. New organisation? <Link to="/signup" className="link">Create one</Link>.
          </AuthHeading>

          <form onSubmit={submitPassword} noValidate className="space-y-4" aria-describedby={error ? 'signin-error' : undefined}>
            <Field label="Work email" htmlFor="email">
              <Input id="email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); setPicked(undefined); setError(undefined); setRefusal(undefined); }} placeholder="name@company.com" invalid={!!error && !email} autoFocus />
            </Field>
            <Field label="Password" htmlFor="password" aside={<Link to="/forgot" className="text-sm text-muted hover:text-fg underline underline-offset-2">Forgot password?</Link>}>
              <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setPicked(undefined); }} invalid={!!error && !password} />
            </Field>
            <Checkbox checked={keep} onChange={(v) => { setKeep(v); setKeepSignedIn(v); }} label="Keep me signed in" description="On this browser. Untick it and closing the browser signs you out. A fresh sign-in is still asked for before approvals, the emergency stop and key rotation if the last one is older than 10 minutes." />

            {error && <div id="signin-error" role="alert"><Banner tone="bad">{error}</Banner></div>}
            {!error && refusal && <RefusalBanner refusal={refusal} onSso={() => { setSsoAuto(true); setSsoOpen(true); }} />}
            {!error && !refusal && lock.failures > 0 && !locked && <p className="text-xs text-muted">{lock.failures} failed attempt{lock.failures === 1 ? '' : 's'} for this email. {lock.left} left before a lock.</p>}

            <Button ref={submitRef} type="submit" variant="primary" size="lg" block loading={busy} disabled={locked} icon={!busy ? <LogIn className="h-4 w-4" /> : undefined}>
              {locked ? `Locked — try again in ${lockLeft >= 60 ? `${Math.ceil(lockLeft / 60)} min` : `${lockLeft}s`}` : 'Sign in'}
            </Button>
          </form>

          <OrRule>or</OrRule>

          <Button variant="secondary" block size="lg" icon={<Fingerprint className="h-4 w-4" />} onClick={() => { setSsoAuto(false); setSsoOpen(true); }} aria-haspopup="dialog">Sign in with single sign-on</Button>
          <p className="mt-2 text-xs text-muted">SAML 2.0 or OpenID Connect. Only the identity providers your organisation has connected are offered.</p>

          <DemoAccounts picked={picked} onPick={fill} />
        </>
      ) : (
        <TotpStep
          user={pending!.user}
          orgId={pending!.orgId}
          breakGlass={pending!.breakGlass}
          bg={pending!.bg}
          code={code}
          setCode={(v) => { setCode(v); setError(undefined); }}
          codeRef={codeRef}
          busy={busy}
          error={error}
          onSubmit={submitCode}
          onBack={() => { setStep('password'); setPending(undefined); setError(undefined); setCode(''); }}
        />
      )}

      <SsoDialog open={ssoOpen} initialEmail={email} autoFind={ssoAuto} onClose={() => setSsoOpen(false)} />
    </AuthLayout>
  );
}

function TotpStep({ user, orgId, breakGlass, bg, code, setCode, codeRef, busy, error, onSubmit, onBack }: {
  user: User; orgId: string; breakGlass?: boolean; bg?: BreakGlassInfo; code: string; setCode: (v: string) => void; codeRef: React.RefObject<HTMLInputElement>; busy: boolean; error?: string; onSubmit: (e?: FormEvent, value?: string) => void; onBack: () => void;
}) {
  const digits = code.padEnd(6, ' ').split('');
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);
  const { secret, enrolled } = useMemo(() => totpSecretFor(user.id, orgId), [user.id, orgId]);
  const step = totpStep();
  const demoCode = totpAt(secret, step);
  const left = 30 - Math.floor((Date.now() / 1000) % 30);
  return (
    <>
      <AuthHeading kicker="Step 2 of 2" title="Enter your 6-digit code">
        Open your authenticator app and enter the code for <span className="text-fg font-medium">{user.email}</span>. Codes change every 30 seconds and work once.
      </AuthHeading>
      {breakGlass && (() => {
        // which kind of break-glass: an owner keeping a password under SAML, or an emergency-access grant
        const bgs = breakGlassSignIn(bg ?? { via: 'owner', past: 'saml' });
        return (
          <Banner tone="held" className="mb-5" title={bgs?.title ?? 'Break-glass sign-in'}>
            {bgs?.text}
          </Banner>
        );
      })()}

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

        <section className="border border-dashed border-line-strong/70 bg-sunken/40 p-4" aria-labelledby="demo-auth">
          <div className="flex items-center justify-between gap-3">
            <p id="demo-auth" className="label">{enrolled ? 'Your enrolled authenticator (demo view)' : 'Demo authenticator for this account'}</p>
            <span className="text-xs text-muted num">{left}s</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="font-mono text-2xl tracking-[0.25em]" aria-live="polite">{demoCode}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setCode(demoCode); onSubmit(undefined, demoCode); }}>Use this code</Button>
          </div>
          <Meter value={left / 30} className="mt-2 h-1" label="Time left for this code" />
          <p className="mt-2 text-xs text-muted">Published for the demonstration so you can sign in without a phone. {enrolled ? 'It is computed from the authenticator you enrolled on the You page.' : 'Each account has its own secret; enrol your own authenticator on the You page.'}</p>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Use a different account</button>
          <span className="inline-flex items-center gap-1.5 text-muted"><Smartphone className="h-3.5 w-3.5" aria-hidden />Lost your device? Ask an owner to reset two-step sign-in.</span>
        </div>
      </form>
    </>
  );
}

/* ── Demo accounts, grouped by organisation and level ─────────────────── */

const ROLE_ORDER = ['owner', 'admin', 'approver', 'viewer', 'auditor'];

function DemoAccounts({ picked, onPick }: { picked?: string; onPick: (a: { email: string; password: string; id: string }) => void }) {
  const created = createdAccounts();
  const changed = changedPasswords();
  const [, force] = useState(0);
  // open each organisation's records after the page paints, one at a time, so the two-step, suspended and
  // SSO-only markers below come from the organisation's settings rather than the directory defaults
  useEffect(() => {
    let live = true;
    const ids = Array.from(new Set(DEMO_ACCOUNTS.map((a) => a.orgId))).filter((id) => !createdOrg(id));
    let i = 0;
    let t = 0;
    const step = () => {
      if (!live || i >= ids.length) return;
      try { orgState(ids[i++]); } catch { /* not available: the directory default stays */ }
      force((x) => x + 1);
      t = window.setTimeout(step, 0);
    };
    t = window.setTimeout(step, 150);
    const off = db.subscribe((_o, kind) => { if (live && (kind === 'member' || kind === 'sso' || kind === 'session' || kind === 'receipt')) force((x) => x + 1); });
    return () => { live = false; window.clearTimeout(t); off(); };
  }, []);
  const groups = LEVELS.map((lv) => {
    const accts = DEMO_ACCOUNTS.filter((a) => a.level === lv && a.role !== 'auditor' && !created.some((c) => c.userId === a.userId))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    const org = ORGS.find((o) => o.id === accts[0]?.orgId);
    return { lv, org, accts };
  }).filter((g) => g.accts.length);
  const auditor = DEMO_ACCOUNTS.find((a) => a.role === 'auditor');

  return (
    <section aria-labelledby="demo-accounts" className="mt-8 border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-line">
        <h3 id="demo-accounts" className="text-sm font-semibold">Demo accounts by assurance level</h3>
        <span className="text-xs text-muted">One click fills the form</span>
      </div>
      {changed.length > 0 && (
        <div className="px-4 py-3 border-b border-line">
          <Banner tone="held" title={`${changed.length} demo password${changed.length === 1 ? ' was' : 's were'} reset in this browser`}
            actions={<Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { restorePublishedPasswords(); force((x) => x + 1); toast.ok('Published demo passwords restored'); }}>Restore</Button>}>
            The buttons below fill the current password.
          </Banner>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.lv} className="border-b border-line last:border-b-0">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-sunken/60">
            <Badge tone="inverse">{LEVEL_INFO[g.lv].tag}</Badge>
            <span className="text-sm font-semibold">{LEVEL_INFO[g.lv].name}</span>
            <span className="text-xs text-muted inline-flex items-center gap-1 min-w-0"><Building2 className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{g.org?.name}</span></span>
            {g.org && ssoOnlyOrg(g.org.id) && <Badge tone="held">SSO only</Badge>}
            {g.org && samlOnlyOrg(g.org.id) && <Badge tone="held" title="Passwords are refused except for a break-glass owner with two-step sign-in">SAML required</Badge>}
          </div>
          <ul className="divide-y divide-line">
            {g.accts.map((a) => <AccountRow key={a.userId} a={a} on={picked === a.userId} onPick={onPick} />)}
          </ul>
        </div>
      ))}
      {auditor && (
        <div className="border-b border-line">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-sunken/60">
            <Badge>L1 · L2 · L3 · SOV</Badge>
            <span className="text-sm font-semibold">Auditor across all four</span>
          </div>
          <ul><AccountRow a={auditor} on={picked === auditor.userId} onPick={onPick} /></ul>
        </div>
      )}
      <div className="border-b border-line">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-sunken/60">
          <Badge>L3 portals</Badge>
          <span className="text-sm font-semibold">Counterparty, regulator and partner</span>
        </div>
        <ul className="divide-y divide-line">
          {PORTAL_ACCOUNTS.map((p) => {
            const on = picked === p.id;
            return (
              <li key={p.id}>
                <button type="button" onClick={() => onPick({ email: p.email, password: p.password, id: p.id })} aria-pressed={on}
                  className={cn('group w-full text-left px-4 py-3 flex items-start gap-3 transition-colors hover:bg-sunken/60 focus-visible:bg-sunken/60', on && 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--accent))]')}>
                  <Avatar initials={p.name.replace(/^R\. /, 'R ').split(' ').map((w) => w[0]).slice(0, 2).join('')} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone={on ? 'inverse' : 'neutral'}>{PORTAL_INFO[p.kind].label}</Badge>
                      <span className="text-sm font-semibold">{p.name}</span>
                    </span>
                    <span className="block text-xs text-muted mt-1">{p.title} · {p.employer}</span>
                    <span className="block text-[13px] text-fg/85 mt-1 leading-snug">{p.journey}</span>
                  </span>
                  <span className="shrink-0 mt-1 text-muted group-hover:text-fg" aria-hidden>{on ? <Check className="h-4 w-4 text-ok-fg" /> : <ArrowRight className="h-4 w-4" />}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {created.length > 0 && (
        <div className="border-b border-line">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-sunken/60">
            <Badge tone="accent">This browser</Badge>
            <span className="text-sm font-semibold">Accounts you created</span>
          </div>
          <ul className="divide-y divide-line">
            {created.map((a) => <AccountRow key={a.userId} a={a} on={picked === a.userId} onPick={onPick} />)}
          </ul>
        </div>
      )}
      <p className="px-4 py-3 text-xs text-muted bg-sunken/50">Demonstration accounts. Sign-in is simulated in this browser; accounts with two-step sign-in show their current code on the next step.</p>
    </section>
  );
}

function AccountRow({ a, on, onPick }: { a: DemoAccount; on: boolean; onPick: (a: { email: string; password: string; id: string }) => void }) {
  const u = userById(a.userId);
  if (!u) return null;
  const orgName = ORGS.find((o) => o.id === a.orgId)?.name;
  return (
    <li>
      <button type="button" onClick={() => onPick({ email: a.email, password: a.password, id: a.userId })} aria-pressed={on}
        className={cn('group w-full text-left px-4 py-3 flex items-start gap-3 transition-colors hover:bg-sunken/60 focus-visible:bg-sunken/60', on && 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--accent))]')}>
        <Avatar initials={u.initials} size={32} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={on ? 'inverse' : 'neutral'}>{ROLE_INFO[a.role].label}</Badge>
            <span className="text-sm font-semibold">{u.name}</span>
            {twoStepFor(a, u) && <span className="inline-flex items-center gap-1 text-[11px] text-muted" title="Two-step sign-in is on for this account"><KeyRound className="h-3 w-3" aria-hidden />2-step</span>}
            {(() => {
              // suspension is per organisation: someone with several (an auditor) still signs in to the others
              const off = u.orgIds.filter((o) => suspendedIn(o, a.userId));
              if (!off.length) return null;
              const all = off.length === u.orgIds.length;
              const names = off.map((o) => ORGS.find((x) => x.id === o)?.name ?? o).join(', ');
              return <span className="inline-flex items-center gap-1 text-[11px] text-bad-fg" title={all ? 'Suspended: sign-in is refused' : `Suspended in ${names}; the other organisations still open`}><Ban className="h-3 w-3" aria-hidden />{all ? 'Suspended' : `Suspended in ${off.length} of ${u.orgIds.length}`}</span>;
            })()}
          </span>
          <span className="block text-xs text-muted mt-1 truncate">{u.title}{a.role === 'auditor' ? ` · ${u.orgIds.length} client organisations` : orgName ? ` · ${orgName}` : ''}</span>
          <span className="block text-[13px] text-fg/85 mt-1 leading-snug">{a.journey}</span>
        </span>
        <span className="shrink-0 mt-1 text-muted group-hover:text-fg" aria-hidden>{on ? <Check className="h-4 w-4 text-ok-fg" /> : <ArrowRight className="h-4 w-4" />}</span>
      </button>
    </li>
  );
}

/* ══ Single sign-on: discovery by domain → the identity provider → the ACS ══ */

function SsoDialog({ open, initialEmail, autoFind, onClose }: { open: boolean; initialEmail: string; autoFind?: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [found, setFound] = useState<{ orgId: string; orgName: string; level: LevelId; providers: SsoProvider[] }>();

  useEffect(() => {
    if (!open) return;
    setEmail(initialEmail);
    setFound(undefined);
    setError(undefined);
    // sent here by an SSO-only refusal: look the organisation up straight away
    if (autoFind && !emailProblem(initialEmail)) void look(undefined, initialEmail);
  }, [open, initialEmail]);

  const look = async (e?: FormEvent, value?: string) => {
    e?.preventDefault();
    const addr = value ?? email;
    const p = emailProblem(addr);
    if (p) { setError(p); return; }
    setBusy(true);
    setError(undefined);
    setFound(undefined);
    try {
      const org = orgForEmail(addr);
      if (!org) throw new Error(`No organisation in Elan1 Govern uses ${addr.split('@')[1]}. Sign in with a password, or ask your administrator which address to use.`);
      const providers = await ssoProviders(org.id);
      setFound({ orgId: org.id, orgName: org.name, level: org.plan, providers });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const go = (p: SsoProvider) => {
    const st = beginSso(found!.orgId, email, p);
    const next = params.get('next');
    nav(`/login?sso=${st.state}${next ? `&next=${encodeURIComponent(next)}` : ''}`);
  };

  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Sign in with single sign-on" description="We find your organisation from your email domain and offer only the identity providers it has connected."
      footer={<Button variant="ghost" onClick={onClose}>{autoFind ? 'Close' : 'Use a password instead'}</Button>}>
      <form onSubmit={look} noValidate className="space-y-3">
        <Field label="Work email" htmlFor="sso-email">
          <div className="flex gap-2">
            <Input id="sso-email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setFound(undefined); setError(undefined); }} placeholder="name@company.com" data-autofocus />
            <Button type="submit" variant="primary" loading={busy}>Continue</Button>
          </div>
        </Field>
        {error && <Banner tone="bad">{error}</Banner>}
        {busy && <p className="text-sm text-muted inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Opening the organisation’s sign-in settings…</p>}
        {found && (
          <div className="border border-line">
            <p className="px-3 py-2 border-b border-line text-sm"><span className="font-semibold">{found.orgName}</span> <span className="text-muted">· {LEVEL_INFO[found.level].label}</span></p>
            {found.providers.length ? (
              <ul className="divide-y divide-line">
                {found.providers.map((p) => (
                  <li key={p.protocol}>
                    <button type="button" onClick={() => go(p)} className="w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-sunken/60">
                      <span className="inline-flex h-8 w-8 items-center justify-center border border-line bg-sunken"><Fingerprint className="h-4 w-4" aria-hidden /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">{p.label}</span>
                        <span className="block text-xs text-muted">{p.protocol === 'saml' ? 'SAML 2.0' : 'OpenID Connect'} · {p.host}{p.jit ? ` · new people are created on first sign-in${p.scim ? ' (SCIM)' : ''}` : ' · existing members only'}</span>
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-3 text-sm text-muted">{found.orgName} has not connected an identity provider. Use your password, or ask an owner to connect SAML or OpenID Connect in the Agents door, under Organisation.</p>
            )}
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** The identity provider's own page (simulated): the person authenticates there; it signs an assertion and returns. */
function IdentityProviderPage({ state }: { state: string }) {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const st = useMemo(() => ssoState(state), [state]);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof groupForPerson>>>();
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    document.title = `${st?.idp ?? 'Identity provider'} · sign in`;
    if (!st) return;
    groupForPerson(st.orgId, st.email).then((g) => {
      setInfo(g);
      setName(g.known?.name ?? '');
      setGroup(g.asserted ?? g.groups.find((x) => x.role === 'viewer')?.idpGroup ?? g.groups[0]?.idpGroup ?? '');
    }).catch((e: Error) => setError(e.message));
  }, [st]);

  if (!st) {
    return (
      <AuthLayout statement={<>Every action, answerable.</>}>
        <AuthHeading title="This sign-in request has ended">Single sign-on requests last 10 minutes and live in the tab that started them. Start again from the sign-in page.</AuthHeading>
        <Button variant="primary" onClick={() => nav('/login', { replace: true })}>Back to sign in</Button>
      </AuthLayout>
    );
  }

  const approve = () => {
    if (!info?.known && name.trim().length < 2) { setError('Enter your name as your directory holds it.'); return; }
    assertSso(state, { name: name || info?.known?.name || '', group });
    const next = params.get('next');
    nav(`/login?acs=${state}${next ? `&next=${encodeURIComponent(next)}` : ''}`, { replace: true });
  };

  return (
    <div className="min-h-screen bg-sunken flex flex-col">
      <div className="border-b border-line bg-surface px-4 py-2 text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-fg">https://{st.host}/{st.protocol === 'saml' ? 'sso/saml' : 'oauth2/v1/authorize'}</span>
        <Badge tone="held">Simulated identity provider</Badge>
        <span>This page stands in for {st.idp}. Elan1 Govern never sees your directory password.</span>
      </div>
      <main className="flex-1 grid place-items-center px-4 py-10">
        <div className="w-full max-w-[440px] border border-line bg-surface">
          <div className="px-6 pt-6 pb-4 border-b border-line">
            <p className="label">{st.idp}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tighter2">Sign in to continue to Elan1 Govern</h1>
            <p className="mt-1 text-sm text-muted break-all">{st.email}</p>
          </div>
          <div className="p-6 space-y-4">
            {!info && !error && <p className="text-sm text-muted inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Looking you up in the directory…</p>}
            {info && (
              <>
                {info.known ? (
                  <div className="flex items-center gap-3 border border-line p-3">
                    <Avatar initials={info.known.initials} size={32} />
                    <div className="min-w-0"><p className="text-sm font-semibold">{info.known.name}</p><p className="text-xs text-muted">{info.known.title}</p></div>
                  </div>
                ) : (
                  <Field label="Your name (directory)" htmlFor="idp-name" hint="Not in Elan1 Govern yet. The directory sends your name and groups.">
                    <Input id="idp-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                  </Field>
                )}
                <Field label="Group the directory asserts" htmlFor="idp-group" hint={info.known ? 'From the directory; mapped to your role in Elan1 Govern.' : 'Mapped to a role by the organisation’s group map.'}>
                  <Select id="idp-group" value={group} onChange={(e) => setGroup(e.target.value)} disabled={!!info.known}>
                    {info.groups.map((g) => <option key={g.idpGroup} value={g.idpGroup}>{g.idpGroup} → {ROLE_INFO[g.role].label}</option>)}
                  </Select>
                </Field>
                <dl className="text-xs text-muted grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt>{st.protocol === 'saml' ? 'Audience' : 'Client'}</dt><dd className="font-mono break-all">{st.entityId}</dd>
                  <dt>{st.protocol === 'saml' ? 'ACS URL' : 'Redirect'}</dt><dd className="font-mono break-all">{st.acsUrl}</dd>
                  <dt>{st.protocol === 'saml' ? 'RelayState' : 'state'}</dt><dd className="font-mono break-all">{st.state}</dd>
                </dl>
              </>
            )}
            {error && <Banner tone="bad">{error}</Banner>}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="primary" onClick={approve} disabled={!info}>Approve and continue</Button>
              <Button variant="ghost" onClick={() => nav('/login', { replace: true })}>Cancel</Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/** The assertion consumer: checks the response and signs the person in (creating them just in time when allowed). */
function AcsPage({ state, next }: { state: string; next: string | null }) {
  const nav = useNavigate();
  const [error, setError] = useState<string>();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    completeSso(state).then(({ user, created }) => {
      toast.ok(created ? `Welcome, ${user.name}` : `Signed in as ${user.name}`, created ? `Your account was created from the directory with the ${ROLE_INFO[user.role].label.toLowerCase()} role. Recorded as a receipt.` : 'Single sign-on. Recorded as a receipt.');
      nav(destination(user, next), { replace: true });
    }).catch((e: Error) => setError(e.message));
  }, [state, next, nav]);
  return (
    <AuthLayout statement={<>Every action, answerable.</>}>
      {error ? (
        <>
          <AuthHeading kicker="Single sign-on" title="Sign-in was not completed" />
          <Banner tone="bad">{error}</Banner>
          <Button className="mt-5" variant="primary" onClick={() => nav('/login', { replace: true })}>Back to sign in</Button>
        </>
      ) : (
        <div role="status" aria-live="polite">
          <AuthHeading kicker="Single sign-on" title="Checking the response from your identity provider" />
          <ul className="space-y-2 text-sm text-muted">
            <li className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />RelayState matches a request this browser sent; the assertion is fresh and unused.</li>
          </ul>
        </div>
      )}
    </AuthLayout>
  );
}
