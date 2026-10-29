import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Globe, Printer } from 'lucide-react';
import { api } from '@/api';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { dateTime, relative } from '@/lib/format';
import { userName } from '@/mock/users';
import { keysApi, type PublishChannel } from '@/mock/keys';
import { useCanDo } from '@/features/settings/permissions';
import { Badge, Banner, Button, CopyButton, Dialog, Field, Input, Panel, Select, Skeleton, StatusChip, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { errMsg, useKeysState } from './useKeys';

const CHANNEL: Record<PublishChannel, string> = { dns: 'DNS TXT record', print: 'Printed page', website: 'Website', letter: 'Engagement letter' };

/**
 * The fingerprint published out of band, so a verifier can check a bundle against a key it did not get from the
 * bundle: a DNS TXT record (copy the name and value) and a printable page; each publication is recorded.
 */
export function FingerprintPublishPanel() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const canCustody = useCanDo('keys.custody');
  const { data: s } = useKeysState();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<PublishChannel>('dns');
  const [where, setWhere] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const org = api.org(orgId);
  const printUrl = `/fingerprint/${org.slug}`;
  if (!s) return <Skeleton className="h-48" />;
  const verb = atLeast(level, 'l2') ? 'signs' : 'seals';
  const current = s.active && !s.active.interim ? s.active : undefined;
  const latest = (c: PublishChannel) => s.publications.find((p) => p.channel === c);

  const start = (c: PublishChannel) => { setChannel(c); setWhere(c === 'dns' ? (s.dns?.name ?? '') : c === 'print' ? 'Printed and filed with the auditor of record' : ''); setErr(undefined); setOpen(true); };
  const save = async () => {
    if (!user) return;
    setBusy(true);
    try { await keysApi.recordPublication(orgId, user.id, channel, where); toast.ok('Publication recorded', `${CHANNEL[channel]} for ${current?.kid}. Recorded on the chain.`); setOpen(false); }
    catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <Panel title="Publish the fingerprint" kicker="Out of band, so verifiers do not trust the bundle’s own key"
      actions={<Link to={printUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium link"><Printer className="h-4 w-4" aria-hidden />Printable page<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
      {!current ? (
        <Banner tone="bad" title="Signing is off">The compromised key is revoked and no new key signs yet. Publish the replacement’s fingerprint once signing is on.</Banner>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="label mb-1.5">DNS TXT record</p>
            <div className="border border-line divide-y divide-line text-sm">
              <div className="grid gap-1 px-3 py-2 sm:grid-cols-[72px_1fr_auto] sm:items-center"><span className="text-muted">Name</span><span className="font-mono text-[12.5px] break-all">{s.dns?.name}</span><CopyButton text={s.dns?.name ?? ''} compact label="Copy record name" /></div>
              <div className="grid gap-1 px-3 py-2 sm:grid-cols-[72px_1fr_auto] sm:items-center"><span className="text-muted">Type</span><span className="font-mono text-[12.5px]">TXT</span><span /></div>
              <div className="grid gap-1 px-3 py-2 sm:grid-cols-[72px_1fr_auto] sm:items-center"><span className="text-muted">Value</span><span className="font-mono text-[12.5px] break-all">"{s.dns?.value}"</span><CopyButton text={s.dns?.value ?? ''} compact label="Copy record value" /></div>
            </div>
            <p className="mt-1.5 text-xs text-muted">Add it at your DNS provider. A verifier compares <span className="font-mono">fp</span> with the fingerprint the verifier prints for the bundle; the key that {verb} the bundle must match.</p>
          </div>
          <div>
            <p className="label mb-1.5">Where it is published</p>
            <ul className="border border-line divide-y divide-line text-sm">
              {(['dns', 'print', 'website', 'letter'] as PublishChannel[]).map((c) => {
                const p = latest(c);
                const fresh = p && p.kid === current.kid;
                return (
                  <li key={c} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                    {c === 'dns' ? <Globe className="h-4 w-4 text-muted" aria-hidden /> : <Printer className="h-4 w-4 text-muted" aria-hidden />}
                    <span className="font-medium">{CHANNEL[c]}</span>
                    {!p ? <Badge>Not recorded</Badge> : fresh ? <StatusChip tone="ok" size="sm">Current key</StatusChip> : <StatusChip tone="held" size="sm">Out of date · {p.kid}</StatusChip>}
                    {p && <span className="text-xs text-muted">{relative(p.at)} by {userName(p.by)}{p.where ? ` · ${p.where}` : ''}</span>}
                    {p?.seq !== undefined && <ReceiptLink seq={p.seq} />}
                    <span className="ml-auto">{canCustody && <Button size="sm" variant={fresh ? 'ghost' : 'secondary'} onClick={() => start(c)}>{fresh ? 'Record again' : 'Record as published'}</Button>}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={`Record the ${CHANNEL[channel].toLowerCase()}`} description={current ? `Fingerprint ${current.fingerprint} of ${current.kid}, published ${dateTime(new Date().toISOString())}.` : undefined}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!where.trim()} onClick={save}>Record</Button></>}>
        <div className="space-y-3">
          <Field label="Channel" htmlFor="fp-ch"><Select id="fp-ch" value={channel} onChange={(e) => setChannel(e.target.value as PublishChannel)}>{(Object.keys(CHANNEL) as PublishChannel[]).map((c) => <option key={c} value={c}>{CHANNEL[c]}</option>)}</Select></Field>
          <Field label="Where" htmlFor="fp-where" required hint="The record name, the page address, or who holds the printed copy."><Input id="fp-where" value={where} onChange={(e) => setWhere(e.target.value)} /></Field>
          {err && <Banner tone="bad">{err}</Banner>}
        </div>
      </Dialog>
    </Panel>
  );
}
