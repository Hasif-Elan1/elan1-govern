/**
 * Organisation settings API — the calls the Agents door's settings screens make that src/api does not
 * (yet) carry: the organisation profile, OIDC sign-in, sessions and their policy, two-step enrolment,
 * notification channels and routing, retention and the replay store, invitations with single-use tokens,
 * member suspension, approver-group membership, webhook delivery with a durable outbox, and closing the
 * organisation.
 *
 * State lives on the organisation's database (persisted with it, shared by everyone using this
 * organisation) under `orgSettings`, never in browser-local storage. Every change writes an admin
 * receipt naming the person. A real backend replaces these bodies without touching any screen.
 */
import type { Member, Role, Webhook, WebhookEvent } from '@/types';
import { api, db } from '@/api';
import type { OrgDB } from '@/mock/db';
import { sha256Hex } from '@/lib/crypto';
import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/legacy';
import { DEMO_ACCOUNTS, INVITED, baseApproverGroupsFor, userById } from '@/mock/users';
import { dispatchBlocked, guardDestination, isInternalName, isSovereign } from '@/mock/sovereign';
import { assertPilotWritable } from '@/mock/billing';
import {
  DEFAULT_ROUTING, domainToken, effectiveGroupsOf, recipientsOf, replayOnOf, settingsOf,
  type ChannelKey, type Lifetime, type OidcCheck, type OidcProvider, type OrgSettings, type SessionPolicy, type SessionRecord, type InviteToken,
} from '@/mock/orgSettings';

const wait = (min = 120, max = 280) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const iso = (t: number) => new Date(t).toISOString();
const H = 3.6e6;
const D = 864e5;
/** Proof is kept at least as long as the books of account it evidences: 8 years (MCA). Shorter saved values read as 8. */
export const MIN_RETENTION_YEARS = 8;
const hex =(bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');

/* ── Types (kept with the organisation's database in src/mock/orgSettings.ts) ── */

export type {
  OidcProvider, OidcDomain, OidcCheck, OidcConfig, Lifetime, SessionPolicy, SessionRecord, MfaEnrolment, ChannelKey, NotifyConfig,
  WhatsAppState, InviteToken, GroupEdit, DeadLetter, SecretRoll, Closure, OrgSettings,
} from '@/mock/orgSettings';
export { ROUTE_IDS, DEFAULT_ROUTING, domainToken } from '@/mock/orgSettings';

/* ── Webhook events: the full list is WebhookEvent in src/types.ts ── */

/** @deprecated The same type as WebhookEvent (src/types.ts); kept so existing imports keep compiling. */
export type ExtEvent = WebhookEvent;

export const WEBHOOK_EVENTS: { id: ExtEvent; what: string }[] = [
  { id: 'receipt.created', what: 'Every new receipt — decisions, approvals, outcomes and admin changes. High volume; suits a SIEM.' },
  { id: 'approval.pending', what: 'A rule held an action for a person.' },
  { id: 'approval.resolved', what: 'A held action was approved, rejected or expired.' },
  { id: 'approval.escalated', what: 'A held action was re-routed to a backup approver group.' },
  { id: 'alert.created', what: 'A detector raised an alert on an agent.' },
  { id: 'stop.engaged', what: 'The emergency stop was engaged.' },
  { id: 'stop.lifted', what: 'The emergency stop was lifted.' },
  { id: 'erasure.requested', what: 'A personal-data erasure request was opened (every level).' },
  { id: 'erasure.executed', what: 'Salts were destroyed for an approved erasure request.' },
  { id: 'counterparty.receipt', what: 'A receipt was issued to, received from or verified for a counterparty (L3).' },
  { id: 'timestamp.anchored', what: 'A Merkle batch received its timestamps (L2 and above).' },
  // shown at every level: L1 copy never says "signed" until DR-017 is decided
  { id: 'chain.integrity', what: 'A checkpoint fixed the chain head (sealed at L1, signed from L2).' },
];

/** The events a receipt produces, for endpoints that subscribe to them. */
function eventsOf(r: { kind: string; action?: string; decision?: string }): ExtEvent[] {
  const out: ExtEvent[] = ['receipt.created'];
  if (r.kind === 'decision' && r.decision === 'ask') out.push('approval.pending');
  if (r.kind === 'approval') out.push('approval.resolved');
  const a = r.action ?? '';
  if (a === 'approval.escalated' || a === 'approval.rerouted') out.push('approval.escalated');
  if (a === 'stop.engaged') out.push('stop.engaged');
  if (a === 'stop.lifted') out.push('stop.lifted');
  if (a === 'erasure.requested') out.push('erasure.requested');
  if (a === 'erasure.executed') out.push('erasure.executed');
  if (a.startsWith('counterparty.receipt')) out.push('counterparty.receipt');
  return out;
}

/* ── State on the organisation's database ─────────────────────────────── */

type WithSettings = OrgDB & { orgSettings?: OrgSettings };

const mailDomain = (d: OrgDB) => d.org.domain ?? `${d.org.slug}.in`;

/** The organisation's settings (created on first use and saved with the organisation). */
export function orgState(orgId: string): OrgSettings {
  return settingsOf(db.getDB(orgId));
}

function commit(orgId: string, kind = 'settings') { db.touch(orgId, kind); }
function record(orgId: string, userId: string, action: string, details: Record<string, string | number | boolean>, agent?: string) {
  return db.logAdmin(orgId, userId, action, details, agent);
}
/** The caller must hold one of `roles` as an active member (member record: suspended, invited or removed hold none). */
function requireRole(orgId: string, userId: string, roles: Role[], what: string) {
  const role = db.memberRole(orgId, userId);
  if (!role || !roles.includes(role)) throw new Error(`${what} — ${roles.map((r) => `${r}s`).join(' and ')} can do this; your role cannot.`);
  // read-only after a pilot's hard stop (mock/billing.ts); removing or suspending someone stays possible
  if (what !== 'Removing members' && what !== 'Suspending members') assertPilotWritable(orgId, userId, 'write');
}

/* ══ Organisation profile ═══════════════════════════════════════════════ */

export type OrgPatch = Partial<Pick<OrgDB['org'], 'name' | 'industry' | 'regions' | 'currency' | 'timezone'>>;

export const orgApi = {
  /** The organisation record (a copy). */
  async org(orgId: string) {
    await wait(60, 140);
    return clone(db.getDB(orgId).org);
  },

  /** Change the organisation profile. Owners and admins. Writes org.updated naming the changed fields. */
  async updateOrg(orgId: string, patch: OrgPatch, userId: string) {
    await wait(200, 400);
    requireRole(orgId, userId, ['owner', 'admin'], 'Editing the organisation');
    const org = db.getDB(orgId).org;
    if (patch.name !== undefined && patch.name.trim().length < 2) throw new Error('Enter the organisation’s name.');
    if (patch.regions && !patch.regions.length) throw new Error('Choose at least one region.');
    const changed = (Object.keys(patch) as (keyof OrgPatch)[]).filter((k) => JSON.stringify(org[k]) !== JSON.stringify(patch[k]));
    if (!changed.length) throw new Error('Nothing changed.');
    Object.assign(org, { ...patch, ...(patch.name ? { name: patch.name.trim() } : {}) });
    const r = record(orgId, userId, 'org.updated', { changed: changed.join(', '), industry: org.industry, regions: org.regions.join(', ') });
    commit(orgId, 'org');
    return { org: clone(org), seq: r.seq };
  },

  /* ══ Single sign-on (OIDC) ════════════════════════════════════════════ */

  async oidc(orgId: string) {
    await wait(60, 140);
    return clone(orgState(orgId).oidc);
  },

  /** Owner only. Saves the OIDC connection; the client secret is kept only as its last 4 characters in this console. */
  async saveOidc(orgId: string, input: { provider: OidcProvider; issuer: string; clientId: string; secret?: string }, userId: string) {
    await wait(300, 500);
    requireRole(orgId, userId, ['owner'], 'Single sign-on');
    if (!/^https:\/\/[^\s/]+\.[^\s]+/.test(input.issuer.trim()) && input.issuer.trim() !== 'https://accounts.google.com') throw new Error('Enter the issuer URL, starting with https://.');
    if (input.clientId.trim().length < 6) throw new Error('Enter the client id from your provider.');
    const s = orgState(orgId).oidc;
    if (!s.secretLast4 && (!input.secret || input.secret.length < 8)) throw new Error('Paste the client secret.');
    // Sovereign: deny-all egress. An identity provider outside the network is refused and recorded (egress.blocked)
    guardSovereignIssuer(orgId, input.provider, input.issuer.trim(), userId);
    Object.assign(s, { provider: input.provider, issuer: input.issuer.trim(), clientId: input.clientId.trim(), savedAt: iso(Date.now()), savedBy: userId, test: undefined });
    if (input.secret) s.secretLast4 = input.secret.slice(-4);
    const r = record(orgId, userId, 'sso.configured', { provider: input.provider, issuer: s.issuer });
    commit(orgId, 'sso');
    return { config: clone(s), seq: r.seq };
  },

  /**
   * Test the saved connection: fetch the discovery document and the signing keys. Deterministic in this
   * console — the issuer must have the provider's real shape (an Okta authorisation server, an Entra
   * tenant id, Google, or a Keycloak realm on the organisation's own domain), and the client id must be set.
   */
  async ssoTest(orgId: string, userId: string) {
    await wait(600, 1000);
    const s = orgState(orgId).oidc;
    const d = db.getDB(orgId);
    const iss = s.issuer;
    // Sovereign: the discovery document is fetched only from an issuer inside the network; anything else is
    // refused before a request leaves, and recorded as egress.blocked (the same as Slack, WhatsApp and webhooks)
    guardSovereignIssuer(orgId, s.provider, iss, userId);
    const shape: Record<OidcProvider, RegExp> = {
      okta: /^https:\/\/[a-z0-9-]+\.okta\.com\/oauth2\/[A-Za-z0-9]+$/,
      entra: /^https:\/\/login\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/,
      google: /^https:\/\/accounts\.google\.com$/,
      keycloak: new RegExp(`^https://[a-z0-9.-]*${mailDomain(d).replace(/\./g, '\\.')}/realms/[a-z0-9-]+$`),
    };
    // a Keycloak realm on an internal name (.internal, .local, .lan, a private address) answers inside a Sovereign network
    const reach = shape[s.provider].test(iss) || (s.provider === 'keycloak' && isSovereign(orgId) && isInternalName(orgId, iss) && /^https:\/\/[^/\s]+\/realms\/[a-z0-9-]+$/.test(iss));
    const checks: OidcCheck[] = [
      { label: 'Discovery document', ok: reach, detail: reach ? `${iss}/.well-known/openid-configuration answered 200.` : `${iss || 'The issuer'}/.well-known/openid-configuration did not answer as a ${PROVIDER_LABEL[s.provider]} issuer (HTTP 404). Check the URL in your provider.` },
      { label: 'Signing keys (JWKS)', ok: reach, detail: reach ? '2 RS256 keys found at jwks_uri.' : 'Not checked — the discovery document was not found.' },
      { label: 'Client id', ok: reach && s.clientId.length >= 6, detail: s.clientId.length >= 6 ? `Client ${s.clientId} is accepted at the token endpoint.` : 'No client id saved.' },
      { label: 'Redirect URI registered', ok: reach, detail: reach ? `${redirectUri(orgId)} is on the client’s allow-list.` : 'Not checked.' },
    ];
    const ok = checks.every((c) => c.ok);
    s.test = { ok, at: iso(Date.now()), checks };
    const r = record(orgId, userId, ok ? 'sso.test_passed' : 'sso.test_failed', { provider: s.provider, issuer: iss || '(none)' });
    commit(orgId, 'sso');
    return { ok, checks, seq: r.seq };
  },

  /** Look up the TXT record for a domain. The record exists only where the organisation published it. */
  async verifyDomain(orgId: string, name: string, userId: string) {
    await wait(700, 1200);
    requireRole(orgId, userId, ['owner'], 'Verifying a domain');
    const s = orgState(orgId).oidc;
    const dm = s.domains.find((x) => x.name === name);
    if (!dm) throw new Error('That domain is not listed.');
    const published = dnsTxt(orgId, name);
    const want = `elan1-govern-verify=${dm.token}`;
    dm.checkedAt = iso(Date.now());
    dm.lastCheck = published.includes(want) ? 'found' : published.some((t) => t.startsWith('elan1-govern-verify=')) ? 'mismatch' : 'not_found';
    let seq: number | undefined;
    if (dm.lastCheck === 'found') {
      dm.verified = true;
      seq = record(orgId, userId, 'sso.domain_verified', { domain: name }).seq;
    }
    commit(orgId, 'sso');
    return { domain: clone(dm), published, seq };
  },

  async addDomain(orgId: string, name: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner'], 'Adding a domain');
    const d = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error('Enter a domain like company.com.');
    const s = orgState(orgId).oidc;
    if (s.domains.some((x) => x.name === d)) throw new Error('That domain is already listed.');
    s.domains.push({ name: d, token: domainToken(orgId, d), verified: false });
    const r = record(orgId, userId, 'sso.domain_added', { domain: d });
    commit(orgId, 'sso');
    return { seq: r.seq };
  },

  async removeDomain(orgId: string, name: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner'], 'Removing a domain');
    const s = orgState(orgId).oidc;
    const dm = s.domains.find((x) => x.name === name);
    if (!dm) throw new Error('That domain is not listed.');
    if (s.ssoOnly && dm.verified && s.domains.filter((x) => x.verified).length === 1) throw new Error('This is the only verified domain while SSO-only is on. Turn SSO-only off first.');
    s.domains = s.domains.filter((x) => x.name !== name);
    const r = record(orgId, userId, 'sso.domain_removed', { domain: name, was_verified: dm.verified });
    commit(orgId, 'sso');
    return { seq: r.seq };
  },

  async setSsoOnly(orgId: string, on: boolean, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner'], 'SSO-only');
    const s = orgState(orgId).oidc;
    const verified = s.domains.filter((x) => x.verified).map((x) => x.name);
    if (on && (!s.savedAt || !verified.length)) throw new Error('Save the connection and verify at least one domain first.');
    s.ssoOnly = on;
    const r = record(orgId, userId, on ? 'sso.enforced' : 'sso.relaxed', { domains: verified.join(', ') });
    commit(orgId, 'sso');
    return { seq: r.seq, domains: verified };
  },

  async setJit(orgId: string, patch: { jit?: boolean; jitRole?: Role }, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner'], 'Just-in-time accounts');
    const s = orgState(orgId).oidc;
    Object.assign(s, patch);
    const r = record(orgId, userId, 'sso.jit_changed', { jit: s.jit, default_role: s.jitRole });
    commit(orgId, 'sso');
    return { seq: r.seq };
  },

  /**
   * How a work email signs in here: 'password', 'sso' (verified domain, password still works) or
   * 'sso_only' (password refused). The sign-in page asks this before it asks for a password.
   */
  signInRoute(orgId: string, email: string): { route: 'password' | 'sso' | 'sso_only'; issuer?: string } {
    const s = orgState(orgId).oidc;
    const dom = email.split('@')[1]?.toLowerCase();
    const dm = s.domains.find((x) => x.name === dom && x.verified);
    if (!s.savedAt || !dm) return { route: 'password' };
    return { route: s.ssoOnly ? 'sso_only' : 'sso', issuer: s.issuer };
  },

  /* ══ Sessions, policy, two-step sign-in ═══════════════════════════════ */

  /** Record this browser's session for the signed-in person (once per sign-in). */
  registerSession(orgId: string, userId: string, signedInAt: number | undefined, ua: string, mfa: boolean) {
    if (!signedInAt) return;
    const s = orgState(orgId);
    const id = `ses_${userId}_${signedInAt}`;
    const existing = s.sessions.find((x) => x.id === id);
    if (existing) { existing.lastActiveAt = iso(Date.now()); return; }
    const { label, phone } = describeAgent(ua);
    s.sessions.unshift({ id, userId, device: label, kind: phone ? 'phone' : 'desktop', method: mfa ? 'Password and 2-step code' : 'Password', startedAt: iso(signedInAt), lastActiveAt: iso(Date.now()), via: 'console' });
    s.sessions = s.sessions.slice(0, 60);
    commit(orgId, 'session');
  },

  /** Sessions for a person: this browser's console sign-ins plus single-use approval links they opened. */
  async sessions(orgId: string, userId: string) {
    await wait(60, 140);
    const s = orgState(orgId);
    const d = db.getDB(orgId);
    const life = lifetimeMs(s.sessionPolicy.lifetime);
    const links: SessionRecord[] = d.platform.links.filter((l) => l.issuedTo === userId && l.usedAt).map((l) => ({
      id: `lnk_${l.token.slice(-10)}`, userId, device: `Approval link · ${l.channel === 'whatsapp' ? 'WhatsApp' : l.channel === 'email' ? 'Email' : 'Phone'}`, kind: 'phone' as const,
      method: 'Single-use link', startedAt: l.usedAt!, lastActiveAt: l.usedAt!, endedAt: l.usedAt!, endReason: 'Ended after the one decision it allowed', via: 'approval_link' as const, approvalId: l.approvalId, seq: l.usedSeq,
    }));
    const mine = s.sessions.filter((x) => x.userId === userId).map((x) => {
      const expired = !x.endedAt && Date.now() - new Date(x.startedAt).getTime() > life;
      return expired ? { ...x, endedAt: iso(new Date(x.startedAt).getTime() + life), endReason: `Expired after the ${s.sessionPolicy.lifetime} session lifetime` } : x;
    });
    return clone({ sessions: [...mine, ...links].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), policy: s.sessionPolicy, lifetimeMs: life });
  },

  async endSession(orgId: string, userId: string, sessionId: string) {
    await wait();
    const s = orgState(orgId);
    const x = s.sessions.find((y) => y.id === sessionId && y.userId === userId);
    if (!x) throw new Error('That session is not yours or no longer exists.');
    x.endedAt = iso(Date.now());
    x.endedBy = userId;
    x.endReason = 'Signed out from Sessions';
    const r = record(orgId, userId, 'session.revoked', { device: x.device, started: x.startedAt });
    commit(orgId, 'session');
    return { seq: r.seq };
  },

  async endOtherSessions(orgId: string, userId: string, keepId: string) {
    await wait();
    const s = orgState(orgId);
    const others = s.sessions.filter((y) => y.userId === userId && y.id !== keepId && !y.endedAt);
    others.forEach((x) => { x.endedAt = iso(Date.now()); x.endedBy = userId; x.endReason = 'Signed out from another session'; });
    const r = record(orgId, userId, 'session.revoked_others', { count: others.length });
    commit(orgId, 'session');
    return { count: others.length, seq: r.seq };
  },

  async setSessionPolicy(orgId: string, patch: Partial<Pick<SessionPolicy, 'lifetime' | 'require2step'>>, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner'], 'Sign-in policy');
    const p = orgState(orgId).sessionPolicy;
    Object.assign(p, patch, { updatedAt: iso(Date.now()), updatedBy: userId });
    const r = record(orgId, userId, patch.require2step !== undefined ? 'session.mfa_policy' : 'session.policy_changed', { lifetime: p.lifetime, require_2step: p.require2step });
    commit(orgId, 'session');
    return { policy: clone(p), seq: r.seq };
  },

  /** Two-step sign-in is on for a person when the directory says so or they enrolled an authenticator here. */
  mfaOn(orgId: string, userId: string) {
    return !!userById(userId)?.mfa || !!orgState(orgId).mfa[userId];
  },

  /** Start TOTP enrolment: a fresh base32 secret and its otpauth URI. Nothing is stored until a code is confirmed. */
  startTotp(orgId: string, userId: string) {
    const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
    const u = userById(userId);
    const label = encodeURIComponent(`Elan1 Govern:${u?.email ?? userId}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Elan1 Govern')}&algorithm=SHA1&digits=6&period=30`, orgId };
  },

  /** Confirm enrolment with a 6-digit code from the authenticator (RFC 6238, 30-second steps, ±1 step). */
  async confirmTotp(orgId: string, userId: string, secret: string, code: string) {
    await wait(200, 400);
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code from your authenticator app.');
    if (!verifyTotp(secret, code)) throw new Error('That code does not match. Check the time on your phone and try the newest code.');
    const r = record(orgId, userId, 'member.mfa_enrolled', { method: 'totp' });
    orgState(orgId).mfa[userId] = { enrolledAt: iso(Date.now()), secret, seq: r.seq };
    commit(orgId, 'member');
    return { seq: r.seq };
  },

  /** The current code for a secret — the authenticator's side, used by the demo helper on /you. */
  totpNow(secret: string) {
    return totp(secret, Math.floor(Date.now() / 30_000));
  },

  /** Change your password: the current one must match. Recorded as member.password_changed. */
  async changePassword(orgId: string, userId: string, current: string, next: string) {
    await wait(300, 500);
    const acct = DEMO_ACCOUNTS.find((a) => a.userId === userId);
    if (!acct || acct.password !== current) throw new Error('Your current password is not right.');
    if (next.length < 12) throw new Error('Use at least 12 characters.');
    if (next === current) throw new Error('Choose a password you have not used here.');
    const r = record(orgId, userId, 'member.password_changed', { method: 'console', other_sessions_ended: true });
    const s = orgState(orgId);
    s.passwordChanges.unshift({ userId, at: iso(Date.now()), seq: r.seq });
    s.sessions.filter((x) => x.userId === userId && !x.endedAt).slice(1).forEach((x) => { x.endedAt = iso(Date.now()); x.endReason = 'Password changed'; });
    commit(orgId, 'session');
    return { seq: r.seq, demoAccount: true };
  },

  /* ══ Notification channels and routing ════════════════════════════════ */

  async notify(orgId: string) {
    await wait(60, 140);
    const s = orgState(orgId);
    return clone({ ...s.notify, routing: { ...DEFAULT_ROUTING, ...s.notify.routing } });
  },

  /** Step 1 of the Slack OAuth install: a state value the callback must return. */
  async startSlackInstall(orgId: string, userId: string) {
    await wait(150, 300);
    requireRole(orgId, userId, ['owner', 'admin'], 'Connecting Slack');
    const state = hex(12);
    orgState(orgId).notify.slack.pendingState = state;
    return { state, scopes: ['chat:write', 'commands', 'users:read.email'], authorizeUrl: `https://slack.com/oauth/v2/authorize?scope=chat:write,commands,users:read.email&state=${state}` };
  },

  /** Step 2: Slack's callback. A wrong state or a denied consent fails and is recorded. */
  async completeSlackInstall(orgId: string, userId: string, input: { state: string; decision: 'allow' | 'deny'; workspace: string }) {
    await wait(500, 900);
    const n = orgState(orgId).notify;
    if (!n.slack.pendingState || n.slack.pendingState !== input.state) {
      record(orgId, userId, 'channel.slack_install_failed', { reason: 'state_mismatch' });
      throw new Error('The install could not be confirmed (the state value did not match). Start again from Connect Slack.');
    }
    n.slack.pendingState = undefined;
    if (input.decision === 'deny') {
      record(orgId, userId, 'channel.slack_install_failed', { reason: 'access_denied', workspace: input.workspace });
      commit(orgId, 'channel');
      throw new Error('Slack reported access_denied: the workspace admin did not allow the app. Nothing was connected.');
    }
    if (input.workspace.trim().length < 2) throw new Error('Enter the workspace name.');
    Object.assign(n.slack, { connected: true, workspace: input.workspace.trim(), team: `T0${hex(4).toUpperCase()}`, installedAt: iso(Date.now()), installedBy: userId, scopes: ['chat:write', 'commands', 'users:read.email'] });
    const r = record(orgId, userId, 'channel.slack_connected', { workspace: n.slack.workspace!, team: n.slack.team! });
    commit(orgId, 'channel');
    return { slack: clone(n.slack), seq: r.seq };
  },

  async disconnectSlack(orgId: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Disconnecting Slack');
    const n = orgState(orgId).notify;
    const ws = n.slack.workspace ?? '';
    n.slack = { connected: false, channel: n.slack.channel };
    const r = record(orgId, userId, 'channel.slack_disconnected', { workspace: ws });
    commit(orgId, 'channel');
    return { seq: r.seq };
  },

  async setSlackChannel(orgId: string, channel: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'The approvals channel');
    if (!/^#[a-z0-9][a-z0-9._-]{0,79}$/.test(channel.trim())) throw new Error('Use a Slack channel name like #govern-approvals (lower case, no spaces).');
    const n = orgState(orgId).notify;
    const from = n.slack.channel;
    n.slack.channel = channel.trim();
    const r = record(orgId, userId, 'channel.routing_changed', { slack_channel: n.slack.channel, from });
    commit(orgId, 'channel');
    return { seq: r.seq };
  },

  async setEmail(orgId: string, on: boolean, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Email notifications');
    orgState(orgId).notify.email = on;
    const r = record(orgId, userId, 'channel.routing_changed', { email: on });
    commit(orgId, 'channel');
    return { seq: r.seq };
  },

  async setRoute(orgId: string, routeId: string, channel: ChannelKey, on: boolean, userId: string) {
    await wait(80, 160);
    requireRole(orgId, userId, ['owner', 'admin'], 'Routing');
    const n = orgState(orgId).notify;
    n.routing[routeId] = { ...(n.routing[routeId] ?? DEFAULT_ROUTING[routeId]), [channel]: on };
    const r = record(orgId, userId, 'channel.routing_changed', { event: routeId, channel, on });
    commit(orgId, 'channel');
    return { seq: r.seq };
  },

  /** Who an event would reach, from the routing table and the channels each person has linked. */
  recipients(orgId: string, routeId: string, approverGroup?: string) {
    return recipientsOf(db.getDB(orgId), routeId, approverGroup);
  },

  async whatsapp(orgId: string, userId: string) {
    await wait(40, 100);
    const d = db.getDB(orgId);
    const s = orgState(orgId).whatsapp[userId];
    const m = d.members.find((x) => x.userId === userId);
    const phone = userById(userId)?.phone ?? '';
    return clone({ number: s?.number ?? phone, verified: !!s?.verifiedAt || (!!m?.whatsappVerified && (!s || s.number === phone)), pending: s?.pending ? { sentAt: s.pending.sentAt, attempts: s.pending.attempts } : undefined });
  },

  /** Send a 6-digit code over WhatsApp. On this test gateway the code is returned so it can be typed in. */
  async sendWhatsAppCode(orgId: string, userId: string, number: string) {
    await wait(400, 700);
    const num = number.trim();
    if (!/^\+[0-9][0-9 ]{9,15}$/.test(num)) throw new Error('Enter the number with country code, for example +91 98450 11203.');
    const sentAt = iso(Date.now());
    const testCode = String(parseInt(sha256Hex(`${num}:${sentAt}:${hex(4)}`).slice(0, 8), 16) % 1_000_000).padStart(6, '0');
    orgState(orgId).whatsapp[userId] = { number: num, pending: { codeHash: sha256Hex(`${userId}:${testCode}`), sentAt, attempts: 0, testCode } };
    commit(orgId, 'channel');
    return { sentTo: num, testCode };
  },

  async verifyWhatsAppCode(orgId: string, userId: string, code: string) {
    await wait(250, 450);
    const st = orgState(orgId).whatsapp[userId];
    if (!st?.pending) throw new Error('Send a code first.');
    if (Date.now() - new Date(st.pending.sentAt).getTime() > 10 * 60_000) { st.pending = undefined; throw new Error('That code expired after 10 minutes. Send a new one.'); }
    if (st.pending.attempts >= 5) { st.pending = undefined; throw new Error('Too many wrong codes. Send a new one.'); }
    if (sha256Hex(`${userId}:${code}`) !== st.pending.codeHash) {
      st.pending.attempts++;
      commit(orgId, 'channel');
      throw new Error(`That code is not right. ${5 - st.pending.attempts} ${5 - st.pending.attempts === 1 ? 'try' : 'tries'} left.`);
    }
    st.pending = undefined;
    st.verifiedAt = iso(Date.now());
    const m = db.getDB(orgId).members.find((x) => x.userId === userId);
    if (m) m.whatsappVerified = true;
    const r = record(orgId, userId, 'channel.whatsapp_verified', { number_hash: sha256Hex(st.number).slice(0, 16) });
    commit(orgId, 'member');
    return { seq: r.seq };
  },

  async forgetWhatsApp(orgId: string, userId: string) {
    await wait();
    const s = orgState(orgId);
    s.whatsapp[userId] = { number: '' };
    const m = db.getDB(orgId).members.find((x) => x.userId === userId);
    if (m) m.whatsappVerified = false;
    const r = record(orgId, userId, 'channel.whatsapp_removed', {});
    commit(orgId, 'member');
    return { seq: r.seq };
  },

  /* ══ Retention and the replay store ═══════════════════════════════════ */

  async dataPolicy(orgId: string) {
    await wait(60, 140);
    const s = orgState(orgId);
    const dep = await api.deployment(orgId);
    const d = db.getDB(orgId);
    const stored = s.replay.on ? d.receipts.filter((r) => r.kind === 'decision' && Date.now() - new Date(r.ts).getTime() < 30 * D && (!s.replay.changedAt || r.ts >= s.replay.changedAt)).length : 0;
    // the write-once lock is a floor: retention is never shorter than it (a level move can raise the lock); nor is it
    // ever shorter than 8 years (MCA books of account) — older saved state with fewer years reads as 8
    const kept = Math.max(MIN_RETENTION_YEARS, Number(s.retention?.years) || MIN_RETENTION_YEARS);
    const years = dep.storage.objectLock === 'compliance' ? Math.max(kept, dep.storage.retentionYears) : kept;
    return clone({ retention: { ...s.retention, years }, replay: s.replay, storedCalls: stored, lock: { mode: dep.storage.objectLock, years: dep.storage.retentionYears, backend: dep.storage.backend }, minYears: MIN_RETENTION_YEARS });
  },

  /**
   * Retention cannot be shorter than the write-once lock on the store (S3 Object Lock or your object-lock cluster),
   * nor than 8 years: proof is kept at least as long as the books of account it evidences (MCA).
   */
  async setRetention(orgId: string, years: number, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Retention');
    if (!Number.isFinite(years) || years < MIN_RETENTION_YEARS) throw new Error(`Retention cannot be shorter than ${MIN_RETENTION_YEARS} years: proof is kept at least as long as the books of account it evidences (MCA).`);
    const dep = await api.deployment(orgId);
    if (dep.storage.objectLock === 'compliance' && years < dep.storage.retentionYears) throw new Error(`Receipts are under ${dep.storage.backend} in compliance mode for ${dep.storage.retentionYears} years. Retention cannot be shorter than the lock.`);
    const s = orgState(orgId);
    const from = Math.max(MIN_RETENTION_YEARS, Number(s.retention?.years) || MIN_RETENTION_YEARS);
    s.retention = { years, updatedAt: iso(Date.now()), updatedBy: userId };
    const r = record(orgId, userId, 'retention.changed', { years, from, object_lock: dep.storage.objectLock, lock_years: dep.storage.retentionYears });
    commit(orgId, 'settings');
    return { seq: r.seq };
  },

  async setReplay(orgId: string, on: boolean, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'The replay store');
    const s = orgState(orgId);
    const d = db.getDB(orgId);
    const rows = s.replay.on ? d.receipts.filter((r) => r.kind === 'decision' && Date.now() - new Date(r.ts).getTime() < 30 * D && (!s.replay.changedAt || r.ts >= s.replay.changedAt)).length : 0;
    s.replay = { on, changedAt: iso(Date.now()), changedBy: userId, clearedRows: on ? undefined : rows };
    const r = record(orgId, userId, on ? 'replay_store.enabled' : 'replay_store.disabled', on ? { days: 30 } : { rows_deleted: rows });
    commit(orgId, 'settings');
    return { seq: r.seq, rows };
  },

  /** true when Test on past actions has stored arguments to replay. */
  replayOn(orgId: string) {
    return replayOnOf(db.getDB(orgId));
  },

  /** A configuration export (not evidence): the organisation's settings and objects, credentials withheld. */
  async exportConfiguration(orgId: string, userId: string) {
    await wait(300, 600);
    const d = db.getDB(orgId);
    const s = orgState(orgId);
    const body = {
      format: 'elan1-govern-config/1', exportedAt: iso(Date.now()), exportedBy: userId,
      note: 'Configuration only. Evidence (receipts, seals, anchors, keys) is exported as an auditor pack or evidence bundle.',
      org: d.org, members: d.members, agents: d.agents.map(({ scenarioKey: _s, keys, ...a }) => ({ ...a, keys: keys.map((k) => ({ id: k.id, prefix: k.prefix, label: k.label, environment: k.environment, revoked: !!k.revoked })) })),
      rulebooks: d.rulebooks, connectors: d.connectors.map((c) => ({ ...c, authHeader: c.authHeader ? '[withheld]' : undefined })),
      aiSystems: d.aiSystems, frameworks: d.frameworks.map((f) => ({ id: f.id, enabled: f.enabled })), webhooks: d.webhooks.map(({ deliveries: _d, ...w }) => w),
      settings: { sessionPolicy: s.sessionPolicy, retention: s.retention, replay: s.replay, routing: s.notify.routing, oidc: { ...s.oidc, secretLast4: s.oidc.secretLast4 ? '[withheld]' : undefined } },
    };
    const r = record(orgId, userId, 'org.config_exported', { format: 'elan1-govern-config/1' });
    return { json: JSON.stringify(body, null, 2), seq: r.seq, filename: `${d.org.slug}-configuration-${iso(Date.now()).slice(0, 10)}.json` };
  },

  /* ══ Members, invitations, suspension ═════════════════════════════════ */

  emailOf(orgId: string, m: Member) {
    return userById(m.userId)?.email ?? (m as Member & { invitedEmail?: string }).invitedEmail ?? orgState(orgId).invites.find((i) => i.userId === m.userId)?.email ?? INVITED.find((i) => i.id === m.userId)?.email ?? m.userId;
  },

  /** The live single-use invitation token for an invited member. */
  inviteFor(orgId: string, userId: string) {
    return orgState(orgId).invites.find((i) => i.userId === userId && !i.revokedAt && !i.replacedBy && !i.usedAt);
  },

  async inviteMembers(orgId: string, emails: string[], role: Role, userId: string) {
    await wait(300, 500);
    requireRole(orgId, userId, ['owner', 'admin'], 'Inviting people');
    if (role === 'owner') requireRole(orgId, userId, ['owner'], 'Inviting an owner');
    const d = db.getDB(orgId);
    const s = orgState(orgId);
    const out: InviteToken[] = [];
    let seq = 0;
    for (const raw of emails) {
      const email = raw.trim().toLowerCase();
      const now = Date.now();
      const id = `u_inv_${now.toString(36)}_${hex(2)}`;
      d.members.push({ userId: id, role, status: 'invited', invitedAt: iso(now), invitedEmail: email } as Member);
      const r = record(orgId, userId, 'member.invited', { email, role });
      seq = r.seq;
      const t: InviteToken = { token: `inv_${hex(12)}`, userId: id, email, role, invitedBy: userId, invitedAt: iso(now), expiresAt: iso(now + 7 * D), seq: r.seq };
      s.invites.push(t);
      out.push(t);
    }
    commit(orgId, 'member');
    return { invites: clone(out), seq };
  },

  /** A new token replaces the old one, which stops working at once. */
  async resendInvite(orgId: string, memberId: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Resending an invitation');
    const d = db.getDB(orgId);
    const m = d.members.find((x) => x.userId === memberId && x.status === 'invited');
    if (!m) throw new Error('That invitation no longer exists.');
    const s = orgState(orgId);
    const old = s.invites.find((i) => i.userId === memberId && !i.revokedAt && !i.replacedBy);
    const now = Date.now();
    const email = orgApi.emailOf(orgId, m);
    const r = record(orgId, userId, 'member.invite_resent', { email, role: m.role });
    const t: InviteToken = { token: `inv_${hex(12)}`, userId: memberId, email, role: m.role, invitedBy: userId, invitedAt: iso(now), expiresAt: iso(now + 7 * D), seq: r.seq };
    if (old) old.replacedBy = t.token;
    s.invites.push(t);
    m.invitedAt = iso(now);
    commit(orgId, 'member');
    return { invite: clone(t), seq: r.seq };
  },

  /** Public: what an invitation token points at — or why it no longer works. */
  inviteByToken(token: string) {
    for (const orgId of db.orgIds()) {
      const d = db.peekDB(orgId);
      if (!d) continue;
      const t = (d as WithSettings).orgSettings?.invites.find((i) => i.token === token);
      if (!t) continue;
      const state = t.usedAt ? 'used' : t.revokedAt ? 'revoked' : t.replacedBy ? 'replaced' : new Date(t.expiresAt).getTime() < Date.now() ? 'expired' : 'valid';
      return { orgId, orgName: d.org.name, invite: clone(t), state };
    }
    return undefined;
  },

  /** Public: accept an invitation (single use). */
  acceptInvite(token: string) {
    const found = orgApi.inviteByToken(token);
    if (!found) throw new Error('This invitation link is not valid.');
    if (found.state !== 'valid') throw new Error(`This invitation was ${found.state === 'replaced' ? 'replaced by a newer one' : found.state}.`);
    const s = orgState(found.orgId);
    const t = s.invites.find((i) => i.token === token)!;
    t.usedAt = iso(Date.now());
    const m = db.getDB(found.orgId).members.find((x) => x.userId === t.userId);
    if (m) { m.status = 'active'; m.lastActiveAt = t.usedAt; }
    const r = record(found.orgId, t.userId, 'member.invite_accepted', { email: t.email, role: t.role });
    commit(found.orgId, 'member');
    return { seq: r.seq };
  },

  async changeRole(orgId: string, memberId: string, to: Role, userId: string) {
    await wait(200, 400);
    requireRole(orgId, userId, ['owner', 'admin'], 'Changing roles');
    const d = db.getDB(orgId);
    const m = d.members.find((x) => x.userId === memberId);
    if (!m) throw new Error('That member no longer exists.');
    if (memberId === userId) throw new Error('You cannot change your own role.');
    const me = db.memberRole(orgId, userId);
    if ((m.role === 'owner' || to === 'owner') && me !== 'owner') throw new Error('Only an owner can make or change an owner.');
    if (m.role === 'owner' && to !== 'owner' && d.members.filter((x) => x.role === 'owner' && x.status === 'active').length <= 1) throw new Error('At least one owner must remain. Make someone else an owner first.');
    const from = m.role;
    m.role = to;
    const r = record(orgId, userId, 'member.role_changed', { member: userById(memberId)?.name ?? orgApi.emailOf(orgId, m), from, to });
    commit(orgId, 'member');
    return { seq: r.seq };
  },

  /**
   * Remove a member (or revoke an invitation). The person leaves every approver group; pending
   * approvals routed to a group they were the only member of are re-routed to that group's backup.
   */
  async removeMember(orgId: string, memberId: string, userId: string) {
    await wait(250, 450);
    requireRole(orgId, userId, ['owner', 'admin'], 'Removing members');
    const d = db.getDB(orgId);
    const s = orgState(orgId);
    const i = d.members.findIndex((x) => x.userId === memberId);
    if (i < 0) throw new Error('That member no longer exists.');
    const m = d.members[i];
    if (memberId === userId) throw new Error('You cannot remove yourself.');
    if (m.role === 'owner' && d.members.filter((x) => x.role === 'owner' && x.status === 'active').length <= 1) throw new Error('The last owner cannot be removed.');
    if ((m.role === 'owner') && db.memberRole(orgId, userId) !== 'owner') throw new Error('Only an owner can remove an owner.');
    const name = userById(memberId)?.name ?? orgApi.emailOf(orgId, m);
    if (m.status === 'invited') {
      d.members.splice(i, 1);
      s.invites.filter((t) => t.userId === memberId && !t.revokedAt).forEach((t) => { t.revokedAt = iso(Date.now()); });
      const r = record(orgId, userId, 'member.invite_revoked', { email: name, role: m.role });
      commit(orgId, 'member');
      return { seq: r.seq, groups: [] as string[], rerouted: 0 };
    }
    // leave every approver group
    const groups = effectiveGroups(orgId).filter((g) => g.members.includes(memberId));
    for (const g of groups) {
      const e = (s.groupEdits[g.id] ??= { add: [], remove: [] });
      e.add = e.add.filter((x) => x !== memberId);
      if (!e.remove.includes(memberId)) e.remove.push(memberId);
    }
    // re-route approvals that now have nobody to decide them (one held by a stop, or already past its expiry, stays put)
    const pols = (await api.escalation(orgId)).policies;
    let rerouted = 0;
    for (const a of d.approvals.filter((x) => x.status === 'pending')) {
      const g = effectiveGroups(orgId).find((x) => x.name === a.approverGroup || x.id === a.approverGroup);
      if (!g || g.members.length > 0) continue;
      const backup = pols.find((p) => p.groupId === g.id)?.backupGroupId ?? 'owners';
      try {
        await api.reroute(orgId, a.id, backup, userId);
        rerouted++;
      } catch { /* blocked or expired: nothing to re-route */ }
    }
    const at = d.members.findIndex((x) => x.userId === memberId);
    if (at >= 0) d.members.splice(at, 1);
    // removed: they hold no role here any more, even where the directory still lists the organisation
    d.removedMembers = Array.from(new Set([...(d.removedMembers ?? []), memberId]));
    s.sessions.filter((x) => x.userId === memberId && !x.endedAt).forEach((x) => { x.endedAt = iso(Date.now()); x.endReason = 'Removed from the organisation'; });
    const r = record(orgId, userId, 'member.removed', { member: name, role: m.role, groups_left: groups.map((g) => g.name).join(', ') || 'none', approvals_rerouted: rerouted });
    commit(orgId, 'member');
    return { seq: r.seq, groups: groups.map((g) => g.name), rerouted };
  },

  /** Suspend: sessions end and sign-in is refused; the account, its role and its history stay. */
  async setSuspended(orgId: string, memberId: string, suspended: boolean, userId: string, reason: string) {
    await wait(200, 400);
    requireRole(orgId, userId, ['owner', 'admin'], 'Suspending members');
    const d = db.getDB(orgId);
    const m = d.members.find((x) => x.userId === memberId);
    if (!m || m.status === 'invited') throw new Error('Only an active member can be suspended.');
    if (memberId === userId) throw new Error('You cannot suspend yourself.');
    if (m.role === 'owner' && db.memberRole(orgId, userId) !== 'owner') throw new Error('Only an owner can suspend or reinstate an owner.');
    if (suspended && m.role === 'owner' && d.members.filter((x) => x.role === 'owner' && x.status === 'active').length <= 1) throw new Error('The last active owner cannot be suspended.');
    if (suspended && reason.trim().length < 4) throw new Error('Say why — the reason is recorded on the receipt.');
    m.status = suspended ? 'suspended' : 'active';
    let ended = 0;
    if (suspended) orgState(orgId).sessions.filter((x) => x.userId === memberId && !x.endedAt).forEach((x) => { x.endedAt = iso(Date.now()); x.endReason = 'Suspended'; ended++; });
    const r = record(orgId, userId, suspended ? 'member.suspended' : 'member.reinstated', { member: userById(memberId)?.name ?? memberId, ...(suspended ? { reason: reason.trim(), sessions_ended: ended } : {}) });
    commit(orgId, 'member');
    return { seq: r.seq, ended };
  },

  /* ══ Approver groups ══════════════════════════════════════════════════ */

  groups(orgId: string) {
    return effectiveGroups(orgId);
  },

  async addGroupMember(orgId: string, groupId: string, memberId: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Editing approver groups');
    const d = db.getDB(orgId);
    const m = d.members.find((x) => x.userId === memberId);
    if (!m || m.status !== 'active') throw new Error('Only active members can join an approver group.');
    if (m.role === 'viewer' || m.role === 'auditor') throw new Error(`${userById(memberId)?.name ?? 'This person'} is a ${m.role}. Viewers and auditors cannot approve; change their role first.`);
    const g = effectiveGroups(orgId).find((x) => x.id === groupId);
    if (!g) throw new Error('No such group.');
    if (g.members.includes(memberId)) throw new Error('Already a member.');
    const e = (orgState(orgId).groupEdits[groupId] ??= { add: [], remove: [] });
    e.remove = e.remove.filter((x) => x !== memberId);
    if (!baseApproverGroupsFor(orgId).find((x) => x.id === groupId)?.members.includes(memberId)) e.add.push(memberId);
    const r = record(orgId, userId, 'approver_group.member_added', { group: g.name, member: userById(memberId)?.name ?? memberId });
    commit(orgId, 'approval');
    return { seq: r.seq };
  },

  async removeGroupMember(orgId: string, groupId: string, memberId: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Editing approver groups');
    const g = effectiveGroups(orgId).find((x) => x.id === groupId);
    if (!g) throw new Error('No such group.');
    if (!g.members.includes(memberId)) throw new Error('Not a member.');
    if (g.members.length <= 1) throw new Error(`${g.name} would have nobody to decide its held actions. Add someone else first.`);
    const e = (orgState(orgId).groupEdits[groupId] ??= { add: [], remove: [] });
    e.add = e.add.filter((x) => x !== memberId);
    if (baseApproverGroupsFor(orgId).find((x) => x.id === groupId)?.members.includes(memberId)) e.remove.push(memberId);
    const r = record(orgId, userId, 'approver_group.member_removed', { group: g.name, member: userById(memberId)?.name ?? memberId });
    commit(orgId, 'approval');
    return { seq: r.seq };
  },

  /* ══ Webhooks and the outbox ══════════════════════════════════════════ */

  /** Endpoints with deliveries, after bringing the outbox up to the chain head. */
  async webhooks(orgId: string) {
    await wait(80, 180);
    syncOutbox(orgId);
    const s = orgState(orgId);
    return clone({ endpoints: db.getDB(orgId).webhooks as (Omit<Webhook, 'events'> & { events: ExtEvent[] })[], deadLetter: s.deadLetter, rolls: s.secretRolls });
  },

  async addWebhook(orgId: string, url: string, events: ExtEvent[], userId: string) {
    await wait(200, 400);
    requireRole(orgId, userId, ['owner', 'admin'], 'Adding an endpoint');
    const u = url.trim();
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(u)) throw new Error('Enter an https:// URL. Plain http is not accepted.');
    const d = db.getDB(orgId);
    if (d.webhooks.some((w) => w.url === u)) throw new Error('That URL already has an endpoint.');
    if (!events.length) throw new Error('Choose at least one event.');
    syncOutbox(orgId);
    const secret = `whsec_${hex(16)}`;
    const w = { id: `wh_${hex(4)}`, url: u, events, status: 'active', secretPrefix: secret.slice(0, 10), createdAt: iso(Date.now()), deliveries: [] } as unknown as Webhook;
    d.webhooks.push(w);
    const r = record(orgId, userId, 'webhook.added', { url: u, events: events.join(', ') });
    commit(orgId, 'webhook');
    return { webhook: clone(w), secret, seq: r.seq };
  },

  /** Enable, disable — enabling a failing endpoint marks it as fixed so the next delivery is tried again. */
  async setWebhookStatus(orgId: string, id: string, status: 'active' | 'disabled', userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Changing an endpoint');
    const w = db.getDB(orgId).webhooks.find((x) => x.id === id);
    if (!w) throw new Error('That endpoint no longer exists.');
    w.status = status;
    const r = record(orgId, userId, status === 'disabled' ? 'webhook.disabled' : 'webhook.enabled', { url: w.url });
    commit(orgId, 'webhook');
    return { seq: r.seq };
  },

  async deleteWebhook(orgId: string, id: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner', 'admin'], 'Deleting an endpoint');
    const d = db.getDB(orgId);
    const i = d.webhooks.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('That endpoint no longer exists.');
    const [w] = d.webhooks.splice(i, 1);
    const r = record(orgId, userId, 'webhook.deleted', { url: w.url });
    commit(orgId, 'webhook');
    return { seq: r.seq };
  },

  /** A test event ("test": true, not a receipt). Failing endpoints answer 503; active ones 200. */
  async sendTestEvent(orgId: string, id: string, userId: string) {
    await wait(250, 500);
    requireRole(orgId, userId, ['owner', 'admin'], 'Sending a test event');
    const w = db.getDB(orgId).webhooks.find((x) => x.id === id);
    if (!w) throw new Error('That endpoint no longer exists.');
    if (w.status === 'disabled') throw new Error('Enable the endpoint first.');
    const del = deliver(orgId, w, (w.events[0] ?? 'receipt.created') as ExtEvent, 1, undefined, true);
    commit(orgId, 'webhook');
    return clone(del);
  },

  /** Resend one delivery: same event id, so the endpoint can de-duplicate. */
  async resendDelivery(orgId: string, id: string, deliveryId: string, userId: string) {
    await wait(250, 500);
    requireRole(orgId, userId, ['owner', 'admin'], 'Resending a delivery');
    const w = db.getDB(orgId).webhooks.find((x) => x.id === id);
    if (!w) throw new Error('That endpoint no longer exists.');
    if (w.status === 'disabled') throw new Error('Enable the endpoint first.');
    const old = w.deliveries.find((x) => x.id === deliveryId);
    if (!old) throw new Error('That delivery is no longer in the log.');
    const del = deliver(orgId, w, old.event as ExtEvent, Math.min(8, old.attempts + 1));
    commit(orgId, 'webhook');
    return clone(del);
  },

  /** Replay every dead letter for an endpoint (or all) that is now active. */
  async replayDeadLetters(orgId: string, userId: string, webhookId?: string) {
    await wait(400, 800);
    requireRole(orgId, userId, ['owner', 'admin'], 'Replaying deliveries');
    const s = orgState(orgId);
    const d = db.getDB(orgId);
    let ok = 0;
    let failed = 0;
    for (const l of s.deadLetter.filter((x) => !x.replayedAt || (x.replayStatus ?? 0) >= 300)) {
      if (webhookId && l.webhookId !== webhookId) continue;
      const w = d.webhooks.find((x) => x.id === l.webhookId);
      if (!w || w.status === 'disabled') continue;
      const res = deliver(orgId, w, l.event, 1, l.seq, false, true);
      l.replayedAt = res.ts;
      l.replayStatus = res.status;
      if (res.status < 300) ok++; else failed++;
    }
    const r = record(orgId, userId, 'webhook.dead_letter_replayed', { delivered: ok, failed });
    commit(orgId, 'webhook');
    return { ok, failed, seq: r.seq };
  },

  /** Roll the signing secret. The new one is shown once; the previous one stays valid for 24 hours. */
  async rollSecret(orgId: string, id: string, userId: string) {
    await wait(250, 450);
    requireRole(orgId, userId, ['owner', 'admin'], 'Rolling a secret');
    const w = db.getDB(orgId).webhooks.find((x) => x.id === id);
    if (!w) throw new Error('That endpoint no longer exists.');
    const secret = `whsec_${hex(16)}`;
    const prev = w.secretPrefix;
    w.secretPrefix = secret.slice(0, 10);
    const until = iso(Date.now() + 24 * H);
    const r = record(orgId, userId, 'webhook.secret_rolled', { url: w.url, previous_valid_until: until });
    orgState(orgId).secretRolls.unshift({ webhookId: id, newPrefix: w.secretPrefix, previousPrefix: prev, previousValidUntil: until, at: iso(Date.now()), by: userId, seq: r.seq });
    commit(orgId, 'webhook');
    return { secret, previousValidUntil: until, seq: r.seq };
  },

  /* ══ Closing the organisation ═════════════════════════════════════════ */

  async closure(orgId: string) {
    await wait(40, 100);
    return clone(orgState(orgId).closure);
  },

  /**
   * Schedule the organisation's closure (owner, typed name). Agents stop at once through the emergency
   * stop; access ends after 7 days; receipts are kept until the retention end and stay verifiable from the
   * final evidence export. Cancellable until the effective date.
   */
  async scheduleClosure(orgId: string, input: { typedName: string; exportId?: string; reason: string }, userId: string) {
    await wait(400, 700);
    requireRole(orgId, userId, ['owner'], 'Closing the organisation');
    const d = db.getDB(orgId);
    const s = orgState(orgId);
    if (s.closure && !s.closure.cancelledAt) throw new Error('A closure is already scheduled.');
    if (input.typedName.trim() !== d.org.name) throw new Error(`Type the organisation’s name exactly: ${d.org.name}`);
    if (!input.exportId) throw new Error('Export the final evidence first.');
    if (!d.stop.active) await api.engageStop(orgId, userId, `Organisation closing: ${input.reason || 'closure scheduled by an owner'}`);
    const now = Date.now();
    const effectiveAt = iso(now + 7 * D);
    // the same floor dataPolicy shows: never shorter than the write-once (compliance) lock
    const dep = await api.deployment(orgId);
    const kept = Math.max(MIN_RETENTION_YEARS, Number(s.retention?.years) || MIN_RETENTION_YEARS);
    const years = dep.storage.objectLock === 'compliance' ? Math.max(kept, dep.storage.retentionYears) : kept;
    const retentionUntil = iso(now + years * 365 * D);
    const r = record(orgId, userId, 'org.closure_scheduled', { effective_at: effectiveAt, retention_until: retentionUntil, final_export: input.exportId, reason: input.reason || '' });
    s.closure = { scheduledAt: iso(now), scheduledBy: userId, effectiveAt, retentionUntil, exportId: input.exportId, seq: r.seq };
    commit(orgId, 'org');
    return { closure: clone(s.closure), seq: r.seq };
  },

  async cancelClosure(orgId: string, userId: string) {
    await wait();
    requireRole(orgId, userId, ['owner'], 'Cancelling the closure');
    const c = orgState(orgId).closure;
    if (!c || c.cancelledAt) throw new Error('No closure is scheduled.');
    c.cancelledAt = iso(Date.now());
    c.cancelledBy = userId;
    const r = record(orgId, userId, 'org.closure_cancelled', { was_effective_at: c.effectiveAt });
    commit(orgId, 'org');
    return { seq: r.seq };
  },
};

/* ── Helpers ───────────────────────────────────────────────────────────── */

export const PROVIDER_LABEL: Record<OidcProvider, string> = { okta: 'Okta', entra: 'Microsoft Entra ID', google: 'Google Workspace', keycloak: 'Keycloak' };

/** The host the organisation's console answers on: its own domain on Sovereign, elan1's hosted domain otherwise. */
export function consoleHost(orgId: string) {
  const d = db.getDB(orgId);
  return d.org.deployment === 'sovereign' ? `https://govern.${mailDomain(d)}` : 'https://govern.elan1.ai';
}
export function redirectUri(orgId: string) {
  return `${consoleHost(orgId)}/auth/oidc/${db.getDB(orgId).org.slug}/callback`;
}
export function issuerPlaceholder(orgId: string, provider: OidcProvider) {
  const d = db.getDB(orgId);
  const short = d.org.slug.replace(/-/g, '');
  return provider === 'okta' ? `https://${short}.okta.com/oauth2/default`
    : provider === 'entra' ? 'https://login.microsoftonline.com/<tenant-id>/v2.0'
      : provider === 'google' ? 'https://accounts.google.com'
        : `https://sso.${mailDomain(d)}/realms/${short}`;
}

/** Cloud identity providers: always outside the network, so never reachable from a Sovereign deployment. */
const CLOUD_IDP_HOST: Partial<Record<OidcProvider, string>> = { okta: 'okta.com', entra: 'login.microsoftonline.com', google: 'accounts.google.com' };

/**
 * Sovereign deployments run under deny-all egress: single sign-on works only with an identity provider inside
 * the network — Keycloak, or an issuer on .internal, .local, .lan, a private (RFC 1918) address or the
 * organisation's own domain. Returns why a provider and issuer cannot be used there (undefined when they can,
 * and always undefined for hosted organisations).
 */
export function ssoIssuerProblem(orgId: string, provider: OidcProvider, issuer: string): string | undefined {
  if (!isSovereign(orgId)) return undefined;
  const name = db.getDB(orgId).org.name;
  if (CLOUD_IDP_HOST[provider]) return `${PROVIDER_LABEL[provider]} is a cloud service outside ${name}’s network. A Sovereign deployment sends nothing to the internet, so sign-in uses Keycloak or another identity provider inside the network.`;
  if (issuer && !isInternalName(orgId, issuer)) return `The issuer is outside ${name}’s network. A Sovereign deployment can reach only an issuer on .internal, .local, .lan, a private address or ${mailDomain(db.getDB(orgId))}.`;
  return undefined;
}

/** Refuse a provider or issuer outside a Sovereign network, recorded as egress.blocked (mock/sovereign guardDestination). */
function guardSovereignIssuer(orgId: string, provider: OidcProvider, issuer: string, userId: string) {
  const why = ssoIssuerProblem(orgId, provider, issuer);
  if (!why) return;
  const outside = issuer && !isInternalName(orgId, issuer) ? issuer : `https://${CLOUD_IDP_HOST[provider] ?? 'identity-provider'}`;
  try {
    guardDestination(orgId, outside, `Single sign-on (${PROVIDER_LABEL[provider]})`, userId);
  } catch (e) {
    throw new Error(`${why} ${(e as Error).message}`);
  }
  // an outside host is never on the internal allow-list; refuse anyway rather than reach it
  throw new Error(why);
}

/** The DNS this console can see: the organisation's own mail domain carries its verification record. */
function dnsTxt(orgId: string, name: string): string[] {
  const d = db.getDB(orgId);
  if (name === mailDomain(d)) return [`elan1-govern-verify=${domainToken(orgId, name)}`, 'v=spf1 include:_spf.google.com ~all'];
  return ['v=spf1 -all'].filter(() => name.endsWith('.eu') || name.endsWith('.co.uk'));
}

/** Approver groups with the saved edits applied — the same groups the mock enforces when someone decides. */
export function effectiveGroups(orgId: string) {
  const d = db.getDB(orgId);
  settingsOf(d);
  return effectiveGroupsOf(d);
}

export function lifetimeMs(l: Lifetime) {
  return l === '8h' ? 8 * H : l === '24h' ? 24 * H : l === '7d' ? 7 * D : 12 * H;
}

export function describeAgent(ua: string) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
  return { label: `${browser} on ${os}`, phone: /iPhone|Android/.test(ua) };
}

/* ── Webhook delivery (deterministic) ─────────────────────────────────── */

type Delivery = Webhook['deliveries'][number];

function deliver(orgId: string, w: Webhook, event: ExtEvent, attempts: number, seq?: number, test = false, replay = false): Delivery {
  const failing = w.status === 'failing';
  const h = parseInt(sha256Hex(`${w.id}:${event}:${seq ?? 'test'}:${attempts}`).slice(0, 6), 16);
  // a failing endpoint keeps failing; the outbox retries with backoff up to 8 attempts, then dead-letters
  const finalAttempts = failing && !test ? 8 : attempts;
  const del: Delivery = { id: `del_${hex(4)}`, event: event as WebhookEvent, ts: iso(Date.now()), status: failing ? 503 : 200, attempts: finalAttempts, ms: failing ? 10_000 : 60 + (h % 240) };
  w.deliveries.unshift(del);
  w.deliveries = w.deliveries.slice(0, 200);
  if (failing && !test && !replay) {
    const s = orgState(orgId);
    s.deadLetter.unshift({ id: `dl_${hex(4)}`, webhookId: w.id, url: w.url, event, ts: del.ts, attempts: 8, lastStatus: 503, seq });
    s.deadLetter = s.deadLetter.filter((l) => Date.now() - new Date(l.ts).getTime() < 30 * D).slice(0, 300);
  }
  return del;
}

/** Queue deliveries for every receipt appended since the last sync, for each subscribed endpoint. */
function syncOutbox(orgId: string) {
  const s = orgState(orgId);
  const d = db.getDB(orgId);
  const head = d.receipts[d.receipts.length - 1]?.seq ?? 0;
  if (s.outboxWatermark === undefined) { s.outboxWatermark = head; return; }
  if (head <= s.outboxWatermark) return;
  const fresh = d.receipts.filter((r) => r.seq > s.outboxWatermark!).slice(-200);
  const lastCp = d.checkpoints[d.checkpoints.length - 1];
  for (const w of d.webhooks) {
    if (w.status === 'disabled') continue;
    const subs = new Set(w.events as ExtEvent[]);
    // Sovereign: deny-all egress — an endpoint outside the allow-list gets nothing; the attempt is in the egress log
    if (dispatchBlocked(orgId, w, fresh.reduce((k, r) => k + eventsOf(r).filter((e) => subs.has(e)).length, 0))) continue;
    for (const r of fresh) for (const e of eventsOf(r)) if (subs.has(e)) deliver(orgId, w, e, 1, r.seq);
    if (subs.has('chain.integrity') && lastCp && lastCp.seq > s.outboxWatermark) deliver(orgId, w, 'chain.integrity', 1, lastCp.seq);
  }
  s.outboxWatermark = head;
}

/* ── TOTP (RFC 6238) ───────────────────────────────────────────────────── */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes: Uint8Array) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string) {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) { const i = B32.indexOf(c); if (i < 0) continue; value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
function totp(secret: string, step: number) {
  const msg = new Uint8Array(8);
  let x = step;
  for (let i = 7; i >= 0; i--) { msg[i] = x & 255; x = Math.floor(x / 256); }
  const mac = hmac(sha1, unbase32(secret), msg);
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
function verifyTotp(secret: string, code: string) {
  const step = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => totp(secret, step + d) === code);
}
