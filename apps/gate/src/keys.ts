import { decrypt, encrypt, generateKeyPair, KEY_ROTATED_ACTION, keyFingerprint, loadSignedRulebook, rulebookToYaml, signRulebook } from "@gate/core";
import { forOrg, type ChainKey, type ChainTx, type KeySource } from "@gate/db";
import { chain } from "./chain";
import type { Deps } from "./deps";

/**
 * Wraps and unwraps org signing keys at rest. The default keeps a master key in the
 * environment (GATE_MASTER_KEY) and uses AES-256-GCM with an AAD bound to the org and key id.
 *
 * A cloud KMS implementation (AWS KMS, Google Cloud KMS, Azure Key Vault, an HSM over PKCS#11)
 * plugs in here: `wrap` calls the KMS Encrypt API (or GenerateDataKey for envelope encryption)
 * with `{ orgId, kid }` as the encryption context, `unwrap` calls Decrypt, and `name` ("aws-kms",
 * "gcp-kms", ...) is stored on each OrgKey row so keys wrapped by different providers can coexist
 * during a migration. Nothing else in Gate changes: signing still happens in this process.
 */
export interface KeyProvider {
  readonly name: string;
  wrap(privateKeyPem: string, ctx: { orgId: string; kid: string }): Promise<string>;
  unwrap(privateKeyEnc: string, ctx: { orgId: string; kid: string }): Promise<string>;
}

/** AAD used before key rotation existed (Org.privateKeyEnc and rows copied from it). */
export const legacyKeyAad = (orgId: string) => `org-key:${orgId}`;
const keyAad = (orgId: string, kid: string) => `org-key:${orgId}:${kid}`;

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

export interface OrgSigningKey extends Required<ChainKey> {
  publicKeyPem: string;
}

const cache = new Map<string, string>();

type KeyReader = Pick<ChainTx, "orgKey" | "org">;

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

async function unwrap(deps: Deps, orgId: string, row: { kid: string; privateKeyEnc: string }) {
  const id = `${orgId}:${row.kid}`;
  let pem = cache.get(id);
  if (!pem) {
    pem = await deps.keys.unwrap(row.privateKeyEnc, { orgId, kid: row.kid });
    cache.set(id, pem);
  }
  return pem;
}

/** The org's current signing key. Prefer `signer()` for chain writes. */
export async function activeKey(deps: Deps, orgId: string, db: KeyReader = forOrg(orgId, deps.db) as unknown as KeyReader): Promise<OrgSigningKey> {
  const row = await activeRow(orgId, db);
  return { kid: row.kid, publicKeyPem: row.publicKey, privateKeyPem: await unwrap(deps, orgId, row) };
}

/** A key source for chain writes: resolved under the chain lock, so a rotation is never raced. */
export function signer(deps: Deps, orgId: string): KeySource {
  return (tx) => activeKey(deps, orgId, tx);
}

/** Creates an org's first key row (the gate creates orgs). */
export async function addFirstKey(deps: Deps, orgId: string, keys: { publicKeyPem: string; privateKeyPem: string }) {
  const kid = keyFingerprint(keys.publicKeyPem);
  await forOrg(orgId, deps.db).orgKey.create({
    data: { orgId, kid, publicKey: keys.publicKeyPem, privateKeyEnc: await deps.keys.wrap(keys.privateKeyPem, { orgId, kid }), provider: deps.keys.name },
  });
  return kid;
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
 * the old key's retirement time is that receipt's time. Rulebooks are re-signed with the new key
 * (their hash does not cover the signature, so receipts that cite them stay valid).
 */
export async function rotateSigningKey(deps: Deps, orgId: string, actor: string): Promise<RotateResult> {
  const next = generateKeyPair();
  const kid = keyFingerprint(next.publicKeyPem);
  const privateKeyEnc = await deps.keys.wrap(next.privateKeyPem, { orgId, kid });
  return chain(deps, orgId, async (append, tx, old) => {
    const previousKid = old.kid as string;
    const oldRow = await tx.orgKey.findFirstOrThrow({ where: { kid: previousKid } });
    const receipt = await append({ kind: "admin", actor, action: KEY_ROTATED_ACTION, details: { old_kid: previousKid, new_kid: kid } });
    const at = new Date(receipt.ts);
    await tx.orgKey.updateMany({ where: { kid: previousKid, retiredAt: null }, data: { retiredAt: at } });
    await tx.orgKey.create({ data: { orgId, kid, publicKey: next.publicKeyPem, privateKeyEnc, provider: deps.keys.name, createdAt: at } });

    let rulebooksResigned = 0;
    for (const rb of await tx.rulebook.findMany({ select: { id: true, yaml: true } })) {
      const loaded = loadSignedRulebook(rb.yaml, oldRow.publicKey);
      if (!loaded.ok) continue; // never launder a rulebook the old key did not sign
      const { signature: _old, ...unsigned } = loaded.rulebook;
      await tx.rulebook.update({ where: { id: rb.id }, data: { yaml: rulebookToYaml(signRulebook(unsigned, next.privateKeyPem)) } });
      rulebooksResigned++;
    }
    return { kid, previousKid, seq: receipt.seq, rulebooksResigned };
  });
}
