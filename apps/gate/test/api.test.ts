import { gmailConnector, mockState, zohoConnector, type ConnectorKind, type ConnectorMode } from "@gate/connectors";
import { hmacSign, signRequest } from "@gate/core";
import { forOrg } from "@gate/db";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectorFor } from "@gate/connectors";
import { resolveApproval } from "../src/approvals";
import { runDemoAgent } from "../src/demo/agent";
import { demoOrg, env, gateMeta, internal, makeApp, tool } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(() => ctx.app.close());

const post = (url: string, key: string, body: unknown) =>
  ctx.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, payload: JSON.stringify(body) });

describe("REST Event API (SDK)", () => {
  it("check -> run yourself -> record", async () => {
    const d = await demoOrg(ctx.deps);
    const check = await post("/v1/check", d.apiKey, { tool: "zoho.record_bill_payment", args: { bill_id: "bill_1187", amount_inr: 18000 } });
    expect(check.json()).toMatchObject({ decision: "allow", rule_id: "pay-small", check_id: expect.any(Number) });
    expect(mockState(d.org.id).payments).toHaveLength(0); // Gate did not run it
    const rec = await post("/v1/record", d.apiKey, { check_id: check.json().check_id, status: "ok", ref: "UTR-1" });
    expect(rec.json()).toMatchObject({ recorded: true });
    const dup = await post("/v1/record", d.apiKey, { check_id: check.json().check_id, status: "ok" });
    expect(dup.statusCode).toBe(409);
    const last = await forOrg(d.org.id).receipt.findFirstOrThrow({ orderBy: { seq: "desc" } });
    expect(last.body).toMatchObject({ kind: "outcome", ref_seq: check.json().check_id, outcome: { status: "ok", ref: "UTR-1" } });
  });

  it("check: ask, then approved -> agent runs and records; refuse cannot be recorded", async () => {
    const d = await demoOrg(ctx.deps);
    const check = (await post("/v1/check", d.apiKey, { tool: "zoho.record_bill_payment", args: { bill_id: "bill_2291", amount_inr: 200000 } })).json();
    expect(check).toMatchObject({ decision: "ask", approval_id: expect.any(String), approval_url: expect.stringContaining("/approvals/") });
    await resolveApproval(ctx.deps, d.org.id, check.approval_id, { userId: d.owner.id, email: d.owner.email, result: "approved" });
    expect(mockState(d.org.id).payments).toHaveLength(0); // executor is the agent
    const st = await ctx.app.inject({ method: "GET", url: `/v1/approvals/${check.approval_id}?wait=0`, headers: { authorization: `Bearer ${d.apiKey}` } });
    expect(st.json()).toMatchObject({ status: "approved", message: expect.stringMatching(/You may run the action now/) });
    expect((await post("/v1/record", d.apiKey, { approval_id: check.approval_id, status: "ok" })).statusCode).toBe(200);

    const refused = (await post("/v1/check", d.apiKey, { tool: "zoho.update_vendor", args: { vendor_id: "v_sharma", fields: { ifsc: "X" } } })).json();
    expect(refused).toMatchObject({ decision: "refuse", rule_id: "no-bank-change" });
    expect((await post("/v1/record", d.apiKey, { check_id: refused.check_id, status: "ok" })).statusCode).toBe(404);
  });

  it("validates bodies and keys", async () => {
    const d = await demoOrg(ctx.deps);
    expect((await post("/v1/check", d.apiKey, { tool: "" })).statusCode).toBe(400);
    expect((await post("/v1/record", d.apiKey, { status: "ok" })).statusCode).toBe(400);
    expect((await post("/v1/record", d.apiKey, { approval_id: "apr_nope", status: "ok" })).statusCode).toBe(404);
    expect((await post("/v1/check", "nope", { tool: "gmail.search" })).statusCode).toBe(401);
    const bad = await ctx.app.inject({ method: "POST", url: "/v1/check", headers: { authorization: `Bearer ${d.apiKey}`, "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    const missing = await ctx.app.inject({ method: "GET", url: "/v1/approvals/apr_missing", headers: { authorization: `Bearer ${d.apiKey}` } });
    expect(missing.statusCode).toBe(404);
  });

  it("an agent cannot see another agent's approvals", async () => {
    const a = await demoOrg(ctx.deps);
    const b = await demoOrg(ctx.deps);
    const held = gateMeta(await tool(ctx.app, a.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 }));
    const st = await ctx.app.inject({ method: "GET", url: `/v1/approvals/${held.approval_id as string}`, headers: { authorization: `Bearer ${b.apiKey}` } });
    expect(st.statusCode).toBe(404);
  });
});

describe("internal API", () => {
  it("requires a valid signature bound to method, path and body", async () => {
    const d = await demoOrg(ctx.deps);
    const url = `/internal/orgs/${d.org.id}/agents/${d.agentId}/status`;
    const body = JSON.stringify({ status: "paused", actor: d.owner.email });
    expect((await ctx.app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json" } })).statusCode).toBe(401);
    const sig = signRequest(env.INTERNAL_API_SECRET, "POST", url, body);
    const tampered = await ctx.app.inject({ method: "POST", url, payload: body.replace("paused", "active"), headers: { "content-type": "application/json", "x-gate-signature": sig } });
    expect(tampered.statusCode).toBe(401);
    const other = await ctx.app.inject({ method: "POST", url: url.replace(d.agentId, "x"), payload: body, headers: { "content-type": "application/json", "x-gate-signature": sig } });
    expect(other.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", "x-gate-signature": sig } });
    expect(ok.json()).toEqual({ status: "paused" });
  });

  it("validates input and unknown orgs", async () => {
    const d = await demoOrg(ctx.deps);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/events`, { actor: "x", action: "nope" })).statusCode).toBe(400);
    expect((await internal(ctx.app, "POST", "/internal/orgs/missing-org/events", { actor: d.owner.email, action: "settings.updated" })).statusCode).toBe(404);
    expect((await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/events`, { actor: d.owner.email, action: "settings.updated", details: { retention_days: 365 } })).json()).toMatchObject({ seq: expect.any(Number) });
    expect((await internal(ctx.app, "GET", "/internal/health")).json()).toMatchObject({ ok: true });
  });

  it("creates agents with keys, rotates and revokes keys", async () => {
    const d = await demoOrg(ctx.deps);
    const yaml = (await forOrg(d.org.id).rulebook.findFirstOrThrow()).yaml.replace("agent: ap-bot", "agent: other");
    const res = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents`, {
      name: "Second bot", slug: "second-bot", purpose: "Testing", ownerEmail: d.owner.email, createdById: d.owner.id, riskTier: "low", yaml, actor: d.owner.email,
    });
    expect(res.json()).toMatchObject({ agentId: expect.any(String), apiKey: expect.stringMatching(/^gk_/), rulebook: { ok: true, version: 1 } });
    const dup = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents`, { name: "x", slug: "second-bot", purpose: "x", ownerEmail: d.owner.email, createdById: d.owner.id, riskTier: "low", actor: d.owner.email });
    expect(dup.statusCode).toBe(409);
    const rotated = (await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/keys`, { actor: d.owner.email })).json();
    expect(rotated.apiKey).toMatch(/^gk_/);
    const keyRow = await forOrg(d.org.id).apiKey.findFirstOrThrow({ where: { agentId: d.agentId, prefix: rotated.apiKey.slice(0, 10) } });
    expect(keyRow.keyHash).not.toContain(rotated.apiKey);
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/keys`, { actor: d.owner.email, revokeKeyId: keyRow.id });
    expect((await post("/v1/check", rotated.apiKey, { tool: "gmail.search", args: { query: "" } })).statusCode).toBe(401);
  });

  it("creates orgs with keys, controls and an admin receipt", async () => {
    const { makeUser } = await import("./helpers");
    const u = await makeUser();
    const res = await internal(ctx.app, "POST", "/internal/orgs", { name: "New Co", ownerUserId: u.id, ownerEmail: u.email });
    const orgId = res.json().orgId as string;
    const db = forOrg(orgId);
    expect(await db.control.count()).toBe(10);
    expect((await db.org.findFirstOrThrow()).privateKeyEnc).toMatch(/^v1\./);
    expect((await db.receipt.findFirstOrThrow()).body).toMatchObject({ seq: 1, kind: "admin", action: "org.created" });
  });

  it("demo: connects mock tools, publishes a signed rulebook and runs in the background", async () => {
    const { makeUser } = await import("./helpers");
    const u = await makeUser();
    const orgId = (await internal(ctx.app, "POST", "/internal/orgs", { name: "Demo Co", ownerUserId: u.id, ownerEmail: u.email })).json().orgId as string;
    const res = await internal(ctx.app, "POST", `/internal/orgs/${orgId}/demo`, { userId: u.id, email: u.email, run: false });
    expect(res.json()).toMatchObject({ apiKey: expect.stringMatching(/^gk_/), mcpUrl: expect.stringMatching(/\/mcp$/) });
    expect(await forOrg(orgId).connector.count({ where: { status: "connected", mode: "mock" } })).toBe(2);
    const again = await internal(ctx.app, "POST", `/internal/orgs/${orgId}/demo`, { userId: u.id, email: u.email, run: false });
    expect(again.json().agentId).toBe(res.json().agentId);
  });

  it("connectors: live mode needs configuration", async () => {
    const d = await demoOrg(ctx.deps);
    const r = await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/connectors/zoho`, { action: "connect", mode: "live", actor: d.owner.email });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/ZOHO_CLIENT_ID/);
  });
});

describe("live connectors and OAuth", () => {
  const SECRET = "test-oauth-access-SECRET-not-real";
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.includes("oauth2.googleapis.com/token") || u.includes("accounts.zoho.in/oauth/v2/token")) return json({ access_token: SECRET, refresh_token: "1//SECRET-REFRESH", expires_in: 3600 });
    if (u.includes("/users/me/profile")) return json({ emailAddress: "ap@acme.in" });
    if (u.includes("/organizations")) return json({ organizations: [{ organization_id: "60011", name: "Acme Books" }] });
    if (u.includes("/messages/g1")) return json({ id: "g1", threadId: "t", payload: { headers: [{ name: "Subject", value: "Hi" }], parts: [] } });
    return json({});
  }) as typeof fetch;

  async function liveApp() {
    const live = { google: { clientId: "g", clientSecret: "gs" }, zoho: { clientId: "z", clientSecret: "zs", accountsUrl: "https://accounts.zoho.in", apiUrl: "https://www.zohoapis.in" }, fetch: fakeFetch };
    return makeApp({
      live,
      connector: (kind: ConnectorKind, mode: ConnectorMode) => (mode === "mock" ? connectorFor(kind, mode, {}) : kind === "gmail" ? gmailConnector(live.google, fakeFetch) : zohoConnector(live.zoho, fakeFetch)),
    });
  }

  it("connects through OAuth, stores tokens encrypted, and never shows them to the agent", async () => {
    const app = await liveApp();
    const d = await demoOrg(app.deps);
    const start = (await internal(app.app, "POST", `/internal/orgs/${d.org.id}/connectors/gmail`, { action: "connect", mode: "live", actor: d.owner.email })).json();
    const auth = new URL(start.redirect);
    expect(auth.origin).toBe("https://accounts.google.com");
    expect(auth.searchParams.get("redirect_uri")).toBe(`${env.GATE_PUBLIC_URL}/oauth/gmail/callback`);
    const cb = await app.app.inject({ method: "GET", url: `/oauth/gmail/callback?code=abc&state=${encodeURIComponent(auth.searchParams.get("state")!)}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`${env.WEB_URL}/connectors?connected=gmail`);
    const row = await forOrg(d.org.id).connector.findFirstOrThrow({ where: { kind: "gmail" } });
    expect(row).toMatchObject({ mode: "live", status: "connected", accountLabel: "ap@acme.in" });
    expect(row.tokensEnc).not.toContain("SECRET");

    // Everything the agent can reach: tool results, errors, approvals, status.
    const responses: string[] = [];
    responses.push(JSON.stringify(await tool(app.app, d.apiKey, "gmail.read_message", { message_id: "g1" })));
    responses.push(JSON.stringify(await tool(app.app, d.apiKey, "gmail.search", { query: "x" })));
    responses.push(JSON.stringify(await tool(app.app, d.apiKey, "gmail.get_attachment", { message_id: "g1", attachment_id: "none" })));
    responses.push(JSON.stringify(await tool(app.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000 })));
    responses.push((await app.app.inject({ method: "POST", url: "/v1/check", headers: { authorization: `Bearer ${d.apiKey}`, "content-type": "application/json" }, payload: JSON.stringify({ tool: "gmail.read_message", args: { message_id: "g1" } }) })).body);
    responses.push((await app.app.inject({ method: "GET", url: "/healthz" })).body);
    for (const r of responses) {
      expect(r).not.toContain("SECRET");
      expect(r).not.toContain("tokensEnc");
    }
    expect(JSON.parse(responses[0]!)).toMatchObject({ structuredContent: { gate: { decision: "allow" } } });

    // Zoho too, with the India data centre and org lookup.
    const z = (await internal(app.app, "POST", `/internal/orgs/${d.org.id}/connectors/zoho`, { action: "connect", mode: "live", actor: d.owner.email })).json();
    const zs = new URL(z.redirect).searchParams.get("state")!;
    expect(new URL(z.redirect).origin).toBe("https://accounts.zoho.in");
    await app.app.inject({ method: "GET", url: `/oauth/zoho/callback?code=abc&state=${encodeURIComponent(zs)}` });
    const zrow = await forOrg(d.org.id).connector.findFirstOrThrow({ where: { kind: "zoho" } });
    expect(zrow).toMatchObject({ mode: "live", accountLabel: "Acme Books", meta: { zoho_org_id: "60011" } });
    await app.app.close();
  });

  it("rejects forged, expired and mismatched OAuth state", async () => {
    const app = await liveApp();
    const d = await demoOrg(app.deps);
    const forged = hmacSign("b".repeat(64), { p: "oauth", o: d.org.id, k: "gmail", u: "x", x: Date.now() / 1000 + 600 });
    const expired = hmacSign(env.INTERNAL_API_SECRET, { p: "oauth", o: d.org.id, k: "gmail", u: "x", x: 1 });
    const wrongKind = hmacSign(env.INTERNAL_API_SECRET, { p: "oauth", o: d.org.id, k: "zoho", u: "x", x: Date.now() / 1000 + 600 });
    for (const s of [forged, expired, wrongKind]) {
      const r = await app.app.inject({ method: "GET", url: `/oauth/gmail/callback?code=abc&state=${encodeURIComponent(s)}` });
      expect(r.headers.location).toMatch(/error=link_expired/);
    }
    const good = hmacSign(env.INTERNAL_API_SECRET, { p: "oauth", o: d.org.id, k: "gmail", u: "x", x: Date.now() / 1000 + 600 });
    expect((await app.app.inject({ method: "GET", url: `/oauth/gmail/callback?error=access_denied&state=${encodeURIComponent(good)}` })).headers.location).toMatch(/error=denied/);
    expect((await app.app.inject({ method: "GET", url: "/oauth/slack/callback" })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/oauth/gmail/callback?code=x&state=${encodeURIComponent(good)}` })).headers.location).toMatch(/error=not_configured/);
    await app.app.close();
  });
});

describe("demo agent over real HTTP", () => {
  it("runs all five steps, waiting for a person on step 3", async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (ctx.app.server.address() as AddressInfo).port;
    const d = await demoOrg(ctx.deps);
    let approved = false;
    const steps = await runDemoAgent({
      url: `http://127.0.0.1:${port}/mcp`,
      apiKey: d.apiKey,
      waitForApproval: true,
      onApproval: (url) => {
        const id = url.split("/").pop()!;
        setTimeout(() => {
          void resolveApproval(ctx.deps, d.org.id, id, { userId: d.owner.id, email: d.owner.email, result: "approved" }).then(() => (approved = true));
        }, 300);
      },
    });
    expect(approved, JSON.stringify(steps)).toBe(true);
    expect(steps.map((s) => [s.step, s.decision, s.rule])).toEqual([
      [1, "allow", "read-mail"],
      [2, "allow", "pay-small"],
      [3, "ask", "pay-large"],
      [4, "refuse", "no-bank-change"],
      [5, "refuse", "default"],
    ]);
    expect(steps[2]!.detail).toMatch(/^approved · PAY-/);
    expect(mockState(d.org.id).payments.map((p) => p.amount_inr)).toEqual([18000, 200000]);
  });
});
