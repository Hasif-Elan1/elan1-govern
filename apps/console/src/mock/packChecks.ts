/**
 * Regulatory pack checks on live calls (registered with the guard as a recorded check, like G1 in mock/records.ts).
 *
 * For every pack that is installed and admitted for the calling agent (an approved pack admission assessment on the
 * agent's AI system), a governed write the pack's declaration covers is checked against the declaration in force:
 * its configured parameters and version (Records › Regulatory packs › Configure; a withdrawn version is never used).
 *
 * Two kinds of requirement:
 *  - a named person must decide (write types the declaration always holds, and writes above the dual-control
 *    threshold). When the rulebook already held the call for a person, the hold meets the requirement and the check
 *    passes. When the rulebook allowed it, the call is held for a named person instead (from L2); it is never refused
 *    for this.
 *  - prohibitions (a write type the pack does not admit, outside the contact window, no approved template, over the
 *    daily contact cap). From L2 they refuse the call (rule pack-gate for a write type the pack does not admit,
 *    pack-declaration for a broken condition), with the pack's own rule named on the receipt.
 *
 * At L1 the pack is a dry run with the same logic: nothing is refused or held, and the receipt records what would
 * have happened.
 *
 * Deterministic and cheap: it reads the call, the installed packs, their configuration, the admissions and (for the
 * cap) the last few hundred receipts. Nothing is written here; the guard writes the receipt.
 */
import type { Agent, PackId } from '@/types';
import { atLeast, levelOfOrg } from '@/lib/levels';
import { packById } from '@/lib/packs';
import { PACK_DEFAULTS } from '@/features/packs/defaults';
import { addRecordedCheck, type OrgDB } from './db';

type Call = { tool: string; args: Record<string, unknown>; tags: string[]; decision?: 'allow' | 'ask' };
/** person: a named person must decide (met by a hold); prohibit: the write is not admitted as it stands. */
type Failure = { packRule: string; ruleId: 'pack-gate' | 'pack-declaration'; reason: string; kind: 'person' | 'prohibit' };

const WRITE_TAGS = ['writes_data', 'moves_money', 'sends_external', 'deletes', 'changes_access', 'changes_production'];
const WRITE_VERB = /(create|update|submit|post|record|send|cancel|delete|pay|place|generate|notice)/;

/** Which calls each pack's declaration covers: the demo tools the pack screens count, and the pack's own connector. */
const COVERS: Record<PackId, (tool: string, args: Record<string, unknown>) => boolean> = {
  ledger1: (t) => t.startsWith('zoho_books.') || t.startsWith('tally.'),
  invoice1: (t) => t === 'zoho_books.create_bill' || t === 'zoho_books.record_payment' || t === 'zoho_books.delete_bill' || t.startsWith('irp.'),
  collect1: (t, a) => (t === 'gmail.send_email' && a.template !== undefined) || t.startsWith('collect.'),
};

/** Write types the declaration always holds for a named person (PACK_WRITE_TYPES dualControl 'always'). */
const ALWAYS_HELD: Record<PackId, string[]> = {
  ledger1: ['tally.cancel_voucher'],
  invoice1: ['irp.cancel_irn'],
  collect1: ['collect.send_final_notice'],
};

/** The approver group a pack hold goes to (the group the pack's locked rule section names). */
const PACK_APPROVER = 'finance';

const isWrite = (c: Call) => c.tags.some((t) => WRITE_TAGS.includes(t)) || WRITE_VERB.test(c.tool.split('.').pop() ?? '');
const istHourNow = () => new Date(Date.now() + 5.5 * 3_600_000).getUTCHours();
const istDayStart = () => { const t = Date.now() + 5.5 * 3_600_000; return t - (t % 86_400_000) - 5.5 * 3_600_000; };
const amountOf = (a: Record<string, unknown>) => { const v = Number(a.amount ?? a.amount_due ?? a.total); return Number.isFinite(v) ? v : undefined; };
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;

interface SavedCfg { values?: Record<string, number>; version?: number; withdrawn?: { version: number; fallbackVersion?: number }[] }

/**
 * The declaration in force for a pack: its configured parameters and version (features/packs/config.ts saves them
 * under platform.recordsDoor.packConfig; mock/recordsDecl.ts withdraws versions). Defaults and version 1 when nothing
 * is configured. A withdrawn version is never used: the version that took over applies, with its own parameters.
 */
function declarationInForce(db: OrgDB, id: PackId): { values: Record<string, number>; version: number } {
  const door = (db.platform as unknown as { recordsDoor?: { packConfig?: Partial<Record<PackId, SavedCfg>> } }).recordsDoor;
  const cfg = door?.packConfig?.[id];
  let version = cfg?.version ?? 1;
  let values = cfg?.values ?? {};
  const withdrawn = new Set((cfg?.withdrawn ?? []).map((w) => w.version));
  if (withdrawn.has(version)) {
    // the version in force was withdrawn without its fallback being applied: use the newest version not withdrawn
    const configured = db.receipts.filter((r) => r.kind === 'admin' && r.action === 'pack.configured' && r.details?.pack === id && !withdrawn.has(Number(r.details.version)));
    const last = configured[configured.length - 1];
    if (last) {
      version = Number(last.details!.version);
      values = Object.fromEntries(Object.entries(last.details!).filter(([k, v]) => typeof v === 'number' && k !== 'version')) as Record<string, number>;
    } else { version = 1; values = {}; }
  }
  return { values: { ...PACK_DEFAULTS[id], ...values }, version };
}

/** Packs installed here and admitted for this agent (an approved admission on the AI system linked to it). */
function admittedPacks(db: OrgDB, agent: Agent): PackId[] {
  const installed = db.platform?.packs ?? [];
  if (!installed.length) return [];
  const systems = new Set(db.aiSystems.filter((s) => s.linkedAgentId === agent.id).map((s) => s.id));
  if (!systems.size) return [];
  return installed.map((p) => p.id).filter((id) => db.assessments.some((a) => systems.has(a.aiSystemId) && a.status === 'approved' && (a as { variant?: string }).variant === `pack_${id}`));
}

function checkPack(db: OrgDB, agent: Agent, id: PackId, call: Call, cfg: { values: Record<string, number>; version: number }): Failure[] {
  const pk = packById(id);
  if (!pk) return [];
  const v = cfg.values;
  const decl = `${pk.declaration.id} v${cfg.version}`;
  const out: Failure[] = [];
  const name = call.tool.split('.').pop() ?? '';
  if (/delete/.test(name)) out.push({ kind: 'prohibit', packRule: `${id}.no_delete`, ruleId: 'pack-gate', reason: `${pk.name} (${decl}) does not admit a delete. Records are reversed or cancelled, never deleted by an agent.` });
  if (ALWAYS_HELD[id].includes(call.tool)) out.push({ kind: 'person', packRule: `${id}.dual_control`, ruleId: 'pack-declaration', reason: `${pk.name} (${decl}) needs a named person to decide ${call.tool} every time.` });
  const amount = amountOf(call.args);
  const above = id === 'ledger1' ? v.dualControlAbove ?? pk.declaration.dualControlAbove : pk.declaration.dualControlAbove;
  if (above && amount !== undefined && amount > above) {
    out.push({ kind: 'person', packRule: `${id}.dual_control_above`, ruleId: 'pack-declaration', reason: `${pk.name} (${decl}) needs a named person above ${inr(above)}; this write is ${inr(amount)}.` });
  }
  if (id === 'collect1') {
    const h = istHourNow();
    const from = v.windowFrom ?? 8;
    const to = v.windowTo ?? 19;
    if (h < from || h >= to) out.push({ kind: 'prohibit', packRule: 'collect1.contact_window', ruleId: 'pack-declaration', reason: `${pk.name} (${decl}) permits borrower contact between ${hh(from)} and ${hh(to)} IST; it is ${String(h).padStart(2, '0')}:xx IST.` });
    if (call.tool !== 'collect.record_promise' && (call.args.template === undefined || String(call.args.template).trim() === '')) {
      out.push({ kind: 'prohibit', packRule: 'collect1.template', ruleId: 'pack-declaration', reason: `${pk.name} (${decl}) sends only from an approved template; the call names none.` });
    }
    const cap = v.dailyCap ?? 3;
    const phone = [call.args.phone, call.args.mobile, call.args.to_number].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
    if (phone) {
      const dayFrom = istDayStart();
      const today = db.receipts.slice(-400).filter((r) => r.kind === 'decision' && r.agent === agent.slug && r.decision !== 'refuse' && new Date(r.ts).getTime() >= dayFrom
        && [r.args_summary?.phone, r.args_summary?.mobile, r.args_summary?.to_number].includes(phone)).length;
      if (today >= cap) out.push({ kind: 'prohibit', packRule: 'collect1.daily_cap', ruleId: 'pack-declaration', reason: `${pk.name} (${decl}) allows ${cap} contact${cap === 1 ? '' : 's'} a day to one borrower; ${today} have been made today.` });
    }
  }
  return out;
}

function packDeclaration(db: OrgDB, agent: Agent, call: Call) {
  if (!isWrite(call)) return undefined;
  const packs = admittedPacks(db, agent).filter((id) => COVERS[id](call.tool, call.args));
  if (!packs.length) return undefined;
  const live = atLeast(levelOfOrg(db.org), 'l2');
  const cfgs = new Map(packs.map((id) => [id, declarationInForce(db, id)] as const));
  const fails = packs.flatMap((id) => checkPack(db, agent, id, call, cfgs.get(id)!));
  const details: Record<string, string | number> = {
    packs: packs.join(','), pack_mode: live ? 'live' : 'dry_run',
    pack_declaration: packs.map((id) => `decl.${id} v${cfgs.get(id)!.version}`).join(','),
  };
  if (fails.length > 1) details.pack_rules_failed = fails.map((f) => f.packRule).join(',');
  const prohibits = fails.filter((f) => f.kind === 'prohibit');
  const person = fails.filter((f) => f.kind === 'person');

  // a prohibition refuses (from L2); a write type the pack does not admit outranks a broken condition
  if (prohibits.length) {
    const first = prohibits.find((f) => f.ruleId === 'pack-gate') ?? prohibits[0];
    details.pack_rule = first.packRule;
    if (!live) {
      // dry run: the checks run and report; nothing is refused and no regulatory claim is made
      details.pack_checks = 'would_refuse';
      details.pack_would_refuse = `${first.ruleId}: ${first.reason}`;
      return { details };
    }
    details.pack_checks = 'refused';
    return { details, refuse: { ruleId: first.ruleId, reason: first.reason } };
  }

  if (!person.length) { details.pack_checks = 'passed'; return { details }; }

  // a named person must decide: the rulebook's hold meets it; an allowed call is held for a person instead
  const first = person[0];
  details.pack_rule = first.packRule;
  if (call.decision === 'ask') {
    details.pack_checks = 'passed';
    details.pack_hold_met = `${first.packRule}: the rulebook already holds this write for a named person, which meets the pack's requirement.`;
    // the hold now carries the pack's requirement too: no autonomy grant, at any level, may release it (db.governCall)
    return { details, personRequired: true };
  }
  if (!live) {
    details.pack_checks = 'would_hold';
    details.pack_would_hold = `${first.ruleId}: ${first.reason} From L2 the call is held for a named person.`;
    return { details };
  }
  details.pack_checks = 'held';
  return { details, hold: { ruleId: first.ruleId, reason: `${first.reason} The rulebook allowed it, so it is held for a named person.`, approver: PACK_APPROVER } };
}

addRecordedCheck('pack-declaration', packDeclaration);
