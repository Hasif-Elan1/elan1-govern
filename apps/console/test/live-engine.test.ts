import { beforeEach, describe, expect, it, vi } from "vitest";

// How an operation runs in a live build (src/api/live/engine.ts): async ones are answered by the server; sync ones
// run here and, when the outermost one changed a document, go to the server too; a refusal undoes the local change
// and is shown. The document sync and the toasts are stand-ins; the HTTP client is real, over a fake fetch.

const h = vi.hoisted(() => ({
  resyncs: [] as { orgId: string; opts?: Record<string, unknown> }[],
  versions: [] as { orgId: string; version: unknown }[],
  flushed: [] as string[],
  toasts: [] as { title: string; body?: unknown }[],
}));
vi.mock("../src/api/live/sync", () => ({
  resync: (orgId: string, opts?: Record<string, unknown>) => { h.resyncs.push({ orgId, opts }); return Promise.resolve(); },
  noteServerVersion: (orgId: string, version: unknown) => void h.versions.push({ orgId, version }),
  flushDeferred: (orgId: string) => void h.flushed.push(orgId),
}));
vi.mock("../src/components/ui/overlay", () => ({ toast: { bad: (title: string, body?: unknown) => void h.toasts.push({ title, body }) } }));

const { decode, encodeArgs, engine, override, runLocally, settled } = await import("../src/api/live/engine");
const { live, quietly } = await import("../src/api/live/state");
const { setTransport } = await import("../src/api/http");

let sent: { op: string; args: unknown[] }[] = [];
let answer: (body: { op: string; args: unknown[] }) => Response = () => new Response("{}");

beforeEach(() => {
  sent = [];
  h.resyncs.length = 0;
  h.versions.length = 0;
  h.flushed.length = 0;
  h.toasts.length = 0;
  answer = () => new Response(JSON.stringify({ result: null, version: 2 }));
  setTransport({
    cookies: () => "gate_csrf=t",
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { op: string; args: unknown[] };
      sent.push(body);
      return answer(body);
    }) as unknown as typeof fetch,
  });
});

/** A domain change, as mock/db.ts reports it through the persistence hook (sync.ts). */
const change = (orgId: string) => { if (live.quiet) return; live.changes++; live.changed.add(orgId); };
const info = (name: string, async: boolean, org: number | null = 0) => ({ name, async, org });

describe("async operations", () => {
  it("are answered by the server, with Maps and Sets as they were", async () => {
    answer = () => new Response(JSON.stringify({ result: { byAgent: { $map: [["a", 1]] }, tags: { $set: ["x"] } }, version: 7 }));
    const local = vi.fn();
    const r = await (engine.call(info("api.today", true), local, ["org_demo", "u_x", undefined], undefined) as Promise<{ byAgent: Map<string, number>; tags: Set<string> }>);
    expect(local).not.toHaveBeenCalled();
    expect(sent).toEqual([{ op: "api.today", args: ["org_demo", "u_x"] }]);
    expect(r.byAgent.get("a")).toBe(1);
    expect(r.tags.has("x")).toBe(true);
    expect(h.versions).toEqual([{ orgId: "org_demo", version: 7 }]);
  });

  it("reject with the server's sentence", async () => {
    answer = () => new Response(JSON.stringify({ error: "Enabling a framework — Viewers cannot do this." }), { status: 400 });
    await expect(engine.call(info("api.setFramework", true), vi.fn(), ["org_demo", "gdpr", true, "u_meera"], undefined)).rejects.toThrow("Enabling a framework — Viewers cannot do this.");
  });

  it("run here when they name no organisation (verification, link pages) or cannot travel as JSON", async () => {
    const verify = vi.fn(async () => "PASS");
    await expect(engine.call(info("api.verifyBundle", true, null), verify, [{}], undefined)).resolves.toBe("PASS");
    runLocally("keys.chainRange");
    const range = vi.fn(async () => () => true);
    await engine.call(info("keys.chainRange", true), range, ["org_demo"], undefined);
    expect(range).toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("can be served by an override (the real password check)", async () => {
    override("work.reauth", async (args) => `checked ${String(args[1])}`);
    await expect(engine.call(info("work.reauth", true, null), vi.fn(), ["u_x", "pw"], undefined)).resolves.toBe("checked pw");
  });
});

describe("sync operations", () => {
  it("run here; a read changes nothing and sends nothing", () => {
    expect(engine.call(info("orgApi.mfaOn", false), (o: unknown) => `read ${String(o)}`, ["org_demo"], undefined)).toBe("read org_demo");
    expect(sent).toEqual([]);
  });

  it("that change a document go to the server once, as the outermost operation, with the arguments of the moment", async () => {
    const inner = (orgId: unknown) => { change(String(orgId)); return 1; };
    const args: unknown[] = ["org_demo", { label: "first" }];
    const out = engine.call(info("tokens.issue", false), function (this: unknown, orgId: unknown) {
      // an operation called inside another runs here as part of it, and is not sent on its own
      engine.call(info("tokens.note", false), inner, [orgId], undefined);
      return "local result";
    }, args, undefined);
    expect(out).toBe("local result");
    (args[1] as { label: string }).label = "changed afterwards";
    expect(live.inflight.get("org_demo")).toBe(1);
    await settled();
    expect(sent).toEqual([{ op: "tokens.issue", args: ["org_demo", { label: "first" }] }]);
    expect(h.versions).toEqual([{ orgId: "org_demo", version: 2 }]);
    expect(live.inflight.has("org_demo")).toBe(false);
    expect(h.flushed).toEqual(["org_demo"]);
  });

  it("that the server refuses are undone here and the refusal is shown", async () => {
    answer = () => new Response(JSON.stringify({ error: "Switching a framework off — Viewers cannot do this." }), { status: 400 });
    engine.call(info("packs.setConfig", false), () => change("org_demo"), ["org_demo"], undefined);
    await settled();
    expect(h.resyncs).toEqual([{ orgId: "org_demo", opts: { force: true, afterForward: true } }]);
    expect(h.toasts).toEqual([{ title: "That change was not saved", body: "Switching a framework off — Viewers cannot do this." }]);
  });

  it("the server does not run from the browser are undone quietly (a gap in the port, not the person's doing)", async () => {
    answer = () => new Response(JSON.stringify({ error: "This operation is not available here." }), { status: 403 });
    engine.call(info("orgApi.orgState", false), () => change("org_demo"), ["org_demo"], undefined);
    await settled();
    expect(h.resyncs).toHaveLength(1);
    expect(h.toasts).toEqual([]);
  });

  it("that change a document but name no organisation are undone, since the server cannot run them", () => {
    engine.call(info("agents.isRetired", false, null), () => change("org_kaveri"), [{}], undefined);
    expect(sent).toEqual([]);
    expect(h.resyncs).toEqual([{ orgId: "org_kaveri", opts: { force: true } }]);
  });

  it("that throw after changing something put it back and rethrow", () => {
    expect(() => engine.call(info("billing.raise", false), () => { change("org_demo"); throw new Error("refused"); }, ["org_demo"], undefined)).toThrow("refused");
    expect(h.resyncs).toEqual([{ orgId: "org_demo", opts: { force: true } }]);
    expect(live.depth).toBe(0);
  });

  it("run by the sync itself (an import) are never sent", () => {
    quietly(() => engine.call(info("tokens.issue", false), () => change("org_demo"), ["org_demo"], undefined));
    expect(live.inflight.size).toBe(0);
  });
});

describe("arguments and results", () => {
  it("drop trailing undefined arguments and keep JSON shapes", () => {
    expect(encodeArgs(["o", undefined, 1, undefined, undefined])).toEqual(["o", null, 1]);
    expect(encodeArgs([new Map([["a", 1]]), new Set([2])])).toEqual([{ a: 1 }, [2]]);
    expect(decode([{ $map: [[1, { $set: [2] }]] }, { a: { b: null } }])).toEqual([new Map([[1, new Set([2])]]), { a: { b: null } }]);
  });
});
