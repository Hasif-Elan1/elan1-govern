import { forOrg, prisma } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaySummary } from "../src/lib/replay";
import type { Role } from "../src/server/policy";

// The route runs for real (rate limit, CSRF, permission, validation, database); only the
// session lookup and the signed call to the gate service are stand-ins.
const state = vi.hoisted(() => ({ role: "owner" as string, orgId: "", calls: [] as { path: string; body: unknown }[], reply: { status: 200, data: {} as Record<string, unknown> } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("../src/server/session", () => ({
  CSRF_COOKIE: "gate_csrf",
  isFresh: () => true,
  currentSession: async () => ({ userId: "u1", csrfToken: "csrf-1", lastAuthAt: new Date() }),
  currentCtx: async () => ({
    user: { id: "u1", email: "owner@test.in", name: "O", totpEnabled: false },
    session: { id: "s1", csrfToken: "csrf-1", lastAuthAt: new Date() },
    org: { id: state.orgId, name: "Replay Co" },
    role: state.role as Role,
    memberships: [],
  }),
}));
vi.mock("../src/server/gate", () => ({
  gate: async (_method: string, path: string, body: unknown) => {
    state.calls.push({ path, body });
    return state.reply;
  },
}));

const { POST } = await import("../src/app/api/rulebooks/[slug]/replay/route");
const settings = await import("../src/app/api/settings/route");
const { resetRateLimits } = await import("../src/server/ratelimit");

let agentId = "";
beforeAll(async () => {
  const org = await prisma.org.create({ data: { name: "Replay Co", publicKey: "x", privateKeyEnc: "x" } });
  state.orgId = org.id;
  agentId = (await forOrg(org.id).agent.create({ data: { orgId: org.id, slug: "ap-bot", name: "AP", purpose: "p", ownerEmail: "owner@test.in" } })).id;
});
afterAll(() => prisma.$disconnect());
beforeEach(() => {
  resetRateLimits();
  state.calls = [];
  state.role = "owner";
  state.reply = { status: 200, data: { total: 3, changed: 1 } };
});

function post(path: string, body: unknown, method = "POST") {
  return new NextRequest(`http://localhost:3000${path}`, { method, headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-csrf-token": "csrf-1" }, body: JSON.stringify(body) });
}
const replay = (body: unknown, slug = "ap-bot") => POST(post(`/api/rulebooks/${slug}/replay`, body), { params: Promise.resolve({ slug }) });

describe("POST /api/rulebooks/:slug/replay", () => {
  it("sends the draft to the gate service for this org's agent", async () => {
    const res = await replay({ yaml: "rules: []", days: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 3, changed: 1 });
    expect(state.calls).toEqual([{ path: `/internal/orgs/${state.orgId}/agents/${agentId}/replay`, body: { yaml: "rules: []", days: 7, actor: "owner@test.in" } }]);
    // 30 days unless asked.
    await replay({ yaml: "rules: []" });
    expect(state.calls[1]!.body).toMatchObject({ days: 30 });
  });

  for (const role of ["viewer", "approver", "auditor"]) {
    it(`refuses a ${role}`, async () => {
      state.role = role;
      expect((await replay({ yaml: "rules: []" })).status).toBe(403);
      expect(state.calls).toEqual([]);
    });
  }
  it("lets an admin run it", async () => {
    state.role = "admin";
    expect((await replay({ yaml: "rules: []" })).status).toBe(200);
  });

  it("validates the period, the agent, and passes the gate's errors on", async () => {
    expect((await replay({ yaml: "rules: []", days: 14 })).status).toBe(400);
    expect((await replay({ yaml: "" })).status).toBe(400);
    expect((await replay({ yaml: "rules: []" }, "nobody")).status).toBe(404);
    state.reply = { status: 422, data: { error: "rules.0: unknown tool", errors: ["rules.0: unknown tool"] } };
    const bad = await replay({ yaml: "rules: []" });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "rules.0: unknown tool", errors: ["rules.0: unknown tool"] });
    state.reply = { status: 429, data: { error: "Too many tests in a minute. Try again shortly." } };
    expect((await replay({ yaml: "rules: []" })).status).toBe(429);
    state.reply = { status: 500, data: {} };
    expect((await replay({ yaml: "rules: []" })).status).toBe(502);
  });

  it("limits runs per organisation", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await replay({ yaml: "rules: []" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("PATCH /api/settings replayStore", () => {
  const patch = (body: unknown) => settings.PATCH(post("/api/settings", body, "PATCH"), { params: Promise.resolve({}) });

  it("switching it off deletes every stored call of the org, and only that org", async () => {
    const other = await prisma.org.create({ data: { name: "Other", publicKey: "x", privateKeyEnc: "x" } });
    const row = (orgId: string, seq: number) => ({ orgId, agentId, seq, tool: "gmail.read_message", decision: "allow", ruleId: "r", argsEnc: "v1.x.y.z" });
    await forOrg(state.orgId).replayCall.createMany({ data: [row(state.orgId, 1), row(state.orgId, 2)] });
    await forOrg(other.id).replayCall.create({ data: row(other.id, 1) });
    state.role = "viewer";
    expect((await patch({ replayStore: false })).status).toBe(403);
    expect(await forOrg(state.orgId).replayCall.count()).toBe(2);
    state.role = "owner";
    expect((await patch({ replayStore: false })).status).toBe(200);
    expect(await forOrg(state.orgId).replayCall.count()).toBe(0);
    expect(await forOrg(other.id).replayCall.count()).toBe(1);
    expect((await forOrg(state.orgId).org.findFirstOrThrow()).replayStore).toBe(false);
    expect(state.calls.at(-1)).toMatchObject({ body: { action: "settings.updated", details: { replayStore: false } } });
    expect((await patch({ replayStore: true })).status).toBe(200);
    expect((await forOrg(state.orgId).org.findFirstOrThrow()).replayStore).toBe(true);
  });
});

describe("replay summary", () => {
  const counts = (o: Partial<Record<"allow" | "ask" | "refuse", number>> = {}) => ({ allow: 0, ask: 0, refuse: 0, ...o });
  it("says what would change in one sentence", () => {
    expect(replaySummary({ total: 412, judged: 409, notJudged: 3, changed: 47, more: counts({ refuse: 12, ask: 30, allow: 5 }), fewer: counts({ ask: 5, allow: 42 }) })).toBe(
      "Of 412 calls, 12 more would be refused, 30 more would ask a person, 5 fewer would ask a person, 5 more would be allowed and 42 fewer would be allowed. 3 could not be judged.",
    );
    expect(replaySummary({ total: 1, judged: 1, notJudged: 0, changed: 0, more: counts(), fewer: counts() })).toBe("Of 1 call, none would change.");
    expect(replaySummary({ total: 2, judged: 1, notJudged: 1, changed: 1, more: counts({ refuse: 1 }), fewer: counts({ allow: 1 }) })).toBe("Of 2 calls, 1 more would be refused and 1 fewer would be allowed. 1 could not be judged.");
    expect(replaySummary({ total: 5, judged: 0, notJudged: 5, changed: 0, more: counts(), fewer: counts() })).toBe("Of 5 calls, none could be judged.");
    expect(replaySummary({ total: 0, judged: 0, notJudged: 0, changed: 0, more: counts(), fewer: counts() })).toBe("No calls in this period.");
  });
});

