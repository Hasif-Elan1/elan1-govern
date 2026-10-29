/**
 * Accounts, sign-in rules and the demo outbox for the public pages (sign-in, sign-up, recovery, invitations,
 * single sign-on and the counterparty, regulator and partner portals).
 *
 * The shared mock API carries only `api.signIn`. Everything else a real identity service would hold lives
 * here, persisted in this browser and hydrated into the shared directory (USERS, DEMO_ACCOUNTS, ORGS) when
 * the app starts, so `api.signIn` and every screen see the same people:
 *   - extra demo accounts per level (second admin, second and third approvers, the DPO),
 *   - portal accounts (counterparty verifier, regulator, partner) that open their portal, not the console,
 *   - organisations and owners created by sign-up, people who accepted an invitation or arrived by SSO,
 *   - the failed-attempt counter and lock per email (survives a reload),
 *   - per-person TOTP secrets (RFC 6238) — the demo publishes each account's current code,
 *   - single-use password-reset tokens with an expiry, and a demo outbox showing what would be sent.
 * Every change that a real backend would record writes a receipt on the organisation's chain.
 *
 * Live builds (src/api/mode.ts) sign in against the real backend instead: nothing here is read from or written to
 * this browser's storage, no demo account or portal password is published, and the session watcher does not run
 * (the server's session is the truth; its end reaches the console as a 401).
 */
import type { LevelId, Org, Role, User } from '@/types';
import { api, db } from '@/api';
import { DEMO_ACCOUNTS, ORGS, USERS, userById, type DemoAccount } from '@/mock/users';
import { sessionHomeOrg, sessionRecordIn, useSession } from '@/store/session';
import { sha256Hex } from '@/lib/crypto';
import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/legacy';
import { orgApi, orgState, PROVIDER_LABEL } from '@/features/settings/orgApi';
import { markBrowserSession } from './keepSignedIn';
import { chooseOrg, ssoOnlyIn, type BreakGlassInfo, type Refusal } from './signInPolicy';
import { LIVE } from '@/api/mode';

const KEY = 'eg:auth:v1';
const MIN = 60_000;
const D = 864e5;
const iso = (t: number) => new Date(t).toISOString();
const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
const wait = (min = 200, max = 450) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

/* ── Types ─────────────────────────────────────────────────────────────── */

export type PortalKind = 'counterparty' | 'regulator' | 'partner';

export interface PortalAccount {
  id: string;
  name: string;
  email: string;
  password: string;
  kind: PortalKind;
  title: string;
  /** The organisation the person works for (outside Elan1 Govern). */
  employer: string;
  /** The organisation that shared records with them, and the counterparty record it holds for them. */
  issuerOrgId: string;
  counterpartyId: string;
  journey: string;
}

export interface CreatedAccount extends DemoAccount { created: 'signup' | 'invitation' | 'sso' }

export interface ResetToken { token: string; userId: string; email: string; createdAt: string; expiresAt: string; usedAt?: string; replacedBy?: string }

export interface OutboxMail {
  id: string;
  channel: 'email' | 'whatsapp' | 'slack';
  to: string;
  subject: string;
  body: string;
  link?: string;
  at: string;
  orgId?: string;
  /** A held call's chat message (F2). Optional: older saved outboxes lack it. Buttons decide for the person it was sent to. */
  chat?: { approvalId: string; token: string; buttons: boolean };
}

interface LockRow { failures: number; lockedUntil?: number; lastAt: number }

export interface SsoState {
  state: string;
  nonce: string;
  orgId: string;
  email: string;
  protocol: 'saml' | 'oidc';
  idp: string;
  host: string;
  entityId: string;
  acsUrl: string;
  createdAt: number;
  usedAt?: number;
  assertion?: { id: string; name: string; group: string; issuedAt: number };
}

interface Store {
  v: 1;
  accounts: CreatedAccount[];
  users: User[];
  orgs: (Org & { createdBy?: string; legalEntity?: string })[];
  passwords: Record<string, string>;
  resets: ResetToken[];
  outbox: OutboxMail[];
  lock: Record<string, LockRow>;
  totpUsed: Record<string, number>;
  onboarding: Record<string, unknown>;
  /** Invitations for organisations created in this browser (seeded organisations keep theirs with orgApi). */
  invites: LocalInvite[];
  /** WhatsApp codes for people in organisations created in this browser. */
  waCodes: Record<string, { number: string; codeHash: string; sentAt: number; attempts: number }>;
  /** Portal sign-ins (counterparty, regulator, partner) in this browser. Optional: older saved registries lack it. */
  portalSessions?: PortalSession[];
}

export interface PortalSession { id: string; accountId: string; kind: PortalKind; startedAt: string; endedAt?: string; endReason?: string; seq?: number }

export interface LocalInvite { token: string; userId: string; orgId: string; email: string; role: Role; invitedBy: string; invitedAt: string; expiresAt: string; usedAt?: string; revokedAt?: string; replacedBy?: string; seq?: number }

const EMPTY: Store = { v: 1, accounts: [], users: [], orgs: [], passwords: {}, resets: [], outbox: [], lock: {}, totpUsed: {}, onboarding: {}, invites: [], waCodes: {}, portalSessions: [] };

function load(): Store {
  if (LIVE) return JSON.parse(JSON.stringify(EMPTY));
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Store;
      if (s.v === 1) return { ...EMPTY, ...s };
    }
  } catch { /* storage unavailable: work in memory */ }
  return JSON.parse(JSON.stringify(EMPTY));
}

const store = load();

function save() {
  if (!LIVE) try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* storage full or unavailable */ }
  listeners.forEach((l) => l());
}

const listeners = new Set<() => void>();
/** Re-render on registry changes (outbox, accounts). */
export function subscribeRegistry(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/* ── Demo accounts beyond the foundation's list (second people for dual control) ── */

const EXTRA: { userId: string; password: string; role: Role; level: LevelId; orgId: string; journey: string }[] = LIVE ? [] : [
  { userId: 'u_fatima', password: 'Demo-DPO-2026', role: 'admin', level: 'l1', orgId: 'org_demo', journey: 'Second admin and Data Protection Officer: the second person on a rulebook review and on erasure approvals.' },
  { userId: 'u_tom', password: 'Demo-Approver2-2026', role: 'approver', level: 'l1', orgId: 'org_demo', journey: 'Second Finance approver: the backup that escalated approvals re-route to.' },
  { userId: 'u_arjun', password: 'Demo-Approver3-2026', role: 'approver', level: 'l1', orgId: 'org_demo', journey: 'Procurement approver: try a held call outside your group and see it refused.' },
  { userId: 'u_nb_neha', password: 'Demo-Admin-L2-2026', role: 'admin', level: 'l2', orgId: 'org_northbank', journey: 'Draft a rulebook change and request a review — at L2 it cannot be published without a second person.' },
  { userId: 'u_nb_gaurav', password: 'Demo-Approver-L2-2026', role: 'approver', level: 'l2', orgId: 'org_northbank', journey: 'Decide held payments; your decisions are sealed and timestamped by two authorities.' },
  { userId: 'u_nb_imran', password: 'Demo-Approver2-L2-2026', role: 'approver', level: 'l2', orgId: 'org_northbank', journey: 'Procurement approver, with Gaurav Sethi. Purchases nobody decides within 4 hours escalate to Finance, Procurement’s backup group; try a held Finance payment and see it refused.' },
  { userId: 'u_nb_shalini', password: 'Demo-DPO-L2-2026', role: 'admin', level: 'l2', orgId: 'org_northbank', journey: 'Data Protection Officer: open a DPDP erasure and approve one opened by someone else.' },
  { userId: 'u_nb_pooja', password: 'Demo-Viewer-L2-2026', role: 'viewer', level: 'l2', orgId: 'org_northbank', journey: 'Watch at L2: read signed, timestamped receipts, coverage and alerts. Changes nothing.' },
  { userId: 'u_nb_deepak', password: 'Demo-Suspended-L2-2026', role: 'viewer', level: 'l2', orgId: 'org_northbank', journey: 'Suspended in Northbank: the password is right but sign-in is refused, and the refusal is a receipt. An owner or admin can reinstate him under People and roles.' },
  { userId: 'u_kh_arvind', password: 'Demo-Admin-L3-2026', role: 'admin', level: 'l3', orgId: 'org_kaveri', journey: 'Review rulebooks, propose an agent’s graduation to A3 for a second person to approve (or approve one someone else proposed), and add a counterparty.' },
  { userId: 'u_kh_revathi', password: 'Demo-Approver-L3-2026', role: 'approver', level: 'l3', orgId: 'org_kaveri', journey: 'Decide held calls, and review the 1 in 10 calls sampled after they run while a graduated agent is in its 30-day supervised period (Agents › Autonomy).' },
  { userId: 'u_kh_rafi', password: 'Demo-Approver2-L3-2026', role: 'approver', level: 'l3', orgId: 'org_kaveri', journey: 'Procurement approver, with Revathi Natarajan; purchases nobody decides within 4 hours escalate to Finance. Also the second person on a graduation proposal: two different people must agree.' },
  { userId: 'u_kh_sneha', password: 'Demo-DPO-L3-2026', role: 'admin', level: 'l3', orgId: 'org_kaveri', journey: 'Data Protection Officer: erasure by salt destruction with a 72-hour clock.' },
  { userId: 'u_kh_nandini', password: 'Demo-Viewer-L3-2026', role: 'viewer', level: 'l3', orgId: 'org_kaveri', journey: 'Watch at L3: read receipts, counterparty exchanges and autonomy levels. Changes nothing.' },
  { userId: 'u_dc_prakash', password: 'Demo-Approver-SOV-2026', role: 'approver', level: 'sovereign', orgId: 'org_deccan', journey: 'Decide held calls on the bank’s own cluster; receipts are signed in the bank’s HSM.' },
  { userId: 'u_dc_farhan', password: 'Demo-Approver2-SOV-2026', role: 'approver', level: 'sovereign', orgId: 'org_deccan', journey: 'Procurement approver, with Prakash Deshpande; vendor payments nobody decides within 4 hours escalate to Finance. Also the second person on a graduation proposal.' },
  { userId: 'u_dc_meenakshi', password: 'Demo-DPO-SOV-2026', role: 'admin', level: 'sovereign', orgId: 'org_deccan', journey: 'Data Protection Officer: erasures, residency proof and the egress log.' },
  { userId: 'u_dc_sunita', password: 'Demo-Viewer-SOV-2026', role: 'viewer', level: 'sovereign', orgId: 'org_deccan', journey: 'Watch on the bank’s own cluster: read receipts signed in its HSM, the egress log and coverage. Changes nothing.' },
];

/** Counterparty, regulator and partner accounts. They sign in to a portal, never to the console. */
export const PORTAL_ACCOUNTS: PortalAccount[] = LIVE ? [] : [
  { id: 'p_star', name: 'Nisha Menon', email: 'nisha.menon@starhealth.in', password: 'Demo-Counterparty-2026', kind: 'counterparty', title: 'Claims audit lead', employer: 'Star Health and Allied Insurance', issuerOrgId: 'org_kaveri', counterpartyId: 'cp_star', journey: 'Verify a claim decision Kaveri Health shared: 3 of 11 fields revealed, the rest committed and checkable.' },
  { id: 'p_rbi', name: 'R. Venkataraman', email: 'r.venkataraman@rbi.org.in', password: 'Demo-Regulator-2026', kind: 'regulator', title: 'Department of Supervision, off-site surveillance', employer: 'Reserve Bank of India', issuerOrgId: 'org_deccan', counterpartyId: 'cp_rbi', journey: 'Regulator portal: check an approved action Deccan Cooperative Bank disclosed, with the named approver on record.' },
  { id: 'p_northbank', name: 'Vikram Desai', email: 'vikram.desai@partners.northbank.co.in', password: 'Demo-Partner-2026', kind: 'partner', title: 'Accounts receivable, Northbank (supplier to Kaveri)', employer: 'Northbank Industrial Ltd', issuerOrgId: 'org_kaveri', counterpartyId: 'cp_northbank', journey: 'Partner portal: confirm the payment Kaveri recorded against your bill, without seeing anything else.' },
];

export const PORTAL_INFO: Record<PortalKind, { label: string; summary: string }> = {
  counterparty: { label: 'Counterparty verifier', summary: 'Checks receipts another organisation issued to them. Sees only the fields shared; holds a verification seat (₹45,000 a year, paid by the issuer).' },
  regulator: { label: 'Regulator', summary: 'Read-only portal for a supervisor: verifies disclosed receipts and their approvers offline. Cannot open the console.' },
  partner: { label: 'Partner', summary: 'A business partner who confirms the records shared with them. Sees only the disclosed fields; holds a verification seat.' },
};

/** The published passwords, before any reset in this browser. */
export const PUBLISHED_PASSWORDS: Record<string, string> = {};

/* ── Hydration: put stored people and organisations into the shared directory ── */

function hydrate() {
  for (const e of EXTRA) {
    const u = userById(e.userId);
    if (!u || DEMO_ACCOUNTS.some((a) => a.userId === e.userId)) continue;
    DEMO_ACCOUNTS.push({ userId: e.userId, email: u.email, password: e.password, role: e.role, level: e.level, orgId: e.orgId, journey: e.journey });
  }
  for (const o of store.orgs) if (!ORGS.some((x) => x.id === o.id)) ORGS.push({ ...o });
  for (const u of store.users) {
    const i = USERS.findIndex((x) => x.id === u.id);
    if (i < 0) USERS.push(u); else USERS[i] = { ...USERS[i], ...u };
  }
  for (const a of store.accounts) if (!DEMO_ACCOUNTS.some((x) => x.userId === a.userId)) DEMO_ACCOUNTS.push(a);
  for (const a of DEMO_ACCOUNTS) if (!(a.userId in PUBLISHED_PASSWORDS)) PUBLISHED_PASSWORDS[a.userId] = a.password;
  for (const p of PORTAL_ACCOUNTS) if (!(p.id in PUBLISHED_PASSWORDS)) PUBLISHED_PASSWORDS[p.id] = p.password;
  for (const [userId, pw] of Object.entries(store.passwords)) {
    const a = DEMO_ACCOUNTS.find((x) => x.userId === userId);
    if (a) a.password = pw;
    const p = PORTAL_ACCOUNTS.find((x) => x.id === userId);
    if (p) p.password = pw;
  }
}
if (!LIVE) hydrate();

/** Accounts made in this browser (sign-up, invitation, SSO). */
export function createdAccounts() { return store.accounts.slice(); }
export function isCreatedAccount(userId: string) { return store.accounts.some((a) => a.userId === userId); }
/** Organisations created by sign-up in this browser. */
export function createdOrg(orgId: string) { return store.orgs.find((o) => o.id === orgId); }
export function changedPasswords() { return Object.keys(store.passwords).filter((id) => PUBLISHED_PASSWORDS[id] && !isCreatedAccount(id)); }

/** Put the published demo passwords back (passwords reset in this browser are undone). */
export function restorePublishedPasswords() {
  for (const id of changedPasswords()) {
    const a = DEMO_ACCOUNTS.find((x) => x.userId === id);
    if (a) a.password = PUBLISHED_PASSWORDS[id];
    const p = PORTAL_ACCOUNTS.find((x) => x.id === id);
    if (p) p.password = PUBLISHED_PASSWORDS[id];
    delete store.passwords[id];
  }
  save();
}

/**
 * "Reset demo data" for sign-in: every lock and used two-step code is cleared, the published demo passwords
 * (console and portal) come back, pending reset links for them stop working and portal sessions end.
 * Accounts and organisations created in this browser keep their own passwords.
 */
export function resetSignInState() {
  store.lock = {};
  store.totpUsed = {};
  for (const id of changedPasswords()) {
    const a = DEMO_ACCOUNTS.find((x) => x.userId === id);
    if (a) a.password = PUBLISHED_PASSWORDS[id];
    const p = PORTAL_ACCOUNTS.find((x) => x.id === id);
    if (p) p.password = PUBLISHED_PASSWORDS[id];
    delete store.passwords[id];
  }
  store.resets = store.resets.filter((r) => isCreatedAccount(r.userId));
  store.portalSessions = [];
  try { localStorage.removeItem(PORTAL_CURRENT); } catch { /* fine */ }
  save();
}
if (typeof window !== 'undefined' && !LIVE) db.onResetDemo(resetSignInState);

/* ── Lockout: 5 failures lock the email for 1 minute, doubling, at most 1 hour ── */

export const MAX_FAILURES = 5;

const norm = (email: string) => email.trim().toLowerCase();

export function lockState(email: string, now = Date.now()) {
  const row = store.lock[norm(email)];
  const lockedUntil = row?.lockedUntil && row.lockedUntil > now ? row.lockedUntil : undefined;
  return { failures: row?.failures ?? 0, lockedUntil, left: Math.max(0, MAX_FAILURES - (row?.failures ?? 0)) };
}

export function recordFailure(email: string): { failures: number; lockedUntil?: number; lockMinutes?: number } {
  const k = norm(email);
  const row = store.lock[k] ?? { failures: 0, lastAt: 0 };
  // a quiet hour clears the count
  if (Date.now() - row.lastAt > 60 * MIN && !row.lockedUntil) row.failures = 0;
  row.failures++;
  row.lastAt = Date.now();
  let lockMinutes: number | undefined;
  if (row.failures >= MAX_FAILURES) {
    const waitMs = Math.min(60 * MIN, MIN * 2 ** Math.min(6, row.failures - MAX_FAILURES));
    row.lockedUntil = Date.now() + waitMs;
    lockMinutes = Math.round(waitMs / MIN);
  }
  store.lock[k] = row;
  save();
  return { failures: row.failures, lockedUntil: row.lockedUntil, lockMinutes };
}

export function clearFailures(email: string) {
  if (!store.lock[norm(email)]) return;
  delete store.lock[norm(email)];
  save();
}

/** The sign-in lock on a member's email: failed attempts counted and, when locked, until when. */
export function signInLock(userId: string, now = Date.now()) {
  const u = userById(userId);
  return u ? lockState(u.email, now) : { failures: 0, lockedUntil: undefined, left: MAX_FAILURES };
}

/**
 * An owner or admin clears a member's sign-in lock and failed-attempt count (People and roles, Sessions).
 * Recorded as auth.sign_in_unlocked on the organisation's chain, naming who unlocked whom.
 */
export function unlockSignIn(orgId: string, memberId: string, byUserId: string) {
  const role = db.memberRole(orgId, byUserId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins unlock sign-in.');
  const u = userById(memberId);
  if (!u) throw new Error('That person is not in the directory.');
  const row = store.lock[norm(u.email)];
  if (!row) throw new Error(`${u.name} has no failed sign-in attempts to clear.`);
  const wasLocked = !!row.lockedUntil && row.lockedUntil > Date.now();
  delete store.lock[norm(u.email)];
  save();
  const r = db.logAdmin(orgId, byUserId, 'auth.sign_in_unlocked', { member: u.name, failures: row.failures, was_locked: wasLocked });
  db.touch(orgId, 'member');
  return { seq: r.seq, wasLocked };
}

export class LockedError extends Error {
  constructor(public until: number) { super(`Too many attempts for this email. Sign-in is locked until ${new Date(until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST.`); }
}

/* ── TOTP (RFC 6238, SHA-1, 6 digits, 30-second steps) ──────────────────── */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes: Uint8Array) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string) {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) { const i = B32.indexOf(c); if (i < 0) continue; value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
export function totpAt(secret: string, step: number) {
  const msg = new Uint8Array(8);
  let x = step;
  for (let i = 7; i >= 0; i--) { msg[i] = x & 255; x = Math.floor(x / 256); }
  const h = hmac(sha1, unbase32(secret), msg);
  const o = h[h.length - 1] & 15;
  const code = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}
export const totpStep = (t = Date.now()) => Math.floor(t / 30_000);

/** The demonstration secret for a person who has not enrolled their own authenticator. Published on purpose. */
export function demoTotpSecret(userId: string) {
  const h = sha256Hex(`elan1-govern-demo-totp:${userId}`).slice(0, 40);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return base32(bytes);
}

/** The secret a person's codes are checked against: their own enrolment if they made one, else the demo secret. */
export function totpSecretFor(userId: string, orgId: string): { secret: string; enrolled: boolean } {
  try {
    const e = createdOrg(orgId) ? undefined : orgState(orgId).mfa[userId];
    if (e?.secret) return { secret: e.secret, enrolled: true };
  } catch { /* organisation not available */ }
  return { secret: demoTotpSecret(userId), enrolled: false };
}

/** Check a code with ±1 step of clock drift; a code is accepted once only. */
export function checkTotp(userId: string, orgId: string, code: string): boolean {
  const { secret } = totpSecretFor(userId, orgId);
  const now = totpStep();
  for (const s of [now, now - 1, now + 1]) {
    if (totpAt(secret, s) === code) {
      if ((store.totpUsed[userId] ?? -1) >= s) return false; // replay
      store.totpUsed[userId] = s;
      save();
      return true;
    }
  }
  return false;
}

/* ── Sessions ──────────────────────────────────────────────────────────── */

export function mfaRequired(user: User, orgId: string) {
  if (createdOrg(orgId)) return user.mfa;
  try { return user.mfa || !!orgState(orgId).mfa[user.id] || orgState(orgId).sessionPolicy.require2step; } catch { return user.mfa; }
}

/**
 * Start a console session for a person in an organisation: stores it like the session store does,
 * registers it in the organisation's session list and writes auth.signed_in.
 */
export function startSession(user: User, orgId: string, method: string, details: Record<string, string | number | boolean> = {}) {
  const fresh = userById(user.id) ?? user;
  const signedInAt = Date.now();
  // sessionOrgId keeps the organisation holding the session record (and auth.signed_in) through any switch
  const next = { user: { ...fresh }, orgId, signedInAt, sessionOrgId: orgId, reauthAt: undefined };
  useSession.setState(next);
  try { localStorage.setItem('eg:session', JSON.stringify(next)); } catch { /* fine */ }
  // 'Keep me signed in' off: the session lasts as long as this browser session (see keepSignedIn.ts)
  markBrowserSession();
  // an organisation created in this browser has its own (fresh) database and chain in the mock, so the sign-in is
  // recorded there — never on another organisation's chain
  try {
    orgApi.registerSession(orgId, fresh.id, signedInAt, navigator.userAgent, method.includes('2-step'));
    const ses = orgState(orgId).sessions.find((x) => x.id === `ses_${fresh.id}_${signedInAt}`);
    if (ses) ses.method = method;
    db.logAdmin(orgId, fresh.id, 'auth.signed_in', { method, ...details });
  } catch { /* the receipt is best effort when the organisation cannot be opened */ }
  return next;
}

/** Ends every open console session for a person (all organisations already open in this browser). */
function endSessionsFor(userId: string, reason: string, keep?: string) {
  let ended = 0;
  for (const orgId of db.orgIds()) {
    const d = db.peekDB(orgId) as (ReturnType<typeof db.getDB> & { orgSettings?: unknown }) | undefined;
    if (!d?.orgSettings) continue;
    orgState(orgId).sessions.filter((x) => x.userId === userId && !x.endedAt && x.id !== keep).forEach((x) => { x.endedAt = iso(Date.now()); x.endReason = reason; ended++; });
    db.touch(orgId, 'session');
  }
  return ended;
}

/** Reasons that close one organisation to a person without ending their sign-in: suspension and removal are per organisation. */
const MEMBERSHIP_END = new Set(['Suspended', 'Removed from the organisation']);

/**
 * Sign this browser out when its session was ended elsewhere (another session, Sessions, a reset, the lifetime).
 * The record that counts is the one in the organisation the browser signed in to, wherever the person is working
 * now; a record ended in the organisation open now counts too. A suspension or removal in the sign-in organisation
 * closes only that organisation: a person still active where they are working keeps their sign-in, and the record
 * moves to that organisation (registered there, so its Sessions list shows it and sign-out ends it).
 */
export function checkSessionEnded(): { ended: boolean; reason?: string; moved?: string } {
  const s = useSession.getState();
  if (!s.user || !s.signedInAt) return { ended: false };
  const userId = s.user.id;
  const home = sessionHomeOrg(s);
  const homeRec = sessionRecordIn(home, userId, s.signedInAt);
  const hereRec = home === s.orgId ? undefined : sessionRecordIn(s.orgId, userId, s.signedInAt);
  const endedHere = hereRec?.endedAt && !MEMBERSHIP_END.has(hereRec.endReason ?? '') ? hereRec : undefined;
  const endedHome = homeRec?.endedAt ? homeRec : undefined;
  if (!endedHere && !endedHome) return { ended: false };
  if (!endedHere && endedHome && MEMBERSHIP_END.has(endedHome.endReason ?? '')) {
    // still in the sign-in organisation: the membership check (session store) moves the person or signs them out
    if (home === s.orgId || !db.memberRole(s.orgId, userId)) return { ended: false };
    try {
      if (!createdOrg(s.orgId)) orgApi.registerSession(s.orgId, userId, s.signedInAt, navigator.userAgent, mfaRequired(s.user, s.orgId));
      db.touch(s.orgId, 'session');
    } catch { /* the record is best effort */ }
    useSession.setState({ sessionOrgId: s.orgId });
    try { localStorage.setItem('eg:session', JSON.stringify({ user: s.user, orgId: s.orgId, signedInAt: s.signedInAt, sessionOrgId: s.orgId, reauthAt: s.reauthAt })); } catch { /* fine */ }
    return { ended: false, moved: s.orgId };
  }
  const rec = endedHere ?? endedHome!;
  s.signOut({ reason: rec.endReason ?? 'Session ended elsewhere' });
  return { ended: true, reason: rec.endReason ?? 'Your session was ended.' };
}

function watchSession() {
  window.setInterval(() => {
    const r = checkSessionEnded();
    if (r.ended) {
      try { sessionStorage.setItem('eg:auth:ended', r.reason ?? 'Your session was ended.'); } catch { /* fine */ }
      window.location.assign('/login');
    }
  }, 10_000);
}
if (typeof window !== 'undefined' && !LIVE) watchSession();

/** Why the last session ended, once (shown on the sign-in page). */
export function takeEndedReason() {
  try { const r = sessionStorage.getItem('eg:auth:ended'); sessionStorage.removeItem('eg:auth:ended'); return r ?? undefined; } catch { return undefined; }
}

/* ── Password sign-in ──────────────────────────────────────────────────── */

export type SignInResult =
  | { kind: 'console'; user: User; orgId: string; mfa: boolean; breakGlass?: boolean; bg?: BreakGlassInfo }
  /** The password matched (or, for SSO-only, was never checked) but the organisation's policy refuses it. */
  | { kind: 'refused'; user?: User; orgId: string; refusal: Refusal; checked: boolean }
  | { kind: 'portal'; account: PortalAccount };

/**
 * Check the email and password against the lock, then the organisation's sign-in policy (signInPolicy.ts):
 * SSO-only domains, suspension per organisation, SAML required with the break-glass owner, two-step sign-in.
 * Starts no session on its own. `preferOrgId` is the organisation to open first when the person has several
 * (an approval link's organisation).
 */
export async function checkPassword(email: string, password: string, opts: { preferOrgId?: string } = {}): Promise<SignInResult> {
  const k = norm(email);
  const lock = lockState(k);
  if (lock.lockedUntil) throw new LockedError(lock.lockedUntil);
  const portal = PORTAL_ACCOUNTS.find((p) => p.email === k);
  if (portal) {
    await wait(300, 600);
    if (portal.password !== password) { failed(k); }
    clearFailures(k);
    return { kind: 'portal', account: portal };
  }
  const acct = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === k);
  // an SSO-only domain: the password is never tried
  const sso = acct ? ssoOnlyIn(acct.orgId, k) : undefined;
  if (acct && sso && !sso.ok) return { kind: 'refused', orgId: acct.orgId, refusal: sso, checked: false };
  await wait(300, 600);
  const user = acct && acct.password === password ? userById(acct.userId) : undefined;
  if (!user) failed(k);
  clearFailures(k);
  const { orgId, policy } = chooseOrg(user, k, [opts.preferOrgId, acct!.orgId]);
  if (!policy.ok) return { kind: 'refused', user, orgId, refusal: policy, checked: true };
  return { kind: 'console', user: { ...user }, orgId, mfa: policy.mfa, breakGlass: policy.breakGlass, bg: policy.bg };
}

function failed(email: string, base = 'That email and password do not match an account.'): never {
  const r = recordFailure(email);
  if (r.lockMinutes) throw new LockedError(r.lockedUntil!);
  const left = MAX_FAILURES - r.failures;
  throw new Error(`${base} ${left} attempt${left === 1 ? '' : 's'} left before a ${r.failures + 1 >= MAX_FAILURES ? '1-minute ' : ''}lock.`);
}

/** Second step: a TOTP code. Wrong codes count towards the same lock as wrong passwords. */
export async function checkSecondStep(email: string, user: User, orgId: string, code: string) {
  await wait(200, 400);
  const lock = lockState(email);
  if (lock.lockedUntil) throw new LockedError(lock.lockedUntil);
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6 digits from your authenticator app.');
  if (!checkTotp(user.id, orgId, code)) failed(email, 'That code does not match, or it was already used.');
  clearFailures(email);
}

/* ── Organisations and single sign-on ─────────────────────────────────── */

/** The organisation an email belongs to: by its domain, or by a known person with that address. */
export function orgForEmail(email: string): Org | undefined {
  const k = norm(email);
  const dom = k.split('@')[1];
  if (!dom) return undefined;
  const byDomain = ORGS.find((o) => o.domain === dom);
  if (byDomain) return byDomain;
  const u = USERS.find((x) => x.email.toLowerCase().split('@')[1] === dom && x.role !== 'auditor');
  return u ? ORGS.find((o) => o.id === u.orgIds[0]) : undefined;
}

export interface SsoProvider { protocol: 'saml' | 'oidc'; label: string; host: string; entityId: string; acsUrl: string; jit: boolean; scim: boolean }

/** The identity providers an organisation has configured — the only ones the sign-in page offers. */
export async function ssoProviders(orgId: string): Promise<SsoProvider[]> {
  if (createdOrg(orgId)) return [];
  const idc = await api.identityConfig(orgId);
  const oidc = await orgApi.oidc(orgId);
  const out: SsoProvider[] = [];
  if (idc.saml.enabled) {
    const host = (() => { try { return new URL(idc.saml.metadataUrl).host; } catch { return 'idp'; } })();
    out.push({ protocol: 'saml', label: idc.saml.idp, host, entityId: idc.saml.entityId, acsUrl: idc.saml.acsUrl, jit: idc.saml.jitProvisioning || idc.scim.enabled, scim: idc.scim.enabled });
  }
  if (oidc.savedAt && oidc.domains.some((d) => d.verified)) {
    const host = (() => { try { return new URL(oidc.issuer).host; } catch { return 'issuer'; } })();
    out.push({ protocol: 'oidc', label: PROVIDER_LABEL[oidc.provider], host, entityId: oidc.clientId, acsUrl: `${location.origin}/login`, jit: oidc.jit, scim: false });
  }
  return out;
}

const SSO_KEY = 'eg:auth:sso';
function ssoStates(): Record<string, SsoState> { try { return JSON.parse(sessionStorage.getItem(SSO_KEY) ?? '{}'); } catch { return {}; } }
function saveSso(m: Record<string, SsoState>) { try { sessionStorage.setItem(SSO_KEY, JSON.stringify(m)); } catch { /* fine */ } }

/** Step 1: the AuthnRequest (SAML) or authorisation request (OIDC). Returns the state to carry to the IdP. */
export function beginSso(orgId: string, email: string, p: SsoProvider): SsoState {
  const st: SsoState = { state: `sso_${hex(10)}`, nonce: hex(8), orgId, email: norm(email), protocol: p.protocol, idp: p.label, host: p.host, entityId: p.entityId, acsUrl: p.acsUrl, createdAt: Date.now() };
  const all = ssoStates();
  all[st.state] = st;
  saveSso(all);
  return st;
}

export function ssoState(state: string): SsoState | undefined { return ssoStates()[state]; }

/** Step 2 (at the identity provider): the person authenticates there and the IdP signs an assertion. */
export function assertSso(state: string, input: { name: string; group: string }) {
  const all = ssoStates();
  const st = all[state];
  if (!st) throw new Error('This sign-in request is not known. Start again from the sign-in page.');
  st.assertion = { id: `_${hex(12)}`, name: input.name.trim(), group: input.group, issuedAt: Date.now() };
  saveSso(all);
  return st;
}

/** The group the identity provider asserts for a known person (from the SCIM group map), or a default. */
export async function groupForPerson(orgId: string, email: string) {
  const idc = await api.identityConfig(orgId);
  const u = USERS.find((x) => x.email.toLowerCase() === norm(email));
  const role = u ? (db.getDB(orgId).members.find((m) => m.userId === u.id)?.role ?? u.role) : undefined;
  return { known: u, groups: idc.scim.groupMap, asserted: role ? idc.scim.groupMap.find((g) => g.role === role)?.idpGroup : undefined };
}

/**
 * Step 3 (the ACS): check the response belongs to a request we sent, is fresh and unused, then sign in
 * the person — creating them just in time with the role their group maps to when the organisation allows it.
 */
export async function completeSso(state: string): Promise<{ user: User; orgId: string; created: boolean }> {
  await wait(400, 700);
  const all = ssoStates();
  const st = all[state];
  if (!st) throw new Error('The response does not match a sign-in this browser started (unknown RelayState). Start again.');
  if (st.usedAt) throw new Error('This response was already used. Each assertion signs in once.');
  if (!st.assertion) throw new Error('The identity provider did not return an assertion.');
  if (Date.now() - st.createdAt > 10 * MIN) throw new Error('The sign-in request expired after 10 minutes. Start again.');
  st.usedAt = Date.now();
  saveSso(all);
  const idc = await api.identityConfig(st.orgId);
  const d = db.getDB(st.orgId);
  let user = USERS.find((x) => x.email.toLowerCase() === st.email);
  let created = false;
  const roleFromGroup = idc.scim.groupMap.find((g) => g.idpGroup === st.assertion!.group)?.role;
  if (user && !user.orgIds.includes(st.orgId)) user = undefined;
  if (user) {
    const m = d.members.find((x) => x.userId === user!.id);
    if (m?.status === 'suspended') throw new Error('This account is suspended in its organisation.');
  } else {
    const providers = await ssoProviders(st.orgId);
    const p = providers.find((x) => x.protocol === st.protocol);
    if (!p?.jit) {
      db.logAdmin(st.orgId, 'system', 'auth.sso_refused', { email_domain: st.email.split('@')[1], reason: 'no_account_and_jit_off', idp: st.idp });
      throw new Error(`${st.email} has no account in ${d.org.name}, and just-in-time accounts are off for ${st.idp}. Ask an owner to invite you, or to turn on SCIM or just-in-time accounts in the Agents door, under Organisation.`);
    }
    if (!roleFromGroup) throw new Error(`The identity provider asserted the group “${st.assertion.group}”, which maps to no role in ${d.org.name}.`);
    const name = st.assertion.name || st.email.split('@')[0].split(/[._-]/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
    user = {
      id: `u_sso_${hex(5)}`, name, email: st.email, role: roleFromGroup, title: `${roleFromGroup[0].toUpperCase()}${roleFromGroup.slice(1)} · via ${st.idp}`,
      initials: name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(), orgIds: [st.orgId], mfa: false, lastSignIn: iso(Date.now()),
    };
    USERS.push(user);
    store.users.push(user);
    d.members.push({ userId: user.id, role: roleFromGroup, status: 'active', lastActiveAt: iso(Date.now()) });
    db.logAdmin(st.orgId, user.id, 'member.jit_provisioned', { email: st.email, role: roleFromGroup, idp: st.idp, protocol: st.protocol, group: st.assertion.group });
    db.touch(st.orgId, 'member');
    created = true;
    save();
  }
  startSession(user, st.orgId, `${st.protocol === 'saml' ? 'SAML' : 'OIDC'} · ${st.idp}`, { protocol: st.protocol, idp: st.idp, assertion: st.assertion.id });
  return { user, orgId: st.orgId, created };
}

/* ── Sign-up: a new organisation and its owner ────────────────────────── */

export interface SignUpInput { company: string; name: string; email: string; password: string; level: LevelId }

export async function signUp(input: SignUpInput) {
  await wait(500, 900);
  const email = norm(input.email);
  const dom = email.split('@')[1];
  if (DEMO_ACCOUNTS.some((a) => a.email.toLowerCase() === email) || USERS.some((u) => u.email.toLowerCase() === email) || PORTAL_ACCOUNTS.some((p) => p.email === email)) throw new Error('An account already uses this email. Sign in instead, or reset the password.');
  const owner = ORGS.find((o) => o.domain === dom);
  if (owner) throw new Error(`${owner.name} already uses ${dom}. Ask one of its owners to invite you from the Agents door, under People and roles.`);
  const slugBase = input.company.trim().toLowerCase().replace(/(private|pvt\.?|limited|ltd\.?)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'organisation';
  const now = Date.now();
  const orgId = `org_${slugBase.replace(/-/g, '_')}_${hex(2)}`;
  const sovereign = input.level === 'sovereign';
  const org: Org & { createdBy?: string } = {
    id: orgId, name: input.company.trim(), slug: `${slugBase}-${orgId.slice(-4)}`, industry: 'general', regions: ['India'], currency: 'INR', timezone: 'Asia/Kolkata',
    plan: input.level, createdAt: iso(now), keyFingerprint: '', levelHistory: [{ level: input.level, from: iso(now) }],
    deployment: sovereign ? 'sovereign' : 'hosted', residency: sovereign ? 'On premises · to be confirmed in set-up' : 'ap-south-1 Mumbai', domain: dom,
  };
  const userId = `u_${hex(5)}`;
  const user: User = {
    id: userId, name: input.name.trim(), email, role: 'owner', title: 'Owner', initials: input.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(),
    orgIds: [orgId], mfa: false, lastSignIn: iso(now),
  };
  org.createdBy = userId;
  const acct: CreatedAccount = { userId, email, password: input.password, role: 'owner', level: input.level, orgId, journey: `Owner of ${org.name}, created in this browser.`, created: 'signup' };
  // the directory gets its own copy: the organisation's chain starts at L1 and syncs the directory entry, while
  // this record keeps the level chosen at sign-up for set-up to raise it to
  ORGS.push({ ...org });
  USERS.push(user);
  DEMO_ACCOUNTS.push(acct);
  store.orgs.push(org);
  store.users.push(user);
  store.accounts.push(acct);
  PUBLISHED_PASSWORDS[userId] = input.password;
  save();
  startSession(user, orgId, 'Password (new organisation)', { signup: true, level: input.level });
  return { user, org };
}

/** Update an organisation created by sign-up (its record lives in this registry). */
export function updateCreatedOrg(orgId: string, patch: Partial<Org> & { legalEntity?: string }) {
  const o = store.orgs.find((x) => x.id === orgId);
  if (!o) return undefined;
  Object.assign(o, patch);
  const shared = ORGS.find((x) => x.id === orgId);
  if (shared) Object.assign(shared, patch);
  save();
  return o;
}

/* ── Password recovery ────────────────────────────────────────────────── */

export const RESET_MINUTES = 30;

/** Always answers the same way (no account enumeration). When an account exists, a single-use link goes to the outbox. */
export async function requestPasswordReset(email: string) {
  await wait(400, 700);
  const k = norm(email);
  const acct = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === k);
  const portal = PORTAL_ACCOUNTS.find((p) => p.email === k);
  if (!acct && portal) {
    // portal accounts (counterparty, regulator, partner) recover the same way; the request is recorded on
    // the chain of the organisation that shared records with them
    const now = Date.now();
    const t: ResetToken = { token: `rst_${hex(14)}`, userId: portal.id, email: k, createdAt: iso(now), expiresAt: iso(now + RESET_MINUTES * MIN) };
    store.resets.filter((r) => r.userId === portal.id && !r.usedAt && !r.replacedBy).forEach((r) => { r.replacedBy = t.token; });
    store.resets.push(t);
    pushMail({ channel: 'email', to: k, subject: `Reset your ${PORTAL_INFO[portal.kind].label.toLowerCase()} portal password`, body: `Someone asked to reset the portal password for ${k}. The link works once and expires in ${RESET_MINUTES} minutes. If it was not you, ignore this message — your password stays as it is.`, link: `/reset/${t.token}`, orgId: portal.issuerOrgId });
    try { db.logAdmin(portal.issuerOrgId, 'system', 'portal.password_reset_requested', { portal_user: portal.name, employer: portal.employer, portal: portal.kind, expires_minutes: RESET_MINUTES }); db.touch(portal.issuerOrgId, 'receipt'); } catch { /* fine */ }
    save();
    return { sent: true };
  }
  if (!acct) return { sent: true };
  const now = Date.now();
  const t: ResetToken = { token: `rst_${hex(14)}`, userId: acct.userId, email: k, createdAt: iso(now), expiresAt: iso(now + RESET_MINUTES * MIN) };
  store.resets.filter((r) => r.userId === acct.userId && !r.usedAt && !r.replacedBy).forEach((r) => { r.replacedBy = t.token; });
  store.resets.push(t);
  pushMail({ channel: 'email', to: k, subject: 'Reset your Elan1 Govern password', body: `Someone asked to reset the password for ${k}. The link works once and expires in ${RESET_MINUTES} minutes. If it was not you, ignore this message — your password stays as it is.`, link: `/reset/${t.token}`, orgId: acct.orgId });
  try { db.logAdmin(acct.orgId, acct.userId, 'member.password_reset_requested', { expires_minutes: RESET_MINUTES }); } catch { /* fine */ }
  save();
  return { sent: true };
}

export function resetInfo(token: string): { state: 'valid' | 'expired' | 'used' | 'replaced' | 'unknown'; reset?: ResetToken } {
  const r = store.resets.find((x) => x.token === token);
  if (!r) return { state: 'unknown' };
  if (r.usedAt) return { state: 'used', reset: r };
  if (r.replacedBy) return { state: 'replaced', reset: r };
  if (new Date(r.expiresAt).getTime() < Date.now()) return { state: 'expired', reset: r };
  return { state: 'valid', reset: r };
}

/** Consume the token, change the password, end every other session and record it. */
export async function resetPassword(token: string, password: string) {
  await wait(500, 800);
  const info = resetInfo(token);
  if (info.state !== 'valid' || !info.reset) throw new Error(info.state === 'unknown' ? 'This reset link is not valid.' : `This reset link was already ${info.state === 'expired' ? 'past its expiry' : info.state}.`);
  const portal = PORTAL_ACCOUNTS.find((p) => p.id === info.reset!.userId);
  if (portal) {
    if (password === portal.password) throw new Error('Choose a password you have not used for this account.');
    portal.password = password;
    store.passwords[portal.id] = password;
    info.reset.usedAt = iso(Date.now());
    let ended = 0;
    for (const s of store.portalSessions ?? []) if (s.accountId === portal.id && !s.endedAt) { s.endedAt = iso(Date.now()); s.endReason = 'Password reset'; ended++; }
    delete store.lock[norm(portal.email)];
    try { db.logAdmin(portal.issuerOrgId, 'system', 'portal.password_changed', { portal_user: portal.name, employer: portal.employer, portal: portal.kind, method: 'reset_link', sessions_ended: ended }); db.touch(portal.issuerOrgId, 'receipt'); } catch { /* fine */ }
    save();
    return { email: portal.email, ended };
  }
  const acct = DEMO_ACCOUNTS.find((a) => a.userId === info.reset!.userId);
  if (!acct) throw new Error('The account behind this link no longer exists.');
  if (password === acct.password) throw new Error('Choose a password you have not used for this account.');
  acct.password = password;
  store.passwords[acct.userId] = password;
  info.reset.usedAt = iso(Date.now());
  const ended = endSessionsFor(acct.userId, 'Password reset');
  delete store.lock[norm(acct.email)];
  try { db.logAdmin(acct.orgId, acct.userId, 'member.password_changed', { method: 'reset_link', other_sessions_ended: ended }); } catch { /* fine */ }
  const s = useSession.getState();
  if (s.user?.id === acct.userId) s.signOut();
  save();
  return { email: acct.email, ended };
}

/* ── Invitations (tokens live with the organisation, see orgApi) ──────── */

/** Invite someone to an organisation created in this browser: a single-use link, valid 7 days, sent to the demo outbox. */
export function inviteToCreatedOrg(orgId: string, email: string, role: Role, byUserId: string) {
  const o = createdOrg(orgId);
  if (!o) throw new Error('Not an organisation created in this browser.');
  const k = norm(email);
  if (store.invites.some((i) => i.orgId === orgId && i.email === k && !i.usedAt && !i.revokedAt)) throw new Error(`${k} is already invited.`);
  const now = Date.now();
  const inv: LocalInvite = { token: `inv_${hex(12)}`, userId: `u_inv_${hex(4)}`, orgId, email: k, role, invitedBy: byUserId, invitedAt: iso(now), expiresAt: iso(now + 7 * D) };
  store.invites.push(inv);
  pushMail({ channel: 'email', to: k, subject: `${userById(byUserId)?.name ?? 'An owner'} invited you to ${o.name} on Elan1 Govern`, body: `You are invited as ${role}. The link works once and expires in 7 days.`, link: `/invite/${inv.token}`, orgId });
  save();
  return inv;
}

export function createdOrgInvites(orgId: string) { return store.invites.filter((i) => i.orgId === orgId); }

/** WhatsApp verification for people in an organisation created in this browser (seeded organisations use orgApi). */
export function sendLocalWhatsAppCode(userId: string, number: string, orgId: string) {
  const num = number.trim();
  if (!/^\+[0-9][0-9 ]{9,15}$/.test(num)) throw new Error('Enter the number with country code, for example +91 98450 11203.');
  const code = String(parseInt(hex(4), 16) % 1_000_000).padStart(6, '0');
  store.waCodes[userId] = { number: num, codeHash: sha256Hex(`${userId}:${code}`), sentAt: Date.now(), attempts: 0 };
  pushMail({ channel: 'whatsapp', to: num, subject: 'Elan1 Govern verification code', body: `Your code is ${code}. It expires in 10 minutes. Do not share it.`, orgId });
  save();
  return { sentTo: num };
}

export function verifyLocalWhatsAppCode(userId: string, code: string) {
  const st = store.waCodes[userId];
  if (!st) throw new Error('Send a code first.');
  if (Date.now() - st.sentAt > 10 * MIN) { delete store.waCodes[userId]; save(); throw new Error('That code expired after 10 minutes. Send a new one.'); }
  if (st.attempts >= 5) { delete store.waCodes[userId]; save(); throw new Error('Too many wrong codes. Send a new one.'); }
  if (sha256Hex(`${userId}:${code}`) !== st.codeHash) { st.attempts++; save(); throw new Error(`That code is not right. ${5 - st.attempts} ${5 - st.attempts === 1 ? 'try' : 'tries'} left.`); }
  const number = st.number;
  delete store.waCodes[userId];
  const u = store.users.find((x) => x.id === userId);
  if (u) { u.phone = number; const shared = USERS.find((x) => x.id === userId); if (shared) shared.phone = number; }
  save();
  return { number };
}

/** Find an invitation by token, opening organisations one at a time until it is found. */
export async function findInvitation(token: string) {
  await wait(150, 300);
  const local = store.invites.find((i) => i.token === token);
  if (local) {
    const state = local.usedAt ? 'used' : local.revokedAt ? 'revoked' : local.replacedBy ? 'replaced' : new Date(local.expiresAt).getTime() < Date.now() ? 'expired' : 'valid';
    return { orgId: local.orgId, orgName: createdOrg(local.orgId)?.name ?? 'your organisation', invite: { ...local }, state } as ReturnType<typeof orgApi.inviteByToken>;
  }
  let found = orgApi.inviteByToken(token);
  if (found) return found;
  for (const orgId of db.orgIds()) {
    db.getDB(orgId);
    orgState(orgId);
    found = orgApi.inviteByToken(token);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 0));
  }
  return undefined;
}

/** Accept: the invited member becomes active with their role, gets a password, and is signed in as themselves. */
export async function acceptInvitation(token: string, name: string, password: string) {
  await wait(400, 700);
  const found = await findInvitation(token);
  if (!found) throw new Error('This invitation link is not valid.');
  if (found.state !== 'valid') throw new Error(`This invitation was ${found.state === 'replaced' ? 'replaced by a newer one' : found.state}.`);
  const { invite, orgId } = found;
  if (DEMO_ACCOUNTS.some((a) => a.email.toLowerCase() === invite.email.toLowerCase())) throw new Error('An account already uses this email. Sign in instead.');
  const local = store.invites.find((i) => i.token === token);
  if (local) local.usedAt = iso(Date.now());
  else orgApi.acceptInvite(token);
  const nm = name.trim();
  const user: User = {
    id: invite.userId, name: nm, email: invite.email, role: invite.role, title: `${invite.role[0].toUpperCase()}${invite.role.slice(1)}`,
    initials: nm.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(), orgIds: [orgId], mfa: false, lastSignIn: iso(Date.now()),
  };
  const i = USERS.findIndex((u) => u.id === user.id);
  if (i >= 0) USERS[i] = user; else USERS.push(user);
  store.users = store.users.filter((u) => u.id !== user.id).concat(user);
  const acct: CreatedAccount = { userId: user.id, email: invite.email, password, role: invite.role, level: api.levelOf(orgId), orgId, journey: `Joined ${found.orgName} from an invitation.`, created: 'invitation' };
  DEMO_ACCOUNTS.push(acct);
  store.accounts.push(acct);
  PUBLISHED_PASSWORDS[user.id] = password;
  save();
  db.touch(orgId, 'member');
  startSession(user, orgId, 'Password (invitation accepted)', { invitation: true });
  return { user, orgId, orgName: found.orgName };
}

/* ── Demo outbox ──────────────────────────────────────────────────────── */

export function pushMail(m: Omit<OutboxMail, 'id' | 'at'>) {
  const mail: OutboxMail = { ...m, id: `mail_${hex(6)}`, at: iso(Date.now()) };
  store.outbox.unshift(mail);
  store.outbox = store.outbox.slice(0, 80);
  save();
  return mail;
}

export function outbox(filter?: { to?: string; orgId?: string }) {
  return store.outbox.filter((m) => (!filter?.to || m.to.toLowerCase() === norm(filter.to)) && (!filter?.orgId || m.orgId === filter.orgId));
}

/* ── Onboarding progress, per organisation (for organisations held in this registry) ── */

export function registryOnboarding<T>(orgId: string): T | undefined { return store.onboarding[orgId] as T | undefined; }
export function saveRegistryOnboarding(orgId: string, value: unknown) { store.onboarding[orgId] = value; save(); }

/* ── Portals ──────────────────────────────────────────────────────────── */

/** The portal token for a portal account: the newest live disclosure its issuer shared with it. */
export async function portalTokenFor(p: PortalAccount): Promise<string | undefined> {
  const list = await api.disclosures(p.issuerOrgId);
  const live = list.filter((x) => x.counterpartyId === p.counterpartyId && x.status === 'active').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return live[0]?.token;
}

/* ── Portal sessions ──────────────────────────────────────────────────── */

/** The portal session this browser holds (its id); the record lives in the registry. */
const PORTAL_CURRENT = 'eg:portal:current';
/** Portal sessions last 12 hours. */
export const PORTAL_SESSION_HOURS = 12;

function portalAccount(id: string) { return PORTAL_ACCOUNTS.find((p) => p.id === id); }

/**
 * Start a portal session after a portal password matched: recorded in this browser's registry and as
 * portal.signed_in on the issuing organisation's chain. Any portal session this browser held is ended first.
 */
export function startPortalSession(p: PortalAccount): PortalSession {
  endPortalSession('Signed in as someone else');
  const now = Date.now();
  const s: PortalSession = { id: `pses_${hex(8)}`, accountId: p.id, kind: p.kind, startedAt: iso(now) };
  try {
    const r = db.logAdmin(p.issuerOrgId, 'system', 'portal.signed_in', { portal_user: p.name, employer: p.employer, portal: p.kind, session: s.id });
    s.seq = r.seq;
    db.touch(p.issuerOrgId, 'receipt');
  } catch { /* best effort when the issuer cannot be opened */ }
  store.portalSessions = [s, ...(store.portalSessions ?? [])].slice(0, 40);
  try { localStorage.setItem(PORTAL_CURRENT, s.id); } catch { /* fine */ }
  save();
  return s;
}

/** This browser's live portal session and its account, or undefined (none, ended, or past 12 hours). */
export function currentPortalSession(): { session: PortalSession; account: PortalAccount } | undefined {
  let id: string | null = null;
  try { id = localStorage.getItem(PORTAL_CURRENT); } catch { return undefined; }
  if (!id) return undefined;
  const session = (store.portalSessions ?? []).find((x) => x.id === id);
  const account = session ? portalAccount(session.accountId) : undefined;
  if (!session || !account || session.endedAt) return undefined;
  // past its lifetime: no longer live (read-only here, so it is safe to call while rendering)
  if (Date.now() - new Date(session.startedAt).getTime() > PORTAL_SESSION_HOURS * 3_600_000) return undefined;
  return { session, account };
}

/** End this browser's portal session; recorded as portal.signed_out on the issuer's chain. */
export function endPortalSession(reason = 'Signed out') {
  let id: string | null = null;
  try { id = localStorage.getItem(PORTAL_CURRENT); localStorage.removeItem(PORTAL_CURRENT); } catch { /* fine */ }
  const s = id ? (store.portalSessions ?? []).find((x) => x.id === id) : undefined;
  if (!s || s.endedAt) { if (id) save(); return; }
  const expiresAt = new Date(s.startedAt).getTime() + PORTAL_SESSION_HOURS * 3_600_000;
  s.endedAt = iso(Math.min(Date.now(), expiresAt));
  s.endReason = Date.now() > expiresAt ? `Expired after ${PORTAL_SESSION_HOURS} hours` : reason;
  const p = portalAccount(s.accountId);
  if (p) {
    try { db.logAdmin(p.issuerOrgId, 'system', 'portal.signed_out', { portal_user: p.name, employer: p.employer, portal: p.kind, session: s.id, reason: s.endReason ?? reason }); db.touch(p.issuerOrgId, 'receipt'); } catch { /* fine */ }
  }
  save();
}

/** Days until a timestamp, for copy. */
export const daysUntil = (isoDate: string) => Math.max(0, Math.ceil((new Date(isoDate).getTime() - Date.now()) / D));
