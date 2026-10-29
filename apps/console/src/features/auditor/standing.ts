/**
 * Per-client standing for the auditor workspace — level, chain, anchors, custody, profiles, controls and
 * coverage — read through src/api for any organisation the auditor holds. Coverage uses the same live
 * recount as the Coverage screen (liveControls, coverageOf), so the figures agree.
 */
import { api } from '@/api';
import type { CrossOrgReceipt, IndustryPack, KeyCustody, LevelState, ProfileRunResult, Receipt } from '@/types';
import { receiptHash, sha256Hex, verifySig } from '@/lib/crypto';
import { levelRank } from '@/lib/levels';
import { date } from '@/lib/format';
import { coverageOf, indexControls, liveControls } from '@/features/compliance/evidence';
import { orgAccess, useSession } from '@/store/session';

export const INDUSTRY_LABEL: Record<IndustryPack, string> = {
  finance: 'Financial services', healthcare: 'Healthcare', hr: 'Human resources', support: 'Customer support', sales: 'Sales', engineering: 'Engineering', general: 'General (multi-sector)',
};

export interface ClientStanding {
  orgId: string;
  level: LevelState;
  receipts: number;
  head?: Receipt;
  first?: Receipt;
  lastCpAt?: string;
  sinceCheckpoint: number;
  refusals: number;
  controls: { evidenced: number; total: number };
  coverage: { share: number; frameworks: number };
  agents: number;
  pending: number;
  custody: KeyCustody;
  anchors?: { batches: number; unanchored: number; withinTargetPct: number; authorities: string[] };
  profiles?: { available: number; viaPack: number; lastRun?: ProfileRunResult & { name: string } };
  crossOrg?: { issued: number; received: number };
}

export async function loadStanding(orgId: string): Promise<ClientStanding> {
  // suspension is per organisation: nothing of a client is read for someone suspended or removed there
  const me = useSession.getState().user;
  const acc = me ? orgAccess(orgId, me.id) : 'active';
  if (acc !== 'active') throw new Error(acc === 'suspended' ? 'Your access to this organisation is suspended.' : 'You are no longer a member of this organisation.');
  const [ev, level, comp, approvals, agents, custody, refused] = await Promise.all([
    api.evidence(orgId), api.level(orgId), api.compliance(orgId), api.approvals(orgId), api.agents(orgId), api.custody(orgId), api.receipts(orgId, { decision: 'refuse', limit: 1 }),
  ]);
  const live = liveControls(orgId, comp.controls);
  const byId = indexControls(live);
  const enabled = comp.frameworks.filter((f) => f.enabled);
  const share = enabled.length ? enabled.reduce((s, f) => s + coverageOf(f, byId).share, 0) / enabled.length : 0;
  const lastCp = ev.checkpoints[0];
  const head = ev.head as Receipt | undefined;
  const l2 = levelRank(level.level) >= 1;
  const l3 = levelRank(level.level) >= 2;
  const [anchors, profiles, cross] = await Promise.all([
    l2 ? api.anchors(orgId, 1) : Promise.resolve(undefined),
    l2 ? api.profiles(orgId) : Promise.resolve(undefined),
    l3 ? api.crossOrgReceipts(orgId) : Promise.resolve(undefined),
  ]);
  const runs = (profiles ?? []).filter((p) => p.lastRun).map((p) => ({ ...p.lastRun!, name: p.name })).sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  return {
    orgId, level, receipts: ev.total, head, first: ev.first as Receipt | undefined, lastCpAt: lastCp?.ts,
    sinceCheckpoint: head ? (lastCp ? head.seq - lastCp.seq : ev.total) : 0,
    refusals: refused.total,
    controls: { evidenced: live.filter((c) => c.status === 'evidenced').length, total: live.length },
    coverage: { share, frameworks: enabled.length },
    agents: agents.length, pending: approvals.filter((a) => a.status === 'pending').length, custody,
    anchors: anchors ? { batches: anchors.totals.batches, unanchored: anchors.totals.unanchoredTail, withinTargetPct: anchors.totals.withinTargetPct, authorities: anchors.authorities.map((a) => a.name) } : undefined,
    profiles: profiles ? { available: profiles.filter((p) => p.enabled).length, viaPack: profiles.filter((p) => p.viaPack).length, lastRun: runs[0] } : undefined,
    crossOrg: cross ? { issued: cross.filter((x) => x.direction === 'issued').length, received: cross.filter((x) => x.direction === 'received').length } : undefined,
  };
}

/**
 * Check a receipt received from a counterparty in this browser, without writing to the client's chain:
 * audience, expiry, the issuer's published key (checked against the fingerprint the client pinned, if any), content hash,
 * and the signature against that published key.
 */
export function checkCrossOrg(x: CrossOrgReceipt, ctx: { domain?: string; pinnedFingerprint?: string; now?: number }) {
  const steps: { label: string; state: 'pass' | 'fail' | 'skip'; detail: string }[] = [];
  const now = ctx.now ?? Date.now();
  const aud = ctx.domain ? `ar-org:${ctx.domain}` : undefined;
  steps.push({ label: 'Audience', state: !aud ? 'skip' : x.audience === aud ? 'pass' : 'fail', detail: `Addressed to ${x.audience || '—'}${aud ? `; the client is ${aud}` : ''}.` });
  const expired = !!x.expiresAt && new Date(x.expiresAt).getTime() < now;
  steps.push({ label: 'Expiry', state: !x.expiresAt ? 'skip' : expired ? 'fail' : 'pass', detail: expired ? 'Expired.' : x.expiresAt ? `Valid until ${date(x.expiresAt)}.` : 'No expiry recorded.' });
  // The issuer's published key set (/.well-known/action-receipt-keys at its domain) — never the key the receipt carries,
  // which a forger controls. The same rule as Assurance › Counterparties.
  let published: string | undefined;
  try { published = api.chainSlice(x.issuerOrgId, x.seq, x.seq).publicKeys[x.kid]; } catch { published = undefined; }
  const fp = published ? sha256Hex(published).slice(0, 16) : '';
  const carriedDiffers = !!published && !!x.publicKey && x.publicKey !== published;
  const pinned = ctx.pinnedFingerprint;
  const keyState: 'pass' | 'fail' = !published ? 'fail' : pinned && pinned !== fp ? 'fail' : 'pass';
  steps.push({
    label: 'Issuer key', state: keyState,
    detail: !published
      ? `${x.issuerName} publishes no key ${x.kid}, so the receipt cannot be checked against the issuer.`
      : `Key ${x.kid} from ${x.issuerName}’s published key set, fingerprint ${fp}${pinned ? (pinned === fp ? ', matches the one the client pinned' : `, does not match the one the client pinned (${pinned})`) : '; the client has not pinned a fingerprint'}.${carriedDiffers ? ' The key carried inside the receipt is a different key and was ignored.' : ''}`,
  });
  const hashOk = !!x.receipt && receiptHash(x.receipt) === x.receiptHash;
  steps.push({ label: 'Content hash', state: x.receipt ? (hashOk ? 'pass' : 'fail') : 'skip', detail: !x.receipt ? 'The full receipt is not held, so its hash cannot be recomputed.' : hashOk ? 'The receipt recomputes to the hash it carries.' : 'The receipt does not match its hash.' });
  const sigOk = !!published && verifySig(x.receiptHash, x.sig, published);
  steps.push({ label: 'Signature', state: sigOk ? 'pass' : 'fail', detail: sigOk ? 'Ed25519 signature verifies against the issuer’s published key.' : published ? 'The signature does not verify against the issuer’s published key.' : 'No published issuer key to check the signature against.' });
  const state: 'verified' | 'failed' = steps.some((s) => s.state === 'fail') ? 'failed' : 'verified';
  return { state, steps };
}
