import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, hashCanonical, keyFingerprint, omit, verifyText } from "@gate/core";
import { forOrg, orgPublicKeys, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rotateSigningKey } from "../src/keys";
import { signedStatement, verifyStatement } from "../src/statements";
import { applyUpdate, importBundle, MANIFEST_FILE, MANIFEST_FORMAT, rollbackUpdate, signManifest, stageUpdate, type UpdateManifest } from "../src/updates";
import { demoOrg, env, makeApp, tool } from "./helpers";

// Signed update bundles (import, stage, apply, rollback) and signed usage / chain-head statements.

const release = generateKeyPair();
const stranger = generateKeyPair();
const b64 = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
const run = randomBytes(3).toString("hex");
let ctx: Awaited<ReturnType<typeof makeApp>>;
let orgIds: string[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  ctx = await makeApp({ env: { ...env, UPDATE_SIGNING_PUBLIC_KEYS: `${b64(stranger.publicKeyPem)},${b64(release.publicKeyPem)}` } });
  // Platform-wide receipts go to these two orgs only, so parallel test files are not disturbed.
  const a = await demoOrg(ctx.deps);
  const b = await demoOrg(ctx.deps);
  orgIds = [a.org.id, b.org.id];
  ctx.deps.platformOrgs = async () => orgIds;
  // Versions are global; start this run's from a clean slate.
  await prisma.updateRecord.deleteMany({});
});
afterAll(async () => {
  await ctx.app.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function bundle(version: string, opts: { key?: string; files?: Record<string, string>; edit?: (m: UpdateManifest) => UpdateManifest } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gate-bundle-"));
  dirs.push(dir);
  const files = opts.files ?? { "gate.img": `gate ${version} ${run}`, "web.img": `web ${version} ${run}` };
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  const key = opts.key ?? release.privateKeyPem;
  const pub = key === release.privateKeyPem ? release.publicKeyPem : stranger.publicKeyPem;
  let m = signManifest(
    { format: MANIFEST_FORMAT, version, createdAt: new Date().toISOString(), artifacts: Object.entries(files).map(([name, body]) => ({ name, sha256: sha(body) })), notes: ["Fixes", "More fixes"], kid: keyFingerprint(pub) },
    key,
  );
  if (opts.edit) m = opts.edit(m);
  await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(m));
  return dir;
}

const actions = (orgId: string, action: string) => forOrg(orgId).receipt.findMany({ where: { action }, orderBy: { seq: "asc" } });
const det = (r: { body: unknown }) => (r.body as { details: Record<string, unknown> }).details;

describe("update bundles", () => {
  it("imports, stages, applies and rolls back, with a receipt in every organisation for each step", async () => {
    const v1 = `2026.11.1-r${run}`;
    const v2 = `2026.11.2-r${run}`;
    const i1 = await importBundle(ctx.deps, await bundle(v1), "ops@bank.internal");
    expect(i1).toMatchObject({ ok: true, record: { version: v1, status: "verified", kid: keyFingerprint(release.publicKeyPem) } });
    expect(await importBundle(ctx.deps, await bundle(v1), "ops@bank.internal")).toMatchObject({ ok: false, status: 409 });
    expect(await applyUpdate(ctx.deps, v1, "ops")).toMatchObject({ ok: false, status: 409, error: "Stage the update first." });
    expect(await stageUpdate(ctx.deps, v1, "ops")).toMatchObject({ ok: true, record: { status: "staged", stagedBy: "ops" } });
    expect(await stageUpdate(ctx.deps, v1, "ops")).toMatchObject({ ok: false, status: 409 });
    expect(await applyUpdate(ctx.deps, v1, "ops")).toMatchObject({ ok: true, record: { status: "active", previousVersion: null } });
    expect(await rollbackUpdate(ctx.deps, "ops", "the first install has nothing before it")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/no earlier/) });

    await importBundle(ctx.deps, await bundle(v2), "ops");
    await stageUpdate(ctx.deps, v2, "ops");
    expect(await applyUpdate(ctx.deps, v2, "ops")).toMatchObject({ ok: true, record: { status: "active", previousVersion: v1 } });
    expect(await prisma.updateRecord.findUnique({ where: { version: v1 } })).toMatchObject({ status: "inactive" });

    expect(await rollbackUpdate(ctx.deps, "ops", "short")).toMatchObject({ ok: false, status: 400 });
    const rb = await rollbackUpdate(ctx.deps, "ops", "payments latency regressed after 2026.11.2");
    expect(rb).toMatchObject({ ok: true, record: { version: v1, status: "active" } });
    expect(await prisma.updateRecord.findUnique({ where: { version: v2 } })).toMatchObject({ status: "rolled_back", rollbackReason: "payments latency regressed after 2026.11.2" });
    // The rolled-back version stays verified and can be staged and applied again.
    expect(await stageUpdate(ctx.deps, v2, "ops")).toMatchObject({ ok: true, record: { status: "staged" } });

    for (const orgId of orgIds) {
      expect((await actions(orgId, "update.imported")).map((r) => det(r).version)).toEqual([v1, v2]);
      expect((await actions(orgId, "update.staged")).map((r) => det(r).version)).toEqual([v1, v2, v2]);
      expect((await actions(orgId, "update.applied")).map((r) => [det(r).version, det(r).from_version])).toEqual([[v1, undefined], [v2, v1]]);
      expect((await actions(orgId, "update.rolled_back")).map((r) => det(r))).toEqual([{ version: v2, to_version: v1, reason: "payments latency regressed after 2026.11.2" }]);
    }
  });

  it("refuses a bundle whose signature, signer, artifacts or manifest are wrong, with a receipt", async () => {
    const bad = async (dir: string, error: RegExp) => {
      const r = await importBundle(ctx.deps, dir, "ops");
      expect(r).toMatchObject({ ok: false, status: 400 });
      if (!r.ok) expect(r.error).toMatch(error);
    };
    await bad(await bundle(`2026.12.1-a${run}`, { edit: (m) => ({ ...m, notes: "edited after signing" }) }), /signature does not verify/);
    await bad(await bundle(`2026.12.1-b${run}`, { edit: (m) => ({ ...m, kid: "0123456789abcdef" }) }), /unknown key/);
    // Signed by a key the deployment trusts, but the kid names the other one.
    await bad(await bundle(`2026.12.1-c${run}`, { edit: (m) => ({ ...m, kid: keyFingerprint(stranger.publicKeyPem) }) }), /invalid signature/);
    await bad(await bundle(`2026.12.1-d${run}`, { edit: (m) => ({ ...m, artifacts: [...m.artifacts, { name: "extra.img", sha256: sha("x") }] }) }), /signature does not verify/);
    const swapped = await bundle(`2026.12.1-e${run}`);
    await writeFile(join(swapped, "gate.img"), "a different image");
    await bad(swapped, /gate.img does not match its SHA-256/);
    const missing = await bundle(`2026.12.1-f${run}`);
    await rm(join(missing, "web.img"));
    await bad(missing, /web.img is missing/);
    const linked = await bundle(`2026.12.1-g${run}`);
    await rm(join(linked, "web.img"));
    await symlink(join(linked, "gate.img"), join(linked, "web.img"));
    await bad(linked, /web.img is not a regular file/);
    await bad(await bundle(`2026.12.1-h${run}`, { edit: (m) => ({ ...m, artifacts: [{ name: "../etc/passwd", sha256: sha("x") }] }) }), /not a valid/);
    const notJson = await bundle(`2026.12.1-i${run}`);
    await writeFile(join(notJson, MANIFEST_FILE), "{");
    await bad(notJson, /not valid JSON/);
    await bad(join(notJson, "nowhere"), /no manifest.json/);
    const noKeys = { ...ctx.deps, env: { ...ctx.deps.env, UPDATE_SIGNING_PUBLIC_KEYS: undefined } };
    expect(await importBundle(noKeys, await bundle(`2026.12.1-j${run}`), "ops")).toMatchObject({ ok: false, error: expect.stringMatching(/no release key/) });

    const rejected = await actions(orgIds[0]!, "update.rejected");
    expect(rejected.map((r) => det(r).version)).toContain(`2026.12.1-e${run}`);
    expect(det(rejected.find((r) => det(r).version === `2026.12.1-e${run}`)!)).toMatchObject({ step: "import", reason: "gate.img does not match its SHA-256 in the manifest" });
    expect(await prisma.updateRecord.count({ where: { version: { startsWith: "2026.12.1-" } } })).toBe(0);
  });

  it("checks the bundle again before stage and apply, so a file swapped after import is caught", async () => {
    const v = `2026.11.9-s${run}`;
    const dir = await bundle(v);
    await importBundle(ctx.deps, dir, "ops");
    await writeFile(join(dir, "web.img"), "tampered on the media");
    expect(await stageUpdate(ctx.deps, v, "ops")).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/web.img does not match/) });
    await writeFile(join(dir, "web.img"), `web ${v} ${run}`);
    expect(await stageUpdate(ctx.deps, v, "ops")).toMatchObject({ ok: true });
    // Re-signed with a different (still trusted) manifest: not the one imported.
    await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(signManifest({ format: MANIFEST_FORMAT, version: v, createdAt: new Date().toISOString(), artifacts: [{ name: "gate.img", sha256: sha(`gate ${v} ${run}`) }], notes: "", kid: keyFingerprint(release.publicKeyPem) }, release.privateKeyPem)));
    expect(await applyUpdate(ctx.deps, v, "ops")).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/not the one that was imported/) });
    expect(await stageUpdate(ctx.deps, "0000.0.0", "ops")).toMatchObject({ ok: false, status: 404 });
    expect(await applyUpdate(ctx.deps, "0000.0.0", "ops")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("signed statements", () => {
  it("chain head: signed with the org key, verifiable with @gate/core, and receipted", async () => {
    const d = await demoOrg(ctx.deps);
    await Promise.all([...ctx.deps.background]);
    const head = await forOrg(d.org.id).receipt.findFirstOrThrow({ orderBy: { seq: "desc" } });
    const st = await signedStatement(ctx.deps, d.org.id, "chain-head", { actor: d.owner.email });
    expect(st).toMatchObject({ format: "elan1.statement.v1", kind: "chain-head", org: d.org.id, orgName: "Test Traders", head: { seq: head.seq, hash: head.hash } });
    const keys = await orgPublicKeys(d.org.id);
    const pem = keys.find((k) => k.kid === st.kid)!.publicKeyPem;
    expect(verifyText(pem, hashCanonical(omit(st, ["sig"])), st.sig)).toBe(true);
    expect(verifyStatement(st, keys)).toBe(true);
    expect(verifyStatement({ ...st, head: { ...st.head!, seq: st.head!.seq - 1 } }, keys)).toBe(false);
    const r = await actions(d.org.id, "statement.signed");
    expect(r).toHaveLength(1);
    expect(r[0]!.seq).toBe(head.seq + 1); // written after signing
    expect(det(r[0]!)).toMatchObject({ kind: "chain-head", head_seq: head.seq });

    // After a rotation the old statement still verifies against the org's key list; a new one names the new key.
    await rotateSigningKey(ctx.deps, d.org.id, d.owner.email);
    const after = await orgPublicKeys(d.org.id);
    expect(verifyStatement(st, after)).toBe(true);
    expect((await signedStatement(ctx.deps, d.org.id, "chain-head")).kid).not.toBe(st.kid);
  });

  it("usage: counts the period's receipts by kind and decision", async () => {
    const d = await demoOrg(ctx.deps);
    const from = new Date();
    await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" }); // allow
    await tool(ctx.app, d.apiKey, "zoho.update_vendor", { vendor_id: "v_sharma", fields: { bank_account: "1111", ifsc: "SBIN0000001" } }); // refuse
    await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 80000 }); // ask
    await Promise.all([...ctx.deps.background]);
    const to = new Date(Date.now() + 1);
    const st = await signedStatement(ctx.deps, d.org.id, "usage", { from, to });
    expect(st.counts).toMatchObject({ decisions: 3, allowed: 1, refused: 1, asked: 1 });
    expect(st.counts!.receipts).toBeGreaterThanOrEqual(3);
    expect(st.period).toEqual({ from: from.toISOString(), to: to.toISOString() });
    expect(verifyStatement(st, await orgPublicKeys(d.org.id))).toBe(true);
    expect(verifyStatement({ ...st, counts: { ...st.counts!, refused: 0 } }, await orgPublicKeys(d.org.id))).toBe(false);
    // Month to date by default; an empty or backwards period is refused.
    expect((await signedStatement(ctx.deps, d.org.id, "usage")).counts!.decisions).toBeGreaterThanOrEqual(3);
    await expect(signedStatement(ctx.deps, d.org.id, "usage", { from: to, to: from })).rejects.toThrow(/period/);
  });
});
