import { forOrg } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminEvent } from "../src/admin";
import { ANCHOR_ACTION, anchorAll, AnchorError, anchorOrg, inclusionProof, leafOf } from "../src/anchors";
import { configuredAuthorities, trustedCertsFor } from "../src/tsa/config";
import { inclusionPath, merkleRoot, verifyInclusion } from "../src/tsa/merkle";
import { TsaError, verifyTimestampToken, type TimestampAuthority, type TimestampToken } from "../src/tsa/token";
import { demoOrg, makeApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const down = (id: string): TimestampAuthority => ({
  id,
  name: `${id} (down)`,
  stamp: async () => {
    throw new TsaError("the authority could not be reached");
  },
});
const broken = (id: string): TimestampAuthority => ({
  id,
  name: id,
  stamp: async () => {
    throw new Error("socket hang up at 10.0.0.7:318"); // never stored as is
  },
});

async function l2Org(level = "l2") {
  const d = await demoOrg(ctx.deps);
  await forOrg(d.org.id).org.update({ where: { id: d.org.id }, data: { level } });
  return d;
}
const receipts = (orgId: string) => forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" }, select: { seq: true, hash: true, action: true, body: true } });

describe("Merkle batches with two timestamps", () => {
  it("batches an L2 org's receipts under one root, stamped by both local authorities, with an anchor.batched receipt", async () => {
    const { org } = await l2Org();
    const before = await receipts(org.id);
    const [b, ...more] = await anchorOrg(ctx.deps, org.id);
    expect(more).toEqual([]);
    expect(b).toMatchObject({ orgId: org.id, fromSeq: 1, toSeq: before.length, status: "ok", root: merkleRoot(before.map((r) => leafOf(r.hash))), failures: [] });

    const tokens = b!.tokens as unknown as TimestampToken[];
    expect(tokens.map((t) => t.tsaId)).toEqual(["local-a", "local-b"]);
    for (const t of tokens) {
      expect(t.imprint).toBe(b!.root);
      expect(await verifyTimestampToken(t, b!.root, await trustedCertsFor(ctx.deps, t.tsaId))).toMatchObject({ ok: true });
    }
    expect(await trustedCertsFor(ctx.deps, "local-a")).not.toEqual(await trustedCertsFor(ctx.deps, "local-b"));

    const after = await receipts(org.id);
    const rec = after.at(-1)!;
    expect(rec.seq).toBe(b!.receiptSeq);
    expect(rec.action).toBe(ANCHOR_ACTION);
    expect(rec.body).toMatchObject({
      kind: "admin",
      actor: "Elan1 Govern",
      details: { batch_id: b!.id, from_seq: 1, to_seq: before.length, count: before.length, root: b!.root, status: "ok", tsa_1_id: "local-a", tsa_1_serial: tokens[0]!.serial, tsa_2_id: "local-b", tsa_2_gen: tokens[1]!.genTime },
    });

    // Nothing new but the anchor receipt itself: no batch.
    expect(await anchorOrg(ctx.deps, org.id)).toEqual([]);
    // A new receipt: the next batch starts right after the last one and includes the anchor receipt.
    await adminEvent(ctx.deps, org.id, "owner@test.in", "test.event");
    const [next] = await anchorOrg(ctx.deps, org.id);
    expect(next).toMatchObject({ fromSeq: before.length + 1, toSeq: before.length + 2, status: "ok" });
  });

  it("leaves L1 orgs alone, and batches L3 and Sovereign ones", async () => {
    const { org: l1 } = await demoOrg(ctx.deps);
    expect(await anchorOrg(ctx.deps, l1.id)).toEqual([]);
    expect(await forOrg(l1.id).anchorBatch.count()).toBe(0);
    for (const level of ["l3", "sovereign"]) {
      const { org } = await l2Org(level);
      expect(await anchorOrg(ctx.deps, org.id)).toHaveLength(1);
    }
  });

  it("one authority answering is degraded, not failed, and raises a health alert", async () => {
    const { org } = await l2Org();
    const [localA] = configuredAuthorities(ctx.deps);
    const [b] = await anchorOrg(ctx.deps, org.id, [localA!, down("digicert")]);
    expect(b).toMatchObject({ status: "degraded", failures: [{ tsaId: "digicert", error: "the authority could not be reached" }] });
    expect((b!.tokens as unknown as TimestampToken[]).map((t) => t.tsaId)).toEqual(["local-a"]);
    const rec = (await receipts(org.id)).at(-1)!;
    expect(rec.body).toMatchObject({ details: { status: "degraded", tsa_1_id: "local-a", failed_1_id: "digicert" } });
    expect(ctx.deps.alerts.some((a) => a.kind === "anchor-degraded" && a.orgId === org.id)).toBe(true);
    // A degraded batch still covers its records: the next run does not batch them again.
    await adminEvent(ctx.deps, org.id, "owner@test.in", "test.event");
    const [next] = await anchorOrg(ctx.deps, org.id);
    expect(next!.fromSeq).toBe(b!.toSeq + 1);
  });

  it("no authority answering is failed: recorded, alerted, and the records go into the next batch", async () => {
    const { org } = await l2Org();
    const [failed] = await anchorOrg(ctx.deps, org.id, [down("freetsa"), broken("digicert")]);
    expect(failed).toMatchObject({ status: "failed", tokens: [], failures: [{ tsaId: "freetsa", error: "the authority could not be reached" }, { tsaId: "digicert", error: "the authority could not be used" }] });
    expect(JSON.stringify(failed!.failures)).not.toContain("10.0.0.7");
    expect(ctx.deps.alerts.some((a) => a.kind === "anchor-failed" && a.orgId === org.id)).toBe(true);
    await expect(inclusionProof(ctx.deps, org.id, 1)).rejects.toThrow(AnchorError);

    const [retry] = await anchorOrg(ctx.deps, org.id);
    expect(retry).toMatchObject({ status: "ok", fromSeq: 1, toSeq: failed!.receiptSeq });
  });

  it("inclusion proofs walk from a receipt to its batch root", async () => {
    const { org } = await l2Org();
    const [b] = await anchorOrg(ctx.deps, org.id);
    const hashes = (await receipts(org.id)).filter((r) => r.seq <= b!.toSeq).map((r) => leafOf(r.hash));
    for (const seq of [1, Math.ceil(b!.toSeq / 2), b!.toSeq]) {
      const p = await inclusionProof(ctx.deps, org.id, seq);
      expect(p).toMatchObject({ seq, batchId: b!.id, root: b!.root, leafIndex: seq - 1, treeSize: hashes.length, receiptHash: hashes[seq - 1], status: "ok", verified: true });
      expect(p.path).toEqual(inclusionPath(hashes, seq - 1));
      expect(verifyInclusion(p.receiptHash, p.path, p.root)).toBe(true);
      expect(p.tokens).toHaveLength(2);
    }
    // The anchor receipt itself is in the unbatched tail; an unknown seq is refused.
    await expect(inclusionProof(ctx.deps, org.id, b!.receiptSeq)).rejects.toThrow("not in a timestamped batch yet");
    await expect(inclusionProof(ctx.deps, org.id, 99_999)).rejects.toThrow("No receipt #99999");
    // Another org cannot read this org's batch.
    const { org: other } = await l2Org();
    await expect(inclusionProof(ctx.deps, other.id, 1)).rejects.toThrow(AnchorError);
  });

  it("builds the configured authorities once, with fixed hosts and pinned CAs", async () => {
    const pem = (await trustedCertsFor(ctx.deps, "local-a"))[0]!;
    const deps = { ...ctx.deps, env: { ...ctx.deps.env, TSA_AUTHORITIES: ["freetsa", "digicert", "local-b"] as const, TSA_FREETSA_CA_PEM: pem, TSA_DIGICERT_CA_PEM: undefined } } as unknown as typeof ctx.deps;
    const list = configuredAuthorities(deps);
    expect(list.map((a) => [a.id, a.constructor.name, a.name])).toEqual([
      ["freetsa", "HttpTsa", "FreeTSA"],
      ["digicert", "HttpTsa", "DigiCert Timestamp Authority"],
      ["local-b", "LocalTsa", "Elan1 Govern local TSA B"],
    ]);
    expect(configuredAuthorities(deps)).toBe(list);
    expect(await trustedCertsFor(deps, "freetsa")).toEqual([pem]);
    expect(await trustedCertsFor(deps, "digicert")).toEqual([]);
    expect(await trustedCertsFor(deps, "emudhra")).toEqual([]);
  });

  it("the job walks every org, and one org's error does not stop the rest", async () => {
    const { org: bad } = await l2Org();
    const { org: good } = await l2Org();
    // No active signing key: the chain write for this org fails.
    const retired = await forOrg(bad.id).orgKey.updateMany({ where: { retiredAt: null }, data: { retiredAt: new Date() } });
    try {
      const counts = await anchorAll(ctx.deps);
      expect(counts.batches).toBeGreaterThanOrEqual(1);
      expect(await forOrg(good.id).anchorBatch.count()).toBe(1);
      expect(await forOrg(bad.id).anchorBatch.count()).toBe(0);
      expect(ctx.deps.alerts.some((a) => a.kind === "anchor-batch-error" && a.orgId === bad.id)).toBe(true);
    } finally {
      expect(retired.count).toBe(1);
      await forOrg(bad.id).orgKey.updateMany({ data: { retiredAt: null } });
    }
  });
});
