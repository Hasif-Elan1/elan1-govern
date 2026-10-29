import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, privateEncrypt, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes, bytesToBase64, derChildren, derToPem, pemToDer, readCertificate, readDer, readTimestampToken, verifyEcdsaP256, verifyRsaPkcs1v15, verifyTimestampToken,
  type TimestampTokenFields, type TsaHashes,
} from "../src/seal/rfc3161";
import { OIDS, alg, concat, ctx, digest, int, makeCert, makeToken, nul, octets, oid, seq, set, tlv, toPem, type TokenOptions } from "./rfc3161-forge";
import type { TsaFixture } from "./seal-v6-real-builder";

const h = (name: string) => (d: Uint8Array) => new Uint8Array(createHash(name).update(d).digest());
const HASHES: TsaHashes = { sha256: h("sha256"), sha384: h("sha384"), sha512: h("sha512"), sha1: h("sha1") };
const tsa = JSON.parse(readFileSync(new URL("./fixtures/seal-v6-real/tsa.json", import.meta.url), "utf8")) as TsaFixture;
const asn1jsOids = JSON.parse(readFileSync(new URL("./fixtures/seal-v6-real/asn1js-oids.json", import.meta.url), "utf8")) as { hex: string; asn1js: string }[];
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ROOT = createHash("sha256").update("a batch root").digest("hex");

/* ── keys used throughout ── */
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ec2 = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ecCert = makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, cn: "Forged EC TSA" });
const rsaCert = makeCert({ publicKey: rsa.publicKey, signer: rsa.privateKey, cn: "Forged RSA TSA", serial: 77n });

const point = (k: KeyObject) => {
  const j = k.export({ format: "jwk" });
  return new Uint8Array([4, ...Buffer.from(j.x!, "base64url"), ...Buffer.from(j.y!, "base64url")]);
};
const ecToken = (o: Partial<TokenOptions> = {}) => makeToken({ root: ROOT, cert: ecCert, key: ec.privateKey, ...o });
const rsaToken = (o: Partial<TokenOptions> = {}) => makeToken({ root: ROOT, cert: rsaCert, key: rsa.privateKey, ...o });
const check = (t: { fields: TimestampTokenFields }, certPem: string | undefined = ecCert.pem, hashes = HASHES, root = ROOT) => verifyTimestampToken(t.fields, root, certPem, hashes);
const error = (r: ReturnType<typeof verifyTimestampToken>) => (r.ok ? "ok" : r.error);

describe("base64, PEM and DER", () => {
  it("decodes and encodes base64 the way Buffer does, for every length", () => {
    for (let n = 0; n < 70; n++) {
      const b = new Uint8Array(randomBytes(n));
      const text = Buffer.from(b).toString("base64");
      expect(bytesToBase64(b)).toBe(text);
      expect(base64ToBytes(text)).toEqual(b);
      expect(base64ToBytes(text.replace(/=+$/, ""))).toEqual(b);
      expect(base64ToBytes(text.replace(/(.{7})/g, "$1\n "))).toEqual(b);
    }
  });

  it("refuses what is not base64", () => {
    for (const bad of ["a", "ab$d", "abc==d", "abcde=", "ab=c", "====", "-_ab"]) expect(base64ToBytes(bad), bad).toBeUndefined();
    expect(base64ToBytes(undefined as unknown as string)).toBeUndefined();
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("reads PEM blocks by label and writes PEM as node:crypto does", () => {
    const pem = createPublicKey(generateKeyPairSync("ed25519").privateKey).export({ type: "spki", format: "pem" }).toString();
    const [der] = pemToDer(pem, "PUBLIC KEY")!;
    expect(derToPem(der!, "PUBLIC KEY")).toBe(pem);
    const certPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(derToPem(pemToDer(certPem, "PUBLIC KEY")![0]!, "PUBLIC KEY")).toBe(certPem); // wrapped at 64 columns
    expect(pemToDer(`${ecCert.pem}junk\n${rsaCert.pem}`)!.map(hex)).toEqual([hex(ecCert.der), hex(rsaCert.der)]);
    expect(pemToDer(ecCert.pem, "PUBLIC KEY")).toEqual([]);
    expect(pemToDer("-----BEGIN CERTIFICATE-----\nAAAA")).toBeUndefined();
    expect(pemToDer("-----BEGIN CERTIFICATE-----\n!!\n-----END CERTIFICATE-----")).toBeUndefined();
    expect(pemToDer(42 as unknown as string)).toBeUndefined();
    expect(derToPem(new Uint8Array(), "X")).toBe("-----BEGIN X-----\n\n-----END X-----\n");
  });

  it("reads DER strictly: definite minimal lengths, no high tags, nothing after the element", () => {
    expect(readDer(new Uint8Array([0x04, 0x02, 1, 2]))?.value).toEqual(new Uint8Array([1, 2]));
    const long = tlv(0x04, new Uint8Array(300));
    expect(readDer(long)?.value.length).toBe(300);
    for (const bad of [
      [0x30, 0x80, 0x00, 0x00], // indefinite length (BER)
      [0x04, 0x81, 0x05, 1, 2, 3, 4, 5], // a long form for a short length
      [0x04, 0x82, 0x00, 0x90, ...new Array(0x90).fill(0)], // a leading zero length byte
      [0x04, 0x85, 0, 0, 0, 0, 1, 0], // more than four length bytes
      [0x04, 0x03, 1, 2], // truncated
      [0x04, 0x01, 1, 0], // trailing bytes
      [0x1f, 0x01, 0x00], // a high tag number
      [0x04], // no length
    ]) expect(readDer(new Uint8Array(bad)), hex(new Uint8Array(bad))).toBeUndefined();
    expect(readDer([1, 2] as unknown as Uint8Array)).toBeUndefined();
    expect(derChildren(readDer(new Uint8Array([0x04, 0x00]))!)).toBeUndefined();
    expect(derChildren(readDer(new Uint8Array([0x30, 0x03, 0x04, 0x05, 0x00]))!)).toBeUndefined();
    expect(derChildren(readDer(seq(int(1), nul()))!)!.map((e) => e.tag)).toEqual([0x02, 0x05]);
  });
});

describe("ECDSA P-256, against node:crypto", () => {
  it("accepts what node signs and rejects a changed digest or signature, over many keys", () => {
    for (let i = 0; i < 120; i++) {
      const { publicKey, privateKey } = i % 2 ? ec : generateKeyPairSync("ec", { namedCurve: "P-256" });
      const msg = randomBytes(1 + i);
      const sig = new Uint8Array(sign("sha256", msg, privateKey));
      const d = digest("sha256", msg);
      expect(verifyEcdsaP256(point(publicKey), d, sig)).toBe(true);
      const d2 = d.slice();
      d2[i % 32]! ^= 1 << (i % 8);
      expect(verifyEcdsaP256(point(publicKey), d2, sig)).toBe(false);
      const s2 = sig.slice();
      s2[s2.length - 1 - (i % 20)]! ^= 1;
      expect(verifyEcdsaP256(point(publicKey), d, s2)).toBe(false);
    }
  });

  it("takes compressed points, and the leftmost 256 bits of a longer hash", () => {
    const msg = randomBytes(10);
    const p = point(ec.publicKey);
    const compressed = concat([2 + (p[64]! & 1)], p.subarray(1, 33));
    expect(verifyEcdsaP256(compressed, digest("sha256", msg), new Uint8Array(sign("sha256", msg, ec.privateKey)))).toBe(true);
    const wrongParity = concat([3 - (p[64]! & 1)], p.subarray(1, 33));
    expect(verifyEcdsaP256(wrongParity, digest("sha256", msg), new Uint8Array(sign("sha256", msg, ec.privateKey)))).toBe(false);
    expect(verifyEcdsaP256(p, digest("sha512", msg), new Uint8Array(sign("sha512", msg, ec.privateKey)))).toBe(true);
  });

  it("works for the keys 1 and n−1 (Q = G and Q = −G)", () => {
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    const GX = "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296";
    const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
    const b64 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, "0"), "hex").toString("base64url");
    for (const [d, y] of [[1n, GY], [N - 1n, P - GY]] as const) {
      const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64(d), x: b64(BigInt(`0x${GX}`)), y: b64(y) }, format: "jwk" });
      for (let i = 0; i < 4; i++) {
        const msg = randomBytes(8);
        expect(verifyEcdsaP256(point(createPublicKey(key)), digest("sha256", msg), new Uint8Array(sign("sha256", msg, key)))).toBe(true);
      }
    }
  });

  it("rejects r or s outside [1, n−1], bad encodings, bad points and trailing bytes", () => {
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const msg = randomBytes(10);
    const d = digest("sha256", msg);
    const p = point(ec.publicKey);
    const good = new Uint8Array(sign("sha256", msg, ec.privateKey));
    const [r, s] = derChildren(readDer(good)!)!.map((e) => BigInt(`0x${hex(e.value)}`)) as [bigint, bigint];
    const sig = (a: Uint8Array, b: Uint8Array) => seq(a, b);
    expect(verifyEcdsaP256(p, d, sig(int(r), int(s)))).toBe(true);
    for (const bad of [
      sig(int(0n), int(s)), sig(int(r), int(0n)), sig(int(N), int(s)), sig(int(r), int(N + s)), sig(int(r + N), int(s)),
      sig(tlv(0x02, [0x80, ...new Array(31).fill(1)]), int(s)), // negative
      sig(tlv(0x02, [0x00, 0x01, ...new Array(30).fill(1)]), int(s)), // not minimal
      sig(tlv(0x02, []), int(s)),
      sig(tlv(0x02, new Array(34).fill(1)), int(s)),
      seq(int(r), int(s), int(1)), seq(int(r)), concat(good, [0]), tlv(0x31, int(r), int(s)),
      new Uint8Array(sign("sha256", msg, { key: ec.privateKey, dsaEncoding: "ieee-p1363" })),
    ]) expect(verifyEcdsaP256(p, d, bad)).toBe(false);
    const off = p.slice();
    off[64]! ^= 1;
    const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    for (const key of [off, new Uint8Array([0]), p.subarray(0, 64), concat([5], p.subarray(1)), concat([4], Buffer.from(P.toString(16), "hex"), p.subarray(33)), concat([2], Buffer.from(P.toString(16), "hex")), concat([2], new Uint8Array(31), [5])]) {
      expect(verifyEcdsaP256(key, d, good)).toBe(false);
    }
    // a compressed x with no square root on the curve
    const pow = (b: bigint, e: bigint) => { let r = 1n; for (let x = b % P; e > 0n; e >>= 1n, x = (x * x) % P) if (e & 1n) r = (r * x) % P; return r; };
    const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
    let x = 1n;
    while (pow((((x * x * x - 3n * x + B) % P) + P) % P, (P - 1n) / 2n) !== P - 1n) x++;
    expect(verifyEcdsaP256(concat([2], Buffer.from(x.toString(16).padStart(64, "0"), "hex")), d, good)).toBe(false);
    // u1·G + u2·Q at infinity: Q = G and a digest of −r
    const G = concat([4], Buffer.from("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" + "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", "hex"));
    expect(verifyEcdsaP256(G, Buffer.from((N - r).toString(16).padStart(64, "0"), "hex"), sig(int(r), int(s)))).toBe(false);
    expect(verifyEcdsaP256(p, new Uint8Array(), good)).toBe(false);
    expect(verifyEcdsaP256(p, undefined as unknown as Uint8Array, good)).toBe(false);
  });
});

describe("RSA PKCS #1 v1.5, against node:crypto", () => {
  const keys = [rsa, generateKeyPairSync("rsa", { modulusLength: 3072 }), generateKeyPairSync("rsa", { modulusLength: 4096, publicExponent: 3 })];
  const parts = (k: KeyObject) => {
    const j = k.export({ format: "jwk" });
    return [new Uint8Array(Buffer.from(j.n!, "base64url")), new Uint8Array(Buffer.from(j.e!, "base64url"))] as const;
  };

  it("accepts what node signs with SHA-256, SHA-384 and SHA-512, and rejects any change", () => {
    for (const k of keys) {
      const [n, e] = parts(k.publicKey);
      for (const hash of ["sha256", "sha384", "sha512"] as const) {
        const msg = randomBytes(20);
        const sig = new Uint8Array(sign(hash, msg, k.privateKey));
        const d = digest(hash, msg);
        expect(verifyRsaPkcs1v15(n, e, hash, d, sig)).toBe(true);
        expect(verifyRsaPkcs1v15(concat([0], n), e, hash, d, sig)).toBe(true); // an INTEGER's sign byte
        const s2 = sig.slice();
        s2[7]! ^= 1;
        expect(verifyRsaPkcs1v15(n, e, hash, d, s2)).toBe(false);
        const d2 = d.slice();
        d2[0]! ^= 1;
        expect(verifyRsaPkcs1v15(n, e, hash, d2, sig)).toBe(false);
        expect(verifyRsaPkcs1v15(n, e, hash === "sha256" ? "sha384" : "sha256", d, sig)).toBe(false);
      }
    }
  });

  it("accepts a DigestInfo without the NULL parameters, and nothing else but the exact encoding", () => {
    const [n, e] = parts(rsa.publicKey);
    const k = n.length;
    const d = digest("sha256", randomBytes(5));
    const raw = (em: Uint8Array) => new Uint8Array(privateEncrypt({ key: rsa.privateKey, padding: constants.RSA_NO_PADDING }, em));
    const em = (prefix: string, opts: { first?: number[]; ps?: number; tail?: Uint8Array } = {}) => {
      const t = concat(Buffer.from(prefix, "hex"), opts.tail ?? d);
      const ps = opts.ps ?? k - t.length - 3;
      return concat(opts.first ?? [0, 1], new Array(ps).fill(0xff), [0], t, new Array(k - 3 - ps - t.length).fill(0));
    };
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, raw(em("3031300d060960864801650304020105000420")))).toBe(true);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, raw(em("302f300b06096086480165030402010420")))).toBe(true);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, raw(em("3031300d060960864801650304020105000420", { first: [0, 2] })))).toBe(false);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, raw(em("3031300d060960864801650304020105000420", { ps: k - 55 })))).toBe(false); // one 0xff short, the DigestInfo moved left
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, raw(em("3031300d060960864801650304020205000420")))).toBe(false); // another hash's OID
  });

  it("rejects a short or long signature, s ≥ n, a weak or malformed key and an unknown hash", () => {
    const [n, e] = parts(rsa.publicKey);
    const msg = randomBytes(9);
    const sig = new Uint8Array(sign("sha256", msg, rsa.privateKey));
    const d = digest("sha256", msg);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, sig.subarray(1))).toBe(false);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, concat([0], sig))).toBe(false);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, n)).toBe(false);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d.subarray(1), sig)).toBe(false);
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const [wn, we] = parts(weak.publicKey);
    expect(verifyRsaPkcs1v15(wn, we, "sha256", d, new Uint8Array(sign("sha256", msg, weak.privateKey)))).toBe(false);
    const even = n.slice();
    even[even.length - 1]! &= 0xfe;
    expect(verifyRsaPkcs1v15(even, e, "sha256", d, sig)).toBe(false);
    for (const badE of [[1], [2], [0x01, 0x00, 0x00], n]) expect(verifyRsaPkcs1v15(n, new Uint8Array(badE), "sha256", d, sig)).toBe(false);
    expect(verifyRsaPkcs1v15(n, e, "md5" as "sha256", d, sig)).toBe(false);
    expect(verifyRsaPkcs1v15(new Uint8Array(), e, "sha256", d, sig)).toBe(false);
    expect(verifyRsaPkcs1v15(n, e, "sha256", d, undefined as unknown as Uint8Array)).toBe(false);
  });
});

describe("certificates", () => {
  it("reads the frozen authorities' certificates as node:crypto does", () => {
    for (const a of tsa.authorities) {
      const [der] = pemToDer(a.certPem)!;
      const c = readCertificate(der!)!;
      const x = new X509Certificate(a.certPem);
      expect(BigInt(`0x${hex(c.serial)}`)).toBe(BigInt(`0x${x.serialNumber}`));
      expect(c.notBefore).toBe(Date.parse(x.validFrom));
      expect(c.notAfter).toBe(Date.parse(x.validTo));
      expect(c.subjectKeyId).toBeDefined();
      expect(c.publicKey.kind).toBe(a.id.startsWith("local") ? "ec-p256" : "rsa");
      if (c.publicKey.kind === "ec-p256") expect(hex(c.publicKey.point)).toBe(hex(point(x.publicKey)));
      if (c.publicKey.kind === "rsa") expect(hex(c.publicKey.modulus).replace(/^00/, "")).toBe(Buffer.from(x.publicKey.export({ format: "jwk" }).n!, "base64url").toString("hex"));
    }
  });

  it("reads v1 certificates, GeneralizedTime validity, unique ids and other key types", () => {
    const v1 = readCertificate(makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, v1: true, generalized: true, notAfter: Date.parse("2051-06-01T00:00:00Z") }).der)!;
    expect(v1.subjectKeyId).toBeUndefined();
    expect(new Date(v1.notAfter).toISOString()).toBe("2051-06-01T00:00:00.000Z");
    expect(readCertificate(makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, uniqueIds: true }).der)?.subjectKeyId).toBeDefined();
    const old = readCertificate(makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, notBefore: Date.parse("1999-01-01T00:00:00Z") }).der)!;
    expect(new Date(old.notBefore).getUTCFullYear()).toBe(1999);
    const ed = generateKeyPairSync("ed25519").publicKey;
    expect(readCertificate(makeCert({ publicKey: ed, signer: ec.privateKey, spki: new Uint8Array(ed.export({ type: "spki", format: "der" })) }).der)?.publicKey).toEqual({ kind: "other", algorithm: "1.3.101.112" });
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey;
    expect(readCertificate(makeCert({ publicKey: p384, signer: ec.privateKey }).der)?.publicKey).toEqual({ kind: "other", algorithm: OIDS.ecPublicKey });
  });

  it("is undefined for anything that is not a certificate", () => {
    const c = ecCert.der;
    const [tbs, sigAlg, sig] = derChildren(readDer(c)!)!;
    const tbsParts = derChildren(tbs!)!;
    const withTbs = (...p: Uint8Array[]) => seq(seq(...p), sigAlg!.der, sig!.der);
    const at = (i: number, el: Uint8Array) => withTbs(...tbsParts.map((x, j) => (j === i ? el : x.der)));
    for (const bad of [
      new Uint8Array(), c.subarray(0, c.length - 1), seq(tbs!.der, sigAlg!.der), seq(tbs!.der, sigAlg!.der, sig!.der, nul()),
      at(4, seq(tbsParts[4]!.der)), // validity with one time
      at(4, seq(tlv(0x17, Buffer.from("260231000000Z")), tbsParts[4]!.der.subarray(15))), // 31 February
      at(4, seq(tlv(0x17, Buffer.from("2602010000Z")), tlv(0x17, Buffer.from("360101000000Z")))), // no seconds
      ...["260101250000Z", "260101006000Z", "260101000060Z", "261301000000Z"].map((t) => at(4, seq(tlv(0x17, Buffer.from(t)), tlv(0x17, Buffer.from("360101000000Z"))))),
      at(4, seq(tlv(0x18, Buffer.from("00500101000000Z")), tlv(0x17, Buffer.from("360101000000Z")))), // year 50: Date.UTC would read 1950
      at(4, seq(tlv(0x18, Buffer.from("20260101000000+0100")), tlv(0x17, Buffer.from("360101000000Z")))), // not UTC
      at(4, seq(tlv(0x04, Buffer.from("260101000000Z")), tlv(0x17, Buffer.from("360101000000Z")))), // not a time
      at(6, seq(seq(oid(OIDS.rsaEncryption), nul()), tlv(0x03, [0, 0x30, 0x03, 0x02, 0x01, 0x01]))), // RSA key with no exponent
      at(6, seq(seq(oid(OIDS.rsaEncryption), nul()), tlv(0x03, [0, ...seq(int(65537n), int(3n), int(1n))]))), // three integers
      at(6, seq(seq(oid(OIDS.rsaEncryption), nul()), tlv(0x03, [0, ...seq(tlv(0x02, [0x80, 1]), int(3n))]))), // a negative modulus
      at(6, seq(seq(oid(OIDS.ecPublicKey), oid(OIDS.p256)), tlv(0x03, [1, 4, 5]))), // unused bits
      at(6, seq(seq(tlv(0x06, [0x2a, 0x80, 0x01])), tlv(0x03, [0, 1]))), // a non-minimal OID arc
      at(6, seq(seq(tlv(0x06, [0x2a, 0x86])), tlv(0x03, [0, 1]))), // an unfinished OID arc
      at(6, seq(seq(tlv(0x06, [])), tlv(0x03, [0, 1]))), // an empty OID
    ]) expect(readCertificate(bad), hex(bad).slice(0, 40)).toBeUndefined();
  });
});

describe("RFC 3161 tokens: the frozen real ones", () => {
  it("verifies every token the gate's local authorities and OpenSSL issued, over its own root only", () => {
    let n = 0;
    for (const a of tsa.authorities) {
      for (const [root, t] of Object.entries(tsa.tokens[a.id]!)) {
        expect(verifyTimestampToken(t as TimestampTokenFields, root, a.certPem, HASHES)).toEqual({ ok: true });
        expect(error(verifyTimestampToken(t as TimestampTokenFields, ROOT, a.certPem, HASHES))).toBe("the token was issued for a different digest");
        const info = readTimestampToken(base64ToBytes(t.der!)!)!;
        expect(info.imprint).toBe(root);
        expect([info.policy, info.policyAsn1js]).toContain(t.policyOid);
        expect(info.signers).toHaveLength(1);
        n++;
      }
    }
    expect(n).toBe(8);
  });

  it("reads the gate's local policies as asn1js writes them, and the hosted ones in plain decimal", () => {
    const local = tsa.tokens["local-a"]!;
    const t = Object.values(local)[0]!;
    const info = readTimestampToken(base64ToBytes(t.der!)!)!;
    expect(info.policy).toBe(tsa.authorities.find((a) => a.id === "local-a")!.policyOid);
    expect(info.policyAsn1js).toBe(t.policyOid);
    expect(t.policyOid).toMatch(/^2\.25\.\{[0-9a-f]+\}\.1$/);
    for (const o of asn1jsOids) {
      const forged = ecToken({ policyHex: o.hex });
      expect(readTimestampToken(forged.der)?.policyAsn1js, o.hex).toBe(o.asn1js);
    }
  });

  it("needs the hashes a token uses: SHA-512 and SHA-1 for OpenSSL's B, SHA-256 only for the gate's own", () => {
    const only256: TsaHashes = { sha256: HASHES.sha256 };
    const of = (id: string) => [Object.entries(tsa.tokens[id]!)[0]!, tsa.authorities.find((a) => a.id === id)!.certPem] as const;
    for (const id of ["local-a", "local-b", "openssl-rsa-a"]) {
      const [[root, t], pem] = of(id);
      expect(verifyTimestampToken(t as TimestampTokenFields, root, pem, only256).ok, id).toBe(true);
    }
    const [[root, t], pem] = of("openssl-rsa-b");
    expect(error(verifyTimestampToken(t as TimestampTokenFields, root, pem, only256))).toBe("the token uses an unsupported digest");
    expect(error(verifyTimestampToken(t as TimestampTokenFields, root, pem, { ...HASHES, sha1: undefined }))).toBe("the signing-certificate attribute does not name the authority's certificate");
  });

  it("never throws, and fails, on every truncation and on a flipped byte anywhere that is signed", () => {
    for (const id of ["local-a", "openssl-rsa-a"]) {
      const a = tsa.authorities.find((x) => x.id === id)!;
      const [root, t] = Object.entries(tsa.tokens[id]!)[0]!;
      const der = base64ToBytes(t.der!)!;
      const info = readTimestampToken(der)!;
      const signer = info.signers[0]!;
      const attrsAt = Buffer.from(der).indexOf(Buffer.from([0xa0, ...signer.signedAttrs!.subarray(1)]));
      const regions = [[Buffer.from(der).indexOf(Buffer.from(info.tstInfo)), info.tstInfo.length], [attrsAt, signer.signedAttrs!.length], [Buffer.from(der).indexOf(Buffer.from(signer.signature)), signer.signature.length]] as const;
      for (const [start, len] of regions) {
        expect(start).toBeGreaterThan(0);
        expect(len).toBeGreaterThan(0);
      }
      const signed = (i: number) => regions.some(([start, len]) => i >= start && i < start + len);
      const at = (bytes: Uint8Array) => verifyTimestampToken({ ...(t as TimestampTokenFields), der: bytesToBase64(bytes) }, root, a.certPem, HASHES);
      for (let i = 0; i < der.length; i++) {
        const flipped = der.slice();
        flipped[i]! ^= 0x10;
        const r = at(flipped);
        if (signed(i)) expect(r.ok, `${id} byte ${i}`).toBe(false);
        expect(at(der.subarray(0, i)).ok).toBe(false);
      }
    }
  });
});

describe("RFC 3161 tokens: every check, on forged tokens", () => {
  it("verifies a well-formed token in each supported shape", () => {
    const shapes: [string, () => ReturnType<typeof makeToken>, string][] = [
      ["ECDSA, ESS v2", () => ecToken(), ecCert.pem],
      ["ECDSA, ESS v1 and v2, an embedded certificate, unsigned attributes, CRLs, TSTInfo extras", () => ecToken({ ess: "both", certs: [ecCert.der], unsignedAttrs: true, crls: true, extras: true, otherCerts: true }), ecCert.pem],
      ["ECDSA, no ESS, named by key id", () => ecToken({ ess: "none", sid: "ski" }), ecCert.pem],
      ["ECDSA, a constructed eContent in three segments", () => ecToken({ segments: 3 }), ecCert.pem],
      ["ECDSA, genTime in whole seconds", () => ecToken({ genTime: Date.parse("2026-10-29T10:00:00Z"), fraction: false }), ecCert.pem],
      ["ECDSA, ESS v2 over SHA-512, digest SHA-384", () => ecToken({ ess: "v2-sha512", digestAlgorithm: OIDS.sha384 }), ecCert.pem],
      ["RSA, rsaEncryption with SHA-256", () => rsaToken(), rsaCert.pem],
      ["RSA, rsaEncryption with SHA-384", () => rsaToken({ digestAlgorithm: OIDS.sha384 }), rsaCert.pem],
      ["RSA, rsaEncryption with SHA-512, ESS v1", () => rsaToken({ digestAlgorithm: OIDS.sha512, ess: "v1" }), rsaCert.pem],
      ["RSA, sha256WithRSAEncryption", () => rsaToken({ signatureAlgorithm: OIDS.sha256Rsa }), rsaCert.pem],
      ["RSA, sha384WithRSAEncryption", () => rsaToken({ signatureAlgorithm: OIDS.sha384Rsa }), rsaCert.pem],
      ["RSA, sha512WithRSAEncryption, named by key id", () => rsaToken({ signatureAlgorithm: OIDS.sha512Rsa, sid: "ski" }), rsaCert.pem],
    ];
    for (const [name, make, pem] of shapes) expect(error(check(make(), pem)), name).toBe("ok");
  });

  it("checks the stored fields against the DER: imprint, policy, serial (ignoring case and leading zeros) and time (as an instant)", () => {
    const t = ecToken({ serial: 0x00ab12n });
    expect(error(check(t))).toBe("ok");
    expect(error(check({ fields: { ...t.fields, serial: "000AB12" } }))).toBe("ok");
    expect(error(check({ fields: { ...t.fields, genTime: "2026-10-29T15:30:00.250+05:30" } }))).toBe("ok");
    expect(error(check({ fields: { ...t.fields, imprint: "00".repeat(32) } }))).toBe("the token was issued for a different digest");
    expect(error(check(t, ecCert.pem, HASHES, "00".repeat(32)))).toBe("the token was issued for a different digest");
    expect(error(verifyTimestampToken(t.fields, null as unknown as string, ecCert.pem, HASHES))).toBe("the token was issued for a different digest");
    for (const fields of [{ policyOid: "1.2.3.4.2" }, { serial: "ab13" }, { serial: "0x" }, { serial: 171 as unknown as string }, { genTime: "2026-10-29T10:00:00.251Z" }, { genTime: "yesterday" }]) {
      expect(error(check({ fields: { ...t.fields, ...fields } })), JSON.stringify(fields)).toBe("the token's stored fields do not match its contents");
    }
    expect(error(check(ecToken({ imprintAlgorithm: OIDS.sha384 })))).toBe("the token's imprint is not SHA-256");
  });

  it("refuses what is not a TimeStampToken", () => {
    const notToken = "the token is not an RFC 3161 timestamp token";
    for (const t of [
      ecToken({ contentType: OIDS.tstInfo, eContentType: OIDS.data }), ecToken({ tstVersion: 2 }), ecToken({ trailing: nul() }), ecToken({ extraAfterSigners: true }),
    ]) expect(error(check(t))).toBe(notToken);
    const t = ecToken();
    expect(error(check({ fields: { ...t.fields, der: "%%%" } }))).toBe(notToken);
    expect(error(check({ fields: { ...t.fields, der: bytesToBase64(concat(t.der, [0])) } }))).toBe(notToken);
    const asData = seq(oid(OIDS.data), ctx(0, octets([1])));
    const noEContent = seq(oid(OIDS.signedData), ctx(0, seq(int(3), set(), seq(oid(OIDS.tstInfo)), set())));
    const twoInContent = seq(oid(OIDS.signedData), ctx(0, seq(int(3)), nul()));
    for (const der of [asData, noEContent, twoInContent, seq(oid(OIDS.signedData), ctx(0, seq(int(3), set(), seq(oid(OIDS.tstInfo), ctx(0, tlv(0x24, int(1)))), set())))]) {
      expect(error(check({ fields: { ...t.fields, der: bytesToBase64(der) } }))).toBe(notToken);
    }
    expect(readTimestampToken(new Uint8Array([1, 2, 3]))).toBeUndefined();
    // the structure inside, one part at a time: a SignedData with these signer infos and this TSTInfo
    const tst = readTimestampToken(t.der)!.tstInfo;
    const wrap = (signers: Uint8Array, info: Uint8Array = tst, eContent: Uint8Array[] = [octets(info)]) =>
      seq(oid(OIDS.signedData), ctx(0, seq(int(3), set(), seq(oid(OIDS.tstInfo), ctx(0, ...eContent)), signers)));
    const signer = (...p: Uint8Array[]) => set(seq(int(1), ...p));
    const name = seq(set(seq(oid(OIDS.commonName))));
    expect(readTimestampToken(wrap(set()))?.signers).toEqual([]);
    for (const der of [
      wrap(signer()), // a version only
      wrap(signer(seq(name, int(1), nul()), alg(OIDS.sha256), alg(OIDS.ecdsaSha256), octets([]))), // an IssuerAndSerialNumber with three parts
      wrap(signer(seq(name, int(1)), alg(OIDS.sha256), alg(OIDS.ecdsaSha256), octets([]), nul())), // something after the signature
      wrap(signer(tlv(0x81, [1]), alg(OIDS.sha256), alg(OIDS.ecdsaSha256), octets([]))), // a sid of neither kind
      wrap(set(), tst, [octets(tst), nul()]), // two things in eContent
      wrap(set(), seq(int(1), oid("1.2.3"), seq(alg(OIDS.sha256), octets(new Uint8Array(32)), nul()), int(1), tlv(0x18, Buffer.from("20261029100000Z")))), // an imprint with three parts
      wrap(set(), seq(int(1), oid("1.2.3"), seq(alg(OIDS.sha256), octets(new Uint8Array(32))), int(1), tlv(0x17, Buffer.from("261029100000Z")))), // genTime as UTCTime
      wrap(set(), seq(tlv(0x02, [0, 1]), oid("1.2.3"), seq(alg(OIDS.sha256), octets(new Uint8Array(32))), int(1), tlv(0x18, Buffer.from("20261029100000Z")))), // version 00 01
    ]) expect(readTimestampToken(der), hex(der).slice(-60)).toBeUndefined();
    const zero = readTimestampToken(wrap(set(), seq(int(1), oid("0.9.2342.19200300.100.1.1"), seq(alg(OIDS.sha256), octets(new Uint8Array(32))), int(0), tlv(0x18, Buffer.from("20261029100000.5Z")))))!;
    expect([zero.policy, zero.policyAsn1js, zero.serial, new Date(zero.genTime).toISOString()]).toEqual(["0.9.2342.19200300.100.1.1", "0.9.2342.19200300.100.1.1", "00", "2026-10-29T10:00:00.500Z"]);
  });

  it("needs exactly one signer, named by the authority's certificate, whose embedded copy is the authority's", () => {
    expect(error(check(ecToken({ signers: 2 })))).toBe("the token must have exactly one signer");
    expect(error(check(ecToken({ signers: 0 })))).toBe("the token must have exactly one signer");
    expect(error(check(ecToken({ sid: "other-serial" })))).toBe("the token is signed by another certificate than the authority's");
    expect(error(check(ecToken(), rsaCert.pem))).toBe("the token is signed by another certificate than the authority's");
    // a key id on a certificate without the extension: SHA-1 of the key, when the caller has SHA-1
    const bare = makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, ski: false });
    const byKeyId = makeToken({ root: ROOT, cert: bare, key: ec.privateKey, sid: "ski" });
    expect(error(check(byKeyId, bare.pem))).toBe("ok");
    expect(error(check(byKeyId, bare.pem, { ...HASHES, sha1: undefined }))).toBe("the token is signed by another certificate than the authority's");
    // an embedded certificate under the signer's name that is not the authority's (another key, same issuer and serial)
    const impostor = makeCert({ publicKey: ec2.publicKey, signer: ec2.privateKey, cn: "Forged EC TSA" });
    expect(error(check(ecToken({ certs: [impostor.der] })))).toBe("the certificate the token carries is not the authority's");
    expect(error(check(ecToken({ certs: [rsaCert.der, seq(int(1)), ecCert.der] })))).toBe("ok");
  });

  it("needs the authority's certificate, valid at the token's time", () => {
    const t = ecToken();
    expect(error(verifyTimestampToken(t.fields, ROOT, undefined, HASHES))).toBe("the authority's certificate could not be read");
    for (const pem of ["", "not a pem", toPem(seq(int(1))), "-----BEGIN CERTIFICATE-----\n!!\n-----END CERTIFICATE-----"]) {
      expect(error(check(t, pem))).toBe("the authority's certificate could not be read");
    }
    expect(error(check(t, `${ecCert.pem}${rsaCert.pem}`))).toBe("ok"); // the first certificate in the PEM
    const later = makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, cn: "Forged EC TSA", notBefore: Date.parse("2027-01-01T00:00:00Z") });
    expect(error(check(makeToken({ root: ROOT, cert: later, key: ec.privateKey }), later.pem))).toBe("the authority's certificate was not valid at the token's time");
    const expired = makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, cn: "Forged EC TSA", notAfter: Date.parse("2026-06-01T00:00:00Z") });
    expect(error(check(makeToken({ root: ROOT, cert: expired, key: ec.privateKey }), expired.pem))).toBe("the authority's certificate was not valid at the token's time");
  });

  it("checks the signed attributes: present, each type once, the TSTInfo content type and its message digest", () => {
    const drop = (type: string) => (attrs: Uint8Array[]) => attrs.filter((a) => hex(a).indexOf(hex(oid(type))) !== 4);
    expect(error(check(ecToken({ noSignedAttrs: true })))).toBe("the token has no signed attributes");
    expect(error(check(ecToken({ attrs: (a) => [...a, a[0]!] })))).toBe("the token's signed attributes repeat a type");
    const ctBad = "the token's content-type attribute is not TSTInfo";
    expect(error(check(ecToken({ attrs: drop(OIDS.contentType) })))).toBe(ctBad);
    expect(error(check(ecToken({ contentType: OIDS.data })))).toBe(ctBad);
    expect(error(check(ecToken({ attrs: (a) => [seq(oid(OIDS.contentType), set(oid(OIDS.tstInfo), oid(OIDS.tstInfo))), ...a.slice(1)] })))).toBe(ctBad);
    expect(error(check(ecToken({ attrs: (a) => [seq(oid(OIDS.contentType), set(int(1))), ...a.slice(1)] })))).toBe(ctBad);
    const mdBad = "the token's message digest does not match";
    expect(error(check(ecToken({ attrs: drop(OIDS.messageDigest) })))).toBe(mdBad);
    expect(error(check(ecToken({ attrs: (a) => [a[0]!, seq(oid(OIDS.messageDigest), set(octets(new Uint8Array(32)))), ...a.slice(2)] })))).toBe(mdBad);
    expect(error(check(ecToken({ attrs: (a) => [a[0]!, seq(oid(OIDS.messageDigest), set(int(1))), ...a.slice(2)] })))).toBe(mdBad);
    expect(error(check(ecToken({ attrs: (a) => [a[0]!, seq(oid(OIDS.messageDigest), set(octets(digest("sha256", new Uint8Array())), octets(new Uint8Array(32)))), ...a.slice(2)] })))).toBe(mdBad);
    expect(error(check(ecToken({ attrs: (a) => [...a, tlv(0x30, [0x06])] })))).toBe("the token is not an RFC 3161 timestamp token");
    expect(error(check(ecToken({ attrs: (a) => [...a, seq(oid(OIDS.signingTime), set(int(1)), nul())] })))).toBe("the token is not an RFC 3161 timestamp token");
  });

  it("accepts SHA-256, SHA-384 and SHA-512 message digests only, with the hashes the caller has", () => {
    expect(error(check(ecToken({ digestAlgorithm: OIDS.sha1 })))).toBe("the token uses an unsupported digest");
    expect(error(check(ecToken({ digestAlgorithm: "1.2.3.4" })))).toBe("the token uses an unsupported digest");
    expect(error(check(ecToken({ digestAlgorithm: OIDS.sha384 }), ecCert.pem, { sha256: HASHES.sha256 }))).toBe("the token uses an unsupported digest");
    expect(error(check(ecToken({ digestAlgorithm: OIDS.sha512 })))).toBe("ok");
  });

  it("checks an ESS signing-certificate attribute, v1 or v2, against the authority's certificate", () => {
    const ess = "the signing-certificate attribute does not name the authority's certificate";
    expect(error(check(ecToken({ ess: "v2-wrong" })))).toBe(ess);
    expect(error(check(ecToken({ ess: "v2-unknown" })))).toBe(ess);
    expect(error(check(ecToken({ ess: "v2-two-values" })))).toBe(ess);
    expect(error(check(ecToken({ ess: "v2-empty" })))).toBe(ess);
    expect(error(check(ecToken({ ess: "v1" })))).toBe("ok");
    expect(error(check(ecToken({ ess: "v1" }), ecCert.pem, { ...HASHES, sha1: undefined }))).toBe(ess);
    expect(error(check(ecToken({ ess: "v2-sha512" }), ecCert.pem, { ...HASHES, sha512: undefined }))).toBe(ess);
  });

  it("verifies the signature with the certificate's key: ECDSA P-256 with SHA-256, RSA PKCS #1 v1.5 with SHA-2, nothing else", () => {
    const sigBad = "the token's signature does not verify";
    expect(error(check(ecToken({ tamper: (s) => concat(s.subarray(0, s.length - 1), [s[s.length - 1]! ^ 1]) })))).toBe(sigBad);
    expect(error(check(rsaToken({ tamper: (s) => concat([s[0]! ^ 1], s.subarray(1)) }), rsaCert.pem))).toBe(sigBad);
    expect(error(check(ecToken({ signatureAlgorithm: OIDS.ecdsaSha384, signHash: "sha384" })))).toBe(sigBad);
    expect(error(check(rsaToken({ signatureAlgorithm: OIDS.rsaPss }), rsaCert.pem))).toBe(sigBad);
    expect(error(check(rsaToken({ signatureAlgorithm: OIDS.sha384Rsa }), rsaCert.pem, { ...HASHES, sha384: undefined }))).toBe(sigBad);
    // a token signed by the right name with the wrong kind of key
    const rsaNamedEc = makeCert({ publicKey: rsa.publicKey, signer: rsa.privateKey, cn: "Forged EC TSA" });
    expect(error(check(ecToken({ ess: "none" }), rsaNamedEc.pem))).toBe(sigBad);
    const ecNamedRsa = makeCert({ publicKey: ec.publicKey, signer: ec.privateKey, cn: "Forged RSA TSA", serial: 77n });
    expect(error(check(rsaToken({ ess: "none" }), ecNamedRsa.pem))).toBe(sigBad);
    // a token whose ECDSA signature is over the TSTInfo instead of the signed attributes
    const t = ecToken();
    const wrongInput = ecToken({ tamper: () => new Uint8Array(sign("sha256", readTimestampToken(t.der)!.tstInfo, ec.privateKey)) });
    expect(error(check(wrongInput))).toBe(sigBad);
  });

  it("never throws on garbage", () => {
    const t = ecToken();
    for (const token of [null, undefined, {}, { der: 5 }, { ...t.fields, der: null }, "token"]) {
      expect(() => verifyTimestampToken(token as unknown as TimestampTokenFields, ROOT, ecCert.pem, HASHES)).not.toThrow();
      expect(verifyTimestampToken(token as unknown as TimestampTokenFields, ROOT, ecCert.pem, HASHES).ok).toBe(false);
    }
    expect(error(verifyTimestampToken(null as unknown as TimestampTokenFields, ROOT, ecCert.pem, HASHES))).toBe("the token could not be read");
    expect(verifyTimestampToken(t.fields, ROOT, ecCert.pem, {} as TsaHashes).ok).toBe(false);
    for (let i = 0; i < 300; i++) {
      const junk = new Uint8Array(randomBytes(1 + (i % 90)));
      junk[0] = 0x30;
      expect(verifyTimestampToken({ ...t.fields, der: bytesToBase64(junk) }, ROOT, ecCert.pem, HASHES).ok).toBe(false);
      expect(readCertificate(junk)).toBeUndefined();
    }
  });
});
