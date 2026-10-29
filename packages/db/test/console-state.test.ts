import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { consoleState, ConsoleStateConflict, prisma } from "../src";

afterAll(() => prisma.$disconnect());

const orgId = () => `org_t${randomBytes(4).toString("hex")}`;

describe("console documents", () => {
  it("saves with a version check and keeps the text as written", async () => {
    const o = orgId();
    expect(await consoleState.load(o)).toBeNull();
    // key order is the console's own (jsonb would sort the keys)
    const json = JSON.stringify({ zeta: 1, alpha: { b: 2, a: 1 }, list: [3, 1, 2] });
    expect(await consoleState.save(o, json, 0)).toBe(1);
    expect(await consoleState.load(o)).toEqual({ version: 1, json });
    await expect(consoleState.save(o, "{}", 0)).rejects.toBeInstanceOf(ConsoleStateConflict);
    await expect(consoleState.save(o, "{}", 2)).rejects.toBeInstanceOf(ConsoleStateConflict);
    expect(await consoleState.save(o, '{"n":2}', 1)).toBe(2);
    expect((await consoleState.versions()).get(o)).toBe(2);
    expect((await consoleState.load(o))?.json).toBe('{"n":2}');
  });

  it("runs one locked transaction at a time per organisation, and rolls back with it", async () => {
    const o = orgId();
    const order: string[] = [];
    const slow = consoleState.withLock(o, async (tx) => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 150));
      await consoleState.save(o, '{"by":"a"}', 0, tx);
      order.push("a:end");
    });
    await new Promise((r) => setTimeout(r, 30));
    const fast = consoleState.withLock(o, async (tx) => {
      order.push("b:start");
      const v = (await consoleState.load(o, tx))?.version ?? 0;
      await consoleState.save(o, '{"by":"b"}', v, tx);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    expect(await consoleState.load(o)).toEqual({ version: 2, json: '{"by":"b"}' });

    await expect(
      consoleState.withLock(o, async (tx) => {
        await consoleState.save(o, '{"by":"c"}', 2, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await consoleState.load(o))?.version).toBe(2);
  });
});
