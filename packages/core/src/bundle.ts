import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { omit } from "./canonical";
import { hashCanonical, keyFingerprint, sha256, signText, verifyText } from "./crypto";
import type { PublicKeyInfo } from "./keys";
import { CheckpointSchema, verifyChain, type ChainHead, type Checkpoint, type Receipt, type VerifyResult } from "./receipt";

export const BUNDLE_FORMAT = "gate-evidence-bundle/1";
const MAX_UNZIPPED = 512 * 1024 * 1024;

const ManifestKeySchema = z.object({ kid: z.string(), created_at: z.string().optional(), retired_at: z.string().nullable().optional() }).strict();

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
    /** The key that signed this manifest. Absent in bundles made before key rotation. */
    kid: z.string().optional(),
    /** Every signing key the org has had, with when each was retired. */
    keys: z.array(ManifestKeySchema).optional(),
    files: z.record(z.string(), z.string()),
    sig: z.string(),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

const README = `Gate evidence bundle

receipts.jsonl    one signed receipt per line, in chain order
checkpoints.json  signed chain heads
public_key.pem    the organisation's current Gate public key
public_keys.json  every Gate public key the organisation has used, by key id
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
  /** The current key: signs the manifest and is written as public_key.pem. */
  publicKeyPem: string;
  privateKeyPem: string;
  /** All of the org's keys, current and retired. Omit for an org with one key. */
  publicKeys?: readonly PublicKeyInfo[];
  generatedAt: string;
}): Uint8Array {
  const files: Record<string, string> = {
    "receipts.jsonl": input.receipts.map((r) => JSON.stringify(r)).join("\n") + (input.receipts.length ? "\n" : ""),
    "checkpoints.json": JSON.stringify(input.checkpoints, null, 2),
    "public_key.pem": input.publicKeyPem,
  };
  const kid = keyFingerprint(input.publicKeyPem);
  const keys = input.publicKeys?.length ? input.publicKeys : undefined;
  if (keys) files["public_keys.json"] = JSON.stringify(Object.fromEntries(keys.map((k) => [keyFingerprint(k.publicKeyPem), k.publicKeyPem])), null, 2);
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
    key_fingerprint: kid,
    ...(keys
      ? {
          kid,
          keys: keys.map((k) => ({
            kid: keyFingerprint(k.publicKeyPem),
            ...(k.createdAt ? { created_at: k.createdAt } : {}),
            retired_at: k.retiredAt ?? null,
          })),
        }
      : {}),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])),
  };
  const manifest = { ...unsigned, sig: signText(input.privateKeyPem, hashCanonical(unsigned)) };
  const zipFiles: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), "README.txt": strToU8(README) };
  for (const [k, v] of Object.entries(files)) zipFiles[k] = strToU8(v);
  return zipSync(zipFiles, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
}

export interface BundleKey {
  kid: string;
  retiredAt: string | null;
}

export type BundleResult = (VerifyResult & { fingerprint?: string; org?: string; keys?: BundleKey[] }) | { ok: false; seq: null; reason: string };

type Fail = { ok: false; seq: null; reason: string };
const fail = (reason: string): Fail => ({ ok: false, seq: null, reason });

/** public_keys.json: kid -> PEM, where every kid must be that PEM's fingerprint. */
function readPublicKeys(text: string | undefined, current: string): Record<string, string> | Fail {
  if (text === undefined) return { [keyFingerprint(current)]: current };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("public_keys.json is not valid JSON");
  }
  const r = z.record(z.string(), z.string()).safeParse(parsed);
  if (!r.success) return fail("public_keys.json is malformed");
  for (const [kid, pem] of Object.entries(r.data)) {
    if (keyFingerprint(pem) !== kid) return fail(`public_keys.json names key ${kid} by the wrong id`);
  }
  if (!r.data[keyFingerprint(current)]) return fail("public_key.pem is not listed in public_keys.json");
  return r.data;
}

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
    return fail(`not a readable bundle: ${(e as Error).message}`);
  }
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : undefined);
  const manifestText = read("manifest.json");
  const receiptsText = read("receipts.jsonl");
  const checkpointsText = read("checkpoints.json");
  const publicKeyPem = read("public_key.pem");
  if (manifestText === undefined || receiptsText === undefined || checkpointsText === undefined || publicKeyPem === undefined) {
    return fail("bundle is missing a file (manifest.json, receipts.jsonl, checkpoints.json, public_key.pem)");
  }
  if (opts.expectedPublicKeyPem && keyFingerprint(opts.expectedPublicKeyPem) !== keyFingerprint(publicKeyPem)) {
    return fail("bundle was signed with a different key than the one you expected");
  }
  const pems = readPublicKeys(read("public_keys.json"), publicKeyPem);
  if ("ok" in pems) return pems as Fail;

  let manifest: Manifest;
  let checkpoints: Checkpoint[];
  try {
    const m = ManifestSchema.safeParse(JSON.parse(manifestText));
    if (!m.success) return fail("manifest.json is malformed");
    manifest = m.data;
    const cps = z.array(CheckpointSchema).safeParse(JSON.parse(checkpointsText));
    if (!cps.success) return fail("checkpoints.json is malformed");
    checkpoints = cps.data;
  } catch {
    return fail("manifest.json or checkpoints.json is not valid JSON");
  }
  if (Object.keys(pems).length > 1 && !manifest.keys) return fail("manifest.json does not list the bundle's keys");
  const retiredAt = new Map((manifest.keys ?? []).map((k) => [k.kid, k.retired_at ?? null]));
  const keys: PublicKeyInfo[] = Object.entries(pems).map(([kid, pem]) => ({ kid, publicKeyPem: pem, retiredAt: retiredAt.get(kid) ?? null }));

  const lines = receiptsText.split("\n").filter((l) => l.trim() !== "");
  const receipts: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      receipts.push(JSON.parse(lines[i] as string));
    } catch {
      return { ok: false, seq: manifest.anchor.seq + i + 1, reason: `line ${i + 1} of receipts.jsonl is not valid JSON` };
    }
  }

  const chain = verifyChain(receipts, keys, { anchor: manifest.anchor, checkpoints });
  if (!chain.ok) return chain;

  // The manifest is signed by the current key, whatever its own kid field claims.
  const manifestKid = keyFingerprint(publicKeyPem);
  if (manifest.kid !== undefined && manifest.kid !== manifestKid) return fail("manifest names a different signing key than public_key.pem");
  if (!verifyText(publicKeyPem, hashCanonical(omit(manifest, ["sig"])), manifest.sig)) {
    return fail("manifest signature is invalid");
  }
  if (chain.lastSeq < manifest.last_seq) {
    return { ok: false, seq: chain.lastSeq + 1, reason: `receipt ${chain.lastSeq + 1} is missing (bundle should end at ${manifest.last_seq})` };
  }
  if (chain.lastSeq !== manifest.last_seq || chain.lastHash !== manifest.last_hash || chain.count !== manifest.count) {
    return { ok: false, seq: chain.lastSeq, reason: "receipts do not match the signed manifest" };
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const text = read(name);
    if (text === undefined || sha256(text) !== expected) return fail(`${name} does not match the manifest`);
  }
  if (files["public_keys.json"] && !manifest.files["public_keys.json"]) return fail("public_keys.json is not covered by the manifest");
  return { ...chain, fingerprint: manifestKid, org: manifest.org.name, keys: keys.map((k) => ({ kid: k.kid as string, retiredAt: k.retiredAt ?? null })) };
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
