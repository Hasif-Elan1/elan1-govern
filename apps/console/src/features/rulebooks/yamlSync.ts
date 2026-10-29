/**
 * Keeps the visual builder and the YAML view in sync.
 * Builder → YAML: regenerated with the catalogue's rulebookYaml, then anything the builder cannot show
 * (extra keys written in YAML) is put back. YAML → builder: parsed with the yaml package; constructs the
 * builder cannot show are kept as "extras" and labelled "Edited in YAML".
 */
import { parse, parseDocument, stringify } from 'yaml';
import type { ApproverGroup, Condition, ConditionOp, Decision, Quota, RiskTag, Rule } from '@/types';
import { rulebookYaml, VENDOR_DOMAINS } from '@/mock/catalog';
import { APPROVER_GROUPS } from '@/mock/users';
import { ALL_TAGS, OP_VALUES, type Problem } from './lib';

export interface Extras {
  top: Record<string, unknown>;
  rules: Record<string, Record<string, unknown>>;
}
export const NO_EXTRAS: Extras = { top: {}, rules: {} };

export interface YamlCtx {
  slug: string;
  version: number;
  owner: string;
  approverIds: string[];
  /** the organisation's approver groups (members are written under approvers:) */
  groups?: ApproverGroup[];
  /** the organisation's named lists (written under lists:) */
  lists?: Record<string, string[]>;
}

const DEFAULT_LISTS = () => ({ approved_vendors: VENDOR_DOMAINS.map((d) => d.split('.')[0]), own_accounts: ['HDFC-OPS-0042', 'ICICI-FD-1180'] });

function genApprovers(ctx: YamlCtx, rules: Rule[]) {
  const ids = approverIdsFor(rules, ctx.approverIds);
  return Object.fromEntries((ctx.groups ?? APPROVER_GROUPS).filter((g) => ids.includes(g.id)).map((g) => [g.id, g.members]));
}

export const hasExtras = (e: Extras) => Object.keys(e.top).length > 0 || Object.values(e.rules).some((r) => Object.keys(r).length > 0);

export function approverIdsFor(rules: Rule[], base: string[] = []): string[] {
  return Array.from(new Set([...base, ...rules.map((r) => r.approver).filter((x): x is string => !!x)]));
}

const condsToYaml = (cs: Condition[]) => {
  const o: Record<string, Record<string, unknown>> = {};
  for (const c of cs) (o[c.field] ??= {})[c.op] = c.value;
  return o;
};
const hasDupFields = (cs?: Condition[]) => !!cs && new Set(cs.map((c) => c.field)).size !== cs.length;

/** Builder → YAML. */
export function buildYaml(ctx: YamlCtx, rules: Rule[], extras: Extras = NO_EXTRAS): string {
  const base = rulebookYaml(ctx.slug, ctx.version, ctx.owner, rules, approverIdsFor(rules, ctx.approverIds));
  const needsPost = hasExtras(extras) || rules.some((r) => hasDupFields(r.when) || hasDupFields(r.unless)) || !!ctx.groups || !!ctx.lists;
  if (!needsPost) return base;
  const header = base.split('\n').filter((l) => l.startsWith('#')).join('\n');
  const doc = parse(base) as Record<string, unknown> & { rules: Record<string, unknown>[] };
  doc.rules = doc.rules.map((y, i) => {
    const r = rules[i];
    const out: Record<string, unknown> = { ...y };
    if (hasDupFields(r.when)) out.when = condsToYaml(r.when!);
    if (hasDupFields(r.unless)) out.unless = condsToYaml(r.unless!);
    const extra = extras.rules[r.id];
    if (extra && Object.keys(extra).length) {
      const reason = out.reason;
      delete out.reason;
      Object.assign(out, extra);
      out.reason = reason;
    }
    return out;
  });
  if (ctx.groups) doc.approvers = genApprovers(ctx, rules);
  if (ctx.lists) doc.lists = ctx.lists;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (k !== 'rules') merged[k] = k in extras.top ? extras.top[k] : v;
  for (const [k, v] of Object.entries(extras.top)) if (!(k in merged)) merged[k] = v;
  merged.rules = doc.rules;
  return `${header}\n${stringify(merged, { lineWidth: 0 })}`;
}

export interface ParseResult {
  ok: boolean;
  rules: Rule[];
  extras: Extras;
  problems: Problem[];
  /** the version number written in the YAML, if any */
  version?: number;
}

const KNOWN_RULE = new Set(['id', 'tool', 'tag', 'when', 'unless', 'decide', 'approver', 'expires_in', 'approve_in_chat', 'quota', 'reason', 'mode']);
const KNOWN_TOP = new Set(['version', 'agent', 'owner', 'default', 'approvers', 'lists', 'rules']);
const DECISIONS: Decision[] = ['allow', 'ask', 'refuse'];

function lineOf(text: string, needle: string): number | undefined {
  const i = text.indexOf(needle);
  if (i < 0) return undefined;
  return text.slice(0, i).split('\n').length;
}

function readConds(raw: unknown, where: string, id: string, problems: Problem[], line?: number): Condition[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const out: Condition[] = [];
  const push = (field: string, op: string, value: unknown) => {
    if (!OP_VALUES.includes(op as ConditionOp)) {
      problems.push({ level: 'error', ruleId: id, line, text: `${id}: unknown operator “${op}” on ${field} in ${where}. Use one of ${OP_VALUES.join(', ')}.` });
      return;
    }
    let v: Condition['value'];
    if (Array.isArray(value)) v = value.map((x) => String(x));
    else if (typeof value === 'number') v = value;
    else if (typeof value === 'boolean') v = String(value);
    else if (typeof value === 'string') v = value;
    else {
      problems.push({ level: 'error', ruleId: id, line, text: `${id}: the value for ${field} ${op} in ${where} must be text, a number or a list.` });
      return;
    }
    out.push({ field, op: op as ConditionOp, value: v });
  };
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (c && typeof c === 'object' && 'field' in c && 'op' in c) push(String((c as Condition).field), String((c as Condition).op), (c as Condition).value);
      else problems.push({ level: 'error', ruleId: id, line, text: `${id}: each item in ${where} needs field, op and value.` });
    }
  } else if (typeof raw === 'object') {
    for (const [field, spec] of Object.entries(raw as Record<string, unknown>)) {
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) for (const [op, value] of Object.entries(spec as Record<string, unknown>)) push(field, op, value);
      else push(field, 'eq', spec);
    }
  } else problems.push({ level: 'error', ruleId: id, line, text: `${id}: ${where} must be a map of field → {operator: value}.` });
  return out.length ? out : undefined;
}

/** YAML → builder. Never throws. */
export function parseRulebookYaml(text: string, ctx: YamlCtx): ParseResult {
  const problems: Problem[] = [];
  const empty: ParseResult = { ok: false, rules: [], extras: NO_EXTRAS, problems };
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    for (const e of doc.errors) problems.push({ level: 'error', line: e.linePos?.[0]?.line, text: e.message.split('\n')[0] });
    return empty;
  }
  const obj = doc.toJS() as unknown;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    problems.push({ level: 'error', line: 1, text: 'The rulebook must be a map with version, agent, default and rules.' });
    return empty;
  }
  const top = obj as Record<string, unknown>;
  const extras: Extras = { top: {}, rules: {} };
  if (top.default !== undefined && top.default !== 'refuse') problems.push({ level: 'error', line: lineOf(text, 'default:'), text: 'default is always refuse. Anything no rule allows is refused; this cannot be changed.' });
  if (top.version !== undefined && Number(top.version) !== ctx.version) problems.push({ level: 'warning', line: lineOf(text, 'version:'), text: `version is set by Elan1 Govern. This draft is version ${ctx.version}; the value ${String(top.version)} will be replaced when you save.` });
  if (top.agent !== undefined && top.agent !== ctx.slug) problems.push({ level: 'warning', line: lineOf(text, 'agent:'), text: `agent is fixed to ${ctx.slug}. One rulebook per agent.` });
  for (const [k, v] of Object.entries(top)) if (!KNOWN_TOP.has(k)) extras.top[k] = v;

  const rawRules = top.rules;
  if (!Array.isArray(rawRules)) {
    problems.push({ level: 'error', line: lineOf(text, 'rules:'), text: 'rules must be a list.' });
    return { ...empty, problems };
  }
  const rules: Rule[] = [];
  rawRules.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push({ level: 'error', text: `Rule ${i + 1} must be a map with id, tool or tag, decide and reason.` });
      return;
    }
    const y = raw as Record<string, unknown>;
    const id = typeof y.id === 'string' && y.id.trim() ? y.id.trim() : '';
    const line = id ? lineOf(text, `id: ${id}`) : undefined;
    if (!id) { problems.push({ level: 'error', text: `Rule ${i + 1} has no id.` }); return; }
    if (y.tool !== undefined && y.tag !== undefined) problems.push({ level: 'error', ruleId: id, line, text: `${id}: use tool or tag, not both.` });
    if (y.tool === undefined && y.tag === undefined) { problems.push({ level: 'error', ruleId: id, line, text: `${id}: add a tool or a tag to match.` }); return; }
    if (y.tag !== undefined && !ALL_TAGS.includes(y.tag as RiskTag)) { problems.push({ level: 'error', ruleId: id, line, text: `${id}: “${String(y.tag)}” is not a risk tag. Use one of ${ALL_TAGS.join(', ')}.` }); return; }
    if (!DECISIONS.includes(y.decide as Decision)) { problems.push({ level: 'error', ruleId: id, line, text: `${id}: decide must be allow, ask or refuse.` }); return; }
    const rule: Rule = { id, match: y.tool !== undefined ? { tool: String(y.tool) } : { tag: y.tag as RiskTag }, decide: y.decide as Decision, reason: typeof y.reason === 'string' ? y.reason : '' };
    const when = readConds(y.when, 'when', id, problems, line);
    if (when) rule.when = when;
    const unless = readConds(y.unless, 'unless', id, problems, line);
    if (unless) rule.unless = unless;
    if (y.approver !== undefined) rule.approver = String(y.approver);
    if (y.expires_in !== undefined) rule.expiresIn = String(y.expires_in);
    if (y.approve_in_chat !== undefined) {
      if (typeof y.approve_in_chat !== 'boolean') problems.push({ level: 'error', ruleId: id, line, text: `${id}: approve_in_chat must be true or false.` });
      else rule.approveInChat = y.approve_in_chat;
    }
    if (y.mode === 'enforce' || y.mode === 'simulate') rule.mode = y.mode;
    else if (y.mode !== undefined) problems.push({ level: 'error', ruleId: id, line, text: `${id}: mode must be enforce or simulate.` });
    if (y.quota !== undefined) {
      const q = y.quota as Record<string, unknown>;
      const kind = q && typeof q === 'object' ? ('max_sum' in q ? 'max_sum' : 'max_count' in q ? 'max_count' : undefined) : undefined;
      if (!kind) problems.push({ level: 'error', ruleId: id, line, text: `${id}: quota needs max_count or max_sum.` });
      else {
        const quota: Quota = { kind, limit: Number(q[kind]), window: String(q.per ?? 'day') };
        if (q.field !== undefined) quota.field = String(q.field);
        if (!Number.isFinite(quota.limit)) problems.push({ level: 'error', ruleId: id, line, text: `${id}: the quota limit must be a number.` });
        rule.quota = quota;
      }
    }
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(y)) if (!KNOWN_RULE.has(k)) extra[k] = v;
    if (Object.keys(extra).length) extras.rules[id] = extra;
    rules.push(rule);
  });

  // approvers and lists: kept as written when they differ from what the builder would generate
  const approversGen = genApprovers(ctx, rules);
  const approversCatalogue = Object.fromEntries(APPROVER_GROUPS.filter((g) => approverIdsFor(rules, ctx.approverIds).includes(g.id)).map((g) => [g.id, g.members]));
  const genLists = ctx.lists ?? DEFAULT_LISTS();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  // approvers and lists are generated from the organisation's records; text that matches either the organisation's or the catalogue's is not an edit
  if (top.approvers !== undefined && !same(top.approvers, approversGen) && !same(top.approvers, approversCatalogue)) extras.top.approvers = top.approvers;
  if (top.lists !== undefined && !same(top.lists, genLists) && !same(top.lists, DEFAULT_LISTS())) extras.top.lists = top.lists;

  const ok = !problems.some((p) => p.level === 'error');
  return { ok, rules, extras, problems, version: top.version !== undefined ? Number(top.version) : undefined };
}

/** The YAML a save or publish writes: the text as typed, unless the version number in it is stale. */
export function finalYaml(text: string, ctx: YamlCtx, rules: Rule[], extras: Extras): string {
  const p = parseRulebookYaml(text, ctx);
  if (p.ok && p.version === ctx.version) return text;
  return buildYaml(ctx, rules, extras);
}
