import { fromConsoleReceipt, verifyChain, type Receipt } from "@gate/core";
import { consoleState, orgPublicKeys, prisma } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConsoleOrg, startGate } from "./console-gate";

// The console's domain runs for real (the built bundle, Postgres, the routes' CSRF and validation, and the gate
// service that writes its receipts to the real chain); only the session lookup is a stand-in. The people are the
// console's demo members of org_demo, seeded into Membership with the demo organisations.
const state = vi.hoisted(() => ({ userId: "u_rahul" }));

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("../src/server/session", () => ({
  CSRF_COOKIE: "gate_csrf",
  isFresh: () => true,
  currentSession: async () => ({ userId: state.userId, csrfToken: "csrf-1", lastAuthAt: new Date() }),
  currentCtx: async () => "no-org",
}));

const gateService = await startGate();
const rpcRoute = await import("../src/app/api/console/rpc/route");
const stateRoute = await import("../src/app/api/console/state/route");
const streamRoute = await import("../src/app/api/console/stream/route");
const consoleDomain = await import("../src/server/console-domain");
const events = await import("../src/server/console-events");
const { resetRateLimits } = await import("../src/server/ratelimit");
const domain = await import("@gate/console/server");

const ORG = "org_demo";
const ADMIN = "u_rahul";
const VIEWER = "u_meera";
const OWNER = "u_ananya";

type Doc = { frameworks: { id: string; enabled: boolean }[]; receipts: { seq: number; actor?: string; action?: string; details?: Record<string, unknown> }[] };
const memory = () => domain.db.peekDB(ORG) as unknown as Doc | undefined;
const framework = (d: Doc | undefined, id: string) => d?.frameworks.find((f) => f.id === id)?.enabled;

function rpc(body: unknown) {
  const req = new NextRequest("http://localhost:3000/api/console/rpc", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-csrf-token": "csrf-1" }, body: JSON.stringify(body) });
  return rpcRoute.POST(req, { params: Promise.resolve({}) });
}
const get = (path: string, signal?: AbortSignal) => new NextRequest(`http://localhost:3000${path}`, signal ? { signal } : {});

// the organisations these tests open (org_kaveri: the membership refusal reads its member list); the console's
// other tests use the other two
async function clean() {
  await consoleDomain.forgetConsoleMemory();
  for (const org of [ORG, "org_kaveri"]) await resetConsoleOrg(org);
}

beforeAll(clean);
afterAll(async () => {
  await gateService.close();
  await prisma.$disconnect();
});
beforeEach(() => {
  resetRateLimits();
  state.userId = ADMIN;
});

describe("POST /api/console/rpc", () => {
  it("acts as the signed-in user, whoever the arguments name", async () => {
    // a viewer naming the owner as the actor is still a viewer
    state.userId = VIEWER;
    const refused = await rpc({ op: "api.setFramework", args: [ORG, "hipaa", true, OWNER] });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/Viewers cannot do this/);
    // nothing was saved and memory is back where it was (unbuilt, if membership came from the Membership table)
    const before = await consoleState.load(ORG);
    expect(before ? framework(JSON.parse(before.json) as Doc, "hipaa") : false).toBe(false);
    expect(framework(memory(), "hipaa") ?? false).toBe(false);

    // an admin naming the viewer: the receipt says the admin did it
    state.userId = ADMIN;
    const res = await rpc({ op: "api.setFramework", args: [ORG, "hipaa", true, VIEWER] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { id: string; enabled: boolean }; version: number };
    expect(body.result).toMatchObject({ id: "hipaa", enabled: true });
    // (open-time seeds may write after it when this call built the document, so look it up by action)
    const last = memory()!.receipts.findLast((r) => r.action === "framework.enabled")!;
    expect(last).toMatchObject({ actor: ADMIN, action: "framework.enabled" });
    // and it is saved, at the version the reply names
    const saved = await consoleState.load(ORG);
    expect(saved?.version).toBe(body.version);
    expect(framework(JSON.parse(saved!.json) as Doc, "hipaa")).toBe(true);
  });

  it("refuses an organisation the user is not a member of", async () => {
    for (const org of ["org_kaveri", "org_nobody", ""]) {
      const res = await rpc({ op: "api.setFramework", args: [org, "hipaa", true, ADMIN] });
      expect(res.status).toBe(403);
    }
    expect((await rpc({ op: "api.agents", args: [42] })).status).toBe(403);
    expect((await stateRoute.GET(get("/api/console/state?org=org_kaveri"), { params: Promise.resolve({}) })).status).toBe(403);
    expect((await streamRoute.GET(get("/api/console/stream?org=org_kaveri"), { params: Promise.resolve({}) })).status).toBe(403);
  });

  it("refuses operations that are not in the manifest, and those without an organisation", async () => {
    for (const op of ["api.nope", "constructor", "api.__proto__", "db.getDB", "api.ops"]) expect((await rpc({ op, args: [ORG] })).status).toBe(404);
    // mock sign-in and the password re-check take no organisation: refused until allowed one by one
    expect((await rpc({ op: "api.signIn", args: ["ananya.rao@demotraders.in", "Demo-Owner-2026"] })).status).toBe(403);
    expect((await rpc({ op: "work.reauth", args: [ADMIN, "x"] })).status).toBe(403);
    // nor those that return other people's secrets (the snapshot has them removed)
    for (const op of ["orgApi.orgState", "work.linksFor"]) expect((await rpc({ op, args: [ORG] })).status).toBe(403);
    expect((await rpc({ op: "api.agents" })).status).toBe(400);
  });

  it("returns the document without signing seeds or other people's secrets", async () => {
    const res = await stateRoute.GET(get(`/api/console/state?org=${ORG}`), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { version, doc } = (await res.json()) as { version: number; doc: Record<string, unknown> & { org: { id: string } } };
    expect(version).toBe(await consoleState.version(ORG));
    expect(doc.org.id).toBe(ORG);
    expect(doc).not.toHaveProperty("keySeeds");
    expect(doc).not.toHaveProperty("keys");
    // receipts come from the real chain, so the stored document holds no signing seeds either; the seeded invite:
    // its token is stored, and left out of what the browser gets
    type Invites = { orgSettings: { invites: { email: string; token?: string }[] } };
    const stored = JSON.parse((await consoleState.load(ORG))!.json) as Invites & { keySeeds?: unknown[] };
    expect(stored).not.toHaveProperty("keySeeds");
    expect(stored).not.toHaveProperty("keys");
    expect(stored.orgSettings.invites[0]?.token).toBeTruthy();
    expect((doc as unknown as Invites).orgSettings.invites[0]).toMatchObject({ email: stored.orgSettings.invites[0]!.email });
    expect((doc as unknown as Invites).orgSettings.invites[0]).not.toHaveProperty("token");
  });
});

describe("runOp", () => {
  it("rolls back what an operation changed before it failed", async () => {
    const before = await consoleState.load(ORG);
    const receipts = memory()!.receipts.length;
    const api = domain.api as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const real = api.setFramework!;
    api.setFramework = async (...a: unknown[]) => {
      await real.apply(domain.api, a); // enables the framework and writes its receipt
      throw new Error("Stopped halfway.");
    };
    try {
      await expect(consoleDomain.runOp(ORG, ADMIN, "api.setFramework", [ORG, "colorado", true, ADMIN])).rejects.toMatchObject({ status: 400, message: "Stopped halfway." });
    } finally {
      api.setFramework = real;
    }
    expect(framework(memory(), "colorado")).toBe(false);
    expect(memory()!.receipts.length).toBe(receipts);
    expect(await consoleState.load(ORG)).toEqual(before);
  });

  it("runs two operations on one organisation one after the other, and saves both", async () => {
    await clean();
    const [a, b] = await Promise.all([
      consoleDomain.runOp(ORG, ADMIN, "api.setFramework", [ORG, "colorado", true, ADMIN]),
      consoleDomain.runOp(ORG, ADMIN, "api.setFramework", [ORG, "nyc144", true, ADMIN]),
    ]);
    // the first builds the organisation from the seed and saves version 1; the second saves version 2
    expect([a.version, b.version].sort()).toEqual([1, 2]);
    const saved = JSON.parse((await consoleState.load(ORG))!.json) as Doc;
    expect(framework(saved, "colorado")).toBe(true);
    expect(framework(saved, "nyc144")).toBe(true);
    const enabled = saved.receipts.filter((r) => r.action === "framework.enabled").map((r) => r.details?.framework);
    expect(enabled.slice(-2).sort()).toEqual(["Colorado AI Act", "NYC LL 144"].sort());
    // one chain: no seq used twice
    const seqs = saved.receipts.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("starts from the saved document in a fresh process, and picks up another process's save", async () => {
    const saved = (await consoleState.load(ORG))!;
    // a fresh process: nothing in memory
    await consoleDomain.forgetConsoleMemory();
    expect(memory()).toBeUndefined();
    const s = await consoleDomain.stateFor(ORG);
    expect(s.version).toBe(saved.version);
    expect(framework(s.doc as unknown as Doc, "colorado")).toBe(true);
    const r = await consoleDomain.runOp(ORG, ADMIN, "api.setFramework", [ORG, "colorado", false, ADMIN]);
    expect(r.version).toBe(saved.version + 1);
    expect(framework(memory(), "colorado")).toBe(false);

    // another process saves a newer version: the next operation here starts from it
    const theirs = JSON.parse((await consoleState.load(ORG))!.json) as Doc & { org: { name: string } };
    theirs.org.name = "Demo Traders (renamed elsewhere)";
    await consoleState.save(ORG, JSON.stringify(theirs), r.version!);
    const level = await consoleDomain.runOp(ORG, ADMIN, "api.org", [ORG]);
    expect(level.result).toMatchObject({ name: "Demo Traders (renamed elsewhere)" });
    expect(level.version).toBe(r.version! + 1);
  });
});

describe("the real chain", () => {
  type ChainDoc = {
    receipts: (Receipt & { approval?: { id: string; status: string } })[];
    approvals: { id: string; seq: number; resultSeq?: number; agentSlug: string; status: string }[];
    alerts: { id: string; agentSlug: string; relatedSeqs: number[] }[];
    publicKeys: Record<string, string>;
  };

  it("holds org_demo's demo history as real receipts, with every reference to them intact", async () => {
    await consoleDomain.runOp(ORG, ADMIN, "api.setFramework", [ORG, "colorado", true, ADMIN]);
    const doc = (await consoleDomain.stateFor(ORG)).doc as unknown as ChainDoc;
    const rows = await prisma.receipt.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } });
    const chain = rows.map((r) => r.body as Receipt);
    // the whole chain verifies with the organisation's real keys, and the document is that chain, receipt for receipt
    expect(verifyChain(chain, await orgPublicKeys(ORG))).toMatchObject({ ok: true, count: chain.length });
    expect(doc.receipts.map((r) => fromConsoleReceipt(r))).toEqual(chain);
    expect(Object.keys(doc.publicKeys)).toEqual((await orgPublicKeys(ORG)).map((k) => k.kid));

    // imported once, after the organisation's setup receipts, and said so
    const marker = chain.find((r) => r.action === "console.history_imported")!;
    const { from_seq: from, to_seq: to } = marker.details as { from_seq: number; to_seq: number };
    expect(chain.slice(0, from - 1).every((r) => r.kind === "admin")).toBe(true);
    expect(marker.seq).toBe(to + 1);
    const imported = chain.filter((r) => r.seq >= from && r.seq <= to);
    expect(imported.length).toBeGreaterThan(500);
    // the demo's key rotations never happened to the real key: recorded under their own name
    expect(imported.some((r) => r.action === "key.rotated")).toBe(false);
    expect(imported.some((r) => r.action === "key.rotated.demo")).toBe(true);
    expect(new Set(chain.map((r) => r.kid)).size).toBe(1);

    // approvals point at their decision and result receipts; alerts at their agent's receipts
    const bySeq = new Map(doc.receipts.map((r) => [r.seq, r]));
    expect(doc.approvals.length).toBeGreaterThan(10);
    for (const a of doc.approvals) {
      expect(bySeq.get(a.seq)).toMatchObject({ kind: "decision", decision: "ask", agent: a.agentSlug, approval: { id: a.id } });
      if (a.resultSeq) expect(bySeq.get(a.resultSeq)).toMatchObject({ kind: "approval", ref_seq: a.seq, approval: { id: a.id } });
    }
    for (const al of doc.alerts) for (const seq of al.relatedSeqs) expect(bySeq.get(seq)?.agent).toBe(al.agentSlug);
  });

  it("holds no signing key: what would sign with the organisation's key here is refused, and nothing is written", async () => {
    const head = await prisma.receipt.findFirst({ where: { orgId: ORG }, orderBy: { seq: "desc" } });
    const res = await rpc({ op: "api.rotateKey", args: [ORG, ADMIN] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(domain.db.NO_KEY);
    expect(await prisma.receipt.findFirst({ where: { orgId: ORG }, orderBy: { seq: "desc" } })).toEqual(head);
  });
});

describe("change announcements", () => {
  it("announces a saved change to the organisation's streams after the commit", async () => {
    await events.listening();
    const heard: { kind: string; version: number }[] = [];
    const stop = events.subscribe(ORG, (e) => heard.push(e));
    try {
      const r = await consoleDomain.runOp(ORG, ADMIN, "api.setFramework", [ORG, "colorado", true, ADMIN]);
      await vi.waitFor(() => expect(heard.map((e) => e.version)).toContain(r.version));
      expect(heard.find((e) => e.version === r.version)?.kind).toBe("receipt");
    } finally {
      stop();
    }
  });

  it("streams them as Server-Sent Events and stops when the browser goes away", async () => {
    const abort = new AbortController();
    const res = await streamRoute.GET(get(`/api/console/stream?org=${ORG}`, abort.signal), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(`"kind":"hello"`);
    await events.listening();
    const r = await consoleDomain.runOp(ORG, ADMIN, "api.setFramework", [ORG, "colorado", false, ADMIN]);
    const next = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(next.replace(/^data: /, ""))).toMatchObject({ orgId: ORG, version: r.version });
    abort.abort();
    expect((await reader.read()).done).toBe(true);
  });
});
