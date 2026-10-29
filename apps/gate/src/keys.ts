import { randomBytes } from "node:crypto";
import {
  decrypt,
  encrypt,
  generateKeyPair,
  KEY_ROTATED_ACTION,
  keyFingerprint,
  loadSignedRulebook,
  rulebookSigningPayload,
  rulebookToYaml,
  verifyText,
  type Rulebook,
} from "@gate/core";
import { allOrgIds, forOrg, signWithKey, type ChainKey, type ChainTx, type KeySource } from "@gate/db";
import { chain } from "./chain";
import type { Deps } from "./deps";

/** Which org key a provider is asked about. */
export interface KeyCtx {
  orgId: string;
  kid: string;
}

/** A key a provider holds: its context plus what the provider stored for it (`OrgKey.privateKeyEnc`). */
export interface KeyRef extends KeyCtx {
  ref: string;
}

/** A key made inside a provider. `backup`, when asked for, is the private key encrypted under a fresh 32-byte key. */
export interface GeneratedKey {
  kid: string;
  publicKeyPem: string;
  ref: string;
  backup?: { key: Uint8Array; blob: string };
}

/**
 * Wraps and unwraps org signing keys at rest. `name` is stored on each OrgKey row, so keys wrapped
 * by different providers coexist (unwrap dispatches on it) and `rewrapAll` can move them.
 *
 * Shipped providers: `env` (GATE_MASTER_KEY, AES-256-GCM, AAD bound to org and key id), `aws-kms`
 * (envelope encryption with a KMS data key, encryption context `{ orgId, kid }`; kms.ts) and
 * `soft-hsm` (a software HSM; soft-hsm.ts). A provider that implements `sign` keeps the private key
 * inside its boundary: it generates keys there, signs by reference, and refuses `unwrap`. The chain
 * signs through it (see `signer`), checking every signature against the stored public key.
 */
export interface KeyProvider {
  readonly name: string;
  wrap(privateKeyPem: string, ctx: KeyCtx): Promise<string>;
  unwrap(privateKeyEnc: string, ctx: KeyCtx): Promise<string>;
  /** Makes a key inside the provider. Providers without it get keys made in this process and wrapped. */
  generate?(orgId: string, opts?: { backup?: boolean; label?: string }): Promise<GeneratedKey>;
  /** Ed25519-signs `digest` (the text of a hash) with a key the provider holds, as `ed25519:<base64>`. */
  sign?(key: KeyRef, digest: string): Promise<string>;
  /** The public key PEM of a key the provider holds. */
  publicKey?(key: KeyRef): Promise<string>;
}

/** Thrown by providers that never hand out private keys. */
export class KeyNotExtractableError extends Error {
  constructor(provider: string) {
    super(`this signing key is held by the "${provider}" key provider and cannot be exported; it can only sign`);
    this.name = "KeyNotExtractableError";
  }
}

/** AAD used before key rotation existed (Org.privateKeyEnc and rows copied from it). */
export const legacyKeyAad = (orgId: string) => `org-key:${orgId}`;
const keyAad = (orgId: string, kid: string) => `org-key:${orgId}:${kid}`;
/** AAD of a ceremony backup: the private key encrypted under the key that the custodians' shares make up. */
export const keyBackupAad = (orgId: string, kid: string) => `key-backup:${orgId}:${kid}`;

export function envKeyProvider(masterKeyHex: string): KeyProvider {
  return {
    name: "env",
    async wrap(pem, { orgId, kid }) {
      return encrypt(masterKeyHex, pem, keyAad(orgId, kid));
    },
    async unwrap(enc, { orgId, kid }) {
      try {
        return decrypt(masterKeyHex, enc, keyAad(orgId, kid));
      } catch {
        // Keys copied from Org.privateKeyEnc by the migration are bound to the org id only.
        return decrypt(masterKeyHex, enc, legacyKeyAad(orgId));
      }
    },
  };
}

/** The provider that wrapped a row: the active one, another configured one, or the env master key. */
export function providerFor(deps: Deps, name: string): KeyProvider {
  if (deps.keys.name === name) return deps.keys;
  const other = deps.keyProviders?.find((p) => p.name === name);
  if (other) return other;
  if (name === "env") return envKeyProvider(deps.env.GATE_MASTER_KEY);
  throw new Error(`no "${name}" key provider is configured, so keys it wrapped cannot be used`);
}

export interface OrgSigningKey {
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

const cache = new Map<string, string>();

type KeyReader = Pick<ChainTx, "orgKey" | "org">;
type KeyRow = { kid: string; publicKey: string; privateKeyEnc: string; provider: string };

/** The org's active key row, copying the legacy Org columns into OrgKey on first use. */
async function activeRow(orgId: string, db: KeyReader) {
  const row = await db.orgKey.findFirst({ where: { retiredAt: null }, orderBy: { createdAt: "desc" } });
  if (row) return row;
  if (await db.orgKey.findFirst()) throw new Error("this organisation has no active signing key");
  const org = await db.org.findFirstOrThrow({ select: { publicKey: true, privateKeyEnc: true, createdAt: true } });
  const kid = keyFingerprint(org.publicKey);
  return db.orgKey.upsert({
    where: { orgId_kid: { orgId, kid } },
    create: { orgId, kid, publicKey: org.publicKey, privateKeyEnc: org.privateKeyEnc, provider: "env", createdAt: org.createdAt },
    update: {},
  });
}

async function unwrap(deps: Deps, orgId: string, row: KeyRow) {
  const id = `${orgId}:${row.kid}`;
  let pem = cache.get(id);
  if (!pem) {
    pem = await providerFor(deps, row.provider).unwrap(row.privateKeyEnc, { orgId, kid: row.kid });
    cache.set(id, pem);
  }
  return pem;
}

/**
 * A chain key for a row: signing by reference when its provider signs inside its boundary,
 * otherwise the unwrapped private key (today's path). A provider's signature is checked against
 * the row's public key before it is used, so a faulty or swapped key never reaches the chain.
 */
export async function chainKeyFor(deps: Deps, orgId: string, row: KeyRow): Promise<ChainKey> {
  const provider = providerFor(deps, row.provider);
  const sign = provider.sign?.bind(provider);
  if (!sign) return { kid: row.kid, privateKeyPem: await unwrap(deps, orgId, row) };
  const ref: KeyRef = { orgId, kid: row.kid, ref: row.privateKeyEnc };
  return {
    kid: row.kid,
    async sign(text) {
      const sig = await sign(ref, text);
      if (!verifyText(row.publicKey, text, sig)) throw new Error(`the "${provider.name}" key provider returned a signature that does not verify with key ${row.kid}`);
      return sig;
    },
  };
}

/**
 * The org's current signing key with its private key, for the few signers that still need it in
 * this process (evidence bundles). Throws KeyNotExtractableError for a key held inside an HSM.
 * Chain writes use `signer()`; code that only needs the public key uses `orgKey()` in deps.ts.
 */
export async function activeKey(deps: Deps, orgId: string, db: KeyReader = forOrg(orgId, deps.db) as unknown as KeyReader): Promise<OrgSigningKey> {
  const row = await activeRow(orgId, db);
  return { kid: row.kid, publicKeyPem: row.publicKey, privateKeyPem: await unwrap(deps, orgId, row) };
}

/** The org's current public key, without touching the private key. */
export async function activePublicKey(deps: Deps, orgId: string): Promise<{ kid: string; publicKeyPem: string }> {
  const row = await activeRow(orgId, forOrg(orgId, deps.db) as unknown as KeyReader);
  return { kid: row.kid, publicKeyPem: row.publicKey };
}

/** The org's current key as a signer, for signatures made outside a chain write (signed statements). */
export async function activeChainKey(deps: Deps, orgId: string): Promise<ChainKey> {
  return chainKeyFor(deps, orgId, await activeRow(orgId, forOrg(orgId, deps.db) as unknown as KeyReader));
}

/** A key source for chain writes: resolved under the chain lock, so a rotation is never raced. */
export function signer(deps: Deps, orgId: string): KeySource {
  return async (tx) => chainKeyFor(deps, orgId, await activeRow(orgId, tx));
}

/** Creates an org's first key row (the gate creates orgs). */
export async function addFirstKey(deps: Deps, orgId: string, keys: { publicKeyPem: string; privateKeyPem: string }) {
  const kid = keyFingerprint(keys.publicKeyPem);
  await forOrg(orgId, deps.db).orgKey.create({
    data: { orgId, kid, publicKey: keys.publicKeyPem, privateKeyEnc: await deps.keys.wrap(keys.privateKeyPem, { orgId, kid }), provider: deps.keys.name },
  });
  return kid;
}

export interface NewSigningKey extends KeyRow {
  /** Signs with the new key (by reference when it is held inside the provider). */
  chainKey: ChainKey;
  backup?: { key: Uint8Array; blob: string };
}

/**
 * Makes a new org signing key with the active provider: inside it when it can generate keys,
 * otherwise here, wrapped at once. With `backup`, also returns the private key encrypted under a
 * fresh random key (the caller splits that key among custodians and zeroes it).
 */
export async function newSigningKey(deps: Deps, orgId: string, opts: { backup?: boolean; label?: string } = {}): Promise<NewSigningKey> {
  const p = deps.keys;
  if (p.generate) {
    const g = await p.generate(orgId, opts);
    const row = { kid: g.kid, publicKey: g.publicKeyPem, privateKeyEnc: g.ref, provider: p.name };
    return { ...row, chainKey: await chainKeyFor(deps, orgId, row), ...(g.backup ? { backup: g.backup } : {}) };
  }
  const next = generateKeyPair();
  const kid = keyFingerprint(next.publicKeyPem);
  const row = { kid, publicKey: next.publicKeyPem, privateKeyEnc: await p.wrap(next.privateKeyPem, { orgId, kid }), provider: p.name };
  let backup: NewSigningKey["backup"];
  if (opts.backup) {
    const key = new Uint8Array(randomBytes(32));
    backup = { key, blob: encrypt(Buffer.from(key).toString("hex"), next.privateKeyPem, keyBackupAad(orgId, kid)) };
  }
  return { ...row, chainKey: { kid, privateKeyPem: next.privateKeyPem }, ...(backup ? { backup } : {}) };
}

/** Signs a rulebook with a chain key, wherever the key is held. */
export async function signRulebookWith(rb: Rulebook, key: ChainKey): Promise<Rulebook> {
  return { ...rb, signature: await signWithKey(key, rulebookSigningPayload(rb)) };
}

/** Re-signs every rulebook the old key signed with the new one. Their hash does not cover the signature, so receipts that cite them stay valid. */
export async function resignRulebooks(tx: ChainTx, oldPublicKeyPem: string, next: ChainKey): Promise<number> {
  let n = 0;
  for (const rb of await tx.rulebook.findMany({ select: { id: true, yaml: true } })) {
    const loaded = loadSignedRulebook(rb.yaml, oldPublicKeyPem);
    if (!loaded.ok) continue; // never launder a rulebook the old key did not sign
    const { signature: _old, ...unsigned } = loaded.rulebook;
    await tx.rulebook.update({ where: { id: rb.id }, data: { yaml: rulebookToYaml(await signRulebookWith(unsigned, next)) } });
    n++;
  }
  return n;
}

export interface RotateResult {
  kid: string;
  previousKid: string;
  seq: number;
  rulebooksResigned: number;
}

/**
 * Makes a new active key and retires the old one, which stays for verification. The `key.rotated`
 * receipt is signed with the OLD key and names the new one, so the chain attests the handover;
 * the old key's retirement time is that receipt's time. Rulebooks are re-signed with the new key.
 */
export async function rotateSigningKey(deps: Deps, orgId: string, actor: string): Promise<RotateResult> {
  const next = await newSigningKey(deps, orgId, { label: "org signing key (rotation)" });
  return chain(deps, orgId, async (append, tx, old) => {
    // A bound successor was published for verifiers to pin: an immediate rotation would skip it.
    if (await tx.keySuccessor.findFirst({ where: { activatedAt: null, withdrawnAt: null } })) throw new Error("A successor key is bound and waiting to sign; activate it instead of rotating.");
    const previousKid = old.kid as string;
    const oldRow = await tx.orgKey.findFirstOrThrow({ where: { kid: previousKid } });
    const receipt = await append({ kind: "admin", actor, action: KEY_ROTATED_ACTION, details: { old_kid: previousKid, new_kid: next.kid } });
    const at = new Date(receipt.ts);
    await tx.orgKey.updateMany({ where: { kid: previousKid, retiredAt: null }, data: { retiredAt: at } });
    await tx.orgKey.create({ data: { orgId, kid: next.kid, publicKey: next.publicKey, privateKeyEnc: next.privateKeyEnc, provider: next.provider, createdAt: at } });
    const rulebooksResigned = await resignRulebooks(tx, oldRow.publicKey, next.chainKey);
    return { kid: next.kid, previousKid, seq: receipt.seq, rulebooksResigned };
  });
}

export interface RewrapResult {
  orgs: number;
  keys: number;
}

/**
 * Moves every key wrapped by `from` to `to` (for example env → aws-kms), org by org. Keys are
 * unwrapped and re-wrapped before each org's transaction; the row is only updated if nobody changed
 * it meanwhile. Each org gets a `key.rewrapped` receipt naming the providers and key ids; `orgIds`
 * limits the run to some orgs (default: all). A key
 * held inside an HSM cannot be exported, so moving away from one fails before anything is written.
 */
export async function rewrapAll(deps: Deps, from: KeyProvider, to: KeyProvider, opts: { actor?: string; orgIds?: readonly string[] } = {}): Promise<RewrapResult> {
  if (from.name === to.name) throw new Error("re-wrapping needs two different key providers");
  const actor = opts.actor ?? "Elan1 Govern";
  let keys = 0;
  let touched = 0;
  for (const orgId of opts.orgIds ?? (await allOrgIds(deps.db))) {
    const db = forOrg(orgId, deps.db);
    const rows = await db.orgKey.findMany({ where: { provider: from.name }, orderBy: { createdAt: "asc" } });
    const successors = await db.keySuccessor.findMany({ where: { provider: from.name, activatedAt: null, withdrawnAt: null } });
    if (!rows.length && !successors.length) continue;
    const rewrap = async (r: { id: string; kid: string; privateKeyEnc: string }) => {
      const ctx = { orgId, kid: r.kid };
      return { id: r.id, kid: r.kid, old: r.privateKeyEnc, next: await to.wrap(await from.unwrap(r.privateKeyEnc, ctx), ctx) };
    };
    const keyUpdates = await Promise.all(rows.map(rewrap));
    const successorUpdates = await Promise.all(successors.map(rewrap));
    await chain(deps, orgId, async (append, tx) => {
      for (const u of keyUpdates) {
        const n = await tx.orgKey.updateMany({ where: { id: u.id, provider: from.name, privateKeyEnc: u.old }, data: { provider: to.name, privateKeyEnc: u.next } });
        if (n.count !== 1) throw new Error(`key ${u.kid} changed while it was being re-wrapped; run it again`);
      }
      for (const u of successorUpdates) {
        const n = await tx.keySuccessor.updateMany({ where: { id: u.id, provider: from.name, privateKeyEnc: u.old }, data: { provider: to.name, privateKeyEnc: u.next } });
        if (n.count !== 1) throw new Error(`successor key ${u.kid} changed while it was being re-wrapped; run it again`);
      }
      const kids = [...keyUpdates, ...successorUpdates].map((u) => u.kid);
      await append({ kind: "admin", actor, action: "key.rewrapped", details: { from: from.name, to: to.name, kids } });
    });
    keys += keyUpdates.length + successorUpdates.length;
    touched++;
  }
  return { orgs: touched, keys };
}
