/**
 * The developer path to production — sandbox tenant, conformance runs, production-key requests with human review,
 * and promotion from advisory (check and record) to enforced (governed run).
 *
 * State lives with the organisation (`devpath` on its database, absent in state saved before it, so every read
 * defaults it). Every recorded write appends a receipt to the organisation's chain through `append` / `logAdmin`.
 *
 * Who reviews: on a hosted organisation a person at Elan1 reviews production keys and promotions (the review desk
 * is shown in the demo so the whole path can be walked). On a Sovereign installation the review belongs to the
 * customer: an owner or admin other than the requester decides, under their own name.
 */
import type { Agent, Decision, LevelId, Receipt } from '@/types';
import { canonical, sha256Hex, verifyChain } from '@/lib/crypto';
import { atLeast, levelOfOrg } from '@/lib/levels';
import { makeRand } from '@/lib/prng';
import { userById, userName } from './users';
import { SCENARIOS, type Call } from './scenarios';
import { append, decideApproval, getDB, governCall, logAdmin, memberRole, readOnlyOpen, touch, type OrgDB } from './db';
import { CONFORMANCE_LEVELS, CONFORMANCE_TESTS, bannedClaims, type ConformanceLevel } from './devpathData';
import { refusalFor, isPersonalEmail, type ApplicantCategory } from '@/features/onboarding/refusals';
// the demo mailbox is loaded when a link is mailed (not at import): db.ts imports this module to seed each demo organisation
import type { pushMail } from '@/features/auth/registry';
const sendMail = (m: Parameters<typeof pushMail>[0]) => import('@/features/auth/registry').then((x) => x.pushMail(m));

const H = 3_600_000;
const D = 24 * H;
const wait = (min = 160, max = 380) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const iso = (t = Date.now()) => new Date(t).toISOString();
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');

export const SUITE_VERSION = 'elan1-conformance 1.2.0';
/** The person at Elan1 who reviews production keys and promotions for hosted organisations (shown on receipts). */
export const ELAN1_REVIEWER = 'Elan1 production review (Meera Iyer)';
export const REVIEW_TARGET_DAYS = 2;
export const PROMOTION_MIN_DAYS = 30;
export const SANDBOX_LIMITS = { perMinute: 10, concurrent: 2, perMonth: 5000 };

/* ── Types ─────────────────────────────────────────────────── */

export interface SandboxTenant {
  id: string;
  status: 'unverified' | 'active';
  email: string;
  company: string;
  description: string;
  agentSlug: string;
  appliedAt: string;
  appliedBy: string;
  token: string;
  verifiedAt?: string;
  keyPrefix?: string;
  fixtures: string[];
  seqs: { applied?: number; created?: number; key?: number };
}

export type TestStatus = 'pass' | 'fail' | 'not_applicable';
export interface TestResult { id: string; title: string; status: TestStatus; detail: string }

export interface RunInput {
  /** a REST client says it treats a timeout or a 5xx as a refusal */
  failClosed: boolean;
  /** waits Retry-After seconds on a 429 */
  retryAfter: boolean;
  /** verifies X-Elan1-Signature and the 5-minute window */
  webhookVerify: boolean;
  /** tells POLICY / GATE / PLATFORM apart and retries only PLATFORM with the same intent */
  familyHandling: boolean;
  /** the copy the integration shows people (scanned by C13 and C14) */
  copy: string;
}

export interface ConformanceRun {
  id: string;
  suite: string;
  at: string;
  by: string;
  orgId: string;
  orgName: string;
  agentSlug: string;
  route: Agent['route'];
  level: LevelId;
  sample: { receipts: number; from?: number; to?: number; label: string };
  results: TestResult[];
  passed: number;
  failed: number;
  allPassed: boolean;
  /** conformance levels the sample reaches, lowest first */
  levels: { id: ConformanceLevel['id']; name: string; reached: boolean; why: string }[];
  highest?: ConformanceLevel['id'];
  digest: string;
  seq?: number;
}

export type RequestStatus = 'draft' | 'in_review' | 'approved' | 'declined' | 'issued' | 'withdrawn';
export const REVIEW_CHECKS = [
  { id: 'conformance', label: 'The conformance result file passes C1–C14 and belongs to this agent' },
  { id: 'declaration', label: 'The declaration version is published and is the one the agent runs' },
  { id: 'target', label: 'The target system and residency domain match the organisation' },
  { id: 'owner', label: 'A named person owns the agent in production and can be reached' },
] as const;
export type ReviewCheckId = typeof REVIEW_CHECKS[number]['id'];

export interface ProdKeyRequest {
  id: string;
  agentSlug: string;
  status: RequestStatus;
  requestedBy: string;
  requestedAt: string;
  submittedAt?: string;
  dueBy?: string;
  conformanceRunId?: string;
  declarationVersion?: number;
  targetSystem: string;
  residency: string;
  productionOwnerId: string;
  enforcement: 'governed_run' | 'check_and_record';
  reversal: 'reversal_plan' | 'irreversible';
  reversalNote: string;
  reviewer?: string;
  reviewedAt?: string;
  checks?: Partial<Record<ReviewCheckId, boolean>>;
  note?: string;
  keyPrefix?: string;
  issuedAt?: string;
  issuedBy?: string;
  seqs: { requested?: number; reviewed?: number; issued?: number; withdrawn?: number };
}

export interface BypassItem { id: string; path: string; evidence: string; testedAt: string }
export const BYPASS_PATHS = [
  { id: 'direct_api', label: 'A direct call to the target’s API with the agent’s old credentials fails (401 or 403)' },
  { id: 'service_account', label: 'The agent’s service account has no write permission on the target any more' },
  { id: 'network', label: 'The agent’s runtime cannot reach the target over the network except through Elan1 Govern' },
  { id: 'stored_tokens', label: 'Every stored token or API key for the target was rotated, and the new ones are held only by the connector' },
] as const;

export interface PromotionRequest {
  id: string;
  agentSlug: string;
  fromRoute: Agent['route'];
  status: 'in_review' | 'approved' | 'declined' | 'withdrawn';
  requestedBy: string;
  requestedAt: string;
  dueBy: string;
  advisorySince: string;
  days: number;
  advisoryDecisions: number;
  /** distinct days (IST) with advisory decisions (absent on requests saved before it was recorded) */
  activeDays?: number;
  bypass: BypassItem[];
  reviewer?: string;
  reviewedAt?: string;
  note?: string;
  seqs: { requested?: number; reviewed?: number };
}

export interface DevPathState { v: 1; seeded?: boolean; sandbox?: SandboxTenant; runs: ConformanceRun[]; requests: ProdKeyRequest[]; promotions: PromotionRequest[] }

type WithDevPath = OrgDB & { devpath?: DevPathState };

function stateOf(d: OrgDB): DevPathState {
  const w = d as WithDevPath;
  if (!w.devpath || w.devpath.v !== 1) w.devpath = { v: 1, runs: [], requests: [], promotions: [] };
  w.devpath.runs ??= [];
  w.devpath.requests ??= [];
  w.devpath.promotions ??= [];
  return w.devpath;
}

/* ── Helpers ───────────────────────────────────────────────── */

/** `from` plus `days` working days (Monday to Friday), at the same time of day. */
export function addWorkingDays(from: number, days: number) {
  let t = from;
  let left = days;
  while (left > 0) {
    t += D;
    const wd = new Date(t + 5.5 * H).getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return t;
}

export const isSovereign = (d: OrgDB) => d.org.deployment === 'sovereign';

function requireRole(orgId: string, userId: string, roles: string[], what: string) {
  const role = memberRole(orgId, userId);
  if (!role || !roles.includes(role)) throw new Error(`${what} Your role cannot do this.`);
  return role;
}

function agentOf(d: OrgDB, slug: string) {
  const a = d.agents.find((x) => x.slug === slug) as (OrgDB['agents'][number] & { retiredAt?: string }) | undefined;
  if (!a) throw new Error(`No agent called ${slug}.`);
  return a;
}

function liveSandboxKey(a: Agent) {
  return a.keys.find((k) => k.environment === 'sandbox' && !k.revoked && !(k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) && !(k as { revokeAt?: string }).revokeAt);
}

function publishedVersion(d: OrgDB, a: Agent) {
  const rb = d.rulebooks.find((r) => r.id === a.rulebookId);
  const pubs = rb?.versions.filter((v) => v.status === 'published') ?? [];
  return pubs.find((v) => v.version === rb?.currentVersion) ?? pubs[pubs.length - 1];
}

function ownerOf(d: OrgDB) {
  return d.members.find((m) => m.role === 'owner' && m.status === 'active')?.userId;
}

/**
 * Who decides a review here, and whether `userId` may. Nobody reviews their own request, and only an owner or admin
 * may decide. On a hosted organisation the decision belongs to Elan1's review desk: in this demo an owner or admin
 * who did not ask stands in for it, and the receipt names that person (marked as the desk's stand-in), never a
 * reviewer who did not act. On Sovereign the customer's owner or admin decides under their own name.
 */
export function reviewerFor(orgId: string, requestedBy: string, userId?: string): { mode: 'elan1' | 'customer'; actor: string; canAct: boolean; whyNot?: string; standIn?: boolean } {
  const d = getDB(orgId);
  const sovereign = isSovereign(d);
  const mode = sovereign ? 'customer' as const : 'elan1' as const;
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') {
    return { mode, actor: userId ?? '', canAct: false, whyNot: sovereign ? 'On a Sovereign installation an owner or admin of your organisation reviews.' : 'Elan1’s production reviewers decide. In this demo an owner or admin who did not ask stands in for them; your role cannot.' };
  }
  if (userId === requestedBy) return { mode, actor: userId, canAct: false, whyNot: sovereign ? 'You asked for this; a different owner or admin reviews it.' : 'You asked for this, so you cannot review it. A different owner or admin stands in for the Elan1 desk in this demo.' };
  return { mode, actor: userId!, canAct: true, standIn: !sovereign };
}

/** The receipt fields that say who reviewed and in what capacity. */
function reviewerDetails(who: ReturnType<typeof reviewerFor>): Record<string, string> {
  return who.standIn
    ? { reviewer_kind: 'elan1', review_desk: 'Elan1 production review', acted_by: who.actor, acted_as: 'stand-in for the Elan1 desk (demo)' }
    : { reviewer_kind: who.mode, acted_by: who.actor };
}

/* ── Sandbox ───────────────────────────────────────────────── */

export function sandboxReceipts(d: OrgDB, slug?: string) {
  return d.receipts.filter((r) => r.environment === 'sandbox' && (!slug || r.agent === slug));
}

export interface SandboxUsage {
  month: number; lastMinute: number; decisions: number; allowed: number; refused: number; asked: number; resolvedByPerson: number; meteredUnits: 0; perAgent: { slug: string; calls: number }[];
  /** sandbox calls in flight now (the limit is SANDBOX_LIMITS.concurrent) */
  running: number;
  /** calls refused with GATE.SANDBOX_LIMIT_REACHED (recorded, not counted against the limits) */
  limited: number;
}

/** The system rule id on a sandbox call refused for being over a limit (GATE.SANDBOX_LIMIT_REACHED). */
export const SANDBOX_LIMIT_RULE = 'sandbox-limit';
const isLimitRefusal = (r: Receipt) => r.rule_id === SANDBOX_LIMIT_RULE;

/** Sandbox calls in flight per organisation: the "2 at once" limit. */
const inFlight = new Map<string, number>();

export function sandboxUsage(d: OrgDB): SandboxUsage {
  const now = Date.now();
  const monthStart = new Date(new Date(now + 5.5 * H).toISOString().slice(0, 7) + '-01T00:00:00+05:30').getTime();
  const all = sandboxReceipts(d).filter((r) => r.kind === 'decision');
  const limited = all.filter(isLimitRefusal).length;
  const dec = all.filter((r) => !isLimitRefusal(r));
  const month = dec.filter((r) => new Date(r.ts).getTime() >= monthStart).length;
  const lastMinute = dec.filter((r) => now - new Date(r.ts).getTime() < 60_000).length;
  const per = new Map<string, number>();
  dec.forEach((r) => per.set(r.agent ?? '', (per.get(r.agent ?? '') ?? 0) + 1));
  const asks = dec.filter((r) => r.decision === 'ask');
  const resolvedByPerson = asks.filter((r) => { const a = d.approvals.find((x) => x.seq === r.seq); return !!a && (a.status === 'approved' || a.status === 'rejected') && !!a.decidedBy && a.decidedBy !== 'system'; }).length;
  return {
    month, lastMinute, decisions: dec.length,
    allowed: dec.filter((r) => r.decision === 'allow').length, refused: dec.filter((r) => r.decision === 'refuse').length, asked: asks.length,
    resolvedByPerson, meteredUnits: 0, perAgent: Array.from(per, ([slug, calls]) => ({ slug, calls })).sort((a, b) => b.calls - a.calls),
    running: inFlight.get(d.org.id) ?? 0, limited,
  };
}

const FIXTURES = (d: OrgDB) => [
  `${d.org.name} sandbox tenant (${d.org.residency ?? 'ap-south-1 Mumbai'}), with its own sandbox receipts`,
  '3 vendors: one approved, one new, one with changed bank details',
  '5 bills, one over the approval line',
  '1 customer over its credit limit (for a precondition refusal)',
  'An approver group made of your owners, so a person resolves each held call',
];

/** Apply for a sandbox tenant: work email, company, a one-line description. A verification link is mailed. */
async function applySandbox(orgId: string, input: { email: string; company: string; description: string; category: ApplicantCategory; agentSlug: string }, userId: string) {
  await wait();
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins apply for the sandbox.');
  const d = getDB(orgId);
  const st = stateOf(d);
  if (st.sandbox?.status === 'active') throw new Error('This organisation already has a sandbox tenant.');
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a work email address.');
  const category: ApplicantCategory = isPersonalEmail(email) ? 'individual' : input.category;
  const refused = refusalFor(category);
  if (refused) {
    const r = logAdmin(orgId, userId, 'sandbox.application_refused', { category: refused.id, email_domain: email.split('@')[1] ?? '' });
    touch(orgId, 'devpath');
    return { refused, receipt: r };
  }
  if (input.company.trim().length < 2) throw new Error('Enter the company name.');
  if (input.description.trim().length < 10) throw new Error('Say in one line what your agent will do (10 characters or more).');
  const a = agentOf(d, input.agentSlug);
  if (a.retiredAt) throw new Error(`${a.slug} is retired.`);
  const token = `sbx_${randHex(10)}`;
  const r = logAdmin(orgId, userId, 'sandbox.applied', { email_domain: email.split('@')[1] ?? '', company: input.company.trim(), agent: a.slug }, a.slug);
  st.sandbox = {
    id: `sbx_${d.org.slug}`, status: 'unverified', email, company: input.company.trim(), description: input.description.trim(), agentSlug: a.slug,
    appliedAt: r.ts, appliedBy: userId, token, fixtures: [], seqs: { applied: r.seq },
  };
  await sendMail({ channel: 'email', to: email, orgId, subject: 'Verify your Elan1 Govern sandbox', body: `Open the link to verify ${email} and create the sandbox tenant for ${input.company.trim()}. Your sandbox key is shown once, after you verify.`, link: `/agents/production?tab=sandbox&verify=${token}` });
  touch(orgId, 'devpath');
  return { tenant: clone(st.sandbox), receipt: r };
}

/** Follow the verification link: the tenant is created with its fixtures and a sandbox key, shown once. */
async function verifySandbox(orgId: string, token: string, userId: string) {
  await wait(300, 600);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins verify the sandbox.');
  const d = getDB(orgId);
  const st = stateOf(d);
  const t = st.sandbox;
  if (!t || t.token !== token) throw new Error('This verification link is not valid for this organisation. Apply again for a new one.');
  if (t.status === 'active') throw new Error('This sandbox tenant is already verified. The link works once.');
  const a = agentOf(d, t.agentSlug);
  const secret = `sk_sbx_${randHex(18)}`;
  const now = Date.now();
  const key = { id: `key_${now.toString(36)}${randHex(2)}`, prefix: secret.slice(0, 12), label: 'Sandbox tenant', createdAt: iso(now), environment: 'sandbox' as const, expiresAt: iso(now + 90 * D) };
  a.keys.unshift(key);
  t.status = 'active';
  t.verifiedAt = iso(now);
  t.keyPrefix = key.prefix;
  t.fixtures = FIXTURES(d);
  t.token = `used_${randHex(4)}`;
  const created = logAdmin(orgId, userId, 'sandbox.tenant_created', { tenant: t.id, agent: a.slug, fixtures: t.fixtures.length, metered_at: 0, limit_per_month: SANDBOX_LIMITS.perMonth }, a.slug);
  const k = logAdmin(orgId, userId, 'key.issued', { agent: a.slug, key: key.prefix, environment: 'sandbox', expires: key.expiresAt.slice(0, 10), via: 'sandbox_tenant' }, a.slug);
  t.seqs.created = created.seq;
  t.seqs.key = k.seq;
  touch(orgId, 'agent');
  return { tenant: clone(t), secret, receipt: created };
}

/** A scenario call for this agent that its rulebook decides as `want`, if it has one; otherwise a plain fixture call. */
function fixtureCall(d: OrgDB, a: OrgDB['agents'][number], want: Decision, seed: number): Call {
  const scen = SCENARIOS[a.scenarioKey];
  if (scen) {
    const rand = makeRand(seed);
    let fallback: Call | undefined;
    for (let i = 0; i < 160; i++) {
      const c = rand.weighted(scen.map((s) => [s, s.weight] as const)).make(rand, a.slug);
      fallback ??= c;
      if (c.decision === want) return c;
    }
    if (fallback && want !== 'refuse') return fallback;
  }
  const tool = want === 'refuse' ? 'fixture.not_declared' : a.tools[0] ?? 'fixture.read';
  return { tool, args: { fixture: true, amount: want === 'ask' ? 240000 : 4200 }, decision: want, ruleId: '', reason: '', tags: [], connector: 'Sandbox fixtures' };
}

export type SandboxLimit = 'per_month' | 'concurrent' | 'per_minute';

/**
 * A sandbox call over a limit: refused with GATE.SANDBOX_LIMIT_REACHED and recorded like any refusal, on a sandbox
 * receipt (metered at 0). Nothing ran.
 */
function limitRefusal(d: OrgDB, a: Agent, which: SandboxLimit, want: Decision, running: number) {
  const why = which === 'per_month' ? `the sandbox hard stop of ${SANDBOX_LIMITS.perMonth.toLocaleString('en-IN')} calls this month is reached`
    : which === 'concurrent' ? `${running} sandbox ${running === 1 ? 'call is' : 'calls are'} already in flight; the limit is ${SANDBOX_LIMITS.concurrent} at once`
    : `${SANDBOX_LIMITS.perMinute} sandbox calls were made in the last minute; the limit is ${SANDBOX_LIMITS.perMinute} a minute`;
  const r = append(d, {
    kind: 'decision', agent: a.slug, tool: 'sandbox.fixture', args_summary: { fixture: want }, environment: 'sandbox',
    rule_id: SANDBOX_LIMIT_RULE, decision: 'refuse', reason: `GATE.SANDBOX_LIMIT_REACHED: ${why}. Nothing ran. Sandbox calls are never billed.`, outcome: { status: 'not_run' },
    details: { code: 'GATE.SANDBOX_LIMIT_REACHED', limit: which, in_flight: running, key: liveSandboxKey(a)?.prefix ?? '', route: a.route, mode: a.route === 'mcp' ? 'governed_run' : 'check_and_record' },
  });
  touch(d.org.id, 'devpath');
  return { receipt: r, outcome: undefined as Receipt | undefined, wanted: want, approvalId: undefined as string | undefined, limited: which as SandboxLimit | undefined };
}

/**
 * Send one fixture call with the agent's sandbox key. It is metered at 0. Sandbox limits apply — the month's hard
 * stop, 2 calls in flight at once and 10 a minute — and a call over one is refused and recorded (not thrown).
 */
async function sendFixture(orgId: string, slug: string, want: Decision, userId: string) {
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins run sandbox fixtures.');
  const d = getDB(orgId);
  const st = stateOf(d);
  if (st.sandbox?.status !== 'active') throw new Error('Create and verify the sandbox tenant first.');
  const a = agentOf(d, slug);
  if (!liveSandboxKey(a)) throw new Error(`${slug} has no live sandbox key (sk_sbx_). Issue one on the agent’s Keys tab.`);
  // the limits are checked when the call arrives, before anything waits, so calls sent together are counted together
  const running = inFlight.get(orgId) ?? 0;
  const u = sandboxUsage(d);
  const over: SandboxLimit | undefined = u.month >= SANDBOX_LIMITS.perMonth ? 'per_month' : running >= SANDBOX_LIMITS.concurrent ? 'concurrent' : u.lastMinute + running >= SANDBOX_LIMITS.perMinute ? 'per_minute' : undefined;
  if (over) {
    await wait(60, 140);
    return limitRefusal(d, a, over, want, running);
  }
  inFlight.set(orgId, running + 1);
  touch(orgId, 'devpath');
  try {
    await wait(250, 500);
    const call = fixtureCall(d, a, want, Date.now() % 100000);
    const r = governCall(d, a, call, { environment: 'sandbox' });
    // check and record: the integration reports what happened after it ran an allowed call
    let outcome: Receipt | undefined;
    if (r.decision === 'allow' && a.route !== 'mcp') {
      outcome = append(d, { kind: 'outcome', agent: a.slug, tool: r.tool, ref_seq: r.seq, outcome: { status: 'ok', ref: 'agent-reported', ms: 180 + Math.round(Math.random() * 900) }, details: { reported_by: 'agent', mode: 'check_and_record' }, environment: 'sandbox' });
    }
    return { receipt: r, outcome, wanted: want, approvalId: r.approval?.id, limited: undefined as SandboxLimit | undefined };
  } finally {
    inFlight.set(orgId, Math.max(0, (inFlight.get(orgId) ?? 1) - 1));
    touch(orgId, 'devpath');
  }
}

/* ── Conformance ───────────────────────────────────────────── */

export const DEFAULT_INPUT: RunInput = { failClosed: false, retryAfter: true, webhookVerify: true, familyHandling: true, copy: '' };

/** The checks a governed run or the SDK make for you; a REST client states them. */
export function inputFor(route: Agent['route'], given: Partial<RunInput>): RunInput {
  const byDesign = route !== 'rest';
  return {
    failClosed: byDesign || !!given.failClosed,
    retryAfter: byDesign || !!given.retryAfter,
    webhookVerify: given.webhookVerify ?? true,
    familyHandling: byDesign || !!given.familyHandling,
    copy: given.copy ?? '',
  };
}

const wordRe = (w: string) => new RegExp(`(^|[^a-z-])${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![a-z])`, 'i');
const STOP_WORDS = ['blocks', 'blocked', 'prevents', 'prevented', 'cannot run', 'stopped', 'we block', 'we prevent'];

/**
 * Run C1–C14 against a sample: the agent's sandbox receipts in `d` (or `receipts` when given, e.g. a broken sample).
 * Pure: nothing is written. `level` is the level the copy is judged at.
 */
export function evaluateConformance(d: OrgDB, slug: string, input: RunInput, opts: { receipts?: Receipt[]; label?: string } = {}): Omit<ConformanceRun, 'id' | 'at' | 'by' | 'seq'> {
  const a = agentOf(d, slug);
  const level = levelOfOrg(d.org);
  const sample = (opts.receipts ?? sandboxReceipts(d, slug)).slice().sort((x, y) => x.seq - y.seq);
  // a call refused for being over a sandbox limit never reached the rulebook: it proves nothing about the integration
  const decisions = sample.filter((r) => r.kind === 'decision' && !isLimitRefusal(r));
  const allowed = decisions.filter((r) => r.decision === 'allow');
  const refused = decisions.filter((r) => r.decision === 'refuse');
  const asks = decisions.filter((r) => r.decision === 'ask');
  const outcomes = sample.filter((r) => r.kind === 'outcome');
  const res: TestResult[] = [];
  const add = (id: string, status: TestStatus, detail: string) => res.push({ id, title: CONFORMANCE_TESTS.find((t) => t.id === id)!.title, status, detail });

  const key = liveSandboxKey(a);
  add('C1', key ? 'pass' : 'fail', key ? `Live sandbox key ${key.prefix}…; the call with no key got 401 and wrote no receipt.` : 'The agent has no live sk_sbx_ key.');
  add('C2', allowed.length ? 'pass' : 'fail', allowed.length ? `${allowed.length} allowed ${allowed.length === 1 ? 'call' : 'calls'}, first #${allowed[0].seq}.` : 'No allowed call in the sample. Send an allowed fixture.');
  const refusedSeqs = new Set(refused.map((r) => r.seq));
  const ranAfterRefusal = outcomes.filter((o) => o.ref_seq !== undefined && refusedSeqs.has(o.ref_seq) && o.outcome?.status === 'ok');
  add('C3', !refused.length ? 'fail' : ranAfterRefusal.length ? 'fail' : 'pass',
    !refused.length ? 'No refusal in the sample. Send a fixture that is refused.' : ranAfterRefusal.length ? `The integration reported running refused call #${ranAfterRefusal[0].ref_seq} (outcome #${ranAfterRefusal[0].seq}).` : `${refused.length} ${refused.length === 1 ? 'refusal' : 'refusals'} read as answers; none was run.`);
  const resolved = asks.map((r) => ({ r, ap: d.approvals.find((x) => x.seq === r.seq) })).filter(({ ap }) => ap && (ap.status === 'approved' || ap.status === 'rejected') && ap.decidedBy && ap.decidedBy !== 'system' && !!memberRole(d.org.id, ap.decidedBy));
  add('C4', resolved.length ? 'pass' : 'fail', resolved.length ? `Held call #${resolved[0].r.seq} ${resolved[0].ap!.status} by ${userName(resolved[0].ap!.decidedBy)}.` : asks.length ? `${asks.length} held ${asks.length === 1 ? 'call is' : 'calls are'} still waiting or expired. A person in the organisation must decide one.` : 'No held call in the sample. Send a fixture that asks a person.');
  if (a.route === 'mcp') {
    const missing = allowed.filter((r) => !r.outcome);
    add('C5', missing.length ? 'fail' : 'pass', missing.length ? `Allowed call #${missing[0].seq} has no outcome.` : 'Governed run: Elan1 Govern ran each allowed call and recorded its outcome on the decision.');
  } else {
    const per = new Map<number, number>();
    outcomes.forEach((o) => { if (o.ref_seq !== undefined) per.set(o.ref_seq, (per.get(o.ref_seq) ?? 0) + 1); });
    const dup = Array.from(per).find(([, n]) => n > 1);
    const missing = allowed.filter((r) => !per.has(r.seq) && Date.now() - new Date(r.ts).getTime() > 5 * 60_000);
    add('C5', dup ? 'fail' : missing.length ? 'fail' : 'pass', dup ? `Decision #${dup[0]} has ${dup[1]} outcomes; a second record is a 409.` : missing.length ? `Allowed call #${missing[0].seq} has no outcome recorded after 5 minutes.` : `${per.size} ${per.size === 1 ? 'outcome' : 'outcomes'}, one per allowed decision.`);
  }
  add('C6', input.failClosed ? 'pass' : 'fail', a.route === 'mcp' ? 'Governed run: when Elan1 Govern is unreachable the call is not run.' : a.route === 'sdk' ? 'SDK: guarded raises GovernError and the function does not run.' : input.failClosed ? 'Your REST client treats a timeout or a 5xx as a refusal.' : 'Your REST client has not said it treats a timeout or a 5xx as a refusal.');
  add('C7', input.retryAfter ? 'pass' : 'fail', input.retryAfter ? 'The harness answered 429 with Retry-After: 2; the next request came after 2.1 s.' : 'The next request came 0.2 s after a 429 with Retry-After: 2.');
  const expired = asks.filter((r) => d.approvals.find((x) => x.seq === r.seq)?.status === 'expired');
  add('C8', !asks.length ? 'fail' : expired.length && !resolved.length ? 'fail' : 'pass', !asks.length ? 'No held call to follow.' : expired.length && !resolved.length ? `Held call #${expired[0].seq} expired while the integration waited.` : `Followed ${asks.length} held ${asks.length === 1 ? 'call' : 'calls'} with approval_status, polls of at most 30 s.`);
  const hooks = d.webhooks.filter((w) => w.status !== 'disabled').length;
  add('C9', !hooks ? 'not_applicable' : input.webhookVerify ? 'pass' : 'fail', !hooks ? 'No webhook endpoint is configured; nothing to verify.' : input.webhookVerify ? 'The good delivery was accepted; the forged and the stale ones were rejected.' : 'A forged delivery was accepted.');
  if (!sample.length) add('C10', 'fail', 'No sandbox receipts to verify.');
  else {
    // verify the contiguous stretch of the chain that holds the sample
    const from = sample[0].seq;
    const to = sample[sample.length - 1].seq;
    const range = opts.receipts ?? d.receipts.filter((r) => r.seq >= from && r.seq <= to);
    const rep = verifyChain(range, d.publicKeys, [], { expectedPrev: range[0]?.prev_hash });
    add('C10', rep.result === 'verified' ? 'pass' : 'fail', rep.result === 'verified' ? `${rep.receipts} receipts #${from}–#${to} verify: hashes, links and keys.` : `Verification ${rep.result === 'failed' ? 'failed' : 'could not finish'}${rep.brokenAt ? ` at #${rep.brokenAt}` : ''}${rep.brokenReason ? `: ${rep.brokenReason}` : ''}.`);
  }
  add('C11', input.familyHandling ? 'pass' : 'fail', input.familyHandling ? 'GATE.PRECONDITION_FAILED and POLICY.DENIED_BY_RULE were not retried; PLATFORM.LOG_APPEND_FAILED was retried once with the same intent; an unknown code was treated as a refusal.' : 'POLICY.DENIED_BY_RULE was retried with the same intent.');
  const pv = publishedVersion(d, a);
  const undeclared = Array.from(new Set(decisions.map((r) => r.tool ?? ''))).filter((t) => t && !a.tools.includes(t) && !decisions.some((r) => r.tool === t && r.decision === 'refuse'));
  add('C12', !pv ? 'fail' : undeclared.length ? 'fail' : 'pass', !pv ? 'No published rulebook version for this agent.' : undeclared.length ? `${undeclared.join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} not declared in version ${pv.version}.` : `Every tool called is declared in rulebook version ${pv.version}.`);
  const copy = input.copy.trim();
  const stopHits = a.route !== 'mcp' ? STOP_WORDS.filter((w) => wordRe(w).test(copy)) : [];
  add('C13', !copy ? 'pass' : stopHits.length ? 'fail' : 'pass', !copy ? `No copy supplied; the route is ${a.route === 'mcp' ? 'governed run (enforced)' : 'check and record (advisory)'}.` : stopHits.length ? `Check and record is advisory, but the copy says “${stopHits[0]}”.` : a.route === 'mcp' ? 'Governed run: the copy may say calls are stopped.' : 'The copy describes the integration as advisory.');
  const banned = bannedClaims(level).filter((w) => wordRe(w).test(copy));
  add('C14', banned.length ? 'fail' : 'pass', banned.length ? `At ${level === 'l1' ? 'L1' : level.toUpperCase()} the copy may not say: ${banned.map((b) => `“${b}”`).join(', ')}.${level === 'l1' && banned.includes('signed') ? ' Say “sealed in a hash chain”.' : ''}` : copy ? `${copy.split(/\s+/).length} words scanned; no banned claim for this level.` : 'No copy supplied; nothing to scan.');

  const c10 = res.find((r) => r.id === 'C10')!.status === 'pass';
  const lv = CONFORMANCE_LEVELS.map((l) => {
    const levelOk = atLeast(level, l.minLevel);
    const reached = c10 && levelOk;
    return { id: l.id, name: l.name, reached, why: !c10 ? 'The sample does not verify (C10).' : levelOk ? l.means : `Needs ${l.minLevel === 'l2' ? 'L2 Attested' : 'L3 Proven'}: ${l.means}` };
  });
  const highest = [...lv].reverse().find((l) => l.reached && l.id !== 'CL-D')?.id ?? (lv.find((l) => l.id === 'CL-D')?.reached ? 'CL-D' : undefined);
  const passed = res.filter((r) => r.status !== 'fail').length;
  const failed = res.filter((r) => r.status === 'fail').length;
  const base = {
    suite: SUITE_VERSION, orgId: d.org.id, orgName: d.org.name, agentSlug: slug, route: a.route, level,
    sample: { receipts: sample.length, from: sample[0]?.seq, to: sample[sample.length - 1]?.seq, label: opts.label ?? `${sample.length} sandbox receipts for ${slug}` },
    results: res, passed, failed, allPassed: failed === 0, levels: lv, highest,
  };
  return { ...base, digest: 'sha256:' + sha256Hex(canonical(base)) };
}

/** Run the suite for an agent and keep the result file. Recorded as a receipt. */
async function runConformance(orgId: string, slug: string, given: Partial<RunInput>, userId: string) {
  await wait(500, 900);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins run the conformance suite.');
  const d = getDB(orgId);
  const a = agentOf(d, slug);
  const run = evaluateConformance(d, slug, inputFor(a.route, given));
  const id = `cr_${Date.now().toString(36)}${randHex(2)}`;
  const r = logAdmin(orgId, userId, 'conformance.run', { run: id, agent: slug, passed: run.passed, failed: run.failed, highest: run.highest ?? 'none', digest: run.digest.slice(0, 23) }, slug);
  const full: ConformanceRun = { ...run, id, at: r.ts, by: userId, seq: r.seq };
  const st = stateOf(d);
  st.runs.unshift(full);
  st.runs = st.runs.slice(0, 30);
  touch(orgId, 'devpath');
  return clone(full);
}

/** The result file: what an applicant attaches to a production-key request. */
export function resultFile(run: ConformanceRun | Omit<ConformanceRun, 'id' | 'at' | 'by' | 'seq'> & Partial<ConformanceRun>) {
  return {
    format: 'elan1.conformance.result.v1', suite: run.suite, run_id: run.id ?? 'unrecorded', ran_at: run.at ?? new Date().toISOString(), ran_by: run.by ? userName(run.by) : 'the public sample runner',
    organisation: run.orgName, agent: run.agentSlug, route: run.route, assurance_level: run.level, sample: run.sample,
    tests: run.results.map((t) => ({ id: t.id, title: t.title, result: t.status, detail: t.detail })),
    summary: { passed: run.passed, failed: run.failed, all_passed: run.allPassed },
    conformance_levels: run.levels.map((l) => ({ level: l.id, name: l.name, reached: l.reached })), highest_level: run.highest ?? null,
    digest: run.digest, receipt_seq: run.seq ?? null,
  };
}

/* ── Production-key requests ───────────────────────────────── */

export interface RequestInput {
  agentSlug: string;
  conformanceRunId?: string;
  targetSystem: string;
  residency: string;
  productionOwnerId: string;
  enforcement: ProdKeyRequest['enforcement'];
  reversal: ProdKeyRequest['reversal'];
  reversalNote: string;
}

/** What would stop a request being sent for review, in plain sentences (empty when ready). */
export function requestProblems(orgId: string, input: RequestInput): string[] {
  return problemsIn(getDB(orgId), input);
}

function problemsIn(d: OrgDB, input: RequestInput): string[] {
  const orgId = d.org.id;
  const out: string[] = [];
  const a = d.agents.find((x) => x.slug === input.agentSlug) as (Agent & { retiredAt?: string }) | undefined;
  if (!a) return ['Choose an agent.'];
  if (a.retiredAt) out.push(`${a.slug} is retired.`);
  const st = stateOf(d);
  const run = st.runs.find((r) => r.id === input.conformanceRunId);
  if (!run) out.push('Attach a conformance result file for this agent.');
  else if (run.agentSlug !== a.slug) out.push('The result file is for a different agent.');
  else if (!run.allPassed) out.push(`The result file has ${run.failed} failing ${run.failed === 1 ? 'test' : 'tests'}. Fix them and run the suite again.`);
  if (!publishedVersion(d, a)) out.push('The agent has no published rulebook version to declare.');
  if (input.targetSystem.trim().length < 3) out.push('Name the target system the agent writes to.');
  const residency = d.org.residency ?? 'ap-south-1 Mumbai';
  if (input.residency.trim() !== residency) out.push(`The residency domain must be the organisation’s: ${residency}.`);
  const ownerRole = memberRole(orgId, input.productionOwnerId);
  if (!ownerRole || ownerRole === 'viewer' || ownerRole === 'auditor') out.push('Name a production owner who is an owner, admin or approver here.');
  if (input.reversal === 'reversal_plan' && input.reversalNote.trim().length < 12) out.push('Describe the reversal plan (12 characters or more), or declare the writes irreversible.');
  if (input.enforcement === 'governed_run' && a.route !== 'mcp') out.push('This agent uses check and record. Ask for its promotion to a governed run first, or request the key for check and record.');
  return out;
}

async function requestKey(orgId: string, input: RequestInput, userId: string, opts: { draft?: boolean } = {}) {
  await wait(250, 500);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins ask for production keys.');
  const d = getDB(orgId);
  const a = agentOf(d, input.agentSlug);
  const st = stateOf(d);
  const open = st.requests.find((r) => r.agentSlug === a.slug && (r.status === 'in_review' || r.status === 'approved' || r.status === 'draft'));
  if (open && !opts.draft) {
    if (open.status !== 'draft') throw new Error(`${a.slug} already has a request ${open.status === 'approved' ? 'approved and waiting to be collected' : 'in review'}.`);
  }
  if (opts.draft && open) return { request: clone(open), receipt: undefined as Receipt | undefined };
  const problems = opts.draft ? [] : requestProblems(orgId, input);
  if (problems.length) throw new Error(problems.join(' '));
  const now = Date.now();
  const pv = publishedVersion(d, a);
  const req: ProdKeyRequest = open ?? {
    id: `pkr_${now.toString(36)}${randHex(2)}`, agentSlug: a.slug, status: 'draft', requestedBy: userId, requestedAt: iso(now),
    targetSystem: '', residency: d.org.residency ?? 'ap-south-1 Mumbai', productionOwnerId: a.ownerId, enforcement: a.route === 'mcp' ? 'governed_run' : 'check_and_record', reversal: 'reversal_plan', reversalNote: '', seqs: {},
  };
  Object.assign(req, {
    conformanceRunId: input.conformanceRunId, targetSystem: input.targetSystem.trim(), residency: input.residency.trim() || req.residency, productionOwnerId: input.productionOwnerId || req.productionOwnerId,
    enforcement: input.enforcement, reversal: input.reversal, reversalNote: input.reversalNote.trim(), declarationVersion: pv?.version,
  });
  let r: Receipt | undefined;
  if (opts.draft) {
    r = logAdmin(orgId, userId, 'production_key.drafted', { request: req.id, agent: a.slug }, a.slug);
  } else {
    req.status = 'in_review';
    req.submittedAt = iso(now);
    req.dueBy = iso(addWorkingDays(now, REVIEW_TARGET_DAYS));
    const run = st.runs.find((x) => x.id === req.conformanceRunId);
    r = logAdmin(orgId, userId, 'production_key.requested', {
      request: req.id, agent: a.slug, conformance_run: req.conformanceRunId ?? '', result_digest: run?.digest.slice(0, 23) ?? '', declaration_version: req.declarationVersion ?? 0,
      target: req.targetSystem, residency: req.residency, production_owner: req.productionOwnerId, enforcement: req.enforcement, reversal: req.reversal, review_due: req.dueBy.slice(0, 10),
    }, a.slug);
    req.seqs.requested = r.seq;
  }
  if (!open) st.requests.unshift(req);
  touch(orgId, 'devpath');
  return { request: clone(req), receipt: r };
}

async function reviewRequest(orgId: string, id: string, approve: boolean, checks: Partial<Record<ReviewCheckId, boolean>>, note: string, userId: string) {
  await wait(300, 600);
  const d = getDB(orgId);
  const st = stateOf(d);
  const req = st.requests.find((r) => r.id === id);
  if (!req || req.status !== 'in_review') throw new Error('This request is not waiting for review.');
  const who = reviewerFor(orgId, req.requestedBy, userId);
  if (!who.canAct) throw new Error(who.whyNot ?? 'You cannot review this request.');
  if (approve && REVIEW_CHECKS.some((c) => !checks[c.id])) throw new Error('Approve only when all four checks hold. Decline with a reason otherwise.');
  // the record must back the ticks: a failing result file or a missing owner cannot be approved
  const problems = approve ? requestProblems(orgId, { agentSlug: req.agentSlug, conformanceRunId: req.conformanceRunId, targetSystem: req.targetSystem, residency: req.residency, productionOwnerId: req.productionOwnerId, enforcement: req.enforcement, reversal: req.reversal, reversalNote: req.reversalNote }) : [];
  if (problems.length) throw new Error(`This request cannot be approved as it stands: ${problems.join(' ')} Decline it with that reason.`);
  if (!approve && note.trim().length < 10) throw new Error('Say why the request is declined (10 characters or more). The requester reads it.');
  req.status = approve ? 'approved' : 'declined';
  req.reviewer = who.actor;
  req.reviewedAt = iso();
  req.checks = { ...checks };
  req.note = note.trim() || undefined;
  const r = append(d, {
    kind: 'admin', actor: who.actor, action: approve ? 'production_key.approved' : 'production_key.declined', agent: req.agentSlug,
    details: { request: req.id, agent: req.agentSlug, checks_passed: REVIEW_CHECKS.filter((c) => checks[c.id]).length, within_target: new Date(req.reviewedAt).getTime() <= new Date(req.dueBy ?? req.reviewedAt).getTime(), ...(req.note ? { note: req.note } : {}), ...reviewerDetails(who) },
  });
  req.seqs.reviewed = r.seq;
  touch(orgId, 'devpath');
  return { request: clone(req), receipt: r };
}

/** Collect an approved key: the gk_ key is issued now and shown once. */
async function collectKey(orgId: string, id: string, userId: string) {
  await wait(250, 450);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins collect production keys.');
  const d = getDB(orgId);
  const st = stateOf(d);
  const req = st.requests.find((r) => r.id === id);
  if (!req || req.status !== 'approved') throw new Error('Only an approved request has a key to collect.');
  const a = agentOf(d, req.agentSlug);
  if (a.retiredAt) throw new Error(`${a.slug} is retired. Retired agents get no new keys.`);
  const secret = `gk_${randHex(18)}`;
  const now = Date.now();
  const key = { id: `key_${now.toString(36)}${randHex(2)}`, prefix: secret.slice(0, 12), label: 'Production (reviewed)', createdAt: iso(now), environment: 'production' as const, expiresAt: iso(now + 365 * D) };
  a.keys.unshift(key);
  const r = logAdmin(orgId, userId, 'key.issued', { agent: a.slug, key: key.prefix, environment: 'production', expires: key.expiresAt.slice(0, 10), request: req.id, reviewed_by: req.reviewer ?? '' }, a.slug);
  req.status = 'issued';
  req.keyPrefix = key.prefix;
  req.issuedAt = r.ts;
  req.issuedBy = userId;
  req.seqs.issued = r.seq;
  touch(orgId, 'agent');
  return { request: clone(req), secret, receipt: r };
}

async function withdrawRequest(orgId: string, id: string, userId: string) {
  await wait();
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins withdraw requests.');
  const d = getDB(orgId);
  const req = stateOf(d).requests.find((r) => r.id === id);
  if (!req || (req.status !== 'in_review' && req.status !== 'draft' && req.status !== 'approved')) throw new Error('This request cannot be withdrawn now.');
  req.status = 'withdrawn';
  const r = logAdmin(orgId, userId, 'production_key.withdrawn', { request: req.id, agent: req.agentSlug }, req.agentSlug);
  req.seqs.withdrawn = r.seq;
  touch(orgId, 'devpath');
  return { request: clone(req), receipt: r };
}

/* ── Promotion: advisory → enforced ────────────────────────── */

/** Advisory traffic must still be arriving: the newest check-and-record decision is at most this many days old. */
export const PROMOTION_RECENT_DAYS = 7;

/**
 * The agent's advisory traffic on the chain: production check-and-record decisions. `days` is counted from the first
 * such decision (never from when the agent was added), so an agent with no advisory decisions has 0 days.
 */
export function advisoryEvidence(d: OrgDB, a: Agent) {
  const decisions = d.receipts.filter((r) => r.kind === 'decision' && r.agent === a.slug && r.environment !== 'sandbox' && (r.details?.mode === 'check_and_record' || r.details?.route === 'rest' || r.details?.route === 'sdk'));
  const first = decisions[0];
  const last = decisions[decisions.length - 1];
  const sinceT = first ? new Date(first.ts).getTime() : undefined;
  const days = sinceT !== undefined ? Math.floor((Date.now() - sinceT) / D) : 0;
  const activeDays = new Set(decisions.map((r) => new Date(new Date(r.ts).getTime() + 5.5 * H).toISOString().slice(0, 10))).size;
  const recent = !!last && Date.now() - new Date(last.ts).getTime() <= PROMOTION_RECENT_DAYS * D;
  const connectors = d.connectors.filter((c) => a.connectorIds.includes(c.id));
  return {
    since: sinceT !== undefined ? iso(sinceT) : undefined, lastAt: last?.ts, days, activeDays, recent, decisions: decisions.length,
    connectors: connectors.map((c) => ({ id: c.id, name: c.name, held: c.heldCredential })),
  };
}

/** Why the advisory traffic does not yet qualify for promotion (undefined when it does). */
export function advisoryShortfall(ev: ReturnType<typeof advisoryEvidence>): string | undefined {
  if (!ev.decisions) return 'No advisory traffic on the chain yet: promotion counts days from the first check-and-record decision.';
  if (ev.days < PROMOTION_MIN_DAYS) return `${ev.days} ${ev.days === 1 ? 'day' : 'days'} of advisory traffic; at least ${PROMOTION_MIN_DAYS} are needed (${PROMOTION_MIN_DAYS - ev.days} more).`;
  if (!ev.recent) return `The newest advisory decision is more than ${PROMOTION_RECENT_DAYS} days old. Promotion needs traffic that is still arriving.`;
  return undefined;
}

async function requestPromotion(orgId: string, slug: string, bypass: { id: string; evidence: string }[], userId: string) {
  await wait(250, 500);
  requireRole(orgId, userId, ['owner', 'admin'], 'Owners and admins ask for a promotion.');
  const d = getDB(orgId);
  const a = agentOf(d, slug);
  if (a.retiredAt) throw new Error(`${slug} is retired.`);
  if (a.route === 'mcp') throw new Error(`${slug} already uses a governed run.`);
  const st = stateOf(d);
  if (st.promotions.some((p) => p.agentSlug === slug && p.status === 'in_review')) throw new Error(`${slug} already has a promotion in review.`);
  const ev = advisoryEvidence(d, a);
  const short = advisoryShortfall(ev);
  if (short) throw new Error(`${slug}: ${short}`);
  if (!ev.connectors.length) throw new Error(`${slug} has no connector for Elan1 Govern to run its calls through. Add one in the Records door, under Connectors.`);
  const missing = BYPASS_PATHS.filter((p) => (bypass.find((b) => b.id === p.id)?.evidence.trim().length ?? 0) < 12);
  if (missing.length) throw new Error(`Bypass proof: give evidence (12 characters or more) that ${missing.length === 1 ? 'this path fails' : 'these paths fail'}: ${missing.map((m) => m.label.toLowerCase()).join('; ')}.`);
  const now = Date.now();
  const p: PromotionRequest = {
    id: `pro_${now.toString(36)}${randHex(2)}`, agentSlug: slug, fromRoute: a.route, status: 'in_review', requestedBy: userId, requestedAt: iso(now), dueBy: iso(addWorkingDays(now, REVIEW_TARGET_DAYS)),
    advisorySince: ev.since!, days: ev.days, advisoryDecisions: ev.decisions, activeDays: ev.activeDays,
    bypass: BYPASS_PATHS.map((x) => ({ id: x.id, path: x.label, evidence: bypass.find((b) => b.id === x.id)!.evidence.trim(), testedAt: iso(now) })), seqs: {},
  };
  const r = logAdmin(orgId, userId, 'promotion.requested', { promotion: p.id, agent: slug, from_route: a.route, to_route: 'mcp', advisory_since: ev.since!.slice(0, 10), advisory_days: ev.days, advisory_active_days: ev.activeDays, advisory_decisions: ev.decisions, bypass_paths: p.bypass.length }, slug);
  p.seqs.requested = r.seq;
  st.promotions.unshift(p);
  touch(orgId, 'devpath');
  return { promotion: clone(p), receipt: r };
}

async function reviewPromotion(orgId: string, id: string, approve: boolean, note: string, userId: string) {
  await wait(300, 600);
  const d = getDB(orgId);
  const p = stateOf(d).promotions.find((x) => x.id === id);
  if (!p || p.status !== 'in_review') throw new Error('This promotion is not waiting for review.');
  const who = reviewerFor(orgId, p.requestedBy, userId);
  if (!who.canAct) throw new Error(who.whyNot ?? 'You cannot review this promotion.');
  if (!approve && note.trim().length < 10) throw new Error('Say why the promotion is declined (10 characters or more).');
  const a = agentOf(d, p.agentSlug);
  if (approve && a.route === 'mcp') throw new Error(`${a.slug} already uses a governed run.`);
  p.status = approve ? 'approved' : 'declined';
  p.reviewer = who.actor;
  p.reviewedAt = iso();
  p.note = note.trim() || undefined;
  if (approve) a.route = 'mcp';
  const r = append(d, {
    kind: 'admin', actor: who.actor, action: approve ? 'promotion.approved' : 'promotion.declined', agent: a.slug,
    details: { promotion: p.id, agent: a.slug, from_route: p.fromRoute, to_route: approve ? 'mcp' : p.fromRoute, advisory_days: p.days, ...(p.note ? { note: p.note } : {}), ...reviewerDetails(who) },
  });
  p.seqs.reviewed = r.seq;
  touch(orgId, 'agent');
  return { promotion: clone(p), receipt: r };
}

/* ── Onboarding refusals ───────────────────────────────────── */

/** Record that set-up refused an applicant category. Returns the receipt. */
export function recordApplicantRefusal(orgId: string, userId: string, category: ApplicantCategory, where: 'onboarding' | 'sandbox') {
  const ref = refusalFor(category);
  if (!ref) return undefined;
  return logAdmin(orgId, userId, 'onboarding.applicant_refused', { category: ref.id, where });
}

/* ── Seed: each demo organisation shows the path ───────────── */

/**
 * Seed the path in `d`: a sandbox tenant with the three answers, a conformance run, a production-key request and,
 * where an advisory agent qualifies, a promotion. Every write goes to `d` itself, so the public sample can seed a
 * scratch copy (`live: false`) and leave the organisation's chain untouched. The demo organisations are seeded when
 * the console opens them (db.ts announceOpen), so Activity, Approvals and Billing show the path from the start.
 */
function seedInto(d: OrgDB, live: boolean) {
  const st = stateOf(d);
  if (st.seeded || d.fresh) return;
  st.seeded = true;
  const orgId = d.org.id;
  const owner = ownerOf(d);
  if (!owner) return;
  const admin = d.members.find((m) => m.role === 'admin' && m.status === 'active' && m.userId !== owner)?.userId ?? owner;
  const adm = (actor: string, action: string, details: Record<string, string | number | boolean>, agent?: string) => append(d, { kind: 'admin', actor, action, details, agent });
  const agent = d.agents.find((a) => a.status === 'active' && a.route === 'mcp' && liveSandboxKey(a) && SCENARIOS[a.scenarioKey]) ?? d.agents.find((a) => a.status === 'active' && liveSandboxKey(a));
  if (agent && !d.stop.active) {
    const u = userById(owner);
    const email = u?.email ?? `owner@${d.org.domain ?? 'example.in'}`;
    const applied = adm(owner, 'sandbox.applied', { email_domain: email.split('@')[1] ?? '', company: d.org.name, agent: agent.slug }, agent.slug);
    const created = adm(owner, 'sandbox.tenant_created', { tenant: `sbx_${d.org.slug}`, agent: agent.slug, fixtures: FIXTURES(d).length, metered_at: 0, limit_per_month: SANDBOX_LIMITS.perMonth }, agent.slug);
    st.sandbox = {
      id: `sbx_${d.org.slug}`, status: 'active', email, company: d.org.name, description: agent.description, agentSlug: agent.slug, appliedAt: applied.ts, appliedBy: owner,
      token: `used_${randHex(4)}`, verifiedAt: created.ts, keyPrefix: liveSandboxKey(agent)?.prefix, fixtures: FIXTURES(d), seqs: { applied: applied.seq, created: created.seq },
    };
    // prove the three outcomes in the sandbox: an allow, a refusal, and a held call a person decides
    const have = (dec: Decision) => sandboxReceipts(d, agent.slug).some((r) => r.kind === 'decision' && r.decision === dec);
    let n = 0;
    for (const want of ['allow', 'refuse', 'ask'] as Decision[]) {
      for (let tries = 0; tries < 3 && !have(want); tries++) {
        const r = governCall(d, agent, fixtureCall(d, agent, want, d.org.id.length * 131 + n++ * 977), { environment: 'sandbox' });
        if (r.decision === 'ask' && r.approval) resolveHeld(d, r, owner, live);
      }
    }
    // a conformance run on the reference integration
    const run = evaluateConformance(d, agent.slug, inputFor(agent.route, { webhookVerify: true, copy: atLeast(levelOfOrg(d.org), 'l2') ? 'Every payment is checked against your signed rulebook and recorded before it runs.' : 'Every payment is checked against your rulebook and sealed in a hash chain before it runs.' }));
    const runId = `cr_seed_${d.org.slug}`;
    const rr = adm(owner, 'conformance.run', { run: runId, agent: agent.slug, passed: run.passed, failed: run.failed, highest: run.highest ?? 'none', digest: run.digest.slice(0, 23) }, agent.slug);
    st.runs.unshift({ ...run, id: runId, at: rr.ts, by: owner, seq: rr.seq });
    // a production-key request: in review at L1 and on Sovereign, approved at L2, declined at L3. It is filed only
    // when it passes the same checks as one sent from the console (a passing result file among them).
    const lvl = levelOfOrg(d.org);
    const conn = d.connectors.filter((c) => agent.connectorIds.includes(c.id)).map((c) => c.name).join(', ') || 'Target system';
    const now = Date.now();
    const input: RequestInput = {
      agentSlug: agent.slug, conformanceRunId: runId, targetSystem: conn, residency: d.org.residency ?? 'ap-south-1 Mumbai', productionOwnerId: agent.ownerId,
      enforcement: 'governed_run', reversal: 'reversal_plan', reversalNote: 'Payments are reversed by a credit note within 30 days; bills are voided, never deleted.',
    };
    const problems = problemsIn(d, input);
    const req: ProdKeyRequest | undefined = problems.length ? undefined : {
      id: `pkr_seed_${d.org.slug}`, agentSlug: agent.slug, status: 'in_review', requestedBy: admin, requestedAt: iso(now), submittedAt: iso(now), dueBy: iso(addWorkingDays(now, REVIEW_TARGET_DAYS)),
      conformanceRunId: runId, declarationVersion: publishedVersion(d, agent)?.version, targetSystem: input.targetSystem, residency: input.residency,
      productionOwnerId: input.productionOwnerId, enforcement: input.enforcement, reversal: input.reversal, reversalNote: input.reversalNote, seqs: {},
    };
    if (req) {
      const rq = adm(admin, 'production_key.requested', { request: req.id, agent: agent.slug, conformance_run: runId, result_digest: run.digest.slice(0, 23), declaration_version: req.declarationVersion ?? 0, target: req.targetSystem, residency: req.residency, production_owner: req.productionOwnerId, enforcement: req.enforcement, reversal: req.reversal, review_due: req.dueBy!.slice(0, 10) }, agent.slug);
      req.seqs.requested = rq.seq;
      st.requests.unshift(req);
    }
    if (req && (lvl === 'l2' || lvl === 'l3')) {
      const approve = lvl === 'l2';
      req.status = approve ? 'approved' : 'declined';
      req.reviewer = ELAN1_REVIEWER;
      req.reviewedAt = iso();
      req.checks = approve ? { conformance: true, declaration: true, target: true, owner: true } : { conformance: true, declaration: true, target: true, owner: false };
      req.note = approve ? undefined : `The named production owner, ${userName(req.productionOwnerId)}, is on leave until next month. Name someone who can be reached while the key is live.`;
      const rv = append(d, { kind: 'admin', actor: ELAN1_REVIEWER, action: approve ? 'production_key.approved' : 'production_key.declined', agent: agent.slug, details: { request: req.id, agent: agent.slug, checks_passed: approve ? 4 : 3, within_target: true, ...(req.note ? { note: req.note } : {}), reviewer_kind: 'elan1' } });
      req.seqs.reviewed = rv.seq;
    }
  }
  // a promotion from check and record to a governed run, for an advisory agent whose traffic qualifies
  const adv = d.agents.find((a) => a.status === 'active' && a.route !== 'mcp' && !advisoryShortfall(advisoryEvidence(d, a)) && advisoryEvidence(d, a).connectors.length);
  if (adv) {
    const ev = advisoryEvidence(d, adv);
    const now = Date.now();
    const evidence: Record<string, string> = {
      direct_api: 'Called the target API with the retired service token from the agent host: 401 Unauthorized at 10:42 IST.',
      service_account: 'Write role removed from the agent’s service account; a test write was refused with 403.',
      network: 'Egress from the agent subnet to the target allowed only via the Elan1 Govern connector; curl timed out.',
      stored_tokens: 'All 3 API tokens for the target rotated; the new token is held only by the connector.',
    };
    const p: PromotionRequest = {
      id: `pro_seed_${d.org.slug}`, agentSlug: adv.slug, fromRoute: adv.route, status: 'in_review', requestedBy: admin, requestedAt: iso(now), dueBy: iso(addWorkingDays(now, REVIEW_TARGET_DAYS)),
      advisorySince: ev.since!, days: ev.days, advisoryDecisions: ev.decisions, activeDays: ev.activeDays, bypass: BYPASS_PATHS.map((x) => ({ id: x.id, path: x.label, evidence: evidence[x.id], testedAt: iso(now - 2 * D) })), seqs: {},
    };
    const r = adm(admin, 'promotion.requested', { promotion: p.id, agent: adv.slug, from_route: adv.route, to_route: 'mcp', advisory_since: ev.since!.slice(0, 10), advisory_days: ev.days, advisory_active_days: ev.activeDays, advisory_decisions: ev.decisions, bypass_paths: p.bypass.length }, adv.slug);
    p.seqs.requested = r.seq;
    st.promotions.unshift(p);
    if (levelOfOrg(d.org) === 'l3') {
      p.status = 'declined';
      p.reviewer = ELAN1_REVIEWER;
      p.reviewedAt = iso();
      p.note = 'The network evidence shows a timeout from one host only. Show that every host the agent runs on is blocked, then ask again.';
      const rv = append(d, { kind: 'admin', actor: ELAN1_REVIEWER, action: 'promotion.declined', agent: adv.slug, details: { promotion: p.id, agent: adv.slug, from_route: p.fromRoute, to_route: p.fromRoute, advisory_days: p.days, note: p.note, reviewer_kind: 'elan1' } });
      p.seqs.reviewed = rv.seq;
    }
  }
  if (live) touch(orgId, 'devpath');
}

/** A held sandbox fixture decided by a person (the owner), so the escalation path is proven. */
function resolveHeld(d: OrgDB, r: Receipt, owner: string, live: boolean) {
  const reason = 'Sandbox fixture: approved by a person to prove the escalation path.';
  if (live) {
    try { decideApproval(d.org.id, r.approval!.id, true, owner, reason); } catch { /* left waiting for a person */ }
    return;
  }
  // a scratch copy: the same approval receipt and state change, written to the copy only
  const ap = d.approvals.find((x) => x.id === r.approval!.id);
  if (!ap) return;
  const agent = d.agents.find((x) => x.slug === ap.agentSlug);
  const advisory = agent?.route !== 'mcp';
  const rec = append(d, {
    kind: 'approval', agent: ap.agentSlug, tool: ap.tool, ref_seq: ap.seq, approval: { id: ap.id, status: 'approved', approver: owner, channel: 'web', self_approval: agent?.ownerId === owner },
    decision: 'allow', reason, actor: owner, outcome: advisory ? undefined : { status: 'ok', ref: 'sandbox:fixture', ms: 640 }, environment: 'sandbox',
    details: { channel: 'web', mode: advisory ? 'check_and_record' : 'governed_run', approver_group: ap.approverGroup },
  });
  ap.status = 'approved';
  ap.decidedAt = rec.ts;
  ap.decidedBy = owner;
  ap.decisionReason = reason;
  ap.resultSeq = rec.seq;
}

/** Seed a demo organisation's path (once). Called by db.ts when the console opens the organisation. */
export function ensureDevpathSeed(d: OrgDB) {
  seedInto(d, true);
}

/** The organisation's path-to-production state (seeded on first read for the demo organisations). */
export function devpathState(orgId: string): DevPathState {
  const d = getDB(orgId);
  seedInto(d, true);
  return stateOf(d);
}

/**
 * The demo organisation as the public sample sees it, without writing anything to it: if its path is already
 * seeded, the organisation itself (read, never written); otherwise a scratch copy with the path seeded into it.
 */
function sampleOrg(): OrgDB {
  return readOnlyOpen(() => {
    const real = getDB('org_demo');
    if ((real as WithDevPath).devpath?.seeded) return real;
    const { keys, ...rest } = real;
    const copy = JSON.parse(JSON.stringify(rest)) as OrgDB;
    copy.keys = keys;
    (copy as WithDevPath).devpath = undefined;
    seedInto(copy, false);
    return copy;
  });
}

/* ── The API the screens use ───────────────────────────────── */

export interface DevPathView {
  orgId: string;
  level: LevelId;
  sovereign: boolean;
  residency: string;
  state: DevPathState;
  usage: SandboxUsage;
  agents: { slug: string; name: string; route: Agent['route']; status: Agent['status']; retired: boolean; sandboxKey?: string; productionKeys: number; ownerId: string; publishedVersion?: number; connectors: string[]; advisory?: ReturnType<typeof advisoryEvidence> }[];
  /** people who may own an agent in production (active owners, admins and approvers) */
  people: { id: string; name: string; role: string }[];
  /** the newest sandbox receipts, newest first */
  recentSandbox: Receipt[];
}

export const devpathApi = {
  async view(orgId: string): Promise<DevPathView> {
    await wait(80, 200);
    const d = getDB(orgId);
    const state = devpathState(orgId);
    return clone({
      orgId, level: levelOfOrg(d.org), sovereign: isSovereign(d), residency: d.org.residency ?? 'ap-south-1 Mumbai', state, usage: sandboxUsage(d),
      agents: d.agents.map((a) => ({
        slug: a.slug, name: a.name, route: a.route, status: a.status, retired: !!(a as { retiredAt?: string }).retiredAt, sandboxKey: liveSandboxKey(a)?.prefix,
        productionKeys: a.keys.filter((k) => k.environment === 'production' && !k.revoked).length, ownerId: a.ownerId, publishedVersion: publishedVersion(d, a)?.version,
        connectors: d.connectors.filter((c) => a.connectorIds.includes(c.id)).map((c) => c.name), advisory: a.route !== 'mcp' ? advisoryEvidence(d, a) : undefined,
      })),
      people: d.members.filter((m) => m.status === 'active' && (m.role === 'owner' || m.role === 'admin' || m.role === 'approver')).map((m) => ({ id: m.userId, name: userName(m.userId), role: m.role })),
      recentSandbox: sandboxReceipts(d).slice(-10).reverse(),
    });
  },
  applySandbox, verifySandbox, sendFixture, runConformance, requestKey, reviewRequest, collectKey, withdrawRequest, requestPromotion, reviewPromotion,
  /** A draft request filed from the add-agent wizard when "production" was chosen. */
  async draftRequest(orgId: string, slug: string, userId: string) {
    const d = getDB(orgId);
    const a = agentOf(d, slug);
    return requestKey(orgId, { agentSlug: slug, targetSystem: d.connectors.filter((c) => a.connectorIds.includes(c.id)).map((c) => c.name).join(', '), residency: d.org.residency ?? 'ap-south-1 Mumbai', productionOwnerId: a.ownerId, enforcement: a.route === 'mcp' ? 'governed_run' : 'check_and_record', reversal: 'reversal_plan', reversalNote: '' }, userId, { draft: true });
  },
  /** Run the suite on a public sample: the reference integration, or one with faults planted in it. Nothing is written. */
  async sample(kind: 'reference' | 'broken') {
    await wait(500, 900);
    const d = sampleOrg();
    const agent = d.agents.find((a) => a.scenarioKey === 'invoice-bot') ?? d.agents[0];
    if (kind === 'reference') return evaluateConformance(d, agent.slug, inputFor(agent.route, { webhookVerify: true, copy: 'Every payment is checked against your rulebook and sealed in a hash chain before it runs.' }), { label: `Reference integration: ${agent.slug} at ${d.org.name}` });
    // the broken sample: a REST client that does not fail closed, reports running a refused call, edits a receipt and over-claims
    const base = sandboxReceipts(d, agent.slug).filter((r) => r.kind === 'decision');
    const from = base[0]?.seq ?? d.receipts[0].seq;
    const to = base[base.length - 1]?.seq ?? d.receipts[d.receipts.length - 1].seq;
    const range = clone(d.receipts.filter((r) => r.seq >= from && r.seq <= to && r.environment === 'sandbox' && r.agent === agent.slug));
    const refusedR = range.find((r) => r.decision === 'refuse');
    const tampered = range.find((r) => r.decision === 'allow') ?? range[0];
    if (tampered) tampered.reason = `${tampered.reason ?? ''} (edited after it was sealed)`;
    if (refusedR) range.push({ ...refusedR, seq: refusedR.seq + 0.5, kind: 'outcome', decision: undefined, ref_seq: refusedR.seq, outcome: { status: 'ok', ref: 'agent-reported' } } as Receipt);
    const restAgent = { ...agent, route: 'rest' as const };
    const fake = { ...d, agents: d.agents.map((a) => (a.slug === agent.slug ? restAgent : a)) } as OrgDB;
    return evaluateConformance(fake, agent.slug, { failClosed: false, retryAfter: false, webhookVerify: true, familyHandling: false, copy: 'Our assistant is signed, tamper-proof and blocks every bad payment.' }, { receipts: range.sort((x, y) => x.seq - y.seq), label: `Broken sample: a REST client for ${agent.slug} with planted faults` });
  },
};
