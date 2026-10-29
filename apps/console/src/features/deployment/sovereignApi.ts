/**
 * Sovereign deployment calls (deny-all egress, local status, the meter on media, rollback). Served from
 * src/mock/sovereign.ts with a short latency so loading states are real; a backend replaces these bodies.
 */
import * as sov from '@/mock/sovereign';

const wait = (min = 150, max = 350) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

export const sovereignApi = {
  async egress(orgId: string, days: number) { await wait(); return { log: sov.egressLog(orgId, days), hosts: sov.internalHosts(orgId), blocked24h: sov.blockedInLast(orgId, 24) }; },
  async addHost(orgId: string, host: string, purpose: string, userId: string) { await wait(250, 450); return sov.addInternalHost(orgId, host, purpose, userId); },
  async removeHost(orgId: string, host: string, userId: string) { await wait(250, 450); return sov.removeInternalHost(orgId, host, userId); },
  async exportEgress(orgId: string, days: number, userId: string) { await wait(300, 600); return sov.exportEgressLog(orgId, days, userId); },
  async localStatus(orgId: string) { await wait(300, 600); return sov.localStatus(orgId); },
  async statements(orgId: string) { await wait(); return { statements: sov.usageStatements(orgId), periods: sov.statementPeriods() }; },
  async preview(orgId: string, periodId: string) { await wait(100, 200); const p = sov.statementPeriods().find((x) => x.id === periodId); if (!p) throw new Error('Choose a period.'); return sov.meterFor(orgId, p.from, p.to); },
  async exportStatement(orgId: string, periodId: string, media: string, userId: string) { await wait(500, 900); return sov.exportUsageStatement(orgId, periodId, media, userId); },
  async handover(orgId: string, id: string, to: string, ref: string, userId: string) { await wait(250, 450); return sov.recordHandover(orgId, id, to, ref, userId); },
  async rollback(orgId: string, id: string, reason: string, userId: string) { await wait(900, 1400); return sov.rollbackUpdate(orgId, id, reason, userId); },
  async rollbacks(orgId: string) { await wait(); return sov.rollbacks(orgId); },
};

/** Synchronous checks the screens use before they try to reach a destination. */
export const egressCheck = sov.checkDestination;
export const egressGuard = sov.guardDestination;
export const isSovereignOrg = sov.isSovereign;
