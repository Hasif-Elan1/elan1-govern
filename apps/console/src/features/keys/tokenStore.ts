/**
 * Platform tokens — the two token classes besides agent keys.
 *
 * The memorandum names three token classes and no fourth:
 *  · the tenant token: one tenant, one actor, one autonomy level; the only class that reaches the write
 *    endpoints. Here that is the agent key (gk_ production, sk_sbx_ sandbox), on each agent's Keys tab;
 *  · the control token: calls the control plane (define: register a write type at a declaration version). It
 *    cannot reach a record store or a write endpoint;
 *  · the read-only operations token: verify and scope, for monitoring and operations. It sees no tenant data
 *    and changes nothing.
 * The documents give no prefixes for the last two; this console uses gctl_ (control) and gops_ (read-only
 * operations) so a leaked token says what it is.
 *
 * Owners and admins issue, list and revoke them; the secret is shown once and only a hash and the prefix are
 * kept. From L2 a control token is dual control: one owner or admin asks, a different one approves, then it is
 * collected once (a control token registers declarations, which are themselves dual-control writes). Every step
 * is a receipt. A Sovereign deployment issues and checks them inside its own network under the same rules.
 *
 * State is kept on the organisation's record as `platformTokens` (optional; an older saved state reads as none).
 * A real backend replaces these bodies without touching the screen.
 */
import { db } from '@/api';
import type { OrgDB } from '@/mock/db';
import { sha256Hex } from '@/lib/crypto';
import { atLeast, levelOfOrg } from '@/lib/levels';
import { assertPilotWritable } from '@/mock/billing';

export type TokenClass = 'control' | 'operations';

export const TOKEN_CLASSES: Record<TokenClass, { prefix: string; label: string; can: string; cannot: string }> = {
  control: {
    prefix: 'gctl_',
    label: 'Control token',
    can: 'Calls the control plane: registers a write type at a declaration version (define), each registration a governed write under dual control.',
    cannot: 'Cannot reach a record store or any write endpoint.',
  },
  operations: {
    prefix: 'gops_',
    label: 'Read-only operations token',
    can: 'Verifies records and resolves scope (verify, scope) for monitoring and operations.',
    cannot: 'Sees no tenant data and changes nothing.',
  },
};

export type TokenStatus = 'requested' | 'approved' | 'active' | 'revoked' | 'declined' | 'withdrawn';

export interface PlatformToken {
  id: string;
  cls: TokenClass;
  label: string;
  status: TokenStatus;
  requestedBy: string;
  requestedAt: string;
  expiresAt?: string;
  /** dual control (control token from L2): the second owner or admin */
  approvedBy?: string;
  approvedAt?: string;
  /** set when the secret is generated (issued or collected); the full secret is never kept */
  prefix?: string;
  hash?: string;
  issuedBy?: string;
  issuedAt?: string;
  revokedBy?: string;
  revokedAt?: string;
  reason?: string;
  seqs: { requested?: number; approved?: number; issued?: number; revoked?: number; closed?: number };
}

type TokenDB = OrgDB & { platformTokens?: PlatformToken[] };

const D = 864e5;
const iso = (t = Date.now()) => new Date(t).toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wait = (min = 200, max = 420) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');

function tokensOf(orgId: string): PlatformToken[] {
  const d = db.getDB(orgId) as TokenDB;
  d.platformTokens ??= [];
  for (const t of d.platformTokens) t.seqs ??= {};
  return d.platformTokens;
}

function requireOwnerOrAdmin(orgId: string, userId: string, what: string) {
  const role = db.memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what} — owners and admins can do this; your role cannot.`);
  assertPilotWritable(orgId, userId, 'write');
}

/** Whether issuing this class needs a second owner or admin here (the control token, from L2). */
export function needsSecondPerson(orgId: string, cls: TokenClass) {
  return cls === 'control' && atLeast(levelOfOrg(db.getDB(orgId).org), 'l2');
}

function mint(orgId: string, t: PlatformToken, userId: string) {
  const secret = `${TOKEN_CLASSES[t.cls].prefix}${randHex(20)}`;
  t.prefix = secret.slice(0, 13);
  t.hash = sha256Hex(secret);
  t.status = 'active';
  t.issuedBy = userId;
  const r = db.logAdmin(orgId, userId, 'token.issued', {
    token: t.prefix, class: t.cls, label: t.label, expires: t.expiresAt ? t.expiresAt.slice(0, 10) : 'never',
    ...(t.approvedBy ? { approved_by: t.approvedBy, requested_by: t.requestedBy } : {}),
  });
  t.issuedAt = r.ts;
  t.seqs.issued = r.seq;
  return { secret, receipt: r };
}

/** Every platform token, newest first. Expired tokens read as revoked by expiry only in the screen. */
export async function listTokens(orgId: string) {
  await wait(60, 140);
  return clone(tokensOf(orgId).slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
}

/**
 * Issue a token. An operations token (and a control token at L1) is issued now and its secret returned once.
 * A control token from L2 is recorded as requested and waits for a different owner or admin to approve.
 */
export async function issueToken(orgId: string, input: { cls: TokenClass; label: string; expiresDays?: number }, userId: string) {
  await wait();
  requireOwnerOrAdmin(orgId, userId, `Issuing a ${TOKEN_CLASSES[input.cls].label.toLowerCase()}`);
  const label = input.label.trim();
  if (label.length < 3) throw new Error('Give the token a label of at least 3 characters: where it is used.');
  const now = Date.now();
  const t: PlatformToken = {
    id: `tok_${now.toString(36)}${randHex(2)}`, cls: input.cls, label, status: 'requested', requestedBy: userId, requestedAt: iso(now),
    ...(input.expiresDays ? { expiresAt: iso(now + input.expiresDays * D) } : {}), seqs: {},
  };
  const list = tokensOf(orgId);
  if (needsSecondPerson(orgId, input.cls)) {
    const r = db.logAdmin(orgId, userId, 'token.requested', { request: t.id, class: t.cls, label, dual_control: 'enforced' });
    t.seqs.requested = r.seq;
    list.unshift(t);
    db.touch(orgId, 'token');
    return { token: clone(t), receipt: r, secret: undefined as string | undefined };
  }
  const { secret, receipt } = mint(orgId, t, userId);
  list.unshift(t);
  db.touch(orgId, 'token');
  return { token: clone(t), receipt, secret: secret as string | undefined };
}

/** Dual control: a different owner or admin approves (or declines) a control-token request. */
export async function decideToken(orgId: string, id: string, approve: boolean, userId: string, note = '') {
  await wait();
  requireOwnerOrAdmin(orgId, userId, 'Approving a control token');
  const t = tokensOf(orgId).find((x) => x.id === id);
  if (!t || t.status !== 'requested') throw new Error('This request is not waiting for a second person.');
  if (t.requestedBy === userId) throw new Error('You asked for this token. A different owner or admin approves it.');
  if (!approve && note.trim().length < 6) throw new Error('Say why the request is declined. The requester reads it.');
  const r = db.logAdmin(orgId, userId, approve ? 'token.approved' : 'token.declined', { request: t.id, class: t.cls, label: t.label, requested_by: t.requestedBy, ...(note.trim() ? { note: note.trim() } : {}) });
  t.status = approve ? 'approved' : 'declined';
  if (approve) { t.approvedBy = userId; t.approvedAt = r.ts; t.seqs.approved = r.seq; } else { t.reason = note.trim(); t.seqs.closed = r.seq; }
  db.touch(orgId, 'token');
  return { token: clone(t), receipt: r };
}

/** Collect an approved control token: the secret is generated now and shown once. */
export async function collectToken(orgId: string, id: string, userId: string) {
  await wait();
  requireOwnerOrAdmin(orgId, userId, 'Collecting a control token');
  const t = tokensOf(orgId).find((x) => x.id === id);
  if (!t || t.status !== 'approved') throw new Error('Only an approved request has a token to collect.');
  const { secret, receipt } = mint(orgId, t, userId);
  db.touch(orgId, 'token');
  return { token: clone(t), receipt, secret };
}

/** Withdraw your own request while it is still waiting for a second person. Only the person who asked can withdraw it. */
export async function withdrawToken(orgId: string, id: string, userId: string) {
  await wait();
  requireOwnerOrAdmin(orgId, userId, 'Withdrawing a token request');
  const t = tokensOf(orgId).find((x) => x.id === id);
  if (!t) throw new Error('There is no such token request.');
  if (t.requestedBy !== userId) throw new Error('Only the person who asked for this token can withdraw the request.');
  if (t.status !== 'requested') throw new Error(t.status === 'approved' ? 'This request has already been approved, so it can no longer be withdrawn. Collect the token and revoke it if it is not needed.' : 'This request is no longer waiting, so it cannot be withdrawn.');
  const r = db.logAdmin(orgId, userId, 'token.request_withdrawn', { request: t.id, class: t.cls, label: t.label });
  t.status = 'withdrawn';
  t.seqs.closed = r.seq;
  db.touch(orgId, 'token');
  return { token: clone(t), receipt: r };
}

/** Revoke an active token: refused from the next call. One owner or admin, at once. */
export async function revokeToken(orgId: string, id: string, userId: string, reason: string) {
  await wait();
  requireOwnerOrAdmin(orgId, userId, 'Revoking a token');
  const t = tokensOf(orgId).find((x) => x.id === id);
  if (!t || t.status !== 'active') throw new Error('That token is not active.');
  const r = db.logAdmin(orgId, userId, 'token.revoked', { token: t.prefix ?? '', class: t.cls, label: t.label, ...(reason.trim() ? { reason: reason.trim() } : {}) });
  t.status = 'revoked';
  t.revokedBy = userId;
  t.revokedAt = r.ts;
  t.reason = reason.trim() || undefined;
  t.seqs.revoked = r.seq;
  db.touch(orgId, 'token');
  return { token: clone(t), receipt: r };
}

export const tokenExpired = (t: Pick<PlatformToken, 'expiresAt' | 'status'>, now = Date.now()) => t.status === 'active' && !!t.expiresAt && new Date(t.expiresAt).getTime() <= now;
