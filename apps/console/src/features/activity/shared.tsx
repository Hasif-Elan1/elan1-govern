/**
 * Shared pieces for Activity, Receipt, Chain, Evidence and Auditor screens:
 * receipt kind marks, plain-language stories, refusal classes, mode and outcome cells, CSV and download helpers.
 */
import type { ReactNode } from 'react';
import { ArrowRightLeft, CheckCheck, CircleCheck, CircleSlash, CircleX, Lock, Scale, Settings2, UserCheck, type LucideIcon } from 'lucide-react';
import type { LevelId, Receipt, ReceiptKind } from '@/types';
import { useNavigate } from 'react-router-dom';
import { Button, StatusChip, type ButtonProps } from '@/components/ui';
import { cn } from '@/lib/cn';
import { channelLabel, dateTime, n, rupees, seqLabel } from '@/lib/format';
import { LEVEL_INFO } from '@/lib/levels';
import { NO_GRANT_LABEL } from '@/lib/autonomy';
import { APPROVER_GROUPS, userName } from '@/mock/users';
import { EnvironmentChip } from '@/features/evidence/EnvironmentChip';
import { useCanSee } from '@/shell/access';

export const H = 3_600_000;
export const D = 24 * H;

/* ── Kind ─────────────────────────────────────────────────── */

export const KIND_META: Record<ReceiptKind, { label: string; icon: LucideIcon; hint: string }> = {
  decision: { label: 'Decision', icon: Scale, hint: 'An agent asked to call a tool and the rulebook answered.' },
  approval: { label: 'Approval', icon: UserCheck, hint: 'A person (or the expiry) decided a held call.' },
  outcome: { label: 'Outcome', icon: CheckCheck, hint: 'The agent reported what happened when it ran the call.' },
  admin: { label: 'Admin change', icon: Settings2, hint: 'A person changed the set-up: rulebook, keys, stop, members.' },
};

export function KindMark({ kind, className, iconOnly }: { kind: ReceiptKind; className?: string; iconOnly?: boolean }) {
  const m = KIND_META[kind];
  const Icon = m.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm text-muted whitespace-nowrap', className)} title={m.hint}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {iconOnly ? <span className="sr-only">{m.label}</span> : m.label}
    </span>
  );
}

/* ── Mode and outcome ─────────────────────────────────────── */

export function receiptMode(r: Receipt): 'governed_run' | 'check_and_record' | undefined {
  const m = r.details?.mode;
  return m === 'governed_run' || m === 'check_and_record' ? m : undefined;
}

export function ModeChip({ r }: { r: Receipt }) {
  const mode = receiptMode(r);
  if (!mode) return <span className="text-subtle">—</span>;
  const enforced = mode === 'governed_run';
  const route = typeof r.details?.route === 'string' ? ` · ${String(r.details.route).toUpperCase()}` : '';
  return (
    <span title={enforced ? 'Enforced. Elan1 Govern holds the tool credential and runs the call; a refused call does not run.' : 'Advisory. Elan1 Govern decides and records; the agent holds its own credentials and runs the call.'}>
      <StatusChip tone={enforced ? 'inverse' : 'neutral'} size="sm" icon={enforced ? <Lock className="h-3 w-3" aria-hidden /> : <ArrowRightLeft className="h-3 w-3" aria-hidden />}>
        {enforced ? 'Governed run' : 'Check and record'}{route}
      </StatusChip>
      {r.environment === 'sandbox' && <> <EnvironmentChip r={r} /></>}
    </span>
  );
}

export function OutcomeCell({ r }: { r: Receipt }) {
  const o = r.outcome;
  if (o?.status === 'ok') return <span className="inline-flex items-center gap-1 text-sm text-ok-fg whitespace-nowrap"><CircleCheck className="h-3.5 w-3.5" aria-hidden />Ran{o.ms !== undefined && <span className="text-muted num"> · {n(o.ms)} ms</span>}</span>;
  if (o?.status === 'error') return <span className="inline-flex items-center gap-1 text-sm text-bad-fg whitespace-nowrap"><CircleX className="h-3.5 w-3.5" aria-hidden />Tool error</span>;
  if (o?.status === 'not_run') return <span className="inline-flex items-center gap-1 text-sm text-muted whitespace-nowrap"><CircleSlash className="h-3.5 w-3.5" aria-hidden />Not run</span>;
  if (r.decision === 'allow' && receiptMode(r) === 'check_and_record') return <span className="text-sm text-muted whitespace-nowrap">Agent runs it</span>;
  if (r.decision === 'ask' && r.kind === 'decision') return <span className="text-sm text-muted whitespace-nowrap">Held</span>;
  return <span className="text-subtle">—</span>;
}

export function outcomeText(r: Receipt): string {
  const o = r.outcome;
  if (o?.status === 'ok') return `ran${o.ms !== undefined ? ` in ${o.ms} ms` : ''}`;
  if (o?.status === 'error') return 'tool error';
  if (o?.status === 'not_run') return 'not run';
  if (r.decision === 'allow' && receiptMode(r) === 'check_and_record') return 'agent runs it';
  return '';
}

/* ── Refusal classes — refusals are evidence ──────────────── */

/**
 * The six classes every level shares. Other screens (Refusals, Not done) key their charts on these, so the
 * set is stable; `refusalClass` folds the level-specific classes below into 'rule' or 'default'.
 */
export type RefusalClass = 'rule' | 'default' | 'paused' | 'invalid' | 'expiry' | 'rejected';
/**
 * Level-specific refusals: a regulatory pack's declaration (from L1, a dry run there) and a missing autonomy grant
 * (L3). There is no class for erased data (erasure removes values from records; it does not refuse calls) and none for
 * an unverified counterparty (a received receipt that fails its checks is not accepted; no agent call is refused).
 */
export type LevelRefusalClass = 'autonomy' | 'pack_gate';
export type RefusalClassFull = RefusalClass | LevelRefusalClass;

export const REFUSAL_CLASSES: { id: RefusalClass; label: string; hint: string }[] = [
  { id: 'rule', label: 'By a rule', hint: 'A rule in the published rulebook refused the call.' },
  { id: 'default', label: 'Default — no rule', hint: 'No rule allowed the call (or the tool was unknown or switched off). Anything not allowed is refused.' },
  { id: 'paused', label: 'Agent paused', hint: 'The agent was paused by its owner, by auto-pause or by the emergency stop.' },
  { id: 'invalid', label: 'Invalid arguments', hint: 'The arguments did not match the tool’s input schema.' },
  { id: 'expiry', label: 'Approval expired', hint: 'No one decided a held call in time. Expiry is a refusal.' },
  { id: 'rejected', label: 'Rejected by a person', hint: 'An approver said no to a held call.' },
];

export const LEVEL_REFUSAL_CLASSES: { id: LevelRefusalClass; label: string; hint: string; level: 'l1' | 'l2' | 'l3'; ruleIds: string[] }[] = [
  { id: 'autonomy', label: 'No autonomy grant', hint: 'Earned autonomy (L3): the agent had no grant above A0 Observe for this tool, so a write was refused.', level: 'l3', ruleIds: ['autonomy-a0'] },
  // packs install from L1 as a dry run: there the check only notes what it would have refused; it refuses from L2
  { id: 'pack_gate', label: 'Regulatory pack', hint: 'A regulatory pack’s declaration (ledger1, invoice1, collect1) does not admit this write. At L1 the pack is a dry run: the receipt notes what would have been refused and nothing is refused.', level: 'l1', ruleIds: ['pack-gate', 'pack-declaration'] },
];

export const REFUSAL_CLASSES_FULL: { id: RefusalClassFull; label: string; hint: string; level?: 'l1' | 'l2' | 'l3' }[] = [...REFUSAL_CLASSES, ...LEVEL_REFUSAL_CLASSES];

/** The fine class, including the level-specific ones. */
export function refusalClassFull(r: Receipt): RefusalClassFull | undefined {
  if (r.decision !== 'refuse') return undefined;
  if (r.kind === 'approval') return r.approval?.status === 'expired' ? 'expiry' : 'rejected';
  const lv = LEVEL_REFUSAL_CLASSES.find((c) => c.ruleIds.includes(r.rule_id ?? '') || (c.id === 'autonomy' && !!r.rule_id?.startsWith('autonomy-')));
  if (lv) return lv.id;
  switch (r.rule_id) {
    case 'agent-paused': return 'paused';
    case 'invalid-arguments': return 'invalid';
    case 'default': case 'no-rulebook': case 'rulebook-invalid': case 'gate-error': case 'tool-disabled': return 'default';
    default: return 'rule';
  }
}

/** The shared class (level-specific refusals fold into 'rule' for packs and autonomy, 'default' otherwise). */
export function refusalClass(r: Receipt): RefusalClass | undefined {
  const c = refusalClassFull(r);
  if (c === 'autonomy' || c === 'pack_gate') return 'rule';
  return c;
}

/**
 * The rule ids the guard writes itself, not lines in a customer's rulebook: the 17 system refusal ids listed on the
 * developer Errors page (developers/sections/More.tsx), in the same order, plus the autonomy ids that hold or release
 * a call without refusing it. This is the one source for SYSTEM_RULES, the receipt page's list of system ids and
 * Assurance › Refusals' "Refused by the guard itself". Nothing writes a counterparty refusal id, so none is listed.
 */
export type GuardRuleGroup = 'guard' | 'consent' | 'pack' | 'autonomy';
export const GUARD_RULES: { id: string; group: GuardRuleGroup; refuses: boolean; text: string }[] = [
  { id: 'POLICY.TENANT_STOPPED', group: 'guard', refuses: true, text: 'The organisation’s pilot reached its hard stop, so writes are paused and no call runs until an owner moves to the paid plan. This is the one refusal that writes no receipt; the stop itself is recorded once.' },
  { id: 'RECEIPT_WRITE_FAILED', group: 'guard', refuses: true, text: 'The receipt writer had failed, and the guard runs nothing it cannot record. The call was refused and not run; the refusals are counted and written to the chain once receipts can be written again.' },
  { id: 'agent-paused', group: 'guard', refuses: true, text: 'The agent was paused (own switch, auto-pause or emergency stop). Every call is refused until it is resumed.' },
  { id: 'sandbox-limit', group: 'guard', refuses: true, text: 'A sandbox key (sk_sbx_) was over its limit — 10 calls a minute, 2 at once or 5,000 a month (GATE.SANDBOX_LIMIT_REACHED). Recorded like any refusal; sandbox calls are metered at 0 and never billed.' },
  // Shown at every level: L1 copy never says "signed", so these stay level-neutral.
  { id: 'no-rulebook', group: 'guard', refuses: true, text: 'No rulebook version was published for this agent, so every call is refused.' },
  { id: 'rulebook-invalid', group: 'guard', refuses: true, text: 'The published rulebook did not verify against its key, so the guard refused rather than trust it.' },
  { id: 'default', group: 'guard', refuses: true, text: 'No rule allowed this call. Anything not explicitly allowed is refused.' },
  { id: 'tool-disabled', group: 'guard', refuses: true, text: 'The tool is switched off on its agent or connector, so the call was refused whatever the rulebook allows. New tools from your own MCP servers start switched off; switch the tool on under Connectors once its risk tags are confirmed.' },
  { id: 'invalid-arguments', group: 'guard', refuses: true, text: 'The arguments did not match the tool’s input schema.' },
  { id: 'gate-error', group: 'guard', refuses: true, text: 'Something failed inside the guard. It fails closed: the call is refused and recorded.' },
  // G1, the DPDP consent check (mock/records.ts): a call that writes to a person needs an active consent for the
  // organisation's contact purpose on the channel it uses. It runs once the organisation keeps a consent ledger.
  { id: 'G1_NO_CONSENT', group: 'consent', refuses: true, text: 'DPDP consent check: the call writes to a person (email, SMS, WhatsApp or a phone call), and no consent for the organisation’s contact purpose is on record for that address. Capture consent through your own process, then send the call again.' },
  { id: 'G1_CHANNEL', group: 'consent', refuses: true, text: 'DPDP consent check: the person has consented, but only for other channels, not the one this call uses. Ask for consent on this channel, or reach the person on a channel they agreed to.' },
  { id: 'G1_WITHDRAWN', group: 'consent', refuses: true, text: 'DPDP consent check: the person withdrew their consent, so calls after the withdrawal are refused. Calls before it stay as they were recorded. Do not reuse the old consent.' },
  { id: 'G1_EXPIRED', group: 'consent', refuses: true, text: 'DPDP consent check: the person’s consent has expired. Ask them again before writing to them; do not reuse the old consent.' },
  { id: 'pack-gate', group: 'pack', refuses: true, text: 'A regulatory pack’s declaration does not admit this write type (for example a delete under ledger1), so it is refused.' },
  { id: 'pack-declaration', group: 'pack', refuses: true, text: 'The write breaks a condition of the regulatory pack’s declaration (contact window, template or daily contact cap). Where the pack only needs a named person to decide, the call is held, not refused.' },
  { id: 'autonomy-a0', group: 'autonomy', refuses: true, text: 'Earned autonomy (L3): this agent had no level above A0 Observe for this tool, so a write was refused. A0 reads only.' },
  { id: 'autonomy-a1', group: 'autonomy', refuses: false, text: 'Earned autonomy (L3): at A1 Draft, writes other than drafts are held for a person.' },
  { id: 'autonomy-a2', group: 'autonomy', refuses: false, text: 'Earned autonomy (L3): at A2 Propose, a person approves every write.' },
  { id: 'autonomy-a4', group: 'autonomy', refuses: false, text: 'Earned autonomy (L3): at A4 Act bounded, a held call inside the granted bound runs without asking. A4 is not yet available.' },
  { id: 'autonomy-a5', group: 'autonomy', refuses: false, text: 'Earned autonomy (L3): at A5 Act broad, a held call runs without asking; a refusal stays a refusal. A5 is not yet available.' },
];

/** Plain-English text for every rule id the guard writes itself (see GUARD_RULES). No prototype, so only these ids match. */
export const SYSTEM_RULES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries(GUARD_RULES.map((g) => [g.id, g.text])));

/** True when a rule id is one the guard writes itself, not a line in the customer's rulebook. */
export function isGuardRule(id: string | undefined): boolean {
  return !!id && Object.prototype.hasOwnProperty.call(SYSTEM_RULES, id);
}

/**
 * Guard ids whose receipt carries a more specific reason than the generic text above: the consent check names the
 * purpose and channel, tool-disabled names where the tool is switched off, and RECEIPT_WRITE_FAILED says when the
 * writer failed. For these the receipt's own reason comes first.
 */
const OWN_REASON_RULES = new Set<string>(['G1_NO_CONSENT', 'G1_CHANNEL', 'G1_WITHDRAWN', 'G1_EXPIRED', 'tool-disabled', 'RECEIPT_WRITE_FAILED']);

/** The text that explains why a rule refused a call: the receipt's own reason where it is the more specific, else the guard's text. */
export function ruleExitText(id: string, reason: string | undefined, fallback = ''): string {
  if (OWN_REASON_RULES.has(id)) return reason ?? SYSTEM_RULES[id] ?? fallback;
  return SYSTEM_RULES[id] ?? reason ?? fallback;
}

/** The system refusal ids, one group a line, for the receipt page's "Rulebook default" block. From GUARD_RULES. */
export function systemRuleIdsYaml(): string {
  const ids = (g: GuardRuleGroup) => GUARD_RULES.filter((x) => x.group === g && x.refuses).map((x) => x.id).join(' · ');
  const holds = GUARD_RULES.filter((x) => x.group === 'autonomy' && !x.refuses && (x.id === 'autonomy-a1' || x.id === 'autonomy-a2')).map((x) => x.id);
  const n = GUARD_RULES.filter((x) => x.refuses).length;
  return [
    'default: refuse   # anything no rule allows is refused',
    `# system refusal ids (${n}): ${ids('guard')}`,
    `# consent check, from L1: ${ids('consent')}`,
    `# pack checks: ${ids('pack')} (a dry run at L1: noted on the receipt, refused from L2)`,
    `# autonomy, from L3: ${ids('autonomy')} (${holds.join(' and ')} hold a call for a person; they do not refuse)`,
  ].join('\n');
}

/* ── Plain-language story of a receipt ────────────────────── */

const asNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : undefined);

export function describeCall(tool?: string, args?: Record<string, unknown>): string {
  if (!tool) return 'make a call';
  const a = args ?? {};
  const verbRaw = (tool.split('.').pop() ?? tool).replace(/_/g, ' ');
  const verb = verbRaw === 'record payment' ? 'record a payment' : verbRaw === 'send email' ? 'send an email' : verbRaw;
  const parts = [verb];
  if (a.service) parts.push(String(a.service) + (a.version ? ` ${a.version}` : ''));
  const amt = asNum(a.amount ?? a.amount_due);
  if (amt !== undefined) parts.push(`of ${rupees(amt)}`);
  const moving = /pay|transfer|send|email|remind|notice/.test(verbRaw);
  const party = a.vendor ?? a.counterparty ?? a.customer ?? a.candidate;
  if (party !== undefined) parts.push(`${moving ? 'to' : 'for'} ${party}`);
  else if (a.to_domain !== undefined) parts.push(`to ${a.to_domain}`);
  else if (a.to_account !== undefined) parts.push(`to ${a.to_account}`);
  if (a.environment) parts.push(`in ${a.environment}`);
  return parts.join(' ');
}

export function later(fromIso: string, toIso: string): string {
  const ms = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());
  const m = Math.round(ms / 60000);
  if (m < 1) return 'within a minute';
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} later`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${h === 1 ? 'hour' : 'hours'} later`;
  return `${Math.round(h / 24)} days later`;
}

const CHANNEL_PHRASE: Record<string, string> = { web: 'in the console', email: 'by email link', phone_link: 'by phone link', slack: 'on Slack', whatsapp: 'on WhatsApp' };
export const channelPhrase = (c?: string) => (c ? ` ${CHANNEL_PHRASE[c] ?? `on ${channelLabel[c] ?? c}`}` : '');

const groupName =(id?: unknown) => (typeof id === 'string' ? APPROVER_GROUPS.find((g) => g.id === id)?.name.toLowerCase() ?? id : 'a person');

const levelName = (v: string) => (v in LEVEL_INFO ? LEVEL_INFO[v as LevelId].label : v || 'the next level');
const yes = (v: string) => v === 'true';

type Phrase = (s: (k: string) => string, r: Receipt) => string;

/** A plain-language phrase for every admin action the console and the platform write. */
const ADMIN_PHRASES: Record<string, Phrase> = {
  // rulebooks and dual control
  'rulebook.published': (s, r) => `published version ${s('version')} of the ${s('rulebook') || r.agent} rulebook${s('reviewed_by') ? `, reviewed by ${userName(s('reviewed_by'))}` : ''}${s('replay_test') ? '; no replay test was possible (the replay store was off)' : ''}`,
  'review.requested': (s, r) => `asked a second person to review version ${s('version')} of the ${s('rulebook') || r.agent} rulebook`,
  'review.approved': (s, r) => `approved the review of version ${s('version')} of the ${s('rulebook') || r.agent} rulebook (dual control)`,
  'review.changes_requested': (s, r) => `sent version ${s('version')} of the ${s('rulebook') || r.agent} rulebook back for changes`,
  'suggestion.drafted': (s) => `turned rule suggestion ${s('suggestion')} into a draft`,
  'suggestion.dismissed': (s) => `dismissed rule suggestion ${s('suggestion')}`,
  'suggestion.dismissal_note': (s) => `dismissed rule suggestion ${s('suggestion')}${s('reason') ? ` — “${s('reason')}”` : ''}`,
  // keys and custody
  'key.rotated': (s, r) => s('old_key')
    ? `rotated ${s('environment') || 'an'} agent key ${s('old_key')} to ${s('new_key')} for ${s('agent') || r.agent}${Number(s('grace_hours')) > 0 ? `; the old key works for ${s('grace_hours')} more hours` : ''}${s('request') ? `, with production review ${s('request')}` : ''}`
    : `rotated the signing key from ${s('old_kid')} to ${s('new_kid')}${s('reason') ? ` (${s('reason')})` : ''}`,
  'drill.refusal_surge': (s) => `ran a refusal-surge drill: ${s('calls')} calls to ${s('tool')} from ${s('agent')}, each refused by rule ${s('rule')}, so the detector could be seen working`,
  'key.signing_started':(s) => `signed the first record with the new key ${s('kid')} (fingerprint ${s('fingerprint')}), straight after the rotation at #${s('rotated_seq')}`,
  'key.ceremony': (s) => `ran a key ceremony (${s('kind') || 'rotation'}${s('quorum') && s('quorum') !== 'n/a' ? `, quorum ${s('quorum')}` : ''}${s('provider') ? `, ${s('provider')}` : ''})`,
  'key.issued': (s, r) => `issued a ${s('environment')} agent key for ${s('agent') || r.agent}`,
  'key.revoked': (s, r) => `revoked agent key ${s('key')} for ${s('agent') || r.agent}`,
  // control and read-only operations tokens (features/keys/tokenStore.ts)
  'token.requested': (s) => `asked for a control token “${s('label')}”; a second owner or admin approves it`,
  'token.approved': (s) => `approved the control token “${s('label')}” asked for by ${userName(s('requested_by'))} (dual control)`,
  'token.declined': (s) => `declined the control token “${s('label')}” asked for by ${userName(s('requested_by'))}${s('note') ? ` — “${s('note')}”` : ''}`,
  'token.request_withdrawn': (s) => `withdrew the ${s('class') === 'control' ? 'control' : 'operations'} token request “${s('label')}”`,
  'token.issued': (s) => `issued ${s('class') === 'control' ? 'control' : 'read-only operations'} token ${s('token')} “${s('label')}”${s('approved_by') ? `, approved by ${userName(s('approved_by'))}` : ''}`,
  'token.revoked': (s) => `revoked ${s('class') === 'control' ? 'control' : 'read-only operations'} token ${s('token')}${s('reason') ? ` — “${s('reason')}”` : ''}`,
  'autonomy.breach_revoke_confirmed': (s, r) => `confirmed revoking the graduation of ${r.agent} on ${s('tool')}, after a breach reported by ${userName(s('reported_by'))}`,
  // developer path to production
  'sandbox.applied': (s, r) => `applied for a sandbox tenant for ${s('agent') || r.agent} (${s('email_domain')}); a verification link was sent`,
  'sandbox.application_refused': (s) => `was refused a sandbox tenant (applicant category: ${s('category').replace(/_/g, ' ')})`,
  'sandbox.tenant_created': (s, r) => `created the sandbox tenant ${s('tenant')} for ${s('agent') || r.agent}, metered at 0`,
  'conformance.run': (s, r) => `ran the conformance suite C1–C14 for ${s('agent') || r.agent}: ${s('passed')} passed, ${s('failed')} failed${s('highest') && s('highest') !== 'none' ? `, ${s('highest')}` : ''}`,
  'production_key.drafted': (s, r) => `started a production-key request for ${s('agent') || r.agent}`,
  'production_key.requested': (s, r) => `asked for a production key for ${s('agent') || r.agent}; review due ${s('review_due')}`,
  'production_key.approved': (s, r) => `approved the production-key request for ${s('agent') || r.agent} (${s('checks_passed')} of 4 checks)`,
  'production_key.declined': (s, r) => `declined the production-key request for ${s('agent') || r.agent}${s('note') ? ` — “${s('note')}”` : ''}`,
  'production_key.withdrawn': (s, r) => `withdrew the production-key request for ${s('agent') || r.agent}`,
  'promotion.requested': (s, r) => `asked to promote ${s('agent') || r.agent} from check and record to a governed run after ${s('advisory_days')} days, with a bypass proof`,
  'promotion.approved': (s, r) => `approved the promotion of ${s('agent') || r.agent} to a governed run`,
  'promotion.declined': (s, r) => `declined the promotion of ${s('agent') || r.agent}${s('note') ? ` — “${s('note')}”` : ''}`,
  'onboarding.applicant_refused': (s) => `was refused at ${s('where') || 'set-up'} (applicant category: ${s('category').replace(/_/g, ' ')})`,
  'key.rotation.requested': (s) => `asked for a rotation of the signing key in ${s('provider') || 'custody'}${s('reason') ? ` — “${s('reason')}”` : ''}`,
  'key.rotation.approved': (s) => `approved the key rotation asked for by ${userName(s('requested_by'))}${s('new_kid') ? `; the new key is ${s('new_kid')}` : ''} (dual control)`,
  'key.rotation.withdrawn': (s) => `withdrew the key rotation request #${s('request_seq')}`,
  'key.compromise.declared': (s) => `declared signing key ${s('kid')} compromised and stopped signing — ${s('reason')}; records are hash-chained but unsigned until a new key signs`,
  'key.compromise.notice_sent': (s) => `sent the key-compromise notice to ${s('to')}${s('cc') ? ` (copy to ${s('cc')})` : ''}, ${yes(s('within_24h')) ? 'within' : 'after'} the 24-hour limit`,
  'key.compromise.closed': (s) => `closed the key compromise: ${s('revoked_kid')} revoked, ${s('new_kid')} signing; ${s('unsigned_from') ? `${s('unsigned_receipts')} receipts unsigned (#${s('unsigned_from')}–#${s('unsigned_to')})` : `the records sealed by the interim chain key ${s('interim_kid')} are unsigned`}`,
  'key.bound': (s) => `bound new signing key ${s('kid')} (fingerprint ${s('fingerprint')}) in ${s('provider')}; signing stays off until a person turns it on`,
  'key.bound_withdrawn': (s) => `withdrew bound key ${s('kid')} before it signed${s('reason') ? ` — ${s('reason')}` : ''}`,
  'key.bound_confirmed': (s) => `confirmed the switch to successor key ${s('kid')}, published by ${userName(s('bound_by'))} (dual control)`,
  'key.change_refused': (s) => `tried to ${s('what') || 'change a key'}; refused because a ${s('reason') || 'chain incident is open'}`,
  'key.contact_set': (s) => `named ${s('name')} (${s('email')}) as the contact for key notices`,
  'key.sign_reconciled': (s) => `reconciled ${s('calls')} ${s('source') || 'Sign calls'} against ${s('signed')} signatures in the chain over ${s('days')} days (${s('discrepancies_open')} discrepancies open)`,
  'key.sign_discrepancy.explained': (s) => `explained ${s('delta')} unmatched Sign calls on ${s('day')} — “${s('note')}”`,
  'key.fingerprint_published': (s) => `recorded the fingerprint of ${s('kid')} as published (${s('channel') === 'dns' ? 'DNS TXT record' : s('channel') === 'print' ? 'printed page' : s('channel')}${s('where') ? `: ${s('where')}` : ''})`,
  // evidence requests (auditor ↔ organisation)
  'evidence.requested': (s) => `asked for evidence for receipts #${s('from_seq')}–#${s('to_seq')} (${s('format') === 'elan1.evidence.bundle.v1' ? 'evidence bundle' : 'auditor pack'}) — ${s('purpose')}`,
  'evidence.request.fulfilled': (s) => `fulfilled evidence request #${s('request_seq')} from ${userName(s('requested_by'))} with export ${s('export')} (${s('receipts')} receipts)`,
  'evidence.request.declined': (s) => `declined evidence request #${s('request_seq')} — ${s('reason')}`,
  'evidence.request.withdrawn': (s) => `withdrew evidence request #${s('request_seq')}`,
  'evidence.request.received': (s) => `collected the evidence sent for request ${s('request')} (${s('receipts')} receipts)`,
  'evidence.request.collected_again': (s) => `downloaded a fresh copy of the evidence for request ${s('request')} (${s('receipts')} receipts; not a new export, not billed)`,
  // levels
  'level.upgraded': (s) => `moved the organisation from ${levelName(s('from'))} to ${levelName(s('to'))}`,
  'level.upgrade_started': (s) => `started the upgrade to ${levelName(s('to'))}`,
  'level.upgrade_seconded': (s) => `seconded the upgrade to ${levelName(s('to'))}`,
  'level.upgrade_stage': (s) => `completed an upgrade step${s('stage') ? ` (${s('stage')})` : ''}${s('to') ? ` towards ${levelName(s('to'))}` : ''}`,
  'level.upgrade_cancelled': (s) => `cancelled the upgrade to ${levelName(s('to'))}`,
  // the L1 → L2 close-out (mock/upgrade.ts)
  'level.upgrade_key_created': (s) => `created signing key ${s('kid')} in AWS KMS (${s('region') || 'ap-south-1'}) before the switch, fingerprint ${s('fingerprint')}${s('replaces') ? `, replacing ${s('replaces')}` : ''}`,
  'level.upgrade_fingerprint_mismatch': (s) => `compared the fingerprint of key ${s('kid')} with the one received out of band: they did not match`,
  'level.upgrade_notice_scheduled': (s) => `scheduled the ${s('kind') === 'fourteen_day' ? '14-day notice' : s('kind') === 'boundary_day' ? 'boundary-day confirmation' : 'auditor note'} to ${s('to_name')}${s('send_at') === 'boundary' ? ' for the boundary' : ''}`,
  'level.upgrade_notice_sent': (s) => `sent the ${s('kind') === 'fourteen_day' ? '14-day notice' : s('kind') === 'boundary_day' ? 'boundary-day confirmation' : 'auditor note'} to ${s('to_name')} by email`,
  'level.upgrade_notice_cancelled': (s) => `cancelled the ${s('kind') === 'fourteen_day' ? '14-day notice' : s('kind') === 'boundary_day' ? 'boundary-day confirmation' : 'auditor note'} to ${s('to_name')}${s('reason') ? ` (${s('reason')})` : ''}`,
  'level.signing_on': (s, r) => `started signing at record #${r.seq} with key ${s('kid')}${s('named_seq') ? `, the sequence named before the switch (#${s('named_seq')})` : ''}`,
  'level.signing_canary': (s) => `wrote signing canary ${s('n')} of ${s('of')} for the first-ten check`,
  'level.upgrade_first_ten_checked': (s) => `checked the first ten signed records against the bound key: ${s('result') === 'pass' ? 'all ten pass' : `${s('failed')} failed`}`,
  'level.upgrade_first_bundle': (s) => `exported the first bundle and verified it (${s('code')}, exit ${s('exit_code')}); a tampered copy gave ${s('tampered_code')}, exit ${s('tampered_exit_code')}`,
  'level.upgrade_closed': (s) => `wrote the closing record of the upgrade to ${levelName(s('to'))}: ${s('checks')} checks pass`,
  'level.upgrade_rolled_back': (s) => s('island_first_seq') ? `rolled back the upgrade to ${levelName(s('from'))}: records #${s('island_first_seq')}–#${s('island_last_seq')} stay as a signed island; the organisation is on ${levelName(s('to'))}` : s('island_kid') ? `rolled back the upgrade to ${levelName(s('from'))}: the records signed by ${s('island_kid')} stay as a signed island; the organisation is on ${levelName(s('to'))}` : `rolled back the upgrade to ${levelName(s('to'))}${s('reason') ? ` — ${s('reason')}` : ''}`,
  // agents and the stop
  'agent.created': (_s, r) => `added the agent ${r.agent}`,
  'agent.paused': (s, r) => `paused ${r.agent}${s('reason') ? ` — ${s('reason')}` : ''}`,
  'agent.resumed': (_s, r) => `resumed ${r.agent}`,
  'agent.updated': (s, r) => `changed ${s('fields') ? s('fields').replace(/_/g, ' ').replace(/,/g, ', ') : 'the settings'} of ${s('agent') || r.agent}`,
  'agent.auto_pause_changed': (s, r) => `turned auto-pause on high alerts ${yes(s('auto_pause_on_high')) ? 'on' : 'off'} for ${s('agent') || r.agent}`,
  'stop.engaged': (s) => `engaged the emergency stop (${s('agents_paused')} agents paused) — ${s('reason')}`,
  'stop.lifted': (s) => `lifted the emergency stop (${s('agents_resumed')} agents resumed)`,
  'stop.widened': (s) => `widened the emergency stop ${s('scope') === 'all_agents' ? 'to every agent' : `by ${s('agents_added')} ${s('agents_added') === '1' ? 'agent' : 'agents'}${s('added') ? ` (${s('added')})` : ''}`}${Number(s('approvals_held')) ? `; ${s('approvals_held')} waiting approvals held` : ''} — ${s('reason')}`,
  // dual control on the lift (from L2), break-glass, incidents declared by hand, CERT-In, drills, approver sampling
  'stop.lift_requested': (s) => `asked to lift the emergency stop — ${s('note')} (a second owner or admin must approve)`,
  'stop.lift_approved': (s) => `approved lifting the emergency stop as the second person, asked by ${userName(s('requested_by'))}`,
  'stop.lift_declined': (s) => `declined lifting the emergency stop asked by ${userName(s('requested_by'))} — ${s('reason')}`,
  'stop.lift_withdrawn': () => 'withdrew their request to lift the emergency stop',
  'breakglass.requested': (s) => `asked for emergency access for ${userName(s('for'))} for ${s('minutes')} minutes — ${s('reason')}`,
  'breakglass.approved': (s) => `approved emergency access for ${userName(s('for'))} for ${s('minutes')} minutes, asked by ${userName(s('requested_by'))}`,
  'breakglass.declined': (s) => `declined emergency access for ${userName(s('for'))} — ${s('reason')}`,
  'breakglass.withdrawn': (s) => `withdrew the request for emergency access for ${userName(s('for'))}`,
  'breakglass.ended': (s) => `ended emergency access for ${userName(s('for'))} after ${s('minutes_used')} minutes`,
  'breakglass.expired': (s) => `emergency access for ${userName(s('for'))} ended when its ${s('minutes')} minutes ran out`,
  'incident.declared': (s) => `declared incident ${s('incident')} by hand: ${s('title')} (${s('class').replace(/_/g, ' ')})${yes(s('cert_in')) ? '; the CERT-In six-hour clock started' : ''}`,
  'incident.certin_draft_saved': (s) => `saved the CERT-In report draft for incident ${s('incident')}`,
  'incident.certin_submitted': (s) => `recorded the CERT-In report for incident ${s('incident')} (${s('reference')}), ${s('hours_after_notice')} hours after notice${yes(s('late')) ? ', after the six-hour deadline' : ''}`,
  'incident.certin_not_reportable': (s) => `recorded incident ${s('incident')} as not reportable to CERT-In — ${s('reason')}`,
  'health.drill_started': (s) => `started a ${String(s('kind')).replace(/_/g, '-')} drill for ${s('minutes')} minutes`,
  'health.drill_ended': (s) => `recorded the end of the receipt-write drill: receipts are written again; ${s('refused')} agent calls were refused while the writer was failed and none ran`,
  'health.write_recovered': (s) => `recorded that receipts are written again after a write failure; ${s('refused')} agent calls were refused while it lasted and none ran`,
  'maintenance.started_early': (s) => `started the planned maintenance window “${s('title')}” early, for a demonstration (${s('minutes')} minutes)`,
  'maintenance.ended_early': (s) => `ended the demonstration maintenance window “${s('title')}” early`,
  'approver.sample_drawn': (s) => `drew ${s('size')} of ${userName(s('approver'))}’s approvals for review — ${s('reason')}`,
  'approver.sample_reviewed': (s) => `reviewed approval ${s('approval')} sampled from ${userName(s('approver'))}: ${s('outcome') === 'sound' ? 'sound' : 'a concern'}`,
  'approver.sample_closed': (s) => `closed the sample of ${userName(s('approver'))}’s approvals: ${s('reviewed')} reviewed, ${s('concerns')} with a concern`,
  // approvals
  'approval.rerouted': (s) => `re-routed approval ${s('approval')} from ${s('from') || 'its group'} to ${s('to')}`,
  'approval.extended': (s) => `extended approval ${s('approval')} once by ${s('hours')} hours — ${s('reason')}`,
  'approval.reversed': (s) => `reversed approval ${s('approval')} (result #${s('result_seq')}), ${s('days_after')} days after it ran — ${s('reason')}`,
  'approval.delegated': (s) => `delegated ${userName(s('from'))}’s approvals to ${userName(s('to'))} until ${s('until').slice(0, 10)} — ${s('reason')}`,
  'approval.delegation_revoked': (s) => `ended the delegation from ${userName(s('from'))} to ${userName(s('to'))}`,
  'approval.same_actor_policy': (s) => `set approving your own agent’s action to ${s('to') === 'forbid' ? 'forbidden' : 'flagged'}`,
  'approval.step_up_policy': (s) => `set step-up for approvals at or above ₹${Number(s('above')).toLocaleString('en-IN')}${yes(s('irreversible')) ? ' and for every irreversible call' : ''}`,
  'approval.rule_drafted': (s) => `drafted rule ${s('rule')} in ${s('rulebook')} v${s('draft_version')} from approval ${s('approval')}`,
  'approvals.outage_started': (s) => `took the approvals service down as a demonstration (${s('waiting')} waiting; nothing can be decided or expire)`,
  'approvals.outage_ended': (s) => `ended the approvals outage after ${s('minutes')} minutes (${s('expiry_extended')} waiting approvals had their expiry moved)`,
  'approval.escalated': (s) => `escalated approval ${s('approval')} from ${s('from')} to the backup group ${s('to')} after ${s('after_minutes')} minutes with no decision`,
  'approval.notified': (s) => `told ${s('people')} ${s('people') === '1' ? 'approver' : 'approvers'}${s('reason') ? ` in ${s('group')} (${s('reason') === 'escalated' ? 'after escalation' : 're-routed'})` : ''} about approval ${s('approval')}:${s('email')} by email${Number(s('slack')) ? `, ${s('slack')} in Slack` : ''}${Number(s('whatsapp')) ? `, ${s('whatsapp')} in WhatsApp` : ''}, each with a single-use link${yes(s('chat_buttons')) ? '; chat messages carry Approve and Reject buttons' : ''}${s('relay') ? ` (email through ${s('relay')})` : ''}`,
  'approval.link_sent': (s) => `sent a single-use link for approval ${s('approval')} to ${userName(s('to'))} by ${s('channel') === 'whatsapp' ? 'WhatsApp' : s('channel') === 'slack' ? 'Slack' : s('channel') === 'phone_link' ? 'phone link' : 'email'}${yes(s('chat_buttons')) ? ' with Approve and Reject buttons' : ''}`,
  'approval.decide_refused': (s) => `tried to ${s('attempted') === 'reject' ? 'reject' : 'approve'} approval ${s('approval')} and was refused: ${s('reason') || `not in the ${s('approver_group')} approver group`}`,
  'escalation.updated': (s) => `set escalation for the ${s('group')} group: ${yes(s('enabled')) ? `after ${s('after_minutes')} minutes to ${s('backup')}` : 'off'}`,
  // evidence
  'evidence.exported': (s) => `exported ${s('format') === 'elan1.evidence.bundle.v1' ? 'an 8-member evidence bundle' : 'an auditor pack'} of ${s('receipts')} receipts${s('seals') ? ` (${s('seals')} sealed)` : ''}${s('profile') && s('profile') !== 'none' ? `, claiming profile ${s('profile')}` : ''}${s('part') ? `, part ${s('part')}` : ''}${s('container') ? ` as ${s('container').toUpperCase()}` : ''}${s('enforcement') ? `; enforcement mode ${s('enforcement')}` : ''}${s('charge') && s('charge') !== '0' ? `; ${rupees(Number(s('charge')))}` : ''}`,
  'evidence.integrity_run': (s) => `ran the integrity check on #${s('from_seq')}–#${s('to_seq')} (${s('records')} records, ${s('signatures')} signatures or seals, ${s('checkpoints')} checkpoints): ${s('result') === 'pass' ? 'no break found' : `broken at #${s('broken_at')}`}`,
  'evidence.continuity_report': (s) => `downloaded the continuity report (${s('runs')} runs, ${s('gaps')} gaps, ${s('failures')} failures, ${s('unchecked')} records not yet checked)`,
  'record.evidence_exported': (s) => `exported the evidence for record ${s('record')} (${s('receipts')} receipts)`,
  'profile.run': (s) => `ran the ${s('profile')} verifier profile v${s('version')}: ${s('result') === 'pass' ? 'every rule passed' : `failed ${s('failing_rules') || 'a rule'}`}`,
  'pack.installed': (s) => `installed the ${s('pack')} regulatory pack (profile ${s('profile')})`,
  'pack.exported': (s) => `exported ${s('export')} from ${s('pack')} (${s('rows')} rows)`,
  // pack factory: portfolio, tests, pilot, reconciliation, removal (mock/packsFactory.ts)
  'pack.uninstalled': (s) => `removed the ${s('pack')} regulatory pack (${s('mode') === 'live' ? 'billed to the end of this month' : 'a dry run, never billed'}) — ${s('reason')}`,
  'pack.candidate_proposed': (s) => `proposed ${s('candidate')} for the pack portfolio (gates failing: ${s('gates_failed')})`,
  'pack.candidate_admitted': (s) => `admitted ${s('candidate')} to the build queue under dual control (proposed by ${s('proposed_by')})`,
  'pack.candidate_rejected': (s) => `rejected ${s('candidate')} into the portfolio register (${s('failed_gates')}): “${s('sentence')}”`,
  'pack.tests_run': (s) => `ran the ${s('pack')} acceptance tests T1–T8: ${s('passed')} pass, ${s('failed')} fail${s('failing') && s('failing') !== 'none' ? ` (${s('failing')})` : ''}`,
  'pack.reversal_drill': (s) => `recorded a reversal drill for ${s('write_type')} in ${s('pack')}`,
  'pack.auditor_reading': (s) => `recorded ${s('auditor')}’s reading of the ${s('pack')} report (T8)`,
  'pack.pilot_started': (s) => `started the 90-day ${s('pack')} pilot at ${s('level').toUpperCase()} with ${s('auditor')} (${s('firm')})`,
  'pack.pilot_necessity': (s) => `recorded the day-0 necessity statement for the ${s('pack')} pilot (${s('not_measurable')} not_measurable rows)`,
  'pack.pilot_self_export': (s) => `recorded the day-76 export for the ${s('pack')} pilot (${s('receipts')} records; ${yes(s('help_needed')) ? 'help was needed' : 'no help needed'})`,
  'pack.pilot_air_gap': (s) => `recorded the offline verifier run for the ${s('pack')} pilot: ${s('export_seq') ? `the customer’s bundle (export #${s('export_seq')})` : 'bundle'} exit ${s('bundle_exit')}, tampered copy exit ${s('tampered_exit')}${s('early_reason') ? ` — early, on day ${s('recorded_day')}: ${s('early_reason')}` : ''}`,
  'pack.pilot_verdict': (s) => `recorded ${s('auditor')}’s written verdict on the ${s('pack')} pilot (${s('outcome').replace(/_/g, ' ')})`,
  'pack.pilot_closed': (s) => `closed the ${s('pack')} pilot: “would you pay for this on its own line?” — ${s('gd_answer')}`,
  'pack.pilot_stopped': (s) => `stopped the ${s('pack')} pilot — ${s('reason')}`,
  'pack.reconciled': (s) => `reconciled ${s('pack')} two ways against ${s('target')}: ${s('matched')} matched, ${s('target_only')} changes with no record, ${s('chain_only')} records with no change`,
  'pack.reconciliation_explained': (s) => `explained ${s('record')} in the ${s('pack')} reconciliation — ${s('note')}`,
  // L1 copy never says "signed": an L1 author is recorded (the receipt is sealed in a hash chain); L2+ authors sign
  'profile.submitted': (s) => `${['l2', 'l3', 'sovereign'].includes(s('level')) ? 'signed' : 'recorded'} verifier profile ${s('profile')} v${s('version')} as its author`,
  'profile.second_reader': (s) => `recorded the second reading of verifier profile ${s('profile')} (P11)`,
  'profile.fixtures_run': (s) => `ran the fixture tests for verifier profile ${s('profile')}: good exit ${s('good')}, tampered ${s('tampered')}, non-conforming ${s('nonconforming')}, incomplete ${s('incomplete')}`,
  'profile.issued': (s) => `issued verifier profile ${s('profile')} v${s('version')} under dual control (author ${s('author')})`,
  'profile.withdrawn': (s) => `withdrew verifier profile ${s('profile')} v${s('version')} — ${s('reason')}${yes(s('order_cancelled')) ? '; its order was cancelled with it' : ''}`,
  // counterparties and disclosure (L3)
  'counterparty.added': (s) => `added ${s('counterparty')} (${s('kind')}) to the counterparty register with ${s('seats')} seat${s('seats') === '1' ? '' : 's'}`,
  'counterparty.receipt.issued': (s) => `issued receipt #${s('seq')} to ${s('counterparty')}, revealing ${s('revealed')} of ${s('committed')} committed fields`,
  'counterparty.receipt.received': (s) => `received receipt #${s('seq')} from ${s('from')}; it ${yes(s('verified')) ? 'verified' : 'did not verify'} on arrival`,
  'counterparty.receipt.verified': (s) => `verified receipt #${s('seq')} from ${s('from')} and bound it into this chain: ${s('result')}`,
  'disclosure.created': (s) => `shared receipt #${s('seq')} with ${s('audience')}, revealing ${s('revealed')} of ${s('committed')} committed fields${s('format') ? ` (${s('format')})` : ''}`,
  'disclosure.exported': (s) => `exported a redacted copy of receipt #${s('seq')}, revealing ${s('revealed')} of ${s('committed')} committed fields`,
  'disclosure.revoked': (s) => `withdrew disclosure ${s('disclosure')} of receipt #${s('seq')}`,
  'disclosure.profile.saved': (s) => `${s('change') === 'updated' ? 'updated' : 'saved'} the disclosure profile “${s('profile')}” (${s('purpose')}), revealing ${s('revealed')} fields for ${s('expires_days')} days`,
  'disclosure.profile.removed': (s) => `removed the disclosure profile “${s('profile')}”`,
  'disclosure.bundle.created': (s) => `signed a disclosure bundle of ${s('receipts')} receipts (#${s('from_seq')}–#${s('to_seq')}) for ${s('audience')}, revealing ${s('revealed')} of ${s('committed')} fields each${s('profile') ? ` (profile “${s('profile')}”)` : ''}`,
  'disclosure.bundle.exported': (s) => (s('via') === 'portal' ? `recorded that ${s('by') || s('audience')} downloaded disclosure bundle ${s('bundle')} (${s('receipts')} receipts, #${s('from_seq')}–#${s('to_seq')}) from its portal link as one file` : `downloaded disclosure bundle ${s('bundle')} (${s('receipts')} receipts, #${s('from_seq')}–#${s('to_seq')}) as one file`),
  'disclosure.bundle.revoked': (s) => `withdrew disclosure bundle ${s('bundle')} (#${s('from_seq')}–#${s('to_seq')}) for ${s('audience')}`,
  'counterparty.first_issue.acknowledged': (s) => `acknowledged the volume and reversal warning before the first ${s('what')} to ${s('audience')} (about ${s('monthly_volume')} a month${s('tool') ? ` of ${s('tool')}` : ''})`,
  'counterparty.receipt.accept_started': (s) => `started accepting receipt #${s('seq')} from ${s('from')}; a second owner or admin completes it`,
  'counterparty.receipt.accepted': (s) => `accepted receipt #${s('seq')} from ${s('from')} as the second person, after ${userName(s('first_by'))}`,
  'counterparty.receipt.accept_refused': (s) => `refused to accept receipt #${s('seq')} from ${s('from')}: ${s('reason')}`,
  'counterparty.receipt.revoked': (s) => `revoked receipt #${s('seq')} issued to ${s('counterparty')}: ${s('reason')}${yes(s('dispute_closed')) ? '; the open dispute about it is closed by the revocation' : ''}`,
  'counterparty.receipt.revocation_received': (s) => `was told that ${s('from')} revoked receipt #${s('seq')}: ${s('reason')}${yes(s('dispute_closed')) ? '; the dispute about it is closed' : ''}`,
  'counterparty.receipt.disputed': (s) => `disputed receipt #${s('seq')} from ${s('from')}: ${s('reason')}`,
  'counterparty.receipt.dispute_received': (s) => `received a dispute from ${s('from')} about receipt #${s('seq')}: ${s('reason')}`,
  'counterparty.receipt.dispute_recorded': (s) => `recorded a dispute about receipt #${s('seq')} raised by ${s('raised_by')} at ${s('counterparty')}${s('via') === 'portal' ? ' through its portal' : ''}`,
  'counterparty.receipt.dispute_resolved': (s) => (s('outcome') === 'withdrawn' ? `${s('side') === 'received' && s('counterparty') ? `was told that ${s('counterparty')} withdrew` : 'withdrew'} the dispute about receipt #${s('seq')} (${s('note')})` : `resolved the dispute about receipt #${s('seq')}: ${s('outcome') === 'upheld' ? 'upheld' : 'rejected'} (${s('note')})`),
  // autonomy (L3)
  'autonomy.granted': (s, r) => (s('grants') ? `carried over ${s('grants')} autonomy grants at ${s('level')} (${s('reason')})` : `granted ${r.agent} autonomy ${s('level')} for ${s('tool')}${s('bound_max') ? ` up to ${s('bound_field')} ${rupees(Number(s('bound_max')))}` : ''}`),
  'autonomy.revoked': (s, r) => `revoked the ${s('level')} autonomy of ${r.agent} for ${s('tool')}${s('falls_back_to') ? `; it is back to ${s('falls_back_to')}` : ''}${yes(s('automatic')) ? ` (automatically, on autonomy breach incident ${s('incident')}; it cannot be proposed again for ${s('cooldown_days') || 30} days)` : s('cooldown_days') ? `; it cannot be proposed again for ${s('cooldown_days')} days` : ''}`,
  'autonomy.graduation.approved': (s, r) => `approved graduating ${r.agent} to ${s('to')} for ${s('tool')} (${s('approvals')} of ${s('required')} people)`,
  'autonomy.graduation.declined': (s, r) => `declined graduating ${r.agent} from ${s('from')} to ${s('to')} for ${s('tool')}`,
  // graduation only: the A2 starting level, a two-person graduation to A3, its supervised period
  'autonomy.started': (s, r) => `started ${r.agent ? `${r.agent}'s` : ''} ${s('tools')} write types at ${s('level')} Propose (${s('reason')})`.replace(/\s+/g, ' '),
  'autonomy.graduation_proposed': (s, r) => `proposed graduating ${r.agent} from ${s('from')} to ${s('to')} for ${s('tool')} (${s('days')} days, ${s('records')} records, ${s('approvals')} approvals)`,
  'autonomy.graduation_withdrawn': (s, r) => `withdrew the proposal to graduate ${r.agent} to ${s('to')} for ${s('tool')}`,
  'autonomy.graduated': (s, r) => `approved graduating ${r.agent} to ${s('to')} for ${s('tool')}, proposed by ${userName(s('proposed_by'))}; supervised until ${s('supervised_until').slice(0, 10)} (${s('sample')} calls sampled)`,
  'autonomy.sample_reviewed': (s, r) => `reviewed sampled call #${s('call_seq')} of ${r.agent} on ${s('tool')}: ${s('outcome') === 'ok' ? 'right for A3' : 'a concern'}`,
  // erasure (DPDP)
  'erasure.requested': (s) => `opened erasure request ${s('request')} (${s('affected')} sealed records affected; the identifier is stored only as a hash)`,
  'erasure.approved': (s) => `approved erasure request ${s('request')} (${s('approvals')} of ${s('required')} approvers)`,
  'erasure.executed': (s) => `destroyed ${s('salts_destroyed')} salts for erasure request ${s('request')}; the chain ${yes(s('chain_verifies')) ? 'still verifies' : 'was re-checked'}`,
  // records area: erasure refusal, consent ledger, declaration withdrawal, gap records, models, hosting (mock/records.ts)
  'erasure.refused': (s) => `refused erasure request ${s('subject_ref')}: ${s('held')} matching records fall under statutory retention (${s('basis').replace(/,/g, ', ')}) until ${s('hold_until')}`,
  'consent.imported': (s) => `brought ${s('entries')} consent records into the consent ledger from the ${s('source').toLowerCase() || 'consent manager'} (${s('withdrawn')} withdrawn)`,
  'consent.recorded': (s) => `recorded consent ${s('consent')} for ${s('purpose').replace(/_/g, ' ')} on ${s('channel')} (notice ${s('notice')})`,
  'consent.withdrawn': (s) => `recorded the withdrawal of consent ${s('consent')} for ${s('purpose').replace(/_/g, ' ')} (${s('via')}); G1 refuses calls that relied on it from now on`,
  'consent.ledger_extended': (s) => `brought ${s('entries')} more consent records into the consent ledger from the ${s('source').toLowerCase() || 'consent manager'}, one for each address the agents write to`,
  'erasure.plan_recorded': (s) => `recorded the erasure plan for request ${s('request')}: ${s('held')} records held back by statutory retention (${s('held_basis').replace(/,/g, ', ')}), ${s('affected')} left to erase`,
  'declaration.recorded': (s, r) => `recorded declaration ${s('declaration_id') || `decl.${r.agent}`} v${s('declaration_version')} (${s('actor_kind').replace(/_/g, ' ')}, ${s('write_types')} write types)`,
  'declaration.version_withdrawn': (s, r) => `withdrew version ${s('version')} of declaration ${s('declaration') || `decl.${r.agent}`}${yes(s('was_in_force')) ? `; version ${s('now_in_force')} is in force again` : ''} — “${s('reason')}”`,
  'pack.configured': (s) => `configured ${s('pack')}: declaration ${s('declaration')} v${s('version')}${s('changed') && s('changed') !== 'none' ? ` (changed ${s('changed').replace(/,/g, ', ')})` : ''}`,
  'pack.declaration_withdrawn': (s) => `withdrew version ${s('version')} of the ${s('pack')} declaration ${s('declaration')}${yes(s('was_in_force')) ? `; version ${s('now_in_force')} is in force again` : ''} — “${s('reason')}”`,
  'rulebook.version_withdrawn': (s, r) => `withdrew version ${s('version')} of the ${s('rulebook') || r.agent} rulebook${yes(s('was_in_force')) ? `; version ${s('now_in_force')} is in force again` : ''} — “${s('reason')}”`,
  'chain.gap_sealed': (s) => `sealed a gap record ${s('gap')}: ${s('minutes')} minutes from ${s('from').slice(0, 16).replace('T', ' ')} with no receipts (${s('cause').replace(/_/g, ' ')}, about ${s('estimated_missed')} calls not recorded)`,
  'agent.model_recorded': (s, r) => `recorded that ${r.agent} runs ${s('model')} (${s('version')})`,
  'inventory.model_recorded': (s) => `recorded that ${s('system')} runs ${s('model')} (${s('version')})`,
  'inventory.model_doc_exported': (s) => `exported RBI model documentation for ${s('systems')} AI systems (${s('format').toUpperCase()})`,
  'hosting.dedicated_requested': (s) => `asked for a dedicated residency domain in ${s('region')} (hosting profile 2)`,
  'hosting.dedicated_activated': (s) => `cut the organisation over to its dedicated residency domain ${s('domain')}`,
  'hosting.dedicated_returned': (s) => `moved the organisation back to the shared hosted stack — “${s('reason')}”`,
  // identity, deployment, discovery
  'identity.updated': (s) => `changed sign-in: SAML ${yes(s('saml_enabled')) ? (yes(s('saml_enforced')) ? 'on and enforced' : 'on') : 'off'}, SCIM ${yes(s('scim_enabled')) ? 'on' : 'off'}`,
  'identity.scim_token_rotated': (s) => `rotated the SCIM token (new prefix ${s('prefix')})`,
  'update.staged': (s) => `verified the signature of update ${s('version')} against the release key and staged it`,
  'update.rejected': (s) => `rejected update ${s('version')}: its signature did not verify against the release key`,
  'update.applied': (s) => `applied update ${s('version')}`,
  // Sovereign and Elan1 notices (mock/sovereign.ts, mock/tenantNotices.ts)
  'update.imported': (s) => `imported update bundle ${s('version')} from removable media (not trusted until its signature is checked)`,
  'update.rolled_back': (s) => `rolled update ${s('version')} back to ${s('to_version')} — “${s('reason')}”`,
  'egress.blocked': (s) => `was stopped by deny-all egress: ${s('destination')} is outside the network (${s('component')}); nothing was sent`,
  'egress.internal_host_added': (s) => `added ${s('host')} to the internal allow-list (${s('purpose')})`,
  'egress.internal_host_removed': (s) => `removed ${s('host')} from the internal allow-list`,
  'egress.log_exported': (s) => `exported the egress log for the last ${s('days')} days (${s('attempts')} blocked attempts)`,
  'meter.statement_exported': (s) => `exported the usage statement for ${s('period')} to media ${s('media')}: ${s('units')} units from ${s('decisions')} governed actions, chain head #${s('head_seq')}`,
  'meter.statement_handed_over': (s) => `recorded the hand-over of the ${s('period')} usage statement to ${s('to')} (reference ${s('ref')})`,
  'notice.contact_changed': (s) => `named ${s('contact')} as the contact for Elan1’s notices (was ${s('previous')})`,
  'notice.acknowledged': (s) => `acknowledged Elan1’s notice “${s('title')}”`,
  'notice.chain_head_checked': (s) => `checked Elan1’s chain-head statement for ${s('date')} against the chain: #${s('seq')} ${s('result') === 'matches' ? 'matches' : 'does not match'}`,
  'discovery.scanned': (s) => `scanned ${s('sources')} sources for AI systems (${s('unregistered')} not yet registered)`,
  'discovery.dismissed': (s) => `dismissed discovery finding ${s('finding')}${s('reason') ? ` — “${s('reason')}”` : ''}`,
  'inventory.added': (s) => `registered ${s('system')} in the AI inventory${s('source') === 'discovery' ? ' from a discovery finding' : ''}${s('model') ? `, running ${s('model')} (${s('version')})` : ''}`,
  // governance
  'assessment.started': (s) => `started a ${s('template').replace(/_/g, ' ') || 'new'} assessment of ${s('system')}`,
  'assessment.submitted': (s) => `submitted the assessment of ${s('system') || s('assessment')} for sign-off${s('tier') ? ` (result: ${s('tier')} risk)` : ''}`,
  'assessment.approved': (s) => `signed off the assessment of ${s('system') || s('assessment')}`,
  'assessment.changes_requested': (s) => `sent the assessment of ${s('system') || s('assessment')} back for changes`,
  'assessment.reopened': (s) => `reopened assessment ${s('assessment')}`,
  'framework.enabled': (s) => `switched on the ${s('framework')} framework`,
  'framework.disabled': (s) => `switched off the ${s('framework')} framework`,
  'compliance.report_exported': (s) => `exported a coverage report (${s('format')}${s('framework') ? `, ${s('framework')}` : ''})`,
  // connectors
  'connector.added': (s) => `connected ${s('connector')} (${s('tools')} tools, ${s('enabled')} switched on)`,
  'connector.synced': (s) => `synced ${s('connector')} (${s('tools')} tools)`,
  'connector.sync_failed': (s) => `tried to sync ${s('connector')}; the sync failed`,
  'tool.enabled': (s) => `switched on ${s('tool')} in ${s('connector')}`,
  'tool.disabled': (s) => `switched off ${s('tool')} in ${s('connector')}`,
  'tool.tags_changed': (s) => `changed the risk tags of ${s('tool')} in ${s('connector')} to ${s('tags')}`,
  // alerts, incidents, organisation
  'alert.acknowledged': (s) => `acknowledged alert ${s('alert')} (${s('detector').replace(/_/g, ' ')})`,
  'alert.resolved': (s) => `resolved alert ${s('alert')} (${s('detector').replace(/_/g, ' ')})`,
  'incident.report_generated': (s) => `generated the report for incident ${s('incident')} (${s('receipts')} receipts)`,
  'onboarding.completed': () => 'completed onboarding',
  'org.updated': (s) => `updated the organisation profile${s('changed') ? ` (${s('changed')})` : ''}`,
  'member.invited': (s) => `invited a ${s('role')}${s('email_domain') ? ` from ${s('email_domain')}` : s('email') ? ` (${s('email')})` : ''}`,
  'member.role_changed': (s) => `changed a member’s role${s('to') ? ` to ${s('to')}` : s('role') ? ` to ${s('role')}` : ''}`,
  'member.removed': () => 'removed a member',
  'member.suspended': () => 'suspended a member',
  'member.reinstated': () => 'reinstated a member',
  // sign-in and sessions (people, and the counterparty, regulator and partner portals)
  'auth.signed_in': (s) => `signed in (${s('method') || 'password'})${yes(s('break_glass')) ? ' as the break-glass owner while SAML is required' : ''}${s('via') === 'approval_link' ? ' from a single-use approval link' : ''}`,
  'auth.signed_out': (s) => `signed out${s('reason') && s('reason') !== 'Signed out' ? ` (${s('reason').toLowerCase()})` : ''}${s('signed_in_org') ? `, ending this organisation’s entry for a session signed in at ${s('signed_in_org')}` : ''}`,
  'auth.sign_in_refused': (s) => `was refused sign-in: ${({ sso_only: 'single sign-on is required for the address', saml_required: 'SAML is required for everyone', member_suspended: 'the account is suspended here', not_a_member: 'no longer a member here' } as Record<string, string>)[s('reason')] ?? s('reason').replace(/_/g, ' ')}${s('via') === 'approval_link' ? ' (on an approval link)' : ''}`,
  'auth.sign_in_unlocked': (s) => `unlocked sign-in for ${s('member')} (${s('failures')} failed attempt${s('failures') === '1' ? '' : 's'} cleared)`,
  'auth.sso_refused': (s) => `refused a single sign-on from ${s('email_domain')}: no account, and just-in-time accounts are off`,
  'member.password_changed': (s) => `changed their password${s('method') === 'reset_link' ? ' with a reset link' : ''}; other sessions were signed out`,
  'member.password_reset_requested': (s) => `asked for a password reset link (expires in ${s('expires_minutes')} minutes)`,
  'portal.signed_in': (s) => `recorded that ${s('portal_user')} (${s('employer')}) signed in to the ${s('portal')} portal`,
  'portal.signed_out': (s) => `recorded that ${s('portal_user')} (${s('employer')}) signed out of the ${s('portal')} portal`,
  'portal.password_reset_requested': (s) => `sent ${s('portal_user')} (${s('employer')}) a portal password reset link`,
  'portal.password_changed': (s) => `recorded that ${s('portal_user')} (${s('employer')}) changed their portal password`,
  // billing and the meter (features/billing, mock/billing.ts)
  'billing.dispute_opened': (s) => `disputed line ${s('line')} on invoice ${s('invoice')}${s('from_seq') ? ` (receipts #${s('from_seq')}–#${s('to_seq')})` : ''}; the line is held`,
  'billing.dispute_withdrawn': (s) => `withdrew the dispute on line ${s('line')} of invoice ${s('invoice')}; the line is payable again`,
  'billing.dispute_settled': (s) => `${s('decided_by') ? `decided for elan1 (${s('decided_by')}${s('approved_by') ? `, approved by an elan1 founder` : ''})` : 'recorded a decision'} on the dispute over line ${s('line')} of ${s('invoice')}: ${({ upheld: 'upheld', partly_upheld: 'partly upheld', rejected: 'rejected' } as Record<string, string>)[s('outcome')] ?? s('outcome')}${s('credit_note') ? `, credit note ${s('credit_note')} for ₹${Number(s('credit_amount')).toLocaleString('en-IN')}` : ''}`,
  'billing.discount_recorded': (s) => `wrote down a ${s('pct')}% discount, ${s('from')} to ${s('until')} (not in force: only a discount elan1 offers and an owner accepts applies)`,
  'billing.discount_offered': (s) => `offered for elan1 (${s('offered_by')}) ${s('pct')}% off governed actions beyond the allowance, ${s('from')} to ${s('until')}; open until ${s('valid_until')}`,
  'billing.discount_accepted': (s) => `accepted elan1’s offer #${s('offer')}: ${s('pct')}% off governed actions beyond the allowance until ${s('until')}`,
  'billing.discount_declined': (s) => `declined elan1’s discount offer #${s('offer')}${s('reason') && s('reason') !== 'Declined' ? ` — ${s('reason')}` : ''}`,
  'billing.discount_requested': (s) => `asked elan1 (${s('to')}) for ${s('pct')}% off governed actions beyond the allowance for ${s('months')} months${s('needs') === 'founder' ? '; beyond a lead’s cap, so it needs a founder' : ''}`,
  'billing.discount_request_withdrawn': (s) => `withdrew discount request #${s('request')}`,
  'billing.discount_ended': (s) => `ended discount #${s('discount')} early${s('reason') ? ` — ${s('reason')}` : ''}`,
  'billing.pilot_closed': () => 'closed the organisation: the pilot stopped and its 30 read-only days passed without a move to the paid plan',
  'billing.reopen_requested': (s) => `asked elan1 (${s('to')}) to reopen the organisation on the paid plan`,
  'billing.discount_request_declined': (s) => `declined for elan1 (${s('decided_by')}) discount request #${s('request')} — ${s('reason')}`,
  'billing.reopen_decided': (s) => `${s('outcome') === 'approved' ? 'approved' : 'declined'} for elan1 (${s('decided_by')}) the request to reopen the organisation — ${s('note')}`,
  'billing.reconciliation_run': (s) => `reconciled the meter against the chain for ${s('period')}: ${yes(s('matched')) ? 'they agree' : `meter ${s('meter_events')}, chain ${s('chain_decisions')} — the invoice is held`}`,
  'billing.pilot_started': (s) => `started the pilot: free until ${s('ends').slice(0, 10)}, up to ${Number(s('cap')).toLocaleString('en-IN')} governed actions`,
  'billing.pilot_stopped': (s) => `paused writes (POLICY.TENANT_STOPPED): the pilot stopped — ${s('why')}; read-only for ${s('read_only_days') || '30'} days`,
  'billing.pilot_converted': (s) => `moved from the pilot to the paid ${({ l1: 'Guarded', l2: 'Attested', l3: 'Proven', sovereign: 'Sovereign' } as Record<string, string>)[s('plan')] ?? 'Guarded'} plan${s('via') === 'upgrade' ? ' with an upgrade, which ended the pilot at its boundary' : ''}; billing starts then`,
  'billing.addon_ordered': (s) => `ordered ${s('addon') === 'profile' ? `verifier profile ${s('profile')}` : s('addon')}`,
  'billing.addon_cancelled': (s) => `cancelled ${s('addon') === 'profile' ? `verifier profile ${s('profile')}` : s('addon')}${s('cause') === 'profile_withdrawn' ? ' because the profile was withdrawn' : s('with_pack') ? ` with the ${s('with_pack')} pack` : ''} (billed to the end of that month, not from the next)`,
};

/** "webhook.secret_rolled" → "webhook: secret rolled" for actions without their own phrase. */
function humaniseAction(action: string) {
  const [area, ...rest] = action.split('.');
  return `${area.replace(/_/g, ' ')}: ${rest.join(' ').replace(/_/g, ' ')}`;
}

export function adminPhrase(r: Receipt): string {
  const d = r.details ?? {};
  const s = (k: string) => (d[k] !== undefined ? String(d[k]) : '');
  const f = r.action ? ADMIN_PHRASES[r.action] : undefined;
  if (f) return f(s, r);
  return r.action ? `recorded a change — ${humaniseAction(r.action)}` : 'recorded a change';
}

/** True when an admin action has its own plain-language phrase. */
export const hasAdminPhrase = (action?: string) => !!action && action in ADMIN_PHRASES;

export function storyOf(r: Receipt, ctx: { root?: Receipt; followUps?: Receipt[] } = {}): string {
  const who = r.agent ?? 'The agent';
  const rule = r.rule_id;
  const governed = receiptMode(r) === 'governed_run';
  if (r.kind === 'decision') {
    let s = `${who} asked to ${describeCall(r.tool, r.args_summary)}. `;
    const auto = typeof r.details?.autonomy === 'string' ? r.details.autonomy : undefined;
    const noGrant = r.details?.autonomy_grant === 'none';
    const fromRulebook = typeof r.details?.rulebook_decision === 'string' ? r.details.rulebook_decision : undefined;
    if (rule?.startsWith('autonomy-') && fromRulebook) {
      const word = (d?: string) => (d === 'allow' ? 'allowed' : d === 'ask' ? 'held for a person' : d === 'refuse' ? 'refused' : d ?? '');
      s += `The rulebook ${word(fromRulebook)} it; the autonomy grant (${noGrant ? NO_GRANT_LABEL : auto ?? 'A0'}) ${word(r.decision)} it instead. `;
      if (r.decision === 'refuse') return s.trim();
      if (r.decision === 'allow') return s + (governed ? 'Elan1 Govern ran it without asking a person.' : 'The agent runs it without asking a person.');
      const ap = ctx.followUps?.find((x) => x.kind === 'approval');
      return s + (ap ? `${userName(ap.approval?.approver)} ${ap.approval?.status === 'rejected' ? 'rejected' : 'approved'} it ${later(r.ts, ap.ts)}.` : 'It is waiting for a person.');
    }
    if (rule === 'agent-paused') s += r.reason?.startsWith('Emergency stop') ? 'It was refused because the emergency stop was engaged.' : 'It was refused because the agent was paused.';
    else if (rule === 'default') s += 'No rule allowed it, so it was refused by default.';
    else if (rule === 'invalid-arguments') s += 'The arguments did not match the tool’s schema, so it was refused.';
    else if (rule === 'no-rulebook' || rule === 'rulebook-invalid' || rule === 'gate-error') s += `It was refused by the guard (${rule}).`;
    else if (r.decision === 'allow') {
      s += `Rule ${rule} allowed it. `;
      if (governed) s += r.outcome?.status === 'ok' ? `Elan1 Govern ran it${r.outcome.ms ? ` in ${n(r.outcome.ms)} ms` : ''}.` : r.outcome?.status === 'error' ? 'Elan1 Govern ran it and the tool returned an error.' : 'Elan1 Govern ran it.';
      else {
        const out = ctx.followUps?.find((x) => x.kind === 'outcome');
        s += out ? `The agent ran the call itself and reported the outcome ${later(r.ts, out.ts)}.` : 'Elan1 Govern advised and recorded; the agent runs the call itself.';
      }
    } else if (r.decision === 'ask') {
      s += `Rule ${rule} asked ${groupName(r.details?.approver_group)}. `;
      const ap = ctx.followUps?.find((x) => x.kind === 'approval');
      const st = ap?.approval?.status;
      if (ap && (st === 'approved' || st === 'approved_run_failed')) s += `${userName(ap.approval?.approver)} approved it${channelPhrase(ap.approval?.channel)} ${later(r.ts, ap.ts)}.${st === 'approved_run_failed' ? ' The run then failed.' : ''}`;
      else if (ap && st === 'rejected') s += `${userName(ap.approval?.approver)} rejected it${channelPhrase(ap.approval?.channel)} ${later(r.ts, ap.ts)}.`;
      else if (ap && st === 'expired') s += `No one decided within ${r.details?.expires_in ?? 'the expiry'}, so it expired and was refused.`;
      else s += 'It is waiting for a person. Nothing runs until someone approves.';
    } else s += `Rule ${rule} refused it.${r.reason ? ` ${r.reason}` : ''}`;
    return s;
  }
  if (r.kind === 'approval') {
    const call = ctx.root ? ` (${ctx.root.agent} asked to ${describeCall(ctx.root.tool, ctx.root.args_summary)})` : '';
    const st = r.approval?.status;
    if (st === 'expired') return `No one decided the call held at ${seqLabel(r.ref_seq ?? 0)}${call} within its expiry, so it was refused.`;
    const verb = st === 'rejected' ? 'rejected' : 'approved';
    const when = ctx.root ? ` ${later(ctx.root.ts, r.ts).replace('later', 'after it was held')}` : '';
    let s = `${userName(r.approval?.approver ?? r.actor)} ${verb} the call held at ${seqLabel(r.ref_seq ?? 0)}${call}${channelPhrase(r.approval?.channel)}${when}.`;
    if (r.details?.single_use) s += ' The decision came through a single-use link, now recorded as used.';
    if (r.details?.owner_override) s += ' An owner decided outside the approver group; that is recorded.';
    if (r.approval?.self_approval) s += ' The approver also owns this agent.';
    if (verb === 'approved') s += governed ? (r.outcome?.status === 'error' ? ' Elan1 Govern ran it and the tool returned an error.' : ' Elan1 Govern ran it.') : ' The agent runs the call itself.';
    return s;
  }
  if (r.kind === 'outcome') return `${who} reported the outcome of ${seqLabel(r.ref_seq ?? 0)}: ${r.outcome?.status === 'ok' ? 'it ran' : r.outcome?.status === 'error' ? 'the tool returned an error' : 'it did not run'}${r.outcome?.ms ? ` (${n(r.outcome.ms)} ms)` : ''}.`;
  return `${userName(r.actor)} ${adminPhrase(r)}.`;
}

/** Admin actions that bind a receipt received from, or issued to, a counterparty (L3). */
export const RECEIVED_ACTIONS = ['counterparty.receipt.received', 'counterparty.receipt.verified'];
export const ISSUED_ACTIONS = ['counterparty.receipt.issued', 'disclosure.created', 'disclosure.exported'];

/* ── CSV and file download ────────────────────────────────── */

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

export function receiptCsvRow(r: Receipt) {
  return {
    seq: r.seq, ts: r.ts, time_ist: dateTime(r.ts), kind: r.kind, agent: r.agent ?? '', actor: r.actor ? userName(r.actor) : '', tool: r.tool ?? '', action: r.action ?? '',
    decision: r.decision ?? '', rule_id: r.rule_id ?? '', reason: r.reason ?? '', mode: receiptMode(r) ?? '', outcome: outcomeText(r), approval_id: r.approval?.id ?? '',
    approval_status: r.approval?.status ?? '', ref_seq: r.ref_seq ?? '', rulebook_version: r.rulebook?.version ?? '', kid: r.kid, prev_hash: r.prev_hash, hash: r.hash,
  };
}

export function downloadText(filename: string, text: string, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * A button that navigates (avoids nesting a button inside a link). It is left out when the role or the plan cannot
 * open the target, so it never leads to a 403 or a screen above the plan.
 */
export function NavButton({ to, ...props }: ButtonProps & { to: string }) {
  const nav = useNavigate();
  const open = useCanSee(to);
  if (!open) return null;
  return <Button {...props} onClick={() => nav(to)} />;
}

/** A labelled fact, used in compact summary grids. */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('bg-surface p-4 min-w-0', className)}>
      <p className="label">{label}</p>
      <div className="mt-1.5 text-sm min-w-0">{children}</div>
    </div>
  );
}
