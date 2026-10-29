import { createHash, randomBytes, webcrypto, X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "@gate/db";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envKeyProvider } from "../src/keys";
import { readGateEnv } from "../src/env";
import { HttpTsa, postTimestampQuery } from "../src/tsa/http";
import { LocalTsa } from "../src/tsa/local";
import { inclusionPath, leafHash, merkleRoot, nodeHash, rootFromPath, verifyInclusion } from "../src/tsa/merkle";
import { acceptReply, derToPem, timestampQuery, TsaError, verifyTimestampToken } from "../src/tsa/token";
import { env } from "./helpers";

const keys = envKeyProvider(env.GATE_MASTER_KEY);
const made: string[] = [];
const tid = (p: string) => {
  const id = `test-${p}-${randomBytes(4).toString("hex")}`;
  made.push(id);
  return id;
};
const local = (p: string, policy = "2.25.1.1") => {
  const id = tid(p);
  return new LocalTsa({ db: prisma, keys }, id, `Test TSA ${id}`, policy);
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

afterAll(async () => {
  await prisma.tsaKey.deleteMany({ where: { id: { in: made } } });
});

describe("Merkle batches match the console (apps/console/src/lib/merkle.ts)", () => {
  // Frozen from the console implementation: leaves are sha256("receipt-1"), sha256("receipt-2"), ...
  // run with `node_modules/.bin/tsx --tsconfig apps/console/tsconfig.json`.
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => digest(`receipt-${i + 1}`));

  it("leaf, node and roots", () => {
    expect(leafHash(leaves(1)[0]!)).toBe("29534994a3ad2af6dd418f46d4093897971cd14bea312167ad82c4b31dbbfcec");
    expect(nodeHash(leaves(2)[0]!, leaves(2)[1]!)).toBe("89524d571646a8dcac8b55e284cb8b2c566c1b032c366734a9e197fe11bd7ed0");
    expect(merkleRoot([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(merkleRoot(leaves(1))).toBe("29534994a3ad2af6dd418f46d4093897971cd14bea312167ad82c4b31dbbfcec");
    expect(merkleRoot(leaves(2))).toBe("a34e6d5dac1ff07f820cc5156b41a50ce78c6a6868d81d5c5824cad0cab7250b");
    expect(merkleRoot(leaves(3))).toBe("59140b9d370d775da9f6e8e0fb3baa63489f19f4e62d8402495b9a576ce9fa51");
    expect(merkleRoot(leaves(5))).toBe("c05444bdd9862e94c1e9f4feefe78984eb141d7a9a8112c852011e37952e3a02");
    expect(merkleRoot(leaves(7))).toBe("40a91eec870d34ec32dcf4f20ecc85eecd70c01143c45916da174679b1cb2019");
    expect(merkleRoot(leaves(8))).toBe("cc7b5fd2bc078fd0dc219b51d725405b4ba7cc936aeb83b4fb56d8a0ade8a9fb");
  });

  it("inclusion paths", () => {
    expect(inclusionPath(leaves(7), 0)).toEqual([
      { hash: "70cd9dc55d5eb8e95d7678e9e63850bf6eab82e4c8320bd921189cf33650a6dd", side: "right" },
      { hash: "fb9a3f99d71930b4a1749046cb732f0d8c611d29ccd4832bc6fcc17e1054d5f8", side: "right" },
      { hash: "0fb0c3b811aa7a7fbf96f0c822071a48d31d7eef102af0fac3cc2156c62d22f9", side: "right" },
    ]);
    expect(inclusionPath(leaves(7), 4)).toEqual([
      { hash: "014b1f294b09694e6b3610d2715ffeef03674da6ba6a3195a5da6d1e271153a1", side: "right" },
      { hash: "2b75ab66f3d78ee4a6cbc2cf87d6772567f80514ad43679ec455e412da4a843d", side: "right" },
      { hash: "4f3cf7244fc877caa995afae4651eca55e47d1a5783393209d40c35fc19e0f21", side: "left" },
    ]);
    expect(inclusionPath(leaves(7), 6)).toEqual([
      { hash: "01f234ed3c84b72f2e2387be16371c2708742b4d4e1b34a4c32b96e64e41739e", side: "left" },
      { hash: "4f3cf7244fc877caa995afae4651eca55e47d1a5783393209d40c35fc19e0f21", side: "left" },
    ]);
    expect(inclusionPath(leaves(5), 4)).toEqual([{ hash: "4f3cf7244fc877caa995afae4651eca55e47d1a5783393209d40c35fc19e0f21", side: "left" }]);
  });

  it("every path recomputes the root, and a wrong leaf or root does not", () => {
    for (const n of [1, 2, 3, 6, 9, 16, 17]) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      ls.forEach((l, i) => expect(rootFromPath(l, inclusionPath(ls, i))).toBe(root));
      expect(verifyInclusion(digest("other"), inclusionPath(ls, 0), root)).toBe(false);
    }
    expect(verifyInclusion(leaves(3)[0]!, inclusionPath(leaves(3), 0), merkleRoot(leaves(4)))).toBe(false);
    expect(verifyInclusion("zz", [], merkleRoot(leaves(1)))).toBe(false);
    expect(() => inclusionPath(leaves(3), 3)).toThrow(RangeError);
  });
});

describe("LocalTsa (RFC 3161 in-process)", () => {
  it("issues tokens that verify against its certificate, and keeps its key encrypted", async () => {
    const a = local("a");
    const root = digest("batch-1");
    const t = await a.stamp(root);
    expect(t).toMatchObject({ tsaId: a.id, tsaName: a.name, imprint: root, policyOid: "2.25.1.1" });
    expect(Math.abs(Date.parse(t.genTime) - Date.now())).toBeLessThan(10_000);
    expect(t.serial).toMatch(/^[0-9a-f]{32}$/);
    expect(t.chain).toHaveLength(1);
    expect(t.chain[0]).toBe(await a.certificatePem());
    const check = await verifyTimestampToken(t, root, [await a.certificatePem()]);
    expect(check).toMatchObject({ ok: true, serial: t.serial, signer: `2.5.4.10=Elan1 Govern, CN=${a.name}` });

    const row = await prisma.tsaKey.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.privateKeyEnc).not.toContain("PRIVATE KEY");
    expect(row.provider).toBe("env");
    // A second instance (another process) loads the same key and certificate.
    const again = new LocalTsa({ db: prisma, keys }, a.id, a.name, "2.25.1.1");
    expect(await again.certificatePem()).toBe(row.certPem);
    expect((await verifyTimestampToken(await again.stamp(root), root, [row.certPem])).ok).toBe(true);
  });

  it("the certificate is a critical-EKU timestamping certificate", async () => {
    const a = local("cert");
    const x = new X509Certificate(await a.certificatePem());
    expect(x.ca).toBe(false);
    expect(x.subject).toContain(a.name);
    const parsed = pkijs.Certificate.fromBER(x.raw);
    const eku = parsed.extensions?.find((e) => e.extnID === "2.5.29.37");
    expect(eku?.critical).toBe(true);
    expect((eku?.parsedValue as pkijs.ExtKeyUsage).keyPurposes).toEqual(["1.3.6.1.5.5.7.3.8"]);
  });

  it("a tampered digest, token or stored field fails", async () => {
    const a = local("tamper");
    const root = digest("batch-2");
    const t = await a.stamp(root);
    const pin = [await a.certificatePem()];
    expect(await verifyTimestampToken(t, digest("batch-3"), pin)).toEqual({ ok: false, error: "the token was issued for a different digest" });
    expect(await verifyTimestampToken(t, "not hex", pin)).toMatchObject({ ok: false });
    expect(await verifyTimestampToken({ ...t, genTime: new Date(0).toISOString() }, root, pin)).toEqual({ ok: false, error: "the token's stored fields do not match its contents" });
    expect(await verifyTimestampToken({ ...t, imprint: digest("x") }, root, pin)).toMatchObject({ ok: false });

    const der = Buffer.from(t.der, "base64");
    const flipped = Buffer.from(der);
    flipped[flipped.length - 3]! ^= 0x01; // inside the signature
    expect((await verifyTimestampToken({ ...t, der: flipped.toString("base64") }, root, pin)).ok).toBe(false);
    // TSTInfo bytes changed: the message digest no longer matches.
    const at = der.indexOf(Buffer.from(root, "hex"));
    const changed = Buffer.from(der);
    changed[at]! ^= 0xff;
    expect(await verifyTimestampToken({ ...t, der: changed.toString("base64") }, root, pin)).toMatchObject({ ok: false });
    expect(await verifyTimestampToken({ ...t, der: "AAAA" }, root, pin)).toEqual({ ok: false, error: "the token could not be read" });
  });

  it("two local authorities are independent: one's token does not verify with the other's certificate", async () => {
    const a = local("ind-a");
    const b = local("ind-b");
    const root = digest("batch-4");
    const [ta, tb] = await Promise.all([a.stamp(root), b.stamp(root)]);
    expect(await a.certificatePem()).not.toBe(await b.certificatePem());
    expect((await verifyTimestampToken(ta, root, [await a.certificatePem()])).ok).toBe(true);
    expect(await verifyTimestampToken(ta, root, [await b.certificatePem()])).toEqual({ ok: false, error: "the signing certificate does not chain to a pinned certificate" });
    expect((await verifyTimestampToken(tb, root, [await a.certificatePem(), await b.certificatePem()])).ok).toBe(true);
    expect(await verifyTimestampToken(tb, root, [])).toEqual({ ok: false, error: "no pinned certificate for this authority" });
  });

  it("refuses bad requests with an RFC 3161 rejection", async () => {
    const a = local("reject", "2.25.9.9");
    const status = async (der: Uint8Array) => pkijs.TimeStampResp.fromBER(await a.respond(der)).status;
    expect((await status(new Uint8Array([1, 2, 3]))).status).toBe(pkijs.PKIStatus.rejection);
    const wrongPolicy = new pkijs.TimeStampReq({
      version: 1,
      messageImprint: pkijs.TimeStampReq.fromBER(timestampQuery(digest("p")).der).messageImprint,
      reqPolicy: "2.25.1.2",
    });
    const s = await status(new Uint8Array(wrongPolicy.toSchema().toBER()));
    expect(s.status).toBe(pkijs.PKIStatus.rejection);
    expect(s.failInfo?.valueBlock.valueHexView[1]).toBe(0x01); // unacceptedPolicy is bit 15
    const sha1 = new pkijs.TimeStampReq({
      version: 1,
      messageImprint: new pkijs.MessageImprint({ hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: "1.3.14.3.2.26" }), hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(20).buffer }) }),
    });
    expect((await status(new Uint8Array(sha1.toSchema().toBER()))).failInfo?.valueBlock.valueHexView[0]).toBe(0x80); // badAlg
    // The client side only ever asks for SHA-256 digests.
    expect(() => timestampQuery("abc")).toThrow(TsaError);
  });
});

// ---- a CA-issued authority certificate, to exercise chain building (as FreeTSA and DigiCert use) ----

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
function dn(cn: string) {
  return new pkijs.RelativeDistinguishedNames({ typesAndValues: [new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: cn }) })] });
}
async function issue(opts: { cn: string; publicKey: webcrypto.CryptoKey; issuer: string; signingKey: webcrypto.CryptoKey; ca: boolean; eku?: boolean }) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: Math.floor(Math.random() * 1e9) + 1 });
  cert.issuer = dn(opts.issuer);
  cert.subject = dn(opts.cn);
  cert.notBefore.value = new Date(Date.now() - 60_000);
  cert.notAfter.value = new Date(Date.now() + 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(opts.publicKey as never);
  cert.extensions = [
    new pkijs.Extension({ extnID: "2.5.29.19", critical: true, extnValue: new pkijs.BasicConstraints({ cA: opts.ca }).toSchema().toBER(false) }),
    new pkijs.Extension({ extnID: "2.5.29.15", critical: true, extnValue: new asn1js.BitString({ valueHex: new Uint8Array([opts.ca ? 0x06 : 0x80]).buffer, unusedBits: 1 }).toBER(false) }),
    ...(opts.eku === false || opts.ca ? [] : [new pkijs.Extension({ extnID: "2.5.29.37", critical: true, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.8"] }).toSchema().toBER(false) })]),
  ];
  await cert.sign(opts.signingKey as never, "SHA-256");
  return derToPem(cert.toSchema(true).toBER());
}

/** A TsaKey row whose certificate is issued by a fresh test CA; LocalTsa signs with it. */
async function caIssuedTsa(p: string, opts: { eku?: boolean } = {}) {
  const ca = await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  const caPem = await issue({ cn: `Test Root ${p}`, publicKey: ca.publicKey, issuer: `Test Root ${p}`, signingKey: ca.privateKey, ca: true });
  const leaf = await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  const id = tid(p);
  const certPem = await issue({ cn: `Test TSA ${id}`, publicKey: leaf.publicKey, issuer: `Test Root ${p}`, signingKey: ca.privateKey, ca: false, eku: opts.eku });
  const keyPem = derToPem(await webcrypto.subtle.exportKey("pkcs8", leaf.privateKey), "PRIVATE KEY");
  await prisma.tsaKey.create({ data: { id, name: `Test TSA ${id}`, certPem, privateKeyEnc: await keys.wrap(keyPem, { orgId: "platform:tsa", kid: id }) } });
  return { tsa: new LocalTsa({ db: prisma, keys }, id, `Test TSA ${id}`, "2.25.1.1"), caPem };
}

describe("HttpTsa (RFC 3161 over HTTP, against a fake local server)", () => {
  let server: Server;
  let url: URL;
  let mode: "ok" | "type" | "redirect" | "huge" | "replay" | "hang" | "status" = "ok";
  let backend: LocalTsa;
  let last: Uint8Array | undefined;
  const seen: { type?: string; accept?: string; method?: string }[] = [];

  beforeAll(async () => {
    backend = local("http");
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        seen.push({ type: req.headers["content-type"], accept: req.headers.accept, method: req.method });
        if (mode === "hang") return;
        if (mode === "redirect") return res.writeHead(302, { location: "http://127.0.0.1:1/" }).end();
        if (mode === "status") return res.writeHead(503).end();
        if (mode === "huge") return res.writeHead(200, { "content-type": "application/timestamp-reply" }).end(Buffer.alloc(2 * 1024 * 1024));
        const reply = mode === "replay" && last ? last : await backend.respond(new Uint8Array(Buffer.concat(chunks)));
        last = reply;
        res.writeHead(200, { "content-type": mode === "type" ? "text/html" : "application/timestamp-reply" }).end(Buffer.from(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tsr`);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const client = async (opts: { timeoutMs?: number; maxBytes?: number } = {}) => new HttpTsa("fake", "Fake TSA", url, [await backend.certificatePem()], { allowPrivate: true, ...opts });

  it("sends a timestamp query and accepts a verified token", async () => {
    mode = "ok";
    const root = digest("http-1");
    const t = await (await client()).stamp(root);
    expect(t).toMatchObject({ tsaId: "fake", tsaName: "Fake TSA", imprint: root });
    expect(seen.at(-1)).toEqual({ type: "application/timestamp-query", accept: "application/timestamp-reply", method: "POST" });
    expect((await verifyTimestampToken(t, root, [await backend.certificatePem()])).ok).toBe(true);
  });

  it("refuses a token that does not chain to the pinned CA", async () => {
    mode = "ok";
    const other = local("http-other");
    const tsa = new HttpTsa("fake", "Fake TSA", url, [await other.certificatePem()], { allowPrivate: true });
    await expect(tsa.stamp(digest("http-2"))).rejects.toThrow("the signing certificate does not chain to a pinned certificate");
  });

  it("refuses a replayed reply (nonce), a wrong content type, a redirect, an error status and an oversized reply", async () => {
    const c = await client();
    mode = "ok";
    await c.stamp(digest("http-3"));
    mode = "replay";
    await expect(c.stamp(digest("http-3"))).rejects.toThrow("the token's nonce is not the one sent");
    mode = "type";
    await expect(c.stamp(digest("http-4"))).rejects.toThrow("not application/timestamp-reply");
    mode = "redirect";
    await expect(c.stamp(digest("http-5"))).rejects.toThrow("redirects are not followed");
    mode = "status";
    await expect(c.stamp(digest("http-6"))).rejects.toThrow("the authority answered HTTP 503");
    mode = "huge";
    await expect(c.stamp(digest("http-7"))).rejects.toThrow("the authority's reply is too large");
    mode = "ok";
  });

  it("times out, and refuses private addresses unless allowed", async () => {
    mode = "hang";
    await expect((await client({ timeoutMs: 300 })).stamp(digest("http-8"))).rejects.toThrow("the authority did not answer in time");
    mode = "ok";
    const strict = new HttpTsa("fake", "Fake TSA", url, [await backend.certificatePem()]);
    await expect(strict.stamp(digest("http-9"))).rejects.toThrow("private or reserved");
    const byName = new URL(url);
    byName.hostname = "localhost";
    await expect(postTimestampQuery(byName, new Uint8Array([0]), { allowPrivate: false })).rejects.toThrow("private or reserved");
    await expect(postTimestampQuery(new URL("ftp://example.com/"), new Uint8Array([0]), { allowPrivate: true })).rejects.toThrow("not http(s)");
    await expect(postTimestampQuery(new URL("http://u:p@example.com/"), new Uint8Array([0]), { allowPrivate: true })).rejects.toThrow("credentials");
    await expect(postTimestampQuery(new URL("http://127.0.0.1:1/"), new Uint8Array([0]), { allowPrivate: true })).rejects.toThrow("could not be reached");
  });

  it("a CA-issued authority certificate chains to the pinned CA; without the timestamping EKU it is refused", async () => {
    const { tsa, caPem } = await caIssuedTsa("chain");
    const root = digest("chain-1");
    const q1 = timestampQuery(root);
    const t = await acceptReply(await tsa.respond(q1.der), q1, { id: tsa.id, name: tsa.name, trusted: [caPem] });
    expect(t.chain).toHaveLength(1);
    expect((await verifyTimestampToken(t, root, [caPem])).ok).toBe(true);
    // The CA is not in the token: chain building needs the pinned CA, and an unrelated CA does not do.
    const other = await caIssuedTsa("chain-other");
    expect(await verifyTimestampToken(t, root, [other.caPem])).toEqual({ ok: false, error: "the signing certificate does not chain to a pinned certificate" });

    const noEku = await caIssuedTsa("no-eku", { eku: false });
    const q = timestampQuery(root);
    await expect(acceptReply(await noEku.tsa.respond(q.der), q, { id: "x", name: "x", trusted: [noEku.caPem] })).rejects.toThrow("not a timestamping certificate");
  });
});

describe("TSA_AUTHORITIES", () => {
  const base = { ...process.env, TSA_AUTHORITIES: undefined, TSA_FREETSA_CA_PEM: undefined, TSA_DIGICERT_CA_PEM: undefined };

  it("defaults to the two local authorities", () => {
    expect(readGateEnv(base).TSA_AUTHORITIES).toEqual(["local-a", "local-b"]);
    expect(readGateEnv({ ...base, TSA_AUTHORITIES: " local-b , local-a " }).TSA_AUTHORITIES).toEqual(["local-b", "local-a"]);
  });

  it("refuses unknown, repeated or single authorities", () => {
    expect(() => readGateEnv({ ...base, TSA_AUTHORITIES: "local-a,emudhra" })).toThrow(/unknown timestamp authority emudhra/);
    expect(() => readGateEnv({ ...base, TSA_AUTHORITIES: "local-a,local-a" })).toThrow(/twice/);
    expect(() => readGateEnv({ ...base, TSA_AUTHORITIES: "local-a" })).toThrow(/at least two/);
  });

  it("needs a pinned CA for each hosted authority", async () => {
    expect(() => readGateEnv({ ...base, TSA_AUTHORITIES: "freetsa,digicert" })).toThrow(/TSA_FREETSA_CA_PEM: is required[\s\S]*TSA_DIGICERT_CA_PEM: is required/);
    expect(() => readGateEnv({ ...base, TSA_AUTHORITIES: "freetsa,local-a", TSA_FREETSA_CA_PEM: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----" })).toThrow(/TSA_FREETSA_CA_PEM: must hold/);
    const pem = await local("env").certificatePem();
    const e = readGateEnv({ ...base, TSA_AUTHORITIES: "freetsa,local-a", TSA_FREETSA_CA_PEM: pem.replaceAll("\n", "\\n") });
    expect(e.TSA_AUTHORITIES).toEqual(["freetsa", "local-a"]);
    expect(e.TSA_FREETSA_CA_PEM).toBe(pem);
  });
});
