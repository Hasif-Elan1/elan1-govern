import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal6, verifyBundle6, verifyChain, verifyText, type Receipt } from "@gate/core";
import { orgPublicKeys, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConsoleOrg, startGate } from "./console-gate";

// The console's signatures on the organisations' real keys (apps/web/src/server/console-signing.ts and
// apps/gate/src/console-signing.ts): the built domain, the bridge, Postgres and a real gate service with its local
// RFC 3161 authorities. org_kaveri, org_deccan and org_demo hold their keys in the software HSM (moved there below),
// org_northbank in the env provider, so both kinds of custody sign every artefact.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

// new keys (a rotation) are made inside the software HSM
process.env.KEY_PROVIDER = "soft-hsm";
const gateService = await startGate();
const consoleDomain = await import("../src/server/console-domain");
const { gate } = await import("../src/server/gate");
const domain = await import("@gate/console/server");
const gatePath = (p: string) => new URL(`../../gate/src/${p}.ts`, import.meta.url).href;
const { rewrapAll } = (await import(/* @vite-ignore */ gatePath("keys"))) as { rewrapAll(deps: unknown, from: unknown, to: unknown, opts: { orgIds: string[] }): Promise<unknown> };
const { verifyTimestampToken } = (await import(/* @vite-ignore */ gatePath("tsa/token"))) as { verifyTimestampToken(t: unknown, digest: string, certs: string[]): Promise<{ ok: boolean; error?: string }> };
const cli = (await import(/* @vite-ignore */ new URL("../../../packages/cli/src/cli.ts", import.meta.url).href)) as { main(argv: string[], out: (l: string) => void, err: (l: string) => void): Promise<number> };

const NB = "org_northbank";
const KH = "org_kaveri";
const DC = "org_deccan";
const DEMO = "org_demo";
const HSM_ORGS = [KH, DC, DEMO];
const OWNER: Record<string, string> = { [NB]: "u_rohan", [KH]: "u_lakshmi", [DC]: "u_suresh", [DEMO]: "u_ananya" };

type Doc = {
  receipts: (Receipt & { redacted?: { kid?: string; sig?: string; payloadHash?: string } })[];
  checkpoints: unknown[];
  publicKeys: Record<string, string>;
  signingKeys: { kid: string; status: string }[];
  org: { keyFingerprint: string; plan: string };
  platform: { erasures: { id: string; status: string; affectedSeqs: number[]; requestedBy: string; approvals: { userId: string }[] }[]; erased: Record<string, string>; disclosures: { id: string; seq: number; sig: string; kid: string; publicKey: string; orgId: string; receiptHash: string; audience: string; expiresAt: string; committed: { name: string; digest: string }[] }[] };
};
const docOf = async (orgId: string) => (await consoleDomain.stateFor(orgId)).doc as unknown as Doc;
const realChain = async (orgId: string) => (await prisma.receipt.findMany({ where: { orgId }, orderBy: { seq: "asc" } })).map((r) => r.body as Receipt);
const run = async <T = unknown>(orgId: string, op: string, args: unknown[], who = OWNER[orgId]!) => (await consoleDomain.runOp(orgId, who, op, args)).result as T;
const browserChain = (d: Doc) => domain.chainVerifier.verifyChain(d.receipts as never, d.publicKeys, d.checkpoints as never);
const activePem = async (orgId: string) => (await orgPublicKeys(orgId)).find((k) => !k.retiredAt)!.publicKeyPem;

beforeAll(async () => {
  await consoleDomain.forgetConsoleMemory();
  for (const org of [NB, KH, DC, DEMO]) await resetConsoleOrg(org);
  // custody in the software HSM: the private key never leaves it, so every signature below goes through it
  const deps = gateService.deps as unknown as { keyProviders: { name: string }[] };
  const env = deps.keyProviders.find((p) => p.name === "env");
  const hsm = deps.keyProviders.find((p) => p.name === "soft-hsm");
  await rewrapAll(gateService.deps, env, hsm, { orgIds: HSM_ORGS });
}, 120_000);
afterAll(async () => {
  await gateService.close();
  await prisma.$disconnect();
});

describe("custody", () => {
  it("holds Kaveri's, Deccan's and Demo Traders' keys in the software HSM and Northbank's in the env provider", async () => {
    for (const orgId of HSM_ORGS) expect(new Set((await prisma.orgKey.findMany({ where: { orgId } })).map((k) => k.provider))).toEqual(new Set(["soft-hsm"]));
    expect((await prisma.orgKey.findMany({ where: { orgId: NB } })).every((k) => k.provider === "env" || k.provider === "soft-hsm")).toBe(true);
  });
});

describe("DPDP erasure on the real chain", () => {
  it("carries Kaveri's seeded erasure out on its chain: redacted, signed by its real key, salts destroyed, and the chain verifies", async () => {
    const d = await docOf(KH);
    const executed = d.platform.erasures.find((e) => e.status === "executed")!;
    expect(executed.affectedSeqs.length).toBeGreaterThan(0);
    const rows = await prisma.receiptRedaction.findMany({ where: { orgId: KH } });
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual([...executed.affectedSeqs].sort((a, b) => a - b));
    const kids = new Set(Object.keys(d.publicKeys));
    for (const seq of executed.affectedSeqs) {
      const r = d.receipts.find((x) => x.seq === seq)!;
      expect(r.args_summary).toEqual({ erased: true });
      expect(kids.has(r.redacted!.kid!)).toBe(true);
      expect(r.redacted!.sig).toMatch(/^ed25519:/);
      expect(d.platform.erased[seq]).toBe(r.redacted!.payloadHash);
    }
    // the receipts the gate wrote for it: one record.erased naming them
    const chain = await realChain(KH);
    const erased = chain.filter((r) => r.action === "record.erased");
    expect(erased).toHaveLength(1);
    expect(String(erased[0]!.details!.seqs).split(",").map(Number)).toEqual([...executed.affectedSeqs].sort((a, b) => a - b));
    // the salts are gone and the seals say so
    const seals = await prisma.sealRecord.findMany({ where: { orgId: KH, seq: { in: executed.affectedSeqs } } });
    for (const s of seals) expect(s).toMatchObject({ saltEnc: null, payloadUnbound: true });
    // the console's verifier over the document (erased copies) and core's over the chain (the rows are unchanged)
    expect(browserChain(d)).toMatchObject({ result: "verified" });
    expect(verifyChain(chain, await orgPublicKeys(KH))).toMatchObject({ ok: true, count: chain.length });
    // and the console's own integrity run passes
    const ir = await run<{ result: string; brokenAt?: number }>(KH, "api.runIntegrity", [KH, OWNER[KH]]);
    expect(ir).toMatchObject({ result: "pass" });
  });

  it("executes a new erasure through the gate after two approvals, and the chain still verifies", async () => {
    const d = await docOf(KH);
    const e = d.platform.erasures.find((x) => x.status === "awaiting_approval");
    expect(e).toBeDefined();
    // the request was opened by the DPO and approved once by the owner: an admin gives the second approval
    const second = "u_kh_arvind";
    expect([e!.requestedBy, ...e!.approvals.map((a) => a.userId)]).not.toContain(second);
    await run(KH, "api.approveErasure", [KH, e!.id, second], second);
    const done = await run<{ status: string; affectedSeqs: number[] }>(KH, "api.executeErasure", [KH, e!.id, second], second);
    expect(done.status).toBe("executed");
    const after = await docOf(KH);
    for (const seq of done.affectedSeqs) expect(after.receipts.find((r) => r.seq === seq)?.redacted?.sig).toMatch(/^ed25519:/);
    expect(browserChain(after)).toMatchObject({ result: "verified" });
    const chain = await realChain(KH);
    expect(chain.filter((r) => r.action === "record.erased")).toHaveLength(2);
    expect(verifyChain(chain, await orgPublicKeys(KH))).toMatchObject({ ok: true });
  });
});

/** Run the CLI's `govern verify` on a bundle, as an auditor would. */
async function governVerify(bundle: unknown, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "gate-signing-"));
  const file = join(dir, "bundle.json");
  writeFileSync(file, JSON.stringify(bundle));
  const out: string[] = [];
  const code = await cli.main(["verify", file, ...args], (l) => out.push(l), (l) => out.push(l));
  return { code, first: out[0] ?? "", out: out.join("\n") };
}

/** What a person answers in the export dialog (residency, purpose, declarations). */
const EXPORT_ANSWERS = { container: "json", gate: { residency: "inside", purpose: "Statutory audit sample", acknowledged: true } };

describe("Seal v6 evidence from the real chain", () => {
  let checkedTo = 0;
  type Batch = { id: string; firstSeq: number; lastSeq: number; root: string; tokens: { tsaId: string; der: string; imprint: string; genTime: string; serial: string; policyOid: string; tsaName: string; chain: string[] }[] };
  type Bundle = { manifest: Record<string, unknown> & { signing_kid: string; last_seq: number }; manifest_sig: string; seals: { seq: number; kid: string }[]; receipts: { seq: number }[]; anchors: { authorities: { id: string; certPem?: string }[]; batches: Batch[] } };

  it("anchors Northbank's records with real RFC 3161 tokens from the two local authorities", async () => {
    // an export must be covered by a completed integrity run: run it first, so the batch covers its receipt too
    const ir = await run<{ result: string; seq: number }>(NB, "api.runIntegrity", [NB, OWNER[NB]]);
    expect(ir).toMatchObject({ result: "pass" });
    checkedTo = ir.seq;
    const b = await run<{ id: string; firstSeq: number; lastSeq: number; root: string; tokens: Batch["tokens"] }>(NB, "api.anchorNow", [NB, OWNER[NB]]);
    expect(b.tokens.map((t) => t.tsaId).sort()).toEqual(["local-a", "local-b"]);
    const certs = await prisma.tsaKey.findMany();
    for (const t of b.tokens) {
      expect(t.imprint).toBe(b.root);
      const check = await verifyTimestampToken({ ...t }, b.root, certs.filter((c) => c.id === t.tsaId).map((c) => c.certPem));
      expect(check).toMatchObject({ ok: true });
    }
    const row = await prisma.anchorBatch.findUnique({ where: { id: b.id } });
    expect(row).toMatchObject({ orgId: NB, fromSeq: b.firstSeq, toSeq: b.lastSeq, root: b.root, status: "ok" });
  });

  it("exports a Northbank L2 bundle the CLI and the console's own verifier both pass, signed by the real key", async () => {
    const anchored = (await prisma.anchorBatch.findFirst({ where: { orgId: NB }, orderBy: { toSeq: "desc" } }))!.toSeq;
    const to = Math.min(anchored, checkedTo);
    const out = await run<{ bundle: Bundle; json: string }>(NB, "api.exportPack", [NB, OWNER[NB], to - 250, to, undefined, EXPORT_ANSWERS]);
    const bundle = out.bundle;
    const kid = (await orgPublicKeys(NB)).find((k) => !k.retiredAt)!.kid;
    expect(bundle.manifest.signing_kid).toBe(kid);
    expect(bundle.manifest_sig).toMatch(/^ed25519:/);
    expect(JSON.parse(out.json).manifest_sig).toBe(bundle.manifest_sig);
    expect(bundle.seals.length).toBeGreaterThan(100);
    expect(verifyText(await activePem(NB), seal6.manifestMessage(bundle.manifest as never), bundle.manifest_sig)).toBe(true);
    // every seal is the gate's, and the gate wrote what it signed
    const stored = await prisma.sealRecord.count({ where: { orgId: NB, seq: { in: bundle.seals.map((s) => s.seq) } } });
    expect(stored).toBe(bundle.seals.length);
    expect((await realChain(NB)).some((r) => r.action === "evidence.manifest_signed")).toBe(true);

    expect(verifyBundle6(bundle, { expectedFingerprint: kid })).toMatchObject({ code: "PASS" });
    const pinned = await governVerify(bundle, "--fingerprint", kid);
    expect(pinned.first).toBe("PASS (exit 0): Pass");
    expect(pinned.code).toBe(0);
    expect(domain.bundleVerifier.verifyBundle(bundle, { expectedFingerprint: kid })).toMatchObject({ code: "PASS" });
    // a changed token fails both
    const bad = structuredClone(bundle);
    const t = bad.anchors.batches[0]!.tokens[0]!;
    t.der = Buffer.from(Buffer.from(t.der, "base64").map((x, i, a) => (i === a.length - 10 ? x ^ 1 : x))).toString("base64");
    expect(verifyBundle6(bad, { expectedFingerprint: kid }).code).toBe("FAIL_INTEGRITY");
    expect(domain.bundleVerifier.verifyBundle(bad, { expectedFingerprint: kid }).code).toBe("FAIL_INTEGRITY");
  });

  it("exports Kaveri's (HSM-held key) bundle over its erased records: payload unbound, and it verifies", async () => {
    const ir = await run<{ result: string; seq: number }>(KH, "api.runIntegrity", [KH, OWNER[KH]]);
    expect(ir).toMatchObject({ result: "pass" });
    await run(KH, "api.anchorNow", [KH, OWNER[KH]]);
    const anchored = (await prisma.anchorBatch.findFirst({ where: { orgId: KH }, orderBy: { toSeq: "desc" } }))!.toSeq;
    const to = Math.min(anchored, ir.seq);
    // a range that holds erased records, within one bundle's size
    const erased = (await prisma.receiptRedaction.findMany({ where: { orgId: KH }, orderBy: { seq: "asc" } })).map((r) => r.seq);
    const last = erased.filter((q) => q <= to).at(-1)!;
    const out = await run<{ bundle: Bundle }>(KH, "api.exportPack", [KH, OWNER[KH], last - 120, Math.min(to, last + 120), undefined, EXPORT_ANSWERS]);
    expect(out.bundle.receipts.some((r) => erased.includes(r.seq))).toBe(true);
    const kid = (await orgPublicKeys(KH)).find((k) => !k.retiredAt)!.kid;
    expect(verifyBundle6(out.bundle, { expectedFingerprint: kid })).toMatchObject({ code: "PASS_PAYLOAD_UNBOUND" });
    expect(domain.bundleVerifier.verifyBundle(out.bundle, { expectedFingerprint: kid })).toMatchObject({ code: "PASS_PAYLOAD_UNBOUND" });
    expect((await governVerify(out.bundle, "--fingerprint", kid)).code).toBe(0);
  });
});

describe("disclosure", () => {
  it("signs a Kaveri disclosure with its real key; the seeded ones are re-signed too", async () => {
    const d = await docOf(KH);
    const r = [...d.receipts].reverse().find((x) => x.kind === "decision" && !x.redacted)!;
    const pkg = await run<Doc["platform"]["disclosures"][number]>(KH, "api.createDisclosure", [KH, { seq: r.seq, fields: ["decision", "tool"], audience: "ar-org:starhealth.in" }, OWNER[KH], { acknowledgeFirstIssue: true }]);
    const pem = await activePem(KH);
    expect(pkg.sig).toMatch(/^ed25519:/);
    expect(verifyText(pem, seal6.disclosureMessage(pkg), pkg.sig)).toBe(true);
    expect(seal6.verifyDisclosure(pkg as never).valid).toBe(true);
    const after = await docOf(KH);
    const keys = await orgPublicKeys(KH);
    for (const p of after.platform.disclosures) {
      const k = keys.find((x) => x.kid === p.kid)!;
      expect(verifyText(k.publicKeyPem, seal6.disclosureMessage(p), p.sig)).toBe(true);
    }
    expect((await realChain(KH)).filter((x) => x.action === "disclosure.signed").length).toBeGreaterThan(0);
  });

  it("reads the disclosure bundles and profiles of Kaveri and Deccan (their seeds are signed by the gate)", async () => {
    for (const orgId of [KH, DC]) {
      const bundles = await run<{ id: string; sig: string; kid: string }[]>(orgId, "api.disclosureBundles", [orgId]);
      expect(bundles.length).toBeGreaterThan(0);
      for (const b of bundles) expect(b.sig).toMatch(/^ed25519:/);
      await run(orgId, "api.disclosureProfiles", [orgId]);
    }
  });
});

describe("signed statements", () => {
  it("signs a Deccan usage statement (HSM-held key) that core verifies", async () => {
    const periods = await run<{ id: string }[]>(DC, "sovereign.statements", [DC]).catch(() => []);
    void periods;
    const r = await run<{ statement: { digest: string; sig: string; kid: string; format: string; org: string; orgName: string; period: unknown; counts: unknown; units: number; head: unknown; meterDigest: string } }>(DC, "sovereign.exportStatement", [DC, new Date().toISOString().slice(0, 7), "USB-SERIAL-0042", OWNER[DC]]);
    const s = r.statement;
    const { digest: _d, sig: _s, kid: _k, ...rest } = s as typeof s & Record<string, unknown>;
    void rest;
    const body = { format: s.format, org: s.org, orgName: s.orgName, period: s.period, counts: s.counts, units: s.units, head: s.head, meterDigest: s.meterDigest };
    expect(seal6.sha256Hex(seal6.canonical(body))).toBe(s.digest);
    expect(verifyText(await activePem(DC), s.digest, s.sig)).toBe(true);
    expect((await realChain(DC)).some((x) => x.action === "statement.signed")).toBe(true);
  });

  it("signs every organisation's residency statement once a day", async () => {
    for (const orgId of [NB, KH, DC, DEMO]) {
      const v = await run<{ proof: { digest: string; sig: string; kid: string } }>(orgId, "api.residency", [orgId]);
      expect(verifyText(await activePem(orgId), v.proof.digest, v.proof.sig)).toBe(true);
      const again = await run<{ proof: { sig: string } }>(orgId, "api.residency", [orgId]);
      expect(again.proof.sig).toBe(v.proof.sig);
    }
  });
});

describe("key rotation", () => {
  it("rotates Demo Traders' real key (generated in the software HSM) and the chain verifies across it", async () => {
    const before = (await orgPublicKeys(DEMO)).find((k) => !k.retiredAt)!.kid;
    await run(DEMO, "api.rotateKey", [DEMO, OWNER[DEMO]]);
    const keys = await orgPublicKeys(DEMO);
    const now = keys.find((k) => !k.retiredAt)!;
    expect(now.kid).not.toBe(before);
    expect((await prisma.orgKey.findFirst({ where: { orgId: DEMO, kid: now.kid } }))?.provider).toBe("soft-hsm");
    const chain = await realChain(DEMO);
    const rot = chain.findLast((r) => r.action === "key.rotated")!;
    expect(rot).toMatchObject({ kid: before, details: { old_kid: before, new_kid: now.kid } });
    expect(chain.at(-1)).toMatchObject({ action: "key.signing_started", kid: now.kid });
    expect(verifyChain(chain, keys)).toMatchObject({ ok: true, count: chain.length });
    const d = await docOf(DEMO);
    expect(d.org.keyFingerprint).toBe(now.kid);
    expect(browserChain(d)).toMatchObject({ result: "verified" });
  });
});

describe("successor keys", () => {
  type KeysState = { bound?: { kid: string; switchAt?: string }; active?: { kid: string } };

  it("runs Kaveri's key ceremony in the gate's custody (HSM): the successor is bound, confirmed by a second person, and signs after the overlap", async () => {
    const before = (await orgPublicKeys(KH)).find((k) => !k.retiredAt)!.kid;
    const c = await run<{ kidAfter: string; boundSeq: number; switchAt: string }>(KH, "api.runKeyCeremony", [KH, OWNER[KH]]);
    const s = (await prisma.keySuccessor.findFirst({ where: { orgId: KH, activatedAt: null, withdrawnAt: null } }))!;
    expect(s).toMatchObject({ kid: c.kidAfter, provider: "soft-hsm", proposedBy: OWNER[KH], boundSeq: c.boundSeq });
    expect(c.switchAt).toBe(s.switchAt.toISOString());
    let chain = await realChain(KH);
    expect(chain.find((r) => r.seq === c.boundSeq)).toMatchObject({ action: "key.bound", details: { kid: s.kid, signing: "off" } });
    expect(chain.filter((r) => r.action === "key.bound" && r.details?.kid === s.kid)).toHaveLength(1);
    let d = await docOf(KH);
    expect(d.signingKeys.find((k) => k.kid === s.kid)?.status).toBe("bound");
    expect(d.publicKeys[s.kid]).toBeDefined();
    expect((await run<KeysState>(KH, "keys.state", [KH])).bound?.kid).toBe(s.kid);

    // the binder cannot turn it on; a second owner or admin confirms, and it still waits for the overlap
    await expect(run(KH, "keys.signingOn", [KH, OWNER[KH]])).rejects.toThrow(/different owner or admin/);
    await expect(run(KH, "keys.signingOn", [KH, "u_kh_arvind"], "u_kh_arvind")).rejects.toThrow(/30-day overlap/);
    expect((await prisma.keySuccessor.findUnique({ where: { id: s.id } }))?.confirmedBy).toBe("u_kh_arvind");
    expect((await orgPublicKeys(KH)).find((k) => !k.retiredAt)!.kid).toBe(before);

    // the overlap ends: the gate switches (key.rotated signed by the old key) and the console records it
    await prisma.keySuccessor.update({ where: { id: s.id }, data: { switchAt: new Date(Date.now() - 1000) } });
    await run(KH, "keys.settle", [KH]);
    const keys = await orgPublicKeys(KH);
    expect(keys.find((k) => !k.retiredAt)!.kid).toBe(s.kid);
    chain = await realChain(KH);
    const rot = chain.findLast((r) => r.action === "key.rotated")!;
    expect(rot).toMatchObject({ kid: before, details: { old_kid: before, new_kid: s.kid, successor: true } });
    expect(chain.find((r) => r.seq > rot.seq && r.action === "key.signing_started")).toMatchObject({ kid: s.kid });
    expect(verifyChain(chain, keys)).toMatchObject({ ok: true, count: chain.length });
    d = await docOf(KH);
    expect(browserChain(d)).toMatchObject({ result: "verified" });
    const state = await run<KeysState>(KH, "keys.state", [KH]);
    expect(state.bound).toBeUndefined();
    expect(state.active?.kid).toBe(s.kid);
  });

  it("binds and withdraws a successor at Northbank (L2: a KMS rotation needs two people)", async () => {
    await run(NB, "keys.requestKmsRotation", [NB, OWNER[NB], "Yearly rotation of the signing key"]);
    await expect(run(NB, "keys.approveKmsRotation", [NB, OWNER[NB]])).rejects.toThrow(/Another owner or admin|different owner or admin/);
    await run(NB, "keys.approveKmsRotation", [NB, "u_nb_neha"], "u_nb_neha");
    const s = (await prisma.keySuccessor.findFirst({ where: { orgId: NB, activatedAt: null, withdrawnAt: null } }))!;
    expect(s.proposedBy).toBe("u_nb_neha");
    expect((await run<KeysState>(NB, "keys.state", [NB])).bound?.kid).toBe(s.kid);
    await run(NB, "keys.withdrawBound", [NB, OWNER[NB], "Rotation postponed"]);
    expect((await prisma.keySuccessor.findUnique({ where: { id: s.id } }))?.withdrawnAt).not.toBeNull();
    expect((await realChain(NB)).at(-1)).toMatchObject({ action: "key.bound_withdrawn", details: { kid: s.kid } });
    expect((await run<KeysState>(NB, "keys.state", [NB])).bound).toBeUndefined();
    const d = await docOf(NB);
    expect(d.signingKeys.find((k) => k.kid === s.kid)?.status).toBe("revoked");
    expect(browserChain(d)).toMatchObject({ result: "verified" });
  });
});

describe("reads that touch the real chain's hashes", () => {
  it("lists counterparties, cross-organisation receipts and disclosures on every L2+ organisation", async () => {
    for (const orgId of [NB, KH, DC]) {
      for (const op of ["agents.evidenceIndex", "agents.counterpartiesByAgent", "api.counterparties", "api.crossOrgReceipts", "api.crossOrgStanding", "api.disclosures"]) {
        await expect(run(orgId, op, [orgId]), `${op} on ${orgId}`).resolves.toBeDefined();
      }
    }
  });
});

describe("the gate signs nothing it is handed", () => {
  const flush = async (orgId: string, requests: unknown[]) => {
    const head = (await prisma.receipt.findFirst({ where: { orgId }, orderBy: { seq: "desc" } }))!;
    return gate<{ error?: string }>("POST", `/internal/orgs/${orgId}/console-signing/flush`, { base: { seq: head.seq, hash: head.hash }, receipts: [], requests, actor: "test" });
  };

  it("refuses a request to sign a digest or text of the caller's choosing", async () => {
    const digest = "ab".repeat(32);
    expect((await flush(KH, [{ id: "x", kind: "digest", input: { digest } }])).status).toBe(400);
    expect((await flush(KH, [{ id: "x", kind: "text", input: { text: "anything" } }])).status).toBe(400);
    // a disclosure whose commitments are not over the receipt's own values
    const r = (await realChain(KH)).findLast((x) => x.kind === "decision")!;
    const committed = seal6.DISCLOSABLE_FIELDS.map((name) => ({ name, digest })).sort((a, b) => a.name.localeCompare(b.name));
    const salts = Object.fromEntries(seal6.DISCLOSABLE_FIELDS.map((n) => [n, "00".repeat(16)]));
    const forged = await flush(KH, [{ id: "x", kind: "disclosure", input: { base: { orgId: KH, seq: r.seq, receiptHash: r.hash, audience: "ar-org:x.in", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), committed }, salts } }]);
    expect(forged.status).toBe(422);
    // a manifest over receipts the chain does not hold
    const fake = await flush(NB, [{ id: "x", kind: "pack-manifest", input: { manifest: { org_id: NB, format: "auditor-pack/1", digest_of: "file", sealing_kid: "x" }, public_keys: {}, receipts: [{ seq: 1, hash: digest }], checkpoints: [], summary_pdf: "", compliance_map: {}, readme: "" } }]);
    expect([400, 422]).toContain(fake.status);
    // a residency statement dated another day
    const day = await flush(NB, [{ id: "x", kind: "residency", input: { statement: { org: NB, domain: "x", stores: ["a@b"], at: "2020-01-01T00:00:00.000Z" } } }]);
    expect(day.status).toBe(422);
    // the chain holds no signature for any of them
    expect(await prisma.consoleSignature.count({ where: { message: digest } })).toBe(0);
  });
});
