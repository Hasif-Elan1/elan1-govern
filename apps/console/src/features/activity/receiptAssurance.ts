/**
 * Everything the receipt page shows about one receipt beyond L1: the level it was written at, its Seal v6
 * record, the Merkle batch and both timestamp tokens, key custody, the autonomy grant in force when it was
 * decided (L3), and what was issued, disclosed or received around it. All through src/api.
 */
import { api } from '@/api';
import type {
  AutonomyGrant, AutonomyLevel, CrossOrgReceipt, Decision, DisclosurePackage, InclusionProof, KeyCustody, LevelId, LevelState, Receipt,
  RegulatoryPack, SigningKey, TsaAuthority,
} from '@/types';
import { levelRank } from '@/lib/levels';
import { autonomyLabel, grantFor, NO_GRANT_LABEL } from '@/lib/autonomy';
import { levelOfReceipt, levelSince, PACK_MATCH } from './assurance';
import { RECEIVED_ACTIONS } from './shared';

export type SealView = Awaited<ReturnType<typeof api.seal>>;

export interface AutonomyAtTime {
  /** false when the receipt was written before L3 or is not a decision/outcome */
  applies: boolean;
  why?: string;
  level?: AutonomyLevel;
  hasGrant: boolean;
  label: string;
  grant?: AutonomyGrant;
  /** F11 autonomy_level from the seal, when sealed */
  sealed?: string;
  /** the rulebook's decision when the grant changed it */
  changedFrom?: Decision;
}

export interface ReceiptAssurance {
  state: LevelState;
  level: LevelId;
  l2Since?: string;
  l3Since?: string;
  seal: SealView;
  proof?: InclusionProof;
  proofError?: string;
  batchStatus?: 'anchored' | 'late';
  authorities: TsaAuthority[];
  custody: KeyCustody;
  signingKeys: SigningKey[];
  publicKeys: Record<string, string>;
  autonomy: AutonomyAtTime;
  issued: CrossOrgReceipt[];
  received: CrossOrgReceipt[];
  disclosures: DisclosurePackage[];
  packs: (RegulatoryPack & { applies: boolean })[];
  /** receipts from this one up to its checkpoint, for checkpoint inclusion */
  between: Receipt[];
}

export async function loadReceiptAssurance(orgId: string, r: Receipt, checkpointSeq?: number): Promise<ReceiptAssurance> {
  const [state, seal, anchors, custody, evidence, packs] = await Promise.all([
    api.level(orgId), api.seal(orgId, r.seq), api.anchors(orgId, 400), api.custody(orgId), api.evidence(orgId), api.packs(orgId),
  ]);
  const level = levelOfReceipt(r, state.history, state.level);
  const l2Since = levelSince(state.history, 'l2');
  const l3Since = levelSince(state.history, 'l3');
  let proof: InclusionProof | undefined;
  let proofError: string | undefined;
  if (seal.sealed) {
    try { proof = await api.inclusionProof(orgId, r.seq); } catch (e) { proofError = (e as Error).message; }
  }
  const batchStatus = proof ? anchors.batches.find((b) => b.id === proof!.batchId)?.status : undefined;
  const orgL3 = levelRank(state.level) >= 2;
  const [grants, cross, disclosures] = orgL3
    ? await Promise.all([api.grants(orgId), api.crossOrgReceipts(orgId), api.disclosures(orgId)])
    : [undefined, [] as CrossOrgReceipt[], [] as DisclosurePackage[]];

  // autonomy in force when the receipt was decided
  let autonomy: AutonomyAtTime;
  const decisionLike = r.kind === 'decision' || r.kind === 'outcome';
  const sealedF11 = seal.sealed ? seal.seal.fields.find((f) => f.id === 'F11')?.value : undefined;
  if (!decisionLike) {
    autonomy = { applies: false, hasGrant: false, label: '—', why: r.kind === 'approval' ? 'A person decided this one; autonomy applies to the agent’s own calls.' : 'Admin changes are made by people, not agents.', sealed: sealedF11 };
  } else if (levelRank(level) < 2) {
    autonomy = { applies: false, hasGrant: false, label: '—', why: l3Since ? `Written before earned autonomy started (${new Date(l3Since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}). The rulebook decided alone.` : 'Earned autonomy starts at L3 Proven. The rulebook decided alone.', sealed: sealedF11 };
  } else {
    const fromReceipt = typeof r.details?.autonomy === 'string' ? (r.details.autonomy as AutonomyLevel) : undefined;
    const noGrant = r.details?.autonomy_grant === 'none';
    const row = grants?.rows.find((x) => x.agentSlug === r.agent && x.tool === r.tool);
    const g = row ? grantFor(row.history, r.agent ?? '', r.tool ?? '', new Date(r.ts).getTime()) : undefined;
    const lv: AutonomyLevel | undefined = fromReceipt ?? g?.level ?? (sealedF11 as AutonomyLevel | undefined);
    const hasGrant = fromReceipt ? !noGrant : !!g;
    autonomy = {
      applies: true, level: lv ?? 'A0', hasGrant, label: hasGrant ? autonomyLabel(lv) : NO_GRANT_LABEL, grant: g, sealed: sealedF11,
      changedFrom: typeof r.details?.rulebook_decision === 'string' ? (r.details.rulebook_decision as Decision) : undefined,
    };
  }

  const issued = cross.filter((x) => x.direction === 'issued' && x.seq === r.seq);
  const received = r.action && RECEIVED_ACTIONS.includes(r.action)
    ? cross.filter((x) => x.direction === 'received' && (x.boundSeq === r.seq || (String(r.details?.from ?? '') === x.issuerName && Number(r.details?.seq) === x.seq)))
    : [];
  const ckpt = checkpointSeq;
  const between = ckpt && ckpt > r.seq ? api.chainSlice(orgId, r.seq + 1, ckpt).receipts : [];
  return {
    state, level, l2Since, l3Since, seal, proof, proofError, batchStatus, authorities: [...anchors.authorities, ...(anchors.previousAuthorities ?? [])], custody,
    signingKeys: evidence.signingKeys, publicKeys: evidence.publicKeys, autonomy, issued, received,
    disclosures: disclosures.filter((d) => d.seq === r.seq), packs: packs.map((p) => ({ ...p, applies: PACK_MATCH[p.id](r) })), between,
  };
}
