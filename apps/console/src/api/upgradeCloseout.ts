/**
 * API for the L1 → L2 upgrade close-out (mock/upgrade.ts). Spread into `api` in api/index.ts; a real backend
 * replaces these bodies without touching a screen. Every write is a receipt in the organisation's chain.
 */
import * as db from '@/mock/db';
import * as platform from '@/mock/platform';
import * as up from '@/mock/upgrade';

const wait = (min = 90, max = 260) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const copy = <T,>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
const batchesOf = (orgId: string) => platform.anchorBatches(db.getDB(orgId)).map(({ firstSeq, lastSeq, windowEnd, tokens }) => ({ firstSeq, lastSeq, windowEnd, tokens: tokens.map((t) => ({ status: t.status })) }));

export const upgradeCloseoutApi = {
  /**
   * The newest L1 → L2 upgrade and its close-out. Returns CloseoutView: { phase: none|preparing|switched|closed|rolled_back,
   * key, outOfBand, signing, nextSigningSeq, firstTen, firstBundle, anchoring, notices, checks (7), closed, rolledBack, islands, canRollBack }.
   */
  async upgradeCloseout(orgId: string) {
    await wait(60, 140);
    return copy(up.closeoutView(orgId, batchesOf(orgId)));
  },

  /** People a notice can go to (members, with the auditor marked). */
  async upgradeContacts(orgId: string) {
    await wait(40, 90);
    return copy(up.suggestedContacts(orgId));
  },

  /** Stage 1: create the Ed25519 key in AWS KMS before the switch. Writes level.upgrade_key_created; elan1 sends the fingerprint out of band. */
  async createUpgradeKey(orgId: string, userId: string) {
    await wait(500, 900);
    return copy(up.createUpgradeKey(orgId, userId));
  },

  /** Compare the fingerprint received out of band. A match writes the key stage (level.upgrade_stage, kms); a mismatch writes level.upgrade_fingerprint_mismatch. */
  async compareUpgradeFingerprint(orgId: string, userId: string, typed: string) {
    await wait(200, 400);
    return copy(up.compareUpgradeFingerprint(orgId, userId, typed));
  },

  /** Compose and schedule a customer notice (14-day notice, boundary-day confirmation, auditor note). Writes level.upgrade_notice_scheduled (and _sent when due now). */
  async scheduleUpgradeNotice(orgId: string, userId: string, input: up.NoticeInput) {
    await wait(200, 400);
    return copy(up.scheduleNotice(orgId, userId, input));
  },

  async sendUpgradeNotice(orgId: string, userId: string, id: string) {
    await wait(200, 400);
    return copy(up.sendNoticeNow(orgId, userId, id));
  },

  async cancelUpgradeNotice(orgId: string, userId: string, id: string) {
    await wait(150, 300);
    return copy(up.cancelNotice(orgId, userId, id));
  },

  /**
   * The switch, L1 → L2 (owner only): checks the key is bound, the notice sent and the chain still where the confirm
   * screen named `namedSeq`; then level.upgraded, the bound key takes over, level.signing_on at `namedSeq`, nine canary
   * records and the boundary-day notices. Returns { seq, matched, kid, fingerprint }.
   */
  async switchToL2(orgId: string, userId: string, namedSeq: number, earlyAgreed: boolean) {
    await wait(700, 1200);
    const pre = up.preSwitchCheck(orgId, namedSeq, earlyAgreed);
    platform.upgradeLevel(orgId, 'l2', userId);
    return copy(up.signOn(orgId, userId, namedSeq, { leadDays: pre.leadDays, early: pre.early, earlyAgreed }));
  },

  /** Check the first ten signed records against the fingerprint compared out of band. Writes level.upgrade_first_ten_checked. */
  async runFirstTen(orgId: string, userId: string) {
    await wait(300, 600);
    return copy(up.runFirstTen(orgId, userId));
  },

  /**
   * Verify the first bundle and a tampered copy. The bundle is exported first through the export dialog (api.exportPack,
   * with every export check), which writes evidence.exported; this writes level.upgrade_first_bundle.
   */
  async runFirstBundle(orgId: string, userId: string, sent?: { exportId: string; json: string }) {
    await wait(300, 600);
    return copy(up.runFirstBundle(orgId, userId, sent));
  },

  /** The closing record (all seven checks must pass). Writes level.upgrade_closed. */
  async writeClosingRecord(orgId: string, userId: string) {
    await wait(300, 600);
    return copy(up.writeClosingRecord(orgId, userId, batchesOf(orgId)));
  },

  /** Roll back a failed upgrade before its closing record (owner only): the signed records stay as an island. Writes level.upgrade_rolled_back. */
  async rollbackUpgrade(orgId: string, userId: string, reason: string) {
    await wait(600, 1000);
    return copy(up.rollbackUpgrade(orgId, userId, reason));
  },
};
