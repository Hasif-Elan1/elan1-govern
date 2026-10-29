import { createHash, randomBytes, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

/**
 * RFC 3161 timestamps: the request a client sends, the checks it makes on the reply, and the
 * offline verification of a stored token. Shared by the local authority (local.ts) and the HTTP
 * one (http.ts), so a token from either is checked by the same code.
 *
 * What is stamped is a SHA-256 digest (a Merkle batch root): it goes into messageImprint as is.
 */

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as never }));

export const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  extKeyUsage: "2.5.29.37",
  timeStamping: "1.3.6.1.5.5.7.3.8",
  rsaEncryption: "1.2.840.113549.1.1.1",
} as const;

/** A timestamp from one authority, as stored on an AnchorBatch (field names follow the console's TimestampToken). */
export interface TimestampToken {
  tsaId: string;
  tsaName: string;
  /** The RFC 3161 TimeStampToken (CMS ContentInfo with SignedData over TSTInfo), DER, base64. */
  der: string;
  /** TSTInfo.genTime, ISO 8601. */
  genTime: string;
  /** TSTInfo.serialNumber, hex. */
  serial: string;
  /** TSTInfo.policy. */
  policyOid: string;
  /** The SHA-256 digest that was stamped (messageImprint), hex: the batch's Merkle root. */
  imprint: string;
  /** The certificates the token carries, PEM, signer first. Trust still comes only from pinned certificates. */
  chain: string[];
}

export interface TimestampAuthority {
  readonly id: string;
  readonly name: string;
  /** Ask for a timestamp over a SHA-256 digest (hex). Resolves only with a token that has been checked. */
  stamp(digestHex: string): Promise<TimestampToken>;
}

/** Why an authority's answer was not accepted. Messages are short fixed phrases: no URLs, hosts or response bodies. */
export class TsaError extends Error {}

export type TokenCheck = { ok: true; genTime: Date; serial: string; signer: string } | { ok: false; error: string };

// ---- encoding helpers ----

const toHex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");
const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const isDigest = (hex: string) => /^[0-9a-f]{64}$/.test(hex);
const NODE_HASH: Record<string, string> = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };

/** Hex digest by WebCrypto algorithm name; throws on any other algorithm. */
function hashHex(webName: string, data: Uint8Array): string {
  const alg = NODE_HASH[webName.toUpperCase()];
  if (!alg) throw new Error("unsupported digest");
  return createHash(alg).update(data).digest("hex");
}

export function pemToDer(pem: string, label = "CERTIFICATE"): Uint8Array[] {
  const out: Uint8Array[] = [];
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  let at = pem.indexOf(begin);
  while (at >= 0) {
    const stop = pem.indexOf(end, at);
    if (stop < 0) break;
    out.push(new Uint8Array(Buffer.from(pem.slice(at + begin.length, stop).replace(/\s+/g, ""), "base64")));
    at = pem.indexOf(begin, stop);
  }
  return out;
}

export function derToPem(der: ArrayBuffer | Uint8Array, label = "CERTIFICATE"): string {
  const b64 = Buffer.from(der instanceof Uint8Array ? der : new Uint8Array(der)).toString("base64");
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${label}-----\n`;
}

export function parseCertificates(pems: string[]): pkijs.Certificate[] {
  return pems.flatMap((p) => pemToDer(p)).map((der) => pkijs.Certificate.fromBER(der));
}

const certDer = (c: pkijs.Certificate) => new Uint8Array(c.toSchema(false).toBER());
const subjectOf = (c: pkijs.Certificate) => c.subject.typesAndValues.map((t) => `${t.type === "2.5.4.3" ? "CN" : t.type}=${t.value.valueBlock.value}`).join(", ");

/** A positive INTEGER of `n` random bytes (high bit clear, never zero). */
export function randomInteger(n: number): asn1js.Integer {
  const b = randomBytes(n);
  b[0] = ((b[0] as number) & 0x7f) | 0x01;
  return new asn1js.Integer({ valueHex: ab(b) });
}

// ---- client side: request and reply ----

export interface TimestampQuery {
  der: Uint8Array;
  nonceHex: string;
  digestHex: string;
}

/** A TimeStampReq over a SHA-256 digest, with a fresh 64-bit nonce and certReq set. */
export function timestampQuery(digestHex: string): TimestampQuery {
  const digest = digestHex.toLowerCase();
  if (!isDigest(digest)) throw new TsaError("the value to timestamp is not a SHA-256 digest");
  const nonce = randomInteger(8);
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: ab(Buffer.from(digest, "hex")) }),
    }),
    nonce,
    certReq: true,
  });
  return { der: new Uint8Array(req.toSchema().toBER()), nonceHex: toHex(nonce.valueBlock.valueHexView), digestHex: digest };
}

/**
 * Accept an authority's TimeStampResp only if: the status is granted, it carries a token, the
 * token's nonce and messageImprint are the ones asked for, and the token verifies (signature, EKU,
 * signing-certificate attribute, chain to a pinned certificate).
 */
export async function acceptReply(reply: Uint8Array, query: TimestampQuery, tsa: { id: string; name: string; trusted: string[] }): Promise<TimestampToken> {
  let resp: pkijs.TimeStampResp;
  let tokenBytes: Uint8Array;
  try {
    const asn = asn1js.fromBER(reply);
    if (asn.offset === -1 || asn.offset !== reply.byteLength || !(asn.result instanceof asn1js.Sequence)) throw new Error();
    resp = new pkijs.TimeStampResp({ schema: asn.result });
    const token = asn.result.valueBlock.value[1];
    tokenBytes = token ? new Uint8Array(token.valueBeforeDecodeView) : new Uint8Array();
  } catch {
    throw new TsaError("the reply is not an RFC 3161 timestamp response");
  }
  if (resp.status.status !== pkijs.PKIStatus.granted) throw new TsaError("the authority did not grant the timestamp");
  if (!resp.timeStampToken || !tokenBytes.byteLength) throw new TsaError("the reply carries no timestamp token");

  const parsed = parseToken(tokenBytes);
  if (!parsed.ok) throw new TsaError(parsed.error);
  const nonce = parsed.tst.nonce ? toHex(parsed.tst.nonce.valueBlock.valueHexView) : "";
  if (nonce !== query.nonceHex) throw new TsaError("the token's nonce is not the one sent");

  const token: TimestampToken = {
    tsaId: tsa.id,
    tsaName: tsa.name,
    der: Buffer.from(tokenBytes).toString("base64"),
    genTime: parsed.tst.genTime.toISOString(),
    serial: toHex(parsed.tst.serialNumber.valueBlock.valueHexView),
    policyOid: parsed.tst.policy,
    imprint: toHex(parsed.tst.messageImprint.hashedMessage.valueBlock.valueHexView),
    chain: parsed.certs.map((c) => derToPem(certDer(c))),
  };
  const check = await verifyTimestampToken(token, query.digestHex, tsa.trusted);
  if (!check.ok) throw new TsaError(check.error);
  return token;
}

// ---- verification ----

type Parsed = { ok: true; signed: pkijs.SignedData; tst: pkijs.TSTInfo; eContent: ArrayBuffer; certs: pkijs.Certificate[] } | { ok: false; error: string };

function parseToken(der: Uint8Array): Parsed {
  try {
    const ci = pkijs.ContentInfo.fromBER(der);
    if (ci.contentType !== OID.signedData) return { ok: false, error: "the token is not CMS signed data" };
    const signed = new pkijs.SignedData({ schema: ci.content });
    if (signed.encapContentInfo.eContentType !== OID.tstInfo || !signed.encapContentInfo.eContent) return { ok: false, error: "the token does not hold a TSTInfo" };
    const eContent = signed.encapContentInfo.eContent.getValue();
    const tst = pkijs.TSTInfo.fromBER(eContent);
    const certs = (signed.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
    return { ok: true, signed, tst, eContent, certs };
  } catch {
    return { ok: false, error: "the token could not be read" };
  }
}

async function findSigner(signerInfo: pkijs.SignerInfo, certs: pkijs.Certificate[]): Promise<pkijs.Certificate | undefined> {
  const sid = signerInfo.sid as pkijs.IssuerAndSerialNumber | asn1js.Primitive | asn1js.Constructed;
  if (sid instanceof pkijs.IssuerAndSerialNumber) return certs.find((c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber));
  // subjectKeyIdentifier [0]: SHA-1 of the public key bits
  const inner = sid.idBlock.isConstructed ? ((sid as asn1js.Constructed).valueBlock.value[0] as asn1js.Primitive) : (sid as asn1js.Primitive);
  const keyId = toHex(inner.valueBlock.valueHexView);
  return certs.find((c) => createHash("sha1").update(c.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).digest("hex") === keyId);
}

/** RFC 3161 §2.3: the signing certificate has exactly one key purpose, id-kp-timeStamping, and the extension is critical. */
function isTimestampingCert(cert: pkijs.Certificate): boolean {
  const eku = (cert.extensions ?? []).filter((e) => e.extnID === OID.extKeyUsage);
  if (eku.length !== 1 || !eku[0]!.critical) return false;
  const purposes = (eku[0]!.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
  return purposes.length === 1 && purposes[0] === OID.timeStamping;
}

/** The ESS signing-certificate attribute (v1 or v2) must name the certificate that signed (RFC 3161 §2.4.2, RFC 5035). */
function signingCertMatches(attrs: pkijs.Attribute[], cert: pkijs.Certificate, crypto: pkijs.ICryptoEngine): boolean {
  const attr = attrs.find((a) => a.type === OID.signingCertificateV2) ?? attrs.find((a) => a.type === OID.signingCertificate);
  if (!attr) return false;
  try {
    const certsSeq = (attr.values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
    const first = (certsSeq.valueBlock.value[0] as asn1js.Sequence).valueBlock.value;
    let alg = attr.type === OID.signingCertificateV2 ? "SHA-256" : "SHA-1";
    let hash = first[0] as asn1js.OctetString;
    if (attr.type === OID.signingCertificateV2 && first[0] instanceof asn1js.Sequence) {
      const algo = crypto.getAlgorithmByOID(new pkijs.AlgorithmIdentifier({ schema: first[0] }).algorithmId);
      if (!("name" in algo)) return false;
      alg = algo.name;
      hash = first[1] as asn1js.OctetString;
    }
    return hashHex(alg, certDer(cert)) === toHex(hash.valueBlock.valueHexView);
  } catch {
    return false;
  }
}

/**
 * Verify a stored timestamp token offline against a digest and pinned certificates (PEM; each may
 * hold several). Checks, in order: the token parses as SignedData over TSTInfo; the imprint is
 * SHA-256 of `digestHex`; the stored fields match the DER; one signer, whose certificate is
 * carried, is a timestamping certificate (critical EKU) and is named by the signing-certificate
 * attribute; the content-type and message-digest attributes are right; the signature verifies;
 * and the signer chains to one of `trustedCerts` at genTime. Revocation is not checked (no CRL or
 * OCSP fetching): pin the CA you trust.
 */
export async function verifyTimestampToken(token: TimestampToken, digestHex: string, trustedCerts: string[]): Promise<TokenCheck> {
  const fail = (error: string): TokenCheck => ({ ok: false, error });
  const digest = digestHex.toLowerCase();
  if (!isDigest(digest)) return fail("the value to check is not a SHA-256 digest");
  const parsed = parseToken(new Uint8Array(Buffer.from(token.der, "base64")));
  if (!parsed.ok) return parsed;
  const { signed, tst, eContent } = parsed;
  const crypto = pkijs.getCrypto(true);

  if (tst.version !== 1) return fail("the TSTInfo version is not 1");
  if (tst.messageImprint.hashAlgorithm.algorithmId !== OID.sha256) return fail("the token's imprint is not SHA-256");
  if (toHex(tst.messageImprint.hashedMessage.valueBlock.valueHexView) !== digest) return fail("the token was issued for a different digest");
  if (token.imprint !== digest || token.genTime !== tst.genTime.toISOString() || token.serial !== toHex(tst.serialNumber.valueBlock.valueHexView) || token.policyOid !== tst.policy) {
    return fail("the token's stored fields do not match its contents");
  }

  if (signed.signerInfos.length !== 1) return fail("the token must have exactly one signer");
  const signerInfo = signed.signerInfos[0]!;
  let extra: pkijs.Certificate[];
  try {
    extra = parseCertificates(token.chain);
  } catch {
    return fail("the token's certificate chain could not be read");
  }
  const seen = new Set<string>();
  const pool = [...parsed.certs, ...extra].filter((c) => {
    const k = toHex(certDer(c));
    return !seen.has(k) && !!seen.add(k);
  });
  const signer = await findSigner(signerInfo, pool);
  if (!signer) return fail("the signing certificate is not in the token");
  if (!isTimestampingCert(signer)) return fail("the signing certificate is not a timestamping certificate");

  const attrs = signerInfo.signedAttrs?.attributes ?? [];
  const ct = attrs.find((a) => a.type === OID.contentType);
  const md = attrs.find((a) => a.type === OID.messageDigest);
  if (!ct || !md || (ct.values[0] as asn1js.ObjectIdentifier).valueBlock.toString() !== OID.tstInfo) return fail("the token's signed attributes are incomplete");
  const hashAlg = crypto.getAlgorithmByOID(signerInfo.digestAlgorithm.algorithmId);
  if (!("name" in hashAlg) || !NODE_HASH[hashAlg.name.toUpperCase()]) return fail("the token uses an unsupported digest");
  if (hashHex(hashAlg.name, new Uint8Array(eContent)) !== toHex((md.values[0] as asn1js.OctetString).valueBlock.valueHexView)) return fail("the token's message digest does not match");
  if (!signingCertMatches(attrs, signer, crypto)) return fail("the signing-certificate attribute does not name the signer");

  let sigOk = false;
  try {
    const rsa = signerInfo.signatureAlgorithm.algorithmId === OID.rsaEncryption;
    sigOk = await crypto.verifyWithPublicKey(signerInfo.signedAttrs!.encodedValue, signerInfo.signature, signer.subjectPublicKeyInfo, signerInfo.signatureAlgorithm, rsa ? hashAlg.name : undefined);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail("the token's signature does not verify");

  let trusted: pkijs.Certificate[];
  try {
    trusted = parseCertificates(trustedCerts);
  } catch {
    return fail("a pinned certificate could not be read");
  }
  if (!trusted.length) return fail("no pinned certificate for this authority");
  const signerDer = toHex(certDer(signer));
  if (trusted.some((c) => toHex(certDer(c)) === signerDer)) {
    // The signing certificate itself is pinned (a local authority's self-signed certificate): it only has to be valid at genTime.
    if (tst.genTime < signer.notBefore.value || tst.genTime > signer.notAfter.value) return fail("the signing certificate was not valid at the token's time");
  } else {
    try {
      const engine = new pkijs.CertificateChainValidationEngine({ trustedCerts: trusted, certs: [...pool.filter((c) => c !== signer), signer], checkDate: tst.genTime });
      if (!(await engine.verify()).result) return fail("the signing certificate does not chain to a pinned certificate");
    } catch {
      return fail("the signing certificate does not chain to a pinned certificate");
    }
  }
  return { ok: true, genTime: tst.genTime, serial: token.serial, signer: subjectOf(signer) };
}
