import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { generateKeyPair, keyFingerprint, shamir, verifyChain, verifyCheckpoint, type Receipt } from "@gate/core";
import { forOrg, orgPublicKeys, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, setUpDemoAgent } from "../src/admin";
import { checkpoint } from "../src/chain";
import { activateSuccessor, planSuccessor, quorumCheck, settleSuccessor, startKeyCeremony, SUCCESSOR_OVERLAP_DAYS } from "../src/custody";
import { keyProvidersFromEnv, orgKey, type Deps } from "../src/deps";
import { readGateEnv } from "../src/env";
import { exportBundle } from "../src/evidence";
import { activeKey, envKeyProvider, KeyNotExtractableError, providerFor, rewrapAll, rotateSigningKey } from "../src/keys";
import { AwsKmsKeyProvider, kmsClient, type KmsSender } from "../src/kms";
import { SoftHsmKeyProvider } from "../src/soft-hsm";
import { env, gateMeta, makeApp, makeUser, tool } from "./helpers";

/**
 * An in-memory AWS KMS for the two commands the provider uses. Data keys are "encrypted" under a
 * root key with the key id and encryption context as AAD, so Decrypt fails for any other key or
 * context, as real KMS does. Nothing here touches the network.
 */
class FakeKms implements KmsSender {
  readonly root = randomBytes(32);
  readonly calls: { op: string; keyId?: string; context?: Record<string, string> }[] = [];
  /** Plaintext data keys handed out, to check the provider zeroes them. */
  readonly handedOut: Uint8Array[] = [];
  fail?: Error;
  constructor(readonly keyId: string) {}

  async send(command: GenerateDataKeyCommand | DecryptCommand) {
    if (this.fail) throw this.fail;
    const aad = (keyId: string | undefined, ctx: Record<string, string> | undefined) => Buffer.from(JSON.stringify([keyId, Object.entries(ctx ?? {}).sort()]));
    if (command instanceof GenerateDataKeyCommand) {
      const { KeyId, EncryptionContext, KeySpec } = command.input;
      this.calls.push({ op: "GenerateDataKey", keyId: KeyId, context: EncryptionContext });
      if (KeyId !== this.keyId) throw Object.assign(new Error(`key ${KeyId} not found; secret=AKIA-should-not-leak`), { name: "NotFoundException" });
      if (KeySpec !== "AES_256") throw new Error("only AES_256 here");
      const plaintext = new Uint8Array(randomBytes(32));
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", this.root, iv).setAAD(aad(KeyId, EncryptionContext));
      const blob = Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]);
      this.handedOut.push(plaintext);
      return { KeyId, CiphertextBlob: new Uint8Array(blob), Plaintext: plaintext };
    }
    const { KeyId, EncryptionContext, CiphertextBlob } = command.input;
    this.calls.push({ op: "Decrypt", keyId: KeyId, context: EncryptionContext });
    const blob = Buffer.from(CiphertextBlob!);
    try {
      const d = createDecipheriv("aes-256-gcm", this.root, blob.subarray(0, 12)).setAAD(aad(KeyId, EncryptionContext));
      d.setAuthTag(blob.subarray(blob.length - 16));
      const plaintext = new Uint8Array(Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]));
      this.handedOut.push(plaintext);
      return { KeyId, Plaintext: plaintext };
    } catch {
      throw Object.assign(new Error("context mismatch"), { name: "InvalidCiphertextException" });
    }
  }
}

const KMS_KEY = "arn:aws:kms:ap-south-1:000000000000:key/test-key";
const fake = new FakeKms(KMS_KEY);
const kms = new AwsKmsKeyProvider({ keyId: KMS_KEY, client: fake });
const hsm = new SoftHsmKeyProvider(env.GATE_MASTER_KEY, prisma);
const envKeys = envKeyProvider(env.GATE_MASTER_KEY);

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp({ keyProviders: [envKeys, hsm, kms] });
});
afterAll(() => ctx.app.close());

/** The app's deps with another provider for new keys. */
const using = (keys: Deps["keys"]): Deps => ({ ...ctx.deps, keys });

const receipts = async (orgId: string) => (await forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);
const verified = async (orgId: string) => verifyChain(await receipts(orgId), await orgPublicKeys(orgId));

async function orgWith(deps: Deps, name = "Custody Co") {
  const owner = await makeUser();
  const org = await createOrg(deps, { name, ownerUserId: owner.id, ownerEmail: owner.email });
  const demo = await setUpDemoAgent(deps, org.id, owner);
  return { org, owner, apiKey: demo.apiKey };
}

describe("AWS KMS key provider", () => {
  it("wraps with a KMS data key under the { orgId, kid } context and unwraps only in that context", async () => {
    const pem = generateKeyPair().privateKeyPem;
    const wrapped = await kms.wrap(pem, { orgId: "org_a", kid: "kid_a" });
    expect(wrapped).toMatch(/^kms1:[A-Za-z0-9+/=]+:v1\./);
    expect(wrapped).not.toContain("PRIVATE KEY");
    expect(fake.calls.at(-1)).toEqual({ op: "GenerateDataKey", keyId: KMS_KEY, context: { orgId: "org_a", kid: "kid_a" } });
    expect(await kms.unwrap(wrapped, { orgId: "org_a", kid: "kid_a" })).toBe(pem);
    expect(fake.calls.at(-1)).toEqual({ op: "Decrypt", keyId: KMS_KEY, context: { orgId: "org_a", kid: "kid_a" } });
    // The plaintext data keys were zeroed once used.
    expect(fake.handedOut.slice(-2).every((k) => k.every((b) => b === 0))).toBe(true);

    // Moved to another org or key id, KMS refuses to decrypt the data key.
    await expect(kms.unwrap(wrapped, { orgId: "org_b", kid: "kid_a" })).rejects.toThrow("AWS KMS Decrypt failed: InvalidCiphertextException");
    await expect(kms.unwrap(wrapped, { orgId: "org_a", kid: "kid_b" })).rejects.toThrow("AWS KMS Decrypt failed: InvalidCiphertextException");
    await expect(kms.unwrap("v1.abc.def.ghi", { orgId: "org_a", kid: "kid_a" })).rejects.toThrow("not an aws-kms wrapped key");
    await expect(kms.unwrap("kms1:a:b:c", { orgId: "org_a", kid: "kid_a" })).rejects.toThrow("not an aws-kms wrapped key");
  });

  it("keeps only the AWS error name, and refuses bad data keys", async () => {
    const other = new AwsKmsKeyProvider({ keyId: "alias/missing", client: fake });
    const err = await other.wrap("pem", { orgId: "o", kid: "k" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("AWS KMS GenerateDataKey failed: NotFoundException");
    expect((err as Error).message).not.toContain("AKIA");

    const broken: KmsSender = { send: async () => ({ Plaintext: new Uint8Array(16), CiphertextBlob: new Uint8Array(4) }) };
    const p = new AwsKmsKeyProvider({ keyId: KMS_KEY, client: broken });
    await expect(p.wrap("pem", { orgId: "o", kid: "k" })).rejects.toThrow("no usable data key");
    await expect(p.unwrap("kms1:AAAA:v1.a.b.c", { orgId: "o", kid: "k" })).rejects.toThrow("no usable data key");
    const throwsString: KmsSender = { send: () => Promise.reject("down") };
    await expect(new AwsKmsKeyProvider({ keyId: KMS_KEY, client: throwsString }).wrap("pem", { orgId: "o", kid: "k" })).rejects.toThrow("AWS KMS GenerateDataKey failed: unknown error");
    expect(() => new AwsKmsKeyProvider({ keyId: "", client: fake })).toThrow(/AWS_KMS_KEY_ID is required/);
  });

  it("is configured from the environment, with a real client only when asked for", () => {
    expect(() => readGateEnv({ ...process.env, KEY_PROVIDER: "aws-kms" })).toThrow(/AWS_KMS_KEY_ID: is required when KEY_PROVIDER=aws-kms/);
    expect(() => readGateEnv({ ...process.env, KEY_PROVIDER: "aws-kms", AWS_KMS_KEY_ID: KMS_KEY, AWS_REGION: "not a region" })).toThrow(/AWS_REGION/);
    expect(() => readGateEnv({ ...process.env, KEY_PROVIDER: "nope" })).toThrow(/KEY_PROVIDER/);
    const e = readGateEnv({ ...process.env, KEY_PROVIDER: "aws-kms", AWS_KMS_KEY_ID: KMS_KEY, AWS_REGION: "ap-south-1" });
    expect(keyProvidersFromEnv(e, prisma, fake).active.name).toBe("aws-kms");
    // Constructing the real client makes no AWS call.
    expect(keyProvidersFromEnv(e, prisma).all.map((p) => p.name)).toEqual(["env", "soft-hsm", "aws-kms"]);
    expect(typeof kmsClient("ap-south-1").send).toBe("function");
    const plain = readGateEnv({ ...process.env, KEY_PROVIDER: "soft-hsm" });
    expect(keyProvidersFromEnv(plain, prisma).active.name).toBe("soft-hsm");
    expect(() => keyProvidersFromEnv({ ...plain, KEY_PROVIDER: "aws-kms" }, prisma)).toThrow("KEY_PROVIDER=aws-kms is not configured");
    expect(readGateEnv(process.env).KEY_PROVIDER).toBe("env");
  });

  it("an org on aws-kms signs, rotates and verifies like any other", async () => {
    const deps = using(kms);
    const d = await orgWith(deps);
    const row = await forOrg(d.org.id).orgKey.findFirstOrThrow();
    expect(row).toMatchObject({ provider: "aws-kms" });
    expect(row.privateKeyEnc).toMatch(/^kms1:/);
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    await rotateSigningKey(deps, d.org.id, d.owner.email);
    expect((await forOrg(d.org.id).orgKey.findMany()).map((k) => k.provider)).toEqual(["aws-kms", "aws-kms"]);
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    expect(await verified(d.org.id)).toMatchObject({ ok: true });
  });
});

describe("providers side by side", () => {
  it("unwrap dispatches on the provider stored on each row", async () => {
    const deps = using(envKeys);
    const d = await orgWith(deps);
    await rotateSigningKey(using(kms), d.org.id, d.owner.email);
    expect((await forOrg(d.org.id).orgKey.findMany({ orderBy: { createdAt: "asc" } })).map((k) => k.provider)).toEqual(["env", "aws-kms"]);
    // The env-backed app signs with the aws-kms row it now finds active.
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    expect(await verified(d.org.id)).toMatchObject({ ok: true });
    expect(providerFor(deps, "env").name).toBe("env");
    expect(providerFor({ ...deps, keyProviders: [] }, "env").name).toBe("env");
    expect(() => providerFor({ ...deps, keyProviders: [] }, "aws-kms")).toThrow(/no "aws-kms" key provider is configured/);
  });

  it("rewrapAll moves every key from one provider to another, with a receipt per org", async () => {
    const deps = using(envKeys);
    const d = await orgWith(deps, "Rewrap Co");
    await rotateSigningKey(deps, d.org.id, d.owner.email);
    await planSuccessor(deps, d.org.id, d.owner.email);
    const before = await forOrg(d.org.id).orgKey.findMany({ orderBy: { createdAt: "asc" } });
    const pems = await Promise.all(before.map((k) => envKeys.unwrap(k.privateKeyEnc, { orgId: d.org.id, kid: k.kid })));

    const r = await rewrapAll(using(kms), envKeys, kms, { actor: d.owner.email, orgIds: [d.org.id] });
    expect(r).toEqual({ orgs: 1, keys: 3 });
    const after = await forOrg(d.org.id).orgKey.findMany({ orderBy: { createdAt: "asc" } });
    expect(after.map((k) => k.provider)).toEqual(["aws-kms", "aws-kms"]);
    expect(await Promise.all(after.map((k) => kms.unwrap(k.privateKeyEnc, { orgId: d.org.id, kid: k.kid })))).toEqual(pems);
    expect((await forOrg(d.org.id).keySuccessor.findFirstOrThrow()).provider).toBe("aws-kms");
    const last = (await receipts(d.org.id)).at(-1)!;
    expect(last).toMatchObject({ action: "key.rewrapped", actor: d.owner.email, details: { from: "env", to: "aws-kms" } });
    expect((last.details!.kids as string[]).sort()).toEqual([...before.map((k) => k.kid), (await forOrg(d.org.id).keySuccessor.findFirstOrThrow()).kid].sort());
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    expect(await verified(d.org.id)).toMatchObject({ ok: true });

    // Nothing left on env for this org: a second run skips it.
    const head = (await receipts(d.org.id)).at(-1)!.seq;
    const again = await rewrapAll(using(kms), envKeys, kms, { orgIds: [d.org.id] });
    expect((await receipts(d.org.id)).at(-1)!.seq).toBe(head);
    expect(again).toEqual({ orgs: 0, keys: 0 });
    await expect(rewrapAll(deps, kms, kms)).rejects.toThrow(/two different key providers/);
  });

  it("a key held in the software HSM cannot be re-wrapped out of it", async () => {
    const d = await orgWith(using(hsm), "Stuck Co");
    await expect(rewrapAll(using(envKeys), hsm, envKeys, { orgIds: [d.org.id] })).rejects.toThrow(KeyNotExtractableError);
    expect((await forOrg(d.org.id).orgKey.findFirstOrThrow()).provider).toBe("soft-hsm");
  });
});

describe("software HSM", () => {
  it("holds org keys: the chain, checkpoints and rulebooks sign inside it", async () => {
    const deps = using(hsm);
    const d = await orgWith(deps, "HSM Co");
    const row = await forOrg(d.org.id).orgKey.findFirstOrThrow();
    expect(row.provider).toBe("soft-hsm");
    expect(row.privateKeyEnc).toMatch(/^hsm:[0-9a-f]{32}$/);
    const stored = await prisma.hsmKey.findUniqueOrThrow({ where: { handle: row.privateKeyEnc.slice(4) } });
    expect(stored.materialEnc).toMatch(/^v1\./);
    expect(stored.publicKey).toBe(row.publicKey);

    // The guard loads the rulebook the HSM signed, and every receipt verifies.
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    const cp = await checkpoint(deps, d.org.id);
    expect(verifyCheckpoint(cp!, await orgPublicKeys(d.org.id))).toBe(true);
    expect(await verified(d.org.id)).toMatchObject({ ok: true });

    // Rotation generates the new key inside the HSM.
    const r = await rotateSigningKey(deps, d.org.id, d.owner.email);
    expect(r.rulebooksResigned).toBe(1);
    const next = await forOrg(d.org.id).orgKey.findFirstOrThrow({ where: { kid: r.kid } });
    expect((await prisma.hsmKey.findUniqueOrThrow({ where: { handle: next.privateKeyEnc.slice(4) } })).label).toBe("org signing key (rotation)");
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    expect(await verified(d.org.id)).toMatchObject({ ok: true });
    expect((await orgKey(deps, d.org.id)).kid).toBe(r.kid);
  });

  it("never hands out a private key", async () => {
    const deps = using(hsm);
    const d = await orgWith(deps, "Sealed Co");
    await expect(activeKey(deps, d.org.id)).rejects.toThrow(KeyNotExtractableError);
    await expect(hsm.unwrap()).rejects.toThrow(/cannot be exported/);
    // Bundles sign their manifest in-process, so they refuse before anything is recorded.
    const seq = (await receipts(d.org.id)).at(-1)!.seq;
    await expect(exportBundle(deps, d.org.id, { from: "2026-01-01", to: "2026-01-02" }, d.owner.email)).rejects.toThrow(KeyNotExtractableError);
    expect((await receipts(d.org.id)).at(-1)!.seq).toBe(seq);
  });

  it("a handle only signs for the org and key it was made for", async () => {
    const g = await hsm.generate("org_x");
    const sig = await hsm.sign({ orgId: "org_x", kid: g.kid, ref: g.ref }, "sha256:abc");
    expect(sig).toMatch(/^ed25519:/);
    expect(await hsm.publicKey({ orgId: "org_x", kid: g.kid, ref: g.ref })).toBe(g.publicKeyPem);
    // Cached and uncached paths both refuse another org or kid.
    await expect(hsm.sign({ orgId: "org_y", kid: g.kid, ref: g.ref }, "x")).rejects.toThrow("belongs to another key");
    const cold = new SoftHsmKeyProvider(env.GATE_MASTER_KEY, prisma);
    await expect(cold.sign({ orgId: "org_y", kid: g.kid, ref: g.ref }, "x")).rejects.toThrow("belongs to another key");
    await expect(cold.sign({ orgId: "org_x", kid: g.kid, ref: "v1.not-a-handle" }, "x")).rejects.toThrow("not a software HSM key handle");
    await expect(cold.sign({ orgId: "org_x", kid: g.kid, ref: "hsm:missing" }, "x")).rejects.toThrow("no such key");
    await expect(cold.publicKey({ orgId: "org_x", kid: g.kid, ref: "hsm:missing" })).rejects.toThrow("no such key");
    // A different master key cannot open the store.
    const other = new SoftHsmKeyProvider("ab".repeat(16) + "cd".repeat(16), prisma);
    await expect(other.sign({ orgId: "org_x", kid: g.kid, ref: g.ref }, "x")).rejects.toThrow("belongs to another key");
    // Imports must match their kid.
    await expect(hsm.wrap(generateKeyPair().privateKeyPem, { orgId: "org_x", kid: "0000000000000000" })).rejects.toThrow("does not match its key id");
  });

  it("a signature that does not verify with the stored public key never reaches the chain", async () => {
    const deps = using(hsm);
    const d = await orgWith(deps, "Swapped Co");
    const seq = (await receipts(d.org.id)).at(-1)!.seq;
    // Point the row at a different public key: the HSM's signatures no longer match it.
    await forOrg(d.org.id).orgKey.updateMany({ data: { publicKey: generateKeyPair().publicKeyPem } });
    await expect(checkpoint(deps, d.org.id)).rejects.toThrow(/does not verify/);
    expect((await receipts(d.org.id)).at(-1)!.seq).toBe(seq);
  });
});

const custodians = ["Asha Rao", "Vikram Shah", "Meera Iyer", "Rahul Nair", "Leela Das"].map((name, i) => ({ name, role: i === 0 ? "CISO" : "Key holder" }));

describe("key ceremony", () => {
  it("3 of 5: a new key in the HSM, its backup split among custodians, shares returned once and never stored", async () => {
    const deps = using(hsm);
    const d = await orgWith(deps, "Ceremony Co");
    const c = await startKeyCeremony(deps, d.org.id, { n: 5, k: 3, custodians, actor: d.owner.email });
    expect(c.shares).toHaveLength(5);
    expect(c.shares.map((s) => s.custodian.name)).toEqual(custodians.map((x) => x.name));

    const all = await receipts(d.org.id);
    const done = all.find((r) => r.seq === c.seq)!;
    expect(done).toMatchObject({ action: "key.ceremony_completed", actor: d.owner.email, details: { ceremony: c.ceremonyId, kid: c.kid, provider: "soft-hsm", quorum: "3 of 5", custodians } });
    expect(all.find((r) => r.seq === c.boundSeq)).toMatchObject({ action: "key.bound", details: { kid: c.kid, purpose: "ceremony", signing: "off", overlap_days: SUCCESSOR_OVERLAP_DAYS } });

    // No share appears anywhere in the database: receipts, the ceremony row, the successor, the HSM store.
    const row = await forOrg(d.org.id).keyCeremony.findFirstOrThrow({ where: { id: c.ceremonyId } });
    const succ = await forOrg(d.org.id).keySuccessor.findFirstOrThrow();
    const hsmRow = await prisma.hsmKey.findUniqueOrThrow({ where: { handle: succ.privateKeyEnc.slice(4) } });
    const everything = JSON.stringify([all, row, succ, hsmRow]);
    for (const { share } of c.shares) {
      expect(everything).not.toContain(share);
      expect(everything).not.toContain(Buffer.from(shamir.parseShare(share).data).toString("hex"));
    }
    expect(row).toMatchObject({ kid: c.kid, threshold: 3, shareCount: 5, shareSet: shamir.parseShare(c.shares[0]!.share).set });
    expect(succ).toMatchObject({ kid: c.kid, purpose: "ceremony", ceremonyId: c.ceremonyId, provider: "soft-hsm", activatedAt: null });
    expect(hsmRow.label).toBe("org signing key (ceremony)");
    // Signing is still with the old key until the successor is activated.
    expect((await orgKey(deps, d.org.id)).kid).not.toBe(c.kid);
    expect(await verified(d.org.id)).toMatchObject({ ok: true });

    // Any 3 shares recover the backup; 2, a tampered one, or another ceremony's do not. Each check is a receipt.
    const s = c.shares.map((x) => x.share);
    expect(await quorumCheck(deps, d.org.id, c.ceremonyId, [s[4]!, s[0]!, s[2]!], d.owner.email)).toMatchObject({ ok: true });
    const two = await quorumCheck(deps, d.org.id, c.ceremonyId, [s[0]!, s[1]!], d.owner.email);
    expect(two).toMatchObject({ ok: false, reason: "3 shares are needed; 2 given" });
    const tampered = s[1]!.replace(/-([0-9a-f])/, (_m, ch: string) => `-${ch === "0" ? "1" : "0"}`);
    expect((await quorumCheck(deps, d.org.id, c.ceremonyId, [s[0]!, tampered, s[2]!], d.owner.email)).reason).toMatch(/checksum mismatch|not a key share/);
    const foreign = shamir.split(new Uint8Array(32).fill(7), 5, 3);
    expect(await quorumCheck(deps, d.org.id, c.ceremonyId, foreign.slice(0, 3), d.owner.email)).toMatchObject({ ok: false, reason: "the shares do not open this ceremony's backup" });
    const checks = (await receipts(d.org.id)).filter((r) => r.action === "key.quorum_checked");
    expect(checks.map((r) => r.details!.ok)).toEqual([true, false, false, false]);
    expect(JSON.stringify(checks)).not.toContain(s[0]!);
    await expect(quorumCheck(deps, d.org.id, "kc_missing", s, d.owner.email)).rejects.toThrow("No such key ceremony");

    // The ceremony's key is the successor: a second person activates it after the overlap.
    await expect(startKeyCeremony(deps, d.org.id, { custodians, actor: d.owner.email })).rejects.toThrow(/already bound/);
    await forOrg(d.org.id).keySuccessor.updateMany({ data: { switchAt: new Date(Date.now() - 1000) } });
    const a = await activateSuccessor(deps, d.org.id, "second@test.in");
    expect(a).toMatchObject({ switched: true, kid: c.kid });
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    expect(await verified(d.org.id)).toMatchObject({ ok: true });
    expect((await receipts(d.org.id)).at(-1)).toMatchObject({ kid: c.kid });
  });

  it("works with a provider that cannot generate keys, and validates the custodians", async () => {
    const deps = using(envKeys);
    const d = await orgWith(deps, "Env Ceremony Co");
    const c = await startKeyCeremony(deps, d.org.id, { custodians, actor: d.owner.email });
    expect((await forOrg(d.org.id).keySuccessor.findFirstOrThrow()).provider).toBe("env");
    expect(await quorumCheck(deps, d.org.id, c.ceremonyId, c.shares.slice(2).map((x) => x.share), d.owner.email)).toMatchObject({ ok: true });

    const e = await orgWith(deps, "Bad Ceremony Co");
    const run = (o: Partial<Parameters<typeof startKeyCeremony>[2]>) => startKeyCeremony(deps, e.org.id, { custodians, actor: e.owner.email, ...o });
    await expect(run({ custodians: custodians.slice(0, 4) })).rejects.toThrow("needs exactly 5 custodians; 4 given");
    await expect(run({ custodians: [...custodians.slice(0, 4), { name: " asha rao ", role: "" }] })).rejects.toThrow("different person");
    await expect(run({ custodians: [...custodians.slice(0, 4), { name: "  ", role: "x" }] })).rejects.toThrow("needs a name");
    await expect(run({ k: 1 })).rejects.toThrow("2 <= k <= n <= 255");
    await expect(run({ n: 2, k: 3 })).rejects.toThrow("2 <= k <= n <= 255");
    const twoOfThree = await run({ n: 3, k: 2, custodians: custodians.slice(0, 3).map((x) => ({ name: x.name, role: "" })) });
    expect(twoOfThree.shares.map((s) => s.custodian.role)).toEqual(["Key holder", "Key holder", "Key holder"]);
    expect((await receipts(e.org.id)).find((r) => r.seq === twoOfThree.seq)!.details).toMatchObject({ quorum: "2 of 3" });
  });

  it("a backup that does not hold the ceremony's key fails the quorum check", async () => {
    const deps = using(envKeys);
    const d = await orgWith(deps, "Mixed Backup Co");
    const c = await startKeyCeremony(deps, d.org.id, { custodians, actor: d.owner.email });
    // Re-point the ceremony at a different key id: the backup opens only under its own AAD.
    await forOrg(d.org.id).keyCeremony.updateMany({ data: { kid: keyFingerprint(generateKeyPair().publicKeyPem) } });
    expect((await quorumCheck(deps, d.org.id, c.ceremonyId, c.shares.slice(0, 3).map((x) => x.share), d.owner.email)).reason).toBe("the shares do not open this ceremony's backup");
  });
});

describe("successor keys", () => {
  it("plan, then a different person confirms; it signs only after the 30-day overlap", async () => {
    const deps = using(envKeys);
    const d = await orgWith(deps, "Successor Co");
    const old = await orgKey(deps, d.org.id);
    const p = await planSuccessor(deps, d.org.id, d.owner.email);
    const overlap = new Date(p.switchAt).getTime() - Date.now();
    expect(overlap).toBeGreaterThan((SUCCESSOR_OVERLAP_DAYS - 1) * 86_400_000);
    expect(overlap).toBeLessThanOrEqual(SUCCESSOR_OVERLAP_DAYS * 86_400_000);
    expect((await receipts(d.org.id)).at(-1)).toMatchObject({ action: "key.bound", actor: d.owner.email, details: { kid: p.kid, purpose: "planned", switch_at: p.switchAt } });

    await expect(planSuccessor(deps, d.org.id, d.owner.email)).rejects.toThrow(/already bound/);
    await expect(rotateSigningKey(deps, d.org.id, d.owner.email)).rejects.toThrow(/successor key is bound/);
    // Dual control: the proposer cannot confirm (whatever the case of the address).
    await expect(activateSuccessor(deps, d.org.id, d.owner.email.toUpperCase())).rejects.toThrow(/different owner or admin/);
    expect(await settleSuccessor(deps, d.org.id)).toBeNull(); // not confirmed

    const first = await activateSuccessor(deps, d.org.id, "approver@test.in");
    expect(first).toMatchObject({ switched: false, kid: p.kid, switchAt: p.switchAt });
    expect((await receipts(d.org.id)).find((r) => r.seq === first.confirmedSeq)).toMatchObject({ action: "key.bound_confirmed", actor: "approver@test.in", details: { kid: p.kid, bound_by: d.owner.email, control: "dual" } });
    expect((await orgKey(deps, d.org.id)).kid).toBe(old.kid);
    expect(await settleSuccessor(deps, d.org.id)).toBeNull(); // overlap not over

    // The overlap ends; a later call (by anyone but the proposer) switches without confirming again.
    await forOrg(d.org.id).keySuccessor.updateMany({ data: { switchAt: new Date(Date.now() - 1000) } });
    const done = await activateSuccessor(deps, d.org.id, "third@test.in");
    expect(done).toMatchObject({ switched: true, previousKid: old.kid, rulebooksResigned: 1 });
    expect(done.confirmedSeq).toBeUndefined();
    const rotated = (await receipts(d.org.id)).find((r) => r.seq === done.seq)!;
    expect(rotated).toMatchObject({ action: "key.rotated", kid: old.kid, actor: "third@test.in", details: { old_kid: old.kid, new_kid: p.kid, successor: true, confirmed_by: "approver@test.in", bound_by: d.owner.email } });
    const keys = await orgPublicKeys(d.org.id);
    expect(keys.find((k) => k.kid === old.kid)!.retiredAt).toBe(rotated.ts);
    expect((await orgKey(deps, d.org.id)).kid).toBe(p.kid);
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    expect(await verified(d.org.id)).toMatchObject({ ok: true });
    await expect(activateSuccessor(deps, d.org.id, "third@test.in")).rejects.toThrow("No successor key is waiting");
  });

  it("settleSuccessor switches a confirmed successor once its overlap is over", async () => {
    const deps = using(hsm);
    const d = await orgWith(deps, "Settle Co");
    const p = await planSuccessor(deps, d.org.id, d.owner.email);
    await activateSuccessor(deps, d.org.id, "approver@test.in");
    await forOrg(d.org.id).keySuccessor.updateMany({ data: { switchAt: new Date(Date.now() - 1000) } });
    const seq = await settleSuccessor(deps, d.org.id);
    expect((await receipts(d.org.id)).find((r) => r.seq === seq)).toMatchObject({ action: "key.rotated", actor: "Elan1 Govern", details: { new_kid: p.kid } });
    expect((await orgKey(deps, d.org.id)).kid).toBe(p.kid);
    expect(gateMeta(await tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" })).decision).toBe("allow");
    expect(await verified(d.org.id)).toMatchObject({ ok: true });
    expect(await settleSuccessor(deps, d.org.id)).toBeNull();
  });

  it("successor rows are tenant-scoped", async () => {
    const deps = using(envKeys);
    const a = await orgWith(deps, "Scope A");
    const b = await orgWith(deps, "Scope B");
    await planSuccessor(deps, a.org.id, a.owner.email);
    expect(await forOrg(b.org.id).keySuccessor.count()).toBe(0);
    await expect(activateSuccessor(deps, b.org.id, "x@test.in")).rejects.toThrow("No successor key is waiting");
    // An HSM handle from org A does not sign for org B.
    const g = await hsm.generate(a.org.id);
    await expect(hsm.sign({ orgId: b.org.id, kid: g.kid, ref: g.ref }, "x")).rejects.toThrow("belongs to another key");
  });
});
