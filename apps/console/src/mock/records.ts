/**
 * Records door additions (mock backend):
 *  - the DPDP consent ledger: consents per data principal and purpose, withdrawals, and G1, the consent check that
 *    reads it on every live call that writes to a person (registered with the guard in db.ts as a recorded check);
 *  - the erasure plan shown before a request is opened, and the refusal recorded when statutory retention conflicts;
 *  - withdrawing a declaration (rulebook) version, so calls made afterwards never use it;
 *  - a gap in the chain recorded as a sealed gap record;
 *  - model name and version on agents and AI systems, and the RBI model-documentation export;
 *  - hosting profile 2: a dedicated residency domain (L2 and above).
 *
 * State lives on the organisation's platform state under `recordsLedger`. Every field is optional on read, so state
 * saved before this file existed loads unchanged. Every recorded write appends an admin receipt to the chain.
 */
import type { Agent, AiSystem, ErasureRequest, LevelId, PackId, Receipt, Rulebook, RulebookVersion } from '@/types';
import { canonical, sha256Hex } from '@/lib/crypto';
import { makeRand } from '@/lib/prng';
import { LEVEL_INFO, atLeast, levelOfOrg } from '@/lib/levels';
import { packById } from '@/lib/packs';
import { buildPdf, type PdfBlock } from '@/lib/pdf';
import { LEGAL_ENTITY } from '@/lib/company';
import { addRecordedCheck, append, getDB, memberRole, touch, type OrgDB } from './db';
import { rulebookAt } from './chain';
import { replayOnOf } from './orgSettings';
import { userName } from './users';
import { ensureDeclSeed } from './recordsDecl';

const H = 3_600_000;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wait = (min = 120, max = 320) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const rid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const norm = (s: string) => s.trim().toLowerCase();
const seedOf = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/* ══ Types ═══════════════════════════════════════════════════════════════ */

export type ConsentChannel = 'email' | 'sms' | 'call' | 'whatsapp' | 'app' | 'any';
export const CHANNEL_LABEL: Record<ConsentChannel, string> = { email: 'Email', sms: 'SMS', call: 'Phone call', whatsapp: 'WhatsApp', app: 'In the app', any: 'Any channel' };

export interface ConsentPurpose {
  id: string;
  label: string;
  /** consent: asked and withdrawable. legitimate_use: a use the DPDP Act names (s.7); no consent is asked. */
  basis: 'consent' | 'legitimate_use';
  principals: string;
  channels: ConsentChannel[];
  description: string;
  /** a regulatory pack whose G1 rule reads this purpose */
  pack?: PackId;
}

export interface ConsentEntry {
  id: string;
  /** the organisation's own reference for the data principal (customer number, case number) */
  principalRef: string;
  /** a masked hint of the identifier; the identifier itself is never stored */
  hint: string;
  /** SHA-256 of the normalised identifier (an email address, a domain, a phone number) */
  principalHash: string;
  principalGroup: string;
  purposeId: string;
  channel: ConsentChannel;
  noticeVersion: string;
  givenAt: string;
  givenVia: string;
  expiresAt?: string;
  status: 'active' | 'withdrawn';
  recordedBy: string;
  seq?: number;
  /** brought in from the consent manager's export when the ledger was switched on */
  imported?: boolean;
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawnVia?: string;
  withdrawalReason?: string;
  withdrawSeq?: number;
}

export interface G1Result {
  result: 'passed' | 'refused';
  code: 'G1_PASS' | 'G1_LEGITIMATE_USE' | 'G1_NO_CONSENT' | 'G1_WITHDRAWN' | 'G1_EXPIRED' | 'G1_CHANNEL';
  detail: string;
  consentId?: string;
  purpose: string;
  checkedAt: string;
}

export interface RetentionBasis { law: 'GST' | 'MCA' | 'PMLA'; cite: string; label: string; years: number }

export interface ErasurePlan {
  identifierHash: string;
  computedAt: string;
  matched: number;
  erasable: number[];
  held: { seq: number; tool: string; until: string; bases: RetentionBasis['law'][] }[];
  fields: { name: string; receipts: number }[];
  systems: { kind: 'connector' | 'agent' | 'ai_system' | 'store'; name: string; to?: string; receipts?: number; note: string }[];
  exports: { id: string; ts: string; firstSeq: number; lastSeq: number; covered: number; format: string }[];
  consents: { id: string; purpose: string; status: ConsentEntry['status'] }[];
  bases: (RetentionBasis & { receipts: number; holdUntil: string })[];
  outcome: 'proceed' | 'partial' | 'refused' | 'nothing';
  digest: string;
}

export interface ErasureRefusal {
  id: string;
  subjectRef: string;
  subjectHash: string;
  reason: string;
  requestedBy: string;
  at: string;
  matched: number;
  bases: RetentionBasis['law'][];
  holdUntil: string;
  planDigest: string;
  seq?: number;
}

export type GapCause = 'sdk_offline' | 'receipt_write' | 'connector_outage' | 'migration' | 'other';
export const GAP_CAUSE_LABEL: Record<GapCause, string> = {
  sdk_offline: 'Advisory agents could not reach the decision service',
  receipt_write: 'Receipt write path unavailable',
  connector_outage: 'Connector outage',
  migration: 'Data migration or import',
  other: 'Other cause',
};

export interface GapRecord {
  id: string;
  from: string;
  to: string;
  cause: GapCause;
  summary: string;
  agents: string[];
  estimatedMissed: number;
  /** the last receipt written before the window opened */
  lastSeqBefore?: number;
  /** receipts that exist inside the window (expected 0 for the affected agents) */
  receiptsInWindow: number;
  incidentId?: string;
  sealedBy: string;
  sealedAt: string;
  digest: string;
  seq?: number;
}

export interface ModelDocExport { id: string; at: string; by: string; systems: number; format: 'pdf' | 'json'; digest: string; seq?: number; filename: string }

export interface DedicatedDomain {
  status: 'provisioning' | 'active' | 'returned';
  region: string;
  domain: string;
  requestedBy: string;
  requestedAt: string;
  requestSeq?: number;
  activatedBy?: string;
  activatedAt?: string;
  activateSeq?: number;
  returnedBy?: string;
  returnedAt?: string;
  returnSeq?: number;
  reason?: string;
}

interface RecordsLedgerState {
  consents: ConsentEntry[];
  consentsSeeded?: boolean;
  /** the ledger was brought in line with live G1 checks (every address the agents write to has an entry; seeded dates fit the chain) */
  g1Live?: boolean;
  gaps: GapRecord[];
  gapsSeeded?: boolean;
  plans: Record<string, ErasurePlan>;
  refusals: ErasureRefusal[];
  refusalsSeeded?: boolean;
  withdrawalsSeeded?: boolean;
  modelsSeeded?: boolean;
  modelDocs: ModelDocExport[];
  hosting: { dedicated?: DedicatedDomain; seeded?: boolean };
}

function st(d: OrgDB): RecordsLedgerState {
  const p = d.platform as unknown as { recordsLedger?: Partial<RecordsLedgerState> };
  const x = (p.recordsLedger ??= {});
  x.consents ??= [];
  x.gaps ??= [];
  x.plans ??= {};
  x.refusals ??= [];
  x.modelDocs ??= [];
  x.hosting ??= {};
  return x as RecordsLedgerState;
}

function requireManager(orgId: string, userId: string, what: string) {
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error(`${what} — owners and admins can do this; your role cannot.`);
}

const ownerOf = (d: OrgDB) => d.members.find((m) => m.role === 'owner' && m.status === 'active')?.userId ?? 'system';
const adminOf = (d: OrgDB) => d.members.find((m) => m.role === 'admin' && m.status === 'active')?.userId ?? ownerOf(d);

/** "Sealed in a hash chain" at L1, "signed" from L2 (the wording rule for receipts). */
export function claimWord(level: LevelId) {
  return atLeast(level, 'l2') ? 'signed' : 'sealed in the hash chain';
}

/* ══ Seeding (once per organisation; a seeded organisation shows every feature) ══ */

/** Fill the demo data this file owns. Safe to call on every read: each part runs once. */
export function ensureRecordsSeed(orgId: string) {
  const d = getDB(orgId);
  const s = st(d);
  // erasure requests opened before plans existed get one, with statutory retention held back (cheap; runs on every read)
  try { reconcileErasures(d, s); } catch { /* never blocks a read */ }
  // declarations other than rulebooks (agent and pack declarations): mock/recordsDecl.ts keeps its own flags
  try { ensureDeclSeed(d); } catch { /* fine */ }
  if (d.fresh) {
    // an organisation created by sign-up starts empty
    s.consentsSeeded = s.gapsSeeded = s.refusalsSeeded = s.withdrawalsSeeded = s.modelsSeeded = s.g1Live = true;
    s.hosting.seeded = true;
    return d;
  }
  const steps: [keyof RecordsLedgerState | 'hosting', () => void][] = [
    ['modelsSeeded', () => seedModels(d)],
    ['consentsSeeded', () => seedConsents(d, s)],
    ['g1Live', () => alignLedgerWithChain(d, s)],
    ['gapsSeeded', () => seedGap(d, s)],
    ['refusalsSeeded', () => seedRefusal(d, s)],
    ['withdrawalsSeeded', () => seedWithdrawal(d)],
  ];
  for (const [flag, run] of steps) {
    if ((s as unknown as Record<string, unknown>)[flag]) continue;
    (s as unknown as Record<string, unknown>)[flag] = true;
    try { run(); } catch { /* a seed step never blocks a read */ }
  }
  if (!s.hosting.seeded) {
    s.hosting.seeded = true;
    try { seedHosting(d, s); } catch { /* fine */ }
  }
  return d;
}

/* ══ Model name and version ══════════════════════════════════════════════ */

const BY_FRAMEWORK: Record<Agent['framework'], { name: string; version: string }> = {
  Claude: { name: 'Claude Sonnet 4.5', version: 'claude-sonnet-4-5-20250929' },
  Cursor: { name: 'Claude Sonnet 4.5 (through Cursor)', version: 'claude-sonnet-4-5-20250929' },
  LangChain: { name: 'Llama 3.1 70B Instruct', version: 'meta.llama3-1-70b-instruct-v1:0' },
  'OpenAI Agents SDK': { name: 'GPT-4.1', version: 'gpt-4.1-2025-04-14' },
  Custom: { name: 'In-house classifier', version: 'v2.3.1' },
};

function modelForVendor(vendor: string, name: string): { name: string; version: string } {
  if (/anthropic/i.test(vendor)) return BY_FRAMEWORK.Claude;
  if (/openai|microsoft/i.test(vendor)) return { name: 'GPT-4o', version: 'gpt-4o-2024-08-06' };
  if (/google/i.test(vendor)) return { name: 'Gemini 1.5 Pro', version: 'gemini-1.5-pro-002' };
  if (/in-house|internal|own/i.test(vendor)) return { name: `${name.split(/\s+/)[0]} model (in-house)`, version: 'v1.4.0' };
  return { name: `${vendor} managed model`, version: 'Not disclosed by the vendor' };
}

/** The model behind an agent or AI system, or undefined when nobody has recorded it. */
export function modelOf(x: { modelName?: string; modelVersion?: string } | undefined): { name: string; version: string } | undefined {
  if (!x?.modelName) return undefined;
  return { name: x.modelName, version: x.modelVersion || 'Not recorded' };
}

function seedModels(d: OrgDB) {
  for (const a of d.agents) {
    if (a.modelName) continue;
    const m = BY_FRAMEWORK[a.framework] ?? BY_FRAMEWORK.Custom;
    a.modelName = m.name;
    a.modelVersion = m.version;
  }
  for (const s of d.aiSystems) {
    if (s.modelName) continue;
    const agent = d.agents.find((a) => a.id === s.linkedAgentId);
    const m = agent?.modelName ? { name: agent.modelName, version: agent.modelVersion ?? '' } : modelForVendor(s.vendor, s.name);
    s.modelName = m.name;
    s.modelVersion = m.version;
  }
}

/** Record the model name and version of an agent (its linked AI system follows) or of an AI system. */
export function setModel(orgId: string, target: { kind: 'agent' | 'ai_system'; id: string }, input: { name: string; version: string }, userId: string) {
  const d = ensureRecordsSeed(orgId);
  const name = input.name.trim();
  const version = input.version.trim();
  if (name.length < 2) throw new Error('Name the model, for example “Claude Sonnet 4.5”.');
  if (!version) throw new Error('Give the version or snapshot the system runs, for example “2025-09-29”. “Not disclosed by the vendor” is an answer too.');
  if (target.kind === 'agent') {
    requireManager(orgId, userId, 'Recording an agent’s model');
    const a = d.agents.find((x) => x.id === target.id || x.slug === target.id);
    if (!a) throw new Error('No such agent in this organisation.');
    const before = a.modelName ? `${a.modelName} ${a.modelVersion ?? ''}`.trim() : 'none';
    a.modelName = name;
    a.modelVersion = version;
    const sys = d.aiSystems.find((x) => x.linkedAgentId === a.id || x.id === a.aiSystemId);
    if (sys) { sys.modelName = name; sys.modelVersion = version; }
    const r = append(d, { kind: 'admin', actor: userId, action: 'agent.model_recorded', agent: a.slug, details: { model: name, version, previous: before, ...(sys ? { system: sys.name } : {}) } });
    return { seq: r.seq, agent: clone(a as Agent) };
  }
  requireManager(orgId, userId, 'Recording an AI system’s model');
  const s = d.aiSystems.find((x) => x.id === target.id);
  if (!s) throw new Error('No such AI system in this organisation.');
  const before = s.modelName ? `${s.modelName} ${s.modelVersion ?? ''}`.trim() : 'none';
  s.modelName = name;
  s.modelVersion = version;
  const r = append(d, { kind: 'admin', actor: userId, action: 'inventory.model_recorded', details: { system: s.name, model: name, version, previous: before } });
  return { seq: r.seq, system: clone(s as AiSystem) };
}

/* ══ Consent ledger (DPDP) ═══════════════════════════════════════════════ */

const BASE_PURPOSES: ConsentPurpose[] = [
  { id: 'service_contact', label: 'Service and account messages', basis: 'consent', principals: 'Customers', channels: ['email', 'sms', 'whatsapp'], description: 'Messages about an account, an order or an invoice, on the channel the person chose.' },
  { id: 'ai_processing', label: 'AI-assisted handling of messages', basis: 'consent', principals: 'Customers', channels: ['any'], description: 'An agent reads the person’s messages and drafts the reply a person or rule then decides on.' },
  { id: 'marketing', label: 'Offers and newsletters', basis: 'consent', principals: 'Customers', channels: ['email', 'sms', 'whatsapp'], description: 'Promotional messages. Asked separately and never bundled with service messages.' },
];

const INDUSTRY_PURPOSES: Partial<Record<string, ConsentPurpose[]>> = {
  finance: [
    { id: 'collections_contact', label: 'Collections contact on overdue accounts', basis: 'consent', principals: 'Borrowers', channels: ['email', 'sms', 'call'], pack: 'collect1', description: 'Reminders about an overdue amount, only on the channel and at the times the person agreed to.' },
    { id: 'kyc', label: 'KYC and anti-money-laundering checks', basis: 'legitimate_use', principals: 'Customers', channels: ['any'], description: 'Required by law (DPDP Act, s.7). No consent is asked, so none can be withdrawn; the use is still listed here.' },
  ],
  healthcare: [
    { id: 'care_coordination', label: 'Care coordination messages', basis: 'consent', principals: 'Patients', channels: ['email', 'sms', 'whatsapp'], description: 'Appointment, referral and discharge messages, on the channel the patient chose.' },
    { id: 'research', label: 'De-identified records in clinical research', basis: 'consent', principals: 'Patients', channels: ['any'], description: 'Use of the patient’s de-identified records in approved research. Withdrawal stops any new use.' },
  ],
  general: [
    { id: 'vendor_contact', label: 'Vendor contact persons', basis: 'consent', principals: 'Vendor contacts', channels: ['email', 'call'], description: 'Purchase orders, remittance advice and queries sent to a named person at a vendor.' },
    { id: 'recruitment', label: 'Processing a job application', basis: 'consent', principals: 'Job applicants', channels: ['email'], description: 'Reading a CV and writing to the applicant. Kept 6 months after the role is filled unless the person agrees to longer.' },
  ],
};

export function purposesFor(d: OrgDB): ConsentPurpose[] {
  return [...BASE_PURPOSES, ...(INDUSTRY_PURPOSES[d.org.industry] ?? INDUSTRY_PURPOSES.general ?? [])];
}

function maskHint(identifier: string) {
  const v = identifier.trim();
  if (v.includes('@')) { const [u, dom] = v.split('@'); return `${u.slice(0, 2)}…@${dom}`; }
  if (/^\+?\d[\d\s-]{6,}$/.test(v)) return `…${v.replace(/\D/g, '').slice(-4)}`;
  return v.length <= 6 ? `${v.slice(0, 2)}…` : `${v.slice(0, 3)}…${v.slice(-4)}`;
}

/** Identifiers the chain holds (email domains and addresses written to), with how often each appears. */
function chainIdentifiers(d: OrgDB) {
  const counts = new Map<string, number>();
  for (const r of d.receipts) {
    if (r.kind !== 'decision' || r.redacted) continue;
    const dom = r.args_summary?.to_domain;
    if (typeof dom === 'string' && dom.includes('.')) counts.set(norm(dom), (counts.get(norm(dom)) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

/** One decision receipt that named an identifier: when, which, and whether it was refused (a refused call relied on nothing). */
interface Use { t: number; seq: number; refused: boolean }
const relianceCache = new Map<string, { key: string; idx: Map<string, Use[]> }>();

/** For every identifier the decision receipts carry (hashed): the calls that touched it, oldest first. */
function relianceIndex(d: OrgDB) {
  const head = d.receipts[d.receipts.length - 1];
  const key = `${d.receipts.length}:${head?.seq}`;
  const hit = relianceCache.get(d.org.id);
  if (hit && hit.key === key) return hit.idx;
  const idx = new Map<string, Use[]>();
  const tail = d.receipts.slice(-4000);
  for (const r of tail) {
    if (r.kind !== 'decision' || r.redacted || !r.args_summary) continue;
    const seen = new Set<string>();
    const use: Use = { t: new Date(r.ts).getTime(), seq: r.seq, refused: r.decision === 'refuse' };
    for (const v of Object.values(r.args_summary)) {
      if (typeof v !== 'string' || v.length < 3 || v.length > 80) continue;
      const vals = [norm(v)];
      if (v.includes('@')) vals.push(norm(v.split('@')[1]));
      for (const x of vals) {
        if (seen.has(x)) continue;
        seen.add(x);
        const h = sha256Hex(x);
        const list = idx.get(h) ?? [];
        list.push(use);
        idx.set(h, list);
      }
    }
  }
  relianceCache.set(d.org.id, { key, idx });
  return idx;
}

/** The calls a consent covered: not refused, made after it was given and before it was withdrawn (or now). */
function coveredBy(e: ConsentEntry, idx: Map<string, Use[]>) {
  const from = new Date(e.givenAt).getTime();
  const to = e.withdrawnAt ? new Date(e.withdrawnAt).getTime() : Number.POSITIVE_INFINITY;
  const uses = (idx.get(e.principalHash) ?? []).filter((u) => !u.refused && u.t >= from && u.t <= to);
  return { count: uses.length, lastSeq: uses.length ? Math.max(...uses.map((u) => u.seq)) : undefined };
}

/** The purpose G1 checks on a live call that writes to a person: the organisation's contact purpose. */
export function contactPurposeOf(d: OrgDB): ConsentPurpose {
  const purposes = purposesFor(d).filter((p) => p.basis === 'consent');
  return purposes.find((p) => p.id === 'collections_contact') ?? purposes.find((p) => p.id === 'vendor_contact') ?? purposes.find((p) => p.id === 'care_coordination') ?? purposes[0];
}

/** First and last call (any decision) that named an identifier, by its hash. */
function usesOf(idx: Map<string, Use[]>, identifier: string) {
  const list = idx.get(sha256Hex(norm(identifier))) ?? [];
  return { first: list.length ? Math.min(...list.map((u) => u.t)) : undefined, last: list.length ? Math.max(...list.map((u) => u.t)) : undefined };
}

/** Email domains the organisation itself uses are not data principals' identifiers. */
function ownDomain(d: OrgDB, identifier: string) {
  const own = [(d.org as { domain?: string }).domain, `${d.org.slug.split('-')[0]}.in`].filter(Boolean).map((x) => norm(String(x)));
  return own.includes(norm(identifier));
}

function seedConsents(d: OrgDB, s: RecordsLedgerState) {
  const r = makeRand(seedOf(`${d.org.id}:consent`));
  const purposes = purposesFor(d).filter((p) => p.basis === 'consent');
  // every address the agents write to: G1 checks each live call against the ledger, so each needs its entry
  const ids = chainIdentifiers(d).filter((x) => !ownDomain(d, x)).slice(0, 16);
  const idx = relianceIndex(d);
  const synthetic = ['priya.nair@gmail.com', '+91 98450 22107', 'arjun.menon@outlook.com', '+91 99000 41893', 'meera.k@yahoo.co.in'];
  const owner = ownerOf(d);
  const now = Date.now();
  const prefix = d.org.industry === 'healthcare' ? 'PT' : d.org.industry === 'finance' ? 'CUST' : 'VC';
  const vias = ['Web form (notice v3)', 'Mobile app', 'Branch, signed form', 'Consent manager (account aggregator)', 'Email reply'];
  const entries: ConsentEntry[] = [];
  const all = [...ids, ...synthetic];
  const contactEntry: Record<string, ConsentEntry> = {};
  all.forEach((identifier, i) => {
    // the chain's identifiers are email domains the agents wrote to: their contact purpose is the one G1 reads
    const contact = contactPurposeOf(d);
    const purpose = i < ids.length ? contact : r.pick(purposes);
    const channel = purpose.channels.includes('any') ? 'any' : i < ids.length && purpose.channels.includes('email') ? 'email' : r.pick(purpose.channels);
    // a consent the agents relied on was given before the first call that named the person
    const first = i < ids.length ? usesOf(idx, identifier).first : undefined;
    const givenAt = Math.min(now - r.int(20, 160) * D, first !== undefined ? first - r.int(3, 30) * D : Number.POSITIVE_INFINITY);
    const e: ConsentEntry = {
      id: `cn_${d.org.id.replace('org_', '')}_${i + 1}`, principalRef: `${prefix}-${10400 + i * 17}`, hint: maskHint(identifier), principalHash: sha256Hex(norm(identifier)),
      principalGroup: purpose.principals, purposeId: purpose.id, channel, noticeVersion: r.pick(['v2', 'v3', 'v3']), givenAt: iso(givenAt), givenVia: r.pick(vias),
      expiresAt: purpose.id === 'marketing' ? iso(givenAt + 365 * D) : undefined, status: 'active', recordedBy: owner, imported: true,
    };
    entries.push(e);
    if (i < ids.length) contactEntry[identifier] = e;
    // a second purpose for some principals
    if (i % 3 === 0) {
      const p2 = purposes.find((p) => p.id === 'ai_processing') ?? purposes[0];
      entries.push({ ...e, id: `${e.id}b`, purposeId: p2.id, channel: p2.channels.includes('any') ? 'any' : p2.channels[0], givenAt: iso(givenAt + 2 * D) });
    }
  });
  // two withdrawals the console shows: a synthetic principal (3 days ago) and an address the agents write to.
  // The second is withdrawn after the last call that named it, so no allowed call follows the withdrawal; from then
  // on G1 refuses every live call to it, and those refusals are on the chain.
  const w1 = entries[entries.length - 2];
  const chainId = ids[Math.min(2, ids.length - 1)];
  const w2 = chainId ? contactEntry[chainId] : entries[3];
  const lastUse = chainId ? usesOf(idx, chainId).last : undefined;
  const w2At = Math.min(now, Math.max(now - 12 * D, (lastUse ?? 0) + 60_000));
  [[w1, now - 3 * D, 'The person withdrew by replying STOP to an SMS.', 'SMS reply'], [w2, w2At, 'Asked in writing to stop marketing and contact after closing the account.', 'Letter to the grievance officer']].forEach(([e, at, reason, via]) => {
    const x = e as ConsentEntry;
    if (!x) return;
    x.status = 'withdrawn';
    x.withdrawnAt = iso(at as number);
    x.withdrawnBy = adminOf(d);
    x.withdrawnVia = via as string;
    x.withdrawalReason = reason as string;
  });
  s.consents.push(...entries);
  const digest = sha256Hex(canonical(entries.map((e) => ({ id: e.id, h: e.principalHash, p: e.purposeId, c: e.channel, s: e.status }))));
  const rec = append(d, { kind: 'admin', actor: owner, action: 'consent.imported', details: { entries: entries.length, active: entries.filter((e) => e.status === 'active').length, withdrawn: entries.filter((e) => e.status === 'withdrawn').length, source: 'Consent manager export', digest: digest.slice(0, 16) } });
  entries.forEach((e) => { e.seq = rec.seq; if (e.status === 'withdrawn') e.withdrawSeq = rec.seq; });
}

export function consentView(orgId: string) {
  const d = ensureRecordsSeed(orgId);
  const s = st(d);
  const idx = relianceIndex(d);
  const purposes = purposesFor(d);
  const installed = new Set(d.platform.packs.map((p) => p.id));
  const now = Date.now();
  const entries = s.consents.map((e) => {
    // only calls inside the consent's own window count: after it was given, before it was withdrawn, not refused
    const rel = coveredBy(e, idx);
    const expired = !!e.expiresAt && new Date(e.expiresAt).getTime() < now && e.status === 'active';
    return { ...clone(e), purposeLabel: purposes.find((p) => p.id === e.purposeId)?.label ?? e.purposeId, reliedOn: rel.count, lastSeq: rel.lastSeq, expired };
  }).sort((a, b) => (b.withdrawnAt ?? b.givenAt).localeCompare(a.withdrawnAt ?? a.givenAt));
  const g1Packs = purposes.filter((p) => p.pack).map((p) => ({ pack: p.pack!, purpose: p.id, purposeLabel: p.label, installed: installed.has(p.pack!), regime: packById(p.pack!)?.regime ?? p.pack! }));
  // G1 on live calls: the latest results the guard recorded on decision receipts
  const g1Receipts = d.receipts.slice(-4000).filter((r) => r.kind === 'decision' && typeof r.details?.g1 === 'string');
  const recent = g1Receipts.slice(-12).reverse().map((r) => ({
    seq: r.seq, ts: r.ts, agent: r.agent ?? '', tool: r.tool ?? '', decision: r.decision ?? '', code: String(r.details!.g1), consent: typeof r.details?.consent === 'string' ? r.details.consent : undefined,
    to: typeof r.args_summary?.to_domain === 'string' ? r.args_summary.to_domain : undefined,
  }));
  const contact = contactPurposeOf(d);
  return {
    level: levelOfOrg(d.org),
    purposes: purposes.map((p) => ({ ...p, active: s.consents.filter((e) => e.purposeId === p.id && e.status === 'active').length, withdrawn: s.consents.filter((e) => e.purposeId === p.id && e.status === 'withdrawn').length })),
    entries,
    stats: {
      active: entries.filter((e) => e.status === 'active' && !e.expired).length,
      withdrawn30d: entries.filter((e) => e.status === 'withdrawn' && e.withdrawnAt && new Date(e.withdrawnAt).getTime() > now - 30 * D).length,
      principals: new Set(entries.map((e) => e.principalHash)).size,
      reliedOn: entries.reduce((t, e) => t + (e.status === 'active' ? e.reliedOn : 0), 0),
      g1Checked: g1Receipts.length,
      g1Refused: g1Receipts.filter((r) => r.decision === 'refuse').length,
    },
    g1Packs,
    g1: { live: s.consents.length > 0, contactPurpose: { id: contact.id, label: contact.label }, recent },
  };
}

type G1Verdict = Omit<G1Result, 'checkedAt'>;

/**
 * G1, the consent check, against the ledger entries for one identifier and purpose. `live`: the call is being
 * decided now (the wording says it is refused, not that it would be).
 */
function decideG1(mine: ConsentEntry[], purpose: ConsentPurpose, channel: ConsentChannel, live: boolean, now = Date.now()): G1Verdict {
  const refusedLine = live ? 'The call is refused and the refusal recorded.' : 'The call would be refused at G1 and the refusal recorded.';
  const active = mine.filter((e) => e.status === 'active' && (!e.expiresAt || new Date(e.expiresAt).getTime() > now));
  const onChannel = active.find((e) => e.channel === channel || e.channel === 'any' || channel === 'any');
  if (onChannel) return { result: 'passed', code: 'G1_PASS', detail: `Consent ${onChannel.id} (${onChannel.principalRef}, notice ${onChannel.noticeVersion}) covers ${purpose.label.toLowerCase()} on ${CHANNEL_LABEL[onChannel.channel].toLowerCase()}. Given ${onChannel.givenAt.slice(0, 10)}.`, consentId: onChannel.id, purpose: purpose.label };
  if (active.length) return { result: 'refused', code: 'G1_CHANNEL', detail: `Consent is on record for ${active.map((e) => CHANNEL_LABEL[e.channel].toLowerCase()).join(', ')}, not for ${CHANNEL_LABEL[channel].toLowerCase()}. ${refusedLine}`, consentId: active[0].id, purpose: purpose.label };
  const withdrawn = mine.filter((e) => e.status === 'withdrawn').sort((a, b) => (b.withdrawnAt ?? '').localeCompare(a.withdrawnAt ?? ''))[0];
  if (withdrawn) return { result: 'refused', code: 'G1_WITHDRAWN', detail: `Consent ${withdrawn.id} was withdrawn ${withdrawn.withdrawnAt?.slice(0, 10)} (${withdrawn.withdrawnVia}). Calls after the withdrawal are refused at G1; the ones before it stay as they were recorded.`, consentId: withdrawn.id, purpose: purpose.label };
  const expired = mine.find((e) => e.expiresAt && new Date(e.expiresAt).getTime() <= now);
  if (expired) return { result: 'refused', code: 'G1_EXPIRED', detail: `Consent ${expired.id} expired ${expired.expiresAt?.slice(0, 10)}. Ask again before writing to this person. ${live ? refusedLine : ''}`.trim(), consentId: expired.id, purpose: purpose.label };
  return { result: 'refused', code: 'G1_NO_CONSENT', detail: `No consent for ${purpose.label.toLowerCase()} is on record for this identifier. ${refusedLine}`, purpose: purpose.label };
}

const hashesOf = (identifier: string) => {
  const hs = [sha256Hex(norm(identifier))];
  if (identifier.includes('@')) hs.push(sha256Hex(norm(identifier.split('@')[1])));
  return hs;
};

/** G1, the consent check, run against the ledger: does a recorded, unwithdrawn consent cover this purpose and channel? Nothing is written. */
export function g1Check(orgId: string, identifier: string, purposeId: string, channel: ConsentChannel): G1Result {
  const d = ensureRecordsSeed(orgId);
  const s = st(d);
  const purpose = purposesFor(d).find((p) => p.id === purposeId);
  if (!purpose) throw new Error('Choose a purpose.');
  if (norm(identifier).length < 3) throw new Error('Enter the identifier the call carries: an email address, a domain or a phone number.');
  const at = iso(Date.now());
  if (purpose.basis === 'legitimate_use') return { result: 'passed', code: 'G1_LEGITIMATE_USE', detail: `${purpose.label} is a legitimate use the Act names (s.7). G1 passes without a consent; the use is still recorded on the receipt.`, purpose: purpose.label, checkedAt: at };
  const hashes = hashesOf(identifier);
  const mine = s.consents.filter((e) => hashes.includes(e.principalHash) && e.purposeId === purposeId);
  return { ...decideG1(mine, purpose, channel, false), checkedAt: at };
}

/** The person a call writes to, and on which channel: an email address, or a phone number for SMS, WhatsApp or a call. */
function addresseeOf(tool: string, args: Record<string, unknown>): { identifier: string; channel: ConsentChannel } | undefined {
  const raw = [args.to, args.phone, args.mobile, args.to_number, args.recipient].find((v) => typeof v === 'string' && v.trim().length >= 3) as string | undefined;
  if (!raw) return undefined;
  const t = tool.toLowerCase();
  if (raw.includes('@')) return { identifier: raw.trim(), channel: 'email' };
  if (!/^\+?\d[\d\s-]{6,}$/.test(raw.trim())) return undefined;
  return { identifier: raw.trim(), channel: /whatsapp/.test(t) ? 'whatsapp' : /(call|dial|voice)/.test(t) ? 'call' : 'sms' };
}

/**
 * G1 on a live call (registered with the guard below). A call that writes to a person — an email, an SMS, a WhatsApp
 * message or a phone call to an address it carries — needs an active consent for the organisation's contact purpose on
 * that channel. A pass names the consent on the receipt; a withdrawn, expired, missing or wrong-channel consent refuses
 * the call. G1 reads the ledger once the organisation keeps one (an organisation with no entry yet is not checked).
 */
/**
 * G1 for one call, as the live check decides it, against the ledger as it stood at `at` (consents given by then;
 * a withdrawal after `at` not yet in effect). The guard asks at the moment of the call; the approval screen asks at
 * the hold, so its sentence does not change afterwards. Undefined: G1 does not apply (no person written to, the
 * organisation's own people, or no ledger yet). Nothing is written.
 */
export function g1ForCall(orgId: string, call: { tool: string; args: Record<string, unknown>; tags: string[] }, at = Date.now()): (G1Verdict & { purposeId: string }) | undefined {
  const to = addresseeOf(call.tool, call.args);
  if (!to) return undefined;
  const writesToPerson = call.tags.includes('sends_external') || /(send|notify|remind|message|sms|whatsapp|call|dial)/.test(call.tool.split('.').pop() ?? '');
  if (!writesToPerson) return undefined;
  const d = ensureRecordsSeed(orgId);
  const s = st(d);
  if (!s.consents.length) return undefined;
  if (ownDomain(d, to.identifier.split('@').pop() ?? '')) return undefined; // the organisation writing to its own people
  const purpose = contactPurposeOf(d);
  const hashes = hashesOf(to.identifier);
  const mine = s.consents
    .filter((e) => hashes.includes(e.principalHash) && e.purposeId === purpose.id && new Date(e.givenAt).getTime() <= at)
    .map((e) => (e.status === 'withdrawn' && e.withdrawnAt && new Date(e.withdrawnAt).getTime() > at ? { ...e, status: 'active' as const } : e));
  return { ...decideG1(mine, purpose, to.channel, true, at), purposeId: purpose.id };
}

function g1Live(db: OrgDB, _agent: unknown, call: { tool: string; args: Record<string, unknown>; tags: string[] }) {
  const v = g1ForCall(db.org.id, call);
  if (!v) return undefined;
  const purpose = { id: v.purposeId };
  const details: Record<string, string | number> = { g1: v.code, consent_purpose: purpose.id, ...(v.consentId ? { consent: v.consentId } : {}) };
  return v.result === 'passed' ? { details } : { details, refuse: { ruleId: v.code, reason: `G1 consent check: ${v.detail}` } };
}
addRecordedCheck('g1-consent', g1Live);

/**
 * Bring a ledger saved before G1 ran on live calls in line with the chain: every address the agents write to gets its
 * consent (imported from the consent manager, given before the first call that named it), and a seeded withdrawal is
 * dated after the last allowed call that named the person. One receipt when entries are added.
 */
function alignLedgerWithChain(d: OrgDB, s: RecordsLedgerState) {
  const idx = relianceIndex(d);
  const purpose = contactPurposeOf(d);
  const now = Date.now();
  const r = makeRand(seedOf(`${d.org.id}:consent:align`));
  // dates of imported entries follow the calls that relied on them
  for (const e of s.consents) {
    if (!e.imported) continue;
    const uses = idx.get(e.principalHash) ?? [];
    const allowed = uses.filter((u) => !u.refused);
    const first = allowed.length ? Math.min(...allowed.map((u) => u.t)) : undefined;
    if (first !== undefined && first < new Date(e.givenAt).getTime()) e.givenAt = iso(first - r.int(3, 30) * D);
    if (e.status === 'withdrawn' && e.withdrawnAt) {
      const after = allowed.filter((u) => u.t > new Date(e.withdrawnAt!).getTime());
      if (after.length) e.withdrawnAt = iso(Math.min(now, Math.max(...after.map((u) => u.t)) + 60_000));
    }
  }
  // every address the agents write to has an entry for the contact purpose
  const have = new Set(s.consents.filter((e) => e.purposeId === purpose.id).map((e) => e.principalHash));
  const prefix = d.org.industry === 'healthcare' ? 'PT' : d.org.industry === 'finance' ? 'CUST' : 'VC';
  const owner = ownerOf(d);
  const added: ConsentEntry[] = [];
  chainIdentifiers(d).filter((x) => !ownDomain(d, x)).slice(0, 24).forEach((identifier, i) => {
    const h = sha256Hex(norm(identifier));
    if (have.has(h)) return;
    const first = usesOf(idx, identifier).first ?? now;
    added.push({
      id: `cn_${d.org.id.replace('org_', '')}_x${i + 1}`, principalRef: `${prefix}-${20400 + i * 13}`, hint: maskHint(identifier), principalHash: h, principalGroup: purpose.principals,
      purposeId: purpose.id, channel: purpose.channels.includes('email') ? 'email' : purpose.channels[0], noticeVersion: 'v3', givenAt: iso(first - r.int(5, 40) * D),
      givenVia: 'Consent manager (account aggregator)', status: 'active', recordedBy: owner, imported: true,
    });
  });
  if (!added.length) return;
  s.consents.push(...added);
  const digest = sha256Hex(canonical(added.map((e) => ({ id: e.id, h: e.principalHash, p: e.purposeId, c: e.channel }))));
  const rec = append(d, { kind: 'admin', actor: owner, action: 'consent.ledger_extended', details: { entries: added.length, purpose: purpose.id, source: 'Consent manager export', digest: digest.slice(0, 16) } });
  added.forEach((e) => { e.seq = rec.seq; });
}

export function recordConsent(orgId: string, input: { principalRef: string; identifier: string; principalGroup: string; purposeId: string; channel: ConsentChannel; noticeVersion: string; givenVia: string; expiresAt?: string }, userId: string) {
  const d = ensureRecordsSeed(orgId);
  requireManager(orgId, userId, 'Recording a consent');
  const purpose = purposesFor(d).find((p) => p.id === input.purposeId);
  if (!purpose) throw new Error('Choose a purpose.');
  if (purpose.basis !== 'consent') throw new Error(`${purpose.label} is a legitimate use the Act names; it is not asked for, so there is no consent to record.`);
  if (norm(input.identifier).length < 3) throw new Error('Enter the identifier: an email address, a domain or a phone number. It is hashed at once and never stored.');
  if (!input.noticeVersion.trim()) throw new Error('Name the version of the notice the person saw.');
  if (!purpose.channels.includes(input.channel) && !purpose.channels.includes('any')) throw new Error(`${purpose.label} is asked for on ${purpose.channels.map((c) => CHANNEL_LABEL[c].toLowerCase()).join(', ')}.`);
  const s = st(d);
  const h = sha256Hex(norm(input.identifier));
  const dup = s.consents.find((e) => e.principalHash === h && e.purposeId === input.purposeId && e.channel === input.channel && e.status === 'active');
  if (dup) throw new Error(`Consent ${dup.id} (${dup.principalRef}) already covers this purpose and channel.`);
  const now = Date.now();
  const e: ConsentEntry = {
    id: rid('cn'), principalRef: input.principalRef.trim() || `DP-${new Date().getFullYear()}-${h.slice(0, 4).toUpperCase()}`, hint: maskHint(input.identifier), principalHash: h,
    principalGroup: input.principalGroup || purpose.principals, purposeId: purpose.id, channel: input.channel, noticeVersion: input.noticeVersion.trim(), givenAt: iso(now), givenVia: input.givenVia.trim() || 'Recorded in the console',
    expiresAt: input.expiresAt || undefined, status: 'active', recordedBy: userId,
  };
  const r = append(d, { kind: 'admin', actor: userId, action: 'consent.recorded', details: { consent: e.id, purpose: purpose.id, channel: e.channel, notice: e.noticeVersion, principal_hash: h.slice(0, 16), via: e.givenVia } });
  e.seq = r.seq;
  s.consents.unshift(e);
  touch(orgId, 'consent');
  return clone(e);
}

export function withdrawConsent(orgId: string, id: string, input: { via: string; reason: string }, userId: string) {
  const d = ensureRecordsSeed(orgId);
  requireManager(orgId, userId, 'Recording a withdrawal');
  const s = st(d);
  const e = s.consents.find((x) => x.id === id);
  if (!e) throw new Error('No such consent in this organisation.');
  if (e.status === 'withdrawn') throw new Error(`Already withdrawn ${e.withdrawnAt?.slice(0, 10)}.`);
  if (!input.via.trim()) throw new Error('Say how the person withdrew: SMS reply, email, the app, a letter.');
  const now = iso(Date.now());
  const r = append(d, { kind: 'admin', actor: userId, action: 'consent.withdrawn', details: { consent: e.id, purpose: e.purposeId, channel: e.channel, via: input.via.trim(), principal_hash: e.principalHash.slice(0, 16), ...(input.reason.trim() ? { reason: input.reason.trim() } : {}) } });
  Object.assign(e, { status: 'withdrawn', withdrawnAt: now, withdrawnBy: userId, withdrawnVia: input.via.trim(), withdrawalReason: input.reason.trim() || undefined, withdrawSeq: r.seq });
  touch(orgId, 'consent');
  return clone(e);
}

/* ══ Erasure plan and statutory retention ════════════════════════════════ */

const GST: RetentionBasis = { law: 'GST', cite: 'CGST Act 2017, s.36; CGST Rules, r.56', label: 'GST accounts and records: 72 months from the due date of the annual return', years: 6 };
const MCA: RetentionBasis = { law: 'MCA', cite: 'Companies Act 2013, s.128(5)', label: 'Books of account and vouchers: 8 financial years', years: 8 };
const PMLA: RetentionBasis = { law: 'PMLA', cite: 'PML Act 2002, s.12; PML Rules, r.3', label: 'Transaction records: 5 years from the transaction', years: 5 };

/** The statutory retention a governed write falls under, by its write type. Reads hold nothing. */
export function retentionFor(tool: string | undefined): RetentionBasis[] {
  if (!tool) return [];
  const verb = tool.split('.').pop() ?? '';
  if (/^(list|read|get|search)_/.test(verb)) return [];
  if (/(transfer|bank_details|ifsc)/.test(tool)) return [PMLA];
  if (/(bill|invoice|payment|journal|ledger|credit_note|voucher|gstin|vendor)/.test(tool)) return [GST, MCA];
  return [];
}

export const RETENTION_BASES = [GST, MCA, PMLA];

function computePlan(d: OrgDB, identifier: string): ErasurePlan {
  const needle = norm(identifier);
  const s = st(d);
  const matched = d.receipts.filter((r) => r.kind === 'decision' && !r.redacted && JSON.stringify(r.args_summary ?? {}).toLowerCase().includes(needle));
  return planFromReceipts(d, s, matched, sha256Hex(needle));
}

function planFromReceipts(d: OrgDB, s: RecordsLedgerState, matched: Receipt[], identifierHash: string): ErasurePlan {
  const erasable: Receipt[] = [];
  const held: ErasurePlan['held'] = [];
  const basisCount = new Map<string, { b: RetentionBasis; receipts: number; until: number }>();
  for (const r of matched) {
    const bases = retentionFor(r.tool);
    if (!bases.length) { erasable.push(r); continue; }
    const t = new Date(r.ts).getTime();
    const until = Math.max(...bases.map((b) => t + b.years * 365 * D));
    held.push({ seq: r.seq, tool: r.tool ?? '', until: iso(until), bases: bases.map((b) => b.law) });
    for (const b of bases) {
      const e = basisCount.get(b.law) ?? { b, receipts: 0, until: 0 };
      e.receipts++;
      e.until = Math.max(e.until, t + b.years * 365 * D);
      basisCount.set(b.law, e);
    }
  }
  const fields = new Map<string, number>();
  erasable.forEach((r) => Object.keys(r.args_summary ?? {}).forEach((k) => fields.set(k, (fields.get(k) ?? 0) + 1)));
  const systems: ErasurePlan['systems'] = [];
  const byConnector = new Map<string, { name: string; id: string; n: number }>();
  const byAgent = new Map<string, number>();
  for (const r of erasable) {
    const c = d.connectors.find((x) => x.tools.some((t) => t.name === r.tool));
    if (c) { const e = byConnector.get(c.id) ?? { name: c.name, id: c.id, n: 0 }; e.n++; byConnector.set(c.id, e); }
    if (r.agent) byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + 1);
  }
  byConnector.forEach((c) => systems.push({ kind: 'connector', name: c.name, to: `/connectors/${c.id}`, receipts: c.n, note: 'The source system keeps its own copy. Erase it there; Elan1 Govern cannot reach it.' }));
  byAgent.forEach((n, slug) => {
    const a = d.agents.find((x) => x.slug === slug);
    systems.push({ kind: 'agent', name: a?.name ?? slug, to: `/agents/${slug}`, receipts: n, note: 'The values its rules inspected are removed from each receipt.' });
    const sys = a && d.aiSystems.find((x) => x.linkedAgentId === a.id || x.id === a.aiSystemId);
    if (sys && !systems.some((x) => x.kind === 'ai_system' && x.name === sys.name)) systems.push({ kind: 'ai_system', name: sys.name, to: `/inventory/${sys.id}`, note: `${sys.vendor} processes this data. Ask the vendor to erase any copy it keeps.` });
  });
  if (erasable.length && replayOnOf(d)) systems.push({ kind: 'store', name: 'Replay store', note: 'Past arguments kept for testing rules are deleted with the values.' });
  const seqs = new Set(erasable.map((r) => r.seq));
  const exports = d.exports.filter((x) => [...seqs].some((q) => q >= x.firstSeq && q <= x.lastSeq)).map((x) => ({ id: x.id, ts: x.ts, firstSeq: x.firstSeq, lastSeq: x.lastSeq, covered: [...seqs].filter((q) => q >= x.firstSeq && q <= x.lastSeq).length, format: x.format ?? 'auditor pack' })).slice(0, 12);
  const consents = s.consents.filter((e) => e.principalHash === identifierHash).map((e) => ({ id: e.id, purpose: e.purposeId, status: e.status }));
  const bases = [...basisCount.values()].map((x) => ({ ...x.b, receipts: x.receipts, holdUntil: iso(x.until) }));
  const outcome: ErasurePlan['outcome'] = !matched.length ? 'nothing' : !erasable.length ? 'refused' : held.length ? 'partial' : 'proceed';
  const body = { identifierHash, erasable: erasable.map((r) => r.seq), held: held.map((h) => h.seq), fields: [...fields.keys()].sort(), exports: exports.map((x) => x.id) };
  return {
    identifierHash, computedAt: iso(Date.now()), matched: matched.length, erasable: erasable.map((r) => r.seq), held,
    fields: [...fields.entries()].map(([name, receipts]) => ({ name, receipts })).sort((a, b) => b.receipts - a.receipts),
    systems, exports, consents, bases, outcome, digest: sha256Hex(canonical(body)),
  };
}

/** The plan for an identifier, before anything is opened. Nothing is written. */
export function previewErasurePlan(orgId: string, identifier: string) {
  const d = ensureRecordsSeed(orgId);
  if (norm(identifier).length < 3) throw new Error('Enter at least 3 characters.');
  return computePlan(d, identifier);
}

/**
 * The plan recorded with a request. Requests opened before plans existed get theirs in reconcileErasures (on every
 * records read, and before an erasure runs), so the plan shown is always what executing the request does.
 */
export function planForRequest(orgId: string, e: ErasureRequest): ErasurePlan {
  const d = ensureRecordsSeed(orgId);
  const s = st(d);
  if (s.plans[e.id]) return clone(s.plans[e.id]);
  // not reachable after reconcileErasures, kept for safety: rebuilt from what the request will erase, as it stands
  return planOfRequest(d, s, d.platform.erasures.find((x) => x.id === e.id) ?? e);
}

/** A plan from a request's own receipts. A receipt already erased keeps no arguments and is counted as erased. */
function planOfRequest(d: OrgDB, s: RecordsLedgerState, e: ErasureRequest) {
  const set = new Set(e.affectedSeqs);
  const rs = d.receipts.filter((r) => set.has(r.seq));
  return planFromReceipts(d, s, rs.map((r) => (r.redacted ? { ...r, tool: undefined } : r)), e.subjectHash);
}

/**
 * Give every request opened before erasure plans existed (seeded, or through the old path) its plan. A request not yet
 * executed is narrowed to the receipts statutory retention lets go, so executing it erases exactly what the plan says;
 * the narrowing is recorded (erasure.plan_recorded). An executed request's plan shows what was erased.
 */
function reconcileErasures(d: OrgDB, s: RecordsLedgerState) {
  for (const e of d.platform.erasures ?? []) {
    if (s.plans[e.id]) continue;
    const plan = planOfRequest(d, s, e);
    if (e.status !== 'executed' && plan.held.length) {
      const heldSeqs = new Set(plan.held.map((h) => h.seq));
      e.affectedSeqs = e.affectedSeqs.filter((q) => !heldSeqs.has(q));
      e.affected = e.affectedSeqs.length;
      append(d, { kind: 'admin', actor: 'system', action: 'erasure.plan_recorded', details: { request: e.id, subject_hash: e.subjectHash.slice(0, 16), affected: e.affected, held: plan.held.length, held_basis: plan.bases.map((b) => b.law).join(','), plan_digest: plan.digest.slice(0, 16) } });
    }
    s.plans[e.id] = plan;
  }
}

/**
 * Open an erasure request with its plan. Receipts under statutory retention are held out of it; when every
 * matching receipt is held the request is refused, and the refusal is recorded.
 */
export function openErasureWithPlan(orgId: string, input: { subjectRef: string; identifier: string; reason: string }, userId: string): { outcome: 'opened'; request: ErasureRequest; plan: ErasurePlan } | { outcome: 'refused'; refusal: ErasureRefusal; plan: ErasurePlan } {
  const d = ensureRecordsSeed(orgId);
  requireManager(orgId, userId, 'Opening an erasure request');
  const needle = norm(input.identifier);
  if (needle.length < 3) throw new Error('Enter the identifier to search for (an email domain, customer name or record id).');
  if (input.reason.trim().length < 8) throw new Error('Say why, in a sentence.');
  const s = st(d);
  const plan = computePlan(d, needle);
  const now = Date.now();
  const subjectRef = input.subjectRef.trim() || `DP-${new Date().getFullYear()}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
  if (plan.outcome === 'refused') {
    const holdUntil = plan.bases.reduce((m, b) => (b.holdUntil > m ? b.holdUntil : m), '');
    const refusal: ErasureRefusal = { id: rid('erf'), subjectRef, subjectHash: plan.identifierHash, reason: input.reason.trim(), requestedBy: userId, at: iso(now), matched: plan.matched, bases: plan.bases.map((b) => b.law), holdUntil, planDigest: plan.digest };
    const r = append(d, { kind: 'admin', actor: userId, action: 'erasure.refused', details: { refusal: refusal.id, subject_ref: subjectRef, subject_hash: plan.identifierHash.slice(0, 16), held: plan.held.length, basis: refusal.bases.join(','), hold_until: holdUntil.slice(0, 10), plan_digest: plan.digest.slice(0, 16) } });
    refusal.seq = r.seq;
    s.refusals.unshift(refusal);
    touch(orgId, 'erasure');
    return { outcome: 'refused', refusal: clone(refusal), plan };
  }
  const e: ErasureRequest = {
    id: rid('er'), subjectRef, subjectHash: plan.identifierHash, reason: input.reason.trim(), requestedBy: userId, requestedAt: iso(now), dueAt: iso(now + 72 * H),
    affectedSeqs: plan.erasable, affected: plan.erasable.length, required: 2, approvals: [], status: 'awaiting_approval',
  };
  d.platform.erasures.unshift(e);
  const r = append(d, { kind: 'admin', actor: userId, action: 'erasure.requested', details: { request: e.id, subject_hash: e.subjectHash.slice(0, 16), affected: e.affected, held: plan.held.length, ...(plan.held.length ? { held_basis: plan.bases.map((b) => b.law).join(',') } : {}), fields: plan.fields.length, exports: plan.exports.length, plan_digest: plan.digest.slice(0, 16) } });
  e.seq = r.seq;
  s.plans[e.id] = plan;
  touch(orgId, 'erasure');
  return { outcome: 'opened', request: clone(e), plan };
}

export function erasureRefusals(orgId: string) {
  return clone(st(ensureRecordsSeed(orgId)).refusals);
}

function seedRefusal(d: OrgDB, s: RecordsLedgerState) {
  // the vendor with the most bills: every receipt naming it is a GST and MCA record, so erasure is refused
  const counts = new Map<string, number>();
  for (const r of d.receipts) {
    if (r.kind !== 'decision' || r.redacted || !retentionFor(r.tool).length) continue;
    const v = r.args_summary?.vendor;
    if (typeof v === 'string') counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  for (const vendor of ranked.slice(0, 5)) {
    const plan = computePlan(d, vendor);
    if (plan.outcome !== 'refused') continue;
    const holdUntil = plan.bases.reduce((m, b) => (b.holdUntil > m ? b.holdUntil : m), '');
    const requestedBy = adminOf(d);
    const refusal: ErasureRefusal = { id: `erf_${d.org.id.replace('org_', '')}_1`, subjectRef: 'DP-2026-0188', subjectHash: plan.identifierHash, reason: 'A sole-proprietor supplier asked for their name to be erased after the contract ended.', requestedBy, at: iso(Date.now()), matched: plan.matched, bases: plan.bases.map((b) => b.law), holdUntil, planDigest: plan.digest };
    const r = append(d, { kind: 'admin', actor: requestedBy, action: 'erasure.refused', details: { refusal: refusal.id, subject_ref: refusal.subjectRef, subject_hash: plan.identifierHash.slice(0, 16), held: plan.held.length, basis: refusal.bases.join(','), hold_until: holdUntil.slice(0, 10), plan_digest: plan.digest.slice(0, 16) } });
    refusal.seq = r.seq;
    s.refusals.push(refusal);
    return;
  }
}

/* ══ Withdrawing a declaration (rulebook) version ═══════════════════════ */

export interface DeclarationRow {
  rulebookId: string;
  slug: string;
  name: string;
  agentName?: string;
  agentStatus?: string;
  inForce?: number;
  currentVersion: number;
  versions: (Pick<RulebookVersion, 'version' | 'status' | 'hash' | 'signedBy' | 'signedAt' | 'note' | 'withdrawn'> & { rules: number; inForce: boolean })[];
}

export function declarationsView(orgId: string): { level: LevelId; rows: DeclarationRow[] } {
  const d = ensureRecordsSeed(orgId);
  const now = Date.now();
  const rows = d.rulebooks.map((rb) => {
    const live = rulebookAt(rb, now);
    const a = d.agents.find((x) => x.id === rb.agentId || x.slug === rb.slug);
    return {
      rulebookId: rb.id, slug: rb.slug, name: rb.name, agentName: a?.name, agentStatus: a?.status, inForce: live?.version, currentVersion: rb.currentVersion,
      versions: rb.versions.slice().sort((x, y) => y.version - x.version).map((v) => ({ version: v.version, status: v.status, hash: v.hash, signedBy: v.signedBy, signedAt: v.signedAt, note: v.note, withdrawn: v.withdrawn, rules: v.rules.length, inForce: live?.version === v.version })),
    };
  });
  return { level: levelOfOrg(d.org), rows: clone(rows) };
}

/** The version that takes over if `version` is withdrawn now (undefined: none would be left). */
export function fallbackFor(rb: Rulebook, version: number): RulebookVersion | undefined {
  const now = Date.now();
  return rb.versions.filter((v) => v.version !== version && v.status === 'published' && v.signedAt && new Date(v.signedAt).getTime() <= now && !v.withdrawn).sort((a, b) => a.signedAt!.localeCompare(b.signedAt!)).pop();
}

/**
 * Withdraw a published rulebook version. It stays in the history; calls made from now on never use it. When it was
 * the version in force, the newest version that is not withdrawn takes over.
 */
export function withdrawVersion(orgId: string, rulebookId: string, version: number, reason: string, userId: string) {
  const d = ensureRecordsSeed(orgId);
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Withdrawing a declaration version — owners and admins can do this; your role cannot.');
  const rb = d.rulebooks.find((x) => x.id === rulebookId || x.slug === rulebookId);
  if (!rb) throw new Error('No such rulebook in this organisation.');
  const v = rb.versions.find((x) => x.version === version);
  if (!v) throw new Error(`No version ${version}.`);
  if (v.status !== 'published' || !v.signedAt) throw new Error('Only a published version can be withdrawn. Discard a draft from the rulebook instead.');
  if (v.withdrawn) throw new Error(`Version ${version} was withdrawn ${v.withdrawn.at.slice(0, 10)}.`);
  if (reason.trim().length < 8) throw new Error('Say why the version is withdrawn, in a sentence. The reason goes on the receipt.');
  const now = Date.now();
  const before = rulebookAt(rb, now);
  const wasInForce = before?.version === version;
  const fallback = fallbackFor(rb, version);
  if (wasInForce && !fallback) throw new Error(`Version ${version} is the only version in force. Publish a replacement first, or pause the agent — withdrawing it would leave the agent with no rulebook.`);
  const r = append(d, { kind: 'admin', actor: userId, action: 'rulebook.version_withdrawn', agent: rb.slug, details: { rulebook: rb.slug, version, reason: reason.trim(), was_in_force: wasInForce, now_in_force: wasInForce ? fallback!.version : before?.version ?? 0, hash: v.hash.slice(0, 16) } });
  v.withdrawn = { at: r.ts, by: userId, reason: reason.trim(), seq: r.seq, fallbackVersion: wasInForce ? fallback!.version : undefined };
  if (wasInForce) rb.currentVersion = fallback!.version;
  rb.updatedAt = r.ts;
  touch(orgId, 'rulebook');
  return { seq: r.seq, slug: rb.slug, version, wasInForce, nowInForce: rulebookAt(rb, Date.now())?.version };
}

function seedWithdrawal(d: OrgDB) {
  if (d.org.id !== 'org_northbank' && d.org.id !== 'org_kaveri') return;
  const now = Date.now();
  for (const rb of d.rulebooks) {
    const live = rulebookAt(rb, now);
    const old = rb.versions.filter((v) => v.status === 'published' && v.signedAt && v.version !== live?.version && !v.withdrawn).sort((a, b) => a.version - b.version)[0];
    if (!live || !old) continue;
    const by = ownerOf(d);
    const reason = 'Withdrawn after review: this version let vendor bank details change without a second person. It must never be restored.';
    const r = append(d, { kind: 'admin', actor: by, action: 'rulebook.version_withdrawn', agent: rb.slug, details: { rulebook: rb.slug, version: old.version, reason, was_in_force: false, now_in_force: live.version, hash: old.hash.slice(0, 16) } });
    old.withdrawn = { at: r.ts, by, reason, seq: r.seq };
    return;
  }
}

/* ══ Chain gaps as sealed gap records ════════════════════════════════════ */

export function gapsView(orgId: string) {
  const d = ensureRecordsSeed(orgId);
  return { level: levelOfOrg(d.org), gaps: clone(st(d).gaps), agents: d.agents.map((a) => ({ slug: a.slug, name: a.name, route: a.route })), incidents: d.incidents.map((i) => ({ id: i.id, title: i.title, status: i.status })) };
}

/** Seal a record of a window the chain holds no receipts for, with its cause. The gap record is itself a receipt. */
export function sealGap(orgId: string, input: { from: string; to: string; cause: GapCause; summary: string; agents: string[]; estimatedMissed: number; incidentId?: string }, userId: string) {
  const d = ensureRecordsSeed(orgId);
  requireManager(orgId, userId, 'Sealing a gap record');
  const from = new Date(input.from).getTime();
  const to = new Date(input.to).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('Give the start and end of the window.');
  if (to <= from) throw new Error('The window must end after it starts.');
  if (to > Date.now()) throw new Error('A gap record covers a window that has ended.');
  if (input.summary.trim().length < 12) throw new Error('Say what happened in a sentence or two. It is sealed as written.');
  if (input.estimatedMissed < 0 || !Number.isFinite(input.estimatedMissed)) throw new Error('Estimate the calls not recorded (0 if none).');
  const s = st(d);
  // an empty agent list means every agent, so it overlaps any gap in the same window
  const sameAgents = (a: string[], b: string[]) => !a.length || !b.length || a.some((x) => b.includes(x));
  if (s.gaps.some((g) => new Date(g.from).getTime() < to && new Date(g.to).getTime() > from && sameAgents(g.agents, input.agents))) throw new Error('A sealed gap record already covers part of this window for these agents.');
  return writeGap(d, s, { ...input, summary: input.summary.trim() }, userId);
}

function writeGap(d: OrgDB, s: RecordsLedgerState, input: { from: string; to: string; cause: GapCause; summary: string; agents: string[]; estimatedMissed: number; incidentId?: string }, userId: string) {
  const from = new Date(input.from).getTime();
  const to = new Date(input.to).getTime();
  const before = [...d.receipts].reverse().find((r) => new Date(r.ts).getTime() <= from);
  const inWindow = d.receipts.filter((r) => { const t = new Date(r.ts).getTime(); return t > from && t < to && (!input.agents.length || (r.agent && input.agents.includes(r.agent))); }).length;
  const id = rid('gap');
  const body = { id, org: d.org.id, from: iso(from), to: iso(to), cause: input.cause, agents: input.agents.slice().sort(), estimated_missed: Math.round(input.estimatedMissed), last_seq_before: before?.seq ?? 0, summary: input.summary };
  const digest = sha256Hex(canonical(body));
  const g: GapRecord = { id, from: iso(from), to: iso(to), cause: input.cause, summary: input.summary, agents: input.agents, estimatedMissed: Math.round(input.estimatedMissed), lastSeqBefore: before?.seq, receiptsInWindow: inWindow, incidentId: input.incidentId, sealedBy: userId, sealedAt: iso(Date.now()), digest };
  const r = append(d, { kind: 'admin', actor: userId, action: 'chain.gap_sealed', details: { gap: id, from: g.from, to: g.to, minutes: Math.round((to - from) / 60000), cause: input.cause, agents: input.agents.join(',') || 'all', estimated_missed: g.estimatedMissed, last_seq_before: g.lastSeqBefore ?? 0, digest: digest.slice(0, 16), ...(input.incidentId ? { incident: input.incidentId } : {}) } });
  g.seq = r.seq;
  g.sealedAt = r.ts;
  s.gaps.unshift(g);
  touch(d.org.id, 'receipt');
  return clone(g);
}

/** The start of a `minutes`-long window near `around` in which none of `agents` wrote a receipt (searched both ways, 10-minute steps). */
function emptyWindow(d: OrgDB, agents: string[], around: number, minutes: number): number | undefined {
  const len = minutes * 60_000;
  const ts = d.receipts.filter((r) => r.agent && agents.includes(r.agent)).map((r) => new Date(r.ts).getTime());
  const free = (from: number) => !ts.some((t) => t >= from && t <= from + len);
  for (let k = 0; k < 600; k++) {
    const step = Math.ceil(k / 2) * 10 * 60_000 * (k % 2 ? 1 : -1);
    const from = around + step;
    if (from + len < Date.now() - H && free(from)) return from;
  }
  return undefined;
}

function seedGap(d: OrgDB, s: RecordsLedgerState) {
  const advisory = d.agents.filter((a) => a.route !== 'mcp');
  const minutes = 14;
  if (advisory.length) {
    // advisory agents run their own calls: while they could not reach the decision service they went ahead unrecorded
    const agents = advisory.slice(0, 2).map((a) => a.slug);
    const from = emptyWindow(d, agents, Date.now() - 6 * D - 3 * H, minutes);
    if (from === undefined) return;
    writeGap(d, s, {
      from: iso(from), to: iso(from + minutes * 60_000), cause: 'sdk_offline', agents, estimatedMissed: 23,
      summary: `The decision service was unreachable from the office network for ${minutes} minutes. Advisory (check and record) agents run their own calls, so they went ahead without a receipt; their SDK queue log shows about 23 calls. Governed-run agents refused every call in the window.`,
    }, adminOf(d));
    return;
  }
  // only governed-run agents: they cannot act without the guard, so nothing ran unrecorded — the window is declared
  // so a verifier sees why the chain holds nothing for it
  const governed = d.agents.slice(0, 2);
  const agents = governed.map((a) => a.slug);
  if (!agents.length) return;
  const from = emptyWindow(d, agents, Date.now() - 6 * D - 3 * H, minutes);
  if (from === undefined) return;
  const connector = d.connectors.find((c) => governed.some((a) => a.connectorIds?.includes(c.id)))?.name ?? 'the accounting system';
  writeGap(d, s, {
    from: iso(from), to: iso(from + minutes * 60_000), cause: 'connector_outage', agents, estimatedMissed: 0,
    summary: `${connector} was unreachable for ${minutes} minutes. The governed-run agents that use it cannot act without the guard, so no call ran and none needed a receipt; the window is declared so a verifier sees why the chain holds nothing for it.`,
  }, adminOf(d));
}

/* ══ RBI model-documentation export ══════════════════════════════════════ */

interface DocSystem {
  id: string; name: string; kind: string; vendor: string; model: string; version: string; purpose: string; owner: string; businessUnit: string; lifecycle: string;
  riskTier: string; decisionImpact: string; dataCategories: string[]; affectedPeople: string[]; residency: string; personalData: string; nextReview: string; registered: string;
  agent?: { slug: string; route: string; status: string; calls7d: number; allowed7d: number; asked7d: number; refused7d: number };
  rulebook?: { slug: string; version: number; hash: string; rules: number; askRules: number; refuseRules: number; signedBy: string; signedAt: string; withdrawn: number };
  validation: { template: string; status: string; tier: string; author: string; reviewer: string; reviewedAt: string }[];
  changes: { seq: number; ts: string; action: string; by: string }[];
}

function docSystems(d: OrgDB, ids?: string[]): DocSystem[] {
  const extra = ((d.platform as unknown as { recordsDoor?: { aiExtra?: Record<string, { residency: string; personalData: boolean; principals: string[] }> } }).recordsDoor?.aiExtra) ?? {};
  const list = d.aiSystems.filter((s) => (ids?.length ? ids.includes(s.id) : s.lifecycle !== 'retired'));
  const now = Date.now();
  return list.map((s) => {
    const a = d.agents.find((x) => x.id === s.linkedAgentId);
    const rb = a ? d.rulebooks.find((x) => x.id === a.rulebookId) : undefined;
    const live = rulebookAt(rb, now);
    const x = extra[s.id];
    const changes = d.receipts.filter((r) => r.kind === 'admin' && (r.details?.system === s.name || (a && r.agent === a.slug && /^(agent\.|rulebook\.|declaration\.)/.test(r.action ?? '')))).slice(-12).map((r) => ({ seq: r.seq, ts: r.ts, action: r.action ?? '', by: userName(r.actor) }));
    return {
      id: s.id, name: s.name, kind: s.kind, vendor: s.vendor, model: s.modelName ?? 'Not recorded', version: s.modelVersion ?? 'Not recorded', purpose: s.purpose, owner: userName(s.ownerId), businessUnit: s.businessUnit,
      lifecycle: s.lifecycle, riskTier: s.riskTier, decisionImpact: s.decisionImpact, dataCategories: s.dataCategories, affectedPeople: s.affectedPeople,
      residency: x?.residency ?? d.org.residency ?? 'Not recorded', personalData: x ? (x.personalData ? `Yes — ${x.principals.join(', ') || 'principals not listed'}` : 'No') : 'Not recorded',
      nextReview: s.nextReview?.slice(0, 10) ?? 'Not set', registered: s.createdAt.slice(0, 10),
      agent: a ? { slug: a.slug, route: a.route === 'mcp' ? 'Governed run (enforced)' : 'Check and record (advisory)', status: a.status, ...a.stats } : undefined,
      rulebook: rb && live ? { slug: rb.slug, version: live.version, hash: live.hash, rules: live.rules.length, askRules: live.rules.filter((r) => r.decide === 'ask').length, refuseRules: live.rules.filter((r) => r.decide === 'refuse').length, signedBy: userName(live.signedBy), signedAt: live.signedAt?.slice(0, 10) ?? '', withdrawn: rb.versions.filter((v) => v.withdrawn).length } : undefined,
      validation: d.assessments.filter((x2) => x2.aiSystemId === s.id).map((x2) => ({ template: x2.template.replace(/_/g, ' '), status: x2.status.replace(/_/g, ' '), tier: x2.resultTier ?? '', author: userName(x2.authorId), reviewer: x2.reviewerId ? userName(x2.reviewerId) : '—', reviewedAt: x2.reviewedAt?.slice(0, 10) ?? '—' })),
      changes,
    };
  });
}

/** Who may export the RBI model documentation: every role but approver (screens disable the button with this). */
export function canExportModelDoc(role: string | undefined) {
  return !!role && role !== 'approver';
}

/** Build the RBI model-documentation export for some or all AI systems and record it. */
export function exportModelDoc(orgId: string, input: { systemIds?: string[]; format: 'pdf' | 'json' }, userId: string) {
  const d = ensureRecordsSeed(orgId);
  const role = memberRole(orgId, userId);
  if (!canExportModelDoc(role)) throw new Error('Owners, admins, viewers and auditors export model documentation; your role cannot.');
  const systems = docSystems(d, input.systemIds);
  if (!systems.length) throw new Error('Choose at least one AI system.');
  const level = levelOfOrg(d.org);
  const hosting = hostingManifest(d);
  const at = new Date().toISOString();
  const claim = level === 'l1' ? 'Every change listed is sealed in the organisation’s hash chain by Elan1 Govern and is not yet externally timestamped.' : `Every change listed is signed with the organisation’s key (${LEVEL_INFO[level].label}) and timestamped by two authorities.`;
  const meta = { format: 'elan1.rbi.model_documentation.v1', org: d.org.name, org_id: d.org.id, level: LEVEL_INFO[level].label, hosting_profile: hosting, generated_at: at, generated_by: userName(userId), systems: systems.length, note: 'Prepared against the RBI’s expectations for model risk management and the FREE-AI framework. Draft — needs legal review.' };
  let text: string;
  let mime: string;
  if (input.format === 'json') {
    text = JSON.stringify({ ...meta, claim, models: systems }, null, 2);
    mime = 'application/json';
  } else {
    const blocks: PdfBlock[] = [
      { kind: 'title', text: 'Model documentation for RBI supervisory review' },
      { kind: 'p', text: `${d.org.name} - ${LEVEL_INFO[level].label}. Generated ${at.slice(0, 16).replace('T', ' ')} UTC by ${userName(userId)}.`, muted: true },
      { kind: 'kv', rows: [['Organisation', d.org.name], ['Assurance level', LEVEL_INFO[level].label], ['Hosting profile', `${hosting.profile} - ${hosting.name}`], ['Residency domain', hosting.residency_domain], ['AI systems documented', String(systems.length)]] },
      { kind: 'p', text: claim, size: 9 },
      { kind: 'h', text: 'Model inventory' },
      { kind: 'table', cols: [{ title: 'System', width: 130 }, { title: 'Model and version', width: 150 }, { title: 'Risk tier', width: 60 }, { title: 'Impact', width: 60 }, { title: 'Stage', width: 95 }], rows: systems.map((s) => [s.name, `${s.model} ${s.version}`, s.riskTier, s.decisionImpact, s.lifecycle.replace('_', ' ')]) },
    ];
    for (const s of systems) {
      blocks.push({ kind: 'rule' }, { kind: 'h', text: s.name });
      blocks.push({ kind: 'kv', rows: [
        ['Model', s.model], ['Version', s.version], ['Kind', s.kind.replace('_', ' ')], ['Vendor', s.vendor], ['Owner', s.owner], ['Business unit', s.businessUnit],
        ['Purpose', s.purpose], ['Decision impact', s.decisionImpact], ['Risk tier', s.riskTier], ['Lifecycle', s.lifecycle.replace('_', ' ')], ['Next review', s.nextReview],
        ['Data categories', s.dataCategories.join(', ') || '-'], ['Affected people', s.affectedPeople.join(', ') || '-'], ['Residency', s.residency], ['Personal data (DPDP)', s.personalData],
      ] });
      blocks.push({ kind: 'p', text: 'Controls in operation', size: 10 });
      blocks.push({ kind: 'kv', rows: s.agent && s.rulebook ? [
        ['Agent', `${s.agent.slug} - ${s.agent.route}, ${s.agent.status}`],
        ['Rulebook in force', `${s.rulebook.slug} v${s.rulebook.version} (${s.rulebook.rules} rules: ${s.rulebook.askRules} ask a person, ${s.rulebook.refuseRules} refuse; default refuse)`],
        ['Published by', `${s.rulebook.signedBy}, ${s.rulebook.signedAt}`], ['Withdrawn versions', String(s.rulebook.withdrawn)],
        ['Last 7 days', `${s.agent.calls7d} calls - ${s.agent.allowed7d} allowed, ${s.agent.asked7d} asked a person, ${s.agent.refused7d} refused`],
      ] : [['Runtime control', 'Not governed at runtime: no linked agent, so no receipts.']] });
      blocks.push({ kind: 'p', text: 'Validation and sign-off', size: 10 });
      blocks.push(s.validation.length ? { kind: 'table', cols: [{ title: 'Assessment', width: 120 }, { title: 'Status', width: 90 }, { title: 'Result', width: 70 }, { title: 'Author', width: 95 }, { title: 'Signed off by', width: 120 }], rows: s.validation.map((v) => [v.template, v.status, v.tier, v.author, `${v.reviewer} ${v.reviewedAt}`]) } : { kind: 'p', text: 'No assessment yet. The risk tier stays unassessed until a different person approves one.', muted: true });
      if (s.changes.length) {
        blocks.push({ kind: 'p', text: 'Change log (receipts)', size: 10 });
        blocks.push({ kind: 'table', cols: [{ title: 'Receipt', width: 60 }, { title: 'When', width: 90 }, { title: 'Change', width: 210 }, { title: 'By', width: 135 }], rows: s.changes.map((c) => [`#${c.seq}`, c.ts.slice(0, 10), c.action, c.by]) });
      }
    }
    blocks.push({ kind: 'rule' }, { kind: 'p', text: `${meta.note} Issued through Elan1 Govern - ${LEGAL_ENTITY}.`, size: 8, muted: true });
    text = buildPdf({ title: `Model documentation - ${d.org.name}`, footer: `${d.org.name} - RBI model documentation - ${at.slice(0, 10)}`, blocks, createdAt: at });
    mime = 'application/pdf';
  }
  const digest = sha256Hex(text);
  const filename = `rbi-model-documentation-${d.org.slug}-${at.slice(0, 10)}.${input.format}`;
  const r = append(d, { kind: 'admin', actor: userId, action: 'inventory.model_doc_exported', details: { systems: systems.length, format: input.format, digest: digest.slice(0, 16), hosting_profile: hosting.profile, level } });
  const rec: ModelDocExport = { id: rid('mdx'), at: r.ts, by: userId, systems: systems.length, format: input.format, digest, seq: r.seq, filename };
  st(d).modelDocs.unshift(rec);
  return { filename, mime, text, digest, seq: r.seq, systems: systems.length };
}

export function modelDocHistory(orgId: string) {
  return clone(st(ensureRecordsSeed(orgId)).modelDocs.slice(0, 10));
}

/* ══ Hosting profiles: profile 2, a dedicated residency domain ══════════ */

export const HOSTING_PROFILES = [
  { n: 1, name: 'Hosted, shared', minLevel: 'l1' as LevelId, description: 'elan1 runs one stack for many organisations in AWS ap-south-1 (Mumbai). Every query is scoped to your organisation by row-level security.' },
  { n: 2, name: 'Dedicated residency domain', minLevel: 'l2' as LevelId, description: 'A stack of your own in the Indian region you choose: your own database, key ring, write-once bucket and network. Nothing is shared with another organisation.' },
  { n: 3, name: 'Customer-held keys', minLevel: 'l3' as LevelId, description: 'The signing key lives in your HSM or your own AWS account; elan1 never holds it.' },
  { n: 4, name: 'Sovereign, on premises', minLevel: 'sovereign' as LevelId, description: 'You run the whole platform on your own infrastructure, with your own timestamp authorities.' },
];

export const DEDICATED_REGIONS = ['AWS ap-south-1 (Mumbai)', 'AWS ap-south-2 (Hyderabad)'];

export function hostingManifest(d: OrgDB) {
  const level = levelOfOrg(d.org);
  const ded = st(d).hosting.dedicated;
  // a dedicated domain counts only from L2 (an organisation moved back to L1 is on profile 1 until it returns to L2)
  const dedicated = ded?.status === 'active' && d.org.deployment !== 'sovereign' && atLeast(level, 'l2');
  const profile = d.org.deployment === 'sovereign' ? 4 : level === 'l3' ? 3 : dedicated ? 2 : 1;
  const name = HOSTING_PROFILES[profile - 1].name + (profile === 3 && dedicated ? ', in a dedicated residency domain' : '');
  return { profile, name, dedicated, residency_domain: dedicated ? `${ded!.domain} · ${ded!.region}` : d.org.residency ?? 'AWS ap-south-1 (Mumbai)' };
}

export function hostingView(orgId: string) {
  const d = ensureRecordsSeed(orgId);
  const level = levelOfOrg(d.org);
  const sov = d.org.deployment === 'sovereign';
  const m = hostingManifest(d);
  const ded = st(d).hosting.dedicated;
  return {
    level, sovereign: sov, current: m, dedicated: ded ? clone(ded) : undefined,
    eligible: !sov && atLeast(level, 'l2'),
    /** a dedicated domain was active but the level is now below L2: it does not count until the organisation is back on L2 */
    suspended: !!ded && ded.status === 'active' && !m.dedicated,
    /** where hosting_profile is stated: the RBI model documentation always, evidence bundle manifests from L2 */
    inBundles: atLeast(level, 'l2'),
    profiles: HOSTING_PROFILES.map((p) => ({ ...p, current: p.n === m.profile, reachable: sov ? p.n === 4 : atLeast(level, p.minLevel) })),
    components: ded && ded.status !== 'returned' ? [
      { name: 'Database', where: `Amazon RDS for PostgreSQL 16, single tenant · ${ded.region}` },
      { name: 'Signing key ring', where: level === 'l3' ? 'Your HSM (customer-held), reached from the dedicated network' : `AWS KMS key ring of its own · ${ded.region}` },
      { name: 'Evidence store', where: `S3 bucket with Object Lock (compliance mode) · ${ded.region}` },
      { name: 'Network', where: `Its own VPC and private endpoints · ${ded.domain}` },
      { name: 'Backups', where: ded.region.includes('Mumbai') ? 'AWS ap-south-2 (Hyderabad), encrypted' : 'AWS ap-south-1 (Mumbai), encrypted' },
    ] : [],
  };
}

function domainFor(d: OrgDB, region: string) {
  return `${d.org.slug.split('-')[0]}.${region.includes('Hyderabad') ? 'aps2' : 'aps1'}.dedicated.govern.elan1.in`;
}

export function requestDedicated(orgId: string, region: string, userId: string) {
  const d = ensureRecordsSeed(orgId);
  const role = memberRole(orgId, userId);
  if (role !== 'owner') throw new Error('Only an owner moves the organisation to a dedicated residency domain.');
  if (d.org.deployment === 'sovereign') throw new Error('A Sovereign deployment already runs on your own infrastructure (hosting profile 4).');
  if (!atLeast(levelOfOrg(d.org), 'l2')) throw new Error(`A dedicated residency domain starts at ${LEVEL_INFO.l2.label}.`);
  if (!DEDICATED_REGIONS.includes(region)) throw new Error('Choose an Indian region.');
  const s = st(d);
  if (s.hosting.dedicated && s.hosting.dedicated.status !== 'returned') throw new Error(s.hosting.dedicated.status === 'active' ? 'The organisation already has a dedicated residency domain.' : 'A dedicated domain is already being provisioned.');
  const domain = domainFor(d, region);
  const r = append(d, { kind: 'admin', actor: userId, action: 'hosting.dedicated_requested', details: { region, domain, profile: 2 } });
  s.hosting.dedicated = { status: 'provisioning', region, domain, requestedBy: userId, requestedAt: r.ts, requestSeq: r.seq };
  touch(orgId, 'deployment');
  return clone(s.hosting.dedicated);
}

export function activateDedicated(orgId: string, userId: string) {
  const d = ensureRecordsSeed(orgId);
  if (memberRole(orgId, userId) !== 'owner') throw new Error('Only an owner confirms the cut-over.');
  const ded = st(d).hosting.dedicated;
  if (!ded || ded.status !== 'provisioning') throw new Error('Nothing is waiting to cut over.');
  const head = d.receipts[d.receipts.length - 1];
  const r = append(d, { kind: 'admin', actor: userId, action: 'hosting.dedicated_activated', details: { region: ded.region, domain: ded.domain, profile: 2, from_seq: head.seq + 1 } });
  Object.assign(ded, { status: 'active', activatedBy: userId, activatedAt: r.ts, activateSeq: r.seq });
  touch(orgId, 'deployment');
  return clone(ded);
}

export function returnToShared(orgId: string, reason: string, userId: string) {
  const d = ensureRecordsSeed(orgId);
  if (memberRole(orgId, userId) !== 'owner') throw new Error('Only an owner moves the organisation back to the shared stack.');
  const ded = st(d).hosting.dedicated;
  if (!ded || ded.status === 'returned') throw new Error('The organisation has no dedicated residency domain.');
  if (reason.trim().length < 8) throw new Error('Say why, in a sentence.');
  const r = append(d, { kind: 'admin', actor: userId, action: 'hosting.dedicated_returned', details: { region: ded.region, domain: ded.domain, was: ded.status, reason: reason.trim() } });
  Object.assign(ded, { status: 'returned', returnedBy: userId, returnedAt: r.ts, returnSeq: r.seq, reason: reason.trim() });
  touch(orgId, 'deployment');
  // the profile the organisation is on now: 1 when hosted and shared, 3 at L3 (customer-held keys)
  const m = hostingManifest(d);
  return { ...clone(ded), profile: m.profile, profileName: m.name };
}

function seedHosting(d: OrgDB, s: RecordsLedgerState) {
  if (d.org.id !== 'org_northbank') return;
  const owner = ownerOf(d);
  const region = DEDICATED_REGIONS[0];
  const domain = domainFor(d, region);
  const r1 = append(d, { kind: 'admin', actor: owner, action: 'hosting.dedicated_requested', details: { region, domain, profile: 2 } });
  const head = d.receipts[d.receipts.length - 1];
  const r2 = append(d, { kind: 'admin', actor: owner, action: 'hosting.dedicated_activated', details: { region, domain, profile: 2, from_seq: head.seq + 1 } });
  s.hosting.dedicated = { status: 'active', region, domain, requestedBy: owner, requestedAt: r1.ts, requestSeq: r1.seq, activatedBy: owner, activatedAt: r2.ts, activateSeq: r2.seq };
}

/* ══ The API the screens call ════════════════════════════════════════════ */

export const recordsApi = {
  async consents(orgId: string) { await wait(); return consentView(orgId); },
  async g1Check(orgId: string, identifier: string, purposeId: string, channel: ConsentChannel) { await wait(80, 200); return g1Check(orgId, identifier, purposeId, channel); },
  async recordConsent(orgId: string, input: Parameters<typeof recordConsent>[1], userId: string) { await wait(200, 400); return recordConsent(orgId, input, userId); },
  async withdrawConsent(orgId: string, id: string, input: { via: string; reason: string }, userId: string) { await wait(200, 400); return withdrawConsent(orgId, id, input, userId); },
  async erasurePlan(orgId: string, identifier: string) { await wait(80, 200); return previewErasurePlan(orgId, identifier); },
  async requestPlan(orgId: string, e: ErasureRequest) { await wait(40, 120); return planForRequest(orgId, e); },
  async openErasure(orgId: string, input: { subjectRef: string; identifier: string; reason: string }, userId: string) { await wait(250, 450); return openErasureWithPlan(orgId, input, userId); },
  async erasureRefusals(orgId: string) { await wait(40, 120); return erasureRefusals(orgId); },
  async declarations(orgId: string) { await wait(); return declarationsView(orgId); },
  async withdrawVersion(orgId: string, rulebookId: string, version: number, reason: string, userId: string) { await wait(250, 450); return withdrawVersion(orgId, rulebookId, version, reason, userId); },
  async gaps(orgId: string) { await wait(60, 160); return gapsView(orgId); },
  async sealGap(orgId: string, input: Parameters<typeof sealGap>[1], userId: string) { await wait(250, 450); return sealGap(orgId, input, userId); },
  async setModel(orgId: string, target: { kind: 'agent' | 'ai_system'; id: string }, input: { name: string; version: string }, userId: string) { await wait(200, 400); return setModel(orgId, target, input, userId); },
  async exportModelDoc(orgId: string, input: { systemIds?: string[]; format: 'pdf' | 'json' }, userId: string) { await wait(300, 600); return exportModelDoc(orgId, input, userId); },
  async modelDocHistory(orgId: string) { await wait(40, 120); return modelDocHistory(orgId); },
  async hosting(orgId: string) { await wait(60, 160); return hostingView(orgId); },
  async requestDedicated(orgId: string, region: string, userId: string) { await wait(300, 600); return requestDedicated(orgId, region, userId); },
  async activateDedicated(orgId: string, userId: string) { await wait(300, 600); return activateDedicated(orgId, userId); },
  async returnToShared(orgId: string, reason: string, userId: string) { await wait(300, 600); return returnToShared(orgId, reason, userId); },
  /** seed (synchronous): the model fields on agents and systems, for screens that read them directly */
  ensureSeed(orgId: string) { ensureRecordsSeed(orgId); },
};
