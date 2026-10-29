import { useSyncExternalStore } from 'react';
import { db } from '@/api';
import { SmartLink } from '@/shell/access';
import { useOrgId } from '@/store/session';
import { dateTime, seqLabel } from '@/lib/format';
import { Banner } from '@/components/ui';
import { unsignedIntervalOf, unsignedIntervals, type UnsignedInterval } from '@/mock/keys';

/** Re-render when this organisation's keys or chain change (reads are synchronous and never write). */
function useKeysVersion(orgId: string) {
  return useSyncExternalStore(
    (cb) => db.subscribe((o, kind) => { if (o === orgId && (kind === 'key' || kind === 'receipt' || kind === 'open')) cb(); }),
    () => `${unsignedIntervals(orgId).map((u) => `${u.fromSeq}-${u.toSeq ?? ''}-${u.open}`).join(',')}`,
  );
}

const range = (u: UnsignedInterval) => `${seqLabel(u.fromSeq)}–${u.toSeq !== undefined ? seqLabel(u.toSeq) : 'now'}`;

/** On the chain explorer: every unsigned interval (a declared key compromise), open or closed. */
export function UnsignedIntervalsBanner({ className = 'mb-6' }: { className?: string }) {
  const orgId = useOrgId();
  useKeysVersion(orgId);
  const list = unsignedIntervals(orgId);
  if (!list.length) return null;
  const open = list.find((u) => u.open);
  return (
    <Banner tone={open ? 'bad' : 'held'} className={className}
      title={open ? `Signing is off · receipts from ${seqLabel(open.fromSeq)} are hash-chained but not signed` : `${list.length === 1 ? 'One unsigned interval' : `${list.length} unsigned intervals`} in this chain`}
      actions={<SmartLink to="/agents/keys?tab=custody" hideWhenBlocked className="text-sm font-medium link whitespace-nowrap">Key compromise</SmartLink>}>
      <ul className="space-y-1">
        {list.map((u) => (
          <li key={u.compromiseId}>
            <span className="font-mono">{range(u)}</span>: key <span className="font-mono">{u.kid}</span> declared compromised {dateTime(u.declaredAt)}.
            {' '}{u.open ? 'Records are still written and linked into the hash chain by Elan1 Govern’s interim chain key; they are not signed with your key until a new key is bound and signing is turned on.' : `Sealed by the interim chain key ${u.interimKid}, not signed with your key.${u.closedAt ? ` Closed ${dateTime(u.closedAt)}.` : ''}`}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/** On a receipt: says so when the receipt falls in an unsigned interval. */
export function UnsignedReceiptNote({ seq, kid, className = 'mb-4' }: { seq: number; kid: string; className?: string }) {
  const orgId = useOrgId();
  useKeysVersion(orgId);
  const u = unsignedIntervalOf(orgId, { seq, kid });
  if (!u) return null;
  return (
    <Banner tone="held" className={className} title="Written during an unsigned interval"
      actions={<SmartLink to="/agents/keys?tab=custody" hideWhenBlocked className="text-sm font-medium link whitespace-nowrap">Key compromise</SmartLink>}>
      This receipt is in {range(u)}, after key <span className="font-mono">{u.kid}</span> was declared compromised ({dateTime(u.declaredAt)}). It is linked into the hash chain and sealed by Elan1 Govern’s interim chain key <span className="font-mono">{u.interimKid}</span>, so a change to it still shows, but it is not signed with your organisation’s key.
    </Banner>
  );
}
