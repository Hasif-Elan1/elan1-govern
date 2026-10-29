import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BellRing, Building2, Check, FileDown, Hash as HashIcon, KeyRound, LogOut, MessageCircle, Monitor, RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { api, db } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgAccess, useSession, useUser } from '@/store/session';
import { ROLE_INFO } from '@/lib/permissions';
import { LEVEL_INFO } from '@/lib/levels';
import { relative } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Avatar, Badge, Banner, Button, CopyButton, Dialog, Field, Input, Meter, PageHeader, Panel, Skeleton, StatusChip, toast } from '@/components/ui';
import { PreferencesSection } from '@/features/settings/sections/Preferences';
import { orgApi } from '@/features/settings/orgApi';
import * as consoleOps from '@/features/console/ops';
import { createdOrg, pushMail, totpAt, totpStep } from '@/features/auth/registry';
import { DemoOutbox } from '@/features/auth/Outbox';
import { QrCode } from './qr';
import { isSovereignOrg } from '@/features/deployment/sovereignApi';
import { EgressBlocked } from '@/features/deployment/EgressBlocked';
import { sessionLimit, useSessionLifetime } from './sessionLifetime';
import { SmartLink, useScreenAccess } from '@/shell/access';

/** The organisation settings this page points to, each shown only where the role and plan can open it. */
const ORG_SETTINGS: { to: string; icon: ReactNode; door: string; label: string }[] = [
  { to: '/agents/people', icon: <Users className="h-4 w-4" aria-hidden />, door: 'Agents', label: 'People and roles' },
  { to: '/agents/organisation?tab=sso', icon: <KeyRound className="h-4 w-4" aria-hidden />, door: 'Agents', label: 'Single sign-on, SAML and SCIM' },
  { to: '/agents/organisation', icon: <Building2 className="h-4 w-4" aria-hidden />, door: 'Agents', label: 'Organisation' },
  { to: '/agents/keys', icon: <KeyRound className="h-4 w-4" aria-hidden />, door: 'Agents', label: 'Agent and signing keys' },
  { to: '/work/channels', icon: <BellRing className="h-4 w-4" aria-hidden />, door: 'Work', label: 'Channels and notifications' },
  { to: '/assurance/exports?tab=data', icon: <FileDown className="h-4 w-4" aria-hidden />, door: 'Assurance', label: 'Exports, webhooks and retention' },
];

const note = (seq?: number) => (seq !== undefined ? `Recorded as receipt #${seq}.` : '');

/**
 * You — the personal page reached from the account menu. Explicitly not a door: it holds only what belongs
 * to the signed-in person (two-step sign-in, sessions, approve-in-chat links, organisations, preferences).
 */
export default function YouPage() {
  const user = useUser();
  const signedInAt = useSession((s) => s.signedInAt);
  const orgId = useSession((s) => s.orgId);
  const switchOrg = useSession((s) => s.switchOrg);
  const nav = useNavigate();
  const access = useOrgAccess(user?.orgIds ?? []);
  const screens = useScreenAccess();
  // approve-in-chat links matter only to roles that decide held actions
  const approves = screens.can('approvals.decide');
  const orgSettings = ORG_SETTINGS.filter((d) => screens.canSee(d.to));
  const members = useQuery((o) => api.members(o), [], { kinds: ['member'] });
  const me = members.data?.find((m) => m.userId === user?.id);
  // two-step sign-in from the organisation's records (orgApi.mfaOn), not the directory's user.mfa: it turns
  // on as soon as an authenticator is enrolled, here or under Preferences
  const mfaOn = useSyncExternalStore(
    (cb) => db.subscribe((o) => { if (o === orgId) cb(); }),
    () => (user ? (createdOrg(orgId) ? !!user.mfa : orgApi.mfaOn(orgId, user.id)) : false),
  );
  const limit = sessionLimit(orgId, signedInAt);
  useSessionLifetime();

  useEffect(() => { document.title = 'You · Elan1 Govern'; }, []);
  const local = !!createdOrg(orgId);
  useEffect(() => { if (user && signedInAt && !local) orgApi.registerSession(orgId, user.id, signedInAt, navigator.userAgent, mfaOn); }, [user, orgId, signedInAt, mfaOn, local]);

  if (!user) return <Banner tone="neutral" title="You are not signed in"><Link to="/login" className="link">Sign in</Link> to see your profile and preferences.</Banner>;

  const orgs = api.orgs(user.orgIds);

  return (
    <div className="space-y-8 overflow-x-clip">
      <PageHeader kicker="Your account" title="You" description="Your profile, how you sign in and where you approve. This page is personal to you; it is not one of the four doors." meta={<Badge tone="neutral">Personal — changes here affect only you</Badge>} />

      {members.error && <Banner tone="bad" title="Your membership could not be loaded" actions={<Button size="sm" onClick={members.refetch}>Try again</Button>}>{members.error.message}</Banner>}

      <Panel flush>
        <div className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start border-b lg:border-b-0 lg:border-r border-line min-w-0">
            <Avatar initials={user.initials} size={64} title={user.name} />
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-semibold tracking-tighter2">{user.name}</h2>
              <p className="mt-0.5 text-md text-muted">{user.title}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge tone={user.role === 'owner' ? 'inverse' : 'neutral'}>{ROLE_INFO[me?.role ?? user.role].label}</Badge>
                {mfaOn
                  ? <StatusChip tone="ok" size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>Two-step sign-in on</StatusChip>
                  : <StatusChip tone="held" size="sm" icon={<ShieldAlert className="h-3 w-3" aria-hidden />}>Two-step sign-in off</StatusChip>}
              </div>
              <p className="mt-3 text-sm text-fg/85 leading-relaxed max-w-[60ch]">{ROLE_INFO[me?.role ?? user.role].summary}</p>
              <SmartLink to="/agents/people?tab=roles" hideWhenBlocked className="mt-2 inline-flex items-center gap-1 text-sm link">What each role can do<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>
            </div>
          </div>
          <dl className="p-5 text-sm min-w-0">
            <Item k="Email"><span className="inline-flex items-center gap-1 font-mono text-[12.5px] break-all">{user.email}<CopyButton text={user.email} compact label="Copy email" /></span></Item>
            {user.phone && <Item k="Phone"><span className="num">{user.phone}</span></Item>}
            <Item k="Signed in">{signedInAt ? relative(new Date(signedInAt).toISOString()) : '—'}</Item>
            {limit && <Item k="Session ends"><span title={`Your organisation ends sessions after ${limit.label}.`}>{relative(new Date(limit.expiresAt).toISOString())} <span className="text-muted">· {limit.lifetime} lifetime</span></span></Item>}
            {approves && <Item k="Approve in chat">
              {isSovereignOrg(orgId) ? <span className="text-muted">Not available — egress denied</span> : members.loading && !members.data ? <Skeleton className="h-4 w-32 ml-auto" /> : members.error ? <span className="text-bad-fg">Could not load</span> : me ? (
                <span>{[me.slackLinked && 'Slack linked', me.whatsappVerified && 'WhatsApp verified'].filter(Boolean).join(' · ') || 'Not linked'}</span>
              ) : <span className="text-muted">Not a member of this organisation</span>}
            </Item>}
            <Item k={orgs.length > 1 ? 'Organisations' : 'Organisation'}>
              <span className="flex flex-col items-end gap-1.5">
                {orgs.map((o) => {
                  const closed = access[o.id] && access[o.id] !== 'active';
                  return (
                    <button key={o.id} type="button" onClick={() => { if (o.id !== orgId && switchOrg(o.id) !== false) { toast.ok(`Switched to ${o.name}`, LEVEL_INFO[o.plan].label); nav('/'); } }}
                      aria-pressed={o.id === orgId} title={o.id === orgId ? 'The organisation you are working in' : closed ? `${o.name} is not open to you: ${access[o.id] === 'suspended' ? 'your access there is suspended' : 'you are no longer a member'}` : `Switch to ${o.name}`}
                      className={cn('inline-flex items-center gap-1.5 border px-2 h-7 text-xs font-medium', o.id === orgId ? 'border-fg bg-fg text-canvas' : closed ? 'border-line text-muted' :'border-line hover:border-fg')}>
                      <span>{o.name}</span><span className={cn('font-mono', o.id === orgId ? 'text-canvas/80' : 'text-muted')}>{LEVEL_INFO[o.plan].tag}</span>
                      {closed && <span className="text-held-fg">·{access[o.id] === 'suspended' ? 'suspended' : 'access ended'}</span>}
                    </button>
                  );
                })}
              </span>
            </Item>
          </dl>
        </div>
      </Panel>

      {local ? (
        <Banner tone="info" title={approves ? 'Two-step sign-in, sessions and chat links' : 'Two-step sign-in and sessions'}>This organisation was created in this browser and has no records of its own yet. Your two-step sign-in, session list{approves ? ' and Slack and WhatsApp links are' : ' are'} kept with an organisation’s records, so they start once its first agent connects.</Banner>
      ) : (
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-6 min-w-0"><TwoStep orgId={orgId} userId={user.id} email={user.email} on={mfaOn} /></div>
        <div className="lg:col-span-6 min-w-0"><Sessions orgId={orgId} userId={user.id} signedInAt={signedInAt} /></div>
        {approves && <div className="lg:col-span-12 min-w-0"><ApproveInChat orgId={orgId} userId={user.id} phone={user.phone} slackLinked={!!me?.slackLinked} isMember={!!me} /></div>}
      </div>
      )}

      <PreferencesSection />

      {orgSettings.length > 0 && (
      <section aria-labelledby="org-settings-title" className="border border-line bg-sunken/50 p-5">
        <h2 id="org-settings-title" className="text-lg font-semibold">Looking for organisation settings?</h2>
        <p className="mt-1 text-sm text-fg/85 leading-relaxed max-w-[72ch]">Organisation settings live inside the doors: people, sign-in, SAML and SCIM under Agents, channels under Work, exports and retention under Assurance.</p>
        <ul className="mt-4 grid gap-px bg-line border border-line sm:grid-cols-2 lg:grid-cols-3">
          {orgSettings.map((d) => <Door key={d.to} {...d} />)}
        </ul>
      </section>
      )}
    </div>
  );
}

/* ── Two-step sign-in: enrol or reset an authenticator (QR + code check) ── */

function TwoStep({ orgId, userId, email, on }: { orgId: string; userId: string; email: string; on: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [code, setCode] = useState('');
  const confirm = useMutation(orgApi.confirmTotp);
  const [, tick] = useState(0);
  useEffect(() => { if (!setup) return; const t = window.setInterval(() => tick((x) => x + 1), 1000); return () => window.clearInterval(t); }, [setup]);
  const enrolled = (() => { try { return !!(db.getDB(orgId) as unknown as { orgSettings?: { mfa: Record<string, { enrolledAt: string }> } }).orgSettings?.mfa[userId]; } catch { return false; } })();

  const start = () => { setSetup(orgApi.startTotp(orgId, userId)); setCode(''); };
  const submit = async () => {
    if (!setup) return;
    try {
      const r = await confirm.mutate(orgId, userId, setup.secret, code);
      toast.ok(on ? 'Authenticator replaced' : 'Two-step sign-in is on', `Codes from the new authenticator are asked for at each sign-in; the old one stops working. ${note(r.seq)}`);
      setSetup(undefined);
    } catch { /* shown in the dialog */ }
  };
  const demo = setup ? totpAt(setup.secret, totpStep()) : '';
  const left = 30 - Math.floor((Date.now() / 1000) % 30);

  return (
    <Panel title="Two-step sign-in" kicker="Authenticator app (RFC 6238)" actions={on ? <StatusChip size="sm" tone="ok" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>On</StatusChip> : <StatusChip size="sm" tone="held" icon={<ShieldAlert className="h-3 w-3" aria-hidden />}>Off</StatusChip>}>
      <p className="text-sm text-muted leading-relaxed">{on ? `A 6-digit code is asked for after your password${enrolled ? ', from the authenticator you enrolled here' : ', from the authenticator your organisation issued'}. Replace it if you changed phones; the old one stops working at once.` : 'After your password, a 6-digit code from an app on your phone. It stops a stolen password from being enough.'}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant={on ? 'secondary' : 'primary'} icon={<Smartphone className="h-4 w-4" />} onClick={start}>{on ? 'Replace my authenticator' : 'Set up two-step sign-in'}</Button>
      </div>
      <Dialog open={!!setup} onClose={() => setSetup(undefined)} title={on ? 'Replace your authenticator' : 'Set up two-step sign-in'} description="Scan the code with Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app, then type the code it shows."
        footer={<><Button variant="ghost" onClick={() => setSetup(undefined)}>Cancel</Button><Button variant="primary" loading={confirm.pending} disabled={!/^\d{6}$/.test(code)} onClick={() => void submit()}>Check the code and turn on</Button></>}>
        {setup && (
          <div className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <QrCode text={setup.uri} label={`QR code for ${email}`} />
              <div className="min-w-0 space-y-2 text-sm">
                <p className="text-muted">Cannot scan? Enter this key by hand:</p>
                <p className="font-mono text-[13px] break-all inline-flex items-start gap-1">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}<CopyButton text={setup.secret} compact label="Copy the key" /></p>
                <p className="text-xs text-muted">Account: {email} · Issuer: Elan1 Govern · 6 digits · 30 seconds</p>
              </div>
            </div>
            <Field label="Code from your app" htmlFor="totp-code" error={confirm.error?.message}>
              <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} mono value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => { if (e.key === 'Enter' && /^\d{6}$/.test(code)) void submit(); }} />
            </Field>
            <div className="border border-dashed border-line-strong/70 bg-sunken/40 p-3">
              <p className="label">Demo authenticator</p>
              <p className="mt-1 flex flex-wrap items-center gap-3"><span className="font-mono text-xl tracking-[0.2em]">{demo}</span><Button size="sm" variant="ghost" onClick={() => setCode(demo)}>Use this code</Button><span className="text-xs text-muted num">{left}s</span></p>
              <Meter value={left / 30} className="mt-1 h-1" label="Time left for this code" />
              <p className="mt-1 text-xs text-muted">What an app holding this key shows now, for trying it without a phone.</p>
            </div>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}

/* ── Sessions ─────────────────────────────────────────────────────────── */

function Sessions({ orgId, userId, signedInAt }: { orgId: string; userId: string; signedInAt?: number }) {
  const q = useQuery((o) => orgApi.sessions(o, userId), [userId], { kinds: ['session'] });
  const currentId = `ses_${userId}_${signedInAt}`;
  const endOne = useMutation(orgApi.endSession);
  const endOthers = useMutation(orgApi.endOtherSessions);
  const open = (q.data?.sessions ?? []).filter((s) => !s.endedAt);
  const others = open.filter((s) => s.id !== currentId);
  return (
    <Panel title="Sessions" kicker={q.data ? `${open.length} open · lifetime ${q.data.policy.lifetime}` : 'Where you are signed in'} flush
      actions={<Button size="sm" variant="secondary" icon={<LogOut className="h-3.5 w-3.5" />} disabled={!others.length} title={!others.length ? 'No other session is open.' : undefined} loading={endOthers.pending}
        onClick={async () => { try { const r = await endOthers.mutate(orgId, userId, currentId); toast.ok(`${r.count} other session${r.count === 1 ? '' : 's'} signed out`, note(r.seq)); q.refetch(); } catch (e) { toast.bad('Could not sign out the other sessions', (e as Error).message); } }}>Sign out other sessions</Button>}>
      {q.error && <div className="p-4"><Banner tone="bad" title="Sessions could not be loaded" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner></div>}
      {q.loading && !q.data && <div className="p-4 space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>}
      {q.data && (q.data.sessions.length ? (
        <ul className="divide-y divide-line">
          {q.data.sessions.slice(0, 8).map((s) => (
            <li key={s.id} className="flex items-start gap-3 px-5 py-3">
              <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center border border-line bg-sunken">{s.kind === 'phone' ? <Smartphone className="h-4 w-4" aria-hidden /> : <Monitor className="h-4 w-4" aria-hidden />}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium flex flex-wrap items-center gap-2">{s.device}{s.id === currentId && <Badge tone="inverse">This browser</Badge>}{s.endedAt && <Badge>Ended</Badge>}</p>
                <p className="text-xs text-muted">{s.method} · started {relative(s.startedAt)}{s.endedAt ? ` · ${s.endReason ?? 'ended'} ${relative(s.endedAt)}` : ` · active ${relative(s.lastActiveAt)}`}{s.seq ? ` · receipt #${s.seq}` : ''}</p>
              </div>
              {!s.endedAt && s.id !== currentId && s.via === 'console' && (
                <Button size="sm" variant="ghost" loading={endOne.pending} onClick={async () => { try { const r = await endOne.mutate(orgId, userId, s.id); toast.ok('Session signed out', note(r.seq)); q.refetch(); } catch (e) { toast.bad('Could not sign out that session', (e as Error).message); } }}>Sign out</Button>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="px-5 py-6 text-sm text-muted">No sessions recorded yet for this organisation.</p>)}
      <p className="px-5 py-3 border-t border-line text-xs text-muted">A session that is signed out elsewhere ends in its browser within 10 seconds. Changing your password signs out every other session.</p>
    </Panel>
  );
}

/* ── Approve in chat: link Slack, verify WhatsApp ─────────────────────── */

function ApproveInChat({ orgId, userId, phone, slackLinked, isMember }: { orgId: string; userId: string; phone?: string; slackLinked: boolean; isMember: boolean }) {
  const notify = useQuery((o) => orgApi.notify(o), [], { kinds: ['channel'] });
  const wa = useQuery((o) => orgApi.whatsapp(o, userId), [userId], { kinds: ['channel', 'member'] });
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string>();
  const [slackOpen, setSlackOpen] = useState(false);
  const send = useMutation(orgApi.sendWhatsAppCode);
  const verify = useMutation(orgApi.verifyWhatsAppCode);
  const forget = useMutation(orgApi.forgetWhatsApp);
  const [linking, setLinking] = useState(false);
  // Sovereign: deny-all egress — Slack and WhatsApp are outside the network, so neither is offered
  const sov = isSovereignOrg(orgId);

  useEffect(() => { if (wa.data && !number) setNumber(wa.data.number || phone || ''); }, [wa.data, phone]);

  const slack = notify.data?.slack;
  const setSlack = async (link: boolean) => {
    setLinking(true);
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await consoleOps.setSlackLinked(orgId, link, userId);
      setSlackOpen(false);
      toast.ok(link ? 'Slack linked' : 'Slack unlinked', `${link ? `Held actions for your groups now reach you in ${slack?.workspace}.` : 'You no longer get held actions in Slack.'} ${note(r.seq)}`);
    } catch (e) {
      toast.bad(link ? 'Slack was not linked' : 'Slack was not unlinked', (e as Error).message);
    } finally {
      setLinking(false);
    }
  };

  return (
    <Panel title="Approve in chat" kicker="Where held actions reach you">
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="slack-me">
          <h3 id="slack-me" className="text-md font-semibold inline-flex items-center gap-2"><HashIcon className="h-4 w-4" aria-hidden />Slack</h3>
          {notify.error && <Banner tone="bad" className="mt-2">{notify.error.message}</Banner>}
          {sov ? <EgressBlocked className="mt-2" service="Slack" host="hooks.slack.com" instead="Held actions for your groups reach you in the console and by email through your organisation’s mail relay." /> : notify.loading && !notify.data ? <Skeleton className="mt-2 h-10 w-full" /> : slack?.connected ? (
            <>
              <p className="mt-1 text-sm text-muted">Your organisation’s workspace: <span className="text-fg font-medium">{slack.workspace}</span> · {slack.channel}. Approve and Reject appear only for rules marked approvable in chat.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {slackLinked ? <StatusChip size="sm" tone="ok" icon={<Check className="h-3 w-3" aria-hidden />}>Linked to you</StatusChip> : <StatusChip size="sm" tone="neutral">Not linked</StatusChip>}
                {slackLinked
                  ? <Button size="sm" variant="ghost" loading={linking} onClick={() => void setSlack(false)}>Unlink</Button>
                  : <Button size="sm" variant="primary" disabled={!isMember} title={!isMember ? 'Only members of this organisation can link Slack.' : undefined} onClick={() => setSlackOpen(true)}>Link my Slack account</Button>}
              </div>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">Slack is not connected for this organisation yet. An owner or admin connects it in the Work door, under <SmartLink to="/work/channels" className="link">Channels</SmartLink>; then you link your own account here.</p>
          )}
        </section>

        <section aria-labelledby="wa-me">
          <h3 id="wa-me" className="text-md font-semibold inline-flex items-center gap-2"><MessageCircle className="h-4 w-4" aria-hidden />WhatsApp</h3>
          {wa.error && <Banner tone="bad" className="mt-2">{wa.error.message}</Banner>}
          {sov ? <EgressBlocked className="mt-2" service="WhatsApp" host="graph.facebook.com" instead="Your number is not collected on this deployment." /> : wa.loading && !wa.data ? <Skeleton className="mt-2 h-10 w-full" /> : wa.data?.verified ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <StatusChip size="sm" tone="ok" icon={<Check className="h-3 w-3" aria-hidden />}>Verified</StatusChip>
              <span className="num">{wa.data.number}</span>
              <Button size="sm" variant="ghost" loading={forget.pending} onClick={async () => { try { const r = await forget.mutate(orgId, userId); toast.ok('WhatsApp removed', note(r.seq)); setSentTo(undefined); wa.refetch(); } catch (e) { toast.bad('Could not remove it', (e as Error).message); } }}>Remove</Button>
            </div>
          ) : (
            <div className="mt-2 space-y-3">
              <p className="text-sm text-muted">Held actions arrive with a link to the decision page. On a rule approvable in chat, the message also carries Approve and Reject, which decide for you only, from the number you verify here.</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Your number" htmlFor="wa-num" className="flex-1 min-w-[180px]" error={send.error?.message}>
                  <Input id="wa-num" type="tel" inputMode="tel" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+91 98450 11203" />
                </Field>
                <Button variant="secondary" loading={send.pending} icon={<RefreshCw className="h-4 w-4" />} onClick={async () => {
                  try {
                    const r = await send.mutate(orgId, userId, number);
                    pushMail({ channel: 'whatsapp', to: r.sentTo, subject: 'Elan1 Govern verification code', body: `Your code is ${r.testCode}. It expires in 10 minutes. Do not share it.`, orgId });
                    setSentTo(r.sentTo);
                    toast.info('Code sent', `To ${r.sentTo} on WhatsApp — shown in the demo outbox below.`);
                  } catch { /* shown */ }
                }}>{sentTo ? 'Resend' : 'Send code'}</Button>
              </div>
              {sentTo && (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="6-digit code" htmlFor="wa-code" className="flex-1 min-w-[160px]" error={verify.error?.message}>
                      <Input id="wa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} mono value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                    </Field>
                    <Button variant="primary" loading={verify.pending} disabled={code.length !== 6} onClick={async () => { try { const r = await verify.mutate(orgId, userId, code); toast.ok('WhatsApp verified', note(r.seq)); setCode(''); setSentTo(undefined); wa.refetch(); } catch { /* shown */ } }}>Verify</Button>
                  </div>
                  <DemoOutbox to={sentTo} title="Demo outbox — WhatsApp" limit={1} />
                </>
              )}
            </div>
          )}
        </section>
      </div>

      <Dialog open={slackOpen} onClose={() => setSlackOpen(false)} size="sm" title={`Slack · ${slack?.workspace ?? ''}`} description="Simulated Slack consent screen."
        footer={<><Button variant="ghost" onClick={() => setSlackOpen(false)}>Cancel</Button><Button variant="primary" loading={linking} onClick={() => void setSlack(true)}>Allow</Button></>}>
        <p className="text-sm leading-relaxed">Elan1 Govern is asking to identify you in <span className="font-medium">{slack?.workspace}</span> (users:read.email), so that held actions routed to your approver groups can be sent to you, and your decisions in Slack recorded under your name.</p>
      </Dialog>
    </Panel>
  );
}

function Item({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-line last:border-b-0 min-w-0">
      <dt className="text-muted shrink-0">{k}</dt>
      <dd className="text-right min-w-0">{children}</dd>
    </div>
  );
}

function Door({ to, icon, door, label }: { to: string; icon: ReactNode; door: string; label: string }) {
  return (
    <li className="bg-surface">
      <Link to={to} className="group flex items-center gap-3 p-4 h-full hover:bg-sunken/60">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-line text-fg">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block label">{door}</span>
          <span className="block text-sm font-medium">{label}</span>
        </span>
        <ArrowUpRight className="h-4 w-4 text-subtle group-hover:text-fg" aria-hidden />
      </Link>
    </li>
  );
}
