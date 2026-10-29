/**
 * L1 → L2 upgrade close-out: the key bound before the switch, the named signing-on sequence, the first-ten-records
 * check, the tenant's first bundle with a tampered copy, the closing record with its seven checks, the signed-island
 * rollback and the customer notices.
 *
 * Every fact is a receipt in the organisation's own chain (level.upgrade_* and level.signing_* admin receipts), so the
 * close-out is shared by everyone in the organisation, survives a reload and is itself evidence. The only state kept
 * outside the chain is what must never be in a receipt: the bound key's private seed (in a real deployment it never
 * leaves AWS KMS) and the full text and address of each notice (receipts carry a digest and the mail domain).
 */
import type { LevelId, Receipt } from '@/types';
import { contentOk, keyFromSeed, sha256Hex, verifySig } from '@/lib/crypto';
import { bundleDigest, verifyBundle, type EvidenceBundle, type VerifyBundleResult } from '@/lib/verify6';
import { LEVEL_INFO, levelOfOrg } from '@/lib/levels';
import { append, deriveBilling, getDB, memberRole, persistLevels, rotateKey, syncOrgMeta, touch, type OrgDB } from './db';
import { userById, userName } from './users';
import { assertKeyChangeAllowed } from './keys';

const D = 24 * 3_600_000;
const short = (db: OrgDB) => db.org.slug.split('-')[0];
const seqL = (s: number) => `#${s.toLocaleString('en-IN')}`;
const dateL = (t: string | number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

/*
 * A planned boundary is a calendar date in India ('YYYY-MM-DD'). It is compared as a day, never through new Date(),
 * which reads it as UTC midnight (05:30 IST) and makes a date 14 days away look like 13 in the IST evening.
 */
const IST_MS = 5.5 * 3_600_000;
/** The IST calendar day an instant falls on, as a day number. */
const istDayOf = (t: number) => Math.floor((t + IST_MS) / D);
/** A 'YYYY-MM-DD' date as the same day number. */
const dayOfDate = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / D);
/** Whole calendar days (IST) from the day `from` falls on to the planned date: 14 means the date is 14 days later. */
export const noticeLeadDays = (planned: string, from: number) => dayOfDate(planned) - istDayOf(from);
/** The planned date as a 'YYYY-MM-DD' value `days` IST calendar days after `from` (for date inputs). */
export const istDatePlus = (from: number, days: number) => new Date((istDayOf(from) + days) * D).toISOString().slice(0, 10);
/** The moment a planned date starts in India (00:00 IST). */
export const plannedStart = (d: string) => Date.parse(`${d}T00:00:00+05:30`);

/* ── Private state (never in a receipt) ───────────────────────── */

interface StoredKey { seed: string; kid: string; fingerprint: string; publicKeyHex: string; createdAt: string; createdSeq: number; runSeq: number }
interface StoredNotice { body: string; toEmail: string }
interface CloseoutStore { keys: StoredKey[]; notices: Record<string, StoredNotice> }
type DBX = OrgDB & { upgradeCloseout?: CloseoutStore };

/** Saved browser state may predate the close-out: every field is defaulted on read. */
function store(db: OrgDB): CloseoutStore {
  const x = db as DBX;
  if (!x.upgradeCloseout) x.upgradeCloseout = { keys: [], notices: {} };
  x.upgradeCloseout.keys ??= [];
  x.upgradeCloseout.notices ??= {};
  return x.upgradeCloseout;
}

/* ── Public types ─────────────────────────────────────────────── */

export type NoticeKind = 'fourteen_day' | 'boundary_day' | 'auditor_note';
export type NoticeStatus = 'scheduled' | 'sent' | 'cancelled';

export const NOTICE_INFO: Record<NoticeKind, { label: string; when: string }> = {
  fourteen_day: { label: '14-day notice', when: 'At least 14 days before the boundary' },
  boundary_day: { label: 'Boundary-day confirmation', when: 'On the boundary day, with the counts each side' },
  auditor_note: { label: 'Auditor note', when: 'On or after the boundary day' },
};

export interface UpgradeNotice {
  id: string;
  kind: NoticeKind;
  toName: string;
  toEmail: string;
  toRole: string;
  subject: string;
  body: string;
  /** ISO time, or 'boundary' — sent the moment signing starts. */
  sendAt: string;
  plannedBoundary?: string;
  status: NoticeStatus;
  scheduledBy: string;
  scheduledSeq: number;
  scheduledAt: string;
  sentSeq?: number;
  sentAt?: string;
  cancelledSeq?: number;
}

export interface BoundKeyView {
  kid: string;
  fingerprint: string;
  alias: string;
  keyRef: string;
  region: string;
  createdSeq: number;
  createdAt: string;
  createdBy: string;
  /** recorded once the fingerprint received out of band matched */
  comparedSeq?: number;
  comparedAt?: string;
  comparedBy?: string;
  channel?: string;
  /** keys created for this upgrade and replaced before the switch */
  replaced: number;
  mismatches: number;
}

export interface FirstTenRow {
  seq: number;
  ts: string;
  what: string;
  kid: string;
  fingerprint: string;
  kidOk: boolean;
  fingerprintOk: boolean;
  hashOk: boolean;
  sigOk: boolean;
  linkOk: boolean;
  ok: boolean;
}

export type CheckState = 'pass' | 'fail' | 'waiting';
export interface CloseCheck { id: string; n: number; label: string; state: CheckState; detail: string; seq?: number }

export interface IslandView { seq: number; at: string; by: string; reason: string; firstSeq: number; lastSeq: number; records: number; kid: string; fingerprint: string; upgradeSeq: number }

export type CloseoutPhase = 'none' | 'preparing' | 'switched' | 'closed' | 'rolled_back';

export interface CloseoutView {
  orgId: string;
  orgName: string;
  slug: string;
  level: LevelId;
  phase: CloseoutPhase;
  run?: { seq: number; at: string; by: string };
  key?: BoundKeyView;
  /** the out-of-band message (simulated): where elan1 sent the fingerprint */
  outOfBand?: { channel: string; to: string; sentAt: string };
  preflight?: { seq: number; at: string; ok: boolean; detail: string };
  upgrade?: { seq: number; at: string; by: string };
  boundary?: { at: string; recordsBefore: number; recordsAfter: number };
  signing?: { seq: number; at: string; kid: string; fingerprint: string; namedSeq?: number; leadDays?: number; earlyAgreed?: boolean };
  /** what the confirm screen names before the switch */
  nextSigningSeq: number;
  /** records in the chain now */
  recordsNow: number;
  firstTen: { rows: FirstTenRow[]; recorded?: { seq: number; at: string; by: string; result: string } };
  firstBundle?: { seq: number; at: string; by: string; exitCode: number; code: string; tamperedExitCode: number; tamperedCode: string; tamperedSeq?: number; tamperedField?: string; receipts?: number };
  anchoring: { state: CheckState; detail: string };
  notices: UpgradeNotice[];
  checks: CloseCheck[];
  closed?: { seq: number; at: string; by: string; checks: string };
  rolledBack?: IslandView;
  islands: IslandView[];
  canRollBack: boolean;
  whyNoRollback?: string;
}

/* ── The upgrade episode, read from the chain ─────────────────── */

interface Episode { start: Receipt; rs: Receipt[] }

const isL1toL2Start = (r: Receipt) => r.action === 'level.upgrade_started' && r.details?.to === 'l2' && (r.details?.from === 'l1' || r.details?.from === undefined);

/**
 * The newest L1 → L2 upgrade: from its level.upgrade_started up to the next upgrade start. A run cancelled before
 * its switch is passed over for an earlier one; a run in progress is returned as it is.
 */
function episode(db: OrgDB): Episode | undefined {
  const rs = db.receipts;
  let end = rs.length;
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if (r.action !== 'level.upgrade_started') continue;
    if (!isL1toL2Start(r)) { end = i; continue; }
    const slice = rs.slice(i + 1, end);
    const upgraded = slice.some((x) => x.action === 'level.upgraded' && x.details?.to === 'l2');
    const cancelled = slice.some((x) => x.action === 'level.upgrade_cancelled');
    if (cancelled && !upgraded) { end = i; continue; }
    return { start: r, rs: slice };
  }
  return undefined;
}

/**
 * A signed-island rollback (not the platform's undo of a switch that failed part-way). A live rollback names the island
 * by its sequence range; a seeded one names it by the KMS key, and the range is read from the chain.
 */
const isIslandRollback = (r: Receipt) => r.action === 'level.upgrade_rolled_back' && (r.details?.island_first_seq !== undefined || r.details?.island_kid !== undefined);

const lastOf = (rs: Receipt[], pred: (r: Receipt) => boolean) => { for (let i = rs.length - 1; i >= 0; i--) if (pred(rs[i])) return rs[i]; return undefined; };
const firstOf = (rs: Receipt[], pred: (r: Receipt) => boolean) => rs.find(pred);
const s = (r: Receipt | undefined, k: string) => (r?.details?.[k] === undefined ? undefined : String(r.details[k]));
const num = (r: Receipt | undefined, k: string) => { const v = r?.details?.[k]; return v === undefined || v === '' || isNaN(Number(v)) ? undefined : Number(v); };

/** Before the switch: the episode in progress (no level.upgraded yet). */
function runInProgress(db: OrgDB): Episode | undefined {
  const ep = episode(db);
  if (!ep || ep.rs.some((r) => r.action === 'level.upgraded')) return undefined;
  return ep;
}

/* ── Key binding (stage 1) ────────────────────────────────────── */

const aliasFor = (db: OrgDB) => `alias/elan1/${db.org.slug}/signing`;
const arnFor = (kid: string) => { const h = sha256Hex(kid); return `arn:aws:kms:ap-south-1:441723908815:key/${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 28)}`; };

function requireOwnerOrAdmin(orgId: string, userId: string, what: string) {
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what}: owners and admins can do this; your role cannot.`);
}

/** Where elan1 sends the fingerprint out of band: the owner's phone by SMS, or their email. */
function outOfBandFor(db: OrgDB) {
  const owner = db.members.find((m) => m.role === 'owner' && m.status === 'active');
  const u = owner ? userById(owner.userId) : undefined;
  if (u?.phone) return { channel: 'SMS', to: `${u.name} (${u.phone.slice(0, 3)} ••••• ${u.phone.replace(/\D/g, '').slice(-5)})` };
  return { channel: 'Email', to: u ? `${u.name} (${u.email.replace(/^(.).*@/, '$1•••@')})` : 'the organisation’s owner' };
}

/**
 * Create the Ed25519 signing key in AWS KMS for the upgrade in progress — before the switch, so its fingerprint can
 * be compared out of band. Creating it again replaces the earlier one (recorded); nothing signs with it yet.
 */
export function createUpgradeKey(orgId: string, userId: string) {
  requireOwnerOrAdmin(orgId, userId, 'Creating the signing key');
  const db = getDB(orgId);
  if (levelOfOrg(db.org) !== 'l1') throw new Error('The key is bound during an upgrade from L1 Guarded to L2 Attested.');
  const ep = runInProgress(db);
  if (!ep) throw new Error('Start the upgrade to L2 Attested first.');
  const st = store(db);
  const n = st.keys.filter((k) => k.runSeq === ep.start.seq).length + 1;
  const seed = `${orgId}:kms-bind:${ep.start.seq}:${n}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const kid = `k_${short(db)}_kms_${new Date().toISOString().slice(2, 7).replace('-', '')}_${db.keys.length + 1}${n > 1 ? String.fromCharCode(96 + n) : ''}`;
  const k = keyFromSeed(seed, kid);
  const previous = lastOf(ep.rs, (r) => r.action === 'level.upgrade_key_created');
  if (previous && ep.rs.some((r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'kms' && r.details?.kid === previous.details?.kid)) {
    throw new Error(`Key ${s(previous, 'kid')} is already bound and its fingerprint compared. To use a different key, cancel this upgrade and start again.`);
  }
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_key_created', details: {
    to: 'l2', kid, fingerprint: k.fingerprint, alias: aliasFor(db), key_ref: arnFor(kid), region: 'ap-south-1', algorithm: 'Ed25519', key_spec: 'ECC_NIST_EDWARDS25519',
    ...(previous ? { replaces: s(previous, 'kid') ?? '' } : {}),
  } });
  st.keys.push({ seed, kid, fingerprint: k.fingerprint, publicKeyHex: k.publicKeyHex, createdAt: r.ts, createdSeq: r.seq, runSeq: ep.start.seq });
  touch(orgId, 'level');
  return { kid, fingerprint: k.fingerprint, seq: r.seq, ...outOfBandFor(db) };
}

const normFp = (x: string) => x.toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * Compare the fingerprint received out of band with the key in KMS. A match records the key stage of the wizard
 * (level.upgrade_stage, stage kms); a mismatch is recorded too, and the key cannot be used until a new one matches.
 */
export function compareUpgradeFingerprint(orgId: string, userId: string, typed: string) {
  requireOwnerOrAdmin(orgId, userId, 'Comparing the key fingerprint');
  const db = getDB(orgId);
  const ep = runInProgress(db);
  if (!ep) throw new Error('No upgrade to L2 Attested is in progress.');
  const created = lastOf(ep.rs, (r) => r.action === 'level.upgrade_key_created');
  if (!created) throw new Error('Create the key in AWS KMS first.');
  const kid = s(created, 'kid') ?? '';
  const fp = s(created, 'fingerprint') ?? '';
  const got = normFp(typed);
  const oob = outOfBandFor(db);
  if (got !== fp) {
    const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_fingerprint_mismatch', details: { to: 'l2', kid, expected_prefix: fp.slice(0, 4), received_prefix: got.slice(0, 4) || '—', received_length: got.length } });
    touch(orgId, 'level');
    return { match: false as const, seq: r.seq };
  }
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_stage', details: {
    to: 'l2', stage: 'kms', kid, fingerprint: fp, fingerprint_compared: 'match', channel: `${oob.channel} to ${oob.to}`, region: 'ap-south-1', alias: aliasFor(db), algorithm: 'Ed25519', key_created_seq: created.seq,
  } });
  touch(orgId, 'level');
  return { match: true as const, seq: r.seq };
}

/**
 * The key bound and compared for the upgrade in progress, for the switch to sign with. Undefined when the key stage
 * was not recorded (the platform then creates a key at the switch, as before).
 */
export function takeBoundKey(db: OrgDB): { seed: string; kid: string } | undefined {
  // called before the switch and at it (level.upgraded is then already written), never after signing started
  const ep = episode(db);
  if (!ep || ep.rs.some((r) => r.action === 'level.signing_on' || r.action === 'level.upgrade_rolled_back')) return undefined;
  const up = firstOf(ep.rs, (r) => r.action === 'level.upgraded');
  const created = lastOf(ep.rs, (r) => r.action === 'level.upgrade_key_created' && (!up || r.seq < up.seq));
  const stage = lastOf(ep.rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'kms' && r.details?.fingerprint_compared === 'match' && (!up || r.seq < up.seq) && (!created || r.details?.kid === created.details?.kid));
  const k = stage ? store(db).keys.find((x) => x.kid === s(stage, 'kid')) : undefined;
  return k ? { seed: k.seed, kid: k.kid } : undefined;
}

/* ── Notices ──────────────────────────────────────────────────── */

export interface NoticeFacts { org: string; plannedBoundary?: string; boundaryAt?: string; signingSeq?: number; before?: number; after?: number; fingerprint?: string; contact?: string }

/** The default text of each notice. Tokens in {braces} are filled when it is sent. */
export function noticeTemplate(kind: NoticeKind, f: NoticeFacts): { subject: string; body: string } {
  const who = f.contact ? `Dear ${f.contact.split(' ')[0]},` : 'Hello,';
  if (kind === 'fourteen_day') {
    const when = f.plannedBoundary ? dateL(f.plannedBoundary) : '{planned_boundary}';
    return {
      subject: `${f.org} moves to L2 Attested on ${when}`,
      body: `${who}

This is 14 days' notice that ${f.org} will move its Elan1 Govern records from L1 Guarded to L2 Attested on ${when}.

What changes at the boundary:
- Records before the boundary stay at L1 for ever: sealed in a hash chain by Elan1 Govern and not externally timestamped. They keep verifying with the same verifier.
- From the boundary, each record is sealed with Seal v6, signed with a key in AWS KMS (ap-south-1) and timestamped by two authorities.

The new key's fingerprint will reach you separately, not in this email. Please keep it: anyone checking our records relies on the fingerprint you hold, not on the key inside a bundle.

On the boundary day you will receive a confirmation with the first signed sequence number and the number of records on each side.

Nothing is needed from you. If the date does not suit you, reply before ${when}.`,
    };
  }
  if (kind === 'boundary_day') {
    return {
      subject: `${f.org} is on L2 Attested from record {signing_seq}`,
      body: `${who}

${f.org} moved to L2 Attested today, {boundary_date}.

- Signing began at record {signing_seq}, with the key whose fingerprint is {fingerprint}.
- {records_before} records before the boundary stay at L1, sealed in a hash chain by Elan1 Govern.
- {records_after} records so far are at L2: sealed, signed with the key in AWS KMS and timestamped by two authorities.

Please compare the fingerprint above with the one you received separately. If they differ, tell us before relying on any record from {signing_seq}.`,
    };
  }
  return {
    subject: `Auditor note: ${f.org} L1 → L2 boundary at record {signing_seq}`,
    body: `${who}

For your working papers: ${f.org} moved from L1 Guarded to L2 Attested on {boundary_date}.

- Boundary: records up to the one before {signing_seq} are L1 (sealed in a hash chain, not externally timestamped); from {signing_seq} they are L2.
- Records each side at the time of this note: {records_before} before, {records_after} after.
- Signing key fingerprint, obtained out of band: {fingerprint}.

To check a bundle on an air-gapped machine:
  govern verify bundle.json --fingerprint {fingerprint}
Exit 0 means it verifies; exit 1 names the first broken record. We ran a deliberately tampered copy of our first bundle and it exited 1.

This note is a draft and needs legal review before you rely on it.`,
  };
}

/** Fill {tokens} with the facts known now. Unknown tokens stay as they are. */
export function fillNotice(text: string, f: NoticeFacts): string {
  const map: Record<string, string | undefined> = {
    boundary_date: f.boundaryAt ? dateL(f.boundaryAt) : undefined,
    planned_boundary: f.plannedBoundary ? dateL(f.plannedBoundary) : undefined,
    signing_seq: f.signingSeq !== undefined ? seqL(f.signingSeq) : undefined,
    records_before: f.before !== undefined ? f.before.toLocaleString('en-IN') : undefined,
    records_after: f.after !== undefined ? f.after.toLocaleString('en-IN') : undefined,
    fingerprint: f.fingerprint ? f.fingerprint.replace(/(.{4})(?=.)/g, '$1 ') : undefined,
  };
  return text.replace(/\{(\w+)\}/g, (m, k: string) => map[k] ?? m);
}

const domainOf = (email: string) => email.split('@')[1] ?? '';

function noticesOf(db: OrgDB, ep: Episode): UpgradeNotice[] {
  const st = store(db);
  const out: UpgradeNotice[] = [];
  const facts = factsFor(db, ep);
  for (const r of ep.rs) {
    const id = s(r, 'notice');
    if (!id) continue;
    if (r.action === 'level.upgrade_notice_scheduled') {
      const kind = s(r, 'kind') as NoticeKind;
      const saved = st.notices[id];
      const tpl = noticeTemplate(kind, { ...facts, plannedBoundary: s(r, 'planned_boundary') ?? facts.plannedBoundary, contact: s(r, 'to_name') });
      out.push({
        id, kind, toName: s(r, 'to_name') ?? '', toEmail: saved?.toEmail ?? `…@${s(r, 'to_domain') ?? ''}`, toRole: s(r, 'to_role') ?? '', subject: s(r, 'subject') ?? tpl.subject,
        body: saved?.body ?? tpl.body, sendAt: s(r, 'send_at') ?? 'boundary', plannedBoundary: s(r, 'planned_boundary'), status: 'scheduled', scheduledBy: r.actor ?? '', scheduledSeq: r.seq, scheduledAt: r.ts,
      });
    } else {
      const n = out.find((x) => x.id === id);
      if (!n) continue;
      if (r.action === 'level.upgrade_notice_sent') {
        n.status = 'sent'; n.sentSeq = r.seq; n.sentAt = r.ts; n.subject = s(r, 'subject') ?? n.subject;
        // a seeded notice has no stored text: show the template filled with the facts it was sent with
        if (!st.notices[id]) { n.body = fillNotice(n.body, facts); n.subject = fillNotice(n.subject, facts); }
      }
      if (r.action === 'level.upgrade_notice_cancelled' && n.status === 'scheduled') { n.status = 'cancelled'; n.cancelledSeq = r.seq; }
    }
  }
  return out;
}

function factsFor(db: OrgDB, ep: Episode): NoticeFacts {
  const upgraded = firstOf(ep.rs, (r) => r.action === 'level.upgraded' && r.details?.to === 'l2');
  const signing = firstOf(ep.rs, (r) => r.action === 'level.signing_on');
  const fourteen = firstOf(ep.rs, (r) => r.action === 'level.upgrade_notice_scheduled' && r.details?.kind === 'fourteen_day');
  const stage = lastOf(ep.rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'kms');
  // the counts each side of the first signed record (the boundary record and the key handover are still L1)
  const cut = signing?.seq ?? upgraded?.seq;
  const before = cut !== undefined ? db.receipts.filter((r) => r.seq < cut).length : undefined;
  return {
    org: db.org.name,
    plannedBoundary: s(fourteen, 'planned_boundary'),
    boundaryAt: upgraded?.ts,
    signingSeq: signing?.seq,
    before,
    after: before !== undefined ? db.receipts.length - before : undefined,
    fingerprint: s(signing, 'fingerprint') ?? s(stage, 'fingerprint'),
  };
}

export interface NoticeInput { kind: NoticeKind; toName: string; toEmail: string; toRole: string; subject: string; body: string; sendAt: string; plannedBoundary?: string }

/** Compose and schedule a notice. A notice due now is sent at once; one for 'boundary' goes when signing starts. */
export function scheduleNotice(orgId: string, userId: string, input: NoticeInput) {
  requireOwnerOrAdmin(orgId, userId, 'Scheduling a notice');
  const db = getDB(orgId);
  const ep = episode(db);
  if (!ep) throw new Error('Start the upgrade to L2 Attested first.');
  if (ep.rs.some((r) => r.action === 'level.upgrade_closed' || isIslandRollback(r))) throw new Error('This upgrade is closed; its notices can no longer change.');
  const upgraded = ep.rs.some((r) => r.action === 'level.upgraded');
  if (!input.toName.trim()) throw new Error('Name the person the notice goes to.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.toEmail.trim())) throw new Error('Enter an email address for the named contact.');
  if (!input.subject.trim() || !input.body.trim()) throw new Error('A notice needs a subject and a body.');
  if (input.kind === 'fourteen_day') {
    if (upgraded) throw new Error('The 14-day notice goes before the switch; this organisation has already switched.');
    if (!input.plannedBoundary) throw new Error('Name the planned boundary date.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.plannedBoundary) || isNaN(dayOfDate(input.plannedBoundary))) throw new Error('Name the planned boundary as a date.');
    const sendTime = Math.max(Date.now(), input.sendAt === 'boundary' ? Date.now() : new Date(input.sendAt).getTime());
    if (noticeLeadDays(input.plannedBoundary, sendTime) < 14) throw new Error(`The planned boundary must be at least 14 days after the notice is sent: ${dateL(plannedStart(istDatePlus(sendTime, 14)))} or later.`);
  }
  if (input.kind === 'boundary_day' && input.sendAt !== 'boundary') throw new Error('The boundary-day confirmation is sent when signing starts.');
  if (input.sendAt !== 'boundary' && isNaN(new Date(input.sendAt).getTime())) throw new Error('Choose when the notice is sent.');
  const id = `ntc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  store(db).notices[id] = { body: input.body, toEmail: input.toEmail.trim() };
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_notice_scheduled', details: {
    to: 'l2', notice: id, kind: input.kind, to_name: input.toName.trim(), to_role: input.toRole.trim(), to_domain: domainOf(input.toEmail.trim()), subject: input.subject.trim(), send_at: input.sendAt,
    body_sha256: sha256Hex(input.body).slice(0, 16), ...(input.plannedBoundary ? { planned_boundary: input.plannedBoundary } : {}),
  } });
  let sent: Receipt | undefined;
  if (input.sendAt !== 'boundary' && new Date(input.sendAt).getTime() <= Date.now() + 60_000 && (input.kind === 'fourteen_day' || upgraded)) sent = sendNotice(db, userId, id);
  touch(orgId, 'level');
  return { id, seq: r.seq, sentSeq: sent?.seq };
}

/** Send one scheduled notice now: its {tokens} are filled with the facts at this moment. */
function sendNotice(db: OrgDB, actor: string, id: string): Receipt {
  const ep = episode(db)!;
  const n = noticesOf(db, ep).find((x) => x.id === id);
  if (!n) throw new Error('That notice is not part of this upgrade.');
  if (n.status !== 'scheduled') throw new Error(n.status === 'sent' ? 'That notice was already sent.' : 'That notice was cancelled.');
  const facts = factsFor(db, ep);
  const upgraded = ep.rs.some((r) => r.action === 'level.upgraded');
  if (n.kind !== 'fourteen_day' && !upgraded) throw new Error(`The ${NOTICE_INFO[n.kind].label.toLowerCase()} goes on or after the boundary day; it is sent when signing starts.`);
  const body = fillNotice(n.body, facts);
  const subject = fillNotice(n.subject, facts);
  store(db).notices[id] = { body, toEmail: n.toEmail };
  return append(db, { kind: 'admin', actor, action: 'level.upgrade_notice_sent', details: { to: 'l2', notice: id, kind: n.kind, to_name: n.toName, to_domain: domainOf(n.toEmail), channel: 'email', subject, body_sha256: sha256Hex(body).slice(0, 16) } });
}

export function sendNoticeNow(orgId: string, userId: string, id: string) {
  requireOwnerOrAdmin(orgId, userId, 'Sending a notice');
  const db = getDB(orgId);
  const r = sendNotice(db, userId, id);
  touch(orgId, 'level');
  return { seq: r.seq };
}

export function cancelNotice(orgId: string, userId: string, id: string) {
  requireOwnerOrAdmin(orgId, userId, 'Cancelling a notice');
  const db = getDB(orgId);
  const ep = episode(db);
  const n = ep ? noticesOf(db, ep).find((x) => x.id === id) : undefined;
  if (!n) throw new Error('That notice is not part of this upgrade.');
  if (n.status !== 'scheduled') throw new Error('Only a scheduled notice can be cancelled; a sent one stays sent.');
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_notice_cancelled', details: { to: 'l2', notice: id, kind: n.kind, to_name: n.toName } });
  touch(orgId, 'level');
  return { seq: r.seq };
}

/** Send every scheduled notice whose time has come (and, after the switch, the 'boundary' ones). Recorded by the system. */
function dispatchDue(db: OrgDB) {
  const ep = episode(db);
  if (!ep) return 0;
  const upgraded = ep.rs.some((r) => r.action === 'level.upgraded');
  if (ep.rs.some(isIslandRollback)) return 0;
  let sent = 0;
  for (const n of noticesOf(db, ep)) {
    if (n.status !== 'scheduled') continue;
    const due = n.sendAt === 'boundary' ? upgraded : new Date(n.sendAt).getTime() <= Date.now() && (n.kind === 'fourteen_day' || upgraded);
    if (!due) continue;
    sendNotice(db, 'system', n.id);
    sent++;
  }
  return sent;
}

/* ── The switch: signing on at the named sequence ─────────────── */

/** The sequence signing starts at if the owner confirms now: level.upgraded, key.rotated, then the first signed record. */
export function nextSigningSeq(db: OrgDB) {
  return db.receipts[db.receipts.length - 1].seq + 3;
}

/** The 14-day notice's planned boundary, and how many days early a switch now would be. */
function noticeLead(db: OrgDB, ep: Episode) {
  const ns = noticesOf(db, ep);
  const fourteen = ns.find((n) => n.kind === 'fourteen_day' && n.status === 'sent');
  if (!fourteen?.sentAt) return undefined;
  // early: switching before the planned date has begun in India
  const planned = fourteen.plannedBoundary ? plannedStart(fourteen.plannedBoundary) : undefined;
  return { notice: fourteen, leadDays: istDayOf(Date.now()) - istDayOf(new Date(fourteen.sentAt).getTime()), planned, early: planned !== undefined && Date.now() < planned };
}

/**
 * Everything that must hold before the switch, checked before anything is written: the upgrade in progress, the key
 * bound and compared, the 14-day notice sent (or the named contact's agreement to an earlier date) and the chain
 * still where the confirm screen named it.
 */
export function preSwitchCheck(orgId: string, namedSeq: number, earlyAgreed: boolean) {
  const db = getDB(orgId);
  const ep = runInProgress(db);
  if (!ep) throw new Error('No upgrade to L2 Attested is in progress.');
  if (!takeBoundKey(db)) throw new Error('Bind the signing key and compare its fingerprint before the switch.');
  const lead = noticeLead(db, ep);
  if (!lead) throw new Error('Send the 14-day notice to the named contact before the switch.');
  if (lead.early && !earlyAgreed) throw new Error(`The notice named ${dateL(lead.planned!)} as the boundary. Record that ${lead.notice.toName} agreed to an earlier date, or wait.`);
  const expected = nextSigningSeq(db);
  if (namedSeq !== expected) throw new Error(`The chain has moved since this screen named ${seqL(namedSeq)}: signing would now start at ${seqL(expected)}. Nothing was changed. Check the new number and confirm again.`);
  return { leadDays: lead.leadDays, early: lead.early, planned: lead.planned };
}

/**
 * Straight after level.upgraded: write the signing-on record (the first record signed by the bound key, at the named
 * sequence), nine canary records so the first-ten check has ten signed records at once, and send the notices
 * scheduled for the boundary.
 */
export function signOn(orgId: string, userId: string, namedSeq: number, info: { leadDays: number; early: boolean; earlyAgreed: boolean }) {
  const db = getDB(orgId);
  const key = db.keys[db.keys.length - 1].key;
  const ep = episode(db);
  const upgraded = ep ? firstOf(ep.rs, (r) => r.action === 'level.upgraded' && r.details?.to === 'l2') : undefined;
  const bound = ep ? lastOf(ep.rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'kms') : undefined;
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.signing_on', details: {
    to: 'l2', named_seq: namedSeq, kid: key.kid, fingerprint: key.fingerprint, bound_kid_matches: s(bound, 'kid') === key.kid, boundary_seq: upgraded?.seq ?? 0,
    records_before: db.receipts.length, notice_lead_days: info.leadDays, early_boundary: info.early, early_agreed: info.early && info.earlyAgreed,
  } });
  for (let k = 2; k <= 10; k++) append(db, { kind: 'admin', actor: 'system', action: 'level.signing_canary', details: { to: 'l2', n: k, of: 10, signing_seq: r.seq, kid: key.kid } });
  dispatchDue(db);
  touch(orgId, 'level');
  return { seq: r.seq, matched: r.seq === namedSeq, kid: key.kid, fingerprint: key.fingerprint };
}

/* ── After the switch ─────────────────────────────────────────── */

function signingOf(db: OrgDB, ep: Episode) {
  const on = firstOf(ep.rs, (r) => r.action === 'level.signing_on');
  if (on) return on;
  // an upgrade confirmed outside the wizard: the first record signed by the new key after level.upgraded
  const up = firstOf(ep.rs, (r) => r.action === 'level.upgraded' && r.details?.to === 'l2');
  if (!up) return undefined;
  const rot = firstOf(ep.rs, (r) => r.action === 'key.rotated' && r.seq > up.seq);
  const kid = s(rot, 'new_kid');
  return kid ? firstOf(ep.rs, (r) => r.seq > up.seq && r.kid === kid) : undefined;
}

function boundFingerprint(ep: Episode, signing?: Receipt) {
  const stage = lastOf(ep.rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'kms' && r.details?.fingerprint_compared === 'match');
  return { kid: s(stage, 'kid') ?? s(signing, 'kid') ?? signing?.kid, fingerprint: s(stage, 'fingerprint') ?? s(signing, 'fingerprint') };
}

function firstTenRows(db: OrgDB, signingSeq: number, kid?: string, fingerprint?: string): FirstTenRow[] {
  const idx = db.receipts.findIndex((r) => r.seq === signingSeq);
  if (idx < 0) return [];
  return db.receipts.slice(idx, idx + 10).map((r, i) => {
    const prev = db.receipts[idx + i - 1];
    const pub = db.publicKeys[r.kid];
    const fp = pub ? sha256Hex(pub).slice(0, 16) : '';
    const row = {
      seq: r.seq, ts: r.ts, what: r.kind === 'admin' ? String(r.action ?? 'admin') : `${r.tool ?? 'call'} · ${r.decision ?? ''}`, kid: r.kid, fingerprint: fp,
      kidOk: !kid || r.kid === kid, fingerprintOk: !!fingerprint && fp === fingerprint, hashOk: contentOk(r, db.publicKeys), sigOk: !!pub && verifySig(r.hash, r.sig, pub), linkOk: !!prev && r.prev_hash === prev.hash,
    };
    return { ...row, ok: row.kidOk && row.fingerprintOk && row.hashOk && row.sigOk && row.linkOk };
  });
}

/** Check the first ten records signed from the signing-on sequence against the fingerprint compared out of band. */
export function runFirstTen(orgId: string, userId: string) {
  requireOwnerOrAdmin(orgId, userId, 'Running the first-ten check');
  const db = getDB(orgId);
  const ep = episode(db);
  const signing = ep ? signingOf(db, ep) : undefined;
  if (!ep || !signing) throw new Error('Signing has not started at L2 yet.');
  const { kid, fingerprint } = boundFingerprint(ep, signing);
  const rows = firstTenRows(db, signing.seq, kid, fingerprint);
  if (rows.length < 10) throw new Error(`${rows.length} of 10 records are signed so far. The check runs once there are ten.`);
  const failed = rows.filter((x) => !x.ok);
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_first_ten_checked', details: {
    to: 'l2', result: failed.length ? 'fail' : 'pass', first_seq: rows[0].seq, last_seq: rows[9].seq, checked: 10, failed: failed.length, kid: kid ?? '', fingerprint: fingerprint ?? '',
    ...(failed[0] ? { first_failure: failed[0].seq } : {}),
  } });
  touch(orgId, 'level');
  return { rows, seq: r.seq, pass: !failed.length };
}

export interface FirstBundleRun {
  seq: number;
  result: VerifyBundleResult;
  tampered: VerifyBundleResult;
  json: string;
  tamperedJson: string;
  tamperedSeq: number;
  field: string;
  before: string;
  after: string;
  fingerprint: string;
}

/**
 * The tenant's own first bundle: export from the signing-on sequence to the head, verify it with the fingerprint held
 * out of band, then change one field of one record in a copy and verify that too. The original must exit 0 and the
 * tampered copy exit 1. Both results are recorded.
 */
export function runFirstBundle(orgId: string, userId: string, sent?: { exportId: string; json: string }): FirstBundleRun {
  requireOwnerOrAdmin(orgId, userId, 'Exporting the first bundle');
  const db = getDB(orgId);
  const ep = episode(db);
  const signing = ep ? signingOf(db, ep) : undefined;
  if (!ep || !signing) throw new Error('Signing has not started at L2 yet.');
  if (levelOfOrg(db.org) === 'l1') throw new Error('The upgrade was rolled back; there is no L2 bundle to export.');
  const { fingerprint } = boundFingerprint(ep, signing);
  const fp = fingerprint ?? db.org.keyFingerprint;
  // the bundle is exported through the export dialog (api.exportPack): the same checks as every console export —
  // size split, chain break, integrity run, residency, consent and declarations — verified first, ₹2,500 shown before
  // the click, ZIP or JSON. Here it is only verified again and tampered with; nothing is exported a second time.
  if (!sent) throw new Error('Export the first bundle through the export dialog first: it runs the export checks, lets you verify it and shows the charge.');
  const made = db.exports.find((e) => e.id === sent.exportId);
  if (!made) throw new Error('That export is not in this organisation’s export history.');
  if (made.firstSeq > signing.seq || made.lastSeq < signing.seq) throw new Error(`The first bundle starts at the signing-on record ${seqL(signing.seq)}; that export covers ${seqL(made.firstSeq)}–${seqL(made.lastSeq)}.`);
  // the file itself must be the one recorded for that export, as evidence requests check: same digest, or it is refused
  let sentBundle: EvidenceBundle;
  try { sentBundle = JSON.parse(sent.json) as EvidenceBundle; } catch { throw new Error('The file is not a readable bundle. Export it again through the export dialog.'); }
  const dg = bundleDigest(sentBundle);
  if (!made.digest || made.digest !== dg) throw new Error(`This file is not the one recorded for export ${made.id}: its digest ${dg.slice(0, 16)} differs from ${(made.digest ?? 'none recorded').slice(0, 16)}. Export it again through the export dialog.`);
  const out = { json: sent.json };
  const result = verifyBundle(JSON.parse(out.json), { expectedFingerprint: fp });
  // the tampered copy: one value of one record in the middle of the bundle, changed after it was signed
  const copy = JSON.parse(out.json) as { receipts: Receipt[] };
  const target = copy.receipts[Math.floor(copy.receipts.length / 2)] ?? copy.receipts[0];
  let field = 'ts';
  let before = target.ts;
  let after = new Date(new Date(target.ts).getTime() + 60_000).toISOString();
  const det = target.details;
  const keys = det ? Object.keys(det).filter((k) => k !== 'to') : [];
  const dk = keys.find((k) => typeof det![k] === 'number') ?? keys.find((k) => typeof det![k] === 'string');
  if (det && dk) {
    field = `details.${dk}`;
    const v = det[dk];
    before = String(v);
    after = typeof v === 'number' ? String(v + 1) : `${v} (edited)`;
    det[dk] = typeof v === 'number' ? v + 1 : `${v} (edited)`;
  } else target.ts = after;
  const tamperedJson = JSON.stringify(copy);
  const tampered = verifyBundle(JSON.parse(tamperedJson), { expectedFingerprint: fp });
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_first_bundle', details: {
    to: 'l2', exit_code: result.exitCode, code: result.code, receipts: result.counts.receipts, first_seq: signing.seq, bundle_sha256: sha256Hex(out.json).slice(0, 16),
    tampered_exit_code: tampered.exitCode, tampered_code: tampered.code, tampered_seq: target.seq, tampered_field: field, fingerprint_supplied: fp,
  } });
  touch(orgId, 'level');
  return { seq: r.seq, result, tampered, json: out.json, tamperedJson, tamperedSeq: target.seq, field, before, after, fingerprint: fp };
}

/* ── The seven closing checks ─────────────────────────────────── */

type AnchorLike = { firstSeq: number; lastSeq: number; windowEnd: string; tokens: { status: string }[] }[];

function anchoringOf(signing: Receipt | undefined, batches: AnchorLike | undefined): { state: CheckState; detail: string } {
  if (!signing) return { state: 'waiting', detail: 'Starts with signing.' };
  if (!batches) return { state: 'waiting', detail: 'Timestamp batches could not be read.' };
  const first = batches.find((b) => b.lastSeq >= signing.seq);
  if (!first) {
    const due = Math.floor(new Date(signing.ts).getTime() / (15 * 60_000)) * 15 * 60_000 + 16 * 60_000;
    return { state: 'waiting', detail: `The first 15-minute batch closes and is timestamped by about ${new Date(due).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST.` };
  }
  const granted = first.tokens.filter((t) => t.status === 'granted' || t.status === 'granted_late').length;
  return granted >= 2
    ? { state: 'pass', detail: `First batch ${seqL(first.firstSeq)}–${seqL(first.lastSeq)} timestamped by both authorities.` }
    : { state: 'fail', detail: `First batch ${seqL(first.firstSeq)}–${seqL(first.lastSeq)} has ${granted} of 2 timestamps.` };
}

function checksFor(db: OrgDB, ep: Episode, batches?: AnchorLike): CloseCheck[] {
  const up = firstOf(ep.rs, (r) => r.action === 'level.upgraded' && r.details?.to === 'l2');
  const signing = signingOf(db, ep);
  const pre = lastOf(ep.rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'preflight' && (!up || r.seq < up.seq));
  const kms = lastOf(ep.rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'kms' && (!up || r.seq < up.seq));
  const ten = lastOf(ep.rs, (r) => r.action === 'level.upgrade_first_ten_checked');
  const bundle = lastOf(ep.rs, (r) => r.action === 'level.upgrade_first_bundle');
  const notices = noticesOf(db, ep);
  const sent = (k: NoticeKind) => notices.find((n) => n.kind === k && n.status === 'sent');
  const fourteen = sent('fourteen_day');
  const between = up && signing ? db.receipts.filter((r) => r.seq > up.seq && r.seq < signing.seq) : [];
  const named = num(signing, 'named_seq');
  const anchor = anchoringOf(signing, batches);
  const out: Omit<CloseCheck, 'n'>[] = [
    {
      id: 'preflight', label: 'Pre-flight: the chain replayed whole before the switch',
      state: pre && s(pre, 'result') === 'verified' ? 'pass' : up ? 'fail' : 'waiting',
      detail: pre ? `Continuous${num(pre, 'receipts') ? `, ${num(pre, 'receipts')!.toLocaleString('en-IN')} records` : ''}; recorded at ${seqL(pre.seq)}.` : 'No pre-flight was recorded before the switch.', seq: pre?.seq,
    },
    {
      id: 'key', label: 'Key bound before the switch, fingerprint compared out of band',
      state: kms && s(kms, 'fingerprint_compared') === 'match' && (!signing || s(kms, 'kid') === (s(signing, 'kid') ?? signing.kid)) ? 'pass' : up ? 'fail' : 'waiting',
      detail: kms ? `${s(kms, 'kid')} · ${s(kms, 'fingerprint')} · ${s(kms, 'channel') ?? 'compared'}.` : 'No key was bound and compared before the switch.', seq: kms?.seq,
    },
    {
      id: 'signing_on', label: 'Signing began at the sequence named before the switch',
      state: !signing ? (up ? 'fail' : 'waiting') : (named === undefined || named === signing.seq) && between.every((r) => r.action === 'key.rotated') && (s(signing, 'kid') ?? signing.kid) === signing.kid ? 'pass' : 'fail',
      detail: signing ? `${named !== undefined ? `Named ${seqL(named)}; ` : ''}signing on at ${seqL(signing.seq)} with ${signing.kid}.` : 'Signing has not started.', seq: signing?.seq,
    },
    {
      id: 'first_ten', label: 'The first ten signed records verify under the bound key',
      state: ten ? (s(ten, 'result') === 'pass' ? 'pass' : 'fail') : 'waiting',
      detail: ten ? `${s(ten, 'result') === 'pass' ? 'All ten pass' : `${s(ten, 'failed')} failed`}${num(ten, 'first_seq') ? ` (${seqL(num(ten, 'first_seq')!)}–${seqL(num(ten, 'last_seq')!)})` : ''}.` : 'Not run yet.', seq: ten?.seq,
    },
    { id: 'anchoring', label: 'Anchoring on: the first batch is timestamped by two authorities', state: anchor.state, detail: anchor.detail },
    {
      id: 'first_bundle', label: 'Your first bundle exits 0; a tampered copy exits 1',
      state: bundle ? (num(bundle, 'exit_code') === 0 && num(bundle, 'tampered_exit_code') === 1 ? 'pass' : 'fail') : 'waiting',
      detail: bundle ? `Bundle: ${s(bundle, 'code')}, exit ${s(bundle, 'exit_code')}. Tampered copy: ${s(bundle, 'tampered_code')}, exit ${s(bundle, 'tampered_exit_code')}.` : 'Not exported yet.', seq: bundle?.seq,
    },
    {
      id: 'notices', label: 'Customers told: 14-day notice, boundary-day confirmation, auditor note',
      state: fourteen && sent('boundary_day') && sent('auditor_note') && (!up || fourteen.sentSeq! < up.seq) ? 'pass' : fourteen && up && fourteen.sentSeq! > up.seq ? 'fail' : 'waiting',
      detail: [
        fourteen ? `14-day notice to ${fourteen.toName}${s(signing, 'notice_lead_days') ? ` ${s(signing, 'notice_lead_days')} days ahead${s(signing, 'early_agreed') === 'true' ? ', earlier date agreed' : ''}` : ''}` : '14-day notice not sent',
        sent('boundary_day') ? `confirmation to ${sent('boundary_day')!.toName}` : 'confirmation not sent',
        sent('auditor_note') ? `auditor note to ${sent('auditor_note')!.toName}` : 'auditor note not sent',
      ].join('; ') + '.',
    },
  ];
  return out.map((c, i) => ({ ...c, n: i + 1 }));
}

/** Write the closing record: all seven checks must pass. */
export function writeClosingRecord(orgId: string, userId: string, batches: AnchorLike) {
  requireOwnerOrAdmin(orgId, userId, 'Writing the closing record');
  const db = getDB(orgId);
  dispatchDue(db);
  const ep = episode(db);
  if (!ep || !ep.rs.some((r) => r.action === 'level.upgraded')) throw new Error('There is no switched upgrade to close.');
  if (ep.rs.some((r) => r.action === 'level.upgrade_closed')) throw new Error('This upgrade already has its closing record.');
  if (ep.rs.some(isIslandRollback)) throw new Error('This upgrade was rolled back.');
  const checks = checksFor(db, ep, batches);
  const open = checks.filter((c) => c.state !== 'pass');
  if (open.length) throw new Error(`${open.length} of 7 checks ${open.length === 1 ? 'does' : 'do'} not pass yet: ${open.map((c) => c.n).join(', ')}. Nothing was written.`);
  const signing = signingOf(db, ep)!;
  const details: Record<string, string | number | boolean> = { to: 'l2', checks: '7 of 7', signing_seq: signing.seq, kid: signing.kid };
  for (const c of checks) details[`c${c.n}_${c.id}`] = c.seq ? `pass ${seqL(c.seq)}` : 'pass';
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_closed', details });
  touch(orgId, 'level');
  return { seq: r.seq };
}

/* ── Signed-island rollback ───────────────────────────────────── */

function rollbackBlock(db: OrgDB, ep: Episode | undefined): string | undefined {
  if (!ep || !ep.rs.some((r) => r.action === 'level.upgraded' && r.details?.to === 'l2')) return 'There is no switched upgrade to roll back.';
  if (ep.rs.some((r) => r.action === 'level.upgrade_closed')) return 'The closing record is written: the upgrade is final. Records keep the level they were written at.';
  if (ep.rs.some(isIslandRollback)) return 'This upgrade was already rolled back.';
  if (levelOfOrg(db.org) !== 'l2') return `The organisation is on ${LEVEL_INFO[levelOfOrg(db.org)].label} now; only an upgrade still on L2 Attested can be rolled back.`;
  return undefined;
}

/**
 * Roll back a failed L1 → L2 upgrade before its closing record. Records signed with the bound KMS key stay in the chain
 * as a signed island — they keep verifying, the key stays in keys.json — and the organisation returns to L1 Guarded:
 * a new process key seals from here, the L2 period is withdrawn from the level history (and from billing) and a
 * level.upgrade_rolled_back receipt names the island.
 */
export function rollbackUpgrade(orgId: string, userId: string, reason: string) {
  const db = getDB(orgId);
  if (memberRole(orgId, userId) !== 'owner') throw new Error('Only an owner can roll back an upgrade.');
  if (reason.trim().length < 10) throw new Error('Say why the upgrade is rolled back (at least 10 characters).');
  const ep = episode(db);
  const why = rollbackBlock(db, ep);
  if (why) throw new Error(why);
  // the roll-back switches the signing key back to a process key: refused, and recorded, while a chain incident or a
  // key compromise is open or a successor is bound (mock/keys.ts)
  assertKeyChangeAllowed(orgId, userId, 'roll back the upgrade (the signing key changes with it)');
  const up = firstOf(ep!.rs, (r) => r.action === 'level.upgraded' && r.details?.to === 'l2')!;
  const signing = signingOf(db, ep!);
  const kmsKey = db.keys[db.keys.length - 1].key;
  const rot = rotateKey(orgId, userId, 'Upgrade to L2 Attested rolled back: sealing returns to an Elan1 Govern process key', `k_${short(db)}_env`);
  const firstSeq = signing?.seq ?? up.seq;
  const islandRecords = db.receipts.filter((r) => r.seq >= firstSeq && r.seq <= rot.seq && r.kid === kmsKey.kid).length;
  const hist = db.org.levelHistory ?? [];
  const at = hist.findIndex((h) => h.level === 'l2' && (h.seq === up.seq || h.from === up.ts));
  db.org.levelHistory = at >= 0 ? [...hist.slice(0, at), ...hist.slice(at + 1)] : hist.filter((h, i) => !(i === hist.length - 1 && h.level === 'l2'));
  if (!db.org.levelHistory.length) db.org.levelHistory = [{ level: 'l1', from: db.org.createdAt }];
  db.org.plan = 'l1';
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_rolled_back', details: {
    from: 'l2', to: 'l1', upgrade_seq: up.seq, island_first_seq: firstSeq, island_last_seq: rot.seq, island_records: islandRecords, island_kid: kmsKey.kid, island_fingerprint: kmsKey.fingerprint,
    new_kid: rot.kid, reason: reason.trim().slice(0, 300),
  } });
  // notices still waiting are withdrawn with the upgrade
  for (const n of noticesOf(db, ep!)) if (n.status === 'scheduled') append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_notice_cancelled', details: { to: 'l2', notice: n.id, kind: n.kind, to_name: n.toName, reason: 'upgrade rolled back' } });
  deriveBilling(db);
  syncOrgMeta(db.org);
  persistLevels(db.org);
  touch(orgId, 'level');
  return { seq: r.seq, islandFirst: firstSeq, islandLast: rot.seq, islandRecords, kid: kmsKey.kid };
}

/* ── The view ─────────────────────────────────────────────────── */

function islandsOf(db: OrgDB): IslandView[] {
  const rs = db.receipts;
  return rs.filter(isIslandRollback).map((r) => {
    const kid = s(r, 'island_kid') ?? '';
    const at = rs.indexOf(r);
    // a seeded rollback names the island by its key: the switch, the first signed record and the key handover back
    // to a process key are read from the receipts before it
    const before = rs.slice(0, at);
    const up = num(r, 'upgrade_seq') ?? lastOf(before, (x) => x.action === 'level.upgraded' && x.details?.to === 'l2')?.seq ?? 0;
    const on = lastOf(before, (x) => x.action === 'level.signing_on' && x.seq > up);
    const firstSeq = num(r, 'island_first_seq') ?? on?.seq ?? firstOf(before, (x) => x.seq > up && x.kid === kid)?.seq ?? 0;
    const lastSeq = num(r, 'island_last_seq') ?? lastOf(before, (x) => x.action === 'key.rotated' && x.details?.old_kid === kid)?.seq ?? before[before.length - 1]?.seq ?? 0;
    const records = num(r, 'island_records') ?? before.filter((x) => x.seq >= firstSeq && x.seq <= lastSeq && x.kid === kid).length;
    return { seq: r.seq, at: r.ts, by: r.actor ?? '', reason: s(r, 'reason') ?? '', firstSeq, lastSeq, records, kid, fingerprint: s(r, 'island_fingerprint') ?? '', upgradeSeq: up };
  });
}

/** Everything the close-out screens show. Sends any notice whose time has come before reading. */
export function closeoutView(orgId: string, batches?: AnchorLike): CloseoutView {
  const db = getDB(orgId);
  if (dispatchDue(db)) touch(orgId, 'level');
  const level = levelOfOrg(db.org);
  const ep = episode(db);
  const islands = islandsOf(db);
  const base = { orgId, orgName: db.org.name, slug: db.org.slug, level, islands, nextSigningSeq: nextSigningSeq(db), recordsNow: db.receipts.length, anchoring: { state: 'waiting' as CheckState, detail: '' }, firstTen: { rows: [] as FirstTenRow[] }, notices: [] as UpgradeNotice[], checks: [] as CloseCheck[] };
  if (!ep) return { ...base, phase: 'none', canRollBack: false, whyNoRollback: 'There is no switched upgrade to roll back.' };

  const rs = ep.rs;
  const created = rs.filter((r) => r.action === 'level.upgrade_key_created');
  const lastCreated = created[created.length - 1];
  const up = firstOf(rs, (r) => r.action === 'level.upgraded' && r.details?.to === 'l2');
  const compared = lastOf(rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'kms' && r.details?.fingerprint_compared === 'match' && (!lastCreated || r.details?.kid === lastCreated.details?.kid));
  const pre = lastOf(rs, (r) => r.action === 'level.upgrade_stage' && r.details?.stage === 'preflight');
  const signing = signingOf(db, ep);
  const closed = firstOf(rs, (r) => r.action === 'level.upgrade_closed');
  const rolled = up ? islands.find((i) => i.upgradeSeq === up.seq) : undefined;
  const ten = lastOf(rs, (r) => r.action === 'level.upgrade_first_ten_checked');
  const bundle = lastOf(rs, (r) => r.action === 'level.upgrade_first_bundle');
  const { kid, fingerprint } = boundFingerprint(ep, signing);
  const cut = signing?.seq ?? up?.seq;
  const before = cut !== undefined ? db.receipts.filter((r) => r.seq < cut).length : 0;
  const oob = outOfBandFor(db);
  const why = rollbackBlock(db, ep);

  return {
    ...base,
    phase: rolled ? 'rolled_back' : closed ? 'closed' : up ? 'switched' : 'preparing',
    run: { seq: ep.start.seq, at: ep.start.ts, by: ep.start.actor ?? '' },
    key: lastCreated || compared ? {
      kid: s(compared, 'kid') ?? s(lastCreated, 'kid') ?? '', fingerprint: s(compared, 'fingerprint') ?? s(lastCreated, 'fingerprint') ?? '', alias: s(lastCreated, 'alias') ?? s(compared, 'alias') ?? aliasFor(db),
      keyRef: s(lastCreated, 'key_ref') ?? arnFor(s(compared, 'kid') ?? ''), region: 'ap-south-1', createdSeq: lastCreated?.seq ?? compared!.seq, createdAt: lastCreated?.ts ?? compared!.ts, createdBy: lastCreated?.actor ?? compared?.actor ?? '',
      comparedSeq: compared?.seq, comparedAt: compared?.ts, comparedBy: compared?.actor, channel: s(compared, 'channel'), replaced: Math.max(0, created.length - 1),
      mismatches: rs.filter((r) => r.action === 'level.upgrade_fingerprint_mismatch' && (!lastCreated || r.details?.kid === lastCreated.details?.kid)).length,
    } : undefined,
    outOfBand: lastCreated ? { ...oob, sentAt: lastCreated.ts } : undefined,
    preflight: pre ? { seq: pre.seq, at: pre.ts, ok: s(pre, 'result') === 'verified', detail: `${num(pre, 'receipts')?.toLocaleString('en-IN') ?? 'All'} records` } : undefined,
    upgrade: up ? { seq: up.seq, at: up.ts, by: up.actor ?? '' } : undefined,
    boundary: up ? { at: up.ts, recordsBefore: before, recordsAfter: db.receipts.length - before } : undefined,
    signing: signing ? { seq: signing.seq, at: signing.ts, kid: signing.kid, fingerprint: s(signing, 'fingerprint') ?? fingerprint ?? '', namedSeq: num(signing, 'named_seq'), leadDays: num(signing, 'notice_lead_days'), earlyAgreed: s(signing, 'early_agreed') === 'true' } : undefined,
    firstTen: { rows: signing ? firstTenRows(db, signing.seq, kid, fingerprint) : [], recorded: ten ? { seq: ten.seq, at: ten.ts, by: ten.actor ?? '', result: s(ten, 'result') ?? '' } : undefined },
    firstBundle: bundle ? {
      seq: bundle.seq, at: bundle.ts, by: bundle.actor ?? '', exitCode: num(bundle, 'exit_code') ?? -1, code: s(bundle, 'code') ?? '', tamperedExitCode: num(bundle, 'tampered_exit_code') ?? -1, tamperedCode: s(bundle, 'tampered_code') ?? '',
      tamperedSeq: num(bundle, 'tampered_seq'), tamperedField: s(bundle, 'tampered_field'), receipts: num(bundle, 'receipts'),
    } : undefined,
    anchoring: anchoringOf(signing, batches),
    notices: noticesOf(db, ep),
    checks: up ? checksFor(db, ep, batches) : [],
    closed: closed ? { seq: closed.seq, at: closed.ts, by: closed.actor ?? '', checks: s(closed, 'checks') ?? '' } : undefined,
    rolledBack: rolled,
    canRollBack: !why,
    whyNoRollback: why,
  };
}

/** Who a notice usually goes to: a named contact (an owner other than the person who started) and the auditor. */
export function suggestedContacts(orgId: string) {
  const db = getDB(orgId);
  const people = db.members.filter((m) => m.status === 'active').map((m) => ({ id: m.userId, role: m.role, user: userById(m.userId) })).filter((p) => p.user);
  return people.map((p) => ({ id: p.id, name: userName(p.id), email: p.user!.email, role: p.role === 'auditor' ? `Auditor · ${p.user!.title}` : p.user!.title, isAuditor: p.role === 'auditor', isOwner: p.role === 'owner' }));
}
