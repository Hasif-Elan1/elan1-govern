import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Link2, ShieldCheck, Waypoints, ArrowRightLeft, Lock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Agent, LevelId, Receipt, RiskTag, Route } from '@/types';
import { useOrgLevel } from '@/store/session';
import { userById } from '@/mock/users';
import { tagLabel, HIGH_IMPACT_TAGS, n, relative, dateTime, seqLabel } from '@/lib/format';
import { Avatar, Badge, StatusChip } from './ui/core';
import { Tooltip } from './ui/overlay';

/** Link to an agent by slug. Agents are named in monospace-free type with a small bot glyph. */
export function AgentLink({ slug, className, plain }: { slug?: string; className?: string; plain?: boolean }) {
  if (!slug) return <span className="text-subtle">—</span>;
  const inner = (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', className)}>
      <Bot className="h-3.5 w-3.5 text-muted shrink-0" aria-hidden />
      <span className="truncate">{slug}</span>
    </span>
  );
  return plain ? inner : <Link to={`/agents/${slug}`} onClick={(e) => e.stopPropagation()} className="hover:underline underline-offset-2">{inner}</Link>;
}

export function Person({ id, showTitle, size = 24, className }: { id?: string; showTitle?: boolean; size?: number; className?: string }) {
  if (!id) return <span className="text-subtle">—</span>;
  if (id === 'system') return <span className={cn('inline-flex items-center gap-2 text-sm', className)}><span className="inline-flex items-center justify-center bg-sunken border border-line text-muted" style={{ width: size, height: size }}><ShieldCheck className="h-3.5 w-3.5" /></span>Elan1 Govern</span>;
  const u = userById(id);
  if (!u) return <span className="text-sm">{id}</span>;
  return (
    <span className={cn('inline-flex items-center gap-2 min-w-0', className)}>
      <Avatar initials={u.initials} size={size} title={u.name} />
      <span className="min-w-0">
        <span className="block text-sm font-medium truncate">{u.name}</span>
        {showTitle && <span className="block text-xs text-muted truncate">{u.title}</span>}
      </span>
    </span>
  );
}

/** "#4,097" — opens the receipt. */
export function ReceiptLink({ seq, className }: { seq?: number; className?: string }) {
  if (seq === undefined) return <span className="text-subtle">—</span>;
  return (
    <Link to={`/activity/${seq}`} onClick={(e) => e.stopPropagation()} className={cn('font-mono text-[12.5px] text-fg hover:text-accent-fg hover:underline underline-offset-2', className)}>
      {seqLabel(seq)}
    </Link>
  );
}

export function TagList({ tags, max = 4 }: { tags: RiskTag[]; max?: number }) {
  if (!tags.length) return <span className="text-xs text-subtle">No risk tags</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {tags.slice(0, max).map((t) => (
        <Badge key={t} tone={HIGH_IMPACT_TAGS.includes(t) ? 'accent' : 'neutral'} title={HIGH_IMPACT_TAGS.includes(t) ? 'High-impact tag' : undefined}>{tagLabel[t]}</Badge>
      ))}
      {tags.length > max && <Badge>+{tags.length - max}</Badge>}
    </span>
  );
}

/**
 * The claim boundary, on screen. Governed run (MCP) is enforced: Elan1 Govern holds the credential and runs the call.
 * Check and record (REST/SDK) is advisory: the agent runs the call itself.
 */
export function RouteMode({ route, compact }: { route: Route; compact?: boolean }) {
  const enforced = route === 'mcp';
  const chip = (
    <StatusChip tone={enforced ? 'inverse' : 'neutral'} size="sm" icon={enforced ? <Lock className="h-3 w-3" aria-hidden /> : <ArrowRightLeft className="h-3 w-3" aria-hidden />}>
      {compact ? (enforced ? 'Governed run' : 'Advisory') : enforced ? 'Governed run · MCP' : `Check and record · ${route.toUpperCase()}`}
    </StatusChip>
  );
  return (
    <Tooltip content={enforced ? 'Enforced. Elan1 Govern holds the tool credential and runs the call; a refused call does not run.' : 'Advisory. Elan1 Govern decides and records; the agent holds its own credentials and runs the call.'}>
      {chip}
    </Tooltip>
  );
}

export function AgentStatus({ agent }: { agent: Pick<Agent, 'status' | 'pausedBy'> }) {
  if (agent.status === 'active') return <StatusChip tone="ok" size="sm" icon={<span className="h-1.5 w-1.5 bg-ok" />}>Active</StatusChip>;
  if (agent.status === 'stopped') return <StatusChip tone="bad" size="sm" icon={<AlertTriangle className="h-3 w-3" />}>Stopped</StatusChip>;
  if (agent.status === 'draft') return <StatusChip tone="neutral" size="sm">Draft</StatusChip>;
  return <StatusChip tone="held" size="sm" icon={<span className="h-1.5 w-1.5 bg-held" />}>{agent.pausedBy === 'auto-pause' ? 'Auto-paused' : 'Paused'}</StatusChip>;
}

/**
 * Chain status is never a lone green tick: it names the scope and what was checked.
 */
export function ChainStatus({ head, total, lastCheckpointAt, className, inverse }: { head?: Receipt; total?: number; lastCheckpointAt?: string; className?: string; inverse?: boolean }) {
  const level = useOrgLevel();
  if (!head) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-sm', inverse ? 'text-ink-200' : 'text-muted', className)}>
      <span className={cn('inline-flex items-center gap-1.5 font-medium', inverse ? 'text-paper' : 'text-fg')}>
        <Waypoints className="h-4 w-4" aria-hidden />
        {/* no continuity claim here: how far the integrity runs reached is shown on Proof (features/evidence/ContinuityLine) */}
        Chain head <Link to={`/activity/${head.seq}`} className="font-mono underline-offset-2 hover:underline">{seqLabel(head.seq)}</Link>
      </span>
      {total !== undefined && <span>{n(total)} receipts in this window</span>}
      {lastCheckpointAt && <span>Last {level === 'l1' ? 'sealed' : 'signed'} checkpoint {relative(lastCheckpointAt)}</span>}
      <span className="inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" aria-hidden />{CHAIN_CLAIM[level]}</span>
    </div>
  );
}

const CHAIN_CLAIM: Record<LevelId, string> = {
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  l1: 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped',
  l2: 'Sealed, signed with a key in AWS KMS · timestamped by two authorities',
  l3: 'Signed with a key you hold in your HSM · timestamped by two authorities',
  sovereign: 'Signed in your own HSM · timestamped by your own two authorities',
};

export function When({ iso, className }: { iso?: string; className?: string }) {
  if (!iso) return <span className="text-subtle">—</span>;
  return <time dateTime={iso} title={dateTime(iso)} className={cn('num whitespace-nowrap', className)}>{relative(iso)}</time>;
}

export function Money({ value, className }: { value?: number; className?: string }) {
  if (value === undefined) return <span className="text-subtle">—</span>;
  return <span className={cn('num', className)}>₹{new Intl.NumberFormat('en-IN').format(value)}</span>;
}

export function ArgsTable({ args }: { args: Record<string, unknown> }) {
  return (
    <table className="w-full text-sm border border-line">
      <tbody>
        {Object.entries(args).map(([k, v]) => (
          <tr key={k} className="border-b border-line last:border-b-0">
            <th scope="row" className="w-1/3 text-left font-mono text-[12px] font-normal text-muted bg-sunken/50 px-3 py-2 align-top">{k}</th>
            <td className="px-3 py-2 font-mono text-[12.5px] break-all">{typeof v === 'number' && k.includes('amount') ? `₹${new Intl.NumberFormat('en-IN').format(v)}` : String(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Section({ title, children, aside, className }: { title: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('py-4 border-b border-line last:border-b-0', className)}>
      <div className="flex items-center justify-between mb-2">
        <p className="label">{title}</p>
        {aside}
      </div>
      {children}
    </div>
  );
}
