import { prisma } from "@gate/db";
import { afterAll, beforeEach, vi } from "vitest";
import { resetConsoleOrg, startGate } from "./console-gate";
import { billingCases } from "./console-wiring/billing";
import { makeHarness } from "./console-wiring/harness";
import { identityCases } from "./console-wiring/identity";
import { sovereignCases } from "./console-wiring/sovereign";
import { webhookCases } from "./console-wiring/webhooks";

// The console's billing, sovereign deployment, identity, webhook and chat-channel screens on the real backends
// (apps/web/src/server/console-overrides/wiring.ts). Each change goes through POST /api/console/rpc as a console
// screen sends it, lands in the real tables, and shows in GET /api/console/state. Only the session lookup is a
// stand-in; the gate runs in this process (console-gate.ts) and writes every receipt to the real chain.
const session = vi.hoisted(() => ({ userId: "u_rohan", lastAuthAt: new Date() }));

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("../src/server/session", () => ({
  CSRF_COOKIE: "gate_csrf",
  FRESH_AUTH_MS: 600_000,
  isFresh: (at: Date) => Date.now() - at.getTime() < 600_000,
  currentSession: async () => ({ id: `ses_test_${session.userId}`, userId: session.userId, csrfToken: "csrf-1", lastAuthAt: session.lastAuthAt }),
  currentCtx: async () => "no-org",
}));

const gate = await startGate();
const rpcRoute = await import("../src/app/api/console/rpc/route");
const stateRoute = await import("../src/app/api/console/state/route");
const consoleDomain = await import("../src/server/console-domain");
const { resetRateLimits } = await import("../src/server/ratelimit");

const h = makeHarness({
  session,
  gate,
  rpcPost: rpcRoute.POST,
  stateGet: stateRoute.GET,
  forget: consoleDomain.forgetConsoleMemory,
  stateFor: (orgId) => consoleDomain.stateFor(orgId),
  resetOrg: resetConsoleOrg,
});

beforeEach(() => {
  resetRateLimits();
  session.lastAuthAt = new Date();
});
afterAll(async () => {
  // the demo organisations as the seed left them, for the console test files after this one
  for (const orgId of ["org_demo", "org_northbank", "org_kaveri", "org_deccan"]) await h.reset(orgId);
  await gate.close();
  await prisma.$disconnect();
});

billingCases(h);
identityCases(h);
webhookCases(h);
sovereignCases(h);
