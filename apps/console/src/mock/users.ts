/**
 * DEMO ACCOUNTS — front-end only. Sign-in is mocked in the browser; these are not real secrets
 * and must never be reused for a real service. One organisation per assurance level:
 *   Demo Traders (L1 Guarded) · Northbank (L2 Attested) · Kaveri Health (L3 Proven) · Deccan Cooperative Bank (Sovereign).
 */
import type { ApproverGroup, LevelId, Member, Org, Role, User } from '@/types';

export interface DemoAccount {
  userId: string;
  email: string;
  password: string;
  role: User['role'];
  /** The assurance level of the organisation the account signs in to (for grouping on the sign-in page). */
  level: LevelId;
  orgId: string;
  journey: string;
}

const NOW = Date.now();
const daysAgoIso = (d: number) => new Date(Math.floor((NOW - d * 86_400_000) / 60_000) * 60_000).toISOString();

export const ORGS: Org[] = [
  {
    id: 'org_demo', name: 'Demo Traders Pvt Ltd', slug: 'demo-traders', industry: 'finance', regions: ['India', 'EU'],
    currency: 'INR', timezone: 'Asia/Kolkata', plan: 'l1', createdAt: '2026-06-02T05:30:00Z', keyFingerprint: '',
    levelHistory: [{ level: 'l1', from: '2026-06-02T05:30:00Z' }], deployment: 'hosted', residency: 'ap-south-1 Mumbai', domain: 'demotraders.in',
  },
  {
    id: 'org_northbank', name: 'Northbank Industrial Ltd', slug: 'northbank', industry: 'general', regions: ['India', 'UK'],
    currency: 'INR', timezone: 'Asia/Kolkata', plan: 'l2', createdAt: '2026-07-14T05:30:00Z', keyFingerprint: '',
    levelHistory: [{ level: 'l1', from: '2026-07-14T05:30:00Z' }, { level: 'l2', from: daysAgoIso(45), by: 'u_rohan' }], deployment: 'hosted', residency: 'ap-south-1 Mumbai', domain: 'northbank.co.in',
  },
  {
    id: 'org_kaveri', name: 'Kaveri Health Network', slug: 'kaveri-health', industry: 'healthcare', regions: ['India'],
    currency: 'INR', timezone: 'Asia/Kolkata', plan: 'l3', createdAt: daysAgoIso(150), keyFingerprint: '',
    levelHistory: [{ level: 'l1', from: daysAgoIso(150) }, { level: 'l2', from: daysAgoIso(120), by: 'u_lakshmi' }, { level: 'l3', from: daysAgoIso(30), by: 'u_lakshmi' }], deployment: 'hosted', residency: 'ap-south-1 Mumbai', domain: 'kaverihealth.in',
  },
  {
    id: 'org_deccan', name: 'Deccan Cooperative Bank Ltd', slug: 'deccan-bank', industry: 'finance', regions: ['India'],
    currency: 'INR', timezone: 'Asia/Kolkata', plan: 'sovereign', createdAt: daysAgoIso(95), keyFingerprint: '',
    levelHistory: [{ level: 'sovereign', from: daysAgoIso(95) }], deployment: 'sovereign', residency: 'On premises · Mumbai (Deccan Cooperative Bank data centre, BKC)', domain: 'deccanbank.coop.in',
  },
];

const u = (id: string, name: string, email: string, role: Role, title: string, orgIds: string[], extra: Partial<User> = {}): User => ({
  id, name, email, role, title, initials: name.replace(/^Dr /, '').split(' ').map((w) => w[0]).slice(0, 2).join(''), orgIds, mfa: true, ...extra,
});

export const USERS: User[] = [
  // Demo Traders — L1
  { id: 'u_ananya', name: 'Ananya Rao', email: 'ananya.rao@demotraders.in', role: 'owner', title: 'Head of Operations', initials: 'AR', orgIds: ['org_demo'], phone: '+91 98450 11203', mfa: true },
  { id: 'u_rahul', name: 'Rahul Menon', email: 'rahul.menon@demotraders.in', role: 'admin', title: 'Platform Lead', initials: 'RM', orgIds: ['org_demo'], mfa: true },
  { id: 'u_venkat', name: 'Venkat Iyer', email: 'venkat.iyer@demotraders.in', role: 'approver', title: 'Finance Controller', initials: 'VI', orgIds: ['org_demo'], phone: '+91 98861 40417', mfa: true },
  { id: 'u_meera', name: 'Meera Shah', email: 'meera.shah@demotraders.in', role: 'viewer', title: 'Risk Analyst', initials: 'MS', orgIds: ['org_demo'], mfa: false },
  { id: 'u_kavita', name: 'Kavita Desai', email: 'kavita.desai@desaico.in', role: 'auditor', title: 'Partner, Desai & Co. Chartered Accountants', initials: 'KD', orgIds: ['org_demo', 'org_northbank', 'org_kaveri', 'org_deccan'], mfa: true },
  { id: 'u_arjun', name: 'Arjun Nair', email: 'arjun.nair@demotraders.in', role: 'approver', title: 'Procurement Manager', initials: 'AN', orgIds: ['org_demo'], mfa: true },
  { id: 'u_fatima', name: 'Fatima Sheikh', email: 'fatima.sheikh@demotraders.in', role: 'admin', title: 'Data Protection Officer', initials: 'FS', orgIds: ['org_demo'], mfa: true },
  { id: 'u_sanjay', name: 'Sanjay Gupta', email: 'sanjay.gupta@demotraders.in', role: 'approver', title: 'Engineering Manager', initials: 'SG', orgIds: ['org_demo'], mfa: true },
  { id: 'u_priya', name: 'Priya Krishnan', email: 'priya.krishnan@demotraders.in', role: 'viewer', title: 'Internal Audit', initials: 'PK', orgIds: ['org_demo'], mfa: false },
  { id: 'u_tom', name: 'Tom Whitfield', email: 'tom.whitfield@demotraders.eu', role: 'approver', title: 'EU Finance Lead', initials: 'TW', orgIds: ['org_demo'], mfa: true },
  // Northbank Industrial — L2
  u('u_rohan', 'Rohan Kapoor', 'rohan.kapoor@northbank.co.in', 'owner', 'Chief Financial Officer', ['org_northbank'], { phone: '+91 98200 31877' }),
  u('u_nb_neha', 'Neha Bhatia', 'neha.bhatia@northbank.co.in', 'admin', 'Head of Digital Operations', ['org_northbank']),
  u('u_nb_gaurav', 'Gaurav Sethi', 'gaurav.sethi@northbank.co.in', 'approver', 'Financial Controller', ['org_northbank'], { phone: '+91 98201 44120' }),
  u('u_nb_imran', 'Imran Qureshi', 'imran.qureshi@northbank.co.in', 'approver', 'Purchase Manager', ['org_northbank']),
  u('u_nb_shalini', 'Shalini Rao', 'shalini.rao@northbank.co.in', 'admin', 'Data Protection Officer', ['org_northbank']),
  u('u_nb_karthik', 'Karthik Subramanian', 'karthik.s@northbank.co.in', 'approver', 'Plant Systems Manager', ['org_northbank']),
  u('u_nb_pooja', 'Pooja Malhotra', 'pooja.malhotra@northbank.co.in', 'viewer', 'Risk Analyst', ['org_northbank'], { mfa: false }),
  u('u_nb_deepak', 'Deepak Jain', 'deepak.jain@northbank.co.in', 'viewer', 'Internal Audit', ['org_northbank'], { mfa: false }),
  u('u_nb_james', 'James Holloway', 'james.holloway@northbank.co.uk', 'approver', 'UK Finance Lead', ['org_northbank']),
  // Kaveri Health Network — L3
  u('u_lakshmi', 'Dr Lakshmi Pillai', 'lakshmi.pillai@kaverihealth.in', 'owner', 'Chief Operating Officer', ['org_kaveri'], { phone: '+91 94470 22815' }),
  u('u_kh_arvind', 'Arvind Swamy', 'arvind.swamy@kaverihealth.in', 'admin', 'Head of Clinical Systems', ['org_kaveri']),
  u('u_kh_revathi', 'Revathi Natarajan', 'revathi.n@kaverihealth.in', 'approver', 'Revenue Cycle Controller', ['org_kaveri'], { phone: '+91 94471 60212' }),
  u('u_kh_rafi', 'Mohammed Rafi', 'mohammed.rafi@kaverihealth.in', 'approver', 'Procurement Head', ['org_kaveri']),
  u('u_kh_sneha', 'Dr Sneha Varghese', 'sneha.varghese@kaverihealth.in', 'admin', 'Data Protection Officer', ['org_kaveri']),
  u('u_kh_vivek', 'Vivek Raman', 'vivek.raman@kaverihealth.in', 'approver', 'IT Infrastructure Manager', ['org_kaveri']),
  u('u_kh_nandini', 'Nandini Hegde', 'nandini.hegde@kaverihealth.in', 'viewer', 'Quality and Risk', ['org_kaveri'], { mfa: false }),
  u('u_kh_lata', 'Lata Reddy', 'lata.reddy@kaverihealth.in', 'viewer', 'Internal Audit', ['org_kaveri'], { mfa: false }),
  u('u_kh_joseph', 'Joseph Mathew', 'joseph.mathew@kaverihealth.in', 'approver', 'Insurance Desk Lead', ['org_kaveri']),
  // Deccan Cooperative Bank — Sovereign
  u('u_suresh', 'Suresh Nambiar', 'suresh.nambiar@deccanbank.coop.in', 'owner', 'Chief Technology Officer', ['org_deccan'], { phone: '+91 98690 17344' }),
  u('u_anjali', 'Anjali Kulkarni', 'anjali.kulkarni@deccanbank.coop.in', 'admin', 'Head of IT Risk', ['org_deccan']),
  u('u_dc_prakash', 'Prakash Deshpande', 'prakash.deshpande@deccanbank.coop.in', 'approver', 'Chief Accountant', ['org_deccan'], { phone: '+91 98691 20056' }),
  u('u_dc_farhan', 'Farhan Siddiqui', 'farhan.siddiqui@deccanbank.coop.in', 'approver', 'Vendor Management Head', ['org_deccan']),
  u('u_dc_meenakshi', 'Meenakshi Sundaram', 'meenakshi.s@deccanbank.coop.in', 'admin', 'Data Protection Officer', ['org_deccan']),
  u('u_dc_rajesh', 'Rajesh Patil', 'rajesh.patil@deccanbank.coop.in', 'approver', 'Data Centre Operations Manager', ['org_deccan']),
  u('u_dc_sunita', 'Sunita Joshi', 'sunita.joshi@deccanbank.coop.in', 'viewer', 'Compliance Officer', ['org_deccan'], { mfa: false }),
  u('u_dc_geeta', 'Geeta Bhat', 'geeta.bhat@deccanbank.coop.in', 'viewer', 'Concurrent Auditor', ['org_deccan'], { mfa: false }),
  u('u_dc_ashwin', 'Ashwin Kamath', 'ashwin.kamath@deccanbank.coop.in', 'approver', 'Treasury Manager', ['org_deccan']),
];

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { userId: 'u_ananya', email: 'ananya.rao@demotraders.in', password: 'Demo-Owner-2026', role: 'owner', level: 'l1', orgId: 'org_demo', journey: 'Run the operation: Today, agents, emergency stop, the meter, then the upgrade to L2.' },
  { userId: 'u_rahul', email: 'rahul.menon@demotraders.in', password: 'Demo-Admin-2026', role: 'admin', level: 'l1', orgId: 'org_demo', journey: 'Build: add an agent, write and publish a rulebook, connect an MCP server.' },
  { userId: 'u_venkat', email: 'venkat.iyer@demotraders.in', password: 'Demo-Approver-2026', role: 'approver', level: 'l1', orgId: 'org_demo', journey: 'Decide: work the approvals inbox, approve a held payment.' },
  { userId: 'u_meera', email: 'meera.shah@demotraders.in', password: 'Demo-Viewer-2026', role: 'viewer', level: 'l1', orgId: 'org_demo', journey: 'Watch: read activity, coverage and alerts. Changes nothing.' },
  { userId: 'u_kavita', email: 'kavita.desai@desaico.in', password: 'Demo-Auditor-2026', role: 'auditor', level: 'l1', orgId: 'org_demo', journey: 'Audit four clients, one per level: sample receipts, export a bundle, verify it with six result codes.' },
  { userId: 'u_rohan', email: 'rohan.kapoor@northbank.co.in', password: 'Demo-Owner-L2-2026', role: 'owner', level: 'l2', orgId: 'org_northbank', journey: 'Attested: timestamps from two authorities, sealed records, the L1→L2 boundary, ledger1 and an 8-member evidence bundle.' },
  { userId: 'u_lakshmi', email: 'lakshmi.pillai@kaverihealth.in', password: 'Demo-Owner-L3-2026', role: 'owner', level: 'l3', orgId: 'org_kaveri', journey: 'Proven: counterparties, selective disclosure, earned autonomy and customer-held keys.' },
  { userId: 'u_suresh', email: 'suresh.nambiar@deccanbank.coop.in', password: 'Demo-Owner-SOV-2026', role: 'owner', level: 'sovereign', orgId: 'org_deccan', journey: 'Sovereign: your cluster, your HSM, local timestamp authorities, no egress, air-gapped signed updates.' },
  { userId: 'u_anjali', email: 'anjali.kulkarni@deccanbank.coop.in', password: 'Demo-Admin-SOV-2026', role: 'admin', level: 'sovereign', orgId: 'org_deccan', journey: 'Run the platform: verify, stage and apply an update bundle; run a key ceremony; read the egress log.' },
];

/** Demo Traders' members (kept as before). */
export const MEMBERS: Member[] = USERS.filter((x) => x.orgIds.includes('org_demo') && x.role !== 'auditor').map((x, i): Member => ({
  userId: x.id,
  role: x.role,
  status: 'active',
  lastActiveAt: new Date(NOW - (i + 1) * 3_600_000 * (i % 3 === 0 ? 2 : 7)).toISOString(),
  slackLinked: ['u_venkat', 'u_arjun', 'u_sanjay', 'u_ananya'].includes(x.id),
  whatsappVerified: ['u_venkat', 'u_ananya'].includes(x.id),
})).concat([
  { userId: 'u_kavita', role: 'auditor', status: 'active', lastActiveAt: new Date(NOW - 26 * 3_600_000).toISOString() },
  { userId: 'u_invite_1', role: 'approver', status: 'invited', invitedAt: new Date(NOW - 2 * 86_400_000).toISOString() } as Member,
]);

export const INVITED = [{ id: 'u_invite_1', email: 'deepa.joshi@demotraders.in', role: 'approver' as const, invitedBy: 'u_ananya' }];

export function userById(id?: string): User | undefined {
  return USERS.find((x) => x.id === id);
}

export function userName(id?: string): string {
  return userById(id)?.name ?? (id === 'system' ? 'Elan1 Govern' : id ?? '—');
}

/** Demo Traders' approver groups (kept for older imports). Use approverGroupsFor(orgId) for any organisation. */
export const APPROVER_GROUPS: ApproverGroup[] = [
  { id: 'finance', name: 'Finance', members: ['u_venkat', 'u_tom'] },
  { id: 'procurement', name: 'Procurement', members: ['u_arjun', 'u_venkat'] },
  { id: 'engineering', name: 'Engineering', members: ['u_sanjay', 'u_rahul'] },
  { id: 'privacy', name: 'Privacy', members: ['u_fatima'] },
  { id: 'owners', name: 'Owners', members: ['u_ananya'] },
];

/**
 * How each organisation's people map onto Demo Traders' seeded roles. The seeded catalogue (agents,
 * rulebooks, approvals, assessments) is reused for every organisation with these people in place.
 */
export const PEOPLE_MAP: Record<string, Record<string, string>> = {
  org_demo: {},
  org_northbank: { u_ananya: 'u_rohan', u_rahul: 'u_nb_neha', u_venkat: 'u_nb_gaurav', u_arjun: 'u_nb_imran', u_fatima: 'u_nb_shalini', u_sanjay: 'u_nb_karthik', u_meera: 'u_nb_pooja', u_priya: 'u_nb_deepak', u_tom: 'u_nb_james' },
  org_kaveri: { u_ananya: 'u_lakshmi', u_rahul: 'u_kh_arvind', u_venkat: 'u_kh_revathi', u_arjun: 'u_kh_rafi', u_fatima: 'u_kh_sneha', u_sanjay: 'u_kh_vivek', u_meera: 'u_kh_nandini', u_priya: 'u_kh_lata', u_tom: 'u_kh_joseph' },
  org_deccan: { u_ananya: 'u_suresh', u_rahul: 'u_anjali', u_venkat: 'u_dc_prakash', u_arjun: 'u_dc_farhan', u_fatima: 'u_dc_meenakshi', u_sanjay: 'u_dc_rajesh', u_meera: 'u_dc_sunita', u_priya: 'u_dc_geeta', u_tom: 'u_dc_ashwin' },
};

/** The person in `orgId` who holds the seeded role that `demoUserId` holds at Demo Traders. */
export function personFor(orgId: string, demoUserId: string): string {
  return PEOPLE_MAP[orgId]?.[demoUserId] ?? demoUserId;
}

/** Base approver groups registered for organisations created by sign-up (owners: the creator; the rest empty). */
const ORG_BASE_GROUPS = new Map<string, ApproverGroup[]>();

export function registerBaseGroups(orgId: string, groups: ApproverGroup[]) {
  ORG_BASE_GROUPS.set(orgId, groups);
}

/**
 * The approver groups as seeded, before any edit made in People and roles › Approver groups. Use this only to
 * work out what an edit changes; everything that decides who may approve uses approverGroupsFor (effective).
 */
export function baseApproverGroupsFor(orgId: string): ApproverGroup[] {
  const fresh = ORG_BASE_GROUPS.get(orgId);
  if (fresh) return fresh;
  if (orgId === 'org_demo' || !PEOPLE_MAP[orgId]) return APPROVER_GROUPS;
  return APPROVER_GROUPS.map((g) => ({ ...g, members: g.members.map((m) => personFor(orgId, m)) }));
}

/** Resolves an organisation's effective groups (base plus saved edits); set by the in-memory database. */
let groupResolver: ((orgId: string) => ApproverGroup[] | undefined) | undefined;
export function setGroupResolver(fn: (orgId: string) => ApproverGroup[] | undefined) {
  groupResolver = fn;
}

/**
 * Approver groups for any organisation, as they are now: the seeded membership with the edits saved in
 * People and roles › Approver groups applied (only active members count). Every membership check, escalation,
 * re-route and approval-link recipient list reads this.
 */
export function approverGroupsFor(orgId: string): ApproverGroup[] {
  return groupResolver?.(orgId) ?? baseApproverGroupsFor(orgId);
}

/** The approver group a name or id refers to, in an organisation (effective membership). */
export function groupFor(orgId: string, nameOrId: string): ApproverGroup | undefined {
  const k = nameOrId.trim().toLowerCase();
  return approverGroupsFor(orgId).find((g) => g.id === k || g.name.toLowerCase() === k);
}

/* ── Organisations and people created by sign-up in this browser ── */

/** The registry the sign-up pages keep in this browser (src/features/auth/registry.ts owns the format). */
export const REGISTRY_KEY = 'eg:auth:v1';

interface RegistrySnapshot { orgs?: (Org & { createdBy?: string })[]; users?: User[]; onboarding?: Record<string, unknown> }

export function registrySnapshot(): RegistrySnapshot {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    return raw ? (JSON.parse(raw) as RegistrySnapshot) : {};
  } catch {
    return {};
  }
}

/**
 * Put organisations and people created by sign-up into the shared directory before anything opens a database,
 * so an organisation id from a stored session resolves to its own organisation, never to Demo Traders.
 * The registry module does the same when it loads; both are idempotent.
 */
function hydrateCreated() {
  const snap = registrySnapshot();
  for (const o of snap.orgs ?? []) if (!ORGS.some((x) => x.id === o.id)) ORGS.push(o);
  for (const u of snap.users ?? []) if (!USERS.some((x) => x.id === u.id)) USERS.push(u);
}
hydrateCreated();
