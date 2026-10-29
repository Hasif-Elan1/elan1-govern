import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bot, Check, CheckCircle2, Hash as HashIcon, KeyRound, LayoutDashboard, Mail, MessageCircle, Plug, Plus, RotateCcw, Server, ShieldCheck, ShieldOff, Smartphone, X } from 'lucide-react';
import { api, db } from '@/api';
import { useOrgId, useUser } from '@/store/session';
import type { LevelId, PackId } from '@/types';
import { cn } from '@/lib/cn';
import { dateTime, n, plural, rupees, seqLabel } from '@/lib/format';
import { ROLE_INFO } from '@/lib/permissions';
import { PLANS, ADD_ONS, listPriceLine } from '@/lib/pricing';
import { ListPriceTag } from '@/features/billing/ListPriceTag';
import { LEVEL_INFO, capabilitiesAdded, levelRank } from '@/lib/levels';
import { Badge, Banner, Button, Checkbox, CodeBlock, DECISION_META, Dialog, Disc, Field, Input, KeyValue, Meter, ProductMark, RadioCards, Select, StatusChip, Switch, Toaster, toast } from '@/components/ui';
import { emailProblem } from '@/features/auth/password';
import { LevelChooser } from '@/features/auth/LevelChooser';
import { DemoOutbox } from '@/features/auth/Outbox';
import { createdOrg, pushMail, sendLocalWhatsAppCode, verifyLocalWhatsAppCode } from '@/features/auth/registry';
import { orgApi } from '@/features/settings/orgApi';
import { CURRENCIES, HIGH_RISK_NOTE, INDUSTRIES, REGIONS, REG_PACKS, REG_PROFILES, SIZES, TIMEZONES, frameworksFor, industryById } from './industries';
import { idpsFor, saveOnboarding, useOnboardingState, type CustodyChoice, type OnboardingState } from './state';
import { CUSTODY_LABEL, canRunSetup, completeOnboarding, roleIn } from './complete';
import { APPLICANT_REFUSALS, ELIGIBLE_LABEL, refusalFor, type ApplicantCategory } from './refusals';
import { recordApplicantRefusal } from '@/mock/devpath';

const ForbiddenPage = lazy(() => import('@/features/system/ForbiddenPage'));

type StepId = 'company' | 'assurance' | 'custody' | 'packs' | 'sovereign' | 'industry' | 'regions' | 'locale' | 'signin' | 'people' | 'done';

function stepsFor(level: LevelId): { id: StepId; label: string; hint: string }[] {
  const r = levelRank(level);
  return [
    { id: 'company', label: 'Company', hint: 'Who you are' },
    { id: 'assurance', label: 'Assurance and residency', hint: 'What you need to prove, and where data lives' },
    ...(r >= 1 ? [{ id: 'custody' as const, label: level === 'sovereign' ? 'Your HSM and timestamp authorities' : 'Key custody and timestamps', hint: 'Who holds the key; who timestamps' }] : []),
    { id: 'packs' as const, label: 'Regulatory packs and profiles', hint: r >= 1 ? 'ledger1, invoice1, collect1' : 'A dry run at L1, live from L2' },
    ...(level === 'sovereign' ? [{ id: 'sovereign' as const, label: 'Your deployment', hint: 'Cluster, database, storage, air gap' }] : []),
    { id: 'industry', label: 'Industry configuration', hint: 'Starter rulebook and frameworks' },
    { id: 'regions', label: 'Regions', hint: 'Where you operate' },
    { id: 'locale', label: 'Currency and time zone', hint: 'How figures and times read' },
    { id: 'signin', label: 'Sign-in: SAML and SCIM', hint: 'Your identity provider' },
    { id: 'people', label: 'Approvers and channels', hint: 'Who decides, and where' },
    { id: 'done', label: 'Done', hint: 'Your next 3 steps' },
  ];
}

/**
 * Set-up changes the organisation (frameworks, a starter rulebook and agent, invitations, an onboarding receipt),
 * so only owners and admins can open it. Every other role gets a Forbidden page that says why and who can help.
 */
export default function OnboardingPage() {
  const user = useUser();
  const orgId = useOrgId();
  const role = roleIn(orgId, user?.id);
  if (!canRunSetup(role)) return <SetupForbidden />;
  return <OnboardingWizard />;
}

function SetupForbidden() {
  useEffect(() => { document.title = 'Not allowed · Elan1 Govern'; }, []);
  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <header className="h-16 border-b border-line bg-surface">
        <div className="h-full flex items-center gap-4 px-4 sm:px-8">
          <ProductMark compact />
          <span className="hidden sm:inline label">Set-up</span>
          <Link to="/" className="ml-auto text-sm font-medium link">Back to the console</Link>
        </div>
      </header>
      <main className="flex-1 px-4 sm:px-8">
        <Suspense fallback={null}><ForbiddenPage /></Suspense>
      </main>
      <Toaster />
    </div>
  );
}

function OnboardingWizard() {
  const nav = useNavigate();
  const user = useUser();
  const orgId = useOrgId();
  const { state, patch, reset } = useOnboardingState(orgId, user?.id);
  const [tried, setTried] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const refusedLogged = useRef<string>();
  const steps = stepsFor(state.level);
  const last = steps.length - 1;
  const step = Math.min(Math.max(state.step, 0), last);
  const id = steps[step].id;
  const local = !!createdOrg(orgId);
  const orgLevel = api.levelOf(orgId);

  useEffect(() => { document.title = 'Set-up · Elan1 Govern'; }, []);

  const problem = (s: StepId, st: OnboardingState): string | undefined => {
    if (s === 'company' && st.company.name.trim().length < 2) return 'Enter your company’s name to continue.';
    if (s === 'company' && refusalFor(st.applicant)) return refusalFor(st.applicant)!.sentence;
    if (s === 'regions' && st.regions.length === 0) return 'Choose at least one region.';
    if (s === 'custody' && levelRank(st.level) >= 2 && st.holders.filter((h) => h.trim()).length < 3) return 'Name at least 3 key holders — the key ceremony needs a quorum of 3 of 5.';
    if (s === 'signin' && st.identity.saml && !/^https:\/\/\S+\.\S+/.test(st.identity.metadataUrl.trim())) return 'Enter your identity provider’s metadata URL (https://…).';
    if (s === 'assurance' && st.level === 'sovereign' && st.residency.trim().length < 3) return 'Say where your data centre is.';
    return undefined;
  };
  const current = problem(id, state);

  const go = (to: number) => {
    setTried(false);
    patch({ step: to, maxStep: Math.max(state.maxStep, to) });
    window.setTimeout(() => headingRef.current?.focus(), 30);
  };

  const finish = async () => {
    if (!user) return;
    setFinishing(true);
    setFinishError(undefined);
    try {
      const r = await completeOnboarding(orgId, state, user.id);
      patch({ completedAt: new Date().toISOString(), completedBy: user.id, receiptSeq: r.receiptSeq, result: { rulebookSlug: r.rulebookSlug, starterYaml: r.starterYaml, invites: r.invites, applied: r.applied, skipped: r.skipped }, step: last, maxStep: last });
      toast.ok('Set-up finished', r.receiptSeq !== undefined ? `Recorded as receipt ${seqLabel(r.receiptSeq)}.` : 'Saved with the organisation.');
      window.setTimeout(() => headingRef.current?.focus(), 30);
    } catch (e) {
      setFinishError((e as Error).message);
    } finally {
      setFinishing(false);
    }
  };

  const next = (e?: FormEvent) => {
    e?.preventDefault();
    if (current) {
      setTried(true);
      // a refused applicant category is recorded once, with the sentence it was shown
      const ref = id === 'company' ? refusalFor(state.applicant) : undefined;
      if (ref && user && refusedLogged.current !== ref.id) {
        refusedLogged.current = ref.id;
        try { recordApplicantRefusal(orgId, user.id, ref.id, 'onboarding'); } catch { /* the refusal is still shown */ }
      }
      return;
    }
    if (id === 'people') { void finish(); return; }
    if (step < last) go(step + 1);
  };

  const progress = step / last;

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <header className="sticky top-0 z-30 h-16 border-b border-line bg-surface/95 backdrop-blur-[2px]">
        <div className="h-full flex items-center gap-4 px-4 sm:px-8">
          <ProductMark compact />
          <span className="hidden sm:inline label">Set-up</span>
          <span className="ml-auto text-sm text-muted num" aria-live="polite">Step {step + 1} of {steps.length}</span>
          <Button size="sm" variant="ghost" onClick={() => { saveOnboarding(orgId, state, user?.id); toast.info('Progress saved', 'Saved with the organisation — set-up continues from this step on any device.'); nav('/'); }}>Save and exit</Button>
        </div>
        <Meter value={progress} tone="inverse" className="h-[3px] lg:hidden" label="Set-up progress" />
      </header>

      <div className="flex-1 lg:grid lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="hidden lg:block border-r border-line bg-surface">
          <div className="sticky top-16 p-8">
            <div className="flex items-center gap-4">
              <Disc kind="progress" size={56} value={Math.max(0.04, progress)} title={`${Math.round(progress * 100)}% of set-up done`} />
              <div>
                <p className="label">Set-up · {LEVEL_INFO[state.level].tag}</p>
                <p className="font-display text-2xl font-semibold num">{Math.round(progress * 100)}%</p>
              </div>
            </div>
            <ol className="mt-8 space-y-1" aria-label="Set-up steps">
              {steps.map((s, i) => {
                const reachable = i <= state.maxStep && (s.id !== 'done' || !!state.completedAt);
                const done = i < step || (s.id === 'done' && !!state.completedAt);
                const on = i === step;
                return (
                  <li key={s.id}>
                    <button type="button" disabled={!reachable} onClick={() => go(i)} aria-current={on ? 'step' : undefined}
                      className={cn('w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed', on ? 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--fg))]' : reachable ? 'hover:bg-sunken/60' : 'opacity-55')}>
                      <span className={cn('mt-0.5 h-5 w-5 shrink-0 inline-flex items-center justify-center border text-[11px] font-semibold num', done ? 'bg-fg border-fg text-canvas' : on ? 'border-fg text-fg' : 'border-line-strong text-muted')}>
                        {done ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className={cn('block text-sm', on ? 'font-semibold' : 'font-medium')}>{s.label}</span>
                        <span className="block text-xs text-muted">{s.hint}</span>
                      </span>
                      <span className="sr-only">{done ? '(done)' : on ? '(current)' : ''}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="mt-8 text-xs text-muted leading-relaxed">Progress is saved with the organisation{state.updatedAt ? ` (last ${dateTime(state.updatedAt)})` : ''}, so another admin or another device continues from the same step. Every choice can be changed later inside the doors.</p>
          </div>
        </aside>

        <form onSubmit={next} noValidate className="flex flex-col min-w-0">
          <main className="flex-1 px-4 sm:px-8 lg:px-14 py-8 lg:py-12">
            <div className="max-w-[860px]">
              <p className="label text-accent-fg mb-2 lg:hidden">Step {step + 1} · {steps[step].label}</p>
              {local && id !== 'done' && step === 0 && (
                <Banner tone="info" className="mb-6" title="A new organisation, made in this browser">
                  Everything you choose is saved with it. It starts empty, with a receipt chain of its own: the first receipt records that it was created, and every screen shows only this organisation’s records.
                </Banner>
              )}
              {id === 'company' && <CompanyStep state={state} patch={patch} tried={tried} error={current} headingRef={headingRef} />}
              {id === 'assurance' && <AssuranceStep state={state} patch={patch} tried={tried} error={current} headingRef={headingRef} orgLevel={orgLevel} isOwner={roleIn(orgId, user?.id) === 'owner'} />}
              {id === 'custody' && <CustodyStep state={state} patch={patch} tried={tried} error={current} headingRef={headingRef} />}
              {id === 'packs' && <PacksStep state={state} patch={patch} headingRef={headingRef} />}
              {id === 'sovereign' && <SovereignStep state={state} patch={patch} headingRef={headingRef} />}
              {id === 'industry' && <IndustryStep state={state} patch={patch} headingRef={headingRef} />}
              {id === 'regions' && <RegionsStep state={state} patch={patch} tried={tried} error={current} headingRef={headingRef} />}
              {id === 'locale' && <LocaleStep state={state} patch={patch} headingRef={headingRef} />}
              {id === 'signin' && <SignInStep state={state} patch={patch} tried={tried} error={current} headingRef={headingRef} orgId={orgId} local={local} />}
              {id === 'people' && <PeopleStep state={state} patch={patch} headingRef={headingRef} orgId={orgId} userId={user?.id ?? ''} userPhone={user?.phone} local={local} />}
              {id === 'done' && <DoneStep state={state} headingRef={headingRef} local={local} orgId={orgId}onRestart={() => { reset(); setTried(false); }} />}
              {finishError && <Banner tone="bad" className="mt-6" title="Set-up could not finish">{finishError}</Banner>}
            </div>
          </main>

          {id !== 'done' && (
            <footer className="sticky bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur-[2px]">
              <div className="flex flex-wrap items-center gap-3 px-4 sm:px-8 lg:px-14 py-3 max-w-[calc(860px+7rem)]">
                <Button type="button" variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => go(step - 1)} disabled={step === 0 || finishing}>Back</Button>
                {tried && current && <span className="text-sm text-bad-fg" role="alert">{current}</span>}
                <Button type="submit" variant="primary" className="ml-auto" loading={finishing} iconRight={!finishing ? <ArrowRight className="h-4 w-4" /> : undefined}>
                  {id === 'people' ? (state.completedAt ? 'Apply set-up again' : 'Finish set-up') : 'Continue'}
                </Button>
              </div>
            </footer>
          )}
        </form>
      </div>
      <Toaster />
    </div>
  );
}

type StepProps = { state: OnboardingState; patch: (p: Partial<OnboardingState>) => void; headingRef: React.RefObject<HTMLHeadingElement> };

function StepHeading({ title, children, headingRef }: { title: string; children?: ReactNode; headingRef: React.RefObject<HTMLHeadingElement> }) {
  return (
    <div className="mb-8">
      <h1 ref={headingRef} tabIndex={-1} className="text-3xl font-bold tracking-tighter2 leading-tight focus:outline-none">{title}</h1>
      {children && <p className="mt-2 max-w-[66ch] text-md text-muted leading-relaxed">{children}</p>}
    </div>
  );
}

/* ── Company ─────────────────────────────────────────────── */

function CompanyStep({ state, patch, tried, error, headingRef }: StepProps & { tried: boolean; error?: string }) {
  const c = state.company;
  const set = (p: Partial<OnboardingState['company']>) => patch({ company: { ...c, ...p } });
  return (
    <>
      <StepHeading title="Tell us about your company" headingRef={headingRef}>The name appears on receipts, evidence bundles and approval messages. The legal entity appears on invoices.</StepHeading>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Company name" htmlFor="ob-name" required error={tried && c.name.trim().length < 2 ? error : undefined} className="sm:col-span-2">
          <Input id="ob-name" value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="Shree Ganesh Traders" invalid={tried && c.name.trim().length < 2} autoFocus />
        </Field>
        <Field label="Legal entity" htmlFor="ob-legal" hint="As registered, for invoices. Optional now." className="sm:col-span-2">
          <Input id="ob-legal" value={c.legal} onChange={(e) => set({ legal: e.target.value })} placeholder="Shree Ganesh Traders Private Limited" />
        </Field>
      </div>
      <fieldset className="mt-6">
        <legend className="text-sm font-medium mb-2">People in the company</legend>
        <RadioCards name="size" value={c.size} onChange={(v) => set({ size: v })} cols={3} options={SIZES.map((s) => ({ value: s, label: s }))} />
      </fieldset>
      <Field label="Which describes you?" htmlFor="ob-applicant" hint="We onboard organisations whose agents act on their own systems. There are 8 kinds of applicant we refuse, and we say why in one sentence." className="mt-6">
        <Select id="ob-applicant" value={state.applicant ?? 'eligible'} onChange={(e) => patch({ applicant: e.target.value as ApplicantCategory })}>
          <option value="eligible">{ELIGIBLE_LABEL}</option>
          {APPLICANT_REFUSALS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </Select>
      </Field>
      {refusalFor(state.applicant) && (
        <Banner tone="bad" className="mt-4" title="We cannot set this up">
          {refusalFor(state.applicant)!.sentence}{refusalFor(state.applicant)!.instead && <> {refusalFor(state.applicant)!.instead}</>}
          {tried && <span className="block mt-1 text-xs">The refusal is recorded on the organisation’s chain.</span>}
        </Banner>
      )}
    </>
  );
}

/* ── Assurance and residency ─────────────────────────────── */

function AssuranceStep({ state, patch, tried, error, headingRef, orgLevel, isOwner }: StepProps & { tried: boolean; error?: string; orgLevel: LevelId; isOwner: boolean }) {
  const adds = levelRank(state.level) > levelRank(orgLevel) ? capabilitiesAdded(orgLevel, state.level) : [];
  const sov = state.level === 'sovereign';
  return (
    <>
      <StepHeading title="How much do you need to prove?" headingRef={headingRef}>Each level includes everything below it. Records keep the level they were made at, so moving up later never rewrites the past. Prices exclude GST; a refused action costs 40% of the per-action rate.</StepHeading>
      <LevelChooser value={state.level} onChange={(lv) => patch({ level: lv, residency: lv === 'sovereign' ? (state.residency.startsWith('ap-') ? '' : state.residency) : state.residency.startsWith('ap-') ? state.residency : 'ap-south-1 Mumbai', custody: lv === 'l2' ? 'aws_kms' : lv === 'l3' ? (state.custody === 'aws_kms' ? 'cloudhsm' : state.custody) : lv === 'sovereign' ? (state.custody === 'luna' ? 'luna' : 'nshield') : 'aws_kms' })} min={orgLevel} />
      {adds.length > 0 && (
        <section className="mt-6 border border-line bg-surface" aria-labelledby="adds-h">
          <div className="px-5 py-3 border-b border-line flex flex-wrap items-center justify-between gap-2">
            <h2 id="adds-h" className="text-md font-semibold">Moving from {LEVEL_INFO[orgLevel].label} to {LEVEL_INFO[state.level].label} adds {adds.length} capabilities</h2>
            <span className="text-xs text-muted num text-right">{rupees(PLANS[state.level].floorPerYear - PLANS[orgLevel].floorPerYear)} more a year<ListPriceTag planId={state.level} /></span>
          </div>
          <ul className="grid gap-px bg-line sm:grid-cols-2">{adds.map((c) => <li key={c.id} className="bg-surface px-5 py-2.5 text-sm"><span className="font-medium">{c.label}.</span> <span className="text-muted">{c.description}</span></li>)}</ul>
          <p className="px-5 py-3 border-t border-line text-xs text-muted">{isOwner ? 'Applied when you finish set-up; the boundary is recorded as a receipt.' : 'Only an owner can raise the level. Your choice is saved and an owner confirms it in the Assurance door, under Assurance levels.'} <Link to={`/assurance/upgrade?to=${state.level}`} className="link">See the upgrade plan</Link></p>
        </section>
      )}

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        {sov ? (
          <Field label="Where your data centre is" htmlFor="ob-res" required error={tried ? error : undefined} hint="Everything runs there: no record, key or log leaves your network." className="sm:col-span-2">
            <Input id="ob-res" value={state.residency} onChange={(e) => patch({ residency: e.target.value })} placeholder="Mumbai — primary BKC, disaster recovery Navi Mumbai" invalid={tried && !!error} />
          </Field>
        ) : (
          <Field label="Data residency" htmlFor="ob-res" hint="Receipts, seals, bundles, backups and keys stay in this domain. Timestamp requests send only a 32-byte Merkle root." className="sm:col-span-2">
            <Select id="ob-res" value={state.residency} onChange={(e) => patch({ residency: e.target.value })}>
              <option value="ap-south-1 Mumbai">India — AWS ap-south-1 (Mumbai)</option>
              <option value="ap-south-2 Hyderabad">India — AWS ap-south-2 (Hyderabad)</option>
            </Select>
          </Field>
        )}
      </div>

      <Banner tone={levelRank(state.level) >= 1 ? 'info' : 'neutral'} className="mt-6" title={levelRank(state.level) >= 1 ? 'Dual control is enforced from L2' : 'Dual control at L1 is recorded, not enforced'}>
        {levelRank(state.level) >= 1 ? 'A rulebook is published only after a different person approves its review. The person who reviewed it cannot also publish it.' : 'At L1 the reviewer of a rulebook is recorded on the publish receipt. From L2 a second person must approve before anyone can publish.'}
      </Banner>
      {levelRank(state.level) === 0 && (
        <Banner tone="neutral" className="mt-3" title="What L1 records are">
          Every decision is sealed in a hash chain by Elan1 Govern and can be checked offline; it is not yet externally timestamped. From L2 each record is also signed with a key in AWS KMS and timestamped by two authorities.
        </Banner>
      )}
      {levelRank(state.level) >= 2 && (
        <Banner tone="info" className="mt-3" title="Autonomy is earned, never set">
          No setting or person sets an agent’s autonomy directly. An agent reaches A3 for an action class only through a two-person graduation — at least 90 days, 200 records and 100 approvals for that class, proposed by one person and approved by another — followed by a 30-day supervised period that samples 1 in 10 calls. Revoking is one press by one person. A4 and A5 are not yet available.
        </Banner>
      )}
    </>
  );
}

/* ── Key custody and timestamps ──────────────────────────── */

function CustodyStep({ state, patch, tried, error, headingRef }: StepProps & { tried: boolean; error?: string }) {
  const lv = state.level;
  const customer = levelRank(lv) >= 2;
  const options: { value: CustodyChoice; label: string; description: string }[] = lv === 'sovereign'
    ? [{ value: 'nshield', label: 'Entrust nShield', description: 'In your data centre. FIPS 140-3 Level 3.' }, { value: 'luna', label: 'Thales Luna', description: 'In your data centre. FIPS 140-3 Level 3.' }]
    : [{ value: 'cloudhsm', label: 'AWS CloudHSM', description: 'A cluster in your AWS account, ap-south-1.' }, { value: 'luna', label: 'Thales Luna', description: 'Network HSM you operate.' }, { value: 'nshield', label: 'Entrust nShield', description: 'Network HSM you operate.' }];
  return (
    <>
      <StepHeading title={customer ? 'Your keys, your HSM' : 'Key custody and timestamps'} headingRef={headingRef}>
        {customer ? 'The signing key is created in your HSM in a key ceremony and never leaves it. Elan1 Govern asks the HSM to sign; you can withdraw that at any time.' : 'At L2 the signing key lives in AWS KMS in your residency domain and is used only by Elan1 Govern. Every 15-minute batch is timestamped by two independent authorities.'}
      </StepHeading>

      {customer ? (
        <>
          <fieldset><legend className="text-sm font-medium mb-2">HSM</legend>
            <RadioCards name="custody" value={state.custody} onChange={(v) => patch({ custody: v })} cols={lv === 'sovereign' ? 2 : 3} options={options} />
          </fieldset>
          <fieldset className="mt-6">
            <legend className="text-sm font-medium">Key holders for the ceremony</legend>
            <p className="mt-1 mb-3 text-xs text-muted">5 named holders; any 3 together can generate or rotate the key. Each is recorded on the ceremony receipt.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {state.holders.map((h, i) => (
                <Input key={i} aria-label={`Key holder ${i + 1}`} value={h} onChange={(e) => { const hs = [...state.holders]; hs[i] = e.target.value; patch({ holders: hs }); }} placeholder={['Chief Technology Officer', 'Head of IT Risk', 'Chief Information Security Officer', 'Internal audit', 'Company secretary'][i]} invalid={tried && !!error && !h.trim() && i < 3} />
              ))}
            </div>
            {tried && error && <p className="mt-2 text-sm text-bad-fg" role="alert">{error}</p>}
          </fieldset>
        </>
      ) : (
        <div className="border border-fg bg-surface p-5 shadow-[inset_0_0_0_1px_rgb(var(--fg))]">
          <p className="flex items-center gap-2 text-md font-semibold"><KeyRound className="h-4 w-4" aria-hidden />{CUSTODY_LABEL.aws_kms}</p>
          <p className="mt-1 text-sm text-muted">Ed25519, rotated every 90 days. The key reference and every rotation are recorded as receipts. Customer-held keys start at L3.</p>
        </div>
      )}

      <section className="mt-8" aria-labelledby="tsa-h">
        <h2 id="tsa-h" className="text-lg font-semibold">Timestamp authorities (RFC 3161)</h2>
        <p className="mt-1 mb-3 text-sm text-muted">Two authorities sign each batch’s Merkle root within 15 minutes; if one is late the other still holds the time.</p>
        {lv === 'sovereign' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Field key={i} label={`Local authority ${i + 1}`} htmlFor={`tsa-${i}`}>
                <Input id={`tsa-${i}`} value={state.localTsas[i]} onChange={(e) => { const t = [...state.localTsas] as [string, string]; t[i] = e.target.value; patch({ localTsas: t }); }} />
              </Field>
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border border-line bg-surface p-4"><p className="label">India</p><p className="mt-1 font-medium">eMudhra TSA</p><p className="text-xs text-muted">Licensed certifying authority under the IT Act.</p></div>
            <Field label="Global authority" htmlFor="tsa-g">
              <Select id="tsa-g" value={state.globalTsa} onChange={(e) => patch({ globalTsa: e.target.value })}>
                {['DigiCert Timestamp Authority', 'GlobalSign Timestamping', 'Sectigo Time Stamping'].map((x) => <option key={x}>{x}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </section>
    </>
  );
}

/* ── Regulatory packs and verifier profiles ──────────────── */

function PacksStep({ state, patch, headingRef }: StepProps) {
  // A verifier profile is billed as its own line; choosing a pack never adds or includes its profile.
  const toggle = (id: PackId, on: boolean) => patch({ packs: on ? [...state.packs, id] : state.packs.filter((x) => x !== id) });
  const profileAddOn = ADD_ONS.find((a) => a.id === 'profile');
  const dryRun = levelRank(state.level) < 1;
  return (
    <>
      <StepHeading title="Regulatory packs and verifier profiles" headingRef={headingRef}>A pack is a declaration and a regime export under one dated obligation, admitted only through five gates. {dryRun ? <>At L1 a pack installs as a <strong>dry run</strong>: its rules run and its reports say “dry run — no regulatory claim until L2”. It goes live, at {rupees(REG_PACKS[0].price)} a pack a year, when you move to L2.</> : <>{rupees(REG_PACKS[0].price)} a pack a year.</>} Skip this and add them later in the Records door, under Regulatory packs.</StepHeading>
      <div className="space-y-4">
        {REG_PACKS.map((p) => {
          const on = state.packs.includes(p.id);
          const suits = p.suits(state.industry, state.regions);
          return (
            <section key={p.id} className={cn('border bg-surface', on ? 'border-fg shadow-[inset_0_0_0_1px_rgb(var(--fg))]' : 'border-line')}>
              <div className="p-5">
                <div className="flex flex-wrap items-start gap-3">
                  <Checkbox checked={on} onChange={(v) => toggle(p.id, v)} label={<span className="font-mono text-md font-semibold">{p.name}</span>} description={p.regime} />
                  <span className="ml-auto flex flex-wrap gap-1.5">{suits && <Badge tone="info">Suits {industryById(state.industry).short.toLowerCase()} in India</Badge>}{dryRun ? <Badge>Dry run at L1</Badge> : <Badge>{rupees(p.price)} a year</Badge>}</span>
                </div>
                <p className="mt-2 text-sm text-fg/85 max-w-[72ch]">{p.summary}</p>
                <p className="mt-2 text-xs text-muted">Checked against the verifier profile <span className="text-fg">{p.profile?.name}</span> ({p.profile?.status}), billed separately · governed writes: <span className="font-mono">{p.starterRules.join(', ')}</span></p>
              </div>
              <ul className="grid gap-px border-t border-line bg-line sm:grid-cols-5">
                {p.gates.map((g) => (
                  <li key={g.id} className="bg-surface px-3 py-2">
                    <p className="text-xs font-semibold inline-flex items-center gap-1"><Check className="h-3 w-3 text-ok-fg" aria-hidden />{g.id} · {g.label}</p>
                    <p className="mt-0.5 text-[11.5px] text-muted leading-snug">{g.evidence}</p>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <section className="mt-8" aria-labelledby="prof-h">
        <h2 id="prof-h" className="text-lg font-semibold">Verifier profiles per regime</h2>
        <p className="mt-1 mb-3 text-sm text-muted">From L2 the verifier checks your bundles against each profile you choose. A profile is billed as its own line — {rupees(profileAddOn?.price ?? 300000)} a year per regime — and is not included with a pack.{dryRun ? ' At L1 your choice is saved and takes effect when you move to L2.' : ''}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {REG_PROFILES.map((p) => {
            const forPack = REG_PACKS.some((x) => state.packs.includes(x.id) && x.profile?.id === p.id);
            const on = state.profiles.includes(p.id);
            return (
              <div key={p.id} className={cn('border p-3 bg-surface', on ? 'border-fg' : 'border-line')}>
                <Checkbox checked={on} onChange={(v) => patch({ profiles: v ? [...state.profiles, p.id] : state.profiles.filter((x) => x !== p.id) })}
                  label={<>{p.name}{forPack && <Badge className="ml-2" tone="info">Checks {p.packId}</Badge>}</>} description={`${p.jurisdiction} · ${p.status === 'certified' ? 'issued' : 'draft'}`} />
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

/* ── Sovereign deployment checklist ──────────────────────── */

const SOV_CHECKS: { id: string; label: string; detail: string }[] = [
  { id: 'k8s', label: 'Kubernetes cluster ready', detail: '3 control-plane nodes and at least 3 workers across two zones.' },
  { id: 'pg', label: 'PostgreSQL 16 with row-level security', detail: 'Primary and a synchronous replica; RLS on every tenant table.' },
  { id: 'openbao', label: 'OpenBao for secrets', detail: 'Unsealed by Shamir shares, 3 of 5 holders.' },
  { id: 'objlock', label: 'Object-lock storage', detail: 'A bucket in compliance mode, 8-year retention.' },
  { id: 'hsm', label: 'HSM partition', detail: 'FIPS 140-3 Level 3; the signing key is created in the key ceremony.' },
  { id: 'tsa', label: 'Two local timestamp authorities reachable', detail: 'RFC 3161 over the internal network only.' },
  { id: 'airgap', label: 'Air-gapped update procedure', detail: 'Signed update bundles on media; verified against the elan1 release key before staging.' },
  { id: 'egress', label: 'Egress denied by default', detail: 'An empty allow-list. No telemetry leaves your network.' },
];

function SovereignStep({ state, patch, headingRef }: StepProps) {
  const sv = state.sovereign;
  const done = SOV_CHECKS.filter((c) => sv.checks[c.id]).length;
  return (
    <>
      <StepHeading title="Your deployment" headingRef={headingRef}>Sovereign runs Elan1 Govern on your infrastructure. The same receipts and the same verifier; you hold every key. Tick what your team has ready — the list is recorded and the deployment page tracks the rest.</StepHeading>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Kubernetes distribution" htmlFor="sov-k8s">
          <Select id="sov-k8s" value={sv.distribution} onChange={(e) => patch({ sovereign: { ...sv, distribution: e.target.value } })}>
            {['Red Hat OpenShift 4.16', 'Rancher RKE2 1.30', 'Upstream Kubernetes 1.30', 'VMware Tanzu 2.5'].map((x) => <option key={x}>{x}</option>)}
          </Select>
        </Field>
        <fieldset><legend className="text-sm font-medium mb-1.5">Object-lock storage</legend>
          <RadioCards name="sov-store" cols={3} value={sv.storage} onChange={(v) => patch({ sovereign: { ...sv, storage: v } })} options={[{ value: 'Ceph', label: 'Ceph' }, { value: 'SeaweedFS', label: 'SeaweedFS' }, { value: 'Garage', label: 'Garage' }]} />
        </fieldset>
      </div>
      <section className="mt-8 border border-line bg-surface" aria-labelledby="sov-h">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-2">
          <h2 id="sov-h" className="text-md font-semibold inline-flex items-center gap-2"><Server className="h-4 w-4" aria-hidden />Readiness</h2>
          <span className="text-sm text-muted num" aria-live="polite">{done} of {SOV_CHECKS.length} ready</span>
        </div>
        <ul className="divide-y divide-line">
          {SOV_CHECKS.map((c) => (
            <li key={c.id} className="px-5 py-3"><Checkbox checked={!!sv.checks[c.id]} onChange={(v) => patch({ sovereign: { ...sv, checks: { ...sv.checks, [c.id]: v } } })} label={c.label} description={c.detail} /></li>
          ))}
        </ul>
        <Meter value={done / SOV_CHECKS.length} className="h-1" label="Readiness" />
      </section>
    </>
  );
}

/* ── Industry ────────────────────────────────────────────── */

function IndustryStep({ state, patch, headingRef }: StepProps) {
  const sel = industryById(state.industry);
  return (
    <>
      <StepHeading title="Choose an industry configuration" headingRef={headingRef}>It sets your starter rulebook, the frameworks you track and the wording of risk questions. {levelRank(state.level) >= 1 ? 'Nothing is published until a person signs it.' : 'Nothing is published until a person reviews and publishes it.'}</StepHeading>
      <RadioCards name="industry" value={state.industry} onChange={(v) => patch({ industry: v })} cols={2}
        options={INDUSTRIES.map((i) => ({
          value: i.id, label: i.label, aside: i.highRisk ? <Badge tone="held">High-risk use</Badge> : undefined,
          description: (<>
            <span className="block">{i.starter}</span>
            <span className="mt-2 flex flex-wrap gap-1">{['ISO 42001', 'NIST AI RMF', ...i.frameworks].map((f) => <Badge key={f}>{f}</Badge>)}</span>
            {i.highRisk && <span className="mt-2 block text-held-fg">{HIGH_RISK_NOTE}</span>}
          </>),
        }))} />
      <section className="mt-8 border border-line bg-surface" aria-labelledby="starter-title">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 border-b border-line">
          <h2 id="starter-title" className="text-lg font-semibold">Starter rulebook · {sel.short}</h2>
          <span className="text-xs text-muted">Default: refuse anything not written down</span>
        </div>
        <ul className="divide-y divide-line">
          {sel.rules.map((r, i) => {
            const m = DECISION_META[r.decide];
            return <li key={i} className="flex items-center gap-3 px-5 py-2.5"><StatusChip tone={m.tone} size="sm" icon={m.icon}>{m.label}</StatusChip><span className="text-sm">{r.text}</span></li>;
          })}
        </ul>
        {sel.highRisk && <div className="px-5 pb-4"><Banner tone="held">{HIGH_RISK_NOTE}</Banner></div>}
      </section>
    </>
  );
}

/* ── Regions ─────────────────────────────────────────────── */

function RegionsStep({ state, patch, tried, error, headingRef }: StepProps & { tried: boolean; error?: string }) {
  const fw = frameworksFor(state.industry, state.regions);
  return (
    <>
      <StepHeading title="Where do you operate?" headingRef={headingRef}>Each region adds the frameworks that apply there. ISO/IEC 42001 and the NIST AI RMF are always on.</StepHeading>
      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Regions">
        {REGIONS.map((r) => {
          const on = state.regions.includes(r.id);
          return (
            <div key={r.id} className={cn('border p-4 transition-colors', on ? 'border-fg bg-surface shadow-[inset_0_0_0_1px_rgb(var(--fg))]' : 'border-line bg-surface')}>
              <Checkbox checked={on} onChange={(v) => patch({ regions: v ? [...state.regions, r.id] : state.regions.filter((x) => x !== r.id) })} label={r.label} description={r.note} />
              <div className="mt-3 pl-[26px] flex flex-wrap gap-1">{r.frameworks.map((f) => <Badge key={f} tone={on ? 'info' : 'neutral'}>{f}</Badge>)}</div>
            </div>
          );
        })}
      </div>
      {tried && error && <p className="mt-3 text-sm text-bad-fg" role="alert">{error}</p>}
      <section className="mt-8 border border-line bg-sunken/50 p-5" aria-live="polite">
        <p className="label">Frameworks that will be enabled · {fw.length}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">{fw.map((f) => <Badge key={f} tone="inverse">{f}</Badge>)}</div>
        <p className="mt-4 text-sm text-muted">Enabling a framework maps your receipts to its requirements so coverage can be counted. Coverage is a count of receipts, not a test that a control works, and not a claim of compliance.</p>
      </section>
    </>
  );
}

/* ── Currency and time zone ──────────────────────────────── */

function LocaleStep({ state, patch, headingRef }: StepProps) {
  const cur = CURRENCIES.find((c) => c.id === state.currency)!;
  const tzLabel = TIMEZONES.find((t) => t.id === state.timezone)?.label ?? state.timezone;
  const plan = PLANS[state.level];
  let sampleTime = '';
  try {
    sampleTime = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: state.timezone, timeZoneName: 'short' }).format(new Date());
  } catch { sampleTime = dateTime(new Date().toISOString()); }
  return (
    <>
      <StepHeading title="Currency and time zone" headingRef={headingRef}>Used for amounts in rules and approvals and the times on receipts. Receipts always store UTC; the console shows your time zone.</StepHeading>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Currency" htmlFor="ob-cur" hint="Defaults to Indian rupees with Indian digit grouping.">
          <Select id="ob-cur" value={state.currency} onChange={(e) => patch({ currency: e.target.value as OnboardingState['currency'] })}>{CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
        </Field>
        <Field label="Time zone" htmlFor="ob-tz" hint="Defaults to India Standard Time.">
          <Select id="ob-tz" value={state.timezone} onChange={(e) => patch({ timezone: e.target.value })}>{TIMEZONES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select>
        </Field>
      </div>
      <div className="mt-8 grid gap-px bg-line border border-line sm:grid-cols-3">
        <div className="bg-surface p-4"><p className="label">An amount</p><p className="mt-1 font-display text-2xl font-semibold num">{cur.sample}</p></div>
        <div className="bg-surface p-4"><p className="label">A time</p><p className="mt-1 text-md font-medium num">{sampleTime}</p></div>
        <div className="bg-surface p-4"><p className="label">A count</p><p className="mt-1 font-display text-2xl font-semibold num">{state.currency === 'INR' ? n(1234567) : new Intl.NumberFormat('en-GB').format(1234567)}</p></div>
      </div>
      <p className="mt-3 text-xs text-muted">{tzLabel}. Billing for Elan1 Govern is in rupees: your {plan.name} floor of {rupees(plan.floorPerYear)} a year reads the same everywhere in the console ({listPriceLine(plan.id)}).</p>
    </>
  );
}

/* ── Sign-in: SAML and SCIM ──────────────────────────────── */

function SignInStep({ state, patch, tried, error, headingRef, orgId, local }: StepProps & { tried: boolean; error?: string; orgId: string; local: boolean }) {
  const [ids, setIds] = useState<{ entityId: string; acsUrl: string; scimEndpoint: string }>();
  // Sovereign: deny-all egress — the console answers on the bank's own domain and only internal identity providers are offered
  const sov = state.level === 'sovereign';
  const idpOptions = idpsFor(state.level);
  useEffect(() => {
    if (local) {
      const c = createdOrg(orgId);
      const slug = c?.slug ?? 'org';
      const ownDomain = (c as { domain?: string } | undefined)?.domain ?? db.getDB(orgId).org.domain ?? `${slug}.in`;
      const base = sov ? `https://govern.${ownDomain}` : 'https://govern.elan1.ai';
      setIds({ entityId: `${base}/saml/${slug}`, acsUrl: `${base}/saml/${slug}/acs`, scimEndpoint: `${base}/scim/v2/${slug}` });
      return;
    }
    api.identityConfig(orgId).then((c) => {
      // a seeded organisation's own identity settings, unless set-up is choosing Sovereign for an organisation that is still hosted
      const own = (u: string) => (sov && /\/\/govern\.elan1\.ai\//.test(u) ? u.replace('//govern.elan1.ai/', `//govern.${db.getDB(orgId).org.domain ?? `${db.getDB(orgId).org.slug}.in`}/`) : u);
      setIds({ entityId: own(c.saml.entityId), acsUrl: own(c.saml.acsUrl), scimEndpoint: own(c.scim.endpoint) });
      const savedIdp = c.saml.idp.replace(/ \(on premises\)$/, '');
      if (!state.identity.metadataUrl && c.saml.enabled && (!sov || idpsFor(state.level).includes(savedIdp))) patch({ identity: { ...state.identity, saml: c.saml.enabled, idp: savedIdp, metadataUrl: c.saml.metadataUrl, scim: c.scim.enabled } });
    }).catch(() => undefined);
  }, [orgId, local, sov]);
  const idn = state.identity;
  const set = (p: Partial<OnboardingState['identity']>) => patch({ identity: { ...idn, ...p } });
  // a level changed to Sovereign after a hosted provider was picked: fall back to Keycloak
  useEffect(() => { if (!idpOptions.includes(idn.idp)) set({ idp: idpOptions[0] }); }, [state.level]);
  return (
    <>
      <StepHeading title="Sign-in: SAML and SCIM" headingRef={headingRef}>Let people sign in with your identity provider and keep membership in step with your directory. Passwords with two-step codes keep working until you require single sign-on. Applied at the end by an owner.</StepHeading>
      <div className="space-y-6">
        <section className="border border-line bg-surface p-5">
          <Switch checked={idn.saml} onChange={(v) => set({ saml: v })} label="Single sign-on with SAML 2.0" />
          {idn.saml && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Identity provider" htmlFor="idp">
                <Select id="idp" value={idpOptions.includes(idn.idp) ? idn.idp : idpOptions[0]} onChange={(e) => set({ idp: e.target.value })}>{idpOptions.map((x) => <option key={x}>{x}</option>)}</Select>
              </Field>
              <Field label="Metadata URL" htmlFor="idp-meta" required error={tried ? error : undefined} hint={sov ? 'From your identity provider inside the network, for example Keycloak’s realm descriptor.' : 'From your identity provider’s SAML app.'}>
                <Input id="idp-meta" value={idn.metadataUrl} onChange={(e) => set({ metadataUrl: e.target.value })} placeholder={sov ? 'https://sso.bank.internal/realms/bank/protocol/saml/descriptor' : 'https://login.example.com/app/saml/metadata'} invalid={tried && !!error} mono />
              </Field>
              {sov && <p className="sm:col-span-2 text-sm text-muted">A Sovereign deployment denies all egress, so cloud providers such as Okta, Entra ID and Google Workspace cannot be reached. Sign-in uses an identity provider inside your network, on .internal, .local, .lan, a private address or your own domain.</p>}
              {ids && (
                <dl className="sm:col-span-2 grid gap-2 text-sm">
                  <div><dt className="label">Entity ID (give this to your IdP)</dt><dd className="font-mono text-[12.5px] break-all">{ids.entityId}</dd></div>
                  <div><dt className="label">ACS URL</dt><dd className="font-mono text-[12.5px] break-all">{ids.acsUrl}</dd></div>
                </dl>
              )}
            </div>
          )}
        </section>
        <section className="border border-line bg-surface p-5">
          <Switch checked={idn.scim} onChange={(v) => set({ scim: v })} label="Provision people with SCIM 2.0" />
          <p className="mt-2 text-sm text-muted">Your directory creates, updates and removes members and maps its groups to roles (Govern-Owners, Govern-Admins, Govern-Approvers, Govern-Viewers). Someone removed in the directory loses access at the next sync.</p>
          {idn.scim && ids && <p className="mt-2 text-sm">Endpoint: <span className="font-mono text-[12.5px] break-all">{ids.scimEndpoint}</span> — the bearer token is shown once, in the Agents door under Organisation.</p>}
        </section>
      </div>
    </>
  );
}

/* ── Approvers and channels ──────────────────────────────── */

function PeopleStep({ state, patch, headingRef, orgId, userId, userPhone, local }: StepProps & { orgId: string; userId: string; userPhone?: string; local: boolean }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OnboardingState['invites'][number]['role']>('approver');
  const [emailErr, setEmailErr] = useState<string>();
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [slackFlow, setSlackFlow] = useState<{ state: string } | undefined>();
  const [workspace, setWorkspace] = useState('');
  // Sovereign: deny-all egress, so Slack and WhatsApp are never set up (approvals go by email through the internal relay)
  const sov = state.level === 'sovereign';
  const NO_CHAT = 'A Sovereign deployment denies all egress: Slack and WhatsApp are not available. Approvals go by email through your own mail relay.';

  const add = () => {
    const p = emailProblem(email);
    if (p) { setEmailErr(p); return; }
    if (state.invites.some((i) => i.email.toLowerCase() === email.trim().toLowerCase())) { setEmailErr('That person is already on the list.'); return; }
    patch({ invites: [...state.invites, { email: email.trim().toLowerCase(), role }] });
    setEmail('');
    setEmailErr(undefined);
  };

  const startSlack = async () => {
    if (sov) { toast.bad('Slack is not available', NO_CHAT); return; }
    setBusy('slack');
    try {
      if (local) setSlackFlow({ state: 'local' });
      else setSlackFlow({ state: (await orgApi.startSlackInstall(orgId, userId)).state });
      setWorkspace(createdOrg(orgId)?.name ?? '');
    } catch (e) { toast.bad('Slack could not be started', (e as Error).message); } finally { setBusy(undefined); }
  };
  const finishSlack = async (decision: 'allow' | 'deny') => {
    if (!slackFlow) return;
    setBusy('slack-done');
    try {
      if (local) {
        if (decision === 'deny') throw new Error('Slack reported access_denied: nothing was connected.');
        if (workspace.trim().length < 2) throw new Error('Enter the workspace name.');
        patch({ slack: { connected: true, workspace: workspace.trim(), channel: state.slack.channel } });
      } else {
        const r = await orgApi.completeSlackInstall(orgId, userId, { state: slackFlow.state, decision, workspace });
        patch({ slack: { connected: true, workspace: r.slack.workspace, channel: r.slack.channel } });
        toast.ok('Slack connected', `${r.slack.workspace} · ${r.slack.channel}. Recorded as receipt ${seqLabel(r.seq)}.`);
      }
      setSlackFlow(undefined);
    } catch (e) { toast.bad('Slack was not connected', (e as Error).message); setSlackFlow(undefined); } finally { setBusy(undefined); }
  };

  const wa = state.whatsapp;
  const sendCode = async () => {
    if (sov) { setCodeErr(NO_CHAT); return; }
    setBusy('wa');
    setCodeErr(undefined);
    try {
      if (local) setSentTo(sendLocalWhatsAppCode(userId, wa.number, orgId).sentTo);
      else {
        const r = await orgApi.sendWhatsAppCode(orgId, userId, wa.number);
        pushMail({ channel: 'whatsapp', to: r.sentTo, subject: 'Elan1 Govern verification code', body: `Your code is ${r.testCode}. It expires in 10 minutes. Do not share it.`, orgId });
        setSentTo(r.sentTo);
      }
    } catch (e) { setCodeErr((e as Error).message); } finally { setBusy(undefined); }
  };
  const verify = async () => {
    if (!/^\d{6}$/.test(code)) { setCodeErr('Enter the 6-digit code.'); return; }
    setBusy('wa-verify');
    setCodeErr(undefined);
    try {
      if (local) verifyLocalWhatsAppCode(userId, code);
      else { const r = await orgApi.verifyWhatsAppCode(orgId, userId, code); toast.ok('WhatsApp number verified', `Recorded as receipt ${seqLabel(r.seq)}.`); }
      patch({ whatsapp: { ...wa, verified: true } });
      setSentTo(undefined);
      setCode('');
    } catch (e) { setCodeErr((e as Error).message); } finally { setBusy(undefined); }
  };
  /** Chose Sovereign after connecting Slack or WhatsApp at a lower level: switch both off (each is a receipt when recorded). */
  const switchOffChat = async () => {
    setBusy('sov-off');
    const seqs: number[] = [];
    try {
      if (!local) {
        if (state.slack.connected) seqs.push((await orgApi.disconnectSlack(orgId, userId)).seq);
        if (wa.verified) seqs.push((await orgApi.forgetWhatsApp(orgId, userId)).seq);
      }
      patch({ slack: { connected: false, channel: state.slack.channel }, whatsapp: { number: '', verified: false } });
      setSentTo(undefined);
      toast.ok('Slack and WhatsApp switched off', seqs.length ? `Recorded as ${seqs.map((s) => `receipt ${seqLabel(s)}`).join(' and ')}.` : 'Approvals will go by email through your own mail relay.');
    } catch (e) { toast.bad('Not switched off', (e as Error).message); } finally { setBusy(undefined); }
  };

  return (
    <>
      <StepHeading title="Approvers and channels" headingRef={headingRef}>Invite the people who decide held actions, and choose where they hear about them. Invitations are sent as single-use links when you finish. You can skip this and do it later in the Agents door, under People and roles, and the Work door, under Channels.</StepHeading>

      <section aria-labelledby="invite-h" className="border border-line bg-surface">
        <div className="px-5 py-3.5 border-b border-line"><h2 id="invite-h" className="text-lg font-semibold">Invite people</h2></div>
        <div className="p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px_auto] items-end">
            <Field label="Work email" htmlFor="ob-inv" error={emailErr}>
              <Input id="ob-inv" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setEmailErr(undefined); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="venkat@company.com" invalid={!!emailErr} />
            </Field>
            <Field label="Role" htmlFor="ob-role">
              <Select id="ob-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="approver">Approver</option><option value="admin">Admin</option><option value="viewer">Viewer</option>
              </Select>
            </Field>
            <Button type="button" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={add}>Add</Button>
          </div>
          <p className="mt-2 text-xs text-muted">{ROLE_INFO[role].summary}</p>
          {state.invites.length > 0 ? (
            <ul className="mt-4 border border-line divide-y divide-line">
              {state.invites.map((i) => (
                <li key={i.email} className="flex items-center gap-3 px-3 py-2">
                  <Mail className="h-4 w-4 text-muted shrink-0" aria-hidden />
                  <span className="text-sm min-w-0 truncate flex-1">{i.email}</span>
                  <Badge>{ROLE_INFO[i.role].label}</Badge>
                  <button type="button" aria-label={`Remove ${i.email}`} onClick={() => patch({ invites: state.invites.filter((x) => x.email !== i.email) })} className="h-7 w-7 inline-flex items-center justify-center text-muted hover:text-fg hover:bg-sunken"><X className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-4 text-sm text-muted">No one yet. Rules that ask a person need at least one approver in each approver group; dual control from L2 needs a second admin.</p>}
        </div>
      </section>

      {sov ? (
        <section aria-labelledby="sov-ch-h" className="mt-6 border border-line bg-surface">
          <div className="px-5 py-3.5 border-b border-line flex items-center gap-2">
            <ShieldOff className="h-4 w-4" aria-hidden />
            <h2 id="sov-ch-h" className="text-lg font-semibold">Email through your own mail relay</h2>
          </div>
          <div className="p-5 space-y-3 text-sm">
            <p>A Sovereign deployment denies all egress, so Slack and WhatsApp are not available: both would need a connection to the internet. Held actions reach approvers as signed, single-use links by email, sent through the mail relay inside your network.</p>
            <p className="text-muted">Once the cluster is up, an owner or admin puts the relay (for example <span className="font-mono text-[12.5px]">smtp-relay.yourbank.internal</span>) on the internal allow-list in the Agents door, under Deployment › Egress. Nothing else leaves the network.</p>
            {(state.slack.connected || wa.verified) && (
              <Banner tone="held" title="Connected before you chose Sovereign"
                actions={<Button type="button" size="sm" variant="secondary" loading={busy === 'sov-off'} onClick={() => void switchOffChat()}>Switch them off</Button>}>
                {[state.slack.connected && 'Slack', wa.verified && 'WhatsApp'].filter(Boolean).join(' and ')} cannot be reached under deny-all egress and will not be used. Switch them off so the set-up matches the deployment.
              </Banner>
            )}
          </div>
        </section>
      ) : (<>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section aria-labelledby="slack-h" className="border border-line bg-surface p-5 flex flex-col">
          <div className="flex items-center gap-2">
            <HashIcon className="h-4 w-4" aria-hidden />
            <h2 id="slack-h" className="text-lg font-semibold">Slack</h2>
            {state.slack.connected && <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />} className="ml-auto">Connected</StatusChip>}
          </div>
          <p className="mt-2 text-sm text-muted flex-1">Held actions post to a channel. People link their own Slack account once, from the You page.</p>
          {state.slack.connected
            ? <p className="mt-4 text-sm"><span className="font-medium">{state.slack.workspace}</span> · <span className="font-mono">{state.slack.channel}</span></p>
            : <Button type="button" className="mt-4 self-start" variant="secondary" loading={busy === 'slack'} onClick={() => void startSlack()}>Connect Slack</Button>}
        </section>

        <section aria-labelledby="wa-h" className="border border-line bg-surface p-5 flex flex-col">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" aria-hidden />
            <h2 id="wa-h" className="text-lg font-semibold">WhatsApp</h2>
            {wa.verified && <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />} className="ml-auto">Verified</StatusChip>}
          </div>
          <p className="mt-2 text-sm text-muted">Your number receives held actions as a single-use link, with Approve and Reject on rules approvable in chat. It is stored as a keyed hash on receipts.</p>
          {wa.verified ? (
            <div className="mt-4 flex items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5"><Smartphone className="h-4 w-4 text-muted" aria-hidden />{wa.number}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => { patch({ whatsapp: { number: wa.number, verified: false } }); setCode(''); }}>Change</Button>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="flex gap-2 items-end">
                <Field label="Your number" htmlFor="ob-wa" className="flex-1">
                  <Input id="ob-wa" type="tel" inputMode="tel" value={wa.number} onChange={(e) => patch({ whatsapp: { ...wa, number: e.target.value } })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void sendCode(); } }} placeholder={userPhone ?? '+91 98450 11203'} />
                </Field>
                <Button type="button" variant="secondary" loading={busy === 'wa'} onClick={() => void sendCode()}>{sentTo ? 'Resend' : 'Send code'}</Button>
              </div>
              {sentTo && (
                <div className="flex gap-2 items-end">
                  <Field label="6-digit code" htmlFor="ob-wa-code" className="flex-1">
                    <Input id="ob-wa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} mono value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void verify(); } }} />
                  </Field>
                  <Button type="button" variant="primary" loading={busy === 'wa-verify'} onClick={() => void verify()}>Verify</Button>
                </div>
              )}
              {codeErr && <p className="text-xs text-bad-fg" role="alert">{codeErr}</p>}
            </div>
          )}
        </section>
      </div>
      {sentTo && <div className="mt-4"><DemoOutbox to={sentTo} title="Demo outbox — WhatsApp" limit={1} /></div>}

      <Banner tone="info" className="mt-6" title="Approve buttons in chat are limited on purpose">
        Slack and WhatsApp show Approve and Reject only for rules marked approvable in chat — never for deletes, access changes, production changes, personal data or where approving asks for the password again — and only to people with a linked Slack account or a verified WhatsApp number. Every other message carries a single-use link to the decision page.
      </Banner>
      </>)}

      <Dialog open={!!slackFlow} onClose={() => setSlackFlow(undefined)} size="sm" title="Slack · install Elan1 Govern" description="Simulated Slack consent screen (OAuth 2.0)."
        footer={<><Button variant="ghost" loading={busy === 'slack-done'} onClick={() => void finishSlack('deny')}>Cancel</Button><Button variant="primary" loading={busy === 'slack-done'} onClick={() => void finishSlack('allow')}>Allow</Button></>}>
        <div className="space-y-3 text-sm">
          <p>Elan1 Govern is requesting permission to post messages (chat:write), receive button presses (commands) and match people by email (users:read.email).</p>
          <Field label="Workspace" htmlFor="slack-ws"><Input id="slack-ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="Your company" /></Field>
          <p className="text-xs text-muted">State <span className="font-mono">{slackFlow?.state}</span> is checked when Slack returns.</p>
        </div>
      </Dialog>
    </>
  );
}

/* ── Done ────────────────────────────────────────────────── */

function DoneStep({ state, headingRef, onRestart, local, orgId }: { state: OnboardingState; headingRef: React.RefObject<HTMLHeadingElement>; onRestart: () => void; local: boolean; orgId: string }) {
  const ind = industryById(state.industry);
  const fw = useMemo(() => frameworksFor(state.industry, state.regions), [state.industry, state.regions]);
  const res = state.result;
  const rbLink = res?.rulebookSlug ? `/rulebooks/${res.rulebookSlug}` : undefined;
  // L1 publishes rulebooks (sealed in the hash chain); from L2 a person signs them. The organisation's level now,
  // which is the chosen one once an owner finished set-up.
  const signs = levelRank(local ? state.level : api.levelOf(orgId)) >= 1;
  const nextSteps = [
    { to: rbLink ?? '/agents/new', icon: ShieldCheck, title: 'Review the starter rulebook', body: `It is an unpublished draft. Read it, test it on past actions, and have a person ${signs ? 'sign and publish' : 'review and publish'} it.` },
    { to: '/agents/new', icon: Bot, title: 'Add your first agent', body: 'Name it, pick the route — governed run over MCP or check and record over REST — and attach the rulebook.' },
    { to: levelRank(state.level) >= 1 ? '/assurance/levels' : '/connectors', icon: levelRank(state.level) >= 1 ? LayoutDashboard : Plug, title: levelRank(state.level) >= 1 ? 'See what your level proves' : 'Connect a system', body: levelRank(state.level) >= 1 ? 'Timestamps, seals, profiles and the evidence bundle for your level.' : 'Gmail, Zoho Books or your own MCP server. Elan1 Govern holds the credential on the governed route.' },
  ];
  return (
    <>
      <StepHeading title={`${state.company.name.trim() || 'Your organisation'} is set up`} headingRef={headingRef}>
        Your starter rulebook is ready as an unpublished draft. Nothing governs an agent until a person {signs ? 'signs and publishes it' : 'publishes it'}.
      </StepHeading>

      <div className="grid gap-4 md:grid-cols-3">
        {nextSteps.map((s, i) => (
          <Link key={s.title} to={s.to} className={cn('group flex flex-col border bg-surface p-5 transition-colors hover:border-fg', i === 0 ? 'border-fg shadow-[inset_0_0_0_1px_rgb(var(--fg))]' : 'border-line')}>
            <span className="flex items-center justify-between">
              <span className="inline-flex h-9 w-9 items-center justify-center border border-line bg-sunken"><s.icon className="h-4 w-4" aria-hidden /></span>
              <span className="label">{i === 0 ? 'Start here' : `Next ${i + 1}`}</span>
            </span>
            <span className="mt-4 text-lg font-semibold font-display">{s.title}</span>
            <span className="mt-1.5 text-sm text-muted flex-1">{s.body}</span>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium">Open <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>
          </Link>
        ))}
      </div>

      {res && (
        <section className="mt-8 border border-line bg-surface" aria-labelledby="applied-h">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 border-b border-line">
            <h2 id="applied-h" className="text-lg font-semibold">What was applied</h2>
            {state.receiptSeq !== undefined ? <span className="text-xs text-muted">Recorded on the chain as <Link to={`/activity/${state.receiptSeq}`} className="font-mono text-fg hover:underline">{seqLabel(state.receiptSeq)}</Link></span> : null}
          </div>
          <ul className="divide-y divide-line">
            {res.applied.map((a) => <li key={a} className="flex items-start gap-2.5 px-5 py-2.5 text-sm"><Check className="h-4 w-4 mt-0.5 text-ok-fg shrink-0" aria-hidden />{a}</li>)}
            {res.skipped.map((a) => <li key={a} className="flex items-start gap-2.5 px-5 py-2.5 text-sm text-muted"><RotateCcw className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />{a}</li>)}
          </ul>
        </section>
      )}

      {res?.starterYaml && local && <div className="mt-6"><CodeBlock code={res.starterYaml} title={`${res.rulebookSlug ?? 'starter'}.yaml — draft`} maxHeight={280} /></div>}
      {rbLink && <p className="mt-4 text-sm"><Link to={rbLink} className="link inline-flex items-center gap-1">Open the starter rulebook draft <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link></p>}

      {res && res.invites.length > 0 && <div className="mt-6"><DemoOutbox orgId={orgId} links={res.invites.map((i) => i.link)} title="Invitations sent — demo outbox" limit={res.invites.length} /></div>}

      <section className="mt-8 border border-line bg-surface" aria-labelledby="summary-h">
        <div className="px-5 py-3.5 border-b border-line"><h2 id="summary-h" className="text-lg font-semibold">Summary</h2></div>
        <div className="px-5 py-2">
          <KeyValue items={[
            { k: 'Company', v: <>{state.company.name || '—'}{state.company.legal && <span className="block text-xs text-muted">{state.company.legal}</span>}</> },
            { k: 'Assurance level', v: LEVEL_INFO[state.level].label },
            { k: 'Residency', v: state.residency },
            ...(levelRank(state.level) >= 1 ? [{ k: 'Key custody', v: levelRank(state.level) >= 2 ? CUSTODY_LABEL[state.custody] : CUSTODY_LABEL.aws_kms }, { k: 'Timestamp authorities', v: state.level === 'sovereign' ? state.localTsas.join(' · ') : `eMudhra · ${state.globalTsa}` }] : [{ k: 'Records', v: 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped' }]),
            { k: 'Regulatory packs', v: state.packs.length ? `${state.packs.join(', ')}${levelRank(state.level) < 1 ? ' (dry run until L2)' : ''}` : 'None yet' },
            { k: 'Verifier profiles', v: state.profiles.length ? `${plural(state.profiles.length, 'profile')}, billed separately${levelRank(state.level) < 1 ? ' from L2' : ''}` : 'None yet' },
            { k: 'Industry configuration', v: ind.label },
            { k: 'Regions', v: state.regions.join(', ') || '—' },
            { k: 'Frameworks', v: <span className="inline-flex flex-wrap justify-end gap-1">{fw.map((f) => <Badge key={f}>{f}</Badge>)}</span> },
            { k: 'Currency and time zone', v: `${state.currency} · ${state.timezone}` },
            { k: 'Sign-in', v: [state.identity.saml && `SAML (${state.identity.idp})`, state.identity.scim && 'SCIM', 'Password + two-step'].filter(Boolean).join(' · ') },
            { k: 'Invitations', v: state.invites.length ? plural(state.invites.length, 'person', 'people') : 'None yet' },
            { k: 'Channels', v: state.level === 'sovereign' ? 'Email through your own mail relay · Slack and WhatsApp off (deny-all egress)' : [state.slack.connected && 'Slack', state.whatsapp.verified && 'WhatsApp', 'Email'].filter(Boolean).join(' · ') },
          ]} />
        </div>
      </section>

      {ind.highRisk && <Banner tone="held" className="mt-6">{HIGH_RISK_NOTE}</Banner>}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link to="/agents/organisation" className="link text-sm">Review in Agents → Organisation</Link>
        <button type="button" onClick={onRestart} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><RotateCcw className="h-3.5 w-3.5" aria-hidden />Run set-up again</button>
      </div>
    </>
  );
}
