/**
 * API for the L3 extras: saved disclosure profiles, disclosure bundles over a range, the first-issue warning,
 * dual-control acceptance, revoking and disputing cross-organisation receipts, and autonomy breaches and cooldowns.
 * Spread into `api` in api/index.ts; a real backend replaces these bodies without touching a screen. Every write is a
 * receipt in the organisation's chain, and every write checks the caller's role here as well as in the mock.
 */
import * as db from '@/mock/db';
import * as platform from '@/mock/platform';
import * as dis from '@/mock/l3disclosure';
import * as xo from '@/mock/l3crossorg';
import * as auto from '@/mock/l3autonomy';
import type { DisclosurePurpose } from '@/lib/disclosure';

const wait = (min = 90, max = 260) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const copy = <T,>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

/** Server-side role check: the caller's role in this organisation now. */
function requireRole(orgId: string, userId: string, roles: string[], what: string) {
  const role = db.memberRole(orgId, userId);
  if (!role || !roles.includes(role)) throw new Error(`${what} — ${roles.length === 2 ? 'owners and admins' : 'owners, admins and approvers'} can do this; ${role ? 'your role cannot' : 'you hold no active role in this organisation'}.`);
}

const OA = ['owner', 'admin'];

export const l3ExtrasApi = {
  /* ── Saved disclosure profiles ── */

  /** Saved disclosure profiles (name, purpose, fields, expiry): DisclosureProfile[]. */
  async disclosureProfiles(orgId: string) {
    await wait(60, 140);
    return dis.profilesView(orgId);
  },

  /** Create or update a profile (owner or admin). Writes disclosure.profile.saved. */
  async saveDisclosureProfile(orgId: string, input: { id?: string; name: string; purpose: DisclosurePurpose; description: string; fields: string[]; expiresDays: number }, userId: string) {
    await wait(200, 400);
    requireRole(orgId, userId, OA, 'Saving a disclosure profile');
    return dis.saveProfile(orgId, input, userId);
  },

  /** Remove a profile (owner or admin). Writes disclosure.profile.removed. Packages already made from it are unchanged. */
  async removeDisclosureProfile(orgId: string, id: string, userId: string) {
    await wait(150, 300);
    requireRole(orgId, userId, OA, 'Removing a disclosure profile');
    return dis.removeProfile(orgId, id, userId);
  },

  /** Count one use of a profile when a package is made from it. */
  async noteProfileUsed(orgId: string, id: string) {
    dis.noteProfileUsed(orgId, id);
  },

  /* ── Bundles over a range ── */

  /** How many receipts a range covers (and the chain's first and last receipt), before signing. */
  async bundleRangePreview(orgId: string, input: { fromSeq: number; toSeq: number; kinds: 'decisions' | 'all' }) {
    await wait(40, 90);
    return dis.previewRange(orgId, input);
  },

  /** Bundles signed by this organisation (without their items). */
  async disclosureBundles(orgId: string) {
    await wait();
    return dis.bundlesView(orgId);
  },

  /** One bundle with every receipt's committed digests and revealed fields. */
  async disclosureBundle(orgId: string, id: string) {
    await wait(80, 180);
    return dis.bundleView(orgId, id);
  },

  /**
   * Sign one bundle over a range (owner or admin; at most 200 receipts). Before the first issue to a new audience the
   * caller passes acknowledgeFirstIssue (the volume and reversal warning), which is recorded. Writes disclosure.bundle.created.
   */
  async createDisclosureBundle(orgId: string, input: { fromSeq: number; toSeq: number; kinds: 'decisions' | 'all'; fields: string[]; profileId?: string; audience: string; counterpartyId?: string; expiresDays: number; acknowledgeFirstIssue?: boolean }, userId: string) {
    await wait(400, 800);
    requireRole(orgId, userId, OA, 'Signing a disclosure bundle');
    const info = xo.firstIssueInfo(orgId, input.audience);
    xo.requireFirstIssueAck(orgId, input.audience, input.acknowledgeFirstIssue);
    const b = dis.createBundle(orgId, input, userId);
    if (info.first) xo.recordFirstIssueAck(orgId, info, userId, `disclosure bundle ${b.id}`);
    return b;
  },

  /**
   * Issue a receipt to a counterparty from a screen that shows the volume and reversal warning: a first issue to the
   * counterparty's audience is refused unless `acknowledgeFirstIssue`, and the acknowledgement is recorded
   * (counterparty.first_issue.acknowledged). Otherwise as issueToCounterparty: { receipt, disclosure }.
   */
  async issueToCounterpartyChecked(orgId: string, seq: number, counterpartyId: string, fields: string[], userId: string, opts: { acknowledgeFirstIssue: boolean; profileId?: string; expiresDays?: number }) {
    await wait(500, 900);
    requireRole(orgId, userId, OA, 'Issuing a receipt to a counterparty');
    const cp = db.getDB(orgId).platform.counterparties.find((c) => c.id === counterpartyId);
    if (!cp) throw new Error('No such counterparty.');
    const audience = `ar-org:${cp.domain}`;
    const info = xo.firstIssueInfo(orgId, audience, seq);
    xo.requireFirstIssueAck(orgId, audience, opts.acknowledgeFirstIssue);
    const out = platform.issueToCounterparty(orgId, seq, counterpartyId, fields, userId, opts.expiresDays ?? 30);
    if (info.first) xo.recordFirstIssueAck(orgId, info, userId, `receipt #${seq}`);
    if (opts.profileId) dis.noteProfileUsed(orgId, opts.profileId);
    return copy(out);
  },

  /** Create a disclosure package from a screen that shows the warning (see issueToCounterpartyChecked). Returns DisclosurePackage. */
  async createDisclosureChecked(orgId: string, input: { seq: number; fields: string[]; audience: string; counterpartyId?: string; expiresDays?: number }, userId: string, opts: { acknowledgeFirstIssue: boolean; profileId?: string }) {
    await wait(300, 600);
    requireRole(orgId, userId, OA, 'Creating a disclosure package');
    const info = xo.firstIssueInfo(orgId, input.audience, input.seq);
    xo.requireFirstIssueAck(orgId, input.audience, opts.acknowledgeFirstIssue);
    const pkg = platform.createDisclosure(orgId, input, userId);
    if (info.first) xo.recordFirstIssueAck(orgId, info, userId, `disclosure package ${pkg.id}`);
    if (opts.profileId) dis.noteProfileUsed(orgId, opts.profileId);
    return copy(pkg);
  },

  /** Verify and record a received receipt (owner or admin): the check uses the issuer's published key and the pinned fingerprint, never the key inside the receipt, and refuses a replayed nonce. */
  async verifyReceivedChecked(orgId: string, id: string, userId: string) {
    await wait(300, 600);
    requireRole(orgId, userId, OA, 'Recording a received receipt');
    xo.prepareCrossOrg(orgId);
    return copy(platform.verifyReceived(orgId, id, userId));
  },

  /** The bundle as one JSON file { filename, text, seq }. Writes disclosure.bundle.exported. */
  async exportDisclosureBundle(orgId: string, id: string, userId: string) {
    await wait(150, 300);
    return dis.exportBundle(orgId, id, userId);
  },

  /** Withdraw a bundle; its portal link stops. Writes disclosure.bundle.revoked. */
  async revokeDisclosureBundle(orgId: string, id: string, userId: string) {
    await wait(150, 300);
    requireRole(orgId, userId, OA, 'Withdrawing a disclosure bundle');
    return dis.revokeBundle(orgId, id, userId);
  },

  /** Public (no sign-in): the bundle behind a portal token, with its check and its file. */
  async disclosureBundleByToken(token: string) {
    await wait(200, 400);
    return copy(dis.bundleByToken(token));
  },

  /** Public (no sign-in): download the bundle behind a portal token as one file. Counted, and recorded on the issuer's chain (disclosure.bundle.exported via the portal). */
  async downloadDisclosureBundleByToken(token: string, by?: string) {
    await wait(120, 260);
    return dis.downloadBundleByToken(token, by);
  },

  isBundleToken: dis.isBundleToken,

  /* ── First issue to a new audience ── */

  /** Whether an audience has had anything from this organisation yet, and the volume a disclosure reveals. */
  async firstIssueInfo(orgId: string, audience: string, seq?: number) {
    await wait(40, 90);
    return xo.firstIssueInfo(orgId, audience, seq);
  },

  /** Record that a person read the volume and reversal warning before the first issue to an audience (counterparty.first_issue.acknowledged). */
  async acknowledgeFirstIssue(orgId: string, audience: string, userId: string, what: string, seq?: number) {
    await wait(60, 120);
    requireRole(orgId, userId, OA, 'Issuing to a new audience');
    return xo.acknowledgeFirstIssue(orgId, audience, userId, what, seq);
  },

  /* ── Received: dual-control acceptance ── */

  /** Start or complete accepting a received receipt (owner or admin; two different people). Writes counterparty.receipt.accept_started, then counterparty.receipt.accepted. */
  async acceptReceived(orgId: string, id: string, userId: string, note = '') {
    await wait(250, 500);
    requireRole(orgId, userId, OA, 'Accepting a received receipt');
    return xo.acceptReceived(orgId, id, userId, note);
  },

  /** Refuse to accept a received receipt, with a reason. Writes counterparty.receipt.accept_refused. */
  async refuseReceived(orgId: string, id: string, userId: string, reason: string) {
    await wait(200, 400);
    requireRole(orgId, userId, OA, 'Refusing a received receipt');
    return xo.refuseAcceptance(orgId, id, userId, reason);
  },

  /* ── Revoke and dispute ── */

  /** Revoke an issued receipt (owner or admin, with a reason). Writes counterparty.receipt.revoked; the receiver is told when it is in this console. */
  async revokeIssued(orgId: string, id: string, userId: string, reason: string) {
    await wait(250, 500);
    requireRole(orgId, userId, OA, 'Revoking an issued receipt');
    return xo.revokeIssued(orgId, id, userId, reason);
  },

  /** Dispute a received receipt (owner, admin or approver). Writes counterparty.receipt.disputed; the issuer is told when it is here. */
  async disputeReceived(orgId: string, id: string, userId: string, reason: string) {
    await wait(250, 500);
    requireRole(orgId, userId, ['owner', 'admin', 'approver'], 'Disputing a received receipt');
    return xo.disputeReceived(orgId, id, userId, reason);
  },

  /** Record a dispute a counterparty outside this console raised about an issued receipt. Writes counterparty.receipt.dispute_recorded. */
  async recordDispute(orgId: string, id: string, userId: string, input: { raisedBy: string; reason: string }) {
    await wait(200, 400);
    requireRole(orgId, userId, OA, 'Recording a dispute');
    return xo.recordDispute(orgId, id, userId, input);
  },

  /** Resolve an open dispute: upheld (an issued receipt is then revoked) or rejected, with a note. Writes counterparty.receipt.dispute_resolved. */
  async resolveDispute(orgId: string, id: string, userId: string, outcome: 'upheld' | 'rejected', note: string) {
    await wait(250, 500);
    requireRole(orgId, userId, OA, 'Resolving a dispute');
    return xo.resolveDispute(orgId, id, userId, outcome, note);
  },

  /** Public, from a portal page: a signed-in counterparty disputes the issued receipt behind the token. */
  async disputeByToken(token: string, input: { name: string; reason: string }) {
    await wait(250, 500);
    return xo.disputeByToken(token, input);
  },

  /** Public: whether the record behind a portal token is an issued receipt, and its dispute or revocation. */
  async standingByToken(token: string) {
    await wait(40, 90);
    return copy(xo.standingByToken(token));
  },

  /** Revoked, disputed, waiting-for-a-second-person and replayed counts for the register. */
  async crossOrgStanding(orgId: string) {
    await wait(40, 90);
    return xo.standingCounts(orgId);
  },

  /* ── Autonomy: breaches and cooldowns ── */

  /** autonomy_breach incidents with the graduations each revoked automatically, and the 30-day cooldowns running now. */
  async autonomyBreaches(orgId: string) {
    await wait(80, 160);
    return copy(auto.autonomyBreachesView(orgId));
  },

  /**
   * Report that an agent acted beyond its graduated autonomy (owner, admin or approver): opens an autonomy_breach
   * incident. An owner's or admin's report revokes the graduation at once; an approver's waits for an owner or
   * admin to confirm the revoke (confirmBreachRevoke).
   */
  async reportAutonomyBreach(orgId: string, input: { grantId: string; seq?: number; what: string }, userId: string) {
    await wait(300, 600);
    requireRole(orgId, userId, ['owner', 'admin', 'approver'], 'Reporting an autonomy breach');
    return copy(auto.reportBreach(orgId, input, userId));
  },

  /** An owner or admin confirms the revoke an approver's breach report asks for. */
  async confirmBreachRevoke(orgId: string, incidentId: string, userId: string) {
    await wait(250, 500);
    requireRole(orgId, userId, ['owner', 'admin'], 'Revoking a graduation');
    return copy(auto.confirmBreachRevoke(orgId, incidentId, userId));
  },
};
