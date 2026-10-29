import { Link } from 'react-router-dom';
import { ArrowRight, ServerCrash } from 'lucide-react';
import { db } from '@/api';
import { dateTime } from '@/lib/format';
import { OUTAGE_SENTENCE, outageState } from '@/mock/approvalsExt';

/**
 * Where an approvals outage is shown for this organisation. Elan1's public /status lists the hosted
 * organisations; a Sovereign deployment is never published there, so its outage shows on its own
 * Deployment › Local status page instead.
 */
export function outageStatusLink(orgId: string): { to: string; label: string; place: string } {
  const sovereign = db.getDB(orgId).org.deployment === 'sovereign';
  return sovereign
    ? { to: '/agents/deployment?tab=status', label: 'See local status', place: 'Deployment › Local status' }
    : { to: '/status', label: 'See the status page', place: 'the status page' };
}

/**
 * The single-use link page while the approvals service is down: no Approve or Reject, nothing expires, and
 * the link stays unused. The same fail-closed sentence as every console decide screen.
 */
export function LinkApprovalsUnavailable({ orgId, headline, member }: { orgId: string; headline: string; /** signed in as a member: Local status is inside the console */ member: boolean }) {
  const o = outageState(orgId);
  const waiting = db.getDB(orgId).approvals.filter((a) => a.status === 'pending').length;
  const status = outageStatusLink(orgId);
  const showStatus = status.to === '/status' || member;
  return (
    <section aria-labelledby="link-down" className="border border-line border-l-[6px] border-l-bad bg-surface p-5" role="status">
      <span className="inline-flex h-10 w-10 items-center justify-center bg-bad-bg text-bad-fg"><ServerCrash className="h-5 w-5" aria-hidden /></span>
      <p className="mt-4 label text-bad-fg">Approvals unavailable</p>
      <h1 id="link-down" className="mt-1 text-xl font-semibold leading-snug">{OUTAGE_SENTENCE}</h1>
      <p className="mt-2 text-sm text-muted leading-relaxed">“{headline}” keeps waiting. Nothing has been approved, and nothing expires while the service is down. This link stays unused: open it again when the service is back.</p>
      <ul className="mt-3 space-y-1 text-sm text-muted">
        {o.since && <li>Down since {dateTime(o.since)}.</li>}
        <li>{waiting} {waiting === 1 ? 'call is' : 'calls are'} waiting, unchanged.</li>
        <li>Approve and reject, re-route, extend, single-use links and reversals are all closed until it is back.</li>
      </ul>
      {showStatus ? (
        <Link to={status.to} className="mt-4 inline-flex items-center gap-1 h-10 px-4 text-sm font-medium border border-line-strong/70 hover:border-fg">{status.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
      ) : (
        <p className="mt-3 text-sm text-muted">It shows on {status.place} inside your network once you sign in.</p>
      )}
    </section>
  );
}
