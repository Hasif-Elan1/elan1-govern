import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Play, Plus, Trash2, Check, Minus, CircleSlash, HelpCircle, ArrowRight, RotateCcw, Info } from 'lucide-react';
import type { Agent, Condition, Rule } from '@/types';
import { api } from '@/api';
import { evaluate, type Evaluation } from '@/lib/evaluate';
import { cn } from '@/lib/cn';
import { tagLabel } from '@/lib/format';
import { useOrgId } from '@/store/session';
import { Badge, Button, Field, IconButton, Input, Panel, Select, Switch, StatusChip, EmptyState } from '@/components/ui';
import { TagList } from '@/components/domain';
import { DEFAULT_ARGS, allTools, coerce, groupName, toolByName, toolsForRule } from './lib';
import { OutcomeChip, ConditionPill } from './parts';
import { expandLists, namedLists } from '@/features/work/backend';

interface Row { key: string; value: string }

const toRows = (o: Record<string, string>): Row[] => Object.entries(o).map(([key, value]) => ({ key, value }));

/** A value that makes the condition hold — used to build an example call for a rule. Named lists come from the organisation. */
function satisfying(c: Condition, lists: Record<string, string[]>): string {
  const v = c.value;
  if (Array.isArray(v)) {
    const first = v[0] ?? '';
    const listed = lists[first]?.[0];
    if (c.op === 'to_domain_in') return `accounts@${listed ? (listed.includes('.') ? listed : `${listed}.in`) : first}`;
    return listed ?? first;
  }
  if (typeof v === 'number') {
    if (c.op === 'gt') return String(v + 1);
    if (c.op === 'lt') return String(v - 1);
    return String(v);
  }
  return String(v);
}

/** Example arguments for a tool: what this agent last sent (from its receipts), else the catalogue's example, else the fields its rules read. */
function exampleArgs(tool: string, recent?: Record<string, string | number | boolean>, rules: Rule[] = []): Record<string, string> {
  if (recent && Object.keys(recent).length) return Object.fromEntries(Object.entries(recent).map(([k, v]) => [k, String(v)]));
  if (DEFAULT_ARGS[tool]) return { ...DEFAULT_ARGS[tool] };
  const tags = toolByName(tool)?.tags ?? [];
  const fields = rules.filter((r) => r.match.tool === tool || (r.match.tag && tags.includes(r.match.tag))).flatMap((r) => [...(r.when ?? []), ...(r.unless ?? [])].map((c) => c.field));
  return Object.fromEntries(Array.from(new Set(fields)).map((f) => [f, '']));
}

export function argsForRule(rule: Rule, agentTools: string[], lists: Record<string, string[]> = {}): { tool: string; args: Record<string, string> } {
  const TOOLS = allTools();
  const tool = rule.match.tool ?? toolsForRule(rule, agentTools)[0]?.name ?? TOOLS.find((t) => rule.match.tag && t.tags.includes(rule.match.tag))?.name ?? agentTools[0] ?? TOOLS[0].name;
  const args = exampleArgs(tool, undefined, [rule]);
  for (const c of rule.when ?? []) if (c.op !== 'fields_include') args[c.field] = satisfying(c, lists);
  return { tool, args };
}

type Outcome = Evaluation['matched'][number]['outcome'];
const OUTCOME_UI: Record<Outcome, { label: string; cls: string; icon: ReactNode }> = {
  matched: { label: 'Applies', cls: 'text-fg', icon: <Check className="h-3.5 w-3.5 text-ok-fg" aria-hidden /> },
  conditions_failed: { label: 'Conditions not met', cls: 'text-muted', icon: <Minus className="h-3.5 w-3.5 text-bad-fg" aria-hidden /> },
  not_applicable: { label: 'Not this tool', cls: 'text-subtle', icon: <CircleSlash className="h-3.5 w-3.5" aria-hidden /> },
  unknown_field: { label: 'Missing argument', cls: 'text-held-fg', icon: <HelpCircle className="h-3.5 w-3.5" aria-hidden /> },
};

export function TryTab({ rules, publishedRules, publishedVersion, draftVersionNo, agent, seed, lists }: {
  rules: Rule[]; publishedRules?: Rule[]; publishedVersion?: number; draftVersionNo: number; agent: Agent; seed?: { tool: string; args: Record<string, string>; n: number }; lists: Record<string, string[]>;
}) {
  const orgId = useOrgId();
  const TOOLS = allTools();
  const currentLists = Object.keys(lists).length ? lists : namedLists(orgId);
  const firstTool = agent.tools[0] ?? TOOLS[0].name;
  const [tool, setTool] = useState(firstTool);
  const [rows, setRows] = useState<Row[]>(toRows(exampleArgs(firstTool, undefined, rules)));
  // the agent's own last call to each tool supplies realistic example arguments
  const [recent, setRecent] = useState<Record<string, Record<string, string | number | boolean>>>({});
  useEffect(() => {
    let live = true;
    api.receipts(orgId, { agent: agent.slug, kind: 'decision', limit: 400 }).then((r) => {
      if (!live) return;
      const m: Record<string, Record<string, string | number | boolean>> = {};
      for (const x of r.items) if (x.tool && x.args_summary && !m[x.tool]) m[x.tool] = x.args_summary;
      setRecent(m);
      if (!seed && m[firstTool]) setRows(toRows(exampleArgs(firstTool, m[firstTool])));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [orgId, agent.slug]);
  const [result, setResult] = useState<{ draft: Evaluation; published?: Evaluation; tool: string; args: Record<string, unknown> }>();
  const [onlyApplicable, setOnlyApplicable] = useState(false);

  useEffect(() => {
    if (!seed) return;
    setTool(seed.tool);
    setRows(toRows(seed.args));
    setResult(undefined);
  }, [seed]);

  const args = useMemo(() => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), coerce(r.value)])), [rows]);

  // Fields read by rules that reach this tool, so the person knows what to fill in.
  const tags = toolByName(tool)?.tags ?? [];
  const readFields = useMemo(() => {
    const reach = rules.filter((r) => (r.match.tool ? r.match.tool === tool : r.match.tag ? tags.includes(r.match.tag) : false));
    return Array.from(new Set(reach.flatMap((r) => [...(r.when ?? []), ...(r.unless ?? [])].map((c) => c.field))));
  }, [rules, tool, tags]);
  const missing = readFields.filter((f) => !(f in args));

  // named lists are expanded to this organisation's values before the rules are evaluated
  const run = () => {
    // quotas are counted against this agent's recorded decisions in the window, as the live guard counts them
    const ctx = { orgId, agentSlug: agent.slug };
    const draft = api.tryAction(expandLists(rules, currentLists), tool, args, ctx);
    const published = publishedRules ? api.tryAction(expandLists(publishedRules, currentLists), tool, args, ctx) : undefined;
    setResult({ draft, published, tool, args });
  };

  const pickTool = (t: string) => {
    setTool(t);
    setRows(toRows(exampleArgs(t, recent[t], rules)));
    setResult(undefined);
  };

  const condState = (rule: Rule, c: Condition) => {
    if (!result) return undefined;
    const e = evaluate(expandLists([{ id: '_', match: rule.match, when: [c], decide: 'allow', reason: '' }], currentLists), result.tool, result.args);
    const o = e.matched[0]?.outcome;
    return o === 'matched' ? true : o === 'conditions_failed' ? false : undefined;
  };

  const examples = rules.filter((r) => r.decide !== 'allow' || r.when?.length).slice(0, 6).map((r) => {
    const ex = argsForRule(r, agent.tools, currentLists);
    const base = recent[ex.tool] ? exampleArgs(ex.tool, recent[ex.tool]) : {};
    return { rule: r, tool: ex.tool, args: { ...base, ...ex.args } };
  });
  const changed = result?.published && (result.published.decision !== result.draft.decision || result.published.ruleId !== result.draft.ruleId);
  const winner = result?.draft.ruleId;
  const trace = result ? result.draft.matched.filter((m) => !onlyApplicable || m.outcome !== 'not_applicable') : [];

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="lg:col-span-5 space-y-6 min-w-0">
        <Panel title="A made-up call" kicker={`Against draft v${draftVersionNo}`}>
          <div className="space-y-5">
            <Field label="Tool" htmlFor="try-tool" hint={<span className="inline-flex flex-wrap items-center gap-1.5">{toolByName(tool)?.description}. <TagList tags={tags} /></span>}>
              <Select id="try-tool" value={tool} onChange={(e) => pickTool(e.target.value)} className="font-mono text-sm">
                <optgroup label={`Tools ${agent.slug} uses`}>{TOOLS.filter((t) => agent.tools.includes(t.name)).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</optgroup>
                <optgroup label="Other tools">{TOOLS.filter((t) => !agent.tools.includes(t.name)).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</optgroup>
              </Select>
            </Field>

            <fieldset>
              <legend className="text-sm font-medium mb-1.5">Arguments</legend>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_auto] gap-2">
                    <Input aria-label={`Argument ${i + 1} name`} mono className="h-9" value={r.key} placeholder="name" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                    <Input aria-label={`Argument ${i + 1} value`} mono className="h-9" value={r.value} placeholder="value" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} onKeyDown={(e) => e.key === 'Enter' && run()} />
                    <IconButton label={`Remove ${r.key || 'argument'}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setRows([...rows, { key: '', value: '' }])}>Add argument</Button>
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => pickTool(tool)}>Reset</Button>
                </div>
              </div>
              {readFields.length > 0 && (
                <p className="mt-3 text-xs text-muted flex flex-wrap items-center gap-1.5">
                  Rules for this tool read
                  {readFields.map((f) => (
                    <button key={f} type="button" disabled={!missing.includes(f)} onClick={() => setRows([...rows, { key: f, value: '' }])}
                      className={cn('font-mono px-1.5 h-6 border', missing.includes(f) ? 'border-held/50 bg-held-bg text-held-fg hover:border-held' : 'border-line text-muted')}
                      title={missing.includes(f) ? `Add ${f} — missing arguments never hold` : `${f} is set`}>
                      {missing.includes(f) ? '+ ' : ''}{f}
                    </button>
                  ))}
                </p>
              )}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" icon={<Play className="h-4 w-4" />} onClick={run}>Try this action</Button>
              <span className="text-xs text-muted">Runs nothing and writes no receipt.</span>
            </div>
          </div>
        </Panel>

        {examples.length > 0 && (
          <Panel title="Examples from these rules" kicker="One click fills the call" flush>
            <ul className="divide-y divide-line">
              {examples.map((ex) => (
                <li key={ex.rule.id}>
                  <button type="button" className="w-full text-left px-5 py-3 hover:bg-sunken/60 focus:bg-sunken/60 flex items-center justify-between gap-3"
                    onClick={() => { setTool(ex.tool); setRows(toRows(ex.args)); setResult(undefined); }}>
                    <span className="min-w-0">
                      <span className="block font-mono text-[12.5px] truncate">{ex.tool}</span>
                      <span className="block text-xs text-muted truncate">{Object.entries(ex.args).map(([k, v]) => `${k}=${v}`).join(' · ')}</span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0"><span className="font-mono text-xs text-subtle hidden sm:inline">{ex.rule.id}</span><ArrowRight className="h-4 w-4 text-subtle" aria-hidden /></span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      <div className="lg:col-span-7 space-y-6 min-w-0" aria-live="polite">
        {!result ? (
          <div className="border border-line bg-surface">
            <EmptyState title="Try a call before you publish" disc="gate">
              Pick a tool, fill in the arguments an agent would send and run it against the draft. You see the decision, the rule that decided it and why every other rule did or did not apply.
            </EmptyState>
          </div>
        ) : (
          <>
            <Panel title="Decision" kicker={`Draft v${draftVersionNo}`}>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                <div className="space-y-2">
                  <OutcomeChip decision={result.draft.decision} size="md" />
                  <p className="text-sm">Decided by <span className="font-mono font-semibold">{result.draft.ruleId}</span></p>
                </div>
                <div className="min-w-0 flex-1 basis-[240px]">
                  <p className="text-md leading-relaxed">{result.draft.reason}</p>
                  {result.draft.decision === 'ask' && (() => {
                    const r = rules.find((x) => x.id === result.draft.ruleId);
                    return r ? <p className="mt-2 text-sm text-muted">Held for {groupName(r.approver)}. Expires after {r.expiresIn ?? '24h'}, then refused. {r.approveInChat ? 'Can be approved in chat.' : 'Decided in the console or by email link.'}</p> : null;
                  })()}
                  {result.draft.decision === 'allow' && <p className="mt-2 text-sm text-muted">{agent.route === 'mcp' ? 'On the governed run, Elan1 Govern would run the call with the credential it holds.' : 'On check and record, Elan1 Govern advises and records; the agent runs the call.'}</p>}
                </div>
              </div>
              {result.published && (
                <div className={cn('mt-5 flex flex-wrap items-center gap-3 border px-4 py-3 text-sm', changed ? 'border-line-strong/60 bg-sunken/60' : 'border-line')}>
                  <span className="label">Published v{publishedVersion}</span>
                  <OutcomeChip decision={result.published.decision} />
                  <span className="font-mono text-[12.5px] text-muted">{result.published.ruleId}</span>
                  <span className="ml-auto">{changed ? <Badge tone="inverse">Draft decides differently</Badge> : <Badge>Same decision</Badge>}</span>
                </div>
              )}
            </Panel>

            <Panel title="Trace" kicker="Every rule, in order" actions={<span className="flex items-center gap-2 text-xs text-muted">Only rules for this tool <Switch label="Only rules for this tool" checked={onlyApplicable} onChange={setOnlyApplicable} showState={false} /></span>} flush>
              <ol className="divide-y divide-line">
                {trace.map(({ rule, outcome }) => {
                  const ui = OUTCOME_UI[outcome];
                  const missingFields = outcome === 'unknown_field' ? (rule.when ?? []).filter((c) => condState(rule, c) === undefined).map((c) => c.field) : [];
                  const unlessApplied = outcome === 'conditions_failed' && rule.decide === 'ask' && (rule.when ?? []).every((c) => condState(rule, c) === true);
                  const isWinner = rule.id === winner && outcome === 'matched';
                  return (
                    <li key={rule.id} className={cn('px-5 py-3', isWinner && 'bg-sunken/60 shadow-[inset_3px_0_0_rgb(var(--fg))]')}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium w-[170px]', ui.cls)}>{ui.icon}{unlessApplied ? 'Exception holds' : ui.label}</span>
                        <span className="font-mono text-[12.5px] font-semibold">{rule.id}</span>
                        <OutcomeChip decision={rule.decide} />
                        {isWinner && <Badge tone="inverse">Decides</Badge>}
                        {outcome === 'matched' && !isWinner && <span className="text-xs text-muted">applies, but a stricter rule wins</span>}
                      </div>
                      {outcome !== 'not_applicable' && (rule.when?.length || missingFields.length) ? (
                        <div className="mt-2 pl-0 sm:pl-[182px] flex flex-wrap gap-1.5">
                          {(rule.when ?? []).map((c, i) => <ConditionPill key={i} c={c} state={condState(rule, c)} />)}
                          {missingFields.length > 0 && <span className="text-xs text-held-fg self-center">Not in the call: {missingFields.join(', ')}. A missing argument never holds.</span>}
                        </div>
                      ) : null}
                      {outcome === 'not_applicable' && (
                        <p className="mt-1 sm:pl-[182px] text-xs text-subtle">{rule.match.tool ? `Matches ${rule.match.tool} only.` : `Matches tools tagged ${tagLabel[rule.match.tag!]}; ${result.tool} is not.`}</p>
                      )}
                    </li>
                  );
                })}
                <li className={cn('px-5 py-3', winner === 'default' && 'bg-sunken/60 shadow-[inset_3px_0_0_rgb(var(--fg))]')}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium w-[170px]">{winner === 'default' ? <Check className="h-3.5 w-3.5 text-ok-fg" aria-hidden /> : <Info className="h-3.5 w-3.5 text-subtle" aria-hidden />}{winner === 'default' ? 'Applies' : 'Not needed'}</span>
                    <span className="font-mono text-[12.5px] font-semibold">default</span>
                    <StatusChip tone="bad" size="sm">Refuse</StatusChip>
                    {winner === 'default' && <Badge tone="inverse">Decides</Badge>}
                  </div>
                  <p className="mt-1 sm:pl-[182px] text-xs text-muted">Anything no rule allows is refused.</p>
                </li>
              </ol>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
