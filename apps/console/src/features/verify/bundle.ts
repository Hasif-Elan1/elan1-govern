/**
 * The public verifier's model: what was loaded (an L1 auditor pack, an L2+ evidence bundle, one receipt,
 * a selective-disclosure package or a receipt another organisation issued), how it is verified (lib/verify6
 * in a worker for packs and bundles; lib/disclosure for disclosure packages; hash + signature for
 * cross-organisation receipts), and the nine-section report every result is written as:
 *   1 Verdict · 2 Claim · 3 Scope · 4 Integrity · 5 Clause results · 6 First failure · 7 Notes · 8 Limits · 9 Reproduction.
 * Six result codes: PASS (with PASS_UNANCHORED_TAIL, PASS_KEY_FROM_BUNDLE, PASS_L1_INTERNAL and PASS_PAYLOAD_UNBOUND),
 * FAIL_INTEGRITY, FAIL_PROFILE, INCOMPLETE, UNSUPPORTED, USAGE. Precedence 1 > 3 > 2. Everything runs in this browser.
 * Samples are built without recording: nothing is written to a tenant's chain and nothing is billed.
 */
import { db } from '@/api';
import type { CrossOrgReceipt, DisclosurePackage, LevelId, Receipt, RevealedField, VerifyCode, VerifySection, VerifyStep } from '@/types';
import { canonical, receiptHash, sha256Hex, verifySig, type VerifyReport } from '@/lib/crypto';
import { CODE_LABELS, EXIT_CODES, LEXICON_MEMBER, VERIFIER_VERSION, VERIFY_LIMITS, l1PackFiles, profileCheckedValue, verifyBundle, withProfileWithdrawals, writeTypesLine, type EvidenceBundle, type VerifyBundleOptions, type VerifyBundleResult } from '@/lib/verify6';
import { verifyDisclosure, FIELD_LABELS, BUNDLE_FORMAT, bundleFromFile, verifyBundleFile, type DisclosableField } from '@/lib/disclosure';
import { profileById, PROFILES } from '@/lib/profiles';
import { LEVEL_INFO, levelOfOrg } from '@/lib/levels';
import { rupees, seqLabel } from '@/lib/format';
import { buildAuditorPack } from '@/mock/evidence';
import { buildEvidenceBundle, crossOrgView, disclosuresView } from '@/mock/platform';
import { prepareCrossOrg } from '@/mock/l3crossorg';
import { isZip, readZip, writeZip, zipText } from './zip';

export type InputKind = 'bundle' | 'receipt' | 'disclosure' | 'cross' | 'disclosure_bundle';
export type Origin = 'file' | 'paste' | 'sample';

export interface TamperNote { seq?: number; field: string; from: string; to: string; expect: VerifyCode; what: string }

export interface Loaded6 {
  kind: InputKind;
  label: string;
  bytes: number;
  origin: Origin;
  bundle?: EvidenceBundle;
  disclosure?: DisclosurePackage;
  cross?: CrossOrgReceipt;
  /** A selective-disclosure bundle over a range (elan1.disclosure.bundle.v1), as the file was read */
  disclosureBundle?: unknown;
  /** The organisation a sample came from (for its published fingerprint and console links). */
  orgId?: string;
  tamper?: TamperNote;
  fromZip?: boolean;
}

export interface ReportLine { label: string; value: string }
export interface ReportSection { n: number; id: string; title: string; text: string; lines: ReportLine[]; state?: 'pass' | 'fail' | 'warn' | 'info' }

export interface Result6 {
  kind: InputKind;
  code: VerifyCode;
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
  label: string;
  headline: string;
  variants: VerifyCode[];
  /** The verifier's own nine checks (bundles), or the steps for a disclosure or cross-organisation receipt. */
  checks: VerifySection[];
  steps?: VerifyStep[];
  report: ReportSection[];
  chain?: VerifyReport;
  raw?: VerifyBundleResult;
  revealed?: RevealedField[];
  committed?: number;
  fingerprint?: string;
  keySource: 'bundle' | 'supplied';
  ms: number;
  org?: string;
}

export interface RunOptions { fingerprint?: string; publicKey?: string; profileId: string; audience?: string }

/* ── Helpers ─────────────────────────────────────────────────────────── */

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const looksLikeReceipt = (x: unknown): x is Receipt => isObj(x) && 'seq' in x && 'hash' in x && 'sig' in x;
const looksLikeDisclosure = (x: unknown): x is DisclosurePackage => isObj(x) && Array.isArray(x.committed) && Array.isArray(x.revealed) && typeof x.sig === 'string';
const looksLikeCross = (x: unknown): x is CrossOrgReceipt => isObj(x) && typeof x.receiptHash === 'string' && typeof x.sig === 'string' && typeof x.publicKey === 'string' && 'audience' in x;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
export const fingerprintOf = (publicKeyHex: string) => sha256Hex(publicKeyHex).slice(0, 16);
const HEX = /^[0-9a-f]+$/;

/** Normalise a fingerprint as a person typed it: tolerate "sha256:", colons and spaces; accept a 64-hex public key. */
export function normaliseFingerprint(input: string): { value?: string; error?: string } {
  const t = input.trim().toLowerCase().replace(/^sha256:/, '').replace(/[:\s]/g, '');
  if (!t) return {};
  if (!HEX.test(t)) return { error: 'A fingerprint is hexadecimal (0–9, a–f).' };
  if (t.length === 64) return { value: fingerprintOf(t) };
  if (t.length < 16) return { error: 'A fingerprint is 16 hexadecimal characters.' };
  return { value: t.slice(0, 16) };
}

export function isPublicKeyHex(x: string) {
  const v = x.trim().toLowerCase();
  return v.length === 64 && HEX.test(v);
}

export function bytesLabel(b: number) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const downloadJson = (name: string, value: unknown) => downloadBlob(name, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));

/** The evidence claim for records at a level, in the words the product uses. */
export const LEVEL_CLAIM: Record<LevelId, string> = {
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  l1: 'sealed in a hash chain by Elan1 Govern and not yet externally timestamped',
  l2: 'sealed, signed with a key in AWS KMS and timestamped by two authorities',
  l3: 'signed with a key the organisation holds in its own HSM and timestamped by two authorities',
  sovereign: 'signed in the organisation’s own HSM and timestamped by its own two authorities',
};

/* ── Parsing ─────────────────────────────────────────────────────────── */

function fromObject(value: unknown, origin: Origin, label: string, bytes: number): Loaded6 {
  if (Array.isArray(value)) {
    if (value.length && value.every(looksLikeReceipt)) return { kind: 'bundle', origin, label, bytes, bundle: { manifest: {}, public_keys: {}, receipts: value, checkpoints: [] } };
    throw new Error('This list does not hold receipts. Each receipt has seq, hash and sig.');
  }
  if (!isObj(value)) throw new Error('Expected a bundle, a receipt, a disclosure package or a counterparty receipt.');
  if (value.format === BUNDLE_FORMAT && bundleFromFile(value)) return { kind: 'disclosure_bundle', origin, label, bytes, disclosureBundle: value };
  if (Array.isArray(value.receipts)) {
    const b = value as unknown as EvidenceBundle;
    return { kind: 'bundle', origin, label, bytes, bundle: { ...b, manifest: isObj(b.manifest) ? b.manifest : {}, public_keys: isObj(b.public_keys) ? b.public_keys : {}, checkpoints: Array.isArray(b.checkpoints) ? b.checkpoints : [] } };
  }
  if (looksLikeDisclosure(value)) return { kind: 'disclosure', origin, label, bytes, disclosure: value };
  if (isObj(value.package) && looksLikeDisclosure(value.package)) return { kind: 'disclosure', origin, label, bytes, disclosure: value.package };
  if (looksLikeCross(value)) return { kind: 'cross', origin, label, bytes, cross: value };
  if (isObj(value.receipt) && looksLikeReceipt(value.receipt)) {
    const pk = typeof value.public_key === 'string' ? value.public_key : undefined;
    return { kind: 'receipt', origin, label, bytes, bundle: { manifest: {}, public_keys: pk ? { [value.receipt.kid]: pk } : {}, receipts: [value.receipt], checkpoints: [] } };
  }
  if (looksLikeReceipt(value)) return { kind: 'receipt', origin, label, bytes, bundle: { manifest: {}, public_keys: {}, receipts: [value], checkpoints: [] } };
  // Let the verifier say why: it answers USAGE for an input that is not a bundle.
  return { kind: 'bundle', origin, label, bytes, bundle: value as unknown as EvidenceBundle };
}

/** Accepts a bundle or pack (JSON), receipts as JSON lines, one receipt, a disclosure package or a counterparty receipt. */
export function parseText(text: string, origin: Origin, label: string): Loaded6 {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Nothing to read. Choose a file or paste JSON first.');
  const bytes = new Blob([text]).size;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1) {
      try {
        const rs = lines.map((l) => JSON.parse(l));
        if (rs.every(looksLikeReceipt)) return { kind: 'bundle', origin, label, bytes, bundle: { manifest: {}, public_keys: {}, receipts: rs, checkpoints: [] } };
      } catch { /* fall through */ }
    }
    throw new Error('This is not valid JSON. Check that the whole file was copied, including the first { and the last }.');
  }
  return fromObject(value, origin, label, bytes);
}

const jsonl = <T,>(text?: string): T[] | undefined => (text === undefined ? undefined : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as T));
const json = <T,>(text?: string): T | undefined => (text === undefined ? undefined : (JSON.parse(text) as T));

/** Read a file: a ZIP bundle (the 8 members) or JSON. */
export async function parseFile(file: File): Promise<Loaded6> {
  const buf = await file.arrayBuffer();
  if (!isZip(buf)) return parseText(new TextDecoder().decode(buf), 'file', file.name);
  const files = await readZip(buf);
  const names = Object.keys(files);
  const root = names.length && names.every((n) => n.includes('/')) ? names[0].split('/')[0] + '/' : '';
  const t = (p: string) => zipText(files, root + p);
  const manifestText = t('manifest.json');
  if (!manifestText) {
    const single = names.find((n) => /\.json$/i.test(n));
    if (single) return { ...parseText(zipText(files, single)!, 'file', `${file.name} › ${single}`), fromZip: true };
    throw new Error('This ZIP holds no manifest.json. An evidence bundle has manifest.json, receipts.jsonl, seals.jsonl, checkpoints.json, anchors.json, keys.json, declarations.json and profile/.');
  }
  const m = JSON.parse(manifestText) as Record<string, unknown>;
  const manifest = (isObj(m.manifest) ? m.manifest : m) as EvidenceBundle['manifest'];
  const manifest_sig = typeof m.manifest_sig === 'string' ? m.manifest_sig : undefined;
  const manifest_seal = typeof m.manifest_seal === 'string' ? m.manifest_seal : undefined;
  if ('manifest_sig' in manifest) delete (manifest as Record<string, unknown>).manifest_sig;
  if ('manifest_seal' in manifest) delete (manifest as Record<string, unknown>).manifest_seal;
  const l1 = manifest.format === 'auditor-pack/1';
  const bundle: EvidenceBundle = {
    manifest, manifest_sig, manifest_seal,
    // L1 auditor pack: the PDF summary (its text is its bytes), the compliance map and the README
    summary_pdf: l1 ? t('summary.pdf') : undefined,
    compliance_map: l1 ? json(t('compliance-map.json')) : undefined,
    public_keys: json<Record<string, string>>(t('keys.json')) ?? {},
    receipts: jsonl<Receipt>(t('receipts.jsonl')) ?? json<Receipt[]>(t('receipts.json')) ?? [],
    checkpoints: json(t('checkpoints.json')) ?? [],
    seals: jsonl(t('seals.jsonl')),
    anchors: json(t('anchors.json')),
    declarations: json(t('declarations.json')),
    profile: t('profile/profile.json') !== undefined ? json(t('profile/profile.json')) ?? null : undefined,
    readme: l1 ? t('README.txt') : t('profile/VERIFY.txt'),
    disclosures: json(t('disclosures.json')),
    // optional member (bundles made before 28 October 2026 have none)
    lexicon: l1 ? undefined : json(t(LEXICON_MEMBER)),
  };
  for (const k of Object.keys(bundle) as (keyof EvidenceBundle)[]) if (bundle[k] === undefined) delete bundle[k];
  return { kind: 'bundle', origin: 'file', label: file.name, bytes: buf.byteLength, bundle, fromZip: true };
}

/** The bundle (L2+) or auditor pack (L1) as a ZIP with its members, the way govern export writes it. */
export function bundleToZip(b: EvidenceBundle): Blob {
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(b.manifest_sig ? { manifest: b.manifest, manifest_sig: b.manifest_sig } : b.manifest_seal ? { manifest: b.manifest, manifest_seal: b.manifest_seal } : b.manifest, null, 2),
    'receipts.jsonl': b.receipts.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'checkpoints.json': JSON.stringify(b.checkpoints, null, 2),
    'keys.json': JSON.stringify(b.public_keys, null, 2),
  };
  if (b.manifest.format === 'auditor-pack/1') {
    // the same bytes the sealed manifest's file digests are taken over (lib/verify6 l1PackFiles)
    for (const [path, text] of Object.entries(l1PackFiles(b))) if (text !== undefined) files[path] = text;
    return writeZip(files);
  }
  if (b.seals) files['seals.jsonl'] = b.seals.map((s) => JSON.stringify(s)).join('\n') + '\n';
  if (b.anchors) files['anchors.json'] = JSON.stringify(b.anchors);
  if (b.declarations) files['declarations.json'] = JSON.stringify(b.declarations, null, 2);
  if (b.profile !== undefined) files['profile/profile.json'] = JSON.stringify(b.profile, null, 2);
  if (b.readme !== undefined) files['profile/VERIFY.txt'] = b.readme;
  if (b.disclosures) files['disclosures.json'] = JSON.stringify(b.disclosures, null, 2);
  if (b.lexicon) files[LEXICON_MEMBER] = JSON.stringify(b.lexicon, null, 2);
  return writeZip(files);
}

/* ── Samples ─────────────────────────────────────────────────────────── */

export const SAMPLE_ORGS: { id: string; level: LevelId }[] = [
  { id: 'org_demo', level: 'l1' }, { id: 'org_northbank', level: 'l2' }, { id: 'org_kaveri', level: 'l3' }, { id: 'org_deccan', level: 'sovereign' },
];

export type SampleId = 'org_demo' | 'org_northbank' | 'org_kaveri' | 'org_deccan' | 'fail-integrity' | 'fail-integrity-l1' | 'fail-tail-l1' | 'fail-profile' | 'incomplete' | 'unsupported' | 'usage' | 'disclosure' | 'cross' | 'receipt';

const cache = new Map<string, EvidenceBundle>();

/**
 * An organisation's L1 auditor pack, built read-only from its chain: the same pack the console exports (sealed
 * manifest, PDF summary, compliance map, README), but nothing is written to the chain and nothing is billed.
 */
function l1Pack(orgId: string): EvidenceBundle {
  return readOnly(() => buildAuditorPack(db.getDB(orgId), 'system').bundle);
}

/**
 * Open organisations read-only: building a sample opens the organisation's chain in this browser but writes nothing
 * to it (no sandbox seed, approval expiry or hourly checkpoint; those wait until the console opens it).
 */
const readOnly = <T,>(fn: () => T): T => db.readOnlyOpen(fn);

/**
 * An organisation's whole chain as it exports it: the L1 pack at L1, the 8-member bundle from L2. Samples are
 * built without recording: no evidence.exported receipt is written to the organisation's chain and no bundle is billed.
 */
function orgBundle(orgId: string, profileId?: string): EvidenceBundle {
  const key = `${orgId}:${profileId ?? ''}`;
  const hit = cache.get(key);
  if (hit) return clone(hit);
  const b = readOnly(() => {
    const d = db.getDB(orgId);
    return levelOfOrg(d.org) === 'l1' ? l1Pack(orgId) : buildEvidenceBundle(d, 'system', undefined, undefined, profileId).bundle;
  });
  cache.set(key, b);
  return clone(b);
}

/** The fingerprint an organisation publishes for its current signing key (as an auditor would obtain it directly). */
export function publishedFingerprint(orgId: string) {
  const d = readOnly(() => db.getDB(orgId));
  return d.signingKeys.find((k) => k.status === 'active')?.fingerprint ?? d.org.keyFingerprint;
}

export function orgName(orgId: string) { return readOnly(() => db.getDB(orgId).org.name); }

/** Build a sample. Building an organisation's chain is real work; the page shows it is busy first. */
export async function buildSample(id: SampleId): Promise<Loaded6> {
  const sized = (b: EvidenceBundle) => JSON.stringify(b).length;
  if (id === 'org_demo' || id === 'org_northbank' || id === 'org_kaveri' || id === 'org_deccan') {
    const b = orgBundle(id);
    const lv = readOnly(() => levelOfOrg(db.getDB(id).org));
    return { kind: 'bundle', origin: 'sample', orgId: id, label: `${orgName(id)} — ${lv === 'l1' ? 'L1 auditor pack' : `${LEVEL_INFO[lv].tag} evidence bundle`}, whole chain`, bytes: sized(b), bundle: b };
  }
  if (id === 'fail-integrity') {
    const b = orgBundle('org_northbank');
    const sealedFrom = (b.manifest.assurance_levels ?? []).find((l) => l.level !== 'l1')?.first_seq ?? b.receipts[0].seq;
    const sealed = b.receipts.map((r, i) => ({ r, i })).filter(({ r }) => r.seq >= sealedFrom && typeof r.args_summary?.amount === 'number');
    const pick = sealed[Math.floor(sealed.length / 2)] ?? { r: b.receipts[Math.floor(b.receipts.length / 2)], i: 0 };
    let note: TamperNote;
    if (typeof pick.r.args_summary?.amount === 'number') {
      const before = Number(pick.r.args_summary.amount);
      const after = before < 100000 ? before * 10 : Math.round(before / 10);
      pick.r.args_summary.amount = after;
      note = { seq: pick.r.seq, field: 'args_summary.amount', from: rupees(before), to: rupees(after), expect: 'FAIL_INTEGRITY', what: 'One sealed receipt’s amount was changed after it was signed. Nothing else was touched.' };
    } else {
      const before = pick.r.reason ?? '';
      pick.r.reason = `${before} (edited)`;
      note = { seq: pick.r.seq, field: 'reason', from: before || '—', to: pick.r.reason, expect: 'FAIL_INTEGRITY', what: 'One sealed receipt’s reason was edited after it was signed.' };
    }
    return { kind: 'bundle', origin: 'sample', orgId: 'org_northbank', label: `${orgName('org_northbank')} — tampered bundle`, bytes: sized(b), bundle: b, tamper: note };
  }
  if (id === 'fail-integrity-l1') {
    // an L1 auditor pack with one receipt edited after it was sealed
    const b = orgBundle('org_demo');
    const ix = b.receipts.map((r, i) => ({ r, i })).filter(({ r }) => typeof r.args_summary?.amount === 'number');
    const pick = ix[Math.floor(ix.length / 2)];
    let note: TamperNote;
    if (pick) {
      const before = Number(pick.r.args_summary!.amount);
      const after = before < 100000 ? before * 10 : Math.round(before / 10);
      pick.r.args_summary!.amount = after;
      note = { seq: pick.r.seq, field: 'args_summary.amount', from: rupees(before), to: rupees(after), expect: 'FAIL_INTEGRITY', what: 'One receipt’s amount in an L1 auditor pack was changed after it was sealed in the hash chain. Nothing else was touched.' };
    } else {
      const r = b.receipts[Math.floor(b.receipts.length / 2)];
      const before = r.reason ?? '';
      r.reason = `${before} (edited)`;
      note = { seq: r.seq, field: 'reason', from: before || '—', to: r.reason, expect: 'FAIL_INTEGRITY', what: 'One receipt’s reason in an L1 auditor pack was edited after it was sealed.' };
    }
    return { kind: 'bundle', origin: 'sample', orgId: 'org_demo', label: `${orgName('org_demo')} — tampered L1 auditor pack`, bytes: sized(b), bundle: b, tamper: note };
  }
  if (id === 'fail-tail-l1') {
    // an L1 auditor pack whose newest receipts were removed: the sealed manifest's last hash no longer matches
    const b = orgBundle('org_demo');
    const cut = Math.min(12, Math.max(1, b.receipts.length - 1));
    const lastBefore = b.receipts[b.receipts.length - 1].seq;
    b.receipts = b.receipts.slice(0, -cut);
    const keep = new Set(b.receipts.map((r) => r.seq));
    b.checkpoints = b.checkpoints.filter((c) => keep.has(c.seq));
    const lastAfter = b.receipts[b.receipts.length - 1].seq;
    return { kind: 'bundle', origin: 'sample', orgId: 'org_demo', label: `${orgName('org_demo')} — L1 auditor pack with its tail cut off`, bytes: sized(b), bundle: b,
      tamper: { seq: lastAfter, field: 'receipts (tail)', from: `ends at #${lastBefore}`, to: `ends at #${lastAfter}`, expect: 'FAIL_INTEGRITY', what: `The newest ${cut} receipts (and their checkpoints) were removed. Every remaining receipt still verifies, but the sealed manifest names #${lastBefore} and its hash as the last record.` } };
  }
  if (id === 'fail-profile') {
    const b = orgBundle('org_northbank', 'in-rbi-collections');
    return { kind: 'bundle', origin: 'sample', orgId: 'org_northbank', label: `${orgName('org_northbank')} — bundle claiming the RBI collections profile`, bytes: sized(b), bundle: b,
      tamper: { field: 'manifest.profile_id', from: 'none', to: 'in-rbi-collections', expect: 'FAIL_PROFILE', what: 'Nothing was changed: the bundle was exported claiming the RBI collections conduct profile. Its records are intact, but some contacts were made after 19:00 IST, which the profile forbids.' } };
  }
  if (id === 'incomplete') {
    const b = orgBundle('org_northbank');
    delete b.anchors;
    return { kind: 'bundle', origin: 'sample', orgId: 'org_northbank', label: `${orgName('org_northbank')} — bundle with a member missing`, bytes: sized(b), bundle: b,
      tamper: { field: 'anchors.json', from: 'present', to: 'removed', expect: 'INCOMPLETE', what: 'The anchors member was left out, so the timestamps cannot be checked. Nothing here is a pass or a fail.' } };
  }
  if (id === 'unsupported') {
    const b = orgBundle('org_northbank');
    b.manifest.bundle_format = 'elan1.evidence.bundle.v9';
    b.manifest.format = 'elan1.evidence.bundle.v9';
    return { kind: 'bundle', origin: 'sample', orgId: 'org_northbank', label: 'A bundle in a format from the future', bytes: sized(b), bundle: b,
      tamper: { field: 'manifest.bundle_format', from: 'elan1.evidence.bundle.v1', to: 'elan1.evidence.bundle.v9', expect: 'UNSUPPORTED', what: 'The manifest names a bundle format this verifier does not know. It refuses to guess rather than pass or fail it.' } };
  }
  if (id === 'usage') {
    const v = { manifest: { format: 'auditor-pack/1' }, records: [] };
    return { kind: 'bundle', origin: 'sample', label: 'A file that is not a bundle', bytes: JSON.stringify(v).length, bundle: v as unknown as EvidenceBundle,
      tamper: { field: 'receipts', from: 'a list of receipts', to: 'missing (the file says “records”)', expect: 'USAGE', what: 'The input is not an evidence bundle at all, so the verifier answers USAGE with exit code 5.' } };
  }
  if (id === 'disclosure') {
    await new Promise((r) => setTimeout(r, 150));
    const list = readOnly(() => disclosuresView('org_kaveri'));
    const p = list.find((x) => x.status === 'active' && x.revealed.length === 3) ?? list.find((x) => x.status === 'active') ?? list[0];
    if (!p) throw new Error('Kaveri Health has no disclosure package to show.');
    return { kind: 'disclosure', origin: 'sample', orgId: 'org_kaveri', label: `${p.issuerName} — disclosure to ${p.audience.replace('ar-org:', '')}`, bytes: JSON.stringify(p).length, disclosure: clone(p) };
  }
  if (id === 'cross') {
    await new Promise((r) => setTimeout(r, 150));
    // read-only: the counterparty register is prepared in memory; nothing is written to either organisation's chain
    const list = readOnly(() => { prepareCrossOrg('org_kaveri'); return clone(crossOrgView('org_kaveri')); });
    const x = list.find((r) => r.direction === 'received' && r.receipt) ?? list.find((r) => r.direction === 'issued');
    if (!x) throw new Error('No counterparty receipt to show.');
    const issued = x.direction === 'issued' ? { ...x, receipt: readOnly(() => db.getDB('org_kaveri').receipts.find((r) => r.seq === x.seq)) } : x;
    return { kind: 'cross', origin: 'sample', orgId: x.direction === 'received' ? x.issuerOrgId : 'org_kaveri', label: `Receipt from ${x.issuerName} to ${x.direction === 'received' ? 'Kaveri Health Network' : x.counterpartyName}`, bytes: JSON.stringify(issued).length, cross: clone(issued) };
  }
  // one receipt
  const b = l1Pack('org_demo');
  const r = [...b.receipts].reverse().find((x) => x.kind === 'decision' && x.decision === 'ask') ?? b.receipts[b.receipts.length - 1];
  return { kind: 'receipt', origin: 'sample', orgId: 'org_demo', label: `Receipt ${seqLabel(r.seq)} from ${orgName('org_demo')}`, bytes: JSON.stringify(r).length, bundle: { manifest: {}, public_keys: { [r.kid]: b.public_keys[r.kid] }, receipts: [r], checkpoints: [] } };
}

/* ── Running ─────────────────────────────────────────────────────────── */

let worker: Worker | undefined;
let workerBroken = false;

function getWorker() {
  if (workerBroken) return undefined;
  try { worker ??= new Worker(new URL('./verify.worker.ts', import.meta.url), { type: 'module' }); } catch { workerBroken = true; worker = undefined; }
  return worker;
}

/** Stop a running check (the worker is replaced). */
export function cancelVerify() {
  worker?.terminate();
  worker = undefined;
}

let seq = 0;
function verifyOffThread(bundle: unknown, rawOpts: VerifyBundleOptions): Promise<VerifyBundleResult> {
  // the worker has no organisation state: the profiles the bundle's organisation withdrew are read here and passed in
  const opts = withProfileWithdrawals(bundle, rawOpts);
  const w = getWorker();
  const local = () => new Promise<VerifyBundleResult>((res, rej) => window.setTimeout(() => { try { res(verifyBundle(bundle, opts)); } catch (e) { rej(e); } }, 30));
  if (!w) return local();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const done = () => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
    const onMsg = (e: MessageEvent<{ id: number; result?: VerifyBundleResult; error?: string }>) => {
      if (e.data?.id !== id) return;
      done();
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result!);
    };
    const onErr = () => { done(); workerBroken = true; worker = undefined; local().then(resolve, reject); };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, bundle, opts });
  });
}

/** Verify a bundle or pack in the worker (falls back to this thread). The console's export dialog uses it too. */
export const verifyBundleOffThread = (bundle: unknown, opts: VerifyBundleOptions) => verifyOffThread(bundle, opts);

/** Verify what was loaded. Bundles, packs and single receipts use the six-code verifier; packages and counterparty receipts their own checks. */
export async function runVerify(l: Loaded6, o: RunOptions): Promise<Result6> {
  const t0 = performance.now();
  if (l.kind === 'disclosure') return verifyPackage(l.disclosure!, o, t0);
  if (l.kind === 'cross') return verifyCross(l.cross!, o, t0);
  if (l.kind === 'disclosure_bundle') return verifyDisclosureBundleFile(l.disclosureBundle, o, t0);
  const b = clone(l.bundle!) as EvidenceBundle;
  const pk = o.publicKey && isPublicKeyHex(o.publicKey) ? o.publicKey.trim().toLowerCase() : undefined;
  if (pk && Array.isArray(b.receipts) && (!b.public_keys || !Object.keys(b.public_keys).length)) {
    b.public_keys = {};
    for (const r of b.receipts) b.public_keys[r.kid] = pk;
  }
  const raw = await verifyOffThread(b, { profileId: o.profileId === 'claimed' ? undefined : o.profileId, expectedFingerprint: o.fingerprint });
  return fromBundleResult(raw, l, o);
}

function fromBundleResult(raw: VerifyBundleResult, l: Loaded6, o: RunOptions): Result6 {
  const m = l.bundle?.manifest ?? {};
  const levels = raw.levels.length ? raw.levels : [];
  const claimLines: ReportLine[] = levels.map((x) => ({ label: `${LEVEL_INFO[x.level].label} · ${x.count} record${x.count === 1 ? '' : 's'} (#${x.firstSeq}–#${x.lastSeq})`, value: LEVEL_CLAIM[x.level] }));
  const profile = raw.profile;
  const integrity = raw.sections.filter((s) => s.id !== 'profile');
  const firstFail = raw.sections.find((s) => s.firstFailure && (s.state === 'fail' || s.state === 'incomplete'));
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided
  const l1Only = levels.length > 0 && levels.every((x) => x.level === 'l1');
  const report: ReportSection[] = [
    { n: 1, id: 'verdict', title: 'Verdict', state: raw.exitCode === 0 ? 'pass' : raw.code === 'FAIL_INTEGRITY' || raw.code === 'FAIL_PROFILE' ? 'fail' : 'warn', text: raw.headline,
      lines: [{ label: 'Result code', value: raw.code }, { label: 'Exit code', value: String(raw.exitCode) }, { label: 'Meaning', value: CODE_LABELS[raw.code] }, ...(raw.variants.length ? [{ label: 'Pass variants that apply', value: raw.variants.join(', ') }] : [])] },
    { n: 2, id: 'claim', title: 'Claim', state: 'info', text: l.kind === 'receipt' ? `${o.fingerprint?.trim() || o.publicKey?.trim() ? 'One receipt, checked against the key you supplied.' : 'One receipt, checked against the key in the file (no key pinned).'} A single receipt makes no claim about the records around it.` : `${raw.org ?? m.org ?? 'The issuer'} claims these records were decided${l1Only ? ' and sealed in a hash chain' : ', signed and chained'} by Elan1 Govern${profile ? `, and that they meet ${profile.name} v${profile.version}` : ''}.`,
      lines: [...claimLines, ...(typeof m.enforcement_mode === 'string' ? [{ label: 'Enforcement mode', value: `${m.enforcement_mode === 'enforced' ? 'Enforced — governed run (MCP)' : m.enforcement_mode === 'advisory' ? 'Advisory — check and record (REST or SDK)' : m.enforcement_mode === 'mixed' ? 'Mixed — governed run (enforced) and check and record (advisory)' : 'No agent decisions'}, as the manifest states` }] : []), { label: 'Format', value: raw.format ?? 'receipts' }, { label: 'Profile claimed', value: m.profile_id ? `${m.profile_id}${m.profile_version ? ` v${m.profile_version}` : ''}` : 'none' }, ...(o.profileId !== 'claimed' ? [{ label: 'Profile checked', value: profileCheckedValue(o.profileId ?? 'none') }] : [])] },
    { n: 3, id: 'scope', title: 'Scope', state: 'info', text: m.continuity_scope === 'range' ? 'A range of the chain. Records before and after it are not covered.' : raw.counts.receipts ? 'The records in this file, from the first to the last sequence number.' : 'No records.',
      lines: [{ label: 'Records', value: String(raw.counts.receipts) }, { label: 'Range', value: raw.chain ? `#${raw.chain.firstSeq}–#${raw.chain.lastSeq}` : '—' }, writeTypesLine(raw), { label: l1Only ? 'Sealed checkpoints' : 'Signed checkpoints', value: String(raw.counts.checkpoints) }, { label: 'Sealed records', value: String(raw.counts.seals) }, { label: 'Merkle batches', value: String(raw.counts.batches) }, { label: 'Timestamp tokens', value: String(raw.counts.tokens) }, { label: 'Refusals among them', value: String(raw.counts.refusals) }, ...(raw.counts.disclosures ? [{ label: 'Disclosure packages', value: String(raw.counts.disclosures) }] : [])] },
    { n: 4, id: 'integrity', title: 'Integrity', state: integrity.some((s) => s.state === 'fail') ? 'fail' : integrity.some((s) => s.state === 'incomplete') ? 'warn' : 'pass', text: integrity.some((s) => s.state === 'fail') ? 'At least one integrity check fails. Do not rely on these records.' : integrity.some((s) => s.state === 'incomplete') ? 'Something needed for an integrity check is missing.' : 'Every applicable integrity check passes.',
      lines: integrity.map((s) => ({ label: `${s.number} ${s.title}`, value: `${stateWord(s.state)} — ${s.detail}` })) },
    { n: 5, id: 'clauses', title: 'Clause results', state: !profile ? 'info' : profile.results.some((r) => r.state === 'fail') ? 'fail' : 'pass', text: profile ? `${profile.name} v${profile.version}: ${profile.results.filter((r) => r.state === 'pass').length} pass, ${profile.results.filter((r) => r.state === 'fail').length} fail, ${profile.results.filter((r) => r.state === 'not_applicable').length} not applicable.` : 'No verifier profile was checked. Choose one to test the records against a regime’s rules.',
      lines: profile ? profile.results.map((r) => ({ label: `${r.id} · ${r.clause}`, value: `${r.state === 'pass' ? 'Pass' : r.state === 'fail' ? 'Fail' : 'Not applicable'} — ${r.text}${r.state === 'fail' ? ` ${r.detail}${r.failingSeqs.length ? ` (first #${r.failingSeqs[0]})` : ''}` : ''}` })) : [] },
    { n: 6, id: 'first-failure', title: 'First failure', state: firstFail ? 'fail' : 'pass', text: firstFail ? `${firstFail.title}: ${firstFail.detail}` : raw.chain?.brokenAt ? `Broken at #${raw.chain.brokenAt}: ${raw.chain.brokenReason}` : 'None.',
      lines: firstFail?.firstFailure ? [...(firstFail.firstFailure.seq !== undefined ? [{ label: 'Record', value: `#${firstFail.firstFailure.seq}` }] : []), { label: 'Field', value: firstFail.firstFailure.field }, { label: 'Expected', value: firstFail.firstFailure.expected }, { label: 'Found', value: firstFail.firstFailure.found }] : [] },
    { n: 7, id: 'notes', title: 'Notes', state: 'info', text: raw.notes.length ? `${raw.notes.length} note${raw.notes.length === 1 ? '' : 's'}.` : 'No notes.', lines: raw.notes.map((t, i) => ({ label: `Note ${i + 1}`, value: t })) },
    { n: 8, id: 'limits', title: 'Limits', state: 'info', text: VERIFY_LIMITS, lines: profile ? [{ label: 'Profile limits', value: profileById(profile.id)?.limits ?? '' }] : [] },
    { n: 9, id: 'reproduction', title: 'Reproduction', state: 'info', text: 'Run the same check on your own machine, with no network, and compare the digest.',
      lines: [{ label: 'Command', value: raw.reproduction.command }, { label: 'Verifier', value: raw.reproduction.verifierVersion }, { label: 'Bundle digest', value: raw.reproduction.bundleDigest }, ...(raw.reproduction.profileDigest ? [{ label: 'Profile digest', value: raw.reproduction.profileDigest }] : []), { label: 'Time taken', value: `${raw.ms} ms` }] },
  ];
  return { kind: l.kind, code: raw.code, exitCode: raw.exitCode, label: raw.label, headline: raw.headline, variants: raw.variants, checks: raw.sections, report, chain: raw.chain, raw, fingerprint: raw.fingerprint, keySource: raw.keySource, ms: raw.ms, org: raw.org ?? (typeof m.org === 'string' ? m.org : undefined) };
}

const stateWord = (s: string) => (s === 'pass' ? 'Pass' : s === 'fail' ? 'Fail' : s === 'warn' ? 'Pass with a warning' : s === 'incomplete' ? 'Incomplete' : 'Not applicable');

function stepsToChecks(steps: VerifyStep[]): VerifySection[] {
  return steps.map((s, i) => ({ id: 'disclosure', number: i + 1, title: s.label, state: s.state === 'skip' ? 'warn' : s.state, detail: s.detail }));
}

function codeFrom(integrityFail: boolean, keySource: 'bundle' | 'supplied', unanchored: boolean): { code: VerifyCode; variants: VerifyCode[] } {
  if (integrityFail) return { code: 'FAIL_INTEGRITY', variants: [] };
  const variants: VerifyCode[] = [];
  if (unanchored) variants.push('PASS_UNANCHORED_TAIL');
  if (keySource === 'bundle') variants.push('PASS_KEY_FROM_BUNDLE');
  return { code: keySource === 'bundle' ? 'PASS_KEY_FROM_BUNDLE' : unanchored ? 'PASS_UNANCHORED_TAIL' : 'PASS', variants };
}

function simpleReport(code: VerifyCode, headline: string, claim: string, claimLines: ReportLine[], scope: ReportLine[], steps: VerifyStep[], notes: string[], repro: ReportLine[], ms: number): ReportSection[] {
  const failed = steps.find((s) => s.state === 'fail');
  return [
    { n: 1, id: 'verdict', title: 'Verdict', state: EXIT_CODES[code] === 0 ? 'pass' : 'fail', text: headline, lines: [{ label: 'Result code', value: code }, { label: 'Exit code', value: String(EXIT_CODES[code]) }, { label: 'Meaning', value: CODE_LABELS[code] }] },
    { n: 2, id: 'claim', title: 'Claim', state: 'info', text: claim, lines: claimLines },
    { n: 3, id: 'scope', title: 'Scope', state: 'info', text: 'One record, as shared with you.', lines: scope },
    { n: 4, id: 'integrity', title: 'Integrity', state: failed ? 'fail' : 'pass', text: failed ? 'At least one check fails.' : 'Every check that applies passes.', lines: steps.map((s) => ({ label: s.label, value: `${s.state === 'pass' ? 'Pass' : s.state === 'fail' ? 'Fail' : 'Not checked'} — ${s.detail}` })) },
    { n: 5, id: 'clauses', title: 'Clause results', state: 'info', text: 'Verifier profiles apply to bundles, not to a single shared record.', lines: [] },
    { n: 6, id: 'first-failure', title: 'First failure', state: failed ? 'fail' : 'pass', text: failed ? `${failed.label}: ${failed.detail}` : 'None.', lines: [] },
    { n: 7, id: 'notes', title: 'Notes', state: 'info', text: notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}.` : 'No notes.', lines: notes.map((t, i) => ({ label: `Note ${i + 1}`, value: t })) },
    { n: 8, id: 'limits', title: 'Limits', state: 'info', text: 'A pass shows the shared fields were committed and signed by the holder of the named key, unaltered since. It does not show the fields you were not shown, that the underlying action happened, or that it was the right decision. Draft — needs legal review.', lines: [] },
    { n: 9, id: 'reproduction', title: 'Reproduction', state: 'info', text: 'Run the same check on your own machine.', lines: [...repro, { label: 'Verifier', value: VERIFIER_VERSION }, { label: 'Time taken', value: `${ms} ms` }] },
  ];
}

function verifyPackage(p: DisclosurePackage, o: RunOptions, t0: number): Result6 {
  const check = verifyDisclosure(p, { pinnedFingerprint: o.fingerprint, audience: o.audience?.trim() ? (o.audience.startsWith('ar-org:') ? o.audience.trim() : `ar-org:${o.audience.trim()}`) : undefined });
  const integrityFail = check.steps.some((s) => (s.label === 'Issuer signature' || s.label === 'Revealed fields' || s.label === 'Issuer key') && s.state === 'fail');
  const keySource = o.fingerprint ? 'supplied' : 'bundle';
  const { code, variants } = codeFrom(integrityFail, keySource, false);
  const notes: string[] = [];
  const exp = check.steps.find((s) => s.label === 'Expiry');
  if (exp?.state === 'fail') notes.push(`The package is past its expiry (${p.expiresAt.slice(0, 10)}). Its signature still verifies; the issuer no longer stands behind sharing it.`);
  const aud = check.steps.find((s) => s.label === 'Audience');
  if (aud?.state === 'fail') notes.push(`It was issued to ${p.audience}, not to the audience you entered.`);
  if (p.status === 'revoked') notes.push('The issuer withdrew this package; its portal link no longer works.');
  if (keySource === 'bundle') notes.push('The issuer key came from the package. Compare its fingerprint with one you obtained from the issuer directly.');
  const ms = Math.round(performance.now() - t0);
  const fp = fingerprintOf(p.publicKey);
  const headline = integrityFail ? 'The package does not verify. Do not rely on the revealed fields.' : `You are seeing ${check.revealedCount} of ${check.committedCount} committed fields; each recomputes to a digest the issuer signed.`;
  const report = simpleReport(code, headline, `${p.issuerName} committed ${check.committedCount} fields of receipt #${p.seq} and revealed ${check.revealedCount} to ${p.audience}.`,
    [{ label: 'Issuer', value: p.issuerName }, { label: 'Receipt', value: `#${p.seq} · ${p.receiptHash.slice(0, 16)}…` }, { label: 'Audience', value: p.audience }, { label: 'Revealed', value: p.revealed.map((r) => FIELD_LABELS[r.name as DisclosableField] ?? r.name).join(', ') }],
    [{ label: 'Committed fields', value: String(check.committedCount) }, { label: 'Revealed fields', value: String(check.revealedCount) }, { label: 'Hidden but bound', value: String(check.committedCount - check.revealedCount) }, { label: 'Expires', value: p.expiresAt.slice(0, 10) }],
    check.steps, notes, [{ label: 'Command', value: `govern verify disclosure.json${o.fingerprint ? ` --fingerprint ${o.fingerprint}` : ''}` }, { label: 'Issuer key fingerprint', value: fp }], ms);
  return { kind: 'disclosure', code, exitCode: EXIT_CODES[code], label: CODE_LABELS[code], headline, variants, checks: stepsToChecks(check.steps), steps: check.steps, report, revealed: p.revealed, committed: check.committedCount, fingerprint: fp, keySource, ms, org: p.issuerName };
}

function verifyCross(x: CrossOrgReceipt, o: RunOptions, t0: number): Result6 {
  const steps: VerifyStep[] = [];
  const fp = fingerprintOf(x.publicKey);
  const aud = o.audience?.trim() ? (o.audience.startsWith('ar-org:') ? o.audience.trim() : `ar-org:${o.audience.trim()}`) : undefined;
  steps.push({ label: 'Audience', state: !aud ? 'skip' : aud === x.audience ? 'pass' : 'fail', detail: aud ? `Addressed to ${x.audience}${aud === x.audience ? '' : `, not ${aud}`}.` : `Addressed to ${x.audience}. Enter your domain to check it is meant for you.` });
  const expired = new Date(x.expiresAt).getTime() < Date.now();
  steps.push({ label: 'Expiry', state: expired ? 'fail' : 'pass', detail: expired ? `Expired ${x.expiresAt.slice(0, 10)}.` : `Valid until ${x.expiresAt.slice(0, 10)}.` });
  steps.push({ label: 'Issuer key', state: o.fingerprint ? (o.fingerprint === fp ? 'pass' : 'fail') : 'skip', detail: o.fingerprint ? `Fingerprint ${fp} ${o.fingerprint === fp ? 'matches' : 'does not match'} the one you supplied.` : `Key fingerprint ${fp}. Compare it with one you obtained from ${x.issuerName} directly.` });
  const hashOk = !!x.receipt && (() => { try { return receiptHash(x.receipt!) === x.receiptHash && x.receipt!.hash === x.receiptHash; } catch { return false; } })();
  steps.push({ label: 'Content hash', state: x.receipt ? (hashOk ? 'pass' : 'fail') : 'skip', detail: !x.receipt ? 'The full receipt is not in this file; only its hash can be signature-checked.' : hashOk ? 'The receipt recomputes to the hash that was signed.' : 'The receipt does not match the hash that was signed — it was changed.' });
  const sigOk = verifySig(x.receiptHash, x.sig, x.publicKey);
  steps.push({ label: 'Signature', state: sigOk ? 'pass' : 'fail', detail: sigOk ? `Ed25519 signature by ${x.issuerName}’s key verifies over the receipt hash.` : 'The signature does not verify against the key in the file.' });
  steps.push({ label: 'Timestamp', state: 'skip', detail: 'No inclusion proof in this file. Ask the issuer for the receipt’s Merkle path and its two timestamp tokens to check when it existed.' });
  const integrityFail = steps.some((s) => (s.label === 'Content hash' || s.label === 'Signature' || s.label === 'Issuer key') && s.state === 'fail');
  const keySource = o.fingerprint ? 'supplied' : 'bundle';
  const { code, variants } = codeFrom(integrityFail, keySource, true);
  const notes = [
    ...(expired ? ['The receipt is past the date the issuer set for relying on it; its signature still verifies.'] : []),
    'Timestamp: not in this file (unanchored). The receipt is signed; when it existed is not externally attested here.',
  ];
  const ms = Math.round(performance.now() - t0);
  const headline = integrityFail ? `This receipt from ${x.issuerName} does not verify.` : `${x.issuerName} signed this receipt (#${x.seq}) and it is unchanged.`;
  const report = simpleReport(code, headline, x.summary || `${x.issuerName} issued receipt #${x.seq} to ${x.audience}.`,
    [{ label: 'Issuer', value: x.issuerName }, { label: 'Audience', value: x.audience }, { label: 'Nonce', value: x.nonce }],
    [{ label: 'Receipt', value: `#${x.seq}` }, { label: 'Receipt hash', value: x.receiptHash }, { label: 'Issued', value: x.issuedAt }, { label: 'Expires', value: x.expiresAt }],
    steps, notes, [{ label: 'Command', value: `govern verify action-receipt.json${o.fingerprint ? ` --fingerprint ${o.fingerprint}` : ''}` }, { label: 'Message signed', value: 'the receipt hash (SHA-256 over canonical JSON)' }, { label: 'Canonical form', value: x.receipt ? `${canonical(x.receipt).length} bytes` : '—' }], ms);
  return { kind: 'cross', code, exitCode: EXIT_CODES[code], label: CODE_LABELS[code], headline, variants, checks: stepsToChecks(steps), steps, report, fingerprint: fp, keySource, ms, org: x.issuerName };
}

/** A selective-disclosure bundle file (elan1.disclosure.bundle.v1): one signature over many receipts' committed digests, checked from the file alone. */
function verifyDisclosureBundleFile(file: unknown, o: RunOptions, t0: number): Result6 {
  const aud = o.audience?.trim() ? (o.audience.startsWith('ar-org:') ? o.audience.trim() : `ar-org:${o.audience.trim()}`) : undefined;
  const check = verifyBundleFile(file, { pinnedFingerprint: o.fingerprint, audience: aud });
  if (!check) throw new Error('This is not a disclosure bundle file (elan1.disclosure.bundle.v1).');
  const b = check.bundle;
  const integrityFail = check.steps.some((s) => (s.label === 'Manifest' || s.label === 'Issuer signature' || s.label === 'Revealed fields' || s.label === 'Issuer key') && s.state === 'fail');
  const keySource = o.fingerprint ? 'supplied' : 'bundle';
  const { code, variants } = codeFrom(integrityFail, keySource, false);
  const notes: string[] = [];
  if (check.steps.find((s) => s.label === 'Expiry')?.state === 'fail') notes.push(`The bundle is past its expiry (${b.expiresAt.slice(0, 10)}). Its signature still verifies; the issuer no longer stands behind sharing it.`);
  if (check.steps.find((s) => s.label === 'Audience')?.state === 'fail') notes.push(`It was issued to ${b.audience}, not to the audience you entered.`);
  if (keySource === 'bundle') notes.push('The issuer key came from the file. Compare its fingerprint with one you obtained from the issuer directly.');
  notes.push('The receipts in the range are not shown in full: each is represented by its hash and its committed digests. Timestamp tokens travel in the issuer’s evidence bundle, not in this file.');
  const ms = Math.round(performance.now() - t0);
  const fp = fingerprintOf(b.publicKey);
  const headline = integrityFail ? 'The bundle does not verify. Do not rely on the revealed values.' : `One signature covers ${b.items.length} receipts (#${b.range.fromSeq}–#${b.range.toSeq}); every revealed value recomputes to a digest the issuer signed.`;
  const report = simpleReport(code, headline, `${b.issuerName} committed every field of ${b.items.length} receipts and revealed ${b.fields.length} fields of each to ${b.audience}.`,
    [{ label: 'Issuer', value: `${b.issuerName} (iss ${b.orgId})` }, { label: 'Audience', value: b.audience }, { label: 'Revealed', value: b.fields.map((f) => FIELD_LABELS[f as DisclosableField] ?? f).join(', ') }, ...(b.profileName ? [{ label: 'Profile', value: b.profileName }] : [])],
    [{ label: 'Receipts', value: String(b.items.length) }, { label: 'Range', value: `#${b.range.fromSeq}–#${b.range.toSeq} (${b.range.kinds === 'all' ? 'all receipts' : 'decisions'})` }, { label: 'Revealed values', value: String(check.revealedCount) }, { label: 'Committed digests', value: String(check.committedCount) }, { label: 'Expires', value: b.expiresAt.slice(0, 10) }],
    check.steps, notes, [{ label: 'Command', value: `govern verify disclosure-bundle.json${o.fingerprint ? ` --fingerprint ${o.fingerprint}` : ''}` }, { label: 'Issuer key fingerprint', value: fp }, { label: 'Message signed', value: 'SHA-256 over the canonical manifest, as the file’s signature.signed describes' }], ms);
  report[2] = { ...report[2], text: `A range of ${b.items.length} receipts, as shared with you. Receipts before and after it are not covered.` };
  report[4] = { ...report[4], text: 'Verifier profiles apply to evidence bundles, not to a disclosure bundle.' };
  return { kind: 'disclosure_bundle', code, exitCode: EXIT_CODES[code], label: CODE_LABELS[code], headline, variants, checks: stepsToChecks(check.steps), steps: check.steps, report, fingerprint: fp, keySource, ms, org: b.issuerName };
}

/** The report as plain text, the way govern verify prints it. */
export function reportText(r: Result6, label: string) {
  const out = [`Elan1 Govern verifier · ${VERIFIER_VERSION}`, `Input: ${label}`, `Checked: ${new Date().toISOString()}`, ''];
  for (const s of r.report) {
    out.push(`${s.n}. ${s.title.toUpperCase()}`, `   ${s.text}`);
    for (const l of s.lines) out.push(`   - ${l.label}: ${l.value}`);
    out.push('');
  }
  out.push(`exit ${r.exitCode}`);
  return out.join('\n');
}

export const PROFILE_OPTIONS = [
  { value: 'claimed', label: 'The profile the bundle claims (if any)' },
  { value: 'none', label: 'None — integrity only' },
  ...PROFILES.map((p) => ({ value: p.id, label: `${p.name} · ${p.jurisdiction}` })),
];
