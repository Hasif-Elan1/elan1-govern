// RFC 3161 timestamp tokens, verified offline: a strict DER reader, the parts of CMS SignedData, TSTInfo and X.509
// a token check needs, and ECDSA P-256 and RSA PKCS #1 v1.5 signature verification in BigInt arithmetic.
//
// One implementation for core's six-code verifier and the console's browser copy (`@gate/core/rfc3161`, its own
// package entry so the console's bundle carries nothing else of core). It is synchronous, has no imports at all and
// never touches node:crypto: the caller passes its hash functions (TsaHashes). Verification only, over public data,
// so nothing here needs constant time. Every input is untrusted: readers return undefined and checks return false or
// a reason on anything malformed; nothing exported throws.

/* ── Base64 and PEM ──────────────────────────────────────── */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 to bytes (whitespace ignored, padding optional); undefined when it is not base64. */
export function base64ToBytes(text: string): Uint8Array | undefined {
  if (typeof text !== "string") return undefined;
  const s = text.replace(/\s+/g, "");
  const body = s.replace(/={1,2}$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(body) || body.length % 4 === 1 || (s.length !== body.length && s.length % 4 !== 0)) return undefined;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of body) {
    value = ((value << 6) | B64.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : B64[c & 63]!;
  }
  return out;
}

/** Every `label` block in a PEM text, as DER; undefined when a block is not base64. */
export function pemToDer(pem: string, label = "CERTIFICATE"): Uint8Array[] | undefined {
  if (typeof pem !== "string") return undefined;
  const out: Uint8Array[] = [];
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  for (let at = pem.indexOf(begin); at >= 0; at = pem.indexOf(begin, at)) {
    const stop = pem.indexOf(end, at);
    if (stop < 0) return undefined;
    const der = base64ToBytes(pem.slice(at + begin.length, stop));
    if (!der) return undefined;
    out.push(der);
    at = stop + end.length;
  }
  return out;
}

/** DER as PEM, the way OpenSSL and node:crypto write it: 64 characters a line and a final newline. */
export function derToPem(der: Uint8Array, label = "CERTIFICATE"): string {
  return `-----BEGIN ${label}-----\n${(bytesToBase64(der).match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;
}

/* ── DER ─────────────────────────────────────────────────── */

/** One DER element. */
export interface DerElement {
  /** The identifier octet: class, constructed bit and a tag number below 31. */
  tag: number;
  /** The whole element, header included. */
  der: Uint8Array;
  /** Its contents. */
  value: Uint8Array;
}

const T = { integer: 0x02, bitString: 0x03, octetString: 0x04, oid: 0x06, utcTime: 0x17, generalizedTime: 0x18, constructedOctetString: 0x24, sequence: 0x30, set: 0x31 } as const;
/** Context-specific tags: [n] constructed (0xa0 + n) and [0] primitive. */
const ctx = (n: number) => 0xa0 + n;
const CTX0_PRIMITIVE = 0x80;

/** The element at `at`: definite lengths in their minimal form only (DER), no high tag numbers. */
function readAt(bytes: Uint8Array, at: number): DerElement | undefined {
  if (at + 2 > bytes.length) return undefined;
  const tag = bytes[at]!;
  if ((tag & 0x1f) === 0x1f) return undefined;
  let len = bytes[at + 1]!;
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    // 0x80 is BER's indefinite length; more than 4 length bytes is never a token
    if (n === 0 || n > 4 || at + 2 + n > bytes.length) return undefined;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[at + 2 + i]!;
    if (len < 0x80 || bytes[at + 2] === 0) return undefined;
    head += n;
  }
  const end = at + head + len;
  if (end > bytes.length) return undefined;
  return { tag, der: bytes.subarray(at, end), value: bytes.subarray(at + head, end) };
}

/** The one DER element `bytes` holds; undefined when it is malformed or anything follows it. */
export function readDer(bytes: Uint8Array): DerElement | undefined {
  if (!(bytes instanceof Uint8Array)) return undefined;
  const el = readAt(bytes, 0);
  return el && el.der.length === bytes.length ? el : undefined;
}

/** The elements inside a constructed element, in order; undefined when they do not exactly fill it. */
export function derChildren(el: DerElement): DerElement[] | undefined {
  if (!(el.tag & 0x20)) return undefined;
  const out: DerElement[] = [];
  for (let at = 0; at < el.value.length; ) {
    const c = readAt(el.value, at);
    if (!c) return undefined;
    out.push(c);
    at += c.der.length;
  }
  return out;
}

/** Thrown inside this module only, by the structure readers below; every exported function catches it. */
class Malformed extends Error {}
const malformed = (): never => {
  throw new Malformed("malformed");
};

/** `e` when it has the tag, else malformed. */
function want(e: DerElement | undefined, tag: number): DerElement {
  return e && e.tag === tag ? e : malformed();
}

/** The children of a constructed element with the tag. */
function kids(e: DerElement | undefined, tag: number): DerElement[] {
  return derChildren(want(e, tag)) ?? malformed();
}

/** An OBJECT IDENTIFIER in dotted form. Arcs are BigInt: the gate's local policies sit under 2.25.<a UUID>. */
function oidOf(e: DerElement | undefined): string {
  const v = want(e, T.oid).value;
  if (!v.length || v[v.length - 1]! & 0x80) malformed();
  const arcs: bigint[] = [];
  let arc = 0n;
  let fresh = true;
  for (const b of v) {
    if (fresh && b === 0x80) malformed(); // a leading 0x80 is not the minimal encoding
    arc = (arc << 7n) | BigInt(b & 0x7f);
    fresh = !(b & 0x80);
    if (fresh) {
      arcs.push(arc);
      arc = 0n;
    }
  }
  const first = arcs[0]!;
  const head = first < 40n ? [0n, first] : first < 80n ? [1n, first - 40n] : [2n, first - 80n];
  return [...head, ...arcs.slice(1)].join(".");
}

/**
 * The same OBJECT IDENTIFIER as asn1js writes it, and so pkijs and the tokens the gate stores: a sub-identifier of up
 * to 8 encoded bytes in decimal, computed in floating point; a longer one as `{hex}` of its 7-bit groups (a first one
 * as `2.{{hex} - 80}`). The gate's local authorities' policies sit under 2.25.<a UUID>, a 17-byte arc, so their
 * tokens' stored policyOid reads `2.25.{…}.1`. Only for comparing with a stored field: `e` is a valid OID (oidOf).
 */
function asn1jsOidOf(e: DerElement): string {
  let out = "";
  let group: number[] = [];
  for (const b of e.value) {
    group.push(b & 0x7f);
    if (b & 0x80) continue;
    const first = out === "";
    if (!first) out += ".";
    if (group.length > 8) out = first ? `2.{{${hexOf(new Uint8Array(group))}} - 80}` : `${out}{${hexOf(new Uint8Array(group))}}`;
    else {
      // pvutils' utilFromBase, exactly: a single group as is, else a sum of doubles
      let dec = group.length === 1 ? group[0]! : 0;
      if (group.length > 1) for (let k = group.length - 1; k >= 0; k--) dec += group[group.length - 1 - k]! * Math.pow(2, 7 * k);
      out += !first ? String(dec) : dec <= 39 ? `0.${dec}` : dec <= 79 ? `1.${dec - 40}` : `2.${dec - 80}`;
    }
    group = [];
  }
  return out;
}

/** The algorithm OID of an AlgorithmIdentifier (its parameters are not read). */
const algorithmOf = (e: DerElement | undefined): string => oidOf(kids(e, T.sequence)[0]);

/** A BIT STRING's bits, which must be whole bytes. */
function bitsOf(e: DerElement | undefined): Uint8Array {
  const v = want(e, T.bitString).value;
  return v.length && v[0] === 0 ? v.subarray(1) : malformed();
}

/** A non-negative INTEGER's contents (a leading 00 sign byte kept). */
function unsignedOf(e: DerElement | undefined): Uint8Array {
  const v = want(e, T.integer).value;
  return v.length && !(v[0]! & 0x80) ? v : malformed();
}

/**
 * An OCTET STRING's octets. CMS content is BER, so an eContent may be a constructed OCTET STRING whose primitive
 * segments are concatenated (pkijs, and so the gate's local authorities, write one); everything else read here is DER.
 */
function octetsOf(e: DerElement | undefined): Uint8Array {
  if (e?.tag === T.octetString) return e.value;
  const parts = kids(e, T.constructedOctetString).map((p) => want(p, T.octetString).value);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ascii = (b: Uint8Array) => String.fromCharCode(...b);

/** UTCTime or GeneralizedTime (UTC, `Z`) as milliseconds; fractions finer than a millisecond are dropped. */
function timeOf({ tag, value }: DerElement): number {
  const utc = tag === T.utcTime;
  const s = ascii(value);
  const m = utc ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
    : tag === T.generalizedTime ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s)
    : null;
  if (!m) return malformed();
  const n = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const year = utc ? (n[0] < 50 ? 2000 : 1900) + n[0] : n[0];
  const ms = Number(((m[7] ?? "") + "000").slice(0, 3));
  const d = new Date(Date.UTC(year, n[1] - 1, n[2], n[3], n[4], n[5], ms));
  // Date.UTC rolls 31 February over into March: a date that does not survive the round trip is not a date
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== n[1] - 1 || d.getUTCDate() !== n[2] || d.getUTCHours() !== n[3] || d.getUTCMinutes() !== n[4] || d.getUTCSeconds() !== n[5]) malformed();
  return d.getTime();
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const bigOf = (b: Uint8Array): bigint => (b.length ? BigInt(`0x${hexOf(b)}`) : 0n);

/** `x` as exactly `len` big-endian bytes (it must fit). */
function bytesOf(x: bigint, len: number): Uint8Array {
  const hex = x.toString(16).padStart(len * 2, "0");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ── Object identifiers ──────────────────────────────────── */

const OID = {
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256Rsa: "1.2.840.113549.1.1.11",
  sha384Rsa: "1.2.840.113549.1.1.12",
  sha512Rsa: "1.2.840.113549.1.1.13",
  subjectKeyIdentifier: "2.5.29.14",
} as const;

/* ── Hashes ──────────────────────────────────────────────── */

/**
 * The hash functions a token check may need, from the caller (node:crypto in core, @noble/hashes in the console).
 * SHA-256 is always needed; a token that needs one the caller did not pass does not verify.
 */
export interface TsaHashes {
  sha256(data: Uint8Array): Uint8Array;
  /** For RSA signatures and message digests over SHA-384 or SHA-512 (hosted authorities). */
  sha384?(data: Uint8Array): Uint8Array;
  sha512?(data: Uint8Array): Uint8Array;
  /** For an ESS signingCertificate (v1) attribute, whose certificate hash is SHA-1, and a signer named by key id on a certificate without one. */
  sha1?(data: Uint8Array): Uint8Array;
}

type HashName = "sha1" | "sha256" | "sha384" | "sha512";
const HASH_BY_OID: Record<string, HashName | undefined> = { [OID.sha1]: "sha1", [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };
const HASH_BYTES: Record<HashName, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };

function hashWith(hashes: TsaHashes, name: HashName | undefined, data: Uint8Array): Uint8Array | undefined {
  const fn = name ? hashes[name] : undefined;
  return fn ? fn(data) : undefined;
}

/* ── ECDSA P-256 ─────────────────────────────────────────── */

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

const mod = (a: bigint, m: bigint = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n;
  let b = mod(base, m);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
  }
  return r;
}

/** The inverse of a non-zero `a` modulo the prime `m` (extended Euclid). */
function inverse(a: bigint, m: bigint): bigint {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}

/** A point in Jacobian coordinates (x/z², y/z³); z = 0 is the point at infinity. */
type Jacobian = readonly [bigint, bigint, bigint];
const INFINITY: Jacobian = [0n, 1n, 0n];

/** Doubling for a = -3 (dbl-2001-b). */
function double([x, y, z]: Jacobian): Jacobian {
  if (z === 0n || y === 0n) return INFINITY;
  const delta = mod(z * z);
  const gamma = mod(y * y);
  const beta = mod(x * gamma);
  const alpha = mod(3n * (x - delta) * (x + delta));
  const x3 = mod(alpha * alpha - 8n * beta);
  return [x3, mod(alpha * (4n * beta - x3) - 8n * gamma * gamma), mod((y + z) * (y + z) - gamma - delta)];
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [x1, y1, z1] = p;
  const [x2, y2, z2] = q;
  const z1z1 = mod(z1 * z1);
  const z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2);
  const u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2);
  const s2 = mod(y2 * z1 * z1z1);
  if (u1 === u2) return s1 === s2 ? double(p) : INFINITY;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const v = mod(u1 * hh);
  const x3 = mod(r * r - hhh - 2n * v);
  return [x3, mod(r * (v - x3) - s1 * hhh), mod(h * z1 * z2)];
}

/** u1·G + u2·Q in one pass over the bits (Shamir's trick). */
function mulAdd(u1: bigint, u2: bigint, q: Jacobian): Jacobian {
  const g: Jacobian = [GX, GY, 1n];
  const gq = add(g, q);
  let r = INFINITY;
  for (let i = 255n; i >= 0n; i--) {
    r = double(r);
    const a = (u1 >> i) & 1n;
    const b = (u2 >> i) & 1n;
    if (a && b) r = add(r, gq);
    else if (a) r = add(r, g);
    else if (b) r = add(r, q);
  }
  return r;
}

const onCurve = (x: bigint, y: bigint) => mod(y * y) === mod(x * x * x - 3n * x + B);

/** A SEC 1 public key (uncompressed or compressed) on P-256; undefined for anything else, the point at infinity included. */
function p256Point(key: Uint8Array): Jacobian | undefined {
  if (key.length === 65 && key[0] === 0x04) {
    const x = bigOf(key.subarray(1, 33));
    const y = bigOf(key.subarray(33));
    return x < P && y < P && onCurve(x, y) ? [x, y, 1n] : undefined;
  }
  if (key.length === 33 && (key[0] === 0x02 || key[0] === 0x03)) {
    const x = bigOf(key.subarray(1));
    if (x >= P) return undefined;
    const rhs = mod(x * x * x - 3n * x + B);
    let y = modPow(rhs, (P + 1n) / 4n, P); // P ≡ 3 (mod 4)
    if (mod(y * y) !== rhs) return undefined;
    if ((y & 1n) !== BigInt(key[0]! & 1)) y = mod(-y);
    return [x, y, 1n];
  }
  return undefined;
}

/** The DER INTEGER in [1, n-1], minimally encoded and not negative. */
function scalarOf(e: DerElement | undefined): bigint | undefined {
  if (!e || e.tag !== T.integer || !e.value.length || e.value.length > 33) return undefined;
  const v = e.value;
  if (v[0]! & 0x80 || (v[0] === 0 && v.length > 1 && !(v[1]! & 0x80))) return undefined;
  const x = bigOf(v);
  return x >= 1n && x < N ? x : undefined;
}

/**
 * ECDSA over P-256: `publicKey` is a SEC 1 point, `digest` the message hash (its leftmost 256 bits are used) and
 * `signature` a DER Ecdsa-Sig-Value. False for anything malformed: r or s outside [1, n-1], a point not on the curve,
 * the point at infinity, trailing bytes.
 */
export function verifyEcdsaP256(publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  try {
    const q = p256Point(publicKey);
    const sig = readDer(signature);
    const rs = sig?.tag === T.sequence ? derChildren(sig) : undefined;
    if (!q || !rs || rs.length !== 2 || !digest.length) return false;
    const r = scalarOf(rs[0]);
    const s = scalarOf(rs[1]);
    if (r === undefined || s === undefined) return false;
    const w = inverse(s, N);
    const [x, , z] = mulAdd(mod(bigOf(digest.subarray(0, 32)) * w, N), mod(r * w, N), q);
    if (z === 0n) return false;
    const zi = inverse(z, P);
    return mod(mod(x * zi * zi), N) === r;
  } catch {
    return false;
  }
}

/* ── RSA PKCS #1 v1.5 ────────────────────────────────────── */

export type RsaHash = "sha256" | "sha384" | "sha512";

/** The DER DigestInfo prefixes (RFC 8017 §9.2 note 1): with the NULL parameters, and the form without them some signers write. */
const DIGEST_INFO: Record<RsaHash, [string, string]> = {
  sha256: ["3031300d060960864801650304020105000420", "302f300b06096086480165030402010420"],
  sha384: ["3041300d060960864801650304020205000430", "303f300b06096086480165030402020430"],
  sha512: ["3051300d060960864801650304020305000440", "304f300b06096086480165030402030440"],
};

const fromHex = (hex: string) => bytesOf(BigInt(`0x${hex}`), hex.length / 2);

/**
 * RSASSA-PKCS1-v1_5 verification (RFC 8017 §8.2.2) by re-encoding: EM = 00 01 FF…FF 00 ‖ DigestInfo(hash, digest).
 * The modulus must be 2048 to 16384 bits and the signature exactly as long as the modulus.
 */
export function verifyRsaPkcs1v15(modulus: Uint8Array, exponent: Uint8Array, hash: RsaHash, digest: Uint8Array, signature: Uint8Array): boolean {
  try {
    const n = bigOf(modulus);
    const e = bigOf(exponent);
    const bits = n.toString(2).length;
    const prefixes = DIGEST_INFO[hash];
    if (!prefixes || bits < 2048 || bits > 16384 || !(n & 1n) || e < 3n || !(e & 1n) || e >= n) return false;
    const k = Math.ceil(bits / 8);
    if (digest.length !== HASH_BYTES[hash] || signature.length !== k) return false;
    const s = bigOf(signature);
    if (s >= n) return false;
    const em = bytesOf(modPow(s, e, n), k);
    return prefixes.some((prefix) => {
      const t = new Uint8Array([...fromHex(prefix), ...digest]);
      const expected = new Uint8Array(k).fill(0xff);
      expected[0] = 0x00;
      expected[1] = 0x01;
      expected[k - t.length - 1] = 0x00;
      expected.set(t, k - t.length);
      return equalBytes(em, expected);
    });
  } catch {
    return false;
  }
}

/* ── X.509 certificates ──────────────────────────────────── */

export type CertificateKey =
  | { kind: "ec-p256"; point: Uint8Array }
  | { kind: "rsa"; modulus: Uint8Array; exponent: Uint8Array }
  | { kind: "other"; algorithm: string };

/** What a token check reads from a certificate. */
export interface CertificateInfo {
  der: Uint8Array;
  /** The issuer Name (DER) and serial number contents: what an IssuerAndSerialNumber names. */
  issuer: Uint8Array;
  serial: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** The subjectKeyIdentifier extension's key id, when the certificate has one. */
  subjectKeyId?: Uint8Array;
  /** The subject public key's bits. */
  publicKeyBits: Uint8Array;
  publicKey: CertificateKey;
}

function keyOf(spki: DerElement | undefined): { bits: Uint8Array; key: CertificateKey } {
  const [alg, bitString] = kids(spki, T.sequence);
  const [algOid, params] = kids(alg, T.sequence);
  const algorithm = oidOf(algOid);
  const bits = bitsOf(bitString);
  if (algorithm === OID.ecPublicKey && params?.tag === T.oid && oidOf(params) === OID.p256) return { bits, key: { kind: "ec-p256", point: bits } };
  if (algorithm === OID.rsaEncryption) {
    const [n, e, ...rest] = kids(readDer(bits), T.sequence);
    if (rest.length) malformed();
    return { bits, key: { kind: "rsa", modulus: unsignedOf(n), exponent: unsignedOf(e) } };
  }
  return { bits, key: { kind: "other", algorithm } };
}

/** The parts of an X.509 certificate (DER) a token check needs; undefined when it is not one. */
export function readCertificate(der: Uint8Array): CertificateInfo | undefined {
  try {
    const parts = kids(readDer(der), T.sequence);
    if (parts.length !== 3) return undefined;
    const tbs = kids(parts[0], T.sequence);
    let i = tbs[0]?.tag === ctx(0) ? 1 : 0; // version
    const serial = want(tbs[i++], T.integer).value;
    want(tbs[i++], T.sequence); // signature algorithm
    const issuer = want(tbs[i++], T.sequence).der;
    const validity = kids(tbs[i++], T.sequence);
    if (validity.length !== 2) return undefined;
    want(tbs[i++], T.sequence); // subject
    const { bits, key } = keyOf(tbs[i++]);
    let subjectKeyId: Uint8Array | undefined;
    for (const e of tbs.slice(i)) {
      if (e.tag !== ctx(3)) continue; // issuer and subject unique ids
      for (const ext of kids(kids(e, ctx(3))[0], T.sequence)) {
        const fields = kids(ext, T.sequence);
        if (oidOf(fields[0]) === OID.subjectKeyIdentifier) subjectKeyId = want(readDer(want(fields[fields.length - 1], T.octetString).value), T.octetString).value;
      }
    }
    return { der, issuer, serial, notBefore: timeOf(validity[0]!), notAfter: timeOf(validity[1]!), subjectKeyId, publicKeyBits: bits, publicKey: key };
  } catch {
    return undefined;
  }
}

/* ── The token: CMS SignedData over a TSTInfo ────────────── */

export interface TokenSigner {
  /** IssuerAndSerialNumber, or a subjectKeyIdentifier. */
  sid: { issuer: Uint8Array; serial: Uint8Array } | { keyId: Uint8Array };
  digestAlgorithm: string;
  /** The signed attributes as their signature covers them: DER, tagged as a SET OF (0x31). */
  signedAttrs?: Uint8Array;
  attributes: { type: string; values: DerElement[] }[];
  signatureAlgorithm: string;
  signature: Uint8Array;
}

/** What an RFC 3161 TimeStampToken holds. */
export interface TimestampTokenInfo {
  /** TSTInfo.policy, dotted decimal. */
  policy: string;
  /** The same OID as asn1js writes it (see asn1jsOidOf): how the gate stores a local authority's policy. */
  policyAsn1js: string;
  /** TSTInfo.messageImprint: its hash algorithm (OID) and the hashed message, hex. */
  imprintAlgorithm: string;
  imprint: string;
  /** TSTInfo.serialNumber, hex as encoded. */
  serial: string;
  /** TSTInfo.genTime, milliseconds since the epoch. */
  genTime: number;
  /** The DER TSTInfo the signer's message digest covers (eContent). */
  tstInfo: Uint8Array;
  /** The certificates the token embeds, DER. */
  certificates: Uint8Array[];
  signers: TokenSigner[];
}

function signerOf(e: DerElement): TokenSigner {
  const f = kids(e, T.sequence);
  want(f[0], T.integer); // version
  const sidEl = f[1] ?? malformed();
  let sid: TokenSigner["sid"];
  if (sidEl.tag === T.sequence) {
    const [issuer, serial, ...rest] = kids(sidEl, T.sequence);
    if (rest.length) malformed();
    sid = { issuer: want(issuer, T.sequence).der, serial: want(serial, T.integer).value };
  } else sid = { keyId: want(sidEl, CTX0_PRIMITIVE).value };
  const digestAlgorithm = algorithmOf(f[2]);
  let i = 3;
  let signedAttrs: Uint8Array | undefined;
  const attributes: TokenSigner["attributes"] = [];
  if (f[i]?.tag === ctx(0)) {
    const el = f[i++]!;
    for (const a of kids(el, ctx(0))) {
      const [type, values, ...rest] = kids(a, T.sequence);
      if (rest.length) malformed();
      attributes.push({ type: oidOf(type), values: kids(values, T.set) });
    }
    signedAttrs = el.der.slice();
    signedAttrs[0] = T.set;
  }
  const signatureAlgorithm = algorithmOf(f[i++]);
  const signature = want(f[i++], T.octetString).value;
  if (f[i]?.tag === ctx(1)) i++; // unsigned attributes
  if (i !== f.length) malformed();
  return { sid, digestAlgorithm, ...(signedAttrs ? { signedAttrs } : {}), attributes, signatureAlgorithm, signature };
}

/**
 * Read an RFC 3161 TimeStampToken: a CMS ContentInfo with SignedData whose content is a TSTInfo (version 1).
 * Undefined when it is anything else or is malformed.
 */
export function readTimestampToken(der: Uint8Array): TimestampTokenInfo | undefined {
  try {
    const [type, content, ...more] = kids(readDer(der), T.sequence);
    if (more.length || oidOf(type) !== OID.signedData) return undefined;
    const [signedEl, ...after] = kids(content, ctx(0));
    if (after.length) return undefined;
    const sd = kids(signedEl, T.sequence);
    want(sd[0], T.integer);
    want(sd[1], T.set);
    const [eType, eWrap, ...eMore] = kids(sd[2], T.sequence);
    if (eMore.length || oidOf(eType) !== OID.tstInfo) return undefined;
    const [eContent, ...eAfter] = kids(eWrap, ctx(0));
    if (eAfter.length) return undefined;
    const tstInfo = octetsOf(eContent);
    let i = 3;
    const certificates: Uint8Array[] = [];
    if (sd[i]?.tag === ctx(0)) for (const c of kids(sd[i++], ctx(0))) if (c.tag === T.sequence) certificates.push(c.der);
    if (sd[i]?.tag === ctx(1)) i++; // revocation information
    const signers = kids(sd[i++], T.set).map(signerOf);
    if (i !== sd.length) return undefined;

    const tst = kids(readDer(tstInfo), T.sequence);
    const version = want(tst[0], T.integer).value;
    if (version.length !== 1 || version[0] !== 1) return undefined;
    const [imprintAlg, hashed, ...imprintMore] = kids(tst[2], T.sequence);
    if (imprintMore.length) return undefined;
    return {
      policy: oidOf(tst[1]),
      policyAsn1js: asn1jsOidOf(tst[1]!),
      imprintAlgorithm: algorithmOf(imprintAlg),
      imprint: hexOf(want(hashed, T.octetString).value),
      serial: hexOf(want(tst[3], T.integer).value),
      genTime: timeOf(want(tst[4], T.generalizedTime)),
      tstInfo,
      certificates,
      signers,
    };
  } catch {
    return undefined;
  }
}

/* ── Verification ────────────────────────────────────────── */

/** The fields of a stored token the check compares with its DER (the console's TimestampToken). */
export interface TimestampTokenFields {
  /** The TimeStampToken, DER, base64. */
  der: string;
  imprint: string;
  genTime: string;
  serial: string;
  policyOid: string;
}

export type TimestampCheck = { ok: true } | { ok: false; error: string };

/** Run a structure reader as a check: malformed is false. */
function holds(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

/** Does the signer identifier name this certificate? */
function names(signer: TokenSigner, cert: CertificateInfo, hashes: TsaHashes): boolean {
  if ("issuer" in signer.sid) return equalBytes(signer.sid.issuer, cert.issuer) && equalBytes(signer.sid.serial, cert.serial);
  const keyId = cert.subjectKeyId ?? hashWith(hashes, "sha1", cert.publicKeyBits);
  return !!keyId && equalBytes(keyId, signer.sid.keyId);
}

/** An ESS signingCertificate (v1, SHA-1) or signingCertificateV2 attribute: its first certificate hash must be the certificate's. */
function essNames(attr: TokenSigner["attributes"][number], certDer: Uint8Array, hashes: TsaHashes): boolean {
  return holds(() => essHash(attr, certDer, hashes));
}

function essHash(attr: TokenSigner["attributes"][number], certDer: Uint8Array, hashes: TsaHashes): boolean {
  if (attr.values.length !== 1) return false;
  const first = kids(kids(attr.values[0], T.sequence)[0], T.sequence)[0];
  const id = kids(first, T.sequence);
  let name: HashName | undefined = "sha1";
  let at = 0;
  if (attr.type === OID.signingCertificateV2) {
    name = "sha256"; // ESSCertIDv2's default
    if (id[0]?.tag === T.sequence) {
      name = HASH_BY_OID[algorithmOf(id[0])];
      at = 1;
    }
  }
  const hash = hashWith(hashes, name, certDer);
  return !!hash && equalBytes(hash, want(id[at], T.octetString).value);
}

/** RSA signature algorithms: shaNWithRSAEncryption names its hash; plain rsaEncryption takes the signer's digest algorithm's. */
const RSA_HASH_BY_ALGORITHM: Record<string, RsaHash | undefined> = { [OID.sha256Rsa]: "sha256", [OID.sha384Rsa]: "sha384", [OID.sha512Rsa]: "sha512" };
const RSA_HASH_BY_DIGEST: Record<string, RsaHash | undefined> = { [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };

/** The signature over the signed attributes, with the certificate's key: ECDSA P-256 with SHA-256, or RSA PKCS #1 v1.5 with SHA-2. */
function signatureOk(signer: TokenSigner, key: CertificateKey, signed: Uint8Array, hashes: TsaHashes): boolean {
  if (signer.signatureAlgorithm === OID.ecdsaSha256) return key.kind === "ec-p256" && verifyEcdsaP256(key.point, hashes.sha256(signed), signer.signature);
  const name = signer.signatureAlgorithm === OID.rsaEncryption ? RSA_HASH_BY_DIGEST[signer.digestAlgorithm] : RSA_HASH_BY_ALGORITHM[signer.signatureAlgorithm];
  const digest = hashWith(hashes, name, signed);
  return key.kind === "rsa" && !!name && !!digest && verifyRsaPkcs1v15(key.modulus, key.exponent, name, digest, signer.signature);
}

/** Hex serial numbers compared as numbers written in hex: case and leading zeros do not matter. */
const sameSerial = (a: unknown, b: string) => typeof a === "string" && /^[0-9a-f]+$/i.test(a) && a.toLowerCase().replace(/^0+/, "") === b.replace(/^0+/, "");

function check(token: TimestampTokenFields, root: string, certPem: string | undefined, hashes: TsaHashes): TimestampCheck {
  const no = (error: string): TimestampCheck => ({ ok: false, error });
  const bytes = base64ToBytes(token.der);
  const info = bytes ? readTimestampToken(bytes) : undefined;
  if (!info) return no("the token is not an RFC 3161 timestamp token");
  if (info.imprintAlgorithm !== OID.sha256) return no("the token's imprint is not SHA-256");
  if (typeof root !== "string" || info.imprint !== root || token.imprint !== root) return no("the token was issued for a different digest");
  const policyOk = token.policyOid === info.policy || token.policyOid === info.policyAsn1js;
  if (!policyOk || !sameSerial(token.serial, info.serial) || Date.parse(token.genTime) !== info.genTime) return no("the token's stored fields do not match its contents");
  if (info.signers.length !== 1) return no("the token must have exactly one signer");
  const signer = info.signers[0]!;

  const certDer = typeof certPem === "string" ? pemToDer(certPem)?.[0] : undefined;
  const cert = certDer ? readCertificate(certDer) : undefined;
  if (!cert) return no("the authority's certificate could not be read");
  if (!names(signer, cert, hashes)) return no("the token is signed by another certificate than the authority's");
  for (const der of info.certificates) {
    const carried = readCertificate(der);
    if (carried && names(signer, carried, hashes) && !equalBytes(der, cert.der)) return no("the certificate the token carries is not the authority's");
  }
  if (info.genTime < cert.notBefore || info.genTime > cert.notAfter) return no("the authority's certificate was not valid at the token's time");

  if (!signer.signedAttrs) return no("the token has no signed attributes");
  const types = signer.attributes.map((a) => a.type);
  if (new Set(types).size !== types.length) return no("the token's signed attributes repeat a type");
  const attr = (type: string) => signer.attributes.find((a) => a.type === type);
  const ct = attr(OID.contentType);
  if (!ct || ct.values.length !== 1 || !holds(() => oidOf(ct.values[0]) === OID.tstInfo)) return no("the token's content-type attribute is not TSTInfo");
  const digestName = HASH_BY_OID[signer.digestAlgorithm];
  const digest = digestName === "sha1" ? undefined : hashWith(hashes, digestName, info.tstInfo);
  if (!digest) return no("the token uses an unsupported digest");
  const md = attr(OID.messageDigest);
  if (!md || md.values.length !== 1 || md.values[0]!.tag !== T.octetString || !equalBytes(md.values[0]!.value, digest)) return no("the token's message digest does not match");
  for (const ess of [attr(OID.signingCertificate), attr(OID.signingCertificateV2)]) {
    if (ess && !essNames(ess, cert.der, hashes)) return no("the signing-certificate attribute does not name the authority's certificate");
  }
  if (!signatureOk(signer, cert.publicKey, signer.signedAttrs, hashes)) return no("the token's signature does not verify");
  return { ok: true };
}

/**
 * Verify a real authority's RFC 3161 token over a batch root, offline, against the authority's certificate (PEM; the
 * first certificate in it). Checks: the DER is a TimeStampToken (SignedData over a version 1 TSTInfo); its imprint is
 * SHA-256 and is `root`, as is the stored imprint; the stored policy, serial and genTime are the TSTInfo's; exactly one
 * signer, named by the authority's certificate (issuer and serial, or key id), and any certificate the token embeds
 * under that name is the authority's, byte for byte; genTime falls in the certificate's validity; the signed
 * attributes carry the TSTInfo content type and its message digest, each once, and an ESS signing-certificate
 * attribute (v1 or v2), when there is one, hashes to the certificate; and the signature over the signed attributes
 * verifies with the certificate's key (ECDSA P-256 with SHA-256, or RSA PKCS #1 v1.5 with SHA-256/384/512). There is
 * no chain building and no revocation check: the certificate is the trust anchor. Never throws.
 */
export function verifyTimestampToken(token: TimestampTokenFields, root: string, certPem: string | undefined, hashes: TsaHashes): TimestampCheck {
  try {
    return check(token, root, certPem, hashes);
  } catch {
    return { ok: false, error: "the token could not be read" };
  }
}
