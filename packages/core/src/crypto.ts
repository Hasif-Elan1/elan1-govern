import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from "node:crypto";
import { canonicalize } from "./canonical";

export const HASH_PREFIX = "sha256:";
export const SIG_PREFIX = "ed25519:";
export const GENESIS_HASH = `${HASH_PREFIX}${"0".repeat(64)}`;

export function sha256(data: string | Uint8Array): string {
  return HASH_PREFIX + createHash("sha256").update(data).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256(canonicalize(value));
}

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }).toString();
}

export function signText(privateKeyPem: string, text: string): string {
  const sig = edSign(null, Buffer.from(text, "utf8"), createPrivateKey(privateKeyPem));
  return SIG_PREFIX + sig.toString("base64");
}

/** Never throws: a malformed key or signature simply fails verification. */
export function verifyText(publicKeyPem: string, text: string, signature: string): boolean {
  if (typeof signature !== "string" || !signature.startsWith(SIG_PREFIX)) return false;
  try {
    const sig = Buffer.from(signature.slice(SIG_PREFIX.length), "base64");
    if (sig.length !== 64) return false;
    return edVerify(null, Buffer.from(text, "utf8"), createPublicKey(publicKeyPem), sig);
  } catch {
    return false;
  }
}

/** A short, stable id for a public key, shown in the UI and in bundles. */
export function keyFingerprint(publicKeyPem: string): string {
  return sha256(publicKeyPem.trim()).slice(HASH_PREFIX.length, HASH_PREFIX.length + 16);
}

// ---- Symmetric encryption (AES-256-GCM) for OAuth tokens and org keys at rest ----

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error("encryption key must be 32 bytes of hex");
  return Buffer.from(keyHex, "hex");
}

export function encrypt(keyHex: string, plaintext: string, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseKey(keyHex), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decrypt(keyHex: string, payload: string, aad = ""): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("bad ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", parseKey(keyHex), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// ---- Tokens: 256-bit random values, stored only as hashes ----

export function randomToken(prefix = ""): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ---- HMAC-signed short tokens (approval links, OAuth state) ----

export function hmacSign(secretHex: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(canonicalize(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", parseKey(secretHex)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function hmacVerify<T = Record<string, unknown>>(secretHex: string, token: string): T | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", parseKey(secretHex)).update(body).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
