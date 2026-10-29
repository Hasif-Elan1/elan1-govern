import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, Clock3, Inbox, Loader2, ShieldCheck } from 'lucide-react';
import { db } from '@/api';
import { ORGS, userById } from '@/mock/users';
import { ROLE_INFO } from '@/lib/permissions';
import { LEVEL_INFO } from '@/lib/levels';
import { relative } from '@/lib/format';
import { Avatar, Badge, Banner, Button, Field, Input, toast } from '@/components/ui';
import { orgApi, orgState } from '@/features/settings/orgApi';
import { AuthHeading, AuthLayout } from './AuthLayout';
import { PasswordChecklist, PasswordInput, passwordChecks, passwordOk } from './password';
import { acceptInvitation, createdOrg, createdOrgInvites } from './registry';

type Found = NonNullable<ReturnType<typeof orgApi.inviteByToken>>;

const TOKEN_SHAPE = /^inv_[A-Za-z0-9]{8,64}$/;

/**
 * Resolve an invitation token through orgApi.inviteByToken: the token must be one an organisation issued,
 * and its state (valid, expired, used, withdrawn, replaced) comes from the organisation's own record. Only
 * organisations already open in this browser are searched by orgApi, so the others are opened one at a time
 * until the token is found. Organisations created in this browser keep their invitations in the registry.
 */
async function resolveInvite(token: string): Promise<Found | undefined> {
  if (!TOKEN_SHAPE.test(token)) return undefined;
  for (const o of ORGS) {
    if (!createdOrg(o.id)) continue;
    const i = createdOrgInvites(o.id).find((x) => x.token === token);
    if (!i) continue;
    const state = i.usedAt ? 'used' : i.revokedAt ? 'revoked' : i.replacedBy ? 'replaced' : new Date(i.expiresAt).getTime() < Date.now() ? 'expired' : 'valid';
    return { orgId: o.id, orgName: o.name, invite: { ...i }, state } as Found;
  }
  const hit = orgApi.inviteByToken(token);
  if (hit) return hit;
  for (const orgId of db.orgIds()) {
    if (createdOrg(orgId)) continue;
    const d = db.peekDB(orgId) as (ReturnType<typeof db.getDB> & { orgSettings?: unknown }) | undefined;
    if (d?.orgSettings) continue; // already searched above
    orgState(orgId); // opens the organisation and its settings, issuing tokens for seeded invitations
    const f = orgApi.inviteByToken(token);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 0));
  }
  return undefined;
}

/** The membership an accepted invitation creates, with the invited role (kept if one already exists). */
function ensureMembership(orgId: string, userId: string, role: Found['invite']['role']) {
  if (createdOrg(orgId)) return;
  const d = db.getDB(orgId);
  const m = d.members.find((x) => x.userId === userId);
  if (m) { if (m.status !== 'active') { m.status = 'active'; db.touch(orgId, 'member'); } return; }
  d.members.push({ userId, role, status: 'active', lastActiveAt: new Date().toISOString() });
  db.touch(orgId, 'member');
}

export default function InvitePage() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [found, setFound] = useState<Found | undefined | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { document.title = 'Accept an invitation · Elan1 Govern'; }, []);
  useEffect(() => {
    let live = true;
    setFound(null);
    // opening organisations to find the token is real work; let the page paint first
    window.setTimeout(() => { resolveInvite(token).then((f) => { if (live) setFound(f); }).catch(() => { if (live) setFound(undefined); }); }, 40);
    return () => { live = false; };
  }, [token]);

  const invite = found?.invite;
  const inviter = userById(invite?.invitedBy);
  const org = ORGS.find((o) => o.id === found?.orgId);
  const role = invite ? ROLE_INFO[invite.role] : undefined;
  const checks = passwordChecks(password, { email: invite?.email, name });
  const nameErr = name.trim().length < 2 ? 'Enter your full name.' : undefined;
  const ok = !nameErr && passwordOk(password, { email: invite?.email, name });

  const accept = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!ok || !invite) return;
    setBusy(true);
    setError(undefined);
    try {
      // the link may have been used, withdrawn or replaced since the page opened (another tab, an admin)
      const fresh = await resolveInvite(token);
      if (!fresh || fresh.state !== 'valid') { setFound(fresh); setBusy(false); return; }
      // single use: orgApi.acceptInvite marks the token used and activates the membership; the account is made with it
      const r = await acceptInvitation(token, name, password);
      ensureMembership(r.orgId, r.user.id, fresh.invite.role);
      toast.ok(`Welcome to ${r.orgName}`, `Signed in as ${r.user.name}, ${ROLE_INFO[r.user.role].label.toLowerCase()}. The invitation link no longer works.`);
      nav(r.user.role === 'approver' ? '/approvals' : '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (found === null) {
    return (
      <AuthLayout statement={<>A person commits it.</>}>
        <div role="status" className="inline-flex items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Checking the invitation…</div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout statement={<>A person commits it.</>} sub={<p>Approvers decide the actions a rulebook holds back — in the console, from an email link, or in Slack and WhatsApp for rules marked approvable in chat.</p>}>
      {!found || found.state !== 'valid' ? (
        <div>
          <span className="inline-flex h-11 w-11 items-center justify-center border border-line bg-surface"><Clock3 className="h-5 w-5" aria-hidden /></span>
          <AuthHeading kicker="Invitation" title={!found ? 'This invitation link is not valid' : found.state === 'expired' ? 'This invitation has expired' : found.state === 'used' ? 'This invitation was already accepted' : found.state === 'replaced' ? 'A newer invitation replaced this one' : 'This invitation was withdrawn'}>
            {!found
              ? 'No organisation issued this link. Check that it was copied in full from the invitation email. '
              : found.state === 'expired'
                ? `The invitation to ${found.orgName} for ${found.invite.email} expired ${relative(found.invite.expiresAt)}. `
                : found.state === 'used'
                  ? `${found.invite.email} accepted it${found.invite.usedAt ? ` ${relative(found.invite.usedAt)}` : ''}. If that was you, sign in with the password you chose. `
                  : found.state === 'replaced'
                    ? `${found.orgName} sent ${found.invite.email} a newer invitation, and this link stopped working when it did. Use the newest email. `
                    : `${found.orgName} withdrew the invitation for ${found.invite.email}. `}
            Invitation links work once and expire after 7 days. {found?.state === 'used' ? 'For anything else, ask' : 'For a new one, ask'} {inviter ? inviter.name : 'an owner or admin'}{found?.state === 'used' ? '.' : ' to send it from the Agents door, under People and roles.'}
          </AuthHeading>
          <Button variant={found?.state === 'used' ? 'primary' : 'secondary'} onClick={() => nav('/login')}>Go to sign in</Button>
        </div>
      ) : (
        <>
          <div className="mb-7 border border-line bg-surface">
            <div className="flex items-start gap-3 p-4">
              {inviter && <Avatar initials={inviter.initials} size={36} />}
              <div className="min-w-0">
                <p className="text-md leading-snug"><span className="font-semibold">{inviter?.name ?? 'An owner'}</span> invited you to <span className="font-semibold">{found.orgName}</span> as {role!.label === 'Admin' || role!.label === 'Approver' || role!.label === 'Owner' || role!.label === 'Auditor' ? 'an' : 'a'} <span className="font-semibold">{role!.label}</span></p>
                <p className="mt-1 text-xs text-muted">{inviter?.title ? `${inviter.title} · ` : ''}sent to {invite!.email} · expires {relative(invite!.expiresAt)}{org ? ` · ${LEVEL_INFO[org.plan].label}` : ''}</p>
              </div>
            </div>
            <div className="border-t border-line px-4 py-3 bg-sunken/50">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="inverse">{role!.label}</Badge><span className="text-sm">{role!.summary}</span></div>
              <ul className="mt-3 space-y-1.5 text-sm text-muted">
                {invite!.role === 'approver' && <li className="flex items-start gap-2"><Inbox className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />Held actions routed to an approver group you belong to appear in your inbox. An owner adds you to a group.</li>}
                <li className="flex items-start gap-2"><ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />Accepting is recorded as a receipt on the organisation’s chain, with your name; so is every decision you make.</li>
              </ul>
            </div>
          </div>

          <AuthHeading kicker="Accept the invitation" title="Set up your account" />
          <form onSubmit={accept} noValidate className="space-y-4">
            <Field label="Email" htmlFor="inv-email" hint="Set by the invitation. To use a different address, ask for a new invitation.">
              <Input id="inv-email" value={invite!.email} readOnly className="bg-sunken text-muted" />
            </Field>
            <Field label="Full name" htmlFor="inv-name" required error={submitted ? nameErr : undefined}>
              <Input id="inv-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} invalid={submitted && !!nameErr} autoFocus />
            </Field>
            <Field label="Password" htmlFor="inv-pw" required error={submitted && !passwordOk(password, { email: invite!.email, name }) ? 'Choose a password that meets the checks below.' : undefined}>
              <PasswordInput id="inv-pw" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="inv-checks" />
              <PasswordChecklist id="inv-checks" checks={checks} />
            </Field>
            {error && <div role="alert"><Banner tone="bad">{error}</Banner></div>}
            <Button type="submit" variant="primary" size="lg" block loading={busy} icon={!busy ? <Check className="h-4 w-4" /> : undefined}>Accept and join {found.orgName}</Button>
            <p className="text-xs text-muted leading-relaxed">You are signed in as yourself with the {role!.label.toLowerCase()} role. The link works once; after this it shows as accepted.</p>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
