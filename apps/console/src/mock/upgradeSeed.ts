/**
 * Seeded L1 → L2 close-out for Northbank (L2 Attested): the upgrade run, the key bound and compared before the switch,
 * the notices, signing on, the first-ten check, the first bundle with its tampered copy and the closing record — so the
 * close-out is visible in the demo without running it. Pure data: imports nothing from the mock database.
 */
import { keyFromSeed } from '@/lib/crypto';
import type { AdminEvent } from './chain';

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

/**
 * Admin events around Northbank's boundary (`boundary` = the L2 period's start, in ms). The chain window starts five
 * days before the boundary, so the run begins inside it; the 14-day notice named a later date and the named contact
 * agreed to the earlier one, which the signing-on record says.
 */
export function northbankCloseoutEvents(boundary: number, p: (id: string) => string): AdminEvent[] {
  const kid = 'k_northbank_kms_2';
  const fp = keyFromSeed('org_northbank:key:2', kid).fingerprint;
  const owner = p('u_ananya'); // Rohan Kapoor
  const admin = p('u_rahul'); // Neha Bhatia
  const contact = { name: 'Gaurav Sethi', role: 'Financial Controller', domain: 'northbank.co.in' };
  const auditor = { name: 'Kavita Desai', role: 'Auditor · Partner, Desai & Co. Chartered Accountants', domain: 'desaico.in' };
  const planned = new Date(boundary - 4.5 * D + 14 * D).toISOString().slice(0, 10);
  const t0 = boundary - 4.9 * D;
  const ev = (at: number, actor: string, action: string, details: AdminEvent['details']): AdminEvent => ({ at, actor, action, details: { to: 'l2', ...details } });
  const out: AdminEvent[] = [
    { at: t0, actor: admin, action: 'level.upgrade_started', details: { from: 'l1', to: 'l2' } },
    ev(t0 + 20 * M, admin, 'level.upgrade_stage', { stage: 'preflight', result: 'verified', checkpoints: 'all valid', ms: 412 }),
    ev(t0 + 2 * H, admin, 'level.upgrade_key_created', { kid, fingerprint: fp, alias: 'alias/elan1/northbank/signing', key_ref: 'arn:aws:kms:ap-south-1:441723908815:key/7d1c40aa-93be-4f02-a1e6-5c08d2b7f914', region: 'ap-south-1', algorithm: 'Ed25519', key_spec: 'ECC_NIST_EDWARDS25519' }),
    ev(t0 + 3 * H, owner, 'level.upgrade_stage', { stage: 'kms', kid, fingerprint: fp, fingerprint_compared: 'match', channel: 'SMS to Rohan Kapoor (+91 ••••• 31877)', region: 'ap-south-1', alias: 'alias/elan1/northbank/signing', algorithm: 'Ed25519' }),
    ev(t0 + 0.4 * D, admin, 'level.upgrade_notice_scheduled', { notice: 'ntc_nb_14', kind: 'fourteen_day', to_name: contact.name, to_role: contact.role, to_domain: contact.domain, subject: `Northbank Industrial Ltd moves to L2 Attested on ${new Date(planned).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, send_at: new Date(t0 + 0.4 * D).toISOString(), planned_boundary: planned, body_sha256: 'a41f09c2d7be5530' }),
    ev(t0 + 0.4 * D + S, admin, 'level.upgrade_notice_sent', { notice: 'ntc_nb_14', kind: 'fourteen_day', to_name: contact.name, to_domain: contact.domain, channel: 'email', body_sha256: 'a41f09c2d7be5530' }),
    ev(t0 + 0.4 * D + 2 * M, admin, 'level.upgrade_notice_scheduled', { notice: 'ntc_nb_bd', kind: 'boundary_day', to_name: contact.name, to_role: contact.role, to_domain: contact.domain, subject: 'Northbank Industrial Ltd is on L2 Attested from record {signing_seq}', send_at: 'boundary', body_sha256: '5be0c1f7a9d24e88' }),
    ev(t0 + 0.4 * D + 3 * M, admin, 'level.upgrade_notice_scheduled', { notice: 'ntc_nb_au', kind: 'auditor_note', to_name: auditor.name, to_role: auditor.role, to_domain: auditor.domain, subject: 'Auditor note: Northbank Industrial Ltd L1 → L2 boundary at record {signing_seq}', send_at: 'boundary', body_sha256: '0c7d3e91f2a6b415' }),
    ev(t0 + 1 * D, admin, 'level.upgrade_stage', { stage: 'tsa', india: 'eMudhra TSA', global: 'DigiCert TSA', target_minutes: 15 }),
    ev(t0 + 1 * D + H, admin, 'level.upgrade_stage', { stage: 'worm', mode: 'compliance', retention_years: 8 }),
    ev(t0 + 1.2 * D, admin, 'level.upgrade_stage', { stage: 'profile', profile: 'none' }),
    { at: t0 + 3 * D, actor: owner, action: 'level.upgrade_seconded', details: { to: 'l2', stage: 'second', from: 'l1', started_by: admin } },
    // level.upgraded (boundary − 60 s) and key.rotated (the boundary) are seeded from the level history and key epochs
    ev(boundary + 2 * S, owner, 'level.signing_on', { kid, fingerprint: fp, bound_kid_matches: true, notice_lead_days: 4, early_boundary: true, early_agreed: true }),
  ];
  for (let k = 2; k <= 10; k++) out.push({ at: boundary + (2 + k) * S, actor: 'system', action: 'level.signing_canary', details: { to: 'l2', n: k, of: 10, kid } });
  out.push(
    ev(boundary + 20 * S, 'system', 'level.upgrade_notice_sent', { notice: 'ntc_nb_bd', kind: 'boundary_day', to_name: contact.name, to_domain: contact.domain, channel: 'email', body_sha256: '5be0c1f7a9d24e88' }),
    ev(boundary + 21 * S, 'system', 'level.upgrade_notice_sent', { notice: 'ntc_nb_au', kind: 'auditor_note', to_name: auditor.name, to_domain: auditor.domain, channel: 'email', body_sha256: '0c7d3e91f2a6b415' }),
    ev(boundary + 25 * M, admin, 'level.upgrade_first_ten_checked', { result: 'pass', checked: 10, failed: 0, kid, fingerprint: fp }),
    ev(boundary + 3 * H, owner, 'level.upgrade_first_bundle', { exit_code: 0, code: 'PASS', tampered_exit_code: 1, tampered_code: 'FAIL_INTEGRITY', tampered_field: 'details.n', fingerprint_supplied: fp }),
    ev(boundary + 1 * D, owner, 'level.upgrade_closed', { checks: '7 of 7', kid, c1_preflight: 'pass', c2_key: 'pass', c3_signing_on: 'pass', c4_first_ten: 'pass', c5_anchoring: 'pass', c6_first_bundle: 'pass', c7_notices: 'pass' }),
  );
  return out;
}

/* ── Demo Traders (L1 Guarded): a rolled-back upgrade and its signed island ── */

/**
 * Demo Traders tried L1 → L2 about 16 days ago. The switch went through and signing began with the bound KMS key, but
 * the global timestamp authority returned no tokens, the first bundle exited 3 (INCOMPLETE) and an owner rolled the
 * upgrade back before the closing record. The records signed with the KMS key stay in the chain as a signed island;
 * sealing returned to an Elan1 Govern process key. Seeded so the rollback and the island are visible without running it.
 */
export const DEMO_ISLAND = {
  kmsKid: 'k_demo_kms_1',
  kmsSeed: 'org_demo:key:island-kms',
  envKid: 'k_demo_env_1',
  envSeed: 'org_demo:key:island-env',
  /** the boundary: 08:40 IST, 16 days back */
  boundaryDay: 16,
  boundaryAt: [8, 40] as const,
  /** the rollback, this long after the boundary */
  rollbackAfter: 5 * H + 20 * M,
  bindReason: 'Signing moved into AWS KMS (ap-south-1) for L2 Attested, with the key bound and its fingerprint compared before the switch',
  rollbackReason: 'Upgrade to L2 Attested rolled back: sealing returns to an Elan1 Govern process key',
  reason: 'The global timestamp authority returned no tokens after the switch, so the first batch held 1 of 2 timestamps and the first bundle exited 3 (INCOMPLETE). Rolled back to fix the authority account before running the upgrade again.',
};

/** The two key epochs of the island (the KMS key at the boundary, the process key at the rollback), in days ago. */
export function demoIslandEpochs(boundary: number, now: number) {
  return [
    { daysAgo: (now - boundary) / D, kid: DEMO_ISLAND.kmsKid, reason: DEMO_ISLAND.bindReason, seed: DEMO_ISLAND.kmsSeed },
    { daysAgo: (now - boundary - DEMO_ISLAND.rollbackAfter) / D, kid: DEMO_ISLAND.envKid, reason: DEMO_ISLAND.rollbackReason, seed: DEMO_ISLAND.envSeed },
  ];
}

/**
 * Admin events of Demo Traders' rolled-back upgrade (`boundary` = the moment the KMS key started signing, in ms). The
 * key.rotated records at the boundary and at the rollback come from the key epochs. The rollback receipt names the
 * island by its key; its sequence range is read from the chain (mock/upgrade.ts islandsOf).
 */
export function demoIslandEvents(boundary: number, p: (id: string) => string): AdminEvent[] {
  const kid = DEMO_ISLAND.kmsKid;
  const fp = keyFromSeed(DEMO_ISLAND.kmsSeed, kid).fingerprint;
  const envFp = keyFromSeed(DEMO_ISLAND.envSeed, DEMO_ISLAND.envKid).fingerprint;
  const owner = p('u_ananya'); // Ananya Rao
  const admin = p('u_rahul'); // Rahul Menon
  const contact = { name: 'Arjun Mehta', role: 'Head of Accounts, Surya Packaging', domain: 'suryapackaging.in' };
  const auditor = { name: 'Kavita Desai', role: 'Auditor · Partner, Desai & Co. Chartered Accountants', domain: 'desaico.in' };
  const t0 = boundary - 3.2 * D;
  const sentAt = t0 + 0.3 * D;
  const planned = new Date(sentAt + 5.5 * H + 14 * D).toISOString().slice(0, 10);
  const rollback = boundary + DEMO_ISLAND.rollbackAfter;
  const ev = (at: number, actor: string, action: string, details: AdminEvent['details']): AdminEvent => ({ at, actor, action, details: { to: 'l2', ...details } });
  const out: AdminEvent[] = [
    { at: t0, actor: admin, action: 'level.upgrade_started', details: { from: 'l1', to: 'l2' } },
    ev(t0 + 15 * M, admin, 'level.upgrade_stage', { stage: 'preflight', result: 'verified', checkpoints: 'all valid', ms: 388 }),
    ev(t0 + 1 * H, admin, 'level.upgrade_key_created', { kid, fingerprint: fp, alias: 'alias/elan1/demo-traders/signing', key_ref: 'arn:aws:kms:ap-south-1:441723908815:key/2b8e61f0-4c7d-4a93-9e15-d0a7c3f58b26', region: 'ap-south-1', algorithm: 'Ed25519', key_spec: 'ECC_NIST_EDWARDS25519' }),
    ev(t0 + 2 * H, owner, 'level.upgrade_stage', { stage: 'kms', kid, fingerprint: fp, fingerprint_compared: 'match', channel: 'SMS to Ananya Rao (+91 ••••• 11203)', region: 'ap-south-1', alias: 'alias/elan1/demo-traders/signing', algorithm: 'Ed25519' }),
    ev(sentAt, admin, 'level.upgrade_notice_scheduled', { notice: 'ntc_demo_14', kind: 'fourteen_day', to_name: contact.name, to_role: contact.role, to_domain: contact.domain, subject: `Demo Traders Pvt Ltd moves to L2 Attested on ${new Date(planned).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, send_at: new Date(sentAt).toISOString(), planned_boundary: planned, body_sha256: '7e2c90b4d1a65f38' }),
    ev(sentAt + S, admin, 'level.upgrade_notice_sent', { notice: 'ntc_demo_14', kind: 'fourteen_day', to_name: contact.name, to_domain: contact.domain, channel: 'email', body_sha256: '7e2c90b4d1a65f38' }),
    ev(sentAt + 2 * M, admin, 'level.upgrade_notice_scheduled', { notice: 'ntc_demo_bd', kind: 'boundary_day', to_name: contact.name, to_role: contact.role, to_domain: contact.domain, subject: 'Demo Traders Pvt Ltd is on L2 Attested from record {signing_seq}', send_at: 'boundary', body_sha256: 'c3a18e5f09d7b246' }),
    ev(sentAt + 3 * M, admin, 'level.upgrade_notice_scheduled', { notice: 'ntc_demo_au', kind: 'auditor_note', to_name: auditor.name, to_role: auditor.role, to_domain: auditor.domain, subject: 'Auditor note: Demo Traders Pvt Ltd L1 → L2 boundary at record {signing_seq}', send_at: 'boundary', body_sha256: '58f0d2a7c1e94b63' }),
    ev(t0 + 1 * D, admin, 'level.upgrade_stage', { stage: 'tsa', india: 'eMudhra TSA', global: 'DigiCert TSA', target_minutes: 15 }),
    ev(t0 + 1 * D + H, admin, 'level.upgrade_stage', { stage: 'worm', mode: 'compliance', retention_years: 8 }),
    ev(t0 + 1.1 * D, admin, 'level.upgrade_stage', { stage: 'profile', profile: 'none' }),
    { at: t0 + 2.9 * D, actor: owner, action: 'level.upgrade_seconded', details: { to: 'l2', stage: 'second', from: 'l1', started_by: admin } },
    // the switch: level.upgraded one second before the KMS key starts signing (key.rotated, from the key epochs)
    { at: boundary - S, actor: owner, action: 'level.upgraded', details: { from: 'l1', to: 'l2' } },
    ev(boundary + S, owner, 'level.signing_on', { kid, fingerprint: fp, bound_kid_matches: true, notice_lead_days: 3, early_boundary: true, early_agreed: true }),
  ];
  for (let k = 2; k <= 10; k++) out.push({ at: boundary + (1 + k) * S, actor: 'system', action: 'level.signing_canary', details: { to: 'l2', n: k, of: 10, kid } });
  out.push(
    ev(boundary + 20 * S, 'system', 'level.upgrade_notice_sent', { notice: 'ntc_demo_bd', kind: 'boundary_day', to_name: contact.name, to_domain: contact.domain, channel: 'email', body_sha256: 'c3a18e5f09d7b246' }),
    ev(boundary + 21 * S, 'system', 'level.upgrade_notice_sent', { notice: 'ntc_demo_au', kind: 'auditor_note', to_name: auditor.name, to_domain: auditor.domain, channel: 'email', body_sha256: '58f0d2a7c1e94b63' }),
    ev(boundary + 30 * M, admin, 'level.upgrade_first_ten_checked', { result: 'pass', checked: 10, failed: 0, kid, fingerprint: fp }),
    ev(boundary + 3 * H, owner, 'level.upgrade_first_bundle', { exit_code: 3, code: 'INCOMPLETE', tampered_exit_code: 1, tampered_code: 'FAIL_INTEGRITY', tampered_field: 'details.n', fingerprint_supplied: fp, missing: 'DigiCert TSA token for the first batch' }),
    // key.rotated (back to a process key) is at `rollback`, from the key epochs; the rollback record follows it
    { at: rollback + S, actor: owner, action: 'level.upgrade_rolled_back', details: { from: 'l2', to: 'l1', island_kid: kid, island_fingerprint: fp, new_kid: DEMO_ISLAND.envKid, new_fingerprint: envFp, reason: DEMO_ISLAND.reason } },
  );
  return out;
}
