import { consoleState, prisma } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConsoleOrg, startGate } from "./console-gate";

// Operations screens used to run only in the browser (in-place writes, hidden op modules, state kept in
// localStorage), now run through the real RPC door: the built domain, Postgres, the route's CSRF and validation.
// Only the session lookup is a stand-in. Northbank (L2) is used so console.test.ts, which works on Demo Traders
// in parallel, never sees these writes.
const state = vi.hoisted(() => ({ userId: "u_nb_neha" }));

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("../src/server/session", () => ({
  CSRF_COOKIE: "gate_csrf",
  isFresh: () => true,
  currentSession: async () => ({ userId: state.userId, csrfToken: "csrf-1", lastAuthAt: new Date() }),
  currentCtx: async () => "no-org",
}));

// receipts are written by the real gate service, which these tests run in-process (see console-gate.ts)
const gateService = await startGate();
const rpcRoute = await import("../src/app/api/console/rpc/route");
const consoleDomain = await import("../src/server/console-domain");
const { resetRateLimits } = await import("../src/server/ratelimit");
const domain = await import("@gate/console/server");

const ORG = "org_northbank";
const OWNER = "u_rohan";
const ADMIN = "u_nb_neha";
const APPROVER = "u_nb_gaurav";
const VIEWER = "u_nb_pooja";

type Receipt = { seq: number; actor?: string; action?: string; details?: Record<string, unknown> };
type Doc = {
  receipts: Receipt[];
  members: { userId: string; slackLinked?: boolean }[];
  onboarding?: { step: number; company: { name: string }; updatedBy?: string };
  approvalsExt?: { delegations: { id: string; from: string; to: string; createdBy: string; revokedAt?: string }[] };
  keysExt?: { contact?: { name: string; email: string; setBy: string } };
  maintenance?: { windows: { id: string; startedEarly?: boolean; endedAt?: string; startedBy?: { userId: string; orgId: string; seq?: number } }[] };
};

async function rpc(op: string, args: unknown[], as = state.userId) {
  state.userId = as;
  const req = new NextRequest("http://localhost:3000/api/console/rpc", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-csrf-token": "csrf-1" }, body: JSON.stringify({ op, args }) });
  const res = await rpcRoute.POST(req, { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as { result?: unknown; version?: number; error?: string } };
}

const saved = async () => JSON.parse((await consoleState.load(ORG))!.json) as Doc;
const lastReceipt = (d: Doc, action: string) => d.receipts.findLast((r) => r.action === action);

/** The organisation as a fresh process (another web server, or this one after a restart) reads it. */
async function reloaded(): Promise<Doc> {
  await consoleDomain.forgetConsoleMemory();
  expect(domain.db.peekDB(ORG)).toBeUndefined();
  return (await consoleDomain.stateFor(ORG)).doc as unknown as Doc;
}

beforeAll(async () => {
  await consoleDomain.forgetConsoleMemory();
  await resetConsoleOrg(ORG);
});
afterAll(async () => {
  await gateService.close();
  await prisma.$disconnect();
});
beforeEach(() => {
  resetRateLimits();
  state.userId = ADMIN;
});

describe("operations that used to run only in the browser, through POST /api/console/rpc", () => {
  it("are in the manifest under the modules screens call", () => {
    const names = new Set(domain.opsManifest.ops.map((o) => o.name));
    for (const op of ["consoleOps.setSlackLinked", "consoleOps.saveOnboarding", "billing.requestDiscount", "approvalsExt.addDelegation", "keys.setContact", "maintenance.startMaintenanceNow", "maintenance.endMaintenance"]) expect(names).toContain(op);
    // a generic receipt writer is never an operation: any member could forge any admin receipt with it
    expect([...names].some((n) => n.endsWith(".recordChange") || n.endsWith(".registerTools"))).toBe(false);
  });

  it("links your own Slack account, as the signed-in member whoever the arguments name", async () => {
    // the viewer names the admin as the actor; the viewer's own member record is the one linked
    const r = await rpc("consoleOps.setSlackLinked", [ORG, true, ADMIN], VIEWER);
    expect(r.status, r.body.error).toBe(200);
    const d = await saved();
    expect(d.members.find((m) => m.userId === VIEWER)?.slackLinked).toBe(true);
    expect(d.members.find((m) => m.userId === ADMIN)?.slackLinked ?? false).not.toBe(true);
    expect(lastReceipt(d, "channel.slack_linked")).toMatchObject({ actor: VIEWER });
    // someone who is not a member of the organisation is refused at the door
    expect((await rpc("consoleOps.setSlackLinked", [ORG, true, ADMIN], "u_ananya")).status).toBe(403);
    expect((await reloaded()).members.find((m) => m.userId === VIEWER)?.slackLinked).toBe(true);
  });

  it("saves set-up progress for owners and admins only", async () => {
    const progress = { v: 2, step: 3, maxStep: 3, company: { name: "Northbank (from set-up)", legal: "", size: "51–250" }, level: "l2", industry: "general", regions: ["India"], packs: [], invites: [] };
    const refused = await rpc("consoleOps.saveOnboarding", [ORG, progress, ADMIN], VIEWER);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/owners and admins can do this/i);
    expect((await saved()).onboarding?.step).toBeUndefined();

    const ok = await rpc("consoleOps.saveOnboarding", [ORG, progress, OWNER], ADMIN);
    expect(ok.status, ok.body.error).toBe(200);
    expect((await saved()).onboarding).toMatchObject({ step: 3, company: { name: "Northbank (from set-up)" }, updatedBy: ADMIN });
    // an older shape is refused rather than saved over the current one
    expect((await rpc("consoleOps.saveOnboarding", [ORG, { ...progress, v: 1 }, ADMIN])).status).toBe(400);
    expect((await reloaded()).onboarding).toMatchObject({ step: 3, updatedBy: ADMIN });
  });

  it("asks elan1 for a discount as an owner only (billing)", async () => {
    const input = { pct: 12, months: 6, reason: "Renewal with a second business unit joining" };
    for (const who of [ADMIN, VIEWER]) {
      const r = await rpc("billing.requestDiscount", [ORG, OWNER, input], who);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/owner/i);
    }
    const ok = await rpc("billing.requestDiscount", [ORG, ADMIN, input], OWNER);
    expect(ok.status, ok.body.error).toBe(200);
    const asked = lastReceipt(await saved(), "billing.discount_requested");
    expect(asked).toMatchObject({ actor: OWNER, details: { pct: 12, months: 6 } });
    // one request with elan1 at a time: the second is refused because the first is stored
    expect((await rpc("billing.requestDiscount", [ORG, OWNER, input], OWNER)).status).toBe(400);
    expect(lastReceipt(await reloaded(), "billing.discount_requested")?.seq).toBe(asked!.seq);
  });

  it("sets up a delegation: your own, or anyone's as an owner or admin (approvals)", async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
    // a viewer decides no approvals, and may not delegate someone else's
    const viewer = await rpc("approvalsExt.addDelegation", [ORG, { from: APPROVER, to: ADMIN, until, reason: "On leave this week" }, ADMIN], VIEWER);
    expect(viewer.status).toBe(400);
    // an approver may delegate only their own approvals
    const other = await rpc("approvalsExt.addDelegation", [ORG, { from: ADMIN, to: OWNER, until, reason: "On leave this week" }, OWNER], APPROVER);
    expect(other.status).toBe(400);
    expect(other.body.error).toMatch(/delegate your own/i);

    const ok = await rpc("approvalsExt.addDelegation", [ORG, { from: APPROVER, to: "u_nb_imran", until, reason: "On leave this week" }, OWNER], APPROVER);
    expect(ok.status, ok.body.error).toBe(200);
    const id = (ok.body.result as { id: string }).id;
    expect((await saved()).approvalsExt?.delegations.find((x) => x.id === id)).toMatchObject({ from: APPROVER, to: "u_nb_imran", createdBy: APPROVER });
    expect((await reloaded()).approvalsExt?.delegations.find((x) => x.id === id)).toMatchObject({ createdBy: APPROVER });
    // and revoking it is the same kind of operation
    const off = await rpc("approvalsExt.revokeDelegation", [ORG, id, APPROVER], ADMIN);
    expect(off.status, off.body.error).toBe(200);
    expect((await saved()).approvalsExt?.delegations.find((x) => x.id === id)?.revokedAt).toBeTruthy();
  });

  it("names the contact for key notices as an owner or admin (keys)", async () => {
    const contact = { name: "Neha Bhatia", email: "neha.bhatia@northbank.co.in", role: "Head of Digital Operations" };
    for (const who of [VIEWER, APPROVER]) expect((await rpc("keys.setContact", [ORG, ADMIN, contact], who)).status).toBe(400);
    const ok = await rpc("keys.setContact", [ORG, OWNER, contact], ADMIN);
    expect(ok.status, ok.body.error).toBe(200);
    expect((await saved()).keysExt?.contact).toMatchObject({ email: contact.email, setBy: ADMIN });
    expect(lastReceipt(await saved(), "key.contact_set")).toMatchObject({ actor: ADMIN });
    // the read is pure; settling the key switch is its own (idempotent) operation
    expect((await rpc("keys.settle", [ORG])).status).toBe(200);
    const read = await rpc("keys.state", [ORG], VIEWER);
    expect(read.status, read.body.error).toBe(200);
    expect((read.body.result as { contact?: { email: string } }).contact?.email).toBe(contact.email);
    expect((await reloaded()).keysExt?.contact).toMatchObject({ setBy: ADMIN });
  });

  it("opens and ends a demonstration maintenance window for this organisation, owners only", async () => {
    for (const who of [ADMIN, VIEWER]) {
      const r = await rpc("maintenance.startMaintenanceNow", [ORG, OWNER], who);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/only an owner/i);
    }
    const ok = await rpc("maintenance.startMaintenanceNow", [ORG, ADMIN], OWNER);
    expect(ok.status, ok.body.error).toBe(200);
    const w = ok.body.result as { id: string; startedEarly: boolean };
    expect(w.startedEarly).toBe(true);
    // the window is kept in the organisation's own document, not in one process's memory or storage
    const doc = await reloaded();
    expect(doc.maintenance?.windows.find((x) => x.id === w.id)).toMatchObject({ startedEarly: true, startedBy: { userId: OWNER, orgId: ORG } });
    const open = await rpc("maintenance.activeMaintenance", [ORG], VIEWER);
    expect(open.status, open.body.error).toBe(200);
    expect((open.body.result as { id: string } | null)?.id).toBe(w.id);

    expect((await rpc("maintenance.endMaintenance", [ORG, OWNER], ADMIN)).status).toBe(400);
    const end = await rpc("maintenance.endMaintenance", [ORG, ADMIN], OWNER);
    expect(end.status, end.body.error).toBe(200);
    expect((await reloaded()).maintenance?.windows.find((x) => x.id === w.id)?.endedAt).toBeTruthy();
    expect((await rpc("maintenance.activeMaintenance", [ORG], VIEWER)).body.result ?? null).toBeNull();
  });
});
