import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { signSamlPost } from "@node-saml/node-saml/lib/saml-post-signing";

// A test identity provider: keys and a self-signed X.509 certificate made at test time (nothing
// committed), and signed SAML responses with whatever flaws a test needs.

// ---- A minimal DER writer, enough for one self-signed certificate ----

const len = (n: number) => {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  for (let v = n; v; v >>= 8) b.unshift(v & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag: number, ...parts: Buffer[]) => {
  const c = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(c.length), c]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const int = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (s: string) => {
  const [a, b, ...rest] = s.split(".").map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const utcTime = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

export type Idp = { entityId: string; privateKeyPem: string; certPem: string };

/** A fresh RSA key and a self-signed certificate (valid from an hour ago for `days`, negative = already expired). */
export function makeIdp(entityId = `https://idp-${randomBytes(3).toString("hex")}.example/saml`, days = 365): Idp {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algo = seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00])); // sha256WithRSAEncryption
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("Test IdP")))));
  const from = new Date(Date.now() - 3_600_000 + (days < 0 ? days * 86_400_000 * 2 : 0));
  const to = new Date(Date.now() + days * 86_400_000);
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x3f) | 0x40; // positive, and minimal DER
  const tbs = seq(tlv(0xa0, int(Buffer.from([2]))), int(serial), algo, name, seq(utcTime(from), utcTime(to)), name, publicKey.export({ type: "spki", format: "der" }));
  const signature = sign("sha256", tbs, privateKey as KeyObject);
  const cert = seq(tbs, algo, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { entityId, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), certPem: pem("CERTIFICATE", cert) };
}

/** The request id inside an HTTP-Redirect AuthnRequest URL. */
export function requestIdOf(url: string): string {
  const xml = inflateRawSync(Buffer.from(new URL(url).searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  return /\bID="([^"]+)"/.exec(xml)![1]!;
}

export type ResponseOpts = {
  inResponseTo?: string | null;
  audience: string;
  email: string;
  issuer?: string;
  assertionId?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  /** Override the Conditions expiry alone (null: leave it out). */
  conditionsNotOnOrAfter?: Date | null;
  attributes?: Record<string, string>;
  /** Sign with this IdP's key (default), another key, or not at all. */
  signWith?: Idp | null;
  acs?: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** A base64 SAMLResponse with one assertion, signed (or not) as asked. */
export function samlResponse(idp: Idp, o: ResponseOpts): string {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const nb = o.notBefore ?? new Date(now.getTime() - 30_000);
  const na = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const cna = o.conditionsNotOnOrAfter === null ? "" : ` NotOnOrAfter="${iso(o.conditionsNotOnOrAfter ?? na)}"`;
  const irt = o.inResponseTo ? ` InResponseTo="${esc(o.inResponseTo)}"` : "";
  const issuer = esc(o.issuer ?? idp.entityId);
  const acs = esc(o.acs ?? "http://localhost:3000/api/auth/saml/acs");
  const attrs = Object.entries({ email: o.email, ...o.attributes })
    .map(([k, v]) => `<saml:Attribute Name="${esc(k)}"><saml:AttributeValue>${esc(v)}</saml:AttributeValue></saml:Attribute>`)
    .join("");
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString("hex")}" Version="2.0" IssueInstant="${iso(now)}" Destination="${acs}"${irt}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${esc(o.assertionId ?? `_a${randomBytes(8).toString("hex")}`)}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(o.email)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(na)}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(nb)}"${cna}><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  const signer = o.signWith === undefined ? idp : o.signWith;
  const out = signer
    ? signSamlPost(xml, "/*[local-name(.)='Response']/*[local-name(.)='Assertion']", { privateKey: signer.privateKeyPem, publicCert: signer.certPem, signatureAlgorithm: "sha256", digestAlgorithm: "sha256" })
    : xml;
  return Buffer.from(out, "utf8").toString("base64");
}
