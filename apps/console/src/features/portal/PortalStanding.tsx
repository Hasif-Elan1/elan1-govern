import { useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { api } from '@/api';
import { dateTime } from '@/lib/format';
import { Banner, Button, Dialog, Field, Textarea } from '@/components/ui';

export type Standing = Awaited<ReturnType<typeof api.standingByToken>>;

type Dispute = NonNullable<NonNullable<Standing>['dispute']>;

function disputeTitle(d: Dispute, issuer: string) {
  if (d.status === 'open') return `Disputed — waiting for ${issuer}`;
  if (d.closedBy === 'revocation') return `Dispute closed: ${issuer} revoked the receipt`;
  if (d.closedBy === 'receiver') return d.status === 'upheld' ? 'Dispute closed by the counterparty' : 'Dispute withdrawn by the counterparty';
  return d.status === 'upheld' ? 'Dispute upheld by the issuer' : 'Dispute rejected by the issuer';
}

/**
 * On the portal page of an issued receipt: whether the issuer revoked it, and any dispute about it. A person signed in
 * to the counterparty portal for this record can raise a dispute, which is recorded on the issuer's chain. Shown also
 * when the link no longer opens the record (a revoked receipt withdraws its link), so the visitor learns why.
 */
export function PortalStanding({ token, issuer, signedInAs, onStanding }: { token: string; issuer: string; signedInAs?: string; onStanding?: (s: Standing) => void }) {
  const [s, setS] = useState<Standing>();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<number>();
  const load = () => api.standingByToken(token).then((v) => { setS(v); onStanding?.(v); }).catch(() => setS(undefined));
  useEffect(() => { load(); }, [token]);
  if (!s?.issued) return null;

  const send = async () => {
    if (!signedInAs) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.disputeByToken(token, { name: signedInAs, reason });
      setDone(r.seq);
      setOpen(false);
      setReason('');
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="mb-6 space-y-3">
      {s.revoked && (
        <Banner tone="bad" title={`${issuer} revoked this receipt`}>
          {s.revoked.reason} · {dateTime(s.revoked.at)}. The signature still verifies, but the issuer no longer stands behind it.
        </Banner>
      )}
      {s.dispute && (
        <Banner tone={s.dispute.status === 'open' ? 'held' : 'neutral'} title={disputeTitle(s.dispute, issuer)}>
          “{s.dispute.reason}” — {s.dispute.raisedBy}, {dateTime(s.dispute.raisedAt)}.{s.dispute.resolution ? ` ${s.dispute.closedBy === 'receiver' ? '' : `${issuer}: `}${s.dispute.resolution}` : ''}{s.dispute.resolvedAt ? ` (${dateTime(s.dispute.resolvedAt)})` : ''}
        </Banner>
      )}
      {done !== undefined && <Banner tone="ok" title="Dispute sent">Recorded on {issuer}’s chain as receipt #{done}. They resolve it, and the outcome shows here.</Banner>}
      {!s.revoked && s.dispute?.status !== 'open' && (
        <div className="flex flex-wrap items-center gap-3 border border-line bg-surface px-4 py-3 text-sm">
          <Scale className="h-4 w-4 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 text-muted">Does this record not match what you know?{signedInAs ? '' : ` Sign in to the counterparty portal to dispute it, or contact ${issuer}.`}</span>
          {signedInAs && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Dispute this record</Button>}
        </div>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Dispute this record" description={`${issuer} sees what you write, with your name (${signedInAs ?? ''}).`}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={send}>Send the dispute</Button></>}>
        <div className="space-y-3">
          <Field label="What you dispute" htmlFor="portal-dispute" required><Textarea id="portal-dispute" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus /></Field>
          {error && <Banner tone="bad">{error}</Banner>}
        </div>
      </Dialog>
    </div>
  );
}
