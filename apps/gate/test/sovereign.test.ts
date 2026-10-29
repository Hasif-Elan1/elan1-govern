import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connectorFor } from "@gate/connectors";
import {
  EgressBlocked,
  egressRuleProblem,
  forOrg,
  isInternalHost,
  matchesEntry,
  parseAllowEntry,
  parseAllowList,
  prisma,
  sovereignProblems,
  targetOf,
} from "@gate/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { connectSlack, slackPost } from "../src/chat/slack";
import type { Deps, JobQueue } from "../src/deps";
import { addEgressRule, egressRules, purgeEgress, removeEgressRule } from "../src/egress";
import { readGateEnv, type GateEnv } from "../src/env";
import { createMailer } from "../src/mailer";
import { addUpstream, syncUpstream } from "../src/upstream";
import { createWebhook, deliverWebhook } from "../src/webhooks";
import { demoOrg, env } from "./helpers";

// GATE_PROFILE=sovereign: deny-all egress except the allow-list, every decision logged, blocked
// attempts receipted. One local server stands in for a webhook endpoint, an MCP server and Slack.

let server: Server;
let port: number;
let base: string;
const hits: string[] = [];

function crm() {
  const s = new McpServer({ name: "crm", version: "1.0.0" });
  s.registerTool("lookup", { description: "Look up an order", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "shipped" }] }));
  return s;
}

const queue: JobQueue = { send: async () => undefined };
type Ctx = { app: Awaited<ReturnType<typeof buildApp>>["app"]; deps: Deps };
const apps: Ctx[] = [];
async function appWith(over: Partial<GateEnv>): Promise<Ctx> {
  const built = await buildApp({ ...env, ...over }, { mailer: { send: async () => undefined }, queue });
  await built.app.ready();
  apps.push(built);
  return built;
}
let std: Ctx;
let denied: Ctx;
let allowed: Ctx;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    hits.push(req.url ?? "");
    let raw = "";
    for await (const c of req) raw += c;
    if (req.url === "/mcp") {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const s = crm();
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void t.close().then(() => s.close()));
      await s.connect(t);
      return void (await t.handleRequest(req, res, JSON.parse(raw)));
    }
    if (req.url?.startsWith("/api/")) {
      const m = req.url.slice(5);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(m === "auth.test" ? { ok: true, team_id: "T0SOV", team: "Bank" } : { ok: true, channel: "C0SOV", ts: "1.0001" }));
    }
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  std = await appWith({});
  denied = await appWith({ GATE_PROFILE: "sovereign", EGRESS_ALLOW: "", SLACK_API_URL: `${base}/api` });
  allowed = await appWith({ GATE_PROFILE: "sovereign", EGRESS_ALLOW: `127.0.0.1:${port}`, SLACK_API_URL: `${base}/api` });
});
afterAll(async () => {
  for (const a of apps) await a.app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const settle = async () => {
  for (const a of apps) await Promise.all([...a.deps.background]);
};
const blockedReceipts = (orgId: string) => forOrg(orgId).receipt.findMany({ where: { action: "egress.blocked" }, orderBy: { seq: "asc" } });
const details = (r: { body: unknown }) => (r.body as { details: Record<string, unknown>; actor: string });
const logs = (orgId: string, purpose: string) => forOrg(orgId).egressLog.findMany({ where: { purpose }, orderBy: { at: "asc" } });

describe("the allow-list", () => {
  it("parses host, host:port, wildcards and IPv6, and reports what it cannot read", () => {
    expect(parseAllowEntry("SIEM.Bank.Internal.")).toEqual({ host: "siem.bank.internal", wildcard: false, port: null });
    expect(parseAllowEntry("smtp.bank.internal:25")).toEqual({ host: "smtp.bank.internal", wildcard: false, port: 25 });
    expect(parseAllowEntry("*.bank.internal:8443")).toEqual({ host: "bank.internal", wildcard: true, port: 8443 });
    expect(parseAllowEntry("[fd00::1]:443")).toEqual({ host: "fd00::1", wildcard: false, port: 443 });
    expect(parseAllowEntry("fd00::2")).toEqual({ host: "fd00::2", wildcard: false, port: null });
    for (const bad of ["*", "a.*.b", "host:0", "host:99999", "host:x", "[fd00::1", "[fd00::1]x", "*.10.0.0.1", "bad_host!"]) expect(parseAllowEntry(bad)).toBeNull();
    const { entries, errors } = parseAllowList("a.internal, b.internal:25  *.c.internal,,nope:");
    expect(entries).toHaveLength(3);
    expect(errors).toEqual(['"nope:" is not a host, host:port or *.zone entry']);
  });

  it("matches exact hosts, ports and subdomains only", () => {
    const w = parseAllowEntry("*.bank.internal")!;
    expect(matchesEntry(w, "siem.bank.internal", 443)).toBe(true);
    expect(matchesEntry(w, "a.b.bank.internal", 25)).toBe(true);
    expect(matchesEntry(w, "bank.internal", 443)).toBe(false);
    expect(matchesEntry(w, "evilbank.internal", 443)).toBe(false);
    const p = parseAllowEntry("smtp.bank.internal:25")!;
    expect(matchesEntry(p, "SMTP.bank.internal", 25)).toBe(true);
    expect(matchesEntry(p, "smtp.bank.internal", 587)).toBe(false);
  });

  it("knows what is inside the network", () => {
    for (const h of ["siem.bank.internal", "relay.local", "mailpit", "localhost", "10.2.3.4", "192.168.1.9", "172.20.0.1", "127.0.0.1", "::1", "fd12::1", "smtp.corp.bank.co.in"]) expect(isInternalHost(h, ["corp.bank.co.in"]), h).toBe(true);
    for (const h of ["slack.com", "graph.facebook.com", "8.8.8.8", "169.254.169.254", "100.64.0.1", "bank.co.in", "2001:4860::8888", "bad host"]) expect(isInternalHost(h, ["corp.bank.co.in"]), h).toBe(false);
  });

  it("names the host and port of URLs and host:port pairs", () => {
    expect(targetOf("https://Siem.bank.internal/x")).toEqual({ host: "siem.bank.internal", port: 443 });
    expect(targetOf("http://[fd00::1]:8080/")).toEqual({ host: "fd00::1", port: 8080 });
    expect(targetOf("smtp://relay.internal")).toEqual({ host: "relay.internal", port: 25 });
    expect(targetOf("relay.internal:2525")).toEqual({ host: "relay.internal", port: 2525 });
    expect(targetOf({ host: "Relay.Internal", port: 25 })).toEqual({ host: "relay.internal", port: 25 });
    expect(() => targetOf("relay.internal")).toThrow();
    expect(() => targetOf("ftp://relay.internal/")).toThrow();
  });

  it("refuses public names and wildcards on an organisation's own list", () => {
    expect(egressRuleProblem("siem.bank.internal", 8088)).toBeNull();
    expect(egressRuleProblem("10.1.1.1", null)).toBeNull();
    expect(egressRuleProblem("*.bank.internal", null)).toMatch(/wildcards/);
    expect(egressRuleProblem("hooks.slack.com", null)).toMatch(/not inside your network/);
    expect(egressRuleProblem("siem.bank.internal", 70000)).toMatch(/port/);
    expect(egressRuleProblem("bad host", null)).toMatch(/not a host/);
    expect(egressRuleProblem("siem.corp.bank.co.in", null, "corp.bank.co.in")).toBeNull();
  });
});

describe("start-up checks in the sovereign profile", () => {
  const sov = { ...process.env, GATE_PROFILE: "sovereign", SLACK_API_URL: "", WHATSAPP_API_URL: "" };

  it("accepts an internal relay on the allow-list and switches public chat off", () => {
    const e = readGateEnv({ ...sov, SMTP_HOST: "smtp.bank.internal", SMTP_PORT: "25", EGRESS_ALLOW: "smtp.bank.internal:25,*.bank.internal" });
    expect(e.GATE_PROFILE).toBe("sovereign");
    expect(e.SLACK_API_URL).toBe("");
    expect(e.WHATSAPP_API_URL).toBe("");
    // Standard keeps the public defaults.
    expect(readGateEnv({ ...process.env, SLACK_API_URL: "" }).SLACK_API_URL).toBe("https://slack.com/api");
  });

  it("refuses public SaaS endpoints the way production refuses sample secrets", () => {
    const ok = { ...sov, SMTP_HOST: "smtp.bank.internal", SMTP_PORT: "25", EGRESS_ALLOW: "smtp.bank.internal:25" };
    expect(() => readGateEnv({ ...ok, SLACK_API_URL: "https://slack.com/api" })).toThrow(/SLACK_API_URL: slack.com is a public endpoint/);
    expect(() => readGateEnv({ ...ok, WHATSAPP_API_URL: "https://graph.facebook.com/v21.0" })).toThrow(/WHATSAPP_API_URL: graph.facebook.com is a public endpoint/);
    expect(() => readGateEnv({ ...ok, SLACK_API_URL: "https://slack-relay.bank.internal/api" })).toThrow(/SLACK_API_URL: slack-relay.bank.internal:443 is not on EGRESS_ALLOW/);
    expect(readGateEnv({ ...ok, EGRESS_ALLOW: "smtp.bank.internal:25,slack-relay.bank.internal", SLACK_API_URL: "https://slack-relay.bank.internal/api" }).SLACK_API_URL).toBe("https://slack-relay.bank.internal/api");
    expect(() => readGateEnv({ ...ok, SMTP_HOST: "smtp.sendgrid.net" })).toThrow(/SMTP_HOST: smtp.sendgrid.net is a public endpoint/);
    expect(() => readGateEnv({ ...ok, SMTP_PORT: "587" })).toThrow(/SMTP_HOST: smtp.bank.internal:587 is not on EGRESS_ALLOW/);
    expect(() => readGateEnv({ ...ok, EGRESS_ALLOW: "smtp.bank.internal:25,api.openai.com" })).toThrow(/EGRESS_ALLOW: api.openai.com is a public name/);
    expect(() => readGateEnv({ ...ok, EGRESS_ALLOW: "smtp.bank.internal:25,*.com" })).toThrow(/EGRESS_ALLOW: \*\.com is a public name/);
    expect(() => readGateEnv({ ...ok, EGRESS_ALLOW: "smtp.bank.internal:25,::bad::" })).toThrow(/EGRESS_ALLOW: "::bad::"/);
    expect(() => readGateEnv({ ...ok, CONNECTOR_MODE: "live", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" })).toThrow(/GOOGLE_CLIENT_ID: Gmail is a public service/);
    expect(() => readGateEnv({ ...ok, CONNECTOR_MODE: "live", ZOHO_CLIENT_ID: "z", ZOHO_CLIENT_SECRET: "s" })).toThrow(/ZOHO_ACCOUNTS_URL: accounts.zoho.in is a public endpoint/);
  });

  it("checks the shared helper on its own", () => {
    expect(sovereignProblems({ allow: "relay.internal:25" }, [{ name: "X", target: "relay.internal" }])).toEqual([{ name: "X", message: "has no host and port" }]);
    expect(sovereignProblems({ allow: "relay.internal:25" }, [{ name: "X", target: { host: "relay.internal", port: 25 } }])).toEqual([]);
  });

  it("refuses a release key that is not an Ed25519 public key", () => {
    expect(() => readGateEnv({ ...process.env, UPDATE_SIGNING_PUBLIC_KEYS: "bm90IGEga2V5" })).toThrow(/UPDATE_SIGNING_PUBLIC_KEYS/);
  });
});

describe("webhooks", () => {
  async function hook() {
    const d = await demoOrg(std.deps);
    const r = await createWebhook(std.deps, d.org.id, { url: `${base}/hook`, events: ["receipt.created"], actor: d.owner.email });
    if (!r.ok) throw new Error(r.error);
    await settle();
    return { d, id: r.id };
  }
  const delivery = (orgId: string, webhookId: string) => forOrg(orgId).webhookDelivery.create({ data: { orgId, webhookId, event: "webhook.test", payload: { n: 1 }, nextAttemptAt: new Date() } });

  it("standard profile: delivers and logs the decision as allowed", async () => {
    const { d, id } = await hook();
    const del = await delivery(d.org.id, id);
    expect(await deliverWebhook(std.deps, d.org.id, del.id)).toBe("delivered");
    const rows = await logs(d.org.id, "webhook");
    expect(rows.at(-1)).toMatchObject({ orgId: d.org.id, host: "127.0.0.1", port, decision: "allowed", profile: "standard" });
  });

  it("sovereign: a host off the allow-list is never connected to, is logged and receipted once an hour", async () => {
    const { d, id } = await hook();
    const before = hits.length;
    const a = await delivery(d.org.id, id);
    expect(await deliverWebhook(denied.deps, d.org.id, a.id)).toBe("failed"); // not retried: nothing changes until the allow-list does
    const row = await forOrg(d.org.id).webhookDelivery.findFirstOrThrow({ where: { id: a.id } });
    expect(row.lastError).toMatch(/egress allow-list/);
    const b = await delivery(d.org.id, id);
    expect(await deliverWebhook(denied.deps, d.org.id, b.id)).toBe("failed");
    expect(hits.length).toBe(before);
    await settle();

    const blocked = (await logs(d.org.id, "webhook")).filter((l) => l.decision === "blocked");
    expect(blocked).toHaveLength(2);
    expect(blocked[0]).toMatchObject({ host: "127.0.0.1", port, profile: "sovereign", alerted: true });
    expect(blocked[1]).toMatchObject({ alerted: false, receiptSeq: null });
    const receipts = await blockedReceipts(d.org.id);
    expect(receipts).toHaveLength(1); // a retrying system does not flood the chain
    expect(details(receipts[0]!).actor).toBe("Elan1 Govern");
    expect(details(receipts[0]!).details).toMatchObject({ host: "127.0.0.1", port, purpose: "webhook", profile: "sovereign", policy: "deny_all" });
    expect(blocked[0]!.receiptSeq).toBe(receipts[0]!.seq);
  });

  it("sovereign: an allow-listed host is delivered to", async () => {
    const { d, id } = await hook();
    const before = hits.length;
    const del = await delivery(d.org.id, id);
    expect(await deliverWebhook(allowed.deps, d.org.id, del.id)).toBe("delivered");
    expect(hits.length).toBe(before + 1);
    expect((await logs(d.org.id, "webhook")).at(-1)).toMatchObject({ decision: "allowed", profile: "sovereign" });
    expect(await blockedReceipts(d.org.id)).toHaveLength(0);
  });

  it("sovereign: an organisation's own rule opens one internal host, for that organisation only", async () => {
    const { d, id } = await hook();
    const other = await hook();
    await forOrg(d.org.id).egressRule.create({ data: { orgId: d.org.id, host: "127.0.0.1", port, purpose: "webhook", createdBy: d.owner.email } });
    expect(await deliverWebhook(denied.deps, d.org.id, (await delivery(d.org.id, id)).id)).toBe("delivered");
    expect(await deliverWebhook(denied.deps, other.d.org.id, (await delivery(other.d.org.id, other.id)).id)).toBe("failed");
    // A rule for another purpose, or a public host written around the validation, opens nothing.
    const third = await hook();
    await forOrg(third.d.org.id).egressRule.create({ data: { orgId: third.d.org.id, host: "127.0.0.1", port, purpose: "chat-slack", createdBy: "x" } });
    expect(await deliverWebhook(denied.deps, third.d.org.id, (await delivery(third.d.org.id, third.id)).id)).toBe("failed");
    await forOrg(third.d.org.id).egressRule.create({ data: { orgId: third.d.org.id, host: "hooks.example.com", createdBy: "x" } });
    expect((await denied.deps.egress.decide("https://hooks.example.com/x", "webhook", { orgId: third.d.org.id })).allowed).toBe(false);
  });

  it("owners add and remove their own internal hosts, with receipts; public hosts and wildcards are refused", async () => {
    const { d, id } = await hook();
    const actor = d.owner.email;
    expect(await addEgressRule(denied.deps, d.org.id, { host: "hooks.slack.com", actor })).toMatchObject({ ok: false, status: 400 });
    expect(await addEgressRule(denied.deps, d.org.id, { host: "*.bank.internal", actor })).toMatchObject({ ok: false, status: 400 });
    expect(await addEgressRule(denied.deps, d.org.id, { host: "127.0.0.1", purpose: "ftp", actor })).toMatchObject({ ok: false, status: 400 });
    const added = await addEgressRule(denied.deps, d.org.id, { host: "127.0.0.1", port, purpose: "webhook", note: "on-premises SIEM", actor });
    expect(added).toMatchObject({ ok: true });
    expect(await addEgressRule(denied.deps, d.org.id, { host: "127.0.0.1", port, purpose: "webhook", actor })).toMatchObject({ ok: false, status: 409 });
    expect(await egressRules(denied.deps, d.org.id)).toHaveLength(1);
    expect(await deliverWebhook(denied.deps, d.org.id, (await delivery(d.org.id, id)).id)).toBe("delivered");
    if (!added.ok) return;
    expect(await removeEgressRule(denied.deps, d.org.id, added.id, actor)).toMatchObject({ ok: true });
    expect(await removeEgressRule(denied.deps, d.org.id, added.id, actor)).toMatchObject({ ok: false, status: 404 });
    expect(await deliverWebhook(denied.deps, d.org.id, (await delivery(d.org.id, id)).id)).toBe("failed");
    const rs = await forOrg(d.org.id).receipt.findMany({ where: { action: { startsWith: "egress.internal_host" } }, orderBy: { seq: "asc" } });
    expect(rs.map((r) => [r.action, details(r).details.host])).toEqual([
      ["egress.internal_host_added", "127.0.0.1"],
      ["egress.internal_host_removed", "127.0.0.1"],
    ]);
    await settle();
  });

  it("sovereign: adding an endpoint outside the allow-list is refused with a receipt naming the person", async () => {
    const d = await demoOrg(denied.deps);
    const r = await createWebhook(denied.deps, d.org.id, { url: "https://siem.example.com/collector", events: ["receipt.created"], actor: d.owner.email });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/siem.example.com is not on this deployment's egress allow-list/) });
    expect(await forOrg(d.org.id).webhook.count()).toBe(0);
    const receipts = await blockedReceipts(d.org.id);
    expect(receipts).toHaveLength(1);
    expect(details(receipts[0]!)).toMatchObject({ actor: d.owner.email, details: { host: "siem.example.com", port: 443, purpose: "webhook" } });
    await settle();
  });
});

describe("upstream MCP servers", () => {
  it("sovereign: refused when added off the allow-list, and nothing reaches the server", async () => {
    const d = await demoOrg(denied.deps);
    const before = hits.length;
    const r = await addUpstream(denied.deps, d.org.id, { name: "crm", url: `${base}/mcp`, actor: d.owner.email });
    expect(r).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/egress allow-list/) });
    expect(hits.length).toBe(before);
    expect(details((await blockedReceipts(d.org.id))[0]!)).toMatchObject({ actor: d.owner.email, details: { purpose: "upstream-mcp", port } });
    await settle();
  });

  it("sovereign: allowed on the allow-list; a later sync under deny-all never connects", async () => {
    const d = await demoOrg(allowed.deps);
    const r = await addUpstream(allowed.deps, d.org.id, { name: "crm", url: `${base}/mcp`, actor: d.owner.email });
    expect(r).toMatchObject({ ok: true, sync: { ok: true, tools: 1 } });
    if (!r.ok) return;
    expect((await logs(d.org.id, "upstream-mcp")).every((l) => l.decision === "allowed")).toBe(true);

    const before = hits.length;
    const again = await syncUpstream(denied.deps, d.org.id, r.server.id, d.owner.email);
    expect(again).toMatchObject({ ok: false, status: 502, error: expect.stringMatching(/egress policy does not allow/) });
    expect(hits.length).toBe(before);
    expect((await logs(d.org.id, "upstream-mcp")).at(-1)).toMatchObject({ decision: "blocked" });
    expect(details((await blockedReceipts(d.org.id))[0]!).details).toMatchObject({ purpose: "upstream-mcp" });
    await settle();
  });
});

describe("Slack and WhatsApp", () => {
  const BOT = ["xoxb", "1234567890", "sovereigntest"].join("-");
  const SIGNING = "0123456789abcdef0123456789abcdef";

  it("sovereign: a chat API off the allow-list is never called", async () => {
    const d = await demoOrg(denied.deps);
    const before = hits.length;
    const r = await connectSlack(denied.deps, d.org.id, { botToken: BOT, signingSecret: SIGNING, channelId: "C0SOV", actor: d.owner.email });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/egress policy does not allow Slack/) });
    await expect(slackPost(denied.deps, d.org.id, BOT, "C0SOV", { text: "x", blocks: [] })).rejects.toMatchObject({ retry: false });
    expect(hits.length).toBe(before);
    expect((await logs(d.org.id, "chat-slack")).map((l) => l.decision)).toEqual(["blocked", "blocked"]);
    expect(await blockedReceipts(d.org.id)).toHaveLength(1);
    await settle();
  });

  it("sovereign: an allow-listed internal relay works, and no URL at all means no chat", async () => {
    const d = await demoOrg(allowed.deps);
    expect(await connectSlack(allowed.deps, d.org.id, { botToken: BOT, signingSecret: SIGNING, channelId: "C0SOV", actor: d.owner.email })).toMatchObject({ ok: true, team: "Bank" });
    expect((await logs(d.org.id, "chat-slack")).at(-1)).toMatchObject({ decision: "allowed" });
    const none = await appWith({ GATE_PROFILE: "sovereign", EGRESS_ALLOW: `127.0.0.1:${port}`, SLACK_API_URL: "", WHATSAPP_API_URL: "" });
    expect(await connectSlack(none.deps, d.org.id, { botToken: BOT, signingSecret: SIGNING, channelId: "C0SOV", actor: d.owner.email })).toMatchObject({ ok: false, error: expect.stringMatching(/Slack is not available in this deployment/) });
    await settle();
  });
});

describe("mail, connectors and retention", () => {
  it("sovereign: an SMTP relay off the allow-list is refused at the platform level with a health alert", async () => {
    // A port no other run used, so the hourly alert window starts fresh.
    const smtpPort = 20_000 + Math.floor(Math.random() * 40_000);
    const mailer = createMailer({ ...env, GATE_PROFILE: "sovereign", SMTP_HOST: "relay.bank.internal", SMTP_PORT: smtpPort }, denied.deps.egress);
    await expect(mailer.send({ to: "a@b.in", subject: "s", text: "t", html: "<p>t</p>" })).rejects.toBeInstanceOf(EgressBlocked);
    const row = await prisma.egressLog.findFirstOrThrow({ where: { host: "relay.bank.internal", port: smtpPort } });
    expect(row).toMatchObject({ orgId: null, purpose: "smtp", decision: "blocked", alerted: true });
    expect(denied.deps.alerts.some((a) => a.kind === "egress-blocked" && a.message.includes(`relay.bank.internal:${smtpPort}`))).toBe(true);
  });

  it("live connectors ask the egress gate before every request, token refresh included", async () => {
    const d = await demoOrg(denied.deps);
    const seen: string[] = [];
    const f = (async (u: string | URL | Request) => (seen.push(String(u)), new Response(JSON.stringify({ access_token: "a", messages: [] }), { status: 200 }))) as typeof fetch;
    const google = { clientId: "c", clientSecret: "s" };
    const ctx = { orgId: d.org.id, tokens: { access_token: "t", refresh_token: "r", expires_at: Date.now() - 1000 } };
    const blocked = connectorFor("gmail", "live", { google, fetch: f, egress: denied.deps.live.egress });
    await expect(blocked.call("gmail.search", { query: "x" }, ctx)).rejects.toBeInstanceOf(EgressBlocked);
    expect(seen).toEqual([]);
    expect((await logs(d.org.id, "connector"))[0]).toMatchObject({ host: "oauth2.googleapis.com", decision: "blocked" });
    const open = connectorFor("gmail", "live", { google, fetch: f, egress: std.deps.live.egress });
    await open.call("gmail.search", { query: "x" }, { ...ctx, tokens: { access_token: "t", expires_at: Date.now() + 3_600_000 } });
    expect(seen).toHaveLength(1);
    await settle();
  });

  it("the egress-purge job drops decisions older than the retention period", async () => {
    const old = new Date(Date.now() - (env.EGRESS_LOG_RETENTION_DAYS + 1) * 86_400_000);
    const keep = await prisma.egressLog.create({ data: { host: "keep.internal", port: 1, purpose: "test", decision: "allowed", profile: "standard" } });
    const drop = await prisma.egressLog.create({ data: { host: "drop.internal", port: 1, purpose: "test", decision: "allowed", profile: "standard", at: old } });
    expect(await purgeEgress(std.deps)).toBeGreaterThanOrEqual(1);
    expect(await prisma.egressLog.findUnique({ where: { id: drop.id } })).toBeNull();
    expect(await prisma.egressLog.findUnique({ where: { id: keep.id } })).not.toBeNull();
  });
});
