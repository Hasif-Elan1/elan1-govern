import { decrypt, keyFingerprint, verifyChain, verifyEvidenceFile, type Receipt } from "@gate/core";
import { forOrg, orgPublicKeys, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg } from "../src/admin";
import { orgKey } from "../src/deps";
import { activeKey, envKeyProvider, legacyKeyAad, rotateSigningKey } from "../src/keys";
import { demoOrg, env, gateMeta, internal, makeApp, makeUser, tool } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(() => ctx.app.close());

const receipts = async (orgId: string) => (await forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);

describe("signing keys", () => {
  it("new orgs get an OrgKey row, and every receipt and checkpoint carries its kid", async () => {
    const d = await demoOrg(ctx.deps);
    const keys = await orgPublicKeys(d.org.id);
    expect(keys).toHaveLength(1);
    const kid = keys[0]!.kid;
    expect(kid).toBe(keyFingerprint((await forOrg(d.org.id).org.findFirstOrThrow()).publicKey));
    const row = await forOrg(d.org.id).orgKey.findFirstOrThrow();
    expect(row.privateKeyEnc).toMatch(/^v1\./);
    expect(row.provider).toBe("env");
    expect((await receipts(d.org.id)).every((r) => r.kid === kid)).toBe(true);
    const cp = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/checkpoints`, { actor: d.owner.email });
    expect(cp.json().checkpoint).toMatchObject({ kid });
  });

  it("rotation: the old key signs the handover, the new key signs after, rulebooks keep working", async () => {
    const d = await demoOrg(ctx.deps);
    const before = await orgKey(ctx.deps, d.org.id);
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/signing-key/rotate`, { actor: d.owner.email });
    expect(res.statusCode).toBe(200);
    const r = res.json() as { kid: string; previousKid: string; seq: number; rulebooksResigned: number };
    expect(r.previousKid).toBe(before.kid);
    expect(r.kid).not.toBe(before.kid);
    expect(r.rulebooksResigned).toBe(1);

    const rotated = (await receipts(d.org.id)).find((x) => x.seq === r.seq)!;
    expect(rotated).toMatchObject({ kind: "admin", action: "key.rotated", kid: before.kid, details: { old_kid: before.kid, new_kid: r.kid } });
    const keys = await orgPublicKeys(d.org.id);
    expect(keys.map((k) => k.kid)).toEqual([before.kid, r.kid]);
    expect(keys[0]!.retiredAt).toBe(rotated.ts);
    expect(keys[1]!.retiredAt).toBeNull();

    // The rulebook was re-signed with the new key; the guard still loads it.
    const after = gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" }));
    expect(after.decision).toBe("allow");
    const all = await receipts(d.org.id);
    expect(all.at(-1)!.kid).toBe(r.kid);
    expect(verifyChain(all, keys)).toMatchObject({ ok: true, count: all.length });
    // A single (current) key is no longer enough to verify the whole chain.
    expect(verifyChain(all, keys[1]!.publicKeyPem).ok).toBe(false);

    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const zip = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/export`, { from: today, to: today, kind: "bundle", actor: d.owner.email });
    const checked = verifyEvidenceFile(new Uint8Array(zip.rawPayload));
    expect(checked).toMatchObject({ ok: true, fingerprint: r.kid, keys: [{ kid: before.kid }, { kid: r.kid, retiredAt: null }] });

    // Rotating again retires the second key too.
    const again = await rotateSigningKey(ctx.deps, d.org.id, d.owner.email);
    expect(again.previousKid).toBe(r.kid);
    const final = await orgPublicKeys(d.org.id);
    expect(final.filter((k) => !k.retiredAt).map((k) => k.kid)).toEqual([again.kid]);
    expect(verifyChain(await receipts(d.org.id), final).ok).toBe(true);
  });

  it("writes racing a rotation never use the retired key", async () => {
    const d = await demoOrg(ctx.deps);
    await Promise.all([
      ...Array.from({ length: 12 }, () => tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })),
      rotateSigningKey(ctx.deps, d.org.id, d.owner.email),
      ...Array.from({ length: 12 }, () => tool(ctx.app, d.apiKey, "gmail.search", { query: "invoice" })),
    ]);
    const all = await receipts(d.org.id);
    expect(verifyChain(all, await orgPublicKeys(d.org.id))).toMatchObject({ ok: true, count: all.length });
  });

  it("an org whose key was never copied to OrgKey is migrated lazily on first use", async () => {
    const owner = await makeUser();
    const org = await createOrg(ctx.deps, { name: "Old Co", ownerUserId: owner.id, ownerEmail: owner.email });
    await forOrg(org.id).orgKey.deleteMany({});
    const k = await activeKey(ctx.deps, org.id);
    expect(k.kid).toBe(keyFingerprint(org.publicKey));
    const row = await forOrg(org.id).orgKey.findFirstOrThrow();
    // The copied row keeps the legacy ciphertext, bound to the org id only.
    expect(decrypt(env.GATE_MASTER_KEY, row.privateKeyEnc, legacyKeyAad(org.id))).toBe(k.privateKeyPem);
    expect(await envKeyProvider(env.GATE_MASTER_KEY).unwrap(row.privateKeyEnc, { orgId: org.id, kid: row.kid })).toBe(k.privateKeyPem);
  });

  it("an org with only retired keys refuses to sign", async () => {
    const owner = await makeUser();
    const org = await createOrg(ctx.deps, { name: "Retired Co", ownerUserId: owner.id, ownerEmail: owner.email });
    await forOrg(org.id).orgKey.updateMany({ data: { retiredAt: new Date() } });
    await expect(orgKey(ctx.deps, org.id)).rejects.toThrow(/no active signing key/);
  });

  it("the migration's SQL fingerprint matches keyFingerprint", async () => {
    const owner = await makeUser();
    const org = await createOrg(ctx.deps, { name: "Fp Co", ownerUserId: owner.id, ownerEmail: owner.email });
    const [row] = await prisma.$queryRaw<{ kid: string }[]>`
      SELECT substr(encode(sha256(convert_to(btrim("publicKey", E' \t\n\r\f'), 'UTF8')), 'hex'), 1, 16) AS kid FROM "Org" WHERE id = ${org.id}`;
    expect(row!.kid).toBe(keyFingerprint(org.publicKey));
  });

  it("the rotate endpoint validates its body", async () => {
    const d = await demoOrg(ctx.deps);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/signing-key/rotate`, {})).statusCode).toBe(400);
  });
});
