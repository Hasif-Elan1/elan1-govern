import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import type { User } from '@/types';
import { DEMO_ACCOUNTS, userName } from '@/mock/users';
import { Banner, Button, Field, Input, Meter } from '@/components/ui';
import { LockedError, checkPassword, checkSecondStep, lockState, startSession, totpAt, totpSecretFor, totpStep } from './registry';
import { breakGlassSignIn, policyFor, recordRefusal, ssoOnlyFor, type BreakGlassInfo, type Refusal } from './signInPolicy';
import { RefusalBanner } from './RefusalBanner';

/**
 * Sign-in on a single-use approval link (/approve/:token). The same checks as /login, in a phone-sized form:
 * the lock after 5 failures, SSO-only domains, SAML required (break-glass owners excepted), suspension in the
 * link's organisation, and the two-step code. A real session is started (Sessions lists it) and auth.signed_in
 * is written on the organisation's chain.
 */
export function LinkSignIn({ orgId, issuedTo, approvalId, token, demo }: { orgId: string; issuedTo: string; approvalId: string; token: string; demo: boolean }) {
  // demo mode only: offer the demo account the link was sent to, or a demo approver of the link's organisation
  const demoAcct = demo ? (DEMO_ACCOUNTS.find((d) => d.userId === issuedTo) ?? DEMO_ACCOUNTS.find((d) => d.orgId === orgId && (d.role === 'approver' || d.role === 'owner'))) : undefined;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [refusal, setRefusal] = useState<Refusal>();
  const [pending, setPending] = useState<{ user: User; orgId: string; breakGlass?: boolean; bg?: BreakGlassInfo }>();
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => { if (pending) window.setTimeout(() => codeRef.current?.focus(), 30); }, [pending]);

  const lock = lockState(email, now);
  const locked = !!lock.lockedUntil;
  const lockLeft = locked ? Math.ceil((lock.lockedUntil! - now) / 1000) : 0;
  const next = encodeURIComponent(`/approve/${token}`);

  const refuse = (r: Refusal, user?: User, refusedOrg?: string) => {
    setRefusal(r);
    setPending(undefined);
    setPassword('');
    setCode('');
    if (user && refusedOrg) recordRefusal(user.id, refusedOrg, r, 'approval_link');
  };

  const finish = (user: User, inOrg: string, method: string) => {
    // asked again after the code: a suspension or SAML switch in between still counts
    const p = policyFor(user, inOrg, email);
    if (!p.ok) { refuse(p, user, inOrg); return; }
    // break-glass: an owner keeping a password under SAML, or an emergency-access grant (named on the receipt)
    const bgs = breakGlassSignIn(p.bg);
    startSession(user, inOrg, `${method}${bgs?.suffix ?? ''} · approval link`, { via: 'approval_link', approval: approvalId, ...(bgs ? bgs.details : {}) });
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || locked) return;
    setErr(undefined);
    setRefusal(undefined);
    const sso = ssoOnlyFor(email);
    if (sso && !sso.ok) { refuse(sso); return; }
    setBusy(true);
    try {
      const r = await checkPassword(email, password, { preferOrgId: orgId });
      if (r.kind === 'portal') { setErr('Portal accounts verify shared records; they cannot decide approvals. Sign in as the approver this link was sent to.'); return; }
      if (r.kind === 'refused') { refuse(r.refusal, r.checked ? r.user : undefined, r.orgId); return; }
      if (r.mfa) { setPending({ user: r.user, orgId: r.orgId, breakGlass: r.breakGlass, bg: r.bg }); setCode(''); }
      else finish(r.user, r.orgId, 'Password');
    } catch (x) {
      setErr((x as Error).message);
      setNow(Date.now());
      if (x instanceof LockedError) setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e?: FormEvent, value?: string) => {
    e?.preventDefault();
    if (busy || !pending) return;
    setBusy(true);
    setErr(undefined);
    try {
      await checkSecondStep(email, pending.user, pending.orgId, value ?? code);
      finish(pending.user, pending.orgId, 'Password and 2-step code');
    } catch (x) {
      setErr((x as Error).message);
      setCode('');
      setNow(Date.now());
      if (x instanceof LockedError) { setPending(undefined); setPassword(''); }
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    const { secret } = totpSecretFor(pending.user.id, pending.orgId);
    const demoCode = totpAt(secret, totpStep(now));
    const left = 30 - Math.floor((now / 1000) % 30);
    return (
      <form onSubmit={submitCode} className="border border-line bg-surface p-4 space-y-3" aria-label="Two-step code">
        <div>
          <p className="font-semibold">Enter your 6-digit code</p>
          <p className="mt-0.5 text-sm text-muted">From your authenticator app, for {pending.user.email}. Codes change every 30 seconds and work once; a wrong code counts towards the lock.</p>
        </div>
        {pending.breakGlass && (() => { const bgs = breakGlassSignIn(pending.bg ?? { via: 'owner', past: 'saml' }); return <Banner tone="held" title={bgs?.title ?? 'Break-glass sign-in'}>{bgs?.text}</Banner>; })()}
        <Field label="Authentication code" htmlFor="link-code" error={err}>
          <Input id="link-code" ref={codeRef} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} className="h-12 font-mono text-xl tracking-[0.3em]" invalid={!!err}
            onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); setErr(undefined); if (v.length === 6) window.setTimeout(() => submitCode(undefined, v), 60); }} />
        </Field>
        {demo && (
          <div className="border border-dashed border-line-strong bg-sunken/50 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-xs text-muted">Demo authenticator · {left}s</span>
                <span className="block font-mono text-lg tracking-[0.25em]">{demoCode}</span>
              </span>
              <button type="button" className="text-xs font-medium underline underline-offset-2 shrink-0" onClick={() => { setCode(demoCode); void submitCode(undefined, demoCode); }}>Use this code</button>
            </div>
            <Meter value={left / 30} className="mt-2 h-1" label="Time left for this code" />
          </div>
        )}
        <Button type="submit" variant="primary" block className="h-12 text-md" loading={busy} disabled={code.length !== 6} icon={<ShieldCheck className="h-4 w-4" aria-hidden />}>Verify and sign in</Button>
        <button type="button" onClick={() => { setPending(undefined); setErr(undefined); setCode(''); }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" aria-hidden />Use a different account</button>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="border border-line bg-surface p-4 space-y-3" aria-label="Sign in to decide" noValidate>
      <div>
        <p className="font-semibold">Sign in as {userName(issuedTo)} to decide</p>
        <p className="mt-0.5 text-sm text-muted">The link proves where the request came from; signing in proves it is you. The same checks as the sign-in page apply, including your two-step code.</p>
      </div>
      {demoAcct && (
        <button
          type="button"
          onClick={() => { setEmail(demoAcct.email); setPassword(demoAcct.password); setErr(undefined); setRefusal(undefined); }}
          className="w-full flex items-center justify-between gap-3 border border-dashed border-line-strong bg-sunken/50 px-3 py-2.5 text-left hover:border-fg"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium">{userName(demoAcct.userId)}</span>
            <span className="block text-xs text-muted truncate">Demonstration only · fills the demo account{demoAcct.userId !== issuedTo ? ' (not the person this link was sent to)' : ''}</span>
          </span>
          <span className="text-xs font-medium underline underline-offset-2 shrink-0">Fill</span>
        </button>
      )}
      <Field label="Work email" htmlFor="link-email">
        <Input id="link-email" type="email" autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); setErr(undefined); setRefusal(undefined); }} className="h-12" />
      </Field>
      <Field label="Password" htmlFor="link-pw" error={err}>
        <Input id="link-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-12" invalid={!!err} leading={<KeyRound className="h-4 w-4" aria-hidden />} />
      </Field>
      {refusal && <RefusalBanner id="link-refusal" refusal={refusal} />}
      {refusal && (refusal.kind === 'sso_only' || refusal.kind === 'saml_required') && (
        <Link to={`/login?next=${next}`} className="inline-flex items-center gap-1.5 text-sm link"><Fingerprint className="h-3.5 w-3.5" aria-hidden />Sign in with single sign-on, then come back to this link</Link>
      )}
      {!err && !refusal && lock.failures > 0 && !locked && <p className="text-xs text-muted">{lock.failures} failed attempt{lock.failures === 1 ? '' : 's'} for this email. {lock.left} left before a lock.</p>}
      <Button type="submit" variant="primary" block className="h-12 text-md" loading={busy} disabled={!email || !password || locked}>
        {locked ? `Locked — try again in ${lockLeft >= 60 ? `${Math.ceil(lockLeft / 60)} min` : `${lockLeft}s`}` : 'Sign in'}
      </Button>
      <p className="text-xs text-muted"><Link to="/forgot" className="underline underline-offset-2">Forgot password?</Link></p>
    </form>
  );
}
