import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileCheck2, LogOut } from 'lucide-react';
import { api } from '@/api';
import type { DisclosurePackage } from '@/types';
import { dateTime, seqLabel } from '@/lib/format';
import { Banner, Button, toast } from '@/components/ui';
import { PORTAL_INFO, PORTAL_SESSION_HOURS, currentPortalSession, endPortalSession, subscribeRegistry, type PortalAccount, type PortalSession } from './registry';

/** This browser's live portal session (counterparty verifier, regulator or partner); re-renders when it changes. */
export function usePortalSession(): { session: PortalSession; account: PortalAccount } | undefined {
  const id = useSyncExternalStore(subscribeRegistry, () => currentPortalSession()?.session.id ?? '');
  return id ? currentPortalSession() : undefined;
}

/** The records an issuer has shared with a portal account and that are still live. */
export async function portalRecords(p: PortalAccount): Promise<DisclosurePackage[]> {
  const list = (await api.disclosures(p.issuerOrgId)) as DisclosurePackage[];
  return list.filter((x) => x.counterpartyId === p.counterpartyId && x.status === 'active').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The signed-in strip on a portal page. When the portal session belongs to the person this record was shared
 * with, it names them, lists their other live records and offers sign-out; otherwise the record is shown as a
 * plain link (no sign-in), and the page says so.
 */
export function PortalSessionBanner({ issuerOrgId, counterpartyId, token }: { issuerOrgId?: string; counterpartyId?: string; token: string }) {
  const nav = useNavigate();
  const portal = usePortalSession();
  const [records, setRecords] = useState<DisclosurePackage[]>();
  const matches = !!portal && !!issuerOrgId && portal.account.issuerOrgId === issuerOrgId && portal.account.counterpartyId === counterpartyId;

  useEffect(() => {
    if (!portal || !matches) { setRecords(undefined); return; }
    let live = true;
    portalRecords(portal.account).then((r) => { if (live) setRecords(r); }).catch(() => undefined);
    return () => { live = false; };
  }, [portal?.session.id, matches]);

  if (!portal) return null;
  const { account, session } = portal;
  const info = PORTAL_INFO[account.kind];
  const signOut = () => {
    endPortalSession();
    toast.ok('Signed out of the portal', 'Recorded on the issuer’s chain.');
    nav('/login', { replace: true });
  };

  if (!matches) {
    return (
      <Banner tone="neutral" className="mb-6" title={`Signed in as ${account.name}, but not for this record`} actions={<Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" aria-hidden />} onClick={signOut}>Sign out</Button>}>
        This record was shared with someone else, so it is shown as a plain link: no sign-in applies to it.
      </Banner>
    );
  }
  const others = (records ?? []).filter((r) => r.token !== token);
  return (
    <Banner tone="info" className="mb-6" title={`${info.label} portal · ${account.name}, ${account.employer}`}
      actions={<Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" aria-hidden />} onClick={signOut}>Sign out</Button>}>
      <p>
        {info.summary} Only what was shared with you is shown.{account.kind === 'regulator' ? ' This portal is read-only: nothing you do here changes the issuer’s records.' : ''}
      </p>
      <p className="mt-1 text-xs">Signed in {dateTime(session.startedAt)}{session.seq !== undefined ? ` · sign-in recorded as receipt ${seqLabel(session.seq)} on the issuer’s chain` : ''} · ends after {PORTAL_SESSION_HOURS} hours.</p>
      {others.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium">Other records shared with you</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {others.map((r) => (
              <li key={r.id}><Link to={`/counterparty/${r.token}`} className="inline-flex items-center gap-1 text-sm link"><FileCheck2 className="h-3.5 w-3.5" aria-hidden />Receipt {seqLabel(r.seq)} · {r.revealed.length} of {r.committed.length} fields</Link></li>
            ))}
          </ul>
        </div>
      )}
    </Banner>
  );
}
