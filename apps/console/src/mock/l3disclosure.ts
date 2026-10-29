/**
 * Selective disclosure extras (L3): saved disclosure profiles, and one signed bundle over a range of receipts.
 *
 * A bundle commits every one of the 11 fields of each receipt in the range as a salted digest, reveals the same
 * chosen fields for each, and carries one Ed25519 signature over the manifest. The salts come from a per-bundle
 * secret kept with the organisation (never returned), so the stored bundle holds only the receipt numbers and the
 * digests are rebuilt on read; the signature proves they are the ones signed.
 */
import type { Receipt } from '@/types';
import { getDB, append, touch, type OrgDB } from './db';
import { ORGS, personFor } from './users';
import { LEVEL_INFO, levelOfOrg } from '@/lib/levels';
import { sha256Hex, signText } from '@/lib/crypto';
import {
  BUNDLE_FORMAT, BUNDLE_MAX, DISCLOSABLE_FIELDS, bundleManifestObject, bundleMessage, disclosureDigest, fieldValuesOf, verifyDisclosureBundle,
  type BundleItem, type DisclosureBundle, type DisclosureProfile, type DisclosurePurpose,
} from '@/lib/disclosure';
import { D, H, clone, iso, isL3, l3ext, randHex, requireL3, requireRoles, type StoredBundle } from './l3state';

const LIMITS = 'This establishes that the issuer’s governed write path produced these records under these rules at these times. It does not establish that the underlying transactions occurred.';
const OWNER_ADMIN = ['owner', 'admin'];

/* ── Seeds ─────────────────────────────────────────────────── */

const SEED_PROFILES: Record<string, { name: string; purpose: DisclosurePurpose; description: string; fields: string[]; expiresDays: number }[]> = {
  org_kaveri: [
    { name: 'Statutory auditor', purpose: 'auditor', description: 'Year-end audit: what was decided, under which rule and rulebook, and who approved it. No amounts or agents.', fields: ['seq', 'ts', 'decision', 'rule_id', 'rulebook_version', 'approval'], expiresDays: 90 },
    { name: 'Insurer — claims audit', purpose: 'insurer', description: 'Star Health claims audit desk: the decision, the approval and the amount of each claim review.', fields: ['ts', 'tool', 'decision', 'approval', 'amount'], expiresDays: 30 },
    { name: 'Lender — working capital', purpose: 'lender', description: 'Deccan Cooperative Bank: payments made and approved, with amounts, for the working-capital line.', fields: ['ts', 'tool', 'decision', 'approval', 'amount', 'outcome'], expiresDays: 30 },
  ],
  org_deccan: [
    { name: 'RBI off-site supervision', purpose: 'regulator', description: 'Department of Supervision: every field except the agent, so the decision path can be followed end to end.', fields: ['seq', 'ts', 'tool', 'decision', 'rule_id', 'reason', 'rulebook_version', 'approval', 'outcome', 'amount'], expiresDays: 90 },
    { name: 'Concurrent auditor', purpose: 'auditor', description: 'Monthly concurrent audit: decisions, rules and named approvers.', fields: ['seq', 'ts', 'decision', 'rule_id', 'rulebook_version', 'approval'], expiresDays: 30 },
    { name: 'NABARD refinance', purpose: 'lender', description: 'Refinance desk: approved held actions with amounts and outcomes.', fields: ['ts', 'tool', 'approval', 'amount', 'outcome'], expiresDays: 14 },
  ],
};

function ensureSeed(db: OrgDB) {
  const x = l3ext(db);
  const seeded = (x.seeded ??= {});
  if (seeded.disclosure || !isL3(db)) return;
  seeded.disclosure = true;
  const now = Date.now();
  const owner = personFor(db.org.id, 'u_ananya');
  const admin = personFor(db.org.id, 'u_rahul');
  x.profiles ??= [];
  (SEED_PROFILES[db.org.id] ?? []).forEach((p, i) => {
    if (x.profiles!.some((q) => q.name === p.name)) return;
    x.profiles!.push({ id: `dpf_${db.org.id.replace('org_', '')}_${i}`, ...p, fields: [...p.fields], createdAt: iso(now - (40 - i * 9) * D), createdBy: i % 2 ? admin : owner, used: 0 });
  });
  // one bundle already shared: Kaveri to its insurer over recent decisions, Deccan to the RBI over recent decisions
  const target = db.org.id === 'org_kaveri' ? { cp: 'cp_star', profile: 1 } : db.org.id === 'org_deccan' ? { cp: 'cp_rbi', profile: 0 } : undefined;
  const cp = target && db.platform.counterparties.find((c) => c.id === target.cp);
  const profile = target && x.profiles[target.profile];
  if (cp && profile) {
    const decisions = db.receipts.filter((r) => r.kind === 'decision' && !r.redacted && new Date(r.ts).getTime() < now - 2 * D);
    const last = decisions.slice(-24);
    if (last.length) {
      const b = buildBundle(db, { seqs: last.map((r) => r.seq), fromSeq: last[0].seq, toSeq: last[last.length - 1].seq, kinds: 'decisions', fields: profile.fields, audience: `ar-org:${cp.domain}`, counterpartyId: cp.id, profile, expiresDays: profile.expiresDays, userId: owner, createdAt: now - 2 * D + 3 * H });
      b.views = 3;
      b.lastViewedAt = iso(now - 20 * H);
      b.downloads = 1;
      profile.used = (profile.used ?? 0) + 1;
    }
  }
}

/* ── Profiles ──────────────────────────────────────────────── */

export function profilesView(orgId: string): DisclosureProfile[] {
  const db = getDB(orgId);
  ensureSeed(db);
  return clone(l3ext(db).profiles ?? []);
}

export function saveProfile(orgId: string, input: { id?: string; name: string; purpose: DisclosurePurpose; description: string; fields: string[]; expiresDays: number }, userId: string): DisclosureProfile {
  const db = getDB(orgId);
  requireL3(db, 'Saved disclosure profiles');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Saving a disclosure profile');
  ensureSeed(db);
  const x = l3ext(db);
  const list = (x.profiles ??= []);
  const name = input.name.trim();
  if (name.length < 3) throw new Error('Give the profile a name of at least 3 characters, such as “Statutory auditor”.');
  if (list.some((p) => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`A profile called “${name}” already exists.`);
  const fields = DISCLOSABLE_FIELDS.filter((f) => input.fields.includes(f));
  if (!fields.length) throw new Error('A profile reveals at least one field.');
  const days = Math.floor(input.expiresDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error('Expiry is between 1 and 365 days.');
  const existing = input.id ? list.find((p) => p.id === input.id) : undefined;
  if (input.id && !existing) throw new Error('No such profile.');
  const r = append(db, { kind: 'admin', actor: userId, action: 'disclosure.profile.saved', details: { profile: name, purpose: input.purpose, fields: fields.join(' '), revealed: fields.length, expires_days: days, change: existing ? 'updated' : 'created' } });
  if (existing) {
    Object.assign(existing, { name, purpose: input.purpose, description: input.description.trim(), fields: [...fields], expiresDays: days, updatedAt: r.ts, updatedBy: userId, seq: r.seq });
    touch(orgId, 'disclosure');
    return clone(existing);
  }
  const p: DisclosureProfile = { id: `dpf_${randHex(4)}`, name, purpose: input.purpose, description: input.description.trim(), fields: [...fields], expiresDays: days, createdAt: r.ts, createdBy: userId, seq: r.seq, used: 0 };
  list.push(p);
  touch(orgId, 'disclosure');
  return clone(p);
}

export function removeProfile(orgId: string, id: string, userId: string) {
  const db = getDB(orgId);
  requireL3(db, 'Saved disclosure profiles');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Removing a disclosure profile');
  ensureSeed(db);
  const x = l3ext(db);
  const p = (x.profiles ?? []).find((q) => q.id === id);
  if (!p) throw new Error('No such profile.');
  x.profiles = (x.profiles ?? []).filter((q) => q.id !== id);
  const r = append(db, { kind: 'admin', actor: userId, action: 'disclosure.profile.removed', details: { profile: p.name, purpose: p.purpose } });
  touch(orgId, 'disclosure');
  return { seq: r.seq };
}

/** Count one use of a profile (a package or bundle made from it). */
export function noteProfileUsed(orgId: string, id?: string) {
  if (!id) return;
  const p = (l3ext(getDB(orgId)).profiles ?? []).find((q) => q.id === id);
  if (p) p.used = (p.used ?? 0) + 1;
}

/* ── Bundles ───────────────────────────────────────────────── */

const saltFor = (secret: string, seq: number, name: string) => sha256Hex(`${secret}:${seq}:${name}`).slice(0, 32);

function itemsOf(db: OrgDB, seqs: number[], fields: string[], secret: string): BundleItem[] {
  const bySeq = new Map<number, Receipt>(db.receipts.map((r) => [r.seq, r]));
  const results = new Map<number, Receipt>();
  for (const r of db.receipts) if (r.kind === 'approval' && r.ref_seq !== undefined && !results.has(r.ref_seq)) results.set(r.ref_seq, r);
  const out: BundleItem[] = [];
  for (const seq of seqs) {
    const r = bySeq.get(seq);
    if (!r) continue;
    const values = fieldValuesOf(r, results.get(seq)) as Record<string, string>;
    const names = Object.keys(values).sort();
    out.push({
      seq, receiptHash: r.hash,
      committed: names.map((name) => ({ name, digest: disclosureDigest(saltFor(secret, seq, name), name, values[name]) })),
      revealed: names.filter((n) => fields.includes(n)).map((name) => ({ name, salt: saltFor(secret, seq, name), value: values[name] })),
    });
  }
  return out;
}

function withItems(db: OrgDB, b: StoredBundle): DisclosureBundle {
  const secret = l3ext(db).bundleSecrets?.[b.id] ?? '';
  const { seqs, ...rest } = b;
  const status = b.status === 'revoked' ? 'revoked' : new Date(b.expiresAt).getTime() < Date.now() ? 'expired' : 'active';
  return { ...clone(rest), status, items: itemsOf(db, seqs, b.fields, secret) };
}

function buildBundle(db: OrgDB, a: { seqs: number[]; fromSeq: number; toSeq: number; kinds: 'decisions' | 'all'; fields: string[]; audience: string; counterpartyId?: string; profile?: DisclosureProfile; expiresDays: number; userId: string; createdAt?: number }): StoredBundle {
  const x = l3ext(db);
  const id = `db_${randHex(5)}`;
  const secret = randHex(16);
  (x.bundleSecrets ??= {})[id] = secret;
  const key = db.keys[db.keys.length - 1].key;
  const createdAt = a.createdAt ?? Date.now();
  const fields: string[] = DISCLOSABLE_FIELDS.filter((f) => a.fields.includes(f));
  const items = itemsOf(db, a.seqs, fields, secret);
  const base = {
    format: BUNDLE_FORMAT as typeof BUNDLE_FORMAT, orgId: db.org.id, audience: a.audience, expiresAt: iso(Math.max(createdAt, Date.now()) + a.expiresDays * D),
    range: { fromSeq: a.fromSeq, toSeq: a.toSeq, count: items.length, kinds: a.kinds }, fields, items,
  };
  const stored: StoredBundle = {
    id, orgId: db.org.id, issuerName: db.org.name, format: BUNDLE_FORMAT, range: base.range, createdAt: iso(createdAt), createdBy: a.userId, audience: a.audience,
    counterpartyId: a.counterpartyId, profileId: a.profile?.id, profileName: a.profile?.name, fields, expiresAt: base.expiresAt, token: `${db.org.slug}.rb.${randHex(10)}`,
    kid: key.kid, publicKey: db.publicKeys[key.kid], sig: signText(bundleMessage(base), key), status: 'active', views: 0, downloads: 0, seqs: items.map((i) => i.seq),
  };
  (x.bundles ??= []).unshift(stored);
  return stored;
}

/** The receipts a range covers. */
export function rangeReceipts(db: OrgDB, fromSeq: number, toSeq: number, kinds: 'decisions' | 'all') {
  const lo = Math.min(fromSeq, toSeq);
  const hi = Math.max(fromSeq, toSeq);
  return db.receipts.filter((r) => r.seq >= lo && r.seq <= hi && (kinds === 'all' || r.kind === 'decision'));
}

/** How many receipts a range would cover, before anything is signed. */
export function previewRange(orgId: string, input: { fromSeq: number; toSeq: number; kinds: 'decisions' | 'all' }) {
  const db = getDB(orgId);
  const rs = rangeReceipts(db, input.fromSeq, input.toSeq, input.kinds);
  const head = db.receipts[db.receipts.length - 1]?.seq ?? 0;
  const first = db.receipts[0]?.seq ?? 0;
  return { count: rs.length, max: BUNDLE_MAX, first, head, refused: rs.filter((r) => r.decision === 'refuse').length, from: rs[0]?.ts, to: rs[rs.length - 1]?.ts };
}

export function bundlesView(orgId: string) {
  const db = getDB(orgId);
  ensureSeed(db);
  return (l3ext(db).bundles ?? []).map((b) => {
    const { seqs: _s, ...rest } = b;
    const status = b.status === 'revoked' ? 'revoked' : new Date(b.expiresAt).getTime() < Date.now() ? 'expired' : 'active';
    return { ...clone(rest), status: status as DisclosureBundle['status'] };
  });
}

export function bundleView(orgId: string, id: string): DisclosureBundle {
  const db = getDB(orgId);
  ensureSeed(db);
  const b = (l3ext(db).bundles ?? []).find((x) => x.id === id);
  if (!b) throw new Error('No such bundle.');
  return withItems(db, b);
}

export function createBundle(orgId: string, input: { fromSeq: number; toSeq: number; kinds: 'decisions' | 'all'; fields: string[]; profileId?: string; audience: string; counterpartyId?: string; expiresDays: number }, userId: string): DisclosureBundle {
  const db = getDB(orgId);
  requireL3(db, 'Disclosure bundles');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Signing a disclosure bundle');
  ensureSeed(db);
  if (!Number.isFinite(input.fromSeq) || !Number.isFinite(input.toSeq)) throw new Error('Give the first and last receipt of the range.');
  const profile = input.profileId ? (l3ext(db).profiles ?? []).find((p) => p.id === input.profileId) : undefined;
  if (input.profileId && !profile) throw new Error('That profile no longer exists.');
  const fields = input.fields.length ? input.fields : profile?.fields ?? [];
  const bad = fields.filter((f) => !(DISCLOSABLE_FIELDS as readonly string[]).includes(f));
  if (bad.length) throw new Error(`Not a disclosable field: ${bad.join(', ')}.`);
  if (!fields.length) throw new Error('Choose at least one field to reveal.');
  const audience = input.audience.trim();
  if (!/^ar-org:[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(audience)) throw new Error('Address the bundle to ar-org:<domain>.');
  const rs = rangeReceipts(db, input.fromSeq, input.toSeq, input.kinds);
  if (!rs.length) throw new Error('No receipts in that range.');
  if (rs.length > BUNDLE_MAX) throw new Error(`The range holds ${rs.length} receipts; one bundle holds at most ${BUNDLE_MAX}. Narrow the range or split it.`);
  const days = Math.floor(input.expiresDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error('Expiry is between 1 and 365 days.');
  const b = buildBundle(db, { seqs: rs.map((r) => r.seq), fromSeq: rs[0].seq, toSeq: rs[rs.length - 1].seq, kinds: input.kinds, fields, audience, counterpartyId: input.counterpartyId, profile, expiresDays: days, userId });
  const r = append(db, { kind: 'admin', actor: userId, action: 'disclosure.bundle.created', details: { bundle: b.id, from_seq: b.range.fromSeq, to_seq: b.range.toSeq, receipts: b.range.count, revealed: fields.length, committed: DISCLOSABLE_FIELDS.length, audience, ...(profile ? { profile: profile.name } : {}), expires: b.expiresAt.slice(0, 10) } });
  b.seqCreated = r.seq;
  if (profile) profile.used = (profile.used ?? 0) + 1;
  touch(orgId, 'disclosure');
  return withItems(db, b);
}

/** The bundle as one JSON file, ready to hand over. Writes disclosure.bundle.exported. */
export function exportBundle(orgId: string, id: string, userId: string) {
  const db = getDB(orgId);
  requireL3(db, 'Disclosure bundles');
  requireRoles(orgId, userId, ['owner', 'admin', 'auditor'], 'Exporting a disclosure bundle');
  const stored = (l3ext(db).bundles ?? []).find((x) => x.id === id);
  if (!stored) throw new Error('No such bundle.');
  if (stored.status === 'revoked') throw new Error('This bundle was withdrawn. Sign a new one to share the range again.');
  const b = withItems(db, stored);
  const file = bundleFile(db, b);
  const r = append(db, { kind: 'admin', actor: userId, action: 'disclosure.bundle.exported', details: { bundle: b.id, from_seq: b.range.fromSeq, to_seq: b.range.toSeq, receipts: b.range.count, audience: b.audience, bytes: file.text.length } });
  stored.downloads = (stored.downloads ?? 0) + 1;
  touch(orgId, 'disclosure');
  return { ...file, seq: r.seq };
}

function bundleFile(db: OrgDB, b: DisclosureBundle) {
  const domain = db.org.domain ?? db.org.slug;
  const body = {
    format: b.format,
    bundle_id: b.id,
    created_at: b.createdAt,
    // org_id is the manifest's iss: what the signature covers
    issuer: { id: `ar-org:${domain}`, org_id: b.orgId, name: b.issuerName, level: LEVEL_INFO[levelOfOrg(db.org)].label },
    audience: b.audience,
    expires_at: b.expiresAt,
    range: { from_seq: b.range.fromSeq, to_seq: b.range.toSeq, count: b.range.count, kinds: b.range.kinds },
    revealed_fields: b.fields,
    profile: b.profileName ?? null,
    items: b.items.map((i) => ({ seq: i.seq, receipt_hash: i.receiptHash, committed: i.committed, disclosures: i.revealed.map((f) => [f.salt, f.name, f.value]) })),
    // exactly what is signed, so it can be rebuilt from the fields above and compared
    manifest: bundleManifestObject(b),
    signature: {
      alg: 'Ed25519', key_id: b.kid, public_key: b.publicKey, fingerprint: sha256Hex(b.publicKey).slice(0, 16),
      signed: 'manifest_digest = SHA-256 over the canonical JSON (keys sorted, no spaces) of "manifest": {format, iss = issuer.org_id, aud = audience, exp = expires_at, range: {from = range.from_seq, to = range.to_seq, count, kinds}, fields = revealed_fields sorted, items: [[seq, receipt_hash, committed digests sorted]]}. sig is the Ed25519 signature over the manifest_digest hex string.',
      manifest_digest: bundleMessage(b), sig: b.sig,
    },
    limits: LIMITS,
    verify: [
      'Compare the fingerprint with the one the issuer gave you directly, not with this file.',
      'Rebuild "manifest" from the fields of this file as "signed" describes, check it equals the manifest given, recompute manifest_digest and check the Ed25519 signature with the issuer’s published key.',
      'Or open the file in the public verifier at /verify, which runs these checks in your browser.',
      'For each disclosure [salt, name, value], SHA-256 over canonical([salt, name, value]) must be one of that receipt’s committed digests.',
      'Withheld is not missing, and missing is not altered: withheld fields stay committed as digests under the same signature.',
    ],
  };
  return { filename: `disclosure-bundle-${db.org.slug}-${b.range.fromSeq}-${b.range.toSeq}.json`, text: JSON.stringify(body, null, 2) };
}

export function revokeBundle(orgId: string, id: string, userId: string) {
  const db = getDB(orgId);
  requireL3(db, 'Disclosure bundles');
  requireRoles(orgId, userId, OWNER_ADMIN, 'Withdrawing a disclosure bundle');
  const b = (l3ext(db).bundles ?? []).find((x) => x.id === id);
  if (!b) throw new Error('No such bundle.');
  if (b.status === 'revoked') throw new Error('This bundle is already withdrawn.');
  b.status = 'revoked';
  const r = append(db, { kind: 'admin', actor: userId, action: 'disclosure.bundle.revoked', details: { bundle: b.id, from_seq: b.range.fromSeq, to_seq: b.range.toSeq, audience: b.audience } });
  b.revokedAt = r.ts;
  b.revokedBy = userId;
  touch(orgId, 'disclosure');
  return withItems(db, b);
}

/** Public (no sign-in): the bundle behind a portal token, verified in the visitor's browser. */
export function bundleByToken(token: string) {
  const slug = token.split('.')[0];
  const org = ORGS.find((o) => o.slug === slug);
  if (!org) throw new Error('This link is not valid.');
  const db = getDB(org.id);
  ensureSeed(db);
  const b = (l3ext(db).bundles ?? []).find((x) => x.token === token);
  if (!b) throw new Error('This link is not valid or was withdrawn.');
  if (b.status === 'revoked') throw new Error(`${org.name} withdrew this disclosure.`);
  b.views++;
  b.lastViewedAt = iso(Date.now());
  touch(org.id, 'disclosure');
  const full = withItems(db, b);
  const cp = db.platform.counterparties.find((c) => c.id === b.counterpartyId);
  return { bundle: full, issuer: { name: org.name, fingerprint: sha256Hex(full.publicKey).slice(0, 16), level: LEVEL_INFO[levelOfOrg(db.org)].label }, counterparty: cp ? { name: cp.name, kind: cp.kind } : undefined, check: verifyDisclosureBundle(full), limits: LIMITS, file: bundleFile(db, full) };
}

/**
 * Public (no sign-in): the recipient downloads the bundle from its portal link. Counted with the bundle's downloads and
 * recorded on the issuer's chain (disclosure.bundle.exported, actor "system", via the portal).
 */
export function downloadBundleByToken(token: string, by?: string) {
  const org = ORGS.find((o) => o.slug === token.split('.')[0]);
  if (!org) throw new Error('This link is not valid.');
  const db = getDB(org.id);
  ensureSeed(db);
  const stored = (l3ext(db).bundles ?? []).find((x) => x.token === token);
  if (!stored) throw new Error('This link is not valid or was withdrawn.');
  if (stored.status === 'revoked') throw new Error(`${org.name} withdrew this disclosure.`);
  const b = withItems(db, stored);
  const file = bundleFile(db, b);
  const r = append(db, { kind: 'admin', actor: 'system', action: 'disclosure.bundle.exported', details: { bundle: b.id, from_seq: b.range.fromSeq, to_seq: b.range.toSeq, receipts: b.range.count, audience: b.audience, bytes: file.text.length, via: 'portal', ...(by ? { by } : {}) } });
  stored.downloads = (stored.downloads ?? 0) + 1;
  touch(org.id, 'disclosure');
  return { ...file, seq: r.seq, downloads: stored.downloads };
}

export const isBundleToken = (token: string) => token.split('.')[1] === 'rb';
