// Freeze real RFC 3161 timestamp tokens over the batch roots of test/seal-v6-real-builder.ts into
// test/fixtures/seal-v6-real/, and what the approved console's own verifier says about every real-format case. Run
// once, from the repository root (it needs the openssl command):
//
//   node_modules/.bin/tsx --tsconfig apps/console/tsconfig.json packages/core/scripts/gen-rfc3161-fixture.mts [work-dir]
//
// OpenSSL's keys and files go in work-dir (default: a new directory under the system's temporary directory).
// The tokens are real: two authorities are the gate's own local timestamp authorities (apps/gate/src/tsa/local.ts,
// ECDSA P-256, self-signed certificates), run here against an in-memory stand-in for their TsaKey rows; two are
// OpenSSL's `ts -reply` with RSA keys (3072 bits with SHA-256 and an ESS signingCertificateV2, 4096 bits with SHA-512
// and an ESS signingCertificate over SHA-1), standing in for a hosted authority such as FreeTSA, which runs the same
// code. Every token is accepted by the gate's own client checks (acceptReply: nonce, imprint, signature, critical EKU,
// signing-certificate attribute, pinned certificate) before it is frozen.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

(globalThis as Record<string, unknown>).window = globalThis;
const root = new URL("../../../", import.meta.url);
const out = new URL("packages/core/test/fixtures/seal-v6-real/", root);
mkdirSync(out, { recursive: true });

await import(new URL("packages/core/src/seal/node.ts", root).href);
const builder = await import(new URL("packages/core/test/seal-v6-real-builder.ts", root).href);
const { LocalTsa } = await import(new URL("apps/gate/src/tsa/local.ts", root).href);
const { TSA_CATALOG } = await import(new URL("apps/gate/src/tsa/catalog.ts", root).href);
const token = await import(new URL("apps/gate/src/tsa/token.ts", root).href);
const v6 = await import(new URL("apps/console/src/lib/verify6.ts", root).href);
const crypto6 = await import(new URL("apps/console/src/lib/crypto.ts", root).href);

const roots: string[] = builder.realRoots();
type Token = Record<string, unknown>;
const authorities: { id: string; name: string; scope: string; policyOid: string; certPem: string }[] = [];
const tokens: Record<string, Record<string, Token>> = {};

// ── the gate's local authorities, with their key rows in memory and the private keys "wrapped" as they are
const rows = new Map<string, Record<string, unknown>>();
const db = {
  tsaKey: {
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> & { id: string } }) => (rows.set(data.id, data), data),
  },
};
const keys = { name: "fixture", wrap: async (pem: string) => pem, unwrap: async (enc: string) => enc };
for (const id of ["local-a", "local-b"] as const) {
  const entry = TSA_CATALOG[id];
  const tsa = new LocalTsa({ db, keys }, id, entry.name, entry.policyOid);
  authorities.push({ id, name: entry.name, scope: "Local", policyOid: entry.policyOid, certPem: await tsa.certificatePem() });
  tokens[id] = {};
  for (const r of roots) tokens[id]![r] = await tsa.stamp(r);
}

// ── OpenSSL as a hosted RSA authority: its replies go through the gate's own client checks
const work = process.argv[2] ? mkdtempSync(join(process.argv[2], "rfc3161-fixture-")) : mkdtempSync(join(tmpdir(), "rfc3161-fixture-"));
const hosted = [
  { id: "openssl-rsa-a", name: "OpenSSL RSA TSA A (hosted stand-in)", bits: 3072, digest: "sha256", ess: "sha256", policyOid: "1.2.3.4.1" },
  { id: "openssl-rsa-b", name: "OpenSSL RSA TSA B (hosted stand-in)", bits: 4096, digest: "sha512", ess: "sha1", policyOid: "1.2.3.4.2" },
];
const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
for (const h of hosted) {
  writeFileSync(join(work, `${h.id}.req.cnf`), [
    "[ req ]", "distinguished_name = dn", "prompt = no", "x509_extensions = ext",
    "[ dn ]", "O = Fixture Hosted TSA", `CN = ${h.name}`,
    "[ ext ]", "basicConstraints = critical,CA:FALSE", "keyUsage = critical,digitalSignature,nonRepudiation", "extendedKeyUsage = critical,timeStamping", "subjectKeyIdentifier = hash", "",
  ].join("\n"));
  openssl("req", "-x509", "-config", `${h.id}.req.cnf`, "-newkey", `rsa:${h.bits}`, "-nodes", "-keyout", `${h.id}.key`, "-out", `${h.id}.crt`, "-days", "3650");
  writeFileSync(join(work, `${h.id}.serial`), "1000\n");
  writeFileSync(join(work, `${h.id}.tsa.cnf`), [
    "[ tsa ]", `default_tsa = ${h.id}`,
    `[ ${h.id} ]`, `signer_cert = ${join(work, `${h.id}.crt`)}`, `signer_key = ${join(work, `${h.id}.key`)}`, `serial = ${join(work, `${h.id}.serial`)}`,
    `signer_digest = ${h.digest}`, `default_policy = ${h.policyOid}`, "digests = sha256, sha384, sha512", "accuracy = secs:1", "ordering = no", "tsa_name = no",
    "ess_cert_id_chain = no", `ess_cert_id_alg = ${h.ess}`, "",
  ].join("\n"));
  const certPem = readFileSync(join(work, `${h.id}.crt`), "utf8");
  authorities.push({ id: h.id, name: h.name, scope: "Global", policyOid: h.policyOid, certPem });
  tokens[h.id] = {};
  for (const r of roots) {
    const query = token.timestampQuery(r);
    writeFileSync(join(work, "query.tsq"), query.der);
    openssl("ts", "-reply", "-config", `${h.id}.tsa.cnf`, "-section", h.id, "-queryfile", "query.tsq", "-out", "reply.tsr");
    tokens[h.id]![r] = await token.acceptReply(new Uint8Array(readFileSync(join(work, "reply.tsr"))), query, { id: h.id, name: h.name, trusted: [certPem] });
  }
}

// the console's TimestampToken fields a real token carries beside the gate's: no modelled signature
for (const byRoot of Object.values(tokens)) for (const [r, t] of Object.entries(byRoot)) byRoot[r] = { ...t, status: "granted", sig: "", delaySeconds: 0 };
const fixture = { authorities, tokens };

const write = (name: string, value: unknown) => {
  const text = JSON.stringify(value, null, 1) + "\n";
  writeFileSync(new URL(name, out), text);
  console.log(name, `${Math.round(text.length / 1024)} KB`);
};
write("tsa.json", fixture);

// ── how asn1js (pkijs, the gate's stored tokens) writes object identifiers, sub-identifiers of every length included
const asn1js = createRequire(new URL("apps/gate/package.json", root))("asn1js");
const arcs = ["2a864886f70d010702", "608648016503040201", "2a0304", "2a030401", "69f0fed59faeefa29b8dd0cf9dbdf0ebf9c1170102", "2b0601040182371402", "8180808080808001", "2a" + "ff".repeat(7) + "7f", "2a" + "81".repeat(7) + "00", "2a" + "ff".repeat(8) + "7f", "ff".repeat(9) + "7f03"];
write("asn1js-oids.json", arcs.map((hex) => {
  const der = Buffer.from(`06${(hex.length / 2).toString(16).padStart(2, "0")}${hex}`, "hex");
  const parsed = asn1js.fromBER(new Uint8Array(der));
  if (parsed.offset === -1) throw new Error(`asn1js cannot read ${hex}`);
  return { hex, asn1js: parsed.result.valueBlock.toString() };
}));

// ── what the console's own verifier says about every real-format case
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const strip = (r: Record<string, unknown>) => {
  const { ms: _ms, chain, ...rest } = r;
  void _ms;
  if (chain && typeof chain === "object") {
    const { ms: _c, ...c } = chain as Record<string, unknown>;
    void _c;
    return { ...rest, chain: c };
  }
  return rest;
};
const results: Record<string, unknown> = {};
for (const c of builder.realCases(JSON.parse(JSON.stringify(fixture)))) {
  const input = JSON.stringify(c.input);
  const r = v6.verifyBundle(JSON.parse(input), c.opts);
  if (r.code !== c.code) throw new Error(`${c.name}: the console's verifier says ${r.code}, the case expects ${c.code}`);
  const report = v6.reportSections(r, c.input.manifest, {}).map((s: { lines: { label: string }[] }) => ({ ...s, lines: s.lines.filter((l) => l.label !== "Time taken") }));
  const result = strip(r);
  const summary = { code: r.code, exitCode: r.exitCode, headline: r.headline, variants: r.variants, sections: r.sections.map((x: { id: string; state: string; detail: string }) => `${x.id}:${x.state}: ${x.detail}`), notes: r.notes };
  results[c.name] = { inputDigest: sha(input), summary, resultDigest: sha(crypto6.canonical(result)), reportDigest: sha(crypto6.canonical(report)) };
}
write("console-results.json", results);
console.log(`${Object.keys(results).length} cases, ${roots.length} batch roots, ${authorities.length} authorities`);
