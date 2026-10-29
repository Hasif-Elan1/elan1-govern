import { encodeConsoleReceipt, receiptHash, toConsoleReceipt, verifyChain, type Receipt } from "@gate/core";
import { orgPublicKeys, prisma } from "@gate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg } from "../src/admin";
import { HISTORY_IMPORTED } from "../src/console-chain";
import type { Deps } from "../src/deps";
import { demoOrg, internal, makeApp, makeUser, tool } from "./helpers";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let deps: Deps;

beforeAll(async () => {
  ({ app, deps } = await makeApp());
});
afterAll(async () => {
  await Promise.all([...deps.background]);
  await app.close();
  await prisma.$disconnect();
});

const chainOf = async (orgId: string) => (await prisma.receipt.findMany({ where: { orgId }, orderBy: { seq: "asc" } })).map((r) => r.body as Receipt);
const headOf = async (orgId: string) => {
  const last = (await chainOf(orgId)).at(-1)!;
  return { seq: last.seq, hash: last.hash };
};
const verifies = async (orgId: string) => verifyChain(await chainOf(orgId), await orgPublicKeys(orgId));

async function freshOrg() {
  const owner = await makeUser();
  return (await createOrg(deps, { name: "Console Chain Traders", ownerUserId: owner.id, ownerEmail: owner.email })).id;
}

describe("POST /internal/orgs/:org/console-receipts", () => {
  it("appends the console's receipts after the head it names, signed by the org's key, in core's format", async () => {
    const orgId = await freshOrg();
    const base = await headOf(orgId);
    const body = encodeConsoleReceipt({
      kind: "approval",
      agent: "invoice-bot",
      ref_seq: base.seq,
      approval: { id: "apr_1", status: "approved_run_failed", approver: "u_venkat", channel: "slack" },
      decision: "allow",
      outcome: { status: "error", ms: 420 },
      actor: "u_venkat",
      environment: "sandbox",
    });
    const res = await internal(app, "POST", `/internal/orgs/${orgId}/console-receipts`, { base, receipts: [body, { kind: "admin", actor: "u_rahul", action: "framework.enabled", details: { framework: "HIPAA" } }], checkpoint: true });
    expect(res.statusCode).toBe(200);
    const { receipts, checkpoint } = res.json() as { receipts: Receipt[]; checkpoint: { seq: number; sig: string } };
    expect(receipts.map((r) => r.seq)).toEqual([base.seq + 1, base.seq + 2]);
    expect(receipts[0]!.prev_hash).toBe(base.hash);
    expect(checkpoint).toMatchObject({ seq: base.seq + 2 });
    // the chain holds exactly what came back; the console reads it as it wrote it
    const stored = await chainOf(orgId);
    expect(stored.slice(-2)).toEqual(receipts);
    expect(receiptHash(receipts[0]!)).toBe(receipts[0]!.hash);
    expect(toConsoleReceipt(receipts[0]!)).toMatchObject({ approval: { status: "approved_run_failed", approver: "u_venkat", channel: "slack" }, outcome: { status: "error", ms: 420 }, environment: "sandbox" });
    expect(await verifies(orgId)).toMatchObject({ ok: true, lastSeq: base.seq + 2 });

    // a checkpoint asked for again with nothing new is the last one
    const again = await internal(app, "POST", `/internal/orgs/${orgId}/console-receipts`, { base: await headOf(orgId), receipts: [], checkpoint: true });
    expect(again.json().checkpoint).toEqual(checkpoint);
  });

  it("refuses the whole write when the chain moved past the head the console holds", async () => {
    const orgId = await freshOrg();
    const base = await headOf(orgId);
    await internal(app, "POST", `/internal/orgs/${orgId}/events`, { actor: "owner@test.in", action: "settings.updated", details: {} });
    const res = await internal(app, "POST", `/internal/orgs/${orgId}/console-receipts`, { base, receipts: [{ kind: "admin", actor: "u_rahul", action: "x" }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().head).toEqual(await headOf(orgId));
    expect((await chainOf(orgId)).some((r) => r.action === "x")).toBe(false);
  });

  it("never writes what only the gate writes, nor a receipt core's format has no place for", async () => {
    const orgId = await freshOrg();
    const base = await headOf(orgId);
    for (const action of ["key.rotated", "key.rewrapped", "org.created", HISTORY_IMPORTED]) {
      const res = await internal(app, "POST", `/internal/orgs/${orgId}/console-receipts`, { base, receipts: [{ kind: "admin", actor: "u_rahul", action, details: { old_kid: "a", new_kid: "b" } }] });
      expect(res.statusCode).toBe(422);
    }
    for (const bad of [{ kind: "admin", environment: "sandbox" }, { kind: "admin", seq: 9 }, { kind: "nope" }, { kind: "approval", approval: { id: "a", status: "approved" } }]) {
      expect((await internal(app, "POST", `/internal/orgs/${orgId}/console-receipts`, { base, receipts: [bad] })).statusCode).toBe(400);
    }
    expect((await internal(app, "POST", `/internal/orgs/org_nobody/console-receipts`, { base, receipts: [] })).statusCode).toBe(404);
    expect(await headOf(orgId)).toEqual(base);
  });
});

describe("POST /internal/orgs/:org/console-history", () => {
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

  it("writes a generated history once, keeping each receipt's time, then a marker and a checkpoint", async () => {
    const orgId = await freshOrg();
    const base = await headOf(orgId);
    const history = [
      { ts: at(60 * 24 * 20), kind: "decision", agent: "invoice-bot", tool: "zoho_books.record_payment", decision: "allow", outcome: { status: "ok" } },
      { ts: at(60 * 24 * 20), kind: "admin", actor: "u_ananya", action: "key.rotated.demo", details: { old_kid: "k_demo_1", new_kid: "k_demo_2" } },
      { ts: at(5), ...encodeConsoleReceipt({ kind: "approval", ref_seq: base.seq + 1, approval: { id: "a1", status: "approved", channel: "web" }, decision: "allow" }) },
    ];
    const res = await internal(app, "POST", `/internal/orgs/${orgId}/console-history`, { base, receipts: history });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { receipts: Receipt[]; marker: Receipt; checkpoint: { seq: number } };
    expect(out.receipts.map((r) => [r.seq, r.ts])).toEqual(history.map((h, i) => [base.seq + 1 + i, h.ts]));
    expect(out.marker).toMatchObject({ seq: base.seq + 4, action: HISTORY_IMPORTED, details: { receipts: 3, from_seq: base.seq + 1, to_seq: base.seq + 3 } });
    expect(out.checkpoint.seq).toBe(base.seq + 4);
    // the imported times are older than the setup receipts before them: the verifier still passes (keys check retirement only)
    expect(await verifies(orgId)).toMatchObject({ ok: true, lastSeq: base.seq + 4 });
    expect(await prisma.webhookDelivery.count({ where: { orgId } })).toBe(0);

    // once only
    const again = await internal(app, "POST", `/internal/orgs/${orgId}/console-history`, { base: await headOf(orgId), receipts: [{ ts: at(1), kind: "admin", action: "x" }] });
    expect(again.statusCode).toBe(422);
  });

  it("refuses a history out of time order, from the future, naming a gate-only action, or after a moved head", async () => {
    const orgId = await freshOrg();
    const base = await headOf(orgId);
    const post = (receipts: unknown[], b = base) => internal(app, "POST", `/internal/orgs/${orgId}/console-history`, { base: b, receipts });
    expect((await post([{ ts: at(5), kind: "admin", action: "a" }, { ts: at(10), kind: "admin", action: "b" }])).statusCode).toBe(422);
    expect((await post([{ ts: new Date(Date.now() + 3_600_000).toISOString(), kind: "admin", action: "a" }])).statusCode).toBe(422);
    expect((await post([{ ts: "yesterday", kind: "admin", action: "a" }])).statusCode).toBe(422);
    expect((await post([{ ts: at(5), kind: "admin", action: "key.rotated", details: { old_kid: "a", new_kid: "b" } }])).statusCode).toBe(422);
    expect((await post([{ ts: at(5), kind: "admin", action: "a" }], { seq: base.seq - 1, hash: base.hash })).statusCode).toBe(409);
    expect(await headOf(orgId)).toEqual(base);
  });

  it("is refused once the chain holds an agent's activity", async () => {
    const { org, apiKey } = await demoOrg(deps);
    await tool(app, apiKey, "gmail.read_message", { message_id: "m_101" });
    const res = await internal(app, "POST", `/internal/orgs/${org.id}/console-history`, { base: await headOf(org.id), receipts: [{ ts: at(1), kind: "admin", action: "a" }] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/already holds activity/);
  });
});
