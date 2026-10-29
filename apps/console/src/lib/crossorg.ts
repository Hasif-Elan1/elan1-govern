/**
 * Cross-organisation receipts (L3): replay detection, issued and received states.
 *
 * Replay. Every receipt issued to a counterparty carries a fresh nonce. A receiver keeps the first copy of each
 * nonce from an issuer; a later copy with the same nonce is refused with the code RECEIPT_REPLAYED, even when its
 * signature verifies (a valid signature only proves the issuer signed it once).
 */
import type { CrossOrgReceipt, VerifyStep } from '@/types';

export const REPLAY_CODE = 'RECEIPT_REPLAYED';

/** In customer copy: the code without any internal prefix. */
export const REPLAY_TEXT = 'Already received: a copy with the same nonce arrived earlier.';

const arrived = (x: CrossOrgReceipt) => (x.receivedAt ? new Date(x.receivedAt).getTime() : 0);

/** The earlier copy this received receipt replays (same issuer and nonce, arrived first), if any. */
export function replayOf(all: CrossOrgReceipt[], x: CrossOrgReceipt): CrossOrgReceipt | undefined {
  if (x.direction !== 'received' || !x.nonce) return undefined;
  const same = all.filter((y) => y.direction === 'received' && y.issuerOrgId === x.issuerOrgId && y.nonce === x.nonce);
  if (same.length < 2) return undefined;
  // first copy: earliest arrival, then the one listed last (new arrivals are put at the top)
  const first = same.reduce((a, b) => (arrived(b) < arrived(a) || (arrived(b) === arrived(a) && all.indexOf(b) > all.indexOf(a)) ? b : a));
  return first.id === x.id ? undefined : first;
}

/** The nonce check as a verification step. */
export function replayStep(all: CrossOrgReceipt[], x: CrossOrgReceipt): VerifyStep {
  const first = replayOf(all, x);
  if (first) return { label: 'Replay', state: 'fail', code: REPLAY_CODE, detail: `Refused: ${REPLAY_CODE}. Nonce ${x.nonce} was first received${first.receivedAt ? ` on ${new Date(first.receivedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })} IST` : ' earlier'}${first.boundSeq ? ` and recorded as receipt #${first.boundSeq}` : ''}. The signature still verifies; this copy is not counted again.` };
  return { label: 'Replay', state: 'pass', detail: `Nonce ${x.nonce || '—'} seen for the first time from ${x.issuerName}.` };
}

export const isReplayed = (x: Pick<CrossOrgReceipt, 'verification'>) => x.verification.steps.some((s) => s.code === REPLAY_CODE && s.state === 'fail');

/** The state of an issued or received receipt beyond its check: revoked, disputed, accepted. */
export type CrossOrgStanding = 'revoked' | 'disputed' | 'dispute_upheld' | 'dispute_rejected' | 'accepted' | 'accept_pending' | 'accept_refused' | 'replayed' | 'none';

export function standingOf(x: CrossOrgReceipt): CrossOrgStanding {
  if (x.revoked || x.issuerRevoked) return 'revoked';
  if (x.dispute?.status === 'open') return 'disputed';
  if (x.direction === 'received' && isReplayed(x)) return 'replayed';
  if (x.dispute?.status === 'upheld') return 'dispute_upheld';
  if (x.acceptance?.state === 'accepted') return 'accepted';
  if (x.acceptance?.state === 'refused') return 'accept_refused';
  if (x.acceptance?.state === 'pending') return 'accept_pending';
  if (x.dispute?.status === 'rejected') return 'dispute_rejected';
  return 'none';
}
