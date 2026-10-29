/**
 * Real cryptography for the demo chain and the in-browser verifier.
 * Mirrors the built receipt rules: SHA-256 over canonical JSON (sorted keys, no whitespace),
 * Ed25519 over the hash string, each receipt carrying the previous receipt's hash.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { Checkpoint, Receipt } from '@/types';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export const GENESIS = '0'.repeat(64);

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
      .join(',') +
    '}'
  );
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export interface KeyPair {
  kid: string;
  privateKey: Uint8Array;
  publicKeyHex: string;
  fingerprint: string;
}

export function keyFromSeed(seedText: string, kid: string): KeyPair {
  const privateKey = sha256(utf8ToBytes(seedText));
  const pub = ed.getPublicKey(privateKey);
  const publicKeyHex = bytesToHex(pub);
  return { kid, privateKey, publicKeyHex, fingerprint: sha256Hex(publicKeyHex).slice(0, 16) };
}

type Unsigned<T> = Omit<T, 'hash' | 'sig'>;

export function receiptHash(r: Unsigned<Receipt> | Receipt): string {
  const { hash: _h, sig: _s, ...body } = r as Receipt;
  return sha256Hex(canonical(body));
}

/**
 * What the organisation signs when an erasure removes fields from a receipt: SHA-256 over the canonical redacted
 * receipt, with its original hash and without the attestation's own kid and sig. Every field left after erasure
 * (decision, tool, actor, outcome, ts …) is covered, and so is the original receipt hash it replaces.
 */
export function redactionMessage(r: Receipt): string {
  const { sig: _s, redacted, ...rest } = r;
  const { kid: _k, sig: _rs, ...red } = redacted ?? { fields: [], reason: '' };
  return sha256Hex(canonical({ ...rest, redacted: red }));
}

/** Sign the redaction of a receipt (see redactionMessage). */
export function signRedaction(r: Receipt, key: KeyPair): Receipt {
  const base: Receipt = { ...r, redacted: { ...(r.redacted ?? { fields: [], reason: '' }), kid: key.kid, sig: undefined } };
  return { ...base, redacted: { ...base.redacted!, sig: bytesToHex(ed.sign(utf8ToBytes(redactionMessage(base)), key.privateKey)) } };
}

/**
 * Does the receipt's content match what was signed? An ordinary receipt: its SHA-256 equals the stored hash. A
 * receipt with fields removed by erasure: the organisation's redaction signature verifies over everything left
 * (its hash cannot be recomputed without the removed values). `keys` maps kid → public key hex.
 */
export function contentOk(r: Receipt, keys: Record<string, string | undefined>): boolean {
  if (!r.redacted) return receiptHash(r) === r.hash;
  const pub = r.redacted.kid ? keys[r.redacted.kid] : undefined;
  return !!pub && !!r.redacted.sig && verifySig(redactionMessage(r), r.redacted.sig, pub);
}

export function signReceipt(body: Unsigned<Receipt>, key: KeyPair): Receipt {
  const hash = receiptHash(body);
  const sig = bytesToHex(ed.sign(utf8ToBytes(hash), key.privateKey));
  return { ...body, hash, sig } as Receipt;
}

export function signCheckpoint(cp: Omit<Checkpoint, 'sig'>, key: KeyPair): Checkpoint {
  const msg = canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid });
  return { ...cp, sig: bytesToHex(ed.sign(utf8ToBytes(msg), key.privateKey)) };
}

/** Ed25519 over the UTF-8 bytes of a text message (the same convention verifySig checks). */
export function signText(message: string, key: KeyPair): string {
  return bytesToHex(ed.sign(utf8ToBytes(message), key.privateKey));
}

export function verifySig(messageHex: string, sigHex: string, publicKeyHex: string): boolean {
  try {
    return ed.verify(hexToBytes(sigHex), utf8ToBytes(messageHex), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/* ── Verification, three-valued ───────────────────────────── */

export type CheckState = 'pass' | 'fail' | 'skip';

export interface ReceiptCheck {
  seq: number;
  schema: CheckState;
  hash: CheckState;
  signature: CheckState;
  link: CheckState;
  key: CheckState;
}

export interface VerifyReport {
  result: 'verified' | 'failed' | 'cannot_verify';
  exitCode: 0 | 1 | 2;
  receipts: number;
  firstSeq?: number;
  lastSeq?: number;
  brokenAt?: number;
  brokenReason?: string;
  checkpoints: { total: number; valid: number };
  keyFingerprint?: string;
  keySource: 'bundle' | 'supplied';
  checks: ReceiptCheck[];
  summary: { label: string; state: CheckState; detail: string }[];
  ms: number;
}

const REQUIRED: (keyof Receipt)[] = ['seq', 'ts', 'org', 'kind', 'prev_hash', 'kid', 'hash', 'sig'];

/**
 * When each key stopped signing: from the key.rotated receipts in the set (the old kid is retired after that
 * receipt), plus any windows the caller knows (`retiredAt`, an ISO time). A receipt signed by a key after its
 * retirement fails the key check.
 */
function retirements(sorted: Receipt[], windows: Record<string, { retiredAt?: string }> = {}) {
  const afterSeq = new Map<string, number>();
  for (const r of sorted) {
    const old = r.action === 'key.rotated' ? r.details?.old_kid : undefined;
    if (typeof old === 'string' && old && !afterSeq.has(old)) afterSeq.set(old, r.seq);
  }
  const afterTime = new Map<string, number>();
  for (const [kid, w] of Object.entries(windows)) if (w.retiredAt) afterTime.set(kid, new Date(w.retiredAt).getTime());
  return (r: Receipt) => {
    const s = afterSeq.get(r.kid);
    if (s !== undefined && r.seq > s) return true;
    const t = afterTime.get(r.kid);
    return t !== undefined && new Date(r.ts).getTime() > t;
  };
}

export function verifyChain(
  receipts: Receipt[],
  keys: Record<string, string>, // kid -> public key hex
  checkpoints: Checkpoint[] = [],
  opts: { keySource?: 'bundle' | 'supplied'; expectedPrev?: string; keyWindows?: Record<string, { retiredAt?: string }> } = {},
): VerifyReport {
  const t0 = performance.now();
  const checks: ReceiptCheck[] = [];
  let brokenAt: number | undefined;
  let brokenReason: string | undefined;
  let prev = opts.expectedPrev;

  if (!receipts.length) {
    return {
      result: 'cannot_verify', exitCode: 2, receipts: 0, checkpoints: { total: 0, valid: 0 }, keySource: opts.keySource ?? 'bundle',
      checks: [], ms: 0,
      summary: [{ label: 'Receipts found', state: 'fail', detail: 'The file holds no receipts to check.' }],
    };
  }

  const sorted = [...receipts].sort((a, b) => a.seq - b.seq);
  const retired = retirements(sorted, opts.keyWindows);
  let retiredUse = false;
  let redacted = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const c: ReceiptCheck = { seq: r.seq, schema: 'pass', hash: 'pass', signature: 'pass', link: 'pass', key: 'pass' };
    if (REQUIRED.some((k) => r[k] === undefined || r[k] === null)) c.schema = 'fail';
    const pub = keys[r.kid];
    if (!pub) c.key = 'fail';
    else if (retired(r)) { c.key = 'fail'; retiredUse = true; }
    // a receipt with erased fields cannot recompute its hash: the organisation's redaction signature covers every
    // field left (and the original hash), so changing its decision, tool, actor or outcome still fails here
    if (r.redacted) redacted++;
    if (!contentOk(r, keys)) c.hash = 'fail';
    c.signature = pub ? (verifySig(r.hash, r.sig, pub) ? 'pass' : 'fail') : 'skip';
    if (i > 0) {
      if (sorted[i - 1].seq + 1 !== r.seq) c.link = 'fail';
      else if (r.prev_hash !== sorted[i - 1].hash) c.link = 'fail';
    } else if (prev !== undefined && r.prev_hash !== prev) c.link = 'fail';
    checks.push(c);
    if (brokenAt === undefined && Object.values(c).some((v) => v === 'fail')) {
      brokenAt = r.seq;
      brokenReason =
        c.hash === 'fail' ? (r.redacted ? 'The erased receipt does not match its redaction signature — a field was changed after the erasure.' : 'The content does not match its hash — the receipt was changed after it was signed.')
        : c.link === 'fail' ? 'The previous-hash link or sequence is broken — a receipt was removed, reordered or replaced.'
        : c.signature === 'fail' ? 'The signature does not verify against the named key.'
        : c.key === 'fail' ? (pub ? 'The receipt is signed by a key that was retired before it was written.' : 'The receipt names a key that is not in the bundle.')
        : 'A required field is missing.';
    }
    prev = r.hash;
  }

  let validCps = 0;
  for (const cp of checkpoints) {
    const pub = keys[cp.kid];
    const msg = canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid });
    const r = sorted.find((x) => x.seq === cp.seq);
    if (pub && verifySig(msg, cp.sig, pub) && (!r || r.hash === cp.hash)) validCps++;
  }

  const all = (k: keyof Omit<ReceiptCheck, 'seq'>): CheckState => (checks.some((c) => c[k] === 'fail') ? 'fail' : 'pass');
  const failed = brokenAt !== undefined || validCps < checkpoints.length;
  const firstKid = sorted[0].kid;
  const fp = keys[firstKid] ? sha256Hex(keys[firstKid]).slice(0, 16) : undefined;
  return {
    result: failed ? 'failed' : 'verified',
    exitCode: failed ? 1 : 0,
    receipts: sorted.length,
    firstSeq: sorted[0].seq,
    lastSeq: sorted[sorted.length - 1].seq,
    brokenAt,
    brokenReason,
    checkpoints: { total: checkpoints.length, valid: validCps },
    keyFingerprint: fp,
    keySource: opts.keySource ?? 'bundle',
    checks,
    ms: Math.round(performance.now() - t0),
    summary: [
      { label: 'Signature', state: all('signature'), detail: 'Each receipt hash is signed with Ed25519 by the key it names.' },
      { label: 'Key valid when signed', state: all('key'), detail: retiredUse ? 'A receipt is signed by a key after the key.rotated receipt that retired it.' : 'Every key id resolves to a key in the bundle, and no key signs after the key.rotated receipt that retired it.' },
      { label: 'Content hash', state: all('hash'), detail: redacted ? `SHA-256 over canonical JSON matches the stored hash. ${redacted} receipt${redacted === 1 ? ' has' : 's have'} fields removed by erasure: their hash cannot be recomputed, so the organisation’s redaction signature over every remaining field is checked instead, with their original signatures and links.` : 'SHA-256 over canonical JSON matches the stored hash.' },
      { label: 'Previous-hash link', state: all('link'), detail: 'Sequence numbers have no gaps and each receipt names the hash before it.' },
      {
        label: 'Checkpoint inclusion',
        state: checkpoints.length === 0 ? 'skip' : validCps === checkpoints.length ? 'pass' : 'fail',
        detail: checkpoints.length ? `${validCps} of ${checkpoints.length} signed checkpoints match the chain head they name.` : 'No checkpoints in this file.',
      },
    ],
  };
}
