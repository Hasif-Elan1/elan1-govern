/**
 * The obligations calendar behind Today's due-dates panel: every dated obligation the organisation has, from its own
 * records — assessment reviews, key rotations and agent-key expiries, regulatory pack pilots, DPDP erasure deadlines,
 * approval expiries, the end of autonomy supervision, CERT-In report deadlines, emergency access and planned maintenance.
 */
import { api } from '@/api';
import type { LevelId, PackId } from '@/types';
import { pilotView } from '@/mock/packsFactory';
import { atLeast } from '@/lib/levels';
import { userName } from '@/mock/users';
import { nextMaintenance } from '@/mock/opsMaintenance';
import { isSovereign } from '@/mock/sovereign';
import { incidents as loadIncidents } from '@/features/work/backend';

const D = 86_400_000;

export type DueKind = 'assessment' | 'key' | 'pack' | 'erasure' | 'approval' | 'supervision' | 'certin' | 'break_glass' | 'maintenance';

export interface DueItem {
  id: string;
  kind: DueKind;
  title: string;
  detail: string;
  at: string;
  to: string;
  /** a legal or regulatory clock (erasure, CERT-In) rather than housekeeping */
  statutory?: boolean;
}

export const DUE_LABEL: Record<DueKind, string> = {
  assessment: 'Assessment review',
  key: 'Key',
  pack: 'Pack pilot',
  erasure: 'Erasure deadline',
  approval: 'Approval expiry',
  supervision: 'Supervision ends',
  certin: 'CERT-In report',
  break_glass: 'Emergency access',
  maintenance: 'Maintenance',
};

export async function dueDates(orgId: string, level: LevelId, horizonDays = 45): Promise<DueItem[]> {
  const now = Date.now();
  const until = now + horizonDays * D;
  const inWindow = (iso?: string, back = 14) => !!iso && new Date(iso).getTime() <= until && new Date(iso).getTime() >= now - back * D;
  const out: DueItem[] = [];

  const [inventory, agents, approvals, erasures, packs, custody, supervision] = await Promise.all([
    api.inventory(orgId).catch(() => []),
    api.agents(orgId).catch(() => []),
    api.approvals(orgId).catch(() => []),
    api.erasures(orgId).catch(() => undefined),
    api.packs(orgId).catch(() => []),
    atLeast(level, 'l2') ? api.custody(orgId).catch(() => undefined) : Promise.resolve(undefined),
    atLeast(level, 'l3') ? api.supervision(orgId).catch(() => []) : Promise.resolve([]),
  ]);

  for (const s of inventory) {
    if (inWindow(s.nextReview, 30)) out.push({ id: `as_${s.id}`, kind: 'assessment', title: `Review the assessment of ${s.name}`, detail: `${s.riskTier} risk · owner ${userName(s.ownerId)}`, at: s.nextReview!, to: `/inventory/${s.id}` });
  }
  if (custody?.rotation.nextDueAt && inWindow(custody.rotation.nextDueAt, 30)) {
    out.push({ id: 'key_rotation', kind: 'key', title: `Rotate the signing key (${custody.provider})`, detail: custody.rotation.policy, at: custody.rotation.nextDueAt, to: '/agents/keys' });
  }
  for (const a of agents) {
    for (const k of a.keys ?? []) {
      if (!k.revoked && inWindow(k.expiresAt, 7)) out.push({ id: `ak_${a.slug}_${k.id}`, kind: 'key', title: `Agent key ${k.prefix}… for ${a.slug} expires`, detail: `${k.environment} · ${k.label}. Issue a new key before it stops working.`, at: k.expiresAt!, to: `/agents/${a.slug}` });
    }
  }
  // regulatory pack pilots: the dated steps of each running pilot (src/lib/packs.ts PILOT_STEPS, from its start)
  for (const p of packs.filter((x) => x.installed)) {
    let pilot: ReturnType<typeof pilotView>;
    try { pilot = pilotView(orgId, p.id as PackId); } catch { pilot = undefined; }
    if (!pilot || pilot.status !== 'running') continue;
    const pending = pilot.steps.filter((s) => s.id !== 'operation' && (s.state === 'open' || s.state === 'waiting'));
    const nextStep = pending[0];
    const close = pilot.steps.find((s) => s.id === 'gd' && s.state !== 'done');
    for (const s of [nextStep, close].filter((x, i, a): x is NonNullable<typeof x> => !!x && a.indexOf(x) === i)) {
      if (!inWindow(s.plannedAt, 14)) continue;
      out.push({
        id: `pk_${p.id}_${s.id}`, kind: 'pack', title: `${p.name} pilot, day ${s.day}: ${s.title}`,
        detail: `${s.id === 'gd' ? 'The answer closes the pilot. ' : ''}With ${pilot.auditor.name}, ${pilot.auditor.firm} · day ${pilot.day} of the pilot now`,
        at: s.plannedAt, to: `/records/packs/${p.id}`,
      });
    }
  }
  for (const e of erasures?.requests ?? []) {
    if (e.status === 'executed' || e.status === 'rejected') continue;
    out.push({ id: `er_${e.id}`, kind: 'erasure', title: `Erasure ${e.subjectRef}: 72-hour deadline`, detail: `${e.approvals.length} of ${e.required} approvals · ${e.affected} sealed records`, at: e.dueAt, to: '/records/erasure', statutory: true });
  }
  approvals.filter((a) => a.status === 'pending').sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).slice(0, 6)
    .forEach((a) => out.push({ id: `ap_${a.id}`, kind: 'approval', title: a.headline, detail: `${a.approverGroup} · an expiry is a refusal`, at: a.expiresAt, to: `/approvals/${a.id}` }));
  for (const s of supervision.filter((x) => x.active)) {
    out.push({ id: `sv_${s.grant.id}`, kind: 'supervision', title: `${s.grant.agentSlug} on ${s.grant.tool}: supervised period ends`, detail: `${s.reviewed} of ${s.sampled.length} sampled calls reviewed${s.concerns ? ` · ${s.concerns} concerns` : ''}`, at: s.endsAt, to: `/agents/autonomy?agent=${s.grant.agentSlug}` });
  }
  const incidents = await loadIncidents(orgId).catch(() => []);
  for (const c of api.ops.certInAll(orgId)) {
    if (c.submittedAt || c.notReportable) continue;
    const inc = incidents.find((i) => i.id === c.incidentId);
    out.push({ id: `ci_${c.incidentId}`, kind: 'certin', title: `Report to CERT-In: ${inc?.title ?? c.incidentId}`, detail: 'Six hours from notice. The incident stays open until it is recorded.', at: c.dueAt, to: `/incidents/${c.incidentId}`, statutory: true });
  }
  for (const b of api.ops.breakGlassList(orgId).filter((x) => x.status === 'active' && x.expiresAt)) {
    out.push({ id: `bg_${b.id}`, kind: 'break_glass', title: `Emergency access for ${userName(b.forUser)} ends`, detail: `Approved by ${userName(b.approvedBy)} · ${b.minutes} minutes`, at: b.expiresAt!, to: '/agents/organisation?tab=sessions' });
  }
  // Elan1's hosted maintenance: a Sovereign deployment runs its own updates and is never in Elan1's windows
  // (mock/tenantNotices.ts sends it no maintenance either)
  const mw = level === 'sovereign' || isSovereign(orgId) ? undefined : nextMaintenance();
  if (mw && inWindow(mw.from)) out.push({ id: `mw_${mw.id}`, kind: 'maintenance', title: `Planned maintenance: ${mw.title}`, detail: mw.note, at: mw.from, to: '/status' });

  return out.sort((a, b) => a.at.localeCompare(b.at));
}
