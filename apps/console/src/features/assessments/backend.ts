/**
 * Assessments — backend extension.
 *
 * The shared API reads assessments (api.assessments, api.assessment) and signs them off (api.reviewAssessment),
 * but has no call to start one, answer it, submit it or reopen it. The functions below supply those over the
 * same organisation database, so a draft started in one browser is the draft every reviewer sees, and the
 * Work › Reviews queue picks up every submitted assessment. Each step writes a signed admin receipt.
 * A real backend replaces these bodies without touching a screen.
 */
import { api, db } from '@/api';
import type { AiSystem, Assessment, PackId, RiskTier } from '@/types';
import { userById } from '@/mock/users';
import { can } from '@/lib/permissions';
import { atLeast } from '@/lib/levels';
import { PACKS } from '@/lib/packs';
import { VARIANTS, admissionOf, newAssessmentFromTemplate, nextReviewDate, optionsFor, summarise, variantOf, type VariantId } from './templates';

const wait = (min = 80, max = 220) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export type ExtAssessment = Assessment & { variant?: VariantId; packId?: PackId; submittedSeq?: number; reviewSeq?: number; startedSeq?: number; admittedSeq?: number; /** admitted below L2, as a dry run */ dryRun?: boolean; /** who pressed Submit; older records lack it (the author is checked then) */ submittedBy?: string };

/** The caller's role is the one their member record holds in this organisation now (suspended or removed: none). */
function requirePerm(orgId: string, userId: string, perm: 'assessments.author' | 'assessments.signoff', what: string) {
  const u = userById(userId);
  if (!u || !can(db.memberRole(orgId, userId), perm)) throw new Error(`${what} Your role cannot do this.`);
  return u;
}

function list(orgId: string): ExtAssessment[] {
  migrateLegacy(orgId);
  return db.getDB(orgId).assessments as ExtAssessment[];
}

function find(orgId: string, id: string): ExtAssessment {
  const a = list(orgId).find((x) => x.id === id);
  if (!a) throw new Error('No such assessment. It may have been discarded or belong to another organisation.');
  return a;
}

function systemOf(orgId: string, id: string): AiSystem | undefined {
  return db.getDB(orgId).aiSystems.find((s) => s.id === id);
}

/* ── One-time import of drafts kept in a browser by the earlier build ── */

const LEGACY_KEY = 'eg:gov-local-assessments';
const migrated = new Set<string>();

function migrateLegacy(orgId: string) {
  if (migrated.has(orgId)) return;
  migrated.add(orgId);
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const byOrg = JSON.parse(raw) as Record<string, Assessment[]>;
    const mine = byOrg[orgId];
    if (!mine?.length) return;
    const d = db.getDB(orgId);
    for (const a of mine) {
      const i = d.assessments.findIndex((x) => x.id === a.id);
      if (i >= 0) d.assessments[i] = a; // answers given against a server draft
      else d.assessments.unshift(a);
    }
    delete byOrg[orgId];
    if (Object.keys(byOrg).length) localStorage.setItem(LEGACY_KEY, JSON.stringify(byOrg));
    else localStorage.removeItem(LEGACY_KEY);
    db.touch(orgId, 'assessment');
  } catch { /* storage unavailable — nothing to import */ }
}

/* ── Reads ────────────────────────────────────────────────── */

export async function assessments(orgId: string) {
  await wait();
  const d = db.getDB(orgId);
  return clone(list(orgId).map((a) => ({ ...a, system: d.aiSystems.find((s) => s.id === a.aiSystemId) })));
}

export async function assessment(orgId: string, id: string) {
  await wait(60, 140);
  const a = find(orgId, id);
  return clone({ assessment: a, system: systemOf(orgId, a.aiSystemId) });
}

/* ── Writes ───────────────────────────────────────────────── */

export async function createAssessment(orgId: string, input: { aiSystemId: string; variant: VariantId }, userId: string) {
  await wait(150, 300);
  requirePerm(orgId, userId, 'assessments.author', 'Owners, admins and approvers write assessments.');
  const sys = systemOf(orgId, input.aiSystemId);
  if (!sys) throw new Error('Register the AI system in the inventory first.');
  const def = VARIANTS[input.variant];
  if (!def) throw new Error('Unknown template.');
  if (def.level && !atLeast(api.levelOf(orgId), def.level)) throw new Error(`${def.label} starts at a higher level.`);
  if (def.kind === 'admission' && list(orgId).some((a) => a.aiSystemId === sys.id && a.variant === input.variant && (a.status === 'draft' || a.status === 'submitted'))) {
    throw new Error(`An open ${def.label} already exists for ${sys.name}. Continue that one.`);
  }
  const a: ExtAssessment = { ...newAssessmentFromTemplate(input.variant, sys.id, userId), ...(def.packId ? { packId: def.packId } : {}) };
  const r = db.logAdmin(orgId, userId, 'assessment.started', { assessment: a.id, system: sys.name, template: input.variant });
  a.startedSeq = r.seq;
  db.getDB(orgId).assessments.unshift(a);
  db.touch(orgId, 'assessment');
  return clone(a);
}

/** Record one answer (draft only). The answer, its points and its explanation come from the template's answer set. */
export async function answerAssessment(orgId: string, id: string, questionId: string, answer: string, userId: string) {
  await wait(40, 120);
  requirePerm(orgId, userId, 'assessments.author', 'Owners, admins and approvers answer assessments.');
  const a = find(orgId, id);
  if (a.status !== 'draft') throw new Error('Only a draft can be answered. Reopen it first.');
  const q = a.questions.find((x) => x.id === questionId);
  if (!q) throw new Error('No such question.');
  const perQ = Math.max(2, Math.round(a.maxScore / Math.max(1, a.questions.length)));
  const opt = optionsFor(q, a.template, perQ).find((x) => x.label === answer);
  if (!opt) throw new Error('That answer is not on this question’s scale.');
  q.answer = opt.label;
  q.points = opt.points;
  q.explanation = opt.explanation;
  const s = summarise(a);
  a.score = s.score;
  a.resultTier = s.complete ? s.tier : 'unassessed';
  db.touch(orgId, 'assessment');
  return clone(a);
}

export async function submitAssessment(orgId: string, id: string, userId: string) {
  await wait(150, 300);
  requirePerm(orgId, userId, 'assessments.author', 'Owners, admins and approvers submit assessments.');
  const a = find(orgId, id);
  if (a.status !== 'draft') throw new Error('Only a draft can be submitted.');
  const s = summarise(a);
  if (!s.complete) throw new Error(`${s.total - s.answered} questions are unanswered.`);
  const def = variantOf(a);
  const sys = systemOf(orgId, a.aiSystemId);
  a.status = 'submitted';
  a.submittedAt = new Date().toISOString();
  a.submittedBy = userId;
  a.score = s.score;
  // pack admission does not set a risk tier: it carries the system's current tier unchanged
  a.resultTier = def.kind === 'admission' ? sys?.riskTier ?? 'unassessed' : s.tier;
  const adm = def.kind === 'admission' ? admissionOf(a) : undefined;
  const r = db.logAdmin(orgId, userId, 'assessment.submitted', { assessment: a.id, system: sys?.name ?? a.aiSystemId, template: def.id, score: s.score, max: a.maxScore, ...(adm ? { gates_met: adm.met, gates: adm.total } : { tier: s.tier }) });
  a.submittedSeq = r.seq;
  db.touch(orgId, 'assessment');
  return clone(a);
}

export async function reopenAssessment(orgId: string, id: string, userId: string) {
  await wait(120, 260);
  requirePerm(orgId, userId, 'assessments.author', 'Owners, admins and approvers reopen assessments.');
  const a = find(orgId, id);
  if (a.status !== 'changes_requested' && a.status !== 'submitted') throw new Error('Only an assessment sent back, or waiting for sign-off, can be reopened.');
  const was = a.status;
  a.status = 'draft';
  db.logAdmin(orgId, userId, 'assessment.reopened', { assessment: a.id, was });
  db.touch(orgId, 'assessment');
  return clone(a);
}

/** Discard a draft that was never approved. The started receipt stays on the chain. */
export async function discardAssessment(orgId: string, id: string, userId: string) {
  await wait(120, 260);
  requirePerm(orgId, userId, 'assessments.author', 'Owners, admins and approvers discard drafts.');
  const a = find(orgId, id);
  if (a.status === 'approved' || a.status === 'submitted') throw new Error('An assessment that was submitted or approved stays on the record. Reopen it instead.');
  const d = db.getDB(orgId);
  d.assessments = d.assessments.filter((x) => x.id !== id);
  const r = db.logAdmin(orgId, userId, 'assessment.discarded', { assessment: id });
  db.touch(orgId, 'assessment');
  return r;
}

/**
 * Sign off (or send back). A different person from the author; owners and admins only. Approval sets the
 * system's risk tier and its next review (6 months for high and unacceptable, 12 for limited, 24 for minimal, calendar months);
 * a pack admission instead admits the pack for the system's agent when all five gates are met.
 */
export async function reviewAssessment(orgId: string, id: string, approve: boolean, note: string, userId: string) {
  await wait(250, 500);
  requirePerm(orgId, userId, 'assessments.signoff', 'Owners and admins sign off assessments.');
  const a = find(orgId, id);
  if (a.status !== 'submitted') throw new Error('Only a submitted assessment can be signed off.');
  if (a.authorId === userId) throw new Error('A different person must sign off. You wrote this assessment.');
  if (a.submittedBy === userId) throw new Error('A different person must sign off. You submitted this assessment.');
  if (note.trim().length < 4) throw new Error('Write a note for the record: what you checked, or what must change.');
  const def = variantOf(a);
  const sys = systemOf(orgId, a.aiSystemId);
  const adm = def.kind === 'admission' ? admissionOf(a) : undefined;
  if (approve && adm && !adm.admitted) throw new Error(`${adm.total - adm.met} of ${adm.total} gates are not met. Request changes; the pack cannot be admitted.`);
  const now = Date.now();
  a.status = approve ? 'approved' : 'changes_requested';
  a.reviewerId = userId;
  a.reviewedAt = new Date(now).toISOString();
  a.reviewNote = note.trim();
  let next: string | undefined;
  if (approve && sys && def.kind !== 'admission') {
    sys.riskTier = a.resultTier as RiskTier;
    next = nextReviewDate(a.resultTier, now);
    sys.nextReview = next;
  }
  const r = db.logAdmin(orgId, userId, approve ? 'assessment.approved' : 'assessment.changes_requested', {
    assessment: a.id, system: sys?.name ?? a.aiSystemId, template: def.id,
    ...(approve && def.kind !== 'admission' ? { tier: a.resultTier, next_review: next!.slice(0, 10) } : {}),
  });
  a.reviewSeq = r.seq;
  if (approve && adm && def.packId) {
    const agent = db.getDB(orgId).agents.find((x) => x.id === sys?.linkedAgentId);
    // below L2 the admission is a dry run: the pack's checks run on the agent's writes and report, with no regulatory claim
    const dryRun = !!def.liveFrom && !atLeast(api.levelOf(orgId), def.liveFrom);
    if (dryRun) a.dryRun = true;
    const pr = db.logAdmin(orgId, userId, 'pack.admitted', { pack: def.packId, system: sys?.name ?? a.aiSystemId, gates_met: adm.met, assessment: a.id, mode: dryRun ? 'dry_run' : 'live', ...(agent ? { agent: agent.slug } : {}) }, agent?.slug);
    a.admittedSeq = pr.seq;
  }
  db.touch(orgId, 'assessment');
  return clone({ assessment: a, system: sys });
}

/* ── Pack admission per system ────────────────────────────── */

export interface PackAdmission { packId: PackId; status: 'admitted' | 'submitted' | 'draft' | 'changes' | 'refused' | 'none'; label: string; assessmentId?: string; at?: string; seq?: number; /** the organisation is below L2: the admission runs as a dry run, with no regulatory claim */ dryRun?: boolean }

const ADM_LABEL: Record<PackAdmission['status'], string> = { admitted: 'Admitted', submitted: 'Waiting for sign-off', draft: 'Admission in draft', changes: 'Changes requested', refused: 'Gates not met', none: 'Not assessed' };

/** The admission state of each pack for one AI system (and so for its agent). */
export async function packAdmissionsFor(orgId: string, aiSystemId: string): Promise<PackAdmission[]> {
  await wait(40, 120);
  return PACKS.map((p) => admissionState(orgId, aiSystemId, p.id));
}

export function admissionState(orgId: string, aiSystemId: string, packId: PackId): PackAdmission {
  const all = list(orgId).filter((a) => a.aiSystemId === aiSystemId && a.variant === `pack_${packId}`).sort((a, b) => (b.reviewedAt ?? b.submittedAt ?? b.createdAt).localeCompare(a.reviewedAt ?? a.submittedAt ?? a.createdAt));
  const approved = all.find((a) => a.status === 'approved');
  const latest = all[0];
  const dryRun = !atLeast(api.levelOf(orgId), 'l2');
  if (approved && (!latest || latest === approved || latest.status !== 'draft')) return { packId, status: 'admitted', label: dryRun ? 'Admitted (dry run)' : ADM_LABEL.admitted, assessmentId: approved.id, at: approved.reviewedAt, seq: approved.admittedSeq, ...(dryRun ? { dryRun } : {}) };
  if (!latest) return { packId, status: 'none', label: ADM_LABEL.none };
  const st: PackAdmission['status'] = latest.status === 'submitted' ? 'submitted' : latest.status === 'changes_requested' ? 'changes' : latest.status === 'draft' ? (admissionOf(latest).complete && !admissionOf(latest).admitted ? 'refused' : 'draft') : 'none';
  return { packId, status: approved ? 'admitted' : st, label: approved ? (dryRun ? 'Admitted (dry run)' : ADM_LABEL.admitted) : ADM_LABEL[st], assessmentId: approved?.id ?? latest.id, ...(approved && dryRun ? { dryRun } : {}) };
}

/** Every admitted (system, pack) pair, for coverage and pack screens. */
export async function packAdmissions(orgId: string) {
  await wait(40, 120);
  const d = db.getDB(orgId);
  return d.aiSystems.flatMap((s) => PACKS.map((p) => ({ system: { id: s.id, name: s.name, agentId: s.linkedAgentId }, ...admissionState(orgId, s.id, p.id) }))).filter((x) => x.status !== 'none');
}
