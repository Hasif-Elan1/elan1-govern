import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Lock } from 'lucide-react';
import type { Condition, ConditionOp, Decision, Quota, RiskTag, Rule } from '@/types';
import { userName } from '@/mock/users';
import { tagLabel } from '@/lib/format';
import { atLeast } from '@/lib/levels';
import { AUTONOMY_LEVELS, isAvailableLevel } from '@/lib/autonomy';
import { useOrgLevel } from '@/store/session';
import { Banner, Button, Checkbox, Dialog, Field, IconButton, Input, RadioCards, Segmented, Select, Switch, Textarea } from '@/components/ui';
import { ALL_TAGS, EXPIRY_OPTIONS, FIELD_SUGGESTIONS, NAMED_LISTS, OPS, QUOTA_WINDOWS, allTools, builderExtra, chatBlockReason, opMeta, orgGroups, toolByName, toolsForRule } from './lib';
import { RuleBody } from './parts';

const ESCALATE_OPTIONS = ['25%', '50%', '75%', '30m', '1h', '2h', '4h', '8h'];

interface Row { field: string; op: ConditionOp; value: string }

const toRows = (cs?: Condition[]): Row[] => (cs ?? []).map((c) => ({ field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value) }));

function fromRows(rows: Row[]): { conds: Condition[]; errors: string[] } {
  const conds: Condition[] = [];
  const errors: string[] = [];
  for (const r of rows) {
    if (!r.field.trim() && !r.value.trim()) continue;
    if (!r.field.trim()) { errors.push('Every condition needs a field.'); continue; }
    const kind = opMeta(r.op).kind;
    if (kind === 'number') {
      const num = Number(r.value.replace(/[₹,\s]/g, ''));
      if (!r.value.trim() || !Number.isFinite(num)) { errors.push(`${r.field} ${opMeta(r.op).label} needs a number.`); continue; }
      conds.push({ field: r.field.trim(), op: r.op, value: num });
    } else if (kind === 'list') {
      const list = r.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (!list.length) { errors.push(`${r.field} ${opMeta(r.op).label} needs at least one value.`); continue; }
      conds.push({ field: r.field.trim(), op: r.op, value: list });
    } else {
      conds.push({ field: r.field.trim(), op: r.op, value: r.value.trim() });
    }
  }
  return { conds, errors };
}

function ConditionRows({ rows, onChange, idPrefix, addLabel }: { rows: Row[]; onChange: (r: Row[]) => void; idPrefix: string; addLabel: string }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] sm:grid-cols-[minmax(0,1fr)_150px_minmax(0,1.2fr)_auto] gap-2 items-start border border-line bg-sunken/40 p-2 sm:border-0 sm:bg-transparent sm:p-0">
          <div className="col-span-1">
            <label className="sr-only" htmlFor={`${idPrefix}-f-${i}`}>Field</label>
            <Input id={`${idPrefix}-f-${i}`} mono list="rb-field-suggestions" placeholder="field, e.g. amount" value={r.field} onChange={(e) => set(i, { field: e.target.value })} className="h-9" />
          </div>
          <div className="row-start-2 sm:row-start-auto col-span-2 sm:col-span-1">
            <label className="sr-only" htmlFor={`${idPrefix}-o-${i}`}>Operator</label>
            <Select id={`${idPrefix}-o-${i}`} size_="sm" value={r.op} onChange={(e) => set(i, { op: e.target.value as ConditionOp })} className="h-9">
              {OPS.map((o) => <option key={o.value} value={o.value}>{o.value} — {o.label}</option>)}
            </Select>
          </div>
          <div className="row-start-3 sm:row-start-auto col-span-2 sm:col-span-1">
            <label className="sr-only" htmlFor={`${idPrefix}-v-${i}`}>Value</label>
            <Input id={`${idPrefix}-v-${i}`} mono placeholder={opMeta(r.op).kind === 'list' ? 'a, b or approved_vendors' : opMeta(r.op).kind === 'number' ? '50000' : 'value'} value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="h-9" inputMode={opMeta(r.op).kind === 'number' ? 'decimal' : undefined} />
          </div>
          <IconButton label="Remove condition" className="row-start-1 col-start-2 sm:row-start-auto sm:col-start-auto" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton>
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...rows, { field: '', op: 'eq', value: '' }])}>{addLabel}</Button>
    </div>
  );
}

/**
 * Add or edit one rule. Match a tool or a risk tag, add conditions, choose the outcome.
 * Approve in chat is switched off, with the reason, where the publish checks would refuse it.
 */
export function RuleDialog({ open, onClose, initial, initialExtra, existingIds, agentTools, onSave, title }: {
  open: boolean; onClose: () => void; initial?: Rule; initialExtra?: Record<string, unknown>; existingIds: string[]; agentTools: string[];
  onSave: (r: Rule, previousId: string | undefined, extra: Record<string, unknown>) => void; title: string;
}) {
  const level = useOrgLevel();
  const groups = orgGroups();
  const TOOLS = allTools();
  const [backup, setBackup] = useState('');
  const [escAfter, setEscAfter] = useState('50%');
  const [minAuto, setMinAuto] = useState('');
  const [id, setId] = useState('');
  const [matchKind, setMatchKind] = useState<'tool' | 'tag'>('tool');
  const [tool, setTool] = useState('');
  const [tag, setTag] = useState<RiskTag>('moves_money');
  const [when, setWhen] = useState<Row[]>([]);
  const [unless, setUnless] = useState<Row[]>([]);
  const [decide, setDecide] = useState<Decision>('allow');
  const [approver, setApprover] = useState('');
  const [expiresIn, setExpiresIn] = useState('24h');
  const [chat, setChat] = useState(false);
  const [reason, setReason] = useState('');
  const [quotaOn, setQuotaOn] = useState(false);
  const [quota, setQuota] = useState<Quota>({ kind: 'max_count', limit: 100, window: 'day' });
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    const r = initial;
    setId(r?.id ?? '');
    setMatchKind(r?.match.tag ? 'tag' : 'tool');
    setTool(r?.match.tool ?? agentTools[0] ?? TOOLS[0].name);
    setTag(r?.match.tag ?? 'moves_money');
    setWhen(toRows(r?.when));
    setUnless(toRows(r?.unless));
    setDecide(r?.decide ?? 'allow');
    setApprover(r?.approver ?? '');
    setExpiresIn(r?.expiresIn ?? '24h');
    setChat(!!r?.approveInChat);
    setReason(r?.reason ?? '');
    setQuotaOn(!!r?.quota);
    setQuota(r?.quota ?? { kind: 'max_count', limit: 100, window: 'day' });
    const bx = builderExtra(initialExtra);
    setBackup(bx.escalate_to ?? '');
    setEscAfter(bx.escalate_after ?? '50%');
    setMinAuto(bx.requires_autonomy ?? '');
    setTried(false);
  }, [open, initial]);

  const w = fromRows(when);
  const u = fromRows(unless);
  const draft: Rule = useMemo(() => {
    const r: Rule = { ...(initial ?? {}), id: id.trim(), match: matchKind === 'tool' ? { tool } : { tag }, decide, reason: reason.trim() } as Rule;
    delete r.when; delete r.unless; delete r.approver; delete r.expiresIn; delete r.approveInChat; delete r.quota;
    if (w.conds.length) r.when = w.conds;
    if (decide === 'ask') {
      if (u.conds.length) r.unless = u.conds;
      r.approver = approver || undefined;
      r.expiresIn = expiresIn;
      r.approveInChat = chat;
      if (!r.approver) delete r.approver;
    }
    if (quotaOn) r.quota = { ...quota, field: quota.kind === 'max_sum' ? quota.field || 'amount' : undefined };
    if (r.quota && !r.quota.field) delete r.quota.field;
    return r;
  }, [id, matchKind, tool, tag, decide, reason, JSON.stringify(w.conds), JSON.stringify(u.conds), approver, expiresIn, chat, quotaOn, quota, initial]);

  const chatBlocked = chatBlockReason({ ...draft, approveInChat: true }, agentTools);
  useEffect(() => { if (chatBlocked && chat) setChat(false); }, [chatBlocked, chat]);

  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id.trim())) errors.push('Give the rule an id in lower case, using letters, numbers and hyphens — for example pay-small.');
  else if (existingIds.includes(id.trim()) && id.trim() !== initial?.id) errors.push(`Another rule already uses the id “${id.trim()}”.`);
  if (matchKind === 'tool' && !toolByName(tool)) errors.push('Choose a tool.');
  if (!reason.trim()) errors.push('Write a reason. Approvers see it and every receipt records it.');
  if (decide === 'ask' && !approver) errors.push('Choose the approver group that decides.');
  if (decide === 'ask' && approver && !groups.find((g) => g.id === approver)?.members.length) errors.push('That approver group has no members. Choose a group with people in it.');
  if (decide === 'ask' && backup) {
    if (backup === approver) errors.push('The backup group must be different from the approver group.');
    else if (!groups.find((g) => g.id === backup)?.members.length) errors.push('The backup group has no members.');
  }
  if (quotaOn && !(quota.limit > 0)) errors.push('The quota limit must be above zero.');
  errors.push(...w.errors, ...u.errors);

  const extra: Record<string, unknown> = { ...(initialExtra ?? {}) };
  delete extra.escalate_to; delete extra.escalate_after; delete extra.requires_autonomy;
  if (decide === 'ask' && backup) { extra.escalate_to = backup; extra.escalate_after = escAfter; }
  if (minAuto) extra.requires_autonomy = minAuto;

  const save = () => {
    setTried(true);
    if (errors.length) return;
    onSave(draft, initial?.id, extra);
    onClose();
  };

  const mine = TOOLS.filter((t) => agentTools.includes(t.name));
  const others = TOOLS.filter((t) => !agentTools.includes(t.name));
  const reach = toolsForRule(draft, agentTools);

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={title} description="Rules match a tool or a risk tag. The strictest matching rule wins — refuse over ask over allow — and anything no rule allows is refused."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{initial ? 'Update rule' : 'Add rule'}</Button></>}>
      <datalist id="rb-field-suggestions">{FIELD_SUGGESTIONS.map((f) => <option key={f} value={f} />)}</datalist>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rule id" required htmlFor="rule-id" hint="Shown on every receipt this rule decides.">
            <Input id="rule-id" mono value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="pay-small" data-autofocus />
          </Field>
          <Field label="Match by">
            <Segmented label="Match by" value={matchKind} onChange={setMatchKind} options={[{ value: 'tool', label: 'One tool' }, { value: 'tag', label: 'Risk tag' }]} />
          </Field>
        </div>

        {matchKind === 'tool' ? (
          <Field label="Tool" htmlFor="rule-tool" hint={toolByName(tool) ? `${toolByName(tool)!.description}. Tags: ${toolByName(tool)!.tags.map((t) => tagLabel[t]).join(', ')}.` : undefined}>
            <Select id="rule-tool" value={tool} onChange={(e) => setTool(e.target.value)} className="font-mono text-sm">
              {mine.length > 0 && <optgroup label="Tools this agent uses">{mine.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</optgroup>}
              <optgroup label="Other tools in connected systems">{others.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</optgroup>
            </Select>
          </Field>
        ) : (
          <Field label="Risk tag" htmlFor="rule-tag" hint={reach.length ? `Reaches ${reach.map((t) => t.name).join(', ')}.` : 'No tool of this agent carries this tag today.'}>
            <Select id="rule-tag" value={tag} onChange={(e) => setTag(e.target.value as RiskTag)}>
              {ALL_TAGS.map((t) => <option key={t} value={t}>{tagLabel[t]} ({t})</option>)}
            </Select>
          </Field>
        )}

        <Field label="Conditions" hint={<>All conditions must hold. A missing argument never holds. Named lists: {Object.keys(NAMED_LISTS).map((l) => <code key={l} className="font-mono mx-0.5">{l}</code>)}.</>}>
          <ConditionRows rows={when} onChange={setWhen} idPrefix="when" addLabel="Add a condition" />
        </Field>

        <Field label="Then">
          <RadioCards name="decide" value={decide} onChange={setDecide} cols={3} options={[
            { value: 'allow', label: 'Allow', description: 'Runs without a person.' },
            { value: 'ask', label: 'Ask a person', description: 'Held until an approver decides.' },
            { value: 'refuse', label: 'Refuse', description: 'Never runs. Recorded.' },
          ]} />
        </Field>

        {decide === 'ask' && (
          <div className="border border-line bg-sunken/40 p-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Approver group" required htmlFor="rule-approver">
                <Select id="rule-approver" value={approver} onChange={(e) => setApprover(e.target.value)}>
                  <option value="">Choose a group</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name} — {g.members.length ? g.members.map((m) => userName(m)).join(', ') : 'no members'}</option>)}
                </Select>
              </Field>
              <Field label="Expires after" htmlFor="rule-exp" hint="If no one decides by then, the call is refused and that is recorded.">
                <Select id="rule-exp" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}>
                  {EXPIRY_OPTIONS.map((x) => <option key={x} value={x}>{x}</option>)}
                </Select>
              </Field>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Approve in chat</p>
                <p className="text-xs text-muted mt-0.5 leading-relaxed">Adds Approve and Reject buttons to the Slack or WhatsApp message, for the approver it was sent to only (their confirmed Slack email or verified WhatsApp number). Any other chat message carries a link to open the call in Elan1 Govern. Off by default; chat is a doorbell, not a replacement.</p>
                {chatBlocked && <p className="mt-2 flex items-start gap-1.5 text-xs text-fg"><Lock className="h-3.5 w-3.5 mt-px shrink-0 text-muted" aria-hidden />{chatBlocked}</p>}
              </div>
              <Switch label="Approve in chat" checked={chat} onChange={setChat} disabled={!!chatBlocked} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Backup group" htmlFor="rule-backup" hint="If nobody in the approver group decides in time, the call is re-routed here once, the group is notified, and a receipt names both groups.">
                <Select id="rule-backup" value={backup} onChange={(e) => setBackup(e.target.value)}>
                  <option value="">Use the group’s escalation policy</option>
                  {groups.filter((g) => g.id !== approver).map((g) => <option key={g.id} value={g.id}>{g.name} — {g.members.length ? g.members.map((m) => userName(m)).join(', ') : 'no members'}</option>)}
                </Select>
              </Field>
              <Field label="Escalate after" htmlFor="rule-esc" hint="A share of the expiry window, or a time.">
                <Select id="rule-esc" value={escAfter} onChange={(e) => setEscAfter(e.target.value)} disabled={!backup}>
                  {ESCALATE_OPTIONS.map((x) => <option key={x} value={x}>{x.endsWith('%') ? `${x} of the window` : x}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Unless (exceptions)" hint="The ask stands aside only when every exception holds. A missing value never holds.">
              <ConditionRows rows={unless} onChange={setUnless} idPrefix="unless" addLabel="Add an exception" />
            </Field>
          </div>
        )}

        {atLeast(level, 'l3') ? (
          <Field label="Minimum autonomy" htmlFor="rule-auto" hint="Earned autonomy: the publish check warns when the agent's level for a tool this rule reaches is below this level. Writes start at A2; A3 comes only by a two-person graduation.">
            <Select id="rule-auto" value={minAuto} onChange={(e) => setMinAuto(e.target.value)}>
              <option value="">No minimum</option>
              {AUTONOMY_LEVELS.filter((l) => l.id !== 'A0').map((l) => <option key={l.id} value={l.id} disabled={!isAvailableLevel(l.id)}>{l.label} — {isAvailableLevel(l.id) ? l.description : 'not yet available'}</option>)}
            </Select>
          </Field>
        ) : minAuto ? (
          <p className="text-xs text-muted">This rule records a minimum autonomy of {minAuto}. Earned autonomy is enforced from Proven (L3).</p>
        ) : null}

        <Field label="Reason" required htmlFor="rule-reason" hint="Plain words. Approvers read it and every receipt records it.">
          <Textarea id="rule-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Payments over ₹50,000 need the finance controller." />
        </Field>

        <div className="space-y-3">
          <Checkbox checked={quotaOn} onChange={setQuotaOn} label="Add a quota" description="Caps how often, or how much, this rule allows in a window. Beyond the cap the call is held for a person in this rule’s approver group; with no approver group it is refused." />
          {quotaOn && (
            <div className="grid gap-3 sm:grid-cols-4 pl-6">
              <Field label="Kind" htmlFor="q-kind"><Select id="q-kind" size_="sm" value={quota.kind} onChange={(e) => setQuota({ ...quota, kind: e.target.value as Quota['kind'] })}><option value="max_count">max_count — calls</option><option value="max_sum">max_sum — total</option></Select></Field>
              {quota.kind === 'max_sum' && <Field label="Field" htmlFor="q-field"><Input id="q-field" mono className="h-8" value={quota.field ?? 'amount'} onChange={(e) => setQuota({ ...quota, field: e.target.value })} /></Field>}
              <Field label="Limit" htmlFor="q-limit"><Input id="q-limit" mono className="h-8" inputMode="numeric" value={String(quota.limit)} onChange={(e) => setQuota({ ...quota, limit: Number(e.target.value.replace(/[₹,\s]/g, '')) || 0 })} /></Field>
              <Field label="Window" htmlFor="q-win"><Select id="q-win" size_="sm" value={quota.window} onChange={(e) => setQuota({ ...quota, window: e.target.value })}>{QUOTA_WINDOWS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select></Field>
            </div>
          )}
        </div>

        <div>
          <p className="label mb-2">Preview</p>
          <div className="border border-line p-4 bg-surface"><RuleBody rule={draft} agentTools={agentTools} extra={extra} /></div>
        </div>

        {tried && errors.length > 0 && (
          <Banner tone="bad" title="Fix these before saving">
            <ul className="list-[square] pl-4 space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </Banner>
        )}
      </div>
    </Dialog>
  );
}
