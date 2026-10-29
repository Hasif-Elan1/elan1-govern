import { createPrivateKey, hkdfSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { decrypt, encrypt, generateKeyPair, keyFingerprint, publicKeyFromPrivate, SIG_PREFIX } from "@gate/core";
import type { Db } from "@gate/db";
import { keyBackupAad, KeyNotExtractableError, type GeneratedKey, type KeyCtx, type KeyProvider, type KeyRef } from "./keys";

const REF_PREFIX = "hsm:";
const materialAad = (handle: string, orgId: string, kid: string) => `soft-hsm:${handle}:${orgId}:${kid}`;

/**
 * A software HSM behind the `KeyProvider` seam (name `soft-hsm`): the stand-in for a customer's
 * HSM until a PKCS#11 adapter exists. Keys are generated inside this module and kept in the HsmKey
 * table, encrypted under a key-encryption key derived (HKDF-SHA256) from GATE_MASTER_KEY; the AAD
 * binds each row to its handle, org and key id. It signs and returns public keys by handle and
 * never returns a private key: `unwrap` always throws. The one way a key leaves is the ceremony
 * backup at generation time, encrypted under a fresh key that the caller splits among custodians.
 *
 * What this protects: no code outside this module can read an HSM-held private key, and a copied
 * row is useless to another org. What it does not: anyone holding GATE_MASTER_KEY and the database
 * can decrypt the store, as with the env provider. A hardware HSM removes that.
 */
export class SoftHsmKeyProvider implements KeyProvider {
  readonly name = "soft-hsm";
  readonly #kek: string;
  readonly #db: Db;
  /** Decrypted keys by handle, with the org and kid they were opened for. Never handed out. */
  readonly #open = new Map<string, { orgId: string; kid: string; key: KeyObject }>();

  constructor(masterKeyHex: string, db: Db) {
    this.#kek = Buffer.from(hkdfSync("sha256", Buffer.from(masterKeyHex, "hex"), Buffer.alloc(0), "elan1-govern soft-hsm kek v1", 32)).toString("hex");
    this.#db = db;
  }

  async generate(orgId: string, opts: { backup?: boolean; label?: string } = {}): Promise<GeneratedKey> {
    const pair = generateKeyPair();
    const kid = keyFingerprint(pair.publicKeyPem);
    const ref = await this.#store(pair.privateKeyPem, pair.publicKeyPem, { orgId, kid }, opts.label ?? "org signing key");
    let backup: GeneratedKey["backup"];
    if (opts.backup) {
      const key = new Uint8Array(randomBytes(32));
      backup = { key, blob: encrypt(Buffer.from(key).toString("hex"), pair.privateKeyPem, keyBackupAad(orgId, kid)) };
    }
    return { kid, publicKeyPem: pair.publicKeyPem, ref, ...(backup ? { backup } : {}) };
  }

  /** Imports a key made elsewhere (an org's first key, a re-wrap, a restore). Returns its handle. */
  async wrap(privateKeyPem: string, ctx: KeyCtx): Promise<string> {
    const publicKeyPem = publicKeyFromPrivate(privateKeyPem);
    if (keyFingerprint(publicKeyPem) !== ctx.kid) throw new Error("the key does not match its key id");
    return this.#store(privateKeyPem, publicKeyPem, ctx, "org signing key (imported)");
  }

  async unwrap(): Promise<string> {
    throw new KeyNotExtractableError(this.name);
  }

  async sign(key: KeyRef, digest: string): Promise<string> {
    const k = await this.#load(key);
    return SIG_PREFIX + edSign(null, Buffer.from(digest, "utf8"), k).toString("base64");
  }

  async publicKey(key: KeyRef): Promise<string> {
    const row = await this.#db.hsmKey.findUnique({ where: { handle: this.#handle(key.ref) }, select: { publicKey: true } });
    if (!row) throw new Error("no such key in the software HSM");
    return row.publicKey;
  }

  async #store(privateKeyPem: string, publicKeyPem: string, ctx: KeyCtx, label: string): Promise<string> {
    const handle = randomBytes(16).toString("hex");
    await this.#db.hsmKey.create({ data: { handle, label, publicKey: publicKeyPem, materialEnc: encrypt(this.#kek, privateKeyPem, materialAad(handle, ctx.orgId, ctx.kid)) } });
    return REF_PREFIX + handle;
  }

  #handle(ref: string): string {
    if (!ref.startsWith(REF_PREFIX)) throw new Error("not a software HSM key handle");
    return ref.slice(REF_PREFIX.length);
  }

  async #load({ orgId, kid, ref }: KeyRef): Promise<KeyObject> {
    const handle = this.#handle(ref);
    const open = this.#open.get(handle);
    if (open) {
      if (open.orgId !== orgId || open.kid !== kid) throw new Error("this key handle belongs to another key");
      return open.key;
    }
    const row = await this.#db.hsmKey.findUnique({ where: { handle } });
    if (!row) throw new Error("no such key in the software HSM");
    let key: KeyObject;
    try {
      key = createPrivateKey(decrypt(this.#kek, row.materialEnc, materialAad(handle, orgId, kid)));
    } catch {
      throw new Error("this key handle belongs to another key");
    }
    this.#open.set(handle, { orgId, kid, key });
    return key;
  }
}
