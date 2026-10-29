import { useState } from 'react';
import { Link } from 'react-router-dom';
import { stringify } from 'yaml';
import { ArrowDown, ArrowUp, Copy, Lock, MoreHorizontal, Pencil, Plus, Trash2, History, Hourglass, FlaskConical, Package, ListChecks, Sparkles } from 'lucide-react';
import { useUi } from '@/store/ui';
import type { Agent, Decision, PackId, Rule, RulebookVersion } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { PACKS } from '@/lib/packs';
import { cn } from '@/lib/cn';
import { n, plural, rupees } from '@/lib/format';
import { Badge, Banner, Button, EmptyState, Field, IconButton, Menu, Panel, Segmented, Skeleton, StatusChip, Textarea, toast } from '@/components/ui';
import { Person, When } from '@/components/domain';
import { OUTCOME, builderExtra, hasForeignExtras, orgGroups } from './lib';
import { DiffBadge, HitsLine, RuleBody, SemanticDiffList, YamlEditedBadge, diffByRule } from './parts';
import { RuleDialog } from './RuleDialog';
import type { Extras } from './yamlSync';
import { setNamedList } from '@/features/work/backend';
import { packConfig } from '@/features/packs/config';
import { SmartLink, useCanSee } from '@/shell/access';

export interface RuleHits { [ruleId: string]: { count: number; last?: string } }

function uniqueId(base: string, taken: string[]) {
  let i = 2;
  let id = `${base}-copy`;
  while (taken.includes(id)) id = `${base}-copy-${i++}`;
  return id;
}

/**
 * A regulatory pack's rule set, added to a rulebook as a locked section. At L1 the section is a dry run: every rule
 * is marked simulate, so it never decides a call (the guard notes on the receipt what it would have decided). From
 * L2 the rules decide like any other.
 */
function packRules(id: PackId, orgId: string, dryRun = false): Rule[] {
  const rules = packRulesLive(id, orgId);
  return dryRun ? rules.map((r) => ({ ...r, mode: 'simulate' as const, reason: `Dry run at L1 (never refuses or holds a call): ${r.reason}` })) : rules;
}

function packRulesLive(id: PackId, orgId: string): Rule[] {
  switch (id) {
    case 'ledger1': {
      // the configured 'Second person above' amount (a new declaration version each time it changes)
      const cfg = packConfig(orgId, 'ledger1');
      const above = cfg.values.dualControlAbove ?? PACKS.find((x) => x.id === id)?.declaration.dualControlAbove ?? 200000;
      return [
        { id: 'ledger1-no-deletes', match: { tag: 'deletes' }, decide: 'refuse', reason: 'ledger1 (MCA audit trail, Rule 3(1)): books are never deleted by an agent; a cancellation is a reversal.' },
        { id: 'ledger1-dual-control', match: { tag: 'moves_money' }, when: [{ field: 'amount', op: 'gt', value: above }], decide: 'ask', approver: 'finance', expiresIn: '24h', approveInChat: false, reason: `ledger1 declaration v${cfg.version} declares a person for postings above ${rupees(above)}.` },
      ];
    }
    case 'invoice1':
      return [
        { id: 'invoice1-no-delete', match: { tool: 'zoho_books.delete_bill' }, decide: 'refuse', reason: 'invoice1 (GST e-invoicing, Rule 48(4)): invoices and bills are cancelled within 24 hours, never deleted by an agent.' },
      ];
    case 'collect1':
      return [
        { id: 'collect1-final-notice', match: { tool: 'gmail.send_email' }, when: [{ field: 'template', op: 'eq', value: 'final_notice' }], decide: 'ask', approver: 'finance', expiresIn: '24h', approveInChat: false, reason: 'collect1 (RBI collections conduct): a final notice is approved by a named person.' },
      ];
  }
}

export function RulesTab({ rules, extras, editable, readOnlyReason: _readOnlyReason, publishedRules, publishedVersion, agent, hits, pendingByRule, onChange, viewing, onTry, lists, onListsChanged }: {
  rules: Rule[]; extras: Extras; editable: boolean; readOnlyReason?: string;
  publishedRules?: Rule[]; publishedVersion?: number; agent: Agent; hits: RuleHits; pendingByRule: Record<string, number>;
  onChange: (rules: Rule[], extras: Extras) => void;
  viewing?: { version: RulebookVersion; onRestore?: () => void };
  onTry: (rule: Rule) => void;
  lists: Record<string, string[]>;
  onListsChanged?: (lists: Record<string, string[]>) => void;
}) {
  const level = useOrgLevel();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const sl = atLeast(level, 'l2');
  const orgId = useOrgId();
  const [editing, setEditing] = useState<{ rule?: Rule; index?: number } | null>(null);
  const [filter, setFilter] = useState<'all' | Decision>('all');
  const canEdit = editable && !viewing;
  const canSeePeople = useCanSee('/agents/people');
  const diffs =publishedRules && !viewing ? diffByRule(publishedRules, rules) : {};
  const ids = rules.map((r) => r.id);
  const shown = rules.map((r, i) => ({ r, i })).filter(({ r }) => filter === 'all' || r.decide === filter);
  const members = useQuery((o) => api.members(o), [], { live: false });
  // packs install from L1 as a dry run, so their locked sections can be added at every level
  const packsQ = useQuery((o) => api.packs(o), [level]);
  const packDry = !atLeast(level, 'l2');
  const isLocked = (id: string) => builderExtra(extras.rules[id]).locked === true;
  const openAsk = useUi((s) => s.openAsk);
  const askAbout = (r: Rule) => openAsk({ kind: 'rule', title: `Rule ${r.id}`, payload: {
    rule: r, extra: extras.rules[r.id], agentSlug: agent.slug, agentTools: agent.tools, hits: hits[r.id], pending: pendingByRule[r.id],
    diff: diffs[r.id], publishedVersion,
  } });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    const next = rules.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next, extras);
  };
  const remove = (i: number) => {
    const prev = rules;
    const prevExtras = extras;
    const r = rules[i];
    const { [r.id]: _dropped, ...rest } = extras.rules;
    onChange(rules.filter((_, j) => j !== i), { ...extras, rules: rest });
    toast.info(`Rule ${r.id} removed from the draft`, `Nothing changes for the agent until a version is ${sl ? 'signed and published' : 'published'}.`, { label: 'Undo', onClick: () => onChange(prev, prevExtras) });
  };
  const duplicate = (i: number) => {
    const r = rules[i];
    const copy: Rule = { ...structuredClone(r), id: uniqueId(r.id, ids) };
    const next = rules.slice();
    next.splice(i + 1, 0, copy);
    const ex = extras.rules[r.id] ? { ...extras, rules: { ...extras.rules, [copy.id]: { ...structuredClone(extras.rules[r.id]), locked: undefined, pack: undefined } } } : extras;
    onChange(next, ex);
    setEditing({ rule: copy, index: i + 1 });
  };
  const save = (rule: Rule, previousId: string | undefined, extra: Record<string, unknown>) => {
    const next = rules.slice();
    if (editing?.index !== undefined && editing.index < rules.length && rules[editing.index]?.id === (previousId ?? rule.id)) next[editing.index] = rule;
    else next.push(rule);
    const restRules = { ...extras.rules };
    if (previousId && previousId !== rule.id) delete restRules[previousId];
    const clean = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length) restRules[rule.id] = clean; else delete restRules[rule.id];
    onChange(next, { ...extras, rules: restRules });
    toast.ok(previousId ? `Rule ${rule.id} updated in the draft` : `Rule ${rule.id} added to the draft`, 'Save the draft to keep it. Try an action to see how it decides.');
  };

  const installed = (packsQ.data ?? []).filter((p) => p.installed);
  const addPack = (id: PackId) => {
    const add = packRules(id, orgId, packDry).filter((r) => !ids.includes(r.id));
    if (!add.length) return;
    const ex = { ...extras.rules };
    for (const r of add) ex[r.id] = { pack: id, locked: true };
    onChange([...rules, ...add], { ...extras, rules: ex });
    toast.ok(`${id} rules added as a locked section${packDry ? ' (dry run)' : ''}`, packDry
      ? `${plural(add.length, 'rule')} from the pack's rule set, marked dry run: at L1 they never refuse or hold a call, and each receipt notes what they would have decided. Save, test and publish them like any change.`
      : `${plural(add.length, 'rule')} from the pack's rule set. Save, test and publish them like any change.`);
  };
  const refreshPack = (id: PackId) => {
    const fresh = new Map(packRules(id, orgId, packDry).map((r) => [r.id, r]));
    onChange(rules.map((r) => (builderExtra(extras.rules[r.id]).pack === id && fresh.has(r.id) ? fresh.get(r.id)! : r)), extras);
    toast.ok(`${id} rules updated to the current parameters`, packDry ? 'Still a dry run at L1. Save, test and publish them like any change.' : 'They decide calls once published. Save, test and publish them like any change.');
  };
  const removePack = (id: PackId) => {
    const keep = rules.filter((r) => builderExtra(extras.rules[r.id]).pack !== id);
    const ex = Object.fromEntries(Object.entries(extras.rules).filter(([k]) => keep.some((r) => r.id === k)));
    onChange(keep, { ...extras, rules: ex });
    toast.info(`${id} rules removed from the draft`, 'Nothing changes until a version is published.');
  };

  const groups = orgGroups();
  const usedGroups = groups.filter((g) => rules.some((r) => r.approver === g.id || builderExtra(extras.rules[r.id]).escalate_to === g.id));
  const removed = publishedRules && !viewing ? publishedRules.filter((p) => !ids.includes(p.id)) : [];
  const statusOf = (uid: string) => members.data?.find((m) => m.userId === uid)?.status;

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="lg:col-span-8 min-w-0 space-y-4">
        {viewing && (
          <Banner tone="neutral" title={`You are reading version ${viewing.version.version} (${viewing.version.status === 'published' ? 'published' : 'draft'}) — read only`}
            actions={viewing.onRestore ? <Button size="sm" variant="secondary" icon={<History className="h-4 w-4" />} onClick={viewing.onRestore}>Copy into the draft</Button> : undefined}>
            Edits always go to the working draft. Copying this version into the draft lets you roll back by publishing it as a new {sl ? 'signed ' : ''}version.
          </Banner>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented size="sm" label="Filter rules by outcome" value={filter} onChange={setFilter} options={[
            { value: 'all', label: 'All', count: rules.length },
            { value: 'allow', label: 'Allow', count: rules.filter((r) => r.decide === 'allow').length },
            { value: 'ask', label: 'Ask', count: rules.filter((r) => r.decide === 'ask').length },
            { value: 'refuse', label: 'Refuse', count: rules.filter((r) => r.decide === 'refuse').length },
          ]} />
          {canEdit && (
            <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>Add rule</Button>
          )}
        </div>

        {rules.length === 0 && (
          <div className="border border-line bg-surface">
            <EmptyState compact title="No rules yet" disc="gate" action={canEdit ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>Add the first rule</Button> : undefined}>
              With no rules, the default refuses every call. Start with what the agent should be allowed to read.
            </EmptyState>
          </div>
        )}

        <ol className="space-y-3" aria-label="Rules, in reading order">
          {shown.map(({ r, i }) => {
            const m = OUTCOME[r.decide];
            const edited = hasForeignExtras(extras.rules[r.id]);
            const locked = isLocked(r.id);
            const pack = builderExtra(extras.rules[r.id]).pack;
            return (
              <li key={r.id + i} className={cn('relative bg-surface border border-line border-l-[3px]', m.edge, locked && 'bg-sunken/30')}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-2 border-b border-line">
                  <span className="font-mono text-xs text-subtle num w-6">{String(i + 1).padStart(2, '0')}</span>
                  <h3 className="font-mono text-[13.5px] font-semibold tracking-normal break-all">{r.id}</h3>
                  {diffs[r.id] && <DiffBadge kind={diffs[r.id]} />}
                  {edited && <YamlEditedBadge />}
                  {locked && <Badge icon={<Lock className="h-3 w-3" aria-hidden />} title="Part of a regulatory pack's signed rule set. Remove the whole pack section to change it.">{pack ?? 'Pack'} · locked{r.mode === 'simulate' ? ' · dry run' : ''}</Badge>}
                  {pendingByRule[r.id] ? (
                    <SmartLink to="/approvals" plainClassName="inline-flex items-center gap-1 text-xs text-held-fg" className="inline-flex items-center gap-1 text-xs text-held-fg hover:underline"><Hourglass className="h-3 w-3" aria-hidden />{plural(pendingByRule[r.id], 'approval')} waiting</SmartLink>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1">
                    <span className="hidden sm:inline mr-2"><HitsLine hits={hits[r.id]} /></span>
                    {canEdit && filter === 'all' && (
                      <>
                        <IconButton size="sm" label={`Move ${r.id} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                        <IconButton size="sm" label={`Move ${r.id} down`} disabled={i === rules.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                      </>
                    )}
                    <IconButton size="sm" label={`Ask Govern to explain rule ${r.id}`} title="Ask Govern" onClick={() => askAbout(r)}><Sparkles className="h-4 w-4" /></IconButton>
                    <Menu width={220} trigger={({ toggle }) => <IconButton size="sm" label={`Actions for ${r.id}`} onClick={toggle}><MoreHorizontal className="h-4 w-4" /></IconButton>} items={[
                      { label: 'Try an action with this rule', icon: <FlaskConical className="h-4 w-4" />, onSelect: () => onTry(r) },
                      ...(canEdit && !locked ? [
                        'sep' as const,
                        { label: 'Edit', icon: <Pencil className="h-4 w-4" />, onSelect: () => setEditing({ rule: r, index: i }) },
                        { label: 'Duplicate', icon: <Copy className="h-4 w-4" />, onSelect: () => duplicate(i) },
                        { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: () => remove(i) },
                      ] : canEdit && locked ? [
                        'sep' as const,
                        { label: 'Duplicate as an editable rule', icon: <Copy className="h-4 w-4" />, onSelect: () => duplicate(i) },
                      ] : []),
                    ]} />
                  </span>
                </div>
                <div className={cn('px-4 py-3', canEdit && !locked && 'hover:bg-sunken/30')} onDoubleClick={canEdit && !locked ? () => setEditing({ rule: r, index: i }) : undefined} title={canEdit && !locked ? 'Double-click to edit' : undefined}>
                  <RuleBody rule={r} agentTools={agent.tools} extra={extras.rules[r.id]} />
                  <div className="sm:hidden mt-2"><HitsLine hits={hits[r.id]} /></div>
                </div>
              </li>
            );
          })}

          {removed.map((r) => (
            <li key={`removed-${r.id}`} className="relative border border-dashed border-line-strong/50 bg-clay-100/30 dark:bg-clay-900/20 px-4 py-3 flex flex-wrap items-center gap-3">
              <DiffBadge kind="removed" />
              <span className="font-mono text-[13px] line-through text-muted">{r.id}</span>
              <span className="text-sm text-muted">In published version {publishedVersion}; removed in this draft.</span>
            </li>
          ))}

          <li className="relative bg-sunken/60 border border-line border-l-[3px] border-l-bad">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="font-mono text-xs text-subtle w-6"><Lock className="h-3.5 w-3.5" aria-label="Locked" /></span>
              <h3 className="text-sm font-semibold">Default — refuse anything not explicitly allowed</h3>
              <span className="ml-auto"><HitsLine hits={hits.default} /></span>
            </div>
            <p className="px-4 pb-3 -mt-1 text-sm text-muted pl-[52px]">Always last and cannot be removed. A call that no rule allows — a new tool, a missing argument, an unknown field — is refused and recorded with rule id <span className="font-mono">default</span>.</p>
          </li>
        </ol>
      </div>

      <aside className="lg:col-span-4 space-y-6 min-w-0">
        <Panel title="How a decision is made" kicker="Every call">
          <ol className="space-y-3 text-sm">
            {[
              sl
                ? ['Check the signature', 'The published version is signed. The guard verifies it on every call; an invalid rulebook refuses everything.']
                : ['Check the seal', 'The published version is sealed with Ed25519. The guard verifies it on every call; an invalid rulebook refuses everything.'],
              ['Find the rules that apply', 'A rule applies when its tool or risk tag matches and every condition holds. A missing argument never holds.'],
              ['Strictest wins', 'Refuse over ask over allow. Order on this page is for reading; it does not change the outcome.'],
              ...(atLeast(level, 'l3') ? [['Apply the agent’s autonomy', 'At Proven the tool’s autonomy level is applied after the rulebook. Writes start at A2 (a person approves each one); A3 is reached only by a two-person graduation. A4 and A5 are not yet available. A refusal is never relaxed.']] : []),
              ['Otherwise refuse', `If nothing applies, the default refuses. Every decision is ${sl ? 'a signed, hash-chained receipt' : 'a receipt sealed in the hash chain'}.`],
            ].map(([t, d], i) => (
              <li key={t} className="grid grid-cols-[22px_1fr] gap-2">
                <span className="font-mono text-xs text-accent-fg num pt-0.5">{i + 1}</span>
                <span><span className="font-medium">{t}.</span> <span className="text-muted">{d}</span></span>
              </li>
            ))}
          </ol>
        </Panel>

        {publishedRules && !viewing && (
          <Panel title={`Against published v${publishedVersion}`} kicker="What this draft changes">
            <SemanticDiffList before={publishedRules} after={rules} emptyText="The draft matches the published version." />
          </Panel>
        )}

        <Panel title="Approver groups" kicker="Who decides held calls" flush footer={canSeePeople ? <Link to="/agents/people" className="link">People and roles</Link> : undefined}>
          {usedGroups.length ? (
            <ul className="divide-y divide-line">
              {usedGroups.map((g) => {
                const active = g.members.filter((m) => (statusOf(m) ?? 'active') === 'active').length;
                return (
                  <li key={g.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{g.name} <span className="font-mono text-xs text-subtle">{g.id}</span></span>
                      <span className="text-xs text-muted">{plural(rules.filter((r) => r.approver === g.id).length, 'rule')}</span>
                    </div>
                    {active === 0 ? <StatusChip className="mt-1.5" tone="bad" size="sm">No active member — blocks publishing</StatusChip> : active === 1 ? <StatusChip className="mt-1.5" tone="held" size="sm">One active member — add a backup group</StatusChip> : null}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-2">
                      {g.members.map((m) => (
                        <span key={m} className="inline-flex items-center gap-1.5">
                          <Person id={m} size={20} />
                          {statusOf(m) && statusOf(m) !== 'active' && <Badge tone="held">{statusOf(m) === 'suspended' ? 'Suspended' : 'Invited'}</Badge>}
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-muted">No ask rules, so no one is asked. Calls are allowed or refused.</p>}
          {members.loading && !members.data && <div className="px-5 pb-3"><Skeleton className="h-4 w-40" /></div>}
        </Panel>

        <Panel title="Regulatory pack rules" kicker={packDry ? 'Locked sections · dry run at L1' : 'Locked sections'} flush
          footer={packDry ? <span>At L1 a pack section is a dry run: its rules never refuse or hold a call, and each receipt notes what they would have decided. They decide calls from {LEVEL_INFO.l2.label}; then choose “Use current parameters” to turn the section live.</span> : undefined}>
            {packsQ.loading && !packsQ.data ? <div className="p-5"><Skeleton className="h-16" /></div> : packsQ.error ? (
              <p className="px-5 py-4 text-sm text-bad-fg">Packs could not be read. {packsQ.error.message}</p>
            ) : installed.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">No regulatory pack is installed. <SmartLink to="/records/packs" hideWhenBlocked className="link">Regulatory packs</SmartLink></p>
            ) : (
              <ul className="divide-y divide-line">
                {installed.map((p) => {
                  const inDraft = rules.some((r) => builderExtra(extras.rules[r.id]).pack === p.id);
                  const fresh = packRules(p.id, orgId, packDry);
                  const stale = inDraft && fresh.some((fr) => { const cur = rules.find((r) => r.id === fr.id); return !!cur && JSON.stringify(cur) !== JSON.stringify(fr); });
                  const dryInDraft = rules.some((r) => builderExtra(extras.rules[r.id]).pack === p.id && r.mode === 'simulate');
                  return (
                    <li key={p.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium"><Package className="h-3.5 w-3.5 text-muted" aria-hidden />{p.name}</span>
                        <span className="block text-xs text-muted">{p.regime}</span>
                      </span>
                      {canEdit ? (inDraft
                        ? <span className="flex flex-wrap gap-2">
                            {stale && <Button size="sm" variant="secondary" onClick={() => refreshPack(p.id)}>Use current parameters</Button>}
                            <Button size="sm" variant="ghost" onClick={() => removePack(p.id)}>Remove section</Button>
                          </span>
                        : <Button size="sm" variant="secondary" onClick={() => addPack(p.id)}>Add {plural(fresh.length, 'rule')}{packDry ? ' as a dry run' : ''}</Button>)
                        : inDraft ? <Badge>{stale ? 'In this rulebook · older parameters' : dryInDraft ? 'In this rulebook · dry run' : 'In this rulebook'}</Badge> : null}
                    </li>
                  );
                })}
              </ul>
            )}
        </Panel>

        <NamedListsPanel lists={lists} onSaved={(next) => onListsChanged?.(next)} canWriteDraft={canEdit} />

        {Object.keys(extras.top).length > 0 && (
          <Panel title="Edited in YAML" kicker="Kept as written" actions={<YamlEditedBadge />}>
            <p className="text-sm text-muted mb-3">These top-level settings were written in YAML. The visual builder cannot show them; they are kept exactly as written and {sl ? 'signed' : 'sealed'} with the version.</p>
            <pre className="text-[12px] font-mono bg-sunken/70 border border-line p-3 overflow-auto max-h-60">{stringify(extras.top, { lineWidth: 0 })}</pre>
          </Panel>
        )}

        {hits.__total && (
          <p className="text-xs text-muted">{n(hits.__total.count)} decisions by this agent in the last 30 days{hits.__total.last && <> · latest <When iso={hits.__total.last} /></>}.</p>
        )}
      </aside>

      <RuleDialog open={!!editing} onClose={() => setEditing(null)} initial={editing?.rule} initialExtra={editing?.rule ? extras.rules[editing.rule.id] : undefined} existingIds={ids} agentTools={agent.tools}
        title={editing?.rule ? `Edit rule ${editing.rule.id}` : 'Add a rule'} onSave={save} />
    </div>
  );
}

/** The organisation's named lists (approved_vendors, own_accounts …). Shared by every rulebook; each change is a receipt. */
function NamedListsPanel({ lists, onSaved, canWriteDraft }: { lists: Record<string, string[]>; onSaved: (lists: Record<string, string[]>) => void; canWriteDraft: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const canEdit = useCan('rulebooks.edit');
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!user || !editing) return;
    setBusy(true);
    try {
      const r = await setNamedList(orgId, editing, text.split(/[\n,]/), user.id);
      toast.ok(`${editing} saved`, `Recorded as receipt #${n(r.seq)}. ${canWriteDraft ? 'The draft’s YAML now carries the new list; publish it to make it live.' : 'It goes into the YAML of the next draft.'}`);
      setEditing(undefined);
      onSaved(r.lists);
    } catch (e) {
      toast.bad('List not saved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Named lists" kicker="Used in conditions" flush>
      <ul className="divide-y divide-line">
        {Object.entries(lists).map(([name, values]) => (
          <li key={name} className="px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-mono text-[12.5px] text-accent-fg"><ListChecks className="h-3.5 w-3.5 text-muted" aria-hidden />{name}</span>
              {canEdit && editing !== name && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} onClick={() => { setEditing(name); setText(values.join('\n')); }}>Edit</Button>}
            </div>
            {editing === name ? (
              <div className="mt-2 space-y-2">
                <Field label="One value per line" htmlFor={`list-${name}`}>
                  <Textarea id={`list-${name}`} rows={5} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[12.5px]" />
                </Field>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" loading={busy} onClick={save}>Save list</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted break-words">{values.join(', ')}</p>
            )}
          </li>
        ))}
      </ul>
      {!canEdit && <p className="px-5 py-3 border-t border-line text-xs text-muted">Owners and admins edit named lists.</p>}
    </Panel>
  );
}
