import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, ArrowRight } from 'lucide-react';
import { useUi } from '@/store/ui';
import type { Alert, Approval, Detector, Incident, LevelId, Receipt, RiskTier, Rule } from '@/types';
import { Drawer, Banner } from '@/components/ui';
import { seqLabel, dateTime, date, channelLabel, plural, n, tagLabel } from '@/lib/format';
import { ORGS, userName } from '@/mock/users';
import { CHAT_NEVER } from '@/mock/approvalNotify';
import { useOrgId, useOrgLevel } from '@/store/session';
import { claimFor, levelOfReceipt } from '@/features/activity/assurance';
import type { ExtAssessment } from '@/features/assessments/backend';
import { admissionOf, bands, isAnswered, prohibitedAnswer, reviewMonths, summarise, variantOf } from '@/features/assessments/templates';
import { builderExtra, conditionText, groupName, quotaText, toolsForRule } from '@/features/rulebooks/lib';

/**
 * Ask Govern explains records in plain words. It never makes, changes or recommends a decision —
 * decisions are made in code by the rulebook. Explanations here are assembled from the record itself.
 */
function explainReceipt(r: Receipt, claim: string, signedLevel: boolean): string[] {
  const out: string[] = [];
  if (r.kind === 'decision') {
    out.push(`At ${dateTime(r.ts)}, ${r.agent} asked to call ${r.tool}. Elan1 Govern checked the request against rulebook version ${r.rulebook?.version ?? '—'} before anything ran.`);
    if (r.decision === 'allow') out.push(`Rule "${r.rule_id}" allowed it: ${r.reason}${r.details?.mode === 'governed_run' ? ' Elan1 Govern then ran the call itself, holding the credential, and recorded the result.' : ' On this route the agent runs the call with its own credentials; Elan1 Govern only advised and recorded.'}`);
    if (r.decision === 'ask') out.push(`Rule "${r.rule_id}" required a person: ${r.reason} The call was held and the ${r.details?.approver_group ?? 'approver'} group was notified. Nothing ran while it waited.`);
    if (r.decision === 'refuse') out.push(r.rule_id === 'default' ? 'No rule allowed it, so it was refused. Every rulebook refuses anything not explicitly allowed.' : r.rule_id === 'agent-paused' ? `The agent was paused or stopped, so the call was refused before any rule ran. ${r.reason}` : `Rule "${r.rule_id}" refused it: ${r.reason} The call did not run.`);
  } else if (r.kind === 'approval') {
    const st = r.approval?.status;
    out.push(st === 'expired' ? `No one decided on held call ${seqLabel(r.ref_seq ?? 0)} before it expired. Expiry counts as a refusal; the call never ran.` : `${userName(r.approval?.approver)} ${st === 'approved' ? 'approved' : 'rejected'} held call ${seqLabel(r.ref_seq ?? 0)} via ${channelLabel[r.approval?.channel ?? 'web']}. Their reason: "${r.reason}".`);
    if (st === 'approved') out.push(r.outcome?.status === 'error' ? 'The call ran after approval but returned an error, which is recorded here.' : 'The call then ran and its result is part of this receipt.');
  } else if (r.kind === 'admin') {
    out.push(`${userName(r.actor)} performed "${r.action}". Administrative changes are written to the same chain as agent decisions, so the record of who changed the rules sits beside the record of what the rules decided.`);
  } else {
    out.push(`The agent reported the outcome of an earlier call (${seqLabel(r.ref_seq ?? 0)}). On the advisory route Elan1 Govern only sees outcomes the agent chooses to report.`);
  }
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  out.push(`This receipt carries the hash of receipt ${seqLabel(r.seq - 1)} and is ${signedLevel ? 'signed' : 'sealed'} with key ${r.kid}. Changing any field would break its hash and every link after it — that is what "tamper-evident" means here. ${claim}`);
  return out;
}

function explainApproval(a: Approval): string[] {
  return [
    `${a.agentSlug} wanted to call ${a.tool}. Rule "${a.ruleId}" held it because ${a.triggeredBy || a.ruleReason}.`,
    `If approved: ${a.effect}`,
    `Over the last 30 days, calls held by this rule were approved ${a.similar.approved} times and rejected ${a.similar.rejected} times${a.similar.reversed ? `; ${a.similar.reversed} approved call was later reversed` : ''}. These are numbers, not a recommendation — the decision is yours.`,
    `If no one decides by the expiry, the call is refused and that refusal is recorded.`,
  ];
}

const DETECTOR_WORDS: Record<Detector, string> = {
  volume_spike: 'the volume detector, which compares how many calls an agent makes with its usual rate',
  refusal_surge: 'the refusal detector, which watches for a sudden rise in refused calls',
  amount_outlier: 'the amount detector, which compares a payment or transfer amount with the agent’s usual range',
  new_counterparty: 'the new counterparty detector, which notices a payee or recipient the agent has not used before',
  new_tool: 'the new tool detector, which notices an agent calling a tool it has not called before',
  off_hours: 'the off-hours detector, which notices calls outside the agent’s usual working hours',
};

function explainAlert(a: Alert, signedLevel: boolean): string[] {
  const out: string[] = [];
  out.push(`At ${dateTime(a.createdAt)}, ${DETECTOR_WORDS[a.detector] ?? `the ${a.detector.replace(/_/g, ' ')} detector`} raised a ${a.severity}-severity alert on ${a.agentSlug}.`);
  out.push(`What triggered it: ${a.detail}${/[.!?]$/.test(a.detail.trim()) ? '' : '.'} The usual level was ${a.baseline}; this time it was ${a.observed}.`);
  if (a.relatedSeqs.length) {
    const shown = a.relatedSeqs.slice(0, 8).map((s) => seqLabel(s)).join(', ');
    out.push(`The evidence is in ${a.relatedSeqs.length === 1 ? 'receipt' : `${a.relatedSeqs.length} receipts`} ${shown}${a.relatedSeqs.length > 8 ? ' and more' : ''}. Each one is ${signedLevel ? 'signed and chained' : 'sealed in the hash chain'}, so you can open and verify it.`);
  } else {
    out.push('No single receipt is attached: the detector looked at the pattern across calls rather than one call.');
  }
  out.push(a.autoPaused
    ? `Auto-pause paused ${a.agentSlug} when the alert was raised. Its new calls are refused and recorded until a person resumes it.`
    : `Auto-pause did not act on this alert, so ${a.agentSlug} kept running. Its calls are still checked against the rulebook as usual.`);
  out.push(a.status === 'open'
    ? 'The alert is open. Acknowledging or resolving it is a person’s decision and is recorded.'
    : a.status === 'acknowledged'
      ? `${a.acknowledgedBy ? `${userName(a.acknowledgedBy)} acknowledged it` : 'It has been acknowledged'}; it is not yet resolved.`
      : `It was resolved${a.resolvedAt ? ` at ${dateTime(a.resolvedAt)}` : ''}.`);
  out.push(`An alert never changes a decision on its own. Decisions are made in code by the ${signedLevel ? 'signed' : 'published'} rulebook.`);
  return out;
}

/* ── Assessments ──────────────────────────────────────────── */

const TIER_WORDS: Record<RiskTier, string> = { minimal: 'Minimal risk', limited: 'Limited risk', high: 'High risk', unacceptable: 'Unacceptable', unassessed: 'Unassessed' };

interface AskAssessment { assessment: ExtAssessment; systemName?: string }

function explainAssessment({ assessment: a, systemName }: AskAssessment): string[] {
  const out: string[] = [];
  const tpl = variantOf(a);
  const sys = systemName ?? 'this AI system';
  const s = summarise(a);
  const provisional = a.status === 'draft' || a.status === 'changes_requested';
  const tier = provisional ? s.tier : a.resultTier;
  const unanswered = a.questions.filter((q) => !isAnswered(q));

  // where it stands
  out.push(
    a.status === 'draft' ? `This ${tpl.label.toLowerCase()} for ${sys} is a draft, written by ${userName(a.authorId)}. ${s.answered} of ${plural(s.total, 'question')} are answered. The result below is provisional: nothing is set on the system until it is submitted and a different person approves it.`
    : a.status === 'changes_requested' ? `${userName(a.reviewerId)} asked for changes to this ${tpl.label.toLowerCase()} for ${sys}${a.reviewNote ? `: “${a.reviewNote}”` : ''}. ${userName(a.authorId)} can reopen it as a draft and answer again; the result below is provisional until then.`
    : a.status === 'submitted' ? `This ${tpl.label.toLowerCase()} for ${sys} was submitted${a.submittedAt ? ` on ${date(a.submittedAt)}` : ''} and waits for sign-off. An owner or admin who did not write it approves it or asks for changes, with a note.`
    : `${userName(a.reviewerId)} approved this ${tpl.label.toLowerCase()} for ${sys}${a.reviewedAt ? ` on ${date(a.reviewedAt)}` : ''}, after ${userName(a.authorId)} wrote it. Approval is recorded as a receipt.`,
  );

  if (tpl.kind === 'admission') {
    const adm = admissionOf(a);
    const notMet = a.questions.filter((q) => isAnswered(q) && q.answer !== 'Met');
    out.push(`It decides whether the ${tpl.packId ?? 'regulatory'} pack may be admitted for ${sys}'s agent. ${adm.met} of ${adm.total} admission checks are met; every one must be met.`);
    if (notMet.length) out.push(`Not met: ${notMet.map((q) => `${q.section} (${q.answer})`).join('; ')}. While any check is not met, the pack cannot be admitted — the only way forward is to fix what the check found and answer again.`);
    if (unanswered.length) out.push(`Not yet answered: ${unanswered.map((q) => q.section).join('; ')}.`);
    if (adm.admitted) out.push(a.status === 'approved' ? `The pack was admitted${a.dryRun ? ' as a dry run: its checks run and report, with no regulatory claim until the organisation reaches L2' : ''}. Admission does not change the system's risk tier.` : `Every check is met, so approving admits the pack for the agent. Admission does not change the system's risk tier.`);
    out.push('The result is counted in code from the answers. Ask Govern only explains it.');
    return out;
  }

  out.push(`It scores ${s.score} of ${a.maxScore}, which ${provisional ? 'would put' : 'puts'} ${sys} at ${TIER_WORDS[tier]}. The bands are: ${bands(a.maxScore).map((b) => `${TIER_WORDS[b.tier]} ${b.from}–${b.to}`).join(', ')}.`);
  const prohibited = a.questions.filter((q) => isAnswered(q) && prohibitedAnswer(q, a.template));
  if (prohibited.length) out.push(`${prohibited.length === 1 ? 'One answer describes' : `${prohibited.length} answers describe`} a prohibited practice — ${prohibited.map((q) => `“${q.text}”: ${q.answer}`).join('; ')} — so the result is Unacceptable whatever the total.`);
  const drivers = a.questions.filter((q) => isAnswered(q) && q.points > 0).sort((p, q) => q.points - p.points).slice(0, 4);
  out.push(drivers.length
    ? `What raised the score most: ${drivers.map((q) => `“${q.text}” — ${q.answer} (+${q.points})`).join('; ')}. Changing the system so that one of these answers changes is what moves it to a lower band.`
    : 'No answer has added points yet.');
  if (unanswered.length) out.push(`${plural(unanswered.length, 'question')} ${unanswered.length === 1 ? 'is' : 'are'} not answered. An unanswered question adds 0, so the result can still rise when ${unanswered.length === 1 ? 'it is' : 'they are'} answered.`);
  out.push(a.status === 'approved'
    ? `The tier was set on the system when it was approved, with the next review in ${reviewMonths(a.resultTier)} months. Nobody can type a tier in; only an approved assessment sets it.`
    : `If approved, the tier is set on the system and the next review falls ${reviewMonths(tier)} months later.`);
  out.push('The score is worked out in code from the answers: the same answers always give the same result. No model is involved, and Ask Govern only explains it.');
  return out;
}

/* ── Incidents ────────────────────────────────────────────── */

type AskIncidentRecord = Incident & { subkind?: string; checksDone?: string[]; resolutionNote?: string; declared?: boolean };
interface AskIncident {
  incident: AskIncidentRecord;
  /** calls refused while it was on (rule agent-paused) */
  refused?: number;
  /** the kind as the page shows it, e.g. "Health · Receipt write failure" */
  kindLabel?: string;
  /** a health incident's checks, with whether each was done */
  checks?: { label: string; done: boolean }[];
  relatedAlerts?: { id: string; title: string; severity: string }[];
  isCurrentStop?: boolean;
  pendingNow?: number;
}

const who = (id?: string) => (!id || id === 'system' ? 'Elan1 Govern' : userName(id));

function span(fromIso: string, toIso?: string) {
  const mins = Math.max(0, Math.round(((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 60000));
  if (mins < 60) return plural(mins, 'minute');
  const h = Math.floor(mins / 60);
  if (h < 48) return `${plural(h, 'hour')}${mins % 60 ? ` ${plural(mins % 60, 'minute')}` : ''}`;
  return plural(Math.floor(h / 24), 'day');
}

function explainIncident(p: AskIncident): string[] {
  const i = p.incident;
  const out: string[] = [];
  const active = i.status === 'active';
  const kind = p.kindLabel ?? (i.kind === 'emergency_stop' ? 'Emergency stop' : i.kind === 'auto_pause' ? 'Auto-pause' : 'Health incident');
  out.push(`${kind}. ${who(i.startedBy)} started it at ${dateTime(i.startedAt)}. The reason given: ${i.reason}${/[.!?]$/.test(i.reason.trim()) ? '' : '.'}`);

  // what it does
  if (i.kind === 'emergency_stop') {
    const scope = i.scope === 'all_agents' ? 'every agent that was active' : `the agents it names (${i.agentSlugs.join(', ') || 'none'})`;
    out.push(`An emergency stop refuses every call from ${scope}${i.agentSlugs.length ? ` — ${plural(i.agentSlugs.length, 'agent')}` : ''}. Each refused call is still recorded, as a receipt with rule agent-paused; ${n(p.refused ?? i.refusedWhileStopped)} ${active ? 'so far' : 'in all'}.`);
    out.push(`${plural(i.pendingApprovalsAtStop, 'approval')} ${i.pendingApprovalsAtStop === 1 ? 'was' : 'were'} waiting when it was engaged. ${active ? 'Nobody can decide them while the stop is on; their expiry still runs, and an expiry is a refusal.' : 'Nobody could decide them while it was on; any still waiting became decidable when it was lifted.'}`);
  } else if (i.kind === 'auto_pause') {
    out.push(`Auto-pause paused ${i.agentSlugs.join(', ') || 'the agent'} because a high-severity alert fired while its auto-pause switch was on. Its calls are refused and recorded with rule agent-paused while it is paused${p.refused ? ` (${n(p.refused)} so far)` : ''}. Other agents are not affected.`);
  } else {
    out.push(`A health incident tracks a failure in the service itself${i.declared ? ', declared by hand' : ''}. It pauses no agent on its own${i.agentSlugs.length ? `; ${plural(i.agentSlugs.length, 'agent')} ${i.agentSlugs.length === 1 ? 'is' : 'are'} involved (${i.agentSlugs.join(', ')})` : ''}. When receipts cannot be written, the guard refuses the calls it cannot record, so nothing runs unrecorded.`);
  }

  // timeline
  if (i.timeline.length) {
    const recent = i.timeline.slice(-4);
    out.push(`The timeline has ${plural(i.timeline.length, 'entry', 'entries')}. ${i.timeline.length > recent.length ? 'The latest: ' : ''}${recent.map((t) => `${t.ts ? `${dateTime(t.ts)} — ` : ''}${t.text}${t.actor && t.actor !== 'system' ? ` (${userName(t.actor)})` : ''}${t.seq !== undefined ? `, receipt ${seqLabel(t.seq)}` : ''}`).join('; ')}.`);
  }
  if (p.relatedAlerts?.length) out.push(`Related alerts: ${p.relatedAlerts.slice(0, 4).map((a) => `${a.title} (${a.severity})`).join('; ')}${p.relatedAlerts.length > 4 ? ` and ${p.relatedAlerts.length - 4} more` : ''}.`);

  // state and next steps
  if (!active) {
    out.push(`It was resolved${i.resolvedAt ? ` at ${dateTime(i.resolvedAt)}` : ''} by ${who(i.resolvedBy)}, after ${span(i.startedAt, i.resolvedAt)}.${i.resolutionNote ? ` Their note: “${i.resolutionNote}”.` : ''}${i.kind === 'emergency_stop' ? ' Only the agents the stop paused were resumed; agents paused for other reasons stayed paused.' : ''}`);
    out.push('Nothing is left to do here. The incident report can be downloaded from this page, and the download is recorded.');
  } else {
    out.push(`It is still active, after ${span(i.startedAt)}.`);
    if (i.kind === 'emergency_stop') {
      out.push(p.isCurrentStop
        ? `Next: once the cause is dealt with, lift it with the guided resume on this page. Only the agents the stop paused are resumed. ${p.pendingNow ? `${plural(p.pendingNow, 'approval')} ${p.pendingNow === 1 ? 'is' : 'are'} waiting now and can be decided once it is lifted.` : ''}`.trim()
        : 'This stop is no longer the one in force, so it cannot be lifted from here.');
    } else if (i.kind === 'auto_pause') {
      out.push(`Next: read the alert, deal with its cause, then resume ${i.agentSlugs[0] ?? 'the agent'} from this page or its agent page. The resume is recorded, and the incident closes with it.`);
    } else if (p.checks?.length) {
      out.push(`Next: work through the checks for its kind, then resolve it with a note. ${p.checks.map((c) => `${c.done ? 'Done' : 'To do'}: ${c.label}`).join('; ')}.`);
    } else {
      out.push('Next: work through the checks for its kind on this page, then resolve it with a note. The checks and the note are recorded.');
    }
  }
  out.push('Ask Govern only explains the record. Lifting a stop, resuming an agent and resolving an incident are a person’s decisions, and each one is recorded.');
  return out;
}

/* ── Rules ────────────────────────────────────────────────── */

interface AskRule {
  rule: Rule;
  /** the builder's extra YAML keys for the rule (escalation, autonomy, pack) */
  extra?: Record<string, unknown>;
  agentSlug?: string;
  agentTools?: string[];
  /** decisions this rule made in the last 30 days */
  hits?: { count: number; last?: string };
  /** approvals it holds now */
  pending?: number;
  /** how the rule differs from the published version, when it does */
  diff?: string;
  publishedVersion?: number;
}

/**
 * How approvers can decide a call this rule holds, following the chat rule (mock/approvalNotify chatBlocker): never
 * in chat at Sovereign; buttons only on rules marked approvable in chat, and withheld per call for the tags chat never
 * approves, for a call that needs a password step-up, and for a call held because a quota is used up.
 */
function chatText(r: Rule, sovereign: boolean): string {
  if (sovereign) return 'They decide in the console or by a single-use email link sent through your own mail relay. Chat is not available at Sovereign: nothing goes to Slack or WhatsApp, so nothing is approved there.';
  if (!r.approveInChat) return 'They decide in the console or by a single-use email link. The rule is not marked approvable in chat, so a Slack or WhatsApp message carries only a link to open it in Elan1 Govern.';
  const ruleTag = r.match.tag && CHAT_NEVER.includes(r.match.tag) ? r.match.tag : undefined;
  if (ruleTag) return `The rule is marked approvable in chat, but every call it holds is tagged “${tagLabel[ruleTag] ?? ruleTag}”, which is never approved in chat. They decide in the console or by a single-use email link; a Slack or WhatsApp message carries only a link.`;
  return 'The rule is marked approvable in chat, so an approver with a linked Slack account or a verified WhatsApp number also gets Approve and Reject buttons on the message, which decide for that person only. Whether the buttons appear depends on the call: they are withheld when it deletes, changes access or production, touches personal data, needs a password step-up, or was held because a quota is used up. Then the message carries only a link to decide in Elan1 Govern. The email link always works.';
}

function explainRule(p: AskRule, sovereign = false): string[] {
  const r = p.rule;
  const out: string[] = [];
  const bx = builderExtra(p.extra);
  const reach = r.match.tag ? toolsForRule(r, p.agentTools) : [];
  out.push(r.match.tool
    ? `Rule "${r.id}" applies when ${p.agentSlug ?? 'the agent'} calls ${r.match.tool}.`
    : `Rule "${r.id}" applies to any tool tagged “${tagLabel[r.match.tag ?? ''] ?? r.match.tag}”${reach.length ? `. For ${p.agentSlug ?? 'this agent'} that is ${plural(reach.length, 'tool')}: ${reach.slice(0, 8).map((t) => t.name).join(', ')}${reach.length > 8 ? ' and more' : ''}` : ', but no tool of this agent carries that tag, so today it never applies'}.`);
  if (r.when?.length) out.push(`It applies only when ${r.when.map(conditionText).join(' and ')}. A missing argument never meets a condition, so if the field is absent the rule does not apply.`);
  out.push(
    r.decide === 'allow' ? 'When it applies, it allows the call.'
    : r.decide === 'refuse' ? `When it applies, it refuses the call, and the refusal names this rule and its reason. The call does not run.`
    : `When it applies, it holds the call for a person in the ${groupName(r.approver)} group. Nothing runs while it waits. If nobody decides within ${r.expiresIn ?? '24h'}, the call is refused. ${chatText(r, sovereign)}`,
  );
  if (r.unless?.length) out.push(`The ask stands aside when ${r.unless.map(conditionText).join(' and ')}.`);
  if (r.decide === 'ask' && bx.escalate_to) out.push(`If nobody decides, it escalates once to ${groupName(bx.escalate_to)} after ${bx.escalate_after?.endsWith('%') ? `${bx.escalate_after} of the window` : bx.escalate_after}. The escalation is recorded.`);
  if (r.quota) out.push(`Limit: ${quotaText(r.quota).replace(/^At most/, 'at most')}. Over the limit, the call is held for a person if the rule names an approver group, and refused if it does not.`);
  if (bx.requires_autonomy) out.push(`It also needs the agent to hold autonomy ${bx.requires_autonomy} or above for the tool.`);
  if (bx.pack) out.push(`It comes from the ${bx.pack} pack's rule set and is locked: remove the whole pack section to change it.`);
  if (r.mode === 'simulate') out.push('It is marked simulate only, so it does not decide calls yet.');
  out.push(`Reason on the rule: ${r.reason || 'none written yet.'}`);
  out.push('If another rule also applies to the same call, the strictest wins: refuse over ask over allow. If no rule applies, the default refuses.');
  if (p.diff) out.push(`This rule is ${p.diff === 'added' ? 'new in the draft' : `changed in the draft (${p.diff})`}${p.publishedVersion ? ` compared with published version ${p.publishedVersion}` : ''}. It does not decide anything until a version with it is published.`);
  if (p.hits) out.push(p.hits.count ? `In the last 30 days it decided ${plural(p.hits.count, 'call')}${p.hits.last ? `, most recently at ${dateTime(p.hits.last)}` : ''}.` : 'It has not decided any call in the last 30 days.');
  if (p.pending) out.push(`${plural(p.pending, 'call')} held by this rule ${p.pending === 1 ? 'is' : 'are'} waiting for a person now.`);
  return out;
}

// Shown at every level. L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
const GENERAL = [
  { q: 'What happens when an agent calls a tool?', a: 'Elan1 Govern checks the agent key, whether the agent is paused, the published rulebook, the tool and its arguments, then decides: allow, ask a person, or refuse. The strictest matching rule wins and anything not explicitly allowed is refused. Every decision becomes a receipt sealed in a hash chain; from L2 each receipt is also signed and timestamped.' },
  { q: 'What does "governed run" mean?', a: 'On the MCP route Elan1 Govern holds the tool credential and runs the call itself, so a refused call cannot run. On the REST and SDK routes ("check and record") it advises and records; the agent runs the call with its own credentials.' },
  { q: 'Can an auditor check the record offline?', a: 'An auditor pack can be checked offline with govern verify or on the /verify page. At L1 it shows the receipts are unchanged since Elan1 Govern sealed them in its hash chain; they are not yet externally timestamped. From L2 records are sealed, signed with a key in AWS KMS and timestamped by two authorities, and the verifier reports one of six codes against a named profile. From L3 the signing key is yours, in your HSM.' },
  { q: 'Does a model make the decisions?', a: 'No. The decision step is plain code with no model on the path. Ask Govern only explains records after the fact.' },
  { q: 'What does a refused action cost?', a: 'A refused action costs 40% of the per-action rate. Inside your yearly allowance a refusal uses 0.4 of an included action.' },
];

/** The level in force when this receipt was written. */
function receiptLevel(r: Receipt, orgId: string, current: LevelId): LevelId {
  const history = ORGS.find((o) => o.id === orgId)?.levelHistory;
  return levelOfReceipt(r, history, current);
}

export function AskPanel() {
  const { ask, closeAsk } = useUi();
  const orgId = useOrgId();
  const current = useOrgLevel();
  const [open, setOpen] = useState<number | null>(0);
  if (!ask) return null;
  // older callers sent an incident as 'general' with its record in the payload
  const legacyIncident = ask.kind === 'general' && !!ask.payload && typeof ask.payload === 'object' && 'incident' in (ask.payload as object);
  const kind = legacyIncident ? 'incident' : ask.kind;
  const paras = !ask.payload ? null
    : kind === 'receipt' ? (() => { const lv = receiptLevel(ask.payload as Receipt, orgId, current); return explainReceipt(ask.payload as Receipt, claimFor(lv), lv !== 'l1'); })()
    : kind === 'approval' ? explainApproval(ask.payload as Approval)
    : kind === 'alert' ? explainAlert(ask.payload as Alert, current !== 'l1')
    : kind === 'assessment' && (ask.payload as Partial<AskAssessment>).assessment ? explainAssessment(ask.payload as AskAssessment)
    : kind === 'incident' && (ask.payload as Partial<AskIncident>).incident ? explainIncident(ask.payload as AskIncident)
    : kind === 'rule' && (ask.payload as Partial<AskRule>).rule ? explainRule(ask.payload as AskRule, current === 'sovereign')
    : null;
  const rulePending = kind === 'rule' && !!(ask.payload as Partial<AskRule> | undefined)?.pending;
  const incidentAlerts = kind === 'incident' ? (ask.payload as Partial<AskIncident> | undefined)?.relatedAlerts ?? [] : [];
  return (
    <Drawer open onClose={closeAsk} kicker="Ask Govern" title={ask.title} width={520} actions={<Sparkles className="h-4 w-4 text-accent mr-2" aria-hidden />}>
      <Banner tone="neutral" className="mb-5">Explains records in plain words. It never makes, changes or recommends a decision.</Banner>
      {paras ? (
        <div className="space-y-4">
          {paras.map((p, i) => <p key={i} className="text-md leading-7">{p}</p>)}
          {ask.kind === 'receipt' && (
            <Link to="/verify" onClick={closeAsk} className="inline-flex items-center gap-1 text-sm font-medium link">Verify this receipt yourself <ArrowRight className="h-3.5 w-3.5" /></Link>
          )}
          {ask.kind === 'alert' && (ask.payload as Alert).relatedSeqs.length > 0 && (
            <Link to={`/activity/${(ask.payload as Alert).relatedSeqs[0]}`} onClick={closeAsk} className="inline-flex items-center gap-1 text-sm font-medium link">Open the first evidence receipt <ArrowRight className="h-3.5 w-3.5" /></Link>
          )}
          {incidentAlerts.length > 0 && (
            <Link to={`/alerts/${incidentAlerts[0].id}`} onClick={closeAsk} className="inline-flex items-center gap-1 text-sm font-medium link">Open the first related alert <ArrowRight className="h-3.5 w-3.5" /></Link>
          )}
          {rulePending && (
            <Link to="/approvals" onClick={closeAsk} className="inline-flex items-center gap-1 text-sm font-medium link">See the calls waiting for a person <ArrowRight className="h-3.5 w-3.5" /></Link>
          )}
        </div>
      ) : (
        <div className="divide-y divide-line border-y border-line">
          {GENERAL.map((g, i) => (
            <div key={i}>
              <button className="w-full text-left py-3.5 flex items-center justify-between gap-3 text-sm font-semibold" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                {g.q}
                <span className="text-muted">{open === i ? '−' : '+'}</span>
              </button>
              {open === i && <p className="pb-4 text-sm text-muted leading-relaxed">{g.a}</p>}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
