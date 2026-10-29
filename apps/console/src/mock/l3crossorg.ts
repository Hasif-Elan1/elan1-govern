/**
 * Cross-organisation receipts (L3), beyond issuing and checking:
 *   · the volume and reversal warning before the first receipt to a new audience (acknowledged on the record);
 *   · dual-control acceptance of a received receipt (receipt.accept): one owner or admin starts, a different one completes;
 *   · revoking an issued receipt, and disputes raised by the receiver (or recorded by the issuer for a counterparty
 *     outside this console), resolved on the issuer's side and mirrored to the other organisation when it is here.
 * Replay detection (nonce) is part of the recorded check itself: see lib/crossorg.ts and mock/platform.ts.
 */
import type { CrossOrgDispute, CrossOrgReceipt, Receipt } from '@/types';
import { getDB, append, touch, peekDB, persist, type OrgDB } from './db';
import { ORGS, personFor, userName } from './users';
import { crossOrgView } from './platform';
import { standingOf, isReplayed } from '@/lib/crossorg';
import { D, H, clone, iso, isL3, l3ext, requireL3, requireRoles } from './l3state';

const OWNER_ADMIN = ['owner', 'admin'];

/* ── Seeds: a replayed copy, acceptances, a dispute and a revocation ── */

function ensureSeed(db: OrgDB) {
  const x = l3ext(db);
  const seeded = (x.seeded ??= {});
  if (seeded.crossorg || !isL3(db)) return;
  seeded.crossorg = true;
  const now = Date.now();
  const list = db.platform.crossOrg;
  const pending = (cpId: string, name: string, issuerOrgId: string, id: string, receivedAt?: number): CrossOrgReceipt =>
    ({ id, direction: 'received', counterpartyId: cpId, counterpartyName: name, issuerOrgId, issuerName: name, audience: '', seq: 0, receiptHash: '', kid: '', publicKey: '', sig: '', issuedAt: '', expiresAt: '', nonce: '', summary: 'Awaiting first verification', verification: { state: 'pending', steps: [] }, ...(receivedAt ? { receivedAt: iso(receivedAt) } : {}) });
  const admin = personFor(db.org.id, 'u_rahul');
  const owner = personFor(db.org.id, 'u_ananya');
  const byId = (id: string) => list.find((y) => y.id === id);
  if (db.org.id === 'org_kaveri') {
    // Northbank's first receipt arrives a second time with the same nonce: refused as RECEIPT_REPLAYED
    if (!byId('xr_org_northbank_0_resent')) list.push(pending('cp_northbank', 'Northbank Industrial Ltd', 'org_northbank', 'xr_org_northbank_0_resent', now - 3 * H));
    const deccan = byId('xr_org_deccan_0');
    if (deccan && !deccan.acceptance) deccan.acceptance = { state: 'pending', first: { userId: admin, at: iso(now - 5 * H), note: 'Balance confirmation matches our bank statement.' } };
    const nb1 = byId('xr_org_northbank_1');
    if (nb1 && !nb1.acceptance) nb1.acceptance = { state: 'accepted', first: { userId: admin, at: iso(now - 3 * D), note: 'Bill matches the purchase order.' }, second: { userId: owner, at: iso(now - 3 * D + 2 * H), note: 'Agreed.' } };
    // the dispute sits on the receipt Star Health holds a portal link for, so the portal shows it
    const star = list.filter((y) => y.direction === 'issued' && y.counterpartyId === 'cp_star');
    const disputed = star.find((y) => y.token) ?? star[0];
    if (disputed && !disputed.dispute && star.length > 1) disputed.dispute = { status: 'open', raisedAt: iso(now - 26 * H), raisedBy: STAR_DESK, side: 'counterparty', reason: 'Our claim file shows a different reviewer for this decision. Please confirm who approved it before we close the audit.' };
  } else if (db.org.id === 'org_deccan') {
    if (!byId('xr_org_kaveri_0_resent')) list.push(pending('cp_kaveri', 'Kaveri Health Network', 'org_kaveri', 'xr_org_kaveri_0_resent', now - 90 * 60_000));
    const kav = byId('xr_org_kaveri_0');
    if (kav && !kav.acceptance) kav.acceptance = { state: 'pending', first: { userId: admin, at: iso(now - 7 * H), note: 'Customer’s receipt checked against their pinned key.' } };
    // the revocation sits on the receipt RBI holds a portal link for, so the portal shows it (and the link's package is withdrawn)
    const rbi = list.filter((y) => y.direction === 'issued' && y.counterpartyId === 'cp_rbi');
    const wrong = rbi.find((y) => y.token) ?? rbi[0];
    if (wrong && !wrong.revoked && rbi.length > 1) revokeSeeded(db, wrong, admin, now - 2 * D);
  }
  seeded.crossorgPortal = true;
}

const STAR_DESK = 'Claims audit desk, Star Health';
const RBI_REASON = 'Issued against the wrong approval. The correct one was issued the same day.';

function revokeSeeded(db: OrgDB, x: CrossOrgReceipt, by: string, at: number) {
  x.revoked = { at: iso(at), by, reason: RBI_REASON };
  const pkg = x.disclosureId ? db.platform.disclosures.find((p) => p.id === x.disclosureId) : undefined;
  if (pkg) pkg.status = 'revoked';
}

/**
 * State saved before the seeds moved: the seeded Star Health dispute and RBI revocation were on the receipt without a
 * portal link, so the portal could not show them. Move each to the receipt with the link, once.
 */
function moveSeedsToPortal(db: OrgDB) {
  const seeded = (l3ext(db).seeded ??= {});
  if (seeded.crossorgPortal || !isL3(db)) return;
  seeded.crossorgPortal = true;
  const issuedTo = (cpId: string) => db.platform.crossOrg.filter((y) => y.direction === 'issued' && y.counterpartyId === cpId && y.id === `xi_${db.org.id}_${y.seq}_${cpId}`);
  if (db.org.id === 'org_kaveri') {
    const star = issuedTo('cp_star');
    const from = star.find((y) => !y.token && y.dispute?.raisedBy === STAR_DESK && y.dispute.seq === undefined);
    const to = star.find((y) => y.token && !y.dispute && !y.revoked);
    if (from && to) { to.dispute = from.dispute; delete from.dispute; }
  } else if (db.org.id === 'org_deccan') {
    const rbi = issuedTo('cp_rbi');
    const from = rbi.find((y) => !y.token && y.revoked?.reason === RBI_REASON && y.revoked.seq === undefined);
    const to = rbi.find((y) => y.token && !y.revoked);
    if (from && to) { revokeSeeded(db, to, from.revoked!.by, new Date(from.revoked!.at).getTime()); delete from.revoked; }
  }
  persist(db.org.id);
}

/**
 * Link received copies to the receipts their issuer holds as issued (peerId), so a revocation, dispute or withdrawal on
 * one side reaches the other. New issues are linked when they are made; this covers the seeded pairs and state saved
 * before they were linked. When the issuer in this console has no issued copy of the receipt, its issued record is
 * written from the copy that arrived (same seq, hash, signature and nonce). Arrival times are filled in (a copy that
 * arrived later, such as a replay, keeps its later time).
 */
function linkPeers(db: OrgDB) {
  if (!isL3(db)) return;
  crossOrgView(db.org.id); // resolves received copies built on first use
  const now = Date.now();
  const touched = new Set<string>();
  const mine = db.platform.crossOrg;
  for (const x of mine) {
    if (x.direction !== 'received' || !x.receipt || !x.receiptHash) continue;
    if (!x.receivedAt) { x.receivedAt = iso(Math.min(new Date(x.issuedAt).getTime() + 10 * 60_000, now - 5 * 60_000)); touched.add(db.org.id); }
    if (x.peerId || !ORGS.some((o) => o.id === x.issuerOrgId)) continue;
    const issuer = peekDB(x.issuerOrgId) ?? getDB(x.issuerOrgId);
    if (!isL3(issuer)) continue;
    const aud = `ar-org:${db.org.domain}`;
    let iss = issuer.platform.crossOrg.find((y) => y.direction === 'issued' && y.audience === aud && y.receiptHash === x.receiptHash);
    if (!iss) {
      const back = issuer.platform.counterparties.find((c) => c.orgId === db.org.id);
      if (!back) continue;
      iss = {
        id: `xi_${issuer.org.id}_${x.seq}_${back.id}`, direction: 'issued', counterpartyId: back.id, counterpartyName: back.name, issuerOrgId: issuer.org.id, issuerName: issuer.org.name, audience: aud,
        seq: x.seq, receiptHash: x.receiptHash, kid: x.kid, publicKey: x.publicKey, sig: x.sig, issuedAt: x.issuedAt, expiresAt: x.expiresAt, nonce: x.nonce, summary: x.summary,
        verification: { state: x.verification.state === 'pending' ? 'pending' : x.verification.state, checkedAt: x.verification.checkedAt, steps: [{ label: 'Delivered', state: 'pass', detail: `Delivered to ${back.name}; their verifier reported ${x.verification.state}.` }] },
      };
      issuer.platform.crossOrg.push(iss);
      back.issued++;
    } else if (iss.nonce !== x.nonce) {
      iss.nonce = x.nonce; // the nonce that arrived is the one both sides hold
    }
    x.peerId = iss.id;
    // a dispute or revocation made before the two were linked reaches the other side now
    if (x.dispute?.status === 'open' && !iss.dispute) iss.dispute = { ...x.dispute, raisedBy: x.dispute.side === 'receiver' ? `${userName(x.dispute.raisedBy)}, ${db.org.name}` : x.dispute.raisedBy };
    if (iss.revoked && !x.issuerRevoked) x.issuerRevoked = { at: iss.revoked.at, reason: iss.revoked.reason };
    touched.add(db.org.id);
    touched.add(issuer.org.id);
  }
  // a later copy of the same nonce arrived after the first one
  for (const x of mine) {
    if (x.direction !== 'received' || !x.receivedAt || !x.nonce) continue;
    const first = mine.find((y) => y !== x && y.direction === 'received' && y.issuerOrgId === x.issuerOrgId && y.nonce === x.nonce && y.id === x.id.replace(/_resent$/, ''));
    if (first?.receivedAt && x.id.endsWith('_resent') && new Date(x.receivedAt).getTime() <= new Date(first.receivedAt).getTime()) {
      const f = new Date(first.receivedAt).getTime();
      x.receivedAt = iso(f + Math.max(60_000, (now - f) / 2));
      touched.add(db.org.id);
    }
  }
  touched.forEach((id) => persist(id));
}

/** Seeds, peer links and the received copies' arrival times; called before each read of this organisation's cross-org receipts. */
export function prepareCrossOrg(orgId: string) {
  ready(getDB(orgId));
}

function ready(db: OrgDB) {
  ensureSeed(db);
  moveSeedsToPortal(db);
  linkPeers(db);
}

/* ── First receipt to a new audience ──────────────────────── */

export interface FirstIssueInfo {
  audience: string;
  first: boolean;
  /** receipts, packages and bundles already issued to this audience */
  prior: number;
  /** decisions in the last 30 days, for the tool of the receipt (when given) and overall */
  toolMonthly?: number;
  tool?: string;
  monthly: number;
  /** what this disclosure tells them over a year at that rate */
  yearly: number;
}

function priorTo(db: OrgDB, audience: string) {
  const x = l3ext(db);
  return db.platform.crossOrg.filter((y) => y.direction === 'issued' && y.audience === audience).length
    + db.platform.disclosures.filter((p) => p.audience === audience).length
    + (x.bundles ?? []).filter((b) => b.audience === audience).length;
}

export function firstIssueInfo(orgId: string, audience: string, seq?: number): FirstIssueInfo {
  const db = getDB(orgId);
  ready(db);
  const prior = priorTo(db, audience);
  const since = Date.now() - 30 * D;
  const recent = db.receipts.filter((r) => r.kind === 'decision' && new Date(r.ts).getTime() >= since);
  const tool = seq !== undefined ? db.receipts.find((r) => r.seq === seq)?.tool : undefined;
  const toolMonthly = tool ? recent.filter((r) => r.tool === tool).length : undefined;
  const monthly = toolMonthly ?? recent.length;
  return { audience, first: prior === 0, prior, tool, toolMonthly, monthly: recent.length, yearly: monthly * 12 };
}

/**
 * Before the first receipt, package or bundle to an audience: the person acknowledges the volume and reversal
 * warning, and that is recorded (counterparty.first_issue.acknowledged). Returns the receipt, or undefined when
 * the audience is not new.
 */
export function acknowledgeFirstIssue(orgId: string, audience: string, userId: string, what: string, seq?: number): Receipt | undefined {
  const info = firstIssueInfo(orgId, audience, seq);
  return info.first ? recordFirstIssueAck(orgId, info, userId, what) : undefined;
}

/** Write the acknowledgement for an issue already known to be the first to its audience (info taken before issuing). */
export function recordFirstIssueAck(orgId: string, info: FirstIssueInfo, userId: string, what: string): Receipt {
  return append(getDB(orgId), { kind: 'admin', actor: userId, action: 'counterparty.first_issue.acknowledged', details: { audience: info.audience, what, monthly_volume: info.toolMonthly ?? info.monthly, ...(info.tool ? { tool: info.tool } : {}) } });
}

/** Throw unless the warning was acknowledged for a first issue (used by the screens that show it). */
export function requireFirstIssueAck(orgId: string, audience: string, acknowledged: boolean | undefined) {
  if (acknowledged) return;
  if (firstIssueInfo(orgId, audience).first) throw new Error(`This is the first receipt to ${audience}. Read and acknowledge the volume and reversal warning before issuing.`);
}

/* ── Dual-control acceptance (receipt.accept) ─────────────── */

function receivedOf(db: OrgDB, id: string) {
  const x = db.platform.crossOrg.find((y) => y.id === id && y.direction === 'received');
  if (!x) throw new Error('No such received receipt.');
  return x;
}

/** One owner or admin starts accepting a received receipt; a different one completes it. Only a verified, current copy. */
export function acceptReceived(orgId: string, id: string, userId: string, note: string) {
  const db = getDB(orgId);
  requireL3(db, 'Accepting received receipts');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Accepting a received receipt');
  ready(db);
  const x = receivedOf(db, id);
  if (isReplayed(x)) throw new Error('This copy was refused as RECEIPT_REPLAYED: the first copy of its nonce is the one to accept.');
  if (x.issuerRevoked) throw new Error(`${x.issuerName} revoked this receipt; it cannot be accepted.`);
  if (x.dispute?.status === 'open') throw new Error('A dispute about this receipt is open. Resolve it first.');
  if (x.verification.state !== 'verified') throw new Error(`The recorded check is ${x.verification.state}. Verify and record it again; only a verified receipt can be accepted.`);
  const a = x.acceptance;
  if (a?.state === 'accepted') throw new Error(`Already accepted by ${userName(a.first?.userId)} and ${userName(a.second?.userId)}.`);
  if (a?.state === 'refused') throw new Error('Acceptance was refused. The refusal is on the record.');
  const text = note.trim();
  if (!a || a.state !== 'pending' || !a.first) {
    const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.accept_started', details: { from: x.issuerName, seq: x.seq, hash: x.receiptHash.slice(0, 16), required: 2, ...(text ? { note: text } : {}) } });
    x.acceptance = { state: 'pending', first: { userId, at: r.ts, seq: r.seq, ...(text ? { note: text } : {}) } };
  } else {
    if (a.first.userId === userId) throw new Error('You started this acceptance. A different owner or admin completes it.');
    const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.accepted', details: { from: x.issuerName, seq: x.seq, hash: x.receiptHash.slice(0, 16), first_by: a.first.userId, second_by: userId, ...(text ? { note: text } : {}) } });
    x.acceptance = { ...a, state: 'accepted', second: { userId, at: r.ts, seq: r.seq, ...(text ? { note: text } : {}) } };
  }
  touch(orgId, 'counterparty');
  return clone(x);
}

/** Refuse to accept (either person, with a reason). */
export function refuseAcceptance(orgId: string, id: string, userId: string, reason: string) {
  const db = getDB(orgId);
  requireL3(db, 'Accepting received receipts');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Refusing a received receipt');
  const x = receivedOf(db, id);
  const text = reason.trim();
  if (text.length < 8) throw new Error('Say why you refuse it — at least a sentence. It is recorded.');
  if (x.acceptance?.state === 'accepted') throw new Error('Already accepted by two people. Raise a dispute instead.');
  if (x.acceptance?.state === 'refused') throw new Error('Already refused.');
  const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.accept_refused', details: { from: x.issuerName, seq: x.seq, reason: text } });
  x.acceptance = { ...(x.acceptance ?? {}), state: 'refused', second: { userId, at: r.ts, seq: r.seq, note: text } };
  touch(orgId, 'counterparty');
  return clone(x);
}

/* ── Revoke and dispute ───────────────────────────────────── */

function issuedOf(db: OrgDB, id: string) {
  const x = db.platform.crossOrg.find((y) => y.id === id && y.direction === 'issued');
  if (!x) throw new Error('No such issued receipt.');
  return x;
}

/** The received copy in the other organisation, when it is in this console. */
function peerReceived(issuer: OrgDB, x: CrossOrgReceipt): { db: OrgDB; rec: CrossOrgReceipt } | undefined {
  const cp = issuer.platform.counterparties.find((c) => c.id === x.counterpartyId);
  if (!cp?.orgId) return undefined;
  const other = peekDB(cp.orgId) ?? getDB(cp.orgId);
  linkPeers(other);
  const match = other.platform.crossOrg.filter((y) => y.direction === 'received' && (y.peerId === x.id || (y.issuerOrgId === issuer.org.id && y.seq === x.seq && y.nonce === x.nonce)));
  // the copy that counts, not a replayed one
  const rec = match.find((y) => !isReplayed(y)) ?? match[0];
  return rec ? { db: other, rec } : undefined;
}

/** The issued receipt in the issuer's organisation, when it is in this console. */
function peerIssued(receiver: OrgDB, x: CrossOrgReceipt): { db: OrgDB; iss: CrossOrgReceipt } | undefined {
  if (!ORGS.some((o) => o.id === x.issuerOrgId)) return undefined;
  if (!x.peerId) linkPeers(receiver);
  const other = peekDB(x.issuerOrgId) ?? getDB(x.issuerOrgId);
  const iss = other.platform.crossOrg.find((y) => y.direction === 'issued' && (y.id === x.peerId || (y.seq === x.seq && y.nonce === x.nonce && y.audience === `ar-org:${receiver.org.domain}`)));
  return iss ? { db: other, iss } : undefined;
}

/** Every received copy in the receiver that came from this issued receipt (the first copy and any replayed one). */
function peerCopies(issuer: OrgDB, x: CrossOrgReceipt): { db: OrgDB; recs: CrossOrgReceipt[] } | undefined {
  const p = peerReceived(issuer, x);
  if (!p) return undefined;
  return { db: p.db, recs: p.db.platform.crossOrg.filter((y) => y.direction === 'received' && (y === p.rec || y.peerId === x.id)) };
}

/** The issuer revokes a receipt it issued (owner or admin, with a reason). Its share link stops; the receiver is told. */
export function revokeIssued(orgId: string, id: string, userId: string, reason: string) {
  const db = getDB(orgId);
  requireL3(db, 'Revoking issued receipts');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Revoking an issued receipt');
  ready(db);
  const x = issuedOf(db, id);
  if (x.revoked) throw new Error('This receipt is already revoked.');
  const text = reason.trim();
  if (text.length < 8) throw new Error('Say why you revoke it — at least a sentence. The counterparty sees it.');
  const pkg = x.disclosureId ? db.platform.disclosures.find((p) => p.id === x.disclosureId) : undefined;
  if (pkg && pkg.status !== 'revoked') pkg.status = 'revoked';
  const openDispute = x.dispute?.status === 'open';
  const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.revoked', details: { counterparty: x.counterpartyName, seq: x.seq, reason: text, ...(pkg ? { disclosure: pkg.id } : {}), ...(openDispute ? { dispute_closed: true } : {}) } });
  x.revoked = { at: r.ts, by: userId, reason: text, seq: r.seq };
  // revoking settles an open dispute about the receipt: closed on both sides, as the revocation
  if (openDispute && x.dispute) x.dispute = { ...x.dispute, status: 'upheld', closedBy: 'revocation', resolvedAt: r.ts, resolvedBy: userId, resolution: `Closed by the revocation: ${text}`, resolveSeq: r.seq };
  const peer = peerCopies(db, x);
  if (peer) {
    const rr = append(peer.db, { kind: 'admin', actor: 'system', action: 'counterparty.receipt.revocation_received', details: { from: db.org.name, seq: x.seq, reason: text, ...(peer.recs.some((y) => y.dispute?.status === 'open') ? { dispute_closed: true } : {}) } });
    for (const rec of peer.recs) {
      rec.issuerRevoked = { at: rr.ts, reason: text, seq: rr.seq };
      if (rec.dispute?.status === 'open') rec.dispute = { ...rec.dispute, status: 'upheld', closedBy: 'revocation', resolvedAt: rr.ts, resolvedBy: `${userName(userId)}, ${db.org.name}`, resolution: `Closed by the revocation: ${text}`, resolveSeq: rr.seq };
    }
    touch(peer.db.org.id, 'counterparty');
  }
  touch(orgId, 'counterparty');
  return { ...clone(x), peerTold: !!peer };
}

/** The receiver disputes a receipt it received (owner, admin or approver, with a reason). The issuer is told when it is here. */
export function disputeReceived(orgId: string, id: string, userId: string, reason: string) {
  const db = getDB(orgId);
  requireL3(db, 'Disputing received receipts');
  requireRoles(orgId, userId, ['owner', 'admin', 'approver'], 'Disputing a received receipt');
  ready(db);
  const x = receivedOf(db, id);
  if (x.dispute?.status === 'open') throw new Error('A dispute about this receipt is already open.');
  const text = reason.trim();
  if (text.length < 12) throw new Error('Say what you dispute — at least a sentence. The issuer sees it.');
  const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.disputed', details: { from: x.issuerName, seq: x.seq, reason: text } });
  const d: CrossOrgDispute = { status: 'open', raisedAt: r.ts, raisedBy: userId, side: 'receiver', reason: text, seq: r.seq };
  x.dispute = d;
  const peer = peerIssued(db, x);
  if (peer) {
    const rr = append(peer.db, { kind: 'admin', actor: 'system', action: 'counterparty.receipt.dispute_received', details: { from: db.org.name, seq: x.seq, reason: text } });
    peer.iss.dispute = { ...d, raisedBy: `${userName(userId)}, ${db.org.name}`, seq: rr.seq };
    touch(peer.db.org.id, 'counterparty');
  }
  touch(orgId, 'counterparty');
  return { receipt: clone(x), issuerTold: !!peer };
}

/** The issuer records a dispute a counterparty outside this console raised (by phone, email or its portal). */
export function recordDispute(orgId: string, id: string, userId: string, input: { raisedBy: string; reason: string }) {
  const db = getDB(orgId);
  requireL3(db, 'Disputes');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Recording a dispute');
  ready(db);
  const x = issuedOf(db, id);
  if (x.dispute?.status === 'open') throw new Error('A dispute about this receipt is already open.');
  const who = input.raisedBy.trim();
  const text = input.reason.trim();
  if (who.length < 3) throw new Error('Name who raised it at the counterparty.');
  if (text.length < 12) throw new Error('Write what they dispute — at least a sentence.');
  const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.dispute_recorded', details: { counterparty: x.counterpartyName, seq: x.seq, raised_by: who, reason: text } });
  x.dispute = { status: 'open', raisedAt: r.ts, raisedBy: who, side: 'counterparty', reason: text, seq: r.seq };
  touch(orgId, 'counterparty');
  return clone(x);
}

/** Public, from the portal page of an issued receipt: a signed-in counterparty raises a dispute. Recorded on the issuer's chain. */
export function disputeByToken(token: string, input: { name: string; reason: string }) {
  const org = ORGS.find((o) => o.slug === token.split('.')[0]);
  if (!org) throw new Error('This link is not valid.');
  const db = getDB(org.id);
  ready(db);
  const x = db.platform.crossOrg.find((y) => y.direction === 'issued' && y.token === token);
  if (!x) throw new Error('This shared record was not issued as a receipt, so there is nothing to dispute here. Contact the issuer.');
  if (x.revoked) throw new Error(`${org.name} already revoked this receipt.`);
  if (x.dispute?.status === 'open') throw new Error('A dispute about this receipt is already open with the issuer.');
  const text = input.reason.trim();
  if (text.length < 12) throw new Error('Write what you dispute — at least a sentence.');
  const r = append(db, { kind: 'admin', actor: 'system', action: 'counterparty.receipt.dispute_recorded', details: { counterparty: x.counterpartyName, seq: x.seq, raised_by: input.name, reason: text, via: 'portal' } });
  x.dispute = { status: 'open', raisedAt: r.ts, raisedBy: input.name, side: 'counterparty', reason: text, seq: r.seq };
  // the counterparty is also in this console: its copy shows the dispute it raised on the portal
  const peer = peerReceived(db, x);
  if (peer && peer.rec.dispute?.status !== 'open') {
    const rr = append(peer.db, { kind: 'admin', actor: 'system', action: 'counterparty.receipt.disputed', details: { from: org.name, seq: x.seq, reason: text, via: 'portal', raised_by: input.name } });
    peer.rec.dispute = { status: 'open', raisedAt: rr.ts, raisedBy: `${input.name} (on ${org.name}’s portal)`, side: 'receiver', reason: text, seq: rr.seq };
    touch(peer.db.org.id, 'counterparty');
  }
  touch(org.id, 'counterparty');
  return { seq: r.seq, issuer: org.name };
}

/** The dispute on a portal token's issued receipt, if any (public). */
export function standingByToken(token: string) {
  const org = ORGS.find((o) => o.slug === token.split('.')[0]);
  if (!org) return undefined;
  const db = getDB(org.id);
  ready(db);
  const x = db.platform.crossOrg.find((y) => y.direction === 'issued' && y.token === token);
  return x ? { issued: true, issuer: org.name, dispute: x.dispute ? clone(x.dispute) : undefined, revoked: x.revoked ? { at: x.revoked.at, reason: x.revoked.reason } : undefined } : undefined;
}

/**
 * Resolve an open dispute. On an issued receipt (the issuer decides): upheld revokes the receipt; rejected keeps it,
 * with the reason. On a received receipt (the receiver closes its side): upheld records that the issuer agreed;
 * rejected withdraws the dispute. Mirrored to the other organisation when it is in this console.
 */
export function resolveDispute(orgId: string, id: string, userId: string, outcome: 'upheld' | 'rejected', note: string) {
  const db = getDB(orgId);
  requireL3(db, 'Disputes');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Resolving a dispute');
  ready(db);
  const x = db.platform.crossOrg.find((y) => y.id === id);
  if (!x) throw new Error('No such receipt.');
  if (x.dispute?.status !== 'open') throw new Error('There is no open dispute on this receipt.');
  const text = note.trim();
  if (text.length < 8) throw new Error('Write what was decided and why — at least a sentence. Both sides see it.');
  // the receiver closing its side: when the issuer is in this console it decides the dispute there, so from here the
  // receiver can only withdraw; "the issuer agreed" is for an issuer outside this console
  const issuerPeer = x.direction === 'received' ? peerIssued(db, x) : undefined;
  if (x.direction === 'received' && outcome === 'upheld' && issuerPeer?.iss.dispute?.status === 'open') throw new Error(`${x.issuerName} is in this console and decides the dispute on its side. You can withdraw yours.`);
  const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.dispute_resolved', details: { [x.direction === 'issued' ? 'counterparty' : 'from']: x.direction === 'issued' ? x.counterpartyName : x.issuerName, seq: x.seq, outcome: x.direction === 'received' && outcome === 'rejected' ? 'withdrawn' : outcome, side: x.direction, note: text } });
  x.dispute = { ...x.dispute, status: outcome, closedBy: x.direction === 'issued' ? 'issuer' : 'receiver', resolvedAt: r.ts, resolvedBy: userId, resolution: text, resolveSeq: r.seq };
  let peerTold = false;
  if (x.direction === 'issued') {
    const peer = peerCopies(db, x);
    const open = peer?.recs.filter((y) => y.dispute?.status === 'open') ?? [];
    if (peer && open.length) {
      const rr = append(peer.db, { kind: 'admin', actor: 'system', action: 'counterparty.receipt.dispute_resolved', details: { from: db.org.name, seq: x.seq, outcome, side: 'issuer', note: text } });
      for (const rec of open) rec.dispute = { ...rec.dispute!, status: outcome, closedBy: 'issuer', resolvedAt: rr.ts, resolvedBy: `${userName(userId)}, ${db.org.name}`, resolution: text, resolveSeq: rr.seq };
      touch(peer.db.org.id, 'counterparty');
    }
    peerTold = !!peer;
    // upheld revokes the receipt (after the outcome reached the other side, so it reads as upheld there)
    if (outcome === 'upheld' && !x.revoked) revokeIssued(orgId, id, userId, `Dispute upheld: ${text}`);
  } else if (issuerPeer) {
    // the receiver withdrew (or recorded the issuer's agreement): the issuer's copy closes too, with the receiver's note
    const iss = issuerPeer.iss;
    if (iss.dispute?.status === 'open') {
      const rr = append(issuerPeer.db, { kind: 'admin', actor: 'system', action: 'counterparty.receipt.dispute_resolved', details: { counterparty: db.org.name, seq: x.seq, outcome: outcome === 'rejected' ? 'withdrawn' : outcome, side: 'received', note: text } });
      iss.dispute = { ...iss.dispute, status: outcome, closedBy: 'receiver', resolvedAt: rr.ts, resolvedBy: `${userName(userId)}, ${db.org.name}`, resolution: outcome === 'rejected' ? `Withdrawn by ${db.org.name}: ${text}` : text, resolveSeq: rr.seq };
      touch(issuerPeer.db.org.id, 'counterparty');
    }
    peerTold = true;
  }
  touch(orgId, 'counterparty');
  return { ...clone(db.platform.crossOrg.find((y) => y.id === id)!), peerTold };
}

/** Counts for the register's figures. */
export function standingCounts(orgId: string) {
  const db = getDB(orgId);
  ready(db);
  const c = { revoked: 0, disputes: 0, acceptPending: 0, replayed: 0 };
  for (const x of db.platform.crossOrg) {
    const s = standingOf(x);
    if (s === 'revoked') c.revoked++;
    if (s === 'disputed') c.disputes++;
    if (s === 'accept_pending') c.acceptPending++;
    if (s === 'replayed') c.replayed++;
  }
  return c;
}
