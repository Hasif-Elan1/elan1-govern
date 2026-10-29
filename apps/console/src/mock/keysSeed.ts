/**
 * Seeded key history the demo shows without anyone running the flows (mock/keys.ts reads these receipts back):
 *
 *  Â· Kaveri (L3 Proven) â€” a closed key compromise from its L2 period: the KMS key k_kaveri_kms_2 declared compromised,
 *    signing stopped and Elan1 Govern's interim chain key sealed the chain for about a day, the notice went out within
 *    24 hours, a replacement KMS key was bound ("Key bound Â· signing off"), a second person turned signing on, and the
 *    compromise was closed. The unsigned interval shows on the chain, on its receipts and in every export.
 *  Â· Deccan (Sovereign) â€” a planned successor generated in the nShield HSM and bound 6 days ago, published ahead of
 *    signing (the overlap): "Key bound Â· signing off" until the switch.
 *  Â· Demo Traders (L1) â€” a key rotation refused, and recorded, while the receipt-write incident was still open.
 *
 * Pure data: imports nothing from the mock database. Current signing keys are unchanged (counterparties pin them).
 */
import { keyFromSeed } from '@/lib/crypto';
import type { AdminEvent } from './chain';
import { userById } from './users';

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();

/** Kaveri's compromise: when it was declared (days ago), and the keys involved. */
export const KAVERI_COMPROMISE = {
  id: 'kcmp_seed_kaveri',
  daysAgo: 75,
  revokedKid: 'k_kaveri_kms_2',
  interimKid: 'k_kaveri_hc_2608',
  interimSeed: 'org_kaveri:key:hc:2608',
  newKid: 'k_kaveri_kms_2608',
  newSeed: 'org_kaveri:key:kms:2608',
  /** hours after the declaration */
  noticeAfterH: 3,
  boundAfterH: 20,
  signingOnAfterH: 26,
  closedAfterH: 46,
  reason: 'A CI deployment role was found holding kms:Sign on the signing key; CloudTrail showed 3 Sign calls from it with no matching receipt.',
};

/** Deccan's planned successor, bound ahead of the switch. */
export const DECCAN_BOUND = {
  kid: 'k_deccan_hsm_2610_3',
  seed: 'org_deccan:key:bound:2610',
  boundDaysAgo: 6,
  overlapDays: 30,
  reason: 'Planned rotation: successor generated in the nShield HSM and published 30 days ahead of signing',
};

/** Demo Traders' refused rotation, during the seeded receipt-write incident (mock/ops.ts inc_h_write_seed). */
export const DEMO_REFUSAL = { incident: 'inc_h_write_seed', what: 'rotate the signing key', atFromIncident: 7 * M + 20 * S };

/** Key epochs to add to an organisation's spec (with their own seeds, so existing keys keep theirs). */
export function seededKeyEpochs(orgId: string): { daysAgo: number; kid: string; reason: string; seed: string }[] {
  if (orgId !== 'org_kaveri') return [];
  const c = KAVERI_COMPROMISE;
  return [
    { daysAgo: c.daysAgo, kid: c.interimKid, seed: c.interimSeed, reason: 'Signing stopped: key compromise declared' },
    { daysAgo: c.daysAgo - c.signingOnAfterH / 24, kid: c.newKid, seed: c.newSeed, reason: 'Signing on with the replacement key after a key compromise' },
  ];
}

/** The admin receipts around the seeded key history (besides the key.rotated receipts the epochs write). */
export function seededKeyEvents(orgId: string, now0: number, p: (id: string) => string): AdminEvent[] {
  if (orgId === 'org_kaveri') {
    const c = KAVERI_COMPROMISE;
    const t = now0 - c.daysAgo * D;
    const revokedFp = keyFromSeed('org_kaveri:key:2', c.revokedKid).fingerprint;
    const nk = keyFromSeed(c.newSeed, c.newKid);
    const owner = p('u_ananya');
    const admin = p('u_rahul');
    const contact = userById(admin)?.email ?? 'security@kaveri.example';
    const auditor = userById('u_kavita')?.email ?? 'auditor@example.in';
    return [
      { at: t + 30 * S, actor: owner, action: 'key.compromise.declared', details: { compromise: c.id, kid: c.revokedKid, fingerprint: revokedFp, reason: c.reason, suspected_since: iso(t - 2 * D), interim_kid: c.interimKid, notice_due: iso(t + 24 * H), contact } },
      { at: t + c.noticeAfterH * H, actor: owner, action: 'key.compromise.notice_sent', details: { compromise: c.id, to: contact, cc: auditor, due: iso(t + 24 * H), within_24h: true } },
      { at: t + c.boundAfterH * H, actor: admin, action: 'key.bound', details: { kid: c.newKid, fingerprint: nk.fingerprint, provider: 'AWS KMS', purpose: 'compromise', reason: 'Replacement key after a declared compromise', signing: 'off', compromise: c.id } },
      { at: t + c.closedAfterH * H, actor: owner, action: 'key.compromise.closed', details: { compromise: c.id, revoked_kid: c.revokedKid, new_kid: c.newKid, interim_kid: c.interimKid, notice_within_24h: true, note: 'The CI role lost kms:Sign; the 3 calls were a misconfigured release job signing a test payload. No receipt was signed by anyone else. Fingerprint of the new key published on DNS and sent to the auditor.' } },
    ];
  }
  if (orgId === 'org_deccan') {
    const b = DECCAN_BOUND;
    const t = now0 - b.boundDaysAgo * D;
    const k = keyFromSeed(b.seed, b.kid);
    return [{ at: t, actor: p('u_ananya'), action: 'key.bound', details: { kid: b.kid, fingerprint: k.fingerprint, provider: 'Entrust nShield Connect XC', purpose: 'planned', reason: b.reason, signing: 'off', switch_at: iso(t + b.overlapDays * D), holders: 3 } }];
  }
  if (orgId === 'org_demo') {
    const at = now0 - 4 * D - 3 * H + DEMO_REFUSAL.atFromIncident;
    return [{ at, actor: p('u_rahul'), action: 'key.change_refused', details: { what: DEMO_REFUSAL.what, incident: DEMO_REFUSAL.incident, reason: 'chain incident is open' } }];
  }
  return [];
}
