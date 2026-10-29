/**
 * Framework reports as PDF, beside the CSV and JSON the Coverage and framework pages already download.
 * Built in the browser with lib/pdf. Marked "Draft — needs legal review" on every page.
 */
import { buildPdf, pdfBlob, type PdfBlock } from '@/lib/pdf';

/** The shape of features/compliance/evidence buildReport (kept structural so this file does not depend on it). */
export interface ComplianceReportLike {
  label: string;
  title: string;
  organisation: string;
  assurance_level: string;
  generated_at: string;
  generated_by: string;
  note: string;
  evidence_claim: string;
  frameworks: { id: string; name: string; jurisdiction: string; official_reference: string; requirements_covered: number; requirements_total: number; requirements: { id: string; title: string; controls: string[]; status: string; evidence_count: number }[] }[];
  controls: { id: string; name: string; evidence_kind: string; evidence_count: number; status: string; starts_at: string }[];
}

const when = (iso: string) => `${iso.replace('T', ' ').slice(0, 16)} UTC`;

/** Save a PDF to this device. */
export function downloadPdf(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The whole compliance report (every framework that is on) as a PDF. */
export function complianceReportPdf(r: ComplianceReportLike): Blob {
  const blocks: PdfBlock[] = [
    { kind: 'title', text: `${r.title} - ${r.organisation}` },
    { kind: 'p', text: `${r.assurance_level} - generated ${when(r.generated_at)} by ${r.generated_by}`, muted: true },
    { kind: 'p', text: r.label, muted: true },
    { kind: 'h', text: 'How to read it' },
    { kind: 'p', text: `${r.note} ${r.evidence_claim}`, size: 9.5 },
    { kind: 'h', text: 'Frameworks' },
    r.frameworks.length
      ? { kind: 'table', cols: [{ title: 'Framework', width: 5 }, { title: 'Reference', width: 4 }, { title: 'Jurisdiction', width: 2 }, { title: 'Covered', width: 1.6 }], rows: r.frameworks.map((f) => [f.name, f.official_reference, f.jurisdiction, `${f.requirements_covered} of ${f.requirements_total}`]) }
      : { kind: 'p', text: 'No framework is turned on.' },
    { kind: 'h', text: 'Controls' },
    { kind: 'table', cols: [{ title: 'Control', width: 1.2 }, { title: 'What it does', width: 5 }, { title: 'Evidence', width: 1.4 }, { title: 'Status', width: 1.6 }, { title: 'From', width: 1.4 }], rows: r.controls.map((c) => [c.id, c.name, String(c.evidence_count), c.status.replace('_', ' '), c.starts_at]) },
  ];
  for (const f of r.frameworks) {
    blocks.push({ kind: 'h', text: `${f.name} - ${f.requirements_covered} of ${f.requirements_total} requirements covered` });
    blocks.push({ kind: 'table', cols: [{ title: 'Requirement', width: 1.8 }, { title: 'Title', width: 5 }, { title: 'Controls', width: 2 }, { title: 'Status', width: 1.8 }, { title: 'Receipts', width: 1.2 }], rows: f.requirements.map((q) => [q.id, q.title, q.controls.join(' ') || 'none', q.status, String(q.evidence_count)]) });
  }
  return pdfBlob(buildPdf({ title: `${r.title} - ${r.organisation}`, footer: `${r.organisation} - ${r.title} - ${r.label}`, blocks }));
}

/** One framework's coverage (the framework page) as a PDF. */
export function frameworkReportPdf(a: {
  organisation: string; level: string; by: string; draftLabel: string; note: string; claim: string;
  framework: { name: string; short: string; officialRef: string; jurisdiction: string };
  covered: number; total: number;
  rows: { id: string; title: string; controls: string[]; status: string; evidence: number; example?: number }[];
}): Blob {
  const blocks: PdfBlock[] = [
    { kind: 'title', text: `${a.framework.name} - coverage` },
    { kind: 'p', text: `${a.organisation} - ${a.level} - generated ${when(new Date().toISOString())} by ${a.by}`, muted: true },
    { kind: 'p', text: a.draftLabel, muted: true },
    { kind: 'kv', rows: [['Framework', a.framework.name], ['Reference', a.framework.officialRef], ['Jurisdiction', a.framework.jurisdiction], ['Requirements covered', `${a.covered} of ${a.total}`]] },
    { kind: 'h', text: 'How to read it' },
    { kind: 'p', text: `${a.note} ${a.claim}`, size: 9.5 },
    { kind: 'h', text: 'Requirements' },
    { kind: 'table', cols: [{ title: 'Requirement', width: 1.8 }, { title: 'Title', width: 5 }, { title: 'Controls', width: 2 }, { title: 'Status', width: 1.8 }, { title: 'Receipts', width: 1.1 }, { title: 'Example', width: 1.1 }], rows: a.rows.map((r) => [r.id, r.title, r.controls.join(' ') || 'none', r.status, String(r.evidence), r.example ? `#${r.example}` : '-']) },
  ];
  return pdfBlob(buildPdf({ title: `${a.framework.short} coverage - ${a.organisation}`, footer: `${a.organisation} - ${a.framework.short} coverage - ${a.draftLabel}`, blocks }));
}
