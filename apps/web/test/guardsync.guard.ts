import { signRequest } from "@gate/core";
import { consoleState, forOrg, prisma } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The approved console driving the real guard, end to end: console operations through POST /api/console/rpc (the
// real route, CSRF and validation; only the session lookup is a stand-in) change the console's documents, and the
// web app applies them to an in-process gate (the real Fastify app, its routes and tables). An agent then calls
// the gate over MCP with the key the console issued. The organisations are the console's demo ones, seeded into
// the real tables as `pnpm db:seed` does.

/** The parts of the gate's Fastify app used here (the gate is imported by file, outside this app's type program). */
interface GateApp {
  inject(req: { method: string; url: string; headers: Record<string, string>; payload?: string }): Promise<{ statusCode: number; json(): unknown }>;
  ready(): Promise<unknown>;
  close(): Promise<unknown>;
}
interface GateDeps {
  background: Set<Promise<unknown>>;
}
const state = vi.hoisted(() => ({ userId: "u_rahul", app: undefined as unknown as GateApp, fail: undefined as "throw" | number | undefined, calls: 0 }));

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("../src/server/session", () => ({
  CSRF_COOKIE: "gate_csrf",
  isFresh: () => true,
  currentSession: async () => ({ userId: state.userId, csrfToken: "csrf-1", lastAuthAt: new Date() }),
  currentCtx: async () => "no-org",
}));
// the signed call to the gate service, made to the in-process gate
vi.mock("../src/server/gate", () => ({
  gate: async (method: "GET" | "POST", path: string, body?: unknown) => {
    state.calls++;
    if (state.fail === "throw") throw new TypeError("fetch failed");
    if (typeof state.fail === "number") return { status: state.fail, data: { error: "gate trouble" } };
    const payload = body === undefined ? "" : JSON.stringify(body);
    const res = await state.app.inject({ method, url: path, headers: { "content-type": "application/json", "x-gate-signature": signRequest(process.env.INTERNAL_API_SECRET!, method, path, payload) }, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, data: res.json() };
  },
}));

const gateFile = (path: string) => new URL(`../../gate/src/${path}`, import.meta.url).href;
const { buildApp } = (await import(/* @vite-ignore */ gateFile("app.ts"))) as { buildApp(env: unknown, overrides: object): Promise<{ app: GateApp; deps: GateDeps }> };
const { readGateEnv } = (await import(/* @vite-ignore */ gateFile("env.ts"))) as { readGateEnv(): unknown };
const { seedConsoleDemo } = (await import(/* @vite-ignore */ gateFile("seed.ts"))) as { seedConsoleDemo(deps: GateDeps, opts: { password: string; webEncKey: string }): Promise<unknown> };
const rpcRoute = await import("../src/app/api/console/rpc/route");
const stateRoute = await import("../src/app/api/console/state/route");
const consoleDomain = await import("../src/server/console-domain");
const { forgetGuardSync } = await import("../src/server/console-sync");
const { resetRateLimits } = await import("../src/server/ratelimit");
const domain = await import("@gate/console/server");

const ORG = "org_demo";
const CONSOLE_ORGS = domain.db.orgIds();
let deps: GateDeps;

async function rpc(op: string, args: unknown[], as = state.userId) {
  state.userId = as;
  const req = new NextRequest("http://localhost:3000/api/console/rpc", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-csrf-token": "csrf-1" }, body: JSON.stringify({ op, args }) });
  const res = await rpcRoute.POST(req, { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as { result?: Record<string, unknown>; error?: string } };
}
async function doc(orgId = ORG, as = state.userId) {
  state.userId = as;
  const res = await stateRoute.GET(new NextRequest(`http://localhost:3000/api/console/state?org=${orgId}`), { params: Promise.resolve({}) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { doc: ConsoleDoc }).doc;
}
type ConsoleDoc = {
  agents: { id: string; slug: string; status: string; keys: { id: string; prefix: string }[] }[];
  approvals: { id: string; status: string; source?: string; headline: string; approverGroup: string; args: Record<string, unknown>; riskTags: string[]; effect: string; expiresAt: string; resultSeq?: number }[];
  rulebooks: { id: string; slug: string; currentVersion: number; versions: { version: number; status: string; yaml: string; rules: Record<string, unknown>[] }[] }[];
};

let rpcId = 1;
async function mcp(key: string, method: string, params: unknown = {}) {
  const res = await state.app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  return { status: res.statusCode, body: res.json() as { result?: { content: { text: string }[]; structuredContent?: { gate: Record<string, unknown> }; tools?: { name: string }[] } } };
}
const call = async (key: string, name: string, args: Record<string, unknown> = {}) => (await mcp(key, "tools/call", { name, arguments: args })).body.result?.structuredContent?.gate ?? {};
const settle = async () => {
  for (let i = 0; i < 10 && deps.background.size; i++) await Promise.all([...deps.background]);
};

/** Forget every console document and everything the console made in the gate's tables for the demo organisations. */
async function clean() {
  await consoleDomain.forgetConsoleMemory();
  forgetGuardSync();
  await prisma.$executeRaw`DELETE FROM "ConsoleState" WHERE "orgId" = ANY(${CONSOLE_ORGS}::text[])`;
  for (const orgId of CONSOLE_ORGS) {
    const db = forOrg(orgId);
    const agents = (await db.agent.findMany({ where: { consoleId: { not: null } }, select: { id: true } })).map((a) => a.id);
    await db.approval.deleteMany({ where: { agentId: { in: agents } } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.upstreamServer.deleteMany({ where: { consoleId: { not: null } } });
    await db.consoleApproverGroup.deleteMany({});
    await db.incident.deleteMany({ where: { startedBy: { not: "" } } });
  }
}

beforeAll(async () => {
  ({ app: state.app, deps } = await buildApp(readGateEnv(), { mailer: { send: async () => undefined } }));
  await state.app.ready();
  await seedConsoleDemo(deps, { password: "guardsync test password", webEncKey: process.env.WEB_ENC_KEY! });
  await clean();
});
afterAll(async () => {
  await settle();
  await clean();
  await state.app.close();
  await prisma.$disconnect();
});
beforeEach(() => {
  resetRateLimits();
  state.userId = "u_rahul";
});

let secret = "";
let approvalId = "";

describe("the console drives the guard", () => {
  it("opening an organisation makes its agents, tools, groups and published rulebooks real", async () => {
    await doc();
    const db = forOrg(ORG);
    const agents = await db.agent.findMany({ where: { consoleId: { not: null } }, orderBy: { slug: "asc" } });
    expect(agents.map((a) => a.slug)).toEqual(["collections-agent", "devops-assistant", "expense-auditor", "hr-screening", "invoice-bot", "treasury-sweeper", "vendor-onboarding"]);
    // paused in the console (an auto-pause, an owner's pause): paused in the guard
    expect(agents.filter((a) => a.status === "paused").map((a) => a.slug)).toEqual(["hr-screening", "treasury-sweeper"]);
    const invoice = agents.find((a) => a.slug === "invoice-bot")!;
    const rb = await db.rulebook.findFirstOrThrow({ where: { id: invoice.activeRulebookId! } });
    expect(rb).toMatchObject({ version: 7, consoleId: "rb_invoice" });
    // the guard's own rules refuse a high-risk agent that merges to main with no ask rule: no rulebook, so nothing runs
    expect(agents.find((a) => a.slug === "devops-assistant")!.activeRulebookId).toBeNull();
    expect((await db.consoleApproverGroup.findFirstOrThrow({ where: { slug: "finance" } })).emails).toEqual(["venkat.iyer@demotraders.in", "tom.whitfield@demotraders.eu"]);
  });

  it("issuing a sandbox key in the console makes a real key, shown once and kept nowhere", async () => {
    const res = await rpc("agents.issueKey", [ORG, "invoice-bot", { label: "Guard test sandbox", environment: "sandbox" }, "u_rahul"]);
    expect(res.status).toBe(200);
    secret = String(res.body.result!.secret);
    expect(secret).toMatch(/^sk_sbx_[0-9a-f]{36}$/);
    const key = await forOrg(ORG).apiKey.findFirstOrThrow({ where: { prefix: secret.slice(0, 12) } });
    expect(key).toMatchObject({ environment: "sandbox", revokedAt: null });
    expect(key.consoleId).toMatch(/^key_/);
    // neither the stored document nor what the browser reads holds the secret
    expect((await consoleState.load(ORG))!.json).not.toContain(secret);
    expect(JSON.stringify(await doc())).not.toContain(secret);
  });

  it("an MCP call with it is decided by the console's published rulebook", async () => {
    const tools = (await mcp(secret, "tools/list")).body.result!.tools!.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["gmail.read_inbox", "zoho_books.record_payment", "gate.approval_status"]));
    expect(tools).not.toContain("gmail.search");
    expect(await call(secret, "gmail.read_inbox", {})).toMatchObject({ decision: "allow", rule_id: "read-ledger" });
    expect(await call(secret, "zoho_books.record_payment", { amount: 18000, vendor: "northwind" })).toMatchObject({ decision: "allow", rule_id: "pay-small" });
    // a switched-off tool is refused; switched on in the console, the rulebook's own refusal decides
    expect(await call(secret, "zoho_books.delete_bill", { bill_id: "b1" })).toMatchObject({ decision: "refuse", rule_id: "default" });
    expect((await rpc("api.setToolEnabled", [ORG, "con_zoho", "zoho_books.delete_bill", true, "u_rahul"])).status).toBe(200);
    expect(await call(secret, "zoho_books.delete_bill", { bill_id: "b1" })).toMatchObject({ decision: "refuse", rule_id: "no-deletes" });
    const held = await call(secret, "zoho_books.record_payment", { amount: 240000, vendor: "Northwind Traders", bill: "NW-2291" });
    expect(held).toMatchObject({ decision: "ask", rule_id: "pay-large", status: "pending" });
    approvalId = String(held.approval_id);
    const receipt = await forOrg(ORG).receipt.findFirstOrThrow({ where: { seq: Number(held.receipt_seq) } });
    expect(receipt.body).toMatchObject({ rulebook: { version: 7 }, agent: "invoice-bot", decision: "ask" });
  });

  it("the held call shows up as a console approval, for the console's Finance group", async () => {
    await settle();
    const a = (await doc()).approvals.find((x) => x.id === approvalId)!;
    expect(a).toMatchObject({ source: "guard", status: "pending", agentSlug: "invoice-bot", tool: "zoho_books.record_payment", approverGroup: "Finance", ruleId: "pay-large", args: { amount: 240000, vendor: "Northwind Traders" }, riskTags: ["moves_money", "writes_data"] });
    expect(a.headline).toMatch(/^invoice-bot wants to call zoho_books\.record_payment/);
    // the console's own lists and screens read it
    const list = await rpc("api.approvals", [ORG]);
    expect((list.body.result as unknown as { id: string }[]).some((x) => x.id === approvalId)).toBe(true);
  });

  it("approving it in the console releases the agent; the guard ran it and wrote the receipts", async () => {
    // someone outside Finance is refused by the console itself
    expect((await rpc("work.decide", [ORG, approvalId, true, "u_arjun", "Looks fine"], "u_arjun")).status).toBe(400);
    const agent = await forOrg(ORG).agent.findFirstOrThrow({ where: { slug: "invoice-bot" } });
    const waiting = mcp(secret, "tools/call", { name: "gate.approval_status", arguments: { approval_id: approvalId, wait_seconds: 20 } });
    const res = await rpc("work.decide", [ORG, approvalId, true, "u_venkat", "Matches the PO."], "u_venkat");
    expect(res.status).toBe(200);
    const released = (await waiting).body.result!.structuredContent!.gate;
    expect(released).toMatchObject({ status: "approved", outcome: { status: "ok" } });
    const real = await forOrg(ORG).approval.findFirstOrThrow({ where: { id: approvalId } });
    expect(real).toMatchObject({ status: "approved", resolvedBy: "venkat.iyer@demotraders.in", agentId: agent.id, note: "Matches the PO." });
    await settle();
    const a = (await doc()).approvals.find((x) => x.id === approvalId)!;
    expect(a).toMatchObject({ status: "approved", decidedBy: "u_venkat" });
    const follow = await forOrg(ORG).receipt.findFirstOrThrow({ where: { seq: a.resultSeq! } });
    expect(follow.body).toMatchObject({ kind: "approval", approval: { id: approvalId, result: "approved" }, outcome: { status: "ok" } });
  });

  it("publishing a rulebook change in the console changes the guard's decision", async () => {
    const d = await doc();
    const rb = d.rulebooks.find((r) => r.id === "rb_invoice")!;
    const current = rb.versions.find((v) => v.version === rb.currentVersion)!;
    // payments over ₹50,000 are refused instead of asked (and approved vendors may be paid up to ₹50,000)
    const rules = current.rules.map((r) => (r.id === "pay-large" ? { ...r, decide: "ask", when: [{ field: "amount", op: "gt", value: 100000 }] } : r));
    rules.push({ id: "no-mid", match: { tag: "moves_money" }, when: [{ field: "amount", op: "gt", value: 50000 }, { field: "amount", op: "lte", value: 100000 }], decide: "refuse", reason: "Not between ₹50,000 and ₹1,00,000." });
    const pub = await rpc("api.publish", [ORG, "rb_invoice", `${current.yaml}\n# guard test\n`, rules, "Refuse mid-sized payments", "u_rahul"]);
    expect(pub.status).toBe(200);
    expect(await call(secret, "zoho_books.record_payment", { amount: 70000, vendor: "northwind" })).toMatchObject({ decision: "refuse", rule_id: "no-mid" });
    const signed = await forOrg(ORG).rulebook.findFirstOrThrow({ where: { consoleId: "rb_invoice", version: Number(pub.body.result!.version) } });
    expect(signed.version).toBeGreaterThan(7);
  });

  it("a version the guard cannot express is refused with a plain message, and nothing is published", async () => {
    const d = await doc();
    const rb = d.rulebooks.find((r) => r.id === "rb_invoice")!;
    const current = rb.versions.find((v) => v.version === rb.currentVersion)!;
    const rules = [...current.rules, { id: "vendor-fields", match: { tool: "zoho_books.create_bill" }, when: [{ field: "fields", op: "fields_include", value: ["bank_account"] }], decide: "refuse", reason: "No bank changes." }];
    const res = await rpc("api.publish", [ORG, "rb_invoice", `${current.yaml}\n# untranslatable\n`, rules, "Fields check", "u_rahul"]);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/^This version was not published: the guard cannot apply it\. Rule "vendor-fields": .*checks which arguments a call has/);
    // the console still has the version that was in force, and so does the guard
    expect((await doc()).rulebooks.find((r) => r.id === "rb_invoice")!.currentVersion).toBe(rb.currentVersion);
    expect(await call(secret, "zoho_books.record_payment", { amount: 70000, vendor: "northwind" })).toMatchObject({ decision: "refuse", rule_id: "no-mid" });
  });

  it("pausing the agent, and the emergency stop, refuse its next call", async () => {
    expect((await rpc("api.setAgentStatus", [ORG, "invoice-bot", "paused", "u_rahul"])).status).toBe(200);
    expect(await call(secret, "gmail.read_inbox", {})).toMatchObject({ decision: "refuse", rule_id: "agent-paused" });
    expect((await rpc("api.setAgentStatus", [ORG, "invoice-bot", "active", "u_rahul"])).status).toBe(200);
    expect(await call(secret, "gmail.read_inbox", {})).toMatchObject({ decision: "allow" });

    expect((await rpc("api.engageStop", [ORG, "u_ananya", "Guard test stop"], "u_ananya")).status).toBe(200);
    expect(await call(secret, "gmail.read_inbox", {})).toMatchObject({ decision: "refuse", rule_id: "agent-paused" });
    expect(await forOrg(ORG).incident.findFirst({ where: { status: "open", reason: "Guard test stop" } })).not.toBeNull();
    expect((await rpc("api.liftStop", [ORG, "u_ananya", "All clear"], "u_ananya")).status).toBe(200);
    expect(await call(secret, "gmail.read_inbox", {})).toMatchObject({ decision: "allow" });
  });

  it("revoking the key in the console stops it at once", async () => {
    const keyId = (await forOrg(ORG).apiKey.findFirstOrThrow({ where: { prefix: secret.slice(0, 12) } })).consoleId!;
    expect((await rpc("api.revokeKey", [ORG, "invoice-bot", keyId, "u_rahul"])).status).toBe(200);
    expect((await mcp(secret, "tools/list")).status).toBe(401);
  });
});

describe("organisations stay apart", () => {
  it("one organisation's people, keys and approvals never reach another's", async () => {
    // a new key and a held call in Demo Traders
    const key = String((await rpc("agents.issueKey", [ORG, "invoice-bot", { label: "Second key", environment: "sandbox" }, "u_rahul"])).body.result!.secret);
    const held = await call(key, "zoho_books.record_payment", { amount: 240000, vendor: "northwind" });
    expect(held).toMatchObject({ decision: "ask" });
    await settle();
    // Kaveri Health's owner is not a member of Demo Traders: the console refuses her
    expect((await rpc("work.decide", [ORG, held.approval_id, true, "u_lakshmi", "x"], "u_lakshmi")).status).toBe(403);
    // Kaveri's own document and tables know nothing of it
    const kaveri = await doc("org_kaveri", "u_lakshmi");
    expect(kaveri.approvals.some((a) => a.id === held.approval_id)).toBe(false);
    expect(await forOrg("org_kaveri").approval.findFirst({ where: { id: String(held.approval_id) } })).toBeNull();
    // a key issued in Kaveri acts for Kaveri's agent only, under Kaveri's rulebook
    const slug = kaveri.agents.find((a) => a.status === "active")!.slug;
    const issued = await rpc("agents.issueKey", ["org_kaveri", slug, { label: "Kaveri sandbox", environment: "sandbox" }, "u_lakshmi"], "u_lakshmi");
    expect(issued.status).toBe(200);
    const kaveriKey = String(issued.body.result!.secret);
    const real = await prisma.apiKey.findFirstOrThrow({ where: { prefix: kaveriKey.slice(0, 12) } });
    expect(real.orgId).toBe("org_kaveri");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: real.agentId } })).orgId).toBe("org_kaveri");
    // Demo Traders' key cannot ask about Kaveri's approvals, nor Kaveri's about Demo Traders'
    const status = await mcp(kaveriKey, "tools/call", { name: "gate.approval_status", arguments: { approval_id: held.approval_id, wait_seconds: 0 } });
    expect(status.body.result!.content[0]!.text).toMatch(/No approval with that id/);
  });
});

describe("when the guard does not take it", () => {
  const status = async (slug: string) => (await doc()).agents.find((a) => a.slug === slug)!.status;

  it("refuses what the operation asked for when the gate cannot be reached, and still opens documents", async () => {
    state.fail = "throw";
    try {
      const res = await rpc("api.setAgentStatus", [ORG, "collections-agent", "paused", "u_rahul"]);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/could not reach the guard to apply this, so nothing was changed/);
      expect(await status("collections-agent")).toBe("active");
      // opening an organisation for the first time is not something anyone asked the guard for: it still opens
      await prisma.$executeRaw`DELETE FROM "ConsoleState" WHERE "orgId" = 'org_deccan'`;
      await consoleDomain.forgetConsoleMemory();
      expect((await doc("org_deccan", "u_suresh")).agents.length).toBeGreaterThan(0);
    } finally {
      state.fail = undefined;
    }
  });

  it("refuses when the gate answers with an error, and applies nothing to an organisation the gate does not have", async () => {
    state.fail = 500;
    try {
      const res = await rpc("api.setAgentStatus", [ORG, "collections-agent", "paused", "u_rahul"]);
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/did not accept this change \(gate trouble\)/);
      state.fail = 404;
      expect((await rpc("api.setAgentStatus", [ORG, "collections-agent", "paused", "u_rahul"])).status).toBe(200);
      expect(await status("collections-agent")).toBe("paused");
    } finally {
      state.fail = undefined;
    }
    // the guard catches up on the next change
    expect((await rpc("api.setAgentStatus", [ORG, "collections-agent", "active", "u_rahul"])).status).toBe(200);
    expect((await forOrg(ORG).agent.findFirstOrThrow({ where: { slug: "collections-agent" } })).status).toBe("active");
  });

  it("sends nothing with CONSOLE_GUARD_SYNC=off", async () => {
    process.env.CONSOLE_GUARD_SYNC = "off";
    try {
      const before = state.calls;
      expect((await rpc("api.setAgentStatus", [ORG, "expense-auditor", "paused", "u_rahul"])).status).toBe(200);
      expect(state.calls).toBe(before);
      expect((await forOrg(ORG).agent.findFirstOrThrow({ where: { slug: "expense-auditor" } })).status).toBe("active");
    } finally {
      process.env.CONSOLE_GUARD_SYNC = "on";
    }
  });
});
