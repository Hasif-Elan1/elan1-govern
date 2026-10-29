/**
 * The L2 verifier: six result codes and a nine-section report. Runs anywhere, offline, on a bundle file.
 *
 *   0  PASS                    everything checks, key fingerprint supplied and matching, nothing unanchored
 *   0  PASS_UNANCHORED_TAIL    passes; the newest sealed records are not yet in a timestamped batch
 *   0  PASS_KEY_FROM_BUNDLE    passes, but the key came from the bundle itself (no fingerprint supplied)
 *   0  PASS_L1_INTERNAL        passes; L1 records only: internal evidence, sealed in a hash chain, not timestamped
 *   0  PASS_PAYLOAD_UNBOUND    passes; an erasure destroyed a salt, so some payload hashes cannot be recomputed
 *   1  FAIL_INTEGRITY          a hash, link, signature, seal, Merkle root or timestamp does not verify
 *   2  FAIL_PROFILE            integrity holds but a rule of the claimed verifier profile fails
 *   3  INCOMPLETE              something needed to check is missing (a member, a seal, a key)
 *   4  UNSUPPORTED             a format or profile this verifier does not know
 *   5  USAGE                   the input is not a bundle, or the options are wrong
 *
 * Precedence: 1 > 3 > 2. FAIL_INTEGRITY and FAIL_PROFILE are never collapsed; INCOMPLETE is never
 * reported as either. L1 packs (auditor-pack/1) verify too: sections 6 and 7 read "not applicable".
 * It reuses verifyChain from lib/crypto for the receipt chain and genuinely recomputes Merkle roots,
 * timestamp-token signatures and Seal v6 digests.
 */
import type {
  AnchorBatch, Checkpoint, DisclosurePackage, LevelId, ProfileRuleResult, Receipt, SealRecord, TsaAuthority, VerifierProfile, VerifyCode, VerifySection,
} from '@/types';
import { canonical, sha256Hex, verifyChain, verifySig, type VerifyReport } from './crypto';
import { merkleRoot } from './merkle';
import { verifySeal } from './seal';
import { profileById, runProfileRules, type ProfileContext } from './profiles';
import { verifyDisclosure } from './disclosure';
import { LEVEL_INFO, levelRank } from './levels';

export const VERIFIER_VERSION = 'elan1-verify 2.0.0';
export const SUPPORTED_FORMATS = ['auditor-pack/1', 'elan1.evidence.bundle.v1'];

export const EXIT_CODES: Record<VerifyCode, 0 | 1 | 2 | 3 | 4 | 5> = {
  PASS: 0, PASS_UNANCHORED_TAIL: 0, PASS_KEY_FROM_BUNDLE: 0, PASS_L1_INTERNAL: 0, PASS_PAYLOAD_UNBOUND: 0, FAIL_INTEGRITY: 1, FAIL_PROFILE: 2, INCOMPLETE: 3, UNSUPPORTED: 4, USAGE: 5,
};

export const CODE_LABELS: Record<VerifyCode, string> = {
  PASS: 'Pass',
  PASS_UNANCHORED_TAIL: 'Pass — newest records not yet timestamped',
  PASS_KEY_FROM_BUNDLE: 'Pass — key taken from the bundle',
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided
  PASS_L1_INTERNAL: 'Pass — L1: internal evidence only',
  PASS_PAYLOAD_UNBOUND: 'Pass — payload unbound (salt erased)',
  FAIL_INTEGRITY: 'Fail — integrity',
  FAIL_PROFILE: 'Fail — profile rules',
  INCOMPLETE: 'Incomplete',
  UNSUPPORTED: 'Unsupported',
  USAGE: 'Usage error',
};

export const VERIFY_LIMITS = 'A pass shows that these records were produced by the holder of the named key, in this order, unaltered since they were sealed — and, where timestamped, that they existed at the time shown by two independent authorities. It does not show that the underlying transactions occurred, that the rules were the right rules, or that records outside this bundle are complete. Draft — needs legal review.';

/** The nine sections of the report, in the specification's order (02 §4.9): the console and the public verifier both use them. */
export const REPORT_SECTION_TITLES = ['Verdict', 'Claim', 'Scope', 'Integrity', 'Clause results', 'First failure', 'Notes', 'Limits', 'Reproduction'] as const;

/** The member list of an L2 evidence bundle (8 members). */
export const BUNDLE_MEMBERS = ['manifest.json', 'receipts.jsonl', 'seals.jsonl', 'checkpoints.json', 'anchors.json', 'keys.json', 'declarations.json', 'profile/ (profile.json + VERIFY.txt)'] as const;

/**
 * The lexicon member (spec 02 §4.9): the rule and refusal vocabulary the bundle's receipts use, so a verifier can read
 * their ids. It is added beside the eight members, never in place of one, and is optional: a bundle made before it has
 * no lexicon and still verifies (the report says so in a note). When the signed manifest lists it, its digest is checked
 * like any other member's.
 */
export const LEXICON_MEMBER = 'lexicon.json' as const;

export interface BundleLexicon {
  format: 'elan1.lexicon.v1';
  /** what each decision word in a receipt means */
  decisions: Record<string, string>;
  /** every rule id the receipts name, with the rule's decision and reason where a rulebook version in range defines it */
  rules: { id: string; decision?: string; text?: string; rulebooks?: string[] }[];
  /** the refusal codes (wire names) those rules and reasons stand for */
  refusal_codes: { code: string; ref: string; family: string; title: string; rule_ids?: string[] }[];
}

/** One unsigned interval named in a manifest (records sealed by an interim chain key during a key compromise). */
export interface UnsignedIntervalManifest { compromise: string; revoked_kid: string; interim_kid: string; first_seq: number; last_seq?: number; open: boolean; replacement_kid?: string }

export interface BundleManifest {
  format?: string;
  bundle_format?: string;
  issuer?: string;
  org?: string;
  org_id?: string;
  created_at?: string;
  created_by?: string;
  receipts?: number;
  first_seq?: number;
  last_seq?: number;
  record_count?: number;
  refusal_count?: number;
  checkpoints?: number;
  /** `interim`: Elan1 Govern's interim chain key during a declared key compromise (hash chain only, not the organisation's key) */
  keys?: { kid: string; fingerprint: string; status?: string; interim?: boolean }[];
  /** records sealed by an interim chain key while signing was off after a declared key compromise */
  unsigned_intervals?: UnsignedIntervalManifest[];
  assurance_levels?: { level: LevelId; count: number; first_seq: number; last_seq: number }[];
  continuity_scope?: string;
  profile_id?: string;
  profile_version?: string;
  profile_digest?: string;
  redaction_profile?: string;
  members?: { path: string; bytes: number; sha256: string }[];
  unanchored_head?: number;
  signing_kid?: string;
  verifier_digest?: string;
  note?: string;
  /** L1 auditor pack: hash of the last receipt the pack holds (a cut-off tail no longer matches it) */
  last_hash?: string;
  /** L1 auditor pack: the key that sealed the manifest */
  sealing_kid?: string;
  /** L1 auditor pack: 'file' when members[].sha256 is over the file's bytes in the ZIP (not canonical JSON) */
  digest_of?: 'file' | 'canonical';
  /** governed run (enforced), check and record (advisory), or both, for the records in range */
  enforcement_mode?: string;
  [k: string]: unknown;
}

export interface EvidenceBundle {
  manifest: BundleManifest;
  manifest_sig?: string;
  /** L1 auditor pack: Ed25519 seal over the manifest by `manifest.sealing_kid` (L1 copy says "sealed") */
  manifest_seal?: string;
  /** L1 auditor pack: the PDF summary (ASCII PDF text, its bytes) */
  summary_pdf?: string;
  /** L1 auditor pack: frameworks, requirements and the receipts in the pack that evidence them */
  compliance_map?: unknown;
  public_keys: Record<string, string>;
  receipts: Receipt[];
  checkpoints: Checkpoint[];
  seals?: SealRecord[];
  anchors?: { authorities: TsaAuthority[]; batches: (AnchorBatch & { leaves: string[] })[] };
  declarations?: { rulebooks: { slug: string; version: number; hash: string; signedBy?: string; signedAt?: string }[]; context?: Omit<ProfileContext, 'receipts' | 'checkpoints' | 'level' | 'anchoredSeqs'> };
  profile?: VerifierProfile | null;
  readme?: string;
  disclosures?: DisclosurePackage[];
  /** optional member: the rule and refusal vocabulary (bundles made before it have none) */
  lexicon?: BundleLexicon;
}

export interface VerifyBundleOptions {
  /** Profile to check against; overrides the profile the bundle claims. 'none' checks no profile. */
  profileId?: string;
  /** Key fingerprint obtained out of band (16 hex). Without it the result is at best PASS_KEY_FROM_BUNDLE. */
  expectedFingerprint?: string;
  now?: number;
  /** Profiles withdrawn by the bundle's organisation (id → date, reason). A bundle claiming one is reported with the date. */
  withdrawals?: Record<string, ProfileWithdrawal>;
}

export interface ProfileWithdrawal { at: string; reason?: string }

let withdrawalLookup: ((orgId: string) => Record<string, ProfileWithdrawal> | undefined) | undefined;
/** Where the verifier, run inside the console, reads an organisation's withdrawn profiles (set by mock/packsFactory.ts). */
export function setProfileWithdrawalLookup(fn: (orgId: string) => Record<string, ProfileWithdrawal> | undefined) { withdrawalLookup = fn; }

/** The withdrawals for the bundle's organisation, resolved on this thread (a worker has no organisation state to read). */
export function withProfileWithdrawals(input: unknown, opts: VerifyBundleOptions = {}): VerifyBundleOptions {
  if (opts.withdrawals || !withdrawalLookup || !isObj(input) || !isObj(input.manifest)) return opts;
  const m = input.manifest as Record<string, unknown>;
  const id = typeof m.org_id === 'string' ? m.org_id : typeof m.tenant_id === 'string' ? m.tenant_id : undefined;
  if (!id) return opts;
  try { const w = withdrawalLookup(id); return w && Object.keys(w).length ? { ...opts, withdrawals: w } : opts; } catch { return opts; }
}

export interface VerifyBundleResult {
  code: VerifyCode;
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
  label: string;
  headline: string;
  /** every PASS variant that applies (the code shows the most important one) */
  variants: VerifyCode[];
  format?: string;
  org?: string;
  levels: { level: LevelId; count: number; firstSeq: number; lastSeq: number }[];
  sections: VerifySection[];
  notes: string[];
  limits: string;
  /** the L1 chain report from verifyChain (receipts, checks, broken-at) */
  chain?: VerifyReport;
  profile?: { id: string; version: string; name: string; results: ProfileRuleResult[]; withdrawnAt?: string; withdrawnReason?: string };
  counts: { receipts: number; seals: number; payloadUnbound: number; batches: number; tokens: number; checkpoints: number; refusals: number; unanchored: number; disclosures: number };
  /** the write types (tools) the decisions in range name, with how many decisions each; reported under Scope */
  writeTypes?: { tool: string; count: number }[];
  fingerprint?: string;
  keySource: 'bundle' | 'supplied';
  reproduction: { command: string; verifierVersion: string; bundleDigest: string; profileDigest?: string };
  ms: number;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Digest of a member's content (canonical JSON). */
export function memberDigest(content: unknown) {
  const text = canonical(content);
  return { sha256: sha256Hex(text), bytes: new TextEncoder().encode(text).length };
}

export function tokenMessage(t: { tsaId: string; imprint: string; genTime: string; serial: string; policyOid: string }) {
  return sha256Hex(canonical({ tsa: t.tsaId, imprint: t.imprint, gen_time: t.genTime, serial: t.serial, policy: t.policyOid }));
}

export function manifestMessage(m: BundleManifest) {
  return sha256Hex(canonical(m));
}

/** The files of an L1 auditor pack (auditor-pack/1), in order. manifest.json is sealed and lists the others' digests. */
export const L1_PACK_MEMBERS = ['manifest.json', 'keys.json', 'receipts.jsonl', 'checkpoints.json', 'summary.pdf', 'compliance-map.json', 'README.txt'] as const;

/** Auditor packs made from this moment carry a sealed manifest; an unsealed one dated after it had its seal removed. */
export const SEALED_MANIFEST_FROM = Date.parse('2026-10-28T00:00:00+05:30');

/** Fields only a sealed L1 manifest carries: a pack that has them but no seal had its seal stripped. */
export const SEALED_ONLY_FIELDS = ['sealing_kid', 'members', 'last_hash', 'digest_of'] as const;

type L1Source = Pick<EvidenceBundle, 'public_keys' | 'receipts' | 'checkpoints' | 'summary_pdf' | 'compliance_map' | 'readme'>;

/**
 * The text of each L1 pack file exactly as it is written into the ZIP. A manifest with `digest_of: 'file'` lists
 * the SHA-256 and byte count of these bytes, so `sha256sum` on a file taken out of the ZIP gives the manifest's value.
 */
export function l1PackFiles(b: L1Source): Record<string, string | undefined> {
  return {
    'keys.json': b.public_keys === undefined ? undefined : JSON.stringify(b.public_keys, null, 2),
    'receipts.jsonl': b.receipts === undefined ? undefined : b.receipts.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'checkpoints.json': b.checkpoints === undefined ? undefined : JSON.stringify(b.checkpoints, null, 2),
    'summary.pdf': b.summary_pdf,
    'compliance-map.json': b.compliance_map === undefined ? undefined : JSON.stringify(b.compliance_map, null, 2),
    'README.txt': b.readme,
  };
}

/** SHA-256 and byte count of a file's bytes (UTF-8 text, as written into the ZIP). */
export function fileDigest(text: string) {
  return { sha256: sha256Hex(text), bytes: new TextEncoder().encode(text).length };
}

/** The content each L1 pack member's digest is taken over (packs sealed before file digests: canonical JSON). */
export function l1PackContents(b: Pick<EvidenceBundle, 'public_keys' | 'receipts' | 'checkpoints' | 'summary_pdf' | 'compliance_map' | 'readme'>): Record<string, unknown> {
  return { 'keys.json': b.public_keys, 'receipts.jsonl': b.receipts, 'checkpoints.json': b.checkpoints, 'summary.pdf': b.summary_pdf, 'compliance-map.json': b.compliance_map, 'README.txt': b.readme };
}

/** The bundle digest the verifier reports under Reproduction: the manifest and the receipt hashes, canonical JSON. */
export function bundleDigest(b: { manifest?: BundleManifest; receipts?: Receipt[] }) {
  const receipts = [...(b.receipts ?? [])].sort((x, y) => x.seq - y.seq);
  return sha256Hex(canonical({ manifest: b.manifest ?? {}, receipts: receipts.map((r) => r.hash) }));
}

function section(id: VerifySection['id'], number: number, title: string, state: VerifySection['state'], detail: string, facts?: VerifySection['facts'], firstFailure?: VerifySection['firstFailure']): VerifySection {
  return { id, number, title, state, detail, ...(facts ? { facts } : {}), ...(firstFailure ? { firstFailure } : {}) };
}

function finish(code: VerifyCode, partial: Partial<VerifyBundleResult>, t0: number, headline: string): VerifyBundleResult {
  const titles: [VerifySection['id'], string][] = [['bundle', 'Bundle and manifest'], ['keys', 'Keys and fingerprint'], ['signatures', 'Signatures'], ['chain', 'Hash chain'], ['checkpoints', 'Checkpoints'], ['anchors', 'Anchors and timestamps'], ['seals', 'Seal v6 records'], ['profile', 'Profile rules'], ['disclosure', 'Disclosure']];
  const have = partial.sections ?? [];
  const sections = titles.map(([id, title], i) => have.find((s) => s.id === id) ?? section(id, i + 1, title, 'incomplete', 'Not checked: verification stopped earlier.'));
  return {
    code, exitCode: EXIT_CODES[code], label: CODE_LABELS[code], headline, variants: partial.variants ?? [], format: partial.format, org: partial.org,
    levels: partial.levels ?? [], sections, notes: partial.notes ?? [], limits: VERIFY_LIMITS, chain: partial.chain, profile: partial.profile,
    counts: partial.counts ?? { receipts: 0, seals: 0, payloadUnbound: 0, batches: 0, tokens: 0, checkpoints: 0, refusals: 0, unanchored: 0, disclosures: 0 },
    ...(partial.writeTypes ? { writeTypes: partial.writeTypes } : {}),
    fingerprint: partial.fingerprint, keySource: partial.keySource ?? 'bundle',
    reproduction: partial.reproduction ?? { command: 'govern verify bundle.json', verifierVersion: VERIFIER_VERSION, bundleDigest: '' },
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * Verify an evidence bundle (L2 `elan1.evidence.bundle.v1`) or an L1 auditor pack.
 * Returns the result code, its exit code and nine report sections, plus the L1 chain report.
 */
export function verifyBundle(input: unknown, opts: VerifyBundleOptions = {}): VerifyBundleResult {
  const t0 = performance.now();
  const notes: string[] = [];

  // ── USAGE
  if (!isObj(input) || !Array.isArray(input.receipts)) {
    return finish('USAGE', { sections: [section('bundle', 1, 'Bundle and manifest', 'fail', 'The input is not an evidence bundle: it needs a receipts list (and, for L2, a manifest with its members).')] }, t0, 'This is not an evidence bundle.');
  }
  if (opts.expectedFingerprint !== undefined && !/^[0-9a-f]{16}$/i.test(opts.expectedFingerprint.trim())) {
    return finish('USAGE', { sections: [section('keys', 2, 'Keys and fingerprint', 'fail', 'The fingerprint you supplied is not 16 hexadecimal characters.')] }, t0, 'The key fingerprint option is not valid.');
  }
  const b = input as unknown as EvidenceBundle;
  const m: BundleManifest = isObj(b.manifest) ? (b.manifest as BundleManifest) : {};
  const format = m.bundle_format ?? m.format ?? (isObj(b.manifest) ? undefined : 'receipts');
  const isL2 = m.bundle_format === 'elan1.evidence.bundle.v1';

  // ── UNSUPPORTED
  if (format && format !== 'receipts' && !SUPPORTED_FORMATS.includes(format)) {
    return finish('UNSUPPORTED', { format, sections: [section('bundle', 1, 'Bundle and manifest', 'fail', `Format "${format}" is not one this verifier knows (${SUPPORTED_FORMATS.join(', ')}).`)] }, t0, `Unsupported format ${format}.`);
  }
  const wantProfile = opts.profileId === 'none' ? undefined : opts.profileId ?? m.profile_id;
  const carried = wantProfile ? profileById(wantProfile) : undefined;
  if (wantProfile && !carried) {
    return finish('UNSUPPORTED', { format, sections: [section('profile', 8, 'Profile rules', 'fail', `Profile "${wantProfile}" is not one this verifier carries.`)] }, t0, `Unsupported profile ${wantProfile}.`);
  }
  // the bundle's own profile member (covered by the manifest's member digests) may add rows to the version this verifier
  // carries: not_measurable and out_of_scope dispositions, such as a pilot's day-0 necessity statement. They check
  // nothing, so they never change a result; they are reported, never left out.
  const own = isObj(b.profile) && carried && b.profile.id === carried.id && b.profile.version === carried.version && Array.isArray(b.profile.rules) ? b.profile : undefined;
  const extraRows = own && carried ? own.rules.filter((r) => (r.disposition === 'not_measurable' || r.disposition === 'out_of_scope') && !carried.rules.some((x) => x.id === r.id)) : [];
  const profile = carried && extraRows.length ? { ...carried, rules: [...carried.rules, ...extraRows] } : carried;
  // a profile the organisation withdrew: the bundle is still checked against it, and reported with the withdrawal date
  const wd = withProfileWithdrawals(input, opts).withdrawals;
  const withdrawal = profile ? wd?.[profile.id] ?? (own?.withdrawnAt ? { at: own.withdrawnAt, reason: own.withdrawnReason } : undefined) : undefined;
  if (Array.isArray(b.seals) && b.seals.some((s) => s?.format !== 'elan1.seal.v6')) {
    return finish('UNSUPPORTED', { format, sections: [section('seals', 7, 'Seal v6 records', 'fail', 'A seal uses a format other than elan1.seal.v6.')] }, t0, 'Unsupported seal format.');
  }

  const receipts = [...b.receipts].sort((x, y) => x.seq - y.seq);
  const keys = isObj(b.public_keys) ? (b.public_keys as Record<string, string>) : {};
  const checkpoints = Array.isArray(b.checkpoints) ? b.checkpoints : [];
  const levels = (m.assurance_levels ?? [{ level: 'l1' as LevelId, count: receipts.length, first_seq: receipts[0]?.seq ?? 0, last_seq: receipts[receipts.length - 1]?.seq ?? 0 }]).map((l) => ({ level: l.level, count: l.count, firstSeq: l.first_seq, lastSeq: l.last_seq }));
  const sealedRange = levels.filter((l) => levelRank(l.level) >= 1);
  const isSealedSeq = (seq: number) => sealedRange.some((l) => seq >= l.firstSeq && seq <= l.lastSeq);
  const sealedReceipts = receipts.filter((r) => isSealedSeq(r.seq));
  const topLevel = levels.reduce<LevelId>((acc, l) => (levelRank(l.level) > levelRank(acc) ? l.level : acc), 'l1');

  const sections: VerifySection[] = [];
  let integrityFail = false;
  let incomplete = false;
  const fail = () => { integrityFail = true; };

  // 1 ── Bundle and manifest
  {
    const facts: VerifySection['facts'] = [{ label: 'Format', value: format ?? 'unknown' }, { label: 'Organisation', value: String(m.org ?? '—') }, { label: 'Range', value: receipts.length ? `${receipts[0].seq}–${receipts[receipts.length - 1].seq}` : 'empty' }, { label: 'Records', value: String(receipts.length) }];
    if (!receipts.length) {
      incomplete = true;
      sections.push(section('bundle', 1, 'Bundle and manifest', 'incomplete', 'The bundle holds no receipts.', facts));
    } else if (isL2) {
      const contents: Record<string, unknown> = {
        'receipts.jsonl': b.receipts, 'seals.jsonl': b.seals, 'checkpoints.json': b.checkpoints, 'anchors.json': b.anchors, 'keys.json': b.public_keys, 'declarations.json': b.declarations, 'profile/ (profile.json + VERIFY.txt)': { profile: b.profile ?? null, readme: b.readme ?? '' },
        // optional: checked only when the signed manifest lists it (older bundles have none)
        [LEXICON_MEMBER]: b.lexicon,
      };
      const members = m.members ?? [];
      const lexListed = members.some((x) => x.path === LEXICON_MEMBER);
      const expectedMembers = BUNDLE_MEMBERS.length + (lexListed ? 1 : 0);
      const missing: string[] = [...BUNDLE_MEMBERS.filter((p) => !members.some((x) => x.path === p) || (p !== 'manifest.json' && contents[p] === undefined)), ...(lexListed && b.lexicon === undefined ? [LEXICON_MEMBER] : [])];
      if (!lexListed) {
        notes.push(b.lexicon !== undefined
          ? `The bundle carries a ${LEXICON_MEMBER} that its signed manifest does not list, so it was not used. Rule and refusal ids are shown as the receipts write them.`
          : `This bundle has no lexicon member (bundles made before 28 October 2026). Rule and refusal ids are shown as the receipts write them.`);
      } else if (isObj(b.lexicon) && Array.isArray(b.lexicon.rules)) {
        const known = new Set(b.lexicon.rules.map((x) => x?.id));
        const unknown = Array.from(new Set(receipts.map((r) => r.rule_id).filter((x): x is string => typeof x === 'string' && !known.has(x))));
        if (unknown.length) notes.push(`${unknown.length} rule id${unknown.length === 1 ? '' : 's'} in the receipts ${unknown.length === 1 ? 'is' : 'are'} not in the lexicon: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}.`);
      }
      const mismatched = members.filter((x) => x.path !== 'manifest.json' && contents[x.path] !== undefined && memberDigest(contents[x.path]).sha256 !== x.sha256);
      const signer = m.signing_kid ? keys[m.signing_kid] : undefined;
      const { members: _mm, ...rest } = m;
      void _mm;
      const manifestOk = !!signer && !!b.manifest_sig && verifySig(manifestMessage({ ...rest, members }), b.manifest_sig, signer);
      facts.push({ label: 'Members', value: `${members.length} of ${expectedMembers}` }, { label: 'Lexicon', value: lexListed ? 'listed in the manifest' : 'none' }, { label: 'Manifest signature', value: manifestOk ? 'verifies' : 'does not verify' });
      if (missing.length) {
        incomplete = true;
        sections.push(section('bundle', 1, 'Bundle and manifest', 'incomplete', `Missing member${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`, facts));
      } else if (mismatched.length || !manifestOk) {
        fail();
        sections.push(section('bundle', 1, 'Bundle and manifest', 'fail', mismatched.length ? `${mismatched.length} member${mismatched.length === 1 ? '' : 's'} do not match the digest in the manifest: ${mismatched.map((x) => x.path).join(', ')}.` : 'The manifest signature does not verify.', facts, mismatched[0] ? { field: mismatched[0].path, expected: mismatched[0].sha256.slice(0, 16), found: memberDigest(contents[mismatched[0].path]).sha256.slice(0, 16) } : { field: 'manifest_sig', expected: 'valid Ed25519 signature', found: 'invalid' }));
      } else if (m.record_count !== undefined && m.record_count !== receipts.length) {
        fail();
        sections.push(section('bundle', 1, 'Bundle and manifest', 'fail', `The manifest says ${m.record_count} records; the bundle holds ${receipts.length}.`, facts, { field: 'record_count', expected: String(m.record_count), found: String(receipts.length) }));
      } else {
        sections.push(section('bundle', 1, 'Bundle and manifest', 'pass', `All ${expectedMembers} members${lexListed ? ', the lexicon among them,' : ''} are present and match the signed manifest.`, facts));
      }
    } else if (format === 'auditor-pack/1' && typeof b.manifest_seal === 'string') {
      // the L1 pack's manifest is sealed (Ed25519) and names the last hash, the counts and every file's digest
      const sealer = m.sealing_kid ? keys[m.sealing_kid] : undefined;
      const sealOk = !!sealer && verifySig(manifestMessage(m), b.manifest_seal, sealer);
      const members = m.members ?? [];
      // from the file-digest packs on, the digest is over the file's bytes in the ZIP; earlier sealed packs used canonical JSON
      const byFile = m.digest_of === 'file';
      const contents: Record<string, unknown> = byFile ? l1PackFiles(b) : l1PackContents(b);
      const digestOf = (p: string) => (byFile ? fileDigest(String(contents[p])) : memberDigest(contents[p]));
      const missing = L1_PACK_MEMBERS.filter((p) => p !== 'manifest.json' && (!members.some((x) => x.path === p) || contents[p] === undefined));
      const mismatched = members.filter((x) => x.path !== 'manifest.json' && contents[x.path] !== undefined && digestOf(x.path).sha256 !== x.sha256);
      const last = receipts[receipts.length - 1];
      const first = receipts[0];
      const refusals = receipts.filter((r) => r.decision === 'refuse').length;
      facts.push({ label: 'Files', value: `${members.length} of ${L1_PACK_MEMBERS.length}` }, { label: 'Manifest seal', value: sealOk ? 'verifies' : 'does not verify' }, { label: 'Last hash in manifest', value: m.last_hash ? `${m.last_hash.slice(0, 16)}…` : '—' });
      if (!sealOk) {
        fail();
        sections.push(section('bundle', 1, 'Bundle and manifest', 'fail', sealer ? 'The manifest seal does not verify: the manifest was changed after the pack was sealed.' : `The key that sealed the manifest (${m.sealing_kid ?? 'none named'}) is not in the pack.`, facts, { field: 'manifest_seal', expected: 'valid Ed25519 seal over the manifest', found: sealer ? 'invalid' : 'no key' }));
      } else if (missing.length) {
        incomplete = true;
        sections.push(section('bundle', 1, 'Bundle and manifest', 'incomplete', `Missing file${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`, facts));
      } else if ((m.last_seq !== undefined && m.last_seq !== last.seq) || (m.last_hash && m.last_hash !== last.hash)) {
        fail();
        sections.push(section('bundle', 1, 'Bundle and manifest', 'fail', `The sealed manifest says the pack ends at #${m.last_seq} (${(m.last_hash ?? '').slice(0, 12)}…); it ends at #${last.seq}. The tail was cut off or replaced.`, facts, { seq: last.seq, field: 'last_seq / last_hash', expected: `#${m.last_seq} · ${(m.last_hash ?? '').slice(0, 16)}`, found: `#${last.seq} · ${last.hash.slice(0, 16)}` }));
      } else if (mismatched.length) {
        fail();
        sections.push(section('bundle', 1, 'Bundle and manifest', 'fail', `${mismatched.length} file${mismatched.length === 1 ? '' : 's'} do not match the digest in the sealed manifest: ${mismatched.map((x) => x.path).join(', ')}.`, facts, { field: mismatched[0].path, expected: mismatched[0].sha256.slice(0, 16), found: digestOf(mismatched[0].path).sha256.slice(0, 16) }));
      } else if ((m.first_seq !== undefined && m.first_seq !== first.seq) || (m.record_count ?? m.receipts) !== receipts.length || (m.refusal_count !== undefined && m.refusal_count !== refusals) || (m.checkpoints !== undefined && m.checkpoints !== checkpoints.length)) {
        fail();
        const which = m.first_seq !== undefined && m.first_seq !== first.seq ? { field: 'first_seq', expected: `#${m.first_seq}`, found: `#${first.seq}` }
          : (m.record_count ?? m.receipts) !== receipts.length ? { field: 'record_count', expected: String(m.record_count ?? m.receipts), found: String(receipts.length) }
          : m.refusal_count !== undefined && m.refusal_count !== refusals ? { field: 'refusal_count', expected: String(m.refusal_count), found: String(refusals) }
          : { field: 'checkpoints', expected: String(m.checkpoints), found: String(checkpoints.length) };
        sections.push(section('bundle', 1, 'Bundle and manifest', 'fail', `The sealed manifest's ${which.field.replace('_', ' ')} is ${which.expected}; the pack holds ${which.found}.`, facts, which));
      } else {
        sections.push(section('bundle', 1, 'Bundle and manifest', 'pass', `An L1 auditor pack with a sealed manifest: all ${L1_PACK_MEMBERS.length} files are present and match their digests${byFile ? ' (the SHA-256 of each file’s bytes)' : ''}, and the counts, first and last receipt and last hash match the pack.`, facts));
      }
    } else {
      // no seal: only a pack made before sealed manifests may lack one. Fields only a sealed manifest carries, or a date
      // on or after sealing began, mean the seal was removed — a downgrade that would hide a cut tail or an edited manifest.
      const sealOnly = SEALED_ONLY_FIELDS.filter((k) => m[k] !== undefined);
      const createdMs = typeof m.created_at === 'string' ? Date.parse(m.created_at) : NaN;
      const packLike = format === 'auditor-pack/1' || (format === undefined && isObj(b.manifest) && Object.keys(m).length > 0);
      if (packLike && sealOnly.length) {
        fail();
        facts.push({ label: 'Manifest seal', value: 'missing' });
        sections.push(section('bundle', 1, 'Bundle and manifest', 'fail', `The manifest carries ${sealOnly.join(', ')}, which only a sealed manifest has, but its seal is missing. The seal was removed, so a cut-off tail or an edited manifest would not be caught. Do not rely on this pack.`, facts, { field: 'manifest_seal', expected: `a seal by ${String(m.sealing_kid ?? 'the sealing key')}`, found: 'removed' }));
      } else if (format === 'auditor-pack/1' && (Number.isNaN(createdMs) || createdMs >= SEALED_MANIFEST_FROM)) {
        incomplete = true;
        facts.push({ label: 'Manifest seal', value: 'missing' });
        sections.push(section('bundle', 1, 'Bundle and manifest', 'incomplete', Number.isNaN(createdMs)
          ? 'The manifest is not sealed and names no creation date, so it cannot be told apart from a sealed pack whose seal was removed. Ask the organisation for the pack again.'
          : `Auditor packs made from 28 October 2026 carry a sealed manifest; this one is dated ${String(m.created_at).slice(0, 10)} and has none. Without the seal a cut-off tail or an edited manifest cannot be caught. Ask the organisation for the pack again.`, facts, { field: 'manifest_seal', expected: 'a sealed manifest (packs from 28 October 2026)', found: 'none' }));
      } else {
        if (format === 'auditor-pack/1') notes.push('This auditor pack’s manifest is not sealed (packs made before 28 October 2026). A cut-off tail is caught only where a checkpoint covers it.');
        else if (receipts.length > 1) notes.push('There is no manifest, so nothing fixes where these records end: a cut-off tail is caught only where a checkpoint covers it.');
        sections.push(section('bundle', 1, 'Bundle and manifest', format === 'auditor-pack/1' || receipts.length > 1 ? 'warn' : 'pass', `${format === 'auditor-pack/1' ? `An L1 auditor pack made ${String(m.created_at ?? '').slice(0, 10)}, before manifests were sealed` : 'Receipts without a manifest'}. The receipts are checked one by one below.`, facts));
      }
    }
  }

  // 2 ── Keys and fingerprint
  const kids = Array.from(new Set(receipts.map((r) => r.kid)));
  const missingKeys = kids.filter((k) => !keys[k]);
  const headKid = receipts[receipts.length - 1]?.kid;
  const fpOf = (kid?: string) => (kid && keys[kid] ? sha256Hex(keys[kid]).slice(0, 16) : undefined);
  const fingerprint = fpOf(headKid);
  const allFps = Object.values(keys).map((k) => sha256Hex(k).slice(0, 16));
  const supplied = opts.expectedFingerprint?.trim().toLowerCase();
  const keySource: 'bundle' | 'supplied' = supplied ? 'supplied' : 'bundle';
  // The supplied fingerprint is trusted for the key it names, and for each key that a key.rotated receipt signed by
  // an already-trusted key hands over to. The newest record (and, at L2, the manifest) must be signed by a trusted
  // key; matching some other key in the bundle — one that signed nothing — proves nothing.
  const trusted = new Set<string>();
  if (supplied) {
    for (const kid of Object.keys(keys)) if (fpOf(kid) === supplied) trusted.add(kid);
    for (const r of receipts) {
      const next = r.action === 'key.rotated' ? r.details?.new_kid : undefined;
      if (typeof next === 'string' && trusted.has(r.kid)) trusted.add(next);
    }
  }
  const manifestKid = isL2 ? m.signing_kid : typeof b.manifest_seal === 'string' ? m.sealing_kid : undefined;
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided
  const signedW = topLevel === 'l1' ? 'sealed' : 'signed';
  {
    const facts = [{ label: 'Keys in bundle', value: String(Object.keys(keys).length) }, { label: 'Head key fingerprint', value: fingerprint ?? '—' }, ...(manifestKid ? [{ label: isL2 ? 'Manifest signed by' : 'Manifest sealed by', value: `${manifestKid} (${fpOf(manifestKid) ?? '—'})` }] : []), { label: 'Fingerprint supplied', value: supplied ?? 'no' }];
    const headTrusted = !!headKid && trusted.has(headKid);
    const manifestTrusted = !manifestKid || trusted.has(manifestKid);
    if (missingKeys.length) {
      incomplete = true;
      sections.push(section('keys', 2, 'Keys and fingerprint', 'incomplete', `Receipts name ${missingKeys.length} key${missingKeys.length === 1 ? '' : 's'} not in the bundle: ${missingKeys.join(', ')}.`, facts));
    } else if (supplied && (!headTrusted || !manifestTrusted)) {
      fail();
      const which = !headTrusted ? `the newest record (#${receipts[receipts.length - 1]?.seq}) is ${signedW} by ${headKid} (${fingerprint ?? '—'})` : `the manifest is ${signedW} by ${manifestKid} (${fpOf(manifestKid) ?? '—'})`;
      sections.push(section('keys', 2, 'Keys and fingerprint', 'fail', `The fingerprint you supplied (${supplied}) is not the key that ${signedW} these records: ${which}${allFps.includes(supplied) ? `, and your key is in the ${isL2 ? 'bundle' : 'pack'} but ${signedW === 'sealed' ? 'seals' : 'signs'} nothing here` : ''}. These records were not ${signedW} by the key you expected.`, facts, { field: 'key fingerprint', expected: supplied, found: !headTrusted ? fingerprint ?? '—' : fpOf(manifestKid) ?? '—' }));
    } else if (supplied) {
      sections.push(section('keys', 2, 'Keys and fingerprint', 'pass', `The fingerprint you obtained out of band is the key that ${signedW} the newest record${manifestKid ? ' and the manifest' : ''}${trusted.size > 1 ? `, or a key it handed over to in a ${signedW} key rotation (${trusted.size} keys trusted)` : ''}. Earlier records are bound to it through the hash chain.`, facts));
    } else {
      notes.push('The key came from the bundle itself. A fabricated bundle would carry its own key too: compare the fingerprint with one you obtained from the organisation directly.');
      sections.push(section('keys', 2, 'Keys and fingerprint', 'warn', `Key taken from the bundle (fingerprint ${fingerprint ?? '—'}). Supply the fingerprint you obtained from the organisation to rule out a substituted key.`, facts));
    }
  }

  // 3 + 4 + 5 ── Signatures, hash chain, checkpoints (verifyChain)
  const chain = receipts.length ? verifyChain(receipts, keys, checkpoints, { keySource }) : undefined;
  if (chain) {
    const sigFail = chain.checks.find((c) => c.signature === 'fail');
    const hashFail = chain.checks.find((c) => c.hash === 'fail' || c.link === 'fail' || c.schema === 'fail');
    if (sigFail) fail();
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided
    const l1Only = topLevel === 'l1';
    sections.push(section('signatures', 3, l1Only ? 'Seals' : 'Signatures', sigFail ? 'fail' : missingKeys.length ? 'incomplete' : 'pass', sigFail ? `The ${l1Only ? 'seal' : 'signature'} on #${sigFail.seq} does not verify against the key it names.` : `${chain.checks.filter((c) => c.signature === 'pass').length} Ed25519 receipt ${l1Only ? 'seals' : 'signatures'} verify.`, [{ label: l1Only ? 'Receipts sealed' : 'Receipts signed', value: String(receipts.length) }], sigFail ? { seq: sigFail.seq, field: 'sig', expected: l1Only ? 'valid Ed25519 seal' : 'valid Ed25519 signature', found: 'invalid' } : undefined));
    if (hashFail) fail();
    const hr = hashFail ? receipts.find((r) => r.seq === hashFail.seq) : undefined;
    sections.push(section('chain', 4, 'Hash chain', hashFail ? 'fail' : 'pass', hashFail ? `Broken at #${hashFail.seq}: ${chain.brokenReason ?? 'the hash or link does not match.'}` : `${receipts.length} receipts recompute to their hashes and each names the one before.`, [{ label: 'First', value: `#${chain.firstSeq}` }, { label: 'Last', value: `#${chain.lastSeq}` }], hashFail && hr ? { seq: hr.seq, field: hashFail.hash === 'fail' ? 'hash' : 'prev_hash', expected: hashFail.hash === 'fail' ? 'SHA-256 of canonical body' : 'hash of the receipt before', found: hashFail.hash === 'fail' ? hr.hash.slice(0, 16) : hr.prev_hash.slice(0, 16) } : undefined));
    const cpBad = chain.checkpoints.total - chain.checkpoints.valid;
    if (cpBad) fail();
    sections.push(section('checkpoints', 5, 'Checkpoints', cpBad ? 'fail' : chain.checkpoints.total ? 'pass' : 'warn', cpBad ? `${cpBad} of ${chain.checkpoints.total} ${l1Only ? 'sealed' : 'signed'} checkpoints do not match the chain head they name.` : chain.checkpoints.total ? `${chain.checkpoints.valid} ${l1Only ? 'sealed' : 'signed'} checkpoints match the chain.` : 'No checkpoints in this bundle.', [{ label: 'Checkpoints', value: `${chain.checkpoints.valid} of ${chain.checkpoints.total}` }]));
  } else {
    sections.push(section('signatures', 3, 'Signatures', 'incomplete', 'No receipts to check.'), section('chain', 4, 'Hash chain', 'incomplete', 'No receipts to check.'), section('checkpoints', 5, 'Checkpoints', 'incomplete', 'No receipts to check.'));
  }

  // 3a ── Unsigned intervals: records sealed by Elan1 Govern's interim chain key after a declared key compromise.
  // They are linked into the hash chain (a change still shows) but are not signed with the organisation's key.
  {
    const intervals = Array.isArray(m.unsigned_intervals) ? m.unsigned_intervals : [];
    const interimKids = new Set<string>([...(m.keys ?? []).filter((k) => k?.interim).map((k) => k.kid), ...intervals.map((u) => u?.interim_kid).filter((x): x is string => typeof x === 'string')]);
    const interimRs = receipts.filter((r) => interimKids.has(r.kid));
    if (interimRs.length) {
      const s3 = sections.find((s) => s.id === 'signatures');
      const span = intervals.length ? intervals.map((u) => `#${u.first_seq}–${u.last_seq !== undefined ? `#${u.last_seq}` : 'the head'}`).join(', ') : `#${interimRs[0].seq}–#${interimRs[interimRs.length - 1].seq}`;
      if (s3) {
        if (s3.state === 'pass') s3.state = 'warn';
        s3.detail = `${s3.detail} ${interimRs.length} of them ${interimRs.length === 1 ? 'is' : 'are'} in an unsigned interval (${span}): sealed by Elan1 Govern’s interim chain key, not signed with the organisation’s key.`;
        s3.facts = [...(s3.facts ?? []), { label: 'Unsigned interval', value: `${interimRs.length} record${interimRs.length === 1 ? '' : 's'} · ${span}` }];
      }
      const revoked = intervals.map((u) => u?.revoked_kid).filter(Boolean).join(', ');
      notes.push(`${interimRs.length} record${interimRs.length === 1 ? '' : 's'} (${span}) fall in an unsigned interval after the organisation declared its signing key${revoked ? ` ${revoked}` : ''} compromised. They are linked into the hash chain by Elan1 Govern’s interim chain key${interimKids.size ? ` (${[...interimKids].join(', ')})` : ''}, so a change to them still shows, but they are not signed with the organisation’s key: treat them as hash-chained only.`);
    }
  }

  // 6 ── Anchors and timestamps
  let unanchored = 0;
  let batches = 0;
  let tokens = 0;
  const degraded: string[] = [];
  const anchoredSeqs = new Set<number>();
  if (!sealedReceipts.length) {
    sections.push(section('anchors', 6, 'Anchors and timestamps', 'not_applicable', 'Not applicable — assurance level 1. L1 records are sealed in a hash chain by Elan1 Govern and not yet externally timestamped.'));
  } else if (!b.anchors || !Array.isArray(b.anchors.batches)) {
    incomplete = true;
    sections.push(section('anchors', 6, 'Anchors and timestamps', 'incomplete', `${sealedReceipts.length} L2 records but no anchors member.`));
  } else {
    const auth = new Map((b.anchors.authorities ?? []).map((a) => [a.id, a]));
    const bySeq = new Map(receipts.map((r) => [r.seq, r]));
    let firstBad: VerifySection['firstFailure'] | undefined;
    let badText = '';
    for (const batch of b.anchors.batches) {
      batches++;
      const root = merkleRoot(batch.leaves ?? []);
      if (root !== batch.root) { firstBad ??= { field: `batch ${batch.id} root`, expected: batch.root.slice(0, 16), found: root.slice(0, 16) }; badText ||= `The Merkle root of batch ${batch.id} does not recompute from its leaves.`; continue; }
      for (let s = batch.firstSeq; s <= batch.lastSeq; s++) {
        const r = bySeq.get(s);
        if (!r) continue;
        if (batch.leaves[s - batch.firstSeq] !== r.hash) { firstBad ??= { seq: s, field: 'leaf', expected: batch.leaves[s - batch.firstSeq]?.slice(0, 16) ?? '—', found: r.hash.slice(0, 16) }; badText ||= `Receipt #${s} is not the leaf its batch committed to.`; }
        else anchoredSeqs.add(s);
      }
      const scopes = new Set<string>();
      for (const t of batch.tokens ?? []) {
        tokens++;
        const a = auth.get(t.tsaId);
        const ok = !!a && t.imprint === batch.root && verifySig(tokenMessage(t), t.sig, a.publicKey);
        if (!ok) { firstBad ??= { field: `timestamp ${t.serial}`, expected: 'token signed by the named authority over the batch root', found: a ? 'signature or imprint mismatch' : 'unknown authority' }; badText ||= `A timestamp token on batch ${batch.id} does not verify.`; }
        else scopes.add(a!.id);
      }
      // one valid authority is degraded (a warning), not a failure; none at all fails
      if (scopes.size === 1) degraded.push(batch.id);
      else if (scopes.size < 1) { firstBad ??= { field: `batch ${batch.id} timestamps`, expected: '2 authorities', found: '0' }; badText ||= `Batch ${batch.id} carries no valid timestamp.`; }
    }
    const lastAnchored = Math.max(0, ...b.anchors.batches.map((x) => x.lastSeq));
    unanchored = sealedReceipts.filter((r) => r.seq > lastAnchored).length;
    const gaps = sealedReceipts.filter((r) => r.seq <= lastAnchored && !anchoredSeqs.has(r.seq)).length;
    if (badText) { fail(); sections.push(section('anchors', 6, 'Anchors and timestamps', 'fail', badText, [{ label: 'Batches', value: String(batches) }, { label: 'Tokens', value: String(tokens) }], firstBad)); }
    else if (gaps) { incomplete = true; sections.push(section('anchors', 6, 'Anchors and timestamps', 'incomplete', `${gaps} L2 records fall between batches the bundle does not carry.`)); }
    else {
      if (unanchored) notes.push(`${unanchored} newest records are not yet in a timestamped batch (the unanchored tail). They are signed and chained; their time is not yet externally attested.`);
      if (degraded.length) notes.push(`${degraded.length} batch${degraded.length === 1 ? '' : 'es'} (${degraded.slice(0, 3).join(', ')}${degraded.length > 3 ? '…' : ''}) carry a valid timestamp from only one of the two authorities. That is degraded, not a failure: the records' time is attested by one authority instead of two.`);
      sections.push(section('anchors', 6, 'Anchors and timestamps', unanchored || degraded.length ? 'warn' : 'pass', `${batches} Merkle batches recompute; ${tokens} RFC 3161 timestamp tokens from ${auth.size} authorities verify.${degraded.length ? ` ${degraded.length} batch${degraded.length === 1 ? ' is' : 'es are'} degraded — timestamped by one authority only.` : ''}${unanchored ? ` ${unanchored} newest records are not yet timestamped.` : ''}`, [{ label: 'Batches', value: String(batches) }, { label: 'Tokens', value: String(tokens) }, { label: 'Degraded batches', value: String(degraded.length) }, { label: 'Anchored records', value: String(anchoredSeqs.size) }, { label: 'Unanchored tail', value: String(unanchored) }]));
    }
  }

  // 7 ── Seal v6 records
  let payloadUnbound = 0;
  const seals = Array.isArray(b.seals) ? b.seals : [];
  // erasure is available from L1: an erased L1 record has no seal, so the organisation's redaction signature
  // (checked with the hash chain above) is what binds what is left of it
  const unsealedRedacted = receipts.filter((r) => r.redacted && !isSealedSeq(r.seq)).length;
  if (unsealedRedacted) notes.push(`${unsealedRedacted} L1 record${unsealedRedacted === 1 ? ' has' : 's have'} fields erased on a data principal’s request. L1 records carry no Seal v6 record: the organisation’s redaction seal over every remaining field is checked instead, with their original links.`);
  if (!sealedReceipts.length) {
    sections.push(section('seals', 7, 'Seal v6 records', 'not_applicable', 'Not applicable — assurance level 1. Seal v6 starts at L2 Attested.'));
  } else {
    const sealBySeq = new Map(seals.map((s) => [s.seq, s]));
    const missingSeals = sealedReceipts.filter((r) => !sealBySeq.has(r.seq));
    let bad: { seq: number; field: string; expected: string; found: string } | undefined;
    let prevDigest: string | undefined;
    let prevSeq: number | undefined;
    for (const r of sealedReceipts) {
      const s = sealBySeq.get(r.seq);
      if (!s) { prevDigest = undefined; continue; }
      const c = verifySeal(s, keys[s.kid], r);
      if (s.payloadUnbound) payloadUnbound++;
      if (!bad && !c.structure) bad = { seq: r.seq, field: 'fields', expected: '16 fields F01–F16 in order', found: `${s.fields?.length ?? 0} fields` };
      if (!bad && !c.digest) bad = { seq: r.seq, field: 'digest', expected: 'SHA-256 of the length-prefixed preimage', found: s.digest.slice(0, 16) };
      if (!bad && !c.signature) bad = { seq: r.seq, field: 'seal sig', expected: 'valid Ed25519 signature over the digest', found: 'invalid' };
      if (!bad && !c.binding) bad = { seq: r.seq, field: 'F04 write_id', expected: 'bound to this receipt hash', found: s.fields[3]?.value ?? '—' };
      const f03 = s.fields[2]?.value;
      if (!bad && prevDigest && prevSeq === r.seq - 1 && f03 !== prevDigest) bad = { seq: r.seq, field: 'F03 prev_digest', expected: prevDigest.slice(0, 16), found: (f03 ?? '').slice(0, 16) };
      prevDigest = s.digest;
      prevSeq = r.seq;
    }
    // a receipt exported with erased fields is bound only through its seal: it must have one, marked unbound
    if (!bad) {
      const loose = receipts.find((r) => r.redacted && isSealedSeq(r.seq) && !sealBySeq.get(r.seq)?.payloadUnbound);
      if (loose) bad = { seq: loose.seq, field: 'redacted', expected: 'a seal with its payload unbound by erasure', found: sealBySeq.has(loose.seq) ? 'a seal with a bound payload' : 'no seal' };
    }
    if (bad) { fail(); sections.push(section('seals', 7, 'Seal v6 records', 'fail', `Seal #${bad.seq} does not verify (${bad.field}).`, [{ label: 'Seals', value: String(seals.length) }], bad)); }
    else if (missingSeals.length) { incomplete = true; sections.push(section('seals', 7, 'Seal v6 records', 'incomplete', `${missingSeals.length} L2 records have no seal in the bundle (first #${missingSeals[0].seq}).`)); }
    else {
      const redactedCount = receipts.filter((r) => r.redacted).length;
      if (payloadUnbound) notes.push(`${payloadUnbound} records have an unbound payload: an erasure request destroyed the salt, so the payload hash (F14) can no longer be recomputed from the payload. ${redactedCount ? `In ${redactedCount} of them the values the rules inspected were removed from the receipt; their original signatures, links and seals still verify, and the organisation's redaction signature covers every field left.` : 'The receipt bodies in this bundle are unchanged.'} The seal's record id (F12) is kept as it was sealed: an email domain or account in it is a digest salted with the destroyed salt.`);
      sections.push(section('seals', 7, 'Seal v6 records', 'pass', `${seals.length} sealed records: 16 frozen fields each, digests recompute, Ed25519 signatures verify, each links to the seal before it.${payloadUnbound ? ` ${payloadUnbound} payloads unbound by erasure.` : ''}`, [{ label: 'Sealed', value: String(seals.length) }, { label: 'Payload unbound', value: String(payloadUnbound) }]));
    }
  }

  // 8 ── Profile rules
  let profileOut: VerifyBundleResult['profile'];
  let profileFail = false;
  if (!profile) {
    sections.push(section('profile', 8, 'Profile rules', 'not_applicable', 'No verifier profile claimed. The bundle is checked for integrity only.'));
  } else {
    const ctx = b.declarations?.context;
    const results = runProfileRules(profile, {
      receipts, checkpoints, level: topLevel, anchoredSeqs, anchorBatches: b.anchors?.batches, wormRetentionYears: ctx?.wormRetentionYears ?? 0,
      erasures: ctx?.erasures ?? [], agents: ctx?.agents ?? [], aiSystems: ctx?.aiSystems ?? [], assessments: ctx?.assessments ?? [],
    });
    profileOut = { id: profile.id, version: profile.version, name: profile.name, results, ...(withdrawal ? { withdrawnAt: withdrawal.at, withdrawnReason: withdrawal.reason } : {}) };
    const failed = results.filter((r) => r.state === 'fail');
    profileFail = failed.length > 0;
    const digestNote = m.profile_digest && m.profile_digest !== profile.digest ? ' The bundle claims a different version of this profile.' : '';
    const wdDate = withdrawal ? new Date(withdrawal.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const wdNote = withdrawal ? ` This profile was withdrawn on ${wdDate}.` : '';
    const extraNote = extraRows.length ? ` ${extraRows.length} row${extraRows.length === 1 ? '' : 's'} (${extraRows.map((r) => r.id).join(', ')}) come from the bundle’s own profile and are not measured.` : '';
    if (withdrawal) notes.push(`The claimed verifier profile ${profile.name} v${profile.version} was withdrawn on ${wdDate}${withdrawal.reason ? ` — “${withdrawal.reason}”` : ''}. Its rules are still checked and reported here, but from that date it is no longer a basis for relying on the records against ${profile.regime}.`);
    sections.push(section('profile', 8, 'Profile rules', failed.length ? 'fail' : withdrawal ? 'warn' : 'pass', failed.length ? `${failed.length} of ${results.length} rules of ${profile.name} v${profile.version} fail: ${failed.map((f) => f.id).join(', ')}.${digestNote}${wdNote}${extraNote}` : `All ${results.filter((r) => r.state === 'pass').length} applicable rules of ${profile.name} v${profile.version} pass.${digestNote}${wdNote}${extraNote}`, [...results.map((r) => ({ label: `${r.id} ${r.clause}`, value: r.state })), ...(withdrawal ? [{ label: 'Withdrawn', value: wdDate }] : [])], failed[0] ? { seq: failed[0].failingSeqs[0], field: failed[0].id, expected: failed[0].text, found: failed[0].detail } : undefined));
  }

  // 9 ── Disclosure
  const disclosures = Array.isArray(b.disclosures) ? b.disclosures : [];
  if (!disclosures.length) {
    sections.push(section('disclosure', 9, 'Disclosure', 'not_applicable', m.redaction_profile && m.redaction_profile !== 'none' ? `Redaction profile ${m.redaction_profile}; no disclosure packages in this bundle.` : 'No fields redacted; no disclosure packages in this bundle.'));
  } else {
    const checks = disclosures.map((p) => verifyDisclosure(p, { now: opts.now }));
    const badD = checks.findIndex((c) => !c.valid);
    if (badD >= 0) fail();
    sections.push(section('disclosure', 9, 'Disclosure', badD >= 0 ? 'fail' : 'pass', badD >= 0 ? `Disclosure package ${disclosures[badD].id} does not verify.` : `${disclosures.length} disclosure package${disclosures.length === 1 ? '' : 's'} verify; revealed fields recompute to signed digests.`));
  }

  // ── Code
  const variants: VerifyCode[] = [];
  // L1 evidence is the organisation's own hash chain: no external timestamp, no managed key custody
  const l1Internal = topLevel === 'l1' && receipts.length > 0 && (format === 'auditor-pack/1' || Array.isArray(m.assurance_levels));
  const unbound = payloadUnbound + unsealedRedacted;
  if (unanchored) variants.push('PASS_UNANCHORED_TAIL');
  if (keySource === 'bundle') variants.push('PASS_KEY_FROM_BUNDLE');
  if (l1Internal) variants.push('PASS_L1_INTERNAL');
  if (unbound) variants.push('PASS_PAYLOAD_UNBOUND');
  if (l1Internal) notes.push('L1: internal evidence only. The records are sealed in a hash chain by Elan1 Govern with a key it holds; they are not externally timestamped, so a pass shows they are unaltered since sealing, not when they were made.');
  const code: VerifyCode = integrityFail ? 'FAIL_INTEGRITY' : incomplete ? 'INCOMPLETE' : profileFail ? 'FAIL_PROFILE' : keySource === 'bundle' ? 'PASS_KEY_FROM_BUNDLE' : unanchored ? 'PASS_UNANCHORED_TAIL' : l1Internal ? 'PASS_L1_INTERNAL' : unbound ? 'PASS_PAYLOAD_UNBOUND' : 'PASS';
  const refusals = receipts.filter((r) => r.decision === 'refuse').length;
  const headline =
    code === 'FAIL_INTEGRITY' ? `Integrity fails${chain?.brokenAt ? ` at #${chain.brokenAt}` : ''}. Do not rely on these records.`
    : code === 'INCOMPLETE' ? 'Something needed to check the bundle is missing. Nothing here is a pass or a fail.'
    : code === 'FAIL_PROFILE' ? `Integrity holds, but ${profileOut?.results.filter((r) => r.state === 'fail').length} rule${profileOut?.results.filter((r) => r.state === 'fail').length === 1 ? '' : 's'} of ${profileOut?.name} fail${profileOut?.results.filter((r) => r.state === 'fail').length === 1 ? 's' : ''}.`
    : `${receipts.length} records verify${sealedReceipts.length ? `, ${seals.length} sealed and ${anchoredSeqs.size} timestamped${degraded.length ? ` (${degraded.length} batch${degraded.length === 1 ? '' : 'es'} by one authority only — degraded)` : ' by two authorities'}` : ''}.`;
  const digest = bundleDigest({ manifest: m, receipts });
  // the write types in range: every tool a decision names, most used first (reported under Scope)
  const toolCounts = new Map<string, number>();
  for (const r of receipts) if (r.kind === 'decision' && typeof r.tool === 'string' && r.tool) toolCounts.set(r.tool, (toolCounts.get(r.tool) ?? 0) + 1);
  const writeTypes = [...toolCounts.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  return finish(code, {
    variants: integrityFail || incomplete || profileFail ? [] : variants, format, org: typeof m.org === 'string' ? m.org : undefined, levels, sections, notes, chain, profile: profileOut,
    counts: { receipts: receipts.length, seals: seals.length, payloadUnbound, batches, tokens, checkpoints: checkpoints.length, refusals, unanchored, disclosures: disclosures.length },
    writeTypes,
    fingerprint, keySource,
    reproduction: { command: `govern verify bundle.json${supplied ? ` --fingerprint ${supplied}` : ''}${profile ? ` --profile ${profile.id}` : ''}`, verifierVersion: VERIFIER_VERSION, bundleDigest: digest, profileDigest: profile?.digest },
  }, t0, headline);
}

/* ── The nine-section report ───────────────────────────────────────────── */

export type ReportSectionId = 'verdict' | 'claim' | 'scope' | 'integrity' | 'clauses' | 'first-failure' | 'notes' | 'limits' | 'reproduction';

/** One section of the report: the verifier's own checks are listed under Integrity, the profile's rules under Clause results. */
export interface ReportSection9 {
  n: number;
  id: ReportSectionId;
  title: (typeof REPORT_SECTION_TITLES)[number];
  state: 'pass' | 'fail' | 'warn' | 'info';
  text: string;
  lines: { label: string; value: string }[];
}

const STATE_WORD: Record<VerifySection['state'], string> = { pass: 'Pass', fail: 'Fail', warn: 'Pass with a warning', incomplete: 'Incomplete', not_applicable: 'Not applicable' };

/**
 * Write a verification result as the specification's nine sections: Verdict, Claim, Scope, Integrity, Clause results,
 * First failure, Notes, Limits and Reproduction. Nothing is re-checked; it only arranges what verifyBundle found.
 */
/** The write types in range, as Scope lists them ("none" when no decision names a tool). */
export function writeTypesLine(r: Pick<VerifyBundleResult, 'writeTypes'>): { label: string; value: string } {
  const w = r.writeTypes ?? [];
  return { label: `Write types (${w.length})`, value: w.length ? w.map((x) => `${x.tool} (${x.count})`).join(', ') : 'none — no decision in range names a tool' };
}

/** The profile line /verify shows under Claim: what was checked, beside what the manifest claims. */
export function profileCheckedValue(profileId: string) {
  return profileId === 'none' ? 'none (integrity only)' : profileId;
}

/**
 * `m` is the bundle's manifest (Claim shows the profile it claims); `opts.profileChecked` is the profile the reader
 * chose to check, shown as "Profile checked" as on /verify ('claimed' or omitted: the manifest's own claim was checked).
 */
export function reportSections(r: VerifyBundleResult, m: BundleManifest = {}, opts: { profileChecked?: string } = {}): ReportSection9[] {
  const l1Only = r.levels.length > 0 && r.levels.every((x) => x.level === 'l1');
  const profile = r.profile;
  const integrity = r.sections.filter((s) => s.id !== 'profile');
  const firstFail = r.sections.find((s) => s.firstFailure && (s.state === 'fail' || s.state === 'incomplete'));
  const iFail = integrity.some((s) => s.state === 'fail');
  const iIncomplete = integrity.some((s) => s.state === 'incomplete');
  const sec = (n: number, id: ReportSectionId, state: ReportSection9['state'], text: string, lines: ReportSection9['lines']): ReportSection9 => ({ n, id, title: REPORT_SECTION_TITLES[n - 1], state, text, lines });
  return [
    sec(1, 'verdict', r.exitCode === 0 ? 'pass' : r.code === 'FAIL_INTEGRITY' || r.code === 'FAIL_PROFILE' ? 'fail' : 'warn', r.headline,
      [{ label: 'Result code', value: r.code }, { label: 'Exit code', value: String(r.exitCode) }, { label: 'Meaning', value: CODE_LABELS[r.code] }, ...(r.variants.length ? [{ label: 'Pass variants that apply', value: r.variants.join(', ') }] : [])]),
    sec(2, 'claim', 'info', `${r.org ?? (typeof m.org === 'string' ? m.org : 'The issuer')} claims these records were decided${l1Only ? ' and sealed in a hash chain' : ', signed and chained'} by Elan1 Govern${profile ? `, and that they meet ${profile.name} v${profile.version}` : ''}.`,
      [...r.levels.map((x) => ({ label: `${LEVEL_INFO[x.level].label} · ${x.count} record${x.count === 1 ? '' : 's'}`, value: `#${x.firstSeq}–#${x.lastSeq}` })),
        ...(typeof m.enforcement_mode === 'string' ? [{ label: 'Enforcement mode', value: m.enforcement_mode === 'enforced' ? 'Enforced — governed run (MCP)' : m.enforcement_mode === 'advisory' ? 'Advisory — check and record (REST or SDK)' : m.enforcement_mode === 'mixed' ? 'Both — governed run and check and record' : 'No agent decisions' }] : []),
        { label: 'Format', value: r.format ?? 'receipts' }, { label: 'Profile claimed', value: m.profile_id ? `${m.profile_id}${m.profile_version ? ` v${m.profile_version}` : ''}` : 'none' },
        ...(opts.profileChecked && opts.profileChecked !== 'claimed' ? [{ label: 'Profile checked', value: profileCheckedValue(opts.profileChecked) }] : [])]),
    sec(3, 'scope', 'info', m.continuity_scope === 'range' ? 'A range of the chain. Records before and after it are not covered.' : r.counts.receipts ? 'The records in this file, from the first to the last sequence number.' : 'No records.',
      [{ label: 'Records', value: String(r.counts.receipts) }, { label: 'Range', value: r.chain ? `#${r.chain.firstSeq}–#${r.chain.lastSeq}` : '—' }, writeTypesLine(r), { label: l1Only ? 'Sealed checkpoints' : 'Signed checkpoints', value: String(r.counts.checkpoints) },
        { label: 'Sealed records', value: String(r.counts.seals) }, { label: 'Merkle batches', value: String(r.counts.batches) }, { label: 'Timestamp tokens', value: String(r.counts.tokens) }, { label: 'Refusals among them', value: String(r.counts.refusals) }]),
    sec(4, 'integrity', iFail ? 'fail' : iIncomplete ? 'warn' : 'pass', iFail ? 'At least one integrity check fails. Do not rely on these records.' : iIncomplete ? 'Something needed for an integrity check is missing.' : 'Every applicable integrity check passes.',
      integrity.map((s) => ({ label: `${s.number} ${s.title}`, value: `${STATE_WORD[s.state]} — ${s.detail}` }))),
    sec(5, 'clauses', !profile ? 'info' : profile.results.some((x) => x.state === 'fail') ? 'fail' : 'pass', profile ? `${profile.name} v${profile.version}: ${profile.results.filter((x) => x.state === 'pass').length} pass, ${profile.results.filter((x) => x.state === 'fail').length} fail, ${profile.results.filter((x) => x.state === 'not_applicable').length} not applicable.` : 'No verifier profile was checked, so no regime is claimed.',
      profile ? profile.results.map((x) => ({ label: `${x.id} · ${x.clause}`, value: `${x.state === 'pass' ? 'Pass' : x.state === 'fail' ? 'Fail' : 'Not applicable'} — ${x.text}${x.state === 'fail' ? ` ${x.detail}${x.failingSeqs.length ? ` (first #${x.failingSeqs[0]})` : ''}` : ''}` })) : []),
    sec(6, 'first-failure', firstFail ? 'fail' : 'pass', firstFail ? `${firstFail.title}: ${firstFail.detail}` : r.chain?.brokenAt ? `Broken at #${r.chain.brokenAt}: ${r.chain.brokenReason}` : 'None.',
      firstFail?.firstFailure ? [...(firstFail.firstFailure.seq !== undefined ? [{ label: 'Record', value: `#${firstFail.firstFailure.seq}` }] : []), { label: 'Field', value: firstFail.firstFailure.field }, { label: 'Expected', value: firstFail.firstFailure.expected }, { label: 'Found', value: firstFail.firstFailure.found }] : []),
    sec(7, 'notes', 'info', r.notes.length ? `${r.notes.length} note${r.notes.length === 1 ? '' : 's'}.` : 'No notes.', r.notes.map((t, i) => ({ label: `Note ${i + 1}`, value: t }))),
    sec(8, 'limits', 'info', r.limits, profile ? [{ label: 'Profile limits', value: profileById(profile.id)?.limits ?? '' }] : []),
    sec(9, 'reproduction', 'info', 'Run the same check on your own machine, with no network, and compare the digest.',
      [{ label: 'Command', value: r.reproduction.command }, { label: 'Verifier', value: r.reproduction.verifierVersion }, { label: 'Bundle digest', value: r.reproduction.bundleDigest }, ...(r.reproduction.profileDigest ? [{ label: 'Profile digest', value: r.reproduction.profileDigest }] : []), { label: 'Time taken', value: `${r.ms} ms` }]),
  ];
}
