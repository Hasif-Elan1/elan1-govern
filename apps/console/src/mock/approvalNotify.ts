/**
 * Telling approvers about a held call (Technology Memorandum, flow F2).
 *
 * When a call is held, every approver the saved routing reaches is sent a signed, single-use link by email —
 * email always goes out. Where the organisation's channels allow it, a Slack or WhatsApp message goes too. A rule
 * marked approvable in chat puts Approve and Reject buttons on that message: they decide for the person it was
 * sent to (their confirmed Slack email, or the WhatsApp number they verified with a code), with no password, so
 * they are never offered where a password step-up applies or for the tags F2 rules out. Any other chat message
 * carries an "Open in Elan1 Govern" link. At Sovereign nothing goes to Slack or WhatsApp (deny-all egress): email
 * goes through the organisation's own mail relay.
 *
 * Nothing leaves the browser: the messages land in the demo outbox (features/auth/registry). Each round of
 * notifications is one approval.notified receipt; a link sent by hand is one approval.link_sent receipt.
 */
import type { Approval, ApprovalLinkToken, Channel } from '@/types';
import { append, getDB, touch } from './db';
import { issueApprovalLink } from './platform';
import { recipientsOf } from './orgSettings';
import { stepUpReason } from './approvalsExt';
import { sovState } from './sovereign';
import { userById } from './users';
// the demo outbox is loaded when a message is sent (not at import): db.ts loads this module only when a call is held
import type { OutboxMail } from '@/features/auth/registry';
const sendMail = (m: Omit<OutboxMail, 'id' | 'at'>) => import('@/features/auth/registry').then((x) => x.pushMail(m));

/** Tags F2 never lets anyone approve from a chat message. */
export const CHAT_NEVER = ['deletes', 'changes_access', 'changes_production', 'personal_data'];

/** The outside hosts a chat message would need; at Sovereign they are refused as egress. */
export const CHAT_HOSTS: Record<'slack' | 'whatsapp', string> = { slack: 'hooks.slack.com', whatsapp: 'graph.facebook.com' };

const isSov = (orgId: string) => getDB(orgId).org.deployment === 'sovereign';

/** Why this held call cannot be approved from a chat message, or undefined when chat buttons are allowed. */
export function chatBlocker(orgId: string, a: Pick<Approval, 'approveInChat' | 'riskTags' | 'tool' | 'args' | 'amount'>): string | undefined {
  if (isSov(orgId)) return 'Nothing is approved in chat under deny-all egress. Open it in Elan1 Govern.';
  if (!a.approveInChat) return 'The rule that held this call is not marked approvable in chat. Open it in Elan1 Govern.';
  const tag = a.riskTags.find((t) => CHAT_NEVER.includes(t));
  if (tag) return `Calls tagged ${tag.replace(/_/g, ' ')} are never approved in chat. Open it in Elan1 Govern.`;
  const step = stepUpReason(orgId, { tool: a.tool, args: a.args, riskTags: a.riskTags, amount: a.amount });
  if (step) return `Approving this asks for your password again (${step.replace(/\.$/, '')}), so it is decided in Elan1 Govern, not in chat.`;
  return undefined;
}

/**
 * Whether this person has the chat account a button press is bound to: the saved routing for approval.pending
 * reaches them on that channel (a linked Slack account, a verified WhatsApp number) for the group now holding the
 * approval, or for the group the rule first named (its members may still decide). decideInChat
 * (features/approvals/chat.ts) accepts a press only from such a person, so messages carry buttons only for them.
 */
export function chatBound(orgId: string, a: Pick<Approval, 'approverGroup' | 'originalGroup'>, userId: string, ch: 'slack' | 'whatsapp'): boolean {
  const d = getDB(orgId);
  const groups = [a.approverGroup, ...(a.originalGroup && a.originalGroup !== a.approverGroup ? [a.originalGroup] : [])];
  return groups.some((g) => !!recipientsOf(d, 'approval.pending', g).find((r) => r.userId === userId)?.[ch]);
}

/** Approve and Reject on a chat message to this person: the call allows chat, and their press would be accepted. */
export function chatButtonsFor(orgId: string, a: Approval, userId: string, ch: 'slack' | 'whatsapp'): boolean {
  return !chatBlocker(orgId, a) && chatBound(orgId, a, userId, ch);
}

/** The internal mail relay a Sovereign deployment sends approval emails through. */
function relayOf(orgId: string): string | undefined {
  if (!isSov(orgId)) return undefined;
  try { return sovState(orgId).internalHosts.find((h) => /mail relay/i.test(h.purpose))?.host; } catch { return undefined; }
}

const istTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

function emailText(orgId: string, a: Approval) {
  const relay = relayOf(orgId);
  return {
    subject: `Held for your decision: ${a.headline}`,
    body: `${a.ruleReason} It expires at ${istTime(a.expiresAt)} IST; an expiry is a refusal. The link works once, only for you, and asks you to sign in.${relay ? ` Sent through your organisation’s mail relay (${relay}).` : ''}`,
  };
}

function chatText(a: Approval, ch: 'slack' | 'whatsapp', buttons: boolean) {
  const who = ch === 'slack' ? 'your confirmed Slack email' : 'the WhatsApp number you verified';
  return {
    subject: `Held for your decision: ${a.headline}`,
    body: buttons
      ? `${a.ruleReason} Approve or Reject here: the buttons decide for you only (${who}) and do not ask for a password. Or open it in Elan1 Govern.`
      : `${a.ruleReason} Open it in Elan1 Govern to decide.`,
  };
}

function chatAddress(userId: string, ch: 'slack' | 'whatsapp') {
  const u = userById(userId);
  if (ch === 'slack') return u?.email ?? userId;
  return u?.phone ?? 'Verified WhatsApp number';
}

/** notifiedSeq: the first round's receipt. routeNotified: the escalation or re-route receipts already notified (optional, saved state before it reads as none). */
type Held = Approval & { notifiedSeq?: number; routeNotified?: number[] };

/**
 * One round of notifications: each person in `reach` gets a single-use email link (always) and, where the routing
 * reaches them on Slack or WhatsApp and the deployment allows it, a chat message. A chat message carries Approve and
 * Reject only where chatButtonsFor says the press would be accepted; otherwise it carries "Open in Elan1 Govern".
 */
function sendRound(orgId: string, a: Approval, reach: ReturnType<typeof recipientsOf>, prefix = '') {
  const sov = isSov(orgId);
  const sent = { email: 0, slack: 0, whatsapp: 0, people: 0, buttons: 0 };
  const channelsTo: { userId: string; channels: Channel[] }[] = [];
  for (const r of reach) {
    const u = userById(r.userId);
    if (!u) continue;
    let t: ApprovalLinkToken;
    try { t = issueApprovalLink(orgId, a.id, r.userId, 'email'); } catch { continue; } // held by a stop, expired, or not allowed to decide
    const e = emailText(orgId, a);
    void sendMail({ channel: 'email', to: u.email, subject: `${prefix}${e.subject}`, body: e.body, link: `/approve/${t.token}`, orgId });
    sent.email++;
    sent.people++;
    const got: Channel[] = ['email'];
    if (!sov) { // deny-all egress: recipientsOf already leaves chat out; never send it here either
      for (const ch of ['slack', 'whatsapp'] as const) {
        if (!r[ch]) continue;
        let c: ApprovalLinkToken;
        try { c = issueApprovalLink(orgId, a.id, r.userId, ch); } catch { continue; }
        const buttons = chatButtonsFor(orgId, a, r.userId, ch);
        const m = chatText(a, ch, buttons);
        void sendMail({ channel: ch, to: chatAddress(r.userId, ch), subject: `${prefix}${m.subject}`, body: m.body, link: `/approve/${c.token}`, orgId, chat: { approvalId: a.id, token: c.token, buttons } });
        sent[ch]++;
        if (buttons) sent.buttons++;
        got.push(ch);
      }
    }
    channelsTo.push({ userId: r.userId, channels: got });
  }
  return { sent, channelsTo };
}

/**
 * A call was just held: send each approver the routing reaches an email link (always) and, where allowed, a chat
 * message; then write one approval.notified receipt. Runs once per approval. Called deferred (setTimeout) by
 * db.governCall so nothing is written while a screen renders.
 */
export function notifyHeldApproval(orgId: string, approvalId: string) {
  const d = getDB(orgId);
  const a = d.approvals.find((x) => x.id === approvalId) as Held | undefined;
  if (!a || a.status !== 'pending' || a.notifiedSeq !== undefined) return;
  const { sent } = sendRound(orgId, a, recipientsOf(d, 'approval.pending', a.approverGroup));
  const relay = relayOf(orgId);
  const rec = append(d, {
    kind: 'admin', actor: 'system', action: 'approval.notified', agent: a.agentSlug,
    details: { approval: a.id, people: sent.people, email: sent.email, slack: sent.slack, whatsapp: sent.whatsapp, links: sent.email + sent.slack + sent.whatsapp, chat_buttons: sent.buttons > 0, ...(relay ? { relay } : {}) },
  });
  a.notifiedSeq = rec.seq;
  touch(orgId, 'approval');
}

/**
 * An approval moved to another group — escalated by its group's policy (`escalated`, routing for
 * approval.escalated) or re-routed by an owner or admin (`rerouted`, routing for approval.pending). The new group
 * is told the same way as the first hold: single-use links in the outbox, email always, chat where allowed, never
 * chat at Sovereign; then one approval.notified receipt with the reason and the move's receipt. Runs once per move.
 * Called deferred (setTimeout) by the escalation tick and by db.reroute so nothing is written while a screen renders.
 */
export function notifyRoutedApproval(orgId: string, approvalId: string, reason: 'escalated' | 'rerouted', moveSeq: number) {
  const d = getDB(orgId);
  const a = d.approvals.find((x) => x.id === approvalId) as Held | undefined;
  if (!a || a.status !== 'pending' || a.heldByStop) return;
  if ((a.routeNotified ?? []).includes(moveSeq)) return;
  const move = (a.escalations ?? []).find((e) => e.seq === moveSeq);
  if (move && move.to !== a.approverGroup) return; // moved again since; the later move notifies
  const reach = recipientsOf(d, reason === 'escalated' ? 'approval.escalated' : 'approval.pending', a.approverGroup);
  const { sent, channelsTo } = sendRound(orgId, a, reach, reason === 'escalated' ? 'Escalated to you · ' : 'Re-routed to you · ');
  const relay = relayOf(orgId);
  const rec = append(d, {
    kind: 'admin', actor: 'system', action: 'approval.notified', agent: a.agentSlug,
    details: { approval: a.id, reason, group: a.approverGroup, ...(move ? { from: move.from } : {}), move_seq: moveSeq, people: sent.people, email: sent.email, slack: sent.slack, whatsapp: sent.whatsapp, links: sent.email + sent.slack + sent.whatsapp, chat_buttons: sent.buttons > 0, ...(relay ? { relay } : {}) },
  });
  a.routeNotified = [...(a.routeNotified ?? []), moveSeq];
  a.notified = Array.from(new Set([...(a.notified ?? []), ...channelsTo.flatMap((x) => x.channels)])) as Channel[];
  const known = a.notifiedTo ?? [];
  a.notifiedTo = [...known, ...channelsTo.filter((x) => !known.some((y) => y.userId === x.userId))];
  touch(orgId, 'approval');
  return rec.seq;
}

/**
 * A person sends a single-use link by hand from the approval page. At Sovereign, Slack and WhatsApp are refused as
 * egress (mock/platform issueApprovalLink records egress.blocked). The link goes to the demo outbox (email, Slack,
 * WhatsApp; a phone link is copied from the page) and the sending is one approval.link_sent receipt.
 */
export function sendApprovalLink(orgId: string, approvalId: string, issuedTo: string, channel: Channel, byUserId: string): ApprovalLinkToken & { seq: number } {
  const t = issueApprovalLink(orgId, approvalId, issuedTo, channel, byUserId);
  const d = getDB(orgId);
  const a = d.approvals.find((x) => x.id === approvalId)!;
  const u = userById(issuedTo);
  let buttons = false;
  if (u && channel === 'email') {
    const e = emailText(orgId, a);
    void sendMail({ channel: 'email', to: u.email, subject: e.subject, body: e.body, link: `/approve/${t.token}`, orgId });
  } else if (u && (channel === 'slack' || channel === 'whatsapp')) {
    // buttons only for someone whose press decideInChat would accept (the routing reaches them on this channel);
    // anyone else, such as an owner outside the group, gets "Open in Elan1 Govern"
    buttons = chatButtonsFor(orgId, a, issuedTo, channel);
    const m = chatText(a, channel, buttons);
    void sendMail({ channel, to: chatAddress(issuedTo, channel), subject: m.subject, body: m.body, link: `/approve/${t.token}`, orgId, chat: { approvalId: a.id, token: t.token, buttons } });
  }
  const relay = channel === 'email' ? relayOf(orgId) : undefined;
  const rec = append(d, { kind: 'admin', actor: byUserId, action: 'approval.link_sent', agent: a.agentSlug, details: { approval: a.id, to: issuedTo, channel, link: t.token.slice(-8), single_use: true, chat_buttons: buttons, ...(relay ? { relay } : {}) } });
  touch(orgId, 'approval');
  return { ...t, seq: rec.seq };
}
