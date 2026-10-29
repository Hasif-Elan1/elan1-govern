import type { AutonomyGrant, AutonomyLevel, Decision, RiskTag } from '@/types';

/**
 * Earned autonomy (L3 and Sovereign) — per agent, per tool (the action class). Autonomy is graduation only:
 * no API, setting or person sets or raises a level directly.
 *   · Starting level. When the organisation reaches L3, and when an agent is registered from L3, each of its
 *     write types starts at A2 Propose: a person approves every write. The platform writes it; nobody chooses it.
 *   · Graduation (A2 → A3, the only way up). One owner or admin proposes it and a different owner or admin
 *     approves it, only when the record for the agent and tool meets GRADUATION (≥ 90 days, ≥ 200 records,
 *     ≥ 100 approvals; shown as numbers, never a recommendation). The A3 grant starts a 30-day supervised
 *     period in which 1 in 10 calls is sampled for a person to review; after it, it is a normal A3 grant.
 *   · Revoke. Any owner or admin, alone, one press, effective at once (a receipt). The tool falls back to A2.
 *   · A4 and A5 are not yet available: listed, never reachable. A missing grant is "A0 Observe (no grant)".
 *
 * How a grant changes the guard's decision (applied after the rulebook; refusals are never relaxed). The A4
 * and A5 cases stay in the evaluator for when they become available; no grant at those levels can be written.
 *   A0 Observe        — reads only. Any call that is not read-only is refused (rule id autonomy-a0).
 *   A1 Draft          — reads and drafts run; any other allowed write is held for a person.
 *   A2 Propose        — the agent proposes; every allowed write is held for a person.
 *   A3 Act reversible — the rulebook decides unchanged.
 *   A4 Act bounded    — a held call runs without asking when it is inside the grant's bound
 *                       (e.g. amount ≤ ₹1,00,000); outside the bound it stays held.
 *   A5 Act broad      — a held call runs without asking. A refusal stays a refusal.
 */
export const AUTONOMY_LEVELS: { id: AutonomyLevel; name: string; label: string; description: string }[] = [
  { id: 'A0', name: 'Observe', label: 'A0 Observe', description: 'Reads only. Every write is refused.' },
  { id: 'A1', name: 'Draft', label: 'A1 Draft', description: 'Reads and drafts. Other writes are held for a person.' },
  { id: 'A2', name: 'Propose', label: 'A2 Propose', description: 'Proposes every write; a person approves each one.' },
  { id: 'A3', name: 'Act reversible', label: 'A3 Act reversible', description: 'Acts where the rulebook allows. Held calls stay held.' },
  { id: 'A4', name: 'Act bounded', label: 'A4 Act bounded', description: 'Held calls inside the granted bound run without asking.' },
  { id: 'A5', name: 'Act broad', label: 'A5 Act broad', description: 'Held calls run without asking. Refusals stay refusals.' },
];

export const NO_GRANT_LABEL = 'A0 Observe (no grant)';

/** Levels listed on the ladder but not reachable by any path (not yet available). */
export const UNAVAILABLE_LEVELS: AutonomyLevel[] = ['A4', 'A5'];
export const isAvailableLevel = (level: AutonomyLevel) => !UNAVAILABLE_LEVELS.includes(level);
export const NOT_YET_AVAILABLE = 'Not yet available';

/** The level every write type starts at from L3, set by the platform (not a grant a person makes). */
export const START_LEVEL: AutonomyLevel = 'A2';

/** Graduation, the only way up: A2 → A3 for one agent and tool, two people, on the record. */
export const GRADUATION = {
  from: 'A2' as AutonomyLevel,
  to: 'A3' as AutonomyLevel,
  minDays: 90,
  minRecords: 200,
  minApprovals: 100,
  supervisedDays: 30,
  /** 1 in `sampleEvery` calls during the supervised period is sampled for a person to review */
  sampleEvery: 10,
} as const;

export interface GraduationCheck { id: 'days' | 'records' | 'approvals'; label: string; value: number; need: number; met: boolean }

/** The three thresholds as numbers, met or not met. */
export function graduationChecks(e: { days: number; records: number; approvals: number }): GraduationCheck[] {
  return [
    { id: 'days', label: 'Days of operation', value: e.days, need: GRADUATION.minDays, met: e.days >= GRADUATION.minDays },
    { id: 'records', label: 'Records', value: e.records, need: GRADUATION.minRecords, met: e.records >= GRADUATION.minRecords },
    { id: 'approvals', label: 'Approvals', value: e.approvals, need: GRADUATION.minApprovals, met: e.approvals >= GRADUATION.minApprovals },
  ];
}

/** true while a graduated grant is in its supervised period at time t. */
export const isSupervised = (g: Pick<AutonomyGrant, 'supervisedUntil' | 'revokedAt'> | undefined, t = Date.now()) =>
  !!g?.supervisedUntil && !g.revokedAt && new Date(g.supervisedUntil).getTime() > t;

/** true for a call's tags that only read (reads run at every level, A0 included). */
export const isReadOnly = (tags: RiskTag[]) => tags.length > 0 && tags.every((t) => t === 'reads_data' || t === 'personal_data') && tags.includes('reads_data');

export function autonomyLabel(level: AutonomyLevel | undefined, hasGrant = true) {
  if (!level || !hasGrant) return NO_GRANT_LABEL;
  return AUTONOMY_LEVELS.find((l) => l.id === level)!.label;
}

export function autonomyRank(level: AutonomyLevel) {
  return Number(level.slice(1));
}

/** The grant in force for an agent and tool at time t (latest unrevoked, unexpired). */
export function grantFor(grants: AutonomyGrant[], agentSlug: string, tool: string, t = Date.now()): AutonomyGrant | undefined {
  return grants
    .filter((g) => g.agentSlug === agentSlug && g.tool === tool && new Date(g.grantedAt).getTime() <= t && (!g.revokedAt || new Date(g.revokedAt).getTime() > t) && (!g.expiresAt || new Date(g.expiresAt).getTime() > t))
    .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt))
    .pop();
}

export interface AutonomyEffect {
  level: AutonomyLevel;
  hasGrant: boolean;
  decision: Decision;
  changed: boolean;
  ruleId?: string;
  reason?: string;
}

/** Apply the autonomy grant to a rulebook decision. Pure; documented above. */
export function applyAutonomy(decision: Decision, grant: AutonomyGrant | undefined, call: { tool: string; tags: RiskTag[]; args: Record<string, unknown> }): AutonomyEffect {
  const level: AutonomyLevel = grant?.level ?? 'A0';
  const hasGrant = !!grant;
  const readOnly = isReadOnly(call.tags);
  const isDraft = /draft|list|read|get|search|verify/i.test(call.tool.split('.').pop() ?? '');
  if (decision === 'refuse') return { level, hasGrant, decision, changed: false };
  switch (level) {
    case 'A0':
      if (readOnly) return { level, hasGrant, decision, changed: false };
      return { level, hasGrant, decision: 'refuse', changed: true, ruleId: 'autonomy-a0', reason: hasGrant ? 'Autonomy A0 Observe: this agent may only read.' : `${NO_GRANT_LABEL}: no person has granted this agent autonomy for ${call.tool}.` };
    case 'A1':
      if (decision === 'allow' && !readOnly && !isDraft) return { level, hasGrant, decision: 'ask', changed: true, ruleId: 'autonomy-a1', reason: 'Autonomy A1 Draft: writes other than drafts are held for a person.' };
      return { level, hasGrant, decision, changed: false };
    case 'A2':
      if (decision === 'allow' && !readOnly) return { level, hasGrant, decision: 'ask', changed: true, ruleId: 'autonomy-a2', reason: 'Autonomy A2 Propose: a person approves every write.' };
      return { level, hasGrant, decision, changed: false };
    case 'A3':
      return { level, hasGrant, decision, changed: false };
    case 'A4': {
      if (decision !== 'ask') return { level, hasGrant, decision, changed: false };
      const field = grant?.bound?.field ?? 'amount';
      const v = Number(call.args[field]);
      const within = grant?.bound ? Number.isFinite(v) && v <= grant.bound.max : call.args[field] === undefined;
      if (within) return { level, hasGrant, decision: 'allow', changed: true, ruleId: 'autonomy-a4', reason: grant?.bound ? `Autonomy A4 Act bounded: ${field} is within the granted bound of ${grant.bound.max.toLocaleString('en-IN')}.` : 'Autonomy A4 Act bounded: no bounded field in this call.' };
      return { level, hasGrant, decision, changed: false };
    }
    case 'A5':
      if (decision === 'ask') return { level, hasGrant, decision: 'allow', changed: true, ruleId: 'autonomy-a5', reason: 'Autonomy A5 Act broad: held calls run without asking.' };
      return { level, hasGrant, decision, changed: false };
  }
}

/* ── Revocation: cooldown and automatic revocation on a breach ─────────── */

/** After a graduation is revoked (by a person or by a breach), the write type cannot be proposed again for this long. */
export const COOLDOWN_DAYS = 30;

export interface Cooldown { grantId: string; revokedAt: string; revokedBy?: string; until: string; automatic: boolean }

/** The cooldown running for an agent and tool at time t: the latest revoked graduation, if revoked under 30 days ago. */
export function cooldownFor(grants: AutonomyGrant[], agentSlug: string, tool: string, t = Date.now()): Cooldown | undefined {
  const g = grants
    .filter((x) => x.agentSlug === agentSlug && x.tool === tool && x.origin === 'graduation' && x.revokedAt)
    .sort((a, b) => a.revokedAt!.localeCompare(b.revokedAt!))
    .pop();
  if (!g) return undefined;
  const until = new Date(g.revokedAt!).getTime() + COOLDOWN_DAYS * 864e5;
  if (until <= t) return undefined;
  return { grantId: g.id, revokedAt: g.revokedAt!, revokedBy: g.revokedBy, until: new Date(until).toISOString(), automatic: g.revokedBy === 'system' };
}

/* ── Precedent score: information shown beside the three numbers ──────── */

export const PRECEDENT_SCORE_VERSION = 'precedent-score/1';

export interface PrecedentScore { score: number; version: string; approvedShare: number; reversalPenalty: number; decided: number }

/**
 * A number from 0 to 100 that summarises how people decided this write type: the share of decided approvals that
 * were approved (rejections count against), less 5 points for each reversal. Information only — it is not a
 * threshold, it does not change eligibility (the three checks do) and it is never a recommendation.
 */
export function precedentScore(e: { approvals: number; rejections: number; reversals: number }): PrecedentScore {
  const decided = e.approvals + e.rejections;
  const approvedShare = decided ? e.approvals / decided : 0;
  const reversalPenalty = 5 * e.reversals;
  const score = decided ? Math.max(0, Math.min(100, Math.round(100 * approvedShare - reversalPenalty))) : 0;
  return { score, version: PRECEDENT_SCORE_VERSION, approvedShare, reversalPenalty, decided };
}

/** The next level reachable from `level`: only A2 → A3 (by graduation). Nothing else moves up. */
export function nextAutonomy(level: AutonomyLevel): AutonomyLevel | undefined {
  return level === GRADUATION.from ? GRADUATION.to : undefined;
}
