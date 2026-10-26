import { generateKeyPair, verifyChain, type Receipt } from "@gate/core";
import { afterAll, describe, expect, it } from "vitest";
import { appendReceipt, createCheckpoint, forOrg, paymentsToday, prisma, startOfDayIST, toCheckpoint, withChain } from "../src";

const keys = generateKeyPair();

async function newOrg(name = "Test Org") {
  return prisma.org.create({ data: { name, publicKey: keys.publicKeyPem, privateKeyEnc: "unused-in-tests" } });
}

afterAll(() => prisma.$disconnect());

describe("forOrg", () => {
  it("scopes reads, writes and updates to one org", async () => {
    const [a, b] = await Promise.all([newOrg("A"), newOrg("B")]);
    const dbA = forOrg(a.id);
    const dbB = forOrg(b.id);
    const agent = await dbA.agent.create({ data: { orgId: b.id, slug: "x", name: "X", purpose: "p", ownerEmail: "o@a.in" } as never });
    expect(agent.orgId).toBe(a.id); // orgId in data is overwritten

    expect(await dbB.agent.findMany()).toHaveLength(0);
    expect(await dbB.agent.findUnique({ where: { id: agent.id } })).toBeNull();
    expect(await dbB.agent.count()).toBe(0);
    await expect(dbB.agent.update({ where: { id: agent.id }, data: { name: "hacked" } })).rejects.toThrow();
    expect((await dbB.agent.updateMany({ where: { id: agent.id }, data: { name: "hacked" } })).count).toBe(0);
    expect((await dbB.agent.deleteMany({})).count).toBe(0);

    await dbA.agent.update({ where: { id: agent.id }, data: { orgId: b.id, name: "renamed" } as never });
    const still = await dbA.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(still).toMatchObject({ orgId: a.id, name: "renamed" });

    expect(await dbB.org.findFirst({ where: { id: a.id } })).toBeNull();
    expect((await dbA.org.findFirst())?.id).toBe(a.id);
  });

  it("scopes createMany and upsert", async () => {
    const [a, b] = await Promise.all([newOrg(), newOrg()]);
    await forOrg(a.id).control.createMany({ data: [{ orgId: b.id, code: "C1", title: "t", description: "d", evidence: "e", mappings: [] } as never] });
    expect(await forOrg(b.id).control.count()).toBe(0);
    await forOrg(b.id).connector.upsert({ where: { orgId_kind: { orgId: a.id, kind: "gmail" } }, create: { kind: "gmail" } as never, update: {} });
    expect(await forOrg(a.id).connector.count()).toBe(0);
    expect(await forOrg(b.id).connector.count()).toBe(1);
  });

  it("refuses global models and empty org ids", async () => {
    const a = await newOrg();
    await expect((forOrg(a.id) as unknown as typeof prisma).user.findMany()).rejects.toThrow(/not a tenant model/);
    await expect(forOrg(a.id).org.create({ data: { name: "x", publicKey: "", privateKeyEnc: "" } })).rejects.toThrow(/gate service/);
    expect(() => forOrg("")).toThrow();
  });
});

describe("receipt chain", () => {
  it("writes concurrent receipts with no gaps and a valid chain", async () => {
    const org = await newOrg();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        appendReceipt(org.id, keys.privateKeyPem, { kind: "decision", tool: "gmail.search", decision: "allow", args_summary: { i } }),
      ),
    );
    const rows = await forOrg(org.id).receipt.findMany({ orderBy: { seq: "asc" } });
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(verifyChain(rows.map((r) => r.body as Receipt), keys.publicKeyPem)).toMatchObject({ ok: true, count: 40 });
  });

  it("rolls back receipts with the transaction", async () => {
    const org = await newOrg();
    await expect(
      withChain(org.id, keys.privateKeyPem, async (append) => {
        await append({ kind: "admin", action: "x" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await forOrg(org.id).receipt.count()).toBe(0);
  });

  it("checkpoints the head once per change", async () => {
    const org = await newOrg();
    expect(await createCheckpoint(org.id, keys.privateKeyPem)).toBeNull();
    await appendReceipt(org.id, keys.privateKeyPem, { kind: "admin", action: "a" });
    const cp = await createCheckpoint(org.id, keys.privateKeyPem);
    expect(cp?.seq).toBe(1);
    expect(await createCheckpoint(org.id, keys.privateKeyPem)).toBeNull();
    const row = await forOrg(org.id).checkpoint.findFirstOrThrow();
    expect(toCheckpoint(row)).toEqual(cp);
  });

  it("sums today's successful payments", async () => {
    const org = await newOrg();
    const pay = (amount_inr: number, status: "ok" | "error") =>
      appendReceipt(org.id, keys.privateKeyPem, {
        kind: "decision",
        tool: "zoho.record_bill_payment",
        decision: "allow",
        args_summary: { amount_inr },
        outcome: { status },
      });
    await pay(1000, "ok");
    await pay(2500, "ok");
    await pay(99999, "error");
    expect(await paymentsToday(org.id)).toBe(3500);
  });

  it("computes IST midnight", () => {
    expect(startOfDayIST(new Date("2026-10-26T20:00:00Z")).toISOString()).toBe("2026-10-26T18:30:00.000Z");
    expect(startOfDayIST(new Date("2026-10-26T10:00:00Z")).toISOString()).toBe("2026-10-25T18:30:00.000Z");
  });
});

describe("quotas and time zones", () => {
  it("finds local midnight in any time zone", async () => {
    const { startOfDayIn } = await import("../src");
    expect(startOfDayIn("Asia/Kolkata", new Date("2026-10-26T20:00:00Z")).toISOString()).toBe("2026-10-26T18:30:00.000Z");
    expect(startOfDayIn("America/New_York", new Date("2026-10-26T03:00:00Z")).toISOString()).toBe("2026-10-25T04:00:00.000Z");
    expect(startOfDayIn("UTC", new Date("2026-10-26T23:59:59Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
  it("counts successful calls and sums a numeric field inside the window", async () => {
    const { quotaUsage } = await import("../src");
    const org = await newOrg();
    const add = (tool: string, amount: unknown, status: "ok" | "error") =>
      appendReceipt(org.id, keys.privateKeyPem, { kind: "decision", tool, decision: "allow", args_summary: { amount }, outcome: { status } });
    await add("crm.issue_refund", 100, "ok");
    await add("crm.issue_refund", 50.5, "ok");
    await add("crm.issue_refund", "not a number", "ok");
    await add("crm.issue_refund", 999, "error");
    await add("crm.other", 7, "ok");
    expect(await quotaUsage(org.id, ["crm.issue_refund"], new Date(Date.now() - 60_000), "amount")).toEqual({ count: 3, sum: 150.5 });
    expect(await quotaUsage(org.id, ["crm.issue_refund", "crm.other"], new Date(Date.now() - 60_000))).toEqual({ count: 4, sum: 0 });
    expect(await quotaUsage(org.id, ["crm.issue_refund"], new Date(Date.now() + 60_000), "amount")).toEqual({ count: 0, sum: 0 });
    expect(await quotaUsage(org.id, [], new Date(0))).toEqual({ count: 0, sum: 0 });
  });
});
