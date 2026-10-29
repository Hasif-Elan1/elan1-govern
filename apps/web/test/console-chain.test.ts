import { fromConsoleReceipt, verifyChain, type Receipt } from "@gate/core";
import { consoleState, orgPublicKeys, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConsoleOrg, startGate } from "./console-gate";

// The console's receipts on the organisation's real chain: the built domain, the bridge, Postgres and a real gate
// service. These tests use org_northbank and org_deccan (console.test.ts uses the other two).
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

const gateService = await startGate();
const consoleDomain = await import("../src/server/console-domain");
const consoleChain = await import("../src/server/console-chain");
const { gate } = await import("../src/server/gate");
const domain = await import("@gate/console/server");

const ORG = "org_northbank";
const OWNER = "u_rohan";
const OWNER_EMAIL = "rohan.kapoor@northbank.co.in";

type DocReceipt = Receipt & { approval?: { id: string; status: string; approver?: string }; environment?: string };
type DocCheckpoint = { id: string; org: string; seq: number; hash: string; ts: string; kid: string; sig: string };
type Doc = { receipts: DocReceipt[]; checkpoints: DocCheckpoint[]; publicKeys: Record<string, string>; signingKeys: { kid: string; status: string }[]; org: { keyFingerprint: string } };

const realChain = async (orgId = ORG) => (await prisma.receipt.findMany({ where: { orgId }, orderBy: { seq: "asc" } })).map((r) => r.body as Receipt);
const docOf = async (orgId = ORG) => (await consoleDomain.stateFor(orgId)).doc as unknown as Doc;
const browserVerify = (d: Pick<Doc, "receipts" | "publicKeys" | "checkpoints">) => domain.chainVerifier.verifyChain(d.receipts as never, d.publicKeys, d.checkpoints as never);
/** An event the gate writes on its own (as the web app's settings pages do): the chain moves without the console. */
const gateEvent = async (orgId = ORG, field = "retention") => {
  const r = await gate<{ seq: number }>("POST", `/internal/orgs/${orgId}/events`, { actor: OWNER_EMAIL, action: "settings.updated", details: { field } });
  expect(r.status).toBe(200);
  return r.data.seq;
};

beforeAll(async () => {
  await consoleDomain.forgetConsoleMemory();
  for (const org of [ORG, "org_deccan"]) await resetConsoleOrg(org);
});
afterAll(async () => {
  await gateService.close();
  await prisma.$disconnect();
});

describe("an operation's receipts", () => {
  it("are written to the organisation's real chain, signed with its key, and are the document's receipts", async () => {
    const r = await consoleDomain.runOp(ORG, OWNER, "api.setFramework", [ORG, "hipaa", true, OWNER]);
    expect(r.result).toMatchObject({ id: "hipaa", enabled: true });
    const doc = await docOf();
    const last = doc.receipts.findLast((x) => x.action === "framework.enabled")!;
    expect(last).toMatchObject({ actor: OWNER, kind: "admin" });
    expect(last.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(last.sig).toMatch(/^ed25519:/);

    // the Receipt table holds the same receipt, and the whole chain verifies with the organisation's own keys
    const chain = await realChain();
    const row = chain.find((x) => x.seq === last.seq)!;
    expect(row).toEqual(fromConsoleReceipt(last));
    expect(verifyChain(chain, await orgPublicKeys(ORG))).toMatchObject({ ok: true, count: chain.length, lastSeq: chain.at(-1)!.seq });
    // the document is the chain, receipt for receipt, from the organisation's creation on
    expect(doc.receipts.map((x) => fromConsoleReceipt(x))).toEqual(chain);
    expect(doc.receipts[0]).toMatchObject({ seq: 1, action: "org.created" });

    // the keys are the gate's: no signing seed anywhere, every public key with its id
    const stored = JSON.parse((await consoleState.load(ORG))!.json) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("keySeeds");
    expect(stored).not.toHaveProperty("keys");
    const keys = await orgPublicKeys(ORG);
    expect(Object.keys(doc.publicKeys)).toEqual(keys.map((k) => k.kid));
    expect(doc.signingKeys.map((k) => [k.kid, k.status])).toEqual(keys.map((k) => [k.kid, k.retiredAt ? "retired" : "active"]));
    expect(doc.org.keyFingerprint).toBe(keys.at(-1)!.kid);
  });

  it("come back to the caller as the real receipts and checkpoints", async () => {
    const r = await consoleDomain.runOp(ORG, OWNER, "api.signCheckpoint", [ORG, OWNER]);
    const cp = r.result as DocCheckpoint;
    const head = (await realChain()).at(-1)!;
    expect(cp).toMatchObject({ org: ORG, seq: head.seq, hash: head.hash });
    expect(cp.sig).toMatch(/^ed25519:/);
    const row = await prisma.checkpoint.findFirst({ where: { orgId: ORG, seq: head.seq } });
    expect(row?.sig).toBe(cp.sig);
    const doc = await docOf();
    expect(doc.checkpoints.at(-1)).toEqual(cp);
    expect(doc.checkpoints.every((c) => c.sig.startsWith("ed25519:"))).toBe(true);
    // the console's own integrity run checks the real chain and records that it did
    const run = await consoleDomain.runOp(ORG, OWNER, "api.runIntegrity", [ORG, OWNER]);
    expect(run.result).toMatchObject({ result: "pass" });
    expect((await realChain()).at(-1)).toMatchObject({ action: "evidence.integrity_run", actor: OWNER });
  });

  it("are refused when they would claim what only the gate writes, and nothing is kept", async () => {
    const before = await realChain();
    const version = await consoleState.version(ORG);
    const api = domain.api as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const real = api.setFramework!;
    api.setFramework = async (...a: unknown[]) => {
      await real.apply(domain.api, a);
      domain.db.logAdmin(ORG, OWNER, "key.rotated", { old_kid: "a", new_kid: "b" });
    };
    try {
      await expect(consoleDomain.runOp(ORG, OWNER, "api.setFramework", [ORG, "colorado", true, OWNER])).rejects.toMatchObject({ status: 409, message: "Only Elan1 Govern writes key.rotated receipts." });
    } finally {
      api.setFramework = real;
    }
    expect(await realChain()).toEqual(before);
    expect(await consoleState.version(ORG)).toBe(version);
    expect((await docOf()).receipts.some((x) => x.action === "framework.enabled" && x.details?.framework === "Colorado AI Act")).toBe(false);
  });
});

describe("receipts the gate writes itself", () => {
  it("appear in the document on the next state read and the next operation", async () => {
    const seq = await gateEvent();
    const doc = await docOf();
    expect(doc.receipts.at(-1)).toMatchObject({ seq, action: "settings.updated", actor: OWNER_EMAIL });
    expect(browserVerify(doc).result).toBe("verified");

    const next = await gateEvent(ORG, "routing");
    await consoleDomain.runOp(ORG, OWNER, "api.setFramework", [ORG, "nyc144", true, OWNER]);
    const after = await docOf();
    const i = after.receipts.findIndex((x) => x.seq === next);
    expect(after.receipts[i]).toMatchObject({ action: "settings.updated", details: { field: "routing" } });
    expect(after.receipts[i + 1]).toMatchObject({ seq: next + 1, action: "framework.enabled", prev_hash: after.receipts[i]!.hash });
    expect(after.receipts.map((x) => fromConsoleReceipt(x))).toEqual(await realChain());
  });
});

describe("the console's own verifier", () => {
  it("accepts the organisation's real chain and its checkpoints, and finds a change anywhere in it", { timeout: 30_000 }, async () => {
    const doc = await docOf();
    const ok = browserVerify(doc);
    expect(ok).toMatchObject({ result: "verified", receipts: doc.receipts.length, checkpoints: { total: doc.checkpoints.length, valid: doc.checkpoints.length } });
    expect(ok.keyFingerprint).toBe(doc.receipts[0]!.kid);

    // each change is checked on the receipts around it (the verifier is the browser's, and not fast)
    const around = (d: Doc, seq: number) => ({
      receipts: d.receipts.filter((r) => Math.abs(r.seq - seq) <= 4),
      publicKeys: d.publicKeys,
      checkpoints: d.checkpoints.filter((c) => Math.abs(c.seq - seq) <= 4),
    });
    const tamper = (f: (d: Doc) => number) => {
      const d = structuredClone(doc);
      const seq = f(d);
      return { report: browserVerify(around(d, seq)), seq };
    };
    const pick = (d: Doc, p: (r: DocReceipt) => boolean) => d.receipts.find(p)!;
    // a detail of an imported decision, an approval's console-only status, a gate receipt's actor, a signature
    for (const f of [
      (d: Doc) => { const r = pick(d, (x) => x.kind === "decision"); r.tool = "bank.initiate_transfer"; return r.seq; },
      (d: Doc) => { const r = pick(d, (x) => x.kind === "approval" && !!x.approval); r.approval!.status = r.approval!.status === "approved" ? "rejected" : "approved"; return r.seq; },
      (d: Doc) => { const r = pick(d, (x) => x.action === "settings.updated"); r.actor = "someone@else.in"; return r.seq; },
      (d: Doc) => { const r = d.receipts[5]!; r.sig = d.receipts[6]!.sig; return r.seq; },
    ]) {
      const { report, seq } = tamper(f);
      expect(report.result).toBe("failed");
      expect(report.brokenAt).toBe(seq);
    }
    // a receipt taken out, and a checkpoint that names another head
    expect(tamper((d) => d.receipts.splice(10, 1)[0]!.seq).report).toMatchObject({ result: "failed", brokenAt: doc.receipts[11]!.seq });
    const cp = doc.checkpoints.at(-1)!;
    const moved = tamper((d) => { d.checkpoints.at(-1)!.hash = d.receipts.find((r) => r.seq === cp.seq - 1)!.hash; return cp.seq; }).report;
    expect(moved.result).toBe("failed");
    expect(moved.checkpoints.valid).toBe(moved.checkpoints.total - 1);
    // another organisation's key does not verify this one's chain
    const deccan = await docOf("org_deccan");
    const wrongKeys = Object.fromEntries(Object.keys(doc.publicKeys).map((k) => [k, Object.values(deccan.publicKeys)[0]!]));
    expect(browserVerify({ ...around(doc, 10), publicKeys: wrongKeys }).result).toBe("failed");
  });
});

describe("the chain moving under an operation", () => {
  it("never forks: the operation runs again on the new head", async () => {
    const api = domain.api as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const real = api.setFramework!;
    let moves = 1;
    let calls = 0;
    api.setFramework = async (...a: unknown[]) => {
      calls++;
      // the guard records an agent's call while the console works on the organisation
      if (moves-- > 0) await gateEvent(ORG, "while-the-console-works");
      return real.apply(domain.api, a);
    };
    try {
      const r = await consoleDomain.runOp(ORG, OWNER, "api.setFramework", [ORG, "colorado", true, OWNER]);
      expect(r.result).toMatchObject({ id: "colorado", enabled: true });
    } finally {
      api.setFramework = real;
    }
    expect(calls).toBe(2);
    const chain = await realChain();
    expect(verifyChain(chain, await orgPublicKeys(ORG)).ok).toBe(true);
    expect(chain.slice(-2).map((x) => x.action)).toEqual(["settings.updated", "framework.enabled"]);
    expect(chain.filter((x) => x.details?.framework === "Colorado AI Act")).toHaveLength(1);
    expect((await docOf()).receipts.map((x) => fromConsoleReceipt(x))).toEqual(chain);
  });

  it("fails cleanly when the chain keeps moving, and the next try succeeds", async () => {
    const api = domain.api as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const real = api.setFramework!;
    api.setFramework = async (...a: unknown[]) => {
      await gateEvent(ORG, "busy");
      return real.apply(domain.api, a);
    };
    const version = await consoleState.version(ORG);
    try {
      await expect(consoleDomain.runOp(ORG, OWNER, "api.setFramework", [ORG, "colorado", false, OWNER])).rejects.toMatchObject({ status: 409 });
    } finally {
      api.setFramework = real;
    }
    expect(await consoleState.version(ORG)).toBe(version);
    const chain = await realChain();
    expect(verifyChain(chain, await orgPublicKeys(ORG)).ok).toBe(true);
    expect(chain.some((x) => x.action === "framework.disabled")).toBe(false);
    // the document still holds every receipt the gate wrote meanwhile, and the operation can be run again
    await consoleDomain.runOp(ORG, OWNER, "api.setFramework", [ORG, "colorado", false, OWNER]);
    const doc = await docOf();
    expect(doc.receipts.map((x) => fromConsoleReceipt(x))).toEqual(await realChain());
    expect(doc.receipts.at(-1)).toMatchObject({ action: "framework.disabled" });
  });
});

describe("a document saved before receipts came from the chain", () => {
  it("is rebuilt on the real chain, with its demo history imported", async () => {
    const legacy = { org: { id: "org_deccan", name: "Deccan Cooperative Bank Ltd" }, members: [], receipts: [{ seq: 501, hash: "ab" }], keySeeds: [{ seed: "org_deccan:key:1", kid: "k", from: 0 }], builtAt: 1, platform: {} };
    // as a database from before: the chain holds the seed's setup receipts only, the document is the old kind
    await consoleDomain.forgetConsoleMemory();
    await resetConsoleOrg("org_deccan");
    await consoleState.save("org_deccan", JSON.stringify(legacy), 0);
    const s = await consoleDomain.stateFor("org_deccan");
    expect(s.version).toBe(2);
    const doc = s.doc as unknown as Doc;
    expect(doc).not.toHaveProperty("keySeeds");
    const chain = await realChain("org_deccan");
    expect(doc.receipts.map((x) => fromConsoleReceipt(x))).toEqual(chain);
    expect(chain.filter((x) => x.action === "console.history_imported")).toHaveLength(1);
    expect(verifyChain(chain, await orgPublicKeys("org_deccan")).ok).toBe(true);
    expect(browserVerify(doc).result).toBe("verified");
  });
});

describe("provisional values", () => {
  it("are replaced wherever an operation copied them, in documents and in results", () => {
    const strings = new Map([["pending:5:n", "sha256:real"], ["pending:sig:5:n", "ed25519:sig"]]);
    const doc = { a: ["pending:5:n", 1, { b: "pending:sig:5:n", c: [{ d: "pending:5:n" }] }], e: "keep" };
    consoleChain.replaceStrings(doc, strings);
    expect(doc).toEqual({ a: ["sha256:real", 1, { b: "ed25519:sig", c: [{ d: "sha256:real" }] }], e: "keep" });
    consoleChain.replaceStrings(doc, new Map());
    const real = { seq: 5, hash: "sha256:real", sig: "ed25519:sig" } as never;
    const fixes = { strings, objects: new Map([["pending:5:n", real]]) };
    expect(consoleChain.fixResult({ r: { seq: 5, hash: "pending:5:n", ts: "x" }, list: ["pending:sig:5:n", 2, null] }, fixes)).toEqual({ r: real, list: ["ed25519:sig", 2, null] });
    expect(consoleChain.fixResult("x", { strings: new Map(), objects: new Map() })).toBe("x");
  });
});
