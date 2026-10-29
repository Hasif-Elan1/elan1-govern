/**
 * Notices from Elan1 to a hosted organisation: a named contact who receives them, an update at least every
 * 30 minutes while an incident that touches the organisation is open, a post-incident note once it is resolved,
 * planned maintenance, and a daily statement of the organisation's chain head that it can check against its
 * own chain. Kept with the organisation's records under an optional `tenantNotices` field (created on first
 * read). Sovereign deployments receive none of this over the network: nothing reaches them from outside.
 */
import type { OrgDB } from './db';
import { append, getDB, memberRole, touch } from './db';
import { nextMaintenance } from './opsMaintenance';
import { userName } from './users';
import { canonical, keyFromSeed, sha256Hex, signText, verifySig, type KeyPair } from '@/lib/crypto';
import { atLeast, levelOfOrg } from '@/lib/levels';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const IST = 5.5 * H;
const iso = (t: number) => new Date(t).toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

interface NoticeState {
  v: 1;
  contact?: { userId: string; since: string; by?: string; seq?: number };
  acks: Record<string, { at: string; by: string; seq: number }>;
  headChecks: Record<string, { at: string; by: string; result: 'matches' | 'differs'; seq: number }>;
}
type WithNotices = OrgDB & { tenantNotices?: NoticeState };

function state(d: OrgDB): NoticeState {
  const x = d as WithNotices;
  if (!x.tenantNotices || x.tenantNotices.v !== 1) x.tenantNotices = { v: 1, acks: {}, headChecks: {} };
  x.tenantNotices.acks ??= {};
  x.tenantNotices.headChecks ??= {};
  return x.tenantNotices;
}

let noticeKey: KeyPair | undefined;
/** Elan1's notice key: it signs the daily chain-head statements sent to every hosted organisation. */
export const NOTICE_KEY = () => (noticeKey ??= keyFromSeed('elan1:notices:2026', 'ntc_2026_10'));

export interface NoticeUpdate { at: string; text: string; kind: 'opened' | 'update' | 'resolved' }
export interface IncidentThread {
  id: string;
  title: string;
  startedAt: string;
  resolvedAt?: string;
  status: 'open' | 'resolved';
  impact: string;
  updates: NoticeUpdate[];
  postIncident?: { publishedAt?: string; dueBy: string; summary: string; cause: string; impactHere: string; changes: string[]; receiptsAffected: string };
}
export interface MaintenanceNotice { id: string; title: string; sentAt: string; from: string; to: string; note: string }
export interface ChainHeadStatement { id: string; date: string; org: string; seq: number; hash: string; at: string; digest: string; kid: string; sig: string; fingerprint: string }

export interface NoticesView {
  deliverable: boolean;
  orgName: string;
  contact: { userId: string; name: string; since: string; seq?: number; isDefault: boolean };
  incidents: IncidentThread[];
  maintenance: MaintenanceNotice[];
  heads: ChainHeadStatement[];
  acks: NoticeState['acks'];
  headChecks: NoticeState['headChecks'];
  noticeKey: { kid: string; fingerprint: string; publicKey: string };
}

const fmt = (t: number) => new Date(t + IST).toISOString().slice(11, 16);

/** The two incidents on Elan1's public status page, as windows (they match /status). */
function incidentWindows(now = Date.now()) {
  const y = new Date(now - D + IST);
  y.setUTCHours(9, 14, 0, 0);
  const tsaFrom = y.getTime() - IST;
  return {
    tsa: { from: tsaFrom, to: tsaFrom + (2 * 60 + 38) * M },
    wa: { from: now - 6 * D, to: now - 6 * D + 26 * M },
  };
}

/** Updates at least every 30 minutes from 5 minutes after the start until the incident is resolved. */
function thirtyMinuteUpdates(from: number, to: number | undefined, now: number, opened: string, update: (i: number, at: number) => string, resolved: string): NoticeUpdate[] {
  const out: NoticeUpdate[] = [{ at: iso(from + 5 * M), kind: 'opened', text: opened }];
  const end = Math.min(to ?? now, now);
  for (let t = from + 35 * M, i = 1; t < end; t += 30 * M, i++) out.push({ at: iso(t), kind: 'update', text: update(i, t) });
  if (to !== undefined && to <= now) out.push({ at: iso(to), kind: 'resolved', text: resolved });
  return out;
}

function contactOf(d: OrgDB, s: NoticeState) {
  const active = (id?: string) => !!id && d.members.some((m) => m.userId === id && m.status === 'active');
  if (s.contact && active(s.contact.userId)) return { ...s.contact, isDefault: false };
  const owner = d.members.find((m) => m.role === 'owner' && m.status === 'active')?.userId ?? d.members[0]?.userId ?? '';
  return { userId: owner, since: d.org.createdAt, isDefault: true };
}

export function noticesView(orgId: string): NoticesView {
  const d = getDB(orgId);
  const s = state(d);
  const now = Date.now();
  const k = NOTICE_KEY();
  const c = contactOf(d, s);
  const base = { orgName: d.org.name, contact: { userId: c.userId, name: userName(c.userId), since: c.since, seq: (c as { seq?: number }).seq, isDefault: c.isDefault }, acks: clone(s.acks), headChecks: clone(s.headChecks), noticeKey: { kid: k.kid, fingerprint: k.fingerprint, publicKey: k.publicKeyHex } };
  if (d.org.deployment === 'sovereign') return { ...base, deliverable: false, incidents: [], maintenance: [], heads: [] };

  const created = new Date(d.org.createdAt).getTime();
  const lv = levelOfOrg(d.org);
  const w = incidentWindows(now);
  const incidents: IncidentThread[] = [];

  // eMudhra unreachable: touches organisations whose batches are timestamped (L2 and above)
  if (atLeast(lv, 'l2') && w.tsa.from > created) {
    const inWindow = d.receipts.filter((r) => { const t = new Date(r.ts).getTime(); return t >= w.tsa.from && t <= w.tsa.to; }).length;
    const batches = Math.ceil((w.tsa.to - w.tsa.from) / (15 * M));
    incidents.push({
      id: `inc_tsa_${new Date(w.tsa.from + IST).toISOString().slice(0, 10)}`, title: 'eMudhra timestamp authority unreachable', startedAt: iso(w.tsa.from), resolvedAt: w.tsa.to <= now ? iso(w.tsa.to) : undefined, status: w.tsa.to <= now ? 'resolved' : 'open',
      impact: `Your batches keep their DigiCert timestamp; the India timestamp is added when eMudhra answers. ${inWindow} of your records fall in the window.`,
      updates: thirtyMinuteUpdates(w.tsa.from, w.tsa.to, now,
        `We are investigating: timestamp requests to eMudhra have timed out since ${fmt(w.tsa.from)} IST. Your records are sealed and signed as usual; DigiCert is timestamping each batch. Next update within 30 minutes.`,
        (i, t) => `Update ${i}: eMudhra is still not answering. ${Math.min(batches, Math.ceil((t - w.tsa.from) / (15 * M)))} of your batches are waiting for the India timestamp; none has missed its DigiCert timestamp. Next update by ${fmt(t + 30 * M)} IST.`,
        `Resolved at ${fmt(w.tsa.to)} IST: eMudhra is answering again and every waiting batch now has both timestamps. No record was lost or re-signed. A post-incident note follows within one working day.`),
      postIncident: {
        dueBy: iso(w.tsa.to + 24 * H), publishedAt: w.tsa.to + 20 * H <= now ? iso(w.tsa.to + 20 * H) : undefined,
        summary: `For 2 hours 38 minutes eMudhra’s RFC 3161 service did not answer. Batches closed in that window were timestamped by DigiCert within 15 minutes as usual and by eMudhra late, once it answered.`,
        cause: 'A certificate rotation at eMudhra left its load balancer refusing connections from our address range. We could not have prevented it; we could have told you sooner.',
        impactHere: `${inWindow} of your records were in batches that carried one timestamp for up to 2 hours 38 minutes. Every one of them has both timestamps now.`,
        changes: ['The anchoring worker now pages our on-call after two missed eMudhra answers, not five.', 'Your named contact gets the first notice within 5 minutes of the start, as here, and an update at least every 30 minutes.', 'We are adding a third authority in India so one outage never leaves a batch with a single timestamp.'],
        receiptsAffected: 'None changed. Timestamps are added to batches; receipts are never rewritten.',
      },
    });
  }
  // WhatsApp delays: touches organisations where someone receives approvals on WhatsApp
  const usesWa = d.members.some((m) => m.status === 'active' && m.whatsappVerified);
  if (usesWa && w.wa.from > created) {
    const held = d.approvals.filter((a) => { const t = new Date(a.createdAt).getTime(); return t >= w.wa.from && t <= w.wa.to && a.notified?.includes('whatsapp'); }).length;
    incidents.push({
      id: `inc_wa_${new Date(w.wa.from + IST).toISOString().slice(0, 10)}`, title: 'WhatsApp approval messages delayed', startedAt: iso(w.wa.from), resolvedAt: iso(w.wa.to), status: 'resolved',
      impact: `Approval messages on WhatsApp arrived up to 9 minutes late. Email, Slack and the console were not affected. ${held} held action${held === 1 ? '' : 's'} of yours were notified on WhatsApp in the window.`,
      updates: thirtyMinuteUpdates(w.wa.from, w.wa.to, now,
        'WhatsApp notifications for held actions are delayed. Approve from the console or the email link meanwhile; nothing expires early. Next update within 30 minutes.',
        (i, t) => `Update ${i}: still delayed. Next update by ${fmt(t + 30 * M)} IST.`,
        'Resolved: WhatsApp delivery is back to normal. A post-incident note follows within one working day.'),
      postIncident: {
        dueBy: iso(w.wa.to + 24 * H), publishedAt: iso(w.wa.to + 18 * H),
        summary: 'For 26 minutes the WhatsApp Business Platform queued our template messages and delivered them up to 9 minutes late.',
        cause: 'Rate limiting on Meta’s side after a template category review. Our sends were within limits.',
        impactHere: `${held} held action${held === 1 ? ' was' : 's were'} notified late on WhatsApp. None expired because of it, and every decision is on its approval receipt with its channel.`,
        changes: ['Held actions waiting more than 5 minutes for a WhatsApp delivery are now also sent by email.', 'The status page shows WhatsApp delivery as its own line under Delivery.'],
        receiptsAffected: 'None. Approval receipts record the channel each decision came from.',
      },
    });
  }
  incidents.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const mw = nextMaintenance(now);
  const maintenance: MaintenanceNotice[] = mw ? [{ id: `mn_${mw.id}`, title: mw.title, sentAt: iso(Math.max(created, new Date(mw.from).getTime() - 7 * D)), from: mw.from, to: mw.to, note: mw.note }] : [];

  // the daily chain head: the last receipt on or before 23:59:59 IST each day, for the last 14 days
  const heads: ChainHeadStatement[] = [];
  const today = new Date(now + IST);
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 1; i <= 14; i++) {
    const dayEnd = today.getTime() - IST - (i - 1) * D - 1;
    if (dayEnd < created) break;
    const date = new Date(dayEnd + IST).toISOString().slice(0, 10);
    let head = d.receipts[0];
    for (const r of d.receipts) { if (new Date(r.ts).getTime() <= dayEnd) head = r; else break; }
    if (!head || new Date(head.ts).getTime() > dayEnd) continue;
    const body = { format: 'elan1.chain_head.v1', org: d.org.id, date, seq: head.seq, hash: head.hash };
    const digest = sha256Hex(canonical(body));
    heads.push({ id: `ch_${date}`, date, org: d.org.id, seq: head.seq, hash: head.hash, at: iso(dayEnd + 1 + 15 * M), digest, kid: k.kid, sig: signText(digest, k), fingerprint: k.fingerprint });
  }

  return { ...base, deliverable: true, incidents, maintenance, heads };
}

function requireMember(d: OrgDB, userId: string) {
  const role = memberRole(d.org.id, userId);
  if (!role) throw new Error('Only members of this organisation can do this.');
  return role;
}

/** Name the person who receives Elan1's notices. Owners and admins. Writes notice.contact_changed. */
export function setNoticeContact(orgId: string, contactId: string, userId: string) {
  const d = getDB(orgId);
  if (d.org.deployment === 'sovereign') throw new Error('Elan1 cannot reach a Sovereign deployment, so it sends no notices to name a contact for.');
  const role = requireMember(d, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins name the contact for Elan1’s notices.');
  const m = d.members.find((x) => x.userId === contactId && x.status === 'active');
  if (!m || m.role === 'auditor') throw new Error('Choose an active member of this organisation (not an auditor).');
  const s = state(d);
  const prev = contactOf(d, s).userId;
  if (prev === contactId && !contactOf(d, s).isDefault) throw new Error(`${userName(contactId)} is already the named contact.`);
  const r = append(d, { kind: 'admin', actor: userId, action: 'notice.contact_changed', details: { contact: userName(contactId), previous: userName(prev) } });
  s.contact = { userId: contactId, since: r.ts, by: userId, seq: r.seq };
  touch(orgId, 'notice');
  return { seq: r.seq };
}

/** Acknowledge a notice (the named contact, owners and admins). Writes notice.acknowledged. */
export function acknowledgeNotice(orgId: string, noticeId: string, title: string, userId: string) {
  const d = getDB(orgId);
  const role = requireMember(d, userId);
  const s = state(d);
  const contact = contactOf(d, s).userId;
  if (userId !== contact && role !== 'owner' && role !== 'admin') throw new Error('The named contact, owners and admins acknowledge Elan1’s notices.');
  if (s.acks[noticeId]) throw new Error('Already acknowledged.');
  const r = append(d, { kind: 'admin', actor: userId, action: 'notice.acknowledged', details: { notice: noticeId, title: title.slice(0, 100) } });
  s.acks[noticeId] = { at: r.ts, by: userId, seq: r.seq };
  touch(orgId, 'notice');
  return { seq: r.seq };
}

/** Check a daily chain-head statement against this organisation's own chain. Writes notice.chain_head_checked. */
export function checkChainHead(orgId: string, statementId: string, userId: string) {
  const d = getDB(orgId);
  requireMember(d, userId);
  const v = noticesView(orgId);
  const st = v.heads.find((h) => h.id === statementId);
  if (!st) throw new Error('No such statement.');
  const s = state(d);
  if (s.headChecks[st.date]) throw new Error('This day’s statement has already been checked.');
  const sigOk = sha256Hex(canonical({ format: 'elan1.chain_head.v1', org: st.org, date: st.date, seq: st.seq, hash: st.hash })) === st.digest && verifySig(st.digest, st.sig, v.noticeKey.publicKey);
  const mine = d.receipts.find((r) => r.seq === st.seq);
  const result: 'matches' | 'differs' = sigOk && !!mine && mine.hash === st.hash ? 'matches' : 'differs';
  const r = append(d, { kind: 'admin', actor: userId, action: 'notice.chain_head_checked', details: { date: st.date, seq: st.seq, result, statement_verifies: sigOk } });
  s.headChecks[st.date] = { at: r.ts, by: userId, result, seq: r.seq };
  touch(orgId, 'notice');
  return { seq: r.seq, result, sigOk };
}
