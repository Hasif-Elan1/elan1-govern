// A small DER writer and RFC 3161 token and X.509 certificate builder, signed with node:crypto, for testing the pure
// TypeScript verifier (src/seal/rfc3161.ts) on every shape a token can take: each option bends one part of a real
// token. Test code only: it trusts its inputs and never checks what it writes.
import { createHash, sign, type KeyObject } from "node:crypto";

export const OIDS = {
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  data: "1.2.840.113549.1.7.1",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256Rsa: "1.2.840.113549.1.1.11",
  sha384Rsa: "1.2.840.113549.1.1.12",
  sha512Rsa: "1.2.840.113549.1.1.13",
  rsaPss: "1.2.840.113549.1.1.10",
  commonName: "2.5.4.3",
  subjectKeyIdentifier: "2.5.29.14",
  extKeyUsage: "2.5.29.37",
  timeStamping: "1.3.6.1.5.5.7.3.8",
} as const;

const u8 = (b: Uint8Array | number[]) => (b instanceof Uint8Array ? b : new Uint8Array(b));
export const concat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(Buffer.concat(parts.map((p) => u8(p))));
const lengthOf = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);

export const tlv = (tag: number, ...parts: (Uint8Array | number[])[]) => {
  const body = concat(...parts);
  return concat([tag, ...lengthOf(body.length)], body);
};
export const seq = (...p: (Uint8Array | number[])[]) => tlv(0x30, ...p);
export const set = (...p: (Uint8Array | number[])[]) => tlv(0x31, ...p);
export const ctx = (n: number, ...p: (Uint8Array | number[])[]) => tlv(0xa0 + n, ...p);
export const octets = (b: Uint8Array | number[]) => tlv(0x04, b);
export const nul = () => tlv(0x05);
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
export const bits = (b: Uint8Array | number[]) => tlv(0x03, [0], b);
export const bool = (v: boolean) => tlv(0x01, [v ? 0xff : 0]);

/** A non-negative INTEGER, minimally encoded. */
export function int(v: bigint | number): Uint8Array {
  let hex = BigInt(v).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (parseInt(hex[0]!, 16) >= 8) hex = `00${hex}`;
  return tlv(0x02, Buffer.from(hex, "hex"));
}

/** An OBJECT IDENTIFIER from dotted decimal (arcs of any size). */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(BigInt);
  const subs = [arcs[0]! * 40n + arcs[1]!, ...arcs.slice(2)];
  const out: number[] = [];
  for (const s of subs) {
    const groups: number[] = [];
    let x = s;
    do {
      groups.unshift(Number(x & 0x7fn));
      x >>= 7n;
    } while (x > 0n);
    groups.forEach((g, i) => out.push(i < groups.length - 1 ? g | 0x80 : g));
  }
  return tlv(0x06, out);
}

export const alg = (o: string, params?: Uint8Array) => seq(oid(o), ...(params ? [params] : []));

const two = (n: number) => String(n).padStart(2, "0");
/** GeneralizedTime, with the milliseconds when there are any (as pkijs writes it). */
export function gtime(ms: number, fraction = true): Uint8Array {
  const d = new Date(ms);
  const base = `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
  return tlv(0x18, Buffer.from(`${base}${fraction && d.getUTCMilliseconds() ? `.${String(d.getUTCMilliseconds()).padStart(3, "0")}` : ""}Z`));
}
export function utime(ms: number): Uint8Array {
  const d = new Date(ms);
  return tlv(0x17, Buffer.from(`${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`));
}

const HASH: Record<string, string> = { [OIDS.sha1]: "sha1", [OIDS.sha256]: "sha256", [OIDS.sha384]: "sha384", [OIDS.sha512]: "sha512" };
export const digest = (name: string, data: Uint8Array) => new Uint8Array(createHash(name).update(data).digest());
export const toPem = (der: Uint8Array, label = "CERTIFICATE") => `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/* ── Certificates ────────────────────────────────────────── */

export interface Forged {
  der: Uint8Array;
  pem: string;
  /** the issuer Name, DER */
  name: Uint8Array;
  serial: bigint;
  /** the subjectKeyIdentifier written into it (or that would be, when `ski: false`) */
  ski: Uint8Array;
}

export interface CertOptions {
  publicKey: KeyObject;
  /** signs the certificate itself (the verifier never checks this signature) */
  signer: KeyObject;
  cn?: string;
  serial?: bigint;
  notBefore?: number;
  notAfter?: number;
  /** write the subjectKeyIdentifier extension (default true) */
  ski?: boolean;
  /** omit the version and the extensions: a v1 certificate */
  v1?: boolean;
  /** use GeneralizedTime for the validity */
  generalized?: boolean;
  /** replace the SubjectPublicKeyInfo */
  spki?: Uint8Array;
  /** add issuer and subject unique ids */
  uniqueIds?: boolean;
}

export function makeCert(o: CertOptions): Forged {
  const name = seq(set(seq(oid(OIDS.commonName), utf8(o.cn ?? "Forged TSA"))));
  const serial = o.serial ?? 0x1234567890abcdefn;
  const spki = o.spki ?? new Uint8Array(o.publicKey.export({ type: "spki", format: "der" }));
  // the key id is SHA-1 of the subject public key bits: an EC point, or an RSA key's RSAPublicKey
  const keyBits = o.spki ?? (o.publicKey.asymmetricKeyType === "rsa" ? new Uint8Array(o.publicKey.export({ type: "pkcs1", format: "der" })) : spki.subarray(spki.length - 65));
  const ski = digest("sha1", keyBits);
  const time = o.generalized ? gtime : utime;
  const validity = seq(time(o.notBefore ?? Date.parse("2026-01-01T00:00:00Z")), time(o.notAfter ?? Date.parse("2036-01-01T00:00:00Z")));
  const ec = o.signer.asymmetricKeyType === "ec";
  const sigAlg = alg(ec ? OIDS.ecdsaSha256 : OIDS.sha256Rsa, ec ? undefined : nul());
  const ext = (id: string, critical: boolean, value: Uint8Array) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
  const extensions = ctx(3, seq(ext(OIDS.extKeyUsage, true, seq(oid(OIDS.timeStamping))), ...(o.ski === false ? [] : [ext(OIDS.subjectKeyIdentifier, false, octets(ski))])));
  const tbs = seq(
    ...(o.v1 ? [] : [ctx(0, int(2))]), int(serial), sigAlg, name, validity, name, spki,
    ...(o.uniqueIds ? [tlv(0x81, [0, 1, 2]), tlv(0x82, [0, 3, 4])] : []), ...(o.v1 ? [] : [extensions]),
  );
  const der = seq(tbs, sigAlg, bits(new Uint8Array(sign("sha256", tbs, o.signer))));
  return { der, pem: toPem(der), name, serial, ski };
}

/* ── Tokens ──────────────────────────────────────────────── */

export interface TokenOptions {
  /** the batch root (hex) the token stamps */
  root: string;
  cert: Forged;
  key: KeyObject;
  policy?: string;
  /** the policy OID's contents, hex, instead of `policy` */
  policyHex?: string;
  serial?: bigint;
  genTime?: number;
  /** GeneralizedTime with milliseconds (default true) */
  fraction?: boolean;
  tstVersion?: number;
  imprintAlgorithm?: string;
  /** the SignerInfo's digest algorithm (messageDigest, and the RSA hash under rsaEncryption) */
  digestAlgorithm?: string;
  /** the SignerInfo's signature algorithm (default ecdsa-with-SHA256 or rsaEncryption by key) */
  signatureAlgorithm?: string;
  /** the hash node:crypto signs with (default by algorithm) */
  signHash?: string;
  ess?: "v1" | "v2" | "v2-sha512" | "v2-unknown" | "v2-wrong" | "v2-two-values" | "v2-empty" | "both" | "none";
  sid?: "issuerSerial" | "ski" | "other-serial";
  /** certificates embedded in the SignedData (DER); `[]` writes an empty set */
  certs?: Uint8Array[];
  /** non-certificate entries in the certificates set (an attribute certificate's [1]) */
  otherCerts?: boolean;
  crls?: boolean;
  unsignedAttrs?: boolean;
  signers?: 0 | 1 | 2;
  /** change the signed attributes before signing */
  attrs?: (attrs: Uint8Array[]) => Uint8Array[];
  /** leave the signed attributes out */
  noSignedAttrs?: boolean;
  contentType?: string;
  eContentType?: string;
  /** write eContent as a constructed OCTET STRING in this many segments (pkijs writes one) */
  segments?: number;
  /** bytes appended inside the ContentInfo */
  trailing?: Uint8Array;
  /** an element appended after the signer infos */
  extraAfterSigners?: boolean;
  /** an accuracy, nonce, tsa name and extensions in the TSTInfo */
  extras?: boolean;
  /** change the signature after signing */
  tamper?: (sig: Uint8Array) => Uint8Array;
}

export interface ForgedToken {
  der: Uint8Array;
  /** the stored fields, as the gate writes them */
  fields: { der: string; imprint: string; genTime: string; serial: string; policyOid: string };
}

export function makeToken(o: TokenOptions): ForgedToken {
  const ec = o.key.asymmetricKeyType === "ec";
  const policy = o.policy ?? "1.2.3.4.1";
  const serial = o.serial ?? 0xabcdef0123n;
  const genTime = o.genTime ?? Date.parse("2026-10-29T10:00:00.250Z");
  const digestAlgorithm = o.digestAlgorithm ?? OIDS.sha256;
  const signatureAlgorithm = o.signatureAlgorithm ?? (ec ? OIDS.ecdsaSha256 : OIDS.rsaEncryption);
  const policyEl = o.policyHex ? tlv(0x06, Buffer.from(o.policyHex, "hex")) : oid(policy);
  const tst = seq(
    int(o.tstVersion ?? 1), policyEl, seq(alg(o.imprintAlgorithm ?? OIDS.sha256, nul()), octets(Buffer.from(o.root, "hex"))), int(serial), gtime(genTime, o.fraction ?? true),
    ...(o.extras ? [seq(int(1)), int(0x0102030405060708n), ctx(0, ctx(4, seq(set(seq(oid(OIDS.commonName), utf8("TSA")))))), ctx(1, seq())] : []),
  );
  const segments = o.segments ?? 0;
  const eContent = segments ? tlv(0x24, ...Array.from({ length: segments }, (_, i) => octets(tst.subarray(Math.floor((i * tst.length) / segments), Math.floor(((i + 1) * tst.length) / segments))))) : octets(tst);

  const certHash = (name: string) => digest(name, o.cert.der);
  const essV2 = (inner: Uint8Array) => seq(oid(OIDS.signingCertificateV2), set(seq(seq(inner))));
  const essAttrs: Record<NonNullable<TokenOptions["ess"]>, Uint8Array[]> = {
    none: [],
    v1: [seq(oid(OIDS.signingCertificate), set(seq(seq(seq(octets(certHash("sha1")))))))],
    v2: [essV2(seq(octets(certHash("sha256"))))],
    "v2-sha512": [essV2(seq(alg(OIDS.sha512), octets(certHash("sha512"))))],
    "v2-unknown": [essV2(seq(alg("1.2.3.99"), octets(certHash("sha256"))))],
    "v2-wrong": [essV2(seq(octets(new Uint8Array(32))))],
    "v2-two-values": [seq(oid(OIDS.signingCertificateV2), set(seq(seq(seq(octets(certHash("sha256"))))), seq(seq(seq(octets(certHash("sha256")))))))],
    "v2-empty": [seq(oid(OIDS.signingCertificateV2), set(seq(seq())))],
    both: [seq(oid(OIDS.signingCertificate), set(seq(seq(seq(octets(certHash("sha1"))))))), essV2(seq(octets(certHash("sha256"))))],
  };
  let attrs = [
    seq(oid(OIDS.contentType), set(oid(o.contentType ?? OIDS.tstInfo))),
    seq(oid(OIDS.messageDigest), set(octets(digest(HASH[digestAlgorithm] ?? "sha256", tst)))),
    ...essAttrs[o.ess ?? "v2"],
  ];
  if (o.attrs) attrs = o.attrs(attrs);
  const signedSet = set(...attrs);
  const hash = o.signHash ?? (signatureAlgorithm === OIDS.sha384Rsa ? "sha384" : signatureAlgorithm === OIDS.sha512Rsa ? "sha512" : signatureAlgorithm === OIDS.rsaEncryption ? HASH[digestAlgorithm] ?? "sha256" : "sha256");
  let sig: Uint8Array = new Uint8Array(sign(hash, o.noSignedAttrs ? tst : signedSet, o.key));
  if (o.tamper) sig = o.tamper(sig);
  const sid = o.sid === "ski" ? tlv(0x80, o.cert.ski) : seq(o.cert.name, int(o.sid === "other-serial" ? o.cert.serial + 1n : o.cert.serial));
  const signerInfo = seq(
    int(o.sid === "ski" ? 3 : 1), sid, alg(digestAlgorithm, nul()), ...(o.noSignedAttrs ? [] : [ctx(0, ...attrs)]), alg(signatureAlgorithm, ec ? undefined : nul()), octets(sig),
    ...(o.unsignedAttrs ? [ctx(1, seq(oid(OIDS.signingTime), set(utime(genTime))))] : []),
  );
  const signers = o.signers ?? 1;
  const signedData = seq(
    int(3), set(alg(digestAlgorithm, nul())), seq(oid(o.eContentType ?? OIDS.tstInfo), ctx(0, eContent)),
    ...(o.certs || o.otherCerts ? [ctx(0, ...(o.certs ?? []), ...(o.otherCerts ? [ctx(1, seq(int(1)))] : []))] : []),
    ...(o.crls ? [ctx(1, seq())] : []),
    set(...Array.from({ length: signers }, () => signerInfo)),
    ...(o.extraAfterSigners ? [int(0)] : []),
  );
  const der = seq(oid(OIDS.signedData), ctx(0, signedData), ...(o.trailing ? [o.trailing] : []));
  return {
    der,
    fields: { der: Buffer.from(der).toString("base64"), imprint: o.root, genTime: new Date(genTime).toISOString(), serial: serial.toString(16).padStart(2, "0"), policyOid: policy },
  };
}
