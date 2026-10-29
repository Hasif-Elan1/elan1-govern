import { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Hash as HashIcon, Inbox, Mail, MessageCircle } from 'lucide-react';
import { relative } from '@/lib/format';
import { Badge } from '@/components/ui';
import { outbox, subscribeRegistry, type OutboxMail } from './registry';

/**
 * The demo outbox: what Elan1 Govern would have sent by email, WhatsApp or Slack. Nothing leaves the
 * browser, so the messages — and their single-use links — are shown here instead.
 */
export function DemoOutbox({ to, orgId, emails, links, title = 'Demo outbox', limit = 6, empty }: {
  to?: string; orgId?: string; title?: string; limit?: number; empty?: string;
  /** Only messages to these addresses. */
  emails?: string[];
  /** Only messages carrying one of these links (for example the invitations just sent). */
  links?: string[];
}) {
  const sig = useSyncExternalStore(subscribeRegistry, () => outbox().length + ':' + (outbox()[0]?.id ?? ''));
  void sig;
  const to2 = emails?.map((e) => e.trim().toLowerCase());
  const mails = outbox({ to, orgId })
    .filter((m) => !to2 || to2.includes(m.to.trim().toLowerCase()))
    .filter((m) => !links || (!!m.link && links.includes(m.link)))
    .slice(0, limit);
  return (
    <section aria-labelledby="outbox-h" className="border border-dashed border-line-strong/70 bg-surface">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-line">
        <h3 id="outbox-h" className="text-sm font-semibold inline-flex items-center gap-2"><Inbox className="h-4 w-4 text-muted" aria-hidden />{title}</h3>
        <Badge tone="held">Not sent — shown here</Badge>
      </div>
      {mails.length ? (
        <ul className="divide-y divide-line" aria-live="polite">
          {mails.map((m) => <MailRow key={m.id} m={m} />)}
        </ul>
      ) : (
        <p className="px-4 py-4 text-sm text-muted">{empty ?? 'Nothing yet.'}</p>
      )}
    </section>
  );
}

function MailRow({ m }: { m: OutboxMail }) {
  const Icon = m.channel === 'whatsapp' ? MessageCircle : m.channel === 'slack' ? HashIcon : Mail;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="font-mono text-fg break-all">{m.to}</span>
        <span>· {relative(m.at)}</span>
      </div>
      <p className="mt-1 text-sm font-semibold">{m.subject}</p>
      <p className="mt-0.5 text-sm text-muted leading-relaxed">{m.body}</p>
      {m.link && <Link to={m.link} className="mt-1.5 inline-block link text-sm break-all">{location.origin}{m.link}</Link>}
    </li>
  );
}
