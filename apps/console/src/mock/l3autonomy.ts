/**
 * Earned autonomy extras (L3): automatic revocation on a breach, and the 30-day cooldown that follows any revocation.
 *
 * An autonomy_breach incident — opened by a person here ("Report a breach"), declared by hand, or opened by the
 * assurance checks — revokes the graduated (A3) grants of the agent it names, at once, by the platform (actor
 * "system"), one autonomy.revoked receipt each with automatic: true. One reported by an approver waits for an
 * owner or admin to confirm the revoke (confirmBreachRevoke), since revoking is theirs (autonomy.grant). The write type falls back to A2 Propose and
 * cannot be proposed again for 30 days (lib/autonomy.ts cooldownFor; enforced in graduationCandidates).
 * Graduation itself is unchanged: three checks, two people, a 30-day supervised period sampled after the call runs.
 */
import type { AutonomyGrant, AutonomyLevel, Incident } from '@/types';
import { getDB, peekDB, append, touch, subscribe, flavourFor, type OrgDB } from './db';
import { personFor, userName } from './users';
import { COOLDOWN_DAYS, GRADUATION, cooldownFor, grantFor, type Cooldown } from '@/lib/autonomy';
import { D, clone, iso, isL3, l3ext, requireL3, requireRoles } from './l3state';

/**
 * `awaitingRevoke`: reported by an approver, who may report a breach but not revoke a graduation (autonomy.grant
 * is owners and admins). Nothing is revoked until an owner or admin confirms; `revokeConfirmedBy` names them.
 * Both optional: incidents saved before this read as revoke-at-once.
 */
type BreachIncident = Incident & { subkind?: string; breach?: { agentSlug: string; tool?: string; seq?: number; awaitingRevoke?: boolean; revokeConfirmedBy?: string }; checksDone?: string[]; resolutionNote?: string };

const isBreach = (i: Incident) => (i as BreachIncident).subkind === 'autonomy_breach';

/** The agent and tool an autonomy_breach incident names (from the report, the incident's agents, or its alert id). */
function targetOf(db: OrgDB, inc: BreachIncident): { agentSlug?: string; tool?: string; fromDetector?: boolean } {
  if (inc.breach) return inc.breach;
  if (inc.agentSlugs?.length) return { agentSlug: inc.agentSlugs[0] };
  // opened by the assurance check "Beyond its autonomy": its alert id is as_auto_<agent>_<tool with dots as _>_<date>
  const alertId = (inc as { alertId?: string }).alertId ?? '';
  const a = db.agents.find((x) => alertId.startsWith(`as_auto_${x.slug}_`));
  if (!a) return { fromDetector: !!alertId };
  const rest = alertId.slice(`as_auto_${a.slug}_`.length);
  const tool = [...a.tools].sort((p, q) => q.length - p.length).find((t) => rest.startsWith(`${t.replace(/\./g, '_')}_`));
  return { agentSlug: a.slug, tool, fromDetector: true };
}

/** Revoke what open autonomy_breach incidents name, once per incident. Returns the grants revoked now. */
export function enforceAutonomyBreaches(orgId: string): AutonomyGrant[] {
  const db = getDB(orgId);
  if (!isL3(db)) return [];
  ensureSeed(db);
  const x = l3ext(db);
  const done = (x.autoRevoked ??= {});
  const revoked: AutonomyGrant[] = [];
  let changed = false;
  for (const inc of db.incidents as BreachIncident[]) {
    if (!isBreach(inc) || inc.status !== 'active' || done[inc.id] || inc.breach?.awaitingRevoke) continue;
    changed = true;
    const t = targetOf(db, inc);
    const now = Date.now();
    // an incident from the assurance check names one tool; without it nothing is revoked (never every grant of the agent)
    const grants = t.fromDetector && !t.tool ? [] : db.platform.grants.filter((g) => g.origin === 'graduation' && !g.revokedAt && !!t.agentSlug && g.agentSlug === t.agentSlug && (!t.tool || g.tool === t.tool) && new Date(g.grantedAt).getTime() <= now);
    done[inc.id] = grants.map((g) => g.id);
    for (const g of grants) {
      g.revokedAt = iso(now);
      g.revokedBy = 'system';
      const back = grantFor(db.platform.grants, g.agentSlug, g.tool);
      const fallsBackTo: AutonomyLevel = back?.level ?? 'A0';
      const r = append(db, { kind: 'admin', actor: 'system', action: 'autonomy.revoked', agent: g.agentSlug, details: { tool: g.tool, level: g.level, falls_back_to: fallsBackTo, automatic: true, incident: inc.id, reason: 'autonomy breach', cooldown_days: COOLDOWN_DAYS } });
      inc.timeline.push({ ts: r.ts, text: `A3 on ${g.tool} revoked automatically; ${g.agentSlug} is back to ${fallsBackTo} for it. It can be proposed again after ${COOLDOWN_DAYS} days.`, seq: r.seq, actor: 'system' });
      revoked.push(clone(g));
    }
    if (!grants.length) {
      inc.timeline.push({
        ts: iso(now), actor: 'system',
        text: t.fromDetector && !t.tool
          ? 'The check did not name a tool, so no graduation was revoked. Review the agent’s grants by hand.'
          : t.fromDetector
            ? `${t.agentSlug} holds no graduated grant on ${t.tool}: the guard refused each attempt at A0 Observe, so there was no graduation to revoke.`
            : `${t.agentSlug ?? 'The agent'} held no graduated grant${t.tool ? ` on ${t.tool}` : ''}, so nothing was revoked.`,
      });
    }
  }
  if (changed) touch(orgId, 'autonomy');
  return revoked;
}

/*
 * Enforcement at once, not when an autonomy screen is next read: whenever an organisation's incidents or chain change
 * (an incident opened by a person, declared by hand or opened by the assurance checks), an open autonomy_breach
 * incident not yet enforced revokes its graduation straight after, before the guard decides another call at A3.
 */
const queued = new Set<string>();
function pendingBreach(orgId: string) {
  const db = peekDB(orgId);
  if (!db || !isL3(db)) return false;
  const done = l3ext(db).autoRevoked ?? {};
  return (db.incidents as BreachIncident[]).some((i) => isBreach(i) && i.status === 'active' && !done[i.id] && !i.breach?.awaitingRevoke);
}
subscribe((orgId, kind) => {
  if (kind !== 'incident' && kind !== 'receipt' && kind !== 'update') return;
  if (queued.has(orgId)) return;
  queued.add(orgId);
  setTimeout(() => {
    queued.delete(orgId);
    try { if (pendingBreach(orgId)) enforceAutonomyBreaches(orgId); } catch { /* enforcement retries on the next change or read */ }
  }, 0);
});

/**
 * A person reports that an agent acted beyond its graduated autonomy (owner, admin or approver): opens an
 * autonomy_breach incident (incident.opened). Reported by an owner or admin, the graduation is revoked
 * automatically at once. Reported by an approver, the incident asks an owner or admin to confirm the revoke
 * (confirmBreachRevoke): approvers may report, but revoking a graduation is autonomy.grant (owners and admins).
 */
export function reportBreach(orgId: string, input: { grantId: string; seq?: number; what: string }, userId: string) {
  const db = getDB(orgId);
  requireL3(db, 'Autonomy breaches');
  const role = requireRoles(orgId, userId, ['owner', 'admin', 'approver'], 'Reporting an autonomy breach');
  const canRevoke = role === 'owner' || role === 'admin';
  const g = db.platform.grants.find((x) => x.id === input.grantId && x.origin === 'graduation');
  if (!g) throw new Error('No such graduation.');
  if (g.revokedAt) throw new Error('This graduation is already revoked.');
  const what = input.what.trim();
  if (what.length < 12) throw new Error('Say what the agent did — at least a sentence. It opens an incident.');
  if (input.seq !== undefined && !db.receipts.some((r) => r.seq === input.seq)) throw new Error(`No receipt #${input.seq} in this chain.`);
  const id = `inc_ab_${Date.now().toString(36)}`;
  const r = append(db, { kind: 'admin', actor: userId, action: 'incident.opened', agent: g.agentSlug, details: { incident: id, kind: 'health', subkind: 'autonomy_breach', tool: g.tool, ...(input.seq !== undefined ? { call_seq: input.seq } : {}), reported_by: userId, revoke: canRevoke ? 'at_once' : 'awaiting_owner_or_admin' } });
  const inc: BreachIncident = {
    id, title: `${g.agentSlug} acted beyond its autonomy on ${g.tool}`, kind: 'health', subkind: 'autonomy_breach', status: 'active', scope: 'selected_agents', agentSlugs: [g.agentSlug],
    startedAt: r.ts, startedBy: userId, reason: what, refusedWhileStopped: 0, pendingApprovalsAtStop: 0,
    breach: { agentSlug: g.agentSlug, tool: g.tool, ...(input.seq !== undefined ? { seq: input.seq } : {}), ...(canRevoke ? {} : { awaitingRevoke: true }) },
    timeline: [
      { ts: r.ts, text: `Reported by ${userName(userId)}${input.seq !== undefined ? ` (receipt #${input.seq})` : ''}: ${what}`, seq: r.seq, actor: userId },
      ...(canRevoke ? [] : [{ ts: r.ts, text: `Waiting for an owner or admin to confirm revoking A3 on ${g.tool}. An approver can report a breach but not revoke a graduation.`, actor: 'system' }]),
    ],
  };
  db.incidents.unshift(inc);
  const revoked = canRevoke ? enforceAutonomyBreaches(orgId) : [];
  touch(orgId, 'incident');
  return { incident: clone(inc as Incident), revoked, awaitingRevoke: !canRevoke };
}

/**
 * An owner or admin confirms the revoke an approver's breach report asks for: the graduation is revoked at once
 * (autonomy.revoked, automatic, naming the incident) and the 30-day cooldown starts.
 */
export function confirmBreachRevoke(orgId: string, incidentId: string, userId: string) {
  const db = getDB(orgId);
  requireL3(db, 'Autonomy breaches');
  requireRoles(orgId, userId, ['owner', 'admin'], 'Revoking a graduation');
  const inc = (db.incidents as BreachIncident[]).find((i) => i.id === incidentId && isBreach(i));
  if (!inc || !inc.breach) throw new Error('No such autonomy breach.');
  if (!inc.breach.awaitingRevoke) throw new Error('This breach is not waiting for a revoke.');
  if (inc.status !== 'active') throw new Error('This incident is resolved. Revoke the graduation from the agent’s Autonomy tab if it is still needed.');
  const r = append(db, { kind: 'admin', actor: userId, action: 'autonomy.breach_revoke_confirmed', agent: inc.breach.agentSlug, details: { incident: inc.id, tool: inc.breach.tool ?? '', reported_by: inc.startedBy } });
  inc.breach.awaitingRevoke = false;
  inc.breach.revokeConfirmedBy = userId;
  inc.timeline.push({ ts: r.ts, text: `Revoke confirmed by ${userName(userId)}.`, seq: r.seq, actor: userId });
  const revoked = enforceAutonomyBreaches(orgId);
  touch(orgId, 'incident');
  return { incident: clone(inc as Incident), revoked, seq: r.seq };
}

export interface BreachRow {
  incidentId: string; title: string; status: Incident['status']; startedAt: string; startedBy: string; reason: string;
  agentSlug?: string; tool?: string; callSeq?: number;
  revoked: { grantId: string; tool: string; at?: string; seq?: number }[];
  /** reported by an approver: an owner or admin must confirm the revoke */
  awaitingRevoke?: boolean;
  revokeConfirmedBy?: string;
}

/** Autonomy breaches (incidents) with what each revoked, and every cooldown running now. */
export function autonomyBreachesView(orgId: string): { breaches: BreachRow[]; cooldowns: (Cooldown & { agentSlug: string; tool: string; incidentId?: string })[]; cooldownDays: number } {
  const db = getDB(orgId);
  if (!isL3(db)) return { breaches: [], cooldowns: [], cooldownDays: COOLDOWN_DAYS };
  enforceAutonomyBreaches(orgId);
  const done = l3ext(db).autoRevoked ?? {};
  const revokeSeq = (g: AutonomyGrant, incId: string) => db.receipts.find((r) => r.action === 'autonomy.revoked' && r.details?.incident === incId && r.details?.tool === g.tool)?.seq;
  const breaches = (db.incidents as BreachIncident[]).filter(isBreach).map((inc): BreachRow => {
    const t = targetOf(db, inc);
    return {
      incidentId: inc.id, title: inc.title, status: inc.status, startedAt: inc.startedAt, startedBy: inc.startedBy, reason: inc.reason, agentSlug: t.agentSlug, tool: t.tool, callSeq: inc.breach?.seq,
      awaitingRevoke: !!inc.breach?.awaitingRevoke && inc.status === 'active', revokeConfirmedBy: inc.breach?.revokeConfirmedBy,
      revoked: (done[inc.id] ?? []).map((gid) => { const g = db.platform.grants.find((x) => x.id === gid); return { grantId: gid, tool: g?.tool ?? '', at: g?.revokedAt, seq: g ? revokeSeq(g, inc.id) : undefined }; }),
    };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const incidentOf = (grantId: string) => Object.entries(done).find(([, ids]) => ids.includes(grantId))?.[0];
  const seen = new Set<string>();
  const cooldowns = db.platform.grants.filter((g) => g.origin === 'graduation' && g.revokedAt).flatMap((g) => {
    const k = `${g.agentSlug}|${g.tool}`;
    if (seen.has(k)) return [];
    seen.add(k);
    const c = cooldownFor(db.platform.grants, g.agentSlug, g.tool);
    return c ? [{ ...c, agentSlug: g.agentSlug, tool: g.tool, incidentId: incidentOf(c.grantId) }] : [];
  });
  return { breaches, cooldowns, cooldownDays: COOLDOWN_DAYS };
}

/* ── Seed (Deccan): a graduation revoked automatically on a breach eight days ago, now in its cooldown ── */

function ensureSeed(db: OrgDB) {
  const x = l3ext(db);
  const seeded = (x.seeded ??= {});
  if (seeded.autonomy || !isL3(db)) return;
  seeded.autonomy = true;
  if (db.org.id !== 'org_deccan') return;
  const agentSlug = flavourFor(db.org.id).slugMap['invoice-bot'] ?? 'invoice-bot';
  const tool = 'gmail.send_email';
  if (!db.agents.some((a) => a.slug === agentSlug && a.tools.includes(tool))) return;
  if (db.platform.grants.some((g) => g.agentSlug === agentSlug && g.tool === tool && g.origin === 'graduation') || db.platform.proposals.some((p) => p.agentSlug === agentSlug && p.tool === tool)) return;
  const now = Date.now();
  const owner = personFor(db.org.id, 'u_ananya');
  const admin = personFor(db.org.id, 'u_rahul');
  const approver = personFor(db.org.id, 'u_venkat');
  const gradAt = now - 31 * D;
  const breachAt = now - 8 * D;
  const propId = `gp_${agentSlug}_gmail_send_email_A3_seed`;
  db.platform.proposals.push({
    id: propId, agentSlug, tool, from: GRADUATION.from, to: GRADUATION.to, evidence: { approvals: 104, rejections: 1, reversals: 0, days: 160, records: 214, counterparties: 0, medianMinutesToDecide: 0 },
    createdAt: iso(gradAt - 2 * D), status: 'granted', required: 2, proposedBy: admin,
    decisions: [{ userId: admin, approve: true, at: iso(gradAt - 2 * D), note: 'Remittance advice to vendors from the approved template; one rejection in 104 approvals.' }, { userId: owner, approve: true, at: iso(gradAt), note: 'Checked the rejection: a wrong vendor address, since fixed.' }],
  });
  const grantId = `gr_${agentSlug}_gmail_send_email_a3_seed`.replace(/\./g, '_');
  db.platform.grants.push({
    id: grantId, agentSlug, tool, level: GRADUATION.to, grantedBy: owner, grantedAt: iso(gradAt), origin: 'graduation', graduationId: propId,
    supervisedUntil: iso(gradAt + GRADUATION.supervisedDays * D), sampleEvery: GRADUATION.sampleEvery, revokedAt: iso(breachAt + 2 * 60_000), revokedBy: 'system',
    reason: `Graduated A2 → A3: proposed by ${userName(admin)}, approved by ${userName(owner)}. Record: 160 days, 214 records, 104 approvals.`,
  });
  const incId = 'inc_ab_seed_deccan';
  const inc: BreachIncident = {
    id: incId, title: `${agentSlug} acted beyond its autonomy on ${tool}`, kind: 'health', subkind: 'autonomy_breach', status: 'resolved', scope: 'selected_agents', agentSlugs: [agentSlug],
    startedAt: iso(breachAt), startedBy: approver, reason: 'A sampled call sent remittance advice to a personal email address outside the vendor master. The rulebook allowed it; it should have been held.',
    refusedWhileStopped: 0, pendingApprovalsAtStop: 0, breach: { agentSlug, tool, revokeConfirmedBy: admin },
    resolvedAt: iso(breachAt + 2 * D), resolvedBy: admin, checksDone: ['grant', 'refused', 'owner'],
    resolutionNote: 'The rulebook now holds any email to a domain outside the vendor master. The graduation stays revoked; it can be proposed again after the cooldown.',
    timeline: [
      { ts: iso(breachAt), text: `Reported by ${userName(approver)} while reviewing a sampled call`, actor: approver },
      { ts: iso(breachAt + 60_000), text: `Revoke confirmed by ${userName(admin)}.`, actor: admin },
      { ts: iso(breachAt + 2 * 60_000), text: `A3 on ${tool} revoked automatically; ${agentSlug} is back to A2 for it. It can be proposed again after ${COOLDOWN_DAYS} days.`, actor: 'system' },
      { ts: iso(breachAt + 2 * D), text: 'Resolved: the rulebook now holds emails outside the vendor master.', actor: admin },
    ],
  };
  db.incidents.push(inc);
  (x.autoRevoked ??= {})[incId] = [grantId];
}
