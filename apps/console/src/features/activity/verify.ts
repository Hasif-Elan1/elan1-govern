/**
 * In-browser verification helpers built on lib/crypto, lib/seal and lib/merkle: one receipt, or a whole chain
 * in chunks with progress. Three-valued throughout (verified · failed · cannot verify); a check line can also
 * be a warning (it holds, with a caveat). Nothing is sent anywhere.
 *
 * L1 checks: signature, key valid when signed, content hash, previous-hash link, checkpoint inclusion.
 * L2 and above add: Seal v6 (16 frozen fields, length-prefixed preimage, salted payload hash, signature),
 * an RFC 3161 token from each of two authorities, both within 15 minutes, and the RFC 6962 inclusion proof.
 * Receipts written before the organisation reached L2 skip the L2 lines and say why.
 */
import { canonical, contentOk, sha256Hex, verifySig, type CheckState } from '@/lib/crypto';
import { verifySeal, digestOfFields } from '@/lib/seal';
import { rootFromPath, verifyInclusion } from '@/lib/merkle';
import { tokenMessage } from '@/lib/verify6';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import type { Checkpoint, InclusionProof, LevelId, LevelPeriod, Receipt, SealRecord, SigningKey, TsaAuthority } from '@/types';
import { date, n, seqLabel } from '@/lib/format';
import { levelOfReceipt, segmentsByLevel, type LevelSegment } from './assurance';

export type Verdict = 'verified' | 'failed' | 'cannot_verify';
export type LineState = CheckState | 'warn';
export interface CheckLine { label: string; state: LineState; detail: string; level?: 'l1' | 'l2' }

export const fingerprintOf = (publicKeyHex?: string) => (publicKeyHex ? sha256Hex(publicKeyHex).slice(0, 16) : undefined);

/**
 * The words for the Ed25519 check on a receipt or checkpoint. L1 copy says "sealed in a hash chain", never
 * "signed", until DR-017 is decided; L2 and above keep "signed".
 */
export function sealWords(signedLevel: boolean) {
  return signedLevel
    ? { signed: 'signed', signature: 'signature', Signature: 'Signature' }
    : { signed: 'sealed', signature: 'seal', Signature: 'Seal (Ed25519)' };
}

/** A key may not sign after it was retired (one minute of tolerance for the rotation receipt itself). */
export function keyWindow(r: Receipt, signingKeys?: SigningKey[]): CheckState {
  if (!signingKeys) return 'skip';
  const k = signingKeys.find((x) => x.kid === r.kid);
  if (!k) return 'fail';
  if (!k.retiredAt) return 'pass';
  return new Date(r.ts).getTime() <= new Date(k.retiredAt).getTime() + 60_000 ? 'pass' : 'fail';
}

export function checkpointValid(cp: Checkpoint, publicKeys: Record<string, string>) {
  const pub = publicKeys[cp.kid];
  if (!pub) return false;
  return verifySig(canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid }), cp.sig, pub);
}

/** What the receipt page and the auditor sample know about a receipt's L2 evidence. */
export interface L2Context {
  /** Level in force when the receipt was written. */
  level: LevelId;
  /** When the organisation reached L2 (undefined: it has not). */
  l2Since?: string;
  /** Seal v6 record, when the receipt is sealed. */
  seal?: SealRecord;
  /** Inclusion proof, when the receipt's batch has been timestamped. */
  proof?: InclusionProof;
  /** Why there is no proof (for example the unanchored tail). */
  proofError?: string;
  /** The two timestamp authorities (their public keys check the tokens). */
  authorities?: TsaAuthority[];
}

export interface ReceiptVerification {
  verdict: Verdict;
  checks: CheckLine[];
  fingerprint?: string;
  ms: number;
}

const TARGET_SECONDS = 15 * 60;

/** The L2 lines for one receipt: seal, one line per timestamp authority, the 15-minute target, the inclusion proof. */
export function l2Lines(r: Receipt, ctx: L2Context, publicKeys: Record<string, string>): CheckLine[] {
  const auth = ctx.authorities ?? [];
  const tsaLabel = (i: number) => `Timestamp — ${auth[i]?.name ?? (i === 0 ? 'first authority' : 'second authority')}`;
  if (levelRank(ctx.level) < 1) {
    const why = ctx.l2Since
      ? `Written before the L2 boundary (${date(ctx.l2Since)}). It keeps L1 rules: sealed in a hash chain by Elan1 Govern, with no Seal v6 record and no timestamp.`
      : 'This organisation is on L1 Guarded. Sealing and timestamps from two authorities start at L2 Attested.';
    return [
      { label: 'Sealed record (Seal v6)', state: 'skip', detail: why, level: 'l2' },
      { label: tsaLabel(0), state: 'skip', detail: why, level: 'l2' },
      { label: tsaLabel(1), state: 'skip', detail: why, level: 'l2' },
      { label: 'Timestamps within 15 minutes', state: 'skip', detail: why, level: 'l2' },
      { label: 'Merkle inclusion proof', state: 'skip', detail: why, level: 'l2' },
    ];
  }
  const lines: CheckLine[] = [];
  // Seal v6
  const s = ctx.seal;
  if (!s) {
    lines.push({ label: 'Sealed record (Seal v6)', state: 'skip', detail: `Written at ${LEVEL_INFO[ctx.level].label}, but the seal is not available here, so it was not checked.`, level: 'l2' });
  } else {
    const c = verifySeal(s, publicKeys[s.kid], r);
    const ok = c.structure && c.digest && c.signature && c.binding;
    const recomputed = c.structure ? digestOfFields(s.fields) : '';
    lines.push({
      label: 'Sealed record (Seal v6)', state: ok ? 'pass' : 'fail', level: 'l2',
      detail: ok
        ? `16 frozen fields; SHA-256 over the ${n(s.preimageBytes)}-byte length-prefixed preimage recomputes to ${s.digest.slice(0, 12)}…; the Ed25519 seal signature verifies against ${s.kid}; F04 binds this receipt’s hash.${s.payloadUnbound ? ' The payload salt was destroyed by an erasure request, so F14 no longer links to the payload. The seal still verifies.' : ''}`
        : !c.structure ? 'The seal does not carry 16 fields F01–F16 in order.'
        : !c.digest ? `The fields recompute to ${recomputed.slice(0, 12)}…, not the signed digest ${s.digest.slice(0, 12)}…: a sealed field was changed.`
        : !c.signature ? `The seal signature does not verify against ${s.kid}.`
        : 'F04 write_id does not bind this receipt’s hash: the seal belongs to another record.',
    });
  }
  // Timestamps and inclusion
  const p = ctx.proof;
  if (!p) {
    const why = ctx.proofError ?? 'Not yet in a timestamped batch.';
    lines.push(
      { label: tsaLabel(0), state: 'skip', detail: why, level: 'l2' },
      { label: tsaLabel(1), state: 'skip', detail: why, level: 'l2' },
      { label: 'Timestamps within 15 minutes', state: 'skip', detail: why, level: 'l2' },
      { label: 'Merkle inclusion proof', state: 'skip', detail: why, level: 'l2' },
    );
    return lines;
  }
  const byId = new Map(auth.map((a) => [a.id, a]));
  // The pair that stamped this batch: an organisation that moved to its own TSAs at Sovereign keeps older batches stamped by the hosted pair.
  const matched = auth.filter((a) => p.tokens.some((t) => t.tsaId === a.id));
  const pair = matched.length >= 2 ? matched : auth.slice(0, 2);
  const ordered = pair.length ? pair.map((a) => p.tokens.find((t) => t.tsaId === a.id)) : p.tokens;
  ordered.slice(0, 2).forEach((t, i) => {
    if (!t) { lines.push({ label: `Timestamp — ${pair[i]?.name ?? (i === 0 ? 'first authority' : 'second authority')}`, state: 'fail', detail: `Batch ${p.batchId} carries no token from ${pair[i]?.name ?? 'this authority'}.`, level: 'l2' }); return; }
    const a = byId.get(t.tsaId);
    const sigOk = !!a && verifySig(tokenMessage(t), t.sig, a.publicKey);
    const imprintOk = t.imprint === p.root;
    lines.push({
      label: `Timestamp — ${t.tsaName}`, state: sigOk && imprintOk ? 'pass' : 'fail', level: 'l2',
      detail: sigOk && imprintOk
        ? `RFC 3161 token ${t.serial.slice(0, 10)}… (policy ${t.policyOid}) stamps the batch root at ${new Date(t.genTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, day: 'numeric', month: 'short' })} IST; the authority’s signature verifies.`
        : !a ? `Token from ${t.tsaName}, an authority not in the published list.` : !imprintOk ? 'The token stamps a different root from this batch.' : 'The authority’s signature on the token does not verify.',
    });
  });
  const worst = Math.max(0, ...p.tokens.map((t) => t.delaySeconds));
  lines.push({
    label: 'Timestamps within 15 minutes', state: worst <= TARGET_SECONDS ? 'pass' : 'warn', level: 'l2',
    detail: worst <= TARGET_SECONDS
      ? `Both tokens were granted within ${Math.max(1, Math.ceil(worst / 60))} min of the batch closing (target 15 min).`
      : `One token was granted ${Math.round(worst / 60)} min after the batch closed, outside the 15-minute target (an authority was unreachable). The timestamp is valid; it is late, and that is recorded.`,
  });
  const incOk = verifyInclusion(r.hash, p.path, p.root);
  lines.push({
    label: 'Merkle inclusion proof', state: incOk ? 'pass' : 'fail', level: 'l2',
    detail: incOk
      ? `Leaf ${p.leafIndex + 1} of ${p.treeSize} in batch ${p.batchId}: ${p.path.length} sibling hash${p.path.length === 1 ? ' recomputes' : 'es recompute'} to the root ${p.root.slice(0, 12)}… (RFC 6962).`
      : `The path recomputes to ${rootFromPath(r.hash, p.path).slice(0, 12)}…, not the batch root ${p.root.slice(0, 12)}….`,
  });
  return lines;
}

/**
 * Verify one receipt: content hash, signature, key validity, link to the receipt before it,
 * and inclusion under a signed checkpoint (walking the links from this receipt to the checkpoint).
 * With an L2 context it adds the seal, both timestamps, the 15-minute target and the inclusion proof.
 */
export function verifyReceipt(r: Receipt, ctx: { publicKeys: Record<string, string>; prev?: Receipt; signingKeys?: SigningKey[]; checkpoint?: Checkpoint; between?: Receipt[]; l2?: L2Context }): ReceiptVerification {
  const t0 = performance.now();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided. L2 and above keep "signed".
  const w = sealWords(!!ctx.l2 && levelRank(ctx.l2.level) >= 1);
  const pub = ctx.publicKeys[r.kid];
  const hashOk = contentOk(r, ctx.publicKeys);
  const sig: CheckState = pub ? (verifySig(r.hash, r.sig, pub) ? 'pass' : 'fail') : 'skip';
  const key: CheckState = !pub ? 'skip' : keyWindow(r, ctx.signingKeys);
  const link: CheckState = !ctx.prev ? 'skip' : ctx.prev.seq + 1 === r.seq && ctx.prev.hash === r.prev_hash ? 'pass' : 'fail';
  let cpState: CheckState = 'skip';
  let cpDetail = `Not yet covered by a ${w.signed} checkpoint. The newest receipts wait for the next hourly checkpoint.`;
  if (ctx.checkpoint) {
    const cp = ctx.checkpoint;
    const sigOk = checkpointValid(cp, ctx.publicKeys);
    let h = r.hash;
    let walkOk = true;
    for (const x of ctx.between ?? []) {
      if (x.prev_hash !== h) { walkOk = false; break; }
      h = x.hash;
    }
    const reaches = walkOk && h === cp.hash;
    cpState = sigOk && reaches ? 'pass' : 'fail';
    cpDetail = cpState === 'pass'
      ? `Checkpoint at ${seqLabel(cp.seq)} is ${w.signed} by ${cp.kid}, and the links from this receipt reach the hash it names.`
      : !sigOk ? `The checkpoint at ${seqLabel(cp.seq)} does not verify against key ${cp.kid}.` : `The links from this receipt do not reach the hash the checkpoint at ${seqLabel(cp.seq)} names.`;
  }
  const checks: CheckLine[] = [
    { label: w.Signature, state: sig, level: 'l1', detail: pub ? (sig === 'pass' ? `Ed25519 ${w.signature} over the hash verifies against key ${r.kid}.` : `The ${w.signature} does not verify against key ${r.kid}.`) : `Key ${r.kid} is not in the key set, so the ${w.signature} cannot be checked.` },
    { label: `Key valid when ${w.signed}`, state: key, level: 'l1', detail: key === 'pass' ? `${r.kid} had not been retired when this receipt was ${w.signed}.` : key === 'fail' ? `${r.kid} was retired before this receipt was ${w.signed}.` : 'Key history not available here.' },
    { label: 'Content hash', state: hashOk ? 'pass' : 'fail', level: 'l1', detail: r.redacted
      ? (hashOk ? `An erasure removed ${r.redacted.fields.join(', ')}, so the hash cannot be recomputed. The organisation’s redaction ${w.signature} (${r.redacted.kid}) over every remaining field and the original hash verifies.` : `The erased receipt does not match its redaction ${w.signature}: a field was changed after the erasure.`)
      : hashOk ? 'SHA-256 over canonical JSON (sorted keys, no hash or sig) matches the stored hash.' : `The content does not match its hash: the receipt was changed after it was ${w.signed}.` },
    { label: 'Previous-hash link', state: link, level: 'l1', detail: link === 'pass' ? `prev_hash equals the hash of ${seqLabel(r.seq - 1)}.` : link === 'fail' ? `prev_hash does not equal the hash of ${seqLabel(r.seq - 1)}, or the sequence has a gap.` : 'The receipt before this one is outside the window loaded here.' },
    { label: 'Checkpoint inclusion', state: cpState, level: 'l1', detail: cpDetail },
    ...(ctx.l2 ? l2Lines(r, ctx.l2, ctx.publicKeys) : []),
  ];
  const failed = checks.some((c) => c.state === 'fail');
  return { verdict: failed ? 'failed' : sig === 'skip' ? 'cannot_verify' : 'verified', checks, fingerprint: pub ? fingerprintOf(pub) : undefined, ms: Math.round(performance.now() - t0) };
}

export interface ChainVerification {
  verdict: Verdict;
  receipts: number;
  firstSeq?: number;
  lastSeq?: number;
  brokenAt?: number;
  brokenReason?: string;
  checkpoints: { total: number; valid: number };
  missingKeys: string[];
  summary: CheckLine[];
  /** The chain split at the level boundaries (one segment when the organisation never changed level). */
  segments: LevelSegment[];
  ms: number;
}

/** Whole-chain check in chunks so the page can show progress and stay responsive. */
export async function verifyChainProgressive(
  receipts: Receipt[], publicKeys: Record<string, string>, checkpoints: Checkpoint[], signingKeys: SigningKey[] | undefined,
  onProgress: (fraction: number, seq?: number) => void, signal?: { cancelled: boolean },
  levels?: { history?: LevelPeriod[]; current: LevelId },
): Promise<ChainVerification> {
  const t0 = performance.now();
  const sorted = [...receipts].sort((a, b) => a.seq - b.seq);
  const segments = segmentsByLevel(sorted, levels?.history, levels?.current ?? 'l1');
  // "signed" only when every receipt in the window was written at L2 or above (L1 records are sealed, not signed).
  const w = sealWords(segments.length > 0 && segments.every((s) => levelRank(s.level) >= 1));
  const tick = () => new Promise((res) => window.setTimeout(res, 0));
  const fails = { signature: 0, key: 0, hash: 0, link: 0 };
  const missing = new Set<string>();
  let brokenAt: number | undefined;
  let brokenReason: string | undefined;
  const CHUNK = 120;
  for (let i = 0; i < sorted.length; i++) {
    if (signal?.cancelled) throw new Error('cancelled');
    const r = sorted[i];
    const prev = sorted[i - 1];
    const pub = publicKeys[r.kid];
    const hashOk = contentOk(r, publicKeys);
    const sigOk = pub ? verifySig(r.hash, r.sig, pub) : undefined;
    const keyOk = pub ? keyWindow(r, signingKeys) !== 'fail' : false;
    const linkOk = !prev || (prev.seq + 1 === r.seq && prev.hash === r.prev_hash);
    if (!pub) missing.add(r.kid);
    if (!hashOk) fails.hash++;
    if (sigOk === false) fails.signature++;
    if (!keyOk) fails.key++;
    if (!linkOk) fails.link++;
    if (brokenAt === undefined && (!hashOk || sigOk === false || !linkOk || (pub && !keyOk))) {
      brokenAt = r.seq;
      brokenReason = !hashOk ? `The content does not match its hash — the receipt was changed after it was ${w.signed}.`
        : !linkOk ? 'The previous-hash link or sequence is broken — a receipt was removed, reordered or replaced.'
        : sigOk === false ? `The ${w.signature} does not verify against the named key.`
        : `The receipt was ${w.signed} with a key after that key was retired.`;
    }
    if (i % CHUNK === 0) { onProgress((i / Math.max(1, sorted.length)) * 0.92, r.seq); await tick(); }
  }
  const bySeq = new Map(sorted.map((r) => [r.seq, r.hash]));
  let valid = 0;
  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    const h = bySeq.get(cp.seq);
    if (checkpointValid(cp, publicKeys) && (h === undefined || h === cp.hash)) valid++;
    if (i % 60 === 0) { onProgress(0.92 + (i / Math.max(1, checkpoints.length)) * 0.08); await tick(); }
  }
  onProgress(1);
  const st = (k: keyof typeof fails): CheckState => (fails[k] > 0 ? 'fail' : 'pass');
  const failed = brokenAt !== undefined || valid < checkpoints.length;
  const verdict: Verdict = !sorted.length ? 'cannot_verify' : failed ? 'failed' : missing.size ? 'cannot_verify' : 'verified';
  return {
    verdict, receipts: sorted.length, firstSeq: sorted[0]?.seq, lastSeq: sorted[sorted.length - 1]?.seq, brokenAt, brokenReason,
    checkpoints: { total: checkpoints.length, valid }, missingKeys: [...missing], ms: Math.round(performance.now() - t0), segments,
    summary: [
      { label: w.Signature, state: missing.size && !fails.signature ? 'skip' : st('signature'), detail: fails.signature ? `${n(fails.signature)} receipts carry a ${w.signature} that does not verify.` : `Each receipt hash is ${w.signed} with Ed25519 by the key it names.` },
      { label: `Key valid when ${w.signed}`, state: st('key'), detail: fails.key ? `${n(fails.key)} receipts name a missing key or one used after it was retired.` : `Every key id resolves to a published key that had not been retired when it ${w.signed} them.` },
      { label: 'Content hash', state: st('hash'), detail: fails.hash ? `${n(fails.hash)} receipts no longer match their hash.` : 'SHA-256 over canonical JSON matches the stored hash for every receipt.' },
      { label: 'Previous-hash link', state: st('link'), detail: fails.link ? `${n(fails.link)} broken links or sequence gaps.` : 'Sequence numbers have no gaps and each receipt names the hash before it.' },
      { label: 'Checkpoint inclusion', state: checkpoints.length === 0 ? 'skip' : valid === checkpoints.length ? 'pass' : 'fail', detail: checkpoints.length ? `${n(valid)} of ${n(checkpoints.length)} ${w.signed} checkpoints verify and match the chain head they name.` : 'No checkpoints to check.' },
    ],
  };
}

/** The level a receipt was written at, for screens that only hold the receipt and the history. */
export { levelOfReceipt };
