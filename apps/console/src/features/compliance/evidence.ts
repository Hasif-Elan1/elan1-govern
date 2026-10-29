/**
 * Live evidence for the controls, counted from the organisation's chain and records.
 * Coverage = share of a framework's requirements with at least one mapped control that has live evidence.
 * It is a count of receipts, not a test that a control works.
 *
 * The control list, the predicates and the framework mapping live in mock/controlMap.ts, so /compliance, Today, the
 * AI system page, the receipt page and the L1 auditor pack's compliance map all compute coverage the same way.
 * This file binds them to the open organisation and keeps the report helpers.
 */
import { api, db } from '@/api';
import type { Control, Framework, LevelId, Receipt } from '@/types';
import { LEVEL_INFO } from '@/lib/levels';
import { controlIdsOf, coverageOf, indexControls, liveControlsOf, requirementsOf, requirementStatus, REQ_STATUS_LABEL, type LiveControl } from '@/mock/controlMap';

export { CONTROL_MATCH, LEVEL_CONTROLS, LEVEL_MAP, REQ_STATUS_LABEL, coverageOf, indexControls, requirementStatus, requirementsOf } from '@/mock/controlMap';
export type { LiveControl, ReqStatus } from '@/mock/controlMap';

/** Recount each control's evidence from the live records so the numbers move with the chain. Adds the level's controls. */
export function liveControls(orgId: string, controls: Control[]): LiveControl[] {
  return liveControlsOf(db.getDB(orgId), controls, api.levelOf(orgId));
}

/** The controls one receipt counts towards, with the same predicates coverage uses (for receipt screens). */
export function controlIdsForReceipt(orgId: string, r: Receipt): string[] {
  return controlIdsOf(db.getDB(orgId), r, api.levelOf(orgId));
}

/** Each framework's coverage, as /compliance computes it (Today and the AI system page use this). */
export function frameworkCoverage(orgId: string, frameworks: Framework[]): Record<string, ReturnType<typeof coverageOf>> {
  const byId = indexControls(liveControls(orgId, db.getDB(orgId).controls));
  return Object.fromEntries(frameworks.map((f) => [f.id, coverageOf(f, byId)]));
}

export const DRAFT_LABEL = 'Draft — needs legal review';
export const COVERAGE_NOTE = "Coverage is the share of a framework's requirements with at least one mapped control that has live evidence on the chain. It is a count of receipts, not a test that a control works.";

/** Jurisdiction notes keyed by framework id; the India badge itself comes from the framework's jurisdiction. */
export const INDIA_NOTE: Record<string, string> = {
  dpdp: 'India. The DPDP Rules are being phased in; requirements here are mapped at section level from the Act. Most DPDP duties (notice, consent, rights) sit outside an agent guard, so they show as gaps until your own processes are recorded.',
  rbi: 'India. FREE-AI is a committee report (August 2025) with recommendations, mapped here at pillar and recommendation level. It is not yet a binding direction; check the current RBI circulars with your compliance team.',
};

export const isIndia = (f: Pick<Framework, 'jurisdiction'>) => /\bIndia\b/i.test(f.jurisdiction);

/** The evidence claim for the organisation's level, in the words the build guide sets. */
export function evidenceClaim(level: LevelId): string {
  switch (level) {
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
    case 'l1': return 'Receipts are sealed in a hash chain by Elan1 Govern and not yet externally timestamped.';
    case 'l2': return 'Records are sealed, signed with a key in AWS KMS and timestamped by two authorities.';
    case 'l3': return 'Records are signed with a key you hold in your HSM and timestamped by two authorities.';
    case 'sovereign': return 'Records are signed in your own HSM and timestamped by your own two authorities.';
  }
}

/** Client-side report download. The draft label travels inside the file. */
export function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildReport(orgName: string, frameworks: Framework[], controls: LiveControl[], by: string, level: LevelId = 'l1') {
  const byId = indexControls(controls);
  return {
    label: DRAFT_LABEL,
    title: 'Compliance report',
    organisation: orgName,
    assurance_level: LEVEL_INFO[level].label,
    generated_at: new Date().toISOString(),
    generated_by: by,
    note: COVERAGE_NOTE,
    evidence_claim: evidenceClaim(level),
    frameworks: frameworks.filter((f) => f.enabled).map((f) => {
      const c = coverageOf(f, byId);
      return {
        id: f.id, name: f.name, jurisdiction: f.jurisdiction, official_reference: f.officialRef,
        requirements_covered: c.covered, requirements_total: c.total, coverage_rounded_down: c.share,
        requirements: requirementsOf(f, byId).map((r) => ({ id: r.id, title: r.title, controls: r.controlIds, status: REQ_STATUS_LABEL[requirementStatus(r, byId)], evidence_count: r.controlIds.reduce((s, id) => s + (byId[id]?.evidenceCount ?? 0), 0) })),
      };
    }),
    controls: controls.map((c) => ({ id: c.id, name: c.name, evidence_kind: c.evidenceKind, evidence_count: c.evidenceCount, last_evidence_at: c.lastEvidenceAt ?? null, status: c.status, note: c.note ?? null, starts_at: c.level ? LEVEL_INFO[c.level].label : LEVEL_INFO.l1.label })),
  };
}

export function reportCsv(report: ReturnType<typeof buildReport>) {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    `# ${report.label}`,
    `# ${report.title} — ${report.organisation} — ${report.assurance_level} — generated ${report.generated_at}`,
    `# ${report.note}`,
    `# ${report.evidence_claim}`,
    ['framework', 'requirement', 'title', 'mapped_controls', 'status', 'evidence_count'].join(','),
    ...report.frameworks.flatMap((f) => f.requirements.map((r) => [f.name, r.id, r.title, r.controls.join(' '), r.status, r.evidence_count].map(esc).join(','))),
  ];
  return lines.join('\n');
}
