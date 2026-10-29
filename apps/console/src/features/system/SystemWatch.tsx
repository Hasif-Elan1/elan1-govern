import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOrgId, useUser } from '@/store/session';
import { activeMaintenance, subscribeMaintenance } from '@/mock/opsMaintenance';
import { ensureOps, noteApprovalLinkOpened, noteApprovalOpened } from '@/mock/ops';
import { isSovereign } from '@/mock/sovereign';

const sovereignOrg = (orgId: string) => { try { return isSovereign(orgId); } catch { return false; } };

/** Pages that stay reachable while offline or in maintenance: the system pages and the public ones. */
const OUTSIDE = ['/offline', '/maintenance', '/status', '/verify', '/developers', '/login', '/signup', '/forgot', '/reset', '/invite', '/approve', '/counterparty', '/legal', '/fingerprint'];
const outside = (path: string) => OUTSIDE.some((p) => path === p || path.startsWith(p + '/'));

/**
 * Watches the browser and the platform for the console:
 * - the browser goes offline → /offline (it comes back to the page it left when the connection returns);
 * - a planned maintenance window opens → /maintenance (with the page to return to);
 * - an approval's full record is opened (its console page, or its approval-link page) → noted, for the approver
 *   telemetry ("decided without opening the record");
 * - the open organisation's operations state (stop lifts, emergency access, CERT-In clocks) is ready.
 * Renders nothing.
 */
export function SystemWatch() {
  const nav = useNavigate();
  const loc = useLocation();
  const orgId = useOrgId();
  const user = useUser();
  const here = useRef(loc.pathname + loc.search);
  here.current = loc.pathname + loc.search;

  // offline: listen to the browser, and check once on load
  useEffect(() => {
    const goOffline = () => {
      if (outside(window.location.pathname)) return;
      nav(`/offline?next=${encodeURIComponent(here.current)}`);
    };
    window.addEventListener('offline', goOffline);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) goOffline();
    return () => window.removeEventListener('offline', goOffline);
  }, [nav]);

  // maintenance: the console closes while a planned window is open. Elan1's hosted windows never close a Sovereign
  // deployment's console: it runs on the bank's own cluster (mock/tenantNotices.ts sends it no maintenance either).
  const sovereign = !!user && sovereignOrg(orgId);
  useEffect(() => {
    if (sovereign) return;
    const check = () => {
      if (outside(window.location.pathname)) return;
      if (activeMaintenance()) nav(`/maintenance?next=${encodeURIComponent(here.current)}`, { replace: true });
    };
    check();
    const off = subscribeMaintenance(check);
    const t = window.setInterval(check, 15_000);
    return () => { off(); window.clearInterval(t); };
  }, [nav, sovereign]);
  useEffect(() => {
    if (!sovereign && !outside(loc.pathname) && activeMaintenance()) nav(`/maintenance?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
  }, [loc.pathname, loc.search, nav, sovereign]);

  // an approval's full record opened in the console
  useEffect(() => {
    const m = /^\/approvals\/([^/?#]+)$/.exec(loc.pathname);
    if (!m || !user) return;
    const t = window.setTimeout(() => { try { noteApprovalOpened(orgId, decodeURIComponent(m[1]), user.id); } catch { /* never breaks the page */ } }, 0);
    return () => window.clearTimeout(t);
  }, [loc.pathname, orgId, user]);
  // an approval link opened: that page shows the full record, for the person the link was sent to (signed in or not)
  useEffect(() => {
    const m = /^\/approve\/([^/?#]+)$/.exec(loc.pathname);
    if (!m) return;
    const t = window.setTimeout(() => { try { noteApprovalLinkOpened(decodeURIComponent(m[1])); } catch { /* never breaks the page */ } }, 0);
    return () => window.clearTimeout(t);
  }, [loc.pathname]);

  // the organisation's operations state and seeded history
  useEffect(() => {
    if (!user) return;
    const t = window.setTimeout(() => { try { ensureOps(orgId); } catch { /* fine */ } }, 0);
    return () => window.clearTimeout(t);
  }, [orgId, user]);

  return null;
}
