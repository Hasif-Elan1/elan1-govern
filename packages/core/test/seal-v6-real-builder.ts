// Evidence bundles made of the artefacts the server really produces, for the six-code verifier: receipts written by
// the organisation's real chain (core's buildReceipt, read back with toConsoleReceipt), Seal v6 records over them
// signed with the chain key, chain-format checkpoints, Merkle batches over the `sha256:` receipt hashes stamped by
// real RFC 3161 authorities, raw-hex keys and an `ed25519:<base64>` manifest signature. Deterministic: a fixed key
// and fixed times. The timestamp tokens are frozen in fixtures/seal-v6-real/tsa.json: scripts/gen-rfc3161-fixture.mts
// asked the gate's own local authorities (apps/gate/src/tsa/local.ts) and OpenSSL (a hosted RSA authority's stand-in,
// accepted by the gate's own client checks) to stamp this builder's batch roots.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import "../src/seal/node";
import { encodeConsoleReceipt, publicKeyHex, toConsoleCheckpoint, toConsoleReceipt } from "../src/console-receipt";
import { keyFingerprint, signText as chainSign } from "../src/crypto";
import { buildReceipt, GENESIS, signCheckpoint as chainCheckpoint, type ChainHead, type Receipt as ChainReceipt, type ReceiptInput } from "../src/receipt";
import {
  BUNDLE_MEMBERS, base64ToBytes, bytesToBase64, digestOfFields, disclosureDigest, disclosureMessage, fieldValues, fieldValuesOf, fingerprintOf, manifestMessage,
  memberDigest, merkleRoot, pemToDer, redactionMessage, sealFields, sealPreimage,
  type AnchorBatch, type BundleManifest, type Checkpoint, type DisclosurePackage, type EvidenceBundle, type Receipt, type SealRecord, type TimestampToken,
  type TsaAuthority, type VerifyBundleOptions,
} from "../src/seal";

export const REAL_ORG = "org_real";
const T0 = Date.parse("2026-10-29T04:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export interface ChainKey {
  privateKeyPem: string;
  publicKeyPem: string;
  /** core's keyFingerprint of the PEM: the key's id on the chain and its published fingerprint */
  kid: string;
  /** the raw 32-byte key as hex: what keys.json carries */
  publicKeyHex: string;
}

/** An Ed25519 chain key from a fixed seed, as PEM the way the gate keeps it. */
export function chainKey(seedHex = "5e".repeat(32)): ChainKey {
  const priv = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seedHex}`, "hex"), format: "der", type: "pkcs8" });
  const publicKeyPem = createPublicKey(priv).export({ format: "pem", type: "spki" }).toString();
  return { privateKeyPem: priv.export({ format: "pem", type: "pkcs8" }).toString(), publicKeyPem, kid: keyFingerprint(publicKeyPem), publicKeyHex: publicKeyHex(publicKeyPem) };
}

/** The receipts' content in the console's shape: approval status and channel, outcome ms and environment included. */
const BODIES: Record<string, unknown>[] = [
  { kind: "admin", actor: "u_rahul", action: "rulebook.published", details: { rulebook: "invoice-bot", version: 3 } },
  { kind: "decision", agent: "invoice-bot", tool: "zoho_books.create_bill", args_summary: { amount: 1200, vendor: "Blue Dart" }, rulebook: { version: 3, hash: `sha256:${"ab".repeat(32)}` }, rule_id: "bills-under-cap", decision: "allow", reason: "Under the cap" },
  { kind: "decision", agent: "invoice-bot", tool: "zoho_books.record_payment", args_summary: { amount: 2500, bill: "BILL-7" }, rulebook: { version: 3, hash: `sha256:${"ab".repeat(32)}` }, rule_id: "payments", decision: "ask", reason: "Needs a person" },
  { kind: "approval", agent: "invoice-bot", tool: "zoho_books.record_payment", ref_seq: 3, decision: "allow", approval: { id: "apr_7", status: "approved", approver: "u_meera", channel: "web" } },
  { kind: "outcome", agent: "invoice-bot", tool: "zoho_books.record_payment", ref_seq: 3, outcome: { status: "ok", ref: "PAY-7", ms: 120 } },
  { kind: "decision", agent: "invoice-bot", tool: "zoho_books.delete_invoice", args_summary: { invoice: "INV-9" }, rulebook: { version: 3, hash: `sha256:${"ab".repeat(32)}` }, rule_id: "no-deletes", decision: "refuse", reason: "Agents never delete invoices" },
  { kind: "decision", agent: "treasury-sweeper", tool: "bank.initiate_transfer", args_summary: { amount: 50000, to_account: "EXT-SBIN-7781" }, rulebook: { version: 3, hash: `sha256:${"ab".repeat(32)}` }, rule_id: "transfers", decision: "allow", reason: "Bounded transfer" },
  { kind: "decision", agent: "invoice-bot", tool: "zoho_books.create_bill", args_summary: { amount: 900, vendor: "Nilgiri" }, rulebook: { version: 3, hash: `sha256:${"ab".repeat(32)}` }, rule_id: "bills-under-cap", decision: "allow", reason: "Under the cap", environment: "sandbox" },
];

/** Receipts before the organisation moved to L2 (no seal, not anchored), and receipts per Merkle batch. */
export const L1_COUNT = 2;
export const BATCH_SIZE = 3;

/** The chain as the gate writes it: core's buildReceipt over the encoded bodies, signed with the chain key. */
export function realChain(key = chainKey()): ChainReceipt[] {
  let head: ChainHead = GENESIS;
  return BODIES.map((body, i) => {
    const r = buildReceipt(encodeConsoleReceipt(body) as unknown as ReceiptInput, { org: REAL_ORG, ts: iso(T0 + i * 4 * 60_000), head, kid: key.kid }, key.privateKeyPem);
    head = { seq: r.seq, hash: r.hash };
    return r;
  });
}

/** The chain's receipts as the console reads them (and as the server's bundles carry them). */
export const realReceipts = (key = chainKey()): Receipt[] => realChain(key).map((r) => toConsoleReceipt(r) as unknown as Receipt);

/** The leaves of each Merkle batch: the console-form receipt hashes, `sha256:` prefix included. */
function batchLeaves(receipts: Receipt[]): string[][] {
  const out: string[][] = [];
  for (let i = L1_COUNT; i < receipts.length; i += BATCH_SIZE) out.push(receipts.slice(i, i + BATCH_SIZE).map((r) => r.hash));
  return out;
}

/** The batch roots the timestamp authorities stamp. */
export const realRoots = (): string[] => batchLeaves(realReceipts()).map((leaves) => merkleRoot(leaves));

/** What the fixture generator froze: each authority's certificate and the token it issued over each batch root. */
export interface TsaFixture {
  authorities: { id: string; name: string; scope: TsaAuthority["scope"]; policyOid: string; certPem: string }[];
  /** authority id → batch root → token */
  tokens: Record<string, Record<string, TimestampToken>>;
}

export interface RealOptions {
  /** the two authorities that stamp every batch (default the gate's local-a and local-b) */
  authorities?: [string, string];
  /** a receipt (by index, at L2) erased on a data principal's request: args_summary removed, the redaction signed, its seal's payload unbound */
  erase?: number;
}

export interface RealBuilt {
  bundle: EvidenceBundle;
  key: ChainKey;
  /** recompute the member digests and the manifest signature after a test changed the bundle */
  resign: (b: EvidenceBundle) => EvidenceBundle;
}

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function buildRealBundle(tsa: TsaFixture, o: RealOptions = {}): RealBuilt {
  const key = chainKey();
  const chain = realChain(key);
  const receipts = chain.map((r) => toConsoleReceipt(r) as unknown as Receipt);
  const count = receipts.length;

  // ── seals: Ed25519 over the 32 digest bytes with the chain key, F03 chaining from the last L1 receipt's hash
  const seals: SealRecord[] = [];
  let prevDigest = receipts[L1_COUNT - 1]!.hash;
  for (let i = L1_COUNT; i < count; i++) {
    const r = receipts[i]!;
    const fields = sealFields(r, { prevDigest, autonomy: "A0", recordVersion: 1, salt: String(i).padStart(32, "0"), lexiconHash: "cd".repeat(32), level: "l2" });
    const digest = digestOfFields(fields);
    const sig = sign(null, Buffer.from(digest, "hex"), key.privateKeyPem).toString("hex");
    // an erasure destroys the salt afterwards: the seal stays as it was sealed, marked unbound
    seals.push({ format: "elan1.seal.v6", seq: r.seq, receiptHash: r.hash, level: "l2", fields, preimageBytes: sealPreimage(fieldValues(fields)).length, digest, kid: key.kid, sig, ...(o.erase === i ? { payloadUnbound: true } : {}) });
    prevDigest = digest;
  }
  const exported = receipts.map((r, i) => {
    if (o.erase !== i) return r;
    const { args_summary: _a, ...rest } = r;
    const base: Receipt = { ...rest, redacted: { fields: ["args_summary"], reason: "erasure", request: "er_1", at: iso(T0 + 86_400_000), kid: key.kid } };
    return { ...base, redacted: { ...base.redacted!, sig: chainSign(key.privateKeyPem, redactionMessage(base)) } };
  });

  // ── anchors: two authorities stamp every batch root
  const [idA, idB] = o.authorities ?? ["local-a", "local-b"];
  const authorities: TsaAuthority[] = [idA, idB].map((id) => {
    const a = tsa.authorities.find((x) => x.id === id)!;
    return { id, name: a.name, scope: a.scope, url: "", policyOid: a.policyOid, publicKey: "", fingerprint: sha256Hex(pemToDer(a.certPem)![0]!).slice(0, 16), status: "operational", certPem: a.certPem };
  });
  const batches: (AnchorBatch & { leaves: string[] })[] = batchLeaves(receipts).map((leaves, b) => {
    const root = merkleRoot(leaves);
    const first = L1_COUNT + b * BATCH_SIZE;
    const rs = receipts.slice(first, first + leaves.length);
    const windowEnd = iso(Date.parse(rs[rs.length - 1]!.ts) + 60_000);
    const tokens = [idA, idB].map((id): TimestampToken => {
      const t = tsa.tokens[id]?.[root];
      if (!t) throw new Error(`no frozen token from ${id} over ${root}: regenerate fixtures/seal-v6-real (scripts/gen-rfc3161-fixture.mts)`);
      // the gate's anchoring job sets these from the window; they are not part of the token
      const delaySeconds = Math.max(0, Math.round((Date.parse(t.genTime) - Date.parse(windowEnd)) / 1000));
      return { ...clone(t), delaySeconds, status: delaySeconds > 900 ? "granted_late" : "granted" };
    });
    return { id: `b_${b + 1}`, windowStart: rs[0]!.ts, windowEnd, firstSeq: rs[0]!.seq, lastSeq: rs[rs.length - 1]!.seq, count: rs.length, root, tokens, status: "anchored", leaves };
  });

  // ── checkpoints: core's, signed over hashCanonical of the head statement, in the console's listing shape
  const checkpoints = [3, count - 1].map((i) => toConsoleCheckpoint(chainCheckpoint({ org: REAL_ORG, seq: chain[i]!.seq, hash: chain[i]!.hash, ts: iso(Date.parse(chain[i]!.ts) + 1000), kid: key.kid }, key.privateKeyPem)) as unknown as Checkpoint);

  // ── a disclosure package over the payment decision, signed with the chain key
  const r = receipts[2]!;
  const values: Record<string, string> = fieldValuesOf(r);
  const names = Object.keys(values).sort();
  const salts = Object.fromEntries(names.map((name, j) => [name, String(j).padStart(32, "0")]));
  const committed = names.map((name) => ({ name, digest: disclosureDigest(salts[name]!, name, values[name]!) }));
  const dBase = { orgId: REAL_ORG, seq: r.seq, receiptHash: r.hash, audience: "ar-org:auditor", expiresAt: "2099-12-31T00:00:00.000Z", committed };
  const disclosure: DisclosurePackage = {
    id: "dp_1", ...dBase, issuerName: "Real Org", createdAt: iso(T0), createdBy: "u_rahul", token: "fixture.0",
    revealed: ["decision", "tool"].map((name) => ({ name, salt: salts[name]!, value: values[name]! })),
    kid: key.kid, publicKey: key.publicKeyHex, sig: chainSign(key.privateKeyPem, disclosureMessage(dBase)), status: "active", views: 0,
  };

  const bundle: EvidenceBundle = {
    manifest: {},
    public_keys: { [key.kid]: key.publicKeyHex },
    receipts: exported,
    checkpoints,
    seals,
    anchors: { authorities, batches },
    declarations: { rulebooks: [{ slug: "invoice-bot", version: 3, hash: `sha256:${"ab".repeat(32)}`, signedBy: "u_rahul", signedAt: iso(T0 - 86_400_000) }] },
    profile: null,
    readme: "Real-format evidence bundle. Verify it offline: govern verify bundle.json",
    disclosures: [disclosure],
  };
  const manifestBase: BundleManifest = {
    format: "elan1.evidence.bundle.v1", bundle_format: "elan1.evidence.bundle.v1", issuer: "Elan1 Govern · real-format fixture", org: "Real Org", org_id: REAL_ORG, tenant_id: REAL_ORG,
    created_at: iso(T0 + 2 * 86_400_000), created_by: "system", receipts: count, record_count: count, refusal_count: exported.filter((x) => x.decision === "refuse").length,
    first_seq: receipts[0]!.seq, last_seq: receipts[count - 1]!.seq, checkpoints: checkpoints.length,
    keys: [{ kid: key.kid, fingerprint: key.kid, status: "active" }],
    assurance_levels: [{ level: "l1", count: L1_COUNT, first_seq: receipts[0]!.seq, last_seq: receipts[L1_COUNT - 1]!.seq }, { level: "l2", count: count - L1_COUNT, first_seq: receipts[L1_COUNT]!.seq, last_seq: receipts[count - 1]!.seq }],
    continuity_scope: "range", enforcement_mode: "enforced", redaction_profile: "none", unanchored_head: 0, signing_kid: key.kid, note: "Real-format fixture",
  };
  const resign = (b: EvidenceBundle): EvidenceBundle => {
    const contents: Record<string, unknown> = {
      "receipts.jsonl": b.receipts, "seals.jsonl": b.seals, "checkpoints.json": b.checkpoints, "anchors.json": b.anchors, "keys.json": b.public_keys, "declarations.json": b.declarations,
      "profile/ (profile.json + VERIFY.txt)": { profile: b.profile ?? null, readme: b.readme ?? "" },
    };
    const members = BUNDLE_MEMBERS.map((path) => (path === "manifest.json" ? { path, bytes: 0, sha256: "self" } : { path, ...memberDigest(contents[path] ?? null) }));
    const manifest = { ...(b.manifest.format ? b.manifest : manifestBase), members };
    return { ...b, manifest, manifest_sig: chainSign(key.privateKeyPem, manifestMessage(manifest)) };
  };
  return { bundle: resign(bundle), key, resign };
}

/* ── The cases both copies of the verifier are run on ───── */

export interface RealCase {
  name: string;
  input: EvidenceBundle;
  opts: VerifyBundleOptions;
  /** the result code the case must give */
  code: string;
}

/** Flip one byte of a base64 DER (by default its last: the end of the signature). */
export function flipDer(der: string, at?: number): string {
  const b = base64ToBytes(der)!;
  b[at ?? b.length - 1]! ^= 0x01;
  return bytesToBase64(b);
}

/** Every case: the real bundle passing, its variants, and each kind of tampering, re-signed so only that check fails. */
export function realCases(tsa: TsaFixture): RealCase[] {
  const base = buildRealBundle(tsa);
  const kid = base.key.kid;
  const pinned = { expectedFingerprint: kid };
  const edit = (built: RealBuilt, f: (b: EvidenceBundle) => void) => {
    const b = clone(built.bundle);
    f(b);
    return built.resign(b);
  };
  const erased = buildRealBundle(tsa, { erase: 6 });
  const hosted = buildRealBundle(tsa, { authorities: ["openssl-rsa-a", "openssl-rsa-b"] });
  const mixed = buildRealBundle(tsa, { authorities: ["local-a", "openssl-rsa-b"] });
  return [
    { name: "real: pinned to the chain kid", input: base.bundle, opts: pinned, code: "PASS" },
    { name: "real: key from the bundle", input: base.bundle, opts: {}, code: "PASS_KEY_FROM_BUNDLE" },
    { name: "real: hosted RSA authorities", input: hosted.bundle, opts: pinned, code: "PASS" },
    { name: "real: a local and a hosted authority", input: mixed.bundle, opts: pinned, code: "PASS" },
    { name: "real: an erased receipt, payload unbound", input: erased.bundle, opts: pinned, code: "PASS_PAYLOAD_UNBOUND" },
    { name: "real: pinned to the demo fingerprint of the same key", input: base.bundle, opts: { expectedFingerprint: fingerprintOf(base.key.publicKeyHex) }, code: "FAIL_INTEGRITY" },
    { name: "real: a byte of a token's DER flipped", input: edit(base, (b) => { b.anchors!.batches[0]!.tokens[0]!.der = flipDer(b.anchors!.batches[0]!.tokens[0]!.der!); }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: an RSA token's DER flipped", input: edit(hosted, (b) => { b.anchors!.batches[1]!.tokens[1]!.der = flipDer(b.anchors!.batches[1]!.tokens[1]!.der!); }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: a token's stored imprint changed", input: edit(base, (b) => { b.anchors!.batches[1]!.tokens[1]!.imprint = "00".repeat(32); }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: a token's stored serial changed", input: edit(base, (b) => { b.anchors!.batches[0]!.tokens[1]!.serial = "01"; }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: the authorities' certificates swapped", input: edit(base, (b) => { const [a, c] = b.anchors!.authorities; [a!.certPem, c!.certPem] = [c!.certPem, a!.certPem]; }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: an authority without its certificate", input: edit(base, (b) => { delete b.anchors!.authorities[0]!.certPem; }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: a real token stripped of its DER", input: edit(base, (b) => { delete b.anchors!.batches[0]!.tokens[0]!.der; }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: a receipt changed", input: edit(base, (b) => { b.receipts[4]!.reason = "edited"; }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: a checkpoint changed", input: edit(base, (b) => { b.checkpoints[0]!.ts = "2026-10-29T05:00:00.000Z"; }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: an erased receipt changed after its redaction", input: edit(erased, (b) => { b.receipts[6]!.decision = "refuse"; }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: a seal's signature broken", input: edit(base, (b) => { b.seals![2]!.sig = b.seals![2]!.sig.replace(/^./, (c) => (c === "0" ? "1" : "0")); }), opts: pinned, code: "FAIL_INTEGRITY" },
    { name: "real: the disclosure package changed", input: edit(base, (b) => { b.disclosures![0]!.audience = "someone-else"; }), opts: pinned, code: "FAIL_INTEGRITY" },
  ];
}
