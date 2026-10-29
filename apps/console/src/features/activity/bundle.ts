/**
 * Assemble an evidence bundle from the organisation's records in this browser — receipts, Seal v6 records,
 * checkpoints, Merkle batches with their timestamp tokens, keys and declarations — and run the six-code
 * verifier (lib/verify6) over it. Every piece comes through src/api; nothing is written to the chain.
 *
 * The working copy carries no signed manifest (only an exported bundle has one), so section 1 reports the
 * assembly instead of member digests. Every other section is checked exactly as for an exported bundle.
 */
import { api } from '@/api';
import type { DisclosurePackage, LevelId, Receipt, SealRecord } from '@/types';
import type { BundleManifest, EvidenceBundle, VerifyBundleResult } from '@/lib/verify6';
import { BUNDLE_MEMBERS } from '@/lib/verify6';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import { segmentsByLevel } from './assurance';

export type SixCodeResult = VerifyBundleResult;

export interface WorkingBundle {
  bundle: EvidenceBundle;
  orgName: string;
  level: LevelId;
  range: { first: number; last: number; count: number };
  sealed: number;
}

const tick = () => new Promise((res) => window.setTimeout(res, 0));

/**
 * Build the bundle for the organisation's chain (or a sequence range of it).
 * `onProgress(fraction, label)` reports the stage; seals are fetched in chunks.
 */
export async function buildWorkingBundle(orgId: string, opts: { from?: number; to?: number; onProgress?: (f: number, label: string) => void; signal?: { cancelled: boolean } } = {}): Promise<WorkingBundle> {
  const progress = opts.onProgress ?? (() => {});
  progress(0.02, 'Reading the chain');
  const [state, evidence] = await Promise.all([api.level(orgId), api.evidence(orgId)]);
  const slice = api.chainSlice(orgId, opts.from, opts.to);
  const receipts: Receipt[] = slice.receipts;
  if (!receipts.length) throw new Error('There are no receipts in that range.');
  const first = receipts[0].seq;
  const last = receipts[receipts.length - 1].seq;
  const seqs = new Set(receipts.map((r) => r.seq));
  const checkpoints = slice.checkpoints.filter((c) => seqs.has(c.seq));
  const segments = segmentsByLevel(receipts, state.history, state.level);
  const sealedSeqs = receipts.filter((r) => levelRank(segments.find((s) => r.seq >= s.firstSeq && r.seq <= s.lastSeq)?.level) >= 1).map((r) => r.seq);

  // Seal v6 records, in chunks
  const seals: SealRecord[] = [];
  const CHUNK = 40;
  for (let i = 0; i < sealedSeqs.length; i += CHUNK) {
    if (opts.signal?.cancelled) throw new Error('cancelled');
    const part = await Promise.all(sealedSeqs.slice(i, i + CHUNK).map((s) => api.seal(orgId, s)));
    for (const v of part) if (v.sealed) seals.push(v.seal);
    progress(0.05 + 0.55 * Math.min(1, (i + CHUNK) / Math.max(1, sealedSeqs.length)), `Reading Seal v6 records (${Math.min(sealedSeqs.length, i + CHUNK)} of ${sealedSeqs.length})`);
    await tick();
  }

  // Anchors: the batches that overlap the range, with their leaves (the receipt hashes they commit to)
  progress(0.62, 'Reading Merkle batches and timestamp tokens');
  let anchors: EvidenceBundle['anchors'];
  if (sealedSeqs.length) {
    const view = await api.anchors(orgId, 100_000);
    const byHash = new Map(receipts.map((r) => [r.seq, r.hash]));
    const all = api.chainSlice(orgId).receipts;
    const hashOf = (s: number) => byHash.get(s) ?? all.find((r) => r.seq === s)?.hash ?? '';
    anchors = {
      authorities: [...view.authorities, ...(view.previousAuthorities ?? [])],
      batches: view.batches
        .filter((b) => b.lastSeq >= first && b.firstSeq <= last)
        .reverse()
        .map((b) => ({ ...b, leaves: Array.from({ length: b.lastSeq - b.firstSeq + 1 }, (_, k) => hashOf(b.firstSeq + k)) })),
    };
  }

  // Declarations and the context profile rules read
  progress(0.7, 'Reading declarations');
  const [agents, inventory, assessments, erasures, disclosures] = await Promise.all([
    api.agents(orgId), api.inventory(orgId), api.assessments(orgId),
    levelRank(state.level) >= 1 ? api.erasures(orgId) : Promise.resolve({ requests: [] as never[] }),
    levelRank(state.level) >= 2 ? api.disclosures(orgId) : Promise.resolve([] as DisclosurePackage[]),
  ]);
  const used = new Map<string, { slug: string; version: number; hash: string }>();
  for (const r of receipts) if (r.agent && r.rulebook) used.set(`${r.agent}@${r.rulebook.version}`, { slug: r.agent, version: r.rulebook.version, hash: r.rulebook.hash });
  const now = Date.now();
  const liveDisclosures = (disclosures as DisclosurePackage[]).filter((d) => d.status === 'active' && new Date(d.expiresAt).getTime() > now && seqs.has(d.seq));

  const manifest: BundleManifest = {
    org: evidence.org.name, org_id: orgId, created_at: new Date().toISOString(), receipts: receipts.length, record_count: receipts.length,
    refusal_count: receipts.filter((r) => r.decision === 'refuse').length, first_seq: first, last_seq: last, checkpoints: checkpoints.length,
    keys: evidence.signingKeys.map((k) => ({ kid: k.kid, fingerprint: k.fingerprint, status: k.status })),
    assurance_levels: segments.map((s) => ({ level: s.level, count: s.count, first_seq: s.firstSeq, last_seq: s.lastSeq })),
    continuity_scope: opts.from === undefined && opts.to === undefined ? 'full_chain' : 'range', redaction_profile: 'none',
    note: 'Working copy assembled in the console; not an export. Export a bundle for a signed manifest.',
  };
  const bundle: EvidenceBundle = {
    manifest, public_keys: slice.publicKeys, receipts, checkpoints, seals, anchors,
    declarations: {
      rulebooks: [...used.values()],
      context: {
        wormRetentionYears: levelRank(state.level) >= 1 ? 8 : 0,
        erasures: erasures.requests,
        agents: agents.map((a) => ({ slug: a.slug, id: a.id, aiSystemId: a.aiSystemId })),
        aiSystems: inventory.map((x) => ({ id: x.id, linkedAgentId: x.linkedAgentId, riskTier: x.riskTier })),
        assessments: assessments.map((a) => ({ aiSystemId: a.aiSystemId, status: a.status })),
      },
    },
    profile: null,
    disclosures: liveDisclosures,
  };
  progress(0.75, 'Bundle assembled');
  return { bundle, orgName: evidence.org.name, level: state.level, range: { first, last, count: receipts.length }, sealed: seals.length };
}

/** Run the six-code verifier over a working bundle; section 1 reports the assembly (there is no signed manifest). */
export async function runSixCode(w: WorkingBundle, opts: { profileId?: string; expectedFingerprint?: string }): Promise<SixCodeResult> {
  await tick();
  const res = await api.verifyBundle(w.bundle, { profileId: opts.profileId || 'none', expectedFingerprint: opts.expectedFingerprint?.trim() || undefined });
  const s1 = res.sections.find((s) => s.id === 'bundle');
  if (s1 && s1.state === 'pass') {
    s1.detail = `Assembled in this browser from the organisation’s records: ${w.range.count} receipts, ${w.sealed} Seal v6 records, ${w.bundle.anchors?.batches.length ?? 0} Merkle batches, ${w.bundle.checkpoints.length} checkpoints and ${Object.keys(w.bundle.public_keys).length} keys. The signed manifest and its ${BUNDLE_MEMBERS.length} member digests are checked when you verify an exported bundle.`;
    s1.facts = [{ label: 'Source', value: 'Working copy (not exported)' }, { label: 'Range', value: `#${w.range.first}–#${w.range.last}` }, { label: 'Records', value: String(w.range.count) }, { label: 'Levels', value: res.levels.map((l) => `${LEVEL_INFO[l.level].short} ${l.count}`).join(' · ') }];
  }
  return res;
}
