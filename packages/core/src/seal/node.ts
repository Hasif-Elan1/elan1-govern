// The Node crypto provider for Seal v6 (node:crypto, the same library core's crypto.ts uses). Importing this
// module installs it, unless another provider was installed first. `@gate/core` imports it; the browser entry
// does not.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { setSealCrypto, sealCryptoInstalled, type SealCrypto } from "./primitives";

// DER prefixes that wrap a raw 32-byte Ed25519 seed (PKCS #8) and public key (SPKI), RFC 8410.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKey(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new TypeError("an Ed25519 seed is 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

// Verifying a bundle checks thousands of signatures by a handful of keys: keep the parsed public keys.
const publicKeys = new Map<string, KeyObject>();
function publicKey(raw: Uint8Array): KeyObject {
  const id = Buffer.from(raw).toString("hex");
  let k = publicKeys.get(id);
  if (!k) {
    k = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    if (publicKeys.size >= 256) publicKeys.clear();
    publicKeys.set(id, k);
  }
  return k;
}

export const nodeSealCrypto: SealCrypto = {
  sha256: (data) => new Uint8Array(createHash("sha256").update(data).digest()),
  sha384: (data) => new Uint8Array(createHash("sha384").update(data).digest()),
  sha512: (data) => new Uint8Array(createHash("sha512").update(data).digest()),
  sha1: (data) => new Uint8Array(createHash("sha1").update(data).digest()),
  ed25519PublicKey: (seed) => new Uint8Array(createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length)),
  ed25519Sign: (message, seed) => new Uint8Array(sign(null, message, privateKey(seed))),
  ed25519Verify: (signature, message, pub) => {
    if (signature.length !== 64 || pub.length !== 32) return false;
    try {
      return verify(null, message, publicKey(pub), signature);
    } catch {
      return false;
    }
  },
};

if (!sealCryptoInstalled()) setSealCrypto(nodeSealCrypto);
