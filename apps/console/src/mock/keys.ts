/**
 * Keys and custody — the parts of the signing-key lifecycle beyond a plain rotation:
 *
 *  · key compromise (L2+): declare → signing stops (an interim Elan1 Govern chain key seals the records, hash-chained
 *    but not signed with the organisation's key) → 24-hour notice to the named contact → bind a new key
 *    ("Key bound · signing off") → signing on (a second owner or admin at L2) → close, with the unsigned interval recorded;
 *  · key windows: a successor key published ahead of signing (the overlap), revoked keys, and the rule that no key
 *    changes while a chain incident is open;
 *  · KMS Sign-call reconciliation (L2; the HSM audit log at L3 and Sovereign);
 *  · the fingerprint published out of band (DNS TXT, printed page) and recorded;
 *  · the auditor's evidence request, a recorded write both ways.
 *
 * State lives on the organisation's database as `keysExt` (saved with it; every field defaulted on read, so state
 * saved before this module existed loads). Every change a person makes is a receipt.
 */
import type { CustodyMode, KeyCeremony, LevelId, Receipt, SigningKey } from '@/types';
import * as db from './db';
import type { OrgDB } from './db';
import { custodyView, pendingRotationRequest } from './platform';
import { atLeast, levelAt, levelOfOrg } from '@/lib/levels';
import { keyFromSeed, type KeyPair } from '@/lib/crypto';
import { dateTime } from '@/lib/format';
import { bundleDigest, type EvidenceBundle, type UnsignedIntervalManifest } from '@/lib/verify6';
import { ORGS, personFor, userById, userName } from './users';
import { DECCAN_BOUND, KAVERI_COMPROMISE } from './keysSeed';

const H = 3_600_000;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const wait = (min = 90, max = 240) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const SEEDED = ['org_demo', 'org_northbank', 'org_kaveri', 'org_deccan'];

/* ── Types ─────────────────────────────────────────────────────────────── */

export interface KeyContact {
  name: string;
  email: string;
  role: string;
  phone?: string;
  setBy?: string;
  setAt?: string;
  seq?: number;
}

export type CompromisePhase = 'signing_off' | 'key_bound' | 'signing_on' | 'closed';

export interface KeyCompromise {
  id: string;
  kid: string;
  fingerprint: string;
  reason: string;
  source: 'manual' | 'reconciliation';
  discrepancyId?: string;
  suspectedSince?: string;
  declaredAt: string;
  declaredBy: string;
  /** key.compromise.declared */
  declSeq: number;
  /** the key.rotated receipt that stopped signing: the first receipt of the unsigned interval */
  unsignedFrom: number;
  interimKid: string;
  noticeDueAt: string;
  contact: KeyContact;
  notice?: { at: string; by: string; seq: number; to: string; cc?: string; late: boolean };
  successor?: { kid: string; fingerprint: string; boundAt: string; boundBy: string; seq: number; holders?: string[] };
  signingOn?: { at: string; by: string; seq: number };
  /** last receipt sealed by the interim key (set when signing comes back on) */
  unsignedTo?: number;
  closed?: { at: string; by: string; seq: number; note: string };
}

/** A key published and bound ahead of signing: "Key bound · signing off". */
export interface BoundKey {
  kid: string;
  fingerprint: string;
  publicKeyHex: string;
  seed: string;
  boundAt: string;
  boundBy: string;
  seq: number;
  reason: string;
  purpose: 'planned' | 'compromise';
  compromiseId?: string;
  holders?: string[];
  /** planned rotations: when signing is meant to switch (the end of the overlap) */
  switchAt?: string;
  /**
   * L2 dual control: the second owner or admin behind this successor — the one who asked for the KMS rotation that
   * an approver bound, or the one who confirmed a successor another person published. Without one, an L2 successor
   * does not switch on its own. Optional: state saved before it existed reads it back from the chain (confirmationOf).
   */
  confirmedBy?: string;
  confirmedAt?: string;
  confirmedSeq?: number;
}

export interface SignDiscrepancy {
  id: string;
  day: string; // yyyy-mm-dd (IST)
  /** Sign calls in the key-use log minus signatures in the chain: positive means a use with no record. */
  delta: number;
  principal: string;
  detail: string;
  status: 'open' | 'explained' | 'escalated';
  by?: string;
  at?: string;
  note?: string;
  seq?: number;
  compromiseId?: string;
}

export interface ReconciliationRun { at: string; by: string; seq?: number; days: number; calls: number; signed: number; open: number }

export type PublishChannel = 'dns' | 'print' | 'website' | 'letter';
export interface FingerprintPublication { id: string; channel: PublishChannel; kid: string; fingerprint: string; where: string; at: string; by: string; seq?: number }

export type EvidenceRequestStatus = 'open' | 'fulfilled' | 'received' | 'declined' | 'withdrawn';
export interface EvidenceRequest {
  id: string;
  requestedBy: string;
  requestedAt: string;
  seq?: number;
  purpose: string;
  fromSeq: number;
  toSeq: number;
  fromDate?: string;
  toDate?: string;
  format: 'auditor-pack/1' | 'elan1.evidence.bundle.v1';
  dueBy: string;
  status: EvidenceRequestStatus;
  /** `exportIds`: every part of the export that was sent (one for a single file); optional, saved state may predate it */
  fulfilled?: { by: string; at: string; seq: number; exportId: string; receipts: number; exportSeq?: number; exportIds?: string[]; digests?: string[] };
  received?: { at: string; seq: number };
  declined?: { by: string; at: string; seq: number; reason: string };
  withdrawn?: { at: string; seq: number };
  /** (view only) whether this console still holds receipts in the range, so a copy can be built again */
  held?: boolean;
}

export interface KeyChangeRefusal { at: string; by: string; what: string; incident: string; seq: number }

interface KeysExt {
  v: 1;
  contact?: KeyContact;
  compromises: KeyCompromise[];
  bound?: BoundKey;
  interimKids: string[];
  discrepancies: SignDiscrepancy[];
  runs: ReconciliationRun[];
  publications: FingerprintPublication[];
  requests: EvidenceRequest[];
  refusals: KeyChangeRefusal[];
  /** seeded open requests still to be written to the chain (done on the first asynchronous read) */
  pendingSeedRequests?: boolean;
}

type ExtDB = OrgDB & { keysExt?: KeysExt };

/* ── State ─────────────────────────────────────────────────────────────── */

const dayKey = (t: number) => new Date(t + 5.5 * H).toISOString().slice(0, 10);
const shortOf = (d: OrgDB) => d.org.slug.split('-')[0].slice(0, 6);
const randId = (p: string) => `${p}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

function ext(orgId: string): KeysExt {
  const d = db.getDB(orgId) as ExtDB;
  if (!d.keysExt) {
    d.keysExt = seed(d);
  }
  const x = d.keysExt;
  x.compromises ??= [];
  x.interimKids ??= [];
  x.discrepancies ??= [];
  x.runs ??= [];
  x.publications ??= [];
  x.requests ??= [];
  x.refusals ??= [];
  return x;
}

/** Seed what each demo organisation shows: a named contact, published fingerprints, key windows, reconciliation, requests. */
function seed(d: OrgDB): KeysExt {
  const orgId = d.org.id;
  const level = levelOfOrg(d.org);
  const x: KeysExt = { v: 1, compromises: [], interimKids: [], discrepancies: [], runs: [], publications: [], requests: [], refusals: [] };
  const admin = userById(personFor(orgId, 'u_rahul')) ?? userById(personFor(orgId, 'u_ananya'));
  if (admin && admin.orgIds.includes(orgId)) x.contact = { name: admin.name, email: admin.email, role: `${admin.title} · security contact for key notices`, phone: admin.phone };
  if (!SEEDED.includes(orgId)) return x;

  const now = Date.now();
  const history = d.org.levelHistory;
  // key windows: from L2 a successor is published 30 days before it signs (L1 rotations take effect at once)
  d.signingKeys.forEach((k, i) => {
    if (k.publishedAt) return;
    const start = new Date(k.createdAt).getTime();
    const prev = d.signingKeys[i - 1];
    const ahead = i > 0 && atLeast(levelAt(history, start), 'l2') ? 30 * D : 0;
    k.publishedAt = iso(Math.max(prev ? new Date(prev.createdAt).getTime() + H : start, start - ahead));
  });

  const owner = personFor(orgId, 'u_ananya');
  const active = d.signingKeys.find((k) => k.status === 'active');
  if (active && atLeast(level, 'l2')) {
    const host = `_elan1-govern.${d.org.domain ?? `${d.org.slug}.example`}`;
    x.publications.push({ id: 'pub_seed_dns', channel: 'dns', kid: active.kid, fingerprint: active.fingerprint, where: host, at: iso(Math.max(new Date(active.createdAt).getTime() + 2 * H, now - 40 * D)), by: owner });
  }
  if (active && atLeast(level, 'l3')) {
    x.publications.push({ id: 'pub_seed_print', channel: 'print', kid: active.kid, fingerprint: active.fingerprint, where: 'Signed copy filed with the key ceremony minutes; one copy to the auditor of record', at: iso(Math.max(new Date(active.createdAt).getTime() + 4 * H, now - 29 * D)), by: owner });
  }

  // reconciliation history (L2 and above): the last nightly run, and Northbank's flagged days
  if (atLeast(level, 'l2')) {
    if (orgId === 'org_northbank') {
      const ops = 'arn:aws:iam::441723908815:role/elan1-ops-breakglass';
      x.discrepancies.push({ id: 'dsc_seed_open', day: dayKey(now - 3 * D), delta: 2, principal: ops, detail: '2 Sign calls on the signing key in CloudTrail with no receipt or checkpoint signed in the same minute (02:41 and 02:43 IST).', status: 'open' });
      x.discrepancies.push({ id: 'dsc_seed_explained', day: dayKey(now - 9 * D), delta: 1, principal: 'arn:aws:iam::441723908815:role/elan1-signer', detail: '1 Sign call in CloudTrail with no matching signature in the chain.', status: 'explained', by: personFor(orgId, 'u_rahul'), at: iso(now - 8 * D), note: 'The signer retried after a KMS throttling error; the first call returned no signature. CloudTrail shows ThrottlingException on the first call.' });
    }
    const t = new Date(dayKey(now) + 'T02:00:00+05:30').getTime();
    x.runs.push({ at: iso(t <= now ? t : t - D), by: 'system', days: 14, calls: 0, signed: 0, open: x.discrepancies.filter((q) => q.status === 'open').length });
  }

  // auditor requests: one fulfilled from before (the export 30 days ago), one open (written to the chain on first read)
  const exp2 = d.exports.find((e) => e.id === 'exp_2');
  if (exp2) {
    x.requests.push({
      id: 'evr_seed_q2', requestedBy: 'u_kavita', requestedAt: iso(new Date(exp2.ts).getTime() - 2 * D), purpose: 'Interim audit: first-half sample of governed actions',
      fromSeq: exp2.firstSeq, toSeq: exp2.lastSeq, format: 'auditor-pack/1', dueBy: iso(new Date(exp2.ts).getTime() + 3 * D), status: 'received',
      fulfilled: { by: exp2.by, at: exp2.ts, seq: 0, exportId: exp2.id, receipts: exp2.receipts }, received: { at: iso(new Date(exp2.ts).getTime() + 3 * H), seq: 0 },
    });
  }
  seedKeyHistory(d, x);
  x.pendingSeedRequests = true;
  return x;
}

/**
 * Read the seeded key history back from the chain (mock/keysSeed.ts writes its receipts): refused key changes,
 * Kaveri's closed compromise with its unsigned interval, and Deccan's bound successor. Each part is skipped when its
 * receipts are not in the chain (state saved before the seed existed).
 */
function seedKeyHistory(d: OrgDB, x: KeysExt) {
  const rs = d.receipts;
  // refusals already on the chain
  for (let i = rs.length - 1; i >= 0 && x.refusals.length < 6; i--) {
    const r = rs[i];
    if (r.action !== 'key.change_refused') continue;
    x.refusals.push({ at: r.ts, by: r.actor ?? 'system', what: String(r.details?.what ?? 'change a key'), incident: String(r.details?.incident ?? ''), seq: r.seq });
  }
  if (d.org.id === 'org_kaveri') {
    const c = KAVERI_COMPROMISE;
    const find = (pred: (r: Receipt) => boolean) => rs.find(pred);
    const stop = find((r) => r.action === 'key.rotated' && r.details?.new_kid === c.interimKid);
    const decl = find((r) => r.action === 'key.compromise.declared' && r.details?.compromise === c.id);
    const notice = find((r) => r.action === 'key.compromise.notice_sent' && r.details?.compromise === c.id);
    const bound = find((r) => r.action === 'key.bound' && r.details?.kid === c.newKid);
    const on = find((r) => r.action === 'key.rotated' && r.details?.new_kid === c.newKid);
    const closed = find((r) => r.action === 'key.compromise.closed' && r.details?.compromise === c.id);
    const lastInterim = [...rs].reverse().find((r) => r.kid === c.interimKid);
    const revoked = d.signingKeys.find((k) => k.kid === c.revokedKid);
    const interim = d.signingKeys.find((k) => k.kid === c.interimKid);
    const next = d.signingKeys.find((k) => k.kid === c.newKid);
    if (stop && decl && notice && bound && on && closed && revoked && interim && next) {
      revoked.status = 'revoked';
      revoked.revokedAt = stop.ts;
      revoked.revokedReason = c.reason;
      interim.interim = true;
      next.publishedAt = bound.ts;
      x.interimKids.push(c.interimKid);
      x.compromises.push({
        id: c.id, kid: c.revokedKid, fingerprint: revoked.fingerprint, reason: c.reason, source: 'manual', suspectedSince: String(decl.details?.suspected_since ?? ''),
        declaredAt: decl.ts, declaredBy: decl.actor ?? 'system', declSeq: decl.seq, unsignedFrom: stop.seq, interimKid: c.interimKid,
        noticeDueAt: iso(new Date(decl.ts).getTime() + 24 * H),
        contact: x.contact ? clone(x.contact) : { name: 'Security contact', email: String(notice.details?.to ?? ''), role: 'Security contact for key notices' },
        notice: { at: notice.ts, by: notice.actor ?? 'system', seq: notice.seq, to: String(notice.details?.to ?? ''), cc: notice.details?.cc ? String(notice.details.cc) : undefined, late: false },
        successor: { kid: c.newKid, fingerprint: next.fingerprint, boundAt: bound.ts, boundBy: bound.actor ?? 'system', seq: bound.seq },
        signingOn: { at: on.ts, by: on.actor ?? 'system', seq: on.seq },
        unsignedTo: Math.max(stop.seq, lastInterim?.seq ?? stop.seq),
        closed: { at: closed.ts, by: closed.actor ?? 'system', seq: closed.seq, note: String(closed.details?.note ?? '') },
      });
    }
  }
  if (d.org.id === 'org_deccan') {
    const b = DECCAN_BOUND;
    const r = rs.find((y) => y.action === 'key.bound' && y.details?.kid === b.kid);
    const signedSince = rs.some((y) => y.action === 'key.rotated' && y.seq > (r?.seq ?? Infinity));
    if (r && !signedSince && !d.signingKeys.some((k) => k.kid === b.kid)) {
      const k = keyFromSeed(b.seed, b.kid);
      d.publicKeys[b.kid] = k.publicKeyHex;
      d.signingKeys.push({ kid: b.kid, fingerprint: k.fingerprint, algorithm: 'Ed25519', status: 'bound', createdAt: r.ts, publishedAt: r.ts, receiptsSigned: 0 });
      const holders = d.platform?.ceremonies?.[0]?.participants?.map((p) => p.name).slice(0, 3);
      x.bound = { kid: b.kid, fingerprint: k.fingerprint, publicKeyHex: k.publicKeyHex, seed: b.seed, boundAt: r.ts, boundBy: r.actor ?? 'system', seq: r.seq, reason: b.reason, purpose: 'planned', holders: holders?.length ? holders : undefined, switchAt: String(r.details?.switch_at ?? iso(new Date(r.ts).getTime() + b.overlapDays * D)) };
    }
  }
}

/** Write the seeded open request to the chain (asynchronous reads only — never during a render). */
function settleSeeds(orgId: string) {
  const x = ext(orgId);
  if (!x.pendingSeedRequests) return;
  x.pendingSeedRequests = false;
  const d = db.getDB(orgId);
  const rs = d.receipts;
  const level = levelOfOrg(d.org);
  if (!rs.length || !d.members.some((m) => m.userId === 'u_kavita' && m.status === 'active')) { db.persist(orgId); return; }
  const from = rs.find((r) => new Date(r.ts).getTime() >= Date.now() - 30 * D) ?? rs[0];
  const to = rs[rs.length - 1];
  const r = db.append(d, { kind: 'admin', actor: 'u_kavita', action: 'evidence.requested', details: { request: 'evr_seed_open', from_seq: from.seq, to_seq: to.seq, format: atLeast(level, 'l2') ? 'elan1.evidence.bundle.v1' : 'auditor-pack/1', purpose: 'Quarterly review: the last 30 days of governed actions' } });
  x.requests.unshift({
    id: 'evr_seed_open', requestedBy: 'u_kavita', requestedAt: r.ts, seq: r.seq, purpose: 'Quarterly review: the last 30 days of governed actions',
    fromSeq: from.seq, toSeq: to.seq, fromDate: from.ts, toDate: to.ts, format: atLeast(level, 'l2') ? 'elan1.evidence.bundle.v1' : 'auditor-pack/1', dueBy: iso(Date.now() + 5 * D), status: 'open',
  });
}

/* ── Guards ────────────────────────────────────────────────────────────── */

const CHAIN_SUBKINDS = ['chain_break', 'receipt_write'];

/** An open incident on the chain itself (an integrity break or a receipt-write failure). Key changes wait for it. */
export function openChainIncident(orgId: string): { id: string; title: string } | undefined {
  const d = db.peekDB(orgId) ?? db.getDB(orgId);
  const inc = d.incidents.find((i) => i.status === 'active' && CHAIN_SUBKINDS.includes(String((i as { subkind?: string }).subkind ?? '')));
  return inc ? { id: inc.id, title: inc.title } : undefined;
}

/** The open key compromise, if one is being handled. */
export function openCompromise(orgId: string): KeyCompromise | undefined {
  const d = db.peekDB(orgId) as ExtDB | undefined;
  const x = d?.keysExt;
  return x?.compromises?.find((c) => !c.closed);
}

/**
 * Which flow a key change belongs to: `'compromise'` lets the compromise procedure's own steps through an open
 * compromise; `'bound'` lets the switch to (or withdrawal of) a bound successor through. `true` is `'compromise'`.
 */
export type KeyChangeStep = 'compromise' | 'bound';

/** The successor bound and waiting to sign, if one is. */
export function boundSuccessor(orgId: string): Omit<BoundKey, 'seed'> | undefined {
  const b = ext(orgId).bound;
  if (!b) return undefined;
  const { seed: _s, ...rest } = b;
  return rest;
}

/** Why a key change is refused now, or undefined when it may go ahead. */
export function keyChangeBlock(orgId: string, step?: KeyChangeStep | boolean): string | undefined {
  const s: KeyChangeStep | undefined = step === true ? 'compromise' : step || undefined;
  const inc = openChainIncident(orgId);
  if (inc) return `A chain incident is open (${inc.title}). Key changes are refused until it is resolved, so the break can be located against the keys as they were.`;
  if (s !== 'compromise' && openCompromise(orgId)) return 'A key compromise is being handled. Finish it — bind a new key, turn signing on and close it — before any other key change.';
  const b = s ? undefined : boundSuccessor(orgId);
  if (b) return `Key ${b.kid} is bound and waiting to sign${b.switchAt ? ` (the switch is planned for ${dateTime(b.switchAt)})` : ''}. Turn signing on with it, or withdraw it, before any other key change — otherwise a rotation would sign with one key while another sits bound.`;
  return undefined;
}

/**
 * Refuse a key change, recorded: the refusal is a receipt. Call before any rotation, ceremony, binding, switch or
 * level change. Never refuses a compromise declaration — stopping a compromised key is always allowed.
 */
export function assertKeyChangeAllowed(orgId: string, userId: string, what: string, step?: KeyChangeStep | boolean) {
  const why = keyChangeBlock(orgId, step);
  if (!why) return;
  const inc = openChainIncident(orgId);
  const comp = inc ? undefined : openCompromise(orgId);
  const bound = inc || comp ? undefined : ext(orgId).bound;
  const incident = inc?.id ?? comp?.id ?? bound?.kid ?? '';
  const reason = inc ? 'chain incident is open' : comp ? 'key compromise is being handled' : 'successor key is bound and waiting to sign';
  const r = db.logAdmin(orgId, userId, 'key.change_refused', { what, incident, reason });
  ext(orgId).refusals.unshift({ at: r.ts, by: userId, what, incident, seq: r.seq });
  db.touch(orgId, 'key');
  throw new Error(`${why} The attempt is recorded as receipt #${r.seq}.`);
}

function requireOwnerOrAdmin(orgId: string, userId: string, what: string) {
  const role = db.memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what} — owners and admins can do this; your role cannot.`);
}

/* ── Signing switch (the mechanics behind rotation, compromise and binding) ── */

function newKey(d: OrgDB, tag: string): { key: KeyPair; seed: string } {
  const n = d.keys.length + 1;
  const seed = `${d.org.id}:key:${tag}:${n}:${Date.now()}`;
  const kid = `k_${shortOf(d)}_${tag}_${new Date().toISOString().slice(2, 7).replace('-', '')}_${n}`;
  return { key: keyFromSeed(seed, kid), seed };
}

/**
 * Switch the key that signs the chain. `signWith: 'old'` is an ordinary rotation (the outgoing key signs the
 * key.rotated receipt that names its successor); `'new'` is a compromise (the compromised key signs nothing more).
 */
function switchSigning(d: OrgDB, next: { key: KeyPair; seed: string }, userId: string, reason: string, opts: { signWith: 'old' | 'new'; oldStatus: 'retired' | 'revoked'; interim?: boolean; revokedReason?: string; details?: Record<string, string | number | boolean> }): Receipt {
  const old = d.keys[d.keys.length - 1].key;
  const now = Date.now();
  const nowIso = iso(now);
  const write = () => db.append(d, { kind: 'admin', actor: userId, action: 'key.rotated', details: { old_kid: old.kid, new_kid: next.key.kid, reason, ...(opts.details ?? {}) } });
  let r: Receipt | undefined;
  if (opts.signWith === 'old') r = write();
  d.keySeeds.push({ seed: next.seed, kid: next.key.kid, from: now });
  d.keys.push({ key: next.key, from: now });
  d.publicKeys[next.key.kid] = next.key.publicKeyHex;
  for (const s of d.signingKeys) {
    if (s.status !== 'active') continue;
    s.status = opts.oldStatus;
    s.retiredAt = nowIso;
    if (opts.oldStatus === 'revoked') { s.revokedAt = nowIso; s.revokedReason = opts.revokedReason; }
  }
  const entry = d.signingKeys.find((s) => s.kid === next.key.kid);
  if (entry) { entry.status = 'active'; entry.createdAt = nowIso; entry.publishedAt ??= nowIso; }
  else d.signingKeys.push({ kid: next.key.kid, fingerprint: next.key.fingerprint, algorithm: 'Ed25519', status: 'active', createdAt: nowIso, receiptsSigned: 0, publishedAt: nowIso, interim: opts.interim || undefined });
  if (opts.signWith === 'new') r = write();
  d.org.keyFingerprint = next.key.fingerprint;
  db.syncOrgMeta(d.org);
  // ordinary rotation: the outgoing key signed the handover, so the incoming key signs one record at once and the
  // newest record is always signed by the organisation's current key (a bundle pinned to it passes straight away)
  if (opts.signWith === 'old') db.append(d, { kind: 'admin', actor: 'system', action: 'key.signing_started', details: { kid: next.key.kid, fingerprint: next.key.fingerprint, rotated_seq: r!.seq } });
  return r!;
}

/* ── Compromise ────────────────────────────────────────────────────────── */

export function compromisePhase(c: KeyCompromise): CompromisePhase {
  if (c.closed) return 'closed';
  if (c.signingOn) return 'signing_on';
  if (c.successor) return 'key_bound';
  return 'signing_off';
}

function declareCompromise(orgId: string, userId: string, input: { reason: string; suspectedSince?: string; discrepancyId?: string }): KeyCompromise {
  requireOwnerOrAdmin(orgId, userId, 'Declaring a key compromise');
  const d = db.getDB(orgId);
  if (!atLeast(levelOfOrg(d.org), 'l2')) throw new Error('The key-compromise procedure starts at L2, where the key is held in AWS KMS or your HSM.');
  const x = ext(orgId);
  if (openCompromise(orgId)) throw new Error('A key compromise is already being handled.');
  if (input.reason.trim().length < 8) throw new Error('Say what happened in a few words.');
  if (!x.contact) throw new Error('Name a contact for key notices first.');
  const current = d.signingKeys.find((k) => k.status === 'active');
  if (!current) throw new Error('There is no signing key to stop.');
  // stop signing: from now the records are sealed in the hash chain by Elan1 Govern's interim chain key
  if (x.bound) { // a planned successor bound before the compromise is withdrawn: it was bound while the key may have been in other hands
    const b = d.signingKeys.find((k) => k.kid === x.bound!.kid && k.status === 'bound');
    if (b) { b.status = 'revoked'; b.revokedAt = iso(Date.now()); b.revokedReason = 'Withdrawn: bound before a declared key compromise'; }
    x.bound = undefined;
  }
  const interim = newKey(d, 'hc');
  const id = randId('kcmp');
  const rot = switchSigning(d, interim, userId, 'Signing stopped: key compromise declared', { signWith: 'new', oldStatus: 'revoked', interim: true, revokedReason: input.reason.trim(), details: { compromise: id, signing: 'off' } });
  x.interimKids.push(interim.key.kid);
  const decl = db.append(d, { kind: 'admin', actor: userId, action: 'key.compromise.declared', details: { compromise: id, kid: current.kid, fingerprint: current.fingerprint, reason: input.reason.trim(), ...(input.suspectedSince ? { suspected_since: input.suspectedSince } : {}), interim_kid: interim.key.kid, notice_due: iso(Date.now() + 24 * H), contact: x.contact.email } });
  const c: KeyCompromise = {
    id, kid: current.kid, fingerprint: current.fingerprint, reason: input.reason.trim(), source: input.discrepancyId ? 'reconciliation' : 'manual', discrepancyId: input.discrepancyId,
    suspectedSince: input.suspectedSince, declaredAt: decl.ts, declaredBy: userId, declSeq: decl.seq, unsignedFrom: rot.seq, interimKid: interim.key.kid,
    noticeDueAt: iso(new Date(decl.ts).getTime() + 24 * H), contact: clone(x.contact),
  };
  x.compromises.unshift(c);
  if (input.discrepancyId) {
    const q = x.discrepancies.find((y) => y.id === input.discrepancyId);
    if (q) { q.status = 'escalated'; q.compromiseId = id; q.by = userId; q.at = decl.ts; q.seq = decl.seq; q.note = 'Declared a key compromise from this discrepancy.'; }
  }
  db.touch(orgId, 'key');
  return clone(c);
}

/** The notice the named contact receives: what happened, which key, from when records are unsigned, what to do. */
export function noticeText(orgName: string, c: KeyCompromise): { subject: string; body: string } {
  return {
    subject: `Key compromise notice — ${orgName} signing key ${c.kid}`,
    body: `${orgName} declared its signing key ${c.kid} (fingerprint ${c.fingerprint}) compromised at ${dateTime(c.declaredAt)}. Reason: ${c.reason}. `
      + `The key is revoked and signs nothing more. From receipt #${c.unsignedFrom} records are still written and linked into the hash chain but are not signed until a new key is bound and signing is turned on. `
      + `Receipts signed before #${c.unsignedFrom} still verify with the published public key. Do not accept anything signed by ${c.kid} after the declaration. The new fingerprint will follow in a second notice.`,
  };
}

function sendNotice(orgId: string, userId: string, id: string, cc?: string) {
  requireOwnerOrAdmin(orgId, userId, 'Sending the key-compromise notice');
  const x = ext(orgId);
  const c = x.compromises.find((y) => y.id === id);
  if (!c) throw new Error('There is no such key compromise.');
  if (c.notice) throw new Error('The notice has already been sent.');
  // a copy goes only to this organisation's own auditor of record, never to anyone else
  if (cc && cc !== auditorOfRecord(orgId)?.email) throw new Error('A copy can go only to this organisation’s auditor of record.');
  const late =Date.now() > new Date(c.noticeDueAt).getTime();
  const r = db.logAdmin(orgId, userId, 'key.compromise.notice_sent', { compromise: id, to: c.contact.email, ...(cc ? { cc } : {}), due: c.noticeDueAt, within_24h: !late });
  c.notice = { at: r.ts, by: userId, seq: r.seq, to: c.contact.email, cc, late };
  db.touch(orgId, 'key');
  return clone(c);
}

function bindKey(orgId: string, userId: string, input: { reason: string; purpose: 'planned' | 'compromise'; holders?: string[]; overlapDays?: number; /** internal: the second person of an approved KMS rotation */ confirmed?: { by: string; at: string; seq: number } }): BoundKey {
  requireOwnerOrAdmin(orgId, userId, 'Binding a new signing key');
  const d = db.getDB(orgId);
  const level = levelOfOrg(d.org);
  const x = ext(orgId);
  const c = openCompromise(orgId);
  if (input.purpose === 'compromise' && !c) throw new Error('There is no open key compromise.');
  if (input.purpose === 'planned' && !atLeast(level, 'l2')) throw new Error('Publishing a successor ahead of signing starts at L2. At L1 the key rotates at once.');
  assertKeyChangeAllowed(orgId, userId, input.purpose === 'compromise' ? 'bind a replacement key' : 'bind a successor key', input.purpose === 'compromise');
  if (x.bound) throw new Error(`Key ${x.bound.kid} is already bound and waiting for signing to be turned on.`);
  if (atLeast(level, 'l3') && (input.holders?.length ?? 0) < 3) throw new Error('At L3 a new key is generated in your HSM with 3 of 5 key holders present.');
  const tag = atLeast(level, 'l3') ? 'hsm' : 'kms';
  const k = newKey(d, tag);
  const provider = custodyView(orgId).provider;
  const switchAt = input.purpose === 'planned' ? iso(Date.now() + Math.max(1, input.overlapDays ?? 30) * D) : undefined;
  const r = db.logAdmin(orgId, userId, 'key.bound', { kid: k.key.kid, fingerprint: k.key.fingerprint, provider, purpose: input.purpose, reason: input.reason.trim(), signing: 'off', ...(c && input.purpose === 'compromise' ? { compromise: c.id } : {}), ...(switchAt ? { switch_at: switchAt } : {}), ...(input.holders?.length ? { holders: input.holders.length } : {}) });
  d.publicKeys[k.key.kid] = k.key.publicKeyHex; // published from binding: verifiers can pin it before it signs
  d.signingKeys.push({ kid: k.key.kid, fingerprint: k.key.fingerprint, algorithm: 'Ed25519', status: 'bound', createdAt: r.ts, publishedAt: r.ts, receiptsSigned: 0 });
  const b: BoundKey = { kid: k.key.kid, fingerprint: k.key.fingerprint, publicKeyHex: k.key.publicKeyHex, seed: k.seed, boundAt: r.ts, boundBy: userId, seq: r.seq, reason: input.reason.trim(), purpose: input.purpose, compromiseId: input.purpose === 'compromise' ? c?.id : undefined, holders: input.holders, switchAt,
    ...(input.confirmed && input.confirmed.by !== userId ? { confirmedBy: input.confirmed.by, confirmedAt: input.confirmed.at, confirmedSeq: input.confirmed.seq } : {}) };
  x.bound = b;
  if (c && input.purpose === 'compromise') c.successor = { kid: b.kid, fingerprint: b.fingerprint, boundAt: b.boundAt, boundBy: userId, seq: r.seq, holders: input.holders };
  db.touch(orgId, 'key');
  return clone(b);
}

function withdrawBound(orgId: string, userId: string, reason: string) {
  requireOwnerOrAdmin(orgId, userId, 'Withdrawing a bound key');
  const d = db.getDB(orgId);
  const x = ext(orgId);
  const b = x.bound;
  if (!b) throw new Error('No key is bound.');
  const r = db.logAdmin(orgId, userId, 'key.bound_withdrawn', { kid: b.kid, reason: reason.trim() || 'Withdrawn before signing' });
  const e = d.signingKeys.find((k) => k.kid === b.kid);
  if (e) { e.status = 'revoked'; e.revokedAt = r.ts; e.revokedReason = 'Withdrawn before it signed'; }
  if (b.compromiseId) { const c = x.compromises.find((y) => y.id === b.compromiseId); if (c) c.successor = undefined; }
  x.bound = undefined;
  db.touch(orgId, 'key');
}

/** Turn signing on with the bound key. At L2 a second owner or admin does this (dual control, as for any KMS key change). */
function signingOn(orgId: string, userId: string) {
  requireOwnerOrAdmin(orgId, userId, 'Turning signing on');
  const d = db.getDB(orgId);
  const level = levelOfOrg(d.org);
  const x = ext(orgId);
  const b = x.bound;
  if (!b) throw new Error('Bind a key first; signing turns on with a bound key.');
  assertKeyChangeAllowed(orgId, userId, 'turn signing on', b.purpose === 'compromise' ? 'compromise' : 'bound');
  if (level === 'l2' && b.boundBy === userId) throw new Error(`You bound this key. At L2 a different owner or admin turns signing on (dual control).`);
  return switchToBound(orgId, userId);
}

/** The switch itself: the bound key signs from here (by a person, or by the system when a planned overlap ends). */
function switchToBound(orgId: string, userId: string, auto = false) {
  const d = db.getDB(orgId);
  const level = levelOfOrg(d.org);
  const x = ext(orgId);
  const b = x.bound!;
  const c = b.compromiseId ? x.compromises.find((y) => y.id === b.compromiseId) : undefined;
  const interimTail = c ? d.receipts[d.receipts.length - 1].seq : undefined;
  const r = switchSigning(d, { key: keyFromSeed(b.seed, b.kid), seed: b.seed }, userId, c ? 'Signing on with the replacement key after a key compromise' : auto ? 'Signing switched to the successor at the end of the planned overlap' : 'Signing switched to the successor published ahead', { signWith: 'old', oldStatus: 'retired', details: { bound_seq: b.seq, bound_by: b.boundBy, signing: 'on', ...(c ? { compromise: c.id } : {}), ...(auto && b.switchAt ? { switch_at: b.switchAt, automatic: true } : {}) } });
  if (c) {
    c.signingOn = { at: r.ts, by: userId, seq: r.seq };
    // the interim key sealed every receipt up to and including this key.rotated receipt
    c.unsignedTo = Math.max(interimTail ?? r.seq, r.seq);
  }
  // L3 and above: the new key came from a ceremony in the HSM; keep the ceremony register complete. A key from a
  // ceremony that published it as a successor (ceremonySuccessor) is already in the register: add the switch to its minutes.
  const fromCeremony = d.platform.ceremonies.find((k) => k.kidAfter === b.kid);
  if (fromCeremony) {
    fromCeremony.log.push({ at: r.ts, text: auto ? 'Signing switched automatically at the end of the planned overlap' : `Signing turned on by ${userName(userId)}` });
  } else if (atLeast(level, 'l3')) {
    d.platform.ceremonies.unshift({ id: `kc_${Date.now().toString(36)}`, kind: 'generation', at: r.ts, participants: (b.holders ?? []).map((n) => ({ name: n, role: 'Key holder' })), quorum: `${b.holders?.length ?? 3} of 5`, outcome: 'completed', kidBefore: undefined, kidAfter: b.kid, hsmSerial: custodyView(orgId).provider, seq: b.seq, log: [{ at: b.boundAt, text: `Key ${b.kid} generated and bound; signing off` }, { at: r.ts, text: auto ? 'Signing switched automatically at the end of the planned overlap' : `Signing turned on by ${userName(userId)}` }] });
  }
  x.bound = undefined;
  db.touch(orgId, 'key');
  return r.seq;
}

/**
 * A planned successor whose overlap has ended switches on its own: the key.rotated receipt is the system's and says
 * so. Not while a chain incident or a key compromise is open — the switch then waits, and the panel says why.
 */
function settleSwitch(orgId: string) {
  const b = ext(orgId).bound;
  if (!b || b.purpose !== 'planned' || !b.switchAt || new Date(b.switchAt).getTime() > Date.now()) return;
  if (keyChangeBlock(orgId, 'bound')) return;
  // L2: a KMS rotation needs two people. A successor one person published waits for a second owner or admin.
  if (needsSecondPerson(orgId, b)) return;
  switchToBound(orgId, 'system', true);
}

/**
 * The second person behind an L2 successor, if there is one: stored on the bound key, or read back from the chain for
 * state saved before the field existed (the approval of the KMS rotation that bound it, or a confirmation).
 */
function confirmationOf(d: OrgDB, b: BoundKey): { by: string; seq: number } | undefined {
  if (b.confirmedBy) return { by: b.confirmedBy, seq: b.confirmedSeq ?? 0 };
  for (let i = d.receipts.length - 1; i >= 0 && d.receipts[i].seq > b.seq; i--) {
    const r = d.receipts[i];
    if (r.action === 'key.rotation.approved' && r.details?.new_kid === b.kid && r.details?.requested_by && r.details.requested_by !== b.boundBy) return { by: String(r.details.requested_by), seq: Number(r.details.request_seq ?? r.seq) };
    if (r.action === 'key.bound_confirmed' && r.details?.kid === b.kid && r.actor && r.actor !== b.boundBy) return { by: r.actor, seq: r.seq };
  }
  return undefined;
}

/** true when an L2 planned successor still needs a second owner or admin before it may switch. */
function needsSecondPerson(orgId: string, b: BoundKey): boolean {
  const d = db.getDB(orgId);
  return b.purpose === 'planned' && levelOfOrg(d.org) === 'l2' && !confirmationOf(d, b);
}

/**
 * L2 dual control for "Publish a successor": a different owner or admin confirms the switch, recorded. The successor
 * then switches on its own at the end of the overlap; without the confirmation it waits. (At L3 and Sovereign the key
 * ceremony's quorum stands for this.)
 */
function confirmSwitch(orgId: string, userId: string) {
  requireOwnerOrAdmin(orgId, userId, 'Confirming the switch to a successor');
  const d = db.getDB(orgId);
  const x = ext(orgId);
  const b = x.bound;
  if (!b || b.purpose !== 'planned') throw new Error('No successor is bound.');
  if (levelOfOrg(d.org) !== 'l2') throw new Error('A second confirmation is the L2 dual control. From L3 the key ceremony’s quorum stands for it.');
  if (confirmationOf(d, b)) throw new Error('A second owner or admin has already confirmed this switch.');
  if (b.boundBy === userId) throw new Error('You published this successor. At L2 a different owner or admin confirms the switch (dual control).');
  assertKeyChangeAllowed(orgId, userId, 'confirm the switch to a successor', 'bound');
  const r = db.logAdmin(orgId, userId, 'key.bound_confirmed', { kid: b.kid, fingerprint: b.fingerprint, bound_by: b.boundBy, bound_seq: b.seq, ...(b.switchAt ? { switch_at: b.switchAt } : {}), control: 'dual' });
  b.confirmedBy = userId;
  b.confirmedAt = r.ts;
  b.confirmedSeq = r.seq;
  db.touch(orgId, 'key');
  return r.seq;
}

/** The overlap policy: a successor is published this many days before it signs. */
export const SUCCESSOR_OVERLAP_DAYS = 30;

/**
 * From L2 a rotation never swaps keys at once. A key ceremony (L3 and Sovereign, 3 of 5 holders present) or an
 * approved KMS rotation (L2) generates the new key and publishes it as a successor with the overlap policy — the
 * same mechanism as "Publish a successor" (bindKey): "Key bound · signing off", its public key published so
 * verifiers can pin it, the current key signing until the switch at the end of the overlap (or sooner, when an
 * owner or admin turns signing on). Writes key.ceremony, then key.bound; key.rotated follows at the switch.
 */
export function ceremonySuccessor(orgId: string, userId: string, participantNames?: string[], via: 'ceremony' | 'kms' = 'ceremony') {
  requireOwnerOrAdmin(orgId, userId, via === 'kms' ? 'Approving a KMS rotation' : 'Running a key ceremony');
  const d = db.getDB(orgId);
  const level = levelOfOrg(d.org);
  if (!atLeast(level, 'l2')) throw new Error('At L1 the key rotates at once. A successor published ahead of signing starts at L2.');
  const l3 = atLeast(level, 'l3');
  // L2: a KMS rotation is dual control — one person asks, a different owner or admin approves (approveKmsRotation)
  if (level === 'l2' && via === 'ceremony') {
    const pending = pendingRotationRequest(d);
    if (!pending) throw new Error('Rotation in AWS KMS needs two people: ask for the rotation first, and a different owner or admin approves it.');
    if (pending.actor === userId) throw new Error('You asked for this rotation. A different owner or admin approves and rotates the key.');
  }
  const custody = custodyView(orgId);
  const holders = custody.holders ?? [];
  const present = l3
    ? (participantNames?.length ? holders.filter((h) => participantNames.includes(h.name)) : holders.slice(0, 3))
    : [{ name: userName(userId), role: 'Approver (owner or admin)' }];
  if (l3 && present.length < 3) throw new Error(`A key ceremony needs 3 of ${holders.length} key holders present; ${present.length} named.`);
  // refused (and recorded) before anything is written: a chain incident, a compromise, or a successor already bound
  assertKeyChangeAllowed(orgId, userId, l3 ? 'run a key ceremony' : 'approve a KMS rotation');
  if (ext(orgId).bound) throw new Error(`Key ${ext(orgId).bound!.kid} is already bound and waiting for signing to be turned on.`);
  const before = d.signingKeys.find((k) => k.status === 'active')?.kid;
  const t = Date.now();
  const cer = db.logAdmin(orgId, userId, 'key.ceremony', { kind: 'rotation', quorum: l3 ? `${present.length} of 5` : 'n/a', provider: custody.provider, successor: 'published', overlap_days: SUCCESSOR_OVERLAP_DAYS });
  const b = bindKey(orgId, userId, {
    reason: l3 ? `Key ceremony: rotation in ${custody.provider}, published as the successor` : 'AWS KMS key rotation, published as the successor',
    purpose: 'planned', holders: l3 ? present.map((h) => h.name) : undefined, overlapDays: SUCCESSOR_OVERLAP_DAYS,
    // L2: the person who asked for the rotation is the second person, so the successor may switch at the end of the overlap
    confirmed: level === 'l2' ? ((q) => (q?.actor && q.actor !== userId ? { by: q.actor, at: q.ts, seq: q.seq } : undefined))(pendingRotationRequest(d)) : undefined,
  });
  const c: KeyCeremony = {
    id: `kc_${t.toString(36)}`, kind: 'rotation' as const, at: iso(t), participants: present, quorum: l3 ? `3 of ${holders.length}` : 'Not applicable — AWS KMS', outcome: 'completed' as const,
    kidBefore: before, kidAfter: b.kid, hsmSerial: l3 ? custody.provider : undefined, seq: cer.seq,
    log: [
      { at: iso(t), text: `${present.length} participant${present.length === 1 ? '' : 's'} present: ${present.map((x) => x.name).join(', ')}` },
      { at: iso(t), text: `New Ed25519 key ${b.kid} generated in ${custody.provider}; fingerprint ${b.fingerprint} recorded` },
      { at: b.boundAt, text: `Published as the successor: key bound, signing off. ${before ?? 'The current key'} keeps signing until the switch${b.switchAt ? ` on ${dateTime(b.switchAt)}` : ''} (${SUCCESSOR_OVERLAP_DAYS}-day overlap)` },
    ],
  };
  d.platform.ceremonies.unshift(c);
  db.touch(orgId, 'key');
  return { ...clone(c), boundSeq: b.seq, switchAt: b.switchAt };
}

function closeCompromise(orgId: string, userId: string, id: string, note: string) {
  requireOwnerOrAdmin(orgId, userId, 'Closing a key compromise');
  const x = ext(orgId);
  const c = x.compromises.find((y) => y.id === id);
  if (!c) throw new Error('There is no such key compromise.');
  if (c.closed) throw new Error('It is already closed.');
  if (!c.notice) throw new Error('Send the notice to the named contact first.');
  if (!c.signingOn) throw new Error('Turn signing on with the replacement key first.');
  const count = (c.unsignedTo ?? c.unsignedFrom) - c.unsignedFrom + 1;
  const r = db.logAdmin(orgId, userId, 'key.compromise.closed', { compromise: id, revoked_kid: c.kid, new_kid: c.successor?.kid ?? '', unsigned_from: c.unsignedFrom, unsigned_to: c.unsignedTo ?? c.unsignedFrom, unsigned_receipts: count, notice_within_24h: !c.notice.late, note: note.trim() });
  c.closed = { at: r.ts, by: userId, seq: r.seq, note: note.trim() };
  db.touch(orgId, 'key');
  return clone(c);
}

function setContact(orgId: string, userId: string, contact: Omit<KeyContact, 'setBy' | 'setAt' | 'seq'>) {
  requireOwnerOrAdmin(orgId, userId, 'Naming the contact for key notices');
  if (!contact.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email.trim())) throw new Error('Give a name and a working email address.');
  const r = db.logAdmin(orgId, userId, 'key.contact_set', { name: contact.name.trim(), email: contact.email.trim(), role: contact.role.trim() });
  ext(orgId).contact = { name: contact.name.trim(), email: contact.email.trim(), role: contact.role.trim(), phone: contact.phone?.trim() || undefined, setBy: userId, setAt: r.ts, seq: r.seq };
  db.touch(orgId, 'key');
}

/* ── Unsigned intervals (read synchronously by the chain and receipt pages) ── */

export interface UnsignedInterval { compromiseId: string; kid: string; interimKid: string; fromSeq: number; toSeq?: number; open: boolean; declaredAt: string; closedAt?: string }

export function unsignedIntervals(orgId: string): UnsignedInterval[] {
  const d = db.peekDB(orgId) as ExtDB | undefined;
  if (d && !d.keysExt) ext(orgId); // seeded history (a closed compromise) is read back on first use
  const cs = d?.keysExt?.compromises ?? [];
  return cs.map((c) => ({ compromiseId: c.id, kid: c.kid, interimKid: c.interimKid, fromSeq: c.unsignedFrom, toSeq: c.unsignedTo, open: !c.signingOn, declaredAt: c.declaredAt, closedAt: c.closed?.at }));
}

/** The unsigned intervals that overlap a range, as an export manifest names them (bundles, auditor packs). */
export function unsignedIntervalsInRange(orgId: string, fromSeq: number, toSeq: number): UnsignedIntervalManifest[] {
  const x = ext(orgId);
  return x.compromises
    .filter((c) => c.unsignedFrom <= toSeq && (c.unsignedTo === undefined ? true : c.unsignedTo >= fromSeq))
    .map((c) => ({ compromise: c.id, revoked_kid: c.kid, interim_kid: c.interimKid, first_seq: c.unsignedFrom, ...(c.unsignedTo !== undefined ? { last_seq: c.unsignedTo } : {}), open: !c.signingOn, ...(c.successor ? { replacement_kid: c.successor.kid } : {}) }));
}

/** true when a key id is Elan1 Govern's interim chain key (records it sealed are hash-chained, not signed with the organisation's key). */
export function isInterimKid(orgId: string, kid: string): boolean {
  const d = db.peekDB(orgId) as ExtDB | undefined;
  if (!d) return false;
  if (!d.keysExt) ext(orgId);
  return !!d.signingKeys.find((k) => k.kid === kid)?.interim || !!d.keysExt?.interimKids.includes(kid);
}

/** The auditor of record: the organisation's active auditor member, if it has one (copied on key-compromise notices). */
export function auditorOfRecord(orgId: string): { userId: string; name: string; email: string; role: string } | undefined {
  const d = db.peekDB(orgId) ?? db.getDB(orgId);
  const m = d.members.find((y) => y.role === 'auditor' && y.status === 'active');
  const u = m ? userById(m.userId) : undefined;
  return u ? { userId: u.id, name: u.name, email: u.email, role: u.title ?? 'Auditor' } : undefined;
}

/** The interval a receipt falls in: sealed by the interim chain key, not signed with the organisation's key. */
export function unsignedIntervalOf(orgId: string, r: Pick<Receipt, 'seq' | 'kid'>): UnsignedInterval | undefined {
  return unsignedIntervals(orgId).find((u) => u.interimKid === r.kid || (r.seq >= u.fromSeq && (u.toSeq === undefined ? u.open : r.seq <= u.toSeq)));
}

/* ── Key windows ───────────────────────────────────────────────────────── */

export interface KeyWindow {
  kid: string;
  fingerprint: string;
  status: SigningKey['status'];
  interim: boolean;
  publishedAt: string;
  signingFrom?: string;
  signingUntil?: string;
  revokedAt?: string;
  revokedReason?: string;
  /** days the key was published while its predecessor still signed */
  overlapDays: number;
  receiptsSigned: number;
}

export function keyWindows(orgId: string): KeyWindow[] {
  ext(orgId);
  const d = db.getDB(orgId);
  const ks = d.signingKeys;
  return ks.map((k, i) => {
    const prev = ks.slice(0, i).reverse().find((p) => p.status !== 'bound' && !(p.status === 'revoked' && !p.retiredAt));
    const pub = k.publishedAt ?? k.createdAt;
    const from = k.status === 'bound' ? undefined : k.createdAt;
    const prevUntil = prev?.retiredAt;
    const overlap = prevUntil && from ? Math.max(0, (Math.min(new Date(prevUntil).getTime(), new Date(from).getTime()) - new Date(pub).getTime()) / D) : 0;
    return {
      kid: k.kid, fingerprint: k.fingerprint, status: k.status, interim: !!k.interim, publishedAt: pub, signingFrom: from,
      signingUntil: k.retiredAt, revokedAt: k.revokedAt, revokedReason: k.revokedReason, overlapDays: Math.round(overlap * 10) / 10, receiptsSigned: k.receiptsSigned,
    };
  });
}

/* ── KMS Sign-call reconciliation ──────────────────────────────────────── */

export interface ReconDay { day: string; calls: number; receipts: number; checkpoints: number; signed: number; delta: number; discrepancy?: SignDiscrepancy }
export interface ReconView {
  source: string;
  logName: string;
  mode: CustodyMode;
  days: ReconDay[];
  totals: { calls: number; signed: number; open: number; explained: number };
  discrepancies: SignDiscrepancy[];
  runs: ReconciliationRun[];
}

function reconDays(orgId: string, days = 14): ReconDay[] {
  const d = db.getDB(orgId);
  const x = ext(orgId);
  const history = d.org.levelHistory;
  const interim = new Set(x.interimKids);
  const since = new Date(dayKey(Date.now() - (days - 1) * D) + 'T00:00:00+05:30').getTime();
  const byDay = new Map<string, { receipts: number; checkpoints: number }>();
  for (let i = 0; i < days; i++) byDay.set(dayKey(since + i * D + 6 * H), { receipts: 0, checkpoints: 0 });
  for (let i = d.receipts.length - 1; i >= 0; i--) {
    const r = d.receipts[i];
    const t = new Date(r.ts).getTime();
    if (t < since) break;
    if (interim.has(r.kid) || !atLeast(levelAt(history, t), 'l2')) continue;
    const e = byDay.get(dayKey(t));
    if (e) e.receipts++;
  }
  for (const c of d.checkpoints) {
    const t = new Date(c.ts).getTime();
    if (t < since || interim.has(c.kid) || !atLeast(levelAt(history, t), 'l2')) continue;
    const e = byDay.get(dayKey(t));
    if (e) e.checkpoints++;
  }
  return [...byDay.entries()].map(([day, v]) => {
    const q = x.discrepancies.find((y) => y.day === day);
    const signed = v.receipts + v.checkpoints;
    const delta = q?.delta ?? 0;
    return { day, receipts: v.receipts, checkpoints: v.checkpoints, signed, calls: signed + delta, delta, discrepancy: q };
  }).reverse();
}

function reconView(orgId: string): ReconView {
  const level = levelOfOrg(db.getDB(orgId).org);
  const x = ext(orgId);
  const c = custodyView(orgId);
  const days = reconDays(orgId);
  return {
    source: level === 'l2' ? 'AWS CloudTrail · kms:Sign events on the signing key' : level === 'l3' ? 'AWS CloudHSM audit log · sign operations on the signing key' : 'Entrust nShield audit log · sign operations on the signing key',
    logName: level === 'l2' ? 'KMS Sign calls' : 'HSM sign operations',
    mode: c.mode,
    days,
    totals: { calls: days.reduce((a, b) => a + b.calls, 0), signed: days.reduce((a, b) => a + b.signed, 0), open: x.discrepancies.filter((q) => q.status === 'open').length, explained: x.discrepancies.filter((q) => q.status === 'explained').length },
    discrepancies: clone(x.discrepancies),
    runs: clone(x.runs.slice(0, 8)),
  };
}

function runReconciliation(orgId: string, userId: string) {
  requireOwnerOrAdmin(orgId, userId, 'Running the reconciliation');
  if (!atLeast(levelOfOrg(db.getDB(orgId).org), 'l2')) throw new Error('Sign-call reconciliation starts at L2, when the key moves into AWS KMS.');
  const v = reconView(orgId);
  const r = db.logAdmin(orgId, userId, 'key.sign_reconciled', { days: v.days.length, calls: v.totals.calls, signed: v.totals.signed, discrepancies_open: v.totals.open, source: v.logName });
  ext(orgId).runs.unshift({ at: r.ts, by: userId, seq: r.seq, days: v.days.length, calls: v.totals.calls, signed: v.totals.signed, open: v.totals.open });
  db.touch(orgId, 'key');
  return reconView(orgId);
}

function explainDiscrepancy(orgId: string, userId: string, id: string, note: string) {
  requireOwnerOrAdmin(orgId, userId, 'Explaining a discrepancy');
  if (note.trim().length < 12) throw new Error('Say what the extra calls were, with a reference someone can check.');
  const q = ext(orgId).discrepancies.find((y) => y.id === id);
  if (!q) throw new Error('There is no such discrepancy.');
  if (q.status !== 'open') throw new Error('It is no longer open.');
  const r = db.logAdmin(orgId, userId, 'key.sign_discrepancy.explained', { day: q.day, delta: q.delta, principal: q.principal, note: note.trim() });
  Object.assign(q, { status: 'explained', by: userId, at: r.ts, note: note.trim(), seq: r.seq });
  db.touch(orgId, 'key');
}

/* ── Fingerprint publication ───────────────────────────────────────────── */

export function dnsRecord(d: Pick<OrgDB, 'org'>, kid: string, fingerprint: string) {
  const domain = d.org.domain ?? `${d.org.slug}.example`;
  return { name: `_elan1-govern.${domain}`, type: 'TXT' as const, value: `v=EG1; kid=${kid}; alg=ed25519; fp=${fingerprint}` };
}

function recordPublication(orgId: string, userId: string, channel: PublishChannel, where: string) {
  requireOwnerOrAdmin(orgId, userId, 'Recording a published fingerprint');
  const d = db.getDB(orgId);
  const k = d.signingKeys.find((s) => s.status === 'active');
  if (!k) throw new Error('There is no active signing key.');
  if (k.interim) throw new Error('Signing is off while a key compromise is handled. Publish the replacement key’s fingerprint once signing is on.');
  const r = db.logAdmin(orgId, userId, 'key.fingerprint_published', { channel, kid: k.kid, fingerprint: k.fingerprint, where: where.trim() });
  ext(orgId).publications.unshift({ id: randId('pub'), channel, kid: k.kid, fingerprint: k.fingerprint, where: where.trim(), at: r.ts, by: userId, seq: r.seq });
  db.touch(orgId, 'key');
}

/* ── Auditor's evidence requests ───────────────────────────────────────── */

function requestEvidence(orgId: string, userId: string, input: { purpose: string; fromSeq: number; toSeq: number; dueDays: number }) {
  const role = db.memberRole(orgId, userId);
  if (role !== 'auditor') throw new Error('Evidence requests come from the organisation’s auditor.');
  const d = db.getDB(orgId);
  if (input.purpose.trim().length < 6) throw new Error('Say what the evidence is for.');
  const first = d.receipts[0]?.seq ?? 1;
  const head = d.receipts[d.receipts.length - 1]?.seq ?? 1;
  const from = Math.max(first, Math.min(input.fromSeq, input.toSeq));
  const to = Math.min(head, Math.max(input.fromSeq, input.toSeq));
  if (to < from) throw new Error(`That range holds no receipts. This console holds #${first} to #${head}.`);
  const format = atLeast(levelOfOrg(d.org), 'l2') ? 'elan1.evidence.bundle.v1' as const : 'auditor-pack/1' as const;
  const id = randId('evr');
  const due = iso(Date.now() + Math.max(1, Math.min(30, input.dueDays)) * D);
  const r = db.logAdmin(orgId, userId, 'evidence.requested', { request: id, from_seq: from, to_seq: to, format, purpose: input.purpose.trim(), due });
  const fromR = d.receipts.find((x) => x.seq === from);
  const toR = d.receipts.find((x) => x.seq === to);
  const q: EvidenceRequest = { id, requestedBy: userId, requestedAt: r.ts, seq: r.seq, purpose: input.purpose.trim(), fromSeq: from, toSeq: to, fromDate: fromR?.ts, toDate: toR?.ts, format, dueBy: due, status: 'open' };
  ext(orgId).requests.unshift(q);
  db.touch(orgId, 'key');
  return clone(q);
}

/**
 * The exact files a fulfilled request sent (one per part), kept with the request so the auditor collects the export
 * that was recorded and billed — the same parts, manifests (with export_checks), digests and creator. Held in memory
 * and in this browser's storage (reset with the demo data), never rebuilt from the range.
 */
const sentFiles = new Map<string, string[]>();
const sentKey = (orgId: string, id: string) => `eg:evidence:sent:${orgId}:${id}`;

function keepSent(orgId: string, id: string, jsons: string[]) {
  sentFiles.set(`${orgId}:${id}`, jsons);
  try {
    // drop files kept for requests this organisation no longer has (state regenerated), then keep these
    const ids = new Set(ext(orgId).requests.map((q) => q.id));
    const prefix = `eg:evidence:sent:${orgId}:`;
    Object.keys(localStorage).filter((k) => k.startsWith(prefix) && !ids.has(k.slice(prefix.length))).forEach((k) => localStorage.removeItem(k));
    localStorage.setItem(sentKey(orgId, id), JSON.stringify(jsons));
  } catch { /* storage full or unavailable: the files stay in memory for this session */ }
}

function sentOf(orgId: string, id: string): string[] | undefined {
  const hit = sentFiles.get(`${orgId}:${id}`);
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(sentKey(orgId, id));
    const x = raw ? (JSON.parse(raw) as unknown) : undefined;
    if (Array.isArray(x) && x.length && x.every((s) => typeof s === 'string')) { sentFiles.set(`${orgId}:${id}`, x as string[]); return x as string[]; }
  } catch { /* unreadable: treated as not held */ }
  return undefined;
}

/** An export already made through the export dialog (api.exportPack), which ran every export check on it. `jsons`: each part's file, in order. */
export interface SentExport { exportIds: string[]; receipts: number; firstSeq: number; lastSeq: number; json?: string; jsons?: string[]; exportSeq?: number }

/**
 * Fulfil a request with an export made through the export dialog: the same checks as every other export (size split,
 * chain break, integrity run, residency, consent and declarations), verified first, with the charge shown before
 * the click. Nothing is exported here: the request is linked to that export. Without one, nothing is sent.
 */
function fulfilRequest(orgId: string, userId: string, id: string, sent?: SentExport) {
  requireOwnerOrAdmin(orgId, userId, 'Fulfilling an evidence request');
  const q = ext(orgId).requests.find((y) => y.id === id);
  if (!q) throw new Error('There is no such request.');
  if (q.status !== 'open') throw new Error('The request is no longer open.');
  if (!sent || !sent.exportIds.length) throw new Error('Export the range through the export dialog first: it runs the export checks, lets you verify the file and shows the charge. Then it is sent.');
  const d = db.getDB(orgId);
  const made = sent.exportIds.map((x) => d.exports.find((e) => e.id === x));
  if (made.some((e) => !e)) throw new Error('That export is not in this organisation’s export history.');
  if (sent.firstSeq > q.fromSeq || sent.lastSeq < q.toSeq) throw new Error(`The export covers #${sent.firstSeq}–#${sent.lastSeq}; the auditor asked for #${q.fromSeq}–#${q.toSeq}.`);
  // the files themselves, one per part, each matching the digest recorded for its export: the auditor collects these bytes
  const jsons = sent.jsons?.length ? sent.jsons : sent.json ? [sent.json] : [];
  if (jsons.length !== sent.exportIds.length) throw new Error(`The export has ${sent.exportIds.length} part${sent.exportIds.length === 1 ? '' : 's'} but ${jsons.length} file${jsons.length === 1 ? '' : 's'} reached the request. Export it again through the export dialog.`);
  const digests = jsons.map((j, i) => {
    let b: EvidenceBundle;
    try { b = JSON.parse(j) as EvidenceBundle; } catch { throw new Error(`Part ${i + 1} is not a readable bundle. Export it again through the export dialog.`); }
    const dg = bundleDigest(b);
    const want = made[i]!.digest;
    if (want && want !== dg) throw new Error(`Part ${i + 1} is not the file recorded for export ${made[i]!.id} (its digest ${dg.slice(0, 16)} differs from ${want.slice(0, 16)}). Export it again through the export dialog.`);
    return dg;
  });
  const format = made[0]!.format ?? q.format;
  const r = db.logAdmin(orgId, userId, 'evidence.request.fulfilled', { request: id, request_seq: q.seq ?? 0, export: sent.exportIds[0], receipts: sent.receipts, format, requested_by: q.requestedBy, digest: digests[0].slice(0, 16), ...(sent.exportIds.length > 1 ? { parts: sent.exportIds.length } : {}) });
  q.status = 'fulfilled';
  q.fulfilled = { by: userId, at: r.ts, seq: r.seq, exportId: sent.exportIds[0], receipts: sent.receipts, exportSeq: sent.exportSeq, exportIds: [...sent.exportIds], digests };
  keepSent(orgId, id, jsons);
  db.touch(orgId, 'key');
  return clone(q);
}

function declineRequest(orgId: string, userId: string, id: string, reason: string) {
  requireOwnerOrAdmin(orgId, userId, 'Declining an evidence request');
  if (reason.trim().length < 8) throw new Error('Give the auditor a reason they can act on.');
  const q = ext(orgId).requests.find((y) => y.id === id);
  if (!q || q.status !== 'open') throw new Error('The request is no longer open.');
  const r = db.logAdmin(orgId, userId, 'evidence.request.declined', { request: id, request_seq: q.seq ?? 0, reason: reason.trim() });
  q.status = 'declined';
  q.declined = { by: userId, at: r.ts, seq: r.seq, reason: reason.trim() };
  db.touch(orgId, 'key');
  return clone(q);
}

function withdrawRequest(orgId: string, userId: string, id: string) {
  const q = ext(orgId).requests.find((y) => y.id === id);
  if (!q || q.status !== 'open') throw new Error('The request is no longer open.');
  if (q.requestedBy !== userId) throw new Error('Only the auditor who asked can withdraw the request.');
  const r = db.logAdmin(orgId, userId, 'evidence.request.withdrawn', { request: id, request_seq: q.seq ?? 0 });
  q.status = 'withdrawn';
  q.withdrawn = { at: r.ts, seq: r.seq };
  db.touch(orgId, 'key');
}

/**
 * The auditor collects the evidence: the receipt that closes the loop. Returns the files to save — exactly the export
 * that was recorded and billed, every part of it — with the first file as `json`/`filename` for older callers.
 */
function collectRequest(orgId: string, userId: string, id: string): { json: string; filename: string; files: { json: string; filename: string }[]; request: EvidenceRequest } {
  const q = ext(orgId).requests.find((y) => y.id === id);
  if (!q) throw new Error('There is no such request.');
  if (q.status !== 'fulfilled' && q.status !== 'received') throw new Error('The organisation has not fulfilled this request yet.');
  if (q.requestedBy !== userId && db.memberRole(orgId, userId) !== 'auditor') throw new Error('The auditor who asked collects the bundle.');
  // never rebuilt from the range: a rebuild would carry a new date, the auditor as creator, no export checks and a
  // different digest from the export that was recorded and billed
  const jsons = sentOf(orgId, id);
  if (!jsons) throw new Error(`The file${(q.fulfilled?.exportIds?.length ?? 1) > 1 ? 's' : ''} sent ${q.fulfilled ? `on ${dateTime(q.fulfilled.at)}` : 'earlier'} ${(q.fulfilled?.exportIds?.length ?? 1) > 1 ? 'are' : 'is'} not held in this browser any more, so ${(q.fulfilled?.exportIds?.length ?? 1) > 1 ? 'they cannot' : 'it cannot'} be handed over again here.${q.received ? ` The copy you collected on ${dateTime(q.received.at)} is the record.` : ''} Ask the organisation to send it again.`);
  const d0 = db.getDB(orgId);
  const prefix = q.format === 'auditor-pack/1' ? 'auditor-pack' : 'evidence-bundle';
  const files = jsons.map((json, i) => {
    const e = d0.exports.find((x) => x.id === (q.fulfilled?.exportIds?.[i] ?? (i === 0 ? q.fulfilled?.exportId : undefined)));
    const range = e ? `${e.firstSeq}-${e.lastSeq}` : `${q.fromSeq}-${q.toSeq}`;
    return { json, filename: `${prefix}-${d0.org.slug}-${range}${jsons.length > 1 ? `-part${i + 1}of${jsons.length}` : ''}.json` };
  });
  const json = files[0].json;
  if (q.received) {
    // a further copy leaving the console is still a recorded write (no new export, no charge)
    db.logAdmin(orgId, userId, 'evidence.request.collected_again', { request: id, receipts: q.fulfilled?.receipts ?? 0, format: q.format, fulfil_seq: q.fulfilled?.seq ?? 0 });
    db.touch(orgId, 'key');
  }
  if (!q.received) {
    const r = db.logAdmin(orgId, userId, 'evidence.request.received', { request: id, fulfil_seq: q.fulfilled?.seq ?? 0, receipts: q.fulfilled?.receipts ?? 0 });
    q.received = { at: r.ts, seq: r.seq };
    q.status = 'received';
    db.touch(orgId, 'key');
  }
  return { json, filename: files[0].filename, files, request: clone(q) };
}

/* ── KMS rotation (L2 dual control), with the approval written after the rotation succeeds ── */

function requestKmsRotation(orgId: string, userId: string, reason: string, alias?: string) {
  requireOwnerOrAdmin(orgId, userId, 'Requesting a KMS rotation');
  const d = db.getDB(orgId);
  if (pendingRotationRequest(d)) throw new Error('A rotation is already waiting for a second person.');
  if (reason.trim().length < 8) throw new Error('Give a reason of a few words.');
  assertKeyChangeAllowed(orgId, userId, 'request a KMS rotation');
  return db.logAdmin(orgId, userId, 'key.rotation.requested', { provider: 'AWS KMS', alias: alias ?? '', reason: reason.trim() });
}

/** The requester withdraws a rotation request that is still waiting; an approved (or rotated) request cannot be withdrawn. */
function withdrawKmsRotation(orgId: string, userId: string) {
  const pending = pendingRotationRequest(db.getDB(orgId));
  if (!pending) throw new Error('There is no rotation request waiting. Once approved, the successor is withdrawn from the key windows instead.');
  if (pending.actor !== userId) throw new Error('Only the person who asked for the rotation can withdraw the request.');
  const r = db.logAdmin(orgId, userId, 'key.rotation.withdrawn', { request_seq: pending.seq });
  db.touch(orgId, 'key');
  return r;
}

/**
 * The second person approves and KMS creates the new key, published as the successor with the overlap policy
 * (ceremonySuccessor): bound, signing off, until the switch. The approval receipt is written only once the key
 * is bound, so a failed rotation never leaves an approval behind with nothing approved.
 */
function approveKmsRotation(orgId: string, userId: string) {
  const d = db.getDB(orgId);
  const pending = pendingRotationRequest(d);
  if (!pending) throw new Error('There is no rotation request waiting.');
  if (pending.actor === userId) throw new Error('You asked for this rotation. Another owner or admin approves it.');
  assertKeyChangeAllowed(orgId, userId, 'approve a KMS rotation');
  const ceremony = ceremonySuccessor(orgId, userId, undefined, 'kms'); // throws before anything is written if the rotation cannot run
  const approval = db.logAdmin(orgId, userId, 'key.rotation.approved', { request_seq: pending.seq, requested_by: pending.actor ?? '', rotation_seq: ceremony.seq ?? 0, new_kid: ceremony.kidAfter ?? '', successor: 'published', switch_at: ceremony.switchAt ?? '' });
  return { ceremony, approvalSeq: approval.seq, requestedBy: pending.actor };
}

/**
 * The key bound for an L1 → L2 upgrade and not yet signing (read from the upgrade's receipts: a
 * level.upgrade_key_created with no signing-on, rotation, cancellation or roll-back after it).
 */
export function upgradeBoundKey(orgId: string): { kid: string; fingerprint: string; at: string; seq: number; compared: boolean } | undefined {
  const d = db.peekDB(orgId) ?? db.getDB(orgId);
  const stop = new Set(['level.signing_on', 'key.rotated', 'level.upgrade_cancelled', 'level.upgrade_rolled_back', 'level.upgrade_closed']);
  let compared = false;
  for (let i = d.receipts.length - 1, n = 0; i >= 0 && n < 4000; i--, n++) {
    const r = d.receipts[i];
    if (!r.action) continue;
    if (stop.has(r.action)) return undefined;
    if (r.action === 'level.upgrade_stage' && r.details?.stage === 'kms' && r.details?.fingerprint_compared === 'match') compared = true;
    if (r.action === 'level.upgrade_key_created') return { kid: String(r.details?.kid ?? ''), fingerprint: String(r.details?.fingerprint ?? ''), at: r.ts, seq: r.seq, compared };
  }
  return undefined;
}

/* ── Views ─────────────────────────────────────────────────────────────── */

export interface KeysState {
  level: LevelId;
  contact?: KeyContact;
  compromise?: KeyCompromise;
  pastCompromises: KeyCompromise[];
  bound?: Omit<BoundKey, 'seed'>;
  /** an L1 → L2 upgrade's key, bound and compared, not yet signing */
  upgradeBound?: ReturnType<typeof upgradeBoundKey>;
  windows: KeyWindow[];
  chainIncident?: { id: string; title: string };
  block?: string;
  refusals: KeyChangeRefusal[];
  publications: FingerprintPublication[];
  active?: { kid: string; fingerprint: string; interim: boolean; publicKeyHex?: string };
  dns?: { name: string; type: 'TXT'; value: string };
  /** the organisation's auditor of record (the only person a compromise notice may be copied to) */
  auditor?: { userId: string; name: string; email: string; role: string };
  /** a planned successor's switch time has passed but a key change is refused now: why it waits */
  switchWaiting?: string;
  /** L2: the bound successor was published by one person and waits for a different owner or admin to confirm the switch */
  awaitingSecond?: boolean;
}

function stateOf(orgId: string): KeysState {
  const x = ext(orgId);
  const d = db.getDB(orgId);
  const active = d.signingKeys.find((k) => k.status === 'active');
  const { seed: _s, ...bound } = x.bound ?? ({} as BoundKey);
  const awaitingSecond = !!x.bound && needsSecondPerson(orgId, x.bound);
  const due = x.bound?.purpose === 'planned' && !!x.bound.switchAt && new Date(x.bound.switchAt).getTime() <= Date.now();
  return clone({
    level: levelOfOrg(d.org), contact: x.contact, compromise: x.compromises.find((c) => !c.closed), pastCompromises: x.compromises.filter((c) => c.closed),
    bound: x.bound ? bound : undefined, upgradeBound: upgradeBoundKey(orgId), windows: keyWindows(orgId), chainIncident: openChainIncident(orgId), block: keyChangeBlock(orgId),
    refusals: x.refusals.slice(0, 6), publications: x.publications,
    active: active ? { kid: active.kid, fingerprint: active.fingerprint, interim: !!active.interim, publicKeyHex: d.publicKeys[active.kid] } : undefined,
    dns: active && !active.interim ? dnsRecord(d, active.kid, active.fingerprint) : undefined,
    auditor: auditorOfRecord(orgId),
    switchWaiting: due ? (keyChangeBlock(orgId, 'bound') ?? (awaitingSecond ? 'A second owner or admin has not confirmed it yet. At L2 a KMS rotation needs two people.' : undefined)) : undefined,
    awaitingSecond: awaitingSecond || undefined,
  });
}

/** What the printable fingerprint page shows (public: no account; public keys only). */
export function publicFingerprint(orgRef: string) {
  const id = (ORGS.find((o) => o.id === orgRef) ?? ORGS.find((o) => o.slug === orgRef))?.id;
  if (!id) return undefined;
  ext(id);
  const d = db.getDB(id);
  const active = d.signingKeys.find((k) => k.status === 'active');
  const signer = active && !active.interim ? active : undefined;
  return clone({
    org: { id, name: d.org.name, slug: d.org.slug, domain: d.org.domain, level: levelOfOrg(d.org) },
    current: signer ? { ...signer, publicKeyHex: d.publicKeys[signer.kid] } : undefined,
    signingOff: !!active?.interim,
    bound: d.signingKeys.filter((k) => k.status === 'bound').map((k) => ({ ...k, publicKeyHex: d.publicKeys[k.kid] })),
    windows: keyWindows(id),
    dns: signer ? dnsRecord(d, signer.kid, signer.fingerprint) : undefined,
  });
}

/* ── API (async, like the rest of the mock API) ────────────────────────── */

export const keysApi = {
  async state(orgId: string) { await wait(60, 160); settleSwitch(orgId); return stateOf(orgId); },
  async setContact(orgId: string, userId: string, contact: Omit<KeyContact, 'setBy' | 'setAt' | 'seq'>) { await wait(200, 400); setContact(orgId, userId, contact); return stateOf(orgId); },
  async declareCompromise(orgId: string, userId: string, input: { reason: string; suspectedSince?: string; discrepancyId?: string }) { await wait(400, 800); return declareCompromise(orgId, userId, input); },
  async sendNotice(orgId: string, userId: string, id: string, cc?: string) { await wait(300, 600); return sendNotice(orgId, userId, id, cc); },
  async bindKey(orgId: string, userId: string, input: { reason: string; purpose: 'planned' | 'compromise'; holders?: string[]; overlapDays?: number }) { await wait(700, 1200); return bindKey(orgId, userId, { reason: input.reason, purpose: input.purpose, holders: input.holders, overlapDays: input.overlapDays }); },
  /** L2: a different owner or admin confirms the switch to a successor one person published (dual control). */
  async confirmSwitch(orgId: string, userId: string) { await wait(300, 600); const seq = confirmSwitch(orgId, userId); settleSwitch(orgId); return seq; },
  async withdrawBound(orgId: string, userId: string, reason: string) { await wait(200, 400); withdrawBound(orgId, userId, reason); },
  async signingOn(orgId: string, userId: string) { await wait(500, 900); return signingOn(orgId, userId); },
  async closeCompromise(orgId: string, userId: string, id: string, note: string) { await wait(300, 600); return closeCompromise(orgId, userId, id, note); },
  async reconciliation(orgId: string) { await wait(80, 200); return reconView(orgId); },
  async runReconciliation(orgId: string, userId: string) { await wait(500, 900); return runReconciliation(orgId, userId); },
  async explainDiscrepancy(orgId: string, userId: string, id: string, note: string) { await wait(200, 400); explainDiscrepancy(orgId, userId, id, note); },
  async recordPublication(orgId: string, userId: string, channel: PublishChannel, where: string) { await wait(200, 400); recordPublication(orgId, userId, channel, where); },
  async requestKmsRotation(orgId: string, userId: string, reason: string, alias?: string) { await wait(200, 400); return requestKmsRotation(orgId, userId, reason, alias); },
  async approveKmsRotation(orgId: string, userId: string) { await wait(900, 1400); return clone(approveKmsRotation(orgId, userId)); },
  async withdrawKmsRotation(orgId: string, userId: string) { await wait(150, 300); return withdrawKmsRotation(orgId, userId); },
  async evidenceRequests(orgId: string) {
    await wait(60, 160);
    settleSeeds(orgId);
    const d = db.getDB(orgId);
    const first = d.receipts[0]?.seq ?? 0;
    const head = d.receipts[d.receipts.length - 1]?.seq ?? 0;
    // a sent request can be collected only while the files that were sent are held here (they are never rebuilt)
    return clone(ext(orgId).requests).map((q) => ({ ...q, held: q.status === 'fulfilled' || q.status === 'received' ? !!sentOf(orgId, q.id) : q.toSeq >= first && q.fromSeq <= head }));
  },
  async requestEvidence(orgId: string, userId: string, input: { purpose: string; fromSeq: number; toSeq: number; dueDays: number }) { await wait(300, 600); return requestEvidence(orgId, userId, input); },
  async fulfilRequest(orgId: string, userId: string, id: string, sent?: SentExport) { await wait(300, 600); return fulfilRequest(orgId, userId, id, sent); },
  async declineRequest(orgId: string, userId: string, id: string, reason: string) { await wait(200, 400); return declineRequest(orgId, userId, id, reason); },
  async withdrawRequest(orgId: string, userId: string, id: string) { await wait(200, 400); withdrawRequest(orgId, userId, id); },
  async collectRequest(orgId: string, userId: string, id: string) { await wait(400, 800); return collectRequest(orgId, userId, id); },
  /** Read the head and window of receipts this console holds (for range pickers). */
  async chainRange(orgId: string) {
    await wait(40, 100);
    const d = db.getDB(orgId);
    return { first: d.receipts[0]?.seq ?? 1, head: d.receipts[d.receipts.length - 1]?.seq ?? 1, firstAt: d.receipts[0]?.ts, headAt: d.receipts[d.receipts.length - 1]?.ts, seqAt: (t: number) => (d.receipts.find((r) => new Date(r.ts).getTime() >= t) ?? d.receipts[d.receipts.length - 1])?.seq ?? 1 };
  },
};

/** Open evidence requests (synchronous; for counts in navigation and banners). */
export function openRequestCount(orgId: string): number {
  const d = db.peekDB(orgId) as ExtDB | undefined;
  return d?.keysExt?.requests?.filter((q) => q.status === 'open').length ?? 0;
}
