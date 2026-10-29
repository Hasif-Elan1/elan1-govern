import { createHash, webcrypto } from "node:crypto";
import type { Db } from "@gate/db";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { KeyProvider } from "../keys";
import { acceptReply, derToPem, OID, pemToDer, randomInteger, timestampQuery, type TimestampAuthority, type TimestampToken } from "./token";

/**
 * A real RFC 3161 timestamp authority inside Elan1 Govern, so timestamping works with no network
 * (development, tests, air-gapped and Sovereign installs). Each authority id has its own ECDSA
 * P-256 key and self-signed certificate (EKU id-kp-timeStamping, critical), made on first use and
 * kept in TsaKey with the private key wrapped by the KeyProvider. Two ids ("local-a", "local-b")
 * give two independent authorities, so the two-timestamp rule holds offline. Their certificates
 * are the trust anchors for their tokens.
 *
 * `respond` is the authority (TimeStampReq in, TimeStampResp out); `stamp` is a client of it that
 * makes the same checks as for a remote authority.
 */

const subtle = webcrypto.subtle;
const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
/** KeyProvider context for TSA keys. Org ids are cuids (no colon), so this never collides with an org's key. */
const keyCtx = (id: string) => ({ orgId: "platform:tsa", kid: id });
const CERT_YEARS = 10;

/** PKIFailureInfo bits (RFC 3161 §2.4.2). */
const FAIL = { badAlg: 0, badRequest: 2, badDataFormat: 5, unacceptedPolicy: 15, unacceptedExtension: 16, systemFailure: 25 } as const;

type Loaded = { cert: pkijs.Certificate; certPem: string; key: webcrypto.CryptoKey };

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function name(cn: string) {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({ type: "2.5.4.10", value: new asn1js.Utf8String({ value: "Elan1 Govern" }) }),
      new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: cn }) }),
    ],
  });
}

/** A self-signed timestamping certificate for a new P-256 key. */
async function makeCertificate(cn: string, keys: webcrypto.CryptoKeyPair): Promise<pkijs.Certificate> {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = randomInteger(16);
  cert.issuer = name(cn);
  cert.subject = name(cn);
  const now = Date.now();
  cert.notBefore.value = new Date(now - 60_000);
  cert.notAfter.value = new Date(now + CERT_YEARS * 365 * 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey as never);
  const ski = createHash("sha1").update(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).digest();
  cert.extensions = [
    new pkijs.Extension({ extnID: "2.5.29.19", critical: true, extnValue: new pkijs.BasicConstraints({ cA: false }).toSchema().toBER(false) }),
    // keyUsage: digitalSignature and nonRepudiation (two named bits, six unused)
    new pkijs.Extension({ extnID: "2.5.29.15", critical: true, extnValue: new asn1js.BitString({ valueHex: ab(new Uint8Array([0xc0])), unusedBits: 6 }).toBER(false) }),
    new pkijs.Extension({ extnID: OID.extKeyUsage, critical: true, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: [OID.timeStamping] }).toSchema().toBER(false) }),
    new pkijs.Extension({ extnID: "2.5.29.14", extnValue: new asn1js.OctetString({ valueHex: ab(ski) }).toBER(false) }),
  ];
  await cert.sign(keys.privateKey as never, "SHA-256");
  return cert;
}

function rejection(bit: number): Uint8Array {
  const bytes = new Uint8Array((bit >> 3) + 1);
  bytes[bit >> 3] = 0x80 >> (bit & 7);
  const status = new pkijs.PKIStatusInfo({ status: pkijs.PKIStatus.rejection, failInfo: new asn1js.BitString({ valueHex: ab(bytes), unusedBits: 7 - (bit & 7) }) });
  return new Uint8Array(new pkijs.TimeStampResp({ status }).toSchema().toBER());
}

export class LocalTsa implements TimestampAuthority {
  private loaded?: Promise<Loaded>;

  constructor(
    private readonly store: { db: Db; keys: KeyProvider },
    readonly id: string,
    readonly name: string,
    readonly policyOid: string,
  ) {}

  /** This authority's certificate (PEM): the trust anchor for its tokens. Made on first use. */
  async certificatePem(): Promise<string> {
    return (await this.load()).certPem;
  }

  private load(): Promise<Loaded> {
    this.loaded ??= this.loadOrCreate().catch((e: unknown) => {
      this.loaded = undefined; // try again next time (the database may have been down)
      throw e;
    });
    return this.loaded;
  }

  private async loadOrCreate(): Promise<Loaded> {
    const row = (await this.store.db.tsaKey.findUnique({ where: { id: this.id } })) ?? (await this.create());
    const pem = await this.store.keys.unwrap(row.privateKeyEnc, keyCtx(this.id));
    const pkcs8 = pemToDer(pem, "PRIVATE KEY")[0];
    if (!pkcs8) throw new Error(`timestamp authority ${this.id}: stored key is not a PKCS#8 PEM`);
    const key = await subtle.importKey("pkcs8", pkcs8, EC, false, ["sign"]);
    const der = pemToDer(row.certPem)[0];
    if (!der) throw new Error(`timestamp authority ${this.id}: stored certificate is not a PEM`);
    return { cert: pkijs.Certificate.fromBER(der), certPem: row.certPem, key };
  }

  private async create() {
    const keys = await subtle.generateKey(EC, true, ["sign", "verify"]);
    const cert = await makeCertificate(this.name, keys);
    const certPem = derToPem(cert.toSchema(true).toBER());
    const keyPem = derToPem(await subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE KEY");
    const privateKeyEnc = await this.store.keys.wrap(keyPem, keyCtx(this.id));
    try {
      return await this.store.db.tsaKey.create({ data: { id: this.id, name: this.name, certPem, privateKeyEnc, provider: this.store.keys.name } });
    } catch (e) {
      // Another instance made it first: use theirs.
      const theirs = await this.store.db.tsaKey.findUnique({ where: { id: this.id } });
      if (theirs) return theirs;
      throw e;
    }
  }

  /** The authority itself: a DER TimeStampReq in, a DER TimeStampResp out (granted, or a rejection with its reason). */
  async respond(request: Uint8Array): Promise<Uint8Array> {
    let req: pkijs.TimeStampReq;
    try {
      req = pkijs.TimeStampReq.fromBER(request);
    } catch {
      return rejection(FAIL.badDataFormat);
    }
    if (req.version !== 1) return rejection(FAIL.badRequest);
    if (req.messageImprint.hashAlgorithm.algorithmId !== OID.sha256 || req.messageImprint.hashedMessage.valueBlock.valueHexView.byteLength !== 32) return rejection(FAIL.badAlg);
    if (req.reqPolicy !== undefined && req.reqPolicy !== this.policyOid) return rejection(FAIL.unacceptedPolicy);
    if (req.extensions?.length) return rejection(FAIL.unacceptedExtension);

    let k: Loaded;
    try {
      k = await this.load();
    } catch {
      return rejection(FAIL.systemFailure);
    }
    const tst = new pkijs.TSTInfo({
      version: 1,
      policy: this.policyOid,
      messageImprint: req.messageImprint,
      serialNumber: randomInteger(16),
      genTime: new Date(),
      accuracy: new pkijs.Accuracy({ seconds: 1 }),
      ...(req.nonce ? { nonce: req.nonce } : {}),
    });
    const tstDer = tst.toSchema().toBER();
    const certDer = k.cert.toSchema(false).toBER();
    const sha256 = (b: ArrayBuffer) => ab(createHash("sha256").update(new Uint8Array(b)).digest());
    // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }; ESSCertIDv2 with the default SHA-256.
    const signingCertificateV2 = new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: sha256(certDer) })] })] })] });
    const signed = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.tstInfo, eContent: new asn1js.OctetString({ valueHex: tstDer }) }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({ issuer: k.cert.issuer, serialNumber: k.cert.serialNumber }),
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.tstInfo })] }),
              new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: sha256(tstDer) })] }),
              new pkijs.Attribute({ type: OID.signingCertificateV2, values: [signingCertificateV2] }),
            ],
          }),
        }),
      ],
      ...(req.certReq ? { certificates: [k.cert] } : {}),
    });
    await signed.sign(k.key as never, 0, "SHA-256");
    const token = new pkijs.ContentInfo({ contentType: OID.signedData, content: signed.toSchema(true) });
    return new Uint8Array(new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status: pkijs.PKIStatus.granted }), timeStampToken: token }).toSchema().toBER());
  }

  async stamp(digestHex: string): Promise<TimestampToken> {
    const query = timestampQuery(digestHex);
    const reply = await this.respond(query.der);
    return acceptReply(reply, query, { id: this.id, name: this.name, trusted: [await this.certificatePem()] });
  }
}
