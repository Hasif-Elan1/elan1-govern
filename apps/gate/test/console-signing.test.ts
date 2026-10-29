import { publicKeyHex, seal6, toConsoleReceipt, verifyText, type Receipt } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERASURE_REASON, flushSigned, lexiconHash, sealSalt, sealUpTo, SIGNING_ACTIONS, SigningRefused, type SignatureRequest } from "../src/console-signing";
import { ConsoleChainRefused, GATE_ONLY_ACTIONS, writeConsoleReceipts } from "../src/console-chain";
import type { Deps } from "../src/deps";
import { envKeyProvider } from "../src/keys";
import { SoftHsmKeyProvider } from "../src/soft-hsm";
import { demoOrg, env, internal, makeApp } from "./helpers";

// What the org key signs for the approved console besides receipts (src/console-signing.ts): Seal v6 records over
// the chain, DPDP erasure, and structured signatures (disclosures, manifests, statements), each checked against the
// chain and receipted. Both custody kinds: the env provider (unwrapped here) and the software HSM (signs inside).

let ctx: Awaited<ReturnType<typeof makeApp>>;
const hsm = new SoftHsmKeyProvider(env.GATE_MASTER_KEY, prisma);
beforeAll(async () => {
  ctx = await makeApp({ keyProviders: [envKeyProvider(env.GATE_MASTER_KEY), hsm] });
});
afterAll(() => ctx.app.close());

const using = (keys: Deps["keys"]): Deps => ({ ...ctx.deps, keys });
const chainOf = async (orgId: string) => (await forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);
const head = async (orgId: string) => {
  const r = (await forOrg(orgId).receipt.findFirst({ orderBy: { seq: "desc" } }))!;
  return { seq: r.seq, hash: r.hash };
};
const pemOf = async (orgId: string, kid: string) => (await forOrg(orgId).orgKey.findFirstOrThrow({ where: { kid } })).publicKey;

async function l2Org(deps: Deps = ctx.deps, level = "l2") {
  const d = await demoOrg(deps);
  await forOrg(d.org.id).org.update({ where: { id: d.org.id }, data: { level } });
  return d;
}

/** The stored seals of an org, as the console reads them. */
async function sealsOf(orgId: string) {
  const rows = await forOrg(orgId).sealRecord.findMany({ orderBy: { seq: "asc" } });
  return rows.map((s) => ({ row: s, record: { format: seal6.SEAL_FORMAT, seq: s.seq, receiptHash: s.receiptHash, level: s.level as seal6.LevelId, fields: seal6.SEAL_FIELDS.map((f, i) => ({ id: f.id, name: f.name, value: (s.values as string[])[i]! })), preimageBytes: 0, digest: s.digest, kid: s.kid, sig: s.sig } satisfies seal6.SealRecord }));
}

describe("Seal v6 records", () => {
  for (const [name, provider] of [["the env provider", undefined], ["the software HSM", hsm]] as const) {
    it(`seals every receipt from the L2 boundary, signed by the org key in ${name}, and the seals verify`, async () => {
      const deps = provider ? using(provider) : ctx.deps;
      const d = await l2Org(deps);
      if (provider) expect((await d.db.orgKey.findFirstOrThrow()).provider).toBe("soft-hsm");
      const before = await chainOf(d.org.id);
      const out = await sealUpTo(deps, d.org.id, { fromSeq: 2, autonomy: { "3": "A2" }, levels: [{ level: "l2", fromSeq: 2 }] });
      // the run is recorded, and that receipt is sealed with it: the head is sealed
      expect(out.receipt).toMatchObject({ action: "seal.signed", actor: "Elan1 Govern", details: { from_seq: 2, to_seq: before.at(-1)!.seq, count: before.length } });
      const chain = await chainOf(d.org.id);
      const seals = await sealsOf(d.org.id);
      expect(seals.map((s) => s.row.seq)).toEqual(chain.slice(1).map((r) => r.seq));
      const kid = chain.at(-1)!.kid!;
      const pub = publicKeyHex(await pemOf(d.org.id, kid));
      let prev = chain[0]!.hash;
      for (const { row, record } of seals) {
        const r = toConsoleReceipt(chain.find((x) => x.seq === row.seq)!) as unknown as seal6.Receipt;
        expect(seal6.verifySeal(record, pub, r)).toEqual({ structure: true, digest: true, signature: true, binding: true });
        expect(record.fields[2]!.value).toBe(prev);
        expect(record.fields[14]!.value).toBe(lexiconHash(d.org.id));
        expect(record.fields[0]!.value).toBe(d.org.id);
        prev = row.digest;
        // the salt is kept, encrypted, and F14 is the payload hashed with it
        const salt = await sealSalt(deps, d.org.id, row.seq);
        expect(record.fields[13]!.value).toBe(seal6.payloadHash(salt!, seal6.payloadOf(r)));
      }
      // F11 as the console gave it, for a decision; A0 for anything else
      const third = seals.find((s) => s.row.seq === 3)!;
      expect(third.record.fields[10]!.value).toBe(chain.find((r) => r.seq === 3)!.kind === "decision" ? "A2" : "A0");
      // nothing new: nothing written
      expect(await sealUpTo(deps, d.org.id, {})).toEqual({ seals: [] });
      expect((await chainOf(d.org.id)).length).toBe(chain.length);
    });
  }

  it("is refused below L2 and needs the boundary the first time", async () => {
    const l1 = await demoOrg(ctx.deps);
    await expect(sealUpTo(ctx.deps, l1.org.id, { fromSeq: 1 })).rejects.toThrow(SigningRefused);
    const d = await l2Org();
    await expect(sealUpTo(ctx.deps, d.org.id, {})).rejects.toThrow(/fromSeq/);
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/console-signing/seal`, { autonomy: { "2": "A9" } });
    expect(res.statusCode).toBe(400);
  });
});

/** A flush with no receipts of its own: only the requests. */
const flushOnly = async (orgId: string, requests: SignatureRequest[], deps = ctx.deps) => flushSigned(deps, orgId, { base: await head(orgId), receipts: [], requests, actor: "owner@test.in" });

describe("DPDP erasure", () => {
  it("redacts the receipts as the console shows them, signed by the org key; destroys the salts; the seals and chain still verify", async () => {
    const d = await l2Org(using(hsm));
    await sealUpTo(ctx.deps, d.org.id, { fromSeq: 1 });
    const chain = await chainOf(d.org.id);
    const target = chain.filter((r) => r.kind === "admin").slice(1, 3).map((r) => r.seq);
    const out = await flushOnly(d.org.id, [{ id: "e1", kind: "erasure", input: { request: "er_1", subjectRef: "DP-2026-0001", seqs: target, at: new Date().toISOString() } }]);
    expect(out.extra).toHaveLength(1);
    expect(out.extra[0]).toMatchObject({ action: "record.erased", actor: "owner@test.in", details: { request: "er_1", subject_ref: "DP-2026-0001", count: 2, seqs: target.join(","), salts_destroyed: 2 } });
    for (const x of out.redactions) {
      const r = x.receipt;
      expect(r.args_summary).toEqual({ erased: true });
      expect(r.redacted).toMatchObject({ fields: ["args_summary"], reason: ERASURE_REASON, request: "DP-2026-0001", payloadHash: x.payloadHash });
      // the org's redaction signature over every field left, with the original hash, as the console's verifier checks it
      expect(verifyText(await pemOf(d.org.id, r.redacted!.kid!), seal6.redactionMessage(r), r.redacted!.sig!)).toBe(true);
      expect(r.hash).toBe(chain.find((c) => c.seq === x.seq)!.hash);
      // the salt is gone; the seal is unchanged, still verifies, and says its payload is unbound
      expect(await sealSalt(ctx.deps, d.org.id, x.seq)).toBeUndefined();
      const s = (await sealsOf(d.org.id)).find((q) => q.row.seq === x.seq)!;
      expect(s.row.payloadUnbound).toBe(true);
      expect(s.record.fields[13]!.value).toBe(x.payloadHash);
      expect(seal6.verifySeal(s.record, publicKeyHex(await pemOf(d.org.id, s.row.kid)), toConsoleReceipt(chain.find((c) => c.seq === x.seq)!) as never).digest).toBe(true);
    }
    // the Receipt rows are unchanged: the chain verifies as it always did
    expect((await chainOf(d.org.id)).slice(0, chain.length)).toEqual(chain);
    // erasing them again changes nothing and writes nothing
    const again = await flushOnly(d.org.id, [{ id: "e2", kind: "erasure", input: { request: "er_1", seqs: target, at: new Date().toISOString() } }]);
    expect(again.extra).toEqual([]);
    expect(again.redactions.map((r) => r.receipt)).toEqual(out.redactions.map((r) => r.receipt));
  });

  it("refuses a receipt that is not in the chain, a record Elan1 Govern keeps, and a date in the future", async () => {
    const d = await l2Org();
    await sealUpTo(ctx.deps, d.org.id, { fromSeq: 1 });
    await expect(flushOnly(d.org.id, [{ id: "e", kind: "erasure", input: { request: "er", seqs: [9999], at: new Date().toISOString() } }])).rejects.toThrow(/no receipt #9999/);
    await expect(flushOnly(d.org.id, [{ id: "e", kind: "erasure", input: { request: "er", seqs: [1], at: new Date().toISOString() } }])).rejects.toThrow(/keeps/);
    const late = new Date(Date.now() + 3_600_000).toISOString();
    await expect(flushOnly(d.org.id, [{ id: "e", kind: "erasure", input: { request: "er", seqs: [2], at: late } }])).rejects.toThrow(/future/);
  });

  it("erases a receipt not sealed yet: the seal made later freezes the erased payload hash and keeps no salt", async () => {
    const d = await l2Org();
    await sealUpTo(ctx.deps, d.org.id, { fromSeq: 1 });
    await writeConsoleReceipts(ctx.deps, d.org.id, { base: await head(d.org.id), receipts: [{ kind: "admin", actor: "x@test.in", action: "settings.updated", details: { field: "retention" } }] });
    const unsealed = (await head(d.org.id)).seq;
    const out = await flushOnly(d.org.id, [{ id: "e", kind: "erasure", input: { request: "er", seqs: [unsealed], at: new Date().toISOString() } }]);
    expect(out.extra[0]).toMatchObject({ action: "record.erased", details: { count: 1, salts_destroyed: 0 } });
    await sealUpTo(ctx.deps, d.org.id, {});
    const s = (await sealsOf(d.org.id)).find((q) => q.row.seq === unsealed)!;
    expect(s.row).toMatchObject({ payloadUnbound: true, saltEnc: null });
    expect(s.record.fields[13]!.value).toBe(out.redactions[0]!.payloadHash);
    const r = (await chainOf(d.org.id)).find((x) => x.seq === unsealed)!;
    expect(seal6.verifySeal(s.record, publicKeyHex(await pemOf(d.org.id, s.row.kid)), toConsoleReceipt(r) as never)).toEqual({ structure: true, digest: true, signature: true, binding: true });
  });

  it("is never something the console can claim in its own receipts", async () => {
    const d = await demoOrg(ctx.deps);
    expect(SIGNING_ACTIONS.filter((a) => !GATE_ONLY_ACTIONS.has(a))).toEqual([]);
    for (const action of SIGNING_ACTIONS) {
      await expect(writeConsoleReceipts(ctx.deps, d.org.id, { base: await head(d.org.id), receipts: [{ kind: "admin", actor: "x@test.in", action }] })).rejects.toThrow(ConsoleChainRefused);
    }
  });
});

describe("signatures built from structured requests", () => {
  /** A disclosure of a receipt, committed with fresh salts, as the console makes one. */
  function disclosureOf(orgId: string, r: Receipt) {
    const c = toConsoleReceipt(r) as unknown as seal6.Receipt;
    const values = seal6.fieldValuesOf(c);
    const salts = Object.fromEntries(Object.keys(values).map((n) => [n, seal6.randomSalt()]));
    const committed = Object.keys(values).sort().map((name) => ({ name, digest: seal6.disclosureDigest(salts[name]!, name, values[name as keyof typeof values]) }));
    return { base: { orgId, seq: c.seq, receiptHash: c.hash, audience: "ar-org:auditor.in", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), committed }, salts };
  }

  it("signs a disclosure of a real receipt once, receipted; the same message again returns the same signature", async () => {
    const d = await l2Org(using(hsm), "l3");
    const r = (await chainOf(d.org.id)).at(-1)!;
    const input = disclosureOf(d.org.id, r);
    const out = await flushOnly(d.org.id, [{ id: "s1", kind: "disclosure", input }]);
    const sig = out.signatures[0]!;
    expect(sig.id).toBe("s1");
    expect(verifyText(await pemOf(d.org.id, sig.kid), seal6.disclosureMessage(input.base), sig.sig)).toBe(true);
    expect(out.extra).toHaveLength(1);
    expect(out.extra[0]).toMatchObject({ action: "disclosure.signed", details: { seq: r.seq, audience: "ar-org:auditor.in", committed: 11, kid: sig.kid } });
    const again = await flushOnly(d.org.id, [{ id: "s2", kind: "disclosure", input }]);
    expect(again.signatures[0]!.sig).toBe(sig.sig);
    expect(again.extra).toEqual([]);
  });

  it("puts the real signature in the operation's own receipts where they quote it", async () => {
    const d = await l2Org(ctx.deps, "l3");
    const r = (await chainOf(d.org.id)).at(-1)!;
    const input = disclosureOf(d.org.id, r);
    const stand = "pending:sign:1:abcdef";
    const out = await flushSigned(ctx.deps, d.org.id, { base: await head(d.org.id), receipts: [{ kind: "admin", actor: "x@test.in", action: "disclosure.created", details: { sig: stand } }], requests: [{ id: stand, kind: "disclosure", input }], actor: "x@test.in" });
    expect(out.receipts[0]!.details!.sig).toBe(out.signatures[0]!.sig);
    expect(out.extra[0]!.seq).toBe(out.receipts[0]!.seq + 1);
  });

  it("refuses commitments that are not over the receipt's own values, another organisation, or a receipt the chain does not hold", async () => {
    const d = await l2Org(ctx.deps, "l3");
    const r = (await chainOf(d.org.id)).at(-1)!;
    const good = disclosureOf(d.org.id, r);
    const forged = { ...good, base: { ...good.base, committed: good.base.committed.map((c, i) => (i === 0 ? { ...c, digest: "ab".repeat(32) } : c)) } };
    await expect(flushOnly(d.org.id, [{ id: "x", kind: "disclosure", input: forged }])).rejects.toThrow(SigningRefused);
    await expect(flushOnly(d.org.id, [{ id: "x", kind: "disclosure", input: { ...good, base: { ...good.base, orgId: "org_other" } } }])).rejects.toThrow(/another organisation/);
    await expect(flushOnly(d.org.id, [{ id: "x", kind: "disclosure", input: { ...good, base: { ...good.base, receiptHash: `sha256:${"0".repeat(64)}` } } }])).rejects.toThrow(/hash/);
    expect(await forOrg(d.org.id).consoleSignature.count()).toBe(0);
  });

  it("signs a usage statement only with the chain's own counts, and a residency statement only for today", async () => {
    const d = await l2Org(using(hsm), "sovereign");
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date().toISOString();
    const chain = (await chainOf(d.org.id)).map((r) => toConsoleReceipt(r) as unknown as seal6.Receipt);
    const inRange = chain.filter((r) => r.ts >= from && r.ts <= to);
    const decisions = inRange.filter((r) => r.kind === "decision" && r.decision);
    const lines = decisions.map((r) => `${r.seq}:${r.decision === "allow" ? 1 : r.decision === "refuse" ? 0.4 : 0}`);
    const committed = decisions.filter((r) => r.decision === "allow").length;
    const refused = decisions.filter((r) => r.decision === "refuse").length;
    const last = inRange.at(-1)!;
    const body = { format: "elan1.usage.statement.v1" as const, org: d.org.id, orgName: d.org.name, period: { from, to, label: "test" }, counts: { decisions: decisions.length, committed, refused, pending: decisions.length - committed - refused, sandbox: 0 }, units: Math.round((committed + refused * 0.4) * 10) / 10, head: { seq: last.seq, hash: last.hash }, meterDigest: seal6.sha256Hex(lines.join("|")) };
    const out = await flushOnly(d.org.id, [{ id: "u", kind: "usage-statement", input: { body } }]);
    expect(verifyText(await pemOf(d.org.id, out.signatures[0]!.kid), seal6.sha256Hex(seal6.canonical(body)), out.signatures[0]!.sig)).toBe(true);
    await expect(flushOnly(d.org.id, [{ id: "u", kind: "usage-statement", input: { body: { ...body, units: body.units + 1 } } }])).rejects.toThrow(/counts are not the chain's/);

    const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
    const statement = { org: d.org.id, domain: "ap-south-1 Mumbai", stores: ["Receipts@Mumbai"], at: day };
    const res = await flushOnly(d.org.id, [{ id: "r", kind: "residency", input: { statement } }]);
    expect(verifyText(await pemOf(d.org.id, res.signatures[0]!.kid), seal6.sha256Hex(seal6.canonical(statement)), res.signatures[0]!.sig)).toBe(true);
    await expect(flushOnly(d.org.id, [{ id: "r", kind: "residency", input: { statement: { ...statement, at: "2026-01-01T00:00:00.000Z" } } }])).rejects.toThrow(/today/);
  });

  it("refuses a manifest over receipts or keys that are not the organisation's", async () => {
    const d = await l2Org();
    const chain = (await chainOf(d.org.id)).map((r) => toConsoleReceipt(r) as unknown as Record<string, unknown>);
    const kid = (await forOrg(d.org.id).orgKey.findFirstOrThrow()).kid;
    const keys = Object.fromEntries((await forOrg(d.org.id).orgKey.findMany()).map((k) => [k.kid, publicKeyHex(k.publicKey)]));
    const pack = (receipts: Record<string, unknown>[], public_keys = keys) => {
      const files = seal6.l1PackFiles({ public_keys, receipts: receipts as never, checkpoints: [], summary_pdf: "pdf", compliance_map: {}, readme: "readme" });
      const members = seal6.L1_PACK_MEMBERS.map((path) => (path === "manifest.json" ? { path, bytes: 0, sha256: "self" } : { path, ...seal6.fileDigest(files[path] ?? "") }));
      const last = receipts.at(-1)!;
      return { manifest: { format: "auditor-pack/1", org_id: d.org.id, digest_of: "file", sealing_kid: kid, record_count: receipts.length, first_seq: receipts[0]!.seq, last_seq: last.seq, last_hash: last.hash, checkpoints: 0, members }, public_keys, receipts, checkpoints: [], summary_pdf: "pdf", compliance_map: {}, readme: "readme" };
    };
    const ok = await flushOnly(d.org.id, [{ id: "m", kind: "pack-manifest", input: pack(chain) }]);
    expect(verifyText(await pemOf(d.org.id, kid), seal6.manifestMessage(pack(chain).manifest as never), ok.signatures[0]!.sig)).toBe(true);
    const changed = chain.map((r, i) => (i === 1 ? { ...r, actor: "someone-else@test.in" } : r));
    await expect(flushOnly(d.org.id, [{ id: "m", kind: "pack-manifest", input: pack(changed) }])).rejects.toThrow(/not the chain's receipt/);
    await expect(flushOnly(d.org.id, [{ id: "m", kind: "pack-manifest", input: pack(chain, { [kid]: "ab".repeat(32) }) }])).rejects.toThrow(/keys.json/);
  });
});

describe("the routes", () => {
  it("never sign a digest or text of the caller's choosing", async () => {
    const d = await l2Org(ctx.deps, "l3");
    const h = await head(d.org.id);
    const flush = (requests: unknown[]) => internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/console-signing/flush`, { base: h, receipts: [], requests, actor: "x@test.in" });
    const digest = "ab".repeat(32);
    for (const req of [{ id: "x", kind: "digest", input: { digest } }, { id: "x", kind: "text", input: { text: "sign me" } }, { id: "x", kind: "residency", input: { message: digest } }, { id: "x", kind: "disclosure", input: { message: digest } }]) {
      expect((await flush([req])).statusCode).toBe(400);
    }
    // the signing routes are the structured ones; there is no route that signs what it is given
    for (const url of ["flush", "seal", "anchor"]) expect(ctx.app.hasRoute({ method: "POST", url: `/internal/orgs/:org/console-signing/${url}` })).toBe(true);
    for (const url of ["sign", "digest", "text"]) expect(ctx.app.hasRoute({ method: "POST", url: `/internal/orgs/:org/console-signing/${url}` })).toBe(false);
    expect(await forOrg(d.org.id).consoleSignature.count()).toBe(0);
  });

  it("are refused without the internal signature, and answer a moved chain with 409", async () => {
    const d = await l2Org();
    const res = await ctx.app.inject({ method: "POST", url: `/internal/orgs/${d.org.id}/console-signing/seal`, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(401);
    const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
    const moved = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/console-signing/flush`, { base: { seq: 1, hash: "sha256:x" }, receipts: [], requests: [{ id: "r", kind: "residency", input: { statement: { org: d.org.id, domain: "x", stores: ["a@b"], at: day } } }], actor: "x@test.in" });
    expect(moved.statusCode).toBe(409);
    const anchored = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/console-signing/anchor`, { actor: "x@test.in" });
    expect(anchored.statusCode).toBe(200);
    expect(anchored.json().batches[0]).toMatchObject({ fromSeq: 1, status: "ok" });
  });
});
