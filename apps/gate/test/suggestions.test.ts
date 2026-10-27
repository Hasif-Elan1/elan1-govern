import { parseRulebookYaml, verifyChain } from "@gate/core";
import { forOrg } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoRulebookYaml, publishRulebook } from "../src/admin";
import { addDemoHistory, DEMO_HISTORY_NOTE } from "../src/demo/history";
import { findAllSuggestions, findSuggestions } from "../src/suggestions";
import { demoOrg, internal, makeApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(() => ctx.app.close());

async function withHistory() {
  const d = await demoOrg(ctx.deps);
  const r = await addDemoHistory(ctx.deps, d.org.id, d.owner.email);
  return { ...d, ...r };
}

const call = (orgId: string, path: string, body: Record<string, unknown>) => internal(ctx.app, "POST", `/internal/orgs/${orgId}${path}`, body);

describe("rule suggestions in the gate service", () => {
  it("the demo history yields one suggestion: raise the payment line to ₹1,00,000", async () => {
    const d = await withHistory();
    expect(d.added).toBe(43);
    expect(d.suggestions).toBe(1);
    const [s, ...rest] = await d.db.ruleSuggestion.findMany();
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ kind: "raise_limit", ruleId: "pay-large", tool: "zoho.record_bill_payment", status: "new", covered: 41, baseVersion: 1, savedPerMonth: expect.any(Number) });
    expect(s!.title).toBe("Raise the no-approval limit for payments from ₹50,000 to ₹1,00,000");
    const draft = parseRulebookYaml(s!.draftYaml);
    expect(draft.ok && draft.rulebook.rules.find((r) => r.id === "pay-small")?.when).toEqual({ amount_inr: { lte: 100000 } });
    expect(s!.draftYaml).not.toContain("signature");
    // One honest receipt says demo history was loaded; the chain still verifies.
    const receipts = await d.db.receipt.findMany({ orderBy: { seq: "asc" } });
    expect(receipts.filter((r) => r.action === "demo.history_added")).toHaveLength(1);
    expect(verifyChain(receipts.map((r) => r.body), (await d.db.orgKey.findFirstOrThrow()).publicKey).ok).toBe(true);
    // Running it again adds nothing.
    expect(await addDemoHistory(ctx.deps, d.org.id, d.owner.email)).toEqual({ added: 0, suggestions: 1 });
    expect(await d.db.approval.count({ where: { note: DEMO_HISTORY_NOTE } })).toBe(43);
  });

  it("dedupes across runs and drops suggestions the evidence no longer supports", async () => {
    const d = await withHistory();
    const again = await findSuggestions(ctx.deps, d.org.id);
    expect(again).toMatchObject({ agents: 1, created: 0, updated: 1, removed: 0, open: 1 });
    // The rulebook moves on (someone raised the line by hand): the suggestion no longer applies.
    const yaml = demoRulebookYaml(d.owner.email, [d.owner.email]).replace("lte: 50000", "lte: 100000").replace("gt: 50000", "gt: 100000");
    expect((await publishRulebook(ctx.deps, d.org.id, d.agentId, yaml, d.owner.email)).ok).toBe(true);
    expect(await findSuggestions(ctx.deps, d.org.id)).toMatchObject({ created: 0, removed: 1, open: 0 });
  });

  it("applying opens a draft: the suggestion is marked and receipted, but nothing is published", async () => {
    const d = await withHistory();
    const s = await d.db.ruleSuggestion.findFirstOrThrow();
    const before = await d.db.rulebook.count();
    const res = await call(d.org.id, `/suggestions/${s.id}/apply`, { actor: d.owner.email });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, agent: "ap-bot", id: s.id });
    expect(await d.db.rulebook.count()).toBe(before);
    expect((await d.db.agent.findFirstOrThrow()).activeRulebookId).toBe((await d.db.rulebook.findFirstOrThrow({ where: { version: 1 } })).id);
    expect(await d.db.ruleSuggestion.findFirstOrThrow({ where: { id: s.id } })).toMatchObject({ status: "applied", decidedBy: d.owner.email });
    const receipt = await d.db.receipt.findFirstOrThrow({ where: { action: "suggestion.applied" } });
    expect(receipt.body).toMatchObject({ kind: "admin", agent: "ap-bot", actor: d.owner.email, details: { suggestion: s.id, kind: "raise_limit", rule: "pay-large", base_version: 1, approvals: 41 } });
    // Opening it again only loads the draft; no second receipt. Dismissing it now is refused.
    expect((await call(d.org.id, `/suggestions/${s.id}/apply`, { actor: d.owner.email })).statusCode).toBe(200);
    expect(await d.db.receipt.count({ where: { action: "suggestion.applied" } })).toBe(1);
    expect((await call(d.org.id, `/suggestions/${s.id}/dismiss`, { actor: d.owner.email })).statusCode).toBe(409);
    // An applied suggestion stays applied on the next run.
    await findSuggestions(ctx.deps, d.org.id);
    expect((await d.db.ruleSuggestion.findFirstOrThrow({ where: { id: s.id } })).status).toBe("applied");
  });

  it("refuses to open a draft made from an older rulebook", async () => {
    const d = await withHistory();
    const s = await d.db.ruleSuggestion.findFirstOrThrow();
    const yaml = demoRulebookYaml(d.owner.email, [d.owner.email]).replace("expires_in: 24h", "expires_in: 4h");
    expect((await publishRulebook(ctx.deps, d.org.id, d.agentId, yaml, d.owner.email)).ok).toBe(true);
    const res = await call(d.org.id, `/suggestions/${s.id}/apply`, { actor: d.owner.email });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/rulebook has changed/);
    // The next run redrafts it from version 2.
    await findSuggestions(ctx.deps, d.org.id);
    expect(await d.db.ruleSuggestion.findFirstOrThrow({ where: { status: "new" } })).toMatchObject({ baseVersion: 2 });
  });

  it("a dismissal sticks until the evidence has at least doubled", async () => {
    const d = await withHistory();
    const s = await d.db.ruleSuggestion.findFirstOrThrow();
    const res = await call(d.org.id, `/suggestions/${s.id}/dismiss`, { actor: d.owner.email });
    expect(res.statusCode).toBe(200);
    expect(await d.db.receipt.count({ where: { action: "suggestion.dismissed" } })).toBe(1);
    expect((await call(d.org.id, `/suggestions/${s.id}/dismiss`, { actor: d.owner.email })).statusCode).toBe(409);
    expect((await call(d.org.id, `/suggestions/${s.id}/apply`, { actor: d.owner.email })).json().error).toMatch(/dismissed/);
    expect(await findSuggestions(ctx.deps, d.org.id)).toMatchObject({ created: 0, open: 0 });
    expect((await d.db.ruleSuggestion.findFirstOrThrow()).status).toBe("dismissed");

    // Twenty more approvals is not enough; forty-one more is.
    const held = await d.db.approval.findFirstOrThrow({ where: { note: DEMO_HISTORY_NOTE } });
    const more = (n: number, from: number) =>
      d.db.approval.createMany({
        data: Array.from({ length: n }, (_, i) => {
          const createdAt = new Date(Date.now() - (2 + ((from + i) % 25)) * 86_400_000);
          const { id: _id, createdAt: _c, resolvedAt: _r, argsSummary: _a, evidence: _e, result: _res, ...rest } = held;
          return { ...rest, argsSummary: { bill_id: `bill_m${from + i}`, amount_inr: 60000, vendor: "Sharma Traders" }, createdAt, resolvedAt: new Date(createdAt.getTime() + 3_600_000) };
        }),
      });
    await more(20, 0);
    expect(await findSuggestions(ctx.deps, d.org.id)).toMatchObject({ open: 0 });
    await more(21, 20);
    expect(await findSuggestions(ctx.deps, d.org.id)).toMatchObject({ updated: 1, open: 1 });
    expect(await d.db.ruleSuggestion.findFirstOrThrow()).toMatchObject({ id: s.id, status: "new", covered: 82, decidedBy: null });
  });

  it("keeps each org's suggestions to itself", async () => {
    const a = await withHistory();
    const b = await demoOrg(ctx.deps);
    const s = await a.db.ruleSuggestion.findFirstOrThrow();
    expect((await call(b.org.id, `/suggestions/${s.id}/apply`, { actor: b.owner.email })).statusCode).toBe(404);
    expect((await call(b.org.id, `/suggestions/${s.id}/dismiss`, { actor: b.owner.email })).statusCode).toBe(404);
    expect(await forOrg(b.org.id).ruleSuggestion.count()).toBe(0);
    const run = await call(b.org.id, "/suggestions/run", { actor: b.owner.email, agentId: b.agentId });
    expect(run.json()).toMatchObject({ agents: 1, created: 0, open: 0 });
    expect((await a.db.ruleSuggestion.findFirstOrThrow({ where: { id: s.id } })).status).toBe("new");
    // The nightly job covers every org and counts open suggestions.
    expect(await findAllSuggestions(ctx.deps)).toBeGreaterThanOrEqual(1);
  });

  it("the on-demand and dev routes validate their input", async () => {
    const d = await demoOrg(ctx.deps);
    expect((await call(d.org.id, "/suggestions/run", {})).statusCode).toBe(400);
    expect((await call(d.org.id, "/suggestions/nope/apply", { actor: d.owner.email })).statusCode).toBe(404);
    expect((await call(d.org.id, "/suggestions/nope/publish", { actor: d.owner.email })).statusCode).toBe(400);
    const h = await call(d.org.id, "/demo/history", { actor: d.owner.email });
    expect(h.json()).toEqual({ added: 43, suggestions: 1 });
  });
});
