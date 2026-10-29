import type { ReactNode } from 'react';
import { OctagonX, Pause, HeartPulse, CheckCircle2, ShieldAlert } from 'lucide-react';
import type { Agent, AnchorBatch, Incident, LevelId, ProfileRunResult, Receipt } from '@/types';
import { StatusChip, Badge } from '@/components/ui';
import { dateTime, n, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { LEGAL_ENTITY } from '@/lib/company';
import { LEVEL_INFO } from '@/lib/levels';
import { HEALTH_META, SECURITY_KINDS, type HealthKind } from '@/features/work/backend';
import { claimFor } from '@/features/work/level';
import { buildPdf, pdfBlob, type PdfBlock } from '@/lib/pdf';

export const KIND_META: Record<Incident['kind'], { label: string; icon: ReactNode }> = {
  emergency_stop: { label: 'Emergency stop', icon: <OctagonX className="h-3 w-3" aria-hidden /> },
  auto_pause: { label: 'Auto-pause', icon: <Pause className="h-3 w-3" aria-hidden /> },
  health: { label: 'Health', icon: <HeartPulse className="h-3 w-3" aria-hidden /> },
};

/** The kind label, with the health incident's own kind when it has one (timestamp outage, key, storage, cluster …). */
export function kindLabel(kind: Incident['kind'], subkind?: HealthKind) {
  if (kind === 'health' && subkind && SECURITY_KINDS.includes(subkind)) return `Security · ${HEALTH_META[subkind].label}`;
  return kind === 'health' && subkind && HEALTH_META[subkind] ? `Health · ${HEALTH_META[subkind].label}` : KIND_META[kind].label;
}

export function KindBadge({ kind, subkind }: { kind: Incident['kind']; subkind?: HealthKind }) {
  const m = KIND_META[kind];
  const security = kind === 'health' && !!subkind && SECURITY_KINDS.includes(subkind);
  return <Badge tone={kind === 'emergency_stop' ? 'inverse' : security ? 'bad' : 'neutral'} icon={security ? <ShieldAlert className="h-3 w-3" aria-hidden /> : m.icon}>{kindLabel(kind, subkind)}</Badge>;
}

export function IncidentStatusChip({ status, size = 'sm' }: { status: Incident['status']; size?: 'sm' | 'md' }) {
  return status === 'active'
    ? <StatusChip tone="bad" size={size} icon={<span className="h-1.5 w-1.5 bg-bad" />}>Active</StatusChip>
    : <StatusChip tone="ok" size={size} icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Resolved</StatusChip>;
}

export function startedByName(id: string, kind?: Incident['kind']) {
  if (id !== 'system') return userName(id);
  return kind === 'health' ? 'Elan1 Govern (health check)' : kind === 'auto_pause' || !kind ? 'Elan1 Govern (auto-pause)' : 'Elan1 Govern';
}

/** "20 h 14 m", "3 d 2 h", "12 m" */
export function duration(fromIso: string, toIso?: string, now = Date.now()) {
  const ms = Math.max(0, (toIso ? new Date(toIso).getTime() : now) - new Date(fromIso).getTime());
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} d ${h % 24} h`;
  if (h > 0) return `${h} h ${m % 60} m`;
  return `${Math.max(m, 0)} m`;
}

export function scopeLabel(i: Incident) {
  if (i.kind === 'health') return i.agentSlugs.length ? `${n(i.agentSlugs.length)} agents` : 'Evidence and platform';
  return i.scope === 'all_agents' ? `All agents (${n(i.agentSlugs.length)})` : `${n(i.agentSlugs.length)} selected`;
}

/**
 * Calls refused while the incident was open. The stored figure is written when a stop is lifted;
 * while an incident is active we count the agent-paused refusals from the chain.
 */
export function refusedDuring(i: Incident, receipts: Receipt[]) {
  if (i.status === 'resolved' && i.refusedWhileStopped) return i.refusedWhileStopped;
  const from = new Date(i.startedAt).getTime();
  const to = i.resolvedAt ? new Date(i.resolvedAt).getTime() : Number.MAX_SAFE_INTEGER;
  const counted = receipts.filter((r) => r.rule_id === 'agent-paused' && r.agent && i.agentSlugs.includes(r.agent) && new Date(r.ts).getTime() >= from && new Date(r.ts).getTime() <= to).length;
  return Math.max(counted, i.refusedWhileStopped);
}

/* ── Incident report (PDF) ────────────────────────────────── */

export interface ReportEvidence {
  level: LevelId;
  /** Merkle batches with their two timestamps that cover the report's receipts (L2 and above) */
  batches?: AnchorBatch[];
  /** the latest verifier profile run, if any */
  profile?: ProfileRunResult & { name?: string };
  custody?: string;
}

/**
 * The incident report as a PDF, written in the browser by lib/pdf (the same writer as the framework and
 * continuity reports): summary, timeline, agents, the receipts from one hour before the start to the resume
 * (up to 300), and from L2 the Merkle batches and timestamps that cover them. Returns the file and its row count.
 */
export function incidentReportPdf(args: {
  incident: Incident; orgName: string; agents: Agent[]; receipts: Receipt[]; refused: number; pendingNow: number; generatedBy: string; keyFingerprint?: string; evidence?: ReportEvidence;
}): { blob: Blob; rows: number } {
  const { incident: i, orgName, agents, receipts, refused, pendingNow, generatedBy, keyFingerprint, evidence } = args;
  const level = evidence?.level ?? 'l1';
  const l2 = level !== 'l1';
  const rows = receipts.slice(0, 300);
  const first = rows.length ? Math.min(...rows.map((r) => r.seq)) : undefined;
  const last = rows.length ? Math.max(...rows.map((r) => r.seq)) : undefined;
  const decision = (r: Receipt) => (r.decision === 'allow' ? 'Allowed' : r.decision === 'ask' ? 'Asked a person' : r.decision === 'refuse' ? 'Refused' : r.action ?? r.kind);
  const now = new Date().toISOString();
  const kind = kindLabel(i.kind, (i as Incident & { subkind?: HealthKind }).subkind);

  const blocks: PdfBlock[] = [
    { kind: 'p', text: `Incident report - ${i.status === 'active' ? 'Active' : 'Resolved'}`, size: 9, muted: true },
    { kind: 'title', text: i.title },
    { kind: 'p', text: `${orgName} - ${i.id} - ${kind} - ${LEVEL_INFO[level].label}`, muted: true },
    { kind: 'kv', rows: [
      ['Agents paused', n(i.agentSlugs.length)],
      ['Calls refused while stopped', n(refused)],
      ['Approvals waiting at stop', n(i.pendingApprovalsAtStop)],
      ['Duration', duration(i.startedAt, i.resolvedAt)],
    ] },
    { kind: 'h', text: 'Summary' },
    { kind: 'kv', rows: [
      ['Started', `${dateTime(i.startedAt)} by ${startedByName(i.startedBy, i.kind)}`],
      ['Reason', i.reason],
      ['Scope', scopeLabel(i)],
      ['Resolved', i.resolvedAt ? `${dateTime(i.resolvedAt)} by ${i.resolvedBy ? userName(i.resolvedBy) : '-'}` : 'Not yet - still active'],
      ['Approvals waiting now', n(pendingNow)],
    ] },
  ];
  if (i.kind === 'emergency_stop') {
    blocks.push({ kind: 'p', text: `Waiting approvals were held by the stop. ${n(i.pendingApprovalsAtStop)} ${i.pendingApprovalsAtStop === 1 ? 'approval was' : 'approvals were'} waiting when the stop was engaged. Nobody could approve or reject ${i.pendingApprovalsAtStop === 1 ? 'it' : 'them'} until the stop was lifted; their expiry still ran, and an expiry is a refusal.` });
  }

  blocks.push(
    { kind: 'h', text: 'Timeline' },
    { kind: 'table', cols: [{ title: 'Time (IST)', width: 2.2 }, { title: 'Event', width: 6.5 }, { title: 'Receipt', width: 1.2 }],
      rows: i.timeline.map((t) => [t.ts ? dateTime(t.ts) : '-', `${t.text}${t.actor ? ` - ${startedByName(t.actor, i.kind)}` : ''}`, t.seq !== undefined ? seqLabel(t.seq) : '-']) },
    { kind: 'h', text: 'Agents affected' },
    { kind: 'table', cols: [{ title: 'Agent', width: 3 }, { title: 'Route', width: 3 }, { title: 'Status at report time', width: 2.5 }],
      rows: i.agentSlugs.length ? i.agentSlugs.map((s) => {
        const a = agents.find((x) => x.slug === s);
        return [s, a ? (a.route === 'mcp' ? 'Governed run - MCP' : `Check and record - ${a.route.toUpperCase()}`) : '-', a ? (a.status === 'paused' && a.pausedBy === 'auto-pause' ? 'Auto-paused' : a.status[0].toUpperCase() + a.status.slice(1)) : 'No longer registered'];
      }) : [['None', '-', '-']] },
    { kind: 'h', text: `Receipts from one hour before the start to ${i.resolvedAt ? 'the resume' : 'now'}` },
    { kind: 'p', text: `${n(rows.length)} receipts${receipts.length > 300 ? ` (first 300 of ${n(receipts.length)})` : ''}${first !== undefined ? ` - sequence ${seqLabel(first)} to ${seqLabel(last!)}` : ''}.`, muted: true },
    { kind: 'table', cols: [{ title: 'Receipt', width: 1.1 }, { title: 'Time (IST)', width: 2.1 }, { title: 'Agent', width: 2 }, { title: 'Tool or action', width: 2.3 }, { title: 'Decision', width: 1.5 }, { title: 'Rule', width: 1.6 }, { title: 'Hash', width: 1.4 }],
      rows: rows.map((r) => [seqLabel(r.seq), dateTime(r.ts), r.agent ?? (r.actor ? startedByName(r.actor, i.kind) : '-'), r.tool ?? r.action ?? '-', decision(r), r.rule_id ?? '-', `${r.hash.slice(0, 12)}...`]) },
  );

  if (l2 && evidence?.batches?.length) {
    blocks.push(
      { kind: 'h', text: 'Timestamps and Merkle batches for this range' },
      { kind: 'p', text: `${n(evidence.batches.length)} batches - each root timestamped by two authorities (RFC 3161).`, muted: true },
      { kind: 'table', cols: [{ title: 'Batch', width: 2 }, { title: 'Receipts', width: 2 }, { title: 'Merkle root', width: 2.5 }, { title: 'Timestamps', width: 4.5 }],
        rows: evidence.batches.slice(0, 60).map((b) => [b.id, `${seqLabel(b.firstSeq)}-${seqLabel(b.lastSeq)}`, `${b.root.slice(0, 20)}...`, b.tokens.map((t) => `${t.tsaName} ${dateTime(t.genTime)}${t.status === 'granted_late' ? ' (late)' : ''}`).join('; ')]) },
    );
  }
  if (l2 && evidence?.profile) {
    blocks.push({ kind: 'p', text: `Verifier profile ${evidence.profile.name ?? evidence.profile.profileId} v${evidence.profile.version}: ${evidence.profile.result === 'pass' ? 'pass' : 'fail'} on ${n(evidence.profile.range.count)} records, run ${dateTime(evidence.profile.ranAt)}.`, muted: true });
  }

  blocks.push(
    { kind: 'h', text: 'Check it yourself' },
    { kind: 'p', text: `To check this range offline, export ${l2 ? 'the 8-member evidence bundle from Assurance > Proof and run "govern verify evidence-bundle.json" (six result codes, nine-section report)' : 'an auditor pack from Assurance > Proof and run "govern verify auditor-pack.json"'}${first !== undefined ? ` for sequence ${seqLabel(first)}-${seqLabel(last!)}` : ''}. Compare the key fingerprint you are given out of band${keyFingerprint ? ` (${keyFingerprint})` : ''}.` },
    { kind: 'rule' },
    { kind: 'p', text: `Generated ${dateTime(now)} by ${generatedBy}. ${LEVEL_INFO[level].label}: ${claimFor(level)}${evidence?.custody ? ` (${evidence.custody})` : ''}; the chain is hash-linked and tamper-evident. This report is a reading of those receipts, not a finding about cause.`, size: 8.5, muted: true },
    { kind: 'p', text: `Elan1 Govern - ${LEGAL_ENTITY}`, size: 8.5, muted: true },
  );

  const pdf = buildPdf({ title: `Incident report - ${i.title}`, footer: `${orgName} - incident report ${i.id}`, blocks, createdAt: now });
  return { blob: pdfBlob(pdf), rows: rows.length };
}
