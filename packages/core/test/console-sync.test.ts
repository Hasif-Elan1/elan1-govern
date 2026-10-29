import { describe, expect, it } from "vitest";
import { AGENT_KEY_RE, attachIssuedKey, guardSyncChanges, guardSyncPayload, inForceVersion, issuedSecret, type ConsoleDocView, type ConsoleDomainFacts } from "../src/console-sync";
import { hashToken } from "../src/crypto";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function doc(): ConsoleDocView {
  return {
    agents: [
      {
        id: "ag_invoice",
        slug: "invoice-bot",
        name: "Invoice bot",
        description: "Pays invoices.",
        ownerId: "u_rahul",
        riskLevel: "high",
        status: "active",
        tools: ["gmail.send_email", "zoho_books.record_payment"],
        keys: [
          { id: "key_a", prefix: "sk_sbx_ab12c", label: "Sandbox", environment: "sandbox", expiresAt: ago(-48), revokeAt: ago(-2) },
          { id: "key_b", prefix: "gk_7Kq2", label: "Old", environment: "production", revoked: true },
        ],
      },
      { id: "ag_hr", slug: "hr-screening", name: "HR", ownerId: "u_fatima", riskLevel: "extreme", status: "paused" },
    ],
    rulebooks: [
      {
        id: "rb_invoice",
        agentId: "ag_invoice",
        versions: [
          { version: 6, status: "published", hash: "h6", signedAt: ago(48), signedBy: "u_rahul", rules: [{ id: "x", match: { tool: "zoho_books.record_payment" }, when: [{ field: "amount", op: "gt", value: 1 }], decide: "ask", reason: "" }] },
          { version: 7, status: "published", hash: "h7", signedAt: ago(24), signedBy: "u_ananya", rules: [{ id: "y", match: { tool: "gmail.send_email" }, unless: [{ field: "to", op: "to_domain_in", value: ["a.in"] }], decide: "ask", reason: "" }] },
          { version: 8, status: "draft", hash: "h8", rules: [{ id: "z", match: { tool: "zoho_books.record_payment" }, when: [{ field: "vendor", op: "eq", value: "n" }], decide: "allow", reason: "" }] },
        ],
      },
      { id: "rb_hr", agentId: "ag_hr", versions: [{ version: 1, status: "draft", hash: "d1" }] },
    ],
    connectors: [
      { id: "con_gmail", name: "Gmail — ap@demotraders.in", mode: "demo", tools: [{ name: "gmail.send_email", enabled: true }] },
      { id: "con_zoho", name: "Zoho Books", mode: "live", url: "https://zoho.example/mcp", tools: [{ name: "zoho_books.record_payment", description: "Pay", enabled: false }] },
    ],
    stop: { active: false },
    approvals: [
      { id: "apr_real", status: "pending", approverGroup: "Finance", expiresAt: ago(-4), source: "guard" },
      { id: "apr_mock", status: "pending", approverGroup: "Finance", expiresAt: ago(-4) },
    ],
  };
}

const facts: ConsoleDomainFacts = {
  groups: [{ id: "finance", name: "Finance", members: ["u_venkat", "u_tom"] }],
  tools: [
    { name: "gmail.send_email", description: "Send", tags: ["sends_external"], connector: "con_gmail" },
    { name: "zoho_books.record_payment", tags: ["moves_money", "nonsense"], connector: "con_zoho" },
    { name: "bank.get_balance", tags: ["reads_data"], connector: "con_bank" },
  ],
  lists: { approved_vendors: ["northwind"] },
  allowedApprovers: (id) => (id === "apr_real" ? ["u_venkat", "u_tom"] : []),
};

describe("guardSyncPayload", () => {
  const p = guardSyncPayload(doc(), facts, NOW);

  it("lists agents with whether the guard lets them act", () => {
    expect(p.agents).toEqual([
      { id: "ag_invoice", slug: "invoice-bot", name: "Invoice bot", description: "Pays invoices.", ownerId: "u_rahul", riskLevel: "high", active: true, stopped: false, tools: ["gmail.send_email", "zoho_books.record_payment"] },
      // an unknown risk level is treated as high
      { id: "ag_hr", slug: "hr-screening", name: "HR", description: "", ownerId: "u_fatima", riskLevel: "high", active: false, stopped: false, tools: [] },
    ]);
  });

  it("lists keys with the moment they stop working (the earlier of expiry and rotation grace)", () => {
    expect(p.keys).toEqual([
      { id: "key_a", agentId: "ag_invoice", prefix: "sk_sbx_ab12c", label: "Sandbox", environment: "sandbox", expiresAt: ago(-2), revoked: false },
      { id: "key_b", agentId: "ag_invoice", prefix: "gk_7Kq2", label: "Old", environment: "production", revoked: true },
    ]);
  });

  it("lists every tool with its connector, tags, switch and the fields rules look at", () => {
    expect(p.tools).toEqual([
      { name: "gmail.send_email", connectorId: "con_gmail", connectorName: "Gmail — ap@demotraders.in", demo: true, description: "Send", tags: ["sends_external"], enabled: true, fields: ["to"] },
      { name: "zoho_books.record_payment", connectorId: "con_zoho", connectorName: "Zoho Books", connectorUrl: "https://zoho.example/mcp", demo: false, description: "Pay", tags: ["moves_money"], enabled: false, fields: ["amount", "vendor"] },
      // a catalogue tool on no connector: not switched off, answered as a demo
      { name: "bank.get_balance", connectorId: "con_bank", connectorName: "bank", demo: true, description: "", tags: ["reads_data"], enabled: true, fields: [] },
    ]);
  });

  it("sends the version in force of each rulebook, or none", () => {
    expect(p.rulebooks).toEqual([
      { id: "rb_invoice", agentId: "ag_invoice", version: 7, hash: "h7", signedBy: "u_ananya", rules: doc().rulebooks[0]!.versions[1]!.rules },
      { id: "rb_hr", agentId: "ag_hr", version: null, hash: null, rules: [] },
    ]);
  });

  it("sends only the approvals the guard holds, with who may decide them now", () => {
    expect(p.approvals).toEqual([{ id: "apr_real", status: "pending", approverGroup: "Finance", allowed: ["u_venkat", "u_tom"], expiresAt: ago(-4) }]);
    expect(p.groups).toEqual(facts.groups);
    expect(p.lists).toEqual(facts.lists);
    expect(p.stop).toEqual({ active: false });
  });

  it("pauses the agents an emergency stop covers: all of them, or the ones it names", () => {
    const all = guardSyncPayload({ ...doc(), stop: { active: true, reason: "Fraud", by: "u_ananya", since: ago(1), scope: "all_agents" } }, facts, NOW);
    expect(all.agents.map((a) => [a.active, a.stopped])).toEqual([[false, true], [false, true]]);
    expect(all.stop).toEqual({ active: true, reason: "Fraud", by: "u_ananya", since: ago(1) });
    const some = guardSyncPayload({ ...doc(), stop: { active: true, scope: "selected_agents", agentSlugs: ["hr-screening"] } }, facts, NOW);
    expect(some.agents.map((a) => a.active)).toEqual([true, false]);
    expect(some.stop).toEqual({ active: true, agentSlugs: ["hr-screening"] });
  });

  it("copes with a document saved before stops and approvals existed", () => {
    const { stop: _s, approvals: _a, ...old } = doc();
    const p2 = guardSyncPayload(old, facts, NOW);
    expect(p2.stop).toEqual({ active: false });
    expect(p2.approvals).toEqual([]);
  });

  it("reports a decided, overridden approval with who decided it", () => {
    const d = doc();
    d.approvals![0] = { ...d.approvals![0]!, status: "approved", decidedBy: "u_ananya", decisionReason: "ok", channel: "web", override: { by: "u_ananya" } };
    expect(guardSyncPayload(d, facts, NOW).approvals[0]).toMatchObject({ status: "approved", decidedBy: "u_ananya", decisionReason: "ok", channel: "web", override: true });
  });
});

describe("inForceVersion", () => {
  it("is the last signed, published version not withdrawn by now", () => {
    const v = doc().rulebooks[0]!.versions;
    expect(inForceVersion(v, NOW)?.version).toBe(7);
    expect(inForceVersion([{ ...v[0]! }, { ...v[1]!, withdrawn: { at: ago(1) } }], NOW)?.version).toBe(6);
    // a withdrawal later than now does not count yet; a version signed in the future does not either
    expect(inForceVersion([{ ...v[1]!, withdrawn: { at: ago(-1) } }], NOW)?.version).toBe(7);
    expect(inForceVersion([{ ...v[1]!, signedAt: ago(-1) }], NOW)).toBeUndefined();
    expect(inForceVersion([{ ...v[1]!, signedAt: undefined }], NOW)).toBeUndefined();
  });
});

describe("guardSyncChanges", () => {
  const before = guardSyncPayload(doc(), facts, NOW);
  it("is empty for a first save", () => {
    expect(guardSyncChanges(undefined, before)).toEqual({ rulebooks: [], keys: [], agents: [], approvals: [], stop: false });
    expect(guardSyncChanges(before, before)).toEqual({ rulebooks: [], keys: [], agents: [], approvals: [], stop: false });
  });

  it("names what an operation changed", () => {
    const d = doc();
    d.rulebooks[0]!.versions[2] = { ...d.rulebooks[0]!.versions[2]!, status: "published", signedAt: ago(0.5) };
    d.agents[0]!.keys!.push({ id: "key_new", prefix: "sk_sbx_99aa1", label: "New", environment: "sandbox" });
    d.agents[0]!.keys![0]!.revoked = true;
    d.agents[1]!.status = "active";
    d.approvals![0]!.status = "approved";
    d.stop = { active: true };
    const after = guardSyncPayload(d, facts, NOW);
    attachIssuedKey(after, before, "sk_sbx_99aa1bb22cc33dd44ee55ff66aa77bb88cc");
    // hr-screening is resumed, but the stop covers it: to the guard it is still paused
    expect(guardSyncChanges(before, after)).toEqual({ rulebooks: ["rb_invoice"], keys: ["key_a", "key_new"], agents: ["ag_invoice"], approvals: ["apr_real"], stop: true });
    // an agent removed in the console is a change too
    expect(guardSyncChanges(before, { ...before, agents: before.agents.slice(0, 1) }).agents).toEqual(["ag_hr"]);
  });
});

describe("issued keys", () => {
  it("finds the secret an operation hands back, in the formats agents use", () => {
    expect(issuedSecret({ secret: "sk_sbx_" + "a".repeat(36) })).toBe("sk_sbx_" + "a".repeat(36));
    expect(issuedSecret({ secret: "gk_" + "b".repeat(43) })).toBe("gk_" + "b".repeat(43));
    expect(issuedSecret({ secret: "short" })).toBeUndefined();
    expect(issuedSecret({ secret: 5 })).toBeUndefined();
    expect(issuedSecret("sk_sbx_" + "a".repeat(36))).toBeUndefined();
    expect(issuedSecret(null)).toBeUndefined();
    expect(AGENT_KEY_RE.test("sk_live_" + "a".repeat(36))).toBe(false);
  });

  it("attaches the secret's hash only to a new key it starts with", () => {
    const before = guardSyncPayload(doc(), facts, NOW);
    const d = doc();
    d.agents[0]!.keys!.unshift({ id: "key_new", prefix: "sk_sbx_99aa1", label: "New", environment: "sandbox" });
    const after = guardSyncPayload(d, facts, NOW);
    const secret = "sk_sbx_99aa1" + "c".repeat(31);
    expect(attachIssuedKey(after, before, "sk_sbx_00000" + "c".repeat(31))).toBeUndefined();
    expect(attachIssuedKey(after, before, secret)).toBe("key_new");
    expect(after.keys[0]!.keyHash).toBe(hashToken(secret));
    // the hash is all that is attached: the secret is nowhere in the message
    expect(JSON.stringify(after)).not.toContain(secret);
    // without a document before, any key the secret starts with may be the new one
    const fresh = guardSyncPayload(d, facts, NOW);
    expect(attachIssuedKey(fresh, undefined, secret)).toBe("key_new");
  });
});
