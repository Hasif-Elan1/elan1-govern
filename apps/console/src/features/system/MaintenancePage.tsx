import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, BadgeCheck, RefreshCw } from 'lucide-react';
import { api } from '@/api';
import type { StatusView } from '@/types';
import { timeShort } from '@/lib/format';
import { Banner, Button, Disc, toast } from '@/components/ui';
import { safeNext } from '@/features/auth/safeNext';
import { StatusFrame } from './StatusFrame';
import { activeMaintenance, canRunMaintenanceDemo, endMaintenance, nextMaintenance, subscribeMaintenance, type MaintenanceWindow } from '@/mock/opsMaintenance';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { userName } from '@/mock/users';

/** The console's maintenance record, read from the public status (console component and its planned windows). */
function maintenanceOf(v: StatusView) {
  const consoleC = v.components.find((c) => c.id === 'console');
  const windows = (consoleC?.days ?? []).filter((d) => d.status === 'maintenance');
  const last = windows[windows.length - 1];
  const affected = v.components.filter((c) => c.status === 'maintenance').map((c) => c.name);
  return { inMaintenance: consoleC?.status === 'maintenance', status: consoleC?.status ?? 'operational', last, affected };
}

/** Planned maintenance: the console is down, the guard is not. "Check again" re-reads the status and returns to the console when it is back. */
export default function MaintenancePage() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const back = safeNext(sp.get('next')) ?? '/';
  const [record, setRecord] = useState<ReturnType<typeof maintenanceOf>>();
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string>();
  const [error, setError] = useState<string>();

  const check = async (auto = false) => {
    setChecking(true);
    setError(undefined);
    try {
      const v = await api.status();
      const m = maintenanceOf(v);
      setRecord(m);
      setCheckedAt(v.updatedAt);
      if (!m.inMaintenance && !auto) {
        toast.ok('The console is back', 'Returning you to where you were.');
        window.setTimeout(() => nav(back, { replace: true }), 600);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => { document.title = 'Maintenance · Elan1 Govern'; void check(true); }, []);
  // the planned window itself: when it ends, re-read the status
  const [win, setWin] = useState<MaintenanceWindow | undefined>(() => activeMaintenance() ?? nextMaintenance());
  useEffect(() => {
    const read = () => { setWin(activeMaintenance() ?? nextMaintenance()); void check(true); };
    const off = subscribeMaintenance(read);
    const t = window.setInterval(() => { if (!activeMaintenance()) read(); }, 15_000);
    return () => { off(); window.clearInterval(t); };
  }, []);
  const open = !!win && !win.endedAt && new Date(win.from).getTime() <= Date.now() && new Date(win.to).getTime() > Date.now();
  // ending a demonstration window early: a signed-in owner only, recorded on their organisation's chain
  const user = useUser();
  const orgId = useOrgId();
  const canEnd = canRunMaintenanceDemo({ userId: user?.id, orgId });
  // the wording follows the signed-in organisation's level: L1 publishes and seals, L2 and above sign; Sovereign
  // approvers have no chat buttons. Signed out, the page speaks neutrally.
  const level = useOrgLevel();
  const signedLevel = !!user && atLeast(level, 'l2');
  const sovereign = !!user && level === 'sovereign';
  const endNow = () => {
    try {
      const w = endMaintenance({ userId: user?.id, orgId });
      toast.ok('Maintenance window ended', `The console is available again.${w?.endedBy?.seq !== undefined ? ` Recorded as receipt #${w.endedBy.seq}.` : ''}`);
      void check();
    } catch (e) {
      toast.bad('The window was not ended', (e as Error).message);
    }
  };

  const up = record && !record.inMaintenance;

  return (
    <StatusFrame
      mark={<Disc kind="orbit" size={64} title="Maintenance" />}
      kicker={up ? 'Maintenance finished' : 'Planned maintenance'}
      title={up ? 'The console is available again' : 'The console is being updated'}
      lead={<p>Agents keep being governed and approvals are queued. The decision service and the receipt chain run separately from this console, so every call is still checked against its {signedLevel ? 'signed' : 'published'} rulebook and recorded.</p>}
      works={[
        'Agents keep being governed — allow, ask a person and refuse decisions continue.',
        'Every decision is still written as a hash-chained receipt — sealed in the chain at L1, signed from L2 — and from L2 batches are still sealed and timestamped.',
        'Held actions are queued for approval, with their expiry clocks and escalations running as normal.',
        sovereign
          ? 'Approvers still decide from single-use approval links sent through your own mail relay and opened over your network: they go to the approvals service, not the console. Slack and WhatsApp are not used under deny-all egress.'
          : 'Approvers still decide from email approval links, and from Slack and WhatsApp buttons where their chat account is linked: they go to the approvals service, not the console.',
        'The status page, the verifier, the legal pages and printed key fingerprints stay open. Auditors can verify exported bundles offline with govern verify.',
      ]}
      waits={[
        'Opening the console and its approvals inbox.',
        'Publishing rulebooks, issuing keys and changing settings.',
      ]}
      actions={
        <>
          {up
            ? <Button variant="primary" iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => nav(back, { replace: true })}>Continue to the console</Button>
            : <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} loading={checking} onClick={() => void check()}>Check again</Button>}
          <Button variant="secondary" icon={<BadgeCheck className="h-4 w-4" />} onClick={() => nav('/verify')}>Verify a bundle</Button>
          <Link to="/status" className="inline-flex h-10 items-center px-2 text-sm link">Service status</Link>
        </>
      }
    >
      {error && <Banner tone="bad" className="mt-6 max-w-[560px]" title="Status could not be read">{error}</Banner>}
      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-px bg-line border border-line max-w-[620px]">
        <div className="bg-surface px-4 py-3"><dt className="label">Console now</dt><dd className="mt-1 font-medium" aria-live="polite">{record ? (record.inMaintenance ? 'In maintenance' : 'Operational') : 'Checking…'}</dd></div>
        <div className="bg-surface px-4 py-3"><dt className="label">Last planned window</dt><dd className="mt-1 font-medium num">{record?.last ? `${record.last.date}${record.last.note ? ` · ${record.last.note.replace(/^Planned maintenance /, '')}` : ''}` : record ? 'None in 90 days' : '—'}</dd></div>
        <div className="bg-surface px-4 py-3 col-span-2 sm:col-span-1"><dt className="label">Last checked</dt><dd className="mt-1 font-medium num">{checkedAt ? `${timeShort(checkedAt)} IST` : 'Not yet'}</dd></div>
      </dl>
      {win && (
        <div className="mt-4 max-w-[620px] border border-line bg-surface px-4 py-3 text-sm">
          <p className="label">{open ? 'This window' : 'Next planned window'}</p>
          <p className="mt-1 font-medium">{win.title}: {timeShort(win.from)}–{timeShort(win.to)} IST{open ? '' : `, ${new Date(win.from).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}`}</p>
          <p className="mt-1 text-muted">{win.note}{win.startedEarly && win.plannedFrom ? ` Started early for a demonstration; it was planned for ${timeShort(win.plannedFrom)} IST.` : ''}</p>
          {open && win.startedEarly && (
            <div className="mt-3">
              {canEnd ? (
                <Button size="sm" variant="secondary" onClick={endNow}>End the demonstration window now</Button>
              ) : (
                <p className="text-xs text-muted">Started early for a demonstration{win.startedBy ? ` by ${userName(win.startedBy.userId)}` : ''}. Only an owner can end it early; otherwise it closes at {timeShort(win.to)} IST.</p>
              )}
            </div>
          )}
        </div>
      )}
    </StatusFrame>
  );
}
