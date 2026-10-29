import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Check, Hash as HashIcon, Inbox, Mail, MessageCircle, X } from 'lucide-react';
import type { Approval, ApprovalLinkToken } from '@/types';
import { relative, seqLabel } from '@/lib/format';
import { Badge, Button, Input, toast } from '@/components/ui';
import { outbox, subscribeRegistry, type OutboxMail } from '@/features/auth/registry';
import { userName } from '@/mock/users';
import { useCan } from '@/store/session';
import { decideInChat } from './chat';

/**
 * What was sent about this held call — the demo outbox, filtered to its links. Nothing leaves the browser, so the
 * email and chat messages are shown here. A Slack or WhatsApp message from a rule marked approvable in chat carries
 * Approve and Reject buttons that decide for the person it was sent to (flow F2).
 */
export function ApprovalOutbox({ a, links, onDecided }: { a: Approval; links: ApprovalLinkToken[]; onDecided?: () => void }) {
  const sig = useSyncExternalStore(subscribeRegistry, () => outbox().length + ':' + (outbox()[0]?.id ?? ''));
  void sig;
  const tokens = new Set(links.map((l) => l.token));
  const mails = outbox().filter((m) => m.chat?.approvalId === a.id || (!!m.link && tokens.has(m.link.replace(/^\/approve\//, '')))).slice(0, 8);
  if (!mails.length) return null;
  return (
    <div className="mt-3 border border-dashed border-line-strong/70 bg-surface">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line">
        <p className="text-xs font-semibold inline-flex items-center gap-1.5"><Inbox className="h-3.5 w-3.5 text-muted" aria-hidden />Demo outbox for this approval</p>
        <Badge tone="held">Not sent — shown here</Badge>
      </div>
      <ul className="divide-y divide-line">
        {mails.map((m) => <Row key={m.id} m={m} a={a} link={links.find((l) => m.chat?.token === l.token)} onDecided={onDecided} />)}
      </ul>
    </div>
  );
}

function Row({ m, a, link, onDecided }: { m: OutboxMail; a: Approval; link?: ApprovalLinkToken; onDecided?: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject'>();
  const Icon = m.channel === 'whatsapp' ? MessageCircle : m.channel === 'slack' ? HashIcon : Mail;
  const where = m.channel === 'whatsapp' ? 'WhatsApp' : m.channel === 'slack' ? 'Slack' : 'email';
  // the demo chat buttons decide an approval: shown only to roles that decide approvals
  const canDecide = useCan('approvals.decide');
  const live = a.status === 'pending' && !link?.usedAt;
  const decide = async (approve: boolean) => {
    if (!m.chat) return;
    setBusy(approve ? 'approve' : 'reject');
    try {
      const r = await decideInChat(m.chat.token, approve, approve ? `Approved in ${where}` : reason.trim());
      toast.ok(r.partial ? 'First approval recorded in chat' : approve ? `Approved in ${where}` : `Rejected in ${where}`, `Decided for ${userName(link?.issuedTo)} via ${m.channel}. Receipt ${seqLabel(r.receipt.seq)}.`);
      setRejecting(false);
      onDecided?.();
    } catch (e) {
      toast.bad('Not decided', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <li className="px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="font-mono text-fg break-all">{m.to}</span>
        <span>· {relative(m.at)}</span>
      </div>
      <p className="mt-1 text-sm font-medium">{m.subject}</p>
      <p className="mt-0.5 text-muted leading-relaxed">{m.body}</p>
      {/* the single-use link is live only for roles that decide approvals (as in the links list above); others read that one was sent, without the token */}
      {m.link && (canDecide
        ? <Link to={m.link} className="mt-1 inline-block link break-all">{m.chat ? 'Open in Elan1 Govern' : `${location.origin}${m.link}`}</Link>
        : <p className="mt-1 text-subtle">Carries a single-use approval link for the person it was sent to.</p>)}
      {m.chat?.buttons && canDecide && (
        live ? (
          rejecting ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input aria-label="Why you reject it" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you reject it" className="h-8 flex-1 min-w-[160px]" data-autofocus />
              <Button size="sm" variant="ghost" onClick={() => { setRejecting(false); setReason(''); }}>Cancel</Button>
              <Button size="sm" variant="danger" loading={busy === 'reject'} disabled={reason.trim().length < 4} onClick={() => decide(false)}>Reject</Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<Check className="h-3.5 w-3.5" aria-hidden />} loading={busy === 'approve'} onClick={() => decide(true)}>Approve</Button>
              <Button size="sm" variant="secondary" icon={<X className="h-3.5 w-3.5" aria-hidden />} onClick={() => setRejecting(true)}>Reject</Button>
              <span className="text-subtle">Buttons in {where} · decide for {userName(link?.issuedTo)} · no password</span>
            </div>
          )
        ) : <p className="mt-1.5 text-subtle">{link?.usedAt ? `Used ${relative(link.usedAt)} by ${userName(link.usedBy)}.` : 'The approval is no longer waiting; the buttons do nothing.'}</p>
      )}
    </li>
  );
}
