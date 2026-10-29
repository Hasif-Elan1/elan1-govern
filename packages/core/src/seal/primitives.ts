// The byte-level primitives Seal v6, the Merkle batches and the six-code verifier are built on.
//
// This module is isomorphic: it never imports node:crypto. SHA-256 and Ed25519 come from a provider. Importing
// `@gate/core` (Node: the CLI, the gate service, the web server) installs one backed by node:crypto (./node.ts).
// A browser, which has no synchronous SHA-256 or Ed25519 of its own, installs one with setSealCrypto() before the
// first call (the console passes its @noble adapter); core itself takes no crypto dependency.
//
// Formats are the console's, byte for byte: hashes and keys are lower-case hex without a prefix, Ed25519 private
// keys are 32-byte seeds, signatures are 64 bytes as hex. Canonical JSON is core's canonicalize(). Records from the
// organisation's real chain keep the chain's own strings (`sha256:` hashes, `ed25519:<base64>` signatures, kids that
// are key fingerprints): verifySig and keyFingerprintOf accept them beside the console's demo forms.
import { canonicalize } from "../canonical";
import { signatureHex } from "../console-receipt";
import { derToPem } from "./rfc3161";

export interface SealCrypto {
  sha256(data: Uint8Array): Uint8Array;
  /** The 32-byte Ed25519 public key for a 32-byte seed. */
  ed25519PublicKey(seed: Uint8Array): Uint8Array;
  ed25519Sign(message: Uint8Array, seed: Uint8Array): Uint8Array;
  /** Never throws: a malformed key or signature fails. */
  ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
  /**
   * Only for RFC 3161 timestamp tokens from hosted authorities (RSA over SHA-384 or SHA-512, an ESS signingCertificate's
   * SHA-1 certificate hash). Without them such a token does not verify; the gate's own authorities need SHA-256 only.
   */
  sha384?(data: Uint8Array): Uint8Array;
  sha512?(data: Uint8Array): Uint8Array;
  sha1?(data: Uint8Array): Uint8Array;
}

let provider: SealCrypto | undefined;

/** Install the SHA-256 and Ed25519 provider. Returns the one it replaces. */
export function setSealCrypto(p: SealCrypto | undefined): SealCrypto | undefined {
  const prev = provider;
  provider = p;
  return prev;
}

export const sealCryptoInstalled = (): boolean => provider !== undefined;

export function sealCrypto(): SealCrypto {
  if (!provider) throw new Error("Seal v6 has no crypto provider: import @gate/core (Node) or call setSealCrypto() first (browser).");
  return provider;
}

/* ── Bytes and hex ───────────────────────────────────────── */

const enc = new TextEncoder();

export function utf8ToBytes(s: string): Uint8Array {
  if (typeof s !== "string") throw new TypeError("utf8ToBytes: not a string");
  return enc.encode(s);
}

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

/** Strict: throws on an odd length or a character that is not hexadecimal (either case). */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError("hexToBytes: not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* ── Hashes, canonical JSON and Ed25519 over text ────────── */

export const GENESIS = "0".repeat(64);

/** Canonical JSON (sorted keys, no whitespace): core's canonicalize. */
export const canonical = (value: unknown): string => canonicalize(value);

export const sha256 = (data: Uint8Array): Uint8Array => sealCrypto().sha256(data);

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export interface KeyPair {
  kid: string;
  /** The 32-byte Ed25519 seed. */
  privateKey: Uint8Array;
  publicKeyHex: string;
  /** First 16 hex of SHA-256 over the public key hex. */
  fingerprint: string;
}

/** A key pair from seed text (seed = SHA-256 of the text): deterministic, for test vectors and fixtures. */
export function keyFromSeed(seedText: string, kid: string): KeyPair {
  return keyFromSeedBytes(sha256(utf8ToBytes(seedText)), kid);
}

export function keyFromSeedBytes(seed: Uint8Array, kid: string): KeyPair {
  const publicKeyHex = bytesToHex(sealCrypto().ed25519PublicKey(seed));
  return { kid, privateKey: seed, publicKeyHex, fingerprint: fingerprintOf(publicKeyHex) };
}

export const fingerprintOf = (publicKeyHex: string): string => sha256Hex(publicKeyHex).slice(0, 16);

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): the 32-byte key follows it. */
const ED25519_SPKI = "302a300506032b6570032100";

/**
 * A real chain key's fingerprint, which is its kid: core's keyFingerprint (first 16 hex of SHA-256 over the trimmed
 * PEM) of the SPKI PEM node:crypto writes for the raw key.
 */
export function chainKeyFingerprint(publicKeyHex: string): string {
  return sha256Hex(derToPem(hexToBytes(ED25519_SPKI + publicKeyHex), "PUBLIC KEY").trim()).slice(0, 16);
}

/**
 * The fingerprint the verifier shows and trusts for the key a bundle names `kid`: a real chain key's is its kid, when
 * the kid is that key's chain fingerprint; any other key's is fingerprintOf its hex, as in the console's demo.
 */
export function keyFingerprintOf(kid: string | undefined, publicKeyHex: string): string {
  const chainKey = typeof kid === "string" && /^[0-9a-f]{16}$/.test(kid) && typeof publicKeyHex === "string" && /^[0-9a-fA-F]{64}$/.test(publicKeyHex);
  return chainKey && chainKeyFingerprint(publicKeyHex) === kid ? kid : fingerprintOf(publicKeyHex);
}

export function signBytes(message: Uint8Array, key: Pick<KeyPair, "privateKey">): string {
  return bytesToHex(sealCrypto().ed25519Sign(message, key.privateKey));
}

/** Ed25519 over the UTF-8 bytes of a text message (the convention verifySig checks). */
export function signText(message: string, key: Pick<KeyPair, "privateKey">): string {
  return signBytes(utf8ToBytes(message), key);
}

export function verifyBytes(message: Uint8Array, sigHex: string, publicKeyHex: string): boolean {
  try {
    return sealCrypto().ed25519Verify(hexToBytes(sigHex), message, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/**
 * Verify Ed25519 over the UTF-8 bytes of `message` (usually a hash as hex text). The signature is 64 bytes as hex, or
 * a real chain signature, `ed25519:<base64>`, over the same text. Never throws.
 */
export function verifySig(message: string, sigHex: string, publicKeyHex: string): boolean {
  const sig = typeof sigHex === "string" && sigHex.startsWith("ed25519:") ? signatureHex(sigHex) : sigHex;
  return typeof message === "string" && !!sig && verifyBytes(utf8ToBytes(message), sig, publicKeyHex);
}

/** Random bytes as hex from the platform's secure source. There is no fallback: salts are secrets. */
export function randomHex(bytes = 16): string {
  const b = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.getRandomValues !== "function") throw new Error("randomHex: no secure random source");
  c.getRandomValues(b);
  return bytesToHex(b);
}
