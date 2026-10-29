/**
 * The pack factory API (spread into `api`): the portfolio register, pack gates and tests, the 90-day pilot,
 * the two-way reconciliation, the verifier-profile lifecycle and the profile entitlement. Served from
 * mock/packsFactory.ts; every write is an admin receipt on the chain.
 */
import type { PackId } from '@/types';
import * as pf from '@/mock/packsFactory';
import { packById, type GateFacts } from '@/lib/packs';

const wait = (min = 90, max = 260) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const copy = <T,>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

export const packsFactoryApi = {
  /** The portfolio register: live packs, candidates (with gates evaluated from their facts), admitted and rejected packs. PackCandidate[]. */
  async packPortfolio(orgId: string) { await wait(); pf.ensureSeed(orgId); return copy(pf.portfolio(orgId)); },
  /** Propose a candidate pack (owner/admin): the gates are scored from the facts. Writes pack.candidate_proposed. */
  async proposePackCandidate(orgId: string, input: { name: string; domain: string; facts: GateFacts }, userId: string) { await wait(300, 600); return copy(pf.proposeCandidate(orgId, input, userId)); },
  /** Admit a candidate (dual control: never its proposer); names the declaration owner, profile author and issuer. Writes pack.candidate_admitted. */
  async admitPackCandidate(orgId: string, id: string, userId: string, team: { declarationOwner: string; profileAuthor: string; profileCertifier: string }, note: string) { await wait(300, 600); return copy(pf.admitCandidate(orgId, id, userId, team, note)); },
  /** Reject a candidate into the register with its failed gate and the sentence. Writes pack.candidate_rejected. */
  async rejectPackCandidate(orgId: string, id: string, userId: string, sentence: string, revisit: string) { await wait(300, 600); return copy(pf.rejectCandidate(orgId, id, userId, sentence, revisit)); },

  /** Everything the pack page's eleven blocks need beyond api.pack: gates, tests, pilot, reconciliations, drills, reading, entitlement, removals. */
  async packFactory(orgId: string, packId: PackId) {
    await wait(60, 160);
    pf.ensureSeed(orgId);
    const pk = packById(packId);
    return copy({
      gates: pf.packGates(orgId, packId), tests: pf.evaluateTests(orgId, packId), lastTestRun: pf.lastTestRun(orgId, packId), pilot: pf.pilotView(orgId, packId), earlierPilots: pf.earlierPilots(orgId, packId),
      reconciliations: pf.reconciliations(orgId, packId), drills: pf.drills(orgId, packId), reading: pf.reading(orgId, packId),
      entitlement: pk ? pf.entitlement(orgId, pk.profileId) : undefined, lifecycle: pk ? pf.profileLifecycle(orgId, pk.profileId) : undefined,
      removed: pf.removedPacks(orgId).filter((x) => x.id === packId),
    });
  },
  /** Run T1–T8 (T5–T7 run the verifier on bundles from this chain at L2+). Writes pack.tests_run. */
  async runPackTests(orgId: string, packId: PackId, userId: string) { await wait(500, 900); return copy(pf.runPackTests(orgId, packId, userId)); },
  /** Record a dated reversal drill for one write type (T3). Writes pack.reversal_drill. */
  async recordReversalDrill(orgId: string, packId: PackId, writeType: string, userId: string, note: string) { await wait(200, 400); return copy(pf.recordDrill(orgId, packId, writeType, userId, note)); },
  /** Record the named auditor's reading of a report (T8). Writes pack.auditor_reading. */
  async recordAuditorReading(orgId: string, packId: PackId, userId: string, input: { auditor: string; statement: string }) { await wait(200, 400); return copy(pf.recordReading(orgId, packId, userId, input)); },
  /** Remove a pack (owner/admin): the declaration stops; it is billed to the end of this month, not from next month. Writes pack.uninstalled (and billing.addon_cancelled when asked). */
  async uninstallPack(orgId: string, packId: PackId, userId: string, reason: string, cancelProfile: boolean) { await wait(400, 700); return copy(pf.uninstallPack(orgId, packId, userId, reason, cancelProfile)); },

  /* the 90-day pilot: a step recorded before its planned day needs `early` (the reason) and is marked early */
  async startPilot(orgId: string, packId: PackId, userId: string, input: { auditorName: string; auditorFirm: string }) { await wait(300, 600); return copy(pf.startPilot(orgId, packId, userId, input)); },
  async recordPilotNecessity(orgId: string, packId: PackId, userId: string, input: { questions: string[]; statement: string; notMeasurable: { clause: string; reason: string; wouldChangeIf: string }[] }) { await wait(300, 600); return copy(pf.recordNecessity(orgId, packId, userId, input)); },
  async recordPilotSelfExport(orgId: string, packId: PackId, userId: string, input: { exportSeq: number; receipts: number; firstSeq: number; lastSeq: number; help: boolean; note: string; early?: string }) { await wait(200, 400); return copy(pf.recordSelfExport(orgId, packId, userId, input)); },
  /** Day 77: verify the customer's own day-76 bundle (the file they exported; its digest must match the export receipt) and a tampered copy. */
  async recordPilotAirGap(orgId: string, packId: PackId, userId: string, input: { bundle: unknown; fileName?: string; early?: string }) { await wait(500, 900); return copy(pf.recordAirGap(orgId, packId, userId, input)); },
  async recordPilotVerdict(orgId: string, packId: PackId, userId: string, input: { auditor: string; outcome: 'relies' | 'relies_with_limits' | 'does_not_rely'; words: string; early?: string }) { await wait(300, 600); return copy(pf.recordVerdict(orgId, packId, userId, input)); },
  async recordPilotGd(orgId: string, packId: PackId, userId: string, input: { answer: 'yes' | 'no'; note: string; early?: string }) { await wait(300, 600); return copy(pf.recordGd(orgId, packId, userId, input)); },
  async stopPilot(orgId: string, packId: PackId, userId: string, reason: string) { await wait(300, 600); return copy(pf.stopPilot(orgId, packId, userId, reason)); },

  /** Two-way reconciliation against the target system's own audit trail (its connector, or an uploaded CSV). Writes pack.reconciled. */
  async reconcilePack(orgId: string, packId: PackId, userId: string, input: { days: number; csv?: string }) { await wait(500, 900); return copy(pf.reconcile(orgId, packId, userId, input)); },
  async explainReconException(orgId: string, reconId: string, key: string, userId: string, note: string) { await wait(200, 400); return copy(pf.explainException(orgId, reconId, key, userId, note)); },

  /* verifier-profile lifecycle and entitlement */
  /** { status, author, issuer, P1–P12 results, entitlement, eligible issuers }. */
  async profileLifecycle(orgId: string, profileId: string) { await wait(); pf.ensureSeed(orgId); return copy(pf.profileLifecycle(orgId, profileId)); },
  async submitProfile(orgId: string, profileId: string, userId: string) { await wait(300, 600); return copy(pf.submitProfile(orgId, profileId, userId)); },
  async recordProfileSecondReader(orgId: string, profileId: string, userId: string, statement: string) { await wait(300, 600); return copy(pf.recordSecondReader(orgId, profileId, userId, statement)); },
  async runProfileFixtures(orgId: string, profileId: string, userId: string) { await wait(600, 1000); return copy(pf.runProfileFixtures(orgId, profileId, userId)); },
  async issueProfile(orgId: string, profileId: string, userId: string) { await wait(300, 600); return copy(pf.issueProfile(orgId, profileId, userId)); },
  async withdrawProfile(orgId: string, profileId: string, userId: string, reason: string) { await wait(300, 600); return copy(pf.withdrawProfile(orgId, profileId, userId, reason)); },
  /** Order a verifier profile (owner, L2+): ₹3,00,000 a year on its own line. Writes billing.addon_ordered. */
  async orderProfile(orgId: string, profileId: string, userId: string) { await wait(300, 600); return copy(pf.orderProfile(orgId, profileId, userId)); },
  async cancelProfileOrder(orgId: string, profileId: string, userId: string) { await wait(300, 600); return copy(pf.cancelProfileOrder(orgId, profileId, userId)); },
};
