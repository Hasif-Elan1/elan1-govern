import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, KeyRing, omit, sha256, signText } from "@gate/core";
import { allOrgIds, type UpdateRecord } from "@gate/db";
import { z } from "zod";
import { adminEvent } from "./admin";
import { raiseAlert, type Deps } from "./deps";
import { releaseKeyList, releaseKeyPem } from "./env";

// Signed update bundles for deployments Elan1 does not run (the sovereign profile, carried in on
// media). A bundle is a directory: manifest.json plus one file per artifact. The manifest is JSON
// (no tar or zip to unpack), signed with Ed25519 by an Elan1 release key configured in
// UPDATE_SIGNING_PUBLIC_KEYS; it names every artifact with its SHA-256. Nothing is trusted at
// import: the signature and every hash are checked on import, again on stage, apply and rollback,
// so a file swapped on disk between steps is caught. "Apply" records the active version; the
// operator's own tooling installs the artifacts. Updates are platform-wide, so every step writes
// an admin receipt to every organisation's chain (there is no platform-level chain).

export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_FORMAT = "elan1.update.manifest.v1";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const ADVISORY_KEY = "elan1-govern:updates";

const Artifact = z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export const UpdateManifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    version: z.string().regex(/^\d{4}\.\d{1,3}\.\d{1,4}(?:[-.][a-z0-9]{1,20})?$/),
    createdAt: z.iso.datetime(),
    artifacts: z.array(Artifact).min(1).max(200),
    notes: z.union([z.string().max(4000), z.array(z.string().max(500)).max(50)]),
    /** Fingerprint of the release key that signed it (keyFingerprint of its PEM). */
    kid: z.string().regex(/^[0-9a-f]{16}$/),
    signature: z.string().max(200),
  })
  .strict()
  .refine((m) => new Set(m.artifacts.map((a) => a.name)).size === m.artifacts.length, { message: "artifact names must be unique", path: ["artifacts"] });
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;

/** The exact bytes a release signature covers: the canonical manifest without its signature. */
export function updateSigningPayload(m: Omit<UpdateManifest, "signature">): string {
  return canonicalize(omit(m as UpdateManifest, ["signature"]));
}

/** Elan1's release tooling (and the tests): sign a manifest with a release key. */
export function signManifest(m: Omit<UpdateManifest, "signature">, privateKeyPem: string): UpdateManifest {
  return { ...m, signature: signText(privateKeyPem, updateSigningPayload(m)) };
}

function releaseRing(deps: Deps): KeyRing | null {
  const pems = releaseKeyList(deps.env.UPDATE_SIGNING_PUBLIC_KEYS).map(releaseKeyPem).filter((p): p is string => !!p);
  return pems.length ? new KeyRing(pems.map((publicKeyPem) => ({ publicKeyPem }))) : null;
}

async function fileSha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export type Verified = { ok: true; manifest: UpdateManifest; manifestSha256: string } | { ok: false; error: string; version?: string };

/** Reads and checks a bundle directory: manifest shape, release signature, then every artifact's hash. */
export async function verifyBundle(deps: Deps, dir: string): Promise<Verified> {
  let text: string;
  try {
    const st = await lstat(join(dir, MANIFEST_FILE));
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return { ok: false, error: `${MANIFEST_FILE} is missing or too large` };
    text = await readFile(join(dir, MANIFEST_FILE), "utf8");
  } catch {
    return { ok: false, error: `no ${MANIFEST_FILE} in the bundle` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${MANIFEST_FILE} is not valid JSON` };
  }
  const parsed = UpdateManifestSchema.safeParse(raw);
  const version = typeof (raw as { version?: unknown })?.version === "string" ? ((raw as { version: string }).version.slice(0, 40)) : undefined;
  if (!parsed.success) return { ok: false, error: `the manifest is not a valid ${MANIFEST_FORMAT}: ${parsed.error.issues[0]?.path.join(".") || "manifest"} ${parsed.error.issues[0]?.message ?? ""}`.trim(), version };
  const m = parsed.data;
  const ring = releaseRing(deps);
  if (!ring) return { ok: false, error: "no release key is configured (UPDATE_SIGNING_PUBLIC_KEYS)", version };
  const sig = ring.verify(updateSigningPayload(m), m.signature, m.createdAt, m.kid);
  if (!sig.ok) return { ok: false, error: `the release signature does not verify: ${sig.reason}`, version };
  for (const a of m.artifacts) {
    const path = join(dir, a.name);
    try {
      // A regular file only: a symlink could point the hash check at something else.
      if (!(await lstat(path)).isFile()) return { ok: false, error: `${a.name} is not a regular file`, version };
      if ((await fileSha256(path)) !== a.sha256) return { ok: false, error: `${a.name} does not match its SHA-256 in the manifest`, version };
    } catch {
      return { ok: false, error: `${a.name} is missing from the bundle`, version };
    }
  }
  return { ok: true, manifest: m, manifestSha256: sha256(canonicalize(m)).slice(7) };
}

/** One admin receipt per organisation. A failure for one org is a health alert and does not stop the rest. */
async function receiptEveryOrg(deps: Deps, actor: string, action: string, details: Record<string, unknown>): Promise<number> {
  let n = 0;
  for (const orgId of await (deps.platformOrgs ?? (() => allOrgIds(deps.db)))()) {
    try {
      await adminEvent(deps, orgId, actor, action, details);
      n++;
    } catch (e) {
      await raiseAlert(deps, "update-receipt-failed", `Could not record ${action} for ${String(details.version ?? "")}: ${(e as Error).message}`, orgId);
    }
  }
  return n;
}

export type UpdateResult = { ok: true; record: UpdateRecord } | { ok: false; status: 400 | 404 | 409; error: string };

const short = (sha: string) => sha.slice(0, 16);

/** Import a bundle from a directory (removable media): verified, then recorded as `verified`. */
export async function importBundle(deps: Deps, dir: string, actor: string): Promise<UpdateResult> {
  const v = await verifyBundle(deps, dir);
  if (!v.ok) {
    await receiptEveryOrg(deps, actor, "update.rejected", { ...(v.version ? { version: v.version } : {}), step: "import", reason: v.error.slice(0, 200) });
    return { ok: false, status: 400, error: `The bundle was refused: ${v.error}.` };
  }
  const m = v.manifest;
  if (await deps.db.updateRecord.findUnique({ where: { version: m.version } })) return { ok: false, status: 409, error: `Version ${m.version} is already imported.` };
  const record = await deps.db.updateRecord.create({
    data: { version: m.version, manifest: m as object, manifestSha256: v.manifestSha256, kid: m.kid, sourceDir: dir, status: "verified", importedBy: actor },
  });
  await receiptEveryOrg(deps, actor, "update.imported", { version: m.version, manifest_sha256: short(v.manifestSha256), kid: m.kid, artifacts: m.artifacts.length });
  return { ok: true, record };
}

/** The bundle on disk must still be exactly the one that was imported. */
async function reverify(deps: Deps, r: UpdateRecord, step: string, actor: string): Promise<string | null> {
  const v = await verifyBundle(deps, r.sourceDir);
  const error = !v.ok ? v.error : v.manifestSha256 !== r.manifestSha256 ? "the manifest on disk is not the one that was imported" : null;
  if (error) await receiptEveryOrg(deps, actor, "update.rejected", { version: r.version, step, reason: error.slice(0, 200) });
  return error;
}

/** Stage a verified (or earlier rolled-back) version for apply, after checking it again. */
export async function stageUpdate(deps: Deps, version: string, actor: string): Promise<UpdateResult> {
  const r = await deps.db.updateRecord.findUnique({ where: { version } });
  if (!r) return { ok: false, status: 404, error: "No such update." };
  if (!["verified", "inactive", "rolled_back"].includes(r.status)) return { ok: false, status: 409, error: `Version ${version} is ${r.status}; only a verified version can be staged.` };
  const error = await reverify(deps, r, "stage", actor);
  if (error) return { ok: false, status: 400, error: `The bundle was refused: ${error}.` };
  const moved = await deps.db.updateRecord.updateMany({ where: { id: r.id, status: r.status }, data: { status: "staged", stagedBy: actor, stagedAt: new Date() } });
  if (moved.count !== 1) return { ok: false, status: 409, error: "The update changed while it was being staged. Try again." };
  await receiptEveryOrg(deps, actor, "update.staged", { version, manifest_sha256: short(r.manifestSha256), signature: "verified" });
  return { ok: true, record: await deps.db.updateRecord.findUniqueOrThrow({ where: { id: r.id } }) };
}

/** Apply a staged version: it becomes the active one, and the one before it is kept for rollback. */
export async function applyUpdate(deps: Deps, version: string, actor: string): Promise<UpdateResult> {
  const r = await deps.db.updateRecord.findUnique({ where: { version } });
  if (!r) return { ok: false, status: 404, error: "No such update." };
  if (r.status !== "staged") return { ok: false, status: 409, error: "Stage the update first." };
  const error = await reverify(deps, r, "apply", actor);
  if (error) return { ok: false, status: 400, error: `The bundle was refused: ${error}.` };
  const out = await deps.db.$transaction(async (tx) => {
    // One apply or rollback at a time across every gate instance.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_KEY}))`;
    const active = await tx.updateRecord.findFirst({ where: { status: "active" } });
    const moved = await tx.updateRecord.updateMany({ where: { id: r.id, status: "staged" }, data: { status: "active", appliedBy: actor, appliedAt: new Date(), previousVersion: active?.version ?? null } });
    if (moved.count !== 1) return null;
    if (active) await tx.updateRecord.update({ where: { id: active.id }, data: { status: "inactive" } });
    return { from: active?.version };
  });
  if (!out) return { ok: false, status: 409, error: "The update changed while it was being applied. Try again." };
  await receiptEveryOrg(deps, actor, "update.applied", { version, manifest_sha256: short(r.manifestSha256), ...(out.from ? { from_version: out.from } : {}) });
  return { ok: true, record: await deps.db.updateRecord.findUniqueOrThrow({ where: { id: r.id } }) };
}

/** Return to the version that was active before the running one, after checking that bundle again. */
export async function rollbackUpdate(deps: Deps, actor: string, reason: string): Promise<UpdateResult> {
  if (reason.trim().length < 10) return { ok: false, status: 400, error: "Give the reason for the rollback (at least 10 characters)." };
  const active = await deps.db.updateRecord.findFirst({ where: { status: "active" } });
  if (!active) return { ok: false, status: 409, error: "No update is active." };
  const prev = active.previousVersion ? await deps.db.updateRecord.findUnique({ where: { version: active.previousVersion } }) : null;
  if (!prev || prev.status !== "inactive") return { ok: false, status: 409, error: "There is no earlier applied version to return to." };
  const error = await reverify(deps, prev, "rollback", actor);
  if (error) return { ok: false, status: 400, error: `The earlier bundle was refused: ${error}.` };
  const ok = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_KEY}))`;
    const down = await tx.updateRecord.updateMany({ where: { id: active.id, status: "active" }, data: { status: "rolled_back", rolledBackBy: actor, rolledBackAt: new Date(), rollbackReason: reason.trim().slice(0, 500) } });
    const up = await tx.updateRecord.updateMany({ where: { id: prev.id, status: "inactive" }, data: { status: "active", appliedBy: actor, appliedAt: new Date() } });
    if (down.count !== 1 || up.count !== 1) throw new Error("rollback raced another change");
    return true;
  }).catch(() => false);
  if (!ok) return { ok: false, status: 409, error: "The updates changed during the rollback. Try again." };
  await receiptEveryOrg(deps, actor, "update.rolled_back", { version: active.version, to_version: prev.version, reason: reason.trim().slice(0, 200) });
  return { ok: true, record: await deps.db.updateRecord.findUniqueOrThrow({ where: { id: prev.id } }) };
}

/** The version this deployment runs, if an update has been applied. */
export function activeUpdate(deps: Deps) {
  return deps.db.updateRecord.findFirst({ where: { status: "active" } });
}
