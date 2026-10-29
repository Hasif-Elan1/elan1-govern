import { randomBytes } from "node:crypto";
import { guardSyncPayload, hashToken, type ConsoleDocView, type ConsoleDomainFacts, type ConsoleRule, type GuardSyncChanges, type GuardSyncPayload, type Receipt } from "@gate/core";
import { addMembership, consoleState, forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg } from "../src/admin";
import { waitForApproval } from "../src/approvals";
import type { GuardSyncResult } from "../src/console-sync";
import { boundedExpiry } from "../src/console-approvals";
import { gateMeta, internal, makeApp, makeUser, mcp, tool } from "./helpers";

// The console's governance configuration applied to the guard (POST /internal/orgs/:org/console-sync), and the
// guard's approvals written back into the console document. The messages are built from a console document with
// the same code the web app uses (@gate/core guardSyncPayload).

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => {
  await ctx.app.close();
  await prisma.$disconnect();
});

const settle = async () => {
  for (let i = 0; i < 10 && ctx.deps.background.size; i++) await Promise.all([...ctx.deps.background]);
};
const NONE: GuardSyncChanges = { rulebooks: [], keys: [], agents: [], approvals: [], stop: false };
const VENDOR_DOMAINS = ["northwind.in", "kalyanimetals.com"];
const RULES: ConsoleRule[] = [
  { id: "read-ledger", match: { tag: "reads_data" }, decide: "allow", reason: "Reading invoices and the AP inbox is routine." },
  { id: "pay-small", match: { tag: "moves_money" }, when: [{ field: "amount", op: "lte", value: 50000 }, { field: "vendor", op: "in", value: ["approved_vendors"] }], decide: "allow", reason: "Small payments to approved vendors.", quota: { kind: "max_sum", field: "amount", limit: 300000, window: "day" } },
  { id: "pay-large", match: { tag: "moves_money" }, when: [{ field: "amount", op: "gt", value: 50000 }], decide: "ask", approver: "finance", reason: "Payments over ₹50,000 need the finance controller.", expiresIn: "24h" },
  { id: "email-vendors", match: { tool: "gmail.send_email" }, when: [{ field: "to", op: "to_domain_in", value: VENDOR_DOMAINS }], decide: "allow", reason: "Replies to known vendor domains are routine." },
  { id: "no-deletes", match: { tag: "deletes" }, decide: "refuse", reason: "Bills are cancelled by a person, never deleted by an agent." },
];

/** A console organisation: its people as real users and members, and a console document for it. */
async function consoleOrg() {
  const owner = await makeUser("owner");
  const venkat = await makeUser("venkat");
  const tom = await makeUser("tom");
  const viewer = await makeUser("viewer");
  const org = await createOrg(ctx.deps, { name: "Console Traders", ownerUserId: owner.id, ownerEmail: owner.email });
  await addMembership({ orgId: org.id, userId: venkat.id, role: "approver" });
  await addMembership({ orgId: org.id, userId: tom.id, role: "approver" });
  await addMembership({ orgId: org.id, userId: viewer.id, role: "viewer" });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const doc: ConsoleDocView & { receipts: unknown[] } = {
    agents: [
      { id: "ag_invoice", slug: "invoice-bot", name: "Invoice bot", description: "Pays supplier invoices.", ownerId: owner.id, riskLevel: "high", status: "active", tools: ["gmail.read_inbox", "gmail.send_email", "zoho_books.record_payment", "zoho_books.delete_bill"], keys: [] },
      { id: "ag_hr", slug: "hr-screening", name: "HR screening", description: "Reads CVs.", ownerId: owner.id, riskLevel: "high", status: "active", tools: ["hr.read_application"], keys: [] },
    ],
    rulebooks: [
      { id: "rb_invoice", agentId: "ag_invoice", versions: [{ version: 7, status: "published", hash: "h7", signedAt: at, signedBy: owner.id, rules: RULES }] },
      // HR's in-force rules check which fields a call has, which the guard cannot say
      { id: "rb_hr", agentId: "ag_hr", versions: [{ version: 1, status: "published", hash: "hr1", signedAt: at, rules: [{ id: "read-cv", match: { tool: "hr.read_application" }, when: [{ field: "cv", op: "fields_include", value: ["cv"] }], decide: "allow", reason: "" }] }] },
    ],
    connectors: [
      { id: "con_gmail", name: "Gmail — ap@demotraders.in", mode: "demo", tools: [{ name: "gmail.read_inbox", enabled: true }, { name: "gmail.send_email", enabled: true }] },
      { id: "con_zoho", name: "Zoho Books — India data centre", mode: "demo", tools: [{ name: "zoho_books.record_payment", enabled: true }, { name: "zoho_books.delete_bill", enabled: false }] },
      { id: "con_hr", name: "Recruiting MCP", mode: "live", url: "https://hr-mcp.example.in/mcp", tools: [{ name: "hr.read_application", enabled: true }] },
    ],
    stop: { active: false },
    approvals: [],
    receipts: [],
  };
  const facts: ConsoleDomainFacts = {
    groups: [
      { id: "finance", name: "Finance", members: [venkat.id, tom.id, viewer.id] },
      { id: "owners", name: "Owners", members: [owner.id] },
    ],
    tools: [
      { name: "gmail.read_inbox", tags: ["reads_data", "personal_data"], connector: "con_gmail" },
      { name: "gmail.send_email", tags: ["sends_external"], connector: "con_gmail" },
      { name: "zoho_books.record_payment", tags: ["moves_money", "writes_data"], connector: "con_zoho" },
      { name: "zoho_books.delete_bill", tags: ["deletes"], connector: "con_zoho" },
      { name: "hr.read_application", tags: ["reads_data", "personal_data"], connector: "con_hr" },
    ],
    lists: { approved_vendors: ["northwind", "kalyanimetals"] },
    allowedApprovers: () => [venkat.id, tom.id],
  };
  return { org, orgId: org.id, owner, venkat, tom, viewer, doc, facts, db: forOrg(org.id) };
}
type Org = Awaited<ReturnType<typeof consoleOrg>>;

const payload = (o: Org, changes: GuardSyncChanges = NONE, extra: Partial<GuardSyncPayload> = {}): GuardSyncPayload => ({ ...guardSyncPayload(o.doc, o.facts), actor: o.owner.id, changes, ...extra });

async function sync(orgId: string, body: GuardSyncPayload) {
  const res = await internal(ctx.app, "POST", `/internal/orgs/${orgId}/console-sync`, body);
  return { status: res.statusCode, body: res.json() as GuardSyncResult & { error?: string } };
}

/** Issue a sandbox key in the console document and the payload that carries its hash. */
function issueKey(o: Org, agent = 0) {
  const secret = `sk_sbx_${randomBytes(18).toString("hex")}`;
  const key = { id: `key_${randomBytes(4).toString("hex")}`, prefix: secret.slice(0, 12), label: "Sandbox", environment: "sandbox", createdAt: new Date().toISOString() };
  o.doc.agents[agent]!.keys!.unshift(key);
  const p = payload(o, { ...NONE, keys: [key.id] });
  p.keys.find((k) => k.id === key.id)!.keyHash = hashToken(secret);
  return { secret, key, payload: p };
}

const receipts = async (orgId: string) => (await forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);

describe("console-sync: the configuration", () => {
  it("makes the console's agents, tools, groups and published rulebook real, once", async () => {
    const o = await consoleOrg();
    const first = await sync(o.orgId, payload(o));
    expect(first.status).toBe(200);
    expect(first.body.rulebooks.rb_invoice).toMatchObject({ ok: true, version: 7 });
    // the HR rulebook cannot be said by the guard: its agent has none, so every call is refused
    expect(first.body.rulebooks.rb_hr).toMatchObject({ ok: false, errors: [expect.stringMatching(/checks which arguments a call has/)] });

    const agents = await o.db.agent.findMany({ orderBy: { slug: "asc" } });
    expect(agents.map((a) => [a.slug, a.consoleId, a.riskTier, a.status, a.ownerEmail])).toEqual([
      ["hr-screening", "ag_hr", "high", "active", o.owner.email],
      ["invoice-bot", "ag_invoice", "high", "active", o.owner.email],
    ]);
    const invoice = agents.find((a) => a.slug === "invoice-bot")!;
    const rb = await o.db.rulebook.findFirstOrThrow({ where: { id: invoice.activeRulebookId! } });
    expect(rb).toMatchObject({ version: 7, consoleId: "rb_invoice", consoleHash: "h7", signedBy: o.owner.email });
    // approvers in the signed rulebook: the group's members who can decide (not the viewer)
    expect(rb.yaml).toContain(`finance: [ ${o.venkat.email}, ${o.tom.email} ]`);
    expect(agents.find((a) => a.slug === "hr-screening")!.activeRulebookId).toBeNull();

    const servers = await o.db.upstreamServer.findMany({ include: { tools: { orderBy: { name: "asc" } } }, orderBy: { slug: "asc" } });
    expect(servers.map((s) => [s.slug, s.name, s.url, s.consoleId])).toEqual([
      ["gmail", "Gmail — ap@demotraders.in", "console://con_gmail", "con_gmail/gmail"],
      ["hr", "Recruiting MCP", "https://hr-mcp.example.in/mcp", "con_hr/hr"],
      ["zoho_books", "Zoho Books — India data centre", "console://con_zoho", "con_zoho/zoho_books"],
    ]);
    expect(servers[2]!.tools.map((t) => [t.name, t.tags, t.enabled])).toEqual([
      ["zoho_books.delete_bill", ["deletes"], false],
      ["zoho_books.record_payment", ["moves_money", "writes_data"], true],
    ]);
    // the fields the rules look at are the tool's arguments
    expect(servers[0]!.tools.find((t) => t.name === "gmail.send_email")!.inputSchema).toEqual({ type: "object", properties: { to: {} } });

    const groups = await o.db.consoleApproverGroup.findMany({ orderBy: { slug: "asc" } });
    expect(groups.map((g) => [g.slug, g.name, g.emails])).toEqual([
      ["finance", "Finance", [o.venkat.email, o.tom.email]],
      ["owners", "Owners", [o.owner.email]],
    ]);
    const rs = await receipts(o.orgId);
    expect(rs.filter((r) => r.action === "rulebook.signed").map((r) => r.rulebook)).toEqual([{ version: 7, hash: rb.hash }]);
    expect(rs.filter((r) => r.action === "agent.created")).toHaveLength(2);

    // the same message again changes nothing and writes nothing
    const count = rs.length;
    expect((await sync(o.orgId, payload(o))).body.rulebooks.rb_invoice).toMatchObject({ ok: true, version: 7, hash: rb.hash });
    expect(await o.db.receipt.count()).toBe(count);
  });

  it("refuses unsigned or malformed messages and unknown organisations", async () => {
    const o = await consoleOrg();
    expect((await ctx.app.inject({ method: "POST", url: `/internal/orgs/${o.orgId}/console-sync`, payload: payload(o) })).statusCode).toBe(401);
    expect((await sync("org_nobody", payload(o))).status).toBe(404);
    const bad = await sync(o.orgId, { ...payload(o), agents: [{ ...payload(o).agents[0]!, slug: "Not A Slug" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/agents\.0\.slug/);
    expect((await sync(o.orgId, { ...payload(o), keys: [{ ...payload(o).agents[0]!, keyHash: "x" } as never] })).status).toBe(400);
  });

  it("leaves an MCP server or agent made outside the console alone", async () => {
    const o = await consoleOrg();
    await o.db.upstreamServer.create({ data: { orgId: o.orgId, slug: "hr", name: "Someone else's", url: "https://other.example/mcp" } });
    await o.db.agent.create({ data: { orgId: o.orgId, slug: "hr-screening", name: "Old HR", purpose: "Old", ownerEmail: o.owner.email } });
    const r = await sync(o.orgId, payload(o));
    expect(r.body.problems).toEqual(expect.arrayContaining([expect.stringMatching(/"hr" was connected outside the console/), expect.stringMatching(/"hr-screening" was added outside the console/)]));
    expect(await o.db.upstreamServer.findFirstOrThrow({ where: { slug: "hr" } })).toMatchObject({ name: "Someone else's", consoleId: null });
    expect(await o.db.agent.findFirstOrThrow({ where: { slug: "hr-screening" } })).toMatchObject({ name: "Old HR", consoleId: null });
  });

  it("follows the console's tools: tags, switches, removals", async () => {
    const o = await consoleOrg();
    await sync(o.orgId, payload(o));
    o.facts.tools = o.facts.tools.filter((t) => t.connector !== "con_hr").map((t) => (t.name === "zoho_books.delete_bill" ? { ...t, tags: ["deletes", "writes_data"] } : t));
    o.doc.connectors = o.doc.connectors.filter((c) => c.id !== "con_hr");
    o.doc.connectors[1]!.tools[1]!.enabled = true;
    await sync(o.orgId, payload(o));
    expect(await o.db.upstreamTool.findFirstOrThrow({ where: { name: "zoho_books.delete_bill" } })).toMatchObject({ tags: ["deletes", "writes_data"], enabled: true });
    expect(await o.db.upstreamServer.findFirst({ where: { slug: "hr" } })).toBeNull();
    expect((await receipts(o.orgId)).filter((r) => r.action === "upstream.removed").map((r) => r.details)).toEqual([{ server: "hr", via: "console" }]);
  });
});

describe("console-sync: keys and calls through the guard", () => {
  it("a key issued in the console works, and the console's published rulebook decides each call", async () => {
    const o = await consoleOrg();
    const k = issueKey(o);
    const r = await sync(o.orgId, k.payload);
    expect(r.body.keys.created).toEqual([k.key.id]);
    const row = await o.db.apiKey.findFirstOrThrow({ where: { consoleId: k.key.id } });
    expect(row).toMatchObject({ prefix: k.key.prefix, environment: "sandbox", keyHash: hashToken(k.secret), revokedAt: null });
    expect(JSON.stringify(row)).not.toContain(k.secret);

    // the agent sees the console's tools that are switched on, and the guard decides each call by the console's rules
    const listed = (await mcp(ctx.app, k.secret, "tools/list")).body.result!.tools!.map((t) => t.name);
    expect(listed).toEqual(expect.arrayContaining(["gmail.read_inbox", "zoho_books.record_payment"]));
    expect(listed).not.toContain("zoho_books.delete_bill");

    const read = await tool(ctx.app, k.secret, "gmail.read_inbox", {});
    expect(gateMeta(read)).toMatchObject({ decision: "allow", rule_id: "read-ledger", ref: expect.stringMatching(/^gmail-demo-/) });
    expect(JSON.parse(read.content[0]!.text)).toMatchObject({ demo: true });
    expect(gateMeta(await tool(ctx.app, k.secret, "zoho_books.record_payment", { amount: 18000, vendor: "Northwind" }))).toMatchObject({ decision: "allow", rule_id: "pay-small" });
    expect(gateMeta(await tool(ctx.app, k.secret, "zoho_books.record_payment", { amount: 18000, vendor: "Shady Co" }))).toMatchObject({ decision: "refuse", rule_id: "default" });
    const held = await tool(ctx.app, k.secret, "zoho_books.record_payment", { amount: 240000, vendor: "Northwind" });
    expect(gateMeta(held)).toMatchObject({ decision: "ask", rule_id: "pay-large", status: "pending" });
    // a switched-off tool is refused, whatever the rules say
    expect(gateMeta(await tool(ctx.app, k.secret, "zoho_books.delete_bill", {}))).toMatchObject({ decision: "refuse", rule_id: "default" });
    expect(gateMeta(await tool(ctx.app, k.secret, "gmail.send_email", { to: "ap@northwind.in" }))).toMatchObject({ decision: "allow", rule_id: "email-vendors" });
    await settle();
    const rs = await receipts(o.orgId);
    expect(rs.filter((x) => x.kind === "decision").every((x) => x.rulebook?.version === 7 && x.agent === "invoice-bot")).toBe(true);
    // the HR agent has no rulebook the guard could sign
    const hr = issueKey(o, 1);
    await sync(o.orgId, hr.payload);
    expect(gateMeta(await tool(ctx.app, hr.secret, "hr.read_application", {}))).toMatchObject({ decision: "refuse", rule_id: "no-rulebook" });
  });

  it("a key with no secret here (the seed's) is not made up; revoked, expired and removed keys stop working", async () => {
    const o = await consoleOrg();
    o.doc.agents[0]!.keys!.push({ id: "key_seed", prefix: "gk_7Kq2", label: "Seed", environment: "production" });
    const k = issueKey(o);
    const r = await sync(o.orgId, k.payload);
    expect(r.body.keys.unbacked).toEqual(["key_seed"]);
    expect(await o.db.apiKey.count({ where: { consoleId: "key_seed" } })).toBe(0);
    expect((await mcp(ctx.app, k.secret, "tools/list")).status).toBe(200);

    // a rotation's grace: the key works until then
    const soon = new Date(Date.now() + 60_000).toISOString();
    Object.assign(o.doc.agents[0]!.keys!.find((x) => x.id === k.key.id)!, { revokeAt: soon });
    await sync(o.orgId, payload(o));
    expect((await o.db.apiKey.findFirstOrThrow({ where: { consoleId: k.key.id } })).expiresAt?.toISOString()).toBe(soon);
    await o.db.apiKey.updateMany({ where: { consoleId: k.key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await mcp(ctx.app, k.secret, "tools/list")).status).toBe(401);

    const k2 = issueKey(o);
    await sync(o.orgId, k2.payload);
    expect((await mcp(ctx.app, k2.secret, "tools/list")).status).toBe(200);
    Object.assign(o.doc.agents[0]!.keys!.find((x) => x.id === k2.key.id)!, { revoked: true });
    await sync(o.orgId, payload(o, { ...NONE, keys: [k2.key.id] }));
    expect((await mcp(ctx.app, k2.secret, "tools/list")).status).toBe(401);
    // the console never brings a revoked key back
    Object.assign(o.doc.agents[0]!.keys!.find((x) => x.id === k2.key.id)!, { revoked: false });
    await sync(o.orgId, payload(o));
    expect((await mcp(ctx.app, k2.secret, "tools/list")).status).toBe(401);

    const k3 = issueKey(o);
    await sync(o.orgId, k3.payload);
    o.doc.agents[0]!.keys = o.doc.agents[0]!.keys!.filter((x) => x.id !== k3.key.id);
    await sync(o.orgId, payload(o));
    expect((await mcp(ctx.app, k3.secret, "tools/list")).status).toBe(401);
  });

  it("publishing a new version changes the real decision; one the guard cannot sign is refused and the guard keeps its rules", async () => {
    const o = await consoleOrg();
    const k = issueKey(o);
    await sync(o.orgId, k.payload);
    const pay = () => tool(ctx.app, k.secret, "zoho_books.record_payment", { amount: 60000, vendor: "Northwind" });
    expect(gateMeta(await pay())).toMatchObject({ decision: "ask", rule_id: "pay-large" });

    // version 8 lets an agent pay approved vendors up to ₹2,50,000 on its own
    const versions = o.doc.rulebooks[0]!.versions;
    const v8 = RULES.map((r) => (r.id === "pay-small" ? { ...r, when: [{ field: "amount", op: "lte" as const, value: 250000 }, r.when![1]!] } : r.id === "pay-large" ? { ...r, when: [{ field: "amount", op: "gt" as const, value: 250000 }] } : r));
    const signed = (n: number) => new Date(Date.now() - 60_000 + n * 1000).toISOString();
    versions.push({ version: 8, status: "published", hash: "h8", signedAt: signed(1), rules: v8 });
    const r8 = await sync(o.orgId, payload(o, { ...NONE, rulebooks: ["rb_invoice"] }));
    expect(r8.body.rulebooks.rb_invoice).toMatchObject({ ok: true, version: 8 });
    expect(gateMeta(await pay())).toMatchObject({ decision: "allow", rule_id: "pay-small" });

    // version 9 checks which fields a call has: refused, and version 8 stays in force
    versions.push({ version: 9, status: "published", hash: "h9", signedAt: signed(2), rules: [{ id: "x", match: { tool: "gmail.send_email" }, when: [{ field: "to", op: "fields_include", value: ["to"] }], decide: "allow", reason: "" }] });
    const r9 = await sync(o.orgId, payload(o, { ...NONE, rulebooks: ["rb_invoice"] }));
    expect(r9.body.rulebooks.rb_invoice).toMatchObject({ ok: false });
    expect(gateMeta(await pay())).toMatchObject({ decision: "allow", rule_id: "pay-small" });
    // the real engine's own rules refuse too: a high-risk agent's payments need an ask rule
    versions.splice(2, 1, { version: 9, status: "published", hash: "h9b", signedAt: signed(3), rules: [{ id: "pay-all", match: { tag: "moves_money" }, decide: "allow", reason: "" }] });
    expect((await sync(o.orgId, payload(o, { ...NONE, rulebooks: ["rb_invoice"] }))).body.rulebooks.rb_invoice).toEqual({ ok: false, errors: ["High-risk agents need at least one \"Ask\" rule for record payment (zoho_books.record_payment), because it moves money."] });

    // not something this operation asked for (a later save found it): the agent has no rulebook until it is fixed
    await sync(o.orgId, payload(o));
    expect(gateMeta(await pay())).toMatchObject({ decision: "refuse", rule_id: "no-rulebook" });

    // withdrawn back to version 8: signed before, so in force again
    versions.splice(2, 1);
    Object.assign(versions[1]!, { signedAt: signed(4) });
    expect((await sync(o.orgId, payload(o, { ...NONE, rulebooks: ["rb_invoice"] }))).body.rulebooks.rb_invoice).toMatchObject({ ok: true, version: 8 });
    expect(gateMeta(await pay())).toMatchObject({ decision: "allow", rule_id: "pay-small" });
    // every version withdrawn: nothing is allowed
    for (const v of versions) v.withdrawn = { at: new Date(Date.now() - 1).toISOString() };
    await sync(o.orgId, payload(o, { ...NONE, rulebooks: ["rb_invoice"] }));
    expect(gateMeta(await pay())).toMatchObject({ decision: "refuse", rule_id: "no-rulebook" });
    expect((await receipts(o.orgId)).filter((r) => r.action === "rulebook.withdrawn")).toHaveLength(2);
  });
});

describe("console-sync: pause and the emergency stop", () => {
  it("pausing an agent refuses its next call; the guard's own pause is not undone by a later sync", async () => {
    const o = await consoleOrg();
    const k = issueKey(o);
    await sync(o.orgId, k.payload);
    const read = () => tool(ctx.app, k.secret, "gmail.read_inbox", {});
    o.doc.agents[0]!.status = "paused";
    await sync(o.orgId, payload(o, { ...NONE, agents: ["ag_invoice"] }));
    expect(gateMeta(await read())).toMatchObject({ decision: "refuse", rule_id: "agent-paused" });
    o.doc.agents[0]!.status = "active";
    await sync(o.orgId, payload(o, { ...NONE, agents: ["ag_invoice"] }));
    expect(gateMeta(await read())).toMatchObject({ decision: "allow" });

    // paused by the guard itself (an auto-pause): a sync that did not resume it leaves it paused
    await o.db.agent.updateMany({ where: { consoleId: "ag_invoice" }, data: { status: "paused" } });
    await sync(o.orgId, payload(o));
    expect(gateMeta(await read())).toMatchObject({ rule_id: "agent-paused" });
  });

  it("the console's stop pauses the agents it covers, as an incident, and lifting it resumes them", async () => {
    const o = await consoleOrg();
    const k = issueKey(o);
    await sync(o.orgId, k.payload);
    o.doc.stop = { active: true, reason: "Suspicious payments", by: o.owner.id, since: new Date().toISOString(), scope: "all_agents" };
    await sync(o.orgId, payload(o, { ...NONE, agents: ["ag_invoice", "ag_hr"], stop: true }));
    expect(gateMeta(await tool(ctx.app, k.secret, "gmail.read_inbox", {}))).toMatchObject({ decision: "refuse", rule_id: "agent-paused" });
    const incident = await o.db.incident.findFirstOrThrow({ where: { status: "open" } });
    expect(incident).toMatchObject({ startedBy: o.owner.email, reason: "Suspicious payments" });
    expect(incident.pausedAgentIds).toHaveLength(2);

    o.doc.stop = { active: false };
    await sync(o.orgId, payload(o, { ...NONE, agents: ["ag_invoice", "ag_hr"], stop: true }));
    expect(gateMeta(await tool(ctx.app, k.secret, "gmail.read_inbox", {}))).toMatchObject({ decision: "allow" });
    expect(await o.db.incident.findFirstOrThrow({ where: { id: incident.id } })).toMatchObject({ status: "closed", endedBy: o.owner.email, resumedCount: 2 });
    const actions = (await receipts(o.orgId)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["emergency.stop", "emergency.resumed", "agent.paused", "agent.resumed"]));

    // a stop on selected agents covers only those
    o.doc.stop = { active: true, scope: "selected_agents", agentSlugs: ["hr-screening"] };
    await sync(o.orgId, payload(o, { ...NONE, agents: ["ag_hr"], stop: true }));
    expect(gateMeta(await tool(ctx.app, k.secret, "gmail.read_inbox", {}))).toMatchObject({ decision: "allow" });
    expect((await o.db.agent.findFirstOrThrow({ where: { consoleId: "ag_hr" } })).status).toBe("paused");
  });

  it("an agent removed in the console stops and its keys stop working", async () => {
    const o = await consoleOrg();
    const k = issueKey(o);
    await sync(o.orgId, k.payload);
    o.doc.agents = o.doc.agents.slice(1);
    await sync(o.orgId, payload(o));
    expect((await mcp(ctx.app, k.secret, "tools/list")).status).toBe(401);
    expect((await o.db.agent.findFirstOrThrow({ where: { consoleId: "ag_invoice" } })).status).toBe("paused");
  });
});

describe("console-sync: held calls", () => {
  async function held(o: Org) {
    const k = issueKey(o);
    await sync(o.orgId, k.payload);
    const r = await tool(ctx.app, k.secret, "zoho_books.record_payment", { amount: 240000, vendor: "Northwind" });
    return { ...k, approvalId: String(gateMeta(r).approval_id) };
  }

  it("goes to the console group's members as they are now, and appears in the console document", async () => {
    const o = await consoleOrg();
    await consoleState.save(o.orgId, JSON.stringify({ org: { id: o.orgId }, approvals: [] }), 0);
    const h = await held(o);
    await settle();
    const a = await o.db.approval.findFirstOrThrow({ where: { id: h.approvalId } });
    expect(a).toMatchObject({ approverGroup: "finance", approvers: [o.venkat.email, o.tom.email], ruleId: "pay-large" });
    const doc = JSON.parse((await consoleState.load(o.orgId))!.json) as { approvals: Record<string, unknown>[] };
    expect(doc.approvals).toHaveLength(1);
    expect(doc.approvals[0]).toMatchObject({
      id: h.approvalId,
      seq: a.heldSeq,
      agentSlug: "invoice-bot",
      tool: "zoho_books.record_payment",
      connector: "Zoho Books — India data centre",
      headline: "invoice-bot wants to call zoho_books.record_payment (amount 2,40,000 for Northwind)",
      ruleId: "pay-large",
      approverGroup: "Finance",
      args: { amount: 240000, vendor: "Northwind" },
      riskTags: ["moves_money", "writes_data"],
      status: "pending",
      amount: 240000,
      counterparty: "Northwind",
      source: "guard",
      notifiedTo: [{ userId: o.venkat.id, channels: ["email"] }, { userId: o.tom.id, channels: ["email"] }],
    });

    // Tom leaves Finance in the console: the next held call goes to Venkat only, without a new rulebook
    o.facts.groups[0]!.members = [o.venkat.id];
    await sync(o.orgId, payload(o));
    const next = await tool(ctx.app, h.secret, "zoho_books.record_payment", { amount: 99000, vendor: "Northwind" });
    expect((await o.db.approval.findFirstOrThrow({ where: { id: String(gateMeta(next).approval_id) } })).approvers).toEqual([o.venkat.email]);
    await settle();
  });

  it("deciding it in the console releases the agent, with the guard's receipts; who may decide comes from the console", async () => {
    const o = await consoleOrg();
    const h = await held(o);
    await settle();
    const wait = waitForApproval(ctx.deps, o.orgId, (await o.db.agent.findFirstOrThrow({ where: { consoleId: "ag_invoice" } })).id, h.approvalId, 10);

    // the console re-routed it to Owners and extended it once
    const expiresAt = new Date(Date.now() + 40 * 3_600_000).toISOString();
    const approval = { id: h.approvalId, status: "pending", approverGroup: "Owners", expiresAt, source: "guard" };
    o.doc.approvals = [approval];
    o.facts.allowedApprovers = () => [o.owner.id];
    await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }));
    expect(await o.db.approval.findFirstOrThrow({ where: { id: h.approvalId } })).toMatchObject({ approverGroup: "owners", approvers: [o.owner.email], expiresAt: new Date(expiresAt) });

    // Venkat is no longer one of the people who may decide it
    Object.assign(approval, { status: "approved", decidedBy: o.venkat.id, decisionReason: "fine" });
    const refused = await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }));
    expect(refused.body.approvals[h.approvalId]).toMatchObject({ ok: false, code: "not_approver" });

    Object.assign(approval, { decidedBy: o.owner.id, decisionReason: "Checked with the vendor." });
    const ok = await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }));
    expect(ok.body.approvals[h.approvalId]).toEqual({ ok: true, status: "approved" });
    const status = await wait;
    expect(status).toMatchObject({ status: "approved", outcome: { status: "ok" } });
    const rs = await receipts(o.orgId);
    expect(rs.at(-1)).toMatchObject({ kind: "approval", approval: { id: h.approvalId, result: "approved", by: o.owner.email }, outcome: { status: "ok", ref: expect.stringMatching(/^zoho_books-demo-/) } });

    // the console asking again changes nothing
    const again = await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }));
    expect(again.body.approvals[h.approvalId]).toBeUndefined();
    o.doc.approvals = [{ ...approval, status: "rejected" }];
    expect((await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }))).body.approvals[h.approvalId]).toMatchObject({ ok: false, code: "not_pending" });
  });

  it("an owner deciding outside the group is the console's override; a viewer or a stranger cannot decide", async () => {
    const o = await consoleOrg();
    const h = await held(o);
    const approval = { id: h.approvalId, status: "approved", approverGroup: "Finance", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), decidedBy: o.viewer.id, source: "guard" };
    o.doc.approvals = [approval];
    o.facts.allowedApprovers = () => [o.venkat.id, o.viewer.id];
    expect((await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }))).body.approvals[h.approvalId]).toMatchObject({ ok: false, code: "not_approver" });
    Object.assign(approval, { decidedBy: "u_stranger" });
    expect((await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }))).body.approvals[h.approvalId]).toMatchObject({ ok: false, code: "not_approver" });
    Object.assign(approval, { decidedBy: o.owner.id, status: "rejected", override: { by: o.owner.id } });
    expect((await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }))).body.approvals[h.approvalId]).toEqual({ ok: true, status: "rejected" });
    await settle();
  });

  it("an expiry the console saw first is the guard's too; an approval the guard does not have is reported", async () => {
    const o = await consoleOrg();
    const h = await held(o);
    o.doc.approvals = [{ id: h.approvalId, status: "expired", approverGroup: "Finance", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), source: "guard" }];
    expect((await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }))).body.approvals[h.approvalId]).toMatchObject({ ok: false, code: "not_due" });
    const past = new Date(Date.now() - 1000).toISOString();
    o.doc.approvals = [{ id: h.approvalId, status: "expired", approverGroup: "Finance", expiresAt: past, source: "guard" }];
    expect((await sync(o.orgId, payload(o, { ...NONE, approvals: [h.approvalId] }))).body.approvals[h.approvalId]).toEqual({ ok: true, status: "expired" });
    o.doc.approvals = [{ id: "apr_nope", status: "pending", approverGroup: "Finance", expiresAt: past, source: "guard" }];
    expect((await sync(o.orgId, payload(o))).body.approvals.apr_nope).toMatchObject({ ok: false, code: "not_found" });
    expect(boundedExpiry(new Date(Date.now() + 90 * 86_400_000)).getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 1000);
    await settle();
  });
});

describe("console-sync: organisations stay apart", () => {
  it("the same console ids in two organisations are two sets of rows, and one's keys and approvals are not the other's", async () => {
    const a = await consoleOrg();
    const b = await consoleOrg();
    const ka = issueKey(a);
    const kb = issueKey(b);
    await sync(a.orgId, ka.payload);
    await sync(b.orgId, kb.payload);
    const agentA = await a.db.agent.findFirstOrThrow({ where: { consoleId: "ag_invoice" } });
    const agentB = await b.db.agent.findFirstOrThrow({ where: { consoleId: "ag_invoice" } });
    expect(agentA.id).not.toBe(agentB.id);

    // b's message cannot carry a's key: a's key hash is already a's
    const stolen = issueKey(b);
    stolen.payload.keys.find((k) => k.id === stolen.key.id)!.keyHash = hashToken(ka.secret);
    const r = await sync(b.orgId, stolen.payload);
    expect(r.body.keys.created).toEqual([]);
    expect(r.body.problems.join(" ")).toMatch(/already in use/);
    // a's key still acts for a's agent only
    const call = await tool(ctx.app, ka.secret, "zoho_books.record_payment", { amount: 240000, vendor: "Northwind" });
    const approvalId = String(gateMeta(call).approval_id);
    expect(await a.db.approval.findFirst({ where: { id: approvalId } })).toMatchObject({ agentId: agentA.id });
    // b cannot see or decide a's approval
    b.doc.approvals = [{ id: approvalId, status: "approved", approverGroup: "Finance", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), decidedBy: b.venkat.id, source: "guard" }];
    expect((await sync(b.orgId, payload(b, { ...NONE, approvals: [approvalId] }))).body.approvals[approvalId]).toMatchObject({ ok: false, code: "not_found" });
    expect((await a.db.approval.findFirstOrThrow({ where: { id: approvalId } })).status).toBe("pending");
    // b pausing its agent leaves a's alone
    b.doc.agents[0]!.status = "paused";
    await sync(b.orgId, payload(b, { ...NONE, agents: ["ag_invoice"] }));
    expect(gateMeta(await tool(ctx.app, ka.secret, "gmail.read_inbox", {}))).toMatchObject({ decision: "allow" });
    expect(gateMeta(await tool(ctx.app, kb.secret, "gmail.read_inbox", {}))).toMatchObject({ rule_id: "agent-paused" });
    // and a's held call is written into a's console document only
    await consoleState.save(b.orgId, JSON.stringify({ org: { id: b.orgId }, approvals: [] }), 0);
    await consoleState.save(a.orgId, JSON.stringify({ org: { id: a.orgId }, approvals: [] }), 0);
    await tool(ctx.app, ka.secret, "zoho_books.record_payment", { amount: 77000, vendor: "Northwind" });
    await settle();
    expect((JSON.parse((await consoleState.load(a.orgId))!.json) as { approvals: unknown[] }).approvals).toHaveLength(1);
    expect((JSON.parse((await consoleState.load(b.orgId))!.json) as { approvals: unknown[] }).approvals).toHaveLength(0);
  });
});
