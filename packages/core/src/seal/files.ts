// Reading and writing evidence bundles as files, and telling the two bundle families apart.
//
//   l1       core's own evidence bundle (gate-evidence-bundle/1, bundle.ts), or an auditor pack ZIP that wraps one
//   seal-v6  the console's formats the six-code verifier reads: the L2+ evidence bundle (elan1.evidence.bundle.v1,
//            8 members and the optional lexicon.json), the console's L1 auditor pack (auditor-pack/1), or receipts
//
// A Seal v6 bundle is a ZIP of its members (the console's bundleToZip) or one JSON document (the console's
// "bundle.json"). fflate is pure JavaScript, so this runs in a browser too.
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Receipt } from "./types";
import { LEXICON_MEMBER, SUPPORTED_FORMATS, l1PackFiles, type BundleManifest, type EvidenceBundle } from "./verify6";

export type BundleProfile = "l1" | "seal-v6";

/** Core's L1 bundle format and the name of the bundle inside an auditor pack (bundle.ts). */
const L1_FORMAT = "gate-evidence-bundle/1";
const L1_PACK_BUNDLE = "evidence-bundle.zip";
const MAX_UNZIPPED = 512 * 1024 * 1024;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const looksLikeReceipt = (x: unknown): x is Receipt => isObj(x) && "seq" in x && "hash" in x && "sig" in x;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Every file in the ZIP, by path, with the same size limit as bundle.ts. Throws on an unreadable or oversized ZIP. */
export function unzipLimited(zip: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(zip, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error("bundle is too large");
      return true;
    },
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The manifest a ZIP's manifest.json holds: bare, or wrapped as { manifest, manifest_sig | manifest_seal }. */
function manifestOf(value: unknown): Record<string, unknown> | undefined {
  if (!isObj(value)) return undefined;
  return isObj(value.manifest) ? value.manifest : value;
}

/**
 * Which verifier a file is for. ZIPs: core's L1 bundle and auditor packs that wrap one are `l1`; a ZIP whose
 * manifest names a console format (or a future elan1 format, which the six-code verifier answers UNSUPPORTED) is
 * `seal-v6`. Text that parses as JSON, or as JSON lines, is `seal-v6`. Anything else is `l1`, whose verifier
 * explains why it cannot be read, exactly as before.
 */
export function detectBundleProfile(bytes: Uint8Array): BundleProfile {
  if (isZip(bytes)) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipLimited(bytes);
    } catch {
      return "l1";
    }
    if (files[L1_PACK_BUNDLE]) return "l1";
    const root = zipRoot(Object.keys(files));
    const text = files[root + "manifest.json"];
    const m = text ? manifestOf(parseJson(strFromU8(text))) : undefined;
    if (!m || m.format === L1_FORMAT) return "l1";
    const format = m.bundle_format ?? m.format;
    return typeof format === "string" && (SUPPORTED_FORMATS.includes(format) || format.startsWith("elan1.")) ? "seal-v6" : "l1";
  }
  return readBundleText(strFromU8(bytes)) === undefined ? "l1" : "seal-v6";
}

/** A ZIP whose every member sits in one folder is read from inside that folder. */
function zipRoot(names: string[]): string {
  const first = names[0];
  return first !== undefined && names.every((n) => n.includes("/")) ? first.split("/")[0] + "/" : "";
}

/**
 * Read a bundle written as text: one JSON document (a bundle, a pack, a list of receipts) or receipts as JSON
 * lines. Returns undefined when the text is neither. The value is passed on as read: the verifier answers USAGE
 * for JSON that is not a bundle.
 */
export function readBundleText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const value = parseJson(trimmed);
  if (value === undefined) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return undefined;
    const rs = lines.map(parseJson);
    return rs.every(looksLikeReceipt) ? { manifest: {}, public_keys: {}, receipts: rs, checkpoints: [] } : undefined;
  }
  if (Array.isArray(value) && value.length && value.every(looksLikeReceipt)) return { manifest: {}, public_keys: {}, receipts: value, checkpoints: [] };
  if (isObj(value) && Array.isArray(value.receipts)) {
    return { ...value, manifest: isObj(value.manifest) ? value.manifest : {}, public_keys: isObj(value.public_keys) ? value.public_keys : {}, checkpoints: Array.isArray(value.checkpoints) ? value.checkpoints : [] };
  }
  return value;
}

/** Read a Seal v6 bundle or console auditor pack from its ZIP members (the console's parseFile). Throws on bad JSON. */
export function readEvidenceZip(zip: Uint8Array): unknown {
  const files = unzipLimited(zip);
  const names = Object.keys(files);
  const root = zipRoot(names);
  const t = (p: string) => (files[root + p] ? strFromU8(files[root + p]!) : undefined);
  const manifestText = t("manifest.json");
  if (manifestText === undefined) {
    const single = names.find((n) => /\.json$/i.test(n));
    if (single) return readBundleText(strFromU8(files[single]!));
    throw new Error("This ZIP holds no manifest.json. An evidence bundle has manifest.json, receipts.jsonl, seals.jsonl, checkpoints.json, anchors.json, keys.json, declarations.json and profile/.");
  }
  const jsonl = <T>(text?: string): T[] | undefined => (text === undefined ? undefined : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as T));
  const json = <T>(text?: string): T | undefined => (text === undefined ? undefined : (JSON.parse(text) as T));
  const wrapped = JSON.parse(manifestText) as Record<string, unknown>;
  const manifest = { ...((isObj(wrapped.manifest) ? wrapped.manifest : wrapped) as BundleManifest) };
  const manifest_sig = typeof wrapped.manifest_sig === "string" ? wrapped.manifest_sig : undefined;
  const manifest_seal = typeof wrapped.manifest_seal === "string" ? wrapped.manifest_seal : undefined;
  delete manifest.manifest_sig;
  delete manifest.manifest_seal;
  const l1 = manifest.format === "auditor-pack/1";
  const profileText = t("profile/profile.json");
  const bundle: Partial<EvidenceBundle> = {
    manifest,
    manifest_sig,
    manifest_seal,
    // L1 auditor pack: the PDF summary (its text is its bytes), the compliance map and the README
    summary_pdf: l1 ? t("summary.pdf") : undefined,
    compliance_map: l1 ? json(t("compliance-map.json")) : undefined,
    public_keys: json<Record<string, string>>(t("keys.json")) ?? {},
    receipts: jsonl<Receipt>(t("receipts.jsonl")) ?? json<Receipt[]>(t("receipts.json")) ?? [],
    checkpoints: json(t("checkpoints.json")) ?? [],
    seals: jsonl(t("seals.jsonl")),
    anchors: json(t("anchors.json")),
    declarations: json(t("declarations.json")),
    profile: profileText !== undefined ? (json<EvidenceBundle["profile"]>(profileText) ?? null) : undefined,
    readme: l1 ? t("README.txt") : t("profile/VERIFY.txt"),
    disclosures: json(t("disclosures.json")),
    // optional member (bundles made before 28 October 2026 have none)
    lexicon: l1 ? undefined : json(t(LEXICON_MEMBER)),
  };
  for (const k of Object.keys(bundle) as (keyof EvidenceBundle)[]) if (bundle[k] === undefined) delete bundle[k];
  return bundle;
}

/** Read any Seal v6 bundle file: a ZIP of members or text. Throws when it is neither. */
export function readEvidenceFile6(bytes: Uint8Array): unknown {
  if (isZip(bytes)) return readEvidenceZip(bytes);
  const value = readBundleText(strFromU8(bytes));
  if (value === undefined) throw new Error("This is not valid JSON or a ZIP.");
  return value;
}

/** The bundle (L2+) or console auditor pack (L1) as a ZIP with its members, the way the console exports it. */
export function bundle6ToZip(b: EvidenceBundle): Uint8Array {
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(b.manifest_sig ? { manifest: b.manifest, manifest_sig: b.manifest_sig } : b.manifest_seal ? { manifest: b.manifest, manifest_seal: b.manifest_seal } : b.manifest, null, 2),
    "receipts.jsonl": b.receipts.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "checkpoints.json": JSON.stringify(b.checkpoints, null, 2),
    "keys.json": JSON.stringify(b.public_keys, null, 2),
  };
  if (b.manifest.format === "auditor-pack/1") {
    // the same bytes the sealed manifest's file digests are taken over (l1PackFiles)
    for (const [path, text] of Object.entries(l1PackFiles(b))) if (text !== undefined) files[path] = text;
  } else {
    if (b.seals) files["seals.jsonl"] = b.seals.map((s) => JSON.stringify(s)).join("\n") + "\n";
    if (b.anchors) files["anchors.json"] = JSON.stringify(b.anchors);
    if (b.declarations) files["declarations.json"] = JSON.stringify(b.declarations, null, 2);
    if (b.profile !== undefined) files["profile/profile.json"] = JSON.stringify(b.profile, null, 2);
    if (b.readme !== undefined) files["profile/VERIFY.txt"] = b.readme;
    if (b.disclosures) files["disclosures.json"] = JSON.stringify(b.disclosures, null, 2);
    if (b.lexicon) files[LEXICON_MEMBER] = JSON.stringify(b.lexicon, null, 2);
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
}
