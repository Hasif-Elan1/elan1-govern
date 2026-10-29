/**
 * Writes screens used to make in place (a receipt logged from a dialog, a field set on the organisation's record),
 * as named operations (plans/console-app.md, 1.3 refined). Each takes the organisation and the person acting,
 * checks that person's role here (the server runs it as the signed-in user, so the check holds there too) and
 * writes its receipt. What a receipt says is worked out here from the organisation's own record wherever it can
 * be; the few values only the browser knows (a file's digest, a recipient's label) are checked for shape.
 *
 * They are async: the ones that write a receipt sign it with the organisation's key, which only the server holds.
 */
import type { IndustryPack, Receipt, Role } from '@/types';
import * as db from '@/mock/db';
import { continuityReport } from '@/mock/evidence';
import { requireMember, requirePermission, requireRole } from '@/mock/guard';
import { atLeast, levelOfOrg, levelRank } from '@/lib/levels';
import { can } from '@/lib/permissions';
import { canonical, sha256Hex, signText } from '@/lib/crypto';
import { DISCLOSABLE_FIELDS, commitFields, disclosureMessage, fieldValuesOf, type DisclosableField } from '@/lib/disclosure';
import type { DisclosurePackage } from '@/types';
import { orgState } from '@/features/settings/orgApi';
import { STARTER_RULES } from '@/features/onboarding/industries';
import { buildRedactedShare, type RedactedShare } from '@/features/activity/redaction';
import type { OnboardingState } from '@/features/onboarding/state';
import type { WorkingPapers } from '@/features/auditor/sampling';

const MANAGERS: Role[] = ['owner', 'admin'];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/* ── Checking what the browser sends ──────────────────────── */

function text(v: unknown, what: string, max = 200): string {
  if (typeof v !== 'string') throw new Error(`${what} is missing.`);
  const t = v.trim();
  if (t.length > max) throw new Error(`${what} is too long (at most ${max} characters).`);
  return t;
}

function count(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e9) throw new Error(`${what} is not a count.`);
  return v;
}

/** A plain JSON object no bigger than `maxBytes` (what a screen saves as-is: set-up progress, working papers). */
function plainObject<T>(v: unknown, what: string, maxBytes: number): T {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} is not a record.`);
  const json = JSON.stringify(v);
  if (json.length > maxBytes) throw new Error(`${what} is too large to save.`);
  return JSON.parse(json) as T;
}

function receiptAt(d: db.OrgDB, seq: unknown, what: string): Receipt {
  const r = typeof seq === 'number' ? d.receipts.find((x) => x.seq === seq) : undefined;
  if (!r) throw new Error(`${what} is not on this organisation's chain.`);
  return r;
}

function fieldsOf(v: unknown): DisclosableField[] {
  if (!Array.isArray(v) || !v.length) throw new Error('Choose at least one field to reveal.');
  const known = new Set<string>(DISCLOSABLE_FIELDS);
  const out = Array.from(new Set(v.map(String)));
  if (out.some((f) => !known.has(f))) throw new Error('One of the fields cannot be disclosed.');
  return out as DisclosableField[];
}

/* ── You: your own Slack link ─────────────────────────────── */

/** Link or unlink your own Slack account to the organisation's workspace (held actions reach you there). */
export async function setSlackLinked(orgId: string, link: boolean, userId: string) {
  requireMember(orgId, userId, link ? 'Linking Slack' : 'Unlinking Slack');
  const d = db.getDB(orgId);
  // Sovereign: deny-all egress, so Slack is never offered
  if (d.org.deployment === 'sovereign') throw new Error('Slack is outside your network: a Sovereign deployment does not reach it.');
  const slack = orgState(orgId).notify.slack;
  if (link && !slack.connected) throw new Error('Your organisation has not connected a Slack workspace yet. An owner or admin connects it under Organisation › Notifications.');
  const m = d.members.find((x) => x.userId === userId);
  if (!m) throw new Error('You are not a member of this organisation.');
  m.slackLinked = !!link;
  const r = db.logAdmin(orgId, userId, link ? 'channel.slack_linked' : 'channel.slack_unlinked', { workspace: slack.workspace ?? '' });
  db.touch(orgId, 'member');
  return { seq: r.seq, linked: m.slackLinked };
}

/* ── Invitations ──────────────────────────────────────────── */

const ROLES: readonly Role[] = ['owner', 'admin', 'approver', 'viewer', 'auditor'];
const DAY = 864e5;

/**
 * An invitation the server issued (apps/web/src/server/console-invites.ts): it emails the single-use link and
 * keeps only its SHA-256, and so does this record, listed under Pending invitations with member.invited. Owners
 * and admins; only an owner invites an owner. A newer invitation to the same address replaces the pending one,
 * whose link stops working.
 */
export async function recordInvitation(orgId: string, input: { email: string; role: Role; tokenHash: string; expiresAt: string }, userId: string) {
  requireRole(orgId, userId, MANAGERS, 'Inviting people');
  const role = input?.role;
  if (!ROLES.includes(role)) throw new Error('Choose a role for the invitation.');
  if (role === 'owner') requireRole(orgId, userId, ['owner'], 'Inviting an owner');
  const email = text(input.email, 'The email address', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('The email address is not valid.');
  if (typeof input.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.tokenHash)) throw new Error('The invitation link is missing.');
  const now = Date.now();
  const expires = Date.parse(text(input.expiresAt, 'The expiry', 40));
  if (!Number.isFinite(expires) || expires <= now || expires > now + 31 * DAY) throw new Error('The expiry is not valid.');
  const d = db.getDB(orgId);
  const s = orgState(orgId);
  if (s.invites.some((i) => i.tokenHash === input.tokenHash)) throw new Error('This invitation is already recorded.');
  const r = db.logAdmin(orgId, userId, 'member.invited', { email, role });
  // the pending invitation to the same address, if any, is replaced: its person record is reused
  const pending = s.invites.filter((i) => i.email === email && !i.usedAt && !i.revokedAt && !i.replacedBy);
  pending.forEach((i) => { i.replacedBy = `seq:${r.seq}`; });
  let m = d.members.find((x) => x.status === 'invited' && pending.some((i) => i.userId === x.userId));
  if (m) {
    m.role = role;
    m.invitedAt = new Date(now).toISOString();
  } else {
    m = { userId: `u_inv_${input.tokenHash.slice(0, 12)}`, role, status: 'invited', invitedAt: new Date(now).toISOString(), invitedEmail: email } as db.OrgDB['members'][number];
    d.members.push(m);
  }
  s.invites.push({ token: '', tokenHash: input.tokenHash, userId: m.userId, email, role, invitedBy: userId, invitedAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(), seq: r.seq });
  db.touch(orgId, 'member');
  return { seq: r.seq, memberId: m.userId };
}

/**
 * Join through an invitation: whoever holds its single-use link becomes an active member with the invited role
 * (taking the place of the pending entry), and member.joined is written naming them. The link is the proof: the
 * server checks it, and the address it was sent to, against its own invitation before running this. Once used, an
 * invitation stays with the person who used it: running this again as them changes nothing, anyone else is refused.
 * A member suspended here stays suspended; one already active keeps their role.
 */
export async function ensureInvitedMembership(orgId: string, token: string, userId: string) {
  if (db.isFresh(orgId)) return { changed: false }; // a sign-up organisation keeps its people in the registry
  const secret = text(token, 'The invitation link');
  const hash = sha256Hex(secret);
  const t = orgState(orgId).invites.find((i) => (i.tokenHash ? i.tokenHash === hash : !!i.token && i.token === secret));
  if (!t) throw new Error('This invitation is not on this organisation’s record.');
  if (t.usedAt) {
    // the demonstration's own acceptance (orgApi.acceptInvite) already made its person a member
    if ((t.acceptedBy ?? t.userId) === userId) return { changed: false };
    throw new Error('This invitation was already used.');
  }
  if (t.revokedAt) throw new Error('This invitation was withdrawn.');
  if (t.replacedBy) throw new Error('A newer invitation replaced this one.');
  if (Date.parse(t.expiresAt) < Date.now()) throw new Error('This invitation has expired.');
  const d = db.getDB(orgId);
  const mine = d.members.find((x) => x.userId === userId);
  if (mine?.status === 'suspended') throw new Error('Your access to this organisation is suspended. An owner or admin there can reinstate you.');
  const now = new Date().toISOString();
  if (t.userId !== userId) {
    const i = d.members.findIndex((x) => x.userId === t.userId && x.status === 'invited');
    if (i >= 0) d.members.splice(i, 1);
  }
  if (!mine) d.members.push({ userId, role: t.role, status: 'active', lastActiveAt: now });
  else if (mine.status !== 'active') Object.assign(mine, { role: t.role, status: 'active', lastActiveAt: now });
  Object.assign(t, { usedAt: now, acceptedBy: userId, userId });
  const r = db.logAdmin(orgId, userId, 'member.joined', { email: t.email, role: mine?.status === 'active' ? mine.role : t.role });
  db.touch(orgId, 'member');
  return { changed: true, seq: r.seq };
}

/* ── Sign-out ─────────────────────────────────────────────── */

/**
 * The person signed out on the server (DELETE /api/auth/session): their session record here (ses_<user>_<signed-in
 * time>, listed under Sessions) ends. The sign-out's receipt, auth.signed_out, is the server's own; `seq` names it.
 * Only your own record; one that already ended (lifetime, suspension, reset, another device) is left as it is.
 */
export async function endSignedOutSession(orgId: string, input: { session: string; reason?: string; seq?: number }, userId: string) {
  const id = text(input?.session, 'The session', 120);
  const s = orgState(orgId);
  const x = s.sessions.find((y) => y.id === id && y.userId === userId);
  if (!x || x.endedAt) return { ended: false };
  Object.assign(x, { endedAt: new Date().toISOString(), endedBy: userId, endReason: input.reason ? text(input.reason, 'The reason', 120) : 'Signed out' });
  if (input.seq !== undefined) x.seq = count(input.seq, 'The receipt');
  db.touch(orgId, 'session');
  return { ended: true };
}

/* ── Set-up (onboarding) ──────────────────────────────────── */

type WithOnboarding = db.OrgDB & { onboarding?: OnboardingState };

/** Save set-up progress with the organisation (owners and admins run set-up). The screen saves it 300 ms after each change. */
export async function saveOnboarding(orgId: string, state: OnboardingState, userId: string) {
  requireRole(orgId, userId, MANAGERS, 'Saving set-up', { anyTime: true });
  const s = plainObject<OnboardingState>(state, 'Set-up progress', 256 * 1024);
  if (s.v !== 2) throw new Error('This set-up progress was saved by an older console. Start set-up again.');
  const d = db.getDB(orgId) as WithOnboarding;
  d.onboarding = { ...s, updatedAt: new Date().toISOString(), updatedBy: userId };
  db.touch(orgId, 'onboarding');
  return { updatedAt: d.onboarding.updatedAt };
}

/** Record the legal entity invoices name (set-up's company step). */
export async function setLegalEntity(orgId: string, legal: string, userId: string) {
  requireRole(orgId, userId, MANAGERS, 'Recording the legal entity');
  const name = text(legal, 'The legal entity');
  if (!name) throw new Error('Nothing changed.');
  const org = db.getDB(orgId).org as db.OrgDB['org'] & { legalEntity?: string };
  if (org.legalEntity === name) return { changed: false };
  const from = org.legalEntity ?? '';
  org.legalEntity = name;
  const r = db.logAdmin(orgId, userId, 'org.legal_entity_recorded', { legal_entity: name, ...(from ? { from } : {}), source: 'onboarding' });
  db.touch(orgId, 'org');
  return { changed: true, seq: r.seq };
}

/** Set-up's starter rulebook for the industry, as an unpublished draft on a draft agent. Once: an existing one is left as it is. */
export async function draftStarterRulebook(orgId: string, industry: IndustryPack, userId: string) {
  requirePermission(orgId, userId, 'rulebooks.edit', 'Drafting the starter rulebook');
  const rules = STARTER_RULES[industry];
  if (!rules) throw new Error('There is no starter rulebook for this industry.');
  const slug = `starter-${industry}`;
  const d = db.getDB(orgId);
  if (d.rulebooks.some((r) => r.slug === slug)) return { created: false, slug };
  db.starterFromOnboarding(d, industry, userId);
  const r = db.logAdmin(orgId, userId, 'rulebook.drafted', { rulebook: slug, version: 1, rules: rules.length, source: 'onboarding' }, slug);
  db.touch(orgId, 'rulebook');
  return { created: true, slug, rules: rules.length, seq: r.seq };
}

/** The onboarding receipt: what set-up applied, worked out from the organisation as it is now and the choices made. */
export async function recordOnboardingCompleted(orgId: string, state: OnboardingState, invites: number, userId: string) {
  requireRole(orgId, userId, MANAGERS, 'Finishing set-up');
  const s = plainObject<OnboardingState>(state, 'Set-up', 256 * 1024);
  const d = db.getDB(orgId);
  const now = levelOfOrg(d.org);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => text(x, 'A choice', 80)).filter(Boolean) : []);
  const industry = STARTER_RULES[s.industry] ? s.industry : d.org.industry;
  const r = db.logAdmin(orgId, userId, 'onboarding.completed', {
    company: text(s.company?.name ?? '', 'The company name') || d.org.name, industry, regions: list(s.regions).join(', '), currency: text(s.currency ?? '', 'The currency', 8), timezone: text(s.timezone ?? '', 'The time zone', 64),
    level: now, residency: text(s.residency ?? '', 'The residency', 80), custody: levelRank(now) >= levelRank('l3') ? text(s.custody ?? '', 'The custody', 20) : levelRank(now) >= levelRank('l2') ? 'aws_kms' : 'elan1_held',
    tsa: levelRank(now) >= levelRank('l2') ? (now === 'sovereign' ? list(s.localTsas).join(' + ') : `eMudhra + ${text(s.globalTsa ?? '', 'The timestamp authority', 120)}`) : 'none (L1)',
    packs: list(s.packs).join(', ') || 'none', profiles: list(s.profiles).join(', ') || 'none', dual_control: levelRank(now) >= levelRank('l2') ? 'enforced' : 'recorded',
    saml: !!s.identity?.saml, scim: !!s.identity?.scim, invites: count(invites, 'The number of invitations'),
    // Sovereign: deny-all egress
    slack: now !== 'sovereign' && !!s.slack?.connected, whatsapp: now !== 'sovereign' && !!s.whatsapp?.verified,
    sovereign_checks: now === 'sovereign' ? Object.values(s.sovereign?.checks ?? {}).filter(Boolean).length : 0, starter_rulebook: `starter-${industry}`,
  });
  db.touch(orgId, 'receipt');
  return { seq: r.seq };
}

/* ── Exports recorded on the chain ────────────────────────── */

/** A compliance report downloaded (the whole report, or one framework's coverage). Exports work while a stopped pilot is read-only. */
export async function recordComplianceExport(orgId: string, input: { format: 'csv' | 'pdf' | 'json'; frameworkId?: string }, userId: string) {
  const role = db.memberRole(orgId, userId);
  if (!can(role, 'compliance.manage')) requirePermission(orgId, userId, 'evidence.export', 'Exporting a compliance report', { anyTime: true });
  if (!['csv', 'pdf', 'json'].includes(input?.format)) throw new Error('Choose CSV, PDF or JSON.');
  const d = db.getDB(orgId);
  let details: Record<string, string | number>;
  if (input.frameworkId !== undefined) {
    const f = d.frameworks.find((x) => x.id === input.frameworkId);
    if (!f) throw new Error('There is no such framework.');
    details = { format: input.format, framework: f.short };
  } else details = { format: input.format, frameworks: d.frameworks.filter((f) => f.enabled).length, level: levelOfOrg(d.org) };
  const r = db.logAdmin(orgId, userId, 'compliance.report_exported', details);
  db.touch(orgId, 'receipt');
  return { seq: r.seq };
}

/** One record's evidence file downloaded (the browser builds the file; its digest goes on the receipt). */
export async function recordEvidenceExported(orgId: string, input: { record: string; receipts: number; seals: number; proofs: number; digest: string }, userId: string) {
  requirePermission(orgId, userId, 'evidence.export', 'Exporting a record’s evidence', { anyTime: true });
  const digest = text(input?.digest, 'The file digest', 64);
  if (!/^[0-9a-f]{16}$/.test(digest)) throw new Error('The file digest is not a SHA-256 prefix.');
  const r = db.logAdmin(orgId, userId, 'record.evidence_exported', { record: text(input.record, 'The record'), receipts: count(input.receipts, 'Receipts'), seals: count(input.seals, 'Seals'), proofs: count(input.proofs, 'Proofs'), digest });
  db.touch(orgId, 'receipt');
  return { seq: r.seq };
}

/** An exported bundle addressed to its recipient (Assurance › Exports). The exports named must be this organisation's. */
export async function recordExportAddressed(orgId: string, input: { exportIds: string[]; recipient: string; recipientKind: string }, userId: string) {
  requirePermission(orgId, userId, 'evidence.export', 'Addressing an export', { anyTime: true });
  const d = db.getDB(orgId);
  const ids = Array.isArray(input?.exportIds) ? input.exportIds : [];
  const exports = ids.map((id) => d.exports.find((e) => e.id === id));
  if (!exports.length || exports.some((e) => !e)) throw new Error('That export is not one of this organisation’s.');
  const first = exports[0]!;
  const r = db.logAdmin(orgId, userId, 'evidence.addressed', { export: exports[exports.length - 1]!.id, recipient: text(input.recipient, 'The recipient'), recipient_kind: text(input.recipientKind, 'The kind of recipient', 40), parts: exports.length, ...(first.seq !== undefined ? { export_seq: first.seq } : {}) });
  db.touch(orgId, 'receipt');
  return { seq: r.seq };
}

/** The continuity report downloaded: what it covered, from the integrity runs as they are now. */
export async function recordContinuityReport(orgId: string, userId: string) {
  requirePermission(orgId, userId, 'activity.read', 'Downloading the continuity report', { anyTime: true });
  const data = continuityReport(db.getDB(orgId));
  const r = db.logAdmin(orgId, userId, 'evidence.continuity_report', { runs: data.runs.length, covered_from: data.coveredFrom ?? 0, covered_to: data.coveredTo ?? 0, gaps: data.gaps.length, failures: data.failures.length, unchecked: data.unchecked?.count ?? 0 });
  db.touch(orgId, 'receipt');
  return { seq: r.seq };
}

/* ── Redacted sharing (L2: signed here, handed over as a file) ───── */

function requireShare(orgId: string, userId: string, what: string) {
  requireRole(orgId, userId, MANAGERS, what, { anyTime: true });
  const d = db.getDB(orgId);
  if (!atLeast(levelOfOrg(d.org), 'l2')) throw new Error(`${what} starts at L2 Attested.`);
  return d;
}

/** The SD-JWT share of one receipt (Activity › receipt › Share with redaction), signed with the key that signed it. */
export async function issueRedactedShare(orgId: string, input: { seq: number; fields: DisclosableField[]; audience: string; relatedSeq?: number; expiresDays?: number }, userId: string): Promise<RedactedShare> {
  const d = requireShare(orgId, userId, 'Sharing a receipt with redaction');
  const r = receiptAt(d, input?.seq, 'That receipt');
  const related = input.relatedSeq !== undefined ? receiptAt(d, input.relatedSeq, 'The approval result') : undefined;
  const days = input.expiresDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('A share lasts between 1 and 365 days.');
  const share = buildRedactedShare(orgId, r, fieldsOf(input.fields), text(input.audience ?? '', 'The audience'), userId, related, days);
  db.touch(orgId, 'receipt');
  return share;
}

/** A record's redacted file (Records › Share with redaction at L2): every field committed, the chosen ones revealed, signed. */
export async function signRedactedFile(orgId: string, input: { seq: number; approvalSeq?: number; fields: DisclosableField[]; audience: string; days: number; record: string }, userId: string): Promise<{ pkg: DisclosurePackage; seq: number }> {
  const d = requireShare(orgId, userId, 'Sharing a record with redaction');
  const decision = receiptAt(d, input?.seq, 'That receipt');
  const approval = input.approvalSeq !== undefined ? receiptAt(d, input.approvalSeq, 'The approval') : undefined;
  const fields = fieldsOf(input.fields);
  const days = Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('A share lasts between 1 and 365 days.');
  const key = d.keys[d.keys.length - 1].key;
  const values = fieldValuesOf(decision, approval);
  const { committed, salts } = commitFields(values);
  const now = Date.now();
  const audience = text(input.audience ?? '', 'The audience') || 'ar-org:unspecified';
  const base = { id: `dp_file_${now.toString(36)}`, orgId, issuerName: d.org.name, seq: decision.seq, receiptHash: decision.hash, createdAt: new Date(now).toISOString(), createdBy: userId, audience, token: '', expiresAt: new Date(now + days * 864e5).toISOString(), committed, revealed: fields.slice().sort().map((f) => ({ name: f, salt: salts[f], value: values[f] })), kid: key.kid, publicKey: key.publicKeyHex, sig: '', status: 'active' as const, views: 0 };
  const pkg: DisclosurePackage = { ...base, sig: signText(disclosureMessage(base), key) };
  const r = db.logAdmin(orgId, userId, 'disclosure.exported', { seq: decision.seq, revealed: pkg.revealed.length, committed: pkg.committed.length, audience: pkg.audience, record: text(input.record, 'The record') });
  db.touch(orgId, 'receipt');
  return { pkg, seq: r.seq };
}

/* ── Assurance level upgrade wizard ───────────────────────── */

const UPGRADE_STEPS = ['level.upgrade_started', 'level.upgrade_stage', 'level.upgrade_seconded', 'level.upgrade_cancelled'] as const;
export type UpgradeStep = (typeof UPGRADE_STEPS)[number];

/** Record a wizard step as an admin receipt on the organisation's chain. Owners and admins prepare an upgrade; an owner confirms it. */
export async function recordUpgradeStep(orgId: string, action: UpgradeStep, details: Record<string, string | number | boolean>, userId: string) {
  requireRole(orgId, userId, MANAGERS, 'Recording an upgrade step');
  if (!UPGRADE_STEPS.includes(action)) throw new Error('That is not a step of the upgrade.');
  const clean = plainObject<Record<string, unknown>>(details ?? {}, 'The step', 16 * 1024);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(clean)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/i.test(k)) throw new Error('A step detail has an unusual name.');
    if (typeof v === 'string') out[k] = text(v, 'A step detail', 2000);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else throw new Error('A step detail is not text, a number or yes/no.');
  }
  const r = db.logAdmin(orgId, userId, action, out);
  db.touch(orgId, 'receipt');
  return { seq: r.seq, ts: r.ts };
}

/* ── Working papers (each person's own, per client) ───────── */

type WithPapers = db.OrgDB & { workingPapers?: Record<string, WorkingPapers> };

const paperDigest = (p: WorkingPapers) => sha256Hex(canonical({ ...p, digest: undefined, updatedAt: undefined })).slice(0, 16);

/** Your working papers for this client (never written to its chain), or undefined. */
export function workingPapersOf(orgId: string, userId: string): WorkingPapers | undefined {
  const p = (db.peekDB(orgId) as WithPapers | undefined)?.workingPapers?.[userId];
  return p ? clone(p) : undefined;
}

/** Save your working papers for this client. Synchronous: the screen saves on every tick or note and shows the stored copy. */
export function saveWorkingPapers(orgId: string, papers: WorkingPapers, userId: string): WorkingPapers {
  requireMember(orgId, userId, 'Saving working papers');
  const p = plainObject<WorkingPapers>(papers, 'The working papers', 2 * 1024 * 1024);
  if (p.version !== 2) throw new Error('These working papers are from an older console.');
  const v: WorkingPapers = { ...p, auditorId: userId, orgId, updatedAt: new Date().toISOString() };
  v.digest = paperDigest(v);
  const d = db.getDB(orgId) as WithPapers;
  (d.workingPapers ??= {})[userId] = v;
  db.touch(orgId, 'papers');
  return clone(v);
}

