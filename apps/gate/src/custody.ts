import { randomBytes } from "node:crypto";
import { decrypt, KEY_ROTATED_ACTION, keyFingerprint, publicKeyFromPrivate, shamir } from "@gate/core";
import { forOrg, type Append, type ChainTx } from "@gate/db";
import { chain } from "./chain";
import type { Deps } from "./deps";
import { chainKeyFor, keyBackupAad, newSigningKey, resignRulebooks, type NewSigningKey } from "./keys";

/**
 * Customer-held keys: key ceremonies (a new signing key whose backup is split k-of-n among
 * custodians) and successor keys (published ahead of signing, switched on after an overlap and a
 * second person's confirmation). Every step is a receipt; shares are returned once and never stored.
 */

/** A successor is published this many days before it may sign, so verifiers can pin it first. */
export const SUCCESSOR_OVERLAP_DAYS = 30;
const DAY = 86_400_000;

export interface Custodian {
  name: string;
  role: string;
}

/** The successor bound and waiting to sign, if there is one. */
export function openSuccessor(db: Pick<ChainTx, "keySuccessor">) {
  return db.keySuccessor.findFirst({ where: { activatedAt: null, withdrawnAt: null }, orderBy: { boundAt: "desc" } });
}

/** Binds a new key as the org's successor: `key.bound`, signing off until the overlap ends. Runs under the chain lock. */
async function bindSuccessor(append: Append, tx: ChainTx, orgId: string, key: NewSigningKey, actor: string, purpose: "planned" | "ceremony", ceremonyId?: string) {
  if (await openSuccessor(tx)) throw new Error("A successor key is already bound and waiting to sign. Activate it before binding another.");
  const switchAt = new Date(Date.now() + SUCCESSOR_OVERLAP_DAYS * DAY);
  const r = await append({
    kind: "admin",
    actor,
    action: "key.bound",
    details: { kid: key.kid, provider: key.provider, purpose, signing: "off", switch_at: switchAt.toISOString(), overlap_days: SUCCESSOR_OVERLAP_DAYS, ...(ceremonyId ? { ceremony: ceremonyId } : {}) },
  });
  await tx.keySuccessor.create({
    data: { orgId, kid: key.kid, publicKey: key.publicKey, privateKeyEnc: key.privateKeyEnc, provider: key.provider, purpose, ceremonyId: ceremonyId ?? null, proposedBy: actor, boundSeq: r.seq, boundAt: new Date(r.ts), switchAt },
  });
  return { boundSeq: r.seq, switchAt: switchAt.toISOString() };
}

export interface CeremonyResult {
  ceremonyId: string;
  kid: string;
  seq: number;
  boundSeq: number;
  switchAt: string;
  /** One share per custodian, in order. Shown once: Elan1 Govern keeps none of them. */
  shares: { custodian: Custodian; share: string }[];
}

function checkCustodians(custodians: readonly Custodian[], n: number, k: number): Custodian[] {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) throw new Error("A ceremony needs 2 <= k <= n <= 255 custodians.");
  if (custodians.length !== n) throw new Error(`A ${k}-of-${n} ceremony needs exactly ${n} custodians; ${custodians.length} given.`);
  const clean = custodians.map((c) => ({ name: String(c?.name ?? "").trim(), role: String(c?.role ?? "").trim() || "Key holder" }));
  if (clean.some((c) => !c.name)) throw new Error("Every custodian needs a name.");
  if (new Set(clean.map((c) => c.name.toLowerCase())).size !== n) throw new Error("Each custodian must be a different person.");
  return clean;
}

/**
 * A key ceremony: makes a new org signing key with the active provider (inside it, for an HSM),
 * splits the key that encrypts its backup with Shamir among the custodians, and binds the new key
 * as the successor. Writes `key.ceremony_completed` (naming the custodians, never the shares) and
 * `key.bound`. Only the encrypted backup is stored; the split key is zeroed.
 */
export async function startKeyCeremony(deps: Deps, orgId: string, opts: { n?: number; k?: number; custodians: readonly Custodian[]; actor: string }): Promise<CeremonyResult> {
  const n = opts.n ?? 5;
  const k = opts.k ?? 3;
  const custodians = checkCustodians(opts.custodians, n, k);
  if (await openSuccessor(forOrg(orgId, deps.db))) throw new Error("A successor key is already bound and waiting to sign. Activate it before a new ceremony.");
  const key = await newSigningKey(deps, orgId, { backup: true, label: "org signing key (ceremony)" });
  const backup = key.backup!;
  let shares: string[];
  try {
    shares = shamir.split(backup.key, n, k);
  } finally {
    backup.key.fill(0);
  }
  const shareSet = shamir.parseShare(shares[0]!).set;
  const ceremonyId = `kc_${randomBytes(8).toString("hex")}`;
  return chain(deps, orgId, async (append, tx) => {
    const r = await append({
      kind: "admin",
      actor: opts.actor,
      action: "key.ceremony_completed",
      details: { ceremony: ceremonyId, kind: "generation", kid: key.kid, provider: key.provider, quorum: `${k} of ${n}`, threshold: k, shares: n, custodians, share_set: shareSet },
    });
    await tx.keyCeremony.create({ data: { id: ceremonyId, orgId, kid: key.kid, threshold: k, shareCount: n, custodians: custodians as object[], shareSet, backupEnc: backup.blob, actor: opts.actor, seq: r.seq } });
    const bound = await bindSuccessor(append, tx, orgId, key, opts.actor, "ceremony", ceremonyId);
    return { ceremonyId, kid: key.kid, seq: r.seq, ...bound, shares: shares.map((share, i) => ({ custodian: custodians[i]!, share })) };
  });
}

/**
 * A quorum check: custodians bring their shares and prove the ceremony's backup can be recovered.
 * The recovered key is checked against the ceremony's key id and dropped; nothing is stored but the
 * `key.quorum_checked` receipt, which records the result (and why it failed) but never a share.
 */
export async function quorumCheck(deps: Deps, orgId: string, ceremonyId: string, shares: readonly string[], actor: string): Promise<{ ok: boolean; seq: number; reason?: string }> {
  const c = await forOrg(orgId, deps.db).keyCeremony.findFirst({ where: { id: ceremonyId } });
  if (!c) throw new Error("No such key ceremony.");
  let reason: string | undefined;
  try {
    const key = shamir.combine(shares);
    try {
      const pem = decrypt(Buffer.from(key).toString("hex"), c.backupEnc, keyBackupAad(orgId, c.kid));
      if (keyFingerprint(publicKeyFromPrivate(pem)) !== c.kid) reason = "the recovered key is not the ceremony's key";
    } catch {
      reason = "the shares do not open this ceremony's backup";
    } finally {
      key.fill(0);
    }
  } catch (e) {
    reason = (e as Error).message;
  }
  const details = { ceremony: c.id, kid: c.kid, shares_presented: new Set(shares).size, threshold: c.threshold, ok: !reason, ...(reason ? { reason } : {}) };
  const r = await chain(deps, orgId, (append) => append({ kind: "admin", actor, action: "key.quorum_checked", details }));
  return { ok: !reason, seq: r.seq, ...(reason ? { reason } : {}) };
}

/** Publishes a new key as the org's successor (L2 and above): `key.bound`; it signs after the overlap and a second person's confirmation. */
export async function planSuccessor(deps: Deps, orgId: string, actor: string): Promise<{ kid: string; boundSeq: number; switchAt: string }> {
  if (await openSuccessor(forOrg(orgId, deps.db))) throw new Error("A successor key is already bound and waiting to sign. Activate it before binding another.");
  const key = await newSigningKey(deps, orgId, { label: "org signing key (successor)" });
  return chain(deps, orgId, async (append, tx) => ({ kid: key.kid, ...(await bindSuccessor(append, tx, orgId, key, actor, "planned")) }));
}

export interface ActivateResult {
  kid: string;
  switched: boolean;
  switchAt: string;
  /** The `key.bound_confirmed` receipt, when this call confirmed. */
  confirmedSeq?: number;
  /** The `key.rotated` receipt, when the successor started signing. */
  seq?: number;
  previousKid?: string;
  rulebooksResigned?: number;
}

type SuccessorRow = NonNullable<Awaited<ReturnType<typeof openSuccessor>>>;

/** The switch: `key.rotated` signed by the old key, the old key retired at its time, the successor active, rulebooks re-signed. */
async function switchToSuccessor(deps: Deps, orgId: string, append: Append, tx: ChainTx, oldKid: string, s: SuccessorRow, actor: string) {
  const oldRow = await tx.orgKey.findFirstOrThrow({ where: { kid: oldKid } });
  const r = await append({
    kind: "admin",
    actor,
    action: KEY_ROTATED_ACTION,
    details: { old_kid: oldKid, new_kid: s.kid, successor: true, bound_seq: s.boundSeq, bound_by: s.proposedBy, confirmed_by: s.confirmedBy, switch_at: s.switchAt.toISOString(), ...(s.ceremonyId ? { ceremony: s.ceremonyId } : {}) },
  });
  const at = new Date(r.ts);
  await tx.orgKey.updateMany({ where: { kid: oldKid, retiredAt: null }, data: { retiredAt: at } });
  await tx.orgKey.create({ data: { orgId, kid: s.kid, publicKey: s.publicKey, privateKeyEnc: s.privateKeyEnc, provider: s.provider, createdAt: at } });
  await tx.keySuccessor.update({ where: { id: s.id }, data: { activatedAt: at, activatedSeq: r.seq } });
  const rulebooksResigned = await resignRulebooks(tx, oldRow.publicKey, await chainKeyFor(deps, orgId, s));
  return { seq: r.seq, previousKid: oldKid, rulebooksResigned };
}

/**
 * The second person behind a successor (dual control): `confirmedBy` must differ from whoever
 * bound it. The first call records `key.bound_confirmed`; once the 30-day overlap has ended the
 * successor starts signing (`key.rotated`, signed by the old key). Called before the overlap ends,
 * it confirms and returns `switched: false`; `settleSuccessor` (or a later call) makes the switch.
 */
export async function activateSuccessor(deps: Deps, orgId: string, confirmedBy: string): Promise<ActivateResult> {
  return chain(deps, orgId, async (append, tx, old) => {
    const s = await openSuccessor(tx);
    if (!s) throw new Error("No successor key is waiting to sign.");
    if (confirmedBy.trim().toLowerCase() === s.proposedBy.trim().toLowerCase()) {
      throw new Error("You bound this successor key. A different owner or admin must confirm the switch (dual control).");
    }
    const result: ActivateResult = { kid: s.kid, switched: false, switchAt: s.switchAt.toISOString() };
    if (!s.confirmedBy) {
      const r = await append({ kind: "admin", actor: confirmedBy, action: "key.bound_confirmed", details: { kid: s.kid, bound_by: s.proposedBy, bound_seq: s.boundSeq, switch_at: s.switchAt.toISOString(), control: "dual" } });
      await tx.keySuccessor.update({ where: { id: s.id }, data: { confirmedBy, confirmedSeq: r.seq } });
      s.confirmedBy = confirmedBy;
      result.confirmedSeq = r.seq;
    }
    if (s.switchAt.getTime() > Date.now()) return result;
    return { ...result, switched: true, ...(await switchToSuccessor(deps, orgId, append, tx, old.kid as string, s, confirmedBy)) };
  });
}

/** For a scheduled job: switches a confirmed successor whose overlap has ended. Returns the `key.rotated` seq, or null. */
export async function settleSuccessor(deps: Deps, orgId: string): Promise<number | null> {
  return chain(deps, orgId, async (append, tx, old) => {
    const s = await openSuccessor(tx);
    if (!s || !s.confirmedBy || s.switchAt.getTime() > Date.now()) return null;
    return (await switchToSuccessor(deps, orgId, append, tx, old.kid as string, s, "Elan1 Govern")).seq;
  });
}
