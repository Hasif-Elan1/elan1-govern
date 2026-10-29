/**
 * Level-specific platform state and computations for every organisation:
 *   Seal v6 records · Merkle anchor batches with two RFC 3161 timestamps · key custody and ceremonies ·
 *   the 8-member evidence bundle · verifier profiles · counterparties, cross-organisation receipts and
 *   selective disclosure · earned autonomy grants and graduation proposals · regulatory packs ·
 *   DPDP erasure · approval escalation and single-use links · dual-control reviews · the meter ·
 *   Sovereign deployment and air-gapped updates · residency · SAML/SCIM · AI discovery · public status.
 *
 * Real where it can be real: SHA-256, Ed25519, RFC 6962 Merkle roots, salted digests. What is modelled
 * (e.g. the Python test-vector run, monthly volumes before the chain window, cluster metrics) says so.
 */
import type {
  AnchorBatch, AnchorIncident, AnchorsView, ApprovalLinkToken, AutonomyGrant, AutonomyLevel, Capability, Channel, Counterparty, CrossOrgReceipt,
  DeploymentView, DisclosurePackage, DiscoveryFinding, DiscoveryScan, ErasureRequest, EscalationPolicy, IdentityConfig, InclusionProof,
  KeyCeremony, KeyCustody, LevelBoundary, LevelId, LevelState, MeterEvent, MeterView, PackExport, PackId, ProfileRunResult, Receipt,
  RegulatoryPack, ResidencyView, ReviewItem, ReviewRequest, SealRecord, StatusComponent, StatusView, TestVectorSuite, TimestampToken,
  TsaAuthority, UpdateBundle, UpgradePlan, UpgradeStep, GraduationProposal, ComponentStatus, AiSystem, Decision, SampleReview, RiskTag,
  VerifierProfile,
} from '@/types';
import { canonical, keyFromSeed, receiptHash, sha256Hex, signText, verifySig, verifyChain, type KeyPair } from '@/lib/crypto';
import { makeRand } from '@/lib/prng';
import { PLANS } from '@/lib/pricing';
import { CAPABILITIES, LEVEL_INFO, atLeast, capabilitiesAdded, levelAt, levelOfOrg, levelRank, nextLevel } from '@/lib/levels';
import { SEAL_FIELDS, digestOfFields, payloadHash, payloadOf, recordIdOf, randomHex, deriveSalt, sealedRecordId, sealFields, sealPreimage, fieldValues, signDigest, verifyDigestSig, verifySeal, runTestVectors } from '@/lib/seal';
import { merkleRoot, inclusionPath, verifyInclusion } from '@/lib/merkle';
import { buildLexicon } from './lexicon';
import { chainMeter } from '@/features/billing/chainMeter';
import { BUNDLE_MEMBERS, LEXICON_MEMBER, VERIFIER_VERSION, bundleDigest, manifestMessage, memberDigest, tokenMessage, type BundleManifest, type EvidenceBundle } from '@/lib/verify6';
import { PROFILES, profileById, runProfileRules } from '@/lib/profiles';
import { PACKS, packById } from '@/lib/packs';
import { DISCLOSABLE_FIELDS, commitFields, disclosureMessage, fieldValuesOf, verifyDisclosure } from '@/lib/disclosure';
import { AUTONOMY_LEVELS, GRADUATION, NO_GRANT_LABEL, START_LEVEL, UNAVAILABLE_LEVELS, autonomyLabel, cooldownFor, grantFor, graduationChecks, isReadOnly, isSupervised, type GraduationCheck } from '@/lib/autonomy';
import { replayStep } from '@/lib/crossorg';
import { LEGAL_ENTITY } from '@/lib/company';
import { isPlatformRefusal } from '@/lib/platformRefusal';
import { can } from '@/lib/permissions';
import { ORGS, groupFor, personFor, userById, userName } from './users';
import { TOOLS } from './catalog';
import { applyMaintenanceToStatus } from './opsMaintenance';
import { getDB, peekDB, append, touch, persist, rotateKey, decideApproval, decisionBlocked, allowedApprovers, syncOrgMeta, persistLevels, deriveBilling, flavourFor, orgIds, memberRole, redactErased, redactReceipt, toolTagsIn, expireDue, type OrgDB, type AuditorPackExport } from './db';
import { approvalsDown, APPROVALS_DOWN_SENTENCE } from './db';
import { channelsOf, effectiveGroupOf, effectiveGroupsOf, recipientChannels, recipientsOf } from './orgSettings';
import { takeBoundKey } from './upgrade';
import { assertKeyChangeAllowed, unsignedIntervalsInRange } from './keys';
import { ENFORCEMENT_LABEL, enforcementOf, recordExport, type ExportOptions } from './evidence';
import { hostingManifest } from './records';
import { assertPilotWritable, endPilotOnUpgrade, pilotUpgradeCheck } from './billing';
import { guardDestination, isInternalName, isSovereign } from './sovereign';

const H = 3_600_000;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');

/* ══ State ══════════════════════════════════════════════════════════════ */

export interface PlatformState {
  /** autonomy: the A2 starting levels the platform writes at L3 and the A3 grants graduations write (nothing else) */
  grants: AutonomyGrant[];
  /** graduation proposals: each proposed by one owner or admin, decided by a different one */
  proposals: GraduationProposal[];
  /** reviews of calls sampled (1 in 10) during a graduated grant's supervised period */
  sampleReviews?: SampleReview[];
  /**
   * The record per agent and tool ("agent|tool") as of `asOf`, for seeded organisations: the console holds a sample
   * of the chain, so the counts of the full history are kept here (modelled); calls after `asOf` are counted on read.
   */
  precedent?: Record<string, PrecedentBase>;
  counterparties: Counterparty[];
  crossOrg: CrossOrgReceipt[];
  disclosures: DisclosurePackage[];
  /** issuer-held salts for every committed field (never returned by the public portal) */
  disclosureSalts: Record<string, Record<string, string>>;
  packs: { id: PackId; installedAt: string; installedBy: string }[];
  erasures: ErasureRequest[];
  /** seq → frozen payload hash, for records whose salt was destroyed */
  erased: Record<number, string>;
  /** seq → frozen F12 (record id as sealed), for records whose salt was destroyed */
  erasedRecordIds?: Record<number, string>;
  /**
   * Random salt secrets, one per block of SALT_BLOCK records (block number → hex). Kept only in this deployment's
   * state and never exported. An erasure deletes its block's secret after copying the other records' salts to
   * `saltsKept`, so the erased record's salt can never be derived again.
   */
  saltSecrets?: Record<string, string>;
  /** seq → salt, for records whose block secret was deleted by an erasure of another record in the block */
  saltsKept?: Record<number, string>;
  escalation: EscalationPolicy[];
  reviews: ReviewRequest[];
  ceremonies: KeyCeremony[];
  updates: UpdateBundle[];
  identity: IdentityConfig;
  discovery: DiscoveryScan;
  profileRuns: ProfileRunResult[];
  links: ApprovalLinkToken[];
}

const short = (db: OrgDB) => db.org.slug.split('-')[0];
const p = (db: OrgDB, demoUserId: string) => personFor(db.org.id, demoUserId);
const s = (db: OrgDB, demoSlug: string) => flavourFor(db.org.id).slugMap[demoSlug] ?? demoSlug;
const ownerOf = (db: OrgDB) => p(db, 'u_ananya');

/** When the organisation reached `level` (or above), in ms; undefined if it has not. */
export function levelStart(db: OrgDB, level: LevelId): number | undefined {
  const h = db.org.levelHistory ?? [{ level: db.org.plan, from: db.org.createdAt }];
  const e = h.find((x) => levelRank(x.level) >= levelRank(level));
  return e ? new Date(e.from).getTime() : undefined;
}

/* ── Salts (Seal v6 F14 and F12) ── */

const SALT_BLOCK = 256;
const saltBlock = (seq: number) => String(Math.floor(seq / SALT_BLOCK));
let saltsChanged = false;

/** The salt of one sealed record, or undefined once an erasure destroyed it. Generated from a random block secret. */
function saltOf(st: PlatformState, seq: number): string | undefined {
  if (st.erased[seq]) return undefined;
  const kept = st.saltsKept?.[seq];
  if (kept) return kept;
  const secrets = (st.saltSecrets ??= {});
  const b = saltBlock(seq);
  if (!secrets[b]) { secrets[b] = randomHex(32); saltsChanged = true; }
  return deriveSalt(secrets[b], seq);
}

/**
 * Destroy one record's salt for good: the other records of its block keep their salts (copied out first), then the
 * block secret is deleted. Nothing — this deployment and Elan1 Govern included — can derive the salt again.
 */
function destroySalt(st: PlatformState, seq: number, existingSeqs: number[]) {
  const b = saltBlock(seq);
  const secret = st.saltSecrets?.[b];
  if (secret) {
    const kept = (st.saltsKept ??= {});
    for (const q of existingSeqs) if (q !== seq && saltBlock(q) === b && !st.erased[q] && !kept[q]) kept[q] = deriveSalt(secret, q);
    delete st.saltSecrets![b];
  }
  if (st.saltsKept) delete st.saltsKept[seq];
}

const levelOfReceipt = (db: OrgDB, r: Receipt): LevelId => levelAt(db.org.levelHistory, new Date(r.ts).getTime(), db.org.plan);
const isSealed = (db: OrgDB, r: Receipt) => { const t = levelStart(db, 'l2'); return t !== undefined && new Date(r.ts).getTime() >= t; };

/* ══ Seeding ════════════════════════════════════════════════════════════ */

export function seedPlatform(db: OrgDB): PlatformState {
  const level = levelOfOrg(db.org);
  const st: PlatformState = {
    grants: [], proposals: [], counterparties: [], crossOrg: [], disclosures: [], disclosureSalts: {}, packs: [], erasures: [], erased: {},
    escalation: defaultEscalation(db), reviews: [], ceremonies: [], updates: [], identity: defaultIdentity(db), discovery: defaultDiscovery(db), profileRuns: [], links: [],
  };
  db.platform = st;
  // dual control: the in-review invoice rulebook draft waits for a second person
  const inv = db.rulebooks.find((rb) => rb.slug === s(db, 'invoice-bot'));
  const draft = inv?.versions.find((v) => v.status === 'in_review');
  if (inv && draft) st.reviews.push({ id: `rv_${inv.slug}_${draft.version}`, kind: 'rulebook', rulebookId: inv.id, slug: inv.slug, version: draft.version, requestedBy: draft.createdBy, requestedAt: draft.createdAt, note: draft.note, status: 'pending', draftHash: draft.hash, rules: clone(draft.rules) });
  // packs
  const packIds: PackId[] = level === 'l2' ? ['ledger1'] : level === 'l3' ? ['ledger1', 'collect1'] : level === 'sovereign' ? ['ledger1', 'invoice1', 'collect1'] : [];
  const l2 = levelStart(db, 'l2');
  st.packs = packIds.map((id, i) => ({ id, installedAt: iso((l2 ?? Date.now()) + (i + 1) * 3 * D), installedBy: ownerOf(db) }));
  if (atLeast(level, 'l3')) seedL3(db, st);
  st.ceremonies = seedCeremonies(db);
  st.updates = seedUpdates(db);
  if (atLeast(level, 'l2')) seedErasures(db, st);
  return st;
}

/**
 * Platform state for an organisation created by sign-up: nothing seeded. Escalation policies for its five
 * approver groups, identity not configured, no discovery findings, no updates, ceremonies or counterparties.
 */
export function seedFreshPlatform(db: OrgDB): PlatformState {
  const base = defaultIdentity(db);
  const st: PlatformState = {
    grants: [], proposals: [], counterparties: [], crossOrg: [], disclosures: [], disclosureSalts: {}, packs: [], erasures: [], erased: {},
    escalation: defaultEscalation(db), reviews: [], ceremonies: [], updates: [],
    identity: {
      saml: { ...base.saml, enabled: false, enforced: false, idp: 'Not configured', metadataUrl: '', lastLoginAt: undefined },
      scim: { ...base.scim, enabled: false, lastSyncAt: undefined, usersProvisioned: 0, deprovisioned30d: 0 },
    },
    discovery: { orgId: db.org.id, scannedAt: db.org.createdAt, sources: [{ name: 'Network egress proxy', kind: 'network', scanned: false }], findings: [] },
    profileRuns: [], links: [],
  };
  db.platform = st;
  return st;
}

function defaultEscalation(db: OrgDB): EscalationPolicy[] {
  const g = (id: string) => groupFor(db.org.id, id)!;
  const row = (id: string, after: number, backup: string, enabled = true): EscalationPolicy => ({ groupId: id, groupName: g(id).name, afterMinutes: after, backupGroupId: backup, backupGroupName: g(backup).name, enabled, triggered: 0 });
  return [row('finance', 240, 'owners'), row('procurement', 240, 'finance'), row('engineering', 60, 'owners'), row('privacy', 480, 'owners'), row('owners', 120, 'finance', false)];
}

function defaultIdentity(db: OrgDB): IdentityConfig {
  const domain = db.org.domain ?? `${db.org.slug}.in`;
  const idp = db.org.id === 'org_demo' ? 'Okta' : db.org.id === 'org_deccan' ? 'Keycloak (on premises)' : 'Microsoft Entra ID';
  const base = db.org.deployment === 'sovereign' ? `https://govern.${domain}` : 'https://govern.elan1.ai';
  return {
    // not required at first: requiring SAML refuses passwords (break-glass owners excepted), so the demo's
    // password accounts keep working until an owner switches it on in Single sign-on
    saml: { enabled: true, enforced: false, idp, entityId: `${base}/saml/${db.org.slug}`, acsUrl: `${base}/saml/${db.org.slug}/acs`, metadataUrl: db.org.id === 'org_deccan' ? `https://sso.${domain}/realms/bank/protocol/saml/descriptor` : `https://login.${idp === 'Okta' ? 'okta.com' : 'microsoftonline.com'}/${db.org.slug}/saml/metadata`, certFingerprint: sha256Hex(`${db.org.id}:saml-cert`).slice(0, 40).replace(/(..)(?!$)/g, '$1:'), certExpiresAt: iso(Date.now() + 211 * D), jitProvisioning: false, lastLoginAt: iso(Date.now() - 40 * 60_000) },
    scim: { enabled: db.org.id !== 'org_demo', endpoint: `${base}/scim/v2/${db.org.slug}`, tokenPrefix: `scim_${sha256Hex(db.org.id).slice(0, 6)}`, lastSyncAt: db.org.id !== 'org_demo' ? iso(Date.now() - 52 * 60_000) : undefined, usersProvisioned: db.members.filter((m) => m.role !== 'auditor').length, deprovisioned30d: db.org.id === 'org_demo' ? 0 : 2, groupMap: [{ idpGroup: 'Govern-Owners', role: 'owner' }, { idpGroup: 'Govern-Admins', role: 'admin' }, { idpGroup: 'Govern-Approvers', role: 'approver' }, { idpGroup: 'Govern-Viewers', role: 'viewer' }] },
  };
}

function defaultDiscovery(db: OrgDB): DiscoveryScan {
  const now = Date.now();
  const f = (id: string, name: string, kind: DiscoveryFinding['kind'], vendor: string, source: string, evidence: string, daysFirst: number, calls: number, risk: DiscoveryFinding['risk'], status: DiscoveryFinding['status'] = 'unregistered'): DiscoveryFinding =>
    ({ id, name, kind, vendor, source, evidence, firstSeen: iso(now - daysFirst * D), lastSeen: iso(now - (id.length % 5 + 1) * H), callsSeen: calls, risk, status });
  const onPrem = db.org.deployment === 'sovereign';
  return {
    orgId: db.org.id, scannedAt: iso(now - 3 * H),
    sources: [
      { name: onPrem ? 'Data-centre egress firewall logs' : 'Network egress proxy', kind: 'network', scanned: true },
      { name: db.platform?.identity?.saml.idp ?? 'Identity provider app catalogue', kind: 'identity_provider', scanned: true },
      ...db.connectors.map((c) => ({ name: c.name, kind: (c.kind === 'mcp_upstream' ? 'mcp_server' : 'connector') as 'mcp_server' | 'connector', scanned: c.status !== 'disconnected' })),
    ],
    findings: [
      f('df_openai', 'OpenAI API key used by procurement-scripts', 'api_key', 'OpenAI', onPrem ? 'Data-centre egress firewall logs (api.openai.com, blocked)' : 'Network egress proxy (api.openai.com)', onPrem ? '212 blocked connection attempts in 7 days from host procurement-scripts-02; the key is not registered to any agent.' : '1,284 calls in 7 days from host procurement-scripts-02 with a key ending Q7aT; no agent is registered for it.', 19, onPrem ? 212 : 1284, 'high'),
      f('df_copilot', 'Copilot Studio bot "HR helpdesk"', 'bot', 'Microsoft', 'Identity provider app registrations', 'Published to Teams for 312 employees; reads the HR SharePoint site, including leave and salary letters.', 34, 4410, 'medium'),
      f('df_mcp', 'Unregistered MCP server analytics-mcp.internal', 'mcp_server', 'In-house', 'MCP servers seen by connected agents', `${s(db, 'devops-assistant')} listed 6 tools from it; it is not connected through Elan1 Govern, so its calls are not decided or recorded.`, 8, 57, 'medium'),
      f('df_chatgpt', 'ChatGPT Team workspace', 'saas_feature', 'OpenAI', 'Single sign-on app catalogue', '14 people signed in with company single sign-on in the last 30 days.', 61, 0, 'low'),
      f('df_zia', 'Zoho Books Zia (AI features) turned on', 'saas_feature', 'Zoho', 'Zoho Books connector settings', 'Zia suggestions are enabled for the finance organisation; they can draft entries for people to accept.', 120, 0, 'low'),
      f('df_grammarly', 'Grammarly with generative AI', 'browser_extension', 'Grammarly', 'Managed browser extension inventory', 'Installed on 41 managed browsers; sends text typed in web forms to the vendor.', 90, 0, 'low', 'dismissed'),
    ],
  };
}

function seedCeremonies(db: OrgDB): KeyCeremony[] {
  const holders = custodyHolders(db);
  const find = (action: string, near: number) => db.receipts.find((r) => r.action === action && Math.abs(new Date(r.ts).getTime() - near) < 10 * 60_000)?.seq;
  const out: KeyCeremony[] = [];
  const kid = (i: number) => db.keySeeds[i]?.kid;
  if (db.org.id === 'org_northbank') {
    const t = db.keySeeds[1]?.from ?? Date.now();
    out.push({ id: 'kc_nb_1', kind: 'generation', at: iso(t - 10 * 60_000), participants: [{ name: userName(ownerOf(db)), role: 'Approver (owner)' }, { name: 'elan1 operations', role: 'Operator' }], quorum: 'Not applicable — AWS KMS', outcome: 'completed', kidBefore: kid(0), kidAfter: kid(1), seq: find('key.rotated', t), log: [{ at: iso(t - 10 * 60_000), text: 'CreateKey (ECC_NIST_EDWARDS25519 stand-in: Ed25519) in ap-south-1' }, { at: iso(t - 8 * 60_000), text: `Alias alias/elan1/${db.org.slug}/signing created` }, { at: iso(t), text: 'Signing switched to the KMS key; the old key retired for signing, kept for verification' }] });
  }
  if (db.org.id === 'org_kaveri') {
    const t = db.keySeeds[2]?.from ?? Date.now();
    out.push({ id: 'kc_kh_1', kind: 'generation', at: iso(t - 2 * 60_000), participants: holders.slice(0, 4), quorum: '3 of 5', outcome: 'completed', kidBefore: kid(1), kidAfter: kid(2), hsmSerial: 'AWS CloudHSM cluster-7kq2v4m3 (hsm-2b5xq, hsm-9w1rd)', seq: find('key.ceremony', t - 2 * 60_000), log: [{ at: iso(t - 40 * 60_000), text: '4 of 5 key holders present in person; identities checked against the register' }, { at: iso(t - 30 * 60_000), text: 'Crypto officer quorum 3 of 5 reached' }, { at: iso(t - 12 * 60_000), text: 'Ed25519 key generated inside the HSM; not exportable' }, { at: iso(t - 2 * 60_000), text: 'Public key fingerprint read aloud and recorded by each holder' }, { at: iso(t), text: 'Signing switched to the HSM key' }] });
  }
  if (db.org.id === 'org_deccan') {
    const t0 = new Date(db.org.createdAt).getTime() + 3 * H;
    const t1 = db.keySeeds[1]?.from ?? Date.now();
    out.push({ id: 'kc_dc_1', kind: 'generation', at: iso(t0), participants: holders.slice(0, 5), quorum: '3 of 5', outcome: 'completed', kidAfter: kid(0), hsmSerial: 'Entrust nShield Connect XC 46-X7215 (BKC) · 46-X7218 (Navi Mumbai DR)', log: [{ at: iso(t0 - 50 * 60_000), text: 'Operator Card Set 3 of 5 created; cards issued to named holders' }, { at: iso(t0 - 20 * 60_000), text: 'Security world initialised on both HSMs' }, { at: iso(t0), text: 'Ed25519 signing key generated; fingerprint recorded in the ceremony minutes' }] });
    out.push({ id: 'kc_dc_2', kind: 'rotation', at: iso(t1 - 2 * 60_000), participants: holders.slice(1, 4), quorum: '3 of 5', outcome: 'completed', kidBefore: kid(0), kidAfter: kid(1), hsmSerial: 'Entrust nShield Connect XC 46-X7215', seq: find('key.ceremony', t1 - 2 * 60_000), log: [{ at: iso(t1 - 25 * 60_000), text: '3 of 5 card holders present' }, { at: iso(t1 - 2 * 60_000), text: 'New signing key generated; old key retired for signing' }, { at: iso(t1), text: 'Key rotation receipt written' }] });
  }
  return out;
}

function custodyHolders(db: OrgDB) {
  const ids = db.fresh
    ? db.members.filter((m) => m.status === 'active' && (m.role === 'owner' || m.role === 'admin')).map((m) => m.userId).slice(0, 5)
    : ['u_ananya', 'u_rahul', 'u_fatima', 'u_sanjay', 'u_venkat'].map((x) => p(db, x));
  return ids.map((id) => ({ name: userName(id), role: userById(id)?.title ?? 'Key holder' }));
}

let releaseKey: KeyPair | undefined;
const RELEASE_KEY = () => (releaseKey ??= keyFromSeed('elan1:release:2026', 'rel_2026_10'));
const ROGUE_KEY = () => keyFromSeed('unknown:release', 'rel_unknown');

function bundle(id: string, version: string, daysAgo: number, sizeMb: number, notes: string[], transport: UpdateBundle['transport'], key: KeyPair): UpdateBundle {
  const digest = sha256Hex(`elan1-govern-${version}.tar.zst`);
  return { id, version, publishedAt: iso(Date.now() - daysAgo * D), sizeMb, digest, kid: key.kid, fingerprint: key.fingerprint, sig: signDigest(digest, key), transport, status: 'available', notes };
}

function seedUpdates(db: OrgDB): UpdateBundle[] {
  const rel = RELEASE_KEY();
  if (db.org.deployment === 'sovereign') {
    const admin = p(db, 'u_rahul');
    const a = bundle('upd_2026_09_2', '2026.9.2', 44, 812, ['Decision service: quota windows per rulebook', 'Verifier: profile digest in the report'], 'air-gapped media', rel);
    Object.assign(a, { status: 'applied', verified: true, stagedAt: iso(Date.now() - 39 * D), stagedBy: admin, appliedAt: iso(Date.now() - 38 * D), appliedBy: admin });
    const b = bundle('upd_2026_10_1', '2026.10.1', 15, 826, ['Console: reviews queue', 'Anchoring: local TSA failover'], 'air-gapped media', rel);
    Object.assign(b, { status: 'applied', verified: true, stagedAt: iso(Date.now() - 13 * D), stagedBy: admin, appliedAt: iso(Date.now() - 12 * D), appliedBy: admin });
    const c = bundle('upd_2026_10_2h', '2026.10.2-hotfix', 6, 64, ['Arrived on removable media without a release note'], 'air-gapped media', ROGUE_KEY());
    Object.assign(c, { status: 'rejected', verified: false, stagedAt: iso(Date.now() - 6 * D), stagedBy: admin });
    const d = bundle('upd_2026_10_3', '2026.10.3', 2, 834, ['Decision service: autonomy A4 bounds per field', 'Verifier: six result codes in the console', 'Postgres 16.4 minor update'], 'air-gapped media', rel);
    return [d, c, b, a];
  }
  const a = bundle('upd_2026_10_3', '2026.10.3', 2, 834, ['Decision service: autonomy A4 bounds per field', 'Verifier: six result codes in the console'], 'managed rollout', rel);
  Object.assign(a, { status: 'applied', verified: true, appliedAt: iso(Date.now() - 2 * D + 3 * H), appliedBy: 'elan1 operations' });
  const b = bundle('upd_2026_10_1', '2026.10.1', 15, 826, ['Console: reviews queue'], 'managed rollout', rel);
  Object.assign(b, { status: 'applied', verified: true, appliedAt: iso(Date.now() - 15 * D + 3 * H), appliedBy: 'elan1 operations' });
  return [a, b];
}

function seedL3(db: OrgDB, st: PlatformState) {
  const l3 = levelStart(db, 'l3')!;
  const owner = ownerOf(db);
  seedAutonomy(db, st, l3, owner, p(db, 'u_rahul'));
  const payAgent = s(db, 'invoice-bot');

  // counterparties
  const nbFp = keyFromSeed('org_northbank:key:2', 'k_northbank_kms_2').fingerprint;
  const khFp = keyFromSeed('org_kaveri:key:3', 'k_kaveri_hsm_3').fingerprint;
  const dcFp = keyFromSeed('org_deccan:key:2', 'k_deccan_hsm_2').fingerprint;
  const since = (d: number) => iso(l3 + d * D);
  const cp = (id: string, name: string, kind: Counterparty['kind'], domain: string, seats: number, seatsUsed: number, verification: Counterparty['verification'], keyRoute: Counterparty['keyRoute'], d: number, contact: string, fp?: string, orgId?: string): Counterparty =>
    ({ id, name, kind, domain, orgId, seats, seatsUsed, verification, keyFingerprint: fp ?? (verification === 'verified' ? sha256Hex(`${domain}:key`).slice(0, 16) : undefined), keyRoute, since: since(d), contact, issued: 0, received: 0 });
  if (db.org.id === 'org_kaveri') {
    st.counterparties = [
      cp('cp_northbank', 'Northbank Industrial Ltd', 'vendor', 'northbank.co.in', 2, 2, 'verified', 'pinned', 2, 'Rohan Kapoor, CFO', nbFp, 'org_northbank'),
      cp('cp_star', 'Star Health and Allied Insurance', 'insurer', 'starhealth.in', 2, 1, 'verified', 'well_known', 4, 'Claims audit desk'),
      cp('cp_deccan', 'Deccan Cooperative Bank Ltd', 'lender', 'deccanbank.coop.in', 1, 1, 'verified', 'pinned', 6, 'Suresh Nambiar, CTO', dcFp, 'org_deccan'),
      cp('cp_nha', 'National Health Authority (ABDM)', 'regulator', 'abdm.gov.in', 1, 0, 'pending', 'trust_anchor', 20, 'Health information exchange team'),
      cp('cp_apollo', 'Apollo Diagnostics', 'vendor', 'apollodiagnostics.in', 1, 1, 'not_started', 'well_known', 25, 'Lab partnerships'),
    ];
  } else if (db.org.id === 'org_deccan') {
    st.counterparties = [
      cp('cp_rbi', 'Reserve Bank of India — Department of Supervision', 'regulator', 'rbi.org.in', 2, 2, 'verified', 'trust_anchor', 10, 'Off-site surveillance team'),
      cp('cp_nabard', 'NABARD', 'lender', 'nabard.org', 1, 1, 'verified', 'well_known', 18, 'Refinance desk'),
      cp('cp_kaveri', 'Kaveri Health Network', 'customer', 'kaverihealth.in', 1, 1, 'verified', 'pinned', 30, 'Dr Lakshmi Pillai, COO', khFp, 'org_kaveri'),
      cp('cp_iffco', 'Krishna Valley Sugar Co-operative', 'customer', 'krishnavalleysugar.coop', 1, 0, 'pending', 'well_known', 60, 'Accounts office'),
    ];
  }
  // receipts this organisation issues (own chain) and receives (resolved lazily from the issuer)
  const mine = (pred: (r: Receipt) => boolean, n: number) => db.receipts.filter(pred).slice(-n);
  const key = currentKey(db);
  const issuedTo = (cpId: string, r: Receipt, summary: string, withDisclosure: number) => {
    const c = st.counterparties.find((x) => x.id === cpId)!;
    const pkg = withDisclosure ? makeDisclosure(db, st, r, ['decision', 'tool', 'amount', 'approval', 'ts', 'rule_id'].slice(0, withDisclosure), `ar-org:${c.domain}`, c.id, owner, new Date(r.ts).getTime() + H) : undefined;
    st.crossOrg.push(crossFromOwn(db, c, r, summary, pkg?.id, pkg?.token, key));
    c.issued++;
  };
  if (db.org.id === 'org_kaveri') {
    const claims = mine((r) => r.agent === s(db, 'expense-auditor') && r.kind === 'decision' && r.decision === 'allow', 2);
    claims.forEach((r, i) => issuedTo('cp_star', r, `Claim review ${String(r.args_summary?.claim ?? r.args_summary?.month ?? '')} — decided under the claims rulebook`.trim(), i === 0 ? 3 : 0));
    const pay = mine((r) => r.agent === payAgent && r.tool === 'zoho_books.record_payment' && r.kind === 'decision', 1);
    pay.forEach((r) => issuedTo('cp_northbank', r, `Payment ${r.args_summary?.bill ?? ''} recorded under supplier-payments rules`, 4));
    // to Deccan (its lender, also in this console): the receipt Deccan holds as received, linked both ways
    const toLender = mine((r) => r.kind === 'decision' && r.decision === 'allow' && (r.tool === 'zoho_books.create_bill' || r.tool === 'bank.get_balance' || r.tool === 'zoho_books.list_invoices'), 1);
    toLender.forEach((r) => issuedTo('cp_deccan', r, `Supporting record for the working-capital line: ${r.tool} under the supplier-payments rulebook`, 3));
    st.crossOrg.push(pendingReceived('cp_northbank', 'Northbank Industrial Ltd', 'org_northbank', 0), pendingReceived('cp_northbank', 'Northbank Industrial Ltd', 'org_northbank', 1), pendingReceived('cp_deccan', 'Deccan Cooperative Bank Ltd', 'org_deccan', 0));
  } else if (db.org.id === 'org_deccan') {
    const loans = mine((r) => r.kind === 'approval' && r.approval?.status === 'approved', 2);
    loans.forEach((r, i) => issuedTo('cp_rbi', r, `Approved held action ${r.tool ?? ''} — named approver on record`, i === 0 ? 4 : 0));
    const k = mine((r) => r.kind === 'decision' && r.decision === 'allow' && r.tool === 'bank.get_balance', 1);
    k.forEach((r) => issuedTo('cp_kaveri', r, 'Balance confirmation for the working-capital line', 3));
    st.crossOrg.push(pendingReceived('cp_kaveri', 'Kaveri Health Network', 'org_kaveri', 0));
  }
}

function pendingReceived(cpId: string, name: string, issuerOrgId: string, index: number): CrossOrgReceipt {
  return { id: `xr_${issuerOrgId}_${index}`, direction: 'received', counterpartyId: cpId, counterpartyName: name, issuerOrgId, issuerName: name, audience: '', seq: 0, receiptHash: '', kid: '', publicKey: '', sig: '', issuedAt: '', expiresAt: '', nonce: '', summary: 'Awaiting first verification', verification: { state: 'pending', steps: [] } };
}

function currentKey(db: OrgDB) {
  return db.keys[db.keys.length - 1].key;
}

function keyForKid(db: OrgDB, kid: string) {
  return db.keys.find((k) => k.key.kid === kid)?.key;
}

function crossFromOwn(db: OrgDB, c: Counterparty, r: Receipt, summary: string, disclosureId: string | undefined, token: string | undefined, _key: KeyPair): CrossOrgReceipt {
  const t = new Date(r.ts).getTime();
  const issuedAt = Math.max(t, Math.min(t + H, Date.now() - 10 * 60_000)); // an hour after the decision, never in the future
  return {
    id: `xi_${db.org.id}_${r.seq}_${c.id}`, direction: 'issued', counterpartyId: c.id, counterpartyName: c.name, issuerOrgId: db.org.id, issuerName: db.org.name, audience: `ar-org:${c.domain}`,
    seq: r.seq, receiptHash: r.hash, kid: r.kid, publicKey: db.publicKeys[r.kid], sig: r.sig, issuedAt: iso(issuedAt), expiresAt: iso(Math.max(issuedAt, Date.now()) + 7 * D), nonce: sha256Hex(`${r.hash}:${c.id}`).slice(0, 16), summary,
    disclosureId, token, verification: { state: 'verified', checkedAt: iso(issuedAt + 20 * 60_000), steps: [{ label: 'Delivered', state: 'pass', detail: `Delivered to ${c.name}; their verifier reported a pass.` }] },
  };
}

function seedErasures(db: OrgDB, st: PlatformState) {
  const collections = s(db, 'collections-agent');
  const domains: Record<string, number> = {};
  db.receipts.filter((r) => r.agent === collections && typeof r.args_summary?.to_domain === 'string' && isSealed(db, r)).forEach((r) => { const d = String(r.args_summary!.to_domain); domains[d] = (domains[d] ?? 0) + 1; });
  const ranked = Object.entries(domains).sort((a, b) => b[1] - a[1]).map(([d]) => d);
  const affected = (needle: string) => db.receipts.filter((r) => isSealed(db, r) && JSON.stringify(r.args_summary ?? {}).toLowerCase().includes(needle)).map((r) => r.seq);
  const owner = ownerOf(db);
  const dpo = p(db, 'u_fatima');
  const admin = p(db, 'u_rahul');
  const mk = (i: number, needle: string, ref: string, reason: string, hoursAgo: number, approvals: string[], status: ErasureRequest['status']): ErasureRequest => {
    const seqs = affected(needle);
    const at = Date.now() - hoursAgo * H;
    return { id: `er_${db.org.id}_${i}`, subjectRef: ref, subjectHash: sha256Hex(needle), reason, requestedBy: dpo, requestedAt: iso(at), dueAt: iso(at + 72 * H), affectedSeqs: seqs, affected: seqs.length, required: 2, approvals: approvals.map((u, j) => ({ userId: u, at: iso(at + (j + 1) * 2 * H) })), status };
  };
  if (ranked[0]) {
    if (db.org.id === 'org_kaveri') {
      const e = mk(1, ranked[0], 'DP-2026-0141', 'Data principal asked to erase their contact details (DPDP Section 12).', 60, [owner, admin], 'approved');
      st.erasures.push(e);
      executeErasureOn(db, st, e, owner, Date.now() - 50 * H, false);
      if (ranked[1]) st.erasures.push(mk(2, ranked[1], 'DP-2026-0157', 'Withdrawal of consent after account closure.', 20, [owner], 'awaiting_approval'));
    } else if (db.org.id === 'org_deccan') {
      st.erasures.push(mk(1, ranked[0], 'DP-2026-0093', 'Borrower closed the loan account and asked for erasure of contact data.', 30, [owner, admin], 'approved'));
    } else {
      st.erasures.push(mk(1, ranked[0], 'DP-2026-0212', 'A customer contact asked to erase their details (DPDP Section 12).', 10, [], 'awaiting_approval'));
    }
  }
}

/* ══ Seal v6 ════════════════════════════════════════════════════════════ */

interface SealCacheEntry { lastSeq: number; prevDigest?: string; versions: Map<string, number>; recs: Map<number, { fields: ReturnType<typeof sealFields>; digest: string; level: LevelId }>; sigs: Map<number, string> }
const sealCache = new Map<string, SealCacheEntry>();

const lexiconHash = (orgId: string) => sha256Hex(canonical({ lexicon: 'elan1.lexicon.v1', org: orgId, fields: SEAL_FIELDS.map((f) => f.name) }));

/**
 * F11 as sealed: the level of the autonomy grant in force, or A0 when none is (the specification's value for a missing
 * grant: "A0 Observe (no grant)"). Before L3 there is no grant at all — earned autonomy starts at L3, every write type
 * at A2, and A3 only by graduation — so every record before the L3 boundary seals A0. Seals are derived from the
 * receipts, never stored, so every seal and bundle is built (and verifies) with this value.
 */
function autonomyAt(db: OrgDB, r: Receipt): string {
  if (r.kind !== 'decision' && r.kind !== 'outcome') return 'A0';
  if (typeof r.details?.autonomy === 'string') return r.details.autonomy;
  const t = new Date(r.ts).getTime();
  const l3 = levelStart(db, 'l3');
  if (l3 === undefined || t < l3) return 'A0';
  return grantFor(db.platform.grants, r.agent ?? '', r.tool ?? '', t)?.level ?? 'A0';
}

/** Build (incrementally) the Seal v6 fields and digests for every sealed receipt. Signatures are lazy. */
export function ensureSeals(db: OrgDB): SealCacheEntry {
  let c = sealCache.get(db.org.id);
  const start = levelStart(db, 'l2');
  if (!c) { c = { lastSeq: -1, versions: new Map(), recs: new Map(), sigs: new Map() }; sealCache.set(db.org.id, c); }
  if (start === undefined) return c;
  const lex = lexiconHash(db.org.id);
  for (const r of db.receipts) {
    if (r.seq <= c.lastSeq) continue;
    c.lastSeq = r.seq;
    if (new Date(r.ts).getTime() < start) { c.prevDigest = r.hash; continue; }
    const erased = db.platform.erased[r.seq];
    const salt = erased ? undefined : saltOf(db.platform, r.seq);
    // F13 counts writes per F12 as sealed, so an erasure (which freezes F12) never shifts a later record's version
    const rid = (erased ? db.platform.erasedRecordIds?.[r.seq] : undefined) ?? sealedRecordId(r, salt);
    const ver = (c.versions.get(rid) ?? 0) + 1;
    c.versions.set(rid, ver);
    const fields = sealFields(r, { prevDigest: c.prevDigest ?? r.prev_hash, autonomy: autonomyAt(db, r), recordVersion: ver, salt, lexiconHash: lex, level: levelOfReceipt(db, r), frozenRecordId: erased ? rid : undefined }, erased);
    const digest = digestOfFields(fields);
    c.recs.set(r.seq, { fields, digest, level: levelOfReceipt(db, r) });
    c.prevDigest = digest;
  }
  // a new block secret must survive a reload, or every later seal digest would change
  if (saltsChanged) { saltsChanged = false; persist(db.org.id); }
  return c;
}

/** The Seal v6 record for one receipt (signed with the key that signed the receipt), or undefined before the L2 boundary. */
export function sealOf(db: OrgDB, seq: number): SealRecord | undefined {
  const c = ensureSeals(db);
  const rec = c.recs.get(seq);
  const r = db.receipts.find((x) => x.seq === seq);
  if (!rec || !r) return undefined;
  const key = keyForKid(db, r.kid) ?? currentKey(db);
  let sig = c.sigs.get(seq);
  if (!sig) { sig = signDigest(rec.digest, key); c.sigs.set(seq, sig); }
  return { format: 'elan1.seal.v6', seq, receiptHash: r.hash, level: rec.level, fields: rec.fields, preimageBytes: sealPreimage(fieldValues(rec.fields)).length, digest: rec.digest, kid: key.kid, sig, ...(db.platform.erased[seq] ? { payloadUnbound: true } : {}) };
}

export function sealView(orgId: string, seq: number) {
  const db = getDB(orgId);
  const r = db.receipts.find((x) => x.seq === seq);
  if (!r) throw new Error(`No receipt #${seq} in this organisation.`);
  const seal = sealOf(db, seq);
  const l2 = levelStart(db, 'l2');
  if (!seal) {
    return { sealed: false as const, receipt: r, level: levelOfReceipt(db, r), boundary: l2 ? iso(l2) : undefined, reason: l2 ? `This receipt is from before the L2 boundary (${new Date(l2).toLocaleDateString('en-IN')}). It is sealed in a hash chain by Elan1 Govern (L1), with no Seal v6 record.` : 'This organisation is on L1 Guarded. Records are sealed in a hash chain by Elan1 Govern; Seal v6 starts at L2 Attested.', fieldsDoc: SEAL_FIELDS };
  }
  const check = verifySeal(seal, db.publicKeys[seal.kid], r);
  return { sealed: true as const, receipt: r, seal, check, fieldsDoc: SEAL_FIELDS, payloadUnbound: !!seal.payloadUnbound, level: seal.level };
}

let vectorsCache: TestVectorSuite | undefined;
export function testVectors(): TestVectorSuite {
  vectorsCache ??= runTestVectors();
  return vectorsCache;
}

/* ══ Anchoring ══════════════════════════════════════════════════════════ */

const tsaKeys = new Map<string, KeyPair>();
function tsaKey(id: string): KeyPair {
  let k = tsaKeys.get(id);
  if (!k) { k = keyFromSeed(`tsa:${id}`, id); tsaKeys.set(id, k); }
  return k;
}

/**
 * The two timestamp authorities that stamp a batch closing at `at` (ms; default now). Hosted levels use
 * eMudhra and DigiCert; from the Sovereign boundary the organisation's own two local TSAs take over.
 * Batches stamped before the boundary keep the hosted authorities, so they keep verifying after an upgrade.
 */
export function tsaAuthorities(db: OrgDB, at?: number): TsaAuthority[] {
  const mk = (id: string, name: string, scope: TsaAuthority['scope'], url: string, oid: string): TsaAuthority => {
    const k = tsaKey(id);
    return { id, name, scope, url, policyOid: oid, publicKey: k.publicKeyHex, fingerprint: k.fingerprint, status: 'operational' };
  };
  const sovFrom = db.org.deployment === 'sovereign' ? levelStart(db, 'sovereign') : undefined;
  if (db.org.deployment === 'sovereign' && (at === undefined || sovFrom === undefined || at >= sovFrom)) {
    const dom = db.org.domain ?? 'example.in';
    const site = sovereignSites(db);
    return [mk(`tsa_${short(db)}_bkc`, `${db.org.name.split(' ')[0]} TSA 1 (${site.primaryLong})`, 'Local', `http://tsa1.${dom}/rfc3161`, '1.3.6.1.4.1.61234.1.1'), mk(`tsa_${short(db)}_dr`, `${db.org.name.split(' ')[0]} TSA 2 (${site.drLong})`, 'Local', `http://tsa2.${dom}/rfc3161`, '1.3.6.1.4.1.61234.1.2')];
  }
  return [mk('tsa_emudhra', 'eMudhra TSA (India)', 'India', 'http://timestamp.emudhra.com', '1.3.6.1.4.1.37442.1.1'), mk('tsa_digicert', 'DigiCert Timestamp Authority (global)', 'Global', 'http://timestamp.digicert.com', '2.16.840.1.114412.7.1')];
}

/** The customer's two sites for a Sovereign deployment: Deccan's named data centres, or a neutral primary and DR site for an organisation that moved to Sovereign by upgrade. */
function sovereignSites(db: OrgDB): { primary: string; dr: string; primaryLong: string; drLong: string } {
  return db.org.id === 'org_deccan'
    ? { primary: 'BKC', dr: 'Navi Mumbai DR', primaryLong: 'BKC data centre', drLong: 'Navi Mumbai DR site' }
    : { primary: 'Primary site', dr: 'DR site', primaryLong: 'primary data centre', drLong: 'DR site' };
}

/** Authorities that stamped this organisation's batches before the Sovereign boundary (empty when none). */
export function previousTsaAuthorities(db: OrgDB): TsaAuthority[] {
  const sovFrom = db.org.deployment === 'sovereign' ? levelStart(db, 'sovereign') : undefined;
  const l2From = levelStart(db, 'l2');
  if (sovFrom === undefined || l2From === undefined || l2From >= sovFrom) return [];
  return tsaAuthorities(db, sovFrom - 1);
}

const WINDOW = 15 * 60_000;
type FullBatch = AnchorBatch & { leaves: string[] };
const batchCache = new Map<string, Map<string, FullBatch>>();

/** The degraded anchoring period: yesterday 09:14–11:52 IST, while the first authority was unreachable. */
function degradedWindow(): { from: number; to: number } {
  const d = new Date(Date.now() - D + 5.5 * H);
  d.setUTCHours(9, 14, 0, 0);
  const from = d.getTime() - 5.5 * H;
  return { from, to: from + (2 * 60 + 38) * 60_000 };
}

function token(a: TsaAuthority, root: string, windowEnd: number, delaySeconds: number, late: boolean): TimestampToken {
  const genTime = iso(windowEnd + delaySeconds * 1000);
  const serial = sha256Hex(`${a.id}:${root}`).slice(0, 20);
  const t = { tsaId: a.id, imprint: root, genTime, serial, policyOid: a.policyOid };
  return { ...t, tsaName: a.name, status: late ? 'granted_late' : 'granted', sig: signText(tokenMessage(t), tsaKey(a.id)), delaySeconds };
}

/** Every completed 15-minute batch of sealed receipts, oldest first (cached; timestamp tokens are real signatures). */
export function anchorBatches(db: OrgDB): FullBatch[] {
  const start = levelStart(db, 'l2');
  if (start === undefined) return [];
  let cache = batchCache.get(db.org.id);
  if (!cache) { cache = new Map(); batchCache.set(db.org.id, cache); }
  const now = Date.now();
  const groups = new Map<number, Receipt[]>();
  for (const r of db.receipts) {
    const t = new Date(r.ts).getTime();
    if (t < start) continue;
    const w = Math.floor(t / WINDOW);
    (groups.get(w) ?? groups.set(w, []).get(w)!).push(r);
  }
  const deg = degradedWindow();
  const out: FullBatch[] = [];
  for (const [w, rs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const windowEnd = (w + 1) * WINDOW;
    if (windowEnd + 60_000 > now) continue; // the open window is the unanchored tail
    const id = `mb_${short(db)}_${w}`;
    const hit = cache.get(id);
    if (hit && hit.count === rs.length) { out.push(hit); continue; }
    const leaves = rs.map((r) => r.hash);
    const root = merkleRoot(leaves);
    const late = windowEnd > deg.from && windowEnd - WINDOW < deg.to;
    const base = (parseInt(root.slice(0, 4), 16) % 220) + 20;
    const auth = tsaAuthorities(db, windowEnd);
    const tokens = auth.map((a, i) => (late && i === 0 ? token(a, root, windowEnd, Math.max(0, Math.round((deg.to - windowEnd) / 1000)) + 180 + i * 40, true) : token(a, root, windowEnd, base + i * 7, false)));
    const b: FullBatch = { id, windowStart: iso(windowEnd - WINDOW), windowEnd: iso(windowEnd), firstSeq: rs[0].seq, lastSeq: rs[rs.length - 1].seq, count: rs.length, root, tokens, status: late ? 'late' : 'anchored', leaves };
    cache.set(id, b);
    out.push(b);
  }
  return out;
}

/** The action of an "Anchor now" receipt (Assurance › Timestamps). */
export const ON_DEMAND_ANCHOR = 'anchor.on_demand';
export type OnDemandBatch = FullBatch & { onDemand: true; recordedSeq: number };

/**
 * Batches timestamped on demand ("Anchor now"), read back from their anchor.on_demand receipts, oldest first. Each is
 * a Merkle batch with two RFC 3161 tokens over a contiguous run of records, like a regular batch, so an export carries
 * it in anchors.json and the verifier checks it the same way. A receipt whose root does not recompute from the
 * contiguous run it names (one written before runs were made contiguous) is left out, never shipped to fail.
 */
export function onDemandAnchorBatches(db: OrgDB): OnDemandBatch[] {
  const out: OnDemandBatch[] = [];
  for (const r of db.receipts) {
    if (r.action !== ON_DEMAND_ANCHOR || !r.details) continue;
    const x = r.details;
    const firstSeq = Number(x.first_seq);
    const lastSeq = Number(x.last_seq);
    if (!Number.isFinite(firstSeq) || !Number.isFinite(lastSeq) || lastSeq < firstSeq) continue;
    const rs = db.receipts.filter((q) => q.seq >= firstSeq && q.seq <= lastSeq);
    if (rs.length !== lastSeq - firstSeq + 1) continue;
    const leaves = rs.map((q) => q.hash);
    const root = String(x.root);
    if (merkleRoot(leaves) !== root) continue;
    const tokens: TimestampToken[] = [];
    for (let i = 1; i <= 3; i++) {
      if (typeof x[`tsa_${i}_id`] !== 'string') continue;
      tokens.push({
        tsaId: String(x[`tsa_${i}_id`]), tsaName: String(x[`tsa_${i}_name`]), genTime: String(x[`tsa_${i}_gen`]), serial: String(x[`tsa_${i}_serial`]),
        policyOid: String(x[`tsa_${i}_policy`]), status: 'granted', imprint: root, sig: String(x[`tsa_${i}_sig`]), delaySeconds: Number(x[`tsa_${i}_delay`] ?? 0),
      });
    }
    out.push({ id: `od_${r.seq}`, windowStart: String(x.window_start ?? r.ts), windowEnd: r.ts, firstSeq, lastSeq, count: rs.length, root, tokens, status: 'anchored', leaves, onDemand: true, recordedSeq: r.seq });
  }
  return out;
}

/** The last record in any timestamped batch, regular or on demand (undefined when none). */
export function lastTimestampedSeq(db: OrgDB): number | undefined {
  const regular = anchorBatches(db);
  const seqs = [...regular.map((b) => b.lastSeq), ...onDemandAnchorBatches(db).map((b) => b.lastSeq)];
  return seqs.length ? Math.max(...seqs) : undefined;
}

/**
 * "Anchor now": close the open 15-minute window early. Owners and admins only (checked here, not just on screen),
 * from L2. Builds the RFC 6962 root over every sealed record after the last timestamped one — one contiguous run,
 * an earlier anchor.on_demand receipt included — asks both authorities for a token over it, and records the batch as
 * an anchor.on_demand receipt. Both must answer with their registered key, or nothing is recorded.
 */
export function anchorOnDemand(orgId: string, userId: string): Omit<OnDemandBatch, 'leaves'> {
  const db = getDB(orgId);
  requireLevel(db, 'l2', 'Timestamping on demand');
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins anchor on demand; your role cannot.');
  const start = levelStart(db, 'l2');
  if (start === undefined) throw new Error('Records are timestamped from the move to L2.');
  const covered = lastTimestampedSeq(db) ?? 0;
  const tail = db.receipts.filter((r) => r.seq > covered && new Date(r.ts).getTime() >= start);
  if (!tail.some((r) => r.action !== ON_DEMAND_ANCHOR)) throw new Error('Every sealed record is already in a timestamped batch. There is nothing to anchor.');
  const auth = tsaAuthorities(db);
  if (auth.length < 2) throw new Error('Two timestamp authorities are needed; only one is configured.');
  const root = merkleRoot(tail.map((r) => r.hash));
  const now = Date.now();
  const details: Record<string, string | number | boolean> = {
    first_seq: tail[0].seq, last_seq: tail[tail.length - 1].seq, count: tail.length, root, window_start: iso(Math.floor(now / WINDOW) * WINDOW),
  };
  auth.forEach((a, i) => {
    const key = tsaKey(a.id);
    if (key.publicKeyHex !== a.publicKey) throw new Error(`${a.name} did not answer with its registered key. Nothing was anchored.`);
    const delay = 2 + i * 3;
    const t = { tsaId: a.id, imprint: root, genTime: iso(now + delay * 1000), serial: sha256Hex(`${a.id}:${root}:od`).slice(0, 20), policyOid: a.policyOid };
    const k = `tsa_${i + 1}`;
    Object.assign(details, { [`${k}_id`]: a.id, [`${k}_name`]: a.name, [`${k}_gen`]: t.genTime, [`${k}_serial`]: t.serial, [`${k}_policy`]: t.policyOid, [`${k}_sig`]: signText(tokenMessage(t), key), [`${k}_delay`]: delay });
  });
  const rec = append(db, { kind: 'admin', actor: userId, action: ON_DEMAND_ANCHOR, details });
  touch(orgId, 'anchor');
  const b = onDemandAnchorBatches(db).find((x) => x.recordedSeq === rec.seq);
  if (!b) throw new Error('The batch was recorded but does not read back. Reload the page.');
  const { leaves: _l, ...view } = b;
  return view;
}

export function anchorsView(orgId: string, limit = 60): AnchorsView {
  const db = getDB(orgId);
  const start = levelStart(db, 'l2');
  const head = db.receipts[db.receipts.length - 1];
  if (start === undefined) {
    return { orgId, enabled: false, level: levelOfOrg(db.org), authorities: tsaAuthorities(db), batches: [], totals: { batches: 0, anchoredRecords: 0, unanchoredTail: 0, headSeq: head.seq, withinTargetPct: 0, targetMinutes: 15 }, incidents: [] };
  }
  const all = anchorBatches(db);
  const lastAnchored = all[all.length - 1]?.lastSeq;
  const sealed = db.receipts.filter((r) => new Date(r.ts).getTime() >= start);
  const unanchored = sealed.filter((r) => lastAnchored === undefined || r.seq > lastAnchored).length;
  const within = all.filter((b) => b.tokens.every((t) => t.delaySeconds <= 15 * 60)).length;
  const deg = degradedWindow();
  const degRecords = sealed.filter((r) => { const t = new Date(r.ts).getTime(); return t >= deg.from && t < deg.to; }).length;
  const t09 = new Date(deg.from + 5.5 * H).toISOString().slice(11, 16);
  const t11 = new Date(deg.to + 5.5 * H).toISOString().slice(11, 16);
  const incidents: AnchorIncident[] = deg.from >= start ? [{ id: `ai_${short(db)}_deg`, from: iso(deg.from), to: iso(deg.to), records: degRecords, status: 'recovered', summary: `${degRecords} records unanchored since ${t09} IST while ${tsaAuthorities(db, deg.from)[0].name} was unreachable. Both timestamps were obtained by ${t11} IST; the second authority stayed within 15 minutes throughout. No record was lost.` }] : [];
  return {
    orgId, enabled: true, level: levelOfOrg(db.org), since: iso(start), authorities: tsaAuthorities(db), previousAuthorities: previousTsaAuthorities(db),
    batches: all.slice(-limit).reverse().map(({ leaves: _l, ...b }) => b),
    totals: { batches: all.length, anchoredRecords: all.reduce((n, b) => n + b.count, 0), unanchoredTail: unanchored, lastAnchoredSeq: lastAnchored, headSeq: head.seq, withinTargetPct: all.length ? within / all.length : 1, targetMinutes: 15 },
    incidents,
  };
}

export function inclusionProof(orgId: string, seq: number): InclusionProof {
  const db = getDB(orgId);
  const r = db.receipts.find((x) => x.seq === seq);
  if (!r) throw new Error(`No receipt #${seq} in this organisation.`);
  if (!isSealed(db, r)) throw new Error('This receipt is from before the L2 boundary: it is sealed in a hash chain by Elan1 Govern, not timestamped.');
  const b = anchorBatches(db).find((x) => seq >= x.firstSeq && seq <= x.lastSeq);
  if (!b) throw new Error('This receipt is in the newest batch, which is not yet timestamped (the unanchored tail). Try again in a few minutes.');
  const index = b.leaves.indexOf(r.hash);
  const path = inclusionPath(b.leaves, index);
  return { seq, receiptHash: r.hash, leafHash: sha256Hex(r.hash), leafIndex: index, treeSize: b.leaves.length, batchId: b.id, root: b.root, path, tokens: b.tokens, verified: verifyInclusion(r.hash, path, b.root) };
}

/* ══ Levels and upgrade ═════════════════════════════════════════════════ */

export function levelState(orgId: string): LevelState {
  const db = getDB(orgId);
  const level = levelOfOrg(db.org);
  const history = db.org.levelHistory ?? [{ level, from: db.org.createdAt }];
  const first = db.receipts[0];
  const boundaries: LevelBoundary[] = history.slice(1).map((h, i) => {
    const at = new Date(h.from).getTime();
    const firstAfter = db.receipts.find((r) => new Date(r.ts).getTime() >= at);
    const before = db.receipts.filter((r) => new Date(r.ts).getTime() < at).length;
    return { from: history[i].level, to: h.level, at: h.from, firstSeq: firstAfter?.seq, recordsBefore: before, recordsAfter: db.receipts.length - before, beforeWindow: !!first && at < new Date(first.ts).getTime() };
  });
  return {
    orgId, level, plan: PLANS[level], deployment: db.org.deployment ?? 'hosted', residency: db.org.residency ?? 'ap-south-1 Mumbai', history, since: history[history.length - 1].from, boundaries,
    capabilities: CAPABILITIES.map((c) => ({ ...c, enabled: levelRank(level) >= levelRank(c.level), since: levelStart(db, c.level) !== undefined ? iso(levelStart(db, c.level)!) : undefined })),
    next: nextLevel(level),
  };
}

const UPGRADE_STEPS: Record<Exclude<LevelId, 'l1'>, UpgradeStep[]> = {
  l2: [
    { id: 'kms', label: 'Move signing into AWS KMS', detail: 'A new Ed25519 signing key is created in AWS KMS in ap-south-1. The old key is retired for signing and kept for verification.', owner: 'elan1' },
    { id: 'tsa', label: 'Timestamp every batch with two authorities', detail: 'Receipts are batched every 15 minutes into a Merkle tree; eMudhra (India) and DigiCert (global) timestamp each root.', owner: 'elan1' },
    { id: 'worm', label: 'Write-once storage', detail: 'Receipts and bundles are kept under S3 Object Lock in compliance mode for 8 years.', owner: 'elan1' },
    { id: 'seal', label: 'Seal v6 from the boundary', detail: 'Every record from the upgrade onwards is sealed with 16 frozen fields. Earlier records stay L1 and keep verifying.', owner: 'elan1' },
    { id: 'dual', label: 'Name a second reviewer', detail: 'From the boundary a rulebook is published only after a different person approves its review.', owner: 'customer' },
    { id: 'profile', label: 'Choose verifier profiles and packs', detail: 'Pick the regimes your auditor checks against (MCA audit trail, GST, RBI, EU AI Act, DPDP, ISO 42001).', owner: 'customer' },
  ],
  l3: [
    { id: 'ceremony', label: 'Key ceremony in your HSM', detail: 'Your key holders generate the signing key in your CloudHSM, Thales Luna or Entrust nShield with a 3 of 5 quorum. Elan1 Govern never holds the key.', owner: 'both' },
    { id: 'grants', label: 'Earned autonomy', detail: 'Every agent write type starts at A2 Propose: a person approves each write. No one sets a level directly; an agent reaches A3 for a write type only by a graduation one owner or admin proposes and a different one approves (at least 90 days, 200 records and 100 approvals), followed by a 30-day supervised period. A4 and A5 are not yet available.', owner: 'customer' },
    { id: 'counterparties', label: 'Register counterparties', detail: 'Add the customers, vendors, insurers, lenders and regulators who will verify your receipts. Each holds a seat (₹45,000 a year).', owner: 'customer' },
    { id: 'disclosure', label: 'Selective disclosure', detail: 'Share a receipt revealing only the fields a counterparty needs; the rest stay committed.', owner: 'customer' },
  ],
  sovereign: [
    { id: 'infra', label: 'Provision your infrastructure', detail: 'Kubernetes (3 control-plane and 4 worker nodes), PostgreSQL 16 with row-level security, OpenBao for secrets, and object-lock storage (Ceph, SeaweedFS or Garage).', owner: 'customer' },
    { id: 'hsm', label: 'Connect your HSM', detail: 'A key ceremony in your on-premises HSM creates the signing key.', owner: 'both' },
    { id: 'tsa', label: 'Install two local timestamp authorities', detail: 'Two TSAs inside your network timestamp every batch.', owner: 'customer' },
    { id: 'bundle', label: 'Import the signed install bundle', detail: 'From air-gapped media. Its Ed25519 signature is checked against the elan1 release key before anything is installed.', owner: 'both' },
    { id: 'egress', label: 'Deny all egress', detail: 'No telemetry leaves your network. The allow-list starts empty.', owner: 'customer' },
  ],
};

export function upgradePlan(orgId: string, to: LevelId, userId?: string): UpgradePlan {
  const db = getDB(orgId);
  const from = levelOfOrg(db.org);
  let whyNot: string | undefined;
  if (levelRank(to) <= levelRank(from)) whyNot = levelRank(to) === levelRank(from) ? `This organisation is already on ${LEVEL_INFO[to].label}.` : 'Moving down a level is not offered: records already sealed at a level stay at that level.';
  else if (userId && memberRole(orgId, userId) !== 'owner') whyNot = 'Only an owner of this organisation can change its level.';
  else if (needsHsmCeremony(from, to) && custodyHolders(db).length < 3) whyNot = `A key ceremony needs 3 key holders present, and this organisation has ${custodyHolders(db).length}. Add at least 3 owners or admins first (Agents › People and roles), then upgrade.`;
  // the pilot covers Guarded only: a stopped pilot blocks the upgrade; a running one ends at the boundary (mock/billing.ts)
  const pilot = levelRank(to) > levelRank(from) ? pilotUpgradeCheck(db) : {};
  if (!whyNot && pilot.whyNot) whyNot = pilot.whyNot;
  const adds: Capability[] = capabilitiesAdded(from, to);
  const steps = (['l2', 'l3', 'sovereign'] as const).filter((l) => levelRank(l) > levelRank(from) && levelRank(l) <= levelRank(to)).flatMap((l) => UPGRADE_STEPS[l]);
  return {
    orgId, from, to, allowed: !whyNot, whyNot, adds, priceBefore: PLANS[from], priceAfter: PLANS[to], floorDifference: PLANS[to].floorPerYear - PLANS[from].floorPerYear, steps,
    boundaryNote: `The boundary is the moment you confirm. Records before it stay ${LEVEL_INFO[from].label}; records after it are ${LEVEL_INFO[to].label}. Both keep verifying with the same verifier.${pilot.note ? ` ${pilot.note}` : ''}`,
  };
}

/** true when moving from `from` to `to` creates a customer-held key in a key ceremony (3 of 5 holders). */
function needsHsmCeremony(from: LevelId, to: LevelId) {
  return (levelRank(to) >= 2 && levelRank(from) < 2) || (to === 'sovereign' && from !== 'sovereign');
}

/**
 * Move an organisation up a level. Owner only; never down. Records a level.upgraded receipt and the boundary.
 * Every check (role, key holders) runs before anything is written; if a step still fails, the organisation is put
 * back on its previous level and a level.upgrade_rolled_back receipt says so.
 */
export function upgradeLevel(orgId: string, to: LevelId, userId: string): LevelState {
  const plan = upgradePlan(orgId, to, userId);
  if (!plan.allowed) throw new Error(plan.whyNot);
  // every level change switches the signing key (KMS at L2, a ceremony at L3 and Sovereign): refused, and recorded,
  // while a chain incident or a key compromise is open or a successor key is bound (mock/keys.ts)
  assertKeyChangeAllowed(orgId, userId, `move the organisation to ${LEVEL_INFO[to].label} (the signing key changes with it)`);
  const db = getDB(orgId);
  const from = plan.from;
  const before = { plan: db.org.plan, levelHistory: db.org.levelHistory ? [...db.org.levelHistory] : undefined, deployment: db.org.deployment, residency: db.org.residency, updates: db.platform.updates, grants: db.platform.grants.length };
  const r = append(db, { kind: 'admin', actor: userId, action: 'level.upgraded', details: { from, to, floor_per_year: PLANS[to].floorPerYear } });
  try {
    applyUpgrade(db, orgId, from, to, userId, r);
  } catch (e) {
    Object.assign(db.org, { plan: before.plan, levelHistory: before.levelHistory, deployment: before.deployment, residency: before.residency });
    db.platform.updates = before.updates;
    db.platform.grants = db.platform.grants.slice(0, before.grants);
    append(db, { kind: 'admin', actor: userId, action: 'level.upgrade_rolled_back', details: { from, to, upgrade_seq: r.seq, reason: (e as Error).message.slice(0, 200) } });
    syncOrgMeta(db.org);
    touch(orgId, 'level');
    throw new Error(`The upgrade to ${LEVEL_INFO[to].label} did not complete, and the organisation stays on ${LEVEL_INFO[from].label}. ${(e as Error).message}`);
  }
  endPilotOnUpgrade(db, userId, to); // a running Guarded pilot ends at the boundary; billing at the new level starts there
  deriveBilling(db);
  syncOrgMeta(db.org);
  persistLevels(db.org);
  touch(orgId, 'level');
  return levelState(orgId);
}

function applyUpgrade(db: OrgDB, orgId: string, from: LevelId, to: LevelId, userId: string, r: Receipt) {
  db.org.levelHistory = [...(db.org.levelHistory ?? [{ level: from, from: db.org.createdAt }]), { level: to, from: r.ts, by: userId, seq: r.seq }];
  db.org.plan = to;
  const label = (x: string) => `k_${short(db)}_${x}`;
  if (levelRank(from) < 1 && levelRank(to) >= 1 && levelRank(to) < 2) {
    // the key created and compared out of band before the switch (mock/upgrade.ts), when the wizard bound one
    const bound = takeBoundKey(db);
    rotateKey(orgId, userId, bound ? 'Signing moved into AWS KMS (ap-south-1) for L2 Attested, with the key bound and its fingerprint compared before the switch' : 'Signing moved into AWS KMS (ap-south-1) for L2 Attested', label('kms'), bound);
    db.platform.ceremonies.unshift({ id: `kc_${Date.now().toString(36)}`, kind: 'generation', at: iso(Date.now()), participants: [{ name: userName(userId), role: 'Approver (owner)' }, { name: 'elan1 operations', role: 'Operator' }], quorum: 'Not applicable — AWS KMS', outcome: 'completed', kidAfter: db.keys[db.keys.length - 1].key.kid, log: [{ at: iso(Date.now()), text: 'KMS key created in ap-south-1; signing switched' }] });
  }
  if (levelRank(to) >= 2 && levelRank(from) < 2) {
    if (to === 'sovereign') {
      db.org.deployment = 'sovereign';
      db.org.residency = `On premises · ${db.org.name} data centre`;
      db.platform.updates = seedUpdates(db);
    }
    runKeyCeremony(orgId, userId, undefined, to === 'sovereign' ? 'generation' : 'generation');
    // earned autonomy starts: every agent write type at A2 Propose (the platform's starting level, not a person's
    // choice); A3 is reached only by a two-person graduation
    const toStart = db.agents.reduce((n, a) => n + a.tools.filter((t) => isWriteType(db, t) && !grantFor(db.platform.grants, a.slug, t)).length, 0);
    const started = append(db, { kind: 'admin', actor: 'system', action: 'autonomy.started', details: { level: START_LEVEL, tools: toStart, reason: 'starting level at L3: a person approves every write until a graduation' } });
    startLevels(db, new Date(started.ts).getTime(), undefined, started.seq);
  } else if (to === 'sovereign' && from !== 'sovereign') {
    db.org.deployment = 'sovereign';
    db.org.residency = `On premises · ${db.org.name} data centre`;
    db.platform.updates = seedUpdates(db);
    runKeyCeremony(orgId, userId, undefined, 'generation');
  }
}

/* ══ Key custody ════════════════════════════════════════════════════════ */

export function custodyView(orgId: string): KeyCustody {
  const db = getDB(orgId);
  const level = levelOfOrg(db.org);
  const signer = db.signingKeys.find((k) => k.status === 'active') ?? db.signingKeys[db.signingKeys.length - 1];
  // during a key compromise Elan1 Govern's interim chain key seals the chain; custody describes the organisation's own
  // key (the bound replacement, else the revoked key), never the interim one (mock/keys.ts)
  const active = signer.interim ? ([...db.signingKeys].reverse().find((k) => !k.interim && k.status === 'bound') ?? [...db.signingKeys].reverse().find((k) => !k.interim) ?? signer) : signer;
  const lastRot = [...db.receipts].reverse().find((r) => r.action === 'key.rotated')?.ts;
  const holders = custodyHolders(db);
  const keyRef = (prefix: string) => `${prefix}${sha256Hex(active.kid).slice(0, 8)}-${sha256Hex(active.kid).slice(8, 12)}-${sha256Hex(active.kid).slice(12, 16)}-${sha256Hex(active.kid).slice(16, 28)}`;
  const base = {
    orgId, algorithm: 'Ed25519' as const, kid: active.kid, fingerprint: active.fingerprint, ceremonies: db.platform.ceremonies,
    ...(signer.interim ? { signingOff: { interimKid: signer.kid, interimFingerprint: signer.fingerprint, since: signer.createdAt, ownKeyStatus: active.status } } : {}),
  };
  if (level === 'sovereign') {
    return { ...base, mode: 'customer_hsm_onprem', provider: 'Entrust nShield Connect XC', location: db.org.id === 'org_deccan' ? `${db.org.name} data centre, Mumbai (primary) and Navi Mumbai (DR)` : `${db.org.name} ${sovereignSites(db).primaryLong} (primary) and ${sovereignSites(db).drLong} (DR)`, keyRef: `nshield:${db.org.slug}/signing/${active.kid}`, residencyDomain: db.org.residency ?? 'On premises', heldBy: 'customer', rotation: { policy: 'Yearly, in a key ceremony (3 of 5 card holders)', lastRotatedAt: lastRot, nextDueAt: lastRot ? iso(new Date(lastRot).getTime() + 365 * D) : undefined }, quorum: { required: 3, of: 5 }, holders, note: 'The key is generated and used inside your HSM. Neither elan1 nor Elan1 Govern’s operators can read or export it.' };
  }
  if (level === 'l3') {
    return { ...base, mode: 'customer_hsm_cloud', provider: 'AWS CloudHSM (your cluster)', location: 'Your AWS account · ap-south-1 (Mumbai)', keyRef: keyRef('cloudhsm:cluster-7kq2v4m3/key/'), residencyDomain: 'ap-south-1 Mumbai', heldBy: 'customer', rotation: { policy: 'Yearly, in a key ceremony (3 of 5 key holders)', lastRotatedAt: lastRot, nextDueAt: lastRot ? iso(new Date(lastRot).getTime() + 365 * D) : undefined }, quorum: { required: 3, of: 5 }, holders, note: 'Elan1 Govern asks your HSM to sign; the key never leaves it. Thales Luna and Entrust nShield are supported the same way.' };
  }
  if (level === 'l2') {
    return { ...base, mode: 'aws_kms', provider: 'AWS KMS', location: 'elan1 AWS account · ap-south-1 (Mumbai)', keyRef: keyRef('arn:aws:kms:ap-south-1:441723908815:key/'), alias: `alias/elan1/${db.org.slug}/signing`, residencyDomain: 'ap-south-1 Mumbai', heldBy: 'elan1', rotation: { policy: 'Yearly; a rotation creates a new kid and is a receipt', lastRotatedAt: lastRot, nextDueAt: lastRot ? iso(new Date(lastRot).getTime() + 365 * D) : undefined }, note: 'Key material never leaves KMS. Elan1 Govern calls Sign; every use is in CloudTrail.' };
  }
  return { ...base, mode: 'env_master', provider: 'Elan1 Govern process key', location: 'elan1 hosted · ap-south-1 (sealed by the environment master key)', keyRef: `env:EG_SIGNING_KEY/${active.kid}`, residencyDomain: 'ap-south-1 Mumbai', heldBy: 'elan1', rotation: { policy: 'On request, from Agents › Keys', lastRotatedAt: lastRot }, note: 'At L1 the signing key is held by Elan1 Govern. Custody in AWS KMS starts at L2; customer-held keys at L3.' };
}

/** The open key.rotation.requested receipt (L2 dual control), if one waits: none once a key.rotated, an approval (the successor is then bound) or a withdrawal follows it. */
export function pendingRotationRequest(db: OrgDB): Receipt | undefined {
  for (let i = db.receipts.length - 1; i >= 0; i--) {
    const a = db.receipts[i].action;
    if (a === 'key.rotated' || a === 'key.rotation.withdrawn' || a === 'key.rotation.approved') return undefined;
    if (a === 'key.rotation.requested') return db.receipts[i];
  }
  return undefined;
}

/**
 * Why the set-up ceremony that creates the organisation's first customer-held key (L3 and Sovereign) cannot run now,
 * or undefined when it may. It may run only in the set-up that moved the organisation into customer-held custody:
 * after that level boundary (recorded on this chain) there is no completed set-up, no successor published, no
 * rotation ceremony and no earlier first-key ceremony. Every later key change keeps the successor and overlap path.
 */
export function firstKeyCeremonyBlock(orgId: string): string | undefined {
  const db = getDB(orgId);
  if (!atLeast(levelOfOrg(db.org), 'l3')) return 'The first customer-held key is created in a key ceremony at L3 or Sovereign.';
  const boundary = db.org.levelHistory?.[db.org.levelHistory.length - 1];
  const already = 'This organisation already signs with its own customer-held key, so a new key is published as a successor with the 30-day overlap. Run the ceremony from Agents › Keys, under Custody.';
  if (!boundary?.seq) return already;
  for (let i = db.receipts.length - 1; i >= 0 && db.receipts[i].seq > boundary.seq; i--) {
    const r = db.receipts[i];
    if (r.action === 'onboarding.completed' || r.action === 'key.bound' || (r.action === 'key.ceremony' && (r.details?.kind !== 'generation' || r.details?.first_key))) return already;
  }
  return undefined;
}

/**
 * Run a key ceremony (L3 and Sovereign: 3 of 5 holders present) or a KMS rotation (L2) or a plain
 * rotation (L1). Rotates the signing key for real and writes a key.ceremony receipt.
 *
 * `firstKey`: the set-up ceremony that creates the organisation's first customer-held key (see firstKeyCeremonyBlock).
 * The key holders are the people named at set-up, and the key signs at once: there is no earlier customer-held key for
 * verifiers to have pinned, so there is nothing to overlap with. Writes key.ceremony (first_key) and key.rotated.
 */
export function runKeyCeremony(orgId: string, userId: string, participantNames?: string[], kind: KeyCeremony['kind'] = 'rotation', opts: { firstKey?: boolean } = {}): KeyCeremony {
  const db = getDB(orgId);
  const level = levelOfOrg(db.org);
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Only an owner or admin of this organisation can run a key ceremony.');
  const firstKey = !!opts.firstKey;
  if (firstKey) { const why = firstKeyCeremonyBlock(orgId); if (why) throw new Error(why); }
  // L2: rotating the KMS key is dual control — one person asks, a different owner or admin approves and rotates
  if (level === 'l2' && kind === 'rotation') {
    const pending = pendingRotationRequest(db);
    if (!pending) throw new Error('Rotation in AWS KMS needs two people: ask for the rotation first, and a different owner or admin approves it.');
    if (pending.actor === userId) throw new Error('You asked for this rotation. A different owner or admin approves and rotates the key.');
  }
  const holders = custodyHolders(db);
  const quorumNeeded = atLeast(level, 'l3') ? 3 : 1;
  // first key: the holders named at set-up are the key holders (a member's own title when the name is a member's)
  const named = Array.from(new Set((participantNames ?? []).map((x) => x.trim()).filter(Boolean)));
  const present = firstKey
    ? named.map((name) => holders.find((h) => h.name === name) ?? { name, role: 'Key holder (named at set-up)' })
    : (participantNames?.length ? holders.filter((h) => participantNames.includes(h.name)) : holders.slice(0, 3));
  if (present.length < quorumNeeded) throw new Error(`A key ceremony needs ${quorumNeeded} of ${firstKey ? 5 : holders.length} key holders present; ${present.length} named.`);
  const before = currentKey(db).kid;
  const provider = custodyView(orgId).provider;
  const t = Date.now();
  const cer = append(db, { kind: 'admin', actor: userId, action: 'key.ceremony', details: { kind, quorum: atLeast(level, 'l3') ? `${present.length} of 5` : 'n/a', provider, ...(firstKey ? { first_key: true, signing: 'on' } : {}) } });
  const rot = rotateKey(orgId, userId, firstKey ? `Key ceremony: first customer-held key generated in ${provider}; signs at once (no earlier customer-held key to overlap with)` : atLeast(level, 'l3') ? `Key ceremony: ${kind} in ${provider}` : level === 'l2' ? 'AWS KMS key rotation' : 'Rotated in a recorded ceremony', `k_${short(db)}_${atLeast(level, 'l3') ? 'hsm' : level === 'l2' ? 'kms' : 'env'}`);
  const c: KeyCeremony = {
    id: `kc_${t.toString(36)}`, kind, at: iso(t), participants: present, quorum: atLeast(level, 'l3') ? `${quorumNeeded} of ${firstKey ? Math.max(5, present.length) : holders.length}` : level === 'l2' ? 'Not applicable — AWS KMS' : '1 (owner or admin)', outcome: 'completed', kidBefore: before, kidAfter: rot.kid, hsmSerial: atLeast(level, 'l3') ? provider : undefined, seq: cer.seq,
    log: [
      { at: iso(t), text: `${present.length} participant${present.length === 1 ? '' : 's'} present: ${present.map((x) => x.name).join(', ')}` },
      { at: iso(t), text: `New Ed25519 key ${rot.kid} generated in ${provider}` },
      ...(firstKey ? [{ at: iso(t), text: 'The organisation’s first customer-held key, created at set-up: it signs from now. There is no earlier customer-held key to overlap with; later rotations publish a successor with the 30-day overlap' }] : []),
      { at: iso(t), text: `Fingerprint ${rot.fingerprint} recorded; old key ${before} retired for signing, kept for verification` },
    ],
  };
  db.platform.ceremonies.unshift(c);
  touch(orgId, 'key');
  return c;
}

/* ══ Evidence bundle (L2) ═══════════════════════════════════════════════ */

const README = (org: string, levels: string, enforcement = '') => `VERIFY.txt — Elan1 Govern evidence bundle (elan1.evidence.bundle.v1)

Organisation: ${org}
Assurance levels in this bundle: ${levels}${enforcement ? `\nEnforcement mode: ${enforcement}` : ''}
Issuer: Elan1 Govern · ${LEGAL_ENTITY}

How to verify, offline, with no account:
  govern verify bundle.zip --fingerprint <16 hex you obtained from the organisation>
  Optional: --profile <profile id> to check the records against a verifier profile.

Result codes: 0 PASS (variants PASS, PASS_UNANCHORED_TAIL, PASS_KEY_FROM_BUNDLE, PASS_L1_INTERNAL, PASS_PAYLOAD_UNBOUND) · 1 FAIL_INTEGRITY ·
2 FAIL_PROFILE · 3 INCOMPLETE · 4 UNSUPPORTED · 5 USAGE.

Verify it yourself first. If it does not pass for you it will not pass for them.
Draft — needs legal review.`;

/** Price of one L2+ evidence bundle (the L1 auditor pack is free). */
export const BUNDLE_PRICE = 2500;

/** Export the 8-member bundle and record it: the evidence.exported receipt, and a ₹2,500 bundle on the invoice. */
export function exportEvidenceBundle(db: OrgDB, userId: string, fromSeq?: number, toSeq?: number, profileId?: string, opts: ExportOptions = {}) {
  const built = buildEvidenceBundle(db, userId, fromSeq, toSeq, profileId, opts);
  const m = built.bundle.manifest;
  recordExport(db, userId, built, {
    seals: built.bundle.seals?.length ?? 0, unanchored: m.unanchored_head ?? 0, profile: m.profile_id ?? 'none', charge: BUNDLE_PRICE,
    ...(opts.part ? { part: `${opts.part.index} of ${opts.part.of}`, part_group: opts.part.group } : {}),
    ...(opts.gate ? { residency: opts.gate.residency, ...(opts.gate.transferBasis ? { transfer_basis: opts.gate.transferBasis } : {}), ...(opts.gate.purpose ? { purpose: opts.gate.purpose } : {}), missing_declarations: opts.gate.missingDeclarations?.length ?? 0 } : {}),
  });
  return built;
}

let bundleProfileHook: ((db: OrgDB, p: VerifierProfile) => VerifierProfile) | undefined;
/** The pack factory sets how a claimed profile is written into a bundle: with this organisation's lifecycle and pilot rows. */
export function setBundleProfileHook(fn: (db: OrgDB, p: VerifierProfile) => VerifierProfile) { bundleProfileHook = fn; }

/** Build the 8-member evidence bundle for a range. Nothing is written (the public verifier's samples use this). */
export function buildEvidenceBundle(db: OrgDB, userId: string, fromSeq?: number, toSeq?: number, profileId?: string, opts: ExportOptions = {}) {
  const receipts = db.receipts.filter((r) => (fromSeq === undefined || r.seq >= fromSeq) && (toSeq === undefined || r.seq <= toSeq));
  if (!receipts.length) throw new Error('No receipts in that range.');
  const seqs = new Set(receipts.map((r) => r.seq));
  const checkpoints = db.checkpoints.filter((c) => seqs.has(c.seq));
  // assurance levels, as contiguous runs
  const levels: { level: LevelId; count: number; first_seq: number; last_seq: number }[] = [];
  for (const r of receipts) {
    const lv = levelOfReceipt(db, r);
    const last = levels[levels.length - 1];
    if (last && last.level === lv) { last.count++; last.last_seq = r.seq; } else levels.push({ level: lv, count: 1, first_seq: r.seq, last_seq: r.seq });
  }
  const sealed = receipts.filter((r) => isSealed(db, r));
  const seals = sealed.map((r) => sealOf(db, r.seq)!).filter(Boolean);
  const regular = anchorBatches(db);
  const lastRegular = regular[regular.length - 1]?.lastSeq ?? 0;
  // batches timestamped on demand ("Anchor now") that reach past the last regular batch travel too, so the records
  // they cover are not counted as the unanchored tail; the verifier checks them like any other batch
  const all = [...regular, ...onDemandAnchorBatches(db).filter((b) => b.lastSeq > lastRegular)];
  const batches = all.filter((b) => b.lastSeq >= receipts[0].seq && b.firstSeq <= receipts[receipts.length - 1].seq).map((b) => clone(b));
  const lastAnchored = Math.max(0, ...all.map((b) => b.lastSeq));
  const unanchored = sealed.filter((r) => r.seq > lastAnchored).length;
  const anchors = { authorities: [...tsaAuthorities(db), ...previousTsaAuthorities(db)], batches };
  const used = new Map<string, { slug: string; version: number; hash: string; signedBy?: string; signedAt?: string }>();
  for (const r of receipts) {
    if (!r.agent || !r.rulebook) continue;
    const k = `${r.agent}@${r.rulebook.version}`;
    if (used.has(k)) continue;
    const v = db.rulebooks.find((b) => b.slug === r.agent)?.versions.find((x) => x.version === r.rulebook!.version);
    used.set(k, { slug: r.agent, version: r.rulebook.version, hash: r.rulebook.hash, signedBy: v?.signedBy, signedAt: v?.signedAt });
  }
  const declarations = {
    rulebooks: [...used.values()],
    context: {
      wormRetentionYears: atLeast(levelOfOrg(db.org), 'l2') ? 8 : 0, erasures: db.platform.erasures,
      agents: db.agents.map((a) => ({ slug: a.slug, id: a.id, aiSystemId: a.aiSystemId })), aiSystems: db.aiSystems.map((x) => ({ id: x.id, linkedAgentId: x.linkedAgentId, riskTier: x.riskTier })),
      assessments: db.assessments.map((a) => ({ aiSystemId: a.aiSystemId, status: a.status })),
    },
  };
  const baseProfile = profileId && profileId !== 'none' ? profileById(profileId) ?? null : null;
  if (profileId && profileId !== 'none' && !baseProfile) throw new Error(`No verifier profile called ${profileId}.`);
  // the profile as it stands in this organisation (its lifecycle and a pilot's not_measurable rows), set by mock/packsFactory.ts
  const profile = baseProfile && bundleProfileHook ? bundleProfileHook(db, baseProfile) : baseProfile;
  const enf = enforcementOf(db, receipts);
  const readme = README(db.org.name, levels.map((l) => `${LEVEL_INFO[l.level].short} #${l.first_seq}–#${l.last_seq} (${l.count})`).join(', '), `${ENFORCEMENT_LABEL[enf.mode]}. ${enf.statement}`);
  // receipts an executed erasure covers leave without the values the rules inspected (the seal keeps F14 frozen)
  const exported = redactErased(db, receipts);
  // the rule and refusal vocabulary the receipts use (spec 02 §4.9): an extra member beside the eight (mock/lexicon.ts)
  const lexicon = buildLexicon(db, exported);
  // the signing key first: getting it can add its public key to keys.json, which must happen before that member's digest
  const key = currentKey(db);
  // read before the member digests too: reading the unsigned intervals can mark interim keys (keys.json)
  const intervals = unsignedIntervalsInRange(db.org.id, receipts[0].seq, receipts[receipts.length - 1].seq);
  const hosting = hostingManifest(db);
  const contents: Record<string, unknown> = { 'receipts.jsonl': exported, 'seals.jsonl': seals, 'checkpoints.json': checkpoints, 'anchors.json': anchors, 'keys.json': db.publicKeys, 'declarations.json': declarations, 'profile/ (profile.json + VERIFY.txt)': { profile, readme }, [LEXICON_MEMBER]: lexicon };
  const members = [...BUNDLE_MEMBERS, LEXICON_MEMBER].map((path) => (path === 'manifest.json' ? { path, bytes: 0, sha256: 'self' } : { path, ...memberDigest(contents[path]) }));
  const enforcement = enforcementOf(db, receipts);
  const manifest: BundleManifest = {
    enforcement_mode: enforcement.mode, enforcement,
    ...(opts.container ? { container: opts.container } : {}),
    ...(opts.part ? { part: opts.part } : {}),
    ...(opts.gate ? { export_checks: opts.gate } : {}),
    // hosting profile 1–4 and the residency domain the records were held in (records area, mock/records.ts)
    hosting_profile: hosting,
    format: 'elan1.evidence.bundle.v1', bundle_format: 'elan1.evidence.bundle.v1', issuer: `Elan1 Govern · ${LEGAL_ENTITY}`, org: db.org.name, org_id: db.org.id, tenant_id: db.org.id,
    created_at: new Date().toISOString(), created_by: userId, receipts: receipts.length, record_count: receipts.length, refusal_count: receipts.filter((r) => r.decision === 'refuse').length,
    first_seq: receipts[0].seq, last_seq: receipts[receipts.length - 1].seq, seq_from: receipts[0].seq, seq_to: receipts[receipts.length - 1].seq, checkpoints: checkpoints.length,
    // records sealed by Elan1 Govern's interim chain key during a key compromise: hash-chained, not signed with the organisation's key
    // (read first: it also marks the interim keys listed next)
    ...(intervals.length ? { unsigned_intervals: intervals } : {}),
    keys: db.signingKeys.map((k) => ({ kid: k.kid, fingerprint: k.fingerprint, status: k.status, ...(k.interim ? { interim: true } : {}) })),
    assurance_levels: levels, continuity_scope: fromSeq === undefined && toSeq === undefined ? 'full_chain' : 'range',
    profile_id: profile?.id, profile_version: profile?.version, profile_digest: profile?.digest, redaction_profile: 'none', members, unanchored_head: unanchored, signing_kid: key.kid,
    verifier_digest: sha256Hex(VERIFIER_VERSION), note: 'Draft — needs legal review. Sealed records are signed with a key in managed custody and timestamped by two authorities; L1 records are sealed in a hash chain by Elan1 Govern and not externally timestamped.',
  };
  const manifest_sig = signText(manifestMessage(manifest), key);
  const bundleObj: EvidenceBundle = { manifest, manifest_sig, public_keys: db.publicKeys, receipts: exported, checkpoints, seals, anchors, declarations, profile, readme, lexicon };
  const json = JSON.stringify(bundleObj);
  const exp: AuditorPackExport = {
    id: `exp_${Date.now().toString(36)}${opts.part ? `_${opts.part.index}` : ''}`, ts: manifest.created_at!, by: userId, firstSeq: receipts[0].seq, lastSeq: receipts[receipts.length - 1].seq, receipts: receipts.length, checkpoints: checkpoints.length,
    sizeKb: Math.round(json.length / 1024), format: 'elan1.evidence.bundle.v1', profileId: profile?.id, enforcement: enforcement.mode, digest: bundleDigest(bundleObj), container: opts.container ?? 'zip',
    ...(opts.part ? { part: `${opts.part.index} of ${opts.part.of}` } : {}),
  };
  return { bundle: bundleObj, json, export: exp };
}

/* ══ Verifier profiles ══════════════════════════════════════════════════ */

export function profilesView(orgId: string) {
  const db = getDB(orgId);
  const installed = new Set(db.platform.packs.map((x) => x.id));
  return PROFILES.map((pr) => ({ ...pr, enabled: atLeast(levelOfOrg(db.org), 'l2'), viaPack: pr.packId ? installed.has(pr.packId) : undefined, lastRun: db.platform.profileRuns.find((r) => r.profileId === pr.id) }));
}

/** Run a verifier profile against the organisation's whole chain. Writes a profile.run receipt when a user runs it. */
export function runProfile(orgId: string, profileId: string, userId?: string): ProfileRunResult {
  const db = getDB(orgId);
  const pr = profileById(profileId);
  if (!pr) throw new Error(`No verifier profile called ${profileId}.`);
  const anchored = new Set<number>();
  const batches = anchorBatches(db);
  batches.forEach((b) => { for (let q = b.firstSeq; q <= b.lastSeq; q++) anchored.add(q); });
  const rules = runProfileRules(pr, {
    receipts: db.receipts, checkpoints: db.checkpoints, level: levelOfOrg(db.org), anchoredSeqs: anchored, anchorBatches: batches, wormRetentionYears: atLeast(levelOfOrg(db.org), 'l2') ? 8 : 0,
    erasures: db.platform.erasures, agents: db.agents, aiSystems: db.aiSystems, assessments: db.assessments,
  });
  const result: ProfileRunResult = {
    id: `pr_${Date.now().toString(36)}`, profileId: pr.id, version: pr.version, orgId, ranAt: iso(Date.now()), ranBy: userId,
    range: { firstSeq: db.receipts[0].seq, lastSeq: db.receipts[db.receipts.length - 1].seq, count: db.receipts.length },
    result: rules.some((r) => r.state === 'fail') ? 'fail' : 'pass', rules, digest: sha256Hex(canonical({ profile: pr.digest, rules: rules.map((r) => [r.id, r.state, r.failingSeqs]) })),
  };
  if (userId) {
    const r = append(db, { kind: 'admin', actor: userId, action: 'profile.run', details: { profile: pr.id, version: pr.version, result: result.result, failing_rules: rules.filter((x) => x.state === 'fail').map((x) => x.id).join(',') } });
    result.seq = r.seq;
  }
  db.platform.profileRuns = [result, ...db.platform.profileRuns.filter((x) => x.profileId !== pr.id)].slice(0, 20);
  return result;
}

/* ══ Counterparties, cross-org receipts, disclosure ═════════════════════ */

function makeDisclosure(db: OrgDB, st: PlatformState, r: Receipt, reveal: string[], audience: string, counterpartyId: string | undefined, userId: string, createdAt = Date.now(), expiresDays = 30): DisclosurePackage {
  const result = db.receipts.find((x) => x.kind === 'approval' && x.ref_seq === r.seq);
  const values = fieldValuesOf(r, result);
  const { committed, salts } = commitFields(values);
  const key = keyForKid(db, r.kid) ?? currentKey(db);
  const id = `dp_${randHex(6)}`;
  const base = { orgId: db.org.id, seq: r.seq, receiptHash: r.hash, audience, expiresAt: iso(Math.max(createdAt, Date.now()) + expiresDays * D), committed };
  const pkg: DisclosurePackage = {
    id, ...base, issuerName: db.org.name, createdAt: iso(createdAt), createdBy: userId, counterpartyId, token: `${db.org.slug}.${randHex(10)}`,
    revealed: reveal.filter((n) => n in values).map((name) => ({ name, salt: salts[name], value: values[name as keyof typeof values] })),
    kid: key.kid, publicKey: db.publicKeys[key.kid], sig: signText(disclosureMessage(base), key), status: 'active', views: 0,
  };
  st.disclosures.unshift(pkg);
  st.disclosureSalts[id] = salts;
  return pkg;
}

/** Resolve receipts received from other demo organisations (built on first use) and verify them for real. */
function resolveReceived(db: OrgDB) {
  for (const x of db.platform.crossOrg) {
    if (x.direction !== 'received' || x.receipt) continue;
    const issuer = getDB(x.issuerOrgId);
    const idx = Number(x.id.split('_').pop()) || 0;
    const pool = issuer.receipts.filter((r) => r.kind === 'decision' && r.decision === 'allow' && (r.tool === 'zoho_books.create_bill' || r.tool === 'bank.get_balance' || r.tool === 'zoho_books.list_invoices'));
    // when the issuer seeded receipts issued to this organisation, the received copy is that receipt (same seq and nonce,
    // linked by peerId), so revocations and disputes reach the other side (mock/l3crossorg.ts)
    const aud = `ar-org:${db.org.domain}`;
    const iss = issuer.platform.crossOrg.filter((y) => y.direction === 'issued' && y.audience === aud && y.id === `xi_${issuer.org.id}_${y.seq}_${y.counterpartyId}`)[idx];
    const r = (iss && issuer.receipts.find((z) => z.seq === iss.seq)) || pool[Math.max(0, pool.length - 1 - idx * 3)];
    if (!r) continue;
    const peer = iss && iss.seq === r.seq ? iss : undefined;
    const cp = db.platform.counterparties.find((c) => c.id === x.counterpartyId);
    Object.assign(x, {
      issuerName: issuer.org.name, audience: aud, seq: r.seq, receiptHash: r.hash, kid: r.kid, publicKey: issuer.publicKeys[r.kid], sig: r.sig,
      issuedAt: peer ? peer.issuedAt : iso(new Date(r.ts).getTime() + 30 * 60_000), expiresAt: peer ? peer.expiresAt : iso(Date.now() + 6 * D), nonce: peer ? peer.nonce : sha256Hex(`${r.hash}:${db.org.id}`).slice(0, 16), receipt: clone(r),
      ...(peer ? { peerId: peer.id } : {}),
      summary: `${issuer.org.name}: ${r.tool}${r.args_summary?.amount ? ` · ₹${Number(r.args_summary.amount).toLocaleString('en-IN')}` : ''} under rulebook v${r.rulebook?.version ?? '—'}`,
    });
    x.verification = checkReceived(db, x);
    if (cp) cp.received = db.platform.crossOrg.filter((y) => y.direction === 'received' && y.counterpartyId === cp.id).length;
  }
}

function checkReceived(db: OrgDB, x: CrossOrgReceipt): CrossOrgReceipt['verification'] {
  const steps: CrossOrgReceipt['verification']['steps'] = [];
  const cp = db.platform.counterparties.find((c) => c.id === x.counterpartyId);
  steps.push({ label: 'Audience', state: x.audience === `ar-org:${db.org.domain}` ? 'pass' : 'fail', detail: `Addressed to ${x.audience}.` });
  const expired = new Date(x.expiresAt).getTime() < Date.now();
  steps.push({ label: 'Expiry', state: expired ? 'fail' : 'pass', detail: expired ? 'Expired.' : `Valid until ${new Date(x.expiresAt).toLocaleDateString('en-IN')}.` });
  // the issuer's published key set (/.well-known/action-receipt-keys at its domain) and the fingerprint pinned here —
  // never the key the receipt carries, so a receipt signed by another key cannot vouch for itself
  const published = (peekDB(x.issuerOrgId) ?? getDB(x.issuerOrgId)).publicKeys[x.kid];
  const fp = published ? sha256Hex(published).slice(0, 16) : undefined;
  const pinned = cp?.keyFingerprint;
  const route = cp?.keyRoute === 'pinned' ? 'obtained directly' : cp?.keyRoute === 'well_known' ? 'from /.well-known/action-receipt-keys' : 'from a trust anchor';
  const carried = x.publicKey && published && x.publicKey !== published ? ' The key carried inside the receipt differs and is ignored.' : '';
  steps.push({
    label: 'Issuer key', state: !published ? 'fail' : pinned ? (pinned === fp ? 'pass' : 'fail') : 'pass',
    detail: !published ? `Key ${x.kid} is not in ${x.issuerName}’s published key set.` : pinned ? `Published key ${x.kid}, fingerprint ${fp}, ${pinned === fp ? 'matches' : 'does not match'} the one pinned for ${cp?.name} (${route}).${carried}` : `Published key ${x.kid}, fingerprint ${fp} (no fingerprint pinned for this counterparty).${carried}`,
  });
  const hashOk = !!x.receipt && receiptHash(x.receipt) === x.receiptHash;
  steps.push({ label: 'Content hash', state: hashOk ? 'pass' : 'fail', detail: hashOk ? 'The receipt recomputes to the hash it carries.' : 'The receipt does not match its hash.' });
  const sigOk = !!published && verifySig(x.receiptHash, x.sig, published);
  steps.push({ label: 'Signature', state: sigOk ? 'pass' : 'fail', detail: sigOk ? 'Ed25519 signature verifies against the issuer’s published key.' : 'The signature does not verify against the issuer’s published key.' });
  const all = db.platform.crossOrg.includes(x) ? db.platform.crossOrg : [x, ...db.platform.crossOrg];
  steps.push(replayStep(all, x));
  const issuer = peekDB(x.issuerOrgId);
  let anchorState: 'pass' | 'skip' = 'skip';
  let anchorDetail = 'UNANCHORED — the issuer is on L1, or this receipt is in its newest batch.';
  if (issuer && x.receipt && isSealed(issuer, x.receipt)) {
    const b = anchorBatches(issuer).find((bb) => x.seq >= bb.firstSeq && x.seq <= bb.lastSeq);
    if (b) { anchorState = 'pass'; anchorDetail = `In batch ${b.id}, timestamped by ${b.tokens.map((t) => t.tsaName).join(' and ')}.`; }
  }
  steps.push({ label: 'Timestamp', state: anchorState, detail: anchorDetail });
  const failed = steps.some((st) => st.state === 'fail');
  return { state: expired ? 'expired' : failed ? 'failed' : 'verified', checkedAt: iso(Date.now()), steps };
}

/**
 * The counterparties named in governed calls, from the chain. Listed read-only from L1 (decision 6d); seats,
 * issuing and receiving start at L3.
 */
function chainCounterparties(db: OrgDB) {
  const by = new Map<string, { name: string; receipts: number; refused: number; lastAt: string; lastSeq: number }>();
  for (const r of db.receipts) {
    if (r.kind !== 'decision' || r.redacted) continue;
    const a = r.args_summary ?? {};
    const name = a.counterparty ?? a.vendor ?? a.to_domain;
    if (typeof name !== 'string' || !name.trim()) continue;
    const e = by.get(name) ?? { name, receipts: 0, refused: 0, lastAt: r.ts, lastSeq: r.seq };
    e.receipts++;
    if (r.decision === 'refuse') e.refused++;
    e.lastAt = r.ts;
    e.lastSeq = r.seq;
    by.set(name, e);
  }
  return [...by.values()].sort((x, y) => y.receipts - x.receipts);
}

export function counterpartiesView(orgId: string) {
  const db = getDB(orgId);
  if (atLeast(levelOfOrg(db.org), 'l3')) resolveReceived(db);
  return { enabled: atLeast(levelOfOrg(db.org), 'l3'), seatPrice: 45000, counterparties: db.platform.counterparties, seatsTotal: db.platform.counterparties.reduce((n, c) => n + c.seats, 0), fromChain: chainCounterparties(db) };
}

export function crossOrgView(orgId: string) {
  const db = getDB(orgId);
  if (atLeast(levelOfOrg(db.org), 'l3')) resolveReceived(db);
  return clone(db.platform.crossOrg.filter((x) => x.direction === 'issued' || x.receipt));
}

/**
 * Change the number of verification seats a counterparty holds (owner or admin, L3+; 1 to 50, never below the
 * seats in use). Writes counterparty.seats.changed and re-derives the invoices (₹45,000 per seat per year).
 */
export function setCounterpartySeats(orgId: string, counterpartyId: string, seats: number, userId: string): Counterparty {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'Verification seats');
  const role = memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins can change seats; your role cannot.');
  const c = db.platform.counterparties.find((x) => x.id === counterpartyId);
  if (!c) throw new Error('No such counterparty.');
  const next = Math.floor(seats);
  if (!Number.isFinite(next) || next < 1) throw new Error('A counterparty needs at least 1 seat to verify.');
  if (next > 50) throw new Error('More than 50 seats for one counterparty is arranged with elan1 directly.');
  if (next < c.seatsUsed) throw new Error(`${c.name} uses ${c.seatsUsed} seat${c.seatsUsed === 1 ? '' : 's'}. Release a verifier on their side before going below that.`);
  if (next === c.seats) return clone(c);
  const before = c.seats;
  c.seats = next;
  // the invoices read the seats from this receipt onwards (billing/chainMeter.ts seatSpans): months already billed keep their amounts
  append(db, { kind: 'admin', actor: userId, action: 'counterparty.seats.changed', details: { counterparty: c.name, counterparty_id: c.id, from: before, to: next, per_year: next * 45000 } });
  deriveBilling(db);
  touch(orgId, 'counterparty');
  return clone(c);
}

export function addCounterparty(orgId: string, input: { name: string; kind: Counterparty['kind']; domain: string; seats: number; contact: string; keyFingerprint?: string }, userId: string): Counterparty {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'The counterparty register');
  requireRole(orgId, userId, ['owner', 'admin']);
  const linked = ORGS.find((o) => o.domain === input.domain.trim().toLowerCase());
  const c: Counterparty = { id: `cp_${randHex(4)}`, name: input.name.trim(), kind: input.kind, domain: input.domain.trim().toLowerCase(), orgId: linked?.id, seats: Math.max(1, input.seats), seatsUsed: 0, verification: input.keyFingerprint ? 'verified' : 'not_started', keyFingerprint: input.keyFingerprint, keyRoute: input.keyFingerprint ? 'pinned' : 'well_known', since: iso(Date.now()), contact: input.contact, issued: 0, received: 0 };
  db.platform.counterparties.push(c);
  append(db, { kind: 'admin', actor: userId, action: 'counterparty.added', details: { counterparty: c.name, kind: c.kind, seats: c.seats } });
  deriveBilling(db);
  return c;
}

/** Issue a receipt to a counterparty with a disclosure package revealing only `fields`. If the counterparty is another demo organisation it arrives in their register too. */
export function issueToCounterparty(orgId: string, seq: number, counterpartyId: string, fields: string[], userId: string, expiresDays = 30) {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'Issuing receipts to counterparties');
  requireRole(orgId, userId, ['owner', 'admin']);
  const r = db.receipts.find((x) => x.seq === seq);
  if (!r) throw new Error(`No receipt #${seq}.`);
  const c = db.platform.counterparties.find((x) => x.id === counterpartyId);
  if (!c) throw new Error('No such counterparty.');
  if (!fields.length) throw new Error('Choose at least one field to reveal.');
  const pkg = makeDisclosure(db, db.platform, r, fields, `ar-org:${c.domain}`, c.id, userId, Date.now(), Math.min(365, Math.max(1, Math.round(expiresDays))));
  const x = crossFromOwn(db, c, r, `${r.tool ?? r.action ?? r.kind} — revealing ${pkg.revealed.length} of ${pkg.committed.length} fields`, pkg.id, pkg.token, currentKey(db));
  x.issuedAt = iso(Date.now());
  x.expiresAt = pkg.expiresAt;
  // a fresh nonce for every issue (the receiver refuses a second copy of a nonce as RECEIPT_REPLAYED)
  x.nonce = randHex(8);
  x.id = `${x.id}_${x.nonce.slice(0, 6)}`;
  x.verification = { state: 'pending', steps: [{ label: 'Delivered', state: 'pass', detail: `Sent to ${c.name}. Their verifier has not reported yet.` }] };
  db.platform.crossOrg.unshift(x);
  c.issued++;
  const rr = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.issued', details: { counterparty: c.name, seq, revealed: pkg.revealed.length, committed: pkg.committed.length, disclosure: pkg.id } });
  pkg.seqCreated = rr.seq;
  if (c.orgId) {
    const other = getDB(c.orgId);
    const back = other.platform.counterparties.find((y) => y.orgId === orgId);
    const rec: CrossOrgReceipt = { ...clone(x), id: `xr_${orgId}_${seq}_${Date.now().toString(36)}`, direction: 'received', counterpartyId: back?.id ?? `cp_${short(db)}`, counterpartyName: db.org.name, receipt: clone(r), audience: `ar-org:${other.org.domain}`, receivedAt: iso(Date.now()), peerId: x.id };
    rec.verification = checkReceived(other, rec);
    other.platform.crossOrg.unshift(rec);
    if (back) back.received++;
    append(other, { kind: 'admin', actor: 'system', action: 'counterparty.receipt.received', details: { from: db.org.name, seq, verified: rec.verification.state === 'verified' } });
    x.verification = { state: rec.verification.state, checkedAt: rec.verification.checkedAt, steps: [{ label: 'Delivered', state: 'pass', detail: `Delivered to ${c.name}; their verifier reported ${rec.verification.state}.` }] };
  }
  return { receipt: x, disclosure: pkg };
}

/** Re-verify a received receipt and bind it into this organisation's chain (a counterparty.receipt.verified receipt). */
export function verifyReceived(orgId: string, id: string, userId: string) {
  const db = getDB(orgId);
  resolveReceived(db);
  const x = db.platform.crossOrg.find((y) => y.id === id && y.direction === 'received');
  if (!x) throw new Error('No such received receipt.');
  x.verification = checkReceived(db, x);
  const r = append(db, { kind: 'admin', actor: userId, action: 'counterparty.receipt.verified', details: { from: x.issuerName, seq: x.seq, hash: x.receiptHash.slice(0, 16), result: x.verification.state } });
  x.boundSeq = r.seq;
  return clone(x);
}

export function disclosuresView(orgId: string) {
  return clone(getDB(orgId).platform.disclosures);
}

/** Create a disclosure package for a receipt: commit all 11 fields, reveal only those chosen. */
export function createDisclosure(orgId: string, input: { seq: number; fields: string[]; audience: string; counterpartyId?: string; expiresDays?: number }, userId: string) {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'Selective disclosure');
  requireRole(orgId, userId, ['owner', 'admin']);
  const r = db.receipts.find((x) => x.seq === input.seq);
  if (!r) throw new Error(`No receipt #${input.seq}.`);
  const bad = input.fields.filter((f) => !(DISCLOSABLE_FIELDS as readonly string[]).includes(f));
  if (bad.length) throw new Error(`Not a disclosable field: ${bad.join(', ')}.`);
  if (!input.fields.length) throw new Error('Choose at least one field to reveal.');
  const pkg = makeDisclosure(db, db.platform, r, input.fields, input.audience || 'ar-org:unspecified', input.counterpartyId, userId, Date.now(), input.expiresDays ?? 30);
  const rr = append(db, { kind: 'admin', actor: userId, action: 'disclosure.created', details: { seq: r.seq, revealed: pkg.revealed.length, committed: pkg.committed.length, audience: pkg.audience } });
  pkg.seqCreated = rr.seq;
  return clone(pkg);
}

export function revokeDisclosure(orgId: string, id: string, userId: string) {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'Selective disclosure');
  requireRole(orgId, userId, ['owner', 'admin']);
  const pkg = db.platform.disclosures.find((x) => x.id === id);
  if (!pkg) throw new Error('No such disclosure package.');
  if (pkg.status === 'revoked') throw new Error('This disclosure is already withdrawn.');
  pkg.status = 'revoked';
  append(db, { kind: 'admin', actor: userId, action: 'disclosure.revoked', details: { disclosure: id, seq: pkg.seq } });
  return clone(pkg);
}

/** Public: the disclosure package behind a portal token, verified in the visitor's browser. No sign-in. */
export function disclosureByToken(token: string) {
  const slug = token.split('.')[0];
  const org = ORGS.find((o) => o.slug === slug);
  if (!org) throw new Error('This link is not valid.');
  const db = getDB(org.id);
  const pkg = db.platform.disclosures.find((x) => x.token === token);
  if (!pkg) throw new Error('This link is not valid or was withdrawn.');
  if (pkg.status === 'revoked') throw new Error(`${org.name} withdrew this disclosure.`);
  pkg.views++;
  pkg.lastViewedAt = iso(Date.now());
  touch(org.id, 'disclosure'); // saved with the organisation, so the count survives a reload and the issuer sees it
  const pub = clone(pkg);
  const check = verifyDisclosure(pub);
  const cp = db.platform.counterparties.find((c) => c.id === pkg.counterpartyId);
  return { package: pub, issuer: { name: org.name, fingerprint: sha256Hex(pkg.publicKey).slice(0, 16), level: LEVEL_INFO[levelOfOrg(db.org)].label }, counterparty: cp ? { name: cp.name, kind: cp.kind } : undefined, check, limits: 'This establishes that the issuer’s governed write path produced this record under these rules at this time. It does not establish that the underlying transaction occurred.' };
}

/* ══ Earned autonomy ════════════════════════════════════════════════════ */

/*
 * Graduation only (see lib/autonomy.ts). Exactly three things write autonomy, and no call takes a level:
 *   the platform writes the A2 starting level (startLevels: at L3, and for an agent registered from L3);
 *   a two-person graduation writes A3 with a 30-day supervised period (proposeGraduation, then decideGraduation);
 *   one owner or admin revokes a graduation in one press (revokeGrant), and the tool falls back to A2.
 */

const pairKey = (agentSlug: string, tool: string) => `${agentSlug}|${tool}`;
const tagsOfTool = (db: OrgDB, tool: string): RiskTag[] => toolTagsIn(db, tool) ?? TOOLS.find((t) => t.name === tool)?.tags ?? [];
/** A write type: any tool that does more than read (reads run at every level, A0 included). */
const isWriteType = (db: OrgDB, tool: string) => !isReadOnly(tagsOfTool(db, tool));
const isRetiredAgent = (db: OrgDB, slug: string) => !!(db.agents.find((a) => a.slug === slug) as { retiredAt?: string } | undefined)?.retiredAt;

/**
 * Write the A2 Propose starting level for the write types of `slugs` (every agent when omitted) that have none at
 * `at`. The platform writes it (grantedBy "system"); nobody chooses a level. Returns how many were written.
 */
function startLevels(db: OrgDB, at: number, slugs?: string[], seq?: number): number {
  let n = 0;
  for (const a of db.agents) {
    if (slugs && !slugs.includes(a.slug)) continue;
    for (const tool of a.tools) {
      if (!isWriteType(db, tool) || grantFor(db.platform.grants, a.slug, tool, at)) continue;
      db.platform.grants.push({
        id: `gr_${a.slug}_${tool}_start_${at.toString(36)}`.replace(/\./g, '_'), agentSlug: a.slug, tool, level: START_LEVEL, grantedBy: 'system', grantedAt: iso(at),
        reason: 'Starting level from L3: a person approves every write until the agent graduates.', origin: 'start', ...(seq ? { seq } : {}),
      });
      n++;
    }
  }
  return n;
}

/** From L3, an agent registered now starts at A2 Propose on each write type (one autonomy.started receipt). */
export function startAutonomy(orgId: string, agentSlug: string): number {
  const db = getDB(orgId);
  if (!atLeast(levelOfOrg(db.org), 'l3')) return 0;
  const now = Date.now();
  const tools = db.agents.find((a) => a.slug === agentSlug)?.tools.filter((t) => isWriteType(db, t) && !grantFor(db.platform.grants, agentSlug, t, now)) ?? [];
  if (!tools.length) return 0;
  const r = append(db, { kind: 'admin', actor: 'system', action: 'autonomy.started', agent: agentSlug, details: { level: START_LEVEL, tools: tools.length, reason: 'starting level for an agent registered at L3' } });
  const n = startLevels(db, new Date(r.ts).getTime(), [agentSlug], r.seq);
  touch(orgId, 'autonomy');
  return n;
}

/** The counts kept for a seeded agent and tool as of `asOf` (see PlatformState.precedent). */
export interface PrecedentBase { since: string; records: number; approvals: number; rejections: number; reversals: number; asOf: string }

/** The record for one agent and tool: what graduation is measured on. Numbers only, never a recommendation. */
export interface Precedent { since: string; days: number; records: number; approvals: number; rejections: number; reversals: number; counterparties: number; medianMinutesToDecide: number }

export function precedentOf(db: OrgDB, agentSlug: string, tool: string, t = Date.now()): Precedent {
  const base = db.platform.precedent?.[pairKey(agentSlug, tool)];
  const after = base ? new Date(base.asOf).getTime() : -Infinity;
  const recs = db.receipts.filter((r) => r.kind === 'decision' && r.agent === agentSlug && r.tool === tool && new Date(r.ts).getTime() > after);
  const decided = db.approvals.filter((a) => a.agentSlug === agentSlug && a.tool === tool && a.status !== 'pending' && new Date(a.createdAt).getTime() > after);
  const allDecided = db.approvals.filter((a) => a.agentSlug === agentSlug && a.tool === tool && a.status !== 'pending' && a.decidedAt);
  const mins = allDecided.map((a) => (new Date(a.decidedAt!).getTime() - new Date(a.createdAt).getTime()) / 60_000).sort((a, b) => a - b);
  // days of operation: from the agent's registration (the console's chain is a sample, so its first record is late)
  const agent = db.agents.find((a) => a.slug === agentSlug);
  const firstRec = db.receipts.find((r) => r.kind === 'decision' && r.agent === agentSlug && r.tool === tool)?.ts;
  const since = base?.since ?? [agent?.createdAt, firstRec].filter(Boolean).sort()[0] ?? iso(t);
  return {
    since, days: Math.max(0, Math.floor((t - new Date(since).getTime()) / D)),
    records: (base?.records ?? 0) + recs.length,
    approvals: (base?.approvals ?? 0) + decided.filter((a) => a.status === 'approved' || a.status === 'approved_run_failed').length,
    rejections: (base?.rejections ?? 0) + decided.filter((a) => a.status === 'rejected').length,
    reversals: base?.reversals ?? 0,
    counterparties: new Set(allDecided.map((a) => a.counterparty).filter(Boolean)).size,
    medianMinutesToDecide: Math.round(mins[Math.floor(mins.length / 2)] ?? 0),
  };
}

const evidenceOf = (p: Precedent): GraduationProposal['evidence'] =>
  ({ approvals: p.approvals, rejections: p.rejections, reversals: p.reversals, days: p.days, records: p.records, counterparties: p.counterparties, medianMinutesToDecide: p.medianMinutesToDecide });

export function grantsView(orgId: string) {
  const db = getDB(orgId);
  const enforced = atLeast(levelOfOrg(db.org), 'l3');
  const rows = db.agents.flatMap((a) => a.tools.map((tool) => {
    const g = grantFor(db.platform.grants, a.slug, tool);
    return {
      agentSlug: a.slug, agentName: a.name, tool, tags: toolTagsIn(db, tool) ?? [], grant: g, level: (g?.level ?? 'A0') as AutonomyLevel, label: autonomyLabel(g?.level, !!g),
      /** graduated (A3 by two people) rather than the starting level; supervised while its 30 days run */
      graduated: g?.origin === 'graduation', supervised: isSupervised(g),
      history: db.platform.grants.filter((x) => x.agentSlug === a.slug && x.tool === tool),
    };
  }));
  return { enforced, levels: AUTONOMY_LEVELS, unavailable: UNAVAILABLE_LEVELS, noGrantLabel: NO_GRANT_LABEL, rows };
}

/** One agent and write type, with its record against the graduation thresholds (met / not met). */
export interface GraduationCandidate {
  agentSlug: string; agentName: string; tool: string; tags: RiskTag[];
  level: AutonomyLevel; hasGrant: boolean; grant?: AutonomyGrant;
  precedent: Precedent; checks: GraduationCheck[];
  /** every threshold met */
  met: boolean;
  /** can be proposed now (L3, at A2, every threshold met, nothing open) */
  eligible: boolean;
  whyNot?: string;
  openProposalId?: string;
  /** a revoked graduation's 30-day cooldown: no re-proposal before this */
  cooldownUntil?: string;
  cooldownAutomatic?: boolean;
}

/** Every agent write type with its numbers against the graduation thresholds. Below L3 it is a preview. */
export function graduationCandidates(orgId: string): GraduationCandidate[] {
  const db = getDB(orgId);
  const enforced = atLeast(levelOfOrg(db.org), 'l3');
  return db.agents.flatMap((a) => a.tools.filter((tool) => isWriteType(db, tool)).map((tool): GraduationCandidate => {
    const g = grantFor(db.platform.grants, a.slug, tool);
    const level: AutonomyLevel = g?.level ?? 'A0';
    const precedent = precedentOf(db, a.slug, tool);
    const checks = graduationChecks(precedent);
    const met = checks.every((c) => c.met);
    const open = db.platform.proposals.find((p) => p.status === 'open' && p.agentSlug === a.slug && p.tool === tool);
    const cooldown = cooldownFor(db.platform.grants, a.slug, tool);
    const whyNot = !enforced ? `Graduation starts at ${LEVEL_INFO.l3.label}.`
      : isRetiredAgent(db, a.slug) ? 'This agent is retired.'
      : level === GRADUATION.to ? (isSupervised(g) ? `Graduated to A3; supervised until ${new Date(g!.supervisedUntil!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : 'Already at A3.')
      : level !== GRADUATION.from ? `Graduation is from A2 Propose; this write type is at ${autonomyLabel(g?.level, !!g)}.`
      : open ? 'A proposal is waiting for a second person.'
      : cooldown ? `Revoked ${new Date(cooldown.revokedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${cooldown.automatic ? ' automatically, on a breach' : ''}. It can be proposed again from ${new Date(cooldown.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (30-day cooldown).`
      : !met ? 'The record does not meet every threshold yet.'
      : undefined;
    return { agentSlug: a.slug, agentName: a.name, tool, tags: tagsOfTool(db, tool), level, hasGrant: !!g, grant: g, precedent, checks, met, eligible: !whyNot, whyNot, openProposalId: open?.id, cooldownUntil: cooldown?.until, cooldownAutomatic: cooldown?.automatic };
  }));
}

/**
 * Revoke a graduation — one press by one person (any owner or admin), effective at once, a receipt. The tool falls
 * back to its A2 starting level. The starting level itself is not a grant a person made, so it is not revoked
 * here (pausing the agent stops its writes).
 */
export function revokeGrant(orgId: string, grantId: string, userId: string) {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  const g = db.platform.grants.find((x) => x.id === grantId);
  if (!g) throw new Error('No such grant.');
  if (g.revokedAt) throw new Error('This grant is already revoked.');
  if (g.origin === 'start') throw new Error('A2 Propose is the starting level, not a grant to revoke. To stop this agent writing, pause it.');
  const supervised = isSupervised(g);
  g.revokedAt = iso(Date.now());
  g.revokedBy = userId;
  const back = grantFor(db.platform.grants, g.agentSlug, g.tool);
  const r = append(db, { kind: 'admin', actor: userId, action: 'autonomy.revoked', agent: g.agentSlug, details: { tool: g.tool, level: g.level, falls_back_to: back?.level ?? 'A0', ...(supervised ? { in_supervised_period: true } : {}), cooldown_days: 30 } });
  touch(orgId, 'autonomy');
  return { grant: clone(g), seq: r.seq, fallsBackTo: (back?.level ?? 'A0') as AutonomyLevel };
}

/** Graduation proposals (open and decided). Each was proposed by a person; none is derived or recommended. */
export function graduationProposals(orgId: string): GraduationProposal[] {
  const db = getDB(orgId);
  if (!atLeast(levelOfOrg(db.org), 'l3')) return [];
  return clone([...db.platform.proposals].sort((a, b) => (a.status === 'open' ? -1 : 1) - (b.status === 'open' ? -1 : 1) || b.createdAt.localeCompare(a.createdAt)));
}

const proposerOf = (p: GraduationProposal) => p.proposedBy ?? p.decisions[0]?.userId;

/**
 * An owner or admin proposes graduating an agent's write type from A2 to A3. Only when the record meets every
 * threshold (≥ 90 days, ≥ 200 records, ≥ 100 approvals). The justification is the proposer's own words, never
 * pre-filled. Writes autonomy.graduation_proposed; a different owner or admin then approves or declines.
 */
export function proposeGraduation(orgId: string, input: { agentSlug: string; tool: string; justification: string }, userId: string): GraduationProposal {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'Graduation');
  requireRole(orgId, userId, ['owner', 'admin']);
  const c = graduationCandidates(orgId).find((x) => x.agentSlug === input.agentSlug && x.tool === input.tool);
  if (!c) throw new Error(`${input.tool} is not a write type of ${input.agentSlug}.`);
  if (c.whyNot) throw new Error(c.whyNot === 'The record does not meet every threshold yet.' ? `The record does not meet every threshold: ${c.checks.filter((k) => !k.met).map((k) => `${k.label.toLowerCase()} ${k.value} of ${k.need}`).join(', ')}.` : c.whyNot);
  const why = input.justification.trim();
  if (why.length < 10) throw new Error('Write the justification yourself: what you checked in the record (10 characters or more).');
  const p = c.precedent;
  const r = append(db, { kind: 'admin', actor: userId, action: 'autonomy.graduation_proposed', agent: input.agentSlug, details: { tool: input.tool, from: GRADUATION.from, to: GRADUATION.to, days: p.days, records: p.records, approvals: p.approvals, rejections: p.rejections, reversals: p.reversals, justification: why } });
  const prop: GraduationProposal = {
    id: `gp_${randHex(5)}`, agentSlug: input.agentSlug, tool: input.tool, from: GRADUATION.from, to: GRADUATION.to, evidence: evidenceOf(p),
    createdAt: r.ts, status: 'open', required: 2, proposedBy: userId, decisions: [{ userId, approve: true, at: r.ts, note: why }], seq: r.seq,
  };
  db.platform.proposals.push(prop);
  touch(orgId, 'autonomy');
  return clone(prop);
}

/**
 * The second person decides. A different owner or admin than the proposer approves or declines (a decline needs a
 * note); the proposer may only withdraw. Approving re-checks the record and the A2 level now, then writes the A3
 * grant with a 30-day supervised period sampling 1 in 10 calls (autonomy.graduated, naming both people).
 */
export function decideGraduation(orgId: string, id: string, approve: boolean, userId: string, note: string) {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'Graduation');
  requireRole(orgId, userId, ['owner', 'admin']);
  const prop = db.platform.proposals.find((x) => x.id === id);
  if (!prop) throw new Error('No such proposal.');
  if (prop.status !== 'open') throw new Error('This proposal is already decided.');
  const proposer = proposerOf(prop);
  const text = note.trim();
  const now = Date.now();
  if (userId === proposer) {
    if (approve) throw new Error('You proposed this graduation. A different owner or admin approves it.');
    prop.status = 'withdrawn';
    prop.decisions.push({ userId, approve: false, at: iso(now), note: text || 'Withdrawn by the proposer.' });
    prop.seq = append(db, { kind: 'admin', actor: userId, action: 'autonomy.graduation_withdrawn', agent: prop.agentSlug, details: { tool: prop.tool, from: prop.from, to: prop.to } }).seq;
  } else if (!approve) {
    if (text.length < 4) throw new Error('Say why you decline — the note is recorded.');
    prop.status = 'declined';
    prop.decisions.push({ userId, approve: false, at: iso(now), note: text });
    prop.seq = append(db, { kind: 'admin', actor: userId, action: 'autonomy.graduation.declined', agent: prop.agentSlug, details: { tool: prop.tool, from: prop.from, to: prop.to, note: text } }).seq;
  } else {
    const current = grantFor(db.platform.grants, prop.agentSlug, prop.tool, now);
    if (current?.level !== GRADUATION.from) throw new Error(`${prop.tool} is no longer at A2 Propose, so it cannot graduate. Decline this proposal.`);
    if (isRetiredAgent(db, prop.agentSlug)) throw new Error(`${prop.agentSlug} is retired.`);
    const p = precedentOf(db, prop.agentSlug, prop.tool, now);
    const missing = graduationChecks(p).filter((k) => !k.met);
    if (missing.length) throw new Error(`The record no longer meets every threshold: ${missing.map((k) => `${k.label.toLowerCase()} ${k.value} of ${k.need}`).join(', ')}.`);
    prop.decisions.push({ userId, approve: true, at: iso(now), note: text });
    prop.evidence = evidenceOf(p);
    const until = iso(now + GRADUATION.supervisedDays * D);
    const r = append(db, {
      kind: 'admin', actor: userId, action: 'autonomy.graduated', agent: prop.agentSlug,
      details: { tool: prop.tool, from: prop.from, to: prop.to, proposed_by: proposer ?? '', approved_by: userId, supervised_until: until, sample: `1 in ${GRADUATION.sampleEvery}`, days: p.days, records: p.records, approvals: p.approvals },
    });
    db.platform.grants.push({
      id: `gr_${randHex(5)}`, agentSlug: prop.agentSlug, tool: prop.tool, level: GRADUATION.to, grantedBy: userId, grantedAt: r.ts, seq: r.seq,
      reason: `Graduated A2 → A3: proposed by ${userName(proposer)}, approved by ${userName(userId)}. Record: ${p.days} days, ${p.records} records, ${p.approvals} approvals.`,
      origin: 'graduation', graduationId: prop.id, supervisedUntil: until, sampleEvery: GRADUATION.sampleEvery,
    });
    prop.status = 'granted';
    prop.seq = r.seq;
  }
  touch(orgId, 'autonomy');
  return clone(prop);
}

/* ── The supervised period: 1 in 10 calls sampled for a person ── */

export interface SampledCall { seq: number; ts: string; decision?: Decision; ruleId?: string; summary?: string; review?: SampleReview }

export interface SupervisionRow {
  grant: AutonomyGrant;
  /** still inside the 30 days and not revoked */
  active: boolean;
  /** end of the period (or the revocation, if earlier) */
  endsAt: string;
  /** decision receipts for the agent and tool since the graduation, inside the period */
  calls: number;
  sampled: SampledCall[];
  reviewed: number;
  concerns: number;
}

/** The calls of one graduated grant's supervised period, and every `sampleEvery`th one (the 1st, 11th, 21st …). */
function supervisionOf(db: OrgDB, g: AutonomyGrant, t = Date.now()): SupervisionRow {
  const every = g.sampleEvery ?? GRADUATION.sampleEvery;
  const start = new Date(g.grantedAt).getTime();
  const end = Math.min(new Date(g.supervisedUntil!).getTime(), g.revokedAt ? new Date(g.revokedAt).getTime() : Infinity);
  const calls = db.receipts.filter((r) => r.kind === 'decision' && r.agent === g.agentSlug && r.tool === g.tool && new Date(r.ts).getTime() >= start && new Date(r.ts).getTime() < end);
  const reviews = (db.platform.sampleReviews ?? []).filter((x) => x.grantId === g.id);
  const sampled = calls.filter((_, i) => i % every === 0).map((r): SampledCall => ({ seq: r.seq, ts: r.ts, decision: r.decision, ruleId: r.rule_id, summary: r.args_summary ? Object.entries(r.args_summary).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') : undefined, review: reviews.find((x) => x.seq === r.seq) }));
  return { grant: clone(g), active: end > t, endsAt: iso(end), calls: calls.length, sampled, reviewed: sampled.filter((x) => x.review).length, concerns: sampled.filter((x) => x.review && !x.review.ok).length };
}

/** Every graduated grant with its supervised period, the ones still running first. */
export function supervisionView(orgId: string): SupervisionRow[] {
  const db = getDB(orgId);
  if (!atLeast(levelOfOrg(db.org), 'l3')) return [];
  return db.platform.grants.filter((g) => g.origin === 'graduation' && g.supervisedUntil).map((g) => supervisionOf(db, g))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.grant.grantedAt.localeCompare(a.grant.grantedAt));
}

/**
 * A person reviews a sampled call (owner, admin or approver). OK, or a concern with a note; a concern does not
 * revoke on its own — revoking is a separate press. Writes autonomy.sample_reviewed.
 */
export function reviewSample(orgId: string, input: { grantId: string; seq: number; ok: boolean; note: string }, userId: string): SampleReview {
  const db = getDB(orgId);
  requireLevel(db, 'l3', 'The supervised period');
  requireRole(orgId, userId, ['owner', 'admin', 'approver']);
  const g = db.platform.grants.find((x) => x.id === input.grantId && x.origin === 'graduation');
  if (!g) throw new Error('No such graduation.');
  const row = supervisionOf(db, g);
  const call = row.sampled.find((x) => x.seq === input.seq);
  if (!call) throw new Error(`Receipt #${input.seq} is not one of the sampled calls of this graduation.`);
  if (call.review) throw new Error(`Receipt #${input.seq} was already reviewed by ${userName(call.review.by)}.`);
  const note = input.note.trim();
  if (!input.ok && note.length < 4) throw new Error('Say what concerns you — the note is recorded.');
  const r = append(db, { kind: 'admin', actor: userId, action: 'autonomy.sample_reviewed', agent: g.agentSlug, details: { tool: g.tool, call_seq: input.seq, outcome: input.ok ? 'ok' : 'concern', ...(note ? { note } : {}) } });
  const review: SampleReview = { grantId: g.id, seq: input.seq, by: userId, at: r.ts, ok: input.ok, note, reviewSeq: r.seq };
  (db.platform.sampleReviews ??= []).push(review);
  touch(orgId, 'autonomy');
  return clone(review);
}

/* ── Seeded autonomy (L3 and Sovereign organisations) ── */

/**
 * Every write type starts at A2 at L3 (or at the agent's registration, if later). The record behind each
 * graduation is kept as counts (the console holds a sample of the chain). Two graduations happened (one still in
 * its supervised period on L3 organisations that reached L3 recently), one proposal waits for a second person, one
 * write type is eligible and not yet proposed, and one is close but short of approvals.
 */
function seedAutonomy(db: OrgDB, st: PlatformState, l3: number, owner: string, admin: string) {
  const now = Date.now();
  for (const a of db.agents) startLevels(db, Math.max(l3, new Date(a.createdAt).getTime()), [a.slug]);
  const asOf = db.receipts[db.receipts.length - 1]?.ts ?? iso(now);
  const created = (demo: string) => new Date(db.agents.find((a) => a.slug === s(db, demo))?.createdAt ?? iso(now - 200 * D)).getTime();
  st.precedent = {};
  const base = (demo: string, tool: string, records: number, approvals: number, rejections: number, reversals = 0) => {
    st.precedent![pairKey(s(db, demo), tool)] = { since: iso(created(demo)), records, approvals, rejections, reversals, asOf };
  };
  base('invoice-bot', 'zoho_books.create_bill', 486, 141, 3);
  base('invoice-bot', 'zoho_books.record_payment', 412, 163, 4, 1);
  base('invoice-bot', 'gmail.send_email', 233, 112, 1);
  base('collections-agent', 'gmail.send_email', 236, 118, 2);
  base('collections-agent', 'gmail.create_draft', 214, 61, 0);

  const graduate = (demo: string, tool: string, at: number, proposer: string, approver: string, ev: { days: number; records: number; approvals: number; rejections: number; reversals: number }, why: string, ok: string) => {
    const agentSlug = s(db, demo);
    const id = `gp_${agentSlug}_${tool.replace(/\./g, '_')}_A3`;
    st.proposals.push({
      id, agentSlug, tool, from: GRADUATION.from, to: GRADUATION.to, evidence: { ...ev, counterparties: 0, medianMinutesToDecide: 0 }, createdAt: iso(at - 2 * D), status: 'granted', required: 2, proposedBy: proposer,
      decisions: [{ userId: proposer, approve: true, at: iso(at - 2 * D), note: why }, { userId: approver, approve: true, at: iso(at), note: ok }],
    });
    st.grants.push({
      id: `gr_${agentSlug}_${tool}_a3`.replace(/\./g, '_'), agentSlug, tool, level: GRADUATION.to, grantedBy: approver, grantedAt: iso(at), origin: 'graduation', graduationId: id,
      supervisedUntil: iso(at + GRADUATION.supervisedDays * D), sampleEvery: GRADUATION.sampleEvery,
      reason: `Graduated A2 → A3: proposed by ${userName(proposer)}, approved by ${userName(approver)}. Record: ${ev.days} days, ${ev.records} records, ${ev.approvals} approvals.`,
    });
  };
  // bills: graduated shortly after L3 (or once 90 days had run), so its supervised period has ended or nearly ended
  const billAt = Math.max(l3 + 3 * D, created('invoice-bot') + 92 * D);
  graduate('invoice-bot', 'zoho_books.create_bill', billAt, owner, admin, { days: Math.floor((billAt - created('invoice-bot')) / D), records: 431, approvals: 127, rejections: 3, reversals: 0 },
    'Bills are created from matched invoices only; 127 approvals with 3 rejections, none reversed.', 'Checked the rejections: all duplicate invoices the rulebook now refuses.');
  // payments: graduated 9 days ago, still in its supervised period (1 in 10 calls sampled)
  const payAt = Math.max(now - 9 * D, l3 + 1 * D, created('invoice-bot') + 92 * D);
  graduate('invoice-bot', 'zoho_books.record_payment', payAt, admin, owner, { days: Math.floor((payAt - created('invoice-bot')) / D), records: 396, approvals: 158, rejections: 4, reversals: 1 },
    'Payments to approved vendors; the one reversal was a bank-side failure, not the agent.', 'Agreed. The rulebook still holds payments above its limit for a person.');
  // a proposal waiting for a second person (proposed by an admin; the owner or another admin decides)
  const mailAgent = s(db, 'collections-agent');
  const mail = precedentOf(db, mailAgent, 'gmail.send_email', now - 1 * D);
  if (grantFor(st.grants, mailAgent, 'gmail.send_email', now)?.level === GRADUATION.from && mail.days >= GRADUATION.minDays) {
    st.proposals.push({
      id: `gp_${mailAgent}_gmail_send_email_A3`, agentSlug: mailAgent, tool: 'gmail.send_email', from: GRADUATION.from, to: GRADUATION.to, evidence: evidenceOf(mail),
      createdAt: iso(now - 1 * D), status: 'open', required: 2, proposedBy: admin,
      decisions: [{ userId: admin, approve: true, at: iso(now - 1 * D), note: 'Payment reminders only, from the approved templates; 2 rejections in 118 approvals, both wording.' }],
    });
  }
  // one sampled call already reviewed on the payments graduation
  const pay = st.grants.find((g) => g.agentSlug === s(db, 'invoice-bot') && g.tool === 'zoho_books.record_payment' && g.origin === 'graduation');
  const first = pay ? supervisionOf(db, pay, now).sampled[0] : undefined;
  if (pay && first) st.sampleReviews = [{ grantId: pay.id, seq: first.seq, by: p(db, 'u_venkat'), at: iso(Math.min(now, new Date(first.ts).getTime() + 3 * H)), ok: true, note: 'Right vendor, right amount, matched to the bill.' }];
}

/* ══ Regulatory packs ═══════════════════════════════════════════════════ */

export const DRY_RUN_NOTE = 'Dry run — no regulatory claim until L2';

const PACK_MATCH: Record<PackId, (r: Receipt) => boolean> = {
  ledger1: (r) => r.kind === 'decision' && !!r.tool?.startsWith('zoho_books.'),
  invoice1: (r) => r.kind === 'decision' && (r.tool === 'zoho_books.create_bill' || r.tool === 'zoho_books.record_payment' || r.tool === 'zoho_books.delete_bill'),
  collect1: (r) => r.kind === 'decision' && r.tool === 'gmail.send_email' && r.args_summary?.template !== undefined,
};

export function packsView(orgId: string): RegulatoryPack[] {
  const db = getDB(orgId);
  return PACKS.map((pk) => {
    const inst = db.platform.packs.find((x) => x.id === pk.id);
    const rs = db.receipts.filter(PACK_MATCH[pk.id]);
    return { ...clone(pk), installed: !!inst, installedAt: inst?.installedAt, installedBy: inst?.installedBy, dryRun: !atLeast(levelOfOrg(db.org), 'l2'), coverage:{ writes: rs.length, refusals: rs.filter((r) => r.decision === 'refuse').length, lastAt: rs[rs.length - 1]?.ts } };
  });
}

/** Packs install from L1 as a dry run (no regulatory claim, not billed) and run live from L2 (decision 5). */
export function installPack(orgId: string, id: PackId, userId: string) {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  if (!packById(id)) throw new Error('No such pack.');
  if (db.platform.packs.some((x) => x.id === id)) throw new Error(`${id} is already installed.`);
  assertPilotWritable(orgId, userId, 'pack.installed'); // read-only after a pilot's hard stop
  const dryRun = !atLeast(levelOfOrg(db.org), 'l2');
  db.platform.packs.push({ id, installedAt: iso(Date.now()), installedBy: userId });
  append(db, { kind: 'admin', actor: userId, action: 'pack.installed', details: { pack: id, profile: packById(id)!.profileId, mode: dryRun ? 'dry_run' : 'live', price_per_year: dryRun ? 0 : 135000 } });
  deriveBilling(db);
  touch(orgId, 'pack');
  return packsView(orgId).find((x) => x.id === id)!;
}

const istTime = (ts: string) => new Date(new Date(ts).getTime() + 5.5 * H).toISOString().replace('T', ' ').slice(0, 19);
const csvCell = (v: unknown) => { const t = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

/** Generate a regime export from the chain (e.g. the MCA audit-trail register as CSV). Writes a pack.exported receipt. */
export function packExport(orgId: string, packId: PackId, exportId: string, userId: string): PackExport {
  const db = getDB(orgId);
  const pk = packById(packId);
  if (!pk) throw new Error('No such pack.');
  if (!db.platform.packs.some((x) => x.id === packId)) throw new Error(`Install ${packId} first.`);
  const res = (seq: number) => db.receipts.find((x) => x.kind === 'approval' && x.ref_seq === seq);
  const rows: unknown[][] = [];
  let header: string[] = [];
  let text = '';
  let mime = 'text/csv';
  if (exportId === 'mca-audit-trail-csv') {
    header = ['seq', 'recorded_at_ist', 'record', 'change', 'actor', 'actor_kind', 'rulebook_version', 'decision', 'approved_by', 'receipt_hash'];
    for (const r of db.receipts.filter((x) => (x.tool?.startsWith('zoho_books.') && x.kind !== 'outcome') || x.action === 'rulebook.published')) {
      rows.push([r.seq, istTime(r.ts), recordIdOf(r), r.tool ?? r.action, r.agent ?? r.actor, r.kind === 'decision' ? 'agent' : r.actor === 'system' ? 'system' : 'human', r.rulebook?.version ?? r.details?.version ?? '', r.decision ?? 'recorded', r.kind === 'decision' ? userName(res(r.seq)?.approval?.approver) : '', r.hash]);
    }
  } else if (exportId === 'mca-edit-log-json') {
    mime = 'application/json';
    const log = db.receipts.filter((r) => r.kind === 'admin').map((r) => ({ seq: r.seq, at: r.ts, by: userName(r.actor), action: r.action, details: r.details, hash: r.hash }));
    text = JSON.stringify({ pack: 'ledger1', organisation: db.org.name, generated_at: iso(Date.now()), entries: log }, null, 2);
    rows.push(...log.map((x) => [x.seq]));
  } else if (exportId === 'gst-register-csv') {
    header = ['seq', 'recorded_at_ist', 'document', 'type', 'counterparty', 'amount_inr', 'decision', 'approved_by', 'receipt_hash'];
    for (const r of db.receipts.filter(PACK_MATCH.invoice1)) rows.push([r.seq, istTime(r.ts), r.args_summary?.bill ?? r.args_summary?.invoice ?? '', r.tool, r.args_summary?.vendor ?? r.args_summary?.counterparty ?? '', r.args_summary?.amount ?? '', r.decision, userName(res(r.seq)?.approval?.approver), r.hash]);
  } else if (exportId === 'rbi-conduct-csv') {
    header = ['seq', 'contact_time_ist', 'within_08_19', 'template', 'customer_domain', 'decision', 'approved_by', 'receipt_hash'];
    for (const r of db.receipts.filter(PACK_MATCH.collect1)) {
      const h = new Date(new Date(r.ts).getTime() + 5.5 * H).getUTCHours();
      rows.push([r.seq, istTime(r.ts), h >= 8 && h < 19 ? 'yes' : 'no', r.args_summary?.template, r.args_summary?.to_domain ?? '', r.decision, userName(res(r.seq)?.approval?.approver), r.hash]);
    }
  } else throw new Error(`No export ${exportId} in ${packId}.`);
  // at L1 every report says so in its first line: the rules ran, but the records are not yet L2 evidence
  const dryRun = !atLeast(levelOfOrg(db.org), 'l2');
  if (!text) text = [...(dryRun ? [`# ${DRY_RUN_NOTE}`] : []), header.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');
  else if (dryRun) text = JSON.stringify({ dry_run: DRY_RUN_NOTE, ...JSON.parse(text) }, null, 2);
  const r = append(db, { kind: 'admin', actor: userId, action: 'pack.exported', details: { pack: packId, export: exportId, rows: rows.length, mode: dryRun ? 'dry_run' : 'live' } });
  return { packId, exportId, filename: `${packId}-${exportId}${dryRun ? '-dry-run' : ''}-${db.org.slug}-${new Date().toISOString().slice(0, 10)}.${mime === 'text/csv' ? 'csv' : 'json'}`, mime, text, rows: rows.length, seq: r.seq };
}

/* ══ DPDP erasure ═══════════════════════════════════════════════════════ */

export function erasuresView(orgId: string) {
  const db = getDB(orgId);
  // erasure is available from L1 (decision 6c): every record is salted from the first L1 record
  return { enabled: true, requests: clone(db.platform.erasures), destroyedSalts: Object.keys(db.platform.erased).length };
}

/** Open an erasure request. The identifier is hashed at once and never stored. Matching receipts are listed. */
export function createErasure(orgId: string, input: { subjectRef: string; identifier: string; reason: string }, userId: string): ErasureRequest {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  const needle = input.identifier.trim().toLowerCase();
  if (needle.length < 3) throw new Error('Enter the identifier to search for (an email domain, customer name or record id).');
  const seqs = db.receipts.filter((r) => r.kind === 'decision' && !r.redacted && JSON.stringify(r.args_summary ?? {}).toLowerCase().includes(needle)).map((r) => r.seq);
  const now = Date.now();
  const e: ErasureRequest = { id: `er_${randHex(5)}`, subjectRef: input.subjectRef.trim() || `DP-${new Date().getFullYear()}-${randHex(2).toUpperCase()}`, subjectHash: sha256Hex(needle), reason: input.reason.trim(), requestedBy: userId, requestedAt: iso(now), dueAt: iso(now + 72 * H), affectedSeqs: seqs, affected: seqs.length, required: 2, approvals: [], status: 'awaiting_approval' };
  db.platform.erasures.unshift(e);
  const r = append(db, { kind: 'admin', actor: userId, action: 'erasure.requested', details: { request: e.id, subject_hash: e.subjectHash.slice(0, 16), affected: e.affected } });
  e.seq = r.seq;
  return clone(e);
}

/** Approve an erasure: two different people, neither the requester. */
export function approveErasure(orgId: string, id: string, userId: string): ErasureRequest {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  const e = db.platform.erasures.find((x) => x.id === id);
  if (!e) throw new Error('No such erasure request.');
  if (e.status !== 'awaiting_approval') throw new Error('This request is not waiting for approval.');
  if (e.requestedBy === userId) throw new Error('The person who opened the request cannot approve it. Two other people approve.');
  if (e.approvals.some((a) => a.userId === userId)) throw new Error('You have already approved this request. A different person must give the second approval.');
  e.approvals.push({ userId, at: iso(Date.now()) });
  if (e.approvals.length >= e.required) e.status = 'approved';
  append(db, { kind: 'admin', actor: userId, action: 'erasure.approved', details: { request: id, approvals: e.approvals.length, required: e.required } });
  return clone(e);
}

function executeErasureOn(db: OrgDB, st: PlatformState, e: ErasureRequest, userId: string, at: number, writeReceipt: boolean) {
  const existing = db.receipts.map((x) => x.seq);
  for (const seq of e.affectedSeqs) {
    const i = db.receipts.findIndex((x) => x.seq === seq);
    const r = db.receipts[i];
    if (!r || st.erased[seq]) continue;
    const salt = saltOf(st, seq)!;
    // F14 and F12 are frozen as sealed; then the salt is destroyed for good
    (st.erasedRecordIds ??= {})[seq] = sealedRecordId(r, salt);
    st.erased[seq] = payloadHash(salt, payloadOf(r));
    destroySalt(st, seq, existing);
    // the values the rules inspected leave the organisation's own chain too: the receipt keeps its hash and
    // signature, and the organisation's key signs the redacted copy so nothing left in it can be changed
    db.receipts[i] = redactReceipt(db, r, st.erased[seq], e.subjectRef, iso(at));
  }
  if (db.platform === st) persist(db.org.id);
  e.status = 'executed';
  e.executedAt = iso(at);
  e.executedBy = userId;
  // the chain still verifies: re-check the affected range and the seals' digests
  if (e.affectedSeqs.length) {
    const lo = Math.min(...e.affectedSeqs);
    const hi = Math.max(...e.affectedSeqs);
    const range = db.receipts.filter((r) => r.seq >= lo && r.seq <= hi).slice(0, 400);
    const chainOk = verifyChain(range, db.publicKeys, []).result === 'verified';
    const sealsOk = e.affectedSeqs.slice(0, 50).every((q) => { const sl = db.platform === st ? sealOf(db, q) : undefined; return !sl || digestOfFields(sl.fields) === sl.digest; });
    e.chainStillVerifies = chainOk && sealsOk;
  } else e.chainStillVerifies = true;
  if (writeReceipt) {
    const r = append(db, { kind: 'admin', actor: userId, action: 'erasure.executed', details: { request: e.id, salts_destroyed: e.affectedSeqs.length, chain_verifies: !!e.chainStillVerifies } });
    e.seq = r.seq;
  }
}

/** Execute an approved erasure inside its 72-hour clock: destroy the salts. Payload hashes become unlinkable; the chain still verifies. */
export function executeErasure(orgId: string, id: string, userId: string): ErasureRequest {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  const e = db.platform.erasures.find((x) => x.id === id);
  if (!e) throw new Error('No such erasure request.');
  if (e.status !== 'approved') throw new Error(e.status === 'executed' ? 'Already executed.' : `Needs ${e.required} approvals first (${e.approvals.length} so far).`);
  executeErasureOn(db, db.platform, e, userId, Date.now(), true);
  touch(orgId, 'erasure');
  return clone(e);
}

/* ══ Approvals: escalation and single-use links ═════════════════════════ */

export function escalationView(orgId: string) {
  const db = getDB(orgId);
  const recent = db.approvals.filter((a) => a.escalations?.length).flatMap((a) => a.escalations!.map((e) => ({ ...e, approvalId: a.id, headline: a.headline, status: a.status }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  return { policies: clone(db.platform.escalation), groups: effectiveGroupsOf(db), recent };
}

export function setEscalation(orgId: string, groupId: string, patch: Partial<Pick<EscalationPolicy, 'afterMinutes' | 'backupGroupId' | 'enabled'>>, userId: string): EscalationPolicy {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  const pol = db.platform.escalation.find((x) => x.groupId === groupId);
  if (!pol) throw new Error('No such approver group.');
  if (patch.backupGroupId === groupId) throw new Error('The backup group must be a different group.');
  if (patch.afterMinutes !== undefined && (patch.afterMinutes < 5 || patch.afterMinutes > 7 * 24 * 60)) throw new Error('Choose between 5 minutes and 7 days.');
  Object.assign(pol, patch);
  if (patch.backupGroupId) pol.backupGroupName = effectiveGroupOf(db, patch.backupGroupId)?.name ?? patch.backupGroupId;
  append(db, { kind: 'admin', actor: userId, action: 'escalation.updated', details: { group: pol.groupId, after_minutes: pol.afterMinutes, backup: pol.backupGroupId, enabled: pol.enabled } });
  return clone(pol);
}

/** Applied on every live tick: a pending approval older than its group's limit is re-routed once to the backup group. */
export function runEscalations(db: OrgDB): number {
  // fail closed: while the approvals service is down nothing is re-routed (mock/approvalsExt outage)
  if (approvalsDown(db)) return 0;
  let n = 0;
  const now = Date.now();
  for (const a of db.approvals) {
    if (a.status !== 'pending' || a.escalations?.some((e) => e.by === 'system')) continue;
    if (a.heldByStop) continue; // nobody can decide it while the stop holds it; re-routing would only add noise
    const g = effectiveGroupOf(db, a.approverGroup);
    const pol = db.platform?.escalation.find((x) => x.groupId === g?.id);
    if (!pol?.enabled) continue;
    if (now - new Date(a.createdAt).getTime() < pol.afterMinutes * 60_000) continue;
    const backup = effectiveGroupOf(db, pol.backupGroupId) ?? effectiveGroupOf(db, pol.backupGroupName);
    const to = backup?.name ?? pol.backupGroupName;
    a.originalGroup ??= a.approverGroup;
    const from = a.approverGroup;
    a.approverGroup = to;
    // the backup group is told through the saved routing for approval.escalated
    const reach = recipientsOf(db, 'approval.escalated', to);
    const r = append(db, { kind: 'admin', actor: 'system', action: 'approval.escalated', agent: a.agentSlug, details: { approval: a.id, from, to, after_minutes: pol.afterMinutes, notified: channelsOf(reach).join(','), notified_people: reach.filter((x) => x.email || x.slack || x.whatsapp).length } });
    (a.escalations ??= []).push({ at: r.ts, from, to, by: 'system', afterMinutes: pol.afterMinutes, seq: r.seq });
    // the backup group gets single-use links like the first hold (email always, chat where allowed, never chat at
    // Sovereign) and an approval.notified receipt with reason escalated — deferred, like mock/approvalNotify's first round
    { const orgId = db.org.id; const id = a.id; const seq = r.seq; setTimeout(() => { void import('./approvalNotify').then((m) => m.notifyRoutedApproval(orgId, id, 'escalated', seq)).catch(() => undefined); }, 0); }
    a.notified = Array.from(new Set([...a.notified, ...channelsOf(reach)])) as Channel[];
    a.notifiedTo = [...(a.notifiedTo ?? []), ...reach.filter((x) => !(a.notifiedTo ?? []).some((y) => y.userId === x.userId)).map((x) => ({ userId: x.userId, channels: recipientChannels(x) }))];
    pol.triggered++;
    pol.lastTriggeredAt = r.ts;
    n++;
  }
  if (n) touch(db.org.id, 'approval');
  return n;
}

/**
 * Issue a single-use approval link for a person (phone, email or chat). At Sovereign (deny-all egress) a Slack or
 * WhatsApp link is refused before anything else; with the person who asked (`byUserId`) the attempt is recorded
 * like any other blocked destination (egress log and an egress.blocked receipt).
 */
export function issueApprovalLink(orgId: string, approvalId: string, issuedTo: string, channel: Channel = 'phone_link', byUserId?: string): ApprovalLinkToken {
  const db = getDB(orgId);
  if (db.org.deployment === 'sovereign' && (channel === 'slack' || channel === 'whatsapp')) {
    const host = channel === 'slack' ? 'hooks.slack.com' : 'graph.facebook.com';
    if (byUserId) guardDestination(orgId, host, `Approval link (${channel === 'slack' ? 'Slack' : 'WhatsApp'})`, byUserId);
    throw new Error(`No link was sent. Egress is denied: ${channel === 'slack' ? 'Slack' : 'WhatsApp'} is outside ${db.org.name}’s network. Send the link by email; it goes through your own mail relay.`);
  }
  const a = db.approvals.find((x) => x.id === approvalId);
  if (!a) throw new Error('No such approval.');
  if (a.status !== 'pending') throw new Error('This approval is no longer waiting.');
  if (approvalsDown(db)) throw new Error(`No link was sent. ${APPROVALS_DOWN_SENTENCE}`);
  if (Date.now() >= new Date(a.expiresAt).getTime()) {
    expireDue(orgId);
    throw new Error('No link was sent. This approval expired; expiry is a refusal.');
  }
  const blocked = decisionBlocked(orgId, a);
  if (blocked) throw new Error(`No link was sent. ${blocked}`);
  // a link goes only to someone who may decide: a current member of the group (or one it was escalated from), or an owner
  const allowed = allowedApprovers(orgId, a, issuedTo);
  const role = memberRole(orgId, issuedTo);
  const owner = role === 'owner';
  if (!can(role, 'approvals.decide')) throw new Error(`${userName(issuedTo)} holds no role here that decides approvals, so a link would not let them decide.`);
  if (!allowed.includes(issuedTo) && !owner) throw new Error(`${userName(issuedTo)} is not in the ${a.approverGroup} approver group as it is now, so a link would not let them decide. Send it to a current member, or ask an owner to re-route the approval.`);
  const t: ApprovalLinkToken = { token: `lnk.${db.org.slug}.${randHex(12)}`, orgId, approvalId, issuedTo, channel, issuedAt: iso(Date.now()), expiresAt: a.expiresAt };
  db.platform.links.unshift(t);
  touch(orgId, 'approval');
  return clone(t);
}

export function resolveApprovalLink(token: string): ApprovalLinkToken & { approvalStatus: string } {
  const slug = token.split('.')[1];
  const org = ORGS.find((o) => o.slug === slug);
  if (!org) throw new Error('This link is not valid.');
  const db = getDB(org.id);
  const t = db.platform.links.find((x) => x.token === token);
  if (!t) throw new Error('This link is not valid.');
  return { ...clone(t), approvalStatus: db.approvals.find((a) => a.id === t.approvalId)?.status ?? 'unknown' };
}

/** Decide through a single-use link. A link works once; a second use is refused and nothing changes. */
export function decideByLink(token: string, approve: boolean, reason: string) {
  const t0 = resolveApprovalLink(token);
  const db = getDB(t0.orgId);
  const t = db.platform.links.find((x) => x.token === token)!;
  if (t.usedAt) throw new Error(`This link was already used at ${new Date(t.usedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. Links work once.`);
  // fail closed before expiry: nothing expires while the approvals service is down
  if (approvalsDown(db)) throw new Error(APPROVALS_DOWN_SENTENCE);
  if (new Date(t.expiresAt).getTime() < Date.now()) throw new Error('This link has expired.');
  const res = decideApproval(t.orgId, t.approvalId, approve, t.issuedTo, reason, t.channel, { link: token.slice(-8), single_use: true });
  t.usedAt = iso(Date.now());
  t.usedBy = t.issuedTo;
  t.usedSeq = res.receipt.seq;
  return { ...res, link: clone(t) };
}

/* ══ Dual control and the reviews queue ═════════════════════════════════ */

/** Ask a different person to review a rulebook draft (dual control). */
export function requestReview(orgId: string, rulebookId: string, userId: string, note: string): ReviewRequest {
  const db = getDB(orgId);
  if (!can(memberRole(orgId, userId), 'rulebooks.edit')) throw new Error('Owners and admins ask for rulebook reviews; your role cannot.');
  const rb = db.rulebooks.find((r) => r.id === rulebookId);
  if (!rb) throw new Error('No such rulebook.');
  const draft = rb.versions.find((v) => v.status !== 'published');
  if (!draft) throw new Error('There is no draft to review. Save a draft first.');
  draft.status = 'in_review';
  const existing = db.platform.reviews.find((x) => x.rulebookId === rulebookId && x.version === draft.version && x.status === 'pending');
  if (existing && existing.draftHash === draft.hash) return clone(existing);
  if (existing) { existing.status = 'changes_requested'; existing.decisionNote = 'The draft changed after the review was requested.'; }
  // the review is of this exact content: publishing under it must publish the same text
  const rv: ReviewRequest = { id: `rv_${rb.slug}_${draft.version}_${randHex(2)}`, kind: 'rulebook', rulebookId, slug: rb.slug, version: draft.version, requestedBy: userId, requestedAt: iso(Date.now()), note, status: 'pending', draftHash: draft.hash, rules: clone(draft.rules) };
  db.platform.reviews.unshift(rv);
  append(db, { kind: 'admin', actor: userId, action: 'review.requested', agent: rb.slug, details: { rulebook: rb.slug, version: draft.version } });
  touch(orgId, 'rulebook');
  return clone(rv);
}

/** Approve (or send back) a rulebook review. The reviewer must be a different person from the requester. */
export function approveReview(orgId: string, reviewId: string, userId: string, approve: boolean, note: string): ReviewRequest {
  const db = getDB(orgId);
  const rv = db.platform.reviews.find((x) => x.id === reviewId);
  if (!rv) throw new Error('No such review.');
  if (rv.status !== 'pending') throw new Error('This review is already decided.');
  if (rv.requestedBy === userId) throw new Error('A different person must review. You asked for this review.');
  if (!can(memberRole(orgId, userId), 'rulebooks.review')) throw new Error('Your role cannot review rulebooks.');
  const current = db.rulebooks.find((r) => r.id === rv.rulebookId)?.versions.find((x) => x.version === rv.version);
  if (rv.draftHash && current && current.hash !== rv.draftHash) throw new Error('The draft changed after this review was requested. Ask for a new review of the current draft.');
  rv.status = approve ? 'approved' : 'changes_requested';
  rv.reviewerId = userId;
  rv.decidedAt = iso(Date.now());
  rv.decisionNote = note;
  const rb = db.rulebooks.find((r) => r.id === rv.rulebookId);
  const v = rb?.versions.find((x) => x.version === rv.version);
  if (v) { v.reviewedBy = approve ? userId : undefined; if (!approve) v.status = 'draft'; }
  append(db, { kind: 'admin', actor: userId, action: approve ? 'review.approved' : 'review.changes_requested', agent: rv.slug, details: { rulebook: rv.slug, version: rv.version } });
  touch(orgId, 'rulebook');
  return clone(rv);
}

/** Everything waiting for a second person: rulebook reviews, assessment sign-offs, erasure approvals, graduation proposals. */
export function reviewsQueue(orgId: string, userId: string): ReviewItem[] {
  const db = getDB(orgId);
  const role = memberRole(orgId, userId);
  const enforced = atLeast(levelOfOrg(db.org), 'l2');
  const items: ReviewItem[] = [];
  for (const rv of db.platform.reviews.filter((x) => x.status === 'pending')) {
    const mine = rv.requestedBy === userId;
    items.push({ id: rv.id, kind: 'rulebook_review', title: `Review ${rv.slug} rulebook v${rv.version}`, detail: rv.note, requestedBy: rv.requestedBy, requestedAt: rv.requestedAt, route: `/rulebooks/${rv.slug}?tab=publish`, refId: rv.id, canAct: !mine && can(role, 'rulebooks.review'), whyNot: mine ? 'You asked for this review; a different person reviews it.' : !can(role, 'rulebooks.review') ? 'Your role cannot review rulebooks.' : undefined, enforced });
  }
  for (const a of db.assessments.filter((x) => x.status === 'submitted')) {
    const mine = a.authorId === userId;
    const sys = db.aiSystems.find((x) => x.id === a.aiSystemId);
    items.push({ id: `as_${a.id}`, kind: 'assessment_signoff', title: `Sign off ${a.template.replace('_', ' ')} assessment — ${sys?.name ?? a.aiSystemId}`, detail: `Scored ${a.score} of ${a.maxScore}; proposed tier ${a.resultTier}.`, requestedBy: a.authorId, requestedAt: a.submittedAt ?? a.createdAt, route: `/assessments/${a.id}`, refId: a.id, canAct: !mine && can(role, 'assessments.signoff'), whyNot: mine ? 'You wrote this assessment; a different person signs it off.' : !can(role, 'assessments.signoff') ? 'Your role cannot sign off assessments.' : undefined, enforced: true });
  }
  for (const e of db.platform.erasures.filter((x) => x.status === 'awaiting_approval' || x.status === 'approved')) {
    const mine = e.requestedBy === userId;
    const done = e.approvals.some((a) => a.userId === userId);
    const ownerAdmin = role === 'owner' || role === 'admin';
    items.push({ id: `er_${e.id}`, kind: 'erasure_approval', title: e.status === 'approved' ? `Execute erasure ${e.subjectRef}` : `Approve erasure ${e.subjectRef} (${e.approvals.length} of ${e.required})`, detail: `${e.affected} sealed receipts; the 72-hour clock ends ${new Date(e.dueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST.`, requestedBy: e.requestedBy, requestedAt: e.requestedAt, dueAt: e.dueAt, route: `/records/erasure?id=${e.id}`, refId: e.id, canAct: ownerAdmin && (e.status === 'approved' || (!mine && !done)), whyNot: !ownerAdmin ? 'Owners and admins approve erasures.' : e.status === 'approved' ? undefined : mine ? 'You opened this request; two other people approve it.' : done ? 'You have approved; a different person gives the second approval.' : undefined, enforced: true });
  }
  for (const pr of graduationProposals(orgId).filter((x) => x.status === 'open')) {
    const proposer = proposerOf(pr);
    const mine = proposer === userId;
    const ownerAdmin = role === 'owner' || role === 'admin';
    items.push({ id: pr.id, kind: 'graduation_proposal', title: `Graduate ${pr.agentSlug} to A3 for ${pr.tool}`, detail: `${pr.evidence.days} days, ${pr.evidence.records} records, ${pr.evidence.approvals} approvals (${pr.evidence.rejections} rejected, ${pr.evidence.reversals} reversed). Proposed by ${userName(proposer)}; a different owner or admin approves.`, requestedBy: proposer ?? 'system', requestedAt: pr.createdAt, route: `/agents/autonomy?proposal=${pr.id}`, refId: pr.id, canAct: ownerAdmin && !mine, whyNot: !ownerAdmin ? 'Owners and admins approve a graduation.' : mine ? 'You proposed this graduation; a different owner or admin approves it.' : undefined, enforced: true });
  }
  return items.sort((a, b) => Number(b.canAct) - Number(a.canAct) || (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9') || b.requestedAt.localeCompare(a.requestedAt));
}

/* ══ Meter ══════════════════════════════════════════════════════════════ */

/** The meter, from the chain: one event per governed action; refusals count 0.4 (40% of the per-action rate). */
export function meterView(orgId: string): MeterView {
  const db = getDB(orgId);
  const plan = PLANS[db.org.plan];
  const resolution = new Map<number, Receipt>();
  for (const r of db.receipts) if (r.kind === 'approval' && r.ref_seq) resolution.set(r.ref_seq, r);
  const decisions = db.receipts.filter((r) => r.kind === 'decision');
  const events: MeterEvent[] = decisions.map((r) => {
    let outcome: MeterEvent['outcome'] = r.decision === 'allow' ? 'committed' : r.decision === 'refuse' ? 'refused' : 'pending';
    if (r.decision === 'ask') {
      const res = resolution.get(r.seq);
      if (res) outcome = res.decision === 'allow' ? 'committed' : 'refused';
    }
    // a sandbox call (sk_sbx_) is metered at 0 (mock/billing.ts); so is a PLATFORM refusal (lib/platformRefusal.ts)
    return { id: `me_${db.org.id}_${r.seq}`, seq: r.seq, ts: r.ts, agent: r.agent, tool: r.tool, decision: r.decision!, outcome, quantity: r.environment === 'sandbox' || isPlatformRefusal(r) ? 0 : outcome === 'committed' ? 1 : outcome === 'refused' ? 0.4 : 0 };
  });
  const committed = events.filter((e) => e.outcome === 'committed').length;
  const refused = events.filter((e) => e.outcome === 'refused').length;
  const pending = events.filter((e) => e.outcome === 'pending').length;
  const units = events.reduce((n, e) => n + e.quantity, 0);
  // reconcile against the chain counted independently: decisions as recorded, plus the approval receipts that
  // resolved held calls (approved = 1, rejected or expired = 0.4), never through the meter's own resolution map
  const decisionSeqs = new Set(decisions.filter((r) => r.environment !== 'sandbox').map((r) => r.seq));
  let chainUnits = 0;
  for (const r of db.receipts) {
    if (r.kind === 'decision') chainUnits += r.environment === 'sandbox' || isPlatformRefusal(r) ? 0 : r.decision === 'allow' ? 1 : r.decision === 'refuse' ? 0.4 : 0;
    else if (r.kind === 'approval' && r.ref_seq !== undefined && decisionSeqs.has(r.ref_seq)) chainUnits += r.decision === 'allow' ? 1 : 0.4;
  }
  chainUnits = Math.round(chainUnits * 10) / 10;
  const meterUnits = Math.round(units * 10) / 10;
  const difference = Math.round((meterUnits - chainUnits) * 10) / 10;
  // months, invoices and the allowance year come from the chain meter, the one builder /billing uses (IST months)
  deriveBilling(db);
  const cmFy = chainMeter(db).fy;
  return {
    orgId, plan,
    window: { from: db.receipts[0].ts, to: db.receipts[db.receipts.length - 1].ts, decisions: decisions.length, committed, refused, pending, units: Math.round(units * 10) / 10, valueAtOverage: committed * plan.overageRate + refused * plan.refusalRate },
    events: events.slice(-200).reverse(),
    months: db.usage.map((u) => ({ ...u, source: 'chain' as const })),
    modelledNote: `Monthly volumes and the invoices are counted from this organisation’s chain (${decisions.length} governed actions since ${new Date(db.receipts[0].ts).toLocaleDateString('en-IN')}), in IST calendar months, by the same meter as the invoices on the Meter page.`,
    invoices: db.invoices,
    allowance: { included: cmFy.included, usedThisYear: Math.round(cmFy.units), remaining: Math.round(cmFy.remaining * 10) / 10, pct: cmFy.share },
    reconciliation: { meterEvents: events.length, chainDecisions: decisions.length, matched: events.length === decisions.length && difference === 0, difference, units: meterUnits, chainUnits, headSeq: db.receipts[db.receipts.length - 1].seq, digest: sha256Hex(events.map((e) => `${e.seq}:${e.quantity}`).join('|')), checkedAt: iso(Date.now()) },
  };
}

/* ══ Deployment, updates, residency ═════════════════════════════════════ */

export function deploymentView(orgId: string): DeploymentView {
  const db = getDB(orgId);
  const level = levelOfOrg(db.org);
  const sov = db.org.deployment === 'sovereign';
  const applied = db.platform.updates.filter((u) => u.status === 'applied').sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))[0];
  const ver = applied?.version ?? '2026.10.3';
  const r = makeRand(db.org.id.length * 31);
  const rel = RELEASE_KEY();
  const custody = custodyView(orgId);
  const dom = db.org.domain ?? 'example.in';
  const site = sovereignSites(db);
  if (sov) {
    const nodes = [
      ...[1, 2, 3].map((i) => ({ name: `cp-${i}.govern.${dom}`, role: 'control-plane' as const, cpu: 8, memoryGb: 32, status: 'ready' as const, zone: i < 3 ? site.primary : site.dr })),
      ...[1, 2, 3, 4].map((i) => ({ name: `wk-${i}.govern.${dom}`, role: 'worker' as const, cpu: 16, memoryGb: 64, status: 'ready' as const, zone: i < 3 ? site.primary : site.dr })),
      ...[1, 2, 3].map((i) => ({ name: `st-${i}.govern.${dom}`, role: 'storage' as const, cpu: 8, memoryGb: 64, status: 'ready' as const, zone: i < 3 ? site.primary : site.dr })),
    ];
    return {
      orgId, mode: 'sovereign', operator: db.org.name, location: db.org.residency ?? 'On premises',
      cluster: { name: `govern-${short(db)}-prod`, distribution: 'Kubernetes (RKE2)', version: '1.30.4', nodes, cpuUsedPct: 0.31 + r.next() * 0.1, memoryUsedPct: 0.44 + r.next() * 0.1 },
      components: [{ name: 'Decision service', version: ver, status: 'running', replicas: 4 }, { name: 'Console', version: ver, status: 'running', replicas: 2 }, { name: 'Anchoring worker', version: ver, status: 'running', replicas: 2 }, { name: 'Verifier', version: '2.0.0', status: 'running', replicas: 2 }, { name: 'PostgreSQL', version: '16.3', status: 'running', replicas: 3 }, { name: 'OpenBao', version: '2.0.1', status: 'running', replicas: 3 }, { name: 'Ceph object gateway (S3 object lock)', version: '18.2.4 Reef', status: 'running', replicas: 3 }],
      database: { engine: 'PostgreSQL 16 (Patroni, 3 nodes)', rowLevelSecurity: true, replicas: 3, sizeGb: 214 },
      secrets: { backend: 'OpenBao', version: '2.0.1', sealed: false },
      storage: { backend: 'Ceph RGW with S3 Object Lock', objectLock: 'compliance', retentionYears: 8, usedTb: 3.8, capacityTb: 48 },
      hsm: { provider: custody.provider, model: 'nShield Connect XC High', fips: 'FIPS 140-3 Level 3', location: db.org.id === 'org_deccan' ? `${site.primary} (primary) and ${site.dr} (DR)` : `Your ${site.primaryLong} and ${site.drLong}`, heldBy: 'customer' },
      tsa: tsaAuthorities(db),
      egress: { policy: 'deny_all', allowList: [], blockedLast24h: 212 + r.int(0, 40), telemetry: 'none' },
      backup: { lastBackupAt: iso(Date.now() - 3 * H), rpoMinutes: 15, rtoMinutes: 60, lastDrillAt: iso(Date.now() - 19 * D), drillResult: 'passed', site: site.drLong },
      updates: clone(db.platform.updates), release: { kid: rel.kid, fingerprint: rel.fingerprint, publicKey: rel.publicKeyHex },
    };
  }
  return {
    orgId, mode: 'hosted', operator: 'elan1 (hosted)', location: 'AWS ap-south-1 (Mumbai), three availability zones',
    cluster: { name: 'eg-prod-aps1', distribution: 'Amazon EKS', version: '1.30', nodes: [1, 2, 3, 4, 5, 6].map((i) => ({ name: `ip-10-20-${i}-${10 + i}.ap-south-1.compute.internal`, role: 'worker' as const, cpu: 8, memoryGb: 32, status: 'ready' as const, zone: `ap-south-1${'abc'[i % 3]}` })), cpuUsedPct: 0.38 + r.next() * 0.1, memoryUsedPct: 0.51 + r.next() * 0.1 },
    components: [{ name: 'Decision service', version: ver, status: 'running', replicas: 6 }, { name: 'Console', version: ver, status: 'running', replicas: 3 }, ...(atLeast(level, 'l2') ? [{ name: 'Anchoring worker', version: ver, status: 'running' as const, replicas: 2 }] : []), { name: 'Verifier', version: '2.0.0', status: 'running', replicas: 2 }],
    database: { engine: 'Amazon RDS for PostgreSQL 16 (Multi-AZ)', rowLevelSecurity: true, replicas: 2, sizeGb: 120 },
    secrets: { backend: atLeast(level, 'l2') ? 'AWS Secrets Manager + KMS' : 'AWS Secrets Manager', version: 'managed', sealed: false },
    storage: atLeast(level, 'l2') ? { backend: 'Amazon S3 with Object Lock', objectLock: 'compliance', retentionYears: 8, usedTb: 0.4, capacityTb: 0 } : { backend: 'Amazon S3 (versioned)', objectLock: 'governance', retentionYears: 1, usedTb: 0.2, capacityTb: 0 },
    hsm: { provider: custody.provider, model: level === 'l3' ? 'CloudHSM hsm2m.medium' : level === 'l2' ? 'AWS KMS (FIPS 140-2 Level 3 HSMs)' : 'Process key', fips: atLeast(level, 'l2') ? 'FIPS 140-2 Level 3' : 'Not applicable', location: custody.location, heldBy: custody.heldBy },
    tsa: atLeast(level, 'l2') ? tsaAuthorities(db) : [],
    egress: { policy: 'elan1_managed', allowList: ['timestamp.emudhra.com', 'timestamp.digicert.com', 'api.slack.com', 'graph.facebook.com (WhatsApp)'], blockedLast24h: 0, telemetry: 'operational metrics only' },
    backup: { lastBackupAt: iso(Date.now() - 1 * H), rpoMinutes: 5, rtoMinutes: 60, lastDrillAt: iso(Date.now() - 26 * D), drillResult: 'passed', site: 'AWS ap-south-2 (Hyderabad)' },
    updates: clone(db.platform.updates), release: { kid: rel.kid, fingerprint: rel.fingerprint, publicKey: rel.publicKeyHex },
  };
}

/** Verify an update bundle's Ed25519 signature against the elan1 release key and stage it (Sovereign). */
export function stageUpdate(orgId: string, id: string, userId: string): UpdateBundle {
  const db = getDB(orgId);
  if (db.org.deployment !== 'sovereign') throw new Error('elan1 applies updates to hosted organisations. Staging is for Sovereign deployments.');
  requireRole(orgId, userId, ['owner', 'admin']);
  const u = db.platform.updates.find((x) => x.id === id);
  if (!u) throw new Error('No such update bundle.');
  if (u.status !== 'available') throw new Error(`This bundle is ${u.status}.`);
  const rel = RELEASE_KEY();
  const ok = u.digest === sha256Hex(`elan1-govern-${u.version}.tar.zst`) && verifyDigestSig(u.digest, u.sig, rel.publicKeyHex);
  u.verified = ok;
  u.stagedAt = iso(Date.now());
  u.stagedBy = userId;
  u.status = ok ? 'staged' : 'rejected';
  const r = append(db, { kind: 'admin', actor: userId, action: ok ? 'update.staged' : 'update.rejected', details: { version: u.version, digest: u.digest.slice(0, 16), signature: ok ? 'verified' : 'failed', release_key: rel.fingerprint } });
  u.seq = r.seq;
  touch(orgId, 'deployment');
  return clone(u);
}

/** Apply a staged update bundle (Sovereign). */
export function applyUpdate(orgId: string, id: string, userId: string): UpdateBundle {
  const db = getDB(orgId);
  if (db.org.deployment !== 'sovereign') throw new Error('elan1 applies updates to hosted organisations.');
  requireRole(orgId, userId, ['owner', 'admin']);
  const u = db.platform.updates.find((x) => x.id === id);
  if (!u) throw new Error('No such update bundle.');
  if (u.status !== 'staged' || !u.verified) throw new Error('Stage and verify the bundle first.');
  u.status = 'applied';
  u.appliedAt = iso(Date.now());
  u.appliedBy = userId;
  const r = append(db, { kind: 'admin', actor: userId, action: 'update.applied', details: { version: u.version, digest: u.digest.slice(0, 16) } });
  u.seq = r.seq;
  touch(orgId, 'deployment');
  return clone(u);
}

export function residencyView(orgId: string): ResidencyView {
  const db = getDB(orgId);
  const sov = db.org.deployment === 'sovereign';
  const level = levelOfOrg(db.org);
  const site = sovereignSites(db);
  const both = db.org.id === 'org_deccan' ? 'BKC and Navi Mumbai' : `${site.primary} and ${site.dr}`;
  const stores = sov
    ? [{ name: 'Receipts and approvals', location: db.org.id === 'org_deccan' ? 'BKC data centre, Mumbai' : `Your ${site.primaryLong}`, provider: 'PostgreSQL 16 (yours)', holds: 'Every receipt, approval and rulebook' }, { name: 'Bundles and anchors', location: both, provider: 'Ceph object lock (yours)', holds: 'Evidence bundles, Merkle batches, timestamps' }, { name: 'Signing key', location: both, provider: 'Entrust nShield (yours)', holds: 'The Ed25519 signing key' }, { name: 'Backups', location: site.drLong, provider: 'Yours', holds: 'Encrypted backups' }]
    : [{ name: 'Receipts and approvals', location: 'AWS ap-south-1, Mumbai', provider: 'Amazon RDS (elan1)', holds: 'Every receipt, approval and rulebook' }, { name: 'Bundles and anchors', location: 'AWS ap-south-1, Mumbai', provider: atLeast(level, 'l2') ? 'Amazon S3 Object Lock' : 'Amazon S3', holds: 'Evidence bundles and exports' }, { name: 'Signing key', location: level === 'l3' ? 'Your AWS account, ap-south-1' : 'AWS ap-south-1, Mumbai', provider: custodyView(orgId).provider, holds: 'The Ed25519 signing key' }, { name: 'Backups', location: 'AWS ap-south-2, Hyderabad', provider: 'elan1', holds: 'Encrypted backups (India only)' }];
  // hosting profile 2 (mock/records.ts): an active dedicated residency domain (L2 and above) replaces the shared stores
  const ded = (db.platform as unknown as { recordsLedger?: { hosting?: { dedicated?: { status: string; region: string; domain: string } } } }).recordsLedger?.hosting?.dedicated;
  const dedicated = !sov && atLeast(level, 'l2') && ded?.status === 'active' ? ded : undefined;
  if (dedicated) {
    const where = dedicated.region.replace(/^AWS (ap-south-\d) \((\w+)\)$/, 'AWS $1, $2');
    const backup = dedicated.region.includes('Mumbai') ? 'AWS ap-south-2, Hyderabad' : 'AWS ap-south-1, Mumbai';
    stores.splice(0, stores.length,
      { name: 'Receipts and approvals', location: where, provider: 'Amazon RDS, single tenant (this organisation only)', holds: 'Every receipt, approval and rulebook' },
      { name: 'Bundles and anchors', location: where, provider: 'Amazon S3 Object Lock, own bucket', holds: 'Evidence bundles and exports' },
      { name: 'Signing key', location: level === 'l3' ? `Your AWS account, ${where}` : `${where}, own key ring`, provider: custodyView(orgId).provider, holds: 'The Ed25519 signing key' },
      { name: 'Backups', location: backup, provider: 'elan1, dedicated vault', holds: 'Encrypted backups (India only)' });
  }
  const statement = { org: db.org.id, domain: dedicated ? `${dedicated.domain} (${dedicated.region})` : db.org.residency ?? 'ap-south-1 Mumbai', stores: stores.map((x) => `${x.name}@${x.location}`), at: new Date(Math.floor(Date.now() / D) * D).toISOString() };
  const key = currentKey(db);
  const digest = sha256Hex(canonical(statement));
  return {
    orgId, domain: statement.domain, deployment: db.org.deployment ?? 'hosted', stores,
    crossBorder: { allowed: false, transfers30d: 0, note: sov ? 'Nothing leaves your network: egress is denied by default.' : 'All stores and backups are in India. Timestamp requests send only a 32-byte Merkle root to the authorities.' },
    proof: { statement: `${db.org.name}: every store listed is in ${statement.domain}. Statement date ${statement.at.slice(0, 10)}.`, digest, signedAt: statement.at, kid: key.kid, sig: signText(digest, key) },
  };
}

/* ══ Identity (SAML, SCIM) ══════════════════════════════════════════════ */

export function identityConfig(orgId: string): IdentityConfig {
  return clone(getDB(orgId).platform.identity);
}

/** SAML providers that are cloud services, by name, with the host a Sovereign deployment would have to reach. */
const CLOUD_SAML_IDP: [RegExp, string][] = [[/okta/i, 'okta.com'], [/entra|azure ad|microsoftonline/i, 'login.microsoftonline.com'], [/google/i, 'accounts.google.com'], [/onelogin/i, 'onelogin.com'], [/jumpcloud/i, 'sso.jumpcloud.com'], [/auth0/i, 'auth0.com']];

/**
 * Sovereign deployments run under deny-all egress (the same rule as OIDC, settings/orgApi ssoIssuerProblem): SAML
 * works only with an identity provider inside the network — Keycloak, ADFS or another provider whose metadata is on
 * .internal, .local, .lan, a private (RFC 1918) address or the organisation's own domain. Returns why a provider and
 * metadata URL cannot be used there, with the outside host it would reach (undefined when they can, and always for
 * hosted organisations).
 */
export function samlEgressProblem(orgId: string, idp: string, metadataUrl: string): { why: string; host: string } | undefined {
  if (!isSovereign(orgId)) return undefined;
  const name = getDB(orgId).org.name;
  const cloud = CLOUD_SAML_IDP.find(([re]) => re.test(idp));
  if (cloud) return { why: `${idp} is a cloud service outside ${name}’s network. A Sovereign deployment sends nothing to the internet, so SAML sign-in uses Keycloak or another identity provider inside the network.`, host: metadataUrl && !isInternalName(orgId, metadataUrl) ? metadataUrl : `https://${cloud[1]}` };
  if (metadataUrl.trim() && !isInternalName(orgId, metadataUrl)) return { why: `The identity provider’s metadata is outside ${name}’s network. A Sovereign deployment can reach only a provider on .internal, .local, .lan, a private address or the organisation’s own domain.`, host: metadataUrl };
  return undefined;
}

export function setIdentityConfig(orgId: string, patch: { saml?: Partial<IdentityConfig['saml']>; scim?: Partial<IdentityConfig['scim']> }, userId: string): IdentityConfig {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner']);
  // Sovereign: refuse SAML from an outside identity provider, recorded as egress.blocked (mock/sovereign guardDestination).
  // Switching SAML off is always allowed; saving metadata, switching it on or requiring it is checked.
  if (patch.saml && isSovereign(orgId) && (patch.saml.idp !== undefined || patch.saml.metadataUrl !== undefined || patch.saml.enabled === true || patch.saml.enforced === true)) {
    const cur = db.platform.identity.saml;
    const problem = samlEgressProblem(orgId, patch.saml.idp ?? cur.idp, patch.saml.metadataUrl ?? cur.metadataUrl);
    if (problem) {
      try { guardDestination(orgId, problem.host, `Single sign-on (SAML, ${patch.saml.idp ?? cur.idp})`, userId); }
      catch (e) { throw new Error(`${problem.why} ${(e as Error).message}`); }
      throw new Error(problem.why);
    }
  }
  if (patch.saml) Object.assign(db.platform.identity.saml, patch.saml);
  if (patch.scim) Object.assign(db.platform.identity.scim, patch.scim);
  if (patch.scim?.enabled && !db.platform.identity.scim.lastSyncAt) db.platform.identity.scim.lastSyncAt = iso(Date.now());
  append(db, { kind: 'admin', actor: userId, action: 'identity.updated', details: { saml_enabled: db.platform.identity.saml.enabled, saml_enforced: db.platform.identity.saml.enforced, scim_enabled: db.platform.identity.scim.enabled } });
  return identityConfig(orgId);
}

/** Rotate the SCIM bearer token; the new token is returned once. */
export function rotateScimToken(orgId: string, userId: string) {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner']);
  const secret = `scim_${randHex(20)}`;
  db.platform.identity.scim.tokenPrefix = secret.slice(0, 11);
  append(db, { kind: 'admin', actor: userId, action: 'identity.scim_token_rotated', details: { prefix: db.platform.identity.scim.tokenPrefix } });
  return { secret, config: identityConfig(orgId) };
}

/* ══ AI discovery ═══════════════════════════════════════════════════════ */

export function discoveryView(orgId: string): DiscoveryScan {
  return clone(getDB(orgId).platform.discovery);
}

/** Re-scan connectors, MCP servers, the identity provider and egress logs for AI use nobody registered. */
export function runDiscovery(orgId: string, userId: string): DiscoveryScan {
  const db = getDB(orgId);
  const sc = db.platform.discovery;
  sc.scannedAt = iso(Date.now());
  for (const f of sc.findings) { f.lastSeen = iso(Date.now() - 10 * 60_000); if (f.status === 'unregistered') f.callsSeen += 3 + (f.id.length % 7); }
  if (!db.fresh && !sc.findings.some((f) => f.id === 'df_gemini')) sc.findings.unshift({ id: 'df_gemini', name: 'Gemini API used by a spreadsheet add-on', kind: 'api_key', vendor: 'Google', source: sc.sources[0]?.name ?? 'Network egress', evidence: 'A Sheets add-on in the finance shared drive called generativelanguage.googleapis.com 38 times today.', firstSeen: iso(Date.now() - 2 * H), lastSeen: iso(Date.now() - 10 * 60_000), callsSeen: 38, risk: 'medium', status: 'unregistered' });
  append(db, { kind: 'admin', actor: userId, action: 'discovery.scanned', details: { sources: sc.sources.length, findings: sc.findings.length, unregistered: sc.findings.filter((f) => f.status === 'unregistered').length } });
  return discoveryView(orgId);
}

/** Register a finding in the AI inventory (lifecycle proposed, risk tier unassessed until an assessment is signed off). */
export function registerFinding(orgId: string, id: string, userId: string): { finding: DiscoveryFinding; system: AiSystem } {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  const f = db.platform.discovery.findings.find((x) => x.id === id);
  if (!f) throw new Error('No such finding.');
  if (f.status === 'registered') throw new Error('Already registered.');
  const kind: AiSystem['kind'] = f.kind === 'bot' || f.kind === 'api_key' ? 'internal_app' : f.kind === 'mcp_server' ? 'agent' : 'vendor_tool';
  const sys: AiSystem = { id: `ai_${randHex(4)}`, name: f.name, kind, vendor: f.vendor, purpose: `Found by AI discovery: ${f.evidence}`, ownerId: userId, businessUnit: 'To be confirmed', lifecycle: 'proposed', riskTier: 'unassessed', dataCategories: [], affectedPeople: [], decisionImpact: 'informs', createdAt: iso(Date.now()), frameworks: ['iso42001'] };
  db.aiSystems.unshift(sys);
  f.status = 'registered';
  f.aiSystemId = sys.id;
  append(db, { kind: 'admin', actor: userId, action: 'inventory.added', details: { system: sys.name, source: 'discovery', finding: f.id } });
  return { finding: clone(f), system: clone(sys) };
}

export function dismissFinding(orgId: string, id: string, userId: string, reason: string) {
  const db = getDB(orgId);
  requireRole(orgId, userId, ['owner', 'admin']);
  const f = db.platform.discovery.findings.find((x) => x.id === id);
  if (!f) throw new Error('No such finding.');
  f.status = 'dismissed';
  append(db, { kind: 'admin', actor: userId, action: 'discovery.dismissed', details: { finding: f.id, reason } });
  return clone(f);
}

/* ══ Public status ══════════════════════════════════════════════════════ */

function chainIntegrity(db: OrgDB) {
  const rs = db.receipts.slice(-200);
  let ok = true;
  for (let i = 1; i < rs.length; i++) if (rs[i].prev_hash !== rs[i - 1].hash || rs[i].seq !== rs[i - 1].seq + 1) { ok = false; break; }
  const head = rs[rs.length - 1];
  ok = ok && receiptHash(head) === head.hash && verifySig(head.hash, head.sig, db.publicKeys[head.kid]);
  const cp = db.checkpoints[db.checkpoints.length - 1];
  const cpOk = !cp || verifySig(canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid }), cp.sig, db.publicKeys[cp.kid]);
  return { ok: ok && cpOk, head, cp, checked: rs.length };
}

/** Public status page data: platform components, delivery, timestamp authorities and chain integrity per organisation. */
export function statusView(): StatusView {
  const now = Date.now();
  const days = (seed: number, bad: { daysAgo: number; status: ComponentStatus; minutes: number; note: string }[] = []) => {
    const r = makeRand(seed);
    let down = 0;
    const out: StatusComponent['days'] = [];
    for (let i = 89; i >= 0; i--) {
      const date = new Date(now - i * D + 5.5 * H).toISOString().slice(0, 10);
      const b = bad.find((x) => x.daysAgo === i);
      if (b) { down += b.minutes; out.push({ date, status: b.status, note: b.note }); }
      else { const blip = r.chance(0.015); if (blip) down += 4; out.push({ date, status: blip ? 'degraded' : 'operational', note: blip ? 'Elevated latency for 4 minutes' : undefined }); }
    }
    return { days: out, uptime90: 1 - down / (90 * 1440) };
  };
  const comp = (id: string, name: string, group: StatusComponent['group'], seed: number, detail: string, bad: Parameters<typeof days>[1] = [], status: ComponentStatus = 'operational'): StatusComponent => ({ id, name, group, status, detail, ...days(seed, bad) });
  const deg = degradedWindow();
  const t09 = new Date(deg.from + 5.5 * H).toISOString().slice(11, 16);
  const t11 = new Date(deg.to + 5.5 * H).toISOString().slice(11, 16);
  const components: StatusComponent[] = [
    comp('gate', 'Decision API (decide before the call)', 'Platform', 11, 'Median decision 38 ms at the 95th percentile of 120 ms.'),
    comp('console', 'Console', 'Platform', 12, 'Sign-in, approvals inbox and records.', [{ daysAgo: 23, status: 'maintenance', minutes: 0, note: 'Planned maintenance 02:00–02:20 IST' }]),
    comp('verifier', 'Public verifier', 'Platform', 13, 'Runs in your browser; this measures the page itself.'),
    ((down) => comp('approvals', 'Approvals delivery (email, Slack, WhatsApp, phone links)', 'Delivery', 14, down.length ? `Down for ${down.join(', ')} (demonstration): nothing can be approved and nothing expires until it is back.` : 'Time from a held call to the first notification.', [{ daysAgo: 6, status: 'degraded', minutes: 26, note: 'WhatsApp messages delayed up to 9 minutes; email and Slack unaffected' }], down.length ? 'outage' : 'operational'))(
      orgIds().map((id) => getDB(id) as OrgDB & { approvalsExt?: { outage?: { active?: boolean } } }).filter((d) => d.org.deployment !== 'sovereign' && d.approvalsExt?.outage?.active).map((d) => d.org.name)),
    comp('webhooks', 'Webhooks', 'Delivery', 15, 'Deliveries from Elan1 Govern; failures at a customer’s endpoint are not counted.'),
    comp('tsa_emudhra', 'eMudhra TSA (India)', 'Timestamping', 16, 'RFC 3161 timestamps for L2 and L3 batches.', [{ daysAgo: 1, status: 'degraded', minutes: 158, note: `Unreachable ${t09}–${t11} IST; batches were timestamped late and the second authority stayed within 15 minutes` }]),
    comp('tsa_digicert', 'DigiCert TSA (global)', 'Timestamping', 17, 'RFC 3161 timestamps for L2 and L3 batches.'),
  ];
  for (const id of orgIds()) {
    const db = getDB(id);
    // Sovereign deployments run in the customer's own network: Elan1 never publishes their status (see Deployment › Local status)
    if (db.org.deployment === 'sovereign') continue;
    const ci = chainIntegrity(db);
    components.push({ ...comp(`chain_${id}`, `Chain integrity — ${db.org.name}`, 'Chain integrity', id.length * 7, ci.ok ? `Last ${ci.checked} receipts link and the head #${ci.head.seq} verifies${ci.cp ? `; checkpoint #${ci.cp.seq} ${atLeast(levelOfOrg(db.org), 'l2') ? 'signature' : 'seal'} verifies` : ''}. ${LEVEL_INFO[levelOfOrg(db.org)].label}.` : `Verification failed near #${ci.head.seq}.`), status: ci.ok ? 'operational' : 'outage' });
  }
  applyMaintenanceToStatus(components); // a planned window open now (src/mock/opsMaintenance.ts)
  const worst: ComponentStatus = components.some((c) => c.status === 'outage') ? 'outage' : components.some((c) => c.status === 'degraded') ? 'degraded' : 'operational';
  return {
    updatedAt: iso(now), overall: worst, components,
    incidents: [
      { id: 'inc_tsa', title: 'eMudhra timestamp authority unreachable', status: 'resolved', startedAt: iso(deg.from), resolvedAt: iso(deg.to), updates: [{ at: iso(deg.from + 5 * 60_000), text: 'Timestamp requests to eMudhra are timing out. Batches keep their DigiCert timestamp; the India timestamp will follow.' }, { at: iso(deg.to), text: 'eMudhra is answering again. Every waiting batch now has both timestamps. No record was lost.' }] },
      { id: 'inc_wa', title: 'WhatsApp approval messages delayed', status: 'resolved', startedAt: iso(now - 6 * D), resolvedAt: iso(now - 6 * D + 26 * 60_000), updates: [{ at: iso(now - 6 * D + 3 * 60_000), text: 'WhatsApp notifications are delayed. Email, Slack and the console are unaffected.' }, { at: iso(now - 6 * D + 26 * 60_000), text: 'Delivery is back to normal.' }] },
    ],
  };
}

/* ══ Guards ═════════════════════════════════════════════════════════════ */

function requireLevel(db: OrgDB, level: LevelId, what: string) {
  if (!atLeast(levelOfOrg(db.org), level)) throw new Error(`${what} starts at ${LEVEL_INFO[level].label}. This organisation is on ${LEVEL_INFO[levelOfOrg(db.org)].label} — see Assurance › Assurance levels to upgrade.`);
}

/** The caller must hold one of `roles` as an active member of the organisation (member record, not the directory). */
function requireRole(orgId: string, userId: string, roles: string[]) {
  const role = memberRole(orgId, userId);
  if (!role || !roles.includes(role)) throw new Error(`${roles.map((r) => r[0].toUpperCase() + r.slice(1) + 's').join(' and ')} can do this; your role cannot.`);
}

