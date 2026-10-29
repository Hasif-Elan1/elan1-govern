/**
 * The sign-in policy every password sign-in goes through — the sign-in page, the approve-by-link page and
 * anything else that starts a console session. One place decides, per organisation:
 *   1. single sign-on only (OpenID Connect, verified domains): passwords for those addresses are not checked;
 *   2. suspension or removal: the member record in that organisation (an auditor suspended in one client
 *      organisation still signs in to the others);
 *   3. SAML required ("Require SAML for everyone"): passwords are refused for the organisation's own people,
 *      except a break-glass owner — an owner with two-step sign-in on, as the SAML settings tell owners to keep —
 *      and anyone holding an emergency-access grant approved by a second person (named on the sign-in receipt);
 *   4. whether a two-step code is needed.
 *
 * It also applies the demo's seeded sign-in state to an organisation's records when they open (a suspended
 * member, written as a receipt) and retires a SAML requirement that older saved demo data carried without
 * anyone having switched it on.
 */
import type { User } from '@/types';
import { db } from '@/api';
import type { OrgDB } from '@/mock/db';
import { DEMO_ACCOUNTS, ORGS, USERS, userById } from '@/mock/users';
import { PROVIDER_LABEL, orgApi, orgState } from '@/features/settings/orgApi';
import { breakGlassActiveFor, breakGlassAllowsEmail } from '@/mock/ops';

export type Refusal =
  | { kind: 'sso_only'; orgName: string; provider: string; domain: string }
  | { kind: 'saml_required'; orgName: string; provider: string }
  | { kind: 'suspended'; orgName: string }
  | { kind: 'not_member'; orgName: string };

/**
 * How a break-glass password sign-in is allowed: an owner with two-step sign-in keeping a password while SAML is
 * required, or a time-boxed emergency-access grant approved by a second owner or admin (src/mock/ops.ts).
 */
export interface BreakGlassInfo {
  via: 'owner' | 'grant';
  /** what the password got past: SAML required, or an SSO-only domain */
  past: 'saml' | 'sso_only';
  grantId?: string;
  approvedBy?: string;
  expiresAt?: string;
}

export type Policy = { ok: true; mfa: boolean; breakGlass?: boolean; bg?: BreakGlassInfo } | ({ ok: false } & Refusal);

/** The grant that lets this person sign in with a password now, if any. */
function grantFor(orgId: string, userId: string, past: BreakGlassInfo['past']): BreakGlassInfo | undefined {
  try {
    const g = breakGlassActiveFor(orgId, userId);
    return g ? { via: 'grant', past, grantId: g.id, approvedBy: g.approvedBy, expiresAt: g.expiresAt } : undefined;
  } catch { return undefined; }
}

/**
 * The method label, receipt details and wording for a break-glass sign-in, so the record says which kind it was and,
 * for a grant, which grant: password sign-in under emergency access can always be told apart.
 */
export function breakGlassSignIn(bg: BreakGlassInfo | undefined) {
  if (!bg) return undefined;
  const pastText = bg.past === 'saml' ? 'SAML is required in this organisation' : 'this address normally signs in only through single sign-on';
  if (bg.via === 'grant') {
    const who = bg.approvedBy ? userById(bg.approvedBy)?.name ?? bg.approvedBy : 'a second owner or admin';
    const until = bg.expiresAt ? new Date(bg.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '';
    return {
      suffix: bg.grantId ? ` (emergency access ${bg.grantId})` : ' (emergency access)',
      details: { break_glass: true, break_glass_via: 'emergency_access', ...(bg.grantId ? { grant: bg.grantId } : {}), ...(bg.approvedBy ? { grant_approved_by: bg.approvedBy } : {}), ...(bg.expiresAt ? { grant_expires_at: bg.expiresAt } : {}), [bg.past === 'saml' ? 'saml_required' : 'sso_only']: true } as Record<string, string | boolean>,
      title: 'Emergency access sign-in',
      text: `${pastText[0].toUpperCase()}${pastText.slice(1)}. You may use a password because ${who} approved emergency access for you${until ? `, until ${until} IST` : ''}. The sign-in receipt names the grant${bg.grantId ? ` (${bg.grantId})` : ''}.`,
    };
  }
  return {
    suffix: ' (break-glass owner)',
    details: { break_glass: true, break_glass_via: 'owner_two_step', [bg.past === 'saml' ? 'saml_required' : 'sso_only']: true } as Record<string, string | boolean>,
    title: 'Break-glass sign-in',
    text: `${pastText[0].toUpperCase()}${pastText.slice(1)}. As an owner with two-step sign-in you may still use a password, so the organisation is never locked out when the identity provider is down. The sign-in receipt records it as break-glass.`,
  };
}

const norm = (email: string) => email.trim().toLowerCase();
const fresh = (orgId: string) => { try { return db.isFresh(orgId); } catch { return false; } };

/* ── Seeded sign-in state (applied once per organisation's records) ─────── */

/** Members the demo starts suspended, so a suspension and its sign-in refusal can be shown without setting one up. */
export const SEEDED_SUSPENSIONS: { orgId: string; userId: string; by: string; reason: string }[] = [
  { orgId: 'org_northbank', userId: 'u_nb_deepak', by: 'u_nb_neha', reason: 'Moved to a group audit role; access paused while the access review is open' },
];

const SEED_VERSION = 1;
type Seeded = OrgDB & { authSeed?: number };

/** Apply the seeded sign-in state to an organisation once. Safe to call often; does nothing the second time. */
export function ensureAuthSeeds(orgId: string) {
  if (fresh(orgId)) return;
  let d: Seeded;
  try { d = db.getDB(orgId) as Seeded; } catch { return; }
  if ((d.authSeed ?? 0) >= SEED_VERSION) return;
  d.authSeed = SEED_VERSION;
  // older saved data had SAML required at L2 and above although nobody switched it on (no identity.updated
  // receipt says so); it never applied to sign-in then, so it is retired rather than enforced without warning
  const saml = d.platform?.identity?.saml;
  if (saml?.enforced && !d.receipts.some((r) => r.action === 'identity.updated' && r.details?.saml_enforced === true)) saml.enforced = false;
  for (const s of SEEDED_SUSPENSIONS.filter((x) => x.orgId === orgId)) {
    const m = d.members.find((x) => x.userId === s.userId);
    if (!m || m.status !== 'active') continue;
    m.status = 'suspended';
    let ended = 0;
    try { orgState(orgId).sessions.filter((x) => x.userId === s.userId && !x.endedAt).forEach((x) => { x.endedAt = new Date().toISOString(); x.endReason = 'Suspended'; ended++; }); } catch { /* no session list yet */ }
    db.logAdmin(orgId, s.by, 'member.suspended', { member: userById(s.userId)?.name ?? s.userId, reason: s.reason, sessions_ended: ended });
  }
  db.touch(orgId, 'member');
}

if (typeof window !== 'undefined') {
  db.subscribe((orgId, kind) => { if (kind === 'open') ensureAuthSeeds(orgId); });
  // organisations opened before this module loaded (it arrives with the sign-in pages and settings)
  window.setTimeout(() => { for (const id of db.orgIds()) if (db.peekDB(id)) ensureAuthSeeds(id); }, 0);
}

/* ── SAML required, and the break-glass owner ─────────────────────────── */

/** Is the address one of the organisation's own (its domain, or a domain listed for single sign-on)? */
function onOrgDomain(orgId: string, email: string) {
  const dom = norm(email).split('@')[1];
  if (!dom) return false;
  const d = db.getDB(orgId);
  if (d.org.domain === dom) return true;
  try { return orgState(orgId).oidc.domains.some((x) => x.name === dom); } catch { return false; }
}

/** SAML is on and required for everyone in the organisation. */
export function samlRequired(orgId: string): { required: boolean; idp: string } {
  if (fresh(orgId)) return { required: false, idp: '' };
  const saml = (db.peekDB(orgId) ?? db.getDB(orgId)).platform?.identity?.saml;
  return { required: !!saml?.enabled && !!saml.enforced, idp: saml?.idp ?? 'your identity provider' };
}

/** Owners who may still sign in with a password while SAML is required: active, with two-step sign-in on. */
export function breakGlassOwners(orgId: string): string[] {
  if (fresh(orgId)) return [];
  const d = db.peekDB(orgId) ?? db.getDB(orgId);
  return d.members.filter((m) => m.role === 'owner' && m.status === 'active' && orgApi.mfaOn(orgId, m.userId)).map((m) => m.userId);
}

/* ── The policy ───────────────────────────────────────────────────────── */

/** OpenID Connect SSO-only for the address's domain in this organisation (asked before any password is checked). */
export function ssoOnlyIn(orgId: string, email: string): Policy | undefined {
  if (fresh(orgId)) return undefined;
  try {
    if (orgApi.signInRoute(orgId, norm(email)).route !== 'sso_only') return undefined;
    // emergency access approved by a second owner or admin, still inside its time box (src/mock/ops.ts)
    if (db.peekDB(orgId) && breakGlassAllowsEmail(orgId, email)) return undefined;
    return { ok: false, kind: 'sso_only', orgName: db.getDB(orgId).org.name, provider: PROVIDER_LABEL[orgState(orgId).oidc.provider], domain: norm(email).split('@')[1] ?? '' };
  } catch {
    return undefined;
  }
}

/**
 * Asked before any password is checked: an address on an SSO-only domain (of the account's organisation, or of
 * the organisation that owns the domain) is sent to its identity provider and its password is never tried.
 */
export function ssoOnlyFor(email: string): Policy | undefined {
  const k = norm(email);
  const dom = k.split('@')[1];
  if (!dom) return undefined;
  const orgId = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === k)?.orgId
    ?? ORGS.find((o) => o.domain === dom)?.id
    ?? ORGS.find((o) => o.id === USERS.find((u) => u.role !== 'auditor' && u.email.toLowerCase().split('@')[1] === dom)?.orgIds[0])?.id;
  return orgId ? ssoOnlyIn(orgId, k) : undefined;
}

/** The policy for one person in one organisation, after the password matched (and again after the code). */
export function policyFor(user: User, orgId: string, email: string): Policy {
  if (fresh(orgId)) return { ok: true, mfa: !!user.mfa };
  ensureAuthSeeds(orgId);
  const sso = ssoOnlyIn(orgId, email);
  if (sso) return sso;
  const d = db.getDB(orgId);
  const m = d.members.find((x) => x.userId === user.id);
  if (m?.status === 'suspended') return { ok: false, kind: 'suspended', orgName: d.org.name };
  const role = db.memberRole(orgId, user.id);
  if (!role) return { ok: false, kind: 'not_member', orgName: d.org.name };
  let mfa = orgApi.mfaOn(orgId, user.id);
  try { mfa = mfa || orgState(orgId).sessionPolicy.require2step; } catch { /* no policy yet */ }
  // an SSO-only address that got this far did so on an emergency-access grant (ssoOnlyIn let it through): say so
  let ssoRoute = false;
  try { ssoRoute = orgApi.signInRoute(orgId, norm(email)).route === 'sso_only'; } catch { /* no identity settings yet */ }
  if (ssoRoute) {
    const bg = grantFor(orgId, user.id, 'sso_only');
    if (bg) return { ok: true, mfa, breakGlass: true, bg };
  }
  const saml = samlRequired(orgId);
  if (saml.required && onOrgDomain(orgId, email)) {
    // a time-boxed emergency access grant approved by a second person is named first: the record says which grant
    const bg = grantFor(orgId, user.id, 'saml');
    if (bg) return { ok: true, mfa, breakGlass: true, bg };
    // break-glass: an owner with two-step sign-in keeps a password, so the organisation is never locked out
    if (role === 'owner' && orgApi.mfaOn(orgId, user.id)) return { ok: true, mfa: true, breakGlass: true, bg: { via: 'owner', past: 'saml' } };
    return { ok: false, kind: 'saml_required', orgName: d.org.name, provider: saml.idp };
  }
  return { ok: true, mfa };
}

/**
 * Pick the organisation a password sign-in opens: the preferred one first (an approval link's organisation, or
 * the account's home), then each of the person's organisations, taking the first whose policy lets them in.
 * When none does, the refusal for the first is returned. Suspension is per organisation.
 */
export function chooseOrg(user: User, email: string, preferred: (string | undefined)[]): { orgId: string; policy: Policy } {
  const order = Array.from(new Set([...preferred.filter((x): x is string => !!x && user.orgIds.includes(x)), ...user.orgIds]));
  let first: { orgId: string; policy: Policy } | undefined;
  for (const orgId of order) {
    const policy = policyFor(user, orgId, email);
    if (policy.ok) return { orgId, policy };
    first ??= { orgId, policy };
  }
  return first ?? { orgId: user.orgIds[0], policy: { ok: true, mfa: !!user.mfa } };
}

const REASON: Record<Refusal['kind'], string> = { sso_only: 'sso_only', saml_required: 'saml_required', suspended: 'member_suspended', not_member: 'not_a_member' };

/** Record a refused sign-in on the organisation's chain (the person is named; the password is never recorded). */
export function recordRefusal(userId: string, orgId: string, refusal: Refusal, via: 'login' | 'approval_link') {
  try {
    const r = db.logAdmin(orgId, userId, 'auth.sign_in_refused', { reason: REASON[refusal.kind], method: 'password', via });
    db.touch(orgId, 'receipt');
    return r.seq;
  } catch { return undefined; }
}

/** Plain-language text for a refusal, for pages without the full banner. */
export function refusalText(r: Refusal): string {
  switch (r.kind) {
    case 'sso_only': return `${r.orgName} signs in everyone with an @${r.domain} address through ${r.provider}. Passwords are not accepted for this address, so yours was not checked.`;
    case 'saml_required': return `${r.orgName} requires everyone to sign in through ${r.provider} (SAML). Passwords are refused; only a break-glass owner with two-step sign-in may use one.`;
    case 'suspended': return `Your account in ${r.orgName} is suspended, so you cannot sign in there. Your role and history are kept. Ask an owner or admin to reinstate you; they do it in the Agents door, under People and roles.`;
    case 'not_member': return `You are no longer a member of ${r.orgName}. Ask an owner to invite you again.`;
  }
}
