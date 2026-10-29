/**
 * In-memory database for the front end. One OrgDB per organisation, built from the seed catalogues
 * and the signed chain generator, with a live traffic engine and every mutation the console needs.
 * Each mutation that a real backend would record writes a signed receipt to the chain.
 *
 * Four organisations, one per assurance level, each with the full seeded catalogue (7 agents, their
 * rulebooks, connectors, approvals, alerts, incidents, inventory, assessments, members, webhooks):
 *   org_demo      Demo Traders Pvt Ltd          L1 Guarded
 *   org_northbank Northbank Industrial Ltd       L2 Attested since ~45 days ago
 *   org_kaveri    Kaveri Health Network          L3 Proven (L2 since ~120 days, L3 since ~30 days)
 *   org_deccan    Deccan Cooperative Bank Ltd    Sovereign, on its own infrastructure in Mumbai
 * Level-specific state (grants, anchors, seals, packs, erasures …) lives in `platform` (see platform.ts).
 */
import type {
  Agent, AiSystem, Alert, Approval, ApproverGroup, Assessment, Channel, Checkpoint, Connector, Control, Framework, Incident, IndustryPack, Invoice,
  Member, Org, Receipt, RiskTag, Role, Rule, Rulebook, RuleSuggestion, SigningKey, UsageMonth, User, Webhook, WebhookEvent,
} from '@/types';
import { GENESIS, keyFromSeed, signCheckpoint, signReceipt, signRedaction, sha256Hex, canonical, type KeyPair } from '@/lib/crypto';
import { sealedRecordId } from '@/lib/seal';
import { makeRand } from '@/lib/prng';
import { atLeast, levelOfOrg } from '@/lib/levels';
import { applyAutonomy, grantFor } from '@/lib/autonomy';
import { evaluate, setToolTagResolver } from '@/lib/evaluate';
import { can } from '@/lib/permissions';
import { AGENTS, CONNECTORS, RULEBOOKS, SUGGESTIONS, TOOLS, rulebookYaml, type ToolDef } from './catalog';
import { AI_SYSTEMS, ASSESSMENTS, CONTROLS, FRAMEWORKS } from './governance';
import { ORGS, MEMBERS, USERS, PEOPLE_MAP, APPROVER_GROUPS, approverGroupsFor, baseApproverGroupsFor, registerBaseGroups, registrySnapshot, setGroupResolver, userById, userName } from './users';
import { generateChain, summarise, rulebookAt, type AdminEvent, type ChainConfig, H, D } from './chain';
import { DEMO_ISLAND, demoIslandEpochs, demoIslandEvents, northbankCloseoutEvents } from './upgradeSeed';
import { seededKeyEpochs, seededKeyEvents } from './keysSeed';
import { SCENARIOS, RATE } from './scenarios';
import { seedPlatform, seedFreshPlatform, runEscalations, exportEvidenceBundle, type PlatformState } from './platform';
import { channelsOf, effectiveGroupOf, effectiveGroupsOf, reachPhrase, recipientChannels, recipientsOf, replayOnOf, type OrgSettings } from './orgSettings';
import { STARTER_RULES, industryById } from '@/features/onboarding/industries';
import { buildAuditorPack, ensureSandboxSeed, recordExport, type EvidenceState, type ExportOptions } from './evidence';
import { ensureBillingSeed, pilotGate, pilotReadOnlyReason } from './billing';
// one invoice builder: deriveBilling uses the chain meter /billing uses (it reads only the OrgDB it is given)
import { buildInvoices, chainMeter, type BillingContext } from '@/features/billing/chainMeter';
import { packById } from '@/lib/packs';
import { ensureDevpathSeed } from './devpath';
import { coverageOf, indexControls, liveControlsOf } from './controlMap';

export interface AuditorPackExport {
  id: string;
  ts: string;
  by: string;
  firstSeq: number;
  lastSeq: number;
  receipts: number;
  checkpoints: number;
  sizeKb: number;
  format?: string;
  profileId?: string;
  /** enforcement mode of the records in range (mock/evidence.ts enforcementOf); absent on exports saved before it */
  enforcement?: string;
  /** the bundle digest the verifier reports (manifest and receipt hashes) */
  digest?: string;
  /** how the file was written: 'zip' or 'json' */
  container?: string;
  /** one part of a split export: "2 of 3" */
  part?: string;
  /** the evidence.exported receipt */
  seq?: number;
}

export interface OrgDB {
  org: Org;
  agents: (Agent & { scenarioKey: string })[];
  rulebooks: Rulebook[];
  suggestions: RuleSuggestion[];
  connectors: Connector[];
  receipts: Receipt[];
  approvals: Approval[];
  checkpoints: Checkpoint[];
  alerts: Alert[];
  incidents: Incident[];
  aiSystems: AiSystem[];
  assessments: Assessment[];
  frameworks: Framework[];
  controls: Control[];
  webhooks: Webhook[];
  signingKeys: SigningKey[];
  keys: { key: KeyPair; from: number }[];
  keySeeds: { seed: string; kid: string; from: number }[];
  publicKeys: Record<string, string>;
  usage: UsageMonth[];
  invoices: Invoice[];
  members: Member[];
  exports: AuditorPackExport[];
  stop: { active: boolean; incidentId?: string; since?: string; by?: string; reason?: string; scope?: 'all_agents' | 'selected_agents'; agentSlugs?: string[] };
  /** Level-specific platform state (grants, packs, erasures, reviews, custody ceremonies, updates …). */
  platform: PlatformState;
  /** Settings the settings screens save (routing, replay store, approver-group edits …); see mock/orgSettings.ts. */
  orgSettings?: OrgSettings;
  /** true for an organisation created by sign-up in this browser: built empty, never from the seeded catalogue. */
  fresh?: boolean;
  /** A fresh organisation's own approver groups before edits (owners: the creator). */
  baseGroups?: ApproverGroup[];
  /** People removed from the organisation (their member record is gone): they hold no role here any more. */
  removedMembers?: string[];
  /**
   * This organisation's own tool catalogue entries (upstream and pack tools, and the tags a person confirmed),
   * keyed by tool name. They override the shared seeded catalogue for this organisation only.
   */
  toolDefs?: Record<string, ToolDef>;
  /** Integrity runs on demand and the sandbox seed flag (mock/evidence.ts). Absent in state saved before them. */
  evidence?: EvidenceState;
}

/* ── Who holds which role, from the organisation's member record ── */

/**
 * The role a person holds in an organisation now. The member record decides: an active member has its role; an
 * invited or suspended member, or a removed one, has none. Only when there is no member record and the person
 * was never removed does the directory entry count (people who joined an organisation created in this browser
 * by invitation have no member record of their own). Every permission check, in the console and the API, reads this.
 */
export function memberRole(orgId: string, userId?: string): Role | undefined {
  if (!userId || userId === 'system') return undefined;
  const d = getDB(orgId);
  const m = d.members.find((x) => x.userId === userId);
  if (m) return m.status === 'active' ? m.role : undefined;
  if (d.removedMembers?.includes(userId)) return undefined;
  const u = userById(userId);
  return u && u.orgIds.includes(orgId) ? u.role : undefined;
}

/** The tool catalogue as this organisation sees it: the shared catalogue with this organisation's own entries over it. */
export function orgToolDefs(orgId: string): ToolDef[] {
  const d = getDB(orgId);
  const out = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));
  for (const c of d.connectors) for (const t of c.tools) if (!out.has(t.name)) out.set(t.name, { name: t.name, description: t.description, tags: t.tags.length ? t.tags : (t.suggestedTags ?? []), connector: c.id });
  for (const t of Object.values(d.toolDefs ?? {})) out.set(t.name, t);
  return Array.from(out.values());
}

/** The organisation the console has open: the rule evaluator reads its tool tags when a caller passes none. */
let activeOrgId: string | undefined;
export function setActiveOrg(orgId: string | undefined) {
  activeOrgId = orgId;
}
/** The organisation the console has open (the server sets it to the operation's organisation). */
export function activeOrg(): string | undefined {
  return activeOrgId;
}
setToolTagResolver((tool) => {
  const d = activeOrgId ? dbs.get(activeOrgId) : undefined;
  return d ? toolTagsIn(d, tool) : undefined;
});

/** The risk tags of a tool in this organisation (its own catalogue entry, then its connector, then the shared catalogue). */
export function toolTagsIn(d: OrgDB, tool: string): RiskTag[] | undefined {
  const own = d.toolDefs?.[tool];
  if (own) return own.tags;
  const ct = d.connectors.flatMap((c) => c.tools).find((t) => t.name === tool);
  if (ct?.tags.length) return ct.tags;
  return TOOLS.find((t) => t.name === tool)?.tags;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const NOW0 = Math.floor(Date.now() / 60_000) * 60_000;
const ist = (daysBack: number, hh: number, mm = 0) => {
  const d = new Date(NOW0 - daysBack * D + 5.5 * H);
  d.setUTCHours(hh, mm, 0, 0);
  return d.getTime() - 5.5 * H;
};

/* ── Persisted organisation levels (so the switcher shows an upgrade before the org is opened) ── */

const LEVELS_KEY = 'eg:levels:v1';
/** The four seeded organisations: their level history is relative to now and is rebuilt with every fresh chain. */
const SEEDED_ORG_IDS = ['org_demo', 'org_northbank', 'org_kaveri', 'org_deccan'];

/**
 * Restore levels saved in this browser. A seeded organisation keeps its seeded (relative) history; only upgrades
 * made in this browser, beyond the seed, are taken from the saved entry, so the level boundary stays where the
 * regenerated chain puts it.
 */
function applySavedLevels() {
  try {
    const raw = localStorage.getItem(LEVELS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, Pick<Org, 'plan' | 'levelHistory' | 'deployment' | 'residency'>>;
    for (const o of ORGS) {
      const s = saved[o.id];
      if (!s) continue;
      if (!SEEDED_ORG_IDS.includes(o.id)) { Object.assign(o, s); continue; }
      const seedHist = o.levelHistory ?? [];
      const savedHist = s.levelHistory ?? [];
      if (savedHist.length <= seedHist.length) continue; // nothing beyond the seed: keep the relative seed
      Object.assign(o, { plan: s.plan, deployment: s.deployment, residency: s.residency, levelHistory: [...seedHist, ...savedHist.slice(seedHist.length)] });
    }
  } catch { /* fine */ }
}
applySavedLevels();

/** Keep the shared ORGS list (used by the organisation switcher) in step with an organisation's level (memory only). */
export function syncOrgMeta(org: Org) {
  const o = ORGS.find((x) => x.id === org.id);
  if (o) Object.assign(o, { plan: org.plan, levelHistory: org.levelHistory, deployment: org.deployment, residency: org.residency, keyFingerprint: org.keyFingerprint });
}

/**
 * Save an organisation's level in this browser, so the switcher shows it before the organisation is opened.
 * Called when the level changes (an upgrade), and for organisations created by sign-up whose dates are absolute.
 */
export function persistLevels(org: Org) {
  try {
    const raw = localStorage.getItem(LEVELS_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    saved[org.id] = { plan: org.plan, levelHistory: org.levelHistory, deployment: org.deployment, residency: org.residency };
    localStorage.setItem(LEVELS_KEY, JSON.stringify(saved));
  } catch { /* fine */ }
}

/* ── Organisation flavour: the seeded catalogue renamed for each organisation ── */

interface Flavour {
  orgId: string;
  slugMap: Record<string, string>;
  names: Record<string, string>;
  text: [RegExp, string][];
}

const SLUGS: Record<string, Record<string, string>> = {
  org_demo: {},
  org_northbank: { 'invoice-bot': 'ap-agent', 'collections-agent': 'receivables-agent', 'vendor-onboarding': 'supplier-onboarding', 'devops-assistant': 'plant-ops-assistant' },
  org_kaveri: { 'invoice-bot': 'supplier-payments', 'collections-agent': 'patient-billing', 'devops-assistant': 'his-ops-assistant', 'expense-auditor': 'claims-reviewer', 'hr-screening': 'staff-credentialing' },
  org_deccan: { 'invoice-bot': 'ap-processor', 'collections-agent': 'loan-collections', 'devops-assistant': 'core-banking-ops' },
};

const AGENT_NAMES: Record<string, Record<string, string>> = {
  org_northbank: { 'ap-agent': 'Accounts-payable agent', 'receivables-agent': 'Receivables agent', 'supplier-onboarding': 'Supplier onboarding', 'plant-ops-assistant': 'Plant operations assistant' },
  org_kaveri: { 'supplier-payments': 'Supplier payments agent', 'patient-billing': 'Patient billing assistant', 'his-ops-assistant': 'Hospital systems assistant', 'claims-reviewer': 'Insurance claims reviewer', 'staff-credentialing': 'Staff credentialing' },
  org_deccan: { 'ap-processor': 'Accounts-payable processor', 'loan-collections': 'Loan collections agent', 'core-banking-ops': 'Core banking operations assistant' },
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flavours = new Map<string, Flavour>();

export function flavourFor(orgId: string): Flavour {
  let f = flavours.get(orgId);
  if (f) return f;
  const org = ORGS.find((o) => o.id === orgId) ?? ORGS[0];
  const slugMap = SLUGS[orgId] ?? {};
  const text: [RegExp, string][] = [];
  if (orgId !== 'org_demo') {
    for (const [from, to] of Object.entries(PEOPLE_MAP[orgId] ?? {})) {
      text.push([new RegExp(`\\b${from}\\b`, 'g'), to]);
      text.push([new RegExp(escapeRe(userName(from)), 'g'), userName(to)]);
    }
    for (const [from, to] of Object.entries(slugMap)) text.push([new RegExp(`(?<![\\w-])${escapeRe(from)}(?![\\w-])`, 'g'), to]);
    const domain = org.domain ?? `${org.slug}.in`;
    text.push([/demotraders\.(in|eu)/g, domain], [/demotraders/g, domain.split('.')[0]], [/Demo Traders/g, org.name.replace(/ (Pvt )?Ltd$/, '')]);
  }
  f = { orgId, slugMap, names: AGENT_NAMES[orgId] ?? {}, text };
  flavours.set(orgId, f);
  return f;
}

/** Rewrite seeded text (people, agent slugs, mail domains) for an organisation. */
export function rewriteText(orgId: string, s: string): string {
  const f = flavourFor(orgId);
  let out = s;
  for (const [re, to] of f.text) out = out.replace(re, to);
  return out;
}

function remap<T>(orgId: string, x: T): T {
  if (orgId === 'org_demo') return clone(x);
  return JSON.parse(rewriteText(orgId, JSON.stringify(x)));
}

/* ── Organisation definitions ─────────────────────────────── */

interface OrgSpec {
  org: Org;
  seed: number;
  days: number;
  startSeq: number;
  volume: number;
  sparseBefore?: { at: number; factor: number };
  /** key rotations, in days ago, each starting a new key */
  keyEpochs: { daysAgo: number; kid: string; reason: string; /** key seed when not the epoch's position (`<org>:key:<n>`) */ seed?: string }[];
  firstKid: string;
}

function specs(): OrgSpec[] {
  return [
    // Demo Traders: a rolled-back L1 → L2 upgrade 16 days ago left a signed island (mock/upgradeSeed.ts); k_demo_2610 keeps its seed
    { org: clone(ORGS[0]), seed: 20261027, days: 21, startSeq: 3001, volume: 1, firstKid: 'k_demo_2606', keyEpochs: [...demoIslandEpochs(ist(DEMO_ISLAND.boundaryDay, ...DEMO_ISLAND.boundaryAt), NOW0), { daysAgo: 10, kid: 'k_demo_2610', reason: 'Scheduled rotation', seed: 'org_demo:key:2' }] },
    { org: clone(ORGS[1]), seed: 777, days: 50, startSeq: 1201, volume: 0.6, sparseBefore: { at: NOW0 - 12 * D, factor: 0.08 }, firstKid: 'k_northbank_env_1', keyEpochs: [{ daysAgo: 45, kid: 'k_northbank_kms_2', reason: 'Signing moved into AWS KMS (ap-south-1) for L2 Attested' }] },
    { org: clone(ORGS[2]), seed: 4242, days: 125, startSeq: 801, volume: 0.6, sparseBefore: { at: NOW0 - 12 * D, factor: 0.035 }, firstKid: 'k_kaveri_env_1', keyEpochs: [{ daysAgo: 120, kid: 'k_kaveri_kms_2', reason: 'Signing moved into AWS KMS (ap-south-1) for L2 Attested' }, ...seededKeyEpochs('org_kaveri'), { daysAgo: 30, kid: 'k_kaveri_hsm_3', reason: 'Key ceremony: signing moved into Kaveri’s AWS CloudHSM cluster for L3 Proven', seed: 'org_kaveri:key:3' }] },
    { org: clone(ORGS[3]), seed: 9119, days: 30, startSeq: 501, volume: 0.6, sparseBefore: { at: NOW0 - 12 * D, factor: 0.12 }, firstKid: 'k_deccan_hsm_1', keyEpochs: [{ daysAgo: 40, kid: 'k_deccan_hsm_2', reason: 'Key ceremony: scheduled rotation in the nShield HSM' }] },
  ];
}

function adminEventsFor(spec: OrgSpec, rulebooks: Rulebook[], slugOf: (s: string) => string): AdminEvent[] {
  const orgId = spec.org.id;
  const p = (id: string) => (orgId === 'org_demo' ? id : PEOPLE_MAP[orgId]?.[id] ?? id);
  const ev: AdminEvent[] = [];
  for (const rb of rulebooks) {
    for (const v of rb.versions) {
      if (v.status === 'published' && v.signedAt) {
        ev.push({ at: new Date(v.signedAt).getTime(), actor: v.signedBy ?? v.createdBy, action: 'rulebook.published', agent: rb.slug, details: { rulebook: rb.slug, version: v.version, hash: v.hash.slice(0, 16), reviewed_by: v.reviewedBy ?? '' } });
      }
    }
  }
  let prevKid = spec.firstKid;
  for (const e of spec.keyEpochs) {
    const at = NOW0 - e.daysAgo * D;
    if (e.reason.startsWith('Key ceremony')) ev.push({ at: at - 120_000, actor: p('u_ananya'), action: 'key.ceremony', details: { kind: 'rotation', quorum: '3 of 5', new_kid: e.kid } });
    ev.push({ at, actor: p('u_ananya'), action: 'key.rotated', details: { old_kid: prevKid, new_kid: e.kid, reason: e.reason } });
    prevKid = e.kid;
  }
  const hist = spec.org.levelHistory ?? [];
  for (let i = 1; i < hist.length; i++) {
    ev.push({ at: new Date(hist[i].from).getTime() - 60_000, actor: hist[i].by ?? p('u_ananya'), action: 'level.upgraded', details: { from: hist[i - 1].level, to: hist[i].level } });
    // the L1 → L2 close-out, seeded for Northbank (see mock/upgradeSeed.ts)
    if (orgId === 'org_northbank' && hist[i].level === 'l2' && hist[i - 1].level === 'l1') ev.push(...northbankCloseoutEvents(new Date(hist[i].from).getTime(), p));
  }
  // Demo Traders' rolled-back L1 → L2 upgrade and its signed island (see mock/upgradeSeed.ts)
  const island = orgId === 'org_demo' ? spec.keyEpochs.find((e) => e.kid === DEMO_ISLAND.kmsKid) : undefined;
  if (island) ev.push(...demoIslandEvents(NOW0 - island.daysAgo * D, p));
  // seeded key history: Kaveri's closed compromise, Deccan's bound successor, Demo Traders' refused rotation (mock/keysSeed.ts)
  ev.push(...seededKeyEvents(orgId, NOW0, p));
  ev.push(
    { at: NOW0 - 12 * D, actor: p('u_fatima'), action: 'agent.created', agent: slugOf('hr-screening'), details: { route: 'sdk', owner: p('u_fatima') } },
    { at: NOW0 - 12 * D + 600_000, actor: p('u_rahul'), action: 'connector.added', details: { connector: 'Recruiting MCP', tools: 2, enabled: 0 } },
    { at: NOW0 - 3 * D, actor: p('u_fatima'), action: 'agent.paused', agent: slugOf('hr-screening'), details: { reason: 'Pending impact assessment sign-off' } },
    { at: NOW0 - 20 * H, actor: 'system', action: 'agent.paused', agent: slugOf('treasury-sweeper'), details: { reason: 'Auto-pause: amount_outlier (high)', alert: 'al_treasury' } },
    { at: ist(9, 17, 30), actor: p('u_ananya'), action: 'stop.engaged', details: { scope: 'all_agents', reason: 'Quarterly stop drill', agents_paused: 7 } },
    { at: ist(9, 17, 55), actor: p('u_ananya'), action: 'stop.lifted', details: { agents_resumed: 7, incident: 'inc_drill' } },
    { at: NOW0 - 7 * D, actor: 'u_kavita', action: 'evidence.exported', details: { format: atLeast(levelOfOrg(spec.org), 'l2') ? 'elan1.evidence.bundle.v1' : 'auditor-pack/1', receipts: 412 } },
    { at: NOW0 - 2 * D, actor: p('u_ananya'), action: 'member.invited', details: { email_domain: spec.org.domain ?? 'demotraders.in', role: 'approver' } },
    { at: NOW0 - 1 * D - 3 * H, actor: p('u_rahul'), action: 'suggestion.drafted', agent: slugOf('invoice-bot'), details: { suggestion: 'sug_1', draft_version: 8 } },
  );
  return ev;
}

function demoInjected(): ChainConfig['injected'] {
  const fmt = (n: number) => '₹' + new Intl.NumberFormat('en-IN').format(n);
  const pay = (amount: number, vendor: string, minsAgo: number, b: string) => ({
    at: NOW0 - minsAgo * 60_000, agent: 'invoice-bot', forcePending: true,
    call: {
      tool: 'zoho_books.record_payment', args: { vendor, amount, bill: b, mode: 'RTGS' }, decision: 'ask' as const, ruleId: 'pay-large', reason: 'Payments over ₹50,000 need the finance controller.',
      tags: ['moves_money' as const, 'writes_data' as const], connector: 'Zoho Books', approverGroup: 'finance', headline: `invoice-bot wants to pay ${fmt(amount)} to ${vendor}`,
      effect: `Records an RTGS payment of ${fmt(amount)} against ${b} in Zoho Books. The bank file is released in the 16:00 batch.`, triggeredBy: `amount ${fmt(amount)} is over the ₹50,000 limit`,
      amount, counterparty: vendor, approveInChat: false, expiresInH: 24,
    },
  });
  const out: NonNullable<ChainConfig['injected']> = [
    pay(240000, 'Northwind Traders', 38, 'BILL-9127'),
    pay(86500, 'Kalyani Metals', 140, 'BILL-9119'),
    pay(612000, 'Surya Packaging', 410, 'BILL-9102'),
    {
      at: NOW0 - 95 * 60_000, agent: 'vendor-onboarding', forcePending: true,
      call: { tool: 'procure.update_bank_details', args: { vendor: 'Blue Dart Logistics', ifsc: 'HDFC0004417', account_last4: '0921' }, decision: 'ask', ruleId: 'bank-change', reason: 'Bank detail changes are the most common payment fraud route; a person confirms by phone.', tags: ['writes_data', 'personal_data', 'moves_money'], connector: 'Procurement MCP', approverGroup: 'procurement', headline: 'vendor-onboarding wants to change the bank account for Blue Dart Logistics', effect: 'Replaces the bank account used for every future payment to Blue Dart Logistics. Confirm by phone with a contact you already hold.', triggeredBy: 'every bank detail change is held', counterparty: 'Blue Dart Logistics', approveInChat: false, expiresInH: 24 },
    },
    {
      at: NOW0 - 22 * 60_000, agent: 'devops-assistant', forcePending: true,
      call: { tool: 'platform.deploy', args: { service: 'billing-api', version: 'v4.12.1', environment: 'production' }, decision: 'ask', ruleId: 'deploy-prod', reason: 'Production changes are held for the on-call engineer.', tags: ['changes_production'], connector: 'Platform MCP', approverGroup: 'engineering', headline: 'devops-assistant wants to deploy billing-api v4.12.1 to production', effect: 'Rolls billing-api v4.12.1 out to production. Rollback is one command and is recorded.', triggeredBy: 'environment is production, outside the change window', approveInChat: false, expiresInH: 2 },
    },
    {
      at: NOW0 - 64 * 60_000, agent: 'invoice-bot', forcePending: true,
      call: { tool: 'gmail.send_email', args: { to: 'billing@apexglobal-trading.ae', subject: 'Re: Updated bank details for payment' }, decision: 'ask', ruleId: 'email-other', reason: 'Email to an unknown domain is checked by a person.', tags: ['sends_external'], connector: 'Gmail', approverGroup: 'finance', headline: 'invoice-bot wants to email billing@apexglobal-trading.ae', effect: 'Sends a reply from ap@demotraders.in to billing@apexglobal-trading.ae. The domain is not on the approved vendor list.', triggeredBy: 'apexglobal-trading.ae is not an approved vendor domain', counterparty: 'apexglobal-trading.ae', approveInChat: true, expiresInH: 4 },
    },
    {
      at: NOW0 - 3 * 60 * 60_000, agent: 'collections-agent', forcePending: true,
      call: { tool: 'gmail.send_email', args: { to: 'accounts@meridianfoods.in', template: 'final_notice', invoice: 'INV-2291', amount_due: 418000, days_overdue: 97 }, decision: 'ask', ruleId: 'final-notice', reason: 'A final notice is a legal step; finance sends it.', tags: ['sends_external'], connector: 'Gmail', approverGroup: 'finance', headline: 'collections-agent wants to send a final notice to Meridian Foods', effect: 'Emails the final-notice template for INV-2291 (₹4,18,000 due) to Meridian Foods. It states that the account may be referred for recovery.', triggeredBy: 'template is final_notice', amount: 418000, counterparty: 'Meridian Foods', approveInChat: true, expiresInH: 24 },
    },
  ];
  for (let i = 0; i < 4; i++) {
    const a = [1450000, 1880000, 2200000, 1975000][i];
    out.push({
      at: NOW0 - 20 * H - (4 - i) * 9 * 60_000, agent: 'treasury-sweeper',
      call: { tool: 'bank.initiate_transfer', args: { from_account: 'HDFC-OPS-0042', to_account: 'EXT-SBIN-7781', amount: a }, decision: 'ask', ruleId: 'external-transfer', reason: 'Any transfer outside our own accounts needs an owner.', tags: ['moves_money'], connector: 'Treasury bank gateway', approverGroup: 'owners', headline: `treasury-sweeper wants to transfer ${fmt(a)} to an external account`, effect: `Initiates a transfer of ${fmt(a)} from HDFC-OPS-0042 to SBIN account ending 7781, which is not one of our own accounts.`, triggeredBy: 'to_account is not in own_accounts', amount: a, approveInChat: false, expiresInH: 1, approveP: 0 },
    });
  }
  return out;
}

/* ── Build ────────────────────────────────────────────────── */

const CACHE_VERSION = 'eg:v5';

function cacheKey(orgId: string) {
  return `${CACHE_VERSION}:${orgId}:${Math.floor(NOW0 / H)}`;
}

function buildOrg(spec: OrgSpec): OrgDB {
  const orgId = spec.org.id;
  const isDemo = orgId === 'org_demo';
  const f = flavourFor(orgId);
  const slugOf = (s: string) => f.slugMap[s] ?? s;

  // keys: one per epoch
  const seeds = [`${orgId}:key:1`, ...spec.keyEpochs.map((e, i) => e.seed ?? `${orgId}:key:${i + 2}`)];
  const keys = [{ key: keyFromSeed(seeds[0], spec.firstKid), from: 0 }, ...spec.keyEpochs.map((e, i) => ({ key: keyFromSeed(seeds[i + 1], e.kid), from: NOW0 - e.daysAgo * D }))];
  const keySeeds = keys.map((k, i) => ({ seed: seeds[i], kid: k.key.kid, from: k.from }));
  const current = keys[keys.length - 1].key;
  spec.org.keyFingerprint = current.fingerprint;

  // the full catalogue, renamed for this organisation
  const agents = remap(orgId, AGENTS).map((a, i) => ({ ...a, name: f.names[a.slug] ?? a.name, scenarioKey: AGENTS[i].slug }));
  const rulebooks = remap(orgId, RULEBOOKS).map((rb) => {
    const ag = agents.find((a) => a.id === rb.agentId)!;
    return { ...rb, name: `${ag.name} rulebook`, versions: rb.versions.map((v) => ({ ...v, hash: sha256Hex(v.yaml) })) };
  });

  // an agent acts only once it exists and its rulebook has a signed version: never before either
  const bornAt = Object.fromEntries(agents.map((a) => {
    const rb = rulebooks.find((b) => b.id === a.rulebookId);
    const firstSigned = Math.min(...(rb?.versions.filter((v) => v.status === 'published' && v.signedAt).map((v) => new Date(v.signedAt!).getTime()) ?? []), Infinity);
    const created = a.slug === slugOf('hr-screening') ? NOW0 - 12 * D : new Date(a.createdAt).getTime();
    return [a.slug, Math.max(created, Number.isFinite(firstSigned) ? firstSigned : created)];
  }));
  const cfg: ChainConfig = {
    orgId, seed: spec.seed, days: spec.days, startSeq: spec.startSeq, now: NOW0, agents, rulebooks, keys,
    admin: adminEventsFor(spec, rulebooks, slugOf),
    stopWindows: [{ from: ist(9, 17, 30), to: ist(9, 17, 55), reason: 'Quarterly stop drill' }],
    pausedFrom: { [slugOf('hr-screening')]: { at: NOW0 - 3 * D, by: 'owner' }, [slugOf('treasury-sweeper')]: { at: NOW0 - 20 * H, by: 'auto-pause' } },
    createdAt: bornAt,
    injected: remap(orgId, demoInjected()), volume: spec.volume, sparseBefore: spec.sparseBefore,
    groups: baseApproverGroupsFor(orgId),
    rewrite: isDemo ? undefined : (s) => rewriteText(orgId, s),
    noChat: spec.org.deployment === 'sovereign',
  };

  // on the server the generated history continues the organisation's real chain, and is replaced by the real
  // receipts it was written as (see ChainWriter); the browser's hourly cache is not used there
  const base = chainWriter?.base(orgId);
  if (base) Object.assign(cfg, { startSeq: base.seq + 1, prevHash: base.hash });
  let chain: ReturnType<typeof generateChain> | undefined;
  if (isDemo && !chainWriter) {
    try {
      const raw = localStorage.getItem(cacheKey(orgId));
      if (raw) chain = JSON.parse(raw);
    } catch { /* storage unavailable */ }
  }
  if (!chain) {
    chain = generateChain(cfg);
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith('eg:v') && !k.startsWith(CACHE_VERSION)) localStorage.removeItem(k);
        else if (k?.startsWith(CACHE_VERSION) && k.includes(orgId)) localStorage.removeItem(k);
      }
      if (isDemo) localStorage.setItem(cacheKey(orgId), JSON.stringify(chain));
    } catch { /* quota or private mode — fine, regenerate next time */ }
  }
  if (chainWriter) chain = { ...chain, receipts: chainWriter.history(orgId, chain.receipts) };

  const since7 = NOW0 - 7 * D;
  for (const a of agents) {
    const rs = chain.receipts.filter((r) => r.agent === a.slug && r.kind === 'decision');
    const last = rs[rs.length - 1];
    a.lastCallAt = last?.ts;
    const w = rs.filter((r) => new Date(r.ts).getTime() >= since7);
    a.stats = { calls7d: w.length, allowed7d: w.filter((r) => r.decision === 'allow').length, asked7d: w.filter((r) => r.decision === 'ask').length, refused7d: w.filter((r) => r.decision === 'refuse').length };
  }

  const connectors = remap(orgId, CONNECTORS);
  for (const c of connectors) for (const t of c.tools) t.calls7d = chain.receipts.filter((r) => r.tool === t.name && r.kind === 'decision' && new Date(r.ts).getTime() >= since7).length;

  const members: Member[] = isDemo ? clone(MEMBERS) : USERS.filter((x) => x.orgIds.includes(orgId) && x.role !== 'auditor').map((x, i): Member => ({
    userId: x.id, role: x.role, status: 'active' as const, lastActiveAt: new Date(NOW0 - (i + 1) * H * (i % 3 === 0 ? 2 : 7)).toISOString(),
    // Sovereign (deny-all egress): nobody has Slack or WhatsApp linked
    slackLinked: spec.org.deployment !== 'sovereign' && (x.role === 'approver' || x.role === 'owner'), whatsappVerified: spec.org.deployment !== 'sovereign' && (x.role === 'owner' || x.id === PEOPLE_MAP[orgId]?.u_venkat),
  })).concat([{ userId: 'u_kavita', role: 'auditor', status: 'active', lastActiveAt: new Date(NOW0 - 26 * H).toISOString() }]);

  const db: OrgDB = {
    org: spec.org, agents, rulebooks, suggestions: remap(orgId, SUGGESTIONS), connectors,
    receipts: chain.receipts, approvals: chain.approvals, checkpoints: chain.checkpoints,
    alerts: [], incidents: [], aiSystems: remap(orgId, AI_SYSTEMS).map((s) => ({ ...s, name: s.linkedAgentId ? agents.find((a) => a.id === s.linkedAgentId)?.name ?? s.name : s.name })),
    assessments: remap(orgId, ASSESSMENTS),
    frameworks: clone(FRAMEWORKS).map((fw) => ({ ...fw, enabled: isDemo ? fw.enabled : fw.enabled || (spec.org.industry === 'healthcare' && fw.id === 'hipaa') })),
    controls: clone(CONTROLS), webhooks: [], signingKeys: [], keys, keySeeds, publicKeys: Object.fromEntries(keys.map((k) => [k.key.kid, k.key.publicKeyHex])),
    usage: [], invoices: [], members, exports: [], stop: { active: false },
    platform: undefined as unknown as PlatformState,
  };

  db.signingKeys = keys.map((k, i) => ({
    kid: k.key.kid, fingerprint: k.key.fingerprint, algorithm: 'Ed25519', status: i === keys.length - 1 ? 'active' : 'retired',
    createdAt: new Date(k.from || new Date(spec.org.createdAt).getTime()).toISOString(), retiredAt: i < keys.length - 1 ? new Date(keys[i + 1].from).toISOString() : undefined,
    receiptsSigned: db.receipts.filter((r) => r.kid === k.key.kid).length,
  }));

  deriveAlertsAndIncidents(db, slugOf);
  deriveControls(db);
  db.webhooks = remap(orgId, demoWebhooks());
  const level2 = atLeast(levelOfOrg(spec.org), 'l2');
  db.exports = [
    { id: 'exp_1', ts: new Date(NOW0 - 7 * D).toISOString(), by: 'u_kavita', firstSeq: db.receipts[0].seq, lastSeq: db.receipts[Math.min(411, db.receipts.length - 1)].seq, receipts: Math.min(412, db.receipts.length), checkpoints: Math.min(160, db.checkpoints.length), sizeKb: level2 ? 912 : 486, format: level2 ? 'elan1.evidence.bundle.v1' : 'auditor-pack/1' },
    { id: 'exp_2', ts: new Date(NOW0 - 30 * D).toISOString(), by: PEOPLE_MAP[orgId]?.u_ananya ?? 'u_ananya', firstSeq: spec.startSeq - 591, lastSeq: spec.startSeq - 1, receipts: 591, checkpoints: 204, sizeKb: 702, format: 'auditor-pack/1' },
  ];
  // a real chain has only its setup receipts before the generated history: the earlier export covers those
  if (base) Object.assign(db.exports[1], { firstSeq: 1, lastSeq: base.seq, receipts: base.seq, checkpoints: 0, sizeKb: 2 });
  db.platform = seedPlatform(db);
  // invoices count the seeded packs and counterparty seats, so they are built once the platform state exists
  deriveBilling(db);
  if (chainWriter) detachKeys(db);
  return db;
}

function deriveAlertsAndIncidents(db: OrgDB, s: (slug: string) => string) {
  const orgId = db.org.id;
  const seqsOf = (agent: string, pred: (r: Receipt) => boolean, n = 6) => db.receipts.filter((r) => r.agent === s(agent) && pred(r)).slice(-n).map((r) => r.seq);
  const iso = (t: number) => new Date(t).toISOString();
  const alerts: Alert[] = [
    { id: 'al_treasury', detector: 'amount_outlier', severity: 'high', agentSlug: 'treasury-sweeper', title: 'Transfers far above this agent\'s usual amounts', detail: '4 transfer requests to an external account in 36 minutes, each above ₹14 lakh. Usual transfers are internal sweeps.', baseline: 'Median ₹9.8 lakh, internal accounts only', observed: '₹14.5–22 lakh to EXT-SBIN-7781', status: 'open', createdAt: iso(NOW0 - 20 * H), autoPaused: true, relatedSeqs: seqsOf('treasury-sweeper', (r) => r.args_summary?.to_account === 'EXT-SBIN-7781', 8) },
    { id: 'al_vendor_cp', detector: 'new_counterparty', severity: 'medium', agentSlug: 'vendor-onboarding', title: 'New counterparty outside India', detail: 'vendor-onboarding tried to create Apex Global Trading FZE (United Arab Emirates). No vendor outside India exists in the master.', baseline: 'Vendors registered in India', observed: '1 vendor in AE', status: 'open', createdAt: iso(NOW0 - 2 * H), relatedSeqs: seqsOf('vendor-onboarding', (r) => r.decision === 'ask', 3) },
    { id: 'al_invoice_domain', detector: 'new_counterparty', severity: 'medium', agentSlug: 'invoice-bot', title: 'Email to a look-alike vendor domain', detail: 'invoice-bot tried to reply to apexglobal-trading.ae about "updated bank details". The thread began from an external sender.', baseline: '5 approved vendor domains', observed: 'apexglobal-trading.ae', status: 'open', createdAt: iso(NOW0 - 64 * 60_000), relatedSeqs: seqsOf('invoice-bot', (r) => r.rule_id === 'email-other', 3) },
    { id: 'al_collect_vol', detector: 'volume_spike', severity: 'medium', agentSlug: 'collections-agent', title: 'Reminder volume 3.1× the usual Monday', detail: 'collections-agent sent 96 reminders before noon. The daily cap is 120.', baseline: '31 reminders by noon', observed: '96 reminders by noon', status: 'acknowledged', acknowledgedBy: 'u_venkat', createdAt: iso(NOW0 - 3 * D), relatedSeqs: seqsOf('collections-agent', (r) => r.rule_id === 'reminders', 6) },
    { id: 'al_devops_hours', detector: 'off_hours', severity: 'low', agentSlug: 'devops-assistant', title: 'Deploy requested at 02:40 IST', detail: 'A production deploy was requested outside working hours and held for engineering.', baseline: 'Deploys 10:00–18:00 IST', observed: '02:40 IST', status: 'resolved', createdAt: iso(NOW0 - 5 * D), resolvedAt: iso(NOW0 - 5 * D + 6 * H), relatedSeqs: seqsOf('devops-assistant', (r) => r.rule_id === 'deploy-prod', 2) },
    { id: 'al_hr_tool', detector: 'new_tool', severity: 'low', agentSlug: 'hr-screening', title: 'First call to hr.send_candidate_email', detail: 'hr-screening called a tool it had not used before. The call was refused by rule no-candidate-email.', baseline: '1 tool used', observed: '2 tools', status: 'resolved', createdAt: iso(NOW0 - 8 * D), resolvedAt: iso(NOW0 - 7 * D), relatedSeqs: seqsOf('hr-screening', (r) => r.tool === 'hr.send_candidate_email', 2) },
    // open refusal surge: the start of plan journey 4 ("Something goes wrong") — investigate in Activity, then stop
    { id: 'al_vendor_refusals', detector: 'refusal_surge', severity: 'high', agentSlug: 'vendor-onboarding', title: 'Refusals at 64% of vendor-onboarding\'s calls this hour', detail: '9 of 14 calls in the last hour were refused, most of them bank-detail changes to vendors outside the master. The usual share is 6%.', baseline: '6% refused over 14 days', observed: '64% refused in the last hour', status: 'open', createdAt: iso(NOW0 - 35 * 60_000), relatedSeqs: seqsOf('vendor-onboarding', (r) => r.decision === 'refuse', 8) },
    { id: 'al_invoice_refusals', detector: 'refusal_surge', severity: 'low', agentSlug: 'invoice-bot', title: 'Refusals up on delete attempts', detail: 'invoice-bot tried to delete 3 bills in one hour. All were refused by rule no-deletes.', baseline: '0–1 refusals an hour', observed: '3 refusals', status: 'resolved', createdAt: iso(NOW0 - 11 * D), resolvedAt: iso(NOW0 - 11 * D + 2 * H), relatedSeqs: seqsOf('invoice-bot', (r) => r.rule_id === 'no-deletes', 3) },
  ];
  db.alerts = remap(orgId, alerts);
  const stopIn = db.receipts.filter((r) => r.reason?.startsWith('Emergency stop'));
  const engaged = db.receipts.find((r) => r.action === 'stop.engaged');
  const lifted = db.receipts.find((r) => r.action === 'stop.lifted');
  const paused = db.receipts.find((r) => r.action === 'agent.paused' && r.agent === s('treasury-sweeper'));
  const incidents: Incident[] = [
    {
      id: 'inc_treasury', title: 'Treasury sweeper auto-paused', kind: 'auto_pause', status: 'active', scope: 'selected_agents', agentSlugs: ['treasury-sweeper'],
      startedAt: iso(NOW0 - 20 * H), startedBy: 'system', reason: 'High-severity amount_outlier alert with auto-pause on.', refusedWhileStopped: db.receipts.filter((r) => r.agent === s('treasury-sweeper') && r.rule_id === 'agent-paused').length, pendingApprovalsAtStop: 0,
      timeline: [
        { ts: iso(NOW0 - 20 * H - 36 * 60_000), text: 'First external transfer request held for owners', seq: alerts[0].relatedSeqs[0] },
        { ts: iso(NOW0 - 20 * H), text: 'amount_outlier raised at high severity' },
        { ts: iso(NOW0 - 20 * H), text: 'Auto-pause paused treasury-sweeper', seq: paused?.seq, actor: 'system' },
        { ts: iso(NOW0 - 19 * H), text: 'Owners notified on WhatsApp and email' },
      ],
    },
    {
      id: 'inc_drill', title: 'Quarterly emergency stop drill', kind: 'emergency_stop', status: 'resolved', scope: 'all_agents', agentSlugs: db.agents.filter((a) => a.slug !== s('hr-screening')).map((a) => a.slug),
      startedAt: engaged?.ts ?? iso(ist(9, 17, 30)), startedBy: 'u_ananya', reason: 'Quarterly stop drill', resolvedAt: lifted?.ts, resolvedBy: 'u_ananya', refusedWhileStopped: stopIn.length, pendingApprovalsAtStop: 1,
      timeline: [
        { ts: engaged?.ts ?? '', text: 'Ananya Rao typed STOP. Every agent paused in one transaction.', seq: engaged?.seq, actor: 'u_ananya' },
        { ts: engaged?.ts ?? '', text: 'Banner shown on every console page and sent to Slack #ops' },
        ...stopIn.slice(0, 3).map((r) => ({ ts: r.ts, text: `${r.agent} called ${r.tool} — refused (agent-paused)`, seq: r.seq })),
        { ts: lifted?.ts ?? '', text: 'Stop lifted. Only the agents the stop paused were resumed.', seq: lifted?.seq, actor: 'u_ananya' },
        { ts: lifted?.ts ?? '', text: 'Incident report generated (PDF)' },
      ],
    },
  ];
  db.incidents = remap(orgId, incidents);
}

/**
 * Stored evidence counts and coverage, computed exactly as /compliance computes them (mock/controlMap.ts: the same
 * control list, predicates and framework mapping, level mappings included). Screens recount live from the chain.
 */
function deriveControls(db: OrgDB) {
  const live = liveControlsOf(db, db.controls);
  const byId = indexControls(live);
  for (const c of db.controls) {
    const l = byId[c.id];
    const n = l?.evidenceCount ?? 0;
    c.evidenceCount = n;
    c.lastEvidenceAt = l?.lastEvidenceAt;
    if (n === 0) c.status = 'no_evidence';
  }
  for (const fw of db.frameworks) fw.coverage = coverageOf(fw, byId).share;
}

/**
 * Usage months and invoices, built by the chain meter (features/billing/chainMeter.ts) — the same builder /billing
 * uses, so the two can never disagree. Months come from the chain's own dates in IST, from the first receipt to the
 * current month (nothing is fixed to a calendar); each month is priced at the level in force for each of its days;
 * Sovereign is the yearly deployment licence plus every action at its rate; each pack is its own line with the
 * re-install rule; a re-ordered profile is never billed twice; discounts, held periods, credit notes, the pilot and
 * sandbox calls (metered at 0) appear as the chain meter shows them. Credit notes stay on /billing; db.invoices holds
 * the monthly and deployment invoices. A held period (meter and chain disagree) is not issued, so it reads 'draft'.
 */
export function deriveBilling(db: OrgDB) {
  if (!db.receipts?.length) { db.usage = []; db.invoices = []; return; }
  const cm = chainMeter(db);
  const ctx: BillingContext = {
    packs: (db.platform?.packs ?? []).map((p) => ({ id: p.id, name: packById(p.id)?.name ?? p.id, installedAt: p.installedAt })),
    counterparties: (db.platform?.counterparties ?? []).map((c) => ({ id: c.id, name: c.name, seats: c.seats, since: c.since })),
  };
  db.usage = cm.months.map((m) => ({ month: m.month, allowed: m.allowed, approved: m.approved, refused: m.refused, expired: m.expired }));
  db.invoices = buildInvoices(db, cm, ctx)
    .filter((i) => i.kind !== 'credit_note')
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((i): Invoice => ({
      id: i.id, period: i.period, issuedAt: i.issuedAt, status: i.status === 'held' || i.status === 'credit' ? 'draft' : i.status,
      lines: i.lines.map((l) => ({ label: l.label, quantity: l.quantity, unit: l.unit, rate: l.rate, amount: l.amount, ...(l.note ? { note: l.note } : {}) })),
      subtotal: i.subtotal, gst: i.gst, total: i.total,
    }));
}

function demoWebhooks(): Webhook[] {
  const r = makeRand(5);
  const deliveries = (events: WebhookEvent[], failing: boolean) =>
    Array.from({ length: 14 }, (_, i) => {
      const fail = failing && i < 5;
      return { id: `del_${i}_${r.int(1000, 9999)}`, event: r.pick(events), ts: new Date(NOW0 - i * r.int(5, 50) * 60_000).toISOString(), status: fail ? r.pick([500, 502, 504]) : 200, attempts: fail ? r.int(2, 8) : 1, ms: r.int(40, fail ? 9000 : 420) };
    });
  return [
    { id: 'wh_siem', url: 'https://splunk-hec.demotraders.in/services/collector/event', events: ['receipt.created'], status: 'active', secretPrefix: 'whsec_4fK2', createdAt: new Date(NOW0 - 60 * D).toISOString(), deliveries: deliveries(['receipt.created'], false) },
    { id: 'wh_ops', url: 'https://ops-bridge.demotraders.in/hooks/elan1', events: ['alert.created', 'approval.pending', 'approval.resolved'], status: 'failing', secretPrefix: 'whsec_9aQe', createdAt: new Date(NOW0 - 30 * D).toISOString(), deliveries: deliveries(['alert.created', 'approval.pending', 'approval.resolved'], true) },
  ];
}

/* ── Organisations created by sign-up: built empty, from their own records ── */

/** The organisation record for an id that is not one of the 4 seeded organisations, if sign-up created it. */
function createdOrgRecord(orgId: string): (Org & { createdBy?: string }) | undefined {
  if (specs().some((s) => s.org.id === orgId)) return undefined;
  const reg = registrySnapshot().orgs?.find((o) => o.id === orgId);
  const shared = ORGS.find((o) => o.id === orgId) as (Org & { createdBy?: string }) | undefined;
  return reg || shared ? { ...(reg ?? {}), ...(shared ?? {}), createdBy: shared?.createdBy ?? reg?.createdBy } as Org & { createdBy?: string } : undefined;
}

/** The creator of a sign-up organisation: the recorded creator, or the first owner the directory lists for it. */
function creatorOf(org: Org & { createdBy?: string }): User | undefined {
  const byId = org.createdBy ? userById(org.createdBy) ?? registrySnapshot().users?.find((u) => u.id === org.createdBy) : undefined;
  if (byId) {
    if (!USERS.some((u) => u.id === byId.id)) USERS.push(byId);
    return byId;
  }
  return USERS.find((u) => u.orgIds.includes(org.id) && u.role === 'owner') ?? USERS.find((u) => u.orgIds.includes(org.id));
}

/** Approver groups for a new organisation: the same five groups, owners holding the creator, the rest empty. */
function freshGroups(ownerId?: string): ApproverGroup[] {
  return APPROVER_GROUPS.map((g) => ({ id: g.id, name: g.name, members: g.id === 'owners' && ownerId ? [ownerId] : [] }));
}

interface OnboardingRecord { completedAt?: string; completedBy?: string; industry?: IndustryPack; result?: { rulebookSlug?: string } }

/** The starter rulebook set-up drafted, as an unpublished draft on a draft agent (nothing runs until a person publishes). */
export function starterFromOnboarding(db: OrgDB, industry: IndustryPack, userId: string, at = new Date().toISOString()) {
  const slug = `starter-${industry}`;
  if (db.rulebooks.some((r) => r.slug === slug)) return undefined;
  const rules: Rule[] = JSON.parse(JSON.stringify(STARTER_RULES[industry] ?? STARTER_RULES.general ?? []));
  const groupIds = Array.from(new Set(rules.map((r) => r.approver).filter(Boolean))) as string[];
  const yaml = rulebookYaml(slug, 1, userId, rules, groupIds.length ? groupIds : ['owners']);
  const short = industryById(industry).short;
  const agent: Agent & { scenarioKey: string } = {
    id: `ag_${slug}`, slug, name: `${short} starter agent`, description: 'Placeholder agent for the starter rulebook. Connect your agent to it, or attach the rulebook to an agent you add.',
    framework: 'Custom', route: 'mcp', status: 'draft', ownerId: userId, riskLevel: 'medium', rulebookId: `rb_${slug}`, connectorIds: [], tools: [], createdAt: at, keys: [],
    stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 }, scenarioKey: '',
  };
  const groups = effectiveGroupsOf(db);
  const rb: Rulebook = {
    id: `rb_${slug}`, slug, name: `${short} starter rulebook`, agentId: agent.id, default: 'refuse',
    approverGroups: groups.filter((g) => groupIds.includes(g.id)).map((g) => ({ id: g.id, name: g.name, members: g.members })),
    currentVersion: 0, updatedAt: at,
    versions: [{ version: 1, status: 'draft', hash: sha256Hex(yaml), createdBy: userId, createdAt: at, note: `Starter rulebook from set-up (${industryById(industry).label})`, rules, yaml }],
  };
  db.agents.push(agent);
  db.rulebooks.push(rb);
  return { slug, rules, yaml, agent, rulebook: rb };
}

/**
 * A new organisation's database: empty but valid. Its own signing key (seeded from its id), a genesis receipt
 * (org.created, linking to 64 zeros) and a checkpoint over it, the creator as the only member and owner, plan
 * L1 Guarded, the five approver groups with the creator in Owners, and — if set-up already drafted one — the
 * starter rulebook. Nothing from the seeded catalogue, and nothing is written to any other organisation.
 */
function buildFreshOrg(rec: Org & { createdBy?: string }): OrgDB {
  const orgId = rec.id;
  const creator = creatorOf(rec);
  const ownerId = creator?.id ?? 'system';
  const createdAt = rec.createdAt ?? new Date().toISOString();
  const short = (rec.slug || orgId).split('-')[0].replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'org';
  const kid = `k_${short}_${createdAt.slice(2, 7).replace('-', '')}_1`;
  const seed = `${orgId}:key:1`;
  const key = keyFromSeed(seed, kid);
  const org: Org = {
    id: orgId, name: rec.name, slug: rec.slug, industry: rec.industry ?? 'general', regions: rec.regions?.length ? rec.regions : ['India'], currency: rec.currency ?? 'INR',
    timezone: rec.timezone ?? 'Asia/Kolkata', plan: 'l1', createdAt, keyFingerprint: key.fingerprint,
    levelHistory: [{ level: 'l1', from: createdAt }], deployment: 'hosted', residency: rec.deployment === 'sovereign' ? 'ap-south-1 Mumbai' : rec.residency ?? 'ap-south-1 Mumbai', domain: rec.domain,
  };
  const genesis = signReceipt({
    seq: 1, ts: createdAt, org: orgId, kind: 'admin', actor: ownerId, action: 'org.created',
    details: { organisation: org.name, plan: 'l1', owner: ownerId, source: 'signup', key: kid },
    prev_hash: GENESIS, kid,
  } as Omit<Receipt, 'hash' | 'sig'>, key);
  const checkpoint = signCheckpoint({ id: `cp_1_${orgId.slice(-4)}`, org: orgId, seq: 1, hash: genesis.hash, ts: createdAt, kid, onDemand: false }, key);
  const baseGroups = freshGroups(creator?.id);
  registerBaseGroups(orgId, baseGroups);
  const db: OrgDB = {
    org, agents: [], rulebooks: [], suggestions: [], connectors: [],
    receipts: [genesis], approvals: [], checkpoints: [checkpoint],
    alerts: [], incidents: [], aiSystems: [], assessments: [],
    frameworks: clone(FRAMEWORKS).map((fw) => ({ ...fw, enabled: false })),
    controls: clone(CONTROLS), webhooks: [],
    signingKeys: [{ kid, fingerprint: key.fingerprint, algorithm: 'Ed25519', status: 'active', createdAt, receiptsSigned: 1 }],
    keys: [{ key, from: 0 }], keySeeds: [{ seed, kid, from: 0 }], publicKeys: { [kid]: key.publicKeyHex },
    usage: [], invoices: [],
    members: creator ? [{ userId: creator.id, role: 'owner', status: 'active', lastActiveAt: new Date().toISOString(), slackLinked: false, whatsappVerified: !!creator.phone }] : [],
    exports: [], stop: { active: false },
    platform: undefined as unknown as PlatformState,
    fresh: true, baseGroups,
  };
  deriveControls(db);
  db.platform = seedFreshPlatform(db);
  // the starter rulebook, when set-up already drafted it (set-up writes it here too; this rebuilds it if the state was lost)
  const ob = registrySnapshot().onboarding?.[orgId] as OnboardingRecord | undefined;
  if (ob?.completedAt && ob.industry) starterFromOnboarding(db, ob.industry, ob.completedBy ?? ownerId, ob.completedAt);
  // on the server the genesis above is a placeholder: the real chain's own org.created replaces it (ChainWriter)
  if (chainWriter) detachKeys(db);
  return db;
}

/* ── Store with subscriptions ─────────────────────────────── */

const dbs = new Map<string, OrgDB>();
/**
 * Registries that other modules add to at load time live on this hoisted function rather than in consts: several mock
 * modules import this one in a cycle and register (subscribe, addCallGate, addRecordedCheck) before it finishes loading.
 */
function held<T>(key: string, make: () => T): T {
  const store = held as unknown as Record<string, unknown>;
  return (store[key] ??= make()) as T;
}
function listeners() { return held('listeners', () => new Set<(orgId: string, kind: string) => void>()); }
let specCache: OrgSpec[] | undefined;

// approver groups as they are now (saved edits applied) for every organisation already open
setGroupResolver((orgId) => {
  const d = dbs.get(orgId);
  return d ? effectiveGroupsOf(d) : undefined;
});

/*
 * Persistence: the whole organisation (decisions, approvals, publishes, stops, platform state) is kept in
 * this browser so work survives a reload. Signing keys are never stored — they are rebuilt from their seeds.
 * State older than 12 hours is discarded so the demo always shows a fresh last 24 hours.
 */
const STATE_PREFIX = 'eg:state:v3:';
/** v2 state predates the 28 Oct 2026 decisions (direct autonomy grants, A4): only sign-up organisations carry over. */
const LEGACY_STATE_PREFIX = 'eg:state:v2:';
const STATE_MAX_AGE = 12 * H;
const saveTimers = new Map<string, number>();

/** An organisation as it is saved: everything but the signing keys, which are rebuilt from their seeds. */
export type SavedDoc = Omit<OrgDB, 'keys'> & { savedAt?: number; builtAt?: number };

/**
 * Where organisation documents live when not in this browser's storage. The server sets one: `load` hands back
 * the organisation's last durable document (or nothing, to build it from the seed) and `save` is told, at once and
 * with no timer, each time the organisation changed. The document `save` receives shares its objects with the
 * live organisation, so serialise it before anything changes it again.
 */
export interface Persistence {
  load(orgId: string): SavedDoc | undefined;
  save(orgId: string, doc: SavedDoc): void;
}
let persistence: Persistence | undefined;

/** Keep organisation documents somewhere other than localStorage (the server's store); undefined goes back to it. */
export function setPersistence(p: Persistence | undefined) {
  persistence = p;
}

/** The organisation as saveState writes it (without its keys), or undefined when it is not open. */
export function exportDoc(orgId: string): SavedDoc | undefined {
  const d = dbs.get(orgId);
  if (!d) return undefined;
  return { ...withoutKeys(d), savedAt: Date.now() };
}

/** The organisation without its signing keys (copied, so the keys of a server document are never read). */
function withoutKeys(d: OrgDB): Omit<OrgDB, 'keys'> {
  const rest: Partial<OrgDB> = { ...d };
  delete rest.keys;
  return rest as Omit<OrgDB, 'keys'>;
}

/** Replace the open organisation with a saved document (another process changed it, or an operation failed). */
export function importDoc(orgId: string, doc: SavedDoc) {
  const d = restore(orgId, doc as OrgDB & { savedAt: number; builtAt: number });
  if (!d) throw new Error(`The saved document for ${orgId} is not a complete organisation.`);
  if (d.org.id !== orgId) throw new Error(`The saved document for ${orgId} belongs to ${d.org.id}.`);
  dbs.set(orgId, d);
  syncOrgMeta(d.org);
}

/** Forget the open organisation, so the next getDB loads it again. */
export function dropFromMemory(orgId: string) {
  dbs.delete(orgId);
  deferredOpen.delete(orgId);
}

function loadState(orgId: string): OrgDB | undefined {
  try {
    if (persistence) {
      const doc = persistence.load(orgId);
      return doc ? restore(orgId, doc as OrgDB & { savedAt: number; builtAt: number }) : undefined;
    }
    let raw = localStorage.getItem(STATE_PREFIX + orgId);
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_STATE_PREFIX + orgId);
      localStorage.removeItem(LEGACY_STATE_PREFIX + orgId);
      if (legacy && (JSON.parse(legacy) as { fresh?: boolean }).fresh) raw = legacy;
    }
    if (!raw) return undefined;
    return restore(orgId, JSON.parse(raw) as OrgDB & { savedAt: number; builtAt: number });
  } catch {
    return undefined;
  }
}

/** A saved document made live: keys rebuilt from their seeds, older saved shapes brought up to date. */
function restore(orgId: string, saved: OrgDB & { savedAt: number; builtAt: number }): OrgDB | undefined {
  // a sign-up organisation's records are its own work, never regenerated: no age limit for them; nor for the
  // server's documents, which are durable (the age limit keeps a browser demo showing a fresh last 24 hours)
  if (!saved.builtAt || (!saved.fresh && !persistence && Date.now() - saved.builtAt > STATE_MAX_AGE) || (!saved.keySeeds?.length && !chainWriter) || !saved.platform) return undefined;
  if (chainWriter) detachKeys(saved);
  else saved.keys = saved.keySeeds.map((s) => ({ key: keyFromSeed(s.seed, s.kid), from: s.from }));
  if (saved.fresh && saved.baseGroups) registerBaseGroups(orgId, saved.baseGroups);
  redactLegacyErased(saved);
  // keys saved before 28 Oct 2026 carry the old eg_ prefixes; agent keys are gk_ (production) and sk_sbx_ (sandbox)
  for (const a of saved.agents ?? []) for (const k of a.keys ?? []) if (k.prefix.startsWith('eg_')) k.prefix = (k.environment === 'sandbox' ? 'sk_sbx_' : 'gk_') + k.prefix.replace(/^eg_(live_|test_)?/, '');
  // demo state saved before 29 Oct 2026: the Finance and Procurement agents were owned by their own group's approver,
  // which the same-person rule (from L2) left unable to decide that group's calls; the admin owns them now (mock/catalog.ts)
  if (!saved.fresh) {
    const who = (id: string) => PEOPLE_MAP[orgId]?.[id] ?? id;
    const slugOf = (slug: string) => (orgId === 'org_demo' ? slug : rewriteText(orgId, slug));
    const moved: Record<string, string> = { [slugOf('invoice-bot')]: who('u_venkat'), [slugOf('collections-agent')]: who('u_venkat'), [slugOf('vendor-onboarding')]: who('u_arjun') };
    for (const a of saved.agents ?? []) if (moved[a.slug] && a.ownerId === moved[a.slug]) a.ownerId = who('u_rahul');
  }
  return saved;
}

function saveState(orgId: string) {
  if (persistence) {
    const doc = exportDoc(orgId);
    if (doc) persistence.save(orgId, doc);
    return;
  }
  window.clearTimeout(saveTimers.get(orgId));
  saveTimers.set(orgId, window.setTimeout(() => {
    const d = dbs.get(orgId);
    if (!d) return;
    try {
      localStorage.setItem(STATE_PREFIX + orgId, JSON.stringify({ ...withoutKeys(d), savedAt: Date.now() }));
    } catch { /* storage full or unavailable — the session keeps working in memory */ }
  }, 400));
}

/** Read-only opens in progress, and organisations opened read-only whose open-time writes still wait (readOnlyOpen). */
let quietOpen = 0;
const deferredOpen = new Set<string>();

/**
 * The organisation's database, built on first use. An organisation created by sign-up gets its own empty
 * database (see buildFreshOrg); only an id nobody knows falls back to Demo Traders.
 */
export function getDB(orgId: string): OrgDB {
  let db = dbs.get(orgId);
  // opened read-only earlier (the public verifier): the open-time writes run now that the console opens it
  if (db && !quietOpen && deferredOpen.delete(orgId)) announceOpen(orgId);
  if (!db) {
    const created = createdOrgRecord(orgId);
    if (created) {
      db = loadState(orgId);
      if (!db) {
        db = buildFreshOrg(created);
        (db as OrgDB & { builtAt: number }).builtAt = Date.now();
        dbs.set(orgId, db);
        saveState(orgId);
      }
      dbs.set(orgId, db);
      syncOrgMeta(db.org);
      persistLevels(db.org); // a sign-up organisation's dates are absolute: safe to keep
      announceOpen(orgId);
      return db;
    }
    specCache ??= specs();
    const spec = specCache.find((s) => s.org.id === orgId) ?? specCache[0];
    db = dbs.get(spec.org.id) ?? loadState(spec.org.id);
    if (!db) {
      db = buildOrg(spec);
      (db as OrgDB & { builtAt: number }).builtAt = NOW0;
    }
    dbs.set(spec.org.id, db);
    // memory only: a seeded organisation's relative level dates are never written back as absolute ones
    syncOrgMeta(db.org);
    announceOpen(spec.org.id);
  }
  return db;
}

/**
 * Tell subscribers, after the current call returns, that an organisation's database was opened (built or loaded),
 * so state derived from it (the signed-in person's role) catches up. Never during a render.
 */
function announceOpen(orgId: string) {
  if (quietOpen) {
    // read-only open: nothing is written to the organisation's chain (no expiry, sandbox seed or hourly checkpoint)
    deferredOpen.add(orgId);
    setTimeout(() => listeners().forEach((l) => l(orgId, 'open')), 0);
    return;
  }
  setTimeout(() => {
    const d = dbs.get(orgId);
    if (d) {
      expireApprovals(d); // expiry runs for every organisation, not only the one with the live tick
      ensureSandboxSeed(d); // a few calls made with the demo agent's sandbox key (once per organisation)
      try { ensureDevpathSeed(d); } catch { /* the path-to-production seed (mock/devpath.ts) never blocks opening */ }
      try { ensureBillingSeed(d); } catch { /* commercial terms seed (mock/billing.ts) never blocks opening */ }
      ensureHourlyCheckpoint(d);
    }
    listeners().forEach((l) => l(orgId, 'open'));
  }, 0);
}

/**
 * Run `fn` with organisations opened read-only: an organisation built or loaded inside it is announced, but the
 * open-time writes (approval expiry, sandbox seed, hourly checkpoint) wait until something else opens it. The public
 * verifier builds its samples this way, so building one writes nothing to that organisation's chain.
 */
export function readOnlyOpen<T>(fn: () => T): T {
  quietOpen++;
  try { return fn(); } finally { quietOpen--; }
}

/** The database only if it is already built (no build). */
export function peekDB(orgId: string): OrgDB | undefined {
  return dbs.get(orgId);
}

/** Every organisation id in the demo. */
export function orgIds(): string[] {
  return ORGS.map((o) => o.id);
}

/** Clear every saved demo organisation and start again from the seeded data. */
/** true for an organisation created by sign-up (built empty, with its own chain). */
export function isFresh(orgId: string): boolean {
  return !!(dbs.get(orgId)?.fresh ?? createdOrgRecord(orgId));
}

/** Work other modules do when the demo is reset (sign-in locks, used codes, changed demo passwords). */
function resetHooks() { return held('resetHooks', () => new Set<() => void>()); }
export function onResetDemo(fn: () => void) {
  resetHooks().add(fn);
  return () => { resetHooks().delete(fn); };
}

export function resetDemo() {
  resetHooks().forEach((h) => { try { h(); } catch { /* a hook never blocks the reset */ } });
  try {
    // Organisation data, the level ladder, per-org export counters and dismissed checklists; plus keys older
    // builds kept outside the organisation state (settings, sessions, WhatsApp codes) that nothing reads now.
    const RESET_PREFIXES = ['eg:state:', 'eg:v', 'eg:evidence:', 'eg:today:', 'eg:data:', 'eg:notify:', 'eg:sso:', 'eg:sessions:', 'eg:wa:'];
    Object.keys(localStorage).filter((k) => k === LEVELS_KEY || RESET_PREFIXES.some((p) => k.startsWith(p))).forEach((k) => localStorage.removeItem(k));
  } catch { /* fine */ }
  location.reload();
}

export function subscribe(fn: (orgId: string, kind: string) => void) {
  listeners().add(fn);
  return () => listeners().delete(fn);
}

function emit(orgId: string, kind: string) {
  saveState(orgId);
  listeners().forEach((l) => l(orgId, kind));
}

/* ── The real chain (server) ──────────────────────────────── */

/**
 * On the server every receipt is written by the organisation's real chain: Elan1 Govern holds the signing key, and
 * nothing here signs. The server sets a writer. `append` then records each receipt as provisional (the next seq, a
 * pending hash and signature) and hands it to the writer; before the server saves anything it writes the operation's
 * receipts to the real chain in one call and puts the real receipts in their place (their seqs are the same: the
 * document's head is the real head when the operation starts, and the chain lock refuses the write if it moved). On
 * demand checkpoints are the real chain's too, and its hourly job signs the rest. A seeded organisation's generated
 * history continues the real chain (`base`) and is replaced by the real receipts it was written as (`history`).
 * The documents hold no signing keys: anything that would sign with the organisation's key here fails with NO_KEY.
 * In the browser (the demo) no writer is set and everything runs as it always has.
 */
export interface ChainWriter {
  /** The real chain head a seeded organisation's generated history continues (its first seq is one after it). */
  base(orgId: string): { seq: number; hash: string };
  /** The receipts of the real chain the generated history was written as, seq for seq. */
  history(orgId: string, generated: Receipt[]): Receipt[];
  /** A receipt an operation appended, provisional until the server writes it. */
  receipt(orgId: string, r: Receipt): void;
  /** A checkpoint an operation asked for, provisional until the real chain signs one. */
  checkpoint(orgId: string, cp: Checkpoint): void;
}
let chainWriter: ChainWriter | undefined;
/**
 * What a provisional receipt's hash and signature (and a provisional checkpoint's) start with until the real
 * chain's replace them: `pending:<seq>:<nonce>`, `pending:sig:<seq>:<nonce>`. The server's nonce makes them unique.
 */
export const PENDING = 'pending:';
let pendingNonce = '0';

/** Write receipts to a real chain through `w` (the server); undefined signs them here, as the demo does. */
export function setChainWriter(w: ChainWriter | undefined, nonce = String(Date.now())) {
  chainWriter = w;
  pendingNonce = nonce;
}

export const NO_KEY = 'This action signs with the organisation’s own key, which only Elan1 Govern holds, and it is not connected to Elan1 Govern yet.';

/** A server document holds no signing keys: reading them fails with NO_KEY (never enumerable, so never saved). */
function detachKeys(d: OrgDB | SavedDoc) {
  delete (d as Partial<OrgDB>).keySeeds;
  for (const name of ['keys', 'keySeeds']) Object.defineProperty(d, name, { get() { throw new Error(NO_KEY); }, enumerable: false, configurable: true });
}

/** The key id a provisional receipt names: the real chain's active key (the server keeps signingKeys from it). */
function activeKid(db: OrgDB, prev: Receipt) {
  return db.signingKeys.find((k) => k.status === 'active')?.kid ?? prev.kid;
}

/* ── Appending receipts ───────────────────────────────────── */

export function append(db: OrgDB, body: Omit<Receipt, 'seq' | 'prev_hash' | 'kid' | 'hash' | 'sig' | 'org' | 'ts'> & { ts?: string }): Receipt {
  // after a pilot's hard stop the organisation is read-only for 30 days, then closed (mock/billing.ts)
  const readOnly = pilotReadOnlyReason(db, body);
  if (readOnly) throw new Error(readOnly);
  const prev = db.receipts[db.receipts.length - 1];
  if (chainWriter) {
    // the server writes it to the organisation's real chain before saving, and puts the real receipt in its place
    const kid = activeKid(db, prev);
    const seq = prev.seq + 1;
    const r = { ts: new Date().toISOString(), ...body, seq, org: db.org.id, prev_hash: prev.hash, kid, hash: `${PENDING}${seq}:${pendingNonce}`, sig: `${PENDING}sig:${seq}:${pendingNonce}` } as Receipt;
    db.receipts.push(r);
    const sk = db.signingKeys.find((k) => k.kid === kid);
    if (sk) sk.receiptsSigned++;
    chainWriter.receipt(db.org.id, r);
    emit(db.org.id, 'receipt');
    return r;
  }
  const key = db.keys[db.keys.length - 1].key;
  const r = signReceipt({ ts: new Date().toISOString(), ...body, seq: prev.seq + 1, org: db.org.id, prev_hash: prev.hash, kid: key.kid } as Omit<Receipt, 'hash' | 'sig'>, key);
  db.receipts.push(r);
  const sk = db.signingKeys.find((k) => k.kid === key.kid);
  if (sk) sk.receiptsSigned++;
  emit(db.org.id, 'receipt');
  return r;
}

export function signCheckpointNow(db: OrgDB, onDemand = true): Checkpoint {
  const head = db.receipts[db.receipts.length - 1];
  if (chainWriter) {
    // the real chain signs it (after the operation's receipts are written); this one stands in until then
    const cp: Checkpoint = { id: `cp_${PENDING}${head.seq}`, org: db.org.id, seq: head.seq, hash: head.hash, ts: new Date().toISOString(), kid: activeKid(db, head), sig: `${PENDING}checkpoint:${head.seq}:${pendingNonce}`, onDemand };
    db.checkpoints.push(cp);
    chainWriter.checkpoint(db.org.id, cp);
    emit(db.org.id, 'checkpoint');
    return cp;
  }
  const key = db.keys[db.keys.length - 1].key;
  const cp = signCheckpoint({ id: `cp_${head.seq}_${Date.now() % 1000}`, org: db.org.id, seq: head.seq, hash: head.hash, ts: new Date().toISOString(), kid: key.kid, onDemand }, key);
  db.checkpoints.push(cp);
  emit(db.org.id, 'checkpoint');
  return cp;
}

/** The hourly checkpoint: sign the chain head when an hour has passed since the last checkpoint and the head moved. */
export function ensureHourlyCheckpoint(db: OrgDB): Checkpoint | undefined {
  // on the server the real chain's hourly job signs them (apps/gate jobs: checkpoints-hourly)
  if (chainWriter) return undefined;
  const head = db.receipts[db.receipts.length - 1];
  if (!head) return undefined;
  const lastCp = db.checkpoints[db.checkpoints.length - 1];
  if (lastCp && lastCp.seq === head.seq) return undefined; // the chain has not moved
  if (lastCp && Date.now() - new Date(lastCp.ts).getTime() < H) return undefined;
  return signCheckpointNow(db, false);
}

/* ── Live traffic ─────────────────────────────────────────── */

let liveTimer: number | undefined;
const liveRand = makeRand(Date.now() % 100000);

export function startLive(orgId: string, everyMs = 9000) {
  stopLive();
  const tick = () => {
    const db = getDB(orgId);
    runEscalations(db);
    expireApprovals(db);
    const active = db.agents.filter((a) => a.status === 'active' && SCENARIOS[a.scenarioKey]);
    if (active.length) {
      const agent = liveRand.weighted(active.map((a) => [a, RATE[a.scenarioKey] ?? 0.3] as const));
      const scen = SCENARIOS[agent.scenarioKey];
      const call = liveRand.weighted(scen.map((s) => [s, s.weight] as const)).make(liveRand, agent.slug);
      governCall(db, agent, call);
    }
    ensureHourlyCheckpoint(db);
    liveTimer = window.setTimeout(tick, everyMs * (0.6 + liveRand.next() * 0.9));
  };
  liveTimer = window.setTimeout(tick, 2500);
}

export function stopLive() {
  if (liveTimer) window.clearTimeout(liveTimer);
  liveTimer = undefined;
}

/** A rule's expires_in ('30m', '4h', '2d') in hours. */
function expiryHours(spec: string): number | undefined {
  const m = /^(\d+)\s*(m|h|d)$/.exec(spec.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 'm' ? n / 60 : m[2] === 'h' ? n : n * 24;
}

/**
 * Run one call through the guard (stop → identity → rulebook → autonomy → decide) and record it.
 * The decision is the published rulebook's (strictest matching rule; quotas counted against this agent's
 * receipts in the window); a tool switched off on its connector is refused. The scenario supplies only the call
 * and its wording.
 * From L3 Proven the agent's autonomy grant for the tool is applied after the rulebook
 * (see lib/autonomy.ts): A0 refuses writes, A1/A2 hold allowed writes for a person, A3 leaves the
 * rulebook's decision unchanged, A4 runs held calls inside the granted bound, A5 runs held calls.
 * A refusal is never relaxed.
 */
/** A guard check asked before anything else on every call; returning a refusal stops the call (and it is not appended). */
export type CallGate = (db: OrgDB, agentSlug: string, tool: string) => Receipt | undefined;
function callGates() { return held('callGates', (): CallGate[] => []); }
export function addCallGate(gate: CallGate) {
  if (!callGates().includes(gate)) callGates().push(gate);
}

/**
 * A check that runs after the rulebook on a live call and is recorded on the call's receipt (mock/records.ts: G1,
 * the DPDP consent check). It returns nothing to stay silent, details to add to the receipt, a refusal, or a hold.
 * `call.decision` is the decision so far (the rulebook's, after a switched-off tool). A hold only tightens: it turns an
 * allow into an ask for a named person (approver group `approver`, else the rule's); it never relaxes an ask.
 */
export type RecordedCheck = (db: OrgDB, agent: Agent, call: { tool: string; args: Record<string, unknown>; tags: string[]; decision?: 'allow' | 'ask' }) =>
  { refuse?: { ruleId: string; reason: string }; hold?: { ruleId: string; reason: string; approver?: string }; details?: Record<string, string | number>; personRequired?: boolean } | undefined;
function recordedChecks() { return held('recordedChecks', () => new Map<string, RecordedCheck>()); }
/** Register (or replace, by name) a recorded check. */
export function addRecordedCheck(name: string, check: RecordedCheck) {
  recordedChecks().set(name, check);
}

export function governCall(db: OrgDB, agent: Agent, rawCall: import('./scenarios').Call, opts?: { environment?: 'sandbox' }) {
  const orgId = db.org.id;
  // pilot hard stop (mock/billing.ts): POLICY.TENANT_STOPPED, the one refusal with no record
  const tenantStopped = pilotGate(db, opts?.environment);
  if (tenantStopped) return tenantStopped;
  // guard checks registered by other modules (mock/ops.ts: the receipt writer is failed); a refusal here is not appended
  for (const gate of callGates()) { const refused = gate(db, agent.slug, rawCall.tool); if (refused) return refused; }
  const rw = (s: string) => (orgId === 'org_demo' ? s : rewriteText(orgId, s));
  const call = orgId === 'org_demo' ? rawCall : { ...rawCall, args: JSON.parse(rw(JSON.stringify(rawCall.args))) as typeof rawCall.args };
  const rb = rulebookAt(db.rulebooks.find((b) => b.id === agent.rulebookId), Date.now());
  const advisory = agent.route !== 'mcp';
  const mode = advisory ? 'check_and_record' : 'governed_run';
  const base = {
    kind: 'decision' as const, agent: agent.slug, tool: call.tool, args_summary: summarise(call.args), args_hash: sha256Hex(canonical({ tool: call.tool, args: call.args })),
    rulebook: rb ? { version: rb.version, hash: rb.hash } : undefined,
    // a call made with a sandbox key (sk_sbx_) is marked on its receipt, inside the signed body
    ...(opts?.environment === 'sandbox' ? { environment: 'sandbox' as const } : {}),
  };
  // stop: a selective stop covers only the agents it named; a paused agent is refused on its own
  const stopped = stopCovers(db, { agentSlug: agent.slug });
  if (stopped || agent.status !== 'active') {
    return appendBeforeRun(db, { ...base, rule_id: 'agent-paused', decision: 'refuse', reason: stopped ? `Emergency stop engaged: ${db.stop.reason}` : 'Agent paused.', outcome: { status: 'not_run' }, details: { route: agent.route, mode } });
  }
  const tags = toolTagsIn(db, call.tool) ?? call.tags;
  // rulebook: the published version in force decides; with none, every call is refused
  if (!rb) {
    return appendBeforeRun(db, { ...base, rule_id: 'no-rulebook', decision: 'refuse', reason: 'No published rulebook version. Every call is refused until a version is published.', outcome: { status: 'not_run' }, details: { route: agent.route, mode } });
  }
  const since = Date.now() - 8 * D;
  const history = db.receipts.filter((r) => r.agent === agent.slug && r.kind === 'decision' && new Date(r.ts).getTime() >= since);
  // rules marked simulate (a pack's locked section added at L1 is a dry run) never decide; what they would have
  // decided, when stricter, is noted on the receipt
  const live = rb.rules.filter((x) => x.mode !== 'simulate');
  const ev = evaluate(live, call.tool, call.args, tags, { history });
  const rule = live.find((x) => x.id === ev.ruleId);
  let decision = ev.decision;
  let ruleId = ev.ruleId;
  let reason = ev.reason;
  const auto: Record<string, string | number | boolean> = {};
  if (live.length < rb.rules.length) {
    const sim = evaluate(rb.rules.filter((x) => x.mode === 'simulate'), call.tool, call.args, tags, { includeSimulate: true });
    const rank = { allow: 0, ask: 1, refuse: 2 } as const;
    if (sim.ruleId !== 'default' && rank[sim.decision] > rank[ev.decision]) { auto.dry_run_rule = sim.ruleId; auto.dry_run_decision = sim.decision; }
  }
  if (ev.quota) { auto.quota = `${ev.quota.kind}:${ev.quota.used}/${ev.quota.limit} per ${ev.quota.window}`; auto.rulebook_decision = 'allow'; auto.quota_decision = ev.decision; }
  // a tool switched off on its connector is refused, whatever the rulebook allows
  const tool = db.connectors.flatMap((c) => c.tools).find((t) => t.name === call.tool);
  if (decision !== 'refuse' && tool && !tool.enabled) {
    auto.rulebook_decision = auto.rulebook_decision ?? decision;
    decision = 'refuse';
    ruleId = 'tool-disabled';
    reason = `${call.tool} is switched off on its connector. Unknown and switched-off tools are refused.`;
  }
  // recorded checks registered by other modules (mock/records.ts: G1, the DPDP consent check). A refusal only
  // tightens and goes on the receipt; a pass may add details (the consent relied on). Sandbox calls write to nobody.
  let checkHold: { approver?: string; reason: string } | undefined;
  let personRequired = false;
  if (decision !== 'refuse' && opts?.environment !== 'sandbox') {
    for (const check of recordedChecks().values()) {
      const hit = check(db, agent, { tool: call.tool, args: call.args as Record<string, unknown>, tags, decision: decision as 'allow' | 'ask' });
      if (!hit) continue;
      Object.assign(auto, hit.details ?? {});
      if (hit.refuse) { auto.rulebook_decision = auto.rulebook_decision ?? decision; decision = 'refuse'; ruleId = hit.refuse.ruleId; reason = hit.refuse.reason; break; }
      // a hold turns an allow into an ask for a named person (a regulatory pack's dual control, mock/packChecks.ts)
      if (hit.hold && decision === 'allow') { auto.rulebook_decision = auto.rulebook_decision ?? decision; decision = 'ask'; ruleId = hit.hold.ruleId; reason = hit.hold.reason; checkHold = { approver: hit.hold.approver, reason: hit.hold.reason }; }
      // a rulebook hold that already meets a pack's "a named person decides" requirement: marked so no autonomy grant releases it
      if (hit.personRequired && decision === 'ask') { personRequired = true; auto.pack_hold_required = true; }
    }
  }
  // earned autonomy (L3 and Sovereign)
  if (decision !== 'refuse' && atLeast(levelOfOrg(db.org), 'l3')) {
    const grant = grantFor(db.platform.grants, agent.slug, call.tool);
    const eff = applyAutonomy(decision, grant, { tool: call.tool, tags, args: call.args });
    auto.autonomy = eff.level;
    if (!eff.hasGrant) auto.autonomy_grant = 'none';
    // a used-up quota or a recorded check's hold only tightens: autonomy never runs a call either of them held, nor a
    // rulebook hold that meets a pack's "a named person decides" requirement (at any level, A4 and A5 included)
    if (eff.changed && eff.decision === 'allow' && personRequired) auto.autonomy_not_applied = 'pack_hold_required';
    if (eff.changed && !((ev.quota || checkHold || personRequired) && eff.decision === 'allow')) { auto.rulebook_decision = auto.rulebook_decision ?? decision; decision = eff.decision; ruleId = eff.ruleId ?? ruleId; reason = eff.reason ?? reason; }
  }
  // the approver group and the expiry come from the rule that held the call; the scenario only names it
  const approverGroup = checkHold?.approver ?? rule?.approver ?? call.approverGroup;
  const expiresInH = rule?.expiresIn ? expiryHours(rule.expiresIn) : call.expiresInH;
  if (decision !== 'ask') {
    const details = { route: agent.route, mode, ...(tags.length ? { tags: tags.join(',') } : {}), ...auto };
    // a governed run that is allowed runs the call first, then writes its receipt
    if (decision === 'allow' && !advisory) {
      return appendAfterRun(db, { ...base, rule_id: ruleId, decision, reason, outcome: { status: 'ok', ref: `${call.connector.split(' ')[0].toLowerCase()}:${liveRand.int(100000, 999999)}`, ms: liveRand.int(90, 1200) }, details });
    }
    return appendBeforeRun(db, { ...base, rule_id: ruleId, decision, reason, outcome: decision === 'allow' ? undefined : { status: 'not_run' }, details });
  }
  const id = `apr_live${Date.now().toString(36)}`;
  const groups = effectiveGroupsOf(db);
  const group = groups.find((g) => g.id === (approverGroup ?? 'owners') || g.name.toLowerCase() === (approverGroup ?? '').toLowerCase()) ?? groups.find((g) => g.id === 'owners') ?? groups[0];
  // who is told, from the saved routing (Settings › Notifications) and the group's current members
  const reach = recipientsOf(db, 'approval.pending', group.name);
  const notified = channelsOf(reach);
  const hours = expiresInH ?? 24;
  const r = appendBeforeRun(db, {
    ...base, rule_id: ruleId, decision: 'ask', reason, approval: { id, status: 'pending' },
    details: { route: agent.route, mode, approver_group: group.id, expires_in: `${hours}h`, notified: notified.join(','), notified_people: reach.filter((x) => x.email || x.slack || x.whatsapp).length, ...auto },
  });
  if (r.decision !== 'ask') return r; // the hold could not be recorded: the guard refused instead (gate-error)
  const triggeredBy = ev.quota ? `the ${ev.quota.window} quota of ${rule?.id ?? ruleId} is used up` : checkHold ? checkHold.reason : auto.autonomy && auto.rulebook_decision ?`autonomy ${auto.autonomy} holds this write for a person` : call.triggeredBy ?? '';
  db.approvals.push({
    id, seq: r.seq, agentSlug: agent.slug, tool: call.tool, connector: call.connector, headline: rw(call.headline ?? `${agent.slug} wants to call ${call.tool}`).replace(/^[\w-]+ wants/, `${agent.slug} wants`),
    ruleId, ruleReason: reason, triggeredBy, approverGroup: group.name, args: call.args, effect: rw(call.effect ?? ''), riskTags: tags,
    status: 'pending', createdAt: r.ts, expiresAt: new Date(Date.now() + hours * H).toISOString(), similar: { approved: liveRand.int(3, 30), rejected: liveRand.int(0, 4), reversed: 0 },
    approveInChat: !ev.quota && (rule?.approveInChat ?? !!call.approveInChat), amount: call.amount, counterparty: call.counterparty, notified,
    notifiedTo: reach.map((x) => ({ userId: x.userId, channels: recipientChannels(x) })),
  });
  emit(orgId, 'approval');
  // F2: the approvers are told — an email link always, chat where allowed (never at Sovereign) — with an
  // approval.notified receipt. Deferred so nothing is written while a screen renders; not for the sandbox tenant.
  if (opts?.environment !== 'sandbox') setTimeout(() => { void import('./approvalNotify').then((m) => m.notifyHeldApproval(orgId, id)).catch(() => undefined); }, 0);
  return r;
}

/* ── Receipt writes that fail ─────────────────────────────── */

/** Thrown when a receipt cannot be written (signing or storage unavailable). */
export class ReceiptWriteError extends Error {
  constructor(message = 'The receipt could not be written: the signing service did not answer.') { super(message); }
}

const writeFaults = new Map<string, number>();

/**
 * Make the next `n` receipt writes for decisions and approvals in an organisation fail once (a test hook for the
 * receipt-write health path; the console never calls it). The retry that follows succeeds.
 */
export function failNextReceiptWrites(orgId: string, n = 1) {
  writeFaults.set(orgId, (writeFaults.get(orgId) ?? 0) + n);
}

function tryWrite(db: OrgDB, body: Parameters<typeof append>[1]): Receipt {
  const left = writeFaults.get(db.org.id) ?? 0;
  if (left > 0) {
    writeFaults.set(db.org.id, left - 1);
    throw new ReceiptWriteError();
  }
  return append(db, body);
}

/**
 * Write a receipt before anything runs. If the write fails, nothing has run, so the guard fails closed: the call
 * is refused with gate-error and the refusal is recorded once the write path answers again.
 */
function appendBeforeRun(db: OrgDB, body: Parameters<typeof append>[1]): Receipt {
  try {
    return tryWrite(db, body);
  } catch (e) {
    if (!(e instanceof ReceiptWriteError)) throw e;
    const { approval: _held, ...rest } = body;
    return append(db, {
      ...rest, rule_id: 'gate-error', decision: 'refuse', outcome: { status: 'not_run' },
      reason: `The decision could not be recorded (${e.message}). The guard fails closed: nothing ran.`,
      details: { ...(body.details ?? {}), receipt_write: 'failed_before_run', intended_decision: body.decision ?? '' },
    });
  }
}

/**
 * Write the receipt for a call that already ran (a governed run that was allowed, or approved). If the write fails,
 * the call is NOT reported as refused — it ran. The receipt is written on retry with an error outcome that says
 * so, and the decision stays what it was.
 */
function appendAfterRun(db: OrgDB, body: Parameters<typeof append>[1]): Receipt {
  try {
    return tryWrite(db, body);
  } catch (e) {
    if (!(e instanceof ReceiptWriteError)) throw e;
    return append(db, {
      ...body,
      outcome: { status: 'error', ref: body.outcome?.ref, ms: body.outcome?.ms },
      reason: `${body.reason ? `${body.reason} ` : ''}The call ran, but its receipt could not be written at the time (${e.message}); it was written on retry. Reported as an error, not a refusal.`,
      details: { ...(body.details ?? {}), receipt_write: 'failed_after_run', retried: true },
    });
  }
}

/** Expire every waiting approval of an organisation whose expiry has passed (an expiry is a refusal). */
export function expireDue(orgId: string) {
  return expireApprovals(getDB(orgId));
}

/** The approvals service is down for this organisation (mock/approvalsExt): fail closed, nothing is decided, re-routed or extended. */
export function approvalsDown(db: OrgDB): boolean {
  return !!(db as OrgDB & { approvalsExt?: { outage?: { active?: boolean } } }).approvalsExt?.outage?.active;
}

export const APPROVALS_DOWN_SENTENCE = 'We cannot check this change right now. Nothing was changed.';

function expireApprovals(db: OrgDB): number {
  // an approvals outage pauses expiry: nothing expires while the service is down (mock/approvalsExt)
  if ((db as OrgDB & { approvalsExt?: { outage?: { active?: boolean } } }).approvalsExt?.outage?.active) return 0;
  const now = Date.now();
  let n = 0;
  for (const a of db.approvals) {
    if (a.status === 'pending' && new Date(a.expiresAt).getTime() <= now) {
      // expiry keeps running during an emergency stop: an expiry is a refusal, which is always safe
      const held = !!a.heldByStop;
      a.heldByStop = undefined;
      a.status = 'expired';
      a.decidedAt = new Date().toISOString();
      a.decisionReason = held ? 'No one could decide it before the expiry: an emergency stop held it. Expiry is a refusal.' : 'No one decided within the expiry. Expiry is a refusal.';
      const r = append(db, { kind: 'approval', agent: a.agentSlug, tool: a.tool, ref_seq: a.seq, approval: { id: a.id, status: 'expired' }, decision: 'refuse', reason: a.decisionReason, outcome: { status: 'not_run' }, actor: 'system', details: { channel: 'expiry' } });
      a.resultSeq = r.seq;
      n++;
    }
  }
  if (n) emit(db.org.id, 'approval');
  return n;
}

const expired = (a: Pick<Approval, 'expiresAt'>) => Date.now() >= new Date(a.expiresAt).getTime();

/* ── Mutations ────────────────────────────────────────────── */

/**
 * The people who may decide an approval: the current group, the group the rule first named, and any group it was
 * escalated from or to. With `forUser`, a group that person re-routed the approval to does not count for them:
 * nobody approves their own re-route (someone else in that group decides it).
 */
export function allowedApprovers(orgId: string, a: Approval, forUser?: string): string[] {
  const db = getDB(orgId);
  const escs = a.escalations ?? [];
  const names = new Set<string>([a.originalGroup ?? a.approverGroup]);
  if (!escs.length) names.add(a.approverGroup);
  // Every `from` is the original group or an earlier `to`, so it is already counted (or deliberately left out).
  // A group reached through this person's own re-route never counts for them, even when the approval has since
  // moved on from it: re-routing Owners → Engineering → Finance does not make an Engineering admin an approver.
  for (const e of escs) {
    if (!(forUser && e.by === forUser)) names.add(e.to);
    if (!forUser) names.add(e.from);
  }
  return Array.from(new Set([...names].filter(Boolean).flatMap((n) => effectiveGroupOf(db, n)?.members ?? [])));
}

/**
 * Hooks registered by mock/approvalsExt: `delegateFor` returns the approver a person stands in for when a named,
 * time-boxed delegation lets them decide this approval (undefined otherwise).
 */
export const approvalHooks: { delegateFor?: (orgId: string, a: Approval, userId: string) => string | undefined } = {};

/** Does an emergency stop cover this approval's agent? (all agents, or the agents a selective stop named, or one it froze) */
function stopCovers(db: OrgDB, a: Pick<Approval, 'agentSlug'> & { heldByStop?: Approval['heldByStop'] }) {
  if (!db.stop.active) return false;
  if (a.heldByStop) return true;
  return db.stop.scope !== 'selected_agents' || !db.stop.agentSlugs || db.stop.agentSlugs.includes(a.agentSlug);
}

/**
 * Why a waiting approval cannot be decided now, if it cannot: an emergency stop holds it, or its agent is paused.
 * Expiry still runs in both cases (an expiry is a refusal).
 */
export function decisionBlocked(orgId: string, a: Approval): string | undefined {
  const db = getDB(orgId);
  if (a.status !== 'pending') return undefined;
  if (stopCovers(db, a)) {
    const since = db.stop.since ? new Date(db.stop.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : undefined;
    return `Held by the emergency stop${since ? ` engaged at ${since} IST` : ''}${db.stop.reason ? ` (${db.stop.reason})` : ''}. Nobody can approve or reject it while the stop is on; it keeps waiting, and its expiry still runs. Lift the stop to decide it.`;
  }
  const ag = db.agents.find((x) => x.slug === a.agentSlug);
  if (ag && ag.status !== 'active' && ag.status !== 'draft') return `${ag.slug} is paused. Resume it to decide its waiting approvals; their expiry still runs.`;
  return undefined;
}

/** Why a waiting approval has run out, if its expiry has passed (it is expired as a refusal at once). */
function expiredNow(db: OrgDB, a: Approval): string | undefined {
  if (a.status !== 'pending' || !expired(a)) return undefined;
  expireApprovals(db);
  return 'This approval expired. Expiry is a refusal: nothing ran.';
}

/**
 * Decide a held call. Approver-group membership is enforced: only members of the approver group
 * (or of the group it was escalated from) may decide — with the edits saved in People and roles ›
 * Approver groups applied. An owner may decide outside the group; that override is recorded on the
 * approval and on the receipt. While an emergency stop covers the agent nobody can decide it.
 */
export function decideApproval(orgId: string, id: string, approve: boolean, userId: string, reason: string, channel: Channel = 'web', extra: Record<string, string | number | boolean> = {}) {
  const db = getDB(orgId);
  const a = db.approvals.find((x) => x.id === id);
  if (!a || a.status !== 'pending') throw new Error('This approval is no longer waiting.');
  if (approvalsDown(db)) throw new Error(APPROVALS_DOWN_SENTENCE);
  const late = expiredNow(db, a);
  if (late) throw new Error(late);
  const blocked = decisionBlocked(orgId, a);
  if (blocked) throw new Error(blocked);
  const user = userById(userId);
  const role = memberRole(orgId, userId);
  if (!can(role, 'approvals.decide')) throw new Error(`${user ? `${user.name} has` : 'You have'} no role in this organisation that decides approvals${role ? ` (${role})` : ''}.`);
  const member = allowedApprovers(orgId, a, userId).includes(userId) || !!approvalHooks.delegateFor?.(orgId, a, userId);
  const isOwner = role === 'owner';
  if (!member && !isOwner) {
    const selfReroute = (a.escalations ?? []).some((e) => e.by === userId);
    const why = selfReroute
      ? `You re-routed this approval, so a member of ${a.approverGroup} who did not re-route it decides. A group you routed it into never makes you an approver. An owner can decide outside the group; that is recorded.`
      : `Only members of the ${a.approverGroup} approver group can decide this${a.originalGroup && a.originalGroup !== a.approverGroup ? ` (or ${a.originalGroup}, which it was escalated from)` : ''}. ${user ? `${user.name} is not in it.` : ''} An owner can decide outside the group; that is recorded.`.trim();
    // the refused attempt is itself a receipt: who tried, on which approval, and why it was refused
    const refused = append(db, { kind: 'admin', actor: userId, agent: a.agentSlug, action: 'approval.decide_refused', details: { approval: id, attempted: approve ? 'approve' : 'reject', approver_group: a.approverGroup, channel, reason: selfReroute ? 're-routed this approval' : 'not in the approver group' } });
    emit(orgId, 'approval');
    throw new Error(`${why} This attempt is recorded (receipt #${refused.seq}).`);
  }
  const agent = db.agents.find((x) => x.slug === a.agentSlug);
  const advisory = agent?.route !== 'mcp';
  const creator = agent?.ownerId === userId;
  const status = approve ? 'approved' as const : 'rejected' as const;
  const body: Parameters<typeof append>[1] = {
    kind: 'approval', agent: a.agentSlug, tool: a.tool, ref_seq: a.seq, approval: { id, status, approver: userId, channel, self_approval: creator },
    decision: approve ? 'allow' : 'refuse', reason, actor: userId,
    outcome: approve ? (advisory ? undefined : { status: 'ok', ref: `${a.connector.split(' ')[0].toLowerCase()}:${Math.floor(Math.random() * 900000 + 100000)}`, ms: 640 }) : { status: 'not_run' },
    details: { channel, mode: advisory ? 'check_and_record' : 'governed_run', approver_group: a.approverGroup, ...(creator ? { flag: 'approver created this agent' } : {}), ...(!member ? { owner_override: true } : {}), ...extra },
  };
  let r: Receipt;
  if (approve && !advisory) {
    // the approved call runs, then its receipt is written; a failed write is an error outcome, never a refusal
    r = appendAfterRun(db, body);
  } else {
    try {
      r = tryWrite(db, body);
    } catch (e) {
      if (!(e instanceof ReceiptWriteError)) throw e;
      throw new Error(`Your decision could not be recorded (${e.message}). Nothing ran and the approval is still waiting. Try again.`);
    }
  }
  a.status = status;
  a.decidedAt = r.ts;
  a.decidedBy = userId;
  a.channel = channel;
  a.decisionReason = reason;
  a.heldByStop = undefined;
  if (!member) a.override = { by: userId, reason: 'Owner decided outside the approver group' };
  a.resultSeq = r.seq;
  emit(orgId, 'approval');
  return { approval: a, receipt: r };
}

export function reroute(orgId: string, id: string, toGroup: string, userId: string) {
  const db = getDB(orgId);
  if (!can(memberRole(orgId, userId), 'approvals.reroute')) throw new Error('Owners and admins re-route approvals; your role cannot.');
  const a = db.approvals.find((x) => x.id === id);
  if (!a) throw new Error('This approval does not exist in this organisation.');
  if (a.status !== 'pending') throw new Error('This approval is no longer waiting, so it cannot be re-routed.');
  if (approvalsDown(db)) throw new Error(`It cannot be re-routed now. ${APPROVALS_DOWN_SENTENCE}`);
  const late = expiredNow(db, a);
  if (late) throw new Error(late);
  const blocked = decisionBlocked(orgId, a);
  if (blocked) throw new Error(`It cannot be re-routed now. ${blocked}`);
  const target = effectiveGroupOf(db, toGroup);
  if (!target) throw new Error(`There is no approver group called ${toGroup}.`);
  if (target.name.toLowerCase() === a.approverGroup.toLowerCase()) throw new Error(`It is already with ${target.name}.`);
  a.originalGroup ??= a.approverGroup;
  const from = a.approverGroup;
  a.approverGroup = target.name;
  const r = append(db, { kind: 'admin', actor: userId, action: 'approval.rerouted', agent: a.agentSlug, details: { approval: id, from, to: a.approverGroup } });
  (a.escalations ??= []).push({ at: r.ts, from, to: a.approverGroup, by: userId, seq: r.seq });
  // the new group is told like the first hold (single-use links, email always, chat where allowed, never chat at
  // Sovereign), with an approval.notified receipt, reason rerouted. Deferred, as governCall defers the first round.
  setTimeout(() => { void import('./approvalNotify').then((m) => m.notifyRoutedApproval(orgId, id, 'rerouted', r.seq)).catch(() => undefined); }, 0);
  emit(orgId, 'approval');
  return a;
}

/** An approval expires 24 hours after it is held; it can be extended once, by 24 hours, with a declared reason. */
export const APPROVAL_EXTENSION_HOURS = 24;

export function extendApproval(orgId: string, id: string, reason: string, userId: string) {
  const db = getDB(orgId);
  if (!can(memberRole(orgId, userId), 'approvals.decide')) throw new Error('Approvers, admins and owners extend approvals; your role cannot.');
  const a = db.approvals.find((x) => x.id === id);
  if (!a) throw new Error('This approval does not exist in this organisation.');
  if (a.status !== 'pending') throw new Error('This approval is no longer waiting, so it cannot be extended.');
  if (approvalsDown(db)) throw new Error(`It cannot be extended now. ${APPROVALS_DOWN_SENTENCE}`);
  const late = expiredNow(db, a);
  if (late) throw new Error(late);
  if (a.extension) throw new Error(`It was already extended once, by ${a.extension.by === userId ? 'you' : 'someone else'}. An approval can be extended only once.`);
  if (reason.trim().length < 5) throw new Error('Say why it needs more time. The reason is recorded on the chain.');
  const from = a.expiresAt;
  const to = new Date(new Date(from).getTime() + APPROVAL_EXTENSION_HOURS * H).toISOString();
  a.expiresAt = to;
  const r = append(db, { kind: 'admin', actor: userId, action: 'approval.extended', agent: a.agentSlug, details: { approval: id, from, to, hours: APPROVAL_EXTENSION_HOURS, reason: reason.trim() } });
  a.extension = { by: userId, at: r.ts, reason: reason.trim(), from, to, seq: r.seq };
  emit(orgId, 'approval');
  return a;
}

export function setAgentStatus(orgId: string, slug: string, status: 'active' | 'paused', userId: string, reason = '') {
  const db = getDB(orgId);
  const a = db.agents.find((x) => x.slug === slug);
  if (!a) throw new Error('Not found');
  // an agent the emergency stop paused comes back only by lifting the stop (two people from L2), never one by one
  if (a.pausedBy === 'emergency-stop' && db.stop.active) throw new Error(`${slug} was paused by the emergency stop. It resumes only when the stop is lifted from its incident${db.stop.incidentId ? ` (${db.stop.incidentId})` : ''}; from L2 that needs a second owner or admin.`);
  a.status = status;
  a.pausedBy = status === 'paused' ? 'owner' : undefined;
  append(db, { kind: 'admin', actor: userId, action: status === 'paused' ? 'agent.paused' : 'agent.resumed', agent: slug, details: { reason: reason || (status === 'paused' ? 'Paused from the console' : 'Resumed from the console') } });
  if (status === 'active') {
    const inc = db.incidents.find((i) => i.status === 'active' && i.agentSlugs.includes(slug) && i.kind === 'auto_pause');
    if (inc) { inc.status = 'resolved'; inc.resolvedAt = new Date().toISOString(); inc.resolvedBy = userId; inc.timeline.push({ ts: inc.resolvedAt, text: `${slug} resumed`, actor: userId }); }
  }
  emit(orgId, 'agent');
  return a;
}

export function engageStop(orgId: string, userId: string, reason: string, slugs?: string[]) {
  const db = getDB(orgId);
  // one stop at a time: a second one would orphan the first incident and release the approvals it froze
  if (db.stop.active) throw new Error(db.stop.scope === 'selected_agents'
    ? 'An emergency stop is already engaged on selected agents. Widen it from its incident (or from the Stop button) to add agents or cover every agent; one owner or admin can do that. Only one stop is open at a time.'
    : 'An emergency stop is already engaged on every agent. Only one stop is open at a time; lift it from its incident before engaging another.');
  const targets = db.agents.filter((a) => a.status === 'active' && (!slugs || slugs.includes(a.slug)));
  const scope = slugs ? 'selected_agents' as const : 'all_agents' as const;
  // approvals already waiting are frozen: they keep waiting but nobody can decide them until the stop is lifted
  const frozen = db.approvals.filter((a) => a.status === 'pending' && (!slugs || slugs.includes(a.agentSlug)));
  const pending = frozen.length;
  targets.forEach((a) => { a.status = 'stopped'; a.pausedBy = 'emergency-stop'; });
  const r = append(db, { kind: 'admin', actor: userId, action: 'stop.engaged', details: { scope, reason, agents_paused: targets.length, pending_approvals: pending, approvals_held: pending } });
  const reach = recipientsOf(db, 'stop.engaged');
  const inc: Incident = {
    id: `inc_${Date.now().toString(36)}`, title: slugs ? `Stop: ${slugs.join(', ')}` : 'Emergency stop', kind: 'emergency_stop', status: 'active', scope,
    agentSlugs: targets.map((t) => t.slug), startedAt: r.ts, startedBy: userId, reason, refusedWhileStopped: 0, pendingApprovalsAtStop: pending,
    timeline: [
      { ts: r.ts, text: `Stop engaged. ${targets.length} agents paused in one transaction.`, seq: r.seq, actor: userId },
      ...(pending ? [{ ts: r.ts, text: `${pending} waiting ${pending === 1 ? 'approval is' : 'approvals are'} held by the stop: nobody can decide ${pending === 1 ? 'it' : 'them'} until it is lifted.` }] : []),
      { ts: r.ts, text: `Banner shown on every console page; ${reachPhrase(reach)}.` },
    ],
  };
  frozen.forEach((a) => { a.heldByStop = { since: r.ts, incidentId: inc.id, by: userId }; });
  db.incidents.unshift(inc);
  db.stop = { active: true, incidentId: inc.id, since: r.ts, by: userId, reason, scope, agentSlugs: slugs ? [...slugs] : undefined };
  emit(orgId, 'stop');
  return inc;
}

/**
 * Widen an engaged selected-agents stop: add agents to it (`slugs`), or make it a stop on every agent (no `slugs`).
 * One owner or admin, at every level: widening only stops more agents, so — like engaging — it needs no second
 * person. Approvals waiting for the added agents are held too. Writes stop.widened and updates the incident.
 * Lifting is unchanged: it resumes every agent the stop paused, from L2 with a second owner or admin.
 */
export function widenStop(orgId: string, userId: string, reason: string, slugs?: string[]) {
  const db = getDB(orgId);
  if (!db.stop.active || !db.stop.incidentId) throw new Error('No emergency stop is engaged. Engage one from the Stop button.');
  if (db.stop.scope !== 'selected_agents') throw new Error('This stop already covers every agent; there is nothing to widen.');
  if (reason.trim().length < 4) throw new Error('Say why the stop is widened. The reason is recorded on the receipt and the incident.');
  const inc = db.incidents.find((i) => i.id === db.stop.incidentId);
  const toAll = !slugs;
  const before = db.stop.agentSlugs ?? [];
  const asked = toAll ? [] : slugs!.filter((s) => !before.includes(s));
  if (!toAll && !asked.length) throw new Error('Choose at least one agent the stop does not cover yet.');
  const unknown = asked.filter((s) => !db.agents.some((a) => a.slug === s));
  if (unknown.length) throw new Error(`No agent called ${unknown.join(', ')} in this organisation.`);
  const targets = db.agents.filter((a) => a.status === 'active' && (toAll || asked.includes(a.slug)));
  const covered = (slug: string) => toAll || before.includes(slug) || asked.includes(slug);
  const frozen = db.approvals.filter((a) => a.status === 'pending' && !a.heldByStop && covered(a.agentSlug));
  targets.forEach((a) => { a.status = 'stopped'; a.pausedBy = 'emergency-stop'; });
  const scope = toAll ? 'all_agents' as const : 'selected_agents' as const;
  const r = append(db, { kind: 'admin', actor: userId, action: 'stop.widened', details: { incident: db.stop.incidentId, from_scope: 'selected_agents', scope, reason: reason.trim(), agents_added: targets.length, ...(toAll ? {} : { added: asked.join(',') }), approvals_held: frozen.length } });
  frozen.forEach((a) => { a.heldByStop = { since: r.ts, incidentId: db.stop.incidentId, by: userId }; });
  const nextSlugs = toAll ? undefined : [...before, ...asked];
  db.stop = { ...db.stop, scope, agentSlugs: nextSlugs };
  if (inc) {
    inc.scope = scope;
    inc.agentSlugs = Array.from(new Set([...inc.agentSlugs, ...targets.map((t) => t.slug)]));
    inc.title = toAll ? 'Emergency stop' : `Stop: ${nextSlugs!.join(', ')}`;
    inc.pendingApprovalsAtStop += frozen.length;
    inc.timeline.push({ ts: r.ts, text: `Stop widened ${toAll ? 'to every agent' : `to ${asked.join(', ')}`}: ${targets.length} more ${targets.length === 1 ? 'agent' : 'agents'} paused. “${reason.trim()}”`, seq: r.seq, actor: userId });
    if (frozen.length) inc.timeline.push({ ts: r.ts, text: `${frozen.length} more waiting ${frozen.length === 1 ? 'approval is' : 'approvals are'} held by the stop until it is lifted.` });
  }
  emit(orgId, 'stop');
  return { incident: inc, seq: r.seq, added: targets.map((t) => t.slug), held: frozen.length };
}

export function liftStop(orgId: string, userId: string, note: string) {
  const db = getDB(orgId);
  if (!db.stop.active) throw new Error('No emergency stop is engaged.');
  const inc = db.incidents.find((i) => i.id === db.stop.incidentId);
  const resumed = db.agents.filter((a) => a.pausedBy === 'emergency-stop');
  resumed.forEach((a) => { a.status = 'active'; a.pausedBy = undefined; });
  // held approvals become decidable again; they kept waiting (any that reached their expiry expired as a refusal)
  const released = db.approvals.filter((a) => a.heldByStop);
  released.forEach((a) => { a.heldByStop = undefined; });
  const stillWaiting = released.filter((a) => a.status === 'pending').length;
  const r = append(db, { kind: 'admin', actor: userId, action: 'stop.lifted', details: { agents_resumed: resumed.length, note, approvals_released: stillWaiting } });
  if (inc) {
    inc.status = 'resolved'; inc.resolvedAt = r.ts; inc.resolvedBy = userId;
    inc.refusedWhileStopped = db.receipts.filter((x) => x.seq > (inc.timeline[0].seq ?? 0) && x.rule_id === 'agent-paused').length;
    inc.timeline.push(
      { ts: r.ts, text: `Stop lifted. ${resumed.length} agents resumed — only those the stop paused.`, seq: r.seq, actor: userId },
      ...(stillWaiting ? [{ ts: r.ts, text: `${stillWaiting} held ${stillWaiting === 1 ? 'approval can' : 'approvals can'} be decided again.` }] : []),
      { ts: r.ts, text: 'Incident report generated.' },
    );
  }
  db.stop = { active: false };
  emit(orgId, 'stop');
}

/**
 * Sign and publish a rulebook version.
 * Dual control: from L2 Attested a different person must have approved a review of this version
 * (api.requestReview → api.approveReview) before it can be published; otherwise this throws.
 * At L1 Guarded the reviewer is recorded but not enforced.
 */
export function publishRulebook(orgId: string, rulebookId: string, yaml: string, rules: Rule[], note: string, userId: string, reviewerId?: string) {
  const db = getDB(orgId);
  const rb = db.rulebooks.find((r) => r.id === rulebookId);
  if (!rb) throw new Error('This rulebook does not exist in this organisation.');
  const draft = rb.versions.find((v) => v.status !== 'published');
  const version = draft ? draft.version : Math.max(...rb.versions.map((v) => v.version)) + 1;
  const enforced = atLeast(levelOfOrg(db.org), 'l2');
  const review = db.platform.reviews.filter((x) => x.rulebookId === rulebookId && x.version === version && x.status === 'approved').pop();
  if (enforced) {
    if (!review) throw new Error('Dual control: a different person must approve a review of this version before it is published. Request a review first.');
    if (review.reviewerId === userId) throw new Error('Dual control: the person who reviewed this version cannot also publish it.');
    if (reviewerId && reviewerId !== review.reviewerId) throw new Error(`Dual control: the approved review was by ${userName(review.reviewerId)}, not ${userName(reviewerId)}.`);
    // the content published must be exactly the content that was reviewed
    const reviewed = review.draftHash ?? draft?.hash;
    if (!reviewed || sha256Hex(yaml) !== reviewed) throw new Error('Dual control: this content is not the version that was reviewed. Save it as a draft and ask for a review of it.');
    // publish the reviewed rules, never whatever was passed with the text: the snapshot taken when the review was
    // asked for, or the draft's own rules when it is still exactly the reviewed content
    const reviewedRules = review.rules ?? (draft && draft.hash === reviewed ? draft.rules : undefined);
    if (!reviewedRules) throw new Error('Dual control: the rules that were reviewed are not on record. Ask for a new review of the current draft.');
    rules = JSON.parse(JSON.stringify(reviewedRules)) as Rule[];
  }
  const reviewedBy = review?.reviewerId ?? reviewerId;
  const now = new Date().toISOString();
  const v = { version, status: 'published' as const, hash: sha256Hex(yaml), createdBy: draft?.createdBy ?? userId, createdAt: draft?.createdAt ?? now, note, rules, yaml, signedBy: userId, signedAt: now, reviewedBy };
  rb.versions = rb.versions.filter((x) => x.version !== version).concat(v);
  rb.currentVersion = version;
  rb.updatedAt = now;
  if (review) review.status = 'published';
  // with the replay store off no Test on past actions was possible: the publish goes ahead and says so on its receipt
  const noReplay = !replayOnOf(db);
  append(db, { kind: 'admin', actor: userId, action: 'rulebook.published', agent: rb.slug, details: { rulebook: rb.slug, version, hash: v.hash.slice(0, 16), reviewed_by: reviewedBy ?? '', dual_control: enforced ? 'enforced' : 'recorded', ...(noReplay ? { replay_test: 'not_possible_replay_store_off' } : {}) } });
  emit(orgId, 'rulebook');
  return v;
}

export function saveDraft(orgId: string, rulebookId: string, yaml: string, rules: Rule[], note: string, userId: string) {
  const db = getDB(orgId);
  const rb = db.rulebooks.find((r) => r.id === rulebookId);
  if (!rb) throw new Error('This rulebook does not exist in this organisation.');
  const existing = rb.versions.find((v) => v.status !== 'published');
  const version = existing?.version ?? Math.max(...rb.versions.map((v) => v.version)) + 1;
  const v = { version, status: 'draft' as const, hash: sha256Hex(yaml), createdBy: userId, createdAt: new Date().toISOString(), note, rules, yaml };
  rb.versions = rb.versions.filter((x) => x.version !== version).concat(v);
  rb.updatedAt = v.createdAt;
  // a changed draft needs a fresh review
  db.platform.reviews.filter((x) => x.rulebookId === rulebookId && x.version === version && (x.status === 'approved' || x.status === 'pending')).forEach((x) => { x.status = 'changes_requested'; x.decisionNote = 'The draft changed after the review was requested.'; });
  emit(orgId, 'rulebook');
  return v;
}

/** Slugs that are routes of their own (/agents/new, /rulebooks/suggestions …) and so cannot name an agent. */
export const RESERVED_AGENT_SLUGS = ['new', 'map', 'gate', 'gmail', 'zoho', 'admin', 'autonomy', 'keys', 'people', 'organisation', 'deployment', 'suggestions', 'settings', 'edit', 'production', 'notices'];

/** Why a slug cannot name a new agent here, or undefined. */
export function agentSlugProblem(db: OrgDB, slug: string): string | undefined {
  if (slug.length < 3 || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return 'Use at least 3 lowercase letters a–z, digits 0–9 and single hyphens, not at the start or end.';
  if (RESERVED_AGENT_SLUGS.includes(slug)) return `“${slug}” is reserved for a page of the console. Choose another slug.`;
  if (db.agents.some((a) => a.slug === slug) || db.rulebooks.some((r) => r.slug === slug)) return 'Another agent already uses this slug.';
  return undefined;
}

export function createAgent(orgId: string, input: { name: string; slug: string; description: string; framework: Agent['framework']; route: Agent['route']; ownerId: string; riskLevel: Agent['riskLevel']; connectorIds: string[]; tools: string[]; starter: 'strict' | 'balanced' }, userId: string) {
  const db = getDB(orgId);
  const slugError = agentSlugProblem(db, input.slug);
  if (slugError) throw new Error(slugError);
  const id = `ag_${input.slug}`;
  const rbId = `rb_${input.slug}`;
  const rules: Rule[] = input.tools.map((t) => {
    const tags = db.connectors.flatMap((c) => c.tools).find((x) => x.name === t)?.tags ?? [];
    const high = tags.some((g) => ['moves_money', 'deletes', 'changes_access', 'changes_production'].includes(g));
    return { id: t.replace(/\./g, '-'), match: { tool: t }, decide: high ? (input.starter === 'strict' ? 'refuse' : 'ask') : tags.includes('reads_data') || input.starter === 'balanced' ? 'allow' : 'ask', approver: high ? 'owners' : undefined, reason: high ? 'High-impact tool held for a person.' : 'Starter rule.' } as Rule;
  });
  const yaml = rulebookYaml(input.slug, 1, input.ownerId, rules, ['owners']);
  const now = new Date().toISOString();
  const rb: Rulebook = { id: rbId, slug: input.slug, name: `${input.name} rulebook`, agentId: id, default: 'refuse', approverGroups: approverGroupsFor(orgId).filter((g) => g.id === 'owners'), currentVersion: 1, updatedAt: now, versions: [{ version: 1, status: 'published', hash: sha256Hex(yaml), createdBy: userId, createdAt: now, signedBy: userId, signedAt: now, note: 'Starter rulebook from the add-agent wizard', rules, yaml }] };
  // a new agent gets a sandbox key only: a production key (gk_) is never self-serve; it is asked for and reviewed (Agents › Path to production)
  const secret = `sk_sbx_${Array.from(crypto.getRandomValues(new Uint8Array(18))).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const agent = { id, slug: input.slug, name: input.name, description: input.description, framework: input.framework, route: input.route, status: 'active' as const, ownerId: input.ownerId, riskLevel: input.riskLevel, rulebookId: rbId, connectorIds: input.connectorIds, tools: input.tools, createdAt: now, keys: [{ id: `key_${input.slug}`, prefix: secret.slice(0, 12), label: 'Created in wizard (sandbox)', createdAt: now, environment: 'sandbox' as const, expiresAt: new Date(Date.now() + 90 * 24 * 3_600_000).toISOString() }], stats: { calls7d: 0, allowed7d: 0, asked7d: 0, refused7d: 0 }, scenarioKey: '' };
  db.agents.push(agent);
  db.rulebooks.push(rb);
  append(db, { kind: 'admin', actor: userId, action: 'agent.created', agent: input.slug, details: { route: input.route, tools: input.tools.length } });
  append(db, { kind: 'admin', actor: userId, action: 'rulebook.published', agent: input.slug, details: { rulebook: input.slug, version: 1, hash: rb.versions[0].hash.slice(0, 16), reviewed_by: '' } });
  emit(orgId, 'agent');
  return { agent, secret, mcpUrl: `https://govern.elan1.ai/mcp/${db.org.slug}/${input.slug}` };
}

/**
 * A receipt with the values the rules inspected removed (args_summary becomes a marker), saying what was removed
 * and why. Hash and signature stay as signed, so the chain link and the original signature still verify; the
 * content hash cannot be recomputed, so the organisation's current key signs the redacted receipt (with its
 * original hash) and the verifier checks that signature instead: no remaining field can be changed afterwards.
 */
export function redactReceipt(db: OrgDB, r: Receipt, payloadHash: string, request?: string, at = new Date().toISOString()): Receipt {
  if (r.redacted?.sig) return r;
  const key = db.keys[db.keys.length - 1].key;
  return signRedaction({ ...r, args_summary: { erased: true }, redacted: { fields: ['args_summary'], reason: 'Erased on a data principal’s request: the salt was destroyed and the values the rules inspected were removed.', request, payloadHash, at } }, key);
}

/**
 * State saved before erasure removed values from the organisation's own chain: redact those receipts now (F12 is
 * frozen first, as it would have been at erasure time), so no erased value stays readable in the console.
 */
function redactLegacyErased(db: OrgDB) {
  const erased = db.platform?.erased ?? {};
  for (const k of Object.keys(erased)) {
    const seq = Number(k);
    const i = db.receipts.findIndex((x) => x.seq === seq);
    const r = db.receipts[i];
    if (!r || r.redacted?.sig) continue;
    (db.platform.erasedRecordIds ??= {})[seq] ??= sealedRecordId(r, undefined);
    const req = db.platform.erasures.find((e) => e.status === 'executed' && e.affectedSeqs.includes(seq));
    db.receipts[i] = redactReceipt(db, r, erased[seq], req?.subjectRef, req?.executedAt);
  }
}

/**
 * Receipts for an export with every erased receipt redacted. An executed erasure already redacts the receipt in
 * the organisation's own chain; this also covers state saved before that, so no export carries an erased value.
 */
export function redactErased(db: OrgDB, receipts: Receipt[]): Receipt[] {
  const erased = db.platform?.erased ?? {};
  if (!Object.keys(erased).length) return receipts;
  const requestOf = (seq: number) => db.platform.erasures.find((e) => e.status === 'executed' && e.affectedSeqs.includes(seq));
  // dated when the erasure was executed (not now), so the same range always exports the same bytes: the export
  // dialog shows receipts.jsonl's digest before writing, and it must match the manifest's
  return receipts.map((r) => {
    if (!erased[r.seq] || r.redacted?.sig) return r;
    const req = requestOf(r.seq);
    return req?.executedAt ? redactReceipt(db, r, erased[r.seq], req.subjectRef, req.executedAt) : redactReceipt(db, r, erased[r.seq], req?.subjectRef);
  });
}

/**
 * Export evidence. L1 organisations get the L1 auditor pack (auditor-pack/1: manifest, public_keys,
 * receipts, checkpoints). From L2 the export is the 8-member evidence bundle (elan1.evidence.bundle.v1),
 * a superset of the L1 pack, with seals, anchors, declarations, an optional verifier profile and a README.
 */
export function exportAuditorPack(orgId: string, userId: string, fromSeq?: number, toSeq?: number, profileId?: string, opts?: ExportOptions) {
  const db = getDB(orgId);
  if (atLeast(levelOfOrg(db.org), 'l2')) return exportEvidenceBundle(db, userId, fromSeq, toSeq, profileId, opts);
  // L1: the auditor pack with its sealed manifest, PDF summary, compliance map and README (mock/evidence.ts); free
  const built = buildAuditorPack(db, userId, fromSeq, toSeq, opts);
  recordExport(db, userId, built, { charge: 0 });
  return built;
}

export function rotateKey(orgId: string, userId: string, reason = 'Rotated from the console', kidPrefix?: string, preset?: { seed: string; kid: string }) {
  const db = getDB(orgId);
  const n = db.keys.length + 1;
  // preset: a key created and bound before the switch (L1 → L2 upgrade, mock/upgrade.ts)
  const seed = preset?.seed ?? `${orgId}:key:${n}:${Date.now()}`;
  const k = keyFromSeed(seed, preset?.kid ?? `${kidPrefix ?? `k_${db.org.slug.split('-')[0]}`}_${new Date().toISOString().slice(2, 7).replace('-', '')}_${n}`);
  db.keySeeds.push({ seed, kid: k.kid, from: Date.now() });
  const old = db.keys[db.keys.length - 1].key;
  const r = append(db, { kind: 'admin', actor: userId, action: 'key.rotated', details: { old_kid: old.kid, new_kid: k.kid, reason } });
  db.keys.push({ key: k, from: Date.now() });
  db.publicKeys[k.kid] = k.publicKeyHex;
  const now = new Date().toISOString();
  db.signingKeys.forEach((s) => { if (s.status === 'active') { s.status = 'retired'; s.retiredAt = now; } });
  db.signingKeys.push({ kid: k.kid, fingerprint: k.fingerprint, algorithm: 'Ed25519', status: 'active', createdAt: now, receiptsSigned: 0 });
  db.org.keyFingerprint = k.fingerprint;
  syncOrgMeta(db.org);
  // The incoming key signs one record at once, so the newest record is never signed by a key that is no longer the
  // organisation's: a bundle checked against the new fingerprint passes straight after the switch. An L1 → L2 switch
  // with a bound key skips it: level.signing_on, signed by the new key, follows at the sequence named before the switch.
  if (!preset) append(db, { kind: 'admin', actor: 'system', action: 'key.signing_started', details: { kid: k.kid, fingerprint: k.fingerprint, rotated_seq: r.seq } });
  emit(orgId, 'key');
  return { old: old.kid, kid: k.kid, fingerprint: k.fingerprint, seq: r.seq };
}

export function logAdmin(orgId: string, userId: string, action: string, details: Record<string, string | number | boolean>, agent?: string) {
  const db = getDB(orgId);
  const r = append(db, { kind: 'admin', actor: userId, action, details, agent });
  return r;
}

export function touch(orgId: string, kind = 'update') {
  emit(orgId, kind);
}

/** Save the organisation's state without telling the screens (for state a read creates, such as a new salt secret). */
export function persist(orgId: string) {
  if (dbs.has(orgId)) saveState(orgId);
}

export function allUsers() {
  return USERS;
}

export { NOW0 };
