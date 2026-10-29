import type { ReactNode } from 'react';
import { Activity, OctagonX, Banknote, UserPlus, Wrench, Moon, Link2Off, Stamp, KeyRound, HardDrive, GitCompare, Network, Handshake, Gauge, PackageX, Server, FileX2 } from 'lucide-react';
import type { Alert, LevelId, Severity } from '@/types';
import { StatusChip } from '@/components/ui';
import type { AnyDetector } from '@/features/work/backend';

/**
 * The detectors. Six behavioural detectors compare each agent with its own baseline (Technology Memorandum §4.16);
 * only three can raise a high-severity alert, and only a high-severity alert can trigger auto-pause — which is off
 * by default. From L2 the assurance-health detectors watch the evidence itself: the chain, the two timestamp
 * authorities, key custody, write-once storage, the two Seal v6 implementations, inclusion proofs; from L3 the
 * counterparties and autonomy grants; on Sovereign the cluster and signed update bundles. A high assurance alert
 * opens a health incident.
 */
export interface DetectorMeta {
  id: AnyDetector;
  family: 'behaviour' | 'assurance';
  label: string;
  watches: string;
  trigger: string;
  severities: Severity[];
  canHigh: boolean;
  icon: ReactNode;
  level: LevelId;
}

const ic = 'h-4 w-4';

export const DETECTORS: DetectorMeta[] = [
  {
    id: 'volume_spike', family: 'behaviour', level: 'l1', label: 'Volume spike', icon: <Activity className={ic} aria-hidden />,
    watches: 'How many calls an agent made in the last hour, against its own 14-day baseline.',
    trigger: 'Median-based z-score of the last hour, at least 20 calls. Medium at 6, high at 12.',
    severities: ['medium', 'high'], canHigh: true,
  },
  {
    id: 'refusal_surge', family: 'behaviour', level: 'l1', label: 'Refusal surge', icon: <OctagonX className={ic} aria-hidden />,
    watches: 'The share of an agent\'s calls that were refused, against its usual share.',
    trigger: 'Refused share above baseline, at least 10 calls. Medium at 0.3, high at 0.6.',
    severities: ['medium', 'high'], canHigh: true,
  },
  {
    id: 'amount_outlier', family: 'behaviour', level: 'l1', label: 'Amount outlier', icon: <Banknote className={ic} aria-hidden />,
    watches: 'Amounts in money-moving calls, against the amounts this agent usually handles.',
    trigger: 'Median-based z-score of the amount, at least 5 samples. Medium at 6, high at 15.',
    severities: ['medium', 'high'], canHigh: true,
  },
  {
    id: 'new_counterparty', family: 'behaviour', level: 'l1', label: 'New counterparty', icon: <UserPlus className={ic} aria-hidden />,
    watches: 'Vendors, domains, payees, accounts or customers the agent has not dealt with in 90 days.',
    trigger: 'First sighting in 90 days. Medium when an amount is involved, otherwise low.',
    severities: ['low', 'medium'], canHigh: false,
  },
  {
    id: 'new_tool', family: 'behaviour', level: 'l1', label: 'New tool', icon: <Wrench className={ic} aria-hidden />,
    watches: 'The first time an agent calls a tool it has never used before.',
    trigger: 'First use of a tool by this agent. Always low.',
    severities: ['low'], canHigh: false,
  },
  {
    id: 'off_hours', family: 'behaviour', level: 'l1', label: 'Off hours', icon: <Moon className={ic} aria-hidden />,
    watches: 'Calls in an hour of the week when this agent is normally quiet.',
    trigger: 'Hour-of-week holding 0.5% or less of baseline calls. Low or medium.',
    severities: ['low', 'medium'], canHigh: false,
  },
  {
    id: 'chain_integrity', family: 'assurance', level: 'l1', label: 'Chain integrity', icon: <Link2Off className={ic} aria-hidden />,
    watches: 'That every receipt links to the one before it and its hash matches its contents.',
    trigger: 'Any break in the last 300 receipts. Always high; opens a health incident, from L1.',
    severities: ['high'], canHigh: true,
  },
  {
    id: 'receipt_write', family: 'assurance', level: 'l1', label: 'Receipt writes', icon: <FileX2 className={ic} aria-hidden />,
    watches: 'That the receipt store takes every write. The guard refuses any call it cannot record.',
    trigger: 'A write the store refused, or a write-failure drill. Always high; opens a health incident, from L1.',
    severities: ['high'], canHigh: true,
  },
  {
    id: 'tsa_late', family: 'assurance', level: 'l2', label: 'Timestamps late or missing', icon: <Stamp className={ic} aria-hidden />,
    watches: 'That each 15-minute batch has a timestamp from both authorities within 15 minutes.',
    trigger: 'An authority unreachable, a token later than 15 minutes, or a batch with one token. High while open.',
    severities: ['medium', 'high'], canHigh: true,
  },
  {
    id: 'kms_signing', family: 'assurance', level: 'l2', label: 'Signing key', icon: <KeyRound className={ic} aria-hidden />,
    watches: 'That the newest receipt is signed with the key in custody (AWS KMS, your HSM).',
    trigger: 'A receipt signed by any other key, or signing unavailable. High.',
    severities: ['high'], canHigh: true,
  },
  {
    id: 'worm_write', family: 'assurance', level: 'l2', label: 'Write-once storage', icon: <HardDrive className={ic} aria-hidden />,
    watches: 'That receipts and bundles are stored under object lock in compliance mode.',
    trigger: 'Object lock not in compliance mode, or a write that failed. High.',
    severities: ['high'], canHigh: true,
  },
  {
    id: 'implementations_disagree', family: 'assurance', level: 'l2', label: 'Two implementations', icon: <GitCompare className={ic} aria-hidden />,
    watches: 'That the TypeScript and Python Seal v6 implementations produce the same bytes on all 64 test vectors.',
    trigger: 'Any vector where they disagree. High.',
    severities: ['high'], canHigh: true,
  },
  {
    id: 'inclusion_proof', family: 'assurance', level: 'l2', label: 'Inclusion proofs', icon: <Network className={ic} aria-hidden />,
    watches: 'That the newest anchored receipt proves into its Merkle batch root.',
    trigger: 'A proof whose recomputed root differs. High.',
    severities: ['high'], canHigh: true,
  },
  {
    id: 'counterparty_verification', family: 'assurance', level: 'l3', label: 'Counterparty verification', icon: <Handshake className={ic} aria-hidden />,
    watches: 'That receipts received from counterparties verify against their keys.',
    trigger: 'A received receipt that fails a verification step. Medium.',
    severities: ['medium'], canHigh: false,
  },
  {
    id: 'autonomy_exceeded', family: 'assurance', level: 'l3', label: 'Beyond its autonomy', icon: <Gauge className={ic} aria-hidden />,
    watches: 'Agents trying to write where they have no grant above A0 Observe.',
    trigger: '3 or more refused writes for one agent and tool in 24 hours. Medium.',
    severities: ['medium'], canHigh: false,
  },
  {
    id: 'update_signature', family: 'assurance', level: 'sovereign', label: 'Update bundle signature', icon: <PackageX className={ic} aria-hidden />,
    watches: 'That every update bundle is signed by the elan1 release key before it is staged.',
    trigger: 'A bundle whose Ed25519 signature does not verify. High; opens a health incident.',
    severities: ['high'], canHigh: true,
  },
  {
    id: 'node_down', family: 'assurance', level: 'sovereign', label: 'Cluster nodes', icon: <Server className={ic} aria-hidden />,
    watches: 'That every node in your cluster reports ready.',
    trigger: 'A node not ready. High; opens a health incident.',
    severities: ['high'], canHigh: true,
  },
];

export const detectorMeta = (id: AnyDetector | string): DetectorMeta => DETECTORS.find((d) => d.id === id) ?? { id: id as AnyDetector, family: 'behaviour', level: 'l1', label: String(id).replace(/_/g, ' '), watches: '', trigger: '', severities: ['low'], canHigh: false, icon: <Activity className={ic} aria-hidden /> };

export const ALERT_STATUS: Record<Alert['status'], { label: string; tone: 'bad' | 'held' | 'ok' }> = {
  open: { label: 'Open', tone: 'bad' },
  acknowledged: { label: 'Acknowledged', tone: 'held' },
  resolved: { label: 'Resolved', tone: 'ok' },
};

export function AlertStatusChip({ status }: { status: Alert['status'] }) {
  const m = ALERT_STATUS[status];
  return (
    <StatusChip tone={m.tone} size="sm" icon={<span className={status === 'open' ? 'h-1.5 w-1.5 bg-bad' : status === 'acknowledged' ? 'h-1.5 w-1.5 bg-held' : 'h-1.5 w-1.5 bg-ok'} />}>
      {m.label}
    </StatusChip>
  );
}

export function DetectorName({ id, className }: { id: AnyDetector; className?: string }) {
  const m = detectorMeta(id);
  return (
    <span className={className ?? 'inline-flex items-center gap-1.5 text-sm'}>
      <span className="text-muted">{m.icon}</span>
      <span>{m.label}</span>
    </span>
  );
}
