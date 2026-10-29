/**
 * The offline verifier's release files, built in this browser from the same code the verifier runs:
 * the 64 test vectors, a reference bundle that passes, a deliberately tampered bundle that fails, the build
 * instructions and the licences — listed in SHA256SUMS, which the release key signs (Ed25519).
 *
 * The signature checks with stock OpenSSL: the public key is published as PEM and the signature as raw bytes.
 *
 * A release is fixed once it is built: its files are kept byte for byte (in this browser's storage) and served
 * again unchanged, so a file downloaded earlier still matches SHA256SUMS whatever happens to the demo chain later.
 * The sample bundles are a fixed stretch of the demo organisation's chain (from its first receipt to a checkpoint),
 * opened read-only, so building a release writes nothing to any chain. Every release, superseded ones included,
 * can be downloaded with its dated note.
 */
import { api, db } from '@/api';
import { keyFromSeed, signText, verifySig } from '@/lib/crypto';
import { LEGAL_ENTITY } from '@/lib/company';
import { bundleToZip } from '@/features/verify/bundle';
import { buildAuditorPack } from '@/mock/evidence';
import { VERIFIER_RELEASES, type VerifierRelease } from '@/mock/devpathData';
import type { EvidenceBundle } from '@/lib/verify6';

export const RELEASE_KEY = keyFromSeed('elan1-govern-verifier-release-key-2026', 'rel_2026_10');

export interface ReleaseFile { name: string; blob: Blob; sha256: string; bytes: number; what: string; licence: string }
export interface Release {
  version: string; date: string; status: VerifierRelease['status']; note: string; supersededOn?: string; why?: string;
  files: ReleaseFile[]; sums: string; sigHex: string; pem: string; pubHex: string; fingerprint: string;
  /** when the files were fixed (first built); they are served unchanged from then on */
  fixedAt: string;
}

const hexOf = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256OfBlob(blob: Blob) {
  return hexOf(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

const hexToBytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

/** An Ed25519 public key as SubjectPublicKeyInfo PEM (what openssl pkeyutl -pubin reads). */
export function ed25519Pem(pubHex: string) {
  const der = new Uint8Array([...hexToBytes('302a300506032b6570032100'), ...hexToBytes(pubHex)]);
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

const text = (s: string) => new Blob([s], { type: 'text/plain' });

function buildTxt(version: string) {
  return [
    `govern verify ${version} — how to build it yourself`,
    '',
    'The verifier is open source (Apache-2.0). You do not have to trust our binaries: build it and compare.',
    '',
    '  git clone https://github.com/elan1/govern-verify',
    `  cd govern-verify && git checkout v${version}`,
    '  npm ci && npm run build            # TypeScript implementation',
    '  pip install -e ./python            # Python implementation (the second implementation)',
    '  npm test && pytest python/tests    # both run the 64 test vectors',
    '',
    'Then check the files on this page:',
    '',
    '  sha256sum -c SHA256SUMS',
    '  openssl pkeyutl -verify -pubin -inkey elan1-release-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig',
    '',
    'And run the two sample bundles:',
    '',
    `  govern verify govern-verify-${version}-reference-bundle.zip   # PASS, exit 0`,
    `  govern verify govern-verify-${version}-tampered-bundle.zip    # FAIL_INTEGRITY, exit 1`,
    '',
    'Nothing here needs an account or a network connection.',
    '',
  ].join('\n');
}

function licencesTxt(year: string) {
  return [
    'Licences',
    '',
    'Action Receipt specification text ....... Creative Commons Attribution 4.0 International (CC BY 4.0)',
    'Reference verifier (govern verify) ...... Apache License 2.0',
    'Test vectors and sample bundles ......... CC0 1.0 Universal (public domain dedication)',
    '',
    `Copyright ${year} ${LEGAL_ENTITY}.`,
    '',
  ].join('\n');
}

function releaseNoteTxt(r: VerifierRelease) {
  return [
    `govern verify ${r.version} — released ${r.date}`,
    '',
    r.note,
    '',
    ...(r.status === 'superseded'
      ? [`Superseded on ${r.supersededOn}.`, r.why ? `Why: ${r.why}` : '', '', 'Kept downloadable so a result made with this version can be reproduced on the day it was made.']
      : ['This is the current release.']),
    '',
  ].join('\n');
}

/* ── Fixed sample bundles ─────────────────────────────────── */

/**
 * The reference bundle: an L1 auditor pack over a fixed stretch of the demo organisation's chain — its first receipt
 * up to the checkpoint nearest receipt 160 — built read-only (nothing is written to the chain, nothing is billed).
 */
function referencePack(): { bundle: EvidenceBundle; label: string } {
  return db.readOnlyOpen(() => {
    const d = db.getDB('org_demo');
    const first = d.receipts[0].seq;
    const target = d.receipts[Math.min(159, d.receipts.length - 1)].seq;
    const cp = [...d.checkpoints].filter((c) => c.seq >= first && c.seq <= target).pop();
    const to = cp?.seq ?? target;
    const built = buildAuditorPack(d, 'system', first, to, { container: 'zip' });
    return { bundle: built.bundle, label: `${d.org.name} — L1 auditor pack, receipts #${first}–#${to}` };
  });
}

/** The tampered bundle: the reference pack with one receipt's amount changed after it was sealed. */
function tamperedPack(ref: EvidenceBundle): { bundle: EvidenceBundle; note: string } {
  const b = JSON.parse(JSON.stringify(ref)) as EvidenceBundle;
  const withAmount = b.receipts.filter((r) => typeof r.args_summary?.amount === 'number');
  const r = withAmount[Math.floor(withAmount.length / 2)] ?? b.receipts[Math.floor(b.receipts.length / 2)];
  if (typeof r.args_summary?.amount === 'number') {
    const before = Number(r.args_summary.amount);
    r.args_summary.amount = before < 100000 ? before * 10 : Math.round(before / 10);
    return { bundle: b, note: `#${r.seq}, args_summary.amount` };
  }
  r.reason = `${r.reason ?? ''} (edited)`;
  return { bundle: b, note: `#${r.seq}, reason` };
}

/* ── Keeping a release fixed ──────────────────────────────── */

const STORE = (v: string) => `eg:data:verifier-release:${v}`;
interface Stored { fixedAt: string; files: { name: string; b64: string; type: string; what: string; licence: string }[] }

async function toB64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (b64: string, type: string) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };

function loadStored(v: string): Stored | undefined {
  try { const raw = localStorage.getItem(STORE(v)); return raw ? JSON.parse(raw) as Stored : undefined; } catch { return undefined; }
}

const cache = new Map<string, Release>();
const building = new Map<string, Promise<Release>>();

/** Build one release's files (the current one by default), or serve them exactly as they were first built. */
export function buildRelease(version?: string): Promise<Release> {
  const r = VERIFIER_RELEASES.find((x) => (version ? x.version === version : x.status === 'current'))!;
  const hit = cache.get(r.version);
  if (hit) return Promise.resolve(hit);
  let p = building.get(r.version);
  if (!p) { p = make(r); building.set(r.version, p); p.finally(() => building.delete(r.version)).catch(() => undefined); }
  return p;
}

async function make(r: VerifierRelease): Promise<Release> {
  const v = r.version;
  let stored = loadStored(v);
  let raw: { name: string; blob: Blob; what: string; licence: string }[];
  if (stored) {
    raw = stored.files.map((f) => ({ name: f.name, blob: fromB64(f.b64, f.type), what: f.what, licence: f.licence }));
  } else {
    const vectors = await api.testVectors();
    const ref = referencePack();
    const bad = tamperedPack(ref.bundle);
    raw = [
      { name: `govern-verify-${v}-test-vectors.json`, blob: new Blob([JSON.stringify(vectors, null, 2)], { type: 'application/json' }), what: `${vectors.vectors.length} Seal v6 test vectors with expected digests and both implementations’ results.`, licence: 'CC0 1.0' },
      { name: `govern-verify-${v}-reference-bundle.zip`, blob: bundleToZip(ref.bundle), what: `${ref.label}. Expected: PASS, exit 0.`, licence: 'CC0 1.0' },
      { name: `govern-verify-${v}-tampered-bundle.zip`, blob: bundleToZip(bad.bundle), what: `The same pack with one receipt edited after it was sealed in the hash chain (${bad.note}). Expected: FAIL_INTEGRITY, exit 1.`, licence: 'CC0 1.0' },
      { name: 'BUILD.txt', blob: text(buildTxt(v)), what: 'How to build the verifier from source and check this release.', licence: 'Apache-2.0' },
      { name: 'LICENSES.txt', blob: text(licencesTxt(r.date.slice(0, 4))), what: 'The licence of every part of the release.', licence: '—' },
      { name: 'RELEASE-NOTE.txt', blob: text(releaseNoteTxt(r)), what: r.status === 'superseded' ? `The dated note: released ${r.date}, superseded on ${r.supersededOn}, and why.` : `The dated note: released ${r.date}.`, licence: '—' },
    ];
    const fixedAt = new Date().toISOString();
    stored = { fixedAt, files: await Promise.all(raw.map(async (f) => ({ name: f.name, b64: await toB64(f.blob), type: f.blob.type || 'application/octet-stream', what: f.what, licence: f.licence }))) };
    try { localStorage.setItem(STORE(v), JSON.stringify(stored)); } catch { /* storage full: kept for this page's life */ }
  }
  const files: ReleaseFile[] = [];
  for (const f of raw) files.push({ ...f, sha256: await sha256OfBlob(f.blob), bytes: f.blob.size });
  const sums = files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n';
  const sigHex = signText(sums, RELEASE_KEY);
  const rel: Release = {
    version: v, date: r.date, status: r.status, note: r.note, supersededOn: r.supersededOn, why: r.why,
    files, sums, sigHex, pem: ed25519Pem(RELEASE_KEY.publicKeyHex), pubHex: RELEASE_KEY.publicKeyHex, fingerprint: RELEASE_KEY.fingerprint, fixedAt: stored.fixedAt,
  };
  cache.set(v, rel);
  return rel;
}

/** Check SHA256SUMS against its signature with the release key (or any key given). */
export function checkSums(sums: string, sigHex: string, pubHex = RELEASE_KEY.publicKeyHex) {
  return verifySig(sums, sigHex, pubHex);
}

export const sigBlob = (sigHex: string) => new Blob([hexToBytes(sigHex)], { type: 'application/octet-stream' });
