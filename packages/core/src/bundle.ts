import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { omit } from "./canonical";
import { hashCanonical, keyFingerprint, sha256, signText, verifyText } from "./crypto";
import { CheckpointSchema, verifyChain, type ChainHead, type Checkpoint, type Receipt, type VerifyResult } from "./receipt";

export const BUNDLE_FORMAT = "gate-evidence-bundle/1";
const MAX_UNZIPPED = 512 * 1024 * 1024;

const ManifestSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    org: z.object({ id: z.string(), name: z.string() }).strict(),
    generated_at: z.string(),
    range: z.object({ from: z.string(), to: z.string() }).strict(),
    anchor: z.object({ seq: z.number().int().min(0), hash: z.string() }).strict(),
    count: z.number().int().min(0),
    last_seq: z.number().int().min(0),
    last_hash: z.string(),
    key_fingerprint: z.string(),
    files: z.record(z.string()),
    sig: z.string(),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

const README = `Gate evidence bundle

receipts.jsonl    one signed receipt per line, in chain order
checkpoints.json  signed chain heads
public_key.pem    the organisation's Gate public key
manifest.json     what this bundle covers, signed

Verify it offline:  gate verify <this-file>.zip
Compare the key fingerprint printed by the verifier with the one shown in Gate under Evidence.
`;

export function buildBundle(input: {
  org: { id: string; name: string };
  range: { from: string; to: string };
  anchor: ChainHead;
  receipts: readonly Receipt[];
  checkpoints: readonly Checkpoint[];
  publicKeyPem: string;
  privateKeyPem: string;
  generatedAt: string;
}): Uint8Array {
  const files: Record<string, string> = {
    "receipts.jsonl": input.receipts.map((r) => JSON.stringify(r)).join("\n") + (input.receipts.length ? "\n" : ""),
    "checkpoints.json": JSON.stringify(input.checkpoints, null, 2),
    "public_key.pem": input.publicKeyPem,
  };
  const last = input.receipts[input.receipts.length - 1];
  const unsigned = {
    format: BUNDLE_FORMAT,
    org: input.org,
    generated_at: input.generatedAt,
    range: input.range,
    anchor: input.anchor,
    count: input.receipts.length,
    last_seq: last?.seq ?? input.anchor.seq,
    last_hash: last?.hash ?? input.anchor.hash,
    key_fingerprint: keyFingerprint(input.publicKeyPem),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])),
  };
  const manifest = { ...unsigned, sig: signText(input.privateKeyPem, hashCanonical(unsigned)) };
  const zipFiles: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), "README.txt": strToU8(README) };
  for (const [k, v] of Object.entries(files)) zipFiles[k] = strToU8(v);
  return zipSync(zipFiles, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
}

export type BundleResult = (VerifyResult & { fingerprint?: string; org?: string }) | { ok: false; seq: null; reason: string };

export function verifyBundle(zip: Uint8Array, opts: { expectedPublicKeyPem?: string } = {}): BundleResult {
  let files: Record<string, Uint8Array>;
  try {
    let total = 0;
    files = unzipSync(zip, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new Error("bundle is too large");
        return true;
      },
    });
  } catch (e) {
    return { ok: false, seq: null, reason: `not a readable bundle: ${(e as Error).message}` };
  }
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : undefined);
  const manifestText = read("manifest.json");
  const receiptsText = read("receipts.jsonl");
  const checkpointsText = read("checkpoints.json");
  const publicKeyPem = read("public_key.pem");
  if (manifestText === undefined || receiptsText === undefined || checkpointsText === undefined || publicKeyPem === undefined) {
    return { ok: false, seq: null, reason: "bundle is missing a file (manifest.json, receipts.jsonl, checkpoints.json, public_key.pem)" };
  }
  if (opts.expectedPublicKeyPem && keyFingerprint(opts.expectedPublicKeyPem) !== keyFingerprint(publicKeyPem)) {
    return { ok: false, seq: null, reason: "bundle was signed with a different key than the one you expected" };
  }

  let manifest: Manifest;
  let checkpoints: Checkpoint[];
  try {
    const m = ManifestSchema.safeParse(JSON.parse(manifestText));
    if (!m.success) return { ok: false, seq: null, reason: "manifest.json is malformed" };
    manifest = m.data;
    const cps = z.array(CheckpointSchema).safeParse(JSON.parse(checkpointsText));
    if (!cps.success) return { ok: false, seq: null, reason: "checkpoints.json is malformed" };
    checkpoints = cps.data;
  } catch {
    return { ok: false, seq: null, reason: "manifest.json or checkpoints.json is not valid JSON" };
  }
  const lines = receiptsText.split("\n").filter((l) => l.trim() !== "");
  const receipts: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      receipts.push(JSON.parse(lines[i] as string));
    } catch {
      return { ok: false, seq: manifest.anchor.seq + i + 1, reason: `line ${i + 1} of receipts.jsonl is not valid JSON` };
    }
  }

  const chain = verifyChain(receipts, publicKeyPem, { anchor: manifest.anchor, checkpoints });
  if (!chain.ok) return chain;

  if (!verifyText(publicKeyPem, hashCanonical(omit(manifest, ["sig"])), manifest.sig)) {
    return { ok: false, seq: null, reason: "manifest signature is invalid" };
  }
  if (chain.lastSeq < manifest.last_seq) {
    return { ok: false, seq: chain.lastSeq + 1, reason: `receipt ${chain.lastSeq + 1} is missing (bundle should end at ${manifest.last_seq})` };
  }
  if (chain.lastSeq !== manifest.last_seq || chain.lastHash !== manifest.last_hash || chain.count !== manifest.count) {
    return { ok: false, seq: chain.lastSeq, reason: "receipts do not match the signed manifest" };
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const text = read(name);
    if (text === undefined || sha256(text) !== expected) return { ok: false, seq: null, reason: `${name} does not match the manifest` };
  }
  return { ...chain, fingerprint: keyFingerprint(publicKeyPem), org: manifest.org.name };
}

/** Exposed for tests and tooling that build bundles by hand. */
export function readBundleFiles(zip: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]));
}

export function writeBundleFiles(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}


export const PACK_BUNDLE_NAME = "evidence-bundle.zip";

/** Accepts either an evidence bundle or an auditor pack that contains one. */
export function verifyEvidenceFile(zip: Uint8Array, opts: { expectedPublicKeyPem?: string } = {}): BundleResult {
  let inner: Uint8Array | undefined;
  try {
    inner = unzipSync(zip, { filter: (f) => f.name === PACK_BUNDLE_NAME && f.originalSize < MAX_UNZIPPED })[PACK_BUNDLE_NAME];
  } catch {
    inner = undefined;
  }
  return verifyBundle(inner ?? zip, opts);
}
