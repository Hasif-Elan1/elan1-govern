import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { safeNext } from '@/features/auth/safeNext';
import { ArrowRight, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Banner, Button, Disc } from '@/components/ui';
import { StatusFrame } from './StatusFrame';

/** The browser lost its connection. The guard runs on our side, so agents are unaffected. */
export default function OfflinePage() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  // the console sends people here when the browser goes offline, with the page they were on
  const back = safeNext(sp.get('next')) ?? '/';
  // Opens in the offline state and changes only when the browser reports the connection back, or a manual check finds it.
  const [online, setOnline] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    document.title = 'Offline · Elan1 Govern';
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // back online: return to the page that was open, after a moment to read the change
  useEffect(() => {
    if (!online || !sp.get('next')) return;
    const t = window.setTimeout(() => nav(back, { replace: true }), 2500);
    return () => window.clearTimeout(t);
  }, [online, back, nav, sp]);

  const retry = () => {
    setChecking(true);
    window.setTimeout(() => { setChecking(false); setOnline(navigator.onLine); }, 700);
  };

  return (
    <StatusFrame
      mark={<Disc kind="eclipse" size={64} title="Offline" />}
      kicker={online ? 'Connection restored' : 'No connection'}
      title={online ? 'You are back online' : 'You are offline'}
      lead={online
        ? <p>The console can reach Elan1 Govern again. Pick up where you left off — approvals and records load as normal.</p>
        : <p>You are offline. Approvals you open will load when you reconnect. Your agents are not affected: decisions are made and recorded on our side, not in this browser.</p>}
      works={[
        'Agents keep being governed and every decision is recorded.',
        'Held actions wait in the queue, with their expiry clocks running.',
        'Auditor packs you already exported verify offline with govern verify.',
        'Pages already open in this browser stay readable.',
      ]}
      waits={[
        'Opening approvals, receipts and anything not yet loaded.',
        'Approving, rejecting and every other change — nothing is sent while offline.',
        'Live updates on Today and Activity.',
      ]}
      actions={<>
        {online
          ? <Button variant="primary" iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => nav(back, { replace: true })}>{sp.get('next') ? 'Back to where you were' : 'Continue to the console'}</Button>
          : <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} loading={checking} onClick={retry}>Try again</Button>}
        <Button variant="secondary" onClick={() => nav('/status')}>Service status</Button>
      </>}
    >
      <div className="mt-6 max-w-[560px]" aria-live="polite">
        {online
          ? <Banner tone="ok" title="Connected"><span className="inline-flex items-center gap-1.5"><Wifi className="h-3.5 w-3.5" aria-hidden />This browser reports a working connection.{sp.get('next') ? ' Taking you back to the page you were on.' : ''}</span></Banner>
          : <Banner tone="neutral" title="Waiting for a connection"><span className="inline-flex items-center gap-1.5"><WifiOff className="h-3.5 w-3.5" aria-hidden />This page updates by itself when the connection returns.</span></Banner>}
      </div>
    </StatusFrame>
  );
}
