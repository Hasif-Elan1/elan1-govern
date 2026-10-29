/**
 * AI system changes the shared API has no call for yet: edit details, move the lifecycle, retire, and keep
 * the residency and DPDP data-principal details. Each runs against the organisation's database the way the
 * API does and writes a signed admin receipt; a real backend replaces this file without touching the screens.
 */
import type { AiSystem, Lifecycle } from '@/types';
import { db } from '@/api';
import { doorState, pause, clone, recordChange, type AiSystemExtra } from '@/features/records/ext';
import { variantOf } from '@/features/assessments/templates';
import { LIFECYCLE_META, LIFECYCLE_ORDER } from './governance';

/** Owners and admins of the organisation only (their member record decides: suspended or removed people cannot). */
function requireManager(orgId: string, userId: string) {
  const role = db.memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins can do this; your role cannot.');
}

/**
 * Does this AI system have a risk assessment a different person approved? Pack-admission assessments do not
 * count: they admit a pack and set no risk tier.
 */
export function hasApprovedRiskAssessment(orgId: string, aiSystemId: string): boolean {
  return db.getDB(orgId).assessments.some((a) => a.aiSystemId === aiSystemId && a.status === 'approved' && variantOf(a).kind !== 'admission');
}

export const RESIDENCIES = ['India — ap-south-1 Mumbai', 'India — ap-south-2 Hyderabad', 'India — on premises', 'European Union', 'United Kingdom', 'United States', 'Several regions'];
export const PRINCIPALS = ['Customers', 'Employees', 'Job applicants', 'Patients', 'Borrowers', 'Vendor contacts', 'Children'];

export function extraOf(orgId: string, id: string): AiSystemExtra | undefined {
  return doorState(orgId).aiExtra[id];
}

/** Store residency and personal-data details for a system without a receipt of its own (used right after a registration receipt). */
export function setExtraQuietly(orgId: string, id: string, extra: Omit<AiSystemExtra, 'updatedAt'>) {
  doorState(orgId).aiExtra[id] = { ...extra, updatedAt: new Date().toISOString() };
  db.touch(orgId, 'inventory');
}

type Patch = Partial<Pick<AiSystem, 'name' | 'kind' | 'vendor' | 'purpose' | 'ownerId' | 'businessUnit' | 'dataCategories' | 'affectedPeople' | 'decisionImpact' | 'linkedAgentId' | 'frameworks' | 'modelName' | 'modelVersion'>>;

export async function updateAiSystem(orgId: string, id: string, patch: Patch, extra: Omit<AiSystemExtra, 'updatedAt'> | undefined, userId: string) {
  await pause(250, 500);
  requireManager(orgId, userId);
  const d = db.getDB(orgId);
  const s = d.aiSystems.find((x) => x.id === id);
  if (!s) throw new Error('No such AI system.');
  if (patch.linkedAgentId && d.aiSystems.some((x) => x.id !== id && x.linkedAgentId === patch.linkedAgentId)) throw new Error('That agent is already linked to another AI system.');
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof Patch, unknown][]) {
    if (JSON.stringify((s as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) { changed.push(k); (s as unknown as Record<string, unknown>)[k] = v; }
  }
  if ('linkedAgentId' in patch && !patch.linkedAgentId) delete s.linkedAgentId;
  if (extra) {
    const prev = doorState(orgId).aiExtra[id];
    if (!prev || prev.residency !== extra.residency || prev.personalData !== extra.personalData || prev.principals.join() !== extra.principals.join()) changed.push('residency_and_personal_data');
    doorState(orgId).aiExtra[id] = { ...extra, updatedAt: new Date().toISOString() };
  }
  if (!changed.length) return clone(s);
  recordChange(orgId, userId, 'inventory.updated', { system: s.name, fields: changed.join(','), ...(extra ? { residency: extra.residency, personal_data: extra.personalData } : {}), ...(changed.includes('modelName') || changed.includes('modelVersion') ? { model: s.modelName ?? '', model_version: s.modelVersion ?? '' } : {}) });
  return clone(s);
}

/** The next stage forward, or undefined when live or retired. */
export function nextStage(stage: Lifecycle): Lifecycle | undefined {
  if (stage === 'live' || stage === 'retired') return undefined;
  return LIFECYCLE_ORDER[LIFECYCLE_ORDER.indexOf(stage) + 1];
}

/** Why a move is not allowed yet, or undefined. Approved and Live need an approved assessment. */
export function lifecycleBlock(to: Lifecycle, hasApprovedAssessment: boolean): string | undefined {
  if ((to === 'approved' || to === 'live') && !hasApprovedAssessment) return `${LIFECYCLE_META[to].label} needs an assessment a different person has approved.`;
  return undefined;
}

/**
 * Move an AI system's lifecycle. Approved and Live need an approved risk assessment, read here from the
 * organisation's assessments (`_clientClaim` is what the screen believes and is ignored).
 */
export async function setLifecycle(orgId: string, id: string, to: Lifecycle, reason: string, _clientClaim: boolean, userId: string) {
  await pause(250, 500);
  requireManager(orgId, userId);
  const s = db.getDB(orgId).aiSystems.find((x) => x.id === id);
  if (!s) throw new Error('No such AI system.');
  if (s.lifecycle === 'retired') throw new Error('This system is retired. Register it again to bring it back.');
  if (to !== 'retired' && LIFECYCLE_ORDER.indexOf(to) <= LIFECYCLE_ORDER.indexOf(s.lifecycle)) throw new Error('A lifecycle moves forward, one stage at a time; retire it instead.');
  if (to !== 'retired' && to !== nextStage(s.lifecycle)) throw new Error(`The next stage is ${LIFECYCLE_META[nextStage(s.lifecycle)!].label}.`);
  const block = lifecycleBlock(to, hasApprovedRiskAssessment(orgId, id));
  if (block) throw new Error(block);
  if (to === 'retired' && reason.trim().length < 4) throw new Error('Say why it is retired.');
  const from = s.lifecycle;
  s.lifecycle = to;
  recordChange(orgId, userId, to === 'retired' ? 'inventory.retired' : 'inventory.lifecycle_changed', { system: s.name, from, to, ...(reason.trim() ? { reason: reason.trim() } : {}) });
  return clone(s);
}
