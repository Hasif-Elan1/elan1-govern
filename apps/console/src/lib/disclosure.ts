/**
 * Selective disclosure in the SD-JWT style (RFC 9901): every committed field is a salted digest,
 * SHA-256 over canonical([salt, name, value]). The issuer signs the sorted list of digests with its
 * Ed25519 key. A counterparty receives only the revealed fields with their salts, recomputes each
 * digest, checks it is in the signed list, and checks the issuer's signature with a key it pinned
 * out of band. Fields not revealed stay hidden but are still bound by the signature.
 */
import type { DisclosureField, DisclosurePackage, Receipt, RevealedField, VerifyStep } from '@/types';
import { canonical, sha256Hex, verifySig } from './crypto';

/** The 11 fields a receipt commits to in a disclosure package. */
export const DISCLOSABLE_FIELDS = ['seq', 'ts', 'agent', 'tool', 'decision', 'rule_id', 'reason', 'rulebook_version', 'approval', 'outcome', 'amount'] as const;
export type DisclosableField = (typeof DISCLOSABLE_FIELDS)[number];

export const FIELD_LABELS: Record<DisclosableField, string> = {
  seq: 'Sequence number', ts: 'Time', agent: 'Agent', tool: 'Tool', decision: 'Decision', rule_id: 'Rule', reason: 'Reason',
  rulebook_version: 'Rulebook version', approval: 'Approval (status and approver)', outcome: 'Outcome', amount: 'Amount',
};

/** The value of each committed field, as a string. */
export function fieldValuesOf(r: Receipt, approvalResult?: Receipt): Record<DisclosableField, string> {
  const ap = approvalResult?.approval ?? r.approval;
  const out = approvalResult?.outcome ?? r.outcome;
  return {
    seq: String(r.seq),
    ts: r.ts,
    agent: r.agent ?? r.actor ?? '',
    tool: r.tool ?? r.action ?? '',
    decision: approvalResult ? `${r.decision} → ${approvalResult.decision}` : r.decision ?? '',
    rule_id: r.rule_id ?? '',
    reason: r.reason ?? '',
    rulebook_version: r.rulebook ? `v${r.rulebook.version} · ${r.rulebook.hash.slice(0, 16)}` : '',
    approval: ap ? `${ap.status}${ap.approver ? ` by ${ap.approver}` : ''}${ap.channel ? ` via ${ap.channel}` : ''}` : 'none',
    outcome: out ? `${out.status}${out.ref ? ` · ${out.ref}` : ''}` : 'not reported',
    amount: r.args_summary?.amount !== undefined ? String(r.args_summary.amount) : '',
  };
}

export function disclosureDigest(salt: string, name: string, value: string) {
  return sha256Hex(canonical([salt, name, value]));
}

export function randomSalt(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The message the issuer signs. */
export function disclosureMessage(p: Pick<DisclosurePackage, 'orgId' | 'seq' | 'receiptHash' | 'audience' | 'expiresAt' | 'committed'>) {
  return sha256Hex(canonical({ iss: p.orgId, seq: p.seq, receipt_hash: p.receiptHash, aud: p.audience, exp: p.expiresAt, digests: p.committed.map((c) => c.digest).sort() }));
}

/** Commit every field with a fresh salt; return the digests and the salts (the issuer keeps the salts). */
export function commitFields(values: Record<string, string>): { committed: DisclosureField[]; salts: Record<string, string> } {
  const salts: Record<string, string> = {};
  const committed = Object.keys(values).sort().map((name) => {
    salts[name] = randomSalt();
    return { name, digest: disclosureDigest(salts[name], name, values[name]) };
  });
  return { committed, salts };
}

export interface DisclosureCheck {
  valid: boolean;
  steps: VerifyStep[];
  revealedCount: number;
  committedCount: number;
}

/**
 * Verify a disclosure package as a counterparty would: audience → expiry → pinned key →
 * issuer signature → each revealed field's digest is in the signed list.
 */
export function verifyDisclosure(p: DisclosurePackage, opts: { pinnedFingerprint?: string; audience?: string; now?: number } = {}): DisclosureCheck {
  const steps: VerifyStep[] = [];
  const now = opts.now ?? Date.now();
  steps.push({ label: 'Audience', state: !opts.audience || opts.audience === p.audience ? 'pass' : 'fail', detail: `Issued to ${p.audience}.` });
  const expired = new Date(p.expiresAt).getTime() < now;
  steps.push({ label: 'Expiry', state: expired ? 'fail' : 'pass', detail: expired ? `Expired ${p.expiresAt}.` : `Valid until ${p.expiresAt}.` });
  const fp = sha256Hex(p.publicKey).slice(0, 16);
  steps.push({ label: 'Issuer key', state: opts.pinnedFingerprint ? (opts.pinnedFingerprint === fp ? 'pass' : 'fail') : 'skip', detail: opts.pinnedFingerprint ? `Fingerprint ${fp} ${opts.pinnedFingerprint === fp ? 'matches' : 'does not match'} the pinned ${opts.pinnedFingerprint}.` : `Key fingerprint ${fp}. Compare it with one you obtained from the issuer directly.` });
  const sigOk = verifySig(disclosureMessage(p), p.sig, p.publicKey);
  steps.push({ label: 'Issuer signature', state: sigOk ? 'pass' : 'fail', detail: sigOk ? `Ed25519 signature over ${p.committed.length} committed digests verifies.` : 'The signature does not verify — the package was changed or signed by another key.' });
  const set = new Set(p.committed.map((c) => c.digest));
  const bad = p.revealed.filter((f: RevealedField) => !set.has(disclosureDigest(f.salt, f.name, f.value)));
  steps.push({ label: 'Revealed fields', state: bad.length ? 'fail' : 'pass', detail: bad.length ? `${bad.length} revealed field${bad.length === 1 ? '' : 's'} (${bad.map((b) => b.name).join(', ')}) do not match a committed digest.` : `You are revealing ${p.revealed.length} of ${p.committed.length} committed fields; each recomputes to a signed digest.` });
  const valid = steps.every((s) => s.state !== 'fail');
  return { valid, steps, revealedCount: p.revealed.length, committedCount: p.committed.length };
}

/* ── Saved disclosure profiles ───────────────────────────────── */

export type DisclosurePurpose = 'auditor' | 'lender' | 'insurer' | 'regulator' | 'customer' | 'other';

export const PURPOSE_LABEL: Record<DisclosurePurpose, string> = {
  auditor: 'Auditor', lender: 'Lender', insurer: 'Insurer', regulator: 'Regulator', customer: 'Customer', other: 'Other',
};

/** A named set of fields and an expiry, saved by an owner or admin and reused for packages and bundles. */
export interface DisclosureProfile {
  id: string;
  name: string;
  purpose: DisclosurePurpose;
  description: string;
  fields: string[];
  expiresDays: number;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
  /** the receipt that recorded the latest save */
  seq?: number;
  /** how many packages and bundles used it */
  used?: number;
}

/* ── Selective-disclosure bundle over a range (one file) ─────── */

export const BUNDLE_FORMAT = 'elan1.disclosure.bundle.v1' as const;
export const BUNDLE_MAX = 200;

export interface BundleItem { seq: number; receiptHash: string; committed: DisclosureField[]; revealed: RevealedField[] }

/**
 * One file over a range of receipts: every receipt's 11 fields committed as salted digests, the same fields revealed
 * for each, and one Ed25519 signature over the manifest (issuer, audience, expiry, range, fields and every receipt's
 * hash with its sorted digests).
 */
export interface DisclosureBundle {
  id: string;
  orgId: string;
  issuerName: string;
  format: typeof BUNDLE_FORMAT;
  range: { fromSeq: number; toSeq: number; count: number; kinds: 'decisions' | 'all' };
  createdAt: string;
  createdBy: string;
  audience: string;
  counterpartyId?: string;
  profileId?: string;
  profileName?: string;
  fields: string[];
  expiresAt: string;
  token: string;
  items: BundleItem[];
  kid: string;
  publicKey: string;
  sig: string;
  status: 'active' | 'revoked' | 'expired';
  views: number;
  lastViewedAt?: string;
  downloads?: number;
  seqCreated?: number;
  revokedAt?: string;
  revokedBy?: string;
}

/** The canonical manifest the issuer signs for a bundle. */
export function bundleManifest(b: Pick<DisclosureBundle, 'format' | 'orgId' | 'audience' | 'expiresAt' | 'range' | 'fields' | 'items'>) {
  return canonical({
    format: b.format, iss: b.orgId, aud: b.audience, exp: b.expiresAt,
    range: { from: b.range.fromSeq, to: b.range.toSeq, count: b.range.count, kinds: b.range.kinds },
    fields: [...b.fields].sort(),
    items: b.items.map((i) => [i.seq, i.receiptHash, i.committed.map((c) => c.digest).sort()]),
  });
}

export const bundleMessage = (b: Parameters<typeof bundleManifest>[0]) => sha256Hex(bundleManifest(b));

export interface BundleCheck extends DisclosureCheck { items: { seq: number; ok: boolean; bad: string[] }[] }

/** Verify a bundle as its recipient would: audience → expiry → pinned key → signature over the manifest → every revealed field. */
export function verifyDisclosureBundle(b: DisclosureBundle, opts: { pinnedFingerprint?: string; audience?: string; now?: number } = {}): BundleCheck {
  const steps: VerifyStep[] = [];
  const now = opts.now ?? Date.now();
  steps.push({ label: 'Audience', state: !opts.audience || opts.audience === b.audience ? 'pass' : 'fail', detail: `Issued to ${b.audience}.` });
  const expired = new Date(b.expiresAt).getTime() < now;
  steps.push({ label: 'Expiry', state: expired ? 'fail' : 'pass', detail: expired ? `Expired ${b.expiresAt}.` : `Valid until ${b.expiresAt}.` });
  const fp = sha256Hex(b.publicKey).slice(0, 16);
  steps.push({ label: 'Issuer key', state: opts.pinnedFingerprint ? (opts.pinnedFingerprint === fp ? 'pass' : 'fail') : 'skip', detail: opts.pinnedFingerprint ? `Fingerprint ${fp} ${opts.pinnedFingerprint === fp ? 'matches' : 'does not match'} the pinned ${opts.pinnedFingerprint}.` : `Key fingerprint ${fp}. Compare it with one you obtained from the issuer directly.` });
  const countOk = b.items.length === b.range.count;
  const sigOk = countOk && verifySig(bundleMessage(b), b.sig, b.publicKey);
  steps.push({ label: 'Issuer signature', state: sigOk ? 'pass' : 'fail', detail: sigOk ? `Ed25519 signature over the manifest of ${b.items.length} receipts verifies.` : !countOk ? `The manifest names ${b.range.count} receipts but the file holds ${b.items.length}.` : 'The signature does not verify — the file was changed or signed by another key.' });
  const items = b.items.map((it) => {
    const set = new Set(it.committed.map((c) => c.digest));
    const bad = it.revealed.filter((f) => !set.has(disclosureDigest(f.salt, f.name, f.value))).map((f) => f.name);
    return { seq: it.seq, ok: bad.length === 0, bad };
  });
  const badItems = items.filter((i) => !i.ok);
  const revealed = b.items.reduce((s, i) => s + i.revealed.length, 0);
  steps.push({ label: 'Revealed fields', state: badItems.length ? 'fail' : 'pass', detail: badItems.length ? `${badItems.length} receipt${badItems.length === 1 ? '' : 's'} (${badItems.slice(0, 4).map((i) => `#${i.seq}`).join(', ')}${badItems.length > 4 ? ' …' : ''}) carry a revealed field that does not match a committed digest.` : `${revealed} revealed values across ${b.items.length} receipts; each recomputes to a signed digest.` });
  const valid = steps.every((s) => s.state !== 'fail');
  return { valid, steps, revealedCount: revealed, committedCount: b.items.reduce((s, i) => s + i.committed.length, 0), items };
}

/* ── The bundle as one file (elan1.disclosure.bundle.v1) ──────── */

/** The manifest object written into the file: exactly what is signed (SHA-256 over its canonical JSON). */
export function bundleManifestObject(b: Parameters<typeof bundleManifest>[0]) {
  return JSON.parse(bundleManifest(b)) as { format: string; iss: string; aud: string; exp: string; range: { from: number; to: number; count: number; kinds: string }; fields: string[]; items: [number, string, string[]][] };
}

const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Read a bundle file back into a bundle, from the file's own fields only (no call to the issuer): the issuer id
 * (issuer.org_id, the manifest's iss), audience, expiry, range, revealed fields, each receipt's committed digests and
 * disclosures, and the signature. Returns undefined when the value is not this format.
 */
export function bundleFromFile(v: unknown): DisclosureBundle | undefined {
  if (!isRec(v) || v.format !== BUNDLE_FORMAT || !Array.isArray(v.items)) return undefined;
  const issuer = isRec(v.issuer) ? v.issuer : {};
  const range = isRec(v.range) ? v.range : {};
  const sig = isRec(v.signature) ? v.signature : {};
  const manifest = isRec(v.manifest) ? v.manifest : {};
  const items: BundleItem[] = (v.items as unknown[]).filter(isRec).map((it) => ({
    seq: Number(it.seq),
    receiptHash: String(it.receipt_hash ?? ''),
    committed: Array.isArray(it.committed) ? (it.committed as DisclosureField[]).map((c) => ({ name: String(c.name), digest: String(c.digest) })) : [],
    revealed: Array.isArray(it.disclosures) ? (it.disclosures as unknown[]).filter(Array.isArray).map((d) => { const [salt, name, value] = d as unknown[]; return { name: String(name), salt: String(salt), value: String(value) }; }) : [],
  }));
  const orgId = String(issuer.org_id ?? manifest.iss ?? issuer.id ?? '');
  return {
    id: String(v.bundle_id ?? 'file'), orgId, issuerName: String(issuer.name ?? orgId), format: BUNDLE_FORMAT,
    range: { fromSeq: Number(range.from_seq), toSeq: Number(range.to_seq), count: Number(range.count ?? items.length), kinds: range.kinds === 'all' ? 'all' : 'decisions' },
    createdAt: String(v.created_at ?? ''), createdBy: '', audience: String(v.audience ?? ''), fields: Array.isArray(v.revealed_fields) ? (v.revealed_fields as unknown[]).map(String) : [],
    expiresAt: String(v.expires_at ?? ''), token: '', items, kid: String(sig.key_id ?? ''), publicKey: String(sig.public_key ?? ''), sig: String(sig.sig ?? ''),
    status: 'active', views: 0, profileName: typeof v.profile === 'string' ? v.profile : undefined,
  };
}

/**
 * Check a bundle file as its recipient would, from the file alone: the manifest written in the file is the one rebuilt
 * from its fields, the digest it states is SHA-256 of that manifest, then audience, expiry, key, signature and every
 * revealed value (verifyDisclosureBundle).
 */
export function verifyBundleFile(v: unknown, opts: { pinnedFingerprint?: string; audience?: string; now?: number } = {}): (BundleCheck & { bundle: DisclosureBundle }) | undefined {
  const b = bundleFromFile(v);
  if (!b) return undefined;
  const check = verifyDisclosureBundle(b, opts);
  const file = v as Record<string, unknown>;
  const rebuilt = bundleManifest(b);
  const stated = isRec(file.manifest) ? canonical(file.manifest) : undefined;
  const statedDigest = isRec(file.signature) ? file.signature.manifest_digest : undefined;
  const same = stated === undefined ? undefined : stated === rebuilt;
  const digestOk = statedDigest === undefined ? undefined : statedDigest === sha256Hex(rebuilt);
  const ok = same !== false && digestOk !== false;
  const step: VerifyStep = {
    label: 'Manifest', state: same === undefined && digestOk === undefined ? 'skip' : ok ? 'pass' : 'fail',
    detail: same === undefined && digestOk === undefined
      ? 'The file states no manifest; it was rebuilt from the file’s fields and checked by the signature below.'
      : ok ? `Rebuilt from the file’s own fields (iss ${b.orgId}, receipts #${b.range.fromSeq}–#${b.range.toSeq}); it matches the manifest and digest the file states.`
        : same === false ? 'The manifest the file states differs from the one its fields rebuild: the file was changed.' : 'The manifest digest the file states is not SHA-256 of its manifest.',
  };
  const steps = [check.steps[0], check.steps[1], check.steps[2], step, ...check.steps.slice(3)];
  return { ...check, steps, valid: steps.every((s) => s.state !== 'fail'), bundle: b };
}
