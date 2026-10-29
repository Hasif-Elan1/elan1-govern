import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, OctagonX } from 'lucide-react';
import type { Agent, LevelId, Receipt, RegulatoryPack, RiskTag, Rule, RulebookVersion } from '@/types';
import { evaluate } from '@/lib/evaluate';
import { sha256Hex } from '@/lib/crypto';
import { AUTONOMY_LEVELS } from '@/lib/autonomy';
import { levelRank } from '@/lib/levels';
import { toolByName } from '@/mock/catalog';
import { cn } from '@/lib/cn';
import { dateTime, n, rupees, seqLabel, tagLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { Badge, DecisionChip, Hash, InlineCode, StatusChip } from '@/components/ui';
import { receiptMode, ruleExitText, SYSTEM_RULES } from './shared';
import type { AutonomyAtTime } from './receiptAssurance';
import { PlanUpsell, SmartLink } from '@/shell/access';

type StepState = 'passed' | 'refused' | 'held' | 'not_reached' | 'flagged' | 'not_in_force';
type StepId = 'identify' | 'paused' | 'rulebook' | 'tool' | 'args' | 'limits' | 'decide' | 'autonomy' | 'pack' | 'act';

interface Step { id: StepId; title: string; state: StepState; summary: string; body?: ReactNode; exit?: { id: string; text: string } }

const STATE_META: Record<StepState, { label: string; tone: 'ok' | 'bad' | 'held' | 'neutral'; box: string }> = {
  passed: { label: 'Passed', tone: 'ok', box: 'bg-fg text-canvas border-fg' },
  refused: { label: 'Refused here', tone: 'bad', box: 'bg-bad text-white border-bad' },
  held: { label: 'Held for a person', tone: 'held', box: 'bg-held text-ink-900 border-held' },
  flagged: { label: 'Recorded, flagged', tone: 'held', box: 'bg-surface text-fg border-held' },
  not_reached: { label: 'Not reached', tone: 'neutral', box: 'bg-surface text-subtle border-line-strong border-dashed' },
  not_in_force: { label: 'Not in force', tone: 'neutral', box: 'bg-surface text-subtle border-line-strong border-dashed' },
};

const OUTCOME_LABEL = { matched: 'Matched', conditions_failed: 'Conditions not met', not_applicable: 'Does not apply', unknown_field: 'Field not recorded' } as const;

function describeQuota(rule: Rule) {
  const q = rule.quota!;
  const total = q.field?.includes('amount') ? rupees(q.limit) : n(q.limit);
  return `${q.kind === 'max_count' ? `at most ${n(q.limit)} calls` : `a total of at most ${total}${q.field ? ` in ${q.field}` : ''}`} per ${q.window === 'day' ? 'day (organisation time zone)' : q.window}`;
}

type PackResult = 'passed' | 'held' | 'refused' | 'would_hold' | 'would_refuse';

/**
 * What the guard's pack check recorded on this receipt (mock/packChecks.ts): the packs admitted for the agent whose
 * declaration covers the write, the declaration versions in force, the mode and the result. Nothing is recomputed:
 * a receipt without these details had no pack check (no admitted pack covered it, or it was decided earlier).
 */
function packRecord(r: Receipt) {
  const d = r.details ?? {};
  const ids = typeof d.packs === 'string' && d.packs ? d.packs.split(',') : [];
  const result = (typeof d.pack_checks === 'string' ? d.pack_checks : undefined) as PackResult | undefined;
  const decls = typeof d.pack_declaration === 'string' ? d.pack_declaration.split(',') : [];
  return {
    ids, result, dryRun: d.pack_mode === 'dry_run',
    declarationOf: (id: string) => decls.find((x) => x.startsWith(`decl.${id} `)),
    rule: typeof d.pack_rule === 'string' ? d.pack_rule : undefined,
    failed: typeof d.pack_rules_failed === 'string' ? d.pack_rules_failed.split(',') : [],
    wouldRefuse: typeof d.pack_would_refuse === 'string' ? d.pack_would_refuse : undefined,
    wouldHold: typeof d.pack_would_hold === 'string' ? d.pack_would_hold : undefined,
    holdMet: typeof d.pack_hold_met === 'string' ? d.pack_hold_met : undefined,
  };
}

/**
 * The decision path as built, re-drawn for one receipt, in the guard's order (mock/db.ts governCall): stop, rulebook,
 * tool, decide, then the recorded checks (the regulatory pack check), then autonomy, then act. Where the receipt
 * carries the rulebook version, the decide step re-runs the pure decide() over that version's rules. The pack step is
 * drawn from what the receipt recorded (the admitted packs, the declaration version and the result), never recomputed.
 * From L3 the autonomy grant in force is applied after the rulebook and the recorded checks.
 */
export function DecisionTrace({ r, agent, version, connectorsHaveTool, autonomy, packs = [], level, orgLevel }: {
  r: Receipt; agent?: Agent; version?: RulebookVersion; connectorsHaveTool: boolean; autonomy?: AutonomyAtTime; packs?: (RegulatoryPack & { applies: boolean })[]; level?: LevelId; orgLevel?: LevelId;
}) {
  const rule = r.rule_id ?? '';
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signedLevel = levelRank(level ?? orgLevel ?? 'l1') >= 1;
  const known = !!toolByName(r.tool ?? '') || connectorsHaveTool;
  const autoRule = rule.startsWith('autonomy-');
  const packRule = rule === 'pack-gate' || rule === 'pack-declaration';
  const refuseAt: StepId | undefined =
    r.decision !== 'refuse' ? undefined
      : rule === 'agent-paused' ? 'paused'
      : rule === 'no-rulebook' || rule === 'rulebook-invalid' ? 'rulebook'
      : rule === 'default' && !known ? 'tool'
      : rule === 'invalid-arguments' ? 'args'
      : autoRule ? 'autonomy'
      : packRule ? 'pack'
      : 'decide';
  const pr = packRecord(r);
  const packHeld = packRule && r.decision === 'ask';
  // the guard runs the recorded checks (the pack check) after the rulebook and before autonomy
  const order: StepId[] = ['identify', 'paused', 'rulebook', 'tool', 'args', 'limits', 'decide', ...(pr.ids.length || packRule ? (['pack'] as StepId[]) : []), 'autonomy', 'act'];
  const idx = (id: StepId) => order.indexOf(id);
  const st = (id: StepId): StepState => (refuseAt && id === refuseAt ? 'refused' : refuseAt && idx(id) > idx(refuseAt) && id !== 'act' ? 'not_reached' : 'passed');

  const tags = (r.details?.tags ? String(r.details.tags).split(',') : toolByName(r.tool ?? '')?.tags ?? []) as RiskTag[];
  // rules marked simulate (a pack section added at L1 as a dry run) never decide, as in the guard
  const rerun = version && r.tool && r.args_summary ? evaluate(version.rules.filter((x) => x.mode !== 'simulate'), r.tool, r.args_summary, tags) : undefined;
  const hashOk = version ? sha256Hex(version.yaml) === r.rulebook?.hash : undefined;
  const key = agent?.keys.find((k) => !k.revoked && k.environment === 'production') ?? agent?.keys[0];
  const governed = receiptMode(r) === 'governed_run';
  const quotaRules = version?.rules.filter((x) => x.quota && (x.match.tool === r.tool || (x.match.tag && tags.includes(x.match.tag)))) ?? [];
  // a pack hold or refusal replaced the rulebook's decision; the receipt keeps it as rulebook_decision
  const rbBefore = typeof r.details?.rulebook_decision === 'string' ? r.details.rulebook_decision : undefined;
  const rulebookDecision = autonomy?.changedFrom ?? (autoRule ? undefined : packRule ? rbBefore : r.decision);
  const byRerun = autoRule || packRule;
  const matchedRule = version?.rules.find((x) => x.id === (byRerun ? rerun?.ruleId : rule));
  const decideState: StepState = refuseAt === 'decide' ? 'refused' : refuseAt && idx(refuseAt) < idx('decide') ? 'not_reached' : rulebookDecision === 'ask' ? 'held' : 'passed';

  // autonomy step
  const autoInForce = !!autonomy?.applies;
  const autoState: StepState = refuseAt && idx(refuseAt) < idx('autonomy') ? 'not_reached' : !autoInForce ? 'not_in_force' : refuseAt === 'autonomy' ? 'refused' : autoRule && r.decision === 'ask' ? 'held' : 'passed';
  const autoDoc = AUTONOMY_LEVELS.find((l) => l.id === autonomy?.level);

  // pack step: from the receipt's own pack details (the packs admitted for this agent that cover the write)
  const pk = pr.ids.map((id) => ({ id, p: packs.find((x) => x.id === id) }));
  const packFlag = pr.result === 'would_refuse' || pr.result === 'would_hold';
  const packState: StepState = refuseAt && idx(refuseAt) < idx('pack') ? 'not_reached' : refuseAt === 'pack' ? 'refused' : packHeld ? 'held' : packFlag ? 'flagged' : 'passed';
  const packSummary = packState === 'not_reached' ? 'Not reached: the call was refused at an earlier step.'
    : refuseAt === 'pack' ? (r.reason ?? SYSTEM_RULES[rule])
    : packHeld ? `${r.reason ?? 'The pack needs a named person to decide this write.'}`
    : pr.result === 'would_refuse' ? `Dry run at L1: the pack would have refused this call. Nothing was refused.`
    : pr.result === 'would_hold' ? `Dry run at L1: the pack would have held this call for a named person. Nothing was held.`
    : pr.holdMet ? 'The pack needs a named person to decide this write; the rulebook’s hold meets that requirement.'
    : `${pk.map((x) => x.p?.name ?? x.id).join(' and ')} checked this write against ${pk.length === 1 ? 'its declaration' : 'their declarations'}; every check passed.`;

  const steps: Step[] = [
    {
      id: 'identify', title: 'Identify the agent key', state: st('identify'),
      summary: `The key was looked up by its SHA-256 hash and resolved to ${r.agent}.`,
      body: key ? <p>Key <span className="font-mono">{key.prefix}…</span> · {key.label} · {key.environment}</p> : undefined,
    },
    {
      id: 'paused', title: 'Paused? (stop check)', state: st('paused'),
      summary: refuseAt === 'paused' ? (r.reason ?? 'The agent was paused.') : 'The agent was active and no emergency stop was engaged.',
      exit: refuseAt === 'paused' ? { id: 'agent-paused', text: SYSTEM_RULES['agent-paused'] } : undefined,
    },
    {
      id: 'rulebook', title: signedLevel ? 'Load the signed rulebook' : 'Load the published rulebook', state: st('rulebook'),
      summary: r.rulebook ? `Version ${r.rulebook.version} loaded and its ${signedLevel ? 'signature' : 'seal'} verified before deciding.` : 'No rulebook version is named on this receipt.',
      body: r.rulebook && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Hash <Hash value={r.rulebook.hash} len={16} /></span>
          {hashOk !== undefined && (hashOk
            ? <Badge tone="ok">Matches version {r.rulebook.version} as published</Badge>
            : <Badge tone="bad">Does not match the stored version</Badge>)}
          {version?.signedBy && <span className="text-muted">{signedLevel ? 'signed' : 'published'} by {userName(version.signedBy)}{version.signedAt && `, ${dateTime(version.signedAt)}`}</span>}
        </div>
      ),
      exit: refuseAt === 'rulebook' ? { id: rule, text: SYSTEM_RULES[rule] ?? r.reason ?? '' } : undefined,
    },
    {
      id: 'tool', title: 'Resolve the tool', state: st('tool'),
      summary: refuseAt === 'tool' ? `${r.tool} is not a known, switched-on tool for this organisation.` : `${r.tool} is a known tool and is switched on.`,
      body: tags.length ? <span className="inline-flex flex-wrap gap-1">{tags.map((t) => <Badge key={t}>{tagLabel[t] ?? t}</Badge>)}</span> : undefined,
      exit: refuseAt === 'tool' ? { id: 'default', text: 'Unknown or switched-off tools are refused.' } : undefined,
    },
    {
      id: 'args', title: 'Validate the arguments', state: st('args'),
      summary: refuseAt === 'args' ? 'The arguments did not match the tool’s input schema.' : 'The arguments matched the tool’s input schema.',
      body: r.args_hash ? <span>Argument hash <Hash value={r.args_hash} len={16} /></span> : undefined,
      exit: refuseAt === 'args' ? { id: 'invalid-arguments', text: SYSTEM_RULES['invalid-arguments'] } : undefined,
    },
    {
      id: 'limits', title: 'Count the limits', state: st('limits'),
      summary: quotaRules.length ? `Counted against ${quotaRules.map((x) => `${x.id} (${describeQuota(x)})`).join('; ')}. A limit can only turn allow into ask, never loosen.` : 'No limit applies to this tool.',
    },
    {
      id: 'decide', title: 'Decide — strictest wins', state: decideState,
      summary: refuseAt && idx(refuseAt) < idx('decide') ? 'Not reached: the call was refused at an earlier step.'
        : autoRule ? `The rulebook decided ${rulebookDecision ?? 'first'}${rerun ? ` by ${rerun.ruleId}` : ''}. The autonomy grant was applied next.`
        : packRule ? `The rulebook decided ${rulebookDecision ?? 'first'}${rerun ? ` by ${rerun.ruleId}` : ''}. The regulatory pack check ran next.`
        : rule === 'default' ? 'No rule matched, so the default applied: refuse.'
        : `Rule ${rule} decided ${r.decision}. Refuse beats ask beats allow; ties go to the first rule.`,
      body: refuseAt && idx(refuseAt) < idx('decide') ? undefined : (
        <div className="space-y-2">
          {matchedRule && <p className="text-muted">“{matchedRule.reason}”</p>}
          {rerun ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border border-line">
                  <thead className="bg-sunken/70"><tr><th className="text-left px-2 py-1.5 label">Rule</th><th className="text-left px-2 py-1.5 label">Matches by</th><th className="text-left px-2 py-1.5 label">Re-run</th><th className="text-left px-2 py-1.5 label">Decides</th></tr></thead>
                  <tbody>
                    {rerun.matched.map((m) => (
                      <tr key={m.rule.id} className={cn('border-t border-line', m.rule.id === rerun.ruleId && 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--fg))]')}>
                        <td className="px-2 py-1.5 font-mono">{m.rule.id}</td>
                        <td className="px-2 py-1.5 font-mono text-muted">{m.rule.match.tool ? `tool ${m.rule.match.tool}` : `tag ${m.rule.match.tag}`}</td>
                        <td className={cn('px-2 py-1.5', m.outcome === 'matched' ? 'text-fg font-medium' : 'text-muted')}>{OUTCOME_LABEL[m.outcome]}</td>
                        <td className="px-2 py-1.5"><DecisionChip decision={m.rule.decide} size="sm" short /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">
                Re-run in this browser with <InlineCode>decide()</InlineCode> over version {version?.version}: {(byRerun ? rerun.decision === rulebookDecision : rerun.ruleId === rule && rerun.decision === r.decision) ? <span className="text-ok-fg font-medium">same answer — {rerun.decision} by {rerun.ruleId}.</span> : <>gives {rerun.decision} by {rerun.ruleId}. The receipt keeps only the values rules inspected, so a re-run can differ; the recorded decision stands.</>}
              </p>
            </>
          ) : <p className="text-xs text-muted">The rule set for this version is not available here, so decide() was not re-run.</p>}
        </div>
      ),
      exit: refuseAt === 'decide' ? { id: rule, text: ruleExitText(rule, r.reason, 'A rule refused this call.') } : undefined,
    },
    {
      id: 'autonomy', title: 'Apply the autonomy grant', state: autoState,
      summary: autoState === 'not_reached' ? 'Not reached: the call was refused at an earlier step.'
        : !autoInForce ? (autonomy?.why ?? 'Earned autonomy starts at L3 Proven. The rulebook decided alone.')
        : autoRule ? `${autonomy?.label} changed the rulebook’s ${rulebookDecision ?? ''} to ${r.decision}. ${SYSTEM_RULES[rule] ?? ''}`
        : `${autonomy?.label} was in force for ${r.tool}. ${autonomy?.level === 'A3' ? 'At A3 the rulebook decides unchanged.' : r.decision === 'refuse' ? 'A refusal is never relaxed.' : 'It did not change the decision.'}`,
      body: autoInForce ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusChip tone={autonomy?.hasGrant ? 'neutral' : 'held'} size="sm">{autonomy?.label}</StatusChip>
          {autoDoc && <span className="text-muted">{autoDoc.description}</span>}
          {autonomy?.grant && <span className="text-muted">{autonomy.grant.origin === 'start' ? 'Starting level, set by the platform at L3' : autonomy.grant.origin === 'graduation' ? `Graduated, approved by ${userName(autonomy.grant.grantedBy)}` : `Granted by ${userName(autonomy.grant.grantedBy)}`}, {dateTime(autonomy.grant.grantedAt)}{autonomy.grant.bound ? `, bound ${autonomy.grant.bound.field} ≤ ${rupees(autonomy.grant.bound.max)}` : ''}.</span>}
          {autonomy?.sealed && <span className="text-muted">Sealed as F11 <span className="font-mono">{autonomy.sealed}</span>.</span>}
          <SmartLink to="/agents/autonomy" hideWhenBlocked className="underline underline-offset-2 hover:text-fg">Autonomy grants</SmartLink>
        </div>
      ) : orgLevel && levelRank(orgLevel) < 2 ? (
        // owners see one line on the plan that adds earned autonomy; everyone else sees nothing
        <PlanUpsell to="l3" what="Earned autonomy (A2 Propose, A3 by a two-person graduation) is part of L3 Proven." />
      ) : undefined,
      exit: refuseAt === 'autonomy' ? { id: rule, text: SYSTEM_RULES[rule] ?? r.reason ?? '' } : undefined,
    },
    ...(order.includes('pack') ? [{
      id: 'pack' as StepId, title: 'Regulatory pack', state: packState,
      summary: packSummary,
      body: packState === 'not_reached' || !pk.length ? undefined : (
        <div className="space-y-3">
          {pk.map(({ id, p }) => (
            <div key={id} className="border border-line p-3">
              <p className="text-sm font-medium flex flex-wrap items-center gap-x-2 gap-y-1">
                <SmartLink to={`/records/packs/${id}`} plainClassName="font-mono" className="font-mono hover:underline underline-offset-2">{p?.name ?? id}</SmartLink>
                {p && <span className="text-muted font-normal">· {p.regime}</span>}
                <StatusChip tone="neutral" size="sm">{pr.dryRun ? 'Dry run at L1' : 'Live'}</StatusChip>
              </p>
              <p className="mt-1.5 text-xs text-muted">Admitted for this agent (an approved admission assessment on its AI system). Checked under <span className="font-mono">{pr.declarationOf(id) ?? `decl.${id}`}</span>, the declaration version in force for this call.</p>
              {p && p.gates.length > 0 && (
                <>
                  <p className="label mt-2 mb-1">Admission checks</p>
                  <div className="flex flex-wrap gap-1.5">{p.gates.map((g) => <StatusChip key={g.id} tone={g.state === 'met' ? 'ok' : g.state === 'provisional' ? 'held' : 'bad'} size="sm"><span className="font-mono">{g.id}</span> {g.label}{g.state === 'provisional' ? ' · provisional' : g.state === 'not_met' ? ' · not met' : ''}</StatusChip>)}</div>
                </>
              )}
            </div>
          ))}
          {(pr.rule || pr.wouldRefuse || pr.wouldHold || pr.holdMet) && (
            <ul className="space-y-1 text-xs">
              {pr.rule && <li><span className="label mr-1.5">Pack rule</span><span className="font-mono">{pr.rule}</span>{pr.failed.length > 1 && <span className="text-muted"> (also: {pr.failed.filter((x) => x !== pr.rule).join(', ')})</span>}</li>}
              {pr.wouldRefuse && <li className="text-muted">Would have refused — {pr.wouldRefuse}</li>}
              {pr.wouldHold && <li className="text-muted">Would have held — {pr.wouldHold}</li>}
              {pr.holdMet && <li className="text-muted">{pr.holdMet}</li>}
            </ul>
          )}
        </div>
      ),
      exit: refuseAt === 'pack' ? { id: rule, text: SYSTEM_RULES[rule] ?? r.reason ?? '' } : undefined,
    }] : []),
    {
      id: 'act', title: 'Act and write the receipt', state: 'passed',
      summary: r.decision === 'refuse' ? (governed ? 'Nothing ran. Elan1 Govern holds the credential, so a refused call cannot run.' : 'Elan1 Govern answered refuse and recorded it. In check and record, the agent holds its own credentials.')
        : r.decision === 'ask' ? `Held. An approval opened for ${String(r.details?.approver_group ?? 'the approver group')}; ${governed ? 'nothing runs until a person approves.' : 'the agent should wait for the answer before it runs the call.'}`
        : governed ? `Governed run: Elan1 Govern called the tool through its connector${r.outcome?.status === 'ok' ? ` — ran in ${n(r.outcome.ms ?? 0)} ms` : r.outcome?.status === 'error' ? ' — the tool returned an error' : ''}.` : 'Check and record: Elan1 Govern advises and records; the agent runs the call.',
      body: <p>Receipt <span className="font-mono">{seqLabel(r.seq)}</span> written: hash <Hash value={r.hash} len={12} copy={false} />, {signedLevel ? 'signed' : 'sealed'} by <span className="font-mono">{r.kid}</span>, linked to <span className="font-mono">{seqLabel(r.seq - 1)}</span>{level && levelRank(level) >= 1 ? ', then sealed (Seal v6) and batched for timestamping' : ''}.</p>,
    },
  ];
  // drawn in the guard's order
  steps.sort((a, b) => idx(a.id) - idx(b.id));

  return (
    <ol className="relative" aria-label="Decision path">
      {steps.map((s, i) => {
        const m = STATE_META[s.state];
        return (
          <li key={s.id} className="relative grid grid-cols-[36px_1fr] gap-x-4 pb-6 last:pb-0">
            {i < steps.length - 1 && <span className={cn('absolute left-[17px] top-9 bottom-0 w-px', s.state === 'refused' || s.state === 'not_reached' ? 'bg-line' : 'bg-fg/40')} aria-hidden />}
            <span className={cn('relative z-[1] flex h-9 w-9 items-center justify-center border font-display font-semibold num', m.box)} aria-hidden>{i + 1}</span>
            <div className={cn('min-w-0', (s.state === 'not_reached' || s.state === 'not_in_force') && 'opacity-70')}>
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                <h3 className="text-md font-semibold">{s.title}</h3>
                <StatusChip tone={m.tone} size="sm">{m.label}</StatusChip>
              </div>
              <p className="mt-1 text-sm text-muted leading-relaxed">{s.summary}</p>
              {s.body && <div className="mt-2 text-sm">{s.body}</div>}
              {s.exit && (
                <div className="mt-3 flex items-start gap-2 border border-bad/50 border-l-[3px] border-l-bad bg-bad-bg px-3 py-2.5">
                  <OctagonX className="h-4 w-4 text-bad-fg shrink-0 mt-0.5" aria-hidden />
                  <div className="min-w-0 text-sm">
                    <p className="font-semibold text-bad-fg flex flex-wrap items-center gap-1.5">Refusal exit <ArrowRight className="h-3.5 w-3.5" aria-hidden /> <span className="font-mono">{s.exit.id}</span></p>
                    <p className="text-fg/80 mt-0.5">{s.exit.text}</p>
                    <p className="text-xs text-muted mt-1">Every later step is skipped except writing the receipt. <Link to={`/activity?d=refuse&q=${encodeURIComponent(s.exit.id)}`} className="underline underline-offset-2 hover:text-fg">Other refusals by {s.exit.id}</Link></p>
                  </div>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** How many steps the trace draws for this receipt (for the panel kicker). */
export function traceStepCount(r: Receipt, _packs: (RegulatoryPack & { applies: boolean })[] = []) {
  // the pack step is drawn only when the receipt recorded a pack check (or a pack decided it)
  const pack = !!r.details?.packs || r.rule_id === 'pack-gate' || r.rule_id === 'pack-declaration';
  return 9 + (pack ? 1 : 0);
}
