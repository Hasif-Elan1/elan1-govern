import { join } from "node:path";
import { keyFingerprint } from "@gate/core";
import { forOrg, normalizeHost, type UpdateRecord } from "@gate/db";
import { z } from "zod";
import { adminEvent } from "../admin";
import { fail, wiringActor, type WiringRoutes } from "../console-wiring";
import type { Deps } from "../deps";
import { addEgressRule, removeEgressRule } from "../egress";
import { releaseKeyList, releaseKeyPem } from "../env";
import { applyUpdate, importBundle, rollbackUpdate, stageUpdate, UPDATE_VERSION } from "../updates";

/*
 * Sovereign deployment, for the console's Deployment screens (wiring): the organisation's internal allow-list
 * (EgressRule, with the console's "what it is for" as the rule's note), the egress-log export receipt, and the
 * signed update bundles (UpdateRecord, platform-wide). The real functions write the receipts (egress.ts,
 * updates.ts; update receipts go to every organisation's chain); each route answers with the seq of the one in
 * this organisation's chain, for the console's "Recorded as receipt #N".
 */

type P = { Params: { org: string } };

const schemas = {
  addHost: z.object({ actor: wiringActor, host: z.string().trim().min(1).max(253), note: z.string().trim().max(200).optional() }).strict(),
  removeHost: z.object({ actor: wiringActor, host: z.string().trim().min(1).max(253) }).strict(),
  exported: z.object({ actor: wiringActor, days: z.number().int().min(1).max(90), attempts: z.number().int().min(0).max(1_000_000), digest: z.string().regex(/^[0-9a-f]{16}$/) }).strict(),
  state: z.object({}).strict(),
  version: z.object({ actor: wiringActor, version: z.string().regex(UPDATE_VERSION) }).strict(),
  rollback: z.object({ actor: wiringActor, version: z.string().regex(UPDATE_VERSION), reason: z.string().max(500) }).strict(),
};

/** The newest receipt in this organisation's chain for an update step on `v`. */
async function seqOf(deps: Deps, orgId: string, action: string, v: string): Promise<number | null> {
  const r = await forOrg(orgId, deps.db).receipt.findFirst({ where: { action, body: { path: ["details", "version"], equals: v } }, orderBy: { seq: "desc" }, select: { seq: true } });
  return r?.seq ?? null;
}

/** A record as JSON (dates as ISO strings). */
export function recordJson(r: UpdateRecord) {
  return {
    id: r.id,
    version: r.version,
    manifest: r.manifest,
    manifestSha256: r.manifestSha256,
    kid: r.kid,
    status: r.status,
    previousVersion: r.previousVersion,
    importedBy: r.importedBy,
    importedAt: r.importedAt.toISOString(),
    stagedBy: r.stagedBy,
    stagedAt: r.stagedAt?.toISOString() ?? null,
    appliedBy: r.appliedBy,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    rolledBackBy: r.rolledBackBy,
    rolledBackAt: r.rolledBackAt?.toISOString() ?? null,
    rollbackReason: r.rollbackReason,
  };
}
export type UpdateRecordJson = ReturnType<typeof recordJson>;

/** The release key bundles must be signed with (the first configured), as the console's footer names it. */
function releaseKey(deps: Deps) {
  for (const k of releaseKeyList(deps.env.UPDATE_SIGNING_PUBLIC_KEYS)) {
    const pem = releaseKeyPem(k);
    if (pem) return { kid: keyFingerprint(pem), fingerprint: keyFingerprint(pem), publicKey: k };
  }
  return null;
}

export const egressRoutes: WiringRoutes = (r, w) => {
  const { deps } = w;

  // ---- The internal allow-list: one rule per host, any port and purpose, the console's purpose as its note ----
  r.post<P>("/internal/orgs/:org/wiring/egress/hosts", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.addHost, req.body);
    const out = await addEgressRule(deps, orgId, { host: b.host, port: null, purpose: null, ...(b.note ? { note: b.note } : {}), actor: b.actor });
    return w.send(reply, out.ok ? { id: out.id, seq: out.seq, host: normalizeHost(b.host) } : out);
  });

  r.post<P>("/internal/orgs/:org/wiring/egress/hosts/remove", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.removeHost, req.body);
    const rules = await forOrg(orgId, deps.db).egressRule.findMany({ where: { host: normalizeHost(b.host) }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!rules.length) return w.send(reply, fail(404, "That host is not on the allow-list."));
    let seq = 0;
    for (const rule of rules) {
      const out = await removeEgressRule(deps, orgId, rule.id, b.actor);
      if (out.ok) seq = out.seq;
    }
    return { seq, removed: rules.length };
  });

  // the log itself is read by the web app (EgressLog through forOrg); the export is a receipt
  r.post<P>("/internal/orgs/:org/wiring/egress/export", async (req) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.exported, req.body);
    const rec = await adminEvent(deps, orgId, b.actor, "egress.log_exported", { days: b.days, attempts: b.attempts, digest: b.digest });
    return { seq: rec.seq };
  });

  // ---- Signed update bundles (platform-wide) ----
  r.post<P>("/internal/orgs/:org/wiring/updates/state", async (req) => {
    await w.org(req.params.org);
    w.parse(schemas.state, req.body);
    const rows = await deps.db.updateRecord.findMany({ orderBy: { importedAt: "desc" } });
    return { records: rows.map(recordJson), release: releaseKey(deps), importDir: !!deps.env.UPDATE_IMPORT_DIR };
  });

  r.post<P>("/internal/orgs/:org/wiring/updates/import", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.version, req.body);
    const root = deps.env.UPDATE_IMPORT_DIR;
    if (!root) return w.send(reply, fail(409, "This deployment has no update folder (UPDATE_IMPORT_DIR), so bundles cannot be imported from the console. The operator sets it, then copies each bundle from the media into a folder named for its version."));
    // the version pattern allows no separator and no "..": the bundle is one folder directly under the root
    const out = await importBundle(deps, join(root, b.version), b.actor);
    if (!out.ok) return w.send(reply, out);
    return { record: recordJson(out.record), seq: await seqOf(deps, orgId, "update.imported", b.version) };
  });

  r.post<P>("/internal/orgs/:org/wiring/updates/stage", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.version, req.body);
    const out = await stageUpdate(deps, b.version, b.actor);
    if (!out.ok) return w.send(reply, out);
    return { record: recordJson(out.record), seq: await seqOf(deps, orgId, "update.staged", b.version) };
  });

  // a bundle that was rolled back is still verified in the console's words: applying it again stages it first
  r.post<P>("/internal/orgs/:org/wiring/updates/apply", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.version, req.body);
    const row = await deps.db.updateRecord.findUnique({ where: { version: b.version }, select: { status: true } });
    if (row?.status === "rolled_back") {
      const staged = await stageUpdate(deps, b.version, b.actor);
      if (!staged.ok) return w.send(reply, staged);
    }
    const out = await applyUpdate(deps, b.version, b.actor);
    if (!out.ok) return w.send(reply, out);
    return { record: recordJson(out.record), seq: await seqOf(deps, orgId, "update.applied", b.version) };
  });

  r.post<P>("/internal/orgs/:org/wiring/updates/rollback", async (req, reply) => {
    const orgId = await w.org(req.params.org);
    const b = w.parse(schemas.rollback, req.body);
    const active = await deps.db.updateRecord.findFirst({ where: { status: "active" }, select: { version: true } });
    if (active?.version !== b.version) return w.send(reply, fail(409, "Only the bundle running now can be rolled back."));
    const out = await rollbackUpdate(deps, b.actor, b.reason);
    if (!out.ok) return w.send(reply, out);
    return { record: recordJson(out.record), from: b.version, to: out.record.version, seq: await seqOf(deps, orgId, "update.rolled_back", b.version) };
  });
};
