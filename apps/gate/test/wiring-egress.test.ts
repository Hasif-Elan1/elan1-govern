import { randomBytes } from "node:crypto";
import { forOrg, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoOrg, env, internal, makeApp } from "./helpers";

// The console's Sovereign screens on the real egress rules and update records (src/wiring/egress.ts). The whole
// journey through the console is apps/web/test/console-wiring/sovereign.ts; here, the routes on their own. Update
// records are platform-wide (updates.test.ts imports and applies them), so only refusals that touch none are run.

let ctx: Awaited<ReturnType<typeof makeApp>>;
let orgId = "";
const ACTOR = "u_wiring_admin";

beforeAll(async () => {
  // without an update folder, whatever this machine's .env says
  ctx = await makeApp({ env: { ...env, UPDATE_IMPORT_DIR: undefined } });
  orgId = (await demoOrg(ctx.deps)).org.id;
});
afterAll(async () => {
  await ctx.app.close();
  await prisma.$disconnect();
});

const post = (path: string, body: unknown) => internal(ctx.app, "POST", `/internal/orgs/${orgId}/wiring/${path}`, body);

describe("wiring: the internal allow-list, the egress-log export and update bundles", () => {
  it("is signed like every internal route, for an organisation the gate holds", async () => {
    const bad = await ctx.app.inject({ method: "POST", url: `/internal/orgs/${orgId}/wiring/egress/export`, headers: { "content-type": "application/json", "x-gate-signature": "t=1,v1=00" }, payload: "{}" });
    expect(bad.statusCode).toBe(401);
    expect((await internal(ctx.app, "POST", "/internal/orgs/org_nobody_here/wiring/egress/hosts", { actor: ACTOR, host: "siem.bank.internal" })).statusCode).toBe(404);
    expect((await post("egress/hosts", { actor: "not an id!", host: "siem.bank.internal" })).statusCode).toBe(400);
  });

  it("adds an internal host with the console's purpose as its note, and removes every rule for it", async () => {
    const host = `siem-${randomBytes(3).toString("hex")}.bank.internal`;
    const added = await post("egress/hosts", { actor: ACTOR, host: host.toUpperCase(), note: "SIEM in the security operations centre" });
    expect(added.statusCode, added.body).toBe(200);
    const a = added.json() as { id: string; seq: number; host: string };
    expect(a.host).toBe(host);
    expect(await forOrg(orgId).egressRule.findFirst({ where: { id: a.id } })).toMatchObject({ host, port: null, purpose: null, note: "SIEM in the security operations centre", createdBy: ACTOR });
    const receipt = await forOrg(orgId).receipt.findFirstOrThrow({ where: { seq: a.seq } });
    expect(receipt).toMatchObject({ action: "egress.internal_host_added" });
    expect((receipt.body as { actor: string }).actor).toBe(ACTOR);

    expect((await post("egress/hosts", { actor: ACTOR, host })).statusCode).toBe(409);
    expect((await post("egress/hosts", { actor: ACTOR, host: "api.openai.com" })).statusCode).toBe(400);
    // a second rule for the same host (a port of its own), as an operator might add: removing the host removes both
    await forOrg(orgId).egressRule.create({ data: { orgId, host, port: 8088, purpose: "webhook", createdBy: "ops" } });

    const removed = await post("egress/hosts/remove", { actor: ACTOR, host });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ removed: 2 });
    expect(await forOrg(orgId).egressRule.count({ where: { host } })).toBe(0);
    expect((await forOrg(orgId).receipt.findFirstOrThrow({ where: { seq: (removed.json() as { seq: number }).seq } })).action).toBe("egress.internal_host_removed");
    const again = await post("egress/hosts/remove", { actor: ACTOR, host });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: "That host is not on the allow-list." });
  });

  it("records an egress-log export by its digest", async () => {
    const r = await post("egress/export", { actor: ACTOR, days: 7, attempts: 3, digest: "0123456789abcdef" });
    expect(r.statusCode, r.body).toBe(200);
    const receipt = await forOrg(orgId).receipt.findFirstOrThrow({ where: { seq: (r.json() as { seq: number }).seq } });
    expect(receipt.body).toMatchObject({ action: "egress.log_exported", actor: ACTOR, details: { days: 7, attempts: 3, digest: "0123456789abcdef" } });
    expect((await post("egress/export", { actor: ACTOR, days: 7, attempts: 3, digest: "not hex" })).statusCode).toBe(400);
  });

  it("reads the update records, and refuses what it cannot do without touching them", async () => {
    const state = await post("updates/state", {});
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ records: expect.any(Array), importDir: false });
    // no update folder configured: nothing is read from anywhere
    const imp = await post("updates/import", { actor: ACTOR, version: "2026.11.9" });
    expect(imp.statusCode).toBe(409);
    expect(imp.json()).toMatchObject({ error: expect.stringMatching(/no update folder/) });
    // a version is one plain folder name: no separators, no ".."
    expect((await post("updates/import", { actor: ACTOR, version: "../../etc" })).statusCode).toBe(400);
    const unique = `2026.11.9-x${randomBytes(3).toString("hex")}`;
    const rb = await post("updates/rollback", { actor: ACTOR, version: unique, reason: "the payments screen times out" });
    expect(rb.statusCode).toBe(409);
    expect(rb.json()).toMatchObject({ error: "Only the bundle running now can be rolled back." });
    expect((await post("updates/stage", { actor: ACTOR, version: unique })).statusCode).toBe(404);
    expect((await post("updates/apply", { actor: ACTOR, version: unique })).statusCode).toBe(404);
  });
});
