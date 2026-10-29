/**
 * Redacted sharing of one receipt in the SD-JWT format (RFC 9901), for L2 Attested.
 *
 * Every one of the 11 disclosable fields gets a fresh salt; the issuer signs the digests of all of them;
 * the holder receives only the disclosures (salt, name, value) of the fields chosen. A verifier recomputes
 * each revealed digest and checks it is in the signed list; hidden fields stay committed.
 *
 * The mock has no issuing endpoint below L3 (api.createDisclosure starts at L3 and adds the counterparty
 * portal), so this module stands in for it: it signs with the key that signed the receipt and records a
 * disclosure.exported receipt on the chain. A real backend signs server-side with the key in custody.
 */
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { db } from '@/api';
import type { DisclosurePackage, Receipt } from '@/types';
import { signText } from '@/lib/crypto';
import { DISCLOSABLE_FIELDS, commitFields, disclosureMessage, fieldValuesOf, type DisclosableField } from '@/lib/disclosure';

const b64url = (bytes: Uint8Array) => {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlText = (text: string) => b64url(utf8ToBytes(text));

export interface RedactedShare {
  sdJwt: string;
  pkg: DisclosurePackage;
  revealed: number;
  committed: number;
  seq: number;
}

/** Build, sign and record a redacted share of receipt `r`, revealing `fields` to `audience`. */
export function issueRedactedShare(orgId: string, r: Receipt, fields: DisclosableField[], audience: string, userId: string, approvalResult?: Receipt, expiresDays = 30): RedactedShare {
  if (!fields.length) throw new Error('Choose at least one field to reveal.');
  const d = db.getDB(orgId);
  const key = d.keys.find((k) => k.key.kid === r.kid)?.key ?? d.keys[d.keys.length - 1].key;
  const values = fieldValuesOf(r, approvalResult);
  const { committed, salts } = commitFields(values);
  const now = Date.now();
  const expiresAt = new Date(now + expiresDays * 86_400_000).toISOString();
  const aud = audience.trim() || 'ar-org:unspecified';
  const base = { orgId, seq: r.seq, receiptHash: r.hash, audience: aud, expiresAt, committed };
  const revealed = DISCLOSABLE_FIELDS.filter((f) => fields.includes(f)).map((name) => ({ name, salt: salts[name], value: values[name] }));
  const pkg: DisclosurePackage = {
    id: `dx_${now.toString(36)}`, ...base, issuerName: d.org.name, createdAt: new Date(now).toISOString(), createdBy: userId, token: '', revealed,
    kid: key.kid, publicKey: d.publicKeys[key.kid], sig: signText(disclosureMessage(base), key), status: 'active', views: 0,
  };
  // SD-JWT compact serialisation: <issuer-signed JWT>~<disclosure>~…~
  const disclosures = DISCLOSABLE_FIELDS.map((name) => ({ name, enc: b64urlText(JSON.stringify([salts[name], name, values[name]])) }));
  const header = { alg: 'EdDSA', typ: 'example+sd-jwt', kid: key.kid };
  const payload = {
    iss: `ar-org:${d.org.domain ?? d.org.slug}`, aud, iat: Math.floor(now / 1000), exp: Math.floor(new Date(expiresAt).getTime() / 1000),
    _sd_alg: 'sha-256', _sd: disclosures.map((x) => b64url(sha256(utf8ToBytes(x.enc)))).sort(),
    receipt: { org: orgId, seq: r.seq, hash: r.hash, kid: r.kid },
  };
  const signingInput = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(payload))}`;
  const sigHex = signText(signingInput, key);
  const sigBytes = new Uint8Array(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const sdJwt = `${signingInput}.${b64url(sigBytes)}~${disclosures.filter((x) => fields.includes(x.name)).map((x) => x.enc).join('~')}~`;
  const rec = db.logAdmin(orgId, userId, 'disclosure.exported', { seq: r.seq, revealed: revealed.length, committed: committed.length, audience: aud, format: 'sd-jwt' });
  pkg.seqCreated = rec.seq;
  return { sdJwt, pkg, revealed: revealed.length, committed: committed.length, seq: rec.seq };
}
