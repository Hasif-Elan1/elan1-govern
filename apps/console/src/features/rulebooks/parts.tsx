import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Hourglass, OctagonX, Lock, Plus, Minus, ArrowUpNarrowWide, ArrowDownWideNarrow, PenLine, MessageSquare, Timer, Users, Gauge, PencilRuler, FileClock, FileCheck2, FileSearch, TimerReset } from 'lucide-react';
import type { Condition, Decision, Rule, RulebookVersion } from '@/types';
import { cn } from '@/lib/cn';
import { tagLabel, plural } from '@/lib/format';
import { Badge, StatusChip, Tooltip } from '@/components/ui';
import { When } from '@/components/domain';
import { NAMED_LISTS, OUTCOME, semDiff, chatBlockReason, conditionText, groupName, opMeta, quotaText, formatValue, toolsForRule, builderExtra } from './lib';

const ic = 'h-3.5 w-3.5 shrink-0';

export function OutcomeChip({ decision, size = 'sm' }: { decision: Decision; size?: 'sm' | 'md' }) {
  const m = OUTCOME[decision];
  const icon = decision === 'allow' ? <Check className={ic} aria-hidden /> : decision === 'ask' ? <Hourglass className={ic} aria-hidden /> : <OctagonX className={ic} aria-hidden />;
  return <StatusChip tone={m.tone} size={size} icon={icon}>{m.label}</StatusChip>;
}

export function VersionStatus({ status, size = 'sm' }: { status: RulebookVersion['status']; size?: 'sm' | 'md' }) {
  if (status === 'published') return <StatusChip tone="ok" size={size} icon={<FileCheck2 className={ic} aria-hidden />}>Published</StatusChip>;
  if (status === 'in_review') return <StatusChip tone="info" size={size} icon={<FileSearch className={ic} aria-hidden />}>In review</StatusChip>;
  return <StatusChip tone="neutral" size={size} icon={<FileClock className={ic} aria-hidden />}>Draft</StatusChip>;
}

export function DefaultRefuseChip() {
  return (
    <Tooltip content="Every rulebook ends with this. Anything no rule allows is refused. It cannot be changed.">
      <StatusChip tone="neutral" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Default: refuse</StatusChip>
    </Tooltip>
  );
}

/** Condition shown as field · operator · value, with named lists marked. */
export function ConditionPill({ c, state }: { c: Condition; state?: boolean | undefined | 'none' }) {
  const m = opMeta(c.op);
  const listNames = Array.isArray(c.value) ? c.value.filter((v) => NAMED_LISTS[v]) : [];
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1 border px-1.5 py-0.5 text-[12.5px] font-mono bg-surface',
      state === true ? 'border-ok/40' : state === false ? 'border-bad/40' : state === undefined ? 'border-held/50 border-dashed' : 'border-line')}>
      {state === true && <Check className="h-3 w-3 text-ok-fg" aria-label="holds" />}
      {state === false && <Minus className="h-3 w-3 text-bad-fg" aria-label="does not hold" />}
      <span className="text-fg">{c.field}</span>
      <span className="text-muted" title={m?.label}>{m?.symbol ?? c.op}</span>
      {listNames.length ? (
        <span className="inline-flex items-center gap-1">
          {listNames.map((l) => <span key={l} className="text-accent-fg" title={NAMED_LISTS[l]}>{l}</span>)}
          {Array.isArray(c.value) && c.value.length > listNames.length && <span className="text-fg">, {c.value.filter((v) => !NAMED_LISTS[v]).join(', ')}</span>}
        </span>
      ) : <span className="text-fg break-all">{formatValue(c)}</span>}
    </span>
  );
}

export type RuleDiffKind = 'added' | 'removed' | 'tighter' | 'looser' | 'changed';

export function DiffBadge({ kind }: { kind: RuleDiffKind }) {
  const map: Record<RuleDiffKind, { label: string; cls: string; icon: ReactNode }> = {
    added: { label: 'Added', cls: 'bg-info-bg text-info-fg border-info/30', icon: <Plus className="h-3 w-3" aria-hidden /> },
    removed: { label: 'Removed', cls: 'bg-clay-100/60 text-accent-fg border-accent/30 dark:bg-clay-900/40', icon: <Minus className="h-3 w-3" aria-hidden /> },
    tighter: { label: 'Tighter', cls: 'bg-sunken text-fg border-line-strong/50', icon: <ArrowUpNarrowWide className="h-3 w-3" aria-hidden /> },
    looser: { label: 'Looser', cls: 'bg-sunken text-fg border-line-strong/50', icon: <ArrowDownWideNarrow className="h-3 w-3" aria-hidden /> },
    changed: { label: 'Changed', cls: 'bg-sunken text-muted border-line', icon: <PenLine className="h-3 w-3" aria-hidden /> },
  };
  const m = map[kind];
  return <span className={cn('inline-flex items-center gap-1 h-[22px] px-1.5 text-xs font-medium border whitespace-nowrap', m.cls)}>{m.icon}{m.label}</span>;
}

export function YamlEditedBadge() {
  return <Badge tone="accent" icon={<PencilRuler className="h-3 w-3" aria-hidden />} title="This rule carries settings written in YAML that the visual builder cannot show. They are kept as written.">Edited in YAML</Badge>;
}

/** The IF / AND / UNLESS / THEN body of a rule. Shared by the builder, suggestions and previews. */
export function RuleBody({ rule, agentTools, condState, extra }: { rule: Rule; agentTools?: string[]; condState?: (c: Condition) => boolean | undefined; extra?: Record<string, unknown> }) {
  const reach = rule.match.tag ? toolsForRule(rule, agentTools) : [];
  const chatBlocked = rule.approveInChat ? chatBlockReason(rule, agentTools) : undefined;
  const bx = builderExtra(extra);
  return (
    <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-2 text-sm">
      <dt className="label pt-1">If</dt>
      <dd className="min-w-0">
        {rule.match.tool ? (
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <span className="text-muted">the agent calls</span>
            <span className="font-mono text-[12.5px] px-1.5 py-0.5 bg-sunken border border-line break-all">{rule.match.tool}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <span className="text-muted">any tool tagged</span>
            <Badge tone="accent">{tagLabel[rule.match.tag ?? ''] ?? rule.match.tag}</Badge>
            <span className="text-xs text-subtle" title={reach.map((t) => t.name).join('\n')}>
              {reach.length ? `reaches ${plural(reach.length, 'tool')}${agentTools ? ' of this agent' : ''}` : 'reaches no tool of this agent'}
            </span>
          </span>
        )}
      </dd>
      {rule.when?.length ? (
        <>
          <dt className="label pt-1">And</dt>
          <dd className="flex flex-wrap gap-1.5 min-w-0">{rule.when.map((c, i) => <ConditionPill key={i} c={c} state={condState ? condState(c) : 'none'} />)}</dd>
        </>
      ) : null}
      {rule.unless?.length ? (
        <>
          <dt className="label pt-1">Unless</dt>
          <dd className="flex flex-wrap items-center gap-1.5 min-w-0">
            {rule.unless.map((c, i) => <ConditionPill key={i} c={c} />)}
            <span className="text-xs text-muted">{rule.unless.length > 1 ? 'all hold' : 'holds'} — then the ask stands aside</span>
          </dd>
        </>
      ) : null}
      <dt className="label pt-1">Then</dt>
      <dd className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
        <OutcomeChip decision={rule.decide} />
        {rule.decide === 'ask' && (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-muted"><Users className="h-3.5 w-3.5" aria-hidden />{groupName(rule.approver)}</span>
            <span className="inline-flex items-center gap-1 text-xs text-muted"><Timer className="h-3.5 w-3.5" aria-hidden />expires {rule.expiresIn ?? '24h'}, then refused</span>
            <span className={cn('inline-flex items-center gap-1 text-xs', chatBlocked ? 'text-bad-fg' : 'text-muted')} title={chatBlocked}>
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />{rule.approveInChat ? (chatBlocked ? 'Approve in chat — not allowed here' : 'Approve in chat on') : 'Console or email link only'}
            </span>
          </>
        )}
        {rule.quota && <span className="inline-flex items-center gap-1 text-xs text-muted"><Gauge className="h-3.5 w-3.5" aria-hidden />{quotaText(rule.quota)}</span>}
        {rule.mode === 'simulate' && <Badge tone="info">Simulate only</Badge>}
      </dd>
      {rule.decide === 'ask' && bx.escalate_to ? (
        <>
          <dt className="label pt-0.5">Escalate</dt>
          <dd className="inline-flex flex-wrap items-center gap-1 text-xs text-muted"><TimerReset className="h-3.5 w-3.5" aria-hidden />to {groupName(bx.escalate_to)} after {bx.escalate_after?.endsWith('%') ? `${bx.escalate_after} of the window` : bx.escalate_after} if nobody decides — once, recorded</dd>
        </>
      ) : null}
      {bx.requires_autonomy || bx.pack ? (
        <>
          <dt className="label pt-0.5">Also</dt>
          <dd className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {bx.requires_autonomy && <Badge icon={<Gauge className="h-3 w-3" aria-hidden />}>Needs autonomy {bx.requires_autonomy} or above</Badge>}
            {bx.pack && <Badge icon={<Lock className="h-3 w-3" aria-hidden />}>From {bx.pack} · locked</Badge>}
          </dd>
        </>
      ) : null}
      <dt className="label pt-0.5">Reason</dt>
      <dd className={cn('text-sm leading-relaxed', rule.reason ? 'text-fg/85' : 'text-bad-fg')}>{rule.reason || 'No reason written yet.'}</dd>
    </dl>
  );
}

/** Semantic diff list (added / removed / tighter / looser). */
export function SemanticDiffList({ before, after, emptyText = 'No rule changes.', compact }: { before: Rule[]; after: Rule[]; emptyText?: string; compact?: boolean }) {
  const d = semDiff(before, after);
  if (!d.length) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <ul className={cn('divide-y divide-line border border-line', compact && 'text-sm')}>
      {d.map((x) => (
        <li key={x.id + x.change} className="flex items-start gap-3 px-3 py-2.5">
          <DiffBadge kind={x.change} />
          <span className="min-w-0 text-sm"><span className="font-mono text-[12.5px]">{x.id}</span><span className="text-muted"> — {x.text.replace(`${x.id}: `, '').replace(`New rule ${x.id}: `, '').replace(`Rule ${x.id} removed`, 'removed from the rulebook')}</span></span>
        </li>
      ))}
    </ul>
  );
}

export function diffByRule(before: Rule[], after: Rule[]): Record<string, RuleDiffKind> {
  return Object.fromEntries(semDiff(before, after).map((x) => [x.id, x.change]));
}

export function HitsLine({ hits }: { hits?: { count: number; last?: string } }) {
  if (!hits) return null;
  return (
    <span className="text-xs text-muted num whitespace-nowrap">
      {hits.count ? <>{plural(hits.count, 'decision')} in 30 days · last <When iso={hits.last} /></> : 'No decisions in 30 days'}
    </span>
  );
}

export function RulebookLink({ slug, children, className }: { slug: string; children?: ReactNode; className?: string }) {
  return <Link to={`/rulebooks/${slug}`} onClick={(e) => e.stopPropagation()} className={cn('hover:underline underline-offset-2', className)}>{children ?? `${slug} rulebook`}</Link>;
}

export { conditionText };
