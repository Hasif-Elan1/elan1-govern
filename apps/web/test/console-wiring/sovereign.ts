import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, generateKeyPair, keyFingerprint, omit, signText } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastReceipt, type Harness } from "./harness";

// Sovereign deployment (apps/web/src/server/console-overrides/wiring/sovereign.ts): Deccan's Deployment screens on
// the real EgressRule and EgressLog rows and the real update records.

const ORG = "org_deccan";
const OWNER = "u_suresh";
const ADMIN = "u_anjali";
const APPROVER = "u_dc_prakash";
const VIEWER = "u_dc_sunita";
const SEEDED = ["siem.deccanbank.internal", "smtp-relay.deccanbank.internal", "itsm.deccanbank.internal"];
const HOST = "ledger.deccanbank.internal";
const BLOCKED_HOST = "api.wiring-test.example";

type GateDeps = { env: Record<string, unknown>; platformOrgs?: () => Promise<string[]> };
type Host = { host: string; purpose: string; addedBy: string; seq?: number };
type Attempt = { id: string; destination: string; component: string; seq?: number };
type Bundle = { id: string; version: string; status: string; seq?: number; rolledBackAt?: string; restoredFrom?: string; firstAppliedSeq?: number; verified?: boolean };

const release = generateKeyPair();
const b64 = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const run = randomBytes(3).toString("hex");

/** A signed bundle in `<root>/<version>`, as Elan1's release tooling writes it (apps/gate/src/updates.ts). */
async function bundle(root: string, version: string, opts: { tamper?: boolean } = {}) {
  const dir = join(root, version);
  await mkdir(dir, { recursive: true });
  const files = { "gate.img": `gate ${version} ${run}`, "web.img": `web ${version} ${run}` };
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  const m = { format: "elan1.update.manifest.v1", version, createdAt: new Date().toISOString(), artifacts: Object.entries(files).map(([name, body]) => ({ name, sha256: sha(body) })), notes: ["Fixes for the wiring test"], kid: keyFingerprint(release.publicKeyPem) };
  const signed = { ...m, signature: signText(release.privateKeyPem, canonicalize(omit(m as typeof m & { signature?: string }, ["signature"]))) };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(signed));
  if (opts.tamper) await writeFile(join(dir, "web.img"), "swapped after signing");
  return dir;
}

export function sovereignCases(h: Harness) {
  describe("sovereign deployment on the real egress rules, egress log and update records (org_deccan)", () => {
    const deps = h.gate.deps as unknown as GateDeps;
    const saved = { env: deps.env, platformOrgs: deps.platformOrgs };
    let root = "";

    const egress = (as = VIEWER) => h.rpc("sovereign.egress", [ORG, 7], as);
    const deployment = async (as = ADMIN) => {
      const r = await h.rpc("api.deployment", [ORG], as);
      expect(r.status, r.body.error).toBe(200);
      return r.body.result as { updates: Bundle[]; release: { kid: string }; egress: { allowList: string[]; blockedLast24h: number } };
    };

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "wiring-updates-"));
      // the gate reads these at call time; update receipts go to Deccan's chain only, so the other areas' chains stay as they are
      deps.env = { ...saved.env, UPDATE_SIGNING_PUBLIC_KEYS: b64(release.publicKeyPem), UPDATE_IMPORT_DIR: root };
      deps.platformOrgs = async () => [ORG];
      // what an earlier run left behind (the seeded hosts stay); update versions are platform-wide
      await forOrg(ORG).egressRule.deleteMany({ where: { host: { notIn: SEEDED } } });
      await prisma.egressLog.deleteMany({ where: { host: BLOCKED_HOST } });
      await forOrg(ORG).webhook.deleteMany({ where: { url: { contains: HOST } } });
      await prisma.updateRecord.deleteMany({});
      await h.reset(ORG);
    });
    afterAll(async () => {
      deps.env = saved.env;
      deps.platformOrgs = saved.platformOrgs;
      await rm(root, { recursive: true, force: true });
    });

    it("lists the internal allow-list from EgressRule and the egress log from the blocked EgressLog rows, Deccan's only", async () => {
      expect((await forOrg(ORG).egressRule.findMany({ where: { host: { in: SEEDED } } })).map((r) => r.host).sort()).toEqual([...SEEDED].sort());
      const mine = await forOrg(ORG).egressLog.create({ data: { orgId: ORG, host: BLOCKED_HOST, port: 443, purpose: "webhook", decision: "blocked", profile: "sovereign", reason: "not on this deployment's allow-list" } });
      const theirs = await forOrg("org_kaveri").egressLog.create({ data: { orgId: "org_kaveri", host: BLOCKED_HOST, port: 8443, purpose: "webhook", decision: "blocked", profile: "sovereign" } });

      const r = await egress();
      expect(r.status, r.body.error).toBe(200);
      const out = r.body.result as { log: Attempt[]; hosts: Host[]; blocked24h: number };
      expect(out.hosts.map((x) => x.host)).toEqual(expect.arrayContaining(SEEDED));
      expect(out.hosts.find((x) => x.host === "smtp-relay.deccanbank.internal")).toMatchObject({ purpose: "Internal mail relay for approval and sign-in emails", addedBy: OWNER });
      // only real attempts: no generated background traffic, and nothing of another organisation's
      expect(out.log.map((e) => e.id)).toEqual([mine.id]);
      expect(out.log[0]).toMatchObject({ destination: `${BLOCKED_HOST}:443`, component: "Webhook dispatcher" });
      expect(out.log.some((e) => e.id === theirs.id)).toBe(false);
      expect(out.blocked24h).toBe(1);

      // the document holds the same, for the screens' synchronous reads
      const { status, doc } = await h.state(ORG, VIEWER);
      expect(status).toBe(200);
      expect(doc.sovereign.internalHosts.map((x: Host) => x.host)).toEqual(out.hosts.map((x) => x.host));
      expect(doc.sovereign.egress.map((e: Attempt) => e.id)).toEqual([mine.id]);

      // the egress screens are for a Sovereign deployment only
      const hosted = await h.rpc("sovereign.egress", ["org_kaveri", 7], "u_lakshmi");
      expect(hosted.status).toBe(400);
      expect(hosted.body.error).toMatch(/for Sovereign deployments/);
    });

    it("adds and removes an internal host as an owner or admin: the real rule, its receipt, and the document", async () => {
      const add = (as: string, host = HOST, purpose = "Core banking ledger exports") => h.rpc("sovereign.addHost", [ORG, host, purpose, OWNER], as);
      for (const who of [APPROVER, VIEWER]) {
        const r = await add(who);
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/owners and admins can do this/);
      }
      expect((await add(ADMIN, "api.openai.com")).body.error).toMatch(/not inside your network/);
      expect((await add(ADMIN, HOST, "db")).body.error).toMatch(/what the host is for/);
      expect(await forOrg(ORG).egressRule.findFirst({ where: { host: HOST } })).toBeNull();

      const ok = await add(ADMIN);
      expect(ok.status, ok.body.error).toBe(200);
      const { seq } = ok.body.result as { seq: number; host: string };
      const rule = await forOrg(ORG).egressRule.findFirstOrThrow({ where: { host: HOST } });
      expect(rule).toMatchObject({ note: "Core banking ledger exports", port: null, purpose: null, createdBy: ADMIN });
      const receipt = await forOrg(ORG).receipt.findFirstOrThrow({ where: { seq } });
      expect(receipt).toMatchObject({ action: "egress.internal_host_added" });
      expect((receipt.body as { actor: string; details: Record<string, unknown> }).actor).toBe(ADMIN);
      expect((receipt.body as { details: Record<string, unknown> }).details).toMatchObject({ rule_id: rule.id, host: HOST });

      const doc = (await h.state(ORG, ADMIN)).doc;
      expect(doc.sovereign.internalHosts.find((x: Host) => x.host === HOST)).toMatchObject({ purpose: "Core banking ledger exports", addedBy: ADMIN, seq });
      expect(lastReceipt(doc, "egress.internal_host_added")?.seq).toBe(seq);
      expect((await add(OWNER)).body.error).toMatch(/already on the allow-list/);

      // isolation: the rule is Deccan's alone, and nobody outside Deccan reaches its allow-list
      expect(await forOrg("org_kaveri").egressRule.findFirst({ where: { host: HOST } })).toBeNull();
      expect((await h.rpc("sovereign.addHost", [ORG, "x.deccanbank.internal", "Someone else's host", "u_lakshmi"], "u_lakshmi")).status).toBe(403);

      // an enabled real webhook endpoint still delivering there keeps the host on the list
      const hook = await forOrg(ORG).webhook.create({ data: { orgId: ORG, url: `https://${HOST}/hooks/elan1`, secretEnc: "test", events: ["receipt.created"], createdBy: ADMIN } });
      const refused = await h.rpc("sovereign.removeHost", [ORG, HOST, ADMIN], ADMIN);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/active webhook endpoint/);
      await forOrg(ORG).webhook.update({ where: { id: hook.id }, data: { active: false } });
      expect((await h.rpc("sovereign.removeHost", [ORG, HOST, ADMIN], APPROVER)).body.error).toMatch(/owners and admins can do this/);

      const gone = await h.rpc("sovereign.removeHost", [ORG, HOST, ADMIN], OWNER);
      expect(gone.status, gone.body.error).toBe(200);
      expect(await forOrg(ORG).egressRule.findFirst({ where: { host: HOST } })).toBeNull();
      const removed = await forOrg(ORG).receipt.findFirstOrThrow({ where: { seq: (gone.body.result as { seq: number }).seq } });
      expect(removed.action).toBe("egress.internal_host_removed");
      expect((await h.state(ORG, OWNER)).doc.sovereign.internalHosts.some((x: Host) => x.host === HOST)).toBe(false);
      expect((await h.rpc("sovereign.removeHost", [ORG, HOST, ADMIN], OWNER)).body.error).toMatch(/not on the allow-list/);
      await forOrg(ORG).webhook.deleteMany({ where: { id: hook.id } });
    });

    it("exports the real egress log for everyone but approvers, with a receipt of its digest", async () => {
      const refused = await h.rpc("sovereign.exportEgress", [ORG, 7, VIEWER], APPROVER);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/Owners, admins, viewers and auditors/);
      const r = await h.rpc("sovereign.exportEgress", [ORG, 7, APPROVER], VIEWER);
      expect(r.status, r.body.error).toBe(200);
      const out = r.body.result as { csv: string; seq: number; count: number };
      expect(out.count).toBe(1);
      expect(out.csv.split("\n")).toHaveLength(2);
      expect(out.csv).toContain(`${BLOCKED_HOST}:443`);
      const receipt = await forOrg(ORG).receipt.findFirstOrThrow({ where: { seq: out.seq } });
      expect(receipt.action).toBe("egress.log_exported");
      expect((receipt.body as { actor: string; details: Record<string, unknown> })).toMatchObject({ actor: VIEWER, details: { days: 7, attempts: 1, digest: sha(out.csv).slice(0, 16) } });
    });

    it("the local status page shows the firewall's real figures", async () => {
      const r = await h.rpc("sovereign.localStatus", [ORG], VIEWER);
      expect(r.status, r.body.error).toBe(200);
      const c = (r.body.result as { components: { id: string; detail: string; facts?: { value: string }[] }[] }).components.find((x) => x.id === "l_egress");
      expect(c?.detail).toMatch(/^1 connection attempts blocked/);
      expect(c?.facts?.[0]?.value).toBe(`${SEEDED.length} internal hosts`);
    });

    it("imports update bundles from the update folder, stages, applies and rolls back on the real records", async () => {
      const v1 = `2026.11.1-w${run}`;
      const v2 = `2026.11.2-w${run}`;
      await bundle(root, v1);
      await bundle(root, v2);
      const imp = (version: string, as = ADMIN) => h.rpc("deployment.importBundle", [ORG, { version, digest: "0".repeat(64), sig: "0".repeat(128), kid: "rel" }, OWNER], as);

      // no update folder configured: nothing is read from anywhere
      deps.env = { ...deps.env, UPDATE_IMPORT_DIR: undefined };
      expect((await imp(v1)).body.error).toMatch(/no update folder/);
      deps.env = { ...deps.env, UPDATE_IMPORT_DIR: root };
      expect((await imp(v1, VIEWER)).body.error).toMatch(/Owners and admins import update bundles/);
      expect((await imp("../../etc")).body.error).toMatch(/No version like/);

      const i1 = await imp(v1);
      expect(i1.status, i1.body.error).toBe(200);
      const b1 = (i1.body.result as { bundle: Bundle; seq: number }).bundle;
      expect(b1).toMatchObject({ version: v1, status: "available" });
      expect(await prisma.updateRecord.findUnique({ where: { version: v1 } })).toMatchObject({ status: "verified", importedBy: ADMIN, kid: keyFingerprint(release.publicKeyPem) });
      expect((await forOrg(ORG).receipt.findFirstOrThrow({ where: { seq: (i1.body.result as { seq: number }).seq } })).action).toBe("update.imported");
      expect((await imp(v1)).body.error).toMatch(/already imported/);

      // the bundle on disk is checked: a file swapped after signing is refused and recorded
      const v3 = `2026.11.3-w${run}`;
      await bundle(root, v3, { tamper: true });
      expect((await imp(v3)).body.error).toMatch(/refused/);
      expect(await prisma.updateRecord.findUnique({ where: { version: v3 } })).toBeNull();
      expect(lastReceipt((await h.state(ORG, ADMIN)).doc, "update.rejected")?.details).toMatchObject({ version: v3, step: "import" });

      expect((await h.rpc("api.stageUpdate", [ORG, b1.id, ADMIN], APPROVER)).body.error).toMatch(/can do this; your role cannot/);
      expect((await h.rpc("api.applyUpdate", [ORG, b1.id, ADMIN], ADMIN)).body.error).toMatch(/Stage and verify the bundle first/);
      const s1 = await h.rpc("api.stageUpdate", [ORG, b1.id, ADMIN], ADMIN);
      expect(s1.status, s1.body.error).toBe(200);
      expect(s1.body.result).toMatchObject({ version: v1, status: "staged", verified: true });
      expect((await h.rpc("api.applyUpdate", [ORG, b1.id, ADMIN], OWNER)).body.result).toMatchObject({ version: v1, status: "applied" });

      const i2 = await imp(v2);
      const b2 = (i2.body.result as { bundle: Bundle }).bundle;
      expect((await h.rpc("api.stageUpdate", [ORG, b2.id, ADMIN], ADMIN)).status).toBe(200);
      const a2 = await h.rpc("api.applyUpdate", [ORG, b2.id, ADMIN], ADMIN);
      expect(a2.status, a2.body.error).toBe(200);
      expect(await prisma.updateRecord.findUnique({ where: { version: v2 } })).toMatchObject({ status: "active", previousVersion: v1, appliedBy: ADMIN });
      expect(await prisma.updateRecord.findUnique({ where: { version: v1 } })).toMatchObject({ status: "inactive" });

      // the Deployment screen: the real records, the real release key; the document holds them for the sync reads
      const view = await deployment();
      expect(view.updates.map((u) => [u.version, u.status]).sort()).toEqual([[v1, "applied"], [v2, "applied"]]);
      expect(view.release.kid).toBe(keyFingerprint(release.publicKeyPem));
      expect(view.egress.blockedLast24h).toBe(1);
      expect((await h.state(ORG, VIEWER)).doc.platform.updates.map((u: Bundle) => u.id).sort()).toEqual([b1.id, b2.id].sort());

      // rollback: only the running bundle, with a reason, by an owner or admin
      expect((await h.rpc("sovereign.rollback", [ORG, b2.id, "the payments screen times out", ADMIN], APPROVER)).body.error).toMatch(/owners and admins can do this/);
      expect((await h.rpc("sovereign.rollback", [ORG, b1.id, "the payments screen times out", ADMIN], ADMIN)).body.error).toMatch(/Only the bundle running now/);
      expect((await h.rpc("sovereign.rollback", [ORG, b2.id, "slow", ADMIN], ADMIN)).body.error).toMatch(/at least 10 characters/);
      const rb = await h.rpc("sovereign.rollback", [ORG, b2.id, "the payments screen times out", ADMIN], OWNER);
      expect(rb.status, rb.body.error).toBe(200);
      expect(rb.body.result).toMatchObject({ from: v2, to: v1 });
      const rbSeq = (rb.body.result as { seq: number }).seq;
      expect((await forOrg(ORG).receipt.findFirstOrThrow({ where: { seq: rbSeq } })).action).toBe("update.rolled_back");
      expect(await prisma.updateRecord.findUnique({ where: { version: v2 } })).toMatchObject({ status: "rolled_back", rolledBackBy: OWNER });
      expect(await prisma.updateRecord.findUnique({ where: { version: v1 } })).toMatchObject({ status: "active" });

      const after = (await h.state(ORG, OWNER)).doc.platform.updates as Bundle[];
      expect(after.find((u) => u.id === b2.id)).toMatchObject({ status: "staged", verified: true, rolledBackAt: expect.any(String) });
      expect(after.find((u) => u.id === b1.id)).toMatchObject({ status: "applied", restoredFrom: v2, seq: rbSeq, firstAppliedSeq: expect.any(Number) });
      const list = await h.rpc("sovereign.rollbacks", [ORG], VIEWER);
      expect(list.body.result).toEqual([expect.objectContaining({ updateId: b2.id, fromVersion: v2, toVersion: v1, by: OWNER, seq: rbSeq })]);

      // a rolled-back bundle is still verified: applying it again checks it, stages it and applies it
      const again = await h.rpc("api.applyUpdate", [ORG, b2.id, ADMIN], ADMIN);
      expect(again.status, again.body.error).toBe(200);
      expect(again.body.result).toMatchObject({ version: v2, status: "applied" });
      expect(await prisma.updateRecord.findUnique({ where: { version: v2 } })).toMatchObject({ status: "active", previousVersion: v1 });

      // a hosted organisation has no bundles to stage
      expect((await h.rpc("api.stageUpdate", ["org_kaveri", b1.id, "u_lakshmi"], "u_lakshmi")).body.error).toMatch(/hosted organisations/);
    });
  });
}
