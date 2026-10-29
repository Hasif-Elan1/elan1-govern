import { api, db } from '@/api';
import { chatBlocker, chatBound } from '@/mock/approvalNotify';
import { userName } from '@/mock/users';
import { decideByLink, type DecideResult } from '@/features/work/backend';

/**
 * Approve in chat (flow F2), as a demo: the Approve and Reject buttons on a Slack or WhatsApp message in the outbox.
 * They decide for the person the message was sent to — bound to their confirmed Slack email or the WhatsApp number
 * they verified — with no password, which is why they exist only on rules marked approvable in chat and never where
 * a password step-up applies. The decision runs the same single-use path as a link (one decision per approval,
 * group membership, the stop, expiry, two people above the limit), and its receipt records the channel: slack or
 * whatsapp. Nothing is approved in chat at Sovereign.
 */
export async function decideInChat(token: string, approve: boolean, reason: string): Promise<DecideResult> {
  const link = await api.resolveApprovalLink(token);
  if (link.channel !== 'slack' && link.channel !== 'whatsapp') throw new Error('This message did not come from Slack or WhatsApp.');
  const d = db.getDB(link.orgId);
  const a = d.approvals.find((x) => x.id === link.approvalId);
  if (!a || a.status !== 'pending') throw new Error('This approval is no longer waiting.');
  const no = chatBlocker(link.orgId, a);
  if (no) throw new Error(no);
  // the clicking identity must still belong to the member the message was sent to — the same rule that decided
  // whether the message carried buttons at all (mock/approvalNotify chatBound)
  if (!chatBound(link.orgId, a, link.issuedTo, link.channel)) throw new Error(`${userName(link.issuedTo)} no longer has a ${link.channel === 'slack' ? 'linked Slack account' : 'verified WhatsApp number'} here, so the button does nothing. Open it in Elan1 Govern.`);
  return decideByLink(token, approve, reason, link.issuedTo);
}
